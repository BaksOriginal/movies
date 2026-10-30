// ==========================================
// pet.js — ОБЩИЙ ПИТОМЕЦ (тамагочи-монстрик)
// ==========================================
// Подключается на главной после script.js. Питомец один на двоих: его
// состояние лежит одной строкой в таблице pet (data jsonb) и обновляется
// у обоих в реальном времени. SQL для таблицы:
//
//   create table if not exists public.pet (
//     id integer primary key default 1,
//     data jsonb not null default '{}'::jsonb,
//     updated_at timestamptz not null default now()
//   );
//   alter table public.pet enable row level security;
//   create policy "pet_select" on public.pet for select to authenticated using (true);
//   create policy "pet_insert" on public.pet for insert to authenticated with check (true);
//   create policy "pet_update" on public.pet for update to authenticated using (true);
//   alter publication supabase_realtime add table public.pet;
//
// Пока таблицы нет, питомец живёт в localStorage этого браузера.
//
// Правила:
//   • опыт копится за заботу, уровень растёт, на уровнях 2/6/12/20 — новая форма;
//   • покормить — раз в день каждому из вас; убрать — раз в день (мусор
//     появляется каждое утро); гладить — сколько угодно, но опыта за это
//     в день даётся не больше PET_PET_DAILY_CAP;
//   • всего в день не больше PET_DAILY_XP_CAP опыта;
//   • питомец не умирает: если 3 дня никто не заходил, он просто замерзает
//     (опыт не теряется), любое действие его размораживает.

const PET_STAGES = [
    { name: "Яйцо", from: 1, hint: "Внутри что-то шевелится…" },
    { name: "Малыш", from: 2, hint: "Только вылупился и всё время хочет есть" },
    { name: "Подросток", from: 6, hint: "Отрастил рожки и хвост" },
    { name: "Взрослый", from: 12, hint: "Расправил крылья" },
    { name: "Легенда", from: 20, hint: "Корона — по праву" },
];
const PET_FEED_XP = 35;
const PET_CLEAN_XP = 30;
const PET_STROKE_XP = 3;
const PET_PET_DAILY_CAP = 45;   // опыта за поглаживания в день
const PET_DAILY_XP_CAP = 150;   // опыта всего в день
const PET_MESS_PER_DAY = 3;
const PET_FREEZE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const PET_LOCAL_KEY = "petState:v1";
const PET_MESS_ITEMS = [
    { emoji: "🧦", x: 16, y: 82 },
    { emoji: "🍕", x: 74, y: 88 },
    { emoji: "🧶", x: 46, y: 93 },
];

let petState = null;
let petStorage = "db";
let petSaveTimer = null;

function petDefaultState() {
    return {
        name: "Эчпочмоня",
        xp: 0,
        day: null,
        fedBy: [],
        cleaned: false,
        mess: 0,
        petXpToday: 0,
        xpToday: 0,
        lastActive: new Date().toISOString(),
        events: [],
    };
}

// ---------- Уровни ----------
function petXpForLevel(level) {
    return 50 + 20 * (level - 1);
}
function petLevelInfo(xp) {
    let level = 1, rest = xp;
    while (rest >= petXpForLevel(level)) {
        rest -= petXpForLevel(level);
        level++;
    }
    return { level, into: rest, need: petXpForLevel(level) };
}
function petStageIndex(level) {
    let idx = 0;
    PET_STAGES.forEach((s, i) => { if (level >= s.from) idx = i; });
    return idx;
}
function petIsFrozen() {
    return Date.now() - Date.parse(petState.lastActive || 0) > PET_FREEZE_AFTER_MS;
}

// ---------- Хранение ----------
async function loadPetState() {
    if (petState) {
        applyPetDailyReset();
        return petState;
    }
    let loaded = null;
    try {
        const { data, error } = await db.from("pet").select("data").eq("id", 1);
        if (error) throw error;
        petStorage = "db";
        loaded = data && data[0] && data[0].data;
    } catch (e) {
        // таблицы ещё нет — живём локально
        petStorage = "local";
        try { loaded = JSON.parse(localStorage.getItem(PET_LOCAL_KEY) || "null"); } catch (e2) { loaded = null; }
    }
    petState = Object.assign(petDefaultState(), loaded || {});
    applyPetDailyReset();
    return petState;
}

// Новый день: кормёжка и уборка снова доступны, лимиты обнуляются, утром
// в комнате опять немного мусора (замёрзший питомец не мусорит)
function applyPetDailyReset() {
    const today = todayDateKey();
    if (petState.day === today) return;
    petState.day = today;
    petState.fedBy = [];
    petState.cleaned = false;
    petState.mess = petIsFrozen() ? 0 : PET_MESS_PER_DAY;
    petState.petXpToday = 0;
    petState.xpToday = 0;
}

function savePetState() {
    clearTimeout(petSaveTimer);
    petSaveTimer = setTimeout(async () => {
        petSaveTimer = null;
        if (petStorage === "local") {
            try { localStorage.setItem(PET_LOCAL_KEY, JSON.stringify(petState)); } catch (e) { /* не критично */ }
            return;
        }
        const { error } = await db.from("pet").upsert({ id: 1, data: petState, updated_at: new Date().toISOString() });
        if (error) console.error("Не удалось сохранить питомца:", error.message);
    }, 400); // поглаживания идут очередью — пишем в базу одной записью
}

// Партнёр что-то сделал с питомцем — подхватываем (если у нас самих нет
// несохранённых изменений, иначе наша запись придёт следом и всё сравняет)
function onPetRealtimeChange(payload) {
    if (!payload || !payload.new || !payload.new.data || petSaveTimer) return;
    const prevLevel = petState ? petLevelInfo(petState.xp).level : null;
    petState = Object.assign(petDefaultState(), payload.new.data);
    applyPetDailyReset();
    refreshPetViews(prevLevel);
}

// ---------- Действия ----------
function petMyName() {
    return currentUser ? getUsernameFromEmail(currentUser.email) : "Кто-то";
}

function petGainXp(amount) {
    const allowed = Math.max(0, Math.min(amount, PET_DAILY_XP_CAP - petState.xpToday));
    petState.xp += allowed;
    petState.xpToday += allowed;
    return allowed;
}

function petLogEvent(text) {
    petState.events = [{ who: petMyName(), text, at: new Date().toISOString() }, ...(petState.events || [])].slice(0, 8);
}

// Любое действие будит питомца; возвращает true, если он был заморожен
function petTouch() {
    const wasFrozen = petIsFrozen();
    petState.lastActive = new Date().toISOString();
    return wasFrozen;
}

function petAfterAction(prevLevel, thawed) {
    savePetState();
    refreshPetViews(prevLevel);
    if (thawed) petCelebrate("Разморожен! ☀️", false);
}

function petFeed() {
    const me = currentUser ? currentUser.id : "me";
    if (petState.fedBy.includes(me)) {
        petSay("Я уже ел сегодня от тебя 😋 Завтра снова!");
        return;
    }
    const prevLevel = petLevelInfo(petState.xp).level;
    const thawed = petTouch();
    petState.fedBy.push(me);
    const got = petGainXp(PET_FEED_XP);
    petLogEvent("покормил(а)");
    petAnimate("is-eating", 1200);
    petEffect("🍖", "pet-fx-food");
    petSay(got ? `Ням! +${got} опыта` : "Ням! (лимит опыта на сегодня исчерпан)");
    petAfterAction(prevLevel, thawed);
}

function petCleanSpot() {
    if (petState.cleaned || petState.mess <= 0) {
        petSay("Тут и так чисто ✨");
        return;
    }
    const prevLevel = petLevelInfo(petState.xp).level;
    const thawed = petTouch();
    petState.mess--;
    petEffect("✨", "pet-fx-sparkle");
    if (petState.mess === 0) {
        petState.cleaned = true;
        const got = petGainXp(PET_CLEAN_XP);
        petLogEvent("навёл(а) порядок");
        petAnimate("is-happy", 1400);
        petSay(got ? `Чистота! +${got} опыта` : "Чистота! (лимит опыта на сегодня исчерпан)");
    }
    petAfterAction(prevLevel, thawed);
}

function petCleanAll() {
    if (petState.cleaned || petState.mess <= 0) {
        petSay("Тут и так чисто ✨");
        return;
    }
    const room = document.getElementById("petRoom");
    if (room) {
        room.classList.remove("is-sweeping");
        void room.offsetWidth;
        room.classList.add("is-sweeping");
    }
    while (petState.mess > 0) petCleanSpot();
}

function petStroke() {
    const prevLevel = petLevelInfo(petState.xp).level;
    const thawed = petTouch();
    const left = PET_PET_DAILY_CAP - petState.petXpToday;
    let got = 0;
    if (left > 0) {
        got = petGainXp(Math.min(PET_STROKE_XP, left));
        petState.petXpToday += got;
        if (petState.petXpToday >= PET_PET_DAILY_CAP) petLogEvent("наобнимал(а) на весь день");
    }
    petAnimate("is-happy", 900);
    petEffect("💗", "pet-fx-heart");
    vibrate(10);
    if (!got && left <= 0) petSay("Мур… На сегодня я уже наобнимался 💤");
    petAfterAction(prevLevel, thawed);
}

function petRename() {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
        <div class="modal-content pet-rename">
            <h3>Как назовём?</h3>
            <input type="text" id="petNameInput" maxlength="24" autocomplete="off">
            <div class="pet-rename-buttons">
                <button type="button" class="ui-btn ui-pill" id="petNameCancel">Отмена</button>
                <button type="button" class="ui-btn ui-pill ui-pill-accent" id="petNameSave">Сохранить</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector("#petNameInput");
    input.value = petState.name;
    const close = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay.querySelector("#petNameCancel").onclick = close;
    overlay.querySelector("#petNameSave").onclick = () => {
        const name = input.value.trim();
        if (name && name !== petState.name) {
            petState.name = name;
            petLogEvent(`назвал(а) питомца «${name}»`);
            savePetState();
            refreshPetViews(null);
        }
        close();
    };
}

// ---------- Монстрик: 5 форм в SVG ----------
// uid нужен, чтобы id градиентов не совпадали, когда на странице несколько монстриков
function petMonsterSvg(stage, uid) {
    const id = (n) => `pet${uid}${n}`;
    const palettes = [
        ["#d9b8ff", "#ff9fd2"],
        ["#b57bff", "#ff6fb5"],
        ["#9a5cff", "#ff4fa3"],
        ["#7f45f0", "#ff3d8f"],
        ["#8b3bff", "#ff2e93"],
    ];
    const [top, bottom] = palettes[stage];
    const defs = `
        <defs>
            <linearGradient id="${id("body")}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>
            </linearGradient>
            <radialGradient id="${id("shine")}" cx="0.35" cy="0.25" r="0.6">
                <stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
            </radialGradient>
            <radialGradient id="${id("aura")}" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0" stop-color="#ffd15c" stop-opacity="0.55"/><stop offset="0.6" stop-color="#ff2e93" stop-opacity="0.18"/><stop offset="1" stop-color="#ff2e93" stop-opacity="0"/>
            </radialGradient>
        </defs>`;

    const eyes = (cx1, cx2, cy, r) => `
        <g class="pet-eyes eyes-normal">
            <ellipse cx="${cx1}" cy="${cy}" rx="${r}" ry="${r * 1.15}" fill="#fff"/>
            <ellipse cx="${cx2}" cy="${cy}" rx="${r}" ry="${r * 1.15}" fill="#fff"/>
            <circle cx="${cx1 + r * 0.15}" cy="${cy + r * 0.15}" r="${r * 0.55}" fill="#1a0828"/>
            <circle cx="${cx2 + r * 0.15}" cy="${cy + r * 0.15}" r="${r * 0.55}" fill="#1a0828"/>
            <circle cx="${cx1 + r * 0.35}" cy="${cy - r * 0.15}" r="${r * 0.2}" fill="#fff"/>
            <circle cx="${cx2 + r * 0.35}" cy="${cy - r * 0.15}" r="${r * 0.2}" fill="#fff"/>
        </g>
        <g class="pet-eyes-happy" fill="none" stroke="#1a0828" stroke-width="${Math.max(3, r * 0.35)}" stroke-linecap="round">
            <path d="M${cx1 - r} ${cy + 2} Q${cx1} ${cy - r} ${cx1 + r} ${cy + 2}"/>
            <path d="M${cx2 - r} ${cy + 2} Q${cx2} ${cy - r} ${cx2 + r} ${cy + 2}"/>
        </g>`;
    const mouth = (cx, cy, w, fangs) => `
        <g class="mouth-normal">
            <path d="M${cx - w} ${cy} Q${cx} ${cy + w * 0.9} ${cx + w} ${cy}" fill="#3a0d2a" stroke="#1a0828" stroke-width="2.5" stroke-linejoin="round"/>
            ${fangs >= 1 ? `<path d="M${cx - w * 0.45} ${cy + 1} l3 7 l3 -6.5" fill="#fff"/>` : ""}
            ${fangs >= 2 ? `<path d="M${cx + w * 0.45 - 6} ${cy + 1} l3 7 l3 -6.5" fill="#fff"/>` : ""}
        </g>
        <ellipse class="mouth-open" cx="${cx}" cy="${cy + 4}" rx="${w * 0.55}" ry="${w * 0.6}" fill="#3a0d2a" stroke="#1a0828" stroke-width="2.5"/>`;
    const blush = (x1, x2, y) => `
        <ellipse cx="${x1}" cy="${y}" rx="9" ry="5" fill="#ff4fa3" opacity="0.45"/>
        <ellipse cx="${x2}" cy="${y}" rx="9" ry="5" fill="#ff4fa3" opacity="0.45"/>`;
    const shadow = `<ellipse class="pet-shadow" cx="100" cy="190" rx="${48 + stage * 6}" ry="8" fill="#000" opacity="0.35"/>`;

    let art = "";
    if (stage === 0) {
        art = `
            <g class="pet-body">
                <ellipse cx="100" cy="122" rx="52" ry="66" fill="url(#${id("body")})"/>
                <circle cx="78" cy="92" r="7" fill="#fff" opacity="0.3"/>
                <circle cx="124" cy="150" r="9" fill="#fff" opacity="0.25"/>
                <circle cx="118" cy="84" r="4" fill="#fff" opacity="0.3"/>
                <polyline points="50,124 66,112 80,128 96,112 110,128 126,112 140,126 150,118" fill="none" stroke="#3a1250" stroke-width="3.5" stroke-linejoin="round"/>
                ${eyes(86, 114, 140, 7)}
                <ellipse cx="100" cy="122" rx="52" ry="66" fill="url(#${id("shine")})"/>
            </g>`;
    } else if (stage === 1) {
        art = `
            <g class="pet-body">
                <ellipse cx="74" cy="184" rx="14" ry="7" fill="${bottom}"/>
                <ellipse cx="126" cy="184" rx="14" ry="7" fill="${bottom}"/>
                <path d="M84 98 l6 -16 l7 15 Z M103 97 l7 -15 l6 16 Z" fill="${top}"/>
                <path d="M46 182 Q36 108 100 94 Q164 108 154 182 Z" fill="url(#${id("body")})"/>
                ${eyes(80, 120, 132, 14)}
                ${blush(66, 134, 156)}
                ${mouth(100, 158, 9, 0)}
                <path d="M46 182 Q36 108 100 94 Q164 108 154 182 Z" fill="url(#${id("shine")})"/>
            </g>`;
    } else if (stage === 2) {
        art = `
            <g class="pet-body">
                <path d="M146 172 Q182 168 178 140 Q176 126 164 132" fill="none" stroke="${bottom}" stroke-width="9" stroke-linecap="round"/>
                <ellipse cx="72" cy="186" rx="15" ry="7" fill="${bottom}"/>
                <ellipse cx="128" cy="186" rx="15" ry="7" fill="${bottom}"/>
                <path d="M74 84 Q64 60 78 52 Q76 68 88 78 Z M126 84 Q136 60 122 52 Q124 68 112 78 Z" fill="#ffd15c"/>
                <ellipse cx="44" cy="140" rx="10" ry="18" fill="${top}" transform="rotate(20 44 140)"/>
                <ellipse cx="156" cy="140" rx="10" ry="18" fill="${top}" transform="rotate(-20 156 140)"/>
                <path d="M50 184 Q40 94 100 76 Q160 94 150 184 Z" fill="url(#${id("body")})"/>
                ${eyes(80, 120, 120, 13)}
                ${blush(64, 136, 146)}
                ${mouth(100, 148, 12, 1)}
                <path d="M50 184 Q40 94 100 76 Q160 94 150 184 Z" fill="url(#${id("shine")})"/>
            </g>`;
    } else {
        const legend = stage === 4;
        const wingEdge = legend ? "#2ee8ff" : "#ff7fc4";
        art = `
            ${legend ? `<circle class="pet-aura" cx="100" cy="112" r="96" fill="url(#${id("aura")})"/>` : ""}
            <g class="pet-body">
                <g class="pet-wings">
                    <path d="M58 112 Q14 64 4 98 Q22 100 18 118 Q34 112 36 132 Q46 120 58 128 Z" fill="#3a1250" stroke="${wingEdge}" stroke-width="3" stroke-linejoin="round"/>
                    <path d="M142 112 Q186 64 196 98 Q178 100 182 118 Q166 112 164 132 Q154 120 142 128 Z" fill="#3a1250" stroke="${wingEdge}" stroke-width="3" stroke-linejoin="round"/>
                </g>
                <path d="M150 174 Q190 172 188 138 Q186 120 170 126" fill="none" stroke="${bottom}" stroke-width="10" stroke-linecap="round"/>
                <path d="M66 190 l-6 -4 l4 -10 h16 l4 10 l-6 4 Z M134 190 l6 -4 l-4 -10 h-16 l-4 10 l6 4 Z" fill="${bottom}"/>
                <path d="M70 74 Q48 46 62 26 Q66 50 86 64 Z M130 74 Q152 46 138 26 Q134 50 114 64 Z" fill="#ffd15c"/>
                <ellipse cx="42" cy="134" rx="11" ry="22" fill="${top}" transform="rotate(24 42 134)"/>
                <ellipse cx="158" cy="134" rx="11" ry="22" fill="${top}" transform="rotate(-24 158 134)"/>
                <path d="M48 184 Q32 80 100 58 Q168 80 152 184 Z" fill="url(#${id("body")})"/>
                <ellipse cx="100" cy="152" rx="32" ry="26" fill="#ffffff" opacity="0.18"/>
                ${eyes(80, 120, 108, 13)}
                ${blush(62, 138, 134)}
                ${mouth(100, 136, 15, 2)}
                <path d="M48 184 Q32 80 100 58 Q168 80 152 184 Z" fill="url(#${id("shine")})"/>
                ${legend ? `
                <g class="pet-crown">
                    <path d="M72 58 L76 30 L88 46 L100 24 L112 46 L124 30 L128 58 Z" fill="#ffd15c" stroke="#ffb020" stroke-width="2" stroke-linejoin="round"/>
                    <circle cx="100" cy="46" r="4" fill="#ff2e93"/><circle cx="84" cy="52" r="3" fill="#2ee8ff"/><circle cx="116" cy="52" r="3" fill="#2ee8ff"/>
                </g>` : ""}
            </g>
            ${legend ? `<g class="pet-orbit"><circle cx="100" cy="16" r="3.5" fill="#ffd15c"/><circle cx="188" cy="112" r="3" fill="#2ee8ff"/><circle cx="12" cy="112" r="3" fill="#ff7fc4"/></g>` : ""}`;
    }
    return `<svg class="pet-svg pet-stage-${stage}" viewBox="0 0 200 200" aria-hidden="true">${defs}${shadow}${art}</svg>`;
}

// ---------- Комната ----------
// Комната питомца нарисована в том же стиле, что и комната на главной;
// за окном то же время суток. Поверх неё живут сам питомец, мусор и эффекты.
function petRoomSvg() {
    const day = typeof roomIsDay === "function" ? roomIsDay() : true;
    const wallA = day ? "#6a5a80" : "#2c2040", wallB = day ? "#4c3f66" : "#1a1229";
    const floorA = day ? "#5d3c22" : "#33201a", floorB = day ? "#311e11" : "#170e09";
    const skyA = day ? "#58a7e8" : "#060a24", skyB = day ? "#bce3f7" : "#33245f";
    const town = day ? "#4a5578" : "#0a0a1c";
    return `
    <svg class="pet-room-svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
            <linearGradient id="prWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${wallA}"/><stop offset="1" stop-color="${wallB}"/></linearGradient>
            <linearGradient id="prFloor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${floorA}"/><stop offset="1" stop-color="${floorB}"/></linearGradient>
            <linearGradient id="prSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${skyA}"/><stop offset="1" stop-color="${skyB}"/></linearGradient>
            <radialGradient id="prLamp" cx="0.5" cy="0" r="1"><stop offset="0" stop-color="#ffc66e" stop-opacity="${day ? 0.12 : 0.34}"/><stop offset="1" stop-color="#ffc66e" stop-opacity="0"/></radialGradient>
        </defs>

        <!-- стена и пол -->
        <rect width="400" height="214" fill="url(#prWall)"/>
        <rect y="214" width="400" height="86" fill="url(#prFloor)"/>
        ${[90, 180, 270, 360].map(x => `<line x1="${x}" y1="214" x2="${x}" y2="300" stroke="#000" stroke-opacity="0.25" stroke-width="2"/>`).join("")}
        ${[240, 268].map(y => `<line x1="0" y1="${y}" x2="400" y2="${y}" stroke="#000" stroke-opacity="0.16"/>`).join("")}
        <rect y="209" width="400" height="5" fill="#2b1a0f"/>

        <!-- окно -->
        <g transform="translate(26 40)">
            <rect x="-5" y="-5" width="114" height="102" rx="2" fill="#3f2a18"/>
            <rect width="104" height="92" fill="url(#prSky)"/>
            <circle cx="72" cy="24" r="11" fill="${day ? "#fff4bb" : "#f3f1ff"}"/>
            <path d="M0 92 V68 h16 V52 h16 V72 h22 V44 h18 V62 h32 V92 Z" fill="${town}"/>
            ${day ? "" : `<g fill="#f5c86a"><rect x="20" y="58" width="2" height="2"/><rect x="26" y="66" width="2" height="2"/><rect x="60" y="52" width="2" height="2"/><rect x="66" y="60" width="2" height="2"/><rect x="80" y="70" width="2" height="2"/><rect x="92" y="76" width="2" height="2"/></g>`}
            <path d="M52 0V92M0 40H104" stroke="#3f2a18" stroke-width="4"/>
            <path d="M0 0H15V92H0Z M89 0H104V92H89Z" fill="#a53c66"/>
            <path d="M5 0V92M10 0V92M94 0V92M99 0V92" stroke="#752746" stroke-width="1.5"/>
        </g>

        <!-- картинка с сердцем -->
        <g transform="translate(160 50)">
            <rect width="52" height="62" rx="2" fill="#2b1a0f"/>
            <rect x="5" y="5" width="42" height="52" fill="#2b1040"/>
            <path d="M26 45S11 36 11 25.500a8 8 0 0 1 15-4.500 8 8 0 0 1 15 4.500C41 36 26 45 26 45z" fill="#ff2e93"/>
        </g>

        <!-- полка с кассетами и цветком -->
        <g transform="translate(244 104)">
            <rect x="0" y="40" width="112" height="7" fill="#74492a"/>
            <rect x="0" y="47" width="112" height="3" fill="#4e3019"/>
            <rect x="8" y="10" width="11" height="30" fill="#d8132f"/><rect x="21" y="6" width="11" height="34" fill="#2f80ff"/>
            <rect x="34" y="11" width="11" height="29" fill="#1fbf6a"/><rect x="47" y="8" width="11" height="32" fill="#ff7a00"/>
            <g fill="#f4f1e6"><rect x="10" y="14" width="7" height="5"/><rect x="23" y="10" width="7" height="5"/><rect x="36" y="15" width="7" height="5"/><rect x="49" y="12" width="7" height="5"/></g>
            <path d="M80 40 h20 l-3 -15 h-14 Z" fill="#b5613a"/>
            <path d="M90 25 Q76 8 83 0 Q90 8 90 25 Q100 5 108 6 Q101 15 90 25" fill="#3fa96a"/>
        </g>

        <!-- торшер -->
        <g transform="translate(366 92)">
            <path d="M-46 30 L46 30 L92 200 L-92 200 Z" fill="url(#prLamp)"/>
            <path d="M-11 0h22l10 32h-42z" fill="#ffd98f"/>
            <path d="M-11 0h22l2 6h-26z" fill="#c9974f"/>
            <rect x="-2" y="32" width="4" height="140" fill="#6d6256"/>
            <ellipse cx="0" cy="176" rx="17" ry="6" fill="#3a3129"/>
        </g>

        <!-- ковёр -->
        <ellipse cx="200" cy="262" rx="150" ry="30" fill="#3a1f5e"/>
        <ellipse cx="200" cy="262" rx="132" ry="24" fill="none" stroke="#ff7fc4" stroke-width="2.5"/>
        <ellipse cx="200" cy="262" rx="102" ry="17" fill="#4c2878"/>

        <!-- лежанка -->
        <g transform="translate(66 240)">
            <ellipse cx="0" cy="14" rx="46" ry="16" fill="#74492a"/>
            <ellipse cx="0" cy="9" rx="39" ry="11" fill="#a53c66"/>
            <ellipse cx="0" cy="7" rx="27" ry="7" fill="#ff7fc4"/>
        </g>

        <!-- миска -->
        <g transform="translate(316 256)">
            <path d="M-22 0 h44 l-6 14 h-32 Z" fill="#d8132f"/>
            <ellipse cx="0" cy="0" rx="22" ry="5" fill="#7a1a30"/>
            <g class="pet-bowl-food">
                <circle cx="-8" cy="-3" r="5" fill="#ffb347"/><circle cx="2" cy="-5" r="5" fill="#ff8a3d"/><circle cx="10" cy="-2" r="4.5" fill="#ffb347"/>
            </g>
        </g>
    </svg>`;
}

// ---------- Страница питомца ----------
let petUidSeq = 0;
function petUid() {
    return ++petUidSeq;
}

async function showPetScreen() {
    setShellSection("pet");
    app.innerHTML = `<div class="ui-empty">Будим питомца…</div>`;
    await loadPetState();
    if (document.body.dataset.section !== "pet") return;

    app.innerHTML = `
        <div class="pet-page">
            <div class="pet-scene">
                <div class="pet-room" id="petRoom">
                    ${petRoomSvg()}
                    <div class="pet-sign" id="petSign"></div>
                    <div class="pet-mess" id="petMess"></div>
                    <button type="button" class="ui-btn pet-actor" id="petActor" aria-label="Погладить"></button>
                    <div class="pet-ice" aria-hidden="true">❄️</div>
                    <div class="pet-fx" id="petFx"></div>
                    <div class="pet-bubble" id="petBubble"></div>
                    <div class="pet-broom" aria-hidden="true">🧹</div>
                </div>
            </div>
            <div class="pet-panel">
                <div class="pet-head">
                    <button type="button" class="ui-btn pet-name" id="petName" title="Переименовать"></button>
                    <div class="pet-stage-line" id="petStageLine"></div>
                </div>
                <div class="pet-bar">
                    <div class="pet-bar-label"><span>До следующего уровня</span><b id="petXpText"></b></div>
                    <div class="pet-bar-track"><div class="pet-bar-fill" id="petXpFill"></div></div>
                </div>
                <div class="pet-bar pet-bar-daily">
                    <div class="pet-bar-label"><span>Опыт сегодня</span><b id="petDailyText"></b></div>
                    <div class="pet-bar-track"><div class="pet-bar-fill" id="petDailyFill"></div></div>
                </div>
                <div class="pet-frozen-note" id="petFrozenNote">❄️ Питомец замёрз — сюда давно никто не заходил. Погладь его, чтобы разморозить. Опыт никуда не делся.</div>
                <div class="pet-actions">
                    <button type="button" class="ui-btn pet-action" id="petFeedBtn"><span class="pet-action-icon">🍖</span><span class="pet-action-title">Покормить</span><span class="pet-action-sub" id="petFeedSub"></span></button>
                    <button type="button" class="ui-btn pet-action" id="petCleanBtn"><span class="pet-action-icon">🧹</span><span class="pet-action-title">Убрать</span><span class="pet-action-sub" id="petCleanSub"></span></button>
                    <button type="button" class="ui-btn pet-action" id="petStrokeBtn"><span class="pet-action-icon">✋</span><span class="pet-action-title">Погладить</span><span class="pet-action-sub" id="petStrokeSub"></span></button>
                </div>
                <div class="pet-stages" id="petStages"></div>
                <div class="pet-log" id="petLog"></div>
                ${petStorage === "local" ? `<p class="pet-local-note">Питомец пока живёт только в этом браузере: таблицы <code>pet</code> в базе ещё нет.</p>` : ""}
            </div>
        </div>
    `;

    document.getElementById("petActor").onclick = petStroke;
    document.getElementById("petFeedBtn").onclick = petFeed;
    document.getElementById("petCleanBtn").onclick = petCleanAll;
    document.getElementById("petStrokeBtn").onclick = petStroke;
    document.getElementById("petName").onclick = petRename;

    renderPetPage(true);
    petSay(petIsFrozen() ? "Брр… холодно…" : ["Привет! 👋", "Я соскучился!", "Поиграем?"][Math.floor(Math.random() * 3)]);
}

function renderPetPage(forceActor) {
    const page = document.querySelector(".pet-page");
    if (!page || !petState) return;
    const info = petLevelInfo(petState.xp);
    const stage = petStageIndex(info.level);
    const frozen = petIsFrozen();
    const me = currentUser ? currentUser.id : "me";

    const actor = document.getElementById("petActor");
    if (forceActor || actor.dataset.stage !== String(stage)) {
        actor.innerHTML = petMonsterSvg(stage, petUid());
        actor.dataset.stage = String(stage);
    }
    document.getElementById("petRoom").classList.toggle("is-frozen", frozen);
    document.getElementById("petRoom").classList.toggle("bowl-full", petState.fedBy.length > 0);
    document.getElementById("petFrozenNote").hidden = !frozen;

    document.getElementById("petSign").textContent = petState.name;
    document.getElementById("petName").textContent = petState.name + " ✎";
    document.getElementById("petStageLine").textContent = `Уровень ${info.level} · ${PET_STAGES[stage].name} — ${PET_STAGES[stage].hint.toLowerCase()}`;
    document.getElementById("petXpText").textContent = `${info.into} / ${info.need}`;
    document.getElementById("petXpFill").style.width = (info.into / info.need * 100) + "%";
    document.getElementById("petDailyText").textContent = `${petState.xpToday} / ${PET_DAILY_XP_CAP}`;
    document.getElementById("petDailyFill").style.width = (petState.xpToday / PET_DAILY_XP_CAP * 100) + "%";

    const fedByMe = petState.fedBy.includes(me);
    document.getElementById("petFeedBtn").classList.toggle("is-done", fedByMe);
    document.getElementById("petFeedSub").textContent = fedByMe ? "Ты уже кормил(а) — завтра снова" : `+${PET_FEED_XP} опыта · раз в день`;
    document.getElementById("petCleanBtn").classList.toggle("is-done", petState.cleaned);
    document.getElementById("petCleanSub").textContent = petState.cleaned ? "Чисто ✨ Завтра опять насорит" : `Мусора: ${petState.mess} · +${PET_CLEAN_XP} опыта`;
    const strokeLeft = Math.max(0, PET_PET_DAILY_CAP - petState.petXpToday);
    document.getElementById("petStrokeBtn").classList.toggle("is-done", strokeLeft === 0);
    document.getElementById("petStrokeSub").textContent = strokeLeft ? `+${PET_STROKE_XP} · ещё ${strokeLeft} опыта сегодня` : "Наобнимался на сегодня";

    // мусор на полу
    const messBox = document.getElementById("petMess");
    messBox.innerHTML = "";
    PET_MESS_ITEMS.slice(0, petState.cleaned ? 0 : petState.mess).forEach(item => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn pet-mess-item";
        btn.style.left = item.x + "%";
        btn.style.top = item.y + "%";
        btn.textContent = item.emoji;
        btn.title = "Убрать";
        btn.onclick = (e) => { e.stopPropagation(); petCleanSpot(); };
        messBox.appendChild(btn);
    });

    // дорожка стадий
    document.getElementById("petStages").innerHTML = PET_STAGES.map((s, i) => `
        <div class="pet-stage ${i < stage ? "is-past" : ""} ${i === stage ? "is-current" : ""}">
            <div class="pet-stage-art">${i <= stage ? petMonsterSvg(i, petUid()) : "<span>?</span>"}</div>
            <div class="pet-stage-name">${s.name}</div>
            <div class="pet-stage-lvl">ур. ${s.from}</div>
        </div>`).join("");

    // кто что делал
    const log = document.getElementById("petLog");
    const events = petState.events || [];
    log.innerHTML = events.length ? `<div class="pet-log-title">Недавно</div>` : "";
    events.slice(0, 5).forEach(ev => {
        const row = document.createElement("div");
        row.className = "pet-log-row";
        const when = new Date(ev.at);
        row.textContent = `${ev.who} ${ev.text}`;
        const time = document.createElement("span");
        time.textContent = when.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        row.appendChild(time);
        log.appendChild(row);
    });
}

// Обновляет всё, где показан питомец (страница и виджет на главной),
// и празднует новый уровень / новую форму
function refreshPetViews(prevLevel) {
    renderPetPage(false);
    refreshPetWidget();
    if (prevLevel == null) return;
    const level = petLevelInfo(petState.xp).level;
    if (level > prevLevel) {
        const evolved = petStageIndex(level) > petStageIndex(prevLevel);
        petCelebrate(evolved ? `✨ Эволюция: ${PET_STAGES[petStageIndex(level)].name}!` : `Уровень ${level}!`, evolved);
    }
}

// ---------- Анимации и реплики ----------
function petAnimate(cls, ms) {
    const actor = document.getElementById("petActor");
    if (!actor) return;
    actor.classList.remove(cls);
    void actor.offsetWidth;
    actor.classList.add(cls);
    clearTimeout(actor["_t" + cls]);
    actor["_t" + cls] = setTimeout(() => actor.classList.remove(cls), ms);
}

function petEffect(emoji, cls) {
    const fx = document.getElementById("petFx");
    if (!fx) return;
    for (let i = 0; i < (cls === "pet-fx-heart" ? 3 : 5); i++) {
        const el = document.createElement("span");
        el.className = "pet-fx-item " + cls;
        el.textContent = emoji;
        el.style.left = (42 + Math.random() * 16) + "%";
        el.style.animationDelay = (i * 0.08) + "s";
        el.style.setProperty("--dx", (Math.random() * 60 - 30) + "px");
        fx.appendChild(el);
        setTimeout(() => el.remove(), 1400);
    }
}

let petBubbleTimer = null;
function petSay(text) {
    const bubble = document.getElementById("petBubble");
    if (!bubble) return;
    bubble.textContent = text;
    bubble.classList.add("is-visible");
    clearTimeout(petBubbleTimer);
    petBubbleTimer = setTimeout(() => bubble.classList.remove("is-visible"), 2600);
}

function petCelebrate(text, big) {
    const room = document.getElementById("petRoom");
    if (!room) return;
    const banner = document.createElement("div");
    banner.className = "pet-celebrate" + (big ? " is-big" : "");
    banner.textContent = text;
    room.appendChild(banner);
    petEffect("⭐", "pet-fx-sparkle");
    setTimeout(() => petEffect("✨", "pet-fx-sparkle"), 250);
    vibrate([30, 40, 60]);
    setTimeout(() => banner.remove(), big ? 2600 : 1800);
}

// ---------- Виджет на главной ----------
function buildPetWidget() {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "ui-btn pet-widget";
    card.id = "petWidget";
    card.innerHTML = `<div class="ui-empty">…</div>`;
    card.onclick = () => navigateFromShell("pet");
    loadPetState().then(() => refreshPetWidget());
    return card;
}

function refreshPetWidget() {
    const card = document.getElementById("petWidget");
    if (!card || !petState) return;
    const info = petLevelInfo(petState.xp);
    const stage = petStageIndex(info.level);
    const frozen = petIsFrozen();
    const me = currentUser ? currentUser.id : "me";
    const needs = [
        petState.fedBy.includes(me) ? "🍖 ✓" : "🍖 голоден",
        petState.cleaned ? "🧹 ✓" : `🧹 ${petState.mess}`,
        petState.petXpToday >= PET_PET_DAILY_CAP ? "✋ ✓" : "✋ погладь",
    ];
    card.classList.toggle("is-frozen", frozen);
    card.innerHTML = `
        <div class="pet-widget-art">${petMonsterSvg(stage, petUid())}</div>
        <div class="pet-widget-body">
            <div class="pet-widget-kicker">${frozen ? "❄️ Замёрз — загляни к нему" : "Ваш питомец"}</div>
            <div class="pet-widget-name"></div>
            <div class="pet-widget-stage">Ур. ${info.level} · ${PET_STAGES[stage].name}</div>
            <div class="pet-widget-bar"><div style="width:${info.into / info.need * 100}%"></div></div>
            <div class="pet-widget-needs">${needs.map(n => `<span>${n}</span>`).join("")}</div>
        </div>
        <span class="pet-widget-go">›</span>
    `;
    card.querySelector(".pet-widget-name").textContent = petState.name;
}
