# 🚀 Оновлення до multi-user версії

## 1. Встанови нові залежності
```bash
npm install
```
Нові пакети: `better-sqlite3`, `bcrypt`, `jsonwebtoken`, `nodemailer`, `qrcode`

## 2. Налаштуй .env
```bash
cp .env.example .env
```
Відредагуй `.env`:
- `JWT_SECRET` — будь-який довгий рядок (мінімум 32 символи)
- `BASE_URL` — адреса сервера (напр. `http://192.168.1.100:3000`)
- `SMTP_USER` / `SMTP_PASS` — Gmail + App Password

### Gmail App Password:
1. Google Account → Security → 2-Step Verification (увімкни)
2. Google Account → Security → App passwords
3. Створи пароль для "Mail" → скопіюй 16-значний код

## 3. Заміни файли
- `server.js` → новий `server.js`
- `public/index.html` → новий `index.html`
- `package.json` → новий `package.json`

## 4. Запусти
```bash
node server.js
```

## 5. Перший запуск
- Зареєструй перший акаунт — він автоматично стане **адміном**
- Підтверди email (або якщо SMTP не налаштований — у консолі буде лінк)
- Всі наступні реєстрації — звичайні користувачі

## Важливо
- Без SMTP підтвердження email виводиться в консоль сервера
- Якщо SMTP не потрібен — можна забрати поле `verified` з перевірок (рядок у server.js)
- БД зберігається в `data/dashboard.db`
- Файли кожного юзера в `uploads/<user_id>/`
