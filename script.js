let dbData = {}; // Сюда мы динамически соберем структуру категорий и жанров из базы данных
let isTransitioning = false; // Флаг: идет ли сейчас перерисовка экрана
let isMusicPlaying = localStorage.getItem("musicEnabled") === "true";

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
                
                let stateChanged = false;
                if (payload.eventType === 'INSERT') {
                    if (!watchedTitles.has(payload.new.title)) {
                        watchedTitles.add(payload.new.title);
                        stateChanged = true;
                    }
                } else if (payload.eventType === 'DELETE') {
                    stateChanged = true;
                }

                // Обновляем интерфейс на лету только при реальных изменениях
                if (stateChanged) {
                    updateUIOnLiveChange();
                }
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

// МЯГКОЕ ОБНОВЛЕНИЕ ТЕКУЩЕГО ЭКРАНА (без выброса на "Домой")
async function refreshCurrentScreen() {
    await loadCatalogFromDB();
    if (history.length > 0) {
        // Перерисовываем ту ветку, на которой сейчас находится пользователь
        let currentActiveData = history[history.length - 1];
        openData(currentActiveData, false); 
    } else {
        showHome();
    }
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

// =======================================================
// ЛОГИКА ПОИСКА (ЛЕВЕНШТЕЙН / НЕЧЕТКИЙ ПОИСК)
// =======================================================

// Вычисление расстояния Левенштейна между двумя строками
function getLevenshteinDistance(a, b) {
    const tmp = [];
    let i, j, alen = a.length, blen = b.length, cost;
    if (alen === 0) return blen;
    if (blen === 0) return alen;
    for (i = 0; i <= alen; i++) tmp[i] = [i];
    for (j = 0; j <= blen; j++) tmp[0][j] = j;
    for (i = 1; i <= alen; i++) {
        for (j = 1; j <= blen; j++) {
            cost = (a[i - 1] === b[j - 1]) ? 0 : 1;
            tmp[i][j] = Math.min(tmp[i - 1][j] + 1, tmp[i][j - 1] + 1, tmp[i - 1][j - 1] + cost);
        }
    }
    return tmp[alen][blen];
}

// Функция нечеткого поиска по каталогу
function performCatalogSearch(query) {
    const searchStr = query.toLowerCase().trim();
    if (!searchStr) return;

    const results = [];
    
    // Проходимся по всей структуре dbData
    for (let catKey in dbData) {
        // Исключаем любые секретные категории из поиска
        if (catKey.includes("Секрет") || catKey.includes("🔒") || catKey.includes("❤️")) {
            continue;
        }

        const categoryData = dbData[catKey];
        for (let genreKey in categoryData) {
            const listOrObj = categoryData[genreKey];

            const processTitle = (fullTitle, franchiseName = null) => {
                const cleanTitle = fullTitle.replace(/\s*\(\d{4}\)$/, "").toLowerCase();
                
                // 1. Точное/Прямое вхождение
                if (cleanTitle.includes(searchStr) || 
                    (franchiseName && franchiseName.toLowerCase().includes(searchStr)) ||
                    genreKey.toLowerCase().includes(searchStr)) {
                    results.push({ title: fullTitle, score: 0 });
                    return;
                }

                // 2. Нечеткий поиск (допускаем опечатки)
                const queryWords = searchStr.split(/\s+/);
                const titleWords = cleanTitle.split(/\s+/);

                let totalDistance = 0;
                let matchesCount = 0;

                queryWords.forEach(qw => {
                    let bestWordDist = 999;
                    titleWords.forEach(tw => {
                        const dist = getLevenshteinDistance(qw, tw);
                        if (dist < bestWordDist) {
                            bestWordDist = dist;
                        }
                    });

                    // Порог для опечаток:
                    // до 4 символов — 1 ошибка, длиннее 4 символов — 2 ошибки
                    const maxAllowedErrors = qw.length <= 4 ? 1 : 2;

                    if (bestWordDist <= maxAllowedErrors) {
                        totalDistance += bestWordDist;
                        matchesCount++;
                    }
                });

                if (matchesCount === queryWords.length) {
                    results.push({ title: fullTitle, score: totalDistance + 1 });
                }
            };

            if (Array.isArray(listOrObj)) {
                listOrObj.forEach(item => {
                    if (typeof item === 'string') {
                        processTitle(item);
                    } else if (typeof item === 'object' && item !== null) {
                        for (let franchiseName in item) {
                            item[franchiseName].forEach(subTitle => {
                                processTitle(subTitle, franchiseName);
                            });
                        }
                    }
                });
            }
        }
    }

    // Сортируем: сначала точные, затем по возрастанию ошибок
    results.sort((a, b) => a.score - b.score);

    const uniqueResults = [];
    const seen = new Set();
    results.forEach(r => {
        if (!seen.has(r.title)) {
            seen.add(r.title);
            uniqueResults.push(r.title);
        }
    });

    currentCategoryName = "🔍 Результаты поиска";
    openData(uniqueResults, true, `Результаты для: "${query}"`);
}

// Главная страница
async function showHome() {
    startTransitionLock();
    history = [];
    currentCategoryName = null;
    await loadCatalogFromDB();
    
    let nav = document.querySelector(".navigation");
    if (nav) nav.remove();

    app.innerHTML = "";

    const createIconButton = (icon, onClick) => {
        let btn = document.createElement("button");
        btn.textContent = icon;
        btn.style.cssText = `
            width: 40px !important; height: 40px !important;
            min-width: 40px !important; min-height: 40px !important;
            padding: 0 !important; margin: 0 !important;
            border-radius: 50% !important; display: flex !important;
            justify-content: center !important; align-items: center !important;
            cursor: pointer !important; border: 1px solid #ccc !important;
            background: #f9f9f9 !important; font-size: 16px !important;
            box-sizing: border-box !important; overflow: visible !important;
            line-height: 1 !important; flex-shrink: 0 !important;
        `;
        btn.onclick = onClick;
        return btn;
    };

    if (currentUser) {
        let header = document.createElement("div");
        header.className = "user-header";
        header.style.display = "flex";
        header.style.justifyContent = "space-between";
        header.style.alignItems = "center";
        header.style.marginBottom = "15px";

        header.innerHTML = `<span id="userEmailSpan" style="font-size: 14px;">${currentUser.email}</span>`;
        
        let controls = document.createElement("div");
        controls.style.display = "flex";
        controls.style.alignItems = "center";
        controls.style.gap = "10px";

        let musicBtn = createIconButton(isMusicPlaying ? "🔊" : "🔇", () => {
            const audio = document.getElementById("bgMusic");
            if (audio.paused) { audio.play(); isMusicPlaying = true; localStorage.setItem("musicEnabled", "true"); musicBtn.textContent = "🔊"; }
            else { audio.pause(); isMusicPlaying = false; localStorage.setItem("musicEnabled", "false"); musicBtn.textContent = "🔇"; }
        });

        let logoutBtn = createIconButton("❌", () => db.auth.signOut());

        controls.appendChild(musicBtn);
        controls.appendChild(logoutBtn);
        header.appendChild(controls);
        app.appendChild(header);
    }

    let title = document.createElement("h1");
    title.textContent = "Время Кино!";
    app.appendChild(title);

    if (currentUser) {
        // Кнопка "Добавить"
        let addBtn = document.createElement("button");
        addBtn.className = "btn-add-new";
        addBtn.textContent = "➕ Добавить тайтл";
        addBtn.style.background = "#e3f2fd";
        addBtn.style.color = "#0d47a1";
        addBtn.style.marginBottom = "10px";
        addBtn.onclick = () => showAddEditModal();
        app.appendChild(addBtn);
        
        // Сплиттер HR
        let hr = document.createElement("hr");
        hr.style.border = "0";
        hr.style.borderTop = "2px solid #9b4f70"; 
        hr.style.margin = "15px 0";
        app.appendChild(hr);

        // ПОИСК РАСПОЛАГАЕТСЯ ЗДЕСЬ (Ниже hr, выше кнопок категорий)
        let searchContainer = document.createElement("div");
        searchContainer.style.cssText = `
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
            width: 100%;
            box-sizing: border-box;
        `;

        let searchInput = document.createElement("input");
        searchInput.type = "text";
        searchInput.placeholder = "Поиск по названию или жанру...";
        searchInput.style.cssText = `
            flex-grow: 1;
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 8px;
            font-size: 14px;
            box-sizing: border-box;
        `;

        let searchSubmitBtn = document.createElement("button");
        searchSubmitBtn.textContent = "🔍";
        searchSubmitBtn.style.cssText = `
            width: 42px !important;
            height: 42px !important;
            padding: 0 !important;
            margin: 0 !important;
            border-radius: 8px !important;
            background: #e3f2fd !important;
            border: 1px solid #bbdefb !important;
            cursor: pointer;
            font-size: 16px;
            display: flex;
            justify-content: center;
            align-items: center;
            flex-shrink: 0;
        `;

        const doSearch = () => {
            const q = searchInput.value;
            if (q.trim()) {
                performCatalogSearch(q);
            }
        };

        searchSubmitBtn.onclick = doSearch;
        searchInput.onkeydown = (e) => {
            if (e.key === "Enter") {
                doSearch();
            }
        };

        searchContainer.appendChild(searchInput);
        searchContainer.appendChild(searchSubmitBtn);
        app.appendChild(searchContainer);
    }

    // Рендерим кнопки категорий (включая Аниме)
    for (let key in dbData) {
        let button = document.createElement("button");
        button.textContent = key;
        button.onclick = () => { currentCategoryName = key; openData(dbData[key], true); };
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

    let footer = document.createElement("p");
    footer.style.textAlign = "center";
    footer.style.marginTop = "40px";
    footer.style.fontSize = "10px";
    footer.style.color = "#999";
    footer.innerHTML = 'Музыка: "Echoes Of Home" by Scott Buckley (www.scottbuckley.com.au) — Licensed under CC-BY 4.0';
    app.appendChild(footer);
}

// Отрисовка строки элемента (тайтла)
function renderItemRow(itemText, container) {
    let row = document.createElement("div");
    row.className = "item-row";

    let itemDiv = document.createElement("div");
    itemDiv.className = "item";
    
    let isSecret = itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал");
    
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

    // УБИРАЕМ КАТЕГОРИЮ "СЕКРЕТ" ИЗ ДОСТУПНЫХ ДЛЯ ДОБАВЛЕНИЯ
    const categories = Object.keys(dbData).filter(cat => {
        return !cat.includes("Секрет") && !cat.includes("🔒") && !cat.includes("❤️");
    });
    
    // Собираем все уникальные жанры для автодополнения (по всему разрешенному каталогу)
    const existingGenres = new Set();
    for (let catKey in dbData) {
        if (catKey.includes("Секрет") || catKey.includes("🔒") || catKey.includes("❤️")) continue;
        
        const categoryData = dbData[catKey];
        if (typeof categoryData === "object" && !Array.isArray(categoryData)) {
            for (let genreKey in categoryData) {
                existingGenres.add(genreKey);
            }
        }
    }

    const sortedGenres = Array.from(existingGenres).sort();
    const genreOptions = sortedGenres.map(g => `<option value="${g}">`).join("");
    
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
    const mFranchise = document.getElementById("mFranchise");
    const franchisesList = document.getElementById("franchisesList");

    // Функция динамического обновления списка франшиз на основе выбранных категории и жанра
    function updateFranchisesDatalist() {
        const selectedCategory = mCategory.value;
        const selectedGenre = mGenre.value.trim();

        const localFranchises = new Set();

        if (dbData[selectedCategory] && dbData[selectedCategory][selectedGenre]) {
            const listOrObj = dbData[selectedCategory][selectedGenre];
            
            if (Array.isArray(listOrObj)) {
                listOrObj.forEach(item => {
                    if (typeof item === 'object' && item !== null) {
                        Object.keys(item).forEach(franchiseName => {
                            localFranchises.add(franchiseName);
                        });
                    }
                });
            }
        }

        franchisesList.innerHTML = Array.from(localFranchises)
            .sort()
            .map(f => `<option value="${f}">`)
            .join("");
    }

    mCategory.addEventListener("change", updateFranchisesDatalist);
    mGenre.addEventListener("input", updateFranchisesDatalist);

    if (existingItem) {
        document.getElementById("mTitle").value = existingItem.title;
        document.getElementById("mYear").value = existingItem.year;
        mCategory.value = existingItem.category;
        mGenre.value = existingItem.genre;
        mFranchise.value = existingItem.franchise || "";
    }

    updateFranchisesDatalist();

    document.getElementById("mCancel").onclick = () => overlay.remove();

    document.getElementById("modalForm").onsubmit = async (e) => {
        e.preventDefault();

        const titleVal = document.getElementById("mTitle").value.trim();
        const yearVal = parseInt(document.getElementById("mYear").value, 10);
        const catVal = mCategory.value;
        const genreVal = mGenre.value.trim();
        let franchiseVal = mFranchise.value.trim();
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
            await refreshCurrentScreen();
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
        
        const { error: watchedError } = await db
            .from("watched_items")
            .delete()
            .eq("title", itemText);

        if (watchedError) {
            console.error("Не удалось удалить из просмотренных:", watchedError.message);
        }

        const { error } = await db
            .from("titles")
            .delete()
            .eq("title", cleanTitle)
            .eq("year", year);

        if (error) {
            alert("Ошибка при удалении: " + error.message);
        } else {
            await refreshCurrentScreen();
        }
    }
}


// =======================================================
// ЛОГИКА ТРЯСКИ ТЕЛЕФОНА (SHAKE DETECTION)
// =======================================================
const SHAKE_THRESHOLD = 15; 
const SHAKE_TIMEOUT = 2500;  
let lastX = null, lastY = null, lastZ = null;
let lastShakeTime = 0;
let isShakeModalOpen = false; 

function getAllTitlesFromCategory(dataBranch) {
    let resultList = [];

    if (Array.isArray(dataBranch)) {
        dataBranch.forEach(item => {
            if (typeof item === 'string') {
                resultList.push(item);
            } else if (typeof item === 'object' && item !== null) {
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

function showRandomTitleModal(titleText) {
    if (isShakeModalOpen) return;
    isShakeModalOpen = true;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "shakeRandomModal";
    overlay.style.zIndex = "10000";

    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); isShakeModalOpen = false; } };

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center; border: 3px solid #ff4081;">
            <div style="font-size: 40px;">🎰</div>
            <h2 id="shakeRandomTitle" style="margin: 15px 0;"></h2>
            <div style="display: flex; flex-direction: column; gap: 10px;">
                <button id="closeShakeBtn" class="btn-save">Супер, смотрим!</button>
                <button id="rerollShakeBtn" class="btn-cancel">🔄 Другой фильм</button>
            </div>
        </div>
    `;

    const isSecret = titleText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || titleText.includes("Бакс Ориджинал") || (currentCategoryName && (currentCategoryName.includes("Секрет") || currentCategoryName.includes("🔒")));
    overlay.querySelector("#shakeRandomTitle").textContent = isSecret ? titleText.replace(/\s*\(\d{4}\)$/, "") : titleText;

    document.body.appendChild(overlay);

    document.getElementById("closeShakeBtn").onclick = () => { overlay.remove(); isShakeModalOpen = false; };
    document.getElementById("rerollShakeBtn").onclick = () => {
        const all = getAllTitlesFromCategory(history[history.length - 1]);
        const next = all[Math.floor(Math.random() * all.length)];
        overlay.querySelector("#shakeRandomTitle").textContent = isSecret ? next.replace(/\s*\(\d{4}\)$/, "") : next;
    };
}

function onPhoneShake() {
    if (currentCategoryName && (currentCategoryName.includes("Секрет") || currentCategoryName.includes("🔒"))) {
        return;
    }

    const now = Date.now();
    if (now - lastShakeTime < 2000 || isShakeModalOpen) return;

    const currentDataBranch = history[history.length - 1];
    if (!currentDataBranch) return;

    const allTitles = getAllTitlesFromCategory(currentDataBranch);
    if (allTitles.length === 0) return;

    lastShakeTime = now;
    const randomTitle = allTitles[Math.floor(Math.random() * allTitles.length)];
    
    showRandomTitleModal(randomTitle);
    isShakeModalOpen = true; 
}

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

    if ((deltaX > SHAKE_THRESHOLD && deltaY > SHAKE_THRESHOLD) || 
        (deltaX > SHAKE_THRESHOLD && deltaZ > SHAKE_THRESHOLD) || 
        (deltaY > SHAKE_THRESHOLD && deltaZ > SHAKE_THRESHOLD)) {
        
        onPhoneShake();
    }

    lastX = x; lastY = y; lastZ = z;
}

function startShakeDetection() {
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
        window.addEventListener('devicemotion', handleMotion);
        console.log("Детектор тряски успешно запущен (Android)");
    }
}

function setupMusicAutoplay() {
    const audio = document.getElementById("bgMusic");
    
    const playHandler = () => {
        if (isMusicPlaying) {
            audio.play().catch(e => console.log("Музыка не смогла запуститься"));
            document.removeEventListener("click", playHandler); 
        }
    };

    document.addEventListener("click", playHandler);
}

setupMusicAutoplay();
const style = document.createElement('style');
style.textContent = `
    .round-btn {
        overflow: hidden;
        width: 40px !important;
        height: 40px !important;
        padding: 0 !important;
        margin: 0 !important;
        border-radius: 50% !important;
        display: flex !important;
        justify-content: center !important;
        align-items: center !important;
        cursor: pointer !important;
        border: 1px solid #ccc !important;
        background: #f9f9f9 !important;
        font-size: 18px !important;
        box-sizing: border-box !important;
        line-height: 1 !important;
    }
`;
document.head.appendChild(style);
