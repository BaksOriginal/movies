// ==========================================
// shell.js — ОБОЛОЧКА ПРИЛОЖЕНИЯ (общая для всех страниц сайта)
// ==========================================
// Подключается после core.js. Строит постоянную рамку вокруг #app:
//   • десктоп (>= 1024px, desktop.css) — боковое меню слева + верхняя панель
//     с поиском и действиями, контент на всю ширину;
//   • телефон (< 1024px, mobile.css) — верхняя панель приложения с кнопкой
//     "назад" и заголовком + нижняя панель вкладок + шторка "Ещё".
// Разметка одна и та же, разница — только в CSS (подключаются по media).
//
// Экраны сайта сами по-прежнему рисуют содержимое в #app, а оболочке лишь
// сообщают, какой раздел активен (setShellSection) и куда ведёт "назад"
// (setShellBack). Куда ведут пункты меню, решает страница через onNavigate:
// главная (script.js) переключает экраны сама, а "Игры"/"Совместный
// просмотр" для разделов главной уходят по ссылке ../#раздел.

const SHELL_ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/>',
    catalog: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    wishlist: '<path d="M6 3.5h12v17l-6-4.5-6 4.5z"/>',
    watched: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8 5.2-5.8"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    chat: '<path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 21l1.4-4.6A8.5 8.5 0 1 1 20.5 12z"/>',
    comments: '<path d="M4 5h16v11H9.5L4 20z"/><path d="M8 9h8M8 12.5h5"/>',
    w2g: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="m8.5 2.5 3.5 3 3.5-3"/><path d="M10.5 9.5v5l4-2.5z"/>',
    games: '<path d="M6.5 8h11a4.5 4.5 0 0 1 4.5 4.5v1.2a3.3 3.3 0 0 1-5.9 2L15 14H9l-1.1 1.7a3.3 3.3 0 0 1-5.9-2v-1.2A4.5 4.5 0 0 1 6.5 8z"/><path d="M7.5 10.5v3.5M5.75 12.25h3.5"/><path d="M15.5 11.5h.01M18 13h.01"/>',
    random: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8.5 8.5h.01M15.5 15.5h.01M12 12h.01M15.5 8.5h.01M8.5 15.5h.01"/>',
    secret: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.1 4.1 0 0 1 12 7.3a4.1 4.1 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    online: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z"/>',
    more: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    back: '<path d="m15 5-7 7 7 7"/>',
    musicOn: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    musicOff: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
    logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="m10 8-4 4 4 4M6 12h10"/>',
    lists: '<path d="M6 3.5h12v17l-6-4.5-6 4.5z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    studio: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5C21 6.3 17 3 12 3z"/><path d="M7.5 11.5h.01M10 7.5h.01M14.5 7.5h.01M17 11h.01"/>',
    board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 8.5h4v4h-4zM14 8.5h2.5M14 12h2.5M7.5 16h9"/>',
    pet: '<path d="M5 20v-8.5a7 7 0 0 1 14 0V20l-2.4-1.6L14.3 20 12 18.4 9.7 20l-2.3-1.6z"/><path d="M8.6 4.6 7.5 2.5M15.4 4.6l1.1-2.1M9.6 11.5h.01M14.4 11.5h.01"/>',
};

function shellIcon(name) {
    return `<svg class="shell-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${SHELL_ICONS[name] || ""}</svg>`;
}

// Пункты меню. Раздел "lists" на телефоне — одна вкладка на три экрана
// (Будем смотреть/Просмотрено/Календарь), "chat" — на чат и комментарии.
const SHELL_NAV_GROUPS = [
    { title: null, items: [
        { id: "home", label: "Главная", icon: "home" },
        { id: "catalog", label: "Каталог", icon: "catalog" },
    ] },
    { title: "Наши списки", items: [
        { id: "wishlist", label: "Будем смотреть", icon: "wishlist" },
        { id: "watched", label: "Просмотрено", icon: "watched" },
        { id: "calendar", label: "Календарь", icon: "calendar" },
    ] },
    { title: "Общение", items: [
        { id: "chat", label: "Чат", icon: "chat" },
        { id: "comments", label: "Комментарии", icon: "comments" },
    ] },
    { title: "Досуг", items: [
        { id: "pet", label: "Питомец", icon: "pet" },
        { id: "w2g", label: "Совместный просмотр", icon: "w2g" },
        { id: "games", label: "Игры", icon: "games" },
        { id: "studio", label: "Арт-студия", icon: "studio" },
        { id: "board", label: "Доска", icon: "board" },
        { id: "random", label: "Рандомайзер", icon: "random" },
    ] },
    { title: null, secret: true, items: [
        { id: "secret", label: "Секрет", icon: "secret" },
    ] },
];

const SHELL_TABS = [
    { id: "home", label: "Главная", icon: "home", sections: ["home"] },
    { id: "catalog", label: "Каталог", icon: "catalog", sections: ["catalog"] },
    { id: "wishlist", label: "Списки", icon: "lists", sections: ["wishlist", "watched", "calendar"] },
    { id: "chat", label: "Чат", icon: "chat", sections: ["chat", "comments"] },
    { id: "more", label: "Ещё", icon: "more", sections: ["pet", "w2g", "games", "studio", "board", "random", "secret", "add", "online"] },
];

const SHELL_LABELS = {
    home: "愛してる", catalog: "Каталог", wishlist: "Будем смотреть", watched: "Просмотрено",
    calendar: "Календарь", chat: "Чат", comments: "Комментарии", w2g: "Совместный просмотр",
    games: "Игры", random: "Рандомайзер", secret: "Секрет", add: "Добавить тайтлы", online: "Онлайн-поиск",
    search: "Поиск", list: "", pet: "Питомец", studio: "Арт-студия", board: "Доска",
};

const DESKTOP_MEDIA = window.matchMedia("(min-width: 1024px)");

const shell = {
    root: null,
    opts: null,
    section: null,
    subKey: null,
    els: {},
};

function isDesktopLayout() {
    return DESKTOP_MEDIA.matches;
}

// opts: {
//   page: "main" | "games" | "w2g" | "studio" | "board",
//   onNavigate(id) -> true, если страница обработала пункт сама,
//   beforeLeave()   -> уборка перед уходом со страницы по ссылке,
//   categories: [{ key, label, emoji, count }] — обычные категории каталога
//               (не передаются — берётся последний сохранённый главной список),
//   counts: { wishlist, watched },
//   searchEl: элемент поиска для верхней панели десктопа
// }
const SHELL_CATEGORIES_KEY = "shellCategories";

function loadSavedShellCategories() {
    try {
        const saved = JSON.parse(localStorage.getItem(SHELL_CATEGORIES_KEY) || "[]");
        return Array.isArray(saved) ? saved : [];
    } catch (e) {
        return [];
    }
}

function saveShellCategories(categories) {
    try {
        localStorage.setItem(SHELL_CATEGORIES_KEY, JSON.stringify(categories));
    } catch (e) { /* не критично: на других страницах просто не будет подпунктов */ }
}

function initShell(opts) {
    shell.opts = Object.assign({ page: "main", counts: {} }, opts);
    if (shell.opts.categories) saveShellCategories(shell.opts.categories);
    else shell.opts.categories = loadSavedShellCategories();
    document.body.classList.add("shell-on");

    if (!shell.root) buildShellDom();
    renderShellSidebar();
    renderShellTabbar();
    renderShellActions();
    renderShellUser();
    if (shell.opts.searchEl) setShellSearch(shell.opts.searchEl);
    initShellBackTrap();
}

function destroyShell() {
    document.body.classList.remove("shell-on");
    closeShellMoreSheet();
}

function buildShellDom() {
    const container = document.querySelector(".container");

    const root = document.createElement("div");
    root.className = "shell";
    root.innerHTML = `
        <aside class="shell-sidebar">
            <a class="shell-brand" href="${shellBaseHref()}">
                <img src="${shellBaseHref()}icon.png" alt="" width="34" height="34">
                <span>愛してる</span>
            </a>
            <nav class="shell-nav" aria-label="Разделы"></nav>
            <div class="shell-user"></div>
        </aside>
        <div class="shell-main">
            <header class="shell-topbar">
                <button type="button" class="shell-back" hidden>${shellIcon("back")}<span class="shell-back-label">Назад</span></button>
                <div class="shell-title"></div>
                <div class="shell-search"></div>
                <div class="shell-actions"></div>
            </header>
        </div>
        <nav class="shell-tabbar" aria-label="Вкладки"></nav>
    `;

    document.body.insertBefore(root, document.body.firstChild);
    if (container) root.querySelector(".shell-main").appendChild(container);

    shell.root = root;
    shell.els = {
        nav: root.querySelector(".shell-nav"),
        user: root.querySelector(".shell-user"),
        topbar: root.querySelector(".shell-topbar"),
        back: root.querySelector(".shell-back"),
        backLabel: root.querySelector(".shell-back-label"),
        title: root.querySelector(".shell-title"),
        search: root.querySelector(".shell-search"),
        actions: root.querySelector(".shell-actions"),
        tabbar: root.querySelector(".shell-tabbar"),
    };

    // Мобильная верхняя панель: крупный заголовок экрана живёт в контенте
    // (h1), а маленький в панели проявляется, только когда h1 уехал вверх.
    let ticking = false;
    window.addEventListener("scroll", () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
            document.body.classList.toggle("shell-scrolled", window.scrollY > 48);
            ticking = false;
        });
    }, { passive: true });

    DESKTOP_MEDIA.addEventListener("change", () => {
        closeShellMoreSheet();
        document.body.classList.toggle("layout-desktop", isDesktopLayout());
    });
    document.body.classList.toggle("layout-desktop", isDesktopLayout());
}

function shellBaseHref() {
    return shell.opts && shell.opts.page !== "main" ? "../" : "./";
}

// Пункт меню ведёт на экран, который и так открыт?
function isCurrentShellScreen(id) {
    if (id.startsWith("category:")) return shell.section === "catalog" && shell.subKey === id.slice("category:".length);
    return id === shell.section;
}

function shellNavigate(id) {
    closeShellMoreSheet();
    // Повторный тап по текущему разделу — как в приложениях: ничего не
    // перезагружаем, просто прокручиваем наверх. Если же внутри раздела
    // ушли вглубь (есть "назад"), тап возвращает к его началу.
    if (isCurrentShellScreen(id) && (!shell.els.back || shell.els.back.hidden)) {
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
    }
    const opts = shell.opts || {};
    if (opts.onNavigate && opts.onNavigate(id) === true) return;

    // Страница пункт не обработала — значит, он живёт на другой странице
    if (opts.beforeLeave) opts.beforeLeave();
    if (typeof saveMusicPositionBeforeLeaving === "function") saveMusicPositionBeforeLeaving();
    const base = shellBaseHref();
    if (id === "games") location.href = base + "games/";
    else if (id === "w2g") location.href = base + "w2g/";
    else if (id === "studio") location.href = base + "studio/";
    else if (id === "board") location.href = base + "board/";
    else if (id.startsWith("category:")) location.href = base + "#" + encodeURIComponent(id);
    else location.href = base + "#" + id;
}

function renderShellSidebar() {
    const nav = shell.els.nav;
    const { categories, counts } = shell.opts;
    nav.innerHTML = "";

    SHELL_NAV_GROUPS.forEach(group => {
        const groupEl = document.createElement("div");
        groupEl.className = "shell-nav-group" + (group.secret ? " shell-nav-group-secret" : "");
        if (group.title) {
            const t = document.createElement("div");
            t.className = "shell-nav-title";
            t.textContent = group.title;
            groupEl.appendChild(t);
        }
        group.items.forEach(item => {
            const el = buildShellNavItem(item.id, item.label, shellIcon(item.icon), counts[item.id]);
            if (group.secret) el.classList.add("shell-nav-secret");
            groupEl.appendChild(el);
            // Категории каталога — вложенным списком сразу под "Каталогом"
            if (item.id === "catalog") {
                categories.forEach(c => {
                    const sub = buildShellNavItem("category:" + c.key, c.label, `<span class="shell-nav-emoji">${c.emoji}</span>`, c.count);
                    sub.classList.add("shell-nav-sub");
                    groupEl.appendChild(sub);
                });
            }
        });
        nav.appendChild(groupEl);
    });

    highlightShellNav();
}

function buildShellNavItem(id, label, iconHtml, count) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shell-nav-item";
    btn.dataset.nav = id;
    btn.innerHTML = `${iconHtml}<span class="shell-nav-label"></span>${count != null ? `<span class="shell-nav-count">${count}</span>` : ""}`;
    btn.querySelector(".shell-nav-label").textContent = label;
    btn.onclick = () => shellNavigate(id);
    return btn;
}

function renderShellTabbar() {
    const bar = shell.els.tabbar;
    bar.innerHTML = "";
    SHELL_TABS.forEach(tab => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "shell-tab";
        btn.dataset.tab = tab.id;
        btn.innerHTML = `${shellIcon(tab.icon)}<span>${tab.label}</span>`;
        btn.onclick = () => {
            vibrate(8);
            if (tab.id === "more") toggleShellMoreSheet();
            else shellNavigate(tab.id);
        };
        bar.appendChild(btn);
    });
    highlightShellNav();
}

function renderShellActions() {
    const box = shell.els.actions;
    box.innerHTML = "";
    [["add", "Добавить"], ["online", "Онлайн-поиск"]].forEach(([id, label]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "shell-action" + (id === "add" ? " shell-action-primary" : "");
        btn.title = label;
        btn.innerHTML = `${shellIcon(id)}<span>${label}</span>`;
        btn.onclick = () => shellNavigate(id);
        box.appendChild(btn);
    });
}

function renderShellUser() {
    const box = shell.els.user;
    const name = currentUser ? getUsernameFromEmail(currentUser.email) : "";
    box.innerHTML = `
        <div class="shell-avatar">${userAvatarHtml(name)}</div>
        <div class="shell-user-name">${escapeShellText(name)}</div>
        <div class="shell-user-buttons"></div>
    `;
    const buttons = box.querySelector(".shell-user-buttons");
    if (document.getElementById("bgMusic")) {
        const music = document.createElement("button");
        music.type = "button";
        music.className = "shell-icon-btn";
        const paint = () => {
            music.innerHTML = shellIcon(isMusicPlaying ? "musicOn" : "musicOff");
            music.title = isMusicPlaying ? "Выключить музыку" : "Включить музыку";
        };
        music.onclick = () => toggleBgMusic();
        buttons.appendChild(music);
        watchMusicControl(music, paint);
    }
    const logout = document.createElement("button");
    logout.type = "button";
    logout.className = "shell-icon-btn";
    logout.title = "Выйти";
    logout.innerHTML = shellIcon("logout");
    logout.onclick = () => shellLogout();
    buttons.appendChild(logout);
}

function shellLogout() {
    if (!confirm("Выйти из аккаунта?")) return;
    if (shell.opts.page === "main") performLogout();
    else performLogout().then(() => { location.href = "../"; });
}

// Все переключатели музыки (меню, шторка «Ещё», радио в комнате) показывают
// одно состояние: кто бы ни переключил, перерисовываются все, кто на экране.
const musicControls = new Set();
function watchMusicControl(el, paint) {
    musicControls.add({ el, paint });
    paint();
}
function paintMusicControls() {
    musicControls.forEach((control) => {
        if (control.el.isConnected) control.paint();
        else musicControls.delete(control);
    });
}

function toggleBgMusic() {
    const audio = document.getElementById("bgMusic");
    if (!audio) return;
    if (audio.paused) {
        audio.play().catch(() => {});
        isMusicPlaying = true;
    } else {
        audio.pause();
        isMusicPlaying = false;
    }
    localStorage.setItem("musicEnabled", String(isMusicPlaying));
    paintMusicControls();
}

function escapeShellText(str) {
    return String(str).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// ---------- Состояние текущего экрана ----------

// section — id пункта меню (home/catalog/wishlist/...), subKey — ключ
// категории каталога (подсвечивает её в боковом меню десктопа).
function setShellSection(section, subKey = null) {
    // Переход в другой раздел — наверх страницы; перерисовка того же
    // экрана (живое обновление, смена страницы списка) прокрутку не трогает
    const sameScreen = section === shell.section && subKey === shell.subKey;
    if (!sameScreen) window.scrollTo(0, 0);
    document.body.classList.toggle("shell-same-screen", sameScreen);
    shell.section = section;
    shell.subKey = subKey;
    document.body.dataset.section = section;
    setShellBack(null);
    setShellTitle(SHELL_LABELS[section] || "");
    highlightShellNav();
}

function highlightShellNav() {
    if (!shell.root) return;
    const activeNav = shell.subKey ? "category:" + shell.subKey : shell.section;
    shell.root.querySelectorAll(".shell-nav-item").forEach(el => {
        const id = el.dataset.nav;
        el.classList.toggle("active", id === activeNav);
        el.classList.toggle("active-parent", id === "catalog" && !!shell.subKey && shell.section === "catalog");
    });
    shell.root.querySelectorAll(".shell-tab").forEach(el => {
        const tab = SHELL_TABS.find(t => t.id === el.dataset.tab);
        el.classList.toggle("active", !!tab && tab.sections.includes(shell.section));
    });
}

// handler = null прячет кнопку "назад"
function setShellBack(handler, label = "Назад") {
    if (!shell.els.back) return;
    shell.els.back.hidden = !handler;
    shell.els.back.onclick = handler ? () => { vibrate(8); handler(); } : null;
    shell.els.backLabel.textContent = label;
    document.body.classList.toggle("shell-has-back", !!handler);
}

function setShellTitle(text) {
    if (shell.els.title) shell.els.title.textContent = text || "";
}

function setShellSearch(el) {
    if (!shell.els.search) return;
    shell.els.search.innerHTML = "";
    if (el) shell.els.search.appendChild(el);
}

function updateShellCounts(counts) {
    if (!shell.opts) return;
    Object.assign(shell.opts.counts, counts);
    if (!shell.root) return;
    Object.keys(counts).forEach(id => {
        const el = shell.root.querySelector(`.shell-nav-item[data-nav="${id}"] .shell-nav-count`);
        if (el) el.textContent = counts[id];
    });
}

function setShellCategories(categories) {
    if (!shell.opts) return;
    shell.opts.categories = categories;
    saveShellCategories(categories);
    renderShellSidebar();
}

// ---------- Шторка "Ещё" (телефон) ----------

function toggleShellMoreSheet() {
    if (document.getElementById("shellMoreSheet")) closeShellMoreSheet();
    else openShellMoreSheet();
}

function closeShellMoreSheet() {
    const sheet = document.getElementById("shellMoreSheet");
    if (!sheet) return;
    sheet.classList.add("closing");
    setTimeout(() => sheet.remove(), 180);
}

function openShellMoreSheet() {
    const name = currentUser ? getUsernameFromEmail(currentUser.email) : "";

    const overlay = document.createElement("div");
    overlay.className = "shell-sheet-overlay";
    overlay.id = "shellMoreSheet";
    overlay.onclick = (e) => { if (e.target === overlay) closeShellMoreSheet(); };

    const sheet = document.createElement("div");
    sheet.className = "shell-sheet";
    sheet.innerHTML = `
        <div class="shell-sheet-handle"></div>
        <div class="shell-sheet-user">
            <div class="shell-avatar">${userAvatarHtml(name)}</div>
            <div class="shell-user-name">${escapeShellText(name)}</div>
        </div>
        <div class="shell-sheet-grid"></div>
        <div class="shell-sheet-row"></div>
    `;
    overlay.appendChild(sheet);

    const grid = sheet.querySelector(".shell-sheet-grid");
    const tile = (id, label, icon, extraClass = "") => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "shell-sheet-tile " + extraClass;
        btn.innerHTML = `${icon}<span></span>`;
        btn.querySelector("span").textContent = label;
        btn.onclick = () => shellNavigate(id);
        grid.appendChild(btn);
    };
    tile("pet", "Питомец", shellIcon("pet"));
    tile("w2g", "Совместный просмотр", shellIcon("w2g"));
    tile("games", "Игры", shellIcon("games"));
    tile("studio", "Арт-студия", shellIcon("studio"));
    tile("board", "Доска", shellIcon("board"));
    tile("random", "Рандомайзер", shellIcon("random"));
    tile("comments", "Комментарии", shellIcon("comments"));
    tile("add", "Добавить тайтлы", shellIcon("add"));
    tile("online", "Онлайн-поиск", shellIcon("online"));
    tile("secret", "Секрет", shellIcon("secret"), "shell-sheet-tile-secret");

    const row = sheet.querySelector(".shell-sheet-row");
    if (document.getElementById("bgMusic")) {
        const music = document.createElement("button");
        music.type = "button";
        music.className = "shell-sheet-pill";
        const paint = () => {
            music.innerHTML = `${shellIcon(isMusicPlaying ? "musicOn" : "musicOff")}<span>${isMusicPlaying ? "Музыка включена" : "Музыка выключена"}</span>`;
        };
        music.onclick = () => toggleBgMusic();
        row.appendChild(music);
        watchMusicControl(music, paint);
    }
    if (typeof thingSound === "function") {
        const things = document.createElement("button");
        things.type = "button";
        things.className = "shell-sheet-pill";
        const paintThings = () => { things.innerHTML = `<span>${thingsMuted() ? "🔇 Звуки вещей" : "🔊 Звуки вещей"}</span>`; };
        paintThings();
        things.onclick = () => { setThingsMuted(!thingsMuted()); paintThings(); thingSound("switch"); };
        row.appendChild(things);
    }
    const logout = document.createElement("button");
    logout.type = "button";
    logout.className = "shell-sheet-pill shell-sheet-pill-danger";
    logout.innerHTML = `${shellIcon("logout")}<span>Выйти</span>`;
    logout.onclick = () => { closeShellMoreSheet(); shellLogout(); };
    row.appendChild(logout);

    document.body.appendChild(overlay);
}

// ---------- Шторки: закрытие свайпом вниз (телефон) ----------
// Все всплывающие окна сайта — это .modal-overlay > .modal-content, их
// создают десятки разных функций. Вместо правки каждой следим за <body> и
// "доучиваем" любое появившееся окно. Закрываем так же, как это сделал бы
// тап по затемнению, — кликом по самому overlay: тогда срабатывает родная
// логика закрытия конкретного окна (а окна, которые по тапу мимо не
// закрываются, и свайпом не закроются — шторка просто вернётся на место).
function initSheetGestures() {
    const DRAG_ZONE_PX = 64;   // тянуть можно за верх шторки (ручку/заголовок)
    const CLOSE_AT_PX = 110;

    function enhance(overlay) {
        const sheet = overlay.querySelector(".modal-content");
        if (!sheet || sheet.querySelector(".modal-sheet-handle")) return;
        const handle = document.createElement("div");
        handle.className = "modal-sheet-handle";
        sheet.prepend(handle);

        let startY = null;
        let dy = 0;

        sheet.addEventListener("touchstart", (e) => {
            if (isDesktopLayout() || e.touches.length !== 1) return;
            const top = sheet.getBoundingClientRect().top;
            if (e.touches[0].clientY - top > DRAG_ZONE_PX || sheet.scrollTop > 0) return;
            startY = e.touches[0].clientY;
            dy = 0;
            sheet.classList.add("sheet-dragging");
        }, { passive: true });

        sheet.addEventListener("touchmove", (e) => {
            if (startY === null) return;
            dy = Math.max(0, e.touches[0].clientY - startY);
            sheet.style.transform = `translateY(${dy}px)`;
            if (dy > 0) e.preventDefault();
        }, { passive: false });

        const release = () => {
            if (startY === null) return;
            startY = null;
            sheet.classList.remove("sheet-dragging");
            sheet.classList.add("sheet-releasing");
            if (dy > CLOSE_AT_PX) {
                sheet.style.transform = "translateY(100%)";
                setTimeout(() => {
                    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                    // Окно не закрывается тапом мимо — возвращаем шторку
                    if (overlay.isConnected) sheet.style.transform = "";
                }, 180);
            } else {
                sheet.style.transform = "";
            }
            setTimeout(() => sheet.classList.remove("sheet-releasing"), 240);
        };
        sheet.addEventListener("touchend", release);
        sheet.addEventListener("touchcancel", release);
    }

    new MutationObserver((mutations) => {
        mutations.forEach(m => m.addedNodes.forEach(node => {
            if (node.nodeType === 1 && node.classList.contains("modal-overlay")) enhance(node);
        }));
    }).observe(document.body, { childList: true });
}

// ---------- Клавиатура на телефоне ----------
// Пока открыта экранная клавиатура, нижние вкладки только съедают место
// (а в iOS ещё и прыгают над клавиатурой) — прячем их на время ввода.
function initTypingMode() {
    const isTextField = (el) => el && (el.tagName === "TEXTAREA" ||
        (el.tagName === "INPUT" && !["checkbox", "radio", "range", "button", "submit", "file", "color"].includes(el.type)));
    document.addEventListener("focusin", (e) => {
        if (isTextField(e.target)) document.body.classList.add("shell-typing");
    });
    document.addEventListener("focusout", (e) => {
        if (isTextField(e.target)) document.body.classList.remove("shell-typing");
    });
}

if (document.body) {
    initSheetGestures();
    initTypingMode();
} else {
    document.addEventListener("DOMContentLoaded", () => { initSheetGestures(); initTypingMode(); }, { once: true });
}

// ---------- Системная кнопка/жест "Назад" ----------
// Экраны сайта переключаются без перезагрузки страницы, поэтому у браузера
// в истории для них нет записей, и "Назад" на телефоне просто уводил с
// сайта. Держим одну запись-"ловушку" поверх текущей: когда браузер на
// неё возвращается (popstate), делаем шаг назад уже внутри сайта —
// закрываем окно/шторку, жмём "назад" в шапке или идём на главную — и
// ставим ловушку заново. Если идти некуда, отпускаем браузер дальше.
// Важно: в script.js есть глобальная переменная history (стек экранов),
// она перекрывает window.history — поэтому здесь везде window.history.
let shellBackTrapReady = false;

function initShellBackTrap() {
    if (shellBackTrapReady) return;
    shellBackTrapReady = true;
    window.history.pushState({ shellTrap: true }, "");
    window.addEventListener("popstate", onShellPopState);
}

function onShellPopState() {
    if (handleShellBack()) {
        window.history.pushState({ shellTrap: true }, "");
    } else {
        // Внутри сайта отступать некуда — это настоящий "назад" браузера
        window.removeEventListener("popstate", onShellPopState);
        shellBackTrapReady = false;
        window.history.back();
    }
}

// Шаг назад внутри сайта. true — обработали здесь.
function handleShellBack() {
    if (document.getElementById("shellMoreSheet")) {
        closeShellMoreSheet();
        return true;
    }

    const overlays = document.querySelectorAll(".modal-overlay");
    if (overlays.length) {
        // Сначала как тап по затемнению — окно закроется своей же логикой.
        // Окна, которые тапом мимо не закрываются (например, оценка), "Назад"
        // всё равно закрывает. Не трогаем только те, где нужен выбор:
        // "Игра окончена" и крутящееся колесо рандомайзера.
        const top = overlays[overlays.length - 1];
        top.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        const mustChoose = ["gameOverModal", "rhythmGameOverModal"].includes(top.id) || top.classList.contains("rz-spinning");
        if (top.isConnected && !mustChoose) top.remove();
        return true;
    }

    if (shell.els.back && !shell.els.back.hidden && shell.els.back.onclick) {
        shell.els.back.onclick();
        return true;
    }

    if (shell.opts && shell.opts.page === "main" && shell.section !== "home") {
        shellNavigate("home");
        return true;
    }
    return false;
}
