/**
 * Turn an imported ET PRJ (the 2.0 "08" layout) into an editable millimetre project.
 *
 * The importer shows a file as it is stored: file units, read only. This module makes a working
 * copy that every command can change: coordinates in millimetres (1 file unit = 1 cm = 10 mm),
 * curves through the same points ET stored, pieces with their net contour, internal lines, texts
 * and grain line, and seam allowances rebuilt from the width ET stores on every contour edge.
 * ET's own seam lines are not copied; they are compared with the rebuilt ones and the largest
 * difference is reported. Whatever cannot be carried over is counted in the report, never dropped
 * silently. The original file is not touched.
 */
import { readPrjCurve, curveTail } from './prj-curves.mjs';
import { materialName } from './piece-attributes.mjs';
export { curveTail };
import { refreshCurve } from './curves.mjs';
import { fitClampedSpline, nativeFitPoints } from './fit-spline.mjs';
import { validateProject, length as entityLength } from './geometry.mjs';
import { findCommand } from './cad-command-set.mjs';
import { moveEnd } from './construct-edit.mjs';
import { applyNotches } from './notches.mjs';
import { seamWidthAt } from './seam-widths.mjs';
import { holeFromEt } from './prj-marks.mjs';
import { baseSizeLayer } from './prj-sizes.mjs';
import { carryEtGrading } from './prj-grading.mjs';
import { closeContourGaps } from './contour-heal.mjs';
import { contoursForGroup } from './topology.mjs';

export const EDITABLE_SOURCE_FORMAT = 'ET PRJ experimental';
const MM = 10; // millimetres per file unit
const HEAL_LIMIT = 1; // mm: ends of neighbouring contour edges this close are brought together, as ET treats them as joined
const scale = p => ({ x: p.x * MM, y: p.y * MM });


function distanceToPolyline(point, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) { const a = line[i - 1], b = line[i], dx = b.x - a.x, dy = b.y - a.y, q = dx * dx + dy * dy, t = q ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / q)) : 0; best = Math.min(best, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy)); }
  return best;
}
/** How far every point of some lines lies from the nearest of other lines, at most. */
function farthest(lines, others) { let worst = 0; for (const line of lines) for (const point of line) worst = Math.max(worst, Math.min(...others.map(other => distanceToPolyline(point, other)))); return worst; }

/**
 * @param input   the bytes of the PRJ file
 * @param parsed  what parsePrj returned for those bytes
 * @returns { project, report }  the editable project and an account of what was and was not carried over
 */
/**
 * The seam corner table at the end of an ET 2.0 file: one record per contour corner (type 0), and special records for
 * treated corners. Fields: type, curve (1-based index into the curve table), a, b, c and, for types 6 to 10 and 15, two sizes
 * in file units; types 16 to 20 end with 40 more bytes. Type 6 is a cut corner between `curve` (end a) and curve b (end c); type 8 a
 * stepped corner at end a of `curve`; type 1 a fold-back of the hem `curve` at its start (a = 0) and/or end (c = 1). v65: 2 直角,
 * 5 延长反转角 and 20 包边延长反转角 name the sewn edge of the piece picked first (end a) and the partner's (curve b, end c); 4 折叠角;
 * 7 七字角, 10 反转直角, 18 双延长角, 19 双投影角 at end a of the edge picked; 15 可调反转 names its ends like the fold-back and keeps its
 * shift as the first size. v67: 3 is ET's step where the width changes at a smooth joint (the page draws it itself); 9 单边直角 at end a
 * (sizes A, 0); 11 to 13 曲线断差1 to 3 at end a (A, B); 14 反转翻角 on the hem, both ends (a 0, c 1; A, B); 16 开叉半止口 and 17 开叉全止口
 * on the vent edge, both ends, their 40 bytes six floats [0, 0, A, B, C, D] and four -1. Rows of a type not known here are tried at
 * each of the three lengths.
 * The table is the last thing in the file, so it is found from the end: objects between the texts and the table, which
 * this reader does not know, need not be understood. Returns null when no table can be read.
 */
// how many bytes follow the 24 of a corner record, by its type, as ET writes them (v65)
const CORNER_EXTRA = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 8, 7: 8, 8: 8, 9: 8, 10: 8, 11: 8, 12: 8, 13: 8, 14: 8, 15: 8, 16: 40, 17: 40, 18: 40, 19: 40, 20: 40 };
export function cornerTable(bytes, textEnd) {
  if (!Number.isInteger(textEnd) || textEnd < 0 || textEnd > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let last = bytes.length; while (last > 0 && bytes[last - 1] === 0) last--;
  let unknownRows = 0;
  // `count` rows from `o`. A row of a type not known here is tried at each length ET uses, keeping the one with which the rest of
  // the table reads to the end of the file (v65; before, one unknown type made the whole table unreadable).
  // The table ends with the file but for zeros; the last row may itself end in zero fields (a 折叠角 whose second end is 0, the two
  // zero sizes of a 七字角), so its end may lie up to a row past the last byte that is not zero.
  const rowsFrom = (o, count) => {
    const rows = [];
    for (let i = 0; i < count; i++) {
      if (o + 24 > bytes.length || view.getUint32(o, true) !== 0 || bytes[o + 4] !== 255 || bytes[o + 5] !== 255 || bytes[o + 6] !== 255) return null;
      const type = bytes[o + 7], row = { type, curve: view.getUint32(o + 8, true), a: view.getInt32(o + 12, true), b: view.getUint32(o + 16, true), c: view.getInt32(o + 20, true) }; o += 24;
      const extra = CORNER_EXTRA[type];
      if (extra === undefined) {
        if (++unknownRows > 8) return null;
        for (const length of [0, 8, 40]) { const rest = rowsFrom(o + length, count - i - 1); if (rest && rest.end >= last && rest.end <= last + 24) return { rows: [...rows, { ...row, unknownLength: length }, ...rest.rows], end: rest.end }; }
        return null;
      }
      if (o + extra > bytes.length) return null;
      if (extra === 8) row.sizes = [view.getFloat32(o, true), view.getFloat32(o + 4, true)];
      else if (extra === 40) row.tail = [0, 1, 2, 3, 4, 5].map(k => view.getFloat32(o + k * 4, true));   // v67: 开叉 keeps [0, 0, A, B, C, D] there
      o += extra; rows.push(row);
    }
    return { rows, end: o };
  };
  const read = start => { const count = view.getUint32(start, true); return count > 20000 ? null : rowsFrom(start + 4, count); };
  for (let o = textEnd; o + 4 <= bytes.length; o++) { unknownRows = 0; const table = read(o); if (table && table.end >= last && table.end <= last + 24 && (table.rows.length || o + 4 >= last)) return { offset: o, rows: table.rows }; }
  return null;
}

/**
 * Notches of an ET 2.0 file. A notch is a node of type 7 in the node table: the 34 bytes every node has (type, identity,
 * six fixed bytes, x, y, z, a reference, zero) and then 46 bytes: u8 how it is placed (0 by distance, 1 at a point where
 * the line named by the reference meets the edge), f32 distance from an end of its edge in file units, u32 1, u32 the
 * curve it sits on (1-based), u8 which end the distance is counted from, u32 role (0 on the net edge, 2 for the twin ET
 * keeps on the seam line of that edge), the direction the notch points and the tangent of the edge there (three floats each),
 * u32 0. The curve lists the node in its second node list. Longer records are other kinds of notch and are returned as unknown.
 */
export function notchNodes(bytes, nodes, sectionEnd) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = [];
  (nodes || []).forEach((node, i) => {
    if (node.recordType !== 7) return;
    const length = (nodes[i + 1]?.offset ?? sectionEnd) - node.offset, o = node.offset + 34;
    if (length > 84 && length < 400) {
      // A notch whose distance is a size of the size table has the size name and a block of numbers between the distance and
      // the fixed "1"; the rest is read from the end of the record. Its place and direction are those of an ordinary notch.
      // two texts follow the distance (either may be empty), then 46 bytes of numbers
      const end = node.offset + length, first = view.getUint16(o + 5, true), second = first < 64 ? view.getUint16(o + 7 + first, true) : 999;
      if (view.getUint32(end - 41, true) === 1 && view.getUint32(end - 4, true) === 0 && bytes[end - 33] <= 1 && [0, 2].includes(view.getUint32(end - 32, true)) && first + second > 0 && second < 64 && 34 + 5 + 4 + first + second + 46 + 41 === length) {
        const text = (at, size) => { try { return new TextDecoder('gb18030', { fatal: true }).decode(bytes.subarray(at, at + size)); } catch { return ''; } };
        const formula = [text(o + 7, first), text(o + 9 + first, second)].filter(Boolean).join(' / ');
        out.push({ node: i + 1, known: true, x: node.x, y: node.y, reference: node.ownerIndex, mode: 0, distance: 0, count: 1, owner: view.getUint32(end - 37, true), end: bytes[end - 33], role: view.getUint32(end - 32, true), formula,
          direction: { x: view.getFloat32(end - 28, true), y: view.getFloat32(end - 24, true) }, tangent: { x: view.getFloat32(end - 16, true), y: view.getFloat32(end - 12, true) } });
        return;
      }
    }
    if (!(length >= 80 && length <= 84) || o + 46 > bytes.length) { out.push({ node: i + 1, known: false, length }); return; }
    out.push({ node: i + 1, known: true, x: node.x, y: node.y, reference: node.ownerIndex, mode: bytes[o], distance: view.getFloat32(o + 1, true), count: view.getUint32(o + 5, true), owner: view.getUint32(o + 9, true),
      end: bytes[o + 13], role: view.getUint32(o + 14, true), direction: { x: view.getFloat32(o + 18, true), y: view.getFloat32(o + 22, true) }, tangent: { x: view.getFloat32(o + 30, true), y: view.getFloat32(o + 34, true) } });
  });
  return out;
}
/** Where a point lies along a polyline: distance from the start, how far off the line it is, and the direction of the line there. */
function alongPath(points, q) {
  let best = { off: Infinity, s: 0, tangent: { x: 1, y: 0 } }, walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy); if (!(length > 0)) continue;
    const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (length * length))), off = Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy);
    if (off < best.off) best = { off, s: walked + t * length, tangent: { x: dx / length, y: dy / length } };
    walked += length;
  }
  return { ...best, total: walked };
}

/**
 * v66: the extension of every contour edge of a piece, read off ET's extended seam `ring` (mm): from points along the middle of the
 * edge's seam line (on the side where the rebuilt seam outline lies) to ET's curve, the median. ET makes its extended seam from the
 * seam curves it stores, so on a curved edge the value can be up to about 1 mm off (see seam-v66 comparisons).
 */
function extensionWidths(project, groupId, contourIds, ring) {
  const group = project.groups.find(g => g.id === groupId), recipe = (project.seamAllowances || []).find(r => r.baseEntityIds.every(id => group.entityIds.includes(id)) && r.baseEntityIds.length === contourIds.length);
  const outline = project.entities.find(e => e.id === recipe.outputIds.find(id => project.entities.find(x => x.id === id)?.seamRole === 'outer')).points;
  const seg = (q, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l)) : 0; return Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy); };
  const near = (q, points, closed) => { let best = Infinity; const n = points.length; for (let i = closed ? 0 : 1; i < n; i++) best = Math.min(best, seg(q, points[(i + n - 1) % n], points[i])); return best; };
  return contourIds.map(id => {
    const entity = project.entities.find(e => e.id === id), pts = entity.points, width = recipe.edgeWidths.find(w => w.entityId === id)?.width ?? Math.abs(recipe.distance);
    const lengths = [0]; for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const total = lengths.at(-1), found = [];
    for (let k = 3; k <= 7; k++) {
      const want = total * k / 10; let i = 1; while (i < pts.length - 1 && lengths[i] < want) i++;
      const a = pts[i - 1], b = pts[i], f = (want - lengths[i - 1]) / ((lengths[i] - lengths[i - 1]) || 1), q = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, d = Math.hypot(b.x - a.x, b.y - a.y) || 1, n = { x: (b.y - a.y) / d, y: -(b.x - a.x) / d };
      const one = { x: q.x + n.x * width, y: q.y + n.y * width }, other = { x: q.x - n.x * width, y: q.y - n.y * width }, seam = near(one, outline, true) <= near(other, outline, true) ? one : other;
      found.push(near(seam, ring, false));
    }
    found.sort((x, y) => x - y);
    return { entityId: id, width: found[2], straight: !entity.curve && pts.length === 2 };
  });
}
export function convertPrjToEditable(input, parsed, { makeId = () => crypto.randomUUID() } = {}) {
  if (parsed?.metadata?.format !== EDITABLE_SOURCE_FORMAT) throw new Error('目前只能把 ET 2.0（08 版）布局的 PRJ 转成可编辑工程；其他布局的文件请先在 ET 里另存为 08 版。');
  // a file with a layer per size is read as its base size, the same bytes the reader used
  const bytes = baseSizeLayer(input instanceof Uint8Array ? input : new Uint8Array(input)).bytes, env = { makeId };
  const curves = parsed.entities.filter(e => e.type !== 'text' && [2, 4].includes(e.source?.recordKind)).sort((a, b) => a.source.offset - b.source.offset);
  const tails = new Map(curves.map(e => [e.id, curveTail(bytes, e.source.offset)]));
  const project = { format: 'zhiyi-cad', version: 6, name: parsed.name || '未命名纸样', units: 'mm', entities: [], groups: [], seamAllowances: [],
    metadata: { importedFrom: { format: 'ET PRJ 2.0', file: String(parsed.metadata.sourceFile || ''), style: String(parsed.metadata.style || ''), baseSize: String(parsed.metadata.baseSize || ''), scale: '1 cm = 10 mm' } } };
  const report = { sourceFile: project.metadata.importedFrom.file, fileUnit: 'cm', scale: '1 cm = 10 mm', curves: { total: curves.length, lines: 0, splines: 0, refittedMaxDifferenceMm: 0 },
    seamLinesNotCopied: 0, notchMarksDropped: 0, unknownAttribute: 0, pieces: [], piecesFailed: [], looseCurves: 0, looseTexts: 0, texts: 0, notes: [] };
  const made = new Map(); let serial = 0;
  const attribute = e => tails.get(e.id).flags[2];
  // v66: ET's extended seam (生成扩展缝边) is a dashed curve on the seam layer, drawn in 7fcccc; a file ET opened again and saved keeps
  // it dashed but in the seam colour (seen with ET's own file). It is rebuilt from widths, not copied.
  // v66: ET's extended seam is a closed dashed ring on the seam layer; v67: a vent's fold is dashed too, but open
  const isExtended = e => attribute(e) === 2 && e.source?.lineStyle === 1 && e.points.length > 3 && Math.hypot(e.points[0].x - e.points.at(-1).x, e.points[0].y - e.points.at(-1).y) < 1e-4, extensions = [];
  // treated seam corners, by the contour edge their record names
  const table = cornerTable(bytes, parsed.metadata.textSectionEndOffset), special = new Map();
  const everyCurve = parsed.entities.filter(e => e.type !== 'text' && e.source?.recordKind).sort((a, b) => a.source.offset - b.source.offset);
  report.corners = { readable: Boolean(table), records: table ? table.rows.length : 0, cut: 0, step: 0, fold: 0, mitre: 0, special: 0, pair: 0, notCarried: 0 };
  const pairRows = [];   // 直角, 延长反转角, 包边延长反转角: set once both pieces have their seam
  for (const row of table?.rows || []) { if (!row.type) continue; const e = everyCurve[row.curve - 1]; if (!e) { report.corners.notCarried++; continue; } if (!special.has(e.id)) special.set(e.id, []); special.get(e.id).push(row); }

  function carry(e) {
    const tail = tails.get(e.id), layer = tail.flags[2] === 1 ? 'internal' : 'outline', number = ++serial;
    if (tail.flags[2] > 2) report.unknownAttribute++;
    const entity = { id: makeId(), type: 'polyline', closed: false, layer, name: (e.source.recordKind === 4 ? '曲线 ' : '直线 ') + number, points: e.points.map(scale) };
    if (e.source.recordKind === 4) {
      // Refit through ET's own points with ET's rule, so that the curve keeps exactly those points.
      let curve = null;
      try {
        const fitted = fitClampedSpline(e.source.fitPoints.map(scale)); curve = fitted.curve;
        // how far the control points ET stored are from the ones its rule gives for the same points
        report.curves.refittedMaxDifferenceMm = Math.max(report.curves.refittedMaxDifferenceMm, ...fitted.controls.map((c, i) => Math.hypot(c.x - e.source.controlPoints[i].x * MM, c.y - e.source.controlPoints[i].y * MM)));
      } catch { report.curves.notRefitted = (report.curves.notRefitted || 0) + 1; /* repeated points: keep the reconstructed curve below */ }
      if (!curve && e.curve) curve = { kind: 'bspline', degree: 3, controlPoints: e.curve.controlPoints.map(scale), knots: [...e.curve.knots], samplingTolerance: .002 };
      if (curve) {
        entity.curve = curve; refreshCurve(entity);
      }
      report.curves.splines++;
    } else report.curves.lines++;
    // ET tells ordinary lines from auxiliary ones by colour: a closed loop of white lines is treated as a piece outline.
    const color = e.source.color; if (Array.isArray(color) && color.length === 3 && color.every(v => Number.isInteger(v) && v >= 0 && v <= 255) && color.some(v => v !== 255)) entity.color = [...color];
    if (e.source.lineStyle === 1) entity.lineStyle = 1;
    if (tail.attribute) entity.etAttribute = tail.attribute;
    // v66: a pink line with ET's attribute word 1 is a line of 净边延长
    if (tail.attribute === 1 && JSON.stringify(entity.color) === '[255,128,255]' && !entity.curve && entity.points?.length === 2) entity.netExtension = true;
    // ET's line marks kept in the first flag byte: 0x10 auxiliary line, 0x08 division mark. The marks of a symmetric piece
    // (0x80, and bits of the second byte) are not carried: written back without the symmetry they belong to, they make ET
    // rebuild a mirrored half that the file does not describe.
    const marks = [tail.flags[0] & 0x18, 0];
    if (marks[0]) entity.etFlags = marks;
    if (marks[0] & 0x10) entity.aux = true;
    made.set(e.id, entity); project.entities.push(entity); return entity;
  }
  for (const e of curves) {
    const tail = tails.get(e.id);
    // A record marked 0x40 is a dashed line that ET keeps a fixed distance from an edge (a stitch line or a hem fold line).
    // Its shape is carried as an ordinary dashed line of the piece; the tie to the edge is not.
    if (tail.special) { const line = carry(e); line.lineStyle = 1; line.layer = 'internal'; report.edgeLinesCarried = (report.edgeLinesCarried || 0) + 1; continue; }
    if (tail.flags[2] === 2) { report.seamLinesNotCopied++; continue; }
    carry(e);
  }
  for (const e of parsed.entities.filter(x => x.type === 'text')) {
    const text = { id: makeId(), type: 'text', layer: 'annotation', name: e.name, text: e.text, points: [scale(e.points[0])], height: e.height * MM, ...(e.width ? { width: e.width * MM } : {}),
      ...(e.rotation ? { rotation: e.rotation } : {}), ...(e.verticalAlign ? { verticalAlign: e.verticalAlign } : {}) };
    made.set(e.id, text); project.entities.push(text); report.texts++;
  }

  const closeContour = edges => closeContourGaps(edges, HEAL_LIMIT);
  const byId = new Map(parsed.entities.map(e => [e.id, e])), owned = new Set();
  for (const [sourceIndex, group] of parsed.groups.entries()) {
    const primary = (group.contours || []).find(c => c.role === 'primary-contour'), entry = { name: group.name, sourceIndex, contourEdges: 0, internalLines: 0, texts: 0, seam: null };
    try {
      if (!primary || !primary.entityIds.length) throw new Error('没有主轮廓。');
      const missing = primary.entityIds.filter(id => !made.has(id)); if (missing.length) throw new Error('主轮廓里有 ' + missing.length + ' 条线没有带入（刀口或缝边属性的线）。');
      const contour = primary.entityIds.map(id => made.get(id)), contourIds = new Set(primary.entityIds);
      const healed = closeContour(contour); if (healed.count) Object.assign(entry, { joinedEnds: healed.count, largestGapClosedMm: +healed.largest.toFixed(3) });
      const members = group.entityIds.filter(id => !contourIds.has(id) && made.has(id)).map(id => made.get(id));
      for (const member of members) if (member.type !== 'text' && member.layer !== 'internal') member.layer = 'internal'; // lines inside a piece that are not its outline
      const grainSource = byId.get(group.source?.grainId), grain = grainSource ? { from: scale(grainSource.points[0]), to: scale(grainSource.points[1]) } : undefined;
      const created = findCommand('piece.create').run(project, { name: group.name || '裁片', contourEntityIds: contour.map(e => e.id), memberEntityIds: members.map(e => e.id), ...(grain ? { grain } : {}) }, env);
      const piece = project.groups.find(g => g.id === created.created);
      piece.source = { kind: 'et-import', pieceIndex: group.source?.pieceIndex ?? null }; // symmetric: ET writes 对称, and "sym" on pieces it made from a DXF; the count beside it is above zero in both cases
      piece.attributes = { symmetric: group.source?.symmetry === '对称' || group.source?.symmetry === 'sym' || group.source?.symmetricCount > 0, material: String(group.source?.material || ''), size: String(group.source?.size || ''), count: Number.isInteger(group.source?.count) && group.source.count >= 1 ? group.source.count : 1,
        // the fabric is the number; a file may carry it without a name
        materialCode: Number.isInteger(group.source?.materialCode) ? group.source.materialCode : 100,
        et: { angle: Number.isFinite(group.source?.angle) ? group.source.angle : 0, label: String(group.source?.labelFormat || 'MD') } };
      piece.attributes.material = materialName(piece.attributes.material, piece.attributes.materialCode);
      if (grainSource?.arrowStart) { const line = project.entities.find(e => e.id === piece.entityIds.at(-1)); if (line?.layer === 'grain') line.arrowStart = true; }
      for (const id of group.entityIds) owned.add(id);
      Object.assign(entry, { contourEdges: contour.length, internalLines: members.filter(e => e.type !== 'text').length, texts: members.filter(e => e.type === 'text').length, extraChains: (group.contours || []).length - 1 });
      // seam allowance from the width ET stores on every contour edge
      const widths = primary.entityIds.map(id => Math.round(tails.get(id).width * MM * 1e4) / 1e4);
      const tapered = primary.entityIds.filter(id => { const t = tails.get(id); return t.width2 !== null && Math.abs(t.width2 - t.width) > 1e-4; }).length;
      const etSeams = group.entityIds.map(id => byId.get(id)).filter(e => e && tails.has(e.id) && attribute(e) === 2 && !isExtended(e)).map(e => e.points.map(scale));
      const etExtended = group.entityIds.map(id => byId.get(id)).find(e => e && tails.has(e.id) && isExtended(e));
      if (widths.some(w => !(w >= 0 && w <= 300))) entry.seam = { rebuilt: false, reason: '轮廓边上的缝份宽度不是有效数值。', etSeamLines: etSeams.length };
      else if (tapered) entry.seam = { widthsMm: [...new Set(widths)].sort((a, b) => a - b), rebuilt: false, reason: '有 ' + tapered + ' 条边的缝份两端宽度不同（渐变缝边），还不能重建。', etSeamLines: etSeams.length };
      else if (widths.some(w => w > 0)) {
        const counts = new Map(); for (const w of widths.filter(x => x > 0)) counts.set(w, (counts.get(w) || 0) + 1);
        const usual = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        // the corner treatments ET keeps for this contour: cut (6), stepped (8) and fold-back (1) corners; v65: 折叠角 (4), 七字角 (7),
        // 反转直角 (10), 可调反转 (15), 双延长角 (18), 双投影角 (19); the pair treatments (2, 5, 20) wait until every piece has its seam
        const corners = [], kinds = { cut: 0, step: 0, fold: 0, mitre: 0, special: 0 }; let unknown = 0;
        const named = { 7: 'sevenStep', 10: 'foldSquare', 18: 'doubleExtend', 19: 'doubleProject' }, steps = { 11: 'curveStep1', 12: 'curveStep2', 13: 'curveStep3' };
        const mm = value => Math.round(value * MM * 1e4) / 1e4;
        primary.entityIds.forEach((id, i) => { for (const row of special.get(id) || []) {
          const entityId = contour[i].id, sizes = row.sizes ? row.sizes.map(value => Math.round(value * MM * 1e4) / 1e4) : null, end = row.a === 1 ? 'end' : 'start', atEnd = row.a === 0 || row.a === 1;
          if (row.type === 6 && atEnd && sizes.every(value => value > 0)) { corners.push({ entityId, end, kind: 'cut', first: sizes[0], second: sizes[1] }); kinds.cut++; }
          else if (row.type === 8 && atEnd && sizes.every(value => value > 0)) { corners.push({ entityId, end, kind: 'step', drop: sizes[0], run: sizes[1] }); kinds.step++; }
          else if (row.type === 1 && (row.a === 0 || row.c === 1)) { if (row.a === 0) { corners.push({ entityId, end: 'start', kind: 'fold' }); kinds.fold++; } if (row.c === 1) { corners.push({ entityId, end: 'end', kind: 'fold' }); kinds.fold++; } }
          else if (row.type === 4 && atEnd) { corners.push({ entityId, end, kind: 'mitre' }); kinds.mitre++; }
          else if (named[row.type] && atEnd) { corners.push({ entityId, end, kind: named[row.type] }); kinds.special++; }
          else if (row.type === 15 && (row.a === 0 || row.c === 1) && sizes && sizes[0] >= 0) { for (const [flag, at] of [[row.a === 0, 'start'], [row.c === 1, 'end']]) if (flag) { corners.push({ entityId, end: at, kind: 'foldShift', shift: sizes[0] }); kinds.special++; } }
          else if ([2, 5, 20].includes(row.type) && atEnd && (row.c === 0 || row.c === 1)) pairRows.push({ row, entityId, end, groupId: piece.id });
          // v67: ET's step at a smooth joint is the page's own default there; 单边直角, 曲线断差, 反转翻角 and 开叉 carry their sizes
          else if (row.type === 3) continue;
          else if (row.type === 9 && atEnd && sizes && sizes[0] >= 0) { corners.push({ entityId, end, kind: 'singleSquare', a: sizes[0] }); kinds.special++; }
          else if (steps[row.type] && atEnd && sizes && sizes[0] >= 0 && sizes[1] >= 0) { corners.push({ entityId, end, kind: steps[row.type], a: sizes[0], b: sizes[1] }); kinds.special++; }
          else if (row.type === 14 && row.a === 0 && row.c === 1 && sizes && sizes[0] > 0 && sizes[1] > sizes[0]) { corners.push({ entityId, end: 'both', kind: 'turnUp', a: sizes[0], b: sizes[1] }); kinds.special++; }
          else if ((row.type === 16 || row.type === 17) && row.a === 0 && row.c === 1 && row.tail && row.tail.slice(2).every(value => value >= 0)) {
            const [a, b, c, d] = row.tail.slice(2).map(mm); corners.push({ entityId, end: 'both', kind: row.type === 16 ? 'ventHalf' : 'ventFull', a, b, c, d }); kinds.special++; }
          else unknown++;
        } special.delete(id); });
        const seamParameters = { groupId: piece.id, width: usual, overrides: contour.map((e, i) => ({ entityId: e.id, width: widths[i] })).filter(o => o.width !== usual) };
        let cornerNote = null;
        // tried on a copy first: a corner that cannot be built must not leave a half-made seam behind
        if (corners.length) try { findCommand('seam.apply').run(JSON.parse(JSON.stringify(project)), { ...seamParameters, corners }, env); } catch (error) { cornerNote = error.message; unknown += corners.length; corners.length = 0; kinds.cut = kinds.step = kinds.fold = kinds.mitre = kinds.special = 0; }
        try {
          const applied = findCommand('seam.apply').run(project, { ...seamParameters, ...(corners.length ? { corners } : {}) }, env);
          const recipe = project.seamAllowances.find(r => r.id === applied.created), ours = recipe.outputIds.map(id => project.entities.find(e => e.id === id)).filter(e => e.seamRole !== 'extension').map(e => e.closed ? [...e.points, e.points[0]] : e.points);
          entry.seam = { widthsMm: [...new Set(widths)].sort((a, b) => a - b), rebuilt: true, etSeamLines: etSeams.length,
            ...(corners.length ? { corners: { ...kinds } } : {}), ...(unknown ? { cornersNotCarried: unknown, ...(cornerNote ? { cornerReason: cornerNote } : {}) } : {}),
            ...(etSeams.length ? { etLinesFromRebuiltMm: +farthest(etSeams, ours).toFixed(3), rebuiltFromEtLinesMm: +farthest(ours, etSeams).toFixed(3) } : {}) };
          if (etExtended) extensions.push({ groupId: piece.id, contourIds: contour.map(e => e.id), ring: etExtended.points.map(scale), entry });
          report.corners.cut += kinds.cut; report.corners.step += kinds.step; report.corners.fold += kinds.fold; report.corners.mitre += kinds.mitre; report.corners.special += kinds.special; report.corners.notCarried += unknown;
        } catch (error) { entry.seam = { widthsMm: [...new Set(widths)].sort((a, b) => a - b), rebuilt: false, reason: error.message, etSeamLines: etSeams.length }; report.corners.notCarried += unknown + corners.length; }
      } else if (etSeams.length) {
        const apart = farthest(etSeams, [[...contour.flatMap(e => e.points), contour[0].points[0]]]);
        entry.seam = apart <= .05 ? { widthsMm: [0], rebuilt: false, none: true, note: '缝份宽度为 0：ET 的缝边线与净边重合。', etSeamLines: etSeams.length }
          : { widthsMm: [0], rebuilt: false, reason: '轮廓各边的缝份宽度都是 0，但文件里的缝边线离净边 ' + apart.toFixed(2) + ' mm。', etSeamLines: etSeams.length };
      }
      report.pieces.push(entry);
    } catch (error) { report.piecesFailed.push({ name: group.name, reason: error.message }); }
  }
  // Notches: every node of type 7 on a net edge becomes a notch of the editable project, at the same place and pointing the
  // same way. Its twin on the seam line is not copied: the page finds it again on the rebuilt seam allowance.
  const notchList = notchNodes(bytes, parsed.metadata.nodes, parsed.metadata.firstCurveOffset ?? bytes.length);
  report.notches = { inFile: notchList.filter(item => !item.known || item.role === 0).length, carried: 0, notCarried: 0, otherKinds: notchList.filter(item => !item.known).length, reasons: [] };
  const notchOfNode = new Map();   // point number of a notch record -> the notch of the drawing made from it
  for (const item of notchList) {
    if (!item.known || item.role !== 0) continue;
    try {
      const source = everyCurve[item.owner - 1], base = source && made.get(source.id); if (!base) throw new Error('它所在的线没有带入');
      const where = alongPath(base.points, { x: item.x * MM, y: item.y * MM }); if (where.off > .05) throw new Error('它不在记录里说的那条线上');
      const recipe = project.seamAllowances.find(r => r.baseEntityIds.includes(base.id)) || null, distance = Math.round(item.distance * MM * 1e4) / 1e4;
      let mode = 'start', position = Math.round(where.s * 1e4) / 1e4;
      if (item.mode === 0 && distance > 0 && item.end === 1 && Math.abs(where.total - distance - where.s) < .05) { mode = 'end'; position = distance; }
      else if (item.mode === 0 && distance > 0 && item.end === 0 && Math.abs(distance - where.s) < .05) position = distance;
      else if (where.total - where.s < 1e-3) { mode = 'end'; position = 0; }
      else if (where.s < 1e-3) position = 0;
      const size = Math.hypot(item.direction.x, item.direction.y), t = where.tangent;
      let pointing = size > .5 ? { x: item.direction.x / size, y: item.direction.y / size } : null;
      // The stored direction of a mirrored notch can point into the piece. Its twin on the seam line shows the real way out.
      if (pointing) {
        const twin = notchList.filter(other => other.known && other.role === 2).map(other => ({ dx: (other.x - item.x) * MM, dy: (other.y - item.y) * MM }))
          .filter(d => { const reach = Math.hypot(d.dx, d.dy); return reach > .01 && reach < 80 && Math.abs(d.dx * pointing.y - d.dy * pointing.x) < .05; }).sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy))[0];
        if (twin && twin.dx * pointing.x + twin.dy * pointing.y < 0) pointing = { x: -pointing.x, y: -pointing.y };
      }
      const side = pointing && pointing.x * -t.y + pointing.y * t.x < 0 ? -1 : 1, square = !pointing || Math.abs(pointing.x * t.x + pointing.y * t.y) < .002;
      let width = 0; if (recipe) try { width = seamWidthAt(recipe, base, where.s); } catch { width = 0; }
      const options = { mode, position, side, count: 1, shape: 'line', direction: square ? null : pointing };
      let notch;
      try { notch = applyNotches(project, base.id, { ...options, depth: width > .4 ? Math.min(3, width / 2) : 3, targetSeamId: width > .4 ? recipe.id : null }, makeId); }
      catch { notch = applyNotches(project, base.id, { ...options, depth: 3, targetSeamId: null }, makeId); }   // no seam line to cut into at that place: drawn on the net line
      const referred = everyCurve[item.reference - 1], line = referred && made.get(referred.id);
      notch.name = '刀口 ' + (++report.notches.carried); notchOfNode.set(item.node, notch.id); notch.et = { mode: item.mode, ...(item.mode === 1 && line && line.id !== base.id ? { referenceEntityId: line.id } : {}) };
      if (item.formula) { report.notches.bySizeName = (report.notches.bySizeName || 0) + 1; (report.notches.sizeNames ??= []).push(item.formula); }
    } catch (error) { report.notches.notCarried++; if (report.notches.reasons.length < 5 && !report.notches.reasons.includes(error.message)) report.notches.reasons.push(error.message); }
  }
  // what belongs to no piece stays as loose lines and texts
  for (const e of parsed.entities) { if (owned.has(e.id) || !made.has(e.id)) continue; if (e.type === 'text') report.looseTexts++; else report.looseCurves++; }
  // ET's own marks (v55): rows of buttons and buttonholes, and drill holes, become marks of the drawing at the same places.
  {
    const found = parsed.metadata.etMarks || { rows: [], drills: [], linePoints: [], readable: true, declaredRows: 0 }, place = q => ({ x: q.x * MM, y: q.y * MM });
    report.marks = { buttonRows: 0, buttonholeRows: 0, buttons: 0, buttonholes: 0, drills: 0, inFile: { rows: found.readable ? found.rows.length : found.declaredRows, drills: found.drills.length }, notCarried: 0, linePoints: found.linePoints.length, readable: found.readable, reasons: [] };
    const pieceOfIndex = index => index === null || index === undefined ? null : project.groups.find(g => g.source?.kind === 'et-import' && g.source.pieceIndex === index + 1) || null;
    const settle = (setId, owner) => {   // the piece ET says the mark belongs to, whatever its place
      const ids = project.entities.filter(e => e.mark?.id === setId).map(e => e.id);
      for (const g of project.groups) g.entityIds = g.entityIds.filter(id => !ids.includes(id));
      if (owner) owner.entityIds.push(...ids);
    };
    const fail = error => { report.marks.notCarried++; if (report.marks.reasons.length < 5 && !report.marks.reasons.includes(error.message)) report.marks.reasons.push(error.message); };
    for (const row of found.rows) {
      try {
        const places = row.items.map(place), first = places[0], last = places.at(-1), base = row.baseLine.map(place), span = Math.hypot(base[1].x - base[0].x, base[1].y - base[0].y) || 1, u = { x: (base[1].x - base[0].x) / span, y: (base[1].y - base[0].y) / span };
        const even = places.every((q, i) => { const t = places.length > 1 ? i / (places.length - 1) : 0; return Math.hypot(q.x - (first.x + (last.x - first.x) * t), q.y - (first.y + (last.y - first.y) * t)) <= .02; });
        const hole = row.kind === 'buttonhole' ? holeFromEt(row.radius * MM, row.offset * MM) : null;
        // sizes come from single-precision numbers of the file: 12.699999809 is 12.7
        const tidy = v => Math.round(v * 1e4) / 1e4, sizes = row.kind === 'button' ? { diameter: tidy(row.radius * 2 * MM) } : { length: tidy(hole.length), direction: 'across', shift: tidy(hole.shift) };
        // evenly spaced rows are one row here too; others are placed mark by mark, each in the row's direction
        const batches = even && places.length > 1 ? [{ from: first, to: last, count: places.length }] : places.map(q => ({ from: q, to: { x: q.x + u.x * 10, y: q.y + u.y * 10 }, count: 1 }));
        for (const batch of batches) { const made = findCommand(row.kind === 'button' ? 'mark.buttons' : 'mark.buttonholes').run(project, { ...batch, ...sizes }, env); settle(made.summary.setId, pieceOfIndex(row.piece)); }
        if (row.kind === 'button') { report.marks.buttonRows++; report.marks.buttons += places.length; } else { report.marks.buttonholeRows++; report.marks.buttonholes += places.length; }
      } catch (error) { fail(error); }
    }
    for (const hole of found.drills) {
      try { const made = findCommand('mark.drill').run(project, { from: place(hole) }, env); settle(made.summary.setId, pieceOfIndex(hole.piece)); report.marks.drills++; } catch (error) { fail(error); }
    }
    if (!found.readable) report.marks.notCarried += found.declaredRows;
  }
  // v59: ET sets one more bit in a byte of the piece record on pieces it made with its 提取裁片 tool. What the bit does is not known;
  // a file written from here does not carry it.
  report.piecesWithEtExtractMark = (parsed.groups || []).filter(group => group.source && (group.source.flag & 0x80)).length;
  if (report.piecesWithEtExtractMark) report.notes.push('有 ' + report.piecesWithEtExtractMark + ' 个裁片带着一个标记（ET 用“提取裁片”做出的裁片有这个标记，它起什么作用还没有查明）。裁片照常带入；另存为新的 ET 文件时不保留这个标记。');
  for (const failed of report.piecesFailed) report.notes.push('裁片“' + failed.name + '”没有建成裁片，它的线条作为独立线条保留：' + failed.reason);
  if (report.notches.carried) report.notes.push('带入了 ' + report.notches.carried + ' 个刀口，位置和方向与原文件相同。');
  if (report.marks.buttonRows || report.marks.buttonholeRows) report.notes.push('带入了 ' + [report.marks.buttonRows ? report.marks.buttonRows + ' 排扣子（' + report.marks.buttons + ' 个）' : '', report.marks.buttonholeRows ? report.marks.buttonholeRows + ' 排扣眼（' + report.marks.buttonholes + ' 个）' : ''].filter(Boolean).join('、') + '，位置、大小与原文件相同；保存为 ET 文件时写回成 ET 自己的扣子、扣眼。');
  if (report.marks.drills) report.notes.push('带入了 ' + report.marks.drills + ' 个打孔，位置与原文件相同。孔的大小在 ET 里是软件的设置，不在文件里，这里按 3 mm 画。');
  if (report.marks.notCarried) report.notes.push('有 ' + report.marks.notCarried + ' 排扣子、扣眼或打孔没有带入：' + (report.marks.readable ? report.marks.reasons.join('；') : '这部分记录没有读懂') + '。');
  if (report.notches.bySizeName) report.notes.push('其中 ' + report.notches.bySizeName + ' 个刀口的位置在 ET 里是按尺寸表里的尺寸定的（' + [...new Set(report.notches.sizeNames)].join('、') + '），带入后位置不变，但不再跟着尺寸表变。');
  if (report.notches.notCarried) report.notes.push('有 ' + report.notches.notCarried + ' 个刀口没有带入：' + report.notches.reasons.join('；') + '。');
  if (report.notches.otherKinds) report.notes.push('有 ' + report.notches.otherKinds + ' 个刀口的记录是还不认识的种类，没有带入。');
  if (report.edgeLinesCarried) report.notes.push('有 ' + report.edgeLinesCarried + ' 条沿边的虚线（明线、折边线一类）按普通虚线带入：位置不变，但在 ET 里不再跟着那条边变。');
  if (report.seamLinesNotCopied) report.notes.push('ET 的 ' + report.seamLinesNotCopied + ' 条缝边线没有照抄，缝份按每条轮廓边上记录的宽度和转角的角处理重新生成。');
  // the pair treatments, now that every piece has its seam: the partner's edge is the curve the record names as b
  for (const { row, entityId, end, groupId } of pairRows) {
    const partnerEdge = made.get(everyCurve[row.b - 1]?.id), partnerGroup = partnerEdge && project.groups.find(g => g.id !== groupId && contoursForGroup(g).some(c => c.role === 'primary-contour' && c.entityIds.includes(partnerEdge.id)));
    if (!partnerGroup) { report.corners.notCarried++; continue; }
    const kind = { 2: 'square', 5: 'extendFold', 20: 'boundFold' }[row.type];
    try {
      const trial = JSON.parse(JSON.stringify(project));
      findCommand('seam.corner').run(trial, { groupId, entityId, end, kind, partnerEntityId: partnerEdge.id, partnerEnd: row.c === 1 ? 'end' : 'start' }, env);
      findCommand('seam.corner').run(project, { groupId, entityId, end, kind, partnerEntityId: partnerEdge.id, partnerEnd: row.c === 1 ? 'end' : 'start' }, env);
      report.corners.pair++;
    } catch { report.corners.notCarried++; }
  }
  // v66: the extended seams, once every corner (pairs too) is in place: each edge's extension read off ET's curve, then rebuilt
  report.extensions = { carried: 0, notCarried: 0 };
  for (const item of extensions) {
    try {
      const widths = extensionWidths(project, item.groupId, item.contourIds, item.ring), straight = widths.filter(w => w.straight), basis = (straight.length ? straight : widths).map(w => w.width).sort((a, b) => a - b);
      const base = Math.round(basis[Math.floor(basis.length / 2)] * 100) / 100;
      if (!(base > 0)) throw new Error('扩展缝边的宽度读不出来。');
      findCommand('seam.extension').run(project, { groupId: item.groupId, width: base }, env);
      // a straight edge with another width keeps it to 0.01 mm; a curve differs from ET's own curve by up to about 1 mm and keeps 0.1 mm
      const own = new Map(); for (const w of widths) if (Math.abs(w.width - base) > (w.straight ? .02 : 1)) { const value = w.straight ? Math.round(w.width * 100) / 100 : Math.round(w.width * 10) / 10; own.set(value, [...(own.get(value) || []), w.entityId]); }
      for (const [width, entityIds] of own) findCommand('seam.extensionEdges').run(project, { groupId: item.groupId, entityIds, width }, env);
      item.entry.seam.extension = { widthMm: base, ...(own.size ? { edges: [...own].map(([width, ids]) => ({ widthMm: width, edges: ids.length })) } : {}) };
      report.extensions.carried++;
    } catch (error) { item.entry.seam.extension = { carried: false, reason: error.message }; report.extensions.notCarried++; }
  }
  if (report.extensions.carried) report.notes.push('带入了 ' + report.extensions.carried + ' 片的扩展缝边，按每条边的扩展宽度重新生成。');
  if (report.extensions.notCarried) report.notes.push('有 ' + report.extensions.notCarried + ' 片的扩展缝边没有带入（宽度读不出来或重建不了）。');
  // special records left over belong to edges that are no contour edge of a piece with a rebuilt seam
  for (const rows of special.values()) report.corners.notCarried += rows.length;
  const carried = report.corners.cut + report.corners.step + report.corners.fold + report.corners.mitre + report.corners.special + report.corners.pair;
  if (carried) report.notes.push('带入了 ' + carried + ' 个缝边角处理：' + [['切角', report.corners.cut], ['台阶角', report.corners.step], ['反转角', report.corners.fold], ['折叠角', report.corners.mitre], ['专用角', report.corners.special], ['两片间的角处理', report.corners.pair]].filter(item => item[1]).map(item => item[0] + ' ' + item[1] + ' 个').join('、') + '。');
  if (report.corners.notCarried) report.notes.push('有 ' + report.corners.notCarried + ' 个缝边角处理没有带入（类型还不认识，或者这个转角上重建不了），这些转角按普通转角处理。');
  if (!table) report.notes.push('文件里的转角记录读不出来，所有转角按普通转角处理。');
  const extra = report.pieces.reduce((sum, p) => sum + (p.extraChains || 0), 0); if (extra) report.notes.push('有 ' + extra + ' 组附加轮廓链按内部线带入，它们在 ET 里的含义没有保留。');
  if (report.unknownAttribute) report.notes.push('有 ' + report.unknownAttribute + ' 条线的属性不认识，按普通线带入。');
  // ---- sizes: the size names, the size table and the rules of the points become a grading plan of the drawing
  const grading = report.grading = carryEtGrading({ parsed, project, made, curves, tails, makeId, notchOfNode });
  if (grading.carried) {
    report.notes.push('带入了放码：号型 ' + grading.sizeOrder.join('、') + '（基码 ' + grading.baseSize + '，' + grading.seriesUsed + ' 系列），尺寸表 ' + grading.tableRows + ' 项，' + grading.rules + ' 个点的放码规则'
      + (grading.followers ? '，另有 ' + grading.followers + ' 个跟随点' : '') + '。已建成放码方案“' + grading.planName + '”，各码按 ET 的办法生成：有规则的点按公式移动，同一位置上没有规则的点跟着走，曲线在放码点之间整体转动缩放。'
      + (grading.seriesChanged ? '文件当前用的 ' + grading.inFile.series + ' 系列只有基码，这里按名称最多的 ' + grading.seriesUsed + ' 系列建立。' : '') + (grading.inFile.layers > 1 ? '原文件里存着 ' + grading.inFile.layers + ' 个码的图形，这里只读入基码，其余各码由方案生成。' : ''));
    if (grading.notCarried) report.notes.push('有 ' + grading.notCarried + ' 条放码规则没有带入：' + grading.reasons.join('；') + (grading.unknownNames.length ? '（' + grading.unknownNames.slice(0, 8).join('、') + '）' : '') + '。');
  } else if (grading.inFile.rules || grading.inFile.tableRows || grading.inFile.sizes.length > 1 || grading.inFile.layers > 1) {
    report.notes.push('文件里有放码数据（号型 ' + (grading.inFile.sizes.join('、') || '无') + '，尺寸表 ' + grading.inFile.tableRows + ' 项，' + grading.inFile.rules + ' 个点有规则），没有带入：' + (grading.reasons.join('；') || '没有可用的规则') + (grading.unknownNames.length ? '（' + grading.unknownNames.slice(0, 8).join('、') + '）' : '') + '。');
  } else if (!grading.inFile.readable) report.notes.push('文件里的号型、尺寸表和放码规则没有读懂，没有带入' + (grading.reasons.length ? '（' + grading.reasons.join('；') + '）' : '') + '。');
  // points recorded on a line between its drawn points are ET's grading points on lines (增加放码点): they come with the grading
  if (report.marks.linePoints) {
    const kept = grading.carried ? project.gradingPlans.find(plan => plan.id === grading.planId).anchors.filter(anchor => anchor.between !== undefined).length : 0, all = report.marks.linePoints;
    report.marks.linePointsCarried = Math.min(kept, all);
    report.notes.push('原文件里有 ' + all + ' 个线上的放码点（ET 的“增加放码点”，不是画线时的点）' + (kept >= all ? '，已随放码带入。' : kept ? '，其中 ' + kept + ' 个随放码带入，其余没有带入；它们不影响基码线的形状。' : '，没有带入（' + (grading.carried ? '没有对上线' : grading.inFile.rules || grading.inFile.tableRows ? '这个文件的放码没有带入' : '文件里没有放码规则') + '）；它们不影响基码线的形状。'));
  }
  if (grading.notchRules) report.notes.push('有 ' + grading.notchRules + ' 个刀口自己带着放码规则，也带入了：在每个码里它按规则移动，再落回它所在的边上。');
  if (grading.carried && grading.notchRulesNotCarried) report.notes.push('有 ' + grading.notchRulesNotCarried + ' 个刀口上的放码规则没有带入（刀口本身没有带入，或者规则读不懂）；这些刀口在每个码里按它在边上的位置重新放。');
  report.notes.push('原文件没有改动。');
  validateProject(project);
  report.totals = { entities: project.entities.length, pieces: project.groups.length, seams: project.seamAllowances.length, lengthCheckedMm: +project.entities.filter(e => e.type !== 'text' && !e.derivedFrom).reduce((sum, e) => sum + entityLength(e), 0).toFixed(3) };
  return { project, report };
}

/**
 * Write the converted project as a complete ET PRJ and compare the seam lines that file would hold with
 * the seam lines of the original, piece by piece. Adds the result to the report; changes nothing else.
 * Cut, stepped and fold-back seam corners are carried over; other corner treatments of ET are not, so pieces
 * with such corners differ there.
 */
export function checkRewrite(input, parsed, project, report, { createExport, parse }) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let written;
  try { written = createExport(project); } catch (error) { report.rewrite = { possible: false, reason: error.message }; return report; }
  const again = parse(written.bytes, 'rewritten.prj'), seamLines = (data, source, group) => {
    const byId = new Map(source.entities.map(e => [e.id, e]));
    return group.entityIds.map(id => byId.get(id)).filter(e => e && e.type !== 'text' && e.source?.recordKind && curveTail(data, e.source.offset).flags[2] === 2).map(e => e.points.map(scale));
  };
  let within = 0, largest = 0, compared = 0;
  report.pieces.forEach((entry, index) => {
    const original = parsed.groups[entry.sourceIndex], rewritten = again.groups[index]; if (!original || !rewritten || !entry.seam) return;
    const theirs = seamLines(bytes, parsed, original), ours = seamLines(written.bytes, again, rewritten);
    if (!theirs.length || !ours.length || !entry.seam.rebuilt) return;
    const difference = Math.max(farthest(theirs, ours), farthest(ours, theirs)); entry.seam.writtenVsOriginalMm = +difference.toFixed(3);
    compared++; largest = Math.max(largest, difference); if (difference <= 1) within++;
  });
  report.rewrite = { possible: true, bytes: written.bytes.length, seamPiecesCompared: compared, seamPiecesWithin1Mm: within, seamLargestDifferenceMm: +largest.toFixed(3) };
  return report;
}
