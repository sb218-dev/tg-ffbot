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
        db.all("SELECT * FROM menu WHERE location_id = ?", [req.params.location_id], (err, menuItems) => {
            db.all("SELECT ia.* FROM item_addons ia JOIN menu m ON ia.main_id = m.id WHERE m.location_id = ?", [req.params.location_id], (err, mappings) => {
                res.json({ menu: menuItems, addons: mappings });
            });
        });
    });
    router.post('/admin/menu/:id/toggle', (req, res) => db.run("UPDATE menu SET is_available = ? WHERE id = ?", [req.body.is_available, req.params.id], err => res.json({ success: !err })));
    router.post('/admin/menu', (req, res) => {
        const { location_id, category, name, price, type } = req.body;
        db.run("INSERT INTO menu (location_id, category, name, price, type) VALUES (?, ?, ?, ?, ?)", [location_id, category, name, price, type], err => res.json({ success: !err }));
    });
    router.put('/admin/menu/:id', (req, res) => {
        const { name, price, category, type } = req.body;
        db.run("UPDATE menu SET name = ?, price = ?, category = ?, type = ? WHERE id = ?", [name, price, category, type, req.params.id], err => res.json({ success: !err }));
    });
    router.delete('/admin/menu/:id', (req, res) => {
        const id = req.params.id;
        db.run("DELETE FROM item_addons WHERE main_id = ? OR addon_id = ?", [id, id], () => {
            db.run("DELETE FROM menu WHERE id = ?", [id], err => res.json({ success: !err }));
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

    // ================= API КУХНИ =================
    router.get('/orders', (req, res) => db.all("SELECT o.*, l.name as loc_name FROM orders o JOIN locations l ON o.location_id = l.id ORDER BY o.id DESC", [], (err, rows) => res.json(rows)));
    router.post('/orders/:id/status', (req, res) => {
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
    router.put('/orders/:id/time', (req, res) => {
        const newTimeStr = req.body.time;
        db.get("SELECT ready_time, tg_id FROM orders WHERE id = ?", [req.params.id], (err, order) => {
            if (err || !order) return res.json({ success: false, error: 'Заказ не найден' });
            const parts = order.ready_time.split('T');
            if (parts.length === 2) {
                const newReadyTime = parts[0] + 'T' + newTimeStr;
                db.run("UPDATE orders SET ready_time = ? WHERE id = ?", [newReadyTime, req.params.id], function() {
                    if (order.tg_id !== 'test_user') bot.sendMessage(order.tg_id, `⏳ Время готовности вашего заказа было изменено. Новое время: ${newTimeStr}`);
                    res.json({ success: true, new_time: newReadyTime });
                });
            } else res.json({ success: false });
        });
    });

    return router;
};