const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');

dotenv.config();

// 🔥 FIREBASE ADMIN INITIALIZATION
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID || "quickpay-761bf",
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID || "fe020c93ecfe04ef392441a5417fb9b054311afd",
  
  client_email: process.env.FIREBASE_CLIENT_EMAIL || "firebase-adminsdk-fbsvc@quickpay-761bf.iam.gserviceaccount.com",
  client_id: process.env.FIREBASE_CLIENT_ID || "108902091588883385790",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL || "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40quickpay-761bf.iam.gserviceaccount.com"
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID || "quickpay-761bf"}.firebaseio.com`
});

const db = admin.firestore();
const app = express();
const jwt = require('jsonwebtoken');

// MIDDLEWARE
app.use(cors({
  origin: ['https://quickpay-psi.vercel.app', 'https://quickpay.shop', 'http://localhost:3000', '*'],
  credentials: true
}));
app.use(express.json());

// ============================================================
// 📌 AUTH MIDDLEWARE
// ============================================================
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'quickpay_jwt_secret_key_2026');
    req.user = { uid: decoded.uid, email: decoded.email };
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

// ============================================================
// 📌 ROOT ENDPOINT
// ============================================================
app.get('/', (req, res) => {
  res.json({
    name: "QuickPay API",
    version: "1.0.0",
    status: "running",
    endpoints: [
      "/",
      "/api/config",
      "/api/auth/google",
      "/api/wallet/balance",
      "/api/subscription/my",
      "/api/subscription/plans",
      "/api/payment/create-order",
      "/api/payment/status/:orderId",
      "/api/payment/history",
      "/api/payment-link/create",
      "/api/payment-link/list",
      "/api/withdrawal/request",
      "/api/withdrawal/history",
      "/api/auth/me",
      "/api/user/profile"
    ]
  });
});

// ============================================================
// 📌 /api/config
// ============================================================
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    data: {
      siteName: "QuickPay",
      firebaseConfig: {
        apiKey: "AIzaSyA9L0Ff4nuAHsS-bC6K4Qf0RUYLR-BLSQo",
        authDomain: "quickpay-761bf.firebaseapp.com",
        projectId: "quickpay-761bf",
        storageBucket: "quickpay-761bf.firebasestorage.app",
        messagingSenderId: "756705256503",
        appId: "1:756705256503:web:8d31b15a680002c5464bb2"
      },
      maintenanceMode: false,
      vapidKey: ""
    }
  });
});

// ============================================================
// 📌 /api/auth/google
// ============================================================
app.post('/api/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ success: false, message: 'ID token is required' });
    }

    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;
    const email = decodedToken.email;
    const name = decodedToken.name || email?.split('@')[0] || 'User';
    const photoURL = decodedToken.picture || '';

    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    let userData;
    let isNewUser = false;

    if (!userDoc.exists) {
      isNewUser = true;
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let refCode = 'QP';
      for (let i = 0; i < 8; i++) refCode += chars.charAt(Math.floor(Math.random() * chars.length));

      userData = {
        uid, email, displayName: name, photoURL: photoURL,
        phone: '', createdAt: Date.now(), lastLoginAt: Date.now(),
        role: 'user', isBanned: false, banReason: '',
        upiId: '', upiHolderName: '',
        bankDetails: { accountNumber: '', ifscCode: '', accountHolderName: '' },
        checkoutTheme: 'default', checkoutThemeColor: '',
        referralCode: refCode, referredBy: '', signupBonus: 5,
        authProvider: 'google.com'
      };
      await userRef.set(userData);
      await db.collection('wallets').doc(uid).set({ balance: 0, bonusBalance: 5, createdAt: Date.now(), updatedAt: Date.now() });
      await db.collection('subscriptions').doc(uid).set({
        planId: 'blaze', startDate: Date.now(),
        endDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        status: 'active', paymentLinksUsedThisMonth: 0, monthStartDate: Date.now()
      });
    } else {
      userData = userDoc.data();
      await userRef.update({ lastLoginAt: Date.now() });
    }

    if (userData.isBanned) {
      return res.status(403).json({ success: false, banned: true, banReason: userData.banReason || 'Account suspended.' });
    }

    const token = jwt.sign({ uid, email }, process.env.JWT_SECRET || 'quickpay_jwt_secret_key_2026', { expiresIn: '7d' });

    res.json({ success: true, data: { token, user: { ...userData, isNewUser } } });

  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/wallet/balance
// ============================================================
app.get('/api/wallet/balance', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const walletRef = db.collection('wallets').doc(uid);
    const walletDoc = await walletRef.get();
    if (!walletDoc.exists) {
      return res.json({ success: true, data: { balance: 0, bonusBalance: 0 } });
    }
    res.json({ success: true, data: walletDoc.data() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/subscription/my
// ============================================================
app.get('/api/subscription/my', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const subRef = db.collection('subscriptions').doc(uid);
    const subDoc = await subRef.get();

    const allPlans = {
      blaze: { id: 'blaze', name: 'Blaze', price: 0, paymentLinksPerMonth: 100, walletLimit: 500, commissionPercent: 5, linkExpiryDays: 30, withdrawalCount: 2, badge: 'Free' },
      bronze: { id: 'bronze', name: 'Bronze', price: 99, paymentLinksPerMonth: 500, walletLimit: 2000, commissionPercent: 4, linkExpiryDays: 60, withdrawalCount: 5, badge: 'Starter' },
      silver: { id: 'silver', name: 'Silver', price: 299, paymentLinksPerMonth: -1, walletLimit: 10000, commissionPercent: 3, linkExpiryDays: -1, withdrawalCount: 10, badge: 'Popular', isHighlighted: true },
      gold: { id: 'gold', name: 'Gold', price: 599, paymentLinksPerMonth: -1, walletLimit: 50000, commissionPercent: 2, linkExpiryDays: -1, withdrawalCount: 20, badge: 'Pro' },
      developer: { id: 'developer', name: 'Developer', price: 999, paymentLinksPerMonth: -1, walletLimit: 100000, commissionPercent: 1, linkExpiryDays: -1, withdrawalCount: -1, badge: 'Enterprise' }
    };

    if (!subDoc.exists) {
      return res.json({ success: true, data: { subscription: { planId: 'blaze', plan: allPlans.blaze, paymentLinksUsedThisMonth: 0 }, overBalance: 0 } });
    }

    const subData = subDoc.data();
    const plan = allPlans[subData.planId || 'blaze'] || allPlans.blaze;

    let overBalance = 0;
    const walletRef = db.collection('wallets').doc(uid);
    const walletDoc = await walletRef.get();
    if (walletDoc.exists) {
      const balance = walletDoc.data().balance || 0;
      if (balance > plan.walletLimit) overBalance = balance - plan.walletLimit;
    }

    res.json({ success: true, data: { subscription: { ...subData, plan, paymentLinksUsedThisMonth: subData.paymentLinksUsedThisMonth || 0 }, overBalance } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/subscription/plans
// ============================================================
app.get('/api/subscription/plans', async (req, res) => {
  try {
    const plans = [
      { id: 'blaze', name: 'Blaze', price: 0, paymentLinksPerMonth: 100, walletLimit: 500, commissionPercent: 5, linkExpiryDays: 30, withdrawalCount: 2, displayOrder: 1, badge: 'Free' },
      { id: 'bronze', name: 'Bronze', price: 99, paymentLinksPerMonth: 500, walletLimit: 2000, commissionPercent: 4, linkExpiryDays: 60, withdrawalCount: 5, displayOrder: 2, badge: 'Starter' },
      { id: 'silver', name: 'Silver', price: 299, paymentLinksPerMonth: -1, walletLimit: 10000, commissionPercent: 3, linkExpiryDays: -1, withdrawalCount: 10, displayOrder: 3, isHighlighted: true, badge: 'Popular' },
      { id: 'gold', name: 'Gold', price: 599, paymentLinksPerMonth: -1, walletLimit: 50000, commissionPercent: 2, linkExpiryDays: -1, withdrawalCount: 20, displayOrder: 4, badge: 'Pro' },
      { id: 'developer', name: 'Developer', price: 999, paymentLinksPerMonth: -1, walletLimit: 100000, commissionPercent: 1, linkExpiryDays: -1, withdrawalCount: -1, displayOrder: 5, badge: 'Enterprise' }
    ];
    res.json({ success: true, data: { plans } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/payment/create-order
// ============================================================
app.post('/api/payment/create-order', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { amount, remark, type = 'payment', customerMobile } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ success: false, message: 'Invalid amount. Minimum ₹1' });
    if (amount > 100000) return res.status(400).json({ success: false, message: 'Maximum amount is ₹1,00,000' });

    const orderId = 'QP' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const orderData = {
      orderId, uid, amount, remark: remark || 'Payment',
      type, status: 'pending',
      paymentUrl: `https://quickpay.shop/pay.html?id=${orderId}`,
      customerMobile: customerMobile || '',
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await db.collection('orders').doc(orderId).set(orderData);
    res.json({ success: true, data: { orderId, paymentUrl: orderData.paymentUrl, amount } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/payment/status/:orderId
// ============================================================
app.get('/api/payment/status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, data: orderDoc.data() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/payment/history
// ============================================================
app.get('/api/payment/history', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const limit = parseInt(req.query.limit) || 50;
    const snapshot = await db.collection('orders').where('uid', '==', uid).orderBy('createdAt', 'desc').limit(limit).get();
    const payments = [];
    snapshot.forEach(doc => payments.push({ id: doc.id, ...doc.data() }));
    res.json({ success: true, data: { payments } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/payment-link/create
// ============================================================
app.post('/api/payment-link/create', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { amount, title, description, expiryDays, redirectUrl } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ success: false, message: 'Invalid amount' });
    if (!title) return res.status(400).json({ success: false, message: 'Title is required' });

    const linkId = 'PL' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const linkData = {
      id: linkId, uid, amount, title, description: description || '',
      redirectUrl: redirectUrl || '', status: 'active',
      paymentCount: 0, totalCollected: 0,
      expiresAt: expiryDays && expiryDays > 0 ? Date.now() + expiryDays * 24 * 60 * 60 * 1000 : null,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await db.collection('paymentLinks').doc(linkId).set(linkData);
    res.json({ success: true, data: { id: linkId, publicUrl: `https://quickpay.shop/pay.html?id=${linkId}`, ...linkData } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/payment-link/list
// ============================================================
app.get('/api/payment-link/list', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const snapshot = await db.collection('paymentLinks').where('uid', '==', uid).orderBy('createdAt', 'desc').get();
    const links = [];
    snapshot.forEach(doc => links.push({ id: doc.id, ...doc.data() }));
    res.json({ success: true, data: { links } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/payment-link/:id/disable
// ============================================================
app.put('/api/payment-link/:id/disable', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { id } = req.params;
    const linkRef = db.collection('paymentLinks').doc(id);
    const linkDoc = await linkRef.get();
    if (!linkDoc.exists) return res.status(404).json({ success: false, message: 'Link not found' });
    if (linkDoc.data().uid !== uid) return res.status(403).json({ success: false, message: 'Unauthorized' });
    await linkRef.update({ status: 'disabled', updatedAt: Date.now() });
    res.json({ success: true, message: 'Link disabled' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/payment-link/:id/enable
// ============================================================
app.put('/api/payment-link/:id/enable', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { id } = req.params;
    const linkRef = db.collection('paymentLinks').doc(id);
    const linkDoc = await linkRef.get();
    if (!linkDoc.exists) return res.status(404).json({ success: false, message: 'Link not found' });
    if (linkDoc.data().uid !== uid) return res.status(403).json({ success: false, message: 'Unauthorized' });
    await linkRef.update({ status: 'active', updatedAt: Date.now() });
    res.json({ success: true, message: 'Link enabled' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/payment-link/:id/edit
// ============================================================
app.put('/api/payment-link/:id/edit', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { id } = req.params;
    const { amount, title, description, expiryDays, redirectUrl } = req.body;
    
    const linkRef = db.collection('paymentLinks').doc(id);
    const linkDoc = await linkRef.get();
    if (!linkDoc.exists) return res.status(404).json({ success: false, message: 'Link not found' });
    if (linkDoc.data().uid !== uid) return res.status(403).json({ success: false, message: 'Unauthorized' });
    
    const updateData = {};
    if (amount) updateData.amount = amount;
    if (title) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (redirectUrl !== undefined) updateData.redirectUrl = redirectUrl;
    if (expiryDays !== undefined) {
      updateData.expiresAt = expiryDays > 0 ? Date.now() + expiryDays * 24 * 60 * 60 * 1000 : null;
    }
    updateData.updatedAt = Date.now();
    
    await linkRef.update(updateData);
    res.json({ success: true, message: 'Link updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/payment-link/:id — DELETE
// ============================================================
app.delete('/api/payment-link/:id', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { id } = req.params;
    const linkRef = db.collection('paymentLinks').doc(id);
    const linkDoc = await linkRef.get();
    if (!linkDoc.exists) return res.status(404).json({ success: false, message: 'Link not found' });
    if (linkDoc.data().uid !== uid) return res.status(403).json({ success: false, message: 'Unauthorized' });
    await linkRef.delete();
    res.json({ success: true, message: 'Link deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/withdrawal/request
// ============================================================
app.post('/api/withdrawal/request', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { method, amount, upiId, upiHolderName, accountNumber, ifscCode, accountHolderName } = req.body;
    if (!amount || amount < 100) return res.status(400).json({ success: false, message: 'Minimum withdrawal is ₹100' });

    const subRef = db.collection('subscriptions').doc(uid);
    const subDoc = await subRef.get();
    let commPct = 5;
    const plans = { blaze: 5, bronze: 4, silver: 3, gold: 2, developer: 1 };
    if (subDoc.exists) commPct = plans[subDoc.data().planId] || 5;

    const commission = Math.round(amount * commPct) / 100;
    const totalRequired = Math.round((amount + commission) * 100) / 100;

    const walletRef = db.collection('wallets').doc(uid);
    const walletDoc = await walletRef.get();
    if (!walletDoc.exists || (walletDoc.data().balance || 0) < totalRequired) {
      return res.status(400).json({ success: false, message: `Insufficient balance. Need ₹${totalRequired}` });
    }

    const wdId = 'WD' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const wdData = {
      id: wdId, uid, method, amount: totalRequired, netAmount: amount, commission,
      status: 'pending',
      upiId: method === 'upi' ? upiId : '', upiHolderName: method === 'upi' ? upiHolderName : '',
      accountNumber: method === 'bank' ? accountNumber : '', ifscCode: method === 'bank' ? ifscCode : '',
      accountHolderName: method === 'bank' ? accountHolderName : '',
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await walletRef.update({ balance: admin.firestore.FieldValue.increment(-totalRequired), updatedAt: Date.now() });
    await db.collection('withdrawals').doc(wdId).set(wdData);
    res.json({ success: true, data: { id: wdId, ...wdData } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/withdrawal/history
// ============================================================
app.get('/api/withdrawal/history', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const snapshot = await db.collection('withdrawals').where('uid', '==', uid).orderBy('createdAt', 'desc').get();
    const withdrawals = [];
    snapshot.forEach(doc => withdrawals.push({ id: doc.id, ...doc.data() }));
    res.json({ success: true, data: { withdrawals } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/auth/me
// ============================================================
app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, data: userDoc.data() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/user/profile
// ============================================================
app.put('/api/user/profile', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { displayName, phone, upiId, upiHolderName, bankDetails, checkoutTheme, checkoutThemeColor } = req.body;
    const userRef = db.collection('users').doc(uid);
    const updateData = {};
    if (displayName !== undefined) updateData.displayName = displayName;
    if (phone !== undefined) updateData.phone = phone;
    if (upiId !== undefined) updateData.upiId = upiId;
    if (upiHolderName !== undefined) updateData.upiHolderName = upiHolderName;
    if (bankDetails !== undefined) updateData.bankDetails = bankDetails;
    if (checkoutTheme !== undefined) updateData.checkoutTheme = checkoutTheme;
    if (checkoutThemeColor !== undefined) updateData.checkoutThemeColor = checkoutThemeColor;
    if (Object.keys(updateData).length === 0) return res.status(400).json({ success: false, message: 'No fields to update' });
    await userRef.update(updateData);
    res.json({ success: true, message: 'Profile updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/notification/count
// ============================================================
app.get('/api/notification/count', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const snapshot = await db.collection('notifications')
      .where('uid', '==', uid)
      .where('isRead', '==', false)
      .get();
    res.json({ success: true, data: { unreadCount: snapshot.size } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/notification/list
// ============================================================
app.get('/api/notification/list', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const limit = parseInt(req.query.limit) || 50;
    const snapshot = await db.collection('notifications')
      .where('uid', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    const notifications = [];
    snapshot.forEach(doc => notifications.push({ id: doc.id, ...doc.data() }));
    res.json({ success: true, data: { notifications } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/notification/read/:id
// ============================================================
app.put('/api/notification/read/:id', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { id } = req.params;
    const notifRef = db.collection('notifications').doc(id);
    const notifDoc = await notifRef.get();
    if (!notifDoc.exists) return res.status(404).json({ success: false, message: 'Notification not found' });
    if (notifDoc.data().uid !== uid) return res.status(403).json({ success: false, message: 'Unauthorized' });
    await notifRef.update({ isRead: true });
    res.json({ success: true, message: 'Marked as read' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/notification/read-all
// ============================================================
app.put('/api/notification/read-all', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const snapshot = await db.collection('notifications')
      .where('uid', '==', uid)
      .where('isRead', '==', false)
      .get();
    const batch = db.batch();
    snapshot.forEach(doc => {
      batch.update(doc.ref, { isRead: true });
    });
    await batch.commit();
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/referral/my
// ============================================================
app.get('/api/referral/my', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });
    
    const userData = userDoc.data();
    const referralCode = userData.referralCode || '';
    
    const snapshot = await db.collection('referrals')
      .where('referrerUid', '==', uid)
      .orderBy('createdAt', 'desc')
      .get();
    
    const referrals = [];
    let totalIncome = 0;
    let thisMonthIncome = 0;
    const now = Date.now();
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const commission = data.commission || 0;
      totalIncome += commission;
      if (data.createdAt >= monthStart.getTime()) {
        thisMonthIncome += commission;
      }
      // Get referred user name
      let referredName = 'User';
      try {
        const refUserRef = db.collection('users').doc(data.referredUid);
        const refUserDoc = await refUserRef.get();
        if (refUserDoc.exists) {
          referredName = refUserDoc.data().displayName || refUserDoc.data().email || 'User';
        }
      } catch (e) {}
      
      referrals.push({
        name: referredName,
        email: data.email || '',
        status: data.status || 'waiting',
        purchaseAmount: data.purchaseAmount || 0,
        commission: commission,
        createdAt: data.createdAt
      });
    }
    
    res.json({
      success: true,
      data: {
        referralCode,
        totalReferrals: referrals.length,
        totalIncome,
        thisMonthIncome,
        signupBonus: 5,
        referrals
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/promo/apply
// ============================================================
app.post('/api/promo/apply', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Promo code is required' });
    
    // Check if already used
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    if (userDoc.exists && userDoc.data().promoCodes && userDoc.data().promoCodes.includes(code)) {
      return res.status(400).json({ success: false, message: 'You have already used this promo code' });
    }
    
    // Check if promo exists
    const promoRef = db.collection('promoCodes').doc(code);
    const promoDoc = await promoRef.get();
    if (!promoDoc.exists) {
      return res.status(404).json({ success: false, message: 'Invalid promo code' });
    }
    
    const promoData = promoDoc.data();
    if (promoData.usedCount >= promoData.maxUses) {
      return res.status(400).json({ success: false, message: 'This promo code has reached its limit' });
    }
    if (promoData.expiryAt && promoData.expiryAt < Date.now()) {
      return res.status(400).json({ success: false, message: 'This promo code has expired' });
    }
    
    // Apply promo
    const bonusAmount = promoData.bonusAmount || 5;
    await db.collection('wallets').doc(uid).update({
      bonusBalance: admin.firestore.FieldValue.increment(bonusAmount),
      updatedAt: Date.now()
    });
    
    await promoRef.update({
      usedCount: admin.firestore.FieldValue.increment(1)
    });
    
    await userRef.update({
      promoCodes: admin.firestore.FieldValue.arrayUnion(code)
    });
    
    res.json({ success: true, message: `Promo code applied! You received ₹${bonusAmount} bonus.` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/developer/token — Get API key
// ============================================================
app.get('/api/developer/token', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });
    
    let apiKey = userDoc.data().apiKey;
    if (!apiKey) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      apiKey = 'QP';
      for (let i = 0; i < 32; i++) {
        apiKey += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      await userRef.update({ apiKey, apiKeyCreatedAt: Date.now() });
    }
    
    res.json({
      success: true,
      data: {
        apiKey,
        createdAt: userDoc.data().apiKeyCreatedAt || Date.now(),
        lastUsedAt: userDoc.data().apiKeyLastUsedAt || null,
        mode: userDoc.data().gatewayMode || 'live'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/developer/token/regenerate
// ============================================================
app.post('/api/developer/token/regenerate', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let apiKey = 'QP';
    for (let i = 0; i < 32; i++) {
      apiKey += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    await db.collection('users').doc(uid).update({
      apiKey,
      apiKeyCreatedAt: Date.now(),
      apiKeyLastUsedAt: null
    });
    res.json({ success: true, data: { apiKey } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/developer/mode
// ============================================================
app.post('/api/developer/mode', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { mode } = req.body;
    if (!['live', 'test'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'Invalid mode. Use "live" or "test"' });
    }
    await db.collection('users').doc(uid).update({ gatewayMode: mode });
    res.json({ success: true, message: `Gateway mode set to ${mode}`, data: { mode } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/notification/test-push
// ============================================================
app.post('/api/notification/test-push', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    // Create a test notification
    await db.collection('notifications').add({
      uid,
      title: '🔔 Test Notification',
      message: 'This is a test push notification from QuickPay! 🚀',
      type: 'general',
      isRead: false,
      createdAt: Date.now()
    });
    res.json({ success: true, message: 'Test notification sent!' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/auth/logout
// ============================================================
app.post('/api/auth/logout', authenticate, async (req, res) => {
  try {
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/otp/send
// ============================================================
app.post('/api/otp/send', async (req, res) => {
  try {
    const { email, name, purpose } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
    
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresInSeconds = 300;
    
    await db.collection('otps').doc(email).set({
      otp,
      purpose: purpose || 'signup',
      name: name || '',
      createdAt: Date.now(),
      expiresAt: Date.now() + expiresInSeconds * 1000
    });
    
    res.json({
      success: true,
      message: 'OTP sent successfully',
      data: { expiresInSeconds }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/otp/verify
// ============================================================
app.post('/api/otp/verify', async (req, res) => {
  try {
    const { email, otp, purpose } = req.body;
    if (!email || !otp) return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    
    const otpRef = db.collection('otps').doc(email);
    const otpDoc = await otpRef.get();
    if (!otpDoc.exists) return res.status(400).json({ success: false, message: 'Invalid OTP' });
    
    const data = otpDoc.data();
    if (data.otp !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP' });
    if (data.expiresAt < Date.now()) return res.status(400).json({ success: false, message: 'OTP has expired' });
    if (data.purpose !== purpose) return res.status(400).json({ success: false, message: 'Invalid OTP purpose' });
    
    // Delete OTP after verification
    await otpRef.delete();
    
    res.json({ success: true, message: 'OTP verified successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/otp/reset-password
// ============================================================
app.post('/api/otp/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ success: false, message: 'Email, OTP and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }
    
    const otpRef = db.collection('otps').doc(email);
    const otpDoc = await otpRef.get();
    if (!otpDoc.exists) return res.status(400).json({ success: false, message: 'Invalid OTP' });
    
    const data = otpDoc.data();
    if (data.otp !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP' });
    if (data.expiresAt < Date.now()) return res.status(400).json({ success: false, message: 'OTP has expired' });
    if (data.purpose !== 'reset') return res.status(400).json({ success: false, message: 'Invalid OTP purpose' });
    
    // Update password in Firebase Auth
    try {
      const user = await admin.auth().getUserByEmail(email);
      await admin.auth().updateUser(user.uid, { password: newPassword });
    } catch (e) {
      return res.status(400).json({ success: false, message: 'User not found or update failed' });
    }
    
    await otpRef.delete();
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/store/access
// ============================================================
app.get('/api/store/access', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });
    
    const userData = userDoc.data();
    const hasAccess = userData.storeUnlocked || false;
    const unlockPrice = 29;
    
    res.json({ success: true, data: { hasAccess, unlockPrice } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/store/unlock/wallet
// ============================================================
app.post('/api/store/unlock/wallet', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });
    
    if (userDoc.data().storeUnlocked) {
      return res.status(400).json({ success: false, message: 'Store already unlocked' });
    }
    
    const unlockPrice = 29;
    const walletRef = db.collection('wallets').doc(uid);
    const walletDoc = await walletRef.get();
    if (!walletDoc.exists || (walletDoc.data().balance || 0) < unlockPrice) {
      return res.status(400).json({ success: false, message: `Insufficient balance. Need ₹${unlockPrice}` });
    }
    
    await walletRef.update({ balance: admin.firestore.FieldValue.increment(-unlockPrice) });
    await userRef.update({ storeUnlocked: true });
    
    res.json({ success: true, message: 'Store unlocked successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/store/unlock/upi
// ============================================================
app.post('/api/store/unlock/upi', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });
    
    if (userDoc.data().storeUnlocked) {
      return res.status(400).json({ success: false, message: 'Store already unlocked' });
    }
    
    const unlockPrice = 29;
    const orderId = 'ST' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    
    await db.collection('orders').doc(orderId).set({
      orderId, uid, amount: unlockPrice,
      remark: 'Store Unlock',
      type: 'store_unlock',
      status: 'pending',
      paymentUrl: `https://quickpay.shop/pay.html?id=${orderId}`,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    res.json({
      success: true,
      data: {
        paymentUrl: `https://quickpay.shop/pay.html?id=${orderId}`
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/store/settings — GET
// ============================================================
app.get('/api/store/settings', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const storeRef = db.collection('stores').doc(uid);
    const storeDoc = await storeRef.get();
    
    if (!storeDoc.exists) {
      return res.json({
        success: true,
        data: {
          storeId: uid,
          storeName: 'My Store',
          logoUrl: '',
          theme: 'boutique',
          socialLinks: { telegram: '', whatsapp: '', youtube: '', instagram: '' }
        }
      });
    }
    
    res.json({ success: true, data: storeDoc.data() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/store/settings — PUT
// ============================================================
app.put('/api/store/settings', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { storeName, logoUrl, socialLinks, theme } = req.body;
    
    const storeRef = db.collection('stores').doc(uid);
    const storeDoc = await storeRef.get();
    
    const updateData = {
      storeId: uid,
      updatedAt: Date.now()
    };
    if (storeName !== undefined) updateData.storeName = storeName;
    if (logoUrl !== undefined) updateData.logoUrl = logoUrl;
    if (socialLinks !== undefined) updateData.socialLinks = socialLinks;
    if (theme !== undefined) updateData.theme = theme;
    
    if (!storeDoc.exists) {
      updateData.createdAt = Date.now();
      await storeRef.set(updateData);
    } else {
      await storeRef.update(updateData);
    }
    
    res.json({ success: true, message: 'Store settings saved' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/store/products — GET
// ============================================================
app.get('/api/store/products', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const snapshot = await db.collection('storeProducts')
      .where('uid', '==', uid)
      .orderBy('createdAt', 'desc')
      .get();
    
    const products = [];
    snapshot.forEach(doc => products.push({ id: doc.id, ...doc.data() }));
    
    res.json({ success: true, data: { products } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/store/products — POST
// ============================================================
app.post('/api/store/products', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { imageUrl, title, description, originalPrice, discountPrice, productLink, screenshotUrls } = req.body;
    
    if (!imageUrl) return res.status(400).json({ success: false, message: 'Image URL is required' });
    if (!title) return res.status(400).json({ success: false, message: 'Title is required' });
    if (!description) return res.status(400).json({ success: false, message: 'Description is required' });
    if (!originalPrice || originalPrice <= 0) {
      return res.status(400).json({ success: false, message: 'Original price is required and must be greater than 0' });
    }
    if (discountPrice && discountPrice >= originalPrice) {
      return res.status(400).json({ success: false, message: 'Discount price must be less than original price' });
    }
    
    const productId = 'PD' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    
    const productData = {
      id: productId,
      uid,
      imageUrl,
      title,
      description,
      originalPrice,
      discountPrice: discountPrice || null,
      productLink: productLink || '',
      screenshotUrls: screenshotUrls || [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    
    await db.collection('storeProducts').doc(productId).set(productData);
    res.json({ success: true, data: productData });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/store/products/:id — PUT
// ============================================================
app.put('/api/store/products/:id', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { id } = req.params;
    const { imageUrl, title, description, originalPrice, discountPrice, productLink, screenshotUrls } = req.body;
    
    const productRef = db.collection('storeProducts').doc(id);
    const productDoc = await productRef.get();
    if (!productDoc.exists) return res.status(404).json({ success: false, message: 'Product not found' });
    if (productDoc.data().uid !== uid) return res.status(403).json({ success: false, message: 'Unauthorized' });
    
    const updateData = { updatedAt: Date.now() };
    if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (originalPrice !== undefined) updateData.originalPrice = originalPrice;
    if (discountPrice !== undefined) updateData.discountPrice = discountPrice;
    if (productLink !== undefined) updateData.productLink = productLink;
    if (screenshotUrls !== undefined) updateData.screenshotUrls = screenshotUrls;
    
    await productRef.update(updateData);
    res.json({ success: true, message: 'Product updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 /api/store/products/:id — DELETE
// ============================================================
app.delete('/api/store/products/:id', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { id } = req.params;
    const productRef = db.collection('storeProducts').doc(id);
    const productDoc = await productRef.get();
    if (!productDoc.exists) return res.status(404).json({ success: false, message: 'Product not found' });
    if (productDoc.data().uid !== uid) return res.status(403).json({ success: false, message: 'Unauthorized' });
    
    await productRef.delete();
    res.json({ success: true, message: 'Product deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 📌 START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 QuickPay API running on port ${PORT}`);
  console.log(`📡 Root: http://localhost:${PORT}`);
  console.log(`📡 Config: http://localhost:${PORT}/api/config`);
});

module.exports = app;
