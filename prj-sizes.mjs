/**
 * The sizes of an ET PRJ of the 2.0 layout (08): size names, the size table, the grading rule of each point, and the size
 * layers of a file that was saved after ET expanded its sizes.
 *
 * What the file holds, as found by reading files ET 2017 wrote and comparing with its own dialogs and its own expansion:
 *
 *   Header, after the forty fabric names:
 *     u32            the series in use (0 to 4; ET shows them as columns A to E of 号型名称)
 *     5 x 50 strings the size names of each series; a position is a size, position 9 is the base size
 *     u32 1, u32 n   the size table (尺寸表): n rows, each a name and 50 numbers, one per position, in centimetres
 *     5 zero bytes, u32 9, u32 9, the document class
 *   Then the fifty positions in order: u32 0 for a position without a layer, or u32 1 and the layer of that size. A file that
 *   was not expanded has the base layer only: 36 zero bytes, the layer, 160 zero bytes. A layer is
 *     u32 1, an id, u32 0, a colour, f32 1, u32 0, a byte (bit 0 set for the base size), the size name, u32 9,
 *     and then everything a single-size file holds: points, lines, pieces, texts, marks, corners.
 *
 *   A point that carries a rule has 0x40 in its first flag byte and a kind after its owner:
 *     2   moved by two formulas (移动点): one along each axis of the rule
 *     10  follows another point that lies on the same place (ET adds these when it expands)
 *   and after the 34 bytes every point has:
 *     u32 0, u8 0, the two formulas as strings, u32 0, u32 0, u32 master (kind 10: number of the point it follows),
 *     u8 0, the two axes of the rule (three numbers each), u32 k and k pairs (6, number of a point that follows this one).
 *   A notch (point type 7) has its 46 bytes after that.
 *
 * A formula is arithmetic over the names of the size table ("胸围/4+衣长/10"). The point moves, in a size, along the axes
 * of the rule, by the value of the formula with every name standing for how much that row differs from the base size; numbers
 * are taken as written, and a formula of numbers only counts once per size step ("1": one centimetre per size). ET's own
 * expansion of a real pattern (111 such points, six sizes) agrees with this to 0.0003 mm, and a probe file settled the numbers.
 */
export const BASE_SLOT = 9, SLOTS = 50, SERIES = 5;
const SERIES_NAMES = ['A', 'B', 'C', 'D', 'E'];
const SIGNATURE = [0x51, 0x7f, 1, 1, 0, 0, 0, 0x40];

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder('gb18030', { fatal: true });
  const r = { o: 0,
    need(n) { if (n < 0 || r.o + n > bytes.length) throw new Error('truncated'); },
    u8() { r.need(1); return bytes[r.o++]; }, u16() { r.need(2); const x = view.getUint16(r.o, true); r.o += 2; return x; }, u32() { r.need(4); const x = view.getUint32(r.o, true); r.o += 4; return x; },
    f32() { r.need(4); const x = view.getFloat32(r.o, true); r.o += 4; return x; }, skip(n) { r.need(n); r.o += n; },
    str() { const n = r.u16(); if (n > 4096) throw new Error('string'); r.need(n); const s = decoder.decode(bytes.subarray(r.o, r.o + n)); r.o += n; return s; } };
  return r;
}

/** The size names and the size table of a 2.0 file, or null when the header is not the one described above. */
export function readSizeSystem(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 600 || !SIGNATURE.every((v, i) => bytes[i] === v)) return null;
  try {
    const r = reader(bytes);
    r.skip(8); r.u32(); r.str(); r.str(); r.str(); r.u32(); r.skip(13); r.u32(); r.skip(3); r.u8(); r.u32(); r.skip(12);
    for (let i = 0; i < 7; i++) r.str();                       // collection, style, note, date, base size, an empty one, the size list
    r.u8(); for (let i = 0; i < 40; i++) r.str();              // fabric names
    const activeSeries = r.u32(); if (activeSeries >= SERIES) return null;
    const series = Array.from({ length: SERIES }, () => Array.from({ length: SLOTS }, () => r.str()));
    const flag = r.u32(), rows = r.u32(); if (flag > 1 || rows > 500) return null;
    const table = [];
    for (let i = 0; i < rows; i++) { const name = r.str(), values = Array.from({ length: SLOTS }, () => r.f32()); if (values.some(v => !Number.isFinite(v))) return null; table.push({ name, values }); }
    r.skip(5); const a = r.u32(), b = r.u32(); if (a >= SLOTS || b >= SLOTS) return null;
    r.u32(); const slotsAt = r.o; let firstSlot = 0;
    while (firstSlot < SLOTS && r.u32() === 0) firstSlot++;      // the positions before the first layer
    if (firstSlot >= SLOTS) return null;
    return { activeSeries, series, table, slotsAt, firstSlot, firstLayer: r.o - 4 };
  } catch { return null; }
}

function layerAt(bytes, view, root, names) {
  // u32 1 (this position has a layer), u32 1, id, u32 0, colour, f32 1, u32 0, flag byte, name, u32 9, point count, first point
  if (root < 0 || root + 44 > bytes.length || view.getUint32(root, true) !== 1 || view.getUint32(root + 4, true) !== 1 || view.getUint32(root + 12, true) !== 0) return null;
  if (view.getFloat32(root + 19, true) !== 1 || view.getUint32(root + 23, true) !== 0 || (bytes[root + 27] & 0x7e)) return null;
  const length = view.getUint16(root + 28, true); if (length < 1 || length > 60 || root + 42 + length > bytes.length) return null;
  let name; try { name = new TextDecoder('gb18030', { fatal: true }).decode(bytes.subarray(root + 30, root + 30 + length)); } catch { return null; }
  if (names && !names.has(name)) return null;
  const after = root + 30 + length; if (view.getUint32(after, true) !== 9) return null;
  const count = view.getUint32(after + 4, true), first = view.getUint32(after + 8, true); if (count > 200000 || (count && first !== 6 && first !== 7)) return null;
  return { name, base: (bytes[root + 27] & 1) === 1, offset: root, pointsAt: after + 8, pointCount: count };
}

/** The size layers of a 2.0 file in file order; one layer for a file that was not expanded. Null when the header is not understood. */
export function sizeLayers(input, system = readSizeSystem(input)) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input); if (!system) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), first = layerAt(bytes, view, system.firstLayer, null); if (!first) return null;
  const layers = [first], names = new Set(system.series.flat().filter(Boolean)); names.delete(first.name);
  // A further layer starts with the same record and the name of another size of the file.
  if (names.size) for (let root = first.pointsAt + 34; root + 44 <= bytes.length; root++) {
    if (bytes[root] !== 1 || bytes[root + 4] !== 1) continue;
    const layer = layerAt(bytes, view, root, names); if (!layer) continue;
    layers.push(layer); names.delete(layer.name); root = layer.pointsAt + 33; if (!names.size) break;
  }
  // The position of a layer is the place of its name in the series in use; the first one is known from the empty positions before it.
  const active = system.series[system.activeSeries]; layers[0].slot = system.firstSlot;
  for (let i = 1; i < layers.length; i++) { const slot = active.indexOf(layers[i].name); layers[i].slot = slot > layers[i - 1].slot ? slot : layers[i - 1].slot + 1; }
  // a layer ends where the empty positions before the next layer begin; after the last one come the positions that are left
  layers.forEach((layer, i) => { layer.end = i + 1 < layers.length ? layers[i + 1].offset - 4 * (layers[i + 1].slot - layer.slot - 1) : bytes.length - 4 * (SLOTS - 1 - layer.slot); });
  if (layers.some(layer => layer.slot >= SLOTS || layer.end <= layer.pointsAt)) return null;
  return layers;
}

/**
 * The file as a single-size file of its base size. A file with one layer is returned as it is. For a file ET saved after
 * expanding its sizes, the other layers are left out: they are what the rules give, and ET makes them again on 推板展开.
 */
export function baseSizeLayer(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input), system = readSizeSystem(bytes), layers = system && sizeLayers(bytes, system);
  if (!layers || layers.length < 2) return { bytes, layers: layers || [], system, spliced: false };
  const base = layers.find(layer => layer.base) || layers[0], head = bytes.subarray(0, system.slotsAt), body = bytes.subarray(base.offset, base.end);
  // the positions before the base size, its layer, the positions after it
  const out = new Uint8Array(head.length + 4 * base.slot + body.length + 4 * (SLOTS - 1 - base.slot)); out.set(head, 0); out.set(body, head.length + 4 * base.slot);
  return { bytes: out, layers, system, spliced: true, base: base.name };
}

/**
 * The points of a layer, read one after the other, with the rule each carries. `end` is where the lines begin.
 * Throws when a record is not one of the kinds described at the top.
 */
export function readPointRules(input, pointsAt, pointCount) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input), r = reader(bytes), points = []; r.o = pointsAt;
  for (let i = 0; i < pointCount; i++) {
    const offset = r.o, type = r.u32(); if (type !== 6 && type !== 7) throw new Error('point type ' + type);
    const id = r.u32(); r.skip(3); const flags = [r.u8(), r.u8(), r.u8()], x = r.f32(), y = r.f32(); r.f32(); const owner = r.u32(), kind = r.u32(), point = { index: i, offset, type, id, flags, x, y, owner, kind };
    if (flags[0] & 0x40) {
      const a = r.u32(), b = r.u8(), fx = r.str(), fy = r.str(), p1 = r.u32(), p2 = r.u32(), master = r.u32(), c = r.u8(), ax = [r.f32(), r.f32(), r.f32()], ay = [r.f32(), r.f32(), r.f32()], count = r.u32();
      if (count > 1000) throw new Error('followers'); const followers = Array.from({ length: count }, () => { r.u32(); return r.u32(); });
      point.rule = { kind, x: fx, y: fy, axisX: [ax[0], ax[1]], axisY: [ay[0], ay[1]], master: kind === 10 ? master : 0, followers, plain: a === 0 && b === 0 && p1 === 0 && p2 === 0 && c === 0 && ax[2] === 0 && ay[2] === 0 && (kind === 10 || master === 0) };
    } else if (kind !== 0 && type === 6 && !(flags[2])) point.kindWithoutRule = kind;
    if (type === 7) r.skip(46);
    points.push(point);
  }
  return { points, end: r.o };
}

export { parseFormula, formulaNames, evaluateFormula } from './size-formula.mjs';
export const seriesName = index => SERIES_NAMES[index] || String(index + 1);

/**
 * What a 2.0 file says about sizes, for the reader of single-size files: the names of the series in use, the size table and the
 * rule of every point. `nodes` are the point records the reader found (with their offsets); a rule names its point by its place
 * in that list. Nothing here throws: what could not be read is said in `problem`.
 */
export function readSizes(input, nodes) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input), none = problem => ({ readable: false, problem, names: [], series: [], table: [], rules: [], layers: [] });
  const system = readSizeSystem(bytes); if (!system) return none('文件头里的号型和尺寸表没有读懂');
  const layers = sizeLayers(bytes, system); if (!layers) return none('各码的图层没有读懂');
  const layer = layers.find(item => item.base) || layers[0]; let read;
  try { read = readPointRules(bytes, layer.pointsAt, layer.pointCount); } catch (error) { return { ...none('点的放码规则没有读懂（' + error.message + '）'), activeSeries: system.activeSeries, table: system.table }; }
  const byOffset = new Map((nodes || []).map((node, index) => [node.offset, index])), rules = [];
  for (const point of read.points) if (point.rule) rules.push({ node: byOffset.has(point.offset) ? byOffset.get(point.offset) : null, pointNumber: point.index + 1, onNotch: point.type === 7, kind: point.rule.kind, x: point.rule.x, y: point.rule.y, axisX: point.rule.axisX, axisY: point.rule.axisY, master: point.rule.master, plain: point.rule.plain });
  const series = system.series.map((names, index) => ({ name: seriesName(index), sizes: names.map((name, slot) => name ? { slot, name } : null).filter(Boolean) }));
  return { readable: true, activeSeries: system.activeSeries, names: series[system.activeSeries].sizes, series, baseSlot: layer.slot, baseName: layer.name, table: system.table.map(row => ({ name: row.name, values: [...row.values] })), rules,
    layers: layers.map(item => ({ name: item.name, base: item.base, slot: item.slot })) };
}

/** One size of a file with several layers, as a single-size file (the same bytes ET would write for that size alone). Null when there is no such layer. */
export function sizeLayerFile(input, name) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input), system = readSizeSystem(bytes), layers = system && sizeLayers(bytes, system), layer = layers && layers.find(item => item.name === name);
  if (!layer) return null;
  const head = bytes.subarray(0, system.slotsAt), body = bytes.subarray(layer.offset, layer.end), out = new Uint8Array(head.length + 4 * layer.slot + body.length + 4 * (SLOTS - 1 - layer.slot));
  out.set(head, 0); out.set(body, head.length + 4 * layer.slot); return out;
}
