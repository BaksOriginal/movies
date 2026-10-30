let dbData = {}; // Сюда мы динамически соберем структуру категорий и жанров из базы данных
let titleCreatedAt = {}; // "Название (год)" -> дата добавления в базу (для значка "новинка")

// ==========================================
// ПАГИНАЦИЯ КАТАЛОГА (карточки, как в "Онлайн Поиске")
// ==========================================
// catalogItemsPerPage: 0 означает "Показывать все" (без нарезки на страницы).
// Храним выбор в localStorage — чтобы не переспрашивать при каждом заходе.
let catalogItemsPerPage = parseInt(localStorage.getItem("catalogItemsPerPage"), 10);
if (!Number.isFinite(catalogItemsPerPage) || catalogItemsPerPage < 0) catalogItemsPerPage = 24;
let catalogCurrentPage = 1;

// ==========================================
// ЗАГОЛОВКИ (h1) С ЭМОДЗИ
// ==========================================
// У h1 в CSS градиентная "вырезка" текста (background-clip: text), из-за
// которой эмодзи в начале заголовка тоже красится в сплошной цвет градиента
// и теряет свой нативный многоцветный вид. Эта функция оборачивает ведущий
// эмодзи в отдельный <span>, который не участвует в вырезке — эмодзи
// остаётся собственного цвета, но с лёгкой обводкой (см. .emoji-native в CSS),
// а остальной текст заголовка окрашивается градиентом как раньше.
// ==========================================
// TMDB (постеры фильмов/сериалов, поиск)
// ==========================================
// Запрос идёт не напрямую на api.themoviedb.org с фронтенда, а через свою
// Edge Function "tmdb-proxy" в Supabase (тот же принцип, что и у
// kinopoisk-search ниже): она хранит ключ в секретах проекта и подставляет
// его на сервере, поэтому в браузерном коде ключа нет вообще.
// Разверните supabase/functions/tmdb-proxy и задайте секрет TMDB_API_KEY
// (см. инструкцию в файле функции).
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w342";

// Общий хелпер для всех обращений к TMDB — собирает URL до Edge Function
// и добавляет те же заголовки авторизации Supabase, что и у остальных
// вызовов функций в этом файле.
async function tmdbFetch(path, extraParams = {}) {
    const params = new URLSearchParams({ language: "ru-RU", ...extraParams });
    return fetch(`${SUPABASE_URL}/functions/v1/tmdb-proxy${path}?${params.toString()}`, {
        headers: {
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            apikey: SUPABASE_ANON_KEY
        }
    });
}

// ==========================================
// TMDB — ОНЛАЙН-ПОИСК (наполнение каталога, кнопка "🔍 Онлайн Поиск")
// ==========================================
// Настоящий рейтинг/ID с Кинопоиска для конкретного тайтла подтягиваются
// отдельно, лениво — см. findKinopoiskMatch() ниже и её использование в
// showAddFromOnlineSearchModal().
const TMDB_IMG_BASE_SMALL = "https://image.tmdb.org/t/p/w185"; // уменьшенные постеры для карточек результата
const TMDB_ANIMATION_GENRE_ID = 16; // одинаковый id и для /genre/movie/list, и для /genre/tv/list — используем как эвристику "Мультфильм"/"Аниме"

let tmdbMovieGenresCache = null; // [{id,name}], заполняется лениво при первом открытии экрана поиска
let tmdbTvGenresCache = null;

// Список жанров TMDB (на русском) для выпадающего списка фильтров.
// kind: "movie" | "tv" — у кино и сериалов на TMDB немного разные наборы жанров.
async function fetchTmdbGenreList(kind) {
    if (kind === "movie" && tmdbMovieGenresCache) return tmdbMovieGenresCache;
    if (kind === "tv" && tmdbTvGenresCache) return tmdbTvGenresCache;
    try {
        const res = await tmdbFetch(`/genre/${kind}/list`);
        const json = await res.json();
        const list = (json.genres || []).slice().sort((a, b) => a.name.localeCompare(b.name, "ru"));
        if (kind === "movie") tmdbMovieGenresCache = list; else tmdbTvGenresCache = list;
        return list;
    } catch (e) {
        console.error("Не удалось загрузить список жанров TMDB:", e);
        return [];
    }
}

// Карта id-жанра → название, теми же кэшами (tmdbMovieGenresCache/
// tmdbTvGenresCache), что и у "Онлайн Поиска" выше — общий global-хелпер,
// т.к. теперь жанры нужны и обычным карточкам каталога (см. fetchTmdbCardMeta).
async function buildGenreNameLookupAsync(kind) {
    const list = await fetchTmdbGenreList(kind);
    const map = {};
    list.forEach(g => { map[g.id] = g.name; });
    return map;
}

// ==========================================
// TMDB-МЕТАДАННЫЕ ДЛЯ КАРТОЧЕК КАТАЛОГА (постер, мини-описание, жанры)
// ==========================================
// Карточкам каталога нужны постер, жанр и краткое описание —
// собираем всё за один и тот же поиск на TMDB и кэшируем по названию,
// чтобы при повторной перерисовке экрана (смена страницы пагинации,
// live-обновление оценок и т.п.) не дёргать TMDB заново.
const tmdbCardMetaCache = new Map(); // "Название (год)" -> meta | null

// Постер/жанры/описание тайтла почти никогда не меняются, а без кэша каждая
// карточка при каждом открытии сайта — это 1-2 запроса к TMDB через прокси.
// Храним найденное в localStorage на 2 недели: при повторных заходах постеры
// появляются сразу, без сети. Описание хранится уже обрезанным — длиннее
// 130 символов карточка его всё равно не показывает.
const TMDB_META_STORAGE_KEY = "tmdbCardMeta:v1";
const TMDB_META_TTL_MS = 14 * 24 * 60 * 60 * 1000;
let tmdbMetaSaveTimer = null;
const tmdbCardMetaSavedAt = new Map(); // "Название (год)" -> когда найдено (для TTL)

(function restoreTmdbCardMetaCache() {
    try {
        const saved = JSON.parse(localStorage.getItem(TMDB_META_STORAGE_KEY) || "{}");
        const now = Date.now();
        for (const key in saved) {
            const entry = saved[key];
            if (entry && now - entry.t < TMDB_META_TTL_MS) {
                tmdbCardMetaCache.set(key, entry.m);
                tmdbCardMetaSavedAt.set(key, entry.t);
            }
        }
    } catch (e) { /* битый кэш — просто начинаем с пустого */ }
})();

function persistTmdbCardMetaCache() {
    if (tmdbMetaSaveTimer) return;
    tmdbMetaSaveTimer = setTimeout(() => {
        tmdbMetaSaveTimer = null;
        const out = {};
        const now = Date.now();
        tmdbCardMetaCache.forEach((meta, key) => {
            if (!tmdbCardMetaSavedAt.has(key)) tmdbCardMetaSavedAt.set(key, now);
            out[key] = { t: tmdbCardMetaSavedAt.get(key), m: meta };
        });
        try {
            localStorage.setItem(TMDB_META_STORAGE_KEY, JSON.stringify(out));
        } catch (e) { /* переполнен localStorage — не критично, останется кэш в памяти */ }
    }, 1500);
}

const tmdbCardMetaInFlight = new Map(); // "Название (год)" -> Promise

function fetchTmdbCardMeta(itemText) {
    if (tmdbCardMetaCache.has(itemText)) return Promise.resolve(tmdbCardMetaCache.get(itemText));
    if (tmdbCardMetaInFlight.has(itemText)) return tmdbCardMetaInFlight.get(itemText);
    const request = requestTmdbCardMeta(itemText).finally(() => tmdbCardMetaInFlight.delete(itemText));
    tmdbCardMetaInFlight.set(itemText, request);
    return request;
}

// TMDB-данные из строки каталога -> в кэш карточек (без похода в сеть)
function rememberTitleMeta(itemText, row) {
    if (row.tmdb_id == null) return;
    if (row.tmdb_id === 0) {
        tmdbCardMetaCache.set(itemText, null);
        return;
    }
    tmdbCardMetaCache.set(itemText, {
        posterUrl: row.poster_path ? TMDB_IMG_BASE_SMALL + row.poster_path : null,
        overview: row.overview || "",
        genreNames: row.tmdb_genres || ""
    });
}

// Результат поиска TMDB -> поля строки titles (null — "TMDB не нашёл")
function buildTitleMetaFields(result, mediaKind, genreNames) {
    if (!result) return { tmdb_id: 0, tmdb_type: null, poster_path: null, tmdb_genres: null, overview: null };
    const overview = result.overview || "";
    return {
        tmdb_id: result.id,
        tmdb_type: mediaKind,
        poster_path: result.poster_path || null,
        tmdb_genres: genreNames || null,
        overview: overview.length > 140 ? overview.slice(0, 140) + "…" : overview
    };
}

// Дописывает найденное в TMDB в строку каталога — один раз на тайтл, после
// этого его карточка больше никогда не ищет TMDB (ни у нас, ни у партнёра)
async function saveTitleMeta(itemText, fields) {
    const row = titleRows[itemText];
    if (!titleMetaColumns || !row || row.id == null || row.tmdb_id != null) return;
    Object.assign(row, fields);
    const { error } = await db.from("titles").update(fields).eq("id", row.id);
    if (error) console.error("Не удалось сохранить данные TMDB в каталог:", error.message);
}

async function requestTmdbCardMeta(itemText) {

    const match = itemText.match(/^(.*)\s\((\d{4})\)$/);
    const title = match ? match[1] : itemText;
    const year = match ? match[2] : null;

    try {
        const movieParams = { query: title };
        if (year) movieParams.year = year;
        let res = await tmdbFetch("/search/movie", movieParams);
        let json = await res.json();
        let result = json.results && json.results[0];
        let mediaKind = "movie";

        if (!result) {
            const tvParams = { query: title };
            if (year) tvParams.first_air_date_year = year;
            res = await tmdbFetch("/search/tv", tvParams);
            json = await res.json();
            result = json.results && json.results[0];
            mediaKind = "tv";
        }

        if (!result) {
            tmdbCardMetaCache.set(itemText, null);
            persistTmdbCardMetaCache();
            saveTitleMeta(itemText, buildTitleMetaFields(null));
            return null;
        }

        const genreMap = await buildGenreNameLookupAsync(mediaKind);
        const genreNames = (result.genre_ids || []).map(id => genreMap[id]).filter(Boolean).slice(0, 3).join(", ");

        const overview = result.overview || "";
        const meta = {
            posterUrl: result.poster_path ? (TMDB_IMG_BASE_SMALL + result.poster_path) : null,
            overview: overview.length > 140 ? overview.slice(0, 140) + "…" : overview,
            genreNames
        };
        tmdbCardMetaCache.set(itemText, meta);
        persistTmdbCardMetaCache();
        saveTitleMeta(itemText, buildTitleMetaFields(result, mediaKind, genreNames));
        return meta;
    } catch (e) {
        console.error("Ошибка при запросе карточки каталога с TMDB:", e);
        return null;
    }
}

// Простое HTML-экранирование — нужно, т.к. в карточках онлайн-поиска
// вставляются названия/описания с TMDB (внешние данные, не то, что раньше
// когда-либо печаталось в innerHTML сайта напрямую).
function escapeHtml(str) {
    return String(str == null ? "" : str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// ==========================================
// КИНОПОИСК (только метаданные — название/год/ID, чтобы построить ссылку на
// реальную страницу фильма на www.kinopoisk.ru; никакого видео)
// ==========================================
// Запрос идёт не прямо на api.kinopoisk.dev с фронтенда (у них не работает
// CORS для браузерных запросов — preflight редиректится, а это принципиально
// нельзя обойти на стороне клиента), а через свою Edge Function
// "kinopoisk-search" в Supabase, которая уже без CORS-ограничений (это
// сервер) стучится в kinopoisk.dev, храня токен в секретах проекта.
// Разверните supabase/functions/kinopoisk-search и задайте секрет
// KINOPOISK_DEV_TOKEN (см. инструкцию в файле функции).

// ==========================================
// СТИКЕРЫ ДЛЯ ЧАТА (хранятся в GitHub, не в БД)
// ==========================================
// Загрузите картинки стикеров (.png/.jpg/.jpeg/.webp/.gif) в папку "stickers"
// вашего GitHub-репозитория и укажите ниже владельца/имя репозитория/ветку.
// Список стикеров подтягивается динамически через GitHub API — просто
// добавляйте новые файлы в папку, менять код не нужно.

// ==========================================
// ФОТО РАЗРАБОТЧИКА (плашка в разделе "Секрет")
// ==========================================
// Лежит отдельным файлом (раньше — base64-строкой прямо здесь, ~66 КБ
// в каждом скачивании script.js). Файл грузится только при открытии
// Секрета и кэшируется браузером. Заменить фото — заменить img/developer.jpg.
const DEVELOPER_PHOTO_URL = "img/developer.jpg";


// ==========================================
// РИТМ-АРКАДА (6-я игра): ТРЕКИ ХРАНЯТСЯ В GITHUB, НЕ В БД
// ==========================================
// Загрузите .ogg-треки в папку "rhytm_game" вашего GitHub-репозитория —
// список подтягивается динамически через GitHub API при каждом заходе
// в раздел, так же как со стикерами. Уровни НЕ хранятся заранее нигде —
// они строятся на лету анализом самого аудиофайла (см. секцию ниже).

// Резервный SHA ветки main — используется getGithubBranchSha() только в самом
// крайнем случае: если свежий SHA получить не удалось (например, 403 —
// исчерпан лимит 60 запросов/час на IP у api.github.com) И при этом в
// localStorage браузера ещё нет вообще никакого ранее сохранённого SHA
// (первый визит на сайт / очищенный кэш). Раньше в этом случае код подставлял
// имя ветки "main" напрямую в jsDelivr — а jsDelivr кэширует листинг файлов по
// имени ветки на часы без возможности ручного Purge, из-за чего показывались
// давно удалённые треки. Подстановка вот этого константного SHA вместо имени
// ветки гарантирует настоящий (пусть не самый последний) снимок репозитория.
//
// ВАЖНО: обновляйте эту строку на актуальный SHA вашей ветки main каждый раз,
// когда добавляете/удаляете треки в rhythm_game (или стикеры в stickers) —
// иначе в этом редком edge-case будет показываться снимок репозитория на
// момент, когда эта строка была обновлена в последний раз, а не самый свежий.
// Узнать текущий SHA: https://api.github.com/repos/BaksOriginal/movies/git/refs/heads/main
// (поле object.sha) — или, если сам API лимитирует, через
// `git ls-remote https://github.com/BaksOriginal/movies.git main` в терминале.

// ==========================================
// АКТУАЛЬНЫЙ SHA ВЕТКИ (обход кэша jsDelivr по "@branch")
// ==========================================
// jsDelivr кэширует ответы по "@main" с заметной задержкой (листинг файлов
// может не обновляться часами после коммита, а ручного Purge для листинга
// data.jsdelivr.com не существует). Ответы же по конкретному commit SHA
// иммутабельны — такой кэш не может "протухнуть": либо там сразу верные
// данные, либо jsDelivr ещё не видел этот SHA и сходит за ним заново.
//
// Поэтому вместо "@main" в URL к data.jsdelivr.com/cdn.jsdelivr.net
// подставляем SHA текущего HEAD ветки. Сам SHA берём с api.github.com —
// это единственное место, где мы всё ещё используем GitHub API напрямую
// (легкий запрос refs/heads, не листинг файлов), и кэшируем результат в
// localStorage на SHA_CACHE_TTL_MS, чтобы не тратить его лимит (60 запросов
// в час на IP) при каждом заходе пользователя на сайт.


// Раньше здесь была функция startTransitionLock(), которая на 350мс блокировала
// АБСОЛЮТНО ВСЕ клики на странице после каждого openData()/showHome(). Экран у
// нас перерисовывается мгновенно (через innerHTML, без CSS-анимации), поэтому
// защищать тут было нечего — а на практике это глобально "съедало" самый первый
// клик пользователя по только что отрисованному экрану (например, по звёздочке
// "Просмотрено"/"Будем смотреть" сразу после захода в раздел), из-за чего
// приходилось кликать дважды. Функция оставлена как no-op на случай, если где-то
// в коде остался вызов startTransitionLock().
function startTransitionLock() {}

// ==========================================
// АЛФАВИТНАЯ СОРТИРОВКА СПИСКОВ ТАЙТЛОВ
// ==========================================
// Делается здесь, в скрипте, сразу после сборки dbData — а не SQL ORDER BY
// или триггером в БД. dbData не плоская таблица, а дерево категория→жанр→
// франшиза, которое и так собирается тут же из плоского списка titles;
// сортировать его на этом же шаге — просто и полностью под контролем
// (нужная локаль "ru", не считаем год/регистр). Триггер в БД решал бы
// задачу глобального порядка, для которой в таблице titles даже нет
// колонки "позиция" — пришлось бы вводить её и пересчитывать на каждую
// вставку/удаление, а результат сортировки всё равно не влияет на то,
// что должно оставаться неизменным в БД — например, isRecentlyAdded()
// ниже сортировку не трогает, ей нужен именно created_at.
function titleSortKey(title) {
    return title.replace(/\s*\(\d{4}\)\s*$/, "").trim().toLowerCase();
}

// Сортирует список тайтлов одного жанра (в списке вперемешку могут быть
// как строки "Название (год)", так и объекты-франшизы { "Крик": [...] })
// Год выпуска из "Название (год)" — для сортировки фильмов внутри франшизы
// по хронологии, а не по алфавиту (алфавит для сиквелов бессмысленнен —
// "Крик 2" должен идти после "Крик", а не после "Крик 4" и т.п.)
function titleYear(title) {
    const m = title.match(/\((\d{4})\)\s*$/);
    return m ? parseInt(m[1], 10) : 0;
}

function sortGenreList(list) {
    list.forEach(item => {
        if (typeof item === "object" && item !== null) {
            for (let franchiseName in item) {
                item[franchiseName].sort((a, b) => titleYear(a) - titleYear(b));
            }
        }
    });
    list.sort((a, b) => {
        const keyA = typeof a === "string" ? titleSortKey(a) : titleSortKey(Object.keys(a)[0]);
        const keyB = typeof b === "string" ? titleSortKey(b) : titleSortKey(Object.keys(b)[0]);
        return keyA.localeCompare(keyB, "ru");
    });
}

// Функция для загрузки тайтлов из Supabase и сборки структуры
// Раньше каталог (все тайтлы) заново скачивался при КАЖДОМ возврате на
// главную — отсюда и вечные тормоза на "Домой". Теперь он грузится один раз,
// а дальше обновляется сам: после своих правок (refreshCurrentScreen) и по
// realtime, когда тайтлы меняет партнёр (см. onCatalogRealtimeChange).
let catalogLoaded = false;

// Секретная категория не меняется никогда — её содержимое живёт прямо здесь,
// в коде, а её строки из таблицы titles игнорируются. Формат тот же, что у
// dbData: { "категория": { "жанр": ["Название (год)", { "Франшиза": [...] }] } }.
const SECRET_CATALOG = {
    "🗝️ Секрет": {
        "💌 Послание для Любимой": [
            "❤️ Я Тебя Очень Сильно ЛЮБЛЮ! ❤️ (2026)",
            "😈 Моя ты Эчпочмоня 😈 (2026)",
            "Спасибо что ты есть 💕 (2026)"
        ],
        "💻 Разработчик": [
            "👑 Бакс Ориджинал 👑 (2026)"
        ]
    }
};

// Последний загруженный каталог хранится и в localStorage: при следующем
// открытии сайта главная рисуется из него сразу, не дожидаясь базы, а
// свежая версия догружается параллельно и подменяет старую, только если
// что-то изменилось (сравниваем по сериализованным строкам).
const CATALOG_CACHE_KEY = "catalogCache:v1";
let catalogSignature = null;

function restoreCatalogFromCache() {
    try {
        const raw = localStorage.getItem(CATALOG_CACHE_KEY);
        if (!raw) return false;
        buildCatalog(JSON.parse(raw));
        catalogSignature = raw;
        return true;
    } catch (e) {
        return false;
    }
}

function clearCatalogCache() {
    try { localStorage.removeItem(CATALOG_CACHE_KEY); } catch (e) { /* не критично */ }
    catalogSignature = null;
}

// ---------- TMDB-данные тайтлов в базе ----------
// Постер, жанры и описание тайтла хранятся прямо в строке titles (столбцы
// tmdb_id/tmdb_type/poster_path/tmdb_genres/overview — SQL для их создания
// см. в комментарии ниже). Тогда карточкам вообще не нужен поиск по TMDB:
// всё приходит вместе с каталогом одним запросом. Чего в базе ещё нет,
// сайт один раз находит в TMDB сам и дописывает в строку (saveTitleMeta).
// tmdb_id = 0 — "искали, TMDB такого не знает" (чтобы не искать снова).
//
//   alter table public.titles
//     add column if not exists tmdb_id integer,
//     add column if not exists tmdb_type text,
//     add column if not exists poster_path text,
//     add column if not exists tmdb_genres text,
//     add column if not exists overview text;
//
// Пока столбцов нет, сайт работает как раньше (titleMetaColumns = false).
const TITLE_BASE_COLUMNS = "id, title, year, category, genre, franchise, created_at";
const TITLE_META_COLUMNS = "tmdb_id, tmdb_type, poster_path, tmdb_genres, overview";
let titleMetaColumns = true;
let titleRows = {}; // "Название (год)" -> строка titles (для дописывания TMDB-данных)

// Возвращает true, если каталог изменился (и dbData пересобран)
async function loadCatalogFromDB() {
    const query = (columns) => db.from('titles').select(columns).order('id', { ascending: true });
    let { data: titles, error } = await query(titleMetaColumns ? `${TITLE_BASE_COLUMNS}, ${TITLE_META_COLUMNS}` : TITLE_BASE_COLUMNS);

    // Столбцов TMDB ещё нет (SQL выше не выполняли) — грузим без них
    if (error && titleMetaColumns && String(error.code) === "42703") {
        titleMetaColumns = false;
        ({ data: titles, error } = await query(TITLE_BASE_COLUMNS));
    }

    if (error) {
        console.error("Ошибка при загрузке каталога из БД:", error);
        return false;
    }

    const signature = JSON.stringify(titles);
    if (signature === catalogSignature) return false;
    catalogSignature = signature;
    buildCatalog(titles);
    try {
        localStorage.setItem(CATALOG_CACHE_KEY, signature);
    } catch (e) { /* переполнен localStorage — просто без кэша */ }
    return true;
}

function buildCatalog(titles) {
    // Собираем плоский список из базы обратно в древовидную структуру для сайта
    const tempStructure = {};
    const tempCreatedAt = {};

    const tempRows = {};

    titles.forEach(item => {
        if (SECRET_CATALOG && isSecretCategory(item.category)) return;
        const cat = item.category;
        const gen = item.genre;
        const fran = item.franchise;
        const titleWithYear = `${item.title} (${item.year})`;
        tempCreatedAt[titleWithYear] = item.created_at || null;
        tempRows[titleWithYear] = item;
        rememberTitleMeta(titleWithYear, item);

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

    for (let cat in tempStructure) {
        for (let genre in tempStructure[cat]) {
            sortGenreList(tempStructure[cat][genre]);
        }
    }

    if (SECRET_CATALOG) {
        for (const cat in SECRET_CATALOG) {
            tempStructure[cat] = JSON.parse(JSON.stringify(SECRET_CATALOG[cat]));
        }
    }

    dbData = tempStructure;
    titleCreatedAt = tempCreatedAt;
    titleRows = tempRows;
    catalogLoaded = true;
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

// Плоский список всех недавно добавленных тайтлов сайта (для кнопки
// "⭐ Новое на сайте" на главной) — вне зависимости от категории/жанра/
// франшизы, в отличие от значка "✦" на карточке (isRecentlyAdded() выше),
// который просто помечает тайтл на его обычном месте в каталоге. Сортируем
// от самого нового к старому — тут это уместнее алфавита, т.к. весь смысл
// экрана именно в свежести добавления.
function getRecentlyAddedTitles() {
    return Object.keys(titleCreatedAt)
        .filter(title => isRecentlyAdded(title))
        .sort((a, b) => new Date(titleCreatedAt[b]).getTime() - new Date(titleCreatedAt[a]).getTime());
}



// ==========================================
// ДЕЛЕГИРОВАНИЕ СОБЫТИЙ ДЛЯ КАРТОЧЕК ТАЙТЛОВ (.item)
// ==========================================
// Раньше renderItemRow() навешивал 8 отдельных слушателей (mousedown/
// mouseup/mouseleave/click/touchstart/touchmove/touchend/touchcancel) на
// КАЖДУЮ карточку .item — при большой категории (сотня+ тайтлов) это
// сотни слушателей и замыканий, создаваемых заново при каждом открытии
// экрана (app.innerHTML = ""). #app как узел не пересоздаётся между
// экранами, так что вместо этого один раз ставим слушатели прямо на
// него и определяем, по какой карточке кликнули, через e.target.closest().
// Долгое нажатие (700мс) открывает меню редактирования/удаления тайтла,
// как и раньше — вся логика та же, просто состояние общее на "текущее
// нажатие", а не на каждую карточку отдельно (одновременно жать двумя
// пальцами по разным карточкам всё равно не сценарий этого интерфейса).
const itemPress = {
    timer: null,
    moving: false,
    startX: 0,
    startY: 0,
    itemText: null,
    suppressNextMouseDown: false
};

function itemPressCancel() {
    if (itemPress.timer !== null) {
        clearTimeout(itemPress.timer);
        itemPress.timer = null;
    }
}

function itemPressStart(e, itemDiv) {
    if (e.type === "mousedown" && itemPress.suppressNextMouseDown) {
        itemPress.suppressNextMouseDown = false;
        return;
    }
    if (e.type === "touchstart") {
        itemPress.suppressNextMouseDown = true;
        itemPress.startX = e.touches[0].clientX;
        itemPress.startY = e.touches[0].clientY;
    }

    itemPress.moving = false;
    itemPress.itemText = itemDiv.dataset.itemText;
    itemPressCancel();
    itemPress.timer = setTimeout(() => {
        if (!itemPress.moving) {
            showActionMenu(itemPress.itemText);
        }
    }, 700);
}

app.addEventListener("mousedown", (e) => {
    const itemDiv = e.target.closest(".item[data-item-text]");
    if (!itemDiv) return;
    itemPressStart(e, itemDiv);
});
app.addEventListener("mouseup", (e) => {
    if (e.target.closest(".item[data-item-text]")) itemPressCancel();
});
// mouseleave не всплывает, поэтому делегировать его напрямую нельзя —
// mouseout всплывает и срабатывает и при переходе на дочерний элемент
// внутри самой карточки, поэтому дополнительно проверяем через
// relatedTarget, что курсор действительно покинул carточку целиком
// (та же ситуация, которую раньше решал mouseleave на каждом элементе).
app.addEventListener("mouseout", (e) => {
    const itemDiv = e.target.closest(".item[data-item-text]");
    if (!itemDiv) return;
    if (e.relatedTarget && itemDiv.contains(e.relatedTarget)) return;
    itemPressCancel();
});
app.addEventListener("click", (e) => {
    if (e.target.closest(".item[data-item-text]")) e.preventDefault();
});
app.addEventListener("touchstart", (e) => {
    const itemDiv = e.target.closest(".item[data-item-text]");
    if (!itemDiv) return;
    itemPressStart(e, itemDiv);
}, { passive: true });
app.addEventListener("touchmove", (e) => {
    if (!e.target.closest(".item[data-item-text]")) return;
    const diffX = Math.abs(e.touches[0].clientX - itemPress.startX);
    const diffY = Math.abs(e.touches[0].clientY - itemPress.startY);
    if (diffX > 10 || diffY > 10) {
        itemPress.moving = true;
        itemPressCancel();
    }
}, { passive: true });
app.addEventListener("touchend", (e) => {
    if (!e.target.closest(".item[data-item-text]")) return;
    itemPressCancel();
    if (itemPress.moving) return;
    e.preventDefault();
    e.stopPropagation();
}, { passive: false });
app.addEventListener("touchcancel", (e) => {
    if (e.target.closest(".item[data-item-text]")) itemPressCancel();
});

let watchedTitles = new Set(); // Производный union: просмотрено хоть кем-то (мной, партнёром или обоими) — используется для звёздочки
let watchedByUser = {}; // "Название (год)" -> Set<user_id> — кто именно из двоих отметил тайтл просмотренным
let watchedTitlesMine = new Set();     // Просмотрено только мной
let watchedTitlesPartner = new Set();  // Просмотрено только партнёром
let watchedTitlesBoth = new Set();     // Просмотрено нами обоими
let wishlistTitles = new Set(); // Общий список вишлиста "Будем смотреть"
let ratingsData = {}; // Оценки: { "Название (год)": [{ username, score, userId }, ...] }
let history = [];
// Параллельный стек: для каждого элемента history хранит значение
// currentCategoryName, которое было актуально в момент его добавления.
// Нужен для того, чтобы кнопка "⬅️ Назад" восстанавливала не только сам
// контент экрана, но и правильную "категорию", к которой он относится —
// иначе, например, после захода в Паутинку и открытия там жанра из ОБЫЧНОЙ
// категории, "Назад" возвращал верный контент секретной подкатегории, но
// currentCategoryName оставался от последнего посещённого обычного жанра,
// и экран секретной подкатегории переставал считаться секретным (пропадала
// кнопка "Паутинка", появлялся неуместный счётчик тайтлов и т.д.).
let categoryHistory = [];
// Ещё один параллельный стек: для каждого элемента history хранит значение
// catalogCurrentPage, актуальное для этого экрана В МОМЕНТ УХОДА с него
// (т.е. непосредственно перед тем, как поверх него был открыт следующий
// экран). catalogCurrentPage — одна общая переменная на всё приложение,
// поэтому без этого стека переход вглубь (например, из списка тайтлов
// жанра в папку франшизы) затирал бы её значением уже вложенного экрана,
// и goBack() из франшизы обратно в жанр не мог бы вспомнить, на какой
// странице пагинации жанра пользователь был — попросту показывал бы
// страницу 1. См. использование в openData()/goBack().
let pageHistory = [];
let realtimeChannel = null; // Канал для мгновенных обновлений
let realtimeConnected = false; // канал реально подписан (иначе чат опрашивается чаще)

// Текущие фильтры поиска
let searchFilters = { category: "", genre: "", year: "", hasRating: "", minStars: "" };
let lastSearchQuery = ""; // Запоминаем последний текстовый запрос, чтобы показывать его в строке поиска на экране результатов

// Состояние чата
let chatMessages = [];
let isChatScreenOpen = false;
let chatPollInterval = null;
let chatReplyTarget = null; // Сообщение, на которое сейчас отвечаем (или null)

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
// КАЛЕНДАРЬ ПРОСМОТРОВ ("Запланировать" на дату)
// ==========================================
// Требуется таблица public.scheduled_items в Supabase — см. SQL-инструкцию
// в комментарии перед loadScheduledFromDB() ниже.
let isCalendarScreenOpen = false;
let scheduledByTitle = {}; // "Название (год)" -> "YYYY-MM-DD" (дата, на которую запланирован просмотр)
let scheduledByDate = {};  // "YYYY-MM-DD" -> ["Название (год)", ...] — производное от scheduledByTitle
let calendarViewYear = null;  // Год открытого сейчас месяца в календаре (null = ещё не открывался)
let calendarViewMonth = null; // Месяц открытого сейчас месяца, 0-индексация (январь = 0)



// ==========================================
// АВТОРИЗАЦИЯ (плагин: db, currentUser, saveSessionBackup, tryRestoreSession,
// performLogout и сам initAuth() определены в core.js — здесь только
// каталог-специфичные обработчики onLogin/onLogout).
// ==========================================
initAuth({
    isRendered: () => app && app.innerHTML.trim(),

    // Тот же пользователь, тихое обновление токена — экран не трогаем.
    onTokenRefresh: () => {
        startShakeDetection(); // безопасно — функция сама не даст навесить слушатель дважды
    },

    onLogin: async (wasAlreadyInitialized) => {
        startShakeDetection(); // На случай, если сессия восстановилась автоматически, а не через форму логина

        // Чистим прошедшие дни календаря из БД — только на новый заход в
        // приложение, а не на каждое фоновое обновление токена/вкладки.
        if (!wasAlreadyInitialized) {
            cleanupPastScheduledItems();
        }

        // Каталог и личные списки (просмотрено/вишлист/оценки/календарь)
        // грузятся параллельно. Если каталог есть в кэше браузера — экран
        // рисуется сразу по нему, а свежая версия подменит его, когда придёт.
        const hadCachedCatalog = !wasAlreadyInitialized && restoreCatalogFromCache();
        const freshCatalog = wasAlreadyInitialized ? Promise.resolve(false) : loadCatalogFromDB();
        await loadUserDataFromDB();
        if (!hadCachedCatalog) await freshCatalog;
        subscribeToChanges();

        if (!wasAlreadyInitialized) {
            ensureMainShell();
            // Диплинк с других страниц сайта на раздел главной: ../#wishlist и т.п.
            if (!(location.hash.length > 1 && openScreenFromHash())) showHome();

            if (hadCachedCatalog) {
                freshCatalog.then(changed => {
                    if (!changed || !currentUser) return;
                    ensureMainShell();
                    if (document.body.dataset.section === "home") showHome();
                });
            }
            // Глитч-анимация — только сразу после входа по форме, а не при
            // каждом открытии главной (переходы с Игр/Совместного просмотра
            // — это тоже новая загрузка страницы с уже восстановленной сессией)
            if (sessionStorage.getItem("playLoginGlitch") === "1") {
                sessionStorage.removeItem("playLoginGlitch");
                playLoginGlitchAnimation();
            }
        } else {
            refreshCurrentScreen();
        }
    },

    onLogout: () => {
        watchedTitles.clear();
        watchedByUser = {};
        watchedTitlesMine.clear();
        watchedTitlesPartner.clear();
        watchedTitlesBoth.clear();
        wishlistTitles.clear();
        ratingsData = {};
        chatMessages = [];
        scheduledByTitle = {};
        scheduledByDate = {};
        isChatScreenOpen = false;
        isCalendarScreenOpen = false;

        if (realtimeChannel) {
            db.removeChannel(realtimeChannel);
            realtimeChannel = null;
        }
        destroyShell();
        mainShellReady = false;
        clearCatalogCache();
        catalogLoaded = false;
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

// ==========================================
// КАЛЕНДАРЬ ПРОСМОТРОВ
// ==========================================
// Требуется таблица public.scheduled_items в Supabase. Выполните один раз
// в SQL Editor вашего проекта:
//
//   create table if not exists public.scheduled_items (
//     id bigint generated always as identity primary key,
//     user_id uuid not null references auth.users(id) on delete cascade,
//     title text not null unique,
//     scheduled_date date not null,
//     created_at timestamptz not null default now()
//   );
//
//   alter table public.scheduled_items enable row level security;
//
//   create policy "scheduled_items_select" on public.scheduled_items
//     for select using (true);
//   create policy "scheduled_items_insert" on public.scheduled_items
//     for insert with check (true);
//   create policy "scheduled_items_update" on public.scheduled_items
//     for update using (true);
//   create policy "scheduled_items_delete" on public.scheduled_items
//     for delete using (true);
//
//   alter publication supabase_realtime add table public.scheduled_items;
//
// title сделан UNIQUE — у одного тайтла может быть только одна активная
// запланированная дата одновременно; "перенос" на другой день — это просто
// UPSERT той же строки с новой датой.

// Локальная (не UTC) дата в формате "YYYY-MM-DD" — важно для правильной
// границы "сегодня/прошлое" в часовом поясе самого пользователя, а не UTC.
function toDateKey(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function todayDateKey() {
    return toDateKey(new Date());
}

function parseDateKey(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    return new Date(y, m - 1, d);
}

function capitalizeFirst(text) {
    if (!text) return text;
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// Короткая дата для кнопки в модалке звёздочки, напр. "05.09.26"
function formatScheduledDateShort(dateKey) {
    return parseDateKey(dateKey).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

// Полная дата для заголовка модалки дня, напр. "5 сентября 2026"
function formatScheduledDateHuman(dateKey) {
    return capitalizeFirst(parseDateKey(dateKey).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }));
}

// Пересчитывает scheduledByDate (дата -> список тайтлов) на основе
// scheduledByTitle (тайтл -> дата). Вызывать после любого изменения
// scheduledByTitle, как recomputeWatchedBuckets() для просмотренного.
function recomputeScheduledByDate() {
    scheduledByDate = {};
    for (const t in scheduledByTitle) {
        const key = scheduledByTitle[t];
        if (!scheduledByDate[key]) scheduledByDate[key] = [];
        scheduledByDate[key].push(t);
    }
    for (const key in scheduledByDate) {
        scheduledByDate[key].sort((a, b) => a.localeCompare(b, "ru"));
    }
}

// Загрузка календаря запланированных просмотров
async function loadScheduledFromDB() {
    if (!currentUser) return;
    const { data, error } = await db.from('scheduled_items').select('title, scheduled_date');
    if (error) {
        console.error("Ошибка при загрузке календаря просмотров:", error);
        return;
    }
    const temp = {};
    data.forEach(row => { temp[row.title] = row.scheduled_date; });
    scheduledByTitle = temp;
    recomputeScheduledByDate();
}

// Ставит/переносит дату просмотра для тайтла (UPSERT по уникальному title —
// если тайтл уже был запланирован на другую дату, просто переезжает на новую)
async function scheduleTitle(title, dateKey) {
    if (!currentUser) return;

    const previousDate = scheduledByTitle[title];
    scheduledByTitle[title] = dateKey;
    recomputeScheduledByDate();
    refreshUIFromState();

    const { error } = await db.from('scheduled_items')
        .upsert({ user_id: currentUser.id, title: title, scheduled_date: dateKey }, { onConflict: 'title' });

    if (error) {
        console.error("Ошибка при сохранении даты просмотра:", error);
        if (previousDate) { scheduledByTitle[title] = previousDate; } else { delete scheduledByTitle[title]; }
        recomputeScheduledByDate();
        refreshUIFromState();
        alert("Не удалось сохранить дату просмотра.");
    }
}

// Убирает тайтл из календаря совсем (без переноса и без отметки просмотренным)
async function removeScheduledTitle(title) {
    if (!currentUser) return;

    const previousDate = scheduledByTitle[title];
    if (!previousDate) return;
    delete scheduledByTitle[title];
    recomputeScheduledByDate();
    refreshUIFromState();

    const { error } = await db.from('scheduled_items').delete().eq('title', title);
    if (error) {
        console.error("Ошибка при удалении из календаря:", error);
        scheduledByTitle[title] = previousDate;
        recomputeScheduledByDate();
        refreshUIFromState();
    }
}

// Чистит уже прошедшие дни из БД, чтобы таблица не росла бесконечно старыми
// записями (дни в прошлом всё равно никогда не подсвечиваются и не кликабельны
// в календаре). Вызывается один раз при каждом новом заходе в приложение —
// не при каждом мягком обновлении токена/вкладки.
async function cleanupPastScheduledItems() {
    const todayKey = todayDateKey();
    const { error } = await db.from('scheduled_items').delete().lt('scheduled_date', todayKey);
    if (error) {
        console.error("Ошибка при очистке прошедших дней календаря:", error);
    }
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

// Загружает watched/wishlist/ratings параллельными запросами.
// Раньше здесь был быстрый путь через SQL-функцию get_watched_wishlist_ratings,
// но она отдаёт "просмотрено" плоским списком без указания, КЕМ именно
// отмечено — а это как раз нужно для деления на "мной/партнёром/нами".
// Поэтому теперь всегда идём напрямую, тремя параллельными запросами.
async function loadUserDataFromDB() {
    if (!currentUser) return;
    await Promise.all([loadWatchedFromDB(), loadWishlistFromDB(), loadRatingsFromDB(), loadScheduledFromDB()]);
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

// Перезагружает оценки из базы (карточки саму оценку больше не показывают —
// она видна только в модалке тайтла, которая читает ratingsData заново
// при каждом открытии, так что точечно патчить DOM карточек тут не нужно).
async function refreshRatingsUI() {
    await loadRatingsFromDB();
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
            () => { queueLiveChange('watched_items'); }
        )
        // Следим за вишлистом
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'wishlist_items' },
            () => { queueLiveChange('wishlist_items'); }
        )
        // Следим за оценками
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'ratings' },
            () => { queueLiveChange('ratings'); }
        )
        // Следим за календарём запланированных просмотров
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'scheduled_items' },
            () => { queueLiveChange('scheduled_items'); }
        )
        // Следим за самим каталогом (тайтлы добавил/изменил партнёр)
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'titles' },
            (payload) => { onCatalogRealtimeChange(payload); }
        )
        // Следим за общим питомцем (см. pet.js)
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'pet' },
            (payload) => { onPetRealtimeChange(payload); }
        )
        // Следим за чатом (отдельно от каталога, поиск это не затрагивает)
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'chat_messages' },
            (payload) => { onChatRealtimeChange(payload); }
        )
        .subscribe((status) => {
            realtimeConnected = status === "SUBSCRIBED";
        });
}

// Изменения от партнёра приходят по одному событию на строку (а отметка
// "просмотрено нами" — это сразу несколько строк). Раньше на КАЖДОЕ событие
// заново скачивались все 4 таблицы. Теперь события копятся ~300 мс и
// перезагружаются только те таблицы, которые реально поменялись.
// Только для изменений ИЗВНЕ: после своего оптимистичного действия (клик по
// звёздочке) звать это нельзя — чтение может обогнать запись и откатить
// свежее локальное состояние. Для своих действий — refreshUIFromState().
const LIVE_TABLE_LOADERS = {
    watched_items: () => loadWatchedFromDB(),
    wishlist_items: () => loadWishlistFromDB(),
    ratings: () => loadRatingsFromDB(),
    scheduled_items: () => loadScheduledFromDB(),
};
const pendingLiveTables = new Set();
let liveChangeTimer = null;

function queueLiveChange(table) {
    pendingLiveTables.add(table);
    clearTimeout(liveChangeTimer);
    liveChangeTimer = setTimeout(async () => {
        const tables = [...pendingLiveTables];
        pendingLiveTables.clear();
        if (!currentUser) return;
        await Promise.all(tables.map(t => LIVE_TABLE_LOADERS[t]()));
        refreshUIFromState();
    }, 300);
}

// Тайтлы обычно добавляют пачкой (экран "Добавить тайтлы") — realtime
// присылает по событию на строку, поэтому перезагрузку каталога слегка
// откладываем и делаем одну на всю пачку.
let catalogRealtimeTimer = null;
function onCatalogRealtimeChange(payload) {
    // Партнёр (или мы сами) только дописали постер/жанры из TMDB — название,
    // год и место в каталоге те же. Весь каталог ради этого не перекачиваем:
    // просто кладём новые данные в память.
    if (payload && payload.eventType === "UPDATE" && payload.new) {
        const row = payload.new;
        const itemText = `${row.title} (${row.year})`;
        const local = titleRows[itemText];
        if (local && local.id === row.id && local.category === row.category &&
            local.genre === row.genre && (local.franchise || null) === (row.franchise || null)) {
            Object.assign(local, row);
            rememberTitleMeta(itemText, row);
            return;
        }
    }
    clearTimeout(catalogRealtimeTimer);
    catalogRealtimeTimer = setTimeout(async () => {
        await loadCatalogFromDB();
        if (!currentUser) return;
        ensureMainShell();
        // Главную перерисовываем сразу (она дешёвая); экраны каталога —
        // нет, чтобы список не прыгал под пальцем: свежие данные подхватятся
        // при следующем переходе
        if (document.body.dataset.section === "home") showHome();
    }, 800);
}

// Перерисовывает интерфейс на основе уже имеющегося в памяти состояния
// (watchedTitles/wishlistTitles/ratingsData и т.д.), БЕЗ обращения к базе.
// Именно эту функцию нужно звать сразу после оптимистичного локального
// изменения (клик по звёздочке), чтобы не словить гонку с loadUserDataFromDB().
function refreshUIFromState() {
    // 1. Счётчики на главной и в боковом меню оболочки
    const homeStatWishlist = document.getElementById("homeStatWishlist");
    if (homeStatWishlist) homeStatWishlist.textContent = wishlistTitles.size;
    const homeStatWatched = document.getElementById("homeStatWatched");
    if (homeStatWatched) homeStatWatched.textContent = getAllWatchedTitles().length;
    updateShellCounts(getShellListCounts());

    // 2. Обновляем состояние кнопок ⭐/🔖 на карточках (секретная категория
    // карточек с кнопками не имеет — .catalog-card там вообще не создаётся,
    // см. renderItemRow)
    document.querySelectorAll(".catalog-card").forEach(card => {
        const itemDiv = card.querySelector(".item[data-item-text]");
        if (!itemDiv) return;
        const itemText = itemDiv.dataset.itemText;

        const starBtn = card.querySelector(".cc-btn-star");
        if (starBtn) {
            starBtn.classList.toggle("cc-active", getMyRatingScore(itemText) != null);
        }

        const bookmarkBtn = card.querySelector(".cc-btn-bookmark");
        if (bookmarkBtn) {
            bookmarkBtn.classList.remove("cc-active", "cc-wishlist");
            if (watchedTitles.has(itemText)) {
                bookmarkBtn.classList.add("cc-active");
            } else if (wishlistTitles.has(itemText)) {
                bookmarkBtn.classList.add("cc-wishlist");
            }
        }
    });

    // 3. Экраны "Просмотрено"/"Будем смотреть" строятся "на лету" из текущего
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
    } else if (isCalendarScreenOpen) {
        renderCalendarScreen();
    }
}

// Мягкое обновление текущего экрана
async function refreshCurrentScreen() {
    await loadCatalogFromDB();
    if (history.length > 0) {
        let currentActiveData = history[history.length - 1];
        // preservePage: true — это перерисовка ТОГО ЖЕ экрана (например,
        // после фонового обновления из БД), а не переход на новый, поэтому
        // страница пагинации, на которой был пользователь, не должна сбрасываться.
        openData(currentActiveData, false, null, true);
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

    // Если тайтл был запланирован в календаре — просмотренное снимает его
    // оттуда тоже (нет смысла держать в планах то, что уже посмотрели)
    if (scheduledByTitle.hasOwnProperty(title)) {
        delete scheduledByTitle[title];
        recomputeScheduledByDate();
        db.from('scheduled_items').delete().eq('title', title).then(({ error }) => {
            if (error) console.error("Не удалось убрать из календаря при отметке просмотренного:", error);
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

    const scheduledDate = scheduledByTitle[title];
    if (scheduledDate) {
        optionsHtml += `<button id="choiceReschedule" class="btn-pink-style">🗓️ Перенести (сейчас: ${formatScheduledDateShort(scheduledDate)})</button>`;
        optionsHtml += `<button id="choiceRemoveSchedule" class="btn-pink-style">❌ Убрать из календаря</button>`;
    } else {
        optionsHtml += `<button id="choiceSchedule" class="btn-pink-style">🗓️ Запланировать</button>`;
    }

    optionsHtml += `<button id="choiceCancel" class="btn-cancel-gray">Отмена</button>`;

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 10px;">Действие с тайтлом</h3>
            <p style="color: #cbb8e8; margin-bottom: 20px; font-size: 14px;">"${title.replace(/\s*\(\d{4}\)$/, "")}"</p>
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

    const scheduleBtn = document.getElementById("choiceSchedule") || document.getElementById("choiceReschedule");
    if (scheduleBtn) {
        scheduleBtn.onclick = () => {
            overlay.remove();
            showScheduleDateModal(title);
        };
    }

    const removeScheduleBtn = document.getElementById("choiceRemoveSchedule");
    if (removeScheduleBtn) {
        removeScheduleBtn.onclick = () => {
            overlay.remove();
            removeScheduledTitle(title);
        };
    }

    const watchMeBtn = document.getElementById("choiceWatchMe");
    if (watchMeBtn) {
        watchMeBtn.onclick = () => {
            spawnSparkBurstAt(watchMeBtn);
            overlay.remove();
            markWatched(title, false);
        };
    }

    const watchBothBtn = document.getElementById("choiceWatchBoth");
    if (watchBothBtn) {
        watchBothBtn.onclick = () => {
            spawnSparkBurstAt(watchBothBtn);
            overlay.remove();
            markWatched(title, true);
        };
    }

    document.getElementById("choiceCancel").onclick = () => {
        overlay.remove();
    };
}

// Модальное окно выбора даты для "Запланировать"/"Перенести". originDateKey —
// необязательная дата-по-умолчанию (используется при переносе из модалки дня
// календаря, чтобы поле было предзаполнено текущей датой этого дня).
function showScheduleDateModal(title, originDateKey) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "scheduleDateModal";

    const displayTitle = title.replace(/\s*\(\d{4}\)$/, "");
    const todayKey = todayDateKey();
    const currentValue = scheduledByTitle[title] || originDateKey || todayKey;

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3>🗓️ Дата просмотра</h3>
            <p style="color: #cbb8e8; margin-bottom: 20px; font-size: 14px;">"${displayTitle}"</p>
            <div class="modal-form">
                <input type="date" id="scheduleDateInput" min="${todayKey}" value="${currentValue}">
            </div>
            <div class="modal-buttons">
                <button id="scheduleDateSave" class="btn-save">Сохранить</button>
                <button id="scheduleDateCancel" class="btn-cancel">Отмена</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    document.getElementById("scheduleDateCancel").onclick = () => overlay.remove();

    document.getElementById("scheduleDateSave").onclick = async () => {
        const input = document.getElementById("scheduleDateInput");
        const chosen = input.value;
        if (!chosen) { alert("Выберите дату."); return; }
        if (chosen < todayKey) { alert("Нельзя выбрать прошедшую дату — только сегодня или позже."); return; }
        overlay.remove();
        await scheduleTitle(title, chosen);
    };
}

// Короткая киберпанк-глитч-вспышка, проигрывается один раз поверх уже
// отрисованного экрана при настоящем входе в приложение — см. подключение
// в onLogin() ниже. Два независимых слоя эффекта:
//  1) .container сам на секунду "ломается" — дёргается transform'ом
//     (translate/skew) и цветовым filter'ом (hue-rotate/saturate/contrast)
//     рывками (steps(), без плавного тайминга) — это и есть настоящая
//     "поломка геометрии" реального интерфейса, а не имитация поверх него.
//  2) Поверх всего — несколько небольших блоков пиксельного шума в
//     розово-голубых тонах, раскиданных по случайным местам экрана и
//     мигающих рывками (не сплошные полосы во весь экран, а именно
//     разрозненные "битые" пиксельные пятна, как в типичном glitch-арте).
function buildGlitchBlocks(count) {
    let html = "";
    for (let i = 0; i < count; i++) {
        const top = (Math.random() * 88).toFixed(1);
        const left = (Math.random() * 82).toFixed(1);
        const w = (8 + Math.random() * 18).toFixed(1);
        const h = (4 + Math.random() * 9).toFixed(1);
        const delay = (Math.random() * 0.22).toFixed(2);
        const tint = i % 2 === 0 ? "lgo-block-cyan" : "lgo-block-pink";
        html += `<div class="lgo-block ${tint}" style="top:${top}vh; left:${left}vw; width:${w}vw; height:${h}vh; animation-delay:${delay}s;"></div>`;
    }
    return html;
}

function playLoginGlitchAnimation() {
    const existing = document.getElementById("loginGlitchOverlay");
    if (existing) existing.remove(); // на случай двойного срабатывания — не копим оверлеи

    // Слой 1 — реальная геометрия .container
    const containerEl = document.querySelector(".container");
    if (containerEl) {
        containerEl.classList.remove("glitch-active");
        void containerEl.offsetWidth; // форс reflow — чтобы анимация гарантированно перезапустилась
        containerEl.classList.add("glitch-active");
        containerEl.addEventListener("animationend", function onGeomEnd(e) {
            if (e.animationName === "glitchGeometry") {
                containerEl.classList.remove("glitch-active");
                containerEl.removeEventListener("animationend", onGeomEnd);
            }
        });
    }

    // Слой 2 — разрозненные блоки цветного пиксельного шума
    const overlay = document.createElement("div");
    overlay.className = "login-glitch-overlay";
    overlay.id = "loginGlitchOverlay";
    overlay.innerHTML = `
        <div class="lgo-fullnoise"></div>
        ${buildGlitchBlocks(7)}
    `;
    document.body.appendChild(overlay);

    // animationend всплывает и от дочерних анимаций — реагируем только на
    // завершение анимации самого оверлея (lgoDissolve), а не детей.
    overlay.addEventListener("animationend", (e) => {
        if (e.target === overlay) overlay.remove();
    });
    // Подстраховка на случай, если animationend по какой-то причине не долетит
    setTimeout(() => { if (overlay.isConnected) overlay.remove(); }, 1200);
}

// ============================================================
// ЭФФЕКТ "ОТМОТКИ" VHS-КАССЕТЫ ПРИ КНОПКАХ "⬅️ Назад"/"🏠 Домой"
// ============================================================
// Играет короткую вспышку в стиле перемотки видеокассеты назад и только
// затем выполняет сам переход (navigateFn) — висит на любой кнопке
// навигации ("Назад" и "Домой"), кроме кликов по самим карточкам/тайтлам.
// Технически — те же два слоя, что и в playLoginGlitchAnimation():
//  1) .container дёргается собственной геометрией (класс vhs-active,
//     анимация vhsTracking) — имитация "заедающей" при перемотке плёнки;
//  2) поверх всего — оверлей с бегущими сканлайнами, парой горизонтальных
//     полос шума и OSD-плашкой "◀◀ REW", как у старого видеомагнитофона.
// navigateFn вызывается не сразу, а в момент пика эффекта (см. таймаут
// ниже) — реальная смена контента экрана прячется за рябью шума, а не
// дёргается на глазах пользователя.
let vhsRewindInProgress = false;

function buildVhsNoiseBands(count) {
    let html = "";
    for (let i = 0; i < count; i++) {
        const top = (Math.random() * 92).toFixed(1);
        const h = (1.4 + Math.random() * 3.2).toFixed(1);
        const delay = (Math.random() * 0.18).toFixed(2);
        const shift = (6 + Math.random() * 14).toFixed(1);
        const tint = i % 2 === 0 ? "vhs-band-cyan" : "vhs-band-pink";
        html += `<div class="vhs-noise-band ${tint}" style="top:${top}vh; height:${h}vh; animation-delay:${delay}s; --band-shift:${shift}vw;"></div>`;
    }
    return html;
}

function playVhsRewindTransition(navigateFn) {
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || vhsRewindInProgress) {
        // При "уменьшить анимацию" в ОС или если предыдущий эффект ещё не
        // доиграл — просто переходим сразу, без визуального шума.
        navigateFn();
        return;
    }
    vhsRewindInProgress = true;

    // Слой 1 — реальная геометрия .container "дрожит", как плёнка на трекинге
    const containerEl = document.querySelector(".container");
    if (containerEl) {
        containerEl.classList.remove("vhs-active");
        void containerEl.offsetWidth; // форс reflow — анимация гарантированно перезапустится
        containerEl.classList.add("vhs-active");
        containerEl.addEventListener("animationend", function onTrackEnd(e) {
            if (e.animationName === "vhsTracking") {
                containerEl.classList.remove("vhs-active");
                containerEl.removeEventListener("animationend", onTrackEnd);
            }
        });
    }

    // Слой 2 — сканлайны, полосы шума и OSD "◀◀ REW" поверх всего экрана
    const existingOverlay = document.getElementById("vhsRewindOverlay");
    if (existingOverlay) existingOverlay.remove(); // на случай двойного срабатывания

    const overlay = document.createElement("div");
    overlay.className = "vhs-rewind-overlay";
    overlay.id = "vhsRewindOverlay";
    overlay.innerHTML = `
        <div class="vhs-scanlines"></div>
        ${buildVhsNoiseBands(5)}
        <div class="vhs-vignette"></div>
        <div class="vhs-osd">◀◀&nbsp;REW</div>
    `;
    document.body.appendChild(overlay);

    // Сама смена экрана — на пике эффекта, пока шум ещё перекрывает контент,
    // чтобы подмена содержимого была не видна пользователю напрямую.
    setTimeout(() => {
        navigateFn();
    }, 220);

    // animationend всплывает и от дочерних анимаций (полос, сканлайнов) —
    // реагируем только на завершение анимации самого оверлея (vhsDissolve).
    overlay.addEventListener("animationend", (e) => {
        if (e.target === overlay) {
            overlay.remove();
            vhsRewindInProgress = false;
        }
    });
    // Подстраховка на случай, если animationend по какой-то причине не долетит
    setTimeout(() => {
        if (overlay.isConnected) overlay.remove();
        vhsRewindInProgress = false;
    }, 1200);
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

        sessionStorage.setItem("playLoginGlitch", "1");
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) {
            sessionStorage.removeItem("playLoginGlitch");
            alert("Ошибка входа: неверный никнейм или пароль.");
            console.error("Ошибка авторизации:", error.message);
        }
    };

    // ---------- Автовход по NFC-карте ----------
    // Карта прошита ссылкой вида "https://сайт/?nfc_u=ИМЯ&nfc_p=ПАРОЛЬ" —
    // при касании телефон открывает эту ссылку, а дальше просто подставляем
    // значения в обычную форму логина и сами жмём "Войти" — работает
    // ровно тем же кодом, что и обычный ручной вход выше. Сами параметры
    // сразу убираем из адресной строки (history.replaceState), чтобы пароль
    // не висел там дольше необходимого и не осел в истории браузера.
    const nfcParams = new URLSearchParams(location.search);
    const nfcUser = nfcParams.get("nfc_u");
    const nfcPass = nfcParams.get("nfc_p");
    if (nfcUser && nfcPass) {
        window.history.replaceState(null, "", location.pathname);
        document.getElementById("loginUsername").value = nfcUser;
        document.getElementById("loginPassword").value = nfcPass;
        document.getElementById("loginForm").requestSubmit();
    }
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
    searchContainer.className = "search-bar";
    searchContainer.innerHTML = shellIcon("search");

    let searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "search-input-field";
    searchInput.placeholder = "Поиск по каталогу";
    searchInput.enterKeyHint = "search";
    searchInput.value = prefillQuery;

    let searchSubmitBtn = document.createElement("button");
    searchSubmitBtn.type = "button";
    searchSubmitBtn.className = "ui-btn search-bar-btn";
    searchSubmitBtn.title = "Искать";
    searchSubmitBtn.textContent = "→";

    let filterBtn = document.createElement("button");
    filterBtn.type = "button";
    filterBtn.className = "ui-btn search-bar-btn btn-filter-icon";
    filterBtn.title = "Фильтры";
    filterBtn.classList.toggle("active", hasActiveFilters(searchFilters));
    filterBtn.textContent = "⚙️";

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
// ==========================================
// АНИМИРОВАННАЯ ПЛАШКА ГЛАВНОГО ЭКРАНА ("Время Кино" и т.д.)
// ==========================================
// Фразы печатаются посимвольно (как ввод текста), немного "стоят" уже
// напечатанными, затем стираются с конца — и так по кругу.
const HERO_PHRASES = ["Время Кино 🎬", "Что посмотрим? 👀", "Попкорн-тайм! 🍿", "Эчпочмоня 😈", "Люблю Тебя! ❤️"];

// Эмодзи (и вообще многие символы вроде флагов/составных эмодзи) в JS-строке
// занимают больше одной "единицы": слайс строки по .slice(0, N) может
// разрезать эмодзи ровно пополам — и на один кадр анимации браузер рисует
// вместо целого эмодзи "битый" символ (ромбик с "?"). Чтобы печатать/стирать
// строго по целым видимым символам, разбиваем фразу на графемы через
// Intl.Segmenter (с фолбэком на Array.from для старых браузеров — тот хотя
// бы не бьёт пары суррогатов, даже если не всегда идеально группирует
// составные эмодзи).
function splitIntoGraphemes(str) {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
        const segmenter = new Intl.Segmenter("ru", { granularity: "grapheme" });
        return Array.from(segmenter.segment(str), (s) => s.segment);
    }
    return Array.from(str);
}
const HERO_PHRASE_GRAPHEMES = HERO_PHRASES.map(splitIntoGraphemes);
let heroTypewriterTimer = null;

function startHeroTypewriter(textEl) {
    if (!textEl) return;
    // showHome() перерисовывает экран с нуля при каждом заходе — глушим
    // предыдущий таймер, чтобы они не копились и не печатали "поверх" друг друга.
    if (heroTypewriterTimer) { clearTimeout(heroTypewriterTimer); heroTypewriterTimer = null; }

    const TYPE_MS = 95;    // скорость печати одного символа
    const DELETE_MS = 45;  // скорость стирания одного символа (чуть быстрее печати)
    const HOLD_MS = 2000;  // сколько фраза "стоит" полностью напечатанной
    const GAP_MS = 250;    // короткая пауза перед началом следующей фразы

    let phraseIndex = 0;
    let charIndex = 0;
    let mode = "typing"; // typing -> holding -> deleting -> gap -> typing...

    const cursorEl = textEl.parentElement ? textEl.parentElement.querySelector(".movie-time-cursor") : null;

    // Подгоняет размер шрифта так, чтобы текущий текст (с учётом курсора)
    // всегда помещался в одну строку по ширине плашки, на любом экране.
    function fitPlateText() {
        const plateInner = textEl.parentElement;
        const plate = plateInner ? plateInner.parentElement : null;
        if (!plate) return;
        const MAX_FONT = 30;
        const MIN_FONT = 15;
        textEl.style.fontSize = MAX_FONT + "px";
        if (cursorEl) cursorEl.style.fontSize = MAX_FONT + "px";
        const plateStyles = getComputedStyle(plate);
        const horizontalPadding = parseFloat(plateStyles.paddingLeft || "0") + parseFloat(plateStyles.paddingRight || "0");
        const available = plate.clientWidth - horizontalPadding;
        const needed = textEl.scrollWidth + (cursorEl ? cursorEl.offsetWidth : 10);
        if (available > 0 && needed > available) {
            const scaled = Math.max(MIN_FONT, Math.floor(MAX_FONT * available / needed));
            textEl.style.fontSize = scaled + "px";
            if (cursorEl) cursorEl.style.fontSize = scaled + "px";
        }
    }

    function tick() {
        // Пользователь ушёл с главного экрана — плашки больше нет в DOM,
        // останавливаемся, чтобы не тикать вхолостую в фоне вечно.
        if (!document.body.contains(textEl)) { heroTypewriterTimer = null; return; }

        const graphemes = HERO_PHRASE_GRAPHEMES[phraseIndex];

        if (mode === "typing") {
            charIndex++;
            textEl.textContent = graphemes.slice(0, charIndex).join("");
            fitPlateText();
            if (charIndex >= graphemes.length) {
                mode = "holding";
                heroTypewriterTimer = setTimeout(tick, HOLD_MS);
            } else {
                heroTypewriterTimer = setTimeout(tick, TYPE_MS);
            }
        } else if (mode === "holding") {
            mode = "deleting";
            heroTypewriterTimer = setTimeout(tick, DELETE_MS);
        } else if (mode === "deleting") {
            charIndex--;
            textEl.textContent = graphemes.slice(0, charIndex).join("");
            fitPlateText();
            if (charIndex <= 0) {
                mode = "gap";
                heroTypewriterTimer = setTimeout(tick, GAP_MS);
            } else {
                heroTypewriterTimer = setTimeout(tick, DELETE_MS);
            }
        } else { // gap
            phraseIndex = (phraseIndex + 1) % HERO_PHRASES.length;
            charIndex = 0;
            mode = "typing";
            heroTypewriterTimer = setTimeout(tick, TYPE_MS);
        }
    }

    textEl.textContent = "";
    fitPlateText();
    heroTypewriterTimer = setTimeout(tick, TYPE_MS);
}

// saveMusicPositionBeforeLeaving() теперь определена в core.js (вместе с
// applyMusicResumeState()/setupMusicAutoplay() — вся логика сохранения и
// восстановления позиции музыки живёт в одном месте, см. core.js). Здесь,
// в script.js, только вызовы этой функции перед переходом на Игры/
// Совместный просмотр (ищи по тексту "saveMusicPositionBeforeLeaving(); location.href").

async function showHome() {
    startTransitionLock();
    resetScreenState();
    history = [];
    categoryHistory = [];
    pageHistory = [];
    currentCategoryName = null;
    if (!catalogLoaded) await loadCatalogFromDB();

    if (!currentUser) return;
    ensureMainShell();
    setShellSection("home");

    app.innerHTML = "";
    app.classList.remove("long-list");

    const home = document.createElement("div");
    home.className = "home";
    app.appendChild(home);

    // ---- Верх: приветствие + ближайший просмотр | счётчики и поиск ----
    const top = document.createElement("div");
    top.className = "home-top";
    home.appendChild(top);

    const hero = document.createElement("section");
    hero.className = "home-hero";
    hero.innerHTML = `
        <div>
            <div class="home-hero-kicker"></div>
            <div class="home-hero-title-wrap">
                <div class="home-hero-title"><span class="movie-time-text"></span><span class="movie-time-cursor">|</span></div>
            </div>
        </div>
    `;
    hero.querySelector(".home-hero-kicker").textContent = `Привет, ${getUsernameFromEmail(currentUser.email)} 👋`;
    hero.appendChild(buildHomeNextCard());
    top.appendChild(hero);
    startHeroTypewriter(hero.querySelector(".movie-time-text"));

    const side = document.createElement("div");
    side.className = "home-side";
    top.appendChild(side);

    const stats = document.createElement("div");
    stats.className = "home-stats";
    const stat = (id, value, label, onClick) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn home-stat";
        btn.innerHTML = `<span class="home-stat-value" id="${id}">${value}</span><span class="home-stat-label">${label}</span>`;
        btn.onclick = onClick;
        stats.appendChild(btn);
    };
    const { normal } = getOrderedCategoryKeys();
    stat("homeStatWishlist", wishlistTitles.size, "в планах", () => renderWishlistFolder());
    stat("homeStatWatched", getAllWatchedTitles().length, "просмотрено", () => renderWatchedTop());
    stat("homeStatCatalog", normal.reduce((sum, key) => sum + getAllTitlesFromCategory(dbData[key]).length, 0), "в каталоге",
        () => { if (normal.length) openCategory(normal[0]); });
    side.appendChild(stats);

    // На ПК поиск живёт в верхней панели оболочки, на телефоне — здесь
    const search = document.createElement("div");
    search.className = "home-search only-mobile";
    search.appendChild(buildSearchBar());
    side.appendChild(search);

    // ---- Категории ----
    if (normal.length > 0) {
        const tiles = document.createElement("div");
        tiles.className = "cat-tiles";
        normal.forEach(key => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "ui-btn cat-tile";
            btn.style.setProperty("--h", getCategoryBaseHue(key));
            btn.innerHTML = `
                <span class="cat-tile-emoji">${getCategoryEmoji(key)}</span>
                <span class="cat-tile-name">${escapeHtml(stripLeadingEmoji(key) || key)}</span>
                <span class="cat-tile-count">${formatTitleCount(getAllTitlesFromCategory(dbData[key]).length)}</span>
            `;
            btn.onclick = () => openCategory(key);
            tiles.appendChild(btn);
        });
        const catalogSection = buildUiSection("Каталог", tiles);
        // Совместный просмотр — заметная кнопка под плитками категорий
        catalogSection.appendChild(buildHomeWatchPartyButton());
        home.appendChild(catalogSection);
    } else {
        home.appendChild(buildHomeWatchPartyButton());
    }

    // ---- Ленты постеров ----
    const recentlyAdded = getRecentlyAddedTitles();
    if (recentlyAdded.length > 0) {
        home.appendChild(buildUiSection("Новое на сайте", buildPosterRail(recentlyAdded.slice(0, 24), { badge: "NEW" }),
            () => { currentCategoryName = null; openData(recentlyAdded, true, "⭐ Новое на сайте"); }));
    }

    const wishlist = Array.from(wishlistTitles);
    if (wishlist.length > 0) {
        home.appendChild(buildUiSection("Будем смотреть", buildPosterRail(wishlist.slice(0, 24)), () => renderWishlistFolder()));
    }

    const watchedTogether = Array.from(watchedTitlesBoth);
    if (watchedTogether.length > 0) {
        home.appendChild(buildUiSection("Посмотрели вместе", buildPosterRail(watchedTogether.slice(0, 24)), () => renderWatchedBucket("both")));
    }

    // ---- Питомец (виджет; полная страница — по тапу) — в самом низу ----
    home.appendChild(buildPetWidget());
}

function buildHomeWatchPartyButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ui-btn home-w2g";
    btn.innerHTML = `
        <span class="home-w2g-icon">${shellIcon("w2g")}</span>
        <span class="home-w2g-text">
            <span class="home-w2g-title">Совместный просмотр</span>
            <span class="home-w2g-sub">Одно видео на двоих, синхронно, со звонком и чатом</span>
        </span>
        <span class="home-w2g-go">Смотреть вместе</span>
    `;
    btn.onclick = () => { vibrate(8); shellNavigate("w2g"); };
    return btn;
}

// Карточка "Следующий просмотр" в hero главной: ближайшая дата из календаря,
// а если ничего не запланировано — предложение выбрать фильм рандомайзером.
function buildHomeNextCard() {
    const card = document.createElement("div");
    card.className = "home-next";

    const today = todayDateKey();
    const nextDate = Object.keys(scheduledByDate).filter(d => d >= today && scheduledByDate[d].length > 0).sort()[0];

    if (!nextDate) {
        card.innerHTML = `
            <div class="home-next-poster">🎲</div>
            <div class="home-next-body">
                <div class="home-next-label">Ничего не запланировано</div>
                <div class="home-next-sub">Выберите, что посмотреть, или доверьтесь случаю</div>
            </div>
            <div class="home-next-actions"></div>
        `;
        const actions = card.querySelector(".home-next-actions");
        actions.appendChild(buildUiPill("🎲 Случайно", () => showRandomTitleFromCatalog(), true));
        actions.appendChild(buildUiPill("Календарь", () => showCalendarScreen()));
        return card;
    }

    const titles = scheduledByDate[nextDate];
    const itemText = titles[0];
    const tomorrow = toDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const dayLabel = nextDate === today ? "сегодня" : nextDate === tomorrow ? "завтра" : formatScheduledDateShort(nextDate);

    card.innerHTML = `
        <div class="home-next-poster">🎬</div>
        <div class="home-next-body">
            <div class="home-next-label"></div>
            <div class="home-next-title"></div>
            <div class="home-next-sub"></div>
        </div>
        <div class="home-next-actions"></div>
    `;
    card.querySelector(".home-next-label").textContent = `Смотрим ${dayLabel}`;
    card.querySelector(".home-next-title").textContent = itemText;
    card.querySelector(".home-next-sub").textContent = titles.length > 1 ? `и ещё ${titles.length - 1} в этот день` : "Запланировано в календаре";
    const actions = card.querySelector(".home-next-actions");
    actions.appendChild(buildUiPill("Подробнее", () => showActionMenu(itemText), true));
    actions.appendChild(buildUiPill("Календарь", () => showCalendarScreen()));

    fetchTmdbCardMeta(itemText).then(meta => {
        if (!meta || !meta.posterUrl || !card.isConnected) return;
        const img = document.createElement("img");
        img.className = "home-next-poster";
        img.src = meta.posterUrl;
        img.alt = "";
        card.querySelector(".home-next-poster").replaceWith(img);
    });
    return card;
}

function buildUiPill(label, onClick, accent = false) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ui-btn ui-pill" + (accent ? " ui-pill-accent" : "");
    btn.textContent = label;
    btn.onclick = onClick;
    return btn;
}

function buildUiSection(title, content, onMore = null) {
    const section = document.createElement("section");
    section.className = "ui-section";
    const head = document.createElement("div");
    head.className = "ui-section-head";
    const h = document.createElement("h2");
    h.className = "ui-section-title";
    h.textContent = title;
    head.appendChild(h);
    if (onMore) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "ui-btn ui-link";
        more.textContent = "Все →";
        more.onclick = onMore;
        head.appendChild(more);
    }
    section.appendChild(head);
    section.appendChild(content);
    return section;
}

// Горизонтальная лента постеров. Тап по постеру — та же карточка тайтла,
// что открывается долгим нажатием в каталоге (showActionMenu).
function buildPosterRail(items, { badge = null } = {}) {
    const rail = document.createElement("div");
    rail.className = "rail";
    const track = document.createElement("div");
    track.className = "rail-track";
    rail.appendChild(track);

    items.forEach(itemText => {
        const m = itemText.match(/^(.*)\s\((\d{4})\)$/);
        const card = document.createElement("button");
        card.type = "button";
        card.className = "ui-btn poster-card";
        card.innerHTML = `
            <div class="poster-card-img">🎬${badge ? `<span class="poster-card-badge">${badge}</span>` : ""}</div>
            <div class="poster-card-title"></div>
            ${m ? `<div class="poster-card-year">${m[2]}</div>` : ""}
        `;
        card.querySelector(".poster-card-title").textContent = m ? m[1] : itemText;
        card.onclick = () => showActionMenu(itemText);
        track.appendChild(card);

        fetchTmdbCardMeta(itemText).then(meta => {
            if (!meta || !meta.posterUrl || !card.isConnected) return;
            const img = document.createElement("img");
            img.src = meta.posterUrl;
            img.alt = "";
            img.loading = "lazy";
            img.draggable = false;
            card.querySelector(".poster-card-img").prepend(img);
        });
    });

    // Стрелки прокрутки — только на ПК (на телефоне лента листается пальцем)
    [["prev", -1], ["next", 1]].forEach(([cls, dir]) => {
        const arrow = document.createElement("button");
        arrow.type = "button";
        arrow.className = `ui-btn rail-arrow rail-arrow-${cls}`;
        arrow.setAttribute("aria-label", dir < 0 ? "Назад" : "Вперёд");
        arrow.innerHTML = shellIcon("back");
        arrow.onclick = () => track.scrollBy({ left: dir * track.clientWidth * 0.8 });
        rail.appendChild(arrow);
    });
    return rail;
}

function formatTitleCount(n) {
    const mod10 = n % 10, mod100 = n % 100;
    const word = (mod10 === 1 && mod100 !== 11) ? "тайтл"
        : (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) ? "тайтла" : "тайтлов";
    return `${n} ${word}`;
}

function getAllWatchedTitles() {
    return Array.from(new Set([...watchedTitlesMine, ...watchedTitlesPartner, ...watchedTitlesBoth]));
}

// ==========================================
// ОБОЛОЧКА ГЛАВНОЙ СТРАНИЦЫ (см. shell.js)
// ==========================================

// Категории каталога в фиксированном порядке: Фильмы -> Мультфильмы ->
// Сериалы -> Аниме -> прочие, секретные — отдельно и в самом конце.
function getOrderedCategoryKeys() {
    const priorityOrder = ["Фильм", "Мультфильм", "Сериал", "Аниме"];
    const priority = (key) => {
        if (isSecretCategory(key)) return 1000;
        for (let i = 0; i < priorityOrder.length; i++) {
            if (key.includes(priorityOrder[i])) return i;
        }
        return 500;
    };
    const ordered = Object.keys(dbData).sort((a, b) => priority(a) - priority(b));
    return {
        normal: ordered.filter(key => !isSecretCategory(key)),
        secret: ordered.filter(key => isSecretCategory(key)),
    };
}

function buildShellCategoryList() {
    return getOrderedCategoryKeys().normal.map(key => ({
        key,
        label: stripLeadingEmoji(key) || key,
        emoji: getCategoryEmoji(key),
        count: getAllTitlesFromCategory(dbData[key]).length,
    }));
}

function getShellListCounts() {
    return { wishlist: wishlistTitles.size, watched: getAllWatchedTitles().length };
}

let mainShellReady = false;
function ensureMainShell() {
    if (!mainShellReady) {
        initShell({
            page: "main",
            onNavigate: navigateFromShell,
            categories: buildShellCategoryList(),
            counts: getShellListCounts(),
            searchEl: buildSearchBar(),
        });
        mainShellReady = true;
    } else {
        setShellCategories(buildShellCategoryList());
        updateShellCounts(getShellListCounts());
    }
}

// Общая уборка перед переходом на любой экран: таймер опроса чата, игры,
// полноэкранные режимы (добавление/онлайн-поиск/Паутинка) и флаги экранов.
function resetScreenState() {
    if (isChatScreenOpen) clearChatReplyTarget();
    isChatScreenOpen = false;
    currentWatchedBucket = null;
    isWishlistScreenOpen = false;
    isCalendarScreenOpen = false;
    if (chatPollInterval) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
    }
    if (typeof activeGameCleanup !== "undefined" && activeGameCleanup) {
        activeGameCleanup();
        activeGameCleanup = null;
    }
    document.body.classList.remove("games-screen-active", "batch-add-screen-active", "online-search-screen-active");
}

function clearNavHistory() {
    history = [];
    categoryHistory = [];
    pageHistory = [];
}

// Открывает категорию каталога "с нуля" — из меню, плиток главной или вкладок
function openCategory(key) {
    if (!dbData[key]) return;
    resetScreenState();
    clearNavHistory();
    currentCategoryName = key;
    openData(dbData[key], true);
}

// Пункты бокового меню / вкладок / шторки "Ещё" (см. shell.js).
// Возвращает true, если пункт обработан здесь, на главной странице.
function navigateFromShell(id) {
    if (id.startsWith("category:")) {
        openCategory(id.slice("category:".length));
        return true;
    }
    switch (id) {
        case "home": showHome(); return true;
        case "catalog": {
            const { normal } = getOrderedCategoryKeys();
            if (normal.length) openCategory(normal[0]);
            return true;
        }
        case "wishlist": resetScreenState(); clearNavHistory(); renderWishlistFolder(); return true;
        case "watched": resetScreenState(); clearNavHistory(); renderWatchedTop(); return true;
        case "calendar": resetScreenState(); clearNavHistory(); showCalendarScreen(); return true;
        case "chat": resetScreenState(); clearNavHistory(); showChatScreen(); return true;
        case "comments": resetScreenState(); clearNavHistory(); showAllCommentsScreen(); return true;
        case "random": showRandomizerModal(); return true;
        case "pet": resetScreenState(); clearNavHistory(); showPetScreen(); return true;
        case "secret": {
            const { secret } = getOrderedCategoryKeys();
            if (secret.length) openCategory(secret[0]);
            return true;
        }
        case "add": resetScreenState(); showBatchAddTitlesScreen(); return true;
        case "online": resetScreenState(); showOnlineSearchScreen(); return true;
    }
    return false; // w2g / games / studio / board — отдельные страницы
}

// Диплинк с других страниц сайта (../#wishlist, ../#category:...) — оболочка
// на Играх/Совместном просмотре ведёт сюда для разделов главной
function openScreenFromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return false;
    window.history.replaceState(null, "", location.pathname + location.search);
    if (id === "home") return false;
    if (id.startsWith("category:") && !dbData[id.slice("category:".length)]) return false;
    // Рандомайзер — окно, а не экран: под ним должна быть главная
    if (id === "random") {
        showHome().then(() => showRandomizerModal());
        return true;
    }
    return navigateFromShell(id);
}

// Рандомайзер (колесо фортуны) живёт в randomizer.js — он общий для всех страниц

// Отрисовка строки элемента (тайтла)
// Простой обработчик "долгого нажатия" для одного конкретного элемента
// (постер карточки) — в отличие от делегированной системы itemPress выше
// (которая висит на #app и различает карточки по e.target.closest()), тут
// элементов на экране немного (не сотни — см. пагинацию в openData()), так
// что вешать по паре слушателей на каждый постер не накладно.
function attachLongPress(el, onLongPress, onTap, delay = 550) {
    // На телефоне долгий тап по <img> — это ещё и системный жест браузера
    // ("Сохранить изображение" на iOS, контекстное меню с "Скачать
    // картинку" на Android). Без этих трёх строк он либо перебивает нашу
    // модалку, либо вообще открывается вместо неё.
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.style.webkitTouchCallout = "none";
    el.style.webkitUserSelect = "none";
    el.style.userSelect = "none";

    let timer = null;
    let longPressFired = false;
    let moved = false;
    let sx = 0, sy = 0;

    function clearTimer() {
        if (timer) { clearTimeout(timer); timer = null; }
    }
    function down(e) {
        moved = false;
        longPressFired = false;
        const p = e.touches ? e.touches[0] : e;
        sx = p.clientX; sy = p.clientY;
        clearTimer();
        timer = setTimeout(() => {
            longPressFired = true;
            vibrate([25]);
            onLongPress();
        }, delay);
    }
    function move(e) {
        const p = e.touches ? e.touches[0] : e;
        if (Math.abs(p.clientX - sx) > 10 || Math.abs(p.clientY - sy) > 10) {
            moved = true;
            clearTimer();
        }
    }
    function up() {
        clearTimer();
        if (!moved && !longPressFired && onTap) onTap();
    }
    function cancel() { clearTimer(); }

    el.addEventListener("mousedown", down);
    el.addEventListener("mousemove", move);
    el.addEventListener("mouseup", up);
    el.addEventListener("mouseleave", cancel);
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: true });
    el.addEventListener("touchend", up, { passive: true });
    el.addEventListener("touchcancel", cancel);
}

// Короткая вспышка искр из точки экрана (px-координаты, как у
// getBoundingClientRect) — приятный отклик на действие типа отметки
// "Просмотрено" или выставления оценки. Каждая искра — обычный span с CSS-
// анимацией (см. .spark-particle в CSS), сам себя удаляет по окончании.
function spawnSparkBurst(x, y) {
    const colors = ["#ff2e93", "#8b3bff", "#2ee8ff", "#ffd15c"];
    const count = 10;
    for (let i = 0; i < count; i++) {
        const el = document.createElement("span");
        el.className = "spark-particle";
        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
        const dist = 24 + Math.random() * 26;
        el.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
        el.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
        el.style.left = x + "px";
        el.style.top = y + "px";
        el.style.background = colors[Math.floor(Math.random() * colors.length)];
        document.body.appendChild(el);
        el.addEventListener("animationend", () => el.remove());
    }
}

// Тот же всплеск искр, но по центру конкретного DOM-элемента (кнопки/звезды)
// — вызывать ДО того, как элемент уберут из DOM (overlay.remove() и т.п.),
// иначе getBoundingClientRect() у уже отсоединённого элемента вернёт нули.
function spawnSparkBurstAt(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    spawnSparkBurst(r.left + r.width / 2, r.top + r.height / 2);
}

// Моя личная оценка (из 10) конкретного тайтла, если она есть
function getMyRatingScore(title) {
    if (!currentUser) return null;
    const found = (ratingsData[title] || []).find(r => r.userId === currentUser.id);
    return found ? found.score : null;
}

// Карточка-папка франшизы — тот же .catalog-card, что у тайтла (item 2 из
// правок), только вместо постера текст "Франшиза", без описания и кнопок
// действий — это не тайтл, а переход внутрь списка фильмов франшизы.
function renderFranchiseCard(franchiseName, franchiseTitles, container) {
    let wrapper = document.createElement("div");
    wrapper.className = "movie-item";

    let card = document.createElement("div");
    card.className = "catalog-card catalog-card-franchise";
    card.onclick = () => openData(franchiseTitles, true, "🎞️ " + franchiseName);

    let posterWrap = document.createElement("div");
    posterWrap.className = "cc-poster-wrap cc-poster-franchise";
    posterWrap.textContent = "🎞️ Франшиза";
    card.appendChild(posterWrap);

    let body = document.createElement("div");
    body.className = "cc-body";

    let titleDiv = document.createElement("div");
    // Класс .item — тот же визуальный стиль заголовка, что и у карточки
    // тайтла, но БЕЗ data-item-text: иначе делегированная система выше
    // (селектор .item[data-item-text]) приняла бы название франшизы за
    // название тайтла и попыталась бы искать его в TMDB/на Кинопоиске
    // при долгом нажатии.
    titleDiv.className = "item cc-title";
    titleDiv.textContent = franchiseName;
    body.appendChild(titleDiv);

    card.appendChild(body);
    wrapper.appendChild(card);
    container.appendChild(wrapper);
}

function renderItemRow(itemText, container) {
    let wrapper = document.createElement("div");
    wrapper.className = "movie-item";

    let isSecret = itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал");

    if (currentCategoryName && (currentCategoryName.includes("Секрет") || currentCategoryName.includes("🔒") || currentCategoryName.includes("❤️"))) {
        isSecret = true;
    }

    if (isSecret) {
        // Секретная категория — старое поведение без изменений: скретч-карточка
        // (или фото-плашка), без постера/кнопок/оценок.
        let row = document.createElement("div");
        row.className = "item-row";

        let itemDiv = document.createElement("div");
        itemDiv.className = "item";

        const displayText = itemText.replace(/\s*\(\d{4}\)$/, "");

        if (itemText.includes("Бакс Ориджинал")) {
            itemDiv.classList.add("dev-plaque");

            let photo = document.createElement("img");
            photo.className = "dev-plaque-photo";
            photo.src = DEVELOPER_PHOTO_URL;
            photo.alt = "Разработчик";
            itemDiv.appendChild(photo);

            let textSpan = document.createElement("span");
            textSpan.className = "dev-plaque-text";
            textSpan.textContent = displayText;
            const role = document.createElement("span");
            role.className = "dev-plaque-role";
            role.textContent = "Сделал этот сайт с любовью";
            textSpan.appendChild(role);
            itemDiv.appendChild(textSpan);
        } else {
            itemDiv.classList.add("secret-scratch-card");

            // Карточки идут подряд в одном контейнере — номер считаем по уже добавленным
            const noteNum = container.querySelectorAll(".secret-scratch-card").length + 1;
            let numSpan = document.createElement("span");
            numSpan.className = "secret-note-num";
            numSpan.textContent = `Записка №${noteNum}`;
            itemDiv.appendChild(numSpan);

            let textSpan = document.createElement("span");
            textSpan.className = "secret-scratch-text";
            textSpan.textContent = displayText;
            itemDiv.appendChild(textSpan);

            let scratchCanvas = document.createElement("canvas");
            scratchCanvas.className = "secret-scratch-canvas";
            itemDiv.appendChild(scratchCanvas);

            setupScratchCard(itemDiv, scratchCanvas);
        }

        row.appendChild(itemDiv);
        wrapper.appendChild(row);
        container.appendChild(wrapper);
        return;
    }

    // ==========================================
    // ОБЫЧНАЯ КАРТОЧКА КАТАЛОГА — тот же визуальный язык, что и у карточек
    // результата "Онлайн Поиска" (.online-search-card/.osc-*), только со
    // своими тремя кнопками действий вместо "Добавить".
    // ==========================================
    let card = document.createElement("div");
    card.className = "catalog-card";

    // ---- Постер ----
    let posterWrap = document.createElement("div");
    posterWrap.className = "cc-poster-wrap";

    let posterImg = document.createElement("img");
    posterImg.className = "cc-poster";
    posterImg.alt = itemText;
    posterImg.style.display = "none";
    posterImg.draggable = false;
    posterWrap.appendChild(posterImg);

    let posterPlaceholder = document.createElement("div");
    posterPlaceholder.className = "cc-poster cc-poster-placeholder";
    posterPlaceholder.textContent = "🎬";
    posterWrap.appendChild(posterPlaceholder);

    if (isRecentlyAdded(itemText)) {
        let badge = document.createElement("span");
        badge.className = "cc-new-badge";
        badge.title = "Добавлено недавно";
        badge.textContent = "✦";
        posterWrap.appendChild(badge);
    }

    // Тап (и, по старой привычке, долгое нажатие) по постеру → карточка тайтла
    attachLongPress(
        posterWrap,
        () => showActionMenu(itemText),
        () => showActionMenu(itemText)
    );

    card.appendChild(posterWrap);

    // ---- Тело карточки ----
    let body = document.createElement("div");
    body.className = "cc-body";

    let titleDiv = document.createElement("div");
    titleDiv.className = "item cc-title";
    titleDiv.textContent = itemText;
    // itemText читается делегированными обработчиками на #app (см. выше) —
    // долгое нажатие прямо на название тоже открывает то же полное меню.
    titleDiv.dataset.itemText = itemText;
    body.appendChild(titleDiv);

    let genresP = document.createElement("p");
    genresP.className = "cc-genres";
    genresP.style.display = "none";
    body.appendChild(genresP);

    let descP = document.createElement("p");
    descP.className = "cc-desc";
    descP.style.display = "none";
    body.appendChild(descP);

    // Оценки (моя/партнёра) больше НЕ дублируются мелкой строкой прямо на
    // карточке — только в модалке тайтла по долгому нажатию на постер
    // (см. buildRatingsSummaryHtml / showActionMenu). Звёздочка-кнопка
    // ниже (cc-btn-star) для выставления СВОЕЙ оценки остаётся.

    // ---- Три кнопки действий ----
    let actions = document.createElement("div");
    actions.className = "cc-actions";

    let starBtn = document.createElement("button");
    starBtn.type = "button";
    starBtn.className = "cc-btn cc-btn-star";
    starBtn.title = "Оценить";
    starBtn.textContent = "⭐";
    if (getMyRatingScore(itemText) != null) starBtn.classList.add("cc-active");
    starBtn.onclick = () => showRatingModal(itemText);
    actions.appendChild(starBtn);

    let bookmarkBtn = document.createElement("button");
    bookmarkBtn.type = "button";
    bookmarkBtn.className = "cc-btn cc-btn-bookmark";
    bookmarkBtn.title = "Просмотрено / Будем смотреть";
    bookmarkBtn.textContent = "🔖";
    if (watchedTitles.has(itemText)) {
        bookmarkBtn.classList.add("cc-active");
    } else if (wishlistTitles.has(itemText)) {
        bookmarkBtn.classList.add("cc-wishlist");
    }
    bookmarkBtn.onclick = () => handleStarClick(itemText);
    actions.appendChild(bookmarkBtn);

    let editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "cc-btn cc-btn-edit";
    editBtn.title = "Изменить / Удалить";
    editBtn.textContent = "✏️";
    editBtn.onclick = () => showEditDeleteModal(itemText);
    actions.appendChild(editBtn);

    body.appendChild(actions);
    card.appendChild(body);
    wrapper.appendChild(card);
    container.appendChild(wrapper);

    // Постер/жанры/описание подгружаются с TMDB асинхронно, не блокируя
    // отрисовку остальных карточек страницы.
    fetchTmdbCardMeta(itemText).then(meta => {
        if (!wrapper.isConnected) return;

        if (meta && meta.posterUrl) {
            posterImg.src = meta.posterUrl;
            posterImg.loading = "lazy";
            posterImg.style.display = "block";
            posterPlaceholder.style.display = "none";
        } else {
            // TMDB не нашёл тайтл вовсе, либо нашёл — но без постера
            posterPlaceholder.textContent = "Постер не найден";
            posterPlaceholder.classList.add("cc-poster-empty");
        }

        if (meta && meta.genreNames) {
            genresP.textContent = meta.genreNames;
            genresP.style.display = "";
        }

        descP.textContent = (meta && meta.overview)
            ? (meta.overview.length > 130 ? meta.overview.slice(0, 130) + "…" : meta.overview)
            : "Описание не найдено";
        descP.style.display = "";
    });
}

// Уменьшает размер шрифта секретного текста так, чтобы название всегда
// помещалось в одну строку, независимо от длины и ширины экрана.
function fitSecretTextToOneLine(wrapperEl, cardWidth) {
    const textEl = wrapperEl.querySelector(".secret-scratch-text");
    if (!textEl) return;

    const maxFontSize = 22;
    const minFontSize = 11; // дальше уже не уменьшаем, чтобы не превратить в нечитаемую строку
    const availableWidth = Math.max(20, cardWidth - 40); // за вычетом отступов карточки

    let fontSize = maxFontSize;
    textEl.style.fontSize = fontSize + "px";

    while (textEl.scrollWidth > availableWidth && fontSize > minFontSize) {
        fontSize -= 1;
        textEl.style.fontSize = fontSize + "px";
    }
}

// Сердечки, вылетающие из только что открытой записки
function spawnSecretHearts(cardEl) {
    const HEARTS = ["❤️", "💕", "💖", "💗", "✨"];
    for (let i = 0; i < 14; i++) {
        const heart = document.createElement("span");
        heart.className = "secret-heart";
        heart.textContent = HEARTS[i % HEARTS.length];
        heart.style.left = (10 + Math.random() * 80) + "%";
        heart.style.setProperty("--dx", (Math.random() * 120 - 60) + "px");
        heart.style.setProperty("--dy", (-60 - Math.random() * 90) + "px");
        heart.style.animationDelay = (Math.random() * 0.25) + "s";
        cardEl.appendChild(heart);
        setTimeout(() => heart.remove(), 1600);
    }
}

// Скретч-карточка для секретной категории: содержимое скрыто под "фольгой",
// текст проявляется по мере того, как пользователь "стирает" её пальцем/мышью
// — как лотерейный билет. Полностью счищать не обязательно: как только
// открыто больше половины площади, остаток фольги плавно исчезает сам.
function setupScratchCard(wrapperEl, canvasEl) {
    const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
    let scratching = false;
    let revealed = false;
    let moveCount = 0;
    let cssWidth = 0, cssHeight = 0;

    function drawFoil(w, h) {
        ctx.clearRect(0, 0, w, h);

        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, "#5b1747");
        grad.addColorStop(0.5, "#9b2c6c");
        grad.addColorStop(1, "#45155a");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // Россыпь сердечек и блёсток — детерминированно по размеру карточки,
        // чтобы при перерисовке узор не "прыгал"
        let seed = Math.round(w * 7 + h * 13);
        const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (let i = 0; i < Math.round(w * h / 900); i++) {
            const x = rand() * w, y = rand() * h;
            if (rand() < 0.35) {
                ctx.font = `${10 + rand() * 8}px sans-serif`;
                ctx.globalAlpha = 0.18 + rand() * 0.2;
                ctx.fillStyle = "#ffd1e8";
                ctx.fillText("♥", x, y);
            } else {
                ctx.globalAlpha = 0.25 + rand() * 0.5;
                ctx.fillStyle = "#ffe3a3";
                ctx.beginPath();
                ctx.arc(x, y, 0.8 + rand() * 1.4, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;

        ctx.fillStyle = "rgba(255, 228, 170, 0.98)";
        ctx.font = "700 15px 'Manrope', sans-serif";
        ctx.shadowColor = "rgba(0,0,0,0.35)";
        ctx.shadowBlur = 6;
        ctx.fillText("✨ Погладь Меня ✨", w / 2, h / 2);
        ctx.shadowBlur = 0;
    }

    function sizeCanvas() {
        const rect = wrapperEl.getBoundingClientRect();
        cssWidth = Math.max(1, rect.width);
        cssHeight = Math.max(1, rect.height);
        const dpr = window.devicePixelRatio || 1;
        canvasEl.width = Math.round(cssWidth * dpr);
        canvasEl.height = Math.round(cssHeight * dpr);
        canvasEl.style.width = cssWidth + "px";
        canvasEl.style.height = cssHeight + "px";
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawFoil(cssWidth, cssHeight);

        fitSecretTextToOneLine(wrapperEl, cssWidth);
    }

    function scratchAt(x, y) {
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(x, y, 20, 0, Math.PI * 2);
        ctx.fill();
    }

    function getPos(e) {
        const rect = canvasEl.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function checkProgress() {
        if (!cssWidth || !cssHeight) return;
        const sampleW = 32;
        const sampleH = Math.max(1, Math.round(sampleW * (cssHeight / cssWidth)));
        const sampleCanvas = document.createElement("canvas");
        sampleCanvas.width = sampleW;
        sampleCanvas.height = sampleH;
        const sctx = sampleCanvas.getContext("2d");
        sctx.drawImage(canvasEl, 0, 0, sampleW, sampleH);
        const data = sctx.getImageData(0, 0, sampleW, sampleH).data;
        let clearPixels = 0;
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] < 12) clearPixels++;
        }
        if (clearPixels / (sampleW * sampleH) > 0.5) {
            revealFully();
        }
    }

    function revealFully() {
        if (revealed) return;
        revealed = true;
        canvasEl.style.transition = "opacity 0.35s ease";
        canvasEl.style.opacity = "0";
        vibrate([40, 30, 60]);
        wrapperEl.classList.add("secret-revealed");
        spawnSecretHearts(wrapperEl);
        setTimeout(() => canvasEl.remove(), 380);
    }

    function handleDown(e) {
        if (revealed) return;
        scratching = true;
        canvasEl.setPointerCapture(e.pointerId);
        const p = getPos(e);
        scratchAt(p.x, p.y);
    }
    function handleMove(e) {
        if (!scratching || revealed) return;
        const p = getPos(e);
        scratchAt(p.x, p.y);
        moveCount++;
        if (moveCount % 6 === 0) checkProgress();
    }
    function handleUp() {
        if (revealed) return;
        scratching = false;
        checkProgress();
    }

    canvasEl.addEventListener("pointerdown", handleDown);
    canvasEl.addEventListener("pointermove", handleMove);
    canvasEl.addEventListener("pointerup", handleUp);
    canvasEl.addEventListener("pointercancel", handleUp);

    // Ждём кадр отрисовки, чтобы у обёртки уже был реальный размер
    requestAnimationFrame(sizeCanvas);
}

// Всплывающее меню выбора действия


// Ищет тайтл на Кинопоиске по названию+году через метаданные kinopoisk.dev
// и возвращает ссылку на его страницу на www.kinopoisk.ru, либо null, если
// не нашлось. Год нужен, чтобы не перепутать одноимённые фильмы разных лет —
// при точном совпадении года берём его, иначе допускаем разницу в 1 год
// (премьеру в разных базах иногда считают по разным датам, конец/начало года).
// Возвращает числовой ID тайтла на Кинопоиске (или null, если не нашлось) —
// что дальше делать с этим ID (какую страницу и как открывать), решаете сами.
async function findKinopoiskId(itemText) {
    const m = itemText.match(/^(.*)\s\((\d{4})\)$/);
    const title = m ? m[1] : itemText;
    const year = m ? Number(m[2]) : null;

    try {
        const params = new URLSearchParams({ query: title });
        const res = await fetch(`${SUPABASE_URL}/functions/v1/kinopoisk-search?${params.toString()}`, {
            headers: {
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                apikey: SUPABASE_ANON_KEY
            }
        });
        if (!res.ok) return null;
        const json = await res.json();
        const docs = (json && json.docs) || [];
        if (!docs.length) return null;

        let best = null;
        if (year) {
            best = docs.find(d => d.year === year) || docs.find(d => Math.abs((d.year || 0) - year) <= 1);
        } else {
            best = docs[0];
        }
        return best ? best.id : null;
    } catch (e) {
        console.error("Ошибка поиска на Кинопоиске:", e);
        return null;
    }
}

// То же самое, что findKinopoiskId() выше, но возвращает ещё и настоящий
// рейтинг с Кинопоиска (rating.kp), не только ID. Используется в модалке
// добавления тайтла из онлайн-поиска (showAddFromOnlineSearchModal) — там
// карточки результатов сами по себе с TMDB, а перед реальным сохранением
// тайтла в базу хочется показать точную оценку именно с Кинопоиска.
// Дёргается по одному разу за клик "Добавить" (не на каждую карточку
// результатов поиска сразу) — так укладывается в скромный дневной лимит
// запросов бесплатного токена kinopoisk.dev.
async function findKinopoiskMatch(title, year) {
    try {
        const params = new URLSearchParams({ query: title });
        const res = await fetch(`${SUPABASE_URL}/functions/v1/kinopoisk-search?${params.toString()}`, {
            headers: {
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                apikey: SUPABASE_ANON_KEY
            }
        });
        if (!res.ok) return null;
        const json = await res.json();
        const docs = (json && json.docs) || [];
        if (!docs.length) return null;

        let best = null;
        if (year) {
            best = docs.find(d => d.year === year) || docs.find(d => Math.abs((d.year || 0) - year) <= 1);
        } else {
            best = docs[0];
        }
        if (!best) return null;

        return {
            id: best.id,
            rating: (best.rating && typeof best.rating.kp === "number") ? best.rating.kp : null
        };
    } catch (e) {
        console.error("Ошибка поиска на Кинопоиске:", e);
        return null;
    }
}

// Единая модалка тайтла — открывается долгим нажатием на постер карточки
// (или на название, через делегированную систему itemPress выше).
// Раньше это были два разных модальных окна (полное меню действий +
// отдельная мини-модалка с Кинопоиск ID) — теперь одно: сначала Трейлер,
// потом Комментарии, и под ними просто строка с Кинопоиск ID (без ссылки).
// Редактирование/удаление сюда не входит — за этим отдельная кнопка
// карандаша на карточке (showEditDeleteModal).
// Сводка оценок (моя + партнёра) для модалки тайтла — заменяет собой
// прежнюю кнопку "⭐ Оценить" в модалке закладки (та стала лишней: теперь
// у карточки есть отдельная кнопка ⭐, которая ведёт прямо в showRatingModal).
// Раньше сами оценки были видны только мелкой строкой на карточке
// (.item-ratings) и могли обрезаться — здесь показываем их явно и полностью.
function buildRatingsSummaryHtml(itemText) {
    const ratings = ratingsData[itemText] || [];
    if (ratings.length === 0) {
        return `<p class="am-ratings-empty">Оценок пока нет</p>`;
    }
    const sorted = [...ratings].sort((a, b) => {
        if (currentUser) {
            if (a.userId === currentUser.id) return -1;
            if (b.userId === currentUser.id) return 1;
        }
        return a.username.localeCompare(b.username);
    });
    let rows = sorted.map(r =>
        `<div class="am-rating-row"><span>${escapeHtml(r.username)}</span><span>⭐ ${r.score}/10</span></div>`
    ).join("");
    if (ratings.length > 1) {
        rows += `<div class="am-rating-row am-rating-avg"><span>Средняя</span><span>⭐ ${getAverageRating(itemText)}/10</span></div>`;
    }
    return rows;
}

// Карточка тайтла — всё о нём в одном окне: постер, жанры, описание, оценки
// обоих, статус в наших списках и все действия (раньше часть действий была
// только кнопками на карточке каталога, а часть — только здесь).
function showActionMenu(itemText) {
    if (itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал")) return;

    // На некоторых устройствах долгое нажатие может сработать дважды подряд
    // (mousedown + touchstart) — не плодим две одинаковые модалки с одинаковыми id
    const existingMenu = document.getElementById("actionMenuModal");
    if (existingMenu) existingMenu.remove();

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "actionMenuModal";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const m = itemText.match(/^(.*)\s\((\d{4})\)$/);
    const status = watchedTitles.has(itemText) ? "✓ Просмотрено"
        : wishlistTitles.has(itemText) ? "🍿 Будем смотреть" : null;
    const scheduled = scheduledByTitle[itemText] ? `📅 ${formatScheduledDateShort(scheduledByTitle[itemText])}` : null;

    overlay.innerHTML = `
        <div class="modal-content title-sheet">
            <div class="ts-head">
                <div class="ts-poster"><span>🎬</span></div>
                <div class="ts-info">
                    <h3 class="ts-title" id="menuTitle"></h3>
                    <div class="ts-meta" id="tsMeta"></div>
                    <div class="ts-badges">
                        ${status ? `<span class="ts-badge">${status}</span>` : ""}
                        ${scheduled ? `<span class="ts-badge ts-badge-gold">${scheduled}</span>` : ""}
                    </div>
                </div>
            </div>
            <p class="ts-overview" id="tsOverview"></p>
            <div id="amRatingsBox" class="am-ratings-box"></div>
            <div class="ts-actions">
                <button type="button" class="ui-btn ts-action" id="actRate"><span>⭐</span>Оценить</button>
                <button type="button" class="ui-btn ts-action" id="actLists"><span>🔖</span>В списки</button>
                <button type="button" class="ui-btn ts-action" id="actComment"><span>💬</span>Комментарии</button>
                <button type="button" class="ui-btn ts-action" id="actTrailer"><span>🎬</span>Трейлер</button>
            </div>
            <div class="ts-footer">
                <span id="kinopoiskIdBox">Ищем на Кинопоиске…</span>
                <button type="button" class="ui-btn ui-link" id="actEdit">✏️ Изменить</button>
            </div>
        </div>
    `;

    overlay.querySelector("#menuTitle").textContent = m ? m[1] : itemText;
    overlay.querySelector("#tsMeta").textContent = m ? m[2] : "";
    overlay.querySelector("#amRatingsBox").innerHTML = buildRatingsSummaryHtml(itemText);
    document.body.appendChild(overlay);

    fetchTmdbCardMeta(itemText).then(meta => {
        if (!meta || !overlay.isConnected) return;
        if (meta.posterUrl) overlay.querySelector(".ts-poster").innerHTML = `<img src="${meta.posterUrl}" alt="">`;
        if (meta.genreNames) overlay.querySelector("#tsMeta").textContent = [m && m[2], meta.genreNames].filter(Boolean).join(" · ");
        overlay.querySelector("#tsOverview").textContent = meta.overview || "";
    });

    findKinopoiskId(itemText).then(id => {
        if (!overlay.isConnected) return;
        const kpBox = overlay.querySelector("#kinopoiskIdBox");
        if (!id) {
            kpBox.textContent = "На Кинопоиске не найден";
            return;
        }
        kpBox.innerHTML = `<a href="https://www.kinopoisk.ru/film/${id}/" target="_blank" rel="noopener">Кинопоиск ↗</a> · ID ${id}`;
    });

    // Каждое действие открывает своё окно вместо этого
    const then = (fn) => () => { overlay.remove(); fn(); };
    overlay.querySelector("#actRate").onclick = then(() => showRatingModal(itemText));
    overlay.querySelector("#actLists").onclick = then(() => handleStarClick(itemText));
    overlay.querySelector("#actComment").onclick = then(() => showCommentsModal(itemText));
    overlay.querySelector("#actEdit").onclick = then(() => showEditDeleteModal(itemText));
    overlay.querySelector("#actTrailer").onclick = then(() => {
        const query = encodeURIComponent(itemText + " трейлер");
        window.open(`https://www.youtube.com/results?search_query=${query}`, "_blank");
    });
}


function showEditDeleteModal(itemText) {
    const existingMenu = document.getElementById("editDeleteModal");
    if (existingMenu) existingMenu.remove();

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "editDeleteModal";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 15px;">${escapeHtml(itemText.replace(/\s*\(\d{4}\)$/, ""))}</h3>
            <div class="action-buttons" style="display: flex; flex-direction: column; gap: 10px;">
                <button class="btn-pink-style" id="edmEdit">✏️ Редактировать</button>
                <button class="btn-pink-style" id="edmDelete">❌ Удалить из базы</button>
                <button class="btn-cancel-gray" id="edmCancel">Отмена</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("edmEdit").onclick = () => { overlay.remove(); handleEditClick(itemText); };
    document.getElementById("edmDelete").onclick = () => { overlay.remove(); handleDeleteClick(itemText); };
    document.getElementById("edmCancel").onclick = () => overlay.remove();
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
            <p style="color: #cbb8e8; margin-bottom: 15px; font-size: 14px;">"${itemText.replace(/\s*\(\d{4}\)$/, "")}"</p>
            <div class="rating-stars" id="ratingStars">${starsHtml}</div>
            <p id="ratingValueLabel" style="color: var(--pink-soft); font-weight: bold; margin: 10px 0 20px; min-height: 18px;">${currentScore > 0 ? currentScore + "/10" : ""}</p>
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

            spawnSparkBurstAt(el);
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
            <p style="color: #cbb8e8; margin-bottom: 15px; font-size: 14px;">"${itemText.replace(/\s*\(\d{4}\)$/, "")}"</p>
            <div class="comments-list" id="commentsList">
                <p style="text-align:center;color:#9686b8;font-size:13px;">Загрузка...</p>
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
            listEl.innerHTML = `<p style="text-align:center;color:#9686b8;font-size:13px;">Комментариев пока нет.</p>`;
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
    isCalendarScreenOpen = false;
    if (chatPollInterval) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
    }
    currentCategoryName = null;
    setShellSection("comments");

    app.innerHTML = "";
    app.appendChild(buildChatTabs("comments"));

    let title = document.createElement("h1");
    setEmojiTitle(title, "🗨️ Комментарии");
    app.appendChild(title);

    let container = document.createElement("div");
    container.id = "allCommentsContainer";
    container.innerHTML = `<div class="ui-empty">Загрузка…</div>`;
    app.appendChild(container);

    await renderAllComments(container);
}

// Фильтр ленты комментариев: "all" | "mine" | "partner"
let allCommentsFilter = "all";

// Загружает и (пере)отрисовывает экран "Комментарии" — лента, свежие сверху,
// с разделителями по дням. У каждого комментария — автор, время, текст и
// плашка тайтла (тап по ней — карточка тайтла, по тексту — окно комментария).
async function renderAllComments(container) {
    const allComments = await loadAllComments();
    if (!container.isConnected) return;

    container.innerHTML = "";

    if (allComments.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ui-empty";
        empty.innerHTML = `<span class="ui-empty-emoji">🗨️</span>`;
        empty.appendChild(document.createTextNode("Комментариев пока нет. Оставить первый можно из карточки тайтла."));
        container.appendChild(empty);
        return;
    }

    const isMine = (c) => currentUser && c.user_id === currentUser.id;
    const counts = {
        all: allComments.length,
        mine: allComments.filter(isMine).length,
        partner: allComments.filter(c => !isMine(c)).length,
    };

    const chips = document.createElement("div");
    chips.className = "chip-row";
    [["all", "Все"], ["mine", "Мои"], ["partner", "Партнёра"]].forEach(([key, label]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn chip" + (allCommentsFilter === key ? " active" : "");
        btn.innerHTML = `<span>${label}</span><span class="chip-count">${counts[key]}</span>`;
        btn.onclick = () => {
            if (allCommentsFilter === key) return;
            allCommentsFilter = key;
            renderAllComments(container);
        };
        chips.appendChild(btn);
    });
    container.appendChild(chips);

    const visible = allComments
        .filter(c => allCommentsFilter === "all" || (allCommentsFilter === "mine") === isMine(c))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const feed = document.createElement("div");
    feed.className = "comment-feed";
    let lastDay = null;
    visible.forEach(c => {
        const day = toDateKey(new Date(c.created_at));
        if (day !== lastDay) {
            lastDay = day;
            const sep = document.createElement("div");
            sep.className = "comment-feed-day";
            sep.textContent = formatFeedDay(day);
            feed.appendChild(sep);
        }
        feed.appendChild(buildCommentFeedItem(c, isMine(c), container));
    });
    if (visible.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ui-empty";
        empty.textContent = "Здесь пока пусто";
        feed.appendChild(empty);
    }
    container.appendChild(feed);
}

function formatFeedDay(dateKey) {
    const today = todayDateKey();
    const yesterday = toDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    if (dateKey === today) return "Сегодня";
    if (dateKey === yesterday) return "Вчера";
    const d = parseDateKey(dateKey);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString("ru-RU", sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
}

function buildCommentFeedItem(c, mine, container) {
    const item = document.createElement("article");
    item.className = "comment-feed-item" + (mine ? " comment-feed-mine" : "");

    const name = c.username || "Аноним";
    const m = (c.title || "").match(/^(.*)\s\((\d{4})\)$/);
    item.innerHTML = `
        <div class="cf-avatar"></div>
        <div class="cf-body">
            <div class="cf-head">
                <span class="cf-name"></span>
                <span class="cf-time">${new Date(c.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            <div class="cf-text"></div>
            <button type="button" class="ui-btn cf-title">
                <span class="cf-title-poster">🎬</span>
                <span class="cf-title-name"></span>
                <span class="cf-title-year">${m ? m[2] : ""}</span>
            </button>
        </div>
    `;
    item.querySelector(".cf-avatar").innerHTML = userAvatarHtml(name);
    item.querySelector(".cf-name").textContent = name;
    item.querySelector(".cf-text").textContent = c.comment;
    item.querySelector(".cf-title-name").textContent = m ? m[1] : c.title;

    item.querySelector(".cf-text").onclick = () => showCommentDetailModal(c, container);
    item.querySelector(".cf-title").onclick = () => showActionMenu(c.title);

    fetchTmdbCardMeta(c.title).then(meta => {
        if (!meta || !meta.posterUrl || !item.isConnected) return;
        item.querySelector(".cf-title-poster").innerHTML = `<img src="${meta.posterUrl}" alt="" loading="lazy">`;
    });
    return item;
}

// Модалка одного комментария на общем экране "Комментарии" — открывается
// тапом по (обрезанной в списке) карточке комментария и показывает текст
// целиком. Кнопки "Изменить"/"Удалить" переехали сюда из списка и видны
// только у своего комментария.
function showCommentDetailModal(comment, container) {
    const isMine = currentUser && comment.user_id === currentUser.id;

    const existingModal = document.getElementById("commentDetailModal");
    if (existingModal) existingModal.remove();

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "commentDetailModal";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    overlay.innerHTML = `
        <div class="modal-content" id="commentDetailBody" style="text-align: center;">
            <h3 style="margin-bottom: 2px;">${escapeHtml(comment.username)}</h3>
            <p class="comment-detail-subtitle">${escapeHtml(comment.title.replace(/\s*\(\d{4}\)$/, ""))}</p>
            <p class="comment-detail-text"></p>
            ${isMine ? `
            <div class="action-buttons">
                <button class="btn-action-edit" id="commentDetailEdit">✏️ Изменить</button>
                <button class="btn-action-delete" id="commentDetailDelete">🗑️ Удалить</button>
            </div>` : ``}
            <button class="btn-cancel-gray" id="commentDetailClose" style="width:100%; margin-top: 10px;">Закрыть</button>
        </div>
    `;
    overlay.querySelector(".comment-detail-text").textContent = comment.comment;
    document.body.appendChild(overlay);

    overlay.querySelector("#commentDetailClose").onclick = () => overlay.remove();

    if (isMine) {
        overlay.querySelector("#commentDetailEdit").onclick = () => {
            showCommentDetailEditForm(overlay, comment, container);
        };
        overlay.querySelector("#commentDetailDelete").onclick = async () => {
            if (!confirm("Удалить ваш комментарий?")) return;
            const { error } = await db.from('comments').delete().eq('id', comment.id);
            if (error) {
                alert("Не удалось удалить комментарий.");
                return;
            }
            overlay.remove();
            await renderAllComments(container);
        };
    }
}

// Форма редактирования прямо внутри модалки showCommentDetailModal — заменяет
// собой прежнее редактирование прямо в карточке списка (showInlineCommentEditForm):
// теперь карточки в списке только для чтения, вся работа с комментарием — тут.
function showCommentDetailEditForm(overlay, existingComment, container) {
    const myUsername = getUsernameFromEmail(currentUser.email);
    const body = overlay.querySelector("#commentDetailBody");

    const formBox = document.createElement("div");
    formBox.className = "modal-form";
    formBox.innerHTML = `
        <input type="text" id="commentDetailInput" required maxlength="500" placeholder="Ваш комментарий...">
        <div class="modal-buttons" style="margin-top: 8px;">
            <button type="button" class="btn-save" id="commentDetailSave">Сохранить</button>
            <button type="button" class="btn-cancel" id="commentDetailEditCancel">Отмена</button>
        </div>
    `;

    Array.from(body.children).forEach(child => child.style.display = "none");
    body.appendChild(formBox);

    const input = formBox.querySelector("#commentDetailInput");
    input.value = existingComment.comment;
    input.focus();

    formBox.querySelector("#commentDetailEditCancel").onclick = () => {
        formBox.remove();
        Array.from(body.children).forEach(child => child.style.display = "");
    };

    formBox.querySelector("#commentDetailSave").onclick = async () => {
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

        overlay.remove();
        await renderAllComments(container);
    };
}

// ==========================================
// ПАГИНАЦИЯ (переиспользуемая, как у "Онлайн Поиска") + ВЫБОР КОЛ-ВА НА СТРАНИЦУ
// ==========================================

// Те же правила, что и в showOnlineSearchScreen(): всегда видны первые 2 и
// последние 2 страницы, плюс окно вокруг текущей, разрывы — многоточием.
function computePagerPages(current, total) {
    const pages = new Set([1, total, current]);
    if (total >= 2) pages.add(2);
    if (total - 1 >= 1) pages.add(total - 1);
    if (current - 1 >= 1) pages.add(current - 1);
    if (current + 1 <= total) pages.add(current + 1);
    return Array.from(pages).filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
}

// Строит DOM-пагинатор — переиспользует готовые CSS-классы онлайн-поиска
// (.online-search-pager/.os-page-btn/...), чтобы каталог и поиск выглядели
// одинаково.
function buildNumberedPager(page, totalPages, onGoTo) {
    const pager = document.createElement("div");
    pager.className = "online-search-pager";
    if (totalPages <= 1) return pager;

    const makeBtn = (label, targetPage, disabled, isCurrent) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "os-page-btn" + (isCurrent ? " os-page-current" : "");
        b.textContent = label;
        b.disabled = !!disabled;
        if (!disabled) b.onclick = () => onGoTo(targetPage);
        return b;
    };
    const makeEllipsis = () => {
        const span = document.createElement("span");
        span.className = "os-page-ellipsis";
        span.textContent = "…";
        return span;
    };

    pager.appendChild(makeBtn("‹", Math.max(1, page - 1), page === 1, false));
    let prevPage = 0;
    computePagerPages(page, totalPages).forEach(p => {
        if (prevPage && p - prevPage > 1) pager.appendChild(makeEllipsis());
        pager.appendChild(makeBtn(String(p), p, false, p === page));
        prevPage = p;
    });
    pager.appendChild(makeBtn("›", Math.min(totalPages, page + 1), page === totalPages, false));

    return pager;
}

const CATALOG_PER_PAGE_OPTIONS = [12, 24, 48, 96, 0]; // 0 = "Все"

// Панель "Показывать по: [12/24/48/96/Все]" наверху экрана каталога/поиска.
// onChange вызывается уже ПОСЛЕ того, как catalogItemsPerPage/catalogCurrentPage
// обновлены — просто перерисовывает тот же экран.
function buildPerPageBar(totalItems, onChange) {
    const bar = document.createElement("div");
    bar.className = "catalog-perpage-bar";

    const label = document.createElement("span");
    label.className = "catalog-perpage-label";
    label.textContent = `Тайтлов: ${totalItems} · Показывать по:`;
    bar.appendChild(label);

    const select = document.createElement("select");
    select.className = "catalog-perpage-select";
    CATALOG_PER_PAGE_OPTIONS.forEach(n => {
        const opt = document.createElement("option");
        opt.value = String(n);
        opt.textContent = n === 0 ? "Все" : String(n);
        if (n === catalogItemsPerPage) opt.selected = true;
        select.appendChild(opt);
    });
    select.onchange = () => {
        catalogItemsPerPage = parseInt(select.value, 10);
        localStorage.setItem("catalogItemsPerPage", String(catalogItemsPerPage));
        catalogCurrentPage = 1;
        onChange();
    };
    bar.appendChild(select);

    return bar;
}

function openData(content, saveHistory = true, customTitle = null, preservePage = false) {
    startTransitionLock();
    resetScreenState();
    if (saveHistory) {
        // Перед тем как уйти вглубь (на новый экран поверх текущего),
        // запоминаем страницу пагинации, на которой находился текущий
        // (уходящий на второй план) экран — чтобы goBack() мог вернуть
        // её, а не всегда открывать страницу 1. Подробности — у
        // объявления pageHistory.
        if (history.length > 0) {
            pageHistory[history.length - 1] = catalogCurrentPage;
        }
        history.push(content);
        categoryHistory.push(currentCategoryName);
        pageHistory.push(1);
    }

    app.innerHTML = "";

    // ---- Оболочка: активный раздел и "назад" ----
    const categoryRoot = currentCategoryName && dbData[currentCategoryName] ? currentCategoryName : null;
    const shellSection = categoryRoot
        ? (isSecretCategory(categoryRoot) ? "secret" : "catalog")
        : (currentCategoryName === "🔍 Результаты поиска" ? "search" : "list");
    setShellSection(shellSection, shellSection === "secret" ? null : categoryRoot);
    if (saveHistory) window.scrollTo(0, 0);
    addNavigation();

    // Экран категории: жанры больше не отдельный экран со списком кнопок —
    // это чипы-фильтры над общей сеткой. "Все" — все тайтлы категории сразу.
    let genreCtx = getGenreContext(content);
    // В Секрете нет "Все" — сразу открывается первый раздел
    if (genreCtx && genreCtx.active === null && isSecretCategory(currentCategoryName)) {
        const firstKey = Object.keys(genreCtx.map)[0];
        if (history[history.length - 1] === content) history[history.length - 1] = genreCtx.map[firstKey];
        content = genreCtx.map[firstKey];
        genreCtx = { map: genreCtx.map, active: firstKey };
    }
    const listContent = genreCtx && genreCtx.active === null ? flattenGenreMap(genreCtx.map) : content;

    const titleText = customTitle || (categoryRoot && genreCtx ? categoryRoot : null);
    if (titleText) {
        const head = document.createElement("div");
        head.className = "page-head";
        let title = document.createElement("h1");
        setEmojiTitle(title, titleText);
        head.appendChild(title);
        const total = getAllTitlesFromCategory(listContent).length;
        if (total > 0 && !(categoryRoot && isSecretCategory(categoryRoot))) {
            const meta = document.createElement("div");
            meta.className = "page-head-meta";
            meta.textContent = formatTitleCount(total);
            head.appendChild(meta);
        }
        app.appendChild(head);
        setShellTitle(stripLeadingEmoji(titleText) || titleText);
    }

    if (categoryRoot && genreCtx && isSecretCategory(categoryRoot)) {
        const sub = document.createElement("p");
        sub.className = "secret-sub";
        sub.textContent = "Это только для тебя 💌";
        app.appendChild(sub);
    }

    if (categoryRoot && genreCtx) {
        if (!isSecretCategory(categoryRoot)) app.appendChild(buildCategoryTabs(categoryRoot));
        app.appendChild(buildGenreChips(genreCtx));
    }

    // На экране результатов поиска показываем ту же панель поиска —
    // чтобы можно было искать дальше (на ПК она и так в верхней панели)
    if (currentCategoryName === "🔍 Результаты поиска" && currentUser) {
        const searchWrap = document.createElement("div");
        searchWrap.className = "only-mobile";
        searchWrap.style.marginBottom = "14px";
        searchWrap.appendChild(buildSearchBar(lastSearchQuery));
        app.appendChild(searchWrap);
    }

    // Раньше каждая кнопка/строка добавлялась прямо в #app по одной —
    // для больших категорий (сотня+ тайтлов) это означало отдельный
    // layout/reflow браузера на каждый appendChild подряд, что и давало
    // заметные просадки при открытии таких экранов (особенно на Android).
    // Собираем список в DocumentFragment "за кадром" и вставляем в #app
    // одним куском — макет считается один раз, а не по счётчику элементов.
    const listFragment = document.createDocumentFragment();

    // ---- Пагинация + "Показывать по" — только для плоских списков тайтлов
    // (каталог, результаты поиска/фильтра). У объектов-папок (списки жанров)
    // элементов обычно немного, пагинация им не нужна. Секретную категорию
    // тоже не трогаем — там даже общий счётчик тайтлов скрыт намеренно
    // (см. count-footer ниже), а строка "Тайтлов: N" в панели пагинации
    // выдала бы то же самое число.
    const isInSecretCategory = currentCategoryName && isSecretCategory(currentCategoryName);
    let pageItems = listContent;
    const isPaginatedList = Array.isArray(listContent) && listContent.length > 0 && !isInSecretCategory;

    if (isPaginatedList) {
        if (!preservePage) catalogCurrentPage = 1;

        const totalItems = listContent.length;
        const perPage = catalogItemsPerPage;
        const totalPages = perPage > 0 ? Math.max(1, Math.ceil(totalItems / perPage)) : 1;
        if (catalogCurrentPage > totalPages) catalogCurrentPage = totalPages;
        if (catalogCurrentPage < 1) catalogCurrentPage = 1;

        app.appendChild(buildPerPageBar(totalItems, () => openData(content, false, customTitle, true)));

        if (perPage > 0) {
            const start = (catalogCurrentPage - 1) * perPage;
            pageItems = listContent.slice(start, start + perPage);
        }
    }

    // На больших страницах (25+ тайтлов) карточки .item и кнопки играют
    // entrance-анимацию (fadeUp) ВСЕ ОДНОВРЕМЕННО при каждом открытии
    // экрана — это лишняя работа для рендера/компоновки именно тогда,
    // когда элементов и так много. На маленьких списках анимация остаётся
    // (там она не мешает), на больших — отключаем через класс на #app.
    const isBigList = Array.isArray(pageItems) && pageItems.length > 25;
    app.classList.toggle("long-list", isBigList);

    // Карточки тайтлов идут в отдельную grid-обёртку (тот же визуальный
    // язык, что у карточек "Онлайн Поиска"); кнопки-папки франшиз — обычным
    // списком над сеткой, как и раньше. Секретная категория (скретч-карты/
    // плашка) в эту сетку НЕ попадает — она рассчитана на строку во всю
    // ширину, а не на фиксированную колонку сетки постеров (см. также
    // комментарий у правила .catalog-grid .movie-item в style.css) — раньше
    // это описывалось только в CSS-комментарии, а сам JS всё равно клал
    // туда все строки подряд, из-за чего секретные карточки сминало в
    // узкие колонки грида вместе с постерами.
    const gridContainer = document.createElement("div");
    gridContainer.className = "catalog-grid";

    if (Array.isArray(pageItems)) {
        pageItems.forEach(item => {
            if (typeof item === "string") {
                renderItemRow(item, isInSecretCategory ? listFragment : gridContainer);
            } 
            else if (typeof item === "object" && item !== null) {
                for (let franchiseName in item) {
                    renderFranchiseCard(franchiseName, item[franchiseName], gridContainer);
                }
            }
        });
        if (gridContainer.childElementCount > 0) listFragment.appendChild(gridContainer);
    }
    else if (typeof content === "object" && content !== null) {
        // Запасной вариант: карта жанров без известной категории (на экранах
        // категорий жанры — чипы над сеткой, см. getGenreContext)
        for (let key in content) {
            let value = content[key];
            let button = document.createElement("button");
            button.textContent = key;
            button.onclick = () => openData(value, true);
            listFragment.appendChild(button);
        }
    }

    app.appendChild(listFragment);

    // Показываем общее количество тайтлов внизу экрана категории/жанра
    // (кроме секретной категории — там подсчёт не нужен вовсе). Считаем по
    // ПОЛНОМУ content, а не по текущей странице — иначе цифра "плавала" бы
    // при переключении страниц.
    const totalTitlesCount = getAllTitlesFromCategory(listContent).length;
    if (totalTitlesCount > 0 && !isInSecretCategory && !titleText) {
        let countFooter = document.createElement("p");
        countFooter.className = "count-footer";
        countFooter.textContent = `Всего тайтлов: ${totalTitlesCount}`;
        app.appendChild(countFooter);
    }

    if (isPaginatedList) {
        const totalItems = listContent.length;
        const perPage = catalogItemsPerPage;
        const totalPages = perPage > 0 ? Math.max(1, Math.ceil(totalItems / perPage)) : 1;
        app.appendChild(buildNumberedPager(catalogCurrentPage, totalPages, (p) => {
            catalogCurrentPage = p;
            openData(content, false, customTitle, true);
            window.scrollTo({ top: 0, behavior: "smooth" });
        }));
    }


}

// Контекст экрана категории: какая карта жанров (dbData[категория]) сейчас
// открыта и какой жанр выбран (null — "Все"). null, если это не экран
// категории/жанра (франшиза, поиск, "Новое на сайте").
function getGenreContext(content) {
    const map = currentCategoryName ? dbData[currentCategoryName] : null;
    if (!map || !content) return null;
    // После перезагрузки каталога из БД в history могут лежать уже старые
    // объекты — карту жанров узнаём по типу, а не по ссылке
    if (!Array.isArray(content)) return { map, active: null };
    for (const key in map) {
        if (map[key] === content) return { map, active: key };
    }
    return null;
}

function flattenGenreMap(map) {
    const all = [];
    for (const key in map) all.push(...map[key]);
    sortGenreList(all);
    return all;
}

// Переключает жанр на месте — без нового шага в истории, чтобы "назад"
// не проходил по каждому нажатому чипу
function replaceCurrentScreen(content) {
    if (history.length === 0) {
        openData(content, true);
        return;
    }
    history[history.length - 1] = content;
    categoryHistory[categoryHistory.length - 1] = currentCategoryName;
    pageHistory[pageHistory.length - 1] = 1;
    openData(content, false);
    window.scrollTo(0, 0);
}

function buildGenreChips(genreCtx) {
    const row = document.createElement("div");
    row.className = "chip-row";
    const showCounts = !isSecretCategory(currentCategoryName);
    const chip = (label, list, isActive, onClick) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn chip" + (isActive ? " active" : "");
        const labelSpan = document.createElement("span");
        labelSpan.textContent = label;
        btn.appendChild(labelSpan);
        if (showCounts) {
            const countSpan = document.createElement("span");
            countSpan.className = "chip-count";
            countSpan.textContent = getAllTitlesFromCategory(list).length;
            btn.appendChild(countSpan);
        }
        btn.onclick = isActive ? null : onClick;
        row.appendChild(btn);
        if (isActive) requestAnimationFrame(() => btn.scrollIntoView({ inline: "center", block: "nearest" }));
    };
    if (showCounts) chip("Все", genreCtx.map, genreCtx.active === null, () => replaceCurrentScreen(genreCtx.map));
    Object.keys(genreCtx.map).forEach(key => {
        chip(key, genreCtx.map[key], genreCtx.active === key, () => replaceCurrentScreen(genreCtx.map[key]));
    });
    return row;
}

// Вкладки категорий над каталогом (на телефоне; на ПК категории в боковом меню)
function buildCategoryTabs(activeKey) {
    const { normal } = getOrderedCategoryKeys();
    const tabs = document.createElement("div");
    tabs.className = "segmented only-mobile";
    normal.forEach(key => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn segmented-item" + (key === activeKey ? " active" : "");
        btn.textContent = key;
        btn.onclick = () => { if (key !== activeKey) openCategory(key); };
        tabs.appendChild(btn);
    });
    return tabs;
}

// Откат на один шаг назад по истории экранов (кнопка "назад" в оболочке).
function goBack() {
    history.pop();
    categoryHistory.pop();
    pageHistory.pop();
    let previous = history[history.length - 1];

    if (previous) {
        // Восстанавливаем ту "категорию", которая была актуальна именно
        // для этого экрана — иначе, например, возврат в подкатегорию
        // Секрета после захода в Паутинку и открытия там обычного жанра
        // мог оставить currentCategoryName от этого обычного жанра, и
        // экран Секрета переставал распознаваться как секретный.
        currentCategoryName = categoryHistory[categoryHistory.length - 1] || null;
        // Восстанавливаем страницу пагинации, на которой пользователь
        // был на этом экране до ухода вглубь (см. pageHistory), и просим
        // openData() не сбрасывать её на первую (preservePage = true).
        catalogCurrentPage = pageHistory[pageHistory.length - 1] || 1;
        openData(previous, false, null, true);
    } else {
        showHome();
    }
}

// Показала бы кнопка "⬅️ Назад" (goBack()) в итоге главную страницу?
// Экран текущего шага всегда лежит на вершине history в момент вызова
// (см. openData()) — если под ним больше ничего нет, goBack() снимет его
// и попадёт на пустую историю, а значит вызовет showHome(). В этом случае
// саму кнопку "Назад" смысла показывать нет — "Домой" рядом уже делает
// ровно то же самое.
function backWouldGoHome() {
    return history.length <= 1;
}

// "Назад" для экранов каталога — кнопка в оболочке (см. shell.js)
function addNavigation() {
    setShellBack(backWouldGoHome() ? null : () => playVhsRewindTransition(goBack));
}

// =======================================================
// ЭМОДЗИ И ЦВЕТА КАТЕГОРИЙ
// =======================================================

// Достаёт ведущий эмодзи из строки категории (как setEmojiTitle), либо null
function extractLeadingEmoji(text) {
    const match = String(text).match(/^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/u);
    return match ? match[1] : null;
}
// Убирает ведущий эмодзи + пробел из строки категории
function stripLeadingEmoji(text) {
    return String(text).replace(/^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u, "");
}
// Эмодзи категории: берём собственный из названия, а если его почему-то нет — подставляем по типу
function getCategoryEmoji(catKey) {
    return extractLeadingEmoji(catKey) ||
        (catKey.includes("Мультфильм") ? "🧸" :
         catKey.includes("Сериал") ? "📺" :
         catKey.includes("Аниме") ? "🎌" :
         catKey.includes("Фильм") ? "🎬" : "🗂️");
}
// Базовый оттенок (hue, 0-360) всей категории — тайтлы внутри неё окрашиваются в этом же "семействе" цветов
function getCategoryBaseHue(catKey) {
    if (catKey.includes("Мультфильм")) return 42;   // золотисто-оранжевый
    if (catKey.includes("Сериал")) return 192;       // циан
    if (catKey.includes("Аниме")) return 268;        // фиолетовый
    if (catKey.includes("Фильм")) return 336;        // розовый
    return 12; // запасной вариант — если вдруг появится ещё одна обычная категория сверх этих 4х
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
async function onChatRealtimeChange(payload) {
    const applied = applyChatRealtimeChange(chatMessages, payload, 150);
    if (applied) chatMessages = applied;
    else await loadChatMessages();
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

// (formatChatTime / canModifyChatMessage / buildReplyPreviewText теперь в core.js —
// общие с чатом совместного просмотра в w2g.js)

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
            ${isMine && !canModify ? `<p style="color: #9686b8; font-size: 13px; margin-top: 12px;">Изменять и удалять сообщение можно только в течение 24 часов после отправки.</p>` : ``}
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
            empty.style.cssText = "text-align:center;color:#9686b8;margin-top:20px;font-size:14px;";
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

    // Добавляем новые сообщения на их место, убираем удалённые и обновляем
    // текст отредактированных (см. syncChatBubbles в core.js)
    const addedNew = syncChatBubbles(box, chatMessages, createChatBubble, updateChatBubbleContent);

    // Прокручиваем вниз только если появились новые сообщения и пользователь
    // и так был у нижнего края (чтобы не сбивать чтение старых сообщений)
    if (addedNew && wasNearBottom) {
        box.scrollTop = box.scrollHeight;
    }
}

// Экран чата (не связан с историей навигации каталога/поиска)
async function showChatScreen() {
    startTransitionLock();
    resetScreenState();
    isChatScreenOpen = true;
    currentCategoryName = null;
    setShellSection("chat");

    app.innerHTML = "";
    app.appendChild(buildChatTabs("chat"));

    let title = document.createElement("h1");
    setEmojiTitle(title, "💬 Чат");
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
    chatInput.className = "chat-text-input";
    chatInput.placeholder = "Написать сообщение...";
    chatInput.autocomplete = "off";

    let stickerBtn = document.createElement("button");
    stickerBtn.id = "chatStickerBtn";
    stickerBtn.className = "chat-sticker-btn";
    stickerBtn.type = "button";
    stickerBtn.textContent = "😊";

    let sendBtn = document.createElement("button");
    sendBtn.id = "chatSendBtn";
    sendBtn.className = "chat-send-btn";
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

        // Показываем сообщение сразу же, не дожидаясь realtime-события.
        // Realtime может прийти раньше ответа на insert — тогда сообщение уже
        // в списке; раньше его добавляли второй раз, и обрезка до 150 вместо
        // дубля выкидывала старое сообщение (оно потом «возвращалось»).
        if (data) {
            chatMessages = applyChatRealtimeChange(chatMessages, { eventType: "INSERT", new: data }, 150) || chatMessages;
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

    // Подстраховка на случай проблем с realtime. Пока канал подписан,
    // сообщения и так приходят мгновенно — тогда сверяемся раз в 30 секунд,
    // а если канал отвалился — каждые 4 секунды, как раньше.
    if (chatPollInterval) clearInterval(chatPollInterval);
    let lastChatPoll = Date.now();
    chatPollInterval = setInterval(async () => {
        // На свёрнутой/неактивной вкладке никто эти сообщения не видит —
        // не тратим на них сеть и CPU, подхватим при возврате на вкладку.
        if (!isChatScreenOpen || document.hidden) return;
        if (realtimeConnected && Date.now() - lastChatPoll < 30000) return;
        lastChatPoll = Date.now();
        await loadChatMessages();
        renderChatMessages();
    }, 4000);


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
            const changes = { title: titleVal, year: yearVal, category: catVal, genre: genreVal, franchise: franchiseVal };
            // Другое название или год — это, возможно, уже другой фильм:
            // сбрасываем TMDB-данные, при следующем показе они найдутся заново
            if (titleMetaColumns && (titleVal !== existingItem.title || yearVal !== existingItem.year)) {
                Object.assign(changes, { tmdb_id: null, tmdb_type: null, poster_path: null, tmdb_genres: null, overview: null });
            }
            result = await db
                .from("titles")
                .update(changes)
                .eq("id", existingItem.id);
        } else {
            result = await db
                .from("titles")
                .insert([{ title: titleVal, year: yearVal, category: catVal, genre: genreVal, franchise: franchiseVal }]);
        }

        if (result.error) {
            alert("Ошибка сохранения: " + result.error.message);
        } else {
            // Если при редактировании изменилось название и/или год — у тайтла
            // меняется "полное" имя ("Title (Year)"), которым в таблице
            // comments помечены все комментарии к нему. Переносим их на новое имя,
            // иначе они "отвяжутся" от тайтла и осядут под старым, уже
            // не существующим названием.
            if (existingItem) {
                const oldFullTitle = `${existingItem.title} (${existingItem.year})`;
                const newFullTitle = `${titleVal} (${yearVal})`;

                if (oldFullTitle !== newFullTitle) {
                    const { error: commentsRenameError } = await db
                        .from("comments")
                        .update({ title: newFullTitle })
                        .eq("title", oldFullTitle);

                    if (commentsRenameError) {
                        console.error("Не удалось обновить название тайтла в комментариях:", commentsRenameError.message);
                    }
                }
            }

            overlay.remove();
            await refreshCurrentScreen();
        }
    };
}

// ==========================================
// МАССОВОЕ ДОБАВЛЕНИЕ ТАЙТЛОВ ("таблицей")
// ==========================================
// Раньше кнопка "➕ Добавить тайтл" открывала showAddEditModal() — вертикальную
// форму на один тайтл за раз, во всплывающем окне. Теперь вместо модалки —
// отдельный полноценный экран приложения (как "Совместный просмотр" или
// раздел "Игры"): свой заголовок, своя навигация "⬅️ Назад"/"🏠 Домой" сверху,
// а сама форма занимает весь #app. Заполнение построчное (горизонтальное):
// несколько тайтлов одновременно, каждый — своя строка с полями
// Название/Год/Категория/Жанр/Франшиза. Жанр и франшиза, как и раньше, можно
// выбрать из уже существующих (через <datalist>) или вписать свои — просто
// теперь это доступно в каждой строке отдельно.
//
// На широких экранах строки выглядят как таблица (общая "шапка" сверху один
// раз, поля в ряд) — для этого на время экрана у .container снимается
// обычное ограничение ширины в 500px (см. body.batch-add-screen-active в
// CSS), иначе даже на десктопе пяти полям в ряд было бы физически негде
// поместиться. На узких экранах (телефон) строки становятся отдельными
// карточками, где перед каждым полем всплывает его подпись (см. .mobile-label
// в CSS) — это делает адаптацию через CSS, а не через отдельную вторую вёрстку.
const MAX_BATCH_ADD_ROWS = 10;
const INITIAL_BATCH_ADD_ROWS = 3;

// Возврат с экрана массового добавления туда, откуда его открыли — без
// повторного похода в БД (если ничего не сохраняли, данные и не менялись).
// Логика та же, что в refreshCurrentScreen(): последний экран из history,
// а если history пуст (кнопка живёт на главной) — просто на главную.
function closeBatchAddScreen() {
    document.body.classList.remove("batch-add-screen-active");
    if (history.length > 0) {
        openData(history[history.length - 1], false, null, true);
    } else {
        showHome();
    }
}

function showBatchAddTitlesScreen() {
    const categories = getOrderedCategoryKeys().normal;

    if (categories.length === 0) {
        alert("Нет доступных категорий для добавления тайтла.");
        return;
    }

    resetScreenState();
    document.body.classList.add("batch-add-screen-active");

    setShellSection("add");
    setShellBack(history.length > 0 ? () => playVhsRewindTransition(closeBatchAddScreen) : null);

    app.innerHTML = "";

    const head = document.createElement("div");
    head.className = "page-head";
    const title = document.createElement("h1");
    setEmojiTitle(title, "➕ Добавить тайтлы");
    head.appendChild(title);
    app.appendChild(head);

    const screenWrap = document.createElement("form");
    screenWrap.className = "add-screen";
    screenWrap.noValidate = true;
    screenWrap.innerHTML = `
        <p class="add-hint">
            Нашли тайтл в интернете? Быстрее через
            <button type="button" class="ui-btn ui-link" id="addGoOnline">онлайн-поиск</button> —
            там название, год и жанр подставятся сами.
        </p>
        <div class="add-cards" id="batchRows"></div>
        <button type="button" class="ui-btn add-more" id="batchAddRowBtn">＋ Ещё тайтл</button>
        <div class="add-bar">
            <span class="add-bar-count" id="batchRowCount"></span>
            <button type="submit" class="ui-btn ui-pill ui-pill-accent add-save" id="batchSaveBtn">Сохранить</button>
        </div>
    `;
    app.appendChild(screenWrap);

    const batchRows = screenWrap.querySelector("#batchRows");
    const addRowBtn = screenWrap.querySelector("#batchAddRowBtn");
    const rowCountLabel = screenWrap.querySelector("#batchRowCount");
    const submitBtn = screenWrap.querySelector("#batchSaveBtn");

    screenWrap.querySelector("#addGoOnline").onclick = () => showOnlineSearchScreen();

    const defaultYear = new Date().getFullYear();
    let rowSeq = 0;

    function currentRowEls() {
        return Array.from(batchRows.querySelectorAll(".add-card"));
    }

    function filledRowCount() {
        return currentRowEls().filter(row => row.querySelector(".rTitle").value.trim()).length;
    }

    function updateRowChrome() {
        const rows = currentRowEls();
        rows.forEach((row, i) => {
            row.querySelector(".add-card-num").textContent = `Тайтл ${i + 1}`;
            row.querySelector(".add-card-remove").hidden = rows.length < 2;
        });
        const filled = filledRowCount();
        rowCountLabel.textContent = filled > 0 ? `Готово к сохранению: ${filled}` : "Заполните хотя бы название";
        submitBtn.disabled = filled === 0;
        submitBtn.textContent = filled > 1 ? `Сохранить ${filled}` : "Сохранить";
        addRowBtn.hidden = rows.length >= MAX_BATCH_ADD_ROWS;
    }

    // Подсказки жанров/франшиз — из уже существующих в выбранной категории
    function refreshSuggestions(rowEl) {
        const category = rowEl.dataset.category;
        populateGenreDatalist(rowEl.querySelector(".rGenreList"), category);
        populateFranchiseDatalist(rowEl.querySelector(".rFranchiseList"), category, rowEl.querySelector(".rGenre").value.trim());
    }

    function addRow(prefill = {}) {
        if (currentRowEls().length >= MAX_BATCH_ADD_ROWS) return null;

        rowSeq++;
        const rowId = `batchRow${rowSeq}`;

        const rowEl = document.createElement("div");
        rowEl.className = "add-card";
        rowEl.dataset.category = prefill.category || categories[0];
        rowEl.innerHTML = `
            <div class="add-card-head">
                <span class="add-card-num"></span>
                <button type="button" class="ui-btn add-card-remove" title="Убрать">✕</button>
            </div>
            <div class="add-row add-row-title">
                <label class="add-field add-field-grow">
                    <span>Название</span>
                    <input type="text" class="rTitle" placeholder="Например: Крик 7" autocomplete="off">
                </label>
                <label class="add-field add-field-year">
                    <span>Год</span>
                    <input type="number" class="rYear" inputmode="numeric" placeholder="${defaultYear}">
                </label>
            </div>
            <div class="add-cats"></div>
            <div class="add-row">
                <label class="add-field add-field-grow">
                    <span>Жанр</span>
                    <input type="text" class="rGenre" placeholder="Начните вводить" list="${rowId}-genres" autocomplete="off">
                    <datalist class="rGenreList" id="${rowId}-genres"></datalist>
                </label>
                <label class="add-field add-field-grow">
                    <span>Франшиза <em>необязательно</em></span>
                    <input type="text" class="rFranchise" placeholder="—" list="${rowId}-franchises" autocomplete="off">
                    <datalist class="rFranchiseList" id="${rowId}-franchises"></datalist>
                </label>
            </div>
        `;
        rowEl.querySelector(".rYear").value = prefill.year || defaultYear;

        // Категория — чипами, а не выпадающим списком: их всего 4
        const catsEl = rowEl.querySelector(".add-cats");
        categories.forEach(cat => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "ui-btn chip" + (cat === rowEl.dataset.category ? " active" : "");
            chip.textContent = cat;
            chip.onclick = () => {
                if (rowEl.dataset.category === cat) return;
                rowEl.dataset.category = cat;
                catsEl.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === chip));
                rowEl.querySelector(".rGenre").value = "";
                refreshSuggestions(rowEl);
            };
            catsEl.appendChild(chip);
        });

        batchRows.appendChild(rowEl);

        rowEl.querySelector(".rGenre").addEventListener("input", () => refreshSuggestions(rowEl));
        rowEl.querySelector(".rTitle").addEventListener("input", updateRowChrome);
        rowEl.querySelector(".add-card-remove").onclick = () => {
            rowEl.remove();
            updateRowChrome();
        };

        refreshSuggestions(rowEl);
        updateRowChrome();
        return rowEl;
    }

    addRowBtn.onclick = () => {
        const rows = currentRowEls();
        const lastRow = rows[rows.length - 1];
        const prefill = lastRow
            ? { category: lastRow.dataset.category, year: lastRow.querySelector(".rYear").value }
            : {};
        const newRow = addRow(prefill);
        if (newRow) {
            newRow.scrollIntoView({ behavior: "smooth", block: "center" });
            newRow.querySelector(".rTitle").focus({ preventScroll: true });
        }
    };

    for (let i = 0; i < INITIAL_BATCH_ADD_ROWS; i++) addRow();

    screenWrap.onsubmit = async (e) => {
        e.preventDefault();

        const toInsert = [];
        let firstErrorRow = null;

        currentRowEls().forEach(rowEl => {
            rowEl.classList.remove("add-card-error");
            const titleVal = rowEl.querySelector(".rTitle").value.trim();
            if (!titleVal) return;

            const yearVal = parseInt(rowEl.querySelector(".rYear").value, 10);
            const catVal = rowEl.dataset.category;
            const genreVal = rowEl.querySelector(".rGenre").value.trim();
            const franchiseVal = rowEl.querySelector(".rFranchise").value.trim() || null;

            if (!yearVal || !catVal || !genreVal) {
                rowEl.classList.add("add-card-error");
                if (!firstErrorRow) firstErrorRow = rowEl;
                return;
            }

            toInsert.push({ title: titleVal, year: yearVal, category: catVal, genre: genreVal, franchise: franchiseVal });
        });

        if (firstErrorRow) {
            firstErrorRow.scrollIntoView({ behavior: "smooth", block: "center" });
            vibrate(60);
            return;
        }
        if (toInsert.length === 0) return;

        submitBtn.disabled = true;
        submitBtn.textContent = "Сохраняем…";

        const result = await db.from("titles").insert(toInsert);

        if (result.error) {
            alert("Ошибка сохранения: " + result.error.message);
            updateRowChrome();
        } else {
            document.body.classList.remove("batch-add-screen-active");
            await refreshCurrentScreen();
        }
    };
}

function buildExistingTitlesSet() {
    return new Set(getAllTitlesFromCategory(dbData).map(t => t.trim().toLowerCase()));
}

// Те же самые правила заполнения даталистов жанра/франшизы, что и в
// showAddEditModal()/showBatchAddTitlesScreen() выше, но вынесенные в общие
// функции — чтобы модалка добавления из онлайн-поиска не плодила третью
// копию одного и того же кода. (Сами showAddEditModal/showBatchAddTitlesScreen
// не трогаем — они и так работают, переносить их на общие функции можно
// отдельным рефакторингом при желании.)
function populateGenreDatalist(datalistEl, category) {
    const localGenres = new Set();
    const categoryData = dbData[category];
    if (categoryData && typeof categoryData === "object" && !Array.isArray(categoryData)) {
        for (let genreKey in categoryData) localGenres.add(genreKey);
    }
    datalistEl.innerHTML = Array.from(localGenres)
        .sort()
        .map(g => `<option value="${escapeHtml(g)}">`)
        .join("");
}

function populateFranchiseDatalist(datalistEl, category, genre) {
    const localFranchises = new Set();
    if (dbData[category] && dbData[category][genre]) {
        const listOrObj = dbData[category][genre];
        if (Array.isArray(listOrObj)) {
            listOrObj.forEach(item => {
                if (typeof item === "object" && item !== null) {
                    Object.keys(item).forEach(f => localFranchises.add(f));
                }
            });
        }
    }
    datalistEl.innerHTML = Array.from(localFranchises)
        .sort()
        .map(f => `<option value="${escapeHtml(f)}">`)
        .join("");
}

// По типу TMDB-запроса ("Фильм"/"Мультфильм"/"Сериал"/"Аниме") подбирает
// РЕАЛЬНЫЙ ключ категории в dbData (у категорий на сайте могут быть эмодзи
// в начале и т.п. — та же логика подстроки, что и в getCategoryPriority()
// выше). Если совпадения нет — берёт первую доступную категорию.
function suggestSiteCategoryForType(type, categories) {
    const match = categories.find(cat => cat.includes(type));
    return match || categories[0] || type;
}

// Модалка "Добавить" — открывается по кнопке на карточке результата
// онлайн-поиска. Интерфейс/логика близки к showAddEditModal(), но название
// и год уже предзаполнены с TMDB, а перед сохранением подтягивается точный
// рейтинг/ID с настоящего Кинопоиска (см. комментарий в начале блока).
// result: { title, year, suggestedCategory, suggestedGenre, tmdbFields, onAdded }
function showAddFromOnlineSearchModal(result) {
    const existingMenu = document.getElementById("onlineSearchAddModal");
    if (existingMenu) existingMenu.remove();

    const categories = Object.keys(dbData).filter(cat => {
        return !cat.includes("Секрет") && !cat.includes("🔒") && !cat.includes("❤️");
    });
    if (categories.length === 0) {
        alert("Нет доступных категорий для добавления тайтла.");
        return;
    }

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "onlineSearchAddModal";

    const suggestedCategory = categories.includes(result.suggestedCategory) ? result.suggestedCategory : categories[0];

    overlay.innerHTML = `
        <div class="modal-content">
            <h3>➕ Добавить тайтл</h3>
            <form class="modal-form" id="onlineAddForm">
                <label>Название</label>
                <input type="text" id="oaTitle" required value="${escapeHtml(result.title)}">

                <label>Год выпуска</label>
                <input type="number" id="oaYear" required value="${result.year}">

                <label>Категория</label>
                <select id="oaCategory" required>
                    ${categories.map(cat => `<option value="${escapeHtml(cat)}" ${cat === suggestedCategory ? "selected" : ""}>${escapeHtml(cat)}</option>`).join("")}
                </select>

                <label>Жанр (выберите или напишите свой)</label>
                <input type="text" id="oaGenre" required value="${escapeHtml(result.suggestedGenre || "")}" placeholder="Например: Ужасы" list="oaGenresList">
                <datalist id="oaGenresList"></datalist>

                <label>Франшиза (если это часть серии, необязательно)</label>
                <input type="text" id="oaFranchise" placeholder="Например: Крик" list="oaFranchisesList">
                <datalist id="oaFranchisesList"></datalist>

                <p class="online-add-kp-status" id="oaKpStatus">🔎 Ищем точный рейтинг на Кинопоиске…</p>

                <div class="modal-buttons">
                    <button type="submit" class="btn-save">Сохранить</button>
                    <button type="button" class="btn-cancel" id="oaCancel">Отмена</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(overlay);

    const oaCategory = document.getElementById("oaCategory");
    const oaGenre = document.getElementById("oaGenre");
    const genresList = document.getElementById("oaGenresList");
    const franchisesList = document.getElementById("oaFranchisesList");

    const refreshGenres = () => populateGenreDatalist(genresList, oaCategory.value);
    const refreshFranchises = () => populateFranchiseDatalist(franchisesList, oaCategory.value, oaGenre.value.trim());

    oaCategory.addEventListener("change", () => {
        refreshGenres();
        refreshFranchises();
    });
    oaGenre.addEventListener("input", refreshFranchises);

    refreshGenres();
    refreshFranchises();

    document.getElementById("oaCancel").onclick = () => overlay.remove();

    // Точный рейтинг/ID с настоящего Кинопоиска — см. комментарий в шапке блока
    const kpStatusEl = document.getElementById("oaKpStatus");
    findKinopoiskMatch(result.title, result.year).then(match => {
        if (!kpStatusEl.isConnected) return; // модалку уже закрыли/сохранили, апдейтить нечего
        if (match) {
            const ratingText = (match.rating != null) ? `⭐ ${match.rating.toFixed(1)}` : "рейтинг не указан";
            kpStatusEl.textContent = `Кинопоиск: ${ratingText} · ID ${match.id}`;
        } else {
            kpStatusEl.textContent = "На Кинопоиске точное совпадение не найдено — можно добавить и так.";
        }
    });

    document.getElementById("onlineAddForm").onsubmit = async (e) => {
        e.preventDefault();

        const titleVal = document.getElementById("oaTitle").value.trim();
        const yearVal = parseInt(document.getElementById("oaYear").value, 10);
        const catVal = oaCategory.value;
        const genreVal = oaGenre.value.trim();
        let franchiseVal = document.getElementById("oaFranchise").value.trim();
        if (franchiseVal === "") franchiseVal = null;

        const submitBtn = overlay.querySelector(".btn-save");
        submitBtn.disabled = true;
        submitBtn.textContent = "Сохраняем…";

        const row = { title: titleVal, year: yearVal, category: catVal, genre: genreVal, franchise: franchiseVal };
        if (titleMetaColumns && result.tmdbFields) Object.assign(row, result.tmdbFields);
        const insertResult = await db
            .from("titles")
            .insert([row]);

        if (insertResult.error) {
            alert("Ошибка сохранения: " + insertResult.error.message);
            submitBtn.disabled = false;
            submitBtn.textContent = "Сохранить";
            return;
        }

        // Обновляем dbData в фоне, НЕ уходя с экрана поиска — пользователь
        // почти наверняка хочет добавить ещё несколько тайтлов подряд из
        // тех же результатов, не начиная поиск заново.
        await loadCatalogFromDB();
        overlay.remove();
        if (typeof result.onAdded === "function") result.onAdded();
    };
}

const ONLINE_SEARCH_TYPES = ["Фильм", "Мультфильм", "Сериал", "Аниме"];

// "Фильм"/"Мультфильм" ищем через /movie-эндпоинты TMDB, "Сериал"/"Аниме" —
// через /tv. У "Мультфильма" и "Аниме" дополнительно требуем жанр
// Animation(16); у "Аниме" — вдобавок страну происхождения JP (эвристика:
// TMDB не размечает аниме отдельным типом). Из-за этого вида аниме-ФИЛЬМЫ
// (не сериалы) в раздел "Аниме" не попадают — их проще найти через
// "Мультфильм", они там тоже будут (это осознанное упрощение).
function onlineSearchEndpointBase(type) {
    return (type === "Сериал" || type === "Аниме") ? "tv" : "movie";
}

function closeOnlineSearchScreen() {
    document.body.classList.remove("online-search-screen-active");
    if (history.length > 0) {
        openData(history[history.length - 1], false, null, true);
    } else {
        showHome();
    }
}

function showOnlineSearchScreen() {
    // Та же гигиена состояния, что и перед открытием любого другого
    // полноэкранного режима (см. showBatchAddTitlesScreen выше).
    isChatScreenOpen = false;
    isWishlistScreenOpen = false;
    isCalendarScreenOpen = false;
    currentWatchedBucket = null;
    if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
    if (typeof activeGameCleanup !== "undefined" && activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }

    document.body.classList.add("online-search-screen-active");

    setShellSection("online");
    setShellBack(history.length > 0 ? () => playVhsRewindTransition(closeOnlineSearchScreen) : null);

    app.innerHTML = "";
    let titleEl = document.createElement("h1");
    setEmojiTitle(titleEl, "🔍 Онлайн Поиск");
    app.appendChild(titleEl);

    const screenWrap = document.createElement("div");
    screenWrap.className = "online-search-screen";
    screenWrap.innerHTML = `
        <form class="online-search-form" id="onlineSearchForm">
            <div class="online-search-row-main">
                <input type="text" id="osQuery" class="search-input-field" placeholder="Название (необязательно)">
                <button type="submit" class="btn-search-icon">🔍</button>
            </div>
            <div class="online-search-filters">
                <div class="os-filter-field">
                    <label>Тип</label>
                    <select id="osType">
                        ${ONLINE_SEARCH_TYPES.map(t => `<option value="${t}">${t}</option>`).join("")}
                    </select>
                </div>
                <div class="os-filter-field">
                    <label>Жанр</label>
                    <select id="osGenre"><option value="">Любой</option></select>
                </div>
                <div class="os-filter-field">
                    <label>Год от</label>
                    <input type="number" id="osYearFrom" placeholder="1990">
                </div>
                <div class="os-filter-field">
                    <label>Год до</label>
                    <input type="number" id="osYearTo" placeholder="2026">
                </div>
                <div class="os-filter-field">
                    <label>Рейтинг от</label>
                    <input type="number" id="osRatingFrom" min="0" max="10" step="0.1" placeholder="0.0">
                </div>
                <div class="os-filter-field">
                    <label>Сортировка</label>
                    <select id="osSort">
                        <option value="popularity.desc">По популярности</option>
                        <option value="vote_average.desc">По рейтингу</option>
                        <option value="primary_release_date.desc">Сначала новые</option>
                        <option value="primary_release_date.asc">Сначала старые</option>
                    </select>
                </div>
            </div>
        </form>
        <p class="online-search-hint" id="osHint">Введите название и/или задайте фильтры, затем нажмите «🔍».</p>
        <div class="online-search-results" id="osResults"></div>
        <div class="online-search-pager" id="osPager"></div>
    `;
    app.appendChild(screenWrap);

    const osQuery = screenWrap.querySelector("#osQuery");
    const osType = screenWrap.querySelector("#osType");
    const osGenre = screenWrap.querySelector("#osGenre");
    const osYearFrom = screenWrap.querySelector("#osYearFrom");
    const osYearTo = screenWrap.querySelector("#osYearTo");
    const osRatingFrom = screenWrap.querySelector("#osRatingFrom");
    const osSort = screenWrap.querySelector("#osSort");
    const osResults = screenWrap.querySelector("#osResults");
    const osPager = screenWrap.querySelector("#osPager");

    const existingTitlesSet = buildExistingTitlesSet();
    let lastRequestToken = 0; // защита от гонки, если фильтры/страницы переключают быстрее ответа сети

    async function refreshGenreOptions() {
        const kind = onlineSearchEndpointBase(osType.value);
        const list = await fetchTmdbGenreList(kind);
        const prevValue = osGenre.value;
        osGenre.innerHTML = `<option value="">Любой</option>` +
            list.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");
        if (list.some(g => String(g.id) === prevValue)) osGenre.value = prevValue;
    }
    osType.addEventListener("change", refreshGenreOptions);
    refreshGenreOptions();

    function normalizeTmdbResult(raw, mediaType) {
        const isTv = mediaType === "tv";
        const dateStr = isTv ? raw.first_air_date : raw.release_date;
        const year = dateStr ? parseInt(dateStr.slice(0, 4), 10) : null;
        return {
            tmdbId: raw.id,
            mediaType,
            title: isTv ? (raw.name || raw.original_name) : (raw.title || raw.original_title),
            year,
            overview: raw.overview || "",
            genreIds: raw.genre_ids || (raw.genres ? raw.genres.map(g => g.id) : []),
            posterPath: raw.poster_path,
            rating: typeof raw.vote_average === "number" ? raw.vote_average : null,
            originCountries: raw.origin_country || []
        };
    }

    // Применяется ТОЛЬКО в режиме текстового поиска — /search/* у TMDB не
    // умеет фильтровать по жанру/году/рейтингу на сервере, поэтому фильтры
    // "дочищаем" на клиенте среди результатов уже полученной страницы (из-за
    // этого при активном текстовом запросе + фильтрах на странице может
    // оказаться меньше 20 карточек — ограничение самого TMDB /search, не наше).
    function passesClientFilters(item, type, genreId, yearFrom, yearTo, ratingFrom) {
        const hasAnimation = item.genreIds.includes(TMDB_ANIMATION_GENRE_ID);
        if ((type === "Фильм" || type === "Сериал") && hasAnimation) return false;
        if (type === "Мультфильм" && !hasAnimation) return false;
        if (type === "Аниме" && !(hasAnimation && item.originCountries.includes("JP"))) return false;
        if (genreId && !item.genreIds.includes(Number(genreId))) return false;
        if (yearFrom && item.year && item.year < yearFrom) return false;
        if (yearTo && item.year && item.year > yearTo) return false;
        if (ratingFrom && (item.rating || 0) < ratingFrom) return false;
        return true;
    }

    function buildGenreNameLookup(kind) {
        const list = kind === "tv" ? tmdbTvGenresCache : tmdbMovieGenresCache;
        const map = {};
        (list || []).forEach(g => { map[g.id] = g.name; });
        return map;
    }

    function renderResultCard(item, genreNameMap) {
        const card = document.createElement("div");
        card.className = "online-search-card";

        const posterUrl = item.posterPath ? (TMDB_IMG_BASE_SMALL + item.posterPath) : null;
        const genreNames = item.genreIds.map(id => genreNameMap[id]).filter(Boolean).slice(0, 3).join(", ");
        const desc = item.overview
            ? (item.overview.length > 140 ? item.overview.slice(0, 140) + "…" : item.overview)
            : "Описание отсутствует.";
        const fullTitleKey = `${item.title} (${item.year || "?"})`.trim().toLowerCase();
        const alreadyAdded = existingTitlesSet.has(fullTitleKey);

        card.innerHTML = `
            <div class="osc-poster-wrap">
                ${posterUrl
                    ? `<img class="osc-poster" src="${posterUrl}" alt="${escapeHtml(item.title)}" loading="lazy">`
                    : `<div class="osc-poster osc-poster-placeholder">🎬</div>`}
            </div>
            <div class="osc-body">
                <h4 class="osc-title">${escapeHtml(item.title)}${item.year ? ` (${item.year})` : ""}</h4>
                ${genreNames ? `<p class="osc-genres">${escapeHtml(genreNames)}</p>` : ""}
                <p class="osc-desc">${escapeHtml(desc)}</p>
                <div class="osc-meta">
                    <span class="osc-rating">${item.rating != null ? "⭐ " + item.rating.toFixed(1) : "—"}</span>
                    <span class="osc-id">TMDB #${item.tmdbId}</span>
                </div>
                <button type="button" class="osc-add-btn" ${alreadyAdded ? "disabled" : ""}>
                    ${alreadyAdded ? "✅ Уже в базе" : "➕ Добавить"}
                </button>
            </div>
        `;

        if (!alreadyAdded) {
            card.querySelector(".osc-add-btn").onclick = () => {
                const firstGenre = genreNames.split(",")[0] ? genreNames.split(",")[0].trim() : "";
                const categories = Object.keys(dbData).filter(cat => {
                    return !cat.includes("Секрет") && !cat.includes("🔒") && !cat.includes("❤️");
                });
                showAddFromOnlineSearchModal({
                    title: item.title,
                    year: item.year || new Date().getFullYear(),
                    suggestedCategory: suggestSiteCategoryForType(osType.value, categories),
                    suggestedGenre: firstGenre,
                    tmdbFields: buildTitleMetaFields(
                        { id: item.tmdbId, poster_path: item.posterPath, overview: item.overview },
                        item.mediaType,
                        genreNames
                    ),
                    onAdded: () => {
                        existingTitlesSet.add(fullTitleKey);
                        const btn = card.querySelector(".osc-add-btn");
                        btn.disabled = true;
                        btn.textContent = "✅ Добавлено";
                    }
                });
            };
        }

        return card;
    }

    // Постраничная навигация "как в Google": всегда видны первые 2 и
    // последние 2 страницы, плюс окно вокруг текущей, разрывы — многоточием.
    // Стрелки "‹"/"›" по бокам. Список страниц всегда короткий (максимум
    // 2+3+2=7 номеров + 2 многоточия + 2 стрелки), поэтому влезает в одну
    // строку и на телефоне, и на десктопе — не нужен перенос/вертикальный список.
    // TMDB отдаёт максимум 500 "видимых" страниц даже если total_pages больше.
    function getPagerPageNumbers(current, total) {
        const pages = new Set([1, total, current]);
        if (total >= 2) pages.add(2);
        if (total - 1 >= 1) pages.add(total - 1);
        if (current - 1 >= 1) pages.add(current - 1);
        if (current + 1 <= total) pages.add(current + 1);
        return Array.from(pages)
            .filter(p => p >= 1 && p <= total)
            .sort((a, b) => a - b);
    }

    function renderPager(page, totalPages, onGoTo) {
        osPager.innerHTML = "";
        const cappedTotal = Math.min(totalPages || 1, 500);
        if (cappedTotal <= 1) return;

        const makeBtn = (label, targetPage, disabled, isCurrent) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "os-page-btn" + (isCurrent ? " os-page-current" : "");
            b.textContent = label;
            b.disabled = !!disabled;
            if (!disabled) b.onclick = () => onGoTo(targetPage);
            return b;
        };
        const makeEllipsis = () => {
            const span = document.createElement("span");
            span.className = "os-page-ellipsis";
            span.textContent = "…";
            return span;
        };

        osPager.appendChild(makeBtn("‹", Math.max(1, page - 1), page === 1, false));

        let prevPage = 0;
        getPagerPageNumbers(page, cappedTotal).forEach(p => {
            if (prevPage && p - prevPage > 1) osPager.appendChild(makeEllipsis());
            osPager.appendChild(makeBtn(String(p), p, false, p === page));
            prevPage = p;
        });

        osPager.appendChild(makeBtn("›", Math.min(cappedTotal, page + 1), page === cappedTotal, false));
    }

    async function runSearch(page) {
        const myToken = ++lastRequestToken;
        osResults.innerHTML = `<p class="online-search-hint">Ищем…</p>`;
        osPager.innerHTML = "";

        // При смене страницы пагинации пользователь обычно уже проскроллил
        // вниз, разглядывая карточки — без этого после клика по номеру
        // страницы он бы оставался внизу и видел новые карточки не сразу.
        // window.scrollTo с behavior:"smooth" сам уважает системную настройку
        // "уменьшить анимацию" (см. общий @media prefers-reduced-motion
        // в начале style.css, там scroll-behavior принудительно auto).
        window.scrollTo({ top: 0, behavior: "smooth" });

        const type = osType.value;
        const kind = onlineSearchEndpointBase(type);
        const genreId = osGenre.value;
        const yearFrom = parseInt(osYearFrom.value, 10) || null;
        const yearTo = parseInt(osYearTo.value, 10) || null;
        const ratingFrom = parseFloat(osRatingFrom.value) || null;
        const queryText = osQuery.value.trim();

        try {
            let rawResults = [];
            let totalPages = 1;

            if (queryText) {
                // Текстовый поиск — фильтры применяем на клиенте (см. комментарий
                // у passesClientFilters выше).
                const res = await tmdbFetch(`/search/${kind}`, { query: queryText, page: String(page) });
                const json = await res.json();
                rawResults = json.results || [];
                totalPages = json.total_pages || 1;
            } else {
                // Без текста — полноценный серверный фильтр /discover, честная
                // постраничная выдача по 20 карточек (стандартный размер страницы TMDB).
                const params = new URLSearchParams({ page: String(page), sort_by: osSort.value });

                if (type === "Мультфильм") {
                    params.set("with_genres", genreId ? `${TMDB_ANIMATION_GENRE_ID},${genreId}` : String(TMDB_ANIMATION_GENRE_ID));
                } else if (type === "Аниме") {
                    params.set("with_genres", genreId ? `${TMDB_ANIMATION_GENRE_ID},${genreId}` : String(TMDB_ANIMATION_GENRE_ID));
                    params.set("with_origin_country", "JP");
                } else {
                    params.set("without_genres", String(TMDB_ANIMATION_GENRE_ID));
                    if (genreId) params.set("with_genres", genreId);
                }

                if (yearFrom || yearTo) {
                    const dateField = kind === "tv" ? "first_air_date" : "primary_release_date";
                    if (yearFrom) params.set(`${dateField}.gte`, `${yearFrom}-01-01`);
                    if (yearTo) params.set(`${dateField}.lte`, `${yearTo}-12-31`);
                }
                if (ratingFrom) params.set("vote_average.gte", String(ratingFrom));

                const res = await tmdbFetch(`/discover/${kind}`, Object.fromEntries(params));
                const json = await res.json();
                rawResults = json.results || [];
                totalPages = json.total_pages || 1;
            }

            if (myToken !== lastRequestToken) return; // пришёл устаревший ответ — игнорируем

            let items = rawResults.map(r => normalizeTmdbResult(r, kind));
            if (queryText) {
                items = items.filter(item => passesClientFilters(item, type, genreId, yearFrom, yearTo, ratingFrom));
            }

            if (items.length === 0) {
                osResults.innerHTML = `<p class="online-search-hint">Ничего не найдено. Попробуйте изменить запрос или фильтры.</p>`;
                osPager.innerHTML = "";
                return;
            }

            const genreNameMap = buildGenreNameLookup(kind);
            osResults.innerHTML = "";
            items.forEach(item => osResults.appendChild(renderResultCard(item, genreNameMap)));

            renderPager(page, totalPages, (p) => runSearch(p));
        } catch (e) {
            console.error("Ошибка онлайн-поиска (TMDB):", e);
            if (myToken !== lastRequestToken) return;
            osResults.innerHTML = `<p class="online-search-hint">Не удалось выполнить поиск. Проверьте соединение и попробуйте ещё раз.</p>`;
        }
    }

    screenWrap.querySelector("#onlineSearchForm").onsubmit = (e) => {
        e.preventDefault();
        runSearch(1);
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

        // Удаляем комментарии, оставленные на этом тайтле — иначе они
        // "осиротеют" и будут висеть в общем экране "Комментарии" под
        // названием тайтла, которого уже не существует.
        const { error: commentsError } = await db
            .from("comments")
            .delete()
            .eq("title", itemText);

        if (commentsError) {
            console.error("Не удалось удалить комментарии тайтла:", commentsError.message);
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
    mine:    { label: "🙋 Просмотрено мной",       chip: "🙋 Мной",       set: () => watchedTitlesMine },
    partner: { label: "🧑‍🤝‍🧑 Просмотрено партнёром", chip: "🧑‍🤝‍🧑 Партнёром", set: () => watchedTitlesPartner },
    both:    { label: "❤️ Просмотрено нами",       chip: "❤️ Вместе",     set: () => watchedTitlesBoth },
};

// Вкладки раздела "Списки" (на телефоне это одна вкладка нижней панели
// на три экрана; на ПК они спрятаны — те же пункты есть в боковом меню)
function buildListsTabs(active) {
    const tabs = document.createElement("div");
    tabs.className = "segmented lists-tabs";
    [
        ["wishlist", `Будем смотреть · ${wishlistTitles.size}`],
        ["watched", `Просмотрено · ${getAllWatchedTitles().length}`],
        ["calendar", "Календарь"],
    ].forEach(([id, label]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn segmented-item" + (id === active ? " active" : "");
        btn.textContent = label;
        btn.onclick = () => { if (id !== active) navigateFromShell(id); };
        tabs.appendChild(btn);
    });
    return tabs;
}

// То же для вкладки "Чат" на телефоне: чат и комментарии
function buildChatTabs(active) {
    const tabs = document.createElement("div");
    tabs.className = "segmented lists-tabs";
    [["chat", "💬 Чат"], ["comments", "🗨️ Комментарии"]].forEach(([id, label]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn segmented-item" + (id === active ? " active" : "");
        btn.textContent = label;
        btn.onclick = () => { if (id !== active) navigateFromShell(id); };
        tabs.appendChild(btn);
    });
    return tabs;
}

function buildListPageHead(titleText, count) {
    const head = document.createElement("div");
    head.className = "page-head";
    const title = document.createElement("h1");
    setEmojiTitle(title, titleText);
    head.appendChild(title);
    const meta = document.createElement("div");
    meta.className = "page-head-meta";
    meta.textContent = formatTitleCount(count);
    head.appendChild(meta);
    return head;
}

function renderTitleListOrEmpty(list, emptyEmoji, emptyText) {
    if (list.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ui-empty";
        empty.innerHTML = `<span class="ui-empty-emoji">${emptyEmoji}</span>`;
        empty.appendChild(document.createTextNode(emptyText));
        app.appendChild(empty);
    } else {
        // Собираем сетку карточек за кадром и вставляем одним куском
        const listFragment = document.createDocumentFragment();
        renderCardGrid(list, listFragment);
        app.appendChild(listFragment);
    }
    app.classList.toggle("long-list", list.length > 25);
}

function sortTitlesAlphabetically(list) {
    return list.sort((a, b) => titleSortKey(a).localeCompare(titleSortKey(b), "ru"));
}

// Общий хелпер: рендерит плоский список тайтлов в grid-сетку карточек
function renderCardGrid(list, container) {
    const grid = document.createElement("div");
    grid.className = "catalog-grid";
    list.forEach(item => renderItemRow(item, grid));
    container.appendChild(grid);
}

// "Просмотрено": все просмотренные + чипы "мной / партнёром / нами".
function renderWatchedTop() {
    renderWatchedScreen(null);
}

function renderWatchedBucket(bucketKey) {
    renderWatchedScreen(WATCHED_BUCKETS[bucketKey] ? bucketKey : null);
}

function renderWatchedScreen(bucketKey) {
    startTransitionLock();
    resetScreenState();
    currentCategoryName = "🎬 Просмотрено";
    currentWatchedBucket = bucketKey || 'top';
    setShellSection("watched");

    app.innerHTML = "";
    app.appendChild(buildListsTabs("watched"));

    const list = sortTitlesAlphabetically(bucketKey ? Array.from(WATCHED_BUCKETS[bucketKey].set()) : getAllWatchedTitles());
    app.appendChild(buildListPageHead("🎬 Просмотрено", list.length));

    const chips = document.createElement("div");
    chips.className = "chip-row";
    const chip = (label, count, isActive, onClick) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn chip" + (isActive ? " active" : "");
        const labelSpan = document.createElement("span");
        labelSpan.textContent = label;
        const countSpan = document.createElement("span");
        countSpan.className = "chip-count";
        countSpan.textContent = count;
        btn.append(labelSpan, countSpan);
        btn.onclick = isActive ? null : onClick;
        chips.appendChild(btn);
    };
    chip("Все", getAllWatchedTitles().length, !bucketKey, () => renderWatchedTop());
    Object.keys(WATCHED_BUCKETS).forEach(key => {
        const bucket = WATCHED_BUCKETS[key];
        chip(bucket.chip, bucket.set().size, bucketKey === key, () => renderWatchedBucket(key));
    });
    app.appendChild(chips);

    renderTitleListOrEmpty(list, "🎬", "Здесь пока пусто");
}

function renderWishlistFolder() {
    startTransitionLock();
    resetScreenState();
    currentCategoryName = "🍿 Будем смотреть";
    isWishlistScreenOpen = true;
    setShellSection("wishlist");

    app.innerHTML = "";
    app.appendChild(buildListsTabs("wishlist"));

    const list = sortTitlesAlphabetically(Array.from(wishlistTitles));
    app.appendChild(buildListPageHead("🍿 Будем смотреть", list.length));
    renderTitleListOrEmpty(list, "🍿", "Добавляйте сюда то, что хотите посмотреть, — кнопкой 🔖 на карточке");
}

// =======================================================
// 📅 КАЛЕНДАРЬ ПРОСМОТРОВ — отдельный экран (как "Будем смотреть"/"Просмотрено")
// =======================================================
// Раздел верхнего уровня, живёт вне обычной history/openData — "назад" не нужен.
function showCalendarScreen() {
    startTransitionLock();
    resetScreenState();
    isCalendarScreenOpen = true;
    currentCategoryName = "📅 Календарь просмотров";

    // Открываем на текущем месяце, если до этого календарь ещё не открывался
    // за эту сессию — а если пользователь уже листал месяцы вперёд/назад,
    // повторное открытие возвращает его туда же, где он был.
    if (calendarViewYear === null) {
        const now = new Date();
        calendarViewYear = now.getFullYear();
        calendarViewMonth = now.getMonth();
    }

    renderCalendarScreen();
}

function renderCalendarScreen() {
    setShellSection("calendar");
    app.innerHTML = "";
    app.appendChild(buildListsTabs("calendar"));

    let title = document.createElement("h1");
    setEmojiTitle(title, "📅 Календарь");
    app.appendChild(title);

    // Переключатель месяца
    let monthNav = document.createElement("div");
    monthNav.className = "calendar-month-nav";

    let prevBtn = document.createElement("button");
    prevBtn.className = "calendar-nav-btn";
    prevBtn.textContent = "←";
    prevBtn.onclick = () => {
        calendarViewMonth--;
        if (calendarViewMonth < 0) { calendarViewMonth = 11; calendarViewYear--; }
        renderCalendarScreen();
    };

    let monthLabel = document.createElement("span");
    monthLabel.className = "calendar-month-label";
    const labelDate = new Date(calendarViewYear, calendarViewMonth, 1);
    monthLabel.textContent = capitalizeFirst(labelDate.toLocaleDateString("ru-RU", { month: "long", year: "numeric" }));

    let nextBtn = document.createElement("button");
    nextBtn.className = "calendar-nav-btn";
    nextBtn.textContent = "→";
    nextBtn.onclick = () => {
        calendarViewMonth++;
        if (calendarViewMonth > 11) { calendarViewMonth = 0; calendarViewYear++; }
        renderCalendarScreen();
    };

    monthNav.appendChild(prevBtn);
    monthNav.appendChild(monthLabel);
    monthNav.appendChild(nextBtn);
    app.appendChild(monthNav);

    // Заголовки дней недели (Пн-Вс)
    let weekDaysRow = document.createElement("div");
    weekDaysRow.className = "calendar-grid calendar-weekdays";
    ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].forEach(d => {
        let cell = document.createElement("div");
        cell.className = "calendar-weekday";
        cell.textContent = d;
        weekDaysRow.appendChild(cell);
    });
    app.appendChild(weekDaysRow);

    // Сетка дней месяца
    let grid = document.createElement("div");
    grid.className = "calendar-grid";

    const firstOfMonth = new Date(calendarViewYear, calendarViewMonth, 1);
    // JS отдаёт 0=Вс..6=Сб, приводим к неделе с понедельника (0=Пн..6=Вс)
    let startWeekday = (firstOfMonth.getDay() + 6) % 7;

    const daysInMonth = new Date(calendarViewYear, calendarViewMonth + 1, 0).getDate();
    const todayKey = todayDateKey();

    for (let i = 0; i < startWeekday; i++) {
        let emptySlot = document.createElement("div");
        emptySlot.className = "calendar-day calendar-day-empty-slot";
        grid.appendChild(emptySlot);
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const dateObj = new Date(calendarViewYear, calendarViewMonth, day);
        const dateKey = toDateKey(dateObj);
        const titlesForDay = scheduledByDate[dateKey] || [];

        let cell = document.createElement("div");
        cell.className = "calendar-day";
        if (dateKey === todayKey) cell.classList.add("calendar-day-today");
        if (dateKey < todayKey) cell.classList.add("calendar-day-past");

        if (titlesForDay.length > 0) {
            cell.classList.add("calendar-day-active");
            cell.onclick = () => showDayPlansModal(dateKey);
        } else {
            cell.classList.add("calendar-day-inactive");
        }

        let dayNum = document.createElement("span");
        dayNum.className = "calendar-day-number";
        dayNum.textContent = String(day);
        cell.appendChild(dayNum);

        if (titlesForDay.length > 0) {
            let dot = document.createElement("span");
            dot.className = "calendar-day-dot";
            dot.textContent = titlesForDay.length > 1 ? String(titlesForDay.length) : "●";
            cell.appendChild(dot);
        }

        grid.appendChild(cell);
    }

    // Сетка месяца слева, список ближайших планов справа (на телефоне — под сеткой)
    const layout = document.createElement("div");
    layout.className = "cal-layout";
    const calMain = document.createElement("div");
    calMain.className = "cal-main";
    calMain.append(monthNav, weekDaysRow, grid);
    layout.append(calMain, buildCalendarAgenda());
    app.appendChild(layout);
}

// "Ближайшие планы": все будущие дни с тайтлами по порядку, с постерами.
// Тап по дню — то же окно дня, что и в сетке (перенести/удалить/просмотрено).
function buildCalendarAgenda() {
    const section = document.createElement("section");
    section.className = "cal-agenda";

    const head = document.createElement("h2");
    head.className = "ui-section-title";
    head.textContent = "Ближайшие планы";
    section.appendChild(head);

    const todayKey = todayDateKey();
    const dates = Object.keys(scheduledByDate).filter(d => d >= todayKey && scheduledByDate[d].length > 0).sort();

    if (dates.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ui-empty";
        empty.innerHTML = `<span class="ui-empty-emoji">🗓️</span>`;
        empty.appendChild(document.createTextNode("Пока ничего не запланировано. Запланировать просмотр можно кнопкой 🔖 на карточке тайтла."));
        section.appendChild(empty);
        return section;
    }

    const tomorrowKey = toDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000));
    dates.forEach(dateKey => {
        const date = parseDateKey(dateKey);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "ui-btn cal-agenda-row" + (dateKey === todayKey ? " cal-agenda-today" : "");
        row.onclick = () => showDayPlansModal(dateKey);

        const when = dateKey === todayKey ? "Сегодня" : dateKey === tomorrowKey ? "Завтра"
            : capitalizeFirst(date.toLocaleDateString("ru-RU", { weekday: "short" }));
        row.innerHTML = `
            <span class="cal-agenda-date">
                <span class="cal-agenda-day">${date.getDate()}</span>
                <span class="cal-agenda-month">${date.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "")}</span>
            </span>
            <span class="cal-agenda-body">
                <span class="cal-agenda-when">${when}</span>
                <span class="cal-agenda-titles"></span>
            </span>
        `;
        const titlesEl = row.querySelector(".cal-agenda-titles");
        scheduledByDate[dateKey].forEach(itemText => {
            const item = document.createElement("span");
            item.className = "cal-agenda-item";
            item.innerHTML = `<span class="cal-agenda-poster">🎬</span><span class="cal-agenda-name"></span>`;
            item.querySelector(".cal-agenda-name").textContent = itemText;
            titlesEl.appendChild(item);
            fetchTmdbCardMeta(itemText).then(meta => {
                if (!meta || !meta.posterUrl || !item.isConnected) return;
                item.querySelector(".cal-agenda-poster").innerHTML = `<img src="${meta.posterUrl}" alt="" loading="lazy">`;
            });
        });
        section.appendChild(row);
    });
    return section;
}

// Модальное окно одного дня календаря: список запланированных тайтлов и
// действия — перенести на другой день, удалить, отметить просмотренным.
// Пересобирает сама себя после каждого действия (если в дне ещё что-то
// осталось), чтобы можно было разобраться сразу с несколькими тайтлами
// подряд, не открывая день заново.
function showDayPlansModal(dateKey) {
    const existing = document.getElementById("dayPlansModal");
    if (existing) existing.remove();

    const titlesForDay = (scheduledByDate[dateKey] || []).slice();
    if (titlesForDay.length === 0) return;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "dayPlansModal";

    let itemsHtml = "";
    titlesForDay.forEach((t, idx) => {
        const displayTitle = t.replace(/\s*\(\d{4}\)$/, "");
        itemsHtml += `
        <div class="day-plan-item">
            <div class="day-plan-title">${displayTitle}</div>
            <div class="day-plan-actions">
                <button class="day-plan-move" data-idx="${idx}">📅 Перенести</button>
                <button class="day-plan-delete" data-idx="${idx}">🗑️ Удалить</button>
                <button class="day-plan-watch-me" data-idx="${idx}">🙋 Просмотрено мной</button>
                <button class="day-plan-watch-both" data-idx="${idx}">❤️ Просмотрено нами</button>
            </div>
        </div>`;
    });

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3>${formatScheduledDateHuman(dateKey)}</h3>
            <div class="day-plan-list">${itemsHtml}</div>
            <div class="action-buttons" style="margin-top: 6px;">
                <button id="dayPlansClose" class="btn-cancel-gray">Закрыть</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.getElementById("dayPlansClose").onclick = () => overlay.remove();

    // Если после действия в дне ещё остались тайтлы — пересобираем модалку
    // на том же дне; если день опустел — просто закрываем её.
    const reopenOrClose = () => {
        overlay.remove();
        if ((scheduledByDate[dateKey] || []).length > 0) {
            showDayPlansModal(dateKey);
        }
    };

    overlay.querySelectorAll(".day-plan-move").forEach(btn => {
        btn.onclick = () => {
            const t = titlesForDay[parseInt(btn.dataset.idx, 10)];
            overlay.remove();
            showScheduleDateModal(t, dateKey);
        };
    });

    overlay.querySelectorAll(".day-plan-delete").forEach(btn => {
        btn.onclick = async () => {
            const t = titlesForDay[parseInt(btn.dataset.idx, 10)];
            await removeScheduledTitle(t);
            reopenOrClose();
        };
    });

    overlay.querySelectorAll(".day-plan-watch-me").forEach(btn => {
        btn.onclick = async () => {
            const t = titlesForDay[parseInt(btn.dataset.idx, 10)];
            await markWatched(t, false);
            reopenOrClose();
        };
    });

    overlay.querySelectorAll(".day-plan-watch-both").forEach(btn => {
        btn.onclick = async () => {
            const t = titlesForDay[parseInt(btn.dataset.idx, 10)];
            await markWatched(t, true);
            reopenOrClose();
        };
    });
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

    const isSecret = titleText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || titleText.includes("Бакс Ориджинал") || (currentCategoryName && (currentCategoryName.includes("Секрет") || currentCategoryName.includes("🔒")));

    overlay.innerHTML = `
        <div class="modal-content pick-modal">
            <div class="pick-kicker">🎰 Случайный выбор</div>
            ${!isSecret ? `<div class="pick-poster" id="shakePosterBox"><span>🎬</span></div>` : ""}
            <h2 class="pick-title" id="shakeRandomTitle"></h2>
            <div class="pick-meta" id="shakeRandomMeta"></div>
            <div class="pick-actions">
                <button type="button" class="ui-btn ui-pill ui-pill-accent pick-main" id="closeShakeBtn">Смотрим!</button>
                <button type="button" class="ui-btn ui-pill" id="rerollShakeBtn">🔄 Другой</button>
            </div>
            ${!isSecret ? `
            <div class="pick-links">
                <button type="button" class="ui-btn ui-link" id="detailsShakeBtn">Подробнее</button>
                <button type="button" class="ui-btn ui-link" id="trailerShakeBtn">Трейлер ↗</button>
            </div>` : ""}
        </div>
    `;

    const titleEl = overlay.querySelector("#shakeRandomTitle");
    const metaEl = overlay.querySelector("#shakeRandomMeta");
    const posterBox = overlay.querySelector("#shakePosterBox");
    let currentTitle = titleText; // тайтл, который сейчас показан (меняется при "Другой")

    const closeModal = () => { overlay.remove(); isShakeModalOpen = false; };
    overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
    document.body.appendChild(overlay);

    // Постер и жанры подставляются, когда "барабан" остановился
    const revealMeta = (pick) => {
        if (isSecret) return;
        fetchTmdbCardMeta(pick).then(meta => {
            if (!overlay.isConnected || pick !== currentTitle) return;
            metaEl.textContent = meta && meta.genreNames ? meta.genreNames : "";
            posterBox.innerHTML = meta && meta.posterUrl ? `<img src="${meta.posterUrl}" alt="">` : "<span>🎬</span>";
        });
    };
    const spin = (pick, spinPool) => {
        metaEl.textContent = "";
        if (posterBox) posterBox.innerHTML = "<span>🎲</span>";
        runSlotAnimation(titleEl, spinPool, pick, isSecret, () => revealMeta(pick));
    };
    spin(titleText, pool);

    overlay.querySelector("#closeShakeBtn").onclick = closeModal;
    overlay.querySelector("#rerollShakeBtn").onclick = () => {
        const all = pool.length > 0 ? pool : getAllTitlesFromCategory(history[history.length - 1]);
        if (all.length === 0) return;
        currentTitle = all[Math.floor(Math.random() * all.length)];
        vibrate(30);
        spin(currentTitle, all);
    };

    if (!isSecret) {
        overlay.querySelector("#detailsShakeBtn").onclick = () => { closeModal(); showActionMenu(currentTitle); };
        overlay.querySelector("#trailerShakeBtn").onclick = () => {
            const query = encodeURIComponent(currentTitle + " трейлер");
            window.open(`https://www.youtube.com/results?search_query=${query}`, "_blank");
        };
    }
}

// Все тайтлы обычных категорий (без секретной) — пул для случайного выбора
function getAllCatalogTitles() {
    return getOrderedCategoryKeys().normal.reduce((all, key) => all.concat(getAllTitlesFromCategory(dbData[key])), []);
}

// Тот же выбор, что и при встряхивании телефона, только по всему каталогу
function showRandomTitleFromCatalog() {
    const pool = getAllCatalogTitles();
    if (pool.length === 0) return;
    showRandomTitleModal(pool[Math.floor(Math.random() * pool.length)], pool);
}

function onPhoneShake() {
    if (currentCategoryName && (currentCategoryName.includes("Секрет") || currentCategoryName.includes("🔒"))) {
        return;
    }

    const now = Date.now();
    if (now - lastShakeTime < 2000 || isShakeModalOpen) return;

    const currentDataBranch = history[history.length - 1];
    const allTitles = currentDataBranch
        ? getAllTitlesFromCategory(currentDataBranch)
        : getAllCatalogTitles();
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

// ===== Курсор-хвост (только десктоп с мышью) =====
// Лёгкий декоративный шлейф искр за курсором. На телефонах/планшетах (без
// точного поинтера) вообще не создаётся — там ему всё равно не за чем
// следить, а лишний canvas на весь экран того не стоит. Уважает
// prefers-reduced-motion — если человек попросил браузер поменьше
// анимировать, эффект не запускается вовсе.
function initCursorTrail() {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (document.getElementById("cursorTrailCanvas")) return;

    const canvas = document.createElement("canvas");
    canvas.id = "cursorTrailCanvas";
    Object.assign(canvas.style, {
        position: "fixed", inset: "0", width: "100vw", height: "100vh",
        pointerEvents: "none", zIndex: "99999"
    });
    document.body.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
        canvas.width = Math.round(window.innerWidth * dpr);
        canvas.height = Math.round(window.innerHeight * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    const COLORS = ["#ff2e93", "#8b3bff", "#2ee8ff", "#ffd15c"];
    let particles = [];
    let lastSpawn = 0;

    window.addEventListener("mousemove", (e) => {
        const now = performance.now();
        if (now - lastSpawn < 26) return; // троттлинг — не по искре на каждый пиксель движения
        lastSpawn = now;
        particles.push({
            x: e.clientX, y: e.clientY,
            r: 3 + Math.random() * 2.5,
            color: COLORS[Math.floor(Math.random() * COLORS.length)],
            life: 1
        });
        if (particles.length > 40) particles.shift();
        if (!running) {
            running = true;
            requestAnimationFrame(tick);
        }
    });

    // Цикл отрисовки крутится, только пока есть искры: раньше он перерисовывал
    // полноэкранный canvas 60 раз в секунду всегда, даже когда мышь не двигалась
    let running = false;
    function tick() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => { p.life -= 0.035; p.r *= 0.97; });
        particles = particles.filter(p => p.life > 0);
        particles.forEach(p => {
            ctx.globalAlpha = Math.max(0, p.life) * 0.7;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0, p.r), 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.globalAlpha = 1;
        if (particles.length > 0) requestAnimationFrame(tick);
        else running = false;
    }
}
initCursorTrail();

