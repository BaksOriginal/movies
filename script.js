let dbData = {}; // Сюда мы динамически соберем структуру категорий и жанров из базы данных

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
async function updateUIOnLiveChange() {
    // 1. Сначала подтягиваем самые свежие данные из базы
    await loadCatalogFromDB();

    // 2. Ищем кнопку "Просмотрено" на экране и обновляем на ней счетчик
    let buttons = document.querySelectorAll("button");
    buttons.forEach(btn => {
        if (btn.textContent.includes("Просмотрено")) {
            btn.textContent = "🎬 Просмотрено (" + watchedTitles.size + ")";
        }
    });

    // 3. Обновляем иконки звездочек (★ / ☆) у текущих элементов на экране
    let rows = document.querySelectorAll(".item-row");
    rows.forEach(row => {
        let itemDiv = row.querySelector(".item");
        let watchBtn = row.querySelector(".btn-watch");
        
        if (itemDiv && watchBtn) {
            let itemText = itemDiv.textContent.trim();
            if (watchedTitles.has(itemText)) {
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
async function showHome() {
    history = [];
    
    // Ждем, пока данные скачаются из базы данных, прежде чем рисовать интерфейс
    await loadCatalogFromDB();
    
    let nav = document.querySelector(".navigation");
    if (nav) {
        nav.remove();
    }

    app.innerHTML = "";

    // Шапка профиля с кнопкой выхода
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

    // Вывод обычных категорий из объекта dbData (из базы данных)
    for (let key in dbData) {
        let button = document.createElement("button");
        button.textContent = key;
        button.onclick = () => {
            openData(dbData[key], true);
        };
        app.appendChild(button);
    }

    // Кнопка категории "Просмотрено"
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
function renderItemRow(itemText, container) {
    let row = document.createElement("div");
    row.className = "item-row";

    let itemDiv = document.createElement("div");
    itemDiv.className = "item";
    itemDiv.textContent = itemText;
    row.appendChild(itemDiv);

    // Список строк из категории "Секрет", у которых не должно быть звездочки
    const secretItems = [
        "❤️ Я Тебя Очень Сильно ЛЮБЛЮ! ❤️",
        "👑 Бакс Ориджинал 👑"
    ];

    // Добавляем звездочку только если элемент НЕ входит в секретный список
    if (!secretItems.includes(itemText)) {
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

// Функция открытия контента
function openData(content, saveHistory = true, customTitle = null) {
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
