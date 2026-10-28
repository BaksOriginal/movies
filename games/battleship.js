// ==========================================
// battleship.js — МОРСКОЙ БОЙ ВДВОЁМ
// ==========================================
// Подключается после duo.js. Сначала оба расставляют флот (корабли не
// касаются друг друга даже углами), потом стреляют по очереди. Попал —
// стреляешь ещё; потопил — клетки вокруг корабля отмечаются сами.
//
// Партия целиком (включая чужую расстановку) лежит в состоянии комнаты у
// обоих — как и рука соперника в дураке, на экране её не показываем.

const BS_VARIANTS = {
    classic: { size: 10, fleet: [4, 3, 3, 2, 2, 2, 1, 1, 1, 1] },
    quick: { size: 8, fleet: [3, 2, 2, 1, 1, 1] }
};
const BS_SHIP_NAMES = { 1: "однопалубный", 2: "двухпалубный", 3: "трёхпалубный", 4: "четырёхпалубный" };
// Состояния клеток в shots: 0 — не стреляли, 1 — мимо, 2 — ранен, 3 — потоплен, 4 — пусто рядом с потопленным
const BS_MISS = 1, BS_HIT = 2, BS_SUNK = 3, BS_AUTO = 4;

function bsCells(size, ship) {
    const cells = [];
    for (let k = 0; k < ship.l; k++) {
        const r = ship.r + (ship.d === "v" ? k : 0);
        const c = ship.c + (ship.d === "h" ? k : 0);
        if (r < 0 || c < 0 || r >= size || c >= size) return null;
        cells.push(r * size + c);
    }
    return cells;
}

// Расстановка корректна: те корабли, что положены по правилам, в поле,
// не пересекаются и не касаются. Возвращает занятость клеток или null.
function bsValidate(size, fleet, ships) {
    if (!Array.isArray(ships) || ships.length !== fleet.length) return null;
    const lens = ships.map(s => s && s.l).sort((a, b) => b - a);
    const need = fleet.slice().sort((a, b) => b - a);
    if (lens.some((l, k) => l !== need[k])) return null;
    const owner = new Array(size * size).fill(-1);
    for (let n = 0; n < ships.length; n++) {
        const s = ships[n];
        if (!Number.isInteger(s.r) || !Number.isInteger(s.c) || (s.d !== "h" && s.d !== "v")) return null;
        const cells = bsCells(size, s);
        if (!cells) return null;
        for (const i of cells) {
            const r = Math.floor(i / size), c = i % size;
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                const rr = r + dr, cc = c + dc;
                if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
                const o = owner[rr * size + cc];
                if (o !== -1 && o !== n) return null;
            }
        }
        cells.forEach(i => { owner[i] = n; });
    }
    return owner;
}

// Можно ли поставить корабль s к уже стоящим (для ручной расстановки)
function bsFits(size, placed, s) {
    const cells = bsCells(size, s);
    if (!cells) return false;
    const taken = new Set();
    placed.forEach(p => bsCells(size, p).forEach(i => taken.add(i)));
    return cells.every(i => {
        const r = Math.floor(i / size), c = i % size;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && cc >= 0 && rr < size && cc < size && taken.has(rr * size + cc)) return false;
        }
        return true;
    });
}

function bsRandomFleet(size, fleet) {
    for (let attempt = 0; attempt < 60; attempt++) {
        const placed = [];
        let ok = true;
        for (const l of fleet.slice().sort((a, b) => b - a)) {
            let done = false;
            for (let t = 0; t < 300 && !done; t++) {
                const d = Math.random() < 0.5 ? "h" : "v";
                const s = {
                    l, d,
                    r: Math.floor(Math.random() * (size - (d === "v" ? l - 1 : 0))),
                    c: Math.floor(Math.random() * (size - (d === "h" ? l - 1 : 0)))
                };
                if (bsFits(size, placed, s)) { placed.push(s); done = true; }
            }
            if (!done) { ok = false; break; }
        }
        if (ok) return placed;
    }
    return null;
}

function bsNewGame(players, options) {
    const variant = options.variant in BS_VARIANTS ? options.variant : "classic";
    const v = BS_VARIANTS[variant];
    return {
        players,
        variant,
        size: v.size,
        fleet: v.fleet.slice(),
        phase: "place",
        ships: { [players[0]]: null, [players[1]]: null },
        shots: { [players[0]]: new Array(v.size * v.size).fill(0), [players[1]]: new Array(v.size * v.size).fill(0) },
        turn: null,
        last: null,
        over: null
    };
}

function bsApply(state, actor, action) {
    if (state.over || !state.players.includes(actor)) return null;
    const opp = state.players.find(p => p !== actor);
    if (action.type === "place") {
        if (state.phase !== "place" || state.ships[actor]) return null;
        const ships = (action.ships || []).map(s => ({ r: s.r, c: s.c, d: s.d, l: s.l }));
        if (!bsValidate(state.size, state.fleet, ships)) return null;
        const s = JSON.parse(JSON.stringify(state));
        s.ships[actor] = ships;
        if (s.ships[opp]) {
            s.phase = "battle";
            s.turn = s.players[Math.floor(Math.random() * 2)];
        }
        return s;
    }
    if (action.type === "fire") {
        const i = action.i;
        if (state.phase !== "battle" || actor !== state.turn) return null;
        if (!Number.isInteger(i) || i < 0 || i >= state.size * state.size || state.shots[actor][i]) return null;
        const s = JSON.parse(JSON.stringify(state));
        const size = s.size;
        const shots = s.shots[actor];
        const ship = s.ships[opp].find(sh => bsCells(size, sh).includes(i));
        if (!ship) {
            shots[i] = BS_MISS;
            s.turn = opp;
            s.last = { by: actor, i, res: "miss" };
            return s;
        }
        shots[i] = BS_HIT;
        const cells = bsCells(size, ship);
        if (cells.every(k => shots[k] === BS_HIT || shots[k] === BS_SUNK)) {
            cells.forEach(k => {
                shots[k] = BS_SUNK;
                const r = Math.floor(k / size), c = k % size;
                for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                    const rr = r + dr, cc = c + dc;
                    if (rr >= 0 && cc >= 0 && rr < size && cc < size && !shots[rr * size + cc]) shots[rr * size + cc] = BS_AUTO;
                }
            });
            s.last = { by: actor, i, res: "sunk", l: ship.l };
            const allSunk = s.ships[opp].every(sh => bsCells(size, sh).every(k => shots[k] === BS_SUNK));
            if (allSunk) s.over = { winner: actor, loser: opp, reason: "fleet" };
        } else {
            s.last = { by: actor, i, res: "hit" };
        }
        return s;
    }
    return null;
}

// Сколько кораблей у игрока ещё на плаву
function bsAfloat(state, uid) {
    const ships = state.ships[uid];
    if (!ships) return state.fleet.length;
    const opp = state.players.find(p => p !== uid);
    const shots = state.shots[opp];
    return ships.filter(sh => !bsCells(state.size, sh).every(k => shots[k] === BS_SUNK)).length;
}

function bsSound(kind) {
    if (typeof beep !== "function") return;
    if (kind === "miss") { beep(330, 70, "sine", 0.06); beep(220, 140, "sine", 0.05, 60); }
    else if (kind === "hit") { beep(160, 90, "sawtooth", 0.07); beep(90, 200, "square", 0.05, 70); }
    else if (kind === "sunk") { beep(140, 110, "sawtooth", 0.07); beep(100, 140, "sawtooth", 0.06, 110); beep(70, 320, "square", 0.05, 240); }
}

const BS_SHIP_SVG = `<svg viewBox="0 0 64 40" aria-hidden="true"><path d="M6 24h52l-7 10H14z" fill="currentColor"/><path d="M18 24V14h20l6 10" fill="currentColor" opacity=".75"/><path d="M26 14V6h6v8" fill="currentColor" opacity=".55"/></svg>`;

function bsMount(container, ctx) {
    const me = ctx.me;
    container.innerHTML = `
        <div class="bg-table bs-table">
            <div class="bg-info" id="bsOpp"></div>
            <div class="bs-area" id="bsArea"></div>
            <div class="bg-status" id="bsStatus"></div>
            <div class="bg-info is-me" id="bsMe"></div>
            <div class="dk-toast" id="bsToast"></div>
            <div class="dk-wait" id="bsWait" hidden><div class="dk-wait-box"><span class="dk-wait-icon">⏸</span><span id="bsWaitText"></span></div></div>
        </div>
    `;
    const el = (id) => container.querySelector("#" + id);
    const area = el("bsArea");
    let S = null;
    let builtFor = null;
    let pendingShot = -1;
    // Ручная расстановка — только у себя, пока не нажали «В бой»
    let draft = null;       // [{l, r, c, d} | {l, r: null}]
    let dir = "h";          // как встанет корабль, вытащенный из запаса
    let drag = null;        // корабль, который сейчас тащат (см. startDrag)

    let toastTimer = null;
    function toast(text) {
        const t = el("bsToast");
        t.textContent = text;
        t.classList.remove("is-on");
        void t.offsetWidth;
        t.classList.add("is-on");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove("is-on"), 2000);
    }

    function boardHtml(id, cls) {
        const n = S.size;
        let cells = "";
        for (let i = 0; i < n * n; i++) cells += `<button type="button" class="bs-cell" data-i="${i}" tabindex="-1"></button>`;
        return `<div class="bs-board ${cls}" id="${id}" style="--n:${n}">${cells}</div>`;
    }

    // Классы клеток корабля: где у него нос, корма и в какую сторону он лежит
    function shipCellClasses(size, ships) {
        const map = new Map();
        (ships || []).forEach(sh => {
            if (sh.r == null) return;
            const cells = bsCells(size, sh);
            cells.forEach((i, k) => {
                let cls = "is-ship is-" + sh.d;
                if (k === 0) cls += " is-start";
                if (k === cells.length - 1) cls += " is-end";
                map.set(i, cls);
            });
        });
        return map;
    }

    // ---------- Расстановка ----------
    // Корабль тащится пальцем или мышью — с поля или из запаса под полем.
    // Короткое касание корабля на поле поворачивает его на 90° на месте.
    function buildPlace() {
        area.className = "bs-area is-place";
        area.innerHTML = `
            <div class="bs-main">${boardHtml("bsMine", "is-mine is-editable")}</div>
            <div class="bs-dock">
                <div class="bs-fleet" id="bsFleet"></div>
                <div class="bs-tools">
                    <button type="button" class="ui-btn ui-pill" id="bsRandom">🎲 Случайно</button>
                    <button type="button" class="ui-btn ui-pill" id="bsRotate">↻ Горизонтально</button>
                    <button type="button" class="ui-btn ui-pill" id="bsClear">Убрать все</button>
                    <button type="button" class="ui-btn ui-pill ui-pill-accent" id="bsReady">В бой!</button>
                </div>
            </div>
        `;
        const board = el("bsMine");
        board.addEventListener("pointerdown", (e) => {
            if (S.ships[me] || drag) return;
            const cell = e.target.closest(".bs-cell");
            if (!cell) return;
            const i = +cell.dataset.i;
            const k = draft.findIndex(s => s.r != null && bsCells(S.size, s).includes(i));
            if (k < 0) return;
            e.preventDefault();
            startDrag(e, k, bsCells(S.size, draft[k]).indexOf(i), "board");
        });
        el("bsFleet").addEventListener("pointerdown", (e) => {
            if (S.ships[me] || drag) return;
            const b = e.target.closest("[data-l]");
            if (!b) return;
            const l = +b.dataset.l;
            const k = draft.findIndex(s => s.l === l && s.r == null);
            if (k < 0) { toast("Все такие корабли уже на поле"); return; }
            e.preventDefault();
            draft[k].d = dir;
            startDrag(e, k, 0, "dock");
        });
        el("bsRandom").onclick = () => {
            const fleet = bsRandomFleet(S.size, S.fleet);
            if (fleet) { draft = fleet; vibrate(8); renderPlace(); }
        };
        el("bsRotate").onclick = () => {
            dir = dir === "h" ? "v" : "h";
            renderPlace();
        };
        el("bsClear").onclick = () => {
            draft = draft.map(s => ({ l: s.l, r: null, c: null, d: s.d }));
            renderPlace();
        };
        el("bsReady").onclick = () => {
            if (draft.some(s => s.r == null)) { toast("Сначала расставь все корабли"); return; }
            vibrate(12);
            el("bsReady").disabled = true;
            // Хозяин комнаты применяет ход сразу — если соперник уже готов,
            // экран тут же перестраивается в бой, и кнопки больше нет
            ctx.act({ type: "place", ships: draft.map(s => ({ r: s.r, c: s.c, d: s.d, l: s.l })) });
        };
        builtFor = "place:" + S.size;
    }

    // Клетка поля под точкой экрана (или -1, если мимо поля)
    function cellAt(x, y) {
        const board = el("bsMine");
        if (!board) return -1;
        const r = board.getBoundingClientRect();
        const pad = 4, n = S.size;
        const cs = (r.width - pad * 2) / n;
        const col = Math.floor((x - r.left - pad) / cs), row = Math.floor((y - r.top - pad) / cs);
        return col < 0 || row < 0 || col >= n || row >= n ? -1 : row * n + col;
    }

    // Куда встанет корабль, если отпустить его над клеткой i (держа за сегмент off)
    function dropTarget(i) {
        if (!drag || i < 0) return null;
        const n = S.size, src = drag.ship;
        const s = { l: src.l, d: src.d, r: Math.floor(i / n), c: i % n };
        if (s.d === "h") s.c = Math.max(0, Math.min(n - s.l, s.c - drag.off));
        else s.r = Math.max(0, Math.min(n - s.l, s.r - drag.off));
        return s;
    }

    function startDrag(e, k, off, from) {
        const src = draft[k];
        drag = {
            k, off, from,
            ship: { l: src.l, d: src.d },
            orig: from === "board" ? { ...src } : null,
            sx: e.clientX, sy: e.clientY,
            moved: false,
            target: null,
            float: null,
        };
        // Пока корабль в руке, на поле его нет — иначе он мешал бы сам себе
        draft[k] = { l: src.l, r: null, c: null, d: src.d };
        window.addEventListener("pointermove", onDragMove);
        window.addEventListener("pointerup", onDragEnd);
        window.addEventListener("pointercancel", onDragEnd);
        if (from === "dock") showFloat(e);
        renderPlace();
    }

    // Корабль, который едет за пальцем
    function showFloat(e) {
        if (drag.float) return;
        const board = el("bsMine");
        const cs = board ? (board.getBoundingClientRect().width - 8) / S.size : 28;
        const f = document.createElement("div");
        f.className = "bs-float is-" + drag.ship.d;
        f.style.setProperty("--cs", cs + "px");
        f.style.setProperty("--off", drag.off);
        f.innerHTML = "<i></i>".repeat(drag.ship.l);
        document.body.appendChild(f);
        drag.float = f;
        moveFloat(e);
    }
    function moveFloat(e) {
        if (drag && drag.float) drag.float.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    }

    function onDragMove(e) {
        if (!drag) return;
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) {
            drag.moved = true;
            showFloat(e);
        }
        if (!drag.moved) return;
        moveFloat(e);
        const t = dropTarget(cellAt(e.clientX, e.clientY));
        const key = t ? `${t.r}:${t.c}` : "";
        if (key !== (drag.target ? `${drag.target.r}:${drag.target.c}` : "")) {
            drag.target = t;
            renderPlace();
        }
        if (drag.float) drag.float.classList.toggle("is-over", !!t);
    }

    function onDragEnd(e) {
        if (!drag) return;
        const d = drag;
        // Куда отпустили — считаем, пока drag ещё не сброшен
        const t = d.moved && e.type !== "pointercancel" ? dropTarget(cellAt(e.clientX, e.clientY)) : null;
        drag = null;
        window.removeEventListener("pointermove", onDragMove);
        window.removeEventListener("pointerup", onDragEnd);
        window.removeEventListener("pointercancel", onDragEnd);
        if (d.float) d.float.remove();
        const size = S.size;
        const others = () => draft.filter((p, idx) => idx !== d.k && p.r != null);

        if (!d.moved) {
            if (d.from === "board") {
                // Касание — поворот на 90° вокруг той клетки, за которую взяли
                const pivot = bsCells(size, d.orig)[d.off];
                const pr = Math.floor(pivot / size), pc = pivot % size;
                const s = { l: d.orig.l, d: d.orig.d === "h" ? "v" : "h", r: pr, c: pc };
                if (s.d === "h") s.c = Math.max(0, Math.min(size - s.l, pc - d.off));
                else s.r = Math.max(0, Math.min(size - s.l, pr - d.off));
                if (s.l > 1 && bsFits(size, others(), s)) { draft[d.k] = s; vibrate(6); }
                else {
                    draft[d.k] = d.orig;
                    if (s.l > 1) toast("Повернуть не получится — мешают соседние корабли");
                }
            } else toast("Перетащи корабль на поле");
            renderPlace();
            return;
        }
        if (t && bsFits(size, others(), t)) {
            draft[d.k] = t;
            vibrate(8);
        } else {
            if (t) toast("Корабли не должны касаться друг друга — даже углами");
            if (d.orig) draft[d.k] = d.orig;   // с поля — вернуть на место, из запаса — обратно в запас
        }
        renderPlace();
    }

    function renderPlace() {
        if (!S || S.phase !== "place") return;
        const size = S.size;
        const mineReady = !!S.ships[me];
        const ships = mineReady ? S.ships[me] : draft;
        const shipCls = shipCellClasses(size, ships);
        // Тень корабля под пальцем: зелёная — встанет, красная — нет
        let ghost = null, ghostOk = false;
        if (!mineReady && drag && drag.target) {
            ghost = new Set(bsCells(size, drag.target) || []);
            ghostOk = bsFits(size, draft.filter((p, idx) => idx !== drag.k && p.r != null), drag.target);
        }
        const board = el("bsMine");
        board.classList.toggle("is-editable", !mineReady);
        Array.from(board.children).forEach((c, i) => {
            let cls = "bs-cell";
            if (shipCls.has(i)) cls += " " + shipCls.get(i);
            if (ghost && ghost.has(i)) cls += ghostOk ? " is-ghost" : " is-ghost is-bad";
            if (c.className !== cls) c.className = cls;
        });
        const groups = {};
        draft.forEach((s, idx) => {
            const g = groups[s.l] || (groups[s.l] = { left: 0 });
            if (s.r == null && !(drag && drag.k === idx)) g.left++;
        });
        el("bsFleet").innerHTML = Object.keys(groups).sort((a, b) => b - a).map(l => {
            const g = groups[l];
            return `<button type="button" class="ui-btn bs-dock-ship${g.left ? "" : " is-done"}" data-l="${l}" ${mineReady ? "disabled" : ""} title="Перетащи на поле">
                <span class="bs-dock-hull">${"<i></i>".repeat(+l)}</span>
                <span class="bs-dock-count">${g.left ? `×${g.left}` : "✓"}</span>
            </button>`;
        }).join("");
        el("bsRotate").textContent = dir === "h" ? "↻ Горизонтально" : "↻ Вертикально";
        ["bsRandom", "bsRotate", "bsClear"].forEach(id => { el(id).disabled = mineReady; });
        el("bsReady").disabled = mineReady || draft.some(s => s.r == null);
        el("bsReady").textContent = mineReady ? "Флот готов ✓" : "В бой!";
    }

    // ---------- Бой ----------
    function buildBattle() {
        area.className = "bs-area is-battle";
        area.innerHTML = `
            <div class="bs-main">
                <div class="bs-board-label">Поле ${escapeGameText(ctx.partnerName())}</div>
                ${boardHtml("bsEnemy", "is-enemy")}
            </div>
            <div class="bs-side">
                <div class="bs-board-label">Твой флот</div>
                ${boardHtml("bsMine", "is-mine")}
            </div>
        `;
        el("bsEnemy").addEventListener("click", (e) => {
            const cell = e.target.closest(".bs-cell");
            if (!cell || !S || S.over) return;
            const i = +cell.dataset.i;
            if (S.turn !== me) { toast(`Сейчас стреляет ${ctx.partnerName()}`); return; }
            if (pendingShot >= 0) return;
            if (S.shots[me][i]) { toast("Сюда уже стреляли"); return; }
            pendingShot = i;
            cell.classList.add("is-pending");
            vibrate(10);
            ctx.act({ type: "fire", i });
            setTimeout(() => {
                if (pendingShot === i) { pendingShot = -1; renderBattle(); }
            }, 4000);
        });
        builtFor = "battle:" + S.size;
    }

    function renderBoardShots(board, shots, shipCls, reveal) {
        Array.from(board.children).forEach((c, i) => {
            const v = shots[i];
            let cls = "bs-cell";
            if (shipCls && shipCls.has(i)) cls += " " + shipCls.get(i);
            if (v === BS_MISS) cls += " is-miss";
            else if (v === BS_AUTO) cls += " is-miss is-auto";
            else if (v === BS_HIT) cls += " is-hit";
            else if (v === BS_SUNK) cls += " is-hit is-sunk";
            if (reveal && reveal.has(i) && !v) cls += " is-reveal";
            if (i === pendingShot && board.id === "bsEnemy" && !v) cls += " is-pending";
            if (c.dataset.cls !== cls) { c.className = cls; c.dataset.cls = cls; }
        });
    }

    function renderBattle(prev) {
        const size = S.size;
        const opp = S.players.find(p => p !== me);
        if (pendingShot >= 0 && S.shots[me][pendingShot]) pendingShot = -1;
        // Чужие корабли: потопленные — целиком контуром, остальные — только после конца партии
        const enemySunk = new Map();
        const reveal = new Set();
        S.ships[opp].forEach(sh => {
            const cells = bsCells(size, sh);
            const sunk = cells.every(k => S.shots[me][k] === BS_SUNK);
            if (sunk || S.over) shipCellClasses(size, [sh]).forEach((v, k) => enemySunk.set(k, v));
            if (S.over && !sunk) cells.forEach(k => reveal.add(k));
        });
        renderBoardShots(el("bsEnemy"), S.shots[me], enemySunk, reveal);
        renderBoardShots(el("bsMine"), S.shots[opp], shipCellClasses(size, S.ships[me]), null);
        el("bsEnemy").classList.toggle("is-my-turn", S.turn === me && !S.over);

        // Последний выстрел: анимация, звук, подпись
        const last = S.last;
        const fresh = last && (!prev || !prev.last || prev.last.i !== last.i || prev.last.by !== last.by);
        Array.from(container.querySelectorAll(".bs-cell.is-last")).forEach(c => c.classList.remove("is-last"));
        if (last) {
            const board = el(last.by === me ? "bsEnemy" : "bsMine");
            const c = board.children[last.i];
            c.classList.add("is-last");
            if (fresh) {
                c.classList.remove("is-boom");
                void c.offsetWidth;
                c.classList.add("is-boom");
                bsSound(last.res);
                if (last.res !== "miss") vibrate(last.res === "sunk" ? [20, 40, 30] : 18);
                if (last.res === "sunk") toast(last.by === me ? `Потоплен ${BS_SHIP_NAMES[last.l] || ""}!` : `${ctx.partnerName()} потопил(а) твой ${BS_SHIP_NAMES[last.l] || "корабль"}`);
            }
        }

        let status;
        if (S.over) status = S.over.winner === me ? "Победа! Весь флот соперника на дне 🏆" : `${ctx.partnerName()} потопил(а) весь твой флот`;
        else if (S.turn === me) status = last && last.by === me && last.res !== "miss" ? "Попадание! Стреляй ещё" : "Твой выстрел — выбери клетку";
        else status = last && last.by === opp && last.res !== "miss" ? `${ctx.partnerName()} попал(а) и стреляет ещё…` : `Стреляет ${ctx.partnerName()}…`;
        el("bsStatus").textContent = status;
        el("bsStatus").classList.toggle("is-my-turn", S.turn === me && !S.over);
    }

    function infoHtml(uid, name, isMe) {
        const afloat = bsAfloat(S, uid);
        let sub;
        if (S.phase === "place") sub = S.ships[uid] ? "флот расставлен" : isMe ? "расставь флот" : "расставляет флот…";
        else sub = `на плаву: ${afloat} из ${S.fleet.length}`;
        const turn = S.phase === "battle" && S.turn === uid && !S.over;
        return `
            <span class="bs-chip">${BS_SHIP_SVG}</span>
            <span class="bg-info-name">${escapeGameText(name)}</span>
            <span class="bg-info-sub">${sub}</span>
            ${turn ? `<span class="bg-turn">${isMe ? "твой выстрел" : "стреляет"}</span>` : ""}
        `;
    }

    function render(prev) {
        const key = S.phase + ":" + S.size;
        if (builtFor !== key) {
            if (S.phase === "place") {
                if (!draft || draft.length !== S.fleet.length) {
                    draft = bsRandomFleet(S.size, S.fleet) || S.fleet.map(l => ({ l, r: null, c: null, d: "h" }));
                }
                buildPlace();
            } else buildBattle();
        }
        const opp = S.players.find(p => p !== me);
        el("bsOpp").innerHTML = infoHtml(opp, ctx.partnerName(), false);
        el("bsMe").innerHTML = infoHtml(me, getUsernameFromEmail(currentUser.email), true);
        el("bsOpp").classList.toggle("is-turn", S.phase === "battle" && S.turn === opp && !S.over);
        el("bsMe").classList.toggle("is-turn", S.phase === "battle" && S.turn === me && !S.over);
        if (S.phase === "place") {
            renderPlace();
            const mine = !!S.ships[me], theirs = !!S.ships[opp];
            el("bsStatus").textContent = mine
                ? `Ждём, пока ${ctx.partnerName()} расставит флот…`
                : theirs ? `${ctx.partnerName()} уже готов(а) — расставь корабли и жми «В бой!»` : "Перетаскивай корабли на поле, нажми на корабль — повернётся";
            el("bsStatus").classList.toggle("is-my-turn", !mine);
        } else {
            renderBattle(prev && prev.phase === "battle" ? prev : null);
        }
    }

    return {
        update(state, info) {
            const prev = S;
            const changed = !S || JSON.stringify(S) !== JSON.stringify(state);
            S = state;
            if (changed) render(prev);
            el("bsWait").hidden = !!info.partnerHere || !!state.over;
            el("bsWaitText").textContent = `${ctx.partnerName()} вышел(а) из комнаты — партия на паузе. Продолжите, когда вернётся.`;
        },
        destroy() {
            // Партия закончилась или комната закрылась прямо во время перетаскивания
            if (drag) {
                if (drag.float) drag.float.remove();
                window.removeEventListener("pointermove", onDragMove);
                window.removeEventListener("pointerup", onDragEnd);
                window.removeEventListener("pointercancel", onDragEnd);
                drag = null;
            }
        }
    };
}

duoRegister({
    id: "battleship",
    title: "Морской бой",
    emoji: "🚢",
    hue: 205,
    short: "Расставь флот и потопи корабли соперника",
    loseText: "Твой флот на дне",
    loseEmoji: "🌊",
    lobbyArt: `<div class="bs-lobby-art">${BS_SHIP_SVG}<span class="bs-lobby-boom">💥</span></div>`,
    options: [{
        key: "variant",
        label: "Поле",
        values: [
            { v: "classic", label: "10 × 10", desc: "Классика: 10 кораблей, от одно- до четырёхпалубного" },
            { v: "quick", label: "8 × 8", desc: "Быстрая партия: 6 кораблей" }
        ]
    }],
    newGame: bsNewGame,
    applyAction: bsApply,
    mount: bsMount
});
