// ==========================================
// randomizer.js — РАНДОМАЙЗЕР (колесо фортуны), общий для всех страниц
// ==========================================
// Подключается после core.js на главной, в Играх и в Совместном просмотре:
// колесо ни от чего на главной не зависит, кроме кнопки "Из «Будем
// смотреть»" — она показывается только там, где загружен вишлист.

// Палитра секторов колеса — переиспользуем неоновые токены темы, чтобы
// колесо не выбивалось из общего стиля страницы.
const RANDOMIZER_WHEEL_COLORS = ["#ff2e93", "#8b3bff", "#2ee8ff", "#ffd15c", "#ff7fc4", "#5a1fb0"];

// Отрисовка секторов колеса на канвасе под текущий список позиций.
// Сектор 0 всегда начинается строго сверху (там же, где неподвижный
// указатель) и дальше идёт по часовой стрелке — это упрощает расчёт угла
// поворота при прокрутке в spin().
//
// Раньше размер шрифта задавался в внутренних пикселях канваса (520×520),
// а сам канвас на экране растягивался всего до ~230×230 (см. .randomizer-wheel-canvas
// в CSS) — то есть текст, "нарисованный" как будто бы 19px, реально
// показывался на экране примерно 8px. Теперь канвас подгоняется под
// devicePixelRatio, а всё рисование ведётся в реальных экранных пикселях
// (ctx.setTransform), поэтому размер шрифта, который мы задаём, — это и
// есть видимый размер. Дополнительно размер шрифта подбирается для каждого
// слова отдельно: сначала прикидывается по угловой ширине сектора (меньше
// секторов — крупнее шрифт), затем ещё уменьшается, только если конкретное
// слово реально не помещается по радиусу (ctx.measureText), а не по
// количеству символов "на глаз", как было раньше.
function drawRandomizerWheel(canvas, items) {
    const stage = canvas.closest(".randomizer-wheel-stage");
    const rect = (stage || canvas).getBoundingClientRect();
    const displaySize = Math.max(120, Math.round(rect.width) || 230);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Внутреннее разрешение канваса — под реальный размер на экране и
    // плотность пикселей устройства (чёткость на retina), а рисуем дальше
    // в координатах "как на экране" через setTransform.
    canvas.width = displaySize * dpr;
    canvas.height = displaySize * dpr;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const size = displaySize;
    const center = size / 2;
    const radius = center - 3;
    const hubRadius = size * 0.09; // радиус центральной втулки (см. .randomizer-wheel-hub) — текст не должен на неё наезжать
    const textStart = radius - 8;       // ближе к внешнему краю колеса
    const textEnd = hubRadius + 12;     // не долезаем до втулки
    const maxTextWidth = Math.max(20, textStart - textEnd);
    const segAngle = (Math.PI * 2) / items.length;

    const MAX_FONT = 26;
    const MIN_FONT = 10;

    ctx.clearRect(0, 0, size, size);

    items.forEach((item, i) => {
        const startAngle = i * segAngle - Math.PI / 2;
        const endAngle = startAngle + segAngle;

        ctx.beginPath();
        ctx.moveTo(center, center);
        ctx.arc(center, center, radius, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = RANDOMIZER_WHEEL_COLORS[i % RANDOMIZER_WHEEL_COLORS.length];
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(10,6,19,0.85)";
        ctx.stroke();

        // Прикидка стартового размера шрифта по угловой ширине сектора —
        // чем меньше позиций введено, тем крупнее текст (до MAX_FONT).
        const wedgeThickness = segAngle * (textStart + textEnd) / 2;
        let fontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, wedgeThickness * 0.82));

        ctx.font = `700 ${fontSize}px 'Jura', 'Segoe UI', Arial, sans-serif`;
        let textWidth = ctx.measureText(item).width;

        // А дальше уменьшаем, только если конкретное слово реально не
        // помещается по длине сектора — короткие слова крупный шрифт не теряют.
        while (textWidth > maxTextWidth && fontSize > MIN_FONT) {
            fontSize -= 1;
            ctx.font = `700 ${fontSize}px 'Jura', 'Segoe UI', Arial, sans-serif`;
            textWidth = ctx.measureText(item).width;
        }

        let label = item;
        if (textWidth > maxTextWidth) {
            // Даже минимальным шрифтом целиком не влезает — обрезаем с многоточием
            while (label.length > 1 && ctx.measureText(label + "…").width > maxTextWidth) {
                label = label.slice(0, -1);
            }
            label = label + "…";
        }

        // Подпись сектора — читается от центра к краю колеса
        ctx.save();
        ctx.translate(center, center);
        ctx.rotate(startAngle + segAngle / 2);
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#f2e9ff";
        ctx.shadowColor = "rgba(0,0,0,0.65)";
        ctx.shadowBlur = 3;
        ctx.fillText(label, textStart, 0);
        ctx.restore();
    });

    // Внешний неоновый обод колеса
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(46,232,255,0.55)";
    ctx.stroke();
}

// Световые искры, разлетающиеся из центра колеса в момент остановки —
// вместе с randomizer-wheel-glow-burst (CSS) и вспышкой на самом колесе
// это и есть "красивый световой эффект в конце".
function spawnRandomizerSparks(container) {
    const SPARK_COUNT = 20;
    const colors = ["#ffd15c", "#2ee8ff", "#ff2e93", "#ffffff"];

    for (let i = 0; i < SPARK_COUNT; i++) {
        const spark = document.createElement("div");
        spark.className = "randomizer-spark";

        const angle = Math.random() * Math.PI * 2;
        const distance = 60 + Math.random() * 90;
        const color = colors[Math.floor(Math.random() * colors.length)];

        spark.style.setProperty("--spark-x", (Math.cos(angle) * distance) + "px");
        spark.style.setProperty("--spark-y", (Math.sin(angle) * distance) + "px");
        spark.style.background = color;
        spark.style.boxShadow = `0 0 8px ${color}`;
        spark.style.animationDelay = (Math.random() * 0.15) + "s";

        container.appendChild(spark);
        setTimeout(() => spark.remove(), 1400);
    }
}

// Модалка "Рандомайзер": пользователь вводит позиции через запятую
// (пробелы вокруг запятых игнорируются), колесо крутится ~5 секунд и
// останавливается на случайно выбранной позиции со световым эффектом.
// Последний набор вариантов колеса запоминается между открытиями —
// обычно крутят одно и то же ("кто выбирает фильм", "пицца или суши")
const RANDOMIZER_ITEMS_KEY = "randomizerItems";

function showRandomizerModal() {
    const hasWishlist = typeof wishlistTitles !== "undefined" && wishlistTitles.size > 0;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "randomizerModal";
    let isSpinning = false;
    overlay.onclick = (e) => { if (e.target === overlay && !isSpinning) overlay.remove(); };

    overlay.innerHTML = `
        <div class="modal-content randomizer-modal-content">
            <h3>🎲 Рандомайзер</h3>
            <div class="randomizer-wheel-area randomizer-wheel-area-visible" id="randomizerWheelArea">
                <div class="randomizer-wheel-stage" id="randomizerWheelStage">
                    <div class="randomizer-wheel-glow" id="randomizerWheelGlow"></div>
                    <div class="randomizer-sparks" id="randomizerSparks"></div>
                    <div class="randomizer-wheel-pointer"></div>
                    <canvas id="randomizerWheelCanvas" class="randomizer-wheel-canvas" width="520" height="520"></canvas>
                    <div class="randomizer-wheel-hub">🎲</div>
                </div>
            </div>
            <div id="randomizerResult" class="randomizer-result"></div>

            <form class="rz-add" id="randomizerAddForm">
                <input type="text" id="randomizerInput" class="rz-input" placeholder="Добавить вариант" enterkeyhint="done" autocomplete="off">
                <button type="submit" class="ui-btn rz-add-btn" title="Добавить">+</button>
            </form>
            <div class="rz-chips" id="randomizerChips"></div>
            <div class="rz-presets">
                ${hasWishlist ? `<button type="button" class="ui-btn ui-link" id="randomizerFromWishlist">🍿 Из «Будем смотреть»</button>` : ""}
                <button type="button" class="ui-btn ui-link" id="randomizerClear">Очистить</button>
            </div>

            <div class="rz-buttons">
                <button type="button" class="ui-btn ui-pill ui-pill-accent rz-spin" id="randomizerPickBtn">Крутить</button>
                <button type="button" class="ui-btn ui-pill" id="randomizerCloseBtn">Закрыть</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const inputEl = overlay.querySelector("#randomizerInput");
    const chipsEl = overlay.querySelector("#randomizerChips");
    const resultEl = overlay.querySelector("#randomizerResult");
    const wheelStage = overlay.querySelector("#randomizerWheelStage");
    const canvas = overlay.querySelector("#randomizerWheelCanvas");
    const glowEl = overlay.querySelector("#randomizerWheelGlow");
    const sparksEl = overlay.querySelector("#randomizerSparks");
    const pickBtn = overlay.querySelector("#randomizerPickBtn");

    let items = [];
    try {
        const saved = JSON.parse(localStorage.getItem(RANDOMIZER_ITEMS_KEY) || "[]");
        if (Array.isArray(saved)) items = saved.filter(x => typeof x === "string");
    } catch (e) { /* нет сохранённого — начинаем с пустого колеса */ }

    const SPIN_DURATION_MS = 5000;
    // Накопительный угол поворота колеса — колесо всегда крутится только
    // вперёд, без "отмотки" назад к началу перед следующим спином.
    let currentRotation = 0;

    function saveItems() {
        try { localStorage.setItem(RANDOMIZER_ITEMS_KEY, JSON.stringify(items)); } catch (e) { /* не критично */ }
    }

    // Пустое колесо рисуем серыми секторами-заглушками, чтобы было видно, что это
    function redraw() {
        if (items.length > 0) {
            drawRandomizerWheel(canvas, items);
            canvas.classList.remove("randomizer-wheel-empty");
        } else {
            drawRandomizerWheel(canvas, ["", "", "", "", "", ""]);
            canvas.classList.add("randomizer-wheel-empty");
        }
        canvas.style.transition = "none";
        canvas.style.transform = `rotate(${currentRotation}deg)`;
    }

    function renderChips() {
        chipsEl.innerHTML = "";
        items.forEach((item, i) => {
            const chip = document.createElement("span");
            chip.className = "rz-chip";
            chip.style.setProperty("--c", RANDOMIZER_WHEEL_COLORS[i % RANDOMIZER_WHEEL_COLORS.length]);
            const text = document.createElement("span");
            text.textContent = item;
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "ui-btn rz-chip-x";
            remove.textContent = "×";
            remove.title = "Убрать";
            remove.onclick = () => {
                if (isSpinning) return;
                items.splice(i, 1);
                update();
            };
            chip.append(text, remove);
            chipsEl.appendChild(chip);
        });
        pickBtn.disabled = items.length < 2;
        pickBtn.textContent = items.length < 2 ? "Добавьте хотя бы 2 варианта" : "Крутить";
    }

    function update() {
        resultEl.textContent = "";
        resultEl.classList.remove("randomizer-result-hit");
        saveItems();
        renderChips();
        redraw();
    }

    // Можно вставить сразу несколько вариантов через запятую
    overlay.querySelector("#randomizerAddForm").onsubmit = (e) => {
        e.preventDefault();
        if (isSpinning) return;
        const added = inputEl.value.split(",").map(s => s.trim()).filter(Boolean);
        if (added.length === 0) return;
        items.push(...added);
        inputEl.value = "";
        update();
    };

    if (hasWishlist) overlay.querySelector("#randomizerFromWishlist").onclick = () => {
        if (isSpinning) return;
        const wish = Array.from(wishlistTitles);
        if (wish.length === 0) return;
        // Колесо с сотней секторов нечитаемо — берём до 12 случайных
        items = wish.sort(() => Math.random() - 0.5).slice(0, 12).map(t => t.replace(/\s*\(\d{4}\)$/, ""));
        update();
    };

    overlay.querySelector("#randomizerClear").onclick = () => {
        if (isSpinning) return;
        items = [];
        update();
    };

    pickBtn.onclick = () => {
        if (isSpinning || items.length < 2) return;

        // Сброс визуальных следов предыдущей прокрутки
        resultEl.classList.remove("randomizer-result-hit");
        resultEl.textContent = "";
        glowEl.classList.remove("randomizer-wheel-glow-burst");
        wheelStage.classList.remove("randomizer-wheel-stage-flash");
        sparksEl.innerHTML = "";

        const winnerIndex = Math.floor(Math.random() * items.length);
        const segAngleDeg = 360 / items.length;
        // Небольшое случайное смещение внутри сектора-победителя —
        // указатель не всегда останавливается ровно по центру сектора.
        const jitter = (Math.random() - 0.5) * segAngleDeg * 0.7;
        const winnerCenterDeg = winnerIndex * segAngleDeg + segAngleDeg / 2 + jitter;

        // Указатель неподвижен и смотрит строго вверх (0°): доворачиваем
        // колесо так, чтобы сектор-победитель оказался под ним, + 6 оборотов
        const targetMod = (360 - winnerCenterDeg + 360) % 360;
        const currentMod = ((currentRotation % 360) + 360) % 360;
        currentRotation += 6 * 360 + ((targetMod - currentMod + 360) % 360);

        isSpinning = true;
        overlay.classList.add("rz-spinning");
        pickBtn.disabled = true;
        pickBtn.textContent = "Крутится…";

        void canvas.offsetWidth;
        canvas.style.transition = `transform ${SPIN_DURATION_MS / 1000}s cubic-bezier(0.16, 0.72, 0.14, 1)`;
        canvas.style.transform = `rotate(${currentRotation}deg)`;

        setTimeout(() => {
            isSpinning = false;
            overlay.classList.remove("rz-spinning");
            pickBtn.disabled = false;
            pickBtn.textContent = "Ещё раз";

            resultEl.textContent = "🎯 " + items[winnerIndex];
            resultEl.classList.add("randomizer-result-hit");
            vibrate([40, 30, 60]);

            // Вспышка на колесе, расширяющееся свечение и разлетающиеся искры
            void wheelStage.offsetWidth;
            wheelStage.classList.add("randomizer-wheel-stage-flash");
            glowEl.classList.add("randomizer-wheel-glow-burst");
            spawnRandomizerSparks(sparksEl);
        }, SPIN_DURATION_MS);
    };

    overlay.querySelector("#randomizerCloseBtn").onclick = () => { if (!isSpinning) overlay.remove(); };

    renderChips();
    // Колесо меряет свой размер по сцене — рисуем после того, как окно встало на место
    requestAnimationFrame(redraw);
}
