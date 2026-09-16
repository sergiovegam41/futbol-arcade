# ⚽ Fútbol Arcade — 2 Jugadores

Juego de fútbol arcade para dos jugadores en el mismo equipo, hecho con HTML, CSS y JavaScript puro sobre `<canvas>`. Sin dependencias, sin build: se abre y se juega.

**▶️ Jugar: https://sergiovegam41.github.io/futbol-arcade/**

---

## Vista 2D / 3D

En el menú eliges cómo mirar el partido: **▦ 2D cenital** (el clásico) o **🎥 3D**, una cámara en ángulo medio-superior hecha con [three.js](https://threejs.org/) que acompaña la jugada.

Es solo una forma distinta de *ver* lo mismo: la simulación no cambia. Sigue corriendo en sus coordenadas de 1600×900 y el 3D las mapea al plano `(x, z)` del mundo, usando la **altura real del balón** que ya existía — así que los centros colgados describen su parábola de verdad, con la sombra quedándose en el césped para que sepas dónde va a caer. El césped 3D reutiliza el mismo canvas donde se dibujan las líneas en 2D, así que ambas vistas comparten el terreno.

Los jugadores son formas simples (cuerpo, cabeza y una cuña que marca hacia dónde miran), se tumban al barrer y el arquero se vuelve traslúcido cuando se le escapa un balón, igual que en 2D.

Si three.js no carga, el botón lo dice y el juego se queda en 2D: la página nunca depende del CDN para ser jugable.

## Sonido de estadio

El público se oye y **reacciona a lo que pasa**: un murmullo constante de fondo y una capa más brillante que solo se abre según el balón se acerca a un arco. Medido, de 19% de intensidad en el medio campo a 93% dentro del área. Sube rápido y baja despacio, como una grada de verdad. Al marcar hay un rugido aparte.

Está **sintetizado, no grabado**: una grabación serían megas de audio que descargar, licenciar y cachear, y que además se notaría el bucle. Esto son unas líneas de Web Audio que nunca se repiten y no pesan nada.

**Mientras se juega el público va muy bajo** (al 20% de su volumen), por debajo de los golpeos y el silbato: es ambiente, no banda sonora. Solo se abre del todo cuando hay motivo — un gol, su repetición, la celebración. Se silencia todo con el botón 🔊, con la tecla `N` o con el botón **Back** del mando.

## Física del balón

- **El gol no se corta en seco.** Al cruzar la línea el balón sigue vivo 1.35 s dentro del arco: entra en la red, golpea la tela, cae y rueda. El reloj se para durante ese rato y solo después llega la celebración y la repetición.
- **Arco con fondo de verdad:** 62px de profundidad contra 220 de ancho, la proporción de uno real.
- **Postes y travesaño sólidos.** Antes el balón los atravesaba. Ahora la madera existe: rebota con un *¡Al palo!*, sacudida de pantalla y sonido.
- **Un gol tiene que pasar por debajo del larguero.** El arco mide 220×73 px (1:3, como uno real) y un balón por encima ya no cuenta.
- **Resistencia cuadrática.** Antes el rozamiento era un porcentaje fijo por frame, así que un cañonazo y un pase perdían la misma *fracción*. La resistencia real crece con el cuadrado de la velocidad: un tiro fuerte frena de golpe y luego rueda; un pase suave sigue trotando. La resistencia de rodadura es aparte y solo actúa en el suelo.
- **Rebotes de verdad.** El balón bota varias veces perdiendo altura (63 → 21 → 8 → 3 → 1 px) en vez del único saltito que daba antes, y el suelo le frena algo de recorrido en cada bote.
- **Los tiros muy fuertes se levantan** del césped, así que un cañonazo vuela bajo en vez de ir clavado al suelo.
- **Sin teletransportes.** A 24 px por frame el balón saltaba limpiamente por encima de un poste entre un frame y el siguiente. Ahora la integración va en sub-pasos: verificado que a **40 px por frame** ningún disparo atraviesa la madera.

## Partido nocturno e iluminación

La vista 3D es un partido de noche, y la luz es lo que la sostiene:

- **Sombras reales.** Un mapa de 2048px cubre todo el campo. Jugadores, balón y postes proyectan sombra sobre el césped — sin eso las figuras parecen pegadas encima del campo en vez de apoyadas en él.
- **Cuatro torres de luz** en las esquinas, con su rejilla de seis focos, halo y un cono cálido que ilumina su zona del campo. Las esquinas quedan más brillantes que el centro, como en un estadio de verdad.
- **Luz principal cálida más relleno frío** desde el lado opuesto, para que las caras en sombra no queden negras del todo.
- **Corrección de color sRGB y tono ACES**, que es lo que evita que los colores saturados se quemen.

## Entrada del partido

En 3D, el saque no empieza en seco: la cámara entra baja detrás de un arco, recorre la cancha a ras de césped y sube hasta la posición de partido, abriendo el objetivo de 34° a 42°. Mientras tanto salen los nombres de los dos equipos y el modo.

El reloj **no arranca hasta que termina**, el campo está congelado, y cualquier botón la salta.

## Repetición del gol

Cada frame de juego se guarda en un búfer circular (solo posiciones). Al marcar, el partido se congela y se repiten los últimos segundos **a cámara lenta**, con letterbox, el piloto rojo de REC y el nombre del goleador.

La cámara de partido no sirve para esto —desde ahí arriba la red moviéndose un par de unidades es invisible—, así que la repetición **tiene su propia cámara**: arranca detrás del disparo, orbita el arco y se va cerrando hasta quedar a ras de campo (de 62 a 4.5 de altura, cerrando el ángulo de 42° a 30°), enfocando justo donde el balón se encuentra con la malla. Al acabar vuelve sola a la cámara de partido.

La red **no se abomba al marcar, sino cuando la repetición llega a ese instante**: si no, termina de rebotar antes de que lo veas. Y al llegar el balón se mantiene el plano un segundo y medio para que se vea la tela hundirse y volver.

**Se puede saltar, y en dos pasos**: la primera pulsación corta el balón dentro de la red y te lleva **a la repetición**; la segunda corta la repetición y va al saque. Saltando, el gol se resuelve en menos de medio segundo en vez de 11.

Esto arregla dos bugs que se notaban en el mando. El primero: saltar la celebración tiraba el gol pendiente a la basura, así que quien apretara un botón durante el festejo **cancelaba la repetición sin enterarse** — de ahí que "no siempre saliera". El segundo: el mando solo se leía dentro del paso de simulación, que no corre ni durante la intro ni durante la repetición, así que **con mando era imposible saltarlas** (con teclado sí funcionaba). Ahora el mando se lee desde el bucle de render, siempre, y cada pulsación cuenta **por flanco**: tener el botón hundido hace una cosa una vez, en vez de atravesar toda la secuencia en dos frames.

**El reloj se para durante la repetición**, así que nunca te roba tiempo de partido: 2.1 segundos de jugada se ven en 5 segundos reales y el marcador del tiempo no se mueve.

## Estadio y detalle

- **Pelucas.** Cada personaje lleva su pelo en 3D: afro, mohawk, coleta, moño, rizos, media melena, rapado… y un calvo por equipo. Repartidos sin repetir y montados sobre la cabeza, así que giran con el jugador. La vista cenital no los dibuja: en plano quedaban raros.
- **Plantillas con nombre.** Cada jugador se llama algo: KK, Penélope, El Tanque, Pantufla, Don Cangrejo… Los arqueros tienen su propio bombo de nombres (Manotas, El Muro, Palomita). Se reparten sin repetir al empezar, salen sobre la cabeza y **el gol anuncia al goleador** — o al del gol en propia, que también se reconoce.
- **Redes de tela Verlet.** Cada arco lleva una red de 207 nodos simulada con la misma técnica que el ejemplo de cloth de three.js: integración Verlet, restricciones de distancia que solo tiran cuando la tela se estira (una red se afloja, no es elástica) y gravedad, así que **cuelga bajo su propio peso**. La malla es una sola lámina doblada en U, de modo que los dos laterales y el fondo son la misma tela y las esquinas quedan cosidas.

  El balón es una **esfera sólida contra ella**: la empuja, la hunde y no la atraviesa nunca. Un tiro flojo la abomba 21px y un cañonazo 35px, y al acabar el rebote se congela sola para no seguir gastando cálculo.

  Sobre la librería: **no uso Ammo.js**. Sus cuerpos blandos harían esto, pero son ~1.5 MB de WASM para una red, en un juego cuya única dependencia es three.js. La técnica de tela de three.js da el mismo resultado con cero peso añadido.
- **Césped de verdad.** Franjas de corte con el brillo del rodillo, miles de briznas y zonas desgastadas donde un campo se pela: bocas de gol, puntos de penal y círculo central.
- **Gradas escalonadas.** Cuatro tribunas con muro frontal, barandilla, siete escalones que suben y se alejan, techo y pilares. 672 espectadores repartidos en las filas, mirando al campo, que se balancean solos y **saltan cuando hay gol**.
- **Estrellas al gol.** Al marcar, el público lanza cosas desde las cuatro tribunas y caen sobre el campo.
- **Bandera arcoíris con tela simulada.** Dos mástiles con banderas hechas de puntos y restricciones de distancia, ancladas al mástil y empujadas por un viento que va y viene.
- **Balón texturizado** en 3D, con sus paneles, que rueda de verdad, y con **cola de cometa** cuando va lanzado o por el aire: dieciséis fantasmas que se afinan y se apagan hacia atrás, siguiendo por dónde pasó de verdad, así que un tiro con rosca deja una estela curva. En un tiro de fuego arde de blanco a naranja.
- **El encare se ve en la cancha:** un arco rojo bajo el jugador, abierto hacia el balón, mientras mantienes el botón.

## Modos

Al empezar eliges rival: **👥 Un amigo** (dos mandos o teclado compartido) o **🤖 La máquina**, con tres niveles.

La máquina no hace trampa: no lee el estado interno ni recibe ventajas de física. Rellena exactamente la misma estructura de mando que un humano, así que el control cerrado, la barra de carga, el encarar y las barridas funcionan igual para ella. La dificultad cambia su **tiempo de reacción**, su **puntería** (error de apuntado real, no penalizaciones artificiales), cuánto **esprinta**, cuánto carga los tiros y cuándo decide entrar a barrer.

| Nivel | Marcador medio frente a un bot que persigue y remata (3 min) |
|---|---|
| Fácil | pierde 2.2 - 0.2 |
| Normal | pierde 1.5 - 1.0 |
| Difícil | compite 1.0 - 0.7 |

## El partido

7 contra 7: un arquero controlado por la IA, **2 defensas**, **2 mediocampistas** y **2 delanteros** por equipo. Controlas a un jugador a la vez; el resto del equipo se mueve solo manteniendo la forma, adelantándose cuando atacas y replegándose cuando defiendes.

- **Si tú corres, todo el equipo corre contigo.** El sprint arrastra a los compañeros, que aceleran en bloque.
- **El control siempre va a quien tiene el balón.** Si un compañero la roba o recibe un pase, pasas a manejarlo a él.
- **Control cerrado:** mientras la llevas, el balón va pegado al pie y no se escapa solo al girar o esprintar.
- **Arquero con criterio:** se queda en pie y achica de costado ante la mayoría de remates, y solo se estira cuando la pelota le queda realmente lejos. Sale del área a cortar balones sueltos y, si la atrapa, la reparte a un compañero.
- **Poderes raros:** de vez en cuando cae un 🔥 **tiro de fuego** en el campo. El primero que lo toca se lo lleva para su equipo y **su siguiente tiro con `B`** sale en llamas, más fuerte y casi imparable. Solo lo gasta el tiro fuerte —pasar o rematar con `A` no lo consume— y caduca a los 15 s: el aro naranja alrededor del jugador marca cuánto queda.

  En 3D **era invisible**: solo estaba dibujado en el canvas cenital, así que el orbe estaba ahí tirado en el campo, lo recogías por accidente y tu única pista era que el tiro salía naranja después. Ahora es un objeto de verdad — un núcleo ardiendo dentro de un halo, girando, flotando y tirando luz sobre el césped, con un aro plano en el pasto para verlo aunque un jugador lo tape, y parpadeando sus últimos tres segundos. Quien lo lleva arrastra un aro que **se va cerrando** según se gasta la ventana de 15 s y se pone rojo intermitente al final.
- **Barra de potencia también en 3D**, flotando sobre el jugador con la zona ideal marcada.
- **Vibración del mando** al disparar cerca del arco y cuando te encaran para robarte el balón, más **temblor de pantalla** en los remates al área.
- Duración configurable (2, 3 o 5 minutos), posesión en vivo, repeticiones de gol con celebración y sonido generado por Web Audio.

## Controles

Conecta hasta dos mandos (el navegador los detecta solo después de que presiones un botón en cada uno) o juega con teclado.

| Acción | Mando | Azul | Rojo |
|---|---|---|---|
| Mover | Joystick izq. | `W` `A` `S` `D` | flechas |
| Tiro al arco (mantén para cargar) | `A` | `Espacio` | `Enter` |
| Tiro fuerte (mantén) | `B` | `F` | `/` |
| Tiro con rosca | `B` + `RB` | `F` + `C` | `/` + `Shift` der. |
| Pase alto (chip) | `X` + `RB` | `E` + `C` | `.` + `Shift` der. |
| Centro / pase alto | `A` + `RB` | `Espacio` + `C` | `Enter` + `Shift` der. |
| Pase (con balón) / Barrida (sin balón) | `X` | `E` | `.` |
| Encarar / robar | `Y` o `LT` | `R` | `,` |
| Sprint | `RT` | `Shift` izq. | `Ctrl` der. |
| Modificador de tiro | `RB` | `C` | `Shift` der. |
| Cambiar al más cercano de la línea | `LB` | `Q` | `M` |
| Elegir por dirección | Palanca derecha | — | — |
| Pausa | — | `P` o `Esc` | `P` o `Esc` |
| Saltar intro / repetición | `A` `B` `X` `Y` `LB` `Start` | cualquier tecla | cualquier tecla |
| Silenciar | `Back` | `N` | `N` |
| Moverse por el menú | Cruceta / palanca izq. | flechas | flechas |
| Confirmar en el menú | `A` o `Start` | `Enter` o `Espacio` | `Enter` o `Espacio` |

### Notas de juego

- **Tiro cargado:** mantén el botón de tiro y suéltalo. La barra bajo el jugador muestra la potencia. Cuanta más carga, más asistencia hacia la portería.
- **Tiro fuerte (`B`):** mantén para llenar la barra de potencia. La barra tiene una **zona ideal** marcada: soltar dentro de ella da un golpeo limpio, preciso y mucho más difícil de atajar. Pasarte de carga da más pique pero menos control, y el disparo se abre.
- **Tiro con rosca (`B` + `RB`):** sale abierto hacia fuera y vuelve hacia el arco. Desde un ángulo cerrado donde el tiro recto se va fuera, la rosca entra.
- **Centro / pase alto (`A` + `RB`):** `RT` corre y `RB` es el modificador de tiro, botones distintos, así que correr nunca convierte un disparo en un globo: el balón solo se eleva si mantienes `RB`. Cuelga el balón por el aire hasta un compañero. La carga define la altura: uno bajo lo corta cualquiera que salte (pulsando el botón de tiro), uno alto pasa por encima de todos. El balón crece y se separa de su sombra; la sombra marca dónde va a caer.
- **Impulso:** soltar el botón de tiro sin balón cerca da un empujón corto hacia delante para cerrar distancia. No se puede encadenar: queda bloqueado 0.85 s, y nunca se suma al sprint —el juego toma el mayor de los dos, no el producto—, así que machacar el botón no te hace más rápido que correr.
- **Barrida (`X` sin balón):** entrada agresiva. Te lanzas por delante y te llevas cualquier balón que toques, pero terminas en el suelo casi un segundo y medio sin poder jugar, y el control pasa a otro compañero. Fallarla deja al rival con el camino libre.
- **Atajadas:** que el arquero llegue a la pelota no significa que la agarre. Según la potencia, la calidad del golpeo y **sobre todo la distancia** hay probabilidad de que se le escape: el arquero se pone traslúcido un instante y el balón sigue de largo. Desde lejos tiene tiempo de acomodarse, así que un tiro de media cancha casi nunca se le pasa aunque aciertes la zona ideal — hay que acercarse.
- **Balón en las manos:** mientras el arquero la sostiene no hay forma de quitársela (ni por contacto, ni encarando, ni barriendo, ni pateando), los rivales son apartados para que no acampen encima, y el saque queda protegido un instante para que no se lo roben al soltarla.
- **Encarar (`Y`):** fija tu orientación sobre el balón y cierras más rápido. Si alcanzas al rival que la lleva, se la quitas y pasas a controlar al que robó.
- **Arquero:** no se mueve hasta que pateas. Ahí arranca su tiempo de reacción (0.11–0.27 s) y solo entonces se compromete: la mayoría de las veces lee el tiro, y a veces apuesta por un palo y se va al contrario. Desde lejos le da tiempo de leerlo; de cerca el balón llega antes que su reacción y le toca adivinar. Si la pelota le pasa cerca se queda en pie y da un paso lateral. Sale de su línea a por balones sueltos, atrapa dentro del área y saca hacia un compañero libre; fuera del área solo puede despejarla con el pie.
- **Vibración:** los tiros a menos de 560px del arco rival hacen vibrar el mando de ese jugador, más fuerte cuanto más cerca y más potente. También vibra el mando del que lleva el balón cuando un rival lo encara, subiendo de intensidad según se acerca, con un golpe seco al perderla. Requiere un mando con soporte de haptics; sin él, el juego funciona igual.
- **Cambio de jugador:** es manual y depende de dónde esté el balón. El campo se parte en tres bandas: en tu tercio el botón alterna entre **defensas**, en el medio entre **mediocampistas** y en el tercio rival entre **delanteros** — la línea que te sirve en esa fase. Dentro de la línea, la primera pulsación te da al más cercano al balón. Para elegir a cualquier otro está la palanca derecha. El único cambio automático es el de posesión.

## Estructura

```
.
├── index.html        # estructura de la página, HUD y pantalla de inicio
├── css/
│   └── styles.css    # estilos, tema e interfaz
├── js/
│   └── game.js       # motor: física, IA, entrada y render sobre canvas
└── .nojekyll         # GitHub Pages sirve los archivos tal cual
```

## Ejecutar en local

Basta con abrir `index.html` en el navegador. Si prefieres servirlo:

```bash
python -m http.server 8000
# o
npx serve .
```

Y entra a `http://localhost:8000`.

## Despliegue

Publicado con **GitHub Pages** desde la rama `main` (carpeta raíz). Cada `push` a `main` actualiza el sitio.
