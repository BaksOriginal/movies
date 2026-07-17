let dbData = {}; // Сюда мы динамически соберем структуру категорий и жанров из базы данных
let titleCreatedAt = {}; // "Название (год)" -> дата добавления в базу (для синего кружка "новинка")

// ==========================================
// TMDB (постеры фильмов/сериалов)
// ==========================================
// Получите бесплатный ключ на https://www.themoviedb.org/settings/api
// и вставьте его сюда вместо заглушки.
const TMDB_API_KEY = "17ff3215ca3fae9d63aacaf9f5fd14c3";
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w342";

// ==========================================
// СТИКЕРЫ ДЛЯ ЧАТА (хранятся в GitHub, не в БД)
// ==========================================
// Загрузите картинки стикеров (.png/.jpg/.jpeg/.webp/.gif) в папку "stickers"
// вашего GitHub-репозитория и укажите ниже владельца/имя репозитория/ветку.
// Список стикеров подтягивается динамически через GitHub API — просто
// добавляйте новые файлы в папку, менять код не нужно.
const GITHUB_STICKERS_OWNER = "ВАШ_GITHUB_ЛОГИН";
const GITHUB_STICKERS_REPO = "ВАШ_РЕПОЗИТОРИЙ";
const GITHUB_STICKERS_BRANCH = "main";
const GITHUB_STICKERS_PATH = "stickers";
const STICKER_PREFIX = "[[STICKER]]"; // маркер стикера внутри текстового поля message

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
    const tempCreatedAt = {};

    titles.forEach(item => {
        const cat = item.category;
        const gen = item.genre;
        const fran = item.franchise;
        const titleWithYear = `${item.title} (${item.year})`;
        tempCreatedAt[titleWithYear] = item.created_at || null;

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
    titleCreatedAt = tempCreatedAt;
}

// Проверка: был ли тайтл добавлен в базу недавно (в течение 2 суток)
function isRecentlyAdded(title) {
    const createdAt = titleCreatedAt[title];
    if (!createdAt) return false;
    const addedTime = new Date(createdAt).getTime();
    if (isNaN(addedTime)) return false;
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    return (Date.now() - addedTime) < TWO_DAYS_MS;
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
let wishlistTitles = new Set(); // Общий список вишлиста "Будем смотреть"
let ratingsData = {}; // Оценки: { "Название (год)": [{ username, score, userId }, ...] }
let history = [];
let realtimeChannel = null; // Канал для мгновенных обновлений

// Текущие фильтры поиска
let searchFilters = { category: "", genre: "", year: "", hasRating: "", minStars: "" };
let lastSearchQuery = ""; // Запоминаем последний текстовый запрос, чтобы показывать его в строке поиска на экране результатов

// Состояние чата
let chatMessages = [];
let isChatScreenOpen = false;
let chatPollInterval = null;

// Переменная, хранящая название текущей открытой категории первого уровня ("🎥 Фильмы" и т.д.)
let currentCategoryName = null; 

// ==========================================
// РЕЗЕРВНОЕ КОПИРОВАНИЕ СЕССИИ (COOKIE BACKUP)
// ==========================================
function saveSessionBackup(session) {
    if (session) {
        const data = JSON.stringify({
            access_token: session.access_token,
            refresh_token: session.refresh_token
        });
        document.cookie = "sb_session_backup=" + encodeURIComponent(data) + "; max-age=31536000; path=/; SameSite=Lax; Secure";
    } else {
        document.cookie = "sb_session_backup=; max-age=0; path=/; SameSite=Lax; Secure";
    }
}

async function tryRestoreSession() {
    try {
        const matches = document.cookie.match(new RegExp("(?:^|; )" + "sb_session_backup".replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + "=([^;]*)"));
        if (matches) {
            const backupData = JSON.parse(decodeURIComponent(matches[1]));
            if (backupData && backupData.refresh_token) {
                console.log("Найдена резервная сессия, восстанавливаем...");
                const { data, error } = await db.auth.setSession({
                    access_token: backupData.access_token,
                    refresh_token: backupData.refresh_token
                });
                if (!error && data.session) {
                    currentUser = data.session.user;
                    saveSessionBackup(data.session);
                    return true;
                }
            }
        }
    } catch (e) {
        console.error("Не удалось восстановить сессию из бэкапа:", e);
    }
    return false;
}

// Настоящий выход из аккаунта. Важно чистить резервную копию сессии
// (cookie) ДО вызова signOut() — иначе обработчик события SIGNED_OUT
// тут же находит валидный бэкап в cookie и восстанавливает сессию
// обратно, и кнопка "Выход" фактически ничего не делает.
async function performLogout() {
    saveSessionBackup(null);
    await db.auth.signOut();
}

// Флаг, который покажет, загрузилось ли приложение в первый раз
let isAppInitialized = false;

// Слушатель событий авторизации
db.auth.onAuthStateChange(async (event, session) => {
    // Supabase сам слушает возврат фокуса на вкладку / разблокировку экрана
    // и переотправляет события авторизации (TOKEN_REFRESHED, повторный SIGNED_IN
    // и т.п.), хотя пользователь на самом деле никуда не уходил.
    // Если это тот же пользователь и приложение уже открыто — просто тихо
    // обновляем токен в фоне и НЕ трогаем текущий экран.
    if (session && isAppInitialized && currentUser && currentUser.id === session.user.id) {
        currentUser = session.user;
        saveSessionBackup(session);
        return;
    }

    if (session) {
        currentUser = session.user;
        saveSessionBackup(session); // Бэкапим сессию

        // Важно: помечаем инициализацию начатой СРАЗУ, синхронно, а не после
        // загрузки данных. Иначе при первой загрузке страницы Supabase иногда
        // присылает два события авторизации подряд (например INITIAL_SESSION
        // и SIGNED_IN), и пока флаг ещё не выставлен, второе событие успевает
        // запустить showHome() повторно — из-за этого один раз "моргает"
        // при самом первом открытии страницы.
        const wasAlreadyInitialized = isAppInitialized;
        isAppInitialized = true;
        
        // Загружаем списки просмотренного, вишлиста и оценок одним запросом
        loadUserDataFromDB().then(() => {
            subscribeToChanges(); 
            
            if (!wasAlreadyInitialized) {
                showHome();
            } else {
                refreshCurrentScreen();
            }
        });
    } else {
        // Пробуем восстановить из бэкапа перед тем как выкинуть
        const restored = await tryRestoreSession();
        if (restored) return;

        currentUser = null;
        watchedTitles.clear();
        wishlistTitles.clear();
        ratingsData = {};
        chatMessages = [];
        isChatScreenOpen = false;
        isAppInitialized = false;
        saveSessionBackup(null);
        
        if (realtimeChannel) {
            db.removeChannel(realtimeChannel);
            realtimeChannel = null;
        }
        showLoginScreen();
    }
});

// ==========================================
// СТРАХОВКА ОТ ПУСТОЙ СТРАНИЦЫ
// ==========================================
// Обычно onAuthStateChange сам вызывает showHome() или showLoginScreen()
// при загрузке страницы. Но если у Supabase не получается обновить
// протухший refresh-токен (см. ошибку 400 на .../auth/v1/token в консоли),
// в части случаев событие авторизации не приходит вообще — и страница
// остаётся пустой навсегда, потому что её просто некому отрисовать.
// Явно запрашиваем сессию сами и, если через 2 секунды приложение всё
// ещё не проинициализировано, принудительно показываем экран входа.
(async function bootstrapAuthWatchdog() {
    try {
        const { data, error } = await db.auth.getSession();
        if (error) {
            console.error("Ошибка получения сессии при загрузке:", error);
        }
        if (!data || !data.session) {
            // Сессии нет — пробуем восстановиться из резервной копии,
            // а если не выйдет, showLoginScreen() внутри onAuthStateChange
            // должен был сработать сам. На всякий случай подстрахуемся ниже.
        }
    } catch (e) {
        console.error("Критическая ошибка при получении сессии:", e);
    }

    setTimeout(() => {
        if (!isAppInitialized && app && !app.innerHTML.trim()) {
            console.warn("Событие авторизации не пришло вовремя — показываем экран входа принудительно.");
            showLoginScreen();
        }
    }, 2000);
})();

// Ловим необработанные ошибки (например, из фонового обновления токена),
// чтобы они не оставляли страницу пустой без объяснений
window.addEventListener("unhandledrejection", (event) => {
    console.error("Необработанная ошибка:", event.reason);
    if (!isAppInitialized && app && !app.innerHTML.trim()) {
        showLoginScreen();
    }
});

// Загрузка просмотренных тайтлов
async function loadWatchedFromDB() {
    if (!currentUser) return;
    const { data, error } = await db.from('watched_items').select('title');
    if (error) {
        console.error("Ошибка при загрузке списка просмотренного:", error);
        return;
    }
    watchedTitles = new Set(data.map(item => item.title));
}

// Загрузка вишлиста
async function loadWishlistFromDB() {
    if (!currentUser) return;
    const { data, error } = await db.from('wishlist_items').select('title');
    if (error) {
        console.error("Ошибка при загрузке вишлиста:", error);
        return;
    }
    wishlistTitles = new Set(data.map(item => item.title));
}

// Проверка: относится ли категория к "секретным" (исключаются из фильтров и поиска)
function isSecretCategory(catKey) {
    return catKey.includes("Секрет") || catKey.includes("🔒") || catKey.includes("❤️");
}

// Загрузка оценок (видны обе оценки — и Asmoday, и Myakish)
async function loadRatingsFromDB() {
    const { data, error } = await db.from('ratings').select('title, username, score, user_id');
    if (error) {
        console.error("Ошибка при загрузке оценок:", error);
        return;
    }
    const temp = {};
    data.forEach(r => {
        if (!temp[r.title]) temp[r.title] = [];
        temp[r.title].push({ username: r.username, score: r.score, userId: r.user_id });
    });
    ratingsData = temp;
}

// Загружает watched/wishlist/ratings ОДНИМ запросом через SQL-функцию
// get_watched_wishlist_ratings (нужно один раз создать её в Supabase, см.
// инструкцию). Если функции ещё нет (или запрос упал) — тихо откатываемся
// на прежний способ из трёх параллельных запросов, чтобы ничего не сломалось.
async function loadUserDataFromDB() {
    if (!currentUser) return;
    try {
        const { data, error } = await db.rpc('get_watched_wishlist_ratings');
        if (error) throw error;

        watchedTitles = new Set(data.watched || []);
        wishlistTitles = new Set(data.wishlist || []);

        const temp = {};
        (data.ratings || []).forEach(r => {
            if (!temp[r.title]) temp[r.title] = [];
            temp[r.title].push({ username: r.username, score: r.score, userId: r.user_id });
        });
        ratingsData = temp;
    } catch (e) {
        await Promise.all([loadWatchedFromDB(), loadWishlistFromDB(), loadRatingsFromDB()]);
    }
}

// В системе всего 2 пользователя — сопоставляем email с красивым именем
function getUsernameFromEmail(email) {
    if (email === "nowyouseemeinvi@gmail.com") return "Myakish";
    if (email === "unknownqsrll@gmail.com") return "Asmoday";
    return email || "Аноним";
}

// Считает среднюю оценку (среднее арифметическое) по тайтлу
function getAverageRating(title) {
    const ratings = ratingsData[title];
    if (!ratings || ratings.length === 0) return null;
    const sum = ratings.reduce((acc, r) => acc + r.score, 0);
    const avg = sum / ratings.length;
    // Показываем без .0, если оценка целая, иначе с одним знаком после запятой
    return Number.isInteger(avg) ? String(avg) : avg.toFixed(1);
}

// Форматирует строку с оценками для отображения под тайтлом
function formatRatings(title) {
    const ratings = ratingsData[title];
    if (!ratings || ratings.length === 0) return "";
    const sorted = [...ratings].sort((a, b) => a.username.localeCompare(b.username));
    let result = "⭐ " + sorted.map(r => `${r.username}: ${r.score}/10`).join("   •   ");
    if (ratings.length > 1) {
        result += `   •   Среднее ${getAverageRating(title)}`;
    }
    return result;
}

// Лёгкое обновление только блоков с оценками (без полной перерисовки экрана)
async function refreshRatingsUI() {
    await loadRatingsFromDB();
    document.querySelectorAll(".movie-item").forEach(wrapper => {
        let itemDiv = wrapper.querySelector(".item");
        let ratingsDiv = wrapper.querySelector(".item-ratings");
        if (itemDiv && ratingsDiv) {
            ratingsDiv.textContent = formatRatings(itemDiv.textContent.trim());
        }
    });
}

// Подписка на изменения базы данных в реальном времени (Websockets)
function subscribeToChanges() {
    if (realtimeChannel) return; 

    realtimeChannel = db
        .channel('schema-db-changes')
        // Следим за просмотренными
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'watched_items' },
            () => { updateUIOnLiveChange(); }
        )
        // Следим за вишлистом
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'wishlist_items' },
            () => { updateUIOnLiveChange(); }
        )
        // Следим за оценками
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'ratings' },
            () => { updateUIOnLiveChange(); }
        )
        // Следим за чатом (отдельно от каталога, поиск это не затрагивает)
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'chat_messages' },
            (payload) => {
                onChatRealtimeChange();
            }
        )
        .subscribe();
}

// Живое обновление интерфейса
async function updateUIOnLiveChange() {
    // Изменения в watched_items/wishlist_items/ratings не затрагивают сам каталог
    // (таблицу titles) — раньше здесь зря перезагружался ВЕСЬ каталог при
    // каждом таком изменении. Загружаем только то, что реально изменилось.
    await loadUserDataFromDB();

    // 1. Обновляем счетчики на кнопках главного экрана
    let buttons = document.querySelectorAll("button");
    buttons.forEach(btn => {
        if (btn.textContent.includes("Просмотрено")) {
            btn.textContent = "🎬 Просмотрено (" + watchedTitles.size + ")";
        }
        if (btn.textContent.includes("Будем смотреть")) {
            btn.textContent = "🍿 Будем смотреть (" + wishlistTitles.size + ")";
        }
    });

    // 2. Обновляем иконки звездочек и оценки
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

            // Очищаем классы перед переназначением
            watchBtn.className = "btn-watch";

            if (watchedTitles.has(lookupText)) {
                watchBtn.classList.add("watched");
                watchBtn.textContent = "★";
            } else if (wishlistTitles.has(lookupText)) {
                watchBtn.classList.add("wishlist-active");
                watchBtn.textContent = "★";
            } else {
                watchBtn.textContent = "☆";
            }
        }
    });

    // 3. Обновляем блоки с оценками
    document.querySelectorAll(".movie-item").forEach(wrapper => {
        let itemDiv = wrapper.querySelector(".item");
        let ratingsDiv = wrapper.querySelector(".item-ratings");
        if (itemDiv && ratingsDiv) {
            ratingsDiv.textContent = formatRatings(itemDiv.textContent.trim());
        }
    });
}

// Мягкое обновление текущего экрана
async function refreshCurrentScreen() {
    await loadCatalogFromDB();
    if (history.length > 0) {
        let currentActiveData = history[history.length - 1];
        openData(currentActiveData, false); 
    } else {
        showHome();
    }
}

// =======================================================
// НОВАЯ ЛОГИКА КЛИКА ПО ЗВЕЗДОЧКЕ (ВЫБОР КАТЕГОРИИ, ОЦЕНКА ИЛИ СНЯТИЕ)
// =======================================================
async function handleStarClick(title) {
    if (!currentUser) return;
    showStarChoiceModal(title);
}

// Модальное окно выбора действия для звёздочки
function showStarChoiceModal(title) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "starChoiceModal";

    const isWatched = watchedTitles.has(title);
    const isWishlisted = wishlistTitles.has(title);

    let optionsHtml = "";
    if (isWatched) {
        optionsHtml += `<button id="choiceRemove" class="btn-pink-style">❌ Убрать из просмотренного</button>`;
    } else if (isWishlisted) {
        optionsHtml += `<button id="choiceRemove" class="btn-pink-style">❌ Убрать из вишлиста</button>`;
    } else {
        optionsHtml += `<button id="choiceWish" class="btn-pink-style">🍿 Будем смотреть</button>`;
        optionsHtml += `<button id="choiceWatch" class="btn-pink-style">🎬 Просмотрено</button>`;
    }
    optionsHtml += `<button id="choiceRate" class="btn-pink-style">⭐ Оценить</button>`;
    optionsHtml += `<button id="choiceCancel" class="btn-cancel-gray">Отмена</button>`;

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 10px;">Действие</h3>
            <p style="color: #666; margin-bottom: 20px; font-size: 14px;">"${title.replace(/\s*\(\d{4}\)$/, "")}"</p>
            <div class="action-buttons" style="display: flex; flex-direction: column; gap: 10px;">
                ${optionsHtml}
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const removeBtn = document.getElementById("choiceRemove");
    if (removeBtn) {
        removeBtn.onclick = async () => {
            overlay.remove();
            if (isWatched) {
                watchedTitles.delete(title);
                updateUIOnLiveChange();
                await db.from('watched_items').delete().eq('title', title).eq('user_id', currentUser.id);
            } else if (isWishlisted) {
                wishlistTitles.delete(title);
                updateUIOnLiveChange();
                await db.from('wishlist_items').delete().eq('title', title).eq('user_id', currentUser.id);
            }
        };
    }

    const wishBtn = document.getElementById("choiceWish");
    if (wishBtn) {
        wishBtn.onclick = async () => {
            overlay.remove();
            wishlistTitles.add(title);
            updateUIOnLiveChange();
            const { error } = await db.from('wishlist_items').insert([{ user_id: currentUser.id, title: title }]);
            if (error) {
                wishlistTitles.delete(title);
                updateUIOnLiveChange();
                console.error("Ошибка при сохранении в вишлист:", error);
            }
        };
    }

    const watchBtnEl = document.getElementById("choiceWatch");
    if (watchBtnEl) {
        watchBtnEl.onclick = async () => {
            overlay.remove();
            watchedTitles.add(title);
            updateUIOnLiveChange();
            const { error } = await db.from('watched_items').insert([{ user_id: currentUser.id, title: title }]);
            if (error) {
                watchedTitles.delete(title);
                updateUIOnLiveChange();
                console.error("Ошибка при сохранении в просмотренное:", error);
            }
        };
    }

    document.getElementById("choiceRate").onclick = () => {
        overlay.remove();
        showRatingModal(title);
    };

    document.getElementById("choiceCancel").onclick = () => {
        overlay.remove();
    };
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

// Собирает доступные варианты для фильтров (категории/жанры/года), исключая "Секрет"
function collectFilterOptions() {
    const categories = [];
    const genres = new Set();
    const years = new Set();

    const collectYear = (fullTitle) => {
        const m = fullTitle.match(/\((\d{4})\)$/);
        if (m) years.add(m[1]);
    };

    for (let catKey in dbData) {
        if (isSecretCategory(catKey)) continue;
        categories.push(catKey);

        const categoryData = dbData[catKey];
        for (let genreKey in categoryData) {
            genres.add(genreKey);
            const listOrObj = categoryData[genreKey];

            if (Array.isArray(listOrObj)) {
                listOrObj.forEach(item => {
                    if (typeof item === 'string') {
                        collectYear(item);
                    } else if (typeof item === 'object' && item !== null) {
                        for (let franchiseName in item) {
                            item[franchiseName].forEach(t => collectYear(t));
                        }
                    }
                });
            }
        }
    }

    return {
        categories,
        genres: Array.from(genres).sort(),
        years: Array.from(years).sort((a, b) => b.localeCompare(a))
    };
}

// Есть ли активные (не пустые) фильтры
function hasActiveFilters(filters) {
    return !!(filters.category || filters.genre || filters.year || filters.hasRating || filters.minStars);
}

// Короткое текстовое описание примененных фильтров (для заголовка результатов)
function buildFilterSummary(filters) {
    const parts = [];
    if (filters.category) parts.push(filters.category);
    if (filters.genre) parts.push(filters.genre);
    if (filters.year) parts.push(filters.year);
    if (filters.hasRating === "yes") parts.push("с оценкой");
    if (filters.hasRating === "no") parts.push("без оценки");
    if (filters.minStars) parts.push(`от ${filters.minStars}★`);
    return parts.join(", ");
}

// Строит панель поиска (поле ввода + кнопка поиска + кнопка фильтров).
// Вынесена в отдельную функцию, чтобы её можно было показывать не только
// на главной, но и на экране результатов поиска — тогда можно искать
// дальше, не возвращаясь на главную страницу.
function buildSearchBar(prefillQuery = "") {
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
    searchInput.placeholder = "Поиск...";
    searchInput.value = prefillQuery;
    searchInput.style.cssText = `
        flex-grow: 1;
        min-width: 0;
        padding: 10px 12px;
        border: 1px solid #ccc;
        border-radius: 8px;
        font-size: 18px;
        font-weight: 600;
        font-family: "Segoe UI", Arial, sans-serif;
        color: #9b4f70;
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
        background: #f5f5f5 !important;
        border: 1px solid #ddd !important;
        cursor: pointer;
        font-size: 16px;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-shrink: 0;
    `;

    let filterBtn = document.createElement("button");
    filterBtn.id = "searchFilterBtn";
    filterBtn.textContent = "⚙️";
    filterBtn.style.cssText = `
        width: 42px !important;
        height: 42px !important;
        padding: 0 !important;
        margin: 0 !important;
        border-radius: 8px !important;
        background: ${hasActiveFilters(searchFilters) ? "#ffe3ec" : "#f5f5f5"} !important;
        border: 1px solid ${hasActiveFilters(searchFilters) ? "#f48fb1" : "#ddd"} !important;
        cursor: pointer;
        font-size: 16px;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-shrink: 0;
    `;

    const doSearch = () => {
        const q = searchInput.value;
        if (q.trim() || hasActiveFilters(searchFilters)) {
            performCatalogSearch(q, searchFilters);
        }
    };

    // Применение/сброс фильтров в модалке больше НЕ запускает поиск сам по
    // себе — только сохраняет выбор и подсвечивает кнопку ⚙️. Сам поиск
    // (по тексту, по фильтрам, или по тому и другому вместе — это уже
    // учтено внутри performCatalogSearch) запускается только кнопкой 🔍
    // или клавишей Enter.
    const refreshFilterButtonAppearance = () => {
        const active = hasActiveFilters(searchFilters);
        filterBtn.style.setProperty("background", active ? "#ffe3ec" : "#f5f5f5", "important");
        filterBtn.style.setProperty("border", "1px solid " + (active ? "#f48fb1" : "#ddd"), "important");
    };

    filterBtn.onclick = () => showFilterModal(refreshFilterButtonAppearance);

    searchSubmitBtn.onclick = doSearch;
    searchInput.onkeydown = (e) => {
        if (e.key === "Enter") {
            doSearch();
        }
    };

    searchContainer.appendChild(searchInput);
    searchContainer.appendChild(searchSubmitBtn);
    searchContainer.appendChild(filterBtn);
    return searchContainer;
}

function performCatalogSearch(query, filters = {}) {
    const searchStr = (query || "").toLowerCase().trim();
    const hasQuery = searchStr.length > 0;
    lastSearchQuery = query || "";

    if (!hasQuery && !hasActiveFilters(filters)) return;

    const results = [];
    
    for (let catKey in dbData) {
        if (isSecretCategory(catKey)) {
            continue;
        }
        if (filters.category && filters.category !== catKey) continue;

        const categoryData = dbData[catKey];
        for (let genreKey in categoryData) {
            if (filters.genre && filters.genre !== genreKey) continue;

            const listOrObj = categoryData[genreKey];

            const processTitle = (fullTitle, franchiseName = null) => {
                // Фильтр по году
                if (filters.year) {
                    const m = fullTitle.match(/\((\d{4})\)$/);
                    const year = m ? m[1] : null;
                    if (year !== filters.year) return;
                }

                // Фильтр по наличию/отсутствию оценки и по минимальному количеству звёзд
                const ratings = ratingsData[fullTitle] || [];
                if (filters.hasRating === "yes" && ratings.length === 0) return;
                if (filters.hasRating === "no" && ratings.length > 0) return;
                if (filters.minStars) {
                    const minStarsNum = parseInt(filters.minStars, 10);
                    const avg = getAverageRating(fullTitle);
                    const qualifies = avg !== null && parseFloat(avg) >= minStarsNum;
                    if (!qualifies) return;
                }

                // Если текстового запроса нет — фильтров уже достаточно, добавляем как есть
                if (!hasQuery) {
                    results.push({ title: fullTitle, score: 0 });
                    return;
                }

                const cleanTitle = fullTitle.replace(/\s*\(\d{4}\)$/, "").toLowerCase();
                
                if (cleanTitle.includes(searchStr) || 
                    (franchiseName && franchiseName.toLowerCase().includes(searchStr)) ||
                    genreKey.toLowerCase().includes(searchStr)) {
                    results.push({ title: fullTitle, score: 0 });
                    return;
                }

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

    results.sort((a, b) => a.score - b.score);

    const uniqueResults = [];
    const seen = new Set();
    results.forEach(r => {
        if (!seen.has(r.title)) {
            seen.add(r.title);
            uniqueResults.push(r.title);
        }
    });

    const filterSummary = buildFilterSummary(filters);
    let displayTitle;
    if (hasQuery && filterSummary) {
        displayTitle = `Результаты для: "${query}" (${filterSummary})`;
    } else if (hasQuery) {
        displayTitle = `Результаты для: "${query}"`;
    } else {
        displayTitle = `🔍 Фильтр: ${filterSummary}`;
    }

    currentCategoryName = "🔍 Результаты поиска";
    openData(uniqueResults, true, displayTitle);
}

// Модальное окно фильтров поиска (кнопка-шестерёнка)
function showFilterModal(onFiltersChanged) {
    const options = collectFilterOptions();

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "filterModal";

    const categoryOptionsHtml = options.categories
        .map(c => `<option value="${c}" ${searchFilters.category === c ? "selected" : ""}>${c}</option>`)
        .join("");

    const genreOptionsHtml = options.genres
        .map(g => `<option value="${g}" ${searchFilters.genre === g ? "selected" : ""}>${g}</option>`)
        .join("");

    const yearOptionsHtml = options.years
        .map(y => `<option value="${y}" ${searchFilters.year === y ? "selected" : ""}>${y}</option>`)
        .join("");

    let starOptionsHtml = "";
    for (let i = 1; i <= 10; i++) {
        starOptionsHtml += `<option value="${i}" ${searchFilters.minStars === String(i) ? "selected" : ""}>от ${i}★ и выше</option>`;
    }

    overlay.innerHTML = `
        <div class="modal-content">
            <h3>⚙️ Фильтры поиска</h3>
            <form class="modal-form" id="filterForm">
                <label>Категория</label>
                <select id="fCategory">
                    <option value="">Все категории</option>
                    ${categoryOptionsHtml}
                </select>

                <label>Жанр</label>
                <select id="fGenre">
                    <option value="">Все жанры</option>
                    ${genreOptionsHtml}
                </select>

                <label>Год</label>
                <select id="fYear">
                    <option value="">Любой год</option>
                    ${yearOptionsHtml}
                </select>

                <label>Оценка</label>
                <select id="fHasRating">
                    <option value="" ${searchFilters.hasRating === "" ? "selected" : ""}>Любая</option>
                    <option value="yes" ${searchFilters.hasRating === "yes" ? "selected" : ""}>Есть оценка</option>
                    <option value="no" ${searchFilters.hasRating === "no" ? "selected" : ""}>Нет оценки</option>
                </select>

                <label>Количество звёзд</label>
                <select id="fMinStars">
                    <option value="" ${searchFilters.minStars === "" ? "selected" : ""}>Любое</option>
                    ${starOptionsHtml}
                </select>

                <div class="modal-buttons">
                    <button type="submit" class="btn-save">Применить</button>
                    <button type="button" class="btn-cancel" id="fReset">Сбросить</button>
                </div>
            </form>
            <div class="action-buttons" style="margin-top: 12px;">
                <button type="button" class="btn-action-cancel" id="fClose">Закрыть</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById("fClose").onclick = () => overlay.remove();

    document.getElementById("fReset").onclick = () => {
        searchFilters = { category: "", genre: "", year: "", hasRating: "", minStars: "" };
        overlay.remove();
        onFiltersChanged();
    };

    document.getElementById("filterForm").onsubmit = (e) => {
        e.preventDefault();
        searchFilters = {
            category: document.getElementById("fCategory").value,
            genre: document.getElementById("fGenre").value,
            year: document.getElementById("fYear").value,
            hasRating: document.getElementById("fHasRating").value,
            minStars: document.getElementById("fMinStars").value
        };
        overlay.remove();
        onFiltersChanged();
    };
}

// Главная страница
async function showHome() {
    startTransitionLock();
    isChatScreenOpen = false;
    if (chatPollInterval) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
    }
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

        header.innerHTML = `<span id="userEmailSpan" style="font-size: 14px;">${getUsernameFromEmail(currentUser.email)}</span>`;
        
        let controls = document.createElement("div");
        controls.style.display = "flex";
        controls.style.alignItems = "center";
        controls.style.gap = "10px";

        let musicBtn = createIconButton(isMusicPlaying ? "🔊" : "🔇", () => {
            const audio = document.getElementById("bgMusic");
            if (audio.paused) { audio.play(); isMusicPlaying = true; localStorage.setItem("musicEnabled", "true"); musicBtn.textContent = "🔊"; }
            else { audio.pause(); isMusicPlaying = false; localStorage.setItem("musicEnabled", "false"); musicBtn.textContent = "🔇"; }
        });

        let logoutBtn = createIconButton("❌", performLogout);

        controls.appendChild(musicBtn);
        controls.appendChild(logoutBtn);
        header.appendChild(controls);
        app.appendChild(header);
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
        addBtn.style.marginBottom = "10px";
        addBtn.onclick = () => showAddEditModal();
        app.appendChild(addBtn);
        
        // Первый сплиттер HR (после "Добавить")
        let hr = document.createElement("hr");
        hr.style.border = "0";
        hr.style.borderTop = "2px solid #9b4f70"; 
        hr.style.margin = "15px 0";
        app.appendChild(hr);

        // ПОИСК РАСПОЛАГАЕТСЯ ЗДЕСЬ
        app.appendChild(buildSearchBar());

        // Второй сплиттер HR (после Поиска)
        let hrAfterSearch = document.createElement("hr");
        hrAfterSearch.style.border = "0";
        hrAfterSearch.style.borderTop = "2px solid #9b4f70"; 
        hrAfterSearch.style.margin = "15px 0 20px 0";
        app.appendChild(hrAfterSearch);
    }

    // Рендерим кнопки категорий
    let secretDividerAdded = false;
    for (let key in dbData) {
        // Разделитель ПЕРЕД секретной категорией (например между "Сериалы" и "Секрет")
        const isSecretKey = key.includes("Секрет") || key.includes("🔒") || key.includes("❤️");
        if (isSecretKey && !secretDividerAdded) {
            let hrBeforeSecret = document.createElement("hr");
            hrBeforeSecret.style.border = "0";
            hrBeforeSecret.style.borderTop = "2px solid #9b4f70";
            hrBeforeSecret.style.margin = "15px 0";
            app.appendChild(hrBeforeSecret);
            secretDividerAdded = true;
        }

        let button = document.createElement("button");
        button.textContent = key;
        if (isSecretKey) {
            button.classList.add("btn-secret-gold");
        }
        button.onclick = () => { currentCategoryName = key; openData(dbData[key], true); };
        app.appendChild(button);

        // Третий сплиттер HR (после категории "Секрет")
        if (isSecretKey) {
            let hrAfterSecret = document.createElement("hr");
            hrAfterSecret.style.border = "0";
            hrAfterSecret.style.borderTop = "2px solid #9b4f70"; 
            hrAfterSecret.style.margin = "15px 0";
            app.appendChild(hrAfterSecret);
        }
    }

    let wishlistBtn = document.createElement("button");
    wishlistBtn.className = "btn-pink-style";
    wishlistBtn.textContent = "🍿 Будем смотреть (" + wishlistTitles.size + ")";
    wishlistBtn.onclick = () => {
        const list = Array.from(wishlistTitles);
        currentCategoryName = "🍿 Будем смотреть";
        openData(list, true, "🍿 Будем смотреть");
    };
    app.appendChild(wishlistBtn);

    // Кнопка "Просмотрено" на главной
    let watchedBtn = document.createElement("button");
    watchedBtn.className = "btn-pink-style";
    watchedBtn.textContent = "🎬 Просмотрено (" + watchedTitles.size + ")";
    watchedBtn.onclick = () => {
        const list = Array.from(watchedTitles);
        currentCategoryName = "🎬 Просмотрено";
        openData(list, true, "🎬 Просмотрено");
    };
    app.appendChild(watchedBtn);

    if (currentUser) {
        let hrBeforeChat = document.createElement("hr");
        hrBeforeChat.style.border = "0";
        hrBeforeChat.style.borderTop = "2px solid #9b4f70";
        hrBeforeChat.style.margin = "20px 0";
        app.appendChild(hrBeforeChat);

        let chatBtn = document.createElement("button");
        chatBtn.className = "btn-chat-purple";
        chatBtn.textContent = "💬 Чат";
        chatBtn.onclick = () => showChatScreen();
        app.appendChild(chatBtn);
    }

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
    let wrapper = document.createElement("div");
    wrapper.className = "movie-item";

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
        let titleSpan = document.createElement("span");
        titleSpan.textContent = itemText;
        itemDiv.appendChild(titleSpan);

        if (isRecentlyAdded(itemText)) {
            itemDiv.style.display = "flex";
            itemDiv.style.justifyContent = "space-between";
            itemDiv.style.alignItems = "center";
            itemDiv.style.gap = "8px";

            let newDot = document.createElement("span");
            newDot.className = "new-title-dot";
            newDot.title = "Добавлено недавно";
            itemDiv.appendChild(newDot);
        }

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
        
        // Установка правильного состояния звездочки на старте
        if (watchedTitles.has(itemText)) {
            watchBtn.classList.add("watched");
            watchBtn.textContent = "★";
        } else if (wishlistTitles.has(itemText)) {
            watchBtn.classList.add("wishlist-active");
            watchBtn.textContent = "★";
        } else {
            watchBtn.textContent = "☆";
        }
        
        watchBtn.onclick = () => handleStarClick(itemText);
        row.appendChild(watchBtn);
    }

    wrapper.appendChild(row);

    if (!isSecret) {
        let ratingsDiv = document.createElement("div");
        ratingsDiv.className = "item-ratings";
        ratingsDiv.textContent = formatRatings(itemText);
        wrapper.appendChild(ratingsDiv);
    }

    container.appendChild(wrapper);
}

// Всплывающее меню выбора действия
// Ищет постер тайтла на TMDB (сначала как фильм, потом как сериал)
async function fetchTmdbPoster(itemText) {
    if (!TMDB_API_KEY || TMDB_API_KEY.includes("ВСТАВЬТЕ")) return null;

    const match = itemText.match(/^(.*)\s\((\d{4})\)$/);
    const title = match ? match[1] : itemText;
    const year = match ? match[2] : null;

    try {
        const movieParams = new URLSearchParams({ api_key: TMDB_API_KEY, query: title, language: "ru-RU" });
        if (year) movieParams.set("year", year);
        let res = await fetch(`https://api.themoviedb.org/3/search/movie?${movieParams.toString()}`);
        let json = await res.json();
        let result = json.results && json.results[0];

        if (!result) {
            const tvParams = new URLSearchParams({ api_key: TMDB_API_KEY, query: title, language: "ru-RU" });
            if (year) tvParams.set("first_air_date_year", year);
            res = await fetch(`https://api.themoviedb.org/3/search/tv?${tvParams.toString()}`);
            json = await res.json();
            result = json.results && json.results[0];
        }

        if (result && result.poster_path) {
            return TMDB_IMG_BASE + result.poster_path;
        }
        return null;
    } catch (e) {
        console.error("Ошибка при запросе постера с TMDB:", e);
        return null;
    }
}

// ==========================================
// СТИКЕРЫ ЧАТА
// ==========================================
let cachedStickerList = null; // кэшируем на время сессии, чтобы не дергать GitHub API каждый раз

// Загружает список файлов-стикеров из папки stickers в GitHub-репозитории
async function fetchStickerList() {
    if (cachedStickerList) return cachedStickerList;

    try {
        const apiUrl = `https://api.github.com/repos/${GITHUB_STICKERS_OWNER}/${GITHUB_STICKERS_REPO}/contents/${GITHUB_STICKERS_PATH}?ref=${GITHUB_STICKERS_BRANCH}`;
        const res = await fetch(apiUrl);
        if (!res.ok) throw new Error("GitHub API вернул статус " + res.status);
        const json = await res.json();
        if (!Array.isArray(json)) return [];

        const imageExtRe = /\.(png|jpe?g|gif|webp)$/i;
        cachedStickerList = json
            .filter(f => f.type === "file" && imageExtRe.test(f.name))
            .map(f => ({
                name: f.name,
                url: `https://raw.githubusercontent.com/${GITHUB_STICKERS_OWNER}/${GITHUB_STICKERS_REPO}/${GITHUB_STICKERS_BRANCH}/${GITHUB_STICKERS_PATH}/${f.name}`
            }));

        return cachedStickerList;
    } catch (e) {
        console.error("Ошибка при загрузке списка стикеров с GitHub:", e);
        return [];
    }
}

// Проверяет, является ли текст сообщения стикером
function isStickerMessage(messageText) {
    return typeof messageText === "string" && messageText.startsWith(STICKER_PREFIX);
}

// Достает URL картинки стикера из текста сообщения
function getStickerUrl(messageText) {
    return messageText.slice(STICKER_PREFIX.length);
}

// Модалка выбора стикера
function showStickerPicker(onPick) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "stickerPickerModal";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    overlay.innerHTML = `
        <div class="modal-content" style="max-height:70vh; overflow-y:auto;">
            <h3 style="text-align:center; margin-bottom:15px;">😊 Стикеры</h3>
            <div class="sticker-grid" id="stickerGrid">
                <p style="text-align:center;color:#999;font-size:13px;">Загружаем стикеры...</p>
            </div>
            <button class="btn-action-cancel" id="stickerPickerCancel" style="margin-top:15px;width:100%;">Закрыть</button>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("stickerPickerCancel").onclick = () => overlay.remove();

    fetchStickerList().then(list => {
        const grid = document.getElementById("stickerGrid");
        if (!grid) return; // модалку уже закрыли, пока грузились стикеры

        if (list.length === 0) {
            grid.innerHTML = `<p style="text-align:center;color:#999;font-size:13px;">Стикеры не найдены. Проверьте настройки GITHUB_STICKERS_* в script.js</p>`;
            return;
        }

        grid.innerHTML = "";
        list.forEach(sticker => {
            const img = document.createElement("img");
            img.src = sticker.url;
            img.alt = sticker.name;
            img.loading = "lazy";
            img.className = "sticker-thumb";
            img.onclick = () => {
                overlay.remove();
                onPick(sticker.url);
            };
            grid.appendChild(img);
        });
    });
}

function showActionMenu(itemText) {
    if (itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал")) return;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "actionMenuModal";

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 10px;" id="menuTitle"></h3>
            <div id="posterBox" style="margin: 10px 0 15px; display: flex; justify-content: center;">
                <p style="color: #999; font-size: 13px;">Ищем постер...</p>
            </div>
            <p style="color: #666; margin-bottom: 20px; font-size: 14px;">Выберите действие для этого тайтла:</p>
            <div class="action-buttons" style="display: flex; flex-direction: column; gap: 10px;">
                <button class="btn-pink-style" id="actTrailer">🎬 Трейлер на YouTube</button>
                <button class="btn-pink-style" id="actEdit">✏️ Редактировать</button>
                <button class="btn-pink-style" id="actDelete">❌ Удалить из базы</button>
                <button class="btn-cancel-gray" id="actCancel">Отмена</button>
            </div>
        </div>
    `;

    overlay.querySelector("#menuTitle").textContent = itemText;
    document.body.appendChild(overlay);

    // Подгружаем постер асинхронно, не блокируя открытие меню
    const posterBox = overlay.querySelector("#posterBox");
    fetchTmdbPoster(itemText).then(url => {
        if (!overlay.isConnected) return; // меню уже закрыли
        if (url) {
            posterBox.innerHTML = `<img src="${url}" alt="Постер" style="max-width: 160px; border-radius: 12px; box-shadow: 0 6px 18px rgba(180,80,120,0.25);">`;
        } else {
            posterBox.innerHTML = `<p style="color: #999; font-size: 13px;">Постер к фильму не найден</p>`;
        }
    });

    // Логика кнопки трейлера
    document.getElementById("actTrailer").onclick = () => {
        overlay.remove();
        const query = encodeURIComponent(itemText + " трейлер");
        window.open(`https://www.youtube.com/results?search_query=${query}`, "_blank");
    };

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

// Модальное окно выставления/изменения/удаления оценки (10 кликабельных звёзд)
function showRatingModal(itemText) {
    if (!currentUser) return;

    const myUsername = getUsernameFromEmail(currentUser.email);
    const existing = (ratingsData[itemText] || []).find(r => r.userId === currentUser.id);
    const currentScore = existing ? existing.score : 0;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "ratingModal";

    let starsHtml = "";
    for (let i = 1; i <= 10; i++) {
        starsHtml += `<span class="rating-star${i <= currentScore ? " filled" : ""}" data-value="${i}">★</span>`;
    }

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 10px;">Оценка (${myUsername})</h3>
            <p style="color: #666; margin-bottom: 15px; font-size: 14px;">"${itemText.replace(/\s*\(\d{4}\)$/, "")}"</p>
            <div class="rating-stars" id="ratingStars">${starsHtml}</div>
            <p id="ratingValueLabel" style="color: #9b4f70; font-weight: bold; margin: 10px 0 20px; min-height: 18px;">${currentScore > 0 ? currentScore + "/10" : ""}</p>
            <div class="action-buttons" style="display: flex; flex-direction: column; gap: 10px;">
                ${existing ? '<button id="ratingDelete" class="btn-action-delete">🗑️ Удалить мою оценку</button>' : ''}
                <button id="ratingCancel" class="btn-action-cancel">Закрыть</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const starsContainer = document.getElementById("ratingStars");
    const valueLabel = document.getElementById("ratingValueLabel");
    const starEls = Array.from(starsContainer.querySelectorAll(".rating-star"));

    function paintStars(value) {
        starEls.forEach(el => {
            const v = parseInt(el.dataset.value, 10);
            el.classList.toggle("filled", v <= value);
        });
    }

    starEls.forEach(el => {
        const v = parseInt(el.dataset.value, 10);

        el.addEventListener("mouseenter", () => {
            paintStars(v);
            valueLabel.textContent = v + "/10";
        });

        el.addEventListener("click", async () => {
            const { error } = await db.from('ratings').upsert(
                {
                    title: itemText,
                    user_id: currentUser.id,
                    username: myUsername,
                    score: v,
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'title,user_id' }
            );

            if (error) {
                console.error("Ошибка при сохранении оценки:", error);
                alert("Не удалось сохранить оценку.");
                return;
            }

            overlay.remove();
            refreshRatingsUI();
        });
    });

    starsContainer.addEventListener("mouseleave", () => {
        paintStars(currentScore);
        valueLabel.textContent = currentScore > 0 ? currentScore + "/10" : "";
    });

    document.getElementById("ratingCancel").onclick = () => overlay.remove();

    if (existing) {
        document.getElementById("ratingDelete").onclick = async () => {
            overlay.remove();
            const { error } = await db.from('ratings')
                .delete()
                .eq('title', itemText)
                .eq('user_id', currentUser.id);

            if (error) {
                console.error("Ошибка при удалении оценки:", error);
                alert("Не удалось удалить оценку.");
            } else {
                refreshRatingsUI();
            }
        };
    }
}

function openData(content, saveHistory = true, customTitle = null) {
    startTransitionLock();
    isChatScreenOpen = false;
    if (chatPollInterval) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
    }
    if (saveHistory) {
        history.push(content);
    }

    app.innerHTML = "";

    if (customTitle) {
        let title = document.createElement("h1");
        title.textContent = customTitle;
        app.appendChild(title);
    }

    // На экране результатов поиска показываем ту же панель поиска —
    // чтобы можно было искать дальше, не возвращаясь на главную
    if (currentCategoryName === "🔍 Результаты поиска" && currentUser) {
        app.appendChild(buildSearchBar(lastSearchQuery));
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

// =======================================================
// ЧАТ МЕЖДУ ПОЛЬЗОВАТЕЛЯМИ (полностью изолирован от поиска/каталога)
// =======================================================

// Загружает последние 150 сообщений из базы (в хронологическом порядке)
async function loadChatMessages() {
    const { data, error } = await db
        .from('chat_messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(150);

    if (error) {
        console.error("Ошибка при загрузке чата:", error);
        return;
    }

    chatMessages = data.reverse();
}

// Реалтайм-обработчик изменений в чате
async function onChatRealtimeChange() {
    await loadChatMessages();
    if (isChatScreenOpen) {
        renderChatMessages();
    }
}

// Форматирует дату и время сообщения
function formatChatTime(isoString) {
    const d = new Date(isoString);
    const datePart = d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });
    const timePart = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    return `${datePart}, ${timePart}`;
}

// Сообщение можно редактировать/удалять только в течение 24 часов после отправки
const CHAT_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
function canModifyChatMessage(msg) {
    const createdTime = new Date(msg.created_at).getTime();
    if (isNaN(createdTime)) return false;
    return (Date.now() - createdTime) < CHAT_EDIT_WINDOW_MS;
}

// Создаёт один DOM-элемент сообщения (используется рендером ниже)
function createChatBubble(msg) {
    let bubble = document.createElement("div");
    const isMine = currentUser && msg.user_id === currentUser.id;
    bubble.className = "chat-bubble " + (isMine ? "chat-bubble-mine" : "chat-bubble-theirs");
    bubble.dataset.msgId = msg.id;

    let meta = document.createElement("div");
    meta.className = "chat-meta";
    meta.textContent = `${msg.username} • ${formatChatTime(msg.created_at)}`;

    let text = document.createElement("div");
    text.className = "chat-text";

    if (isStickerMessage(msg.message)) {
        bubble.classList.add("chat-bubble-sticker");
        let img = document.createElement("img");
        img.src = getStickerUrl(msg.message);
        img.alt = "стикер";
        img.className = "chat-sticker-img";
        text.appendChild(img);
    } else {
        text.textContent = msg.message;
    }

    bubble.appendChild(meta);
    bubble.appendChild(text);

    // Редактирование/удаление по долгому нажатию — только на своих сообщениях
    if (isMine) {
        bubble.style.cursor = "pointer";
        attachChatLongPress(bubble, msg);
    }

    return bubble;
}

// Обновляет содержимое уже отрисованного пузыря сообщения, если текст
// поменялся (например, сообщение отредактировали)
function updateChatBubbleContent(bubbleEl, msg) {
    if (isStickerMessage(msg.message)) return; // стикеры не редактируются

    const textEl = bubbleEl.querySelector(".chat-text");
    if (textEl && textEl.textContent !== msg.message) {
        textEl.textContent = msg.message;
    }
    const metaEl = bubbleEl.querySelector(".chat-meta");
    const metaText = `${msg.username} • ${formatChatTime(msg.created_at)}`;
    if (metaEl && metaEl.textContent !== metaText) {
        metaEl.textContent = metaText;
    }
}

// Долгое нажатие на пузырь сообщения — открывает меню редактирования/удаления
function attachChatLongPress(el, msg) {
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
            if (!isMoving) showChatMessageMenu(msg);
        }, 600);
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

    el.addEventListener("mousedown", startPress);
    el.addEventListener("mouseup", cancelPress);
    el.addEventListener("mouseleave", cancelPress);
    el.addEventListener("touchstart", startPress, { passive: true });
    el.addEventListener("touchmove", movePress, { passive: true });
    el.addEventListener("touchend", cancelPress, { passive: true });
    el.addEventListener("touchcancel", cancelPress);
}

// Меню действий над своим сообщением
function showChatMessageMenu(msg) {
    const canModify = canModifyChatMessage(msg);
    const isSticker = isStickerMessage(msg.message);

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "chatMsgMenuModal";
    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 15px;">Сообщение</h3>
            ${canModify ? `
            <div class="action-buttons">
                ${!isSticker ? `<button class="btn-action-edit" id="chatMsgEdit">✏️ Редактировать</button>` : ``}
                <button class="btn-action-delete" id="chatMsgDelete">🗑️ Удалить</button>
                <button class="btn-action-cancel" id="chatMsgCancel">Отмена</button>
            </div>
            ` : `
            <p style="color: #777; font-size: 14px; margin-bottom: 15px;">Изменять и удалять сообщение можно только в течение 24 часов после отправки.</p>
            <div class="action-buttons">
                <button class="btn-action-cancel" id="chatMsgCancel">Закрыть</button>
            </div>
            `}
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("chatMsgCancel").onclick = () => overlay.remove();

    if (!canModify) return;

    const editBtn = document.getElementById("chatMsgEdit");
    if (editBtn) editBtn.onclick = () => {
        overlay.remove();
        if (!canModifyChatMessage(msg)) {
            alert("Время редактирования истекло (доступно только 24 часа после отправки).");
            return;
        }
        showChatMessageEditModal(msg);
    };

    document.getElementById("chatMsgDelete").onclick = async () => {
        overlay.remove();
        if (!canModifyChatMessage(msg)) {
            alert("Время удаления истекло (доступно только 24 часа после отправки).");
            return;
        }
        if (!confirm("Удалить это сообщение?")) return;

        const { error } = await db.from('chat_messages').delete().eq('id', msg.id);
        if (error) {
            console.error("Ошибка при удалении сообщения:", error);
            alert("Не удалось удалить сообщение.");
            return;
        }
        // Убираем сразу локально, не дожидаясь realtime-события
        chatMessages = chatMessages.filter(m => m.id !== msg.id);
        renderChatMessages();
    };
}

// Модалка редактирования текста сообщения
function showChatMessageEditModal(msg) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "chatMsgEditModal";
    overlay.innerHTML = `
        <div class="modal-content">
            <h3 style="text-align: center; margin-bottom: 15px;">Редактировать сообщение</h3>
            <form class="modal-form" id="chatEditForm">
                <input type="text" id="chatEditInput" required>
                <div class="modal-buttons">
                    <button type="submit" class="btn-save">Сохранить</button>
                    <button type="button" class="btn-cancel" id="chatEditCancel">Отмена</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector("#chatEditInput");
    input.value = msg.message;
    input.focus();

    overlay.querySelector("#chatEditCancel").onclick = () => overlay.remove();

    overlay.querySelector("#chatEditForm").onsubmit = async (e) => {
        e.preventDefault();
        const newText = input.value.trim();
        if (!newText || newText === msg.message) {
            overlay.remove();
            return;
        }

        const { error } = await db.from('chat_messages').update({ message: newText }).eq('id', msg.id);
        if (error) {
            console.error("Ошибка при редактировании сообщения:", error);
            alert("Не удалось изменить сообщение.");
            return;
        }
        // Обновляем сразу локально, не дожидаясь realtime-события
        const local = chatMessages.find(m => m.id === msg.id);
        if (local) local.message = newText;
        overlay.remove();
        renderChatMessages();
    };
}

// Отрисовка списка сообщений внутри открытого чата.
// Важно: не пересоздаём весь список при каждом обновлении (это давало
// "моргание" каждые несколько секунд из-за опроса/realtime), а только
// добавляем новые сообщения и убираем удалённые — уже отрисованные
// сообщения не трогаем (только обновляем текст на месте, если его отредактировали).
function renderChatMessages() {
    const box = document.getElementById("chatBox");
    if (!box) return;

    // Пустое состояние
    if (chatMessages.length === 0) {
        if (box.dataset.rendered !== "empty") {
            box.innerHTML = "";
            let empty = document.createElement("p");
            empty.style.cssText = "text-align:center;color:#999;margin-top:20px;font-size:14px;";
            empty.textContent = "Сообщений пока нет. Напишите первым!";
            box.appendChild(empty);
            box.dataset.rendered = "empty";
        }
        return;
    }

    // Если до этого показывалась заглушка "нет сообщений" — очищаем её один раз
    if (box.dataset.rendered === "empty") {
        box.innerHTML = "";
        box.dataset.rendered = "list";
    }
    box.dataset.rendered = "list";

    const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

    // Собираем уже отрисованные элементы по id
    const renderedEls = new Map();
    box.querySelectorAll("[data-msg-id]").forEach(el => renderedEls.set(el.dataset.msgId, el));
    const currentIds = new Set(chatMessages.map(m => String(m.id)));

    // Удаляем из DOM сообщения, которых больше нет в данных (удалили)
    renderedEls.forEach((el, id) => {
        if (!currentIds.has(id)) el.remove();
    });

    // Добавляем новые сообщения и обновляем текст уже существующих (если отредактировали)
    let addedNew = false;
    chatMessages.forEach(msg => {
        const idStr = String(msg.id);
        const existingEl = renderedEls.get(idStr);
        if (!existingEl) {
            box.appendChild(createChatBubble(msg));
            addedNew = true;
        } else {
            updateChatBubbleContent(existingEl, msg);
        }
    });

    // Прокручиваем вниз только если появились новые сообщения и пользователь
    // и так был у нижнего края (чтобы не сбивать чтение старых сообщений)
    if (addedNew && wasNearBottom) {
        box.scrollTop = box.scrollHeight;
    }
}

// Экран чата (не связан с историей навигации каталога/поиска)
async function showChatScreen() {
    startTransitionLock();
    isChatScreenOpen = true;
    currentCategoryName = null;

    let oldNav = document.querySelector(".navigation");
    if (oldNav) oldNav.remove();

    app.innerHTML = "";

    let title = document.createElement("h1");
    title.textContent = "💬 Чат";
    app.appendChild(title);

    let chatBox = document.createElement("div");
    chatBox.className = "chat-box";
    chatBox.id = "chatBox";
    app.appendChild(chatBox);

    let inputRow = document.createElement("div");
    inputRow.className = "chat-input-row";

    let chatInput = document.createElement("input");
    chatInput.type = "text";
    chatInput.id = "chatInput";
    chatInput.placeholder = "Написать сообщение...";
    chatInput.autocomplete = "off";

    let stickerBtn = document.createElement("button");
    stickerBtn.id = "chatStickerBtn";
    stickerBtn.type = "button";
    stickerBtn.textContent = "😊";

    let sendBtn = document.createElement("button");
    sendBtn.id = "chatSendBtn";
    sendBtn.textContent = "➤";

    // Общая отправка сообщения в БД — используется и для текста, и для стикеров
    const sendChatMessage = async (text) => {
        if (!text || !currentUser) return;

        const username = getUsernameFromEmail(currentUser.email);
        const { data, error } = await db.from('chat_messages')
            .insert([{ user_id: currentUser.id, username: username, message: text }])
            .select()
            .single();

        if (error) {
            console.error("Ошибка при отправке сообщения:", error);
            alert("Не удалось отправить сообщение.");
            return;
        }

        // Показываем сообщение сразу же, не дожидаясь realtime-события
        if (data) {
            chatMessages.push(data);
            if (chatMessages.length > 150) chatMessages.shift();
            renderChatMessages();
        }
    };

    const sendMessage = async () => {
        const text = chatInput.value.trim();
        if (!text) return;

        chatInput.value = "";
        chatInput.focus();

        await sendChatMessage(text);
    };

    stickerBtn.onclick = () => {
        if (!currentUser) return;
        showStickerPicker((stickerUrl) => sendChatMessage(STICKER_PREFIX + stickerUrl));
    };

    sendBtn.onclick = sendMessage;
    chatInput.onkeydown = (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            sendMessage();
        }
    };

    inputRow.appendChild(chatInput);
    inputRow.appendChild(stickerBtn);
    inputRow.appendChild(sendBtn);
    app.appendChild(inputRow);

    await loadChatMessages();
    renderChatMessages();

    // Подстраховка на случай проблем с realtime: обновляем чат каждые 4 секунды
    if (chatPollInterval) clearInterval(chatPollInterval);
    chatPollInterval = setInterval(async () => {
        if (!isChatScreenOpen) return;
        await loadChatMessages();
        renderChatMessages();
    }, 4000);

    // Собственная навигация чата — не трогает историю поиска/каталога
    let nav = document.createElement("div");
    nav.className = "navigation";

    let homeBtn = document.createElement("button");
    homeBtn.textContent = "🏠 Домой";
    homeBtn.onclick = () => {
        isChatScreenOpen = false;
        if (chatPollInterval) {
            clearInterval(chatPollInterval);
            chatPollInterval = null;
        }
        showHome();
    };

    nav.appendChild(homeBtn);

    let container = document.querySelector(".container");
    if (container) {
        container.insertBefore(nav, container.firstChild);
    } else {
        document.body.insertBefore(nav, app);
    }

    chatInput.focus();
}

// Функция открытия модалки для ДОБАВЛЕНИЯ или РЕДАКТИРОВАНИЯ
function showAddEditModal(existingItem = null) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "addEditModal";

    const categories = Object.keys(dbData).filter(cat => {
        return !cat.includes("Секрет") && !cat.includes("🔒") && !cat.includes("❤️");
    });
    
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

    const genresList = document.getElementById("genresList");

    function updateGenresDatalist() {
        const selectedCategory = mCategory.value;
        const localGenres = new Set();

        const categoryData = dbData[selectedCategory];
        if (categoryData && typeof categoryData === "object" && !Array.isArray(categoryData)) {
            for (let genreKey in categoryData) {
                localGenres.add(genreKey);
            }
        }

        genresList.innerHTML = Array.from(localGenres)
            .sort()
            .map(g => `<option value="${g}">`)
            .join("");
    }

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

    mCategory.addEventListener("change", () => {
        updateGenresDatalist();
        mGenre.value = "";
        updateFranchisesDatalist();
    });
    mGenre.addEventListener("input", updateFranchisesDatalist);

    if (existingItem) {
        document.getElementById("mTitle").value = existingItem.title;
        document.getElementById("mYear").value = existingItem.year;
        mCategory.value = existingItem.category;
        mGenre.value = existingItem.genre;
        mFranchise.value = existingItem.franchise || "";
    }

    updateGenresDatalist();
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
        
        // Удаляем из просмотренных
        const { error: watchedError } = await db
            .from("watched_items")
            .delete()
            .eq("title", itemText);

        if (watchedError) {
            console.error("Не удалось удалить из просмотренных:", watchedError.message);
        }

        // Удаляем из вишлиста
        const { error: wishlistError } = await db
            .from("wishlist_items")
            .delete()
            .eq("title", itemText);

        if (wishlistError) {
            console.error("Не удалось удалить из списка 'Будем смотреть':", wishlistError.message);
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

// Короткая вибрация (если поддерживается устройством/браузером)
function vibrate(pattern) {
    if (navigator.vibrate) {
        try { navigator.vibrate(pattern); } catch (e) { /* игнорируем, если браузер не разрешил */ }
    }
}

// Анимация "прокрутки" случайных названий перед финальным результатом —
// как в игровом автомате: сначала быстро, затем замедляется
function runSlotAnimation(el, pool, finalText, isSecretDisplay, onDone) {
    const displayOf = (t) => isSecretDisplay ? t.replace(/\s*\(\d{4}\)$/, "") : t;
    el.classList.add("slot-spin");

    const totalSteps = 16;
    let step = 0;

    function tick() {
        if (step >= totalSteps) {
            el.classList.remove("slot-spin");
            el.textContent = displayOf(finalText);
            vibrate([40, 30, 60]); // финальный "щелчок"
            if (onDone) onDone();
            return;
        }

        const randomPick = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : finalText;
        el.textContent = displayOf(randomPick);
        step++;

        // Замедление к концу прокрутки
        const delay = 45 + step * step * 2;
        setTimeout(tick, delay);
    }

    tick();
}

function showRandomTitleModal(titleText, pool = []) {
    if (isShakeModalOpen) return;
    isShakeModalOpen = true;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "shakeRandomModal";
    overlay.style.zIndex = "10000";

    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); isShakeModalOpen = false; } };

    const isSecret = titleText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || titleText.includes("Бакс Ориджинал") || (currentCategoryName && (currentCategoryName.includes("Секрет") || currentCategoryName.includes("🔒")));

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center; border: 3px solid #ff4081;">
            <div style="font-size: 40px;">🎰</div>
            <h2 id="shakeRandomTitle" style="margin: 15px 0;"></h2>
            ${!isSecret ? `
            <div id="shakePosterBox" style="margin: 0 0 15px; display: none; justify-content: center;"></div>
            <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                <button id="posterShakeBtn" class="btn-pink-style" style="flex:1;">🖼 Постер</button>
                <button id="trailerShakeBtn" class="btn-pink-style" style="flex:1;">🎬 Трейлер</button>
            </div>
            ` : ``}
            <div style="display: flex; flex-direction: column; gap: 10px;">
                <button id="closeShakeBtn" class="btn-save">Супер, смотрим!</button>
                <button id="rerollShakeBtn" class="btn-cancel">🔄 Другой фильм</button>
                <button id="bottomCloseShakeBtn" class="btn-cancel-gray">Закрыть</button>
            </div>
        </div>
    `;

    const titleEl = overlay.querySelector("#shakeRandomTitle");
    let currentTitle = titleText; // тайтл, который сейчас показан (меняется при "Другой фильм")

    document.body.appendChild(overlay);

    runSlotAnimation(titleEl, pool, titleText, isSecret);

    const closeModal = () => { overlay.remove(); isShakeModalOpen = false; };

    document.getElementById("closeShakeBtn").onclick = closeModal;
    document.getElementById("bottomCloseShakeBtn").onclick = closeModal;
    document.getElementById("rerollShakeBtn").onclick = () => {
        const all = pool.length > 0 ? pool : getAllTitlesFromCategory(history[history.length - 1]);
        const next = all[Math.floor(Math.random() * all.length)];
        vibrate(30);
        currentTitle = next;
        // Скрываем постер прошлого тайтла — он больше не актуален после перепрокрутки
        const posterBox = overlay.querySelector("#shakePosterBox");
        if (posterBox) { posterBox.style.display = "none"; posterBox.innerHTML = ""; }
        runSlotAnimation(titleEl, all, next, isSecret);
    };

    if (!isSecret) {
        const posterBtn = document.getElementById("posterShakeBtn");
        const trailerBtn = document.getElementById("trailerShakeBtn");
        const posterBox = document.getElementById("shakePosterBox");

        posterBtn.onclick = async () => {
            if (posterBox.style.display === "flex") {
                posterBox.style.display = "none";
                return;
            }
            posterBox.style.display = "flex";
            posterBox.innerHTML = `<p style="color: #999; font-size: 13px;">Ищем постер...</p>`;
            const url = await fetchTmdbPoster(currentTitle);
            if (!overlay.isConnected) return; // модалку уже закрыли, пока грузился постер
            if (url) {
                posterBox.innerHTML = `<img src="${url}" alt="Постер" style="max-width: 160px; border-radius: 12px; box-shadow: 0 6px 18px rgba(180,80,120,0.25);">`;
            } else {
                posterBox.innerHTML = `<p style="color: #999; font-size: 13px;">Постер к фильму не найден</p>`;
            }
        };

        trailerBtn.onclick = () => {
            const query = encodeURIComponent(currentTitle + " трейлер");
            window.open(`https://www.youtube.com/results?search_query=${query}`, "_blank");
        };
    }
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
    
    showRandomTitleModal(randomTitle, allTitles);
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
// Генератор бесконечных нежных сердечек на заднем фоне
function initHeartsBackground() {
    // Если контейнер уже почему-то существует, не создаем его заново
    if (document.querySelector('.hearts-background')) return;

    const container = document.createElement('div');
    container.className = 'hearts-background';
    document.body.appendChild(container);

    function spawnHeart() {
        const heart = document.createElement('div');
        heart.className = 'floating-heart';
        heart.innerHTML = '❤️'; // Используем классический эмодзи сердечка

        // Рандомизируем параметры для живого и естественного эффекта
        const size = Math.random() * 18 + 12; // Размер от 12px до 30px
        const startLeft = Math.random() * 100; // Позиция по горизонтали (в %)
        const duration = Math.random() * 12 + 10; // Скорость подъема от 10 до 22 секунд (очень плавно)
        const swayX = (Math.random() * 120 - 60) + 'px'; // Амплитуда покачивания влево/вправо
        const rotateDeg = (Math.random() * 360) + 'deg'; // Случайный угол вращения

        // Применяем стили
        heart.style.fontSize = `${size}px`;
        heart.style.left = `${startLeft}%`;
        heart.style.animationDuration = `${duration}s`;
        
        // Передаем переменные покачивания во floatUp анимацию
        heart.style.setProperty('--sway-x', swayX);
        heart.style.setProperty('--rotate-deg', rotateDeg);

        container.appendChild(heart);

        // Самоликвидация элемента из DOM после того, как он улетел, чтобы не грузить браузер
        setTimeout(() => {
            heart.remove();
        }, duration * 1000);
    }

    // Создаем первое сердечко сразу
    spawnHeart();
    
    // Каждые 900мс (чуть меньше секунды) плавно выпускаем новое сердечко
    setInterval(spawnHeart, 900);
}

// Запускаем магию!
initHeartsBackground();
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
    /* --- ЗАДНИЙ ФОН С ПЛАВАЮЩИМИ СЕРДЕЧКАМИ --- */
    .hearts-background {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        pointer-events: none; /* Клики проходят сквозь них */
        z-index: -1;          /* Строго на заднем фоне */
        overflow: hidden;
    }

    .floating-heart {
        position: absolute;
        bottom: -50px;        /* Появляются чуть ниже экрана */
        color: #ff4081;       /* Малиново-розовый цвет */
        opacity: 0;
        pointer-events: none;
        user-select: none;
        animation: floatUp linear forwards;
    }

    @keyframes floatUp {
        0% {
            transform: translateY(0) translateX(0) rotate(0deg);
            opacity: 0;
        }
        10% {
            opacity: 0.15;    /* Порог максимальной прозрачности (очень нежные) */
        }
        90% {
            opacity: 0.15;
        }
        100% {
            /* Улетают вверх на всю высоту экрана с небольшим покачиванием и вращением */
            transform: translateY(-115vh) translateX(var(--sway-x)) rotate(var(--rotate-deg));
            opacity: 0;       /* Полностью растворяются вверху */
        }
    }
    /* Звёздочка для вишлиста (Красивый голубой) */
    .btn-watch.wishlist-active {
        color: #2196f3 !important;
        opacity: 1 !important;
    }

    /* --- ЭТАЛОННЫЙ РОЗОВЫЙ СТИЛЬ (Как "Трейлер на YouTube") --- */
    .btn-pink-style {
        background-color: #ffe3ec !important;
        color: #d81b60 !important;
        border: none !important;
        font-weight: 600 !important;
        transition: background-color 0.2s ease, transform 0.1s ease;
    }
    .btn-pink-style:hover {
        background-color: #ffd5e3 !important;
    }

    /* --- ЭТАЛОННЫЙ СЕРЫЙ СТИЛЬ ДЛЯ КНОПОК ОТМЕНЫ --- */
    .btn-cancel-gray {
        background-color: #f0f0f0 !important;
        color: #333333 !important;
        border: none !important;
        font-weight: 600 !important;
        transition: background-color 0.2s ease;
    }
    .btn-cancel-gray:hover {
        background-color: #e5e5e5 !important;
    }
`;
document.head.appendChild(style);
