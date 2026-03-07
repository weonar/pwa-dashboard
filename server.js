// Завантажуємо .env
try { require('dotenv').config(); } catch (e) { console.warn('dotenv не знайдено'); }

console.log('=== ENV ПЕРЕВІРКА ===');
console.log('SMTP_USER:    ', process.env.SMTP_USER    ? '✅ ' + process.env.SMTP_USER : '❌ ВІДСУТНІЙ — email не працюватиме');
console.log('SMTP_PASS:    ', process.env.SMTP_PASS    ? '✅ задано' : '❌ ВІДСУТНІЙ');
console.log('MONGODB_URI:  ', process.env.MONGODB_URI  ? '✅ задано' : '❌ ВІДСУТНІЙ — in-memory режим');
console.log('CLOUDINARY_URL:', process.env.CLOUDINARY_URL ? '✅ задано' : '❌ ВІДСУТНІЙ — файли не працюватимуть');
console.log('JWT_SECRET:   ', process.env.JWT_SECRET   ? '✅ задано' : '⚠️  використовується дефолтний — небезпечно!');
console.log('BASE_URL:     ', process.env.BASE_URL     || '⚠️  не задано — посилання в листах будуть неправильні');
console.log('====================');

// ==================== КОНФІГ ====================
const PORT        = process.env.PORT        || 3000;
const JWT_SECRET  = process.env.JWT_SECRET  || 'change_this_secret_in_production';
const BASE_URL    = process.env.BASE_URL    || `http://localhost:${PORT}`;
const SMTP_USER   = process.env.SMTP_USER   || '';
const SMTP_PASS   = process.env.SMTP_PASS   || '';
const MONGODB_URI = process.env.MONGODB_URI || '';

// ==================== ЗАЛЕЖНОСТІ ====================
const express     = require('express');
const http        = require('http');
const WebSocket   = require('ws');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const nodemailer  = require('nodemailer');
const crypto      = require('crypto');
const QRCode      = require('qrcode');
const { MongoClient, ObjectId } = require('mongodb');
const cloudinary  = require('cloudinary').v2;
const multer      = require('multer');
const streamifier = require('streamifier');

// ==================== CLOUDINARY ====================
if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL });
}

function uploadToCloudinary(buffer, folder, filename) {
  return new Promise((resolve, reject) => {
    const publicId = `${folder}/${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const stream = cloudinary.uploader.upload_stream(
      { public_id: publicId, resource_type: 'auto', use_filename: false },
      (err, result) => { if (err) reject(err); else resolve(result); }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

async function deleteFromCloudinary(publicId) {
  for (const type of ['image', 'video', 'raw']) {
    try {
      const r = await cloudinary.uploader.destroy(publicId, { resource_type: type });
      if (r.result === 'ok') return r;
    } catch {}
  }
}

// ==================== MONGODB ====================
let db;

async function connectMongo() {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI не знайдено — in-memory fallback');
    db = createInMemoryDB();
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db = client.db();
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('users').createIndex({ username: 1 }, { unique: true });
    await db.collection('files').createIndex({ userId: 1 });
    console.log('MongoDB підключено');
  } catch (e) {
    console.error('MongoDB помилка:', e.message, '— in-memory fallback');
    db = createInMemoryDB();
  }
}

// ==================== IN-MEMORY FALLBACK ====================
function createInMemoryDB() {
  const fs = require('fs'), path = require('path');
  const FILE = './data/users.json';
  let d = { users: [], userData: [], qrTokens: [], files: [] };
  try {
    if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
    if (fs.existsSync(FILE)) { d = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!d.files) d.files = []; }
  } catch {}
  const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); } catch {} };

  const match = (obj, q) => Object.entries(q).every(([k, v]) => k === '_id' ? String(obj._id) === String(v) : obj[k] === v);

  const col = (arr) => ({
    findOne: async (q) => arr.find(o => match(o, q)) || null,
    find: (q) => ({ toArray: async () => q ? arr.filter(o => Object.entries(q).every(([k,v]) => String(o[k]) === String(v))) : [...arr] }),
    insertOne: async (doc) => { const _id = crypto.randomBytes(12).toString('hex'); arr.push({ _id, ...doc }); save(); return { insertedId: _id }; },
    updateOne: async (q, upd, opts) => {
      let idx = arr.findIndex(o => match(o, q));
      if (idx === -1 && opts && opts.upsert) { arr.push({ _id: crypto.randomBytes(12).toString('hex'), ...q }); idx = arr.length - 1; }
      if (idx !== -1) { Object.assign(arr[idx], upd.$set || {}); save(); }
    },
    deleteOne: async (q) => { const i = arr.findIndex(o => match(o, q)); if (i !== -1) { arr.splice(i, 1); save(); } },
    deleteMany: async (q) => { const before = arr.length; d[arr === d.users ? 'users' : arr === d.files ? 'files' : arr === d.userData ? 'userData' : 'qrTokens'] = arr.filter(o => !Object.entries(q).every(([k,v]) => String(o[k]) === String(v))); save(); },
    countDocuments: async (q) => q ? arr.filter(o => Object.entries(q).every(([k,v]) => String(o[k]) === String(v))).length : arr.length,
    createIndex: async () => {},
  });

  return {
    collection: (name) => {
      const map = { users: d.users, userData: d.userData, files: d.files, qrTokens: d.qrTokens };
      const arr = map[name] || [];
      const c = col(arr);
      if (name === 'users') {
        c.insertOne = async (doc) => {
          const _id = crypto.randomBytes(12).toString('hex');
          d.users.push({ _id, ...doc });
          d.userData.push({ _id: crypto.randomBytes(12).toString('hex'), userId: _id, clipboard: '', notes: { mode: 'text', content: '', tasks: [] } });
          save();
          return { insertedId: _id };
        };
        c.deleteOne = async (q) => {
          const i = d.users.findIndex(o => match(o, q));
          if (i !== -1) { const id = String(d.users[i]._id); d.users.splice(i, 1); d.userData = d.userData.filter(u => u.userId !== id); d.files = d.files.filter(f => f.userId !== id); save(); }
        };
      }
      return c;
    }
  };
}

// ==================== HELPERS ====================
async function findUserById(id) {
  try { return await db.collection('users').findOne({ _id: new ObjectId(String(id)) }); } catch {}
  return await db.collection('users').findOne({ _id: String(id) });
}

async function findUser(q) {
  for (const [k, v] of Object.entries(q)) {
    const u = await db.collection('users').findOne({ [k]: v });
    if (u) return u;
  }
  return null;
}

// ==================== MAILER ====================
// Спробуємо port 587 (STARTTLS) — надійніший на хмарних платформах
const mailer = SMTP_USER ? nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,       // false = STARTTLS
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  tls: { rejectUnauthorized: false },
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 8000,
}) : null;

if (mailer) {
  mailer.verify()
    .then(() => console.log('✅ Gmail SMTP OK (port 587)'))
    .catch(e => {
      console.error('❌ Gmail SMTP port 587 failed:', e.message);
      console.error('   Перевір: SMTP_USER, SMTP_PASS, та що App Password правильний');
    });
}

async function sendMail(to, subject, html) {
  if (!mailer) {
    console.log(`[EMAIL STUB] To: ${to} | Subject: ${subject}`);
    console.log('[EMAIL STUB] Причина: SMTP_USER не задано в env змінних');
    return;
  }
  console.log(`[EMAIL] Відправка на ${to}...`);
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Email timeout after 15s')), 15000)
  );
  try {
    const info = await Promise.race([
      mailer.sendMail({ from: `"PWA Dashboard" <${SMTP_USER}>`, to, subject, html }),
      timeout
    ]);
    console.log(`[EMAIL] Успішно відправлено: ${info.messageId}`);
  } catch(e) {
    console.error(`[EMAIL] Помилка відправки на ${to}:`, e.message);
    throw e;
  }
}

// ==================== APP ====================
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function flexAuthMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ==================== AUTH ====================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) return res.status(400).json({ error: 'Всі поля обовязкові' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль мінімум 6 символів' });

    const existing = await findUser({ email }) || await findUser({ username: username.trim() });
    if (existing) return res.status(409).json({ error: 'Email або нікнейм вже зайнятий' });

    const hash = await bcrypt.hash(password, 10);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const count = await db.collection('users').countDocuments({});
    const isFirst = count === 0;

    const { insertedId } = await db.collection('users').insertOne({
      email, username: username.trim(), password: hash,
      role: isFirst ? 'admin' : 'user',
      verified: isFirst ? 1 : 0,
      verify_token: isFirst ? null : verifyToken,
      reset_token: null, reset_expiry: null,
      created_at: Date.now(), last_login: null
    });

    // Для MongoDB — явно створюємо userData
    if (MONGODB_URI) {
      await db.collection('userData').updateOne(
        { userId: String(insertedId) },
        { $set: { userId: String(insertedId), clipboard: '', notes: { mode: 'text', content: '', tasks: [] } } },
        { upsert: true }
      );
    }

    if (!isFirst) {
      const verifyUrl = `${BASE_URL}/api/auth/verify/${verifyToken}`;
      // Відповідаємо одразу — не чекаємо email
      res.json({ ok: true, message: 'Реєстрація успішна! Перевірте пошту.' });
      // Відправляємо email у фоні
      sendMail(email, 'Підтвердіть email — PWA Dashboard', `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2>Привіт, ${username}!</h2>
          <p>Підтвердіть вашу email-адресу:</p>
          <a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#667eea;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Підтвердити email</a>
        </div>`).catch(e => console.error('Register email error:', e.message));
    } else {
      res.json({ ok: true, message: 'Акаунт адміна створено! Можете увійти.' });
    }
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Email або нікнейм вже зайнятий' });
    console.error(e); res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.get('/api/auth/verify/:token', async (req, res) => {
  const user = await db.collection('users').findOne({ verify_token: req.params.token });
  if (!user) return res.send('<h2>Невірний або вже використаний токен</h2>');
  await db.collection('users').updateOne({ _id: user._id }, { $set: { verified: 1, verify_token: null } });
  res.redirect('/?verified=1');
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const user = await findUser({ email: login, username: login });
    if (!user) return res.status(401).json({ error: 'Невірний логін або пароль' });
    if (!user.verified) return res.status(403).json({ error: 'Підтвердіть email перед входом' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Невірний логін або пароль' });
    await db.collection('users').updateOne({ _id: user._id }, { $set: { last_login: Date.now() } });
    const token = jwt.sign({ id: String(user._id), username: user.username, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, user: { id: String(user._id), username: user.username, email: user.email, role: user.role } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Помилка сервера' }); }
});

app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const { login } = req.body;
    const user = await findUser({ email: login, username: login });
    if (!user) return res.json({ ok: true });
    if (user.verified) return res.status(400).json({ error: 'Email вже підтверджений' });
    const verifyToken = crypto.randomBytes(32).toString('hex');
    await db.collection('users').updateOne({ _id: user._id }, { $set: { verify_token: verifyToken } });
    const verifyUrl = `${BASE_URL}/api/auth/verify/${verifyToken}`;
    res.json({ ok: true });
    sendMail(user.email, 'Підтвердіть email — PWA Dashboard', `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Підтвердження email</h2>
        <a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#667eea;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Підтвердити email</a>
      </div>`).catch(e => console.error('Resend email error:', e.message));
  } catch (e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.post('/api/auth/forgot', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await db.collection('users').findOne({ email });
    if (!user) return res.json({ ok: true });
    const token = crypto.randomBytes(32).toString('hex');
    await db.collection('users').updateOne({ _id: user._id }, { $set: { reset_token: token, reset_expiry: Date.now() + 3600000 } });
    const resetUrl = `${BASE_URL}/?reset=${token}`;
    res.json({ ok: true });
    sendMail(email, 'Скидання пароля — PWA Dashboard', `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Скидання пароля</h2>
        <p>Посилання діє 1 годину.</p>
        <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#f5576c;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Скинути пароль</a>
      </div>`).catch(e => console.error('Forgot email error:', e.message));
  } catch (e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.post('/api/auth/reset', async (req, res) => {
  try {
    const { token, password } = req.body;
    const user = await db.collection('users').findOne({ reset_token: token });
    if (!user || user.reset_expiry < Date.now()) return res.status(400).json({ error: 'Токен недійсний або вже використаний' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль мінімум 6 символів' });
    const hash = await bcrypt.hash(password, 10);
    await db.collection('users').updateOne({ _id: user._id }, { $set: { password: hash, reset_token: null, reset_expiry: null } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const user = await findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ id: String(user._id), username: user.username, email: user.email, role: user.role, created_at: user.created_at, last_login: user.last_login });
});

app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const user = await findUserById(req.user.id);
  if (!(await bcrypt.compare(oldPassword, user.password))) return res.status(400).json({ error: 'Невірний поточний пароль' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Новий пароль мінімум 6 символів' });
  await db.collection('users').updateOne({ _id: user._id }, { $set: { password: await bcrypt.hash(newPassword, 10) } });
  res.json({ ok: true });
});

// ==================== QR ====================
app.post('/api/qr/generate', authMiddleware, async (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 5 * 60 * 1000;
    await db.collection('qrTokens').deleteMany({ userId: req.user.id });
    await db.collection('qrTokens').insertOne({ token, userId: req.user.id, expiresAt });
    const url = `${BASE_URL}/?qr=${token}`;
    const qrDataUrl = await QRCode.toDataURL(url, { width: 256, margin: 2, color: { dark: '#ffffff', light: '#1a1a2e' } });
    res.json({ ok: true, qrDataUrl, url, expiresIn: 300 });
  } catch (e) { res.status(500).json({ error: 'Помилка генерації QR' }); }
});

app.post('/api/qr/auth', async (req, res) => {
  const { token } = req.body;
  const row = await db.collection('qrTokens').findOne({ token });
  if (!row || row.expiresAt < Date.now()) return res.status(400).json({ error: 'QR-код недійсний або застарів' });
  await db.collection('qrTokens').deleteOne({ token });
  const user = await findUserById(row.userId);
  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  const jwtToken = jwt.sign({ id: String(user._id), username: user.username, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token: jwtToken, user: { id: String(user._id), username: user.username, email: user.email, role: user.role } });
});

// ==================== ADMIN ====================
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const users = await db.collection('users').find({}).toArray();
  res.json(users.map(u => { const { password, verify_token, reset_token, reset_expiry, ...s } = u; return { ...s, id: String(u._id) }; }));
});

app.patch('/api/admin/users/:id/role', authMiddleware, adminMiddleware, async (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  await db.collection('users').updateOne({ _id: user._id }, { $set: { role } });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Не можна видалити себе' });
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  // Видаляємо файли з Cloudinary
  const files = await db.collection('files').find({ userId: String(user._id) }).toArray();
  await Promise.allSettled(files.map(f => deleteFromCloudinary(f.publicId)));
  await db.collection('users').deleteOne({ _id: user._id });
  await db.collection('files').deleteMany({ userId: String(user._id) });
  await db.collection('userData').deleteOne({ userId: String(user._id) });
  res.json({ ok: true });
});

// ==================== USER DATA ====================
app.get('/api/clipboard', authMiddleware, async (req, res) => {
  const data = await db.collection('userData').findOne({ userId: req.user.id });
  res.json({ content: data?.clipboard || '' });
});

app.get('/api/notes', authMiddleware, async (req, res) => {
  const data = await db.collection('userData').findOne({ userId: req.user.id });
  res.json(data?.notes || { mode: 'text', content: '', tasks: [] });
});

app.get('/api/statistics', authMiddleware, async (req, res) => {
  try {
    const data = await db.collection('userData').findOne({ userId: req.user.id });
    const tasks = data?.notes?.tasks || [];
    const files = await db.collection('files').find({ userId: req.user.id }).toArray();
    const totalSize = files.reduce((s, f) => s + (f.size || 0), 0);
    const userClients = [...clients.values()].filter(c => c.userId === req.user.id);
    res.json({
      tasks: { total: tasks.length, completed: tasks.filter(t => t.completed).length },
      files: { count: files.length, totalSize },
      devices: userClients.length,
      clipboard: { length: (data?.clipboard || '').length },
      lastSync: new Date().toISOString()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== FILES ====================
app.get('/api/files', authMiddleware, async (req, res) => {
  try {
    const files = await db.collection('files').find({ userId: req.user.id }).toArray();
    res.json(files.map(f => ({
      name: f.filename, size: f.size || 0,
      modified: f.createdAt || new Date().toISOString(),
      url: f.url, publicId: f.publicId, _id: String(f._id)
    })).sort((a, b) => new Date(b.modified) - new Date(a.modified)));
  } catch { res.json([]); }
});

app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не завантажено' });
  try {
    const folder = `pwa-dashboard/${req.user.id}`;
    const result = await uploadToCloudinary(req.file.buffer, folder, req.file.originalname);
    await db.collection('files').insertOne({
      userId: req.user.id,
      filename: req.file.originalname,
      publicId: result.public_id,
      resourceType: result.resource_type,
      url: result.secure_url,
      size: req.file.size,
      createdAt: new Date().toISOString()
    });
    broadcastToUser(req.user.id, 'filesUpdated', {});
    res.json({ success: true, filename: req.file.originalname, url: result.secure_url });
  } catch (e) { console.error('Upload error:', e); res.status(500).json({ error: 'Помилка завантаження: ' + e.message }); }
});

app.delete('/api/files/:filename', authMiddleware, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const file = await db.collection('files').findOne({ userId: req.user.id, filename });
    if (!file) return res.status(404).json({ error: 'Файл не знайдено' });
    await deleteFromCloudinary(file.publicId);
    await db.collection('files').deleteOne({ _id: file._id });
    broadcastToUser(req.user.id, 'filesUpdated', {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/download/:filename', flexAuthMiddleware, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const file = await db.collection('files').findOne({ userId: req.user.id, filename });
    if (!file) return res.status(404).json({ error: 'Файл не знайдено' });
    res.redirect(file.url);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== WEBSOCKET ====================
const clients = new Map();

wss.on('connection', (ws) => {
  const clientId = crypto.randomBytes(16).toString('hex');
  let userId = null;

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        try {
          const payload = jwt.verify(msg.token, JWT_SECRET);
          userId = payload.id;
          clients.set(clientId, { ws, userId });
          await db.collection('userData').updateOne({ userId }, { $set: { userId, clipboard: { $ifNull: ['$clipboard', ''] } } }, { upsert: false });
          const data = await db.collection('userData').findOne({ userId });
          if (!data) {
            await db.collection('userData').updateOne({ userId }, { $set: { userId, clipboard: '', notes: { mode: 'text', content: '', tasks: [] } } }, { upsert: true });
          }
          const d = await db.collection('userData').findOne({ userId });
          ws.send(JSON.stringify({ type: 'init', clipboard: d?.clipboard || '', notes: d?.notes || { mode: 'text', content: '', tasks: [] } }));
        } catch { ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' })); ws.close(); }
        return;
      }
      if (!userId) return;
      if (msg.type === 'clipboard') {
        await db.collection('userData').updateOne({ userId }, { $set: { clipboard: msg.content } }, { upsert: true });
        broadcastToUser(userId, 'clipboard', { content: msg.content }, clientId);
      }
      if (msg.type === 'notes') {
        const { mode, ...incoming } = msg.data;
        const cur = await db.collection('userData').findOne({ userId });
        const merged = { ...(cur?.notes || {}), ...incoming };
        await db.collection('userData').updateOne({ userId }, { $set: { notes: merged } }, { upsert: true });
        broadcastToUser(userId, 'notes', incoming, clientId);
      }
    } catch (e) { console.error('WS error:', e.message); }
  });

  ws.on('close', () => clients.delete(clientId));
  ws.on('error', () => clients.delete(clientId));
});

function broadcastToUser(userId, type, data, excludeClientId = null) {
  const msg = JSON.stringify({ type, ...data });
  clients.forEach(({ ws, userId: uid }, cid) => {
    if (uid === userId && cid !== excludeClientId && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ==================== ЗАПУСК ====================
connectMongo().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`
PWA Dashboard запущено
http://localhost:${PORT}
Файли: Cloudinary
БД: ${MONGODB_URI ? 'MongoDB Atlas' : 'in-memory (локальна розробка)'}
    `);
  });
});