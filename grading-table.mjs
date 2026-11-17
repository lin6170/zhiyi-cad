/**
 * Grading by a size table, the way ET does it.
 *
 * A plan of this kind (method "table") holds
 *   sizeTable  the size names of ET's five series by position (position 9 is the base size), the series in use, and the rows
 *              of the size table: a name and one number per position, in centimetres, as ET keeps them;
 *   anchors    the points of lines and curves that grading knows about. An anchor names a line or curve and a place on it:
 *              one of its stations (`index`: an end of a line, one of the points a curve passes through), or a point on it
 *              between two stations (`between` the station before it, `at` the place; ET's 线上的放码点). It either carries
 *              two formulas over the names of the size table and the two axes they act along, or it is plain (a point a
 *              curve is divided at that has no rule of its own).
 * and its sizes name a position each.
 *
 * How a size is made (established against ET 2017's own expansion of a probe drawing and of a real multi-size pattern):
 *   - a point with formulas moves, along its axes, by the value of each formula with every name standing for the difference of
 *     that row between the size and the base size; a formula of numbers only is a step per size;
 *   - a point without a rule stays, unless it lies on a point that moves: then it moves with it (ET writes such followers into
 *     the file when it expands the sizes);
 *   - a line follows its two ends; a curve is divided at its anchors, and each part is turned and scaled as a whole so that
 *     its two ends land on their new places. The curve is then drawn through the moved points by ET's own rule.
 */
import { parseFormula, formulaNames, evaluateFormula } from './size-formula.mjs';
import { fitClampedSpline, nativeFitPoints } from './fit-spline.mjs';
import { refreshCurve } from './curves.mjs';

export const TABLE_UNIT_MM = 10;          // the size table and the formulas are in centimetres
const THIN_MM = 1;                        // points of a graded curve closer than this are thinned, as ET does
export const FOLLOW_TOLERANCE_MM = .05;   // ET made followers of points up to 0.03 mm from the point they follow
const SLOTS = 50, SERIES = 5, OPERATORS = '+-*/()';
const finite = v => typeof v === 'number' && Number.isFinite(v);

/** The stations of a line or curve: where an anchor can sit. Null for what cannot be graded this way (a text). */
export function stationsOf(entity) {
  if (!entity || entity.type === 'text') return null;
  if (!entity.curve) return { points: entity.points.map(p => ({ x: p.x, y: p.y })), fitted: false, curve: false };
  const fit = nativeFitPoints(entity.curve);
  if (fit) return { points: fit.map(p => ({ x: p.x, y: p.y })), fitted: true, curve: true };
  // a curve that was not drawn through points: it can only be moved as a whole between its two ends
  const controls = entity.curve.controlPoints; return { points: [{ x: controls[0].x, y: controls[0].y }, { x: controls.at(-1).x, y: controls.at(-1).y }], fitted: false, curve: true };
}

/** Checks and tidies the table part of a plan. `sources` and `sizes` are the already checked lists of the plan. */
export function normalizeTablePlan(value, sources, sizes) {
  const t = value.sizeTable;
  if (!t || !Array.isArray(t.series) || t.series.length !== SERIES || !Number.isInteger(t.activeSeries) || t.activeSeries < 0 || t.activeSeries >= SERIES || !Number.isInteger(t.baseSlot) || t.baseSlot < 0 || t.baseSlot >= SLOTS || !Array.isArray(t.rows) || t.rows.length > 500) throw new Error('尺寸表方案的号型或尺寸表结构无效');
  const series = t.series.map(list => {
    if (!Array.isArray(list) || list.length > SLOTS) throw new Error('号型名称结构无效'); const used = new Set();
    return list.map(item => { if (!item || !Number.isInteger(item.slot) || item.slot < 0 || item.slot >= SLOTS || used.has(item.slot) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 50) throw new Error('号型名称无效'); used.add(item.slot); return { slot: item.slot, name: item.name.trim() }; }).sort((a, b) => a.slot - b.slot);
  });
  const names = new Set(), rows = t.rows.map(row => {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (!name || name.length > 50 || names.has(name) || [...name].some(c => OPERATORS.includes(c) || c === ' ') || (name[0] >= '0' && name[0] <= '9') || name[0] === '.') throw new Error('尺寸表里的名称“' + name + '”不能用：名称不能重复，不能以数字开头，不能带运算符号');
    if (!Array.isArray(row.values) || row.values.length !== SLOTS || row.values.some(v => !finite(v) || Math.abs(v) > 1e6)) throw new Error('尺寸表“' + name + '”的数值无效');
    names.add(name); return { name, values: [...row.values] };
  });
  const slots = new Set([t.baseSlot]);
  for (const size of sizes) { const given = value.sizes.find(s => s.id === size.id); if (!given || !Number.isInteger(given.slot) || given.slot < 0 || given.slot >= SLOTS || slots.has(given.slot)) throw new Error('尺码“' + size.label + '”在号型表里的位置无效'); slots.add(given.slot); size.slot = given.slot; }
  if (!Array.isArray(value.anchors) || value.anchors.length > 20000) throw new Error('放码点数量超出范围');
  const byId = new Map(sources.map(source => [source.entityId, source])), seen = new Set();
  const anchors = value.anchors.map(anchor => {
    const source = byId.get(anchor?.entityId), onLine = anchor?.between !== undefined, place = onLine ? anchor.between : anchor?.index;
    if (!source || source.kind === 'text' || !Number.isInteger(place) || place < 0 || place > 100000) throw new Error('放码点所在的线不在方案里，或者序号无效');
    const where = onLine ? { between: place, at: { x: anchor.at?.x, y: anchor.at?.y } } : { index: place };
    if (onLine && (!finite(where.at.x) || !finite(where.at.y) || Math.abs(where.at.x) > 1e8 || Math.abs(where.at.y) > 1e8)) throw new Error('线上的放码点位置无效');
    // two grading points on the same place of a line are possible when their rules differ (ET keeps both)
    const key = anchor.entityId + '#' + JSON.stringify(where) + (onLine && anchor.plain !== true ? '|' + String(anchor.x ?? '').trim() + '|' + String(anchor.y ?? '').trim() : ''); if (seen.has(key)) throw new Error('放码点重复'); seen.add(key);
    // What the plan remembers of the drawing, so that a rule is found again after its line was changed (reconcileTablePlan in
    // grading.mjs): where a station stood, and how many stations its line had.
    if (!onLine && anchor.at && finite(anchor.at.x) && finite(anchor.at.y) && Math.abs(anchor.at.x) <= 1e8 && Math.abs(anchor.at.y) <= 1e8) where.at = { x: anchor.at.x, y: anchor.at.y };
    if (Number.isInteger(anchor.stations) && anchor.stations >= 2 && anchor.stations <= 100001) where.stations = anchor.stations;
    if (anchor.plain === true) return { entityId: anchor.entityId, ...where, plain: true };
    const out = { entityId: anchor.entityId, ...where, x: String(anchor.x ?? '').trim(), y: String(anchor.y ?? '').trim() };
    for (const key of ['x', 'y']) { if (out[key].length > 300) throw new Error('公式太长'); let tree; try { tree = parseFormula(out[key]); } catch (error) { throw new Error('公式“' + out[key] + '”读不懂：' + error.message); } for (const name of formulaNames(tree)) if (!names.has(name)) throw new Error('公式“' + out[key] + '”用到了尺寸表里没有的“' + name + '”'); }
    for (const key of ['axisX', 'axisY']) { const axis = anchor[key]; if (!Array.isArray(axis) || axis.length !== 2 || !axis.every(finite) || Math.hypot(axis[0], axis[1]) > 1.001 || Math.hypot(axis[0], axis[1]) < .999) throw new Error('放码方向无效'); out[key] = [axis[0], axis[1]]; }
    return out;
  });
  // rules that sit on notches: the notch moves by its formulas and is put back on its edge
  if (value.notchRules !== undefined && (!Array.isArray(value.notchRules) || value.notchRules.length > 5000)) throw new Error('刀口的放码规则无效');
  const notchSeen = new Set(), notchRules = (value.notchRules || []).map(rule => {
    if (!rule || typeof rule.notchId !== 'string' || !rule.notchId || rule.notchId.length > 200 || notchSeen.has(rule.notchId)) throw new Error('刀口的放码规则无效'); notchSeen.add(rule.notchId);
    const out = { notchId: rule.notchId, x: String(rule.x ?? '').trim(), y: String(rule.y ?? '').trim() };
    for (const key of ['x', 'y']) { if (out[key].length > 300) throw new Error('公式太长'); let tree; try { tree = parseFormula(out[key]); } catch (error) { throw new Error('公式“' + out[key] + '”读不懂：' + error.message); } for (const name of formulaNames(tree)) if (!names.has(name)) throw new Error('公式“' + out[key] + '”用到了尺寸表里没有的“' + name + '”'); }
    for (const key of ['axisX', 'axisY']) { const axis = rule[key]; if (!Array.isArray(axis) || axis.length !== 2 || !axis.every(finite) || Math.hypot(axis[0], axis[1]) > 1.001 || Math.hypot(axis[0], axis[1]) < .999) throw new Error('放码方向无效'); out[key] = [axis[0], axis[1]]; }
    return out;
  });
  // the sizes of the plan are the names of the series in use: the base size at its position, every other size at its own
  const active = series[t.activeSeries], named = (slot, name) => { const entry = active.find(item => item.slot === slot); if (entry) entry.name = name; else active.push({ slot, name }); };
  named(t.baseSlot, String(value.baseSize || '').trim().slice(0, 50)); for (const size of sizes) named(size.slot, size.label); active.sort((a, b) => a.slot - b.slot);
  const lostRules = Number.isInteger(value.lostRules) && value.lostRules > 0 && value.lostRules < 1e6 ? value.lostRules : 0;
  return { sizeTable: { unit: 'cm', activeSeries: t.activeSeries, baseSlot: t.baseSlot, series, rows }, anchors, notchRules, lostRules };
}

/** Where a place lies on a line or curve: on one of its stations ({ index }), on it between two stations ({ between }), or not on it (null). */
export function placeOnLine(entity, at, tolerance = FOLLOW_TOLERANCE_MM) {
  const stations = stationsOf(entity); if (!stations) return null;
  let index = -1, nearest = tolerance; stations.points.forEach((p, i) => { const d = Math.hypot(p.x - at.x, p.y - at.y); if (d <= nearest) { nearest = d; index = i; } });
  if (index >= 0) return { index };
  const path = entity.points, along = q => { let best = { distance: Infinity, length: 0 }, walked = 0; for (let i = 1; i < path.length; i++) { const a = path[i - 1], b = path[i], dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy, t = d ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / d)) : 0, distance = Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy), piece = Math.sqrt(d); if (distance < best.distance) best = { distance, length: walked + t * piece }; walked += piece; } return best; };
  const here = along(at); if (here.distance > tolerance) return null;
  const places = stations.points.map(p => along(p).length); let before = 0; for (let i = 0; i < stations.points.length - 1; i++) if (places[i] <= here.length) before = i;
  return { between: before };
}

/** How far a rule moves its point in one size, in millimetres, along the axes of the rule. */
export function ruleDisplacement(plan, size, rule) {
  const rows = new Map(plan.sizeTable.rows.map(row => [row.name, row.values])), slot = size.slot, base = plan.sizeTable.baseSlot, difference = name => rows.has(name) ? rows.get(name)[slot] - rows.get(name)[base] : NaN;
  const moved = text => { if (!text) return 0; const tree = parseFormula(text); return formulaNames(tree).size ? evaluateFormula(tree, difference) : evaluateFormula(tree, () => NaN) * (slot - base); };
  const dx = moved(rule.x) * TABLE_UNIT_MM, dy = moved(rule.y) * TABLE_UNIT_MM; return { dx: dx * rule.axisX[0] + dy * rule.axisY[0], dy: dx * rule.axisX[1] + dy * rule.axisY[1] };
}

// turn and scale as a whole: what was at `a` goes to `a2`, what was at `b` goes to `b2`
const similar = (points, a, b, a2, b2) => {
  const ux = b.x - a.x, uy = b.y - a.y, vx = b2.x - a2.x, vy = b2.y - a2.y, q = ux * ux + uy * uy;
  if (q < 1e-18) return points.map(p => ({ x: p.x + a2.x - a.x, y: p.y + a2.y - a.y }));
  const re = (ux * vx + uy * vy) / q, im = (ux * vy - uy * vx) / q;
  return points.map(p => { const x = p.x - a.x, y = p.y - a.y; return { x: a2.x + re * x - im * y, y: a2.y + im * x + re * y }; });
};

/**
 * Where the anchors of a plan go in one size. Returns, for every line and curve of `entities` that the plan names, its stations
 * and its marks in order along it: each mark has its place before (`base`), how far it moves (`dx`, `dy`, mm) and a `key` that
 * says where it sits (a station number, or a number between two stations).
 */
export function tableDisplacements(entities, plan, size) {
  const table = plan.sizeTable, rows = new Map(table.rows.map(row => [row.name, row.values])), slot = size.slot, base = table.baseSlot;
  // A formula is worked out with every name standing for how much that row differs from the base size; numbers in it are taken
  // as written ("胸围/4+0.5" adds half a centimetre in every size). A formula of numbers only is a step: it counts once for
  // every size the size is away from the base size ("1" is one centimetre per size). This is what ET 2017 did with a probe file.
  const difference = name => rows.has(name) ? rows.get(name)[slot] - rows.get(name)[base] : NaN, trees = new Map();
  const moved = text => { if (!text) return 0; if (!trees.has(text)) { const tree = parseFormula(text); trees.set(text, { tree, step: !formulaNames(tree).size }); } const { tree, step } = trees.get(text); return step ? evaluateFormula(tree, () => NaN) * (slot - base) : evaluateFormula(tree, difference); };
  const sources = new Set(plan.sources.map(source => source.entityId)), lines = new Map();
  for (const entity of entities) { if (!sources.has(entity.id)) continue; const stations = stationsOf(entity); if (stations) lines.set(entity.id, { entity, stations, marks: new Map() }); }
  const masters = [];
  for (const [listed, anchor] of plan.anchors.entries()) {
    const line = lines.get(anchor.entityId); if (!line) continue; const points = line.stations.points; let key, place;
    if (anchor.between !== undefined) {
      if (anchor.between >= points.length - 1) throw new Error('线上放码点的位置超出“' + line.entity.name + '”的点数，请重新建立方案');
      const before = Math.hypot(anchor.at.x - points[anchor.between].x, anchor.at.y - points[anchor.between].y), after = Math.hypot(anchor.at.x - points[anchor.between + 1].x, anchor.at.y - points[anchor.between + 1].y);
      key = anchor.between + Math.min(.999, Math.max(.001, before + after > 0 ? before / (before + after) : .5)); place = { x: anchor.at.x, y: anchor.at.y };
      while (line.marks.has(key)) key -= 1e-6;   // on the same place as an earlier one: ET puts the later one first along the line
    } else { if (anchor.index >= points.length) throw new Error('放码点的序号超出“' + line.entity.name + '”的点数，请重新建立方案'); key = anchor.index; place = points[anchor.index]; }
    if (anchor.plain) { line.marks.set(key, { key, base: place, dx: 0, dy: 0, plain: true }); continue; }
    const dx = moved(anchor.x) * TABLE_UNIT_MM, dy = moved(anchor.y) * TABLE_UNIT_MM, mark = { key, listed, base: place, dx: dx * anchor.axisX[0] + dy * anchor.axisY[0], dy: dx * anchor.axisX[1] + dy * anchor.axisY[1] };
    line.marks.set(key, mark); masters.push(mark);
  }
  // an end, or a plain mark, that lies on a point with a rule moves with it
  let followers = 0;
  const follow = point => { let best = null, nearest = FOLLOW_TOLERANCE_MM; for (const master of masters) { const distance = Math.hypot(master.base.x - point.x, master.base.y - point.y); if (distance <= nearest) { nearest = distance; best = master; } } return best; };
  for (const line of lines.values()) {
    const points = line.stations.points, last = points.length - 1;
    for (const key of new Set([0, last, ...line.marks.keys()])) {
      const present = line.marks.get(key); if (present && !present.plain) continue;
      const place = present ? present.base : points[key], master = follow(place);
      if (master) { line.marks.set(key, { key, base: place, dx: master.dx, dy: master.dy, follows: true }); followers++; } else if (!present) line.marks.set(key, { key, base: place, dx: 0, dy: 0, plain: true });
    }
  }
  return { lines, followers };
}

/** Moves the lines and curves of `entities` that the plan names to their shape in one size. Returns how many changed. */
export function applyTableGrading(entities, plan, size) {
  const { lines, followers } = tableDisplacements(entities, plan, size); let changed = 0;
  for (const { entity, stations, marks } of lines.values()) {
    const sorted = [...marks.values()].sort((a, b) => a.key - b.key);
    if (sorted.every(mark => Math.abs(mark.dx) < 1e-9 && Math.abs(mark.dy) < 1e-9)) continue;
    const points = stations.points, target = mark => ({ x: mark.base.x + mark.dx, y: mark.base.y + mark.dy }), next = points.map(p => ({ ...p })), order = [];
    // Two grading points on one place of the line that land within a millimetre of each other in this size count as one, the one
    // listed first (seen with ET on a real pattern: two rules on one place that divide the same row by 4.2 and by 4; it keeps both only in the size where they come 1.1 mm apart).
    for (const mark of sorted) { const last = order.at(-1), onLine = m => !Number.isInteger(m.key) && !m.plain; if (last && onLine(mark) && onLine(last) && Math.hypot(target(mark).x - target(last).x, target(mark).y - target(last).y) < THIN_MM) { if (mark.listed < last.listed) order[order.length - 1] = mark; } else order.push(mark); }
    // each part between two marks is turned and scaled as a whole; a station on a mark goes where the mark goes
    for (let k = 1; k < order.length; k++) {
      const from = order[k - 1], to = order[k], first = Math.ceil(from.key), last = Math.floor(to.key); if (last < first) continue;
      similar(points.slice(first, last + 1), from.base, to.base, target(from), target(to)).forEach((p, i) => { next[first + i] = p; });
    }
    // A grading point on the line between two stations becomes a point of the line in the new size: ET draws the graded curve
    // through it. Points that come closer than a millimetre to each other are thinned as ET does it (seen on a real pattern:
    // of two grading points on one place it keeps both when they end up 1.1 mm apart and one when 0.8 mm; a drawn point that
    // close to a grading point is the one left out). ET may leave out more points that the shape no longer needs; the curve
    // is then the same within a few tenths of a millimetre.
    const inserted = order.filter(mark => !Number.isInteger(mark.key) && !mark.plain);
    // (a straight line stays straight between its ends: there ET moves the point on it and nothing else)
    if (inserted.length && stations.fitted) {
      const keyed = [...next.map((p, i) => ({ key: i, p, rank: i === 0 || i === next.length - 1 ? 0 : 2 })), ...inserted.map(mark => ({ key: mark.key, p: target(mark), rank: 1, listed: mark.listed }))].sort((a, b) => a.key - b.key), kept = [];
      // rank: an end always stays (0), then grading points (1; of two, the one listed first), then drawn points (2)
      const better = (a, b) => a.rank !== b.rank ? a.rank < b.rank : (a.listed ?? 0) < (b.listed ?? 0);
      for (const item of keyed) { const last = kept.at(-1); if (last && Math.hypot(item.p.x - last.p.x, item.p.y - last.p.y) < THIN_MM) { if (better(item, last)) kept[kept.length - 1] = item; } else kept.push(item); }
      next.length = 0; for (const item of kept) next.push(item.p);
    }
    if (!entity.curve) entity.points = next;
    else if (stations.fitted) { const fitted = fitClampedSpline(next); entity.curve = { ...entity.curve, controlPoints: fitted.curve.controlPoints, knots: fitted.curve.knots }; refreshCurve(entity); }
    else { const controls = entity.curve.controlPoints.map(p => ({ x: p.x, y: p.y })); entity.curve.controlPoints = similar(controls, points[0], points[1], next[0], next[1]); refreshCurve(entity); }
    changed++;
  }
  return { changed, followers };
}
