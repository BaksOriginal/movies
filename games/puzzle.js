// ==========================================
// puzzle.js — ПАЗЛ ИЗ ПОСТЕРА
// ==========================================
// Подключается после games.js. Картинка — любой постер из каталога (у
// которого он есть): выбранный вручную или случайный «сюрприз», название
// которого откроется только в конце. Три сложности — 24, 54 и 96 деталей.
//
// Детали — SVG: каждая показывает тот же постер, обрезанный по контуру с
// выступами и пазами (clip-path), так что канвас и CORS не нужны. Деталь
// примагничивается, если отпустить её рядом с её местом на поле.
// Незаконченная партия сохраняется в localStorage.

const PUZZLE_LEVELS = {
    easy: { name: "Лёгкий", cols: 4, rows: 6, dots: 1, ghost: true, desc: "24 детали, на поле видна бледная подсказка" },
    medium: { name: "Средний", cols: 6, rows: 9, dots: 2, ghost: false, desc: "54 детали" },
    hard: { name: "Сложный", cols: 8, rows: 12, dots: 3, ghost: false, desc: "96 деталей — для терпеливых" },
};
const PZ_SAVE_KEY = "puzzleGame:v1";
const PZ_BEST_KEY = "puzzleBest:v1";
const PZ_IMG = "https://image.tmdb.org/t/p/w780";
const PZ_THUMB = "https://image.tmdb.org/t/p/w185";
const PZ_CELL = 100;            // размер клетки в единицах SVG
const PZ_PAD = 26;              // запас под выступы вокруг клетки (выступ — 24)
const PZ_SNAP = 0.3;            // насколько близко (в долях клетки) нужно отпустить деталь

// Форма выступа: кубические кривые после прямого участка 0…0.38 вдоль края.
// u — вдоль края, v — наружу (в долях клетки). Форма симметрична, поэтому
// у соседней детали тот же край, пройденный в обратную сторону, совпадает.
const PZ_TAB = [
    [0.42, 0, 0.43, 0.04, 0.41, 0.08],
    [0.36, 0.16, 0.40, 0.24, 0.50, 0.24],
    [0.60, 0.24, 0.64, 0.16, 0.59, 0.08],
    [0.57, 0.04, 0.58, 0, 0.62, 0],
];

let pzPosters = null;   // [{ title, year, path }] из каталога
let pzChoice = null;    // выбранный в меню постер или null — «сюрприз»

function pzLoadSaved() {
    try {
        const s = JSON.parse(localStorage.getItem(PZ_SAVE_KEY) || "null");
        return s && PUZZLE_LEVELS[s.level] && Array.isArray(s.placed) ? s : null;
    } catch (e) { return null; }
}
function pzSave(state) { try { localStorage.setItem(PZ_SAVE_KEY, JSON.stringify(state)); } catch (e) {} }
function pzClearSaved() { try { localStorage.removeItem(PZ_SAVE_KEY); } catch (e) {} }
function pzLoadBest() { try { return JSON.parse(localStorage.getItem(PZ_BEST_KEY) || "{}") || {}; } catch (e) { return {}; } }
function pzSaveBest(best) { try { localStorage.setItem(PZ_BEST_KEY, JSON.stringify(best)); } catch (e) {} }
function pzFormatTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
}

function puzzleTileText() {
    const saved = pzLoadSaved();
    if (saved) return `На паузе · собрано ${saved.placed.filter(Boolean).length}/${saved.placed.length}`;
    const best = pzLoadBest();
    const parts = Object.keys(PUZZLE_LEVELS).filter(k => best[k]).map(k => `${PUZZLE_LEVELS[k].name[0]} ${pzFormatTime(best[k].time)}`);
    return parts.length ? `Лучшее: ${parts.join(" · ")}` : "Любой постер с сайта · 3 сложности";
}

async function pzLoadPosters() {
    if (pzPosters) return pzPosters;
    const { data, error } = await db.from("titles").select("title, year, poster_path").not("poster_path", "is", null);
    if (error) throw error;
    const seen = new Set();
    pzPosters = (data || [])
        .filter(r => r.poster_path && !seen.has(r.poster_path) && seen.add(r.poster_path))
        .map(r => ({ title: r.title, year: r.year, path: r.poster_path }))
        .sort((a, b) => a.title.localeCompare(b.title, "ru"));
    return pzPosters;
}

// ---------- Меню ----------
async function showPuzzleMenu() {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);
    app.innerHTML = "";
    const title = document.createElement("h1");
    setEmojiTitle(title, "🧩 Пазл");
    app.appendChild(title);

    const menu = document.createElement("div");
    menu.className = "sdk-menu pz-menu";
    app.appendChild(menu);

    const saved = pzLoadSaved();
    if (saved) {
        const done = saved.placed.filter(Boolean).length;
        const resume = document.createElement("button");
        resume.type = "button";
        resume.className = "ui-btn sdk-resume";
        resume.innerHTML = `
            <span class="sdk-resume-icon">▶</span>
            <span class="sdk-resume-body">
                <span class="sdk-resume-title">Продолжить пазл</span>
                <span class="sdk-resume-sub">${PUZZLE_LEVELS[saved.level].name} · ${pzFormatTime(saved.elapsed)} · собрано ${done}/${saved.placed.length}</span>
            </span>
            <span class="sdk-resume-bar"><span style="width:${done / saved.placed.length * 100}%"></span></span>
        `;
        resume.onclick = () => startPuzzleGame(saved);
        menu.appendChild(resume);
    }

    const pickLabel = document.createElement("div");
    pickLabel.className = "sdk-menu-label";
    pickLabel.textContent = "Картинка";
    menu.appendChild(pickLabel);

    const pick = document.createElement("div");
    pick.className = "pz-pick";
    menu.appendChild(pick);
    const renderPick = () => {
        const c = pzChoice;
        pick.innerHTML = `
            <span class="pz-pick-thumb">${c ? `<img src="${PZ_THUMB + c.path}" alt="">` : "🎲"}</span>
            <span class="pz-pick-body">
                <span class="pz-pick-title"></span>
                <span class="pz-pick-sub">${c ? (c.year || "") : "Случайный постер из каталога — название откроется, когда соберёшь"}</span>
            </span>
            <span class="pz-pick-actions">
                <button type="button" class="ui-btn ui-pill" data-a="choose">Выбрать постер</button>
                ${c ? `<button type="button" class="ui-btn ui-pill" data-a="random">🎲 Сюрприз</button>` : ""}
            </span>
        `;
        pick.querySelector(".pz-pick-title").textContent = c ? c.title : "Сюрприз";
        pick.querySelector("[data-a=choose]").onclick = () => pzOpenPicker((p) => { pzChoice = p; renderPick(); });
        const rnd = pick.querySelector("[data-a=random]");
        if (rnd) rnd.onclick = () => { pzChoice = null; renderPick(); };
    };
    renderPick();

    const label = document.createElement("div");
    label.className = "sdk-menu-label";
    label.textContent = saved ? "Или новый пазл" : "Сложность";
    menu.appendChild(label);

    const best = pzLoadBest();
    const grid = document.createElement("div");
    grid.className = "sdk-levels";
    Object.entries(PUZZLE_LEVELS).forEach(([key, lvl]) => {
        const b = best[key];
        const card = document.createElement("button");
        card.type = "button";
        card.className = `ui-btn sdk-level sdk-level-${key}`;
        card.innerHTML = `
            <span class="sdk-level-dots">${[1, 2, 3].map(n => `<i class="${n <= lvl.dots ? "on" : ""}"></i>`).join("")}</span>
            <span class="sdk-level-name">${lvl.name}</span>
            <span class="sdk-level-desc">${lvl.desc}</span>
            <span class="sdk-level-best">${b ? `🏆 ${pzFormatTime(b.time)} · собрано: ${b.wins}` : "Ещё не собирали"}</span>
        `;
        card.onclick = () => {
            if (saved && !confirm("Начать новый пазл? Незаконченный будет потерян.")) return;
            newPuzzleGame(key);
        };
        grid.appendChild(card);
    });
    menu.appendChild(grid);

    const rules = document.createElement("p");
    rules.className = "sdk-rules";
    rules.textContent = "Перетаскивай детали на поле — отпущенная рядом со своим местом деталь встанет туда сама. Кнопка «Края» оставляет на столе только детали рамки.";
    menu.appendChild(rules);
}

function pzOpenPicker(onPick) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
        <div class="modal-content pz-picker">
            <div class="pz-picker-head">
                <div class="pz-picker-title">Выбери постер</div>
                <input type="search" class="pz-picker-search" placeholder="Поиск по названию" autocomplete="off">
            </div>
            <div class="pz-picker-grid"><div class="pz-picker-empty">Загружаю постеры…</div></div>
        </div>
    `;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    const gridEl = overlay.querySelector(".pz-picker-grid");
    const search = overlay.querySelector(".pz-picker-search");
    let list = [];
    const render = () => {
        const q = search.value.trim().toLowerCase();
        const shown = q ? list.filter(p => p.title.toLowerCase().includes(q)) : list;
        if (!shown.length) {
            gridEl.innerHTML = `<div class="pz-picker-empty">${list.length ? "Ничего не нашлось" : "В каталоге пока нет постеров"}</div>`;
            return;
        }
        gridEl.innerHTML = shown.map((p, k) => `
            <button type="button" class="ui-btn pz-picker-item" data-k="${list.indexOf(p)}">
                <img loading="lazy" src="${PZ_THUMB + p.path}" alt="">
                <span>${escapeGameText(p.title)}</span>
            </button>`).join("");
    };
    gridEl.addEventListener("click", (e) => {
        const b = e.target.closest("[data-k]");
        if (!b) return;
        overlay.remove();
        onPick(list[+b.dataset.k]);
    });
    search.addEventListener("input", render);
    pzLoadPosters().then((p) => { list = p; render(); }).catch(() => {
        gridEl.innerHTML = `<div class="pz-picker-empty">Не получилось загрузить каталог</div>`;
    });
}

async function newPuzzleGame(levelKey) {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);
    app.innerHTML = `<div class="sdk-loading"><div class="sdk-loading-grid">${"<i></i>".repeat(9)}</div>Режу постер на детали…</div>`;
    let poster = pzChoice;
    try {
        if (!poster) {
            const list = await pzLoadPosters();
            if (!list.length) { alert("В каталоге пока нет ни одного постера."); showPuzzleMenu(); return; }
            poster = list[Math.floor(Math.random() * list.length)];
        }
    } catch (e) {
        alert("Не получилось загрузить каталог. Проверь интернет.");
        showPuzzleMenu();
        return;
    }
    const lvl = PUZZLE_LEVELS[levelKey];
    const rnd = () => (Math.random() < 0.5 ? -1 : 1);
    startPuzzleGame({
        level: levelKey,
        path: poster.path,
        title: poster.title,
        year: poster.year || null,
        surprise: !pzChoice,
        eh: Array.from({ length: (lvl.rows - 1) * lvl.cols }, rnd),
        ev: Array.from({ length: lvl.rows * (lvl.cols - 1) }, rnd),
        placed: new Array(lvl.cols * lvl.rows).fill(0),
        pos: null,
        elapsed: 0,
        ghost: lvl.ghost,
    });
}

// Контур детали (r, c) в координатах всей картинки
function pzPiecePath(S, r, c) {
    const { cols, rows } = PUZZLE_LEVELS[S.level];
    const x = c * PZ_CELL, y = r * PZ_CELL, L = PZ_CELL;
    const top = r === 0 ? 0 : -S.eh[(r - 1) * cols + c];
    const bottom = r === rows - 1 ? 0 : S.eh[r * cols + c];
    const left = c === 0 ? 0 : -S.ev[r * (cols - 1) + c - 1];
    const right = c === cols - 1 ? 0 : S.ev[r * (cols - 1) + c];
    const f = (n) => Math.round(n * 10) / 10;
    const edge = (sx, sy, ex, ey, nx, ny, sign) => {
        if (!sign) return `L${f(ex)} ${f(ey)}`;
        const dx = ex - sx, dy = ey - sy;
        const pt = (u, v) => `${f(sx + dx * u + nx * v * L * sign)} ${f(sy + dy * u + ny * v * L * sign)}`;
        let d = `L${pt(0.38, 0)}`;
        PZ_TAB.forEach(([a, b, cc, dd, u, v]) => { d += `C${pt(a, b)} ${pt(cc, dd)} ${pt(u, v)}`; });
        return d + `L${f(ex)} ${f(ey)}`;
    };
    return `M${x} ${y}` +
        edge(x, y, x + L, y, 0, -1, top) +
        edge(x + L, y, x + L, y + L, 1, 0, right) +
        edge(x + L, y + L, x, y + L, 0, 1, bottom) +
        edge(x, y + L, x, y, -1, 0, left) + "Z";
}

// ---------- Партия ----------
function startPuzzleGame(state) {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);
    setShellBack(() => showPuzzleMenu(), "Пазл");

    const S = state;
    const lvl = PUZZLE_LEVELS[S.level];
    const { cols, rows } = lvl;
    const total = cols * rows;
    const imgUrl = PZ_IMG + S.path;
    let finished = false;
    let runStart = performance.now();
    let paused = false;

    app.innerHTML = "";
    const root = document.createElement("div");
    root.className = "pz-game";
    root.innerHTML = `
        <div class="pz-hud">
            <span class="pz-hud-stat"><b id="pzTime">0:00</b><small>время</small></span>
            <span class="pz-hud-stat"><b id="pzCount">0/${total}</b><small>собрано</small></span>
            <span class="pz-hud-tools">
                <button type="button" class="ui-btn pz-tool" id="pzGhost" title="Бледная картинка на поле">👁<span>Подсказка</span></button>
                <button type="button" class="ui-btn pz-tool" id="pzEdges" title="Только детали рамки">⬚<span>Края</span></button>
                <button type="button" class="ui-btn pz-tool" id="pzSpread" title="Разложить детали заново">🔀<span>Разложить</span></button>
            </span>
        </div>
        <div class="pz-field" id="pzField">
            <div class="pz-board" id="pzBoard"><div class="pz-ghost" style="background-image:url('${imgUrl}')"></div></div>
            <div class="pz-loading">Загружаю постер…</div>
        </div>
    `;
    app.appendChild(root);
    document.documentElement.classList.add("pz-playing");
    document.body.classList.add("pz-playing");

    const field = root.querySelector("#pzField");
    const board = root.querySelector("#pzBoard");
    const timeEl = root.querySelector("#pzTime");
    const countEl = root.querySelector("#pzCount");
    let layout = null;  // { W, H, bx, by, cell }
    const pieces = [];  // { el, r, c, i, edge }
    let zTop = 10;

    function fit() {
        if (!root.isConnected) return;
        window.scrollTo(0, 0);
        const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        root.style.height = Math.max(380, vh - root.getBoundingClientRect().top - 12) + "px";
    }

    function computeLayout() {
        const W = field.clientWidth, H = field.clientHeight;
        const m = 10, ratio = cols / rows;
        let bw, bh, bx, by;
        if (W > H * 0.95) {
            bh = H - m * 2; bw = bh * ratio;
            if (bw > W * 0.52) { bw = W * 0.52; bh = bw / ratio; }
            bx = m + 4; by = (H - bh) / 2;
        } else {
            bw = Math.min(W - m * 2, H * 0.56 * ratio); bh = bw / ratio;
            bx = (W - bw) / 2; by = m;
        }
        layout = { W, H, bx, by, cell: bw / cols, bw, bh };
        board.style.left = bx + "px";
        board.style.top = by + "px";
        board.style.width = bw + "px";
        board.style.height = bh + "px";
    }

    // Случайное место на столе: подальше от поля, но в пределах экрана
    function randomSpot() {
        const { W, H, bx, by, bw, bh, cell } = layout;
        let best = null, bestOverlap = Infinity;
        for (let t = 0; t < 40; t++) {
            const x = Math.random() * Math.max(1, W - cell), y = Math.random() * Math.max(1, H - cell);
            const ox = Math.max(0, Math.min(x + cell, bx + bw) - Math.max(x, bx));
            const oy = Math.max(0, Math.min(y + cell, by + bh) - Math.max(y, by));
            const overlap = ox * oy;
            if (overlap < bestOverlap) { bestOverlap = overlap; best = [x / W, y / H]; }
            if (!overlap) break;
        }
        return best;
    }

    function place(p) {
        const { W, H, bx, by, cell } = layout;
        const scale = cell / PZ_CELL;
        const size = (PZ_CELL + PZ_PAD * 2) * scale;
        let x, y;
        if (S.placed[p.i]) { x = bx + p.c * cell; y = by + p.r * cell; }
        else { x = S.pos[p.i][0] * W; y = S.pos[p.i][1] * H; }
        p.el.style.width = p.el.style.height = size + "px";
        p.el.style.transform = `translate3d(${x - PZ_PAD * scale}px, ${y - PZ_PAD * scale}px, 0)`;
    }

    function build() {
        const uid = Math.random().toString(36).slice(2, 7);
        const frag = document.createDocumentFragment();
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const i = r * cols + c;
                const d = pzPiecePath(S, r, c);
                const el = document.createElement("div");
                const edge = r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
                el.className = "pz-piece" + (edge ? " is-edge" : "") + (S.placed[i] ? " is-placed" : "");
                el.dataset.i = i;
                el.innerHTML = `<svg viewBox="${c * PZ_CELL - PZ_PAD} ${r * PZ_CELL - PZ_PAD} ${PZ_CELL + PZ_PAD * 2} ${PZ_CELL + PZ_PAD * 2}" aria-hidden="true">
                    <defs><clipPath id="pzc${uid}${i}"><path d="${d}"/></clipPath></defs>
                    <image href="${imgUrl}" x="0" y="0" width="${cols * PZ_CELL}" height="${rows * PZ_CELL}" preserveAspectRatio="xMidYMid slice" clip-path="url(#pzc${uid}${i})"/>
                    <path class="pz-edge" d="${d}"/>
                    <path class="pz-hit" d="${d}"/>
                </svg>`;
                el.style.zIndex = S.placed[i] ? 1 : ++zTop;
                pieces.push({ el, r, c, i, edge });
                frag.appendChild(el);
            }
        }
        field.appendChild(frag);
    }

    function layoutAll() {
        computeLayout();
        pieces.forEach(place);
    }

    function renderHud() {
        const n = S.placed.filter(Boolean).length;
        countEl.textContent = `${n}/${total}`;
        root.querySelector("#pzGhost").classList.toggle("is-on", !!S.ghost);
        board.classList.toggle("is-ghost", !!S.ghost);
    }
    function elapsedNow() { return S.elapsed + (paused || finished ? 0 : performance.now() - runStart); }
    function renderTime() { timeEl.textContent = pzFormatTime(elapsedNow()); }
    function save() {
        if (finished) return;
        S.elapsed = elapsedNow();
        runStart = performance.now();
        pzSave(S);
    }

    // ---------- Перетаскивание ----------
    let drag = null;
    field.addEventListener("pointerdown", (e) => {
        if (finished || drag) return;
        const pieceEl = e.target.closest(".pz-piece");
        if (!pieceEl || pieceEl.classList.contains("is-placed")) return;
        e.preventDefault();
        const p = pieces[+pieceEl.dataset.i];
        const fr = field.getBoundingClientRect();
        const { W, H } = layout;
        drag = {
            p, id: e.pointerId,
            dx: e.clientX - fr.left - S.pos[p.i][0] * W,
            dy: e.clientY - fr.top - S.pos[p.i][1] * H,
        };
        try { field.setPointerCapture(e.pointerId); } catch (err) {}
        pieceEl.style.zIndex = ++zTop;
        pieceEl.classList.add("is-dragging");
        vibrate(5);
    });
    field.addEventListener("pointermove", (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const fr = field.getBoundingClientRect();
        const { W, H, cell } = layout;
        const x = Math.max(-cell * 0.3, Math.min(W - cell * 0.7, e.clientX - fr.left - drag.dx));
        const y = Math.max(-cell * 0.3, Math.min(H - cell * 0.7, e.clientY - fr.top - drag.dy));
        S.pos[drag.p.i] = [x / W, y / H];
        place(drag.p);
    });
    const endDrag = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const p = drag.p;
        drag = null;
        p.el.classList.remove("is-dragging");
        const { W, H, bx, by, cell } = layout;
        const x = S.pos[p.i][0] * W, y = S.pos[p.i][1] * H;
        const tx = bx + p.c * cell, ty = by + p.r * cell;
        if (Math.hypot(x - tx, y - ty) < cell * PZ_SNAP) {
            S.placed[p.i] = 1;
            p.el.classList.add("is-placed", "is-snap");
            p.el.style.zIndex = 1;
            setTimeout(() => p.el.classList.remove("is-snap"), 500);
            place(p);
            vibrate(12);
            if (typeof beep === "function") { beep(880, 50, "sine", 0.05); beep(1320, 70, "sine", 0.04, 45); }
            renderHud();
            if (S.placed.every(Boolean)) finish();
            else save();
        }
    };
    field.addEventListener("pointerup", endDrag);
    field.addEventListener("pointercancel", endDrag);

    root.querySelector("#pzGhost").onclick = () => { S.ghost = !S.ghost; renderHud(); save(); };
    root.querySelector("#pzEdges").onclick = (e) => {
        const on = field.classList.toggle("is-edges");
        e.currentTarget.classList.toggle("is-on", on);
    };
    root.querySelector("#pzSpread").onclick = () => {
        pieces.forEach(p => { if (!S.placed[p.i]) { S.pos[p.i] = randomSpot(); place(p); } });
        save();
    };

    function finish() {
        finished = true;
        S.elapsed = S.elapsed + performance.now() - runStart;
        pzClearSaved();
        const best = pzLoadBest();
        const prev = best[S.level];
        const isRecord = !prev || S.elapsed < prev.time;
        best[S.level] = { time: isRecord ? S.elapsed : prev.time, wins: (prev ? prev.wins : 0) + 1 };
        pzSaveBest(best);
        renderTime();
        board.classList.add("is-done");
        field.classList.add("is-done");
        if (typeof beep === "function") [523, 659, 784, 1047].forEach((f, k) => beep(f, 140, "triangle", 0.06, k * 110));
        vibrate([20, 60, 20, 60, 40]);
        setTimeout(() => {
            if (!root.isConnected) return;
            const overlay = document.createElement("div");
            overlay.className = "modal-overlay";
            overlay.id = "gameOverModal";
            overlay.innerHTML = `
                <div class="modal-content gameover pz-done${isRecord ? " gameover-record" : ""}">
                    <div class="gameover-kicker">${isRecord ? "🏆 Новый рекорд!" : "🧩 Пазл собран!"}</div>
                    <img class="pz-done-poster" src="${PZ_THUMB + S.path}" alt="">
                    <div class="pz-done-title"></div>
                    <div class="pz-done-sub">${lvl.name} · ${total} деталей · ${pzFormatTime(S.elapsed)}</div>
                    <div class="pz-done-actions">
                        <button type="button" class="ui-btn ui-pill ui-pill-accent" id="pzAgain">Ещё пазл</button>
                        <button type="button" class="ui-btn ui-pill" id="pzToGames">К играм</button>
                    </div>
                </div>
            `;
            overlay.querySelector(".pz-done-title").textContent = S.surprise ? `Это был «${S.title}»${S.year ? ` (${S.year})` : ""}` : S.title;
            overlay.querySelector("#pzAgain").onclick = () => { overlay.remove(); showPuzzleMenu(); };
            overlay.querySelector("#pzToGames").onclick = () => { overlay.remove(); showGamesScreen(); };
            overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
            document.body.appendChild(overlay);
        }, 1100);
    }

    function visibilityHandler() {
        if (document.hidden) { save(); paused = true; }
        else if (paused) { paused = false; runStart = performance.now(); }
    }
    const onResize = () => { fit(); if (layout) layoutAll(); };
    document.addEventListener("visibilitychange", visibilityHandler);
    window.addEventListener("resize", onResize);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", onResize);
    const timer = setInterval(renderTime, 500);
    const autosave = setInterval(save, 8000);

    activeGameCleanup = () => {
        save();
        clearInterval(timer);
        clearInterval(autosave);
        document.removeEventListener("visibilitychange", visibilityHandler);
        window.removeEventListener("resize", onResize);
        if (window.visualViewport) window.visualViewport.removeEventListener("resize", onResize);
        document.documentElement.classList.remove("pz-playing");
        document.body.classList.remove("pz-playing");
        document.getElementById("gameOverModal")?.remove();
    };

    fit();
    renderHud();
    // Сначала дожидаемся постера, чтобы детали не появились пустыми
    const img = new Image();
    const begin = () => {
        if (!root.isConnected) return;
        field.querySelector(".pz-loading")?.remove();
        computeLayout();
        if (!S.pos) S.pos = Array.from({ length: total }, () => randomSpot());
        build();
        layoutAll();
        runStart = performance.now();
        save();
    };
    img.onload = begin;
    img.onerror = begin;
    img.src = imgUrl;
}
