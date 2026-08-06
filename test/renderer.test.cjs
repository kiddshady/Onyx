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

  console.log('\n5. Overlays: dónde caen, no solo si existen');
  await click('[data-menu="item"]');
  await sleep(400);
  const menu = await js(`(() => { const m=document.querySelector('.ox-menu'); if(!m) return null;
    const r=m.getBoundingClientRect(); return {t:Math.round(r.top),l:Math.round(r.left),b:Math.round(r.bottom),rt:Math.round(r.right)}; })()`);
  ok('el menú abre dentro de la ventana',
    menu && menu.t >= 0 && menu.l >= 0 && menu.b <= H && menu.rt <= W, JSON.stringify(menu));
  await js(`document.body.click(); true`); await sleep(300);

  await click('#btn-palette');
  await sleep(500);
  const pal = await js(`(() => { const p=document.querySelector('.ox-palette'); if(!p) return null;
    const r=p.getBoundingClientRect(); return {t:Math.round(r.top),cx:Math.round(r.left+r.width/2)}; })()`);
  ok('la paleta abre centrada y visible', pal && pal.t > 0 && Math.abs(pal.cx - W / 2) < 4, JSON.stringify(pal));
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

  console.log('\n6. El medidor indeterminado nunca se va de la pista');
  // Una barra que se sale de su pista se lee como un componente roto, no como
  // "esperando". Se muestrea el recorrido entero en vez de mirar un instante.
  const fuera = await js(`(async () => {
    const m = document.querySelector('.ox-meter--indeterminate');
    const f = m && m.querySelector('.ox-meter__fill');
    if (!f) return 'no existe';
    const malos = [];
    for (let i = 0; i < 30; i++) {
      const p = m.getBoundingClientRect(); const r = f.getBoundingClientRect();
      const visible = Math.min(r.right, p.right) - Math.max(r.left, p.left);
      if (visible < 1) malos.push(i);
      await new Promise(res => setTimeout(res, 60));
    }
    return malos;
  })()`);
  ok('siempre hay barra sobre la pista', Array.isArray(fuera) && fuera.length === 0, JSON.stringify(fuera));

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
