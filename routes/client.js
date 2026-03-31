const express = require('express');

module.exports = (db, bot, config) => {
    const router = express.Router();
    const { KITCHEN_CHAT_ID, WEBAPP_URL } = config;

    // ================= API КЛИЕНТА =================
    router.post('/users', (req, res) => {
        const { tg_id, username } = req.body;
        if (!tg_id) return res.status(400).json({ error: 'tg_id is required' });
        db.get("SELECT * FROM users WHERE tg_id = ?", [tg_id], (err, user) => {
            if (user) {
                db.run("UPDATE users SET username = ? WHERE tg_id = ?", [username, tg_id]);
                res.json(user);
            } else {
                db.run("INSERT INTO users (tg_id, username) VALUES (?, ?)", [tg_id, username], function() {
                    res.json({ tg_id, username, last_location_id: null, points: 0 });
                });
            }
        });
    });
    router.put('/users/:tg_id/location', (req, res) => {
        db.run("UPDATE users SET last_location_id = ? WHERE tg_id = ?", [req.body.location_id, req.params.tg_id], err => res.json({ success: !err }));
    });

    router.get('/locations', (req, res) => db.all("SELECT * FROM locations", [], (err, rows) => res.json(rows)));

    router.get('/menu', (req, res) => {
        const locId = req.query.location_id;
        db.all("SELECT m.* FROM menu m JOIN menu_availability ma ON m.id = ma.menu_id WHERE ma.location_id = ? AND ma.is_available = 1 ORDER BY m.sort_order ASC, m.id ASC", [locId], (err, menuItems) => {
            if (err) return res.status(500).json({error: err.message});
            db.all("SELECT * FROM item_addons", [], (err, mappings) => {
                const mapDict = {};
                mappings.forEach(m => {
                    if (!mapDict[m.main_id]) mapDict[m.main_id] = [];
                    mapDict[m.main_id].push(m.addon_id);
                });
                menuItems.forEach(item => { if (item.type !== 'addon') item.allowed_addons_ids = mapDict[item.id] || []; });
                res.json(menuItems || []);
            });
        });
    });

    router.post('/order', (req, res) => {
        const { location_id, tg_id, username, items, time, comment } = req.body;
        
        db.get("SELECT * FROM locations WHERE id = ?", [location_id], (err, location) => {
            if (!location) return res.status(400).json({ error: "Заведение не найдено" });
            if (location.is_active === 0) return res.status(400).json({ error: "В данный момент заведение не принимает предзаказы (Экстренная остановка)." });

            const orderTimeMs = new Date(time + '+03:00').getTime();
            const nowMs = Date.now();
            if (orderTimeMs < nowMs + 9 * 60 * 1000 || orderTimeMs > nowMs + 48 * 60 * 60 * 1000) return res.status(400).json({ error: "Недопустимое время (мин 10 минут, макс 2 суток)" });

            const orderDate = new Date(time + '+03:00');
            const orderTimeFloat = orderDate.getHours() + (orderDate.getMinutes() / 60);
            const [openH, openM] = location.open_time.split(':').map(Number);
            const [closeH, closeM] = location.close_time.split(':').map(Number);
            if (orderTimeFloat < (openH + openM/60) || orderTimeFloat >= (closeH + closeM/60)) return res.status(400).json({ error: `Это заведение принимает предзаказы только на время с ${location.open_time} до ${location.close_time}.` });

            let allItemIds = [];
            items.forEach(item => { allItemIds.push(item.main.id); item.addons.forEach(a => allItemIds.push(a.id)); });
            if (allItemIds.length === 0) return res.status(400).json({ error: "Пустая корзина" });

            const placeholders = allItemIds.map(() => '?').join(',');
            db.all(`SELECT m.name, COALESCE(ma.is_available, 0) as is_available FROM menu m LEFT JOIN menu_availability ma ON m.id = ma.menu_id AND ma.location_id = ? WHERE m.id IN (${placeholders})`, [location_id, ...allItemIds], (err, rows) => {
                const outOfStock = rows.filter(r => r.is_available === 0);
                if (outOfStock.length > 0) return res.status(400).json({ error: `Эти позиции закончились: ${outOfStock.map(r => r.name).join(', ')}.` });

                const createdAt = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
                const details = items.map(i => {
                    const addonsText = i.addons.length > 0 ? `\n   └ ${i.addons.map(a => a.name).join(', ')}` : '';
                    return `▪️ ${i.main.name} (x${i.count})${addonsText}`;
                }).join('\n');
                const total = items.reduce((sum, i) => sum + (i.totalItemPrice * i.count), 0);

                db.run("INSERT INTO orders (location_id, tg_id, username, details, comment, ready_time, status, created_at, total_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", 
                    [location_id, tg_id, username, details, comment, time, 'new', createdAt, total], function(err) {
                        const clientInfo = username ? `@${username}` : `ID: ${tg_id}`;
                        const commentText = comment ? `\n💬 Комментарий: ${comment}` : '';
                        bot.sendMessage(KITCHEN_CHAT_ID, `📍 Точка: ${location.name}\n🔥 НОВЫЙ ЗАКАЗ #${this.lastID}\n👤 Клиент: ${clientInfo}\n\nСостав:\n${details}${commentText}\n\nСумма: ${total} руб.\n⏰ К времени: ${time.replace('T', ' ')}`, 
                            { reply_markup: { inline_keyboard: [[ { text: "👨‍🍳 Открыть панель кухни", url: `${WEBAPP_URL}/kitchen.html` } ]] } }
                        ).catch(err => console.error('[Telegram Bot] Ошибка отправки заказа в чат кухни. Проверьте KITCHEN_CHAT_ID и права бота:', err.message));
                        res.json({ success: true, orderId: this.lastID });
                });
            });
        });
    });

    router.get('/my_orders', (req, res) => {
        db.all("SELECT o.*, l.name as loc_name FROM orders o JOIN locations l ON o.location_id = l.id WHERE o.tg_id = ? AND o.status = 'new' ORDER BY o.id DESC", [req.query.tg_id], (err, rows) => res.json(rows || []));
    });

    router.post('/orders/:id/cancel_by_user', (req, res) => {
        db.run("UPDATE orders SET status = 'cancelled' WHERE id = ? AND tg_id = ? AND status = 'new'", [req.params.id, req.body.tg_id], function(err) {
            if (this.changes > 0) { bot.sendMessage(KITCHEN_CHAT_ID, `⚠️ Клиент отменил свой заказ #${req.params.id}!`); res.json({ success: true }); } 
            else res.json({ success: false, error: "Ошибка отмены" });
        });
    });

    return router;
};