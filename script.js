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
// Вставьте сюда ваши реальные данные из панели Supabase:
const SUPABASE_URL = "https://nwkgofmgluduldgsmwfa.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Igpb__d5aHp3DBbQH1NgOA_W8_Ku6aE";

// Инициализируем клиент под именем db, чтобы не было конфликта с глобальной переменной supabase
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = document.getElementById("app");
let currentUser = null;
let watchedTitles = new Set(); // Общий список просмотренного у обоих пользователей
let history = [];
let realtimeChannel = null; // Канал для мгновенных обновлений

// Слушатель событий авторизации
// Слушатель событий авторизации с предварительной загрузкой каталога
db.auth.onAuthStateChange((event, session) => {
    if (session) {
        currentUser = session.user;
        
        // Качаем параллельно: и список просмотренного, и сам каталог фильмов
        Promise.all([
            loadWatchedFromDB(),
            loadCatalogFromDB() // Качаем каталог один раз при старте!
        ]).then(() => {
            subscribeToChanges(); 
            showHome(); // Теперь запускается мгновенно
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
                event: '*', // Отслеживаем INSERT и DELETE
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

// Логика авто-обновления экрана без перезагрузки
// Живое обновление интерфейса без перезагрузки страницы
// Умное живое обновление интерфейса без принудительного сброса на главную
async function updateUIOnLiveChange() {
    // Подтягиваем свежие данные из базы
    await loadCatalogFromDB();

    // 1. Обновляем счетчик на кнопке "Просмотрено" (если мы на главной)
    let buttons = document.querySelectorAll("button");
    buttons.forEach(btn => {
        if (btn.textContent.includes("Просмотрено")) {
            btn.textContent = "🎬 Просмотрено (" + watchedTitles.size + ")";
        }
    });

    // 2. Обновляем иконки звездочек (★ / ☆) у текущих элементов на экране
    let rows = document.querySelectorAll(".item-row");
    rows.forEach(row => {
        let itemDiv = row.querySelector(".item");
        let watchBtn = row.querySelector(".btn-watch");
        
        if (itemDiv && watchBtn) {
            let itemText = itemDiv.textContent.trim();
            
            // Восстанавливаем оригинальный текст с годом для проверки в watchedTitles
            // (так как в "Секретах" мы год убирали при отрисовке)
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
        // Локально сразу удаляем, чтобы интерфейс откликнулся мгновенно
        watchedTitles.delete(title);
        updateUIOnLiveChange();

        // Отправляем запрос на удаление в БД (фильтруем по названию И по ID текущего юзера)
        const { error } = await db
            .from('watched_items')
            .delete()
            .eq('title', title)
            .eq('user_id', currentUser.id);

        if (error) {
            console.error("Ошибка при удалении фильма из БД:", error);
            // Если в БД удалить не удалось, возвращаем обратно
            watchedTitles.add(title);
            updateUIOnLiveChange();
        }
    } else {
        // Локально сразу добавляем для быстроты отклика
        watchedTitles.add(title);
        updateUIOnLiveChange();

        // Добавляем в БД
        const { error } = await db
            .from('watched_items')
            .insert([{ user_id: currentUser.id, title: title }]);

        if (error) {
            console.error("Ошибка при добавлении фильма в БД:", error);
            // Если в БД добавить не удалось, откатываем назад
            watchedTitles.delete(title);
            updateUIOnLiveChange();
        }
    }
}
// Экран авторизации
// Экран авторизации с подменой никнеймов на почты
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
        
        // Получаем введенный никнейм и приводим к нижнему регистру, чтобы не зависеть от опечаток (Asmoday или asmoday)
        const username = document.getElementById("loginUsername").value.trim().toLowerCase();
        const password = document.getElementById("loginPassword").value;

        let email = "";

        // Карта сопоставления никнеймов и реальных почт
        if (username === "myakish") {
            email = "nowyouseemeinvi@gmail.com";
        } else if (username === "asmoday") {
            email = "unknownqsrll@gmail.com";
        } else {
            // Если введен неизвестный никнейм, пробуем отправить его как есть (на случай, если захотите войти по обычной почте)
            email = username;
        }

        // Выполняем вход в Supabase
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) {
            alert("Ошибка входа: неверный никнейм или пароль.");
            console.error("Ошибка авторизации:", error.message);
        }
    };
}

// Главная страница
// Главная страница с динамической загрузкой категорий из Supabase
// Главная страница — теперь работает МГНОВЕННО без запросов в сеть
function showHome() {
    startTransitionLock();
    history = [];
    
    let nav = document.querySelector(".navigation");
    if (nav) nav.remove();

    app.innerHTML = "";

    if (currentUser) {
        let header = document.createElement("div");
        header.className = "user-header";
        header.innerHTML = `
            <span>Аккаунт: ${currentUser.email}</span>
            <button class="btn-logout" id="logoutBtn">Выйти</button>
        `;
        app.appendChild(header);
        document.getElementById("logoutBtn").onclick = () => db.auth.signOut();
    }

    let title = document.createElement("h1");
    title.textContent = "Время Кино!";
    app.appendChild(title);

    // Кнопка: Добавить тайтл (только для авторизованных)
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
        button.onclick = () => openData(dbData[key], true);
        app.appendChild(button);
    }

    let watchedBtn = document.createElement("button");
    watchedBtn.textContent = "🎬 Просмотрено (" + watchedTitles.size + ")";
    watchedBtn.style.background = "#ffe3ec";
    watchedBtn.onclick = () => {
        const list = Array.from(watchedTitles);
        openData(list, true, "🎬 Просмотрено");
    };
    app.appendChild(watchedBtn);
}

// Отрисовка строки элемента с интерактивом
// Отрисовка строки элемента (тайтла)
// Отрисовка строки элемента (тайтла) с умным зажатием без фантомных кликов
// Отрисовка строки элемента (тайтла) с умным зажатием без фантомных кликов
function renderItemRow(itemText, container) {
    let row = document.createElement("div");
    row.className = "item-row";

    let itemDiv = document.createElement("div");
    itemDiv.className = "item";
    
    // --- ПРОВЕРКА НА СЕКРЕТНОСТЬ ---
    // 1. Проверяем по конкретным текстам (на всякий случай)
    let isSecret = itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал");
    
    // 2. И проверяем по названию текущей категории в истории
    if (history.length > 0) {
        const currentCategoryData = history[history.length - 1];
        // Ищем в dbData категорию, которая совпадает с текущим экраном
        for (let catName in dbData) {
            if (dbData[catName] === currentCategoryData && (catName.includes("Секрет") || catName.includes("🔒") || catName.includes("❤️"))) {
                isSecret = true;
                break;
            }
        }
    }

    if (isSecret) {
        // Убираем год в конце (любые четыре цифры в скобках)
        itemDiv.textContent = itemText.replace(/\s*\(\d{4}\)$/, "");
    } else {
        itemDiv.textContent = itemText;
        itemDiv.style.cursor = "pointer";
        itemDiv.style.userSelect = "none"; // Запрещаем выделение текста при зажатии
        itemDiv.style.webkitUserSelect = "none";
        
        let pressTimer = null;
        let isMoving = false; // Флаг, чтобы отличать скролл от зажатия
        let startX = 0, startY = 0;

        // Начало нажатия
        const startPress = (e) => {
            isMoving = false;
            
            // Запоминаем начальную точку тача (для проверки скролла)
            if (e.type === 'touchstart') {
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
            }

            // Запускаем таймер зажатия на 700мс
            pressTimer = setTimeout(() => {
                if (!isMoving) {
                    showActionMenu(itemText);
                }
            }, 700);
        };

        // Отмена таймера (если отпустили раньше времени)
        const cancelPress = () => {
            if (pressTimer !== null) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        };

        // Проверка движения пальца (если сдвинули больше чем на 10px — это скролл, а не зажатие)
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

        // Защита от фантомных кликов
        const preventPhantomClick = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        // Слушатели для ПК
        itemDiv.addEventListener("mousedown", startPress);
        itemDiv.addEventListener("mouseup", cancelPress);
        itemDiv.addEventListener("mouseleave", cancelPress);
        itemDiv.addEventListener("click", (e) => {
            e.preventDefault();
        });

        // Слушатели для мобилок (тач)
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

    // Звёздочку рисуем только для НЕ секретных тайтлов
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

// Всплывающее меню выбора действия при клике на тайтл
function showActionMenu(itemText) {
    // Проверяем на секрет (на всякий случай)
    if (itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал")) return;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "actionMenuModal";

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 10px;">${itemText}</h3>
            <p style="color: #666; margin-bottom: 20px; font-size: 14px;">Выберите действие для этого тайтла:</p>
            <div class="action-buttons">
                <button class="btn-action-edit" id="actEdit">✏️ Редактировать</button>
                <button class="btn-action-delete" id="actDelete">❌ Удалить</button>
                <button class="btn-action-cancel" id="actCancel">Отмена</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // Привязываем действия к кнопкам
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
// Показ модального окна добавления или редактирования тайтла
async function showAddEditModal(editItem = null) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "addEditModal";

    // Собираем все уникальные ЖАНРЫ и ФРАНШИЗЫ, которые уже есть в базе
    const existingGenres = new Set();
    const existingFranchises = new Set();

    for (let catKey in dbData) {
        const categoryData = dbData[catKey];
        if (Array.isArray(categoryData)) continue; // Пропускаем плоские списки (например, "Просмотрено")

        for (let genreKey in categoryData) {
            existingGenres.add(genreKey);
            const titles = categoryData[genreKey];
            
            // Если внутри жанра лежит объект (франшизы)
            if (typeof titles === "object" && !Array.isArray(titles)) {
                for (let franchiseKey in titles) {
                    existingFranchises.add(franchiseKey);
                }
            }
        }
    }

    // Превращаем сеты в упорядоченные массивы
    const sortedGenres = Array.from(existingGenres).sort();
    const sortedFranchises = Array.from(existingFranchises).sort();

    // Генерируем HTML-опции для автодополнения жанров
    const genreOptions = sortedGenres.map(g => `<option value="${g}"></option>`).join("");
    // Генерируем HTML-опции для автодополнения франшиз
    const franchiseOptions = sortedFranchises.map(f => `<option value="${f}"></option>`).join("");

    overlay.innerHTML = `
        <div class="modal-content">
            <h3>${editItem ? "✏️ Редактировать тайтл" : "➕ Добавить новый тайтл"}</h3>
            <form id="addTitleForm">
                <div class="form-group">
                    <label>Название фильма:</label>
                    <input type="text" id="mTitle" required placeholder="Например: Шрек 5" value="${editItem ? editItem.title : ""}">
                </div>
                <div class="form-group">
                    <label>Год выпуска:</label>
                    <input type="number" id="mYear" required placeholder="Например: 2026" value="${editItem ? editItem.year : new Date().getFullYear()}">
                </div>
                <div class="form-group">
                    <label>Категория:</label>
                    <select id="mCategory" required>
                        <option value="🎥 Фильмы" ${editItem && editItem.category === "🎥 Фильмы" ? "selected" : ""}>🎥 Фильмы</option>
                        <option value="🍿 Сериалы" ${editItem && editItem.category === "🍿 Сериалы" ? "selected" : ""}>🍿 Сериалы</option>
                        <option value="🏮 Аниме" ${editItem && editItem.category === "🏮 Аниме" ? "selected" : ""}>🏮 Аниме</option>
                        <option value="🔒 Секрет" ${editItem && editItem.category === "🔒 Секрет" ? "selected" : ""}>🔒 Секрет</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Жанр (выберите из списка или впишите свой):</label>
                    <input type="text" id="mGenre" list="genresList" required placeholder="Начните писать или выберите жанр..." value="${editItem ? editItem.genre : ""}">
                    <datalist id="genresList">
                        ${genreOptions}
                    </datalist>
                </div>
                <div class="form-group">
                    <label>Франшиза (необязательно, выберите или впишите свою):</label>
                    <input type="text" id="mFranchise" list="franchisesList" placeholder="Оставьте пустым, если нет франшизы" value="${editItem && editItem.franchise ? editItem.franchise : ""}">
                    <datalist id="franchisesList">
                        ${franchiseOptions}
                    </datalist>
                </div>
                <div style="display: flex; gap: 10px; margin-top: 20px;">
                    <button type="submit" class="btn-submit" style="flex: 1; padding: 12px; background: #0d47a1; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">Сохранить</button>
                    <button type="button" id="closeModalBtn" style="flex: 1; padding: 12px; background: #eee; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">Отмена</button>
                </div>
            </form>
        </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById("closeModalBtn").onclick = () => overlay.remove();

    // Обработка отправки формы
    document.getElementById("addTitleForm").onsubmit = async (e) => {
        e.preventDefault();

        const title = document.getElementById("mTitle").value.trim();
        const year = parseInt(document.getElementById("mYear").value, 10);
        const category = document.getElementById("mCategory").value;
        const genre = document.getElementById("mGenre").value.trim();
        
        // Получаем франшизу (если пусто — записываем null в базу)
        let franchise = document.getElementById("mFranchise").value.trim();
        if (franchise === "") franchise = null;

        if (editItem) {
            // Обновление существующей записи
            const { error } = await db
                .from("titles")
                .update({ title, year, category, genre, franchise })
                .eq("id", editItem.id);

            if (error) {
                alert("Ошибка изменения: " + error.message);
            } else {
                overlay.remove();
                await updateUIOnLiveChange();
            }
        } else {
            // Добавление новой записи
            const { error } = await db
                .from("titles")
                .insert([{ title, year, category, genre, franchise }]);

            if (error) {
                alert("Ошибка добавления: " + error.message);
            } else {
                overlay.remove();
                await updateUIOnLiveChange();
            }
        }
    };
}

// Обработка кнопки "Редактировать"
async function handleEditClick(itemText) {
    // Парсим название и год обратно (например "Крик (2026)")
    const match = itemText.match(/^(.*?)\s*\((\d{4})\)$/);
    if (!match) return;

    const cleanTitle = match[1].trim();
    const year = parseInt(match[2], 10);

    // Ищем запись в базе, чтобы узнать её ID, категорию и жанр
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
        const { error } = await db
            .from("titles")
            .delete()
            .eq("title", cleanTitle)
            .eq("year", year);

        if (error) {
            alert("Ошибка при удалении: " + error.message);
        } else {
            await updateUIOnLiveChange();
            // Возвращаемся на главную
            showHome();
        }
    }
}
