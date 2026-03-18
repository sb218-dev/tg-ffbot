const tg = window.Telegram.WebApp;
tg.expand();

// Красим рамки самого окна Telegram под наш новый фон
tg.setBackgroundColor('#ffffff');
tg.setHeaderColor('#ffffff');

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
    
    document.getElementById('menu-loc-title').innerHTML = `Меню <span style="color: var(--accent);">(${loc.name})</span>`;
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
            div.onclick = () => openAddonModal(item.id);
            div.innerHTML = `
                <img src="/images/${item.id}.webp" onerror="this.src='https://placehold.co/300x300/E9EEF5/3F5CA9?text=Нет+фото'" class="item-image" alt="${item.name}">
                <div class="item-info">
                    <h4>${item.name}</h4>
                </div>
                <button class="price-btn" onclick="event.stopPropagation(); directAddBaseItem(${item.id})">${item.price} ₽</button>
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

function openSearch() {
    document.getElementById('btn-open-search').style.display = 'none'; document.getElementById('categories-container').style.display = 'none';
    document.getElementById('search-wrapper').classList.add('active'); document.getElementById('search-input').focus();
}
function closeSearch() {
    document.getElementById('search-input').value = ''; filterItems('');
    document.getElementById('search-wrapper').classList.remove('active');
    document.getElementById('btn-open-search').style.display = 'flex'; document.getElementById('categories-container').style.display = 'flex';
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

    // Настраиваем описание блюда
    const infoBtn = document.getElementById('modal-info-btn');
    const descBlock = document.getElementById('modal-item-desc');
    descBlock.classList.add('hidden'); // Скрываем по умолчанию при открытии
    if (item.description && item.description.trim() !== '') {
        infoBtn.classList.remove('hidden');
        descBlock.innerText = item.description;
    } else {
        infoBtn.classList.add('hidden');
    }

    document.getElementById('modal-item-name').innerText = item.name;
    document.getElementById('modal-hint').innerText = item.name.includes('Комбо') ? "Выберите 1 чебурек и 1 напиток:" : "Выберите добавки/соусы:";

    const addonsContainer = document.getElementById('modal-addons-list');
    let addonsHtml = '';
    
    availableAddons.forEach(addon => {
        const priceText = addon.price > 0 ? `+${addon.price} ₽` : 'В комбо';
        addonsHtml += `
            <div class="addon-box" onclick="toggleAddon(this)">
                <input type="checkbox" value="${addon.id}" data-name="${addon.name}" data-price="${addon.price}">
                <span class="addon-name">${addon.name}</span>
                <span class="addon-price">${priceText}</span>
            </div>
        `;
    });
    addonsContainer.innerHTML = addonsHtml;
    
    updateAddonModalPrice();
    document.getElementById('step-menu').classList.add('hidden');
    document.getElementById('addon-modal').classList.remove('hidden');
}

function toggleDescription() {
    document.getElementById('modal-item-desc').classList.toggle('hidden');
    tg.HapticFeedback.selectionChanged();
}

function directAddBaseItem(itemId) {
    const item = menuData.find(i => i.id === itemId);
    if(item) confirmDirectAddToCart(item);
}

function toggleAddon(boxElement) {
    const cb = boxElement.querySelector('input[type="checkbox"]');
    cb.checked = !cb.checked;
    if (cb.checked) boxElement.classList.add('selected'); else boxElement.classList.remove('selected');
    updateAddonModalPrice(); tg.HapticFeedback.selectionChanged();
}
function updateAddonModalPrice() {
    if (!currentItemSelection) return; let sum = currentItemSelection.price;
    document.querySelectorAll('#modal-addons-list input[type="checkbox"]:checked').forEach(cb => { sum += parseInt(cb.dataset.price); });
    document.getElementById('btn-confirm-addons').innerText = `Добавить в корзину +${sum} ₽`;
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
    let total = 0;
    let cartHtml = '';
    
    Object.entries(cart).forEach(([key, item]) => {
        if (item.count > 0) {
            total += item.totalItemPrice * item.count;
            const addonsText = item.addons.length > 0 ? `<br><small style="color: var(--hint);">└ ${item.addons.map(a=>a.name).join(', ')}</small>` : '';
            cartHtml += `<div class="cart-item"><div><b>${item.main.name} (x${item.count})</b><br><span style="color: var(--accent); font-weight: 700;">${item.totalItemPrice * item.count} ₽</span> ${addonsText}</div><button class="cart-item-btn" onclick="removeFromCart('${key}')">✕</button></div>`;
        }
    });
    cartDiv.innerHTML = cartHtml;
    
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
        if (total > 0) tg.MainButton.setParams({ text: `В КОРЗИНУ (${total} ₽)`, color: '#F48C5B', text_color: '#ffffff', is_active: true, is_visible: true });
        else tg.MainButton.hide();
    } else if (currentStep === 'cart') {
        if (total > 0) tg.MainButton.setParams({ text: `ОФОРМИТЬ ЗАКАЗ`, color: '#F48C5B', text_color: '#ffffff', is_active: true, is_visible: true });
        else tg.MainButton.hide();
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
    const card = document.getElementById('my-order-details-card'); card.innerHTML = 'Загрузка...';
    document.getElementById('btn-cancel-order').style.display = 'none';
    
    fetch(`/api/my_orders?tg_id=${tgUserId}`).then(res => res.json()).then(orders => {
        card.innerHTML = '';
        if(orders.length === 0) { card.innerHTML = '<p style="text-align:center; color: var(--hint);">Нет активных заказов.</p>'; return; }
        
        const order = orders[0]; // Берем самый свежий заказ пользователя
        const detailsHtml = `
            <h3 style="margin-top:0; color: var(--button);">Заказ #${order.id}</h3>
            <p style="color: var(--hint); font-size: 14px; margin-top: -10px; margin-bottom: 16px;">📍 ${order.loc_name}</p>
            <div style="white-space: pre-wrap; margin-bottom: 16px; font-size: 14px; line-height: 1.5; background: var(--secondary-bg); padding: 12px; border-radius: var(--radius);">${order.details}</div>
            ${order.comment ? `<div style="background: #fff3cd; color: #856404; padding: 10px; border-radius: var(--radius); margin-bottom: 16px; font-size: 13px;">💬 <b>Комментарий:</b> ${order.comment}</div>` : ''}
            <div style="font-weight: 700; font-size: 18px; border-top: 1px solid #eee; padding-top: 12px; display: flex; justify-content: space-between;">
                <span>Итого:</span>
                <span style="color: var(--accent);">${order.total_price || 0} ₽</span>
            </div>
            <div style="margin-top: 12px; color: var(--button); font-weight: 600; font-size: 15px; background: rgba(63, 92, 169, 0.1); padding: 10px; border-radius: var(--radius); text-align: center;">
                🕒 Будет готов к: ${order.ready_time.replace('T', ' ')}
            </div>
        `;
        card.innerHTML = detailsHtml;
        
        const cancelBtn = document.getElementById('btn-cancel-order');
        cancelBtn.style.display = 'block';
        cancelBtn.onclick = () => cancelMyOrder(order.id);
    });
}

function cancelMyOrder(orderId) {
    tg.showConfirm("Отменить этот заказ?", (confirm) => { if(confirm) { fetch(`/api/orders/${orderId}/cancel_by_user`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tg_id: tgUserId }) }).then(() => { tg.showAlert("Заказ отменен"); showLocations(); }); } });
}

tg.MainButton.onClick(() => {
    if (currentStep === 'menu') { showCart(); return; }
    if (currentStep === 'cart') { submitOrder(); return; }
});

function submitOrder() {
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
}