/**
 * v67: seam treatments at a smooth joint, where two edges run on within 15 degrees of each other and the seam width changes (ET's step,
 * corner record type 3, is the default there; see stepJoint in seam-corners.mjs), as ET 2017's 专用角处理 makes them:
 *   curveStep1  曲线断差1 (record type 11): the wider seam line runs on A past the joint, then straight to the narrower seam line at A + B
 *   curveStep2  曲线断差2 (12): from the joint, a curve to the narrower seam line at A + B
 *   curveStep3  曲线断差3 (13): the wider seam line runs on A, then a curve to the narrower seam line at A + B
 *   singleSquare 单边直角 (9) at a joint: the step moved A along into the narrower side
 *   ventHalf / ventFull  开叉半止口 / 开叉全止口 (16, 17): a vent; the wider edge is the vent, its other end the hem (ventShape)
 * Distances along the narrower side are measured along its edge from the joint. Everything is in one length unit; the contour runs
 * counter-clockwise, the allowance lies on the right of the direction of travel.
 * Measured in ET's own files: on straight edges the straight parts, the ends and the vent's lines are exact. The curves of
 * 曲线断差2 and 3 are fitted to ET's (ET stores them as many sampled points of a curve it does not keep): 3 within 0.05 mm, 2 within
 * 0.5 mm over 17 cases; the vent's top curve is ET's own spline through three points, its middle point fitted. On a curved vent
 * edge ET mirrors the net side about a straight line (v75, curvedVent below; up to v74 the page laid the facing along the vent's
 * chord, up to 10 mm off): within 0.92 mm of ET's 32 probe vents.
 */
import { fitClampedSpline } from './fit-spline.mjs';
import { sampleCurve, evaluateBSpline } from './curves.mjs';

const add = (a, b, f = 1) => ({ x: a.x + b.x * f, y: a.y + b.y * f }), sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a, b) => a.x * b.x + a.y * b.y, cross = (a, b) => a.x * b.y - a.y * b.x, len = a => Math.hypot(a.x, a.y), neg = a => ({ x: -a.x, y: -a.y });
const unit = a => { const d = len(a); if (!(d > 1e-12)) throw new Error('边在转角处长度为零。'); return { x: a.x / d, y: a.y / d }; };
const meet = (p, d, q, e) => { const den = cross(d, e); return Math.abs(den) < 1e-12 ? null : add(p, d, cross(sub(q, p), e) / den); };
export const JOINT_KINDS = ['curveStep1', 'curveStep2', 'curveStep3'];
export const VENT_KINDS = ['ventHalf', 'ventFull'];

/** A point and the direction of travel at distance L along a polyline (beyond its end it runs straight on). */
export function along(points, L) {
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], d = len(sub(b, a));
    if (!(d > 0)) continue;
    if (walked + d >= L || i === points.length - 1) { const t = unit(sub(b, a)); return { point: add(a, t, L - walked), tangent: t }; }
    walked += d;
  }
  throw new Error('边长度为零。');
}
/** The net points of a polyline from its start up to distance L, ending exactly there. */
function netUpTo(points, L) {
  const out = [points[0]]; let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], d = len(sub(b, a));
    if (walked + d >= L) { out.push(add(a, unit(sub(b, a)), L - walked)); return out; }
    out.push(b); walked += d;
  }
  out.push(along(points, L).point); return out;
}
// normalised curve shapes from (0, 0) to (1, 1): u along the edge (share of the curve's length along it), v share of the width change
// 曲线断差3: close to a conic through ET's points (0.0006 of the width change), the same for every A
function stepCurve3(t) { const w = .869, b0 = (1 - t) ** 2, b1 = 2 * w * t * (1 - t), b2 = t * t, D = b0 + b1 + b2; return { u: (b1 * .468 + b2) / D, v: (b1 * .944 + b2) / D }; }
// 曲线断差2: from the joint (u along the whole A + B here); a cubic whose first handle runs along the wider seam line, its handles a
// rule of r = A / (A + B) and l = ln(B / width change), both held in the range measured (r up to 0.9, B from 0.2 to 5 times the width
// change). Fitted to ET's curves: 17 cases, worst 0.47 mm, mean 0.37 mm; with A = 0 it is 曲线断差3.
const STEP2 = [2.12884, -1.16607, -0.136782, 0.222836, 0.722155, 0.0156911, 0.720845, 0.248023, 0.0487983];
function stepCurve2(t, A, B, change) {
  const r = Math.min(Math.max(A / (A + B), 0), .9), l = Math.min(Math.max(Math.log(B / change), Math.log(.2)), Math.log(5)), k = STEP2;
  const p1 = { u: r * (k[0] + k[1] * r + k[2] * l), v: 0 }, p2 = { u: k[3] + k[4] * r + k[5] * l, v: k[6] + k[7] * r + k[8] * l }, b = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3];
  return { u: b[1] * p1.u + b[2] * p2.u + b[3], v: b[1] * p1.v + b[2] * p2.v + b[3] };
}
/** The curve of a step between S on the wider seam line and E on the narrower one, laid along `alongEdge` (towards the narrower side). */
function shapedStep(S, E, alongEdge, shape) {
  const inward = { x: -alongEdge.y, y: alongEdge.x }, ds = dot(sub(E, S), alongEdge), dw = dot(sub(E, S), inward), points = [];
  for (let i = 0; i <= 24; i++) { const { u, v } = shape(i / 24); points.push(add(add(S, alongEdge, ds * u), inward, dw * v)); }
  points[0] = S; points[points.length - 1] = E; return points;
}
/**
 * The seam line at a smooth joint between `wide` and `narrow`, from the wider seam line to the narrower one.
 *   wide:   { tangent (unit, at the joint, pointing into the narrower side), normal (unit, outwards), width }
 *   narrow: { points (its edge from the joint into the narrower side), normal(i) is not needed: outward = sign * left of travel, width, outwardSign }
 * Returns { wideEnd, narrowStart, path } (path from wideEnd to narrowStart) and `region`, the polygon between the net edges and the
 * new seam line (to add to the allowance).
 */
export function jointShape(kind, vertex, wide, narrow, params) {
  const outAt = (L) => { const { point, tangent } = along(narrow.points, L), n = narrow.outwardSign > 0 ? { x: tangent.y, y: -tangent.x } : { x: -tangent.y, y: tangent.x }; return { net: point, seam: add(point, n, narrow.width), tangent }; };
  const W0 = add(vertex, wide.normal, wide.width), A = params.extend ?? params.size ?? 0, B = params.run ?? 0;
  if (!(A >= 0) || !(B >= 0)) throw new Error('A、B 值无效。');
  if (!(wide.width > narrow.width)) throw new Error('这个转角两边缝份一样宽，没有断差。');
  const WA = add(W0, wide.tangent, A);
  let path, reach;
  if (kind === 'singleSquare') {
    const at = outAt(A); reach = A;
    path = [WA, meet(WA, wide.normal, at.seam, at.tangent) || at.seam];
  } else {
    if (!(A + B > 0)) throw new Error('A 与 B 不能都为 0。');
    reach = A + B; const end = outAt(A + B).seam;
    if (kind === 'curveStep1') path = [WA, end];
    else if (kind === 'curveStep3') path = B > 0 ? shapedStep(WA, end, wide.tangent, stepCurve3) : [WA, end];
    else if (kind === 'curveStep2') path = shapedStep(W0, end, wide.tangent, t => stepCurve2(t, A, B, wide.width - narrow.width));
    else throw new Error('不认识的断差处理“' + kind + '”。');
  }
  const net = netUpTo(narrow.points, reach);
  // the region reaches 0.05 mm into the wider side, past the step it replaces: on a curve the two normals at the joint differ a little
  // and a region ending exactly on the step left a needle behind
  const back = neg(wide.tangent), m = .05;
  return { wideEnd: path[0], narrowStart: path.at(-1), path, reach, region: [...net.slice().reverse(), add(vertex, back, m), add(W0, back, m), W0, ...path, outAt(reach).seam].filter((p, i, all) => !i || len(sub(p, all[i - 1])) > 1e-9) };
}
/**
 * ET's 开叉半止口 and 开叉全止口 (records 16 and 17, sizes A, B, C, D) on a vent: the vent edge `vent` is the wider edge of a smooth joint
 * with `narrow`; its other end is the hem corner. In the vent's frame at the joint (s along the edges into the narrower side, w out from
 * the net edge; ww the vent's width, its seam line the fold, wn the narrower width):
 *   the narrower seam line ends at s = A + B; a curve K1 runs from there to the fold point (s = C, w = ww); K2 is its mirror about the
 *   fold; 半止口: at s = A + B a line out to the facing edge w = 2ww + D, which runs down to the hem's seam line (carried out to it), a
 *   solid line stays at w = 2ww when D > 0; 全止口: a second fold at w = 2ww, K1 moved out by 2ww, the outer edge w = 3ww from s = C
 *   down (D not used). Both: the vent's seam line becomes a dashed fold from s = C down; a line from the fold at s = 0 to the net edge at
 *   s = B. Straight vents as ET; a curved vent edge (one with fit points that bend: `vent.fit`) is mirrored as ET does it (curvedVent).
 *   vent:  { tangent (unit, at the joint, pointing into the narrower side), normal, width, points (its edge from the joint to the hem corner) }
 *   narrow: as for jointShape;  hem: { seamPoint, tangent } a point of the hem's seam line and its direction
 * Returns { foldPoint, narrowStart, k1, outline (from the fold point outwards to the hem's seam line), lines: [{ points, dashed }],
 * hemStart (where the hem's seam line now begins), foldLine, region, zone, etParts }. zone: the narrower edge's seam band from the
 * joint to s = A + B, to cut away before the region is added (a long, shallow K1 runs inside it next to N, and ET draws it there). etParts are the extra curves as ET writes them, in its
 * order, all hanging in the vent edge's links: { kind: 'spline' (fit points) | 'spline3' (a straight curve through three points) |
 * 'line', points, dashed, down (runs from the top to the hem: ET writes it in the vent edge's own direction), inside (a line inside the
 * allowance, not part of the cut outline: ET marks it with 32 in the curve's attribute word) }.
 */
export function ventShape(kind, vertex, vent, narrow, hem, { a = 0, b = 0, c = 0, d = 0 }) {
  if (!VENT_KINDS.includes(kind)) throw new Error('不认识的开叉处理“' + kind + '”。');
  for (const value of [a, b, c, d]) if (!(value >= 0)) throw new Error('开叉的 A、B、C、D 值无效。');
  const ww = vent.width, wn = narrow.width;
  if (!(ww > wn)) throw new Error('开叉的边要比相接的边缝份宽。');
  if (!(a + b > c)) throw new Error('开叉的 A + B 要大于 C。');
  const outAt = (L) => { const { point, tangent } = along(narrow.points, L), n = narrow.outwardSign > 0 ? { x: tangent.y, y: -tangent.x } : { x: -tangent.y, y: tangent.x }; return { net: point, seam: add(point, n, wn), tangent }; };
  // a straight vent's frame: s from its hem corner to the joint (towards the narrower side), n outwards
  const hemCorner = vent.points.at(-1), sAxis = vent.points.length > 2 ? unit(sub(vertex, hemCorner)) : vent.tangent, nAxis = vent.normal;
  const P = (s, w) => add(add(vertex, sAxis, s), nAxis, w), top = a + b;
  // v75: on a curved vent ET sets the fold point in a frame at the joint taken from a chord of the vent's spline (here: over the first
  // half of its first piece; within 0.34 mm of ET's point, the spline's own tangent misses by up to 1.3 mm)
  const fit = curvedFit(vent, vertex), frame = fit ? jointFrame(fit, vent.normal) : { tangent: vent.tangent, normal: vent.normal };
  const N = outAt(top).seam, F = add(add(vertex, frame.normal, ww), frame.tangent, c);
  const mirror = p => add(p, nAxis, -2 * dot(sub(p, F), nAxis));
  const k1Fit = fit ? ventMiddle(N, F, frame.tangent, frame.normal, kind === 'ventFull' && frame.normal.x > 1e-9) : ventMiddle(N, F, sAxis, nAxis, kind === 'ventFull' && nAxis.x > 1e-9), k1 = splinePoints(k1Fit), k2Out = splinePoints(k1Fit.map(mirror)).reverse();   // K2 from the fold point outwards
  const hemMeet = w => meet(P(0, w), sAxis, hem.seamPoint, hem.tangent);
  // the fold is the vent's own seam line: from F straight back to the joint's offset, then along the vent edge at the vent's width
  // (a curved vent's too, as ET draws it), to where it meets the hem's seam line
  const across = d => { const n = { x: -d.y, y: d.x }; return dot(n, vent.normal) >= 0 ? n : neg(n); }, fold = [F, add(vertex, frame.normal, ww)];
  for (let i = 1; i < vent.points.length; i++) {
    const a = vent.points[i - 1], b = vent.points[i], d = sub(b, a); if (!(len(d) > 1e-9)) continue;
    const prev = i > 1 ? unit(sub(a, vent.points[i - 2])) : unit(d), here = unit(d), mean = unit(add(prev, here)), n = across(mean), stretch = 1 / Math.max(.2, dot(across(here), n));
    if (i > 1) fold.push(add(a, n, ww * stretch));
    if (i === vent.points.length - 1) fold.push(add(b, across(here), ww));
  }
  let foldBottom = null;
  for (let i = 1; i < fold.length && !foldBottom; i++) {   // the first crossing with the hem's seam line, or the last part carried on to it
    const a = fold[i - 1], b = fold[i], d = sub(b, a), x = meet(a, d, hem.seamPoint, hem.tangent); if (!x) continue;
    const t = dot(sub(x, a), d) / dot(d, d); if (t >= -1e-9 && (t <= 1 + 1e-9 || i === fold.length - 1)) { fold.length = i; fold.push(x); foldBottom = x; }
  }
  if (!foldBottom) { foldBottom = hemMeet(ww); fold.push(foldBottom); }
  const foldLine = fold.filter((p, i, all) => !i || len(sub(p, all[i - 1])) > 1e-9), lines = [];
  if (fit) return curvedVent(kind, vertex, vent, narrow, hem, { b, d, ww, top, N, F, k1Fit, k1, outAt, fit, foldLine, foldBottom, frame });
  let outward, outerBottom;
  if (kind === 'ventHalf') {
    const edgeW = 2 * ww + d; outerBottom = hemMeet(edgeW);
    outward = [...k2Out, P(top, edgeW), outerBottom];
    if (d > 0) lines.push({ points: [P(top, 2 * ww), hemMeet(2 * ww)], dashed: false });
  } else {
    const k3 = k1.map(p => add(p, nAxis, 2 * ww)); outerBottom = hemMeet(3 * ww);
    outward = [...k2Out, P(top, 2 * ww), ...k3, outerBottom];
    lines.push({ points: [P(top, 2 * ww), hemMeet(2 * ww)], dashed: true });
  }
  lines.push({ points: [add(vertex, vent.normal, ww), outAt(b).net], dashed: false });
  // ET's order, as its files keep it: K1 and K2 from the narrower seam line's end to the fold point, 全止口 K3 (K1 moved out by 2ww),
  // the line at s = A + B out from K2's end, the line from the fold at the joint to the net edge at s = B, 全止口 the line in from K3's
  // end, then down to the hem: 半止口 the solid line at 2ww (D > 0) and the facing edge; 全止口 the second fold and the outer edge
  const out2 = p => add(p, nAxis, 2 * ww), etParts = [{ kind: 'spline', points: k1Fit }, { kind: 'spline', points: k1Fit.map(mirror) }];
  if (kind === 'ventFull') etParts.push({ kind: 'spline', points: k1Fit.map(out2) });
  etParts.push({ kind: 'line', points: [mirror(N), P(top, kind === 'ventHalf' ? 2 * ww + d : 2 * ww)] }, { kind: 'line', points: [add(vertex, vent.normal, ww), outAt(b).net], inside: true });
  if (kind === 'ventFull') etParts.push({ kind: 'line', points: [out2(N), P(top, 2 * ww)] }, { kind: 'line', points: [P(top, 2 * ww), hemMeet(2 * ww)], dashed: true, down: true, inside: true }, { kind: 'spline3', points: [out2(F), outerBottom], down: true });
  else { if (d > 0) etParts.push({ kind: 'line', points: [P(top, 2 * ww), hemMeet(2 * ww)], down: true, inside: true }); etParts.push({ kind: 'line', points: [P(top, 2 * ww + d), outerBottom], down: true }); }
  const net = netUpTo(narrow.points, top);
  const region = [...net.slice().reverse(), ...vent.points.slice(1), foldBottom, ...outward.slice().reverse(), ...k1.slice().reverse()].filter((p, i, all) => !i || len(sub(p, all[i - 1])) > 1e-9);
  const zone = [];
  for (let i = 0; i <= 24; i++) zone.push(along(narrow.points, top * i / 24).point);
  for (let i = 24; i >= 0; i--) zone.push(outAt(top * i / 24).seam);
  return { foldPoint: F, narrowStart: N, k1, k1Fit, outward, foldLine, lines, hemStart: outerBottom, region, zone, etParts };
}
/**
 * The three fit points of the vent's top curve K1: its ends and a middle point on the chord's perpendicular bisector, bulging towards
 * the narrower seam line (fitted to ET's curves: the bulge as a share of the chord, by the chord's angle to the edge). `flat`: ET's
 * 开叉全止口 on a vent whose outside faces +x puts the middle point at a twelfth of the chord whatever the angle (both such vents it
 * drew, straight and curved; its 开叉半止口 there and every other vent follow the angle).
 */
export function ventMiddle(N, F, sAxis, nAxis, flat = false) {
  const chord = sub(F, N), c = len(chord), mid = add(N, chord, .5);
  let across = { x: -chord.y / c, y: chord.x / c };
  const inner = add(F, nAxis, -dot(sub(F, N), nAxis));   // the fold point's place on the narrower seam line's level
  if (dot(sub(inner, mid), across) < 0) across = neg(across);
  const theta = Math.atan2(Math.abs(dot(chord, nAxis)), Math.abs(dot(chord, sAxis))) * 180 / Math.PI;
  return [N, add(mid, across, c * (flat ? 1 / 12 : ventBulge(theta))), F];
}
export function ventBulge(theta) {
  const table = [[0, .086], [11.31, .0997], [18.43, .1097], [29.05, .1238], [30.96, .1262], [32.83, .1285], [33.69, .1296], [45, .1422], [90, .2]];
  for (let i = 1; i < table.length; i++) if (theta <= table[i][0]) { const [a0, b0] = table[i - 1], [a1, b1] = table[i]; return b0 + (b1 - b0) * (theta - a0) / (a1 - a0); }
  return table.at(-1)[1];
}
function splinePoints(fit) { const s = fitClampedSpline(fit); return sampleCurve({ ...s.curve, samplingTolerance: .002 }).points; }
/** The fit points of a curved vent edge, from the joint to the hem corner, or null for a straight one. */
function curvedFit(vent, vertex) {
  const fit = vent.fit; if (!fit || fit.length < 3) return null;
  const run = len(sub(fit[0], vertex)) <= len(sub(fit.at(-1), vertex)) ? fit : [...fit].reverse(), chord = sub(run.at(-1), run[0]), c = len(chord);
  if (!(c > 1e-9)) return null;
  return run.slice(1, -1).some(p => Math.abs(cross(chord, sub(p, run[0]))) / c > 1e-3) ? run : null;
}
/** The frame at the joint of a curved vent: along the chord of its spline over the first half of the first piece, into the narrower side. */
function jointFrame(fit, normal) {
  const spline = fitClampedSpline(fit).curve, U = spline.knots, breaks = [...new Set(U)], Q = evaluateBSpline(spline.controlPoints, U, breaks[0] + (breaks[1] - breaks[0]) / 2, 3);
  const tangent = unit(sub(fit[0], Q)), n = { x: tangent.y, y: -tangent.x };
  return { tangent, normal: dot(n, normal) >= 0 ? n : neg(n) };
}
const reflectAbout = (o, u) => p => { const v = sub(p, o); return add(o, add(neg(v), u, 2 * dot(v, u))); };   // about the line through o along u
const turnAbout = u => v => add(neg(v), u, 2 * dot(v, u));
/** A polyline moved out by `dist` on the side `side` points to, its ends kept on the lines (p, d) and (q, e). */
function offsetBetween(points, dist, side, p, d, q, e) {
  const normal = i => { const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)], t = unit(sub(b, a)), n = { x: -t.y, y: t.x }; return dot(n, side) >= 0 ? n : neg(n); };
  const moved = points.map((pt, i) => add(pt, normal(i), dist));
  const top = meet(moved[0], sub(moved[1], moved[0]), p, d) || moved[0], bottom = meet(moved.at(-1), sub(moved.at(-1), moved.at(-2)), q, e) || moved.at(-1);
  return [top, ...moved.slice(1, -1), bottom];
}
/** Up to `count` points of a polyline, evenly by length, both ends kept: the fit points ET gets for a curve made of many points. */
function thinned(points, count = 12) {
  const at = [0]; for (let i = 1; i < points.length; i++) at.push(at[i - 1] + len(sub(points[i], points[i - 1])));
  if (points.length <= count) return points;
  const out = [points[0]]; let j = 1;
  for (let k = 1; k < count - 1; k++) { const s = at.at(-1) * k / (count - 1); while (j < points.length - 1 && at[j] < s) j++; out.push(points[j]); }
  out.push(points.at(-1)); return out.filter((pt, i, all) => !i || len(sub(pt, all[i - 1])) > 1e-9);
}
/**
 * v75: ET's 开叉半止口 and 开叉全止口 on a curved vent edge, as ET's own saves of eight made-up pieces with curved vents show (four
 * runs): ET mirrors the net side about one straight line instead of laying the facing along the vent's chord.
 * The line runs from the fold point F (s = C) to the hem corner H moved out by ww; ET takes the direction there from a chord of its
 * own (here: square to the chord over the last third of the spline's last piece, within 0.23 mm of ET's point). K2 is the image of K1,
 * the line at s = A + B the image of the narrower edge's normal there; the 2ww line is ET's spline through the images of the vent's
 * fit points (the hem corner's image left out when it comes within ww / 3 of the hem's seam line), from the line at s = A + B to
 * the hem's seam line; 半止口: the facing edge is the 2ww line moved out by D; 全止口: the 2ww line is the second fold, and a second
 * line through its first point and the hem corner's image mirrors K2 into K3 and the fold into the outer edge.
 */
function curvedVent(kind, vertex, vent, narrow, hem, { b, d, ww, top, N, F, k1Fit, k1, outAt, fit, foldLine, foldBottom, frame }) {
  const H = fit.at(-1), spline = fitClampedSpline(fit).curve, U = spline.knots, breaks = [...new Set(U)], tEnd = breaks.at(-1), span = tEnd - breaks.at(-2);
  const Q = evaluateBSpline(spline.controlPoints, U, tEnd - span / 3, 3), chord = unit(sub(H, Q));
  let nH = { x: -chord.y, y: chord.x }; if (dot(nH, sub(F, H)) < 0) nH = neg(nH);
  const X = add(H, nH, ww), axis = unit(sub(X, F)), m1 = reflectAbout(F, axis), t1 = turnAbout(axis);
  // the fold near the hem: through that point at the hem corner, then on along the same chord to the hem's seam line (as ET's fold runs)
  const Xend = meet(X, chord, hem.seamPoint, hem.tangent), keep = foldLine.filter(p => dot(sub(p, X), chord) < -1e-6);
  if (Xend && dot(sub(Xend, X), chord) > 0 && keep.length >= 2) { foldLine = [...keep, X, Xend]; foldBottom = Xend; }
  const k2Fit = k1Fit.map(m1), k2Out = splinePoints(k2Fit).reverse(), N1 = m1(N);
  const at = outAt(top), sDir = t1(unit(sub(at.net, at.seam)));   // the line at s = A + B: the image of the narrower edge's normal, outwards from N'
  const ctrl = spline.controlPoints, tH = unit(sub(H, ctrl[ctrl.length - 3]));   // down the vent at the hem corner
  const p1 = meet(N1, sDir, m1(fit[0]), t1(frame.tangent)) || m1(fit[0]), pEnd = meet(m1(H), t1(tH), hem.seamPoint, hem.tangent) || m1(H);
  const images = fit.map(m1); if (len(sub(images.at(-1), pEnd)) < ww / 3) images.pop();
  const twoFit = [p1, ...images, pEnd].filter((p, i, all) => !i || len(sub(p, all[i - 1])) > 1e-9), two = splinePoints(twoFit);
  const awayFromFold = { x: -axis.y, y: axis.x }, away = dot(awayFromFold, sub(p1, F)) >= 0 ? awayFromFold : neg(awayFromFold);
  const lines = [], etParts = [{ kind: 'spline', points: k1Fit }, { kind: 'spline', points: k2Fit }];
  let outward, outerBottom;
  if (kind === 'ventHalf') {
    const facing = d > 0 ? offsetBetween(two, d, away, N1, sDir, hem.seamPoint, hem.tangent) : two;
    outward = [...k2Out, ...facing]; outerBottom = facing.at(-1);
    if (d > 0) lines.push({ points: two, dashed: false });
    etParts.push({ kind: 'line', points: [N1, facing[0]] }, { kind: 'line', points: [add(vertex, frame.normal, ww), outAt(b).net], inside: true });
    if (d > 0) etParts.push({ kind: 'spline', points: twoFit, down: true, inside: true });
    etParts.push({ kind: 'spline', points: d > 0 ? thinned(facing) : twoFit, down: true });
  } else {
    const m2 = reflectAbout(p1, unit(sub(m1(H), p1))), k3Fit = k2Fit.map(m2), k3 = splinePoints(k3Fit);
    // the outer edge: the image of the fold, cut at the hem's seam line (or carried on to it)
    const raw = foldLine.map(m2); let outer = null;
    for (let i = 1; i < raw.length && !outer; i++) { const a = raw[i - 1], e = sub(raw[i], a), x = meet(a, e, hem.seamPoint, hem.tangent); if (!x) continue; const t = dot(sub(x, a), e) / dot(e, e); if (t >= -1e-9 && (t <= 1 + 1e-9 || i === raw.length - 1)) outer = [...raw.slice(0, i), x]; }
    if (!outer) outer = raw;
    outward = [...k2Out, p1, ...k3, ...outer]; outerBottom = outer.at(-1);
    lines.push({ points: two, dashed: true });
    etParts.push({ kind: 'spline', points: k3Fit }, { kind: 'line', points: [N1, p1] }, { kind: 'line', points: [add(vertex, frame.normal, ww), outAt(b).net], inside: true },
      { kind: 'line', points: [m2(N1), p1] }, { kind: 'spline', points: twoFit, dashed: true, down: true, inside: true }, { kind: 'spline', points: thinned(outer), down: true });
  }
  lines.push({ points: [add(vertex, frame.normal, ww), outAt(b).net], dashed: false });
  const net = netUpTo(narrow.points, top);
  const region = [...net.slice().reverse(), ...vent.points.slice(1), foldBottom, ...outward.slice().reverse(), ...k1.slice().reverse()].filter((p, i, all) => !i || len(sub(p, all[i - 1])) > 1e-9);
  const zone = [];
  for (let i = 0; i <= 24; i++) zone.push(along(narrow.points, top * i / 24).point);
  for (let i = 24; i >= 0; i--) zone.push(outAt(top * i / 24).seam);
  return { foldPoint: F, narrowStart: N, k1, k1Fit, outward, foldLine, lines, hemStart: outerBottom, region, zone, etParts };
}
