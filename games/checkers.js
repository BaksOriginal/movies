// ==========================================
// checkers.js — РУССКИЕ ШАШКИ ВДВОЁМ
// ==========================================
// Подключается после duo.js. Правила русских шашек:
//   • простая шашка ходит вперёд на одну клетку, бьёт и вперёд, и назад;
//   • бить обязательно, за один ход можно бить несколько шашек подряд;
//   • дамка ходит и бьёт на любое расстояние по диагонали; если после
//     взятия она может бить дальше — должна встать на клетку, откуда бьёт;
//   • шашка, дошедшая до последнего ряда во время взятия, сразу становится
//     дамкой и продолжает бить уже как дамка;
//   • побитые шашки снимаются после хода («турецкий удар»): через одну и ту
//     же шашку дважды не прыгают;
//   • проигрывает тот, у кого нет шашек или ходов. 15 ходов подряд только
//     дамками без взятий (у каждого) — ничья.
//
// Поле — массив из 64 клеток (индекс = ряд * 8 + столбец, ряд 0 — сверху у
// белых): "" — пусто, "w"/"b" — шашки, "W"/"B" — дамки.

const CK_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const CK_DRAW_KING_MOVES = 30;

const ckColor = (p) => p ? p.toLowerCase() : "";
const ckIsKing = (p) => p === "W" || p === "B";
const ckIn = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const ckLastRow = (color) => color === "w" ? 0 : 7;

function ckNewGame(players) {
    const board = new Array(64).fill("");
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        if ((r + c) % 2 === 0) continue;
        if (r < 3) board[r * 8 + c] = "b";
        if (r > 4) board[r * 8 + c] = "w";
    }
    const white = players[Math.floor(Math.random() * 2)];
    const black = players[0] === white ? players[1] : players[0];
    return {
        players,
        colors: { [white]: "w", [black]: "b" },
        board,
        turn: white,
        last: null,
        quiet: 0,
        over: null
    };
}

// Все взятия шашкой с клетки from (с учётом многоходовых)
function ckCaptures(board, from, out) {
    const piece = board[from];
    const color = ckColor(piece);
    const b = board.slice();
    b[from] = "";

    // Можно ли с клетки pos продолжить бить (без побитых)
    function canCapture(pos, pc, captured) {
        const r0 = pos >> 3, c0 = pos & 7;
        for (const [dr, dc] of CK_DIRS) {
            if (ckIsKing(pc)) {
                let r = r0 + dr, c = c0 + dc;
                while (ckIn(r, c) && b[r * 8 + c] === "") { r += dr; c += dc; }
                if (!ckIn(r, c)) continue;
                const v = r * 8 + c;
                if (captured.includes(v) || ckColor(b[v]) === color) continue;
                if (ckIn(r + dr, c + dc) && b[(r + dr) * 8 + c + dc] === "") return true;
            } else {
                const r = r0 + dr, c = c0 + dc;
                if (!ckIn(r + dr, c + dc)) continue;
                const v = r * 8 + c, L = (r + dr) * 8 + c + dc;
                if (b[v] && ckColor(b[v]) !== color && !captured.includes(v) && b[L] === "") return true;
            }
        }
        return false;
    }

    function rec(pos, pc, path, captured) {
        let found = false;
        const r0 = pos >> 3, c0 = pos & 7;
        for (const [dr, dc] of CK_DIRS) {
            if (ckIsKing(pc)) {
                let r = r0 + dr, c = c0 + dc;
                while (ckIn(r, c) && b[r * 8 + c] === "") { r += dr; c += dc; }
                if (!ckIn(r, c)) continue;
                const v = r * 8 + c;
                if (captured.includes(v) || ckColor(b[v]) === color) continue;
                const lands = [];
                let lr = r + dr, lc = c + dc;
                while (ckIn(lr, lc) && b[lr * 8 + lc] === "") { lands.push(lr * 8 + lc); lr += dr; lc += dc; }
                if (!lands.length) continue;
                const nextCaptured = captured.concat(v);
                const cont = lands.filter(L => canCapture(L, pc, nextCaptured));
                (cont.length ? cont : lands).forEach(L => { found = true; rec(L, pc, path.concat(L), nextCaptured); });
            } else {
                const r = r0 + dr, c = c0 + dc;
                if (!ckIn(r + dr, c + dc)) continue;
                const v = r * 8 + c, L = (r + dr) * 8 + c + dc;
                if (!b[v] || ckColor(b[v]) === color || captured.includes(v) || b[L] !== "") continue;
                found = true;
                const npc = (r + dr) === ckLastRow(color) ? pc.toUpperCase() : pc;
                rec(L, npc, path.concat(L), captured.concat(v));
            }
        }
        if (!found && captured.length) out.push({ path, captures: captured, piece: pc });
    }
    rec(from, piece, [from], []);
}

// Все разрешённые ходы цвета: если есть взятие — только взятия
function ckMoves(board, color) {
    const caps = [];
    for (let i = 0; i < 64; i++) if (ckColor(board[i]) === color) ckCaptures(board, i, caps);
    if (caps.length) return caps;
    const moves = [];
    for (let i = 0; i < 64; i++) {
        const p = board[i];
        if (ckColor(p) !== color) continue;
        const r0 = i >> 3, c0 = i & 7;
        for (const [dr, dc] of CK_DIRS) {
            if (ckIsKing(p)) {
                let r = r0 + dr, c = c0 + dc;
                while (ckIn(r, c) && board[r * 8 + c] === "") { moves.push({ path: [i, r * 8 + c], captures: [], piece: p }); r += dr; c += dc; }
            } else {
                if (dr !== (color === "w" ? -1 : 1)) continue;
                const r = r0 + dr, c = c0 + dc;
                if (ckIn(r, c) && board[r * 8 + c] === "") {
                    moves.push({ path: [i, r * 8 + c], captures: [], piece: r === ckLastRow(color) ? p.toUpperCase() : p });
                }
            }
        }
    }
    return moves;
}

const ckSamePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function ckApply(state, actor, action) {
    if (state.over || action.type !== "move" || actor !== state.turn || !Array.isArray(action.path)) return null;
    const s = JSON.parse(JSON.stringify(state));
    const color = s.colors[actor];
    const move = ckMoves(s.board, color).find(m => ckSamePath(m.path, action.path));
    if (!move) return null;
    const wasKing = ckIsKing(s.board[move.path[0]]);
    s.board[move.path[0]] = "";
    move.captures.forEach(v => { s.board[v] = ""; });
    s.board[move.path[move.path.length - 1]] = move.piece;
    s.last = { by: actor, path: move.path, captures: move.captures, promoted: !wasKing && ckIsKing(move.piece) };
    s.quiet = wasKing && !move.captures.length ? s.quiet + 1 : 0;

    const opp = s.players.find(p => p !== actor);
    s.turn = opp;
    if (!ckMoves(s.board, s.colors[opp]).length) s.over = { winner: actor, loser: opp, reason: "win" };
    else if (s.quiet >= CK_DRAW_KING_MOVES) s.over = { winner: null, loser: null, reason: "draw" };
    return s;
}

// ---------- Интерфейс ----------
function ckMount(container, ctx) {
    const me = ctx.me;
    container.innerHTML = `
        <div class="bg-table ck-table">
            <div class="bg-info" id="ckOpp"></div>
            <div class="bg-board-wrap">
                <div class="ck-board" id="ckBoard">
                    <div class="ck-squares" id="ckSquares"></div>
                    <div class="ck-pieces" id="ckPieces"></div>
                </div>
            </div>
            <div class="bg-status" id="ckStatus"></div>
            <div class="bg-info is-me" id="ckMe"></div>
            <div class="dk-toast" id="ckToast"></div>
            <div class="dk-wait" id="ckWait" hidden><div class="dk-wait-box"><span class="dk-wait-icon">⏸</span><span id="ckWaitText"></span></div></div>
        </div>
    `;
    const el = (id) => container.querySelector("#" + id);
    const boardEl = el("ckBoard"), squaresEl = el("ckSquares"), piecesEl = el("ckPieces");

    let S = null;
    let flip = false;
    let partial = null;   // начатое многоходовое взятие: [откуда, куда, ...]
    let selected = null;  // шашка, выбранная тапом
    let pending = false;
    let prevBoard = null;
    let drag = null;

    // Клетки: тёмные/светлые, у чёрных доска перевёрнута, чтобы свои были снизу
    const toDisplay = (i) => { const r = i >> 3, c = i & 7; return flip ? [7 - r, 7 - c] : [r, c]; };
    const fromDisplay = (R, C) => flip ? (7 - R) * 8 + (7 - C) : R * 8 + C;

    function buildSquares() {
        let html = "";
        for (let R = 0; R < 8; R++) for (let C = 0; C < 8; C++) {
            const i = fromDisplay(R, C);
            const dark = ((i >> 3) + (i & 7)) % 2 === 1;
            html += `<div class="ck-sq${dark ? " is-dark" : ""}" data-i="${i}" style="grid-row:${R + 1};grid-column:${C + 1}"></div>`;
        }
        squaresEl.innerHTML = html;
    }

    let toastTimer = null;
    function toast(text) {
        const t = el("ckToast");
        t.textContent = text;
        t.classList.remove("is-on");
        void t.offsetWidth;
        t.classList.add("is-on");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove("is-on"), 2400);
    }

    // Текущая доска с учётом начатого взятия (шашка «в пути», побитые помечены)
    function viewBoard() {
        const b = S.board.slice();
        if (partial) {
            const from = partial[0], at = partial[partial.length - 1];
            const pc = b[from];
            b[from] = "";
            b[at] = pc;
        }
        return b;
    }

    // Попытка сделать шаг from -> to
    function step(from, to) {
        if (!S || S.over || pending) return false;
        const pName = ctx.partnerName();
        if (S.turn !== me) { toast(`Сейчас ходит ${pName}`); return false; }
        const color = S.colors[me];
        const moves = ckMoves(S.board, color);
        const start = partial ? partial[0] : from;
        if (partial && from !== partial[partial.length - 1]) { toast("Продолжай бить той же шашкой"); return false; }
        const path = (partial || [from]).concat(to);
        const fits = moves.filter(m => m.path.length >= path.length && path.every((v, k) => m.path[k] === v));
        if (!fits.length) {
            vibrate([20, 30, 20]);
            if (partial) toast("Отсюда так бить нельзя — бей дальше");
            else if (moves.some(m => m.captures.length)) toast(moves.some(m => m.path[0] === start) ? "Так нельзя — бить обязательно" : "Бить обязательно — есть взятие другой шашкой");
            else toast("Так ходить нельзя");
            return false;
        }
        const exact = fits.find(m => m.path.length === path.length);
        if (exact) {
            partial = null;
            selected = null;
            pending = true;
            setTimeout(() => { pending = false; }, 1500);
            vibrate(10);
            ctx.act({ type: "move", path });
            // Показываем ход сразу, не дожидаясь ответа хозяина комнаты
            const optimistic = ckApply(S, me, { type: "move", path });
            if (optimistic) renderBoard(optimistic, true);
            return true;
        }
        partial = path;
        selected = to;
        vibrate(8);
        render(false);
        return true;
    }

    // ---------- Ввод: перетаскивание и тапы ----------
    // Клетка под точкой — по координатам доски (сама шашка под пальцем не мешает)
    function squareAt(x, y) {
        const b = boardEl.getBoundingClientRect();
        const C = Math.floor((x - b.left) / (b.width / 8)), R = Math.floor((y - b.top) / (b.height / 8));
        return R >= 0 && R < 8 && C >= 0 && C < 8 ? fromDisplay(R, C) : null;
    }
    function onDown(e) {
        const pieceEl = e.target.closest(".ck-piece");
        if (!pieceEl || !S || S.over || e.button > 0) return;
        const i = +pieceEl.dataset.i;
        const vb = viewBoard();
        if (ckColor(vb[i]) !== S.colors[me]) return;
        drag = { pieceEl, i, id: e.pointerId, x0: e.clientX, y0: e.clientY, moving: false };
        try { pieceEl.setPointerCapture(e.pointerId); } catch (err) {}
    }
    function onMove(e) {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
        if (!drag.moving && Math.hypot(dx, dy) < 6) return;
        drag.moving = true;
        e.preventDefault();
        drag.pieceEl.classList.add("is-dragging");
        drag.pieceEl.style.setProperty("--tx", dx + "px");
        drag.pieceEl.style.setProperty("--ty", dy + "px");
        const sq = squareAt(e.clientX, e.clientY);
        squaresEl.querySelectorAll(".is-hover").forEach(s => s.classList.remove("is-hover"));
        if (sq != null) squaresEl.querySelector(`.ck-sq[data-i="${sq}"]`).classList.add("is-hover");
    }
    function onUp(e, cancelled) {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag;
        drag = null;
        squaresEl.querySelectorAll(".is-hover").forEach(s => s.classList.remove("is-hover"));
        const reset = () => {
            d.pieceEl.classList.remove("is-dragging");
            d.pieceEl.style.removeProperty("--tx");
            d.pieceEl.style.removeProperty("--ty");
        };
        if (!d.moving) {
            reset();
            if (!cancelled) { selected = selected === d.i ? null : d.i; markSelected(); }
            return;
        }
        // Курсор держит шашку за центр клетки, смотрим, куда её отпустили
        const sq = cancelled ? null : squareAt(e.clientX, e.clientY);
        if (sq == null || sq === d.i || !step(d.i, sq)) {
            d.pieceEl.classList.add("is-returning");
            reset();
            setTimeout(() => d.pieceEl.classList.remove("is-returning"), 200);
        }
    }
    piecesEl.addEventListener("pointerdown", onDown);
    piecesEl.addEventListener("pointermove", onMove);
    piecesEl.addEventListener("pointerup", (e) => onUp(e, false));
    piecesEl.addEventListener("pointercancel", (e) => onUp(e, true));
    // Тап по пустой клетке, когда шашка выбрана
    squaresEl.addEventListener("click", (e) => {
        const sq = e.target.closest(".ck-sq");
        if (!sq || selected == null || !S) return;
        step(selected, +sq.dataset.i);
    });

    function markSelected() {
        piecesEl.querySelectorAll(".ck-piece").forEach(p => p.classList.toggle("is-selected", +p.dataset.i === selected));
    }

    // ---------- Отрисовка ----------
    function pieceHtml(p, i, extra = "", style = "") {
        const [R, C] = toDisplay(i);
        return `<div class="ck-piece ck-${ckColor(p)}${ckIsKing(p) ? " is-king" : ""}${extra}" data-i="${i}" style="--r:${R};--c:${C};${style}"><span></span></div>`;
    }

    function renderBoard(state, animate) {
        const b = state === S && partial ? viewBoard() : state.board;
        const last = state.last;
        let html = "";
        for (let i = 0; i < 64; i++) {
            if (!b[i]) continue;
            let extra = "", style = "";
            if (animate && last && i === last.path[last.path.length - 1] && prevBoard && !prevBoard[i]) {
                const [R0, C0] = toDisplay(last.path[0]), [R1, C1] = toDisplay(i);
                extra = " is-moved";
                style = `--fr:${R0 - R1};--fc:${C0 - C1};`;
            }
            if (partial && partial.slice(1).length && i === partial[partial.length - 1]) extra += " is-midjump";
            if (selected === i) extra += " is-selected";
            if (partial && state === S) {
                // побитые в начатом взятии — полупрозрачные
                const caps = ckMoves(S.board, S.colors[me]).find(m => partial.every((v, k) => m.path[k] === v));
                if (caps && caps.captures.slice(0, partial.length - 1).includes(i)) extra += " is-captured";
            }
            html += pieceHtml(b[i], i, extra, style);
        }
        // Только что побитые шашки тают на своих клетках
        if (animate && last && prevBoard) {
            last.captures.forEach(v => { if (prevBoard[v]) html += pieceHtml(prevBoard[v], v, " is-gone"); });
        }
        piecesEl.innerHTML = html;
        prevBoard = state.board.slice();

        squaresEl.querySelectorAll(".is-last").forEach(s => s.classList.remove("is-last"));
        if (last) [last.path[0], last.path[last.path.length - 1]].forEach(v => squaresEl.querySelector(`.ck-sq[data-i="${v}"]`)?.classList.add("is-last"));
        if (partial) partial.forEach(v => squaresEl.querySelector(`.ck-sq[data-i="${v}"]`)?.classList.add("is-last"));
    }

    function infoHtml(uid, name, isMe) {
        const color = S.colors[uid];
        const mine = S.board.filter(p => ckColor(p) === color).length;
        const lost = 12 - S.board.filter(p => ckColor(p) === (color === "w" ? "b" : "w")).length;
        const kings = S.board.filter(p => ckColor(p) === color && ckIsKing(p)).length;
        const turn = S.turn === uid && !S.over;
        return `
            <span class="bg-chip-piece ck-${color}"><span></span></span>
            <span class="bg-info-name">${escapeGameText(name)}</span>
            <span class="bg-info-sub">${color === "w" ? "белые" : "чёрные"} · ${mine} шаш.${kings ? ` · ${kings} дам.` : ""}</span>
            <span class="bg-info-captured" title="Побито">${lost ? `✕ ${lost}` : ""}</span>
            ${turn ? `<span class="bg-turn">${isMe ? "твой ход" : "ходит"}</span>` : ""}
        `;
    }

    function render(animate) {
        const s = S;
        const opp = s.players.find(p => p !== me);
        const newFlip = s.colors[me] === "b";
        if (newFlip !== flip || !squaresEl.children.length) { flip = newFlip; buildSquares(); }
        renderBoard(s, animate);
        el("ckOpp").innerHTML = infoHtml(opp, ctx.partnerName(), false);
        el("ckMe").innerHTML = infoHtml(me, getUsernameFromEmail(currentUser.email), true);
        el("ckOpp").classList.toggle("is-turn", s.turn === opp);
        el("ckMe").classList.toggle("is-turn", s.turn === me);
        let status;
        if (s.over) status = s.over.winner ? (s.over.winner === me ? "Победа!" : "Поражение") : "Ничья";
        else if (s.turn === me) status = partial ? "Бей дальше!" : s.last && s.last.promoted && s.last.by !== me ? `${ctx.partnerName()} прошёл в дамки! Твой ход` : "Твой ход — перетащи шашку";
        else status = `Ходит ${ctx.partnerName()}…`;
        el("ckStatus").textContent = status;
        el("ckStatus").classList.toggle("is-my-turn", s.turn === me && !s.over);
    }

    return {
        update(state, info) {
            const changed = !S || JSON.stringify(S) !== JSON.stringify(state);
            const animate = !!S && changed;
            if (animate) thingSound("clack");
            const prevRendered = prevBoard;
            S = state;
            pending = false;
            if (changed) {
                partial = null;
                selected = null;
                // Свой ход уже показан оптимистично — повторно не анимируем
                if (prevRendered && JSON.stringify(prevRendered) === JSON.stringify(state.board)) { prevBoard = prevRendered; render(false); }
                else render(animate);
            }
            el("ckWait").hidden = !!info.partnerHere || !!state.over;
            el("ckWaitText").textContent = `${ctx.partnerName()} вышел(а) из комнаты — партия на паузе. Продолжите, когда вернётся.`;
        },
        destroy() {}
    };
}

duoRegister({
    id: "checkers",
    title: "Шашки",
    emoji: "⚫",
    hue: 200,
    short: "Русские шашки: дамки, взятие обязательно",
    lobbyArt: `<div class="ck-lobby-art"><span class="ck-piece ck-w"><span></span></span><span class="ck-piece ck-b is-king"><span></span></span><span class="ck-piece ck-w is-king"><span></span></span></div>`,
    options: [],
    newGame: ckNewGame,
    applyAction: ckApply,
    mount: ckMount
});
