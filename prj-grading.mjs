/**
 * The grading of an ET PRJ (2.0 layout) carried into the editable drawing: its size names, its size table and the rules of its
 * points become one grading plan of the kind "table" (see grading-table.mjs), so that every size can be made the way ET makes it.
 *
 * What is carried and what is not is counted in the returned report; nothing is dropped without saying so.
 *   - A rule belongs to a point record of the file. The point is found again as a station of the line or curve that lists it
 *     (an end of a line, a point a curve passes through). A rule whose point is not a station cannot be carried.
 *   - Kind 2 (moved by two formulas) is carried. Kind 10 (follows another point) is carried with the formulas of the point it
 *     follows. Other kinds are not understood yet.
 *   - A formula must be arithmetic over names of the size table of the file.
 *   - The sizes are those of the series in use. When that series names the base size only, the series with the most names is taken
 *     and the report says so.
 *   - A rule on a notch (ET lets a notch move by formulas of its own) is carried with the notch of the drawing made from that
 *     record. The twin of the notch on the seam line needs none: the page finds it again on the seam allowance of each size.
 */
import { gradeSource } from './grading-schema.mjs';
import { normalizeGradingPlan } from './grading-schema.mjs';
import { stationsOf } from './grading-table.mjs';
import { parseFormula, formulaNames } from './size-formula.mjs';

const MM = 10, ON_STATION_MM = .02, ON_LINE_MM = .05;
// the nearest place on a polyline: how far along it lies, and how far away
function alongPath(points, q) {
  let best = { distance: Infinity, length: 0 }, walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy, t = d ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / d)) : 0, distance = Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy), piece = Math.sqrt(d);
    if (distance < best.distance) best = { distance, length: walked + t * piece }; walked += piece;
  }
  return best;
}

export function carryEtGrading({ parsed, project, made, curves, tails, makeId, notchOfNode = new Map() }) {
  const sizes = parsed.metadata.sizeSystem;
  const report = { inFile: { readable: Boolean(sizes?.readable), series: '', sizes: [], tableRows: 0, rules: 0, followers: 0, otherKinds: 0, onNotches: 0, layers: (parsed.metadata.sizeLayers || []).length || 1 },
    carried: false, planId: null, planName: '', seriesUsed: '', seriesChanged: false, sizes: [], sizeOrder: [], baseSize: '', tableRows: 0, rules: 0, followers: 0, onLines: 0, dividingPoints: 0, notchRules: 0, notchRulesNotCarried: 0, notCarried: 0, locks: 0, lockedSizes: [], locksNotCarried: 0, reasons: [], unknownNames: [] };
  if (!sizes || !sizes.readable) { if (sizes?.problem) report.reasons.push(sizes.problem); return report; }
  const nodes = parsed.metadata.nodes || [], moved = sizes.rules.filter(rule => rule.kind === 2), following = sizes.rules.filter(rule => rule.kind === 10);
  Object.assign(report.inFile, { series: sizes.series[sizes.activeSeries]?.name || '', sizes: sizes.names.map(size => size.name), tableRows: sizes.table.length, rules: moved.filter(rule => !rule.onNotch).length, followers: following.length,
    otherKinds: sizes.rules.filter(rule => rule.kind !== 2 && rule.kind !== 10).length, onNotches: sizes.rules.filter(rule => rule.onNotch).length });
  if (!moved.length && !sizes.table.length && sizes.names.length <= 1) return report;   // a file without grading
  const fail = reason => { if (!report.reasons.includes(reason)) report.reasons.push(reason); };

  // ---- the rule of every point number, with a follower taking the formulas of the point it follows
  const known = new Set(sizes.table.map(row => row.name)), byNumber = new Map(sizes.rules.map(rule => [rule.pointNumber, rule])), usable = new Map();
  const check = rule => {
    for (const text of [rule.x, rule.y]) { let tree; try { tree = parseFormula(text); } catch (error) { return '有公式读不懂（“' + text + '”：' + error.message + '）'; }
      const missing = [...formulaNames(tree)].filter(name => !known.has(name)); if (missing.length) { for (const name of missing) if (!report.unknownNames.includes(name)) report.unknownNames.push(name); return '有公式用到了尺寸表里没有的名称'; } }
    if (!rule.plain) return '有规则带着还不认识的附加数据'; return '';
  };
  const notchRules = [], notchSeen = new Set();
  for (const rule of sizes.rules) {
    if (rule.onNotch) {
      // the notch on the net edge carries the rule into the drawing; its twin on the seam line (no notch of the drawing) is not counted
      const notchId = notchOfNode.get(rule.pointNumber); if (!notchId) continue;
      if (rule.kind !== 2 || check(rule) || notchSeen.has(notchId)) { report.notchRulesNotCarried++; continue; }
      notchSeen.add(notchId); notchRules.push({ notchId, x: rule.x, y: rule.y, axisX: [...rule.axisX], axisY: [...rule.axisY], ...(rule.inches ? { unit: 'in' } : {}) }); continue;
    }
    const source = rule.kind === 10 ? byNumber.get(rule.master) : rule;
    if (rule.kind !== 2 && rule.kind !== 10) { report.notCarried++; fail('有 ' + rule.kind + ' 类的规则还不认识'); continue; }
    if (!source || source.kind !== 2) { report.notCarried++; fail('有跟随点找不到它跟随的点'); continue; }
    const problem = check(source); if (problem) { report.notCarried++; fail(problem); continue; }
    if (rule.node === null || rule.node === undefined) { report.notCarried++; fail('有规则所在的点没有对上点记录'); continue; }
    usable.set(rule.node, { x: source.x, y: source.y, axisX: [...source.axisX], axisY: [...source.axisY], follower: rule.kind === 10, inches: !!source.inches });   // v68: a rule ET made in inches keeps that
  }

  // ---- every line and curve of the drawing with the points the file lists on it
  const anchors = [], seen = new Set(), placed = new Set(), stationOfNode = new Map();   // v69: node number -> the stations it stands on (for the locks)
  for (const e of curves) {
    const entity = made.get(e.id); if (!entity) continue;
    const stations = stationsOf(entity), last = stations.points.length - 1;
    for (const number of tails.get(e.id).direct) {
      const node = nodes[number - 1]; if (!node) continue; const at = { x: node.x * MM, y: node.y * MM };
      let index = -1, nearest = ON_STATION_MM; stations.points.forEach((p, i) => { const d = Math.hypot(p.x - at.x, p.y - at.y); if (d <= nearest) { nearest = d; index = i; } });
      const rule = usable.get(number - 1); let where = null;
      if (index >= 0) { where = { index }; stationOfNode.set(number, [...(stationOfNode.get(number) || []), { entityId: entity.id, index, at: stations.points[index], stations: stations.points.length }]); }
      else {
        // not one of the points the curve was drawn through: a grading point on the line (ET's 线上的放码点), between two of them
        const along = alongPath(entity.points, at);
        if (along.distance <= ON_LINE_MM) { const places = stations.points.map(p => alongPath(entity.points, p).length); let before = 0; for (let i = 0; i < last; i++) if (places[i] <= along.length) before = i; where = { between: before, at }; }
      }
      if (!where) { if (rule) { report.notCarried++; fail('有规则所在的点不在它的线上'); placed.add(number - 1); } continue; }
      const key = entity.id + '#' + JSON.stringify(where) + (rule && where.between !== undefined ? '|' + rule.x + '|' + rule.y : ''); if (rule) placed.add(number - 1); if (seen.has(key)) continue;
      if (rule) { seen.add(key); anchors.push({ entityId: entity.id, ...where, x: rule.x, y: rule.y, axisX: rule.axisX, axisY: rule.axisY, ...(rule.inches ? { unit: 'in' } : {}) }); if (rule.follower) report.followers++; else report.rules++; if (where.between !== undefined) report.onLines++; }
      else if (where.between !== undefined || (where.index !== 0 && where.index !== last)) { seen.add(key); anchors.push({ entityId: entity.id, ...where, plain: true }); report.dividingPoints++; }
    }
  }
  for (const node of usable.keys()) if (!placed.has(node)) { report.notCarried++; fail('有规则所在的线没有带入（缝边线一类由网页重新生成的线）'); }
  // v71: a file with size names or a size table but no rules yet keeps them: the plan carries the names of the five series and
  // the size table without rules, and they are written back
  const tableOnly = !anchors.some(anchor => !anchor.plain);
  if (tableOnly && moved.length) { fail('没有一条规则能带入'); return report; }

  // ---- the sizes: those of the series in use, or of the series with the most names when that one names the base size only
  let series = sizes.series[sizes.activeSeries];
  const others = list => list.sizes.filter(size => size.slot !== sizes.baseSlot).length, hasBase = list => list.sizes.some(size => size.slot === sizes.baseSlot);
  if (!others(series)) { const better = sizes.series.filter(hasBase).sort((a, b) => others(b) - others(a))[0]; if (better && others(better)) { series = better; report.seriesChanged = true; } }
  if (!others(series) || !hasBase(series)) { fail('文件里没有基码以外的号型名称'); return report; }
  const targets = series.sizes.filter(size => size.slot !== sizes.baseSlot).slice(0, 12);
  if (others(series) > 12) fail('号型超过 12 个，只带入前 12 个');
  const value = { name: 'ET 放码', baseSize: series.sizes.find(size => size.slot === sizes.baseSlot).name, interpolation: 'fixed', method: 'table', rules: [],
    sources: project.entities.filter(entity => !entity.derivedFrom && !entity.notchFrom).map(gradeSource),
    sizes: targets.map(size => ({ id: makeId(), label: size.name, step: size.slot - sizes.baseSlot, slot: size.slot })),
    sizeTable: { unit: 'cm', activeSeries: sizes.series.indexOf(series), baseSlot: sizes.baseSlot, series: sizes.series.map(list => list.sizes.map(size => ({ slot: size.slot, name: size.name }))), rows: sizes.table.map(row => ({ name: row.name, values: [...row.values] })) },
    anchors, notchRules };
  // v69: the locks of every size (ET's 锁定放码点), and the sizes ET keeps whole (锁定解锁当前层: every point of the layer where it stands)
  const locks = [], lockedSizes = [];
  for (const layer of sizes.layers || []) {
    const size = value.sizes.find(item => item.label === layer.name); if (!size || layer.base) continue;
    if (layer.lockProblem) { report.locksNotCarried++; fail('有一个码的锁定没有读懂（' + layer.lockProblem + '）'); continue; }
    const lockAt = (points, whole) => { for (const point of points || []) { const stations = stationOfNode.get(point.pointNumber); if (!stations) { if (!whole) { report.locksNotCarried++; fail('有锁定的点不在带入的线上'); } continue; }
      for (const station of stations) if (!locks.some(lock => lock.entityId === station.entityId && lock.index === station.index && lock.sizeId === size.id && Boolean(lock.layer) === whole)) locks.push({ entityId: station.entityId, index: station.index, at: { x: station.at.x, y: station.at.y }, stations: station.stations, sizeId: size.id, x: point.x * MM, y: point.y * MM, ...(whole ? { layer: true } : {}) }); } };
    lockAt(layer.lockedPoints, false);
    if (layer.locked) { lockAt(layer.allPoints, true); lockedSizes.push(size.id); }
  }
  if (locks.length) value.locks = locks; if (lockedSizes.length) value.lockedSizes = lockedSizes;
  let plan; try { plan = normalizeGradingPlan(value); } catch (error) { fail('放码方案没有建成：' + error.message); report.rules = 0; report.followers = 0; report.dividingPoints = 0; return report; }
  const id = makeId(); (project.gradingPlans ||= []).push({ id, ...plan }); project.version = Math.max(project.version, 8);
  Object.assign(report, { carried: true, ...(tableOnly ? { tableOnly: true } : {}), locks: (plan.locks || []).filter(lock => !lock.layer).length, lockedSizes: (plan.lockedSizes || []).map(sizeId => plan.sizes.find(size => size.id === sizeId).label), notchRules: plan.notchRules.length, planId: id, planName: plan.name, seriesUsed: series.name, sizes: plan.sizes.map(size => size.label), baseSize: plan.baseSize, tableRows: plan.sizeTable.rows.length,
    sizeOrder: [{ label: plan.baseSize, slot: plan.sizeTable.baseSlot }, ...plan.sizes].sort((a, b) => a.slot - b.slot).map(size => size.label) });
  return report;
}
