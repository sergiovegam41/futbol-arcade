# ⚽ Fútbol Arcade — 2 Jugadores

Juego de fútbol arcade para dos jugadores en el mismo equipo, hecho con HTML, CSS y JavaScript puro sobre `<canvas>`. Sin dependencias, sin build: se abre y se juega.

**▶️ Jugar: https://sergiovegam41.github.io/futbol-arcade/**

---

## El partido

5 contra 5: un arquero controlado por la IA, **2 defensas** y **2 delanteros** por equipo. Controlas a un jugador a la vez; el resto del equipo se mueve solo manteniendo la forma, adelantándose cuando atacas y replegándose cuando defiendes.

- **Si tú corres, todo el equipo corre contigo.** El sprint arrastra a los compañeros, que aceleran en bloque.
- **El control siempre va a quien tiene el balón.** Si un compañero la roba o recibe un pase, pasas a manejarlo a él.
- **Control cerrado:** mientras la llevas, el balón va pegado al pie y no se escapa solo al girar o esprintar.
- **Arquero con criterio:** se queda en pie y achica de costado ante la mayoría de remates, y solo se estira cuando la pelota le queda realmente lejos. Sale del área a cortar balones sueltos y, si la atrapa, la reparte a un compañero.
- **Poderes raros:** de vez en cuando cae un 🔥 **tiro de fuego** en el campo. El primero que lo toca se lo lleva para su equipo y **su siguiente tiro con `B`** sale en llamas, más fuerte y casi imparable. Solo lo gasta el tiro fuerte —pasar o rematar con `A` no lo consume— y caduca a los 15 s: el aro naranja alrededor del jugador marca cuánto queda.
- **Vibración del mando** al disparar cerca del arco y cuando te encaran para robarte el balón, más **temblor de pantalla** en los remates al área.
- Duración configurable (2, 3 o 5 minutos), posesión en vivo, repeticiones de gol con celebración y sonido generado por Web Audio.

## Controles

Conecta hasta dos mandos (el navegador los detecta solo después de que presiones un botón en cada uno) o juega con teclado.

| Acción | Mando | Azul | Rojo |
|---|---|---|---|
| Mover | Joystick izq. | `W` `A` `S` `D` | flechas |
| Tiro al arco (mantén para cargar) | `A` | `Espacio` | `Enter` |
| Tiro fuerte (mantén) | `B` | `F` | `/` |
| Tiro con rosca | `B` + `RB` | — | — |
| Centro / pase alto | `A` + `RB` | — | — |
| Pase (con balón) / Barrida (sin balón) | `X` | `E` | `.` |
| Encarar / robar | `Y` o `LT` | `R` | `,` |
| Sprint | `RB` / `RT` | `Shift` | `Ctrl` der. |
| Cambiar al más cercano | `LB` | `Q` | `M` |
| Elegir por dirección | Palanca derecha | — | — |
| Pausa | — | `P` o `Esc` | `P` o `Esc` |

### Notas de juego

- **Tiro cargado:** mantén el botón de tiro y suéltalo. La barra bajo el jugador muestra la potencia. Cuanta más carga, más asistencia hacia la portería.
- **Tiro fuerte (`B`):** mantén para llenar la barra de potencia. La barra tiene una **zona ideal** marcada: soltar dentro de ella da un golpeo limpio, preciso y mucho más difícil de atajar. Pasarte de carga da más pique pero menos control, y el disparo se abre.
- **Tiro con rosca (`B` + `RB`):** sale abierto hacia fuera y vuelve hacia el arco. Desde un ángulo cerrado donde el tiro recto se va fuera, la rosca entra.
- **Centro / pase alto (`A` + `RB`):** cuelga el balón por el aire hasta un compañero. La carga define la altura: uno bajo lo corta cualquiera que salte (pulsando el botón de tiro), uno alto pasa por encima de todos. El balón crece y se separa de su sombra; la sombra marca dónde va a caer.
- **Barrida (`X` sin balón):** entrada agresiva. Te lanzas por delante y te llevas cualquier balón que toques, pero terminas en el suelo casi un segundo y medio sin poder jugar, y el control pasa a otro compañero. Fallarla deja al rival con el camino libre.
- **Atajadas:** que el arquero llegue a la pelota no significa que la agarre. Según la potencia, la calidad del golpeo y **sobre todo la distancia** hay probabilidad de que se le escape: el arquero se pone traslúcido un instante y el balón sigue de largo. Desde lejos tiene tiempo de acomodarse, así que un tiro de media cancha casi nunca se le pasa aunque aciertes la zona ideal — hay que acercarse.
- **Balón en las manos:** mientras el arquero la sostiene no hay forma de quitársela (ni por contacto, ni encarando, ni barriendo, ni pateando), los rivales son apartados para que no acampen encima, y el saque queda protegido un instante para que no se lo roben al soltarla.
- **Encarar (`Y`):** fija tu orientación sobre el balón y cierras más rápido. Si alcanzas al rival que la lleva, se la quitas y pasas a controlar al que robó.
- **Arquero:** no se mueve hasta que pateas. Ahí arranca su tiempo de reacción (0.11–0.27 s) y solo entonces se compromete: la mayoría de las veces lee el tiro, y a veces apuesta por un palo y se va al contrario. Desde lejos le da tiempo de leerlo; de cerca el balón llega antes que su reacción y le toca adivinar. Si la pelota le pasa cerca se queda en pie y da un paso lateral. Sale de su línea a por balones sueltos, atrapa dentro del área y saca hacia un compañero libre; fuera del área solo puede despejarla con el pie.
- **Vibración:** los tiros a menos de 560px del arco rival hacen vibrar el mando de ese jugador, más fuerte cuanto más cerca y más potente. También vibra el mando del que lleva el balón cuando un rival lo encara, subiendo de intensidad según se acerca, con un golpe seco al perderla. Requiere un mando con soporte de haptics; sin él, el juego funciona igual.
- **Cambio de jugador:** es manual y depende de dónde esté el balón. En campo rival el botón alterna entre tus **delanteros**; en tu propia mitad, entre tus **defensas** — la línea que te sirve en esa fase. Dentro de la línea, la primera pulsación te da al más cercano al balón. Para elegir a cualquier otro está la palanca derecha. El único cambio automático es el de posesión.

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
