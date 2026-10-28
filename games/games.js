// ==========================================
// games.js — РАЗДЕЛ «ИГРЫ» (/movies/games/)
// ==========================================
// Подключается на games/index.html ПОСЛЕ core.js.
// Всё, что нужно из core.js: db, currentUser, app, vibrate, setEmojiTitle, hashStringToSeed.

// =======================================================
// ИГРЫ (Змейка / Flappy Bird / Doodle Jump) — общая таблица лидеров на двоих
// =======================================================
// Для работы нужна таблица в Supabase (создать один раз вручную, SQL editor):
//
// create table game_scores (
//   user_id uuid references auth.users(id),
//   username text,
//   game text check (game in ('snake','flappy','doodle','runner','ninja')),
//   best_score integer default 0,
//   updated_at timestamptz default now(),
//   primary key (user_id, game)
// );
//
// Если таблица у вас уже создана под старую версию (без 'runner'/'ninja'),
// добавить новые игры "Брокколи-раннер" и "Эмодзи Ниндзя" в таблицу лидеров
// можно так (выполнить один раз в SQL editor):
//
// alter table game_scores drop constraint game_scores_game_check;
// alter table game_scores add constraint game_scores_game_check check (game in ('snake','flappy','doodle','runner','ninja'));
//
// (RLS можно не включать, как и для остальных таблиц в этом проекте —
// либо настроить так же, как у таблицы ratings/comments.)

let gameScoresCache = { snake: [], flappy: [], doodle: [], runner: [], ninja: [] };
let activeGameCleanup = null; // остановка текущей запущенной игры (интервалы/rAF/слушатели), если она есть

// ==========================================
// 8-БИТНЫЕ ЗВУКИ ДЛЯ ИГР
// ==========================================
// Звуки генерируются на лету через Web Audio API (простые "чиповые" бипы),
// без каких-либо аудиофайлов — это НЕ музыка, а короткие игровые эффекты
// (прыжок/еда/очко/столкновение и т.п.), которые работают одинаково во всех играх.
let gameAudioCtx = null;
function getGameAudioCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!gameAudioCtx) gameAudioCtx = new AC();
    if (gameAudioCtx.state === "suspended") gameAudioCtx.resume();
    return gameAudioCtx;
}

// Один короткий "чиповый" бип. type — форма волны (square/triangle/sawtooth — придают тот самый 8-битный характер).
function beep(freq, durationMs, type = "square", volume = 0.15, delayMs = 0) {
    try {
        const ctx = getGameAudioCtx();
        if (!ctx) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        const startAt = ctx.currentTime + delayMs / 1000;
        const endAt = startAt + durationMs / 1000;
        gain.gain.setValueAtTime(volume, startAt);
        gain.gain.exponentialRampToValueAtTime(0.001, endAt);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startAt);
        osc.stop(endAt);
    } catch (e) { /* звук не критичен для игры — молча игнорируем сбои аудио */ }
}

// Готовые звуковые эффекты для всех игр на сайте — вызываются по имени из игровой логики
function playSound(name) {
    switch (name) {
        case "jump":     beep(520, 90, "square", 0.15); break;
        case "point":    beep(880, 80, "square", 0.15); break;
        case "eat":      beep(660, 70, "square", 0.15); beep(990, 70, "square", 0.12, 60); break;
        case "shoot":    beep(1100, 50, "square", 0.1); break;
        case "gameover": beep(400, 120, "square", 0.16); beep(300, 120, "square", 0.16, 130); beep(200, 220, "square", 0.16, 260); break;
        case "slice":    beep(1300, 35, "triangle", 0.11); beep(750, 55, "triangle", 0.09, 25); break;
        case "bomb":     beep(90, 260, "sawtooth", 0.25); beep(55, 320, "square", 0.2, 40); break;
    }
}

// ------------------------- СПРАЙТ ПТИЧКИ ДЛЯ FLAPPY BIRD -------------------------
// Голова с фото профиля (вырезана, фон убран) — используется как спрайт птички.
// Лежит файлом img/flappy-head.png (раньше — base64-строкой в коде).
const flappyBirdImg = new Image();
flappyBirdImg.src = "../img/flappy-head.png";

// ------------------------- СПРАЙТ БЕГУНА ДЛЯ БРОККОЛИ-РАННЕРА -------------------------
// Фото персонажа в беге (вырезано, фон убран) — используется как спрайт бегущего героя.
// Лежит файлом img/runner.png (раньше — base64-строкой в коде).
const runnerCharImg = new Image();
runnerCharImg.src = "../img/runner.png";

// Загружает лучшие результаты обоих игроков по обеим играм
async function loadGameScores() {
    const { data, error } = await db.from('game_scores').select('*');
    if (error) {
        console.error("Ошибка при загрузке рекордов игр:", error);
        return;
    }
    gameScoresCache = { snake: [], flappy: [], doodle: [], runner: [], ninja: [] };
    (data || []).forEach(row => {
        if (!gameScoresCache[row.game]) gameScoresCache[row.game] = [];
        gameScoresCache[row.game].push({ userId: row.user_id, username: row.username, score: row.best_score });
    });
}

// Возвращает личный текущий рекорд игрока в конкретной игре
function getMyBest(game) {
    if (!currentUser) return 0;
    const mine = (gameScoresCache[game] || []).find(r => r.userId === currentUser.id);
    return mine ? mine.score : 0;
}

// Сохраняет новый рекорд, только если он реально побит. Возвращает true, если это новый рекорд.
async function saveGameScore(game, score) {
    if (!currentUser) return false;
    const list = gameScoresCache[game] || (gameScoresCache[game] = []);
    const mine = list.find(r => r.userId === currentUser.id);
    const prevBest = mine ? mine.score : 0;
    if (score <= prevBest) return false;

    const username = getUsernameFromEmail(currentUser.email);
    const { error } = await db.from('game_scores').upsert(
        { user_id: currentUser.id, username, game, best_score: score, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,game' }
    );
    if (error) {
        console.error("Ошибка при сохранении рекорда игры:", error);
        return false;
    }
    if (mine) mine.score = score;
    else list.push({ userId: currentUser.id, username, score });
    return true;
}

// Строит HTML таблицы лидеров (у нас всего 2 игрока — лидер сверху с короной)
function buildLeaderboardHtml(game) {
    const rows = (gameScoresCache[game] || []).slice().sort((a, b) => b.score - a.score);
    if (rows.length === 0) {
        return `<p class="game-leaderboard-empty">Рекордов пока нет — сыграйте первыми!</p>`;
    }
    return `<div class="leaderboard">` + rows.map((r, i) => `
        <div class="leaderboard-row${i === 0 ? ' leaderboard-leader' : ''}">
            <span class="leaderboard-name">${i === 0 ? '🏆 ' : ''}${r.username}</span>
            <span class="leaderboard-score">${r.score}</span>
        </div>
    `).join('') + `</div>`;
}

// Ставим фоновую музыку сайта на паузу, пока пользователь находится в разделе "Игры",
// и запоминаем, играла ли она до этого — чтобы аккуратно возобновить при выходе.
let musicWasPlayingBeforeGames = false;
function pauseMusicForGames() {
    const audio = document.getElementById("bgMusic");
    musicWasPlayingBeforeGames = !!(audio && !audio.paused);
    if (audio && !audio.paused) audio.pause();
}
function resumeMusicAfterGames() {
    const audio = document.getElementById("bgMusic");
    if (audio && musicWasPlayingBeforeGames && isMusicPlaying) {
        audio.play().catch(() => {});
    }
    musicWasPlayingBeforeGames = false;
}

// Навигация раздела игр: внутри конкретной игры — "назад" в оболочке
// (к списку игр или обратно в Паутинку), а нижние вкладки на телефоне
// прячутся, чтобы не отъедать место у игрового поля.
function setGamesNav(showBackToMenu) {
    // Ставим музыку на паузу и блокируем выделение текста только один раз, при входе в раздел
    // "Игры" (а не при каждом переключении между играми внутри раздела).
    if (!document.body.classList.contains("games-screen-active")) {
        pauseMusicForGames();
    }
    document.body.classList.add("games-screen-active");
    document.body.classList.toggle("shell-immersive", !!showBackToMenu);

    if (!showBackToMenu) {
        setShellBack(null);
    } else {
        setShellBack(() => showGamesScreen(), "Игры");
    }
}

// Показывает окно "Игра окончена" с результатом и кнопками "Заново"/"К играм"
// Общая разметка окна "Игра окончена" (обычные игры и Ритм-Аркада)
function buildGameOverHtml(score, isRecord, restartId, menuId, menuLabel) {
    return `
        <div class="modal-content gameover${isRecord ? " gameover-record" : ""}">
            <div class="gameover-kicker">${isRecord ? "🏆 Новый рекорд!" : "Игра окончена"}</div>
            <div class="gameover-score">${score}</div>
            <div class="gameover-label">очков</div>
            <div class="gameover-actions">
                <button type="button" id="${restartId}" class="ui-btn ui-pill ui-pill-accent">🔁 Ещё раз</button>
                <button type="button" id="${menuId}" class="ui-btn ui-pill">${menuLabel}</button>
            </div>
        </div>
    `;
}

function showGameOverModal(score, isRecord, onRestart) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "gameOverModal";
    overlay.innerHTML = buildGameOverHtml(score, isRecord, "gameOverRestart", "gameOverMenu", "🕹️ К играм");
    document.body.appendChild(overlay);
    overlay.querySelector("#gameOverRestart").onclick = () => { overlay.remove(); onRestart(); };
    overlay.querySelector("#gameOverMenu").onclick = () => { overlay.remove(); showGamesScreen(); };
}

// Единая "заливка" с кнопкой "▶️ Играть" ровно по центру canvas — показывается перед
// стартом любой игры вместо разных текстов вида "Тапни, чтобы начать". Заливка всегда
// точно совпадает по размеру с конкретным canvas игры, какой бы он ни был.
function showPlayOverlay(canvas, onPlay) {
    // Оборачиваем canvas в отдельный контейнер (если он ещё не обёрнут), чтобы заливка
    // растягивалась ровно на размер canvas, а не на всю колонку .game-wrap целиком
    let holder = canvas.parentElement;
    if (!holder || !holder.classList.contains("game-canvas-wrap")) {
        holder = document.createElement("div");
        // .game-canvas-wrap рассчитан на настоящий <canvas> с "внутренним" пиксельным
        // размером (inline-block аккуратно сжимается по нему). В ритм-игре сюда
        // приходит div с шириной через CSS (width:100%) — для него добавляем
        // модификатор -fluid, иначе inline-block+width:100% дают циклическую
        // неопределённость ширины, и арена схлопывается в тонкую полоску.
        holder.className = "game-canvas-wrap" + (canvas.tagName !== "CANVAS" ? " game-canvas-wrap-fluid" : "");
        canvas.parentNode.insertBefore(holder, canvas);
        holder.appendChild(canvas);
    }

    const overlay = document.createElement("div");
    overlay.className = "game-start-overlay";
    overlay.innerHTML = `<button type="button" class="game-play-btn">▶️ Играть</button>`;
    holder.appendChild(overlay);

    overlay.querySelector(".game-play-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        overlay.remove();
        onPlay();
    });
}

// Определяем "настоящий десктоп" — устройство с мышью (точный поинтер +
// поддержка hover). У тачскринов (телефоны/планшеты) matchMedia тут даст
// false, даже если ширина экрана большая — это то, что нам и нужно, чтобы
// не путать большие планшеты с ПК. Используется и для увеличения canvas,
// и (см. style.css, .dpad) для скрытия сенсорных кнопок управления.
function isDesktopPointer() {
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

// Общая настройка canvas под десктоп: логика игр везде считает координаты
// в "логических" единицах (переменные W/H/SIZE), поэтому саму игровую
// математику не трогаем — вместо этого один раз растягиваем и сам canvas,
// и систему координат внутри него через ctx.scale(). Так весь существующий
// код отрисовки (который рисует в координатах 0..logicalW/0..logicalH)
// автоматически рисует более крупную и чёткую картинку на ПК, а хитбоксы,
// скорость и вся игровая логика остаются как были.
// desktopScale — во сколько раз увеличить видимый размер именно на ПК
// (на телефоне/планшете размер не меняется вообще).
function setupResponsiveCanvas(canvas, logicalW, logicalH, desktopScale) {
    let scale = 1;
    if (isDesktopPointer()) {
        // Подстраховка на случай узкого окна браузера на ПК (например,
        // свёрнутое вбок окно вполовину экрана) — не даём canvas вылезти
        // за пределы того, что реально доступно по ширине.
        const availableW = (document.documentElement.clientWidth || window.innerWidth) * 0.92;
        scale = Math.max(1, Math.min(desktopScale, availableW / logicalW));
    }
    const dpr = window.devicePixelRatio || 1;
    const displayW = Math.round(logicalW * scale);
    const displayH = Math.round(logicalH * scale);
    canvas.style.width = displayW + "px";
    canvas.style.height = displayH + "px";
    canvas.width = Math.round(displayW * dpr);
    canvas.height = Math.round(displayH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(canvas.width / logicalW, canvas.height / logicalH);
    return ctx;
}

// Список игр для шестиугольного меню: порядок здесь = порядок отрисовки
// значков и порядок точек на пунктирной линии между ними. Название,
// короткое описание "что за игра" и таблица лидеров теперь показываются
// не сразу на экране, а в модалке по тапу на значок (см. showGameInfoModal).
const GAMES_META = [
    { id: "snake", hue: 140,  emoji: "🐍", title: "Змейка",                  desc: "Классика: собирай еду, расти — и не влетай в стену или в свой же хвост.",  leaderboard: true,  start: () => startSnakeGame() },
    { id: "flappy", hue: 28, emoji: "🍫", title: "Эчпочмоня vs. Шоколадки", desc: "Лети между шоколадками, не задевая их — чем дальше, тем плотнее строй.",     leaderboard: true,  start: () => startFlappyGame() },
    { id: "doodle", hue: 268, emoji: "👾", title: "Doodle Jump",             desc: "Прыгай с платформы на платформу и забирайся как можно выше.",               leaderboard: true,  start: () => startDoodleGame() },
    { id: "runner", hue: 95, emoji: "🥦", title: "Бега Брокколи",           desc: "Беги без остановки и перепрыгивай препятствия на пути.",                    leaderboard: true,  start: () => startRunnerGame() },
    { id: "ninja", hue: 350,  emoji: "💣",  title: "Эмодзи Ниндзя",           desc: "Разрезай летящие эмодзи и не задевай бомбы.",                               leaderboard: true,  start: () => startNinjaGame() },
    { id: "rhythm", hue: 305, emoji: "🎵", title: "Ритм-Аркада",             desc: "Лови ноты в такт музыке — выбор треков и свои рекорды внутри.",             leaderboard: false, start: () => showRhythmMenu() }
];

// Экран выбора игры — "карта": шестиугольные точки-уровни, соединённые
// кривой пунктирной тропинкой. Рядом с каждой точкой — название и рекорд.
// Тап по точке открывает окно игры с таблицей лидеров и кнопкой "Играть"
// (см. showGameInfoModal). Раскладку считает layoutGamesMap(): на телефоне
// тропинка петляет сверху вниз, на ПК — слева направо.
async function showGamesScreen() {
    if (!currentUser) { location.href = "../"; return; }

    if (activeGameCleanup) {
        activeGameCleanup();
        activeGameCleanup = null;
    }

    app.innerHTML = "";

    let title = document.createElement("h1");
    setEmojiTitle(title, "🕹️ Игры");
    app.appendChild(title);

    let container = document.createElement("div");
    container.id = "gamesContainer";
    container.innerHTML = `<p style="text-align:center;color:#9686b8;font-size:13px;">Загрузка рекордов...</p>`;
    app.appendChild(container);

    setGamesNav(false);

    await loadGameScores();
    if (!container.isConnected) return;

    container.innerHTML = "";
    const map = document.createElement("div");
    map.className = "games-map";
    map.innerHTML = `
        <svg class="games-map-path" aria-hidden="true">
            <path class="games-map-trail-glow"></path>
            <path class="games-map-trail"></path>
        </svg>
        <span class="games-map-flag games-map-flag-start">Старт</span>
        <span class="games-map-flag games-map-flag-end">🏁</span>
    `;
    GAMES_META.forEach((game, i) => {
        const node = document.createElement("button");
        node.type = "button";
        node.className = "ui-btn map-node";
        node.style.setProperty("--h", game.hue);
        node.style.setProperty("--i", i);
        node.setAttribute("aria-label", game.title);
        node.innerHTML = `
            <span class="map-hex">
                <span class="map-hex-inner"><span class="map-hex-emoji">${game.emoji}</span></span>
                <span class="map-hex-num">${i + 1}</span>
            </span>
            <span class="map-label">
                <span class="map-label-title"></span>
                <span class="map-label-score">${buildGameTileScore(game)}</span>
            </span>
        `;
        node.querySelector(".map-label-title").textContent = game.title;
        node.onclick = () => showGameInfoModal(game.id);
        map.appendChild(node);
    });
    container.appendChild(map);
    initGamesMap(map);

    // Диплинк на конкретную игру с автозапуском: games/?play=snake
    const params = new URLSearchParams(location.search);
    const play = params.get("play");
    if (play) {
        history.replaceState(null, "", location.pathname);
        const g = GAMES_META.find(x => x.id === play);
        if (g) g.start();
    }
}

// Расставляет точки карты и прокладывает между ними тропинку. Телефон —
// зигзаг сверху вниз (подписи сбоку), ПК — зигзаг слева направо (подписи
// под точками). Тропинка — плавные кривые Безье через центры шестиугольников.
function layoutGamesMap(map) {
    const nodes = [...map.querySelectorAll(".map-node")];
    if (nodes.length === 0) return;
    const horizontal = map.clientWidth >= 760;
    map.classList.toggle("games-map-horizontal", horizontal);

    const width = map.clientWidth;
    const points = nodes.map((node, i) => {
        let x, y;
        if (horizontal) {
            const step = width / nodes.length;
            x = step * (i + 0.5);
            y = i % 2 === 0 ? 120 : 250;
        } else {
            x = i % 2 === 0 ? width * 0.24 : width * 0.76;
            y = 90 + i * 150;
        }
        node.style.left = x + "px";
        node.style.top = y + "px";
        node.classList.toggle("map-node-flip", !horizontal && i % 2 === 1);
        return { x, y };
    });

    const height = horizontal ? 400 : points[points.length - 1].y + 110;
    map.style.height = height + "px";

    // Хвосты тропинки: от флажка "Старт" и до финиша
    const first = points[0], last = points[points.length - 1];
    const start = horizontal ? { x: 34, y: first.y - 80 } : { x: first.x + 40, y: 22 };
    const end = horizontal ? { x: width - 26, y: last.y + 80 } : { x: last.x - 40, y: height - 24 };
    const all = [start, ...points, end];

    let d = `M ${all[0].x} ${all[0].y}`;
    for (let i = 1; i < all.length; i++) {
        const p0 = all[i - 1], p1 = all[i];
        if (horizontal) {
            const dx = (p1.x - p0.x) * 0.55;
            d += ` C ${p0.x + dx} ${p0.y}, ${p1.x - dx} ${p1.y}, ${p1.x} ${p1.y}`;
        } else {
            const dy = (p1.y - p0.y) * 0.6;
            d += ` C ${p0.x} ${p0.y + dy}, ${p1.x} ${p1.y - dy}, ${p1.x} ${p1.y}`;
        }
    }
    const svg = map.querySelector(".games-map-path");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.querySelectorAll("path").forEach(p => p.setAttribute("d", d));

    const flagStart = map.querySelector(".games-map-flag-start");
    const flagEnd = map.querySelector(".games-map-flag-end");
    flagStart.style.left = start.x + "px";
    flagStart.style.top = start.y + "px";
    flagEnd.style.left = end.x + "px";
    flagEnd.style.top = end.y + "px";
}

// Пересчитывает карту сразу и при ресайзе/повороте экрана, пока она есть на
// странице — слушатель сам себя снимает, когда карта исчезла.
let gamesMapResizeObserver = null;
function initGamesMap(map) {
    layoutGamesMap(map);
    if (gamesMapResizeObserver) gamesMapResizeObserver.disconnect();
    gamesMapResizeObserver = new ResizeObserver(() => {
        if (map.isConnected) layoutGamesMap(map);
        else gamesMapResizeObserver.disconnect();
    });
    gamesMapResizeObserver.observe(map);
}

// Строка рекордов на точке карты: свой рекорд и лидер
function buildGameTileScore(game) {
    if (!game.leaderboard) return "Треки и рекорды внутри";
    const rows = (gameScoresCache[game.id] || []).slice().sort((a, b) => b.score - a.score);
    if (rows.length === 0) return "Рекордов пока нет";
    const mine = getMyBest(game.id);
    const leader = rows[0];
    const leaderText = `👑 ${escapeGameText(leader.username)} · ${leader.score}`;
    return mine > 0 && leader.userId !== currentUser.id ? `Мой рекорд ${mine} · ${leaderText}` : leaderText;
}

function escapeGameText(str) {
    return String(str || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// Модалка "что за игра": название, короткое описание, таблица лидеров (если
// у игры есть общий рекорд — у Ритм-Аркады свои рекорды по трекам внутри
// её собственного меню) и кнопка "Играть".
function showGameInfoModal(gameId) {
    const g = GAMES_META.find(x => x.id === gameId);
    if (!g) return;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "gameInfoModal";
    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <button type="button" class="modal-close-btn" aria-label="Закрыть">✕</button>
            <h3>${g.emoji} ${g.title}</h3>
            <p class="game-info-desc">${g.desc}</p>
            ${g.leaderboard ? buildLeaderboardHtml(g.id) : ""}
            <button type="button" id="gameInfoPlayBtn" class="btn-games-green">▶️ Играть</button>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector(".modal-close-btn").onclick = () => overlay.remove();
    overlay.querySelector("#gameInfoPlayBtn").onclick = () => { overlay.remove(); g.start(); };
}

// ------------------------- ЗМЕЙКА -------------------------
function startSnakeGame() {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);

    app.innerHTML = "";
    let title = document.createElement("h1");
    setEmojiTitle(title, "🐍 Змейка");
    title.style.marginBottom = "5px";
    app.appendChild(title);

    const GRID = 15;
    const CELL = 18;
    const SIZE = GRID * CELL;
    const TICK_MS = 270; // было 140 — чуть замедлили змейку, чтобы было комфортнее играть

    let wrap = document.createElement("div");
    wrap.className = "game-wrap";
    wrap.innerHTML = `
        <div class="game-score-row">Счёт: <span id="snakeScore">0</span> &nbsp;•&nbsp; Рекорд: <span id="snakeBest">${getMyBest('snake')}</span></div>
        <canvas id="snakeCanvas" width="${SIZE}" height="${SIZE}" class="game-canvas"></canvas>
        <div class="dpad">
            <button class="dpad-btn dpad-up">▲</button>
            <div class="dpad-mid">
                <button class="dpad-btn dpad-left">◀</button>
                <button class="dpad-btn dpad-down">▼</button>
                <button class="dpad-btn dpad-right">▶</button>
            </div>
        </div>
    `;
    app.appendChild(wrap);

    const canvas = wrap.querySelector("#snakeCanvas");
    const ctx = setupResponsiveCanvas(canvas, SIZE, SIZE, 1.8);
    const scoreEl = wrap.querySelector("#snakeScore");
    const bestEl = wrap.querySelector("#snakeBest");

    let snake, dir, nextDir, food, score, tickInterval, gameOver;

    function randomFood() {
        let cell;
        do {
            cell = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
        } while (snake.some(s => s.x === cell.x && s.y === cell.y));
        return cell;
    }

    function resetState() {
        snake = [{ x: 7, y: 7 }, { x: 6, y: 7 }, { x: 5, y: 7 }];
        dir = { x: 1, y: 0 };
        nextDir = { x: 1, y: 0 };
        food = randomFood();
        score = 0;
        gameOver = false;
        scoreEl.textContent = "0";
    }

    function roundedRectPath(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function drawBoard() {
        // Мягкая шахматная "садовая" клетка вместо плоской заливки
        for (let gy = 0; gy < GRID; gy++) {
            for (let gx = 0; gx < GRID; gx++) {
                ctx.fillStyle = (gx + gy) % 2 === 0 ? "#eef7ee" : "#e3f2e3";
                ctx.fillRect(gx * CELL, gy * CELL, CELL, CELL);
            }
        }
    }

    function drawFood() {
        const cx = food.x * CELL + CELL / 2;
        const cy = food.y * CELL + CELL / 2 + 1;
        const r = CELL / 2.6;

        // Яблочко: тело + блик + листик + хвостик
        ctx.fillStyle = "#e53935";
        ctx.beginPath();
        ctx.arc(cx - r * 0.15, cy, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.beginPath();
        ctx.arc(cx - r * 0.55, cy - r * 0.5, r * 0.28, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = "#6d4c2b";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + 1, cy - r - 3);
        ctx.stroke();

        ctx.fillStyle = "#4caf50";
        ctx.beginPath();
        ctx.ellipse(cx + 3, cy - r - 2, 3.2, 1.8, -0.6, 0, Math.PI * 2);
        ctx.fill();
    }

    function drawSnake() {
        const n = snake.length;
        snake.forEach((seg, i) => {
            const t = n > 1 ? i / (n - 1) : 0;
            // Плавный градиент от тёмно-зелёной головы к светлому кончику хвоста
            const rCol = Math.round(46 + t * (165 - 46));
            const gCol = Math.round(125 + t * (214 - 125));
            const bCol = Math.round(50 + t * (167 - 50));
            ctx.fillStyle = `rgb(${rCol},${gCol},${bCol})`;
            roundedRectPath(seg.x * CELL + 1, seg.y * CELL + 1, CELL - 2, CELL - 2, i === 0 ? 6 : 5);
            ctx.fill();
        });

        // Мордочка на голове: глаза + маленький раздвоенный язычок по направлению движения
        const head = snake[0];
        const hx = head.x * CELL + CELL / 2;
        const hy = head.y * CELL + CELL / 2;
        const ex = dir.y !== 0 ? CELL * 0.22 : 0;
        const ey = dir.x !== 0 ? CELL * 0.22 : 0;

        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(hx - ex + dir.x * 2, hy - ey + dir.y * 2, 2.4, 0, Math.PI * 2);
        ctx.arc(hx + ex + dir.x * 2, hy + ey + dir.y * 2, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1b3a1b";
        ctx.beginPath();
        ctx.arc(hx - ex + dir.x * 3, hy - ey + dir.y * 3, 1.1, 0, Math.PI * 2);
        ctx.arc(hx + ex + dir.x * 3, hy + ey + dir.y * 3, 1.1, 0, Math.PI * 2);
        ctx.fill();

        const tipX = hx + dir.x * (CELL / 2 + 5);
        const tipY = hy + dir.y * (CELL / 2 + 5);
        const baseX = hx + dir.x * (CELL / 2);
        const baseY = hy + dir.y * (CELL / 2);
        ctx.strokeStyle = "#c62828";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(baseX, baseY);
        ctx.lineTo(tipX, tipY);
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX + dir.y * 2.5, tipY + dir.x * 2.5);
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - dir.y * 2.5, tipY - dir.x * 2.5);
        ctx.stroke();
    }

    function draw() {
        drawBoard();
        drawFood();
        drawSnake();
    }

    function tick() {
        if (gameOver) return;
        dir = nextDir;
        const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

        if (head.x < 0 || head.x >= GRID || head.y < 0 || head.y >= GRID ||
            snake.some(s => s.x === head.x && s.y === head.y)) {
            endGame();
            return;
        }

        snake.unshift(head);

        if (head.x === food.x && head.y === food.y) {
            score++;
            scoreEl.textContent = String(score);
            food = randomFood();
            playSound("eat");
        } else {
            snake.pop();
        }

        draw();
    }

    async function endGame() {
        gameOver = true;
        playSound("gameover");
        clearInterval(tickInterval);
        const isRecord = await saveGameScore('snake', score);
        if (isRecord) bestEl.textContent = String(score);
        showGameOverModal(score, isRecord, () => {
            resetState();
            draw();
            tickInterval = setInterval(tick, TICK_MS);
        });
    }

    function setDirection(x, y) {
        if (dir.x === -x && dir.y === -y) return; // запрещаем разворот на 180°
        nextDir = { x, y };
    }

    function keyHandler(e) {
        const map = {
            ArrowUp: [0, -1], KeyW: [0, -1],
            ArrowDown: [0, 1], KeyS: [0, 1],
            ArrowLeft: [-1, 0], KeyA: [-1, 0],
            ArrowRight: [1, 0], KeyD: [1, 0]
        };
        const move = map[e.code];
        if (move) { e.preventDefault(); setDirection(move[0], move[1]); }
    }
    document.addEventListener("keydown", keyHandler);

    wrap.querySelector(".dpad-up").onclick = () => setDirection(0, -1);
    wrap.querySelector(".dpad-down").onclick = () => setDirection(0, 1);
    wrap.querySelector(".dpad-left").onclick = () => setDirection(-1, 0);
    wrap.querySelector(".dpad-right").onclick = () => setDirection(1, 0);

    // Свайпы прямо по канвасу — как альтернатива D-pad'у на мобильных
    let touchStartX = 0, touchStartY = 0;
    canvas.addEventListener("touchstart", (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: true });
    canvas.addEventListener("touchend", (e) => {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        if (Math.abs(dx) > Math.abs(dy)) {
            if (Math.abs(dx) > 20) setDirection(dx > 0 ? 1 : -1, 0);
        } else {
            if (Math.abs(dy) > 20) setDirection(0, dy > 0 ? 1 : -1);
        }
    }, { passive: true });

    resetState();
    draw();
    showPlayOverlay(canvas, () => {
        tickInterval = setInterval(tick, TICK_MS);
    });

    activeGameCleanup = () => {
        clearInterval(tickInterval);
        document.removeEventListener("keydown", keyHandler);
    };
}

// ------------------------- FLAPPY BIRD -------------------------
function startFlappyGame() {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);

    app.innerHTML = "";
    let title = document.createElement("h1");
    setEmojiTitle(title, "🍫 Эчпочмоня vs. Шоколадки");
    title.style.marginBottom = "5px";
    app.appendChild(title);

    const W = 300, H = 420;
    const GROUND_H = 32;
    const GRAVITY = 1500;   // px/с²
    const JUMP_V = -420;    // px/с
    const PIPE_W = 50;
    const GAP = 140;
    const PIPE_SPEED = 130;    // px/с
    const PIPE_INTERVAL = 1500; // мс
    const BIRD_W = 42, BIRD_H = 36; // размер спрайта-головы на канвасе
    const BIRD_R = 16;              // радиус для проверки столкновений

    let wrap = document.createElement("div");
    wrap.className = "game-wrap";
    wrap.innerHTML = `
        <div class="game-score-row">Счёт: <span id="flappyScore">0</span> &nbsp;•&nbsp; Рекорд: <span id="flappyBest">${getMyBest('flappy')}</span></div>
        <canvas id="flappyCanvas" width="${W}" height="${H}" class="game-canvas"></canvas>
    `;
    app.appendChild(wrap);

    const canvas = wrap.querySelector("#flappyCanvas");
    const ctx = setupResponsiveCanvas(canvas, W, H, 1.6);
    const scoreEl = wrap.querySelector("#flappyScore");
    const bestEl = wrap.querySelector("#flappyBest");

    let birdY, birdV, pipes, score, gameOver, lastTime, rafId, spawnTimer, started, bgOffset;

    function reset() {
        birdY = H / 2;
        birdV = 0;
        pipes = [];
        score = 0;
        gameOver = false;
        started = false;
        spawnTimer = 0;
        lastTime = null;
        bgOffset = 0;
        scoreEl.textContent = "0";
    }

    function spawnPipe() {
        const minTop = 40;
        const maxTop = H - GROUND_H - GAP - 40;
        const gapY = minTop + Math.random() * (maxTop - minTop);
        pipes.push({ x: W, gapY, passed: false });
    }

    // ---- Небо с солнцем и облаками ----
    function drawSky() {
        const skyGrad = ctx.createLinearGradient(0, 0, 0, H - GROUND_H);
        skyGrad.addColorStop(0, "#bfe9ff");
        skyGrad.addColorStop(1, "#eaf8ff");
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, W, H - GROUND_H);

        ctx.fillStyle = "rgba(255, 235, 150, 0.85)";
        ctx.beginPath();
        ctx.arc(W - 45, 42, 22, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "rgba(255,255,255,0.85)";
        for (let i = 0; i < 3; i++) {
            const raw = (i * 140 + 60 - bgOffset * 0.4) % (W + 120);
            const cx = (raw < 0 ? raw + W + 120 : raw) - 60;
            const cy = 55 + i * 45;
            drawCloud(cx, cy);
        }
    }

    function drawCloud(cx, cy) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, 18, 11, 0, 0, Math.PI * 2);
        ctx.ellipse(cx + 14, cy - 5, 14, 10, 0, 0, Math.PI * 2);
        ctx.ellipse(cx - 14, cy - 3, 13, 9, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    // ---- Шоколадные батончики вместо труб ----
    function drawChocolateBar(x, y, w, h, edge) {
        if (h <= 0) return;
        const grad = ctx.createLinearGradient(x, 0, x + w, 0);
        grad.addColorStop(0, "#4a2f21");
        grad.addColorStop(0.35, "#7b4b32");
        grad.addColorStop(0.55, "#8a5738");
        grad.addColorStop(1, "#5b3a29");
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);

        // канавки-дольки шоколадки
        ctx.strokeStyle = "rgba(0,0,0,0.28)";
        ctx.lineWidth = 2;
        for (let gy = 0; gy < h; gy += 22) {
            ctx.beginPath();
            ctx.moveTo(x + 3, y + gy);
            ctx.lineTo(x + w - 3, y + gy);
            ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w / 2, y + h);
        ctx.stroke();

        // лёгкий блик слева
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(x + 2, y, 5, h);

        // неровный "отломанный" край со стороны просвета
        const teeth = 6, amp = 5;
        ctx.fillStyle = "rgba(0,0,0,0.18)";
        ctx.beginPath();
        if (edge === "bottom") {
            const baseY = y + h;
            ctx.moveTo(x, baseY);
            for (let i = 0; i <= teeth; i++) {
                ctx.lineTo(x + (w / teeth) * i, baseY - (i % 2 === 0 ? 0 : amp));
            }
            ctx.lineTo(x + w, baseY);
        } else {
            const baseY = y;
            ctx.moveTo(x, baseY);
            for (let i = 0; i <= teeth; i++) {
                ctx.lineTo(x + (w / teeth) * i, baseY + (i % 2 === 0 ? 0 : amp));
            }
            ctx.lineTo(x + w, baseY);
        }
        ctx.closePath();
        ctx.fill();
    }

    // ---- Цветочное поле вместо земли ----
    function drawFlowerField() {
        const gy = H - GROUND_H;
        const grad = ctx.createLinearGradient(0, gy, 0, H);
        grad.addColorStop(0, "#8bc34a");
        grad.addColorStop(1, "#558b2f");
        ctx.fillStyle = grad;
        ctx.fillRect(0, gy, W, GROUND_H);

        const colors = ["#ffffff", "#ffeb3b", "#ff8fab", "#ba68c8"];
        const spacing = 26;
        const scrollX = bgOffset * 0.5;
        for (let x = -spacing; x < W + spacing * 2; x += spacing) {
            const raw = (x - scrollX) % (W + spacing);
            const fx = (raw < 0 ? raw + W + spacing : raw) - spacing / 2;
            const seed = Math.floor((x + 10000) / spacing);
            const fy = gy + 9 + (seed % 3) * 7;
            const color = colors[seed % colors.length];

            ctx.strokeStyle = "#3d7a1f";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(fx, fy + 5);
            ctx.lineTo(fx, fy + 11);
            ctx.stroke();

            ctx.fillStyle = color;
            for (let p = 0; p < 4; p++) {
                const ang = (Math.PI / 2) * p + 0.4;
                ctx.beginPath();
                ctx.arc(fx + Math.cos(ang) * 3, fy + Math.sin(ang) * 3, 2.6, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.fillStyle = "#ffb300";
            ctx.beginPath();
            ctx.arc(fx, fy, 1.8, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function draw() {
        drawSky();

        pipes.forEach(p => {
            drawChocolateBar(p.x, 0, PIPE_W, p.gapY, "bottom");
            drawChocolateBar(p.x, p.gapY + GAP, PIPE_W, H - GROUND_H - (p.gapY + GAP), "top");
        });

        drawFlowerField();

        // Птичка — голова с фотографии профиля
        ctx.save();
        ctx.translate(50, birdY);
        ctx.rotate(Math.max(-0.4, Math.min(0.9, birdV / 600)));
        if (flappyBirdImg.complete && flappyBirdImg.naturalWidth > 0) {
            ctx.drawImage(flappyBirdImg, -BIRD_W / 2, -BIRD_H / 2, BIRD_W, BIRD_H);
        } else {
            ctx.fillStyle = "#fbc02d";
            ctx.beginPath();
            ctx.arc(0, 0, 12, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function checkCollision() {
        const birdX = 50, r = BIRD_R;
        if (birdY + r >= H - GROUND_H || birdY - r <= 0) return true;
        return pipes.some(p =>
            birdX + r > p.x && birdX - r < p.x + PIPE_W &&
            (birdY - r < p.gapY || birdY + r > p.gapY + GAP)
        );
    }

    function loop(time) {
        if (gameOver) return;
        if (!lastTime) lastTime = time;
        const dt = Math.min(0.05, (time - lastTime) / 1000);
        lastTime = time;

        if (started) {
            birdV += GRAVITY * dt;
            birdY += birdV * dt;
            bgOffset += PIPE_SPEED * dt;

            spawnTimer += dt * 1000;
            if (spawnTimer >= PIPE_INTERVAL) {
                spawnTimer = 0;
                spawnPipe();
            }

            pipes.forEach(p => { p.x -= PIPE_SPEED * dt; });
            pipes = pipes.filter(p => p.x > -PIPE_W);

            pipes.forEach(p => {
                if (!p.passed && p.x + PIPE_W < 50) {
                    p.passed = true;
                    score++;
                    scoreEl.textContent = String(score);
                    playSound("point");
                }
            });

            if (checkCollision()) {
                endGame();
                return;
            }
        }

        draw();
        rafId = requestAnimationFrame(loop);
    }

    async function endGame() {
        gameOver = true;
        playSound("gameover");
        cancelAnimationFrame(rafId);
        const isRecord = await saveGameScore('flappy', score);
        if (isRecord) bestEl.textContent = String(score);
        showGameOverModal(score, isRecord, () => {
            reset();
            draw();
            rafId = requestAnimationFrame(loop);
        });
    }

    function jump() {
        if (gameOver) return;
        started = true;
        birdV = JUMP_V;
        playSound("jump");
    }

    function keyHandler(e) {
        if (e.code === "Space") { e.preventDefault(); jump(); }
    }
    document.addEventListener("keydown", keyHandler);
    canvas.addEventListener("mousedown", jump);
    canvas.addEventListener("touchstart", (e) => { e.preventDefault(); jump(); }, { passive: false });

    reset();
    draw();
    showPlayOverlay(canvas, () => {
        started = true;
        rafId = requestAnimationFrame(loop);
    });

    activeGameCleanup = () => {
        gameOver = true;
        cancelAnimationFrame(rafId);
        document.removeEventListener("keydown", keyHandler);
    };
}

// ------------------------- DOODLE JUMP -------------------------
// Персонаж и все "текстуры" (платформы, облачка, фон) нарисованы кодом
// (canvas-графика), без внешних картинок — как и остальные игры на сайте.
function startDoodleGame() {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);

    app.innerHTML = "";
    let title = document.createElement("h1");
    setEmojiTitle(title, "👾 Doodle Jump");
    title.style.marginBottom = "5px";
    app.appendChild(title);

    const W = 300, H = 420;
    const GRAVITY = 1100;       // px/с²
    const JUMP_V = -520;        // px/с — импульс подскока при приземлении на платформу
    const MOVE_SPEED = 210;     // px/с — горизонтальная скорость персонажа
    const PLAT_W = 58, PLAT_H = 13;
    const DOODLER_W = 34, DOODLER_H = 34;
    const ANCHOR_Y = H * 0.42;  // выше этой линии экран "скроллится" вниз, а не герой лезет выше

    // --- Новое: стрельба, монстры, броня, ракета ---
    const BULLET_SPEED = 620;       // px/с — скорость полёта пули вверх
    const SHOOT_COOLDOWN = 0.28;    // с — минимальный интервал между выстрелами
    const ROCKET_SPEED = 900;       // px/с — скорость подъёма на ракете
    const ROCKET_DURATION = 2.2;    // с — сколько длится полёт на ракете
    const ARMOR_DURATION = 5;       // с — сколько живёт броня
    const ARMOR_MAX_CHARGES = 5;    // сколько столкновений с монстрами держит броня
    const ARMOR_BLINK_AT = 1.4;     // с — за сколько до конца брони начинать моргать

    let wrap = document.createElement("div");
    wrap.className = "game-wrap";
    wrap.innerHTML = `
        <div class="game-score-row">Счёт: <span id="doodleScore">0</span> &nbsp;•&nbsp; Рекорд: <span id="doodleBest">${getMyBest('doodle')}</span></div>
        <canvas id="doodleCanvas" width="${W}" height="${H}" class="game-canvas"></canvas>
        <div class="dpad">
            <div class="dpad-mid">
                <button class="dpad-btn dpad-left">◀</button>
                <button class="dpad-btn dpad-shoot" title="Стрелять">🔫</button>
                <button class="dpad-btn dpad-right">▶</button>
            </div>
        </div>
    `;
    app.appendChild(wrap);

    const canvas = wrap.querySelector("#doodleCanvas");
    const ctx = setupResponsiveCanvas(canvas, W, H, 1.6);
    const scoreEl = wrap.querySelector("#doodleScore");
    const bestEl = wrap.querySelector("#doodleBest");

    let x, y, vx, vy, facing, platforms, score, scrollTotal, gameOver, lastTime, rafId, movingLeft, movingRight;
    let monsters, bullets, powerups, monsterNextY, lastShotTime;
    let armorActive, armorCharges, armorTimer;
    let rocketActive, rocketTimer;

    function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
        return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
    }

    function makePlatform(px, py, moving) {
        return {
            x: px, y: py, w: PLAT_W, h: PLAT_H,
            moving: !!moving,
            vx: moving ? (Math.random() < 0.5 ? -60 : 60) : 0
        };
    }

    function topmostY() {
        return platforms.reduce((min, p) => Math.min(min, p.y), Infinity);
    }

    function makePowerup(type, plat) {
        return { type, x: plat.x + plat.w / 2, y: plat.y - 20, w: 20, h: 20, collected: false };
    }

    function maybeSpawnPlatforms() {
        while (topmostY() > -20) {
            const py = topmostY() - (50 + Math.random() * 45);
            const px = 10 + Math.random() * (W - 20 - PLAT_W);
            const moving = Math.random() < 0.2;
            const plat = makePlatform(px, py, moving);
            platforms.push(plat);

            // Изредка на платформе появляется бонус: чаще броня, очень редко — ракета
            if (!moving) {
                const roll = Math.random();
                if (roll < 0.025) {
                    powerups.push(makePowerup('rocket', plat));
                } else if (roll < 0.16) {
                    powerups.push(makePowerup('armor', plat));
                }
            }
        }
    }

    // ---- Монстры ----
    function makeMonster(my) {
        const types = ['bat', 'ghost', 'spiky'];
        const type = types[Math.floor(Math.random() * types.length)];
        const mx = 24 + Math.random() * (W - 48);
        const m = { type, baseX: mx, baseY: my, x: mx, y: my, phase: Math.random() * Math.PI * 2 };
        if (type === 'bat') {
            m.vx = Math.random() < 0.5 ? -75 : 75;
            m.w = 30; m.h = 20;
        } else if (type === 'ghost') {
            m.w = 26; m.h = 30;
        } else {
            m.vx = (Math.random() < 0.5 ? -1 : 1) * (55 + Math.random() * 45);
            m.w = 26; m.h = 26;
        }
        return m;
    }

    function maybeSpawnMonsters() {
        while (monsterNextY > -80) {
            const spawnY = monsterNextY;
            monsterNextY -= 220 + Math.random() * 260;
            if (Math.random() < 0.55) {
                monsters.push(makeMonster(spawnY));
            }
        }
    }

    function updateMonsters(dt) {
        monsters.forEach(m => {
            m.phase += dt;
            if (m.type === 'bat') {
                m.baseX += m.vx * dt;
                if (m.baseX < 16) { m.baseX = 16; m.vx *= -1; }
                if (m.baseX > W - 16) { m.baseX = W - 16; m.vx *= -1; }
                m.x = m.baseX;
                m.y = m.baseY + Math.sin(m.phase * 7) * 3;
            } else if (m.type === 'ghost') {
                m.x = m.baseX + Math.sin(m.phase * 1.3) * 22;
                m.y = m.baseY + Math.sin(m.phase * 2) * 10;
            } else {
                m.baseX += m.vx * dt;
                if (m.baseX < 15) { m.baseX = 15; m.vx *= -1; }
                if (m.baseX > W - 15) { m.baseX = W - 15; m.vx *= -1; }
                m.x = m.baseX;
                m.y = m.baseY + Math.sin(m.phase * 3.4) * 14;
            }
        });
    }

    function shoot() {
        if (gameOver) return;
        const now = performance.now() / 1000;
        if (now - lastShotTime < SHOOT_COOLDOWN) return;
        lastShotTime = now;
        bullets.push({ x, y: y - DOODLER_H / 2, vy: -BULLET_SPEED });
        playSound("shoot");
    }

    function reset() {
        x = W / 2;
        vx = 0;
        facing = 1;
        score = 0;
        scrollTotal = 0;
        gameOver = false;
        movingLeft = false;
        movingRight = false;
        lastTime = null;
        scoreEl.textContent = "0";

        monsters = [];
        bullets = [];
        powerups = [];
        monsterNextY = -140; // монстры не появляются в первые секунды игры
        lastShotTime = -999;

        armorActive = false;
        armorCharges = 0;
        armorTimer = 0;
        rocketActive = false;
        rocketTimer = 0;

        platforms = [makePlatform(x - PLAT_W / 2, H - 30, false)];
        maybeSpawnPlatforms();

        // Герой стартует как будто только что оттолкнулся от первой платформы
        y = H - 30 - DOODLER_H / 2 - 2;
        vy = JUMP_V;
    }

    function roundedRect(rx, ry, rw, rh, r) {
        ctx.beginPath();
        ctx.moveTo(rx + r, ry);
        ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, r);
        ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
        ctx.arcTo(rx, ry + rh, rx, ry, r);
        ctx.arcTo(rx, ry, rx + rw, ry, r);
        ctx.closePath();
    }

    // ---- Персонаж-doodler, нарисованный самостоятельно ----
    function drawDoodler() {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(facing, 1);

        // усики-антенны
        ctx.strokeStyle = "#c98fb0";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-6, -DOODLER_H / 2 + 2);
        ctx.lineTo(-10, -DOODLER_H / 2 - 9);
        ctx.moveTo(6, -DOODLER_H / 2 + 2);
        ctx.lineTo(10, -DOODLER_H / 2 - 9);
        ctx.stroke();
        ctx.fillStyle = "#ffb6d5";
        ctx.beginPath();
        ctx.arc(-10, -DOODLER_H / 2 - 9, 2.6, 0, Math.PI * 2);
        ctx.arc(10, -DOODLER_H / 2 - 9, 2.6, 0, Math.PI * 2);
        ctx.fill();

        // тело
        ctx.fillStyle = "#f7a8c4";
        ctx.beginPath();
        ctx.ellipse(0, 0, DOODLER_W / 2, DOODLER_H / 2, 0, 0, Math.PI * 2);
        ctx.fill();

        // ножки
        ctx.fillStyle = "#e589ac";
        ctx.beginPath();
        ctx.ellipse(-8, DOODLER_H / 2 - 3, 6, 4, 0, 0, Math.PI * 2);
        ctx.ellipse(8, DOODLER_H / 2 - 3, 6, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        // глаза (смотрят по направлению движения)
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(6, -4, 6, 0, Math.PI * 2);
        ctx.arc(-4, -6, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#3a2733";
        ctx.beginPath();
        ctx.arc(8, -4, 2.6, 0, Math.PI * 2);
        ctx.arc(-3, -6, 2.2, 0, Math.PI * 2);
        ctx.fill();

        // улыбка
        ctx.strokeStyle = "#a4436a";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(2, 3, 5, 0.15 * Math.PI, 0.75 * Math.PI);
        ctx.stroke();

        ctx.restore();
    }

    function drawPlatform(p) {
        const grad = ctx.createLinearGradient(0, p.y, 0, p.y + p.h);
        if (p.moving) {
            grad.addColorStop(0, "#81d4fa");
            grad.addColorStop(1, "#4fc3f7");
        } else {
            grad.addColorStop(0, "#aee571");
            grad.addColorStop(1, "#7cb342");
        }
        ctx.fillStyle = grad;
        roundedRect(p.x, p.y, p.w, p.h, 6);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        roundedRect(p.x + 3, p.y + 2, p.w - 6, 3, 2);
        ctx.fill();
    }

    function drawBackground() {
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, "#dcecff");
        grad.addColorStop(1, "#f3e9ff");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // лёгкий параллакс-фон из облачков
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        for (let i = 0; i < 5; i++) {
            const cy = ((i * 130 + scrollTotal * 0.15) % (H + 100)) - 50;
            const cx = 40 + (i * 61) % (W - 80);
            ctx.beginPath();
            ctx.ellipse(cx, cy, 16, 9, 0, 0, Math.PI * 2);
            ctx.ellipse(cx + 12, cy - 4, 11, 8, 0, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function drawMonster(m) {
        ctx.save();
        ctx.translate(m.x, m.y);
        if (m.type === 'bat') {
            const flap = Math.sin(m.phase * 10) * 6;
            ctx.fillStyle = "#5b3a73";
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.quadraticCurveTo(-18, -6 - flap, -22, 4);
            ctx.quadraticCurveTo(-10, 2, 0, 0);
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.quadraticCurveTo(18, -6 - flap, 22, 4);
            ctx.quadraticCurveTo(10, 2, 0, 0);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(0, 0, 10, 8, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#ff5252";
            ctx.beginPath();
            ctx.arc(-3, -1, 1.6, 0, Math.PI * 2);
            ctx.arc(3, -1, 1.6, 0, Math.PI * 2);
            ctx.fill();
        } else if (m.type === 'ghost') {
            ctx.fillStyle = "rgba(180, 220, 255, 0.88)";
            ctx.beginPath();
            ctx.arc(0, -2, 13, Math.PI, 0, false);
            ctx.lineTo(13, 10);
            ctx.lineTo(8, 4);
            ctx.lineTo(3, 10);
            ctx.lineTo(-3, 4);
            ctx.lineTo(-8, 10);
            ctx.lineTo(-13, 4);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = "#33445a";
            ctx.beginPath();
            ctx.arc(-5, -3, 2, 0, Math.PI * 2);
            ctx.arc(5, -3, 2, 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.rotate(m.phase * 2);
            ctx.strokeStyle = "#e64a19";
            ctx.lineWidth = 3;
            for (let i = 0; i < 8; i++) {
                const ang = (Math.PI / 4) * i;
                ctx.beginPath();
                ctx.moveTo(Math.cos(ang) * 9, Math.sin(ang) * 9);
                ctx.lineTo(Math.cos(ang) * 15, Math.sin(ang) * 15);
                ctx.stroke();
            }
            ctx.fillStyle = "#ff7043";
            ctx.beginPath();
            ctx.arc(0, 0, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#3a2733";
            ctx.beginPath();
            ctx.arc(-3, -1, 1.6, 0, Math.PI * 2);
            ctx.arc(3, -1, 1.6, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function drawPowerup(pu) {
        ctx.save();
        ctx.translate(pu.x, pu.y);
        if (pu.type === 'armor') {
            ctx.fillStyle = "#42a5f5";
            ctx.beginPath();
            ctx.moveTo(0, -10);
            ctx.lineTo(9, -6);
            ctx.lineTo(9, 3);
            ctx.quadraticCurveTo(9, 10, 0, 13);
            ctx.quadraticCurveTo(-9, 10, -9, 3);
            ctx.lineTo(-9, -6);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = "#e3f2fd";
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.fillStyle = "#e3f2fd";
            ctx.beginPath();
            ctx.moveTo(-3, 0);
            ctx.lineTo(0, 4);
            ctx.lineTo(5, -4);
            ctx.lineTo(3, -4);
            ctx.lineTo(0, 0);
            ctx.lineTo(-1, -2);
            ctx.closePath();
            ctx.fill();
        } else {
            ctx.fillStyle = "#ef5350";
            ctx.beginPath();
            ctx.moveTo(0, -13);
            ctx.quadraticCurveTo(7, -2, 6, 8);
            ctx.lineTo(-6, 8);
            ctx.quadraticCurveTo(-7, -2, 0, -13);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = "#ffca28";
            ctx.beginPath();
            ctx.moveTo(-6, 8);
            ctx.lineTo(-9, 13);
            ctx.lineTo(-3, 9);
            ctx.closePath();
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(6, 8);
            ctx.lineTo(9, 13);
            ctx.lineTo(3, 9);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = "#90caf9";
            ctx.beginPath();
            ctx.arc(0, -1, 3, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function drawBullet(b) {
        ctx.save();
        const grad = ctx.createLinearGradient(b.x, b.y - 8, b.x, b.y + 6);
        grad.addColorStop(0, "#fff59d");
        grad.addColorStop(1, "#ff8a65");
        ctx.fillStyle = grad;
        roundedRect(b.x - 3, b.y - 8, 6, 14, 3);
        ctx.fill();
        ctx.restore();
    }

    // Щит брони моргает перед истечением — отдельного таймера на экране нет,
    // сам щит и есть индикатор
    function drawArmorShield() {
        const blinking = armorTimer < ARMOR_BLINK_AT;
        const visible = !blinking || (Math.floor(armorTimer * 8) % 2 === 0);
        if (!visible) return;
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = "rgba(129, 212, 250, 0.18)";
        ctx.beginPath();
        ctx.arc(0, 0, DOODLER_W / 2 + 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(66, 165, 245, 0.9)";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.restore();
    }

    function drawRocketFlame() {
        ctx.save();
        ctx.translate(x, y + DOODLER_H / 2);
        const flicker = 8 + Math.random() * 6;
        ctx.fillStyle = "#ffb300";
        ctx.beginPath();
        ctx.moveTo(-6, 0);
        ctx.lineTo(6, 0);
        ctx.lineTo(0, flicker + 10);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#ff7043";
        ctx.beginPath();
        ctx.moveTo(-3.5, 0);
        ctx.lineTo(3.5, 0);
        ctx.lineTo(0, flicker + 4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    function drawRocketShell() {
        ctx.save();
        ctx.translate(x, y);
        ctx.strokeStyle = "rgba(255, 112, 67, 0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, DOODLER_W / 2 + 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    function draw() {
        drawBackground();
        platforms.forEach(drawPlatform);
        powerups.forEach(drawPowerup);
        monsters.forEach(drawMonster);
        bullets.forEach(drawBullet);
        if (rocketActive) drawRocketFlame();
        drawDoodler();
        if (armorActive) drawArmorShield();
        if (rocketActive) drawRocketShell();
    }

    function update(dt) {
        if (movingLeft && !movingRight) { vx = -MOVE_SPEED; facing = -1; }
        else if (movingRight && !movingLeft) { vx = MOVE_SPEED; facing = 1; }
        else vx = 0;

        const half = DOODLER_W / 2;
        x += vx * dt;
        if (x < -half) x = W + half;
        if (x > W + half) x = -half;

        if (rocketActive) {
            // На ракете летим вверх быстро и без обычной физики/приземления
            y -= ROCKET_SPEED * dt;
            vy = -ROCKET_SPEED;
            rocketTimer -= dt;
            if (rocketTimer <= 0) {
                rocketActive = false;
                vy = JUMP_V * 0.7; // мягкий переход обратно в обычный полёт
            }
        } else {
            vy += GRAVITY * dt;
            const prevY = y;
            y += vy * dt;

            // приземление на платформу (только когда падаем вниз)
            if (vy > 0) {
                for (const p of platforms) {
                    const feetPrev = prevY + DOODLER_H / 2;
                    const feetNow = y + DOODLER_H / 2;
                    const withinX = x + half * 0.6 > p.x && x - half * 0.6 < p.x + p.w;
                    if (withinX && feetPrev <= p.y && feetNow >= p.y) {
                        y = p.y - DOODLER_H / 2;
                        vy = JUMP_V;
                        playSound("jump");
                        break;
                    }
                }
            }
        }

        // движущиеся платформы
        platforms.forEach(p => {
            if (p.moving) {
                p.x += p.vx * dt;
                if (p.x < 6) { p.x = 6; p.vx *= -1; }
                if (p.x + p.w > W - 6) { p.x = W - 6 - p.w; p.vx *= -1; }
            }
        });

        // скроллинг мира вниз (визуально — герой карабкается выше), когда герой поднимается выше anchor-линии
        if (y < ANCHOR_Y) {
            const dy = ANCHOR_Y - y;
            y = ANCHOR_Y;
            platforms.forEach(p => { p.y += dy; });
            monsters.forEach(m => { m.baseY += dy; });
            powerups.forEach(pu => { pu.y += dy; });
            bullets.forEach(b => { b.y += dy; });
            monsterNextY += dy;
            scrollTotal += dy;
            score = Math.floor(scrollTotal / 10);
            scoreEl.textContent = String(score);
        }

        platforms = platforms.filter(p => p.y < H + 20);
        maybeSpawnPlatforms();

        updateMonsters(dt);
        monsters = monsters.filter(m => m.y < H + 60);
        maybeSpawnMonsters();

        // подбор бонусов (броня/ракета)
        powerups = powerups.filter(pu => pu.y < H + 20);
        powerups.forEach(pu => {
            if (pu.collected) return;
            if (rectsOverlap(x - half * 0.8, y - DOODLER_H * 0.4, half * 1.6, DOODLER_H * 0.8, pu.x - pu.w / 2, pu.y - pu.h / 2, pu.w, pu.h)) {
                pu.collected = true;
                if (pu.type === 'armor') {
                    armorActive = true;
                    armorCharges = ARMOR_MAX_CHARGES;
                    armorTimer = ARMOR_DURATION;
                } else if (pu.type === 'rocket') {
                    rocketActive = true;
                    rocketTimer = ROCKET_DURATION;
                }
            }
        });
        powerups = powerups.filter(pu => !pu.collected);

        // истечение брони по времени
        if (armorActive) {
            armorTimer -= dt;
            if (armorTimer <= 0 || armorCharges <= 0) {
                armorActive = false;
            }
        }

        // пули
        bullets.forEach(b => { b.y += b.vy * dt; });
        bullets = bullets.filter(b => b.y > -20);

        // пули сбивают монстров
        for (let bi = bullets.length - 1; bi >= 0; bi--) {
            const b = bullets[bi];
            for (let mi = monsters.length - 1; mi >= 0; mi--) {
                const m = monsters[mi];
                if (rectsOverlap(b.x - 3, b.y - 7, 6, 14, m.x - m.w / 2, m.y - m.h / 2, m.w, m.h)) {
                    monsters.splice(mi, 1);
                    bullets.splice(bi, 1);
                    score += 5;
                    scoreEl.textContent = String(score);
                    playSound("point");
                    break;
                }
            }
        }

        // столкновения дудлика с монстрами
        const dbx = x - half * 0.65, dbw = half * 1.3;
        const dby = y - DOODLER_H * 0.325, dbh = DOODLER_H * 0.65;
        for (let mi = monsters.length - 1; mi >= 0; mi--) {
            const m = monsters[mi];
            if (!rectsOverlap(dbx, dby, dbw, dbh, m.x - m.w / 2, m.y - m.h / 2, m.w, m.h)) continue;

            if (rocketActive) {
                // На ракете монстры не наносят урона — сбиваем их с пути
                monsters.splice(mi, 1);
            } else if (armorActive) {
                monsters.splice(mi, 1);
                armorCharges -= 1;
                if (armorCharges <= 0) armorActive = false;
            } else {
                endGame();
                return;
            }
        }

        if (y - DOODLER_H / 2 > H) {
            endGame();
        }
    }

    function loop(time) {
        if (gameOver) return;
        if (!lastTime) lastTime = time;
        const dt = Math.min(0.05, (time - lastTime) / 1000);
        lastTime = time;

        update(dt);
        draw();
        rafId = requestAnimationFrame(loop);
    }

    async function endGame() {
        gameOver = true;
        playSound("gameover");
        cancelAnimationFrame(rafId);
        const isRecord = await saveGameScore('doodle', score);
        if (isRecord) bestEl.textContent = String(score);
        showGameOverModal(score, isRecord, () => {
            reset();
            draw();
            rafId = requestAnimationFrame(loop);
        });
    }

    function keyHandler(e) {
        if (e.code === "ArrowLeft" || e.code === "KeyA") { e.preventDefault(); movingLeft = true; }
        if (e.code === "ArrowRight" || e.code === "KeyD") { e.preventDefault(); movingRight = true; }
        if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") { e.preventDefault(); shoot(); }
    }
    function keyUpHandler(e) {
        if (e.code === "ArrowLeft" || e.code === "KeyA") movingLeft = false;
        if (e.code === "ArrowRight" || e.code === "KeyD") movingRight = false;
    }
    document.addEventListener("keydown", keyHandler);
    document.addEventListener("keyup", keyUpHandler);

    function bindHold(btn, onDown, onUp) {
        btn.addEventListener("mousedown", (e) => { e.preventDefault(); onDown(); });
        btn.addEventListener("touchstart", (e) => { e.preventDefault(); onDown(); }, { passive: false });
        btn.addEventListener("mouseup", onUp);
        btn.addEventListener("mouseleave", onUp);
        btn.addEventListener("touchend", onUp);
    }
    bindHold(wrap.querySelector(".dpad-left"), () => { movingLeft = true; }, () => { movingLeft = false; });
    bindHold(wrap.querySelector(".dpad-right"), () => { movingRight = true; }, () => { movingRight = false; });

    const shootBtn = wrap.querySelector(".dpad-shoot");
    shootBtn.addEventListener("mousedown", (e) => { e.preventDefault(); shoot(); });
    shootBtn.addEventListener("touchstart", (e) => { e.preventDefault(); shoot(); }, { passive: false });

    // Тап по канвасу — тоже управление: держим левую/правую половину экрана
    canvas.addEventListener("touchstart", (e) => {
        const rect = canvas.getBoundingClientRect();
        const tx = e.touches[0].clientX - rect.left;
        if (tx < rect.width / 2) movingLeft = true; else movingRight = true;
    }, { passive: true });
    canvas.addEventListener("touchend", () => { movingLeft = false; movingRight = false; }, { passive: true });

    reset();
    draw();
    showPlayOverlay(canvas, () => {
        rafId = requestAnimationFrame(loop);
    });

    activeGameCleanup = () => {
        gameOver = true;
        cancelAnimationFrame(rafId);
        document.removeEventListener("keydown", keyHandler);
        document.removeEventListener("keyup", keyUpHandler);
    };
}

// ------------------------- БРОККОЛИ-РАННЕР -------------------------
// Аналог "динозаврика" из Chrome: бесконечный раннер, где вместо кактусов —
// брокколи (наземные препятствия, через них нужно перепрыгивать), а вместо
// птеродактилей — летучие мыши (летают на уровне корпуса/головы, от них нужно
// приседать). Спрайт героя — фото персонажа, вырезанное из фона (см. выше).
function startRunnerGame() {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);

    app.innerHTML = "";
    let title = document.createElement("h1");
    setEmojiTitle(title, "🥦 Бега Брокколи");
    title.style.marginBottom = "5px";
    app.appendChild(title);

    const W = 300, H = 150;
    const GROUND_Y = H - 26;           // линия земли, на которую опираются ноги
    const GRAVITY = 1800;              // px/с² (было 1700 — прыжок держит чуть дольше)
    const JUMP_V = -480;               // px/с — импульс прыжка (было -440 — прыжок повыше)
    const BASE_SPEED = 190;            // px/с — начальная скорость мира
    const MAX_SPEED = 430;             // px/с — потолок скорости
    const SPEED_PER_PX = 0.018;        // рост скорости за каждый пройденный пиксель дистанции
    const CHAR_X = 54;                 // фиксированная позиция героя по X
    const STAND_H = 60, STAND_W = 46;  // размеры героя стоя/в прыжке (визуальные, для отрисовки)
    const DUCK_H = 36, DUCK_W = 46;    // размеры героя в приседе (просто уменьшенный спрайт)
    const BROC_MIN_H = 16, BROC_MAX_H = 26; // было 20-32 — брокколи пониже, чтобы прыжок гарантированно перекрывал их
    const BAT_TOP_BASE = GROUND_Y - 78; // верх зоны, где летает мышь (варьируется)
    const BAT_H = 26;

    let wrap = document.createElement("div");
    wrap.className = "game-wrap";
    wrap.innerHTML = `
        <div class="game-score-row">Счёт: <span id="runnerScore">0</span> &nbsp;•&nbsp; Рекорд: <span id="runnerBest">${getMyBest('runner')}</span></div>
        <canvas id="runnerCanvas" width="${W}" height="${H}" class="game-canvas"></canvas>
        <div class="dpad">
            <div class="dpad-mid">
                <button class="dpad-btn dpad-duck" title="Присесть">⬇️</button>
                <button class="dpad-btn dpad-jump" title="Прыжок">⬆️</button>
            </div>
        </div>
    `;
    app.appendChild(wrap);

    const canvas = wrap.querySelector("#runnerCanvas");
    const ctx = setupResponsiveCanvas(canvas, W, H, 2.0);
    const scoreEl = wrap.querySelector("#runnerScore");
    const bestEl = wrap.querySelector("#runnerBest");

    let footY, vy, ducking, obstacles, distance, speed, score, gameOver, started;
    let lastTime, rafId, spawnTimer, nextSpawnIn, bgOffset, dustParticles, animT;

    function reset() {
        footY = GROUND_Y;
        vy = 0;
        ducking = false;
        obstacles = [];
        dustParticles = [];
        distance = 0;
        speed = BASE_SPEED;
        score = 0;
        gameOver = false;
        started = false;
        lastTime = null;
        spawnTimer = 0;
        nextSpawnIn = 900;
        bgOffset = 0;
        animT = 0;
        scoreEl.textContent = "0";
    }

    function currentCharBox() {
        const grounded = footY >= GROUND_Y - 0.5;
        if (ducking && grounded) {
            return { top: footY - DUCK_H, bottom: footY, w: DUCK_W };
        }
        return { top: footY - STAND_H, bottom: footY, w: STAND_W };
    }

    function spawnObstacle() {
        const isBat = Math.random() < 0.35;
        if (isBat) {
            const wobble = (Math.random() - 0.5) * 10;
            obstacles.push({
                type: "bat", x: W + 10, w: 32,
                top: BAT_TOP_BASE + wobble, h: BAT_H,
                phase: Math.random() * Math.PI * 2
            });
        } else {
            const h = BROC_MIN_H + Math.random() * (BROC_MAX_H - BROC_MIN_H);
            const w = 20 + Math.random() * 8;
            obstacles.push({ type: "broccoli", x: W + 10, w, h, top: GROUND_Y - h });
        }
    }

    // ---- Сумеречное небо: луна, звёзды, силуэты облаков ----
    function drawSky() {
        const grad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
        grad.addColorStop(0, "#4b3a68");
        grad.addColorStop(0.55, "#a06791");
        grad.addColorStop(1, "#f6c3d6");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, GROUND_Y);

        // луна
        ctx.fillStyle = "rgba(255, 250, 235, 0.92)";
        ctx.beginPath();
        ctx.arc(W - 36, 28, 14, 0, Math.PI * 2);
        ctx.fill();

        // звёзды
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        for (let i = 0; i < 12; i++) {
            const sx = (i * 53 + 20 - bgOffset * 0.15) % (W + 40);
            const fx = (sx < 0 ? sx + W + 40 : sx) - 20;
            const sy = 10 + (i * 37) % 60;
            const tw = 0.5 + 0.5 * Math.sin(animT * 3 + i);
            ctx.globalAlpha = 0.4 + 0.5 * tw;
            ctx.fillRect(fx, sy, 2, 2);
        }
        ctx.globalAlpha = 1;

        // силуэты холмов на горизонте
        ctx.fillStyle = "rgba(60, 40, 70, 0.55)";
        for (let i = 0; i < 3; i++) {
            const raw = (i * 130 + 40 - bgOffset * 0.3) % (W + 160);
            const hx = (raw < 0 ? raw + W + 160 : raw) - 80;
            ctx.beginPath();
            ctx.ellipse(hx, GROUND_Y + 6, 90, 26, 0, Math.PI, 0, true);
            ctx.fill();
        }
    }

    // ---- Дорожка-земля со скроллящейся текстурой ----
    function drawGround() {
        const grad = ctx.createLinearGradient(0, GROUND_Y, 0, H);
        grad.addColorStop(0, "#7a5c46");
        grad.addColorStop(1, "#4f3a2c");
        ctx.fillStyle = grad;
        ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);

        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.lineWidth = 2;
        const spacing = 34;
        const scrollX = bgOffset % spacing;
        for (let x = -scrollX; x < W; x += spacing) {
            ctx.beginPath();
            ctx.moveTo(x, GROUND_Y + 3);
            ctx.lineTo(x + 16, GROUND_Y + 3);
            ctx.stroke();
        }

        // травинки у кромки
        ctx.strokeStyle = "#8bc34a";
        ctx.lineWidth = 1.5;
        const gspacing = 22;
        const gscroll = bgOffset % gspacing;
        for (let x = -gscroll; x < W; x += gspacing) {
            const seed = Math.floor((x + bgOffset) / gspacing);
            const h2 = 4 + (seed % 3) * 2;
            ctx.beginPath();
            ctx.moveTo(x, GROUND_Y);
            ctx.lineTo(x - 2, GROUND_Y - h2);
            ctx.moveTo(x, GROUND_Y);
            ctx.lineTo(x + 2, GROUND_Y - h2 + 1);
            ctx.stroke();
        }
    }

    // ---- Брокколи-препятствие ----
    function drawBroccoli(o) {
        const cx = o.x + o.w / 2;
        const stemW = o.w * 0.34;
        ctx.fillStyle = "#c8d98a";
        ctx.fillRect(cx - stemW / 2, GROUND_Y - o.h * 0.4, stemW, o.h * 0.4);

        const florR = o.w * 0.32;
        const centers = [
            [cx, GROUND_Y - o.h + florR * 0.9],
            [cx - o.w * 0.28, GROUND_Y - o.h + florR * 1.3],
            [cx + o.w * 0.28, GROUND_Y - o.h + florR * 1.3],
            [cx - o.w * 0.12, GROUND_Y - o.h + florR * 0.3],
            [cx + o.w * 0.12, GROUND_Y - o.h + florR * 0.3]
        ];
        ctx.fillStyle = "#2e7d32";
        centers.forEach(c => {
            ctx.beginPath();
            ctx.arc(c[0], c[1], florR, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.fillStyle = "rgba(255,255,255,0.18)";
        centers.forEach(c => {
            ctx.beginPath();
            ctx.arc(c[0] - florR * 0.3, c[1] - florR * 0.3, florR * 0.4, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // ---- Летучая мышь-препятствие ----
    function drawBat(o) {
        const cx = o.x + o.w / 2, cy = o.top + o.h / 2;
        const flap = Math.sin(animT * 11 + o.phase) * 7;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.fillStyle = "#241a33";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(-16, -6 - flap, -20, 3);
        ctx.quadraticCurveTo(-9, 1, 0, 0);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(16, -6 - flap, 20, 3);
        ctx.quadraticCurveTo(9, 1, 0, 0);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(0, 0, 9, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ff5252";
        ctx.beginPath();
        ctx.arc(-3, -1, 1.4, 0, Math.PI * 2);
        ctx.arc(3, -1, 1.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // ---- Пылевые частицы под ногами при беге ----
    function updateDust(dt) {
        if (started && !gameOver && footY >= GROUND_Y - 0.5 && Math.random() < 0.5) {
            dustParticles.push({ x: CHAR_X - 14, y: GROUND_Y - 2, age: 0 });
        }
        dustParticles.forEach(p => { p.age += dt; p.x -= speed * dt; });
        dustParticles = dustParticles.filter(p => p.age < 0.5);
    }

    function drawDust() {
        dustParticles.forEach(p => {
            const a = 1 - p.age / 0.5;
            ctx.fillStyle = `rgba(230, 220, 210, ${a * 0.5})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y - p.age * 12, 3 + p.age * 6, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // ---- Герой — фото персонажа в беге/прыжке/приседе ----
    function drawChar() {
        const box = currentCharBox();
        const w = box.w, h = box.bottom - box.top;
        const cx = CHAR_X, cy = box.bottom;
        ctx.save();
        ctx.translate(cx, cy);
        const airborne = footY < GROUND_Y - 0.5;
        const tilt = airborne ? Math.max(-0.18, Math.min(0.28, vy / 900)) : 0;
        const bob = (!airborne && started) ? Math.sin(animT * 16) * 2 : 0;
        ctx.translate(0, bob);
        ctx.rotate(tilt);
        if (runnerCharImg.complete && runnerCharImg.naturalWidth > 0) {
            ctx.drawImage(runnerCharImg, -w / 2, -h, w, h);
        } else {
            ctx.fillStyle = "#ff2e93";
            ctx.fillRect(-w / 2, -h, w, h);
        }
        ctx.restore();
    }

    function draw() {
        drawSky();
        obstacles.forEach(o => o.type === "broccoli" ? drawBroccoli(o) : drawBat(o));
        drawGround();
        drawDust();
        drawChar();
    }

    function checkCollision() {
        const box = currentCharBox();
        // Хитбокс намеренно уже и ниже, чем весь спрайт (руки/волосы на фото не должны
        // засчитываться как столкновение) — иначе перепрыгнуть препятствия почти нереально.
        const insetX = 8, insetTop = 6, insetBottom = 2;
        const left = CHAR_X - box.w / 2 + insetX, right = CHAR_X + box.w / 2 - insetX;
        const top = box.top + insetTop, bottom = box.bottom - insetBottom;
        return obstacles.some(o => {
            if (right < o.x || left > o.x + o.w) return false;
            const oTop = o.top;
            const oBottom = o.type === "broccoli" ? GROUND_Y : o.top + o.h;
            return top < oBottom && bottom > oTop;
        });
    }

    function loop(time) {
        if (gameOver) return;
        if (!lastTime) lastTime = time;
        const dt = Math.min(0.05, (time - lastTime) / 1000);
        lastTime = time;
        animT += dt;

        if (started) {
            distance += speed * dt;
            speed = Math.min(MAX_SPEED, BASE_SPEED + distance * SPEED_PER_PX);
            bgOffset += speed * dt;

            const newScore = Math.floor(distance / 10);
            if (newScore !== score) {
                score = newScore;
                scoreEl.textContent = String(score);
            }

            // физика прыжка
            if (footY < GROUND_Y) {
                vy += GRAVITY * dt;
                footY += vy * dt;
                if (footY >= GROUND_Y) { footY = GROUND_Y; vy = 0; }
            }

            // спавн препятствий, интервал сокращается по мере роста скорости
            const t = Math.min(1, distance / 3000);
            const minInt = 950 - t * 300;
            const maxInt = 1700 - t * 500;
            spawnTimer += dt * 1000;
            if (spawnTimer >= nextSpawnIn) {
                spawnTimer = 0;
                nextSpawnIn = minInt + Math.random() * (maxInt - minInt);
                spawnObstacle();
            }

            obstacles.forEach(o => { o.x -= speed * dt; });
            obstacles = obstacles.filter(o => o.x + o.w > -10);

            updateDust(dt);

            if (checkCollision()) {
                endGame();
                return;
            }
        }

        draw();
        rafId = requestAnimationFrame(loop);
    }

    async function endGame() {
        gameOver = true;
        playSound("gameover");
        cancelAnimationFrame(rafId);
        const isRecord = await saveGameScore('runner', score);
        if (isRecord) bestEl.textContent = String(score);
        showGameOverModal(score, isRecord, () => {
            reset();
            draw();
            rafId = requestAnimationFrame(loop);
        });
    }

    function jump() {
        if (gameOver) return;
        started = true;
        if (footY >= GROUND_Y - 0.5 && !ducking) {
            vy = JUMP_V;
            footY = GROUND_Y - 0.01;
            playSound("jump");
        }
    }

    function setDuck(v) {
        if (gameOver) return;
        started = started || v;
        ducking = v;
    }

    function keyHandler(e) {
        if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") { e.preventDefault(); jump(); }
        if (e.code === "ArrowDown" || e.code === "KeyS") { e.preventDefault(); setDuck(true); }
    }
    function keyUpHandler(e) {
        if (e.code === "ArrowDown" || e.code === "KeyS") setDuck(false);
    }
    document.addEventListener("keydown", keyHandler);
    document.addEventListener("keyup", keyUpHandler);

    function bindHold(btn, onDown, onUp) {
        btn.addEventListener("mousedown", (e) => { e.preventDefault(); onDown(); });
        btn.addEventListener("touchstart", (e) => { e.preventDefault(); onDown(); }, { passive: false });
        btn.addEventListener("mouseup", onUp);
        btn.addEventListener("mouseleave", onUp);
        btn.addEventListener("touchend", onUp);
    }
    wrap.querySelector(".dpad-jump").addEventListener("mousedown", (e) => { e.preventDefault(); jump(); });
    wrap.querySelector(".dpad-jump").addEventListener("touchstart", (e) => { e.preventDefault(); jump(); }, { passive: false });
    bindHold(wrap.querySelector(".dpad-duck"), () => setDuck(true), () => setDuck(false));

    canvas.addEventListener("mousedown", jump);
    canvas.addEventListener("touchstart", (e) => { e.preventDefault(); jump(); }, { passive: false });

    reset();
    draw();
    showPlayOverlay(canvas, () => {
        started = true;
        rafId = requestAnimationFrame(loop);
    });

    activeGameCleanup = () => {
        gameOver = true;
        cancelAnimationFrame(rafId);
        document.removeEventListener("keydown", keyHandler);
        document.removeEventListener("keyup", keyUpHandler);
    };
}

// ------------------------- ЭМОДЗИ НИНДЗЯ (аналог Fruit Ninja) -------------------------
// Эмодзи подлетают снизу вверх по дуге под гравитацией, их нужно "разрезать"
// проведя пальцем/мышью по экрану. Бомбу 💣 резать нельзя — игра сразу заканчивается.
// Пропустил (не разрезал) обычный эмодзи, улетевший вниз за край экрана — теряешь жизнь.
function startNinjaGame() {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);

    app.innerHTML = "";
    let title = document.createElement("h1");
    setEmojiTitle(title, "💣 Эмодзи Ниндзя");
    title.style.marginBottom = "5px";
    app.appendChild(title);

    const W = 300, H = 420;
    const TARGET_EMOJIS = ["😈", "❤️", "⭐", "🍫", "💖"];
    const BOMB_EMOJI = "💣";
    const GRAVITY = 780;          // px/с²
    const START_LIVES = 3;
    const OBJ_R = 20;             // радиус для попадания среза
    const FONT_SIZE = 34;
    const BOMB_CHANCE = 0.16;
    let SPAWN_MIN = 750, SPAWN_MAX = 1250; // мс между волнами (сужается по ходу игры)

    let wrap = document.createElement("div");
    wrap.className = "game-wrap";
    wrap.innerHTML = `
        <div class="game-score-row">Счёт: <span id="ninjaScore">0</span> &nbsp;•&nbsp; Рекорд: <span id="ninjaBest">${getMyBest('ninja')}</span> &nbsp;•&nbsp; Жизни: <span id="ninjaLives">${START_LIVES}</span></div>
        <canvas id="ninjaCanvas" width="${W}" height="${H}" class="game-canvas"></canvas>
    `;
    app.appendChild(wrap);

    const canvas = wrap.querySelector("#ninjaCanvas");
    const ctx = setupResponsiveCanvas(canvas, W, H, 1.6);
    const scoreEl = wrap.querySelector("#ninjaScore");
    const bestEl = wrap.querySelector("#ninjaBest");
    const livesEl = wrap.querySelector("#ninjaLives");

    let objects, score, lives, gameOver, lastTime, rafId, spawnTimer, nextSpawnIn, trail, isDown, particles;

    function reset() {
        objects = [];
        particles = [];
        trail = [];
        score = 0;
        lives = START_LIVES;
        gameOver = false;
        isDown = false;
        spawnTimer = 0;
        nextSpawnIn = 600;
        SPAWN_MIN = 750; SPAWN_MAX = 1250;
        scoreEl.textContent = "0";
        livesEl.textContent = String(lives);
    }

    function spawnWave() {
        const count = Math.random() < 0.3 ? 2 : 1;
        for (let i = 0; i < count; i++) {
            const isBomb = Math.random() < BOMB_CHANCE;
            const x = 40 + Math.random() * (W - 80);
            const vy = -(560 + Math.random() * 170);
            const vx = (Math.random() - 0.5) * 90;
            objects.push({
                emoji: isBomb ? BOMB_EMOJI : TARGET_EMOJIS[Math.floor(Math.random() * TARGET_EMOJIS.length)],
                isBomb,
                x, y: H + 20,
                vx, vy,
                rot: 0, vr: (Math.random() - 0.5) * 4,
                sliced: false,
                r: OBJ_R
            });
        }
        // Постепенно ускоряем игру по мере роста счёта
        SPAWN_MIN = Math.max(380, 750 - score * 4);
        SPAWN_MAX = Math.max(650, 1250 - score * 6);
    }

    function spawnParticles(x, y, color) {
        for (let i = 0; i < 8; i++) {
            const angle = (Math.PI * 2 * i) / 8;
            particles.push({
                x, y,
                vx: Math.cos(angle) * (80 + Math.random() * 60),
                vy: Math.sin(angle) * (80 + Math.random() * 60),
                life: 0.4,
                color
            });
        }
    }

    function distToSegment(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const cx = x1 + t * dx, cy = y1 + t * dy;
        return Math.hypot(px - cx, py - cy);
    }

    function sliceCheck(x1, y1, x2, y2) {
        if (gameOver) return;
        objects.forEach(o => {
            if (o.sliced) return;
            if (distToSegment(o.x, o.y, x1, y1, x2, y2) <= o.r) {
                o.sliced = true;
                if (o.isBomb) {
                    playSound("bomb");
                    spawnParticles(o.x, o.y, "#444");
                    endGame();
                } else {
                    playSound("slice");
                    score++;
                    scoreEl.textContent = String(score);
                    spawnParticles(o.x, o.y, "#ff6fa5");
                }
            }
        });
    }

    function draw() {
        // Фон — мягкое ночное небо в тон стилю сайта
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, "#2b1f3d");
        grad.addColorStop(1, "#553459");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // След от пальца/мыши
        if (trail.length > 1) {
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            for (let i = 1; i < trail.length; i++) {
                const p0 = trail[i - 1], p1 = trail[i];
                const alpha = i / trail.length;
                ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.9})`;
                ctx.lineWidth = 4 * alpha + 1;
                ctx.beginPath();
                ctx.moveTo(p0.x, p0.y);
                ctx.lineTo(p1.x, p1.y);
                ctx.stroke();
            }
        }

        // Эмодзи-объекты
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `${FONT_SIZE}px sans-serif`;
        objects.forEach(o => {
            if (o.sliced) return;
            ctx.save();
            ctx.translate(o.x, o.y);
            ctx.rotate(o.rot);
            ctx.fillText(o.emoji, 0, 0);
            ctx.restore();
        });

        // Частицы разлёта
        particles.forEach(p => {
            ctx.globalAlpha = Math.max(0, p.life / 0.4);
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        });
    }

    function update(dt) {
        spawnTimer += dt * 1000;
        if (spawnTimer >= nextSpawnIn) {
            spawnTimer = 0;
            nextSpawnIn = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
            spawnWave();
        }

        objects.forEach(o => {
            o.vy += GRAVITY * dt;
            o.x += o.vx * dt;
            o.y += o.vy * dt;
            o.rot += o.vr * dt;
        });

        // Пропущенные (упавшие вниз, не разрезанные) обычные эмодзи — минус жизнь
        for (let i = objects.length - 1; i >= 0; i--) {
            const o = objects[i];
            if (o.y - o.r > H) {
                if (!o.sliced && !o.isBomb) {
                    lives--;
                    livesEl.textContent = String(lives);
                    if (lives <= 0) { objects.splice(i, 1); endGame(); continue; }
                }
                objects.splice(i, 1);
            } else if (o.sliced) {
                objects.splice(i, 1);
            }
        }

        particles.forEach(p => {
            p.life -= dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += GRAVITY * 0.4 * dt;
        });
        particles = particles.filter(p => p.life > 0);
    }

    function loop(time) {
        if (gameOver) return;
        if (!lastTime) lastTime = time;
        const dt = Math.min(0.05, (time - lastTime) / 1000);
        lastTime = time;

        update(dt);
        draw();
        rafId = requestAnimationFrame(loop);
    }

    async function endGame() {
        if (gameOver) return;
        gameOver = true;
        playSound("gameover");
        cancelAnimationFrame(rafId);
        const isRecord = await saveGameScore('ninja', score);
        if (isRecord) bestEl.textContent = String(score);
        showGameOverModal(score, isRecord, () => {
            reset();
            draw();
            lastTime = 0;
            rafId = requestAnimationFrame(loop);
        });
    }

    function canvasPoint(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: (clientX - rect.left) * (W / rect.width),
            y: (clientY - rect.top) * (H / rect.height)
        };
    }

    function pointerDown(clientX, clientY) {
        if (gameOver) return;
        isDown = true;
        trail = [canvasPoint(clientX, clientY)];
    }
    function pointerMove(clientX, clientY) {
        if (!isDown || gameOver) return;
        const p = canvasPoint(clientX, clientY);
        const prev = trail[trail.length - 1];
        trail.push(p);
        if (trail.length > 12) trail.shift();
        if (prev) sliceCheck(prev.x, prev.y, p.x, p.y);
    }
    function pointerUp() {
        isDown = false;
        trail = [];
    }

    function mouseDownHandler(e) { pointerDown(e.clientX, e.clientY); }
    function mouseMoveHandler(e) { pointerMove(e.clientX, e.clientY); }
    function mouseUpHandler() { pointerUp(); }
    function touchStartHandler(e) { e.preventDefault(); const t = e.touches[0]; pointerDown(t.clientX, t.clientY); }
    function touchMoveHandler(e) { e.preventDefault(); const t = e.touches[0]; pointerMove(t.clientX, t.clientY); }
    function touchEndHandler(e) { e.preventDefault(); pointerUp(); }

    canvas.addEventListener("mousedown", mouseDownHandler);
    canvas.addEventListener("mousemove", mouseMoveHandler);
    window.addEventListener("mouseup", mouseUpHandler);
    canvas.addEventListener("touchstart", touchStartHandler, { passive: false });
    canvas.addEventListener("touchmove", touchMoveHandler, { passive: false });
    canvas.addEventListener("touchend", touchEndHandler, { passive: false });

    reset();
    draw();
    showPlayOverlay(canvas, () => {
        rafId = requestAnimationFrame(loop);
    });

    activeGameCleanup = () => {
        gameOver = true;
        cancelAnimationFrame(rafId);
        canvas.removeEventListener("mousedown", mouseDownHandler);
        canvas.removeEventListener("mousemove", mouseMoveHandler);
        window.removeEventListener("mouseup", mouseUpHandler);
        canvas.removeEventListener("touchstart", touchStartHandler);
        canvas.removeEventListener("touchmove", touchMoveHandler);
        canvas.removeEventListener("touchend", touchEndHandler);
    };
}

// =======================================================
// РИТМ-АРКАДА — 6-я игра. Уровни НЕ прописаны заранее: они строятся
// на лету анализом самого аудиофайла (энергетический onset-детектор
// ищет резкие всплески громкости — то есть "биты"). Треки — фиксированный
// набор файлов из папки rhythm_game/ на GitHub (см. RHYTHM_TRACK_FILES).
// =======================================================
//
// Нужно один раз создать отдельную таблицу в Supabase (SQL editor) —
// рекорды тут хранятся ПО КАЖДОМУ ТРЕКУ отдельно, а не одной строкой
// на игру, как в game_scores у остальных 5 игр:
//
// create table rhythm_scores (
//   user_id uuid references auth.users(id),
//   username text,
//   track_name text,
//   best_score integer default 0,
//   updated_at timestamptz default now(),
//   primary key (user_id, track_name)
// );

// ----------------- Список треков -----------------
// Набор треков больше не меняется, поэтому список зашит прямо здесь — без
// поиска новых файлов (раньше папка листилась через jsDelivr API + SHA
// ветки с GitHub API). Сами файлы по-прежнему лежат в папке rhythm_game/
// репозитория на GitHub и отдаются через CDN jsDelivr; раз они не меняются,
// ссылка на ветку main без SHA безопасна — устаревать в кэше нечему.
// Имя файла — стабильный ID трека: по нему хранятся рекорды в
// rhythm_scores, так что переименовывать файлы нельзя.
const RHYTHM_TRACKS_DIR = "https://cdn.jsdelivr.net/gh/BaksOriginal/movies@main/rhythm_game/";
const RHYTHM_TRACK_FILES = [
    "BenSound ♥ Angels By My Side.ogg",
    "BenSound ♥ New Frontier.ogg",
    "BenSound ♥ The Light Between Us.ogg",
    "BenSound ♥ Unbreakable Resolve.ogg",
];

const RHYTHM_TRACKS = RHYTHM_TRACK_FILES
    .map(fileName => ({
        key: fileName,
        label: fileName.replace(/\.ogg$/i, "").replace(/[_-]+/g, " ").trim(),
        url: RHYTHM_TRACKS_DIR + encodeURIComponent(fileName)
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "ru"));

// ----------------- Рекорды: отдельно по каждому треку -----------------
let rhythmScoresCache = {}; // { trackKey: [{userId, username, score}, ...] }

async function loadRhythmScores(trackKeys) {
    if (!trackKeys || trackKeys.length === 0) { rhythmScoresCache = {}; return; }
    const { data, error } = await db.from('rhythm_scores').select('*').in('track_name', trackKeys);
    if (error) {
        console.error("Ошибка при загрузке рекордов ритм-игры:", error);
        return;
    }
    rhythmScoresCache = {};
    trackKeys.forEach(k => { rhythmScoresCache[k] = []; });
    (data || []).forEach(row => {
        if (!rhythmScoresCache[row.track_name]) rhythmScoresCache[row.track_name] = [];
        rhythmScoresCache[row.track_name].push({ userId: row.user_id, username: row.username, score: row.best_score });
    });
}

function getMyRhythmBest(trackKey) {
    if (!currentUser) return 0;
    const mine = (rhythmScoresCache[trackKey] || []).find(r => r.userId === currentUser.id);
    return mine ? mine.score : 0;
}

// Сохраняет новый рекорд для конкретного трека, только если он реально побит
async function saveRhythmScore(trackKey, score) {
    if (!currentUser) return false;
    const list = rhythmScoresCache[trackKey] || (rhythmScoresCache[trackKey] = []);
    const mine = list.find(r => r.userId === currentUser.id);
    const prevBest = mine ? mine.score : 0;
    if (score <= prevBest) return false;

    const username = getUsernameFromEmail(currentUser.email);
    const { error } = await db.from('rhythm_scores').upsert(
        { user_id: currentUser.id, username, track_name: trackKey, best_score: score, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,track_name' }
    );
    if (error) {
        console.error("Ошибка при сохранении рекорда ритм-игры:", error);
        return false;
    }
    if (mine) mine.score = score;
    else list.push({ userId: currentUser.id, username, score });
    return true;
}

function buildRhythmLeaderboardHtml(trackKey) {
    const rows = (rhythmScoresCache[trackKey] || []).slice().sort((a, b) => b.score - a.score);
    if (rows.length === 0) {
        return `<p class="game-leaderboard-empty">Рекордов пока нет — сыграйте первыми!</p>`;
    }
    return `<div class="leaderboard">` + rows.map((r, i) => `
        <div class="leaderboard-row${i === 0 ? ' leaderboard-leader' : ''}">
            <span class="leaderboard-name">${i === 0 ? '🏆 ' : ''}${r.username}</span>
            <span class="leaderboard-score">${r.score}</span>
        </div>
    `).join('') + `</div>`;
}

// ----------------- Детерминированный "случайный" сид по имени файла -----------------
// Один и тот же трек всегда даёт одну и ту же карту нот — иначе рекорды
// между заходами было бы невозможно сравнивать.
// (hashStringToSeed теперь в core.js — используется также Паутинкой в script.js)
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const RHYTHM_LANES = 4;
// Максимум 4 ступени ускорения: обычный темп, затем 3 разгона после каждого
// полного проигрывания трека (см. advanceSpeedTierAndLoop).
const RHYTHM_SPEED_TIERS = [1.0, 1.15, 1.3, 1.5];
// Первые 2 секунды трека — без нот: время оглядеться и приготовиться,
// вместо того чтобы бить по такту с первой же секунды.
const RHYTHM_START_GAP_SEC = 2.0;

// Строит карту нот прямо по декодированному аудио — простой энергетический
// onset-детектор (ищем резкие всплески громкости относительно локального
// "фона"). Это не полноценный частотный BPM-анализ, как в профессиональных
// чарт-редакторах osu!, но на треках с чётким битом даёт вполне играбельный
// и, что важно, детерминированный результат.
function buildBeatmapFromAudioBuffer(audioBuffer, seedKey) {
    const sampleRate = audioBuffer.sampleRate;
    const numCh = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;

    const channelsData = [];
    for (let c = 0; c < numCh; c++) channelsData.push(audioBuffer.getChannelData(c));
    const mono = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        let sum = 0;
        for (let c = 0; c < numCh; c++) sum += channelsData[c][i];
        mono[i] = sum / numCh;
    }

    const windowSize = Math.max(256, Math.round(sampleRate * 0.04)); // ~40мс
    const hop = Math.max(1, Math.round(windowSize / 2));             // 50% перекрытие
    const numWindows = Math.max(0, Math.floor((length - windowSize) / hop) + 1);

    const energy = new Float32Array(numWindows);
    const times = new Float32Array(numWindows);
    for (let w = 0; w < numWindows; w++) {
        const start = w * hop;
        let sum = 0;
        for (let i = start; i < start + windowSize; i++) sum += mono[i] * mono[i];
        energy[w] = Math.sqrt(sum / windowSize);
        times[w] = (start + windowSize / 2) / sampleRate;
    }

    const flux = new Float32Array(numWindows);
    for (let w = 1; w < numWindows; w++) {
        const d = energy[w] - energy[w - 1];
        flux[w] = d > 0 ? d : 0;
    }

    const secToWindows = (sec) => Math.max(1, Math.round((sec * sampleRate) / hop));
    const localSpan = secToWindows(1.0); // адаптивный порог по последней ~1 сек
    const minGap = secToWindows(0.16);   // ноты не чаще, чем раз в ~160мс

    const rng = mulberry32(hashStringToSeed(seedKey));
    const notes = [];
    let lastPickW = -Infinity;
    let lastLane = -1;
    let sameLaneStreak = 0;

    for (let w = 2; w < numWindows - 1; w++) {
        const from = Math.max(0, w - localSpan);
        let sum = 0;
        for (let k = from; k < w; k++) sum += flux[k];
        const localMean = (w - from) > 0 ? sum / (w - from) : 0;
        const threshold = localMean * 1.6 + 0.002;

        const isPeak = flux[w] > threshold && flux[w] >= flux[w - 1] && flux[w] >= flux[w + 1];
        if (isPeak && times[w] >= RHYTHM_START_GAP_SEC && (w - lastPickW) >= minGap) {
            let lane = Math.floor(rng() * RHYTHM_LANES);
            if (lane === lastLane) {
                sameLaneStreak++;
                if (sameLaneStreak >= 2) {
                    lane = (lane + 1 + Math.floor(rng() * (RHYTHM_LANES - 1))) % RHYTHM_LANES;
                    sameLaneStreak = 0;
                }
            } else {
                sameLaneStreak = 0;
            }
            lastLane = lane;

            notes.push({ time: times[w], lane, hit: false, missed: false });
            lastPickW = w;
        }
    }

    return { duration: audioBuffer.duration, notes };
}

// Экран выбора трека — список подтягивается с GitHub заново при каждом заходе
async function showRhythmMenu() {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);

    app.innerHTML = "";
    let title = document.createElement("h1");
    setEmojiTitle(title, "🎵 Ритм-Аркада");
    app.appendChild(title);

    let container = document.createElement("div");
    container.id = "rhythmMenuContainer";
    container.innerHTML = `<div class="ui-empty">Загружаем рекорды…</div>`;
    app.appendChild(container);

    const tracks = RHYTHM_TRACKS;
    await loadRhythmScores(tracks.map(t => t.key));
    if (!container.isConnected) return;

    container.innerHTML = tracks.map((t, i) => `
        <div class="rhythm-track-card">
            <div class="rhythm-track-card-header">🎧 ${t.label}</div>
            ${buildRhythmLeaderboardHtml(t.key)}
            <button type="button" class="btn-games-green rhythm-play-btn" data-idx="${i}">▶️ Играть</button>
        </div>
    `).join("");

    container.querySelectorAll(".rhythm-play-btn").forEach(btn => {
        btn.onclick = () => {
            const track = tracks[Number(btn.dataset.idx)];
            if (track) startRhythmLevel(track);
        };
    });
}

// Модалка окончания ритм-игры — со своей навигацией (назад к списку треков, не к общим играм)
function showRhythmGameOverModal(score, isRecord, onRestart, onMenu) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "rhythmGameOverModal";
    overlay.innerHTML = buildGameOverHtml(score, isRecord, "rhythmGameOverRestart", "rhythmGameOverMenu", "🎵 К трекам");
    document.body.appendChild(overlay);
    overlay.querySelector("#rhythmGameOverRestart").onclick = () => { overlay.remove(); onRestart(); };
    overlay.querySelector("#rhythmGameOverMenu").onclick = () => { overlay.remove(); onMenu(); };
}

// ------------------------- САМА ИГРА -------------------------
async function startRhythmLevel(track) {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);

    app.innerHTML = "";
    let title = document.createElement("h1");
    setEmojiTitle(title, "🎵 " + track.label);
    title.style.marginBottom = "5px";
    app.appendChild(title);

    let wrap = document.createElement("div");
    wrap.className = "game-wrap rhythm-wrap";
    wrap.innerHTML = `<div class="rhythm-status" id="rhythmStatus">Загружаем трек...</div>`;
    app.appendChild(wrap);

    let audioBuffer, chart, objectUrl;
    try {
        const res = await fetch(track.url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const arrayBuffer = await res.arrayBuffer();
        objectUrl = URL.createObjectURL(new Blob([arrayBuffer.slice(0)], { type: "audio/ogg" }));

        const statusEl = wrap.querySelector("#rhythmStatus");
        if (statusEl) statusEl.textContent = "Анализируем биты...";

        const ctx = getGameAudioCtx();
        audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
        chart = buildBeatmapFromAudioBuffer(audioBuffer, track.key);
    } catch (e) {
        console.error("Ошибка загрузки/анализа трека:", e);
        if (wrap.isConnected) {
            wrap.innerHTML = `<p style="text-align:center;color:#9686b8;">Не удалось загрузить трек 😔<br>Проверьте, что файл лежит в папке rhythm_game.</p>
                <button class="btn-action-cancel" id="rhythmBackErr" style="margin-top:12px;">⬅ Назад</button>`;
            wrap.querySelector("#rhythmBackErr").onclick = () => showRhythmMenu();
        }
        return;
    }
    if (!wrap.isConnected) return; // пока грузили — успели уйти с экрана

    if (!chart.notes.length) {
        wrap.innerHTML = `<p style="text-align:center;color:#9686b8;">Не получилось найти чёткий ритм в этом треке 😕<br>Попробуйте другой трек.</p>
            <button class="btn-action-cancel" id="rhythmBackNoNotes" style="margin-top:12px;">⬅ Назад</button>`;
        wrap.querySelector("#rhythmBackNoNotes").onclick = () => showRhythmMenu();
        return;
    }

    const LANE_KEYS = ["A", "F", "J", "K"];
    wrap.innerHTML = `
        <div class="rhythm-topbar">
            <div class="rhythm-stat">Счёт: <span id="rhythmScore">0</span></div>
            <div class="rhythm-speed-chip" id="rhythmSpeedChip">x1</div>
            <div class="rhythm-stat rhythm-lives" id="rhythmLives"></div>
        </div>
        <div class="rhythm-combo-wrap"><div class="rhythm-combo" id="rhythmCombo"></div></div>
        <div class="rhythm-arena" id="rhythmArena">
            ${LANE_KEYS.map((k, i) => `<div class="rhythm-lane" data-lane="${i}"><div class="rhythm-hitline"></div><div class="rhythm-key-hint">${k}</div></div>`).join("")}
            <div class="rhythm-judgement" id="rhythmJudgement"></div>
            <div class="rhythm-countdown" id="rhythmCountdown"></div>
        </div>
    `;
    // Кликабельного ряда кнопок под ареной нет — игра заточена под телефон, и
    // попадание по ноте происходит тапом прямо по самому тайлу (см. tryHitTile
    // ниже), а не по фиксированной кнопке снизу. LANE_KEYS используется для
    // физической клавиатуры (десктоп, см. keyHandler) — подсказка с буквой
    // (.rhythm-key-hint) в верстке выше показывается только на ПК, см. CSS.

    const arena = wrap.querySelector("#rhythmArena");
    const laneEls = Array.from(wrap.querySelectorAll(".rhythm-lane"));
    const scoreEl = wrap.querySelector("#rhythmScore");
    const comboEl = wrap.querySelector("#rhythmCombo");
    const speedChipEl = wrap.querySelector("#rhythmSpeedChip");
    const livesEl = wrap.querySelector("#rhythmLives");
    const judgementEl = wrap.querySelector("#rhythmJudgement");
    const countdownEl = wrap.querySelector("#rhythmCountdown");

    const audio = new Audio();
    audio.src = objectUrl;
    audio.preload = "auto";

    const LOOKAHEAD = 1.1;      // сек (в шкале трека) — за сколько до удара тайл появляется сверху
    const WINDOW_PERFECT = 0.055;

    // Реальные размеры тайла зависят от ширины дорожки (в CSS задан aspect-ratio
    // 1/3 — длина тайла всегда в 3 раза больше его ширины), поэтому меряем их
    // один раз здесь, через невидимый тайл-зонд, сразу как только арена появилась
    // в вёрстке. От этого зависит: (1) на сколько тайл прячем над ареной перед
    // стартом, (2) сколько px он должен пройти, чтобы к моменту note.time его
    // центр совпал с центром линии удара, (3) насколько широкое окно тайминга
    // дать тапу — чем длиннее тайл (или шире экран), тем дольше он физически
    // находится рядом с линией, и тап по нему должен засчитываться всё это время
    // (иначе с длинными тайлами тапы по их верхней/нижней части не считывались бы).
    const rhythmProbe = document.createElement("div");
    rhythmProbe.className = "rhythm-tile";
    rhythmProbe.style.visibility = "hidden";
    rhythmProbe.style.top = "0px";
    laneEls[0].appendChild(rhythmProbe);
    const TILE_HEIGHT_PX = rhythmProbe.offsetHeight || 46;
    rhythmProbe.remove();

    const rhythmHitline = laneEls[0].querySelector(".rhythm-hitline");
    const rhythmLaneHeight = laneEls[0].clientHeight;
    const TILE_HITLINE_TOP = rhythmHitline ? rhythmHitline.offsetTop : rhythmLaneHeight - 46;
    const TILE_HITLINE_HEIGHT = rhythmHitline ? rhythmHitline.offsetHeight : 3;
    const TILE_TRAVEL_PX = TILE_HITLINE_TOP + TILE_HITLINE_HEIGHT / 2 + TILE_HEIGHT_PX / 2;
    const TILE_SPEED_PX_PER_SEC = TILE_TRAVEL_PX / LOOKAHEAD;

    // Половина времени, которое тайл физически проводит рядом с линией удара
    // (пока хотя бы часть его длины перекрывает линию), плюс небольшой запас —
    // само окно, за пределами которого нота считается пропущенной. Зажато
    // снизу и сверху, чтобы не стать ни слишком жёстким, ни тривиально лёгким.
    const MISS_CUTOFF = Math.min(0.4, Math.max(0.16, (TILE_HEIGHT_PX / 2) / TILE_SPEED_PX_PER_SEC + 0.07));

    // Минимальный зазор по времени между двумя нотами на ОДНОЙ дорожке, при
    // котором их тайлы ещё не наезжают друг на друга визуально — используется
    // при спавне (см. resolveLaneForNote), чтобы разводить слишком тесные
    // ноты по соседним дорожкам вместо наложения.
    const MIN_LANE_GAP_SEC = TILE_HEIGHT_PX / TILE_SPEED_PX_PER_SEC;

    const START_LIVES = 3;

    let score = 0, combo = 0;
    let lives = START_LIVES;
    let tierIndex = 0;
    let gameOver = false;
    let paused = true;
    let rafId = null;
    let activeTiles = []; // { note, el }
    let spawnCursor = 0;

    // --- Плавные игровые часы ---
    // audio.currentTime на многих мобильных браузерах обновляется рывками
    // (не каждый кадр, а раз в ~150-250мс), в то время как позиция тайла на
    // экране тоже считается от него же в loop() — а тап (pointerdown) в
    // tryHitTile прилетает АСИНХРОННО, между кадрами rAF, и в момент тапа
    // audio.currentTime мог быть "устаревшим" на десятки мс относительно
    // того, что игрок реально видел на экране. Именно это ощущалось как
    // "не засчитывает тап по ноте, хотя явно попал" и "приходится тапать
    // дважды". Чтобы у тапа всегда было точное и монотонно растущее время,
    // синхронизируем опорную точку (audio.currentTime + performance.now())
    // на каждом кадре, а между кадрами интерполируем через performance.now()
    // — он всегда точный и не "прыгает" пачками, в отличие от currentTime.
    let clockAnchorAudioTime = 0;
    let clockAnchorPerf = performance.now();
    function syncClock() {
        clockAnchorAudioTime = audio.currentTime;
        clockAnchorPerf = performance.now();
    }
    function getPlaybackTime() {
        if (paused || gameOver) return clockAnchorAudioTime;
        const elapsedSec = (performance.now() - clockAnchorPerf) / 1000;
        return clockAnchorAudioTime + elapsedSec * audio.playbackRate;
    }

    function renderLives() {
        livesEl.textContent = "❤️".repeat(Math.max(0, lives)) + "🖤".repeat(Math.max(0, START_LIVES - lives));
    }
    function renderSpeedChip() {
        const v = RHYTHM_SPEED_TIERS[tierIndex];
        speedChipEl.textContent = "x" + (Number.isInteger(v) ? v.toFixed(0) : v.toString());
    }
    renderLives();
    renderSpeedChip();

    function showJudgement(text, cls) {
        judgementEl.textContent = text;
        judgementEl.className = "rhythm-judgement " + cls;
        void judgementEl.offsetWidth; // форсируем reflow, чтобы анимация перезапускалась при частых попаданиях
        judgementEl.classList.add("rhythm-judgement-anim");
    }
    function popCombo() {
        comboEl.textContent = combo > 0 ? combo + "x" : "";
        comboEl.classList.remove("rhythm-combo-pop");
        void comboEl.offsetWidth;
        comboEl.classList.add("rhythm-combo-pop");
    }
    function resetChartState() {
        chart.notes.forEach(n => { n.hit = false; n.missed = false; });
        activeTiles.forEach(t => t.el.remove());
        activeTiles = [];
        spawnCursor = 0;
    }

    function endGame() {
        if (gameOver) return;
        gameOver = true;
        paused = true;
        cancelAnimationFrame(rafId);
        audio.pause();
        playSound("gameover");
        saveRhythmScore(track.key, score).then(isRecord => {
            showRhythmGameOverModal(score, isRecord, () => startRhythmLevel(track), () => showRhythmMenu());
        });
    }

    function registerMiss(note) {
        if (note.hit || note.missed) return;
        note.missed = true;
        combo = 0;
        popCombo();
        lives--;
        renderLives();
        showJudgement("МИМО", "rhythm-judge-miss");
        if (lives <= 0) endGame();
    }

    // Трек доиграл целиком — небольшая пауза, затем разгон и повтор той же карты нот
    function advanceSpeedTierAndLoop() {
        paused = true;
        cancelAnimationFrame(rafId);
        audio.pause();
        resetChartState();

        if (tierIndex < RHYTHM_SPEED_TIERS.length - 1) tierIndex++;
        renderSpeedChip();

        let count = 2;
        countdownEl.textContent = "🔥 Ускорение! " + count;
        countdownEl.classList.add("rhythm-countdown-show");
        const iv = setInterval(() => {
            count--;
            if (count <= 0) {
                clearInterval(iv);
                countdownEl.classList.remove("rhythm-countdown-show");
                audio.currentTime = 0;
                audio.playbackRate = RHYTHM_SPEED_TIERS[tierIndex];
                audio.play().catch(() => {});
                paused = false;
                syncClock();
                rafId = requestAnimationFrame(loop);
            } else {
                countdownEl.textContent = "🔥 Ускорение! " + count;
            }
        }, 1000);
    }

    // Если на дорожке note.lane уже есть активный (не пойманный/пропущенный)
    // тайл, который выйдет слишком близко по времени — тайлы наложатся друг
    // на друга визуально, и более ранний окажется под более поздним, не
    // ловя тапы. Разводим такую ноту на ближайшую свободную дорожку.
    function resolveLaneForNote(note) {
        const hasConflict = (lane) => activeTiles.some(a =>
            a.note.lane === lane && !a.note.hit && !a.note.missed &&
            Math.abs(a.note.time - note.time) < MIN_LANE_GAP_SEC
        );
        if (!hasConflict(note.lane)) return note.lane;
        for (let offset = 1; offset < RHYTHM_LANES; offset++) {
            const candidate = (note.lane + offset) % RHYTHM_LANES;
            if (!hasConflict(candidate)) return candidate;
        }
        return note.lane; // все дорожки заняты — очень редкий случай, оставляем как есть
    }

    function loop() {
        if (gameOver || paused) return;
        syncClock();
        const t = clockAnchorAudioTime;

        while (spawnCursor < chart.notes.length && chart.notes[spawnCursor].time - t <= LOOKAHEAD) {
            const note = chart.notes[spawnCursor];
            note.lane = resolveLaneForNote(note);
            const el = document.createElement("div");
            el.className = "rhythm-tile";
            el.style.top = (-TILE_HEIGHT_PX) + "px"; // прячем тайл целиком над ареной перед стартом
            // Попадание — прямым тапом/кликом по самому тайлу (мобильная игра,
            // без отдельных кнопок внизу). pointerdown, а не click — заметно
            // меньше задержка на тач-экранах. Тап именно по тайлу — точное
            // попадание "по линии" (больше очков, см. tryHitTile/registerHit).
            el.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                tryHitTile(note, el, true);
            });
            laneEls[note.lane].appendChild(el);
            activeTiles.push({ note, el });
            spawnCursor++;
        }

        for (let i = activeTiles.length - 1; i >= 0; i--) {
            const { note, el } = activeTiles[i];
            const progress = 1 - (note.time - t) / LOOKAHEAD;
            const y = progress * TILE_TRAVEL_PX;
            el.style.transform = `translateY(${y}px)`;

            if (!note.hit && !note.missed && (t - note.time) > MISS_CUTOFF) {
                registerMiss(note);
            }
            if (note.hit || note.missed) {
                el.remove();
                activeTiles.splice(i, 1);
            }
        }

        if (t >= chart.duration - 0.05) {
            chart.notes.forEach(n => registerMiss(n)); // всё, что не успели ударить — в промах
            if (!gameOver) advanceSpeedTierAndLoop();
            return;
        }

        rafId = requestAnimationFrame(loop);
    }

    // Попадание засчитывается двумя способами: тап прямо по тайлу-ноте
    // (onLine=true — точный тап "по линии", вешается на каждый тайл при
    // спавне в loop() выше) и тап в любом другом месте экрана (onLine=false,
    // см. handleAnywhereTap ниже) — тот тоже засчитывается, но приносит
    // меньше очков, чем точное попадание по тайлу.
    function registerHit(note, diff, onLine) {
        note.hit = true;
        combo++;
        const multiplier = Math.min(4, 1 + Math.floor(combo / 10));
        let base, judgeText, judgeCls;
        if (onLine) {
            const isPerfect = diff <= WINDOW_PERFECT;
            base = isPerfect ? 300 : 100;
            judgeText = isPerfect ? "ИДЕАЛЬНО" : "ХОРОШО";
            judgeCls = isPerfect ? "rhythm-judge-perfect" : "rhythm-judge-good";
        } else {
            base = 60;
            judgeText = "ЕСТЬ";
            judgeCls = "rhythm-judge-anywhere";
        }
        score += base * multiplier;
        scoreEl.textContent = score;
        popCombo();
        showJudgement(judgeText, judgeCls);
    }

    function tryHitTile(note, el, onLine) {
        if (gameOver || paused) return;
        if (note.hit || note.missed) return;
        const diff = Math.abs(getPlaybackTime() - note.time);
        if (diff > MISS_CUTOFF) return; // тайл ещё далеко от такта — тап без эффекта

        registerHit(note, diff, onLine);

        // Убираем тайл из общего цикла отрисовки сразу (иначе loop() тут же
        // удалит его как "note.hit" за один кадр), но даём короткому
        // transition (см. CSS .rhythm-tile) доиграть "поп" ровно с той
        // позиции, где тайл был в момент тапа — без прыжка.
        const idx = activeTiles.findIndex(a => a.note === note);
        if (idx !== -1) activeTiles.splice(idx, 1);
        el.classList.add("rhythm-tile-hit");
        el.style.transform = (el.style.transform || "") + " scale(1.4)";
        el.style.opacity = "0";
        setTimeout(() => el.remove(), 180);
    }

    // Ближайшая по времени активная (ещё не пойманная и не пропущенная) нота —
    // среди ВСЕХ дорожек. Используется тапами в любом месте экрана.
    function findNearestActiveNote() {
        const t = getPlaybackTime();
        let best = null, bestDiff = Infinity;
        for (const entry of activeTiles) {
            if (entry.note.hit || entry.note.missed) continue;
            const diff = Math.abs(t - entry.note.time);
            if (diff <= MISS_CUTOFF && diff < bestDiff) { bestDiff = diff; best = entry; }
        }
        return best;
    }

    // Тап в любом месте экрана (не по самому тайлу) — засчитывается по
    // ближайшей активной ноте, чтобы не нужно было точно попадать по тайлу.
    // Срабатывает только если тап не был уже обработан самим тайлом — у его
    // обработчика стоит e.stopPropagation(), так что до сюда он не доходит.
    function handleAnywhereTap() {
        if (gameOver || paused) return;
        const entry = findNearestActiveNote();
        if (!entry) return; // рядом ничего не звучит — тап просто без эффекта
        tryHitTile(entry.note, entry.el, false);
    }
    wrap.addEventListener("pointerdown", handleAnywhereTap);

    // Резервный способ — физическая клавиатура (для тестирования на десктопе).
    // Бьёт по ближайшей по времени ноте в соответствующей дорожке.
    function tryHitLane(lane) {
        if (gameOver || paused) return;
        const t = getPlaybackTime();
        let bestNote = null, bestDiff = Infinity;
        for (const note of chart.notes) {
            if (note.hit || note.missed || note.lane !== lane) continue;
            const diff = Math.abs(t - note.time);
            if (diff <= MISS_CUTOFF && diff < bestDiff) { bestNote = note; bestDiff = diff; }
        }
        if (!bestNote) return; // мимо такта — без штрафа, просто ничего не происходит
        registerHit(bestNote, bestDiff, true);
    }

    function keyHandler(e) {
        const idx = LANE_KEYS.indexOf(e.key.toUpperCase());
        if (idx !== -1) tryHitLane(idx);
    }
    window.addEventListener("keydown", keyHandler);

    showPlayOverlay(arena, () => {
        paused = false;
        audio.playbackRate = RHYTHM_SPEED_TIERS[tierIndex];
        audio.play().catch(() => {});
        syncClock();
        rafId = requestAnimationFrame(loop);
    });

    activeGameCleanup = () => {
        gameOver = true;
        paused = true;
        cancelAnimationFrame(rafId);
        audio.pause();
        window.removeEventListener("keydown", keyHandler);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
}
