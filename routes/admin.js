const express = require('express');

module.exports = (db, bot) => {
    const router = express.Router();

    // ================= API АДМИНКИ =================
    router.get('/admin/locations', (req, res) => db.all("SELECT * FROM locations", [], (err, rows) => res.json(rows)));
    router.post('/admin/locations', (req, res) => {
        const { name, open_time, close_time } = req.body;
        db.run("INSERT INTO locations (name, open_time, close_time) VALUES (?, ?, ?)", [name, open_time, close_time], err => res.json({ success: !err }));
    });
    router.put('/admin/locations/:id', (req, res) => {
        const { name, open_time, close_time, is_active } = req.body;
        db.run("UPDATE locations SET name = ?, open_time = ?, close_time = ?, is_active = ? WHERE id = ?", [name, open_time, close_time, is_active, req.params.id], err => res.json({ success: !err }));
    });

    router.get('/admin/menu/:location_id', (req, res) => {
        db.all("SELECT m.*, coalesce(ma.is_available, 0) as is_available FROM menu m LEFT JOIN menu_availability ma ON m.id = ma.menu_id AND ma.location_id = ? ORDER BY m.sort_order ASC, m.id ASC", [req.params.location_id], (err, menuItems) => {
            db.all("SELECT * FROM item_addons", [], (err, mappings) => {
                res.json({ menu: menuItems || [], addons: mappings || [] });
            });
        });
    });
    router.post('/admin/menu/:id/toggle', (req, res) => {
        db.run("INSERT OR REPLACE INTO menu_availability (menu_id, location_id, is_available) VALUES (?, ?, ?)", [req.params.id, req.body.location_id, req.body.is_available], err => res.json({ success: !err }));
    });
    router.post('/admin/menu', (req, res) => {
        const { category, name, price, type, location_id, description } = req.body;
        db.run("INSERT INTO menu (category, name, price, type, description) VALUES (?, ?, ?, ?, ?)", [category, name, price, type, description || ''], function(err) {
            if (err) return res.json({ success: false });
            db.run("INSERT INTO menu_availability (menu_id, location_id, is_available) VALUES (?, ?, 1)", [this.lastID, location_id], () => res.json({ success: true }));
        });
    });
    router.put('/admin/menu/:id', (req, res) => {
        const { name, price, category, type, description } = req.body;
        db.run("UPDATE menu SET name = ?, price = ?, category = ?, type = ?, description = ? WHERE id = ?", [name, price, category, type, description || '', req.params.id], err => res.json({ success: !err }));
    });
    router.delete('/admin/menu/:id', (req, res) => {
        const id = req.params.id;
        db.run("DELETE FROM item_addons WHERE main_id = ? OR addon_id = ?", [id, id], () => {
            db.run("DELETE FROM menu_availability WHERE menu_id = ?", [id], () => {
                db.run("DELETE FROM menu WHERE id = ?", [id], err => res.json({ success: !err }));
            });
        });
    });
    router.post('/admin/menu/:id/addons', (req, res) => {
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
    router.post('/admin/menu/reorder', (req, res) => {
        const { ordered_ids } = req.body;
        if (!ordered_ids || !Array.isArray(ordered_ids)) {
            return res.status(400).json({ success: false, error: 'ordered_ids is required and should be an array.' });
        }

        db.serialize(() => {
            const stmt = db.prepare("UPDATE menu SET sort_order = ? WHERE id = ?");
            ordered_ids.forEach((id, index) => {
                stmt.run(index, id);
            });
            stmt.finalize((err) => {
                if (err) res.json({ success: false, error: err.message });
                else res.json({ success: true });
            });
        });
    });

    // ================= API КУХНИ =================
    router.get('/orders', (req, res) => {
        db.all("SELECT o.*, l.name as loc_name FROM orders o JOIN locations l ON o.location_id = l.id ORDER BY CASE WHEN o.status = 'new' THEN 1 WHEN o.status = 'ready' THEN 2 ELSE 3 END, o.id ASC", [], (err, rows) => res.json(rows || []));
    });
    router.post('/orders/:id/status', (req, res) => {
        db.run("UPDATE orders SET status = ? WHERE id = ?", [req.body.status, req.params.id], function() {
            db.get("SELECT tg_id FROM orders WHERE id = ?", [req.params.id], (err, row) => {
                if (row && row.tg_id !== 'test_user') {
                    let message = '';
                    if (req.body.status === 'ready') message = `✅ Ваш заказ готов и ждет вас! Приятного аппетита!`;
                    else if (req.body.status === 'cancelled') message = `❌ К сожалению, мы вынуждены отменить ваш заказ. Приносим извинения.`;
                    
                    if (message) {
                        bot.sendMessage(row.tg_id, message)
                           .catch(e => console.error(`[Telegram Bot] Ошибка отправки статуса заказа #${req.params.id} клиенту ${row.tg_id}:`, e.message));
                    }
                }
            });
            res.json({ success: true });
        });
    });
    router.put('/orders/:id/time', (req, res) => {
        const newTimeStr = req.body.time;
        if (!newTimeStr) return res.status(400).json({ success: false, error: 'Время не указано' });
        db.get("SELECT ready_time, tg_id FROM orders WHERE id = ?", [req.params.id], (err, order) => {
            if (err || !order) return res.json({ success: false, error: 'Заказ не найден' });
            const parts = order.ready_time.split('T');
            if (parts.length === 2) {
                const newReadyTime = parts[0] + 'T' + newTimeStr;
                db.run("UPDATE orders SET ready_time = ? WHERE id = ?", [newReadyTime, req.params.id], function() {
                    if (order.tg_id !== 'test_user') {
                        bot.sendMessage(order.tg_id, `⏳ Время готовности вашего заказа было изменено. Новое время: ${newTimeStr}`).catch(e => console.error(`[Telegram Bot] Ошибка отправки нового времени заказа #${req.params.id} клиенту ${order.tg_id}:`, e.message));
                    }
                    res.json({ success: true, new_time: newReadyTime });
                });
            } else res.json({ success: false });
        });
    });

    return router;
};