function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = (db, bot, config) => {
    const router = express.Router();
    const { KITCHEN_CHAT_ID, WEBAPP_URL } = config;

    // ================= API КЛИЕНТА =================
    router.post('/users', (req, res) => {
        const { tg_id, username, full_name } = req.body;
        if (!tg_id) return res.status(400).json({ error: 'tg_id is required' });
        const cleanUsername = username ? String(username).replace(/^@/, '').trim() : '';
        const hasUsername = /^[a-zA-Z0-9_]{4,32}$/.test(cleanUsername);
        const displayName = hasUsername ? `@${cleanUsername}` : (full_name || username || '');

        db.get("SELECT * FROM users WHERE tg_id = ?", [tg_id], (err, user) => {
            if (user) {
                db.run("UPDATE users SET username = ? WHERE tg_id = ?", [displayName, tg_id]);
                res.json(user);
            } else {
                db.run("INSERT INTO users (tg_id, username) VALUES (?, ?)", [tg_id, displayName], function(err) {
                    res.json({ tg_id, username: displayName, last_location_id: null, points: 0 });
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

    const inFlightOrders = new Set();
    const recentOrders = new Map(); // tg_id -> { timestamp, signature, orderId }

    // Очистка старых записей дедупликации каждые 5 минут
    setInterval(() => {
        const now = Date.now();
        for (const [key, val] of recentOrders.entries()) {
            if (now - val.timestamp > 60000) {
                recentOrders.delete(key);
            }
        }
    }, 300000);

    router.post('/order', (req, res) => {
        const { location_id, tg_id, username, full_name, items, time, comment } = req.body;
        
        if (!tg_id) {
            return res.status(400).json({ error: "Не передан идентификатор пользователя" });
        }

        const lockKey = String(tg_id);

        // 1. Защита от параллельных одновременных запросов (Race Condition / Multi-tap)
        if (inFlightOrders.has(lockKey)) {
            return res.status(429).json({ error: "Ваш заказ уже обрабатывается, пожалуйста подождите..." });
        }

        // 2. Защита от повторной отправки дубликата (окно 15 секунд)
        const orderSignature = JSON.stringify({
            location_id,
            time,
            comment: comment || '',
            items: (items || []).map(i => ({ id: i.main?.id, count: i.count, addons: (i.addons || []).map(a => a.id).sort() }))
        });

        const recent = recentOrders.get(lockKey);
        if (recent && (Date.now() - recent.timestamp < 15000) && recent.signature === orderSignature) {
            console.log(`[Deduplication] Заблокирован дубликат заказа для tg_id=${tg_id}. Возвращаем существующий orderId #${recent.orderId}`);
            return res.json({ success: true, orderId: recent.orderId, duplicatePrevented: true });
        }

        inFlightOrders.add(lockKey);

        const releaseLock = () => inFlightOrders.delete(lockKey);

        db.get("SELECT * FROM locations WHERE id = ?", [location_id], (err, location) => {
            if (!location) {
                releaseLock();
                return res.status(400).json({ error: "Заведение не найдено" });
            }
            if (location.is_active === 0) {
                releaseLock();
                return res.status(400).json({ error: "В данный момент заведение не принимает предзаказы (Экстренная остановка)." });
            }

            if (!items || !Array.isArray(items) || items.length === 0) {
                releaseLock();
                return res.status(400).json({ error: "Пустая корзина или неверный формат данных" });
            }

            const orderTimeMs = new Date(time + '+03:00').getTime();
            const nowMs = Date.now();
            // Оставляем запас (5 минут вместо 9) на случай, если клиент долго находился в корзине
            if (orderTimeMs < nowMs + 5 * 60 * 1000 || orderTimeMs > nowMs + 48 * 60 * 60 * 1000) {
                releaseLock();
                return res.status(400).json({ error: "Недопустимое время. Укажите время с запасом минимум 10 минут." });
            }

            // Берем часы и минуты напрямую из строки (формат YYYY-MM-DDTHH:mm) для независимости от часового пояса сервера
            const [orderH, orderM] = time.split('T')[1].split(':').map(Number);
            const orderTimeFloat = orderH + (orderM / 60);
            const [openH, openM] = location.open_time.split(':').map(Number);
            const [closeH, closeM] = location.close_time.split(':').map(Number);
            if (orderTimeFloat < (openH + openM/60) || orderTimeFloat >= (closeH + closeM/60)) {
                releaseLock();
                return res.status(400).json({ error: `Это заведение принимает предзаказы только на время с ${location.open_time} до ${location.close_time}.` });
            }

            let allItemIds = [];
            items.forEach(item => { 
                if (item.main && item.main.id) allItemIds.push(item.main.id); 
                if (Array.isArray(item.addons)) item.addons.forEach(a => { if (a && a.id) allItemIds.push(a.id); }); 
            });
            if (allItemIds.length === 0) {
                releaseLock();
                return res.status(400).json({ error: "Пустая корзина" });
            }

            const placeholders = allItemIds.map(() => '?').join(',');
            db.all(`SELECT m.name, COALESCE(ma.is_available, 0) as is_available FROM menu m LEFT JOIN menu_availability ma ON m.id = ma.menu_id AND ma.location_id = ? WHERE m.id IN (${placeholders})`, [location_id, ...allItemIds], (err, rows) => {
                if (err) {
                    releaseLock();
                    return res.status(500).json({ error: "Ошибка проверки наличия позиций" });
                }
                const outOfStock = rows.filter(r => r.is_available === 0);
                if (outOfStock.length > 0) {
                    releaseLock();
                    return res.status(400).json({ error: `Эти позиции закончились: ${outOfStock.map(r => r.name).join(', ')}.` });
                }

                const createdAt = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
                const details = items.map(i => {
                    const addonsText = (i.addons && i.addons.length > 0) ? `\n   └ ${i.addons.map(a => a.name).join(', ')}` : '';
                    return `▪️ ${i.main.name} (x${i.count})${addonsText}`;
                }).join('\n');
                const total = items.reduce((sum, i) => sum + (i.totalItemPrice * i.count), 0);

                const cleanUsername = username ? String(username).replace(/^@/, '').trim() : '';
                const isValidUsername = /^[a-zA-Z0-9_]{4,32}$/.test(cleanUsername);
                const clientDisplayName = (full_name || username || 'Клиент').trim();
                const isNumericTgId = tg_id && !isNaN(Number(tg_id));

                let clientInfo = '';
                if (isNumericTgId) {
                    if (isValidUsername) {
                        clientInfo = `<a href="tg://user?id=${tg_id}">${escapeHtml(clientDisplayName)}</a> (<a href="https://t.me/${cleanUsername}">@${cleanUsername}</a>)`;
                    } else {
                        clientInfo = `<a href="tg://user?id=${tg_id}">${escapeHtml(clientDisplayName)}</a> (ID: <code>${tg_id}</code>)`;
                    }
                } else if (isValidUsername) {
                    clientInfo = `<a href="https://t.me/${cleanUsername}">@${cleanUsername}</a>`;
                } else {
                    clientInfo = escapeHtml(clientDisplayName);
                }

                const savedUsername = isValidUsername ? `@${cleanUsername}` : clientDisplayName;

                db.run("INSERT INTO orders (location_id, tg_id, username, details, comment, ready_time, status, created_at, total_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", 
                    [location_id, tg_id, savedUsername, details, comment, time, 'new', createdAt, total], function(err) {
                        releaseLock();

                        if (err) {
                            console.error('[DB] Ошибка создания заказа:', err);
                            return res.status(500).json({ error: "Не удалось сохранить заказ" });
                        }

                        const orderId = this.lastID;
                        
                        // Сохраняем в кэш дедупликации
                        recentOrders.set(lockKey, {
                            timestamp: Date.now(),
                            signature: orderSignature,
                            orderId: orderId
                        });

                        const commentText = comment ? `\n💬 Комментарий: ${escapeHtml(comment)}` : '';
                        const inlineKeyboard = [
                            [{ text: "👨‍🍳 Открыть панель кухни", url: `${WEBAPP_URL}/kitchen.html` }]
                        ];
                        if (isValidUsername) {
                            inlineKeyboard.push([{ text: `💬 Написать @${cleanUsername}`, url: `https://t.me/${cleanUsername}` }]);
                        }

                        const orderMsg = `📍 Точка: <b>${escapeHtml(location.name)}</b>\n🔥 <b>НОВЫЙ ЗАКАЗ #${orderId}</b>\n👤 Клиент: ${clientInfo}\n\nСостав:\n${escapeHtml(details)}${commentText}\n\nСумма: <b>${total} руб.</b>\n⏰ К времени: <b>${time.replace('T', ' ')}</b>`;

                        bot.sendMessage(KITCHEN_CHAT_ID, orderMsg, {
                            parse_mode: 'HTML',
                            reply_markup: { inline_keyboard: inlineKeyboard }
                        }).catch(err => console.error('[Telegram Bot] Ошибка отправки заказа в чат кухни. Проверьте KITCHEN_CHAT_ID и права бота:', err.message));
                        
                        if (tg_id !== 'test_user' && !String(tg_id).startsWith('web_')) {
                            bot.sendMessage(tg_id, `Ваш заказ принят. Его номер #${orderId}`).catch(err => console.error('[Telegram Bot] Ошибка отправки подтверждения клиенту:', err.message));
                        }
                        
                        res.json({ success: true, orderId: orderId });
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