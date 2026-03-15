const tg = window.Telegram.WebApp;
tg.expand();

// Красим рамки самого окна Telegram под наш новый фон
tg.setBackgroundColor('#E9EEF5');
tg.setHeaderColor('#E9EEF5');

let locationsData = [];
let currentLocation = null;
let menuData = [];
let cart = {};
let userData = null;
let currentItemSelection = null;
let currentStep = 'locations';
const tgUserId = tg.initDataUnsafe?.user?.id || 'test_user';
const tgUsername = tg.initDataUnsafe?.user?.username || tg.initDataUnsafe?.user?.first_name || '';

// Координаты заведений
const locationCoords = {
    'Московское шоссе 13жд': [59.827724, 30.346403],
    'проспект Пятилеток 8': [59.922075, 30.459518]
};

let myMap;
let markersAdded = false;
let isMapLoading = false;

// Ленивая загрузка Яндекс Карт
function loadYandexMaps() {
    if (myMap || isMapLoading) return;
    isMapLoading = true;
    const script = document.createElement('script');
    script.src = "https://api-maps.yandex.ru/2.1/?apikey=6548b42c-41fd-4f56-bd38-8800649b8c12&lang=ru_RU";
    script.type = "text/javascript";
    script.onload = () => {
        ymaps.ready(() => {
            myMap = new ymaps.Map("map", {
                center: [59.874, 30.402], // Приблизительный центр между точками
                zoom: 11,
                controls: ['zoomControl']
            });
            addMarkers();
        });
    };
    document.head.appendChild(script);
}

function addMarkers() {
    if (!myMap || markersAdded || locationsData.length === 0) return;
    locationsData.forEach(loc => {
        const coords = locationCoords[loc.name];
        if (coords) {
            const placemark = new ymaps.Placemark(coords, {
                balloonContent: `<b>${loc.name}</b><br>🕒 Открыто с ${loc.open_time} до ${loc.close_time}`,
                hintContent: loc.name
            }, {
                preset: loc.is_active ? 'islands#blueFoodIcon' : 'islands#grayFoodIcon'
            });
            if (loc.is_active) placemark.events.add('click', () => selectLocation(loc));
            myMap.geoObjects.add(placemark);
        }
    });
    if (myMap.geoObjects.getBounds()) myMap.setBounds(myMap.geoObjects.getBounds(), { checkZoomRange: true, zoomMargin: 15 });
    markersAdded = true;
}

Promise.all([
    fetch('/api/locations?v=' + new Date().getTime()).then(res => res.json()),
    fetch('/api/users', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ tg_id: tgUserId, username: tgUsername }) }).then(res => res.json())
]).then(([locations, user]) => {
    locationsData = locations;
    userData = user;
    renderLocations();
    checkMyOrders();
    
    // Инициируем подгрузку скриптов Яндекс Карт параллельно с рендером UI
    loadYandexMaps();
    
    // Автоматический выбор последней точки
    if (userData && userData.last_location_id) {
        const savedLoc = locationsData.find(l => l.id === userData.last_location_id && l.is_active);
        if (savedLoc) selectLocation(savedLoc, false);
    }
});

function renderLocations() {
    const container = document.getElementById('locations-container');
    container.innerHTML = '';
    locationsData.forEach(loc => {
        const div = document.createElement('div');
        if (loc.is_active) {
            div.className = 'location-card';
            div.innerHTML = `<b>${loc.name}</b><span>🕒 Открыто с ${loc.open_time} до ${loc.close_time}</span>`;
            div.onclick = () => selectLocation(loc);
        } else {
            div.className = 'location-card disabled';
            div.innerHTML = `<b>${loc.name}</b><span class="status-tag">Временно не принимает заказы</span>`;
        }
        container.appendChild(div);
    });
}

function selectLocation(loc, savePreference = true) {
    currentLocation = loc; cart = {}; updateCartUI();
    if (savePreference && tgUserId !== 'test_user') {
        fetch(`/api/users/${tgUserId}/location`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ location_id: loc.id }) });
    }
    
    document.getElementById('menu-loc-title').innerText = `Меню (${loc.name})`;
    document.getElementById('time-hint').innerText = `Часы работы: ${loc.open_time} - ${loc.close_time}`;
    
    const timePicker = document.getElementById('time-picker');
    const nowSPb = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
    const minTime = new Date(nowSPb.getTime() + 20 * 60000); 
    const maxTime = new Date(nowSPb.getTime() + 48 * 3600000); 
    const formatForInput = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    timePicker.min = formatForInput(minTime); timePicker.max = formatForInput(maxTime); timePicker.value = formatForInput(minTime);

    fetch(`/api/menu?location_id=${loc.id}&v=` + new Date().getTime()).then(res => res.json()).then(data => {
        menuData = data;
        renderMenu(); showMenu();
    });
}

function showLocations() {
    currentStep = 'locations';
    document.querySelectorAll('.section').forEach(el => el.classList.add('hidden'));
    document.getElementById('step-locations').classList.remove('hidden');
    loadYandexMaps();
    // Фикс для Яндекс Карт: при возврате с другой страницы карта может сломаться из-за display: none
    if (myMap) setTimeout(() => myMap.container.fitToViewport(), 100);
    tg.MainButton.hide(); checkMyOrders();
}

function renderMenu() {
    const mainItems = menuData.filter(i => i.type === 'main' || i.type === 'both');
    const categories = [...new Set(mainItems.map(item => item.category))];
    const container = document.getElementById('categories-container');
    const itemsContainer = document.getElementById('all-items-container');
    container.innerHTML = '';
    itemsContainer.innerHTML = '';

    categories.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = 'category-pill'; btn.innerText = cat; btn.onclick = () => showItems(cat);
        btn.onclick = () => document.getElementById(`cat-${cat}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
        container.appendChild(btn);

        const section = document.createElement('div');
        section.className = 'category-section';
        section.id = `cat-${cat}`;
        section.innerHTML = `<h3>${cat}</h3>`;
        
        const grid = document.createElement('div');
        grid.className = 'items-grid';
        
        mainItems.filter(item => item.category === cat).forEach(item => {
            const div = document.createElement('div');
            div.className = 'item-card';
            div.dataset.name = item.name.toLowerCase();
            div.innerHTML = `
                <img src="/images/${encodeURIComponent(item.name)}.webp" onerror="this.src='https://placehold.co/300x300/E9EEF5/3F5CA9?text=Нет+фото'" class="item-image" alt="${item.name}">
                <div class="item-info">
                    <h4>${item.name}</h4>
                    <span>${item.price} ₽</span>
                </div>
                <button class="add-btn" onclick="openAddonModal(${item.id})">+ Добавить</button>
            `;
            grid.appendChild(div);
        });
        section.appendChild(grid);
        itemsContainer.appendChild(section);
    });
}

function showMenu() { 
    currentStep = 'menu';
    document.querySelectorAll('.section').forEach(el => el.classList.add('hidden')); 
    document.getElementById('step-menu').classList.remove('hidden'); 
    updateMainButton();
}

function showCart() {
    currentStep = 'cart';
    document.querySelectorAll('.section').forEach(el => el.classList.add('hidden'));
    document.getElementById('step-cart').classList.remove('hidden');
    updateMainButton();
}

function showTime() {
    currentStep = 'time';
    document.querySelectorAll('.section').forEach(el => el.classList.add('hidden'));
    document.getElementById('step-time').classList.remove('hidden');
    updateMainButton();
}

function toggleSearch() {
    const s = document.getElementById('search-container');
    s.classList.toggle('hidden');
    if(!s.classList.contains('hidden')) document.getElementById('search-input').focus();
}

// Реализация Debounce (Задержки) для поиска
let searchTimeout;
function onSearchInput(query) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => filterItems(query), 200);
}

function filterItems(query) {
    query = query.toLowerCase();
    document.querySelectorAll('.item-card').forEach(card => {
        card.style.display = card.dataset.name.includes(query) ? 'flex' : 'none';
    });
    document.querySelectorAll('.category-section').forEach(sec => {
        const visible = sec.querySelectorAll('.item-card[style="display: flex;"], .item-card:not([style*="display: none"])');
        sec.style.display = visible.length ? 'block' : 'none';
    });
}

function openAddonModal(itemId) {
    const item = menuData.find(i => i.id === itemId);
    currentItemSelection = item;
    
    const allowedIds = item.allowed_addons_ids || [];
    const availableAddons = menuData.filter(i => allowedIds.includes(i.id));

    if (availableAddons.length === 0) { confirmDirectAddToCart(item); return; }

    document.getElementById('modal-item-name').innerText = item.name;
    document.getElementById('modal-hint').innerText = item.name.includes('Комбо') ? "Выберите 1 чебурек и 1 напиток:" : "Выберите добавки/соусы:";

    const addonsContainer = document.getElementById('modal-addons-list');
    addonsContainer.innerHTML = '';
    
    availableAddons.forEach(addon => {
        const priceText = addon.price > 0 ? `+${addon.price}₽` : '<span style="color:var(--button);">В комбо</span>';
        addonsContainer.innerHTML += `<div class="addon-item"><input type="checkbox" id="addon-${addon.id}" value="${addon.id}" data-name="${addon.name}" data-price="${addon.price}"><label for="addon-${addon.id}">${addon.name}</label><span style="font-size: 14px; font-weight: bold; color: var(--accent);">${priceText}</span></div>`;
    });
    
    document.getElementById('step-menu').classList.add('hidden');
    document.getElementById('addon-modal').classList.remove('hidden');
}

function confirmDirectAddToCart(item) {
    const cartKey = `${item.id}_`; 
    if (!cart[cartKey]) cart[cartKey] = { main: item, addons: [], totalItemPrice: item.price, count: 0 };
    cart[cartKey].count++; updateCartUI(); tg.HapticFeedback.impactOccurred('light'); tg.showAlert(`Добавлено: ${item.name}`);
}

function closeAddonModal() { document.getElementById('addon-modal').classList.add('hidden'); document.getElementById('step-menu').classList.remove('hidden'); }

function confirmAddToCart() {
    const checkboxes = document.querySelectorAll('#modal-addons-list input[type="checkbox"]:checked');
    const selectedAddons = Array.from(checkboxes).map(cb => ({ id: cb.value, name: cb.dataset.name, price: parseInt(cb.dataset.price) }));

    if (currentItemSelection.name.includes('Комбо')) {
        const chebCount = selectedAddons.filter(a => a.name.includes('Чебурек:')).length;
        const drinkCount = selectedAddons.filter(a => a.name.includes('Напиток:')).length;
        if (chebCount !== 1 || drinkCount !== 1) { tg.showAlert('Для комбо необходимо выбрать ровно 1 чебурек и 1 напиток!'); return; }
    }

    const addonIds = selectedAddons.map(a => a.id).sort().join('-');
    const cartKey = `${currentItemSelection.id}_${addonIds}`;

    if (!cart[cartKey]) cart[cartKey] = { main: currentItemSelection, addons: selectedAddons, totalItemPrice: currentItemSelection.price + selectedAddons.reduce((sum, a) => sum + a.price, 0), count: 0 };
    cart[cartKey].count++; closeAddonModal(); showMenu(); updateCartUI(); tg.HapticFeedback.impactOccurred('light');
}

function removeFromCart(cartKey) {
    if (cart[cartKey]) {
        cart[cartKey].count--;
        if (cart[cartKey].count <= 0) delete cart[cartKey];
        updateCartUI(); tg.HapticFeedback.impactOccurred('light');
    }
}

function updateCartUI() {
    const cartDiv = document.getElementById('cart-items');
    let total = 0; cartDiv.innerHTML = '';
    
    Object.entries(cart).forEach(([key, item]) => {
        if (item.count > 0) {
            total += item.totalItemPrice * item.count;
            const addonsText = item.addons.length > 0 ? `<br><small style="color: var(--hint);">└ ${item.addons.map(a=>a.name).join(', ')}</small>` : '';
            cartDiv.innerHTML += `<div class="cart-item"><div><b>${item.main.name} (x${item.count})</b><br><span style="color: var(--accent); font-weight: 700;">${item.totalItemPrice * item.count} ₽</span> ${addonsText}</div><button class="add-btn" style="color:var(--hint); background:none; font-size:18px; width:auto; padding:4px 10px;" onclick="removeFromCart('${key}')">✕</button></div>`;
        }
    });
    
    if (document.getElementById('cart-total-page')) {
        document.getElementById('cart-total-page').innerText = total;
    }
    
    updateMainButton(total);
}

function updateMainButton(total) {
    if (total === undefined) {
        total = 0;
        Object.values(cart).forEach(i => { if(i.count > 0) total += i.totalItemPrice * i.count; });
    }

    if (currentStep === 'menu') {
        if (total > 0) tg.MainButton.setParams({ text: `В КОРЗИНУ (${total} ₽)`, color: '#3F5CA9', text_color: '#ffffff', is_active: true, is_visible: true });
        else tg.MainButton.hide();
    } else if (currentStep === 'cart') {
        if (total > 0) tg.MainButton.setParams({ text: `К ОФОРМЛЕНИЮ`, color: '#3F5CA9', text_color: '#ffffff', is_active: true, is_visible: true });
        else tg.MainButton.setParams({ text: 'КОРЗИНА ПУСТА', color: '#d1d1d6', text_color: '#6c757d', is_active: false, is_visible: true });
    } else if (currentStep === 'time') {
        tg.MainButton.setParams({ text: `ОФОРМИТЬ ЗАКАЗ`, color: '#3F5CA9', text_color: '#ffffff', is_active: true, is_visible: true });
    } else {
        tg.MainButton.hide();
    }
}

function checkMyOrders() { fetch(`/api/my_orders?tg_id=${tgUserId}`).then(res => res.json()).then(orders => { const btn = document.getElementById('my-orders-btn-global'); if (orders.length > 0) btn.classList.remove('hidden'); else btn.classList.add('hidden'); }); }

function showMyOrders() {
    currentStep = 'my_orders';
    document.querySelectorAll('.section').forEach(el => el.classList.add('hidden'));
    document.getElementById('step-my-orders').classList.remove('hidden');
    updateMainButton();
    const container = document.getElementById('my-orders-list'); container.innerHTML = 'Загрузка...';
    fetch(`/api/my_orders?tg_id=${tgUserId}`).then(res => res.json()).then(orders => {
        container.innerHTML = '';
        if(orders.length === 0) { container.innerHTML = 'Нет активных заказов.'; return; }
        orders.forEach(o => { container.innerHTML += `<div class="item-card" style="display:block;"><h3>Заказ #${o.id} (${o.loc_name})</h3><p>К времени: ${o.ready_time.replace('T', ' ')}</p><button class="item-btn" style="background:#dc3545; width:100%;" onclick="cancelMyOrder(${o.id})">❌ Отменить заказ</button></div>`; });
    });
}

function cancelMyOrder(orderId) {
    tg.showConfirm("Отменить этот заказ?", (confirm) => { if(confirm) { fetch(`/api/orders/${orderId}/cancel_by_user`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tg_id: tgUserId }) }).then(() => { tg.showAlert("Заказ отменен"); showLocations(); }); } });
}

tg.MainButton.onClick(() => {
    if(!currentLocation) return;
    const selectedTime = document.getElementById('time-picker').value;
    const comment = document.getElementById('order-comment').value;

    if (!selectedTime) { tg.showAlert("Укажите время готовности!"); return; }

    const items = Object.values(cart).filter(i => i.count > 0);
    
    fetch('/api/order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: currentLocation.id, tg_id: tgUserId, username: tgUsername, items: items, time: selectedTime, comment: comment })
    }).then(res => res.json()).then(res => {
        if(res.success) { tg.showAlert("Заказ успешно отправлен!"); tg.close(); } 
        else { tg.showAlert(res.error || "Ошибка при оформлении"); }
    });
});