const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const basicAuth = require('express-basic-auth');

// ================= НАСТРОЙКИ =================
const TOKEN = '---'; 
const WEBAPP_URL = '---';
const KITCHEN_CHAT_ID = '---'; 

const PORT = 3000;
const app = express();
const bot = new TelegramBot(TOKEN, { polling: true });

// 1. Базовые настройки (парсинг JSON и CORS)
app.use(express.json());
app.use(cors());

// 2. Создаем "вышибалу"
const adminAuth = basicAuth({
    users: { 'PIDIDI': 'EPSTEIN' },
    challenge: true,
    realm: 'Admin Panel'
});

// 3. СТАВИМ ЗАЩИТУ ДО РАЗДАЧИ ФАЙЛОВ!
app.use('/kitchen.html', adminAuth);
app.use('/api/admin', adminAuth);

// 4. И только теперь разрешаем раздавать файлы (например, index.html для клиентов)
app.use(express.static(path.join(__dirname, 'public')));

// ================= БАЗА ДАННЫХ =================
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS locations (id INTEGER PRIMARY KEY, name TEXT, open_time TEXT DEFAULT '11:00', close_time TEXT DEFAULT '23:00', is_active INTEGER DEFAULT 1)");
    // type теперь может быть 'main', 'addon' или 'both'
    db.run("CREATE TABLE IF NOT EXISTS menu (id INTEGER PRIMARY KEY, location_id INTEGER, category TEXT, name TEXT, price INTEGER, type TEXT DEFAULT 'main', is_available INTEGER DEFAULT 1, FOREIGN KEY(location_id) REFERENCES locations(id))");
    db.run("CREATE TABLE IF NOT EXISTS item_addons (main_id INTEGER, addon_id INTEGER, FOREIGN KEY(main_id) REFERENCES menu(id), FOREIGN KEY(addon_id) REFERENCES menu(id))");
    db.run("CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, location_id INTEGER, tg_id TEXT, username TEXT, details TEXT, comment TEXT, ready_time TEXT, status TEXT, created_at TEXT, late_notified INTEGER DEFAULT 0, FOREIGN KEY(location_id) REFERENCES locations(id))");
    
    db.get("SELECT count(*) as count FROM locations", (err, row) => {
        if (row.count === 0) {
            db.serialize(() => {
                db.run("INSERT INTO locations (name, open_time, close_time) VALUES ('Московское шоссе 13жд', '11:00', '23:00')");
                db.run("INSERT INTO locations (name, open_time, close_time) VALUES ('проспект Пятилеток 8', '11:00', '23:00')");

                const seedMenuForLocation = (locId) => {
                    const stmt = db.prepare(`INSERT INTO menu (location_id, category, name, price, type) VALUES (${locId}, ?, ?, ?, ?)`);
                    
                    const chebureks = [ ["Говядина и свинина", 210], ["Мраморная говядина", 230], ["Баранина", 240], ["Ветчина сыр", 225], ["Сыр зелень", 230], ["Сыр", 220], ["Четыре сыра", 300], ["Картошка сыр бекон", 245], ["Картошка грибы", 195], ["Чебурек - пицца", 270], ["Пепперони", 235], ["Вишня", 225], ["Банан шоколад", 230] ];
                    chebureks.forEach(i => stmt.run("Чебуреки", i[0], i[1], "main"));
                    
                    const snacks = [ ["Картофель фри", 170], ["Картофель айдахо", 190], ["Наггетсы", 180], ["Хворост", 100], ["Сырные палочки", 180], ["Пельмени жаренные", 350] ];
                    snacks.forEach(i => stmt.run("Закуски", i[0], i[1], "main"));
                    
                    const drinks = [ ["Чай", 60], ["Американо 0.2", 120], ["Капучино 0.2", 140], ["Латте 0.2", 140], ["Сок", 130], ["Лимонад", 180] ];
                    drinks.forEach(i => stmt.run("Напитки", i[0], i[1], "main"));
                    
                    stmt.run("Сезонные блюда", "Чебурек с брынзой", 250, "main");
                    stmt.run("Сезонные блюда", "Комбо (Чебурек+Фри+Напиток)", 450, "main");

                    // ИЗМЕНЕНО: Добавки и соусы создаются ОДИН РАЗ с типом 'both'
                    const ingredients = [ ["Сыр", 60], ["Доп мясо", 85], ["Бекон", 65], ["Халапеньо", 40], ["Огурцы соленые", 40], ["Ветчина", 60], ["Пепперони", 60], ["Томаты", 50], ["Грибы", 50], ["Зелень", 35], ["Картошка фри", 65] ];
                    ingredients.forEach(i => stmt.run("Соусы и добавки", i[0], i[1], "both"));
                    
                    const sauces = [ ["Сырный соус", 60], ["Сметанный соус", 60], ["Кетчунез", 60], ["Острый соус", 60] ];
                    sauces.forEach(i => stmt.run("Соусы и добавки", i[0], i[1], "both"));

                    // Выбор для комбо остается скрытым ('addon')
                    const comboChoices = [ ["Чебурек: Мясной", 0], ["Чебурек: Сырный", 0], ["Напиток: Сок", 0], ["Напиток: Чай", 0] ];
                    comboChoices.forEach(i => stmt.run("Комбо_выбор", i[0], i[1], "addon"));
                    stmt.finalize();

                    // ИЗМЕНЕНО: Умная авто-привязка
                    // Привязываем все ингредиенты к Чебурекам
                    db.run(`INSERT INTO item_addons (main_id, addon_id) SELECT m1.id, m2.id FROM menu m1, menu m2 WHERE m1.location_id = ${locId} AND m2.location_id = ${locId} AND m1.category = 'Чебуреки' AND m2.category = 'Соусы и добавки'`);
                    // Привязываем ТОЛЬКО соусы к Закускам (Ищем слово "соус" или "Кетчунез" в названии)
                    db.run(`INSERT INTO item_addons (main_id, addon_id) SELECT m1.id, m2.id FROM menu m1, menu m2 WHERE m1.location_id = ${locId} AND m2.location_id = ${locId} AND m1.category = 'Закуски' AND m2.category = 'Соусы и добавки' AND (m2.name LIKE '%соус%' OR m2.name = 'Кетчунез')`);
                    // Привязываем Комбо
                    db.run(`INSERT INTO item_addons (main_id, addon_id) SELECT m1.id, m2.id FROM menu m1, menu m2 WHERE m1.location_id = ${locId} AND m2.location_id = ${locId} AND m1.name LIKE 'Комбо%' AND m2.category = 'Комбо_выбор'`);
                };

                seedMenuForLocation(1);
                seedMenuForLocation(2);
            });
        }
    });
});

setInterval(() => {
    db.all("SELECT id, tg_id, ready_time FROM orders WHERE status = 'new' AND late_notified = 0", [], (err, rows) => {
        if (err || !rows) return;
        const now = Date.now();
        rows.forEach(order => {
            const readyTimestamp = new Date(order.ready_time + '+03:00').getTime();
            if (now > readyTimestamp) {
                db.run("UPDATE orders SET late_notified = 1 WHERE id = ?", [order.id]);
                if (order.tg_id !== 'test_user') bot.sendMessage(order.tg_id, "😔 К сожалению, не успеваем сделать ваш заказ к назначенному времени, но мы очень торопимся!");
            }
        });
    });
}, 60000);

// ================= API АДМИНКИ =================
app.get('/api/admin/locations', (req, res) => db.all("SELECT * FROM locations", [], (err, rows) => res.json(rows)));
app.post('/api/admin/locations', (req, res) => {
    const { name, open_time, close_time } = req.body;
    db.run("INSERT INTO locations (name, open_time, close_time) VALUES (?, ?, ?)", [name, open_time, close_time], err => res.json({ success: !err }));
});
app.put('/api/admin/locations/:id', (req, res) => {
    const { name, open_time, close_time, is_active } = req.body;
    db.run("UPDATE locations SET name = ?, open_time = ?, close_time = ?, is_active = ? WHERE id = ?", [name, open_time, close_time, is_active, req.params.id], err => res.json({ success: !err }));
});

app.get('/api/admin/menu/:location_id', (req, res) => {
    db.all("SELECT * FROM menu WHERE location_id = ?", [req.params.location_id], (err, menuItems) => {
        db.all("SELECT ia.* FROM item_addons ia JOIN menu m ON ia.main_id = m.id WHERE m.location_id = ?", [req.params.location_id], (err, mappings) => {
            res.json({ menu: menuItems, addons: mappings });
        });
    });
});
app.post('/api/admin/menu/:id/toggle', (req, res) => db.run("UPDATE menu SET is_available = ? WHERE id = ?", [req.body.is_available, req.params.id], err => res.json({ success: !err })));
app.post('/api/admin/menu', (req, res) => {
    const { location_id, category, name, price, type } = req.body;
    db.run("INSERT INTO menu (location_id, category, name, price, type) VALUES (?, ?, ?, ?, ?)", [location_id, category, name, price, type], err => res.json({ success: !err }));
});
app.put('/api/admin/menu/:id', (req, res) => {
    const { name, price, category, type } = req.body;
    db.run("UPDATE menu SET name = ?, price = ?, category = ?, type = ? WHERE id = ?", [name, price, category, type, req.params.id], err => res.json({ success: !err }));
});
app.delete('/api/admin/menu/:id', (req, res) => {
    const id = req.params.id;
    db.run("DELETE FROM item_addons WHERE main_id = ? OR addon_id = ?", [id, id], () => {
        db.run("DELETE FROM menu WHERE id = ?", [id], err => res.json({ success: !err }));
    });
});
app.post('/api/admin/menu/:id/addons', (req, res) => {
    const main_id = req.params.id;
    const { addon_ids } = req.body; 
    db.run("DELETE FROM item_addons WHERE main_id = ?", [main_id], () => {
        if (!addon_ids || addon_ids.length === 0) return res.json({ success: true });
        const stmt = db.prepare("INSERT INTO item_addons (main_id, addon_id) VALUES (?, ?)");
        addon_ids.forEach(a_id => stmt.run(main_id, a_id));
        stmt.finalize();
        res.json({ success: true });
    });
});

// ================= API КЛИЕНТА =================
app.get('/api/locations', (req, res) => db.all("SELECT * FROM locations", [], (err, rows) => res.json(rows)));

app.get('/api/menu', (req, res) => {
    const locId = req.query.location_id;
    db.all("SELECT * FROM menu WHERE is_available = 1 AND location_id = ?", [locId], (err, menuItems) => {
        if (err) return res.status(500).json({error: err.message});
        db.all("SELECT ia.main_id, ia.addon_id FROM item_addons ia JOIN menu m ON ia.main_id = m.id WHERE m.location_id = ?", [locId], (err, mappings) => {
            const mapDict = {};
            mappings.forEach(m => {
                if (!mapDict[m.main_id]) mapDict[m.main_id] = [];
                mapDict[m.main_id].push(m.addon_id);
            });
            menuItems.forEach(item => { if (item.type !== 'addon') item.allowed_addons_ids = mapDict[item.id] || []; });
            res.json(menuItems);
        });
    });
});

app.post('/api/order', (req, res) => {
    const { location_id, tg_id, username, items, time, comment } = req.body;
    
    db.get("SELECT * FROM locations WHERE id = ?", [location_id], (err, location) => {
        if (!location) return res.status(400).json({ error: "Заведение не найдено" });
        if (location.is_active === 0) return res.status(400).json({ error: "В данный момент заведение не принимает предзаказы (Экстренная остановка)." });

        const orderTimeMs = new Date(time + '+03:00').getTime();
        const nowMs = Date.now();
        if (orderTimeMs < nowMs + 19 * 60 * 1000 || orderTimeMs > nowMs + 48 * 60 * 60 * 1000) return res.status(400).json({ error: "Недопустимое время (мин 20 минут, макс 2 суток)" });

        const orderDate = new Date(time + '+03:00');
        const orderTimeFloat = orderDate.getHours() + (orderDate.getMinutes() / 60);
        const [openH, openM] = location.open_time.split(':').map(Number);
        const [closeH, closeM] = location.close_time.split(':').map(Number);
        if (orderTimeFloat < (openH + openM/60) || orderTimeFloat >= (closeH + closeM/60)) return res.status(400).json({ error: `Это заведение принимает предзаказы только на время с ${location.open_time} до ${location.close_time}.` });

        let allItemIds = [];
        items.forEach(item => { allItemIds.push(item.main.id); item.addons.forEach(a => allItemIds.push(a.id)); });
        if (allItemIds.length === 0) return res.status(400).json({ error: "Пустая корзина" });

        const placeholders = allItemIds.map(() => '?').join(',');
        db.all(`SELECT name, is_available FROM menu WHERE id IN (${placeholders})`, allItemIds, (err, rows) => {
            const outOfStock = rows.filter(r => r.is_available === 0);
            if (outOfStock.length > 0) return res.status(400).json({ error: `Эти позиции закончились: ${outOfStock.map(r => r.name).join(', ')}.` });

            const createdAt = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
            const details = items.map(i => {
                const addonsText = i.addons.length > 0 ? `\n   └ ${i.addons.map(a => a.name).join(', ')}` : '';
                return `▪️ ${i.main.name} (x${i.count})${addonsText}`;
            }).join('\n');
            const total = items.reduce((sum, i) => sum + (i.totalItemPrice * i.count), 0);

            db.run("INSERT INTO orders (location_id, tg_id, username, details, comment, ready_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", 
                [location_id, tg_id, username, details, comment, time, 'new', createdAt], function(err) {
                    const clientInfo = username ? `@${username}` : `ID: ${tg_id}`;
                    const commentText = comment ? `\n💬 Комментарий: ${comment}` : '';
                    bot.sendMessage(KITCHEN_CHAT_ID, `📍 Точка: ${location.name}\n🔥 НОВЫЙ ЗАКАЗ #${this.lastID}\n👤 Клиент: ${clientInfo}\n\nСостав:\n${details}${commentText}\n\nСумма: ${total} руб.\n⏰ К времени: ${time.replace('T', ' ')}`, 
                        { reply_markup: { inline_keyboard: [[ { text: "👨‍🍳 Открыть панель кухни", url: `${WEBAPP_URL}/kitchen.html` } ]] } }
                    );
                    res.json({ success: true, orderId: this.lastID });
            });
        });
    });
});

app.get('/api/my_orders', (req, res) => {
    db.all("SELECT o.*, l.name as loc_name FROM orders o JOIN locations l ON o.location_id = l.id WHERE o.tg_id = ? AND o.status = 'new' ORDER BY o.id DESC", [req.query.tg_id], (err, rows) => res.json(rows || []));
});

app.post('/api/orders/:id/cancel_by_user', (req, res) => {
    db.run("UPDATE orders SET status = 'cancelled' WHERE id = ? AND tg_id = ? AND status = 'new'", [req.params.id, req.body.tg_id], function(err) {
        if (this.changes > 0) { bot.sendMessage(KITCHEN_CHAT_ID, `⚠️ Клиент отменил свой заказ #${req.params.id}!`); res.json({ success: true }); } 
        else res.json({ success: false, error: "Ошибка отмены" });
    });
});

// ================= API КУХНИ =================
app.get('/api/orders', (req, res) => db.all("SELECT o.*, l.name as loc_name FROM orders o JOIN locations l ON o.location_id = l.id ORDER BY o.id DESC", [], (err, rows) => res.json(rows)));
app.post('/api/orders/:id/status', (req, res) => {
    db.run("UPDATE orders SET status = ? WHERE id = ?", [req.body.status, req.params.id], function() {
        db.get("SELECT tg_id FROM orders WHERE id = ?", [req.params.id], (err, row) => {
            if (row && row.tg_id !== 'test_user') {
                if (req.body.status === 'ready') bot.sendMessage(row.tg_id, `✅ Ваш заказ готов и ждет вас! Приятного аппетита!`);
                else if (req.body.status === 'cancelled') bot.sendMessage(row.tg_id, `❌ К сожалению, мы вынуждены отменить ваш заказ. Приносим извинения.`);
            }
        });
        res.json({ success: true });
    });
});

bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, "Добро пожаловать в «Чебуречную У Мартина»! Выберите заведение и сделайте заказ:", { reply_markup: { inline_keyboard: [[{ text: "📍 Выбрать заведение", web_app: { url: WEBAPP_URL } }]] } }));
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));