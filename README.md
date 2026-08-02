# Onyx

Plantilla de app de escritorio Electron. Oscura, acromática, todo hecho a mano:
ni un control nativo de Chromium, ni un emoji, ni una transición que falte.

No es una librería: es una **plantilla que se copia**. Cada app que sale de acá
queda 100% independiente — no enlaza contra Onyx, así que tocar Onyx más
adelante no puede romper nada de lo que ya construiste.

```powershell
.\scaffold.ps1 -Name Thunder -Accent cian
```

```
cd C:\tools\Thunder
npm run dev
```

Y ya tenés una app corriendo: ventana sin frame ni flash blanco, rail de
navegación, paleta de comandos, overlays propios, datos en disco con escritura
atómica, y una vitrina viva de todos los primitivos.

---

## Las perillas

Todo el sistema visual deriva de cuatro variables, arriba de todo en
[`renderer/css/tokens.css`](renderer/css/tokens.css):

| Variable | Qué es | Default |
|---|---|---|
| `--ox-hue` | El matiz de **toda** la escalera de grises, en grados OKLCH | `258` (azul frío) |
| `--ox-tint` | Cuánta temperatura. Multiplica la croma de la escalera | `1` |
| `--ox-accent-rgb` | El acento, como triplete RGB | `240 243 247` (luz) |
| `--ox-mono` | La familia monoespaciada, **empaquetada** | `roboto` (Roboto Mono) |

La paleta está en OKLCH y no en hex a propósito: OKLCH separa luminancia de
matiz, así que se puede re-tintar la app entera moviendo un número sin que
ninguna superficie se aclare ni se oscurezca de más.

**No las edites a mano.** Hay dos copias del color base en hex que no se pueden
derivar en tiempo de ejecución — el `backgroundColor` de la ventana y el fondo
del splash — y desincronizarlas trae de vuelta el destello blanco. Usá:

```
node tools/retint.mjs --accent violeta
node tools/retint.mjs --hue 205 --tint 1.6
node tools/retint.mjs --mono sistema
```

que toca los tres lugares de una. `npm test` verifica que sigan en sincronía.

Los presets de acento: `luz`, `cian`, `violeta`, `verde`, `ambar`. **Rojo no
hay**, a propósito: el rojo está reservado al fallo, y un acento rojo lo deja
sin significado.

### La tipografía viaja con la app

`font-family: 'X', 'Y', Consolas, monospace` no elige una tipografía: elige una
lotería. En una máquina cualquiera, un stack que arranca con `'JetBrains Mono'`
puede terminar pintando Cascadia Mono sin avisar — se ve bien, pero no se ve
como lo diseñaste, y en la máquina de al lado se ve distinto otra vez.

Por eso la mono está **empaquetada** en `renderer/fonts/`, declarada en
[`fonts.css`](renderer/css/fonts.css), con los dos pesos que el sistema usa
(400 y 500 — `.ox-chip--mono` hereda el medio) y partida por `unicode-range`
para que ningún carácter caiga en la de respaldo a mitad de palabra.

Para sumar una: el `.woff2` en `renderer/fonts/`, su `@font-face` en
`fonts.css`, y su token `--ox-mono-*` en `tokens.css`. Aparece sola en **Piezas**
y `retint.mjs` la acepta. Si distribuís la app, la licencia de la fuente tiene
que viajar con ella.

> **La sans todavía no.** `--ox-font` sigue saliendo del sistema, así que en
> Windows suele caer a Segoe UI Variable en vez de Inter. Empaquetarla es el
> mismo procedimiento.

---

## El mapa

```
main.cjs              La ventana. Todo el anti-flash vive acá y está comentado.
preload.cjs           La única puerta al sistema. Lo que no esté acá, no existe.
src/
  ipc.cjs             Qué puede pedir el renderer. Es la superficie de ataque.
  store.cjs           JSON atómico: ajustes, documentos sueltos, colecciones.
renderer/
  index.html          El shell (titlebar, rail, statusbar) y el boot splash.
  fonts/              Las tipografías empaquetadas, con su licencia al lado.
  css/
    fonts.css         Los @font-face. Se carga primero.
    tokens.css        ← la única fuente de verdad. Empezá acá.
    base.css          Reset, scrollbars, focus, selección, tipografía.
    motion.css        Keyframes, entradas/salidas, click-flash, esfumados.
    shell.css         Titlebar, rail, statusbar, inspector, encabezado de vista.
    controls.css      Botones, campos, switch, check, slider, segmentado.
    surfaces.css      Cards, listas, tablas, chips, medidores, marcas de estado.
    overlays.css      Modal, menú, tooltip, toast, paleta de comandos.
  js/
    icons.js          El set base de SVG. Los tuyos con Icons.add({...}).
    motion.js         Salidas animadas, esfumados, indicadores que viajan.
    overlays.js       Tooltip, Toast, Menu, Modal.
    palette.js        Ctrl+K, con match por subsecuencia.
    router.js         Vistas + parámetro + ciclo de vida.
    ui.js             paint, head, empty, mark, status, attempt, copy.
    format.js         Duraciones, tamaños, tiempo relativo, monogramas.
    design-view.js    La vitrina viva.
    app.js            ← la app demo. Esto se borra.
tools/
  retint.mjs          Re-tinta la app dejando los tres lugares sincronizados.
  oklch.mjs           OKLCH → sRGB, con las matrices del estándar.
test/
  tokens.test.mjs     Que el color de la ventana no se desincronice.
  store.test.mjs      Escritura atómica bajo concurrencia.
  renderer.test.cjs   Monta la app de verdad y la recorre (npm run smoke).
```

```
npm test        # tokens + almacenamiento. Node pelado, instantáneo.
npm run smoke   # monta el renderer con Electron y lo recorre entero.
```

El de humo mide **dónde cae** cada overlay, no solo si existe. El bug más caro
de este sistema fue un modal que renderizaba en `top:-281px`: presente en el
DOM, correcto en el HTML, e inalcanzable con el mouse. Un test que solo
preguntara `¿existe .ox-modal?` habría dado verde.

La referencia completa del sistema —clases, componentes, cuándo usar cada uno—
está en **[docs/sistema.md](docs/sistema.md)**. La versión que se toca con el
mouse está adentro de la app, en **Piezas**.

---

## Las reglas que no se negocian

Son las que hacen que la app se sienta de una pieza. Cada una está resuelta en
el código; romperlas es lo que hace que algo "se vea raro" sin poder decir por qué.

**Solo oscuro.** No hay modo claro. No es una preferencia tibia: el blanco de
más molesta físicamente, y mantener dos looks coherentes es el doble de trabajo
para diluir la identidad. Si algo se ve apagado, se arregla con contraste y
elevación, no con fondo claro.

**Todo cambio de estado se anima, incluida la salida.** Lo más fácil de olvidar
es que lo que se va del DOM tiene que *terminar* su animación antes de irse.
Para eso está `exit()` en `motion.js`: marca `data-state="closing"`, espera el
`animationend` y recién ahí remueve. Sin eso los overlays parpadean al cerrarse
y toda la app se siente rota.

**Cero emojis y cero glifos unicode.** Todo símbolo es un SVG propio sobre
grilla de 16. Un `✓` o un `↵` se renderiza distinto en cada máquina, no se le
controla el peso ni el color, y rompe el trazo del resto. Hasta las flechas de
las teclas en la paleta de comandos son SVG.

**Nada nativo de Chromium.** El `outline` azul del focus, el `title=` amarillo,
la scrollbar gris de Windows, el highlight azul de la selección, el `confirm()`
del sistema: todos reemplazados. Un control nativo grita "esto es una página web
adentro de una ventana".

**El contenido se puede copiar.** El chrome (botones, labels, nav) es
`user-select: none` para el feel nativo, pero todo lo que alguien querría
llevarse lleva `.ox-copyable`. Bloquear la selección es hostil.

**Donde el scroll recorta al aire, va un fade.** Un corte al aire se lee como un
bug. `.ox-scroll` lo hace solo, y apaga el fade del lado donde no hay nada
recortado. Pero **el fade va solo donde el corte es al aire**: si de ese lado hay
una línea — la statusbar, el pie de un panel, el hairline del propio bloque — la
línea ya es el límite, y el esfumado encima la ensucia y además miente. Un bloque
con borde corta limpio contra su borde: ese lado se apaga con
`.ox-scroll--line-top` / `--line-bottom`. El contenedor lleva padding ≥
`--ox-fade` para que en reposo la banda no coma el primer ni el último ítem.

**La jerarquía es por elevación, no por bordes.** Lo que flota sube de
superficie y proyecta sombra. Los hairlines existen para divisores finos, y
siempre como `box-shadow: inset` — un `border` real deja hilacha en las esquinas
redondeadas con `overflow:hidden`.

**Sans para la UI, mono solo para dato exacto.** IDs, números, rutas,
timestamps. El mono en texto corrido se lee técnico de más.

**Un solo acento por pantalla.** Si dos cosas compiten por ser "el color", una
sobra.

---

## Por qué Electron 40 y por qué la ventana nace en x:-20000

Hay **dos** destellos blancos distintos al abrir una ventana en Windows, y se
arreglan distinto. Confundirlos es lo que hace perder horas.

**El de contenido (FOUC).** Antes de que el renderer pinte su primer frame,
Chromium muestra el fondo por defecto de la ventana. Se mata con `show:false` +
`backgroundColor` oscuro + `paintWhenInitiallyHidden` + el splash inline del
`index.html`. Necesario, pero no alcanza solo.

**El del compositor (DWM).** Cuando el HWND pasa de oculto a visible, el
compositor de Windows pinta su backdrop **por encima** del swap chain de
Chromium. Ningún CSS lo alcanza. No se puede evitar — se puede *provocar donde
nadie lo vea*. Por eso la ventana nace fuera de pantalla, hace su primer
`show()` ahí, y recién 200 ms después se mueve a su lugar.

> Si el destello se ve en vivo pero **no** aparece en una grabación de pantalla,
> es este segundo. Los grabadores capturan el swap chain antes de la composición
> final, así que el backdrop de DWM les es invisible.

Los 200 ms no son arbitrarios: con 120 el flash vuelve de forma intermitente. Un
destello "a veces sí, a veces no" es siempre este número, nunca otra cosa.

Y hay un tercer destello, el de **minimizar → restaurar**, que el truco
off-screen no cubre. Ese no se elimina: se tiñe. Desde Electron 40 el compositor
lo pinta con el `backgroundColor` de la ventana; en la 33 y anteriores es blanco
hardcodeado y no hay forma de taparlo. Por eso la versión está pineada.

> **Peaje del upgrade:** subir de Electron sube Node y puede romper módulos
> nativos. Regla: upgrade de Electron ⇒ rebuild de nativos.

---

## Los datos

Archivos JSON legibles en `data/`, no en AppData: se abren con un editor, se
versionan en git, y se arreglan a mano cuando algo sale mal. `<APP>_DATA` mueve
la carpeta.

`src/store.cjs` da tres formas de guardar:

```js
store.loadSettings() / saveSettings(patch)   // los ajustes, con migraciones
store.doc('borrador').read() / .write(data)  // un documento suelto
store.collection('notas')                    // una carpeta, un archivo por ítem
```

La escritura atómica de ese archivo es más larga de lo que parece que debería, y
cada línea de más está cubriendo un modo de falla que ya pasó en producción:

1. **Escritura no atómica** → un corte a mitad deja el archivo truncado. Se
   escribe un `.tmp`, se fuerza el flush, y recién ahí se renombra encima.
2. **`.tmp` de nombre fijo** → dos guardados solapados usan el mismo temporal;
   el primero en renombrar se lo lleva y el segundo muere con `ENOENT`. **Esa
   escritura se pierde en silencio.** Nombre único + una cola por archivo.
3. **`EPERM` en Windows** → el rename falla si el destino está tomado en ese
   instante (antivirus, otro proceso leyendo, otra instancia). Son bloqueos de
   milisegundos: se reintenta con backoff.

Los ids que llegan del renderer se validan antes de tocar el disco: un id con
`../` escribiría donde quiera. `assertId` no se saca.

---

## Empezar una app de verdad

1. `.\scaffold.ps1 -Name MiApp -Accent violeta`
2. **La marca.** El octágono es el placeholder. Está en dos lugares que tienen
   que coincidir: el splash de `renderer/index.html` y el ícono `onyx` de
   `renderer/js/icons.js`.
3. **Las vistas.** Vaciá `renderer/js/app.js` y dejá `boot()`. El rail y la
   statusbar se editan en `index.html`.
4. **Los datos.** Declará tus ajustes en `src/store.cjs` y tus colecciones en
   la lista blanca de `src/ipc.cjs`.
5. **Tus íconos.** `Icons.add({ ... })` al arrancar. No edites `icons.js`: así
   podés traerte una versión nueva del set base sin pisar los tuyos.

Lo que **no** hay que hacer: renombrar el prefijo `ox-`. Es el prefijo del
framework, no de la app. Que sea el mismo en todas tus apps es lo que hace que
`ox-btn` signifique lo mismo en todos lados y que un arreglo se pueda portar
copiando un archivo. Tus componentes propios llevan tu prefijo.
