const data = {

    "Аниме": {

        "Романтика": [
            "Your Name",
            "Toradora!",
            "Clannad"
        ],

        "Драма": [
            "Violet Evergarden",
            "Anohana",
            "Erased"
        ],

        "Sci-Fi": [
            "Steins;Gate",
            "Psycho-Pass",
            "Cowboy Bebop"
        ]
    },


    "Фильмы": {

        "Sci-Fi": [
            "Interstellar",
            "Arrival",
            "The Matrix"
        ],

        "Боевик": [
            "John Wick",
            "Nobody",
            "Mad Max"
        ],

        "Хоррор": [
            "Alien",
            "The Thing",
            "The Conjuring"
        ]
    },


    "Игры": [
        "Cyberpunk 2077",
        "Little Witch Nobeta",
        "NieR: Automata"
    ]

};


const app = document.getElementById("app");

let history = [];


function clear(){

    app.innerHTML = "";

}



function showHome(){

    history = [];


    let nav = document.querySelector(".navigation");

    if(nav){
        nav.remove();
    }


    clear();

    let title = document.createElement("h1");

    title.textContent = "Что сегодня посмотрим?";

    app.appendChild(title);

    for(let category in data){

        let button = document.createElement("button");

        button.textContent = category;

        button.onclick = () => openCategory(category);


        app.appendChild(button);

    }

}



function openCategory(category){

    history.push(showHome);


    clear();


    let content = data[category];


    if(Array.isArray(content)){

        showItems(content);

    }

    else{


        for(let genre in content){

            let button = document.createElement("button");

            button.textContent = genre;


            button.onclick = () => openGenre(content[genre], category);


            app.appendChild(button);

        }

    }


    addNavigation();

}



function openGenre(items, category){

    history.push(() => openCategory(category));


    clear();


    showItems(items);


    addNavigation();

}



function showItems(items){

    items.forEach(item => {


        let div = document.createElement("div");


        div.className = "item";


        div.textContent = item;


        app.appendChild(div);


    });

}



function addNavigation(){

    let oldNav = document.querySelector(".navigation");


    if(oldNav){

        oldNav.remove();

    }



    let nav = document.createElement("div");


    nav.className = "navigation";



    let back = document.createElement("button");


    back.textContent = "⬅ Назад";



    back.onclick = () => {


        let previous = history.pop();


        if(previous){

            previous();

        }

    };



    let home = document.createElement("button");


    home.textContent = "🏠 Домой";



    home.onclick = showHome;



    nav.appendChild(back);

    nav.appendChild(home);



    document.body.insertBefore(

        nav,

        document.querySelector(".container")

    );

}



showHome();