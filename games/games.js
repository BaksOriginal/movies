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

// =======================================================
// НЕОНОВЫЙ СТИЛЬ ИГР — общая палитра и приёмы отрисовки
// =======================================================
// Все игры раздела рисуются в одном стиле с сайтом: ночная синтвейв-гамма,
// светящиеся контуры, розово-фиолетово-голубые акценты.
// Свечение сделано БЕЗ ctx.shadowBlur: он пересчитывает размытие на каждом
// кадре и заметно тормозит на телефонах. Вместо этого линия рисуется
// несколько раз — широкой полупрозрачной подложкой и тонкой яркой серединой.
const NEON = {
    void: "#07030f",
    deep: "#12071f",
    violet: "#2a0b3d",
    plum: "#4a1150",
    pink: "#ff2e93",
    pinkSoft: "#ff7fc4",
    purple: "#8b3bff",
    cyan: "#2ee8ff",
    gold: "#ffd15c",
    green: "#39ff9c",
    red: "#ff4d6d",
    text: "#f2e9ff",
};

function neonRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// Обводит ТЕКУЩИЙ путь контекста неоновой линией (путь строится до вызова)
function neonStroke(ctx, color, width = 2) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = width * 5;
    ctx.stroke();
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = width * 2.4;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
}

// Мягкий светящийся ореол вокруг точки
function neonHalo(ctx, x, y, r, color, alpha = 0.45) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, neonRgba(color, alpha));
    g.addColorStop(1, neonRgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

// Детерминированные звёзды (одинаковые на каждом кадре), с мерцанием и параллаксом
function drawNeonStars(ctx, w, h, t, { count = 40, offsetX = 0, offsetY = 0, seed = 7 } = {}) {
    let s = seed;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < count; i++) {
        const bx = rand() * w, by = rand() * h, size = rand() < 0.15 ? 2 : 1;
        const x = ((bx - offsetX) % w + w) % w;
        const y = ((by + offsetY) % h + h) % h;
        ctx.globalAlpha = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2 + i * 1.7));
        ctx.fillStyle = i % 5 === 0 ? NEON.cyan : i % 7 === 0 ? NEON.pinkSoft : "#ffffff";
        ctx.fillRect(x, y, size, size);
    }
    ctx.globalAlpha = 1;
}

// Ночное синтвейв-небо: тёмный верх, малиновое зарево у горизонта
function drawNeonSky(ctx, w, horizonY) {
    const g = ctx.createLinearGradient(0, 0, 0, horizonY);
    g.addColorStop(0, NEON.void);
    g.addColorStop(0.55, NEON.violet);
    g.addColorStop(1, NEON.plum);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, horizonY);
}

// Полосатое "ретро-солнце" на горизонте
function drawNeonSun(ctx, cx, horizonY, r) {
    // зарево — до обрезки, иначе у него виден квадратный край
    neonHalo(ctx, cx, horizonY - r * 0.4, r * 1.8, NEON.pink, 0.35);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - r - 2, horizonY - r - 2, r * 2 + 4, r + 2);
    ctx.clip();
    const g = ctx.createLinearGradient(0, horizonY - r, 0, horizonY);
    g.addColorStop(0, NEON.gold);
    g.addColorStop(1, NEON.pink);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, horizonY, r, Math.PI, 0);
    ctx.fill();
    // горизонтальные прорези, к низу толще
    ctx.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 6; i++) {
        const y = horizonY - r * 0.5 + i * (r * 0.1);
        ctx.fillRect(cx - r, y, r * 2, 1 + i * 0.8);
    }
    ctx.restore();
}

// Силуэт ночного города с огоньками окон (параллакс по scroll)
function drawNeonSkyline(ctx, w, baseY, scroll, { color = NEON.deep, maxH = 60, seed = 3 } = {}) {
    let s = seed;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const blocks = [];
    let x = 0;
    while (x < w + 80) {
        const bw = 16 + rand() * 26, bh = maxH * (0.35 + rand() * 0.65);
        blocks.push({ x, bw, bh, lit: rand() });
        x += bw + 2;
    }
    const total = x;
    ctx.fillStyle = color;
    blocks.forEach(b => {
        const bx = ((b.x - scroll) % total + total) % total - 40;
        ctx.fillRect(bx, baseY - b.bh, b.bw, b.bh);
    });
    blocks.forEach((b, i) => {
        const bx = ((b.x - scroll) % total + total) % total - 40;
        ctx.fillStyle = i % 3 === 0 ? neonRgba(NEON.cyan, 0.55) : neonRgba(NEON.pinkSoft, 0.5);
        for (let wy = baseY - b.bh + 6; wy < baseY - 4; wy += 8) {
            for (let wx = bx + 4; wx < bx + b.bw - 4; wx += 6) {
                if (((wx * 7 + wy * 13 + i) % 5) === 0) ctx.fillRect(wx, wy, 2, 2);
            }
        }
    });
}

// Перспективная неоновая сетка-пол (как в синтвейве), едет вместе со scroll
function drawNeonFloor(ctx, w, topY, bottomY, scroll, color = NEON.pink) {
    const g = ctx.createLinearGradient(0, topY, 0, bottomY);
    g.addColorStop(0, "#1a0626");
    g.addColorStop(1, NEON.void);
    ctx.fillStyle = g;
    ctx.fillRect(0, topY, w, bottomY - topY);

    const h = bottomY - topY;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, topY, w, h);
    ctx.clip();
    ctx.strokeStyle = neonRgba(color, 0.55);
    ctx.lineWidth = 1;
    // поперечные линии: к горизонту гуще, бегут к зрителю
    const phase = (scroll % 40) / 40;
    for (let i = 0; i < 10; i++) {
        const k = (i + phase) / 10;
        const y = topY + h * k * k;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
    }
    // продольные линии сходятся в точку на горизонте
    const vx = w / 2, shift = (scroll * 0.6) % 28;
    for (let x = -w; x <= w * 2; x += 28) {
        ctx.beginPath();
        ctx.moveTo(vx + (x - vx - shift) * 0.15, topY);
        ctx.lineTo(x - shift, bottomY);
        ctx.stroke();
    }
    ctx.restore();
    // светящаяся кромка горизонта
    ctx.beginPath();
    ctx.moveTo(0, topY + 0.5);
    ctx.lineTo(w, topY + 0.5);
    neonStroke(ctx, color, 1.5);
}

// Неоновое сердечко (еда в Змейке и т.п.)
function neonHeartPath(ctx, x, y, s) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.8);
    ctx.bezierCurveTo(x - s * 1.2, y - s * 0.1, x - s * 0.6, y - s, x, y - s * 0.35);
    ctx.bezierCurveTo(x + s * 0.6, y - s, x + s * 1.2, y - s * 0.1, x, y + s * 0.8);
    ctx.closePath();
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
        if (canvas.tagName === "CANVAS") buildArcadeCabinet(canvas, holder);
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

// Аркады стоят в корпусе игрового автомата: вывеска сверху, панель с кнопками снизу.
// Игра автомата определяется по id холста ("snakeCanvas" → snake).
function buildArcadeCabinet(canvas, holder) {
    const wrap = canvas.closest(".game-wrap");
    if (!wrap) return;
    const meta = GAMES_META.find(g => g.id + "Canvas" === canvas.id);
    const cab = document.createElement("div");
    cab.className = "arcade-cab";
    cab.style.setProperty("--h", meta ? meta.hue : 300);
    cab.innerHTML = `<div class="arcade-marquee"></div>`;
    cab.firstChild.textContent = meta ? meta.title : "Аркада";
    holder.parentNode.insertBefore(cab, holder);
    cab.appendChild(holder);
    const deck = document.createElement("div");
    deck.className = "arcade-deck";
    deck.setAttribute("aria-hidden", "true");
    deck.innerHTML = `<i class="arcade-stick"></i><i class="arcade-btn"></i><i class="arcade-btn is-b"></i><i class="arcade-coin"></i>`;
    cab.appendChild(deck);
    wrap.classList.add("is-arcade");
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
    { id: "rhythm", hue: 305, emoji: "🎵", title: "Ритм-Аркада",             desc: "Лови ноты в такт музыке — выбор треков и свои рекорды внутри.",             leaderboard: false, start: () => showRhythmMenu() },
    { id: "sudoku", hue: 190, emoji: "🔢", title: "Судоку",                  desc: "Классическая головоломка 9×9 с тремя уровнями сложности, заметками и подсказками.", leaderboard: false, tileText: () => sudokuTileText(), start: () => showSudokuMenu() },
    { id: "puzzle", hue: 215, emoji: "🧩", title: "Пазл",                    desc: "Собери любой постер с сайта: 24, 54 или 96 деталей. Можно выбрать фильм или довериться случаю.", leaderboard: false, tileText: () => puzzleTileText(), start: () => showPuzzleMenu() }
];

// Экран выбора игры — звёздная карта со всеми играми (см. chart.js).
// Тап по одиночной игре открывает окно с таблицей лидеров и кнопкой
// "Играть" (см. showGameInfoModal), по игре вдвоём — её комнату.
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
    container.appendChild(buildGamesChart());

    // Страницу перезагрузили, пока мы были в комнате игры вдвоём (мобильный
    // браузер так делает после переключения приложений) — возвращаемся туда
    let activeDuoRoom = null;
    try { activeDuoRoom = sessionStorage.getItem(DUO_ACTIVE_ROOM_KEY); } catch (e) {}
    if (activeDuoRoom && DUO_GAMES[activeDuoRoom]) { openDuoRoom(activeDuoRoom); return; }

    // Диплинк на конкретную игру с автозапуском: games/?play=snake
    const params = new URLSearchParams(location.search);
    const play = params.get("play");
    if (play) {
        history.replaceState(null, "", location.pathname);
        const g = GAMES_META.find(x => x.id === play);
        if (g) g.start();
    }
}

// Строка рекордов на точке карты: свой рекорд и лидер
function buildGameTileScore(game) {
    if (!game.leaderboard) return game.tileText ? game.tileText() : "Треки и рекорды внутри";
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
        // Тёмное поле с тонкой светящейся сеткой и мягким свечением по центру
        ctx.fillStyle = NEON.deep;
        ctx.fillRect(0, 0, SIZE, SIZE);
        neonHalo(ctx, SIZE / 2, SIZE / 2, SIZE * 0.75, NEON.purple, 0.18);
        ctx.strokeStyle = neonRgba(NEON.cyan, 0.07);
        ctx.lineWidth = 1;
        for (let i = 1; i < GRID; i++) {
            ctx.beginPath();
            ctx.moveTo(i * CELL + 0.5, 0);
            ctx.lineTo(i * CELL + 0.5, SIZE);
            ctx.moveTo(0, i * CELL + 0.5);
            ctx.lineTo(SIZE, i * CELL + 0.5);
            ctx.stroke();
        }
    }

    function drawFood() {
        // Еда — неоновое сердечко с ореолом
        const cx = food.x * CELL + CELL / 2;
        const cy = food.y * CELL + CELL / 2;
        neonHalo(ctx, cx, cy, CELL * 1.3, NEON.pink, 0.5);
        neonHeartPath(ctx, cx, cy, CELL * 0.42);
        ctx.fillStyle = NEON.pink;
        ctx.fill();
        neonStroke(ctx, NEON.pinkSoft, 1.2);
    }

    function drawSnake() {
        // Тело — светящаяся лента от голубой головы к фиолетовому хвосту
        const n = snake.length;
        const lerp = (a, b, t) => Math.round(a + (b - a) * t);
        for (let i = n - 1; i >= 0; i--) {
            const seg = snake[i];
            const t = n > 1 ? i / (n - 1) : 0;
            const col = `rgb(${lerp(46, 139, t)},${lerp(232, 59, t)},${lerp(255, 255, t)})`;
            const inset = i === 0 ? 1 : 2 + t * 1.5;
            roundedRectPath(seg.x * CELL + inset, seg.y * CELL + inset, CELL - inset * 2, CELL - inset * 2, 5);
            ctx.fillStyle = col;
            ctx.globalAlpha = 0.3;
            ctx.fill();
            ctx.globalAlpha = 1;
            neonStroke(ctx, col, 1.6);
        }

        // Голова: заливка, глаза и язычок по направлению движения
        const head = snake[0];
        const hx = head.x * CELL + CELL / 2;
        const hy = head.y * CELL + CELL / 2;
        neonHalo(ctx, hx, hy, CELL * 1.2, NEON.cyan, 0.35);
        roundedRectPath(head.x * CELL + 1, head.y * CELL + 1, CELL - 2, CELL - 2, 6);
        ctx.fillStyle = NEON.cyan;
        ctx.fill();

        const ex = dir.y !== 0 ? CELL * 0.22 : 0;
        const ey = dir.x !== 0 ? CELL * 0.22 : 0;
        ctx.fillStyle = NEON.void;
        ctx.beginPath();
        ctx.arc(hx - ex + dir.x * 3, hy - ey + dir.y * 3, 2.1, 0, Math.PI * 2);
        ctx.arc(hx + ex + dir.x * 3, hy + ey + dir.y * 3, 2.1, 0, Math.PI * 2);
        ctx.fill();

        const tipX = hx + dir.x * (CELL / 2 + 5);
        const tipY = hy + dir.y * (CELL / 2 + 5);
        ctx.beginPath();
        ctx.moveTo(hx + dir.x * (CELL / 2), hy + dir.y * (CELL / 2));
        ctx.lineTo(tipX, tipY);
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX + dir.y * 2.5, tipY + dir.x * 2.5);
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - dir.y * 2.5, tipY - dir.x * 2.5);
        neonStroke(ctx, NEON.pink, 1.2);
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
    // ---- Ночной синтвейв-город: звёзды, ретро-солнце, огни небоскрёбов ----
    function drawSky() {
        const horizon = H - GROUND_H;
        drawNeonSky(ctx, W, horizon);
        drawNeonStars(ctx, W, horizon * 0.7, bgOffset / 60, { count: 34, offsetX: bgOffset * 0.05 });
        drawNeonSun(ctx, W * 0.66, horizon - 22, 54);
        drawNeonSkyline(ctx, W, horizon, bgOffset * 0.25, { color: "#1c0a2c", maxH: 80, seed: 11 });
        drawNeonSkyline(ctx, W, horizon, bgOffset * 0.5, { color: NEON.void, maxH: 46, seed: 5 });
    }


    // ---- Шоколадные батончики вместо труб ----
    // ---- Шоколадки вместо труб: тёмный шоколад в неоновой обводке ----
    function drawChocolateBar(x, y, w, h, edge) {
        if (h <= 0) return;
        const grad = ctx.createLinearGradient(x, 0, x + w, 0);
        grad.addColorStop(0, "#2a1320");
        grad.addColorStop(0.5, "#4a2335");
        grad.addColorStop(1, "#2a1320");
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);

        // дольки
        ctx.strokeStyle = neonRgba(NEON.pinkSoft, 0.22);
        ctx.lineWidth = 1.5;
        for (let gy = 22; gy < h; gy += 22) {
            ctx.beginPath();
            ctx.moveTo(x + 4, y + (edge === "bottom" ? h - gy : gy));
            ctx.lineTo(x + w - 4, y + (edge === "bottom" ? h - gy : gy));
            ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w / 2, y + h);
        ctx.stroke();

        // контур с "отломанным" зубчатым краем со стороны просвета
        const teeth = 6, amp = 5;
        ctx.beginPath();
        if (edge === "bottom") {
            ctx.moveTo(x, y);
            ctx.lineTo(x, y + h);
            for (let i = 0; i <= teeth; i++) ctx.lineTo(x + (w / teeth) * i, y + h - (i % 2 === 0 ? 0 : amp));
            ctx.lineTo(x + w, y);
        } else {
            ctx.moveTo(x, y + h);
            ctx.lineTo(x, y);
            for (let i = 0; i <= teeth; i++) ctx.lineTo(x + (w / teeth) * i, y + (i % 2 === 0 ? 0 : amp));
            ctx.lineTo(x + w, y + h);
        }
        neonStroke(ctx, NEON.pink, 1.6);
    }

    // ---- Цветочное поле вместо земли ----
    // ---- Неоновая сетка-пол вместо земли ----
    function drawFlowerField() {
        drawNeonFloor(ctx, W, H - GROUND_H, H, bgOffset, NEON.pink);
    }

    function draw() {
        drawSky();

        pipes.forEach(p => {
            drawChocolateBar(p.x, 0, PIPE_W, p.gapY, "bottom");
            drawChocolateBar(p.x, p.gapY + GAP, PIPE_W, H - GROUND_H - (p.gapY + GAP), "top");
        });

        drawFlowerField();

        // Птичка — голова с фотографии профиля, с неоновым ореолом
        neonHalo(ctx, 50, birdY, 34, NEON.pink, 0.35);
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
    // ---- Персонаж: неоновый инопланетянин ----
    function drawDoodler() {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(facing, 1);
        neonHalo(ctx, 0, 0, DOODLER_W, NEON.pink, 0.3);

        // усики с огоньками
        ctx.beginPath();
        ctx.moveTo(-6, -DOODLER_H / 2 + 2);
        ctx.lineTo(-10, -DOODLER_H / 2 - 9);
        ctx.moveTo(6, -DOODLER_H / 2 + 2);
        ctx.lineTo(10, -DOODLER_H / 2 - 9);
        neonStroke(ctx, NEON.pinkSoft, 1.4);
        ctx.fillStyle = NEON.cyan;
        ctx.beginPath();
        ctx.arc(-10, -DOODLER_H / 2 - 9, 2.6, 0, Math.PI * 2);
        ctx.arc(10, -DOODLER_H / 2 - 9, 2.6, 0, Math.PI * 2);
        ctx.fill();

        // ножки
        ctx.fillStyle = NEON.pink;
        ctx.beginPath();
        ctx.ellipse(-8, DOODLER_H / 2 - 2, 6, 3.5, 0, 0, Math.PI * 2);
        ctx.ellipse(8, DOODLER_H / 2 - 2, 6, 3.5, 0, 0, Math.PI * 2);
        ctx.fill();

        // тело
        ctx.beginPath();
        ctx.ellipse(0, 0, DOODLER_W / 2, DOODLER_H / 2, 0, 0, Math.PI * 2);
        const body = ctx.createLinearGradient(0, -DOODLER_H / 2, 0, DOODLER_H / 2);
        body.addColorStop(0, "#3a1250");
        body.addColorStop(1, "#1a0828");
        ctx.fillStyle = body;
        ctx.fill();
        neonStroke(ctx, NEON.pink, 1.8);

        // глаза-визор
        ctx.fillStyle = NEON.text;
        ctx.beginPath();
        ctx.arc(6, -4, 5.5, 0, Math.PI * 2);
        ctx.arc(-4, -6, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = NEON.cyan;
        ctx.beginPath();
        ctx.arc(8, -4, 2.6, 0, Math.PI * 2);
        ctx.arc(-3, -6, 2.2, 0, Math.PI * 2);
        ctx.fill();

        // улыбка
        ctx.beginPath();
        ctx.arc(2, 4, 5, 0.15 * Math.PI, 0.75 * Math.PI);
        neonStroke(ctx, NEON.pinkSoft, 1.2);

        ctx.restore();
    }

    // ---- Платформы — неоновые трубки (двигающиеся — розовые) ----
    function drawPlatform(p) {
        const color = p.moving ? NEON.pink : NEON.cyan;
        roundedRect(p.x, p.y, p.w, p.h, 6);
        ctx.fillStyle = neonRgba(color, 0.14);
        ctx.fill();
        neonStroke(ctx, color, 1.8);
        ctx.fillStyle = neonRgba("#ffffff", 0.55);
        ctx.fillRect(p.x + 8, p.y + 3, p.w - 16, 1.5);
    }

    function drawBackground() {
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, NEON.void);
        grad.addColorStop(1, NEON.violet);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // две "орбиты" звёзд с разной скоростью — ощущение подъёма в космос
        drawNeonStars(ctx, W, H, scrollTotal / 300, { count: 30, offsetY: scrollTotal * 0.08, seed: 13 });
        drawNeonStars(ctx, W, H, scrollTotal / 200, { count: 18, offsetY: scrollTotal * 0.2, seed: 29 });

        // тонкие вертикальные линии сетки
        ctx.strokeStyle = neonRgba(NEON.purple, 0.12);
        ctx.lineWidth = 1;
        for (let gx = 30; gx < W; gx += 60) {
            ctx.beginPath();
            ctx.moveTo(gx + 0.5, 0);
            ctx.lineTo(gx + 0.5, H);
            ctx.stroke();
        }
    }

    function drawMonster(m) {
        ctx.save();
        ctx.translate(m.x, m.y);
        if (m.type === 'bat') {
            const flap = Math.sin(m.phase * 10) * 6;
            neonHalo(ctx, 0, 0, 28, NEON.purple, 0.35);
            ctx.fillStyle = "#1a0828";
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.quadraticCurveTo(-18, -6 - flap, -22, 4);
            ctx.quadraticCurveTo(-10, 2, 0, 0);
            ctx.moveTo(0, 0);
            ctx.quadraticCurveTo(18, -6 - flap, 22, 4);
            ctx.quadraticCurveTo(10, 2, 0, 0);
            ctx.fill();
            neonStroke(ctx, NEON.purple, 1.4);
            ctx.beginPath();
            ctx.ellipse(0, 0, 10, 8, 0, 0, Math.PI * 2);
            ctx.fill();
            neonStroke(ctx, NEON.purple, 1.4);
            ctx.fillStyle = NEON.red;
            ctx.beginPath();
            ctx.arc(-3, -1, 1.8, 0, Math.PI * 2);
            ctx.arc(3, -1, 1.8, 0, Math.PI * 2);
            ctx.fill();
        } else if (m.type === 'ghost') {
            neonHalo(ctx, 0, 0, 26, NEON.cyan, 0.3);
            ctx.beginPath();
            ctx.arc(0, -2, 13, Math.PI, 0, false);
            ctx.lineTo(13, 10);
            ctx.lineTo(8, 4);
            ctx.lineTo(3, 10);
            ctx.lineTo(-3, 4);
            ctx.lineTo(-8, 10);
            ctx.lineTo(-13, 4);
            ctx.closePath();
            ctx.fillStyle = neonRgba(NEON.cyan, 0.18);
            ctx.fill();
            neonStroke(ctx, NEON.cyan, 1.5);
            ctx.fillStyle = NEON.text;
            ctx.beginPath();
            ctx.arc(-5, -3, 2.2, 0, Math.PI * 2);
            ctx.arc(5, -3, 2.2, 0, Math.PI * 2);
            ctx.fill();
        } else {
            neonHalo(ctx, 0, 0, 26, NEON.gold, 0.35);
            ctx.rotate(m.phase * 2);
            ctx.beginPath();
            for (let i = 0; i < 8; i++) {
                const ang = (Math.PI / 4) * i;
                ctx.moveTo(Math.cos(ang) * 9, Math.sin(ang) * 9);
                ctx.lineTo(Math.cos(ang) * 15, Math.sin(ang) * 15);
            }
            neonStroke(ctx, NEON.gold, 2);
            ctx.beginPath();
            ctx.arc(0, 0, 9, 0, Math.PI * 2);
            ctx.fillStyle = "#3a1230";
            ctx.fill();
            neonStroke(ctx, NEON.red, 1.6);
            ctx.fillStyle = NEON.gold;
            ctx.beginPath();
            ctx.arc(-3, -1, 1.7, 0, Math.PI * 2);
            ctx.arc(3, -1, 1.7, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function drawPowerup(pu) {
        ctx.save();
        ctx.translate(pu.x, pu.y);
        if (pu.type === 'armor') {
            neonHalo(ctx, 0, 0, 24, NEON.cyan, 0.4);
            ctx.beginPath();
            ctx.moveTo(0, -10);
            ctx.lineTo(9, -6);
            ctx.lineTo(9, 3);
            ctx.quadraticCurveTo(9, 10, 0, 13);
            ctx.quadraticCurveTo(-9, 10, -9, 3);
            ctx.lineTo(-9, -6);
            ctx.closePath();
            ctx.fillStyle = neonRgba(NEON.cyan, 0.2);
            ctx.fill();
            neonStroke(ctx, NEON.cyan, 1.6);
            ctx.beginPath();
            ctx.moveTo(-4, 1);
            ctx.lineTo(-1, 4);
            ctx.lineTo(5, -3);
            neonStroke(ctx, NEON.text, 1.4);
        } else {
            neonHalo(ctx, 0, 0, 24, NEON.pink, 0.4);
            ctx.beginPath();
            ctx.moveTo(0, -13);
            ctx.quadraticCurveTo(7, -2, 6, 8);
            ctx.lineTo(-6, 8);
            ctx.quadraticCurveTo(-7, -2, 0, -13);
            ctx.closePath();
            ctx.fillStyle = "#3a1230";
            ctx.fill();
            neonStroke(ctx, NEON.pink, 1.6);
            ctx.beginPath();
            ctx.moveTo(-6, 8);
            ctx.lineTo(-9, 13);
            ctx.lineTo(-3, 9);
            ctx.moveTo(6, 8);
            ctx.lineTo(9, 13);
            ctx.lineTo(3, 9);
            neonStroke(ctx, NEON.gold, 1.4);
            ctx.fillStyle = NEON.cyan;
            ctx.beginPath();
            ctx.arc(0, -1, 2.8, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function drawBullet(b) {
        ctx.save();
        roundedRect(b.x - 2.5, b.y - 8, 5, 14, 2.5);
        ctx.fillStyle = NEON.text;
        ctx.fill();
        neonStroke(ctx, NEON.cyan, 1.4);
        ctx.restore();
    }

    // Щит брони моргает перед истечением — отдельного таймера на экране нет,
    // сам щит и есть индикатор
    // Щит брони моргает перед истечением — отдельного таймера на экране нет,
    // сам щит и есть индикатор
    function drawArmorShield() {
        const blinking = armorTimer < ARMOR_BLINK_AT;
        const visible = !blinking || (Math.floor(armorTimer * 8) % 2 === 0);
        if (!visible) return;
        ctx.save();
        ctx.translate(x, y);
        ctx.beginPath();
        ctx.arc(0, 0, DOODLER_W / 2 + 8, 0, Math.PI * 2);
        ctx.fillStyle = neonRgba(NEON.cyan, 0.1);
        ctx.fill();
        neonStroke(ctx, NEON.cyan, 1.8);
        ctx.restore();
    }

    function drawRocketFlame() {
        ctx.save();
        ctx.translate(x, y + DOODLER_H / 2);
        const flicker = 8 + Math.random() * 6;
        neonHalo(ctx, 0, flicker / 2 + 6, 22, NEON.pink, 0.45);
        ctx.fillStyle = NEON.pink;
        ctx.beginPath();
        ctx.moveTo(-6, 0);
        ctx.lineTo(6, 0);
        ctx.lineTo(0, flicker + 10);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = NEON.gold;
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
        ctx.beginPath();
        ctx.arc(0, 0, DOODLER_W / 2 + 6, 0, Math.PI * 2);
        neonStroke(ctx, NEON.gold, 1.6);
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
    // ---- Ночной синтвейв: ретро-солнце, звёзды, огни города на горизонте ----
    function drawSky() {
        drawNeonSky(ctx, W, GROUND_Y);
        drawNeonStars(ctx, W, GROUND_Y * 0.6, animT, { count: 22, offsetX: bgOffset * 0.05, seed: 17 });
        drawNeonSun(ctx, W - 70, GROUND_Y, 38);
        drawNeonSkyline(ctx, W, GROUND_Y, bgOffset * 0.3, { color: "#1c0a2c", maxH: 34, seed: 21 });
    }

    // ---- Дорожка-земля со скроллящейся текстурой ----
    // ---- Неоновая сетка-дорога ----
    function drawGround() {
        drawNeonFloor(ctx, W, GROUND_Y, H, bgOffset, NEON.cyan);
    }

    // ---- Брокколи-препятствие ----
    // ---- Брокколи-препятствие в неоновом контуре ----
    function drawBroccoli(o) {
        const cx = o.x + o.w / 2;
        const stemW = o.w * 0.34;
        neonHalo(ctx, cx, GROUND_Y - o.h / 2, o.h, NEON.green, 0.25);
        ctx.beginPath();
        ctx.rect(cx - stemW / 2, GROUND_Y - o.h * 0.4, stemW, o.h * 0.4);
        ctx.fillStyle = "#0d2a1c";
        ctx.fill();
        neonStroke(ctx, NEON.green, 1.2);

        const florR = o.w * 0.32;
        const centers = [
            [cx, GROUND_Y - o.h + florR * 0.9],
            [cx - o.w * 0.28, GROUND_Y - o.h + florR * 1.3],
            [cx + o.w * 0.28, GROUND_Y - o.h + florR * 1.3],
            [cx - o.w * 0.12, GROUND_Y - o.h + florR * 0.3],
            [cx + o.w * 0.12, GROUND_Y - o.h + florR * 0.3]
        ];
        ctx.beginPath();
        centers.forEach(c => {
            ctx.moveTo(c[0] + florR, c[1]);
            ctx.arc(c[0], c[1], florR, 0, Math.PI * 2);
        });
        ctx.fillStyle = "#0d2a1c";
        ctx.fill();
        neonStroke(ctx, NEON.green, 1.4);
    }

    // ---- Летучая мышь-препятствие ----
    // ---- Летучая мышь-препятствие ----
    function drawBat(o) {
        const cx = o.x + o.w / 2, cy = o.top + o.h / 2;
        const flap = Math.sin(animT * 11 + o.phase) * 7;
        neonHalo(ctx, cx, cy, 26, NEON.purple, 0.35);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.fillStyle = "#1a0828";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(-16, -6 - flap, -20, 3);
        ctx.quadraticCurveTo(-9, 1, 0, 0);
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(16, -6 - flap, 20, 3);
        ctx.quadraticCurveTo(9, 1, 0, 0);
        ctx.fill();
        neonStroke(ctx, NEON.purple, 1.3);
        ctx.beginPath();
        ctx.ellipse(0, 0, 9, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        neonStroke(ctx, NEON.purple, 1.3);
        ctx.fillStyle = NEON.red;
        ctx.beginPath();
        ctx.arc(-3, -1, 1.6, 0, Math.PI * 2);
        ctx.arc(3, -1, 1.6, 0, Math.PI * 2);
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
        // вместо пыли — неоновые искры из-под ног
        dustParticles.forEach((p, i) => {
            const a = 1 - p.age / 0.5;
            ctx.fillStyle = neonRgba(i % 2 ? NEON.pink : NEON.cyan, a * 0.8);
            ctx.fillRect(p.x, p.y - p.age * 14, 2 + p.age * 3, 2 + p.age * 3);
        });
    }

    // ---- Герой — фото персонажа в беге/прыжке/приседе ----
    function drawChar() {
        const box = currentCharBox();
        const w = box.w, h = box.bottom - box.top;
        const cx = CHAR_X, cy = box.bottom;
        ctx.save();
        // неоновое пятно-тень под ногами
        ctx.save();
        ctx.translate(cx, GROUND_Y);
        ctx.scale(1, 0.3);
        neonHalo(ctx, 0, 0, w * 0.7, NEON.pink, 0.45);
        ctx.restore();
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
                    spawnParticles(o.x, o.y, NEON.red);
                    endGame();
                } else {
                    playSound("slice");
                    score++;
                    scoreEl.textContent = String(score);
                    spawnParticles(o.x, o.y, NEON.pinkSoft);
                }
            }
        });
    }

    function draw() {
        // Фон — ночное небо с неоновым горизонтом внизу
        const t = performance.now() / 1000;
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, NEON.void);
        grad.addColorStop(0.7, NEON.violet);
        grad.addColorStop(1, NEON.plum);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
        drawNeonStars(ctx, W, H * 0.8, t, { count: 40, seed: 41 });
        drawNeonFloor(ctx, W, H - 70, H, t * 60, NEON.purple);

        // След от пальца/мыши — неоновый "клинок" от голубого к розовому
        if (trail.length > 1) {
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            for (let i = 1; i < trail.length; i++) {
                const p0 = trail[i - 1], p1 = trail[i];
                const alpha = i / trail.length;
                const color = alpha > 0.6 ? NEON.pinkSoft : NEON.cyan;
                ctx.beginPath();
                ctx.moveTo(p0.x, p0.y);
                ctx.lineTo(p1.x, p1.y);
                ctx.globalAlpha = alpha;
                neonStroke(ctx, color, 2.2 * alpha + 0.8);
                ctx.globalAlpha = 1;
            }
        }

        // Эмодзи-объекты
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `${FONT_SIZE}px sans-serif`;
        objects.forEach(o => {
            if (o.sliced) return;
            neonHalo(ctx, o.x, o.y, OBJ_R * 1.8, o.emoji === BOMB_EMOJI ? NEON.red : NEON.pink, 0.4);
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

// ------------------------- САМА ИГРА: НЕОНОВЫЕ ПЛИТКИ -------------------------
// Жанр "плиток под музыку": по четырём дорожкам падают высокие неоновые
// плитки — каждую нужно нажать самому, когда она подходит к линии внизу.
// Длинные плитки нужно не просто нажать, а удерживать до конца.
// Тап по пустому месту дорожки и пропущенная плитка стоят жизни.
// Ноты те же, что строит buildBeatmapFromAudioBuffer (по битам самого трека);
// здесь они раскладываются по дорожкам так, чтобы плитки не наезжали друг на
// друга, и часть одиночных нот на длинных паузах становится "удержанием".
// Отрисовка — один canvas, без DOM-элементов на каждую плитку.

const RT_LANE_COLORS = [NEON.pink, NEON.purple, NEON.cyan, NEON.pinkSoft];
const RT_KEYS = ["D", "F", "J", "K"];
const RT_LOOKAHEAD = 1.25;   // сек трека от появления плитки сверху до линии
const RT_LINE_RATIO = 0.84;  // линия удара — на этой доле высоты арены
const RT_TILE_RATIO = 0.17;  // высота обычной плитки — доля высоты арены
const RT_WINDOW = { perfect: 0.06, great: 0.12, late: 0.2, early: 0.45 };

// Раскладывает ноты по дорожкам и превращает часть нот в длинные (удержание)
function layoutRhythmTiles(notes, seedKey) {
    const rng = mulberry32(hashStringToSeed(seedKey + ":tiles"));
    const tileTime = RT_LOOKAHEAD * RT_TILE_RATIO / RT_LINE_RATIO; // сколько секунд занимает плитка
    const laneFreeAt = [0, 0, 0, 0];
    const out = [];
    let prevLane = -1;
    let lastTime = -Infinity;
    // Биты, идущие чаще чем раз в ~0,22 с, пальцами на телефоне уже не
    // успеть — оставляем первую ноту из такой "дроби"
    const playable = notes.filter(n => {
        if (n.time - lastTime < 0.22) return false;
        lastTime = n.time;
        return true;
    });
    playable.forEach((n, i) => {
        const next = playable[i + 1];
        const gap = next ? next.time - n.time : 1;
        const hold = gap >= 0.5 && rng() < 0.6 ? Math.min(1.4, gap - 0.28) : 0;
        // свободные дорожки, не повторяя предыдущую, — "лесенка" как у пианино
        const free = [0, 1, 2, 3].filter(l => laneFreeAt[l] <= n.time - 0.02 && l !== prevLane);
        if (!free.length) return; // плитке негде упасть — пропускаем ноту, чем рисовать наложение
        const lane = free[Math.floor(rng() * free.length)];
        laneFreeAt[lane] = n.time + hold + tileTime + 0.04;
        prevLane = lane;
        out.push({ time: n.time, end: n.time + hold, hold: hold > 0, lane, hit: false, missed: false, holding: false, done: false, judge: null, flash: 0 });
    });
    return out;
}

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

        const ctxAudio = getGameAudioCtx();
        audioBuffer = await ctxAudio.decodeAudioData(arrayBuffer.slice(0));
        chart = buildBeatmapFromAudioBuffer(audioBuffer, track.key);
    } catch (e) {
        console.error("Ошибка загрузки/анализа трека:", e);
        if (wrap.isConnected) {
            wrap.innerHTML = `<div class="ui-empty">Не удалось загрузить трек 😔</div>
                <button type="button" class="ui-btn ui-pill" id="rhythmBackErr">⬅ К трекам</button>`;
            wrap.querySelector("#rhythmBackErr").onclick = () => showRhythmMenu();
        }
        return;
    }
    if (!wrap.isConnected) return; // пока грузили — успели уйти с экрана

    const tiles = layoutRhythmTiles(chart.notes, track.key);
    if (!tiles.length) {
        wrap.innerHTML = `<div class="ui-empty">Не получилось найти чёткий ритм в этом треке 😕</div>
            <button type="button" class="ui-btn ui-pill" id="rhythmBackNoNotes">⬅ К трекам</button>`;
        wrap.querySelector("#rhythmBackNoNotes").onclick = () => showRhythmMenu();
        return;
    }

    wrap.innerHTML = `
        <div class="rt-hud">
            <div class="rt-progress"><div class="rt-progress-fill" id="rtProgress"></div>
                <span class="rt-star" style="left:33%">♥</span><span class="rt-star" style="left:66%">♥</span><span class="rt-star" style="left:99%">♥</span>
            </div>
            <div class="rt-hud-row">
                <span class="rt-lives" id="rtLives"></span>
                <span class="rt-score" id="rtScore">0</span>
                <span class="rt-speed" id="rtSpeed">x1</span>
            </div>
        </div>
        <div class="rhythm-arena rt-arena" id="rhythmArena">
            <canvas class="rt-canvas" id="rtCanvas"></canvas>
            <div class="rhythm-countdown" id="rhythmCountdown"></div>
        </div>
        <div class="rt-keys">${RT_KEYS.map(k => `<span>${k}</span>`).join("")}</div>
    `;

    const arena = wrap.querySelector("#rhythmArena");
    const canvas = wrap.querySelector("#rtCanvas");
    const ctx = canvas.getContext("2d");
    const scoreEl = wrap.querySelector("#rtScore");
    const livesEl = wrap.querySelector("#rtLives");
    const speedEl = wrap.querySelector("#rtSpeed");
    const progressEl = wrap.querySelector("#rtProgress");
    const starEls = Array.from(wrap.querySelectorAll(".rt-star"));
    const countdownEl = wrap.querySelector("#rhythmCountdown");

    const audio = new Audio();
    audio.src = objectUrl;
    audio.preload = "auto";

    // ---- Размеры арены (canvas подстраивается под CSS-размер и плотность экрана) ----
    let W = 0, H = 0, lineY = 0, tileH = 0, laneW = 0, pxPerSec = 0;
    function resize() {
        const rect = arena.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        W = rect.width;
        H = rect.height;
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lineY = H * RT_LINE_RATIO;
        tileH = H * RT_TILE_RATIO;
        laneW = W / 4;
        pxPerSec = lineY / RT_LOOKAHEAD;
    }
    resize();
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => {
        resize();
        if (paused) draw(getPlaybackTime());
    }));
    resizeObserver.observe(arena);

    const START_LIVES = 3;
    let score = 0, combo = 0, lives = START_LIVES, tierIndex = 0;
    let gameOver = false, paused = true, rafId = null;
    const lanePress = [0, 0, 0, 0];      // подсветка нажатой дорожки (затухает)
    const laneError = [0, 0, 0, 0];      // красная вспышка ошибки
    const holdsByPointer = new Map();    // pointerId/клавиша -> длинная плитка, которую держат
    let effects = [];                    // кольца и искры от попаданий
    let judgement = null;                // { text, color, age }
    let shake = 0;

    // ---- Часы трека: audio.currentTime обновляется рывками, поэтому между
    // его обновлениями время досчитывается по performance.now() ----
    let clockAnchorAudioTime = 0;
    let clockAnchorPerf = performance.now();
    function syncClock() {
        clockAnchorAudioTime = audio.currentTime;
        clockAnchorPerf = performance.now();
    }
    function getPlaybackTime() {
        if (paused || gameOver) return clockAnchorAudioTime;
        return clockAnchorAudioTime + (performance.now() - clockAnchorPerf) / 1000 * audio.playbackRate;
    }

    function renderHud() {
        livesEl.textContent = "❤️".repeat(Math.max(0, lives)) + "🖤".repeat(Math.max(0, START_LIVES - lives));
        const v = RHYTHM_SPEED_TIERS[tierIndex];
        speedEl.textContent = "x" + (Number.isInteger(v) ? v.toFixed(0) : v);
        scoreEl.textContent = score;
    }
    renderHud();

    function showJudgement(text, color) {
        judgement = { text, color, age: 0 };
    }

    function spawnBurst(lane, color) {
        const cx = lane * laneW + laneW / 2;
        effects.push({ type: "ring", x: cx, y: lineY, age: 0, color });
        for (let i = 0; i < 10; i++) {
            const a = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 160;
            effects.push({ type: "spark", x: cx, y: lineY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, age: 0, color });
        }
    }

    // ---- Подсчёт очков: точность + множитель за серию (как и раньше, до x4) ----
    function addScore(base) {
        const multiplier = Math.min(4, 1 + Math.floor(combo / 10));
        score += base * multiplier;
        scoreEl.textContent = score;
    }

    function loseLife(lane, text) {
        combo = 0;
        lives--;
        laneError[lane] = 1;
        shake = 1;
        vibrate(60);
        showJudgement(text, NEON.red);
        renderHud();
        if (lives <= 0) endGame();
    }

    function hitTile(tile, diff, key) {
        tile.hit = true;
        tile.flash = 1;
        combo++;
        let base, text, color;
        if (diff <= RT_WINDOW.perfect) { base = 300; text = "ИДЕАЛЬНО"; color = NEON.gold; }
        else if (diff <= RT_WINDOW.great) { base = 200; text = "ОТЛИЧНО"; color = NEON.cyan; }
        else { base = 100; text = "ХОРОШО"; color = NEON.pinkSoft; }
        tile.judge = color;
        addScore(base);
        showJudgement(text, color);
        spawnBurst(tile.lane, color);
        vibrate(8);
        if (tile.hold) {
            tile.holding = true;
            holdsByPointer.set(key, tile);
        } else {
            tile.done = true;
        }
    }

    // Длинная плитка: бонус за удержание пропорционален тому, сколько продержали
    function releaseHold(key) {
        const tile = holdsByPointer.get(key);
        if (!tile) return;
        holdsByPointer.delete(key);
        if (tile.done) return;
        tile.holding = false;
        tile.done = true;
        const t = getPlaybackTime();
        const part = Math.max(0, Math.min(1, (t - tile.time) / Math.max(0.01, tile.end - tile.time)));
        addScore(Math.round(200 * part));
        if (part >= 0.9) {
            showJudgement("УДЕРЖАНО", NEON.gold);
            spawnBurst(tile.lane, NEON.gold);
        }
    }

    // Нажатие на дорожку. y — где именно нажали (для тапа пальцем/мышью):
    // если палец прямо на плитке, она засчитывается даже рано, как в жанре
    // принято; иначе — ближайшая по времени плитка дорожки в окне точности.
    function pressLane(lane, key, y = null) {
        if (gameOver || paused) return;
        lanePress[lane] = 1;
        const t = getPlaybackTime();
        let best = null, bestDiff = Infinity;
        for (const tile of tiles) {
            if (tile.lane !== lane || tile.hit || tile.missed) continue;
            const dt = tile.time - t; // >0 — плитка ещё не дошла до линии
            if (dt > RT_LOOKAHEAD) break;
            const bottom = lineY - dt * pxPerSec;
            const top = bottom - tileH - (tile.end - tile.time) * pxPerSec;
            const underFinger = y !== null && y >= top - 12 && y <= bottom + 12;
            const inWindow = dt <= RT_WINDOW.early && dt >= -RT_WINDOW.late;
            if ((underFinger || inWindow) && Math.abs(dt) < bestDiff) {
                best = tile;
                bestDiff = Math.abs(dt);
            }
        }
        if (best) hitTile(best, bestDiff, key);
        else loseLife(lane, "МИМО");
    }

    // ---- Ввод: мультитач по дорожкам и клавиши D F J K ----
    function laneFromEvent(e) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        return { lane: Math.max(0, Math.min(3, Math.floor(x / (rect.width / 4)))), y: e.clientY - rect.top };
    }
    function onPointerDown(e) {
        e.preventDefault();
        const { lane, y } = laneFromEvent(e);
        pressLane(lane, "p" + e.pointerId, y);
    }
    function onPointerUp(e) {
        releaseHold("p" + e.pointerId);
    }
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    const keysDown = new Set();
    function keyDown(e) {
        const lane = RT_KEYS.indexOf(e.key.toUpperCase());
        if (lane === -1 || keysDown.has(lane)) return;
        keysDown.add(lane);
        pressLane(lane, "k" + lane);
    }
    function keyUp(e) {
        const lane = RT_KEYS.indexOf(e.key.toUpperCase());
        if (lane === -1) return;
        keysDown.delete(lane);
        releaseHold("k" + lane);
    }
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);

    // ---- Отрисовка ----
    function tileRect(tile, t) {
        const bottom = lineY - (tile.time - t) * pxPerSec;
        const height = tileH + (tile.end - tile.time) * pxPerSec;
        return { x: tile.lane * laneW + 4, y: bottom - height, w: laneW - 8, h: height, bottom };
    }

    function roundRect(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function drawTile(tile, t) {
        const r = tileRect(tile, t);
        const color = tile.missed ? NEON.red : RT_LANE_COLORS[tile.lane];
        if (r.y > H || r.bottom < -10) return;

        // уже нажатая обычная плитка — вспышка и растворение
        if (tile.hit && !tile.hold) {
            if (tile.flash <= 0) return;
            ctx.globalAlpha = tile.flash;
            roundRect(r.x, r.y, r.w, r.h, 10);
            ctx.fillStyle = neonRgba(tile.judge || color, 0.55);
            ctx.fill();
            neonStroke(ctx, NEON.text, 1.5);
            ctx.globalAlpha = 1;
            return;
        }

        roundRect(r.x, r.y, r.w, r.h, 10);
        const g = ctx.createLinearGradient(0, r.y, 0, r.bottom);
        g.addColorStop(0, "#160822");
        g.addColorStop(1, tile.missed ? "#3a0d18" : "#2a0f3e");
        ctx.fillStyle = g;
        ctx.fill();
        neonStroke(ctx, color, 2);

        // блик и "клавиша" внизу плитки
        ctx.fillStyle = neonRgba("#ffffff", 0.08);
        ctx.fillRect(r.x + 6, r.y + 6, r.w - 12, 3);
        ctx.fillStyle = neonRgba(color, 0.55);
        ctx.fillRect(r.x + 10, r.bottom - 12, r.w - 20, 4);

        if (tile.hold) {
            // дорожка удержания по центру, заполняется пока держат
            const cx = r.x + r.w / 2;
            ctx.beginPath();
            ctx.moveTo(cx, r.y + 14);
            ctx.lineTo(cx, r.bottom - 20);
            ctx.strokeStyle = neonRgba(color, 0.35);
            ctx.lineWidth = 6;
            ctx.lineCap = "round";
            ctx.stroke();
            // часть плитки, уже ушедшая за линию, — "проигранная", светится золотом
            if ((tile.holding || tile.done) && r.bottom - 20 > lineY) {
                ctx.beginPath();
                ctx.moveTo(cx, r.bottom - 20);
                ctx.lineTo(cx, Math.max(r.y + 14, lineY));
                neonStroke(ctx, NEON.gold, 3);
            }
        }
    }

    function draw(t) {
        ctx.save();
        if (shake > 0) ctx.translate((Math.random() - 0.5) * 8 * shake, (Math.random() - 0.5) * 6 * shake);

        // фон и дорожки
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, NEON.void);
        bg.addColorStop(1, "#1a0626");
        ctx.fillStyle = bg;
        ctx.fillRect(-10, -10, W + 20, H + 20);
        for (let l = 0; l < 4; l++) {
            const x = l * laneW;
            if (lanePress[l] > 0) {
                const g = ctx.createLinearGradient(0, 0, 0, H);
                g.addColorStop(0, neonRgba(RT_LANE_COLORS[l], 0));
                g.addColorStop(1, neonRgba(RT_LANE_COLORS[l], 0.22 * lanePress[l]));
                ctx.fillStyle = g;
                ctx.fillRect(x, 0, laneW, H);
            }
            if (laneError[l] > 0) {
                ctx.fillStyle = neonRgba(NEON.red, 0.28 * laneError[l]);
                ctx.fillRect(x, 0, laneW, H);
            }
            if (l > 0) {
                ctx.fillStyle = neonRgba(NEON.purple, 0.22);
                ctx.fillRect(x - 0.5, 0, 1, H);
            }
        }

        // большая полупрозрачная серия на фоне
        if (combo >= 5) {
            ctx.fillStyle = neonRgba(NEON.text, 0.08);
            ctx.font = `800 ${Math.round(H * 0.12)}px Manrope, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(combo), W / 2, H * 0.3);
        }

        // плитки
        for (const tile of tiles) {
            if (tile.time - t > RT_LOOKAHEAD + 0.1) break;
            if (tile.end - t < -1) continue;
            drawTile(tile, t);
        }

        // линия удара
        ctx.beginPath();
        ctx.moveTo(0, lineY);
        ctx.lineTo(W, lineY);
        neonStroke(ctx, NEON.pinkSoft, 1.5);

        // кольца и искры
        effects.forEach(e => {
            const k = 1 - e.age / (e.type === "ring" ? 0.35 : 0.5);
            if (k <= 0) return;
            ctx.globalAlpha = k;
            if (e.type === "ring") {
                ctx.beginPath();
                ctx.ellipse(e.x, e.y, laneW * (0.22 + (1 - k) * 0.22), 8 + (1 - k) * 10, 0, 0, Math.PI * 2);
                neonStroke(ctx, e.color, 1.5);
            } else {
                ctx.fillStyle = e.color;
                ctx.fillRect(e.x, e.y, 3, 3);
            }
            ctx.globalAlpha = 1;
        });

        // оценка попадания
        if (judgement && judgement.age < 0.6) {
            const k = judgement.age / 0.6;
            ctx.globalAlpha = 1 - k;
            ctx.fillStyle = judgement.color;
            ctx.font = `800 ${Math.round(Math.min(W * 0.08, 26) * (1 + (1 - k) * 0.15))}px Manrope, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(judgement.text, W / 2, lineY - H * 0.18 - k * 14);
            ctx.globalAlpha = 1;
        }
        ctx.restore();
    }

    // ---- Игровой цикл ----
    let lastFrame = performance.now();
    function loop(now) {
        if (gameOver || paused) return;
        const dt = Math.min(0.05, (now - lastFrame) / 1000);
        lastFrame = now;
        syncClock();
        const t = clockAnchorAudioTime;

        for (const tile of tiles) {
            if (tile.time - t > RT_LOOKAHEAD) break;
            // пропущенная плитка
            if (!tile.hit && !tile.missed && t - tile.time > RT_WINDOW.late) {
                tile.missed = true;
                loseLife(tile.lane, "ПРОПУСК");
                if (gameOver) return;
            }
            // длинную плитку додержали до конца — засчитываем сами
            if (tile.holding && t >= tile.end) {
                for (const [key, held] of holdsByPointer) if (held === tile) releaseHold(key);
            }
            if (tile.flash > 0) tile.flash = Math.max(0, tile.flash - dt * 5);
        }
        for (let l = 0; l < 4; l++) {
            lanePress[l] = Math.max(0, lanePress[l] - dt * 4);
            laneError[l] = Math.max(0, laneError[l] - dt * 3);
        }
        shake = Math.max(0, shake - dt * 6);
        effects.forEach(e => {
            e.age += dt;
            if (e.type === "spark") { e.x += e.vx * dt; e.y += e.vy * dt; e.vy += 400 * dt; }
        });
        effects = effects.filter(e => e.age < 0.5);
        if (judgement) judgement.age += dt;

        // прогресс трека и "сердечки" на 33/66/100%
        const progress = Math.min(1, t / chart.duration);
        progressEl.style.width = (progress * 100) + "%";
        starEls.forEach((el, i) => el.classList.toggle("rt-star-on", progress >= [0.33, 0.66, 0.99][i]));

        draw(t);

        if (t >= chart.duration - 0.05) {
            if (!gameOver) advanceSpeedTierAndLoop();
            return;
        }
        rafId = requestAnimationFrame(loop);
    }

    function startPlaying() {
        paused = false;
        audio.playbackRate = RHYTHM_SPEED_TIERS[tierIndex];
        audio.play().catch(() => {});
        syncClock();
        lastFrame = performance.now();
        rafId = requestAnimationFrame(loop);
    }

    // Трек кончился — следующий круг быстрее (как и раньше)
    function advanceSpeedTierAndLoop() {
        paused = true;
        cancelAnimationFrame(rafId);
        audio.pause();
        holdsByPointer.clear();
        tiles.forEach(tile => Object.assign(tile, { hit: false, missed: false, holding: false, done: false, judge: null, flash: 0 }));
        if (tierIndex < RHYTHM_SPEED_TIERS.length - 1) tierIndex++;
        renderHud();

        let count = 3;
        countdownEl.textContent = "🔥 Быстрее! " + count;
        countdownEl.classList.add("rhythm-countdown-show");
        const iv = setInterval(() => {
            count--;
            if (gameOver) { clearInterval(iv); return; }
            if (count <= 0) {
                clearInterval(iv);
                countdownEl.classList.remove("rhythm-countdown-show");
                audio.currentTime = 0;
                startPlaying();
            } else {
                countdownEl.textContent = "🔥 Быстрее! " + count;
            }
        }, 1000);
    }

    function endGame() {
        if (gameOver) return;
        gameOver = true;
        paused = true;
        cancelAnimationFrame(rafId);
        audio.pause();
        playSound("gameover");
        draw(getPlaybackTime());
        saveRhythmScore(track.key, score).then(isRecord => {
            showRhythmGameOverModal(score, isRecord, () => startRhythmLevel(track), () => showRhythmMenu());
        });
    }

    // Свернули вкладку — пауза, при возврате "Играть" продолжит с того же места
    function onVisibility() {
        if (!document.hidden || paused || gameOver) return;
        paused = true;
        cancelAnimationFrame(rafId);
        syncClock();
        audio.pause();
        holdsByPointer.forEach((tile, key) => releaseHold(key));
        showPlayOverlay(arena, startPlaying);
    }
    document.addEventListener("visibilitychange", onVisibility);

    draw(0);
    showPlayOverlay(arena, startPlaying);

    activeGameCleanup = () => {
        gameOver = true;
        paused = true;
        cancelAnimationFrame(rafId);
        audio.pause();
        resizeObserver.disconnect();
        canvas.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        window.removeEventListener("keydown", keyDown);
        window.removeEventListener("keyup", keyUp);
        document.removeEventListener("visibilitychange", onVisibility);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
}
