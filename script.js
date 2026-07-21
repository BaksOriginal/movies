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
const GITHUB_STICKERS_OWNER = "BaksOriginal";
const GITHUB_STICKERS_REPO = "movies";
const GITHUB_STICKERS_BRANCH = "main";
const GITHUB_STICKERS_PATH = "stickers";
const STICKER_PREFIX = "[[STICKER]]"; // маркер стикера внутри текстового поля message

let isMusicPlaying = localStorage.getItem("musicEnabled") === "true";

// Раньше здесь была функция startTransitionLock(), которая на 350мс блокировала
// АБСОЛЮТНО ВСЕ клики на странице после каждого openData()/showHome(). Экран у
// нас перерисовывается мгновенно (через innerHTML, без CSS-анимации), поэтому
// защищать тут было нечего — а на практике это глобально "съедало" самый первый
// клик пользователя по только что отрисованному экрану (например, по звёздочке
// "Просмотрено"/"Будем смотреть" сразу после захода в раздел), из-за чего
// приходилось кликать дважды. Функция оставлена как no-op на случай, если где-то
// в коде остался вызов startTransitionLock().
function startTransitionLock() {}

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
let watchedTitles = new Set(); // Производный union: просмотрено хоть кем-то (мной, партнёром или обоими) — используется для звёздочки
let watchedByUser = {}; // "Название (год)" -> Set<user_id> — кто именно из двоих отметил тайтл просмотренным
let watchedTitlesMine = new Set();     // Просмотрено только мной
let watchedTitlesPartner = new Set();  // Просмотрено только партнёром
let watchedTitlesBoth = new Set();     // Просмотрено нами обоими
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
let chatReplyTarget = null; // Сообщение, на которое сейчас отвечаем (или null)

// Состояние тёмной темы (сохраняется за пользователем)
let isDarkTheme = false;

// Переменная, хранящая название текущей открытой категории первого уровня ("🎥 Фильмы" и т.д.)
let currentCategoryName = null; 

// Отслеживают, находится ли пользователь СЕЙЧАС внутри разделов "Просмотрено"
// или "Будем смотреть" (эти разделы строятся из watchedTitles*/wishlistTitles
// "на лету", поэтому при любом изменении данных их нужно перерисовывать заново,
// а не просто патчить иконки — иначе тайтл остаётся в старой подкатегории/
// списке до возврата на главную).
let currentWatchedBucket = null; // null | 'top' | 'mine' | 'partner' | 'both'
let isWishlistScreenOpen = false;

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
        startShakeDetection(); // безопасно — функция сама не даст навесить слушатель дважды
        return;
    }

    if (session) {
        currentUser = session.user;
        saveSessionBackup(session); // Бэкапим сессию
        startShakeDetection(); // На случай, если сессия восстановилась автоматически, а не через форму логина (функция сама защищена от повторного запуска)

        // Важно: помечаем инициализацию начатой СРАЗУ, синхронно, а не после
        // загрузки данных. Иначе при первой загрузке страницы Supabase иногда
        // присылает два события авторизации подряд (например INITIAL_SESSION
        // и SIGNED_IN), и пока флаг ещё не выставлен, второе событие успевает
        // запустить showHome() повторно — из-за этого один раз "моргает"
        // при самом первом открытии страницы.
        const wasAlreadyInitialized = isAppInitialized;
        isAppInitialized = true;
        
        // Загружаем списки просмотренного, вишлиста и оценок одним запросом
        loadThemePreference();
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
        watchedByUser = {};
        watchedTitlesMine.clear();
        watchedTitlesPartner.clear();
        watchedTitlesBoth.clear();
        wishlistTitles.clear();
        ratingsData = {};
        chatMessages = [];
        isChatScreenOpen = false;
        isAppInitialized = false;
        applyDarkTheme(false);
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

// Загрузка просмотренных тайтлов (с указанием, КЕМ именно отмечено)
async function loadWatchedFromDB() {
    if (!currentUser) return;
    const { data, error } = await db.from('watched_items').select('title, user_id');
    if (error) {
        console.error("Ошибка при загрузке списка просмотренного:", error);
        return;
    }

    const temp = {};
    data.forEach(row => {
        if (!temp[row.title]) temp[row.title] = new Set();
        temp[row.title].add(row.user_id);
    });
    watchedByUser = temp;
    recomputeWatchedBuckets();
}

// Пересчитывает 3 ведра просмотренного (мной / партнёром / нами) на основе
// watchedByUser и currentUser. Вызывать после любого изменения watchedByUser.
function recomputeWatchedBuckets() {
    watchedTitlesMine = new Set();
    watchedTitlesPartner = new Set();
    watchedTitlesBoth = new Set();
    watchedTitles = new Set();

    if (!currentUser) return;

    for (let title in watchedByUser) {
        const users = watchedByUser[title];
        if (!users || users.size === 0) continue;

        watchedTitles.add(title);

        const iWatched = users.has(currentUser.id);
        const othersWatched = Array.from(users).some(id => id !== currentUser.id);

        if (iWatched && othersWatched) {
            watchedTitlesBoth.add(title);
        } else if (iWatched) {
            watchedTitlesMine.add(title);
        } else if (othersWatched) {
            watchedTitlesPartner.add(title);
        }
    }
}

// Пытается определить user_id партнёра по уже загруженным данным (чат,
// оценки, отметки просмотренного) — своего ID Supabase Auth не отдаёт для
// чужого аккаунта напрямую, поэтому вылавливаем его из общих данных.
function getPartnerUserId() {
    if (!currentUser) return null;

    for (let msg of chatMessages) {
        if (msg.user_id && msg.user_id !== currentUser.id) return msg.user_id;
    }
    for (let title in watchedByUser) {
        for (let uid of watchedByUser[title]) {
            if (uid !== currentUser.id) return uid;
        }
    }
    for (let title in ratingsData) {
        for (let r of ratingsData[title]) {
            if (r.userId && r.userId !== currentUser.id) return r.userId;
        }
    }
    return null;
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

// =======================================================
// ТЁМНАЯ ТЕМА (доступна из секретной категории, сохраняется за пользователем)
// =======================================================

// Применяет/снимает класс тёмной темы с тела страницы
function applyDarkTheme(enabled) {
    isDarkTheme = enabled;
    document.body.classList.toggle("dark-theme", enabled);
}

// Загружает сохранённую пользователем тему из базы (с мгновенным кэшем в localStorage,
// чтобы тема не "мигала" при повторном открытии сайта до ответа сервера)
async function loadThemePreference() {
    if (!currentUser) return;

    const cacheKey = "darkTheme_" + currentUser.id;
    const cached = localStorage.getItem(cacheKey);
    if (cached !== null) {
        applyDarkTheme(cached === "true");
    }

    const { data, error } = await db
        .from('user_settings')
        .select('dark_theme')
        .eq('user_id', currentUser.id)
        .maybeSingle();

    if (error) {
        console.error("Ошибка при загрузке настроек темы:", error);
        return;
    }

    const enabled = !!(data && data.dark_theme);
    applyDarkTheme(enabled);
    localStorage.setItem(cacheKey, String(enabled));
}

// Сохраняет выбор темы в базу и в локальный кэш
async function saveThemePreference(enabled) {
    if (!currentUser) return;
    applyDarkTheme(enabled);
    localStorage.setItem("darkTheme_" + currentUser.id, String(enabled));

    const { error } = await db.from('user_settings').upsert(
        { user_id: currentUser.id, dark_theme: enabled },
        { onConflict: 'user_id' }
    );
    if (error) {
        console.error("Ошибка при сохранении темы:", error);
    }
}

// Строит переключатель тёмной темы для секретной категории
function buildThemeToggle() {
    let row = document.createElement("div");
    row.className = "theme-toggle-row";

    let label = document.createElement("span");
    label.className = "theme-toggle-label";
    label.textContent = "🌙 Режим Эчпочмони";

    let switchLabel = document.createElement("label");
    switchLabel.className = "theme-switch";

    let checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isDarkTheme;
    checkbox.onchange = () => saveThemePreference(checkbox.checked);

    let slider = document.createElement("span");
    slider.className = "theme-switch-slider";

    switchLabel.appendChild(checkbox);
    switchLabel.appendChild(slider);

    row.appendChild(label);
    row.appendChild(switchLabel);
    return row;
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

// Загружает watched/wishlist/ratings параллельными запросами.
// Раньше здесь был быстрый путь через SQL-функцию get_watched_wishlist_ratings,
// но она отдаёт "просмотрено" плоским списком без указания, КЕМ именно
// отмечено — а это как раз нужно для деления на "мной/партнёром/нами".
// Поэтому теперь всегда идём напрямую, тремя параллельными запросами.
async function loadUserDataFromDB() {
    if (!currentUser) return;
    await Promise.all([loadWatchedFromDB(), loadWishlistFromDB(), loadRatingsFromDB()]);
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

// =======================================================
// КОММЕНТАРИИ К ТАЙТЛАМ (1 пользователь — максимум 1 комментарий)
// =======================================================

// Загружает все комментарии к конкретному тайтлу из базы
async function loadCommentsForTitle(title) {
    const { data, error } = await db
        .from('comments')
        .select('*')
        .eq('title', title)
        .order('created_at', { ascending: true });

    if (error) {
        console.error("Ошибка при загрузке комментариев:", error);
        return [];
    }
    return data || [];
}

// Загружает ВСЕ комментарии по ВСЕМ тайтлам разом (для общего экрана "Комментарии")
async function loadAllComments() {
    const { data, error } = await db
        .from('comments')
        .select('*')
        .order('created_at', { ascending: true });

    if (error) {
        console.error("Ошибка при загрузке всех комментариев:", error);
        return [];
    }
    return data || [];
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

// Живое обновление интерфейса. Дергает базу и подтягивает актуальные
// watched/wishlist/ratings — используется ТОЛЬКО когда изменение пришло
// извне (через realtime-канал, например, от партнёра). Для собственных
// действий пользователя (клик по звёздочке и т.п.) нельзя вызывать эту
// функцию сразу после оптимистичного локального обновления: запрос на
// чтение здесь улетает НЕ дожидаясь, пока запись (insert/delete) реально
// зафиксируется на сервере, и если чтение обгонит запись — оно перетрёт
// свежее локальное состояние старыми данными и звёздочка "откатится"
// назад, будто клик не сработал (отсюда ощущение, что нужно нажимать
// дважды). Для локальных оптимистичных обновлений используйте
// refreshUIFromState() ниже — она просто перерисовывает то, что уже есть
// в памяти, без похода в базу.
async function updateUIOnLiveChange() {
    // Изменения в watched_items/wishlist_items/ratings не затрагивают сам каталог
    // (таблицу titles) — раньше здесь зря перезагружался ВЕСЬ каталог при
    // каждом таком изменении. Загружаем только то, что реально изменилось.
    await loadUserDataFromDB();
    refreshUIFromState();
}

// Перерисовывает интерфейс на основе уже имеющегося в памяти состояния
// (watchedTitles/wishlistTitles/ratingsData и т.д.), БЕЗ обращения к базе.
// Именно эту функцию нужно звать сразу после оптимистичного локального
// изменения (клик по звёздочке), чтобы не словить гонку с loadUserDataFromDB().
function refreshUIFromState() {
    // 1. Обновляем счетчики на кнопках главного экрана (только по явным id —
    // раньше здесь искали ВСЕ кнопки по вхождению текста "Просмотрено"/"Будем
    // смотреть", из-за чего заодно портились и подкатегории "Просмотрено
    // мной/партнёром/нами" с похожим текстом на кнопках)
    const watchedMainBtn = document.getElementById("watchedMainBtn");
    if (watchedMainBtn) {
        const totalWatched = watchedTitlesMine.size + watchedTitlesPartner.size + watchedTitlesBoth.size;
        watchedMainBtn.textContent = "🎬 Просмотрено (" + totalWatched + ")";
    }
    const wishlistMainBtn = document.getElementById("wishlistMainBtn");
    if (wishlistMainBtn) {
        wishlistMainBtn.textContent = "🍿 Будем смотреть (" + wishlistTitles.size + ")";
    }

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

    // 4. Экраны "Просмотрено"/"Будем смотреть" строятся "на лету" из текущего
    // состояния, а не из статичного списка — поэтому точечного патча иконок
    // (шаг 2) им недостаточно: тайтл после изменения может должен переехать в
    // другую подкатегорию (мной → партнёром) или вовсе пропасть из списка.
    // Если сейчас открыт один из таких экранов — перерисовываем его целиком.
    if (currentWatchedBucket === 'top') {
        renderWatchedTop();
    } else if (currentWatchedBucket) {
        renderWatchedBucket(currentWatchedBucket);
    } else if (isWishlistScreenOpen) {
        renderWishlistFolder();
    }
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

// Отмечает тайтл просмотренным. forBoth=true — отмечаем сразу за себя И за
// партнёра (если его user_id удалось определить и он ещё сам не отмечал).
async function markWatched(title, forBoth) {
    if (!currentUser) return;

    // Если тайтл был в вишлисте — просмотренное отменяет "будем смотреть"
    if (wishlistTitles.has(title)) {
        wishlistTitles.delete(title);
        db.from('wishlist_items').delete().eq('title', title).then(({ error }) => {
            if (error) console.error("Не удалось убрать из вишлиста при отметке просмотренного:", error);
        });
    }

    const rowsToInsert = [{ user_id: currentUser.id, title: title }];

    if (forBoth) {
        const partnerId = getPartnerUserId();
        const partnerAlreadyHasIt = !!(watchedByUser[title] && watchedByUser[title].has(partnerId));
        if (partnerId && !partnerAlreadyHasIt) {
            rowsToInsert.push({ user_id: partnerId, title: title });
        }
    }

    // Оптимистично обновляем локально сразу, не дожидаясь ответа сервера
    if (!watchedByUser[title]) watchedByUser[title] = new Set();
    rowsToInsert.forEach(r => watchedByUser[title].add(r.user_id));
    recomputeWatchedBuckets();
    refreshUIFromState();

    const { error } = await db.from('watched_items').insert(rowsToInsert);
    if (error) {
        console.error("Ошибка при сохранении в просмотренное:", error);
        rowsToInsert.forEach(r => watchedByUser[title] && watchedByUser[title].delete(r.user_id));
        recomputeWatchedBuckets();
        refreshUIFromState();
        alert("Не удалось сохранить отметку просмотренного.");
    }
}

// Убирает ТОЛЬКО отметку текущего пользователя (если было "нами" — станет
// "партнёром"; если было только "мной" — исчезнет из просмотренного вовсе)
async function removeMyWatched(title) {
    if (!currentUser) return;

    if (watchedByUser[title]) {
        watchedByUser[title].delete(currentUser.id);
        if (watchedByUser[title].size === 0) delete watchedByUser[title];
    }
    recomputeWatchedBuckets();
    refreshUIFromState();

    const { error } = await db.from('watched_items').delete().eq('title', title).eq('user_id', currentUser.id);
    if (error) {
        console.error("Ошибка при удалении из просмотренного:", error);
        // На всякий случай перезагружаем актуальное состояние с сервера
        await loadWatchedFromDB();
        refreshUIFromState();
    }
}

// Модальное окно выбора действия для звёздочки
function showStarChoiceModal(title) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "starChoiceModal";

    const iWatchedIt = watchedTitlesMine.has(title) || watchedTitlesBoth.has(title);
    const isWatchedAtAll = watchedTitles.has(title);
    const isWishlisted = wishlistTitles.has(title);

    let optionsHtml = "";

    if (iWatchedIt) {
        optionsHtml += `<button id="choiceRemoveWatched" class="btn-pink-style">❌ Убрать мою отметку "просмотрено"</button>`;
    } else {
        optionsHtml += `<button id="choiceWatchMe" class="btn-pink-style">🎬 Просмотрено мной</button>`;
        optionsHtml += `<button id="choiceWatchBoth" class="btn-pink-style">🎬❤️ Просмотрено нами</button>`;
    }

    if (isWishlisted) {
        optionsHtml += `<button id="choiceRemoveWish" class="btn-pink-style">❌ Убрать из вишлиста</button>`;
    } else if (!isWatchedAtAll) {
        optionsHtml += `<button id="choiceWish" class="btn-pink-style">🍿 Будем смотреть</button>`;
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

    const removeWatchedBtn = document.getElementById("choiceRemoveWatched");
    if (removeWatchedBtn) {
        removeWatchedBtn.onclick = () => {
            overlay.remove();
            removeMyWatched(title);
        };
    }

    const removeWishBtn = document.getElementById("choiceRemoveWish");
    if (removeWishBtn) {
        removeWishBtn.onclick = async () => {
            overlay.remove();
            wishlistTitles.delete(title);
            refreshUIFromState();
            await db.from('wishlist_items').delete().eq('title', title).eq('user_id', currentUser.id);
        };
    }

    const wishBtn = document.getElementById("choiceWish");
    if (wishBtn) {
        wishBtn.onclick = async () => {
            overlay.remove();
            wishlistTitles.add(title);
            refreshUIFromState();
            const { error } = await db.from('wishlist_items').insert([{ user_id: currentUser.id, title: title }]);
            if (error) {
                wishlistTitles.delete(title);
                refreshUIFromState();
                console.error("Ошибка при сохранении в вишлист:", error);
            }
        };
    }

    const watchMeBtn = document.getElementById("choiceWatchMe");
    if (watchMeBtn) {
        watchMeBtn.onclick = () => {
            overlay.remove();
            markWatched(title, false);
        };
    }

    const watchBothBtn = document.getElementById("choiceWatchBoth");
    if (watchBothBtn) {
        watchBothBtn.onclick = () => {
            overlay.remove();
            markWatched(title, true);
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
    searchInput.className = "search-input-field";
    searchInput.placeholder = "Поиск...";
    searchInput.value = prefillQuery;
    searchInput.style.cssText = `
        flex-grow: 1;
        min-width: 0;
        padding: 10px 12px;
        border-radius: 8px;
        font-size: 18px;
        font-weight: 600;
        font-family: "Segoe UI", Arial, sans-serif;
        box-sizing: border-box;
    `;

    let searchSubmitBtn = document.createElement("button");
    searchSubmitBtn.className = "btn-search-icon";
    searchSubmitBtn.textContent = "🔍";
    searchSubmitBtn.style.cssText = `
        width: 42px !important;
        height: 42px !important;
        padding: 0 !important;
        margin: 0 !important;
        border-radius: 8px !important;
        cursor: pointer;
        font-size: 16px;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-shrink: 0;
    `;

    let filterBtn = document.createElement("button");
    filterBtn.id = "searchFilterBtn";
    filterBtn.className = "btn-filter-icon";
    filterBtn.classList.toggle("active", hasActiveFilters(searchFilters));
    filterBtn.textContent = "⚙️";
    filterBtn.style.cssText = `
        width: 42px !important;
        height: 42px !important;
        padding: 0 !important;
        margin: 0 !important;
        border-radius: 8px !important;
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
        filterBtn.classList.toggle("active", hasActiveFilters(searchFilters));
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
    currentWatchedBucket = null;
    isWishlistScreenOpen = false;
    if (chatPollInterval) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
    }
    if (activeGameCleanup) {
        activeGameCleanup();
        activeGameCleanup = null;
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
        btn.className = "icon-btn";
        btn.style.cssText = `
            width: 40px !important; height: 40px !important;
            min-width: 40px !important; min-height: 40px !important;
            padding: 0 !important; margin: 0 !important;
            border-radius: 50% !important; display: flex !important;
            justify-content: center !important; align-items: center !important;
            cursor: pointer !important; font-size: 16px !important;
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
    wishlistBtn.id = "wishlistMainBtn";
    wishlistBtn.className = "btn-pink-style";
    wishlistBtn.textContent = "🍿 Будем смотреть (" + wishlistTitles.size + ")";
    wishlistBtn.onclick = () => {
        renderWishlistFolder();
    };
    app.appendChild(wishlistBtn);

    // Кнопка "Просмотрено" на главной — ведёт в папку с 3 подкатегориями
    // (мной / партнёром / нами)
    let watchedBtn = document.createElement("button");
    watchedBtn.id = "watchedMainBtn";
    watchedBtn.className = "btn-pink-style";
    const totalWatchedCount = watchedTitlesMine.size + watchedTitlesPartner.size + watchedTitlesBoth.size;
    watchedBtn.textContent = "🎬 Просмотрено (" + totalWatchedCount + ")";
    watchedBtn.onclick = () => {
        renderWatchedTop();
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

        let allCommentsBtn = document.createElement("button");
        allCommentsBtn.className = "btn-chat-purple";
        allCommentsBtn.textContent = "🗨️ Комментарии";
        allCommentsBtn.onclick = () => showAllCommentsScreen();
        app.appendChild(allCommentsBtn);

        // Сплиттер HR перед разделом игр
        let hrBeforeGames = document.createElement("hr");
        hrBeforeGames.style.border = "0";
        hrBeforeGames.style.borderTop = "2px solid #9b4f70";
        hrBeforeGames.style.margin = "20px 0";
        app.appendChild(hrBeforeGames);

        let gamesBtn = document.createElement("button");
        gamesBtn.className = "btn-games-green";
        gamesBtn.textContent = "🕹 Игры";
        gamesBtn.onclick = () => showGamesScreen();
        app.appendChild(gamesBtn);
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
                <button class="btn-pink-style" id="actComment">💬 Комментарии</button>
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

    document.getElementById("actComment").onclick = () => {
        overlay.remove();
        showCommentsModal(itemText);
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

// Модальное окно комментариев к тайтлу (1 пользователь = максимум 1 комментарий)
async function showCommentsModal(itemText) {
    if (!currentUser) return;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "commentsModal";
    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 10px;">💬 Комментарии</h3>
            <p style="color: #666; margin-bottom: 15px; font-size: 14px;">"${itemText.replace(/\s*\(\d{4}\)$/, "")}"</p>
            <div class="comments-list" id="commentsList">
                <p style="text-align:center;color:#999;font-size:13px;">Загрузка...</p>
            </div>
            <div id="commentFormBox"></div>
            <div class="action-buttons" style="margin-top: 10px;">
                <button id="commentsClose" class="btn-action-cancel">Закрыть</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector("#commentsClose").onclick = () => overlay.remove();

    const myUsername = getUsernameFromEmail(currentUser.email);
    const listEl = overlay.querySelector("#commentsList");
    const formBox = overlay.querySelector("#commentFormBox");

    async function refresh() {
        const comments = await loadCommentsForTitle(itemText);
        if (!overlay.isConnected) return;

        listEl.innerHTML = "";
        if (comments.length === 0) {
            listEl.innerHTML = `<p style="text-align:center;color:#999;font-size:13px;">Комментариев пока нет.</p>`;
        } else {
            comments.forEach(c => {
                const card = document.createElement("div");
                card.className = "comment-card";
                const isMine = c.user_id === currentUser.id;
                card.innerHTML = `
                    <div class="comment-card-header"><span>${c.username}</span></div>
                    <div class="comment-card-text"></div>
                    ${isMine ? `<div class="comment-card-actions">
                        <button class="btn-action-edit" data-act="edit">✏️ Изменить</button>
                        <button class="btn-action-delete" data-act="delete">🗑️ Удалить</button>
                    </div>` : ``}
                `;
                card.querySelector(".comment-card-text").textContent = c.comment;

                if (isMine) {
                    card.querySelector('[data-act="edit"]').onclick = () => showCommentForm(c);
                    card.querySelector('[data-act="delete"]').onclick = async () => {
                        if (!confirm("Удалить ваш комментарий?")) return;
                        const { error } = await db.from('comments').delete().eq('id', c.id);
                        if (error) {
                            alert("Не удалось удалить комментарий.");
                            return;
                        }
                        await refresh();
                    };
                }

                listEl.appendChild(card);
            });
        }

        const myComment = comments.find(c => c.user_id === currentUser.id);
        showCommentForm(myComment || null);
    }

    function showCommentForm(existingComment) {
        formBox.innerHTML = "";
        if (existingComment && formBox.dataset.editing !== "1") {
            // У пользователя уже есть комментарий и форма редактирования не открыта — формы не показываем,
            // редактирование доступно через кнопку "Изменить" в карточке комментария
            return;
        }

        const form = document.createElement("form");
        form.className = "modal-form";
        form.innerHTML = `
            <label style="text-align:left;">${existingComment ? "Изменить комментарий (" + myUsername + ")" : "Оставить комментарий (" + myUsername + ")"}</label>
            <input type="text" id="commentInput" required maxlength="500" placeholder="Ваш комментарий...">
            <div class="modal-buttons">
                <button type="submit" class="btn-save">Сохранить</button>
                ${existingComment ? `<button type="button" class="btn-cancel" id="commentFormCancel">Отмена</button>` : ``}
            </div>
        `;
        formBox.appendChild(form);
        formBox.dataset.editing = "1";

        const input = form.querySelector("#commentInput");
        if (existingComment) input.value = existingComment.comment;
        input.focus();

        const cancelBtn = form.querySelector("#commentFormCancel");
        if (cancelBtn) {
            cancelBtn.onclick = () => {
                formBox.dataset.editing = "0";
                formBox.innerHTML = "";
            };
        }

        form.onsubmit = async (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) return;

            const { error } = await db.from('comments').upsert(
                {
                    title: itemText,
                    user_id: currentUser.id,
                    username: myUsername,
                    comment: text,
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'title,user_id' }
            );

            if (error) {
                console.error("Ошибка при сохранении комментария:", error);
                alert("Не удалось сохранить комментарий.");
                return;
            }

            formBox.dataset.editing = "0";
            await refresh();
        };
    }

    await refresh();
}

// =======================================================
// ОБЩИЙ ЭКРАН "КОММЕНТАРИИ" — все комментарии по всем тайтлам сразу,
// сгруппированные по фильму/сериалу. Редактировать или удалять здесь
// можно только СВОЙ комментарий (как и в showCommentsModal выше).
// =======================================================
async function showAllCommentsScreen() {
    startTransitionLock();
    isChatScreenOpen = false;
    currentWatchedBucket = null;
    isWishlistScreenOpen = false;
    if (chatPollInterval) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
    }
    currentCategoryName = null;

    let oldNav = document.querySelector(".navigation");
    if (oldNav) oldNav.remove();

    app.innerHTML = "";

    let title = document.createElement("h1");
    title.textContent = "🗨️ Комментарии";
    app.appendChild(title);

    let container = document.createElement("div");
    container.id = "allCommentsContainer";
    container.innerHTML = `<p style="text-align:center;color:#999;font-size:13px;">Загрузка...</p>`;
    app.appendChild(container);

    // Своя навигация (не трогает историю поиска/каталога) — как у экрана чата
    let nav = document.createElement("div");
    nav.className = "navigation";

    let homeBtn = document.createElement("button");
    homeBtn.textContent = "🏠 Домой";
    homeBtn.onclick = () => showHome();
    nav.appendChild(homeBtn);

    let containerEl = document.querySelector(".container");
    if (containerEl) {
        containerEl.insertBefore(nav, containerEl.firstChild);
    } else {
        document.body.insertBefore(nav, app);
    }

    await renderAllComments(container);
}

// Загружает и (пере)отрисовывает содержимое экрана "Комментарии"
async function renderAllComments(container) {
    const allComments = await loadAllComments();
    if (!container.isConnected) return;

    container.innerHTML = "";

    if (allComments.length === 0) {
        container.innerHTML = `<p style="text-align:center;color:#999;font-size:13px;">Комментариев пока нет.</p>`;
        return;
    }

    // Группируем по названию тайтла, сохраняя порядок первого появления
    const byTitle = {};
    const titleOrder = [];
    allComments.forEach(c => {
        if (!byTitle[c.title]) {
            byTitle[c.title] = [];
            titleOrder.push(c.title);
        }
        byTitle[c.title].push(c);
    });

    titleOrder.forEach(titleName => {
        const group = document.createElement("div");
        group.className = "comment-title-group";
        group.style.marginBottom = "22px";

        const heading = document.createElement("h3");
        heading.style.marginBottom = "8px";
        heading.textContent = titleName.replace(/\s*\(\d{4}\)$/, "");
        group.appendChild(heading);

        byTitle[titleName].forEach(c => {
            const card = document.createElement("div");
            card.className = "comment-card";
            const isMine = currentUser && c.user_id === currentUser.id;
            card.innerHTML = `
                <div class="comment-card-header"><span>${c.username}</span></div>
                <div class="comment-card-text"></div>
                ${isMine ? `<div class="comment-card-actions">
                    <button class="btn-action-edit" data-act="edit">✏️ Изменить</button>
                    <button class="btn-action-delete" data-act="delete">🗑️ Удалить</button>
                </div>` : ``}
            `;
            card.querySelector(".comment-card-text").textContent = c.comment;

            if (isMine) {
                card.querySelector('[data-act="edit"]').onclick = () => {
                    showInlineCommentEditForm(card, c, container);
                };
                card.querySelector('[data-act="delete"]').onclick = async () => {
                    if (!confirm("Удалить ваш комментарий?")) return;
                    const { error } = await db.from('comments').delete().eq('id', c.id);
                    if (error) {
                        alert("Не удалось удалить комментарий.");
                        return;
                    }
                    await renderAllComments(container);
                };
            }

            group.appendChild(card);
        });

        container.appendChild(group);
    });
}

// Показывает прямо внутри карточки комментария форму редактирования своего текста
function showInlineCommentEditForm(card, existingComment, container) {
    const myUsername = getUsernameFromEmail(currentUser.email);

    const formBox = document.createElement("div");
    formBox.className = "modal-form";
    formBox.innerHTML = `
        <input type="text" id="inlineCommentInput" required maxlength="500" placeholder="Ваш комментарий...">
        <div class="modal-buttons" style="margin-top: 8px;">
            <button type="button" class="btn-save" id="inlineCommentSave">Сохранить</button>
            <button type="button" class="btn-cancel" id="inlineCommentCancel">Отмена</button>
        </div>
    `;

    // Прячем обычный вид карточки, показываем форму вместо неё
    Array.from(card.children).forEach(child => child.style.display = "none");
    card.appendChild(formBox);

    const input = formBox.querySelector("#inlineCommentInput");
    input.value = existingComment.comment;
    input.focus();

    formBox.querySelector("#inlineCommentCancel").onclick = () => {
        formBox.remove();
        Array.from(card.children).forEach(child => child.style.display = "");
    };

    formBox.querySelector("#inlineCommentSave").onclick = async () => {
        const text = input.value.trim();
        if (!text) return;

        const { error } = await db.from('comments').upsert(
            {
                title: existingComment.title,
                user_id: currentUser.id,
                username: myUsername,
                comment: text,
                updated_at: new Date().toISOString()
            },
            { onConflict: 'title,user_id' }
        );

        if (error) {
            console.error("Ошибка при сохранении комментария:", error);
            alert("Не удалось сохранить комментарий.");
            return;
        }

        await renderAllComments(container);
    };
}

function openData(content, saveHistory = true, customTitle = null) {
    startTransitionLock();
    isChatScreenOpen = false;
    currentWatchedBucket = null;
    isWishlistScreenOpen = false;
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

    // Показываем общее количество тайтлов внизу экрана категории/жанра
    // (кроме секретной категории — там подсчёт не нужен вовсе)
    const isInSecretCategory = currentCategoryName && isSecretCategory(currentCategoryName);
    const totalTitlesCount = getAllTitlesFromCategory(content).length;
    if (totalTitlesCount > 0 && !isInSecretCategory) {
        let countFooter = document.createElement("p");
        countFooter.className = "count-footer";
        countFooter.textContent = `Всего тайтлов: ${totalTitlesCount}`;
        app.appendChild(countFooter);
    }

    // Тумблер тёмной темы — только на самом верхнем экране категории "Секрет"
    // (history.length === 1 сразу после клика по кнопке категории на главной),
    // а не в её подкатегориях/жанрах ниже по дереву
    const isTopLevelOfSecretCategory = isInSecretCategory && history.length === 1;
    if (isTopLevelOfSecretCategory && currentUser) {
        app.appendChild(buildThemeToggle());
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

// =======================================================
// ОТВЕТ НА СООБЩЕНИЕ (REPLY)
// =======================================================

// Устанавливает сообщение, на которое отвечаем, и показывает панель над полем ввода
function setChatReplyTarget(msg) {
    chatReplyTarget = msg;
    renderChatReplyBar();
    const input = document.getElementById("chatInput");
    if (input) input.focus();
}

function clearChatReplyTarget() {
    chatReplyTarget = null;
    renderChatReplyBar();
}

// Отрисовывает (или убирает) панель "Ответ на сообщение" над полем ввода чата
function renderChatReplyBar() {
    const box = document.getElementById("chatReplyBarBox");
    if (!box) return;

    if (!chatReplyTarget) {
        box.innerHTML = "";
        return;
    }

    box.innerHTML = `
        <div class="chat-reply-bar">
            <div class="chat-reply-bar-info">
                <span class="chat-reply-bar-author"></span>
                <span class="chat-reply-bar-text"></span>
            </div>
            <button type="button" class="chat-reply-bar-cancel" id="chatReplyCancelBtn">✕</button>
        </div>
    `;
    box.querySelector(".chat-reply-bar-author").textContent = chatReplyTarget.username;
    box.querySelector(".chat-reply-bar-text").textContent = buildReplyPreviewText(chatReplyTarget);
    box.querySelector("#chatReplyCancelBtn").onclick = () => clearChatReplyTarget();
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

// Обрезает текст цитаты ответа для превью
function buildReplyPreviewText(msg) {
    if (isStickerMessage(msg.message)) return "🖼️ Стикер";
    const text = msg.message || "";
    return text.length > 60 ? text.slice(0, 60) + "…" : text;
}

// Создаёт один DOM-элемент сообщения (используется рендером ниже)
function createChatBubble(msg) {
    let bubble = document.createElement("div");
    const isMine = currentUser && msg.user_id === currentUser.id;
    bubble.className = "chat-bubble " + (isMine ? "chat-bubble-mine" : "chat-bubble-theirs");
    bubble.dataset.msgId = msg.id;

    // Цитата сообщения, на которое отвечали
    if (msg.reply_to_username) {
        let quote = document.createElement("div");
        quote.className = "chat-reply-quote";
        quote.innerHTML = `<span class="chat-reply-quote-author"></span><br><span class="chat-reply-quote-text"></span>`;
        quote.querySelector(".chat-reply-quote-author").textContent = msg.reply_to_username;
        quote.querySelector(".chat-reply-quote-text").textContent = msg.reply_to_text || "";
        bubble.appendChild(quote);
    }

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
        img.draggable = false;
        img.oncontextmenu = (e) => e.preventDefault(); // отключаем системное меню браузера на долгом тапе
        text.appendChild(img);
    } else {
        text.textContent = msg.message;
    }

    bubble.appendChild(meta);
    bubble.appendChild(text);

    // Реакция сердечком (если есть)
    if (msg.reaction) {
        let heart = document.createElement("div");
        heart.className = "chat-reaction-heart";
        heart.textContent = msg.reaction;
        bubble.appendChild(heart);
    }

    // Долгое нажатие — открывает меню (ответить, а для своих сообщений — ещё редактировать/удалить)
    bubble.style.cursor = "pointer";
    attachChatLongPress(bubble, msg, isMine);

    // Двойной тап по сообщению СОБЕСЕДНИКА — реакция сердечком
    if (!isMine) {
        attachChatDoubleTap(bubble, msg);
    }

    return bubble;
}

// Обновляет содержимое уже отрисованного пузыря сообщения, если текст
// поменялся (например, сообщение отредактировали, или сообщение, на
// которое ссылается ответ, было удалено)
function updateChatBubbleContent(bubbleEl, msg) {
    // Обновляем текст цитаты ответа (например, "Сообщение удалено"),
    // если она есть — это нужно независимо от того, стикер это или нет
    const quoteTextEl = bubbleEl.querySelector(".chat-reply-quote-text");
    if (quoteTextEl) {
        const quoteText = msg.reply_to_text || "";
        if (quoteTextEl.textContent !== quoteText) {
            quoteTextEl.textContent = quoteText;
        }
    }

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

    // Обновляем реакцию-сердечко, если она поменялась
    let heartEl = bubbleEl.querySelector(".chat-reaction-heart");
    if (msg.reaction) {
        if (!heartEl) {
            heartEl = document.createElement("div");
            heartEl.className = "chat-reaction-heart";
            bubbleEl.appendChild(heartEl);
        }
        heartEl.textContent = msg.reaction;
    } else if (heartEl) {
        heartEl.remove();
    }
}

// Долгое нажатие на пузырь сообщения — открывает меню (ответить / редактировать / удалить)
function attachChatLongPress(el, msg, isMine) {
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
                vibrate(15);
                showChatMessageMenu(msg, isMine);
            }
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

// Двойной тап/клик по сообщению собеседника — ставит или снимает реакцию сердечком
function attachChatDoubleTap(el, msg) {
    let lastTapTime = 0;
    const DOUBLE_TAP_MS = 300;

    const handleTap = (e) => {
        const now = Date.now();
        if (now - lastTapTime < DOUBLE_TAP_MS) {
            lastTapTime = 0;
            e.preventDefault();
            toggleHeartReaction(msg);
        } else {
            lastTapTime = now;
        }
    };

    el.addEventListener("dblclick", (e) => {
        e.preventDefault();
        toggleHeartReaction(msg);
    });
    el.addEventListener("touchend", handleTap, { passive: false });
}

// Ставит/снимает реакцию сердечком на сообщение собеседника
async function toggleHeartReaction(msg) {
    if (!currentUser) return;
    const alreadyMine = msg.reaction && msg.reaction_by === currentUser.id;
    const newReaction = alreadyMine ? null : "❤️";
    const newReactionBy = alreadyMine ? null : currentUser.id;

    vibrate(20);

    // Обновляем локально сразу для отзывчивости интерфейса
    const local = chatMessages.find(m => m.id === msg.id);
    if (local) {
        local.reaction = newReaction;
        local.reaction_by = newReactionBy;
        renderChatMessages();
    }

    const { error } = await db.from('chat_messages')
        .update({ reaction: newReaction, reaction_by: newReactionBy })
        .eq('id', msg.id);

    if (error) {
        console.error("Ошибка при сохранении реакции:", error);
    }
}

// Меню действий над сообщением (ответить — для любых сообщений; редактировать/удалить — только для своих)
function showChatMessageMenu(msg, isMine) {
    const canModify = isMine && canModifyChatMessage(msg);
    const isSticker = isStickerMessage(msg.message);

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "chatMsgMenuModal";
    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 15px;">Сообщение</h3>
            <div class="action-buttons">
                <button class="btn-action-edit" id="chatMsgReply">↩️ Ответить</button>
                ${canModify && !isSticker ? `<button class="btn-action-edit" id="chatMsgEdit">✏️ Редактировать</button>` : ``}
                ${canModify ? `<button class="btn-action-delete" id="chatMsgDelete">🗑️ Удалить</button>` : ``}
                <button class="btn-action-cancel" id="chatMsgCancel">${canModify ? "Отмена" : "Закрыть"}</button>
            </div>
            ${isMine && !canModify ? `<p style="color: #777; font-size: 13px; margin-top: 12px;">Изменять и удалять сообщение можно только в течение 24 часов после отправки.</p>` : ``}
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("chatMsgCancel").onclick = () => overlay.remove();

    document.getElementById("chatMsgReply").onclick = () => {
        overlay.remove();
        setChatReplyTarget(msg);
    };

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

        // Сначала помечаем "удалено" во всех ответах, ссылающихся на это
        // сообщение — иначе после удаления самого сообщения его текст
        // навсегда останется висеть в чужих цитатах.
        const { error: replyUpdateError } = await db.from('chat_messages')
            .update({ reply_to_text: "Сообщение удалено" })
            .eq('reply_to_id', msg.id);
        if (replyUpdateError) {
            console.error("Ошибка при обновлении ответов на удаляемое сообщение:", replyUpdateError);
        }

        const { error } = await db.from('chat_messages').delete().eq('id', msg.id);
        if (error) {
            console.error("Ошибка при удалении сообщения:", error);
            alert("Не удалось удалить сообщение.");
            return;
        }
        // Убираем сразу локально, не дожидаясь realtime-события
        chatMessages = chatMessages.filter(m => m.id !== msg.id);
        // И сразу же обновляем локальные цитаты в ответах на него
        chatMessages.forEach(m => {
            if (m.reply_to_id === msg.id) m.reply_to_text = "Сообщение удалено";
        });
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
    currentWatchedBucket = null;
    isWishlistScreenOpen = false;
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

    // Панель "ответ на сообщение" (появляется, когда выбран reply)
    let replyBarBox = document.createElement("div");
    replyBarBox.id = "chatReplyBarBox";
    app.appendChild(replyBarBox);
    chatReplyTarget = null;
    renderChatReplyBar();

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
        const payload = { user_id: currentUser.id, username: username, message: text };

        if (chatReplyTarget) {
            payload.reply_to_id = chatReplyTarget.id;
            payload.reply_to_username = chatReplyTarget.username;
            payload.reply_to_text = buildReplyPreviewText(chatReplyTarget);
        }

        const { data, error } = await db.from('chat_messages')
            .insert([payload])
            .select()
            .single();

        if (error) {
            console.error("Ошибка при отправке сообщения:", error);
            alert("Не удалось отправить сообщение.");
            return;
        }

        clearChatReplyTarget();

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
        clearChatReplyTarget();
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
let shakeDetectionStarted = false; // чтобы не навешивать слушатель devicemotion повторно

// =======================================================
// "ЖИВЫЕ" ЭКРАНЫ "ПРОСМОТРЕНО" И "БУДЕМ СМОТРЕТЬ"
// =======================================================
// В отличие от обычного каталога, эти разделы строятся не из статичных
// данных БД, а из watchedTitles*/wishlistTitles, которые меняются прямо
// во время просмотра экрана (пользователь снимает/ставит отметку не выходя
// из папки). Поэтому они НЕ используют общий openData()/history (там бы
// содержимое застыло на момент открытия папки) — у них свои функции
// рендера, которые вызываются заново после каждого изменения состояния
// (см. refreshUIFromState()), и своя маленькая навигация.

const WATCHED_BUCKETS = {
    mine:    { label: "🙋 Просмотрено мной",       set: () => watchedTitlesMine },
    partner: { label: "🧑‍🤝‍🧑 Просмотрено партнёром", set: () => watchedTitlesPartner },
    both:    { label: "❤️ Просмотрено нами",       set: () => watchedTitlesBoth },
};

function renderWatchedNav(backHandler) {
    let oldNav = document.querySelector(".navigation");
    if (oldNav) oldNav.remove();

    let nav = document.createElement("div");
    nav.className = "navigation";

    if (backHandler) {
        let back = document.createElement("button");
        back.textContent = "⬅ Назад";
        back.onclick = backHandler;
        nav.appendChild(back);
    }

    let home = document.createElement("button");
    home.textContent = "🏠 Домой";
    home.onclick = () => showHome();
    nav.appendChild(home);

    let container = document.querySelector(".container");
    if (container) {
        container.insertBefore(nav, container.firstChild);
    } else {
        document.body.insertBefore(nav, app);
    }
}

// Верхний экран "Просмотрено" — 3 кнопки-подкатегории со счётчиками
function renderWatchedTop() {
    startTransitionLock();
    isChatScreenOpen = false;
    if (chatPollInterval) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
    }
    currentCategoryName = "🎬 Просмотрено";
    currentWatchedBucket = 'top';
    isWishlistScreenOpen = false;

    app.innerHTML = "";

    let title = document.createElement("h1");
    title.textContent = "🎬 Просмотрено";
    app.appendChild(title);

    for (let key in WATCHED_BUCKETS) {
        const bucket = WATCHED_BUCKETS[key];
        let btn = document.createElement("button");
        btn.textContent = `${bucket.label} (${bucket.set().size})`;
        btn.onclick = () => renderWatchedBucket(key);
        app.appendChild(btn);
    }

    renderWatchedNav(() => showHome());
}

// Экран одной подкатегории (мной / партнёром / нами) со списком тайтлов
function renderWatchedBucket(bucketKey) {
    startTransitionLock();
    isChatScreenOpen = false;
    if (chatPollInterval) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
    }
    currentCategoryName = "🎬 Просмотрено";
    currentWatchedBucket = bucketKey;
    isWishlistScreenOpen = false;

    const bucket = WATCHED_BUCKETS[bucketKey];
    if (!bucket) { renderWatchedTop(); return; }

    app.innerHTML = "";

    let title = document.createElement("h1");
    title.textContent = bucket.label;
    app.appendChild(title);

    const list = Array.from(bucket.set());
    if (list.length === 0) {
        let empty = document.createElement("p");
        empty.style.textAlign = "center";
        empty.style.color = "#999";
        empty.textContent = "Здесь пока пусто.";
        app.appendChild(empty);
    } else {
        list.forEach(item => renderItemRow(item, app));
    }

    let countFooter = document.createElement("p");
    countFooter.className = "count-footer";
    countFooter.textContent = `Всего тайтлов: ${list.length}`;
    app.appendChild(countFooter);

    renderWatchedNav(() => renderWatchedTop());
}

// Экран "Будем смотреть" — плоский список вишлиста
function renderWishlistFolder() {
    startTransitionLock();
    isChatScreenOpen = false;
    if (chatPollInterval) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
    }
    currentCategoryName = "🍿 Будем смотреть";
    currentWatchedBucket = null;
    isWishlistScreenOpen = true;

    app.innerHTML = "";

    let title = document.createElement("h1");
    title.textContent = "🍿 Будем смотреть";
    app.appendChild(title);

    const list = Array.from(wishlistTitles);
    if (list.length === 0) {
        let empty = document.createElement("p");
        empty.style.textAlign = "center";
        empty.style.color = "#999";
        empty.textContent = "Здесь пока пусто.";
        app.appendChild(empty);
    } else {
        list.forEach(item => renderItemRow(item, app));
    }

    let countFooter = document.createElement("p");
    countFooter.className = "count-footer";
    countFooter.textContent = `Всего тайтлов: ${list.length}`;
    app.appendChild(countFooter);

    renderWatchedNav(() => showHome());
}

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
    if (shakeDetectionStarted) return; // уже запущено — не навешиваем слушатель второй раз
    shakeDetectionStarted = true;

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
// =======================================================
// ИГРЫ (Змейка / Flappy Bird / Doodle Jump) — общая таблица лидеров на двоих
// =======================================================
// Для работы нужна таблица в Supabase (создать один раз вручную, SQL editor):
//
// create table game_scores (
//   user_id uuid references auth.users(id),
//   username text,
//   game text check (game in ('snake','flappy','doodle')),
//   best_score integer default 0,
//   updated_at timestamptz default now(),
//   primary key (user_id, game)
// );
//
// Если таблица у вас уже создана под старую версию (только 'snake'/'flappy'),
// добавить Doodle Jump в таблицу лидеров можно так (выполнить один раз в SQL editor):
//
// alter table game_scores drop constraint game_scores_game_check;
// alter table game_scores add constraint game_scores_game_check check (game in ('snake','flappy','doodle'));
//
// (RLS можно не включать, как и для остальных таблиц в этом проекте —
// либо настроить так же, как у таблицы ratings/comments.)

let gameScoresCache = { snake: [], flappy: [], doodle: [] };
let activeGameCleanup = null; // остановка текущей запущенной игры (интервалы/rAF/слушатели), если она есть

// ------------------------- СПРАЙТ ПТИЧКИ ДЛЯ FLAPPY BIRD -------------------------
// Голова с фото профиля (вырезана, фон убран) — используется как спрайт птички.
// Хранится прямо в коде как base64-картинка, чтобы не заводить отдельную папку
// с текстурами на GitHub и не зависеть от внешних файлов/хостинга.
const FLAPPY_BIRD_HEAD_B64 = "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";
const flappyBirdImg = new Image();
flappyBirdImg.src = "data:image/png;base64," + FLAPPY_BIRD_HEAD_B64;

// Загружает лучшие результаты обоих игроков по обеим играм
async function loadGameScores() {
    const { data, error } = await db.from('game_scores').select('*');
    if (error) {
        console.error("Ошибка при загрузке рекордов игр:", error);
        return;
    }
    gameScoresCache = { snake: [], flappy: [], doodle: [] };
    (data || []).forEach(row => {
        if (!gameScoresCache[row.game]) gameScoresCache[row.game] = [];
        gameScoresCache[row.game].push({ userId: row.user_id, username: row.username, score: row.best_score });
    });
}

// Возвращает личный текущий рекорд игрока в конкретной игре
function getMyBest(game) {
    if (!currentUser) return 0;
    const mine = (gameScoresCache[game] || []).find(r => r.userId === currentUser.id);
    return mine ? mine.score : 0;
}

// Сохраняет новый рекорд, только если он реально побит. Возвращает true, если это новый рекорд.
async function saveGameScore(game, score) {
    if (!currentUser) return false;
    const list = gameScoresCache[game] || (gameScoresCache[game] = []);
    const mine = list.find(r => r.userId === currentUser.id);
    const prevBest = mine ? mine.score : 0;
    if (score <= prevBest) return false;

    const username = getUsernameFromEmail(currentUser.email);
    const { error } = await db.from('game_scores').upsert(
        { user_id: currentUser.id, username, game, best_score: score, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,game' }
    );
    if (error) {
        console.error("Ошибка при сохранении рекорда игры:", error);
        return false;
    }
    if (mine) mine.score = score;
    else list.push({ userId: currentUser.id, username, score });
    return true;
}

// Строит HTML таблицы лидеров (у нас всего 2 игрока — лидер сверху с короной)
function buildLeaderboardHtml(game) {
    const rows = (gameScoresCache[game] || []).slice().sort((a, b) => b.score - a.score);
    if (rows.length === 0) {
        return `<p class="game-leaderboard-empty">Рекордов пока нет — сыграйте первыми!</p>`;
    }
    return `<div class="leaderboard">` + rows.map((r, i) => `
        <div class="leaderboard-row${i === 0 ? ' leaderboard-leader' : ''}">
            <span class="leaderboard-name">${i === 0 ? '🏆 ' : ''}${r.username}</span>
            <span class="leaderboard-score">${r.score}</span>
        </div>
    `).join('') + `</div>`;
}

// Единая навигация для экрана игр: "⬅️ Игры" (если внутри конкретной игры) + "🏠 Домой"
function setGamesNav(showBackToMenu) {
    let oldNav = document.querySelector(".navigation");
    if (oldNav) oldNav.remove();

    let nav = document.createElement("div");
    nav.className = "navigation";

    if (showBackToMenu) {
        let backBtn = document.createElement("button");
        backBtn.textContent = "⬅️ Игры";
        backBtn.onclick = () => showGamesScreen();
        nav.appendChild(backBtn);
    }

    let homeBtn = document.createElement("button");
    homeBtn.textContent = "🏠 Домой";
    homeBtn.onclick = () => showHome();
    nav.appendChild(homeBtn);

    let containerEl = document.querySelector(".container");
    if (containerEl) {
        containerEl.insertBefore(nav, containerEl.firstChild);
    } else {
        document.body.insertBefore(nav, app);
    }
}

// Показывает окно "Игра окончена" с результатом и кнопками "Заново"/"К играм"
function showGameOverModal(score, isRecord, onRestart) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "gameOverModal";
    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3>${isRecord ? "🏆 Новый рекорд!" : "Игра окончена"}</h3>
            <p style="font-size: 22px; font-weight: bold; color:#9b4f70; margin: 10px 0 20px;">Счёт: ${score}</p>
            <div class="action-buttons" style="display: flex; flex-direction: column; gap: 10px;">
                <button id="gameOverRestart" class="btn-pink-style">🔁 Заново</button>
                <button id="gameOverMenu" class="btn-action-cancel">🕹 К играм</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector("#gameOverRestart").onclick = () => { overlay.remove(); onRestart(); };
    overlay.querySelector("#gameOverMenu").onclick = () => { overlay.remove(); showGamesScreen(); };
}

// Экран выбора игры со сводными таблицами лидеров
async function showGamesScreen() {
    startTransitionLock();
    isChatScreenOpen = false;
    currentWatchedBucket = null;
    isWishlistScreenOpen = false;
    if (chatPollInterval) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
    }
    if (activeGameCleanup) {
        activeGameCleanup();
        activeGameCleanup = null;
    }
    currentCategoryName = null;

    app.innerHTML = "";

    let title = document.createElement("h1");
    title.textContent = "🕹 Игры";
    app.appendChild(title);

    let container = document.createElement("div");
    container.id = "gamesContainer";
    container.innerHTML = `<p style="text-align:center;color:#999;font-size:13px;">Загрузка рекордов...</p>`;
    app.appendChild(container);

    setGamesNav(false);

    await loadGameScores();
    if (!container.isConnected) return;

    container.innerHTML = `
        <div class="game-card">
            <div class="game-card-header">🐍 Змейка</div>
            ${buildLeaderboardHtml('snake')}
            <button id="playSnakeBtn" class="btn-games-green">▶️ Играть</button>
        </div>
        <div class="game-card">
            <div class="game-card-header">🐤 Flappy Bird</div>
            ${buildLeaderboardHtml('flappy')}
            <button id="playFlappyBtn" class="btn-games-green">▶️ Играть</button>
        </div>
        <div class="game-card">
            <div class="game-card-header">🐰 Doodle Jump</div>
            ${buildLeaderboardHtml('doodle')}
            <button id="playDoodleBtn" class="btn-games-green">▶️ Играть</button>
        </div>
    `;

    container.querySelector("#playSnakeBtn").onclick = () => startSnakeGame();
    container.querySelector("#playFlappyBtn").onclick = () => startFlappyGame();
    container.querySelector("#playDoodleBtn").onclick = () => startDoodleGame();
}

// ------------------------- ЗМЕЙКА -------------------------
function startSnakeGame() {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);

    app.innerHTML = "";
    let title = document.createElement("h1");
    title.textContent = "🐍 Змейка";
    title.style.marginBottom = "5px";
    app.appendChild(title);

    const GRID = 15;
    const CELL = 18;
    const SIZE = GRID * CELL;
    const TICK_MS = 170; // было 140 — чуть замедлили змейку, чтобы было комфортнее играть

    let wrap = document.createElement("div");
    wrap.className = "game-wrap";
    wrap.innerHTML = `
        <div class="game-score-row">Счёт: <span id="snakeScore">0</span> &nbsp;•&nbsp; Рекорд: <span id="snakeBest">${getMyBest('snake')}</span></div>
        <canvas id="snakeCanvas" width="${SIZE}" height="${SIZE}" class="game-canvas"></canvas>
        <div class="dpad">
            <button class="dpad-btn dpad-up">▲</button>
            <div class="dpad-mid">
                <button class="dpad-btn dpad-left">◀</button>
                <button class="dpad-btn dpad-down">▼</button>
                <button class="dpad-btn dpad-right">▶</button>
            </div>
        </div>
    `;
    app.appendChild(wrap);

    const canvas = wrap.querySelector("#snakeCanvas");
    const ctx = canvas.getContext("2d");
    const scoreEl = wrap.querySelector("#snakeScore");
    const bestEl = wrap.querySelector("#snakeBest");

    let snake, dir, nextDir, food, score, tickInterval, gameOver;

    function randomFood() {
        let cell;
        do {
            cell = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
        } while (snake.some(s => s.x === cell.x && s.y === cell.y));
        return cell;
    }

    function resetState() {
        snake = [{ x: 7, y: 7 }, { x: 6, y: 7 }, { x: 5, y: 7 }];
        dir = { x: 1, y: 0 };
        nextDir = { x: 1, y: 0 };
        food = randomFood();
        score = 0;
        gameOver = false;
        scoreEl.textContent = "0";
    }

    function roundedRectPath(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function drawBoard() {
        // Мягкая шахматная "садовая" клетка вместо плоской заливки
        for (let gy = 0; gy < GRID; gy++) {
            for (let gx = 0; gx < GRID; gx++) {
                ctx.fillStyle = (gx + gy) % 2 === 0 ? "#eef7ee" : "#e3f2e3";
                ctx.fillRect(gx * CELL, gy * CELL, CELL, CELL);
            }
        }
    }

    function drawFood() {
        const cx = food.x * CELL + CELL / 2;
        const cy = food.y * CELL + CELL / 2 + 1;
        const r = CELL / 2.6;

        // Яблочко: тело + блик + листик + хвостик
        ctx.fillStyle = "#e53935";
        ctx.beginPath();
        ctx.arc(cx - r * 0.15, cy, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.beginPath();
        ctx.arc(cx - r * 0.55, cy - r * 0.5, r * 0.28, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = "#6d4c2b";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + 1, cy - r - 3);
        ctx.stroke();

        ctx.fillStyle = "#4caf50";
        ctx.beginPath();
        ctx.ellipse(cx + 3, cy - r - 2, 3.2, 1.8, -0.6, 0, Math.PI * 2);
        ctx.fill();
    }

    function drawSnake() {
        const n = snake.length;
        snake.forEach((seg, i) => {
            const t = n > 1 ? i / (n - 1) : 0;
            // Плавный градиент от тёмно-зелёной головы к светлому кончику хвоста
            const rCol = Math.round(46 + t * (165 - 46));
            const gCol = Math.round(125 + t * (214 - 125));
            const bCol = Math.round(50 + t * (167 - 50));
            ctx.fillStyle = `rgb(${rCol},${gCol},${bCol})`;
            roundedRectPath(seg.x * CELL + 1, seg.y * CELL + 1, CELL - 2, CELL - 2, i === 0 ? 6 : 5);
            ctx.fill();
        });

        // Мордочка на голове: глаза + маленький раздвоенный язычок по направлению движения
        const head = snake[0];
        const hx = head.x * CELL + CELL / 2;
        const hy = head.y * CELL + CELL / 2;
        const ex = dir.y !== 0 ? CELL * 0.22 : 0;
        const ey = dir.x !== 0 ? CELL * 0.22 : 0;

        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(hx - ex + dir.x * 2, hy - ey + dir.y * 2, 2.4, 0, Math.PI * 2);
        ctx.arc(hx + ex + dir.x * 2, hy + ey + dir.y * 2, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1b3a1b";
        ctx.beginPath();
        ctx.arc(hx - ex + dir.x * 3, hy - ey + dir.y * 3, 1.1, 0, Math.PI * 2);
        ctx.arc(hx + ex + dir.x * 3, hy + ey + dir.y * 3, 1.1, 0, Math.PI * 2);
        ctx.fill();

        const tipX = hx + dir.x * (CELL / 2 + 5);
        const tipY = hy + dir.y * (CELL / 2 + 5);
        const baseX = hx + dir.x * (CELL / 2);
        const baseY = hy + dir.y * (CELL / 2);
        ctx.strokeStyle = "#c62828";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(baseX, baseY);
        ctx.lineTo(tipX, tipY);
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX + dir.y * 2.5, tipY + dir.x * 2.5);
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - dir.y * 2.5, tipY - dir.x * 2.5);
        ctx.stroke();
    }

    function draw() {
        drawBoard();
        drawFood();
        drawSnake();
    }

    function tick() {
        if (gameOver) return;
        dir = nextDir;
        const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

        if (head.x < 0 || head.x >= GRID || head.y < 0 || head.y >= GRID ||
            snake.some(s => s.x === head.x && s.y === head.y)) {
            endGame();
            return;
        }

        snake.unshift(head);

        if (head.x === food.x && head.y === food.y) {
            score++;
            scoreEl.textContent = String(score);
            food = randomFood();
        } else {
            snake.pop();
        }

        draw();
    }

    async function endGame() {
        gameOver = true;
        clearInterval(tickInterval);
        const isRecord = await saveGameScore('snake', score);
        if (isRecord) bestEl.textContent = String(score);
        showGameOverModal(score, isRecord, () => {
            resetState();
            draw();
            tickInterval = setInterval(tick, TICK_MS);
        });
    }

    function setDirection(x, y) {
        if (dir.x === -x && dir.y === -y) return; // запрещаем разворот на 180°
        nextDir = { x, y };
    }

    function keyHandler(e) {
        const map = {
            ArrowUp: [0, -1], KeyW: [0, -1],
            ArrowDown: [0, 1], KeyS: [0, 1],
            ArrowLeft: [-1, 0], KeyA: [-1, 0],
            ArrowRight: [1, 0], KeyD: [1, 0]
        };
        const move = map[e.code];
        if (move) { e.preventDefault(); setDirection(move[0], move[1]); }
    }
    document.addEventListener("keydown", keyHandler);

    wrap.querySelector(".dpad-up").onclick = () => setDirection(0, -1);
    wrap.querySelector(".dpad-down").onclick = () => setDirection(0, 1);
    wrap.querySelector(".dpad-left").onclick = () => setDirection(-1, 0);
    wrap.querySelector(".dpad-right").onclick = () => setDirection(1, 0);

    // Свайпы прямо по канвасу — как альтернатива D-pad'у на мобильных
    let touchStartX = 0, touchStartY = 0;
    canvas.addEventListener("touchstart", (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: true });
    canvas.addEventListener("touchend", (e) => {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        if (Math.abs(dx) > Math.abs(dy)) {
            if (Math.abs(dx) > 20) setDirection(dx > 0 ? 1 : -1, 0);
        } else {
            if (Math.abs(dy) > 20) setDirection(0, dy > 0 ? 1 : -1);
        }
    }, { passive: true });

    resetState();
    draw();
    tickInterval = setInterval(tick, TICK_MS);

    activeGameCleanup = () => {
        clearInterval(tickInterval);
        document.removeEventListener("keydown", keyHandler);
    };
}

// ------------------------- FLAPPY BIRD -------------------------
function startFlappyGame() {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);

    app.innerHTML = "";
    let title = document.createElement("h1");
    title.textContent = "🐤 Flappy Bird";
    title.style.marginBottom = "5px";
    app.appendChild(title);

    const W = 300, H = 420;
    const GROUND_H = 32;
    const GRAVITY = 1500;   // px/с²
    const JUMP_V = -420;    // px/с
    const PIPE_W = 50;
    const GAP = 140;
    const PIPE_SPEED = 130;    // px/с
    const PIPE_INTERVAL = 1500; // мс
    const BIRD_W = 42, BIRD_H = 36; // размер спрайта-головы на канвасе
    const BIRD_R = 16;              // радиус для проверки столкновений

    let wrap = document.createElement("div");
    wrap.className = "game-wrap";
    wrap.innerHTML = `
        <div class="game-score-row">Счёт: <span id="flappyScore">0</span> &nbsp;•&nbsp; Рекорд: <span id="flappyBest">${getMyBest('flappy')}</span></div>
        <canvas id="flappyCanvas" width="${W}" height="${H}" class="game-canvas"></canvas>
        <p class="game-hint">Тапни по экрану / кликни / нажми Пробел, чтобы взлететь</p>
    `;
    app.appendChild(wrap);

    const canvas = wrap.querySelector("#flappyCanvas");
    const ctx = canvas.getContext("2d");
    const scoreEl = wrap.querySelector("#flappyScore");
    const bestEl = wrap.querySelector("#flappyBest");

    let birdY, birdV, pipes, score, gameOver, lastTime, rafId, spawnTimer, started, bgOffset;

    function reset() {
        birdY = H / 2;
        birdV = 0;
        pipes = [];
        score = 0;
        gameOver = false;
        started = false;
        spawnTimer = 0;
        lastTime = null;
        bgOffset = 0;
        scoreEl.textContent = "0";
    }

    function spawnPipe() {
        const minTop = 40;
        const maxTop = H - GROUND_H - GAP - 40;
        const gapY = minTop + Math.random() * (maxTop - minTop);
        pipes.push({ x: W, gapY, passed: false });
    }

    // ---- Небо с солнцем и облаками ----
    function drawSky() {
        const skyGrad = ctx.createLinearGradient(0, 0, 0, H - GROUND_H);
        skyGrad.addColorStop(0, "#bfe9ff");
        skyGrad.addColorStop(1, "#eaf8ff");
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, W, H - GROUND_H);

        ctx.fillStyle = "rgba(255, 235, 150, 0.85)";
        ctx.beginPath();
        ctx.arc(W - 45, 42, 22, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "rgba(255,255,255,0.85)";
        for (let i = 0; i < 3; i++) {
            const raw = (i * 140 + 60 - bgOffset * 0.4) % (W + 120);
            const cx = (raw < 0 ? raw + W + 120 : raw) - 60;
            const cy = 55 + i * 45;
            drawCloud(cx, cy);
        }
    }

    function drawCloud(cx, cy) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, 18, 11, 0, 0, Math.PI * 2);
        ctx.ellipse(cx + 14, cy - 5, 14, 10, 0, 0, Math.PI * 2);
        ctx.ellipse(cx - 14, cy - 3, 13, 9, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    // ---- Шоколадные батончики вместо труб ----
    function drawChocolateBar(x, y, w, h, edge) {
        if (h <= 0) return;
        const grad = ctx.createLinearGradient(x, 0, x + w, 0);
        grad.addColorStop(0, "#4a2f21");
        grad.addColorStop(0.35, "#7b4b32");
        grad.addColorStop(0.55, "#8a5738");
        grad.addColorStop(1, "#5b3a29");
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);

        // канавки-дольки шоколадки
        ctx.strokeStyle = "rgba(0,0,0,0.28)";
        ctx.lineWidth = 2;
        for (let gy = 0; gy < h; gy += 22) {
            ctx.beginPath();
            ctx.moveTo(x + 3, y + gy);
            ctx.lineTo(x + w - 3, y + gy);
            ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w / 2, y + h);
        ctx.stroke();

        // лёгкий блик слева
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(x + 2, y, 5, h);

        // неровный "отломанный" край со стороны просвета
        const teeth = 6, amp = 5;
        ctx.fillStyle = "rgba(0,0,0,0.18)";
        ctx.beginPath();
        if (edge === "bottom") {
            const baseY = y + h;
            ctx.moveTo(x, baseY);
            for (let i = 0; i <= teeth; i++) {
                ctx.lineTo(x + (w / teeth) * i, baseY - (i % 2 === 0 ? 0 : amp));
            }
            ctx.lineTo(x + w, baseY);
        } else {
            const baseY = y;
            ctx.moveTo(x, baseY);
            for (let i = 0; i <= teeth; i++) {
                ctx.lineTo(x + (w / teeth) * i, baseY + (i % 2 === 0 ? 0 : amp));
            }
            ctx.lineTo(x + w, baseY);
        }
        ctx.closePath();
        ctx.fill();
    }

    // ---- Цветочное поле вместо земли ----
    function drawFlowerField() {
        const gy = H - GROUND_H;
        const grad = ctx.createLinearGradient(0, gy, 0, H);
        grad.addColorStop(0, "#8bc34a");
        grad.addColorStop(1, "#558b2f");
        ctx.fillStyle = grad;
        ctx.fillRect(0, gy, W, GROUND_H);

        const colors = ["#ffffff", "#ffeb3b", "#ff8fab", "#ba68c8"];
        const spacing = 26;
        const scrollX = bgOffset * 0.5;
        for (let x = -spacing; x < W + spacing * 2; x += spacing) {
            const raw = (x - scrollX) % (W + spacing);
            const fx = (raw < 0 ? raw + W + spacing : raw) - spacing / 2;
            const seed = Math.floor((x + 10000) / spacing);
            const fy = gy + 9 + (seed % 3) * 7;
            const color = colors[seed % colors.length];

            ctx.strokeStyle = "#3d7a1f";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(fx, fy + 5);
            ctx.lineTo(fx, fy + 11);
            ctx.stroke();

            ctx.fillStyle = color;
            for (let p = 0; p < 4; p++) {
                const ang = (Math.PI / 2) * p + 0.4;
                ctx.beginPath();
                ctx.arc(fx + Math.cos(ang) * 3, fy + Math.sin(ang) * 3, 2.6, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.fillStyle = "#ffb300";
            ctx.beginPath();
            ctx.arc(fx, fy, 1.8, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function draw() {
        drawSky();

        pipes.forEach(p => {
            drawChocolateBar(p.x, 0, PIPE_W, p.gapY, "bottom");
            drawChocolateBar(p.x, p.gapY + GAP, PIPE_W, H - GROUND_H - (p.gapY + GAP), "top");
        });

        drawFlowerField();

        // Птичка — голова с фотографии профиля
        ctx.save();
        ctx.translate(50, birdY);
        ctx.rotate(Math.max(-0.4, Math.min(0.9, birdV / 600)));
        if (flappyBirdImg.complete && flappyBirdImg.naturalWidth > 0) {
            ctx.drawImage(flappyBirdImg, -BIRD_W / 2, -BIRD_H / 2, BIRD_W, BIRD_H);
        } else {
            ctx.fillStyle = "#fbc02d";
            ctx.beginPath();
            ctx.arc(0, 0, 12, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

        if (!started) {
            ctx.fillStyle = "rgba(0,0,0,0.55)";
            ctx.font = "14px Arial";
            ctx.textAlign = "center";
            ctx.fillText("Тапни, чтобы начать", W / 2, H / 2 - 40);
        }
    }

    function checkCollision() {
        const birdX = 50, r = BIRD_R;
        if (birdY + r >= H - GROUND_H || birdY - r <= 0) return true;
        return pipes.some(p =>
            birdX + r > p.x && birdX - r < p.x + PIPE_W &&
            (birdY - r < p.gapY || birdY + r > p.gapY + GAP)
        );
    }

    function loop(time) {
        if (gameOver) return;
        if (!lastTime) lastTime = time;
        const dt = Math.min(0.05, (time - lastTime) / 1000);
        lastTime = time;

        if (started) {
            birdV += GRAVITY * dt;
            birdY += birdV * dt;
            bgOffset += PIPE_SPEED * dt;

            spawnTimer += dt * 1000;
            if (spawnTimer >= PIPE_INTERVAL) {
                spawnTimer = 0;
                spawnPipe();
            }

            pipes.forEach(p => { p.x -= PIPE_SPEED * dt; });
            pipes = pipes.filter(p => p.x > -PIPE_W);

            pipes.forEach(p => {
                if (!p.passed && p.x + PIPE_W < 50) {
                    p.passed = true;
                    score++;
                    scoreEl.textContent = String(score);
                }
            });

            if (checkCollision()) {
                endGame();
                return;
            }
        }

        draw();
        rafId = requestAnimationFrame(loop);
    }

    async function endGame() {
        gameOver = true;
        cancelAnimationFrame(rafId);
        const isRecord = await saveGameScore('flappy', score);
        if (isRecord) bestEl.textContent = String(score);
        showGameOverModal(score, isRecord, () => {
            reset();
            draw();
            rafId = requestAnimationFrame(loop);
        });
    }

    function jump() {
        if (gameOver) return;
        started = true;
        birdV = JUMP_V;
    }

    function keyHandler(e) {
        if (e.code === "Space") { e.preventDefault(); jump(); }
    }
    document.addEventListener("keydown", keyHandler);
    canvas.addEventListener("mousedown", jump);
    canvas.addEventListener("touchstart", (e) => { e.preventDefault(); jump(); }, { passive: false });

    reset();
    draw();
    rafId = requestAnimationFrame(loop);

    activeGameCleanup = () => {
        gameOver = true;
        cancelAnimationFrame(rafId);
        document.removeEventListener("keydown", keyHandler);
    };
}

// ------------------------- DOODLE JUMP -------------------------
// Персонаж и все "текстуры" (платформы, облачка, фон) нарисованы кодом
// (canvas-графика), без внешних картинок — как и остальные игры на сайте.
function startDoodleGame() {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);

    app.innerHTML = "";
    let title = document.createElement("h1");
    title.textContent = "🐰 Doodle Jump";
    title.style.marginBottom = "5px";
    app.appendChild(title);

    const W = 300, H = 420;
    const GRAVITY = 1100;       // px/с²
    const JUMP_V = -520;        // px/с — импульс подскока при приземлении на платформу
    const MOVE_SPEED = 210;     // px/с — горизонтальная скорость персонажа
    const PLAT_W = 58, PLAT_H = 13;
    const DOODLER_W = 34, DOODLER_H = 34;
    const ANCHOR_Y = H * 0.42;  // выше этой линии экран "скроллится" вниз, а не герой лезет выше

    let wrap = document.createElement("div");
    wrap.className = "game-wrap";
    wrap.innerHTML = `
        <div class="game-score-row">Счёт: <span id="doodleScore">0</span> &nbsp;•&nbsp; Рекорд: <span id="doodleBest">${getMyBest('doodle')}</span></div>
        <canvas id="doodleCanvas" width="${W}" height="${H}" class="game-canvas"></canvas>
        <div class="dpad">
            <div class="dpad-mid">
                <button class="dpad-btn dpad-left">◀</button>
                <button class="dpad-btn dpad-right">▶</button>
            </div>
        </div>
        <p class="game-hint">Стрелки ◀ ▶ / A D, или кнопки ниже — герой прыгает сам</p>
    `;
    app.appendChild(wrap);

    const canvas = wrap.querySelector("#doodleCanvas");
    const ctx = canvas.getContext("2d");
    const scoreEl = wrap.querySelector("#doodleScore");
    const bestEl = wrap.querySelector("#doodleBest");

    let x, y, vx, vy, facing, platforms, score, scrollTotal, gameOver, lastTime, rafId, movingLeft, movingRight;

    function makePlatform(px, py, moving) {
        return {
            x: px, y: py, w: PLAT_W, h: PLAT_H,
            moving: !!moving,
            vx: moving ? (Math.random() < 0.5 ? -60 : 60) : 0
        };
    }

    function topmostY() {
        return platforms.reduce((min, p) => Math.min(min, p.y), Infinity);
    }

    function maybeSpawnPlatforms() {
        while (topmostY() > -20) {
            const py = topmostY() - (50 + Math.random() * 45);
            const px = 10 + Math.random() * (W - 20 - PLAT_W);
            const moving = Math.random() < 0.2;
            platforms.push(makePlatform(px, py, moving));
        }
    }

    function reset() {
        x = W / 2;
        vx = 0;
        facing = 1;
        score = 0;
        scrollTotal = 0;
        gameOver = false;
        movingLeft = false;
        movingRight = false;
        lastTime = null;
        scoreEl.textContent = "0";

        platforms = [makePlatform(x - PLAT_W / 2, H - 30, false)];
        maybeSpawnPlatforms();

        // Герой стартует как будто только что оттолкнулся от первой платформы
        y = H - 30 - DOODLER_H / 2 - 2;
        vy = JUMP_V;
    }

    function roundedRect(rx, ry, rw, rh, r) {
        ctx.beginPath();
        ctx.moveTo(rx + r, ry);
        ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, r);
        ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
        ctx.arcTo(rx, ry + rh, rx, ry, r);
        ctx.arcTo(rx, ry, rx + rw, ry, r);
        ctx.closePath();
    }

    // ---- Персонаж-doodler, нарисованный самостоятельно ----
    function drawDoodler() {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(facing, 1);

        // усики-антенны
        ctx.strokeStyle = "#c98fb0";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-6, -DOODLER_H / 2 + 2);
        ctx.lineTo(-10, -DOODLER_H / 2 - 9);
        ctx.moveTo(6, -DOODLER_H / 2 + 2);
        ctx.lineTo(10, -DOODLER_H / 2 - 9);
        ctx.stroke();
        ctx.fillStyle = "#ffb6d5";
        ctx.beginPath();
        ctx.arc(-10, -DOODLER_H / 2 - 9, 2.6, 0, Math.PI * 2);
        ctx.arc(10, -DOODLER_H / 2 - 9, 2.6, 0, Math.PI * 2);
        ctx.fill();

        // тело
        ctx.fillStyle = "#f7a8c4";
        ctx.beginPath();
        ctx.ellipse(0, 0, DOODLER_W / 2, DOODLER_H / 2, 0, 0, Math.PI * 2);
        ctx.fill();

        // ножки
        ctx.fillStyle = "#e589ac";
        ctx.beginPath();
        ctx.ellipse(-8, DOODLER_H / 2 - 3, 6, 4, 0, 0, Math.PI * 2);
        ctx.ellipse(8, DOODLER_H / 2 - 3, 6, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        // глаза (смотрят по направлению движения)
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(6, -4, 6, 0, Math.PI * 2);
        ctx.arc(-4, -6, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#3a2733";
        ctx.beginPath();
        ctx.arc(8, -4, 2.6, 0, Math.PI * 2);
        ctx.arc(-3, -6, 2.2, 0, Math.PI * 2);
        ctx.fill();

        // улыбка
        ctx.strokeStyle = "#a4436a";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(2, 3, 5, 0.15 * Math.PI, 0.75 * Math.PI);
        ctx.stroke();

        ctx.restore();
    }

    function drawPlatform(p) {
        const grad = ctx.createLinearGradient(0, p.y, 0, p.y + p.h);
        if (p.moving) {
            grad.addColorStop(0, "#81d4fa");
            grad.addColorStop(1, "#4fc3f7");
        } else {
            grad.addColorStop(0, "#aee571");
            grad.addColorStop(1, "#7cb342");
        }
        ctx.fillStyle = grad;
        roundedRect(p.x, p.y, p.w, p.h, 6);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        roundedRect(p.x + 3, p.y + 2, p.w - 6, 3, 2);
        ctx.fill();
    }

    function drawBackground() {
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, "#dcecff");
        grad.addColorStop(1, "#f3e9ff");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // лёгкий параллакс-фон из облачков
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        for (let i = 0; i < 5; i++) {
            const cy = ((i * 130 + scrollTotal * 0.15) % (H + 100)) - 50;
            const cx = 40 + (i * 61) % (W - 80);
            ctx.beginPath();
            ctx.ellipse(cx, cy, 16, 9, 0, 0, Math.PI * 2);
            ctx.ellipse(cx + 12, cy - 4, 11, 8, 0, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function draw() {
        drawBackground();
        platforms.forEach(drawPlatform);
        drawDoodler();
    }

    function update(dt) {
        if (movingLeft && !movingRight) { vx = -MOVE_SPEED; facing = -1; }
        else if (movingRight && !movingLeft) { vx = MOVE_SPEED; facing = 1; }
        else vx = 0;

        const half = DOODLER_W / 2;
        x += vx * dt;
        if (x < -half) x = W + half;
        if (x > W + half) x = -half;

        vy += GRAVITY * dt;
        const prevY = y;
        y += vy * dt;

        // приземление на платформу (только когда падаем вниз)
        if (vy > 0) {
            for (const p of platforms) {
                const feetPrev = prevY + DOODLER_H / 2;
                const feetNow = y + DOODLER_H / 2;
                const withinX = x + half * 0.6 > p.x && x - half * 0.6 < p.x + p.w;
                if (withinX && feetPrev <= p.y && feetNow >= p.y) {
                    y = p.y - DOODLER_H / 2;
                    vy = JUMP_V;
                    break;
                }
            }
        }

        // движущиеся платформы
        platforms.forEach(p => {
            if (p.moving) {
                p.x += p.vx * dt;
                if (p.x < 6) { p.x = 6; p.vx *= -1; }
                if (p.x + p.w > W - 6) { p.x = W - 6 - p.w; p.vx *= -1; }
            }
        });

        // скроллинг мира вниз (визуально — герой карабкается выше), когда герой поднимается выше anchor-линии
        if (y < ANCHOR_Y) {
            const dy = ANCHOR_Y - y;
            y = ANCHOR_Y;
            platforms.forEach(p => { p.y += dy; });
            scrollTotal += dy;
            score = Math.floor(scrollTotal / 10);
            scoreEl.textContent = String(score);
        }

        platforms = platforms.filter(p => p.y < H + 20);
        maybeSpawnPlatforms();

        if (y - DOODLER_H / 2 > H) {
            endGame();
        }
    }

    function loop(time) {
        if (gameOver) return;
        if (!lastTime) lastTime = time;
        const dt = Math.min(0.05, (time - lastTime) / 1000);
        lastTime = time;

        update(dt);
        draw();
        rafId = requestAnimationFrame(loop);
    }

    async function endGame() {
        gameOver = true;
        cancelAnimationFrame(rafId);
        const isRecord = await saveGameScore('doodle', score);
        if (isRecord) bestEl.textContent = String(score);
        showGameOverModal(score, isRecord, () => {
            reset();
            draw();
            rafId = requestAnimationFrame(loop);
        });
    }

    function keyHandler(e) {
        if (e.code === "ArrowLeft" || e.code === "KeyA") { e.preventDefault(); movingLeft = true; }
        if (e.code === "ArrowRight" || e.code === "KeyD") { e.preventDefault(); movingRight = true; }
    }
    function keyUpHandler(e) {
        if (e.code === "ArrowLeft" || e.code === "KeyA") movingLeft = false;
        if (e.code === "ArrowRight" || e.code === "KeyD") movingRight = false;
    }
    document.addEventListener("keydown", keyHandler);
    document.addEventListener("keyup", keyUpHandler);

    function bindHold(btn, onDown, onUp) {
        btn.addEventListener("mousedown", (e) => { e.preventDefault(); onDown(); });
        btn.addEventListener("touchstart", (e) => { e.preventDefault(); onDown(); }, { passive: false });
        btn.addEventListener("mouseup", onUp);
        btn.addEventListener("mouseleave", onUp);
        btn.addEventListener("touchend", onUp);
    }
    bindHold(wrap.querySelector(".dpad-left"), () => { movingLeft = true; }, () => { movingLeft = false; });
    bindHold(wrap.querySelector(".dpad-right"), () => { movingRight = true; }, () => { movingRight = false; });

    // Тап по канвасу — тоже управление: держим левую/правую половину экрана
    canvas.addEventListener("touchstart", (e) => {
        const rect = canvas.getBoundingClientRect();
        const tx = e.touches[0].clientX - rect.left;
        if (tx < rect.width / 2) movingLeft = true; else movingRight = true;
    }, { passive: true });
    canvas.addEventListener("touchend", () => { movingLeft = false; movingRight = false; }, { passive: true });

    reset();
    draw();
    rafId = requestAnimationFrame(loop);

    activeGameCleanup = () => {
        gameOver = true;
        cancelAnimationFrame(rafId);
        document.removeEventListener("keydown", keyHandler);
        document.removeEventListener("keyup", keyUpHandler);
    };
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
        // В режиме Эчпочмони сердечки заменяются на озорной эмодзи 😈
        heart.innerHTML = isDarkTheme ? '😈' : '❤️';

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
