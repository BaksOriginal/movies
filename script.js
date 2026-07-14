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
        ]

    },


    "Мультфильмы": {

        "Комедия": {

            "Шрек": [
                "Шрек 1",
                "Шрек 2",
                "Шрек 3"
            ],

            "Мадагаскар": [
                "Мадагаскар 1",
                "Мадагаскар 2"
            ],

            "Кот в сапогах": "Кот в сапогах"

        }

    }

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



    for(let key in data){


        let button = document.createElement("button");

        button.textContent = key;


        button.onclick = () => {

            openData(data[key], data);

        };


        app.appendChild(button);

    }

}



function openData(content, parent){


    history.push(() => openData(parent, null));


    clear();



    if(Array.isArray(content)){


        content.forEach(item => {


            let div = document.createElement("div");

            div.className = "item";

            div.textContent = item;


            app.appendChild(div);


        });


    }

    else if(typeof content === "object"){


        for(let key in content){


            let value = content[key];



            if(typeof value === "string"){


                let div = document.createElement("div");

                div.className = "item";

                div.textContent = value;


                app.appendChild(div);


            }


            else{


                let button = document.createElement("button");

                button.textContent = key;


                button.onclick = () => {

                    openData(value, content);

                };


                app.appendChild(button);

            }


        }


    }


    addNavigation();

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
