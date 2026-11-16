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
import { readPrjCurve } from './prj-curves.mjs';
import { refreshCurve } from './curves.mjs';
import { fitClampedSpline, nativeFitPoints } from './fit-spline.mjs';
import { validateProject, length as entityLength } from './geometry.mjs';
import { findCommand } from './cad-command-set.mjs';
import { moveEnd } from './construct-edit.mjs';
import { applyNotches } from './notches.mjs';
import { seamWidthAt } from './seam-widths.mjs';

export const EDITABLE_SOURCE_FORMAT = 'ET PRJ experimental';
const MM = 10; // millimetres per file unit
const HEAL_LIMIT = 1; // mm: ends of neighbouring contour edges this close are brought together, as ET treats them as joined
const scale = p => ({ x: p.x * MM, y: p.y * MM });

/** What an ET curve record holds after its geometry: reference lists, the seam width of a contour edge, attachments. */
export function curveTail(bytes, offset) {
  const record = readPrjCurve(bytes, offset); if (!record) throw new Error('曲线记录无法读取。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u32 = o => view.getUint32(o, true), f32 = o => view.getFloat32(o, true);
  const flags = Array.from(bytes.subarray(offset + 7, offset + 10)); let o = record.geometryEnd;
  const need = n => { if (o + n > bytes.length) throw new Error('曲线记录被截断。'); };
  if (record.kind === 4) { need(4); const count = u32(o); o += 4; if (count > 10000) throw new Error('曲线显示表长度异常。'); need(count * 4); o += count * 4; }
  const list = () => { need(4); const count = u32(o); o += 4; if (count > 1000) throw new Error('曲线引用表长度异常。'); need(count * 4); const ids = []; for (let i = 0; i < count; i++) { ids.push(u32(o)); o += 4; } return ids; };
  const direct = list(), secondary = list(), links = list(); need(4); const width = f32(o); o += 4;
  let width2 = null; if (flags[1] & 0x10) { need(4); width2 = f32(o); o += 4; }
  // Bit 0x40 marks a record with a different ending (seen on notch marks); its seam width is not meaningful.
  const special = Boolean(flags[0] & 0x40); let attribute = 0;
  if (!special) { need(4); const attached = u32(o); o += 4; if (attached > 1000) throw new Error('曲线附着表长度异常。'); need(attached * 8 + 6); o += attached * 8; attribute = u32(o); }
  // attribute: ET's element attribute word; 0 for an ordinary line, set for auxiliary lines and the like
  return { flags, kind: record.kind, direct, secondary, links, width, width2, special, attribute };
}

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
 * treated corners. Fields: type, curve (1-based index into the curve table), a, b, c and, for types 6 and 8, two sizes
 * in file units. Type 6 is a cut corner between `curve` (end a) and curve b (end c); type 8 a stepped hem corner at end a
 * of the side `curve`; type 1 a fold-back of the hem `curve` at its start (a = 0) and/or end (c = 1).
 * The table is the last thing in the file, so it is found from the end: objects between the texts and the table, which
 * this reader does not know, need not be understood. Returns null when no table can be read.
 */
export function cornerTable(bytes, textEnd) {
  if (!Number.isInteger(textEnd) || textEnd < 0 || textEnd > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let last = bytes.length; while (last > 0 && bytes[last - 1] === 0) last--;
  const read = start => {
    let o = start; const count = view.getUint32(o, true), rows = []; o += 4; if (count > 20000) return null;
    for (let i = 0; i < count; i++) {
      if (o + 24 > bytes.length || view.getUint32(o, true) !== 0 || bytes[o + 4] !== 255 || bytes[o + 5] !== 255 || bytes[o + 6] !== 255) return null;
      const type = bytes[o + 7], row = { type, curve: view.getUint32(o + 8, true), a: view.getInt32(o + 12, true), b: view.getUint32(o + 16, true), c: view.getInt32(o + 20, true) }; o += 24;
      if (type === 6 || type === 8) { if (o + 8 > bytes.length) return null; row.sizes = [view.getFloat32(o, true), view.getFloat32(o + 4, true)]; o += 8; } else if (type > 5) return null;
      rows.push(row);
    }
    return { rows, end: o };
  };
  for (let o = textEnd; o + 4 <= bytes.length; o++) { const table = read(o); if (table && table.end >= last && table.end <= last + 4 && (table.rows.length || o + 4 >= last)) return { offset: o, rows: table.rows }; }
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

export function convertPrjToEditable(input, parsed, { makeId = () => crypto.randomUUID() } = {}) {
  if (parsed?.metadata?.format !== EDITABLE_SOURCE_FORMAT) throw new Error('目前只能把 ET 2.0（08 版）布局的 PRJ 转成可编辑工程；其他布局的文件请先在 ET 里另存为 08 版。');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input), env = { makeId };
  const curves = parsed.entities.filter(e => e.type !== 'text' && [2, 4].includes(e.source?.recordKind)).sort((a, b) => a.source.offset - b.source.offset);
  const tails = new Map(curves.map(e => [e.id, curveTail(bytes, e.source.offset)]));
  const project = { format: 'zhiyi-cad', version: 6, name: parsed.name || '未命名纸样', units: 'mm', entities: [], groups: [], seamAllowances: [],
    metadata: { importedFrom: { format: 'ET PRJ 2.0', file: String(parsed.metadata.sourceFile || ''), style: String(parsed.metadata.style || ''), baseSize: String(parsed.metadata.baseSize || ''), scale: '1 cm = 10 mm' } } };
  const report = { sourceFile: project.metadata.importedFrom.file, fileUnit: 'cm', scale: '1 cm = 10 mm', curves: { total: curves.length, lines: 0, splines: 0, refittedMaxDifferenceMm: 0 },
    seamLinesNotCopied: 0, notchMarksDropped: 0, unknownAttribute: 0, pieces: [], piecesFailed: [], looseCurves: 0, looseTexts: 0, texts: 0, notes: [] };
  const made = new Map(); let serial = 0;
  const attribute = e => tails.get(e.id).flags[2];
  // treated seam corners, by the contour edge their record names
  const table = cornerTable(bytes, parsed.metadata.textSectionEndOffset), special = new Map();
  const everyCurve = parsed.entities.filter(e => e.type !== 'text' && e.source?.recordKind).sort((a, b) => a.source.offset - b.source.offset);
  report.corners = { readable: Boolean(table), records: table ? table.rows.length : 0, cut: 0, step: 0, fold: 0, notCarried: 0 };
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

  /** ET accepts a contour whose edges miss each other by a fraction of a millimetre. Here both ends go to the point half-way between them. */
  function closeContour(edges) {
    const ends = e => [e.points[0], e.points.at(-1)], gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y); let count = 0, largest = 0;
    if (edges.length < 2) return { count, largest };
    for (let i = 0; i < edges.length; i++) {
      const a = edges[i], b = edges[(i + 1) % edges.length]; let best = null;
      for (const [ia, pa] of ends(a).entries()) for (const [ib, pb] of ends(b).entries()) { const d = gap(pa, pb); if (!best || d < best.d) best = { d, ia, ib, pa, pb }; }
      if (best.d <= 1e-6) continue;
      const fixed = edge => edge.curve && !nativeFitPoints(edge.curve); if (fixed(a) && fixed(b) && best.d <= .05) continue; // within the tolerance of a closed contour; nothing to move
      if (best.d > HEAL_LIMIT) throw new Error('轮廓没有闭合：相邻两条边的端点相距 ' + best.d.toFixed(3) + ' mm，超过 ' + HEAL_LIMIT + ' mm。');
      // A curve whose end cannot be moved (its points repeat at the end) stays; then the neighbour comes all the way to it.
      const movable = edge => !edge.curve || Boolean(nativeFitPoints(edge.curve)), put = (edge, index, to) => { const moved = moveEnd(edge, index === 0 ? 'start' : 'end', to); if (moved.curve) { edge.curve = moved.curve; refreshCurve(edge); } else edge.points = moved.points; };
      if (movable(a) && movable(b)) { const middle = { x: (best.pa.x + best.pb.x) / 2, y: (best.pa.y + best.pb.y) / 2 }; put(a, best.ia, middle); put(b, best.ib, middle); }
      else if (movable(a)) put(a, best.ia, best.pb); else if (movable(b)) put(b, best.ib, best.pa);
      else throw new Error('轮廓没有闭合：相邻两条曲线的端点相距 ' + best.d.toFixed(3) + ' mm，而这两条曲线的端点都不能移动。');
      count++; largest = Math.max(largest, best.d);
    }
    return { count, largest };
  }
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
      piece.source = { kind: 'et-import' }; piece.attributes = { symmetric: group.source?.symmetry === '对称', material: String(group.source?.material || ''), size: String(group.source?.size || '') };
      if (grainSource?.arrowStart) { const line = project.entities.find(e => e.id === piece.entityIds.at(-1)); if (line?.layer === 'grain') line.arrowStart = true; }
      for (const id of group.entityIds) owned.add(id);
      Object.assign(entry, { contourEdges: contour.length, internalLines: members.filter(e => e.type !== 'text').length, texts: members.filter(e => e.type === 'text').length, extraChains: (group.contours || []).length - 1 });
      // seam allowance from the width ET stores on every contour edge
      const widths = primary.entityIds.map(id => Math.round(tails.get(id).width * MM * 1e4) / 1e4);
      const tapered = primary.entityIds.filter(id => { const t = tails.get(id); return t.width2 !== null && Math.abs(t.width2 - t.width) > 1e-4; }).length;
      const etSeams = group.entityIds.map(id => byId.get(id)).filter(e => e && tails.has(e.id) && attribute(e) === 2).map(e => e.points.map(scale));
      if (widths.some(w => !(w >= 0 && w <= 300))) entry.seam = { rebuilt: false, reason: '轮廓边上的缝份宽度不是有效数值。', etSeamLines: etSeams.length };
      else if (tapered) entry.seam = { widthsMm: [...new Set(widths)].sort((a, b) => a - b), rebuilt: false, reason: '有 ' + tapered + ' 条边的缝份两端宽度不同（渐变缝边），还不能重建。', etSeamLines: etSeams.length };
      else if (widths.some(w => w > 0)) {
        const counts = new Map(); for (const w of widths.filter(x => x > 0)) counts.set(w, (counts.get(w) || 0) + 1);
        const usual = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        // the corner treatments ET keeps for this contour: cut (6), stepped (8) and fold-back (1) corners
        const corners = [], kinds = { cut: 0, step: 0, fold: 0 }; let unknown = 0;
        primary.entityIds.forEach((id, i) => { for (const row of special.get(id) || []) {
          const entityId = contour[i].id, sizes = row.sizes ? row.sizes.map(value => Math.round(value * MM * 1e4) / 1e4) : null, end = row.a === 1 ? 'end' : 'start';
          if (row.type === 6 && (row.a === 0 || row.a === 1) && sizes.every(value => value > 0)) { corners.push({ entityId, end, kind: 'cut', first: sizes[0], second: sizes[1] }); kinds.cut++; }
          else if (row.type === 8 && (row.a === 0 || row.a === 1) && sizes.every(value => value > 0)) { corners.push({ entityId, end, kind: 'step', drop: sizes[0], run: sizes[1] }); kinds.step++; }
          else if (row.type === 1 && (row.a === 0 || row.c === 1)) { if (row.a === 0) { corners.push({ entityId, end: 'start', kind: 'fold' }); kinds.fold++; } if (row.c === 1) { corners.push({ entityId, end: 'end', kind: 'fold' }); kinds.fold++; } }
          else unknown++;
        } special.delete(id); });
        const seamParameters = { groupId: piece.id, width: usual, overrides: contour.map((e, i) => ({ entityId: e.id, width: widths[i] })).filter(o => o.width !== usual) };
        let cornerNote = null;
        // tried on a copy first: a corner that cannot be built must not leave a half-made seam behind
        if (corners.length) try { findCommand('seam.apply').run(JSON.parse(JSON.stringify(project)), { ...seamParameters, corners }, env); } catch (error) { cornerNote = error.message; unknown += corners.length; corners.length = 0; kinds.cut = kinds.step = kinds.fold = 0; }
        try {
          const applied = findCommand('seam.apply').run(project, { ...seamParameters, ...(corners.length ? { corners } : {}) }, env);
          const recipe = project.seamAllowances.find(r => r.id === applied.created), ours = recipe.outputIds.map(id => project.entities.find(e => e.id === id)).map(e => e.closed ? [...e.points, e.points[0]] : e.points);
          entry.seam = { widthsMm: [...new Set(widths)].sort((a, b) => a - b), rebuilt: true, etSeamLines: etSeams.length,
            ...(corners.length ? { corners: { ...kinds } } : {}), ...(unknown ? { cornersNotCarried: unknown, ...(cornerNote ? { cornerReason: cornerNote } : {}) } : {}),
            ...(etSeams.length ? { etLinesFromRebuiltMm: +farthest(etSeams, ours).toFixed(3), rebuiltFromEtLinesMm: +farthest(ours, etSeams).toFixed(3) } : {}) };
          report.corners.cut += kinds.cut; report.corners.step += kinds.step; report.corners.fold += kinds.fold; report.corners.notCarried += unknown;
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
      notch.name = '刀口 ' + (++report.notches.carried); notch.et = { mode: item.mode, ...(item.mode === 1 && line && line.id !== base.id ? { referenceEntityId: line.id } : {}) };
      if (item.formula) { report.notches.bySizeName = (report.notches.bySizeName || 0) + 1; (report.notches.sizeNames ??= []).push(item.formula); }
    } catch (error) { report.notches.notCarried++; if (report.notches.reasons.length < 5 && !report.notches.reasons.includes(error.message)) report.notches.reasons.push(error.message); }
  }
  // what belongs to no piece stays as loose lines and texts
  for (const e of parsed.entities) { if (owned.has(e.id) || !made.has(e.id)) continue; if (e.type === 'text') report.looseTexts++; else report.looseCurves++; }
  for (const failed of report.piecesFailed) report.notes.push('裁片“' + failed.name + '”没有建成裁片，它的线条作为独立线条保留：' + failed.reason);
  if (report.notches.carried) report.notes.push('带入了 ' + report.notches.carried + ' 个刀口，位置和方向与原文件相同。');
  if (report.notches.bySizeName) report.notes.push('其中 ' + report.notches.bySizeName + ' 个刀口的位置在 ET 里是按尺寸表里的尺寸定的（' + [...new Set(report.notches.sizeNames)].join('、') + '），带入后位置不变，但不再跟着尺寸表变。');
  if (report.notches.notCarried) report.notes.push('有 ' + report.notches.notCarried + ' 个刀口没有带入：' + report.notches.reasons.join('；') + '。');
  if (report.notches.otherKinds) report.notes.push('有 ' + report.notches.otherKinds + ' 个刀口的记录是还不认识的种类，没有带入。');
  if (report.edgeLinesCarried) report.notes.push('有 ' + report.edgeLinesCarried + ' 条沿边的虚线（明线、折边线一类）按普通虚线带入：位置不变，但在 ET 里不再跟着那条边变。');
  if (report.seamLinesNotCopied) report.notes.push('ET 的 ' + report.seamLinesNotCopied + ' 条缝边线没有照抄，缝份按每条轮廓边上记录的宽度和转角的角处理重新生成。');
  // special records left over belong to edges that are no contour edge of a piece with a rebuilt seam
  for (const rows of special.values()) report.corners.notCarried += rows.length;
  const carried = report.corners.cut + report.corners.step + report.corners.fold;
  if (carried) report.notes.push('带入了 ' + carried + ' 个缝边角处理：' + [['切角', report.corners.cut], ['台阶角', report.corners.step], ['反转角', report.corners.fold]].filter(item => item[1]).map(item => item[0] + ' ' + item[1] + ' 个').join('、') + '。');
  if (report.corners.notCarried) report.notes.push('有 ' + report.corners.notCarried + ' 个缝边角处理没有带入（类型还不认识，或者这个转角上重建不了），这些转角按普通转角处理。');
  if (!table) report.notes.push('文件里的转角记录读不出来，所有转角按普通转角处理。');
  const extra = report.pieces.reduce((sum, p) => sum + (p.extraChains || 0), 0); if (extra) report.notes.push('有 ' + extra + ' 组附加轮廓链按内部线带入，它们在 ET 里的含义没有保留。');
  if (report.unknownAttribute) report.notes.push('有 ' + report.unknownAttribute + ' 条线的属性不认识，按普通线带入。');
  report.notes.push('放码规则、多尺码和布料等裁片属性之外的信息没有带入；原文件没有改动。');
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
