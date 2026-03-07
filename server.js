// ==================== КОНФІГ ====================
const PORT       = process.env.PORT       || 3000;
const HDD_PATH   = process.env.HDD_PATH   || './uploads';
const DATA_DIR   = './data';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
const BASE_URL   = process.env.BASE_URL   || `http://localhost:${PORT}`;
const SMTP_USER  = process.env.SMTP_USER  || '';
const SMTP_PASS  = process.env.SMTP_PASS  || '';

// ==================== ЗАЛЕЖНОСТІ ====================
const express    = require('express');
const path       = require('path');
const fs         = require('fs').promises;
const fsSync     = require('fs');
const http       = require('http');
const WebSocket  = require('ws');
const multer     = require('multer');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const QRCode     = require('qrcode');

// ==================== PURE-JS БД (замість better-sqlite3) ====================
// Простий JSON-файл як база даних — працює на Termux, Vercel, будь-де
class JsonDB {
  constructor(filePath) {
    this.filePath = filePath;
    this._load();
  }

  _load() {
    try {
      this.data = JSON.parse(fsSync.readFileSync(this.filePath, 'utf8'));
    } catch {
      this.data = { users: [], userData: [], qrTokens: [] };
      this._save();
    }
  }

  _save() {
    fsSync.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  // ---- USERS ----
  findUser(query) {
    return this.data.users.find(u =>
      Object.entries(query).every(([k, v]) => u[k] === v)
    ) || null;
  }

  findUsers() {
    return this.data.users.map(u => {
      const { password, verify_token, reset_token, reset_expiry, ...safe } = u;
      return safe;
    });
  }

  insertUser(user) {
    const id = (this.data.users.reduce((m, u) => Math.max(m, u.id), 0)) + 1;
    const newUser = { id, ...user, created_at: Date.now(), last_login: null };
    this.data.users.push(newUser);
    // Init user data
    this.data.userData.push({
      user_id: id,
      clipboard: '',
      notes: JSON.stringify({ mode: 'text', content: '', tasks: [] })
    });
    this._save();
    return newUser;
  }

  updateUser(id, fields) {
    const idx = this.data.users.findIndex(u => u.id === id);
    if (idx === -1) return;
    this.data.users[idx] = { ...this.data.users[idx], ...fields };
    this._save();
  }

  deleteUser(id) {
    this.data.users = this.data.users.filter(u => u.id !== id);
    this.data.userData = this.data.userData.filter(u => u.user_id !== id);
    this._save();
  }

  countUsers() {
    return this.data.users.length;
  }

  // ---- USER DATA ----
  getUserData(userId) {
    let row = this.data.userData.find(u => u.user_id === userId);
    if (!row) {
      row = { user_id: userId, clipboard: '', notes: JSON.stringify({ mode: 'text', content: '', tasks: [] }) };
      this.data.userData.push(row);
      this._save();
    }
    return { clipboard: row.clipboard, notes: JSON.parse(row.notes) };
  }

  setClipboard(userId, content) {
    const idx = this.data.userData.findIndex(u => u.user_id === userId);
    if (idx !== -1) { this.data.userData[idx].clipboard = content; this._save(); }
  }

  setNotes(userId, notes) {
    const idx = this.data.userData.findIndex(u => u.user_id === userId);
    if (idx !== -1) { this.data.userData[idx].notes = JSON.stringify(notes); this._save(); }
  }

  // ---- QR TOKENS ----
  insertQR(token, userId, expiresAt) {
    // Чистимо старі токени цього юзера
    this.data.qrTokens = this.data.qrTokens.filter(t => t.user_id !== userId && t.expires_at > Date.now());
    this.data.qrTokens.push({ token, user_id: userId, expires_at: expiresAt });
    this._save();
  }

  findQR(token) {
    return this.data.qrTokens.find(t => t.token === token && t.expires_at > Date.now()) || null;
  }

  deleteQR(token) {
    this.data.qrTokens = this.data.qrTokens.filter(t => t.token !== token);
    this._save();
  }
}

// ==================== ІНІЦІАЛІЗАЦІЯ ====================
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

[DATA_DIR, HDD_PATH].forEach(dir => {
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
});

const db = new JsonDB(path.join(DATA_DIR, 'users.json'));

// ==================== NODEMAILER ====================
const mailer = SMTP_USER ? nodemailer.createTransport({
  service: 'gmail',
  auth: { user: SMTP_USER, pass: SMTP_PASS }
}) : null;

async function sendMail(to, subject, html) {
  if (!mailer) {
    console.log(`\n📧 [EMAIL STUB]\nTo: ${to}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, '').trim()}\n`);
    return;
  }
  await mailer.sendMail({ from: SMTP_USER, to, subject, html });
}

// ==================== MIDDLEWARE ====================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function flexAuthMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ==================== MULTER ====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(HDD_PATH, String(req.user.id));
    fsSync.mkdirSync(userDir, { recursive: true });
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

function getUserUploadsPath(userId) {
  const p = path.join(HDD_PATH, String(userId));
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

// ==================== AUTH ROUTES ====================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password)
      return res.status(400).json({ error: 'Всі поля обовʼязкові' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Пароль мінімум 6 символів' });

    const existing = db.findUser({ email }) || db.findUser({ username: username.trim() });
    if (existing) return res.status(409).json({ error: 'Email або нікнейм вже зайнятий' });

    const hash = await bcrypt.hash(password, 10);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const isFirst = db.countUsers() === 0;
    const role = isFirst ? 'admin' : 'user';

    db.insertUser({
      email, username: username.trim(), password: hash,
      role, verified: isFirst ? 1 : 0, // перший юзер одразу verified
      verify_token: isFirst ? null : verifyToken,
      reset_token: null, reset_expiry: null
    });

    if (!isFirst) {
      const verifyUrl = `${BASE_URL}/api/auth/verify/${verifyToken}`;
      await sendMail(email, '✅ Підтвердіть email — PWA Dashboard', `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2>Привіт, ${username}! 👋</h2>
          <p>Підтвердіть вашу email-адресу:</p>
          <a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#667eea;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">
            Підтвердити email
          </a>
        </div>
      `);
      res.json({ ok: true, message: 'Реєстрація успішна! Перевірте пошту для підтвердження.' });
    } else {
      res.json({ ok: true, message: 'Акаунт адміна створено! Можете увійти.' });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.get('/api/auth/verify/:token', (req, res) => {
  const user = db.findUser({ verify_token: req.params.token });
  if (!user) return res.send('<h2>❌ Невірний або вже використаний токен</h2>');
  db.updateUser(user.id, { verified: 1, verify_token: null });
  res.redirect('/?verified=1');
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const user = db.findUser({ email: login }) || db.findUser({ username: login });
    if (!user) return res.status(401).json({ error: 'Невірний логін або пароль' });
    if (!user.verified) return res.status(403).json({ error: 'Підтвердіть email перед входом' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Невірний логін або пароль' });

    db.updateUser(user.id, { last_login: Date.now() });

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, role: user.role },
      JWT_SECRET, { expiresIn: '30d' }
    );

    res.json({ ok: true, token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.post('/api/auth/forgot', async (req, res) => {
  try {
    const { email } = req.body;
    const user = db.findUser({ email });
    if (!user) return res.json({ ok: true });

    const token = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + 3600000;
    db.updateUser(user.id, { reset_token: token, reset_expiry: expiry });

    const resetUrl = `${BASE_URL}/?reset=${token}`;
    await sendMail(email, '🔑 Скидання пароля — PWA Dashboard', `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Скидання пароля</h2>
        <p>Посилання діє 1 годину.</p>
        <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#f5576c;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">
          Скинути пароль
        </a>
      </div>
    `);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.post('/api/auth/reset', async (req, res) => {
  try {
    const { token, password } = req.body;
    const user = db.data.users.find(u => u.reset_token === token && u.reset_expiry > Date.now());
    if (!user) return res.status(400).json({ error: 'Токен недійсний або вже використаний' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль мінімум 6 символів' });

    const hash = await bcrypt.hash(password, 10);
    db.updateUser(user.id, { password: hash, reset_token: null, reset_expiry: null });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.findUser({ id: req.user.id });
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({
    id: user.id, username: user.username, email: user.email,
    role: user.role, created_at: user.created_at, last_login: user.last_login
  });
});

app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const user = db.findUser({ id: req.user.id });
  const ok = await bcrypt.compare(oldPassword, user.password);
  if (!ok) return res.status(400).json({ error: 'Невірний поточний пароль' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Новий пароль мінімум 6 символів' });
  const hash = await bcrypt.hash(newPassword, 10);
  db.updateUser(req.user.id, { password: hash });
  res.json({ ok: true });
});

// ==================== QR ====================
app.post('/api/qr/generate', authMiddleware, async (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 5 * 60 * 1000;
    db.insertQR(token, req.user.id, expiresAt);

    const url = `${BASE_URL}/?qr=${token}`;
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 256, margin: 2,
      color: { dark: '#ffffff', light: '#1a1a2e' }
    });

    res.json({ ok: true, qrDataUrl, url, expiresIn: 300 });
  } catch (e) {
    res.status(500).json({ error: 'Помилка генерації QR' });
  }
});

app.post('/api/qr/auth', async (req, res) => {
  const { token } = req.body;
  const row = db.findQR(token);
  if (!row) return res.status(400).json({ error: 'QR-код недійсний або застарів' });

  db.deleteQR(token);
  const user = db.findUser({ id: row.user_id });
  const jwtToken = jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role },
    JWT_SECRET, { expiresIn: '30d' }
  );
  res.json({ ok: true, token: jwtToken, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
});

// ==================== ADMIN ====================
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  res.json(db.findUsers());
});

app.patch('/api/admin/users/:id/role', authMiddleware, adminMiddleware, (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  db.updateUser(Number(req.params.id), { role });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Не можна видалити себе' });
  db.deleteUser(Number(req.params.id));
  res.json({ ok: true });
});

// ==================== DATA (per-user) ====================
app.get('/api/clipboard', authMiddleware, (req, res) => {
  const data = db.getUserData(req.user.id);
  res.json({ content: data.clipboard });
});

app.get('/api/notes', authMiddleware, (req, res) => {
  const data = db.getUserData(req.user.id);
  res.json(data.notes);
});

app.get('/api/statistics', authMiddleware, async (req, res) => {
  try {
    const data = db.getUserData(req.user.id);
    const tasks = data.notes.tasks || [];
    const userDir = getUserUploadsPath(req.user.id);
    let fileCount = 0, totalSize = 0;
    try {
      const files = await fs.readdir(userDir);
      for (const f of files) {
        const stat = await fs.stat(path.join(userDir, f));
        if (stat.isFile()) { fileCount++; totalSize += stat.size; }
      }
    } catch {}
    const userClients = [...clients.values()].filter(c => c.userId === req.user.id);
    res.json({
      tasks: { total: tasks.length, completed: tasks.filter(t => t.completed).length },
      files: { count: fileCount, totalSize },
      devices: userClients.length,
      clipboard: { length: data.clipboard.length },
      lastSync: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== FILES ====================
app.get('/api/files', authMiddleware, async (req, res) => {
  try {
    const userDir = getUserUploadsPath(req.user.id);
    const files = await fs.readdir(userDir);
    const list = [];
    for (const f of files) {
      const stat = await fs.stat(path.join(userDir, f));
      if (stat.isFile()) list.push({ name: f, size: stat.size, modified: stat.mtime.toISOString() });
    }
    res.json(list.sort((a, b) => new Date(b.modified) - new Date(a.modified)));
  } catch { res.json([]); }
});

app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не завантажено' });
  broadcastToUser(req.user.id, 'filesUpdated', {});
  res.json({ success: true, filename: req.file.filename });
});

app.delete('/api/files/:filename', authMiddleware, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const userDir  = getUserUploadsPath(req.user.id);
    const filePath = path.join(userDir, filename);
    if (!path.resolve(filePath).startsWith(path.resolve(userDir)))
      return res.status(400).json({ error: 'Недопустимий шлях' });
    await fs.unlink(filePath);
    broadcastToUser(req.user.id, 'filesUpdated', {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/download/:filename', flexAuthMiddleware, (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const userDir  = getUserUploadsPath(req.user.id);
    const filePath = path.join(userDir, filename);
    if (!path.resolve(filePath).startsWith(path.resolve(userDir)))
      return res.status(400).json({ error: 'Недопустимий шлях' });
    if (!fsSync.existsSync(filePath)) return res.status(404).json({ error: 'Файл не знайдено' });
    res.download(filePath);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== WEBSOCKET ====================
const clients = new Map();

wss.on('connection', (ws) => {
  const clientId = crypto.randomUUID();
  let userId = null;

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'auth') {
        try {
          const payload = jwt.verify(msg.token, JWT_SECRET);
          userId = payload.id;
          clients.set(clientId, { ws, userId });
          console.log(`✅ WS: ${payload.username}`);

          const data = db.getUserData(userId);
          ws.send(JSON.stringify({ type: 'init', clipboard: data.clipboard, notes: data.notes }));
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
          ws.close();
        }
        return;
      }

      if (!userId) return;

      if (msg.type === 'clipboard') {
        db.setClipboard(userId, msg.content);
        broadcastToUser(userId, 'clipboard', { content: msg.content }, clientId);
      }

      if (msg.type === 'notes') {
        const { mode, ...incoming } = msg.data;
        const current = db.getUserData(userId);
        const merged = { ...current.notes, ...incoming };
        db.setNotes(userId, merged);
        broadcastToUser(userId, 'notes', incoming, clientId);
      }
    } catch (e) {
      console.error('WS error:', e.message);
    }
  });

  ws.on('close', () => clients.delete(clientId));
  ws.on('error', () => clients.delete(clientId));
});

function broadcastToUser(userId, type, data, excludeClientId = null) {
  const msg = JSON.stringify({ type, ...data });
  clients.forEach(({ ws, userId: uid }, cid) => {
    if (uid === userId && cid !== excludeClientId && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

// ==================== ЗАПУСК ====================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 PWA DASHBOARD (multi-user) 🚀    ║
╚════════════════════════════════════════╝
📱 http://localhost:${PORT}
🌐 З локальної мережі: http://<твій-ip>:${PORT}
📁 Файли: ${HDD_PATH}
💾 БД: ${DATA_DIR}/users.json

Перший акаунт = адмін (вкладка Сайт тільки для нього)
  `);
});