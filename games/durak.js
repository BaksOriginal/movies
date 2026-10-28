// ==========================================
// durak.js — ДУРАК ВДВОЁМ (подкидной / переводной)
// ==========================================
// Подключается после duo.js. Правила — чистые функции над объектом партии
// (его применяет хозяин комнаты, см. duo.js), интерфейс — mount()/update().
//
// Карта — строка из двух символов: достоинство "6789TJQKA" + масть "SCDH"
// (♠ ♣ ♦ ♥), например "TH" — десятка червей.

const DK_RANKS = "6789TJQKA";
const DK_SUITS = "SCDH";
const DK_RANK_LABEL = { "6": "6", "7": "7", "8": "8", "9": "9", T: "10", J: "В", Q: "Д", K: "К", A: "Т" };
const DK_SUIT_SYMBOL = { S: "♠", C: "♣", D: "♦", H: "♥" };
const DK_SUIT_NAME = { S: "пики", C: "трефы", D: "бубны", H: "червы" };
const DK_HAND = 6;

const dkRank = (c) => DK_RANKS.indexOf(c[0]);
const dkSuit = (c) => c[1];

function dkBeats(attack, defend, trump) {
    if (dkSuit(defend) === dkSuit(attack)) return dkRank(defend) > dkRank(attack);
    return dkSuit(defend) === trump && dkSuit(attack) !== trump;
}

function dkOther(s, uid) { return s.players[0] === uid ? s.players[1] : s.players[0]; }
function dkUndefended(s) { return s.table.filter(p => !p.d).length; }
// Первый отбой партии — не больше 5 карт, дальше — 6
function dkTableLimit(s) { return s.firstBout ? 5 : 6; }

// ---------- Новая партия ----------
function dkNewGame(players, options) {
    const deck = [];
    for (const s of DK_SUITS) for (const r of DK_RANKS) deck.push(r + s);
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const hands = { [players[0]]: [], [players[1]]: [] };
    for (let k = 0; k < DK_HAND; k++) {
        hands[players[0]].push(deck.pop());
        hands[players[1]].push(deck.pop());
    }
    // Козырь — нижняя карта колоды (deck[0]), её берут последней
    const trumpCard = deck[0];
    const trump = dkSuit(trumpCard);

    // Первым ходит тот, у кого младший козырь
    let attacker = null, low = 99;
    players.forEach(p => hands[p].forEach(c => {
        if (dkSuit(c) === trump && dkRank(c) < low) { low = dkRank(c); attacker = p; }
    }));
    if (!attacker) attacker = players[Math.floor(Math.random() * 2)];

    return {
        mode: options.mode === "perevodnoy" ? "perevodnoy" : "podkidnoy",
        players,
        deck,
        trumpCard,
        trump,
        hands,
        attacker,
        defender: players[0] === attacker ? players[1] : players[0],
        table: [],
        phase: "attack",   // attack — идёт отбой; taking — защитник сказал «Беру», можно подкинуть
        firstBout: true,
        discard: 0,
        last: null,
        over: null
    };
}

// ---------- Что можно сделать прямо сейчас ----------
function dkCanAttackWith(s, card) {
    if (s.over || !["attack", "taking"].includes(s.phase)) return false;
    if (s.table.length >= dkTableLimit(s)) return false;
    if (dkUndefended(s) >= s.hands[s.defender].length) return false;
    if (s.table.length === 0) return true;
    return s.table.some(p => p.a[0] === card[0] || (p.d && p.d[0] === card[0]));
}

function dkDefendTargets(s, card) {
    if (s.over || s.phase !== "attack") return [];
    const out = [];
    s.table.forEach((p, i) => { if (!p.d && dkBeats(p.a, card, s.trump)) out.push(i); });
    return out;
}

function dkCanTransfer(s, card) {
    if (s.over || s.mode !== "perevodnoy" || s.phase !== "attack" || s.table.length === 0) return false;
    if (s.table.some(p => p.d)) return false;
    if (!s.table.every(p => p.a[0] === card[0])) return false;
    if (s.table.length + 1 > dkTableLimit(s)) return false;
    // Новому защитнику (нынешнему атакующему) должно хватить карт
    return s.hands[s.attacker].length >= s.table.length + 1;
}

// ---------- Применение хода (возвращает новую партию или null) ----------
function dkApply(state, actor, action) {
    const s = JSON.parse(JSON.stringify(state));
    if (s.over) return null;
    const hand = s.hands[actor];
    const take = (card) => {
        const i = hand.indexOf(card);
        if (i < 0) return false;
        hand.splice(i, 1);
        return true;
    };

    switch (action.type) {
        case "attack": {
            if (actor !== s.attacker || !hand.includes(action.card) || !dkCanAttackWith(s, action.card)) return null;
            take(action.card);
            s.table.push({ a: action.card, d: null });
            s.last = { by: actor, type: s.phase === "taking" ? "throw" : "attack", card: action.card };
            return s;
        }
        case "defend": {
            if (actor !== s.defender || !hand.includes(action.card)) return null;
            const pair = s.table[action.target];
            if (!pair || pair.d || !dkDefendTargets(s, action.card).includes(action.target)) return null;
            take(action.card);
            pair.d = action.card;
            s.last = { by: actor, type: "defend", card: action.card };
            return s;
        }
        case "transfer": {
            if (actor !== s.defender || !hand.includes(action.card) || !dkCanTransfer(s, action.card)) return null;
            take(action.card);
            s.table.push({ a: action.card, d: null });
            [s.attacker, s.defender] = [s.defender, s.attacker];
            s.last = { by: actor, type: "transfer", card: action.card };
            return s;
        }
        case "take": {
            if (actor !== s.defender || s.phase !== "attack" || dkUndefended(s) === 0) return null;
            s.phase = "taking";
            s.last = { by: actor, type: "take" };
            return s;
        }
        case "pass": {
            // Атакующий закончил подкидывать — защитник забирает всё со стола
            if (actor !== s.attacker || s.phase !== "taking") return null;
            const taker = s.defender;
            s.table.forEach(p => { s.hands[taker].push(p.a); if (p.d) s.hands[taker].push(p.d); });
            s.last = { by: taker, type: "took", count: s.table.reduce((n, p) => n + (p.d ? 2 : 1), 0) };
            s.table = [];
            s.phase = "attack";
            dkEndRound(s, false);
            return s;
        }
        case "bita": {
            if (actor !== s.attacker || s.phase !== "attack" || s.table.length === 0 || dkUndefended(s) > 0) return null;
            s.discard += s.table.length * 2;
            s.table = [];
            s.last = { by: actor, type: "bita" };
            dkEndRound(s, true);
            return s;
        }
    }
    return null;
}

function dkEndRound(s, defended) {
    s.firstBout = false;
    // Добор: сначала атакующий, потом защитник
    [s.attacker, s.defender].forEach(p => {
        while (s.hands[p].length < DK_HAND && s.deck.length) s.hands[p].push(s.deck.pop());
    });
    if (defended) [s.attacker, s.defender] = [s.defender, s.attacker];

    if (s.deck.length === 0) {
        const [a, b] = s.players;
        const ea = s.hands[a].length === 0, eb = s.hands[b].length === 0;
        if (ea && eb) s.over = { winner: null, loser: null, reason: "draw" };
        else if (ea) s.over = { winner: a, loser: b, reason: "durak" };
        else if (eb) s.over = { winner: b, loser: a, reason: "durak" };
    }
}

// Удобно отсортированная рука: по мастям (козыри в конце), внутри — по старшинству
function dkSortHand(cards, trump) {
    const suitOrder = (c) => dkSuit(c) === trump ? 9 : DK_SUITS.indexOf(dkSuit(c));
    return cards.slice().sort((x, y) => suitOrder(x) - suitOrder(y) || dkRank(x) - dkRank(y));
}

// ---------- Интерфейс ----------
function dkCardHtml(card, extra = "") {
    const r = DK_RANK_LABEL[card[0]], s = DK_SUIT_SYMBOL[dkSuit(card)];
    const face = "JQKA".includes(card[0]);
    return `<div class="dk-card dk-s-${dkSuit(card)}${face ? " is-face" : ""}${extra}" data-c="${card}">
        <span class="dk-corner"><b>${r}</b><i>${s}</i></span>
        <span class="dk-center">${face ? `<b>${r}</b>` : ""}<i>${s}</i></span>
        <span class="dk-corner dk-corner-br"><b>${r}</b><i>${s}</i></span>
    </div>`;
}
function dkBackHtml(extra = "") { return `<div class="dk-card dk-back${extra}"><span></span></div>`; }

function dkMount(container, ctx) {
    const me = ctx.me;
    container.innerHTML = `
        <div class="dk-table">
            <div class="dk-opp">
                <div class="dk-fan dk-opp-hand" id="dkOppHand"></div>
                <div class="dk-role" id="dkOppRole"></div>
            </div>
            <div class="dk-middle">
                <div class="dk-deck" id="dkDeck"></div>
                <div class="dk-field" id="dkField"></div>
                <div class="dk-discard" id="dkDiscard"></div>
            </div>
            <div class="dk-status" id="dkStatus"></div>
            <div class="dk-actions" id="dkActions"></div>
            <div class="dk-fan dk-hand" id="dkHand"></div>
            <div class="dk-wait" id="dkWait" hidden><div class="dk-wait-box"><span class="dk-wait-icon">⏸</span><span id="dkWaitText"></span></div></div>
        </div>
    `;
    const el = (id) => container.querySelector("#" + id);
    const oppHandEl = el("dkOppHand"), fieldEl = el("dkField"), handEl = el("dkHand");

    let S = null;
    let selected = null;       // выбранная защитником карта, если вариантов несколько
    let prevTable = [];
    let prevHand = new Set();
    let prevOppCount = 0;
    let busy = false;          // ход отправлен, ждём ответ хозяина

    function send(action) {
        busy = true;
        selected = null;
        vibrate(8);
        ctx.act(action);
        setTimeout(() => { busy = false; }, 1200);
    }

    function layoutFan(box) {
        const cards = box.children;
        const n = cards.length;
        if (!n) return;
        const w = cards[0].offsetWidth;
        const avail = box.clientWidth;
        const step = n > 1 ? Math.min(w * 0.78, (avail - w) / (n - 1)) : 0;
        box.style.setProperty("--ml", (n > 1 ? step - w : 0) + "px");
        box.style.setProperty("--fan-w", (w + step * (n - 1)) + "px");
    }

    function onHandClick(e) {
        const cardEl = e.target.closest(".dk-card");
        if (!cardEl || !S || busy) return;
        const card = cardEl.dataset.c;
        if (!cardEl.classList.contains("is-playable")) { cardEl.classList.remove("is-nope"); void cardEl.offsetWidth; cardEl.classList.add("is-nope"); return; }

        if (S.attacker === me) { send({ type: "attack", card }); return; }
        if (S.defender === me && S.phase === "attack") {
            const targets = dkDefendTargets(S, card);
            const canTr = dkCanTransfer(S, card);
            if (targets.length === 1 && !canTr) { send({ type: "defend", card, target: targets[0] }); return; }
            if (targets.length === 0 && canTr) { send({ type: "transfer", card }); return; }
            selected = selected === card ? null : card;
            render();
        }
    }
    function onFieldClick(e) {
        if (!S || !selected || busy) return;
        const tr = e.target.closest(".dk-transfer-slot");
        if (tr) { send({ type: "transfer", card: selected }); return; }
        const pair = e.target.closest(".dk-pair.is-target");
        if (pair) send({ type: "defend", card: selected, target: +pair.dataset.i });
    }
    handEl.addEventListener("click", onHandClick);
    fieldEl.addEventListener("click", onFieldClick);

    function sweep(cardsHtml, cls) {
        const ghost = document.createElement("div");
        ghost.className = `dk-sweep ${cls}`;
        ghost.innerHTML = cardsHtml;
        fieldEl.appendChild(ghost);
        setTimeout(() => ghost.remove(), 650);
    }

    function render() {
        const s = S;
        const opp = dkOther(s, me);
        const pName = ctx.partnerName();
        const myHand = dkSortHand(s.hands[me], s.trump);
        const iAttack = s.attacker === me;
        const iDefend = s.defender === me;

        // Колода и козырь
        el("dkDeck").innerHTML = `
            ${s.deck.length ? `${dkCardHtml(s.trumpCard, " dk-trump-card")}${s.deck.length > 1 ? dkBackHtml(" dk-deck-top") : ""}` : `<div class="dk-trump-empty dk-s-${s.trump}">${DK_SUIT_SYMBOL[s.trump]}</div>`}
            <span class="dk-deck-count">${s.deck.length ? s.deck.length : "колода пуста"} · козырь <b>${DK_SUIT_SYMBOL[s.trump]}</b></span>
        `;
        el("dkDiscard").innerHTML = s.discard ? `<div class="dk-discard-pile">${dkBackHtml()}${dkBackHtml()}</div><span class="dk-deck-count">бито ${s.discard}</span>` : `<span class="dk-deck-count">бито 0</span>`;

        // Рука соперника (рубашками)
        const oppCount = s.hands[opp].length;
        oppHandEl.innerHTML = Array.from({ length: oppCount }, (_, i) => dkBackHtml(i >= prevOppCount ? " is-new" : "")).join("");
        prevOppCount = oppCount;
        el("dkOppRole").innerHTML = `<span class="dk-role-name"></span><span class="dk-role-tag ${s.attacker === opp ? "is-attack" : "is-defend"}">${s.attacker === opp ? "ходит" : "отбивается"}</span><span class="dk-role-count">${oppCount} карт</span>`;
        el("dkOppRole").querySelector(".dk-role-name").textContent = pName;

        // Стол: пары «атака / защита»
        const seen = new Set();
        prevTable.forEach(p => { seen.add(p.a); if (p.d) seen.add(p.d); });
        const from = s.last && s.last.by === me ? "is-from-me" : "is-from-opp";
        let targets = [], canTr = false;
        if (selected) { targets = dkDefendTargets(s, selected); canTr = dkCanTransfer(s, selected); }
        fieldEl.innerHTML = s.table.map((p, i) => `
            <div class="dk-pair${targets.includes(i) ? " is-target" : ""}" data-i="${i}">
                ${dkCardHtml(p.a, seen.has(p.a) ? "" : " is-new " + from)}
                ${p.d ? dkCardHtml(p.d, " dk-cover" + (seen.has(p.d) ? "" : " is-new " + from)) : ""}
            </div>
        `).join("") + (canTr ? `<div class="dk-pair dk-transfer-slot"><span>↪<br>Перевести</span></div>` : "")
            + (s.table.length === 0 ? `<div class="dk-field-empty">${iAttack ? "Твой ход — выкладывай карту" : `Ходит ${escapeGameText(pName)}…`}</div>` : "");

        // Стол только что опустел — карты улетают в «бито» или в руку взявшему
        if (prevTable.length && !s.table.length && s.last) {
            const html = prevTable.map(p => `<div class="dk-pair">${dkCardHtml(p.a)}${p.d ? dkCardHtml(p.d, " dk-cover") : ""}</div>`).join("");
            if (s.last.type === "bita") sweep(html, "to-discard");
            else if (s.last.type === "took") sweep(html, s.last.by === me ? "to-me" : "to-opp");
        }
        prevTable = s.table.map(p => ({ a: p.a, d: p.d }));

        // Моя рука
        handEl.innerHTML = myHand.map(c => {
            let playable = false;
            if (iAttack) playable = dkCanAttackWith(s, c);
            else if (iDefend && s.phase === "attack") playable = dkDefendTargets(s, c).length > 0 || dkCanTransfer(s, c);
            const cls = (playable ? " is-playable" : " is-dim") + (selected === c ? " is-selected" : "") + (prevHand.size && !prevHand.has(c) ? " is-new" : "") + (dkSuit(c) === s.trump ? " is-trump" : "");
            return dkCardHtml(c, cls);
        }).join("");
        prevHand = new Set(myHand);

        // Кнопки и подсказка
        const acts = [];
        let status = "";
        const undef = dkUndefended(s);
        if (iAttack) {
            if (s.phase === "taking") {
                acts.push(`<button type="button" class="ui-btn dk-act dk-act-main" data-a="pass">👐 Пусть забирает</button>`);
                status = `${pName} берёт. Можешь подкинуть ещё или отдать карты.`;
            } else if (s.table.length && !undef) {
                acts.push(`<button type="button" class="ui-btn dk-act dk-act-main" data-a="bita">✅ Бита</button>`);
                status = "Всё отбито. Подкинь ещё или жми «Бита».";
            } else if (s.table.length) {
                status = `${pName} отбивается…`;
            } else {
                status = "Твой ход.";
            }
        } else if (iDefend) {
            if (!s.table.length) {
                status = `Ходит ${pName}…`;
            } else if (s.phase === "taking") {
                status = `Ты берёшь — ${pName} может подкинуть ещё.`;
            } else if (undef) {
                acts.push(`<button type="button" class="ui-btn dk-act dk-act-take" data-a="take">🫴 Беру</button>`);
                status = selected ? "Выбери, какую карту побить" + (dkCanTransfer(s, selected) ? " или переведи" : "") : (s.mode === "perevodnoy" && !s.table.some(p => p.d) ? "Отбивайся или переводи." : "Отбивайся.");
            } else {
                status = `Отбито. ${pName} решает — подкинуть или «Бита».`;
            }
        }
        if (s.last && s.last.by !== me) {
            const lastText = { transfer: `↪ ${pName} перевёл(а)!` }[s.last.type];
            if (lastText) status = lastText + " " + status;
        }
        el("dkStatus").textContent = status;
        el("dkStatus").classList.toggle("is-my-turn", acts.length > 0 || (iAttack && !s.table.length) || (iDefend && undef > 0 && s.phase === "attack"));
        el("dkActions").innerHTML = acts.join("");
        el("dkActions").querySelectorAll(".dk-act").forEach(b => { b.onclick = () => { if (!busy) send({ type: b.dataset.a }); }; });

        container.querySelector(".dk-table").classList.toggle("is-trump-" + s.trump, true);
        requestAnimationFrame(() => { layoutFan(handEl); layoutFan(oppHandEl); });
    }

    const ro = new ResizeObserver(() => { layoutFan(handEl); layoutFan(oppHandEl); });
    ro.observe(handEl);

    return {
        update(state, info) {
            const changed = !S || JSON.stringify(S) !== JSON.stringify(state);
            S = state;
            busy = false;
            if (selected && !state.hands[me].includes(selected)) selected = null;
            if (changed) render();
            const wait = el("dkWait");
            wait.hidden = !!info.partnerHere || !!state.over;
            el("dkWaitText").textContent = `${ctx.partnerName()} вышел(а) из комнаты — партия на паузе. Продолжите, когда вернётся.`;
        },
        destroy() { ro.disconnect(); }
    };
}

duoRegister({
    id: "durak",
    title: "Дурак",
    emoji: "🃏",
    hue: 330,
    short: "Подкидной и переводной, 36 карт",
    loseText: "Остался(ась) дураком",
    loseEmoji: "🤡",
    lobbyArt: `<div class="dk-lobby-fan">${["AS", "KH", "QD", "JC"].map(c => dkCardHtml(c)).join("")}</div>`,
    options: [{
        key: "mode",
        label: "Вариант",
        values: [
            { v: "podkidnoy", label: "Подкидной", desc: "Классика: отбиваешься или берёшь" },
            { v: "perevodnoy", label: "Переводной", desc: "Картой того же достоинства можно перевести ход" }
        ]
    }],
    newGame: dkNewGame,
    applyAction: dkApply,
    mount: dkMount
});
