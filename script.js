let dbData = {}; // Сюда мы динамически соберем структуру категорий и жанров из базы данных
let isTransitioning = false; // Флаг: идет ли сейчас перерисовка экрана

// Включаем временную блокировку кликов на 350мс
function startTransitionLock() {
    isTransitioning = true;
    setTimeout(() => {
        isTransitioning = false;
    }, 350); 
}

// Перехватываем ВСЕ клики на сайте на стадии погружения
document.addEventListener('click', (e) => {
    if (isTransitioning) {
        e.preventDefault();
        e.stopPropagation();
    }
}, true); // true обязателен — это заставит событие обрабатываться в первую очередь

// Функция для загрузки тайтлов из Supabase и сборки структуры
async function loadCatalogFromDB() {
    const { data: titles, error } = await db
        .from('titles')
        .select('*')
        .order('id', { ascending: true });

    if (error) {
        console.error("Ошибка при загрузке каталога из БД:", error);
        return;
    }

    // Собираем плоский список из базы обратно в древовидную структуру для сайта
    const tempStructure = {};

    titles.forEach(item => {
        const cat = item.category;
        const gen = item.genre;
        const fran = item.franchise;
        const titleWithYear = `${item.title} (${item.year})`;

        if (!tempStructure[cat]) tempStructure[cat] = {};
        if (!tempStructure[cat][gen]) tempStructure[cat][gen] = [];

        if (fran) {
            // Ищем, есть ли уже такая франшиза внутри жанра
            let franchiseObj = tempStructure[cat][gen].find(
                i => typeof i === 'object' && i !== null && i[fran]
            );

            if (!franchiseObj) {
                franchiseObj = { [fran]: [] };
                tempStructure[cat][gen].push(franchiseObj);
            }
            franchiseObj[fran].push(titleWithYear);
        } else {
            // Обычный фильм без франшизы
            tempStructure[cat][gen].push(titleWithYear);
        }
    });

    dbData = tempStructure;
}

// ==========================================
// НАСТРОЙКА SUPABASE
// ==========================================
const SUPABASE_URL = "https://nwkgofmgluduldgsmwfa.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Igpb__d5aHp3DBbQH1NgOA_W8_Ku6aE";

// Инициализируем клиент под именем db
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = document.getElementById("app");
let currentUser = null;
let watchedTitles = new Set(); // Общий список просмотренного у обоих пользователей
let history = [];
let realtimeChannel = null; // Канал для мгновенных обновлений

// Переменная, хранящая название текущей открытой категории первого уровня ("🎥 Фильмы" и т.д.)
let currentCategoryName = null; 

// Слушатель событий авторизации
db.auth.onAuthStateChange((event, session) => {
    if (session) {
        currentUser = session.user;
        loadWatchedFromDB().then(() => {
            subscribeToChanges(); 
            showHome();
        });
    } else {
        currentUser = null;
        watchedTitles.clear();
        if (realtimeChannel) {
            db.removeChannel(realtimeChannel);
            realtimeChannel = null;
        }
        showLoginScreen();
    }
});

// Загрузка просмотренных тайтлов из общей базы данных
async function loadWatchedFromDB() {
    if (!currentUser) return;
    
    const { data: dbData, error } = await db
        .from('watched_items')
        .select('title');

    if (error) {
        console.error("Ошибка при загрузке списка просмотренного:", error);
        return;
    }

    watchedTitles = new Set(dbData.map(item => item.title));
}

// Подписка на изменения базы данных в реальном времени (Websockets)
function subscribeToChanges() {
    if (realtimeChannel) return; 

    realtimeChannel = db
        .channel('schema-db-changes')
        .on(
            'postgres_changes',
            {
                event: '*', 
                schema: 'public',
                table: 'watched_items'
            },
            (payload) => {
                console.log('Изменение получено в реальном времени:', payload);
                
                if (payload.eventType === 'INSERT') {
                    watchedTitles.add(payload.new.title);
                } else if (payload.eventType === 'DELETE') {
                    watchedTitles.delete(payload.old.title);
                }

                // Обновляем интерфейс на лету
                updateUIOnLiveChange();
            }
        )
        .subscribe();
}

// Живое обновление интерфейса без принудительного сброса на главную
async function updateUIOnLiveChange() {
    await loadCatalogFromDB();

    // 1. Обновляем счетчик на кнопке "Просмотрено"
    let buttons = document.querySelectorAll("button");
    buttons.forEach(btn => {
        if (btn.textContent.includes("Просмотрено")) {
            btn.textContent = "🎬 Просмотрено (" + watchedTitles.size + ")";
        }
    });

    // 2. Обновляем иконки звездочек
    let rows = document.querySelectorAll(".item-row");
    rows.forEach(row => {
        let itemDiv = row.querySelector(".item");
        let watchBtn = row.querySelector(".btn-watch");
        
        if (itemDiv && watchBtn) {
            let itemText = itemDiv.textContent.trim();
            
            const isSecret = itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал");
            let lookupText = itemText;
            if (isSecret && !itemText.includes("(2026)")) {
                lookupText = itemText + " (2026)";
            }

            if (watchedTitles.has(lookupText)) {
                watchBtn.classList.add("watched");
                watchBtn.textContent = "★";
            } else {
                watchBtn.classList.remove("watched");
                watchBtn.textContent = "☆";
            }
        }
    });
}

// Добавление или удаление отметки "просмотрено"
async function toggleWatchState(title) {
    if (!currentUser) return;

    if (watchedTitles.has(title)) {
        watchedTitles.delete(title);
        updateUIOnLiveChange();

        const { error } = await db
            .from('watched_items')
            .delete()
            .eq('title', title)
            .eq('user_id', currentUser.id);

        if (error) {
            console.error("Ошибка при удалении фильма из БД:", error);
            watchedTitles.add(title);
            updateUIOnLiveChange();
        }
    } else {
        watchedTitles.add(title);
        updateUIOnLiveChange();

        const { error } = await db
            .from('watched_items')
            .insert([{ user_id: currentUser.id, title: title }]);

        if (error) {
            console.error("Ошибка при добавлении фильма в БД:", error);
            watchedTitles.delete(title);
            updateUIOnLiveChange();
        }
    }
}

// Экран авторизации
function showLoginScreen() {
    app.innerHTML = `
        <h1>Авторизация</h1>
        <form class="login-form" id="loginForm">
            <input type="text" id="loginUsername" placeholder="Имя" required autocomplete="username">
            <input type="password" id="loginPassword" placeholder="Пароль" required autocomplete="current-password">
            <button type="submit">Войти</button>
        </form>
    `;

    document.getElementById("loginForm").onsubmit = async (e) => {
        e.preventDefault();
        
        // Запускаем отслеживание акселерометра (пользователь кликнул, браузер разрешит)
        startShakeDetection();

        const username = document.getElementById("loginUsername").value.trim().toLowerCase();
        const password = document.getElementById("loginPassword").value;

        let email = "";

        if (username === "myakish") {
            email = "nowyouseemeinvi@gmail.com";
        } else if (username === "asmoday") {
            email = "unknownqsrll@gmail.com";
        } else {
            email = username;
        }

        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) {
            alert("Ошибка входа: неверный никнейм или пароль.");
            console.error("Ошибка авторизации:", error.message);
        }
    };
}

// Главная страница
async function showHome() {
    startTransitionLock();
    history = [];
    currentCategoryName = null; // Сбрасываем текущую категорию на главной
    await loadCatalogFromDB();
    
    let nav = document.querySelector(".navigation");
    if (nav) nav.remove();

    app.innerHTML = "";

    if (currentUser) {
        let header = document.createElement("div");
        header.className = "user-header";
        header.innerHTML = `<span id="userEmailSpan"></span> <button class="btn-logout" id="logoutBtn">Выйти</button>`;
        header.querySelector("#userEmailSpan").textContent = "Аккаунт: " + currentUser.email;
        app.appendChild(header);
        document.getElementById("logoutBtn").onclick = () => db.auth.signOut();
    }

    let title = document.createElement("h1");
    title.textContent = "Время Кино!";
    app.appendChild(title);

    if (currentUser) {
        let addBtn = document.createElement("button");
        addBtn.className = "btn-add-new";
        addBtn.textContent = "➕ Добавить тайтл";
        addBtn.style.background = "#e3f2fd";
        addBtn.style.color = "#0d47a1";
        addBtn.style.marginBottom = "20px";
        addBtn.onclick = () => showAddEditModal();
        app.appendChild(addBtn);
    }

    for (let key in dbData) {
        let button = document.createElement("button");
        button.textContent = key;
        // При клике на категорию запоминаем её название
        button.onclick = () => {
            currentCategoryName = key;
            openData(dbData[key], true);
        };
        app.appendChild(button);
    }

    let watchedBtn = document.createElement("button");
    watchedBtn.textContent = "🎬 Просмотрено (" + watchedTitles.size + ")";
    watchedBtn.style.background = "#ffe3ec";
    watchedBtn.onclick = () => {
        const list = Array.from(watchedTitles);
        currentCategoryName = "🎬 Просмотрено";
        openData(list, true, "🎬 Просмотрено");
    };
    app.appendChild(watchedBtn);
}

// Отрисовка строки элемента (тайтла)
function renderItemRow(itemText, container) {
    let row = document.createElement("div");
    row.className = "item-row";

    let itemDiv = document.createElement("div");
    itemDiv.className = "item";
    
    // --- ПРОВЕРКА НА СЕКРЕТНОСТЬ ---
    let isSecret = itemText.includes("Я Тебя Очень Сильно LЮБЛЮ!") || itemText.includes("Бакс Ориджинал");
    
    // Если мы внутри секретной категории, делаем тайтл секретным
    if (currentCategoryName && (currentCategoryName.includes("Секрет") || currentCategoryName.includes("🔒") || currentCategoryName.includes("❤️"))) {
        isSecret = true;
    }

    if (isSecret) {
        itemDiv.textContent = itemText.replace(/\s*\(\d{4}\)$/, "");
    } else {
        itemDiv.textContent = itemText;
        itemDiv.style.cursor = "pointer";
        itemDiv.style.userSelect = "none";
        itemDiv.style.webkitUserSelect = "none";
        
        let pressTimer = null;
        let isMoving = false;
        let startX = 0, startY = 0;

        const startPress = (e) => {
            isMoving = false;
            if (e.type === 'touchstart') {
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
            }

            pressTimer = setTimeout(() => {
                if (!isMoving) {
                    showActionMenu(itemText);
                }
            }, 700);
        };

        const cancelPress = () => {
            if (pressTimer !== null) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        };

        const movePress = (e) => {
            if (e.type === 'touchmove') {
                let diffX = Math.abs(e.touches[0].clientX - startX);
                let diffY = Math.abs(e.touches[0].clientY - startY);
                if (diffX > 10 || diffY > 10) {
                    isMoving = true;
                    cancelPress();
                }
            }
        };

        const preventPhantomClick = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        itemDiv.addEventListener("mousedown", startPress);
        itemDiv.addEventListener("mouseup", cancelPress);
        itemDiv.addEventListener("mouseleave", cancelPress);
        itemDiv.addEventListener("click", (e) => { e.preventDefault(); });

        itemDiv.addEventListener("touchstart", startPress, { passive: true });
        itemDiv.addEventListener("touchmove", movePress, { passive: true });
        itemDiv.addEventListener("touchend", (e) => {
            cancelPress();
            if (isMoving) return;
            if (pressTimer === null) {
                preventPhantomClick(e);
            }
        }, { passive: false });
        itemDiv.addEventListener("touchcancel", cancelPress);
    }
    
    row.appendChild(itemDiv);

    if (!isSecret) {
        let watchBtn = document.createElement("button");
        watchBtn.className = "btn-watch";
        if (watchedTitles.has(itemText)) {
            watchBtn.classList.add("watched");
            watchBtn.textContent = "★";
        } else {
            watchBtn.textContent = "☆";
        }
        watchBtn.onclick = () => toggleWatchState(itemText);
        row.appendChild(watchBtn);
    }

    container.appendChild(row);
}

// Всплывающее меню выбора действия
function showActionMenu(itemText) {
    if (itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал")) return;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "actionMenuModal";

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 10px;" id="menuTitle"></h3>
            <p style="color: #666; margin-bottom: 20px; font-size: 14px;">Выберите действие для этого тайтла:</p>
            <div class="action-buttons">
                <button class="btn-action-edit" id="actEdit">✏️ Редактировать</button>
                <button class="btn-action-delete" id="actDelete">❌ Удалить из базы</button>
                <button class="btn-action-cancel" id="actCancel">Отмена</button>
            </div>
        </div>
    `;

    // Записываем заголовок безопасно (защита от XSS)
    overlay.querySelector("#menuTitle").textContent = itemText;

    document.body.appendChild(overlay);

    document.getElementById("actEdit").onclick = () => {
        overlay.remove();
        handleEditClick(itemText);
    };

    document.getElementById("actDelete").onclick = () => {
        overlay.remove();
        handleDeleteClick(itemText);
    };

    document.getElementById("actCancel").onclick = () => {
        overlay.remove();
    };
}

// Функция открытия контента
function openData(content, saveHistory = true, customTitle = null) {
    startTransitionLock();
    if (saveHistory) {
        history.push(content);
    }

    app.innerHTML = "";

    if (customTitle) {
        let title = document.createElement("h1");
        title.textContent = customTitle;
        app.appendChild(title);
    }

    if (Array.isArray(content)) {
        content.forEach(item => {
            if (typeof item === "string") {
                renderItemRow(item, app);
            } 
            else if (typeof item === "object" && item !== null) {
                for (let franchiseName in item) {
                    let button = document.createElement("button");
                    button.textContent = franchiseName;
                    button.onclick = () => openData(item[franchiseName], true);
                    app.appendChild(button);
                }
            }
        });
    }
    else if (typeof content === "object" && content !== null) {
        for (let key in content) {
            let value = content[key];
            let button = document.createElement("button");
            button.textContent = key;
            button.onclick = () => openData(value, true);
            app.appendChild(button);
        }
    }

    addNavigation();
}

// Навигационная панель Назад/Домой
function addNavigation() {
    let oldNav = document.querySelector(".navigation");
    if (oldNav) {
        oldNav.remove();
    }

    let nav = document.createElement("div");
    nav.className = "navigation";

    let back = document.createElement("button");
    back.textContent = "⬅ Назад";

    back.onclick = () => {
        history.pop();
        let previous = history[history.length - 1];

        if (previous) {
            // Если выходим назад к списку категорий первого уровня, восстанавливаем имя категории
            if (history.length === 1) {
                // Если остался один шаг в истории, значит мы на уровне жанров текущей категории
                // Категорию не сбрасываем
            }
            openData(previous, false);
        } else {
            showHome();
        }
    };

    let home = document.createElement("button");
    home.textContent = "🏠 Домой";
    home.onclick = showHome;

    nav.appendChild(back);
    nav.appendChild(home);

    let container = document.querySelector(".container");
    if (container) {
        container.insertBefore(nav, container.firstChild);
    } else {
        document.body.insertBefore(nav, app);
    }
}

// Функция открытия модалки для ДОБАВЛЕНИЯ или РЕДАКТИРОВАНИЯ
function showAddEditModal(existingItem = null) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "addEditModal";

    const categories = Object.keys(dbData);
    
    // Собираем все уникальные ЖАНРЫ и ФРАНШИЗЫ из базы для автодополнения
    const existingGenres = new Set();
    const existingFranchises = new Set();

    for (let catKey in dbData) {
        const categoryData = dbData[catKey];
        if (Array.isArray(categoryData)) continue; 

        for (let genreKey in categoryData) {
            existingGenres.add(genreKey);
            const titles = categoryData[genreKey];
            
            if (typeof titles === "object" && !Array.isArray(titles)) {
                for (let franchiseKey in titles) {
                    existingFranchises.add(franchiseKey);
                }
            }
        }
    }

    const sortedGenres = Array.from(existingGenres).sort();
    const sortedFranchises = Array.from(existingFranchises).sort();

    const genreOptions = sortedGenres.map(g => `<option value="${g}">`).join("");
    const franchiseOptions = sortedFranchises.map(f => `<option value="${f}">`).join("");
    
    overlay.innerHTML = `
        <div class="modal-content">
            <h3>${existingItem ? "Редактировать" : "Добавить фильм/серию"}</h3>
            <form class="modal-form" id="modalForm">
                <label>Название</label>
                <input type="text" id="mTitle" required placeholder="Например: Крик 7">

                <label>Год выпуска</label>
                <input type="number" id="mYear" required placeholder="Например: 2026" value="2026">

                <label>Категория</label>
                <select id="mCategory" required>
                    ${categories.map(cat => `<option value="${cat}">${cat}</option>`).join("")}
                </select>

                <label>Жанр (Выберите или напишите свой)</label>
                <input type="text" id="mGenre" required placeholder="Например: Ужасы" list="genresList">
                <datalist id="genresList">
                    ${genreOptions}
                </datalist>

                <label>Франшиза (Если это часть серии, необязательно)</label>
                <input type="text" id="mFranchise" placeholder="Например: Крик" list="franchisesList">
                <datalist id="franchisesList">
                    ${franchiseOptions}
                </datalist>

                <div class="modal-buttons">
                    <button type="submit" class="btn-save">Сохранить</button>
                    <button type="button" class="btn-cancel" id="mCancel">Отмена</button>
                </div>
            </form>
        </div>
    `;

    document.body.appendChild(overlay);

    const mCategory = document.getElementById("mCategory");
    const mGenre = document.getElementById("mGenre");

    if (existingItem) {
        document.getElementById("mTitle").value = existingItem.title;
        document.getElementById("mYear").value = existingItem.year;
        mCategory.value = existingItem.category;
        mGenre.value = existingItem.genre;
        document.getElementById("mFranchise").value = existingItem.franchise || "";
    }

    document.getElementById("mCancel").onclick = () => overlay.remove();

    document.getElementById("modalForm").onsubmit = async (e) => {
        e.preventDefault();

        const titleVal = document.getElementById("mTitle").value.trim();
        const yearVal = parseInt(document.getElementById("mYear").value, 10);
        const catVal = mCategory.value;
        const genreVal = mGenre.value.trim();
        let franchiseVal = document.getElementById("mFranchise").value.trim();
        if (franchiseVal === "") franchiseVal = null;

        let result;

        if (existingItem) {
            result = await db
                .from("titles")
                .update({ title: titleVal, year: yearVal, category: catVal, genre: genreVal, franchise: franchiseVal })
                .eq("id", existingItem.id);
        } else {
            result = await db
                .from("titles")
                .insert([{ title: titleVal, year: yearVal, category: catVal, genre: genreVal, franchise: franchiseVal }]);
        }

        if (result.error) {
            alert("Ошибка сохранения: " + result.error.message);
        } else {
            overlay.remove();
            await updateUIOnLiveChange();
            showHome();
        }
    };
}

// Обработка кнопки "Редактировать"
async function handleEditClick(itemText) {
    const match = itemText.match(/^(.*?)\s*\((\d{4})\)$/);
    if (!match) return;

    const cleanTitle = match[1].trim();
    const year = parseInt(match[2], 10);

    const { data, error } = await db
        .from("titles")
        .select("*")
        .eq("title", cleanTitle)
        .eq("year", year)
        .limit(1)
        .single();

    if (error || !data) {
        alert("Не удалось найти этот элемент в базе данных.");
        return;
    }

    showAddEditModal(data);
}

// Обработка кнопки "Удалить"
async function handleDeleteClick(itemText) {
    const match = itemText.match(/^(.*?)\s*\((\d{4})\)$/);
    if (!match) return;

    const cleanTitle = match[1].trim();
    const year = parseInt(match[2], 10);

    if (confirm(`Вы уверены, что хотите навсегда удалить "${cleanTitle}"?`)) {
        
        // 1. Сначала чистим из просмотренных, чтобы не ругалась БД на связи
        const { error: watchedError } = await db
            .from("watched_items")
            .delete()
            .eq("title", itemText);

        if (watchedError) {
            console.error("Не удалось удалить из просмотренных:", watchedError.message);
        }

        // 2. Теперь удаляем сам фильм
        const { error } = await db
            .from("titles")
            .delete()
            .eq("title", cleanTitle)
            .eq("year", year);

        if (error) {
            alert("Ошибка при удалении: " + error.message);
        } else {
            await updateUIOnLiveChange();
            showHome();
        }
    }
}


// =======================================================
// ЛОГИКА ТРЯСКИ ТЕЛЕФОНА (SHAKE DETECTION)
// =======================================================
const SHAKE_THRESHOLD = 15; // Чувствительность датчика (15 — оптимально)
const SHAKE_TIMEOUT = 2500;  // Задержка между взмахами (2.5 сек), чтобы не спамило
let lastX = null, lastY = null, lastZ = null;
let lastShakeTime = 0;
let isShakeModalOpen = false; // Чтобы не открывать две модалки рандома одновременно

// Функция, которая собирает абсолютно ВСЕ фильмы из текущей выбранной ветки (включая все жанры и франшизы)
function getAllTitlesFromCategory(dataBranch) {
    let resultList = [];

    if (Array.isArray(dataBranch)) {
        dataBranch.forEach(item => {
            if (typeof item === 'string') {
                resultList.push(item);
            } else if (typeof item === 'object' && item !== null) {
                // Если внутри лежит франшиза
                for (let key in item) {
                    if (Array.isArray(item[key])) {
                        resultList = resultList.concat(item[key]);
                    }
                }
            }
        });
    } else if (typeof dataBranch === 'object' && dataBranch !== null) {
        for (let key in dataBranch) {
            resultList = resultList.concat(getAllTitlesFromCategory(dataBranch[key]));
        }
    }

    return resultList;
}

// Показ красивого модального окна со случайным выбором
function showRandomTitleModal(titleText) {
    if (isShakeModalOpen) return;
    isShakeModalOpen = true;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "shakeRandomModal";
    overlay.style.zIndex = "10000"; // Поверх всех остальных меню

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center; border: 3px solid #ff4081; animation: popIn 0.3s ease;">
            <div style="font-size: 40px; margin-bottom: 10px;">🎰</div>
            <h3 style="color: #ff4081; margin-bottom: 5px; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Выбор Судьбы!</h3>
            <h2 id="shakeRandomTitle" style="margin-bottom: 25px; font-size: 22px; line-height: 1.4;"></h2>
            <button id="closeShakeBtn" class="btn-save" style="background: #ff4081; width: 100%; border: none;">Супер, смотрим!</button>
        </div>
    `;

    // Безопасно выводим рандомный тайтл без XSS уязвимостей
    // И сразу убираем год для секретов, если выпал секрет
    const isSecret = titleText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || titleText.includes("Бакс Ориджинал") || (currentCategoryName && (currentCategoryName.includes("Секрет") || currentCategoryName.includes("🔒") || currentCategoryName.includes("❤️")));
    
    const displayText = isSecret ? titleText.replace(/\s*\(\d{4}\)$/, "") : titleText;
    overlay.querySelector("#shakeRandomTitle").textContent = displayText;

    document.body.appendChild(overlay);

    document.getElementById("closeShakeBtn").onclick = () => {
        overlay.remove();
        isShakeModalOpen = false;
    };
}

// Функция, реагирующая на тряску
function onPhoneShake() {
    const now = Date.now();
    if (now - lastShakeTime < SHAKE_TIMEOUT) return; 

    // Если мы на главном экране (категория не выбрана) или уже открыто окно рандома — игнорируем тряску
    if (!currentCategoryName || isShakeModalOpen) return;

    // Слегка вибрируем телефон (работает на Android)
    if (navigator.vibrate) {
        navigator.vibrate([200, 100, 200]); 
    }

    // Собираем все фильмы из открытой в данный момент ветки истории
    const currentDataBranch = history[history.length - 1];
    if (!currentDataBranch) return;

    const allCategoryTitles = getAllTitlesFromCategory(currentDataBranch);

    if (allCategoryTitles.length === 0) return;

    lastShakeTime = now;

    // Выбираем случайный тайтл
    const randomIndex = Math.floor(Math.random() * allCategoryTitles.length);
    const chosenTitle = allCategoryTitles[randomIndex];

    // Показываем модалку счастливчика
    showRandomTitleModal(chosenTitle);
}

// Обработчик акселерометра
function handleMotion(event) {
    const acceleration = event.accelerationIncludingGravity;
    if (!acceleration) return;

    let x = acceleration.x;
    let y = acceleration.y;
    let z = acceleration.z;

    if (lastX === null) {
        lastX = x; lastY = y; lastZ = z;
        return;
    }

    let deltaX = Math.abs(lastX - x);
    let deltaY = Math.abs(lastY - y);
    let deltaZ = Math.abs(lastZ - z);

    // Если движение превысило порог резкости по двум осям — это тряска!
    if ((deltaX > SHAKE_THRESHOLD && deltaY > SHAKE_THRESHOLD) || 
        (deltaX > SHAKE_THRESHOLD && deltaZ > SHAKE_THRESHOLD) || 
        (deltaY > SHAKE_THRESHOLD && deltaZ > SHAKE_THRESHOLD)) {
        
        onPhoneShake();
    }

    lastX = x; lastY = y; lastZ = z;
}

// Запуск детектора тряски
function startShakeDetection() {
    // Для iOS 13+ требуется явное разрешение
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission()
            .then(permissionState => {
                if (permissionState === 'granted') {
                    window.addEventListener('devicemotion', handleMotion);
                    console.log("Детектор тряски успешно запущен (iOS)");
                }
            })
            .catch(console.error);
    } else {
        // Для Android
        window.addEventListener('devicemotion', handleMotion);
        console.log("Детектор тряски успешно запущен (Android)");
    }
}
