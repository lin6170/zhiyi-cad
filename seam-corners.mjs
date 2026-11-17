/**
 * Seam corner treatments, as ET keeps them for single contour corners:
 *   cut   the tip where two seam lines meet is cut off: each seam line stops a given distance before the tip
 *   step  a stepped hem corner: the side seam stops below the hem's seam line, steps in along the hem, then
 *         runs parallel to the side up to the hem's seam line
 *   fold  a fold-back hem corner: the side seam stops on the hem's net line and the hem allowance beyond it
 *         mirrors the side seam, so the folded hem lies exactly on the piece
 * Everything is in one length unit. The contour is walked counter-clockwise: the piece is on the left of the
 * direction of travel, the seam allowance on the right. `arriving` is the edge that ends at the corner and
 * `leaving` the edge that starts there: { tangent: unit vector in the direction of travel, width }.
 * Every function returns { tip, end, start, pieces }: `tip` is where the two seam lines meet, `end` is where the
 * seam line of the arriving edge now stops, `start` where that of the leaving edge begins, and `pieces` are the
 * extra seam lines between them in the direction of travel: { owner: 'arriving' | 'leaving', points }.
 */
const add = (a, b, f = 1) => ({ x: a.x + b.x * f, y: a.y + b.y * f }), sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a, b) => a.x * b.y - a.y * b.x, dot = (a, b) => a.x * b.x + a.y * b.y, right = t => ({ x: t.y, y: -t.x }), left = t => ({ x: -t.y, y: t.x });
const neg = t => ({ x: -t.x, y: -t.y }), unit = t => { const d = Math.hypot(t.x, t.y); return { x: t.x / d, y: t.y / d }; };
const meet = (p, d, q, e) => { const den = cross(d, e); return Math.abs(den) < 1e-12 ? null : add(p, d, cross(sub(q, p), e) / den); };
// mirror a direction, or a point, about a line of direction u (through o)
const mirrorDir = (w, u) => sub({ x: 2 * dot(w, u) * u.x, y: 2 * dot(w, u) * u.y }, w), mirrorPoint = (p, o, u) => add(o, mirrorDir(sub(p, o), u));
const PARALLEL = 1e-6;
/**
 * The treatments and the type byte ET gives them in a 2.0 file (v65 learned the ones after fold, cut and step from ET's 缝边角处理
 * and 专用角处理): fold 反转角 1, square 直角 2 (two pieces), mitre 折叠角 4, extendFold 延长反转角 5 (one corner, shaped by the
 * piece it is sewn to), cut 切角 6, sevenStep 七字角 7, step 偷角处理 8, foldSquare 反转直角 10, foldShift 可调反转 15,
 * doubleExtend 双延长角 18, doubleProject 双投影角 19, boundFold 包边延长反转角 20 (two pieces).
 */
export const CORNER_KINDS = ['cut', 'step', 'fold', 'mitre', 'square', 'extendFold', 'boundFold', 'sevenStep', 'foldSquare', 'foldShift', 'doubleExtend', 'doubleProject'];
export const PAIR_KINDS = ['square', 'extendFold', 'boundFold'];
/** ET's 折叠角 keeps the folded allowances this far (10 mm) from the corner's diagonal; the callers pass it in their own unit. */
export const MITRE_GAP_MM = 10;

function frame(vertex, arriving, leaving) {
  for (const edge of [arriving, leaving]) if (!(edge.width >= 0) || !Number.isFinite(edge.tangent?.x) || !Number.isFinite(edge.tangent?.y)) throw new Error('转角的边数据无效。');
  const turn = cross(arriving.tangent, leaving.tangent);
  if (turn <= PARALLEL) throw new Error('只有向外凸出的转角可以做角处理。');
  const a = add(vertex, right(arriving.tangent), arriving.width), b = add(vertex, right(leaving.tangent), leaving.width);
  return { a, b, tip: meet(a, arriving.tangent, b, leaving.tangent) };
}
/**
 * v67: ET's step where the seam width changes at a smooth joint (two edges running on within 15 degrees; its corner record type 3):
 * the wider seam line ends at its own offset of the joint point and a straight line runs on along the wider edge's normal through
 * the joint to the narrower seam line. Exact against ET on straight edges, also at a bend of 10 degrees.
 */
export function stepJoint(vertex, arriving, leaving) {
  const nA = right(arriving.tangent), nL = right(leaving.tangent);
  if (arriving.width > leaving.width) {
    const end = add(vertex, nA, arriving.width), start = meet(vertex, nA, add(vertex, nL, leaving.width), leaving.tangent) || add(vertex, nL, leaving.width);
    return { tip: end, end, start, pieces: [{ owner: 'arriving', points: [end, start] }] };
  }
  const start = add(vertex, nL, leaving.width), end = meet(vertex, nL, add(vertex, nA, arriving.width), arriving.tangent) || add(vertex, nA, arriving.width);
  return { tip: start, end, start, pieces: [{ owner: 'leaving', points: [end, start] }] };
}
/**
 * v67: ET's 单边直角 (record type 9) at a corner: the seam line of the picked edge runs on `size` past the corner (measured along the
 * edge from the net corner), then a line square to the picked edge runs, whichever way it has to, until it meets the other seam line.
 * Where the two would run side by side (a square corner) ET's own result is broken; the page refuses it.
 */
export function singleSquareCorner(vertex, arriving, leaving, { picked, size }) {
  if (picked !== 'arriving' && picked !== 'leaving') throw new Error('需要说明点的是哪一条边。');
  if (!(size >= 0)) throw new Error('单边直角的 A 值无效。');
  const p = picked === 'arriving' ? arriving : leaving, o = picked === 'arriving' ? leaving : arriving, np = right(p.tangent);
  const past = add(add(vertex, np, p.width), p.tangent, picked === 'arriving' ? size : -size);
  const meetOther = meet(past, np, add(vertex, right(o.tangent), o.width), o.tangent);
  if (!meetOther) throw new Error('方向线与另一条缝边线平行，不能做单边直角。');
  const tip = meet(add(vertex, right(arriving.tangent), arriving.width), arriving.tangent, add(vertex, right(leaving.tangent), leaving.width), leaving.tangent) || past;
  return picked === 'arriving'
    ? { tip, end: past, start: meetOther, pieces: [{ owner: 'arriving', points: [past, meetOther] }] }
    : { tip, end: meetOther, start: past, pieces: [{ owner: 'leaving', points: [meetOther, past] }] };
}
/**
 * v67: ET's 反转翻角 (record type 14) at one end of a hem: a turned-up cuff. The side seam line stops on the hem's net line; mirrored about
 * the hem's normal it runs on `depth` (A) further out; then in the side's own direction again for `rest` (B), to the hem's seam line.
 * ET takes it only when A + B is the hem's width and B is larger than A (checked by the callers).
 */
export function turnUpCorner(vertex, arriving, leaving, { hem, depth, rest }) {
  if (hem !== 'arriving' && hem !== 'leaving') throw new Error('需要说明哪一条是下摆。');
  const h = hem === 'arriving' ? arriving : leaving, s = hem === 'arriving' ? leaving : arriving, nh = right(h.tangent);
  const S0 = meet(add(vertex, right(s.tangent), s.width), s.tangent, vertex, h.tangent);
  if (!S0) throw new Error('侧边与下摆接近平行，不能做反转翻角。');
  const d = hem === 'leaving' ? s.tangent : neg(s.tangent), across = dot(d, nh);   // the side seam going out across the hem line
  if (!(across > PARALLEL)) throw new Error('侧边没有越过下摆，不能做反转翻角。');
  const d1 = add(d, h.tangent, -2 * dot(d, h.tangent)), F1 = add(S0, d1, depth / across), F2 = add(F1, d, rest / across);
  const tip = meet(add(vertex, right(arriving.tangent), arriving.width), arriving.tangent, add(vertex, right(leaving.tangent), leaving.width), leaving.tangent) || F2;
  return hem === 'leaving'
    ? { tip, end: S0, start: F2, fold: F1, pieces: [{ owner: 'leaving', points: [S0, F1, F2] }] }
    : { tip, end: F2, start: S0, fold: F1, pieces: [{ owner: 'arriving', points: [F2, F1, S0] }] };
}
/** The default corner: both seam lines run to the point where they meet. */
export function plainCorner(vertex, arriving, leaving) {
  const a = add(vertex, right(arriving.tangent), arriving.width), b = add(vertex, right(leaving.tangent), leaving.width);
  const tip = meet(a, arriving.tangent, b, leaving.tangent) || add(a, sub(b, a), .5);
  return { tip, end: tip, start: tip, pieces: [] };
}
/** Cut corner: the arriving seam line stops `arrivingCut` before the tip, the leaving one starts `leavingCut` after it. */
export function cutCorner(vertex, arriving, leaving, { arrivingCut, leavingCut, owner = 'arriving' }) {
  if (!(arrivingCut > 0) || !(leavingCut > 0)) throw new Error('切角的两个距离都必须大于 0。');
  const { tip } = frame(vertex, arriving, leaving);
  const end = add(tip, arriving.tangent, -arrivingCut), start = add(tip, leaving.tangent, leavingCut);
  return { tip, end, start, pieces: [{ owner, points: [end, start] }] };
}
/**
 * Stepped hem corner (ET's 偷角处理, type 8). `side` says which of the two edges is the side seam, the one whose seam line steps
 * (in ET the edge picked, the one the record names); the other one is the hem. `drop` is how far inside the hem's seam line the side
 * seam stops; the riser of the step runs parallel to the side, `run` inside the side's seam line (measured square to the side, as ET
 * does). v65: ET takes any two sizes: the step may reach past the hem's allowance (drop 26 on a 10 mm hem when the wider edge is
 * picked) and the riser may lie inside the side's net line (19.05 on a 12.7 mm side in a real back pocket).
 */
export function stepCorner(vertex, arriving, leaving, { side, drop, run }) {
  if (side !== 'arriving' && side !== 'leaving') throw new Error('台阶角需要说明哪一条是侧边。');
  const s = side === 'arriving' ? arriving : leaving, h = side === 'arriving' ? leaving : arriving;
  if (!(drop > 0) || !(run > 0)) throw new Error('台阶角的两个尺寸都必须大于 0。');
  const { tip } = frame(vertex, arriving, leaving);
  const sideSeam = add(vertex, right(s.tangent), s.width), level = add(vertex, right(h.tangent), h.width - drop), hemSeam = add(vertex, right(h.tangent), h.width);
  const riser = add(vertex, right(s.tangent), s.width - run);
  const s1 = meet(sideSeam, s.tangent, level, h.tangent), s2 = meet(riser, s.tangent, level, h.tangent), s3 = meet(riser, s.tangent, hemSeam, h.tangent);
  return side === 'arriving'
    ? { tip, end: s1, start: s3, pieces: [{ owner: 'arriving', points: [s1, s2] }, { owner: 'leaving', points: [s2, s3] }] }
    : { tip, end: s3, start: s1, pieces: [{ owner: 'arriving', points: [s3, s2] }, { owner: 'leaving', points: [s2, s1] }] };
}
/**
 * Fold-back hem corner. `fold` says which edge is the hem that is folded back; the other one is the side.
 * `sidePath`, when given, is the side's seam line as points running from near the corner into the piece; it is
 * used for curved sides. Without it the side seam is taken straight along its tangent.
 */
export function foldCorner(vertex, arriving, leaving, { fold, sidePath = null }) {
  if (fold !== 'arriving' && fold !== 'leaving') throw new Error('反转角需要说明哪一条是折边。');
  const f = fold === 'arriving' ? arriving : leaving, s = fold === 'arriving' ? leaving : arriving;
  if (!(f.width > 0)) throw new Error('折边的缝份宽度必须大于 0。');
  const { tip } = frame(vertex, arriving, leaving), out = right(f.tangent);
  const depth = p => -dot(sub(p, vertex), out);                         // how far a point lies inside the fold line
  const mirror = p => add(p, out, 2 * depth(p));
  // the side seam towards the inside of the piece: away from the corner along the side
  const into = fold === 'arriving' ? s.tangent : { x: -s.tangent.x, y: -s.tangent.y }, sideSeam = add(vertex, right(s.tangent), s.width);
  const straight = d => meet(sideSeam, into, add(vertex, out, -d), f.tangent);
  let at = straight;
  if (sidePath && sidePath.length >= 2) {
    // walk the path, extended straight at both ends, to where it reaches a given depth
    const path = [add(sidePath[0], sub(sidePath[0], sidePath[1]), 1e3), ...sidePath, add(sidePath.at(-1), sub(sidePath.at(-1), sidePath.at(-2)), 1e3)];
    at = d => { for (let i = 1; i < path.length; i++) { const d0 = depth(path[i - 1]) - d, d1 = depth(path[i]) - d; if (d0 <= 0 && d1 > 0) return add(path[i - 1], sub(path[i], path[i - 1]), d0 / (d0 - d1)); } return straight(d); };
  }
  // the flap from the fold line outwards: the side seam of the same depth, mirrored; a curved side gets more points
  const shares = at === straight ? [0, .5, 1] : [0, .25, .5, .75, 1], inside = shares.map(share => at(f.width * share));
  if (inside.some(p => !p)) throw new Error('折边与侧边接近平行，不能做反转角。');
  const flap = inside.map((p, i) => i ? mirror(p) : p), e0 = flap[0], e1 = flap.at(-1);
  // the flap is stored with the fold edge (ET hangs it in that edge's links); v66: ET's extended seam moves it by the side's extension
  return fold === 'leaving'
    ? { tip, end: e0, start: e1, pieces: [{ owner: 'leaving', extensionOwner: 'arriving', smooth: at !== straight, points: flap }] }
    : { tip, end: e1, start: e0, pieces: [{ owner: 'arriving', extensionOwner: 'leaving', smooth: at !== straight, points: [...flap].reverse() }] };
}
/**
 * 折叠角 (ET type 4). Folded onto the piece about its own net edge, each allowance ends on a line parallel to the diagonal from the
 * net corner to the tip, `gap` away from it: the arriving edge's on the left of the diagonal, the leaving edge's on the right. Unfolded,
 * the arriving seam line stops at A, runs to M where the two mirrored lines cross and on to B on the leaving seam line. Checked
 * against ET at corners of 60, 86, 90 and 96 degrees with widths 30/10, 20/20 and 10/30 (0.001 mm); ET refuses the corner when the
 * allowances are too narrow for the gap, and so does this.
 */
export function mitreCorner(vertex, arriving, leaving, { gap }) {
  if (!(gap > 0)) throw new Error('折叠角需要离对角线的距离。');
  const { a, b, tip } = frame(vertex, arriving, leaving), e = unit(sub(tip, vertex)), n = left(e);
  const pa = mirrorPoint(add(vertex, n, gap), vertex, arriving.tangent), da = mirrorDir(e, arriving.tangent);
  const pl = mirrorPoint(add(vertex, n, -gap), vertex, leaving.tangent), dl = mirrorDir(e, leaving.tangent);
  const A = meet(a, arriving.tangent, pa, da), B = meet(b, leaving.tangent, pl, dl), M = Math.abs(cross(da, dl)) < 1e-9 ? pa : meet(pa, da, pl, dl);
  // ET refuses only when both ends fall beyond the tip (allowances narrower than the gap); at an obtuse corner next to a curve one
  // end may lie beyond it and the corner then adds a little allowance there
  if (!A || !B || !M || (dot(sub(tip, A), arriving.tangent) <= 1e-9 && dot(sub(B, tip), leaving.tangent) <= 1e-9)) throw new Error('缝份太窄，做不了折叠角。');
  return { tip, end: A, start: B, pieces: [{ owner: 'arriving', points: [A, M] }, { owner: 'leaving', points: [M, B] }] };
}
/** The sewn edge of a corner (arriving or leaving) and the other one, which crosses the seam it is sewn in. */
function sewnAndCrossing(arriving, leaving, sewn) {
  if (sewn !== 'arriving' && sewn !== 'leaving') throw new Error('需要说明哪一条是缝合的边。');
  const s = sewn === 'arriving' ? arriving : leaving, x = sewn === 'arriving' ? leaving : arriving;
  return { s, x, away: sewn === 'arriving' ? neg(s.tangent) : s.tangent };   // away: along the sewn edge from the corner into the piece
}
/** How far the sewn edge, carried on beyond the corner, runs before it meets the crossing edge's seam line. */
export function sewnReach(vertex, arriving, leaving, { sewn }) {
  const { x, away } = sewnAndCrossing(arriving, leaving, sewn), Q = meet(vertex, neg(away), add(vertex, right(x.tangent), x.width), x.tangent);
  if (!Q) throw new Error('缝合的边与相交的边平行，不能做这个角。');
  return dot(sub(Q, vertex), neg(away));
}
/**
 * 直角 (ET type 2, set on two pieces sewn together). Both pieces carry their sewn edge on beyond the corner by the same `reach`, the
 * longer of the two (ET: whichever piece is picked first); the crossing seam line ends there, at Q, and a segment square to the sewn
 * edge, as long as this piece's own sewn seam width, reaches the sewn seam line. When this piece reaches less far than its partner,
 * Q lies beyond its crossing seam line: `outside` is then true and ET draws the crossing seam line again from its far end to Q.
 */
export function squareCorner(vertex, arriving, leaving, { sewn, reach }) {
  const { s, away } = sewnAndCrossing(arriving, leaving, sewn);
  if (!(reach > 0)) throw new Error('直角的延长距离无效。');
  const { tip } = frame(vertex, arriving, leaving), Q = add(vertex, neg(away), reach), B = add(Q, right(s.tangent), s.width);
  const outside = reach > sewnReach(vertex, arriving, leaving, { sewn }) + 1e-9;
  return sewn === 'arriving'
    ? { tip, end: B, start: Q, pieces: [{ owner: 'arriving', points: [B, Q] }], crossing: 'leaving', outside }
    : { tip, end: Q, start: B, pieces: [{ owner: 'leaving', points: [Q, B] }], crossing: 'arriving', outside };
}
/**
 * The corner of 包边延长反转角 and 延长反转角 (ET types 20 and 5): a straight line `line` ({ point, direction }) replaces the corner
 * between the two seam lines: the arriving seam line stops where the line meets it, the leaving one starts where the line meets it.
 * A line that runs along one of the seam lines changes nothing (ET writes the seam lines again whole there).
 */
export function lineCorner(vertex, arriving, leaving, { line, owner = 'arriving' }) {
  const { a, b, tip } = frame(vertex, arriving, leaving), d = unit(line.direction);
  // where the line meets a seam line; a line that runs along the seam line meets it at its own point when that lies on it (ET then
  // splits the seam line there), otherwise nowhere
  const onto = (p, t) => Math.abs(cross(d, t)) >= 1e-6 ? meet(p, t, line.point, d) : Math.abs(cross(sub(line.point, p), t)) < 1e-6 ? line.point : null;
  const end = onto(a, arriving.tangent), start = onto(b, leaving.tangent);
  if (!end || !start) return { tip, end: tip, start: tip, pieces: [] };
  // ET does not make 延长反转角 when the line meets a seam line far from the corner (two pieces whose crossing edges differ much in
  // width or angle, so that the two crossing seam lines run nearly side by side; its probe d3), and makes nothing usable of
  // 包边延长反转角 there (d4). The corners ET made reach at most 1.1 times the corner's size (the wider seam width over the sine of
  // the turn); a line may reach three times that.
  const size = Math.max(arriving.width, leaving.width) / Math.max(cross(arriving.tangent, leaving.tangent), .05), reach = 3 * size;
  if (Math.hypot(end.x - tip.x, end.y - tip.y) > reach || Math.hypot(start.x - tip.x, start.y - tip.y) > reach) throw new Error('两片相交边的缝份或角度相差太大，角线离转角太远，做不了这个角。');
  return { tip, end, start, pieces: [{ owner, points: [end, start] }] };
}
/** 包边延长反转角 on the piece picked first: the crossing seam line mirrored about the sewn net edge, through where they meet. */
export function boundFoldLine(vertex, arriving, leaving, { sewn }) {
  const { s, x } = sewnAndCrossing(arriving, leaving, sewn), Q = meet(vertex, s.tangent, add(vertex, right(x.tangent), x.width), x.tangent);
  if (!Q) throw new Error('缝合的边与相交的边平行，不能做这个角。');
  return { point: Q, direction: mirrorDir(x.tangent, s.tangent) };
}
/**
 * The map that lays one piece on the other along their sewn edges (face to face, so it mirrors): corner on corner, sewn edge on
 * sewn edge. `from` and `to` are { vertex, away } with `away` the unit direction along the sewn edge into the piece. Returns a
 * function for points and one for directions.
 */
export function sewingMap(from, to) {
  let axis = add(from.away, to.away); axis = Math.hypot(axis.x, axis.y) < 1e-9 ? left(from.away) : unit(axis);
  const turn = w => mirrorDir(w, axis);
  return { point: p => add(to.vertex, turn(sub(p, from.vertex))), direction: turn };
}
/** The crossing seam line of a corner as { point, direction }, and the corner as { vertex, away } for sewingMap. */
export function crossingSeam(vertex, arriving, leaving, { sewn }) {
  const { x, away } = sewnAndCrossing(arriving, leaving, sewn);
  return { line: { point: add(vertex, right(x.tangent), x.width), direction: x.tangent }, corner: { vertex, away } };
}
/**
 * The corners of ET's 专用角处理 that need no sizes, and 可调反转 with one. `hem` says which edge plays the hem (the one picked in
 * ET); the other is the side. Straight lines along the tangents of the two edges at the corner. Checked against ET on square and
 * slanted corners (0.001 mm).
 *   sevenStep 七字角: the side seam stops on the hem's net line, steps in to half the side's width, drops parallel to the side to
 *     half the hem's width and runs to where the side's net line meets the hem's seam line
 *   foldSquare 反转直角: the side seam stops on the hem's net line, the allowance below mirrors the side seam down to half the hem's
 *     width, then runs square to the hem down to its seam line
 *   foldShift 可调反转: the side seam stops on the hem's net line and runs straight to the fold-back point on the hem's seam line,
 *     moved `shift` further out along it
 *   doubleExtend 双延长角: from where the side seam meets the hem's net line straight to where the side's net line meets the hem's
 *     seam line (the same whichever edge is the hem)
 *   doubleProject 双投影角: both seam lines stop square to the net corner and are joined through it
 */
export function specialCorner(vertex, arriving, leaving, { kind, hem, shift = 0 }) {
  if (hem !== 'arriving' && hem !== 'leaving') throw new Error('需要说明哪一条是折边。');
  const { tip } = frame(vertex, arriving, leaving), h = hem === 'arriving' ? arriving : leaving, s = hem === 'arriving' ? leaving : arriving;
  const outH = right(h.tangent), outS = right(s.tangent);
  const sideAt = d => meet(add(vertex, outS, s.width), s.tangent, add(vertex, outH, d), h.tangent);   // the side seam where it is d outside the hem's net line
  const S0 = sideAt(0), Q = meet(vertex, s.tangent, add(vertex, outH, h.width), h.tangent);
  if (!S0 || !Q) throw new Error('两条边接近平行，不能做这个角。');
  let path;   // from the side seam to the hem seam
  if (kind === 'sevenStep') {
    const half = add(vertex, outS, s.width / 2), S1 = meet(half, s.tangent, vertex, h.tangent), S2 = meet(half, s.tangent, add(vertex, outH, h.width / 2), h.tangent);
    path = [S0, S1, S2, Q];
  } else if (kind === 'foldSquare') {
    const inside = sideAt(-h.width / 2), F = mirrorPoint(inside, vertex, h.tangent), foot = add(F, outH, h.width - dot(sub(F, vertex), outH));
    path = [S0, F, foot];
  } else if (kind === 'foldShift') {
    if (!(shift >= 0)) throw new Error('可调反转的移动量无效。');
    const F = mirrorPoint(sideAt(-h.width), vertex, h.tangent), outward = hem === 'arriving' ? h.tangent : neg(h.tangent);
    path = [S0, add(F, outward, shift)];
  } else if (kind === 'doubleExtend') path = [S0, Q];
  else if (kind === 'doubleProject') path = [add(vertex, outS, s.width), vertex, add(vertex, outH, h.width)];
  else throw new Error('不认识的角处理“' + kind + '”。');
  const along = hem === 'arriving' ? [...path].reverse() : path;   // in the direction the outline is walked
  const owner = kind === 'doubleProject' || kind === 'doubleExtend' ? (hem === 'arriving' ? 'arriving' : 'leaving') : hem;
  return { tip, end: along[0], start: along.at(-1), pieces: [{ owner, points: along }] };
}
