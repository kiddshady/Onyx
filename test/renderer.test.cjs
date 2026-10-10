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
  // Enter entero: keyDown, el char (es el que activa un botón enfocado) y keyUp.
  const enter = () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  };
  /* Lo que se VE en un rectángulo de la ventana: el brillo medio y cuánto
     varía (el desvío). Una foto de lo que pintó Chromium, no del DOM: un
     z-index que se escapa o un vidrio que no esmerila solo se ven acá. */
  const brillo = async (r) => {
    const img = await win.webContents.capturePage({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
    const { width, height } = img.getSize();
    const bm = img.toBitmap();   // BGRA
    let s = 0; let s2 = 0;
    for (let i = 0; i < width * height; i++) {
      const l = 0.2126 * bm[i * 4 + 2] + 0.7152 * bm[i * 4 + 1] + 0.0722 * bm[i * 4];
      s += l; s2 += l * l;
    }
    const n = width * height; const media = s / n;
    return { media: +media.toFixed(1), desvio: +Math.sqrt(Math.max(0, s2 / n - media * media)).toFixed(1) };
  };

  console.log('\n1. Arranque');
  ok('el splash se fue', !(await js(`!!document.getElementById('boot-splash')`)));
  ok('el shell está montado', await js(`!!document.querySelector('.ox-titlebar') && !!document.querySelector('.ox-rail')`));
  ok('los <i data-icon> se reemplazaron por SVG', !(await js(`!!document.querySelector('i[data-icon]')`)));
  ok('la vista inicial pintó algo', (await js(`document.getElementById('view').children.length`)) > 0);
  /* Los contadores del chrome nacen vacíos en el HTML: el primer dato no es un
     cambio. Con un «0» de relleno, numero() lo tomaba como cambio y quedaban
     teñidos de acento mientras se iba el splash (Finway 0.8.5). */
  ok('los contadores del chrome no destellan al arrancar',
    await js(`!document.querySelector('.ox-titlebar .ox-ticked, .ox-rail .ox-ticked, .ox-statusbar .ox-ticked')
      && document.querySelector('.ox-navitem__count').textContent !== ''`));

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

  /* Lo que va de borde a borde se queda sin la sangría. `.ox-bleed` era una
     regla aparte que pisaba el padding, y con (0,1,0) contra (0,3,0) no le
     ganaba nunca: en Quire el lector quedaba con 24 px de más a cada lado. Y
     un __main de borde a borde no estira su .ox-scroll hasta afuera. */
  const bleed = await js(`(() => {
    const view = document.getElementById('view');
    const a = document.createElement('div'); a.className = 'ox-bleed';
    const b = document.createElement('div'); b.className = 'ox-viewbody';
    b.innerHTML = '<div class="ox-viewbody__main ox-viewbody__main--bleed"><div class="ox-scroll"></div></div>';
    const c = document.createElement('div');
    view.append(a, b, c);
    const r = {
      bleed: getComputedStyle(a).paddingLeft,
      mainBleed: getComputedStyle(b.firstChild).paddingLeft,
      scrollEnBleed: getComputedStyle(b.querySelector('.ox-scroll')).marginRight,
      comun: getComputedStyle(c).paddingLeft,
    };
    a.remove(); b.remove(); c.remove();
    return r;
  })()`);
  ok('.ox-bleed se queda sin la sangría', bleed.bleed === '0px' && bleed.comun === '24px', JSON.stringify(bleed));
  ok('un __main de borde a borde no estira su scroll por fuera', bleed.mainBleed === '0px' && bleed.scrollEnBleed === '0px', JSON.stringify(bleed));

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

  /* 4-quater. El esfumado no tapa la scrollbar. Al llegar arriba, el fade tarda
     --ox-t-3 en retirarse, y con la máscara sobre la caja entera la punta del
     thumb quedaba esfumada ese rato y aparecía después (Nexus, como la bóveda de
     Prism). Se congela el fade prendido con el scroll arriba y se mide en
     píxeles: la punta del thumb tiene que brillar igual que su medio. */
  console.log('\n4-quater. El esfumado no tapa la scrollbar');
  const sbCaja = await js(`(() => {
    const st = document.createElement('style');
    st.id = 'sb-test-st';
    st.textContent = '#sb-test::-webkit-scrollbar-thumb { background-color: #fff; }';
    document.head.append(st);
    const sc = document.createElement('div');
    sc.id = 'sb-test';
    sc.className = 'ox-scroll';
    sc.style.cssText = 'position:fixed;left:60px;top:200px;width:240px;height:200px;z-index:900;'
      + 'background:#000;transition:none;--ox-fade:20px;--ox-fade-top:20px;--ox-fade-bottom:20px';
    sc.innerHTML = '<div style="height:900px"></div>';
    document.body.append(sc);
    sc.scrollTop = 0;
    const r = sc.getBoundingClientRect();
    return { x: r.right, y: r.top };
  })()`);
  await sleep(300);
  // El thumb vive en los 10 px de la derecha, con 3 px de borde transparente.
  const sbPunta = await brillo({ x: sbCaja.x - 6, y: sbCaja.y + 4, width: 2, height: 12 });
  const sbMedio = await brillo({ x: sbCaja.x - 6, y: sbCaja.y + 26, width: 2, height: 12 });
  await js(`document.getElementById('sb-test')?.remove(); document.getElementById('sb-test-st')?.remove(); true`);
  ok('con el fade prendido, la punta del thumb se ve entera',
    sbMedio.media > 150 && sbPunta.media > sbMedio.media * 0.9, JSON.stringify({ sbPunta, sbMedio }));

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

  /* ── 5-ter. El modal arranca en su campo, y Enter aplica (U5) ─────────────
     Sin `autofocus`, el foco iba al primer botón o campo del modal, que en
     orden es la cruz del encabezado: lo que se tipeaba no entraba a ningún
     lado, y Enter en el campo no hacía nada (el rango de Imprimir de Quire,
     ux-06 e imprimir-16). Y la confirmación destructiva arrancaba con el foco
     en el botón rojo: un Enter por reflejo borraba (ux-09). Todo por el
     camino real: el modal lo abre un botón, y las teclas van por
     sendInputEvent. Si el Enter no se frenara, le llegaría como click al
     botón que abrió el modal (recupera el foco al cerrarse) y lo reabriría. */
  console.log('\n5-ter. El modal arranca en su campo, y Enter aplica');
  win.focus();
  win.webContents.focus();
  await sleep(150);
  const estadoModal = () => js(`(async () => {
    const { Modal } = await import('./js/overlays.js');
    const a = document.activeElement;
    return { abierto: Modal.isOpen === true, res: window.__res, foco: a?.id || a?.textContent.trim() || null,
      cruz: !!a?.matches('[data-dismiss]'), sel: a?.tagName === 'INPUT' ? [a.selectionStart, a.selectionEnd] : null,
      clicks: window.__clicks, modales: document.querySelectorAll('.ox-modal__anim:not([data-state])').length };
  })()`);
  await js(`(async () => {
    const { Modal } = await import('./js/overlays.js');
    const b = document.createElement('button');
    b.id = 'm-abre'; b.textContent = 'Renombrar';
    b.style.cssText = 'position:fixed;left:40px;top:40px;z-index:50';
    window.__clicks = 0; window.__res = 'pendiente';
    b.addEventListener('click', () => {
      window.__clicks++;
      Modal.show({ title: 'Renombrar', body: '<div class="ox-field"><input class="ox-input" id="m-nombre" value="viejo"></div>',
        actions: [{ label: 'Cancelar', value: null }, { label: 'Guardar', value: 'guardado', variant: 'primary' }] })
        .then((v) => { window.__res = v; });
    });
    document.body.append(b);
    b.focus(); b.click();
    return true;
  })()`);
  await sleep(250);
  const mAbierto = await estadoModal();
  ok('sin autofocus, el foco arranca en el campo (no en la cruz) y con el texto elegido',
    mAbierto.abierto && mAbierto.foco === 'm-nombre' && !mAbierto.cruz && mAbierto.sel?.[0] === 0 && mAbierto.sel?.[1] === 5, JSON.stringify(mAbierto));
  enter();
  await sleep(450);
  const mEnter = await estadoModal();
  ok('Enter en el campo resuelve con la acción primaria', mEnter.res === 'guardado' && !mEnter.abierto, JSON.stringify(mEnter));
  ok('y no le llega como click al botón que abrió el modal (no se reabre)', mEnter.clicks === 1 && mEnter.modales === 0, JSON.stringify(mEnter));

  // Con la primaria apagada (una vista que valida), Enter no hace nada. Y con
  // solo una roja, tampoco: lo que no tiene vuelta atrás no sale de un Enter.
  const conEnter = async (acciones, apagar) => {
    await js(`(async () => {
      const { Modal } = await import('./js/overlays.js');
      window.__res = 'pendiente';
      Modal.show({ title: 'Prueba', body: '<input class="ox-input" id="m-campo">', actions: ${acciones} }).then((v) => { window.__res = v; });
      return true;
    })()`);
    await sleep(250);
    if (apagar) await js(`document.querySelector('.ox-modal__anim:not([data-state]) .ox-btn--primary').disabled = true; true`);
    enter();
    await sleep(300);
    const r = await estadoModal();
    await js(`(async () => { (await import('./js/overlays.js')).Modal.close(null); return true; })()`);
    await sleep(400);
    return r;
  };
  const mApagada = await conEnter(`[{ label: 'Cancelar', value: null }, { label: 'Aplicar', value: 'aplicado', variant: 'primary' }]`, true);
  ok('con la primaria deshabilitada, Enter no resuelve', mApagada.abierto && mApagada.res === 'pendiente' && mApagada.foco === 'm-campo', JSON.stringify(mApagada));
  const mRoja = await conEnter(`[{ label: 'Cancelar', value: null }, { label: 'Borrar', value: 'borrado', variant: 'danger-solid' }]`, false);
  ok('con solo una acción roja, Enter tampoco', mRoja.abierto && mRoja.res === 'pendiente', JSON.stringify(mRoja));

  // Sin campos: la acción primaria, nunca la cruz.
  await js(`(async () => { const { Modal } = await import('./js/overlays.js');
    Modal.show({ title: 'Aviso', sub: 'Sin campos', actions: [{ label: 'Cerrar', value: null }, { label: 'Aceptar', value: true, variant: 'primary' }] }); return true; })()`);
  await sleep(250);
  const mSinCampo = await estadoModal();
  await js(`(async () => { (await import('./js/overlays.js')).Modal.close(null); return true; })()`);
  await sleep(400);
  ok('sin campos, el foco va a la acción primaria', mSinCampo.foco === 'Aceptar' && !mSinCampo.cruz, JSON.stringify(mSinCampo));

  // confirm({ danger }): arranca en Cancelar, y un Enter por reflejo cancela.
  await js(`(async () => { const { Modal } = await import('./js/overlays.js'); window.__res = 'pendiente';
    Modal.confirm({ title: '¿Borrar todo?', confirmLabel: 'Borrar todo', danger: true }).then((v) => { window.__res = v; }); return true; })()`);
  await sleep(250);
  const mPeligro = await estadoModal();
  enter();
  await sleep(450);
  const mPeligroEnter = await estadoModal();
  ok('confirm({ danger }) arranca con el foco en Cancelar', mPeligro.foco === 'Cancelar', JSON.stringify(mPeligro));
  ok('y un Enter por reflejo cancela', mPeligroEnter.res === false && !mPeligroEnter.abierto, JSON.stringify(mPeligroEnter));
  ok('Modal.isOpen dice si hay un modal abierto', mPeligro.abierto && !mPeligroEnter.abierto, JSON.stringify({ mPeligro, mPeligroEnter }));
  await js(`document.getElementById('m-abre')?.remove(); true`);

  /* ── 5-quater. El hint de un ítem de menú se ve (U6) ──────────────────────
     Menu.show dibujaba label, ícono, atajo y tilde, y tiraba el `hint`: tres
     menús de Quire lo mandaban (el papel con sus medidas, las impresoras con
     «del sistema») y no se veía (ux-07). Se mide que esté, que entre en su
     fila sin pisar el nombre, y que vaya atenuado. */
  console.log('\n5-quater. El hint de un ítem de menú se ve');
  const hint = await js(`(async () => {
    const { Menu } = await import('./js/overlays.js');
    const ancla = document.createElement('button');
    ancla.textContent = 'Papel';
    ancla.style.cssText = 'position:fixed;left:40px;top:40px;z-index:50';
    document.body.append(ancla);
    Menu.show(ancla, [{ label: 'A4', hint: '210 × 297 mm', selected: true }, { label: 'Carta', hint: '216 × 279 mm', key: 'Ctrl 1' }]);
    await new Promise((r) => setTimeout(r, 300));
    const tenue = (() => { const s = document.createElement('span'); s.style.color = 'var(--ox-text-4)'; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; })();
    const filas = [...document.querySelectorAll('.ox-menu:not([data-state]) .ox-menuitem')].map((it) => {
      const h = it.querySelector('.ox-menuitem__hint');
      if (!h) return null;
      const ri = it.getBoundingClientRect(); const rh = h.getBoundingClientRect(); const rl = it.querySelector('.ox-truncate').getBoundingClientRect();
      const k = it.querySelector('.ox-menuitem__key')?.getBoundingClientRect();
      return { texto: h.textContent, ancho: Math.round(rh.width), adentro: rh.left >= ri.left && rh.right <= ri.right + 0.5 && rh.top >= ri.top && rh.bottom <= ri.bottom + 0.5,
        noPisa: rh.left >= rl.right - 0.5 && (!k || k.left >= rh.right - 0.5), color: getComputedStyle(h).color };
    });
    Menu.close(true);
    ancla.remove();
    return { tenue, filas };
  })()`);
  ok('el hint de cada ítem se ve, entra en su fila y no pisa el nombre ni el atajo',
    hint.filas.length === 2 && hint.filas.every((f) => f && f.ancho > 20 && f.adentro && f.noPisa) && hint.filas[0].texto === '210 × 297 mm',
    JSON.stringify(hint));
  ok('y va atenuado (--ox-text-4)', hint.filas.every((f) => f && f.color === hint.tenue), JSON.stringify(hint));

  /* ── 5-quinquies. Un modal abierto encima de otro ───────────────────────────
     El de abajo quedaba huérfano: su promesa no se resolvía nunca, y su velo y
     su caja se quedaban en el DOM (Quire, 2F). Ahora se contesta con null y
     sale con su exit(), y el velo lo hereda el nuevo: con dos velos a .62 (uno
     saliendo y otro entrando) la pantalla se oscurecía en el medio del
     cambio. Se mide la opacidad del velo cuadro por cuadro, que un velo
     heredado y no otro nuevo no se deja descartar si el nuevo no quiere, y
     que el foco vuelve a quien abrió el primero. Las dos cajas hacen un
     relevo (la nueva asoma cuando la vieja ya va por un tercio, no se
     cruzan enteras en el centro), y abajo: la caja que sale no contesta un
     click, y close() y show() seguidos tampoco apilan dos velos. */
  console.log('\n5-quinquies. Un modal abierto encima de otro');
  const pisa = await js(`(async () => {
    const { Modal } = await import('./js/overlays.js');
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const cuadro = () => new Promise((ok) => requestAnimationFrame(ok));
    const capa = document.getElementById('ox-layer');
    const abridor = document.createElement('button');
    abridor.className = 'ox-btn'; abridor.textContent = 'abrir';
    abridor.style.cssText = 'position:fixed;left:10px;top:10px;z-index:1';
    document.body.append(abridor);
    abridor.focus();
    const r = {};
    let resA = 'sin contestar';
    Modal.show({ title: 'Primero', actions: [{ label: 'Aceptar', value: true, variant: 'primary' }] }).then((v) => { resA = v; });
    await espera(400);
    const velo = capa.querySelector('.ox-scrim');
    const cajaA = capa.querySelector('.ox-modal__anim');
    let resB = 'sin contestar';
    Modal.show({ title: 'Segundo', dismissible: false, actions: [{ label: 'Listo', value: 'listo', variant: 'primary' }] }).then((v) => { resB = v; });
    await Promise.resolve();
    r.contesto = resA;
    r.sale = cajaA.dataset.state;
    const cajaB = [...capa.querySelectorAll('.ox-modal__anim')].pop();
    const ops = []; const cajas = [];
    for (let i = 0; i < 20; i++) {
      const velos = [...capa.querySelectorAll('.ox-scrim')];
      // Lo que tapa la pantalla: cada velo es rgba(…, .62) con su opacidad.
      ops.push(+(1 - velos.reduce((p, v) => p * (1 - 0.62 * +getComputedStyle(v).opacity), 1)).toFixed(3));
      cajas.push([cajaA.isConnected ? +(+getComputedStyle(cajaA).opacity).toFixed(2) : 0, +(+getComputedStyle(cajaB).opacity).toFixed(2)]);
      await cuadro();
    }
    r.tapa = ops;
    r.relevo = cajas;
    r.velos = capa.querySelectorAll('.ox-scrim').length;
    r.mismoVelo = capa.querySelector('.ox-scrim') === velo;
    await espera(300);
    r.cajas = [...capa.querySelectorAll('.ox-modal__anim')].map((a) => a.querySelector('.ox-modal__title').textContent);
    r.abierto = Modal.isOpen;
    // El velo heredado no cierra un modal que no se deja descartar.
    velo.click();
    await espera(50);
    r.trasClickVelo = Modal.isOpen && resB === 'sin contestar';
    Modal.close('cerrado');
    await espera(400);
    r.resB = resB;
    r.quedan = capa.querySelectorAll('.ox-scrim, .ox-modal__anim').length;
    r.foco = document.activeElement === abridor;
    abridor.remove();
    return r;
  })()`);
  if (process.env.ONYX_SERIES) console.log(JSON.stringify(pisa));
  ok('el modal de abajo se contesta con null y sale con su exit()', pisa.contesto === null && pisa.sale === 'closing', JSON.stringify(pisa));
  ok('el velo es el mismo y no se oscurece en el cambio (un solo velo, quieto en .62)',
    pisa.velos === 1 && pisa.mismoVelo && pisa.tapa.every((t) => Math.abs(t - 0.62) < 0.02), JSON.stringify(pisa.tapa));
  ok('al terminar queda una sola caja, la del nuevo', pisa.cajas.length === 1 && pisa.cajas[0] === 'Segundo' && pisa.abierto, JSON.stringify(pisa.cajas));
  ok('el velo heredado respeta al nuevo: si no se deja descartar, el click no lo cierra', pisa.trasClickVelo, JSON.stringify(pisa));
  ok('cerrado el nuevo, no queda nada en la capa y el foco vuelve a quien abrió el primero',
    pisa.resB === 'cerrado' && pisa.quedan === 0 && pisa.foco, JSON.stringify(pisa));
  /* Relevo: ningún cuadro con las dos cajas a la vista (la vieja por encima
     de .4 y la nueva asomando), y la nueva asoma recién con la vieja por
     debajo de .4. Sin la espera, en el cuadro siguiente al show las dos ya
     se veían (1 y .3). */
  const asoma = pisa.relevo.findIndex(([, b]) => b > 0.02);
  ok('las dos cajas hacen un relevo: la nueva espera a que la vieja vaya por un tercio',
    asoma > 0 && pisa.relevo[asoma][0] < 0.4 && pisa.relevo.every(([a, b]) => !(a > 0.4 && b > 0.1))
      && pisa.relevo.some(([a]) => a > 0.05 && a < 0.95), JSON.stringify(pisa.relevo));

  /* La caja que sale no contesta. Se clickea con el mouse de verdad (por la
     ventana, no con el.click(): lo que importa es a quién le llega) el botón
     del de abajo a los 40 ms de que lo pise otro. Antes el click le llegaba
     al botón que se iba, y su close() cerraba al de ARRIBA con el valor de
     abajo. El de arriba no se deja descartar: el click cae en el velo y no
     pasa nada. */
  const xy = await js(`(async () => {
    const { Modal } = await import('./js/overlays.js');
    window.__pisa = { A: 'sin contestar', B: 'sin contestar' };
    Modal.show({ title: 'Primero', width: 700, body: '<div style="height:300px"></div>',
      actions: [{ label: 'Borrar todo', value: 'valor-de-A', variant: 'primary' }] }).then((v) => { window.__pisa.A = v; });
    await new Promise((r) => setTimeout(r, 400));
    const b = [...document.querySelectorAll('.ox-modal__foot button')].find((x) => x.textContent === 'Borrar todo');
    const q = b.getBoundingClientRect();
    Modal.show({ title: 'Segundo', width: 320, dismissible: false,
      actions: [{ label: 'Listo', value: 'valor-de-B', variant: 'primary' }] }).then((v) => { window.__pisa.B = v; });
    return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };
  })()`);
  await sleep(40);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: xy.x, y: xy.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: xy.x, y: xy.y, button: 'left', clickCount: 1 });
  await sleep(80);
  const clic = await js(`(async () => {
    const { Modal } = await import('./js/overlays.js');
    const r = { ...window.__pisa, abierto: Modal.isOpen };
    Modal.close(null);
    await new Promise((ok) => setTimeout(ok, 400));
    return r;
  })()`);
  ok('la caja que sale no contesta: clickear su botón no cierra al que la pisó',
    clic.A === null && clic.B === 'sin contestar' && clic.abierto, JSON.stringify(clic));

  /* close() y enseguida show() (un confirm y después otro diálogo): el velo
     que se iba se revive y vuelve desde donde estaba. Antes entraba otro
     debajo y los dos juntos llegaban a .79. Con el show en el mismo cuadro
     y a los 60 ms. */
  const modalesSeguidos = await js(`(async () => {
    const { Modal } = await import('./js/overlays.js');
    const cuadro = () => new Promise((ok) => requestAnimationFrame(ok));
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const capa = document.getElementById('ox-layer');
    const tapa = () => [...capa.querySelectorAll('.ox-scrim')].reduce((p, v) => p * (1 - 0.62 * +getComputedStyle(v).opacity), 1);
    const out = {};
    for (const demora of [0, 60]) {
      Modal.show({ title: 'A', actions: [{ label: 'ok', value: true }] });
      await espera(400);
      Modal.close(true);
      const s = []; const n = [];
      const t = performance.now();
      while (performance.now() - t < demora) { s.push(+(1 - tapa()).toFixed(3)); await cuadro(); }
      Modal.show({ title: 'B', actions: [{ label: 'ok', value: true }] });
      for (let i = 0; i < 30; i++) { s.push(+(1 - tapa()).toFixed(3)); n.push(capa.querySelectorAll('.ox-scrim').length); await cuadro(); }
      out['a' + demora] = { tapa: s, velos: Math.max(...n), abierto: Modal.isOpen };
      Modal.close(null); await espera(400);
      out['a' + demora].quedan = capa.querySelectorAll('.ox-scrim, .ox-modal__anim').length;
    }
    return out;
  })()`);
  if (process.env.ONYX_SERIES) console.log(JSON.stringify(modalesSeguidos));
  for (const [k, v] of Object.entries(modalesSeguidos)) {
    ok(`close() y show() seguidos (${k.slice(1)} ms): un solo velo, que no oscurece ni se apaga`,
      v.velos === 1 && v.tapa.every((t) => t < 0.625 && t > 0.5) && v.abierto && v.quedan === 0, JSON.stringify(v));
  }

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

  /* Mantener apretado mientras el primer paso repinta el panel (lo normal: la
     vista escucha el cambio y vuelve a pintar). El botón apretado sale del
     documento y el pointerup cae sobre el botón NUEVO: el root viejo no se
     entera. Sin el freno en window, el contador viejo seguía corriendo solo y
     cada paso volvía a repintar. Salió de Quire (las copias de Imprimir). */
  const aguante = await js(`(async () => {
    const { bindStepper } = await import('./js/motion.js');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(host);
    let pasos = 0;
    const pintar = () => {
      host.innerHTML = '<div class="ox-stepper"><input class="ox-input ox-num" type="number" min="0" max="99" step="1" value="' + (1 + pasos) + '">'
        + '<button data-step="up"></button><button data-step="down"></button></div>';
      bindStepper(host.querySelector('.ox-stepper'), () => { pasos++; pintar(); });
    };
    pintar();
    const o = { bubbles: true, pointerId: 1, pointerType: 'mouse' };
    host.querySelector('[data-step="up"]').dispatchEvent(new PointerEvent('pointerdown', o));
    await new Promise((r) => setTimeout(r, 60));
    host.querySelector('[data-step="up"]').dispatchEvent(new PointerEvent('pointerup', o));
    await new Promise((r) => setTimeout(r, 1200));
    const r = { pasos, valor: host.querySelector('input').value };
    host.remove();
    return r;
  })()`);
  ok('soltar frena aunque el primer paso haya repintado el stepper', aguante.pasos === 1 && aguante.valor === '2', JSON.stringify(aguante));

  /* ── 6-ter. Lo apagado se ve apagado, y se apaga de a poco ────────────────
     Un .ox-iconbtn deshabilitado se veía igual que uno activo y se iluminaba
     al pasarle el mouse (Chromium le aplica :hover): las flechas de Buscar,
     el deshacer de la tinta y la barra de Páginas de Quire mentían (U3). Y
     la flecha del stepper caía de 1 a .25 en un cuadro al llegar al tope,
     porque su transición no incluía la opacidad (U4). Se mide el color
     contra el token y la opacidad cuadro a cuadro.

     Y dos cosas que salieron de esos mismos arreglos. La flecha que NACE en
     el tope se fundía en cada montaje si algo había forzado el estilo antes
     del cableado (100 100 76 58 … 25): tiene que estar en 25 desde el primer
     cuadro. Y un .ox-iconbtn apagado con pointer-events: none se quedaba sin
     tooltip, que en un botón de ícono es su nombre: con el mouse de verdad
     encima no se ilumina, pero dice qué es y su atajo. */
  console.log('\n6-ter. Lo apagado se ve apagado');
  const apagados = await js(`(async () => {
    const { bindStepper } = await import('./js/motion.js');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:40px;top:40px;width:140px;z-index:50';
    host.innerHTML = '<button class="ox-iconbtn" id="ib-on"></button><button class="ox-iconbtn" id="ib-off" disabled></button>'
      + '<span id="ib-tenue" style="color:var(--ox-text-4)"></span>'
      + '<div class="ox-stepper"><input class="ox-input" type="number" value="1"><div class="ox-stepper__btns">'
      + '<button class="ox-stepper__btn" data-step="up"></button><button class="ox-stepper__btn" data-step="down"></button></div></div>';
    document.body.append(host);
    const cs = (id) => getComputedStyle(host.querySelector(id));
    const r = { tenue: cs('#ib-tenue').color, on: cs('#ib-on').color, off: cs('#ib-off').color };
    const flecha = host.querySelector('[data-step="down"]');
    void getComputedStyle(flecha).opacity;
    await new Promise((ok) => requestAnimationFrame(ok));
    flecha.disabled = true;
    r.opacidad = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 220) {
      r.opacidad.push(Math.round(+getComputedStyle(flecha).opacity * 100));
      await new Promise((ok) => requestAnimationFrame(ok));
    }
    // Un campo en 0 con mínimo 0: la flecha de abajo nace en el tope. El
    // getComputedStyle de antes del cableado es «algo forzó el estilo entre
    // el paint() y el bindStepper» (initScrollFades, colocar una cápsula).
    const st = document.createElement('div');
    st.className = 'ox-stepper';
    st.innerHTML = '<input class="ox-input" type="number" min="0" max="9" value="0"><div class="ox-stepper__btns">'
      + '<button class="ox-stepper__btn" data-step="up"></button><button class="ox-stepper__btn" data-step="down"></button></div>';
    host.append(st);
    const enTope = st.querySelector('[data-step="down"]');
    void getComputedStyle(enTope).opacity;
    bindStepper(st);
    r.alNacer = [];
    const t1 = performance.now();
    while (performance.now() - t1 < 200) {
      r.alNacer.push(Math.round(+getComputedStyle(enTope).opacity * 100));
      await new Promise((ok) => requestAnimationFrame(ok));
    }
    host.remove();
    return r;
  })()`);
  ok('un .ox-iconbtn deshabilitado se apaga (--ox-text-4)',
    apagados.off === apagados.tenue && apagados.on !== apagados.tenue, JSON.stringify(apagados));
  ok('la flecha del stepper se apaga fundiéndose, no de un cuadro al otro',
    apagados.opacidad.some((v) => v > 30 && v < 95) && apagados.opacidad.at(-1) === 25, apagados.opacidad.join(' '));
  ok('la que nace en el tope nace apagada (25 desde el primer cuadro, sin fundirse al montarse)',
    apagados.alNacer.length > 3 && apagados.alNacer.every((v) => v === 25), apagados.alNacer.join(' '));

  // El de al lado, prendido, es el control: con el mouse encima SÍ se ilumina
  // (si no, el hover no estaría llegando y lo de abajo no probaría nada).
  // matches(':hover') no sirve para esto: desde executeJavaScript da false
  // aunque el estilo de :hover esté aplicado.
  const ibPos = await js(`(() => {
    const c = document.createElement('div');
    c.id = 'ib-caja';
    c.style.cssText = 'position:fixed;left:520px;top:520px;display:flex;gap:40px;z-index:50';
    c.innerHTML = '<button class="ox-iconbtn" id="ib-prendido" data-tip="Rehacer"></button>'
      + '<button class="ox-iconbtn" id="ib-tip" disabled data-tip="Deshacer" data-tip-key="Ctrl Z"></button>';
    document.body.append(c);
    const centro = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    return { prendido: centro(c.children[0]), apagado: centro(c.children[1]) };
  })()`);
  const ibHover = {};
  for (const [cual, p] of Object.entries(ibPos)) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x - 20), y: Math.round(p.y + 60) });
    await sleep(500);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y) });
    await sleep(700);
    ibHover[cual] = await js(`(() => {
      const b = document.getElementById('${cual === 'prendido' ? 'ib-prendido' : 'ib-tip'}'); const cs = getComputedStyle(b);
      const t = [...document.querySelectorAll('.ox-tooltip')].find((x) => !x.dataset.state);
      return { fondo: cs.backgroundColor, color: cs.color, tip: t ? t.textContent : null };
    })()`);
  }
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: H - 40 });
  await sleep(300);
  await js(`document.getElementById('ib-caja')?.remove(); true`);
  ok('con el mouse encima, un .ox-iconbtn apagado no se ilumina (y el prendido de al lado sí)',
    ibHover.prendido.fondo !== 'rgba(0, 0, 0, 0)' && ibHover.apagado.fondo === 'rgba(0, 0, 0, 0)' && ibHover.apagado.color === apagados.tenue,
    JSON.stringify({ ...ibHover, tenue: apagados.tenue }));
  ok('pero su tooltip sigue diciendo qué es y su atajo', ibHover.apagado.tip === 'DeshacerCtrl Z', JSON.stringify(ibHover));

  /* Lo mismo para un botón de TEXTO apagado con tooltip: dice por qué está
     apagado (en Quire, «Imprimir» con un PDF con contraseña). Antes tenía
     pointer-events: none y el tooltip nunca salía. Con el mouse de verdad
     encima: sale el tooltip y el ghost no se ilumina. Uno sin tooltip, y uno
     [aria-disabled] (que sí recibiría el clic), siguen con el puntero cortado. */
  const btPos = await js(`(() => {
    const c = document.createElement('div');
    c.id = 'bt-caja';
    c.style.cssText = 'position:fixed;left:520px;top:520px;display:flex;gap:40px;z-index:50';
    c.innerHTML = '<button class="ox-btn ox-btn--ghost" id="bt-tip" disabled data-tip="Este PDF tiene contraseña">Imprimir</button>'
      + '<button class="ox-btn ox-btn--secondary" id="bt-mudo" disabled>Guardar</button>'
      + '<button class="ox-btn ox-btn--secondary" id="bt-aria" aria-disabled="true" data-tip="No">Exportar</button>';
    document.body.append(c);
    const r = c.children[0].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(btPos.x - 20), y: Math.round(btPos.y + 60) });
  await sleep(500);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(btPos.x), y: Math.round(btPos.y) });
  await sleep(700);
  const btHover = await js(`(() => {
    const cs = (id) => getComputedStyle(document.getElementById(id));
    const t = [...document.querySelectorAll('.ox-tooltip')].find((x) => !x.dataset.state);
    return { tip: t ? t.textContent : null, fondo: cs('bt-tip').backgroundColor, color: cs('bt-tip').color,
      mudo: cs('bt-mudo').pointerEvents, aria: cs('bt-aria').pointerEvents };
  })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: H - 40 });
  await sleep(300);
  await js(`document.getElementById('bt-caja')?.remove(); true`);
  ok('un .ox-btn apagado con tooltip dice por qué está apagado', btHover.tip === 'Este PDF tiene contraseña', JSON.stringify(btHover));
  ok('y con el mouse encima no se ilumina (el ghost sigue sin fondo y en --ox-text-4)',
    btHover.fondo === 'rgba(0, 0, 0, 0)' && btHover.color === apagados.tenue, JSON.stringify({ ...btHover, tenue: apagados.tenue }));
  ok('sin tooltip, o con aria-disabled, el puntero sigue cortado', btHover.mudo === 'none' && btHover.aria === 'none', JSON.stringify(btHover));

  /* La selección sobre una superficie clara (.ox-sobre-claro, el lector de
     Quire). Con el ::selection de siempre, el velo es el acento —casi blanco—
     y la letra pasa a --ox-text: sobre papel blanco no se ve el velo y la
     tinta oscura se vuelve clara. Se mide en la foto: el papel seleccionado
     tiene que oscurecer y la letra seguir oscura; la de control, sin la
     clase, muestra el defecto. */
  const papel = async (clase) => {
    const r = await js(`(() => {
      document.getElementById('sel-papel')?.remove();
      const p = document.createElement('div');
      p.id = 'sel-papel';
      p.className = '${clase}';
      p.style.cssText = 'position:fixed;left:40px;top:300px;padding:0;background:#fff;color:#111;font:700 28px/1.2 sans-serif;white-space:nowrap;user-select:text;z-index:60';
      p.textContent = 'HOJA BLANCA';
      document.body.append(p);
      const rg = document.createRange(); rg.selectNodeContents(p);
      const s = getSelection(); s.removeAllRanges(); s.addRange(rg);
      const b = p.getBoundingClientRect();
      return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
    })()`);
    await sleep(150);
    const img = await win.webContents.capturePage({ x: r.x + 1, y: r.y + 2, width: r.w - 2, height: r.h - 4 });
    const buf = img.toBitmap();
    let claro = 255; let oscuro = 255; let lum = 0; let n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const L = Math.round(0.299 * buf[i + 2] + 0.587 * buf[i + 1] + 0.114 * buf[i]);
      oscuro = Math.min(oscuro, L); lum += L; n++;
    }
    // El fondo es lo que más se repite: la mediana alcanza.
    const ls = [];
    for (let i = 0; i < buf.length; i += 4) ls.push(Math.round(0.299 * buf[i + 2] + 0.587 * buf[i + 1] + 0.114 * buf[i]));
    ls.sort((a, b) => a - b);
    claro = ls[Math.floor(ls.length * 0.75)];
    return { fondo: claro, letra: oscuro };
  };
  const conClase = await papel('ox-sobre-claro');
  const sinClase = await papel('');
  await js(`getSelection().removeAllRanges(); document.getElementById('sel-papel')?.remove(); true`);
  ok('sobre papel, lo seleccionado se oscurece (antes quedaba en 253 de 255)', conClase.fondo < 235 && sinClase.fondo > 245, JSON.stringify({ conClase, sinClase }));
  ok('y la letra seleccionada sigue oscura (con el ::selection de siempre se aclaraba)', conClase.letra < 80 && sinClase.letra > conClase.letra + 60, JSON.stringify({ conClase, sinClase }));

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

  /* ── 7-bis. La vitrina pone al día en vez de rehacer (U11) ────────────────
     Es lo que se copia, así que tiene que mostrar el patrón bueno. Los
     botones de mono se rehacían con innerHTML en cada click: el elegido
     pasaba a primario de un cuadro al otro (nodo nuevo, sin de dónde
     transicionar) y el destello del click se iba con el nodo viejo. Y el
     valor del select de demo cambiaba con textContent. Se mide que sean los
     MISMOS botones y que el cambio de variante corra como transición, y que
     el valor del select haga relevo (shell-36). De paso, que su menú muestre
     el `hint` (U6). */
  console.log('\n7-bis. La vitrina pone al día en vez de rehacer');
  const vitrina = await js(`(async () => {
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const { Menu } = await import('./js/overlays.js');
    const host = document.getElementById('knob-mono');
    const antes = [...host.querySelectorAll('[data-mono]')];
    const otro = antes.find((b) => b.classList.contains('ox-btn--secondary'));
    otro.click();
    await espera(30);
    const despues = [...host.querySelectorAll('[data-mono]')];
    const r = {
      mismos: antes.length === despues.length && antes.every((b, i) => b === despues[i]),
      elegido: otro.classList.contains('ox-btn--primary') && !otro.classList.contains('ox-btn--secondary'),
      primarios: despues.filter((b) => b.classList.contains('ox-btn--primary')).length,
      transiciona: otro.getAnimations().some((a) => a instanceof CSSTransition),
    };
    const sel = document.getElementById('demo-select');
    const val = sel.querySelector('.ox-select__value');
    // Primero el que ya está elegido, antes de cualquier otro: swap() todavía
    // no recuerda nada (el valor lo escribió el HTML) y relevaba la misma
    // palabra por sí misma.
    sel.click();
    await espera(300);
    const yaElegido = document.querySelector('.ox-menu:not([data-state]) .ox-menuitem.is-selected');
    const valorAntes = val.textContent.trim();
    yaElegido?.click();
    r.mismo = { habia: !!yaElegido, relevo: !!val.querySelector(':scope > .ox-swap-out'), igual: val.textContent.trim() === valorAntes };
    await espera(400);
    sel.click();
    await espera(300);
    r.hint = document.querySelector('.ox-menu:not([data-state]) .ox-menuitem__hint')?.textContent || null;
    const opcion = [...document.querySelectorAll('.ox-menu:not([data-state]) .ox-menuitem')].find((b) => !b.classList.contains('is-selected'));
    r.nombre = opcion?.querySelector('.ox-truncate').textContent || null;
    opcion?.click();
    r.relevo = !!val.querySelector(':scope > .ox-swap-out--over');
    await espera(400);
    r.valor = val.textContent.trim();
    sel.click();
    await espera(300);
    r.marcado = document.querySelector('.ox-menu:not([data-state]) .ox-menuitem.is-selected .ox-truncate')?.textContent || null;
    Menu.close();
    await espera(300);
    return r;
  })()`);
  ok('los botones de mono son los mismos nodos: cambia la variante y transiciona',
    vitrina.mismos && vitrina.elegido && vitrina.primarios === 1 && vitrina.transiciona, JSON.stringify(vitrina));
  ok('el valor del select de demo cambia con relevo, y el menú marca el nuevo',
    vitrina.relevo && vitrina.nombre && vitrina.valor === vitrina.nombre && vitrina.marcado === vitrina.nombre, JSON.stringify(vitrina));
  ok('el menú del select muestra su hint («por defecto»)', vitrina.hint === 'por defecto', JSON.stringify(vitrina));
  ok('elegir el que ya estaba elegido no releva nada', vitrina.mismo.habia && !vitrina.mismo.relevo && vitrina.mismo.igual, JSON.stringify(vitrina.mismo));

  /* ocupar() y contador() en la vitrina (regla de Piezas: lo que no está en
     la vitrina no existe). El botón de demo trabaja 1,6 s y vuelve. */
  const vitrina2 = await js(`(async () => {
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const b = document.getElementById('demo-ocupar');
    const c = document.getElementById('demo-contador');
    if (!b || !c) return { falta: true };
    b.click();
    const r = { ocupa: b.dataset.ocupado, calco: !!b.querySelector(':scope > .ox-swap-out--over'),
      spinner: !!b.querySelector(':scope > .ox-swap-in svg, :scope > svg.ox-swap-in') };
    document.getElementById('demo-contar-mas').click();
    document.getElementById('demo-contar-mas').click();
    await espera(1900);
    r.vuelve = b.dataset.ocupado; r.dice = b.textContent.trim(); r.cuenta = c.textContent;
    document.getElementById('demo-contar-vaciar').click();
    await espera(400);
    r.vacio = c.textContent;
    return r;
  })()`);
  ok('la vitrina muestra ocupar() y contador() andando',
    !vitrina2.falta && vitrina2.ocupa === '1' && vitrina2.calco && vitrina2.spinner && vitrina2.vuelve === '0' && vitrina2.dice === 'Exportar'
      && vitrina2.cuenta === '2' && vitrina2.vacio === '', JSON.stringify(vitrina2));

  /* «Repetir entradas» (U10): la entrada se repetía con un style.animation en
     línea con fill `both`, que retiene para siempre el último cuadro —el
     cuerpo quedaba bloque contenedor de lo fixed y frontera de backdrop— y le
     ganaría a cualquier salida (shell-35). Ahora va por la API, sin fill: se
     mide que entre, y que al terminar no quede nada aplicado. */
  const repetir = await js(`(async () => {
    const body = document.getElementById('design-body');
    document.getElementById('replay').click();
    await new Promise((r) => setTimeout(r, 120));
    const aMitad = +getComputedStyle(body).opacity;
    await new Promise((r) => setTimeout(r, 600));
    const cs = getComputedStyle(body);
    return { aMitad: +aMitad.toFixed(2), inline: body.style.animation, nombre: cs.animationName,
      transform: cs.transform, opacidad: cs.opacity, retenidas: body.getAnimations().length };
  })()`);
  ok('«Repetir entradas» vuelve a hacer entrar la vitrina', repetir.aMitad < 0.95, JSON.stringify(repetir));
  ok('y al terminar no deja nada aplicado (animation: none, sin transform ni animación retenida)',
    repetir.inline === '' && repetir.nombre === 'none' && repetir.transform === 'none' && repetir.opacidad === '1' && repetir.retenidas === 0,
    JSON.stringify(repetir));

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

  /* El contrapeso del max-content: en un contenedor más angosto que la suma
     de las opciones (el inspector de Quire, 288px útiles y overflow hidden),
     el control tiene que ACOTARSE al contenedor —las columnas quedan
     desparejas— y la cápsula seguir cayendo sobre su opción. Sin max-width
     medía 317px y "Carpeta…" quedaba recortada por el panel. */
  await js(`(async () => {
    const { bindSwitcher } = await import('./js/motion.js');
    const c = document.createElement('div');
    c.id = 'seg-angosto';
    c.style.cssText = 'width:288px;overflow:hidden;display:flex;flex-direction:column';
    c.innerHTML = '<div class="ox-segmented" id="seg-estrecho">'
      + '<button class="ox-segmented__opt" data-value="a">Junto al original</button>'
      + '<button class="ox-segmented__opt is-active" data-value="b">Descargas</button>'
      + '<button class="ox-segmented__opt" data-value="c">Carpeta…</button>'
      + '</div>';
    document.querySelector('.ox-table').after(c);
    bindSwitcher(c.querySelector('#seg-estrecho'), () => {});
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return true;
  })()`);
  await sleep(300);
  cap = await capsula('#seg-estrecho');
  const angosto = await js(`(() => {
    const c = document.getElementById('seg-angosto').getBoundingClientRect();
    const s = document.getElementById('seg-estrecho').getBoundingClientRect();
    return { ancho: +s.width.toFixed(1), seSale: s.right > c.right + 0.5 };
  })()`);
  ok('en un contenedor angosto el control no se sale', angosto && !angosto.seSale && angosto.ancho <= 288, JSON.stringify(angosto));
  ok('y la cápsula cae sobre "Descargas" aunque las columnas sean desparejas',
    cap && cap.txt === 'Descargas' && cap.desfase <= 1 && cap.anchos[0] > cap.anchos[1], JSON.stringify(cap));
  await js(`(() => { document.getElementById('seg-angosto')?.remove(); return true; })()`);

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

  /* ── 8-decies. Un ícono dentro de un dato chico va en el renglón ───────────
     `.ox-meta` y `.ox-label` son texto en línea y todo svg es display:block:
     el ícono se iba solo a un renglón de arriba (salió de Pharos). Se arman
     los dos casos y se mide que ícono y texto compartan renglón. Sin la regla
     de base.css da 13.5px de desfase y 27px de alto. */
  console.log('\n8-decies. Un ícono dentro de un dato chico va en el renglón');
  const renglon = await js(`(async () => {
    const { Icons } = await import('./js/icons.js');
    const caja = document.createElement('div');
    caja.innerHTML = '<span class="ox-meta">' + Icons.svg('clock', 'ox-icon--sm') + ' hace 2 h</span>'
      + '<div><span class="ox-label">' + Icons.svg('settings', 'ox-icon--sm') + ' Ajustes</span></div>';
    document.getElementById('view').prepend(caja);
    const medir = (el) => {
      const i = el.querySelector('svg').getBoundingClientRect();
      const r = document.createRange(); r.selectNodeContents(el.lastChild);
      const t = r.getBoundingClientRect();
      return { dy: +Math.abs((i.top + i.bottom) / 2 - (t.top + t.bottom) / 2).toFixed(1), alto: Math.round(el.getBoundingClientRect().height) };
    };
    const out = { meta: medir(caja.querySelector('.ox-meta')), label: medir(caja.querySelector('.ox-label')) };
    caja.remove();
    return out;
  })()`);
  ok('en .ox-meta el ícono va al lado del texto', renglon.meta.dy <= 2 && renglon.meta.alto < 20, JSON.stringify(renglon));
  ok('y en .ox-label también', renglon.label.dy <= 2 && renglon.label.alto < 22, JSON.stringify(renglon));

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

  /* ── 8-undecies. swap(): reescribir un bloque sin cortes ──────────────────
     Un innerHTML a secas se lleva lo viejo en el mismo cuadro en que llega lo
     nuevo. Se mide la demo de la vitrina en los cuatro casos, muestreando la
     opacidad cada 20 ms: la curva, no una foto. Y el mismo mecanismo en la
     app demo: el contexto de la titlebar, que entraba y salía de golpe. */
  console.log('\n8-undecies. swap(): reescribir un bloque sin cortes');
  const swapA = (k) => js(`document.querySelector('#demo-swap-btns [data-swap="${k}"]').click()`);
  await js(`document.getElementById('demo-swap').scrollIntoView({ block: 'center' })`);
  await swapA('pista');
  await sleep(400);

  const relevo = await js(`(async () => {
    const box = document.getElementById('demo-swap');
    const viejo = box.querySelector(':scope > .ox-meta');
    const antes = viejo.getBoundingClientRect();
    document.querySelector('#demo-swap-btns [data-swap="cargando"]').click();
    const calco = box.querySelector(':scope > .ox-swap-out--over');
    const nuevo = box.querySelector(':scope > .ox-swap-in');
    const rb = box.getBoundingClientRect();
    const filas = [];
    for (let t = 0; t <= 240; t += 20) {
      const rc = calco?.isConnected ? calco.getBoundingClientRect() : null;
      const rv = viejo.isConnected ? viejo.getBoundingClientRect() : null;
      filas.push({ t,
        viejo: calco?.isConnected ? Math.round(+getComputedStyle(calco).opacity * 100) : null,
        nuevo: nuevo ? Math.round(+getComputedStyle(nuevo).opacity * 100) : null,
        mismoLugar: !rc || (Math.abs(rc.left - rb.left) < 0.5 && Math.abs(rc.top - rb.top) < 0.5),
        quieto: !rv || (Math.abs(rv.left - antes.left) < 0.5 && Math.abs(rv.top - antes.top) < 0.5) });
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 300));
    const finitas = [...box.querySelectorAll('*')].flatMap((e) => e.getAnimations())
      .filter((a) => a.effect.getTiming().iterations !== Infinity).length;
    return { hayCalco: !!calco, filas, calcos: box.querySelectorAll('.ox-swap-out').length, finitas };
  })()`);
  const sr = relevo.filas.map((f) => `${f.t}:${f.viejo ?? '-'}/${f.nuevo}`).join(' ');
  ok('un estado por otro: lo viejo queda en un calco encima', relevo.hayCalco, JSON.stringify(relevo));
  ok('que se esfuma de a poco', relevo.filas.some((f) => f.viejo > 5 && f.viejo < 95), sr);
  ok('lo nuevo espera su turno: arranca invisible', relevo.filas[0].nuevo <= 5, sr);
  ok('nunca los dos a más de la mitad', relevo.filas.every((f) => !(f.viejo > 50 && f.nuevo > 50)), sr);
  ok('el calco cae sobre el bloque, y lo viejo no se mueve mientras se va',
    relevo.filas.every((f) => f.mismoLugar && f.quieto), JSON.stringify(relevo.filas.filter((f) => !f.mismoLugar || !f.quieto)));
  ok('al terminar no queda calco ni entrada retenida', relevo.calcos === 0 && relevo.finitas === 0, JSON.stringify(relevo));

  /* El calco conserva la caja de lo VIEJO. Con `inset: 0` tomaba la del
     contenedor ya con lo nuevo: una frase alineada a la derecha que pasaba a
     una más corta se esfumaba partida en dos renglones (Pharos 0.4.0, el
     descuento de la ficha). Y un texto suelto que llega en un relevo tiene
     que entrar animado, no aparecer entero debajo de lo que se va.
     El ancho de la frase es fraccionario a propósito (el letter-spacing): la
     primera versión del arreglo medía con clientWidth, que redondea, y al
     calco le faltaba una fracción de píxel para que la frase entrara —se
     partía igual («Cargar / movimiento» en Finway)—. */
  const cajaVieja = await js(`(async () => {
    const { swap } = await import('./js/motion.js');
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:40px;top:40px;width:420px;display:flex;align-items:center;z-index:50';
    host.innerHTML = '<div style="flex:1"></div><span class="ox-meta" style="letter-spacing:.0137px"></span>';
    document.body.append(host);
    const frase = host.lastElementChild;
    swap(frase, 'Mostrando precios con <b>40%</b> menos');
    await espera(400);
    const r0 = frase.getBoundingClientRect();
    swap(frase, 'Mostrando precios de lista', { relevo: true });
    const calco = frase.querySelector(':scope > .ox-swap-out--over');
    const nuevo = [...frase.children].find((n) => n !== calco);
    const r = { alto: r0.height, calcoAlto: 0, corrido: 0, nuevoAlEmpezar: nuevo ? +getComputedStyle(nuevo).opacity : null };
    const t0 = performance.now();
    while (calco?.isConnected && performance.now() - t0 < 400) {
      const rc = calco.getBoundingClientRect();
      r.calcoAlto = Math.max(r.calcoAlto, rc.height, calco.scrollHeight);
      r.corrido = Math.max(r.corrido, Math.abs(rc.left - r0.left), Math.abs(rc.right - r0.right));
      await new Promise((ok) => requestAnimationFrame(ok));
    }
    host.remove();
    return r;
  })()`);
  ok('el calco conserva la caja de lo viejo: la frase no se parte en dos renglones',
    cajaVieja.calcoAlto > 0 && cajaVieja.calcoAlto <= cajaVieja.alto + 1, JSON.stringify(cajaVieja));
  ok('ni se corre de donde estaba', cajaVieja.corrido < 0.5, JSON.stringify(cajaVieja));
  ok('un texto suelto que llega en un relevo entra animado (arranca invisible)',
    cajaVieja.nuevoAlEmpezar !== null && cajaVieja.nuevoAlEmpezar <= 0.05, JSON.stringify(cajaVieja));

  // Y el que se va (algo → vacío): antes se borraba en el acto.
  const seVaTexto = await js(`(async () => {
    const { swap } = await import('./js/motion.js');
    const el = document.createElement('span');
    el.textContent = 'en categorías sin tope';
    document.body.append(el);
    swap(el, '');
    const saliendo = el.querySelector(':scope > .ox-swap-out');
    await new Promise((ok) => setTimeout(ok, 60));
    const r = { saliendo: !!saliendo, aMitad: saliendo?.isConnected ? +getComputedStyle(saliendo).opacity : null };
    await new Promise((ok) => setTimeout(ok, 400));
    r.vacio = el.childNodes.length === 0;
    el.remove();
    return r;
  })()`);
  ok('un texto suelto que se va sale esfumándose, no de golpe',
    seVaTexto.saliendo && seVaTexto.aMitad > 0 && seVaTexto.aMitad < 1 && seVaTexto.vacio, JSON.stringify(seVaTexto));

  /* Dos relevos seguidos, antes de que lo del medio termine de entrar. El
     calco le hacía finish() a todo lo que se llevaba: lo del medio saltaba a
     opaco y se esfumaba desde ahí, mostrando entero un estado que nunca se
     había visto. Se mide cuánto se ve de cada texto (su opacidad por la de sus
     ancestros), cuadro a cuadro. */
  const seguidos = await js(`(async () => {
    const { swap } = await import('./js/motion.js');
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const cuadro = () => new Promise((r) => requestAnimationFrame(r));
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:40px;top:40px;width:300px';
    document.body.append(el);
    const visible = (txt) => { let max = 0;
      for (const n of el.querySelectorAll('span')) {
        if (n.textContent !== txt) continue;
        let op = 1; for (let x = n; x && x !== el; x = x.parentElement) op *= +getComputedStyle(x).opacity;
        max = Math.max(max, op);
      }
      return Math.round(max * 100) / 100; };
    swap(el, '<span>uno</span>');
    await espera(400);
    // Lo del medio todavía no asomó (está en su espera): no se tiene que ver nunca.
    swap(el, '<span>dos</span>', { relevo: true });
    await espera(25);
    const dosAntes = visible('dos');
    swap(el, '<span>tres</span>', { relevo: true });
    let dosMax = 0;
    for (let i = 0; i < 25; i++) { dosMax = Math.max(dosMax, visible('dos')); await cuadro(); }
    await espera(400);
    // Lo del medio a mitad de su entrada: sale desde donde estaba, no desde opaco.
    swap(el, '<span>cuatro</span>', { relevo: true });
    await espera(110);
    const cuatroAntes = visible('cuatro');
    swap(el, '<span>cinco</span>', { relevo: true });
    let cuatroMax = visible('cuatro');
    for (let i = 0; i < 20; i++) { cuatroMax = Math.max(cuatroMax, visible('cuatro')); await cuadro(); }
    await espera(500);
    const fin = el.textContent;
    el.remove();
    return { dosAntes, dosMax, cuatroAntes, cuatroMax, fin };
  })()`);
  ok('dos relevos seguidos: lo que no había asomado no aparece nunca', seguidos.dosAntes <= 0.02 && seguidos.dosMax <= 0.05, JSON.stringify(seguidos));
  ok('lo que venía entrando sale desde la opacidad que tenía, no desde opaco',
    seguidos.cuatroAntes > 0.1 && seguidos.cuatroAntes < 0.9 && seguidos.cuatroMax <= seguidos.cuatroAntes + 0.05, JSON.stringify(seguidos));
  ok('y al final queda solo lo último', seguidos.fin === 'cinco', JSON.stringify(seguidos));

  /* Fundido: una tabla que gana columnas. Con el relevo la tabla entera
     pasaba por media luz (0,5 la vieja, 0,3 la nueva). Con fundido la nueva
     está entera debajo desde el primer cuadro, y el calco es opaco y va por
     encima del th sticky de la nueva. */
  const fundido = await js(`(async () => {
    const { swap } = await import('./js/motion.js');
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const host = document.createElement('div');
    host.className = 'ox-scroll';
    host.style.cssText = 'position:fixed;left:40px;top:120px;width:520px;height:160px;z-index:50;background:var(--ox-bg)';
    document.body.append(host);
    const tabla = (cols) => '<table class="ox-table"><thead><tr>' + cols.map((c) => '<th>' + c + '</th>').join('')
      + '</tr></thead><tbody>' + [1, 2, 3].map((i) => '<tr>' + cols.map((c) => '<td>' + c + i + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    swap(host, tabla(['Presentación', 'Precio']));
    await espera(400);
    swap(host, tabla(['Presentación', 'Lista', 'Con 20%', 'Ahorro']), { fundido: true });
    const calco = host.querySelector(':scope > .ox-swap-out--over');
    const nueva = host.querySelector(':scope > table');
    const th = nueva?.querySelector('th');
    const bg = calco ? getComputedStyle(calco).backgroundColor : '';
    const r = {
      hayCalco: !!calco,
      opaco: bg !== '' && bg !== 'transparent' && !/^rgba\\(.*,\\s*0\\)$/.test(bg),
      fondo: bg,
      zCalco: calco ? +getComputedStyle(calco).zIndex : null,
      zTh: th ? +getComputedStyle(th).zIndex : null,
      nueva: 1, viejo: [],
    };
    const t0 = performance.now();
    while (calco?.isConnected && performance.now() - t0 < 400) {
      r.nueva = Math.min(r.nueva, +getComputedStyle(nueva).opacity);
      r.viejo.push(Math.round(+getComputedStyle(calco).opacity * 100));
      await new Promise((ok) => requestAnimationFrame(ok));
    }
    host.remove();
    return r;
  })()`);
  ok('fundido: la tabla vieja queda en un calco opaco', fundido.hayCalco && fundido.opaco, JSON.stringify(fundido));
  ok('que va por encima del encabezado sticky de la nueva', fundido.zCalco > fundido.zTh, JSON.stringify(fundido));
  ok('la nueva está entera debajo desde el primer cuadro (sin media luz)', fundido.nueva === 1, JSON.stringify(fundido));
  ok('y el calco se esfuma de a poco', fundido.viejo.some((v) => v > 5 && v < 95), fundido.viejo.join(' '));

  /* ── 8-terdecies. Lo que cambia con la app andando ─────────────────────────
     numero, frase, valor y deslizarAlto nacieron en Finway y en Apex (cada una
     tenía su copia); reconcile, en Prism. Se miden sobre nodos de prueba. */
  console.log('\n8-terdecies. Lo que cambia con la app andando');
  const vivo = await js(`(async () => {
    const m = await import('./js/motion.js');
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:40px;top:40px;width:420px;z-index:50';
    document.body.append(host);
    const nuevo = (html = '') => { const el = document.createElement('div'); el.innerHTML = html; host.append(el); return el; };
    const r = {};

    // numero: el primer llenado no destella; un cambio, sí.
    const n = nuevo();
    m.numero(n, 5); r.primeroDestella = n.classList.contains('ox-ticked');
    m.numero(n, 6); r.cambioDestella = n.classList.contains('ox-ticked') && n.textContent === '6';

    // frase: solo cifras → en el lugar con destello; otra frase → relevo.
    const f = nuevo('3 tomas');
    m.frase(f, '4 tomas');
    r.cifras = { calco: !!f.querySelector('.ox-swap-out'), destello: f.classList.contains('ox-ticked'), dice: f.textContent };
    await espera(50);
    m.frase(f, '1 toma');
    r.otra = { calco: !!f.querySelector(':scope > .ox-swap-out--over') };

    // valor: siempre en el lugar, aunque cambien palabras; lo que ya dice no cuenta.
    const v = nuevo('hasta el lunes');
    m.valor(v, 'hasta el lunes'); r.valorPrimero = v.classList.contains('ox-ticked');
    m.valor(v, 'hasta el martes');
    r.valor = { calco: !!v.querySelector('.ox-swap-out'), destello: v.classList.contains('ox-ticked'), dice: v.textContent };

    // deslizarAlto: el alto viaja en vez de saltar.
    const d = nuevo('una línea');
    const d0 = d.getBoundingClientRect().height;
    m.deslizarAlto(d, () => { d.innerHTML = 'una<br>dos<br>tres<br>cuatro'; });
    const altos = [];
    for (let i = 0; i < 6; i++) { await new Promise((ok) => requestAnimationFrame(ok)); altos.push(Math.round(d.getBoundingClientRect().height)); }
    await espera(250);
    r.alto = { d0: Math.round(d0), altos, final: Math.round(d.getBoundingClientRect().height) };

    host.remove();
    return r;
  })()`);
  ok('numero(): el primer llenado no destella', vivo.primeroDestella === false, JSON.stringify(vivo));
  ok('y un cambio se escribe en el lugar con un destello', vivo.cambioDestella, JSON.stringify(vivo));
  ok('frase(): si cambian solo las cifras, en el lugar con destello', !vivo.cifras.calco && vivo.cifras.destello && vivo.cifras.dice === '4 tomas', JSON.stringify(vivo.cifras));
  ok('y si cambia la frase, relevo', vivo.otra.calco, JSON.stringify(vivo.otra));
  ok('valor(): siempre en el lugar, aunque cambien palabras', !vivo.valorPrimero && !vivo.valor.calco && vivo.valor.destello && vivo.valor.dice === 'hasta el martes', JSON.stringify(vivo));
  ok('deslizarAlto(): el alto viaja en vez de saltar',
    vivo.alto.altos.some((h) => h > vivo.alto.d0 + 1 && h < vivo.alto.final - 1), JSON.stringify(vivo.alto));

  /* deslizarAncho (U9): lo mismo a lo ancho, para un ítem de una fila como la
     statusbar. Se arma una fila con gap, el ítem cambia de texto adentro de
     un relevo (como lo haría la app) y se mide su ancho y la x del vecino en
     cada cuadro: los dos tienen que pasar por valores intermedios, no saltar.
     En Quire, el nombre del documento corría a la página y la medida de un
     cuadro al otro (shell-23). */
  const ancho = await js(`(async () => {
    const m = await import('./js/motion.js');
    if (typeof m.deslizarAncho !== 'function') return { falta: true };
    const fila = document.createElement('div');
    fila.style.cssText = 'position:fixed;left:40px;top:40px;display:flex;gap:16px;z-index:50;font-size:12px';
    fila.innerHTML = '<div class="ox-statusbar__item"><span>Ningún documento</span></div><div>vecino</div>';
    document.body.append(fila);
    const item = fila.firstElementChild; const valor = item.firstElementChild; const vecino = fila.lastElementChild;
    await new Promise((ok) => requestAnimationFrame(ok));
    const w0 = item.getBoundingClientRect().width; const x0 = vecino.getBoundingClientRect().left;
    m.deslizarAncho(item, () => m.swap(valor, 'un documento con un nombre bastante largo.pdf', { relevo: true }));
    const anchos = []; const xs = [];
    for (let i = 0; i < 8; i++) {
      anchos.push(Math.round(item.getBoundingClientRect().width)); xs.push(Math.round(vecino.getBoundingClientRect().left));
      await new Promise((ok) => requestAnimationFrame(ok));
    }
    await new Promise((ok) => setTimeout(ok, 300));
    const r = { w0: Math.round(w0), x0: Math.round(x0), anchos, xs, final: Math.round(item.getBoundingClientRect().width),
      xFinal: Math.round(vecino.getBoundingClientRect().left), retiene: item.getAnimations().length };
    fila.remove();
    return r;
  })()`);
  ok('deslizarAncho(): el ancho viaja en vez de saltar, y el vecino lo acompaña',
    !ancho.falta && ancho.final > ancho.w0 + 20
      && ancho.anchos.some((w) => w > ancho.w0 + 1 && w < ancho.final - 1)
      && ancho.xs.some((x) => x > ancho.x0 + 1 && x < ancho.xFinal - 1)
      && ancho.retiene === 0, JSON.stringify(ancho));

  /* ── 8-terdecies-bis. Al achicarse, primero se va lo de adentro ─────────────
     deslizarAncho y deslizarAlto con un relevo adentro (motion-timing §10).
     Plegándose en el acto, la caja le cortaba a la frase que se iba un pedazo
     cuando todavía estaba casi entera: en el chip de Páginas de Quire, a los
     60 ms 7,5 px con opacidad 0,79. Lo pidieron tres paquetes de la auditoría
     (2C, 2E y 2F), cada uno con su copia local. Se mide cuadro por cuadro lo
     que la caja le recorta al calco y con qué opacidad: mientras el calco se
     ve (≥ 0,3) no le puede recortar nada. Y al crecer, lo nuevo no asoma
     recortado: con la opacidad ya en ≥ 0,5, la caja está casi abierta. */
  console.log('\n8-terdecies-bis. Al achicarse, primero se va lo de adentro');
  const ordenCaja = await js(`(async () => {
    const m = await import('./js/motion.js');
    const cuadro = () => new Promise((ok) => requestAnimationFrame(ok));
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const LARGO = 'un documento con un nombre bastante largo.pdf';
    const fila = () => {
      const f = document.createElement('div');
      f.style.cssText = 'position:fixed;left:40px;top:40px;display:flex;gap:16px;z-index:50;font-size:12px';
      f.innerHTML = '<div class="ox-statusbar__item"><span></span></div><div>vecino</div>';
      document.body.append(f);
      return { f, item: f.firstElementChild, valor: f.firstElementChild.firstElementChild };
    };
    const r = {};

    // Achicar a lo ancho con un relevo adentro.
    {
      const { f, item, valor } = fila();
      m.swap(valor, LARGO);
      await espera(400);
      const w0 = item.getBoundingClientRect().width;
      m.deslizarAncho(item, () => m.swap(valor, 'corto.pdf', { relevo: true }));
      const serie = [];
      for (let i = 0; i < 30; i++) {
        const calco = valor.querySelector('.ox-swap-out--over');
        const ri = item.getBoundingClientRect();
        if (calco) {
          const rc = calco.getBoundingClientRect();
          serie.push({ op: +(+getComputedStyle(calco).opacity).toFixed(2), recorte: +Math.max(0, rc.right - ri.right).toFixed(1), w: Math.round(ri.width) });
        } else serie.push({ op: 0, recorte: 0, w: Math.round(ri.width) });
        await cuadro();
      }
      await espera(200);
      r.achica = { w0: Math.round(w0), final: Math.round(item.getBoundingClientRect().width), retiene: item.getAnimations().length,
        peor: serie.filter((s) => s.op >= 0.3).reduce((a, s) => Math.max(a, s.recorte), 0), serie: serie.slice(0, 16) };
      f.remove();
    }

    // Achicar SIN relevo adentro: no espera (la espera es solo para el relevo).
    {
      const { f, item, valor } = fila();
      valor.textContent = LARGO;
      await cuadro();
      const w0 = item.getBoundingClientRect().width;
      m.deslizarAncho(item, () => { valor.textContent = 'corto.pdf'; });
      await cuadro(); await cuadro(); await cuadro();
      r.sinRelevo = { w0: Math.round(w0), a3: Math.round(item.getBoundingClientRect().width) };
      await espera(300);
      f.remove();
    }

    // Crecer con un relevo adentro: lo nuevo no asoma recortado.
    {
      const { f, item, valor } = fila();
      m.swap(valor, 'corto.pdf');
      await espera(400);
      const w0 = item.getBoundingClientRect().width;
      m.deslizarAncho(item, () => m.swap(valor, LARGO, { relevo: true }));
      const serie = [];
      for (let i = 0; i < 30; i++) {
        const vivo = valor.querySelector(':scope > :not(.ox-swap-out)');
        const ri = item.getBoundingClientRect();
        const rv = vivo.getBoundingClientRect();
        serie.push({ op: +(+getComputedStyle(vivo).opacity).toFixed(2), recorte: +Math.max(0, rv.right - ri.right).toFixed(1) });
        await cuadro();
      }
      await espera(200);
      const final = item.getBoundingClientRect().width;
      const delta = final - w0;
      r.crece = { w0: Math.round(w0), final: Math.round(final),
        peor: +(serie.filter((s) => s.op >= 0.5).reduce((a, s) => Math.max(a, s.recorte), 0) / delta).toFixed(2), serie: serie.slice(0, 12) };
      f.remove();
    }

    // Achicar a lo alto con un relevo adentro (Imprimir, de Múltiple a Simple).
    {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:40px;top:120px;width:300px;z-index:50;font-size:12px;line-height:20px';
      document.body.append(host);
      m.swap(host, '<div>una</div><div>dos</div><div>tres</div><div>cuatro</div><div>cinco</div>');
      await espera(400);
      const h0 = host.getBoundingClientRect().height;
      m.deslizarAlto(host, () => m.swap(host, '<div>una sola</div>', { relevo: true }));
      const serie = [];
      for (let i = 0; i < 30; i++) {
        const calco = host.querySelector('.ox-swap-out--over');
        const rh = host.getBoundingClientRect();
        if (calco) {
          const rc = calco.getBoundingClientRect();
          serie.push({ op: +(+getComputedStyle(calco).opacity).toFixed(2), recorte: +Math.max(0, rc.bottom - rh.bottom).toFixed(1), h: Math.round(rh.height) });
        } else serie.push({ op: 0, recorte: 0, h: Math.round(rh.height) });
        await cuadro();
      }
      await espera(200);
      r.alto = { h0: Math.round(h0), final: Math.round(host.getBoundingClientRect().height), retiene: host.getAnimations().length,
        peor: serie.filter((s) => s.op >= 0.3).reduce((a, s) => Math.max(a, s.recorte), 0), serie: serie.slice(0, 16) };
      host.remove();
    }
    return r;
  })()`);
  if (process.env.ONYX_SERIES) console.log(JSON.stringify(ordenCaja));
  ok('deslizarAncho(): al achicarse no le recorta nada a la frase que se va mientras se ve',
    ordenCaja.achica.final < ordenCaja.achica.w0 - 20 && ordenCaja.achica.peor < 1 && ordenCaja.achica.retiene === 0, JSON.stringify(ordenCaja.achica));
  ok('y la espera es solo con un relevo adentro: sin relevo se pliega en el acto',
    ordenCaja.sinRelevo.a3 < ordenCaja.sinRelevo.w0 - 1, JSON.stringify(ordenCaja.sinRelevo));
  ok('al crecer, lo que llega no asoma recortado (con opacidad ≥ 0,5 la caja ya casi se abrió)',
    ordenCaja.crece.final > ordenCaja.crece.w0 + 20 && ordenCaja.crece.peor <= 0.15, JSON.stringify(ordenCaja.crece));
  ok('deslizarAlto(): al achicarse con un relevo adentro, tampoco recorta lo que se ve',
    ordenCaja.alto.final < ordenCaja.alto.h0 - 20 && ordenCaja.alto.peor < 1 && ordenCaja.alto.retiene === 0, JSON.stringify(ordenCaja.alto));

  /* ── ocupar() y contador() ──────────────────────────────────────────────────
     Las dos nacieron repetidas en Quire. ocupar(): libre ↔ ocupado con relevo
     y el ancho viajando; el estado vive en data-ocupado, así un botón que
     nace ocupado (la vista se repintó en medio del trabajo) no releva su
     propio rótulo. contador(): aparece y se va fundiéndose, cambia en su
     lugar con destello, otra cuenta vacía durante la salida no la corta, y
     un número que vuelve mientras se iba sigue desde su opacidad. */
  const piezas2 = await js(`(async () => {
    const m = await import('./js/motion.js');
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const cuadro = () => new Promise((ok) => requestAnimationFrame(ok));
    const fila = document.createElement('div');
    fila.style.cssText = 'position:fixed;left:40px;top:40px;display:flex;gap:8px;z-index:50';
    fila.innerHTML = '<button class="ox-btn ox-btn--primary" id="t-ocupar">Exportar</button><span>vecino</span>'
      + '<button class="ox-btn ox-btn--primary" data-ocupado="1" id="t-nace">Exportando…</button>'
      + '<span class="ox-navitem__count" id="t-cuenta"></span>';
    document.body.append(fila);
    const b = fila.querySelector('#t-ocupar'); const vecino = b.nextElementSibling;
    const r = {};
    const calcos = (el) => el.querySelectorAll(':scope > .ox-swap-out--over').length;

    const w0 = b.getBoundingClientRect().width; const x0 = vecino.getBoundingClientRect().left;
    m.ocupar(b, true, 'Exportando las 12 páginas…');
    const xs = [];
    for (let i = 0; i < 6; i++) { await cuadro(); xs.push(Math.round(vecino.getBoundingClientRect().left)); }
    r.ocupa = { marca: b.dataset.ocupado, aria: b.getAttribute('aria-busy'), calco: calcos(b) === 1, xs, x0: Math.round(x0) };
    m.ocupar(b, true, 'Exportando las 12 páginas…');
    r.repite = calcos(b);
    await espera(450);
    r.ocupa.final = Math.round(b.getBoundingClientRect().width); r.ocupa.w0 = Math.round(w0);
    r.ocupa.dice = b.querySelector(':scope > :not(.ox-swap-out)')?.textContent;

    const nace = fila.querySelector('#t-nace');
    m.ocupar(nace, true, 'Exportando…');
    r.nace = { calco: calcos(nace), dice: nace.textContent };

    m.ocupar(b, false, 'Exportar');
    r.libera = { marca: b.dataset.ocupado, aria: b.getAttribute('aria-busy'), calco: calcos(b) === 1 };
    await espera(450);
    r.libera.dice = b.textContent.trim();

    const c = fila.querySelector('#t-cuenta');
    m.contador(c, 0);
    r.cero = { hijos: c.childNodes.length, texto: c.textContent };
    m.contador(c, 4);
    r.aparece = { entra: !!c.querySelector('.ox-swap-in'), destello: c.classList.contains('ox-ticked'), texto: c.textContent };
    await espera(350);
    m.contador(c, 12);
    r.cambia = { calco: !!c.querySelector('.ox-swap-out'), destello: c.classList.contains('ox-ticked'), texto: c.textContent };
    await espera(100);
    /* Un número que vuelve mientras el contador se va: lo que se veía tiene
       que seguir desde su opacidad, no cortarse y entrar desde 0 (con swap()
       iba de .93 a 0 en un cuadro). Se muestrea cuadro por cuadro el hijo
       que se ve. Con el MISMO número además pasaba que el textContent
       todavía decía «12» (el que sale), y con esa memoria no se escribía
       nada y el contador quedaba vacío: la memoria es __cuenta. */
    const opDe = () => { const n = [...c.children].filter((k) => k.isConnected);
      return n.length ? +Math.max(...n.map((k) => +getComputedStyle(k).opacity)).toFixed(2) : 0; };
    const vuelve = async (n) => {
      m.contador(c, 0);
      const saliendo = c.querySelector('[data-state="closing"]');
      const v = { sale: !!saliendo, op: [] };
      for (let i = 0; i < 4; i++) { await cuadro(); v.op.push(opDe()); }
      m.contador(c, 0);                       // otro vacío: no hace nada
      for (let i = 0; i < 2; i++) { await cuadro(); v.op.push(opDe()); }
      v.sigue = !!saliendo?.isConnected;
      c.classList.remove('ox-ticked');        // la clase queda puesta del destello anterior
      m.contador(c, n);
      v.destello = c.classList.contains('ox-ticked');
      v.tras = [];
      for (let i = 0; i < 12; i++) { await cuadro(); v.tras.push(opDe()); }
      await espera(250);
      v.texto = c.textContent; v.hijos = c.children.length;
      return v;
    };
    r.seVa = await vuelve(12);
    await espera(400);
    r.otro = await vuelve(7);
    // Y después se puede volver a ir: swap() sabe que hay algo a la vista.
    m.contador(c, 0);
    await espera(400);
    r.final = { texto: c.textContent, hijos: c.children.length };
    fila.remove();
    return r;
  })()`);
  ok('ocupar(): pasa a ocupado con un relevo, marca data-ocupado y aria-busy, y el vecino acompaña',
    piezas2.ocupa.marca === '1' && piezas2.ocupa.aria === 'true' && piezas2.ocupa.calco && piezas2.ocupa.final > piezas2.ocupa.w0 + 20
      && piezas2.ocupa.xs.some((x) => x > piezas2.ocupa.x0 + 1 && x < piezas2.ocupa.x0 + (piezas2.ocupa.final - piezas2.ocupa.w0) - 1)
      && piezas2.ocupa.dice === 'Exportando las 12 páginas…', JSON.stringify(piezas2.ocupa));
  ok('con el mismo estado no hace nada', piezas2.repite === 1, String(piezas2.repite));
  ok('un botón que nace ocupado (data-ocupado="1") no releva su propio rótulo', piezas2.nace.calco === 0 && piezas2.nace.dice === 'Exportando…', JSON.stringify(piezas2.nace));
  ok('y vuelve a libre con otro relevo', piezas2.libera.marca === '0' && piezas2.libera.aria === 'false' && piezas2.libera.calco && piezas2.libera.dice === 'Exportar', JSON.stringify(piezas2.libera));
  ok('contador(): con 0 queda vacío', piezas2.cero.hijos === 0 && piezas2.cero.texto === '', JSON.stringify(piezas2.cero));
  ok('aparece fundiéndose, sin destello (el primer llenado no es un cambio)', piezas2.aparece.entra && !piezas2.aparece.destello && piezas2.aparece.texto === '4', JSON.stringify(piezas2.aparece));
  ok('cambia en su lugar con un destello, sin relevo', !piezas2.cambia.calco && piezas2.cambia.destello && piezas2.cambia.texto === '12', JSON.stringify(piezas2.cambia));
  ok('se va fundiéndose, y otro 0 durante la salida no la corta',
    piezas2.seVa.sale && piezas2.seVa.op.some((o) => o > 0.05 && o < 0.95) && piezas2.seVa.sigue, JSON.stringify(piezas2.seVa));
  // Desde la opacidad en que iba y siempre para arriba, hasta 1.
  const sube = (v) => { const desde = v.op[v.op.length - 1]; const serie = [desde, ...v.tras];
    return desde < 0.9 && serie.every((o, i) => i === 0 || o >= serie[i - 1] - 0.01) && v.tras[v.tras.length - 1] > 0.98; };
  ok('si el mismo número vuelve mientras se va, sigue desde donde iba (sin parpadeo) y queda',
    sube(piezas2.seVa) && piezas2.seVa.texto === '12' && piezas2.seVa.hijos === 1 && !piezas2.seVa.destello, JSON.stringify(piezas2.seVa));
  ok('si vuelve otro número, también sigue desde donde iba, y cambia con destello',
    sube(piezas2.otro) && piezas2.otro.texto === '7' && piezas2.otro.hijos === 1 && piezas2.otro.destello, JSON.stringify(piezas2.otro));
  ok('y después se puede volver a ir', piezas2.final.texto === '' && piezas2.final.hijos === 0, JSON.stringify(piezas2.final));

  /* reconcile() sobre una tabla: las filas que siguen son el MISMO nodo y
     viajan (FLIP); la que se va sale fuera del flujo CON el ancho de sus
     celdas (una fila absoluta pierde el de sus columnas); la nueva entra. */
  const lista = await js(`(async () => {
    const { reconcile } = await import('./js/motion.js');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:40px;top:120px;width:520px;z-index:50;background:var(--ox-bg)';
    host.innerHTML = '<table class="ox-table"><tbody></tbody></table>';
    document.body.append(host);
    const tbody = host.querySelector('tbody');
    const fila = (k) => ({ key: k, html: '<tr class="ox-tr"><td>' + k + '</td><td class="ox-td--num">$ ' + k.charCodeAt(0) * 37 + '</td><td>nota de ' + k + '</td></tr>' });
    reconcile(tbody, ['a', 'b', 'c', 'd'].map(fila), { enter: false });
    const antes = Object.fromEntries([...tbody.children].map((tr) => [tr.dataset.key, tr]));
    const anchosB = [...antes.b.cells].map((c) => Math.round(c.getBoundingClientRect().width));
    reconcile(tbody, ['a', 'c', 'd', 'e'].map(fila));
    const b = antes.b;
    const r = {
      mismos: ['a', 'c', 'd'].every((k) => tbody.querySelector('[data-key="' + k + '"]') === antes[k]),
      bAfuera: getComputedStyle(b).position === 'absolute' && b.dataset.state === 'closing',
      anchosB, anchosBAfuera: [...b.cells].map((c) => Math.round(c.getBoundingClientRect().width)),
      viajan: ['c', 'd'].every((k) => antes[k].getAnimations().length > 0),
      entra: tbody.querySelector('[data-key="e"]')?.getAnimations().length > 0,
    };
    await new Promise((ok) => setTimeout(ok, 600));
    r.orden = [...tbody.children].map((tr) => tr.dataset.key).join('');
    host.remove();
    return r;
  })()`);
  ok('reconcile(): las filas que siguen son el mismo nodo', lista.mismos, JSON.stringify(lista));
  ok('la que se va sale fuera del flujo', lista.bAfuera, JSON.stringify(lista));
  ok('y conserva el ancho de sus celdas mientras se esfuma',
    lista.anchosB.every((w, i) => Math.abs(w - lista.anchosBAfuera[i]) <= 1), JSON.stringify(lista));
  ok('las de abajo viajan a su lugar y la nueva entra', lista.viajan && lista.entra, JSON.stringify(lista));
  ok('al final queda el orden nuevo, sin la que se fue', lista.orden === 'acde', JSON.stringify(lista));

  /* .ox-plegable en una columna: el gap también se pliega de a poco. Antes el
     alto llegaba a 0 y el gap desaparecía de golpe al final (display:none). */
  const pliegueCampo = await js(`(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:40px;top:300px;width:300px;z-index:50';
    host.innerHTML = '<div class="ox-field"><label class="ox-field__label">Cuándo</label><input class="ox-input">'
      + '<span class="ox-field__hint ox-plegable">Esa hora todavía no llegó.</span></div>';
    document.body.append(host);
    const campo = host.firstElementChild;
    const pista = campo.querySelector('.ox-plegable');
    // Recién creada entra desplegándose (@starting-style): se espera a que termine.
    await new Promise((ok) => setTimeout(ok, 450));
    const altos = [Math.round(campo.getBoundingClientRect().height * 10) / 10];
    pista.hidden = true;
    const t0 = performance.now();
    while (performance.now() - t0 < 360) {
      await new Promise((ok) => requestAnimationFrame(ok));
      altos.push(Math.round(campo.getBoundingClientRect().height * 10) / 10);
    }
    host.remove();
    const saltos = altos.slice(1).map((h, i) => Math.round((altos[i] - h) * 10) / 10);
    return { altos, mayor: Math.max(...saltos), total: Math.round((altos[0] - altos[altos.length - 1]) * 10) / 10 };
  })()`);
  ok('una pista plegable se lleva el gap del campo de a poco, sin salto al final',
    pliegueCampo.total > 10 && pliegueCampo.mayor < 6, JSON.stringify(pliegueCampo));

  await swapA('vacio');
  await sleep(400);
  const aparece = await js(`(async () => {
    const box = document.getElementById('demo-swap');
    document.querySelector('#demo-swap-btns [data-swap="resultado"]').click();
    const hijo = box.firstElementChild;
    const op = () => Math.round(+getComputedStyle(hijo).opacity * 100);
    const a0 = op();
    await new Promise((r) => setTimeout(r, 400));
    return { a0, a1: op() };
  })()`);
  ok('lo que aparece se funde (de 0 a 100)', aparece.a0 <= 10 && aparece.a1 === 100, JSON.stringify(aparece));

  const igual = await js(`(async () => {
    const box = document.getElementById('demo-swap');
    const antes = box.firstElementChild;
    document.querySelector('#demo-swap-btns [data-swap="resultado"]').click();
    await new Promise((r) => setTimeout(r, 60));
    return antes.isConnected && box.firstElementChild === antes;
  })()`);
  ok('con el mismo HTML no reemplaza ningún nodo', igual);

  const seVa = await js(`(async () => {
    const box = document.getElementById('demo-swap');
    const hijo = box.firstElementChild;
    document.querySelector('#demo-swap-btns [data-swap="vacio"]').click();
    await new Promise((r) => setTimeout(r, 70));
    const medio = hijo.isConnected ? Math.round(+getComputedStyle(hijo).opacity * 100) : null;
    await new Promise((r) => setTimeout(r, 400));
    return { medio, alFinal: box.children.length };
  })()`);
  ok('lo que se va termina de irse antes de salir del DOM',
    seVa.medio > 5 && seVa.medio < 95 && seVa.alFinal === 0, JSON.stringify(seVa));
  await swapA('pista');

  // El contexto de la titlebar, en la app demo: entra al abrir un ítem y se
  // esfuma al volver a la lista.
  const contexto = await js(`(async () => {
    const R = (await import('./js/router.js')).default;
    const ctx = document.getElementById('titlebar-context');
    const op = (el) => el?.isConnected ? Math.round(+getComputedStyle(el).opacity * 100) : null;
    R.go('item', ${JSON.stringify(id)});
    const entra = ctx.firstElementChild;
    const e0 = op(entra);
    await new Promise((r) => setTimeout(r, 500));
    const e1 = op(entra);
    R.go('items');
    await new Promise((r) => setTimeout(r, 70));
    const s0 = op(entra);
    await new Promise((r) => setTimeout(r, 400));
    return { e0, e1, s0, alFinal: ctx.children.length };
  })()`);
  ok('el contexto de la titlebar entra al abrir un ítem',
    contexto.e0 !== null && contexto.e0 <= 10 && contexto.e1 === 100, JSON.stringify(contexto));
  ok('y se esfuma al volver, en vez de irse de golpe',
    contexto.s0 > 5 && contexto.s0 < 95 && contexto.alFinal === 0, JSON.stringify(contexto));
  await click('[data-view="piezas"]');
  await sleep(700);

  /* ── 8-duodecies. Lo que se prende con `hidden` se pliega ─────────────────
     Con `display: none` a secas, algo que se prende con el.hidden aparece y
     se va de un cuadro al otro y empuja de golpe a lo de al lado (salió de
     Quire 0.9.8: una barra de tinta, un progreso, datos de la statusbar). Se
     mide la demo de la vitrina en cada cuadro, al prender y al apagar: tiene
     que haber medidas intermedias, al apagar tiene que seguir en pantalla
     mientras se va, y en la fila los de al lado no pueden saltar al final. */
  console.log('\n8-duodecies. Mostrar y esconder: .ox-plegable');
  const pliegue = await js(`(async () => {
    const cuadro = () => new Promise((ok) => requestAnimationFrame(ok));
    const serie = async (el, disparar, medir) => {
      disparar();
      const out = []; const t0 = performance.now();
      while (performance.now() - t0 < 320) {
        const cs = getComputedStyle(el);
        out.push({ t: Math.round(performance.now() - t0), med: medir(), op: Math.round(+cs.opacity * 100), display: cs.display });
        await cuadro();
      }
      return out;
    };
    const resumen = (s) => {
      const max = Math.max(...s.map((f) => f.med));
      return { serie: s.map((f) => f.t + ':' + f.med + '/' + f.op).join(' '), max, fin: s.at(-1).med,
        intermedias: s.filter((f) => f.med > 0 && f.med < max).length,
        visibleAlIrse: s[0].display !== 'none' && s[0].op > 50 };
    };
    const alto = document.getElementById('demo-plegable');
    const boton = document.getElementById('demo-plegar');
    const h = () => Math.round(alto.getBoundingClientRect().height);
    const entra = resumen(await serie(alto, () => boton.click(), h));
    await new Promise((r) => setTimeout(r, 150));
    const sale = resumen(await serie(alto, () => boton.click(), h));

    const ancho = document.getElementById('demo-plegable-ancho');
    const ultimo = document.querySelector('#demo-plegable-fila > :last-child');
    const botonAncho = document.getElementById('demo-plegar-ancho');
    const w = () => Math.round(ancho.getBoundingClientRect().width);
    /* El último chip, en cada cuadro, junto con si el del medio ya pasó a
       display:none. Lo que importa es el paso de ESE cuadro: a mitad del
       pliegue el vecino se mueve rápido (hasta ~18 px por cuadro) y está bien;
       un salto justo al desaparecer es el hueco del gap que no se descontó. */
    const xs = [];
    const saleAncho = resumen(await serie(ancho, () => botonAncho.click(), () => {
      xs.push({ x: ultimo.getBoundingClientRect().left, fuera: getComputedStyle(ancho).display === 'none' });
      return w();
    }));
    const k = xs.findIndex((f) => f.fuera);
    const salto = k > 0 ? Math.abs(xs[k].x - xs[k - 1].x) : Infinity;
    await new Promise((r) => setTimeout(r, 150));
    const entraAncho = resumen(await serie(ancho, () => botonAncho.click(), w));
    return { entra, sale, saleAncho, entraAncho, salto: Math.round(salto * 10) / 10, xs: xs.map((f) => Math.round(f.x) + (f.fuera ? '*' : '')).join(' ') };
  })()`);
  const plegado = (quien, r, alIrse) => {
    ok(`${quien}: pasa por medidas intermedias`, r.intermedias >= 2, r.serie);
    if (alIrse) ok(`${quien}: sigue en pantalla mientras se va`, r.visibleAlIrse, r.serie);
  };
  plegado('alto, al mostrar', pliegue.entra);
  plegado('alto, al esconder', pliegue.sale, true);
  ok('escondido no ocupa lugar', pliegue.sale.fin === 0, pliegue.sale.serie);
  plegado('ancho, al esconder', pliegue.saleAncho, true);
  plegado('ancho, al mostrar', pliegue.entraAncho);
  ok('en la fila, los de al lado no saltan cuando el plegado se va', pliegue.salto <= 2, `salto en ese cuadro: ${pliegue.salto} px (${pliegue.xs})`);
  const statEscondido = await js(`(() => { const el = document.getElementById('stat-saved');
    el.hidden = true; const d = getComputedStyle(el).display; el.hidden = false; return d; })()`);
  ok('un ítem de la statusbar con hidden se esconde de verdad', statEscondido === 'none', statEscondido);

  /* ── 8-duodecies-bis. Lo plegado de un .ox-reveal sale del Tab ──────────
     Salió de Chem Engine (octubre de 2026): con alto 0, los botones de adentro
     de un revelado cerrado seguían enfocables —el panel del átomo dejaba
     catorce paradas invisibles— y el foco desaparecía en la nada. Cerrado,
     nada de adentro toma el foco; abierto, sí. Y un ghost que es interruptor
     (.is-active) se ve distinto de uno apagado. */
  console.log('\n8-duodecies-bis. Lo plegado de un revelado sale del Tab');
  const revelado = await js(`(async () => {
    const rev = document.getElementById('demo-reveal');
    const boton = document.getElementById('demo-reveal-boton');
    const enfoca = () => { boton.focus(); const si = document.activeElement === boton; boton.blur(); return si; };
    const cerrado = { abierto: rev.classList.contains('is-open'), vis: getComputedStyle(rev).visibility, foco: enfoca() };
    document.getElementById('demo-revelar').click();
    await new Promise((r) => setTimeout(r, 400));
    const abierto = { abierto: rev.classList.contains('is-open'), vis: getComputedStyle(rev).visibility, foco: enfoca() };
    document.getElementById('demo-revelar').click();
    await new Promise((r) => setTimeout(r, 400));
    const otraVez = { vis: getComputedStyle(rev).visibility, foco: enfoca() };
    const fondo = (el) => getComputedStyle(el).backgroundColor;
    const ghost = document.querySelector('.ox-btn--ghost:not(.is-active):not(:hover)');
    const prendido = document.getElementById('demo-ghost-interruptor');
    return { cerrado, abierto, otraVez, ghost: fondo(ghost), prendido: fondo(prendido) };
  })()`);
  ok('cerrado, lo de adentro no toma el foco', !revelado.cerrado.abierto && revelado.cerrado.vis === 'hidden' && !revelado.cerrado.foco, JSON.stringify(revelado.cerrado));
  ok('abierto, sí', revelado.abierto.abierto && revelado.abierto.vis === 'visible' && revelado.abierto.foco, JSON.stringify(revelado.abierto));
  ok('y al volver a cerrarse, de nuevo no', revelado.otraVez.vis === 'hidden' && !revelado.otraVez.foco, JSON.stringify(revelado.otraVez));
  ok('un ghost prendido (.is-active) se ve distinto de uno apagado', revelado.prendido !== revelado.ghost, `${revelado.ghost} vs ${revelado.prendido}`);

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
    return { scrollbar: r.includes('::-webkit-scrollbar'), seleccion: r.includes('::selection'), focus: r.includes(':focus-visible'),
      // Lo que se estira (resize) pinta el agarrador de Chromium en la esquina
      // salvo que haya uno propio.
      estiran: [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).resize !== 'none').length,
      agarrador: r.includes('::-webkit-resizer') }; })()`);
  ok('scrollbar propia', reglas.scrollbar);
  ok('::selection propia', reglas.seleccion);
  ok('focus ring propio (:focus-visible)', reglas.focus);
  ok('agarrador de estirar propio (::-webkit-resizer)', reglas.estiran === 0 || reglas.agarrador, JSON.stringify(reglas));

  /* ── 9-bis. Ningún anillo de foco se corta ─────────────────────────────────
     El anillo de base.css sale 3.5px por fuera del elemento. Si el elemento se
     ve entero pero esos 3.5px caen afuera de un contenedor que recorta (un
     .ox-scroll, el borde de la ventana) o encima del canto de una superficie
     (una card, el carril del segmentado), con Tab se ve cortado: pasó en los
     controles de ventana, el primer ítem del rail, el segmentado y las filas
     de una tabla de borde a borde (Apex, sep 2026). Cada elemento se enfoca
     como con teclado y se mide su anillo real (solo las sombras duras: una
     difusa es elevación, no anillo), así los que van hacia adentro cuentan
     cero. Las filas de tabla se prueban como si tuvieran tabindex, porque las
     apps se lo ponen. */
  console.log('\n9-bis. Ningún anillo de foco se corta');
  const AUDITAR_ANILLOS = `((scope) => {
  if (!document.getElementById('aud-notr')) document.head.insertAdjacentHTML('beforeend', '<style id="aud-notr">*,*::before{transition:none!important}</style>');
  // Cuánto sale el anillo REAL por fuera del elemento: se lo enfoca como con
  // teclado y se leen sus sombras de afuera y su outline.
  const extent = (el) => {
    el.focus({ focusVisible: true, preventScroll: true });
    const s = getComputedStyle(el);
    let m = 0;
    for (const part of s.boxShadow.split(/,(?![^(]*\\))/)) {
      if (part.includes('inset') || part.trim() === 'none') continue;
      const nums = part.replace(/rgba?\\([^)]*\\)|oklch\\([^)]*\\)/g, '').match(/-?[\\d.]+px/g) || [];
      const [x = 0, y = 0, blur = 0, spread = 0] = nums.map(parseFloat);
      if (blur > 0) continue;   // una sombra difusa (elevación, brillo) no es el anillo
      m = Math.max(m, spread + Math.max(Math.abs(x), Math.abs(y)));
    }
    if (s.outlineStyle !== 'none' && !/rgba\\(0, 0, 0, 0\\)/.test(s.outlineColor)) m = Math.max(m, parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset));
    el.blur();
    return m;
  };
  const SEL = 'a[href],button:not([disabled]):not([tabindex="-1"]),input:not([disabled]):not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const name = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
    const txt = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
    return el.tagName.toLowerCase() + id + cls + (txt ? ' «' + txt + '»' : '');
  };
  const out = [];
  for (const el of scope.querySelectorAll(SEL)) {
    if (el.closest('[inert],[hidden],[aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const R = extent(el);
    if (R <= 0.5) continue;
    const boxes = [{ who: 'ventana', l: 0, t: 0, r: innerWidth, b: innerHeight }];
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.clipPath !== 'none' || /paint|strict|content/.test(s.contain)) {
        const ar = a.getBoundingClientRect();
        const l = ar.left + a.clientLeft; const t = ar.top + a.clientTop;
        boxes.push({ who: name(a), l, t, r: l + a.clientWidth, b: t + a.clientHeight });
      }
    }
    const e = 0.5;
    // ¿Roza el canto de una superficie (card, panel, modal)? Un fondo o una
    // sombra con radio: el anillo se pisa con su borde aunque nada lo recorte.
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      const surf = (s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.boxShadow !== 'none') && parseFloat(s.borderTopLeftRadius) > 0;
      if (!surf) continue;
      const ar = a.getBoundingClientRect();
      const g = [r.left - ar.left, r.top - ar.top, ar.right - r.right, ar.bottom - r.bottom];
      if (g.some((x) => x < -e)) continue;
      const lados = ['izq', 'arriba', 'der', 'abajo'].filter((_, i) => g[i] < R - e).map((n, i) => n);
      const det = g.map((x, i) => ['izq', 'arriba', 'der', 'abajo'][i] + ' ' + x.toFixed(1)).filter((_, i) => g[i] < R - e);
      if (det.length) { out.push(name(el) + '  roza ' + name(a) + '  [' + det.join(', ') + ']'); break; }
    }
    for (const bx of boxes) {
      const inside = r.left >= bx.l - e && r.top >= bx.t - e && r.right <= bx.r + e && r.bottom <= bx.b + e;
      if (!inside) break;   // el elemento mismo ya está recortado: no es culpa del anillo
      const lados = [];
      if (r.left - R < bx.l - e) lados.push('izq ' + (r.left - bx.l).toFixed(1));
      if (r.top - R < bx.t - e) lados.push('arriba ' + (r.top - bx.t).toFixed(1));
      if (r.right + R > bx.r + e) lados.push('der ' + (bx.r - r.right).toFixed(1));
      if (r.bottom + R > bx.b + e) lados.push('abajo ' + (bx.b - r.bottom).toFixed(1));
      if (lados.length) { out.push(name(el) + '  ← ' + bx.who + '  [' + lados.join(', ') + ']'); break; }
    }
  }
  document.querySelectorAll('.ox-scroll, .ox-main, [class*="scroll"]').forEach((s) => { s.scrollTop = 0; s.scrollLeft = 0; });
  return out;
})(document)`;
  // Sin foco en la ventana, :focus-visible no se aplica y todo anillo mide
  // cero: la auditoría pasaría sin haber medido nada. Hoy lo trae el
  // win.focus() de la prueba del puntero; esto no depende de que siga ahí.
  win.focus();
  win.webContents.focus();
  await sleep(150);
  ok('la ventana tiene el foco (si no, no hay anillos que medir)', await js('document.hasFocus()'));
  for (const v of ['inicio', 'items', 'piezas', 'ajustes']) {
    await click(`[data-view="${v}"]`);
    await sleep(700);
    await js(`document.querySelectorAll('#view tbody tr').forEach((tr) => tr.tabIndex = 0)`);
    const cortes = await js(AUDITAR_ANILLOS);
    ok(`${v}: ningún anillo de foco se corta ni roza un canto`, cortes.length === 0, '\n      ' + cortes.join('\n      '));
  }
  // Una lista que va de borde a borde de un .ox-scroll, en la columna de una
  // vista con inspector: ahí la sangría la lleva __main y el scroll recorta
  // justo en el borde de la fila (salió en Idiolect). La vitrina no lo arma,
  // así que se arma acá y se audita solo.
  const listaAlBorde = await js(`(() => {
    const caja = document.createElement('div');
    caja.className = 'ox-viewbody';
    caja.innerHTML = '<div class="ox-viewbody__main"><div class="ox-scroll ox-grow" id="aud-lista"><div class="ox-list"><div class="ox-listitem" tabindex="0"><div class="ox-listitem__main"><span class="ox-listitem__title">Fila al borde</span></div></div></div></div></div><aside class="ox-inspector"></aside>';
    document.getElementById('view').prepend(caja);
    const out = ${AUDITAR_ANILLOS.replace('(document)', "(document.getElementById('aud-lista'))")};
    caja.remove();
    return out;
  })()`);
  ok('una .ox-listitem al borde de un .ox-scroll no corta su anillo', listaAlBorde.length === 0, '\n      ' + listaAlBorde.join('\n      '));
  await js(`document.getElementById('aud-notr')?.remove()`);

  /* ── 9-ter. El relevo de vistas ────────────────────────────────────────────
     Primero la vista vieja se iba de un cuadro al otro y la nueva arrancaba
     desde transparente: un cuadro vacío. Después la vieja pasó a un calco que
     se esfumaba encima, pero la nueva esperaba 90 ms invisible y entraba
     corrida 10 px: la pantalla bajaba a un tercio de tapada y volvía (en
     Quire, con las hojas blancas de un PDF, un parpadeo) y lo que las dos
     vistas comparten en el mismo lugar temblaba. Ahora es un fundido: la
     nueva ya está entera y quieta DEBAJO del calco, que es opaco. Se muestrea
     cada 40 ms y se mide cuánto está tapada la pantalla, no se mira. */
  console.log('\n9-ter. El relevo de vistas');
  await click('[data-view="ajustes"]');
  await sleep(700);
  const relevoVistas = await js(`(async () => {
    const view = document.getElementById('view');
    const rv = view.getBoundingClientRect();
    document.querySelector('.ox-navitem[data-view="inicio"]').click();
    const op = (el) => el?.isConnected ? Math.round(+getComputedStyle(el).opacity * 100) : null;
    const calco = document.querySelector('.ox-main--saliente');
    const cc = calco && getComputedStyle(calco);
    // El fondo sale de un token OKLCH: se mide el alfa pintándolo, no parseándolo.
    const alfa = (color) => { const c = document.createElement('canvas').getContext('2d');
      c.fillStyle = color; c.fillRect(0, 0, 1, 1); return c.getImageData(0, 0, 1, 1).data[3]; };
    const opaco = !!cc && alfa(cc.backgroundColor) === 255;
    const encima = !!calco && +cc.zIndex > 0 && view.compareDocumentPosition(calco) === Node.DOCUMENT_POSITION_FOLLOWING;
    const filas = [];
    for (let t = 0; t <= 400; t += 40) {
      const rc = calco?.getBoundingClientRect();
      const viejo = op(calco); const nuevo = op(view);
      filas.push({ t, viejo, nuevo,
        tapado: Math.round(viejo == null ? nuevo : viejo + (100 - viejo) * nuevo / 100),
        quieta: getComputedStyle(view).transform === 'none',
        mismoLugar: !rc || !calco.isConnected || (rc.left === rv.left && rc.top === rv.top && rc.width === rv.width && rc.height === rv.height),
        views: document.querySelectorAll('#view').length });
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 500));
    return { filas, hayCalco: !!calco, opaco, encima,
      animaciones: view.getAnimations().length, calcos: document.querySelectorAll('.ox-main--saliente').length };
  })()`);
  const sv = relevoVistas.filas.map((f) => `${f.t}:${f.viejo ?? '-'}/${f.nuevo}`).join(' ');
  ok('al navegar, la vista vieja queda en un calco', relevoVistas.hayCalco, JSON.stringify(relevoVistas));
  ok('el calco es opaco y va encima (tapa a la nueva mientras se va)', relevoVistas.opaco && relevoVistas.encima, JSON.stringify(relevoVistas));
  ok('que se esfuma de a poco (no se va de un cuadro al otro)', relevoVistas.filas.some((f) => f.viejo > 5 && f.viejo < 95), sv);
  ok('la pantalla no se destapa en ningún momento (sin parpadeo)', relevoVistas.filas.every((f) => f.tapado >= 97), sv);
  ok('la nueva no se corre mientras entra (sin temblor)', relevoVistas.filas.every((f) => f.quieta), sv);
  ok('las dos en la misma celda, sin salto', relevoVistas.filas.every((f) => f.mismoLugar), sv);
  ok('un solo #view en todo el relevo', relevoVistas.filas.every((f) => f.views === 1), sv);
  ok('el calco se va del DOM al terminar', relevoVistas.calcos === 0, JSON.stringify(relevoVistas));
  ok('y la nueva no retiene ninguna animación', relevoVistas.animaciones === 0, JSON.stringify(relevoVistas));

  /* Lo que la vista vieja tenía con entrada PROPIA no vuelve a entrar en el
     calco. Mover un nodo le reinicia las animaciones CSS, y un bloque que ya
     estaba quieto caía a 0 en el primer cuadro y reaparecía mientras la vista
     se esfumaba (salió en Chem Engine, con la ficha de identidad). Se planta
     un bloque con fundido propio, se lo deja terminar, y se navega. */
  await click('[data-view="ajustes"]');
  await sleep(700);
  const propia = await js(`(async () => {
    const b = document.createElement('div');
    b.textContent = 'bloque con entrada propia';
    b.style.animation = 'ox-fade-in 280ms both';
    document.querySelector('#view .ox-scroll').prepend(b);
    await new Promise((r) => setTimeout(r, 450));
    document.querySelector('.ox-navitem[data-view="inicio"]').click();
    const calco = document.querySelector('.ox-main--saliente');
    const filas = [];
    for (let t = 0; t <= 120; t += 20) {
      filas.push({ t, calco: Math.round(+getComputedStyle(calco).opacity * 100), bloque: Math.round(+getComputedStyle(b).opacity * 100) });
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 400));
    return filas;
  })()`);
  ok('un bloque con entrada propia no vuelve a entrar adentro del calco',
    propia.every((f) => f.bloque >= 99), propia.map((f) => `${f.t}:${f.calco}/${f.bloque}`).join(' '));

  /* Dos navegaciones seguidas, antes de que termine el primer fundido. El
     calco nuevo va DEBAJO de los que todavía se están yendo: la pantalla del
     instante siguiente es la misma composición que la del anterior (lo que se
     iba sigue a la misma opacidad, encima de la vista que acaba de calcarse).
     Encima de todos, el calco nuevo —opaco— tapaba de un cuadro al otro lo que
     se iba a mitad de camino: un corte. Salió de Quire, que lo tenía así.
     La segunda navegación va a los 90 ms y no a los 60: dentro de los 60 ms
     de un calco go() ya no calca (lo intermedio no se llegó a ver, 9-septies),
     y con 60 justos el test caía en el umbral. */
  await click('[data-view="ajustes"]');
  await sleep(700);
  const seguidas = await js(`(async () => {
    const vistas = [...document.querySelectorAll('.ox-navitem[data-view]')].map((b) => b.dataset.view)
      .filter((v) => v !== 'ajustes');
    // Cuánto de cada calco se ve, de arriba hacia abajo (después en el DOM = encima).
    const pesos = () => {
      const w = new Map(); let resto = 1;
      for (const c of [...document.querySelectorAll('.ox-main--saliente')].reverse()) {
        const a = +getComputedStyle(c).opacity; w.set(c, resto * a); resto *= 1 - a;
      }
      return w;
    };
    document.querySelector('.ox-navitem[data-view="' + vistas[0] + '"]').click();
    const primero = document.querySelector('.ox-main--saliente');
    await new Promise((r) => setTimeout(r, 90));
    const antes = pesos().get(primero);
    document.querySelector('.ox-navitem[data-view="' + vistas[1] + '"]').click();
    const despues = pesos().get(primero);
    await new Promise((r) => setTimeout(r, 600));
    return { vistas: vistas.slice(0, 2), antes: Math.round(antes * 100), despues: Math.round((despues ?? 0) * 100),
      calcos: document.querySelectorAll('.ox-main--saliente').length };
  })()`);
  ok('navegar dos veces seguidas no corta el fundido que estaba en curso',
    seguidas.antes > 20 && Math.abs(seguidas.antes - seguidas.despues) <= 5 && seguidas.calcos === 0, JSON.stringify(seguidas));

  /* ── 9-quater. Repintar la misma vista ─────────────────────────────────────
     Router.refresh() (después de guardar, duplicar, borrar) repintaba en seco
     con innerHTML: lo viejo se iba en un cuadro, todo lo que tenía entrada
     propia volvía a entrar, los contadores volvían a contar desde 0, el scroll
     volvía arriba y las cápsulas nacían de cero. Lo encontró la auditoría de
     Finway y Apex. Ahora es el mismo fundido que navegar, con lo nuevo
     asentado debajo. Se mide sobre una vista de prueba, para no depender de
     qué datos haya en disco. */
  console.log('\n9-quater. Repintar la misma vista');
  const repinte = await js(`(async () => {
    const { Router } = await import('./js/router.js');
    const { paint } = await import('./js/ui.js');
    const { countTo, bindSwitcher } = await import('./js/motion.js');
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const cuadro = () => new Promise((r) => requestAnimationFrame(r));
    Router.define({ 'prueba-repinte': { view: () => {
      paint('<div class="ox-scroll ox-grow">'
        + '<div class="ox-segmented" id="rp-seg"><button class="ox-segmented__opt is-active" data-value="a">Uno</button>'
        + '<button class="ox-segmented__opt" data-value="b">Dos, más largo</button></div>'
        + '<div class="ox-stat"><span class="ox-stat__value" id="rp-n">0</span></div>'
        + '<div class="ox-empty" id="rp-vacio"><div class="ox-empty__title">Nada todavía</div></div>'
        + '<div style="height:2400px"></div></div>');
      bindSwitcher(document.getElementById('rp-seg'));
      countTo(document.getElementById('rp-n'), 1284);
    } } });
    Router.go('prueba-repinte');
    // La cápsula nace donde va: antes la primera medida llegaba en raf2 y
    // nacía en ancho 0 contra la izquierda, y crecía.
    const capAlNacer = parseFloat(getComputedStyle(document.getElementById('rp-seg'), '::before').width);
    await espera(1200);
    const view = document.getElementById('view');
    view.querySelector('.ox-scroll').scrollTop = 500;
    await espera(100);
    const scrollAntes = view.querySelector('.ox-scroll').scrollTop;
    Router.refresh();
    const calco = document.querySelector('.ox-main--saliente');
    const cc = calco && getComputedStyle(calco);
    const alfa = (color) => { const c = document.createElement('canvas').getContext('2d');
      c.fillStyle = color; c.fillRect(0, 0, 1, 1); return c.getImageData(0, 0, 1, 1).data[3]; };
    const r = { capAlNacer, scrollAntes, hayCalco: !!calco,
      opaco: !!cc && alfa(cc.backgroundColor) === 255, filas: [] };
    await Promise.resolve();
    const vacio = document.getElementById('rp-vacio');
    const n = document.getElementById('rp-n');
    const seg = document.getElementById('rp-seg');
    const t0 = performance.now();
    while (performance.now() - t0 < 360) {
      const viejo = calco?.isConnected ? +getComputedStyle(calco).opacity * 100 : null;
      const nuevo = +getComputedStyle(view).opacity * 100;
      r.filas.push({ t: Math.round(performance.now() - t0),
        tapado: Math.round(viejo == null ? nuevo : viejo + (100 - viejo) * nuevo / 100),
        viejo: viejo == null ? null : Math.round(viejo),
        vacio: Math.round(+getComputedStyle(vacio).opacity * 100),
        n: n.textContent,
        cap: Math.round(parseFloat(getComputedStyle(seg, '::before').width)),
        scroll: Math.round(view.querySelector('.ox-scroll').scrollTop) });
      await cuadro();
    }
    await espera(300);
    r.calcos = document.querySelectorAll('.ox-main--saliente').length;
    Router.go('inicio');
    await espera(500);
    return r;
  })()`);
  const sp = repinte.filas.map((f) => `${f.t}:${f.viejo ?? '-'}/${f.vacio}/${f.n}/${f.cap}/${f.scroll}`).join(' ');
  ok('la cápsula de un segmentado nace en su lugar, no en ancho 0', repinte.capAlNacer > 0, JSON.stringify(repinte));
  ok('repintar la misma vista deja lo de antes en un calco opaco', repinte.hayCalco && repinte.opaco, JSON.stringify(repinte));
  ok('que se esfuma de a poco, sin destapar la pantalla',
    repinte.filas.some((f) => f.viejo > 5 && f.viejo < 95) && repinte.filas.every((f) => f.tapado >= 97), sp);
  ok('lo que tiene entrada propia no vuelve a entrar (el vacío queda entero)', repinte.filas.every((f) => f.vacio >= 99), sp);
  ok('los contadores no vuelven a contar desde 0', repinte.filas.every((f) => f.n === '1284'), sp);
  ok('la cápsula no vuelve a nacer en ancho 0', repinte.filas.every((f) => f.cap > 0), sp);
  ok('y el scroll queda donde estaba', repinte.filas.every((f) => Math.abs(f.scroll - repinte.scrollAntes) <= 1), sp);
  ok('el calco se va del DOM al terminar', repinte.calcos === 0, JSON.stringify(repinte.calcos));

  /* ── 9-quinquies. Repintar no vuelve a desplegar lo plegable (U8) ─────────
     Un .ox-plegable que nace visible se despliega desde 0 con una transición
     (@starting-style), y repintar() daba por terminadas las animaciones pero
     no las transiciones: la barra que ya estaba crecía de 0 a su alto debajo
     del fundido y empujaba lo de abajo (Quire, la barra de tinta al cambiar
     de documento, css-13). Se mide el alto en cada cuadro desde el primero,
     en los dos caminos: sin nada que fuerce el estilo antes, y con una
     cápsula que vuelve a su lugar (colocar() fuerza el estilo antes de
     asentar, y la transición ya arrancó). Y uno que se prende DESPUÉS con
     `hidden = false` se tiene que seguir desplegando. */
  console.log('\n9-quinquies. Repintar no vuelve a desplegar lo plegable');
  const plegRepinte = await js(`(async () => {
    const { Router } = await import('./js/router.js');
    const { paint } = await import('./js/ui.js');
    const { bindSwitcher } = await import('./js/motion.js');
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const cuadro = () => new Promise((r) => requestAnimationFrame(r));
    let conCapsula = false;
    Router.define({ 'prueba-plegable': { view: () => {
      paint('<div class="ox-scroll ox-grow">'
        + (conCapsula ? '<div class="ox-segmented" id="pl-seg"><button class="ox-segmented__opt is-active" data-value="a">Uno</button>'
          + '<button class="ox-segmented__opt" data-value="b">Dos, más largo</button></div>' : '')
        + '<div class="ox-plegable" id="pl-barra"><div style="height:40px">barra</div></div>'
        + '<div class="ox-plegable" id="pl-otra" hidden><div style="height:40px">otra</div></div>'
        + '<div style="height:20px">abajo</div></div>');
      if (conCapsula) bindSwitcher(document.getElementById('pl-seg'));
    } } });
    const serie = async (id) => {
      const out = []; const t0 = performance.now();
      while (performance.now() - t0 < 300) { out.push(Math.round(document.getElementById(id).getBoundingClientRect().height)); await cuadro(); }
      return out;
    };
    Router.go('prueba-plegable');
    await espera(600);
    Router.refresh();
    const sinCapsula = await serie('pl-barra');
    conCapsula = true;
    Router.refresh();
    await espera(600);
    Router.refresh();
    const conCapsulaSerie = await serie('pl-barra');
    await espera(300);
    document.getElementById('pl-otra').hidden = false;
    const despues = await serie('pl-otra');
    Router.go('inicio');
    await espera(500);
    // Al navegar no corre sola: la vista que no quiere desplegarse debajo del
    // calco llama a asentarPlegables() después de pintar (como el lector de
    // Quire con la barra de tinta). Sola, sin el finish() de repintar.
    const { asentarPlegables } = await import('./js/motion.js');
    Router.define({ 'prueba-plegable-nav': { view: () => {
      paint('<div class="ox-scroll ox-grow"><div class="ox-plegable" id="pl-nav"><div style="height:40px">barra</div></div></div>');
      asentarPlegables?.(document.getElementById('view'));
    } } });
    Router.go('prueba-plegable-nav');
    const alNavegar = await serie('pl-nav');
    Router.go('inicio');
    await espera(500);
    return { sinCapsula, conCapsula: conCapsulaSerie, despues, alNavegar };
  })()`);
  ok('al repintar, un plegable visible tiene su alto desde el primer cuadro',
    plegRepinte.sinCapsula.every((h) => h === 40), plegRepinte.sinCapsula.join(' '));
  ok('también si algo forzó el estilo antes de asentar (una cápsula que vuelve a su lugar)',
    plegRepinte.conCapsula.every((h) => h === 40), plegRepinte.conCapsula.join(' '));
  ok('y uno que se prende después se sigue desplegando',
    plegRepinte.despues.some((h) => h > 0 && h < 40) && plegRepinte.despues.at(-1) === 40, plegRepinte.despues.join(' '));
  ok('al navegar, asentarPlegables() después de pintar lo deja en su alto desde el primer cuadro',
    plegRepinte.alNavegar.every((h) => h === 40), plegRepinte.alNavegar.join(' '));

  /* ── 9-sexies. La vista nueva no se asoma por encima del calco (U2) ───────
     El calco del router es z-index 1, y la vista nueva no era un contexto de
     apilamiento: un hijo suyo con z-index 2 (el panel de miniaturas del
     lector de Quire, css-01; el th sticky de una tabla que no scrollea) le
     ganaba en la raíz y se veía entero desde el primer cuadro. Se congela el
     fundido a los 60 ms (el calco va por ~85 %) con un hijo blanco de
     z-index 2 y se mide el píxel: tiene que ser el calco a su opacidad, no el
     blanco. Y `isolation` no tiene que romper ningún vidrio: uno de adentro
     de la vista sigue esmerilando, y el scrim de un modal también. */
  console.log('\n9-sexies. La vista nueva no se asoma por encima del calco');
  await js(`(async () => {
    const { Router } = await import('./js/router.js');
    const { paint } = await import('./js/ui.js');
    Router.define({
      'prueba-z-a': { view: () => paint('<div style="height:8px"></div>') },
      'prueba-z-b': { view: () => paint('<div id="pz-claro" style="position:relative;z-index:2;margin:40px;width:240px;height:160px;background:#fff"></div>') },
      'prueba-vidrio': { view: () => paint('<div id="pv-rayas" style="position:relative;margin:40px;width:480px;height:160px;'
        + 'background:repeating-linear-gradient(90deg,#fff 0 2px,#000 2px 4px)">'
        + '<div id="pv-envol" style="position:absolute;left:0;top:0;width:240px;height:160px">'
        + '<div style="position:absolute;inset:0;backdrop-filter:blur(6px)"></div></div></div>') },
    });
    return true;
  })()`);
  /* El calco se va solo a los 260 ms (el respaldo de exit(), que lo saca
     aunque sus animaciones estén pausadas): la foto tiene que llegar antes.
     Con la máquina cargada capturePage puede llegar tarde, ver el blanco y
     dar una falla sin bug. Si cuando volvió la foto el calco ya no estaba, la
     medición no vale y se repite (un calco que se fue no vuelve, así que si
     sigue ahí, estaba en la foto). */
  let zr = null; let zConCalco = null; let zValida = false; let zIntentos = 0;
  while (!zValida && zIntentos < 3) {
    zIntentos++;
    await js(`(async () => { (await import('./js/router.js')).Router.go('prueba-z-a'); return true; })()`);
    await sleep(700);
    zr = await js(`(async () => {
      const { Router } = await import('./js/router.js');
      Router.go('prueba-z-b');
      const calco = window.__zCalco = document.querySelector('.ox-main--saliente');
      for (const a of calco?.getAnimations() ?? []) { a.pause(); a.currentTime = 60; }
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      const c = document.getElementById('pz-claro').getBoundingClientRect();
      return { op: calco?.isConnected ? +getComputedStyle(calco).opacity : null, x: c.left, y: c.top, w: c.width, h: c.height };
    })()`);
    zConCalco = await brillo({ x: zr.x + 20, y: zr.y + 20, width: zr.w - 40, height: zr.h - 40 });
    zValida = zr.op != null && await js(`!!window.__zCalco?.isConnected`);
  }
  const zClaro = { x: zr.x + 20, y: zr.y + 20, width: zr.w - 40, height: zr.h - 40 };
  const zFondo = await brillo({ x: zr.x + zr.w + 60, y: zClaro.y, width: 100, height: zClaro.height });
  await sleep(500);
  const zSolo = await brillo(zClaro);
  await js(`delete window.__zCalco; true`);
  // Cuánto del calco hay en el píxel: 1 = el fondo opaco del calco, 0 = el blanco de abajo.
  const zCalco = (zSolo.media - zConCalco.media) / Math.max(1, zSolo.media - zFondo.media);
  ok('un hijo de z-index 2 de la vista nueva queda DEBAJO del calco (el píxel es el calco a su opacidad)',
    zValida && zr.op > 0.5 && zCalco >= zr.op - 0.03,
    JSON.stringify({ calco: zr.op, enElPixel: +zCalco.toFixed(3), zConCalco, zFondo, zSolo, intentos: zIntentos,
      ...(zValida ? {} : { invalida: 'en los 3 intentos el calco se fue antes de la foto: la máquina está muy cargada, no es el z-index' }) }));

  // El vidrio: rayas de 2 px, la mitad izquierda debajo de un backdrop-filter.
  const pv = await js(`(async () => {
    const { Router } = await import('./js/router.js');
    Router.go('prueba-vidrio');
    await new Promise((r) => setTimeout(r, 700));
    const r = document.getElementById('pv-rayas').getBoundingClientRect();
    return { x: r.left, y: r.top, iso: getComputedStyle(document.getElementById('view')).isolation };
  })()`);
  const bajoVidrio = { x: pv.x + 40, y: pv.y + 40, width: 160, height: 80 };
  const vidrio = { iso: pv.iso, bajo: await brillo(bajoVidrio), fuera: await brillo({ x: pv.x + 280, y: pv.y + 40, width: 160, height: 80 }) };
  // Control: con una frontera de backdrop conocida (opacidad < 1 en el
  // envoltorio transparente) el vidrio no tiene nada que esmerilar.
  await js(`document.getElementById('pv-envol').style.opacity = '.999'; true`);
  await sleep(200);
  vidrio.roto = await brillo(bajoVidrio);
  await js(`document.getElementById('pv-envol').style.opacity = ''; true`);
  await js(`(async () => { const { Modal } = await import('./js/overlays.js'); Modal.show({ title: 'Vidrio', width: 200 }); return true; })()`);
  await sleep(600);
  const zonaScrim = { x: pv.x + 280, y: pv.y + 20, width: 120, height: 40 };
  vidrio.scrim = await brillo(zonaScrim);
  await js(`document.querySelector('.ox-scrim:not([data-state])').style.backdropFilter = 'none'; true`);
  await sleep(150);
  vidrio.scrimSinBlur = await brillo(zonaScrim);
  await js(`(async () => { const { Modal } = await import('./js/overlays.js'); Modal.close(null); return true; })()`);
  await sleep(400);
  ok('con la vista aislada, un vidrio de adentro sigue esmerilando lo que tiene detrás',
    vidrio.iso === 'isolate' && vidrio.bajo.desvio < 10 && vidrio.fuera.desvio > 100, JSON.stringify(vidrio));
  ok('(y la medida distingue un vidrio roto: con una frontera de backdrop no esmerila)', vidrio.roto.desvio > 100, JSON.stringify(vidrio.roto));
  ok('y el scrim de un modal sigue esmerilando la vista', vidrio.scrim.desvio < 10 && vidrio.scrimSinBlur.desvio > 30,
    JSON.stringify({ scrim: vidrio.scrim, sinBlur: vidrio.scrimSinBlur }));

  /* ── 9-septies. Repintar y navegar en la misma tarea (U7) ─────────────────
     En Quire, abrir o cerrar un documento desde otra vista emite el aviso
     (la vista actual se repinta con refresh()) y enseguida navega (go()).
     Eran dos calcos en el mismo task, fundiéndose juntos: el del medio —el
     estado intermedio, que nadie llegó a ver— asomaba hasta un 25 % (Páginas
     con las hojas en blanco, shell-29). Mientras lo del host no se vio,
     go() ya no calca: queda UNO, con lo de antes del refresh, y la vista
     nueva va directo debajo.

     Dos veces: con un refresh que no tarda nada y con uno que tarda 80 ms
     después del paint() (una vista grande: Páginas con cientos de hojas). El
     criterio era solo de reloj (60 ms desde el calco) y con 80 ms de trabajo
     go() volvía a calcar: ['intermedio','antes']. En la misma tarea no se
     pinta nada, así que se decide por cuadros. Y la vista vieja está
     scrolleada: lo que el repintado dejaba pendiente para el final de la
     tarea le ponía ese scroll a la vista NUEVA (nacía en 0 y saltaba a 700).
     Del mismo pendiente: un countTo() de la vista nueva escribía el valor de
     una, como si fuera la misma vista repintada, en vez de contar. */
  console.log('\n9-septies. Repintar y navegar en la misma tarea');
  const doble = await js(`(async () => {
    const { Router } = await import('./js/router.js');
    const { paint } = await import('./js/ui.js');
    const { countTo } = await import('./js/motion.js');
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const alto = '<div style="height:3000px"></div>';
    const out = {};
    for (const costo of [0, 80]) {
      let estado = 'antes';
      Router.define({
        ['prueba-doble-a' + costo]: { view: () => {
          paint('<div class="ox-scroll ox-grow" id="pd-a"><p>' + estado + '</p>' + alto + '</div>');
          if (estado !== 'intermedio') return;
          const t0 = performance.now();
          while (performance.now() - t0 < costo) { /* lo que tarda en armarse y cablearse */ }
        } },
        ['prueba-doble-b' + costo]: { view: () => {
          paint('<div class="ox-scroll ox-grow" id="pd-b"><p>final</p><span id="pd-n"></span>' + alto + '</div>');
          countTo(document.getElementById('pd-n'), 500);
        } },
      });
      Router.go('prueba-doble-a' + costo);
      await espera(600);
      document.getElementById('pd-a').scrollTop = 700;
      await espera(60);
      estado = 'intermedio';
      Router.refresh();
      Router.go('prueba-doble-b' + costo);
      const view = document.getElementById('view');
      const r = {
        calcos: [...document.querySelectorAll('.ox-main--saliente')].map((c) => c.textContent.trim()),
        vista: view.querySelector('p')?.textContent.trim(),
        quieta: !view.classList.contains('ox-view'),
        cuentaAlNacer: document.getElementById('pd-n').textContent,
      };
      await espera(50);
      r.scroll = document.getElementById('pd-b').scrollTop;
      await espera(750);
      r.quedan = document.querySelectorAll('.ox-main--saliente').length;
      r.cuentaAlFinal = document.getElementById('pd-n').textContent;
      out[costo] = r;
    }
    Router.go('inicio');
    await espera(500);
    return out;
  })()`);
  for (const [costo, d] of Object.entries(doble)) {
    const cual = costo === '0' ? '' : ` (con ${costo} ms de trabajo después del paint)`;
    ok(`refresh() y go() seguidos dejan UN solo calco, con lo de antes del refresh${cual}`,
      d.calcos.length === 1 && d.calcos[0] === 'antes', JSON.stringify(d));
    ok(`y la vista nueva va quieta debajo, sin el estado intermedio en ningún lado${cual}`,
      d.vista === 'final' && d.quieta && d.quedan === 0, JSON.stringify(d));
    ok(`y no hereda el scroll de la vista vieja${cual}`, d.scroll === 0, JSON.stringify(d));
    ok(`y sus contadores cuentan (no escriben el valor de una, como al repintar)${cual}`,
      d.cuentaAlNacer !== '500' && d.cuentaAlFinal === '500', JSON.stringify(d));
  }

  /* Tooltip entre vecinos: el pointerout del primero llega ANTES que el
     pointerover del segundo y ya lo cerró, así que mirar si hay uno abierto no
     alcanza para saber que venías de otro. Salió en Moji: pasar de un botón al
     de al lado volvía a esperar los 420 ms enteros. Se mide cuándo aparece. */
  const tips = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const [a, b] = document.querySelectorAll('.ox-statusbar [data-tip]');
    const over = (el) => el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    const out = (el) => el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    const visible = (txt) => [...document.querySelectorAll('.ox-tooltip')]
      .some((t) => !t.dataset.state && t.textContent.startsWith(txt));
    const until = async (txt) => { const t0 = performance.now();
      while (!visible(txt) && performance.now() - t0 < 1000) await wait(10);
      return Math.round(performance.now() - t0); };
    over(a);
    const frio = await until(a.dataset.tip);
    await wait(150);
    out(a); over(b);
    const vecino = await until(b.dataset.tip);
    out(b);
    await wait(700);
    // Un ancla que se va del DOM durante la espera no deja un tooltip en la esquina.
    const suelto = document.createElement('button');
    suelto.dataset.tip = 'ancla que se fue';
    document.body.append(suelto);
    over(suelto); suelto.remove();
    await wait(600);
    const huerfano = visible('ancla que se fue');
    window.dispatchEvent(new Event('blur'));
    return { frio, vecino, huerfano };
  })()`);
  ok('el primer tooltip espera la demora larga', tips.frio >= 380 && tips.frio < 1000, JSON.stringify(tips));
  ok('el del vecino entra con la espera corta', tips.vecino < 250, JSON.stringify(tips));
  ok('si el ancla se fue durante la espera, no aparece', !tips.huerfano, JSON.stringify(tips));

  /* El tooltip también con el teclado (U12). Solo con el pointerover, el que
     recorre la ventana con Tab no veía ninguno, y ahí viven los atajos: Quire
     tenía una docena que la interfaz nunca decía (ux-17). Va por la tecla de
     verdad (sendInputEvent), que es lo que hace al foco :focus-visible. Y un
     clic no lo muestra por el foco: con el mouse ya está el hover. */
  console.log('\n9-octies. El tooltip con el foco del teclado');
  win.focus();
  win.webContents.focus();
  await sleep(150);
  await js(`(() => {
    const caja = document.createElement('div');
    caja.id = 'tk-caja';
    caja.style.cssText = 'position:fixed;left:320px;top:320px;display:flex;gap:8px;z-index:50';
    caja.innerHTML = '<button class="ox-btn ox-btn--secondary" id="tk-a">antes</button>'
      + '<button class="ox-iconbtn" id="tk-b" data-tip="Guardar" data-tip-key="Ctrl S"></button>';
    document.body.append(caja);
    document.getElementById('tk-a').focus();
    return true;
  })()`);
  const tipVisible = () => js(`(() => { const t = [...document.querySelectorAll('.ox-tooltip')].find((x) => !x.dataset.state);
    return { foco: document.activeElement?.id || null, tip: t ? t.textContent : null }; })()`);
  tecla('Tab');
  await sleep(700);
  const conTab = await tipVisible();
  ok('con Tab, el foco de teclado muestra el tooltip con su atajo', conTab.foco === 'tk-b' && conTab.tip === 'GuardarCtrl S', JSON.stringify(conTab));
  tecla('Tab', ['shift']);
  await sleep(400);
  const alIrse = await tipVisible();
  ok('y se va cuando se va el foco', alIrse.foco === 'tk-a' && alIrse.tip === null, JSON.stringify(alIrse));
  const tkB = await js(`(() => { const r = document.getElementById('tk-b').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await puntero('mouseMove', tkB.x, tkB.y);
  await puntero('mouseDown', tkB.x, tkB.y, { button: 'left', clickCount: 1 });
  await puntero('mouseUp', tkB.x, tkB.y, { button: 'left', clickCount: 1 });
  await puntero('mouseMove', 4, H - 40);
  await sleep(700);
  const conClic = await tipVisible();
  ok('un clic de mouse no lo deja por el foco', conClic.foco === 'tk-b' && conClic.tip === null, JSON.stringify(conClic));

  /* Y el foco que pone un script después de una tecla tampoco: navegar es
     Tab. Con «cualquier tecla» contaba como teclado: un clic real abre un
     modal, se tipea, Enter (o Escape), y Modal.close le devuelve el foco al
     botón que lo abrió —queda :focus-visible—; a los 420 ms aparecía su
     tooltip sin que nadie hubiera tabulado. En Quire, el tacho de «Borrar
     toda la tinta» al salir de su confirm. Lo mismo un atajo que enfoca un
     campo con data-tip (Ctrl+F): el tooltip encima de lo que se va a tipear.
     Y el que tabula hasta un campo y escribe enseguida no lo ve salir. */
  const escribir = (s) => {
    for (const ch of s) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
    }
  };
  await js(`(async () => {
    const { Modal } = await import('./js/overlays.js');
    const caja = document.getElementById('tk-caja');
    caja.insertAdjacentHTML('beforeend', '<button class="ox-iconbtn" id="tk-abre" data-tip="Renombrar" data-tip-key="F2"></button>'
      + '<input class="ox-input" id="tk-buscar" style="width:140px" data-tip="Buscar" data-tip-key="Ctrl F">');
    document.getElementById('tk-abre').addEventListener('click', () => {
      Modal.show({ title: 'Renombrar', body: '<input class="ox-input" id="tk-nombre" value="viejo">',
        actions: [{ label: 'Cancelar', value: null }, { label: 'Guardar', value: 'g', variant: 'primary' }] });
    });
    window.__tkAtajo = (e) => { if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); document.getElementById('tk-buscar').focus(); } };
    document.addEventListener('keydown', window.__tkAtajo);
    document.activeElement?.blur();
    return true;
  })()`);
  const tkAbre = await js(`(() => { const r = document.getElementById('tk-abre').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const alCerrar = {};
  for (const modo of ['Enter', 'Escape']) {
    await puntero('mouseMove', tkAbre.x, tkAbre.y);
    await puntero('mouseDown', tkAbre.x, tkAbre.y, { button: 'left', clickCount: 1 });
    await puntero('mouseUp', tkAbre.x, tkAbre.y, { button: 'left', clickCount: 1 });
    await puntero('mouseMove', 4, H - 40);   // el mouse se va: el hover no cuenta
    await sleep(350);
    escribir('nuevo');
    await sleep(100);
    if (modo === 'Enter') enter(); else escape();
    await sleep(800);
    alCerrar[modo] = await tipVisible();
    await js(`document.activeElement?.blur(); true`);
    await sleep(200);
  }
  ok('cerrar un modal con Enter no deja el tooltip del botón que lo abrió',
    alCerrar.Enter.foco === 'tk-abre' && alCerrar.Enter.tip === null, JSON.stringify(alCerrar.Enter));
  ok('ni con Escape', alCerrar.Escape.foco === 'tk-abre' && alCerrar.Escape.tip === null, JSON.stringify(alCerrar.Escape));
  tecla('F', ['control']);
  await sleep(700);
  const conAtajo = await tipVisible();
  ok('un atajo que enfoca un campo con data-tip no le pone el tooltip encima', conAtajo.foco === 'tk-buscar' && conAtajo.tip === null, JSON.stringify(conAtajo));
  await js(`document.getElementById('tk-b').focus(); true`);
  tecla('Tab');
  tecla('Tab');
  escribir('a');
  await sleep(700);
  const tabYEscribe = await tipVisible();
  ok('tabular hasta un campo y escribir enseguida no lo hace salir encima', tabYEscribe.foco === 'tk-buscar' && tabYEscribe.tip === null, JSON.stringify(tabYEscribe));
  await js(`document.removeEventListener('keydown', window.__tkAtajo); delete window.__tkAtajo; document.getElementById('tk-caja')?.remove(); true`);

  // El test no puede dejar basura en los datos.
  if (id) await js(`window.onyx.col('items').remove(${JSON.stringify(id)})`);
  await js(`window.onyx.settings.save({ densidad:'comoda' })`);

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  console.log(errores.length ? `CONSOLA:\n  ${errores.join('\n  ')}` : 'CONSOLA: limpia');
  app.exit(fail || errores.length ? 1 : 0);
});
