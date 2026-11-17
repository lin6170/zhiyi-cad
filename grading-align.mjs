/**
 * ET 2017's alignment tools of grading mode (v68), as ET's own saves showed them:
 *   - 对齐: every size of a piece is moved so that one point of it lies where the base size has it; or only its height (ET with
 *     Shift), or only its left-right place (ET with Ctrl). Loose lines and other pieces stay.
 *   - 线对齐: every size of a piece is turned and moved so that one of its straight lines lies on the base size's line. The point of
 *     the size's line that goes onto the chosen place is the one at the same distance from the nearer end of the line (from the
 *     start when the place is just in the middle); the line takes the base line's direction.
 *   - 保留: the move is written into the rules of the corners of the piece's outline (both ends of every outline line, corners
 *     without a rule too), so that the sizes come out aligned; the aligned corner is left without a rule. ET leaves a rule on the
 *     middle of a curve, a grading point on a line and the points of inner lines as they were, and so does this.
 *   - 点对齐移动点规则 / 线对齐移动点规则: the rule of a point is set so that, with the sizes aligned, it moves by given amounts (per
 *     size step, along the base's x and y). With 保留 the alignment is written into the rules first and the amounts become the rule.
 * Moves that do not follow from the size table (a turn, an alignment) are written the way ET writes them: as rows of the size table
 * named MS…ID… with one number for every size, or as a plain number when the move is the same for every size step.
 */
import { generateGradedSize } from './grading.mjs';
import { stationsOf, TABLE_UNIT_MM, ALIGN_AXES, normalizeAlignment } from './grading-table.mjs';
export { ALIGN_AXES, normalizeAlignment };

const REACH_MM = .5, SAME_MM = .05, ZERO_CM = 5e-6;
const sub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y }), add = (p, q) => ({ x: p.x + q.x, y: p.y + q.y }), mul = (p, k) => ({ x: p.x * k, y: p.y * k });
const length = d => Math.hypot(d.x, d.y), unit = d => { const l = length(d); if (l < 1e-12) throw new Error('这条线太短，不能用来对齐。'); return mul(d, 1 / l); };
const clone = value => JSON.parse(JSON.stringify(value));

/** The piece (a group with an outline) a line belongs to, or null. */
export function pieceOfEntity(project, entityId) { return (project.groups || []).find(group => (group.contours || []).length && group.entityIds.includes(entityId)) || null; }
/** What moves with a piece in a size: its own lines and texts, its seam lines, its notches. */
export function pieceEntityIds(project, piece) {
  const ids = new Set(piece.entityIds);
  for (const recipe of project.seamAllowances || []) if (recipe.baseEntityIds.some(id => ids.has(id))) for (const id of recipe.outputIds || []) ids.add(id);
  for (const recipe of project.notches || []) if (ids.has(recipe.baseEntityId)) for (const id of recipe.outputIds || []) ids.add(id);
  return ids;
}
// the straight parts of a line or polyline in order; a closed polyline also the part from its last point back to its first
function segmentsOf(entity) {
  const pts = entity.points, out = []; for (let i = 0; i + 1 < pts.length; i++) out.push({ index: i, ends: [pts[i], pts[i + 1]] });
  if (entity.closed && pts.length > 2 && Math.hypot(pts[0].x - pts.at(-1).x, pts[0].y - pts.at(-1).y) > 1e-9) out.push({ index: pts.length - 1, ends: [pts.at(-1), pts[0]] });
  return out;
}
const segmentEnds = (entity, index = 0) => { const pts = entity.points; return [pts[index], pts[(index + 1) % pts.length]]; };
const stationPoints = entity => { const stations = stationsOf(entity); if (!stations) throw new Error('文字不能用来对齐。'); return stations.points; };
const nearestStation = (entity, at) => { let best = -1, nearest = REACH_MM; stationPoints(entity).forEach((p, i) => { const d = Math.hypot(p.x - at.x, p.y - at.y); if (d <= nearest) { nearest = d; best = i; } }); return best; };

/** Checks an alignment ({ mode: 'point' | 'line', entityId, at, axis }) against the drawing and says where it stands. */
export function alignmentPlace(project, alignment) {
  if (!alignment || !['point', 'line'].includes(alignment.mode)) throw new Error('对齐方式只有按点（point）和按线（line）。');
  const entity = project.entities.find(item => item.id === alignment.entityId);
  if (!entity || entity.type === 'text' || entity.derivedFrom || entity.notchFrom) throw new Error('对齐要选纸样自己的线（不是文字、缝份线或刀口）。');
  const piece = pieceOfEntity(project, entity.id); if (!piece) throw new Error('对齐只对裁片：“' + (entity.name || '这条线') + '”不在裁片上。');
  const at = alignment.at; if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new Error('对齐的位置无效。');
  if (alignment.mode === 'point') {
    const index = nearestStation(entity, at); if (index < 0) throw new Error('对齐点要是“' + (entity.name || '这条线') + '”的端点或曲线经过的点（离它 ' + REACH_MM + ' mm 以内）。');
    const axis = alignment.axis || 'both'; if (!ALIGN_AXES.includes(axis)) throw new Error('对齐的方向只有 both、x、y。');
    return { mode: 'point', piece, entity, index, point: stationPoints(entity)[index], axis };
  }
  if (entity.curve) throw new Error('线对齐要选裁片上的一条直线（或折线上直的一段），不能是曲线。');
  // a line, or the straight part of a polyline nearest to the place (a rectangle drawn in the page is one closed polyline)
  let best = null;
  for (const segment of segmentsOf(entity)) {
    const [a, b] = segment.ends, d = sub(b, a), total = length(d); if (total < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((at.x - a.x) * d.x + (at.y - a.y) * d.y) / (total * total))), place = add(a, mul(d, t)), off = Math.hypot(at.x - place.x, at.y - place.y);
    if (!best || off < best.off) best = { segment: segment.index, t, total, place, off };
  }
  if (!best || best.off > REACH_MM) throw new Error('线对齐的位置要在“' + (entity.name || '这条线') + '”上（离它 ' + REACH_MM + ' mm 以内）。');
  const from = best.t <= .5 ? 'start' : 'end';
  return { mode: 'line', piece, entity, segment: best.segment, point: best.place, from, distance: from === 'start' ? best.t * best.total : (1 - best.t) * best.total };
}

/** One size's transform: x' = a·x + c·y + e, y' = b·x + d·y + f (ET's piece transform: m00 a, m01 b, m10 c, m11 d, translation e, f). */
export function sizeAlignment(place, sized) {
  if (place.mode === 'point') {
    const q = stationPoints(sized)[place.index]; let e = place.point.x - q.x, f = place.point.y - q.y;
    if (place.axis === 'x') f = 0; else if (place.axis === 'y') e = 0;
    return { a: 1, b: 0, c: 0, d: 1, e, f };
  }
  const [a0, b0] = segmentEnds(place.entity, place.segment), [as, bs] = segmentEnds(sized, place.segment);
  const turn = Math.atan2(b0.y - a0.y, b0.x - a0.x) - Math.atan2(bs.y - as.y, bs.x - as.x), cos = Math.cos(turn), sin = Math.sin(turn);
  const there = place.from === 'start' ? add(as, mul(unit(sub(bs, as)), place.distance)) : add(bs, mul(unit(sub(as, bs)), place.distance));
  return { a: cos, b: sin, c: -sin, d: cos, e: place.point.x - (cos * there.x - sin * there.y), f: place.point.y - (sin * there.x + cos * there.y) };
}
export const transformPoint = (t, p) => ({ x: t.a * p.x + t.c * p.y + t.e, y: t.b * p.x + t.d * p.y + t.f });
export function inverseTransform(t) {
  const det = t.a * t.d - t.b * t.c; if (Math.abs(det) < 1e-12) throw new Error('对齐变换无效');
  const a = t.d / det, b = -t.b / det, c = -t.c / det, d = t.a / det; return { a, b, c, d, e: -(a * t.e + c * t.f), f: -(b * t.e + d * t.f) };
}

/** The transform of every size for an alignment. `results` are the generated sizes ({ size, project }), as evaluateGradingPlan gives them. */
export function alignmentTransforms(project, alignment, results) {
  const place = alignmentPlace(project, alignment), transforms = new Map();
  for (const result of results) {
    if (!result || !result.project) continue; const sized = result.project.entities.find(item => item.id === place.entity.id); if (!sized) continue;
    transforms.set(result.size.id, sizeAlignment(place, sized));
  }
  return { place, transforms, entityIds: pieceEntityIds(project, place.piece) };
}

const sizesOf = plan => plan.sizes.map(size => ({ ...size, k: size.slot - plan.sizeTable.baseSlot }));
const tidy = v => { const text = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, ''); return text === '-0' ? '0' : text; };
/** A formula that moves a point by `values` (centimetres, one per size of the plan in its order): '' for no move, a number for the
 * same move every size step, otherwise a new row of the size table (ET's MS…ID… rows). */
export function numericFormula(value, values, rowsMade = { count: 0 }) {
  const sizes = sizesOf(value);
  if (values.every(v => Math.abs(v) < ZERO_CM)) return '';
  const step = values[0] / sizes[0].k;
  if (sizes.every((size, i) => Math.abs(values[i] - size.k * step) < ZERO_CM)) return tidy(step);
  const rows = value.sizeTable.rows, taken = new Set(rows.map(row => row.name)); let name;
  do { name = 'MS' + rowsMade.count++ + 'ID' + rows.length; } while (taken.has(name));
  const base = value.sizeTable.baseSlot, slope = sizes.reduce((sum, size, i) => sum + values[i] / size.k, 0) / sizes.length, bySlot = new Map(sizes.map((size, i) => [size.slot, values[i]]));
  rows.push({ name, values: Array.from({ length: 50 }, (_, slot) => slot === base ? 0 : bySlot.has(slot) ? bySlot.get(slot) : (slot - base) * slope) });
  return name;
}
// every station of the piece's lines that stands on `at` (a corner is the end of two lines): ET's box takes them all
function stationsAt(project, piece, at) {
  const out = [];
  for (const id of piece.entityIds) {
    const entity = project.entities.find(item => item.id === id); if (!entity || entity.type === 'text' || entity.derivedFrom || entity.notchFrom) continue;
    stationPoints(entity).forEach((p, index) => { if (Math.hypot(p.x - at.x, p.y - at.y) <= SAME_MM) out.push({ entityId: id, index, at: p }); });
  }
  return out;
}
// puts formulas on stations; empty formulas leave the station without a rule (a fixed point), as ET does
// (a corner in the middle of a polyline without a rule would be carried along by the corners around it, so it gets a rule that
// moves it by nothing, ET's fixed point; the end of a line without a rule stays where it is, as in ET's files)
function setRule(value, stations, x, y, project) {
  for (const station of stations) {
    value.anchors = value.anchors.filter(anchor => !(anchor.entityId === station.entityId && anchor.index === station.index));
    const entity = project.entities.find(item => item.id === station.entityId), last = entity ? stationPoints(entity).length - 1 : 0;
    const middle = entity && !entity.curve && station.index > 0 && station.index < last;
    if (x || y || middle) value.anchors.push({ entityId: station.entityId, index: station.index, at: { x: station.at.x, y: station.at.y }, x, y, axisX: [1, 0], axisY: [0, 1] });
  }
}
const generated = (project, value) => value.sizes.map(size => generateGradedSize(project, value, size.id));
const sizedStation = (result, station) => { const sized = result.project.entities.find(item => item.id === station.entityId); if (!sized) throw new Error('有一个尺码里缺少这条线'); return stationPoints(sized)[station.index]; };

/** 保留: writes an alignment into the rules of the corners of the piece's outline. Returns the changed plan value and what changed. */
export function bakeAlignment(project, plan, alignment, rowsMade = { count: 0 }) {
  const value = clone(plan), results = generated(project, value), { place, transforms } = alignmentTransforms(project, alignment, results);
  const outline = (place.piece.contours.find(contour => contour.role === 'primary-contour') || place.piece.contours[0]).entityIds;
  const corners = [];
  for (const id of outline) {
    const entity = project.entities.find(item => item.id === id); if (!entity) continue; const points = stationPoints(entity);
    // the ends of a line or curve; every corner of a polyline (ET's outlines are separate lines, so there these are the same)
    for (const index of entity.curve ? [0, points.length - 1] : points.map((_, i) => i)) if (!corners.some(corner => corner.entityId === id && corner.index === index)) corners.push({ entityId: id, index, at: points[index] });
  }
  let fixed = 0, changed = 0;
  for (const corner of corners) {
    const moves = results.map(result => { const moved = transformPoint(transforms.get(result.size.id), sizedStation(result, corner)); return { dx: (moved.x - corner.at.x) / TABLE_UNIT_MM, dy: (moved.y - corner.at.y) / TABLE_UNIT_MM }; });
    const x = numericFormula(value, moves.map(m => m.dx), rowsMade), y = numericFormula(value, moves.map(m => m.dy), rowsMade);
    setRule(value, [corner], x, y, project); if (x || y) changed++; else fixed++;
  }
  delete value.alignment;
  return { value, place, corners: corners.length, changed, fixed };
}

/** ET's 点对齐移动点规则 / 线对齐移动点规则. `target` is a place ({ x, y }) of a point of the same piece; `amounts` is { x, y } in
 * centimetres for every size step, or { perSize: [{ sizeId, x, y }] } (centimetres away from the base size). A direction left out
 * (undefined) keeps the target's present movement in the aligned view, so that only the direction given changes; 0 means it stands
 * still there. The target's rule is replaced: in each size the target goes to its place in the aligned view, taken back to that size. */
export function alignedMove(project, plan, alignment, target, amounts, keep = false) {
  alignment = { ...alignment, axis: 'both' };   // ET's 点对齐移动点规则 aligns on the whole point (no Shift or Ctrl there)
  const place = alignmentPlace(project, alignment), stations = stationsAt(project, place.piece, target);
  if (!stations.length) throw new Error('目标点要是“' + (place.piece.name || '这片') + '”上一条线的端点或曲线经过的点（离它 ' + SAME_MM + ' mm 以内）。');
  const given = v => v === undefined || v === null || v === '' ? undefined : Number(v), sizes = sizesOf(plan), wanted = amounts.perSize
    ? sizes.map(size => { const item = amounts.perSize.find(entry => entry.sizeId === size.id); if (!item) throw new Error('缺少尺码“' + size.label + '”的移动量'); return { x: given(item.x), y: given(item.y) }; })
    : sizes.map(size => ({ x: given(amounts.x) === undefined ? undefined : given(amounts.x) * size.k, y: given(amounts.y) === undefined ? undefined : given(amounts.y) * size.k }));
  if (wanted.every(w => w.x === undefined && w.y === undefined)) throw new Error('请给出横向或纵向的移动量。');
  if (wanted.some(w => [w.x, w.y].some(v => v !== undefined && !Number.isFinite(v)))) throw new Error('移动量要是数。');
  // where the target is now in every size, seen aligned
  const results = generated(project, plan), { transforms } = alignmentTransforms(project, alignment, results), p = stations[0].at;
  const goals = results.map((result, i) => { const now = transformPoint(transforms.get(result.size.id), sizedStation(result, stations[0])), w = wanted[i];
    return { x: w.x === undefined ? now.x : p.x + w.x * TABLE_UNIT_MM, y: w.y === undefined ? now.y : p.y + w.y * TABLE_UNIT_MM }; });
  const rowsMade = { count: 0 };
  if (keep) {   // 保留: the aligned view becomes the sizes themselves; the target's rule is its place in that view (typed numbers as written, as ET writes them)
    const baked = bakeAlignment(project, plan, alignment, rowsMade), value = baked.value, typed = key => !amounts.perSize && given(amounts[key]) !== undefined;
    const axis = key => typed(key) ? (given(amounts[key]) ? tidy(given(amounts[key])) : '') : numericFormula(value, goals.map(g => (g[key] - p[key]) / TABLE_UNIT_MM), rowsMade);
    const x = axis('x'), y = axis('y');
    setRule(value, stations, x, y, project);
    return { value, place, stations: stations.length, baked: baked.changed + baked.fixed, x, y };
  }
  const value = clone(plan);
  const moves = results.map((result, i) => { const back = inverseTransform(transforms.get(result.size.id)), q = transformPoint(back, goals[i]); return { dx: (q.x - p.x) / TABLE_UNIT_MM, dy: (q.y - p.y) / TABLE_UNIT_MM }; });
  const x = numericFormula(value, moves.map(m => m.dx), rowsMade), y = numericFormula(value, moves.map(m => m.dy), rowsMade);
  setRule(value, stations, x, y, project);
  return { value, place, stations: stations.length, baked: 0, x, y };
}
