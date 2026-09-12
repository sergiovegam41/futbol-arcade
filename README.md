# ⚽ Fútbol Arcade — 2 Jugadores

Juego de fútbol arcade para dos jugadores en el mismo equipo, hecho con HTML, CSS y JavaScript puro sobre `<canvas>`. Sin dependencias, sin build: se abre y se juega.

**▶️ Jugar: https://sergiovegam41.github.io/futbol-arcade/**

---

## El partido

5 contra 5: un arquero controlado por la IA, **2 defensas** y **2 delanteros** por equipo. Controlas a un jugador a la vez; el resto del equipo se mueve solo manteniendo la forma, adelantándose cuando atacas y replegándose cuando defiendes.

- **Si tú corres, todo el equipo corre contigo.** El sprint arrastra a los compañeros, que aceleran en bloque.
- **El control siempre va a quien tiene el balón.** Si un compañero la roba o recibe un pase, pasas a manejarlo a él.
- **Control cerrado:** mientras la llevas, el balón va pegado al pie y no se escapa solo al girar o esprintar.
- **Vibración del mando** al disparar cerca del arco, con intensidad según la cercanía y la potencia del tiro.
- Duración configurable (2, 3 o 5 minutos), posesión en vivo, repeticiones de gol con celebración y sonido generado por Web Audio.

## Controles

Conecta hasta dos mandos (el navegador los detecta solo después de que presiones un botón en cada uno) o juega con teclado.

| Acción | Mando | Azul | Rojo |
|---|---|---|---|
| Mover | Joystick izq. | `W` `A` `S` `D` | flechas |
| Tiro al arco (mantén para cargar) | `A` | `Espacio` | `Enter` |
| Tiro fuerte | `B` | `F` | `/` |
| Pase | `X` | `E` | `.` |
| Encarar / robar | `Y` o `LT` | `R` | `,` |
| Sprint | `RB` / `RT` | `Shift` | `Ctrl` der. |
| Cambiar al más cercano | `LB` | `Q` | `M` |
| Elegir por dirección | Palanca derecha | — | — |
| Pausa | — | `P` o `Esc` | `P` o `Esc` |

### Notas de juego

- **Tiro cargado:** mantén el botón de tiro y suéltalo. La barra bajo el jugador muestra la potencia. Cuanta más carga, más asistencia hacia la portería.
- **Tiro fuerte (`B`):** golpe seco de máxima potencia con fuerte corrección hacia el arco.
- **Encarar (`Y`):** fija tu orientación sobre el balón y cierras más rápido. Si alcanzas al rival que la lleva, se la quitas y pasas a controlar al que robó.
- **Vibración:** los tiros a menos de 560px del arco rival hacen vibrar el mando de ese jugador. Cuanto más cerca y más potente, más fuerte y más largo el golpe. Requiere un mando con soporte de haptics; sin él, el juego funciona igual.
- **Cambio de jugador:** es manual. La primera pulsación te da el más cercano al balón; pulsaciones seguidas recorren hacia afuera. El único cambio automático es el de posesión.

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
