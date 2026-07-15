let dbData = {}; 
let isTransitioning = false; 

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

    titles.forEach(item => {
        const cat = item.category;
        const gen = item.genre;
        const fran = item.franchise;
        const titleWithYear = `${item.title} (${item.year})`;

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
}

const SUPABASE_URL = "https://nwkgofmgluduldgsmwfa.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Igpb__d5aHp3DBbQH1NgOA_W8_Ku6aE";

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = document.getElementById("app");
let currentUser = null;
let watchedTitles = new Set(); 
let history = [];
let realtimeChannel = null; 

db.auth.onAuthStateChange((event, session) => {
    if (session) {
        currentUser = session.user;
        
        Promise.all([
            loadWatchedFromDB(),
            loadCatalogFromDB() 
        ]).then(() => {
            subscribeToChanges(); 
            showHome(); 
        });
    } else {
        currentUser = null;
        watchedTitles.clear();
        if (realtimeChannel) {
            db.removeChannel(realtimeChannel);
            realtimeChannel = null;
        }
        showLoginScreen();
    }
});

async function loadWatchedFromDB() {
    if (!currentUser) return;
    
    const { data: dbData, error } = await db
        .from('watched_items')
        .select('title');

    if (error) {
        console.error("Ошибка при загрузке списка просмотренного:", error);
        return;
    }

    watchedTitles = new Set(dbData.map(item => item.title));
}

function subscribeToChanges() {
    if (realtimeChannel) return; 

    realtimeChannel = db
        .channel('schema-db-changes')
        .on(
            'postgres_changes',
            {
                event: '*', 
                schema: 'public',
                table: 'watched_items'
            },
            (payload) => {
                console.log('Изменение получено в реальном времени:', payload);
                
                if (payload.eventType === 'INSERT') {
                    watchedTitles.add(payload.new.title);
                } else if (payload.eventType === 'DELETE') {
                    watchedTitles.delete(payload.old.title);
                }

                updateUIOnLiveChange();
            }
        )
        .subscribe();
}

async function updateUIOnLiveChange() {
    await loadCatalogFromDB();

    let buttons = document.querySelectorAll("button");
    buttons.forEach(btn => {
        if (btn.textContent.includes("Просмотрено")) {
            btn.textContent = "🎬 Просмотрено (" + watchedTitles.size + ")";
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

            if (watchedTitles.has(lookupText)) {
                watchBtn.classList.add("watched");
                watchBtn.textContent = "★";
            } else {
                watchBtn.classList.remove("watched");
                watchBtn.textContent = "☆";
            }
        }
    });
}

async function toggleWatchState(title) {
    if (!currentUser) return;

    if (watchedTitles.has(title)) {
        watchedTitles.delete(title);
        updateUIOnLiveChange();

        const { error } = await db
            .from('watched_items')
            .delete()
            .eq('title', title)
            .eq('user_id', currentUser.id);

        if (error) {
            console.error("Ошибка при удалении фильма из БД:", error);
            watchedTitles.add(title);
            updateUIOnLiveChange();
        }
    } else {
        watchedTitles.add(title);
        updateUIOnLiveChange();

        const { error } = await db
            .from('watched_items')
            .insert([{ user_id: currentUser.id, title: title }]);

        if (error) {
            console.error("Ошибка при добавлении фильма в БД:", error);
            watchedTitles.delete(title);
            updateUIOnLiveChange();
        }
    }
}
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

function showHome() {
    startTransitionLock();
    history = [];
    
    let nav = document.querySelector(".navigation");
    if (nav) nav.remove();

    app.innerHTML = "";

    if (currentUser) {
        let header = document.createElement("div");
        header.className = "user-header";
        header.innerHTML = `<span id="userEmailSpan"></span> <button class="btn-logout" id="logoutBtn">Выйти</button>`;
        header.querySelector("#userEmailSpan").textContent = "Аккаунт: " + currentUser.email;
        app.appendChild(header);
        document.getElementById("logoutBtn").onclick = () => db.auth.signOut();
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
        addBtn.style.marginBottom = "20px";
        addBtn.onclick = () => showAddEditModal();
        app.appendChild(addBtn);
    }

    for (let key in dbData) {
        let button = document.createElement("button");
        button.textContent = key;
        button.onclick = () => openData(dbData[key], true);
        app.appendChild(button);
    }

    let watchedBtn = document.createElement("button");
    watchedBtn.textContent = "🎬 Просмотрено (" + watchedTitles.size + ")";
    watchedBtn.style.background = "#ffe3ec";
    watchedBtn.onclick = () => {
        const list = Array.from(watchedTitles);
        openData(list, true, "🎬 Просмотрено");
    };
    app.appendChild(watchedBtn);
}

function renderItemRow(itemText, container) {
    let row = document.createElement("div");
    row.className = "item-row";

    let itemDiv = document.createElement("div");
    itemDiv.className = "item";
    
    let isSecret = itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал");
    
    if (history.length > 0) {
        const currentCategoryData = history[history.length - 1];
        for (let catName in dbData) {
            if (dbData[catName] === currentCategoryData && (catName.includes("Секрет") || catName.includes("🔒") || catName.includes("❤️"))) {
                isSecret = true;
                break;
            }
        }
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
        itemDiv.addEventListener("click", (e) => {
            e.preventDefault();
        });

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
        } else {
            watchBtn.textContent = "☆";
        }
        watchBtn.onclick = () => toggleWatchState(itemText);
        row.appendChild(watchBtn);
    }

    container.appendChild(row);
}

function showActionMenu(itemText) {
    if (itemText.includes("Я Тебя Очень Сильно ЛЮБЛЮ!") || itemText.includes("Бакс Ориджинал")) return;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "actionMenuModal";

    overlay.innerHTML = `
        <div class="modal-content" style="text-align: center;">
            <h3 style="margin-bottom: 10px;" id="menuTitle"></h3>
            <p style="color: #666; margin-bottom: 20px; font-size: 14px;">Выберите действие для этого тайтла:</p>
            <div class="action-buttons">
                <button class="btn-action-edit" id="actEdit">✏️ Редактировать</button>
                <button class="btn-action-delete" id="actDelete">❌ Удалить</button>
                <button class="btn-action-cancel" id="actCancel">Отмена</button>
            </div>
        </div>
    `;

    overlay.querySelector("#menuTitle").textContent = itemText;

    document.body.appendChild(overlay);

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
    startTransitionLock();
    if (saveHistory) {
        history.push(content);
    }

    app.innerHTML = "";

    if (customTitle) {
        let title = document.createElement("h1");
        title.textContent = customTitle;
        app.appendChild(title);
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

function showAddEditModal(existingItem = null) {

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "addEditModal";

    const existingGenres = new Set();
    const existingFranchises = new Set();

    for (let catKey in dbData) {
        const categoryData = dbData[catKey];
        if (Array.isArray(categoryData)) continue; 

        for (let genreKey in categoryData) {
            existingGenres.add(genreKey);
            const titles = categoryData[genreKey];
            
            if (typeof titles === "object" && !Array.isArray(titles)) {
                for (let franchiseKey in titles) {
                    existingFranchises.add(franchiseKey);
                }
            }
        }
    }

    const sortedGenres = Array.from(existingGenres).sort();
    const sortedFranchises = Array.from(existingFranchises).sort();

    const genreOptions = sortedGenres.map(g => `<option value="${g}">`).join("");
    const franchiseOptions = sortedFranchises.map(f => `<option value="${f}">`).join("");

    const categories = Object.keys(dbData);
    
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
                    ${franchiseOptions}
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

    if (existingItem) {
        document.getElementById("mTitle").value = existingItem.title;
        document.getElementById("mYear").value = existingItem.year;
        mCategory.value = existingItem.category;
        mGenre.value = existingItem.genre;
        document.getElementById("mFranchise").value = existingItem.franchise || "";
    }

    document.getElementById("mCancel").onclick = () => overlay.remove();

    document.getElementById("modalForm").onsubmit = async (e) => {
        e.preventDefault();

        const titleVal = document.getElementById("mTitle").value.trim();
        const yearVal = parseInt(document.getElementById("mYear").value, 10);
        const catVal = mCategory.value;
        const genreVal = mGenre.value.trim();
        
        let franchiseVal = document.getElementById("mFranchise").value.trim();
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
            await updateUIOnLiveChange();
        }
    };
}
   
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

async function handleDeleteClick(itemText) {
    const match = itemText.match(/^(.*?)\s*\((\d{4})\)$/);
    if (!match) return;

    const cleanTitle = match[1].trim();
    const year = parseInt(match[2], 10);

    if (confirm(`Вы уверены, что хотите навсегда удалить "${cleanTitle}"?`)) {
        const { error } = await db
            .from("titles")
            .delete()
            .eq("title", cleanTitle)
            .eq("year", year);

        if (error) {
            alert("Ошибка при удалении: " + error.message);
        } else {
            await updateUIOnLiveChange();
            showHome();
        }
    }
}
