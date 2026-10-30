// ==========================================
// live.js — ЖИВОЙ САЙТ: КТО ГДЕ И ЧТО НЕ ПРОЧИТАНО
// ==========================================
// Подключается на всех страницах сайта после shell.js. Запускается из
// initShell (см. shell.js), один канал Supabase Realtime "site_live":
//   presence          — кто на сайте и в каком разделе (см. liveSetWhere);
//   postgres_changes  — новое сообщение в чате: число в меню, звонок и окошко
//                       уведомления на любой странице;
//   broadcast "read"  — второй прочитал чат: галочки у своих сообщений.
//
// Отметка «прочитано до» лежит в таблице chat_reads. Пока таблицы нет
// (миграция 20261101_chat_reads.sql), счётчик работает по памяти браузера,
// а двойных галочек не будет.

const LIVE_POLL_MS = 30000;
const LIVE_RECONNECT_MS = 2000;
const LIVE_TOAST_MS = 7000;
const LIVE_LOCAL_READ_KEY = "chatLastRead";

const live = {
    ch: null,
    me: null,
    myName: "",
    connected: false,
    reconnectTimer: null,
    started: false,
    where: null,
    partner: null,          // { name, where } — второй человек на сайте
    lastRead: null,         // до какого момента прочитал чат я
    partnerRead: null,      // … и второй
    readsOk: true,          // есть ли таблица chat_reads
    unread: 0,
    seen: new Set(),        // id сообщений, о которых уже сообщили
    listeners: new Set(),
    baseTitle: "",
};

function liveOnChange(fn) { live.listeners.add(fn); }
function liveChanged() {
    live.listeners.forEach((fn) => { try { fn(); } catch (e) { console.warn("live listener", e); } });
}

function initSiteLive() {
    if (live.started || !currentUser) return;
    live.started = true;
    live.me = currentUser.id;
    live.myName = getUsernameFromEmail(currentUser.email);
    live.baseTitle = document.title;
    liveConnect();
    liveLoadReads();
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) return;
        liveTrack();
        liveRefreshUnread();
        liveMarkOpenChatRead();
    });
    window.addEventListener("online", () => liveRefreshUnread());
    setInterval(() => { if (!document.hidden) { liveRefreshUnread(); liveLoadPartnerRead(); } }, LIVE_POLL_MS);
}

function liveConnect() {
    const channel = db.channel("site_live", { config: { presence: { key: live.me }, broadcast: { self: false } } });
    live.ch = channel;
    channel
        .on("presence", { event: "sync" }, () => liveOnPresence())
        .on("broadcast", { event: "read" }, ({ payload }) => {
            if (!payload || payload.from === live.me || !payload.at) return;
            if (!live.partnerRead || payload.at > live.partnerRead) {
                live.partnerRead = payload.at;
                liveRenderTicks();
            }
        })
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, ({ new: row }) => liveOnMessage(row))
        .subscribe((status) => {
            if (live.ch !== channel) return;
            if (status === "SUBSCRIBED") {
                live.connected = true;
                liveTrack();
                liveRefreshUnread();
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                live.connected = false;
                if (!live.reconnectTimer) live.reconnectTimer = setTimeout(() => {
                    live.reconnectTimer = null;
                    live.ch = null;
                    try { db.removeChannel(channel); } catch (e) {}
                    liveConnect();
                }, LIVE_RECONNECT_MS);
            }
        });
}

// ---------- Кто где ----------
function liveTrack() {
    if (!live.ch || !live.connected) return;
    try {
        const r = live.ch.track({ name: live.myName, where: live.where });
        if (r && r.catch) r.catch(() => {});
    } catch (e) {}
}

function liveSetWhere(section) {
    if (live.where === section) return;
    live.where = section;
    liveTrack();
}

function liveOnPresence() {
    const state = live.ch ? live.ch.presenceState() : {};
    const other = Object.keys(state).find(k => k !== live.me);
    const metas = other ? state[other] : null;
    const meta = metas && metas.length ? metas[metas.length - 1] : null;
    live.partner = meta ? { name: meta.name || "", where: meta.where || "home" } : null;
    liveChanged();
}

// ---------- Прочитано ----------
async function liveLoadReads() {
    const { data, error } = await db.from("chat_reads").select("user_id, last_read_at");
    if (error) {
        console.warn("chat_reads", error);
        live.readsOk = false;
        try { live.lastRead = localStorage.getItem(LIVE_LOCAL_READ_KEY); } catch (e) {}
    } else {
        const rows = data || [];
        const mine = rows.find(r => r.user_id === live.me);
        const theirs = rows.find(r => r.user_id !== live.me);
        live.lastRead = mine ? mine.last_read_at : null;
        live.partnerRead = theirs ? theirs.last_read_at : null;
    }
    // Самый первый вход: старая переписка непрочитанной не считается
    if (!live.lastRead) liveWriteRead(new Date().toISOString());
    liveRenderTicks();
    liveRefreshUnread();
    liveMarkOpenChatRead();
}

async function liveLoadPartnerRead() {
    if (!live.readsOk) return;
    const { data, error } = await db.from("chat_reads").select("user_id, last_read_at");
    if (error) return;
    const theirs = (data || []).find(r => r.user_id !== live.me);
    if (theirs && theirs.last_read_at !== live.partnerRead) {
        live.partnerRead = theirs.last_read_at;
        liveRenderTicks();
    }
}

function liveWriteRead(at) {
    live.lastRead = at;
    try { localStorage.setItem(LIVE_LOCAL_READ_KEY, at); } catch (e) {}
    if (live.readsOk) {
        db.from("chat_reads").upsert([{ user_id: live.me, last_read_at: at }]).then(({ error }) => {
            if (error) console.warn("chat_reads save", error);
        });
    }
    if (live.ch && live.connected) {
        try {
            const r = live.ch.send({ type: "broadcast", event: "read", payload: { from: live.me, at } });
            if (r && r.catch) r.catch(() => {});
        } catch (e) {}
    }
}

function liveChatIsOpen() {
    return typeof isChatScreenOpen !== "undefined" && isChatScreenOpen && !document.hidden;
}

// Чат открыт и виден — всё в нём считается прочитанным
function liveMarkOpenChatRead() {
    if (!live.started || !liveChatIsOpen() || typeof chatMessages === "undefined" || !chatMessages.length) return;
    let latest = null;
    chatMessages.forEach((m) => { if (m.created_at && (!latest || m.created_at > latest)) latest = m.created_at; });
    if (latest && (!live.lastRead || latest > live.lastRead)) liveWriteRead(latest);
    liveSetUnread(0);
    const toasts = document.getElementById("liveToasts");
    if (toasts) toasts.innerHTML = "";
}

async function liveRefreshUnread() {
    if (!live.lastRead) return;
    if (liveChatIsOpen()) { liveSetUnread(0); return; }
    const { count, error } = await db.from("chat_messages")
        .select("id", { count: "exact", head: true })
        .gt("created_at", live.lastRead)
        .neq("user_id", live.me);
    if (!error && typeof count === "number") liveSetUnread(count);
}

function liveSetUnread(n) {
    if (live.unread === n) return;
    live.unread = n;
    if (typeof setShellBadge === "function") setShellBadge("chat", n);
    if (live.baseTitle) document.title = (n ? `(${n}) ` : "") + live.baseTitle;
    liveChanged();
}

// Галочки у своих сообщений: ✓ отправлено, ✓✓ прочитано
function chatTickState(createdAt) {
    return live.readsOk && live.partnerRead && createdAt && createdAt <= live.partnerRead;
}
function chatPaintTick(el) {
    const read = chatTickState(el.dataset.created);
    el.textContent = read ? "✓✓" : "✓";
    el.classList.toggle("is-read", !!read);
    el.title = read ? "Прочитано" : "Отправлено";
}
function liveRenderTicks() {
    document.querySelectorAll(".chat-tick").forEach(chatPaintTick);
}

// ---------- Новое сообщение ----------
function liveOnMessage(row) {
    if (!row || row.user_id === live.me || live.seen.has(row.id)) return;
    live.seen.add(row.id);
    if (liveChatIsOpen()) return;  // чат сам его покажет и отметит прочитанным
    liveSetUnread(live.unread + 1);
    liveShowToast(row);
    if (typeof thingSound === "function") thingSound("ring");
    vibrate([30, 60, 30]);
}

function liveShowToast(row) {
    let box = document.getElementById("liveToasts");
    if (!box) {
        box = document.createElement("div");
        box.id = "liveToasts";
        box.className = "live-toasts";
        document.body.appendChild(box);
    }
    while (box.children.length >= 2) box.firstElementChild.remove();
    const name = row.username || "Сообщение";
    const toast = document.createElement("button");
    toast.type = "button";
    toast.className = "ui-btn live-toast";
    toast.innerHTML = `
        <span class="live-toast-ava">${userAvatarHtml(name)}</span>
        <span class="live-toast-body"><b></b><span></span></span>
        <span class="live-toast-close" aria-label="Закрыть">✕</span>
    `;
    toast.querySelector("b").textContent = name;
    toast.querySelector(".live-toast-body span").textContent =
        typeof isStickerMessage === "function" && isStickerMessage(row.message) ? "🖼 Стикер" : String(row.message || "").slice(0, 140);
    const hide = () => {
        toast.classList.add("is-leaving");
        setTimeout(() => toast.remove(), 220);
    };
    toast.onclick = (e) => {
        hide();
        if (e.target.closest(".live-toast-close")) return;
        shellNavigate("chat");
    };
    box.appendChild(toast);
    setTimeout(hide, LIVE_TOAST_MS);
}
