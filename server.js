const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { SocksProxyAgent } = require('socks-proxy-agent');
const path = require('path');
const cors = require('cors');
const basicAuth = require('express-basic-auth');
const fs = require('fs');
const zlib = require('zlib');
const compression = require('compression');
const db = require('./database'); // Подключаем базу данных
const config = require('./config'); // Подключаем файл с настройками

// ================= НАСТРОЙКИ =================
const TOKEN = config.TOKEN; 
const WEBAPP_URL = config.WEBAPP_URL;
const KITCHEN_CHAT_ID = config.KITCHEN_CHAT_ID; 

const PORT = 3000;
const app = express();

const botOptions = { polling: true };
if (config.PROXY_URL) {
    const agent = new SocksProxyAgent(config.PROXY_URL);
    botOptions.request = { agent: agent };
    console.log('🌐 Бот использует SOCKS5 прокси');
}

// Альтернативный способ: Проксирование самого API Телеграма (например, через Cloudflare)
if (config.TG_API_PROXY) {
    botOptions.baseApiUrl = config.TG_API_PROXY;
    console.log(`🌐 Бот использует прокси-API: ${config.TG_API_PROXY}`);
}
const bot = new TelegramBot(TOKEN, botOptions);

bot.on('polling_error', (error) => {
    console.log('❌ Ошибка Telegram Polling:', error.code, error.message);
});

bot.getMe().then((me) => {
    console.log(`✅ Бот @${me.username} успешно связался с Telegram!`);
}).catch((err) => {
    console.log(`❌ Ошибка связи с Telegram:`, err.message);
});

// 1. Базовые настройки (парсинг JSON и CORS)
app.use(express.json());
app.use(cors());
// Включаем GZIP-сжатие всех ответов сервера
app.use(compression());

// 2. Создаем "вышибалу"
const adminUser = config.ADMIN_USER || 'admin';
const adminPass = config.ADMIN_PASS || 'secret';

const adminAuth = basicAuth({
    users: { [adminUser]: adminPass },
    challenge: true,
    realm: 'Admin Panel'
});

// 3. СТАВИМ ЗАЩИТУ ДО РАЗДАЧИ ФАЙЛОВ!
app.use('/kitchen.html', adminAuth);
app.use('/api/admin', adminAuth);

// 4. Раздача статики с кэшированием (картинки кэшируются на 7 дней)
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '7d', // Браузер не будет запрашивать файлы заново 7 дней
    etag: true
}));

// Подключаем роуты
const adminRoutes = require('./routes/admin')(db, bot);
const clientRoutes = require('./routes/client')(db, bot, { KITCHEN_CHAT_ID, WEBAPP_URL });
const integrationRoutes = require('./routes/integrations')(db, bot, config);

app.use('/api', adminRoutes);
app.use('/api', clientRoutes);
app.use('/api', integrationRoutes);

setInterval(() => {
    db.all("SELECT id, tg_id, ready_time FROM orders WHERE status = 'new' AND late_notified = 0", [], (err, rows) => {
        if (err || !rows) return;
        const now = Date.now();
        rows.forEach(order => {
            const readyTimestamp = new Date(order.ready_time + '+03:00').getTime();
            if (now > readyTimestamp) {
                db.run("UPDATE orders SET late_notified = 1 WHERE id = ?", [order.id]);
                if (order.tg_id !== 'test_user') {
                    bot.sendMessage(order.tg_id, "😔 К сожалению, не успеваем сделать ваш заказ к назначенному времени, но мы очень торопимся!").catch(e => console.error(`[Telegram Bot] Ошибка отправки уведомления об опоздании заказа #${order.id} клиенту ${order.tg_id}:`, e.message));
                }
            }
        });
    });
}, 60000);

// ================= АРХИВАЦИЯ СТАРЫХ ЗАКАЗОВ =================
function archiveOldOrders() {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
    const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

    // Ищем все заказы, дата которых (первые 10 символов YYYY-MM-DD) меньше сегодняшней
    db.all("SELECT o.*, l.name as loc_name FROM orders o LEFT JOIN locations l ON o.location_id = l.id WHERE substr(o.ready_time, 1, 10) < ?", [todayStr], (err, rows) => {
        if (err || !rows || rows.length === 0) return;

        const archiveBase = path.join(__dirname, 'archive');
        if (!fs.existsSync(archiveBase)) fs.mkdirSync(archiveBase);

        const groups = {};
        rows.forEach(o => {
            const date = o.ready_time.split('T')[0];
            // Очищаем имя точки от спецсимволов для безопасности файловой системы
            const locName = (o.loc_name || `Удаленная_точка_${o.location_id}`).replace(/[^a-zа-яё0-9]/gi, '_');
            const key = `${date}_${locName}`;
            if (!groups[key]) groups[key] = { date, locName, orders: [] };
            groups[key].orders.push(o);
        });

        Object.values(groups).forEach(g => {
            const dateFolder = path.join(archiveBase, g.date);
            if (!fs.existsSync(dateFolder)) fs.mkdirSync(dateFolder);

            const locFolder = path.join(dateFolder, g.locName);
            if (!fs.existsSync(locFolder)) fs.mkdirSync(locFolder);

            const filePath = path.join(locFolder, 'orders.json.gz');
            let existing = [];
            if (fs.existsSync(filePath)) {
                try { existing = JSON.parse(zlib.gunzipSync(fs.readFileSync(filePath)).toString()); } catch(e) {}
            }
            
            fs.writeFileSync(filePath, zlib.gzipSync(JSON.stringify(existing.concat(g.orders))));
        });

        // Удаляем перенесённые заказы и сжимаем файл базы данных (VACUUM)
        db.run("DELETE FROM orders WHERE substr(ready_time, 1, 10) < ?", [todayStr], (err) => { if (!err) db.run("VACUUM"); });
    });
}
setTimeout(archiveOldOrders, 5000); // Оставляем разовый запуск при старте сервера для подстраховки

function scheduleMidnightArchivation() {
    const moscowDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
    const nextMidnight = new Date(moscowDate);
    nextMidnight.setHours(24, 0, 0, 0); // Устанавливаем ровно на 00:00 следующего дня
    
    setTimeout(() => {
        archiveOldOrders();
        scheduleMidnightArchivation(); // Планируем следующий запуск на следующие сутки
    }, nextMidnight.getTime() - moscowDate.getTime());
}
scheduleMidnightArchivation();

// Бот
bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, "Добро пожаловать в «Чебуречную У Мартина»! Выберите заведение и сделайте заказ:", { reply_markup: { inline_keyboard: [[{ text: "📍 Выбрать заведение", web_app: { url: WEBAPP_URL } }]] } }));
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));