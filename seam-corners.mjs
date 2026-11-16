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
const cross = (a, b) => a.x * b.y - a.y * b.x, dot = (a, b) => a.x * b.x + a.y * b.y, right = t => ({ x: t.y, y: -t.x });
const meet = (p, d, q, e) => { const den = cross(d, e); return Math.abs(den) < 1e-12 ? null : add(p, d, cross(sub(q, p), e) / den); };
const PARALLEL = 1e-6;
export const CORNER_KINDS = ['cut', 'step', 'fold'];

function frame(vertex, arriving, leaving) {
  for (const edge of [arriving, leaving]) if (!(edge.width >= 0) || !Number.isFinite(edge.tangent?.x) || !Number.isFinite(edge.tangent?.y)) throw new Error('转角的边数据无效。');
  const turn = cross(arriving.tangent, leaving.tangent);
  if (turn <= PARALLEL) throw new Error('只有向外凸出的转角可以做角处理。');
  const a = add(vertex, right(arriving.tangent), arriving.width), b = add(vertex, right(leaving.tangent), leaving.width);
  return { a, b, tip: meet(a, arriving.tangent, b, leaving.tangent) };
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
 * Stepped hem corner. `side` says which of the two edges is the side seam; the other one is the hem.
 * `drop` is how far below the hem's seam line the side seam stops; the riser of the step runs parallel to the
 * side, `run` inside the side's seam line (measured square to the side, as ET does).
 */
export function stepCorner(vertex, arriving, leaving, { side, drop, run }) {
  if (side !== 'arriving' && side !== 'leaving') throw new Error('台阶角需要说明哪一条是侧边。');
  const s = side === 'arriving' ? arriving : leaving, h = side === 'arriving' ? leaving : arriving;
  if (!(drop > 0) || !(run > 0)) throw new Error('台阶角的两个尺寸都必须大于 0。');
  if (drop > h.width + 1e-9) throw new Error('台阶的高度不能超过折边的缝份宽度。');
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
  return fold === 'leaving'
    ? { tip, end: e0, start: e1, pieces: [{ owner: 'leaving', points: flap }] }
    : { tip, end: e1, start: e0, pieces: [{ owner: 'arriving', points: [...flap].reverse() }] };
}
