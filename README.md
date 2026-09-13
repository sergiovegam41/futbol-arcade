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
- **Poderes raros:** de vez en cuando cae un 🔥 **tiro de fuego** en el campo. El primero que lo toca se lo lleva para su equipo y su siguiente disparo sale en llamas, más fuerte y casi imparable. Máximo uno en el campo a la vez y tres por partido.
- **Vibración del mando** al disparar cerca del arco y cuando te encaran para robarte el balón, más **temblor de pantalla** en los remates al área.
- Duración configurable (2, 3 o 5 minutos), posesión en vivo, repeticiones de gol con celebración y sonido generado por Web Audio.

## Controles

Conecta hasta dos mandos (el navegador los detecta solo después de que presiones un botón en cada uno) o juega con teclado.

| Acción | Mando | Azul | Rojo |
|---|---|---|---|
| Mover | Joystick izq. | `W` `A` `S` `D` | flechas |
| Tiro al arco (mantén para cargar) | `A` | `Espacio` | `Enter` |
| Tiro fuerte | `B` | `F` | `/` |
| Pase (con balón) / Barrida (sin balón) | `X` | `E` | `.` |
| Encarar / robar | `Y` o `LT` | `R` | `,` |
| Sprint | `RB` / `RT` | `Shift` | `Ctrl` der. |
| Cambiar al más cercano | `LB` | `Q` | `M` |
| Elegir por dirección | Palanca derecha | — | — |
| Pausa | — | `P` o `Esc` | `P` o `Esc` |

### Notas de juego

- **Tiro cargado:** mantén el botón de tiro y suéltalo. La barra bajo el jugador muestra la potencia. Cuanta más carga, más asistencia hacia la portería.
- **Tiro fuerte (`B`):** mantén para llenar la barra de potencia. La barra tiene una **zona ideal** marcada: soltar dentro de ella da un golpeo limpio, preciso y mucho más difícil de atajar. Pasarte de carga da más pique pero menos control, y el disparo se abre.
- **Barrida (`X` sin balón):** entrada agresiva. Te lanzas por delante y te llevas cualquier balón que toques, pero terminas en el suelo casi un segundo y medio sin poder jugar, y el control pasa a otro compañero. Fallarla deja al rival con el camino libre.
- **Atajadas:** que el arquero llegue a la pelota no significa que la agarre. Según la potencia y la calidad del golpeo hay probabilidad de que se le escape: el arquero se pone traslúcido un instante y el balón sigue de largo. Tirarle de frente ya no es gol seguro para él.
- **Encarar (`Y`):** fija tu orientación sobre el balón y cierras más rápido. Si alcanzas al rival que la lleva, se la quitas y pasas a controlar al que robó.
- **Arquero:** lee los disparos de verdad, no los regates, así que ya no se le puede provocar la estirada acercándose. Ante un tiro que le pasa cerca se mantiene en pie y da un paso lateral; solo se tira si la pelota va fuera de su alcance, y aun así falla de vez en cuando. Ocasionalmente sale a achicar contra un atacante que se le viene encima. Dentro del área atrapa y saca hacia un compañero libre; fuera del área solo puede despejarla con el pie.
- **Vibración:** los tiros a menos de 560px del arco rival hacen vibrar el mando de ese jugador, más fuerte cuanto más cerca y más potente. También vibra el mando del que lleva el balón cuando un rival lo encara, subiendo de intensidad según se acerca, con un golpe seco al perderla. Requiere un mando con soporte de haptics; sin él, el juego funciona igual.
- **Cambio de jugador:** es manual. El botón solo alterna entre los jugadores cerca del balón (480px): la primera pulsación te da el más cercano y las siguientes rotan entre ese grupo, nunca te entrega a alguien parado en la otra punta. Para llegar a un jugador lejano usa la palanca derecha. El único cambio automático es el de posesión.

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
