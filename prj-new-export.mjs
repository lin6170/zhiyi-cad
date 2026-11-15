/**
 * Complete new ET PRJ (the "08" 2.0 layout) written from a millimetre project:
 * pieces with their net contour, internal lines, grain line, text and seam
 * allowances. The byte layout is the one ET itself writes for a new document;
 * nothing is copied from a user pattern. File coordinates are centimetres.
 *
 * Scope is deliberately strict. Anything this module cannot represent is
 * reported as a blocking reason instead of being dropped.
 */
import { fitClampedSpline, nativeFitPoints } from './fit-spline.mjs';
import { evaluateBSpline, validateCurve } from './curves.mjs';
import { orientChain, contoursForGroup } from './topology.mjs';
import { textWidth } from './geometry.mjs';
import { edgeWidthMap, edgeKey } from './seam-widths.mjs';
import { parsePrj } from './prj-parser.mjs';

export const NEW_PRJ_FORMAT = 'ET PRJ 2.0 / 08';
export const NEW_PRJ_NATIVE_VERIFIED = true;
const DOCUMENT_CLASS = 0x0b8f70ad, WHITE = [255, 255, 255], SEAM = [255, 128, 0], INTERNAL = [128, 128, 128];
const MM_PER_UNIT = 10, LIMIT = 100000, CURVE_TOLERANCE = .001, GAP_TOLERANCE = .005, SMOOTH_SINE = Math.sin(20 * Math.PI / 180);
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

// ---------------------------------------------------------------- GBK text
let gbkTable = null;
/** ET stores text in code page 936. Characters outside it are rejected, never replaced. */
export function encodeGbk(text) {
  if (!gbkTable) {
    gbkTable = new Map(); const decoder = new TextDecoder('gb18030', { fatal: false });
    for (let lead = 0x81; lead <= 0xfe; lead++) for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      const character = decoder.decode(Uint8Array.of(lead, trail));
      if (character.length === 1 && character !== '�' && !gbkTable.has(character)) gbkTable.set(character, [lead, trail]);
    }
  }
  const bytes = [];
  for (const character of String(text)) {
    const code = character.codePointAt(0);
    if (code < 0x80) { if (code < 0x20) throw new Error('文字含控制字符，不能写入 PRJ。'); bytes.push(code); continue; }
    const pair = gbkTable.get(character);
    if (!pair) throw new Error('文字“' + character + '”不在 ET 使用的 GBK 字符集中，不能写入 PRJ。');
    bytes.push(pair[0], pair[1]);
  }
  if (bytes.length > 4096) throw new Error('文字过长，不能写入 PRJ。');
  return Uint8Array.from(bytes);
}

// ---------------------------------------------------------------- bytes
class Writer {
  constructor() { this.parts = []; this.length = 0; }
  bytes(values) { const b = values instanceof Uint8Array ? values : Uint8Array.from(values); this.parts.push(b); this.length += b.length; return this; }
  zero(count) { return this.bytes(new Uint8Array(count)); }
  u8(value) { return this.bytes([value & 255]); }
  u16(value) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, value, true); return this.bytes(b); }
  u32(value) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value >>> 0, true); return this.bytes(b); }
  f32(value) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, value, true); return this.bytes(b); }
  string(text) { const b = encodeGbk(text); return this.u16(b.length).bytes(b); }
  point(p) { return this.f32(p.x).f32(p.y).f32(0); }
  list(values) { this.u32(values.length); for (const value of values) this.u32(value); return this; }
  done() { const out = new Uint8Array(this.length); let o = 0; for (const part of this.parts) { out.set(part, o); o += part.length; } return out; }
}
const IDENTITY_TRANSFORM = (() => {
  const w = new Writer();
  for (let block = 0; block < 2; block++) { for (let i = 0; i < 13; i++) w.f32(i % 4 === 0 ? 1 : 0); w.bytes([0, 0, 0, 1]); }
  return w.done();
})();
const MATERIAL_GROUPS = [['面料'], ['里'], ['衬', '棉'], ['实样']];

/** Serialize an explicit model. Every identity and coordinate comes from the model. */
export function encodeNewPrj(model) {
  const w = new Writer(), h = model.header, size = h.sizeName;
  // File header and the document information block of ET's own default document.
  w.bytes([0x51, 0x7f, 1, 1]).f32(2).u32(0).string('PD').string('').string('');
  w.u32(DOCUMENT_CLASS).u32(1).u32(2).u32(0).u8(0).u32(h.id).bytes(WHITE).u8(1).u32(0).zero(12);
  w.string(h.collection).string(h.style).string(h.note).string(h.savedAt).string(size).string('').string(size + ' 总数: 1').u8(0);
  for (const group of MATERIAL_GROUPS) for (let i = 0; i < 10; i++) w.string(group[i] || '');
  w.zero(22);
  for (let i = 0; i < 50; i++) w.string(i ? '' : size);
  for (let i = 0; i < 50; i++) w.string(i ? '' : '38');
  w.zero(282).u32(1).zero(9).u32(9).u32(9).u32(DOCUMENT_CLASS).zero(36);
  // One size.
  w.u32(1).u32(1).u32(model.root.id).u32(0).bytes(WHITE).f32(1).u32(0).u8(1).string(size).u32(9);
  w.u32(model.nodes.length);
  for (const node of model.nodes) w.u32(6).u32(node.id).bytes([0, 0, 255, 0, 0, 0]).point(node).u32(node.owner).u32(0);
  w.u32(model.curves.length);
  model.curves.forEach((curve, index) => {
    w.u32(curve.id).bytes(curve.base).bytes(curve.flags);
    if (curve.kind === 2) w.u32(2).u32(0).u32(0).bytes(curve.color).f32(1).u32(curve.style).u8(0).point(curve.points[0]).point(curve.points[1]);
    else {
      w.u32(4).u32(0).bytes(curve.base).u8(0).u32(0).u32(0).bytes(curve.color).f32(1).u32(curve.style);
      w.u32(curve.points.length); for (const p of curve.points) w.point(p);
      w.u32(curve.controls.length); for (const p of curve.controls) w.point(p);
      w.u32(0); // ET rebuilds its display table when the file is opened.
    }
    w.list([index * 2 + 1, index * 2 + 2]).list([]).list(curve.links).f32(curve.width).u32(0).u32(0).u16(0);
  });
  w.u32(model.pieces.length);
  model.pieces.forEach((piece, index) => {
    w.u32(piece.id).bytes(WHITE).u8(0x20).zero(13).u32(1).u32(piece.id2).bytes(WHITE).u32(piece.id2);
    w.string(h.style).string(piece.name).string(size).string('面料').u32(100).string(piece.symmetric ? '对称' : '不对称');
    w.u32(1).u32(piece.symmetric ? 1 : 0).f32(0).u32(0).string('MD').u32(piece.mode);
    w.point(piece.center).point(piece.end1).u32(0).point(piece.center).point(piece.end2).u32(0).u16(0);
    w.u32(1).u8(0).u8(0).list(piece.chain).u32(index + 1);
    w.list(piece.ownedCurves).list(piece.ownedCurves.flatMap(curve => [curve * 2 - 1, curve * 2])).list(piece.corners).list(piece.texts).list([]);
    w.bytes(IDENTITY_TRANSFORM);
  });
  w.u32(model.texts.length);
  for (const text of model.texts) {
    w.u32(text.id).u32(0).bytes(WHITE).f32(1).u32(0).u8(0).u32(1).u8(0).u32(1);
    w.f32(text.x).f32(text.y).f32(text.cos).f32(text.sin).f32(text.width).f32(text.height).u32(0).string(text.text).f32(text.x2).f32(text.y2).zero(6);
  }
  w.u32(0).u32(0).u32(model.corners.length);
  for (const corner of model.corners) w.u32(0).bytes(WHITE).u8(0).u32(corner.curve).u32(corner.end).u32(0).u32(0xffffffff);
  w.zero(160);
  const bytes = w.done();
  if (bytes.length > 16 * 1024 * 1024) throw new Error('生成的 PRJ 超过 16 MB。');
  return bytes;
}

/** Strict inverse of encodeNewPrj. Accepts only files this module can write. */
export function readNewPrj(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder('gb18030', { fatal: true });
  let o = 0;
  const fail = message => { throw new Error('新建 PRJ 校验：' + message + '（偏移 ' + o + '）'); };
  const need = n => { if (o + n > bytes.length) fail('文件被截断'); };
  const u8 = () => { need(1); return bytes[o++]; };
  const u16 = () => { need(2); const v = view.getUint16(o, true); o += 2; return v; };
  const u32 = () => { need(4); const v = view.getUint32(o, true); o += 4; return v; };
  const f32 = () => { need(4); const v = view.getFloat32(o, true); o += 4; return v; };
  const string = () => { const n = u16(); need(n); let s; try { s = decoder.decode(bytes.subarray(o, o + n)); } catch { fail('文字编码无效'); } o += n; return s; };
  const expect = (expected, actual, what) => { if (expected !== actual) fail(what + '不符合新建布局'); };
  const zeros = (n, what) => { need(n); for (let i = 0; i < n; i++) if (bytes[o + i]) fail(what + '应为零'); o += n; };
  const rgb = () => [u8(), u8(), u8()];
  const white = what => { const c = rgb(); if (c.some(v => v !== 255)) fail(what + '颜色不符'); };
  const point = () => { const x = f32(), y = f32(); if (f32() !== 0 || ![x, y].every(v => Number.isFinite(v) && Math.abs(v) < LIMIT)) fail('坐标无效'); return { x, y }; };
  const list = () => { const n = u32(); if (n > 100000) fail('引用数量异常'); return Array.from({ length: n }, u32); };
  const literal = (text, what) => expect(text, string(), what);

  for (const value of [0x51, 0x7f, 1, 1]) expect(value, u8(), '文件头');
  expect(2, f32(), '版本'); expect(0, u32(), '文件头'); literal('PD', '文件头'); literal('', '文件头'); literal('', '文件头');
  const header = {};
  expect(DOCUMENT_CLASS, u32(), '文档类别'); expect(1, u32(), '文档信息'); expect(2, u32(), '文档信息'); expect(0, u32(), '文档信息'); expect(0, u8(), '文档信息');
  header.id = u32(); white('文档'); expect(1, u8(), '文档信息'); expect(0, u32(), '文档信息'); zeros(12, '文档信息');
  header.collection = string(); header.style = string(); header.note = string(); header.savedAt = string(); header.sizeName = string();
  literal('', '文档信息'); literal(header.sizeName + ' 总数: 1', '尺码计数'); expect(0, u8(), '文档信息');
  for (const group of MATERIAL_GROUPS) for (let i = 0; i < 10; i++) literal(group[i] || '', '布料表');
  zeros(22, '布料表');
  for (let i = 0; i < 50; i++) literal(i ? '' : header.sizeName, '号型表');
  for (let i = 0; i < 50; i++) literal(i ? '' : '38', '号型表');
  zeros(282, '号型表'); expect(1, u32(), '尺寸表'); zeros(9, '尺寸表'); expect(9, u32(), '尺寸表'); expect(9, u32(), '尺寸表'); expect(DOCUMENT_CLASS, u32(), '文档类别'); zeros(36, '尺码前缀');
  expect(1, u32(), '尺码'); expect(1, u32(), '尺码');
  const root = { id: u32() }; expect(0, u32(), '尺码'); white('尺码'); expect(1, f32(), '尺码'); expect(0, u32(), '尺码'); expect(1, u8(), '尺码'); literal(header.sizeName, '尺码名'); expect(9, u32(), '尺码');
  const nodeCount = u32(); if (nodeCount > 200000) fail('节点数量异常');
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    expect(6, u32(), '节点类型'); const id = u32(); expect(0, u8(), '节点'); expect(0, u8(), '节点'); expect(255, u8(), '节点'); zeros(3, '节点标志');
    const p = point(), owner = u32(); expect(0, u32(), '节点'); nodes.push({ id, x: p.x, y: p.y, owner });
  }
  const curveCount = u32(); if (curveCount * 2 !== nodeCount) fail('节点与线条数量不一致');
  const curves = [];
  for (let i = 0; i < curveCount; i++) {
    const curve = { id: u32(), base: rgb(), flags: [u8(), u8(), u8()], kind: u32() }; expect(0, u32(), '线条');
    if (curve.kind === 2) { expect(0, u32(), '直线'); curve.color = rgb(); expect(1, f32(), '直线'); curve.style = u32(); expect(0, u8(), '直线'); curve.points = [point(), point()]; }
    else if (curve.kind === 4) {
      const again = rgb(); if (again.some((v, k) => v !== curve.base[k])) fail('曲线底色不一致'); expect(0, u8(), '曲线'); expect(0, u32(), '曲线'); expect(0, u32(), '曲线');
      curve.color = rgb(); expect(1, f32(), '曲线'); curve.style = u32();
      const n = u32(); if (n < 2 || n > 1000) fail('曲线点数异常'); curve.points = Array.from({ length: n }, point);
      expect(n + 2, u32(), '曲线控制点数'); curve.controls = Array.from({ length: n + 2 }, point); expect(0, u32(), '曲线显示表');
    } else fail('线条类型不受支持');
    const direct = list(); if (direct.length !== 2 || direct[0] !== i * 2 + 1 || direct[1] !== i * 2 + 2) fail('线条节点引用不符');
    if (list().length) fail('线条附加节点不受支持');
    curve.links = list(); curve.width = f32(); expect(0, u32(), '线条'); expect(0, u32(), '线条'); expect(0, u16(), '线条');
    curves.push(curve);
  }
  const pieceCount = u32(); if (pieceCount > 10000) fail('裁片数量异常');
  const pieces = [];
  for (let i = 0; i < pieceCount; i++) {
    const piece = { id: u32() }; white('裁片'); expect(0x20, u8(), '裁片'); zeros(13, '裁片'); expect(1, u32(), '裁片'); piece.id2 = u32(); white('裁片'); expect(piece.id2, u32(), '裁片');
    literal(header.style, '裁片款式'); piece.name = string(); literal(header.sizeName, '裁片号型'); literal('面料', '裁片布料'); expect(100, u32(), '裁片布料');
    const symmetry = string(); if (!['对称', '不对称'].includes(symmetry)) fail('裁片对称属性不符'); piece.symmetric = symmetry === '对称';
    expect(1, u32(), '裁片数量'); expect(piece.symmetric ? 1 : 0, u32(), '裁片对称'); expect(0, f32(), '裁片角度'); expect(0, u32(), '裁片'); literal('MD', '裁片标签'); piece.mode = u32();
    piece.center = point(); piece.end1 = point(); expect(0, u32(), '布纹'); const again = point(); if (again.x !== piece.center.x || again.y !== piece.center.y) fail('布纹中心不一致'); piece.end2 = point(); expect(0, u32(), '布纹'); expect(0, u16(), '裁片');
    expect(1, u32(), '轮廓数量'); expect(0, u8(), '轮廓'); expect(0, u8(), '轮廓'); piece.chain = list(); expect(i + 1, u32(), '轮廓归属');
    piece.ownedCurves = list(); const ownedNodes = list();
    if (canonical(ownedNodes) !== canonical(piece.ownedCurves.flatMap(curve => [curve * 2 - 1, curve * 2]))) fail('裁片节点引用不符');
    piece.corners = list(); piece.texts = list(); if (list().length) fail('裁片独立对象不受支持');
    need(112); for (let k = 0; k < 112; k++) if (bytes[o + k] !== IDENTITY_TRANSFORM[k]) fail('裁片变换不符'); o += 112;
    pieces.push(piece);
  }
  const textCount = u32(); if (textCount > 10000) fail('文字数量异常');
  const texts = [];
  for (let i = 0; i < textCount; i++) {
    const text = { id: u32() }; expect(0, u32(), '文字'); white('文字'); expect(1, f32(), '文字'); expect(0, u32(), '文字'); expect(0, u8(), '文字'); expect(1, u32(), '文字'); expect(0, u8(), '文字'); expect(1, u32(), '文字');
    text.x = f32(); text.y = f32(); text.cos = f32(); text.sin = f32(); text.width = f32(); text.height = f32(); expect(0, u32(), '文字'); text.text = string(); text.x2 = f32(); text.y2 = f32(); zeros(6, '文字');
    texts.push(text);
  }
  expect(0, u32(), '附加对象'); expect(0, u32(), '附加对象');
  const cornerCount = u32(); if (cornerCount > 100000) fail('转角数量异常');
  const corners = [];
  for (let i = 0; i < cornerCount; i++) { expect(0, u32(), '转角'); white('转角'); expect(0, u8(), '转角类型'); const corner = { curve: u32(), end: u32() }; expect(0, u32(), '转角'); expect(0xffffffff, u32(), '转角'); corners.push(corner); }
  if (bytes.length - o !== 160) fail('文件尾长度不符'); zeros(160, '文件尾');
  return { header, root, nodes, curves, pieces, texts, corners };
}

// ---------------------------------------------------------------- geometry
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), add = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const cross = (a, b) => a.x * b.y - a.y * b.x, dot = (a, b) => a.x * b.x + a.y * b.y, length = v => Math.hypot(v.x, v.y);
const negate = v => ({ x: -v.x, y: -v.y }), right = t => ({ x: t.y, y: -t.x }), round = p => ({ x: Math.fround(p.x), y: Math.fround(p.y) });
function unit(v, what) { const n = length(v); if (!(n > 1e-9)) throw new Error(what + '长度为零，不能写入 PRJ。'); return { x: v.x / n, y: v.y / n }; }
function segmentDistance(p, a, b) {
  const d = sub(b, a), squared = dot(d, d), t = squared ? Math.max(0, Math.min(1, dot(sub(p, a), d) / squared)) : 0;
  return length(sub(p, add(a, d, t)));
}
/** Smallest distance from a point to the polyline segments in [from, to]. */
function polylineDistance(p, polyline, from, to) {
  let best = Infinity;
  for (let i = Math.max(0, Math.floor(from)); i <= Math.min(polyline.length - 2, Math.ceil(to)); i++) best = Math.min(best, segmentDistance(p, polyline[i], polyline[i + 1]));
  return best;
}
const etKnots = parameters => { const end = parameters.at(-1); return [0, 0, 0, 0, ...parameters.slice(1, -1), end, end, end, end]; };
function sampleEtSpline(data, perSpan) {
  const knots = etKnots(data.parameters), out = [];
  for (let i = 1; i < data.parameters.length; i++) for (let j = i === 1 ? 0 : 1; j <= perSpan; j++) {
    out.push(evaluateBSpline(data.controls, knots, data.parameters[i - 1] + (data.parameters[i] - data.parameters[i - 1]) * j / perSpan, 3));
  }
  return out;
}
function fitEt(points) { const g = fitClampedSpline(points); return { fit: g.fit, controls: g.controls, parameters: g.parameters }; }
/** Tangent direction of an ET spline at one of its fit parameters (one-sided at the ends). */
function etTangent(data, index) {
  const knots = etKnots(data.parameters), end = data.parameters.at(-1), t = data.parameters[index];
  const span = Math.min(...data.parameters.slice(1).map((v, i) => v - data.parameters[i])), h = span * 1e-3;
  const a = evaluateBSpline(data.controls, knots, Math.max(0, t - h), 3), b = evaluateBSpline(data.controls, knots, Math.min(end, t + h), 3);
  return unit(sub(b, a), '曲线切向');
}
/** Convert an editor B-spline (already in file units) into ET fit points within tolerance. */
export function convertCurveToEt(curve, tolerance = CURVE_TOLERANCE) {
  validateCurve(curve);
  const p = curve.degree, knots = curve.knots, start = knots[p], end = knots[curve.controlPoints.length];
  const breaks = [...new Set(knots.filter(k => k >= start && k <= end))].sort((a, b) => a - b);
  const evaluate = t => evaluateBSpline(curve.controlPoints, knots, t, p);
  // A curve that already has ET's own form is written with its own fit points, so ET shows the points it was drawn with.
  const native = nativeFitPoints(curve);
  if (native && native.length <= 120) {
    try {
      const data = fitEt(native.map(round)), etKnotVector = etKnots(data.parameters), own = [start, ...knots.slice(p + 1, knots.length - p - 1), end];
      let deviation = 0;
      for (let i = 1; i < own.length; i++) for (let j = 0; j <= 12; j++) {
        deviation = Math.max(deviation, length(sub(evaluateBSpline(data.controls, etKnotVector, data.parameters[i - 1] + (data.parameters[i] - data.parameters[i - 1]) * j / 12, 3), evaluate(own[i - 1] + (own[i] - own[i - 1]) * j / 12))));
      }
      if (deviation <= tolerance) return { ...data, deviation, native: true };
    } catch { /* not usable as it is: convert by sampling below */ }
  }
  const REFERENCE = 4096, PER = 12, reference = Array.from({ length: REFERENCE + 1 }, (_, i) => evaluate(start + (end - start) * i / REFERENCE));
  const referenceIndex = t => (t - start) / (end - start) * REFERENCE;
  let last = null;
  for (const density of [2, 3, 4, 6, 8, 12, 16, 24, 32]) {
    // An ET curve repeats its end control points, which bends the first and last
    // interval. Two short intervals at each end keep that effect below tolerance.
    const at = [];
    for (let i = 1; i < breaks.length; i++) for (let j = i === 1 ? 0 : 1; j <= density; j++) at.push(breaks[i - 1] + (breaks[i] - breaks[i - 1]) * j / density);
    const first = at[1] - at[0], final = at.at(-1) - at.at(-2);
    at.splice(1, 0, at[0] + first / 16, at[0] + first / 4); at.splice(at.length - 1, 0, at.at(-1) - final / 4, at.at(-1) - final / 16);
    const points = [], used = [];
    for (const t of at) {
      const q = round(evaluate(t));
      if (!points.length || length(sub(q, points.at(-1))) > 1e-4) { points.push(q); used.push(t); }
    }
    if (points.length < 2) throw new Error('曲线过短，不能写入 PRJ。');
    if (points.length > 120) break;
    let data;
    try { data = fitEt(points); } catch { continue; }
    // Compare both ways near the matching parameter, so a loop or a detour cannot hide.
    const etKnotVector = etKnots(data.parameters), sampled = [];
    let deviation = 0;
    for (let i = 1; i < data.parameters.length; i++) {
      const window = (referenceIndex(used[i]) - referenceIndex(used[i - 1])) * 2 + 8;
      for (let j = i === 1 ? 0 : 1; j <= PER; j++) {
        const q = evaluateBSpline(data.controls, etKnotVector, data.parameters[i - 1] + (data.parameters[i] - data.parameters[i - 1]) * j / PER, 3);
        const guess = referenceIndex(used[i - 1] + (used[i] - used[i - 1]) * j / PER);
        sampled.push(q); deviation = Math.max(deviation, polylineDistance(q, reference, guess - window, guess + window));
      }
    }
    for (let i = 1; i < used.length; i++) {
      const from = Math.ceil(referenceIndex(used[i - 1])), to = Math.floor(referenceIndex(used[i])), base = (i - 1) * PER;
      for (let r = from; r <= to; r += 8) deviation = Math.max(deviation, polylineDistance(reference[r], sampled, base - PER, base + 2 * PER));
    }
    last = { ...data, deviation };
    if (deviation <= tolerance) return last;
  }
  throw new Error('曲线无法在 ' + (tolerance * MM_PER_UNIT) + ' mm 容差内转换为 ET 曲线' + (last ? '（当前偏差 ' + (last.deviation * MM_PER_UNIT).toFixed(4) + ' mm）' : '') + '。');
}

// ---------------------------------------------------------------- planning
function formatDate(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('保存时间无效。');
  return { savedAt: [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()].join('/') };
}
function scalePoint(p) {
  const q = { x: p.x / MM_PER_UNIT, y: p.y / MM_PER_UNIT };
  if (![q.x, q.y].every(v => Number.isFinite(v) && Math.abs(v) < LIMIT)) throw new Error('坐标超出 PRJ 范围。');
  return q;
}
/** Split one editor entity into ET edges. Each edge is a straight line or one spline. */
function entityEdges(entity) {
  if (entity.curve) {
    if (entity.closed) throw new Error('“' + entity.name + '”是闭合曲线，尚不支持写入新 PRJ。');
    const curve = { ...entity.curve, controlPoints: entity.curve.controlPoints.map(scalePoint), knots: [...entity.curve.knots] };
    return [{ kind: 'spline', data: convertCurveToEt(curve), segmentIndex: null, name: entity.name }];
  }
  const points = entity.points.map(scalePoint).map(round), count = entity.closed ? points.length : points.length - 1, edges = [];
  if (entity.closed && points.length < 3) throw new Error('“' + entity.name + '”的闭合折线不足三点。');
  for (let i = 0; i < count; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (a.x === b.x && a.y === b.y) throw new Error('“' + entity.name + '”含零长度线段，不能写入 PRJ。');
    edges.push({ kind: 'line', points: [a, b], segmentIndex: entity.closed ? i : null, name: entity.name });
  }
  return edges;
}
const edgeStart = edge => edge.kind === 'line' ? edge.points[0] : edge.data.fit[0];
const edgeEnd = edge => edge.kind === 'line' ? edge.points[1] : edge.data.fit.at(-1);
/**
 * ET joins seam edges along the end chords of the polyline it displays a curve
 * with: it walks the curve and starts a new chord once the chord misses the
 * curve by 0.03 mm or reaches 15 mm (measured on ET 2017's own display tables).
 * Using the same end chords puts the written corners where ET regenerates them.
 */
const DISPLAY_SAGITTA = .003, DISPLAY_CHORD = 1.5;
function etDisplayPolyline(data) {
  const dense = sampleEtSpline(data, 32), out = [dense[0]]; let anchor = 0;
  for (let i = 1; i < dense.length; i++) {
    const a = dense[anchor], d = sub(dense[i], a), chord = length(d); let sagitta = 0;
    if (chord > 0) for (let k = anchor + 1; k < i; k++) sagitta = Math.max(sagitta, Math.abs(cross(sub(dense[k], a), d)) / chord);
    if (sagitta >= DISPLAY_SAGITTA || chord >= DISPLAY_CHORD) { out.push(dense[i]); anchor = i; }
  }
  if (anchor !== dense.length - 1) out.push(dense.at(-1));
  return out;
}
function edgeTangents(edge) {
  if (edge.kind === 'line') { const t = unit(sub(edge.points[1], edge.points[0]), '线段'); return [t, t]; }
  const shown = etDisplayPolyline(edge.data);
  return [unit(sub(shown[1], shown[0]), '曲线起点'), unit(sub(shown.at(-1), shown.at(-2)), '曲线终点')];
}
function edgePolyline(edge) { return edge.kind === 'line' ? edge.points : sampleEtSpline(edge.data, 8); }

/**
 * Translate a project into the explicit PRJ model. Throws one Error listing
 * every blocking reason; returns { model, report } otherwise.
 */
// ET numbers the objects it creates from the current time. Identities written
// here start well in the past, so a file opened right after export cannot clash.
const IDENTITY_LEAD_SECONDS = 400000, MAX_IDENTITIES = 300000;
export function planNewPrj(project, { now = new Date(), identityStart = Math.floor(now.getTime() / 1000) - IDENTITY_LEAD_SECONDS } = {}) {
  const problems = [], notes = [];
  if (!project || project.format !== 'zhiyi-cad' || !Array.isArray(project.entities)) throw new Error('当前工程无法识别。');
  if (project.units !== 'mm') problems.push('工程单位不是毫米。从 ET 导入且未确认比例的工程请使用原有的 PRJ 回存。');
  if (project.entities.some(e => e.source?.format === 'ET PRJ')) problems.push('工程含从 ET PRJ 导入的图元，请使用原有的 PRJ 回存，或保存工程。');
  if (project.notches?.length || project.entities.some(e => e.notchFrom)) problems.push('工程含刀口，新建 PRJ 尚不支持写入刀口。');
  if (!Number.isSafeInteger(identityStart) || identityStart < 1 || identityStart > 0xfff00000) problems.push('对象编号起点无效。');
  if (problems.length) throw new Error(problems.join('\n'));

  const byId = new Map(project.entities.map(e => [e.id, e])), used = new Set(), recipes = project.seamAllowances || [];
  const derived = new Set(project.entities.filter(e => e.derivedFrom).map(e => e.id));
  let nextId = identityStart; const id = () => nextId++;
  const model = { header: { ...formatDate(now), id: id(), collection: '', style: String(project.name || '未命名纸样').slice(0, 60), note: '', sizeName: 'F' }, root: { id: id() }, nodes: [], curves: [], pieces: [], texts: [], corners: [] };
  const report = { format: NEW_PRJ_FORMAT, fileUnit: 'cm', scale: '1 cm = 10 mm', pieces: [], looseCurves: 0, looseTexts: 0, maxCurveDeviationMm: 0, seamRecipes: 0, omitted: [], notes };
  try { encodeGbk(model.header.style); } catch (error) { problems.push('工程名称：' + error.message); }

  const pendingCurves = [];
  function addCurve(edge, style) {
    const curve = edge.kind === 'line' ? { kind: 2, points: edge.points.map(round) } : { kind: 4, points: edge.data.fit, controls: edge.data.controls };
    if (edge.kind === 'spline') report.maxCurveDeviationMm = Math.max(report.maxCurveDeviationMm, (edge.data.deviation || 0) * MM_PER_UNIT);
    pendingCurves.push({ ...curve, ...style, links: [] });
    return pendingCurves.length;
  }
  function addText(entity) {
    if (entity.mirrorY) throw new Error('文字“' + entity.text + '”为镜像文字，不能写入 PRJ。');
    if (!entity.text) { report.omitted.push('空文字 1 项'); return null; }
    encodeGbk(entity.text);
    const angle = (entity.rotation || 0) * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle), height = entity.height / MM_PER_UNIT;
    const width = (entity.width || textWidth(entity.text, entity.height)) / MM_PER_UNIT, anchor = scalePoint(entity.points[0]);
    // ET anchors text at the left middle. A baseline anchor is lifted by 0.4 of the height.
    const lift = entity.verticalAlign === 'middle' ? 0 : height * .4, x = anchor.x - sin * lift, y = anchor.y + cos * lift;
    if (!(height > 0 && height <= 1000 && width > 0)) throw new Error('文字“' + entity.text + '”的尺寸无效。');
    model.texts.push(clone({ id: 0, x: Math.fround(x), y: Math.fround(y), cos: Math.fround(cos), sin: Math.fround(sin), width: Math.fround(width), height: Math.fround(height), text: entity.text,
      x2: Math.fround(x + cos * width * .75), y2: Math.fround(y + sin * width * .75) }));
    return model.texts.length;
  }

  const pieceSpecs = [];
  for (const group of project.groups || []) {
    const contours = contoursForGroup(group).filter(c => c.entityIds.length), primary = contours.find(c => c.role === 'primary-contour');
    if (!primary) { notes.push('组合“' + group.name + '”没有轮廓定义，其成员按独立线条和文字写入。'); continue; }
    try {
      if (contours.length > 1) throw new Error('含额外轮廓，尚不支持。');
      const bases = primary.entityIds.map(entityId => byId.get(entityId));
      if (bases.some(e => !e || e.type === 'text' || e.derivedFrom || e.notchFrom)) throw new Error('轮廓线缺失或不是普通线条。');
      if (new Set(primary.entityIds).size !== primary.entityIds.length || primary.entityIds.some(entityId => used.has(entityId))) throw new Error('轮廓线被重复引用。');
      if (bases.length > 1 && bases.some(e => e.closed)) throw new Error('闭合折线只能单独作为轮廓。');
      if (bases.length === 1 && !bases[0].closed) throw new Error('单条轮廓线必须闭合。');
      // Seam widths per editor edge, in millimetres.
      const matching = recipes.filter(r => r.baseEntityIds.length === primary.entityIds.length && r.baseEntityIds.every(entityId => primary.entityIds.includes(entityId)));
      if (matching.length > 1) throw new Error('同一轮廓有多个缝份定义。');
      const recipe = matching[0] || null; let widths = null;
      if (recipe) {
        if (!(recipe.distance > 0)) throw new Error('缝份向内偏移，尚不支持。');
        widths = edgeWidthMap(project, recipe.baseEntityIds, recipe); report.seamRecipes++;
        if (recipe.join !== 'miter') notes.push('“' + group.name + '”的缝份转角在 ET 中按默认尖角延长生成，网页的圆角或方角设置不写入。');
      }
      // Ordered traversal; every edge knows whether its stored direction is against the traversal.
      let traversal = [];
      const oriented = bases.length === 1 ? [{ entity: bases[0], reversed: false }] : orientChain(bases);
      for (const item of oriented) {
        const edges = entityEdges(item.entity).map(edge => ({ ...edge, entity: item.entity, reversed: item.reversed,
          width: (widths ? widths.get(edgeKey(item.entity.id, edge.segmentIndex)) : 0) / MM_PER_UNIT }));
        if (edges.some(edge => !(edge.width >= 0) || edge.width > 100)) throw new Error('缝份宽度须在 0 至 1000 mm 之间。');
        traversal.push(...(item.reversed ? edges.reverse() : edges));
      }
      const outline = traversal.flatMap(edge => { const pts = edgePolyline(edge); return edge.reversed ? [...pts].reverse() : pts; });
      let area = 0; for (let i = 0; i < outline.length; i++) { const a = outline[i], b = outline[(i + 1) % outline.length]; area += a.x * b.y - a.y * b.x; }
      if (Math.abs(area) < 1e-6) throw new Error('轮廓面积为零。');
      if (area < 0) traversal = traversal.reverse().map(edge => ({ ...edge, reversed: !edge.reversed })); // ET lists the net contour counter-clockwise.
      const count = traversal.length, ends = traversal.map(edge => edge.reversed ? [edgeEnd(edge), edgeStart(edge)] : [edgeStart(edge), edgeEnd(edge)]);
      let maxGap = 0; for (let i = 0; i < count; i++) maxGap = Math.max(maxGap, length(sub(ends[i][1], ends[(i + 1) % count][0])));
      if (maxGap > GAP_TOLERANCE) throw new Error('轮廓端点间隙 ' + (maxGap * MM_PER_UNIT).toFixed(3) + ' mm，超过 ' + GAP_TOLERANCE * MM_PER_UNIT + ' mm。');
      const tangents = traversal.map(edge => { const [a, b] = edgeTangents(edge); return edge.reversed ? [negate(b), negate(a)] : [a, b]; });
      // Seam corner after edge i: ET's default joins the two offset lines at their intersection, however sharp the corner.
      const corner = traversal.map((edge, i) => {
        const next = traversal[(i + 1) % count], t1 = tangents[i][1], t2 = tangents[(i + 1) % count][0], P = ends[i][1], Q = ends[(i + 1) % count][0];
        const a = add(P, right(t1), edge.width), b = add(Q, right(t2), next.width), turn = cross(t1, t2);
        if (dot(t1, t2) < 0 && Math.abs(turn) < SMOOTH_SINE) throw new Error('“' + edge.name + '”与“' + next.name + '”之间折回，不能生成缝份。');
        // ET inserts a separate step where tangent edges change width; that form is not written yet.
        if (Math.abs(turn) < SMOOTH_SINE && Math.abs(edge.width - next.width) > 1e-6) throw new Error('“' + edge.name + '”与“' + next.name + '”接近相切但缝份宽度不同，尚不支持。');
        if (Math.abs(turn) < 1e-6) return add(a, sub(b, a), .5);
        const X = add(a, t1, cross(sub(b, a), t2) / turn);
        if (length(sub(X, P)) > 200) throw new Error('“' + edge.name + '”处的缝份转角过尖，延长超过 2 m。');
        return X;
      });
      for (const item of bases) used.add(item.id);
      // Other members.
      const members = group.entityIds.map(entityId => byId.get(entityId)).filter(e => e && !primary.entityIds.includes(e.id));
      const grains = members.filter(e => e.layer === 'grain' && e.type !== 'text' && !e.curve && e.points.length === 2 && !e.closed);
      if (grains.length > 1) throw new Error('含多条布纹线，每个裁片只能写入一条。');
      const internals = [], texts = [];
      for (const member of members) {
        if (derived.has(member.id)) { used.add(member.id); continue; }
        if (member === grains[0]) { used.add(member.id); continue; }
        if (member.type === 'text') texts.push(member); else internals.push(member);
        used.add(member.id);
      }
      pieceSpecs.push({ group, traversal, corner, tangents, ends, internals, texts, grain: grains[0] || null, outline, recipe });
    } catch (error) { problems.push('裁片“' + group.name + '”：' + error.message); }
  }
  for (const recipe of recipes) if (!pieceSpecs.some(spec => spec.recipe === recipe)) problems.push('缝份“' + recipe.name + '”的基准不是裁片主轮廓，不能写入新 PRJ。');
  if (problems.length) throw new Error(problems.join('\n'));

  try {
    for (const spec of pieceSpecs) {
      const { traversal, corner, tangents, ends } = spec, count = traversal.length, chain = [], seams = [], internal = [], texts = [];
      const hasSeam = Boolean(spec.recipe);
      for (const edge of traversal) chain.push(addCurve(edge, { base: WHITE, color: WHITE, flags: [1 | (edge.reversed ? 2 : 0), 0, 0], style: 0, width: Math.fround(edge.width) }));
      for (const member of spec.internals) for (const edge of entityEdges(member)) internal.push(addCurve(edge, { base: INTERNAL, color: INTERNAL, flags: [0, 0, 1], style: 0, width: 1 }));
      traversal.forEach((edge, i) => {
        const startCorner = corner[(i + count - 1) % count], endCorner = corner[i], t0 = tangents[i][0], t1 = tangents[i][1];
        let points;
        if (edge.kind === 'line') points = [startCorner, endCorner];
        else {
          const indices = edge.data.fit.map((_, k) => k), order = edge.reversed ? indices.reverse() : indices;
          points = order.map(k => { const t = etTangent(edge.data, k); return add(edge.data.fit[k], right(edge.reversed ? negate(t) : t), edge.width); });
          // Trim offset points that fall outside the two corners, then anchor the ends on the corners.
          let inner = points.slice(1, -1).filter(p => dot(sub(p, startCorner), t0) > 1e-4 && dot(sub(p, endCorner), t1) < -1e-4);
          points = [startCorner, ...inner, endCorner];
        }
        const natural = (edge.reversed ? [...points].reverse() : points).map(round);
        let seamEdge;
        if (natural.length === 2 || edge.kind === 'line') seamEdge = { kind: 'line', points: [natural[0], natural.at(-1)] };
        else try { seamEdge = { kind: 'spline', data: fitEt(natural) }; } catch { throw new Error('裁片“' + spec.group.name + '”在“' + edge.name + '”处的缝份曲线无法稳定生成，请减小该边缝份。'); }
        if (seamEdge.kind === 'line' && seamEdge.points[0].x === seamEdge.points[1].x && seamEdge.points[0].y === seamEdge.points[1].y) throw new Error('裁片“' + spec.group.name + '”的缝份线在“' + edge.name + '”处退化为一点。');
        const index = addCurve(seamEdge, { base: SEAM, color: SEAM, flags: [edge.reversed ? 2 : 0, 0, 2], style: 0, width: 1 });
        seams.push(index); pendingCurves[chain[i] - 1].links = [index];
      });
      const cornerFirst = model.corners.length + 1;
      traversal.forEach((edge, i) => model.corners.push({ curve: chain[i], end: edge.reversed ? 0 : 1 }));
      for (const member of spec.texts) { const index = addText(member); if (index) texts.push(index); }
      // Grain line: the arrow end of the editor line becomes ET's first end.
      let center, end1, end2, mode = 1;
      if (spec.grain) {
        const [a, b] = spec.grain.points.map(scalePoint); center = add(a, sub(b, a), .5); end1 = b; end2 = a; mode = spec.grain.arrowStart ? 3 : 1;
        if (length(sub(a, b)) < .05) throw new Error('裁片“' + spec.group.name + '”的布纹线过短。');
      } else {
        const xs = spec.outline.map(p => p.x), ys = spec.outline.map(p => p.y), half = Math.max(.5, Math.min(10, (Math.max(...ys) - Math.min(...ys)) / 4));
        center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }; end1 = add(center, { x: 0, y: -1 }, half); end2 = add(center, { x: 0, y: 1 }, half);
        notes.push('裁片“' + spec.group.name + '”没有布纹线，已按竖直方向在裁片中心添加。');
      }
      encodeGbk(spec.group.name);
      model.pieces.push({ id: 0, id2: 0, name: spec.group.name, symmetric: spec.group.source?.kind === 'parametric-demo', mode, center: round(center), end1: round(end1), end2: round(end2),
        chain, ownedCurves: [...chain, ...internal, ...seams], corners: Array.from({ length: count }, (_, i) => cornerFirst + i), texts });
      report.pieces.push({ name: spec.group.name, contourEdges: count, internalLines: internal.length, texts: texts.length, hasSeam,
        seamWidthsMm: [...new Set(traversal.map(edge => +(edge.width * MM_PER_UNIT).toFixed(3)))].sort((a, b) => a - b), symmetric: spec.group.source?.kind === 'parametric-demo' });
    }
    for (const entity of project.entities) {
      if (used.has(entity.id)) continue;
      if (derived.has(entity.id)) continue;
      if (entity.type === 'text') { if (addText(entity)) report.looseTexts++; continue; }
      for (const edge of entityEdges(entity)) { addCurve(edge, { base: WHITE, color: WHITE, flags: [0, 0, 0], style: 0, width: 1 }); report.looseCurves++; }
    }
  } catch (error) { throw new Error(error.message); }
  if (!pendingCurves.length) throw new Error('工程没有可写入 PRJ 的线条。');
  if (pendingCurves.length > 20000 || model.texts.length > 5000 || 2 + pendingCurves.length * 3 + model.pieces.length * 2 + model.texts.length > MAX_IDENTITIES) throw new Error('图元数量超过新建 PRJ 的上限。');
  if (!model.texts.length || !model.pieces.length) notes.push('本工具重新打开自己的 PRJ 时需要至少一个裁片和一条文字；此文件只能在 ET 中打开。');
  // Identities in file order: nodes, curves, pieces, texts.
  pendingCurves.forEach((curve, index) => { for (const p of [curve.points[0], curve.points.at(-1)]) model.nodes.push({ id: id(), x: p.x, y: p.y, owner: index + 1 }); });
  model.curves = pendingCurves.map(curve => ({ id: id(), kind: curve.kind, base: curve.base, color: curve.color, flags: curve.flags, style: curve.style, points: curve.points,
    ...(curve.kind === 4 ? { controls: curve.controls } : {}), links: curve.links, width: Math.fround(curve.width) }));
  for (const piece of model.pieces) { piece.id = id(); piece.id2 = id(); }
  for (const text of model.texts) text.id = id();
  const unsupported = [];
  if (project.seamChecks?.length) unsupported.push('对缝检查');
  if (project.gradingPlans?.length || project.grading?.length) unsupported.push('放码方案');
  if (project.markerPlans?.length || project.markers?.length) unsupported.push('排料方案');
  if (project.plot || project.plotSettings) unsupported.push('出图设置');
  if (unsupported.length) report.omitted.push(unsupported.join('、') + '不属于 PRJ 纸样数据，请同时保存工程');
  Object.assign(report, { curves: model.curves.length, lines: model.curves.filter(c => c.kind === 2).length, splines: model.curves.filter(c => c.kind === 4).length,
    nodes: model.nodes.length, texts: model.texts.length, seamCurves: model.curves.filter(c => c.flags[2] === 2).length, corners: model.corners.length });
  return { model, report };
}

/** Plan, encode and prove that the bytes decode back to exactly the planned model. */
export function createNewPrjExport(project, options = {}) {
  const { model, report } = planNewPrj(project, options), bytes = encodeNewPrj(model);
  const decoded = readNewPrj(bytes);
  if (canonical(decoded) !== canonical(model)) throw new Error('生成的 PRJ 回读结果与计划不一致，已拒绝导出。');
  const again = encodeNewPrj(decoded);
  if (again.length !== bytes.length || again.some((value, index) => value !== bytes[index])) throw new Error('生成的 PRJ 重新编码不一致，已拒绝导出。');
  if (model.pieces.length && model.texts.length) {
    // The same file must reopen in this application through the ordinary PRJ import.
    const reopened = parsePrj(bytes, 'new.prj'), curves = reopened.entities.filter(e => [2, 4].includes(e.source?.recordKind));
    if (curves.length !== model.curves.length || reopened.groups.length !== model.pieces.length || reopened.entities.filter(e => e.type === 'text').length !== model.texts.length) throw new Error('生成的 PRJ 重新导入后的数量不一致，已拒绝导出。');
    report.reopenChecked = true;
  } else report.reopenChecked = false;
  const filename = String(project.name || '纸样').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80) + '-ET.prj';
  return { bytes, report: { ...report, byteLength: bytes.length }, filename, model };
}
