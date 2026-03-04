// ==================== КОНФИГ ====================
const PORT = 3000;
const HDD_PATH = process.env.HDD_PATH || './uploads'; // Путь к папке для файлов
const DATA_DIR = './data';
const NOTES_FILE = `${DATA_DIR}/notes.json`;
const CLIPBOARD_FILE = `${DATA_DIR}/clipboard.json`;

// ==================== ЗАВИСИМОСТИ ====================
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Упорядочиваем данные и создаем необходимые папки
if (!fsSync.existsSync(DATA_DIR)) {
  fsSync.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fsSync.existsSync(HDD_PATH)) {
  fsSync.mkdirSync(HDD_PATH, { recursive: true });
}

// Хранилище клиентов
const clients = new Map();
let clipboardData = '';
let notesData = { mode: 'text', content: '', tasks: [] };

// ==================== ИНИЦИАЛИЗАЦИЯ ДАННЫХ ====================
async function initializeData() {
  try {
    // Загружаем буфер обмена
    if (fsSync.existsSync(CLIPBOARD_FILE)) {
      const data = await fs.readFile(CLIPBOARD_FILE, 'utf8');
      clipboardData = JSON.parse(data).content || '';
    }

    // Загружаем заметки
    if (fsSync.existsSync(NOTES_FILE)) {
      const data = await fs.readFile(NOTES_FILE, 'utf8');
      notesData = JSON.parse(data);
    }
  } catch (error) {
    console.error('Ошибка при загрузке данных:', error.message);
  }
}

// ==================== MIDDLEWARE ====================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, HDD_PATH);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    cb(null, `${timestamp}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// ==================== API ENDPOINTS ====================

// Получить список файлов
app.get('/api/files', async (req, res) => {
  try {
    if (!fsSync.existsSync(HDD_PATH)) {
      return res.json([]);
    }

    const files = await fs.readdir(HDD_PATH);
    const fileList = [];

    for (const file of files) {
      try {
        const stats = await fs.stat(path.join(HDD_PATH, file));
        if (stats.isFile()) {
          fileList.push({
            name: file,
            size: stats.size,
            modified: stats.mtime.toISOString()
          });
        }
      } catch (error) {
        console.error(`Ошибка при чтении информации о файле ${file}:`, error.message);
      }
    }

    res.json(fileList.sort((a, b) => new Date(b.modified) - new Date(a.modified)));
  } catch (error) {
    console.error('Ошибка при чтении файлов:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Загрузка файла
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (req.file) {
    // Отправляем обновление всем клиентам
    broadcastMessage('filesUpdated', {});
    res.json({ success: true, filename: req.file.filename });
  } else {
    res.status(400).json({ error: 'Файл не загружен' });
  }
});

// Удаление файла
app.delete('/api/files/:filename', async (req, res) => {
  try {
    const filePath = path.join(HDD_PATH, decodeURIComponent(req.params.filename));

    // Проверка безопасности: убеждаемся, что файл находится в правильной папке
    if (!filePath.startsWith(path.resolve(HDD_PATH))) {
      return res.status(400).json({ error: 'Недопустимый путь' });
    }

    await fs.unlink(filePath);
    broadcastMessage('filesUpdated', {});
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка при удалении файла:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Скачивание файла
app.get('/api/download/:filename', (req, res) => {
  try {
    const filePath = path.join(HDD_PATH, decodeURIComponent(req.params.filename));

    // Проверка безопасности
    if (!filePath.startsWith(path.resolve(HDD_PATH))) {
      return res.status(400).json({ error: 'Недопустимый путь' });
    }

    res.download(filePath);
  } catch (error) {
    console.error('Ошибка при скачивании файла:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Получить текущее состояние буфера обмена
app.get('/api/clipboard', (req, res) => {
  res.json({ content: clipboardData });
});

// Получить текущее состояние заметок
app.get('/api/notes', (req, res) => {
  res.json(notesData);
});

// ==================== WEBSOCKET ====================
wss.on('connection', (ws) => {
  const clientId = Date.now() + Math.random();
  clients.set(clientId, ws);

  console.log(`[${new Date().toLocaleTimeString()}] ✅ Подключен клиент: ${clientId}`);
  console.log(`Всего клиентов: ${clients.size}`);

  // Отправляем текущее состояние
  ws.send(JSON.stringify({
    type: 'init',
    clipboard: clipboardData,
    notes: notesData
  }));

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === 'clipboard') {
        clipboardData = message.content;
        // Сохраняем в файл
        await fs.writeFile(CLIPBOARD_FILE, JSON.stringify({ content: clipboardData }));
        // Отправляем всем клиентам
        broadcastMessage('clipboard', { content: clipboardData }, clientId);
      }

      if (message.type === 'notes') {
        notesData = message.data;
        // Сохраняем в файл
        await fs.writeFile(NOTES_FILE, JSON.stringify(notesData));
        // Отправляем всем клиентам
        broadcastMessage('notes', notesData, clientId);
      }
    } catch (error) {
      console.error('Ошибка при обработке сообщения:', error.message);
    }
  });

  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`[${new Date().toLocaleTimeString()}] ❌ Отключен клиент: ${clientId}`);
    console.log(`Всего клиентов: ${clients.size}`);
  });

  ws.on('error', (error) => {
    console.error('WebSocket ошибка:', error.message);
  });
});

// ==================== УТИЛИТЫ ====================
function broadcastMessage(type, data, excludeClientId = null) {
  const message = JSON.stringify({ type, ...data });

  clients.forEach((client, clientId) => {
    if (clientId !== excludeClientId && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ==================== ЗАПУСК СЕРВЕРА ====================
initializeData().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════╗
║     🚀 PWA DASHBOARD ЗАПУЩЕН 🚀        ║
╚════════════════════════════════════════╝

📱 Открой в браузере: http://localhost:${PORT}
🌐 Из локальной сети: http://<IP-телефона>:${PORT}

📁 Путь к файлам: ${HDD_PATH}
💾 Данные сохраняются в: ${DATA_DIR}

Нажми Ctrl+C для остановки сервера
────────────────────────────────────────
    `);
  });
});

process.on('SIGINT', async () => {
  console.log('\n\n📤 Сохраняю данные...');
  await fs.writeFile(CLIPBOARD_FILE, JSON.stringify({ content: clipboardData }));
  await fs.writeFile(NOTES_FILE, JSON.stringify(notesData));
  console.log('✅ Данные сохранены. До встречи!');
  process.exit(0);
});
