// ==================== КОНФІГ ====================
const PORT      = process.env.PORT      || 3000;
const HDD_PATH  = process.env.HDD_PATH  || './uploads';
const DATA_DIR  = './data';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
const BASE_URL   = process.env.BASE_URL  || `http://localhost:${PORT}`;

// Gmail SMTP — заповни в .env
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';

// ==================== ЗАЛЕЖНОСТІ ====================
const express    = require('express');
const path       = require('path');
const fs         = require('fs').promises;
const fsSync     = require('fs');
const http       = require('http');
const WebSocket  = require('ws');
const multer     = require('multer');
const Database   = require('better-sqlite3');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const QRCode     = require('qrcode');

// ==================== ІНІЦІАЛІЗАЦІЯ ====================
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// Папки
[DATA_DIR, HDD_PATH].forEach(dir => {
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
});

// ==================== БАЗА ДАНИХ ====================
const db = new Database(path.join(DATA_DIR, 'dashboard.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT    UNIQUE NOT NULL,
    username     TEXT    UNIQUE NOT NULL,
    password     TEXT    NOT NULL,
    role         TEXT    NOT NULL DEFAULT 'user',
    verified     INTEGER NOT NULL DEFAULT 0,
    verify_token TEXT,
    reset_token  TEXT,
    reset_expiry INTEGER,
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_login   INTEGER
  );

  CREATE TABLE IF NOT EXISTS user_data (
    user_id   INTEGER PRIMARY KEY,
    clipboard TEXT    NOT NULL DEFAULT '',
    notes     TEXT    NOT NULL DEFAULT '{"mode":"text","content":"","tasks":[]}',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS qr_tokens (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ==================== NODEMAILER ====================
const mailer = SMTP_USER ? nodemailer.createTransport({
  service: 'gmail',
  auth: { user: SMTP_USER, pass: SMTP_PASS }
}) : null;

async function sendMail(to, subject, html) {
  if (!mailer) {
    console.log(`[EMAIL STUB] To: ${to}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, '')}`);
    return;
  }
  await mailer.sendMail({ from: SMTP_USER, to, subject, html });
}

// ==================== MIDDLEWARE ====================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// JWT auth middleware
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

function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ==================== MULTER (per-user uploads) ====================
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
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB

// ==================== HELPERS ====================
function getUserData(userId) {
  let row = db.prepare('SELECT * FROM user_data WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO user_data (user_id) VALUES (?)').run(userId);
    row = db.prepare('SELECT * FROM user_data WHERE user_id = ?').get(userId);
  }
  return {
    clipboard: row.clipboard,
    notes: JSON.parse(row.notes)
  };
}

function getUserUploadsPath(userId) {
  const p = path.join(HDD_PATH, String(userId));
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

// ==================== AUTH ROUTES ====================

// Реєстрація
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password)
      return res.status(400).json({ error: 'Всі поля обовʼязкові' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Пароль мінімум 6 символів' });

    const exists = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
    if (exists) return res.status(409).json({ error: 'Email або нікнейм вже зайнятий' });

    const hash = await bcrypt.hash(password, 10);
    const verifyToken = crypto.randomBytes(32).toString('hex');

    const isFirstUser = !db.prepare('SELECT id FROM users LIMIT 1').get();
    const role = isFirstUser ? 'admin' : 'user';

    db.prepare(`
      INSERT INTO users (email, username, password, role, verify_token)
      VALUES (?, ?, ?, ?, ?)
    `).run(email, username.trim(), hash, role, verifyToken);

    const verifyUrl = `${BASE_URL}/api/auth/verify/${verifyToken}`;
    await sendMail(email, '✅ Підтвердіть email — PWA Dashboard', `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Привіт, ${username}! 👋</h2>
        <p>Підтвердіть вашу email-адресу для активації акаунту:</p>
        <a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#667eea;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">
          Підтвердити email
        </a>
        <p style="color:#888;margin-top:16px;font-size:13px">Якщо це не ви — просто ігноруйте лист.</p>
      </div>
    `);

    res.json({ ok: true, message: 'Реєстрація успішна! Перевірте пошту для підтвердження.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// Підтвердження email
app.get('/api/auth/verify/:token', (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE verify_token = ?').get(req.params.token);
  if (!user) return res.send('<h2>❌ Невірний або вже використаний токен</h2>');
  db.prepare('UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?').run(user.id);
  res.redirect('/?verified=1');
});

// Логін
app.post('/api/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(login, login);
    if (!user) return res.status(401).json({ error: 'Невірний логін або пароль' });
    if (!user.verified) return res.status(403).json({ error: 'Підтвердіть email перед входом' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Невірний логін або пароль' });

    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ ok: true, token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// Скидання пароля — запит
app.post('/api/auth/forgot', async (req, res) => {
  try {
    const { email } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.json({ ok: true }); // не розкриваємо чи є email

    const token = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + 3600000; // 1 год
    db.prepare('UPDATE users SET reset_token = ?, reset_expiry = ? WHERE id = ?').run(token, expiry, user.id);

    const resetUrl = `${BASE_URL}/?reset=${token}`;
    await sendMail(email, '🔑 Скидання пароля — PWA Dashboard', `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Скидання пароля</h2>
        <p>Натисніть кнопку нижче щоб встановити новий пароль. Посилання діє 1 годину.</p>
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

// Скидання пароля — встановити новий
app.post('/api/auth/reset', async (req, res) => {
  try {
    const { token, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE reset_token = ? AND reset_expiry > ?').get(token, Date.now());
    if (!user) return res.status(400).json({ error: 'Токен недійсний або вже використаний' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль мінімум 6 символів' });

    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password = ?, reset_token = NULL, reset_expiry = NULL WHERE id = ?').run(hash, user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// Інфо про поточного юзера
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, email, role, created_at, last_login FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// Зміна пароля
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const ok = await bcrypt.compare(oldPassword, user.password);
  if (!ok) return res.status(400).json({ error: 'Невірний поточний пароль' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Новий пароль мінімум 6 символів' });
  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});

// ==================== QR-КОД СЕСІЇ ====================
app.post('/api/qr/generate', authMiddleware, async (req, res) => {
  try {
    // Чистимо старі токени цього юзера
    db.prepare('DELETE FROM qr_tokens WHERE user_id = ? OR expires_at < ?').run(req.user.id, Date.now());

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 хвилин
    db.prepare('INSERT INTO qr_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, req.user.id, expiresAt);

    const url = `${BASE_URL}/?qr=${token}`;
    const qrDataUrl = await QRCode.toDataURL(url, { width: 256, margin: 2, color: { dark: '#fff', light: '#1a1a2e' } });

    res.json({ ok: true, qrDataUrl, url, expiresIn: 300 });
  } catch (e) {
    res.status(500).json({ error: 'Помилка генерації QR' });
  }
});

// Авторизація через QR-токен
app.post('/api/qr/auth', async (req, res) => {
  const { token } = req.body;
  const row = db.prepare('SELECT * FROM qr_tokens WHERE token = ? AND expires_at > ?').get(token, Date.now());
  if (!row) return res.status(400).json({ error: 'QR-код недійсний або застарів' });

  db.prepare('DELETE FROM qr_tokens WHERE token = ?').run(token);

  const user = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(row.user_id);
  const jwtToken = jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({ ok: true, token: jwtToken, user });
});

// ==================== ADMIN ROUTES ====================
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, email, role, verified, created_at, last_login FROM users').all();
  res.json(users);
});

app.patch('/api/admin/users/:id/role', authMiddleware, adminMiddleware, (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Не можна видалити себе' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ==================== DATA ROUTES (per-user) ====================

app.get('/api/clipboard', authMiddleware, (req, res) => {
  const data = getUserData(req.user.id);
  res.json({ content: data.clipboard });
});

app.get('/api/notes', authMiddleware, (req, res) => {
  const data = getUserData(req.user.id);
  res.json(data.notes);
});

app.get('/api/statistics', authMiddleware, async (req, res) => {
  try {
    const data = getUserData(req.user.id);
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

// ==================== FILES (per-user) ====================

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
  } catch {
    res.json([]);
  }
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Middleware що підтримує token і як query param (для download через <a>)
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

app.get('/api/download/:filename', flexAuthMiddleware, (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const userDir  = getUserUploadsPath(req.user.id);
    const filePath = path.join(userDir, filename);
    if (!path.resolve(filePath).startsWith(path.resolve(userDir)))
      return res.status(400).json({ error: 'Недопустимий шлях' });
    if (!fsSync.existsSync(filePath)) return res.status(404).json({ error: 'Файл не знайдено' });
    res.download(filePath);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== WEBSOCKET ====================
// clients: Map<clientId, { ws, userId }>
const clients = new Map();

wss.on('connection', (ws, req) => {
  const clientId = crypto.randomUUID();
  let userId = null;

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);

      // Перша авторизація через WS
      if (msg.type === 'auth') {
        try {
          const payload = jwt.verify(msg.token, JWT_SECRET);
          userId = payload.id;
          clients.set(clientId, { ws, userId });
          console.log(`✅ WS auth: ${payload.username} (${clientId})`);

          const data = getUserData(userId);
          ws.send(JSON.stringify({ type: 'init', clipboard: data.clipboard, notes: data.notes }));
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
          ws.close();
        }
        return;
      }

      if (!userId) return; // не авторизований

      if (msg.type === 'clipboard') {
        const content = msg.content;
        db.prepare('UPDATE user_data SET clipboard = ? WHERE user_id = ?').run(content, userId);
        broadcastToUser(userId, 'clipboard', { content }, clientId);
      }

      if (msg.type === 'notes') {
        const { mode, ...incoming } = msg.data;
        const current = getUserData(userId);
        const merged = { ...current.notes, ...incoming };
        db.prepare('UPDATE user_data SET notes = ? WHERE user_id = ?').run(JSON.stringify(merged), userId);
        broadcastToUser(userId, 'notes', incoming, clientId);
      }
    } catch (e) {
      console.error('WS error:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(clientId);
  });
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
║     🚀 PWA DASHBOARD (multi-user)     ║
╚════════════════════════════════════════╝
📱 http://localhost:${PORT}
📁 Файли: ${HDD_PATH}
💾 БД: ${DATA_DIR}/dashboard.db
  `);
});
