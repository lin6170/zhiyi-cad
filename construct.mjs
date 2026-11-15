/**
 * Construction geometry for pattern drafting: parallels, perpendiculars, angle lines,
 * bisectors, division marks, compass and gauge constructions, circles and arcs, fillets,
 * corner joins, length changes and reflection about an axis.
 * Pure functions on entity geometry. Millimetres, x to the right, y upward.
 * "left" and "right" are seen while travelling along a line from its first point to its last.
 * Curves are returned as cubic B-splines, the form the editor and the PRJ export already use.
 */
import { bezierSpans } from './curves.mjs';
import { fitClampedSpline } from './fit-spline.mjs';
import { pathMetrics, stationOnPath } from './path-metrics.mjs';

export const PARALLEL_TOLERANCE = .005; // mm, largest allowed distance between a parallel curve and the true offset
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y }), scale = (v, k) => ({ x: v.x * k, y: v.y * k });
const dot = (a, b) => a.x * b.x + a.y * b.y, cross = (a, b) => a.x * b.y - a.y * b.x, norm = v => Math.hypot(v.x, v.y);
const leftOf = v => ({ x: -v.y, y: v.x }); // a quarter turn counter-clockwise
const distance = (a, b) => norm(sub(a, b));
function unit(v, message = '两点重合，方向无法确定。') { const n = norm(v); if (!(n > 1e-9)) throw new Error(message); return { x: v.x / n, y: v.y / n }; }
const signOf = side => { if (side !== 'left' && side !== 'right') throw new Error('需要说明在线的左侧还是右侧。'); return side === 'left' ? 1 : -1; };
const positive = (value, name, max = 100000) => { if (!(typeof value === 'number' && value > 0 && value <= max)) throw new Error(name + '须大于 0 且不超过 ' + max + ' mm。'); return value; };

// ---------------------------------------------------------------- what an entity is
export function kindOf(entity) { return entity.type === 'text' ? 'text' : entity.curve ? 'curve' : entity.points.length === 2 && !entity.closed ? 'line' : 'polyline'; }
/** The two ends of a straight line entity. */
export function straightEnds(entity, name = '这条线') {
  if (!entity || kindOf(entity) !== 'line') throw new Error(name + '须是一条直线。');
  const [a, b] = entity.points; if (!(distance(a, b) > 1e-9)) throw new Error(name + '长度为零。');
  return [{ ...a }, { ...b }];
}
function pathOnly(entity) { if (!entity || entity.type === 'text') throw new Error('请选择一条线。'); return entity; }

// ---------------------------------------------------------------- Bezier pieces of a curve
function bezierAt(controls, t) {
  // value, first and second derivative of a quadratic or cubic Bezier
  let row = controls; const levels = [row];
  while (row.length > 1) { row = row.slice(0, -1).map((p, i) => ({ x: p.x * (1 - t) + row[i + 1].x * t, y: p.y * (1 - t) + row[i + 1].y * t })); levels.push(row); }
  const n = controls.length - 1, last = levels[n - 1], before = levels[n - 2];
  const d1 = scale(sub(last[1], last[0]), n), d2 = n > 1 ? scale(add(sub(before[2], before[1]), sub(before[0], before[1])), n * (n - 1)) : { x: 0, y: 0 };
  return { point: levels[n][0], d1, d2 };
}
/** Direction of travel at a curve parameter. Splines with a doubled end control point stand still at their ends; the second derivative gives the direction there. */
function travel(state, t) {
  if (norm(state.d1) > 1e-9) return unit(state.d1);
  if (norm(state.d2) > 1e-9) return unit(t < .5 ? state.d2 : scale(state.d2, -1));
  throw new Error('曲线在此处没有确定的方向。');
}

// ---------------------------------------------------------------- stations along a line
/** A point on a line or curve given by distance from one end or by a share of its length. */
export function station(entity, where) {
  pathOnly(entity);
  let metrics; try { metrics = pathMetrics(entity); } catch (error) { throw new Error('无法沿这条线定位：' + error.message); }
  let position;
  if (where && typeof where.ratio === 'number') { if (!(where.ratio >= 0 && where.ratio <= 1)) throw new Error('位置比例须在 0 到 1 之间。'); position = metrics.total * where.ratio; }
  else if (where && typeof where.distance === 'number' && (where.from === 'start' || where.from === 'end')) {
    if (!(where.distance >= 0 && where.distance <= metrics.total + 1e-7)) throw new Error('位置超出线的长度（线长 ' + metrics.total.toFixed(2) + ' mm）。');
    position = where.from === 'start' ? where.distance : metrics.total - where.distance;
  } else throw new Error('位置须写成“距起点或终点多远”，或一个 0 到 1 的比例。');
  position = Math.max(0, Math.min(metrics.total, position));
  let found; try { found = stationOnPath(metrics, position); } catch (error) { throw new Error(error.message.replace(/刀口/g, '定位点')); }
  return { point: found.point, tangent: unit(found.tangent), position, total: metrics.total };
}
/** The station on a line or curve closest to a point, measured on the displayed polyline (within about 0.01 mm). */
export function nearestStation(entity, point) {
  pathOnly(entity);
  const points = entity.closed ? [...entity.points, entity.points[0]] : entity.points; let best = null, travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], ab = sub(b, a), length = norm(ab); if (!(length > 0)) continue;
    const t = Math.max(0, Math.min(1, dot(sub(point, a), ab) / (length * length))), foot = add(a, scale(ab, t)), away = distance(point, foot);
    if (!best || away < best.away) best = { away, position: travelled + length * t, point: foot, direction: scale(ab, 1 / length) };
    travelled += length;
  }
  if (!best) throw new Error('这条线没有长度。');
  return { ...best, total: travelled };
}

// ---------------------------------------------------------------- parallels
function offsetPolyline(points, closed, d) {
  const count = points.length, segments = closed ? count : count - 1, directions = [];
  for (let i = 0; i < segments; i++) directions.push(unit(sub(points[(i + 1) % count], points[i]), '折线含有重合的相邻顶点。'));
  const normals = directions.map(leftOf), out = [];
  for (let i = 0; i < count; i++) {
    const before = closed ? normals[(i - 1 + segments) % segments] : normals[i - 1], after = closed ? normals[i % segments] : normals[i];
    if (!before || !after) { out.push(add(points[i], scale(before || after, d))); continue; }
    const k = 1 + dot(before, after);
    if (k < .02) throw new Error('折线的转角过尖，不能作平行线。');
    out.push(add(points[i], scale(add(before, after), d / k)));
  }
  for (let i = 0; i < segments; i++) if (dot(sub(out[(i + 1) % count], out[i]), directions[i]) <= 1e-9) throw new Error('平行距离超过了折线内侧能容纳的宽度。');
  return out;
}
function awayFromSegment(point, a, b) { const ab = sub(b, a), q = dot(ab, ab), t = q ? Math.max(0, Math.min(1, dot(sub(point, a), ab) / q)) : 0; return distance(point, add(a, scale(ab, t))); }
/** Largest distance from the points of one polyline to another polyline that runs alongside it in the same direction. */
function farthestFrom(points, line) {
  let j = 1, worst = 0;
  for (const point of points) {
    let best = awayFromSegment(point, line[j - 1], line[j]);
    while (j < line.length - 1) { const next = awayFromSegment(point, line[j], line[j + 1]); if (next <= best) { best = next; j++; } else break; }
    worst = Math.max(worst, best);
  }
  return worst;
}
// Polylines used for comparing curves have chords of about 0.2 mm, so their own sag stays far below the tolerance.
const chords = length => Math.max(8, Math.min(4096, Math.ceil(length / .2)));
function polylineOf(evaluate, pieces) {
  const out = [];
  for (let piece = 0; piece < pieces; piece++) {
    let rough = 0, previous = evaluate(piece, 0); for (let j = 1; j <= 16; j++) { const q = evaluate(piece, j / 16); rough += distance(q, previous); previous = q; }
    const count = chords(rough); for (let j = piece ? 1 : 0; j <= count; j++) out.push(evaluate(piece, j / count));
  }
  return out;
}
/** A spline through points of a parametrised curve, refined until it stays within the tolerance of that curve. evaluate(piece, t) gives the true point. */
function fitThrough(evaluate, pieces, tolerance) {
  const reference = polylineOf(evaluate, pieces); let best = null;
  for (const density of [1, 2, 3, 4, 6, 8, 12, 16, 24]) {
    const at = [];
    for (let piece = 0; piece < pieces; piece++) for (let j = piece ? 1 : 0; j <= density; j++) at.push(piece + j / density);
    // A fitted spline repeats its end control points, which bends the first and last interval; two short intervals keep that small.
    const first = at[1] - at[0], final = at.at(-1) - at.at(-2);
    at.splice(1, 0, at[0] + first / 16, at[0] + first / 4); at.splice(at.length - 1, 0, at.at(-1) - final / 4, at.at(-1) - final / 16);
    const points = [];
    for (const u of at) { const piece = Math.min(pieces - 1, Math.floor(u)), q = evaluate(piece, u - piece); if (!points.length || distance(q, points.at(-1)) > 1e-3) points.push(q); }
    if (points.length < 2) throw new Error('曲线过短，不能作平行线。');
    if (points.length > 120) break;
    let fitted; try { fitted = fitClampedSpline(points); } catch { continue; }
    const spans = bezierSpans(fitted.curve), samples = polylineOf((piece, t) => bezierAt(spans[piece].controlPoints, t).point, spans.length);
    const deviation = Math.max(farthestFrom(samples, reference), farthestFrom(reference, samples));
    if (!best || deviation < best.deviation) best = { curve: fitted.curve, deviation, fitPoints: points.length };
    if (deviation <= tolerance) return best;
  }
  throw new Error('平行曲线无法在 ' + tolerance + ' mm 容差内拟合' + (best ? '（最好结果 ' + best.deviation.toFixed(4) + ' mm）' : '') + '。请先把曲线分段。');
}
function offsetCurve(curve, d) {
  const spans = bezierSpans(curve), final = spans.length - 1, FOLD = '平行距离达到或超过了曲线内侧的弯曲半径，平行线会打结。请减小距离或换到外侧。';
  // Speed of the parallel relative to the original: 1 - curvature x distance. At or below zero the parallel turns back on itself.
  const speedRatio = (piece, t) => { const state = bezierAt(spans[piece].controlPoints, t), speed = norm(state.d1); return speed > 1e-9 ? 1 - cross(state.d1, state.d2) / speed ** 3 * d : null; };
  const normalAt = (piece, t) => leftOf(travel(bezierAt(spans[piece].controlPoints, t), t));
  const even = Array.from({ length: 64 }, (_, j) => (j + 1) / 64), close = []; for (let k = 30; k >= 7; k--) close.push(2 ** -k);
  // A spline with a doubled end control point hooks sharply over its last fraction of a millimetre. There the exact
  // parallel would fold over by a similar amount; the direction is held instead. A fold anywhere else is refused.
  // Walks inward from one end and returns the place where the hook ends, or null when the end is regular.
  function hold(fromStart) {
    const endPoint = fromStart ? spans[0].controlPoints[0] : spans[final].controlPoints.at(-1); let boundary = null, folding = false;
    for (let k = 0; k <= final; k++) {
      const piece = fromStart ? k : final - k, controls = spans[piece].controlPoints;
      for (const step of k === 0 ? [...close, ...even] : even) {
        const t = fromStart ? step : 1 - step, reach = distance(bezierAt(controls, t).point, endPoint), ratio = speedRatio(piece, t);
        if (ratio !== null && ratio < .05) { if (reach > 2) throw new Error(FOLD); folding = true; boundary = null; }
        else if (folding) { folding = false; boundary = { piece, t }; }
        if (reach > 2 && !folding) return boundary;
      }
    }
    if (folding) throw new Error(FOLD);
    return boundary;
  }
  const startHold = hold(true), endHold = hold(false);
  const beforeStart = (piece, t) => startHold !== null && (piece < startHold.piece || (piece === startHold.piece && t < startHold.t));
  const afterEnd = (piece, t) => endHold !== null && (piece > endHold.piece || (piece === endHold.piece && t > endHold.t));
  spans.forEach((span, piece) => { for (let j = 0; j <= 64; j++) { const t = j / 64; if (beforeStart(piece, t) || afterEnd(piece, t)) continue; const ratio = speedRatio(piece, t); if (ratio !== null && ratio < .05) throw new Error(FOLD); } });
  const startNormal = startHold ? normalAt(startHold.piece, startHold.t) : null, endNormal = endHold ? normalAt(endHold.piece, endHold.t) : null;
  const evaluate = (piece, t) => add(bezierAt(spans[piece].controlPoints, t).point, scale(beforeStart(piece, t) ? startNormal : afterEnd(piece, t) ? endNormal : normalAt(piece, t), d));
  return { ...fitThrough(evaluate, spans.length, PARALLEL_TOLERANCE), endsHeld: Number(startHold !== null) + Number(endHold !== null) };
}
/** A parallel to a line, a polyline or a curve at the given distance on the given side. */
export function parallel(entity, distanceMm, side) {
  pathOnly(entity); const d = positive(distanceMm, '平行距离') * signOf(side), kind = kindOf(entity);
  if (kind === 'curve') { const result = offsetCurve(entity.curve, d); return { geometry: { points: [], closed: false, curve: result.curve }, deviation: result.deviation, fitPoints: result.fitPoints }; }
  if (kind === 'line') { const [a, b] = straightEnds(entity), shift = scale(leftOf(unit(sub(b, a))), d); return { geometry: { points: [add(a, shift), add(b, shift)], closed: false }, deviation: 0 }; }
  return { geometry: { points: offsetPolyline(entity.points, Boolean(entity.closed), d), closed: Boolean(entity.closed) }, deviation: 0 };
}
/** Which side of a line or curve a point lies on, judged at the nearest place on it. */
export function sideOf(entity, point) {
  const near = nearestStation(entity, point), turn = cross(near.direction, sub(point, near.point));
  if (Math.abs(turn) < 1e-7) throw new Error('这个点正好在线上，分不出左右；请点在线的一侧。');
  return turn > 0 ? 'left' : 'right';
}

// ---------------------------------------------------------------- lines at a station
/** A line that leaves a station at an angle to the direction of travel; 90 degrees gives the perpendicular. */
export function angleLine(entity, where, degrees, length, side) {
  if (!(typeof degrees === 'number' && degrees > 0 && degrees < 180)) throw new Error('角度须大于 0 且小于 180 度。');
  const at = station(entity, where), angle = degrees * Math.PI / 180 * signOf(side), c = Math.cos(angle), s = Math.sin(angle), t = at.tangent;
  const direction = degrees === 90 ? scale(leftOf(t), signOf(side)) : { x: t.x * c - t.y * s, y: t.x * s + t.y * c };
  return { points: [at.point, add(at.point, scale(direction, positive(length, '线长')))], foot: at.point, position: at.position, total: at.total };
}
function meeting(a, b, c, d) {
  const u = sub(b, a), v = sub(d, c), k = cross(u, v);
  if (Math.abs(k) <= 1e-9 * norm(u) * norm(v)) throw new Error('两条线平行，没有交点。');
  return add(a, scale(u, cross(sub(c, a), v) / k));
}
/** For a line and a corner point on its extension: the end that stays and the unit direction from the corner to it. */
function rayFrom(corner, ends, near) {
  // With a picked point the end nearer to it is the one that moves, as in ET; otherwise the end nearer to the corner moves.
  const far = near ? (distance(near, ends[0]) <= distance(near, ends[1]) ? 1 : 0) : distance(corner, ends[0]) >= distance(corner, ends[1]) ? 0 : 1;
  return { far, direction: unit(sub(ends[far], corner), near ? '点击的这一端移到交点后，这条线就没有长度了。请点在要连接的那一端附近。' : '线的两端都在交点上。'), reach: distance(corner, ends[far]) };
}
/** The line that halves the angle between two straight lines, starting at their meeting point. */
export function bisector(first, second, length) {
  const a = straightEnds(first, '第一条线'), b = straightEnds(second, '第二条线'), corner = meeting(a[0], a[1], b[0], b[1]);
  const direction = unit(add(rayFrom(corner, a).direction, rayFrom(corner, b).direction), '两条线成一直线，没有角可以平分。');
  return { points: [corner, add(corner, scale(direction, positive(length, '线长')))], corner };
}
/** Marks that divide a line or curve into equal lengths. Each mark is a short line across the path, centred on the division point. */
export function divisionMarks(entity, count, markLength = 6) {
  if (!Number.isInteger(count) || count < 2 || count > 100) throw new Error('等分数须是 2 到 100 的整数。');
  positive(markLength, '标记长度', 1000); const marks = [];
  for (let k = 1; k < count; k++) { const at = station(entity, { ratio: k / count }), half = scale(leftOf(at.tangent), markLength / 2); marks.push({ points: [sub(at.point, half), add(at.point, half)], point: at.point, index: k }); }
  return marks;
}

// ---------------------------------------------------------------- compass and gauge
/** The point at given distances from two points, on the chosen side of the line from the first to the second. */
export function compass(a, b, lengthA, lengthB, side) {
  const gap = distance(a, b); positive(lengthA, '第一条线长'); positive(lengthB, '第二条线长');
  if (!(gap > 1e-9)) throw new Error('两个起点重合。');
  if (lengthA + lengthB < gap - 1e-9) throw new Error('两条线长之和 ' + (lengthA + lengthB).toFixed(2) + ' mm 小于两点距离 ' + gap.toFixed(2) + ' mm，够不到一起。');
  if (Math.abs(lengthA - lengthB) > gap + 1e-9) throw new Error('两条线长相差 ' + Math.abs(lengthA - lengthB).toFixed(2) + ' mm，大于两点距离 ' + gap.toFixed(2) + ' mm，交不到一起。');
  const u = unit(sub(b, a)), along = (lengthA * lengthA - lengthB * lengthB + gap * gap) / (2 * gap), height = Math.sqrt(Math.max(0, lengthA * lengthA - along * along));
  const point = add(add(a, scale(u, along)), scale(leftOf(u), height * signOf(side)));
  return { point, lines: [[{ ...a }, point], [{ ...b }, { ...point }]] };
}
function circleHitsOnSegment(center, radius, a, b) {
  const ab = sub(b, a), length = norm(ab); if (!(length > 0)) return [];
  const u = scale(ab, 1 / length), foot = dot(sub(center, a), u), away2 = dot(sub(center, a), sub(center, a)) - foot * foot, inside = radius * radius - away2;
  if (inside < -1e-9) return [];
  const half = Math.sqrt(Math.max(0, inside));
  return (half < 1e-9 ? [foot] : [foot - half, foot + half]).filter(t => t >= -1e-9 && t <= length + 1e-9).map(t => ({ t: t / length, point: add(a, scale(u, Math.max(0, Math.min(length, t)))) }));
}
function circleHitsOnBezier(center, radius, controls) {
  const f = t => distance(bezierAt(controls, t).point, center) - radius, hits = [], N = 96; let before = f(0);
  if (Math.abs(before) < 1e-9) hits.push(0);
  for (let i = 1; i <= N; i++) {
    const t1 = i / N, value = f(t1);
    if (Math.abs(value) < 1e-9) { if (!hits.length || t1 - hits.at(-1) > 1e-6) hits.push(t1); }
    else if (before * value < 0 && Math.abs(before) >= 1e-9) { let lo = (i - 1) / N, hi = t1, flo = before; for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2, fm = f(mid); if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; } } hits.push((lo + hi) / 2); }
    before = value;
  }
  return hits.map(t => ({ t, point: bezierAt(controls, t).point }));
}
/** A straight line of a given length from a point to a target line or curve. Solutions are ordered from the start of the target. */
export function gauge(from, target, length) {
  pathOnly(target); positive(length, '线长'); const hits = [];
  if (target.curve) bezierSpans(target.curve).forEach((span, index) => { for (const hit of circleHitsOnBezier(from, length, span.controlPoints)) hits.push({ order: index + hit.t, point: hit.point }); });
  else { const points = target.closed ? [...target.points, target.points[0]] : target.points; for (let i = 1; i < points.length; i++) for (const hit of circleHitsOnSegment(from, length, points[i - 1], points[i])) hits.push({ order: i - 1 + hit.t, point: hit.point }); }
  hits.sort((x, y) => x.order - y.order);
  const distinct = hits.filter((hit, i) => !i || distance(hit.point, hits[i - 1].point) > 1e-6);
  if (!distinct.length) {
    const sample = target.points, nearest = Math.min(...sample.map(p => distance(p, from))), farthest = Math.max(...sample.map(p => distance(p, from)));
    throw new Error('从这个点出发、长 ' + length.toFixed(2) + ' mm 的线够不到目标线上。目标线到该点最近约 ' + nearest.toFixed(2) + ' mm，最远约 ' + farthest.toFixed(2) + ' mm。');
  }
  return distinct.map(hit => ({ point: hit.point, line: [{ ...from }, hit.point] }));
}

// ---------------------------------------------------------------- circles and arcs
/** A circular arc as a cubic B-spline. Pieces span at most 30 degrees, which keeps the radial error below one millionth of the radius. */
export function arcCurve(center, radius, startRadians, sweepRadians) {
  positive(radius, '半径'); if (!(Math.abs(sweepRadians) > 1e-9 && Math.abs(sweepRadians) <= 2 * Math.PI + 1e-9)) throw new Error('圆弧的转角须大于 0 且不超过 360 度。');
  const pieces = Math.max(1, Math.ceil(Math.abs(sweepRadians) / (Math.PI / 6) - 1e-9)), step = sweepRadians / pieces, handle = 4 / 3 * Math.tan(step / 4) * radius;
  const at = angle => ({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }), tangent = angle => ({ x: -Math.sin(angle), y: Math.cos(angle) });
  const controls = [at(startRadians)], knots = [0, 0, 0, 0];
  for (let i = 0; i < pieces; i++) {
    const a = startRadians + step * i, b = a + step;
    controls.push(add(at(a), scale(tangent(a), handle)), sub(at(b), scale(tangent(b), handle)), i === pieces - 1 && Math.abs(Math.abs(sweepRadians) - 2 * Math.PI) < 1e-9 ? { ...controls[0] } : at(b));
    knots.push(i + 1, i + 1, i + 1);
  }
  knots.push(pieces);
  return { kind: 'bspline', degree: 3, controlPoints: controls, knots, samplingTolerance: .002 };
}
/** A full circle, starting at its rightmost point and running counter-clockwise back to it. */
export const circleCurve = (center, radius) => arcCurve(center, radius, 0, 2 * Math.PI);

// ---------------------------------------------------------------- changing straight lines
/** Round the corner of two straight lines with an arc of the given radius. Each line keeps the end that is farther from the corner. */
export function fillet(first, second, radius, { firstNear, secondNear } = {}) {
  positive(radius, '圆角半径'); const a = straightEnds(first, '第一条线'), b = straightEnds(second, '第二条线'), corner = meeting(a[0], a[1], b[0], b[1]);
  const ra = rayFrom(corner, a, firstNear), rb = rayFrom(corner, b, secondNear), cosine = Math.max(-1, Math.min(1, dot(ra.direction, rb.direction))), angle = Math.acos(cosine);
  if (!(angle > 1e-6 && angle < Math.PI - 1e-6)) throw new Error('两条线成一直线，不能做圆角。');
  const setback = radius / Math.tan(angle / 2);
  if (setback > ra.reach - 1e-6 || setback > rb.reach - 1e-6) throw new Error('圆角半径太大：切点要离交点 ' + setback.toFixed(2) + ' mm，而两条线从交点起只有 ' + ra.reach.toFixed(2) + ' 和 ' + rb.reach.toFixed(2) + ' mm。');
  const ta = add(corner, scale(ra.direction, setback)), tb = add(corner, scale(rb.direction, setback)), center = add(corner, scale(unit(add(ra.direction, rb.direction)), radius / Math.sin(angle / 2)));
  const start = Math.atan2(ta.y - center.y, ta.x - center.x), turn = cross(sub(ta, center), sub(tb, center)) > 0 ? 1 : -1, curve = arcCurve(center, radius, start, turn * (Math.PI - angle));
  curve.controlPoints[0] = { ...ta }; curve.controlPoints[curve.controlPoints.length - 1] = { ...tb }; // exactly the tangent points, so the three lines stay joined
  const keep = (ends, ray, tangentPoint) => ray.far === 0 ? [ends[0], tangentPoint] : [tangentPoint, ends[1]];
  return { first: keep(a, ra, ta), second: keep(b, rb, tb), curve, corner, center, tangentPoints: [ta, tb], setback };
}
/** Bring two straight lines together at the point where they, or their extensions, meet. In each line the end nearer to that point moves. */
export function cornerJoin(first, second, { firstNear, secondNear } = {}) {
  const a = straightEnds(first, '第一条线'), b = straightEnds(second, '第二条线'), corner = meeting(a[0], a[1], b[0], b[1]);
  const move = (ends, near) => { const ray = rayFrom(corner, ends, near); if (!(ray.reach > 1e-6)) throw new Error('线的两端都在交点上。'); return ray.far === 0 ? [ends[0], { ...corner }] : [{ ...corner }, ends[1]]; };
  return { first: move(a, firstNear), second: move(b, secondNear), corner };
}
/** Give a straight line a new length by moving one end along its own direction. */
export function withLength(entity, end, length) {
  const [a, b] = straightEnds(entity); if (end !== 'start' && end !== 'end') throw new Error('需要说明移动起点还是终点。');
  positive(length, '线长'); const u = unit(sub(b, a));
  return end === 'end' ? [a, add(a, scale(u, length))] : [sub(b, scale(u, length)), b];
}

// ---------------------------------------------------------------- reflection
/** Reflection about the line through two points, as a function on points. */
export function reflection(from, to) {
  const u = unit(sub(to, from), '镜像轴的两个点重合。');
  return p => { const v = sub(p, from), along = dot(v, u); return { x: from.x + 2 * along * u.x - v.x, y: from.y + 2 * along * u.y - v.y }; };
}
/** The same reflection applied to a direction (no shift). */
export function reflectionOfVector(from, to) { const u = unit(sub(to, from), '镜像轴的两个点重合。'); return v => { const along = dot(v, u); return { x: 2 * along * u.x - v.x, y: 2 * along * u.y - v.y }; }; }

// ---------------------------------------------------------------- measuring
/** The angle between two straight lines in degrees, from 0 to 180, taken between their directions of travel. */
export function angleBetween(first, second) {
  const a = straightEnds(first, '第一条线'), b = straightEnds(second, '第二条线'), u = unit(sub(a[1], a[0])), v = unit(sub(b[1], b[0]));
  return Math.atan2(Math.abs(cross(u, v)), dot(u, v)) * 180 / Math.PI;
}
