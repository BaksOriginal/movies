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

// Почему ход не проходит — короткое объяснение вместо подсказок заранее
function dkWhyNot(s, me, pName, intent, card, target) {
    if (s.attacker !== me && s.defender !== me) return "Сейчас не твой ход";
    if (intent === "attack") {
        if (s.attacker !== me) return `Сейчас ходит ${pName}`;
        if (s.table.length >= dkTableLimit(s)) return s.firstBout ? "В первый отбой — не больше 5 карт" : "На столе уже 6 карт";
        if (dkUndefended(s) >= s.hands[s.defender].length) return `Больше не подкинуть — у ${pName} не хватит карт`;
        return "Подкидывать можно только карты того же достоинства, что уже на столе";
    }
    if (s.defender !== me) return `Сейчас ходит ${pName}`;
    if (s.phase === "taking") return "Ты уже берёшь карты";
    if (intent === "defend") {
        const pair = s.table[target];
        if (!pair) return "Положи карту на ту, которую бьёшь";
        if (pair.d) return "Эта карта уже побита";
        return `${DK_RANK_LABEL[card[0]]}${DK_SUIT_SYMBOL[dkSuit(card)]} не бьёт ${DK_RANK_LABEL[pair.a[0]]}${DK_SUIT_SYMBOL[dkSuit(pair.a)]} — нужна старше той же масти или козырь`;
    }
    if (intent === "transfer") {
        if (s.mode !== "perevodnoy") return "Положи карту на ту, которую бьёшь";
        if (s.table.some(p => p.d)) return "Переводить можно только до первой отбитой карты";
        if (!s.table.every(p => p.a[0] === card[0])) return "Перевести можно только картой того же достоинства";
        if (s.table.length + 1 > dkTableLimit(s)) return "Больше карт на стол не положить";
        return `У ${pName} не хватит карт, чтобы отбиться — перевести нельзя`;
    }
    return "Так нельзя";
}

function dkMount(container, ctx) {
    const me = ctx.me;
    container.innerHTML = `
        <div class="dk-table">
            <div class="dk-opp">
                <div class="dk-fan dk-opp-hand" id="dkOppHand"></div>
                <div class="dk-role" id="dkOppRole"></div>
            </div>
            <div class="dk-middle">
                <div class="dk-side">
                    <div class="dk-deck" id="dkDeck"></div>
                    <div class="dk-discard" id="dkDiscard"></div>
                </div>
                <div class="dk-field" id="dkField"></div>
            </div>
            <div class="dk-status" id="dkStatus"></div>
            <div class="dk-actions" id="dkActions"></div>
            <div class="dk-fan dk-hand" id="dkHand"></div>
            <div class="dk-toast" id="dkToast"></div>
            <div class="dk-wait" id="dkWait" hidden><div class="dk-wait-box"><span class="dk-wait-icon">⏸</span><span id="dkWaitText"></span></div></div>
        </div>
    `;
    const el = (id) => container.querySelector("#" + id);
    const tableEl = container.querySelector(".dk-table");
    const oppHandEl = el("dkOppHand"), fieldEl = el("dkField"), handEl = el("dkHand"), middleEl = container.querySelector(".dk-middle");

    let S = null;
    let selected = null;       // карта, поднятая тапом (вместо перетаскивания)
    let prevTable = [];
    let prevHand = new Set();
    let prevOppCount = 0;
    let pending = null;        // { card, timer } — ход отправлен, ждём ответ хозяина
    let placedCard = null;     // карта, которую только что положили руками (без «прилёта»)
    let drag = null;

    // ---------- Ход: проверка и отправка ----------
    function resolveDrop(card, pairIndex) {
        const s = S;
        const pName = ctx.partnerName();
        if (s.attacker === me) {
            return dkCanAttackWith(s, card) ? { type: "attack", card } : { error: dkWhyNot(s, me, pName, "attack", card) };
        }
        if (s.defender !== me || s.phase !== "attack") return { error: dkWhyNot(s, me, pName, "defend", card, pairIndex) };
        const undef = s.table.map((p, i) => p.d ? -1 : i).filter(i => i >= 0);
        if (pairIndex != null && s.table[pairIndex] && !s.table[pairIndex].d) {
            return dkDefendTargets(s, card).includes(pairIndex) ? { type: "defend", card, target: pairIndex } : { error: dkWhyNot(s, me, pName, "defend", card, pairIndex) };
        }
        // Мимо конкретной карты: в переводном — попытка перевода; иначе,
        // если отбивать нужно одну карту, считаем, что бьём её
        if (s.mode === "perevodnoy" && s.table.length && !s.table.some(p => p.d) && s.table.every(p => p.a[0] === card[0])) {
            return dkCanTransfer(s, card) ? { type: "transfer", card } : { error: dkWhyNot(s, me, pName, "transfer", card) };
        }
        if (undef.length === 1) {
            return dkDefendTargets(s, card).includes(undef[0]) ? { type: "defend", card, target: undef[0] } : { error: dkWhyNot(s, me, pName, "defend", card, undef[0]) };
        }
        if (!undef.length) return { error: `Всё отбито — ждём, что решит ${pName}` };
        return { error: s.mode === "perevodnoy" && !s.table.some(p => p.d) ? dkWhyNot(s, me, pName, "transfer", card) : "Положи карту на ту, которую бьёшь" };
    }

    function send(action) {
        selected = null;
        vibrate(8);
        if (action.card) {
            placedCard = action.card;
            const c = handEl.querySelector(`.dk-card[data-c="${action.card}"]`);
            if (c) c.classList.add("is-sending");
            if (pending) clearTimeout(pending.timer);
            pending = { card: action.card, timer: setTimeout(() => { pending = null; render(); }, 1500) };
        }
        ctx.act(action);
    }

    let toastTimer = null;
    function toast(text) {
        const t = el("dkToast");
        t.textContent = text;
        t.classList.remove("is-on");
        void t.offsetWidth;
        t.classList.add("is-on");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove("is-on"), 2600);
    }

    function reject(cardEl, text) {
        vibrate([20, 30, 20]);
        if (cardEl) { cardEl.classList.remove("is-nope"); void cardEl.offsetWidth; cardEl.classList.add("is-nope"); }
        if (text) toast(text);
    }

    function tryPlay(card, pairIndex, cardEl) {
        if (!S || S.over || pending) return false;
        const res = resolveDrop(card, pairIndex);
        if (res.error) { reject(cardEl, res.error); return false; }
        send(res);
        return true;
    }

    // ---------- Перетаскивание ----------
    function dropTargetAt(x, y) {
        const hit = document.elementFromPoint(x, y);
        if (!hit) return null;
        const pair = hit.closest(".dk-field .dk-pair");
        if (pair) return { pair: +pair.dataset.i };
        if (hit.closest(".dk-middle") || hit.closest(".dk-opp") || hit.closest(".dk-status")) return { pair: null };
        return null;
    }

    function onPointerDown(e) {
        const cardEl = e.target.closest(".dk-card");
        if (!cardEl || !S || e.button > 0 || drag) return;
        drag = { cardEl, card: cardEl.dataset.c, id: e.pointerId, x0: e.clientX, y0: e.clientY, moving: false, ghost: null };
        try { cardEl.setPointerCapture(e.pointerId); } catch (err) {}
    }
    function onPointerMove(e) {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
        if (!drag.moving) {
            if (Math.hypot(dx, dy) < 7) return;
            drag.moving = true;
            const r = drag.cardEl.getBoundingClientRect();
            const ghost = drag.cardEl.cloneNode(true);
            ghost.classList.add("dk-ghost");
            ghost.classList.remove("is-new", "is-selected", "is-nope");
            ghost.style.setProperty("--w", r.width + "px");
            ghost.style.left = r.left + "px";
            ghost.style.top = r.top + "px";
            document.body.appendChild(ghost);
            drag.ghost = ghost;
            drag.offX = drag.x0 - r.left;
            drag.offY = drag.y0 - r.top;
            drag.cardEl.classList.add("is-dragging");
            selected = null;
            markSelected();
            tableEl.classList.add("is-dragging");
        }
        e.preventDefault();
        drag.ghost.style.left = (e.clientX - drag.offX) + "px";
        drag.ghost.style.top = (e.clientY - drag.offY) + "px";
        const t = dropTargetAt(e.clientX, e.clientY);
        fieldEl.querySelectorAll(".is-hover").forEach(p => p.classList.remove("is-hover"));
        middleEl.classList.toggle("is-hover", !!t);
        if (t && t.pair != null) {
            const p = fieldEl.querySelector(`.dk-pair[data-i="${t.pair}"]`);
            if (p) p.classList.add("is-hover");
        }
    }
    function endDrag(e, cancelled) {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag;
        drag = null;
        tableEl.classList.remove("is-dragging");
        middleEl.classList.remove("is-hover");
        fieldEl.querySelectorAll(".is-hover").forEach(p => p.classList.remove("is-hover"));
        if (!d.moving) {
            // Простой тап: поднять / опустить карту (положить — тапом по столу)
            if (!cancelled) { selected = selected === d.card ? null : d.card; markSelected(); }
            return;
        }
        const t = cancelled ? null : dropTargetAt(e.clientX, e.clientY);
        const ok = t && tryPlay(d.card, t.pair, d.cardEl);
        if (ok) {
            d.ghost.remove();
            d.cardEl.classList.remove("is-dragging");
            return;
        }
        // Ход не засчитан — карта плавно возвращается в руку
        const r = d.cardEl.getBoundingClientRect();
        d.ghost.classList.add("is-returning");
        d.ghost.style.left = r.left + "px";
        d.ghost.style.top = r.top + "px";
        setTimeout(() => { d.ghost.remove(); d.cardEl.classList.remove("is-dragging"); }, 230);
    }
    handEl.addEventListener("pointerdown", onPointerDown);
    handEl.addEventListener("pointermove", onPointerMove);
    handEl.addEventListener("pointerup", (e) => endDrag(e, false));
    handEl.addEventListener("pointercancel", (e) => endDrag(e, true));
    handEl.addEventListener("dragstart", (e) => e.preventDefault());

    function markSelected() {
        handEl.querySelectorAll(".dk-card").forEach(c => c.classList.toggle("is-selected", c.dataset.c === selected));
        middleEl.classList.toggle("is-armed", !!selected);
    }

    // Поднятую тапом карту можно положить тапом по столу или по карте на столе
    middleEl.addEventListener("click", (e) => {
        if (!selected || !S) return;
        const pair = e.target.closest(".dk-field .dk-pair");
        const cardEl = handEl.querySelector(`.dk-card[data-c="${selected}"]`);
        tryPlay(selected, pair ? +pair.dataset.i : null, cardEl);
        markSelected();
    });

    // ---------- Раскладка ----------
    function layoutFan(box) {
        const cards = box.children;
        const n = cards.length;
        if (!n) return;
        const w = cards[0].offsetWidth;
        const avail = box.clientWidth;
        const step = n > 1 ? Math.min(w * 0.78, (avail - w) / (n - 1)) : 0;
        box.style.setProperty("--ml", (n > 1 ? step - w : 0) + "px");
    }

    // Подбираем размер карт на столе, чтобы все пары влезли без прокрутки
    function layoutField() {
        const n = Math.max(1, S ? S.table.length : 1);
        const W = fieldEl.clientWidth, H = fieldEl.clientHeight;
        if (!W || !H) return;
        const maxW = parseFloat(getComputedStyle(fieldEl).getPropertyValue("--fw-max")) || 56;
        let w = maxW;
        for (; w > 30; w -= 2) {
            const pw = w * 1.5 + 6, ph = w * 1.8 + 6;
            const perRow = Math.max(1, Math.floor(W / pw));
            if (Math.ceil(n / perRow) * ph <= H) break;
        }
        fieldEl.style.setProperty("--fw", w + "px");
    }

    function layoutAll() {
        layoutFan(handEl);
        layoutFan(oppHandEl);
        layoutField();
    }

    function sweep(cardsHtml, cls) {
        const ghost = document.createElement("div");
        ghost.className = `dk-sweep ${cls}`;
        ghost.innerHTML = cardsHtml;
        fieldEl.appendChild(ghost);
        setTimeout(() => ghost.remove(), 650);
    }

    function render() {
        const s = S;
        if (!s) return;
        const opp = dkOther(s, me);
        const pName = ctx.partnerName();
        const myHand = dkSortHand(s.hands[me], s.trump);
        const iAttack = s.attacker === me;
        const iDefend = s.defender === me;

        // Колода и козырь
        el("dkDeck").innerHTML = `
            <div class="dk-deck-stack">
                ${s.deck.length ? `${dkCardHtml(s.trumpCard, " dk-trump-card")}${s.deck.length > 1 ? dkBackHtml(" dk-deck-top") : ""}` : `<div class="dk-trump-empty dk-s-${s.trump}">${DK_SUIT_SYMBOL[s.trump]}</div>`}
            </div>
            <span class="dk-deck-count">${s.deck.length ? s.deck.length : "пусто"} · <b class="dk-s-${s.trump}">${DK_SUIT_SYMBOL[s.trump]}</b></span>
        `;
        el("dkDiscard").innerHTML = `<div class="dk-discard-pile">${s.discard ? dkBackHtml() + dkBackHtml() : ""}</div><span class="dk-deck-count">бито ${s.discard}</span>`;

        // Рука соперника (рубашками)
        const oppCount = s.hands[opp].length;
        oppHandEl.innerHTML = Array.from({ length: oppCount }, (_, i) => dkBackHtml(i >= prevOppCount ? " is-new" : "")).join("");
        prevOppCount = oppCount;
        const oppTag = s.attacker === opp ? (s.phase === "taking" ? "подкидывает" : "ходит") : (s.phase === "taking" ? "берёт" : "отбивается");
        el("dkOppRole").innerHTML = `<span class="dk-role-name"></span><span class="dk-role-tag ${s.attacker === opp ? "is-attack" : "is-defend"}">${oppTag}</span><span class="dk-role-count">${oppCount} ${dkPlural(oppCount)}</span>`;
        el("dkOppRole").querySelector(".dk-role-name").textContent = pName;

        // Стол: пары «атака / защита»
        const seen = new Set();
        prevTable.forEach(p => { seen.add(p.a); if (p.d) seen.add(p.d); });
        const from = s.last && s.last.by === me ? "is-from-me" : "is-from-opp";
        const anim = (c) => seen.has(c) ? "" : c === placedCard ? " is-placed" : " is-new " + from;
        fieldEl.innerHTML = s.table.map((p, i) => `
            <div class="dk-pair${p.d ? " is-covered" : ""}" data-i="${i}">
                ${dkCardHtml(p.a, anim(p.a))}
                ${p.d ? dkCardHtml(p.d, " dk-cover" + anim(p.d)) : ""}
            </div>
        `).join("") + (s.table.length === 0 ? `<div class="dk-field-empty">${iAttack ? "Твой ход — перетащи карту на стол" : `Ходит ${escapeGameText(pName)}…`}</div>` : "");
        placedCard = null;

        // Стол только что опустел — карты улетают в «бито» или в руку взявшему
        if (prevTable.length && !s.table.length && s.last) {
            const html = prevTable.map(p => `<div class="dk-pair">${dkCardHtml(p.a)}${p.d ? dkCardHtml(p.d, " dk-cover") : ""}</div>`).join("");
            if (s.last.type === "bita") sweep(html, "to-discard");
            else if (s.last.type === "took") sweep(html, s.last.by === me ? "to-me" : "to-opp");
        }
        prevTable = s.table.map(p => ({ a: p.a, d: p.d }));

        // Моя рука
        if (pending && !myHand.includes(pending.card)) { clearTimeout(pending.timer); pending = null; }
        handEl.innerHTML = myHand.map(c => {
            const cls = (selected === c ? " is-selected" : "") + (prevHand.size && !prevHand.has(c) ? " is-new" : "") + (dkSuit(c) === s.trump ? " is-trump" : "") + (pending && pending.card === c ? " is-sending" : "");
            return dkCardHtml(c, cls);
        }).join("");
        prevHand = new Set(myHand);
        middleEl.classList.toggle("is-armed", !!selected);

        // Кнопки и строка «чей ход» — без подсказок, какой картой ходить
        const acts = [];
        let status = "";
        const undef = dkUndefended(s);
        if (iAttack) {
            if (s.phase === "taking") {
                acts.push(`<button type="button" class="ui-btn dk-act dk-act-main" data-a="pass">👐 Пусть забирает</button>`);
                status = `${pName} берёт. Подкинь ещё или отдай карты.`;
            } else if (s.table.length && !undef) {
                acts.push(`<button type="button" class="ui-btn dk-act dk-act-main" data-a="bita">✅ Бита</button>`);
                status = "Всё отбито. Подкинь ещё или «Бита».";
            } else if (s.table.length) {
                status = `${pName} отбивается…`;
            } else {
                status = "Твой ход";
            }
        } else if (iDefend) {
            if (!s.table.length) {
                status = `Ходит ${pName}…`;
            } else if (s.phase === "taking") {
                status = `Ты берёшь — ${pName} может подкинуть ещё`;
            } else if (undef) {
                acts.push(`<button type="button" class="ui-btn dk-act dk-act-take" data-a="take">🤲 Беру</button>`);
                status = s.mode === "perevodnoy" && !s.table.some(p => p.d) ? "Отбивайся или переводи" : "Отбивайся";
            } else {
                status = `Отбито. ${pName} решает — подкинуть или «Бита»`;
            }
        }
        if (s.last && s.last.by !== me && s.last.type === "transfer") status = `↪ ${pName} перевёл(а)! ` + status;
        el("dkStatus").textContent = status;
        const myTurn = (iAttack && (s.phase === "taking" || !s.table.length || !undef)) || (iDefend && s.phase === "attack" && undef > 0);
        el("dkStatus").classList.toggle("is-my-turn", myTurn);
        el("dkActions").innerHTML = acts.join("");
        el("dkActions").querySelectorAll(".dk-act").forEach(b => { b.onclick = () => { if (!pending) send({ type: b.dataset.a }); }; });

        layoutAll();
        requestAnimationFrame(layoutAll);
    }

    const ro = new ResizeObserver(() => { if (S) layoutAll(); });
    ro.observe(tableEl);
    ro.observe(fieldEl);

    return {
        update(state, info) {
            const changed = !S || JSON.stringify(S) !== JSON.stringify(state);
            if (S && changed) thingSound("card");
            S = state;
            if (selected && !state.hands[me].includes(selected)) selected = null;
            if (changed) render();
            el("dkWait").hidden = !!info.partnerHere || !!state.over;
            el("dkWaitText").textContent = `${ctx.partnerName()} вышел(а) из комнаты — партия на паузе. Продолжите, когда вернётся.`;
        },
        destroy() {
            ro.disconnect();
            document.querySelectorAll(".dk-ghost").forEach(g => g.remove());
        }
    };
}

function dkPlural(n) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return "карта";
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "карты";
    return "карт";
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
