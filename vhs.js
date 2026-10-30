// ==========================================
// vhs.js — КАТАЛОГ КАК ПОЛКА С ВИДЕОКАССЕТАМИ
// ==========================================
// Подключается на главной после script.js. Второй вид каталога: тайтлы стоят
// корешками на полках, полки разбиты по жанрам. Цвет корешка задаёт жанр,
// рисунок — категория (фильмы, мультфильмы, сериалы, аниме). Вид запоминается
// в браузере; карточка тайтла в этом виде тоже оформлена как кассета
// (см. showActionMenu в script.js).
//
// Вся графика — статичный CSS, постеры на полке не загружаются.

const VHS_VIEW_KEY = "catalogView";
const VHS_MAX_TITLE = 44;       // дальше название на корешке обрезается
const VHS_LONG_TITLE = 18;      // длиннее — мелким шрифтом в две строки
// Оттенки подобраны так, чтобы соседние жанры заметно различались
const VHS_HUES = [340, 18, 44, 92, 150, 186, 212, 248, 276, 308, 4, 128];

function catalogView() {
    try {
        return localStorage.getItem(VHS_VIEW_KEY) === "cards" ? "cards" : "vhs";
    } catch (e) { return "vhs"; }
}

function setCatalogView(view) {
    try { localStorage.setItem(VHS_VIEW_KEY, view); } catch (e) {}
}

// Переключатель «Кассеты / Карточки»
function buildCatalogViewToggle(onChange) {
    const box = document.createElement("div");
    box.className = "vhs-toggle";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Вид каталога");
    const current = catalogView();
    [["vhs", "📼 Кассеты"], ["cards", "▦ Карточки"]].forEach(([view, label]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn" + (view === current ? " is-active" : "");
        btn.textContent = label;
        btn.setAttribute("aria-pressed", view === current);
        btn.onclick = () => {
            if (view === catalogView()) return;
            setCatalogView(view);
            onChange();
        };
        box.appendChild(btn);
    });
    return box;
}

function vhsIsSecretTitle(itemText) {
    return itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал");
}

function vhsGenreOf(itemText) {
    const row = titleRows[itemText];
    return (row && row.genre) || "Без жанра";
}

// Один жанр — один цвет, одинаковый на всех экранах и у обоих пользователей
function vhsHueOf(genre) {
    return VHS_HUES[Math.abs(hashStringToSeed(genre)) % VHS_HUES.length];
}

// Рисунок корешка по категории
function vhsStyleOf(itemText) {
    const row = titleRows[itemText];
    const cat = (row && row.category) || "";
    if (cat.includes("Мультфильм")) return "toon";
    if (cat.includes("Сериал")) return "tv";
    if (cat.includes("Аниме")) return "anime";
    return "film";
}

// Наклейки на корешке: просмотрено, в планах, своя оценка, новинка
function vhsApplyMarks(spine, itemText) {
    const score = getMyRatingScore(itemText);
    const watched = watchedTitles.has(itemText);
    const wish = !watched && wishlistTitles.has(itemText);
    let html = "";
    if (watched) html += `<i class="vhs-mark is-watched" title="Просмотрено">✓</i>`;
    if (wish) html += `<i class="vhs-mark is-wish" title="Будем смотреть">★</i>`;
    if (score != null) html += `<i class="vhs-mark is-score" title="Моя оценка">${score}</i>`;
    if (isRecentlyAdded(itemText)) html += `<i class="vhs-mark is-new" title="Добавлено недавно">NEW</i>`;
    const marks = spine.querySelector(".vhs-marks");
    if (marks.innerHTML !== html) marks.innerHTML = html;
}

function vhsBuildSpine(itemText) {
    const m = itemText.match(/^(.*)\s\((\d{4})\)$/);
    const name = m ? m[1] : itemText;
    const shown = name.length > VHS_MAX_TITLE ? name.slice(0, VHS_MAX_TITLE - 1) + "…" : name;
    const spine = document.createElement("button");
    spine.type = "button";
    spine.className = `ui-btn vhs-spine is-${vhsStyleOf(itemText)}`;
    spine.style.setProperty("--h", vhsHueOf(vhsGenreOf(itemText)));
    spine.dataset.vhsTitle = itemText;
    spine.title = itemText;
    spine.setAttribute("aria-label", itemText);
    spine.innerHTML = `
        <span class="vhs-brand">VHS</span>
        <span class="vhs-marks"></span>
        <span class="vhs-name${shown.length > VHS_LONG_TITLE ? " is-long" : ""}"></span>
        <span class="vhs-year"></span>
    `;
    spine.querySelector(".vhs-name").textContent = shown;
    spine.querySelector(".vhs-year").textContent = m ? m[2] : "";
    vhsApplyMarks(spine, itemText);
    spine.onclick = () => { thingSound("tape"); showActionMenu(itemText); };
    return spine;
}

// Франшиза — коробка-комплект шириной в две кассеты
function vhsBuildBox(franchiseName, titles) {
    const first = getAllTitlesFromCategory(titles)[0] || "";
    const box = document.createElement("button");
    box.type = "button";
    box.className = "ui-btn vhs-spine vhs-box";
    box.style.setProperty("--h", vhsHueOf(vhsGenreOf(first)));
    box.title = franchiseName;
    box.setAttribute("aria-label", `Франшиза ${franchiseName}`);
    box.innerHTML = `
        <span class="vhs-brand">BOX</span>
        <span class="vhs-name is-long"></span>
        <span class="vhs-year">×${getAllTitlesFromCategory(titles).length}</span>
    `;
    const shown = franchiseName.length > VHS_MAX_TITLE ? franchiseName.slice(0, VHS_MAX_TITLE - 1) + "…" : franchiseName;
    box.querySelector(".vhs-name").textContent = shown;
    box.onclick = () => { thingSound("tape"); openData(titles, true, "🎞️ " + franchiseName); };
    return box;
}

// items — как в списках каталога: строки-тайтлы и объекты-франшизы
function renderVhsShelves(items, container) {
    const groups = new Map();
    items.forEach((item) => {
        if (typeof item === "string") {
            const g = vhsGenreOf(item);
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(vhsBuildSpine(item));
        } else if (item && typeof item === "object") {
            for (const name in item) {
                const first = getAllTitlesFromCategory(item[name])[0] || "";
                const g = vhsGenreOf(first);
                if (!groups.has(g)) groups.set(g, []);
                groups.get(g).push(vhsBuildBox(name, item[name]));
            }
        }
    });
    const names = Array.from(groups.keys()).sort((a, b) =>
        stripLeadingEmoji(a).localeCompare(stripLeadingEmoji(b), "ru"));
    const wrap = document.createElement("div");
    wrap.className = "vhs-shelves";
    names.forEach((genre) => {
        const section = document.createElement("section");
        section.className = "vhs-section";
        section.style.setProperty("--h", vhsHueOf(genre));
        const label = document.createElement("div");
        label.className = "vhs-plate";
        label.innerHTML = `<b></b><span>${groups.get(genre).length}</span>`;
        label.firstChild.textContent = genre;
        const shelf = document.createElement("div");
        shelf.className = "vhs-shelf";
        groups.get(genre).forEach(el => shelf.appendChild(el));
        section.appendChild(label);
        section.appendChild(shelf);
        wrap.appendChild(section);
    });
    container.appendChild(wrap);
}

// «Просмотрено»: кассеты лежат стопками в коробке. Название читается целиком,
// на кассете только отметка о просмотре и своя оценка.
function renderVhsCrate(list, container, label) {
    const crate = document.createElement("div");
    crate.className = "vhs-crate";
    crate.dataset.label = label;
    const stacks = document.createElement("div");
    stacks.className = "vhs-stacks";
    list.forEach((itemText) => {
        const m = itemText.match(/^(.*)\s\((\d{4})\)$/);
        const score = getMyRatingScore(itemText);
        const tape = document.createElement("button");
        tape.type = "button";
        tape.className = "ui-btn vhs-lying";
        tape.style.setProperty("--h", vhsHueOf(vhsGenreOf(itemText)));
        tape.title = itemText;
        tape.innerHTML = `
            <i class="vhs-mark is-watched" title="Просмотрено">✓</i>
            <span class="vhs-lying-name"></span>
            <span class="vhs-lying-year"></span>
            ${score != null ? `<i class="vhs-mark is-score" title="Моя оценка">${score}</i>` : ""}
        `;
        tape.querySelector(".vhs-lying-name").textContent = m ? m[1] : itemText;
        tape.querySelector(".vhs-lying-year").textContent = m ? m[2] : "";
        tape.onclick = () => { thingSound("tape"); showActionMenu(itemText); };
        stacks.appendChild(tape);
    });
    crate.appendChild(stacks);
    container.appendChild(crate);
}

// Оценки и списки изменились — обновляем наклейки на месте
function refreshVhsMarks() {
    document.querySelectorAll(".vhs-spine[data-vhs-title]").forEach((spine) => {
        vhsApplyMarks(spine, spine.dataset.vhsTitle);
    });
}

// Бумажная наклейка в шапке окон оценки и действий
function vhsPanelSticker(kicker, title) {
    const safe = (t) => String(t).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    return `<div class="vhs-panel-sticker"><i></i><small>${safe(kicker)}</small><b>${safe(title)}</b></div>`;
}

// Части карточки тайтла в стиле кассеты
function vhsCardTapeHtml() {
    return `
        <div class="vhs-tape" aria-hidden="true">
            <div class="vhs-sticker">
                <span class="vhs-sticker-band"></span>
                <span class="vhs-sticker-title"></span>
                <span class="vhs-sticker-meta"></span>
            </div>
            <div class="vhs-window">
                <i class="vhs-reel"></i>
                <i class="vhs-tape-strip"></i>
                <i class="vhs-reel is-small"></i>
            </div>
        </div>
    `;
}

function vhsFillCard(sheet, itemText, name, year) {
    const genre = vhsGenreOf(itemText);
    sheet.classList.add("is-vhs");
    sheet.style.setProperty("--h", vhsHueOf(genre));
    sheet.querySelector(".vhs-sticker-title").textContent = name;
    sheet.querySelector(".vhs-sticker-meta").textContent = [stripLeadingEmoji(genre) || genre, year, "PAL · HI-FI"].filter(Boolean).join(" · ");
}
