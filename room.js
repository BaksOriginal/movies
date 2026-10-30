// ==========================================
// room.js — ГЛАВНАЯ В ВИДЕ КОМНАТЫ
// ==========================================
// Подключается на главной после vhs.js и pet.js. Вид на вашу комнату: каждый
// предмет ведёт в свой раздел сайта. Обычная главная остаётся — переключатель
// над комнатой, выбор запоминается в браузере.
//
// Предметы — отдельные SVG, у каждого две пары координат в процентах от сцены:
// wide для ПК и tall для телефона (какие применить, решает CSS, см. ui.css).
// Анимация в комнате одна — экран телевизора.

const ROOM_VIEW_KEY = "homeView";
const ROOM_LAMP_KEY = "roomLampOff";

const ROOM_ART = {
    board: `<svg viewBox="0 0 240 150"><rect width="240" height="150" rx="5" fill="#4a2f1c"/><rect x="8" y="8" width="224" height="134" fill="#a97f53"/><g fill="#7f5c38"><circle cx="30" cy="30" r="1.4"/><circle cx="90" cy="118" r="1.4"/><circle cx="170" cy="40" r="1.4"/><circle cx="205" cy="110" r="1.4"/><circle cx="130" cy="75" r="1.4"/></g><path d="M58 34Q105 62 170 34Q150 70 110 92" fill="none" stroke="#d8132f" stroke-width="1.6"/><g transform="rotate(-4 58 50)"><rect x="30" y="30" width="56" height="48" fill="#ffe873"/><path d="M36 46h42M36 55h34M36 64h38" stroke="#7a6a2d" stroke-width="2"/></g><g transform="rotate(3 170 50)"><rect x="146" y="28" width="52" height="44" fill="#ffb3d1"/><path d="M152 44h38M152 53h28" stroke="#8d4a68" stroke-width="2"/></g><g transform="rotate(-2 110 105)"><rect x="86" y="90" width="50" height="42" fill="#aee2ff"/><path d="M92 106h36M92 115h26" stroke="#3f6e8a" stroke-width="2"/></g><g fill="#e0234e"><circle cx="58" cy="32" r="3.6"/><circle cx="170" cy="30" r="3.6"/><circle cx="110" cy="92" r="3.6"/></g></svg>`,
    frame: `<svg viewBox="0 0 80 92"><rect width="80" height="92" rx="3" fill="#2b1a0f"/><rect x="7" y="7" width="66" height="78" fill="#2b1040"/><path d="M40 67S17 53 17 37a12.5 12.5 0 0 1 23-7 12.5 12.5 0 0 1 23 7c0 16-23 30-23 30z" fill="#ff2e93"/><path d="M26 34a7 7 0 0 1 8-6" fill="none" stroke="#ffd0e6" stroke-width="2.5" stroke-linecap="round"/></svg>`,
    sofa: `<svg viewBox="0 0 300 150"><path d="M40 16h220a22 22 0 0 1 22 22v62H18V38a22 22 0 0 1 22-22z" fill="#553183"/><path d="M152 18v70" stroke="#3d2263" stroke-width="3"/><rect x="28" y="78" width="244" height="44" rx="14" fill="#6a3ea1"/><path d="M150 80v40" stroke="#4e2c7c" stroke-width="3"/><rect x="2" y="56" width="42" height="70" rx="17" fill="#4a2a73"/><rect x="256" y="56" width="42" height="70" rx="17" fill="#4a2a73"/><rect x="24" y="122" width="16" height="22" fill="#20120a"/><rect x="260" y="122" width="16" height="22" fill="#20120a"/><rect x="50" y="52" width="44" height="30" rx="9" fill="#ff7fc4" transform="rotate(-9 72 67)"/><rect x="208" y="52" width="44" height="30" rx="9" fill="#2ee8ff" opacity=".85" transform="rotate(8 230 67)"/></svg>`,
    lamp: `<svg viewBox="0 0 70 260"><path class="room-lamp-shade" d="M18 8h34l14 62H4z" fill="#ffd98f"/><path d="M18 8h34l2 9H16z" fill="#c9974f"/><rect x="33" y="70" width="4" height="170" fill="#6d6256"/><path d="M38 90v44" stroke="#c9974f" stroke-width="1.5"/><circle cx="38" cy="137" r="3" fill="#c9974f"/><ellipse cx="35" cy="246" rx="24" ry="9" fill="#3a3129"/></svg>`,
    arcade: `<svg viewBox="0 0 130 280"><path d="M18 4h94l6 56-6 12 8 80-8 124H12L4 152l8-80-5-12z" fill="#21123f"/><path d="M18 4h94l6 56H7z" fill="#ff2e93"/><text x="65" y="39" text-anchor="middle" font-family="ui-monospace,Consolas,monospace" font-size="20" font-weight="900" fill="#fff">ИГРЫ</text><rect x="20" y="70" width="90" height="72" rx="6" fill="#050a18" stroke="#2ee8ff" stroke-width="2"/><g fill="#2ee8ff"><rect x="34" y="84" width="6" height="6"/><rect x="46" y="84" width="6" height="6"/><rect x="58" y="84" width="6" height="6"/><rect x="70" y="84" width="6" height="6"/><rect x="82" y="84" width="6" height="6"/></g><g fill="#ff7fc4"><rect x="40" y="97" width="6" height="6"/><rect x="52" y="97" width="6" height="6"/><rect x="64" y="97" width="6" height="6"/><rect x="76" y="97" width="6" height="6"/></g><path d="M58 128h14l-7-9z" fill="#ffd15c"/><path d="M6 150h118l-6 28H12z" fill="#3a2363"/><circle cx="42" cy="154" r="6" fill="#ff4f6e"/><path d="M42 154v10" stroke="#ddd" stroke-width="3"/><circle cx="80" cy="165" r="5" fill="#ffd15c"/><circle cx="96" cy="165" r="5" fill="#2ee8ff"/><rect x="42" y="200" width="46" height="28" rx="3" fill="#120825"/><rect x="62" y="206" width="6" height="16" fill="#ffd15c"/></svg>`,
    easel: `<svg viewBox="0 0 170 240"><path d="M85 4 26 236M85 4l59 232M85 8v208" stroke="#7a5230" stroke-width="7" stroke-linecap="round"/><rect x="24" y="24" width="122" height="104" fill="#fbf7ea" stroke="#c8b796" stroke-width="3"/><path d="M36 104Q58 42 80 86t50-44" fill="none" stroke="#ff2e93" stroke-width="7" stroke-linecap="round"/><circle cx="110" cy="56" r="13" fill="#ffd400"/><path d="M36 118h50" stroke="#2f80ff" stroke-width="6" stroke-linecap="round"/><rect x="14" y="128" width="142" height="10" fill="#8a5d36"/></svg>`,
    rug: `<svg viewBox="0 0 380 90"><ellipse cx="190" cy="45" rx="188" ry="43" fill="#3a1f5e"/><ellipse cx="190" cy="45" rx="166" ry="35" fill="none" stroke="#ff7fc4" stroke-width="3"/><ellipse cx="190" cy="45" rx="130" ry="25" fill="#4c2878"/></svg>`,
    table: `<svg viewBox="0 0 240 90"><path d="M12 8h216l10 22H2z" fill="#74492a"/><rect x="2" y="30" width="236" height="8" fill="#4e3019"/><path d="M22 38l-5 50h11l5-50zM218 38l5 50h-11l-5-50z" fill="#3b2412"/></svg>`,
    popcorn: `<svg viewBox="0 0 70 90"><g fill="#fff3c9"><circle cx="16" cy="24" r="10"/><circle cx="34" cy="14" r="11"/><circle cx="52" cy="24" r="10"/><circle cx="27" cy="28" r="9"/><circle cx="44" cy="28" r="9"/></g><path d="M10 30h50l-8 58H18z" fill="#fff"/><path d="M19 30l5 58h-6l-8-58zM36 30h-1v58h6l1-58zM60 30l-8 58h-6l5-58z" fill="#e5354f"/></svg>`,
    dice: `<svg viewBox="0 0 44 44"><rect x="4" y="4" width="36" height="36" rx="8" fill="#fbf7ea" transform="rotate(-8 22 22)"/><g fill="#d8132f"><circle cx="14" cy="15" r="3.4"/><circle cx="22" cy="22" r="3.4"/><circle cx="30" cy="29" r="3.4"/></g></svg>`,
    notebook: `<svg viewBox="0 0 70 50"><path d="M6 8h58l4 34H2z" fill="#2f80ff"/><path d="M10 6h50l4 34H6z" fill="#fbf7ea"/><path d="M15 16h36M14 24h38M14 32h26" stroke="#7a7a9a" stroke-width="2"/></svg>`,
    phone: `<svg viewBox="0 0 90 70"><path d="M10 62 20 28h50l10 34z" fill="#c9153d"/><path d="M6 12q39-20 78 0v12H66v-8q-21-8-42 0v8H6z" fill="#e5254f"/><circle cx="45" cy="44" r="14" fill="#f7efd9"/><circle cx="45" cy="44" r="5" fill="#c9153d"/><g fill="#7a1a30"><circle cx="45" cy="34" r="1.8"/><circle cx="53" cy="39" r="1.8"/><circle cx="53" cy="49" r="1.8"/><circle cx="45" cy="54" r="1.8"/><circle cx="37" cy="49" r="1.8"/><circle cx="37" cy="39" r="1.8"/></g></svg>`,
    radio: `<svg viewBox="0 0 110 80"><path d="M78 16 96 2" stroke="#b9b9c2" stroke-width="2"/><rect x="4" y="16" width="102" height="62" rx="8" fill="#6d4427"/><rect x="12" y="24" width="52" height="46" rx="4" fill="#2a1a0f"/><path d="M16 32h44M16 40h44M16 48h44M16 56h44M16 64h44" stroke="#8d6b45" stroke-width="2"/><rect x="70" y="26" width="30" height="14" rx="2" fill="#ffe29a"/><path d="M84 28v10" stroke="#d8132f" stroke-width="1.5"/><circle cx="78" cy="56" r="7" fill="#d9c9a8"/><circle cx="95" cy="56" r="7" fill="#d9c9a8"/></svg>`,
    box: `<svg viewBox="0 0 150 120"><rect x="24" y="4" width="20" height="60" fill="#d8132f"/><rect x="46" y="10" width="20" height="54" fill="#2f80ff"/><rect x="68" y="2" width="20" height="62" fill="#1fbf6a"/><rect x="90" y="9" width="20" height="55" fill="#ff7a00"/><path d="M6 44h138l-8 74H14z" fill="#b98a55"/><path d="M6 44h138l4-10H2z" fill="#d6a871"/><rect x="42" y="66" width="66" height="28" fill="#fbf7ea"/><path d="M50 76l6 6 11-11" fill="none" stroke="#1fbf6a" stroke-width="4"/><path d="M76 74h24M76 84h18" stroke="#555" stroke-width="2.5"/></svg>`,
    tv: `<svg viewBox="0 0 380 280"><path d="M120 38 86 4M136 38l34-34" stroke="#b9b9c2" stroke-width="3" stroke-linecap="round"/><rect x="8" y="38" width="284" height="170" rx="16" fill="#5c3b24"/><rect x="8" y="38" width="284" height="170" rx="16" fill="none" stroke="#2b1a0f" stroke-width="3"/><rect x="20" y="48" width="212" height="150" rx="16" fill="#0b0a0f"/><g stroke="#2b1a0f" stroke-width="3"><path d="M244 150h38M244 160h38M244 170h38M244 180h38"/></g><text x="263" y="196" text-anchor="middle" font-size="8" font-weight="800" fill="#f0d7b7" letter-spacing="1">愛-TV</text><rect x="40" y="210" width="224" height="28" rx="3" fill="#17151d" stroke="#000"/><rect class="room-vcr-slot" x="54" y="219" width="94" height="8" rx="1" fill="#000" stroke="#4a4752"/><text x="214" y="229" font-family="ui-monospace,Consolas,monospace" font-size="12" font-weight="700" fill="#4dff91">PLAY</text><rect x="4" y="238" width="372" height="12" fill="#74492a"/><rect x="4" y="250" width="372" height="4" fill="#4e3019"/><path d="M24 254l-6 26h11l5-26zM356 254l6 26h-11l-5-26z" fill="#3b2412"/></svg>`,
};

function homeView() {
    try { return localStorage.getItem(ROOM_VIEW_KEY) === "classic" ? "classic" : "room"; } catch (e) { return "room"; }
}

// Панель над главной: приветствие, вид, звуки вещей
function buildHomeViewBar(onChange) {
    const bar = document.createElement("div");
    bar.className = "home-view-bar";
    const hello = document.createElement("span");
    hello.className = "home-view-hello";
    hello.textContent = `Привет, ${getUsernameFromEmail(currentUser.email)} 👋`;
    bar.appendChild(hello);

    const sound = document.createElement("button");
    sound.type = "button";
    sound.className = "ui-btn home-view-sound";
    const paintSound = () => {
        sound.textContent = thingsMuted() ? "🔇" : "🔊";
        sound.title = thingsMuted() ? "Звуки вещей выключены" : "Звуки вещей включены";
        sound.setAttribute("aria-label", sound.title);
    };
    paintSound();
    sound.onclick = () => { setThingsMuted(!thingsMuted()); paintSound(); thingSound("switch"); };
    bar.appendChild(sound);

    const toggle = document.createElement("div");
    toggle.className = "vhs-toggle";
    toggle.setAttribute("role", "group");
    toggle.setAttribute("aria-label", "Вид главной");
    [["room", "🛋️ Комната"], ["classic", "▦ Обычная"]].forEach(([view, label]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn" + (view === homeView() ? " is-active" : "");
        btn.textContent = label;
        btn.onclick = () => {
            if (view === homeView()) return;
            try { localStorage.setItem(ROOM_VIEW_KEY, view); } catch (e) {}
            thingSound("switch");
            onChange();
        };
        toggle.appendChild(btn);
    });
    bar.appendChild(toggle);
    return bar;
}

// Стеллаж: одна полка — одна категория каталога
function roomShelfSvg(keys) {
    const rnd = (() => { let s = 91; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
    let rows = "";
    for (let row = 0; row < 4; row++) {
        const y = 12 + row * 81;
        const key = keys[row];
        const hue = key ? getCategoryBaseHue(key) : 30;
        let tapes = "";
        for (let x = 18; x < 236;) {
            const w = 15 + Math.floor(rnd() * 5), h = 58 + Math.floor(rnd() * 6);
            const l = 34 + Math.floor(rnd() * 22), dh = Math.floor(rnd() * 34) - 17;
            tapes += `<rect x="${x}" y="${y + 66 - h}" width="${w}" height="${h}" rx="1" fill="hsl(${hue + dh} 70% ${l}%)"/><rect x="${x + 3}" y="${y + 66 - h + 6}" width="${w - 6}" height="7" fill="#f4f1e6"/>`;
            x += w + 2;
        }
        const emoji = key ? getCategoryEmoji(key) : "";
        rows += `<g class="room-shelf-row"${key ? ` data-cat="${row}"` : ""}><rect x="10" y="${y - 6}" width="240" height="80" fill="transparent"/>${tapes}<rect x="96" y="${y + 66}" width="68" height="13" rx="2" fill="#20120a"/><text x="130" y="${y + 76}" text-anchor="middle" font-size="10">${emoji}</text></g>`;
    }
    return `<svg viewBox="0 0 260 340"><rect width="260" height="340" rx="4" fill="#3b2412"/><rect x="10" y="8" width="240" height="324" fill="#170d07"/><g fill="#6b4426"><rect x="6" y="78" width="248" height="9"/><rect x="6" y="159" width="248" height="9"/><rect x="6" y="240" width="248" height="9"/><rect x="6" y="321" width="248" height="11"/></g>${rows}</svg>`;
}

function roomCalendarSvg() {
    const now = new Date();
    const day = now.getDate();
    const month = now.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "").toUpperCase();
    return `<svg viewBox="0 0 90 110"><rect y="6" width="90" height="104" rx="4" fill="#fbf7ea"/><rect y="6" width="90" height="28" rx="4" fill="#d8132f"/><circle cx="24" cy="6" r="4" fill="#6d6d76"/><circle cx="66" cy="6" r="4" fill="#6d6d76"/><text x="45" y="27" text-anchor="middle" font-size="16" font-weight="800" fill="#fff">${month}</text><text x="45" y="84" text-anchor="middle" font-size="46" font-weight="800" fill="#23202b">${day}</text></svg>`;
}

function roomTimeOfDay() {
    const h = new Date().getHours();
    return h >= 6 && h < 11 ? "morning" : h >= 11 && h < 17 ? "day" : h >= 17 && h < 21 ? "evening" : "night";
}

function buildRoomHome(onViewChange) {
    const wrap = document.createElement("div");
    wrap.className = "room-home";
    wrap.appendChild(buildHomeViewBar(onViewChange));

    const scene = document.createElement("section");
    scene.className = `room-scene is-${roomTimeOfDay()}`;
    scene.setAttribute("aria-label", "Комната");
    let lampOff = false;
    try { lampOff = localStorage.getItem(ROOM_LAMP_KEY) === "1"; } catch (e) {}
    scene.classList.toggle("is-lamp-off", lampOff);
    scene.innerHTML = `<div class="room-wall"></div><div class="room-floor"></div><div class="room-shade"></div>`;
    wrap.appendChild(scene);

    const { normal } = getOrderedCategoryKeys();
    const go = (id, sound) => () => { thingSound(sound || "soft"); shellNavigate(id); };

    const addObj = (o) => {
        const el = document.createElement(o.go ? "button" : "div");
        if (o.go) { el.type = "button"; el.onclick = o.go; }
        el.className = `${o.go ? "ui-btn " : ""}room-obj room-${o.id}`;
        const [wx, wy, ww] = o.wide, [tx, ty, tw] = o.tall;
        el.style.cssText = `--wx:${wx}%;--wy:${wy}%;--ww:${ww}%;--tx:${tx}%;--ty:${ty}%;--tw:${tw}%;aspect-ratio:${o.ar};`;
        if (o.label) el.setAttribute("aria-label", o.label);
        el.innerHTML = o.html + (o.label ? `<span class="room-tag">${o.tag || o.label}</span>` : "");
        scene.appendChild(el);
        return el;
    };

    addObj({ id: "window", ar: "200/170", wide: [3, 6, 19], tall: [3, 2, 28], html: `<span class="room-sky"><i class="room-sun"></i><i class="room-town"></i></span>` });
    addObj({ id: "board", ar: "240/150", wide: [25, 5, 19], tall: [33, 2.5, 30], label: "Доска", html: ROOM_ART.board, go: go("board", "paper") });
    addObj({ id: "calendar", ar: "90/110", wide: [46, 6, 7], tall: [78, 2.5, 18], label: "Календарь", html: roomCalendarSvg(), go: go("calendar", "paper") });
    addObj({ id: "frame", ar: "80/92", wide: [55, 8, 6], tall: [65, 3, 11], label: "Секрет", html: ROOM_ART.frame, go: go("secret", "soft") });
    addObj({ id: "rug", ar: "380/90", wide: [27, 75, 40], tall: [6, 67, 62], html: ROOM_ART.rug });

    const shelf = addObj({ id: "shelf", ar: "260/340", wide: [74.5, 13, 24], tall: [61, 22, 37], label: "Каталог", html: roomShelfSvg(normal), go: () => {
        thingSound("tape");
        shellNavigate("catalog");
    } });
    shelf.addEventListener("click", (e) => {
        const row = e.target.closest && e.target.closest("[data-cat]");
        if (!row) return;
        e.stopImmediatePropagation();
        thingSound("tape");
        openCategory(normal[+row.dataset.cat]);
    }, true);

    // Радио стоит на стеллаже и включает музыку сайта
    const hasMusic = !!document.getElementById("bgMusic");
    const radio = addObj({ id: "radio", ar: "110/80", wide: [80, 2.5, 9], tall: [63, 15.3, 17], label: "Музыка", html: ROOM_ART.radio, go: hasMusic ? () => {
        toggleBgMusic();
        thingSound("knob");
        radio.classList.toggle("is-on", isMusicPlaying);
    } : null });
    radio.classList.toggle("is-on", hasMusic && isMusicPlaying);

    addObj({ id: "lamp", ar: "70/260", wide: [1, 37, 5], tall: [54, 45, 9], label: "Свет", html: ROOM_ART.lamp, go: () => {
        lampOff = !lampOff;
        scene.classList.toggle("is-lamp-off", lampOff);
        try { localStorage.setItem(ROOM_LAMP_KEY, lampOff ? "1" : "0"); } catch (e) {}
        thingSound("switch");
    } });

    const sofa = addObj({ id: "sofa", ar: "300/150", wide: [6, 47, 25], tall: [3, 46, 50], html: `${ROOM_ART.sofa}
        <span class="room-ava is-left">${userAvatarHtml("Myakish")}</span>
        <span class="room-ava is-right">${userAvatarHtml("Asmoday")}</span>` });
    sofa.setAttribute("aria-hidden", "true");

    addObj({ id: "arcade", ar: "130/280", wide: [62, 27, 11.5], tall: [74, 52, 22], label: "Игры", html: ROOM_ART.arcade, go: go("games", "tape") });

    // Телевизор: экран ведёт в совместный просмотр, ручки и кассета — свои действия
    const tvEl = addObj({ id: "tv", ar: "380/280", wide: [31, 30, 30], tall: [1, 18, 58], html: ROOM_ART.tv });
    tvEl.innerHTML += `
        <button type="button" class="ui-btn room-tv-screen" aria-label="Совместный просмотр"></button>
        <button type="button" class="ui-btn room-knob is-ch" aria-label="Следующий канал" title="Следующий канал"></button>
        <button type="button" class="ui-btn room-knob is-vol" aria-label="Звук телевизора" title="Звук телевизора"></button>
        <span class="room-sound-mark"></span>
        <button type="button" class="ui-btn room-cassette" aria-label="Вставить кассету" title="Вставить кассету">${retroCassetteHtml("ВИДЕО")}</button>
        <span class="room-tag">Совместный просмотр</span>
    `;
    const screenBtn = tvEl.querySelector(".room-tv-screen");
    const tv = mountRetroTv(screenBtn);
    const knobCh = tvEl.querySelector(".is-ch"), knobVol = tvEl.querySelector(".is-vol"), mark = tvEl.querySelector(".room-sound-mark");
    const paintKnobs = () => {
        knobCh.style.transform = `rotate(${tv.channelIndex() * 60 - 60}deg)`;
        knobVol.style.transform = `rotate(${tv.soundOn() ? 80 : -80}deg)`;
        mark.textContent = tv.soundOn() ? "🔊" : "🔇";
    };
    tv.onChange(paintKnobs);
    paintKnobs();
    screenBtn.onclick = () => { thingSound("switch"); shellNavigate("w2g"); };
    knobCh.onclick = () => { thingSound("knob"); tv.next(); };
    knobVol.onclick = () => { thingSound("knob"); tv.setSound(!tv.soundOn()); };
    const cassette = tvEl.querySelector(".room-cassette");
    cassette.onclick = () => openCassetteDialog((value) => {
        try { sessionStorage.setItem(RETRO_PENDING_KEY, value); } catch (e) {}
        tv.setSound(false);
        cassetteFlyInto(cassette, tvEl.querySelector(".room-vcr-slot"), () => shellNavigate("w2g"));
    });

    addObj({ id: "table", ar: "240/90", wide: [8, 78, 25], tall: [3, 84, 49], html: ROOM_ART.table });
    addObj({ id: "popcorn", ar: "70/90", wide: [10, 69, 5], tall: [3, 77, 10], label: "Будем смотреть", tag: "Планы", html: ROOM_ART.popcorn, go: go("wishlist", "soft") });
    addObj({ id: "dice", ar: "1/1", wide: [17, 76, 2.8], tall: [17, 80.5, 7], label: "Рандомайзер", tag: "Рандом", html: ROOM_ART.dice, go: go("random", "tape") });
    addObj({ id: "notebook", ar: "70/50", wide: [20.5, 76, 5.5], tall: [29, 80, 12], label: "Комментарии", tag: "Отзывы", html: ROOM_ART.notebook, go: go("comments", "paper") });
    addObj({ id: "phone", ar: "90/70", wide: [26.5, 73, 5.5], tall: [41, 78.5, 10], label: "Чат", html: ROOM_ART.phone, go: go("chat", "knob") });
    addObj({ id: "box", ar: "150/120", wide: [63, 78, 11], tall: [54, 84, 18], label: "Просмотрено", html: ROOM_ART.box, go: go("watched", "tape") });
    addObj({ id: "easel", ar: "170/240", wide: [82, 67, 13], tall: [75, 81, 20], label: "Арт-студия", html: ROOM_ART.easel, go: go("studio", "soft") });

    // Питомец — настоящий, его текущая стадия
    const pet = addObj({ id: "pet", ar: "1/1", wide: [42, 70, 11], tall: [24, 62, 22], label: "Питомец", html: `<span class="room-pet-art"></span>`, go: go("pet", "soft") });
    if (typeof loadPetState === "function") {
        loadPetState().then(() => {
            if (!pet.isConnected || !petState) return;
            const stage = petStageIndex(petLevelInfo(petState.xp).level);
            pet.querySelector(".room-pet-art").innerHTML = petMonsterSvg(stage, petUid());
            pet.classList.toggle("is-frozen", petIsFrozen());
        }).catch(() => {});
    }
    return wrap;
}
