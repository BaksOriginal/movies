// ==========================================
// studio.js — СОВМЕСТНАЯ АРТ-СТУДИЯ
// ==========================================
// Подключается на studio/index.html после core.js и shell.js.
//
// Рисунок хранится не картинкой, а списком команд — по строке на мазок,
// фигуру или заливку. Пример:
//     S1 a                              ← версия формата и формат листа
//     k2 a7f3qz p ff2e93 6 0 Bk4A2C1…   ← мазок ручкой: цвет, ширина, точки
//     k3 0c9mfe f 2f80ff 0 0 Q5Wg       ← заливка в точке
//     x a7f3qz                          ← мазок a7f3qz отменён
// Точки мазка — первая абсолютно, дальше разницы с предыдущей, каждое число
// упаковано в 1–3 символа (zigzag + base-32 с битом продолжения). Мазок из
// ста точек весит пару сотен байт, весь рисунок — десятки килобайт.
//
// Картинка каждый раз собирается из команд на холсте фиксированного размера
// (не зависящего от экрана), поэтому заливка у обоих попадает в одни и те же
// пиксели. Порядок команд — по часам Лэмпорта (t) и id, поэтому у двоих он
// одинаковый, даже если мазки пришли в разном порядке.
//
// Совместная работа — канал Supabase Realtime "art_studio":
//   presence — кто в студии и какой рисунок открыт;
//   op       — готовая команда;      live — мазок, который ещё рисуется;
//   cur      — курсор соседа;        sig/hello/ops — сверка: если что-то
//   потерялось по дороге, недостающие строки досылаются;
//   list     — список рисунков изменился; invite — «иди сюда».
// В таблице drawings лежит текст рисунка. Сохранение — «прочитать, слить,
// записать», так что одновременная запись двоих ничего не теряет.

const ST_FORMATS = {
    a: { w: 1600, h: 1200, label: "Альбомный" },
    p: { w: 1200, h: 1600, label: "Книжный" },
    s: { w: 1400, h: 1400, label: "Квадрат" },
};
const ST_BG = "#ffffff";
const ST_SAVE_DELAY_MS = 1800;
const ST_SAVE_MAX_WAIT_MS = 8000;
const ST_HEARTBEAT_MS = 5000;
const ST_RECONNECT_MS = 2000;
const ST_LIVE_MS = 60;
const ST_CURSOR_MS = 70;
const ST_CHECKPOINT_EVERY = 25;
const ST_MAX_CHECKPOINTS = 4;
const ST_CHUNK_CHARS = 60000;
const ST_FILL_TOLERANCE = 40;
const ST_DRAFT_KEY = (id) => `studioDraft:${id}`;
const ST_PREFS_KEY = "studioPrefs:v1";

const ST_ICONS = {
    pen: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 7l3 3"/>',
    brush: '<path d="M19 3.5a2 2 0 0 1 2.8 2.8L13.5 14.6 10.9 12z"/><path d="M10.4 13.3c-2.4-.6-4.6.9-4.9 3.3-.2 1.6-1 2.6-2.2 3.1 3 1 6.9.4 8.1-1.6.9-1.5.6-3.2-1-4.8z"/>',
    marker: '<path d="M14.5 3.5l6 6-8.5 8.5H6v-6z"/><path d="M6 18l-2.5 2.5H9"/><path d="M11.5 6.5l6 6"/>',
    eraser: '<path d="M8 20h12"/><path d="M4.6 15.4l9.9-9.9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L12 18H7.2z"/><path d="M9.5 10.5l5 5"/>',
    fill: '<path d="M5 11.5l7-7 7 7-7 7z"/><path d="M5 11.5h14"/><path d="M20.5 15.5s1.8 2.2 1.8 3.3a1.8 1.8 0 0 1-3.6 0c0-1.1 1.8-3.3 1.8-3.3z"/>',
    picker: '<path d="M19.4 4.6a2 2 0 0 0-2.8 0L13 8.2l2.8 2.8 3.6-3.6a2 2 0 0 0 0-2.8z"/><path d="M14.4 9.6L6 18v2.5h2.5l8.4-8.4"/><path d="M12 7.2l4.8 4.8"/>',
    shape: '<rect x="3" y="11" width="9" height="9" rx="1.5"/><circle cx="16.5" cy="7.5" r="4.5"/>',
    hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 10.5V6a1.5 1.5 0 0 1 3 0v6"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L3.6 15a1.5 1.5 0 0 1 2.3-1.9L8 15"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
    back: '<path d="m15 5-7 7 7 7"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
};
function stIcon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ST_ICONS[name] || ""}</svg>`;
}

const ST_TOOLS = [
    { id: "pen", label: "Ручка", key: "p" },
    { id: "brush", label: "Кисть", key: "b" },
    { id: "marker", label: "Маркер", key: "m" },
    { id: "eraser", label: "Ластик", key: "e" },
    { id: "fill", label: "Заливка", key: "g" },
    { id: "picker", label: "Пипетка", key: "i" },
    { id: "shape", label: "Фигуры", key: "u" },
    { id: "hand", label: "Рука", key: "h" },
];
// Код команды для инструментов-мазков
const ST_STROKE_KIND = { pen: "p", brush: "b", marker: "m", eraser: "e" };
// Пределы и начальная ширина для каждого инструмента (в пикселях листа)
const ST_WIDTHS = {
    pen: { min: 1, max: 40, def: 5 },
    brush: { min: 2, max: 140, def: 22 },
    marker: { min: 4, max: 140, def: 30 },
    eraser: { min: 4, max: 240, def: 48 },
    shape: { min: 1, max: 40, def: 6 },
};
const ST_SHAPES = [
    { id: "L", label: "Линия", svg: '<path d="M5 19L19 5"/>' },
    { id: "A", label: "Стрелка", svg: '<path d="M5 19L19 5"/><path d="M10 5h9v9"/>' },
    { id: "R", label: "Прямоугольник", svg: '<rect x="4" y="6" width="16" height="12" rx="1"/>' },
    { id: "O", label: "Эллипс", svg: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>' },
    { id: "T", label: "Треугольник", svg: '<path d="M12 4.5l8.5 15h-17z"/>' },
    { id: "S", label: "Звезда", svg: '<path d="M12 3.5l2.6 5.5 6 .7-4.4 4.1 1.2 5.9L12 16.8l-5.4 2.9 1.2-5.9-4.4-4.1 6-.7z"/>' },
    { id: "H", label: "Сердце", svg: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.1 4.1 0 0 1 12 7.3a4.1 4.1 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>' },
];
const ST_SHAPE_KINDS = new Set(ST_SHAPES.map(s => s.id));
const ST_KINDS = new Set(["p", "b", "m", "e", "f", "c", ...ST_SHAPE_KINDS]);
const ST_PALETTE = [
    "#000000", "#4a4a4a", "#9e9e9e", "#ffffff", "#ff2e93", "#ff8ac6",
    "#e53935", "#ff7a00", "#ffd400", "#8bd334", "#1fbf6a", "#00b8d9",
    "#2f80ff", "#3d2bd6", "#8b3bff", "#c77dff", "#7a4a26", "#f2c38f",
];

const st = {
    ch: null,
    me: null,
    myName: "",
    connected: false,
    reconnectTimer: null,
    partnerKey: null,
    partner: null,          // presence соседа: { name, d, color }
    list: [],               // строки таблицы drawings для галереи
    doc: null,              // открытый рисунок (см. stNewDoc)
    ui: null,               // элементы редактора
    tool: "pen",
    prevTool: "pen",
    shape: "R",
    shapeFill: false,
    color: "#ff2e93",
    widths: {},
    recent: [],
    undo: [],               // id своих команд по порядку
    redo: [],               // строки отменённых команд
    view: { s: 1, x: 0, y: 0, fit: true },
    live: new Map(),        // мазки соседа, которые ещё рисуются: from → op
    saveTimer: null,
    saveFirstDirtyAt: 0,
    saving: false,
    dirty: false,
    hooksInstalled: false,
};

// ---------- Мелочи ----------
function stEsc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function stRandId() {
    let s = "";
    for (let i = 0; i < 6; i++) s += "0123456789abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 36)];
    return s;
}
function stHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
}
function stPartnerName() {
    if (st.partner && st.partner.name) return st.partner.name;
    return st.myName === "Myakish" ? "Asmoday" : st.myName === "Asmoday" ? "Myakish" : "Партнёр";
}
function stFormatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const today = new Date();
    const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === today.toDateString()) return "сегодня, " + time;
    const y = new Date(today); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "вчера, " + time;
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) + ", " + time;
}
function stToast(text, action) {
    let box = document.getElementById("stToasts");
    if (!box) {
        box = document.createElement("div");
        box.id = "stToasts";
        box.className = "st-toasts";
        document.body.appendChild(box);
    }
    const t = document.createElement("div");
    t.className = "st-toast";
    t.innerHTML = `<span></span>`;
    t.firstChild.textContent = text;
    if (action) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ui-btn st-toast-btn";
        b.textContent = action.label;
        b.onclick = () => { t.remove(); action.run(); };
        t.appendChild(b);
    }
    box.appendChild(t);
    setTimeout(() => { t.classList.add("is-leaving"); setTimeout(() => t.remove(), 300); }, action ? 7000 : 2600);
}
function stLoadPrefs() {
    try {
        const p = JSON.parse(localStorage.getItem(ST_PREFS_KEY) || "{}");
        if (typeof p.color === "string" && /^#[0-9a-f]{6}$/i.test(p.color)) st.color = p.color;
        if (p.widths && typeof p.widths === "object") st.widths = p.widths;
        if (Array.isArray(p.recent)) st.recent = p.recent.filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 8);
        if (ST_SHAPE_KINDS.has(p.shape)) st.shape = p.shape;
        st.shapeFill = !!p.shapeFill;
        if (ST_TOOLS.some(t => t.id === p.tool) && p.tool !== "picker") st.tool = p.tool;
    } catch (e) {}
    Object.keys(ST_WIDTHS).forEach(k => {
        const lim = ST_WIDTHS[k];
        const v = +st.widths[k];
        st.widths[k] = v >= lim.min && v <= lim.max ? v : lim.def;
    });
}
function stSavePrefs() {
    try {
        localStorage.setItem(ST_PREFS_KEY, JSON.stringify({
            color: st.color, widths: st.widths, recent: st.recent, shape: st.shape, shapeFill: st.shapeFill,
            tool: st.tool === "picker" ? st.prevTool : st.tool,
        }));
    } catch (e) {}
}

// ---------- Кодирование команд ----------
const ST_ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const ST_ALPHA_IDX = {};
for (let i = 0; i < ST_ALPHA.length; i++) ST_ALPHA_IDX[ST_ALPHA[i]] = i;

// Массив целых → строка. Знак — zigzag, дальше по 5 бит на символ:
// символы 32–63 значат «будет ещё», 0–31 — последний кусок числа.
function stEncNums(nums) {
    let s = "";
    for (const n of nums) {
        let v = n < 0 ? -n * 2 - 1 : n * 2;
        while (v >= 32) { s += ST_ALPHA[32 + (v & 31)]; v = Math.floor(v / 32); }
        s += ST_ALPHA[v];
    }
    return s;
}
function stDecNums(str) {
    const out = [];
    let v = 0, mul = 1;
    for (let i = 0; i < str.length; i++) {
        const d = ST_ALPHA_IDX[str[i]];
        if (d === undefined) return null;
        if (d >= 32) { v += (d - 32) * mul; mul *= 32; continue; }
        v += d * mul;
        out.push(v % 2 ? -(v + 1) / 2 : v / 2);
        v = 0; mul = 1;
    }
    return out;
}
// Точки [x0,y0,x1,y1,…] (целые) → строка: первая точка как есть, дальше разницы
function stEncPts(pts) {
    if (!pts.length) return "-";
    const d = [pts[0], pts[1]];
    for (let i = 2; i < pts.length; i += 2) d.push(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    return stEncNums(d);
}
function stDecPts(str) {
    if (!str || str === "-") return [];
    const d = stDecNums(str);
    if (!d || d.length % 2) return null;
    for (let i = 2; i < d.length; i += 2) { d[i] += d[i - 2]; d[i + 1] += d[i - 1]; }
    return d;
}
function stOpLine(op) {
    return `${op.t.toString(36)} ${op.id} ${op.k} ${op.c} ${op.w} ${op.f ? 1 : 0} ${stEncPts(op.pts)}`;
}
// Строка → команда { t, id, k, c, w, f, pts, line } или отмена { tomb: id }
function stParseLine(line) {
    if (typeof line !== "string") return null;
    const a = line.split(" ");
    // Отмена — ровно два поля. Смотреть только на «x» в начале нельзя:
    // номер команды 33 в 36-ричной записи — тоже «x», и такая команда
    // принималась за отмену самой себя (а счётчик застревал на 33)
    if (a.length === 2) return a[0] === "x" && /^[0-9a-z]{6}$/.test(a[1]) ? { tomb: a[1] } : null;
    if (a.length !== 7) return null;
    const t = parseInt(a[0], 36);
    if (!(t >= 0) || !/^[0-9a-z]{6}$/.test(a[1]) || !ST_KINDS.has(a[2])) return null;
    const pts = stDecPts(a[6]);
    if (!pts) return null;
    if ("pbme".includes(a[2]) && pts.length < 2) return null;
    if (a[2] === "f" && pts.length !== 2) return null;
    if (ST_SHAPE_KINDS.has(a[2]) && pts.length !== 4) return null;
    const c = /^[0-9a-f]{6}$/.test(a[3]) ? a[3] : "000000";
    const w = Math.max(0, Math.min(400, parseInt(a[4], 10) || 0));
    return { t, id: a[1], k: a[2], c, w, f: a[5] === "1" ? 1 : 0, pts, line };
}

// Прореживание точек мазка (Рамер — Дуглас — Пекер): ровные участки
// хранятся двумя точками, изгибы — сколько нужно
function stSimplify(pts, eps) {
    const n = pts.length / 2;
    if (n <= 2) return pts.slice();
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        const ax = pts[a * 2], ay = pts[a * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1];
        const dx = bx - ax, dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        let best = -1, bestD = eps;
        for (let i = a + 1; i < b; i++) {
            const d = Math.abs(dy * pts[i * 2] - dx * pts[i * 2 + 1] + bx * ay - by * ax) / len;
            if (d > bestD) { bestD = d; best = i; }
        }
        if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
    return out;
}

// ---------- Рисование команд ----------
function stTrace(ctx, p) {
    const n = p.length / 2;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    if (n === 1) { ctx.lineTo(p[0] + 0.01, p[1]); return; }
    for (let i = 1; i < n - 1; i++) {
        const x = p[i * 2], y = p[i * 2 + 1];
        ctx.quadraticCurveTo(x, y, (x + p[i * 2 + 2]) / 2, (y + p[i * 2 + 3]) / 2);
    }
    ctx.lineTo(p[n * 2 - 2], p[n * 2 - 1]);
}

function stStrokePlain(ctx, p, w, col) {
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    stTrace(ctx, p);
    ctx.stroke();
    ctx.restore();
}

// Маркер: полупрозрачный и «умножается» на то, что под ним, как настоящий.
// Весь мазок — один stroke(), поэтому сам с собой он не темнеет.
function stStrokeMarker(ctx, p, w, col) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.globalCompositeOperation = "multiply";
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    stTrace(ctx, p);
    ctx.stroke();
    ctx.restore();
}

// Кисть: мазок сужается к началу и концу, край чуть мягкий. Сглаженная
// линия проходится мелким шагом, и в каждой точке ставится круг нужного
// радиуса — все круги заливаются одним fill(), поэтому тень-размытие края
// считается один раз и форма получается без ступенек.
function stStrokeBrush(ctx, p, w, col) {
    const n = p.length / 2;
    // Плотные точки вдоль той же кривой, что у stTrace
    const dense = [p[0], p[1]];
    const push = (x, y) => dense.push(x, y);
    const step = Math.max(0.6, w * 0.08);
    let sx = p[0], sy = p[1];
    for (let i = 1; i < n; i++) {
        const x = p[i * 2], y = p[i * 2 + 1];
        const last = i === n - 1;
        const ex = last ? x : (x + p[i * 2 + 2]) / 2;
        const ey = last ? y : (y + p[i * 2 + 3]) / 2;
        const cx = last ? (sx + ex) / 2 : x, cy = last ? (sy + ey) / 2 : y;
        const len = Math.hypot(cx - sx, cy - sy) + Math.hypot(ex - cx, ey - cy);
        const k = Math.max(1, Math.ceil(len / step));
        for (let j = 1; j <= k; j++) {
            const t = j / k, u = 1 - t;
            push(u * u * sx + 2 * u * t * cx + t * t * ex, u * u * sy + 2 * u * t * cy + t * t * ey);
        }
        sx = ex; sy = ey;
    }
    const m = dense.length / 2;
    const L = [0];
    for (let i = 1; i < m; i++) L.push(L[i - 1] + Math.hypot(dense[i * 2] - dense[i * 2 - 2], dense[i * 2 + 1] - dense[i * 2 - 1]));
    const total = L[m - 1];
    const ramp = Math.max(1, Math.min(total * 0.35, w * 4));
    ctx.save();
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = Math.min(4, Math.max(0.5, w * 0.12));
    ctx.beginPath();
    let lastS = -Infinity;
    for (let i = 0; i < m; i++) {
        const s = L[i];
        const r = (w / 2) * (m === 1 ? 0.8 : 0.22 + 0.78 * Math.min(1, s / ramp, (total - s) / ramp));
        if (i !== m - 1 && s - lastS < Math.max(0.5, r * 0.3)) continue;
        lastS = s;
        const x = dense[i * 2], y = dense[i * 2 + 1];
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();
}

function stShapePath(ctx, k, p, w) {
    const [x1, y1, x2, y2] = p;
    const l = Math.min(x1, x2), t = Math.min(y1, y2);
    const cw = Math.abs(x2 - x1), ch = Math.abs(y2 - y1);
    ctx.beginPath();
    if (k === "L") {
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    } else if (k === "A") {
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.min(Math.hypot(x2 - x1, y2 - y1) * 0.6, Math.max(18, w * 3.2));
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.moveTo(x2 + Math.cos(ang + 2.6) * head, y2 + Math.sin(ang + 2.6) * head);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x2 + Math.cos(ang - 2.6) * head, y2 + Math.sin(ang - 2.6) * head);
    } else if (k === "R") {
        ctx.rect(l, t, cw, ch);
    } else if (k === "O") {
        ctx.ellipse(l + cw / 2, t + ch / 2, cw / 2, ch / 2, 0, 0, Math.PI * 2);
    } else if (k === "T") {
        ctx.moveTo(l + cw / 2, t); ctx.lineTo(l + cw, t + ch); ctx.lineTo(l, t + ch); ctx.closePath();
    } else if (k === "S") {
        const cx = l + cw / 2, cy = t + ch / 2;
        for (let i = 0; i < 10; i++) {
            const r = i % 2 ? 0.42 : 1;
            const a = -Math.PI / 2 + (i * Math.PI) / 5;
            const px = cx + Math.cos(a) * (cw / 2) * r, py = cy + Math.sin(a) * (ch / 2) * r;
            if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }
        ctx.closePath();
    } else if (k === "H") {
        const X = (u) => l + u * cw, Y = (v) => t + v * ch;
        ctx.moveTo(X(0.5), Y(0.28));
        ctx.bezierCurveTo(X(0.5), Y(0.25), X(0.44), Y(0.08), X(0.25), Y(0.08));
        ctx.bezierCurveTo(X(0.02), Y(0.08), X(0), Y(0.35), X(0), Y(0.38));
        ctx.bezierCurveTo(X(0), Y(0.62), X(0.24), Y(0.8), X(0.5), Y(0.98));
        ctx.bezierCurveTo(X(0.76), Y(0.8), X(1), Y(0.62), X(1), Y(0.38));
        ctx.bezierCurveTo(X(1), Y(0.35), X(0.98), Y(0.08), X(0.75), Y(0.08));
        ctx.bezierCurveTo(X(0.56), Y(0.08), X(0.5), Y(0.25), X(0.5), Y(0.28));
        ctx.closePath();
    }
}

function stDrawShape(ctx, k, p, w, col, filled) {
    ctx.save();
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = Math.max(1, w);
    ctx.lineCap = "round";
    ctx.lineJoin = k === "R" ? "miter" : "round";
    stShapePath(ctx, k, p, w);
    if (filled && k !== "L" && k !== "A") ctx.fill();
    ctx.stroke();
    ctx.restore();
}

// Заливка замкнутой области (построчная, с допуском на сглаженные края).
// После основной заливки область «наплывает» на 1 пиксель — иначе вдоль
// линий оставалась бы светлая кайма от сглаживания.
function stFloodFill(ctx, sx, sy, hex, W, H) {
    sx = Math.round(sx); sy = Math.round(sy);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
    const img = ctx.getImageData(0, 0, W, H);
    const d32 = new Uint32Array(img.data.buffer);
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    const fill = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    const seed = d32[sy * W + sx];
    if (seed === fill) return;
    const sr = seed & 255, sg = (seed >>> 8) & 255, sb = (seed >>> 16) & 255;
    const tol = ST_FILL_TOLERANCE;
    const mask = new Uint8Array(W * H);
    const like = (i) => {
        if (mask[i]) return false;
        const v = d32[i];
        return Math.abs((v & 255) - sr) <= tol && Math.abs(((v >>> 8) & 255) - sg) <= tol && Math.abs(((v >>> 16) & 255) - sb) <= tol;
    };
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    const stack = [sx, sy];
    while (stack.length) {
        const y = stack.pop(), x0 = stack.pop();
        let x = x0;
        const row = y * W;
        if (!like(row + x)) continue;
        while (x > 0 && like(row + x - 1)) x--;
        let upOpen = false, downOpen = false;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (; x < W && like(row + x); x++) {
            mask[row + x] = 1;
            if (y > 0) {
                const up = like(row - W + x);
                if (up && !upOpen) stack.push(x, y - 1);
                upOpen = up;
            }
            if (y < H - 1) {
                const dn = like(row + W + x);
                if (dn && !downOpen) stack.push(x, y + 1);
                downOpen = dn;
            }
        }
        if (x - 1 > maxX) maxX = x - 1;
    }
    minX = Math.max(0, minX - 2); minY = Math.max(0, minY - 2);
    maxX = Math.min(W - 1, maxX + 2); maxY = Math.min(H - 1, maxY + 2);
    // Два прохода «наплыва»: пиксель края берём, если рядом уже залитый
    // (из прошлого прохода) и цветом он ещё ближе к фону, чем к линии
    for (let pass = 1; pass <= 2; pass++) {
        const limit = pass === 1 ? 150 : 90;
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const i = y * W + x;
                if (mask[i]) continue;
                const near = (x > 0 && mask[i - 1] && mask[i - 1] <= pass) || (x < W - 1 && mask[i + 1] && mask[i + 1] <= pass) ||
                    (y > 0 && mask[i - W] && mask[i - W] <= pass) || (y < H - 1 && mask[i + W] && mask[i + W] <= pass);
                if (!near) continue;
                const v = d32[i];
                const diff = Math.max(Math.abs((v & 255) - sr), Math.abs(((v >>> 8) & 255) - sg), Math.abs(((v >>> 16) & 255) - sb));
                if (diff < limit) mask[i] = pass + 1;
            }
        }
    }
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const i = y * W + x;
            if (mask[i]) d32[i] = fill;
        }
    }
    ctx.putImageData(img, 0, 0, minX, minY, maxX - minX + 1, maxY - minY + 1);
}

function stDrawOp(ctx, op, W, H) {
    const col = "#" + op.c;
    switch (op.k) {
        case "p": stStrokePlain(ctx, op.pts, op.w, col); break;
        case "e": stStrokePlain(ctx, op.pts, op.w, ST_BG); break;
        case "b": stStrokeBrush(ctx, op.pts, op.w, col); break;
        case "m": stStrokeMarker(ctx, op.pts, op.w, col); break;
        case "f": stFloodFill(ctx, op.pts[0], op.pts[1], op.c, W, H); break;
        case "c": ctx.save(); ctx.fillStyle = col; ctx.fillRect(0, 0, W, H); ctx.restore(); break;
        default: stDrawShape(ctx, op.k, op.pts, op.w, col, op.f);
    }
}

// ---------- Документ ----------
function stParseDocText(text) {
    const lines = String(text || "").split("\n");
    let fmt = "a";
    const m = /^S1 ([aps])/.exec(lines[0] || "");
    if (m) { fmt = m[1]; lines.shift(); }
    return { fmt, lines: lines.filter(Boolean) };
}

function stNewDoc(row) {
    const parsed = stParseDocText(row.data);
    const f = ST_FORMATS[parsed.fmt];
    const doc = {
        id: row.id,
        title: row.title || "Без названия",
        fmt: parsed.fmt,
        W: f.w, H: f.h,
        ops: [],            // по порядку (t, id), отменённые остаются на месте
        byId: new Map(),
        dead: new Set(),
        known: new Set(),   // всё, что мы знаем: id команд и "x"+id отмен
        sig: 0,
        clock: 0,
        canvas: null, ctx: null,
        cps: [],            // снимки холста: { idx, canvas } — после idx команд
        pendingIdx: null,
        rebuildRaf: 0,
    };
    stMergeLines(doc, parsed.lines);
    return doc;
}

function stDocText(doc) {
    const out = ["S1 " + doc.fmt];
    for (const op of doc.ops) if (!doc.dead.has(op.id)) out.push(op.line);
    for (const id of doc.dead) out.push("x " + id);
    return out.join("\n");
}

function stKnow(doc, key) {
    if (doc.known.has(key)) return false;
    doc.known.add(key);
    doc.sig = (doc.sig + stHash(key)) >>> 0;
    return true;
}

// Сравнение порядка двух команд
function stBefore(a, b) { return a.t < b.t || (a.t === b.t && a.id < b.id); }

// Добавить строки в документ. Возвращает, сколько нового узнали.
function stMergeLines(doc, lines) {
    let added = 0;
    for (const line of lines) {
        const p = stParseLine(line);
        if (!p) continue;
        if (p.tomb) {
            if (!stKnow(doc, "x" + p.tomb)) continue;
            stKnow(doc, p.tomb);
            doc.dead.add(p.tomb);
            added++;
            const op = doc.byId.get(p.tomb);
            if (op) stInvalidate(doc, doc.ops.indexOf(op));
            continue;
        }
        if (doc.byId.has(p.id)) continue;
        stKnow(doc, p.id);
        if (p.t > doc.clock) doc.clock = p.t;
        added++;
        if (doc.dead.has(p.id)) continue; // уже отменена — тело не нужно
        let pos = doc.ops.length;
        while (pos > 0 && stBefore(p, doc.ops[pos - 1])) pos--;
        doc.ops.splice(pos, 0, p);
        doc.byId.set(p.id, p);
        if (!doc.ctx) continue;
        if (pos === doc.ops.length - 1 && doc.pendingIdx === null) {
            stDrawOp(doc.ctx, p, doc.W, doc.H);
            stMaybeCheckpoint(doc);
        } else {
            stInvalidate(doc, pos);
        }
    }
    return added;
}

// Команда на позиции idx изменилась (вставили в середину или отменили) —
// перерисовать с ближайшего снимка до неё
function stInvalidate(doc, idx) {
    if (!doc.ctx || idx < 0) return;
    doc.pendingIdx = doc.pendingIdx === null ? idx : Math.min(doc.pendingIdx, idx);
    doc.cps = doc.cps.filter(cp => cp.idx <= doc.pendingIdx);
    if (!doc.rebuildRaf) doc.rebuildRaf = requestAnimationFrame(() => { doc.rebuildRaf = 0; stRebuild(doc); });
}

function stRebuild(doc) {
    const from = doc.pendingIdx === null ? 0 : doc.pendingIdx;
    doc.pendingIdx = null;
    const ctx = doc.ctx;
    let cp = null;
    for (const c of doc.cps) if (c.idx <= from && (!cp || c.idx > cp.idx)) cp = c;
    ctx.save();
    ctx.globalCompositeOperation = "copy";
    if (cp) ctx.drawImage(cp.canvas, 0, 0);
    else { ctx.fillStyle = ST_BG; ctx.fillRect(0, 0, doc.W, doc.H); }
    ctx.restore();
    const start = cp ? cp.idx : 0;
    const n = doc.ops.length;
    for (let i = start; i < n; i++) {
        const op = doc.ops[i];
        if (!doc.dead.has(op.id)) stDrawOp(ctx, op, doc.W, doc.H);
        // Снимки имеет смысл делать только ближе к концу: их всего несколько
        if (n - (i + 1) < ST_CHECKPOINT_EVERY * ST_MAX_CHECKPOINTS) stMaybeCheckpoint(doc, i + 1);
    }
}

function stMaybeCheckpoint(doc, idx = doc.ops.length) {
    const last = doc.cps.length ? doc.cps[doc.cps.length - 1].idx : 0;
    if (idx - last < ST_CHECKPOINT_EVERY) return;
    let canvas;
    if (doc.cps.length >= ST_MAX_CHECKPOINTS) canvas = doc.cps.shift().canvas;
    else {
        canvas = document.createElement("canvas");
        canvas.width = doc.W; canvas.height = doc.H;
    }
    const c = canvas.getContext("2d");
    c.globalCompositeOperation = "copy";
    c.drawImage(doc.canvas, 0, 0);
    doc.cps.push({ idx, canvas });
}

// Отрисовать весь рисунок в отдельный холст (для превью и скачивания)
function stRenderDocTo(doc) {
    const canvas = document.createElement("canvas");
    canvas.width = doc.W; canvas.height = doc.H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = ST_BG;
    ctx.fillRect(0, 0, doc.W, doc.H);
    for (const op of doc.ops) if (!doc.dead.has(op.id)) stDrawOp(ctx, op, doc.W, doc.H);
    return canvas;
}

// ---------- База ----------
async function stDbList() {
    const { data, error } = await db.from("drawings").select("id, title, data, created_by, updated_at").order("updated_at", { ascending: false });
    if (error) throw error;
    return data || [];
}
async function stDbCreate(title, fmt) {
    const { data, error } = await db.from("drawings").insert([{ title, data: "S1 " + fmt, created_by: st.me }]).select("id, title, data, created_by, updated_at").single();
    if (error) throw error;
    return data;
}
async function stDbLoad(id) {
    const { data, error } = await db.from("drawings").select("id, title, data, created_by, updated_at").eq("id", id).maybeSingle();
    if (error) throw error;
    return data;
}

// ---------- Канал ----------
function stInitChannel() {
    if (st.ch || !currentUser) return;
    st.me = currentUser.id;
    st.myName = getUsernameFromEmail(currentUser.email);
    const channel = db.channel("art_studio", { config: { presence: { key: st.me }, broadcast: { self: false } } });
    st.ch = channel;
    const on = (event, fn) => channel.on("broadcast", { event }, ({ payload }) => {
        if (!payload || payload.from === st.me) return;
        fn(payload);
    });
    channel.on("presence", { event: "sync" }, () => stOnPresence());
    on("op", stOnOp);
    on("live", stOnLive);
    on("cur", stOnCursor);
    on("sig", stOnSig);
    on("hello", stOnHello);
    on("ops", stOnOps);
    on("list", () => { if (!st.doc) stRefreshGallery(); });
    on("meta", stOnMeta);
    on("invite", stOnInvite);
    channel.subscribe((status) => {
        if (st.ch !== channel) return;
        if (status === "SUBSCRIBED") {
            st.connected = true;
            stTrack();
            stSendHello();
            stRenderPartner();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            st.connected = false;
            stRenderPartner();
            if (!st.reconnectTimer) st.reconnectTimer = setTimeout(() => {
                st.reconnectTimer = null;
                const old = st.ch;
                st.ch = null;
                if (old) { try { db.removeChannel(old); } catch (e) {} }
                stInitChannel();
            }, ST_RECONNECT_MS);
        }
    });
    stInstallHooks();
}

function stInstallHooks() {
    if (st.hooksInstalled) return;
    st.hooksInstalled = true;
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) { stFlushSave(); return; }
        if (st.ch && st.ch.state && st.ch.state !== "joined") {
            const old = st.ch; st.ch = null; st.connected = false;
            try { db.removeChannel(old); } catch (e) {}
            stInitChannel();
            return;
        }
        stTrack();
        stSendHello();
    });
    window.addEventListener("pagehide", () => stFlushSave());
    window.addEventListener("online", () => stSendHello());
    // Realtime доставляет «по возможности»: раз в несколько секунд сверяем,
    // одинаковый ли у нас набор команд, и досылаем недостающее
    setInterval(() => {
        if (st.doc && stPartnerHere()) stSend("sig", { d: st.doc.id, sig: st.doc.sig, n: st.doc.known.size });
    }, ST_HEARTBEAT_MS);
}

function stSend(event, payload) {
    if (!st.ch || !st.connected) return;
    try {
        const r = st.ch.send({ type: "broadcast", event, payload: Object.assign({ from: st.me }, payload) });
        if (r && r.catch) r.catch(() => {});
    } catch (e) {}
}

function stTrack() {
    if (!st.ch || !st.connected) return;
    try {
        const r = st.ch.track({ name: st.myName, d: st.doc ? st.doc.id : null, color: st.color, at: Date.now() });
        if (r && r.catch) r.catch(() => {});
    } catch (e) {}
}

function stOnPresence() {
    const state = st.ch ? st.ch.presenceState() : {};
    const other = Object.keys(state).find(k => k !== st.me);
    const wasHere = stPartnerHere();
    st.partnerKey = other || null;
    const metas = other ? state[other] : null;
    st.partner = metas && metas.length ? metas[metas.length - 1] : null;
    if (!stPartnerHere()) { st.live.clear(); stDrawLive(); stHideCursor(); }
    if (!wasHere && stPartnerHere()) stSendHello();
    stRenderPartner();
    if (!st.doc) stRenderGalleryPresence();
}

function stPartnerHere() {
    return !!(st.doc && st.partner && st.partner.d === st.doc.id);
}

function stSendHello(reply = false) {
    if (!st.doc) return;
    stSend("hello", { d: st.doc.id, keys: Array.from(st.doc.known), reply });
}

function stOnHello(p) {
    const doc = st.doc;
    if (!doc || p.d !== doc.id || !Array.isArray(p.keys)) return;
    const theirs = new Set(p.keys);
    const lines = [];
    for (const key of doc.known) {
        if (theirs.has(key)) continue;
        if (key.length === 7 && key[0] === "x") lines.push("x " + key.slice(1));
        else {
            const op = doc.byId.get(key);
            if (op && !doc.dead.has(key)) lines.push(op.line);
        }
    }
    stSendLines(doc.id, lines);
    // Есть то, чего нет у нас, — попросим в ответ (но без пинг-понга)
    if (!p.reply && p.keys.some(k => !doc.known.has(k))) stSendHello(true);
}

function stSendLines(d, lines) {
    let chunk = [], size = 0;
    for (const line of lines) {
        chunk.push(line);
        size += line.length + 1;
        if (size >= ST_CHUNK_CHARS) { stSend("ops", { d, lines: chunk }); chunk = []; size = 0; }
    }
    if (chunk.length) stSend("ops", { d, lines: chunk });
}

function stOnOps(p) {
    if (!st.doc || p.d !== st.doc.id || !Array.isArray(p.lines)) return;
    if (stMergeLines(st.doc, p.lines)) stMarkDirty();
}

function stOnSig(p) {
    const doc = st.doc;
    if (!doc || p.d !== doc.id) return;
    if (p.sig !== doc.sig || p.n !== doc.known.size) stSendHello();
}

function stOnOp(p) {
    const doc = st.doc;
    if (!doc || p.d !== doc.id) return;
    if (st.live.delete(p.from)) stDrawLive();
    if (stMergeLines(doc, [p.line])) stMarkDirty();
}

function stOnLive(p) {
    if (!st.doc || p.d !== st.doc.id) return;
    const op = p.line ? stParseLine(p.line) : null;
    if (op && !op.tomb) st.live.set(p.from, op);
    else st.live.delete(p.from);
    stDrawLive();
    if (op && op.pts.length >= 2) stShowCursor(op.pts[op.pts.length - 2], op.pts[op.pts.length - 1], "#" + op.c);
}

function stOnCursor(p) {
    if (!st.doc || p.d !== st.doc.id) return;
    if (p.x == null) { stHideCursor(); return; }
    stShowCursor(p.x, p.y, p.c);
}

function stOnMeta(p) {
    if (st.doc && p.d === st.doc.id && typeof p.title === "string") {
        st.doc.title = p.title.slice(0, 60);
        if (st.ui) st.ui.title.textContent = st.doc.title;
    }
    if (!st.doc) stRefreshGallery();
}

function stOnInvite(p) {
    if (st.doc && st.doc.id === p.d) return;
    if (typeof beep === "function") { beep(660, 90, "triangle", 0.05); beep(990, 140, "sine", 0.04, 110); }
    vibrate(15);
    stToast(`${p.name || stPartnerName()} зовёт рисовать «${String(p.title || "").slice(0, 40)}»`, {
        label: "Открыть",
        run: () => stOpenDrawing(p.d),
    });
}

// ---------- Сохранение ----------
function stMarkDirty() {
    if (!st.doc) return;
    st.dirty = true;
    if (!st.saveFirstDirtyAt) st.saveFirstDirtyAt = Date.now();
    stRenderSaveState();
    clearTimeout(st.saveTimer);
    const waited = Date.now() - st.saveFirstDirtyAt;
    // Когда рисуем вдвоём, базу пишет один из двоих (у кого id меньше),
    // второй — только если долго не получалось или при выходе
    const leader = !stPartnerHere() || st.me < st.partnerKey;
    const delay = leader ? Math.max(0, Math.min(ST_SAVE_DELAY_MS, ST_SAVE_MAX_WAIT_MS - waited)) : 20000;
    st.saveTimer = setTimeout(() => stSave(), delay);
    try { localStorage.setItem(ST_DRAFT_KEY(st.doc.id), stDocText(st.doc)); } catch (e) {}
}

async function stSave() {
    const doc = st.doc;
    if (!doc || !st.dirty) return;
    if (st.saving) { clearTimeout(st.saveTimer); st.saveTimer = setTimeout(() => stSave(), 600); return; }
    st.saving = true;
    st.dirty = false;
    st.saveFirstDirtyAt = 0;
    stRenderSaveState();
    try {
        // Сначала забираем то, что успел записать сосед, — иначе затрём
        const row = await stDbLoad(doc.id);
        if (!row) { stToast("Рисунок удалён"); stCloseEditor(); return; }
        if (row.data) stMergeLines(doc, stParseDocText(row.data).lines);
        const text = stDocText(doc);
        const { error } = await db.from("drawings").update({ data: text, updated_at: new Date().toISOString() }).eq("id", doc.id);
        if (error) throw error;
        if (!st.dirty) { try { localStorage.removeItem(ST_DRAFT_KEY(doc.id)); } catch (e) {} }
    } catch (e) {
        console.warn("studio save", e);
        st.dirty = true;
        clearTimeout(st.saveTimer);
        st.saveTimer = setTimeout(() => stSave(), 5000);
    } finally {
        st.saving = false;
        stRenderSaveState();
    }
}

function stFlushSave() {
    if (st.doc && st.dirty) { clearTimeout(st.saveTimer); stSave(); }
}

function stRenderSaveState() {
    if (!st.ui) return;
    const el = st.ui.save;
    const state = st.saving ? "saving" : st.dirty ? "dirty" : "saved";
    el.dataset.state = state;
    el.textContent = state === "saved" ? "Сохранено" : "Сохраняю…";
}

// ---------- Галерея ----------
const stThumbCache = new Map();

async function showStudioScreen() {
    stInitChannel();
    stLoadPrefs();
    const fromHash = /^#d=([0-9a-f-]{36})$/.exec(location.hash || "");
    if (fromHash) { stOpenDrawing(fromHash[1]); return; }
    stRenderGallery();
}

function stRenderGallery() {
    setShellSection("studio");
    app.innerHTML = `
        <div class="st-gallery">
            <section class="st-hero">
                <div class="st-hero-text">
                    <div class="st-hero-kicker">Арт-студия</div>
                    <h2 class="st-hero-title">Рисуйте вдвоём</h2>
                    <p class="st-hero-sub">Один холст на двоих: всё, что рисует один, сразу появляется у другого. Рисунки сохраняются, их можно дорисовать потом.</p>
                </div>
                <div class="st-new">
                    <div class="st-new-label">Новый рисунок</div>
                    <div class="st-new-formats">
                        ${Object.entries(ST_FORMATS).map(([k, f]) => `
                            <button type="button" class="ui-btn st-new-btn" data-fmt="${k}">
                                <span class="st-new-sheet is-${k}"></span>
                                <span>${f.label}</span>
                            </button>`).join("")}
                    </div>
                </div>
            </section>
            <div class="st-partner-line" id="stGalleryPartner"></div>
            <div class="st-grid" id="stGrid"><div class="st-empty">Загружаю рисунки…</div></div>
        </div>
    `;
    app.querySelectorAll(".st-new-btn").forEach(btn => { btn.onclick = () => stCreateDrawing(btn.dataset.fmt); });
    stRenderGalleryPresence();
    stRefreshGallery();
}

async function stRefreshGallery() {
    const grid = document.getElementById("stGrid");
    if (!grid) return;
    try {
        st.list = await stDbList();
    } catch (e) {
        console.warn("studio list", e);
        grid.innerHTML = `<div class="st-empty">Не получилось загрузить рисунки. Проверь интернет и обнови страницу.</div>`;
        return;
    }
    if (!document.getElementById("stGrid")) return;
    if (!st.list.length) {
        grid.innerHTML = `<div class="st-empty">Пока ни одного рисунка. Выберите формат листа выше — и вперёд 🎨</div>`;
        return;
    }
    grid.innerHTML = "";
    st.list.forEach(row => grid.appendChild(stBuildCard(row)));
    stRenderGalleryPresence();
    stRenderThumbs();
}

function stBuildCard(row) {
    const fmt = stParseDocText(row.data).fmt;
    const card = document.createElement("div");
    card.className = "st-card";
    card.dataset.id = row.id;
    card.innerHTML = `
        <button type="button" class="ui-btn st-card-open">
            <span class="st-card-thumb is-${fmt}"><canvas></canvas></span>
            <span class="st-card-body">
                <span class="st-card-title"></span>
                <span class="st-card-meta"></span>
            </span>
        </button>
        <span class="st-card-here" hidden></span>
        <button type="button" class="ui-btn st-card-menu" aria-label="Действия">${stIcon("more")}</button>
    `;
    card.querySelector(".st-card-title").textContent = row.title || "Без названия";
    const size = (row.data || "").length;
    card.querySelector(".st-card-meta").textContent = `${stFormatDate(row.updated_at)} · ${size < 1024 ? size + " Б" : Math.round(size / 1024) + " КБ"}`;
    card.querySelector(".st-card-open").onclick = () => stOpenDrawing(row.id);
    card.querySelector(".st-card-menu").onclick = (e) => stCardMenu(row, e.currentTarget);
    return card;
}

function stRenderGalleryPresence() {
    const line = document.getElementById("stGalleryPartner");
    if (line) {
        const name = stPartnerName();
        if (!st.partner) line.innerHTML = `<span class="st-dot"></span>${stEsc(name)} сейчас не в студии`;
        else if (st.partner.d) {
            const row = st.list.find(r => r.id === st.partner.d);
            line.innerHTML = `<span class="st-dot is-on"></span>${stEsc(name)} рисует «${stEsc(row ? row.title : "…")}»`;
            if (row) {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "ui-btn ui-pill ui-pill-accent";
                b.textContent = "Присоединиться";
                b.onclick = () => stOpenDrawing(row.id);
                line.appendChild(b);
            }
        } else line.innerHTML = `<span class="st-dot is-on"></span>${stEsc(name)} в студии`;
    }
    document.querySelectorAll(".st-card").forEach(card => {
        const here = card.querySelector(".st-card-here");
        const on = !!(st.partner && st.partner.d === card.dataset.id);
        here.hidden = !on;
        here.innerHTML = on ? userAvatarHtml(stPartnerName()) : "";
        here.title = on ? `${stPartnerName()} рисует здесь` : "";
    });
}

// Превью рисуются по очереди, чтобы галерея не подвисала
async function stRenderThumbs() {
    for (const row of st.list.slice()) {
        const card = document.querySelector(`.st-card[data-id="${row.id}"]`);
        if (!card) continue;
        const canvas = card.querySelector("canvas");
        const key = row.id + ":" + row.updated_at + ":" + (row.data || "").length;
        let thumb = stThumbCache.get(key);
        if (!thumb) {
            await new Promise(r => setTimeout(r, 0));
            const doc = stNewDoc(row);
            const full = stRenderDocTo(doc);
            thumb = document.createElement("canvas");
            const k = 360 / Math.max(doc.W, doc.H);
            thumb.width = Math.round(doc.W * k); thumb.height = Math.round(doc.H * k);
            const c = thumb.getContext("2d");
            c.imageSmoothingQuality = "high";
            c.drawImage(full, 0, 0, thumb.width, thumb.height);
            stThumbCache.set(key, thumb);
        }
        canvas.width = thumb.width; canvas.height = thumb.height;
        canvas.getContext("2d").drawImage(thumb, 0, 0);
    }
}

async function stCreateDrawing(fmt) {
    const title = "Рисунок " + new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
    try {
        const row = await stDbCreate(title, fmt);
        stSend("list", {});
        stOpenEditor(row);
    } catch (e) {
        console.warn("studio create", e);
        stToast("Не получилось создать рисунок");
    }
}

function stCardMenu(row, anchor) {
    stOpenPopover(anchor, "st-pop-menu", (pop, close) => {
        pop.innerHTML = `
            <button type="button" class="ui-btn st-menu-item" data-a="open">Открыть</button>
            <button type="button" class="ui-btn st-menu-item" data-a="rename">Переименовать</button>
            <button type="button" class="ui-btn st-menu-item" data-a="png">Скачать PNG</button>
            <button type="button" class="ui-btn st-menu-item is-danger" data-a="delete">Удалить</button>
        `;
        pop.onclick = async (e) => {
            const a = e.target.closest("[data-a]");
            if (!a) return;
            close();
            if (a.dataset.a === "open") stOpenDrawing(row.id);
            else if (a.dataset.a === "rename") stRename(row.id, row.title);
            else if (a.dataset.a === "png") stDownloadPng(stNewDoc(row));
            else if (a.dataset.a === "delete") stDelete(row);
        };
    });
}

async function stRename(id, current) {
    const title = await stPrompt("Название рисунка", current || "");
    if (title == null) return;
    const clean = title.trim().slice(0, 60) || "Без названия";
    const { error } = await db.from("drawings").update({ title: clean }).eq("id", id);
    if (error) { stToast("Не получилось переименовать"); return; }
    if (st.doc && st.doc.id === id) { st.doc.title = clean; if (st.ui) st.ui.title.textContent = clean; }
    stSend("meta", { d: id, title: clean });
    if (!st.doc) stRefreshGallery();
}

async function stDelete(row) {
    const ok = await stConfirm(`Удалить «${row.title}»?`, "Рисунок пропадёт у обоих, вернуть его будет нельзя.", "Удалить");
    if (!ok) return;
    const { error } = await db.from("drawings").delete().eq("id", row.id);
    if (error) { stToast("Не получилось удалить"); return; }
    try { localStorage.removeItem(ST_DRAFT_KEY(row.id)); } catch (e) {}
    stSend("list", {});
    if (st.doc && st.doc.id === row.id) { st.dirty = false; stCloseEditor(); }
    else stRefreshGallery();
}

function stDownloadPng(doc) {
    const canvas = stRenderDocTo(doc);
    canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = (doc.title || "рисунок").replace(/[\\/:*?"<>|]+/g, "_") + ".png";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, "image/png");
}

// ---------- Небольшие диалоги ----------
function stDialog(build) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay st-dialog-overlay";
        const box = document.createElement("div");
        box.className = "st-dialog";
        overlay.appendChild(box);
        let done = false;
        const finish = (v) => { if (done) return; done = true; overlay.remove(); resolve(v); };
        overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(null); });
        build(box, finish);
        document.body.appendChild(overlay);
        const input = box.querySelector("input");
        if (input) { input.focus(); input.select(); }
    });
}
function stPrompt(label, value) {
    return stDialog((box, finish) => {
        box.innerHTML = `
            <div class="st-dialog-title"></div>
            <form class="st-dialog-form">
                <input type="text" class="st-dialog-input" maxlength="60" autocomplete="off">
                <div class="st-dialog-actions">
                    <button type="button" class="ui-btn ui-pill" data-a="no">Отмена</button>
                    <button type="submit" class="ui-btn ui-pill ui-pill-accent">Сохранить</button>
                </div>
            </form>
        `;
        box.querySelector(".st-dialog-title").textContent = label;
        const input = box.querySelector("input");
        input.value = value;
        box.querySelector("form").onsubmit = (e) => { e.preventDefault(); finish(input.value); };
        box.querySelector("[data-a=no]").onclick = () => finish(null);
    });
}
function stConfirm(title, text, yes) {
    return stDialog((box, finish) => {
        box.innerHTML = `
            <div class="st-dialog-title"></div>
            <p class="st-dialog-text"></p>
            <div class="st-dialog-actions">
                <button type="button" class="ui-btn ui-pill" data-a="no">Отмена</button>
                <button type="button" class="ui-btn ui-pill st-pill-danger" data-a="yes"></button>
            </div>
        `;
        box.querySelector(".st-dialog-title").textContent = title;
        box.querySelector(".st-dialog-text").textContent = text;
        box.querySelector("[data-a=yes]").textContent = yes;
        box.querySelector("[data-a=no]").onclick = () => finish(false);
        box.querySelector("[data-a=yes]").onclick = () => finish(true);
    }).then(v => !!v);
}

// Всплывающая панель у кнопки (цвет, фигуры, меню)
function stOpenPopover(anchor, cls, build) {
    const existing = document.querySelector(".st-pop");
    if (existing) {
        const same = existing.dataset.cls === cls;
        existing._close();
        if (same) return;
    }
    const pop = document.createElement("div");
    pop.className = "st-pop " + cls;
    pop.dataset.cls = cls;
    const close = () => {
        pop.remove();
        document.removeEventListener("pointerdown", outside, true);
        window.removeEventListener("resize", close);
    };
    const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    pop._close = close;
    build(pop, close);
    document.body.appendChild(pop);
    // Ставим рядом с кнопкой, не вылезая за экран
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const vw = innerWidth, vh = innerHeight;
    let left = Math.min(vw - pw - 8, Math.max(8, r.left + r.width / 2 - pw / 2));
    let top = r.bottom + 8;
    if (top + ph > vh - 8) top = r.top - ph - 8;
    if (top < 8) {
        // Не помещается ни снизу, ни сверху (кнопка сбоку) — ставим рядом
        top = Math.max(8, Math.min(vh - ph - 8, r.top));
        left = r.right + 8 + pw <= vw ? r.right + 8 : Math.max(8, r.left - pw - 8);
    }
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    setTimeout(() => {
        document.addEventListener("pointerdown", outside, true);
        window.addEventListener("resize", close);
    }, 0);
    return pop;
}
function stClosePopover() {
    const p = document.querySelector(".st-pop");
    if (p) { p._close(); return true; }
    return false;
}

// ---------- Редактор ----------
async function stOpenDrawing(id) {
    if (st.doc && st.doc.id === id) return;
    try {
        const row = await stDbLoad(id);
        if (!row) {
            stToast("Этот рисунок уже удалили");
            if (st.doc) stCloseEditor(); else stRenderGallery();
            return;
        }
        stOpenEditor(row);
    } catch (e) {
        console.warn("studio open", e);
        stToast("Не получилось открыть рисунок");
        if (!st.doc && !document.getElementById("stGrid")) stRenderGallery();
    }
}

function stOpenEditor(row) {
    if (st.doc) stCloseEditor(true);
    const doc = stNewDoc(row);
    // Несохранённый черновик (закрыли вкладку без сети) — вливаем
    try {
        const draft = localStorage.getItem(ST_DRAFT_KEY(row.id));
        if (draft && stMergeLines(doc, stParseDocText(draft).lines)) st.dirty = true;
    } catch (e) {}
    st.doc = doc;
    st.undo = [];
    st.redo = [];
    st.live.clear();
    if (location.hash !== "#d=" + doc.id) {
        try { window.history.replaceState(window.history.state, "", "#d=" + doc.id); } catch (e) {}
    }
    stBuildEditor();
    doc.canvas = st.ui.main;
    doc.ctx = st.ui.main.getContext("2d", { willReadFrequently: true });
    doc.pendingIdx = 0;
    stRebuild(doc);
    stFitView();
    stTrack();
    stSendHello();
    stRenderSaveState();
    if (st.dirty) stMarkDirty();
}

function stCloseEditor(silent) {
    if (!st.doc) return;
    stFlushSave();
    stSend("live", { d: st.doc.id, line: null });
    stSend("cur", { d: st.doc.id, x: null });
    const doc = st.doc;
    if (doc.rebuildRaf) cancelAnimationFrame(doc.rebuildRaf);
    // Сохранение уже ушло в полёт со ссылкой на doc, так что его можно отпускать
    st.doc = null;
    stClosePopover();
    if (st.ui) { st.ui.cleanup(); st.ui.root.remove(); st.ui = null; }
    document.documentElement.classList.remove("st-editing");
    document.body.classList.remove("st-editing");
    setShellBack(null);
    try { window.history.replaceState(window.history.state, "", location.pathname + location.search); } catch (e) {}
    stTrack();
    if (!silent) stRenderGallery();
}

function stBuildEditor() {
    const doc = st.doc;
    const root = document.createElement("div");
    root.className = "st-editor";
    root.innerHTML = `
        <header class="st-top">
            <button type="button" class="ui-btn st-icon-btn" data-a="back" aria-label="К рисункам">${stIcon("back")}</button>
            <div class="st-top-mid">
                <button type="button" class="ui-btn st-title" data-a="rename"></button>
                <span class="st-save" data-state="saved">Сохранено</span>
            </div>
            <div class="st-partner" data-a="invite"></div>
            <button type="button" class="ui-btn st-icon-btn" data-a="undo" aria-label="Отменить" title="Отменить (Ctrl+Z)">${stIcon("undo")}</button>
            <button type="button" class="ui-btn st-icon-btn" data-a="redo" aria-label="Вернуть" title="Вернуть (Ctrl+Y)">${stIcon("redo")}</button>
            <button type="button" class="ui-btn st-icon-btn" data-a="menu" aria-label="Ещё">${stIcon("more")}</button>
        </header>
        <nav class="st-tools">
            ${ST_TOOLS.map(t => `<button type="button" class="ui-btn st-tool" data-tool="${t.id}" title="${t.label} (${t.key.toUpperCase()})" aria-label="${t.label}">${stIcon(t.id)}<span class="st-tool-label">${t.label}</span></button>`).join("")}
        </nav>
        <div class="st-viewport">
            <div class="st-stage" style="width:${doc.W}px;height:${doc.H}px">
                <canvas class="st-canvas st-canvas-main" width="${doc.W}" height="${doc.H}"></canvas>
                <canvas class="st-canvas st-canvas-live" width="${doc.W}" height="${doc.H}"></canvas>
                <canvas class="st-canvas st-canvas-preview" width="${doc.W}" height="${doc.H}"></canvas>
                <div class="st-cursor" hidden><i></i><span></span></div>
            </div>
            <div class="st-loupe" hidden></div>
            <div class="st-zoom">
                <button type="button" class="ui-btn st-zoom-btn" data-a="zoomout" aria-label="Уменьшить">${stIcon("minus")}</button>
                <button type="button" class="ui-btn st-zoom-val" data-a="fit" title="Вписать в экран"></button>
                <button type="button" class="ui-btn st-zoom-btn" data-a="zoomin" aria-label="Увеличить">${stIcon("plus")}</button>
            </div>
        </div>
        <div class="st-props">
            <button type="button" class="ui-btn st-color-btn" data-a="color" aria-label="Цвет"><span class="st-color-swatch"></span></button>
            <div class="st-quick-colors"></div>
            <button type="button" class="ui-btn st-shape-btn" data-a="shapes" aria-label="Выбор фигуры"></button>
            <label class="st-width">
                <span class="st-width-dot"><i></i></span>
                <input type="range" class="st-width-range" aria-label="Толщина">
                <span class="st-width-val"></span>
            </label>
        </div>
    `;
    document.body.appendChild(root);
    document.documentElement.classList.add("st-editing");
    document.body.classList.add("st-editing");

    const $ = (s) => root.querySelector(s);
    const ui = {
        root,
        title: $(".st-title"),
        save: $(".st-save"),
        partner: $(".st-partner"),
        viewport: $(".st-viewport"),
        stage: $(".st-stage"),
        main: $(".st-canvas-main"),
        liveCanvas: $(".st-canvas-live"),
        preview: $(".st-canvas-preview"),
        cursor: $(".st-cursor"),
        loupe: $(".st-loupe"),
        zoomVal: $(".st-zoom-val"),
        swatch: $(".st-color-swatch"),
        quick: $(".st-quick-colors"),
        shapeBtn: $(".st-shape-btn"),
        range: $(".st-width-range"),
        widthVal: $(".st-width-val"),
        widthDot: $(".st-width-dot i"),
        undoBtn: $("[data-a=undo]"),
        redoBtn: $("[data-a=redo]"),
        cleanups: [],
    };
    ui.liveCtx = ui.liveCanvas.getContext("2d");
    ui.previewCtx = ui.preview.getContext("2d");
    ui.cleanup = () => ui.cleanups.forEach(fn => fn());
    st.ui = ui;
    ui.title.textContent = doc.title;

    root.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-a]");
        if (!btn || !root.contains(btn)) return;
        const a = btn.dataset.a;
        if (a === "back") stCloseEditor();
        else if (a === "rename") stRename(doc.id, doc.title);
        else if (a === "undo") stUndo();
        else if (a === "redo") stRedo();
        else if (a === "menu") stEditorMenu(btn);
        else if (a === "invite") stInvite();
        else if (a === "zoomin") stZoomBy(1.4);
        else if (a === "zoomout") stZoomBy(1 / 1.4);
        else if (a === "fit") stFitView();
        else if (a === "color") stColorPopover(btn);
        else if (a === "shapes") stShapePopover(btn);
    });
    root.querySelectorAll(".st-tool").forEach(btn => { btn.onclick = () => stSetTool(btn.dataset.tool); });
    ui.range.addEventListener("input", () => {
        st.widths[stWidthKey()] = +ui.range.value;
        stRenderProps();
        stSavePrefs();
    });

    stBindPointer(ui);
    const onKey = (e) => stOnKey(e);
    const onResize = () => { if (st.view.fit) stFitView(); else stApplyView(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", stOnKeyUp);
    window.addEventListener("resize", onResize);
    ui.cleanups.push(() => {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", stOnKeyUp);
        window.removeEventListener("resize", onResize);
    });
    setShellBack(() => { if (!stClosePopover()) stCloseEditor(); });

    stRenderTools();
    stRenderProps();
    stRenderPartner();
    stRenderUndo();
}

function stEditorMenu(anchor) {
    const doc = st.doc;
    stOpenPopover(anchor, "st-pop-menu", (pop, close) => {
        pop.innerHTML = `
            <button type="button" class="ui-btn st-menu-item" data-m="rename">Переименовать</button>
            <button type="button" class="ui-btn st-menu-item" data-m="png">Скачать PNG</button>
            <button type="button" class="ui-btn st-menu-item" data-m="clear">Очистить холст</button>
            <button type="button" class="ui-btn st-menu-item is-danger" data-m="delete">Удалить рисунок</button>
            <div class="st-menu-note"></div>
        `;
        const size = stDocText(doc).length;
        pop.querySelector(".st-menu-note").textContent =
            `${doc.ops.length - doc.dead.size} команд · ${size < 1024 ? size + " Б" : (size / 1024).toFixed(1) + " КБ"} в базе`;
        pop.onclick = async (e) => {
            const m = e.target.closest("[data-m]");
            if (!m) return;
            close();
            if (m.dataset.m === "rename") stRename(doc.id, doc.title);
            else if (m.dataset.m === "png") stDownloadPng(doc);
            else if (m.dataset.m === "clear") {
                if (await stConfirm("Очистить холст?", "Всё нарисованное закрасится белым. Это можно отменить кнопкой ↶.", "Очистить")) {
                    stCommit({ k: "c", c: "ffffff", w: 0, f: 0, pts: [] });
                }
            } else if (m.dataset.m === "delete") stDelete({ id: doc.id, title: doc.title });
        };
    });
}

function stInvite() {
    if (!st.doc || stPartnerHere()) return;
    if (!st.partner) { stToast(`${stPartnerName()} сейчас не в студии`); return; }
    stSend("invite", { d: st.doc.id, title: st.doc.title, name: st.myName });
    stToast(`Позвали ${stPartnerName()} 💌`);
}

function stRenderPartner() {
    if (!st.ui) return;
    const el = st.ui.partner;
    const name = stPartnerName();
    const here = stPartnerHere();
    const online = !!st.partner && st.connected;
    el.className = "st-partner" + (here ? " is-here" : online ? " is-online" : "");
    el.innerHTML = `
        <span class="st-partner-ava">${userAvatarHtml(name)}<i></i></span>
        <span class="st-partner-text">${here ? "рисует с тобой" : online ? "Позвать" : st.connected ? "не в студии" : "нет связи"}</span>
    `;
    el.title = here ? `${name} в этом рисунке` : online ? `Позвать ${name} в этот рисунок` : `${name} не в студии`;
    el.style.setProperty("--pc", here && st.partner.color ? st.partner.color : "");
}

// ---------- Инструменты и свойства ----------
function stWidthKey() {
    return st.tool in ST_STROKE_KIND ? st.tool : "shape";
}

function stSetTool(tool) {
    if (tool !== "picker") st.prevTool = tool;
    st.tool = tool;
    stClosePopover();
    stRenderTools();
    stRenderProps();
    stSavePrefs();
}

function stRenderTools() {
    if (!st.ui) return;
    st.ui.root.querySelectorAll(".st-tool").forEach(b => b.classList.toggle("is-active", b.dataset.tool === st.tool));
    st.ui.viewport.dataset.tool = st.tool;
}

function stRenderProps() {
    const ui = st.ui;
    if (!ui) return;
    ui.swatch.style.background = st.color;
    const key = stWidthKey();
    const lim = ST_WIDTHS[key];
    const showWidth = ["pen", "brush", "marker", "eraser", "shape"].includes(st.tool);
    ui.root.querySelector(".st-width").hidden = !showWidth;
    ui.shapeBtn.hidden = st.tool !== "shape";
    ui.range.min = lim.min; ui.range.max = lim.max;
    ui.range.value = st.widths[key];
    ui.widthVal.textContent = st.widths[key];
    const px = Math.max(2, Math.min(26, st.widths[key] * st.view.s));
    ui.widthDot.style.width = ui.widthDot.style.height = px + "px";
    ui.widthDot.style.background = st.tool === "eraser" ? "#fff" : st.color;
    ui.widthDot.style.opacity = st.tool === "marker" ? 0.6 : 1;
    const shape = ST_SHAPES.find(s => s.id === st.shape);
    ui.shapeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="${st.shapeFill ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${shape.svg}</svg>`;
    // Быстрые цвета: последние использованные, а пока их нет — из палитры
    const quick = (st.recent.length ? st.recent : ST_PALETTE.slice(0, 6)).slice(0, 6);
    ui.quick.innerHTML = quick.map(c => `<button type="button" class="ui-btn st-quick${c.toLowerCase() === st.color.toLowerCase() ? " is-active" : ""}" data-c="${c}" style="--c:${c}" aria-label="Цвет ${c}"></button>`).join("");
    ui.quick.querySelectorAll(".st-quick").forEach(b => { b.onclick = () => stSetColor(b.dataset.c); });
}

function stSetColor(c, remember = true) {
    st.color = c.toLowerCase();
    if (remember) st.recent = [st.color, ...st.recent.filter(x => x !== st.color)].slice(0, 8);
    stRenderProps();
    stSavePrefs();
    stTrack();
}

function stColorPopover(anchor) {
    stOpenPopover(anchor, "st-pop-color", (pop, close) => {
        pop.innerHTML = `
            <div class="st-palette">${ST_PALETTE.map(c => `<button type="button" class="ui-btn st-pal${c === st.color ? " is-active" : ""}" data-c="${c}" style="--c:${c}" aria-label="${c}"></button>`).join("")}</div>
            ${st.recent.length ? `<div class="st-pop-label">Недавние</div><div class="st-palette is-recent">${st.recent.map(c => `<button type="button" class="ui-btn st-pal" data-c="${c}" style="--c:${c}" aria-label="${c}"></button>`).join("")}</div>` : ""}
            <label class="st-custom-color">
                <input type="color" value="${st.color}">
                <span>Свой цвет…</span>
            </label>
        `;
        pop.addEventListener("click", (e) => {
            const b = e.target.closest("[data-c]");
            if (!b) return;
            stSetColor(b.dataset.c);
            if (st.tool === "eraser" || st.tool === "picker" || st.tool === "hand") stSetTool(st.prevTool === "eraser" || st.prevTool === "hand" ? "pen" : st.prevTool);
            close();
        });
        const input = pop.querySelector("input[type=color]");
        input.addEventListener("input", () => stSetColor(input.value, false));
        input.addEventListener("change", () => stSetColor(input.value));
    });
}

function stShapePopover(anchor) {
    stOpenPopover(anchor, "st-pop-shapes", (pop, close) => {
        const render = () => {
            pop.innerHTML = `
                <div class="st-shapes">${ST_SHAPES.map(s => `
                    <button type="button" class="ui-btn st-shape${s.id === st.shape ? " is-active" : ""}" data-s="${s.id}" title="${s.label}" aria-label="${s.label}">
                        <svg viewBox="0 0 24 24" fill="${st.shapeFill && s.id !== "L" && s.id !== "A" ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${s.svg}</svg>
                    </button>`).join("")}
                </div>
                <div class="st-seg">
                    <button type="button" class="ui-btn${st.shapeFill ? "" : " is-active"}" data-fill="0">Контур</button>
                    <button type="button" class="ui-btn${st.shapeFill ? " is-active" : ""}" data-fill="1">Залитая</button>
                </div>
            `;
        };
        render();
        pop.addEventListener("click", (e) => {
            const s = e.target.closest("[data-s]");
            const f = e.target.closest("[data-fill]");
            if (s) { st.shape = s.dataset.s; stRenderProps(); stSavePrefs(); close(); }
            else if (f) { st.shapeFill = f.dataset.fill === "1"; render(); stRenderProps(); stSavePrefs(); }
        });
    });
}

// ---------- Вид: масштаб и сдвиг ----------
function stFitView() {
    const ui = st.ui, doc = st.doc;
    if (!ui || !doc) return;
    const r = ui.viewport.getBoundingClientRect();
    // Окно свёрнуто или ещё не разложено — масштаб вышел бы нулевым или отрицательным
    if (r.width < 40 || r.height < 40) return;
    const pad = r.width < 600 ? 10 : 28;
    const s = Math.min((r.width - pad * 2) / doc.W, (r.height - pad * 2) / doc.H);
    st.view = { s, x: (r.width - doc.W * s) / 2, y: (r.height - doc.H * s) / 2, fit: true, fitS: s };
    stApplyView();
}

function stApplyView() {
    const ui = st.ui;
    if (!ui) return;
    const v = st.view;
    ui.stage.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
    ui.stage.style.setProperty("--inv", 1 / v.s);
    ui.zoomVal.textContent = Math.round(v.s / (v.fitS || v.s) * 100) + "%";
    stRenderProps();
}

function stZoomAt(factor, cx, cy) {
    const v = st.view;
    const fitS = v.fitS || v.s;
    const s = Math.max(fitS * 0.5, Math.min(fitS * 12, v.s * factor));
    const k = s / v.s;
    v.x = cx - (cx - v.x) * k;
    v.y = cy - (cy - v.y) * k;
    v.s = s;
    v.fit = false;
    stClampView();
    stApplyView();
}

function stZoomBy(factor) {
    const r = st.ui.viewport.getBoundingClientRect();
    stZoomAt(factor, r.width / 2, r.height / 2);
}

// Лист не должен уезжать за край целиком — хотя бы 80px остаются на экране
function stClampView() {
    const v = st.view, doc = st.doc;
    const r = st.ui.viewport.getBoundingClientRect();
    const w = doc.W * v.s, h = doc.H * v.s, m = 80;
    v.x = Math.min(r.width - m, Math.max(m - w, v.x));
    v.y = Math.min(r.height - m, Math.max(m - h, v.y));
}

// Экранные координаты → пиксели листа
function stToDoc(e) {
    const r = st.ui.viewport.getBoundingClientRect();
    return { x: (e.clientX - r.left - st.view.x) / st.view.s, y: (e.clientY - r.top - st.view.y) / st.view.s };
}

// ---------- Указатель: рисование, жесты ----------
let stSpaceDown = false;

function stBindPointer(ui) {
    const vp = ui.viewport;
    const pointers = new Map();
    let g = null; // текущее действие: { type: "draw"|"shape"|"tap"|"pick"|"pan"|"pinch", … }
    let lastCursorAt = 0;
    let liveTimer = 0;

    const vpPoint = (e) => { const r = vp.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    const startPinch = () => {
        cancelDraw();
        const [a, b] = Array.from(pointers.values());
        g = { type: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    const cancelDraw = () => {
        if (g && (g.type === "draw" || g.type === "shape")) {
            clearPreview();
            stSend("live", { d: st.doc.id, line: null });
        }
        if (g && g.type === "pick") ui.loupe.hidden = true;
        g = null;
    };
    const clearPreview = () => ui.previewCtx.clearRect(0, 0, st.doc.W, st.doc.H);

    const sendLive = (op) => {
        if (liveTimer) return;
        liveTimer = setTimeout(() => {
            liveTimer = 0;
            if (!g || g.op !== op || !stPartnerHere()) return;
            const pts = op.pts.map(Math.round);
            if (pts.length > 2400) return; // очень длинный мазок покажем уже готовым
            stSend("live", { d: st.doc.id, line: stOpLine(Object.assign({}, op, { t: 0, id: "live00", pts })) });
        }, ST_LIVE_MS);
    };

    const drawPreview = () => {
        if (!g || !g.op) return;
        const ctx = ui.previewCtx, op = g.op;
        clearPreview();
        const col = "#" + op.c;
        if (op.k === "p") stStrokePlain(ctx, op.pts, op.w, col);
        else if (op.k === "e") stStrokePlain(ctx, op.pts, op.w, ST_BG);
        else if (op.k === "b") stStrokeBrush(ctx, op.pts, op.w, col);
        else if (op.k === "m") { ctx.save(); ctx.globalAlpha = 0.55; stStrokePlain(ctx, op.pts, op.w, col); ctx.restore(); }
        else stDrawShape(ctx, op.k, op.pts, op.w, col, op.f);
    };
    let previewRaf = 0;
    const schedulePreview = () => {
        if (previewRaf) return;
        previewRaf = requestAnimationFrame(() => { previewRaf = 0; drawPreview(); });
    };

    const pickAt = (e) => {
        const p = stToDoc(e);
        const x = Math.round(p.x), y = Math.round(p.y);
        if (x < 0 || y < 0 || x >= st.doc.W || y >= st.doc.H) return null;
        const d = st.doc.ctx.getImageData(x, y, 1, 1).data;
        const hex = "#" + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, "0")).join("");
        const vpP = vpPoint(e);
        ui.loupe.hidden = false;
        ui.loupe.style.left = vpP.x + "px";
        ui.loupe.style.top = vpP.y + "px";
        ui.loupe.style.background = hex;
        return hex;
    };

    vp.addEventListener("pointerdown", (e) => {
        if (!st.doc) return;
        if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
        stClosePopover();
        try { vp.setPointerCapture(e.pointerId); } catch (err) {}
        const vpP = vpPoint(e);
        pointers.set(e.pointerId, vpP);
        if (pointers.size === 2) { startPinch(); return; }
        if (pointers.size > 2) return;
        e.preventDefault();

        if (e.button === 1 || stSpaceDown || st.tool === "hand") {
            g = { type: "pan", sx: vpP.x, sy: vpP.y, vx: st.view.x, vy: st.view.y };
            vp.classList.add("is-panning");
            return;
        }
        const p = stToDoc(e);
        if (st.tool in ST_STROKE_KIND) {
            const k = ST_STROKE_KIND[st.tool];
            g = { type: "draw", op: { k, c: st.color.slice(1), w: st.widths[st.tool], f: 0, pts: [p.x, p.y] } };
            schedulePreview();
            sendLive(g.op);
        } else if (st.tool === "shape") {
            g = { type: "shape", op: { k: st.shape, c: st.color.slice(1), w: st.widths.shape, f: st.shapeFill ? 1 : 0, pts: [p.x, p.y, p.x, p.y] } };
        } else if (st.tool === "fill") {
            g = { type: "tap", sx: vpP.x, sy: vpP.y, p };
        } else if (st.tool === "picker") {
            g = { type: "pick", color: pickAt(e) };
        }
    });

    vp.addEventListener("pointermove", (e) => {
        if (!st.doc) return;
        const vpP = vpPoint(e);
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, vpP);

        // Курсор для соседа (мышь — и без нажатия)
        const now = performance.now();
        if (stPartnerHere() && now - lastCursorAt > ST_CURSOR_MS && (!g || g.type !== "draw")) {
            lastCursorAt = now;
            const p = stToDoc(e);
            stSend("cur", { d: st.doc.id, x: Math.round(p.x), y: Math.round(p.y), c: st.color });
        }
        if (!g) return;

        if (g.type === "pinch") {
            if (pointers.size < 2) return;
            const [a, b] = Array.from(pointers.values());
            const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            st.view.x += mx - g.mx;
            st.view.y += my - g.my;
            stZoomAt(dist / g.dist, mx, my);
            g.dist = dist; g.mx = mx; g.my = my;
            return;
        }
        if (g.type === "pan") {
            st.view.x = g.vx + vpP.x - g.sx;
            st.view.y = g.vy + vpP.y - g.sy;
            st.view.fit = false;
            stClampView();
            stApplyView();
            return;
        }
        if (g.type === "pick") { g.color = pickAt(e) || g.color; return; }
        if (g.type === "tap") return;
        if (g.type === "shape") {
            const p = stToDoc(e);
            g.op.pts[2] = p.x; g.op.pts[3] = p.y;
            schedulePreview();
            sendLive(g.op);
            return;
        }
        if (g.type === "draw") {
            const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
            const pts = g.op.pts;
            const minStep = 0.8 / Math.max(1, st.view.s);
            for (const ev of (events.length ? events : [e])) {
                const p = stToDoc(ev);
                const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
                if (Math.hypot(p.x - lx, p.y - ly) < minStep) continue;
                pts.push(p.x, p.y);
            }
            schedulePreview();
            sendLive(g.op);
        }
    });

    const end = (e) => {
        const had = pointers.delete(e.pointerId);
        if (!had || !st.doc) return;
        vp.classList.remove("is-panning");
        if (!g) return;
        if (g.type === "pinch") {
            // Второй палец ещё на экране — рисовать им не начинаем
            if (pointers.size === 0) g = null;
            return;
        }
        const cur = g;
        g = null;
        if (e.type === "pointercancel") { cancelDraw(); return; }
        if (cur.type === "draw") {
            clearPreview();
            let pts = cur.op.pts.map(Math.round);
            pts = stSimplify(pts, 0.75);
            stCommit(Object.assign({}, cur.op, { pts }));
        } else if (cur.type === "shape") {
            clearPreview();
            const pts = cur.op.pts.map(Math.round);
            if (Math.hypot(pts[2] - pts[0], pts[3] - pts[1]) < 3) { stSend("live", { d: st.doc.id, line: null }); return; }
            stCommit(Object.assign({}, cur.op, { pts }));
        } else if (cur.type === "tap") {
            const vpP = vpPoint(e);
            if (Math.hypot(vpP.x - cur.sx, vpP.y - cur.sy) > 12) return;
            const x = Math.round(cur.p.x), y = Math.round(cur.p.y);
            if (x < 0 || y < 0 || x >= st.doc.W || y >= st.doc.H) return;
            stCommit({ k: "f", c: st.color.slice(1), w: 0, f: 0, pts: [x, y] });
        } else if (cur.type === "pick") {
            ui.loupe.hidden = true;
            if (cur.color) {
                stSetColor(cur.color);
                stSetTool(st.prevTool);
            }
        }
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);
    vp.addEventListener("pointerleave", (e) => {
        if (e.pointerType === "mouse" && !pointers.size && stPartnerHere()) stSend("cur", { d: st.doc.id, x: null });
    });

    vp.addEventListener("wheel", (e) => {
        e.preventDefault();
        const vpP = vpPoint(e);
        if (e.ctrlKey || e.metaKey) {
            stZoomAt(Math.exp(-e.deltaY * 0.01), vpP.x, vpP.y);
        } else {
            st.view.x -= e.shiftKey ? e.deltaY : e.deltaX;
            st.view.y -= e.shiftKey ? 0 : e.deltaY;
            st.view.fit = false;
            stClampView();
            stApplyView();
        }
    }, { passive: false });
    vp.addEventListener("contextmenu", (e) => e.preventDefault());
}

function stOnKey(e) {
    if (!st.doc) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || document.querySelector(".st-dialog-overlay")) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && (key === "z" || key === "я")) { e.preventDefault(); if (e.shiftKey) stRedo(); else stUndo(); return; }
    if (mod && (key === "y" || key === "н")) { e.preventDefault(); stRedo(); return; }
    if (mod) return;
    if (e.code === "Space") { stSpaceDown = true; st.ui.viewport.classList.add("is-space"); e.preventDefault(); return; }
    if (e.key === "Escape") { stClosePopover(); return; }
    if (e.key === "[" || e.key === "]") {
        const k = stWidthKey(), lim = ST_WIDTHS[k];
        const step = Math.max(1, Math.round(st.widths[k] * 0.15));
        st.widths[k] = Math.max(lim.min, Math.min(lim.max, st.widths[k] + (e.key === "]" ? step : -step)));
        stRenderProps();
        stSavePrefs();
        return;
    }
    // По физической клавише, чтобы работало и в русской раскладке
    const code = /^Key([A-Z])$/.exec(e.code);
    const tool = code && ST_TOOLS.find(t => t.key === code[1].toLowerCase());
    if (tool) stSetTool(tool.id);
}
function stOnKeyUp(e) {
    if (e.code === "Space") { stSpaceDown = false; if (st.ui) st.ui.viewport.classList.remove("is-space"); }
}

// ---------- Команды: добавить, отменить, вернуть ----------
function stCommit(base) {
    const doc = st.doc;
    if (!doc) return;
    const op = Object.assign({}, base, { t: doc.clock + 1, id: stRandId() });
    op.line = stOpLine(op);
    stMergeLines(doc, [op.line]);
    st.undo.push(op.id);
    st.redo = [];
    stSend("op", { d: doc.id, line: op.line });
    stMarkDirty();
    stRenderUndo();
}

function stUndo() {
    const doc = st.doc;
    if (!doc) return;
    while (st.undo.length) {
        const id = st.undo.pop();
        const op = doc.byId.get(id);
        if (!op || doc.dead.has(id)) continue;
        const line = "x " + id;
        stMergeLines(doc, [line]);
        st.redo.push(op.line);
        stSend("op", { d: doc.id, line });
        stMarkDirty();
        break;
    }
    stRenderUndo();
}

function stRedo() {
    const doc = st.doc;
    if (!doc || !st.redo.length) return;
    const op = stParseLine(st.redo.pop());
    const keepRedo = st.redo;
    if (op && !op.tomb) stCommit({ k: op.k, c: op.c, w: op.w, f: op.f, pts: op.pts });
    st.redo = keepRedo;
    stRenderUndo();
}

function stRenderUndo() {
    if (!st.ui || !st.doc) return;
    st.ui.undoBtn.disabled = !st.undo.some(id => st.doc.byId.has(id) && !st.doc.dead.has(id));
    st.ui.redoBtn.disabled = !st.redo.length;
}

// ---------- Сосед: его мазок в процессе и курсор ----------
function stDrawLive() {
    const ui = st.ui, doc = st.doc;
    if (!ui || !doc) return;
    const ctx = ui.liveCtx;
    ctx.clearRect(0, 0, doc.W, doc.H);
    for (const op of st.live.values()) {
        const col = "#" + op.c;
        if (op.k === "m") { ctx.save(); ctx.globalAlpha = 0.55; stStrokePlain(ctx, op.pts, op.w, col); ctx.restore(); }
        else if (op.k === "e") stStrokePlain(ctx, op.pts, op.w, ST_BG);
        else if (op.k === "p") stStrokePlain(ctx, op.pts, op.w, col);
        else if (op.k === "b") stStrokeBrush(ctx, op.pts, op.w, col);
        else if (ST_SHAPE_KINDS.has(op.k)) stDrawShape(ctx, op.k, op.pts, op.w, col, op.f);
    }
}

let stCursorHideTimer = 0;
function stShowCursor(x, y, color) {
    const ui = st.ui;
    if (!ui) return;
    const el = ui.cursor;
    el.hidden = false;
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.setProperty("--cc", /^#[0-9a-f]{6}$/i.test(color || "") ? color : "#ff2e93");
    el.querySelector("span").textContent = stPartnerName();
    clearTimeout(stCursorHideTimer);
    stCursorHideTimer = setTimeout(stHideCursor, 4000);
}
function stHideCursor() {
    if (st.ui) st.ui.cursor.hidden = true;
}
