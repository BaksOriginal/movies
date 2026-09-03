// ==========================================
// core.js — ОБЩИЙ КОД ДЛЯ ВСЕХ СТРАНИЦ САЙТА
// ==========================================
// Подключается ПЕРВЫМ (после supabase-js), до script.js / games.js / w2g.js.
// Здесь то, что нужно на любой странице: клиент Supabase, состояние
// авторизации (currentUser) и её "выживание" между страницами через
// localStorage/cookie, и несколько мелких утилит, которыми пользуются
// сразу два-три раздела сайта (каталог, игры, совместный просмотр).
//
// Т.к. это обычные <script> без type="module", все объявленные здесь
// function/let/const видны и в script.js, и в games.js, и в w2g.js —
// главное подключать core.js раньше них в HTML.

// ==========================================
// НАСТРОЙКА SUPABASE
// ==========================================
const SUPABASE_URL = "https://nwkgofmgluduldgsmwfa.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Igpb__d5aHp3DBbQH1NgOA_W8_Ku6aE";
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==========================================
// АКТУАЛЬНЫЙ SHA ВЕТКИ (обход кэша jsDelivr по "@branch")
// ==========================================
// Общая утилита — ей пользуются и стикеры чата (ниже), и список треков
// ритм-игры (в games.js). jsDelivr кэширует ответы по "@main" с заметной
// задержкой, а по конкретному commit SHA — нет, поэтому вместо имени ветки
// в URL к data.jsdelivr.com/cdn.jsdelivr.net подставляем SHA текущего HEAD.
const GITHUB_FALLBACK_SHA = "cba3258795994c35cea06a41c6269421788c3bc5";
const SHA_CACHE_TTL_MS = 30 * 60 * 1000; // 30 минут

async function getGithubBranchSha(owner, repo, branch) {
    const cacheKey = `ghSha:${owner}/${repo}@${branch}`;
    let cachedEntry = null;
    try {
        const cachedRaw = localStorage.getItem(cacheKey);
        if (cachedRaw) {
            const cached = JSON.parse(cachedRaw);
            if (cached && cached.sha) {
                cachedEntry = cached;
                if ((Date.now() - cached.savedAt) < SHA_CACHE_TTL_MS) {
                    return cached.sha;
                }
            }
        }
    } catch (e) { /* битый кэш в localStorage — просто идём за свежим SHA */ }

    try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`);
        if (!res.ok) throw new Error("GitHub API вернул статус " + res.status);
        const json = await res.json();
        const sha = json && json.object && json.object.sha;
        if (!sha) throw new Error("Не удалось получить SHA ветки из ответа GitHub API");

        try {
            localStorage.setItem(cacheKey, JSON.stringify({ sha, savedAt: Date.now() }));
        } catch (e) { /* localStorage недоступен/переполнен — не критично, просто не кэшируем */ }

        return sha;
    } catch (e) {
        if (cachedEntry && cachedEntry.sha) {
            console.error(`Не удалось получить свежий SHA ${owner}/${repo}@${branch} (см. ошибку ниже), используем последний известный SHA из кэша:`, e);
            return cachedEntry.sha;
        }
        if (GITHUB_FALLBACK_SHA) {
            console.error(`Не удалось получить SHA ветки ${owner}/${repo}@${branch}, и в кэше ничего нет — используем зашитый в коде резервный SHA (${GITHUB_FALLBACK_SHA}):`, e);
            try {
                localStorage.setItem(cacheKey, JSON.stringify({ sha: GITHUB_FALLBACK_SHA, savedAt: Date.now() }));
            } catch (e2) { /* не критично */ }
            return GITHUB_FALLBACK_SHA;
        }
        console.error(`Не удалось получить SHA ветки ${owner}/${repo}@${branch}, и в кэше ничего нет — используем branch напрямую (риск устаревшего кэша jsDelivr):`, e);
        return branch;
    }
}

// ==========================================
// СТИКЕРЫ ДЛЯ ЧАТА (общие для обычного чата и чата совместного просмотра)
// ==========================================
const GITHUB_STICKERS_OWNER = "BaksOriginal";
const GITHUB_STICKERS_REPO = "movies";
const GITHUB_STICKERS_BRANCH = "main";
const GITHUB_STICKERS_PATH = "stickers";
const STICKER_PREFIX = "[[STICKER]]";

let cachedStickerList = null;

async function fetchStickerList() {
    if (cachedStickerList) return cachedStickerList;
    try {
        const ref = await getGithubBranchSha(GITHUB_STICKERS_OWNER, GITHUB_STICKERS_REPO, GITHUB_STICKERS_BRANCH);
        const apiUrl = `https://data.jsdelivr.com/v1/packages/gh/${GITHUB_STICKERS_OWNER}/${GITHUB_STICKERS_REPO}@${ref}?structure=flat`;
        const res = await fetch(apiUrl);
        if (!res.ok) throw new Error("jsDelivr API вернул статус " + res.status);
        const json = await res.json();
        const files = Array.isArray(json.files) ? json.files : [];

        const prefix = `/${GITHUB_STICKERS_PATH}/`;
        const imageExtRe = /\.(png|jpe?g|gif|webp)$/i;

        cachedStickerList = files
            .filter(f => typeof f.name === "string" && f.name.startsWith(prefix) && imageExtRe.test(f.name))
            .map(f => {
                const encodedPath = f.name.split("/").map(encodeURIComponent).join("/");
                return {
                    name: f.name.slice(prefix.length),
                    url: `https://cdn.jsdelivr.net/gh/${GITHUB_STICKERS_OWNER}/${GITHUB_STICKERS_REPO}@${ref}${encodedPath}`
                };
            });

        return cachedStickerList;
    } catch (e) {
        console.error("Ошибка при загрузке списка стикеров (jsDelivr):", e);
        return [];
    }
}

function isStickerMessage(messageText) {
    return typeof messageText === "string" && messageText.startsWith(STICKER_PREFIX);
}

function getStickerUrl(messageText) {
    return messageText.slice(STICKER_PREFIX.length);
}

function showStickerPicker(onPick) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "stickerPickerModal";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    overlay.innerHTML = `
        <div class="modal-content" style="max-height:70vh; overflow-y:auto;">
            <h3 style="text-align:center; margin-bottom:15px;">😊 Стикеры</h3>
            <div class="sticker-grid" id="stickerGrid">
                <p style="text-align:center;color:#9686b8;font-size:13px;">Загружаем стикеры...</p>
            </div>
            <button class="btn-action-cancel" id="stickerPickerCancel" style="margin-top:15px;width:100%;">Закрыть</button>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("stickerPickerCancel").onclick = () => overlay.remove();

    fetchStickerList().then(list => {
        const grid = document.getElementById("stickerGrid");
        if (!grid) return;

        if (list.length === 0) {
            grid.innerHTML = `<p style="text-align:center;color:#9686b8;font-size:13px;">Стикеры не найдены. Проверьте настройки GITHUB_STICKERS_* в core.js</p>`;
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

// ==========================================
// ЗАГОЛОВКИ (h1) С ЭМОДЗИ
// ==========================================
function setEmojiTitle(el, text) {
    el.textContent = "";
    const match = text.match(/^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u);
    if (match) {
        const emoji = match[1];
        const rest = text.slice(match[0].length);
        const span = document.createElement("span");
        span.className = "emoji-native";
        span.textContent = emoji;
        el.appendChild(span);
        el.appendChild(document.createTextNode(" " + rest));
    } else {
        el.textContent = text;
    }
}

// Превращает email в отображаемое имя пользователя
function getUsernameFromEmail(email) {
    if (email === "nowyouseemeinvi@gmail.com") return "Myakish";
    if (email === "unknownqsrll@gmail.com") return "Asmoday";
    return email || "Аноним";
}

// Вибро-отклик (используется в каталоге, играх и совместном просмотре)
function vibrate(pattern) {
    if (navigator.vibrate) {
        try { navigator.vibrate(pattern); } catch (e) { /* игнорируем, если браузер не разрешил */ }
    }
}

// ==========================================
// ФОНОВАЯ МУЗЫКА (общая для всех страниц)
// ==========================================
let isMusicPlaying = localStorage.getItem("musicEnabled") === "true";

function setupMusicAutoplay() {
    const audio = document.getElementById("bgMusic");
    if (!audio) return; // на странице нет <audio id="bgMusic"> — тихо выходим

    const playHandler = () => {
        if (isMusicPlaying) {
            audio.play().catch(e => console.log("Музыка не смогла запуститься"));
            document.removeEventListener("click", playHandler);
        }
    };
    document.addEventListener("click", playHandler);
}

// ==========================================
// ФОНОВЫЕ ЛЕТАЮЩИЕ СЕРДЕЧКИ (декоративный эффект, общий для всех страниц)
// ==========================================
function initHeartsBackground() {
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', initHeartsBackground, { once: true });
        return;
    }
    if (document.querySelector('.hearts-background')) return;

    const container = document.createElement('div');
    container.className = 'hearts-background';
    document.body.appendChild(container);

    const MAX_FLOATING_EMOJIS = 10;

    function spawnHeart() {
        if (container.childElementCount >= MAX_FLOATING_EMOJIS) return;

        const heart = document.createElement('div');
        heart.className = 'floating-heart';
        const FLOATING_EMOJIS = ['😈', '❤️', '😈', '❤️', '💜'];
        heart.innerHTML = FLOATING_EMOJIS[Math.floor(Math.random() * FLOATING_EMOJIS.length)];

        const size = Math.random() * 18 + 12;
        const startLeft = Math.random() * 100;
        const duration = Math.random() * 12 + 10;
        const swayX = (Math.random() * 120 - 60) + 'px';
        const rotateDeg = (Math.random() * 360) + 'deg';

        heart.style.fontSize = `${size}px`;
        heart.style.left = `${startLeft}%`;
        heart.style.animationDuration = `${duration}s`;
        heart.style.setProperty('--sway-x', swayX);
        heart.style.setProperty('--rotate-deg', rotateDeg);

        container.appendChild(heart);

        setTimeout(() => {
            heart.remove();
        }, duration * 1000);
    }

    spawnHeart();
    setInterval(spawnHeart, 1800);
}

// ==========================================
// АВТОРИЗАЦИЯ И СЕССИЯ (общие для всех страниц)
// ==========================================
let currentUser = null;
let isAppInitialized = false;

// ---------- РЕЗЕРВНОЕ КОПИРОВАНИЕ СЕССИИ (COOKIE BACKUP) ----------
// Кука ставится с path=/, поэтому одна и та же резервная копия сессии
// видна на /movies/, /movies/games/ и /movies/w2g/ — авторизация
// переживает переход между страницами без повторного логина.
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

async function performLogout() {
    saveSessionBackup(null);
    await db.auth.signOut();
}

// ---------- ЕДИНАЯ ТОЧКА ПОДПИСКИ НА СОБЫТИЯ АВТОРИЗАЦИИ ----------
// Каждая страница (script.js / games.js / w2g.js) вызывает initAuth() один
// раз со своими обработчиками — сама механика (кэш сессии, дедупликация
// повторных SIGNED_IN, watchdog на случай "тишины" от Supabase) при этом
// не дублируется по файлам.
//
// handlers.onLogin(wasAlreadyInitialized) — есть сессия, пользователь вошёл
// handlers.onTokenRefresh()               — тот же пользователь, тихое обновление токена (экран трогать не надо)
// handlers.onLogout()                     — сессии нет и восстановить не вышло
// handlers.isRendered()                   — вернуть true, если экран уже что-то показывает (для watchdog)
function initAuth(handlers) {
    const { onLogin, onTokenRefresh, onLogout, isRendered } = handlers;

    db.auth.onAuthStateChange(async (event, session) => {
        if (session && isAppInitialized && currentUser && currentUser.id === session.user.id) {
            currentUser = session.user;
            saveSessionBackup(session);
            if (onTokenRefresh) onTokenRefresh();
            return;
        }

        if (session) {
            currentUser = session.user;
            saveSessionBackup(session);
            const wasAlreadyInitialized = isAppInitialized;
            isAppInitialized = true;
            if (onLogin) await onLogin(wasAlreadyInitialized);
        } else {
            const restored = await tryRestoreSession();
            if (restored) return;

            currentUser = null;
            isAppInitialized = false;
            saveSessionBackup(null);
            if (onLogout) onLogout();
        }
    });

    // Страховка от пустой страницы: если Supabase не прислал событие
    // авторизации вовремя (протухший refresh-токен и т.п.), через 2 сек
    // принудительно считаем, что пользователь не авторизован.
    (async function bootstrapAuthWatchdog() {
        try {
            await db.auth.getSession();
        } catch (e) {
            console.error("Критическая ошибка при получении сессии:", e);
        }
        setTimeout(() => {
            if (!isAppInitialized && (!isRendered || !isRendered())) {
                console.warn("Событие авторизации не пришло вовремя — считаем пользователя не авторизованным.");
                if (onLogout) onLogout();
            }
        }, 2000);
    })();

    window.addEventListener("unhandledrejection", (event) => {
        console.error("Необработанная ошибка:", event.reason);
        if (!isAppInitialized && (!isRendered || !isRendered())) {
            if (onLogout) onLogout();
        }
    });
}

// ==========================================
// МИНИ-ШАПКА ДЛЯ ПОДСТРАНИЦ (games/w2g)
// ==========================================
// Небольшой аналог шапки showHome() из script.js — email, музыка, выход —
// но без завязки на каталог, чтобы games.js/w2g.js не тянули весь script.js.
function renderMiniHeader(container) {
    if (!currentUser) return;

    const header = document.createElement("div");
    header.className = "user-header";
    header.innerHTML = `<span id="userEmailSpan">${getUsernameFromEmail(currentUser.email)}</span>`;

    const controls = document.createElement("div");
    controls.className = "hero-controls";

    const iconBtnStyle = `
        width: 40px !important; height: 40px !important;
        min-width: 40px !important; min-height: 40px !important;
        padding: 0 !important; margin: 0 !important;
        border-radius: 50% !important; display: flex !important;
        justify-content: center !important; align-items: center !important;
        cursor: pointer !important; font-size: 16px !important;
        box-sizing: border-box !important; overflow: visible !important;
        line-height: 1 !important; flex-shrink: 0 !important;
    `;

    const musicBtn = document.createElement("button");
    musicBtn.className = "icon-btn";
    musicBtn.style.cssText = iconBtnStyle;
    musicBtn.textContent = isMusicPlaying ? "🔊" : "🔇";
    musicBtn.onclick = () => {
        const audio = document.getElementById("bgMusic");
        if (!audio) return;
        if (audio.paused) { audio.play(); isMusicPlaying = true; localStorage.setItem("musicEnabled", "true"); musicBtn.textContent = "🔊"; }
        else { audio.pause(); isMusicPlaying = false; localStorage.setItem("musicEnabled", "false"); musicBtn.textContent = "🔇"; }
    };

    const logoutBtn = document.createElement("button");
    logoutBtn.className = "icon-btn";
    logoutBtn.style.cssText = iconBtnStyle;
    logoutBtn.textContent = "❌";
    logoutBtn.onclick = performLogout;

    controls.appendChild(musicBtn);
    controls.appendChild(logoutBtn);
    header.appendChild(controls);
    container.appendChild(header);
}

// Запускаем декоративные эффекты, общие для всех страниц
initHeartsBackground();
setupMusicAutoplay();
