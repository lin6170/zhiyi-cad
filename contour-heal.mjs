/**
 * Bringing together the ends of neighbouring contour edges that miss each other by a little.
 * ET accepts a contour whose edges miss each other by a fraction of a millimetre: here both ends go to the point half-way
 * between them. Used when an ET file is made editable and when a size is made from the grading rules of an ET file, where
 * rules of two points on the same place can differ a little.
 */
import { nativeFitPoints } from './fit-spline.mjs';
import { refreshCurve } from './curves.mjs';
import { moveEnd } from './construct-edit.mjs';

/** `edges` in contour order. Throws when a gap is larger than `limit` (mm). Returns how many joints were closed and the largest gap. */
export function closeContourGaps(edges, limit) {
  const ends = e => [e.points[0], e.points.at(-1)], gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y); let count = 0, largest = 0;
  if (edges.length < 2) return { count, largest };
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i], b = edges[(i + 1) % edges.length]; let best = null;
    for (const [ia, pa] of ends(a).entries()) for (const [ib, pb] of ends(b).entries()) { const d = gap(pa, pb); if (!best || d < best.d) best = { d, ia, ib, pa, pb }; }
    if (best.d <= 1e-6) continue;
    const fixed = edge => edge.curve && !nativeFitPoints(edge.curve); if (fixed(a) && fixed(b) && best.d <= .05) continue; // within the tolerance of a closed contour; nothing to move
    if (best.d > limit) throw new Error('轮廓没有闭合：相邻两条边的端点相距 ' + best.d.toFixed(3) + ' mm，超过 ' + limit + ' mm。');
    // A curve whose end cannot be moved (its points repeat at the end) stays; then the neighbour comes all the way to it.
    const movable = edge => !edge.curve || Boolean(nativeFitPoints(edge.curve)), put = (edge, index, to) => { const moved = moveEnd(edge, index === 0 ? 'start' : 'end', to); if (moved.curve) { edge.curve = moved.curve; refreshCurve(edge); } else edge.points = moved.points; };
    if (movable(a) && movable(b)) { const middle = { x: (best.pa.x + best.pb.x) / 2, y: (best.pa.y + best.pb.y) / 2 }; put(a, best.ia, middle); put(b, best.ib, middle); }
    else if (movable(a)) put(a, best.ia, best.pb); else if (movable(b)) put(b, best.ib, best.pa);
    else throw new Error('轮廓没有闭合：相邻两条曲线的端点相距 ' + best.d.toFixed(3) + ' mm，而这两条曲线的端点都不能移动。');
    count++; largest = Math.max(largest, best.d);
  }
  return { count, largest };
}
