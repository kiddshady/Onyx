/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — app demo
   Esto NO es parte del framework: es el ejemplo que se borra. Existe para dos
   cosas: que la plantilla arranque mostrando algo real, y que quede escrito en
   algún lado cómo se usan las piezas (router con parámetro, colección en
   disco, modal que devuelve un valor, ajustes que persisten).

   Para empezar tu app: vaciá las vistas de acá abajo y dejá el arranque.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Tooltip, Toast, Menu, Modal } from './overlays.js';
import Palette from './palette.js';
import Router from './router.js';
import { initClickFlash, initScrollFades, raf2, countTo, tick, bindSwitcher } from './motion.js';
import { viewEl, esc, paint, head, empty, mark, status, attempt, copy, colorToken } from './ui.js';
import { fmtBytes, relTime, fmtDate, plural, monogram } from './format.js';
import { designHTML, wireDesign } from './design-view.js';

const api = window.onyx;
const items = api.col('items');

/* ══ Datos ═══════════════════════════════════════════════════════════════════
   Un espejo en memoria de lo que hay en disco. Las vistas leen de acá y nunca
   hacen IPC para dibujarse: si cada repintado pidiera los datos de nuevo,
   navegar entre vistas parpadearía. */

const S = {
  info: null,
  settings: {},
  items: [],
  lastSaved: null,
};

async function loadAll() {
  const [info, settings, list] = await Promise.all([api.info(), api.settings.get(), items.list()]);
  S.info = info;
  S.settings = settings;
  S.items = list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function saveItem(item) {
  const saved = await items.save({ ...item, updatedAt: Date.now() });
  S.items = [saved, ...S.items.filter((i) => i.id !== saved.id)]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  S.lastSaved = Date.now();
  updateChrome();
  return saved;
}

async function removeItem(id) {
  await items.remove(id);
  S.items = S.items.filter((i) => i.id !== id);
  updateChrome();
}

const item = (id) => S.items.find((i) => i.id === id) || null;

/* ══ Crear ═══════════════════════════════════════════════════════════════════ */

async function newItemModal() {
  // El cuerpo del modal se arma como nodo para poder leer los campos después
  // de que se cierre: el elemento sigue siendo válido aunque ya no esté en el DOM.
  const body = document.createElement('div');
  body.className = 'ox-col';
  body.style.gap = '16px';
  body.innerHTML = `
    <div class="ox-field">
      <label class="ox-field__label">Nombre</label>
      <input class="ox-input" id="f-name" placeholder="Sin título" spellcheck="false">
    </div>
    <div class="ox-field">
      <label class="ox-field__label">Nota</label>
      <textarea class="ox-textarea" id="f-note" placeholder="Para qué es esto…"></textarea>
    </div>`;

  const ok = await Modal.show({
    title: 'Nuevo ítem',
    sub: 'Se guarda como un archivo JSON suelto en la carpeta de datos.',
    body,
    width: 460,
    actions: [
      { label: 'Cancelar', value: null },
      { label: 'Crear', value: true, variant: 'primary', autofocus: true },
    ],
  });
  if (!ok) return null;

  const name = body.querySelector('#f-name').value.trim() || 'Sin título';
  const note = body.querySelector('#f-note').value.trim();

  return attempt(async () => {
    const id = await items.nextId('n');
    const saved = await saveItem({ id, name, note, state: 'idle', createdAt: Date.now() });
    Toast.show({ title: 'Ítem creado', text: `${saved.name} · ${saved.id}`, icon: 'check' });
    registerCommands();
    Router.go('item', saved.id);
    return saved;
  }, { errorTitle: 'No se pudo crear el ítem' });
}

/* ══ Vista: Inicio ═══════════════════════════════════════════════════════════ */

function viewInicio() {
  const total = S.items.length;
  const recientes = S.items.slice(0, 5);

  paint(head({
    title: 'Inicio',
    sub: 'Plantilla Onyx corriendo sobre datos reales en disco',
    actions: '<button class="ox-btn ox-btn--primary ox-flashable" data-action="new"><i data-icon="plus"></i> Nuevo ítem</button>',
  }) + `
    <div class="ox-scroll ox-grow">
      <div class="ox-row" style="gap:40px;margin-bottom:28px;flex-wrap:wrap">
        <div class="ox-stat"><span class="ox-stat__value" id="k-items">0</span><span class="ox-stat__label">Ítems</span></div>
        <div class="ox-stat"><span class="ox-stat__value" id="k-bytes">0</span><span class="ox-stat__label">En disco</span></div>
        <div class="ox-stat"><span class="ox-stat__value">${esc(S.info?.electron || '—')}</span><span class="ox-stat__label">Electron</span></div>
      </div>

      <div class="ox-section">
        <div class="ox-section__head">
          <span class="ox-section__title">Recientes</span>
          ${total > 5 ? `<button class="ox-btn ox-btn--ghost ox-btn--sm" data-goto="items">Ver los ${total}<i data-icon="chevronRight"></i></button>` : ''}
        </div>
        ${total ? `<div class="ox-list">${recientes.map(rowHTML).join('')}</div>`
          : `<div class="ox-empty" style="margin:24px auto">${Icons.svg('inbox')}
              <div class="ox-empty__title">Todavía no hay nada</div>
              <div class="ox-empty__text">Creá un ítem y va a quedar como un archivo JSON en tu carpeta de datos. Cerrá y volvé a abrir la app: sigue estando.</div>
              <div class="ox-row" style="margin-top:6px"><button class="ox-btn ox-btn--secondary ox-flashable" data-action="new"><i data-icon="plus"></i> Crear el primero</button></div>
            </div>`}
      </div>
      <div style="height:32px"></div>
    </div>`);

  // Los contadores corren en vez de saltar: un número que aparece de golpe no
  // se lee, uno que se mueve sí.
  const bytes = S.items.reduce((n, i) => n + JSON.stringify(i).length, 0);
  countTo(document.getElementById('k-items'), total);
  countTo(document.getElementById('k-bytes'), bytes, { format: fmtBytes });
}

function rowHTML(it) {
  return `
    <div class="ox-listitem" role="button" tabindex="0" data-open="${esc(it.id)}">
      ${mark(it.state || 'idle')}
      <div class="ox-listitem__main">
        <span class="ox-listitem__title">${esc(it.name)}</span>
        <span class="ox-listitem__sub">${esc(it.id)} · ${esc(relTime(it.updatedAt))}${it.note ? ` · ${esc(it.note.slice(0, 60))}` : ''}</span>
      </div>
      <div class="ox-rowactions">
        <button class="ox-iconbtn ox-iconbtn--sm" data-menu="item" data-menu-arg="${esc(it.id)}" data-tip="Más"><i data-icon="more"></i></button>
      </div>
    </div>`;
}

/* ══ Vista: Ítems ════════════════════════════════════════════════════════════ */

function viewItems() {
  paint(head({
    title: 'Ítems',
    sub: plural(S.items.length, 'ítem', 'ítems') + ' en ' + esc(S.info?.dataDir || 'disco'),
    actions: '<button class="ox-btn ox-btn--primary ox-flashable" data-action="new"><i data-icon="plus"></i> Nuevo ítem</button>',
  }) + (S.items.length
    ? `<div class="ox-scroll ox-grow">
         <div class="ox-list">${S.items.map(rowHTML).join('')}</div>
         <div style="height:32px"></div>
       </div>`
    : empty({
      icon: 'inbox',
      title: 'No hay ítems',
      text: 'Cada ítem es un archivo JSON independiente: guardar uno no reescribe los otros, y borrar a mano es borrar un archivo.',
      actions: '<button class="ox-btn ox-btn--secondary ox-flashable" data-action="new"><i data-icon="plus"></i> Crear el primero</button>',
    })));
}

/* ══ Vista: un ítem (router con parámetro + inspector) ═══════════════════════ */

function viewItem(id) {
  const it = item(id);
  if (!it) {
    paint(head({ title: 'No encontrado', crumbs: [{ label: 'Ítems', view: 'items' }, { label: id }] })
      + empty({ icon: 'alert', title: `No existe ${id}`, text: 'Puede que lo hayas borrado, o que el archivo ya no esté en la carpeta de datos.' }));
    return;
  }

  paint(head({
    title: it.name,
    crumbs: [{ label: 'Ítems', view: 'items' }, { label: it.id }],
    actions: `
      <button class="ox-btn ox-btn--secondary ox-flashable" data-action="rename"><i data-icon="edit"></i> Renombrar</button>
      <button class="ox-iconbtn" data-menu="item" data-menu-arg="${esc(it.id)}" data-tip="Más"><i data-icon="more"></i></button>`,
  }) + `
    <div class="ox-viewbody">
      <div class="ox-viewbody__main">
        <div class="ox-scroll ox-grow">
          <div class="ox-card" style="max-width:640px">
            <div class="ox-card__head"><span class="ox-subtitle">Nota</span></div>
            <div class="ox-card__body">
              <textarea class="ox-textarea" id="note" rows="8"
                        placeholder="Escribí algo. Se guarda solo al salir del campo.">${esc(it.note || '')}</textarea>
            </div>
          </div>
          <div style="height:32px"></div>
        </div>
      </div>

      <!-- El inspector: metadatos y acciones del objeto seleccionado. -->
      <aside class="ox-inspector">
        <div class="ox-inspector__head">
          <span class="ox-avatar">${esc(monogram(it.name))}</span>
          <div class="ox-grow" style="min-width:0">
            <div class="ox-truncate" style="font-weight:var(--ox-w-medium)">${esc(it.name)}</div>
            <div class="ox-meta ox-mono">${esc(it.id)}</div>
          </div>
        </div>
        <div class="ox-inspector__body ox-scroll">
          <div class="ox-field" style="margin-bottom:18px">
            <label class="ox-field__label">Estado</label>
            <div class="ox-segmented" id="state-seg">
              ${['idle', 'running', 'done', 'failed'].map((s) => `
                <button class="ox-segmented__opt${(it.state || 'idle') === s ? ' is-active' : ''}" data-value="${s}">${s}</button>`).join('')}
            </div>
          </div>
          <div class="ox-kv">
            <span class="ox-kv__k">Estado</span><span class="ox-kv__v" id="kv-state">${status(it.state || 'idle')}</span>
            <span class="ox-kv__k">Creado</span><span class="ox-kv__v">${esc(fmtDate(it.createdAt, { withTime: true }))}</span>
            <span class="ox-kv__k">Modificado</span><span class="ox-kv__v">${esc(relTime(it.updatedAt))}</span>
            <span class="ox-kv__k">Tamaño</span><span class="ox-kv__v ox-num">${esc(fmtBytes(JSON.stringify(it).length))}</span>
          </div>
        </div>
        <div class="ox-inspector__foot">
          <button class="ox-btn ox-btn--ghost ox-btn--sm ox-grow" data-copy="${esc(it.id)}"><i data-icon="copy"></i> Copiar id</button>
          <button class="ox-btn ox-btn--danger ox-btn--sm" data-action="delete" data-arg="${esc(it.id)}"><i data-icon="trash"></i> Eliminar</button>
        </div>
      </aside>
    </div>`);

  /* La nota se guarda al salir del campo, no en cada tecla: escribir no
     debería producir 200 escrituras a disco. */
  const note = document.getElementById('note');
  note.addEventListener('blur', async () => {
    const value = note.value;
    if (value === (it.note || '')) return;
    await attempt(() => saveItem({ ...it, note: value }), { errorTitle: 'No se pudo guardar la nota' });
    document.querySelector('#stat-saved .ox-statusbar__value')?.parentElement && tick(document.querySelector('#stat-saved'));
  });

  const seg = document.getElementById('state-seg');
  bindSwitcher(seg, async (value) => {
    await attempt(() => saveItem({ ...it, state: value }));
    document.getElementById('kv-state').innerHTML = status(value);
  });
}

/* ══ Vista: Piezas ═══════════════════════════════════════════════════════════ */

function viewPiezas() {
  paint(head({
    title: 'Piezas',
    sub: 'Todos los primitivos del sistema, vivos',
    actions: '<button class="ox-btn ox-btn--ghost ox-flashable" id="replay"><i data-icon="retry"></i> Repetir entradas</button>',
  }) + designHTML());

  wireDesign(viewEl());
  document.getElementById('replay')?.addEventListener('click', () => {
    const body = document.getElementById('design-body');
    body.style.animation = 'none';
    void body.offsetWidth;   // reinicia la animación
    body.style.animation = 'ox-glide-in 420ms var(--ox-ease) both';
  });
}

/* ══ Vista: Ajustes ══════════════════════════════════════════════════════════ */

const DENSIDADES = [
  { id: 'compacta', label: 'Compacta' },
  { id: 'comoda', label: 'Cómoda' },
  { id: 'amplia', label: 'Amplia' },
];

function viewAjustes() {
  const st = S.settings;
  paint(head({ title: 'Ajustes', sub: 'Se guardan en settings.json, con escritura atómica' }) + `
    <div class="ox-scroll ox-grow">
      <div style="max-width:620px">

        <div class="ox-section">
          <div class="ox-section__head"><span class="ox-section__title">Comportamiento</span></div>
          <div class="ox-card"><div class="ox-card__body ox-col" style="gap:18px">
            <label class="ox-row" style="gap:12px">
              <button class="ox-switch${st.autoGuardado ? ' is-on' : ''}" id="set-auto"></button>
              <span class="ox-col" style="gap:2px">
                <span class="ox-label">Guardado automático</span>
                <span class="ox-meta">Escribe al salir de cada campo en vez de esperar un botón.</span>
              </span>
            </label>
            <div class="ox-field">
              <label class="ox-field__label">Densidad</label>
              <div class="ox-segmented" id="set-densidad" style="max-width:280px">
                ${DENSIDADES.map((d) => `<button class="ox-segmented__opt${st.densidad === d.id ? ' is-active' : ''}" data-value="${d.id}">${d.label}</button>`).join('')}
              </div>
            </div>
          </div></div>
        </div>

        <div class="ox-section">
          <div class="ox-section__head"><span class="ox-section__title">Datos</span></div>
          <div class="ox-card"><div class="ox-card__body">
            <div class="ox-kv">
              <span class="ox-kv__k">Carpeta</span>
              <span class="ox-kv__v ox-mono ox-copyable" data-copy="${esc(S.info?.dataDir || '')}">${esc(S.info?.dataDir || '—')}</span>
              <span class="ox-kv__k">Ítems</span><span class="ox-kv__v ox-num">${S.items.length}</span>
              <span class="ox-kv__k">Esquema</span><span class="ox-kv__v ox-mono">v${esc(st.schema ?? 1)}</span>
            </div>
            <p class="ox-meta" style="margin-top:14px;line-height:1.65">
              Los archivos son JSON legibles: se pueden abrir con un editor, versionar en git
              y arreglar a mano. La escritura es atómica, así que un corte a mitad deja el
              archivo anterior intacto en vez de uno truncado.
            </p>
          </div></div>
        </div>

        <div class="ox-section">
          <div class="ox-section__head"><span class="ox-section__title">Acerca de</span></div>
          <div class="ox-card"><div class="ox-card__body">
            <div class="ox-kv">
              <span class="ox-kv__k">App</span><span class="ox-kv__v">${esc(S.info?.name || '—')} ${esc(S.info?.version || '')}</span>
              <span class="ox-kv__k">Electron</span><span class="ox-kv__v ox-mono">${esc(S.info?.electron || '—')}</span>
            </div>
          </div></div>
        </div>

      </div>
      <div style="height:32px"></div>
    </div>`);

  document.getElementById('set-auto')?.addEventListener('click', async (e) => {
    const on = !e.currentTarget.classList.contains('is-on');
    e.currentTarget.classList.toggle('is-on', on);
    await persist({ autoGuardado: on });
  });

  bindSwitcher(document.getElementById('set-densidad'), (value) => persist({ densidad: value }));
}

async function persist(patch) {
  const saved = await attempt(() => api.settings.save(patch), { errorTitle: 'No se pudieron guardar los ajustes' });
  if (!saved) return;
  S.settings = saved;
  S.lastSaved = Date.now();
  updateChrome();
}

/* ══ Router ══════════════════════════════════════════════════════════════════ */

Router.define({
  inicio: { view: viewInicio },
  items: { view: viewItems },
  item: { view: viewItem, nav: 'items' },   // el detalle sigue iluminando "Ítems"
  piezas: { view: viewPiezas },
  ajustes: { view: viewAjustes },
}, document.getElementById('view'));

/* ══ Menús de contexto ═══════════════════════════════════════════════════════ */

const MENUS = {
  item: (id) => [
    { label: 'Abrir', icon: 'external', onSelect: () => Router.go('item', id) },
    { label: 'Renombrar…', icon: 'edit', onSelect: () => renameItem(id) },
    { label: 'Duplicar', icon: 'duplicate', onSelect: () => duplicateItem(id) },
    { label: 'Copiar id', icon: 'copy', onSelect: () => copy(id) },
    { sep: true },
    { label: 'Eliminar', icon: 'trash', danger: true, onSelect: () => deleteItem(id) },
  ],
};

async function renameItem(id) {
  const it = item(id);
  if (!it) return;
  const body = document.createElement('div');
  body.className = 'ox-field';
  body.innerHTML = '<label class="ox-field__label">Nombre</label><input class="ox-input" spellcheck="false">';
  const input = body.querySelector('input');
  input.value = it.name;

  const ok = await Modal.show({
    title: 'Renombrar',
    body,
    width: 420,
    actions: [{ label: 'Cancelar', value: null }, { label: 'Guardar', value: true, variant: 'primary' }],
  });
  if (!ok) return;
  const name = input.value.trim();
  if (!name || name === it.name) return;
  await attempt(() => saveItem({ ...it, name }));
  registerCommands();
  Router.refresh();
}

async function duplicateItem(id) {
  const it = item(id);
  if (!it) return;
  await attempt(async () => {
    const newId = await items.nextId('n');
    await saveItem({ ...it, id: newId, name: `${it.name} copia`, createdAt: Date.now() });
    Toast.show({ title: 'Duplicado', text: newId, icon: 'duplicate' });
    registerCommands();
    Router.refresh();
  });
}

async function deleteItem(id) {
  const it = item(id);
  const ok = await Modal.confirm({
    title: `¿Eliminar “${it?.name || id}”?`,
    sub: 'Se borra su archivo de la carpeta de datos. Esto no se puede deshacer.',
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  await attempt(() => removeItem(id));
  Toast.show({ title: 'Eliminado', text: id, icon: 'trash' });
  registerCommands();
  // Si estabas parado en el ítem que borraste, no tiene sentido quedarse ahí.
  Router.current.name === 'item' && Router.current.param === id ? Router.go('items') : Router.refresh();
}

/* ══ Shell ═══════════════════════════════════════════════════════════════════ */

function wireShell() {
  const w = api?.win;
  document.getElementById('win-min')?.addEventListener('click', () => w?.minimize());
  document.getElementById('win-close')?.addEventListener('click', () => w?.close());
  const maxBtn = document.getElementById('win-max');
  maxBtn?.addEventListener('click', () => w?.toggleMaximize());
  w?.onMaximized((isMax) => {
    maxBtn.innerHTML = Icons.svg(isMax ? 'winRestore' : 'winMax');
    maxBtn.setAttribute('aria-label', isMax ? 'Restaurar' : 'Maximizar');
  });

  document.querySelectorAll('.ox-navitem').forEach((b) =>
    b.addEventListener('click', () => Router.go(b.dataset.view)));

  document.getElementById('btn-palette')?.addEventListener('click', () => Palette.toggle());
  document.getElementById('btn-new')?.addEventListener('click', newItemModal);

  /* Delegación global: las vistas se repintan enteras, así que enganchar los
     handlers en cada repintado sería recablear todo cada vez. Con delegación
     el cableado se hace una sola vez y sobrevive a cualquier innerHTML. */
  document.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) Router.go(goto.dataset.goto, goto.dataset.param || null);

    const open = e.target.closest('[data-open]');
    if (open && !e.target.closest('[data-menu]')) Router.go('item', open.dataset.open);

    const cp = e.target.closest('[data-copy]');
    if (cp) copy(cp.dataset.copy);

    const trigger = e.target.closest('[data-menu]');
    if (trigger) {
      e.stopPropagation();
      const build = MENUS[trigger.dataset.menu];
      if (build) Menu.show(trigger, build(trigger.dataset.menuArg), { align: 'end' });
    }

    const act = e.target.closest('[data-action]');
    if (act) {
      const a = act.dataset.action;
      if (a === 'new') newItemModal();
      if (a === 'rename') renameItem(Router.param);
      if (a === 'delete') deleteItem(act.dataset.arg);
    }
  });

  // Enter y Espacio sobre una fila: la lista tiene que ser usable sin mouse.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest?.('[data-open]');
    if (!row) return;
    e.preventDefault();
    Router.go('item', row.dataset.open);
  });
}

/** Todo lo que vive fuera de la vista: statusbar, contadores del rail, contexto. */
function updateChrome() {
  document.querySelector('[data-view="items"] .ox-navitem__count').textContent = S.items.length;
  document.getElementById('stat-items').textContent = S.items.length;

  const saved = document.querySelector('#stat-saved .ox-statusbar__value');
  if (saved) saved.textContent = S.lastSaved ? relTime(S.lastSaved) : '—';

  document.getElementById('stat-version').innerHTML =
    `${mark('done')}<span>${esc(S.info?.name || 'Onyx')} ${esc(S.info?.version || '')}</span>`;

  document.getElementById('rail-foot').innerHTML =
    `<span class="ox-meta ox-truncate" data-tip="${esc(S.info?.dataDir || '')}">${esc(S.info?.dataDir || '')}</span>`;

  const ctx = document.getElementById('titlebar-context');
  const it = Router.name === 'item' ? item(Router.param) : null;
  ctx.innerHTML = it ? `${Icons.svg('file', 'ox-icon--sm')}<span>${esc(it.name)}</span>` : '';
}

function registerCommands() {
  Palette.clear();
  Palette.register([
    { id: 'new', group: 'Crear', icon: 'plus', label: 'Nuevo ítem', run: newItemModal },
    { id: 'nav-inicio', group: 'Ir a', icon: 'home', label: 'Inicio', run: () => Router.go('inicio') },
    { id: 'nav-items', group: 'Ir a', icon: 'list', label: 'Ítems', run: () => Router.go('items') },
    { id: 'nav-piezas', group: 'Ir a', icon: 'layers', label: 'Piezas', run: () => Router.go('piezas') },
    { id: 'nav-ajustes', group: 'Ir a', icon: 'settings', label: 'Ajustes', run: () => Router.go('ajustes') },
    ...S.items.map((it) => ({
      id: `open-${it.id}`, group: 'Abrir', icon: 'file', label: it.name, hint: it.id,
      run: () => Router.go('item', it.id),
    })),
  ]);
}

/* ══ Color de la ventana ═════════════════════════════════════════════════════
   --ox-bg está en oklch y Electron solo entiende hex. En vez de mantener el
   valor duplicado a mano, se resuelve acá y se lo mandamos al proceso
   principal: así el frame fantasma que pinta el compositor de Windows al
   restaurar sigue camuflado aunque cambies el matiz en tokens.css.

   La traducción a hex la hace colorToken() con un canvas, no un regex. El
   porqué está en ui.js y no es opcional: parseando el texto, la app le mandaba
   VERDE a su propia ventana. */
function syncWindowColor() {
  const hex = colorToken('--ox-bg');
  if (hex) api?.win?.setBackground(hex);
}

/* ══ Arranque ════════════════════════════════════════════════════════════════ */

async function boot() {
  Icons.mount(document);      // reemplaza los <i data-icon> del index.html
  Tooltip.init();
  Palette.init();
  initClickFlash();
  initScrollFades();
  wireShell();
  syncWindowColor();

  try {
    await loadAll();
  } catch (err) {
    // Si los datos no cargan, la app tiene que DECIRLO. Una pantalla vacía sin
    // explicación es peor que un error feo.
    paint(empty({ icon: 'alert', title: 'No se pudo iniciar', text: err.message }));
    console.error(err);
    return;
  }

  registerCommands();
  updateChrome();
  Router.onChange(updateChrome);
  Router.go('inicio');

  // El splash se va recién cuando ya hay algo pintado debajo. El doble rAF
  // garantiza que el navegador aplicó los estilos de la vista antes del fade.
  raf2(() => {
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    splash.style.opacity = '0';
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    setTimeout(() => splash.remove(), 600);
  });
}

boot();
