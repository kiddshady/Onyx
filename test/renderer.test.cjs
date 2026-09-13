/* ═══════════════════════════════════════════════════════════════════════════
   Humo del renderer: monta la app de verdad y la recorre.

   Se corre con `npm run smoke` (necesita Electron, por eso no está en el
   `npm test`, que es node pelado).

   Lo que busca es lo que un test de unidad NO ve: overlays que aterrizan fuera
   de pantalla, vistas que no montan, animaciones que se quedan quietas donde no
   se las ve, glifos unicode que se colaron. La regla que lo guía: **medí dónde
   CAE una cosa, no solo si existe**. El bug más caro de este sistema fue un
   modal que renderizaba en top:-281px — presente en el DOM, correcto en el
   HTML, e inalcanzable con el mouse.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const W = 1440; const H = 900;

/* El backgroundColor que main.cjs le pone a la ventana. El renderer se lo
   vuelve a mandar ya resuelto desde los tokens, y los dos tienen que coincidir:
   si no, el que se ve mientras el contenido no cubre la ventana es el otro. */
const BG_MAIN = (fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
  .match(/const BG = '(#[0-9a-f]{6})'/i)?.[1] || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const bail = (w, e) => { console.log(`ABORTADO ${w}`, e?.stack || e || ''); app.exit(3); };
process.on('unhandledRejection', (e) => bail('rechazo', e));
process.on('uncaughtException', (e) => bail('excepción', e));
setTimeout(() => bail('timeout de 120s'), 120000);

app.whenReady().then(async () => {
  require(path.join(ROOT, 'src', 'ipc.cjs')).register();

  const win = new BrowserWindow({
    x: -20000, y: -20000, width: W, height: H,
    frame: false, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#000',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true },
  });
  const errores = [];
  win.webContents.on('console-message', (e) => { if (e.level >= 2) errores.push(`${e.level}: ${e.message}`); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.show();
  await sleep(2200);

  const js = (c) => win.webContents.executeJavaScript(c);
  // Clickear sin explotar si el selector no existe: un elemento faltante tiene
  // que reportarse como falla del test, no como excepción que aborta todo.
  const click = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false; el.click(); return true; })()`);
  // Un click real es pointerdown → pointerup → click, y varios overlays se
  // cierran en pointerdown. Con `el.click()` solo, el orden nunca se prueba.
  const tap = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    el.click(); return true; })()`);
  // Una tecla de verdad, por el canal de entrada de la ventana. Misma razón por
  // la que `tap` existe al lado de `click`: un evento fabricado a mano prueba el
  // manejador, no el camino que recorre la tecla hasta llegar a él.
  const escape = () => win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });

  console.log('\n1. Arranque');
  ok('el splash se fue', !(await js(`!!document.getElementById('boot-splash')`)));
  ok('el shell está montado', await js(`!!document.querySelector('.ox-titlebar') && !!document.querySelector('.ox-rail')`));
  ok('los <i data-icon> se reemplazaron por SVG', !(await js(`!!document.querySelector('i[data-icon]')`)));
  ok('la vista inicial pintó algo', (await js(`document.getElementById('view').children.length`)) > 0);

  console.log('\n2. Crear por la UI real: modal → disco');
  await click('#btn-new');
  await sleep(600);
  ok('el modal de creación abre', await js(`!!document.querySelector('.ox-modal')`));
  await js(`(() => { document.getElementById('f-name').value='Humo';
    document.getElementById('f-note').value='creado por el test'; return true; })()`);
  await click('.ox-modal__foot .ox-btn--primary');
  await sleep(1200);

  const creado = await js(`window.onyx.col('items').list().then(l => l.find(i => i.name === 'Humo') || null)`);
  const id = creado?.id;
  ok('quedó en disco con id asignado', !!id, JSON.stringify(creado));
  ok('la nota viajó entera', creado?.note === 'creado por el test');
  ok('el router saltó a su detalle', await js(`!!document.querySelector('.ox-inspector')`));
  ok('los ajustes persisten', (await js(`window.onyx.settings.save({ densidad:'amplia' }).then(s => s.densidad)`)) === 'amplia');

  console.log('\n3. Todas las vistas montan');
  for (const v of ['items', 'piezas', 'ajustes', 'inicio']) {
    await click(`[data-view="${v}"]`);
    await sleep(700);
    const hijos = await js(`document.getElementById('view').children.length`);
    const activo = await js(`!!document.querySelector('[data-view="${v}"].is-active')`);
    ok(`${v}: pinta y queda activa en el rail`, hijos > 0 && activo, `hijos=${hijos} activo=${activo}`);
  }

  console.log('\n4. Router con parámetro');
  await click('[data-view="items"]');
  await sleep(600);
  ok('el ítem aparece en la lista', await click(`[data-open="${id}"]`));
  await sleep(800);
  ok('abre el detalle', await js(`!!document.querySelector('.ox-inspector')`));
  ok('el rail sigue marcando la sección padre', await js(`!!document.querySelector('[data-view="items"].is-active')`));
  ok('las migas llevan de vuelta', await js(`!!document.querySelector('[data-goto="items"]')`));
  ok('la titlebar muestra el contexto', (await js(`document.getElementById('titlebar-context').textContent.trim()`)) === 'Humo');

  /* ── 4-bis. El layout de dos paneles, medido ────────────────────────────────
     Dos cosas que solo se ven en esta vista y que ningún test miraba.

     La barra del panel tiene que nacer en el BORDE del inspector. La sangría
     lateral la pone el padre, así que la caja que scrollea terminaba 24px
     antes y la barra flotaba en el medio, separada de todo. Se mide el hueco y
     no la existencia de la regla: devolverle la sangría al contenedor la manda
     de vuelta al medio sin romper nada más, o sea en silencio.

     Y el cuerpo del inspector no lleva esfumado abajo NUNCA: si hay pie lo
     cierra el pie, y si no lo hay lo cierra la línea de la statusbar. Antes
     solo contemplaba el primer caso, así que un inspector sin pie recuperaba
     el fade y se lo encimaba a esa línea. Para probarlo hay que sacar el pie,
     porque la vitrina siempre trae uno. */
  console.log('\n4-bis. El layout de dos paneles');

  const barra = await js(`(() => {
    const sc = document.querySelector('.ox-viewbody__main > .ox-scroll');
    const insp = document.querySelector('.ox-inspector');
    if (!sc || !insp) return null;
    return {
      hueco: Math.round(insp.getBoundingClientRect().left - sc.getBoundingClientRect().right),
      barra: sc.offsetWidth - sc.clientWidth,
      scrollea: sc.scrollHeight - sc.clientHeight > 1,
    };
  })()`);
  ok('la barra del panel nace pegada al inspector',
    barra && barra.hueco === 0, JSON.stringify(barra));

  /* Sin scroll REAL no hay nada que esfumar y `is-bottom` apaga el fade por su
     cuenta: la medición daría 0px tenga o no tenga la regla puesta, y el
     chequeo pasaría siempre. Por eso se fuerza contenido alto y una posición
     intermedia — el único estado donde ese fade existiría de verdad. */
  const fade = await js(`(async () => {
    const body = document.querySelector('.ox-inspector__body');
    const pie = document.querySelector('.ox-inspector__foot');
    if (!body || !pie) return null;
    const relleno = document.createElement('div');
    relleno.style.height = '1200px';
    body.appendChild(relleno);
    const medir = async () => {
      body.scrollTop = 200;
      body.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 450));
      return getComputedStyle(body).getPropertyValue('--ox-fade-bottom').trim();
    };
    const con = await medir();
    const padre = pie.parentElement;
    const sig = pie.nextSibling;
    pie.remove();
    const sin = await medir();
    padre.insertBefore(pie, sig);
    relleno.remove();
    body.scrollTop = 0;
    body.dispatchEvent(new Event('scroll'));
    return { conPie: con, sinPie: sin };
  })()`);
  ok('el cuerpo del inspector no esfuma abajo, con pie o sin él',
    fade && fade.conPie === '0px' && fade.sinPie === '0px', JSON.stringify(fade));

  /* ── 4-ter. El encabezado cierra con línea donde hay inspector ─────────────
     El panel es de otro plano y arranca con un borde duro justo debajo del
     encabezado; si la columna principal se esfuma arriba, el encabezado se ve
     derretido de un lado y sólido del otro. Por eso, con inspector, el
     encabezado trae su hairline SOLO y el scroll de la columna no esfuma
     arriba — la línea ya es el límite. Una vista simple lo pide con
     `head({ linea: true })`; sin pedirlo sigue esfumando, y eso también se
     comprueba: si no, el 0px de arriba podría ser un falso positivo.

     Mismo cuidado que en 4-bis: sin scroll REAL `is-top` apaga el fade por su
     cuenta, así que se fuerza contenido alto y una posición intermedia. */
  console.log('\n4-ter. El encabezado cierra con línea donde hay inspector');
  const medirFadeTop = (sel) => js(`(async () => {
    const sc = document.querySelector(${JSON.stringify(sel)});
    if (!sc) return null;
    const relleno = document.createElement('div');
    relleno.style.height = '1200px';
    sc.appendChild(relleno);
    sc.scrollTop = 200;
    sc.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 450));
    const out = { fadeTop: getComputedStyle(sc).getPropertyValue('--ox-fade-top').trim(), scrollea: sc.scrollHeight - sc.clientHeight > 1 };
    relleno.remove();
    sc.scrollTop = 0;
    sc.dispatchEvent(new Event('scroll'));
    return out;
  })()`);
  const sombraHead = () => js(`(() => { const h = document.querySelector('.ox-main > .ox-viewhead'); return h ? getComputedStyle(h).boxShadow : null; })()`);
  const conInspector = { sombra: await sombraHead(), fade: await medirFadeTop('.ox-viewbody__main > .ox-scroll') };
  ok('con inspector, el encabezado trae su línea sin pedirla',
    !!conInspector.sombra && conInspector.sombra !== 'none', JSON.stringify(conInspector));
  ok('y la columna principal no esfuma arriba',
    !!conInspector.fade && conInspector.fade.scrollea && conInspector.fade.fadeTop === '0px', JSON.stringify(conInspector));

  await click('[data-view="items"]');
  await sleep(600);
  const simple = { sombra: await sombraHead(), fade: await medirFadeTop('.ox-main > .ox-scroll') };
  ok('la vista simple, sin pedir línea, sigue esfumando arriba',
    simple.sombra === 'none' && !!simple.fade && simple.fade.scrollea && parseFloat(simple.fade.fadeTop) > 0, JSON.stringify(simple));
  await js(`document.querySelector('.ox-main > .ox-viewhead').classList.add('ox-viewhead--line'); true`);
  const pedida = { sombra: await sombraHead(), fade: await medirFadeTop('.ox-main > .ox-scroll') };
  ok('con la línea pedida, aparece y el esfumado de arriba se apaga',
    !!pedida.sombra && pedida.sombra !== 'none' && !!pedida.fade && pedida.fade.fadeTop === '0px', JSON.stringify(pedida));
  await js(`document.querySelector('.ox-main > .ox-viewhead').classList.remove('ox-viewhead--line'); true`);
  const apiHead = await js(`(async () => { const { head } = await import('./js/ui.js');
    return { con: head({ title: 'x', linea: true }).includes('ox-viewhead--line'), sin: head({ title: 'x' }).includes('ox-viewhead--line') }; })()`);
  ok('head({ linea: true }) pone la clase, y sin pedirla no', !!apiHead && apiHead.con && !apiHead.sin, JSON.stringify(apiHead));

  // De vuelta al detalle: lo que sigue abre su menú.
  ok('vuelve al detalle', await click(`[data-open="${id}"]`));
  await sleep(800);

  console.log('\n5. Overlays: dónde caen, no solo si existen');
  await click('[data-menu="item"]');
  await sleep(400);
  const menu = await js(`(() => { const m=document.querySelector('.ox-menu'); if(!m) return null;
    const r=m.getBoundingClientRect(); return {t:Math.round(r.top),l:Math.round(r.left),b:Math.round(r.bottom),rt:Math.round(r.right)}; })()`);
  ok('el menú abre dentro de la ventana',
    menu && menu.t >= 0 && menu.l >= 0 && menu.b <= H && menu.rt <= W, JSON.stringify(menu));

  /* ── El item peligroso se pinta entero, y en los tres estados ──────────────
     El ícono venía perdiendo por especificidad contra el resaltado: pasabas el
     mouse por Eliminar, el texto y el fondo se ponían rojos, y el tachito se
     quedaba gris —el ícono decía una cosa y el resto de la fila otra—. Con el
     resaltado del teclado se caía hasta el texto.

     Se mide comparando el ícono contra el color del PROPIO item, no contra un
     literal: lo que tiene que ser cierto es que digan lo mismo, sea cual sea el
     rojo del tema. Y aparte se exige que ese color SEA el token de peligro,
     porque «los dos grises» también empatan y no es lo que se quiere.

     Ojo con el cuándo: estas propiedades tienen transición declarada, así que
     leerlas apenas cambia el estado devuelve el valor de ARRANQUE y el chequeo
     da verde con el bug puesto. Cada lectura espera a que la transición
     termine; sin esa espera, esto no prueba nada. */
  const pintaDanger = async (estado) => {
    await sleep(500);
    return js(`(() => {
      const it = document.querySelector('.ox-menuitem--danger');
      if (!it) return null;
      const sonda = document.createElement('span');
      sonda.style.color = getComputedStyle(document.documentElement).getPropertyValue('--ox-danger');
      document.body.appendChild(sonda);
      const rojo = getComputedStyle(sonda).color;
      sonda.remove();
      return { estado: ${JSON.stringify(estado)}, rojo,
               texto: getComputedStyle(it).color,
               icono: getComputedStyle(it.querySelector('.ox-icon')).color };
    })()`);
  };
  const lejos = () => win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: H - 4 });
  const donde = await js(`(() => { const it=document.querySelector('.ox-menuitem--danger'); if(!it) return null;
    const r=it.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
  lejos();
  const reposo = await pintaDanger('en reposo');
  await js(`document.querySelector('.ox-menuitem--danger').classList.add('is-active'); true`);
  const teclado = await pintaDanger('resaltado por teclado');
  await js(`document.querySelector('.ox-menuitem--danger').classList.remove('is-active'); true`);
  await sleep(400);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: donde.x, y: donde.y });
  const mouse = await pintaDanger('con el mouse encima');
  lejos();
  for (const e of [reposo, teclado, mouse]) {
    ok(`Eliminar es de color peligro ${e?.estado}`, !!e && e.texto === e.rojo, JSON.stringify(e));
    ok(`y su tachito también ${e?.estado}`, !!e && e.icono === e.rojo, JSON.stringify(e));
  }
  await js(`document.body.click(); true`); await sleep(300);

  await click('#btn-palette');
  await sleep(500);
  const pal = await js(`(() => { const p=document.querySelector('.ox-palette'); if(!p) return null;
    const r=p.getBoundingClientRect(); return {t:Math.round(r.top),cx:Math.round(r.left+r.width/2)}; })()`);
  ok('la paleta abre centrada y visible', pal && pal.t > 0 && Math.abs(pal.cx - W / 2) < 4, JSON.stringify(pal));

  /* Y el campo vacío no promete cosas de otra app. Estuvo diciendo «Buscar
     comandos, pipelines, agentes…» —vocabulario de aquella para la que se
     escribió esta paleta— y viajó con la plantilla hasta un editor de química,
     donde ofrecía dos features que no existen. Un texto que solo se lee con el
     campo en blanco es de los que nadie vuelve a mirar: que lo mire esto. */
  const ph = await js(`document.querySelector('.ox-palette__input')?.placeholder || ''`);
  ok('con una pista en el campo vacío', ph.length > 3, ph);
  ok('y sin vocabulario prestado de otra app', !/pipeline|agente/i.test(ph), ph);

  await click('.ox-scrim'); await sleep(400);

  await click('[data-view="piezas"]');
  await sleep(900);
  await click('#demo-modal');
  await sleep(600);
  const modal = await js(`(() => { const m=document.querySelector('.ox-modal'); if(!m) return null;
    const r=m.getBoundingClientRect(); return {cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2),t:Math.round(r.top)}; })()`);
  ok('el modal queda CENTRADO en la ventana',
    modal && Math.abs(modal.cx - W / 2) < 4 && Math.abs(modal.cy - H / 2) < 4 && modal.t > 0, JSON.stringify(modal));
  await click('[data-dismiss]'); await sleep(400);

  // El toggle del menú. Volver a tocar el botón que lo abrió TIENE que cerrarlo.
  // Si no, se ve como un rebote: el manejador de click-afuera deja pasar al
  // ancla, el handler del botón vuelve a llamar a show(), y cierra+reabre en el
  // mismo gesto. Por eso acá va `tap` y no `click`: reproduce el orden real.
  const abierto = () => js(`!!document.querySelector('.ox-menu')`);
  await tap('#demo-select');
  await sleep(400);
  ok('el select abre su menú', await abierto());
  await tap('#demo-select');
  await sleep(500);
  ok('volver a tocarlo lo CIERRA (no rebota)', !(await abierto()));
  ok('y el ancla suelta el estado abierto', !(await js(`!!document.querySelector('#demo-select.is-open')`)));

  await tap('#demo-select');
  await sleep(400);
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
  await sleep(500);
  ok('y un click afuera también lo cierra', !(await abierto()));

  /* ── 5-bis. Escape con un menú abierto encima de un modal ──────────────────
     Modal y Menu escuchan los dos el keydown en `document` y en CAPTURA. Para
     el mismo nodo y la misma fase gana el que se registró primero, y ese es
     siempre el modal, que abrió antes. Resultado: desplegar un select adentro
     de un diálogo y arrepentirse con Escape cerraba el DIÁLOGO ENTERO y se
     perdía todo lo tipeado, en vez de cerrar solo el menú.

     Es un bug de orden de registro: no se ve leyendo ninguno de los dos módulos
     por separado —cada manejador, solo, es correcto— y vuelve apenas alguien
     reordene los overlays. Por eso se prueba acá y no en unidad: hace falta que
     los dos estén vivos al mismo tiempo.

     El modal de la vitrina no trae un select adentro, así que el escenario se
     arma: se abre el modal y se dispara el menú del select que quedó atrás. Que
     ese botón esté tapado por el scrim da igual — lo que se prueba es el estado
     «menú abierto encima de un modal», no dónde se puede clickear. */
  console.log('\n5-bis. Escape se lleva el menú, no el diálogo de atrás');
  await click('#demo-modal');
  await sleep(600);
  await click('#demo-select');
  await sleep(400);
  const hayModal = () => js(`!!document.querySelector('.ox-modal')`);
  ok('con el diálogo abierto, el menú abre encima', (await abierto()) && (await hayModal()));

  escape();
  await sleep(600);
  ok('el primer Escape cierra SOLO el menú', !(await abierto()));
  ok('y el diálogo sigue en pie', await hayModal());

  escape();
  await sleep(600);
  ok('el segundo Escape sí cierra el diálogo', !(await hayModal()));

  /* ── 6. El medidor indeterminado ───────────────────────────────────────────
     Una pista vacía se lee como un componente roto, no como «esperando». Se
     muestrea el recorrido entero en vez de mirar un instante.

     SE MIDE LA RACHA, NO LAS MUESTRAS SUELTAS, y la diferencia importa. La
     barra recorre de -100% a 294% de su propio ancho, así que en el empalme del
     bucle queda un frame exactamente al filo de la pista: medido con
     requestAnimationFrame sobre dos ciclos completos —226 frames— el solape
     mínimo es 0.43 px, aparece UNA vez y no se repite nunca dos frames
     seguidos. Es el diseño, y está escrito así arriba de la animación.

     La versión anterior exigía «más de 1 px SIEMPRE», lo que convertía ese
     frame invisible en una falla y dejaba el resultado librado a dónde cayera
     el muestreo. Lo que de verdad hay que prohibir es que la pista quede vacía
     un RATO —lo único que un ojo alcanza a ver— y eso es una racha. */
  console.log('\n6. El medidor indeterminado nunca deja la pista vacía');
  const pista = await js(`(async () => {
    const m = document.querySelector('.ox-meter--indeterminate');
    const f = m && m.querySelector('.ox-meter__fill');
    if (!f) return { error: 'no existe' };
    const muestras = [];
    for (let i = 0; i < 40; i++) {
      const p = m.getBoundingClientRect(); const r = f.getBoundingClientRect();
      muestras.push(Math.min(r.right, p.right) - Math.max(r.left, p.left));
      await new Promise(res => setTimeout(res, 50));
    }
    let racha = 0; let peor = 0;
    for (const v of muestras) { if (v < 1) { racha++; peor = Math.max(peor, racha); } else racha = 0; }
    return { peor, min: Math.round(Math.min(...muestras) * 100) / 100, n: muestras.length };
  })()`);
  ok('la barra nunca falta dos muestras seguidas',
    pista && !pista.error && pista.peor <= 1, JSON.stringify(pista));

  console.log('\n6-bis. El campo numérico y sus flechas');
  /* Lo que se mide no es que el botón exista: es que el VALOR cambie, que el
     evento salga (los listeners de las apps escuchan al input, no al botón), y
     que el spinner de Chromium no esté asomando por debajo. */
  const paso = await js(`(async () => {
    const root = document.getElementById('demo-stepper');
    if (!root) return { error: 'no existe el stepper' };
    const input = root.querySelector('input[type="number"]');
    const arriba = root.querySelector('[data-step="up"]');
    const abajo = root.querySelector('[data-step="down"]');

    let cambios = 0;
    input.addEventListener('change', () => cambios++);

    const tocar = (b) => {
      const o = { bubbles: true, pointerId: 1, pointerType: 'mouse' };
      b.dispatchEvent(new PointerEvent('pointerdown', o));
      b.dispatchEvent(new PointerEvent('pointerup', o));
    };

    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    tocar(arriba);
    const trasSubir = input.value;
    tocar(abajo); tocar(abajo);
    const trasBajar = input.value;

    // Al mínimo (1) la flecha de abajo tiene que quedar apagada.
    const abajoApagado = abajo.disabled;

    // Y al máximo (12), la de arriba.
    for (let i = 0; i < 20; i++) tocar(arriba);
    const tope = input.value;
    const arribaApagado = arriba.disabled;

    const spinner = getComputedStyle(input, '::-webkit-inner-spin-button');
    return {
      trasSubir, trasBajar, tope, cambios, abajoApagado, arribaApagado,
      spinnerOculto: spinner.appearance === 'none' || spinner.display === 'none',
      apariencia: getComputedStyle(input).appearance,
    };
  })()`);
  ok('subir suma uno', paso.trasSubir === '2', JSON.stringify(paso));
  ok('bajar no pasa del mínimo', paso.trasBajar === '1', paso.trasBajar);
  ok('y ahí la flecha de abajo se apaga', paso.abajoApagado === true);
  ok('no pasa del máximo', paso.tope === '12', paso.tope);
  ok('y ahí se apaga la de arriba', paso.arribaApagado === true);
  /* 1→2, 2→1 (el segundo click no mueve nada), y 11 subidas hasta 12. */
  ok('cada paso real despacha change', paso.cambios === 13, `${paso.cambios}`);
  ok('el input no muestra el control nativo', paso.apariencia === 'textfield', paso.apariencia);

  console.log('\n7. La fuente empaquetada carga de verdad');
  /* Éste es el chequeo que evita el fracaso silencioso: con CSP estricta y
     protocolo file://, un @font-face con la ruta mal puesta no tira error —
     el navegador cae a la de respaldo y todo "se ve bien". Por eso no alcanza
     con preguntar por --ox-mono: hay que confirmar que la familia cargó Y que
     realmente cambia el ancho del texto. */
  const fuente = await js(`(async () => {
    await document.fonts.ready;
    const cargadas = [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ':' + f.weight);
    const medir = (fam) => { const s = document.createElement('span');
      s.style.cssText = 'position:fixed;left:-9999px;font-size:64px;white-space:pre;font-family:' + fam;
      s.textContent = 'MMMiiilll0O1'; document.body.appendChild(s);
      const w = s.getBoundingClientRect().width; s.remove(); return Math.round(w); };
    return {
      cargadas,
      declarada: getComputedStyle(document.documentElement).getPropertyValue('--ox-mono').trim(),
      roboto: medir("'Roboto Mono'"), serif: medir('serif'),
      disponible: document.fonts.check('400 13px "Roboto Mono"'),
    };
  })()`);
  ok('el @font-face resolvió a archivos reales', fuente.cargadas.length > 0, JSON.stringify(fuente.cargadas));
  ok('Roboto Mono está disponible para pintar', fuente.disponible, JSON.stringify(fuente));
  ok('y NO está cayendo a la de respaldo', fuente.roboto !== fuente.serif, `roboto=${fuente.roboto} serif=${fuente.serif}`);
  // Ojo: getComputedStyle RESUELVE el var(), así que acá se ve la familia final
  // y no la indirección. Que --ox-mono apunte a un token se verifica sobre el
  // texto del CSS, en tokens.test.mjs.
  ok('la familia efectiva es la empaquetada', fuente.declarada.includes('Roboto Mono'), fuente.declarada);

  const monos = await js(`document.querySelectorAll('#knob-mono [data-mono]').length`);
  ok('la vitrina descubrió las monos declaradas', monos >= 2, `${monos}`);
  const antesMono = await js(`getComputedStyle(document.querySelector('#mono-sample')).fontFamily`);
  await click('#knob-mono [data-mono="sistema"]');
  await sleep(300);
  ok('cambiar la mono cambia lo que se pinta',
    (await js(`getComputedStyle(document.querySelector('#mono-sample')).fontFamily`)) !== antesMono);

  console.log('\n8. Las perillas re-tintan de verdad');
  const antes = await js(`getComputedStyle(document.body).backgroundColor`);
  await js(`(() => { const h=document.getElementById('knob-hue'); h.value=30; h.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(300);
  ok('cambiar el matiz cambia el fondo', (await js(`getComputedStyle(document.body).backgroundColor`)) !== antes);
  await click('#knob-reset');
  await sleep(300);
  ok('el reset vuelve al original', (await js(`getComputedStyle(document.body).backgroundColor`)) === antes);

  /* El color que el renderer le manda a la ventana.
     Va acá y no en tokens.test.mjs porque ese test compara ARCHIVOS: verifica
     que el hex de main.cjs derive del token. Este mide lo que pasa en tiempo
     de ejecución, que es otra cosa y es donde estuvo el bug — el renderer
     pisaba el backgroundColor correcto con uno mal traducido. */
  console.log('\n8-bis. El color que va a la ventana');
  const colorVentana = await js(`(async () => {
    const { colorToken, aHex } = await import('./js/ui.js');
    const computado = (() => {
      const p = document.createElement('span');
      p.style.cssText = 'position:fixed;left:-9999px;color:var(--ox-bg)';
      document.body.appendChild(p);
      const c = getComputedStyle(p).color;
      p.remove();
      return c;
    })();
    return {
      computado,
      hex: colorToken('--ox-bg'),
      // El regex viejo, para dejar constancia de qué habría devuelto.
      conRegexViejo: (() => {
        const n = computado.match(/[0-9]+/g);
        return n ? '#' + n.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('') : null;
      })(),
      // aHex tiene que dar lo mismo pase lo que pase por la notación.
      desdeRgb: aHex('rgb(10, 11, 13)'),
      desdeHex: aHex('#0a0b0d'),
    };
  })()`);
  ok('el token resuelve a un hex de 6 dígitos',
    /^#[0-9a-f]{6}$/i.test(colorVentana.hex || ''), JSON.stringify(colorVentana));
  ok('coincide con el backgroundColor de main.cjs',
    colorVentana.hex.toLowerCase() === BG_MAIN, `${colorVentana.hex} vs ${BG_MAIN}`);
  /* La red de seguridad de verdad: que el fondo NO sea un color saturado. El
     bug daba #009500 —un hex perfectamente válido— así que validar la FORMA no
     alcanza; hay que mirar el color. */
  ok('y no es un verde/magenta salido de parsear mal el oklch', (() => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(colorVentana.hex.slice(i, i + 2), 16));
    return Math.max(r, g, b) - Math.min(r, g, b) < 40;
  })(), `${colorVentana.hex} (el regex viejo daba ${colorVentana.conRegexViejo})`);
  ok('aHex normaliza cualquier notación',
    colorVentana.desdeRgb === '#0a0b0d' && colorVentana.desdeHex === '#0a0b0d',
    JSON.stringify(colorVentana));

  /* ── Botones de solo ícono ─────────────────────────────────────────────────
     Un botón que solo lleva un SVG tiene que tenerlo centrado. Suena obvio y no
     lo era: Chromium le da `padding: 1px 6px` a todo `<button>` y este reset no
     lo tocaba. En los controles chicos eso deja la caja de contenido más
     angosta que el ícono; el ícono desborda, y un ítem de grid que desborda su
     área cae de `center` a `start`. El tilde del `.ox-check` salía 4px a la
     derecha y recortado contra el borde; el `.ox-iconbtn`, 1,5px — invisible de
     a uno y repetido en la titlebar, el rail y cada fila.

     Corre sobre Piezas, que es donde están todos los primitivos juntos. */
  console.log('\n8-ter. Los botones de solo ícono centran su contenido');
  const descentrados = await js(`(() => {
    const malos = [];
    for (const b of document.querySelectorAll('button')) {
      // Solo ícono: un único hijo elemento, que es un svg, y sin texto.
      if (b.children.length !== 1 || b.textContent.trim()) continue;
      const hijo = b.firstElementChild;
      if (hijo.tagName.toLowerCase() !== 'svg') continue;
      const rb = b.getBoundingClientRect();
      const rh = hijo.getBoundingClientRect();
      if (!rb.width || !rh.width) continue;
      const d = ((rh.left + rh.right) / 2) - ((rb.left + rb.right) / 2);
      const desborda = rh.right > rb.right + 0.5 || rh.left < rb.left - 0.5;
      if (Math.abs(d) > 0.51 || desborda) {
        malos.push({ clase: b.className.slice(0, 34), corrimiento: +d.toFixed(2), desborda });
      }
    }
    return { malos, revisados: [...document.querySelectorAll('button')].length };
  })()`);
  ok('ninguno tiene el ícono corrido ni desbordado',
    descentrados.malos.length === 0, JSON.stringify(descentrados.malos));
  ok('y había botones que revisar', descentrados.revisados > 10, `${descentrados.revisados}`);

  /* ── La tarjeta sin encabezado ──────────────────────────────────────────────
     `.ox-card__body` llevaba `padding-top: 0` para no repetir el aire que el
     `__head` ya pone. Con head quedaba perfecto; SIN head el contenido se
     pegaba al borde de arriba — 0 px contra 16 abajo.

     Vivió tanto porque esta misma vitrina mostraba UNA tarjeta y con `padding`
     inline: el único lugar que existe para ver las piezas era el único donde la
     pieza rota no se veía. */
  console.log('\n8-quater. Las dos formas de la tarjeta');

  const tarjetas = await js(`(() => [...document.querySelectorAll('.ox-card__body')].map((b) => {
    const s = getComputedStyle(b);
    const head = b.previousElementSibling?.classList.contains('ox-card__head');
    const arriba = b.getBoundingClientRect().top - b.closest('.ox-card').getBoundingClientRect().top;
    return {
      head: !!head,
      top: parseFloat(s.paddingTop),
      bottom: parseFloat(s.paddingBottom),
      // Lo que de verdad separa al contenido del filo: el padding del cuerpo
      // MÁS lo que haya arriba de él.
      aire: +(arriba + parseFloat(s.paddingTop)).toFixed(1),
    };
  }))()`);

  const sinHead = tarjetas.filter((t) => !t.head);
  const conHead = tarjetas.filter((t) => t.head);

  ok('la vitrina muestra las dos formas', sinHead.length > 0 && conHead.length > 0,
    JSON.stringify(tarjetas));
  ok('sin encabezado, el cuerpo pone su propio aire arriba',
    sinHead.every((t) => t.top > 0 && t.top === t.bottom), JSON.stringify(sinHead));
  /* Y el arreglo NO puede romper el caso que ya estaba bien: con head, repetir
     el padding separaría el cuerpo de su propio título. */
  ok('con encabezado, el cuerpo NO lo repite', conHead.every((t) => t.top === 0),
    JSON.stringify(conHead));
  ok('pero el contenido igual queda separado del filo',
    tarjetas.every((t) => t.aire >= 12), JSON.stringify(tarjetas.map((t) => t.aire)));

  /* ── 8-quinquies. Las columnas numéricas alinean su título con sus cifras ──
     `.ox-table th` trae text-align:left con especificidad (0,1,1) y le gana a
     `.ox-td--num`, que pide right con (0,1,0). Sin la regla que lo corrige, un
     <th> marcado como numérico se queda a la izquierda mientras sus celdas van
     a la derecha, y la columna se lee corrida: los valores no caen debajo de
     su propio título. Nada parece roto, solo raro.

     Salió de una app con una tabla de precios de cuatro columnas numéricas,
     donde el desfase se midió en 82px. Acá hay una sola columna así, que
     alcanza para que el defecto no vuelva a entrar.

     Se mide el borde derecho del TEXTO con un Range y no el de la celda: el de
     la celda abarca la columna entera y daría el mismo número estuviera el
     texto donde estuviera — justo el defecto que se busca. */
  console.log('\n8-quinquies. Las columnas numéricas de la tabla');
  const columnas = await js(`(() => {
    const t = document.querySelector('.ox-table');
    if (!t) return { error: 'no hay tabla en la vitrina' };
    const fila = t.querySelector('tbody tr');
    if (!fila) return { error: 'la tabla no tiene filas' };
    const ths = [...t.querySelectorAll('thead th')];
    const tds = [...fila.querySelectorAll('td')];
    const derecha = (el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return Math.round(r.getBoundingClientRect().right);
    };
    return ths.map((th, i) => (th.classList.contains('ox-td--num') && tds[i]
      ? {
          col: th.textContent.trim(),
          align: getComputedStyle(th).textAlign,
          d: Math.abs(derecha(th) - derecha(tds[i])),
        }
      : null)).filter(Boolean);
  })()`);
  ok('había una columna numérica que medir',
    Array.isArray(columnas) && columnas.length > 0, JSON.stringify(columnas));
  ok('su título cae sobre sus cifras',
    Array.isArray(columnas) && columnas.length > 0 && columnas.every((c) => c.d <= 2),
    JSON.stringify(columnas));

  /* ── La cápsula del segmentado cae SOBRE su opción ─────────────────────────
     Se compara el centro del texto (un Range, no la celda) con el centro de la
     cápsula (el ::before). El bug que caza: en una celda de tabla las opciones
     no medían lo mismo y la cápsula, calculada como ancho/n, caía 10px corrida
     — el texto parecía descentrado. La vitrina tiene el segmentado en un flex;
     el caso de la tabla se arma acá mismo, con dos opciones de distinto largo,
     cableado con el mismo bindSwitcher que usa la app. */
  console.log('\n8-sexies. La cápsula del segmentado cae sobre su opción');
  const capsula = (sel) => js(`(() => {
    const seg = document.querySelector(${JSON.stringify(sel)});
    if (!seg) return null;
    const s = seg.getBoundingClientRect();
    const cs = getComputedStyle(seg, '::before');
    const x = new DOMMatrixReadOnly(cs.transform).m41 + parseFloat(cs.left);
    const centroCapsula = x + parseFloat(cs.width) / 2;
    const act = seg.querySelector('.ox-segmented__opt.is-active');
    const r = document.createRange(); r.selectNodeContents(act);
    const t = r.getBoundingClientRect();
    const centroTexto = (t.left + t.right) / 2 - s.left;
    const anchos = [...seg.querySelectorAll('.ox-segmented__opt')].map((o) => +o.getBoundingClientRect().width.toFixed(1));
    return { txt: act.textContent.trim(), desfase: +Math.abs(centroCapsula - centroTexto).toFixed(2), anchos };
  })()`);
  let cap = await capsula('#demo-seg');
  ok('en el flex de la vitrina, centrada sobre la activa', cap && cap.desfase <= 1, JSON.stringify(cap));
  await click('#demo-seg [data-value="c"]');
  await sleep(500);
  cap = await capsula('#demo-seg');
  ok('y sigue centrada después de viajar', cap && cap.txt === 'Tabla' && cap.desfase <= 1, JSON.stringify(cap));

  await js(`(async () => {
    const { bindSwitcher } = await import('./js/motion.js');
    const t = document.createElement('table');
    t.className = 'ox-table'; t.id = 'seg-en-tabla';
    t.innerHTML = '<tbody><tr class="ox-tr"><td>fila</td><td class="ox-td--tight">'
      + '<div class="ox-segmented" id="seg-tabla">'
      + '<button class="ox-segmented__opt is-active" data-value="a">Descendente</button>'
      + '<button class="ox-segmented__opt" data-value="b">Asc</button>'
      + '</div></td></tr></tbody>';
    document.querySelector('.ox-table').after(t);
    bindSwitcher(t.querySelector('#seg-tabla'), () => {});
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return true;
  })()`);
  await sleep(300);
  cap = await capsula('#seg-tabla');
  ok('en una celda de tabla las opciones miden lo mismo',
    cap && cap.anchos.length === 2 && Math.abs(cap.anchos[0] - cap.anchos[1]) <= 0.5, JSON.stringify(cap));
  ok('y la cápsula cae centrada sobre la larga', cap && cap.txt === 'Descendente' && cap.desfase <= 1, JSON.stringify(cap));
  await click('#seg-tabla [data-value="b"]');
  await sleep(500);
  cap = await capsula('#seg-tabla');
  ok('y sobre la corta', cap && cap.txt === 'Asc' && cap.desfase <= 1, JSON.stringify(cap));
  await js(`(() => { document.getElementById('seg-en-tabla')?.remove(); return true; })()`);

  /* ── El estado vacío no agranda el ícono de su botón ───────────────────────
     `.ox-empty .ox-icon` (descendiente) le daba 34px también al ícono de un
     botón de acción dentro del empty(); ahora es solo el hijo directo. */
  console.log('\n8-septies. El estado vacío no agranda el ícono de su botón');
  const vacio = await js(`(async () => {
    const { empty } = await import('./js/ui.js');
    const { Icons } = await import('./js/icons.js');
    const caja = document.createElement('div');
    caja.id = 'vacio-prueba';
    caja.innerHTML = empty({ icon: 'inbox', title: 'Nada', text: 'Todavía',
      actions: '<button class="ox-btn ox-btn--secondary">' + Icons.svg('search') + ' Ir a buscar</button>' });
    document.querySelector('.ox-table').after(caja);
    const grande = caja.querySelector('.ox-empty > .ox-icon').getBoundingClientRect().width;
    const chico = caja.querySelector('.ox-btn .ox-icon').getBoundingClientRect().width;
    caja.remove();
    return { grande, chico };
  })()`);
  ok('el ícono del vacío es el grande', vacio && vacio.grande === 34, JSON.stringify(vacio));
  ok('y el del botón es el de un botón', vacio && vacio.chico === 14, JSON.stringify(vacio));

  /* ── El encabezado de la tabla es del color de donde está ──────────────────
     El <th> es sticky y por eso opaco. Pintaba --ox-bg fijo, y dentro de una
     card —donde vive la tabla en las apps que salieron de acá— quedaba una
     banda más oscura que sus propias filas. Ahora lee --ox-surface, que declara
     cada plano en el renglón donde pinta su fondo. Se mide en los dos
     hospedadores: la tabla de la vitrina, sobre la vista, y un clon dentro de
     una card que se arma acá y se saca al final. Y se comprueba que los dos
     planos sean distintos: si fueran iguales, la prueba no distinguiría nada. */
  console.log('\n8-octies. El encabezado de la tabla es del color de donde está');
  const fondos = await js(`(() => {
    const t = document.querySelector('.ox-table');
    if (!t) return { error: 'no hay tabla en la vitrina' };
    const bg = (el) => getComputedStyle(el).backgroundColor;
    const card = document.createElement('div');
    card.className = 'ox-card';
    card.appendChild(t.cloneNode(true));
    t.after(card);
    const out = {
      vista: { th: bg(t.querySelector('th')), plano: bg(document.querySelector('.ox-main')) },
      card: { th: bg(card.querySelector('th')), plano: bg(card) },
    };
    card.remove();
    return out;
  })()`);
  ok('sobre la vista, el th pinta el fondo de la vista',
    fondos.vista && fondos.vista.th === fondos.vista.plano, JSON.stringify(fondos));
  ok('dentro de una card, el th pinta la card',
    fondos.card && fondos.card.th === fondos.card.plano, JSON.stringify(fondos));
  ok('y los dos planos son distintos entre sí',
    fondos.vista && fondos.card && fondos.vista.plano !== fondos.card.plano, JSON.stringify(fondos));

  console.log('\n8-nonies. Las acciones de fila no se quedan pegadas al clic');
  // La fila es un botón con tabindex: un clic de mouse la deja enfocada. Con
  // :focus-within, las .ox-rowactions quedaban a la vista en la última fila
  // clickeada aunque el mouse ya se hubiera ido. Con el teclado, en cambio,
  // SÍ tienen que verse. Va con eventos de mouse de verdad (el click() de
  // arriba es sintético y no mueve el foco). :focus solo aplica con la
  // ventana activa, por eso el control positivo con Tab: si el foco lo tiene
  // otra ventana, falla ese y no pasa nada de casualidad.
  await click('[data-view="piezas"]');
  await sleep(400);
  win.focus();
  const puntero = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), ...extra });
  const tecla = (keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); };
  const fila = await js(`(() => {
    const it = [...document.querySelectorAll('#design-scroll .ox-listitem')].find(x => x.querySelector('.ox-rowactions'));
    if (!it) return null;
    it.scrollIntoView({ block: 'center' }); it.id = 'test-fila';
    const r = it.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  ok('la vitrina tiene una fila con acciones, dentro de la ventana', fila && fila.y > 0 && fila.y + fila.h < H, JSON.stringify(fila));
  const acciones = () => js(`Number(getComputedStyle(document.querySelector('#test-fila .ox-rowactions')).opacity)`);
  const enfocado = () => js(`document.activeElement?.className || ''`);
  const sobreFila = [fila.x + 40, fila.y + fila.h / 2];   // sobre la marca de estado, lejos de las acciones
  await puntero('mouseMove', ...sobreFila);
  await sleep(400);
  ok('con el mouse encima se ven', (await acciones()) === 1, `opacity=${await acciones()}`);
  await puntero('mouseDown', ...sobreFila, { button: 'left', clickCount: 1 });
  await puntero('mouseUp', ...sobreFila, { button: 'left', clickCount: 1 });
  await sleep(300);
  ok('el clic de mouse deja la fila enfocada', /ox-listitem/.test(await enfocado()), await enfocado());
  const cabecera = await js(`(() => { const r = document.querySelector('.ox-viewhead').getBoundingClientRect(); return { cx: r.left + r.width / 2, y: r.top + 8 }; })()`);
  await puntero('mouseMove', cabecera.cx, cabecera.y);
  await sleep(450);
  ok('al irse el mouse se esfuman, aunque la fila siga enfocada', (await acciones()) === 0 && /ox-listitem/.test(await enfocado()), `opacity=${await acciones()} foco=${await enfocado()}`);
  tecla('Tab');
  await sleep(400);
  ok('Tab entra a la primera acción y vuelven (foco de teclado adentro)', /ox-iconbtn/.test(await enfocado()) && (await acciones()) === 1, `opacity=${await acciones()} foco=${await enfocado()}`);
  tecla('Tab', ['shift']);
  await sleep(400);
  ok('Shift+Tab vuelve a la fila y siguen a la vista (foco de teclado en la fila)', /ox-listitem/.test(await enfocado()) && (await acciones()) === 1, `opacity=${await acciones()} foco=${await enfocado()}`);
  await js(`document.activeElement?.blur(); document.getElementById('test-fila')?.removeAttribute('id'); true`);
  await sleep(300);

  console.log('\n9. Las reglas de oro');
  const glifos = await js(`(() => {
    const malo = /[\\u2190-\\u21FF\\u2300-\\u23FF\\u25A0-\\u27BF\\u2B00-\\u2BFF\\uFE0F\\u{1F300}-\\u{1FAFF}]/u;
    const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) if (malo.test(n.nodeValue)) out.push(n.nodeValue.trim().slice(0, 40));
    return out;
  })()`);
  ok('cero emojis y glifos unicode en la UI', glifos.length === 0, JSON.stringify(glifos));
  ok('cero title= nativo', (await js(`document.querySelectorAll('[title]').length`)) === 0);
  const reglas = await js(`(() => { const r = [...document.styleSheets].flatMap(ss => { try { return [...ss.cssRules] } catch { return [] } })
      .map(x => x.selectorText).filter(Boolean).join(' ');
    return { scrollbar: r.includes('::-webkit-scrollbar'), seleccion: r.includes('::selection'), focus: r.includes(':focus-visible') }; })()`);
  ok('scrollbar propia', reglas.scrollbar);
  ok('::selection propia', reglas.seleccion);
  ok('focus ring propio (:focus-visible)', reglas.focus);

  // El test no puede dejar basura en los datos.
  if (id) await js(`window.onyx.col('items').remove(${JSON.stringify(id)})`);
  await js(`window.onyx.settings.save({ densidad:'comoda' })`);

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  console.log(errores.length ? `CONSOLA:\n  ${errores.join('\n  ')}` : 'CONSOLA: limpia');
  app.exit(fail || errores.length ? 1 : 0);
});
