// ==========================================
// chart.js — КАРТА ИГР: звёздная карта и чертёж станции
// ==========================================
// Подключается после duo.js. Все игры лежат на одной карте: в центре —
// чертёж станции, на внутренней орбите игры вдвоём (сектор A), на внешней —
// одиночные (сектор B). На телефоне те же точки идут двумя колонками.
//
// Всё статичное: без анимаций, размытий и теней-фильтров. Свечение линий —
// вторая, толстая и почти прозрачная копия той же линии.

const GC_CRAFT = `
    <rect x="-34" y="-16" width="68" height="32" rx="6"/>
    <path d="M34-16 62-6V6L34 16M-34-12-52-18V18L-34 12M-52-10-64-14V14L-52 10"/>
    <ellipse rx="10" ry="30"/>
    <path d="M-6-16V-30M6-16V-30M-6 16V30M6 16V30"/>
    <rect x="-44" y="-66" width="88" height="36"/>
    <rect x="-44" y="30" width="88" height="36"/>
    <path d="M-22-66V-30M0-66V-30M22-66V-30M-44-48H44M-22 30V66M0 30V66M22 30V66M-44 48H44"/>
    <path d="M62 0H78M78-14Q90 0 78 14"/>
    <circle cx="-20" r="3"/><circle cx="20" r="3"/>
`;

function gcEsc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// Детерминированный «случайный» ряд: звёзды не прыгают при перестроении
function gcRandom(seed) {
    let s = seed;
    return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

function gcCraftSvg(x, y, k) {
    return `<g transform="translate(${x} ${y}) scale(${k})">
        <g class="gc-glow">${GC_CRAFT}</g>
        <g class="gc-line">${GC_CRAFT}</g>
        <g class="gc-note">
            <path d="M62-6 92-40H132M-44-66-80-88H-126M-64 80H78M-64 74V86M78 74V86"/>
            <text x="94" y="-45">ОТСЕК-Н</text>
            <text x="-126" y="-93">ПАНЕЛЬ 2×3</text>
            <text x="7" y="96" text-anchor="middle">L 142.0 ЕД</text>
        </g>
    </g>`;
}

// Орбита-эллипс с насечками и подписями градусов
function gcOrbit(cx, cy, rx, ry, cls, labels) {
    let ticks = "", text = "";
    for (let a = 0; a < 360; a += 10) {
        const r = a * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        const len = a % 30 === 0 ? 1.035 : 1.015;
        ticks += `M${(cx + rx * c).toFixed(1)} ${(cy + ry * s).toFixed(1)}L${(cx + rx * len * c).toFixed(1)} ${(cy + ry * len * s).toFixed(1)}`;
        if (labels && a % 30 === 0) {
            text += `<text x="${(cx + rx * 1.06 * c).toFixed(1)}" y="${(cy + ry * 1.06 * s + 3).toFixed(1)}" text-anchor="middle">${String(a).padStart(3, "0")}°</text>`;
        }
    }
    return `<ellipse class="${cls}" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/><path class="gc-tick" d="${ticks}"/><g class="gc-deg">${text}</g>`;
}

function gcStars(W, H) {
    const rnd = gcRandom(4217);
    let dots = "", crosses = "";
    for (let i = 0; i < 70; i++) {
        const x = (rnd() * W).toFixed(1), y = (rnd() * H).toFixed(1);
        dots += `<circle cx="${x}" cy="${y}" r="${(0.5 + rnd() * 0.9).toFixed(1)}"/>`;
    }
    for (let i = 0; i < 10; i++) {
        const x = rnd() * W, y = rnd() * H;
        crosses += `M${(x - 4).toFixed(1)} ${y.toFixed(1)}h8M${x.toFixed(1)} ${(y - 4).toFixed(1)}v8`;
    }
    return `<g class="gc-star">${dots}</g><path class="gc-cross" d="${crosses}"/>`;
}

function buildGamesChart() {
    duoInit();
    const chart = document.createElement("section");
    chart.className = "gc-chart";
    chart.innerHTML = `
        <svg class="gc-svg" aria-hidden="true"></svg>
        <div class="gc-block gc-block-title">
            <b>КАРТА ИГР</b>
            <span>ЛИСТ 01 · СИСТЕМА 愛</span>
        </div>
        <div class="gc-block gc-block-presence" id="gcPresence"></div>
        <div class="gc-block gc-block-legend">
            <span class="is-a">◉ СЕКТОР A — ВДВОЁМ</span>
            <span class="is-b">◉ СЕКТОР B — ОДИНОЧНЫЕ</span>
        </div>
    `;
    const svg = chart.querySelector(".gc-svg");

    const duoDefs = Object.values(DUO_GAMES);
    const items = [
        ...duoDefs.map((def, i) => ({ sector: "a", code: "A-" + String(i + 1).padStart(2, "0"), id: def.id, hue: def.hue || 300, emoji: def.emoji, title: def.title, open: () => openDuoRoom(def.id) })),
        ...GAMES_META.map((g, i) => ({ sector: "b", code: "B-" + String(i + 1).padStart(2, "0"), id: g.id, hue: g.hue, emoji: g.emoji, title: g.title, game: g, open: () => showGameInfoModal(g.id) })),
    ];
    items.forEach((it) => {
        const node = document.createElement("button");
        node.type = "button";
        node.className = `ui-btn gc-node is-${it.sector}`;
        node.style.setProperty("--h", it.hue);
        node.setAttribute("aria-label", it.title);
        node.innerHTML = `
            <span class="gc-mark"><span class="gc-emoji">${it.emoji}</span><span class="gc-badge" hidden>ЖДЁТ</span></span>
            <span class="gc-code">${it.code}</span>
            <span class="gc-title">${gcEsc(it.title)}</span>
            <span class="gc-sub"></span>
        `;
        node.onclick = it.open;
        it.el = node;
        chart.appendChild(node);
    });

    function renderInfo() {
        const pName = duoPartnerName();
        const pres = chart.querySelector("#gcPresence");
        const where = duo.partnerOnline && duo.partner && duo.partner.room && DUO_GAMES[duo.partner.room];
        pres.classList.toggle("is-on", !!duo.partnerOnline);
        pres.textContent = !duo.partnerOnline
            ? `◌ ${pName}: НЕ В ИГРАХ`
            : where ? `◉ ${pName} ЖДЁТ: ${where.title}` : `◉ ${pName}: НА КАРТЕ`;
        items.forEach((it) => {
            const sub = it.el.querySelector(".gc-sub");
            if (it.sector === "b") { sub.innerHTML = buildGameTileScore(it.game); return; }
            const def = DUO_GAMES[it.id];
            const room = duoLoadRoom(it.id);
            const waiting = !!(duo.partnerOnline && duo.partner && duo.partner.room === it.id);
            const playing = room.game && !room.game.over;
            sub.textContent = waiting ? `${pName} уже за столом` : playing ? "Есть незаконченная партия" : def.short || "";
            it.el.classList.toggle("is-waiting", waiting);
            it.el.querySelector(".gc-badge").hidden = !waiting;
        });
    }

    function place(it, x, y, w) {
        it.x = x; it.y = y;
        it.el.style.left = x + "px";
        it.el.style.top = y + "px";
        it.el.style.width = w + "px";
    }

    function layout() {
        const W = chart.clientWidth;
        if (!W) return;
        const a = items.filter(i => i.sector === "a"), b = items.filter(i => i.sector === "b");
        const wide = W >= 760;
        chart.classList.toggle("is-wide", wide);
        let H, art = "";
        if (wide) {
            H = Math.max(840, Math.round(W * 0.78));
            const cx = W / 2, cy = H / 2;
            const ring = (list, rx, ry) => list.forEach((it, i) => {
                const ang = (-90 + 180 / list.length + i * 360 / list.length) * Math.PI / 180;
                place(it, cx + rx * Math.cos(ang), cy + ry * Math.sin(ang), 176);
            });
            const irx = W * 0.235, iry = H * 0.23, orx = W * 0.415, ory = H * 0.4;
            ring(a, irx, iry);
            ring(b, orx, ory);
            art = gcStars(W, H)
                + `<path class="gc-axis" d="M0 ${cy}H${W}M${cx} 0V${H}"/>`
                + gcOrbit(cx, cy, orx, ory, "gc-orbit is-b", true)
                + gcOrbit(cx, cy, irx, iry, "gc-orbit is-a", false)
                + gcCraftSvg(cx, cy, Math.min(0.95, W / 1250));
        } else {
            const colW = (W - 24) / 2, xL = 12 + colW / 2, xR = W - 12 - colW / 2;
            const rowH = 190;
            let y = 318;
            const column = (list) => {
                list.forEach((it, i) => {
                    place(it, i % 2 === 0 ? xL : xR, y + Math.floor(i / 2) * rowH + (i % 2 ? 26 : 0), colW);
                });
                y += Math.ceil(list.length / 2) * rowH + 40;
            };
            const yA = y - 40;
            column(a);
            const yB = y - 40;
            column(b);
            H = y - 30;
            const cx = W / 2, cy = 180;
            art = gcStars(W, H)
                + `<path class="gc-axis" d="M${cx} 0V${H}M0 ${cy}H${W}"/>`
                + gcOrbit(cx, cy, W * 0.46, 104, "gc-orbit is-b", false)
                + gcCraftSvg(cx, cy, Math.min(0.72, W / 480))
                + `<text class="gc-sector is-a" x="12" y="${yA}">СЕКТОР A — ВДВОЁМ</text>`
                + `<text class="gc-sector is-b" x="12" y="${yB}">СЕКТОР B — ОДИНОЧНЫЕ</text>`;
        }
        // Созвездия: линии между соседними точками сектора
        const links = (list, cls) => {
            if (list.length < 2) return "";
            const pts = wide ? [...list, list[0]] : list;
            return `<path class="gc-link ${cls}" d="${pts.map((it, i) => `${i ? "L" : "M"}${it.x.toFixed(1)} ${it.y.toFixed(1)}`).join("")}"/>`;
        };
        chart.style.height = H + "px";
        svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
        svg.innerHTML = art + links(a, "is-a") + links(b, "is-b");
    }

    const listener = () => {
        if (!chart.isConnected) { duo.listeners.delete(listener); return; }
        renderInfo();
    };
    duo.listeners.add(listener);
    renderInfo();
    const observer = new ResizeObserver(() => {
        if (chart.isConnected) layout();
        else observer.disconnect();
    });
    observer.observe(chart);
    return chart;
}
