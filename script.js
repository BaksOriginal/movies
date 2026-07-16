let dbData = {}; // Сюда мы динамически соберем структуру категорий и жанров из базы данных
let isTransitioning = false; // Флаг: идет ли сейчас перерисовка экрана
let isMusicPlaying = localStorage.getItem("musicEnabled") === "true";

// Включаем временную блокировку кликов на 350мс
function startTransitionLock() {
    isTransitioning = true;
    setTimeout(() => {
        isTransitioning = false;
    }, 350); 
}

// Перехватываем ВСЕ клики на сайте на стадии погружения
document.addEventListener('click', (e) => {
    if (isTransitioning) {
        e.preventDefault();
        e.stopPropagation();
    }
}, true); // true обязателен — это заставит событие обрабатываться в первую очередь

// Функция для загрузки тайтлов из Supabase и сборки структуры
async function loadCatalogFromDB() {
    const { data: titles, error } = await db
        .from('titles')
        .select('*')
        .order('id', { ascending: true });

    if (error) {
        console.error("Ошибка при загрузке каталога из БД:", error);
        return;
    }

    // Собираем плоский список из базы обратно в древовидную структуру для сайта
    const tempStructure = {};

    titles.forEach(item => {
        const cat = item.category;
        const gen = item.genre;
        const fran = item.franchise;
        const titleWithYear = `${item.title} (${item.year})`;

        if (!tempStructure[cat]) tempStructure[cat] = {};
        if (!tempStructure[cat][gen]) tempStructure[cat][gen] = [];

        if (fran) {
            // Ищем, есть ли уже такая франшиза внутри жанра
            let franchiseObj = tempStructure[cat][gen].find(
                i => typeof i === 'object' && i !== null && i[fran]
            );

            if (!franchiseObj) {
                franchiseObj = { [fran]: [] };
                tempStructure[cat][gen].push(franchiseObj);
            }
            franchiseObj[fran].push(titleWithYear);
        } else {
            // Обычный фильм без франшизы
            tempStructure[cat][gen].push(titleWithYear);
        }
    });

    dbData = tempStructure;
}

// ==========================================
// НАСТРОЙКА SUPABASE
// ==========================================
const SUPABASE_URL = "https://nwkgofmgluduldgsmwfa.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Igpb__d5aHp3DBbQH1NgOA_W8_Ku6aE";

// Инициализируем клиент под именем db
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = document.getElementById("app");
let currentUser = null;
let watchedTitles = new Set(); // Общий список просмотренного у обоих пользователей
let wishlistTitles = new Set(); // Общий список вишлиста "Будем смотреть"
let allRatings = []; // Все оценки из базы данных [{title, user_email, rating, user_id}]
let history = [];
let realtimeChannel = null; // Канал для мгновенных обновлений

// Переменная, хранящая название текущей открытой категории первого уровня ("🎥 Фильмы" и т.д.)
let currentCategoryName = null; 

// Глобальные переменные для фильтров поиска
let filterGenre = "";
let filterCategory = "";
let filterYear = "";
let filterHasRating = "all"; // 'all', 'yes', 'no'
let filterMinRating = "";

// ==========================================
// РЕЗЕРВНОЕ КОПИРОВАНИЕ СЕССИИ (COOKIE BACKUP)
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
        const matches = document.cookie.match(new RegExp("(?:^|; )" + "sb_session_backup".replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + "=([^;]*)"));
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

// Флаг, который покажет, загрузилось ли приложение в первый раз
let isAppInitialized = false;

// Слушатель событий авторизации
db.auth.onAuthStateChange(async (event, session) => {
    if (session) {
        currentUser = session.user;
        saveSessionBackup(session); // Бэкапим сессию
        
        // Загружаем списки просмотренного, вишлиста и оценок параллельно
        Promise.all([loadWatchedFromDB(), loadWishlistFromDB(), loadRatingsFromDB()]).then(() => {
            subscribeToChanges(); 
            
            if (!isAppInitialized) {
                isAppInitialized = true;
                showHome();
            } else {
                refreshCurrentScreen();
            }
        });
    } else {
        // Пробуем восстановить из бэкапа перед тем как выкинуть
        const restored = await tryRestoreSession();
        if (restored) return;

        currentUser = null;
        watchedTitles.clear();
        wishlistTitles.clear();
        allRatings = [];
        isAppInitialized = false;
        saveSessionBackup(null);
        
        if (realtimeChannel) {
            db.removeChannel(realtimeChannel);
            realtimeChannel = null;
        }
        showLoginScreen();
    }
});

// Загрузка просмотренных тайтлов
async function loadWatchedFromDB() {
    if (!currentUser) return;
    const { data, error } = await db.from('watched_items').select('title');
    if (error) {
        console.error("Ошибка при загрузке списка просмотренного:", error);
        return;
    }
    watchedTitles = new Set(data.map(item => item.title));
}

// Загрузка вишлиста
async function loadWishlistFromDB() {
    if (!currentUser) return;
    const { data, error } = await db.from('wishlist_items').select('title');
    if (error) {
        console.error("Ошибка при загрузке вишлиста:", error);
        return;
    }
    wishlistTitles = new Set(data.map(item => item.title));
}

// Загрузка оценок
async function loadRatingsFromDB() {
    if (!currentUser) return;
    const { data, error } = await db.from('ratings').select('title, user_email, rating, user_id');
    if (error) {
        console.error("Ошибка при загрузке оценок:", error);
        return;
    }
    allRatings = data || [];
}

// Подписка на изменения базы данных в реальном времени (Websockets)
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
        .subscribe();
}

// Живое обновление интерфейса
async function updateUIOnLiveChange() {
    await loadCatalogFromDB();
    await Promise.all([loadWatchedFromDB(), loadWishlistFromDB(), loadRatingsFromDB()]);

    // Обновляем счетчики на кнопках главного экрана
    let buttons = document.querySelectorAll("button");
    buttons.forEach(btn => {
        if (btn.textContent.includes("Просмотрено")) {
            btn.textContent = "🎬 Просмотрено (" + watchedTitles.size + ")";
        }
        if (btn.textContent.includes("Будем смотреть")) {
            btn.textContent = "🍿 Будем смотреть (" + wishlistTitles.size + ")";
        }
    });

    // Полностью перерисовываем текущий список элементов, чтобы обновить оценки под ними
    const itemContainers = document.querySelectorAll(".item-row, .item-ratings-info");
    if (itemContainers.length > 0 && history.length > 0) {
        let currentActiveData = history[history.length - 1];
        openData(currentActiveData, false);
    }
}

// Мягкое обновление текущего экрана
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
// ЛОГИКА КЛИКА ПО ЗВЕЗДОЧКЕ (ОБНОВЛЕННАЯ С ОЦЕНКОЙ)
// =======================================================
async function handleStarClick(title) {
    if (!currentUser) return;

    // Если фильм уже в одной из категорий — повторный клик предлагает УБРАТЬ оценку через модалку
    if (watchedTitles.has(title) || wishlistTitles.has(title)) {
        showRemoveRatingModal(title);
        return;
    }

    // Если фильм чистый — открываем красивое быстрое меню добавления
    showStarChoiceModal(title);
}

// Модальное окно для СНЯТИЯ / УДАЛЕНИЯ оценки
function showRemoveRatingModal(title) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "removeRatingModal";

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 10px;">Удалить из списков?</h3>
            <p style="color: #666; margin-bottom: 20px; font-size: 14px;">"${title.replace(/\s*\(\d{4}\)$/, "")}"</p>
            <div class="action-buttons" style="display: flex; flex-direction: column; gap: 10px;">
                <button id="confirmRemove" class="btn-pink-style" style="background-color: #ffebee !important; color: #c62828 !important; border: 1px solid #ffcdd2 !important; padding: 12px; border-radius: 8px; font-weight: bold; cursor: pointer;">❌ Убрать оценку</button>
                <button id="cancelRemove" class="btn-cancel-gray" style="background-color: #f5f5f5; border: 1px solid #ccc; padding: 12px; border-radius: 8px; cursor: pointer;">Оставить в списке</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById("confirmRemove").onclick = async () => {
        overlay.remove();
        
        // Локально вычищаем из списков на клиенте для мгновенного отклика UI
        watchedTitles.delete(title);
        wishlistTitles.delete(title);
        if (userRatings[title]) {
            delete userRatings[title];
        }
        updateUIOnLiveChange();

        // Удаляем из базы данных Supabase
        await db.from('watched_items').delete().eq('title', title).eq('user_id', currentUser.id);
        await db.from('wishlist_items').delete().eq('title', title).eq('user_id', currentUser.id);
    };

    document.getElementById("cancelRemove").onclick = () => {
        overlay.remove();
    };
}

// Модальное окно выбора категории для звёздочки (с добавлением Оценки)
function showStarChoiceModal(title) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "starChoiceModal";

    const isWatched = watchedTitles.has(title);
    const isWishlist = wishlistTitles.has(title);
    const myRatingObj = allRatings.find(r => r.title === title && r.user_id === currentUser.id);

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 10px;">Действие с тайтлом</h3>
            <p style="color: #666; margin-bottom: 20px; font-size: 14px;">"${title.replace(/\s*\(\d{4}\)$/, "")}"</p>
            <div class="action-buttons" style="display: flex; flex-direction: column; gap: 10px;">
                <button id="choiceWish" class="btn-pink-style">${isWishlist ? "❌ Убрать из Будем смотреть" : "🍿 Будем смотреть"}</button>
                <button id="choiceWatch" class="btn-pink-style">${isWatched ? "❌ Убрать из Просмотрено" : "🎬 Просмотрено"}</button>
                <button id="choiceRate" class="btn-pink-style" style="background-color: #ffd5e3 !important;">⭐ ${myRatingObj ? `Переоценить (сейчас: ${myRatingObj.rating})` : "Оценить фильм"}</button>
                ${myRatingObj ? '<button id="choiceDeleteRate" class="btn-action-delete">❌ Удалить мою оценку</button>' : ''}
                <button id="choiceCancel" class="btn-cancel-gray">Отмена</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById("choiceWish").onclick = async () => {
        overlay.remove();
        if (isWishlist) {
            wishlistTitles.delete(title);
            updateUIOnLiveChange();
            await db.from('wishlist_items').delete().eq('title', title).eq('user_id', currentUser.id);
        } else {
            wishlistTitles.add(title);
            // Если добавляем в вишлист, убираем из просмотренного
            if (watchedTitles.has(title)) {
                watchedTitles.delete(title);
                await db.from('watched_items').delete().eq('title', title).eq('user_id', currentUser.id);
            }
            updateUIOnLiveChange();
            await db.from('wishlist_items').insert([{ user_id: currentUser.id, title: title }]);
        }
    };

    document.getElementById("choiceWatch").onclick = async () => {
        overlay.remove();
        if (isWatched) {
            watchedTitles.delete(title);
            updateUIOnLiveChange();
            await db.from('watched_items').delete().eq('title', title).eq('user_id', currentUser.id);
        } else {
            watchedTitles.add(title);
            // Если добавляем в просмотренное, убираем из вишлиста
            if (wishlistTitles.has(title)) {
                wishlistTitles.delete(title);
                await db.from('wishlist_items').delete().eq('title', title).eq('user_id', currentUser.id);
            }
            updateUIOnLiveChange();
            await db.from('watched_items').insert([{ user_id: currentUser.id, title: title }]);
        }
    };

    document.getElementById("choiceRate").onclick = () => {
        overlay.remove();
        showRatingInputModal(title, myRatingObj ? myRatingObj.rating : 0);
    };

    if (myRatingObj) {
        document.getElementById("choiceDeleteRate").onclick = async () => {
            overlay.remove();
            await db.from('ratings').delete().eq('title', title).eq('user_id', currentUser.id);
            updateUIOnLiveChange();
        };
    }

    document.getElementById("choiceCancel").onclick = () => {
        overlay.remove();
    };
}

// Модалка ввода оценки (1-10 звезд)
function showRatingInputModal(title, currentRating) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "ratingInputModal";

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3>Оцените фильм</h3>
            <p style="color: #666; font-size: 14px;">"${title.replace(/\s*\(\d{4}\)$/, "")}"</p>
            
            <div class="rating-stars-input" id="starsContainer">
                ${Array.from({ length: 10 }, (_, i) => `
                    <span class="rating-star ${i < currentRating ? 'active' : ''}" data-value="${i + 1}">★</span>
                `).join("")}
            </div>
            <div style="font-weight: bold; margin-bottom: 20px; font-size: 18px;" id="ratingValue">${currentRating || 0} / 10</div>

            <div class="modal-buttons">
                <button id="saveRating" class="btn-save">Сохранить</button>
                <button id="cancelRating" class="btn-cancel">Отмена</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    let selectedRating = currentRating;
    const stars = overlay.querySelectorAll(".rating-star");
    const valueDisplay = overlay.querySelector("#ratingValue");

    stars.forEach(star => {
        star.onclick = () => {
            selectedRating = parseInt(star.getAttribute("data-value"), 10);
            valueDisplay.textContent = `${selectedRating} / 10`;
            stars.forEach((s, idx) => {
                if (idx < selectedRating) {
                    s.classList.add("active");
                } else {
                    s.classList.remove("active");
                }
            });
        };
    });

    document.getElementById("cancelRating").onclick = () => overlay.remove();

    document.getElementById("saveRating").onclick = async () => {
        if (selectedRating === 0) {
            alert("Пожалуйста, выберите оценку!");
            return;
        }
        overlay.remove();

        // Проверяем, был ли уже оценен фильм, чтобы сделать upsert
        const { error } = await db.from('ratings').upsert({
            user_id: currentUser.id,
            user_email: currentUser.email,
            title: title,
            rating: selectedRating
        }, { onConflict: 'user_id,title' });

        if (error) {
            console.error("Ошибка сохранения оценки:", error);
            alert("Не удалось сохранить оценку.");
        } else {
            updateUIOnLiveChange();
        }
    };
}

// Экран авторизации
function showLoginScreen() {
    app.innerHTML = `
        <h1>Авторизация</h1>
        <form class="login-form" id="loginForm">
            <input type="text" id="loginUsername" placeholder="Имя" required autocomplete="username">
            <input type="password" id="loginPassword" placeholder="Пароль" required autocomplete="current-password">
            <button type="submit">Войти</button>
        </form>
    `;

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
// ЛОГИКА ПОИСКА (ЛЕВЕНШТЕЙН / НЕЧЕТКИЙ ПОИСК С ФИЛЬТРАМИ)
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

function performCatalogSearch(query) {
    currentCategoryName = "🔍 Результаты поиска";
    
    let results = [];
    const q = query.toLowerCase().trim();

    // Обходим дерево категорий и жанров из dbData
    for (let cat in dbData) {
        for (let gen in dbData[cat]) {
            dbData[cat][gen].forEach(movie => {
                // 1. Фильтр по поисковому тексту (название или жанр)
                const matchesQuery = !q || 
                    movie.title.toLowerCase().includes(q) || 
                    gen.toLowerCase().includes(q);

                // 2. Фильтр по Категории
                const matchesCategory = !filterCategory || cat === filterCategory;

                // 3. Фильтр по Жанру
                const matchesGenre = !filterGenre || gen === filterGenre;

                // 4. Фильтр по Году
                const matchesYear = !filterYear || (movie.year && movie.year.toString() === filterYear);

                // Получаем оценку текущего авторизованного пользователя
                const hasUserRating = watchedTitles.has(movie.title);
                const userRatingVal = userRatings[movie.title] || 0;

                // 5. Фильтр по наличию оценки
                let matchesHasRating = true;
                if (filterHasRating === "rated") {
                    matchesHasRating = hasUserRating;
                } else if (filterHasRating === "unrated") {
                    matchesHasRating = !hasUserRating;
                }

                // 6. Фильтр по минимальной оценке
                const matchesMinRating = !filterMinRating || (hasUserRating && userRatingVal >= parseInt(filterMinRating));

                if (matchesQuery && matchesCategory && matchesGenre && matchesYear && matchesHasRating && matchesMinRating) {
                    results.push(movie);
                }
            });
        }
    }

    // Рендерим результаты. Второй параметр false предотвращает бесконечное забивание истории назад/вперед
    openData(results, false); 
}

// Главная страница
async function showHome() {
    startTransitionLock();
    history = [];
    currentCategoryName = null;
    await loadCatalogFromDB();
    
    let nav = document.querySelector(".navigation");
    if (nav) nav.remove();

    app.innerHTML = "";

    const createIconButton = (icon, onClick) => {
        let btn = document.createElement("button");
        btn.textContent = icon;
        btn.style.cssText = `
            width: 40px !important; height: 40px !important;
            min-width: 40px !important; min-height: 40px !important;
            padding: 0 !important; margin: 0 !important;
            border-radius: 50% !important; display: flex !important;
            justify-content: center !important; align-items: center !important;
            cursor: pointer !important; border: 1px solid #ccc !important;
            background: #f9f9f9 !important; font-size: 16px !important;
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

        header.innerHTML = `<span id="userEmailSpan" style="font-size: 14px;">${currentUser.email}</span>`;
        
        let controls = document.createElement("div");
        controls.style.display = "flex";
        controls.style.alignItems = "center";
        controls.style.gap = "10px";

        let musicBtn = createIconButton(isMusicPlaying ? "🔊" : "🔇", () => {
            const audio = document.getElementById("bgMusic");
            if (audio.paused) { audio.play(); isMusicPlaying = true; localStorage.setItem("musicEnabled", "true"); musicBtn.textContent = "🔊"; }
            else { audio.pause(); isMusicPlaying = false; localStorage.setItem("musicEnabled", "false"); musicBtn.textContent = "🔇"; }
        });

        let logoutBtn = createIconButton("❌", () => db.auth.signOut());

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
        addBtn.style.background = "#e3f2fd";
        addBtn.style.color = "#0d47a1";
        addBtn.style.marginBottom = "10px";
        addBtn.onclick = () => showAddEditModal();
        app.appendChild(addBtn);
        
        let hr = document.createElement("hr");
        hr.style.border = "0";
        hr.style.borderTop = "2px solid #9b4f70"; 
        hr.style.margin = "15px 0";
        app.appendChild(hr);

        // ПОИСК И ФИЛЬТРЫ
        // ПОИСК И ФИЛЬТРЫ (ШЕСТЕРЕНКА)
        // ==========================================
        // БЛОК ПОИСКА И ФИЛЬТРОВ (ШЕСТЕРЕНКА)
        // ==========================================
        let searchContainer = document.createElement("div");
        searchContainer.style.cssText = `
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
            width: 100%;
            box-sizing: border-box;
        `;

        let searchInput = document.createElement("input");
        searchInput.type = "text";
        searchInput.id = "searchInputEl"; // Индификатор для сохранения фокуса
        searchInput.placeholder = "Поиск по названию или жанру...";
        searchInput.style.cssText = `
            flex-grow: 1;
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 8px;
            font-size: 14px;
            box-sizing: border-box;
        `;

        const triggerSearch = () => {
            const q = searchInput.value;
            if (q.trim() || filterCategory || filterGenre || filterYear || filterMinRating || filterHasRating !== "all") {
                performCatalogSearch(q);
            } else {
                showHome();
            }
        };

        // Живой поиск при вводе текста без блокировки ввода!
        searchInput.oninput = triggerSearch;

        // Кнопка поиска (лупа)
        let searchSubmitBtn = document.createElement("button");
        searchSubmitBtn.textContent = "🔍";
        searchSubmitBtn.style.cssText = `
            width: 42px !important;
            height: 42px !important;
            padding: 0 !important;
            margin: 0 !important;
            border-radius: 8px !important;
            background: #e3f2fd !important;
            border: 1px solid #bbdefb !important;
            cursor: pointer;
            font-size: 16px;
            display: flex;
            justify-content: center;
            align-items: center;
            flex-shrink: 0;
            box-sizing: border-box;
        `;
        searchSubmitBtn.onclick = triggerSearch;

        // Кнопка фильтров (шестеренка), оформленная 1-в-1 как лупа
        let filterBtn = document.createElement("button");
        filterBtn.textContent = "⚙️";
        filterBtn.style.cssText = `
            width: 42px !important;
            height: 42px !important;
            padding: 0 !important;
            margin: 0 !important;
            border-radius: 8px !important;
            background: #e3f2fd !important;
            border: 1px solid #bbdefb !important;
            cursor: pointer;
            font-size: 16px;
            display: flex;
            justify-content: center;
            align-items: center;
            flex-shrink: 0;
            box-sizing: border-box;
        `;
        
        // Обработчик для шестеренки
        filterBtn.onclick = () => {
            // Если у тебя будет функция открытия панели фильтров, пропиши ее вызов здесь.
            // Сейчас просто оставим заглушку или сброс строки поиска.
            searchInput.value = "";
            showHome();
        };

        searchContainer.appendChild(searchInput);
        searchContainer.appendChild(searchSubmitBtn);
        searchContainer.appendChild(filterBtn);
        app.appendChild(searchContainer);

        // Контейнер панели фильтров (скрыт по умолчанию)
        let filterPanel = document.createElement("div");
        filterPanel.className = "filter-panel";
        filterPanel.style.display = "none";

        // Собираем данные для списков фильтрации
        const allGenres = new Set();
        const allCategories = new Set();
        const allYears = new Set();

        for (let catKey in dbData) {
            if (catKey.includes("Секрет") || catKey.includes("🔒") || catKey.includes("❤️")) continue;
            allCategories.add(catKey);
            for (let genKey in dbData[catKey]) {
                allGenres.add(genKey);
                const items = dbData[catKey][genKey];
                const processArr = (arr) => {
                    arr.forEach(i => {
                        if (typeof i === 'string') {
                            const match = i.match(/\((\d{4})\)$/);
                            if (match) allYears.add(match[1]);
                        } else if (typeof i === 'object') {
                            for (let f in i) processArr(i[f]);
                        }
                    });
                };
                if (Array.isArray(items)) processArr(items);
            }
        }

        filterPanel.innerHTML = `
            <div class="filter-row">
                <select id="fCategory">
                    <option value="">Все категории</option>
                    ${Array.from(allCategories).sort().map(c => `<option value="${c}" ${filterCategory === c ? 'selected' : ''}>${c}</option>`).join("")}
                </select>
                <select id="fGenre">
                    <option value="">Все жанры</option>
                    ${Array.from(allGenres).sort().map(g => `<option value="${g}" ${filterGenre === g ? 'selected' : ''}>${g}</option>`).join("")}
                </select>
            </div>
            <div class="filter-row">
                <select id="fYear">
                    <option value="">Все года</option>
                    ${Array.from(allYears).sort((a,b) => b-a).map(y => `<option value="${y}" ${filterYear === y ? 'selected' : ''}>${y}</option>`).join("")}
                </select>
                <select id="fHasRating">
                    <option value="all" ${filterHasRating === 'all' ? 'selected' : ''}>Оценка: Любая</option>
                    <option value="yes" ${filterHasRating === 'yes' ? 'selected' : ''}>Есть оценка</option>
                    <option value="no" ${filterHasRating === 'no' ? 'selected' : ''}>Без оценки</option>
                </select>
                <select id="fMinRating">
                    <option value="">Балл: Любой</option>
                    ${Array.from({length: 10}, (_, i) => `<option value="${i+1}" ${filterMinRating == (i+1) ? 'selected' : ''}>От ${i+1} ★</option>`).join("")}
                </select>
            </div>
            <div style="display: flex; gap: 10px; margin-top: 5px;">
                <button id="fReset" class="btn-cancel-gray" style="flex: 1; min-height: 35px; padding: 5px; font-size: 13px; border-radius: 8px;">Сбросить фильтры</button>
            </div>
        `;

        app.appendChild(filterPanel);

        // Логика открытия/закрытия фильтров
        filterBtn.onclick = () => {
            filterPanel.style.display = filterPanel.style.display === "none" ? "flex" : "none";
        };

        // Слушатели изменений фильтров
        filterPanel.querySelector("#fCategory").onchange = (e) => {
            filterCategory = e.target.value;
            triggerSearch();
        };
        filterPanel.querySelector("#fGenre").onchange = (e) => {
            filterGenre = e.target.value;
            triggerSearch();
        };
        filterPanel.querySelector("#fYear").onchange = (e) => {
            filterYear = e.target.value;
            triggerSearch();
        };
        filterPanel.querySelector("#fHasRating").onchange = (e) => {
            filterHasRating = e.target.value;
            triggerSearch();
        };
        filterPanel.querySelector("#fMinRating").onchange = (e) => {
            filterMinRating = e.target.value;
            triggerSearch();
        };
        filterPanel.querySelector("#fReset").onclick = () => {
            filterCategory = "";
            filterGenre = "";
            filterYear = "";
            filterHasRating = "all";
            filterMinRating = "";
            filterPanel.querySelector("#fCategory").value = "";
            filterPanel.querySelector("#fGenre").value = "";
            filterPanel.querySelector("#fYear").value = "";
            filterPanel.querySelector("#fHasRating").value = "all";
            filterPanel.querySelector("#fMinRating").value = "";
            searchInput.value = "";
            triggerSearch();
        };

        let hrAfterSearch = document.createElement("hr");
        hrAfterSearch.style.border = "0";
        hrAfterSearch.style.borderTop = "2px solid #9b4f70"; 
        hrAfterSearch.style.margin = "15px 0 20px 0";
        app.appendChild(hrAfterSearch);
    }

    // Рендерим кнопки категорий
    for (let key in dbData) {
        let button = document.createElement("button");
        button.textContent = key;
        button.onclick = () => { currentCategoryName = key; openData(dbData[key], true); };
        app.appendChild(button);

        if (key.includes("Секрет") || key.includes("🔒") || key.includes("❤️")) {
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

    let watchedBtn = document.createElement("button");
    watchedBtn.className = "btn-pink-style";
    watchedBtn.textContent = "🎬 Просмотрено (" + watchedTitles.size + ")";
    watchedBtn.onclick = () => {
        const list = Array.from(watchedTitles);
        currentCategoryName = "🎬 Просмотрено";
        openData(list, true, "🎬 Просмотрено");
    };
    app.appendChild(watchedBtn);

    let footer = document.createElement("p");
    footer.style.textAlign = "center";
    footer.style.marginTop = "40px";
    footer.style.fontSize = "10px";
    footer.style.color = "#999";
    footer.innerHTML = 'Музыка: "Echoes Of Home" by Scott Buckley (www.scottbuckley.com.au) — Licensed under CC-BY 4.0';
    app.appendChild(footer);
}

// Отрисовка строки элемента (тайтла) и блока оценок под ним
function renderItemRow(itemText, container) {
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
        itemDiv.textContent = itemText;
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
        
        if (watchedTitles.has(itemText)) {
            watchBtn.classList.add("watched");
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

    container.appendChild(row);

    // Добавляем инфо об оценках ПОД строкой фильма (если не секретный)
    if (!isSecret) {
        const itemRatings = allRatings.filter(r => r.title === itemText);
        if (itemRatings.length > 0) {
            let ratingsDiv = document.createElement("div");
            ratingsDiv.className = "item-ratings-info";
            
            // Средняя оценка
            const avg = (itemRatings.reduce((sum, r) => sum + r.rating, 0) / itemRatings.length).toFixed(1);
            ratingsDiv.innerHTML = `<span style="font-weight: bold; color: #ffb400;">⭐ ${avg}/10</span>`;

            // Список оценок пользователей
            itemRatings.forEach(r => {
                const shortName = r.user_email.split("@")[0]; // "myakish" или "asmoday"
                ratingsDiv.innerHTML += `
                    <span class="user-rating-badge">${shortName}: ${r.rating}</span>
                `;
            });
            container.appendChild(ratingsDiv);
        }
    }
}

// Всплывающее меню выбора действия
function showActionMenu(itemText) {
    if (itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал")) return;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "actionMenuModal";

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 10px;" id="menuTitle"></h3>
            <p style="color: #666; margin-bottom: 20px; font-size: 14px;">Выберите действие для этого тайтла:</p>
            <div class="action-buttons" style="display: flex; flex-direction: column; gap: 10px;">
                <button class="btn-pink-style" id="actTrailer">🎬 Трейлер на YouTube</button>
                <button class="btn-pink-style" id="actEdit">✏️ Редактировать</button>
                <button class="btn-pink-style" id="actDelete">❌ Удалить из базы</button>
                <button class="btn-cancel-gray" id="actCancel">Отмена</button>
            </div>
        </div>
    `;

    overlay.querySelector("#menuTitle").textContent = itemText;
    document.body.appendChild(overlay);

    // Логика кнопки трейлера
    document.getElementById("actTrailer").onclick = () => {
        overlay.remove();
        const query = encodeURIComponent(itemText + " трейлер");
        window.open(`https://www.youtube.com/results?search_query=${query}`, "_blank");
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

function openData(content, saveHistory = true, customTitle = null) {
    // Сохраняем текст, который пользователь ввёл прямо сейчас, чтобы он не стирался
    const currentSearchText = document.getElementById("searchInputEl")?.value || "";

    startTransitionLock();
    if (saveHistory) {
        history.push(content);
    }

    app.innerHTML = "";

    // Если мы находимся в режиме результатов поиска, рисуем поле поиска и фильтров сверху результатов
    if (currentCategoryName === "🔍 Результаты поиска") {
        let searchContainer = document.createElement("div");
        searchContainer.style.cssText = `
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
            width: 100%;
            box-sizing: border-box;
        `;

        let searchInput = document.createElement("input");
        searchInput.type = "text";
        searchInput.id = "searchInputEl";
        searchInput.value = currentSearchText; // Возвращаем введённый текст на место
        searchInput.placeholder = "Поиск по названию или жанру...";
        searchInput.style.cssText = `
            flex-grow: 1;
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 8px;
            font-size: 14px;
            box-sizing: border-box;
        `;

        // Умный мгновенный поиск
        const triggerSearch = () => {
            const q = searchInput.value;
            if (q.trim() || filterCategory || filterGenre || filterYear || filterMinRating || filterHasRating !== "all") {
                performCatalogSearch(q);
            } else {
                showHome();
            }
        };

        searchInput.oninput = triggerSearch;

        // Кнопка-лупа
        let searchSubmitBtn = document.createElement("button");
        searchSubmitBtn.textContent = "🔍";
        searchSubmitBtn.style.cssText = `
            width: 42px !important; height: 42px !important;
            border-radius: 8px !important; background: #e3f2fd !important;
            border: 1px solid #bbdefb !important; cursor: pointer;
            font-size: 16px; display: flex; justify-content: center; align-items: center;
            flex-shrink: 0; box-sizing: border-box;
        `;
        searchSubmitBtn.onclick = triggerSearch;

        // Кнопка-шестерёнка
        let filterBtn = document.createElement("button");
        filterBtn.textContent = "⚙️";
        filterBtn.style.cssText = `
            width: 42px !important; height: 42px !important;
            border-radius: 8px !important; background: #e3f2fd !important;
            border: 1px solid #bbdefb !important; cursor: pointer;
            font-size: 16px; display: flex; justify-content: center; align-items: center;
            flex-shrink: 0; box-sizing: border-box;
        `;
        filterBtn.onclick = () => {
            // При нажатии на шестерёнку возвращаем на главный экран и открываем панель фильтров
            showHome();
            setTimeout(() => {
                const panel = document.getElementById("filterPanelEl");
                if (panel) panel.style.display = "flex";
            }, 50);
        };

        searchContainer.appendChild(searchInput);
        searchContainer.appendChild(searchSubmitBtn);
        searchContainer.appendChild(filterBtn);
        app.appendChild(searchContainer);

        // Возвращаем фокус ввода в конец текстового поля
        setTimeout(() => {
            const inp = document.getElementById("searchInputEl");
            if (inp) {
                inp.focus();
                inp.setSelectionRange(inp.value.length, inp.value.length);
            }
        }, 10);
    }

    if (customTitle) {
        let title = document.createElement("h1");
        title.textContent = customTitle;
        app.appendChild(title);
    }

    if (currentCategoryName) {
        let categoryHeader = document.createElement("h2");
        categoryHeader.textContent = currentCategoryName;
        categoryHeader.style.color = "#9b4f70";
        categoryHeader.style.marginBottom = "15px";
        app.appendChild(categoryHeader);
    }

    let listContainer = document.createElement("div");
    listContainer.className = "catalog-list";

    if (content.length === 0) {
        let noResults = document.createElement("p");
        noResults.textContent = "Ничего не найдено 😢";
        noResults.style.color = "#888";
        noResults.style.marginTop = "20px";
        listContainer.appendChild(noResults);
    } else {
        content.forEach(item => {
            let card = createMovieCard(item);
            listContainer.appendChild(card);
        });
    }

    app.appendChild(listContainer);
}

// Навигационная панель Назад/Домой
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

// Функция открытия модалки для ДОБАВЛЕНИЯ или РЕДАКТИРОВАНИЯ
function showAddEditModal(existingItem = null) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "addEditModal";

    const categories = Object.keys(dbData).filter(cat => {
        return !cat.includes("Секрет") && !cat.includes("🔒") && !cat.includes("❤️");
    });
    
    const existingGenres = new Set();
    for (let catKey in dbData) {
        if (catKey.includes("Секрет") || catKey.includes("🔒") || catKey.includes("❤️")) continue;
        
        const categoryData = dbData[catKey];
        if (typeof categoryData === "object" && !Array.isArray(categoryData)) {
            for (let genreKey in categoryData) {
                existingGenres.add(genreKey);
            }
        }
    }

    const sortedGenres = Array.from(existingGenres).sort();
    const genreOptions = sortedGenres.map(g => `<option value="${g}">`).join("");
    
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
                    ${genreOptions}
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

    mCategory.addEventListener("change", updateFranchisesDatalist);
    mGenre.addEventListener("input", updateFranchisesDatalist);

    if (existingItem) {
        document.getElementById("mTitle").value = existingItem.title;
        document.getElementById("mYear").value = existingItem.year;
        mCategory.value = existingItem.category;
        mGenre.value = existingItem.genre;
        mFranchise.value = existingItem.franchise || "";
    }

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

// Обработка кнопки "Редактировать"
async function handleEditClick(itemText) {
    const match = itemText.match(/^(.*?)\s*\((\d{4})\)$/);
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

// Обработка кнопки "Удалить"
async function handleDeleteClick(itemText) {
    const match = itemText.match(/^(.*?)\s*\((\d{4})\)$/);
    if (!match) return;

    const cleanTitle = match[1].trim();
    const year = parseInt(match[2], 10);

    if (confirm(`Вы уверены, что хотите навсегда удалить "${cleanTitle}"?`)) {
        
        // Удаляем из просмотренных
        await db.from("watched_items").delete().eq("title", itemText);

        // Удаляем из вишлиста
        await db.from("wishlist_items").delete().eq("title", itemText);

        // Удаляем оценки
        await db.from("ratings").delete().eq("title", itemText);

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
// ЛОГИКА ТРЯСКИ ТЕЛЕФОНА (SHAKE DETECTION)
// =======================================================
const SHAKE_THRESHOLD = 15; 
const SHAKE_TIMEOUT = 2500;  
let lastX = null, lastY = null, lastZ = null;
let lastShakeTime = 0;
let isShakeModalOpen = false; 

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

function showRandomTitleModal(titleText) {
    if (isShakeModalOpen) return;
    isShakeModalOpen = true;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "shakeRandomModal";
    overlay.style.zIndex = "10000";

    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); isShakeModalOpen = false; } };

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center; border: 3px solid #ff4081;">
            <div style="font-size: 40px;">🎰</div>
            <h2 id="shakeRandomTitle" style="margin: 15px 0;"></h2>
            <div style="display: flex; flex-direction: column; gap: 10px;">
                <button id="closeShakeBtn" class="btn-save">Супер, смотрим!</button>
                <button id="rerollShakeBtn" class="btn-cancel">🔄 Другой фильм</button>
            </div>
        </div>
    `;

    const isSecret = titleText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || titleText.includes("Бакс Ориджинал") || (currentCategoryName && (currentCategoryName.includes("Секрет") || currentCategoryName.includes("🔒")));
    overlay.querySelector("#shakeRandomTitle").textContent = isSecret ? titleText.replace(/\s*\(\d{4}\)$/, "") : titleText;

    document.body.appendChild(overlay);

    document.getElementById("closeShakeBtn").onclick = () => { overlay.remove(); isShakeModalOpen = false; };
    document.getElementById("rerollShakeBtn").onclick = () => {
        const all = getAllTitlesFromCategory(history[history.length - 1]);
        const next = all[Math.floor(Math.random() * all.length)];
        overlay.querySelector("#shakeRandomTitle").textContent = isSecret ? next.replace(/\s*\(\d{4}\)$/, "") : next;
    };
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
    
    showRandomTitleModal(randomTitle);
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

// Генератор бесконечных нежных сердечек на заднем фоне
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

// Запускаем магию!
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
