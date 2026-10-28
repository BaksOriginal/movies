// ==========================================
// duo.js — ИГРЫ ВДВОЁМ: комната, «Готов», синхронизация партии
// ==========================================
// Подключается на games/index.html после games.js. Один Supabase Realtime
// канал на весь раздел игр:
//   • presence — кто сейчас в разделе, в какой игровой комнате и нажал ли «Готов»;
//   • broadcast "room" — снимок комнаты (настройки, текущая партия, счёт серии);
//   • broadcast "act"  — ход гостя, который хозяин комнаты проверяет и применяет.
// Никаких таблиц в базе: партия лежит в localStorage у обоих, и при встрече
// побеждает более свежая версия — так можно выйти и доиграть потом.
//
// Хозяин комнаты — тот из двоих, у кого id меньше (детерминированно, без
// переговоров). Только он применяет ходы к партии, поэтому рассинхрона нет.
//
// Игра регистрируется через duoRegister({ id, title, emoji, options, newGame,
// applyAction, mount }) — см. durak.js.

const DUO_LEAVE_GRACE_MS = 2500;
const DUO_HEARTBEAT_MS = 4000;      // как часто сверяем версии комнаты с партнёром
const DUO_RECONNECT_MS = 2000;      // пауза перед переподключением канала
const DUO_ACTIVE_ROOM_KEY = "duoActiveRoom";
const DUO_GAMES = {};

const duo = {
    ch: null,
    me: null,
    myName: "",
    partnerKey: null,
    partner: null,          // presence-данные партнёра
    partnerOnline: false,
    leaveTimer: null,
    roomId: null,           // в какой игре я сейчас (null — не в комнате)
    ready: false,
    room: null,             // { version, options, game, gameNo, series }
    synced: false,          // получили ли уже снимок комнаты от партнёра после входа
    connected: false,       // канал Realtime подписан и работает
    reconnectTimer: null,
    view: null,             // активный экран комнаты (см. openDuoRoom)
    listeners: new Set()    // кто хочет знать об изменениях presence (карта игр)
};

function duoRegister(def) { DUO_GAMES[def.id] = def; }

function duoStorageKey(id) { return `duoRoom:${id}:v1`; }

function duoLoadRoom(id) {
    const def = DUO_GAMES[id];
    let room = null;
    try { room = JSON.parse(localStorage.getItem(duoStorageKey(id)) || "null"); } catch (e) {}
    if (!room || typeof room.version !== "number") {
        const options = {};
        (def.options || []).forEach(o => { options[o.key] = o.values[0].v; });
        room = { version: 0, options, game: null, gameNo: 0, series: {} };
    }
    return room;
}
function duoSaveRoom(id, room) {
    try { localStorage.setItem(duoStorageKey(id), JSON.stringify(room)); } catch (e) {}
}

function duoIsHost() { return !!duo.partnerKey && duo.me < duo.partnerKey; }
function duoPartnerHere() { return duo.partnerOnline && duo.partner && duo.partner.room === duo.roomId && !!duo.roomId; }
// Имя партнёра: из presence, а если он не в сети — второе из двух известных имён
function duoPartnerName() {
    if (duo.partner && duo.partner.name) return duo.partner.name;
    return duo.myName === "Myakish" ? "Asmoday" : duo.myName === "Asmoday" ? "Myakish" : "Партнёр";
}
function duoOptsKey(room) { return JSON.stringify(room ? room.options : {}); }

// ---------- Канал ----------
function duoInit() {
    if (duo.ch || !currentUser) return;
    duo.me = currentUser.id;
    duo.myName = getUsernameFromEmail(currentUser.email);

    const channel = db.channel("duo_games", { config: { presence: { key: duo.me }, broadcast: { self: false } } });
    duo.ch = channel;
    channel
        .on("presence", { event: "sync" }, () => duoOnPresence())
        .on("broadcast", { event: "room" }, ({ payload }) => duoOnRoom(payload))
        .on("broadcast", { event: "act" }, ({ payload }) => duoOnAct(payload))
        .on("broadcast", { event: "hello" }, ({ payload }) => duoOnHello(payload))
        .on("broadcast", { event: "ver" }, ({ payload }) => duoOnVer(payload))
        .subscribe((status) => {
            if (duo.ch !== channel) return;
            if (status === "SUBSCRIBED") {
                duo.connected = true;
                duoTrack();
                // После (пере)подключения сразу просим у партнёра свежий снимок
                if (duo.roomId) duoSend("hello", { game: duo.roomId });
                duoChanged();
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                // На мобильном интернете канал рвётся при смене сети и сворачивании
                // браузера — поднимаем его заново, а не остаёмся «не в сети» навсегда
                duo.connected = false;
                duoChanged();
                duoScheduleReconnect();
            }
        });
    duoInstallGlobalHooks();
}

function duoScheduleReconnect() {
    if (duo.reconnectTimer) return;
    duo.reconnectTimer = setTimeout(() => {
        duo.reconnectTimer = null;
        duoReconnect();
    }, DUO_RECONNECT_MS);
}

function duoReconnect() {
    const old = duo.ch;
    duo.ch = null;
    duo.connected = false;
    if (old) { try { db.removeChannel(old); } catch (e) {} }
    duoInit();
}

// Один раз на страницу: возврат во вкладку, появление сети, сверка версий
let duoHooksInstalled = false;
function duoInstallGlobalHooks() {
    if (duoHooksInstalled) return;
    duoHooksInstalled = true;
    document.addEventListener("visibilitychange", () => {
        if (document.hidden || !duo.ch) return;
        if (duo.ch.state && duo.ch.state !== "joined") { duoReconnect(); return; }
        duoTrack();
        if (duo.roomId) duoSend("hello", { game: duo.roomId });
    });
    window.addEventListener("online", () => { if (duo.ch) duoReconnect(); });
    // Сообщения Realtime доставляются «по возможности»: если снимок или ход
    // потерялся, без этой сверки игроки могли навсегда разойтись в состоянии
    setInterval(() => {
        if (!duo.ch || !duo.roomId || !duo.room || !duoPartnerHere()) return;
        duoSend("ver", { game: duo.roomId, version: duo.room.version });
    }, DUO_HEARTBEAT_MS);
}

function duoTrack() {
    if (!duo.ch) return;
    const room = duo.roomId ? duo.room : null;
    duo.ch.track({
        name: duo.myName,
        room: duo.roomId,
        ready: duo.ready,
        optsKey: room ? duoOptsKey(room) : "",
        gameNo: room ? room.gameNo : 0,
        at: Date.now()
    }).catch(() => {});
}

function duoSend(event, payload) {
    if (!duo.ch) return;
    duo.ch.send({ type: "broadcast", event, payload: Object.assign({ from: duo.me }, payload) }).catch(() => {});
}

function duoOnPresence() {
    if (!duo.ch) return;
    const state = duo.ch.presenceState();
    let key = null, data = null;
    for (const k in state) {
        if (k === duo.me || !state[k] || !state[k].length) continue;
        key = k;
        // Партнёр может быть открыт в нескольких вкладках: берём ту, что в
        // моей комнате, иначе — самую свежую
        const entries = state[k].slice().sort((a, b) => (a.at || 0) - (b.at || 0));
        data = entries.filter(e => duo.roomId && e.room === duo.roomId).pop() || entries[entries.length - 1];
    }
    const wasHere = duoPartnerHere();
    if (key) {
        if (duo.leaveTimer) { clearTimeout(duo.leaveTimer); duo.leaveTimer = null; }
        duo.partnerKey = key;
        duo.partner = data;
        duo.partnerOnline = true;
    } else if (duo.partnerOnline && !duo.leaveTimer) {
        // Presence присылает «ушёл» и при коротком обрыве сокета — ждём
        // немного, прежде чем поверить (так же, как в совместном просмотре)
        duo.leaveTimer = setTimeout(() => {
            duo.leaveTimer = null;
            const s = duo.ch ? duo.ch.presenceState() : {};
            if (Object.keys(s).some(k => k !== duo.me && s[k] && s[k].length)) return;
            duo.partnerOnline = false;
            duo.partner = null;
            duoChanged();
        }, DUO_LEAVE_GRACE_MS);
    }
    // Партнёр только что зашёл в мою комнату — обмениваемся снимками
    if (!wasHere && duoPartnerHere()) duoSend("room", { game: duo.roomId, room: duo.room });
    duoMaybeStart();
    duoChanged();
}

function duoChanged() {
    duo.listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
    if (duo.view) duo.view.render();
}

// Снимок комнаты от партнёра: берём, если он новее (при равных версиях
// главнее снимок хозяина)
function duoOnRoom(p) {
    if (!p || p.from === duo.me || p.game !== duo.roomId || !p.room) return;
    const mine = duo.room;
    const theirs = p.room;
    const fromHost = p.from < duo.me;
    const firstSync = !duo.synced;
    duo.synced = true;
    if (theirs.version > mine.version || (theirs.version === mine.version && fromHost && JSON.stringify(theirs) !== JSON.stringify(mine))) {
        duoAdoptRoom(theirs, firstSync);
    } else if (theirs.version < mine.version) {
        // У партнёра старая версия (например, он играл с другого устройства) — отдаём свою
        duoSend("room", { game: duo.roomId, room: duo.room });
    }
    duoMaybeStart();
}

function duoOnHello(p) {
    if (!p || p.from === duo.me || p.game !== duo.roomId || !duo.room) return;
    duoSend("room", { game: duo.roomId, room: duo.room });
}

// Сверка версий: у кого старее — просит снимок, у кого новее — отправляет
function duoOnVer(p) {
    if (!p || p.from === duo.me || p.game !== duo.roomId || !duo.room) return;
    if (p.version > duo.room.version) duoSend("hello", { game: duo.roomId });
    else if (p.version < duo.room.version) duoSend("room", { game: duo.roomId, room: duo.room });
}

function duoAdoptRoom(room, fromSync) {
    const prev = duo.room;
    duo.room = room;
    duoSaveRoom(duo.roomId, room);
    const newGame = room.gameNo !== prev.gameNo && room.game && !room.game.over;
    const optsChanged = duoOptsKey(room) !== duoOptsKey(prev);
    // «Готов» сбрасывается, когда началась партия или кто-то поменял настройки.
    // Первая сверка после входа в комнату (fromSync) готовность не трогает:
    // раньше «Готов», нажатый до прихода снимка от партнёра, тут же слетал.
    if (duo.ready && (newGame || (optsChanged && !fromSync))) duo.ready = false;
    // presence должен знать актуальные настройки и номер партии — по ним
    // хозяин решает, можно ли начинать
    if (newGame || optsChanged || room.gameNo !== prev.gameNo) duoTrack();
    if (duo.view) duo.view.onRoom(prev, room);
    duoChanged();
}

// Хозяин комнаты применяет изменение и рассылает новую версию
function duoCommit(mutate) {
    const next = JSON.parse(JSON.stringify(duo.room));
    if (mutate(next) === false) return false;
    next.version = duo.room.version + 1;
    duoAdoptRoom(next);
    duoSend("room", { game: duo.roomId, room: next });
    return true;
}

// Действие игрока: хозяин применяет сам, гость отправляет хозяину.
// Ход гостя переотправляется, пока не придёт новая версия комнаты: сообщение
// могло потеряться. Дубль уже применённого хода хозяин просто отбросит —
// по правилам он становится невозможным (карты нет в руке, клетка занята…).
let duoPendingAct = null;
function duoAction(action) {
    if (!duo.roomId) return;
    if (!duoPartnerHere()) return;
    if (duoIsHost()) { duoApply(duo.me, action); return; }
    if (duoPendingAct) clearInterval(duoPendingAct.timer);
    const base = duo.room.version, roomId = duo.roomId;
    let tries = 0;
    const send = () => duoSend("act", { game: roomId, action });
    send();
    const entry = {};
    entry.timer = setInterval(() => {
        if (!duo.room || duo.roomId !== roomId || duo.room.version > base || ++tries > 6) {
            clearInterval(entry.timer);
            if (duoPendingAct === entry) duoPendingAct = null;
            return;
        }
        send();
        duoSend("hello", { game: roomId });
    }, 1500);
    duoPendingAct = entry;
}

function duoOnAct(p) {
    if (!p || p.game !== duo.roomId || !duoIsHost() || p.from !== duo.partnerKey) return;
    duoApply(p.from, p.action);
}

function duoApply(actor, action) {
    const def = DUO_GAMES[duo.roomId];
    duoCommit(room => {
        if (action.type === "opt") {
            if (room.game && !room.game.over) return false;
            const opt = (def.options || []).find(o => o.key === action.key);
            if (!opt || !opt.values.some(v => v.v === action.value)) return false;
            room.options[action.key] = action.value;
            return true;
        }
        if (!room.game || room.game.over) return false;
        if (action.type === "surrender") {
            const winner = room.game.players.find(p => p !== actor);
            room.game.over = { winner, loser: actor, reason: "surrender" };
        } else {
            const next = def.applyAction(room.game, actor, action);
            if (!next) return false;
            room.game = next;
        }
        if (room.game.over) {
            const w = room.game.over.winner;
            if (w) room.series[w] = (room.series[w] || 0) + 1;
        }
        return true;
    });
}

// Оба в комнате и оба «Готов» с одинаковыми настройками — хозяин раздаёт
function duoMaybeStart() {
    if (!duo.roomId || !duoIsHost() || !duoPartnerHere() || !duo.ready) return;
    const room = duo.room;
    if (room.game && !room.game.over) return;
    const p = duo.partner;
    if (!p.ready || p.optsKey !== duoOptsKey(room) || p.gameNo !== room.gameNo) return;
    const def = DUO_GAMES[duo.roomId];
    duoCommit(r => {
        r.game = def.newGame([duo.me, duo.partnerKey], r.options);
        r.gameNo++;
        return true;
    });
}

function duoSetReady(v) {
    duo.ready = v;
    duoTrack();
    duoMaybeStart();
    duoChanged();
}

// ---------- Экран комнаты ----------
function openDuoRoom(id) {
    const def = DUO_GAMES[id];
    if (!def) return;
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    duoInit();
    setGamesNav(true);

    duo.roomId = id;
    duo.ready = false;
    duo.synced = false;
    duo.room = duoLoadRoom(id);
    duoTrack();
    duoSend("hello", { game: id });
    // Если мобильный браузер перезагрузит страницу (часто бывает после
    // переключения на другое приложение), вернёмся прямо в эту комнату
    try { sessionStorage.setItem(DUO_ACTIVE_ROOM_KEY, id); } catch (e) {}

    app.innerHTML = "";
    const title = document.createElement("h1");
    setEmojiTitle(title, `${def.emoji} ${def.title}`);
    title.style.marginBottom = "8px";
    app.appendChild(title);

    const root = document.createElement("div");
    root.className = `duo-room duo-room-${id}`;
    root.innerHTML = `
        <div class="duo-players" id="duoPlayers"></div>
        <div class="duo-body" id="duoBody"></div>
    `;
    app.appendChild(root);
    const playersEl = root.querySelector("#duoPlayers");
    const bodyEl = root.querySelector("#duoBody");

    let mode = null;      // "lobby" | "game"
    let gameView = null;  // то, что вернул def.mount()

    function renderPlayers() {
        const room = duo.room;
        const here = duoPartnerHere();
        const pName = duoPartnerName();
        const pKey = duo.partnerKey;
        const playing = room.game && !room.game.over;
        const myScore = room.series[duo.me] || 0;
        const pScore = pKey ? room.series[pKey] || 0 : 0;
        playersEl.innerHTML = `
            <div class="duo-player is-me">
                <span class="duo-avatar">${escapeGameText(duo.myName[0] || "?")}</span>
                <span class="duo-player-body"><span class="duo-player-name"></span><span class="duo-player-sub">Ты${!playing && duo.ready ? " · готов(а)" : ""}</span></span>
            </div>
            <div class="duo-score"><b>${myScore}</b><i>:</i><b>${pScore}</b></div>
            <div class="duo-player is-partner${here ? " is-online" : ""}">
                <span class="duo-player-body"><span class="duo-player-name"></span><span class="duo-player-sub">${!duo.connected ? "соединение…" : here ? (!playing && duo.partner.ready ? "готов(а)" : "в комнате") : !duo.partnerOnline ? "не в сети" : duo.partner && duo.partner.room ? "в другой игре" : "в разделе игр"}</span></span>
                <span class="duo-avatar">${escapeGameText(pName[0] || "?")}<i class="duo-dot"></i></span>
            </div>
            ${playing ? `<button type="button" class="ui-btn duo-menu-btn" id="duoMenuBtn" aria-label="Меню партии">⋯</button>` : ""}
        `;
        playersEl.querySelector(".is-me .duo-player-name").textContent = duo.myName;
        playersEl.querySelector(".is-partner .duo-player-name").textContent = pName;
        const menuBtn = playersEl.querySelector("#duoMenuBtn");
        if (menuBtn) menuBtn.onclick = showMenu;
    }

    function showMenu() {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = `
            <div class="modal-content duo-menu">
                <h3>Партия</h3>
                <p class="duo-menu-text">Партия сохраняется сама — можно выйти и доиграть потом, когда вы оба снова будете здесь.</p>
                <button type="button" class="ui-btn ui-pill duo-menu-danger" id="duoSurrender">🏳️ Сдаться</button>
                <button type="button" class="ui-btn ui-pill" id="duoMenuClose">Продолжить</button>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
        overlay.querySelector("#duoMenuClose").onclick = () => overlay.remove();
        overlay.querySelector("#duoSurrender").onclick = () => {
            overlay.remove();
            if (!duoPartnerHere()) { alert("Сдаться можно, только когда соперник в комнате."); return; }
            duoAction({ type: "surrender" });
        };
    }

    function renderLobby() {
        const room = duo.room;
        const here = duoPartnerHere();
        const pName = duoPartnerName();
        const last = room.game && room.game.over ? room.game.over : null;

        let result = "";
        if (last) {
            const won = last.winner === duo.me;
            const draw = !last.winner;
            const surrendered = last.reason === "surrender";
            const text = draw ? "Ничья!" : won ? (surrendered ? `${pName} сдаётся — победа твоя!` : "Победа!") : surrendered ? "Партия сдана" : (def.loseText || "Поражение");
            result = `<div class="duo-result ${draw ? "is-draw" : won ? "is-win" : "is-lose"}">
                <span class="duo-result-emoji">${draw ? "🤝" : won ? "🏆" : surrendered ? "🏳️" : (def.loseEmoji || "😵")}</span>
                <span class="duo-result-text">${escapeGameText(text)}</span>
            </div>`;
        }

        const optsHtml = (def.options || []).map(o => `
            <div class="duo-opt">
                <div class="duo-opt-label">${o.label}</div>
                <div class="duo-seg" data-key="${o.key}">
                    ${o.values.map(v => `<button type="button" class="ui-btn duo-seg-btn${room.options[o.key] === v.v ? " is-active" : ""}" data-v="${v.v}" ${here ? "" : "disabled"}>
                        <span class="duo-seg-title">${v.label}</span><span class="duo-seg-desc">${v.desc || ""}</span>
                    </button>`).join("")}
                </div>
            </div>
        `).join("");

        const pReady = here && duo.partner.ready && duo.partner.optsKey === duoOptsKey(room);
        let status;
        if (!duo.connected) status = "📡 Подключаемся к серверу…";
        else if (!duo.partnerOnline) status = `💤 ${escapeGameText(pName)} сейчас не в сети. Как только зайдёт в эту игру — можно начинать.`;
        else if (!here) status = `👀 ${escapeGameText(pName)} в разделе игр, но не в этой комнате. Позови!`;
        else if (duo.ready && pReady) status = "Раздаём…";
        else if (duo.ready) status = `Ждём, пока ${escapeGameText(pName)} нажмёт «Готов»`;
        else if (pReady) status = `${escapeGameText(pName)} уже готов(а) — дело за тобой!`;
        else status = "Оба в комнате. Нажмите «Готов», чтобы начать.";

        bodyEl.innerHTML = `
            <div class="duo-lobby">
                ${result}
                <div class="duo-lobby-art">${def.lobbyArt || ""}</div>
                ${optsHtml}
                <div class="duo-ready-row">
                    <div class="duo-ready-chip${duo.ready ? " is-on" : ""}"><span>${escapeGameText(duo.myName)}</span><b>${duo.ready ? "✓ Готов" : "…"}</b></div>
                    <div class="duo-ready-chip${pReady ? " is-on" : ""}${here ? "" : " is-off"}"><span>${escapeGameText(pName)}</span><b>${pReady ? "✓ Готов" : here ? "…" : "нет"}</b></div>
                </div>
                <button type="button" class="ui-btn duo-ready-btn${duo.ready ? " is-on" : ""}" id="duoReadyBtn">${duo.ready ? "Отменить готовность" : last ? "🔁 Готов к реваншу" : "✋ Готов"}</button>
                <p class="duo-status">${status}</p>
            </div>
        `;
        bodyEl.querySelectorAll(".duo-seg").forEach(seg => {
            seg.addEventListener("click", e => {
                const btn = e.target.closest(".duo-seg-btn");
                if (!btn || btn.classList.contains("is-active")) return;
                duoAction({ type: "opt", key: seg.dataset.key, value: btn.dataset.v });
            });
        });
        bodyEl.querySelector("#duoReadyBtn").onclick = () => { vibrate(10); duoSetReady(!duo.ready); };
    }

    // Во время партии страница не скроллится: комната ровно по высоте окна
    function fitRoom() {
        if (!root.isConnected) return;
        if (!document.body.classList.contains("duo-playing")) { root.style.height = ""; return; }
        window.scrollTo(0, 0);
        const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        root.style.height = Math.max(420, vh - root.getBoundingClientRect().top - 12) + "px";
    }
    function setPlaying(v) {
        if (document.body.classList.contains("duo-playing") === v) return;
        document.body.classList.toggle("duo-playing", v);
        document.documentElement.classList.toggle("duo-playing", v);
        fitRoom();
    }
    window.addEventListener("resize", fitRoom);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", fitRoom);

    function render() {
        if (!root.isConnected) return;
        renderPlayers();
        const playing = duo.room.game && !duo.room.game.over;
        setPlaying(!!playing || mode === "game" || mode === "ending");
        if (playing) {
            if (mode !== "game") {
                if (gameView && gameView.destroy) gameView.destroy();
                mode = "game";
                bodyEl.innerHTML = "";
                gameView = def.mount(bodyEl, { me: duo.me, act: duoAction, partnerName: duoPartnerName });
            }
            gameView.update(duo.room.game, { partnerHere: duoPartnerHere() });
        } else {
            if (mode === "game" && gameView) {
                // Партия только что закончилась — даём досмотреть последний ход
                const finished = duo.room.game;
                mode = "ending";
                gameView.update(finished, { partnerHere: true });
                setTimeout(() => { if (mode === "ending") { gameView && gameView.destroy && gameView.destroy(); gameView = null; mode = "lobby"; render(); } }, 1600);
                return;
            }
            if (mode === "ending") return;
            mode = "lobby";
            renderLobby();
        }
    }

    duo.view = {
        render,
        onRoom() {}
    };

    activeGameCleanup = () => {
        try { sessionStorage.removeItem(DUO_ACTIVE_ROOM_KEY); } catch (e) {}
        setPlaying(false);
        window.removeEventListener("resize", fitRoom);
        if (window.visualViewport) window.visualViewport.removeEventListener("resize", fitRoom);
        if (gameView && gameView.destroy) gameView.destroy();
        duo.view = null;
        duo.roomId = null;
        duo.ready = false;
        duo.room = null;
        duoTrack();
    };

    render();
}

// ---------- Блок «Вдвоём» на карте игр ----------
function buildDuoSection() {
    duoInit();
    const section = document.createElement("section");
    section.className = "duo-section";
    section.innerHTML = `
        <div class="duo-section-head">
            <h2 class="duo-section-title">Вдвоём</h2>
            <span class="duo-section-presence" id="duoPresence"></span>
        </div>
        <div class="duo-cards" id="duoCards"></div>
    `;
    const cards = section.querySelector("#duoCards");

    function render() {
        if (!section.isConnected && section.parentNode) return;
        const pName = duoPartnerName();
        const pres = section.querySelector("#duoPresence");
        if (!duo.partnerOnline) pres.innerHTML = `<i class="duo-dot"></i>${escapeGameText(pName)} не в играх`;
        else {
            const where = duo.partner && duo.partner.room && DUO_GAMES[duo.partner.room];
            pres.innerHTML = `<i class="duo-dot is-on"></i>${escapeGameText(pName)} ${where ? `ждёт в «${where.title}»` : "в разделе игр"}`;
        }
        pres.classList.toggle("is-on", duo.partnerOnline);

        cards.innerHTML = "";
        Object.values(DUO_GAMES).forEach(def => {
            const room = duoLoadRoom(def.id);
            const waiting = duo.partnerOnline && duo.partner && duo.partner.room === def.id;
            const playing = room.game && !room.game.over;
            const card = document.createElement("button");
            card.type = "button";
            card.className = `ui-btn duo-card${waiting ? " is-waiting" : ""}`;
            card.style.setProperty("--h", def.hue || 300);
            card.innerHTML = `
                <span class="duo-card-emoji">${def.emoji}</span>
                <span class="duo-card-body">
                    <span class="duo-card-title">${def.title}</span>
                    <span class="duo-card-sub">${waiting ? `${escapeGameText(pName)} уже за столом` : playing ? "Есть незаконченная партия" : def.short || ""}</span>
                </span>
                ${waiting ? `<span class="duo-card-badge">Ждёт</span>` : ""}
            `;
            card.onclick = () => openDuoRoom(def.id);
            cards.appendChild(card);
        });
    }
    const listener = () => { if (!section.isConnected) { duo.listeners.delete(listener); return; } render(); };
    duo.listeners.add(listener);
    render();
    return section;
}
