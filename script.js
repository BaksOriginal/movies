let dbData = {}; // Сюда мы динамически соберем структуру категорий и жанров из базы данных
let titleCreatedAt = {}; // "Название (год)" -> дата добавления в базу (для синего кружка "новинка")
// ==========================================
// TMDB (постеры фильмов/сериалов)
// ==========================================
const TMDB_API_KEY = "17ff3215ca3fae9d63aacaf9f5fd14c3";
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w342";
// ==========================================
// СТИКЕРЫ ДЛЯ ЧАТА (хранятся в GitHub, не в БД)
// ==========================================
const GITHUB_STICKERS_OWNER = "BaksOriginal";
const GITHUB_STICKERS_REPO = "movies";
const GITHUB_STICKERS_BRANCH = "main";
const GITHUB_STICKERS_PATH = "stickers";
const STICKER_PREFIX = "[[STICKER]]";
let isTransitioning = false;
let isMusicPlaying = localStorage.getItem("musicEnabled") === "true";
function startTransitionLock() {
isTransitioning = true;
setTimeout(() => {
isTransitioning = false;
}, 350);
}
document.addEventListener('click', (e) => {
if (isTransitioning) {
e.preventDefault();
e.stopPropagation();
}
}, true);
async function loadCatalogFromDB() {
const { data: titles, error } = await db
.from('titles')
.select('*')
.order('id', { ascending: true });
if (error) {
     console.error("Ошибка при загрузке каталога из БД:", error);
     return;
 }
 const tempStructure = {};
 const tempCreatedAt = {};
 titles.forEach(item => {
     const cat = item.category;
     const gen = item.genre;
     const fran = item.franchise;
     const titleWithYear = `${item.title} (${item.year})`;
     tempCreatedAt[titleWithYear] = item.created_at || null;
     if (!tempStructure[cat]) tempStructure[cat] = {};
     if (!tempStructure[cat][gen]) tempStructure[cat][gen] = [];
     if (fran) {
         let franchiseObj = tempStructure[cat][gen].find(
             i => typeof i === 'object' && i !== null && i[fran]
         );
         if (!franchiseObj) {
             franchiseObj = { [fran]: [] };
             tempStructure[cat][gen].push(franchiseObj);
         }
         franchiseObj[fran].push(titleWithYear);
     } else {
         tempStructure[cat][gen].push(titleWithYear);
     }
 });
 dbData = tempStructure;
 titleCreatedAt = tempCreatedAt;
}
function isRecentlyAdded(title) {
const createdAt = titleCreatedAt[title];
if (!createdAt) return false;
const addedTime = new Date(createdAt).getTime();
if (isNaN(addedTime)) return false;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
return (Date.now() - addedTime) < TWO_DAYS_MS;
}
// ==========================================
// НАСТРОЙКА SUPABASE
// ==========================================
const SUPABASE_URL = "https://nwkgofmgluduldgsmwfa.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Igpb__d5aHp3DBbQH1NgOA_W8_Ku6aE";
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = document.getElementById("app");
let currentUser = null;
// ===== НОВАЯ СТРУКТУРА ПРОСМОТРЕННОГО =====
let watchedByMe = new Set();
let watchedByPartner = new Set();
let watchedTogether = new Set();
// Обратная совместимость: геттер для кода, который ожидает watchedTitles
Object.defineProperty(window, 'watchedTitles', {
get: () => {
const result = new Set();
watchedByMe.forEach(t => result.add(t));
watchedTogether.forEach(t => result.add(t));
return result;
}
});
let wishlistTitles = new Set();
let ratingsData = {};
let history = [];
let realtimeChannel = null;
let searchFilters = { category: "", genre: "", year: "", hasRating: "", minStars: "" };
let lastSearchQuery = "";
let chatMessages = [];
let isChatScreenOpen = false;
let chatPollInterval = null;
let chatReplyTarget = null;
let isDarkTheme = false;
let currentCategoryName = null;
// ==========================================
// РЕЗЕРВНОЕ КОПИРОВАНИЕ СЕССИИ
// ==========================================
function saveSessionBackup(session) {
if (session) {
const data = JSON.stringify({
access_token: session.access_token,
refresh_token: session.refresh_token
});
document.cookie = "sb_session_backup=" + encodeURIComponent(data) + "; max-age=31536000; path=/; SameSite=Lax; Secure";
} else {
document.cookie = "sb_session_backup=; max-age=0; path=/; SameSite=Lax; Secure";
}
}
async function tryRestoreSession() {
try {
const matches = document.cookie.match(new RegExp("(?:^|; )" + "sb_session_backup".replace(/([.$?*|{}()[]\/+^])/g, '\$1') + "=([^;]*)"));
if (matches) {
const backupData = JSON.parse(decodeURIComponent(matches[1]));
if (backupData && backupData.refresh_token) {
console.log("Найдена резервная сессия, восстанавливаем...");
const { data, error } = await db.auth.setSession({
access_token: backupData.access_token,
refresh_token: backupData.refresh_token
});
if (!error && data.session) {
currentUser = data.session.user;
saveSessionBackup(data.session);
return true;
}
}
}
} catch (e) {
console.error("Не удалось восстановить сессию из бэкапа:", e);
}
return false;
}
async function performLogout() {
saveSessionBackup(null);
await db.auth.signOut();
}
let isAppInitialized = false;
db.auth.onAuthStateChange(async (event, session) => {
if (session && isAppInitialized && currentUser && currentUser.id === session.user.id) {
currentUser = session.user;
saveSessionBackup(session);
startShakeDetection();
return;
}
if (session) {
     currentUser = session.user;
     saveSessionBackup(session);
     startShakeDetection();
     const wasAlreadyInitialized = isAppInitialized;
     isAppInitialized = true;
     loadThemePreference();
     loadUserDataFromDB().then(() => {
         subscribeToChanges(); 
         if (!wasAlreadyInitialized) {
             showHome();
         } else {
             refreshCurrentScreen();
         }
     });
 } else {
     const restored = await tryRestoreSession();
     if (restored) return;
     currentUser = null;
     watchedByMe.clear();
     watchedByPartner.clear();
     watchedTogether.clear();
     wishlistTitles.clear();
     ratingsData = {};
     chatMessages = [];
     isChatScreenOpen = false;
     isAppInitialized = false;
     applyDarkTheme(false);
     saveSessionBackup(null);
     if (realtimeChannel) {
         db.removeChannel(realtimeChannel);
         realtimeChannel = null;
     }
     showLoginScreen();
 }
});
(async function bootstrapAuthWatchdog() {
try {
const { data, error } = await db.auth.getSession();
if (error) {
console.error("Ошибка получения сессии при загрузке:", error);
}
} catch (e) {
console.error("Критическая ошибка при получении сессии:", e);
}
setTimeout(() => {
    if (!isAppInitialized && app && !app.innerHTML.trim()) {
        console.warn("Событие авторизации не пришло вовремя — показываем экран входа принудительно.");
        showLoginScreen();
    }
}, 2000);
})();
window.addEventListener("unhandledrejection", (event) => {
console.error("Необработанная ошибка:", event.reason);
if (!isAppInitialized && app && !app.innerHTML.trim()) {
showLoginScreen();
}
});
// ==========================================
// ЗАГРУЗКА ДАННЫХ ПРОСМОТРЕННОГО (НОВАЯ СТРУКТУРА)
// ==========================================
async function loadWatchedFromDB() {
if (!currentUser) return;
const { data, error } = await db.from('watched_items').select('title, watch_type, user_id');
if (error) {
console.error("Ошибка при загрузке списка просмотренного:", error);
return;
}
watchedByMe.clear();
watchedByPartner.clear();
watchedTogether.clear();
data.forEach(item => {
    if (item.watch_type === 'together') {
        watchedTogether.add(item.title);
    } else if (item.user_id === currentUser.id) {
        watchedByMe.add(item.title);
    } else {
        watchedByPartner.add(item.title);
    }
});
}
async function loadWishlistFromDB() {
if (!currentUser) return;
const { data, error } = await db.from('wishlist_items').select('title');
if (error) {
console.error("Ошибка при загрузке вишлиста:", error);
return;
}
wishlistTitles = new Set(data.map(item => item.title));
}
function isSecretCategory(catKey) {
return catKey.includes("Секрет") || catKey.includes("🔒") || catKey.includes("❤️");
}
// =======================================================
// ТЁМНАЯ ТЕМА
// =======================================================
function applyDarkTheme(enabled) {
isDarkTheme = enabled;
document.body.classList.toggle("dark-theme", enabled);
}
async function loadThemePreference() {
if (!currentUser) return;
const cacheKey = "darkTheme_" + currentUser.id;
 const cached = localStorage.getItem(cacheKey);
 if (cached !== null) {
     applyDarkTheme(cached === "true");
 }
 const { data, error } = await db
     .from('user_settings')
     .select('dark_theme')
     .eq('user_id', currentUser.id)
     .maybeSingle();
 if (error) {
     console.error("Ошибка при загрузке настроек темы:", error);
     return;
 }
 const enabled = !!(data && data.dark_theme);
 applyDarkTheme(enabled);
 localStorage.setItem(cacheKey, String(enabled));
}
async function saveThemePreference(enabled) {
if (!currentUser) return;
applyDarkTheme(enabled);
localStorage.setItem("darkTheme_" + currentUser.id, String(enabled));
const { error } = await db.from('user_settings').upsert(
    { user_id: currentUser.id, dark_theme: enabled },
    { onConflict: 'user_id' }
);
if (error) {
    console.error("Ошибка при сохранении темы:", error);
}
}
function buildThemeToggle() {
let row = document.createElement("div");
row.className = "theme-toggle-row";
let label = document.createElement("span");
 label.className = "theme-toggle-label";
 label.textContent = "🌙 Тёмная тема";
 let switchLabel = document.createElement("label");
 switchLabel.className = "theme-switch";
 let checkbox = document.createElement("input");
 checkbox.type = "checkbox";
 checkbox.checked = isDarkTheme;
 checkbox.onchange = () => saveThemePreference(checkbox.checked);
 let slider = document.createElement("span");
 slider.className = "theme-switch-slider";
 switchLabel.appendChild(checkbox);
 switchLabel.appendChild(slider);
 row.appendChild(label);
 row.appendChild(switchLabel);
 return row;
}
async function loadRatingsFromDB() {
const { data, error } = await db.from('ratings').select('title, username, score, user_id');
if (error) {
console.error("Ошибка при загрузке оценок:", error);
return;
}
const temp = {};
data.forEach(r => {
if (!temp[r.title]) temp[r.title] = [];
temp[r.title].push({ username: r.username, score: r.score, userId: r.user_id });
});
ratingsData = temp;
}
async function loadUserDataFromDB() {
if (!currentUser) return;
try {
const { data, error } = await db.rpc('get_watched_wishlist_ratings');
if (error) throw error;
    watchedByMe.clear();
     watchedByPartner.clear();
     watchedTogether.clear();
     (data.watched || []).forEach(item => {
         if (item.watch_type === 'together') {
             watchedTogether.add(item.title);
         } else if (item.user_id === currentUser.id) {
             watchedByMe.add(item.title);
         } else {
             watchedByPartner.add(item.title);
         }
     });
     wishlistTitles = new Set(data.wishlist || []);
     const temp = {};
     (data.ratings || []).forEach(r => {
         if (!temp[r.title]) temp[r.title] = [];
         temp[r.title].push({ username: r.username, score: r.score, userId: r.user_id });
     });
     ratingsData = temp;
 } catch (e) {
     await Promise.all([loadWatchedFromDB(), loadWishlistFromDB(), loadRatingsFromDB()]);
 }
}
function getUsernameFromEmail(email) {
if (email === "nowyouseemeinvi@gmail.com") return "Myakish";
if (email === "unknownqsrll@gmail.com") return "Asmoday";
return email || "Аноним";
}
function getAverageRating(title) {
const ratings = ratingsData[title];
if (!ratings || ratings.length === 0) return null;
const sum = ratings.reduce((acc, r) => acc + r.score, 0);
const avg = sum / ratings.length;
return Number.isInteger(avg) ? String(avg) : avg.toFixed(1);
}
function formatRatings(title) {
const ratings = ratingsData[title];
if (!ratings || ratings.length === 0) return "";
const sorted = [...ratings].sort((a, b) => a.username.localeCompare(b.username));
let result = "⭐ " + sorted.map(r => `${r.username}: ${r.score}/10`).join("   •   ");
if (ratings.length > 1) {
result += `• Среднее ${getAverageRating(title)}`;
}
return result;
}
// =======================================================
// КОММЕНТАРИИ К ТАЙТЛАМ
// =======================================================
async function loadCommentsForTitle(title) {
const { data, error } = await db
.from('comments')
.select('*')
.eq('title', title)
.order('created_at', { ascending: true });
if (error) {
    console.error("Ошибка при загрузке комментариев:", error);
    return [];
}
return data || [];
}
async function loadAllComments() {
const { data, error } = await db
.from('comments')
.select('*')
.order('created_at', { ascending: false });
if (error) {
    console.error("Ошибка при загрузке всех комментариев:", error);
    return [];
}
return data || [];
}
async function refreshRatingsUI() {
await loadRatingsFromDB();
document.querySelectorAll(".movie-item").forEach(wrapper => {
let itemDiv = wrapper.querySelector(".item");
let ratingsDiv = wrapper.querySelector(".item-ratings");
if (itemDiv && ratingsDiv) {
ratingsDiv.textContent = formatRatings(itemDiv.textContent.trim());
}
});
}
function subscribeToChanges() {
if (realtimeChannel) return;
realtimeChannel = db
     .channel('schema-db-changes')
     .on(
         'postgres_changes',
         { event: '*', schema: 'public', table: 'watched_items' },
         () => { updateUIOnLiveChange(); }
     )
     .on(
         'postgres_changes',
         { event: '*', schema: 'public', table: 'wishlist_items' },
         () => { updateUIOnLiveChange(); }
     )
     .on(
         'postgres_changes',
         { event: '*', schema: 'public', table: 'ratings' },
         () => { updateUIOnLiveChange(); }
     )
     .on(
         'postgres_changes',
         { event: '*', schema: 'public', table: 'chat_messages' },
         (payload) => {
             onChatRealtimeChange();
         }
     )
     .subscribe();
}
async function updateUIOnLiveChange() {
await loadUserDataFromDB();
let buttons = document.querySelectorAll("button");
 buttons.forEach(btn => {
     if (btn.textContent.includes("🎬 Просмотрено (")) {
         const total = watchedByMe.size + watchedByPartner.size + watchedTogether.size;
         btn.textContent = "🎬 Просмотрено (" + total + ")";
     }
     if (btn.textContent.includes("Будем смотреть")) {
         btn.textContent = "🍿 Будем смотреть (" + wishlistTitles.size + ")";
     }
 });
 let rows = document.querySelectorAll(".item-row");
 rows.forEach(row => {
     let itemDiv = row.querySelector(".item");
     let watchBtn = row.querySelector(".btn-watch");
     if (itemDiv && watchBtn) {
         let itemText = itemDiv.textContent.trim();
         const isSecret = itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал");
         let lookupText = itemText;
         if (isSecret && !itemText.includes("(2026)")) {
             lookupText = itemText + " (2026)";
         }
         watchBtn.className = "btn-watch";
         if (watchedByMe.has(lookupText) || watchedTogether.has(lookupText)) {
             watchBtn.classList.add("watched");
             watchBtn.textContent = "★";
         } else if (watchedByPartner.has(lookupText)) {
             watchBtn.classList.add("watched-partner");
             watchBtn.textContent = "★";
         } else if (wishlistTitles.has(lookupText)) {
             watchBtn.classList.add("wishlist-active");
             watchBtn.textContent = "★";
         } else {
             watchBtn.textContent = "☆";
         }
     }
 });
 document.querySelectorAll(".movie-item").forEach(wrapper => {
     let itemDiv = wrapper.querySelector(".item");
     let ratingsDiv = wrapper.querySelector(".item-ratings");
     if (itemDiv && ratingsDiv) {
         ratingsDiv.textContent = formatRatings(itemDiv.textContent.trim());
     }
 });
}
async function refreshCurrentScreen() {
await loadCatalogFromDB();
if (history.length > 0) {
let currentActiveData = history[history.length - 1];
openData(currentActiveData, false);
} else {
showHome();
}
}
// =======================================================
// НОВАЯ ЛОГИКА КЛИКА ПО ЗВЕЗДОЧКЕ
// =======================================================
async function handleStarClick(title) {
if (!currentUser) return;
showStarChoiceModal(title);
}
function showStarChoiceModal(title) {
const overlay = document.createElement("div");
overlay.className = "modal-overlay";
overlay.id = "starChoiceModal";
const isWatchedByMe = watchedByMe.has(title);
 const isWatchedByPartner = watchedByPartner.has(title);
 const isWatchedTogether = watchedTogether.has(title);
 const isWishlisted = wishlistTitles.has(title);
 let optionsHtml = "";
 if (isWatchedTogether) {
     optionsHtml += `<button id="choiceRemove" class="btn-pink-style">❌ Убрать из просмотренного нами</button>`;
 } else if (isWatchedByMe) {
     optionsHtml += `<button id="choiceRemove" class="btn-pink-style">❌ Убрать из просмотренного мной</button>`;
 } else if (isWatchedByPartner) {
     optionsHtml += `<button id="choiceWatchTogether" class="btn-pink-style">🎬 Просмотрено нами</button>`;
     optionsHtml += `<button id="choiceWatchSelf" class="btn-pink-style">🎬 Просмотрено мной</button>`;
 } else if (isWishlisted) {
     optionsHtml += `<button id="choiceRemove" class="btn-pink-style">❌ Убрать из вишлиста</button>`;
     optionsHtml += `<button id="choiceWatchSelf" class="btn-pink-style">🎬 Просмотрено мной</button>`;
     optionsHtml += `<button id="choiceWatchTogether" class="btn-pink-style">🎬 Просмотрено нами</button>`;
 } else {
     optionsHtml += `<button id="choiceWish" class="btn-pink-style">🍿 Будем смотреть</button>`;
     optionsHtml += `<button id="choiceWatchSelf" class="btn-pink-style">🎬 Просмотрено мной</button>`;
     optionsHtml += `<button id="choiceWatchTogether" class="btn-pink-style">🎬 Просмотрено нами</button>`;
 }
 optionsHtml += `<button id="choiceRate" class="btn-pink-style">⭐ Оценить</button>`;
 optionsHtml += `<button id="choiceCancel" class="btn-cancel-gray">Отмена</button>`;
 overlay.innerHTML = `
     <div class="modal-content" style="text-align: center;">
         <h3 style="margin-bottom: 10px;">Действие</h3>
         <p style="color: #666; margin-bottom: 20px; font-size: 14px;">"${title.replace(/\s*\(\d{4}\)$/, "")}"</p>
         <div class="action-buttons" style="display: flex; flex-direction: column; gap: 10px;">
             ${optionsHtml}
         </div>
     </div>
 `;
 document.body.appendChild(overlay);
 const removeBtn = document.getElementById("choiceRemove");
 if (removeBtn) {
     removeBtn.onclick = async () => {
         overlay.remove();
         if (isWatchedTogether) {
             watchedTogether.delete(title);
             await db.from('watched_items').delete().eq('title', title).eq('user_id', currentUser.id).eq('watch_type', 'together');
         } else if (isWatchedByMe) {
             watchedByMe.delete(title);
             await db.from('watched_items').delete().eq('title', title).eq('user_id', currentUser.id).eq('watch_type', 'self');
         } else if (isWishlisted) {
             wishlistTitles.delete(title);
             await db.from('wishlist_items').delete().eq('title', title).eq('user_id', currentUser.id);
         }
         updateUIOnLiveChange();
     };
 }
 const wishBtn = document.getElementById("choiceWish");
 if (wishBtn) {
     wishBtn.onclick = async () => {
         overlay.remove();
         wishlistTitles.add(title);
         updateUIOnLiveChange();
         const { error } = await db.from('wishlist_items').insert([{ user_id: currentUser.id, title: title }]);
         if (error) {
             wishlistTitles.delete(title);
             updateUIOnLiveChange();
             console.error("Ошибка при сохранении в вишлист:", error);
         }
     };
 }
 const watchSelfBtn = document.getElementById("choiceWatchSelf");
 if (watchSelfBtn) {
     watchSelfBtn.onclick = async () => {
         overlay.remove();
         watchedByMe.add(title);
         updateUIOnLiveChange();
         const { error } = await db.from('watched_items').insert([{ 
             user_id: currentUser.id, 
             title: title,
             watch_type: 'self'
         }]);
         if (error) {
             watchedByMe.delete(title);
             updateUIOnLiveChange();
             console.error("Ошибка при сохранении 'сам':", error);
         }
     };
 }
 const watchTogetherBtn = document.getElementById("choiceWatchTogether");
 if (watchTogetherBtn) {
     watchTogetherBtn.onclick = async () => {
         overlay.remove();
         watchedTogether.add(title);
         updateUIOnLiveChange();
         const { error } = await db.from('watched_items').insert([{ 
             user_id: currentUser.id, 
             title: title,
             watch_type: 'together'
         }]);
         if (error) {
             watchedTogether.delete(title);
             updateUIOnLiveChange();
             console.error("Ошибка при сохранении 'вместе':", error);
         }
     };
 }
 document.getElementById("choiceRate").onclick = () => {
     overlay.remove();
     showRatingModal(title);
 };
 document.getElementById("choiceCancel").onclick = () => {
     overlay.remove();
 };
}
function showLoginScreen() {
app.innerHTML = `<h1>Авторизация</h1> <form class="login-form" id="loginForm"> <input type="text" id="loginUsername" placeholder="Имя" required autocomplete="username"> <input type="password" id="loginPassword" placeholder="Пароль" required autocomplete="current-password"> <button type="submit">Войти</button> </form>`;
document.getElementById("loginForm").onsubmit = async (e) => {
     e.preventDefault();
     startShakeDetection();
     const username = document.getElementById("loginUsername").value.trim().toLowerCase();
     const password = document.getElementById("loginPassword").value;
     let email = "";
     if (username === "myakish") {
         email = "nowyouseemeinvi@gmail.com";
     } else if (username === "asmoday") {
         email = "unknownqsrll@gmail.com";
     } else {
         email = username;
     }
     const { error } = await db.auth.signInWithPassword({ email, password });
     if (error) {
         alert("Ошибка входа: неверный никнейм или пароль.");
         console.error("Ошибка авторизации:", error.message);
     }
 };
}
// =======================================================
// ЛОГИКА ПОИСКА
// =======================================================
function getLevenshteinDistance(a, b) {
const tmp = [];
let i, j, alen = a.length, blen = b.length, cost;
if (alen === 0) return blen;
if (blen === 0) return alen;
for (i = 0; i <= alen; i++) tmp[i] = [i];
for (j = 0; j <= blen; j++) tmp[0][j] = j;
for (i = 1; i <= alen; i++) {
for (j = 1; j <= blen; j++) {
cost = (a[i - 1] === b[j - 1]) ? 0 : 1;
tmp[i][j] = Math.min(tmp[i - 1][j] + 1, tmp[i][j - 1] + 1, tmp[i - 1][j - 1] + cost);
}
}
return tmp[alen][blen];
}
function collectFilterOptions() {
const categories = [];
const genres = new Set();
const years = new Set();
const collectYear = (fullTitle) => {
     const m = fullTitle.match(/\((\d{4})\)$/);
     if (m) years.add(m[1]);
 };
 for (let catKey in dbData) {
     if (isSecretCategory(catKey)) continue;
     categories.push(catKey);
     const categoryData = dbData[catKey];
     for (let genreKey in categoryData) {
         genres.add(genreKey);
         const listOrObj = categoryData[genreKey];
         if (Array.isArray(listOrObj)) {
             listOrObj.forEach(item => {
                 if (typeof item === 'string') {
                     collectYear(item);
                 } else if (typeof item === 'object' && item !== null) {
                     for (let franchiseName in item) {
                         item[franchiseName].forEach(t => collectYear(t));
                     }
                 }
             });
         }
     }
 }
 return {
     categories,
     genres: Array.from(genres).sort(),
     years: Array.from(years).sort((a, b) => b.localeCompare(a))
 };
}
function hasActiveFilters(filters) {
return !!(filters.category || filters.genre || filters.year || filters.hasRating || filters.minStars);
}
function buildFilterSummary(filters) {
const parts = [];
if (filters.category) parts.push(filters.category);
if (filters.genre) parts.push(filters.genre);
if (filters.year) parts.push(filters.year);
if (filters.hasRating === "yes") parts.push("с оценкой");
if (filters.hasRating === "no") parts.push("без оценки");
if (filters.minStars) parts.push(`от ${filters.minStars}★`);
return parts.join(", ");
}
function buildSearchBar(prefillQuery = "") {
let searchContainer = document.createElement("div");
searchContainer.style.cssText = `display: flex; gap: 8px; margin-bottom: 12px; width: 100%; box-sizing: border-box;`;
let searchInput = document.createElement("input");
 searchInput.type = "text";
 searchInput.className = "search-input-field";
 searchInput.placeholder = "Поиск...";
 searchInput.value = prefillQuery;
 searchInput.style.cssText = `
     flex-grow: 1;
     min-width: 0;
     padding: 10px 12px;
     border-radius: 8px;
     font-size: 18px;
     font-weight: 600;
     font-family: "Segoe UI", Arial, sans-serif;
     box-sizing: border-box;
 `;
 let searchSubmitBtn = document.createElement("button");
 searchSubmitBtn.className = "btn-search-icon";
 searchSubmitBtn.textContent = "🔍";
 searchSubmitBtn.style.cssText = `
     width: 42px !important;
     height: 42px !important;
     padding: 0 !important;
     margin: 0 !important;
     border-radius: 8px !important;
     cursor: pointer;
     font-size: 16px;
     display: flex;
     justify-content: center;
     align-items: center;
     flex-shrink: 0;
 `;
 let filterBtn = document.createElement("button");
 filterBtn.id = "searchFilterBtn";
 filterBtn.className = "btn-filter-icon";
 filterBtn.classList.toggle("active", hasActiveFilters(searchFilters));
 filterBtn.textContent = "⚙️";
 filterBtn.style.cssText = `
     width: 42px !important;
     height: 42px !important;
     padding: 0 !important;
     margin: 0 !important;
     border-radius: 8px !important;
     cursor: pointer;
     font-size: 16px;
     display: flex;
     justify-content: center;
     align-items: center;
     flex-shrink: 0;
 `;
 const doSearch = () => {
     const q = searchInput.value;
     if (q.trim() || hasActiveFilters(searchFilters)) {
         performCatalogSearch(q, searchFilters);
     }
 };
 const refreshFilterButtonAppearance = () => {
     filterBtn.classList.toggle("active", hasActiveFilters(searchFilters));
 };
 filterBtn.onclick = () => showFilterModal(refreshFilterButtonAppearance);
 searchSubmitBtn.onclick = doSearch;
 searchInput.onkeydown = (e) => {
     if (e.key === "Enter") {
         doSearch();
     }
 };
 searchContainer.appendChild(searchInput);
 searchContainer.appendChild(searchSubmitBtn);
 searchContainer.appendChild(filterBtn);
 return searchContainer;
}
function performCatalogSearch(query, filters = {}) {
const searchStr = (query || "").toLowerCase().trim();
const hasQuery = searchStr.length > 0;
lastSearchQuery = query || "";
if (!hasQuery && !hasActiveFilters(filters)) return;
 const results = [];
 for (let catKey in dbData) {
     if (isSecretCategory(catKey)) {
         continue;
     }
     if (filters.category && filters.category !== catKey) continue;
     const categoryData = dbData[catKey];
     for (let genreKey in categoryData) {
         if (filters.genre && filters.genre !== genreKey) continue;
         const listOrObj = categoryData[genreKey];
         const processTitle = (fullTitle, franchiseName = null) => {
             if (filters.year) {
                 const m = fullTitle.match(/\((\d{4})\)$/);
                 const year = m ? m[1] : null;
                 if (year !== filters.year) return;
             }
             const ratings = ratingsData[fullTitle] || [];
             if (filters.hasRating === "yes" && ratings.length === 0) return;
             if (filters.hasRating === "no" && ratings.length > 0) return;
             if (filters.minStars) {
                 const minStarsNum = parseInt(filters.minStars, 10);
                 const avg = getAverageRating(fullTitle);
                 const qualifies = avg !== null && parseFloat(avg) >= minStarsNum;
                 if (!qualifies) return;
             }
             if (!hasQuery) {
                 results.push({ title: fullTitle, score: 0 });
                 return;
             }
             const cleanTitle = fullTitle.replace(/\s*\(\d{4}\)$/, "").toLowerCase();
             if (cleanTitle.includes(searchStr) || 
                 (franchiseName && franchiseName.toLowerCase().includes(searchStr)) ||
                 genreKey.toLowerCase().includes(searchStr)) {
                 results.push({ title: fullTitle, score: 0 });
                 return;
             }
             const queryWords = searchStr.split(/\s+/);
             const titleWords = cleanTitle.split(/\s+/);
             let totalDistance = 0;
             let matchesCount = 0;
             queryWords.forEach(qw => {
                 let bestWordDist = 999;
                 titleWords.forEach(tw => {
                     const dist = getLevenshteinDistance(qw, tw);
                     if (dist < bestWordDist) {
                         bestWordDist = dist;
                     }
                 });
                 const maxAllowedErrors = qw.length <= 4 ? 1 : 2;
                 if (bestWordDist <= maxAllowedErrors) {
                     totalDistance += bestWordDist;
                     matchesCount++;
                 }
             });
             if (matchesCount === queryWords.length) {
                 results.push({ title: fullTitle, score: totalDistance + 1 });
             }
         };
         if (Array.isArray(listOrObj)) {
             listOrObj.forEach(item => {
                 if (typeof item === 'string') {
                     processTitle(item);
                 } else if (typeof item === 'object' && item !== null) {
                     for (let franchiseName in item) {
                         item[franchiseName].forEach(subTitle => {
                             processTitle(subTitle, franchiseName);
                         });
                     }
                 }
             });
         }
     }
 }
 results.sort((a, b) => a.score - b.score);
 const uniqueResults = [];
 const seen = new Set();
 results.forEach(r => {
     if (!seen.has(r.title)) {
         seen.add(r.title);
         uniqueResults.push(r.title);
     }
 });
 const filterSummary = buildFilterSummary(filters);
 let displayTitle;
 if (hasQuery && filterSummary) {
     displayTitle = `Результаты для: "${query}" (${filterSummary})`;
 } else if (hasQuery) {
     displayTitle = `Результаты для: "${query}"`;
 } else {
     displayTitle = `🔍 Фильтр: ${filterSummary}`;
 }
 currentCategoryName = "🔍 Результаты поиска";
 openData(uniqueResults, true, displayTitle);
}
function showFilterModal(onFiltersChanged) {
const options = collectFilterOptions();
const overlay = document.createElement("div");
 overlay.className = "modal-overlay";
 overlay.id = "filterModal";
 const categoryOptionsHtml = options.categories
     .map(c => `<option value="${c}" ${searchFilters.category === c ? "selected" : ""}>${c}</option>`)
     .join("");
 const genreOptionsHtml = options.genres
     .map(g => `<option value="${g}" ${searchFilters.genre === g ? "selected" : ""}>${g}</option>`)
     .join("");
 const yearOptionsHtml = options.years
     .map(y => `<option value="${y}" ${searchFilters.year === y ? "selected" : ""}>${y}</option>`)
     .join("");
 let starOptionsHtml = "";
 for (let i = 1; i <= 10; i++) {
     starOptionsHtml += `<option value="${i}" ${searchFilters.minStars === String(i) ? "selected" : ""}>от ${i}★ и выше</option>`;
 }
 overlay.innerHTML = `
     <div class="modal-content">
         <h3>⚙️ Фильтры поиска</h3>
         <form class="modal-form" id="filterForm">
             <label>Категория</label>
             <select id="fCategory">
                 <option value="">Все категории</option>
                 ${categoryOptionsHtml}
             </select>
             <label>Жанр</label>
             <select id="fGenre">
                 <option value="">Все жанры</option>
                 ${genreOptionsHtml}
             </select>
             <label>Год</label>
             <select id="fYear">
                 <option value="">Любой год</option>
                 ${yearOptionsHtml}
             </select>
             <label>Оценка</label>
             <select id="fHasRating">
                 <option value="" ${searchFilters.hasRating === "" ? "selected" : ""}>Любая</option>
                 <option value="yes" ${searchFilters.hasRating === "yes" ? "selected" : ""}>Есть оценка</option>
                 <option value="no" ${searchFilters.hasRating === "no" ? "selected" : ""}>Нет оценки</option>
             </select>
             <label>Количество звёзд</label>
             <select id="fMinStars">
                 <option value="" ${searchFilters.minStars === "" ? "selected" : ""}>Любое</option>
                 ${starOptionsHtml}
             </select>
             <div class="modal-buttons">
                 <button type="submit" class="btn-save">Применить</button>
                 <button type="button" class="btn-cancel" id="fReset">Сбросить</button>
             </div>
         </form>
         <div class="action-buttons" style="margin-top: 12px;">
             <button type="button" class="btn-action-cancel" id="fClose">Закрыть</button>
         </div>
     </div>
 `;
 document.body.appendChild(overlay);
 document.getElementById("fClose").onclick = () => overlay.remove();
 document.getElementById("fReset").onclick = () => {
     searchFilters = { category: "", genre: "", year: "", hasRating: "", minStars: "" };
     overlay.remove();
     onFiltersChanged();
 };
 document.getElementById("filterForm").onsubmit = (e) => {
     e.preventDefault();
     searchFilters = {
         category: document.getElementById("fCategory").value,
         genre: document.getElementById("fGenre").value,
         year: document.getElementById("fYear").value,
         hasRating: document.getElementById("fHasRating").value,
         minStars: document.getElementById("fMinStars").value
     };
     overlay.remove();
     onFiltersChanged();
 };
}
// =======================================================
// ГЛАВНАЯ СТРАНИЦА
// =======================================================
async function showHome() {
startTransitionLock();
isChatScreenOpen = false;
if (chatPollInterval) {
clearInterval(chatPollInterval);
chatPollInterval = null;
}
history = [];
currentCategoryName = null;
await loadCatalogFromDB();
let nav = document.querySelector(".navigation");
 if (nav) nav.remove();
 app.innerHTML = "";
 const createIconButton = (icon, onClick) => {
     let btn = document.createElement("button");
     btn.textContent = icon;
     btn.className = "icon-btn";
     btn.style.cssText = `
         width: 40px !important; height: 40px !important;
         min-width: 40px !important; min-height: 40px !important;
         padding: 0 !important; margin: 0 !important;
         border-radius: 50% !important; display: flex !important;
         justify-content: center !important; align-items: center !important;
         cursor: pointer !important; font-size: 16px !important;
         box-sizing: border-box !important; overflow: visible !important;
         line-height: 1 !important; flex-shrink: 0 !important;
     `;
     btn.onclick = onClick;
     return btn;
 };
 if (currentUser) {
     let header = document.createElement("div");
     header.className = "user-header";
     header.style.display = "flex";
     header.style.justifyContent = "space-between";
     header.style.alignItems = "center";
     header.style.marginBottom = "15px";
     header.innerHTML = `<span id="userEmailSpan" style="font-size: 14px;">${getUsernameFromEmail(currentUser.email)}</span>`;
     let controls = document.createElement("div");
     controls.style.display = "flex";
     controls.style.alignItems = "center";
     controls.style.gap = "10px";
     let musicBtn = createIconButton(isMusicPlaying ? "🔊" : "🔇", () => {
         const audio = document.getElementById("bgMusic");
         if (audio.paused) { audio.play(); isMusicPlaying = true; localStorage.setItem("musicEnabled", "true"); musicBtn.textContent = "🔊"; }
         else { audio.pause(); isMusicPlaying = false; localStorage.setItem("musicEnabled", "false"); musicBtn.textContent = "🔇"; }
     });
     let logoutBtn = createIconButton("❌", performLogout);
     controls.appendChild(musicBtn);
     controls.appendChild(logoutBtn);
     header.appendChild(controls);
     app.appendChild(header);
 }
 let title = document.createElement("h1");
 title.textContent = "Время Кино!";
 app.appendChild(title);
 if (currentUser) {
     let addBtn = document.createElement("button");
     addBtn.className = "btn-add-new";
     addBtn.textContent = "➕ Добавить тайтл";
     addBtn.style.marginBottom = "10px";
     addBtn.onclick = () => showAddEditModal();
     app.appendChild(addBtn);
     let hr = document.createElement("hr");
     hr.style.border = "0";
     hr.style.borderTop = "2px solid #9b4f70"; 
     hr.style.margin = "15px 0";
     app.appendChild(hr);
     app.appendChild(buildSearchBar());
     let hrAfterSearch = document.createElement("hr");
     hrAfterSearch.style.border = "0";
     hrAfterSearch.style.borderTop = "2px solid #9b4f70"; 
     hrAfterSearch.style.margin = "15px 0 20px 0";
     app.appendChild(hrAfterSearch);
 }
 let secretDividerAdded = false;
 for (let key in dbData) {
     const isSecretKey = key.includes("Секрет") || key.includes("🔒") || key.includes("❤️");
     if (isSecretKey && !secretDividerAdded) {
         let hrBeforeSecret = document.createElement("hr");
         hrBeforeSecret.style.border = "0";
         hrBeforeSecret.style.borderTop = "2px solid #9b4f70";
         hrBeforeSecret.style.margin = "15px 0";
         app.appendChild(hrBeforeSecret);
         secretDividerAdded = true;
     }
     let button = document.createElement("button");
     button.textContent = key;
     if (isSecretKey) {
         button.classList.add("btn-secret-gold");
     }
     button.onclick = () => { currentCategoryName = key; openData(dbData[key], true); };
     app.appendChild(button);
     if (isSecretKey) {
         let hrAfterSecret = document.createElement("hr");
         hrAfterSecret.style.border = "0";
         hrAfterSecret.style.borderTop = "2px solid #9b4f70"; 
         hrAfterSecret.style.margin = "15px 0";
         app.appendChild(hrAfterSecret);
     }
 }
 let wishlistBtn = document.createElement("button");
 wishlistBtn.className = "btn-pink-style";
 wishlistBtn.textContent = "🍿 Будем смотреть (" + wishlistTitles.size + ")";
 wishlistBtn.onclick = () => {
     const list = Array.from(wishlistTitles);
     currentCategoryName = "🍿 Будем смотреть";
     openData(list, true, "🍿 Будем смотреть");
 };
 app.appendChild(wishlistBtn);

 // ===== ОБЪЕДИНЕННАЯ КНОПКА ПРОСМОТРЕННОГО =====
 let watchedBtn = document.createElement("button");
 watchedBtn.className = "btn-pink-style";
 const totalWatched = watchedByMe.size + watchedByPartner.size + watchedTogether.size;
 watchedBtn.textContent = "🎬 Просмотрено (" + totalWatched + ")";
watchedBtn.onclick = () => {
    currentCategoryName = "🎬 Просмотрено";

    const watchedData = {
        [`Просмотрено мной (${watchedByMe.size})`]: Array.from(watchedByMe),
        [`Просмотрено партнёром (${watchedByPartner.size})`]: Array.from(watchedByPartner),
        [`Просмотрено нами (${watchedTogether.size})`]: Array.from(watchedTogether)
    };

    openData(watchedData, true, "🎬 Просмотрено");
};
 app.appendChild(watchedBtn);

 if (currentUser) {
     let hrBeforeChat = document.createElement("hr");
     hrBeforeChat.style.border = "0";
     hrBeforeChat.style.borderTop = "2px solid #9b4f70";
     hrBeforeChat.style.margin = "20px 0";
     app.appendChild(hrBeforeChat);
     let chatBtn = document.createElement("button");
     chatBtn.className = "btn-chat-purple";
     chatBtn.textContent = "💬 Чат";
     chatBtn.onclick = () => showChatScreen();
     app.appendChild(chatBtn);
     // ===== КНОПКА КОММЕНТАРИЕВ =====
     let commentsBtn = document.createElement("button");
     commentsBtn.className = "btn-chat-purple";
     commentsBtn.textContent = "💭 Комментарии";
     commentsBtn.onclick = () => showGlobalCommentsScreen();
     app.appendChild(commentsBtn);
 }
 let footer = document.createElement("p");
 footer.style.textAlign = "center";
 footer.style.marginTop = "40px";
 footer.style.fontSize = "10px";
 footer.style.color = "#999";
 footer.innerHTML = 'Музыка: "Echoes Of Home" by Scott Buckley (www.scottbuckley.com.au) — Licensed under CC-BY 4.0';
 app.appendChild(footer);
}
// =======================================================
// ОТРИСОВКА ЭЛЕМЕНТА (ТАЙТЛА)
// =======================================================
function renderItemRow(itemText, container) {
let wrapper = document.createElement("div");
wrapper.className = "movie-item";
let row = document.createElement("div");
 row.className = "item-row";
 let itemDiv = document.createElement("div");
 itemDiv.className = "item";
 let isSecret = itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал");
 if (currentCategoryName && (currentCategoryName.includes("Секрет") || currentCategoryName.includes("🔒") || currentCategoryName.includes("❤️"))) {
     isSecret = true;
 }
 if (isSecret) {
     itemDiv.textContent = itemText.replace(/\s*\(\d{4}\)$/, "");
 } else {
     let titleSpan = document.createElement("span");
     titleSpan.textContent = itemText;
     itemDiv.appendChild(titleSpan);
     if (isRecentlyAdded(itemText)) {
         itemDiv.style.display = "flex";
         itemDiv.style.justifyContent = "space-between";
         itemDiv.style.alignItems = "center";
         itemDiv.style.gap = "8px";
         let newDot = document.createElement("span");
         newDot.className = "new-title-dot";
         newDot.title = "Добавлено недавно";
         itemDiv.appendChild(newDot);
     }
     itemDiv.style.cursor = "pointer";
     itemDiv.style.userSelect = "none";
     itemDiv.style.webkitUserSelect = "none";
     let pressTimer = null;
     let isMoving = false;
     let startX = 0, startY = 0;
     const startPress = (e) => {
         isMoving = false;
         if (e.type === 'touchstart') {
             startX = e.touches[0].clientX;
             startY = e.touches[0].clientY;
         }
         pressTimer = setTimeout(() => {
             if (!isMoving) {
                 showActionMenu(itemText);
             }
         }, 700);
     };
     const cancelPress = () => {
         if (pressTimer !== null) {
             clearTimeout(pressTimer);
             pressTimer = null;
         }
     };
     const movePress = (e) => {
         if (e.type === 'touchmove') {
             let diffX = Math.abs(e.touches[0].clientX - startX);
             let diffY = Math.abs(e.touches[0].clientY - startY);
             if (diffX > 10 || diffY > 10) {
                 isMoving = true;
                 cancelPress();
             }
         }
     };
     const preventPhantomClick = (e) => {
         e.preventDefault();
         e.stopPropagation();
     };
     itemDiv.addEventListener("mousedown", startPress);
     itemDiv.addEventListener("mouseup", cancelPress);
     itemDiv.addEventListener("mouseleave", cancelPress);
     itemDiv.addEventListener("click", (e) => { e.preventDefault(); });
     itemDiv.addEventListener("touchstart", startPress, { passive: true });
     itemDiv.addEventListener("touchmove", movePress, { passive: true });
     itemDiv.addEventListener("touchend", (e) => {
         cancelPress();
         if (isMoving) return;
         if (pressTimer === null) {
             preventPhantomClick(e);
         }
     }, { passive: false });
     itemDiv.addEventListener("touchcancel", cancelPress);
 }
 row.appendChild(itemDiv);
 if (!isSecret) {
     let watchBtn = document.createElement("button");
     watchBtn.className = "btn-watch";
     if (watchedByMe.has(itemText) || watchedTogether.has(itemText)) {
         watchBtn.classList.add("watched");
         watchBtn.textContent = "★";
     } else if (watchedByPartner.has(itemText)) {
         watchBtn.classList.add("watched-partner");
         watchBtn.textContent = "★";
     } else if (wishlistTitles.has(itemText)) {
         watchBtn.classList.add("wishlist-active");
         watchBtn.textContent = "★";
     } else {
         watchBtn.textContent = "☆";
     }
     watchBtn.onclick = () => handleStarClick(itemText);
     row.appendChild(watchBtn);
 }
 wrapper.appendChild(row);
 if (!isSecret) {
     let ratingsDiv = document.createElement("div");
     ratingsDiv.className = "item-ratings";
     ratingsDiv.textContent = formatRatings(itemText);
     wrapper.appendChild(ratingsDiv);
 }
 container.appendChild(wrapper);
}
// =======================================================
// ГЛОБАЛЬНЫЙ ЭКРАН КОММЕНТАРИЕВ
// =======================================================
async function showGlobalCommentsScreen() {
startTransitionLock();
isChatScreenOpen = false;
if (chatPollInterval) {
clearInterval(chatPollInterval);
chatPollInterval = null;
}
currentCategoryName = null;
let oldNav = document.querySelector(".navigation");
 if (oldNav) oldNav.remove();
 app.innerHTML = "";
 let title = document.createElement("h1");
 title.textContent = "💭 Комментарии";
 app.appendChild(title);
 let loading = document.createElement("p");
 loading.style.textAlign = "center";
 loading.style.color = "#999";
 loading.textContent = "Загрузка...";
 app.appendChild(loading);
 const allComments = await loadAllComments();
 loading.remove();
 if (allComments.length === 0) {
     let empty = document.createElement("p");
     empty.style.textAlign = "center";
     empty.style.color = "#999";
     empty.style.marginTop = "20px";
     empty.textContent = "Комментариев пока нет.";
     app.appendChild(empty);
 } else {
     // Группируем комментарии по тайтлу
     const byTitle = {};
     allComments.forEach(c => {
         if (!byTitle[c.title]) byTitle[c.title] = [];
         byTitle[c.title].push(c);
     });
     for (let titleName in byTitle) {
         let titleBlock = document.createElement("div");
         titleBlock.style.marginBottom = "20px";
         titleBlock.style.textAlign = "left";
         let titleHeader = document.createElement("div");
         titleHeader.style.fontWeight = "bold";
         titleHeader.style.fontSize = "16px";
         titleHeader.style.color = "#9b4f70";
         titleHeader.style.marginBottom = "8px";
         titleHeader.style.padding = "0 4px";
         titleHeader.textContent = titleName;
         titleBlock.appendChild(titleHeader);
         byTitle[titleName].forEach(c => {
             const card = document.createElement("div");
             card.className = "comment-card";
             const isMine = c.user_id === currentUser.id;
             card.innerHTML = `
                 <div class="comment-card-header"><span></span><span></span></div>
                 <div class="comment-card-text"></div>
                 ${isMine ? `<div class="comment-card-actions">
                     <button class="btn-action-edit" data-act="edit">✏️ Изменить</button>
                     <button class="btn-action-delete" data-act="delete">🗑️ Удалить</button>
                 </div>` : ``}
             `;
             card.querySelector(".comment-card-header span:first-child").textContent = c.username;
             card.querySelector(".comment-card-header span:last-child").textContent = formatChatTime(c.created_at);
             card.querySelector(".comment-card-text").textContent = c.comment;
             if (isMine) {
                 card.querySelector('[data-act="edit"]').onclick = () => {
                     showGlobalCommentEditForm(card, c, titleBlock);
                 };
                 card.querySelector('[data-act="delete"]').onclick = async () => {
                     if (!confirm("Удалить ваш комментарий?")) return;
                     const { error } = await db.from('comments').delete().eq('id', c.id);
                     if (error) {
                         alert("Не удалось удалить комментарий.");
                         return;
                     }
                     card.remove();
                     if (titleBlock.querySelectorAll('.comment-card').length === 0) {
                         titleBlock.remove();
                     }
                 };
             }
             titleBlock.appendChild(card);
         });
         app.appendChild(titleBlock);
     }
 }
 // Навигация
 let nav = document.createElement("div");
 nav.className = "navigation";
 let homeBtn = document.createElement("button");
 homeBtn.textContent = "🏠 Домой";
 homeBtn.onclick = () => {
     showHome();
 };
 nav.appendChild(homeBtn);
 let container = document.querySelector(".container");
 if (container) {
     container.insertBefore(nav, container.firstChild);
 } else {
     document.body.insertBefore(nav, app);
 }
}
function showGlobalCommentEditForm(cardEl, comment, titleBlock) {
// Убираем старые формы редактирования
titleBlock.querySelectorAll('.global-comment-edit-form').forEach(f => f.remove());
const form = document.createElement("div");
 form.className = "global-comment-edit-form";
 form.style.cssText = `
     background: white;
     padding: 12px;
     border-radius: 14px;
     margin: 8px 0;
     box-shadow: 0 4px 12px rgba(180,80,120,0.15);
 `;
 form.innerHTML = `
     <input type="text" class="edit-comment-input" style="
         width: 100%;
         padding: 10px;
         border: 2px solid #ffdce5;
         border-radius: 10px;
         font-size: 14px;
         margin-bottom: 8px;
         box-sizing: border-box;
     " value="">
     <div style="display: flex; gap: 8px;">
         <button class="btn-save" style="flex: 1; padding: 8px;">Сохранить</button>
         <button class="btn-cancel" style="flex: 1; padding: 8px;">Отмена</button>
     </div>
 `;
 const input = form.querySelector('.edit-comment-input');
 input.value = comment.comment;
 input.focus();
 form.querySelector('.btn-save').onclick = async () => {
     const newText = input.value.trim();
     if (!newText || newText === comment.comment) {
         form.remove();
         return;
     }
     const { error } = await db.from('comments').update({ comment: newText }).eq('id', comment.id);
     if (error) {
         alert("Не удалось изменить комментарий.");
         return;
     }
     comment.comment = newText;
     cardEl.querySelector('.comment-card-text').textContent = newText;
     form.remove();
 };
 form.querySelector('.btn-cancel').onclick = () => {
     form.remove();
 };
 cardEl.after(form);
}
// =======================================================
// TMDB ПОСТЕРЫ
// =======================================================
async function fetchTmdbPoster(itemText) {
if (!TMDB_API_KEY || TMDB_API_KEY.includes("ВСТАВЬТЕ")) return null;
const match = itemText.match(/^(.*)\s\((\d{4})\)$/);
 const title = match ? match[1] : itemText;
 const year = match ? match[2] : null;
 try {
     const movieParams = new URLSearchParams({ api_key: TMDB_API_KEY, query: title, language: "ru-RU" });
     if (year) movieParams.set("year", year);
     let res = await fetch(`https://api.themoviedb.org/3/search/movie?${movieParams.toString()}`);
     let json = await res.json();
     let result = json.results && json.results[0];
     if (!result) {
         const tvParams = new URLSearchParams({ api_key: TMDB_API_KEY, query: title, language: "ru-RU" });
         if (year) tvParams.set("first_air_date_year", year);
         res = await fetch(`https://api.themoviedb.org/3/search/tv?${tvParams.toString()}`);
         json = await res.json();
         result = json.results && json.results[0];
     }
     if (result && result.poster_path) {
         return TMDB_IMG_BASE + result.poster_path;
     }
     return null;
 } catch (e) {
     console.error("Ошибка при запросе постера с TMDB:", e);
     return null;
 }
}
// ==========================================
// СТИКЕРЫ ЧАТА
// ==========================================
let cachedStickerList = null;
async function fetchStickerList() {
if (cachedStickerList) return cachedStickerList;
try {
     const apiUrl = `https://api.github.com/repos/${GITHUB_STICKERS_OWNER}/${GITHUB_STICKERS_REPO}/contents/${GITHUB_STICKERS_PATH}?ref=${GITHUB_STICKERS_BRANCH}`;
     const res = await fetch(apiUrl);
     if (!res.ok) throw new Error("GitHub API вернул статус " + res.status);
     const json = await res.json();
     if (!Array.isArray(json)) return [];
     const imageExtRe = /\.(png|jpe?g|gif|webp)$/i;
     cachedStickerList = json
         .filter(f => f.type === "file" && imageExtRe.test(f.name))
         .map(f => ({
             name: f.name,
             url: `https://raw.githubusercontent.com/${GITHUB_STICKERS_OWNER}/${GITHUB_STICKERS_REPO}/${GITHUB_STICKERS_BRANCH}/${GITHUB_STICKERS_PATH}/${f.name}`
         }));
     return cachedStickerList;
 } catch (e) {
     console.error("Ошибка при загрузке списка стикеров с GitHub:", e);
     return [];
 }
}
function isStickerMessage(messageText) {
return typeof messageText === "string" && messageText.startsWith(STICKER_PREFIX);
}
function getStickerUrl(messageText) {
return messageText.slice(STICKER_PREFIX.length);
}
function showStickerPicker(onPick) {
const overlay = document.createElement("div");
overlay.className = "modal-overlay";
overlay.id = "stickerPickerModal";
overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
overlay.innerHTML = `
     <div class="modal-content" style="max-height:70vh; overflow-y:auto;">
         <h3 style="text-align:center; margin-bottom:15px;">😊 Стикеры</h3>
         <div class="sticker-grid" id="stickerGrid">
             <p style="text-align:center;color:#999;font-size:13px;">Загружаем стикеры...</p>
         </div>
         <button class="btn-action-cancel" id="stickerPickerCancel" style="margin-top:15px;width:100%;">Закрыть</button>
     </div>
 `;
 document.body.appendChild(overlay);
 document.getElementById("stickerPickerCancel").onclick = () => overlay.remove();
 fetchStickerList().then(list => {
     const grid = document.getElementById("stickerGrid");
     if (!grid) return;
     if (list.length === 0) {
         grid.innerHTML = `<p style="text-align:center;color:#999;font-size:13px;">Стикеры не найдены. Проверьте настройки GITHUB_STICKERS_* в script.js</p>`;
         return;
     }
     grid.innerHTML = "";
     list.forEach(sticker => {
         const img = document.createElement("img");
         img.src = sticker.url;
         img.alt = sticker.name;
         img.loading = "lazy";
         img.className = "sticker-thumb";
         img.onclick = () => {
             overlay.remove();
             onPick(sticker.url);
         };
         grid.appendChild(img);
     });
 });
}
function showActionMenu(itemText) {
if (itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал")) return;
const overlay = document.createElement("div");
 overlay.className = "modal-overlay";
 overlay.id = "actionMenuModal";
 overlay.innerHTML = `
     <div class="modal-content" style="text-align: center;">
         <h3 style="margin-bottom: 10px;" id="menuTitle"></h3>
         <div id="posterBox" style="margin: 10px 0 15px; display: flex; justify-content: center;">
             <p style="color: #999; font-size: 13px;">Ищем постер...</p>
         </div>
         <p style="color: #666; margin-bottom: 20px; font-size: 14px;">Выберите действие для этого тайтла:</p>
         <div class="action-buttons" style="display: flex; flex-direction: column; gap: 10px;">
             <button class="btn-pink-style" id="actTrailer">🎬 Трейлер на YouTube</button>
             <button class="btn-pink-style" id="actComment">💬 Комментарии</button>
             <button class="btn-pink-style" id="actEdit">✏️ Редактировать</button>
             <button class="btn-pink-style" id="actDelete">❌ Удалить из базы</button>
             <button class="btn-cancel-gray" id="actCancel">Отмена</button>
         </div>
     </div>
 `;
 overlay.querySelector("#menuTitle").textContent = itemText;
 document.body.appendChild(overlay);
 const posterBox = overlay.querySelector("#posterBox");
 fetchTmdbPoster(itemText).then(url => {
     if (!overlay.isConnected) return;
     if (url) {
         posterBox.innerHTML = `<img src="${url}" alt="Постер" style="max-width: 160px; border-radius: 12px; box-shadow: 0 6px 18px rgba(180,80,120,0.25);">`;
     } else {
         posterBox.innerHTML = `<p style="color: #999; font-size: 13px;">Постер к фильму не найден</p>`;
     }
 });
 document.getElementById("actTrailer").onclick = () => {
     overlay.remove();
     const query = encodeURIComponent(itemText + " трейлер");
     window.open(`https://www.youtube.com/results?search_query=${query}`, "_blank");
 };
 document.getElementById("actComment").onclick = () => {
     overlay.remove();
     showCommentsModal(itemText);
 };
 document.getElementById("actEdit").onclick = () => {
     overlay.remove();
     handleEditClick(itemText);
 };
 document.getElementById("actDelete").onclick = () => {
     overlay.remove();
     handleDeleteClick(itemText);
 };
 document.getElementById("actCancel").onclick = () => {
     overlay.remove();
 };
}
function showRatingModal(itemText) {
if (!currentUser) return;
const myUsername = getUsernameFromEmail(currentUser.email);
 const existing = (ratingsData[itemText] || []).find(r => r.userId === currentUser.id);
 const currentScore = existing ? existing.score : 0;
 const overlay = document.createElement("div");
 overlay.className = "modal-overlay";
 overlay.id = "ratingModal";
 let starsHtml = "";
 for (let i = 1; i <= 10; i++) {
     starsHtml += `<span class="rating-star${i <= currentScore ? " filled" : ""}" data-value="${i}">★</span>`;
 }
 overlay.innerHTML = `
     <div class="modal-content" style="text-align: center;">
         <h3 style="margin-bottom: 10px;">Оценка (${myUsername})</h3>
         <p style="color: #666; margin-bottom: 15px; font-size: 14px;">"${itemText.replace(/\s*\(\d{4}\)$/, "")}"</p>
         <div class="rating-stars" id="ratingStars">${starsHtml}</div>
         <p id="ratingValueLabel" style="color: #9b4f70; font-weight: bold; margin: 10px 0 20px; min-height: 18px;">${currentScore > 0 ? currentScore + "/10" : ""}</p>
         <div class="action-buttons" style="display: flex; flex-direction: column; gap: 10px;">
             ${existing ? '<button id="ratingDelete" class="btn-action-delete">🗑️ Удалить мою оценку</button>' : ''}
             <button id="ratingCancel" class="btn-action-cancel">Закрыть</button>
         </div>
     </div>
 `;
 document.body.appendChild(overlay);
 const starsContainer = document.getElementById("ratingStars");
 const valueLabel = document.getElementById("ratingValueLabel");
 const starEls = Array.from(starsContainer.querySelectorAll(".rating-star"));
 function paintStars(value) {
     starEls.forEach(el => {
         const v = parseInt(el.dataset.value, 10);
         el.classList.toggle("filled", v <= value);
     });
 }
 starEls.forEach(el => {
     const v = parseInt(el.dataset.value, 10);
     el.addEventListener("mouseenter", () => {
         paintStars(v);
         valueLabel.textContent = v + "/10";
     });
     el.addEventListener("click", async () => {
         // Безопасное сохранение: удаляем старую оценку (если была) и вставляем новую
         await db.from('ratings').delete().eq('title', itemText).eq('user_id', currentUser.id);
         const { error } = await db.from('ratings').insert({
             title: itemText,
             user_id: currentUser.id,
             username: myUsername,
             score: v
         });
         if (error) {
             console.error("Ошибка при сохранении оценки:", error);
             alert("Не удалось сохранить оценку.");
             return;
         }
         overlay.remove();
         refreshRatingsUI();
     });
 });
 starsContainer.addEventListener("mouseleave", () => {
     paintStars(currentScore);
     valueLabel.textContent = currentScore > 0 ? currentScore + "/10" : "";
 });
 document.getElementById("ratingCancel").onclick = () => overlay.remove();
 if (existing) {
     document.getElementById("ratingDelete").onclick = async () => {
         overlay.remove();
         const { error } = await db.from('ratings')
             .delete()
             .eq('title', itemText)
             .eq('user_id', currentUser.id);
         if (error) {
             console.error("Ошибка при удалении оценки:", error);
             alert("Не удалось удалить оценку.");
         } else {
             refreshRatingsUI();
         }
     };
 }
}
async function showCommentsModal(itemText) {
if (!currentUser) return;
const overlay = document.createElement("div");
 overlay.className = "modal-overlay";
 overlay.id = "commentsModal";
 overlay.innerHTML = `
     <div class="modal-content" style="text-align: center;">
         <h3 style="margin-bottom: 10px;">💬 Комментарии</h3>
         <p style="color: #666; margin-bottom: 15px; font-size: 14px;">"${itemText.replace(/\s*\(\d{4}\)$/, "")}"</p>
         <div class="comments-list" id="commentsList">
             <p style="text-align:center;color:#999;font-size:13px;">Загрузка...</p>
         </div>
         <div id="commentFormBox"></div>
         <div class="action-buttons" style="margin-top: 10px;">
             <button id="commentsClose" class="btn-action-cancel">Закрыть</button>
         </div>
     </div>
 `;
 document.body.appendChild(overlay);
 overlay.querySelector("#commentsClose").onclick = () => overlay.remove();
 const myUsername = getUsernameFromEmail(currentUser.email);
 const listEl = overlay.querySelector("#commentsList");
 const formBox = overlay.querySelector("#commentFormBox");
 async function refresh() {
     const comments = await loadCommentsForTitle(itemText);
     if (!overlay.isConnected) return;
     listEl.innerHTML = "";
     if (comments.length === 0) {
         listEl.innerHTML = `<p style="text-align:center;color:#999;font-size:13px;">Комментариев пока нет.</p>`;
     } else {
         comments.forEach(c => {
             const card = document.createElement("div");
             card.className = "comment-card";
             const isMine = c.user_id === currentUser.id;
             card.innerHTML = `
                 <div class="comment-card-header"><span>${c.username}</span></div>
                 <div class="comment-card-text"></div>
                 ${isMine ? `<div class="comment-card-actions">
                     <button class="btn-action-edit" data-act="edit">✏️ Изменить</button>
                     <button class="btn-action-delete" data-act="delete">🗑️ Удалить</button>
                 </div>` : ``}
             `;
             card.querySelector(".comment-card-text").textContent = c.comment;
             if (isMine) {
                 card.querySelector('[data-act="edit"]').onclick = () => showCommentForm(c);
                 card.querySelector('[data-act="delete"]').onclick = async () => {
                     if (!confirm("Удалить ваш комментарий?")) return;
                     const { error } = await db.from('comments').delete().eq('id', c.id);
                     if (error) {
                         alert("Не удалось удалить комментарий.");
                         return;
                     }
                     await refresh();
                 };
             }
             listEl.appendChild(card);
         });
     }
     const myComment = comments.find(c => c.user_id === currentUser.id);
     showCommentForm(myComment || null);
 }
 function showCommentForm(existingComment) {
     formBox.innerHTML = "";
     if (existingComment && formBox.dataset.editing !== "1") {
         return;
     }
     const form = document.createElement("form");
     form.className = "modal-form";
     form.innerHTML = `
         <label style="text-align:left;">${existingComment ? "Изменить комментарий (" + myUsername + ")" : "Оставить комментарий (" + myUsername + ")"}</label>
         <input type="text" id="commentInput" required maxlength="500" placeholder="Ваш комментарий...">
         <div class="modal-buttons">
             <button type="submit" class="btn-save">Сохранить</button>
             ${existingComment ? `<button type="button" class="btn-cancel" id="commentFormCancel">Отмена</button>` : ``}
         </div>
     `;
     formBox.appendChild(form);
     formBox.dataset.editing = "1";
     const input = form.querySelector("#commentInput");
     if (existingComment) input.value = existingComment.comment;
     input.focus();
     const cancelBtn = form.querySelector("#commentFormCancel");
     if (cancelBtn) {
         cancelBtn.onclick = () => {
             formBox.dataset.editing = "0";
             formBox.innerHTML = "";
         };
     }
     form.onsubmit = async (e) => {
         e.preventDefault();
         const text = input.value.trim();
         if (!text) return;
         
         let error;
         if (existingComment) {
             const res = await db.from('comments').update({ comment: text }).eq('id', existingComment.id);
             error = res.error;
         } else {
             const res = await db.from('comments').insert({
                 title: itemText,
                 user_id: currentUser.id,
                 username: myUsername,
                 comment: text
             });
             error = res.error;
         }
         
         if (error) {
             console.error("Ошибка при сохранении комментария:", error);
             alert("Не удалось сохранить комментарий.");
             return;
         }
         formBox.dataset.editing = "0";
         await refresh();
     };
 }
 await refresh();
}
// =======================================================
// ОТКРЫТИЕ ДАННЫХ (КАТЕГОРИИ/ЖАНРЫ/ФИЛЬМЫ)
// =======================================================
function openData(content, saveHistory = true, customTitle = null) {
startTransitionLock();
isChatScreenOpen = false;
if (chatPollInterval) {
clearInterval(chatPollInterval);
chatPollInterval = null;
}
if (saveHistory) {
history.push(content);
}
app.innerHTML = "";
 if (customTitle) {
     let title = document.createElement("h1");
     title.textContent = customTitle;
     app.appendChild(title);
 }
 if (currentCategoryName === "🔍 Результаты поиска" && currentUser) {
     app.appendChild(buildSearchBar(lastSearchQuery));
 }
 if (Array.isArray(content)) {
     content.forEach(item => {
         if (typeof item === "string") {
             renderItemRow(item, app);
         } 
         else if (typeof item === "object" && item !== null) {
             for (let franchiseName in item) {
                 let button = document.createElement("button");
                 button.textContent = franchiseName;
                 button.onclick = () => openData(item[franchiseName], true);
                 app.appendChild(button);
             }
         }
     });
 }
 else if (typeof content === "object" && content !== null) {
     for (let key in content) {
         let value = content[key];
         let button = document.createElement("button");
         button.textContent = key;
         button.onclick = () => openData(value, true);
         app.appendChild(button);
     }
 }
 const isInSecretCategory = currentCategoryName && isSecretCategory(currentCategoryName);
 const totalTitlesCount = getAllTitlesFromCategory(content).length;
 if (totalTitlesCount > 0 && !isInSecretCategory) {
     let countFooter = document.createElement("p");
     countFooter.className = "count-footer";
     countFooter.textContent = `Всего тайтлов: ${totalTitlesCount}`;
     app.appendChild(countFooter);
 }
 // ===== ИСПРАВЛЕНИЕ: тумблер темы ТОЛЬКО на уровне категории (history.length === 1) =====
 // history.length === 1 означает, что мы только что кликнули по категории (первый уровень)
 // и ещё не углубились в жанры/франшизы
 if (isInSecretCategory && currentUser && history.length === 1) {
     app.appendChild(buildThemeToggle());
 }
 addNavigation();
}
function addNavigation() {
let oldNav = document.querySelector(".navigation");
if (oldNav) {
oldNav.remove();
}
let nav = document.createElement("div");
 nav.className = "navigation";
 let back = document.createElement("button");
 back.textContent = "⬅ Назад";
 back.onclick = () => {
     history.pop();
     let previous = history[history.length - 1];
     if (previous) {
         openData(previous, false);
     } else {
         showHome();
     }
 };
 let home = document.createElement("button");
 home.textContent = "🏠 Домой";
 home.onclick = showHome;
 nav.appendChild(back);
 nav.appendChild(home);
 let container = document.querySelector(".container");
 if (container) {
     container.insertBefore(nav, container.firstChild);
 } else {
     document.body.insertBefore(nav, app);
 }
}
// =======================================================
// ЧАТ
// =======================================================
async function loadChatMessages() {
const { data, error } = await db
.from('chat_messages')
.select('*')
.order('created_at', { ascending: false })
.limit(150);
if (error) {
    console.error("Ошибка при загрузке чата:", error);
    return;
}
chatMessages = data.reverse();
}
async function onChatRealtimeChange() {
await loadChatMessages();
if (isChatScreenOpen) {
renderChatMessages();
}
}
function setChatReplyTarget(msg) {
chatReplyTarget = msg;
renderChatReplyBar();
const input = document.getElementById("chatInput");
if (input) input.focus();
}
function clearChatReplyTarget() {
chatReplyTarget = null;
renderChatReplyBar();
}
function renderChatReplyBar() {
const box = document.getElementById("chatReplyBarBox");
if (!box) return;
if (!chatReplyTarget) {
     box.innerHTML = "";
     return;
 }
 box.innerHTML = `
     <div class="chat-reply-bar">
         <div class="chat-reply-bar-info">
             <span class="chat-reply-bar-author"></span>
             <span class="chat-reply-bar-text"></span>
         </div>
         <button type="button" class="chat-reply-bar-cancel" id="chatReplyCancelBtn">✕</button>
     </div>
 `;
 box.querySelector(".chat-reply-bar-author").textContent = chatReplyTarget.username;
 box.querySelector(".chat-reply-bar-text").textContent = buildReplyPreviewText(chatReplyTarget);
 box.querySelector("#chatReplyCancelBtn").onclick = () => clearChatReplyTarget();
}
function formatChatTime(isoString) {
const d = new Date(isoString);
const datePart = d.toLocaleDateString( "ru-RU ", { day:  "2-digit ", month:  "2-digit ", year:  "2-digit " });
const timePart = d.toLocaleTimeString( "ru-RU ", { hour:  "2-digit ", minute:  "2-digit " });
return  `${datePart}, ${timePart}` ;
}
const CHAT_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
function canModifyChatMessage(msg) {
const createdTime = new Date(msg.created_at).getTime();
if (isNaN(createdTime)) return false;
return (Date.now() - createdTime) < CHAT_EDIT_WINDOW_MS;
}
function buildReplyPreviewText(msg) {
if (isStickerMessage(msg.message)) return "🖼️ Стикер";
const text = msg.message || "";
return text.length > 60 ? text.slice(0, 60) + "…" : text;
}
function createChatBubble(msg) {
let bubble = document.createElement("div");
const isMine = currentUser && msg.user_id === currentUser.id;
bubble.className = "chat-bubble " + (isMine ? "chat-bubble-mine" : "chat-bubble-theirs");
bubble.dataset.msgId = msg.id;
if (msg.reply_to_username) {
     let quote = document.createElement("div");
     quote.className = "chat-reply-quote";
     quote.innerHTML = `<span class="chat-reply-quote-author"></span><br><span class="chat-reply-quote-text"></span>`;
     quote.querySelector(".chat-reply-quote-author").textContent = msg.reply_to_username;
     quote.querySelector(".chat-reply-quote-text").textContent = msg.reply_to_text || "";
     bubble.appendChild(quote);
 }
 let meta = document.createElement("div");
 meta.className = "chat-meta";
 meta.textContent = `${msg.username} • ${formatChatTime(msg.created_at)}`;
 let text = document.createElement("div");
 text.className = "chat-text";
 if (isStickerMessage(msg.message)) {
     bubble.classList.add("chat-bubble-sticker");
     let img = document.createElement("img");
     img.src = getStickerUrl(msg.message);
     img.alt = "стикер";
     img.className = "chat-sticker-img";
     img.draggable = false;
     img.oncontextmenu = (e) => e.preventDefault();
     text.appendChild(img);
 } else {
     text.textContent = msg.message;
 }
 bubble.appendChild(meta);
 bubble.appendChild(text);
 if (msg.reaction) {
     let heart = document.createElement("div");
     heart.className = "chat-reaction-heart";
     heart.textContent = msg.reaction;
     bubble.appendChild(heart);
 }
 bubble.style.cursor = "pointer";
 attachChatLongPress(bubble, msg, isMine);
 if (!isMine) {
     attachChatDoubleTap(bubble, msg);
 }
 return bubble;
}
function updateChatBubbleContent(bubbleEl, msg) {
const quoteTextEl = bubbleEl.querySelector(".chat-reply-quote-text");
if (quoteTextEl) {
const quoteText = msg.reply_to_text || "";
if (quoteTextEl.textContent !== quoteText) {
quoteTextEl.textContent = quoteText;
}
}
if (isStickerMessage(msg.message)) return;
 const textEl = bubbleEl.querySelector(".chat-text");
 if (textEl && textEl.textContent !== msg.message) {
     textEl.textContent = msg.message;
 }
 const metaEl = bubbleEl.querySelector(".chat-meta");
 const metaText = `${msg.username} • ${formatChatTime(msg.created_at)}`;
 if (metaEl && metaEl.textContent !== metaText) {
     metaEl.textContent = metaText;
 }
 let heartEl = bubbleEl.querySelector(".chat-reaction-heart");
 if (msg.reaction) {
     if (!heartEl) {
         heartEl = document.createElement("div");
         heartEl.className = "chat-reaction-heart";
         bubbleEl.appendChild(heartEl);
     }
     heartEl.textContent = msg.reaction;
 } else if (heartEl) {
     heartEl.remove();
 }
}
function attachChatLongPress(el, msg, isMine) {
let pressTimer = null;
let isMoving = false;
let startX = 0, startY = 0;
const startPress = (e) => {
     isMoving = false;
     if (e.type === 'touchstart') {
         startX = e.touches[0].clientX;
         startY = e.touches[0].clientY;
     }
     pressTimer = setTimeout(() => {
         if (!isMoving) {
             vibrate(15);
             showChatMessageMenu(msg, isMine);
         }
     }, 600);
 };
 const cancelPress = () => {
     if (pressTimer !== null) {
         clearTimeout(pressTimer);
         pressTimer = null;
     }
 };
 const movePress = (e) => {
     if (e.type === 'touchmove') {
         let diffX = Math.abs(e.touches[0].clientX - startX);
         let diffY = Math.abs(e.touches[0].clientY - startY);
         if (diffX > 10 || diffY > 10) {
             isMoving = true;
             cancelPress();
         }
     }
 };
 el.addEventListener("mousedown", startPress);
 el.addEventListener("mouseup", cancelPress);
 el.addEventListener("mouseleave", cancelPress);
 el.addEventListener("touchstart", startPress, { passive: true });
 el.addEventListener("touchmove", movePress, { passive: true });
 el.addEventListener("touchend", cancelPress, { passive: true });
 el.addEventListener("touchcancel", cancelPress);
}
function attachChatDoubleTap(el, msg) {
let lastTapTime = 0;
const DOUBLE_TAP_MS = 300;
const handleTap = (e) => {
    const now = Date.now();
    if (now - lastTapTime < DOUBLE_TAP_MS) {
        lastTapTime = 0;
        e.preventDefault();
        toggleHeartReaction(msg);
    } else {
        lastTapTime = now;
    }
};
el.addEventListener("dblclick", (e) => {
    e.preventDefault();
    toggleHeartReaction(msg);
});
el.addEventListener("touchend", handleTap, { passive: false });
}
async function toggleHeartReaction(msg) {
if (!currentUser) return;
const alreadyMine = msg.reaction && msg.reaction_by === currentUser.id;
const newReaction = alreadyMine ? null : "❤️";
const newReactionBy = alreadyMine ? null : currentUser.id;
vibrate(20);
const local = chatMessages.find(m => m.id === msg.id);
if (local) {
    local.reaction = newReaction;
    local.reaction_by = newReactionBy;
    renderChatMessages();
}
const { error } = await db.from('chat_messages')
    .update({ reaction: newReaction, reaction_by: newReactionBy })
    .eq('id', msg.id);
if (error) {
    console.error("Ошибка при сохранении реакции:", error);
}
}
function showChatMessageMenu(msg, isMine) {
const canModify = isMine && canModifyChatMessage(msg);
const isSticker = isStickerMessage(msg.message);
const overlay = document.createElement("div");
 overlay.className = "modal-overlay";
 overlay.id = "chatMsgMenuModal";
 overlay.innerHTML = `
     <div class="modal-content" style="text-align: center;">
         <h3 style="margin-bottom: 15px;">Сообщение</h3>
         <div class="action-buttons">
             <button class="btn-action-edit" id="chatMsgReply">↩️ Ответить</button>
             ${canModify && !isSticker ? `<button class="btn-action-edit" id="chatMsgEdit">✏️ Редактировать</button>` : ``}
             ${canModify ? `<button class="btn-action-delete" id="chatMsgDelete">🗑️ Удалить</button>` : ``}
             <button class="btn-action-cancel" id="chatMsgCancel">${canModify ? "Отмена" : "Закрыть"}</button>
         </div>
         ${isMine && !canModify ? `<p style="color: #777; font-size: 13px; margin-top: 12px;">Изменять и удалять сообщение можно только в течение 24 часов после отправки.</p>` : ``}
     </div>
 `;
 document.body.appendChild(overlay);
 document.getElementById("chatMsgCancel").onclick = () => overlay.remove();
 document.getElementById("chatMsgReply").onclick = () => {
     overlay.remove();
     setChatReplyTarget(msg);
 };
 if (!canModify) return;
 const editBtn = document.getElementById("chatMsgEdit");
 if (editBtn) editBtn.onclick = () => {
     overlay.remove();
     if (!canModifyChatMessage(msg)) {
         alert("Время редактирования истекло (доступно только 24 часа после отправки).");
         return;
     }
     showChatMessageEditModal(msg);
 };
 document.getElementById("chatMsgDelete").onclick = async () => {
     overlay.remove();
     if (!canModifyChatMessage(msg)) {
         alert("Время удаления истекло (доступно только 24 часа после отправки).");
         return;
     }
     if (!confirm("Удалить это сообщение?")) return;
     const { error: replyUpdateError } = await db.from('chat_messages')
         .update({ reply_to_text: "Сообщение удалено" })
         .eq('reply_to_id', msg.id);
     if (replyUpdateError) {
         console.error("Ошибка при обновлении ответов на удаляемое сообщение:", replyUpdateError);
     }
     const { error } = await db.from('chat_messages').delete().eq('id', msg.id);
     if (error) {
         console.error("Ошибка при удалении сообщения:", error);
         alert("Не удалось удалить сообщение.");
         return;
     }
     chatMessages = chatMessages.filter(m => m.id !== msg.id);
     chatMessages.forEach(m => {
         if (m.reply_to_id === msg.id) m.reply_to_text = "Сообщение удалено";
     });
     renderChatMessages();
 };
}
function showChatMessageEditModal(msg) {
const overlay = document.createElement("div");
overlay.className = "modal-overlay";
overlay.id = "chatMsgEditModal";
overlay.innerHTML = `<div class="modal-content"> <h3 style="text-align: center; margin-bottom: 15px;">Редактировать сообщение</h3> <form class="modal-form" id="chatEditForm"> <input type="text" id="chatEditInput" required> <div class="modal-buttons"> <button type="submit" class="btn-save">Сохранить</button> <button type="button" class="btn-cancel" id="chatEditCancel">Отмена</button> </div> </form> </div>`;
document.body.appendChild(overlay);
const input = overlay.querySelector("#chatEditInput");
 input.value = msg.message;
 input.focus();
 overlay.querySelector("#chatEditCancel").onclick = () => overlay.remove();
 overlay.querySelector("#chatEditForm").onsubmit = async (e) => {
     e.preventDefault();
     const newText = input.value.trim();
     if (!newText || newText === msg.message) {
         overlay.remove();
         return;
     }
     const { error } = await db.from('chat_messages').update({ message: newText }).eq('id', msg.id);
     if (error) {
         console.error("Ошибка при редактировании сообщения:", error);
         alert("Не удалось изменить сообщение.");
         return;
     }
     const local = chatMessages.find(m => m.id === msg.id);
     if (local) local.message = newText;
     overlay.remove();
     renderChatMessages();
 };
}
function renderChatMessages() {
const box = document.getElementById("chatBox");
if (!box) return;
if (chatMessages.length === 0) {
     if (box.dataset.rendered !== "empty") {
         box.innerHTML = "";
         let empty = document.createElement("p");
         empty.style.cssText = "text-align:center;color:#999;margin-top:20px;font-size:14px;";
         empty.textContent = "Сообщений пока нет. Напишите первым!";
         box.appendChild(empty);
         box.dataset.rendered = "empty";
     }
     return;
 }
 if (box.dataset.rendered === "empty") {
     box.innerHTML = "";
     box.dataset.rendered = "list";
 }
 box.dataset.rendered = "list";
 const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
 const renderedEls = new Map();
 box.querySelectorAll("[data-msg-id]").forEach(el => renderedEls.set(el.dataset.msgId, el));
 const currentIds = new Set(chatMessages.map(m => String(m.id)));
 renderedEls.forEach((el, id) => {
     if (!currentIds.has(id)) el.remove();
 });
 let addedNew = false;
 chatMessages.forEach(msg => {
     const idStr = String(msg.id);
     const existingEl = renderedEls.get(idStr);
     if (!existingEl) {
         box.appendChild(createChatBubble(msg));
         addedNew = true;
     } else {
         updateChatBubbleContent(existingEl, msg);
     }
 });
 if (addedNew && wasNearBottom) {
     box.scrollTop = box.scrollHeight;
 }
}
async function showChatScreen() {
startTransitionLock();
isChatScreenOpen = true;
currentCategoryName = null;
let oldNav = document.querySelector(".navigation");
 if (oldNav) oldNav.remove();
 app.innerHTML = "";
 let title = document.createElement("h1");
 title.textContent = "💬 Чат";
 app.appendChild(title);
 let chatBox = document.createElement("div");
 chatBox.className = "chat-box";
 chatBox.id = "chatBox";
 app.appendChild(chatBox);
 let replyBarBox = document.createElement("div");
 replyBarBox.id = "chatReplyBarBox";
 app.appendChild(replyBarBox);
 chatReplyTarget = null;
 renderChatReplyBar();
 let inputRow = document.createElement("div");
 inputRow.className = "chat-input-row";
 let chatInput = document.createElement("input");
 chatInput.type = "text";
 chatInput.id = "chatInput";
 chatInput.placeholder = "Написать сообщение...";
 chatInput.autocomplete = "off";
 let stickerBtn = document.createElement("button");
 stickerBtn.id = "chatStickerBtn";
 stickerBtn.type = "button";
 stickerBtn.textContent = "😊";
 let sendBtn = document.createElement("button");
 sendBtn.id = "chatSendBtn";
 sendBtn.textContent = "➤";
 const sendChatMessage = async (text) => {
     if (!text || !currentUser) return;
     const username = getUsernameFromEmail(currentUser.email);
     const payload = { user_id: currentUser.id, username: username, message: text };
     if (chatReplyTarget) {
         payload.reply_to_id = chatReplyTarget.id;
         payload.reply_to_username = chatReplyTarget.username;
         payload.reply_to_text = buildReplyPreviewText(chatReplyTarget);
     }
     const { data, error } = await db.from('chat_messages')
         .insert([payload])
         .select()
         .single();
     if (error) {
         console.error("Ошибка при отправке сообщения:", error);
         alert("Не удалось отправить сообщение.");
         return;
     }
     clearChatReplyTarget();
     if (data) {
         chatMessages.push(data);
         if (chatMessages.length > 150) chatMessages.shift();
         renderChatMessages();
     }
 };
 const sendMessage = async () => {
     const text = chatInput.value.trim();
     if (!text) return;
     chatInput.value = "";
     chatInput.focus();
     await sendChatMessage(text);
 };
 stickerBtn.onclick = () => {
     if (!currentUser) return;
     showStickerPicker((stickerUrl) => sendChatMessage(STICKER_PREFIX + stickerUrl));
 };
 sendBtn.onclick = sendMessage;
 chatInput.onkeydown = (e) => {
     if (e.key === "Enter") {
         e.preventDefault();
         sendMessage();
     }
 };
 inputRow.appendChild(chatInput);
 inputRow.appendChild(stickerBtn);
 inputRow.appendChild(sendBtn);
 app.appendChild(inputRow);
 await loadChatMessages();
 renderChatMessages();
 if (chatPollInterval) clearInterval(chatPollInterval);
 chatPollInterval = setInterval(async () => {
     if (!isChatScreenOpen) return;
     await loadChatMessages();
     renderChatMessages();
 }, 4000);
 let nav = document.createElement("div");
 nav.className = "navigation";
 let homeBtn = document.createElement("button");
 homeBtn.textContent = "🏠 Домой";
 homeBtn.onclick = () => {
     isChatScreenOpen = false;
     clearChatReplyTarget();
     if (chatPollInterval) {
         clearInterval(chatPollInterval);
         chatPollInterval = null;
     }
     showHome();
 };
 nav.appendChild(homeBtn);
 let container = document.querySelector(".container");
 if (container) {
     container.insertBefore(nav, container.firstChild);
 } else {
     document.body.insertBefore(nav, app);
 }
 chatInput.focus();
}
// =======================================================
// ДОБАВЛЕНИЕ/РЕДАКТИРОВАНИЕ/УДАЛЕНИЕ ТАЙТЛОВ
// =======================================================
function showAddEditModal(existingItem = null) {
const overlay = document.createElement("div");
overlay.className = "modal-overlay";
overlay.id = "addEditModal";
const categories = Object.keys(dbData).filter(cat => {
     return !cat.includes("Секрет") && !cat.includes("🔒") && !cat.includes("❤️");
 });
 overlay.innerHTML = `
     <div class="modal-content">
         <h3>${existingItem ? "Редактировать" : "Добавить фильм/серию"}</h3>
         <form class="modal-form" id="modalForm">
             <label>Название</label>
             <input type="text" id="mTitle" required placeholder="Например: Крик 7">
             <label>Год выпуска</label>
             <input type="number" id="mYear" required placeholder="Например: 2026" value="2026">
             <label>Категория</label>
             <select id="mCategory" required>
                 ${categories.map(cat => `<option value="${cat}">${cat}</option>`).join("")}
             </select>
             <label>Жанр (Выберите или напишите свой)</label>
             <input type="text" id="mGenre" required placeholder="Например: Ужасы" list="genresList">
             <datalist id="genresList">
             </datalist>
             <label>Франшиза (Если это часть серии, необязательно)</label>
             <input type="text" id="mFranchise" placeholder="Например: Крик" list="franchisesList">
             <datalist id="franchisesList">
                 </datalist>
             <div class="modal-buttons">
                 <button type="submit" class="btn-save">Сохранить</button>
                 <button type="button" class="btn-cancel" id="mCancel">Отмена</button>
             </div>
         </form>
     </div>
 `;
 document.body.appendChild(overlay);
 const mCategory = document.getElementById("mCategory");
 const mGenre = document.getElementById("mGenre");
 const mFranchise = document.getElementById("mFranchise");
 const franchisesList = document.getElementById("franchisesList");
 const genresList = document.getElementById("genresList");
 function updateGenresDatalist() {
     const selectedCategory = mCategory.value;
     const localGenres = new Set();
     const categoryData = dbData[selectedCategory];
     if (categoryData && typeof categoryData === "object" && !Array.isArray(categoryData)) {
         for (let genreKey in categoryData) {
             localGenres.add(genreKey);
         }
     }
     genresList.innerHTML = Array.from(localGenres)
         .sort()
         .map(g => `<option value="${g}">`)
         .join("");
 }
 function updateFranchisesDatalist() {
     const selectedCategory = mCategory.value;
     const selectedGenre = mGenre.value.trim();
     const localFranchises = new Set();
     if (dbData[selectedCategory] && dbData[selectedCategory][selectedGenre]) {
         const listOrObj = dbData[selectedCategory][selectedGenre];
         if (Array.isArray(listOrObj)) {
             listOrObj.forEach(item => {
                 if (typeof item === 'object' && item !== null) {
                     Object.keys(item).forEach(franchiseName => {
                         localFranchises.add(franchiseName);
                     });
                 }
             });
         }
     }
     franchisesList.innerHTML = Array.from(localFranchises)
         .sort()
         .map(f => `<option value="${f}">`)
         .join("");
 }
 mCategory.addEventListener("change", () => {
     updateGenresDatalist();
     mGenre.value = "";
     updateFranchisesDatalist();
 });
 mGenre.addEventListener("input", updateFranchisesDatalist);
 if (existingItem) {
     document.getElementById("mTitle").value = existingItem.title;
     document.getElementById("mYear").value = existingItem.year;
     mCategory.value = existingItem.category;
     mGenre.value = existingItem.genre;
     mFranchise.value = existingItem.franchise || "";
 }
 updateGenresDatalist();
 updateFranchisesDatalist();
 document.getElementById("mCancel").onclick = () => overlay.remove();
 document.getElementById("modalForm").onsubmit = async (e) => {
     e.preventDefault();
     const titleVal = document.getElementById("mTitle").value.trim();
     const yearVal = parseInt(document.getElementById("mYear").value, 10);
     const catVal = mCategory.value;
     const genreVal = mGenre.value.trim();
     let franchiseVal = mFranchise.value.trim();
     if (franchiseVal === "") franchiseVal = null;
     let result;
     if (existingItem) {
         result = await db
             .from("titles")
             .update({ title: titleVal, year: yearVal, category: catVal, genre: genreVal, franchise: franchiseVal })
             .eq("id", existingItem.id);
     } else {
         result = await db
             .from("titles")
             .insert([{ title: titleVal, year: yearVal, category: catVal, genre: genreVal, franchise: franchiseVal }]);
     }
     if (result.error) {
         alert("Ошибка сохранения: " + result.error.message);
     } else {
         overlay.remove();
         await refreshCurrentScreen();
     }
 };
}
async function handleEditClick(itemText) {
const match = itemText.match(/^(.*?)\s\((\d{4})\)$/);
if (!match) return;
const cleanTitle = match[1].trim();
const year = parseInt(match[2], 10);
const { data, error } = await db
    .from("titles")
    .select("*")
    .eq("title", cleanTitle)
    .eq("year", year)
    .limit(1)
    .single();
if (error || !data) {
    alert("Не удалось найти этот элемент в базе данных.");
    return;
}
showAddEditModal(data);
}
async function handleDeleteClick(itemText) {
const match = itemText.match(/^(.*?)\s\((\d{4})\)$/);
if (!match) return;
const cleanTitle = match[1].trim();
 const year = parseInt(match[2], 10);
 if (confirm(`Вы уверены, что хотите навсегда удалить "${cleanTitle}"?`)) {
     const { error: watchedError } = await db
         .from("watched_items")
         .delete()
         .eq("title", itemText);
     if (watchedError) {
         console.error("Не удалось удалить из просмотренных:", watchedError.message);
     }
     const { error: wishlistError } = await db
         .from("wishlist_items")
         .delete()
         .eq("title", itemText);
     if (wishlistError) {
         console.error("Не удалось удалить из списка 'Будем смотреть':", wishlistError.message);
     }
     const { error } = await db
         .from("titles")
         .delete()
         .eq("title", cleanTitle)
         .eq("year", year);
     if (error) {
         alert("Ошибка при удалении: " + error.message);
     } else {
         await refreshCurrentScreen();
     }
 }
}
// =======================================================
// ТРЯСКА ТЕЛЕФОНА (SHAKE DETECTION)
// =======================================================
const SHAKE_THRESHOLD = 15;
const SHAKE_TIMEOUT = 2500;
let lastX = null, lastY = null, lastZ = null;
let lastShakeTime = 0;
let isShakeModalOpen = false;
let shakeDetectionStarted = false;
function getAllTitlesFromCategory(dataBranch) {
let resultList = [];
if (Array.isArray(dataBranch)) {
     dataBranch.forEach(item => {
         if (typeof item === 'string') {
             resultList.push(item);
         } else if (typeof item === 'object' && item !== null) {
             for (let key in item) {
                 if (Array.isArray(item[key])) {
                     resultList = resultList.concat(item[key]);
                 }
             }
         }
     });
 } else if (typeof dataBranch === 'object' && dataBranch !== null) {
     for (let key in dataBranch) {
         resultList = resultList.concat(getAllTitlesFromCategory(dataBranch[key]));
     }
 }
 return resultList;
}
function vibrate(pattern) {
if (navigator.vibrate) {
try { navigator.vibrate(pattern); } catch (e) { }
}
}
function runSlotAnimation(el, pool, finalText, isSecretDisplay, onDone) {
const displayOf = (t) => isSecretDisplay ? t.replace(/\s*(\d{4})$/, "") : t;
el.classList.add("slot-spin");
const totalSteps = 16;
 let step = 0;
 function tick() {
     if (step >= totalSteps) {
         el.classList.remove("slot-spin");
         el.textContent = displayOf(finalText);
         vibrate([40, 30, 60]);
         if (onDone) onDone();
         return;
     }
     const randomPick = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : finalText;
     el.textContent = displayOf(randomPick);
     step++;
     const delay = 45 + step * step * 2;
     setTimeout(tick, delay);
 }
 tick();
}
function showRandomTitleModal(titleText, pool = []) {
if (isShakeModalOpen) return;
isShakeModalOpen = true;
const overlay = document.createElement("div");
 overlay.className = "modal-overlay";
 overlay.id = "shakeRandomModal";
 overlay.style.zIndex = "10000";
 overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); isShakeModalOpen = false; } };
 const isSecret = titleText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || titleText.includes("Бакс Ориджинал") || (currentCategoryName && (currentCategoryName.includes("Секрет") || currentCategoryName.includes("🔒")));
 overlay.innerHTML = `
     <div class="modal-content" style="text-align: center; border: 3px solid #ff4081;">
         <div style="font-size: 40px;">🎰</div>
         <h2 id="shakeRandomTitle" style="margin: 15px 0;"></h2>
         ${!isSecret ? `
         <div id="shakePosterBox" style="margin: 0 0 15px; display: none; justify-content: center;"></div>
         <div style="display: flex; gap: 10px; margin-bottom: 10px;">
             <button id="posterShakeBtn" class="btn-pink-style" style="flex:1;">🖼 Постер</button>
             <button id="trailerShakeBtn" class="btn-pink-style" style="flex:1;">🎬 Трейлер</button>
         </div>
         ` : ``}
         <div style="display: flex; flex-direction: column; gap: 10px;">
             <button id="closeShakeBtn" class="btn-save">Супер, смотрим!</button>
             <button id="rerollShakeBtn" class="btn-cancel">🔄 Другой фильм</button>
             <button id="bottomCloseShakeBtn" class="btn-cancel-gray">Закрыть</button>
         </div>
     </div>
 `;
 const titleEl = overlay.querySelector("#shakeRandomTitle");
 let currentTitle = titleText;
 document.body.appendChild(overlay);
 runSlotAnimation(titleEl, pool, titleText, isSecret);
 const closeModal = () => { overlay.remove(); isShakeModalOpen = false; };
 document.getElementById("closeShakeBtn").onclick = closeModal;
 document.getElementById("bottomCloseShakeBtn").onclick = closeModal;
 document.getElementById("rerollShakeBtn").onclick = () => {
     const all = pool.length > 0 ? pool : getAllTitlesFromCategory(history[history.length - 1]);
     const next = all[Math.floor(Math.random() * all.length)];
     vibrate(30);
     currentTitle = next;
     const posterBox = overlay.querySelector("#shakePosterBox");
     if (posterBox) { posterBox.style.display = "none"; posterBox.innerHTML = ""; }
     runSlotAnimation(titleEl, all, next, isSecret);
 };
 if (!isSecret) {
     const posterBtn = document.getElementById("posterShakeBtn");
     const trailerBtn = document.getElementById("trailerShakeBtn");
     const posterBox = document.getElementById("shakePosterBox");
     posterBtn.onclick = async () => {
         if (posterBox.style.display === "flex") {
             posterBox.style.display = "none";
             return;
         }
         posterBox.style.display = "flex";
         posterBox.innerHTML = `<p style="color: #999; font-size: 13px;">Ищем постер...</p>`;
         const url = await fetchTmdbPoster(currentTitle);
         if (!overlay.isConnected) return;
         if (url) {
             posterBox.innerHTML = `<img src="${url}" alt="Постер" style="max-width: 160px; border-radius: 12px; box-shadow: 0 6px 18px rgba(180,80,120,0.25);">`;
         } else {
             posterBox.innerHTML = `<p style="color: #999; font-size: 13px;">Постер к фильму не найден</p>`;
         }
     };
     trailerBtn.onclick = () => {
         const query = encodeURIComponent(currentTitle + " трейлер");
         window.open(`https://www.youtube.com/results?search_query=${query}`, "_blank");
     };
 }
}
function onPhoneShake() {
if (currentCategoryName && (currentCategoryName.includes("Секрет") || currentCategoryName.includes("🔒"))) {
return;
}
const now = Date.now();
if (now - lastShakeTime < 2000 || isShakeModalOpen) return;
const currentDataBranch = history[history.length - 1];
if (!currentDataBranch) return;
const allTitles = getAllTitlesFromCategory(currentDataBranch);
if (allTitles.length === 0) return;
lastShakeTime = now;
const randomTitle = allTitles[Math.floor(Math.random() * allTitles.length)];
showRandomTitleModal(randomTitle, allTitles);
isShakeModalOpen = true; 
}
function handleMotion(event) {
const acceleration = event.accelerationIncludingGravity;
if (!acceleration) return;
let x = acceleration.x;
 let y = acceleration.y;
 let z = acceleration.z;
 if (lastX === null) {
     lastX = x; lastY = y; lastZ = z;
     return;
 }
 let deltaX = Math.abs(lastX - x);
 let deltaY = Math.abs(lastY - y);
 let deltaZ = Math.abs(lastZ - z);
 if ((deltaX > SHAKE_THRESHOLD && deltaY > SHAKE_THRESHOLD) || 
     (deltaX > SHAKE_THRESHOLD && deltaZ > SHAKE_THRESHOLD) || 
     (deltaY > SHAKE_THRESHOLD && deltaZ > SHAKE_THRESHOLD)) {
     onPhoneShake();
 }
 lastX = x; lastY = y; lastZ = z;
}
function startShakeDetection() {
if (shakeDetectionStarted) return;
shakeDetectionStarted = true;
if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission()
        .then(permissionState => {
            if (permissionState === 'granted') {
                window.addEventListener('devicemotion', handleMotion);
                console.log("Детектор тряски успешно запущен (iOS)");
            }
        })
        .catch(console.error);
} else {
    window.addEventListener('devicemotion', handleMotion);
    console.log("Детектор тряски успешно запущен (Android)");
}
}
function setupMusicAutoplay() {
const audio = document.getElementById("bgMusic");
const playHandler = () => {
    if (isMusicPlaying) {
        audio.play().catch(e => console.log("Музыка не смогла запуститься"));
        document.removeEventListener("click", playHandler); 
    }
};
document.addEventListener("click", playHandler);
}
function initHeartsBackground() {
if (document.querySelector('.hearts-background')) return;
const container = document.createElement('div');
 container.className = 'hearts-background';
 document.body.appendChild(container);
 function spawnHeart() {
     const heart = document.createElement('div');
     heart.className = 'floating-heart';
     heart.innerHTML = '❤️';
     const size = Math.random() * 18 + 12;
     const startLeft = Math.random() * 100;
     const duration = Math.random() * 12 + 10;
     const swayX = (Math.random() * 120 - 60) + 'px';
     const rotateDeg = (Math.random() * 360) + 'deg';
     heart.style.fontSize = `${size}px`;
     heart.style.left = `${startLeft}%`;
     heart.style.animationDuration = `${duration}s`;
     heart.style.setProperty('--sway-x', swayX);
     heart.style.setProperty('--rotate-deg', rotateDeg);
     container.appendChild(heart);
     setTimeout(() => {
         heart.remove();
     }, duration * 1000);
 }
 spawnHeart();
 setInterval(spawnHeart, 900);
}
initHeartsBackground();
setupMusicAutoplay();
const style = document.createElement('style');
style.textContent = `
.round-btn {
overflow: hidden;
width: 40px !important;
height: 40px !important;
padding: 0 !important;
margin: 0 !important;
border-radius: 50% !important;
display: flex !important;
justify-content: center !important;
align-items: center !important;
cursor: pointer !important;
border: 1px solid #ccc !important;
background: #f9f9f9 !important;
font-size: 18px !important;
box-sizing: border-box !important;
line-height: 1 !important;
}
.hearts-background {
position: fixed;
top: 0;
left: 0;
width: 100vw;
height: 100vh;
pointer-events: none;
z-index: -1;
overflow: hidden;
}
.floating-heart {
     position: absolute;
     bottom: -50px;
     color: #ff4081;
     opacity: 0;
     pointer-events: none;
     user-select: none;
     animation: floatUp linear forwards;
 }
 @keyframes floatUp {
     0% {
         transform: translateY(0) translateX(0) rotate(0deg);
         opacity: 0;
     }
     10% {
         opacity: 0.15;
     }
     90% {
         opacity: 0.15;
     }
     100% {
         transform: translateY(-115vh) translateX(var(--sway-x)) rotate(var(--rotate-deg));
         opacity: 0;
     }
 }
 .btn-watch.wishlist-active {
     color: #2196f3 !important;
     opacity: 1 !important;
 }
 /* Звёздочка партнёра — фиолетовая */
 .btn-watch.watched-partner {
     color: #9c27b0 !important;
     opacity: 1 !important;
 }
 .btn-pink-style {
     background-color: #ffe3ec !important;
     color: #d81b60 !important;
     border: none !important;
     font-weight: 600 !important;
     transition: background-color 0.2s ease, transform 0.1s ease;
 }
 .btn-pink-style:hover {
     background-color: #ffd5e3 !important;
 }
 .btn-cancel-gray {
     background-color: #f0f0f0 !important;
     color: #333333 !important;
     border: none !important;
     font-weight: 600 !important;
     transition: background-color 0.2s ease;
 }
 .btn-cancel-gray:hover {
     background-color: #e5e5e5 !important;
 }
`;
document.head.appendChild(style);
