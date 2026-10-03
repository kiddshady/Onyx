/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — motion (runtime)
   La mitad JS del sistema de movimiento. Su trabajo más importante es el que
   más se olvida: que lo que se va del DOM TERMINE su animación de salida antes
   de irse. Sin esto los overlays parpadean al cerrarse y la app se siente rota.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Dos frames: garantiza que el navegador ya aplicó los estilos iniciales. */
export function raf2(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/**
 * Saca un elemento del DOM DESPUÉS de su animación de salida.
 * Marca data-state="closing" (el CSS engancha ahí) y espera al animationend,
 * con un timeout de red por si el elemento no tiene animación declarada.
 */
export function exit(el, { fallback = 400, onDone } = {}) {
  if (!el || el.dataset.state === 'closing') return Promise.resolve();
  el.dataset.state = 'closing';

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener('animationend', onAnim);
      el.remove();
      onDone?.();
      resolve();
    };
    // Solo nos importa la animación del propio elemento, no la de sus hijos.
    const onAnim = (e) => { if (e.target === el) finish(); };
    el.addEventListener('animationend', onAnim);
    const timer = setTimeout(finish, fallback);
  });
}

/* ── swap: reescribir un bloque sin cortes ──────────────────────────────────
   Un `innerHTML` a secas es un corte: lo viejo desaparece en el cuadro en que
   llega lo nuevo. Salió en Chem Engine, donde un auditor de transiciones lo
   encontró en todas partes, y cada caso pedía algo distinto:

   · APARECE (vacío → algo): lo nuevo entra con un fundido.
   · SE VA (algo → vacío): cada hijo termina de irse antes de salir del DOM.
     Hijo por hijo y no en una caja: si el contenedor es una grilla, una caja
     en el medio desarmaría las filas mientras se esfuman.
   · CAMBIA DE VALORES (algo → algo): se reescribe en el lugar y SIN volver a
     animar. Una ficha que se recalcula seguido destellaba en cada cambio.
   · CAMBIA DE ESTADO (`relevo`: pista → cargando → resultado, un estado por
     otro): lo viejo se esfuma en un calco ENCIMA, en el mismo lugar, y lo
     nuevo asoma cuando lo viejo ya va por un tercio. El calco copia el acomodo
     del contenedor para que lo viejo no se mueva mientras se va.
   · CAMBIA DE FORMA UN BLOQUE GRANDE (`fundido`: una tabla que gana o pierde
     columnas): la espera del relevo destapa —a mitad de camino lo viejo va
     por la mitad y lo nuevo por un tercio, y el bloque entero queda a media
     luz—. Con fundido el calco lleva el fondo opaco de lo que tiene detrás y
     va por encima del `th` sticky de la tabla nueva, y lo nuevo está entero y
     quieto debajo desde el primer cuadro. De Pharos 0.4.1.

   En los dos, el calco conserva la caja que tenía lo viejo (ancho, alto y
   dónde caía), no la del contenedor ya con lo nuevo: con `inset: 0`, una
   frase que se iba dentro de una caja más angosta se partía en dos renglones
   mientras se esfumaba, y una más ancha se corría (Pharos 0.4.1).

   Con el mismo HTML de la última vez no hace nada: se puede llamar en cada
   refresco sin reemplazar nodos que no cambiaron. Y si lo de antes todavía
   estaba ENTRANDO, lo nuevo sigue desde el mismo punto del fundido en vez de
   cortarlo (dos recálculos seguidos hacían saltar el bloque a opaco). */
const ultimo = new WeakMap();

export function swap(el, html, { relevo = false, fundido = false } = {}) {
  if (!el) return;
  if (ultimo.get(el) === html) return;
  ultimo.set(el, html);

  const viejos = [...el.childNodes].filter((n) => !(n.nodeType === 1 && n.classList.contains('ox-swap-out')));
  const antes = viejos.some((n) => n.nodeType === 1 || n.textContent.trim());
  const despues = html.trim() !== '';
  if (!antes && !despues) return;

  // Lo que todavía se estaba yendo EN el flujo se corta: si no, durante el
  // fundido habría dos juegos de filas.
  if (despues) el.querySelectorAll(':scope > .ox-swap-out:not(.ox-swap-out--over)').forEach((n) => n.remove());

  // Solo las entradas: lo que gira para siempre (un spinner) no se toca.
  const finitas = () => el.getAnimations({ subtree: true })
    .filter((a) => a.effect?.getTiming().iterations !== Infinity);

  if (antes && despues && !relevo && !fundido) {
    const enCurso = finitas().filter((a) => a.playState === 'running').map((a) => a.currentTime);
    const t = enCurso.length ? Math.max(...enCurso) : null;
    el.innerHTML = html;
    if (t != null) for (const n of el.children) entrar(n);
    for (const a of finitas()) { if (t != null) a.currentTime = t; else a.cancel(); }
    return;
  }

  if (antes && !despues) {
    for (let n of viejos) {
      // Un texto suelto no puede salir animado: se borraba de golpe. Va en un
      // <span> y sale como los demás.
      if (n.nodeType === 3 && n.textContent.trim()) {
        const s = document.createElement('span');
        n.replaceWith(s);
        s.append(n);
        n = s;
      }
      if (n.nodeType !== 1) { n.remove(); continue; }
      n.classList.remove('ox-swap-in', 'is-after');
      n.classList.add('ox-swap-out');
      n.inert = true;
      exit(n, { fallback: 220 });
    }
    return;
  }

  let calco = null;
  let caja = null;
  if (antes) {
    caja = cajaDe(el);
    calco = document.createElement('div');
    calco.className = `ox-swap-out ox-swap-out--over${fundido ? ' ox-swap-out--fundido' : ''}`;
    calco.inert = true;
    calco.setAttribute('aria-hidden', 'true');
    calco.append(...viejos);
    for (const x of calco.querySelectorAll('[id]')) x.removeAttribute('id');
    if (getComputedStyle(el).position === 'static') el.classList.add('ox-swap-host');
    // El fondo, del primer opaco hacia arriba: el calco no lleva la clase de
    // ninguna superficie que lo traiga.
    if (fundido) calco.style.background = fondoDetras(el);
    el.prepend(calco);
    // Mover un nodo le reinicia las animaciones CSS: lo que tenía su propia
    // entrada volvería a entrar desde cero adentro del calco que se va.
    for (const a of calco.getAnimations({ subtree: true })) {
      if (a.effect?.getTiming().iterations !== Infinity) a.finish();
    }
    exit(calco, { fallback: 220 });
  }

  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  // Un texto suelto no se puede animar: aparecía entero de golpe debajo de lo
  // viejo que se estaba yendo. Va en un <span> (de Pharos).
  for (const n of [...tpl.content.childNodes]) {
    if (n.nodeType !== 3 || !n.textContent.trim()) continue;
    const s = document.createElement('span');
    n.replaceWith(s);
    s.append(n);
  }
  // Con fundido lo nuevo no anima: está entero debajo y el calco lo destapa.
  if (!(fundido && antes)) for (const n of tpl.content.children) entrar(n, antes);
  el.append(tpl.content);

  // El calco, clavado en la caja vieja: medida ya con lo nuevo adentro.
  if (calco) {
    const ahora = cajaDe(el);
    Object.assign(calco.style, {
      inset: 'auto',
      left: `${caja.left - ahora.left}px`,
      top: `${caja.top - ahora.top}px`,
      width: `${caja.w}px`,
      height: `${caja.h}px`,
    });
  }
}

/* La caja de relleno de `el` (donde se apoya un hijo absoluto), con
   decimales. clientWidth redondea: a una frase de 105,06 px le daba 105 y
   no entraba —se partía en dos renglones igual—. */
function cajaDe(el) {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const bt = parseFloat(cs.borderTopWidth) || 0;
  return {
    left: r.left + bl,
    top: r.top + bt,
    w: r.width - bl - (parseFloat(cs.borderRightWidth) || 0),
    h: r.height - bt - (parseFloat(cs.borderBottomWidth) || 0),
  };
}

/** El primer fondo opaco hacia arriba: lo que el calco de un fundido tiene que
    llevar para tapar lo nuevo sin que se note un parche. */
function fondoDetras(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor;
    if (alfaDe(bg) >= 1) return bg;
  }
  return getComputedStyle(document.body).backgroundColor;
}

/** La opacidad de un color computado: `rgba(…, a)`, `oklch(… / a)` o sin alfa. */
function alfaDe(color) {
  if (!color || color === 'transparent') return 0;
  const barra = color.match(/\/\s*([\d.]+)(%?)\s*\)$/);
  if (barra) return Number(barra[1]) / (barra[2] ? 100 : 1);
  const rgba = color.match(/^rgba\((?:[^,]+,){3}\s*([\d.]+)\s*\)$/);
  return rgba ? Number(rgba[1]) : 1;
}

function entrar(n, tarde = false) {
  n.classList.add('ox-swap-in');
  if (tarde) n.classList.add('is-after');
  // Terminada la entrada se apaga con una clase y no con style.animation: un
  // fill `both` retenido deja la opacidad clavada, y un inline le ganaría
  // después a la regla de salida.
  n.addEventListener('animationend', function fin(ev) {
    if (ev.target !== n) return;
    n.removeEventListener('animationend', fin);
    n.classList.add('is-settled');
  });
}

/** Escalona los hijos de un contenedor seteando --i (el CSS lo usa de delay). */
export function stagger(container, selector = ':scope > *', step = 1) {
  container.querySelectorAll(selector).forEach((el, i) => {
    el.style.setProperty('--i', String(i * step));
  });
}

/* ── Click-flash ────────────────────────────────────────────────────────────
   Un velo de luz que nace con el press y decae. No viaja como un ripple de
   Material: solo confirma que el click llegó, y se limpia solo. */
export function initClickFlash(root = document) {
  root.addEventListener('pointerdown', (e) => {
    const target = e.target.closest?.('.ox-flashable');
    if (!target || target.disabled) return;
    const flash = document.createElement('span');
    flash.className = 'ox-flash';
    target.appendChild(flash);
    flash.addEventListener('animationend', () => flash.remove(), { once: true });
  });
}

/* ── Esfumado del scroll ────────────────────────────────────────────────────
   Apaga el fade del lado donde no hay nada recortado: pegado arriba no se
   esfuma arriba. Sin esto el primer item vive a media luz sin razón. */
export function scrollFade(el) {
  if (!el || el.__vcFade) return;
  el.__vcFade = true;

  const update = () => {
    const slack = el.scrollHeight - el.clientHeight;
    if (slack <= 1) {                       // no hay nada que recortar
      el.classList.add('is-top', 'is-bottom');
      el.classList.remove('is-stuck-head');
      return;
    }
    el.classList.toggle('is-top', el.scrollTop <= 1);
    el.classList.toggle('is-bottom', el.scrollTop >= slack - 1);
    // Un encabezado de tabla clavado contra el borde: su tabla ya empezó arriba
    // del borde y todavía no terminó. Ahí la línea es el límite y el fade sobra.
    const top = el.getBoundingClientRect().top;
    const stuck = [...el.querySelectorAll('.ox-table')].some((t) => {
      if (t.closest('.ox-scroll') !== el) return false;
      const r = t.getBoundingClientRect();
      return r.top < top - 1 && r.bottom > top;
    });
    el.classList.toggle('is-stuck-head', stuck);
  };

  el.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(el);
  // El contenido puede cambiar de alto sin que cambie el del contenedor.
  new MutationObserver(update).observe(el, { childList: true, subtree: true });
  update();
}

/** Aplica scrollFade a todo .ox-scroll que todavía no lo tenga. */
export function initScrollFades(root = document) {
  root.querySelectorAll('.ox-scroll').forEach(scrollFade);
}

/* ── Indicadores que viajan ─────────────────────────────────────────────────
   La cápsula del segmentado y el subrayado de los tabs se DESLIZAN entre
   opciones. Que viajen en vez de saltar es lo que los hace sentir físicos. */

/* La cápsula copia la geometría REAL de la opción activa, igual que el
   subrayado de los tabs. Antes se calculaba como ancho/n asumiendo opciones
   iguales, y en una celda de tabla no lo son: la cápsula caía corrida y el
   texto parecía descentrado. offsetLeft es relativo al segmentado (position:
   relative), así que ya incluye su padding. */
export function syncSegmented(seg) {
  const active = seg.querySelector('.ox-segmented__opt.is-active') || seg.querySelector('.ox-segmented__opt');
  if (!active) return;
  seg.style.setProperty('--seg-x', `${active.offsetLeft}px`);
  seg.style.setProperty('--seg-w', `${active.offsetWidth}px`);
}

export function syncTabs(tabs) {
  const active = tabs.querySelector('.ox-tab.is-active');
  if (!active) return;
  tabs.style.setProperty('--tab-x', `${active.offsetLeft}px`);
  tabs.style.setProperty('--tab-w', `${active.offsetWidth}px`);
}

/* Pone un indicador en su lugar sin que viaje: la transición se apaga, se
   mide, se fuerza el estilo y se vuelve a prender. Leer el estilo del pseudo
   es lo que asienta el valor; sin eso, al sacar la clase el navegador ve el
   cambio recién ahí y lo anima igual. De Apex. */
function colocar(root, pseudo, fn) {
  root.classList.add('is-placing');
  fn();
  void getComputedStyle(root, pseudo).width;
  root.classList.remove('is-placing');
}

/**
 * Cablea un grupo (segmentado o tabs) para que se comporte solo.
 * onChange recibe el value del botón elegido.
 */
export function bindSwitcher(root, onChange) {
  const isSeg = root.classList.contains('ox-segmented');
  const optSel = isSeg ? '.ox-segmented__opt' : '.ox-tab';
  const pseudo = isSeg ? '::before' : '::after';
  const medir = () => (isSeg ? syncSegmented(root) : syncTabs(root));
  /* La primera medida no viaja: la cápsula nace donde va. Antes la primera
     medida llegaba recién en raf2, así que la cápsula nacía en ancho 0 contra
     la izquierda y crecía, en cada vista que se montaba. Si ya trae una
     posición (la que devolvió el repintado de la misma vista), viaja desde
     ahí: es la que se tocó. De Apex. */
  let colocado = !!root.style.getPropertyValue(isSeg ? '--seg-w' : '--tab-w');
  const sync = () => {
    if (colocado) return medir();
    if (!root.offsetWidth) return;          // todavía sin layout: lo hace el ResizeObserver
    colocar(root, pseudo, medir);
    colocado = true;
  };

  root.addEventListener('click', (e) => {
    const opt = e.target.closest(optSel);
    if (!opt || opt.classList.contains('is-active')) return;
    root.querySelectorAll(optSel).forEach((o) => o.classList.remove('is-active'));
    opt.classList.add('is-active');
    sync();
    onChange?.(opt.dataset.value, opt);
  });

  sync();
  new ResizeObserver(sync).observe(root);
  raf2(sync);   // las fuentes pueden cambiar el ancho después del primer layout
  return sync;
}

/* ── Cambiar o repintar la vista ────────────────────────────────────────────
   Navegar es un fundido: la vista que se va pasa a un calco opaco encima y se
   esfuma, y la nueva está entera debajo desde el primer cuadro (calcar, lo
   usa el router).

   Repintar la MISMA vista —Router.refresh() después de guardar, una vista
   que se vuelve a pintar con el dato nuevo— era un innerHTML en seco, y eso
   traía cuatro cosas que se veían en todas las apps:
   · lo viejo se iba en el mismo cuadro en que llegaba lo nuevo;
   · todo lo que tenía entrada propia volvía a entrar (filas escalonadas, el
     vacío que sube, la línea de un gráfico que se dibuja de nuevo);
   · los contadores (countTo) volvían a contar desde 0;
   · el lugar se perdía: el scroll volvía arriba, un revelado abierto se
     cerraba, el foco se iba y las cápsulas de los segmentados nacían de cero.
   Ahora paint() repinta con repintar(): el mismo calco que al navegar, y lo
   nuevo ASENTADO debajo —sin entradas, con los contadores en su valor y en el
   mismo lugar que lo viejo—. Lo que no cambió es idéntico en las dos capas y no
   se mueve; solo se funde lo distinto. El repintado con calco es de Pharos; la
   foto del lugar, del remontar() de Apex. */

/**
 * La vista que se va no desaparece de un cuadro al otro: su contenido pasa a
 * un calco con la misma clase de `.ox-main`, en la misma celda de la grilla, y
 * se esfuma encima. Sin esto, la vieja se iba de golpe y la nueva arrancaba
 * desde transparente: un cuadro vacío en cada navegación.
 *
 * El calco va sin ids (nadie tiene que encontrar un #campo que se está yendo),
 * inerte, y conserva su scroll. Si la vista vieja todavía estaba entrando, el
 * calco arranca desde la opacidad y el corrimiento en que la agarró. Si ya
 * había otro calco yéndose, el nuevo va encima de ese: es el estado más
 * reciente.
 */
export function calcar(host) {
  if (!host || !host.firstChild || !host.parentElement) return null;
  const cs = getComputedStyle(host);
  const calco = document.createElement(host.tagName);
  calco.className = host.className;
  calco.classList.remove('ox-view', 'is-settled');
  calco.classList.add('ox-main--saliente');
  calco.setAttribute('aria-hidden', 'true');
  calco.inert = true;
  calco.style.opacity = cs.opacity;
  if (cs.transform !== 'none') calco.style.transform = cs.transform;

  const scrolls = [...host.querySelectorAll('*')]
    .filter((el) => el.scrollTop || el.scrollLeft)
    .map((el) => [el, el.scrollTop, el.scrollLeft]);
  calco.append(...host.childNodes);
  for (const el of calco.querySelectorAll('[id]')) el.removeAttribute('id');
  let ancla = host;
  while (ancla.nextElementSibling?.classList.contains('ox-main--saliente')) ancla = ancla.nextElementSibling;
  ancla.after(calco);
  for (const [el, top, left] of scrolls) { el.scrollTop = top; el.scrollLeft = left; }

  // Mover un nodo en el DOM le REINICIA las animaciones CSS. Lo que tenía su
  // propia entrada (un bloque que se funde, una lista escalonada) volvía a
  // entrar desde cero adentro del calco que se está yendo: caía a opacidad 0
  // en el primer cuadro y reaparecía mientras la vista se esfumaba. Medido en
  // Chem Engine: 0 → 38 → 53 → 75 % con el calco bajando. Se dan por
  // terminadas; lo que gira para siempre (un spinner) sigue girando.
  for (const a of calco.getAnimations({ subtree: true })) {
    if (a.effect?.getTiming().iterations !== Infinity) a.finish();
  }

  exit(calco, { fallback: 260 });
  host.__calcadoEn = performance.now();
  return calco;
}

const INDICADORES = [
  { sel: '.ox-segmented', pseudo: '::before', x: '--seg-x', w: '--seg-w' },
  { sel: '.ox-tabs', pseudo: '::after', x: '--tab-x', w: '--tab-w' },
];

/** Mientras se asienta un repintado, countTo() no cuenta: escribe el valor. */
let asentando = 0;

/** El lugar de una vista, antes de repintarla. Se reconoce por ids. */
function fotografiar(root) {
  const f = { scrolls: [], indicadores: new Map(), revelados: [], foco: null };
  root.querySelectorAll('.ox-scroll').forEach((el) => f.scrolls.push(el.scrollTop));
  for (const ind of INDICADORES) {
    root.querySelectorAll(`${ind.sel}[id]`).forEach((el) => {
      // Lo que se VE, no el destino: si la cápsula venía viajando, sigue desde ahí.
      const cs = getComputedStyle(el, ind.pseudo);
      const x = cs.transform && cs.transform !== 'none' ? new DOMMatrixReadOnly(cs.transform).m41 : 0;
      f.indicadores.set(el.id, { ind, x, w: parseFloat(cs.width) || 0 });
    });
  }
  root.querySelectorAll('.ox-reveal.is-open[id]').forEach((el) => f.revelados.push(el.id));
  const act = document.activeElement;
  const dueño = act && root.contains(act) ? act.closest('[id]') : null;
  // Se reconoce por su id o por el data-value dentro de un grupo con id; si
  // no, no hay forma honesta de encontrar su gemelo y el foco no se devuelve.
  if (dueño && root.contains(dueño) && (dueño === act || act.dataset.value != null)) {
    f.foco = { id: dueño.id, valor: dueño === act ? null : act.dataset.value };
  }
  return f;
}

/** Lo que la vista tiene que ver ANTES de cablearse: revelados e indicadores. */
function devolverAlPintar(root, f) {
  for (const id of f.revelados) root.querySelector(`#${CSS.escape(id)}`)?.classList.add('is-open');
  for (const [id, { ind, x, w }] of f.indicadores) {
    const el = root.querySelector(`#${CSS.escape(id)}`);
    if (!el?.matches(ind.sel) || !w) continue;
    colocar(el, ind.pseudo, () => {
      el.style.setProperty(ind.x, `${x}px`);
      el.style.setProperty(ind.w, `${w}px`);
    });
  }
}

/**
 * Repinta `root` con `poner()`, que escribe lo nuevo. Si `root` ya tenía una
 * vista, es un fundido que no pierde el lugar (ver arriba) y devuelve true; si
 * estaba vacío, solo pinta.
 *
 * Si `root` se calcó hace un instante (el router, al navegar; una vista que
 * pinta «cargando» y el dato a los pocos ms), lo nuevo va directo debajo de
 * ese calco: otro en el medio dejaba ver un instante el estado intermedio
 * —encabezado sin cuerpo— y la pantalla bajaba de brillo (Pharos).
 */
export function repintar(root, poner) {
  const recien = performance.now() - (root.__calcadoEn ?? -Infinity) < 60;
  const f = !recien && root.firstChild ? fotografiar(root) : null;
  const calco = f ? calcar(root) : null;
  poner();
  if (!calco) return false;
  devolverAlPintar(root, f);
  asentar(root, f);
  return true;
}

/* Lo nuevo queda quieto debajo del calco: sus entradas se dan por terminadas
   (lo que gira para siempre sigue, y las transiciones también: una cápsula
   que viene de donde estaba tiene que llegar viajando). Se hace dos veces:
   ahora, con lo que trajo el HTML, y al terminar la tarea, con lo que la vista
   haya arrancado al cablearse. Recién ahí se devuelven el scroll y el foco,
   que dependen del alto final. */
function asentar(root, f) {
  const terminar = () => {
    for (const a of root.getAnimations({ subtree: true })) {
      if (a.effect?.target === root || a instanceof CSSTransition) continue;
      if (a.effect?.getTiming().iterations !== Infinity) a.finish();
    }
  };
  asentando++;
  terminar();
  queueMicrotask(() => {
    asentando--;
    terminar();
    const scrolls = root.querySelectorAll('.ox-scroll');
    f.scrolls.forEach((top, i) => { if (scrolls[i] && top) scrolls[i].scrollTop = top; });
    // Si la vista ya puso el foco donde quería, se respeta.
    if (f.foco && (!document.activeElement || document.activeElement === document.body)) {
      const dueño = root.querySelector(`#${CSS.escape(f.foco.id)}`);
      const el = f.foco.valor != null
        ? dueño?.querySelector(`[data-value="${CSS.escape(f.foco.valor)}"]`)
        : dueño;
      el?.focus({ preventScroll: true });
    }
  });
}

/* ── Campo numérico ─────────────────────────────────────────────────────────
   El spinner de `<input type=number>` es de Chromium y está tapado en el CSS.
   Esto le devuelve las flechas, ya dibujadas por nosotros.

   El input NO se reemplaza: sigue siendo el dueño del valor, del foco y del
   teclado. Por eso cada paso despacha `input` Y `change` con bubbles — quien
   escuchaba al campo antes de tener flechas sigue funcionando sin tocar nada.

   Mantener apretado repite, y acelera: un campo de copias que llega a 50 de a
   un click por vez no lo usa nadie. */

const ESPERA = 380;    // antes de empezar a repetir: distingue click de aguante
const PASO_LENTO = 110;
const PASO_RAPIDO = 45;
const ACELERA_A = 1200;   // ms aguantando antes de pasar a rápido

/**
 * Cablea un `.ox-stepper` (input + dos flechas).
 * onChange recibe el valor numérico ya acotado a min/max.
 */
export function bindStepper(root, onChange) {
  const input = root?.querySelector('input[type="number"]');
  if (!input) return () => {};

  const num = (attr, fallback) => {
    const v = parseFloat(input.getAttribute(attr));
    return Number.isFinite(v) ? v : fallback;
  };

  const leer = () => {
    const v = parseFloat(input.value);
    return Number.isFinite(v) ? v : num('min', 0);
  };

  /** Los topes se releen en cada paso: el max suele depender de otra cosa. */
  const acotar = (v) => Math.min(num('max', Infinity), Math.max(num('min', -Infinity), v));

  const sync = () => {
    const v = leer();
    const arriba = root.querySelector('[data-step="up"]');
    const abajo = root.querySelector('[data-step="down"]');
    if (arriba) arriba.disabled = v >= num('max', Infinity);
    if (abajo) abajo.disabled = v <= num('min', -Infinity);
  };

  function mover(dir) {
    const antes = leer();
    const v = acotar(antes + dir * num('step', 1));
    if (v === antes) { sync(); return false; }
    input.value = String(v);
    sync();
    // bubbles: los listeners suelen estar en el contenedor, no en el input.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    onChange?.(v, input);
    return true;
  }

  let timer = null;
  const frenar = () => { clearTimeout(timer); timer = null; };

  function arrancar(dir, desde) {
    const transcurrido = Date.now() - desde;
    if (!mover(dir)) { frenar(); return; }
    timer = setTimeout(() => arrancar(dir, desde), transcurrido > ACELERA_A ? PASO_RAPIDO : PASO_LENTO);
  }

  root.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-step]');
    if (!btn || btn.disabled) return;
    e.preventDefault();                 // que el campo no pierda el foco
    const dir = btn.dataset.step === 'up' ? 1 : -1;
    mover(dir);
    const desde = Date.now();
    timer = setTimeout(() => arrancar(dir, desde), ESPERA);
    /* La captura del puntero es lo que hace que soltar CUENTE aunque el dedo se
       haya ido del botón. Sin esto, arrastrar afuera deja el contador corriendo
       para siempre. */
    btn.setPointerCapture?.(e.pointerId);
  });

  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    root.addEventListener(ev, frenar);
  }

  input.addEventListener('input', sync);
  sync();
  return sync;
}

/* ── Revelado de alto (grid 0fr → 1fr) ───────────────────────────────────── */
export function toggleReveal(el, open) {
  const next = open ?? !el.classList.contains('is-open');
  el.classList.toggle('is-open', next);
  return next;
}

/* ── Números que cuentan ────────────────────────────────────────────────────
   Un contador que salta de 0 a 1284 no se lee; uno que corre, sí. */
export function countTo(el, to, { from = 0, duration = 700, format = (n) => n } = {}) {
  // Repintando la misma vista, el número ya estaba en pantalla: volver a
  // contar desde 0 lo haría entrar de nuevo. Va el valor; si cambió, el
  // fundido del repintado lo muestra.
  if (asentando) { el.textContent = format(Math.round(to)); return; }
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = format(Math.round(from + (to - from) * ease(t)));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Marca un valor que acaba de cambiar: destella y vuelve. */
export function tick(el) {
  el.classList.remove('ox-ticked');
  void el.offsetWidth;          // reinicia la animación
  el.classList.add('ox-ticked');
}
