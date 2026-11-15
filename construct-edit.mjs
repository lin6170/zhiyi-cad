/**
 * More drafting geometry. Every rule here was observed on ET 2017's own tool with a probe file:
 * right-angle connection, lines between the division points of
 * two paths, a perpendicular or a tangent from a point, moving the end of a line or curve, turning
 * lines until a reference line is vertical or horizontal, division arcs, the four positions of the
 * compass tool and the points a curve was drawn through.
 * Millimetres, y up. Pure functions, no DOM.
 */
import { bezierSpans } from './curves.mjs';
import { fitClampedSpline, nativeFitPoints } from './fit-spline.mjs';
import { station, nearestStation, straightEnds, compass } from './construct.mjs';

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y }), scale = (v, k) => ({ x: v.x * k, y: v.y * k });
const dot = (a, b) => a.x * b.x + a.y * b.y, cross = (a, b) => a.x * b.y - a.y * b.x, norm = v => Math.hypot(v.x, v.y), distance = (a, b) => norm(sub(a, b));
const leftOf = v => ({ x: -v.y, y: v.x }), copy = p => ({ x: p.x, y: p.y });
function unit(v, message = '两点重合，方向无法确定。') { const n = norm(v); if (!(n > 1e-9)) throw new Error(message); return { x: v.x / n, y: v.y / n }; }
const endName = end => { if (end !== 'start' && end !== 'end') throw new Error('需要说明是起点还是终点。'); return end; };

/** Which end of a path a point is nearer to, measured along the path. */
export function nearerEnd(entity, point) { const found = nearestStation(entity, point); return found.position <= found.total / 2 ? 'start' : 'end'; }

// ---------------------------------------------------------------- right-angle connection
/**
 * Two straight lines that join two points through a right-angled corner: one line from each point to the corner.
 * "vertical-first" leaves the first point vertically, "horizontal-first" horizontally; a toward point picks the nearer corner.
 */
export function elbow(from, to, { corner, toward } = {}) {
  if (Math.abs(from.x - to.x) < 1e-9 || Math.abs(from.y - to.y) < 1e-9) throw new Error('两个点在同一条水平线或垂直线上，直接画一条直线即可。');
  if (corner && toward) throw new Error('corner 和 toward 只能给一个。');
  const corners = { 'vertical-first': { x: from.x, y: to.y }, 'horizontal-first': { x: to.x, y: from.y } };
  const choice = toward ? (distance(toward, corners['vertical-first']) <= distance(toward, corners['horizontal-first']) ? 'vertical-first' : 'horizontal-first') : corner;
  if (!corners[choice]) throw new Error('需要说明拐角在哪一边：先竖后横（vertical-first）、先横后竖（horizontal-first），或给出 toward。');
  return { corner: corners[choice], choice, lines: [[copy(from), copy(corners[choice])], [copy(to), copy(corners[choice])]] };
}

// ---------------------------------------------------------------- lines between division points
/** Straight lines joining the points that divide two paths into the same number of equal parts, each path measured from the named end. */
export function rungs(first, second, count, firstFrom = 'start', secondFrom = 'start') {
  if (!Number.isInteger(count) || count < 2 || count > 100) throw new Error('等分数须是 2 到 100 的整数。');
  endName(firstFrom); endName(secondFrom); const lines = [];
  for (let k = 1; k < count; k++) {
    const a = station(first, { ratio: firstFrom === 'end' ? 1 - k / count : k / count }).point, b = station(second, { ratio: secondFrom === 'end' ? 1 - k / count : k / count }).point;
    if (distance(a, b) < 1e-6) throw new Error('两条线上第 ' + k + ' 个等分点重合，连不成线。');
    lines.push({ points: [a, b], index: k });
  }
  return lines;
}

// ---------------------------------------------------------------- from a point to a path
function bezierState(controls, t) {
  const [a, b, c, d] = controls, s = 1 - t;
  return { point: { x: s * s * s * a.x + 3 * s * s * t * b.x + 3 * s * t * t * c.x + t * t * t * d.x, y: s * s * s * a.y + 3 * s * s * t * b.y + 3 * s * t * t * c.y + t * t * t * d.y },
    d1: { x: 3 * (s * s * (b.x - a.x) + 2 * s * t * (c.x - b.x) + t * t * (d.x - c.x)), y: 3 * (s * s * (b.y - a.y) + 2 * s * t * (c.y - b.y) + t * t * (d.y - c.y)) } };
}
/** Places on a curve where a function of position and direction changes sign; bisected to full precision. */
function crossings(curve, measure) {
  const found = [];
  for (const span of bezierSpans(curve)) {
    if (span.controlPoints.length !== 4) throw new Error('只支持三次曲线。');
    const value = t => { const state = bezierState(span.controlPoints, t); return measure(state.point, state.d1); };
    let previous = value(0);
    for (let i = 1; i <= 96; i++) {
      const t = i / 96, now = value(t);
      if (previous === 0 || previous * now < 0) {
        let lo = (i - 1) / 96, hi = t, low = previous;
        for (let k = 0; k < 60 && previous !== 0; k++) { const mid = (lo + hi) / 2, m = value(mid); if (low * m <= 0) hi = mid; else { lo = mid; low = m; } }
        const state = bezierState(span.controlPoints, previous === 0 ? (i - 1) / 96 : (lo + hi) / 2);
        if (norm(state.d1) > 1e-9 && !found.some(p => distance(p.point, state.point) < 1e-4)) found.push({ point: state.point, tangent: unit(state.d1) });
      }
      previous = now;
    }
  }
  return found;
}
const nearestTo = (candidates, toward) => toward ? [...candidates].sort((p, q) => distance(p.point, toward) - distance(q.point, toward))[0] : candidates[0];
/**
 * The perpendicular from a point to a path. For a straight line the foot may lie on its extension; for a
 * curve the foot must be a place where the connecting line really is perpendicular to the curve.
 */
export function footFrom(point, entity, toward) {
  if (!entity || entity.type === 'text') throw new Error('请选择一条线。');
  let foot, onExtension = false;
  if (!entity.curve && entity.points.length === 2 && !entity.closed) {
    const [a, b] = straightEnds(entity), u = unit(sub(b, a)), along = dot(sub(point, a), u);
    foot = add(a, scale(u, along)); onExtension = along < -1e-9 || along > distance(a, b) + 1e-9;
  } else if (entity.curve) {
    const feet = crossings(entity.curve, (p, d) => dot(sub(p, point), d));
    if (!feet.length) throw new Error('从这个点到这条曲线作不出垂线：垂足落在曲线之外。');
    foot = nearestTo(feet, toward || point).point;
  } else throw new Error('垂线的目标须是一条直线或一条曲线。');
  if (distance(point, foot) < 1e-6) throw new Error('这个点就在线上，垂线没有长度。');
  return { points: [copy(point), foot], foot, onExtension, length: distance(point, foot) };
}
/** A straight line from a point that touches a curve. With several possible lines, the one touching nearest to toward. */
export function tangentFrom(point, entity, toward) {
  if (!entity || !entity.curve) throw new Error('切线的目标须是一条曲线或一个圆。');
  const touches = crossings(entity.curve, (p, d) => cross(sub(p, point), d)).filter(touch => distance(touch.point, point) > 1e-6);
  if (!touches.length) throw new Error('从这个点作不出与这条曲线相切的直线。');
  const touch = nearestTo(touches, toward);
  return { points: [copy(point), touch.point], touch: touch.point, candidates: touches.length, length: distance(point, touch.point) };
}

// ---------------------------------------------------------------- the points a curve goes through
/** The points an ET-style curve was drawn through, or an explanation why it has none. */
export function curvePoints(entity) {
  if (!entity || !entity.curve) throw new Error('这不是一条曲线。');
  const fit = nativeFitPoints(entity.curve);
  if (!fit) throw new Error('这条曲线的形状不是由曲线点决定的（它是圆弧，或它的控制点被单独改过），请用节点工具修改。');
  return fit;
}
/** The curve through a changed list of points, fitted the way ET fits its curves. */
export function curveThrough(points) {
  if (points.length < 2) throw new Error('曲线至少要有两个点。');
  try { return fitClampedSpline(points).curve; } catch (error) { throw new Error('这些点连不成曲线：' + error.message); }
}
/** Move one end of a line or curve to a new place. A curve keeps all its other points, as in ET. */
export function moveEnd(entity, end, to) {
  endName(end); if (!entity || entity.type === 'text') throw new Error('请选择一条线。');
  if (entity.closed) throw new Error('闭合的图形没有端点。');
  if (entity.curve) {
    const points = curvePoints(entity).map(copy), index = end === 'start' ? 0 : points.length - 1;
    if (distance(points[end === 'start' ? 1 : points.length - 2], to) < 1e-6) throw new Error('端点移到这里会和相邻的曲线点重合。');
    points[index] = copy(to); return { curve: curveThrough(points), fitPoints: points.length };
  }
  const points = entity.points.map(copy), index = end === 'start' ? 0 : points.length - 1;
  if (distance(points[end === 'start' ? 1 : points.length - 2], to) < 1e-6) throw new Error('端点移到这里，线就没有长度了。');
  if (distance(points[index], to) < 1e-9) throw new Error('端点已经在这个位置。');
  points[index] = copy(to); return { points };
}

// ---------------------------------------------------------------- vertical or horizontal correction
/**
 * The turn that makes a straight reference line vertical or horizontal, about its midpoint.
 * With a picked point, the end nearer to it ends up at the bottom (vertical) or on the left (horizontal), as in ET;
 * without one, the smaller of the two possible turns is taken. The angle is counter-clockwise, in degrees.
 */
export function alignTurn(reference, axis, near) {
  const [a, b] = straightEnds(reference, '参考线');
  if (axis !== 'vertical' && axis !== 'horizontal') throw new Error('需要说明补正到垂直（vertical）还是水平（horizontal）。');
  const target = axis === 'vertical' ? { x: 0, y: 1 } : { x: 1, y: 0 }, center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const turn = (from, to) => { const u = unit(sub(to, from)); return Math.atan2(cross(u, target), dot(u, target)) * 180 / Math.PI; };
  let degrees;
  if (near) degrees = distance(near, a) <= distance(near, b) ? turn(a, b) : turn(b, a);
  else { const one = turn(a, b), other = turn(b, a); degrees = Math.abs(one) <= Math.abs(other) ? one : other; }
  return { center, degrees };
}

// ---------------------------------------------------------------- division arcs
/**
 * ET marks equal parts with a quarter-circle arc over every part: the arc starts and ends on the division
 * points, its centre lies half a chord away on the other side, and it is a curve through twelve points spaced
 * evenly by angle. Each arc runs from the later division point back to the earlier one, as ET stores it.
 */
export function divisionArcs(points, side = 'left') {
  if (side !== 'left' && side !== 'right') throw new Error('需要说明弧线画在线的左侧还是右侧。');
  const arcs = [];
  for (let k = 1; k < points.length; k++) {
    const from = points[k - 1], to = points[k], chord = distance(from, to);
    if (!(chord > 1e-6)) throw new Error('等分点重合，画不出等分弧。');
    const normal = scale(leftOf(unit(sub(to, from))), side === 'left' ? 1 : -1), center = sub(scale(add(from, to), .5), scale(normal, chord / 2)), radius = chord / Math.SQRT2;
    const start = Math.atan2(to.y - center.y, to.x - center.x), sweep = (side === 'left' ? 1 : -1) * Math.PI / 2;
    const fit = Array.from({ length: 12 }, (_, i) => i === 0 ? copy(to) : i === 11 ? copy(from) : { x: center.x + radius * Math.cos(start + sweep * i / 11), y: center.y + radius * Math.sin(start + sweep * i / 11) });
    arcs.push({ curve: curveThrough(fit), from: copy(from), to: copy(to), index: k, height: radius - chord / 2 });
  }
  return arcs;
}

// ---------------------------------------------------------------- compass positions
/** Every point that lies at the two lengths from the two points: both sides, and with the lengths exchanged. */
export function compassChoices(a, b, lengthA, lengthB) {
  const found = [];
  for (const [la, lb, swapped] of lengthA === lengthB ? [[lengthA, lengthB, false]] : [[lengthA, lengthB, false], [lengthB, lengthA, true]]) for (const side of ['left', 'right']) {
    try { const result = compass(a, b, la, lb, side); if (!found.some(f => distance(f.point, result.point) < 1e-9)) found.push({ ...result, side, swapped, lengths: [la, lb] }); } catch { /* this combination does not reach */ }
  }
  if (!found.length) compass(a, b, lengthA, lengthB, 'left'); // raises the explanation
  return found;
}
/** The compass position nearest to a point, among all four. */
export function compassNearest(a, b, lengthA, lengthB, toward) { return compassChoices(a, b, lengthA, lengthB).sort((p, q) => distance(p.point, toward) - distance(q.point, toward))[0]; }
