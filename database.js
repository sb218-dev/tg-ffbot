const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    // Включаем режим WAL для высокой производительности (много потоков чтения + 1 запись)
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");

    db.run("CREATE TABLE IF NOT EXISTS locations (id INTEGER PRIMARY KEY, name TEXT, open_time TEXT DEFAULT '11:00', close_time TEXT DEFAULT '23:00', is_active INTEGER DEFAULT 1)");
    // Единое меню без дубликатов
    db.run("CREATE TABLE IF NOT EXISTS menu (id INTEGER PRIMARY KEY, category TEXT, name TEXT, price INTEGER, type TEXT DEFAULT 'main', sort_order INTEGER DEFAULT 0)");
    db.run("CREATE TABLE IF NOT EXISTS menu_availability (menu_id INTEGER, location_id INTEGER, is_available INTEGER DEFAULT 1, PRIMARY KEY(menu_id, location_id))");
    db.run("CREATE TABLE IF NOT EXISTS item_addons (main_id INTEGER, addon_id INTEGER, FOREIGN KEY(main_id) REFERENCES menu(id), FOREIGN KEY(addon_id) REFERENCES menu(id))");
    db.run("CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, location_id INTEGER, tg_id TEXT, username TEXT, details TEXT, comment TEXT, ready_time TEXT, status TEXT, created_at TEXT, late_notified INTEGER DEFAULT 0, total_price INTEGER DEFAULT 0, source TEXT DEFAULT 'telegram', FOREIGN KEY(location_id) REFERENCES locations(id))");
    db.run("CREATE TABLE IF NOT EXISTS users (tg_id TEXT PRIMARY KEY, username TEXT, phone TEXT, last_location_id INTEGER, points INTEGER DEFAULT 0)");
    db.run("ALTER TABLE orders ADD COLUMN total_price INTEGER DEFAULT 0", (err) => { /* Игнорируем ошибку, если колонка уже существует */ });
    db.run("ALTER TABLE orders ADD COLUMN source TEXT DEFAULT 'telegram'", (err) => { /* Игнорируем ошибку */ });
    db.run("ALTER TABLE menu ADD COLUMN description TEXT DEFAULT ''", (err) => { /* Игнорируем ошибку */ });
    db.run("ALTER TABLE menu ADD COLUMN sort_order INTEGER DEFAULT 0", (err) => { /* Игнорируем ошибку */ });

    // Создаем индексы для быстрого поиска
    db.run("CREATE INDEX IF NOT EXISTS idx_orders_tgid ON orders(tg_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)");
    db.run("CREATE INDEX IF NOT EXISTS idx_menu_avail_location ON menu_availability(location_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_menu_sort_order ON menu(sort_order)");
    
    db.get("SELECT count(*) as count FROM locations", (err, row) => {
        if (row.count === 0) {
            db.serialize(() => {
                db.run("INSERT INTO locations (name, open_time, close_time) VALUES ('Московское шоссе 13жд', '11:00', '23:00')");
                db.run("INSERT INTO locations (name, open_time, close_time) VALUES ('проспект Пятилеток 8', '11:00', '23:00')");

                const stmt = db.prepare(`INSERT INTO menu (category, name, price, type) VALUES (?, ?, ?, ?)`);
                
                const chebureks = [ ["Говядина и свинина", 210], ["Мраморная говядина", 230], ["Баранина", 240], ["Ветчина сыр", 225], ["Сыр зелень", 230], ["Сыр", 220], ["Четыре сыра", 300], ["Картошка сыр бекон", 245], ["Картошка грибы", 195], ["Чебурек - пицца", 270], ["Пепперони", 235], ["Вишня", 225], ["Банан шоколад", 230] ];
                chebureks.forEach(i => stmt.run("Чебуреки", i[0], i[1], "main"));
                
                const snacks = [ ["Картофель фри", 170], ["Картофель айдахо", 190], ["Наггетсы", 180], ["Хворост", 100], ["Сырные палочки", 180], ["Пельмени жаренные", 350] ];
                snacks.forEach(i => stmt.run("Закуски", i[0], i[1], "main"));
                
                const drinks = [ ["Чай", 60], ["Американо 0.2", 120], ["Капучино 0.2", 140], ["Латте 0.2", 140], ["Сок", 130], ["Лимонад", 180] ];
                drinks.forEach(i => stmt.run("Напитки", i[0], i[1], "main"));
                
                stmt.run("Сезонные блюда", "Чебурек с брынзой", 250, "main");
                stmt.run("Сезонные блюда", "Комбо (Чебурек+Фри+Напиток)", 450, "main");

                const ingredients = [ ["Сыр", 60], ["Доп мясо", 85], ["Бекон", 65], ["Халапеньо", 40], ["Огурцы соленые", 40], ["Ветчина", 60], ["Пепперони", 60], ["Томаты", 50], ["Грибы", 50], ["Зелень", 35], ["Картошка фри", 65] ];
                ingredients.forEach(i => stmt.run("Соусы и добавки", i[0], i[1], "both"));
                
                const sauces = [ ["Сырный соус", 60], ["Сметанный соус", 60], ["Кетчунез", 60], ["Острый соус", 60] ];
                sauces.forEach(i => stmt.run("Соусы и добавки", i[0], i[1], "both"));

                const comboChoices = [ ["Чебурек: Мясной", 0], ["Чебурек: Сырный", 0], ["Напиток: Сок", 0], ["Напиток: Чай", 0] ];
                comboChoices.forEach(i => stmt.run("Комбо_выбор", i[0], i[1], "addon"));
                
                stmt.finalize(() => {
                    db.run("UPDATE menu SET sort_order = id");
                    db.run("INSERT INTO menu_availability (menu_id, location_id, is_available) SELECT id, 1, 1 FROM menu");
                    db.run("INSERT INTO menu_availability (menu_id, location_id, is_available) SELECT id, 2, 1 FROM menu");

                    db.run(`INSERT INTO item_addons (main_id, addon_id) SELECT m1.id, m2.id FROM menu m1, menu m2 WHERE m1.category = 'Чебуреки' AND m2.category = 'Соусы и добавки'`);
                    db.run(`INSERT INTO item_addons (main_id, addon_id) SELECT m1.id, m2.id FROM menu m1, menu m2 WHERE m1.category = 'Закуски' AND m2.category = 'Соусы и добавки' AND (m2.name LIKE '%соус%' OR m2.name = 'Кетчунез')`);
                    db.run(`INSERT INTO item_addons (main_id, addon_id) SELECT m1.id, m2.id FROM menu m1, menu m2 WHERE m1.name LIKE 'Комбо%' AND m2.category = 'Комбо_выбор'`);
                });
            });
        }
    });
});

module.exports = db;