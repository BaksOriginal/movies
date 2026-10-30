// ==========================================
// board.js — ДОСКА С ЗАМЕТКАМИ НА ДВОИХ
// ==========================================
// Подключается на board/index.html после core.js и shell.js. Пробковая доска
// фиксированного размера, заметки приклеиваются в любое её место и видны
// обоим. Два вида заметок: обычная (текст, ссылки кликабельны) и счётчик
// серий (название, сезон, серия, кнопки «+»).
//
// Каждая заметка — строка таблицы board_notes, всё содержимое лежит в data
// (jsonb): новые виды заметок не потребуют менять таблицу. При одновременной
// правке одной заметки побеждает последняя запись.
//
// Красная нить соединяет кнопки двух заметок. Она хранится у заметки, от
// которой её протянули (data.links — id других заметок); если любой из двух
// заметок больше нет, нить просто не рисуется.
//
// Канал Supabase Realtime "notes_board": presence — кто на доске;
// note — заметка изменилась; move — её тащат прямо сейчас; del — удалена.
// Сообщения доставляются «по возможности», поэтому список ещё и сверяется
// с базой при возврате на вкладку и раз в 30 секунд.

const BD_W = 1400;
const BD_H = 1000;
const BD_ZOOM_KEY = "boardZoom:v1";
const BD_SYNC_MS = 30000;
const BD_MOVE_MS = 70;
const BD_RETRY_MS = 5000;
const BD_TEXT_MAX = 2000;
const BD_LINKS_MAX = 30;
const BD_PIN_TOP = 2;   // центр кнопки ниже верхнего края заметки, px
const BD_COLORS = {
    yellow: { label: "Жёлтая", bg: "#ffe873" },
    orange: { label: "Оранжевая", bg: "#ffc27a" },
    pink: { label: "Розовая", bg: "#ffb3d1" },
    purple: { label: "Сиреневая", bg: "#d9c2ff" },
    blue: { label: "Голубая", bg: "#aee2ff" },
    green: { label: "Зелёная", bg: "#c3f09a" },
    white: { label: "Белая", bg: "#fbf7ea" },
};
const BD_SIZES = {
    s: { label: "Маленькая", w: 190 },
    m: { label: "Средняя", w: 250 },
    l: { label: "Большая", w: 340 },
};
const BD_EDGES = {
    plain: "Прямые",
    round: "Скруглённые",
    torn: "Рваный низ",
    corner: "Срезанный угол",
    wave: "Зубчатые",
};

const bd = {
    ch: null,
    me: null,
    myName: "",
    connected: false,
    partnerName: null,
    notes: new Map(),   // id → { id, data, updated_at }
    els: new Map(),     // id → элемент заметки
    unsaved: new Set(), // id заметок, ещё не дошедших до базы
    dragId: null,
    zoom: 1,
    ui: null,
    syncTimer: null,
    retryTimer: null,
    reconnectTimer: null,
    hooksInstalled: false,
    missingTable: false,
};

function bdEsc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// Текст заметки в HTML: всё экранировано, ссылки кликабельны
function bdLinkify(text) {
    const re = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
    let out = "", last = 0, m;
    const src = String(text || "");
    while ((m = re.exec(src))) {
        // Точка или скобка в конце — обычно знак препинания, а не часть адреса
        const raw = m[0].replace(/[.,;:!?)\]»"']+$/, "");
        out += bdEsc(src.slice(last, m.index));
        const href = /^https?:/i.test(raw) ? raw : "https://" + raw;
        out += `<a class="bd-link" href="${bdEsc(href)}" target="_blank" rel="noopener noreferrer">${bdEsc(raw)}</a>`;
        last = m.index + raw.length;
    }
    return out + bdEsc(src.slice(last));
}

// Небольшой наклон у каждой заметки свой и одинаковый у обоих
function bdTilt(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return (Math.abs(h) % 50) / 10 - 2.5;
}

// Угол заметки: заданный вручную, а пока его нет — её случайный наклон
function bdAngle(id, data) {
    return data.rot == null ? (id ? bdTilt(id) : 0) : data.rot;
}

// Угол в пределах -180…180
function bdWrapAngle(a) {
    return ((((a + 180) % 360) + 360) % 360) - 180;
}

function bdClampInt(v, min, fallback) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= min ? Math.min(n, 9999) : fallback;
}

// Данные заметки приводим к допустимым: они могли прийти от другой версии сайта
function bdNormalize(data) {
    const d = data && typeof data === "object" ? data : {};
    return {
        kind: d.kind === "counter" ? "counter" : "text",
        text: String(d.text || "").slice(0, BD_TEXT_MAX),
        season: bdClampInt(d.season, 1, 1),
        episode: bdClampInt(d.episode, 1, 1),
        x: Number.isFinite(+d.x) ? +d.x : 40,
        y: Number.isFinite(+d.y) ? +d.y : 40,
        z: Number.isFinite(+d.z) ? +d.z : 1,
        rot: d.rot != null && Number.isFinite(+d.rot) ? bdWrapAngle(+d.rot) : null,
        color: BD_COLORS[d.color] ? d.color : "yellow",
        size: BD_SIZES[d.size] ? d.size : "m",
        edge: BD_EDGES[d.edge] ? d.edge : "plain",
        by: String(d.by || ""),
        links: Array.isArray(d.links) ? Array.from(new Set(d.links.filter(x => typeof x === "string"))).slice(0, BD_LINKS_MAX) : [],
    };
}

// ---------- База ----------
async function bdFetch() {
    const { data, error } = await db.from("board_notes").select("id, data, updated_at");
    if (error) throw error;
    return data || [];
}

async function bdPersist(note) {
    bd.unsaved.add(note.id);
    const stamp = note.updated_at;
    const { error } = await db.from("board_notes").upsert([{ id: note.id, data: note.data, updated_at: stamp }]);
    if (error) {
        console.warn("board save", error);
        bdRenderStatus();
        clearTimeout(bd.retryTimer);
        bd.retryTimer = setTimeout(bdRetryUnsaved, BD_RETRY_MS);
        return false;
    }
    // Пока ответ шёл, заметку могли изменить снова — тогда она ещё не сохранена
    const cur = bd.notes.get(note.id);
    if (!cur || cur.updated_at === stamp) bd.unsaved.delete(note.id);
    bdRenderStatus();
    return true;
}

function bdRetryUnsaved() {
    bd.unsaved.forEach((id) => {
        const note = bd.notes.get(id);
        if (note) bdPersist(note); else bd.unsaved.delete(id);
    });
}

// Сверка с базой. Заметки, которые мы сами ещё не сохранили или тащим, не трогаем.
async function bdSync() {
    let rows;
    try {
        rows = await bdFetch();
    } catch (e) {
        console.warn("board load", e);
        // 42P01 / PGRST205 — таблицы ещё нет
        if (e && (e.code === "42P01" || e.code === "PGRST205")) bd.missingTable = true;
        bdRenderStatus();
        return false;
    }
    bd.missingTable = false;
    const seen = new Set();
    rows.forEach((row) => {
        seen.add(row.id);
        if (bd.unsaved.has(row.id) || bd.dragId === row.id) return;
        const cur = bd.notes.get(row.id);
        if (cur && cur.updated_at >= row.updated_at) return;
        bdApplyNote({ id: row.id, data: bdNormalize(row.data), updated_at: row.updated_at });
    });
    Array.from(bd.notes.keys()).forEach((id) => {
        if (!seen.has(id) && !bd.unsaved.has(id)) bdRemoveNote(id);
    });
    bdRenderStatus();
    return true;
}

// ---------- Канал ----------
function bdInitChannel() {
    if (bd.ch || !currentUser) return;
    bd.me = currentUser.id;
    bd.myName = getUsernameFromEmail(currentUser.email);
    const channel = db.channel("notes_board", { config: { presence: { key: bd.me }, broadcast: { self: false } } });
    bd.ch = channel;
    const on = (event, fn) => channel.on("broadcast", { event }, ({ payload }) => { if (payload) fn(payload); });
    channel.on("presence", { event: "sync" }, () => bdOnPresence());
    on("note", bdOnNote);
    on("move", bdOnMove);
    on("del", (p) => { if (p.id && !bd.unsaved.has(p.id)) bdRemoveNote(p.id); });
    channel.subscribe((status) => {
        if (bd.ch !== channel) return;
        if (status === "SUBSCRIBED") {
            bd.connected = true;
            try {
                const r = channel.track({ name: bd.myName });
                if (r && r.catch) r.catch(() => {});
            } catch (e) {}
            bdSync();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            bd.connected = false;
            if (!bd.reconnectTimer) bd.reconnectTimer = setTimeout(() => {
                bd.reconnectTimer = null;
                const old = bd.ch;
                bd.ch = null;
                if (old) { try { db.removeChannel(old); } catch (e) {} }
                bdInitChannel();
            }, 2000);
        }
        bdRenderStatus();
    });
    if (!bd.hooksInstalled) {
        bd.hooksInstalled = true;
        document.addEventListener("visibilitychange", () => { if (!document.hidden) bdSync(); });
        window.addEventListener("online", () => { bdRetryUnsaved(); bdSync(); });
        bd.syncTimer = setInterval(() => { if (!document.hidden) bdSync(); }, BD_SYNC_MS);
    }
}

function bdSend(event, payload) {
    if (!bd.ch || !bd.connected) return;
    try {
        const r = bd.ch.send({ type: "broadcast", event, payload });
        if (r && r.catch) r.catch(() => {});
    } catch (e) {}
}

function bdOnPresence() {
    const state = bd.ch ? bd.ch.presenceState() : {};
    const other = Object.keys(state).find(k => k !== bd.me);
    const metas = other ? state[other] : null;
    bd.partnerName = metas && metas.length ? metas[metas.length - 1].name || "Партнёр" : null;
    bdRenderStatus();
}

function bdOnNote(p) {
    if (!p.id || bd.dragId === p.id) return;
    const cur = bd.notes.get(p.id);
    if (cur && p.updated_at && cur.updated_at > p.updated_at) return;
    bdApplyNote({ id: p.id, data: bdNormalize(p.data), updated_at: p.updated_at });
}

function bdOnMove(p) {
    const note = bd.notes.get(p.id);
    if (!note || bd.dragId === p.id) return;
    note.data.x = +p.x; note.data.y = +p.y;
    if (Number.isFinite(+p.z)) note.data.z = +p.z;
    if (p.rot != null && Number.isFinite(+p.rot)) note.data.rot = bdWrapAngle(+p.rot);
    bdPlaceEl(note);
}

// ---------- Заметки: данные и отрисовка ----------
function bdApplyNote(note) {
    bd.notes.set(note.id, note);
    bdRenderNote(note);
    bdRenderEmpty();
}

function bdRemoveNote(id) {
    bd.notes.delete(id);
    const el = bd.els.get(id);
    if (el) el.remove();
    bd.els.delete(id);
    bdScheduleThreads();
    bdRenderEmpty();
}

// Изменить заметку у себя, сообщить второму и записать в базу
function bdCommit(id, data) {
    const note = { id, data, updated_at: new Date().toISOString() };
    bdApplyNote(note);
    bdSend("note", { id, data, updated_at: note.updated_at });
    return bdPersist(note);
}

function bdPlaceEl(note) {
    const el = bd.els.get(note.id);
    if (!el) return;
    el.style.transform = `translate(${note.data.x}px, ${note.data.y}px) rotate(${bdAngle(note.id, note.data)}deg)`;
    el.style.zIndex = note.data.z;
    bdScheduleThreads();
}

// ---------- Красная нить ----------
// Кнопка закреплена у верхнего края, так что с учётом поворота её место
// считаем от центра заметки
function bdPinPoint(note) {
    const el = bd.els.get(note.id);
    if (!el) return null;
    const w = el.offsetWidth, h = el.offsetHeight;
    const a = bdAngle(note.id, note.data) * Math.PI / 180;
    const dy = BD_PIN_TOP - h / 2;
    return { x: note.data.x + w / 2 - dy * Math.sin(a), y: note.data.y + h / 2 + dy * Math.cos(a) };
}

// Нить слегка провисает: квадратичная кривая с серединой ниже прямой
function bdThreadPath(a, b) {
    const sag = Math.min(46, Math.hypot(b.x - a.x, b.y - a.y) * 0.09);
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 + sag };
}

function bdThreadSvg(a, b) {
    const c = bdThreadPath(a, b);
    return `M${a.x} ${a.y}Q${c.cx} ${c.cy} ${b.x} ${b.y}`;
}

// Область нажатия — без концов нити, иначе она закрывала бы сами кнопки
function bdThreadHit(a, b) {
    const c = bdThreadPath(a, b);
    let d = "";
    for (let i = 0; i <= 12; i++) {
        const t = 0.12 + (i / 12) * 0.76, u = 1 - t;
        const x = u * u * a.x + 2 * u * t * c.cx + t * t * b.x;
        const y = u * u * a.y + 2 * u * t * c.cy + t * t * b.y;
        d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
}

let bdThreadsRaf = 0;
function bdScheduleThreads() {
    if (bdThreadsRaf) return;
    bdThreadsRaf = requestAnimationFrame(() => { bdThreadsRaf = 0; bdRenderThreads(); });
}

function bdRenderThreads() {
    if (!bd.ui) return;
    let shadow = "", line = "", knots = "", hits = "";
    const knot = (p) => `<circle cx="${p.x}" cy="${p.y}" r="3.2"/>`;
    const seen = new Set();
    bd.notes.forEach((note) => {
        const a = bdPinPoint(note);
        if (!a) return;
        note.data.links.forEach((otherId) => {
            const other = bd.notes.get(otherId);
            const pair = [note.id, otherId].sort().join("|");
            if (!other || otherId === note.id || seen.has(pair)) return;
            const b = bdPinPoint(other);
            if (!b) return;
            seen.add(pair);
            const d = bdThreadSvg(a, b);
            shadow += `<path d="${d}"/>`;
            line += `<path d="${d}"/>`;
            knots += knot(a) + knot(b);
            hits += `<path d="${bdThreadHit(a, b)}" data-from="${bdEsc(note.id)}" data-to="${bdEsc(otherId)}"/>`;
        });
    });
    bd.ui.threads.innerHTML = `
        <g class="bd-thread-shadow" transform="translate(1 4)">${shadow}</g>
        <g class="bd-thread-line">${line}</g>
        <g class="bd-thread-knot">${knots}</g>
        <g class="bd-thread-hit">${hits}</g>
        <path class="bd-thread-live" id="bdThreadLive"/>
    `;
}

// Подсказка на пару секунд вместо строки состояния
let bdHintTimer = 0;
function bdHint(text) {
    if (!bd.ui) return;
    clearTimeout(bdHintTimer);
    bd.ui.status.className = "bd-status is-wait";
    bd.ui.status.textContent = text;
    bdHintTimer = setTimeout(() => { bdHintTimer = 0; bdRenderStatus(); }, 3500);
}

function bdLinked(a, b) {
    return a.data.links.includes(b.id) || b.data.links.includes(a.id);
}

function bdAddThread(from, to) {
    if (bdLinked(from, to)) { bdHint("Эти заметки уже соединены"); return; }
    const links = from.data.links.filter(id => bd.notes.has(id));
    if (links.length >= BD_LINKS_MAX) { bdHint("У этой заметки слишком много нитей"); return; }
    vibrate(10);
    thingSound("pin");
    bdCommit(from.id, Object.assign({}, from.data, { links: [...links, to.id] }));
}

function bdRemoveThread(fromId, toId) {
    const from = bd.notes.get(fromId);
    if (!from) return;
    bdCommit(fromId, Object.assign({}, from.data, { links: from.data.links.filter(id => id !== toId) }));
}

function bdRenderNote(note) {
    if (!bd.ui) return;
    const d = note.data;
    let el = bd.els.get(note.id);
    if (!el) {
        el = document.createElement("article");
        el.dataset.id = note.id;
        bd.els.set(note.id, el);
        bd.ui.board.appendChild(el);
    }
    el.className = `bd-note is-${d.kind} edge-${d.edge}`;
    el.style.setProperty("--note-bg", BD_COLORS[d.color].bg);
    el.style.width = BD_SIZES[d.size].w + "px";
    const author = d.by ? `<span class="bd-note-ava" title="${bdEsc(d.by)}">${userAvatarHtml(d.by)}</span>` : "";
    if (d.kind === "counter") {
        el.innerHTML = `
            <span class="bd-pin"></span>
            <button type="button" class="ui-btn bd-rotate" aria-label="Повернуть заметку" title="Потяни, чтобы повернуть">↻</button>
            <div class="bd-paper">
                <div class="bd-note-title">${bdLinkify(d.text) || "Без названия"}</div>
                <div class="bd-counter">
                    <div class="bd-count"><small>Сезон</small><b>${d.season}</b></div>
                    <div class="bd-count"><small>Серия</small><b>${d.episode}</b></div>
                </div>
                <div class="bd-counter-actions">
                    <button type="button" class="ui-btn bd-plus" data-act="season" title="Следующий сезон, серия станет 1">+ сезон</button>
                    <button type="button" class="ui-btn bd-plus is-main" data-act="episode" title="Следующая серия">+ серия</button>
                    <button type="button" class="ui-btn bd-minus" data-act="back" title="Вернуть серию назад" aria-label="Вернуть серию назад" ${d.episode <= 1 ? "disabled" : ""}>−</button>
                </div>
                ${author}
            </div>
        `;
    } else {
        el.innerHTML = `
            <span class="bd-pin"></span>
            <button type="button" class="ui-btn bd-rotate" aria-label="Повернуть заметку" title="Потяни, чтобы повернуть">↻</button>
            <div class="bd-paper">
                <div class="bd-note-text">${bdLinkify(d.text) || '<span class="bd-note-empty">Пустая заметка</span>'}</div>
                ${author}
            </div>
        `;
    }
    bdPlaceEl(note);
}

function bdRenderEmpty() {
    if (bd.ui) bd.ui.empty.hidden = bd.notes.size > 0 || bd.missingTable;
}

function bdRenderStatus() {
    if (!bd.ui) return;
    const el = bd.ui.status;
    let text, cls = "";
    if (bdHintTimer) return;
    if (bd.missingTable) { text = "Таблица заметок ещё не создана"; cls = "is-bad"; }
    else if (bd.unsaved.size) { text = "Сохраняю…"; cls = "is-wait"; }
    else if (!bd.connected) { text = "Нет связи"; cls = "is-bad"; }
    else if (bd.partnerName) { text = `${bd.partnerName} на доске`; cls = "is-on"; }
    else text = "Сохранено";
    el.className = "bd-status " + cls;
    el.textContent = text;
}

function bdMaxZ() {
    let z = 0;
    bd.notes.forEach(n => { if (n.data.z > z) z = n.data.z; });
    return z;
}

// ---------- Экран ----------
function showBoardScreen() {
    bdInitChannel();
    setShellSection("board");
    try {
        const z = parseFloat(localStorage.getItem(BD_ZOOM_KEY));
        bd.zoom = z >= 0.4 && z <= 1.6 ? z : 0;
    } catch (e) { bd.zoom = 0; }

    document.documentElement.classList.add("bd-page");
    document.body.classList.add("bd-page");
    app.innerHTML = `
        <div class="bd-screen">
            <div class="bd-bar">
                <button type="button" class="ui-btn ui-pill ui-pill-accent" id="bdNewText">+ Заметка</button>
                <button type="button" class="ui-btn ui-pill" id="bdNewCounter">+ Счётчик серий</button>
                <span class="bd-status" id="bdStatus"></span>
                <span class="bd-zoom">
                    <button type="button" class="ui-btn bd-zoom-btn" id="bdZoomOut" aria-label="Уменьшить">−</button>
                    <button type="button" class="ui-btn bd-zoom-btn" id="bdZoomIn" aria-label="Увеличить">+</button>
                </span>
            </div>
            <div class="bd-scroll" id="bdScroll">
                <div class="bd-sizer" id="bdSizer">
                    <div class="bd-board" id="bdBoard" style="width:${BD_W}px;height:${BD_H}px">
                        <svg class="bd-threads" id="bdThreads" viewBox="0 0 ${BD_W} ${BD_H}" aria-hidden="true"></svg>
                        <div class="bd-empty" id="bdEmpty" hidden>Доска пока пустая.<br>Добавьте первую заметку кнопкой сверху.</div>
                    </div>
                </div>
            </div>
        </div>
    `;
    const root = app.querySelector(".bd-screen");
    bd.ui = {
        root,
        board: root.querySelector("#bdBoard"),
        scroll: root.querySelector("#bdScroll"),
        sizer: root.querySelector("#bdSizer"),
        status: root.querySelector("#bdStatus"),
        empty: root.querySelector("#bdEmpty"),
        threads: root.querySelector("#bdThreads"),
    };
    bd.els.clear();

    const fit = () => {
        if (!root.isConnected) return;
        window.scrollTo(0, 0);
        const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        // На телефоне снизу ещё панель вкладок
        const tabbar = document.querySelector(".shell-tabbar");
        const below = tabbar ? tabbar.offsetHeight : 0;
        root.style.height = Math.max(320, vh - root.getBoundingClientRect().top - below - 12) + "px";
        bdApplyZoom();
    };
    window.addEventListener("resize", fit);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", fit);
    fit();

    root.querySelector("#bdNewText").onclick = () => bdCreate("text");
    root.querySelector("#bdNewCounter").onclick = () => bdCreate("counter");
    root.querySelector("#bdZoomIn").onclick = () => bdSetZoom(bdCurrentZoom() * 1.2);
    root.querySelector("#bdZoomOut").onclick = () => bdSetZoom(bdCurrentZoom() / 1.2);
    bdBindBoard();

    bd.notes.forEach(bdRenderNote);
    bdRenderStatus();
    // Рукописный шрифт меняет высоту заметок, а с ней и место кнопок после поворота
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(bdScheduleThreads);
    bdSync().then(() => { bdRenderEmpty(); bdScrollToNotes(); });
}

// Доска шире экрана телефона — сразу показываем заметки, а не пустой угол
function bdScrollToNotes() {
    if (!bd.ui || !bd.notes.size) return;
    const z = bdCurrentZoom();
    const sc = bd.ui.scroll;
    let first = null;
    bd.notes.forEach((n) => { if (!first || n.data.x + n.data.y < first.x + first.y) first = n.data; });
    sc.scrollLeft = Math.max(0, first.x * z - 16);
    sc.scrollTop = Math.max(0, first.y * z - 16);
}

// Масштаб по умолчанию: вся ширина доски, но не мельче, чем можно прочитать
function bdDefaultZoom() {
    const w = bd.ui.scroll.clientWidth || BD_W;
    return Math.max(0.72, Math.min(1, w / BD_W));
}
function bdCurrentZoom() { return bd.zoom || bdDefaultZoom(); }

function bdSetZoom(z) {
    bd.zoom = Math.max(0.4, Math.min(1.6, z));
    try { localStorage.setItem(BD_ZOOM_KEY, String(bd.zoom)); } catch (e) {}
    bdApplyZoom();
}

function bdApplyZoom() {
    if (!bd.ui) return;
    const z = bdCurrentZoom();
    bd.ui.board.style.transform = `scale(${z})`;
    bd.ui.sizer.style.width = BD_W * z + "px";
    bd.ui.sizer.style.height = BD_H * z + "px";
}

// ---------- Жесты на доске ----------
function bdBindBoard() {
    const board = bd.ui.board;
    let drag = null;
    let turn = null;    // поворот за ручку: { id, pid, cx, cy, start, startRot }
    let thread = null;  // тянем нить: { from, pid, sx, sy, moved, target }
    const boardPoint = (e) => {
        const r = board.getBoundingClientRect(), z = bdCurrentZoom();
        return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
    };
    // Заметка под пальцем; нить в этот момент нажатия не перехватывает (см. is-threading)
    const noteAt = (e) => {
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const el = hit && hit.closest ? hit.closest(".bd-note") : null;
        return el ? bd.notes.get(el.dataset.id) || null : null;
    };
    const setThreadTarget = (note) => {
        if (thread.target === note) return;
        if (thread.target) { const old = bd.els.get(thread.target.id); if (old) old.classList.remove("is-thread-target"); }
        thread.target = note;
        if (note) { const el = bd.els.get(note.id); if (el) el.classList.add("is-thread-target"); }
    };
    let lastMoveAt = 0;
    const pointerAngle = (e) => Math.atan2(e.clientY - turn.cy, e.clientX - turn.cx) * 180 / Math.PI;

    board.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        const pin = e.target.closest(".bd-pin");
        if (pin && !drag && !turn && !thread) {
            const note = bd.notes.get(pin.closest(".bd-note").dataset.id);
            if (!note) return;
            e.preventDefault();
            thread = { from: note, pid: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, target: null };
            board.classList.add("is-threading");
            try { board.setPointerCapture(e.pointerId); } catch (err) {}
            return;
        }
        const handle = e.target.closest(".bd-rotate");
        if (handle && !drag && !turn) {
            const el = handle.closest(".bd-note");
            const note = bd.notes.get(el.dataset.id);
            if (!note) return;
            e.preventDefault();
            // Вокруг центра заметки: он не зависит от её текущего угла
            const r = el.getBoundingClientRect();
            turn = { id: note.id, pid: e.pointerId, el, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
            turn.start = pointerAngle(e);
            turn.startRot = bdAngle(note.id, note.data);
            bd.dragId = note.id;
            el.classList.add("is-dragging");
            note.data.z = bdMaxZ() + 1;
            bdPlaceEl(note);
            try { board.setPointerCapture(e.pointerId); } catch (err) {}
            return;
        }
        if (e.target.closest("a, button")) return;
        const el = e.target.closest(".bd-note");
        if (!el || drag) return;
        const note = bd.notes.get(el.dataset.id);
        if (!note) return;
        const z = bdCurrentZoom();
        const r = board.getBoundingClientRect();
        drag = {
            id: note.id,
            pid: e.pointerId,
            el,
            sx: e.clientX,
            sy: e.clientY,
            ox: (e.clientX - r.left) / z - note.data.x,
            oy: (e.clientY - r.top) / z - note.data.y,
            moved: false,
        };
        try { board.setPointerCapture(e.pointerId); } catch (err) {}
    });

    board.addEventListener("pointermove", (e) => {
        if (thread && e.pointerId === thread.pid) {
            if (!thread.moved && Math.hypot(e.clientX - thread.sx, e.clientY - thread.sy) < 6) return;
            thread.moved = true;
            const a = bdPinPoint(thread.from);
            const live = document.getElementById("bdThreadLive");
            if (a && live) live.setAttribute("d", bdThreadSvg(a, boardPoint(e)));
            const over = noteAt(e);
            setThreadTarget(over && over.id !== thread.from.id ? over : null);
            return;
        }
        if (turn && e.pointerId === turn.pid) {
            const note = bd.notes.get(turn.id);
            if (!note) return;
            let rot = Math.round(bdWrapAngle(turn.startRot + pointerAngle(e) - turn.start));
            if (Math.abs(rot) <= 3) rot = 0;    // легко поставить ровно
            note.data.rot = rot;
            bdPlaceEl(note);
            const now = performance.now();
            if (now - lastMoveAt > BD_MOVE_MS) {
                lastMoveAt = now;
                bdSend("move", { id: note.id, x: note.data.x, y: note.data.y, z: note.data.z, rot });
            }
            return;
        }
        if (!drag || e.pointerId !== drag.pid) return;
        if (!drag.moved) {
            if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
            drag.moved = true;
            bd.dragId = drag.id;
            drag.el.classList.add("is-dragging");
            // Взятая заметка всегда оказывается поверх остальных
            const note = bd.notes.get(drag.id);
            if (note) { note.data.z = bdMaxZ() + 1; bdPlaceEl(note); }
        }
        const note = bd.notes.get(drag.id);
        if (!note) return;
        const z = bdCurrentZoom();
        const r = board.getBoundingClientRect();
        note.data.x = Math.round(Math.max(0, Math.min(BD_W - drag.el.offsetWidth, (e.clientX - r.left) / z - drag.ox)));
        note.data.y = Math.round(Math.max(0, Math.min(BD_H - drag.el.offsetHeight, (e.clientY - r.top) / z - drag.oy)));
        bdPlaceEl(note);
        const now = performance.now();
        if (now - lastMoveAt > BD_MOVE_MS) {
            lastMoveAt = now;
            bdSend("move", { id: note.id, x: note.data.x, y: note.data.y, z: note.data.z });
        }
    });

    const end = (e) => {
        if (thread && e.pointerId === thread.pid) {
            const t = thread, target = t.target;
            setThreadTarget(null);
            thread = null;
            board.classList.remove("is-threading");
            const live = document.getElementById("bdThreadLive");
            if (live) live.removeAttribute("d");
            if (e.type !== "pointerup") return;
            if (target) bdAddThread(t.from, target);
            else bdHint(t.moved ? "Отпусти нить на другой заметке" : "Потяни от кнопки к другой заметке, чтобы соединить их нитью");
            return;
        }
        if (turn && e.pointerId === turn.pid) {
            const t = turn;
            turn = null;
            bd.dragId = null;
            t.el.classList.remove("is-dragging");
            const note = bd.notes.get(t.id);
            if (note) bdCommit(note.id, note.data);
            return;
        }
        if (!drag || e.pointerId !== drag.pid) return;
        const d = drag;
        drag = null;
        d.el.classList.remove("is-dragging");
        const note = bd.notes.get(d.id);
        if (!d.moved) {
            // Просто нажали — открыть редактор
            if (note && e.type === "pointerup") bdOpenEditor(note);
            return;
        }
        bd.dragId = null;
        if (note) { thingSound("paper"); bdCommit(note.id, note.data); }
    };
    board.addEventListener("pointerup", end);
    board.addEventListener("pointercancel", end);

    // Кнопки счётчика
    board.addEventListener("click", async (e) => {
        const hit = e.target.closest("[data-from]");
        if (hit) {
            if (await siteConfirm("Убрать эту нить?", "Убрать")) bdRemoveThread(hit.dataset.from, hit.dataset.to);
            return;
        }
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        const note = bd.notes.get(btn.closest(".bd-note").dataset.id);
        if (!note) return;
        const data = Object.assign({}, note.data);
        if (btn.dataset.act === "episode") data.episode += 1;
        else if (btn.dataset.act === "season") { data.season += 1; data.episode = 1; }
        else if (btn.dataset.act === "back" && data.episode > 1) data.episode -= 1;
        vibrate(8);
        thingSound("knob");
        bdCommit(note.id, data);
    });
}

// ---------- Создание и редактор ----------
function bdCreate(kind) {
    const z = bdCurrentZoom();
    const sc = bd.ui.scroll;
    // Новая заметка появляется в видимой части доски, каждая чуть в стороне
    const jitter = (bd.notes.size % 6) * 24;
    const x = Math.round(Math.max(0, Math.min(BD_W - 260, sc.scrollLeft / z + 30 + jitter)));
    const y = Math.round(Math.max(0, Math.min(BD_H - 200, sc.scrollTop / z + 30 + jitter)));
    const data = bdNormalize({ kind, x, y, z: bdMaxZ() + 1, by: bd.myName });
    bdOpenEditor({ id: null, data });
}

function bdOpenEditor(note) {
    const isNew = !note.id;
    const d = Object.assign({}, note.data);
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay bd-overlay";
    overlay.innerHTML = `
        <div class="modal-content bd-editor">
            <div class="bd-editor-title">${isNew ? (d.kind === "counter" ? "Новый счётчик серий" : "Новая заметка") : (d.kind === "counter" ? "Счётчик серий" : "Заметка")}</div>
            <div class="bd-preview"><div class="bd-preview-paper"></div></div>
            ${d.kind === "counter" ? `
                <label class="bd-field"><span>Название</span>
                    <input type="text" class="bd-input" id="bdText" maxlength="200" placeholder="Например, Рик и Морти" autocomplete="off">
                </label>
                <div class="bd-field-row">
                    <label class="bd-field"><span>Сезон</span><input type="number" class="bd-input" id="bdSeason" min="1" max="9999" inputmode="numeric"></label>
                    <label class="bd-field"><span>Серия</span><input type="number" class="bd-input" id="bdEpisode" min="1" max="9999" inputmode="numeric"></label>
                </div>
            ` : `
                <label class="bd-field"><span>Текст</span>
                    <textarea class="bd-input bd-textarea" id="bdText" maxlength="${BD_TEXT_MAX}" rows="5" placeholder="Что угодно. Ссылки станут кликабельными."></textarea>
                </label>
            `}
            <div class="bd-field"><span>Цвет</span>
                <div class="bd-swatches">${Object.entries(BD_COLORS).map(([k, c]) => `<button type="button" class="ui-btn bd-swatch" data-color="${k}" style="--c:${c.bg}" aria-label="${c.label}" title="${c.label}"></button>`).join("")}</div>
            </div>
            <div class="bd-field"><span>Размер</span>
                <div class="bd-seg">${Object.entries(BD_SIZES).map(([k, s]) => `<button type="button" class="ui-btn" data-size="${k}">${s.label}</button>`).join("")}</div>
            </div>
            <div class="bd-field"><span>Края</span>
                <div class="bd-seg is-wrap">${Object.entries(BD_EDGES).map(([k, label]) => `<button type="button" class="ui-btn" data-edge="${k}">${label}</button>`).join("")}</div>
            </div>
            <div class="bd-field"><span>Поворот: <b id="bdRotVal"></b></span>
                <div class="bd-rot-row">
                    <input type="range" class="bd-rot-range" id="bdRot" min="-180" max="180" step="1" aria-label="Поворот заметки">
                    <button type="button" class="ui-btn ui-pill" id="bdRotZero">Ровно</button>
                </div>
            </div>
            <div class="bd-editor-actions">
                ${isNew ? "" : `<button type="button" class="ui-btn ui-pill bd-delete" id="bdDelete">Удалить</button>`}
                <button type="button" class="ui-btn ui-pill" id="bdCancel">Отмена</button>
                <button type="button" class="ui-btn ui-pill ui-pill-accent" id="bdSave">${isNew ? "Приклеить" : "Сохранить"}</button>
            </div>
        </div>
    `;
    const $ = (s) => overlay.querySelector(s);
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    const textEl = $("#bdText");
    textEl.value = d.text;
    const seasonEl = $("#bdSeason"), episodeEl = $("#bdEpisode");
    if (seasonEl) { seasonEl.value = d.season; episodeEl.value = d.episode; }

    const renderChoices = () => {
        overlay.querySelectorAll("[data-color]").forEach(b => b.classList.toggle("is-active", b.dataset.color === d.color));
        overlay.querySelectorAll("[data-size]").forEach(b => b.classList.toggle("is-active", b.dataset.size === d.size));
        overlay.querySelectorAll("[data-edge]").forEach(b => b.classList.toggle("is-active", b.dataset.edge === d.edge));
        const paper = $(".bd-preview");
        paper.className = `bd-preview edge-${d.edge}`;
        paper.style.setProperty("--note-bg", BD_COLORS[d.color].bg);
        paper.style.width = Math.round(BD_SIZES[d.size].w * 0.62) + "px";
        const angle = Math.round(bdAngle(note.id, d));
        paper.style.transform = `rotate(${angle}deg)`;
        $("#bdRot").value = angle;
        $("#bdRotVal").textContent = angle + "°";
    };
    renderChoices();
    overlay.addEventListener("click", (e) => {
        const b = e.target.closest("[data-color], [data-size], [data-edge]");
        if (!b) return;
        if (b.dataset.color) d.color = b.dataset.color;
        if (b.dataset.size) d.size = b.dataset.size;
        if (b.dataset.edge) d.edge = b.dataset.edge;
        renderChoices();
    });

    $("#bdRot").addEventListener("input", (e) => { d.rot = +e.target.value; renderChoices(); });
    $("#bdRotZero").onclick = () => { d.rot = 0; renderChoices(); };
    $("#bdCancel").onclick = close;
    $("#bdSave").onclick = () => {
        d.text = textEl.value.trim().slice(0, BD_TEXT_MAX);
        if (d.kind === "counter") {
            d.season = bdClampInt(seasonEl.value, 1, 1);
            d.episode = bdClampInt(episodeEl.value, 1, 1);
        }
        close();
        // Пока окно было открыто, заметку могли перенести или соединить нитью
        const cur = note.id && bd.notes.get(note.id);
        if (cur) { d.x = cur.data.x; d.y = cur.data.y; d.z = cur.data.z; d.links = cur.data.links; }
        bdCommit(note.id || crypto.randomUUID(), d);
        vibrate(10);
        thingSound("pin");
    };
    const del = $("#bdDelete");
    if (del) del.onclick = async () => {
        if (!(await siteConfirm("Удалить заметку? Она пропадёт у обоих.", "Удалить"))) return;
        close();
        const backup = bd.notes.get(note.id);
        bdRemoveNote(note.id);
        bd.unsaved.delete(note.id);
        const { error } = await db.from("board_notes").delete().eq("id", note.id);
        if (error) {
            console.warn("board delete", error);
            alert("Не получилось удалить заметку. Проверь интернет.");
            if (backup) bdApplyNote(backup);
            return;
        }
        bdSend("del", { id: note.id });
    };

    document.body.appendChild(overlay);
    if (isNew) textEl.focus();
}
