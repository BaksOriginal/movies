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
            <div class="game-card-header">🍫 Эчпочмоня vs. Шоколадки</div>
            ${buildLeaderboardHtml('flappy')}
            <button id="playFlappyBtn" class="btn-games-green">▶️ Играть</button>
        </div>
        <div class="game-card">
            <div class="game-card-header">👾 Doodle Jump</div>
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
                if (roll < 0.012) {
                    powerups.push(makePowerup('rocket', plat));
                } else if (roll < 0.09) {
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
        while (monsterNextY > topmostY() - 20) {
            const spawnY = monsterNextY;
            monsterNextY -= 260 + Math.random() * 320;
            if (Math.random() < 0.5) {
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
        monsterNextY = -180; // монстры не появляются в первые секунды игры
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
