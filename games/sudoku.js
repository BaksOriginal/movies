// ==========================================
// sudoku.js — СУДОКУ (одиночная игра раздела «Игры»)
// ==========================================
// Подключается на games/index.html после games.js. Сервер не нужен: головоломки
// генерируются прямо в браузере (у каждой ровно одно решение), незаконченная
// партия и лучшее время по каждой сложности хранятся в localStorage.

const SUDOKU_SAVE_KEY = "sudokuGame:v1";
const SUDOKU_BEST_KEY = "sudokuBest:v1";
const SUDOKU_MAX_MISTAKES = 3;
const SUDOKU_HINTS = 3;

const SUDOKU_LEVELS = {
    easy:   { name: "Лёгкий",  clues: 40, dots: 1, desc: "Много подсказок на поле — разогреться и не напрягаться." },
    medium: { name: "Средний", clues: 32, dots: 2, desc: "Придётся подумать и пользоваться заметками." },
    hard:   { name: "Сложный", clues: 25, dots: 3, desc: "Минимум цифр. Для тех, кто любит долгие партии." }
};

// ---------- Генератор ----------
// Поле — массив из 81 числа (0 — пусто). Решатель на битовых масках:
// всегда идёт в клетку с наименьшим числом кандидатов, поэтому даже
// проверка «решение единственное?» занимает миллисекунды.
const SDK_ALL = 0x3FE; // биты 1..9

function sdkBox(i) { return Math.floor(Math.floor(i / 9) / 3) * 3 + Math.floor((i % 9) / 3); }

function sdkBitCount(m) { let c = 0; while (m) { m &= m - 1; c++; } return c; }

function sdkShuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Решает поле на месте. limit — сколько решений искать (2 — для проверки
// единственности), random — перебирать кандидатов в случайном порядке
// (так из пустого поля получается случайное полное).
function sdkSolve(grid, limit = 1, random = false) {
    const rows = new Array(9).fill(0), cols = new Array(9).fill(0), boxes = new Array(9).fill(0);
    for (let i = 0; i < 81; i++) {
        const v = grid[i];
        if (!v) continue;
        const bit = 1 << v;
        const r = Math.floor(i / 9), c = i % 9, b = sdkBox(i);
        if ((rows[r] | cols[c] | boxes[b]) & bit) return 0; // противоречие
        rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
    }
    let count = 0;
    let solved = null;

    function step() {
        let best = -1, bestMask = 0, bestCount = 10;
        for (let i = 0; i < 81; i++) {
            if (grid[i]) continue;
            const mask = SDK_ALL & ~(rows[Math.floor(i / 9)] | cols[i % 9] | boxes[sdkBox(i)]);
            const n = sdkBitCount(mask);
            if (n < bestCount) { best = i; bestMask = mask; bestCount = n; if (n <= 1) break; }
        }
        if (best === -1) {
            count++;
            if (!solved) solved = grid.slice();
            return count >= limit;
        }
        if (bestCount === 0) return false;
        const digits = [];
        for (let d = 1; d <= 9; d++) if (bestMask & (1 << d)) digits.push(d);
        if (random) sdkShuffle(digits);
        const r = Math.floor(best / 9), c = best % 9, b = sdkBox(best);
        for (const d of digits) {
            const bit = 1 << d;
            grid[best] = d; rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
            const stop = step();
            grid[best] = 0; rows[r] &= ~bit; cols[c] &= ~bit; boxes[b] &= ~bit;
            if (stop) return true;
        }
        return false;
    }

    step();
    if (solved && limit === 1) for (let i = 0; i < 81; i++) grid[i] = solved[i];
    return count;
}

// Новая головоломка: случайное полное поле, из которого симметричными
// парами убираются цифры, пока решение остаётся единственным и пока не
// дошли до нужного числа подсказок.
function sdkGenerate(levelKey) {
    const target = SUDOKU_LEVELS[levelKey].clues;
    let best = null;
    // Пара попыток: если первая упёрлась (на «Сложном» иногда не удаётся
    // убрать столько цифр), берём ту, где подсказок вышло меньше.
    for (let attempt = 0; attempt < 3; attempt++) {
        const solution = new Array(81).fill(0);
        sdkSolve(solution, 1, true);
        const puzzle = solution.slice();
        let clues = 81;
        const order = sdkShuffle([...Array(41).keys()]); // 0..40: клетка и её зеркальная пара
        for (const i of order) {
            if (clues <= target) break;
            const j = 80 - i;
            const a = puzzle[i], b = puzzle[j];
            puzzle[i] = 0; puzzle[j] = 0;
            if (sdkSolve(puzzle.slice(), 2) !== 1) {
                puzzle[i] = a; puzzle[j] = b;
            } else {
                clues -= i === j ? 1 : 2;
            }
        }
        if (!best || clues < best.clues) best = { puzzle, solution, clues };
        if (clues <= target + 1) break;
    }
    return best;
}

// ---------- Сохранение ----------
function sdkLoadSaved() {
    try {
        const s = JSON.parse(localStorage.getItem(SUDOKU_SAVE_KEY) || "null");
        if (s && Array.isArray(s.values) && s.values.length === 81 && SUDOKU_LEVELS[s.level]) return s;
    } catch (e) { /* битое сохранение — просто начнём заново */ }
    return null;
}
function sdkClearSaved() {
    try { localStorage.removeItem(SUDOKU_SAVE_KEY); } catch (e) {}
}
function sdkLoadBest() {
    try { return JSON.parse(localStorage.getItem(SUDOKU_BEST_KEY) || "{}") || {}; } catch (e) { return {}; }
}
function sdkSaveBest(best) {
    try { localStorage.setItem(SUDOKU_BEST_KEY, JSON.stringify(best)); } catch (e) {}
}

function sdkFormatTime(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Подпись на точке карты игр
function sudokuTileText() {
    const saved = sdkLoadSaved();
    if (saved) return `Партия на паузе · ${SUDOKU_LEVELS[saved.level].name}`;
    const best = sdkLoadBest();
    const parts = Object.keys(SUDOKU_LEVELS).filter(k => best[k]).map(k => `${SUDOKU_LEVELS[k].name[0]} ${sdkFormatTime(best[k].time)}`);
    return parts.length ? `Лучшее: ${parts.join(" · ")}` : "3 уровня сложности";
}

// ---------- Меню: продолжить / выбор сложности ----------
function showSudokuMenu() {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);

    app.innerHTML = "";
    const title = document.createElement("h1");
    setEmojiTitle(title, "🔢 Судоку");
    app.appendChild(title);

    const saved = sdkLoadSaved();
    const best = sdkLoadBest();

    const menu = document.createElement("div");
    menu.className = "sdk-menu";

    if (saved) {
        const filled = saved.values.filter(Boolean).length;
        const resume = document.createElement("button");
        resume.type = "button";
        resume.className = "ui-btn sdk-resume";
        resume.innerHTML = `
            <span class="sdk-resume-icon">▶</span>
            <span class="sdk-resume-body">
                <span class="sdk-resume-title">Продолжить партию</span>
                <span class="sdk-resume-sub">${SUDOKU_LEVELS[saved.level].name} · ${sdkFormatTime(saved.elapsed)} · заполнено ${filled}/81</span>
            </span>
            <span class="sdk-resume-bar"><span style="width:${filled / 81 * 100}%"></span></span>
        `;
        resume.onclick = () => startSudokuGame(saved);
        menu.appendChild(resume);
    }

    const label = document.createElement("div");
    label.className = "sdk-menu-label";
    label.textContent = saved ? "Или новая партия" : "Выбери сложность";
    menu.appendChild(label);

    const grid = document.createElement("div");
    grid.className = "sdk-levels";
    Object.entries(SUDOKU_LEVELS).forEach(([key, lvl]) => {
        const b = best[key];
        const card = document.createElement("button");
        card.type = "button";
        card.className = `ui-btn sdk-level sdk-level-${key}`;
        card.innerHTML = `
            <span class="sdk-level-dots">${[1, 2, 3].map(n => `<i class="${n <= lvl.dots ? "on" : ""}"></i>`).join("")}</span>
            <span class="sdk-level-name">${lvl.name}</span>
            <span class="sdk-level-desc">${lvl.desc}</span>
            <span class="sdk-level-best">${b ? `🏆 ${sdkFormatTime(b.time)} · побед: ${b.wins}` : "Ещё не пройдено"}</span>
        `;
        card.onclick = () => {
            if (saved && !confirm("Начать новую партию? Текущая будет потеряна.")) return;
            newSudokuGame(key);
        };
        grid.appendChild(card);
    });
    menu.appendChild(grid);

    const rules = document.createElement("p");
    rules.className = "sdk-rules";
    rules.textContent = "Заполни поле так, чтобы в каждой строке, столбце и квадрате 3×3 цифры от 1 до 9 встречались по одному разу. Три ошибки — партия проиграна.";
    menu.appendChild(rules);

    app.appendChild(menu);
}

function newSudokuGame(levelKey) {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);
    app.innerHTML = `<div class="sdk-loading"><div class="sdk-loading-grid">${"<i></i>".repeat(9)}</div>Собираю поле…</div>`;
    // Даём браузеру нарисовать «загрузку», генерация занимает доли секунды
    setTimeout(() => {
        const g = sdkGenerate(levelKey);
        startSudokuGame({
            level: levelKey,
            puzzle: g.puzzle,
            solution: g.solution,
            values: g.puzzle.slice(),
            notes: new Array(81).fill(0),
            mistakes: 0,
            hints: SUDOKU_HINTS,
            elapsed: 0
        });
    }, 60);
}

// ---------- Партия ----------
function startSudokuGame(state) {
    if (activeGameCleanup) { activeGameCleanup(); activeGameCleanup = null; }
    setGamesNav(true);
    setShellBack(() => showSudokuMenu(), "Судоку");

    const S = state;
    const level = SUDOKU_LEVELS[S.level];
    let selected = S.values.findIndex(v => !v);
    let notesMode = false;
    let finished = false;
    let paused = false;
    let undoStack = [];
    let runStart = performance.now();

    app.innerHTML = "";
    const title = document.createElement("h1");
    setEmojiTitle(title, "🔢 Судоку");
    title.style.marginBottom = "5px";
    app.appendChild(title);

    const wrap = document.createElement("div");
    wrap.className = "sdk-game";
    wrap.innerHTML = `
        <div class="sdk-stage">
            <div class="sdk-hud">
                <span class="sdk-chip sdk-chip-level">${"●".repeat(level.dots)} ${level.name}</span>
                <span class="sdk-chip">Ошибки <b id="sdkMistakes"></b></span>
                <button type="button" class="ui-btn sdk-chip sdk-timer" id="sdkTimer" aria-label="Пауза"><span id="sdkTime">00:00</span><span class="sdk-pause-icon">❚❚</span></button>
            </div>
            <div class="sdk-board-wrap">
                <div class="sdk-board" id="sdkBoard"></div>
                <div class="sdk-paused" id="sdkPaused" hidden>
                    <div class="sdk-paused-title">Пауза</div>
                    <button type="button" class="ui-btn ui-pill ui-pill-accent" id="sdkResume">▶ Продолжить</button>
                </div>
            </div>
        </div>
        <div class="sdk-controls">
            <div class="sdk-tools">
                <button type="button" class="ui-btn sdk-tool" id="sdkUndo"><span class="sdk-tool-icon">↶</span>Отменить</button>
                <button type="button" class="ui-btn sdk-tool" id="sdkErase"><span class="sdk-tool-icon">⌫</span>Стереть</button>
                <button type="button" class="ui-btn sdk-tool" id="sdkNotes"><span class="sdk-tool-icon">✎</span>Заметки<span class="sdk-tool-badge" id="sdkNotesBadge">выкл</span></button>
                <button type="button" class="ui-btn sdk-tool" id="sdkHint"><span class="sdk-tool-icon">💡</span>Подсказка<span class="sdk-tool-badge" id="sdkHintBadge"></span></button>
            </div>
            <div class="sdk-pad" id="sdkPad"></div>
            <div class="sdk-keys-hint">Клавиши: 1–9, стрелки, Backspace, N — заметки, Ctrl+Z — отменить</div>
        </div>
    `;
    app.appendChild(wrap);

    const boardEl = wrap.querySelector("#sdkBoard");
    const padEl = wrap.querySelector("#sdkPad");
    const timeEl = wrap.querySelector("#sdkTime");
    const pausedEl = wrap.querySelector("#sdkPaused");

    // Поле: 9 квадратов 3×3, в каждом по 9 клеток — так толстые границы
    // квадратов получаются сами собой из зазоров сетки.
    const cells = new Array(81);
    for (let b = 0; b < 9; b++) {
        const box = document.createElement("div");
        box.className = "sdk-box";
        for (let k = 0; k < 9; k++) {
            const r = Math.floor(b / 3) * 3 + Math.floor(k / 3);
            const c = (b % 3) * 3 + (k % 3);
            const i = r * 9 + c;
            const cell = document.createElement("button");
            cell.type = "button";
            cell.className = "sdk-cell";
            cell.dataset.i = i;
            cell.style.setProperty("--d", r + c);
            box.appendChild(cell);
            cells[i] = cell;
        }
        boardEl.appendChild(box);
    }
    const padBtns = [];
    for (let d = 1; d <= 9; d++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn sdk-num";
        btn.dataset.d = d;
        btn.innerHTML = `<span class="sdk-num-digit">${d}</span><span class="sdk-num-left"></span>`;
        padEl.appendChild(btn);
        padBtns[d] = btn;
    }

    const peersOf = (i) => {
        const r = Math.floor(i / 9), c = i % 9, b = sdkBox(i), out = [];
        for (let j = 0; j < 81; j++) {
            if (j !== i && (Math.floor(j / 9) === r || j % 9 === c || sdkBox(j) === b)) out.push(j);
        }
        return out;
    };
    const isGiven = (i) => S.puzzle[i] !== 0;
    const isWrong = (i) => S.values[i] !== 0 && S.values[i] !== S.solution[i];

    function renderCell(i) {
        const v = S.values[i];
        const cell = cells[i];
        if (v) {
            cell.textContent = v;
        } else if (S.notes[i]) {
            let html = '<span class="sdk-notes">';
            for (let d = 1; d <= 9; d++) html += `<i data-n="${d}">${S.notes[i] & (1 << d) ? d : ""}</i>`;
            cell.innerHTML = html + "</span>";
        } else {
            cell.textContent = "";
        }
    }

    function renderAll() {
        for (let i = 0; i < 81; i++) renderCell(i);
        renderHighlights();
        renderPad();
        renderHud();
    }

    function renderHighlights() {
        const selVal = selected >= 0 ? S.values[selected] : 0;
        const sr = Math.floor(selected / 9), sc = selected % 9, sb = selected >= 0 ? sdkBox(selected) : -1;
        for (let i = 0; i < 81; i++) {
            const cell = cells[i];
            const v = S.values[i];
            const peer = selected >= 0 && i !== selected && (Math.floor(i / 9) === sr || i % 9 === sc || sdkBox(i) === sb);
            cell.classList.toggle("is-given", isGiven(i));
            cell.classList.toggle("is-user", !isGiven(i) && v !== 0 && !isWrong(i));
            cell.classList.toggle("is-wrong", isWrong(i));
            cell.classList.toggle("is-selected", i === selected);
            cell.classList.toggle("is-peer", peer);
            cell.classList.toggle("is-same", !!selVal && v === selVal && i !== selected);
            cell.classList.toggle("is-conflict", !!selVal && peer && v === selVal && isWrong(selected));
            if (!v && S.notes[i]) {
                cell.querySelectorAll(".sdk-notes i").forEach(n => n.classList.toggle("hl", !!selVal && +n.dataset.n === selVal));
            }
        }
    }

    function renderPad() {
        for (let d = 1; d <= 9; d++) {
            let placed = 0;
            for (let i = 0; i < 81; i++) if (S.values[i] === d && !isWrong(i)) placed++;
            const left = 9 - placed;
            padBtns[d].querySelector(".sdk-num-left").textContent = left || "";
            padBtns[d].classList.toggle("is-done", left === 0);
            padBtns[d].classList.toggle("is-notes", notesMode);
        }
    }

    function renderHud() {
        wrap.querySelector("#sdkMistakes").textContent = `${S.mistakes}/${SUDOKU_MAX_MISTAKES}`;
        wrap.querySelector("#sdkMistakes").classList.toggle("is-bad", S.mistakes > 0);
        wrap.querySelector("#sdkNotes").classList.toggle("is-on", notesMode);
        wrap.querySelector("#sdkNotesBadge").textContent = notesMode ? "вкл" : "выкл";
        wrap.querySelector("#sdkHintBadge").textContent = S.hints;
        wrap.querySelector("#sdkHint").disabled = S.hints <= 0;
        wrap.querySelector("#sdkUndo").disabled = undoStack.length === 0;
        renderTime();
    }

    function currentElapsed() {
        return S.elapsed + (paused || finished ? 0 : performance.now() - runStart);
    }
    function renderTime() { timeEl.textContent = sdkFormatTime(currentElapsed()); }
    function commitTime() {
        if (!paused && !finished) { S.elapsed += performance.now() - runStart; runStart = performance.now(); }
    }
    function save() {
        if (finished) return;
        commitTime();
        try { localStorage.setItem(SUDOKU_SAVE_KEY, JSON.stringify(S)); } catch (e) {}
    }

    function pushUndo(changes) {
        undoStack.push(changes);
        if (undoStack.length > 300) undoStack.shift();
    }
    // Снимок клетки до изменения — для «Отменить»
    const snap = (i) => [i, S.values[i], S.notes[i]];

    function flash(indices, cls) {
        indices.forEach(i => {
            cells[i].classList.remove(cls);
            void cells[i].offsetWidth;
            cells[i].classList.add(cls);
        });
    }

    function checkGroupsDone(i) {
        const r = Math.floor(i / 9), c = i % 9, b = sdkBox(i);
        const groups = [
            [...Array(9).keys()].map(k => r * 9 + k),
            [...Array(9).keys()].map(k => k * 9 + c),
            [...Array(81).keys()].filter(j => sdkBox(j) === b)
        ];
        groups.forEach(g => {
            if (g.every(j => S.values[j] === S.solution[j])) flash(g, "is-wave");
        });
    }

    function placeDigit(d) {
        if (finished || paused || selected < 0 || isGiven(selected)) return;
        const i = selected;

        if (notesMode) {
            if (S.values[i]) return;
            pushUndo([snap(i)]);
            S.notes[i] ^= (1 << d);
            renderCell(i);
            renderHighlights();
            renderHud();
            save();
            return;
        }

        // Повторный тап той же цифрой — убрать её
        if (S.values[i] === d) { erase(); return; }

        const changes = [snap(i)];
        const correct = S.solution[i] === d;
        if (correct) {
            peersOf(i).forEach(j => { if (S.notes[j] & (1 << d)) { changes.push(snap(j)); } });
        }
        pushUndo(changes);

        S.values[i] = d;
        S.notes[i] = 0;
        if (correct) {
            peersOf(i).forEach(j => { if (S.notes[j] & (1 << d)) { S.notes[j] &= ~(1 << d); renderCell(j); } });
            vibrate(8);
            renderCell(i);
            flash([i], "is-pop");
            checkGroupsDone(i);
        } else {
            S.mistakes++;
            vibrate([30, 40, 30]);
            beep(180, 120, "triangle", 0.12);
            renderCell(i);
            flash([i], "is-shake");
        }
        renderHighlights();
        renderPad();
        renderHud();

        if (S.mistakes >= SUDOKU_MAX_MISTAKES) { lose(); return; }
        if (S.values.every((v, k) => v === S.solution[k])) { win(); return; }
        save();
    }

    function erase() {
        if (finished || paused || selected < 0 || isGiven(selected)) return;
        const i = selected;
        if (!S.values[i] && !S.notes[i]) return;
        pushUndo([snap(i)]);
        S.values[i] = 0;
        S.notes[i] = 0;
        renderCell(i);
        renderHighlights();
        renderPad();
        renderHud();
        save();
    }

    function undo() {
        if (finished || paused || !undoStack.length) return;
        const changes = undoStack.pop();
        changes.forEach(([i, v, n]) => { S.values[i] = v; S.notes[i] = n; renderCell(i); });
        selected = changes[0][0];
        renderHighlights();
        renderPad();
        renderHud();
        save();
    }

    function hint() {
        if (finished || paused || S.hints <= 0) return;
        let i = selected;
        if (i < 0 || isGiven(i) || S.values[i] === S.solution[i]) {
            // Выделенная клетка уже верна — подсказываем самую «простую»
            // пустую клетку (с наименьшим числом вариантов)
            let bestCount = 10;
            i = -1;
            for (let j = 0; j < 81; j++) {
                if (S.values[j] === S.solution[j]) continue;
                let used = 0;
                peersOf(j).forEach(p => { if (S.values[p] && !isWrong(p)) used |= 1 << S.values[p]; });
                const n = sdkBitCount(SDK_ALL & ~used);
                if (n < bestCount) { bestCount = n; i = j; }
            }
            if (i < 0) return;
        }
        selected = i;
        const d = S.solution[i];
        const changes = [snap(i)];
        peersOf(i).forEach(j => { if (S.notes[j] & (1 << d)) changes.push(snap(j)); });
        pushUndo(changes);
        S.hints--;
        S.values[i] = d;
        S.notes[i] = 0;
        peersOf(i).forEach(j => { if (S.notes[j] & (1 << d)) { S.notes[j] &= ~(1 << d); renderCell(j); } });
        renderCell(i);
        flash([i], "is-hinted");
        checkGroupsDone(i);
        renderHighlights();
        renderPad();
        renderHud();
        if (S.values.every((v, k) => v === S.solution[k])) { win(); return; }
        save();
    }

    function select(i) {
        if (paused) return;
        selected = i;
        renderHighlights();
    }

    function setPaused(v) {
        if (finished || paused === v) return;
        if (v) { commitTime(); paused = true; }
        else { paused = false; runStart = performance.now(); }
        pausedEl.hidden = !paused;
        boardEl.classList.toggle("is-hidden", paused);
        wrap.querySelector("#sdkTimer").classList.toggle("is-paused", paused);
        renderTime();
        if (paused) save();
    }

    function finish() {
        commitTime();
        finished = true;
        sdkClearSaved();
        clearInterval(timer);
    }

    function win() {
        finish();
        const time = S.elapsed;
        const best = sdkLoadBest();
        const prev = best[S.level];
        const isRecord = !prev || time < prev.time;
        best[S.level] = { time: isRecord ? time : prev.time, wins: (prev ? prev.wins : 0) + 1 };
        sdkSaveBest(best);

        boardEl.classList.add("is-solved");
        cells.forEach(c => c.classList.add("is-wave"));
        playSound("point");
        vibrate([20, 40, 20, 40, 60]);
        setTimeout(() => showResult(true, time, isRecord), 1100);
    }

    function lose() {
        finish();
        boardEl.classList.add("is-lost");
        playSound("gameover");
        setTimeout(() => showResult(false, S.elapsed, false), 700);
    }

    function showResult(won, time, isRecord) {
        if (!wrap.isConnected) return;
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.id = "gameOverModal";
        overlay.innerHTML = `
            <div class="modal-content gameover${isRecord ? " gameover-record" : ""}">
                <div class="gameover-kicker">${won ? (isRecord ? "🏆 Новый рекорд!" : "🎉 Решено!") : "💥 Три ошибки"}</div>
                <div class="gameover-score">${won ? sdkFormatTime(time) : "Увы"}</div>
                <div class="gameover-label">${level.name} · ошибок: ${S.mistakes} · подсказок: ${SUDOKU_HINTS - S.hints}</div>
                <div class="gameover-actions">
                    <button type="button" id="sdkAgain" class="ui-btn ui-pill ui-pill-accent">🔁 Новое поле</button>
                    <button type="button" id="sdkToMenu" class="ui-btn ui-pill">🔢 К судоку</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector("#sdkAgain").onclick = () => { overlay.remove(); newSudokuGame(S.level); };
        overlay.querySelector("#sdkToMenu").onclick = () => { overlay.remove(); showSudokuMenu(); };
    }

    // ---------- Ввод ----------
    boardEl.addEventListener("click", (e) => {
        const cell = e.target.closest(".sdk-cell");
        if (cell) select(+cell.dataset.i);
    });
    padEl.addEventListener("click", (e) => {
        const btn = e.target.closest(".sdk-num");
        if (btn) placeDigit(+btn.dataset.d);
    });
    wrap.querySelector("#sdkUndo").onclick = undo;
    wrap.querySelector("#sdkErase").onclick = erase;
    wrap.querySelector("#sdkHint").onclick = hint;
    wrap.querySelector("#sdkNotes").onclick = () => { notesMode = !notesMode; renderPad(); renderHud(); };
    wrap.querySelector("#sdkTimer").onclick = () => setPaused(!paused);
    wrap.querySelector("#sdkResume").onclick = () => setPaused(false);

    function keyHandler(e) {
        if (finished || document.querySelector(".modal-overlay")) return;
        if (e.target.closest && e.target.closest("input, textarea")) return;
        const k = e.key;
        if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "я")) { e.preventDefault(); undo(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (/^[1-9]$/.test(k)) { e.preventDefault(); placeDigit(+k); return; }
        if (k === "Backspace" || k === "Delete" || k === "0") { e.preventDefault(); erase(); return; }
        if (k === "n" || k === "N" || k === "т" || k === "Т") { notesMode = !notesMode; renderPad(); renderHud(); return; }
        if (k === " " || k === "p" || k === "з") { e.preventDefault(); setPaused(!paused); return; }
        const moves = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 };
        if (moves[k] !== undefined) {
            e.preventDefault();
            if (selected < 0) { select(0); return; }
            const r = Math.floor(selected / 9), c = selected % 9;
            const nr = (r + (k === "ArrowUp" ? -1 : k === "ArrowDown" ? 1 : 0) + 9) % 9;
            const nc = (c + (k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0) + 9) % 9;
            select(nr * 9 + nc);
        }
    }
    function visibilityHandler() {
        if (document.hidden) setPaused(true);
    }
    document.addEventListener("keydown", keyHandler);
    document.addEventListener("visibilitychange", visibilityHandler);

    const timer = setInterval(() => {
        if (!wrap.isConnected) return;
        renderTime();
    }, 500);
    const autosave = setInterval(() => { if (!paused && !finished) save(); }, 10000);

    activeGameCleanup = () => {
        save();
        clearInterval(timer);
        clearInterval(autosave);
        document.removeEventListener("keydown", keyHandler);
        document.removeEventListener("visibilitychange", visibilityHandler);
        document.getElementById("gameOverModal")?.remove();
    };

    renderAll();
    save();
}
