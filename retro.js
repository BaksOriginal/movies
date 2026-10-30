// ==========================================
// retro.js — ЗВУКИ ВЕЩЕЙ, ТЕЛЕВИЗОР, КАССЕТА
// ==========================================
// Общий модуль для главной, совместного просмотра и доски. Файлов нет: звуки
// синтезируются через Web Audio, картинка каналов рисуется на маленьком
// холсте (160×100, 12 кадров в секунду) — это и выглядит как старый телевизор,
// и почти не нагружает устройство.
//
//   thingSound(name)      — короткий звук предмета (кассета, бумага, щелчок…);
//   mountRetroTv(host)    — экран с каналами: помехи, лес, океан, город;
//   openCassetteDialog()  — окно-кассета для вставки ссылки или кода плеера;
//   cassetteFlyInto()     — кассета летит в щель видеомагнитофона.

const RETRO_MUTE_KEY = "thingsMuted";
const RETRO_CHANNEL_KEY = "tvChannel";
const RETRO_VOLUME_KEY = "tvVolume";
const RETRO_PENDING_KEY = "wpPendingSource";    // ссылка, вставленная в кассету на главной
const RETRO_TV_W = 160;
const RETRO_TV_H = 100;
const RETRO_TV_FPS = 12;
const RETRO_CHANNELS = [
    { id: "noise", label: "ПОМЕХИ" },
    { id: "forest", label: "ЛЕС, ДОЖДЬ" },
    { id: "ocean", label: "ОКЕАН" },
    { id: "city", label: "НОЧНОЙ ГОРОД" },
];

// ---------- Звук: общий контекст ----------
let retroAudioCtx = null;
let retroNoiseBuffers = null;

function retroCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!retroAudioCtx) retroAudioCtx = new AC();
    if (retroAudioCtx.state === "suspended") retroAudioCtx.resume().catch(() => {});
    return retroAudioCtx;
}

// Закольцованный шум: белый и «коричневый» (глухой, как прибой и гул города)
function retroNoise(ctx, kind) {
    if (!retroNoiseBuffers) {
        const len = ctx.sampleRate * 3;
        const white = ctx.createBuffer(1, len, ctx.sampleRate);
        const brown = ctx.createBuffer(1, len, ctx.sampleRate);
        const w = white.getChannelData(0), b = brown.getChannelData(0);
        let last = 0;
        for (let i = 0; i < len; i++) {
            const r = Math.random() * 2 - 1;
            w[i] = r;
            last = (last + 0.02 * r) / 1.02;
            b[i] = last * 3.5;
        }
        retroNoiseBuffers = { white, brown };
    }
    const src = ctx.createBufferSource();
    src.buffer = retroNoiseBuffers[kind];
    src.loop = true;
    return src;
}

function retroFilter(ctx, type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q) f.Q.value = q;
    return f;
}

// ---------- Звуки вещей ----------
function thingsMuted() {
    try { return localStorage.getItem(RETRO_MUTE_KEY) === "1"; } catch (e) { return false; }
}
function setThingsMuted(v) {
    try { localStorage.setItem(RETRO_MUTE_KEY, v ? "1" : "0"); } catch (e) {}
}

// Короткий всплеск шума: шелест, щелчок, стук
function retroBurst(ctx, at, dur, { type = "bandpass", freq = 1000, q = 1, vol = 0.2, kind = "white", sweep = 0 }) {
    const src = retroNoise(ctx, kind);
    const f = retroFilter(ctx, type, freq, q);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + Math.min(0.012, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, at + dur);
    src.connect(f); f.connect(g); g.connect(ctx.destination);
    src.start(at, Math.random() * 2);
    src.stop(at + dur + 0.02);
}

function retroThunk(ctx, at, freq, dur, vol) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(freq, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * 0.5), at + dur);
    g.gain.setValueAtTime(vol, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(at);
    o.stop(at + dur + 0.02);
}

let retroLastThingAt = 0;

function thingSound(name) {
    if (thingsMuted()) return;
    const ctx = retroCtx();
    if (!ctx) return;
    retroLastThingAt = performance.now();
    const t = ctx.currentTime + 0.005;
    switch (name) {
        case "tick":    // любая кнопка: еле слышный щелчок
            retroBurst(ctx, t, 0.018, { freq: 2100, q: 3, vol: 0.05 });
            break;
        case "card":    // карта ложится на стол
            retroBurst(ctx, t, 0.07, { type: "highpass", freq: 2200, vol: 0.07, sweep: 900 });
            retroThunk(ctx, t + 0.03, 210, 0.04, 0.05);
            break;
        case "clack":   // фишка стукнула о доску
            retroThunk(ctx, t, 720, 0.04, 0.12);
            retroBurst(ctx, t, 0.025, { freq: 3000, q: 2, vol: 0.09 });
            break;
        case "pencil":  // карандаш по бумаге
            retroBurst(ctx, t, 0.07, { freq: 3600, q: 1.5, vol: 0.05, sweep: 2600 });
            break;
        case "erase":
            retroBurst(ctx, t, 0.1, { type: "lowpass", freq: 1500, vol: 0.05 });
            break;
        case "win":
            [523, 659, 784, 1047].forEach((f, k) => retroThunk(ctx, t + k * 0.09, f, 0.16, 0.07));
            break;
        case "tape":    // кассету достали с полки: пластиковый стук
            retroBurst(ctx, t, 0.05, { freq: 2200, q: 2, vol: 0.12 });
            retroThunk(ctx, t, 190, 0.09, 0.14);
            retroBurst(ctx, t + 0.07, 0.04, { freq: 3200, q: 3, vol: 0.06 });
            break;
        case "paper":   // шелест заметки
            retroBurst(ctx, t, 0.16, { type: "highpass", freq: 2600, vol: 0.05, sweep: 5200 });
            break;
        case "pin":     // иголка входит в пробку
            retroBurst(ctx, t, 0.03, { freq: 4200, q: 4, vol: 0.12 });
            retroThunk(ctx, t, 420, 0.05, 0.06);
            break;
        case "switch":  // выключатель
            retroBurst(ctx, t, 0.025, { freq: 3400, q: 2, vol: 0.2 });
            retroThunk(ctx, t, 260, 0.04, 0.12);
            break;
        case "knob":    // ручка телевизора
            retroBurst(ctx, t, 0.02, { freq: 2600, q: 5, vol: 0.14 });
            retroBurst(ctx, t + 0.045, 0.02, { freq: 1900, q: 5, vol: 0.1 });
            break;
        case "soft":    // любой мягкий предмет в комнате
            retroThunk(ctx, t, 150, 0.08, 0.1);
            retroBurst(ctx, t, 0.05, { type: "lowpass", freq: 900, vol: 0.08 });
            break;
        case "insert":  // кассета уезжает в видик: шуршание, мотор, щелчок
            retroBurst(ctx, t, 0.42, { freq: 900, q: 1, vol: 0.05, sweep: 1500 });
            retroThunk(ctx, t + 0.05, 95, 0.4, 0.06);
            retroBurst(ctx, t + 0.44, 0.04, { freq: 2400, q: 2, vol: 0.2 });
            retroThunk(ctx, t + 0.44, 170, 0.1, 0.18);
            break;
        case "eject":
            retroBurst(ctx, t, 0.04, { freq: 2400, q: 2, vol: 0.16 });
            retroBurst(ctx, t + 0.05, 0.3, { freq: 1400, q: 1, vol: 0.05, sweep: 800 });
            retroThunk(ctx, t + 0.34, 150, 0.08, 0.14);
            break;
    }
}

// Любая кнопка без своего звука тихо щёлкает. Слушаем в конце всплытия: если
// обработчик уже сыграл свой звук, второй не добавляем.
document.addEventListener("click", (e) => {
    if (!e.target.closest || !e.target.closest("button, a, label, select, .movie-item, .chip, .calendar-day-active")) return;
    if (performance.now() - retroLastThingAt > 60) thingSound("tick");
});

// ---------- Атмосферный звук каналов ----------
const retroAmbience = { stop: null, gain: null };

function retroVolume() {
    try {
        const v = parseFloat(localStorage.getItem(RETRO_VOLUME_KEY));
        return v >= 0 && v <= 1 ? v : 0.3;
    } catch (e) { return 0.3; }
}
function setRetroVolume(v) {
    try { localStorage.setItem(RETRO_VOLUME_KEY, String(v)); } catch (e) {}
    if (retroAmbience.gain && retroAudioCtx) retroAmbience.gain.gain.setTargetAtTime(v * 0.5, retroAudioCtx.currentTime, 0.05);
}

function ambienceStop() {
    if (retroAmbience.stop) retroAmbience.stop();
    retroAmbience.stop = null;
    retroAmbience.gain = null;
}

function ambiencePlay(id) {
    ambienceStop();
    const ctx = retroCtx();
    if (!ctx) return;
    const master = ctx.createGain();
    master.gain.value = 0.0001;
    master.gain.setTargetAtTime(retroVolume() * 0.5, ctx.currentTime, 0.25);
    master.connect(ctx.destination);
    const nodes = [], timers = [];
    let live = true;

    const loop = (kind, gainValue, ...filters) => {
        const src = retroNoise(ctx, kind);
        const g = ctx.createGain();
        g.gain.value = gainValue;
        let tail = src;
        filters.forEach((f) => { tail.connect(f); tail = f; });
        tail.connect(g);
        g.connect(master);
        src.start(0, Math.random() * 2);
        nodes.push(src);
        return g;
    };
    const lfo = (param, freq, depth) => {
        const o = ctx.createOscillator();
        const d = ctx.createGain();
        o.frequency.value = freq;
        d.gain.value = depth;
        o.connect(d); d.connect(param);
        o.start();
        nodes.push(o);
    };
    // Случайные одиночные звуки (птицы, машины)
    const every = (minMs, maxMs, fn) => {
        const tick = () => {
            if (!live) return;
            fn();
            timers.push(setTimeout(tick, minMs + Math.random() * (maxMs - minMs)));
        };
        timers.push(setTimeout(tick, minMs * Math.random()));
    };
    const tone = (type, from, to, dur, vol, at) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(from, at);
        o.frequency.exponentialRampToValueAtTime(to, at + dur);
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(vol, at + dur * 0.25);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        o.connect(g); g.connect(master);
        o.start(at);
        o.stop(at + dur + 0.02);
    };

    if (id === "noise") {
        loop("white", 0.16, retroFilter(ctx, "highpass", 500), retroFilter(ctx, "lowpass", 7500));
    } else if (id === "forest") {
        loop("white", 0.3, retroFilter(ctx, "highpass", 1400), retroFilter(ctx, "lowpass", 8000));
        loop("brown", 0.5, retroFilter(ctx, "lowpass", 500));
        every(3500, 9000, () => {    // редкая птица за дождём
            const at = ctx.currentTime;
            const base = 2400 + Math.random() * 1400;
            for (let k = 0; k < 2 + Math.floor(Math.random() * 3); k++) {
                tone("sine", base, base * 0.8, 0.09, 0.022, at + k * 0.13);
            }
        });
    } else if (id === "ocean") {
        const body = loop("brown", 0.9, retroFilter(ctx, "lowpass", 800));
        const foam = loop("white", 0.06, retroFilter(ctx, "bandpass", 2400, 0.5));
        lfo(body.gain, 0.11, 0.5);
        lfo(foam.gain, 0.11, 0.05);
    } else if (id === "city") {
        loop("brown", 0.7, retroFilter(ctx, "lowpass", 350));
        every(3000, 8000, () => {    // проезжающая машина
            const at = ctx.currentTime;
            const dur = 2.5 + Math.random() * 2;
            const src = retroNoise(ctx, "white");
            const f = retroFilter(ctx, "bandpass", 300, 0.8);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, at);
            g.gain.exponentialRampToValueAtTime(0.09, at + dur * 0.5);
            g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
            f.frequency.setValueAtTime(420, at);
            f.frequency.exponentialRampToValueAtTime(240, at + dur);
            src.connect(f); f.connect(g); g.connect(master);
            src.start(at, Math.random() * 2);
            src.stop(at + dur + 0.05);
        });
        every(14000, 30000, () => {  // далёкий гудок
            tone("sawtooth", 330, 320, 0.5, 0.008, ctx.currentTime);
        });
    }

    retroAmbience.gain = master;
    retroAmbience.stop = () => {
        live = false;
        timers.forEach(clearTimeout);
        const now = ctx.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(0.0001, now, 0.08);
        setTimeout(() => {
            nodes.forEach((n) => { try { n.stop(); } catch (e) {} });
            try { master.disconnect(); } catch (e) {}
        }, 400);
    };
}

// Вкладка скрыта — звук каналов замолкает вместе с картинкой
document.addEventListener("visibilitychange", () => {
    if (!retroAudioCtx || !retroAmbience.stop) return;
    if (document.hidden) retroAudioCtx.suspend().catch(() => {});
    else retroAudioCtx.resume().catch(() => {});
});

// ---------- Картинка каналов ----------
function retroSeeded(seed) {
    let s = seed;
    return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

function retroLayer(paint) {
    const c = document.createElement("canvas");
    c.width = RETRO_TV_W; c.height = RETRO_TV_H;
    paint(c.getContext("2d"), RETRO_TV_W, RETRO_TV_H);
    return c;
}

function retroGradient(ctx, h, stops) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    stops.forEach(([at, col]) => g.addColorStop(at, col));
    return g;
}

const RETRO_SCENES = {
    noise() {
        let img = null;
        return (ctx, t, W, H) => {
            if (!img) img = ctx.createImageData(W, H);
            const d = new Uint32Array(img.data.buffer);
            const band = (t * 14) % (H + 20) - 10;
            for (let y = 0; y < H; y++) {
                const lift = Math.abs(y - band) < 4 ? 46 : 0;
                for (let x = 0; x < W; x++) {
                    const v = Math.min(255, Math.floor(Math.random() * 190) + lift);
                    d[y * W + x] = (255 << 24) | (v << 16) | (v << 8) | v;
                }
            }
            ctx.putImageData(img, 0, 0);
        };
    },
    forest() {
        const rnd = retroSeeded(811);
        const bg = retroLayer((c, W, H) => {
            c.fillStyle = retroGradient(c, H, [[0, "#2c3f47"], [0.6, "#60787a"], [1, "#7b8f8b"]]);
            c.fillRect(0, 0, W, H);
            [["#4d6768", 60, 7, 15], ["#34504f", 70, 10, 22], ["#1c322f", 86, 14, 34]].forEach(([col, base, step, tall]) => {
                c.fillStyle = col;
                for (let x = -6; x < W + 6; x += step * (0.7 + rnd() * 0.6)) {
                    const h = tall * (0.7 + rnd() * 0.5), w = step * 0.95;
                    c.beginPath();
                    c.moveTo(x, base - h);
                    c.lineTo(x + w, base + 2);
                    c.lineTo(x - w, base + 2);
                    c.fill();
                }
                c.fillRect(0, base, W, H - base);
            });
            c.fillStyle = "#101f1c";
            c.fillRect(0, 88, W, 12);
        });
        const drops = Array.from({ length: 46 }, () => [rnd() * 180, rnd() * 100, 4 + rnd() * 4]);
        return (ctx, t, W, H) => {
            ctx.drawImage(bg, 0, 0);
            ctx.strokeStyle = "rgba(205,228,235,0.55)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            drops.forEach((d) => {
                d[0] -= 1.1; d[1] += d[2];
                if (d[1] > H) { d[1] = -5; d[0] = Math.random() * 180; }
                ctx.moveTo(d[0], d[1]);
                ctx.lineTo(d[0] - 1, d[1] + d[2]);
            });
            ctx.stroke();
            if (Math.random() < 0.0035) { ctx.fillStyle = "rgba(235,240,255,0.5)"; ctx.fillRect(0, 0, W, H); }
        };
    },
    ocean() {
        const H0 = 54;
        const bg = retroLayer((c, W) => {
            c.fillStyle = retroGradient(c, H0, [[0, "#191c4b"], [0.5, "#74396f"], [0.85, "#e07a5f"], [1, "#f6bd60"]]);
            c.fillRect(0, 0, W, H0);
            c.fillStyle = "#ffe29a";
            c.beginPath();
            c.arc(W * 0.62, H0, 13, Math.PI, 0);
            c.fill();
        });
        return (ctx, t, W, H) => {
            ctx.drawImage(bg, 0, 0);
            for (let y = H0; y < H; y += 2) {
                const depth = (y - H0) / (H - H0);
                const wave = Math.sin(y * 0.55 - t * 1.6) * 0.5 + 0.5;
                const r = 24 + wave * 22, gr = 52 + wave * 34 + depth * 16, b = 96 + wave * 28 - depth * 16;
                ctx.fillStyle = `rgb(${r | 0},${gr | 0},${b | 0})`;
                ctx.fillRect(0, y, W, 2);
                // солнечная дорожка
                const w = 3 + depth * 13 + Math.sin(y + t * 3) * 2;
                ctx.fillStyle = `rgba(255,200,120,${0.55 - depth * 0.3})`;
                ctx.fillRect(W * 0.62 - w + Math.sin(y * 1.7 + t * 2) * 2, y, w * 2, 1);
            }
            // накат на берег
            const shore = 90 + Math.sin(t * 0.7) * 4;
            ctx.fillStyle = "#d8bd8c";
            ctx.fillRect(0, shore + 2, W, H - shore);
            ctx.fillStyle = "rgba(240,248,255,0.85)";
            for (let x = 0; x < W; x += 3) {
                ctx.fillRect(x, shore + Math.sin(x * 0.2 + t) * 1.2, 3, 2);
            }
        };
    },
    city() {
        const rnd = retroSeeded(4021);
        const windows = [];
        const bg = retroLayer((c, W, H) => {
            c.fillStyle = retroGradient(c, 70, [[0, "#070a24"], [1, "#2b1c4e"]]);
            c.fillRect(0, 0, W, H);
            c.fillStyle = "#c9d6ff";
            for (let i = 0; i < 30; i++) c.fillRect(rnd() * W | 0, rnd() * 34 | 0, 1, 1);
            c.fillStyle = "#e9ecff";
            c.beginPath(); c.arc(128, 15, 6, 0, Math.PI * 2); c.fill();
            c.fillStyle = "#14112f";
            for (let x = 0; x < W;) {
                const w = 7 + rnd() * 9, h = 18 + rnd() * 26;
                c.fillRect(x, 74 - h, w, h);
                x += w + 1;
            }
            c.fillStyle = "#0a0a1c";
            for (let x = -2; x < W;) {
                const w = 11 + rnd() * 13, h = 22 + rnd() * 34, top = 78 - h;
                c.fillRect(x, top, w, h);
                for (let wy = top + 3; wy < 74; wy += 5) {
                    for (let wx = x + 2; wx < x + w - 2; wx += 4) {
                        if (rnd() < 0.72) windows.push([wx | 0, wy | 0, rnd() < 0.45]);
                    }
                }
                x += w + 1;
            }
            c.fillStyle = "#16161f";
            c.fillRect(0, 78, W, 22);
            c.fillStyle = "#5c5c66";
            for (let x = 2; x < W; x += 12) c.fillRect(x, 88, 6, 1);
        });
        const cars = [{ x: 10, y: 84, v: 1.6, c: "#ff4b4b" }, { x: 90, y: 92, v: -2.1, c: "#fff2b0" }];
        return (ctx, t, W) => {
            ctx.drawImage(bg, 0, 0);
            if (Math.random() < 0.3) { const w = windows[Math.random() * windows.length | 0]; w[2] = !w[2]; }
            ctx.fillStyle = "#f5c86a";
            windows.forEach((w) => { if (w[2]) ctx.fillRect(w[0], w[1], 2, 2); });
            cars.forEach((car) => {
                car.x += car.v;
                if (car.x > W + 22) car.x = -22;
                if (car.x < -22) car.x = W + 22;
                ctx.fillStyle = "#0d0d16";
                ctx.fillRect(car.x, car.y - 2, 11, 3);
                ctx.fillStyle = car.c;
                ctx.fillRect(car.v > 0 ? car.x + 10 : car.x, car.y - 1, 2, 2);
                ctx.fillStyle = "rgba(255,240,180,0.2)";
                ctx.fillRect(car.v > 0 ? car.x + 12 : car.x - 11, car.y - 1, 11, 2);
            });
        };
    },
};

// Экран телевизора в элементе host. Возвращает управление им.
function mountRetroTv(host) {
    const saved = (() => { try { return parseInt(localStorage.getItem(RETRO_CHANNEL_KEY), 10); } catch (e) { return 0; } })();
    let index = saved >= 0 && saved < RETRO_CHANNELS.length ? saved : 0;
    host.classList.add("retro-screen");
    host.innerHTML = `<canvas width="${RETRO_TV_W}" height="${RETRO_TV_H}" aria-hidden="true"></canvas><span class="retro-osd"></span><span class="retro-hint"></span>`;
    const canvas = host.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const osd = host.querySelector(".retro-osd");
    const scenes = {};
    const sceneOf = (id) => scenes[id] || (scenes[id] = RETRO_SCENES[id]());
    let staticFrames = 0;
    let soundOn = false;
    let paused = false;
    let osdTimer = 0;
    let time = 0;
    const listeners = new Set();

    const showOsd = () => {
        const ch = RETRO_CHANNELS[index];
        osd.textContent = `CH ${String(index + 1).padStart(2, "0")} ${ch.label}`;
        osd.classList.add("is-on");
        clearTimeout(osdTimer);
        osdTimer = setTimeout(() => osd.classList.remove("is-on"), 2600);
    };

    const syncAudio = () => {
        if (soundOn && !paused) ambiencePlay(RETRO_CHANNELS[index].id);
        else ambienceStop();
    };

    const timer = setInterval(() => {
        if (!host.isConnected) { api.destroy(); return; }
        if (paused || document.hidden) return;
        time += 1 / RETRO_TV_FPS;
        if (staticFrames > 0) {
            staticFrames--;
            sceneOf("noise")(ctx, time, RETRO_TV_W, RETRO_TV_H);
        } else {
            sceneOf(RETRO_CHANNELS[index].id)(ctx, time, RETRO_TV_W, RETRO_TV_H);
        }
    }, 1000 / RETRO_TV_FPS);

    const api = {
        channelIndex: () => index,
        channelLabel: () => RETRO_CHANNELS[index].label,
        next() {
            index = (index + 1) % RETRO_CHANNELS.length;
            try { localStorage.setItem(RETRO_CHANNEL_KEY, String(index)); } catch (e) {}
            staticFrames = 3;
            showOsd();
            syncAudio();
            listeners.forEach(fn => fn());
        },
        setSound(on) {
            soundOn = !!on;
            syncAudio();
            listeners.forEach(fn => fn());
        },
        soundOn: () => soundOn,
        setPaused(v) {
            paused = !!v;
            syncAudio();
        },
        setHint(text) { host.querySelector(".retro-hint").textContent = text || ""; },
        onChange(fn) { listeners.add(fn); },
        destroy() {
            clearInterval(timer);
            clearTimeout(osdTimer);
            ambienceStop();
        },
    };
    showOsd();
    return api;
}

// ---------- Кассета ----------
function retroCassetteHtml(label) {
    return `
        <span class="retro-tape" aria-hidden="true">
            <span class="retro-tape-label">${label || ""}</span>
            <span class="retro-tape-window"><i></i><b></b><i></i></span>
        </span>
    `;
}

// Окно вставки: одно поле и для ссылки, и для кода плеера <iframe>
function openCassetteDialog(onSubmit) {
    if (document.getElementById("cassetteDialog")) return;
    thingSound("tape");
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "cassetteDialog";
    overlay.innerHTML = `
        <form class="modal-content retro-dialog">
            <div class="retro-dialog-tape">
                <div class="retro-dialog-sticker">
                    <i></i>
                    <label for="cassetteInput">Что записать на кассету?</label>
                    <textarea id="cassetteInput" rows="3" placeholder="Ссылка на YouTube, Rutube, .mp4 или код плеера &lt;iframe&gt;" autocomplete="off" spellcheck="false" required></textarea>
                </div>
                <div class="retro-tape-window" aria-hidden="true"><i></i><b></b><i></i></div>
            </div>
            <div class="retro-dialog-actions">
                <button type="button" class="ui-btn ui-pill" data-a="no">Отмена</button>
                <button type="submit" class="ui-btn ui-pill ui-pill-accent">Вставить в видик</button>
            </div>
        </form>
    `;
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("[data-a=no]").onclick = close;
    const input = overlay.querySelector("textarea");
    overlay.querySelector("form").onsubmit = (e) => {
        e.preventDefault();
        const val = input.value.trim();
        if (!val) return;
        close();
        onSubmit(val);
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            overlay.querySelector("form").requestSubmit();
        }
    });
    document.body.appendChild(overlay);
    input.focus();
}

// Кассета улетает в щель видика, затем done()
function cassetteFlyInto(fromEl, slotEl, done) {
    thingSound("insert");
    if (!fromEl || !slotEl || !fromEl.animate) { setTimeout(done, 450); return; }
    const a = fromEl.getBoundingClientRect(), b = slotEl.getBoundingClientRect();
    const clone = fromEl.cloneNode(true);
    clone.removeAttribute("id");
    clone.classList.add("retro-flying");
    clone.style.cssText = `position:fixed;left:${a.left}px;top:${a.top}px;width:${a.width}px;height:${a.height}px;margin:0;z-index:1500;pointer-events:none;`;
    document.body.appendChild(clone);
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const scale = Math.min(1, b.width / a.width);
    const anim = clone.animate([
        { transform: "translate(0,0) scale(1)", opacity: 1 },
        { transform: `translate(${dx}px,${dy - 14}px) scale(${scale})`, opacity: 1, offset: 0.7 },
        { transform: `translate(${dx}px,${dy}px) scale(${scale * 0.92},${scale * 0.15})`, opacity: 0 },
    ], { duration: 560, easing: "ease-in-out", fill: "forwards" });
    anim.onfinish = () => { clone.remove(); done(); };
}
