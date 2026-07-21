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
//   game text check (game in ('snake','flappy','doodle','runner')),
//   best_score integer default 0,
//   updated_at timestamptz default now(),
//   primary key (user_id, game)
// );
//
// Если таблица у вас уже создана под старую версию (без 'runner'),
// добавить новую игру "Брокколи-раннер" в таблицу лидеров можно так
// (выполнить один раз в SQL editor):
//
// alter table game_scores drop constraint game_scores_game_check;
// alter table game_scores add constraint game_scores_game_check check (game in ('snake','flappy','doodle','runner'));
//
// (RLS можно не включать, как и для остальных таблиц в этом проекте —
// либо настроить так же, как у таблицы ratings/comments.)

let gameScoresCache = { snake: [], flappy: [], doodle: [], runner: [] };
let activeGameCleanup = null; // остановка текущей запущенной игры (интервалы/rAF/слушатели), если она есть

// ------------------------- СПРАЙТ ПТИЧКИ ДЛЯ FLAPPY BIRD -------------------------
// Голова с фото профиля (вырезана, фон убран) — используется как спрайт птички.
// Хранится прямо в коде как base64-картинка, чтобы не заводить отдельную папку
// с текстурами на GitHub и не зависеть от внешних файлов/хостинга.
const FLAPPY_BIRD_HEAD_B64 = "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";
const flappyBirdImg = new Image();
flappyBirdImg.src = "data:image/png;base64," + FLAPPY_BIRD_HEAD_B64;

// ------------------------- СПРАЙТ БЕГУНА ДЛЯ БРОККОЛИ-РАННЕРА -------------------------
// Фото персонажа в беге (вырезано, фон убран) — используется как спрайт бегущего героя.
// Хранится прямо в коде как base64-картинка, по той же схеме, что и голова птички выше.
const RUNNER_CHAR_B64 = "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";
const runnerCharImg = new Image();
runnerCharImg.src = "data:image/png;base64," + RUNNER_CHAR_B64;

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
            <div class="game-card-header">🍫 Эчпочмоня vs. Шоколадки</div>
            ${buildLeaderboardHtml('flappy')}
            <button id="playFlappyBtn" class="btn-games-green">▶️ Играть</button>
        </div>
        <div class="game-card">
            <div class="game-card-header">👾 Doodle Jump</div>
            ${buildLeaderboardHtml('doodle')}
            <button id="playDoodleBtn" class="btn-games-green">▶️ Играть</button>
        </div>
        <div class="game-card">
            <div class="game-card-header">🥦 Бега Брокколи</div>
            ${buildLeaderboardHtml('runner')}
            <button id="playRunnerBtn" class="btn-games-green">▶️ Играть</button>
        </div>
    `;

    container.querySelector("#playSnakeBtn").onclick = () => startSnakeGame();
    container.querySelector("#playFlappyBtn").onclick = () => startFlappyGame();
    container.querySelector("#playDoodleBtn").onclick = () => startDoodleGame();
    container.querySelector("#playRunnerBtn").onclick = () => startRunnerGame();
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
    title.textContent = "🍫 Эчпочмоня vs. Шоколадки";
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
    title.textContent = "👾 Doodle Jump";
    title.style.marginBottom = "5px";
    app.appendChild(title);

    const W = 300, H = 420;
    const GRAVITY = 1100;       // px/с²
    const JUMP_V = -520;        // px/с — импульс подскока при приземлении на платформу
    const MOVE_SPEED = 210;     // px/с — горизонтальная скорость персонажа
    const PLAT_W = 58, PLAT_H = 13;
    const DOODLER_W = 34, DOODLER_H = 34;
    const ANCHOR_Y = H * 0.42;  // выше этой линии экран "скроллится" вниз, а не герой лезет выше

    // --- Новое: стрельба, монстры, броня, ракета ---
    const BULLET_SPEED = 620;       // px/с — скорость полёта пули вверх
    const SHOOT_COOLDOWN = 0.28;    // с — минимальный интервал между выстрелами
    const ROCKET_SPEED = 900;       // px/с — скорость подъёма на ракете
    const ROCKET_DURATION = 2.2;    // с — сколько длится полёт на ракете
    const ARMOR_DURATION = 5;       // с — сколько живёт броня
    const ARMOR_MAX_CHARGES = 5;    // сколько столкновений с монстрами держит броня
    const ARMOR_BLINK_AT = 1.4;     // с — за сколько до конца брони начинать моргать

    let wrap = document.createElement("div");
    wrap.className = "game-wrap";
    wrap.innerHTML = `
        <div class="game-score-row">Счёт: <span id="doodleScore">0</span> &nbsp;•&nbsp; Рекорд: <span id="doodleBest">${getMyBest('doodle')}</span></div>
        <canvas id="doodleCanvas" width="${W}" height="${H}" class="game-canvas"></canvas>
        <div class="dpad">
            <div class="dpad-mid">
                <button class="dpad-btn dpad-left">◀</button>
                <button class="dpad-btn dpad-shoot" title="Стрелять">🔫</button>
                <button class="dpad-btn dpad-right">▶</button>
            </div>
        </div>
    `;
    app.appendChild(wrap);

    const canvas = wrap.querySelector("#doodleCanvas");
    const ctx = canvas.getContext("2d");
    const scoreEl = wrap.querySelector("#doodleScore");
    const bestEl = wrap.querySelector("#doodleBest");

    let x, y, vx, vy, facing, platforms, score, scrollTotal, gameOver, lastTime, rafId, movingLeft, movingRight;
    let monsters, bullets, powerups, monsterNextY, lastShotTime;
    let armorActive, armorCharges, armorTimer;
    let rocketActive, rocketTimer;

    function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
        return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
    }

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

    function makePowerup(type, plat) {
        return { type, x: plat.x + plat.w / 2, y: plat.y - 20, w: 20, h: 20, collected: false };
    }

    function maybeSpawnPlatforms() {
        while (topmostY() > -20) {
            const py = topmostY() - (50 + Math.random() * 45);
            const px = 10 + Math.random() * (W - 20 - PLAT_W);
            const moving = Math.random() < 0.2;
            const plat = makePlatform(px, py, moving);
            platforms.push(plat);

            // Изредка на платформе появляется бонус: чаще броня, очень редко — ракета
            if (!moving) {
                const roll = Math.random();
                if (roll < 0.025) {
                    powerups.push(makePowerup('rocket', plat));
                } else if (roll < 0.16) {
                    powerups.push(makePowerup('armor', plat));
                }
            }
        }
    }

    // ---- Монстры ----
    function makeMonster(my) {
        const types = ['bat', 'ghost', 'spiky'];
        const type = types[Math.floor(Math.random() * types.length)];
        const mx = 24 + Math.random() * (W - 48);
        const m = { type, baseX: mx, baseY: my, x: mx, y: my, phase: Math.random() * Math.PI * 2 };
        if (type === 'bat') {
            m.vx = Math.random() < 0.5 ? -75 : 75;
            m.w = 30; m.h = 20;
        } else if (type === 'ghost') {
            m.w = 26; m.h = 30;
        } else {
            m.vx = (Math.random() < 0.5 ? -1 : 1) * (55 + Math.random() * 45);
            m.w = 26; m.h = 26;
        }
        return m;
    }

    function maybeSpawnMonsters() {
        while (monsterNextY > -80) {
            const spawnY = monsterNextY;
            monsterNextY -= 220 + Math.random() * 260;
            if (Math.random() < 0.55) {
                monsters.push(makeMonster(spawnY));
            }
        }
    }

    function updateMonsters(dt) {
        monsters.forEach(m => {
            m.phase += dt;
            if (m.type === 'bat') {
                m.baseX += m.vx * dt;
                if (m.baseX < 16) { m.baseX = 16; m.vx *= -1; }
                if (m.baseX > W - 16) { m.baseX = W - 16; m.vx *= -1; }
                m.x = m.baseX;
                m.y = m.baseY + Math.sin(m.phase * 7) * 3;
            } else if (m.type === 'ghost') {
                m.x = m.baseX + Math.sin(m.phase * 1.3) * 22;
                m.y = m.baseY + Math.sin(m.phase * 2) * 10;
            } else {
                m.baseX += m.vx * dt;
                if (m.baseX < 15) { m.baseX = 15; m.vx *= -1; }
                if (m.baseX > W - 15) { m.baseX = W - 15; m.vx *= -1; }
                m.x = m.baseX;
                m.y = m.baseY + Math.sin(m.phase * 3.4) * 14;
            }
        });
    }

    function shoot() {
        if (gameOver) return;
        const now = performance.now() / 1000;
        if (now - lastShotTime < SHOOT_COOLDOWN) return;
        lastShotTime = now;
        bullets.push({ x, y: y - DOODLER_H / 2, vy: -BULLET_SPEED });
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

        monsters = [];
        bullets = [];
        powerups = [];
        monsterNextY = -140; // монстры не появляются в первые секунды игры
        lastShotTime = -999;

        armorActive = false;
        armorCharges = 0;
        armorTimer = 0;
        rocketActive = false;
        rocketTimer = 0;

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

    function drawMonster(m) {
        ctx.save();
        ctx.translate(m.x, m.y);
        if (m.type === 'bat') {
            const flap = Math.sin(m.phase * 10) * 6;
            ctx.fillStyle = "#5b3a73";
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.quadraticCurveTo(-18, -6 - flap, -22, 4);
            ctx.quadraticCurveTo(-10, 2, 0, 0);
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.quadraticCurveTo(18, -6 - flap, 22, 4);
            ctx.quadraticCurveTo(10, 2, 0, 0);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(0, 0, 10, 8, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#ff5252";
            ctx.beginPath();
            ctx.arc(-3, -1, 1.6, 0, Math.PI * 2);
            ctx.arc(3, -1, 1.6, 0, Math.PI * 2);
            ctx.fill();
        } else if (m.type === 'ghost') {
            ctx.fillStyle = "rgba(180, 220, 255, 0.88)";
            ctx.beginPath();
            ctx.arc(0, -2, 13, Math.PI, 0, false);
            ctx.lineTo(13, 10);
            ctx.lineTo(8, 4);
            ctx.lineTo(3, 10);
            ctx.lineTo(-3, 4);
            ctx.lineTo(-8, 10);
            ctx.lineTo(-13, 4);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = "#33445a";
            ctx.beginPath();
            ctx.arc(-5, -3, 2, 0, Math.PI * 2);
            ctx.arc(5, -3, 2, 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.rotate(m.phase * 2);
            ctx.strokeStyle = "#e64a19";
            ctx.lineWidth = 3;
            for (let i = 0; i < 8; i++) {
                const ang = (Math.PI / 4) * i;
                ctx.beginPath();
                ctx.moveTo(Math.cos(ang) * 9, Math.sin(ang) * 9);
                ctx.lineTo(Math.cos(ang) * 15, Math.sin(ang) * 15);
                ctx.stroke();
            }
            ctx.fillStyle = "#ff7043";
            ctx.beginPath();
            ctx.arc(0, 0, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#3a2733";
            ctx.beginPath();
            ctx.arc(-3, -1, 1.6, 0, Math.PI * 2);
            ctx.arc(3, -1, 1.6, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function drawPowerup(pu) {
        ctx.save();
        ctx.translate(pu.x, pu.y);
        if (pu.type === 'armor') {
            ctx.fillStyle = "#42a5f5";
            ctx.beginPath();
            ctx.moveTo(0, -10);
            ctx.lineTo(9, -6);
            ctx.lineTo(9, 3);
            ctx.quadraticCurveTo(9, 10, 0, 13);
            ctx.quadraticCurveTo(-9, 10, -9, 3);
            ctx.lineTo(-9, -6);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = "#e3f2fd";
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.fillStyle = "#e3f2fd";
            ctx.beginPath();
            ctx.moveTo(-3, 0);
            ctx.lineTo(0, 4);
            ctx.lineTo(5, -4);
            ctx.lineTo(3, -4);
            ctx.lineTo(0, 0);
            ctx.lineTo(-1, -2);
            ctx.closePath();
            ctx.fill();
        } else {
            ctx.fillStyle = "#ef5350";
            ctx.beginPath();
            ctx.moveTo(0, -13);
            ctx.quadraticCurveTo(7, -2, 6, 8);
            ctx.lineTo(-6, 8);
            ctx.quadraticCurveTo(-7, -2, 0, -13);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = "#ffca28";
            ctx.beginPath();
            ctx.moveTo(-6, 8);
            ctx.lineTo(-9, 13);
            ctx.lineTo(-3, 9);
            ctx.closePath();
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(6, 8);
            ctx.lineTo(9, 13);
            ctx.lineTo(3, 9);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = "#90caf9";
            ctx.beginPath();
            ctx.arc(0, -1, 3, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function drawBullet(b) {
        ctx.save();
        const grad = ctx.createLinearGradient(b.x, b.y - 8, b.x, b.y + 6);
        grad.addColorStop(0, "#fff59d");
        grad.addColorStop(1, "#ff8a65");
        ctx.fillStyle = grad;
        roundedRect(b.x - 3, b.y - 8, 6, 14, 3);
        ctx.fill();
        ctx.restore();
    }

    // Щит брони моргает перед истечением — отдельного таймера на экране нет,
    // сам щит и есть индикатор
    function drawArmorShield() {
        const blinking = armorTimer < ARMOR_BLINK_AT;
        const visible = !blinking || (Math.floor(armorTimer * 8) % 2 === 0);
        if (!visible) return;
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = "rgba(129, 212, 250, 0.18)";
        ctx.beginPath();
        ctx.arc(0, 0, DOODLER_W / 2 + 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(66, 165, 245, 0.9)";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.restore();
    }

    function drawRocketFlame() {
        ctx.save();
        ctx.translate(x, y + DOODLER_H / 2);
        const flicker = 8 + Math.random() * 6;
        ctx.fillStyle = "#ffb300";
        ctx.beginPath();
        ctx.moveTo(-6, 0);
        ctx.lineTo(6, 0);
        ctx.lineTo(0, flicker + 10);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#ff7043";
        ctx.beginPath();
        ctx.moveTo(-3.5, 0);
        ctx.lineTo(3.5, 0);
        ctx.lineTo(0, flicker + 4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    function drawRocketShell() {
        ctx.save();
        ctx.translate(x, y);
        ctx.strokeStyle = "rgba(255, 112, 67, 0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, DOODLER_W / 2 + 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    function draw() {
        drawBackground();
        platforms.forEach(drawPlatform);
        powerups.forEach(drawPowerup);
        monsters.forEach(drawMonster);
        bullets.forEach(drawBullet);
        if (rocketActive) drawRocketFlame();
        drawDoodler();
        if (armorActive) drawArmorShield();
        if (rocketActive) drawRocketShell();
    }

    function update(dt) {
        if (movingLeft && !movingRight) { vx = -MOVE_SPEED; facing = -1; }
        else if (movingRight && !movingLeft) { vx = MOVE_SPEED; facing = 1; }
        else vx = 0;

        const half = DOODLER_W / 2;
        x += vx * dt;
        if (x < -half) x = W + half;
        if (x > W + half) x = -half;

        if (rocketActive) {
            // На ракете летим вверх быстро и без обычной физики/приземления
            y -= ROCKET_SPEED * dt;
            vy = -ROCKET_SPEED;
            rocketTimer -= dt;
            if (rocketTimer <= 0) {
                rocketActive = false;
                vy = JUMP_V * 0.7; // мягкий переход обратно в обычный полёт
            }
        } else {
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
            monsters.forEach(m => { m.baseY += dy; });
            powerups.forEach(pu => { pu.y += dy; });
            bullets.forEach(b => { b.y += dy; });
            monsterNextY += dy;
            scrollTotal += dy;
            score = Math.floor(scrollTotal / 10);
            scoreEl.textContent = String(score);
        }

        platforms = platforms.filter(p => p.y < H + 20);
        maybeSpawnPlatforms();

        updateMonsters(dt);
        monsters = monsters.filter(m => m.y < H + 60);
        maybeSpawnMonsters();

        // подбор бонусов (броня/ракета)
        powerups = powerups.filter(pu => pu.y < H + 20);
        powerups.forEach(pu => {
            if (pu.collected) return;
            if (rectsOverlap(x - half * 0.8, y - DOODLER_H * 0.4, half * 1.6, DOODLER_H * 0.8, pu.x - pu.w / 2, pu.y - pu.h / 2, pu.w, pu.h)) {
                pu.collected = true;
                if (pu.type === 'armor') {
                    armorActive = true;
                    armorCharges = ARMOR_MAX_CHARGES;
                    armorTimer = ARMOR_DURATION;
                } else if (pu.type === 'rocket') {
                    rocketActive = true;
                    rocketTimer = ROCKET_DURATION;
                }
            }
        });
        powerups = powerups.filter(pu => !pu.collected);

        // истечение брони по времени
        if (armorActive) {
            armorTimer -= dt;
            if (armorTimer <= 0 || armorCharges <= 0) {
                armorActive = false;
            }
        }

        // пули
        bullets.forEach(b => { b.y += b.vy * dt; });
        bullets = bullets.filter(b => b.y > -20);

        // пули сбивают монстров
        for (let bi = bullets.length - 1; bi >= 0; bi--) {
            const b = bullets[bi];
            for (let mi = monsters.length - 1; mi >= 0; mi--) {
                const m = monsters[mi];
                if (rectsOverlap(b.x - 3, b.y - 7, 6, 14, m.x - m.w / 2, m.y - m.h / 2, m.w, m.h)) {
                    monsters.splice(mi, 1);
                    bullets.splice(bi, 1);
                    score += 5;
                    scoreEl.textContent = String(score);
                    break;
                }
            }
        }

        // столкновения дудлика с монстрами
        const dbx = x - half * 0.65, dbw = half * 1.3;
        const dby = y - DOODLER_H * 0.325, dbh = DOODLER_H * 0.65;
        for (let mi = monsters.length - 1; mi >= 0; mi--) {
            const m = monsters[mi];
            if (!rectsOverlap(dbx, dby, dbw, dbh, m.x - m.w / 2, m.y - m.h / 2, m.w, m.h)) continue;

            if (rocketActive) {
                // На ракете монстры не наносят урона — сбиваем их с пути
                monsters.splice(mi, 1);
            } else if (armorActive) {
                monsters.splice(mi, 1);
                armorCharges -= 1;
                if (armorCharges <= 0) armorActive = false;
            } else {
                endGame();
                return;
            }
        }

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
        if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") { e.preventDefault(); shoot(); }
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

    const shootBtn = wrap.querySelector(".dpad-shoot");
    shootBtn.addEventListener("mousedown", (e) => { e.preventDefault(); shoot(); });
    shootBtn.addEventListener("touchstart", (e) => { e.preventDefault(); shoot(); }, { passive: false });

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

// ------------------------- БРОККОЛИ-РАННЕР -------------------------
// Аналог "динозаврика" из Chrome: бесконечный раннер, где вместо кактусов —
// брокколи (наземные препятствия, через них нужно перепрыгивать), а вместо
// птеродактилей — летучие мыши (летают на уровне корпуса/головы, от них нужно
// приседать). Спрайт героя — фото персонажа, вырезанное из фона (см. выше).
function startRunnerGame() {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);

    app.innerHTML = "";
    let title = document.createElement("h1");
    title.textContent = "🥦 Бега Брокколи";
    title.style.marginBottom = "5px";
    app.appendChild(title);

    const W = 300, H = 150;
    const GROUND_Y = H - 26;           // линия земли, на которую опираются ноги
    const GRAVITY = 1800;              // px/с² (было 1700 — прыжок держит чуть дольше)
    const JUMP_V = -480;               // px/с — импульс прыжка (было -440 — прыжок повыше)
    const BASE_SPEED = 190;            // px/с — начальная скорость мира
    const MAX_SPEED = 430;             // px/с — потолок скорости
    const SPEED_PER_PX = 0.018;        // рост скорости за каждый пройденный пиксель дистанции
    const CHAR_X = 54;                 // фиксированная позиция героя по X
    const STAND_H = 60, STAND_W = 46;  // размеры героя стоя/в прыжке (визуальные, для отрисовки)
    const DUCK_H = 36, DUCK_W = 46;    // размеры героя в приседе (просто уменьшенный спрайт)
    const BROC_MIN_H = 16, BROC_MAX_H = 26; // было 20-32 — брокколи пониже, чтобы прыжок гарантированно перекрывал их
    const BAT_TOP_BASE = GROUND_Y - 78; // верх зоны, где летает мышь (варьируется)
    const BAT_H = 26;

    let wrap = document.createElement("div");
    wrap.className = "game-wrap";
    wrap.innerHTML = `
        <div class="game-score-row">Счёт: <span id="runnerScore">0</span> &nbsp;•&nbsp; Рекорд: <span id="runnerBest">${getMyBest('runner')}</span></div>
        <canvas id="runnerCanvas" width="${W}" height="${H}" class="game-canvas"></canvas>
        <div class="dpad">
            <div class="dpad-mid">
                <button class="dpad-btn dpad-duck" title="Присесть">⬇️</button>
                <button class="dpad-btn dpad-jump" title="Прыжок">⬆️</button>
            </div>
        </div>
    `;
    app.appendChild(wrap);

    const canvas = wrap.querySelector("#runnerCanvas");
    const ctx = canvas.getContext("2d");
    const scoreEl = wrap.querySelector("#runnerScore");
    const bestEl = wrap.querySelector("#runnerBest");

    let footY, vy, ducking, obstacles, distance, speed, score, gameOver, started;
    let lastTime, rafId, spawnTimer, nextSpawnIn, bgOffset, dustParticles, animT;

    function reset() {
        footY = GROUND_Y;
        vy = 0;
        ducking = false;
        obstacles = [];
        dustParticles = [];
        distance = 0;
        speed = BASE_SPEED;
        score = 0;
        gameOver = false;
        started = false;
        lastTime = null;
        spawnTimer = 0;
        nextSpawnIn = 900;
        bgOffset = 0;
        animT = 0;
        scoreEl.textContent = "0";
    }

    function currentCharBox() {
        const grounded = footY >= GROUND_Y - 0.5;
        if (ducking && grounded) {
            return { top: footY - DUCK_H, bottom: footY, w: DUCK_W };
        }
        return { top: footY - STAND_H, bottom: footY, w: STAND_W };
    }

    function spawnObstacle() {
        const isBat = Math.random() < 0.35;
        if (isBat) {
            const wobble = (Math.random() - 0.5) * 10;
            obstacles.push({
                type: "bat", x: W + 10, w: 32,
                top: BAT_TOP_BASE + wobble, h: BAT_H,
                phase: Math.random() * Math.PI * 2
            });
        } else {
            const h = BROC_MIN_H + Math.random() * (BROC_MAX_H - BROC_MIN_H);
            const w = 20 + Math.random() * 8;
            obstacles.push({ type: "broccoli", x: W + 10, w, h, top: GROUND_Y - h });
        }
    }

    // ---- Сумеречное небо: луна, звёзды, силуэты облаков ----
    function drawSky() {
        const grad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
        grad.addColorStop(0, "#4b3a68");
        grad.addColorStop(0.55, "#a06791");
        grad.addColorStop(1, "#f6c3d6");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, GROUND_Y);

        // луна
        ctx.fillStyle = "rgba(255, 250, 235, 0.92)";
        ctx.beginPath();
        ctx.arc(W - 36, 28, 14, 0, Math.PI * 2);
        ctx.fill();

        // звёзды
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        for (let i = 0; i < 12; i++) {
            const sx = (i * 53 + 20 - bgOffset * 0.15) % (W + 40);
            const fx = (sx < 0 ? sx + W + 40 : sx) - 20;
            const sy = 10 + (i * 37) % 60;
            const tw = 0.5 + 0.5 * Math.sin(animT * 3 + i);
            ctx.globalAlpha = 0.4 + 0.5 * tw;
            ctx.fillRect(fx, sy, 2, 2);
        }
        ctx.globalAlpha = 1;

        // силуэты холмов на горизонте
        ctx.fillStyle = "rgba(60, 40, 70, 0.55)";
        for (let i = 0; i < 3; i++) {
            const raw = (i * 130 + 40 - bgOffset * 0.3) % (W + 160);
            const hx = (raw < 0 ? raw + W + 160 : raw) - 80;
            ctx.beginPath();
            ctx.ellipse(hx, GROUND_Y + 6, 90, 26, 0, Math.PI, 0, true);
            ctx.fill();
        }
    }

    // ---- Дорожка-земля со скроллящейся текстурой ----
    function drawGround() {
        const grad = ctx.createLinearGradient(0, GROUND_Y, 0, H);
        grad.addColorStop(0, "#7a5c46");
        grad.addColorStop(1, "#4f3a2c");
        ctx.fillStyle = grad;
        ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);

        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.lineWidth = 2;
        const spacing = 34;
        const scrollX = bgOffset % spacing;
        for (let x = -scrollX; x < W; x += spacing) {
            ctx.beginPath();
            ctx.moveTo(x, GROUND_Y + 3);
            ctx.lineTo(x + 16, GROUND_Y + 3);
            ctx.stroke();
        }

        // травинки у кромки
        ctx.strokeStyle = "#8bc34a";
        ctx.lineWidth = 1.5;
        const gspacing = 22;
        const gscroll = bgOffset % gspacing;
        for (let x = -gscroll; x < W; x += gspacing) {
            const seed = Math.floor((x + bgOffset) / gspacing);
            const h2 = 4 + (seed % 3) * 2;
            ctx.beginPath();
            ctx.moveTo(x, GROUND_Y);
            ctx.lineTo(x - 2, GROUND_Y - h2);
            ctx.moveTo(x, GROUND_Y);
            ctx.lineTo(x + 2, GROUND_Y - h2 + 1);
            ctx.stroke();
        }
    }

    // ---- Брокколи-препятствие ----
    function drawBroccoli(o) {
        const cx = o.x + o.w / 2;
        const stemW = o.w * 0.34;
        ctx.fillStyle = "#c8d98a";
        ctx.fillRect(cx - stemW / 2, GROUND_Y - o.h * 0.4, stemW, o.h * 0.4);

        const florR = o.w * 0.32;
        const centers = [
            [cx, GROUND_Y - o.h + florR * 0.9],
            [cx - o.w * 0.28, GROUND_Y - o.h + florR * 1.3],
            [cx + o.w * 0.28, GROUND_Y - o.h + florR * 1.3],
            [cx - o.w * 0.12, GROUND_Y - o.h + florR * 0.3],
            [cx + o.w * 0.12, GROUND_Y - o.h + florR * 0.3]
        ];
        ctx.fillStyle = "#2e7d32";
        centers.forEach(c => {
            ctx.beginPath();
            ctx.arc(c[0], c[1], florR, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.fillStyle = "rgba(255,255,255,0.18)";
        centers.forEach(c => {
            ctx.beginPath();
            ctx.arc(c[0] - florR * 0.3, c[1] - florR * 0.3, florR * 0.4, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // ---- Летучая мышь-препятствие ----
    function drawBat(o) {
        const cx = o.x + o.w / 2, cy = o.top + o.h / 2;
        const flap = Math.sin(animT * 11 + o.phase) * 7;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.fillStyle = "#241a33";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(-16, -6 - flap, -20, 3);
        ctx.quadraticCurveTo(-9, 1, 0, 0);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(16, -6 - flap, 20, 3);
        ctx.quadraticCurveTo(9, 1, 0, 0);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(0, 0, 9, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ff5252";
        ctx.beginPath();
        ctx.arc(-3, -1, 1.4, 0, Math.PI * 2);
        ctx.arc(3, -1, 1.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // ---- Пылевые частицы под ногами при беге ----
    function updateDust(dt) {
        if (started && !gameOver && footY >= GROUND_Y - 0.5 && Math.random() < 0.5) {
            dustParticles.push({ x: CHAR_X - 14, y: GROUND_Y - 2, age: 0 });
        }
        dustParticles.forEach(p => { p.age += dt; p.x -= speed * dt; });
        dustParticles = dustParticles.filter(p => p.age < 0.5);
    }

    function drawDust() {
        dustParticles.forEach(p => {
            const a = 1 - p.age / 0.5;
            ctx.fillStyle = `rgba(230, 220, 210, ${a * 0.5})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y - p.age * 12, 3 + p.age * 6, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // ---- Герой — фото персонажа в беге/прыжке/приседе ----
    function drawChar() {
        const box = currentCharBox();
        const w = box.w, h = box.bottom - box.top;
        const cx = CHAR_X, cy = box.bottom;
        ctx.save();
        ctx.translate(cx, cy);
        const airborne = footY < GROUND_Y - 0.5;
        const tilt = airborne ? Math.max(-0.18, Math.min(0.28, vy / 900)) : 0;
        const bob = (!airborne && started) ? Math.sin(animT * 16) * 2 : 0;
        ctx.translate(0, bob);
        ctx.rotate(tilt);
        if (runnerCharImg.complete && runnerCharImg.naturalWidth > 0) {
            ctx.drawImage(runnerCharImg, -w / 2, -h, w, h);
        } else {
            ctx.fillStyle = "#9b4f70";
            ctx.fillRect(-w / 2, -h, w, h);
        }
        ctx.restore();
    }

    function draw() {
        drawSky();
        obstacles.forEach(o => o.type === "broccoli" ? drawBroccoli(o) : drawBat(o));
        drawGround();
        drawDust();
        drawChar();

        if (!started) {
            ctx.fillStyle = "rgba(255,255,255,0.9)";
            ctx.font = "13px Arial";
            ctx.textAlign = "center";
            ctx.fillText("Тапни чтобы начать", W / 2, H / 2 - 30);
        }
    }

    function checkCollision() {
        const box = currentCharBox();
        // Хитбокс намеренно уже и ниже, чем весь спрайт (руки/волосы на фото не должны
        // засчитываться как столкновение) — иначе перепрыгнуть препятствия почти нереально.
        const insetX = 8, insetTop = 6, insetBottom = 2;
        const left = CHAR_X - box.w / 2 + insetX, right = CHAR_X + box.w / 2 - insetX;
        const top = box.top + insetTop, bottom = box.bottom - insetBottom;
        return obstacles.some(o => {
            if (right < o.x || left > o.x + o.w) return false;
            const oTop = o.top;
            const oBottom = o.type === "broccoli" ? GROUND_Y : o.top + o.h;
            return top < oBottom && bottom > oTop;
        });
    }

    function loop(time) {
        if (gameOver) return;
        if (!lastTime) lastTime = time;
        const dt = Math.min(0.05, (time - lastTime) / 1000);
        lastTime = time;
        animT += dt;

        if (started) {
            distance += speed * dt;
            speed = Math.min(MAX_SPEED, BASE_SPEED + distance * SPEED_PER_PX);
            bgOffset += speed * dt;

            const newScore = Math.floor(distance / 10);
            if (newScore !== score) {
                score = newScore;
                scoreEl.textContent = String(score);
            }

            // физика прыжка
            if (footY < GROUND_Y) {
                vy += GRAVITY * dt;
                footY += vy * dt;
                if (footY >= GROUND_Y) { footY = GROUND_Y; vy = 0; }
            }

            // спавн препятствий, интервал сокращается по мере роста скорости
            const t = Math.min(1, distance / 3000);
            const minInt = 950 - t * 300;
            const maxInt = 1700 - t * 500;
            spawnTimer += dt * 1000;
            if (spawnTimer >= nextSpawnIn) {
                spawnTimer = 0;
                nextSpawnIn = minInt + Math.random() * (maxInt - minInt);
                spawnObstacle();
            }

            obstacles.forEach(o => { o.x -= speed * dt; });
            obstacles = obstacles.filter(o => o.x + o.w > -10);

            updateDust(dt);

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
        const isRecord = await saveGameScore('runner', score);
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
        if (footY >= GROUND_Y - 0.5 && !ducking) {
            vy = JUMP_V;
            footY = GROUND_Y - 0.01;
        }
    }

    function setDuck(v) {
        if (gameOver) return;
        started = started || v;
        ducking = v;
    }

    function keyHandler(e) {
        if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") { e.preventDefault(); jump(); }
        if (e.code === "ArrowDown" || e.code === "KeyS") { e.preventDefault(); setDuck(true); }
    }
    function keyUpHandler(e) {
        if (e.code === "ArrowDown" || e.code === "KeyS") setDuck(false);
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
    wrap.querySelector(".dpad-jump").addEventListener("mousedown", (e) => { e.preventDefault(); jump(); });
    wrap.querySelector(".dpad-jump").addEventListener("touchstart", (e) => { e.preventDefault(); jump(); }, { passive: false });
    bindHold(wrap.querySelector(".dpad-duck"), () => setDuck(true), () => setDuck(false));

    canvas.addEventListener("mousedown", jump);
    canvas.addEventListener("touchstart", (e) => { e.preventDefault(); jump(); }, { passive: false });

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
