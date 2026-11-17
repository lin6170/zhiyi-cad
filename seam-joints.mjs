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
 * edge the facing is laid along the vent's chord (ET's own facing there bends in a way not worked out; up to 7 mm off).
 */
import { fitClampedSpline } from './fit-spline.mjs';
import { sampleCurve } from './curves.mjs';

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
 *   s = B. Straight vents as ET; a curved vent edge is laid along its chord for the facing (the fold follows the curve).
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
  // the facing is laid along the vent's chord from its hem corner to the joint (s towards the narrower side), n outwards
  const hemCorner = vent.points.at(-1), sAxis = vent.points.length > 2 ? unit(sub(vertex, hemCorner)) : vent.tangent, nAxis = vent.normal;
  const P = (s, w) => add(add(vertex, sAxis, s), nAxis, w), top = a + b;
  const N = outAt(top).seam, F = add(add(vertex, vent.normal, ww), vent.tangent, c);
  const mirror = p => add(p, nAxis, -2 * dot(sub(p, F), nAxis));
  const k1Fit = ventMiddle(N, F, sAxis, nAxis, kind === 'ventFull' && nAxis.x > 1e-9), k1 = splinePoints(k1Fit), k2Out = splinePoints(k1Fit.map(mirror)).reverse();   // K2 from the fold point outwards
  const hemMeet = w => meet(P(0, w), sAxis, hem.seamPoint, hem.tangent);
  // the fold is the vent's own seam line: from F straight back to the joint's offset, then along the vent edge at the vent's width
  // (a curved vent's too, as ET draws it), to where it meets the hem's seam line
  const across = d => { const n = { x: -d.y, y: d.x }; return dot(n, vent.normal) >= 0 ? n : neg(n); }, fold = [F, add(vertex, vent.normal, ww)];
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
