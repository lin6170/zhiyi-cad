/**
 * v63: ET's tools for corners and curves: 圆角处理 between any two lines or curves, 定长调曲线, 曲线端矢调整 and 接角圆顺.
 * What ET 2017 did with probe files, and how it is followed here:
 *  - 圆角处理 with one radius: a circular arc that touches both lines; each line is cut where the arc touches it and keeps
 *    the part away from the corner. Two straight lines keep the formula of construct.fillet (compared with ET in v48).
 *    Next to a curve the arc is found exactly; ET finds it on the polyline it displays, so its arc and cut points can
 *    lie a few tenths of a millimetre from the exact ones.
 *  - with two distances (ET's two radii): each line is cut at its own distance from the corner, measured along it (along
 *    a curve as well), and the two cut points are joined by the cubic Bezier [P1, T, P2, P2]: P1 on the first line
 *    picked, P2 on the second, T where the tangents at the two cut points meet (the corner itself for straight lines).
 *    ET's curves lay within 0.008 mm of that Bezier between straight lines and within 0.05 mm next to curves (ET takes
 *    the tangents from its display polyline). The curve is kept as a curve through points within 0.01 mm of the Bezier.
 *  - 切角: the two cut points are joined by a straight line.
 *  - 定长调曲线: one curve point is moved; the two ends and the points named as fixed stay; every other curve point moves
 *    along the normal of the chord between the two ends of the curve by one amount times its weight, and the amount is
 *    found so that the curve keeps its length. The weight falls in a straight line from 1 at the moved point to 0 at
 *    the two ends, by length along the polygon of curve points; fixed points keep their place without changing the
 *    weights of the others. Both were seen in ET (the normal, and fixed points), but ET's exact sharing was not found:
 *    after the same move ET's points lay within 0.37 mm of the ones here in 14 of 15 runs and 0.94 mm in one, and ET
 *    kept the length only within 0.08 mm.
 *  - 曲线端矢调整: every curve point Q between the ends moves towards Q turned about the end E by the turn, by the weight
 *    |Q - F|^2 / (|Q - E|^2 + |Q - F|^2) (F the other end); the two ends stay. This is ET's rule: six turns made in ET
 *    were repeated within 0.002 mm. ET measures a turn from the direction of its display polyline at the end; here the
 *    direction of an end is taken over its last 3 mm, as everywhere else in the editor.
 *  - 接角圆顺: the second line and its seam line are turned about the end of that seam line where it meets the line, and
 *    moved, until that seam line lies on the first one (joint on joint, direction on direction): the two lines then run
 *    on across the seam as they will after sewing. ET shows them so and lets their points be dragged; a point dragged
 *    there goes back with the opposite move (two drags in ET agreed with this exactly). Here points are moved by giving
 *    where they go in that joined view, or the ends of the two curves are turned with the rule of 曲线端矢调整 until they
 *    meet the seam square (mode square) or run on in one direction (mode smooth). ET has no automatic version.
 * Millimetres, y up. Pure functions, no DOM.
 */
import { fitClampedSpline } from './fit-spline.mjs';
import { curveLength } from './curves.mjs';
import * as trim from './construct-trim.mjs';
import { arcCurve, fillet as straightFillet, kindOf } from './construct.mjs';

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y }), scale = (v, k) => ({ x: v.x * k, y: v.y * k });
const dot = (a, b) => a.x * b.x + a.y * b.y, cross = (a, b) => a.x * b.y - a.y * b.x, norm = v => Math.hypot(v.x, v.y), distance = (a, b) => norm(sub(a, b));
const left = v => ({ x: -v.y, y: v.x }), negate = v => ({ x: -v.x, y: -v.y }), copy = p => ({ x: p.x, y: p.y });
const turnBy = (v, a) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });
const angleFrom = (u, v) => Math.atan2(cross(u, v), dot(u, v));   // the signed angle that turns u onto v
function unit(v, message = '方向无法确定。') { const n = norm(v); if (!(n > 1e-12)) throw new Error(message); return { x: v.x / n, y: v.y / n }; }
const positive = (value, name) => { if (!(typeof value === 'number' && value > 0 && value <= 100000)) throw new Error(name + '须大于 0 且不超过 100000 mm。'); return value; };
const lengthOfFit = points => curveLength(fitClampedSpline(points).curve).value;
const isCurve = entity => Boolean(entity && entity.curve);

// ---------------------------------------------------------------- a corner and the two lines seen from it
function straightMeeting(a, b, c, d) {
  const u = sub(b, a), v = sub(d, c), k = cross(u, v);
  if (Math.abs(k) <= 1e-9 * norm(u) * norm(v)) throw new Error('两条线平行，没有交点。');
  return add(a, scale(u, cross(sub(c, a), v) / k));
}
/** The corner of two lines: where they cross or touch (the crossing nearest to the picked points), else where a straight line's extension meets the other. */
export function cornerOf(first, second, { firstNear, secondNear } = {}) {
  const hits = trim.crossings(first, second), ends = e => [e.points[0], e.points.at(-1)];
  for (const p of ends(first)) for (const q of ends(second)) if (distance(p, q) < 1e-4 && !hits.some(hit => distance(hit.point, p) < 1e-4)) hits.push({ point: copy(p) });   // two lines that only touch at their ends
  if (hits.length) {
    if (hits.length === 1 || !(firstNear || secondNear)) return copy(hits[0].point);
    const away = q => (firstNear ? distance(q, firstNear) : 0) + (secondNear ? distance(q, secondNear) : 0);
    return copy(hits.reduce((best, hit) => (away(hit.point) < away(best.point) ? hit : best)).point);
  }
  const straight = [first, second].map(e => kindOf(e) === 'line');
  if (straight[0] && straight[1]) return straightMeeting(first.points[0], first.points[1], second.points[0], second.points[1]);
  for (const [line, other] of straight[0] ? [[first, second]] : straight[1] ? [[second, first]] : []) {
    const [a, b] = line.points, d = scale(unit(sub(b, a), '直线长度为零。'), 1e5), found = trim.crossings({ points: [sub(a, d), add(b, d)] }, other);
    if (found.length) { const nearEnd = q => Math.min(distance(q, a), distance(q, b)); return copy(found.reduce((best, hit) => (nearEnd(hit.point) < nearEnd(best.point) ? hit : best)).point); }
  }
  throw new Error('两条线不相交，也没有共同的端点，找不到转角。');
}
/**
 * A line or curve seen from a corner on it (or on the extension of a straight line). The part that stays runs from the
 * corner to one end: with a picked point the end nearer to it is the one that is cut back (as in ET); without one the
 * longer part stays. at(s) gives the point and the direction away from the corner at length s from it; keep(s) the
 * line after it is cut there.
 */
function sideFrom(entity, corner, near, what) {
  if (kindOf(entity) === 'line') {
    const [a, b] = entity.points, far = near ? (distance(near, a) <= distance(near, b) ? 1 : 0) : (distance(corner, a) >= distance(corner, b) ? 0 : 1);
    const end = far ? b : a, reach = distance(corner, end), u = unit(sub(end, corner), what + '的两端都在转角上。');
    const point = s => add(corner, scale(u, s));
    return { reach, curved: false, at: s => ({ point: point(s), direction: u }), keep: s => ({ points: far ? [point(s), copy(b)] : [copy(a), point(s)] }) };
  }
  if (entity.closed) throw new Error(what + '是闭合的图形，不能做圆角。');
  const total = trim.pathLength(entity), found = trim.nearestOnPath(entity, corner);
  if (found.away > 1e-4) throw new Error('转角不在' + what + '上。');
  const sc = found.at, atStart = sc < 1e-6, atEnd = sc > total - 1e-6;
  let forward;
  if (atStart || atEnd) forward = atStart;
  else if (near) forward = trim.nearestOnPath(entity, near).at < sc;   // the picked side is cut back, the other stays
  else forward = total - sc >= sc;
  const reach = forward ? total - sc : sc;
  return { reach, curved: true,
    at: s => { const q = trim.placeAlong(entity, forward ? sc + s : sc - s); return { point: q.point, direction: forward ? q.direction : negate(q.direction) }; },
    keep: s => trim.partBetween(entity, forward ? sc + s : 0, forward ? total : sc - s) };
}
function checkReach(side, s, what) {
  if (!(s < side.reach - 1e-6)) throw new Error('圆角太大：' + what + '从转角起只有 ' + side.reach.toFixed(2) + ' mm，要在 ' + s.toFixed(2) + ' mm 处切开。');
}

// ---------------------------------------------------------------- the piece that joins the two cut points
/** The circle of radius r that touches both lines near the corner: lengths a, b from the corner to where it touches, and its centre. */
function touchingCircle(A, B, r) {
  const uA = A.at(0).direction, uB = B.at(0).direction, turn = Math.sign(cross(uA, uB)), angle = Math.acos(Math.max(-1, Math.min(1, dot(uA, uB))));
  if (!turn || !(angle > 1e-6 && angle < Math.PI - 1e-6)) throw new Error('两条线在转角处成一直线，不能做圆角。');
  const centreA = s => { const q = A.at(s); return add(q.point, scale(left(q.direction), turn * r)); };
  const centreB = s => { const q = B.at(s); return add(q.point, scale(left(q.direction), -turn * r)); };
  const slope = (f, s, reach) => { const h = Math.max(1e-5, r * 1e-5), lo = Math.max(0, s - h), hi = Math.min(reach, s + h); return scale(sub(f(hi), f(lo)), 1 / (hi - lo)); };
  let a = r / Math.tan(angle / 2), b = a, gap = Infinity;
  for (let k = 0; k < 60; k++) {
    a = Math.min(Math.max(a, 1e-9), A.reach); b = Math.min(Math.max(b, 1e-9), B.reach);
    const f = sub(centreA(a), centreB(b)); gap = norm(f); if (gap < 1e-9) break;
    const ja = slope(centreA, a, A.reach), jb = scale(slope(centreB, b, B.reach), -1), det = cross(ja, jb);
    if (!(Math.abs(det) > 1e-14)) break;
    let da = cross(negate(f), jb) / det, db = cross(ja, negate(f)) / det; const step = Math.hypot(da, db), most = Math.max(r, 1);
    if (step > most) { da *= most / step; db *= most / step; }
    a += da; b += db;
  }
  if (!(gap < 1e-6)) throw new Error('找不到同时与两条线相切、半径为 ' + r + ' mm 的圆弧，请改小半径。');
  return { a, b, centre: centreA(a) };
}
function arcJoint(A, B, r) {
  const circle = touchingCircle(A, B, r); checkReach(A, circle.a, '第一条线'); checkReach(B, circle.b, '第二条线');
  const p = A.at(circle.a).point, q = B.at(circle.b).point, c = circle.centre, sweep = angleFrom(sub(p, c), sub(q, c));
  const curve = arcCurve(c, r, Math.atan2(p.y - c.y, p.x - c.x), sweep);
  curve.controlPoints[0] = copy(p); curve.controlPoints[curve.controlPoints.length - 1] = copy(q);   // exactly the touching points, so the lines stay joined
  return { a: circle.a, b: circle.b, joint: { curve }, centre: c };
}
/** ET's curve for two distances: the cubic Bezier [p, t, q, q], t where the tangents at p and q meet. */
export function twoDistanceBezier(p, dp, q, dq) {
  const den = cross(dp, dq); if (!(Math.abs(den) > 1e-12)) throw new Error('两条线在切开处的方向平行，不能连成圆角曲线。');
  const k = cross(sub(q, p), dq) / den, t = add(p, scale(dp, k));
  return [copy(p), t, copy(q), copy(q)];
}
const bezierPoint = (c, u) => { const v = 1 - u; return { x: v * v * v * c[0].x + 3 * u * v * v * c[1].x + 3 * u * u * v * c[2].x + u * u * u * c[3].x, y: v * v * v * c[0].y + 3 * u * v * v * c[1].y + 3 * u * u * v * c[2].y + u * u * u * c[3].y }; };
function curveJoint(A, B, a, b) {
  const qa = A.at(a), qb = B.at(b), bez = twoDistanceBezier(qa.point, qa.direction, qb.point, qb.direction);
  // the tangents must meet on the corner's side of both cut points, or the curve would loop
  if (!(dot(sub(bez[1], qa.point), qa.direction) < 0 && dot(sub(bez[1], qb.point), qb.direction) < 0)) throw new Error('两条线在切开处的方向围不成转角，请改小距离。');
  const target = Array.from({ length: 801 }, (_, i) => bezierPoint(bez, i / 800)), fitted = trim.fitShape(target, [target[0], target[400], target[800]]);
  const curve = fitted ? fitted.curve : { kind: 'bspline', degree: 3, controlPoints: bez, knots: [0, 0, 0, 0, 1, 1, 1, 1], samplingTolerance: .002 };
  return { joint: { curve }, bezier: bez, shapeChangeMm: fitted ? fitted.gap : 0 };
}

/**
 * 圆角处理 between two lines, polylines or curves. style 'round' (default): one radius gives a circular arc, two distances
 * (radius2 given) ET's curve; style 'chamfer' a straight line between the two cut points (radius2 defaults to radius).
 * Returns the shapes of the two lines after the cut ({points} or {curve}), the joining piece, the corner and the cuts.
 */
export function filletBetween(first, second, { radius, radius2, style = 'round', firstNear, secondNear } = {}) {
  positive(radius, '圆角半径'); if (radius2 !== undefined) positive(radius2, '第二个半径');
  if (style !== 'round' && style !== 'chamfer') throw new Error('圆角的做法只能是 round（圆角）或 chamfer（切角）。');
  if (style === 'round' && radius2 === undefined && kindOf(first) === 'line' && kindOf(second) === 'line') {
    const r = straightFillet(first, second, radius, { firstNear, secondNear });
    return { kind: 'arc', first: { points: r.first }, second: { points: r.second }, joint: { curve: r.curve }, corner: r.corner, centre: r.center, tangentPoints: r.tangentPoints, cuts: [r.setback, r.setback] };
  }
  const corner = cornerOf(first, second, { firstNear, secondNear }), A = sideFrom(first, corner, firstNear, '第一条线'), B = sideFrom(second, corner, secondNear, '第二条线');
  const angle = Math.abs(angleFrom(A.at(0).direction, B.at(0).direction));
  if (!(angle > 1e-6 && angle < Math.PI - 1e-6)) throw new Error('两条线在转角处成一直线，不能做圆角。');
  let made, kind;
  if (style === 'chamfer') {
    const a = radius, b = radius2 ?? radius; checkReach(A, a, '第一条线'); checkReach(B, b, '第二条线');
    made = { a, b, joint: { points: [A.at(a).point, B.at(b).point] } }; kind = 'chamfer';
  } else if (radius2 === undefined) { made = arcJoint(A, B, radius); kind = 'arc'; }
  else { checkReach(A, radius, '第一条线'); checkReach(B, radius2, '第二条线'); made = { a: radius, b: radius2, ...curveJoint(A, B, radius, radius2) }; kind = 'curve'; }
  const tangentPoints = [A.at(made.a).point, B.at(made.b).point], firstPart = A.keep(made.a), secondPart = B.keep(made.b);
  // the three lines meet exactly: a curve through points keeps its points in single precision (as ET stores them), so the
  // ends at the two cuts are taken from whichever of the pieces was rounded
  const endNear = (shape, q) => { const tips = shape.curve ? [shape.curve.controlPoints[0], shape.curve.controlPoints.at(-1)] : [shape.points[0], shape.points.at(-1)]; return distance(tips[0], q) <= distance(tips[1], q) ? tips[0] : tips[1]; };
  const moveEnd = (shape, q, to) => { if (!shape.points) return; const i = distance(shape.points[0], q) <= distance(shape.points.at(-1), q) ? 0 : shape.points.length - 1; shape.points[i] = copy(to); };
  if (kind === 'curve') { const c = made.joint.curve.controlPoints; moveEnd(firstPart, tangentPoints[0], c[0]); moveEnd(secondPart, tangentPoints[1], c[c.length - 1]); }
  else if (kind === 'arc') { const c = made.joint.curve.controlPoints; c[0] = copy(endNear(firstPart, tangentPoints[0])); c[c.length - 1] = copy(endNear(secondPart, tangentPoints[1])); }
  else made.joint.points = [copy(endNear(firstPart, tangentPoints[0])), copy(endNear(secondPart, tangentPoints[1]))];
  return { kind, first: firstPart, second: secondPart, joint: made.joint, corner, tangentPoints, cuts: [made.a, made.b],
    ...(made.centre ? { centre: made.centre } : {}), ...(made.bezier ? { bezier: made.bezier, shapeChangeMm: made.shapeChangeMm } : {}) };
}

// ---------------------------------------------------------------- 定长调曲线
/**
 * Weights of the curve points for 定长调曲线: 1 at the moved point (at its new place), falling in a straight line to 0 at
 * the two ends, by length along the polygon of curve points. Fixed points do not move but do not change the weights of
 * the others: this is what ET did (with the second point of a seven-point curve fixed, the others moved as without it).
 */
export function keepLengthWeights(points, index, to, fixed = []) {
  const placed = points.map((p, i) => (i === index ? to : p)), last = placed.length - 1, along = [0];
  for (let i = 1; i <= last; i++) along.push(along[i - 1] + distance(placed[i], placed[i - 1]));
  const still = new Set([0, last, index, ...fixed]);
  return placed.map((_, i) => {
    if (still.has(i)) return 0;
    const w = i < index ? (along[i] - along[0]) / (along[index] - along[0]) : (along[last] - along[i]) / (along[last] - along[index]);
    return Math.max(0, Math.min(1, w));
  });
}
/**
 * 定长调曲线: move curve point `index` to `to` and keep the length of the curve. The ends and the `fixed` points stay;
 * the other points move along the normal of the chord between the ends (see keepLengthWeights).
 */
export function movedKeepingLength(entity, index, to, fixed = []) {
  if (!isCurve(entity)) throw new Error('定长调曲线只用于曲线。');
  if (entity.closed) throw new Error('闭合的曲线请先打断。');
  const own = trim.pointsOf(entity).points, n = own.length;
  if (!Number.isInteger(index) || index < 1 || index > n - 2) throw new Error('要移动的曲线点编号须在 1 到 ' + (n - 2) + ' 之间（这条曲线有 ' + n + ' 个曲线点，两端不能用这个工具移动）。');
  const fixedSet = new Set(fixed);
  if (fixedSet.size !== fixed.length) throw new Error('固定点的编号有重复。');
  for (const k of fixedSet) { if (!Number.isInteger(k) || k < 0 || k >= n) throw new Error('固定点的编号须在 0 到 ' + (n - 1) + ' 之间。'); if (k === index) throw new Error('要移动的点不能同时是固定点。'); }
  const chord = sub(own[n - 1], own[0]); if (!(norm(chord) > 1e-6)) throw new Error('曲线两端重合，没有可以作法线的弦。');
  const normal = left(unit(chord)), weights = keepLengthWeights(own, index, to, [...fixedSet]), free = weights.filter(w => w > 0).length;
  if (!free) throw new Error('没有可以跟着移动的曲线点：除了两端、被移动的点和固定点，至少还要有一个曲线点。');
  const goal = trim.pathLength(entity), size = norm(chord);
  const build = t => own.map((p, i) => (i === index ? copy(to) : weights[i] ? add(p, scale(normal, t * weights[i])) : copy(p)));
  const miss = t => { const pts = build(t); for (let i = 1; i < pts.length; i++) if (distance(pts[i], pts[i - 1]) < 1e-6) return NaN; return lengthOfFit(pts) - goal; };
  // the amount nearest to no change at which the length is right: look outwards on both sides for a change of sign
  const f0 = miss(0); let bracket = null;
  if (Math.abs(f0) < 1e-9) bracket = [0, 0];
  for (let step = size * 1e-4; !bracket && step <= size * 2; step *= 1.15) {   // small steps, so that a narrow dip below the length is not stepped over
    for (const sign of [1, -1]) {
      const lo = sign * step / 1.15, hi = sign * step, flo = step === size * 1e-4 ? f0 : miss(lo), fhi = miss(hi);
      if (Number.isFinite(flo) && Number.isFinite(fhi) && flo * fhi <= 0) { bracket = [lo, hi, flo]; break; }
    }
  }
  if (!bracket) {
    let least = Math.abs(f0); for (let k = -200; k <= 200; k++) { const f = miss(k / 100 * size); if (Number.isFinite(f)) least = Math.min(least, Math.abs(f)); }
    throw new Error('点移到这里以后保持不了原长：其余曲线点怎么移，曲线也还' + (f0 > 0 ? '长' : '短') + ' ' + least.toFixed(2) + ' mm。请少移一些，或少设固定点。');
  }
  let [lo, hi, flo] = bracket;
  for (let k = 0; k < 80 && hi !== lo; k++) { const mid = (lo + hi) / 2, f = miss(mid); if (!Number.isFinite(f)) break; if (Math.sign(f) === Math.sign(flo)) { lo = mid; flo = f; } else hi = mid; if (Math.abs(hi - lo) < 1e-10) break; }
  const amount = (lo + hi) / 2, points = build(amount), curve = fitClampedSpline(points).curve;
  return { curve, points: n, moved: free, amountMm: amount, largestFollowMm: Math.abs(amount) * Math.max(...weights), lengthMm: curveLength(curve).value, goalMm: goal, normal };
}

// ---------------------------------------------------------------- 曲线端矢调整
/** The direction in which a curve leaves one of its ends, into the curve, taken over its last 3 mm. */
export function endDirection(entity, end) { return negate(trim.outwardDirection(entity, end)); }
/** ET's weights for turning the end E of a curve: |Q - F|^2 / (|Q - E|^2 + |Q - F|^2), F the other end. */
export function endTurnWeight(q, e, f) { const de = distance(q, e) ** 2, df = distance(q, f) ** 2; return de + df > 0 ? df / (de + df) : 0; }
/** 曲线端矢调整: turn the end of a curve by `degrees` (counter-clockwise positive) with ET's rule; both ends stay. */
export function turnedEnd(entity, end, degrees) {
  if (!isCurve(entity)) throw new Error('曲线端矢调整只用于曲线。');
  if (end !== 'start' && end !== 'end') throw new Error('需要说明转起点还是终点。');
  if (!(typeof degrees === 'number' && Math.abs(degrees) < 180)) throw new Error('转角须在 -180 到 180 度之间。');
  const own = trim.pointsOf(entity).points, n = own.length;
  if (n < 3) throw new Error('这条曲线只有两个曲线点，没有可以跟着转的点。');
  if (distance(own[0], own[n - 1]) < 1e-6) throw new Error('闭合的曲线没有端点。');
  const e = end === 'start' ? own[0] : own[n - 1], f = end === 'start' ? own[n - 1] : own[0], a = degrees * Math.PI / 180;
  const points = own.map((q, i) => {
    if (i === 0 || i === n - 1) return copy(q);
    const w = endTurnWeight(q, e, f), turned = add(e, turnBy(sub(q, e), a));
    return add(q, scale(sub(turned, q), w));
  });
  return { curve: fitClampedSpline(points).curve, points: n };
}
/** The turn (degrees) that brings the direction of an end towards a point. */
export function turnTowards(entity, end, toward) {
  const e = end === 'start' ? entity.points[0] : entity.points.at(-1), want = sub(toward, e);
  if (!(norm(want) > 1e-6)) throw new Error('方向点不能就在端点上。');
  return angleFrom(endDirection(entity, end), want) * 180 / Math.PI;
}

// ---------------------------------------------------------------- 接角圆顺
/** Which end of a line lies on which end of its seam line (they must meet there). */
function joinOf(line, seam, what, seamWhat) {
  const ends = e => [e.points[0], e.points.at(-1)];
  let best = null;
  ends(line).forEach((p, i) => ends(seam).forEach((q, k) => { const d = distance(p, q); if (!best || d < best.d) best = { d, lineEnd: i ? 'end' : 'start', seamEnd: k ? 'end' : 'start', point: copy(p) }; }));
  if (best.d > .01) throw new Error(what + '和' + seamWhat + '没有接在一起（端点相距 ' + best.d.toFixed(2) + ' mm）。');
  return best;
}
/**
 * The joined view of 接角圆顺: the second line and its seam turned about the joint of that seam and moved onto the first
 * seam. map takes a point of the second line into the view, unmap brings a point of the view back.
 */
export function joinedView(first, second, firstSeam, secondSeam) {
  const ja = joinOf(first, firstSeam, '第一条线', '第一条缝合线'), jb = joinOf(second, secondSeam, '第二条线', '第二条缝合线');
  const da = endDirection(firstSeam, ja.seamEnd), db = endDirection(secondSeam, jb.seamEnd), turn = angleFrom(db, da);
  return { joint: ja.point, from: jb.point, turn, firstEnd: ja.lineEnd, secondEnd: jb.lineEnd, seamDirection: da,
    map: p => add(ja.point, turnBy(sub(p, jb.point), turn)), unmap: p => add(jb.point, turnBy(sub(p, ja.point), -turn)) };
}
/** The angle (degrees) of the bend where the two lines meet in the joined view; 0 when they run on in one direction. */
function bendOf(view, first, second) {
  const arrive = trim.outwardDirection(first, view.firstEnd), leave = turnBy(endDirection(second, view.secondEnd), view.turn);
  return angleFrom(arrive, leave) * 180 / Math.PI;
}
/** Turn the end of a curve until the direction in which it leaves that end is `want` (with ET's rule of 曲线端矢调整). */
function turnUntil(entity, end, want) {
  const direction = degrees => endDirection({ ...entity, curve: turnedEnd(entity, end, degrees).curve }, end);
  let x0 = 0, f0 = angleFrom(endDirection(entity, end), want) * 180 / Math.PI;
  if (Math.abs(f0) < 1e-6) return { curve: entity.curve, degrees: 0 };
  let x1 = f0 * .8, f1 = angleFrom(direction(x1), want) * 180 / Math.PI;
  for (let k = 0; k < 40 && Math.abs(f1) > 1e-6; k++) {   // secant steps on the angle still missing (degrees)
    if (!(Math.abs(f1 - f0) > 1e-12)) break;
    const next = x1 - f1 * (x1 - x0) / (f1 - f0);
    if (!(Math.abs(next) < 170)) throw new Error('曲线端部转不到要求的方向。');
    x0 = x1; f0 = f1; x1 = next; f1 = angleFrom(direction(x1), want) * 180 / Math.PI;
  }
  if (Math.abs(f1) > 1e-4) throw new Error('曲线端部转不到要求的方向。');
  return { curve: turnedEnd(entity, end, x1).curve, degrees: x1 };
}
/**
 * 接角圆顺 of two lines that are sewn together along two seam lines. moves: [{ which: 'first'|'second', index, to }],
 * `to` given in the joined view; or mode 'square' / 'smooth' to turn the ends of the two curves at the joint.
 */
export function smoothedCorner(first, second, firstSeam, secondSeam, { mode, moves } = {}) {
  const view = joinedView(first, second, firstSeam, secondSeam), before = bendOf(view, first, second), out = { first: null, second: null };
  if (moves && moves.length) {
    if (mode) throw new Error('移动曲线点和自动圆顺请分开做。');
    for (const which of ['first', 'second']) {
      const entity = which === 'first' ? first : second, mine = moves.filter(m => m.which === which); if (!mine.length) continue;
      if (!isCurve(entity)) throw new Error((which === 'first' ? '第一条线' : '第二条线') + '是直线，没有曲线点可以移动。');
      const own = trim.pointsOf(entity).points, n = own.length, seen = new Set();
      for (const m of mine) {
        if (!Number.isInteger(m.index) || m.index < 1 || m.index > n - 2) throw new Error('曲线点编号须在 1 到 ' + (n - 2) + ' 之间（两端不移动）。');
        if (seen.has(m.index)) throw new Error('同一个曲线点移动了两次。'); seen.add(m.index);
        own[m.index] = which === 'first' ? copy(m.to) : view.unmap(m.to);
      }
      for (let i = 1; i < n; i++) if (distance(own[i], own[i - 1]) < 1e-6) throw new Error('移动后有两个曲线点重合。');
      out[which] = { curve: fitClampedSpline(own).curve };
    }
  } else {
    if (mode !== 'square' && mode !== 'smooth') throw new Error('需要说明怎样圆顺：square（两条线都与缝合线垂直）或 smooth（顺成一个方向）。');
    for (const [entity, what] of [[first, '第一条线'], [second, '第二条线']]) if (!isCurve(entity)) throw new Error(what + '是直线，不能自动圆顺；请把它改成曲线，或移动曲线点。');
    const arrive = trim.outwardDirection(first, view.firstEnd), leave = turnBy(endDirection(second, view.secondEnd), view.turn);
    let target;
    if (mode === 'square') { const across = left(view.seamDirection); target = dot(across, add(arrive, leave)) >= 0 ? across : negate(across); }
    else { const sum = add(arrive, leave); target = unit(sum, '两条线在接角处方向相反，不能顺成一个方向。'); }
    out.first = turnUntil(first, view.firstEnd, negate(target));
    out.second = turnUntil(second, view.secondEnd, turnBy(target, -view.turn));
  }
  const after = bendOf(view, out.first ? { ...first, curve: out.first.curve } : first, out.second ? { ...second, curve: out.second.curve } : second);
  return { ...out, view, bendBefore: before, bendAfter: after };
}
