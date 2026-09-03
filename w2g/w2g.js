// ==========================================
// w2g.js — РАЗДЕЛ «СОВМЕСТНЫЙ ПРОСМОТР» (/movies/w2g/)
// ==========================================
// Подключается на w2g/index.html ПОСЛЕ core.js.
// Всё, что нужно из core.js: db, currentUser, app, vibrate, setEmojiTitle,
// getUsernameFromEmail, renderMiniHeader, стикеры (isStickerMessage,
// getStickerUrl, showStickerPicker).
// ==========================================
// СОСТОЯНИЕ (перенесено из общего блока script.js — используется только здесь)
// ==========================================
// ==========================================
// Состояние совместного просмотра (Watch Party)
// ==========================================
// Синхронизация построена на Supabase Realtime: канал с двумя механизмами —
// Broadcast (мгновенные события play/pause/seek/load, без записи в БД и без
// каких-либо лимитов на "N запросов в час") и Presence (кто сейчас находится
// на экране совместного просмотра — на этом строится автопауза при потере
// интернета у собеседника: событие "leave" присылает сам сервер Supabase,
// как только соединение реально обрывается).
let isWatchPartyScreenOpen = false;
let watchPartyChannel = null; // Supabase Realtime канал (broadcast + presence)
let watchPartyPlayer = null; // Унифицированная обёртка над текущим плеером (video/YouTube/Rutube)
let isApplyingRemoteWPUpdate = false; // Пока true — наши же события play/pause/seek не рассылаются обратно
let watchPartyHeartbeat = null; // Интервал, который раз в 5 сек досылает текущее время (коррекция рассинхрона)
let watchPartySelfState = { url: null, sourceType: null, playing: false, time: 0 }; // То, что мы транслируем партнёру
let watchPartyPartnerPresence = null; // Последнее известное состояние партнёра (из Presence)
let watchPartyPartnerOnline = false;
let watchPartyLeaveTimer = null; // Отложенная проверка "партнёр правда вышел" (см. initWatchPartyChannel)
// Счётчик неудачных попыток переподключения канала подряд. Раньше при
// заблокированном на уровне сети WebSocket (адблокер/антивирус с SSL-
// инспекцией/VPN) канал пересоздавался каждые 2 сек БЕСКОНЕЧНО — сам по
// себе это было не страшно, но частые мгновенные обрывы хендшейка
// ("WebSocket is closed before the connection is established") — известный
// триггер бага внутри клиентской библиотеки supabase-js/realtime-js, из-за
// которого её собственный внутренний таймер переподключения рекурсивно
// вызывает сам себя и в итоге роняет вкладку в "RangeError: Maximum call
// stack size exceeded". Ограничиваем количество автоматических попыток и
// после исчерпания лимита останавливаемся и явно показываем ошибку вместо
// того, чтобы продолжать долбиться в стену.
let watchPartyReconnectAttempts = 0;
const WP_MAX_RECONNECT_ATTEMPTS = 5;
let watchPartyChatMessages = []; // Сообщения чата совместного просмотра (своя таблица watch_party_messages)
let watchPartyChatReplyTarget = null; // Сообщение, на которое сейчас отвечаем в чате совместного просмотра
let watchPartyChatPollInterval = null; // Подстраховка на случай проблем с realtime (как у обычного чата)

// ---------- Аудио/видео звонок внутри совместного просмотра (WebRTC) ----------
// Сигналинг (offer/answer/ICE) идёт через тот же самый канал watch_party_room
// (broadcast-событие "webrtc", отдельное от "sync", которым синхронизируется
// плеер) — отдельного сервера для этого не нужно. Используем паттерн
// "perfect negotiation" (см. MDN), чтобы при одновременном включении камеры/
// микрофона с обеих сторон не было конфликта офферов: роль "вежливого" пира
// детерминированно определяется сравнением user id (см. isWatchPartyPolitePeer).
const WATCH_PARTY_RTC_CONFIG = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        // TURN нужен, когда прямое P2P-соединение невозможно (типичный случай —
        // мобильный интернет: оператор прячет телефон за жёстким NAT, и один
        // только STUN тут не помогает, ICE-кандидаты не сходятся, поэтому
        // разрешения на микро/камеру запрашиваются успешно, но медиапоток до
        // партнёра не долетает). Ниже — бесплатный публичный TURN (Open Relay
        // Project / Metered) в качестве запасного пути. Он не бесконечный и не
        // приватный (трафик идёт через чужой сервер третьей стороны, хоть и
        // зашифрован) — для постоянного использования лучше завести свой TURN,
        // например на metered.ca, Xirsys или Cloudflare Calls (у всех есть
        // бесплатный тариф), и подставить свои учётные данные сюда.
        { urls: "stun:stun.relay.metered.ca:80" },
        { urls: "turn:global.relay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:global.relay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:global.relay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
    ]
};
let watchPartyPeerConnection = null; // RTCPeerConnection, создаётся лениво при первом включении микро/камеры
let watchPartyLocalStream = null; // Наши локальные треки (микрофон/камера), включённые прямо сейчас
let watchPartyRemoteStream = null; // Треки, приезжающие от партнёра
let watchPartyMicOn = false;
let watchPartyCamOn = false;
let watchPartyFacingMode = "user"; // "user" (фронтальная) / "environment" (основная) — для разворота камеры на телефоне
let watchPartyHasMultipleCameras = false; // Показывать ли кнопку разворота камеры (проверяется через enumerateDevices)
let watchPartyMakingOffer = false; // Флаг "perfect negotiation" — сейчас формируем свой оффер
let watchPartyIgnoreOffer = false; // Флаг "perfect negotiation" — этот входящий оффер нужно проигнорировать (коллизия)
let watchPartyPartnerId = null; // id партнёра — вычисляется из Presence, нужен для роли "вежливого" пира
let watchPartyPartnerMediaState = { mic: false, cam: false }; // Последнее известное состояние микро/камеры партнёра
let watchPartyCallAudioCtx = null; // Отдельный AudioContext для звука оповещения о включении/выключении микро/камеры
let youtubeAPIReadyPromise = null; // Кэш промиса загрузки YouTube IFrame API (грузим один раз)
let hlsJsReadyPromise = null; // Кэш промиса загрузки hls.js (грузим один раз, только если реально нужен m3u8)


// ==========================================
// СОВМЕСТНЫЙ ПРОСМОТР (Watch Party)
// ==========================================
// Поддерживаемые источники на старте: YouTube, Rutube, а также прямые
// ссылки на файлы .mp4 / .webm / .m3u8 (HLS). ВК Видео и Одноклассники
// сознательно не поддерживаются — у обоих сервисов на данный момент нет
// рабочего программного API для управления встроенным плеером.

// ---------- Определение источника по ссылке ----------
// Достаёт src из целиком вставленного HTML-тега <iframe ...></iframe>.
// DOMParser не выполняет скрипты и ничего не вставляет в реальный документ —
// мы только читаем атрибут src, а сам iframe на странице создаём сами через
// iframe.src = ..., так что произвольная разметка внутри вставленного тега
// никак не выполняется и не попадает в DOM как есть.
function extractIframeSrc(html) {
    try {
        const doc = new DOMParser().parseFromString(String(html), "text/html");
        const iframeEl = doc.querySelector("iframe");
        if (!iframeEl) return null;
        const rawSrc = iframeEl.getAttribute("src");
        if (!rawSrc) return null;
        const parsed = new URL(rawSrc, window.location.href);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
        return parsed.href;
    } catch (e) {
        return null;
    }
}


const LOCAL_SERVER_BASE = "https://pleer.video/";

function buildLocalServerData(trimmedRaw) {
    if (!/^\d+$/.test(trimmedRaw)) return null;
    return {
        iframe: `${LOCAL_SERVER_BASE}${trimmedRaw}`
    };
}

function parseWatchPartyUrl(rawUrl) {
    const trimmedRaw = String(rawUrl).trim();

    if (/^<iframe[\s>]/i.test(trimmedRaw)) {
        const src = extractIframeSrc(trimmedRaw);
        return src ? { type: "custom", ref: src } : null;
    }

    const localData = buildLocalServerData(trimmedRaw);
    if (localData) {
        return { type: "custom", ref: localData.iframe };
    }

    let url;
    try {
        url = new URL(trimmedRaw);
    } catch (e) {
        return null;
    }

    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const path = url.pathname;

    // YouTube
    if (host === "youtu.be") {
        const id = path.slice(1).split("/")[0];
        if (id) return { type: "youtube", ref: id };
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
        if (path === "/watch") {
            const id = url.searchParams.get("v");
            if (id) return { type: "youtube", ref: id };
        }
        const embedMatch = path.match(/^\/(?:embed|shorts|live)\/([a-zA-Z0-9_-]+)/);
        if (embedMatch) return { type: "youtube", ref: embedMatch[1] };
    }

    // Rutube
    if (host === "rutube.ru") {
        const m = path.match(/\/(?:video|play\/embed|shorts)\/([a-zA-Z0-9]+)/);
        if (m) return { type: "rutube", ref: m[1] };
    }

    // Прямые файлы
    const cleanPath = path.toLowerCase();
    if (cleanPath.endsWith(".m3u8")) return { type: "hls", ref: url.href };
    if (cleanPath.endsWith(".mp4") || cleanPath.endsWith(".webm")) return { type: "direct", ref: url.href };

    return null;
}

function describeWPSource(type) {
    if (type === "youtube") return "YouTube-видео";
    if (type === "rutube") return "видео с Rutube";
    if (type === "hls") return "видеопоток (m3u8)";
    if (type === "custom") return "встроенный плеер";
    return "видеофайл";
}

// ---------- Ленивая загрузка внешних плееров ----------
function ensureYouTubeAPI() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (youtubeAPIReadyPromise) return youtubeAPIReadyPromise;
    youtubeAPIReadyPromise = new Promise((resolve) => {
        const prevCallback = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
            if (typeof prevCallback === "function") prevCallback();
            resolve();
        };
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(script);
    });
    return youtubeAPIReadyPromise;
}

function ensureHlsJs() {
    if (window.Hls) return Promise.resolve();
    if (hlsJsReadyPromise) return hlsJsReadyPromise;
    hlsJsReadyPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Не удалось загрузить hls.js"));
        document.head.appendChild(script);
    });
    return hlsJsReadyPromise;
}

// ---------- Общая обёртка для <video> (прямые mp4/webm и HLS) ----------
function wireWatchPartyVideoElement(video, type) {
    const obj = {
        type: type,
        onPlay: null,
        onPause: null,
        onSeek: null,
        play() {
            const p = video.play();
            if (p && p.catch) p.catch(() => {});
        },
        pause() {
            video.pause();
        },
        seekTo(t) {
            try { video.currentTime = Math.max(0, t); } catch (e) {}
        },
        getCurrentTime() {
            return video.currentTime || 0;
        },
        destroy() {
            try { video.pause(); video.removeAttribute("src"); video.load(); } catch (e) {}
            video.remove();
        }
    };

    video.addEventListener("play", () => {
        if (!isApplyingRemoteWPUpdate && obj.onPlay) obj.onPlay(video.currentTime);
    });
    video.addEventListener("pause", () => {
        if (!isApplyingRemoteWPUpdate && obj.onPause) obj.onPause(video.currentTime);
    });
    video.addEventListener("seeked", () => {
        if (!isApplyingRemoteWPUpdate && obj.onSeek) obj.onSeek(video.currentTime);
    });

    return obj;
}

async function createWPDirectPlayer(mountEl, url) {
    mountEl.innerHTML = "";
    const video = document.createElement("video");
    video.className = "wp-video";
    video.controls = true;
    video.playsInline = true;
    video.src = url;
    mountEl.appendChild(video);
    return wireWatchPartyVideoElement(video, "direct");
}

async function createWPHlsPlayer(mountEl, url) {
    mountEl.innerHTML = "";
    const video = document.createElement("video");
    video.className = "wp-video";
    video.controls = true;
    video.playsInline = true;
    mountEl.appendChild(video);

    let hlsInstance = null;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari умеет HLS нативно
        video.src = url;
    } else {
        await ensureHlsJs();
        hlsInstance = new Hls();
        hlsInstance.loadSource(url);
        hlsInstance.attachMedia(video);
    }

    const obj = wireWatchPartyVideoElement(video, "hls");
    const originalDestroy = obj.destroy;
    obj.destroy = () => {
        if (hlsInstance) { try { hlsInstance.destroy(); } catch (e) {} }
        originalDestroy();
    };
    return obj;
}

// ---------- YouTube (IFrame Player API) ----------
async function createWPYouTubePlayer(mountEl, videoId) {
    mountEl.innerHTML = "";
    const holder = document.createElement("div");
    holder.id = "wpYouTube_" + Math.random().toString(36).slice(2);
    mountEl.appendChild(holder);

    await ensureYouTubeAPI();

    return await new Promise((resolve) => {
        const obj = {
            type: "youtube",
            onPlay: null,
            onPause: null,
            onSeek: null,
            _player: null,
            _lastTime: 0,
            _poll: null,
            play() { this._player && this._player.playVideo(); },
            pause() { this._player && this._player.pauseVideo(); },
            seekTo(t) { this._player && this._player.seekTo(t, true); },
            getCurrentTime() { return this._player ? (this._player.getCurrentTime() || 0) : 0; },
            destroy() {
                if (this._poll) clearInterval(this._poll);
                if (this._player) { try { this._player.destroy(); } catch (e) {} }
            }
        };

        obj._player = new YT.Player(holder.id, {
            videoId: videoId,
            playerVars: { playsinline: 1, rel: 0 },
            events: {
                onReady: () => {
                    // У YouTube нет отдельного события перемотки — отслеживаем
                    // скачки времени сами, раз в секунду, пока видео играет.
                    obj._poll = setInterval(() => {
                        if (isApplyingRemoteWPUpdate || !obj._player || typeof obj._player.getPlayerState !== "function") return;
                        if (obj._player.getPlayerState() !== 1) return; // 1 = playing
                        const now = obj._player.getCurrentTime();
                        const expected = obj._lastTime + 1;
                        if (Math.abs(now - expected) > 1.5) {
                            obj.onSeek && obj.onSeek(now);
                        }
                        obj._lastTime = now;
                    }, 1000);
                    resolve(obj);
                },
                onStateChange: (e) => {
                    if (isApplyingRemoteWPUpdate) return;
                    if (e.data === YT.PlayerState.PLAYING) {
                        obj.onPlay && obj.onPlay(obj._player.getCurrentTime());
                    } else if (e.data === YT.PlayerState.PAUSED) {
                        obj.onPause && obj.onPause(obj._player.getCurrentTime());
                    }
                }
            }
        });
    });
}

// ---------- Rutube (embed + postMessage API) ----------
async function createWPRutubePlayer(mountEl, videoId) {
    mountEl.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.className = "wp-rutube-frame";
    iframe.src = "https://rutube.ru/play/embed/" + videoId + "/";
    iframe.setAttribute("frameborder", "0");
    iframe.setAttribute("allow", "clipboard-write; autoplay; fullscreen");
    iframe.setAttribute("webkitAllowFullScreen", "");
    iframe.setAttribute("allowFullScreen", "");
    mountEl.appendChild(iframe);

    const obj = {
        type: "rutube",
        onPlay: null,
        onPause: null,
        onSeek: null,
        _lastTime: 0,
        _msgHandler: null,
        play() { this._send("player:play"); },
        pause() { this._send("player:pause"); },
        seekTo(t) { this._send("player:setCurrentTime", { time: t }); },
        getCurrentTime() { return this._lastTime; },
        _send(type, data) {
            if (!iframe.contentWindow) return;
            iframe.contentWindow.postMessage(JSON.stringify({ type: type, data: data || {} }), "*");
        },
        destroy() {
            if (this._msgHandler) window.removeEventListener("message", this._msgHandler);
            iframe.remove();
        }
    };

    let resolveReady;
    const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

    obj._msgHandler = (event) => {
        if (event.source !== iframe.contentWindow) return;
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        if (!msg || !msg.type) return;

        if (msg.type === "player:ready") {
            resolveReady();
        } else if (msg.type === "player:currentTime" && msg.data) {
            obj._lastTime = msg.data.time ?? msg.data.currentTime ?? obj._lastTime;
        } else if (msg.type === "player:changeState" && msg.data) {
            if (isApplyingRemoteWPUpdate) return;
            const state = msg.data.state;
            if (state === "playing") obj.onPlay && obj.onPlay(obj._lastTime);
            else if (state === "pause" || state === "paused") obj.onPause && obj.onPause(obj._lastTime);
        }
    };
    window.addEventListener("message", obj._msgHandler);

    // Резервный таймаут — если сообщение player:ready почему-то не пришло,
    // не блокируем экран навсегда.
    await Promise.race([readyPromise, new Promise((r) => setTimeout(r, 3000))]);

    return obj;
}


async function createWPCustomIframePlayer(mountEl, src) {
    mountEl.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.className = "wp-rutube-frame wp-custom-frame";
    iframe.src = src;
    iframe.setAttribute("frameborder", "0");
    iframe.setAttribute("allow", "autoplay; fullscreen; encrypted-media; picture-in-picture");
    iframe.setAttribute("allowfullscreen", "");
    mountEl.appendChild(iframe);

    return {
        type: "custom",
        onPlay: null,
        onPause: null,
        onSeek: null,
        play() {},
        pause() {},
        seekTo() {},
        getCurrentTime() { return 0; },
        destroy() { iframe.remove(); }
    };
}

// ---------- Загрузка источника (своя или пришедшая от партнёра) ----------
async function loadWatchPartySource(rawUrl, opts) {
    opts = opts || {};
    const parsed = parseWatchPartyUrl(rawUrl);
    if (!parsed) {
        showWPStatusNote("⚠️ Ссылка не распознана. Поддерживаются YouTube, Rutube, прямые ссылки на .mp4/.webm/.m3u8, а также код плеера <iframe> (кнопка 🔗)");
        return;
    }

    const container = document.getElementById("watchPartyPlayerContainer");
    if (!container) return;
    container.innerHTML = '<p style="text-align:center;color:var(--text-faint);padding:40px 0;">Загружаем видео...</p>';

    if (watchPartyPlayer) {
        try { watchPartyPlayer.destroy(); } catch (e) {}
        watchPartyPlayer = null;
    }

    let player = null;
    try {
        if (parsed.type === "direct") player = await createWPDirectPlayer(container, parsed.ref);
        else if (parsed.type === "hls") player = await createWPHlsPlayer(container, parsed.ref);
        else if (parsed.type === "youtube") player = await createWPYouTubePlayer(container, parsed.ref);
        else if (parsed.type === "rutube") player = await createWPRutubePlayer(container, parsed.ref);
        else if (parsed.type === "custom") player = await createWPCustomIframePlayer(container, parsed.ref);
    } catch (e) {
        console.error("Ошибка загрузки видео для совместного просмотра:", e);
    }

    if (!player) {
        container.innerHTML = '<p style="text-align:center;color:var(--pink-soft);padding:40px 0;">Не удалось загрузить видео.</p>';
        return;
    }

    if (!document.getElementById("watchPartyPlayerContainer")) {
        // Пользователь успел уйти с экрана, пока плеер грузился
        try { player.destroy(); } catch (e) {}
        return;
    }

    player.onPlay = handleLocalWPPlay;
    player.onPause = handleLocalWPPause;
    player.onSeek = handleLocalWPSeek;

    watchPartyPlayer = player;
    const initialTime = opts.initialTime || 0;
    watchPartySelfState = {
        url: rawUrl,
        sourceType: parsed.type,
        playing: !!opts.autoplay,
        time: initialTime
    };

    if (initialTime > 0.5) {
        applyRemoteWP(() => player.seekTo(initialTime));
    }
    if (opts.autoplay) {
        applyRemoteWP(() => player.play());
    }

    await trackWPPresence();
    renderWPStatusBar();

    if (opts.announce !== false) {
        broadcastWP("load", { url: rawUrl, sourceType: parsed.type, time: initialTime });
    }
}

// ---------- Локальные действия -> рассылка партнёру ----------
function handleLocalWPPlay(time) {
    watchPartySelfState.playing = true;
    watchPartySelfState.time = time;
    broadcastWP("play", { time: time });
    trackWPPresence();
}
function handleLocalWPPause(time) {
    watchPartySelfState.playing = false;
    watchPartySelfState.time = time;
    broadcastWP("pause", { time: time });
    trackWPPresence();
}
function handleLocalWPSeek(time) {
    watchPartySelfState.time = time;
    broadcastWP("seek", { time: time });
    trackWPPresence();
}

function applyRemoteWP(fn) {
    isApplyingRemoteWPUpdate = true;
    try { fn(); } catch (e) { console.error(e); }
    setTimeout(() => { isApplyingRemoteWPUpdate = false; }, 400);
}

function broadcastWP(type, extra) {
    if (!watchPartyChannel || !currentUser) return;
    watchPartyChannel.send({
        type: "broadcast",
        event: "sync",
        payload: Object.assign({
            type: type,
            senderId: currentUser.id,
            senderName: getUsernameFromEmail(currentUser.email)
        }, extra || {})
    });
}

async function trackWPPresence() {
    if (!watchPartyChannel || !currentUser) return;
    try {
        await watchPartyChannel.track({
            username: getUsernameFromEmail(currentUser.email),
            url: watchPartySelfState.url,
            sourceType: watchPartySelfState.sourceType,
            playing: watchPartySelfState.playing,
            time: watchPartySelfState.time,
            updatedAt: Date.now()
        });
    } catch (e) {
        console.error("Не удалось обновить presence совместного просмотра:", e);
    }
}

// ---------- Обработка событий от партнёра ----------
function handleRemoteWPPayload(payload) {
    if (!payload || !currentUser || payload.senderId === currentUser.id) return;
    const senderName = payload.senderName || "Партнёр";

    if (payload.type === "load") {
        showWPStatusNote(senderName + " включил(а): " + describeWPSource(payload.sourceType));
        loadWatchPartySource(payload.url, { initialTime: payload.time || 0, announce: false, autoplay: false });
        return;
    }

    if (!watchPartyPlayer) return;

    if (payload.type === "play") {
        applyRemoteWP(() => {
            const drift = Math.abs(watchPartyPlayer.getCurrentTime() - (payload.time || 0));
            if (drift > 1.2) watchPartyPlayer.seekTo(payload.time || 0);
            watchPartyPlayer.play();
        });
        watchPartySelfState.playing = true;
        showWPStatusNote(senderName + " нажал(а) ▶️ Play");
    } else if (payload.type === "pause") {
        applyRemoteWP(() => {
            watchPartyPlayer.pause();
            watchPartyPlayer.seekTo(payload.time || 0);
        });
        watchPartySelfState.playing = false;
        showWPStatusNote(senderName + " поставил(а) ⏸ на паузу");
    } else if (payload.type === "seek") {
        applyRemoteWP(() => watchPartyPlayer.seekTo(payload.time || 0));
        watchPartySelfState.time = payload.time || 0;
    } else if (payload.type === "heartbeat") {
        const drift = Math.abs(watchPartyPlayer.getCurrentTime() - (payload.time || 0));
        if (drift > 2.5) {
            applyRemoteWP(() => watchPartyPlayer.seekTo(payload.time || 0));
        }
    }
}

// ---------- Presence: кто сейчас в комнате совместного просмотра ----------
function updateWPPresenceUI() {
    if (!watchPartyChannel || !currentUser) return;
    const state = watchPartyChannel.presenceState();
    let foundPartner = null;
    let foundPartnerId = null;
    for (const key in state) {
        if (key === currentUser.id) continue;
        const entries = state[key];
        if (entries && entries.length) {
            foundPartner = entries[entries.length - 1];
            foundPartnerId = key;
        }
    }
    const partnerWasOffline = !watchPartyPartnerOnline;
    watchPartyPartnerOnline = !!foundPartner;
    watchPartyPartnerPresence = foundPartner;
    if (foundPartnerId) watchPartyPartnerId = foundPartnerId;
    renderWPStatusBar();

    // Партнёр только что появился на связи, а у нас включён микро/камера —
    // значит, соединение (если оно было) скорее всего умерло вместе с его
    // предыдущей вкладкой. Пробуем пересобрать звонок, чтобы не заставлять
    // руками выключать/включать кнопки заново.
    if (partnerWasOffline && watchPartyPartnerOnline && (watchPartyMicOn || watchPartyCamOn) && !watchPartyPeerConnection) {
        ensureWatchPartyPeerConnection();
    }
}

function joinPartnerWatchParty() {
    if (!watchPartyPartnerPresence || !watchPartyPartnerPresence.url) return;
    const p = watchPartyPartnerPresence;
    const estTime = (p.time || 0) + (p.playing ? Math.max(0, (Date.now() - (p.updatedAt || Date.now())) / 1000) : 0);
    loadWatchPartySource(p.url, { initialTime: estTime, autoplay: !!p.playing, announce: false });
}

// ---------- Канал Realtime ----------
// Сколько ждём после события "leave", прежде чем поверить, что партнёр
// действительно вышел (см. комментарий внутри обработчика ниже).
const WP_LEAVE_GRACE_MS = 2500;

function initWatchPartyChannel() {
    if (watchPartyChannel || !currentUser) return;

    // Держим локальную ссылку на "этот" канал: колбэк .subscribe() ниже
    // сверяется именно с ней, а не с внешней переменной watchPartyChannel.
    // Раньше колбэк читал внешнюю watchPartyChannel напрямую — если канал
    // уже был заменён новым (или намеренно закрыт через leaveWatchPartyScreen),
    // "устаревший" колбэк всё равно видел актуальный/непустой канал в этой
    // переменной и заново логировал ошибку/пересоздавал канал, из-за чего
    // при выходе с экрана в консоль летели сотни повторов одной и той же ошибки.
    const channel = db.channel("watch_party_room", {
        config: { presence: { key: currentUser.id } }
    });
    watchPartyChannel = channel;

    channel
        .on("broadcast", { event: "sync" }, ({ payload }) => handleRemoteWPPayload(payload))
        .on("broadcast", { event: "webrtc" }, ({ payload }) => handleWatchPartyRTCSignal(payload))
        .on("postgres_changes", { event: "*", schema: "public", table: "watch_party_messages" }, (payload) => onWatchPartyChatRealtimeChange(payload))
        .on("presence", { event: "sync" }, () => updateWPPresenceUI())
        .on("presence", { event: "join" }, ({ key }) => {
            if (key === currentUser.id) return;
            // Партнёр реально на связи — если параллельно тикает отложенная
            // проверка "вышел ли он" (см. leave ниже), отменяем её: обычно
            // join прилетает почти сразу вслед за leave при кратком разрыве
            // websocket'а (сон вкладки, смена сети, пропущенный heartbeat),
            // а не при настоящем уходе со страницы.
            if (watchPartyLeaveTimer) {
                clearTimeout(watchPartyLeaveTimer);
                watchPartyLeaveTimer = null;
            } else if (!watchPartyPartnerOnline) {
                showWPStatusNote("Партнёр зашёл в совместный просмотр");
            }
            updateWPPresenceUI();
        })
        .on("presence", { event: "leave" }, ({ key }) => {
            if (key === currentUser.id) return;
            // ВАЖНО: раньше здесь сразу считали, что партнёр вышел, и молча
            // ставили видео на паузу. Но Supabase Presence шлёт leave (и следом
            // за ним join) при ЛЮБОМ кратком обрыве соединения — не только при
            // реальном уходе со страницы. Именно это давало ложное "партнёр
            // отключился" при обоих открытых вкладках и самопроизвольную паузу
            // в момент запуска (когда сокет как раз проходит первый
            // хендшейк/переподключение). Поэтому не реагируем мгновенно: ждём
            // немного и перепроверяем актуальный список presence — если партнёр
            // уже снова там, это была ложная тревога.
            if (watchPartyLeaveTimer) clearTimeout(watchPartyLeaveTimer);
            watchPartyLeaveTimer = setTimeout(() => {
                watchPartyLeaveTimer = null;
                if (!watchPartyChannel) return;
                const state = watchPartyChannel.presenceState();
                const stillPresent = Object.keys(state).some(
                    k => k !== currentUser.id && state[k] && state[k].length
                );
                if (stillPresent) return; // ложная тревога — партнёр уже переподключился

                watchPartyPartnerOnline = false;
                watchPartyPartnerPresence = null;
                renderWPStatusBar();
                if (watchPartyPlayer && watchPartySelfState.playing) {
                    applyRemoteWP(() => watchPartyPlayer.pause());
                    watchPartySelfState.playing = false;
                }
                closeWatchPartyPeerConnectionOnly(); // сам звонок разорвался вместе с партнёром — сохраняем состояние наших кнопок mic/cam, но чистим RTC
                showWPStatusNote("⚠️ Партнёр отключился — видео поставлено на паузу");
            }, WP_LEAVE_GRACE_MS);
        })
        .subscribe(async (status) => {
            // Если к этому моменту watchPartyChannel уже указывает не на
            // "наш" channel (его успели заменить новым или обнулить при
            // выходе с экрана) — это событие от устаревшего/намеренно
            // закрытого канала, реагировать на него не нужно.
            if (watchPartyChannel !== channel) return;

            if (status === "SUBSCRIBED") {
                watchPartyReconnectAttempts = 0; // подключение реально удалось — счётчик неудач обнуляем
                await trackWPPresence();
                updateWPPresenceUI();
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                // Канал отвалился сам по себе (не пользователь закрыл экран) —
                // судя по логам ("Realtime send() is automatically falling back
                // to REST API"), сокет периодически рвётся, и без пересоздания
                // канала play/pause/seek у партнёров тихо перестают долетать
                // друг до друга. Пересобираем канал через паузу с нарастающей
                // задержкой (2с, 4с, 6с...) — резкие мгновенные повторы именно
                // на заблокированном WebSocket и провоцируют внутренний баг
                // supabase-js со стек-оверфлоу (см. комментарий у объявления
                // watchPartyReconnectAttempts).
                console.error("Канал совместного просмотра отвалился со статусом:", status);
                db.removeChannel(channel);
                watchPartyChannel = null;
                watchPartyReconnectAttempts++;
                if (!isWatchPartyScreenOpen) return;
                if (watchPartyReconnectAttempts > WP_MAX_RECONNECT_ATTEMPTS) {
                    showWPConnectionFailed();
                    return;
                }
                const delay = 2000 * watchPartyReconnectAttempts;
                setTimeout(() => { if (isWatchPartyScreenOpen) initWatchPartyChannel(); }, delay);
            }
        });

    if (watchPartyHeartbeat) clearInterval(watchPartyHeartbeat);
    watchPartyHeartbeat = setInterval(() => {
        if (!isWatchPartyScreenOpen || !watchPartyPlayer || !watchPartySelfState.playing) return;
        const t = watchPartyPlayer.getCurrentTime();
        watchPartySelfState.time = t;
        broadcastWP("heartbeat", { time: t });
    }, 5000);
}

function leaveWatchPartyScreen() {
    isWatchPartyScreenOpen = false;
    if (watchPartyHeartbeat) { clearInterval(watchPartyHeartbeat); watchPartyHeartbeat = null; }
    if (watchPartyLeaveTimer) { clearTimeout(watchPartyLeaveTimer); watchPartyLeaveTimer = null; }
    if (watchPartyChatPollInterval) { clearInterval(watchPartyChatPollInterval); watchPartyChatPollInterval = null; }
    if (watchPartyPlayer) { try { watchPartyPlayer.destroy(); } catch (e) {} watchPartyPlayer = null; }
    cleanupWatchPartyCall(); // важно: до закрытия канала, чтобы партнёр успел получить "bye"
    if (watchPartyChannel) {
        // Важно: обнуляем ссылку ДО removeChannel. Статус CLOSED от этого
        // канала может прилететь в .subscribe()-колбэк асинхронно, и та
        // проверка (watchPartyChannel !== channel) должна увидеть, что
        // канал уже не актуален — иначе на каждый выход с экрана в консоль
        // сыпался спам "Канал совместного просмотра отвалился" и запускалась
        // ненужная попытка пересоздания канала.
        const channelToClose = watchPartyChannel;
        watchPartyChannel = null;
        db.removeChannel(channelToClose);
    }
    watchPartySelfState = { url: null, sourceType: null, playing: false, time: 0 };
    watchPartyPartnerPresence = null;
    watchPartyPartnerOnline = false;
    watchPartyChatReplyTarget = null;
    watchPartyReconnectAttempts = 0; // следующий заход в экран получает чистый лимит попыток
}

// ---------- Мелкие UI-хелперы экрана ----------
// Показывается, когда WebSocket-канал не смог подключиться WP_MAX_RECONNECT_ATTEMPTS
// раз подряд — обычно значит, что соединение блокируется на этом устройстве/
// сети (адблокер, антивирус с проверкой HTTPS, VPN или корпоративный
// файрвол), а не что сам сайт сломан. Даёт понятную причину вместо вечного
// "Подключаемся..." и кнопку, чтобы попробовать ещё раз вручную (например,
// после отключения блокировщика), не перезагружая страницу целиком.
function showWPConnectionFailed() {
    const bar = document.getElementById("watchPartyStatusBar");
    if (!bar) return;
    bar.innerHTML = '';
    const dot = document.createElement("span");
    dot.className = "wp-status-dot wp-offline";
    bar.appendChild(dot);
    bar.appendChild(document.createTextNode(
        " Не удалось подключить синхронизацию — похоже, соединение блокируется (адблокер, антивирус или VPN на этом устройстве). "
    ));
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "wp-status-retry-btn";
    retryBtn.textContent = "🔄 Попробовать снова";
    retryBtn.onclick = () => {
        watchPartyReconnectAttempts = 0;
        bar.innerHTML = '<span class="wp-status-dot wp-offline"></span> Подключаемся...';
        initWatchPartyChannel();
    };
    bar.appendChild(retryBtn);
}

function renderWPStatusBar() {
    const bar = document.getElementById("watchPartyStatusBar");
    if (bar) {
        bar.innerHTML = watchPartyPartnerOnline
            ? '<span class="wp-status-dot wp-online"></span> Партнёр в совместном просмотре'
            : '<span class="wp-status-dot wp-offline"></span> Партнёр сейчас не смотрит с вами';
    }

    const banner = document.getElementById("watchPartyJoinBanner");
    if (!banner) return;

    const partnerHasOther = watchPartyPartnerOnline && watchPartyPartnerPresence && watchPartyPartnerPresence.url &&
        watchPartySelfState.url !== watchPartyPartnerPresence.url;

    if (partnerHasOther) {
        banner.style.display = "flex";
        const textEl = banner.querySelector("#wpJoinText");
        if (textEl) textEl.textContent = "Партнёр сейчас смотрит: " + describeWPSource(watchPartyPartnerPresence.sourceType);
    } else {
        banner.style.display = "none";
    }
}

function showWPStatusNote(text) {
    const el = document.getElementById("watchPartyNote");
    if (!el) return;
    el.textContent = text;
    el.style.opacity = "1";
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.style.opacity = "0"; }, 3500);
}

// ==========================================
// АУДИО/ВИДЕО ЗВОНОК СОВМЕСТНОГО ПРОСМОТРА (WebRTC)
// ==========================================
// Две независимые кнопки — микрофон и камера. Каждая сама по себе добавляет/
// убирает свой трек в общее соединение (одно на двоих, лениво создаётся по
// требованию). Сигналинг — через canал watch_party_room (событие "webrtc"),
// офферы/ответы/ICE-кандидаты просто рассылаются партнёру broadcast'ом.

// "Вежливый" пир — тот, чей id меньше лексикографически. Оба клиента
// вычисляют это одинаково, не сговариваясь, поэтому роли никогда не
// расходятся. Вежливый пир уступает при коллизии офферов (откатывает свой).
function isWatchPartyPolitePeer() {
    if (!currentUser || !watchPartyPartnerId) return true;
    return currentUser.id < watchPartyPartnerId;
}

function broadcastWatchPartyRTC(type, extra) {
    if (!watchPartyChannel || !currentUser) return;
    watchPartyChannel.send({
        type: "broadcast",
        event: "webrtc",
        payload: Object.assign({ type: type, senderId: currentUser.id }, extra || {})
    });
}

// Создаёт (если ещё не создано) единое RTCPeerConnection на весь звонок —
// и микрофон, и камера используют одно и то же соединение.
function ensureWatchPartyPeerConnection() {
    if (watchPartyPeerConnection) return watchPartyPeerConnection;
    if (!currentUser) return null;

    const pc = new RTCPeerConnection(WATCH_PARTY_RTC_CONFIG);
    watchPartyPeerConnection = pc;
    watchPartyRemoteStream = new MediaStream();

    pc.ontrack = (e) => {
        watchPartyRemoteStream.addTrack(e.track);
        e.track.onended = () => {
            try { watchPartyRemoteStream.removeTrack(e.track); } catch (err) {}
            updateWatchPartyRemoteMedia();
        };
        updateWatchPartyRemoteMedia();
    };

    pc.onicecandidate = (e) => {
        if (e.candidate) broadcastWatchPartyRTC("ice", { candidate: e.candidate.toJSON() });
    };

    // Срабатывает сам, когда меняется набор треков (добавили/убрали
    // микро/камеру) — именно здесь и формируется оффер по паттерну
    // "perfect negotiation".
    pc.onnegotiationneeded = async () => {
        try {
            watchPartyMakingOffer = true;
            await pc.setLocalDescription();
            broadcastWatchPartyRTC("desc", { description: pc.localDescription });
        } catch (err) {
            console.error("Ошибка согласования звонка совместного просмотра:", err);
        } finally {
            watchPartyMakingOffer = false;
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
            // Соединение развалилось (обычно из-за сети) — закрываем и,
            // если у нас всё ещё включены микро/камера, пробуем пересобрать.
            const shouldRetry = watchPartyMicOn || watchPartyCamOn;
            closeWatchPartyPeerConnectionOnly();
            if (shouldRetry && watchPartyPartnerOnline) ensureWatchPartyPeerConnection();
        }
    };

    return pc;
}

// Обработчик входящих сигналов от партнёра (offer/answer/ICE/статус
// микро-камеры/прощание при выходе с экрана).
async function handleWatchPartyRTCSignal(payload) {
    if (!payload || !currentUser || payload.senderId === currentUser.id) return;
    watchPartyPartnerId = payload.senderId;

    if (payload.type === "desc") {
        const pc = ensureWatchPartyPeerConnection();
        if (!pc) return;
        const description = payload.description;
        const isPolite = isWatchPartyPolitePeer();
        const offerCollision = description.type === "offer" &&
            (watchPartyMakingOffer || pc.signalingState !== "stable");

        watchPartyIgnoreOffer = !isPolite && offerCollision;
        if (watchPartyIgnoreOffer) return; // мы "невежливый" пир — партнёр сам откатит свой оффер

        try {
            await pc.setRemoteDescription(description);
            if (description.type === "offer") {
                await pc.setLocalDescription();
                broadcastWatchPartyRTC("desc", { description: pc.localDescription });
            }
        } catch (err) {
            console.error("Ошибка обработки offer/answer звонка совместного просмотра:", err);
        }
        return;
    }

    if (payload.type === "ice") {
        const pc = watchPartyPeerConnection;
        if (!pc) return;
        try {
            await pc.addIceCandidate(payload.candidate);
        } catch (err) {
            if (!watchPartyIgnoreOffer) console.error("Ошибка ICE-кандидата звонка совместного просмотра:", err);
        }
        return;
    }

    if (payload.type === "media-state") {
        const prev = watchPartyPartnerMediaState;
        watchPartyPartnerMediaState = { mic: !!payload.mic, cam: !!payload.cam };

        // Не полагаемся только на track.onended — в некоторых браузерах при
        // renegotiation (партнёр выключил камеру/микро) трек на нашей стороне
        // не всегда получает событие "ended" вовремя (или вообще), и превью
        // зависает с последним кадром. Явный сигнал mic/cam — надёжный
        // источник истины, поэтому лишние треки подчищаем сами.
        if (watchPartyRemoteStream) {
            if (!watchPartyPartnerMediaState.cam) {
                watchPartyRemoteStream.getVideoTracks().forEach(t => watchPartyRemoteStream.removeTrack(t));
            }
            if (!watchPartyPartnerMediaState.mic) {
                watchPartyRemoteStream.getAudioTracks().forEach(t => watchPartyRemoteStream.removeTrack(t));
            }
        }

        renderWatchPartyCallControls();
        // Звук — только партнёру, только на реальное изменение состояния
        // (а не на повторную рассылку того же самого).
        if (prev.mic !== watchPartyPartnerMediaState.mic) {
            playWatchPartyToggleSound(watchPartyPartnerMediaState.mic);
            showWPStatusNote(watchPartyPartnerMediaState.mic ? "🎤 Партнёр включил микрофон" : "🔇 Партнёр выключил микрофон");
        }
        if (prev.cam !== watchPartyPartnerMediaState.cam) {
            playWatchPartyToggleSound(watchPartyPartnerMediaState.cam);
            showWPStatusNote(watchPartyPartnerMediaState.cam ? "🎥 Партнёр включил камеру" : "📷 Партнёр выключил камеру");
        }
        return;
    }

    if (payload.type === "bye") {
        closeWatchPartyPeerConnectionOnly();
        watchPartyPartnerMediaState = { mic: false, cam: false };
        renderWatchPartyCallControls();
        return;
    }
}

// Синтезирует короткий звук оповещения о включении/выключении микро/камеры
// партнёром — намеренно НЕ похож на "динь-динь" нового сообщения в чате
// (playWatchPartyBellSound): здесь короткое скользящее "свуп" по частоте
// (вверх — включили, вниз — выключили), пилообразная волна вместо синусоиды.
function playWatchPartyToggleSound(turnedOn) {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!watchPartyCallAudioCtx) watchPartyCallAudioCtx = new AudioCtx();
        if (watchPartyCallAudioCtx.state === "suspended") watchPartyCallAudioCtx.resume();

        const ctx = watchPartyCallAudioCtx;
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";

        const startFreq = turnedOn ? 420 : 620;
        const endFreq = turnedOn ? 780 : 260;
        osc.frequency.setValueAtTime(startFreq, now);
        osc.frequency.exponentialRampToValueAtTime(endFreq, now + 0.16);

        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.2, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.24);
    } catch (e) {
        console.error("Не удалось воспроизвести звук переключения микро/камеры:", e);
    }
}

// Закрывает только RTCPeerConnection и остатки удалённого потока — наши
// собственные локальные треки (и кнопки mic/cam) не трогает, чтобы при
// возврате партнёра можно было тихо пересобрать соединение.
function closeWatchPartyPeerConnectionOnly() {
    if (watchPartyPeerConnection) {
        try { watchPartyPeerConnection.close(); } catch (e) {}
        watchPartyPeerConnection = null;
    }
    watchPartyRemoteStream = null;
    watchPartyMakingOffer = false;
    watchPartyIgnoreOffer = false;
    watchPartyPartnerMediaState = { mic: false, cam: false };
    updateWatchPartyRemoteMedia();
}

// Полная остановка звонка (наши треки тоже глушим) — вызывается при выходе
// с экрана совместного просмотра.
function cleanupWatchPartyCall() {
    broadcastWatchPartyRTC("bye", {});
    if (watchPartyLocalStream) {
        watchPartyLocalStream.getTracks().forEach(t => t.stop());
        watchPartyLocalStream = null;
    }
    closeWatchPartyPeerConnectionOnly();
    watchPartyMicOn = false;
    watchPartyCamOn = false;
    watchPartyPartnerMediaState = { mic: false, cam: false };
    renderWatchPartyCallControls();
}

// Превращает DOMException от getUserMedia в понятное пользователю сообщение —
// вместо одной и той же общей фразы на любую причину сбоя (иначе не отличить
// "запретили доступ" от "камера занята другим приложением" или "сайт открыт
// не по HTTPS").
function describeWatchPartyMediaError(err, kind) {
    const device = kind === "audio" ? "микрофону" : "камере";
    const name = err && err.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        return "Доступ к " + device + " запрещён. Проверьте: 1) разрешение для этого сайта в самом браузере (значок замка / "
            + "«ⓘ» рядом с адресной строкой → Разрешения); 2) разрешение на камеру/микрофон для самого браузера в настройках "
            + "телефона (Android: Настройки → Приложения → [браузер] → Разрешения; iOS: Настройки → [браузер], или Настройки → "
            + "Safari → Камера/Микрофон, если это Safari). Если сайт открыт из встроенного браузера мессенджера/соцсети — "
            + "откройте ссылку в обычном браузере, встроенные WebView часто блокируют это в принципе.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        return "Не найдено устройство (" + device + "). Возможно, оно отключено в настройках телефона.";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
        return device.charAt(0).toUpperCase() + device.slice(1) + " уже используется другим приложением — закройте его и попробуйте снова.";
    }
    if (name === "SecurityError") {
        return "Браузер блокирует доступ по соображениям безопасности — сайт должен быть открыт по HTTPS (не http://).";
    }
    return "Не удалось получить доступ к " + device + " (" + (name || "неизвестная ошибка") + "). Подробности — в консоли браузера.";
}

// ---------- Включение/выключение микрофона ----------
async function toggleWatchPartyMic() {
    if (!currentUser) return;
    if (watchPartyMicOn) {
        if (watchPartyPeerConnection) {
            watchPartyPeerConnection.getSenders().forEach(sender => {
                if (sender.track && sender.track.kind === "audio") {
                    const track = sender.track; // removeTrack() ниже сам обнулит sender.track — сохраняем ссылку заранее
                    watchPartyPeerConnection.removeTrack(sender);
                    track.stop();
                }
            });
        }
        if (watchPartyLocalStream) {
            watchPartyLocalStream.getAudioTracks().forEach(t => {
                watchPartyLocalStream.removeTrack(t);
                t.stop();
            });
        }
        watchPartyMicOn = false;
        renderWatchPartyCallControls();
        broadcastWatchPartyRTC("media-state", { mic: watchPartyMicOn, cam: watchPartyCamOn });
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const track = stream.getAudioTracks()[0];
        if (!watchPartyLocalStream) watchPartyLocalStream = new MediaStream();
        watchPartyLocalStream.addTrack(track);
        const pc = ensureWatchPartyPeerConnection();
        if (pc) pc.addTrack(track, watchPartyLocalStream);
        watchPartyMicOn = true;
        renderWatchPartyCallControls();
        broadcastWatchPartyRTC("media-state", { mic: watchPartyMicOn, cam: watchPartyCamOn });
    } catch (err) {
        console.error("Не удалось включить микрофон:", err);
        alert(describeWatchPartyMediaError(err, "audio"));
    }
}

// ---------- Включение/выключение камеры ----------
async function toggleWatchPartyCam() {
    if (!currentUser) return;
    if (watchPartyCamOn) {
        if (watchPartyPeerConnection) {
            watchPartyPeerConnection.getSenders().forEach(sender => {
                if (sender.track && sender.track.kind === "video") {
                    const track = sender.track; // removeTrack() ниже сам обнулит sender.track — сохраняем ссылку заранее
                    watchPartyPeerConnection.removeTrack(sender);
                    track.stop();
                }
            });
        }
        if (watchPartyLocalStream) {
            watchPartyLocalStream.getVideoTracks().forEach(t => {
                watchPartyLocalStream.removeTrack(t);
                t.stop();
            });
        }
        watchPartyCamOn = false;
        renderWatchPartyCallControls();
        updateWatchPartyLocalPreview();
        broadcastWatchPartyRTC("media-state", { mic: watchPartyMicOn, cam: watchPartyCamOn });
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: watchPartyFacingMode }
        });
        const track = stream.getVideoTracks()[0];
        if (!watchPartyLocalStream) watchPartyLocalStream = new MediaStream();
        watchPartyLocalStream.addTrack(track);
        const pc = ensureWatchPartyPeerConnection();
        if (pc) pc.addTrack(track, watchPartyLocalStream);
        watchPartyCamOn = true;
        renderWatchPartyCallControls();
        updateWatchPartyLocalPreview();
        broadcastWatchPartyRTC("media-state", { mic: watchPartyMicOn, cam: watchPartyCamOn });
        detectWatchPartyMultipleCameras();
    } catch (err) {
        console.error("Не удалось включить камеру:", err);
        alert(describeWatchPartyMediaError(err, "video"));
    }
}

// Разворот камеры (фронтальная/основная) — актуально на телефоне.
// Меняем трек через replaceTrack, это НЕ требует пересогласования (SDP).
async function switchWatchPartyCamera() {
    if (!watchPartyCamOn || !watchPartyLocalStream) return;
    watchPartyFacingMode = watchPartyFacingMode === "user" ? "environment" : "user";
    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: watchPartyFacingMode }
        });
        const newTrack = newStream.getVideoTracks()[0];
        const oldTrack = watchPartyLocalStream.getVideoTracks()[0];
        if (oldTrack) {
            watchPartyLocalStream.removeTrack(oldTrack);
            oldTrack.stop();
        }
        watchPartyLocalStream.addTrack(newTrack);

        if (watchPartyPeerConnection) {
            const sender = watchPartyPeerConnection.getSenders().find(s => s.track && s.track.kind === "video");
            if (sender) await sender.replaceTrack(newTrack);
            else watchPartyPeerConnection.addTrack(newTrack, watchPartyLocalStream);
        }
        updateWatchPartyLocalPreview();
    } catch (err) {
        console.error("Не удалось развернуть камеру:", err);
        watchPartyFacingMode = watchPartyFacingMode === "user" ? "environment" : "user"; // откатываем при неудаче
    }
}

// Показываем кнопку разворота камеры, только если на устройстве реально
// больше одной камеры (иначе на десктопе она будет просто бесполезной).
async function detectWatchPartyMultipleCameras() {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        watchPartyHasMultipleCameras = devices.filter(d => d.kind === "videoinput").length > 1;
        renderWatchPartyCallControls();
    } catch (e) {}
}

// ---------- Обновление DOM ----------
function updateWatchPartyLocalPreview() {
    const box = document.getElementById("wpLocalPreviewBox");
    const video = document.getElementById("wpLocalVideo");
    const flipBtn = document.getElementById("wpFlipCamBtn");
    if (!box || !video) return;

    if (watchPartyCamOn && watchPartyLocalStream) {
        video.srcObject = watchPartyLocalStream;
        video.play().catch(() => {});
        video.classList.toggle("wp-mirror", watchPartyFacingMode === "user");
        box.classList.add("wp-preview-visible");
    } else {
        video.srcObject = null;
        box.classList.remove("wp-preview-visible");
    }
    if (flipBtn) flipBtn.style.display = (watchPartyCamOn && watchPartyHasMultipleCameras) ? "flex" : "none";
}

function updateWatchPartyRemoteMedia() {
    const box = document.getElementById("wpRemotePreviewBox");
    const video = document.getElementById("wpRemoteVideo");
    const badge = document.getElementById("wpAudioOnlyBadge");
    if (!box || !video) return;

    if (video.srcObject !== watchPartyRemoteStream) {
        video.srcObject = watchPartyRemoteStream;
    }
    if (watchPartyRemoteStream && watchPartyRemoteStream.getTracks().length) {
        // video.srcObject приходит из RTCPeerConnection.ontrack — а это
        // срабатывает уже ПОСЛЕ обмена сигналами, то есть вне синхронного
        // контекста клика по кнопке микро/камеры. Android Chrome в таком
        // случае считает, что "недавнего" пользовательского жеста не было,
        // и молча блокирует play() для элемента со звуковой дорожкой —
        // получаем постоянный чёрный экран вместо видео партнёра. Safari/iOS
        // делает исключение для потоков WebRTC, поэтому там всё работало.
        // Обходим стандартным способом: если запуск "как есть" не удался,
        // на мгновение заглушаем звук (autoplay muted-видео разрешён везде
        // без всяких жестов) и снимаем mute сразу после того, как
        // воспроизведение реально стартовало — это уже не требует нового
        // жеста, так как проигрывание уже идёт.
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => {
                video.muted = true;
                video.play().then(() => { video.muted = false; }).catch(() => {});
            });
        }
    }

    // Видимость держим на явном сигнале от партнёра (media-state), а не на
    // том, жив ли ещё трек в потоке — иначе при выключении камеры/микро
    // партнёром превью может зависнуть с последним кадром до следующего
    // события (см. комментарий в handleWatchPartyRTCSignal).
    const showCam = watchPartyPartnerMediaState.cam;
    const showAudioOnly = watchPartyPartnerMediaState.mic && !watchPartyPartnerMediaState.cam;

    box.classList.toggle("wp-preview-visible", showCam || showAudioOnly);
    video.style.visibility = showCam ? "visible" : "hidden";
    if (badge) badge.style.display = showAudioOnly ? "flex" : "none";
}

function renderWatchPartyCallControls() {
    const micBtn = document.getElementById("wpMicBtn");
    if (micBtn) {
        micBtn.classList.toggle("wp-call-btn-active", watchPartyMicOn);
        micBtn.textContent = watchPartyMicOn ? "🎤" : "🔇";
        micBtn.title = watchPartyMicOn ? "Выключить микрофон" : "Включить микрофон";
    }
    const camBtn = document.getElementById("wpCamBtn");
    if (camBtn) {
        camBtn.classList.toggle("wp-call-btn-active", watchPartyCamOn);
        camBtn.textContent = watchPartyCamOn ? "🎥" : "📷";
        camBtn.title = watchPartyCamOn ? "Выключить камеру" : "Включить камеру";
    }
    updateWatchPartyLocalPreview();
    updateWatchPartyRemoteMedia();
}

// ---------- Свайп между страницами "Чат" / "Аудио-видео" ----------
function scrollWatchPartySwipeToPage(index) {
    const track = document.getElementById("wpSwipeTrack");
    if (!track) return;
    const page = track.children[index];
    if (page) track.scrollTo({ left: page.offsetLeft, behavior: "smooth" });
}

function updateWatchPartySwipeDots() {
    const track = document.getElementById("wpSwipeTrack");
    if (!track || !track.clientWidth) return;
    const dots = document.querySelectorAll(".wp-swipe-dot");
    if (!dots.length) return;
    const idx = Math.round(track.scrollLeft / track.clientWidth);
    dots.forEach((d, i) => d.classList.toggle("wp-swipe-dot-active", i === idx));
}

// ==========================================
// ЧАТ СОВМЕСТНОГО ПРОСМОТРА
// ==========================================
// Функционал повторяет обычный чат (стикеры, ответы, время, редактирование,
// удаление, реакция сердечком), но живёт в отдельной таблице БД
// (watch_party_messages, лимит 100 сообщений — старые чистятся триггером
// на стороне БД) и встроен прямо в экран совместного просмотра компактным
// блоком, а не отдельным полноэкранным чатом.

// Загружает последние 100 сообщений чата совместного просмотра
async function loadWatchPartyChatMessages() {
    const { data, error } = await db
        .from('watch_party_messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

    if (error) {
        console.error("Ошибка при загрузке чата совместного просмотра:", error);
        return;
    }

    watchPartyChatMessages = data.reverse();
}

// Синтезирует короткий звук-«колокольчик» через Web Audio API (без внешнего
// аудиофайла) — играет при новом сообщении от партнёра в совместном
// просмотре, независимо от того, свёрнут чат или открыт полноэкранный плеер:
// пока пользователь физически находится на этом экране (а значит realtime-канал
// вообще подписан), звук должен быть слышен.
let wpNotifyAudioCtx = null;
function playWatchPartyBellSound() {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!wpNotifyAudioCtx) wpNotifyAudioCtx = new AudioCtx();
        if (wpNotifyAudioCtx.state === "suspended") wpNotifyAudioCtx.resume();

        const ctx = wpNotifyAudioCtx;
        const now = ctx.currentTime;

        // Два коротких перекрывающихся тона дают эффект "динь-динь"
        [880, 1320].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sine";
            osc.frequency.value = freq;

            const start = now + i * 0.09;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.22, start + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);

            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.55);
        });
    } catch (e) {
        console.error("Не удалось воспроизвести звук уведомления:", e);
    }
}

// Реалтайм-обработчик изменений в чате совместного просмотра
async function onWatchPartyChatRealtimeChange(payload) {
    // Звук — только на НОВОЕ сообщение (INSERT) и только если оно не наше
    // собственное (иначе будет пищать в ответ на каждое своё сообщение).
    // Редактирование/удаление/реакция сердечком (UPDATE/DELETE) сюда не попадают.
    if (
        payload &&
        payload.eventType === "INSERT" &&
        payload.new &&
        (!currentUser || payload.new.user_id !== currentUser.id)
    ) {
        playWatchPartyBellSound();
    }

    await loadWatchPartyChatMessages();
    if (isWatchPartyScreenOpen) {
        renderWatchPartyChatMessages();
    }
}

// ---------- Ответ на сообщение ----------
function setWPChatReplyTarget(msg) {
    watchPartyChatReplyTarget = msg;
    renderWPChatReplyBar();
    const input = document.getElementById("wpChatInput");
    if (input) input.focus();
}

function clearWPChatReplyTarget() {
    watchPartyChatReplyTarget = null;
    renderWPChatReplyBar();
}

function renderWPChatReplyBar() {
    const box = document.getElementById("wpChatReplyBarBox");
    if (!box) return;

    if (!watchPartyChatReplyTarget) {
        box.innerHTML = "";
        return;
    }

    box.innerHTML = `
        <div class="chat-reply-bar">
            <div class="chat-reply-bar-info">
                <span class="chat-reply-bar-author"></span>
                <span class="chat-reply-bar-text"></span>
            </div>
            <button type="button" class="chat-reply-bar-cancel" id="wpChatReplyCancelBtn">✕</button>
        </div>
    `;
    box.querySelector(".chat-reply-bar-author").textContent = watchPartyChatReplyTarget.username;
    box.querySelector(".chat-reply-bar-text").textContent = buildReplyPreviewText(watchPartyChatReplyTarget);
    box.querySelector("#wpChatReplyCancelBtn").onclick = () => clearWPChatReplyTarget();
}

// ---------- Пузыри сообщений ----------
function createWPChatBubble(msg) {
    let bubble = document.createElement("div");
    const isMine = currentUser && msg.user_id === currentUser.id;
    bubble.className = "chat-bubble " + (isMine ? "chat-bubble-mine" : "chat-bubble-theirs");
    bubble.dataset.msgId = msg.id;

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
        img.oncontextmenu = (e) => e.preventDefault();
        text.appendChild(img);
    } else {
        text.textContent = msg.message;
    }

    bubble.appendChild(meta);
    bubble.appendChild(text);

    if (msg.reaction) {
        let heart = document.createElement("div");
        heart.className = "chat-reaction-heart";
        heart.textContent = msg.reaction;
        bubble.appendChild(heart);
    }

    bubble.style.cursor = "pointer";
    attachWPChatLongPress(bubble, msg, isMine);

    if (!isMine) {
        attachWPChatDoubleTap(bubble, msg);
    }

    return bubble;
}

function updateWPChatBubbleContent(bubbleEl, msg) {
    const quoteTextEl = bubbleEl.querySelector(".chat-reply-quote-text");
    if (quoteTextEl) {
        const quoteText = msg.reply_to_text || "";
        if (quoteTextEl.textContent !== quoteText) {
            quoteTextEl.textContent = quoteText;
        }
    }

    if (isStickerMessage(msg.message)) return;

    const textEl = bubbleEl.querySelector(".chat-text");
    if (textEl && textEl.textContent !== msg.message) {
        textEl.textContent = msg.message;
    }
    const metaEl = bubbleEl.querySelector(".chat-meta");
    const metaText = `${msg.username} • ${formatChatTime(msg.created_at)}`;
    if (metaEl && metaEl.textContent !== metaText) {
        metaEl.textContent = metaText;
    }

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

function attachWPChatLongPress(el, msg, isMine) {
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
                showWPChatMessageMenu(msg, isMine);
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

function attachWPChatDoubleTap(el, msg) {
    let lastTapTime = 0;
    const DOUBLE_TAP_MS = 300;

    const handleTap = (e) => {
        const now = Date.now();
        if (now - lastTapTime < DOUBLE_TAP_MS) {
            lastTapTime = 0;
            e.preventDefault();
            toggleWPChatHeartReaction(msg);
        } else {
            lastTapTime = now;
        }
    };

    el.addEventListener("dblclick", (e) => {
        e.preventDefault();
        toggleWPChatHeartReaction(msg);
    });
    el.addEventListener("touchend", handleTap, { passive: false });
}

async function toggleWPChatHeartReaction(msg) {
    if (!currentUser) return;
    const alreadyMine = msg.reaction && msg.reaction_by === currentUser.id;
    const newReaction = alreadyMine ? null : "❤️";
    const newReactionBy = alreadyMine ? null : currentUser.id;

    vibrate(20);

    const local = watchPartyChatMessages.find(m => m.id === msg.id);
    if (local) {
        local.reaction = newReaction;
        local.reaction_by = newReactionBy;
        renderWatchPartyChatMessages();
    }

    const { error } = await db.from('watch_party_messages')
        .update({ reaction: newReaction, reaction_by: newReactionBy })
        .eq('id', msg.id);

    if (error) {
        console.error("Ошибка при сохранении реакции в чате совместного просмотра:", error);
    }
}

function showWPChatMessageMenu(msg, isMine) {
    const canModify = isMine && canModifyChatMessage(msg);
    const isSticker = isStickerMessage(msg.message);

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "wpChatMsgMenuModal";
    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 15px;">Сообщение</h3>
            <div class="action-buttons">
                <button class="btn-action-edit" id="wpChatMsgReply">↩️ Ответить</button>
                ${canModify && !isSticker ? `<button class="btn-action-edit" id="wpChatMsgEdit">✏️ Редактировать</button>` : ``}
                ${canModify ? `<button class="btn-action-delete" id="wpChatMsgDelete">🗑️ Удалить</button>` : ``}
                <button class="btn-action-cancel" id="wpChatMsgCancel">${canModify ? "Отмена" : "Закрыть"}</button>
            </div>
            ${isMine && !canModify ? `<p style="color: #9686b8; font-size: 13px; margin-top: 12px;">Изменять и удалять сообщение можно только в течение 24 часов после отправки.</p>` : ``}
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("wpChatMsgCancel").onclick = () => overlay.remove();

    document.getElementById("wpChatMsgReply").onclick = () => {
        overlay.remove();
        setWPChatReplyTarget(msg);
    };

    if (!canModify) return;

    const editBtn = document.getElementById("wpChatMsgEdit");
    if (editBtn) editBtn.onclick = () => {
        overlay.remove();
        if (!canModifyChatMessage(msg)) {
            alert("Время редактирования истекло (доступно только 24 часа после отправки).");
            return;
        }
        showWPChatMessageEditModal(msg);
    };

    document.getElementById("wpChatMsgDelete").onclick = async () => {
        overlay.remove();
        if (!canModifyChatMessage(msg)) {
            alert("Время удаления истекло (доступно только 24 часа после отправки).");
            return;
        }
        if (!confirm("Удалить это сообщение?")) return;

        const { error: replyUpdateError } = await db.from('watch_party_messages')
            .update({ reply_to_text: "Сообщение удалено" })
            .eq('reply_to_id', msg.id);
        if (replyUpdateError) {
            console.error("Ошибка при обновлении ответов на удаляемое сообщение:", replyUpdateError);
        }

        const { error } = await db.from('watch_party_messages').delete().eq('id', msg.id);
        if (error) {
            console.error("Ошибка при удалении сообщения:", error);
            alert("Не удалось удалить сообщение.");
            return;
        }
        watchPartyChatMessages = watchPartyChatMessages.filter(m => m.id !== msg.id);
        watchPartyChatMessages.forEach(m => {
            if (m.reply_to_id === msg.id) m.reply_to_text = "Сообщение удалено";
        });
        renderWatchPartyChatMessages();
    };
}

function showWPChatMessageEditModal(msg) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "wpChatMsgEditModal";
    overlay.innerHTML = `
        <div class="modal-content">
            <h3 style="text-align: center; margin-bottom: 15px;">Редактировать сообщение</h3>
            <form class="modal-form" id="wpChatEditForm">
                <input type="text" id="wpChatEditInput" required>
                <div class="modal-buttons">
                    <button type="submit" class="btn-save">Сохранить</button>
                    <button type="button" class="btn-cancel" id="wpChatEditCancel">Отмена</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector("#wpChatEditInput");
    input.value = msg.message;
    input.focus();

    overlay.querySelector("#wpChatEditCancel").onclick = () => overlay.remove();

    overlay.querySelector("#wpChatEditForm").onsubmit = async (e) => {
        e.preventDefault();
        const newText = input.value.trim();
        if (!newText || newText === msg.message) {
            overlay.remove();
            return;
        }

        const { error } = await db.from('watch_party_messages').update({ message: newText }).eq('id', msg.id);
        if (error) {
            console.error("Ошибка при редактировании сообщения:", error);
            alert("Не удалось изменить сообщение.");
            return;
        }
        const local = watchPartyChatMessages.find(m => m.id === msg.id);
        if (local) local.message = newText;
        overlay.remove();
        renderWatchPartyChatMessages();
    };
}

// Отрисовка (та же логика "не перерисовывать всё с нуля", что и в обычном чате)
function renderWatchPartyChatMessages() {
    const box = document.getElementById("wpChatBox");
    if (!box) return;

    if (watchPartyChatMessages.length === 0) {
        if (box.dataset.rendered !== "empty") {
            box.innerHTML = "";
            let empty = document.createElement("p");
            empty.style.cssText = "text-align:center;color:#9686b8;margin-top:15px;font-size:13px;";
            empty.textContent = "Сообщений пока нет. Напишите первым!";
            box.appendChild(empty);
            box.dataset.rendered = "empty";
        }
        return;
    }

    if (box.dataset.rendered === "empty") {
        box.innerHTML = "";
        box.dataset.rendered = "list";
    }
    box.dataset.rendered = "list";

    const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

    const renderedEls = new Map();
    box.querySelectorAll("[data-msg-id]").forEach(el => renderedEls.set(el.dataset.msgId, el));
    const currentIds = new Set(watchPartyChatMessages.map(m => String(m.id)));

    renderedEls.forEach((el, id) => {
        if (!currentIds.has(id)) el.remove();
    });

    let addedNew = false;
    watchPartyChatMessages.forEach(msg => {
        const idStr = String(msg.id);
        const existingEl = renderedEls.get(idStr);
        if (!existingEl) {
            box.appendChild(createWPChatBubble(msg));
            addedNew = true;
        } else {
            updateWPChatBubbleContent(existingEl, msg);
        }
    });

    if (addedNew && wasNearBottom) {
        box.scrollTop = box.scrollHeight;
    }
}

// ---------- Модалка вставки кода стороннего плеера (<iframe>) ----------
function showWPIframeModal() {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "wpIframeModal";
    overlay.innerHTML = `
        <div class="modal-content">
            <h3 style="text-align: center; margin-bottom: 15px;">🔗 Вставить код плеера</h3>
            <form class="modal-form" id="wpIframeForm">
                <textarea id="wpIframeInput" rows="5" placeholder='<iframe src="..." width="640" height="360"></iframe>' style="width:100%; resize:vertical; font-family:monospace; font-size:13px; box-sizing:border-box;" required></textarea>
                <div class="modal-buttons">
                    <button type="submit" class="btn-save">Загрузить</button>
                    <button type="button" class="btn-cancel" id="wpIframeCancel">Отмена</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(overlay);

    const closeModal = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
    overlay.querySelector("#wpIframeCancel").onclick = closeModal;

    const textarea = overlay.querySelector("#wpIframeInput");
    textarea.focus();

    overlay.querySelector("#wpIframeForm").onsubmit = (e) => {
        e.preventDefault();
        const html = textarea.value.trim();
        if (!html) return;

        if (!extractIframeSrc(html)) {
            alert("Не нашлось тега <iframe> с атрибутом src. Проверьте и вставьте код плеера целиком.");
            return;
        }

        closeModal();
        loadWatchPartySource(html, { initialTime: 0, autoplay: false, announce: true });
    };
}

// ---------- Экран совместного просмотра ----------
async function showWatchPartyScreen() {
    if (!currentUser) { location.href = "../"; return; }

    let oldNav = document.querySelector(".navigation");
    if (oldNav) oldNav.remove();

    app.innerHTML = "";
    renderMiniHeader(app);
    isWatchPartyScreenOpen = true;

    let title = document.createElement("h1");
    setEmojiTitle(title, "🎬 Совместный просмотр");
    app.appendChild(title);

    let statusBar = document.createElement("div");
    statusBar.id = "watchPartyStatusBar";
    statusBar.className = "wp-status-bar";
    statusBar.innerHTML = '<span class="wp-status-dot wp-offline"></span> Подключаемся...';
    app.appendChild(statusBar);

    // Баннер "партнёр смотрит другое видео, присоединиться?" — всегда над
    // плеером, самым верхним смысловым блоком (не относится к чату).
    let joinBanner = document.createElement("div");
    joinBanner.id = "watchPartyJoinBanner";
    joinBanner.className = "wp-join-banner";
    joinBanner.style.display = "none";
    joinBanner.innerHTML = '<span id="wpJoinText"></span>';
    let joinBtn = document.createElement("button");
    joinBtn.className = "btn-watchparty-gold";
    joinBtn.textContent = "▶️ Присоединиться";
    joinBtn.onclick = () => joinPartnerWatchParty();
    joinBanner.appendChild(joinBtn);
    app.appendChild(joinBanner);

    // Плеер
    let playerContainer = document.createElement("div");
    playerContainer.id = "watchPartyPlayerContainer";
    playerContainer.className = "wp-player-container";
    playerContainer.innerHTML = '<p style="text-align:center;color:var(--text-faint);padding:40px 0;">Вставьте ссылку ниже, чтобы начать</p>';
    app.appendChild(playerContainer);

    // Строка вставки ссылки + кнопка запуска рядом с ней
    let urlRow = document.createElement("div");
    urlRow.className = "chat-input-row wp-url-row";
    let urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.id = "wpUrlInput";
    urlInput.className = "chat-text-input";
    urlInput.placeholder = "Ссылка: YouTube, Rutube";
    urlInput.autocomplete = "off";
    // Кнопка вставки кода стороннего плеера (целиком <iframe>) — стоит левее
    // кнопки запуска, тот же стиль иконки, что у кнопки со стикерами в чате.
    let wpIframeBtn = document.createElement("button");
    wpIframeBtn.id = "wpIframeBtn";
    wpIframeBtn.type = "button";
    wpIframeBtn.className = "chat-sticker-btn";
    wpIframeBtn.title = "Вставить код плеера (iframe)";
    wpIframeBtn.textContent = "🔗";
    wpIframeBtn.onclick = () => showWPIframeModal();

    let loadBtn = document.createElement("button");
    loadBtn.id = "wpLoadBtn";
    loadBtn.type = "button";
    loadBtn.className = "chat-send-btn"; // тот же стиль, что и у кнопки отправки сообщений в чат
    loadBtn.textContent = "➤"; // тот же эмодзи, что и у кнопки отправки сообщений в чат
    const doLoad = () => {
        const val = urlInput.value.trim();
        if (!val) return;
        loadWatchPartySource(val, { initialTime: 0, autoplay: false, announce: true });
    };
    loadBtn.onclick = doLoad;
    urlInput.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); doLoad(); }
    };
    urlRow.appendChild(urlInput);
    urlRow.appendChild(wpIframeBtn);
    urlRow.appendChild(loadBtn);
    app.appendChild(urlRow);

    let note = document.createElement("div");
    note.id = "watchPartyNote";
    note.className = "wp-note";
    app.appendChild(note);

    // ---------- Свайп-блок: страница 1 — чат, страница 2 — аудио/видео звонок ----------
    // Прокручиваемый контейнер с CSS scroll-snap — свайп между чатом и звонком
    // получается нативным и плавным (инерция/анимация — от самого браузера,
    // без ручного отслеживания touch-событий). Под ним — два кружка-индикатора
    // (как в Instagram-каруселях), по тапу тоже переключают страницу.
    let swipeWrap = document.createElement("div");
    swipeWrap.className = "wp-swipe-wrap";

    let swipeTrack = document.createElement("div");
    swipeTrack.id = "wpSwipeTrack";
    swipeTrack.className = "wp-swipe-track";

    // ---------- Страница 1: чат (своя таблица watch_party_messages) ----------
    let chatPage = document.createElement("div");
    chatPage.className = "wp-swipe-page";

    let chatLabel = document.createElement("div");
    chatLabel.className = "wp-chat-label";
    chatLabel.textContent = "💬 Чат";
    chatPage.appendChild(chatLabel);

    let wpChatBox = document.createElement("div");
    wpChatBox.className = "chat-box wp-chat-box";
    wpChatBox.id = "wpChatBox";
    chatPage.appendChild(wpChatBox);

    let wpReplyBarBox = document.createElement("div");
    wpReplyBarBox.id = "wpChatReplyBarBox";
    chatPage.appendChild(wpReplyBarBox);
    watchPartyChatReplyTarget = null;
    renderWPChatReplyBar();

    let wpInputRow = document.createElement("div");
    wpInputRow.className = "chat-input-row";

    let wpChatInput = document.createElement("input");
    wpChatInput.type = "text";
    wpChatInput.id = "wpChatInput";
    wpChatInput.className = "chat-text-input";
    wpChatInput.placeholder = "Написать сообщение...";
    wpChatInput.autocomplete = "off";

    let wpStickerBtn = document.createElement("button");
    wpStickerBtn.id = "wpChatStickerBtn";
    wpStickerBtn.className = "chat-sticker-btn";
    wpStickerBtn.type = "button";
    wpStickerBtn.textContent = "😊";

    let wpSendBtn = document.createElement("button");
    wpSendBtn.id = "wpChatSendBtn";
    wpSendBtn.className = "chat-send-btn";
    wpSendBtn.textContent = "➤";

    const sendWPChatMessage = async (text) => {
        if (!text || !currentUser) return;

        const username = getUsernameFromEmail(currentUser.email);
        const payload = { user_id: currentUser.id, username: username, message: text };

        if (watchPartyChatReplyTarget) {
            payload.reply_to_id = watchPartyChatReplyTarget.id;
            payload.reply_to_username = watchPartyChatReplyTarget.username;
            payload.reply_to_text = buildReplyPreviewText(watchPartyChatReplyTarget);
        }

        const { data, error } = await db.from('watch_party_messages')
            .insert([payload])
            .select()
            .single();

        if (error) {
            console.error("Ошибка при отправке сообщения в чат совместного просмотра:", error);
            alert("Не удалось отправить сообщение.");
            return;
        }

        clearWPChatReplyTarget();

        if (data) {
            watchPartyChatMessages.push(data);
            if (watchPartyChatMessages.length > 100) watchPartyChatMessages.shift();
            renderWatchPartyChatMessages();
        }
    };

    const sendWPMessageFromInput = async () => {
        const text = wpChatInput.value.trim();
        if (!text) return;

        wpChatInput.value = "";
        wpChatInput.focus();

        await sendWPChatMessage(text);
    };

    wpStickerBtn.onclick = () => {
        if (!currentUser) return;
        showStickerPicker((stickerUrl) => sendWPChatMessage(STICKER_PREFIX + stickerUrl));
    };

    wpSendBtn.onclick = sendWPMessageFromInput;
    wpChatInput.onkeydown = (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            sendWPMessageFromInput();
        }
    };

    wpInputRow.appendChild(wpChatInput);
    wpInputRow.appendChild(wpStickerBtn);
    wpInputRow.appendChild(wpSendBtn);
    chatPage.appendChild(wpInputRow);
    swipeTrack.appendChild(chatPage);

    // ---------- Страница 2: аудио/видео звонок (крупнее, на всю ширину страницы) ----------
    let callPage = document.createElement("div");
    callPage.className = "wp-swipe-page";

    let callLabel = document.createElement("div");
    callLabel.className = "wp-chat-label";
    callLabel.textContent = "📞 Аудио/видео";
    callPage.appendChild(callLabel);

    let callButtonsRow = document.createElement("div");
    callButtonsRow.className = "wp-call-buttons-row";

    let micBtn = document.createElement("button");
    micBtn.id = "wpMicBtn";
    micBtn.type = "button";
    micBtn.className = "wp-call-btn wp-call-btn-lg";
    micBtn.textContent = "🔇";
    micBtn.title = "Включить микрофон";
    micBtn.onclick = () => toggleWatchPartyMic();
    callButtonsRow.appendChild(micBtn);

    let camBtn = document.createElement("button");
    camBtn.id = "wpCamBtn";
    camBtn.type = "button";
    camBtn.className = "wp-call-btn wp-call-btn-lg";
    camBtn.textContent = "📷";
    camBtn.title = "Включить камеру";
    camBtn.onclick = () => toggleWatchPartyCam();
    callButtonsRow.appendChild(camBtn);

    callPage.appendChild(callButtonsRow);

    let callPreviews = document.createElement("div");
    callPreviews.className = "wp-call-previews wp-call-previews-lg";

    // Наше собственное превью (видно только когда камера включена)
    let localPreviewBox = document.createElement("div");
    localPreviewBox.id = "wpLocalPreviewBox";
    localPreviewBox.className = "wp-preview-box wp-preview-box-lg";
    let localVideo = document.createElement("video");
    localVideo.id = "wpLocalVideo";
    localVideo.className = "wp-preview-video";
    localVideo.muted = true; // своё видео всегда без звука — иначе эхо
    localVideo.autoplay = true;
    localVideo.playsInline = true;
    localPreviewBox.appendChild(localVideo);
    let localLabel = document.createElement("div");
    localLabel.className = "wp-preview-label";
    localLabel.textContent = "Вы";
    localPreviewBox.appendChild(localLabel);
    let flipCamBtn = document.createElement("button");
    flipCamBtn.id = "wpFlipCamBtn";
    flipCamBtn.type = "button";
    flipCamBtn.className = "wp-flip-cam-btn";
    flipCamBtn.title = "Сменить камеру";
    flipCamBtn.textContent = "🔄";
    flipCamBtn.style.display = "none";
    flipCamBtn.onclick = () => switchWatchPartyCamera();
    localPreviewBox.appendChild(flipCamBtn);
    callPreviews.appendChild(localPreviewBox);

    // Превью партнёра (видео, если у него включена камера; иначе просто
    // играет его звук с микрофона, а тут показывается значок "только звук")
    let remotePreviewBox = document.createElement("div");
    remotePreviewBox.id = "wpRemotePreviewBox";
    remotePreviewBox.className = "wp-preview-box wp-preview-box-lg";
    let remoteVideo = document.createElement("video");
    remoteVideo.id = "wpRemoteVideo";
    remoteVideo.className = "wp-preview-video";
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;
    remotePreviewBox.appendChild(remoteVideo);
    let remoteLabel = document.createElement("div");
    remoteLabel.className = "wp-preview-label";
    remoteLabel.textContent = "Партнёр";
    remotePreviewBox.appendChild(remoteLabel);
    let audioOnlyBadge = document.createElement("div");
    audioOnlyBadge.id = "wpAudioOnlyBadge";
    audioOnlyBadge.className = "wp-audio-only-badge";
    audioOnlyBadge.textContent = "🎙️";
    audioOnlyBadge.style.display = "none";
    remotePreviewBox.appendChild(audioOnlyBadge);
    callPreviews.appendChild(remotePreviewBox);

    callPage.appendChild(callPreviews);
    swipeTrack.appendChild(callPage);

    swipeWrap.appendChild(swipeTrack);

    // ---------- Кружки-индикаторы (как в каруселях Instagram) ----------
    let swipeDots = document.createElement("div");
    swipeDots.className = "wp-swipe-dots";
    let chatDot = document.createElement("button");
    chatDot.type = "button";
    chatDot.className = "wp-swipe-dot wp-swipe-dot-active";
    chatDot.title = "Чат";
    chatDot.onclick = () => scrollWatchPartySwipeToPage(0);
    let callDot = document.createElement("button");
    callDot.type = "button";
    callDot.className = "wp-swipe-dot";
    callDot.title = "Аудио/видео";
    callDot.onclick = () => scrollWatchPartySwipeToPage(1);
    swipeDots.appendChild(chatDot);
    swipeDots.appendChild(callDot);
    swipeWrap.appendChild(swipeDots);

    app.appendChild(swipeWrap);

    // Отслеживаем прокрутку свайп-трека, чтобы подсвечивать активный кружок
    let wpSwipeScrollRAF = null;
    swipeTrack.addEventListener("scroll", () => {
        if (wpSwipeScrollRAF) return;
        wpSwipeScrollRAF = requestAnimationFrame(() => {
            wpSwipeScrollRAF = null;
            updateWatchPartySwipeDots();
        });
    }, { passive: true });

    watchPartyPartnerMediaState = { mic: false, cam: false };
    renderWatchPartyCallControls();
    detectWatchPartyMultipleCameras();

    initWatchPartyChannel();
    renderWPStatusBar();

    await loadWatchPartyChatMessages();
    renderWatchPartyChatMessages();

    // Подстраховка на случай проблем с realtime — как у обычного чата.
    // Дополнительно сверяем id последнего сообщения до/после подгрузки: если
    // realtime по каким-то причинам не сработал, а тут "подъехало" новое
    // чужое сообщение — звук всё равно должен прозвучать.
    if (watchPartyChatPollInterval) clearInterval(watchPartyChatPollInterval);
    watchPartyChatPollInterval = setInterval(async () => {
        if (!isWatchPartyScreenOpen || document.hidden) return;

        const prevLastId = watchPartyChatMessages.length
            ? watchPartyChatMessages[watchPartyChatMessages.length - 1].id
            : null;

        await loadWatchPartyChatMessages();

        const newLast = watchPartyChatMessages.length
            ? watchPartyChatMessages[watchPartyChatMessages.length - 1]
            : null;
        if (newLast && newLast.id !== prevLastId && (!currentUser || newLast.user_id !== currentUser.id)) {
            playWatchPartyBellSound();
        }

        renderWatchPartyChatMessages();
    }, 4000);

    // Собственная навигация — как у чата и игр, не трогает историю каталога
    let nav = document.createElement("div");
    nav.className = "navigation";

    let homeBtn = document.createElement("button");
    homeBtn.textContent = "🏠 Домой";
    homeBtn.onclick = () => {
        leaveWatchPartyScreen();
        location.href = "../";
    };
    nav.appendChild(homeBtn);

    let container = document.querySelector(".container");
    if (container) {
        container.insertBefore(nav, container.firstChild);
    } else {
        document.body.insertBefore(nav, app);
    }
}
