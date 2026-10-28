// ==========================================
// tictactoe.js — КРЕСТИКИ-НОЛИКИ ВДВОЁМ
// ==========================================
// Подключается после duo.js. Два варианта: классика 3×3 и большое поле
// 10×10, где нужно собрать пять в ряд. Крестики ходят первыми, кому они
// достанутся — решает жребий перед каждой партией.

const TTT_VARIANTS = {
    classic: { size: 3, win: 3 },
    gomoku: { size: 10, win: 5 }
};

function tttNewGame(players, options) {
    const v = TTT_VARIANTS[options.variant] || TTT_VARIANTS.classic;
    const x = players[Math.floor(Math.random() * 2)];
    const o = players[0] === x ? players[1] : players[0];
    return {
        players,
        variant: options.variant in TTT_VARIANTS ? options.variant : "classic",
        size: v.size,
        win: v.win,
        cells: new Array(v.size * v.size).fill(""),
        marks: { [x]: "x", [o]: "o" },
        turn: x,
        last: null,
        line: null,
        over: null
    };
}

// Линия победы через клетку i (или null)
function tttLineAt(s, i) {
    const n = s.size, mark = s.cells[i];
    const r0 = Math.floor(i / n), c0 = i % n;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const line = [i];
        for (const sign of [1, -1]) {
            let r = r0 + dr * sign, c = c0 + dc * sign;
            while (r >= 0 && r < n && c >= 0 && c < n && s.cells[r * n + c] === mark) {
                line.push(r * n + c);
                r += dr * sign; c += dc * sign;
            }
        }
        if (line.length >= s.win) return line.sort((a, b) => a - b);
    }
    return null;
}

function tttApply(state, actor, action) {
    if (state.over || action.type !== "put" || actor !== state.turn) return null;
    const i = action.i;
    if (!Number.isInteger(i) || i < 0 || i >= state.cells.length || state.cells[i]) return null;
    const s = JSON.parse(JSON.stringify(state));
    s.cells[i] = s.marks[actor];
    s.last = { by: actor, i };
    const line = tttLineAt(s, i);
    const opp = s.players.find(p => p !== actor);
    if (line) {
        s.line = line;
        s.over = { winner: actor, loser: opp, reason: "line" };
    } else if (s.cells.every(Boolean)) {
        s.over = { winner: null, loser: null, reason: "draw" };
    } else {
        s.turn = opp;
    }
    return s;
}

const TTT_X_SVG = `<svg viewBox="0 0 100 100" aria-hidden="true"><path pathLength="100" d="M24 24 L76 76 M76 24 L24 76"/></svg>`;
const TTT_O_SVG = `<svg viewBox="0 0 100 100" aria-hidden="true"><circle pathLength="100" cx="50" cy="50" r="27"/></svg>`;

function tttMount(container, ctx) {
    const me = ctx.me;
    container.innerHTML = `
        <div class="bg-table ttt-table">
            <div class="bg-info" id="tttOpp"></div>
            <div class="bg-board-wrap">
                <div class="ttt-board" id="tttBoard"></div>
            </div>
            <div class="bg-status" id="tttStatus"></div>
            <div class="bg-info is-me" id="tttMe"></div>
            <div class="dk-toast" id="tttToast"></div>
            <div class="dk-wait" id="tttWait" hidden><div class="dk-wait-box"><span class="dk-wait-icon">⏸</span><span id="tttWaitText"></span></div></div>
        </div>
    `;
    const el = (id) => container.querySelector("#" + id);
    const boardEl = el("tttBoard");
    let S = null;
    let builtFor = null;
    let pending = false;

    let toastTimer = null;
    function toast(text) {
        const t = el("tttToast");
        t.textContent = text;
        t.classList.remove("is-on");
        void t.offsetWidth;
        t.classList.add("is-on");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove("is-on"), 2000);
    }

    boardEl.addEventListener("click", (e) => {
        const cell = e.target.closest(".ttt-cell");
        if (!cell || !S || S.over || pending) return;
        const i = +cell.dataset.i;
        if (S.turn !== me) { toast(`Сейчас ходит ${ctx.partnerName()}`); return; }
        if (S.cells[i]) { toast("Клетка занята"); return; }
        pending = true;
        setTimeout(() => { pending = false; }, 1500);
        vibrate(10);
        // Сразу рисуем свой знак, не дожидаясь ответа хозяина комнаты
        cell.innerHTML = S.marks[me] === "x" ? TTT_X_SVG : TTT_O_SVG;
        cell.className = `ttt-cell is-${S.marks[me]} is-new`;
        ctx.act({ type: "put", i });
    });

    function build() {
        const n = S.size;
        boardEl.style.setProperty("--n", n);
        boardEl.classList.toggle("is-big", n > 3);
        boardEl.innerHTML = S.cells.map((_, i) => `<button type="button" class="ttt-cell" data-i="${i}" aria-label="Клетка ${i + 1}"></button>`).join("");
        builtFor = S.variant + ":" + n;
    }

    function infoHtml(uid, name, isMe) {
        const mark = S.marks[uid];
        const turn = S.turn === uid && !S.over;
        return `
            <span class="bg-chip-mark is-${mark}">${mark === "x" ? TTT_X_SVG : TTT_O_SVG}</span>
            <span class="bg-info-name">${escapeGameText(name)}</span>
            <span class="bg-info-sub">${mark === "x" ? "крестики · ходят первыми" : "нолики"}</span>
            ${turn ? `<span class="bg-turn">${isMe ? "твой ход" : "ходит"}</span>` : ""}
        `;
    }

    function render(prev) {
        if (builtFor !== S.variant + ":" + S.size) build();
        const cells = boardEl.children;
        S.cells.forEach((m, i) => {
            const c = cells[i];
            if (m && c.classList.contains("is-" + m)) {
                // Знак уже нарисован (в т.ч. своим ходом заранее) — только подсветки
                c.classList.toggle("is-last", !!S.last && S.last.i === i);
                c.classList.toggle("is-win", !!S.line && S.line.includes(i));
                return;
            }
            const isNew = m && (!prev || prev.cells[i] !== m);
            const cls = `ttt-cell${m ? " is-" + m : ""}${isNew ? " is-new" : ""}${S.last && S.last.i === i ? " is-last" : ""}${S.line && S.line.includes(i) ? " is-win" : ""}`;
            if (c.className !== cls) {
                c.className = cls;
                c.innerHTML = m === "x" ? TTT_X_SVG : m === "o" ? TTT_O_SVG : "";
            }
        });
        if (S.line) S.line.forEach((i, k) => cells[i].style.setProperty("--k", k));
        const opp = S.players.find(p => p !== me);
        el("tttOpp").innerHTML = infoHtml(opp, ctx.partnerName(), false);
        el("tttMe").innerHTML = infoHtml(me, getUsernameFromEmail(currentUser.email), true);
        el("tttOpp").classList.toggle("is-turn", S.turn === opp && !S.over);
        el("tttMe").classList.toggle("is-turn", S.turn === me && !S.over);
        let status;
        if (S.over) status = S.over.winner ? (S.over.winner === me ? "Победа! Линия собрана" : `${ctx.partnerName()} собрал(а) линию`) : "Ничья — поле заполнено";
        else status = S.turn === me ? `Твой ход${S.size > 3 ? " — собери пять в ряд" : ""}` : `Ходит ${ctx.partnerName()}…`;
        el("tttStatus").textContent = status;
        el("tttStatus").classList.toggle("is-my-turn", S.turn === me && !S.over);
    }

    return {
        update(state, info) {
            const prev = S;
            const changed = !S || JSON.stringify(S) !== JSON.stringify(state);
            S = state;
            pending = false;
            if (changed) render(prev);
            el("tttWait").hidden = !!info.partnerHere || !!state.over;
            el("tttWaitText").textContent = `${ctx.partnerName()} вышел(а) из комнаты — партия на паузе. Продолжите, когда вернётся.`;
        },
        destroy() {}
    };
}

duoRegister({
    id: "tictactoe",
    title: "Крестики-нолики",
    emoji: "❌",
    hue: 170,
    short: "3×3 или пять в ряд на большом поле",
    lobbyArt: `<div class="ttt-lobby-art"><span class="is-x">${TTT_X_SVG}</span><span class="is-o">${TTT_O_SVG}</span><span class="is-x">${TTT_X_SVG}</span></div>`,
    options: [{
        key: "variant",
        label: "Поле",
        values: [
            { v: "classic", label: "3 × 3", desc: "Классика: три в ряд" },
            { v: "gomoku", label: "10 × 10", desc: "Большое поле: нужно собрать пять в ряд" }
        ]
    }],
    newGame: tttNewGame,
    applyAction: tttApply,
    mount: tttMount
});
