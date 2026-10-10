/* ═══════════════════════════════════════════════════════════════════════════
   La fuente de los bloques
   Roboto Mono no trae los caracteres de bloque (U+2580–259F: █ ▀ ▄ ▌ ▐ ▛ ▜…),
   así que el navegador los saca de la fuente de respaldo (Cascadia Mono), que
   tiene otras medidas: no llenan la celda, y un dibujo hecho con ellos (el
   mascot de Claude Code en una terminal) sale con rayas entre filas y entre
   columnas. Esta fuente los dibuja con las medidas de Roboto Mono (el mismo
   ancho, el mismo alto de línea) y fonts.css la suma a la familia
   'Roboto Mono' con su unicode-range. Viene de Prism (oct 2026).

   Dos detalles para que no queden costuras:
   - Afuera, el bloque se pasa un poco de la celda. Arriba y abajo lo recorta
     la fila de una terminal como xterm.js (overflow: hidden); a los costados
     se encima con el vecino, que es del mismo color. Dos bordes suavizados
     que se tocan justo no suman un pixel lleno: quedaba la raya.
   - Adentro (la mitad, los octavos) corta en su lugar exacto.
   Las sombras (░▒▓) no van: un punteado con medidas fraccionarias hace moiré.

   Si la mono deja de ser Roboto Mono, cambian ADV, ASC y DESC (su hhea y el
   ancho de su W) y hay que volver a generarla. Con xterm.js, cargala antes
   de abrir la terminal: xterm se guarda el ancho de cada carácter la primera
   vez que lo ve, y medido con el respaldo queda corrido para siempre.

     node tools/bloques.mjs   → renderer/fonts/bloques.ttf
═══════════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'renderer', 'fonts', 'bloques.ttf');

/* Las medidas de Roboto Mono al doble (su em es 2048): así la mitad del ancho
   (1229 / 2) cae en un entero. */
const UPM = 4096;
const ADV = 2458;          // el ancho de Roboto Mono: 1229 / 2048
const ASC = 4292;          // su ascender: 2146
const DESC = 1110;         // su descender: 555
const OUT_X = 160;         // lo que se pasa a los costados (~.04 em)
const OUT_Y = 500;         // y arriba y abajo (~.12 em; lo recorta la fila)

// La celda: x de 0 a ADV; y de -DESC a ASC (la fila es eso, redondeado).
const H = ASC + DESC;
const cell = { l: 0, r: ADV, b: -DESC, t: ASC };
const at = { x: (f) => Math.round(f * ADV), y: (f) => Math.round(-DESC + f * H) };

/** Un rectángulo en fracciones de la celda; los lados que caen en el borde se pasan. */
function box(x0, y0, x1, y1) {
  return {
    x0: x0 === 0 ? cell.l - OUT_X : at.x(x0),
    x1: x1 === 1 ? cell.r + OUT_X : at.x(x1),
    y0: y0 === 0 ? cell.b - OUT_Y : at.y(y0),
    y1: y1 === 1 ? cell.t + OUT_Y : at.y(y1),
  };
}

/** Un contorno en sentido horario (TrueType, y para arriba). */
const rect = ({ x0, y0, x1, y1 }) => [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];

/* Los cuadrantes: arriba-izq, arriba-der, abajo-izq, abajo-der. Tres juntos son
   una L de un solo contorno (dos rectángulos pegados podrían dejar costura). */
const Q = { ul: [0, .5, .5, 1], ur: [.5, .5, 1, 1], ll: [0, 0, .5, .5], lr: [.5, 0, 1, .5] };
function quads(...names) {
  if (names.length < 3) return names.map((n) => rect(box(...Q[n])));
  const f = box(0, 0, 1, 1);
  const mx = at.x(.5);
  const my = at.y(.5);
  // Las esquinas en orden horario; la que falta se reemplaza por la muesca.
  const corners = { ll: [f.x0, f.y0], ul: [f.x0, f.y1], ur: [f.x1, f.y1], lr: [f.x1, f.y0] };
  const order = ['ll', 'ul', 'ur', 'lr'];
  const gone = order.find((n) => !names.includes(n));
  const pts = [];
  order.forEach((n, i) => {
    if (n !== gone) { pts.push(corners[n]); return; }
    const prev = corners[order[(i + 3) % 4]];
    const next = corners[order[(i + 1) % 4]];
    const [cx, cy] = corners[n];
    pts.push(prev[0] === cx ? [cx, my] : [mx, cy]);
    pts.push([mx, my]);
    pts.push(next[0] === cx ? [cx, my] : [mx, cy]);
  });
  return [pts];
}

const eighthsLow = (n) => [rect(box(0, 0, 1, n / 8))];
const eighthsLeft = (n) => [rect(box(0, 0, n / 8, 1))];

const GLYPHS = [
  [0x2580, [rect(box(0, .5, 1, 1))]],                 // ▀
  ...[1, 2, 3, 4, 5, 6, 7].map((n, i) => [0x2581 + i, eighthsLow(n)]),   // ▁▂▃▄▅▆▇
  [0x2588, [rect(box(0, 0, 1, 1))]],                  // █
  ...[7, 6, 5, 4, 3, 2, 1].map((n, i) => [0x2589 + i, eighthsLeft(n)]),  // ▉▊▋▌▍▎▏
  [0x2590, [rect(box(.5, 0, 1, 1))]],                 // ▐
  [0x2594, [rect(box(0, 7 / 8, 1, 1))]],              // ▔
  [0x2595, [rect(box(7 / 8, 0, 1, 1))]],              // ▕
  [0x2596, quads('ll')],                              // ▖
  [0x2597, quads('lr')],                              // ▗
  [0x2598, quads('ul')],                              // ▘
  [0x2599, quads('ul', 'll', 'lr')],                  // ▙
  [0x259A, quads('ul', 'lr')],                        // ▚
  [0x259B, quads('ul', 'ur', 'll')],                  // ▛
  [0x259C, quads('ul', 'ur', 'lr')],                  // ▜
  [0x259D, quads('ur')],                              // ▝
  [0x259E, quads('ur', 'll')],                        // ▞
  [0x259F, quads('ur', 'll', 'lr')],                  // ▟
];

/* ── Escribir el TrueType ─────────────────────────────────────────────────── */

class Buf {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 0xff); return this; }
  u16(v) { return this.u8(v >> 8).u8(v); }
  i16(v) { return this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v) { return this.u16(Math.floor(v / 0x10000) & 0xffff).u16(v & 0xffff); }
  tag(s) { for (const c of s) this.u8(c.charCodeAt(0)); return this; }
  pad4() { while (this.bytes.length % 4) this.u8(0); return this; }
  get length() { return this.bytes.length; }
  build() { return Buffer.from(this.bytes); }
}

function glyf(contours) {
  const b = new Buf();
  if (!contours.length) return { data: b.build(), bbox: null, points: 0 };
  const pts = contours.flat();
  const bbox = {
    x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])),
    x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])),
  };
  b.i16(contours.length).i16(bbox.x0).i16(bbox.y0).i16(bbox.x1).i16(bbox.y1);
  let end = -1;
  for (const c of contours) { end += c.length; b.u16(end); }
  b.u16(0);                                  // sin instrucciones
  for (let i = 0; i < pts.length; i++) b.u8(0x01);   // todos sobre la curva, x e y de 16 bits
  let last = 0;
  for (const [x] of pts) { b.i16(x - last); last = x; }
  last = 0;
  for (const [, y] of pts) { b.i16(y - last); last = y; }
  return { data: b.pad4().build(), bbox, points: pts.length };
}

const glyphs = [glyf([]), ...GLYPHS.map(([, c]) => glyf(c))];   // la 0 es .notdef, vacía
const boxes = glyphs.map((g) => g.bbox).filter(Boolean);
const all = {
  x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
  x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)),
};
const numGlyphs = glyphs.length;

const tables = {};

{ // glyf + loca (offsets largos)
  const g = new Buf();
  const loca = new Buf();
  for (const { data } of glyphs) { loca.u32(g.length); for (const v of data) g.u8(v); }
  loca.u32(g.length);
  tables.glyf = g.build();
  tables.loca = loca.build();
}

{ // head (checkSumAdjustment se llena al final)
  const b = new Buf();
  const when = Math.floor(Date.UTC(2026, 9, 10) / 1000) + 2082844800;   // segundos desde 1904
  b.u32(0x00010000).u32(0x00010000).u32(0).u32(0x5F0F3CF5)
    .u16(0x000B).u16(UPM)
    .u32(0).u32(when).u32(0).u32(when)
    .i16(all.x0).i16(all.y0).i16(all.x1).i16(all.y1)
    .u16(0).u16(8).i16(2).i16(1).i16(0);
  tables.head = b.build();
}

{ // hhea
  const lsbs = glyphs.map((g) => g.bbox?.x0 ?? 0);
  const rsbs = glyphs.filter((g) => g.bbox).map((g) => ADV - g.bbox.x1);
  const b = new Buf();
  b.u32(0x00010000).i16(ASC).i16(-DESC).i16(0).u16(ADV)
    .i16(Math.min(...lsbs)).i16(Math.min(...rsbs)).i16(all.x1)
    .i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0)
    .u16(numGlyphs);
  tables.hhea = b.build();
}

{ // hmtx: todas del ancho de Roboto Mono
  const b = new Buf();
  for (const g of glyphs) b.u16(ADV).i16(g.bbox?.x0 ?? 0);
  tables.hmtx = b.build();
}

{ // maxp 1.0
  const b = new Buf();
  b.u32(0x00010000).u16(numGlyphs)
    .u16(Math.max(...glyphs.map((g) => g.points)))
    .u16(Math.max(...GLYPHS.map(([, c]) => c.length)))
    .u16(0).u16(0).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);
  tables.maxp = b.build();
}

{ // OS/2 v4. USE_TYPO_METRICS: el alto de línea sale de typo (el de Roboto
  // Mono); win abarca lo que se pasa, que Windows no lo recorte.
  const b = new Buf();
  // Subíndice, superíndice, tachado, alto de x y de mayúscula: los de Roboto Mono, al doble.
  b.u16(4).i16(ADV).u16(400).u16(5).u16(0)
    .i16(2868).i16(2662).i16(0).i16(574)
    .i16(2868).i16(2662).i16(0).i16(1954)
    .i16(204).i16(1024)
    .i16(0);
  [2, 0, 0, 9, 0, 0, 0, 0, 0, 0].forEach((v) => b.u8(v));   // PANOSE: texto, monoespaciada
  b.u32(0).u32(1 << 21).u32(0).u32(0)             // ulUnicodeRange: bit 53, Block Elements
    .tag('UMBX')
    .u16(0x00C0)                                  // REGULAR | USE_TYPO_METRICS
    .u16(GLYPHS[0][0]).u16(GLYPHS.at(-1)[0])
    .i16(ASC).i16(-DESC).i16(0)
    .u16(all.y1).u16(-all.y0)
    .u32(1).u32(0)                                // Latin 1
    .i16(2164).i16(2912)
    .u16(0).u16(0x20).u16(0);
  tables['OS/2'] = b.build();
}

{ // cmap: formato 4, tramos contiguos
  const runs = [];
  GLYPHS.forEach(([cp], i) => {
    const r = runs.at(-1);
    if (r && cp === r.end + 1) r.end = cp;
    else runs.push({ start: cp, end: cp, gid: i + 1 });
  });
  runs.push({ start: 0xFFFF, end: 0xFFFF, gid: 0, last: true });
  const seg = runs.length;
  const pow = 2 ** Math.floor(Math.log2(seg));
  const sub = new Buf();
  sub.u16(4).u16(16 + seg * 8).u16(0)
    .u16(seg * 2).u16(pow * 2).u16(Math.log2(pow)).u16(seg * 2 - pow * 2);
  runs.forEach((r) => sub.u16(r.end));
  sub.u16(0);
  runs.forEach((r) => sub.u16(r.start));
  runs.forEach((r) => sub.u16(r.last ? 1 : (r.gid - r.start + 0x10000) & 0xffff));
  runs.forEach(() => sub.u16(0));
  const b = new Buf();
  b.u16(0).u16(2).u16(0).u16(3).u32(20).u16(3).u16(1).u32(20);   // Unicode BMP y Windows BMP, la misma tabla
  for (const v of sub.build()) b.u8(v);
  tables.cmap = b.build();
}

{ // name
  const names = [
    [0, '© 2026 Kidd Shady · Umbrovex Systems'],
    [1, 'Bloques'],
    [2, 'Regular'],
    [3, 'Bloques Regular 1.000'],
    [4, 'Bloques Regular'],
    [5, 'Version 1.000'],
    [6, 'Bloques-Regular'],
  ];
  const strings = names.map(([, s]) => {
    const u = new Buf();
    for (const ch of s) u.u16(ch.charCodeAt(0));
    return u.build();
  });
  const b = new Buf();
  b.u16(0).u16(names.length).u16(6 + names.length * 12);
  let off = 0;
  names.forEach(([id], i) => {
    b.u16(3).u16(1).u16(0x0409).u16(id).u16(strings[i].length).u16(off);
    off += strings[i].length;
  });
  for (const s of strings) for (const v of s) b.u8(v);
  tables.name = b.build();
}

{ // post 3.0: sin nombres de glifos
  const b = new Buf();
  b.u32(0x00030000).u32(0).i16(-300).i16(200).u32(1).u32(0).u32(0).u32(0).u32(0);
  tables.post = b.build();
}

/* ── Armar el archivo ─────────────────────────────────────────────────────── */

function checksum(buf) {
  let sum = 0;
  const padded = Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)]);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

const tags = Object.keys(tables).sort();
const n = tags.length;
const pow = 2 ** Math.floor(Math.log2(n));
const head = new Buf();
head.u32(0x00010000).u16(n).u16(pow * 16).u16(Math.log2(pow)).u16(n * 16 - pow * 16);
let offset = 12 + n * 16;
const body = [];
for (const tag of tags) {
  const data = tables[tag];
  head.tag(tag).u32(checksum(data)).u32(offset).u32(data.length);
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  body.push(padded);
  offset += padded.length;
}
const font = Buffer.concat([head.build(), ...body]);
const headAt = 12 + n * 16 + body.slice(0, tags.indexOf('head')).reduce((s, b) => s + b.length, 0);
font.writeUInt32BE((0xB1B0AFBA - checksum(font)) >>> 0, headAt + 8);

fs.writeFileSync(OUT, font);
console.log(`${GLYPHS.length} bloques · ${font.length} bytes → ${path.relative(ROOT, OUT)}`);
