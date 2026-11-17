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
import { planEtMarks } from './prj-marks.mjs';
import { evaluateBSpline, validateCurve } from './curves.mjs';
import { orientChain, contoursForGroup } from './topology.mjs';
import { textWidth } from './geometry.mjs';
import { edgeWidthMap, edgeKey } from './seam-widths.mjs';
import { parsePrj } from './prj-parser.mjs';
import { cutCorner, stepCorner, foldCorner, mitreCorner, squareCorner, sewnReach, lineCorner, boundFoldLine, sewingMap, crossingSeam, specialCorner, stepJoint, singleSquareCorner, turnUpCorner, MITRE_GAP_MM, PAIR_KINDS } from './seam-corners.mjs';
import { jointShape, ventShape, along, JOINT_KINDS, VENT_KINDS } from './seam-joints.mjs';
import { SMOOTH_JOINT_COS } from './variable-offset.mjs';

import { MATERIAL_CODES, attributesOf } from './piece-attributes.mjs';
export { MATERIAL_CODES };
import { generateNotches } from './notches.mjs';

export const NEW_PRJ_FORMAT = 'ET PRJ 2.0 / 08';
export const NEW_PRJ_NATIVE_VERIFIED = true;
const DOCUMENT_CLASS = 0x0b8f70ad, WHITE = [255, 255, 255], SEAM = [255, 128, 0], INTERNAL = [128, 128, 128];
/** The display colour a line carries from an ET file, if any. ET treats white loose lines as outlines, coloured ones as auxiliary lines. */
/** ET's attribute word of a line carried from an ET file (auxiliary line and the like); 0 for an ordinary line. Without it ET takes a closed loop of loose lines for a piece outline when it regenerates seam allowances. */
const attributeOf = entity => Number.isInteger(entity.etAttribute) && entity.etAttribute > 0 && entity.etAttribute <= 0xffffffff ? entity.etAttribute : 0;
/** ET's marks of a line that is no contour edge: auxiliary line (0x10) and division mark (0x08). */
const marked = (flags, entity) => { const kept = Array.isArray(entity.etFlags) ? entity.etFlags : [0, 0]; return [flags[0] | (kept[0] & 0x18) | (entity.aux ? 0x10 : 0), flags[1], flags[2]]; };
const AUXILIARY = [0, 127, 255];
/** v66: ET draws the extended seam (生成扩展缝边) dashed in this colour. */
const EXTENSION = [127, 204, 204];
const colorOf = entity => Array.isArray(entity.color) && entity.color.length === 3 && entity.color.every(v => Number.isInteger(v) && v >= 0 && v <= 255) ? entity.color : null;
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
  // Negative zero is written as zero: the same drawing then gives the same bytes whether it comes from memory or from a saved project.
  f32(value) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, value + 0, true); return this.bytes(b); }
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
  // The sizes (see prj-sizes.mjs): the series in use, five series of fifty names (position 9 is the base size), the size table.
  const grading = h.grading;
  w.u32(grading ? grading.activeSeries : 0);
  for (let series = 0; series < 5; series++) for (let slot = 0; slot < 50; slot++) w.string(grading ? grading.names[series][slot] || '' : slot === 9 ? [size, '38'][series] || '' : '');
  w.u32(1).u32(grading ? grading.rows.length : 0);
  for (const row of grading ? grading.rows : []) { w.string(row.name); for (const value of row.values) w.f32(value); }
  w.zero(5).u32(9).u32(9).u32(DOCUMENT_CLASS).zero(36);
  // One size.
  w.u32(1).u32(1).u32(model.root.id).u32(0).bytes(WHITE).f32(1).u32(0).u8(1).string(size).u32(9);
  w.u32(model.nodes.length + model.notches.length + (model.points || []).length + (model.gradePoints || []).length);
  // A point with a grading rule: 0x40 in its first flag byte, kind 2 after its owner, then the two formulas and the two axes.
  const rule = r => { w.u32(0).u8(0).string(r.x).string(r.y).u32(0).u32(0).u32(0).u8(0).f32(r.axisX[0]).f32(r.axisX[1]).f32(0).f32(r.axisY[0]).f32(r.axisY[1]).f32(0).u32(0); };
  for (const node of model.nodes) { w.u32(6).u32(node.id).bytes([0, 0, 255, node.rule ? 0x40 : 0, 0, 0]).point(node).u32(node.owner).u32(node.rule ? 2 : 0); if (node.rule) rule(node.rule); }
  // A notch is a node of type 7: after the common part, how it is placed (0 by distance, 1 where the referenced line meets the edge),
  // the distance from one end of its curve, 1, the curve, which end, its role (0 on the net edge, 2 for the twin on the seam line),
  // the direction it points and the tangent of the curve there.
  for (const notch of model.notches) {   // a notch that moves by a rule of its own carries the rule before its notch data
    w.u32(7).u32(notch.id).bytes([0, 0, 255, notch.rule ? 0x40 : 0, 0, 0]).point(notch).u32(notch.reference).u32(notch.rule ? 2 : 0); if (notch.rule) rule(notch.rule);
    w.u8(notch.mode).f32(notch.distance).u32(1).u32(notch.owner).u8(notch.end).u32(notch.role).point(notch.direction).point(notch.tangent);
    if (notch.angle) w.f32(notch.angle); else w.u32(0);   // v67: ET's notches at the folds of 反转翻角 keep an angle (degrees) there
  }
  // After the notches: the drill holes (flag byte 5) and the two ends of every row's base line (flag byte 7). No line owns them.
  for (const p of model.points || []) w.u32(6).u32(p.id).bytes([0, 0, 255, 0, 0, p.flag]).point(p).u32(0).u32(0);
  // Last: grading points that are not an end of their line: a point a curve passes through, or a point on the line (third flag byte 6).
  for (const p of model.gradePoints || []) { w.u32(6).u32(p.id).bytes([0, 0, 255, p.rule ? 0x40 : 0, 0, p.onLine ? 6 : 0]).point(p).u32(p.owner).u32(p.rule ? 2 : 0); if (p.rule) rule(p.rule); }
  w.u32(model.curves.length);
  model.curves.forEach((curve, index) => {
    w.u32(curve.id).bytes(curve.base).bytes(curve.flags);
    if (curve.kind === 2) w.u32(2).u32(0).u32(0).bytes(curve.color).f32(1).u32(curve.style).u8(0).point(curve.points[0]).point(curve.points[1]);
    else {
      w.u32(4).u32(0).bytes(curve.base2 || curve.base).u8(0).u32(0).u32(0).bytes(curve.color).f32(1).u32(curve.style);   // v66: ET draws a curve in its second base colour
      w.u32(curve.points.length); for (const p of curve.points) w.point(p);
      w.u32(curve.controls.length); for (const p of curve.controls) w.point(p);
      w.u32(0); // ET rebuilds its display table when the file is opened.
    }
    w.list([index * 2 + 1, index * 2 + 2, ...(curve.gradePoints || [])]).list(curve.secondary || []).list(curve.links).f32(curve.width).u32(0).u32(curve.attribute || 0).u16(0);
  });
  w.u32(model.pieces.length);
  model.pieces.forEach((piece, index) => {
    w.u32(piece.id).bytes(WHITE).u8(0x20).zero(13).u32(1).u32(piece.id2).bytes(WHITE).u32(piece.id2);
    w.string(h.style).string(piece.name).string(size).string(piece.material).u32(piece.materialCode).string(piece.symmetric ? '对称' : '不对称');
    w.u32(piece.count).u32(piece.symmetric ? piece.count : 0).f32(piece.angle).u32(0).string(piece.label).u32(piece.mode);
    w.point(piece.center).point(piece.end1).u32(0).point(piece.center).point(piece.end2).u32(0).u16(0);
    w.u32(1).u8(0).u8(0).list(piece.chain).u32(index + 1);
    w.list(piece.ownedCurves).list([...piece.ownedCurves.flatMap(curve => [curve * 2 - 1, curve * 2]), ...(piece.points || [])]).list(piece.corners).list(piece.texts).list(piece.rows || []);
    w.bytes(IDENTITY_TRANSFORM);
  });
  w.u32(model.texts.length);
  for (const text of model.texts) {
    w.u32(text.id).u32(0).bytes(WHITE).f32(1).u32(0).u8(0).u32(1).u8(0).u32(1);
    w.f32(text.x).f32(text.y).f32(text.cos).f32(text.sin).f32(text.width).f32(text.height).u32(0).string(text.text).f32(text.x2).f32(text.y2).zero(6);
  }
  // Rows of buttons (kind 0) and buttonholes (kind 1), as ET's own tools write them: the number of marks, their radius, how far a
  // buttonhole reaches past its row, the base line as a curve through two points (ET rebuilds its display table), every mark
  // with its distance, share and curve parameter along the base line, and the numbers of the two point records at its ends.
  w.u32((model.rows || []).length);
  for (const row of model.rows || []) {
    const [a, b] = row.baseLine;
    w.u32(row.id).bytes(WHITE).bytes([0, row.kind, 0]).u8(1).u32(row.items.length).f32(row.radius).f32(row.offset).u32(0).u8(0);
    w.bytes(WHITE).u8(0).u32(0).u32(0).bytes(WHITE).f32(1).u32(1).u32(2).point(a).point(b).u32(4).point(a).point(a).point(b).point(b).u32(0);
    w.u32(row.items.length); for (const item of row.items) w.point(item).f32(item.along).f32(item.share).f32(item.parameter);
    w.u32(row.ends[0]).u32(row.ends[1]);
  }
  w.u32(0).u32(model.corners.length);
  // One record per contour corner. A cut (6) or stepped (8) corner replaces the plain record and carries two sizes;
  // a fold-back (1) is an extra record of the folded edge that names its treated ends (0 and 1, or -1 for an end left plain).
  // v65: the other treatments replace the plain record of their corner too; 可调反转 (15) names its ends like the fold-back and carries
  // its shift and a zero, 七字角 (7) and 反转直角 (10) two zero floats, the types from 16 on six zero floats and four -1, as ET writes them.
  for (const corner of model.corners) {
    w.u32(0).bytes(WHITE).u8(corner.type || 0).u32(corner.curve).u32(corner.end >>> 0).u32(corner.other || 0).u32((corner.otherEnd ?? -1) >>> 0);
    if (CORNER_SIZES.includes(corner.type)) w.f32(corner.sizes[0]).f32(corner.sizes[1]);
    else if (CORNER_TAILS.includes(corner.type)) { for (let i = 0; i < 6; i++) w.f32(corner.tail ? corner.tail[i] : 0); for (let i = 0; i < 4; i++) w.u32(0xffffffff); }   // v67: 开叉 keeps [0, 0, A, B, C, D] there
  }
  w.zero(160);
  const bytes = w.done();
  if (bytes.length > 16 * 1024 * 1024) throw new Error('生成的 PRJ 超过 16 MB。');
  return bytes;
}

// corner record types with two sizes after their fields, and those with a 40-byte tail (v65, from ET's own files)
const CORNER_SIZES = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15], CORNER_TAILS = [16, 17, 18, 19, 20], CORNER_TYPES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
/** Strict inverse of encodeNewPrj. Accepts only files this module can write. */
/** How many lines follow the points: found by walking the point records, whose length depends on what they carry. */
function declaredCurveCount(bytes, start, count) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let o = start;
  for (let i = 0; i < count; i++) {
    if (o + 34 > bytes.length) throw new Error('PRJ 结构不符：节点记录被截断');
    const type = view.getUint32(o, true), ruled = bytes[o + 11]; o += 34;
    if (ruled & 0x40) { o += 5; for (let k = 0; k < 2; k++) { if (o + 2 > bytes.length) throw new Error('PRJ 结构不符：放码规则被截断'); o += 2 + view.getUint16(o, true); } o += 13 + 24 + 4; }
    if (type === 7) o += 46;
  }
  if (o + 4 > bytes.length) throw new Error('PRJ 结构不符：节点记录被截断');
  return view.getUint32(o, true);
}
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
  // the sizes: the series in use, five series of fifty names, the size table
  const activeSeries = u32(); if (activeSeries > 4) fail('号型系列不符');
  const names = Array.from({ length: 5 }, () => Array.from({ length: 50 }, string));
  expect(1, u32(), '尺寸表'); const tableRowCount = u32(); if (tableRowCount > 500) fail('尺寸表行数异常');
  const tableRows = Array.from({ length: tableRowCount }, () => ({ name: string(), values: Array.from({ length: 50 }, f32) }));
  if (names[activeSeries][9] !== header.sizeName) fail('基码名称不符');
  // a file without grading names its one size, and "38" beside it, and nothing else
  const plain = activeSeries === 0 && !tableRowCount && names.every((list, series) => list.every((name, slot) => name === (slot === 9 ? [header.sizeName, '38'][series] || '' : '')));
  if (!plain) header.grading = { activeSeries, names, rows: tableRows };
  zeros(5, '尺寸表'); expect(9, u32(), '尺寸表'); expect(9, u32(), '尺寸表'); expect(DOCUMENT_CLASS, u32(), '文档类别'); zeros(36, '尺码前缀');
  expect(1, u32(), '尺码'); expect(1, u32(), '尺码');
  const root = { id: u32() }; expect(0, u32(), '尺码'); white('尺码'); expect(1, f32(), '尺码'); expect(0, u32(), '尺码'); expect(1, u8(), '尺码'); literal(header.sizeName, '尺码名'); expect(9, u32(), '尺码');
  const nodeCount = u32(); if (nodeCount > 200000) fail('节点数量异常');
  const declaredCurves = declaredCurveCount(bytes, o, nodeCount);
  const nodes = [], notches = [], points = [], gradePoints = [];
  for (let i = 0; i < nodeCount; i++) {
    const type = u32(); if (type !== 6 && type !== 7) fail('节点类型不受支持');
    const id = u32(); expect(0, u8(), '节点'); expect(0, u8(), '节点'); expect(255, u8(), '节点'); const ruled = u8(); expect(0, u8(), '节点标志'); const flag = u8();
    const p = point(), owner = u32(), kind = u32(); let rule = null;
    if (ruled !== 0 && ruled !== 0x40) fail('节点标志不符');
    if (ruled) {   // a grading rule: two formulas and the two axes they act along
      if (kind !== 2) fail('放码规则记录不符'); expect(0, u32(), '放码规则'); expect(0, u8(), '放码规则');
      rule = { x: string(), y: string() }; zeros(13, '放码规则'); rule.axisX = [f32(), f32()]; expect(0, f32(), '放码方向'); rule.axisY = [f32(), f32()]; expect(0, f32(), '放码方向'); expect(0, u32(), '放码规则');
    } else if (kind !== 0) fail('节点记录不符');
    if (type === 6 && owner === 0) {   // a drill hole (5) or an end of a row's base line (7): after the end points and the notches, owned by no line
      if ((flag !== 5 && flag !== 7) || rule || gradePoints.length) fail('点记录不符'); points.push({ id, x: p.x, y: p.y, flag }); continue;
    }
    if (type === 6 && (flag || notches.length || points.length || gradePoints.length || nodes.length >= declaredCurves * 2)) {   // a grading point inside its line: after everything else
      if (flag !== 0 && flag !== 6) fail('放码点记录不符'); gradePoints.push({ id, x: p.x, y: p.y, owner, onLine: flag === 6, ...(rule ? { rule } : {}) }); continue;
    }
    if (flag || points.length || gradePoints.length) fail('节点标志或顺序不符');
    if (type === 6) { nodes.push({ id, x: p.x, y: p.y, owner, ...(rule ? { rule } : {}) }); continue; }
    const notch = { id, x: p.x, y: p.y, reference: owner, ...(rule ? { rule } : {}), mode: u8(), distance: f32() }; expect(1, u32(), '刀口'); notch.owner = u32(); notch.end = u8(); notch.role = u32();
    notch.direction = point(); notch.tangent = point(); { const angle = f32(); if (angle) notch.angle = angle; }
    if (notch.mode > 1 || notch.end > 1 || ![0, 2].includes(notch.role)) fail('刀口记录不符');
    notches.push(notch);
  }
  const curveCount = u32(); if (curveCount * 2 !== nodes.length) fail('节点与线条数量不一致');
  const curves = [];
  for (let i = 0; i < curveCount; i++) {
    const curve = { id: u32(), base: rgb(), flags: [u8(), u8(), u8()], kind: u32() }; expect(0, u32(), '线条');
    if (curve.kind === 2) { expect(0, u32(), '直线'); curve.color = rgb(); expect(1, f32(), '直线'); curve.style = u32(); expect(0, u8(), '直线'); curve.points = [point(), point()]; }
    else if (curve.kind === 4) {
      // the second base colour is the one ET draws a curve in; v66: the extended seam has 7fcccc there, every other curve its first base colour
      const again = rgb(); if (again.some((v, k) => v !== curve.base[k])) { if (again.join() !== '127,204,204') fail('曲线底色不一致'); curve.base2 = again; } expect(0, u8(), '曲线'); expect(0, u32(), '曲线'); expect(0, u32(), '曲线');
      curve.color = rgb(); expect(1, f32(), '曲线'); curve.style = u32();
      const n = u32(); if (n < 2 || n > 1000) fail('曲线点数异常'); curve.points = Array.from({ length: n }, point);
      expect(n + 2, u32(), '曲线控制点数'); curve.controls = Array.from({ length: n + 2 }, point); expect(0, u32(), '曲线显示表');
    } else fail('线条类型不受支持');
    const direct = list(); if (direct.length < 2 || direct[0] !== i * 2 + 1 || direct[1] !== i * 2 + 2) fail('线条节点引用不符');
    const firstGradePoint = curveCount * 2 + notches.length + points.length, inside = direct.slice(2);
    if (inside.some(n => !(n > firstGradePoint && n <= nodeCount) || gradePoints[n - firstGradePoint - 1].owner !== i + 1)) fail('线条放码点引用不符'); if (inside.length) curve.gradePoints = inside;
    const secondary = list(); if (secondary.some(n => !(n > curveCount * 2 && n <= nodeCount) || notches[n - curveCount * 2 - 1].owner !== i + 1)) fail('线条附加节点引用不符'); if (secondary.length) curve.secondary = secondary;
    curve.links = list(); curve.width = f32(); expect(0, u32(), '线条'); curve.attribute = u32(); expect(0, u16(), '线条');
    curves.push(curve);
  }
  const pieceCount = u32(); if (pieceCount > 10000) fail('裁片数量异常');
  const pieces = [];
  for (let i = 0; i < pieceCount; i++) {
    const piece = { id: u32() }; white('裁片'); expect(0x20, u8(), '裁片'); zeros(13, '裁片'); expect(1, u32(), '裁片'); piece.id2 = u32(); white('裁片'); expect(piece.id2, u32(), '裁片');
    literal(header.style, '裁片款式'); piece.name = string(); literal(header.sizeName, '裁片号型'); piece.material = string(); piece.materialCode = u32(); if (!piece.material || piece.materialCode > 100000) fail('裁片布料不符');
    const symmetry = string(); if (!['对称', '不对称'].includes(symmetry)) fail('裁片对称属性不符'); piece.symmetric = symmetry === '对称';
    piece.count = u32(); if (piece.count < 1 || piece.count > 999) fail('裁片片数异常'); expect(piece.symmetric ? piece.count : 0, u32(), '裁片对称'); piece.angle = f32(); if (!Number.isFinite(piece.angle)) fail('裁片角度异常'); expect(0, u32(), '裁片'); piece.label = string(); if (!piece.label.startsWith('MD')) fail('裁片标签不符'); piece.mode = u32();
    piece.center = point(); piece.end1 = point(); expect(0, u32(), '布纹'); const again = point(); if (again.x !== piece.center.x || again.y !== piece.center.y) fail('布纹中心不一致'); piece.end2 = point(); expect(0, u32(), '布纹'); expect(0, u16(), '裁片');
    expect(1, u32(), '轮廓数量'); expect(0, u8(), '轮廓'); expect(0, u8(), '轮廓'); piece.chain = list(); expect(i + 1, u32(), '轮廓归属');
    piece.ownedCurves = list(); const ownedNodes = list();
    const lineEnds = nodes.length + notches.length; piece.points = ownedNodes.filter(n => n > lineEnds);
    if (canonical(ownedNodes.filter(n => n <= lineEnds)) !== canonical(piece.ownedCurves.flatMap(curve => [curve * 2 - 1, curve * 2])) || piece.points.some(n => n > lineEnds + points.length)) fail('裁片节点引用不符');
    piece.corners = list(); piece.texts = list(); piece.rows = list();
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
  const rowCount = u32(); if (rowCount > 10000) fail('扣位数量异常');
  const rows = [], samePoint = (a, b) => a.x === b.x && a.y === b.y;
  for (let i = 0; i < rowCount; i++) {
    const row = { id: u32() }; white('扣位'); expect(0, u8(), '扣位'); row.kind = u8(); if (row.kind > 1) fail('扣位种类不符'); expect(0, u8(), '扣位'); expect(1, u8(), '扣位');
    const count = u32(); row.radius = f32(); row.offset = f32(); if (!(row.radius > 0) || !(row.offset >= 0) || (row.kind === 0 && row.offset !== 0)) fail('扣位尺寸不符'); expect(0, u32(), '扣位'); expect(0, u8(), '扣位');
    white('扣位基线'); expect(0, u8(), '扣位基线'); expect(0, u32(), '扣位基线'); expect(0, u32(), '扣位基线'); white('扣位基线'); expect(1, f32(), '扣位基线'); expect(1, u32(), '扣位基线'); expect(2, u32(), '扣位基线');
    row.baseLine = [point(), point()]; expect(4, u32(), '扣位基线'); const controls = [point(), point(), point(), point()];
    if (!samePoint(controls[0], row.baseLine[0]) || !samePoint(controls[1], row.baseLine[0]) || !samePoint(controls[2], row.baseLine[1]) || !samePoint(controls[3], row.baseLine[1])) fail('扣位基线不符'); expect(0, u32(), '扣位基线');
    expect(count, u32(), '扣位个数'); if (count < 1 || count > 1000) fail('扣位个数异常');
    row.items = Array.from({ length: count }, () => ({ ...point(), along: f32(), share: f32(), parameter: f32() })); row.ends = [u32(), u32()];
    for (const end of row.ends) { const found = points[end - nodes.length - notches.length - 1]; if (!found || found.flag !== 7) fail('扣位基线端点不符'); }
    rows.push(row);
  }
  for (const piece of pieces) if (piece.rows.some(n => n < 1 || n > rows.length)) fail('裁片扣位引用不符');
  expect(0, u32(), '附加对象');
  const cornerCount = u32(); if (cornerCount > 100000) fail('转角数量异常');
  const corners = [];
  for (let i = 0; i < cornerCount; i++) {
    expect(0, u32(), '转角'); white('转角'); const type = u8(); if (!CORNER_TYPES.includes(type)) fail('转角类型 ' + type + ' 不受支持');
    const corner = { curve: u32(), end: u32() | 0, other: u32(), otherEnd: u32() | 0 };
    if (type) corner.type = type; else { if (corner.other !== 0 || corner.otherEnd !== -1) fail('转角记录不符'); delete corner.other; delete corner.otherEnd; }
    if (CORNER_SIZES.includes(type)) corner.sizes = [f32(), f32()];
    else if (CORNER_TAILS.includes(type)) { const tail = [f32(), f32(), f32(), f32(), f32(), f32()]; if (type > 17 && tail.some(x => x !== 0)) fail('转角尾不为零'); if (tail.some(x => x !== 0)) corner.tail = tail; for (let k = 0; k < 4; k++) expect(0xffffffff, u32(), '转角尾'); }   // v67: 开叉 keeps [0, 0, A, B, C, D]
    corners.push(corner);
  }
  if (bytes.length - o !== 160) fail('文件尾长度不符'); zeros(160, '文件尾');
  if (gradePoints.some((point, index) => !curves[point.owner - 1] || !(curves[point.owner - 1].gradePoints || []).includes(curves.length * 2 + notches.length + points.length + index + 1))) fail('放码点没有被它的线引用');
  return { header, root, nodes, notches, points, gradePoints, curves, pieces, texts, rows, corners };
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
    return [{ kind: 'spline', data: convertCurveToEt(curve), segmentIndex: null, name: entity.name, entityId: entity.id, from: 0, to: null }];
  }
  const points = entity.points.map(scalePoint).map(round), count = entity.closed ? points.length : points.length - 1, edges = [];
  if (entity.closed && points.length < 3) throw new Error('“' + entity.name + '”的闭合折线不足三点。');
  for (let i = 0; i < count; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (a.x === b.x && a.y === b.y) throw new Error('“' + entity.name + '”含零长度线段，不能写入 PRJ。');
    edges.push({ kind: 'line', points: [a, b], segmentIndex: entity.closed ? i : null, name: entity.name, entityId: entity.id, from: i, to: (i + 1) % points.length });
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
/** How far along a polyline the point nearest to q lies, and the length of the polyline. */
function alongPolyline(points, q) {
  let best = { off: Infinity, s: 0 }, walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], d = sub(points[i], a), size = length(d); if (!(size > 0)) continue;
    const t = Math.max(0, Math.min(1, dot(sub(q, a), d) / (size * size))), off = length(sub(sub(q, a), { x: d.x * t, y: d.y * t }));
    if (off < best.off) best = { off, s: walked + t * size };
    walked += size;
  }
  return { ...best, total: walked };
}
/** The seam line of a curved edge as points that start at one of its corners and run along the edge; null for a straight edge. */
function seamPathFrom(edge, fromTraversalStart) {
  if (edge.kind === 'line') return null;
  const points = edgePolyline(edge), ordered = edge.reversed ? [...points].reverse() : points, last = ordered.length - 1;
  const path = ordered.map((p, i) => add(p, right(unit(sub(ordered[Math.min(i + 1, last)], ordered[Math.max(i - 1, 0)]), '曲线')), edge.width));
  return fromTraversalStart ? path : path.reverse();
}

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

  if (!Number.isSafeInteger(identityStart) || identityStart < 1 || identityStart > 0xfff00000) problems.push('对象编号起点无效。');
  if (problems.length) throw new Error(problems.join('\n'));

  const byId = new Map(project.entities.map(e => [e.id, e])), used = new Set(), recipes = project.seamAllowances || [];
  const derived = new Set(project.entities.filter(e => e.derivedFrom || e.notchFrom).map(e => e.id));
  // ET's own marks (v55): rows of buttons, rows of buttonholes that lie across their row, and drill holes are written as the objects
  // ET's tools make, so ET knows them for what they are; the lines they are drawn with are then left out. Other marks stay lines.
  const etMarks = planEtMarks(project), markLines = new Set(etMarks.entityIds);
  let nextId = identityStart; const id = () => nextId++;
  const model = { header: { ...formatDate(now), id: id(), collection: '', style: String(project.name || '未命名纸样').slice(0, 60), note: '', sizeName: 'F' }, root: { id: id() }, nodes: [], notches: [], curves: [], pieces: [], texts: [], corners: [] };
  const pendingNotches = [], curveOf = new Map(), writtenNotches = new Set();   // curveOf: the first curve written for an editor entity
  const report = { format: NEW_PRJ_FORMAT, fileUnit: 'cm', scale: '1 cm = 10 mm', pieces: [], looseCurves: 0, looseTexts: 0, maxCurveDeviationMm: 0, seamRecipes: 0, omitted: [], notes };
  try { encodeGbk(model.header.style); } catch (error) { problems.push('工程名称：' + error.message); }

  const pendingCurves = [], recordsOf = new Map();   // recordsOf: the line records written for an editor entity, with the stations each begins and ends at
  function addCurve(edge, style) {
    const curve = edge.kind === 'line' ? { kind: 2, points: edge.points.map(round) } : { kind: 4, points: edge.data.fit, controls: edge.data.controls };
    if (edge.kind === 'spline') report.maxCurveDeviationMm = Math.max(report.maxCurveDeviationMm, (edge.data.deviation || 0) * MM_PER_UNIT);
    pendingCurves.push({ ...curve, ...style, links: [] });
    if (edge.entityId !== undefined) { if (!recordsOf.has(edge.entityId)) recordsOf.set(edge.entityId, []); recordsOf.get(edge.entityId).push({ number: pendingCurves.length, kind: curve.kind, from: edge.from, to: edge.to }); }
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
        // v67: where the width changes at a smooth joint ET draws a step (see stepJoint below); the tip is only a placeholder there
        if (dot(t1, t2) > SMOOTH_JOINT_COS && Math.abs(edge.width - next.width) > 1e-6) return add(a, sub(b, a), .5);
        if (Math.abs(turn) < 1e-6) return add(a, sub(b, a), .5);
        const X = add(a, t1, cross(sub(b, a), t2) / turn);
        if (length(sub(X, P)) > 200) throw new Error('“' + edge.name + '”处的缝份转角过尖，延长超过 2 m。');
        return X;
      });
      // Corner treatments of the seam recipe (cut, step, fold-back) replace the plain corner at single contour corners.
      const joints = corner.map(tip => ({ tip, end: tip, start: tip, pieces: [] })), cornerRecords = [], folds = new Map(), shifts = new Map(), pairs = [], skipPlain = new Set();
      // v67: ET's step where the seam width changes at a smooth joint (its corner record type 3, on the wider edge at the joint, in
      // place of the plain record): the wider seam line ends at its own offset of the joint point, a straight line runs on along the
      // wider edge's normal to the narrower seam line; ET hangs that line in the wider edge's links.
      traversal.forEach((edge, v) => {
        const next = traversal[(v + 1) % count], t1 = tangents[v][1], t2 = tangents[(v + 1) % count][0], P = ends[v][1];
        if (!(dot(t1, t2) > SMOOTH_JOINT_COS && Math.abs(edge.width - next.width) > 1e-6)) return;
        joints[v] = { ...stepJoint(P, { tangent: t1, width: edge.width }, { tangent: t2, width: next.width }), defaultStep: true };
        const wide = edge.width > next.width ? v : (v + 1) % count;
        cornerRecords[v] = { edge: wide, type: 3, end: ((wide === v) !== traversal[wide].reversed) ? 1 : 0, otherEnd: -1 };
      });
      // v67: the corners of ET's 专用角处理 that v65 left, as ET writes them (its own files, read record by record)
      const seamStyles = [], walkPoints = index => { const pts = edgePolyline(traversal[index]); return traversal[index].reversed ? [...pts].reverse() : [...pts]; };   // a copy: callers reverse it
      const frame = v => ({ v, P: ends[v][1], first: traversal[v], second: traversal[(v + 1) % count], arriving: { tangent: tangents[v][1], width: traversal[v].width }, leaving: { tangent: tangents[(v + 1) % count][0], width: traversal[(v + 1) % count].width } });
      const smoothAt = f => dot(f.arriving.tangent, f.leaving.tangent) > SMOOTH_JOINT_COS && Math.abs(f.first.width - f.second.width) > 1e-6;
      // a smooth joint seen from its wider edge: that edge running into the narrower side, and the narrower edge from the joint on
      const jointSides = f => f.first.width > f.second.width
        ? { wideArrives: true, wide: { tangent: f.arriving.tangent, normal: right(f.arriving.tangent), width: f.first.width }, narrow: { points: walkPoints((f.v + 1) % count), outwardSign: 1, width: f.second.width } }
        : { wideArrives: false, wide: { tangent: negate(f.leaving.tangent), normal: right(f.leaving.tangent), width: f.second.width }, narrow: { points: walkPoints(f.v).reverse(), outwardSign: -1, width: f.first.width } };
      // 单边直角 and 曲线断差1-3: at a smooth joint the wider seam line runs on and one curve, stored from the wider seam line to the narrower
      // one, hangs in the wider edge's links; the narrower seam line starts where it ends. 单边直角 at a corner: the square line hangs in
      // the picked edge's links, stored from its seam line outwards. The record sits on the picked edge with A (and B).
      const singleEnd = (item, k, f, role, where) => {
        const a = item.a / MM_PER_UNIT, b = (item.b || 0) / MM_PER_UNIT, v = f.v;
        try {
          if (smoothAt(f)) {
            const { wideArrives, wide, narrow } = jointSides(f), made = jointShape(item.kind, f.P, wide, narrow, { extend: a, run: b });
            const onward = along(narrow.points, made.reach).tangent, part = made.path.length > 2 ? { kind: 'spline', points: made.path } : { kind: 'line', points: [made.path[0], made.path.at(-1)] };
            joints[v] = wideArrives
              ? { tip: made.wideEnd, end: made.wideEnd, start: made.narrowStart, startTangent: onward, pieces: [{ owner: 'arriving', parts: [part] }] }
              : { tip: made.wideEnd, end: made.narrowStart, start: made.wideEnd, endTangent: negate(onward), pieces: [{ owner: 'leaving', parts: [part] }] };
          } else if (item.kind === 'singleSquare') {
            const shape = singleSquareCorner(f.P, f.arriving, f.leaving, { picked: role, size: a }), [p, q] = shape.pieces[0].points;
            joints[v] = { ...shape, pieces: [{ owner: role, parts: [{ kind: 'line', points: role === 'arriving' ? [p, q] : [q, p] }] }] };
          } else throw new Error('曲线断差要做在缝份宽度不同、接近相切（转折不到 15 度）的两条边之间。');
        } catch (error) { throw new Error(where + error.message); }
        cornerRecords[v] = { edge: k, type: { singleSquare: 9, curveStep1: 11, curveStep2: 12, curveStep3: 13 }[item.kind], end: item.end === 'end' ? 1 : 0, otherEnd: -1, sizes: [Math.fround(a), item.kind === 'singleSquare' ? 0 : Math.fround(b)] };
      };
      // 反转翻角 and 开叉 treat both ends of their edge; one record on that edge names both ends (0 and 1), neither corner keeps its plain one
      const bothEnds = (item, k) => {
        const vS = (k + count - 1) % count, vE = k, edge = traversal[k], where = '“' + edge.name + '”的' + (item.kind === 'turnUp' ? '反转翻角' : '开叉') + '：';
        const free = (v, joint) => !joints[v].treated && !(joints[v].pieces.length && !(joint && joints[v].defaultStep));
        try {
          if (item.kind === 'turnUp') {
            if (!free(vS, false) || !free(vE, false)) throw new Error('两端已有别的角处理。');
            if (Math.abs(item.a + item.b - edge.width * MM_PER_UNIT) > .01) throw new Error('A + B 要等于下摆的缝份宽度 ' + +(edge.width * MM_PER_UNIT).toFixed(3) + ' mm（ET 也这样要求）。');
            if (!(item.b > item.a)) throw new Error('B 要大于 A（ET 也这样要求）。');
            const storedDir = unit(edge.reversed ? sub(ends[k][0], ends[k][1]) : sub(ends[k][1], ends[k][0]), '下摆');
            for (const [v, hem] of [[vS, 'leaving'], [vE, 'arriving']]) {
              const f = frame(v), shape = turnUpCorner(f.P, f.arriving, f.leaving, { hem, depth: item.a / MM_PER_UNIT, rest: item.b / MM_PER_UNIT });
              const [S0, F1, F2] = hem === 'leaving' ? shape.pieces[0].points : [...shape.pieces[0].points].reverse();
              // two straight parts at each end, each a curve through three points, away from F1 at the hem's stored start and towards it at
              // its stored end; a notch (role 2) at F1 on the second part, pointing out along the hem, with an angle in its last field
              const atStoredEnd = (hem === 'arriving') !== edge.reversed, out = atStoredEnd ? storedDir : negate(storedDir), second = atStoredEnd ? [F2, F1] : [F1, F2];
              const t = unit(sub(second[1], second[0]), '反转翻角的边'), turn = (Math.atan2(t.y, t.x) - Math.atan2(out.y, out.x)) * 180 / Math.PI;
              const notch = { x: Math.fround(F1.x), y: Math.fround(F1.y), role: 2, end: 0, measured: Math.fround(atStoredEnd ? length(sub(F1, F2)) : 0), direction: { x: Math.fround(out.x), y: Math.fround(out.y) }, tangent: { x: Math.fround(t.x), y: Math.fround(t.y) }, angle: Math.fround(180 - ((turn % 360) + 360) % 360) };
              joints[v] = { tip: shape.tip, end: shape.end, start: shape.start, treated: true, pieces: [{ owner: hem, parts: [{ kind: 'spline3', points: atStoredEnd ? [S0, F1] : [F1, S0] }, { kind: 'spline3', points: second, notch }] }] };
            }
            cornerRecords[vE] = { edge: k, type: 14, end: 0, otherEnd: 1, sizes: [Math.fround(item.a / MM_PER_UNIT), Math.fround(item.b / MM_PER_UNIT)] }; skipPlain.add(vS);
            return;
          }
          // 开叉: one end of the vent edge is a smooth joint where it is the wider edge, the other its hem corner
          const fS = frame(vS), fE = frame(vE), topAtEnd = smoothAt(fE) && fE.first.width > fE.second.width;
          if (!topAtEnd && !(smoothAt(fS) && fS.second.width > fS.first.width)) throw new Error('开叉要做在比相接的边缝份宽、与它接近相切的边上（例如开衩的边）。');
          const f = topAtEnd ? fE : fS, h = topAtEnd ? fS : fE;
          if (!free(f.v, true) || !free(h.v, false)) throw new Error('两端已有别的角处理。');
          const { narrow } = jointSides(f), ventWalk = walkPoints(k), a = item.a / MM_PER_UNIT, b = item.b / MM_PER_UNIT;
          const vent = topAtEnd ? { tangent: f.arriving.tangent, normal: right(f.arriving.tangent), width: edge.width, points: [...ventWalk].reverse() }
            : { tangent: negate(f.leaving.tangent), normal: right(f.leaving.tangent), width: edge.width, points: ventWalk };
          const hemEdge = topAtEnd ? h.first : h.second, hemTangent = topAtEnd ? h.arriving.tangent : h.leaving.tangent;
          const made = ventShape(item.kind, f.P, vent, narrow, { seamPoint: add(h.P, right(hemTangent), hemEdge.width), tangent: hemTangent }, { a, b, c: (item.c || 0) / MM_PER_UNIT, d: (item.d || 0) / MM_PER_UNIT });
          // ET writes the parts that run down to the hem in the vent edge's own direction; the vent's own seam line becomes the dashed fold
          const fromTop = topAtEnd ? edge.reversed : !edge.reversed, onward = along(narrow.points, a + b).tangent;
          const parts = made.etParts.map(part => ({ ...part, points: part.down && !fromTop ? [...part.points].reverse() : part.points }));
          const F = made.foldLine[0], foldBottom = made.foldLine.at(-1), N = made.narrowStart;
          joints[f.v] = topAtEnd ? { tip: F, end: F, start: N, startTangent: onward, pieces: [{ owner: 'arriving', parts }] } : { tip: F, end: N, start: F, endTangent: negate(onward), pieces: [{ owner: 'leaving', parts }] };
          joints[h.v] = topAtEnd ? { tip: made.hemStart, end: made.hemStart, start: foldBottom, pieces: [], treated: true } : { tip: made.hemStart, end: foldBottom, start: made.hemStart, pieces: [], treated: true };
          seamStyles[k] = 1;
          cornerRecords[f.v] = { edge: k, type: item.kind === 'ventHalf' ? 16 : 17, end: 0, otherEnd: 1, tail: [0, 0, item.a, item.b, item.c || 0, item.d || 0].map(x => Math.fround(x / MM_PER_UNIT)) }; skipPlain.add(h.v);
        } catch (error) { throw new Error(where + error.message); }
      };
      for (const item of recipe?.corners || []) {
        const k = traversal.findIndex(edge => edge.entity.id === item.entityId && (edge.segmentIndex ?? null) === (item.segmentIndex ?? null));
        const both = item.kind === 'turnUp' || VENT_KINDS.includes(item.kind);
        if (k < 0 || !(both ? item.end === 'both' : ['start', 'end'].includes(item.end))) throw new Error('缝份的角处理引用了不在轮廓上的边。');
        if (both) { bothEnds(item, k); continue; }
        // the corner is where edge k ends (it arrives there) or where it starts (it leaves from there)
        const arrives = (item.end === 'end') !== traversal[k].reversed, v = arrives ? k : (k + count - 1) % count, role = arrives ? 'arriving' : 'leaving';
        const first = traversal[v], second = traversal[(v + 1) % count], P = ends[v][1], where = '“' + first.name + '”与“' + second.name + '”之间的转角：';
        const arriving = { tangent: tangents[v][1], width: first.width }, leaving = { tangent: tangents[(v + 1) % count][0], width: second.width };
        const v67 = item.kind === 'singleSquare' || JOINT_KINDS.includes(item.kind);
        if ((joints[v].pieces.length && !(v67 && joints[v].defaultStep)) || joints[v].treated) throw new Error(where + '有两种角处理。');
        // the two ends of an edge as stored, at this corner: the arriving edge ends here in the walking direction, the leaving one starts
        const storedEnd = (index, atEnd) => (atEnd !== traversal[index].reversed) ? 1 : 0;
        if (PAIR_KINDS.includes(item.kind)) { pairs.push({ item, k, v, role, arrives, where }); joints[v].treated = true; continue; }
        if (v67) { singleEnd(item, k, frame(v), role, where); continue; }
        try {
          if (item.kind === 'cut') joints[v] = cutCorner(P, arriving, leaving, { arrivingCut: (arrives ? item.first : item.second) / MM_PER_UNIT, leavingCut: (arrives ? item.second : item.first) / MM_PER_UNIT, owner: role });
          else if (item.kind === 'step') joints[v] = stepCorner(P, arriving, leaving, { side: role, drop: item.drop / MM_PER_UNIT, run: item.run / MM_PER_UNIT });
          else if (item.kind === 'fold') joints[v] = foldCorner(P, arriving, leaving, { fold: role, sidePath: arrives ? seamPathFrom(second, true) : seamPathFrom(first, false) });
          else if (item.kind === 'mitre') joints[v] = mitreCorner(P, arriving, leaving, { gap: MITRE_GAP_MM / MM_PER_UNIT });
          else if (['sevenStep', 'foldSquare', 'foldShift', 'doubleExtend', 'doubleProject'].includes(item.kind)) joints[v] = specialCorner(P, arriving, leaving, { kind: item.kind, hem: role, shift: (item.shift || 0) / MM_PER_UNIT });
          else throw new Error('不认识的角处理“' + item.kind + '”。');
        } catch (error) { throw new Error(where + error.message); }
        if (item.kind === 'fold') { const entry = folds.get(k) || { edge: k, start: false, end: false }; entry[item.end] = true; folds.set(k, entry); continue; }
        if (item.kind === 'foldShift') { const entry = shifts.get(k) || { edge: k, start: false, end: false, shift: item.shift }; entry[item.end] = true; shifts.set(k, entry); skipPlain.add(v); continue; }
        if (item.kind === 'mitre') { cornerRecords[v] = { edge: v, type: 4, end: storedEnd(v, true), other: (v + 1) % count, otherEnd: storedEnd((v + 1) % count, false) }; continue; }
        if (item.kind !== 'cut' && item.kind !== 'step') { const type = { sevenStep: 7, foldSquare: 10, doubleExtend: 18, doubleProject: 19 }[item.kind]; cornerRecords[v] = { edge: k, type, end: item.end === 'end' ? 1 : 0, otherEnd: -1, ...(type < 16 ? { sizes: [0, 0] } : {}) }; continue; }
        const otherIndex = arrives ? (k + 1) % count : v, other = traversal[otherIndex], otherEnd = (!arrives) !== other.reversed ? 1 : 0;
        cornerRecords[v] = { edge: k, type: item.kind === 'cut' ? 6 : 8, end: item.end === 'end' ? 1 : 0, ...(item.kind === 'cut' ? { other: otherIndex, otherEnd } : { otherEnd: -1 }),
          sizes: (item.kind === 'cut' ? [item.first, item.second] : [item.drop, item.run]).map(value => Math.fround(value / MM_PER_UNIT)) };
      }
      for (const item of bases) used.add(item.id);
      // Other members.
      const members = group.entityIds.map(entityId => byId.get(entityId)).filter(e => e && !primary.entityIds.includes(e.id));
      const grains = members.filter(e => e.layer === 'grain' && e.type !== 'text' && !e.curve && e.points.length === 2 && !e.closed);
      if (grains.length > 1) throw new Error('含多条布纹线，每个裁片只能写入一条。');
      const internals = [], texts = [];
      for (const member of members) {
        if (derived.has(member.id)) { used.add(member.id); continue; }
        if (member === grains[0]) { used.add(member.id); continue; }
        if (member.type === 'text') texts.push(member); else if (!markLines.has(member.id)) internals.push(member);
        used.add(member.id);
      }
      pieceSpecs.push({ group, traversal, corner, joints, cornerRecords, folds, shifts, pairs, skipPlain, seamStyles, tangents, ends, internals, texts, grain: grains[0] || null, outline, recipe });
    } catch (error) { problems.push('裁片“' + group.name + '”：' + error.message); }
  }
  for (const recipe of recipes) if (!pieceSpecs.some(spec => spec.recipe === recipe)) problems.push('缝份“' + recipe.name + '”的基准不是裁片主轮廓，不能写入新 PRJ。');
  // v65: treatments of two pieces sewn together, once every piece is known: the corner of the partner, in file units
  const frameOf = (spec, entityId, segmentIndex, end) => {
    const count = spec.traversal.length, k = spec.traversal.findIndex(edge => edge.entity.id === entityId && (edge.segmentIndex ?? null) === (segmentIndex ?? null));
    if (k < 0) return null;
    const arrives = (end === 'end') !== spec.traversal[k].reversed, v = arrives ? k : (k + count - 1) % count;
    return { k, v, arrives, P: spec.ends[v][1], arriving: { tangent: spec.tangents[v][1], width: spec.traversal[v].width }, leaving: { tangent: spec.tangents[(v + 1) % count][0], width: spec.traversal[(v + 1) % count].width } };
  };
  for (const spec of pieceSpecs) for (const pair of spec.pairs) {
    const { item, k, v, role, where } = pair, own = frameOf(spec, item.entityId, item.segmentIndex, item.end);
    const other = pieceSpecs.find(s => s !== spec && frameOf(s, item.partner.entityId, item.partner.segmentIndex, item.partner.end)), far = other && frameOf(other, item.partner.entityId, item.partner.segmentIndex, item.partner.end);
    if (!far) { problems.push('裁片“' + spec.group.name + '”：' + where + '缝合的另一片不在写出的裁片里。'); continue; }
    const farRole = far.arrives ? 'arriving' : 'leaving';
    try {
      if (item.kind === 'square') spec.joints[v] = squareCorner(own.P, own.arriving, own.leaving, { sewn: role, reach: Math.max(sewnReach(own.P, own.arriving, own.leaving, { sewn: role }), sewnReach(far.P, far.arriving, far.leaving, { sewn: farRole })) });
      else {
        let line;
        if (item.kind === 'boundFold' && item.role !== 'second') line = boundFoldLine(own.P, own.arriving, own.leaving, { sewn: role });
        else {
          const source = item.kind === 'boundFold' ? boundFoldLine(far.P, far.arriving, far.leaving, { sewn: farRole }) : crossingSeam(far.P, far.arriving, far.leaving, { sewn: farRole }).line;
          const map = sewingMap(crossingSeam(far.P, far.arriving, far.leaving, { sewn: farRole }).corner, crossingSeam(own.P, own.arriving, own.leaving, { sewn: role }).corner);
          line = { point: map.point(source.point), direction: map.direction(source.direction) };
        }
        spec.joints[v] = lineCorner(own.P, own.arriving, own.leaving, { line, owner: role });
      }
    } catch (error) { problems.push('裁片“' + spec.group.name + '”：' + where + error.message); continue; }
    // the record sits with the piece picked first and names the partner's edge; the partner leaves out its plain record (not for 延长反转角)
    if (item.role === 'second') spec.skipPlain.add(v);
    else spec.cornerRecords[v] = { edge: k, type: { square: 2, extendFold: 5, boundFold: 20 }[item.kind], end: item.end === 'end' ? 1 : 0, partner: { spec: other, index: far.k }, otherEnd: item.partner.end === 'end' ? 1 : 0 };
  }
  if (problems.length) throw new Error(problems.join('\n'));
  const partnerRecords = [];

  try {
    for (const spec of pieceSpecs) {
      const { traversal, joints, tangents, ends } = spec, count = traversal.length, chain = [], seams = [], internal = [], texts = [], seamShapes = [];
      const hasSeam = Boolean(spec.recipe);
      for (const edge of traversal) chain.push(addCurve(edge, { base: WHITE, color: WHITE, flags: [1 | (edge.reversed ? 2 : 0), 0, 0], style: 0, width: Math.fround(edge.width) }));
      for (const member of spec.internals) for (const edge of entityEdges(member)) { internal.push(addCurve(edge, { base: member.netExtension ? WHITE : member.aux ? AUXILIARY : INTERNAL, color: colorOf(member) || (member.aux ? AUXILIARY : INTERNAL), flags: marked([0, 0, 1], member), style: member.lineStyle === 1 || member.aux ? 1 : 0, width: 1, attribute: attributeOf(member) })); if (!curveOf.has(member.id)) curveOf.set(member.id, internal.at(-1)); }
      traversal.forEach((edge, i) => {
        // v67: where a treatment moved the corner along a curved edge, its points are kept by the edge's direction there
        const startCorner = joints[(i + count - 1) % count].start, endCorner = joints[i].end, t0 = joints[(i + count - 1) % count].startTangent || tangents[i][0], t1 = joints[i].endTangent || tangents[i][1];
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
        // v67: a vent's own seam line, its fold, is a curve through three points even when straight, as ET writes it (ET calls the seam
        // of a vent abnormal on saving when that line is a plain line)
        if (spec.seamStyles[i] && (natural.length === 2 || edge.kind === 'line')) seamEdge = { kind: 'spline', data: fitEt([natural[0], round(add(natural[0], sub(natural.at(-1), natural[0]), .5)), natural.at(-1)]) };
        else if (natural.length === 2 || edge.kind === 'line') seamEdge = { kind: 'line', points: [natural[0], natural.at(-1)] };
        else try { seamEdge = { kind: 'spline', data: fitEt(natural) }; } catch { throw new Error('裁片“' + spec.group.name + '”在“' + edge.name + '”处的缝份曲线无法稳定生成，请减小该边缝份。'); }
        if (seamEdge.kind === 'line' && seamEdge.points[0].x === seamEdge.points[1].x && seamEdge.points[0].y === seamEdge.points[1].y) throw new Error('裁片“' + spec.group.name + '”的缝份线在“' + edge.name + '”处退化为一点。');
        // v67: a vent's own seam line is its fold: dashed, and marked 32 in the attribute word as a line inside the allowance (as ET)
        const index = addCurve(seamEdge, { base: SEAM, color: SEAM, flags: [edge.reversed ? 2 : 0, 0, 2], style: spec.seamStyles[i] || 0, width: 1, attribute: spec.seamStyles[i] ? 32 : 0 });
        seams.push(index); pendingCurves[chain[i] - 1].links = [index]; seamShapes[i] = { index, points: seamEdge.kind === 'line' ? seamEdge.points : sampleEtSpline(seamEdge.data, 16) };
      });
      // Extra seam lines of the treated corners, written in the direction the outline is walked. Each belongs to one of the two
      // net edges of its corner; ET marks the ones at the stored end of their edge with 4 in the first flag byte.
      if (hasSeam) joints.forEach((joint, v) => joint.pieces.forEach(piece => {
        const j = piece.owner === 'arriving' ? v : (v + 1) % count, owner = traversal[j], atStoredEnd = (piece.owner === 'arriving') !== owner.reversed;
        if (piece.parts) {   // v67: curves given as ET writes them: kind, points in ET's direction, dashed, a notch of their own
          for (const part of piece.parts) {
            const pts = part.points.map(round);
            if (length(sub(pts[0], pts.at(-1))) < 1e-4) continue;
            const through = part.kind === 'spline3' ? [pts[0], round(add(pts[0], sub(pts.at(-1), pts[0]), .5)), pts.at(-1)] : pts;
            const extra = part.kind === 'line' ? { kind: 'line', points: [pts[0], pts.at(-1)] } : { kind: 'spline', data: fitEt(through) };
            const index = addCurve(extra, { base: SEAM, color: SEAM, flags: [atStoredEnd ? 4 : 0, 0, 2], style: part.dashed ? 1 : 0, width: 1, attribute: part.inside ? 32 : 0 });
            seams.push(index); pendingCurves[chain[j] - 1].links.push(index);
            if (part.notch) pendingNotches.push({ ...part.notch, owner: index, mode: 0, recipeId: null });
          }
          return;
        }
        const points = piece.points.map(round);
        if (length(sub(points[0], points.at(-1))) < 1e-4) return;   // the treatment leaves nothing to draw here
        // v66: a piece that turns (七字角, 反转直角, 双投影角, even by a few degrees) is written as one curve per straight part, as ET writes
        // its own: one curve through all its points made ET draw those corners round until it rebuilt the seam, and ET's extended seam
        // followed the round shape. A curved piece (a fold-back flap beside a curved side, marked smooth) stays one curve.
        const parts = [[points[0]]];
        points.slice(1).forEach((q, k) => {
          parts.at(-1).push(q);
          const next = points[k + 2];
          if (next && !piece.smooth) { const u = sub(q, points[k]), w = sub(next, q), chord = length(add(u, w)); if (length(u) > 1e-6 && length(w) > 1e-6 && (u.x * w.x + u.y * w.y < 0 || !(chord > 0) || Math.abs(u.x * w.y - u.y * w.x) / chord > 1e-4)) parts.push([q]); }   // q off the chord by more than 0.001 mm
        });
        for (const part of parts) {
          const a = part[0], b = part.at(-1);
          if (length(sub(a, b)) < 1e-4) continue;
          // a straight part on a straight edge is a line; everything else is a curve through its points, as ET writes it
          const through = part.length > 2 ? part : [a, round(add(a, sub(b, a), .5)), b];
          const extra = owner.kind === 'line' && part.length === 2 ? { kind: 'line', points: [a, b] } : { kind: 'spline', data: fitEt(through) };
          const index = addCurve(extra, { base: SEAM, color: SEAM, flags: [atStoredEnd ? 4 : 0, 0, 2], style: 0, width: 1 });
          seams.push(index); pendingCurves[chain[j] - 1].links.push(index);
        }
      }));
      // v66: the extended seam, as ET's 生成扩展缝边 writes it: one closed curve with every point doubled (so it runs straight from point
      // to point), dashed (style 1) in 7fcccc, on the seam layer, hanging in the links of the first net edge after that edge's seam lines
      const extended = hasSeam && spec.recipe.extension ? byId.get((spec.recipe.outputIds || []).find(id => byId.get(id)?.seamRole === 'extension')) : null;
      if (extended) {
        const ring = extended.points.map(q => round(scalePoint(q))), twice = ring.slice(1).flatMap(q => [q, q]);
        const index = addCurve({ kind: 'spline', data: { fit: [ring[0], ...twice, ring[0]], controls: [ring[0], ring[0], ...twice, ring[0], ring[0]] } }, { base: SEAM, base2: EXTENSION, color: EXTENSION, flags: [0, 0, 2], style: 1, width: 1 });
        seams.push(index); pendingCurves[chain[0] - 1].links.push(index);
      }
      const cornerFirst = model.corners.length + 1;
      spec.chain = chain;
      traversal.forEach((edge, i) => { const special = spec.cornerRecords[i];
        if (special) { const record = { type: special.type, curve: chain[special.edge], end: special.end, other: special.other === undefined ? 0 : chain[special.other], otherEnd: special.otherEnd, sizes: special.sizes, tail: special.tail };
          model.corners.push(record); if (special.partner) partnerRecords.push({ record, partner: special.partner }); }
        else if (!spec.skipPlain.has(i)) model.corners.push({ curve: chain[i], end: edge.reversed ? 0 : 1 }); });
      for (const fold of spec.folds.values()) model.corners.push({ type: 1, curve: chain[fold.edge], end: fold.start ? 0 : -1, other: 0, otherEnd: fold.end ? 1 : -1 });
      for (const shift of spec.shifts.values()) model.corners.push({ type: 15, curve: chain[shift.edge], end: shift.start ? 0 : -1, other: 0, otherEnd: shift.end ? 1 : -1, sizes: [Math.fround(shift.shift / MM_PER_UNIT), 0] });
      traversal.forEach((edge, i) => { if (!curveOf.has(edge.entity.id)) curveOf.set(edge.entity.id, chain[i]); });
      // Notches on the contour edges: a node on the net edge and, where the edge has a seam line, its twin on that line.
      for (const recipe of project.notches || []) {
        const owned = traversal.map((edge, i) => ({ edge, i })).filter(item => item.edge.entity.id === recipe.baseEntityId); if (!owned.length) continue;
        let generated; try { generated = generateNotches(project, recipe.baseEntityId, { ...recipe, targetSeamId: null }); } catch (error) { throw new Error('刀口“' + recipe.name + '”：' + error.message); }
        writtenNotches.add(recipe.id);
        for (const station of generated.stations) {
          const N = round(scalePoint(station.point)), t = unit(station.tangent, '刀口处的线');
          const pointing = recipe.direction ? unit(recipe.direction, '刀口方向') : { x: -t.y * recipe.side, y: t.x * recipe.side };
          // the edge the notch sits on: the only one, or the nearest side of a closed outline
          const { edge, i } = owned.length === 1 ? owned[0] : owned.map(item => ({ ...item, off: segmentDistance(N, item.edge.points[0], item.edge.points[1]) })).sort((a, b) => a.off - b.off)[0];
          const shape = edgePolyline(edge), walked = alongPolyline(shape, N), fromEnd = recipe.mode === 'end' || (recipe.et?.mode === 1 && walked.s > walked.total / 2);
          const placed = recipe.et?.mode === 1 && recipe.et.referenceEntityId ? { mode: 1, referenceEntityId: recipe.et.referenceEntityId } : { mode: 0 };
          const common = { ...placed, recipeId: recipe.id, end: fromEnd ? 1 : 0, direction: { x: Math.fround(pointing.x), y: Math.fround(pointing.y) }, tangent: { x: Math.fround(t.x), y: Math.fround(t.y) } };
          pendingNotches.push({ ...common, x: N.x, y: N.y, owner: chain[i], role: 0, measured: Math.fround(fromEnd ? walked.total - walked.s : walked.s) });
          const seam = seamShapes[i]; if (!seam || !(edge.width > 0)) continue;
          // the twin: where the notch, drawn on from the net edge, crosses the seam line of this edge
          let S = null, best = Infinity;
          for (let k = 1; k < seam.points.length; k++) { const a = seam.points[k - 1], d = sub(seam.points[k], a), den = cross(pointing, d); if (Math.abs(den) < 1e-12) continue;
            const along = cross(sub(a, N), d) / den, u = cross(sub(a, N), pointing) / den; if (along > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 && along < best) { best = along; S = add(N, pointing, along); } }
          if (!S) S = add(N, pointing, edge.width / Math.max(.2, Math.abs(cross(t, pointing))));
          S = round(S); const onSeam = alongPolyline(seam.points, S);
          pendingNotches.push({ ...common, x: S.x, y: S.y, owner: seam.index, role: 2, measured: Math.fround(fromEnd ? onSeam.total - onSeam.s : onSeam.s) });
        }
      }
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
      const attributes = spec.group.attributes || {}, cut = attributesOf(spec.group), material = cut.material;
      if (cut.materialCode === null) throw new Error('裁片“' + spec.group.name + '”的布料“' + material + '”没有已知的 ET 布料编号。可以用的布料：' + Object.keys(MATERIAL_CODES).join('、') + '。');
      encodeGbk(material);
      model.pieces.push({ id: 0, id2: 0, name: spec.group.name, symmetric: spec.group.source?.kind === 'parametric-demo' || attributes.symmetric === true, material, materialCode: cut.materialCode,
        count: cut.count, angle: Math.fround(attributes.et?.angle || 0), label: attributes.et?.label || 'MD', mode, center: round(center), end1: round(end1), end2: round(end2),
        chain, ownedCurves: [...chain, ...internal, ...seams], corners: Array.from({ length: model.corners.length - cornerFirst + 1 }, (_, i) => cornerFirst + i), texts, points: [], rows: [] });
      report.pieces.push({ name: spec.group.name, material, count: model.pieces.at(-1).count, contourEdges: count, internalLines: internal.length, texts: texts.length, hasSeam,
        seamWidthsMm: [...new Set(traversal.map(edge => +(edge.width * MM_PER_UNIT).toFixed(3)))].sort((a, b) => a - b), symmetric: spec.group.source?.kind === 'parametric-demo' || spec.group.attributes?.symmetric === true });
    }
    // a pair record names the partner's sewn edge, whose curve number is known once that piece is written (v65)
    for (const { record, partner } of partnerRecords) record.other = partner.spec.chain[partner.index];
    for (const entity of project.entities) {
      if (used.has(entity.id)) continue;
      if (derived.has(entity.id) || markLines.has(entity.id)) continue;
      if (entity.type === 'text') { if (addText(entity)) report.looseTexts++; continue; }
      for (const edge of entityEdges(entity)) { const index = addCurve(edge, { base: entity.aux ? AUXILIARY : WHITE, color: colorOf(entity) || (entity.aux ? AUXILIARY : WHITE), flags: marked([0, 0, 0], entity), style: entity.lineStyle === 1 || entity.aux ? 1 : 0, width: 1, attribute: attributeOf(entity) }); if (!curveOf.has(entity.id)) curveOf.set(entity.id, index); report.looseCurves++; }
    }
    const left = (project.notches || []).filter(recipe => !writtenNotches.has(recipe.id));
    if (left.length) notes.push('有 ' + left.length + ' 个刀口不在裁片的轮廓线上，ET 文件里只能记轮廓线上的刀口，这些没有写入。');
  } catch (error) { throw new Error(error.message); }
  if (!pendingCurves.length) throw new Error('工程没有可写入 PRJ 的线条。');
  const pieceNumber = new Map(pieceSpecs.map((spec, index) => [spec.group.id, index]));
  if (pendingCurves.length > 20000 || model.texts.length > 5000 || 2 + pendingCurves.length * 3 + pendingNotches.length + model.pieces.length * 2 + model.texts.length > MAX_IDENTITIES) throw new Error('图元数量超过新建 PRJ 的上限。');
  if (!model.texts.length || !model.pieces.length) notes.push('本工具重新打开自己的 PRJ 时需要至少一个裁片和一条文字；此文件只能在 ET 中打开。');
  // Identities in file order: nodes, curves, pieces, texts.
  pendingCurves.forEach((curve, index) => { for (const p of [curve.points[0], curve.points.at(-1)]) model.nodes.push({ id: id(), x: p.x, y: p.y, owner: index + 1 }); });
  // notch nodes come after the end nodes; each curve lists its own
  pendingNotches.forEach((notch, index) => {
    // a notch placed by a line that is no longer written falls back to its distance from the end of its curve
    const referred = notch.mode === 1 ? curveOf.get(notch.referenceEntityId) : null, mode = referred ? 1 : 0;
    // placed by a line: ET records which end of that line touches the edge
    const line = referred ? pendingCurves[referred - 1].points : null, touching = line && length(sub(line[0], notch)) > length(sub(line.at(-1), notch)) ? 1 : 0;
    model.notches.push({ id: id(), recipeId: notch.recipeId, x: notch.x, y: notch.y, reference: referred || notch.owner, mode, distance: mode ? 0 : notch.measured, owner: notch.owner, end: mode ? touching : notch.end, role: notch.role, direction: notch.direction, tangent: notch.tangent, ...(notch.angle ? { angle: notch.angle } : {}) });
    (pendingCurves[notch.owner - 1].secondary ??= []).push(pendingCurves.length * 2 + index + 1);
  });
  // ET's own marks: point records after the notches, row objects after the texts
  model.points = []; model.rows = [];
  {
    const firstPoint = pendingCurves.length * 2 + pendingNotches.length, pieceOf = groupId => { const at = pieceNumber.get(groupId); return at === undefined ? null : model.pieces[at]; };
    const addPoint = (q, flag, piece) => { model.points.push({ id: id(), x: q.x, y: q.y, flag }); const number = firstPoint + model.points.length; if (piece) piece.points.push(number); return number; };
    for (const row of etMarks.rows) {
      const piece = pieceOf(row.groupId), places = row.places.map(q => round(scalePoint(q))), radius = Math.fround(row.radius / MM_PER_UNIT), offset = Math.fround(row.offset / MM_PER_UNIT), a = places[0];
      // one mark alone has no second place: its base line runs in the row's direction for the width of the mark
      const b = places.length > 1 ? places.at(-1) : round(add(a, row.direction, Math.max(2 * radius, .5))), total = length(sub(b, a));
      if (!(total > 1e-6)) throw new Error('一排' + (row.kind === 'button' ? '扣位' : '扣眼') + '的第一个和最后一个重合，不能写入 PRJ。');
      const items = places.map(q => { const along = length(sub(q, a)); return { x: q.x, y: q.y, along: Math.fround(along), share: Math.fround(along / total), parameter: Math.fround(along * 1.5) }; });
      const ends = [addPoint(a, 7, piece), addPoint(b, 7, piece)];
      model.rows.push({ id: 0, kind: row.kind === 'button' ? 0 : 1, radius, offset, baseLine: [a, b], items, ends }); if (piece) piece.rows.push(model.rows.length);
    }
    for (const hole of etMarks.drills) addPoint(round(scalePoint(hole)), 5, pieceOf(hole.groupId));
    report.marks = { buttonRows: etMarks.rows.filter(row => row.kind === 'button').length, buttonholeRows: etMarks.rows.filter(row => row.kind === 'buttonhole').length, marksInRows: etMarks.rows.reduce((sum, row) => sum + row.places.length, 0), drills: etMarks.drills.length };
  }
  // ---- grading (v56): a plan that grades by a size table is written the way ET keeps it: the size names and the size table in the
  // header, the rule of a point with its point record. A rule on the end of a line goes to that end; a rule inside a curve, or on a
  // line between two of its points, gets a point record of its own that the line lists after its two ends.
  model.gradePoints = []; report.grading = { written: false, sizes: [], baseSize: '', tableRows: 0, rules: 0, onLines: 0, dividingPoints: 0, notWritten: 0, reasons: [] };
  {
    const plan = (project.gradingPlans || []).find(item => item.method === 'table');
    if (plan) {
      const table = plan.sizeTable, names = Array.from({ length: 5 }, (_, series) => { const list = Array(50).fill(''); for (const item of table.series[series]) list[item.slot] = item.name; return list; });
      try { for (const text of [...names.flat(), ...table.rows.map(row => row.name), ...plan.anchors.flatMap(anchor => anchor.plain ? [] : [anchor.x, anchor.y])]) encodeGbk(text); } catch (error) { throw new Error('放码方案里有 ET 文件写不了的文字：' + error.message); }
      const base = names[table.activeSeries][table.baseSlot]; if (table.baseSlot !== 9 || !base) throw new Error('放码方案的基码不在号型表的基码位置上，不能写入 PRJ。');
      model.header.grading = { activeSeries: table.activeSeries, names, rows: table.rows.map(row => ({ name: row.name, values: row.values.map(Math.fround) })) }; model.header.sizeName = base;
      const firstExtra = pendingCurves.length * 2 + pendingNotches.length + model.points.length, g = report.grading;
      const fail = reason => { g.notWritten++; if (!g.reasons.includes(reason)) g.reasons.push(reason); };
      const ruleOf = anchor => anchor.plain ? null : { x: anchor.x, y: anchor.y, axisX: anchor.axisX.map(Math.fround), axisY: anchor.axisY.map(Math.fround) };
      const inside = (number, q, onLine, rule) => { model.gradePoints.push({ id: id(), x: q.x, y: q.y, owner: number, onLine, ...(rule ? { rule } : {}) }); (pendingCurves[number - 1].gradePoints ??= []).push(firstExtra + model.gradePoints.length); if (rule) { g.rules++; if (onLine) g.onLines++; } else g.dividingPoints++; };
      const atEnd = (number, start, rule) => { if (!rule) return; const node = model.nodes[number * 2 - (start ? 2 : 1)]; if (node.rule) return; node.rule = rule; g.rules++; };
      for (const anchor of plan.anchors) {
        const records = recordsOf.get(anchor.entityId), rule = ruleOf(anchor);
        if (!records) { if (rule) fail('有放码点所在的线没有写入文件（缝边线一类由 ET 重新生成的线，或者没有带入的标记线）'); continue; }
        if (anchor.between !== undefined) {
          const record = records.length === 1 ? records[0] : records.find(item => item.from === anchor.between);
          if (!record) { if (rule) fail('有线上的放码点对不上它的线'); continue; }
          inside(record.number, round(scalePoint(anchor.at)), true, rule); continue;
        }
        if (records.length === 1 && records[0].kind === 4) {
          const number = records[0].number, points = pendingCurves[number - 1].points, last = points.length - 1;
          if (anchor.index > last) { if (rule) fail('有放码点的序号超出曲线的点数'); continue; }
          if (anchor.index === 0 || anchor.index === last) atEnd(number, anchor.index === 0, rule); else inside(number, points[anchor.index], false, rule);
          continue;
        }
        let placed = false;
        for (const record of records) { if (record.kind !== 2) continue; if (record.from === anchor.index) { atEnd(record.number, true, rule); placed = true; } if (record.to === anchor.index) { atEnd(record.number, false, rule); placed = true; } }
        if (!placed && rule) fail('有放码点不在它的线的端点上');
      }
      // a rule on a notch goes to the notch on the net edge and to its twin on the seam line, as in ET's own files
      g.notchRules = 0;
      for (const item of plan.notchRules || []) { const records = model.notches.filter(notch => notch.recipeId === item.notchId); if (!records.length) { fail('有带放码规则的刀口没有写入文件'); continue; } for (const notch of records) notch.rule = { x: item.x, y: item.y, axisX: item.axisX.map(Math.fround), axisY: item.axisY.map(Math.fround) }; g.notchRules++; }
      Object.assign(g, { written: true, sizes: plan.sizes.map(size => size.label), baseSize: base, tableRows: table.rows.length });
      notes.push('放码已写入：号型 ' + plan.sizes.map(size => size.label).join('、') + '（基码 ' + base + '），尺寸表 ' + table.rows.length + ' 项，' + g.rules + ' 个点的放码规则。文件里只有基码的图形；在 ET 里执行“推板展开”得到各码。' + (g.notWritten ? '有 ' + g.notWritten + ' 条规则没有写入：' + g.reasons.join('；') + '。' : ''));
      if ((project.gradingPlans || []).filter(item => item.method === 'table').length > 1) notes.push('工程里有不止一个按尺寸表放码的方案，ET 文件里只能记一个，写入的是“' + plan.name + '”。');
    }
  }
  for (const notch of model.notches) delete notch.recipeId;
  model.curves = pendingCurves.map(curve => ({ id: id(), kind: curve.kind, base: curve.base, color: curve.color, flags: curve.flags, style: curve.style, points: curve.points, ...(curve.gradePoints ? { gradePoints: curve.gradePoints } : {}),
    ...(curve.kind === 4 ? { controls: curve.controls, ...(curve.base2 ? { base2: curve.base2 } : {}) } : {}), ...(curve.secondary ? { secondary: curve.secondary } : {}), links: curve.links, width: Math.fround(curve.width), attribute: curve.attribute || 0 }));
  for (const piece of model.pieces) { piece.id = id(); piece.id2 = id(); }
  for (const text of model.texts) text.id = id();
  for (const row of model.rows) row.id = id();
  const unsupported = [];
  if (project.seamChecks?.length) unsupported.push('对缝检查');
  if (project.gradingPlans?.some(plan => plan.method !== 'table') || project.grading?.length) unsupported.push('逐点输入位移的放码方案');
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
