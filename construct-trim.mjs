/**
 * Bringing the end of a line or curve to another line, changing the length of a curve, and changing the points a
 * curve goes through (v54).
 *
 * The first two follow what ET 2017's own tools (长度调整, 一端修正, 两端修正) did with a probe file:
 *  - a straight line moves its end along itself until it meets the other line;
 *  - a curve that crosses the other line is cut there and keeps the part away from the end that was pointed at;
 *  - a line or curve that the other line does not reach, but that the extension of the other (straight) line crosses,
 *    is cut there in the same way (v61, seen with ET's smart tool);
 *  - a curve that does not reach gets one more point where its end direction meets the other line;
 *  - a curve made longer gets one more point in its end direction, placed so that the whole curve has the wanted length;
 *  - a curve made shorter is cut at that length.
 * ET takes directions and crossings from the polyline it displays, and stores a cut curve as that polyline's points.
 * Here crossings are exact, a cut curve keeps as few points as hold its shape within 0.01 mm, and the end direction of
 * a curve is taken over its last 3 mm (see outwardDirection).
 * Millimetres, y up. Pure functions, no DOM.
 */
import { bezierSpans, sampleCurve } from './curves.mjs';
import { fitClampedSpline, nativeFitPoints } from './fit-spline.mjs';
import { sliceBezier, evaluateBezier, bezierLineHits } from './bezier-cut.mjs';

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y }), scale = (v, k) => ({ x: v.x * k, y: v.y * k });
const dot = (a, b) => a.x * b.x + a.y * b.y, cross = (a, b) => a.x * b.y - a.y * b.x, norm = v => Math.hypot(v.x, v.y), distance = (a, b) => norm(sub(a, b));
const copy = p => ({ x: p.x, y: p.y });
function unit(v, message = '方向无法确定。') { const n = norm(v); if (!(n > 1e-12)) throw new Error(message); return { x: v.x / n, y: v.y / n }; }
/** A closed polyline, or a curve that ends where it starts (a circle). */
const isClosed = entity => Boolean(entity.closed) || (entity.points.length > 2 && distance(entity.points[0], entity.points.at(-1)) < 1e-9);
const endName = end => { if (end !== 'start' && end !== 'end') throw new Error('需要说明是起点还是终点。'); return end; };
export const SHAPE_TOLERANCE = .01;   // mm: how far a curve that is cut or pinned may leave the shape it had
const MAX_POINTS = 120;               // curve points one curve may have

// ---------------------------------------------------------------- a path as Bezier pieces
function pathOnly(entity, what = '这条线') { if (!entity || entity.type === 'text' || !entity.points) throw new Error(what + '须是一条线或曲线。'); return entity; }
/** The Bezier pieces of a line, polyline or curve in order, each as its control points (two for a straight piece). */
export function piecesOf(entity) {
  pathOnly(entity);
  if (entity.curve) return bezierSpans(entity.curve).map(span => span.controlPoints.map(copy));
  const points = entity.closed ? [...entity.points, entity.points[0]] : entity.points, pieces = [];
  for (let i = 1; i < points.length; i++) if (distance(points[i - 1], points[i]) > 1e-9) pieces.push([copy(points[i - 1]), copy(points[i])]);
  if (!pieces.length) throw new Error('这条线没有长度。');
  return pieces;
}
function derivative(controls, t) {
  const n = controls.length - 1; let row = controls.slice(0, -1).map((p, i) => scale(sub(controls[i + 1], p), n));
  while (row.length > 1) row = row.slice(0, -1).map((p, i) => ({ x: p.x * (1 - t) + row[i + 1].x * t, y: p.y * (1 - t) + row[i + 1].y * t }));
  return row[0];
}
const GAUSS = [[-.906179845938664, .2369268850561891], [-.5384693101056831, .4786286704993665], [0, .5688888888888889], [.5384693101056831, .4786286704993665], [.906179845938664, .2369268850561891]];
/** Length of one Bezier piece between two parameters. */
export function pieceLength(controls, from = 0, to = 1) {
  if (controls.length === 2) return distance(controls[0], controls[1]) * (to - from);
  let total = 0; const panels = 12;
  for (let k = 0; k < panels; k++) {
    const a = from + (to - from) * k / panels, half = (to - from) / panels / 2, mid = a + half;
    for (const [x, w] of GAUSS) total += w * half * norm(derivative(controls, mid + half * x));
  }
  return total;
}
function measured(entity) {
  const pieces = piecesOf(entity), lengths = pieces.map(c => pieceLength(c)), starts = []; let total = 0;
  for (const length of lengths) { starts.push(total); total += length; }
  return { pieces, lengths, starts, total };
}
/** Length of a line or curve. */
export function pathLength(entity) { return measured(entity).total; }
/** Where a length measured from the start lies: the piece, the parameter in it, and the point. */
function placeAt(path, length) {
  const s = Math.max(0, Math.min(path.total, length)); let index = path.pieces.length - 1;
  for (let i = 0; i < path.pieces.length; i++) if (s <= path.starts[i] + path.lengths[i]) { index = i; break; }
  const controls = path.pieces[index], wanted = s - path.starts[index]; let lo = 0, hi = 1;
  if (controls.length === 2) lo = hi = path.lengths[index] > 0 ? wanted / path.lengths[index] : 0;
  else for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (pieceLength(controls, 0, mid) < wanted) lo = mid; else hi = mid; }
  const t = Math.max(0, Math.min(1, (lo + hi) / 2));
  return { index, t, point: evaluateBezier(controls, t) };
}
/** The point at a length along a path and the direction of travel there (v63). */
export function placeAlong(entity, length) {
  const path = measured(entity), place = placeAt(path, length), controls = path.pieces[place.index];
  let d = derivative(controls, place.t);
  if (!(norm(d) > 1e-9)) d = derivative(controls, place.t < .5 ? Math.min(1, place.t + 1e-6) : Math.max(0, place.t - 1e-6));   // a doubled end control point
  return { point: place.point, direction: unit(d, '线在这里没有确定的方向。'), total: path.total };
}
/**
 * The direction in which a path leaves one of its ends, pointing away from the path.
 * A curve drawn through points has its last control point doubled: it comes to rest at its end and turns ever more
 * sharply over the last fraction of a millimetre, so the direction exactly at the end says little about how the curve
 * runs. For such an end the direction is taken over the last END_REACH millimetres, which is also close to what ET does
 * (ET takes the last piece of the polyline it displays).
 */
export const END_REACH = 3;
export function outwardDirection(entity, end) {
  endName(end); const path = measured(entity), controls = end === 'end' ? path.pieces.at(-1) : [...path.pieces[0]].reverse(), tip = controls.at(-1);
  if (controls.length > 2 && distance(controls.at(-2), tip) < 1e-9) {
    const reach = Math.min(END_REACH, path.total / 2), back = placeAt(path, end === 'end' ? path.total - reach : reach).point;
    return unit(sub(tip, back));
  }
  for (let i = controls.length - 2; i >= 0; i--) if (distance(controls[i], tip) > 1e-9) return unit(sub(tip, controls[i]));
  throw new Error('线的端部没有确定的方向。');
}
const cubic = controls => controls.length === 4 ? controls.map(copy) : controls.length === 3
  ? [copy(controls[0]), add(controls[0], scale(sub(controls[1], controls[0]), 2 / 3)), add(controls[2], scale(sub(controls[1], controls[2]), 2 / 3)), copy(controls[2])]
  : [copy(controls[0]), add(controls[0], scale(sub(controls[1], controls[0]), 1 / 3)), add(controls[0], scale(sub(controls[1], controls[0]), 2 / 3)), copy(controls[1])];
/** A curve made of cubic pieces that join end to end. */
function curveFromPieces(pieces) {
  const controlPoints = [copy(pieces[0][0])], knots = [0, 0, 0, 0];
  pieces.forEach((piece, i) => { const c = cubic(piece); controlPoints.push(c[1], c[2], c[3]); knots.push(i + 1, i + 1, i + 1); });
  knots.push(pieces.length);
  return { kind: 'bspline', degree: 3, controlPoints, knots, samplingTolerance: .002 };
}
/** The exact part of a path between two lengths measured from its start, as Bezier pieces. */
function partPieces(path, from, to) {
  if (!(to - from > 1e-9)) throw new Error('截取的一段没有长度。');
  const a = placeAt(path, from), b = placeAt(path, to), pieces = [];
  for (let i = a.index; i <= b.index; i++) {
    const t0 = i === a.index ? a.t : 0, t1 = i === b.index ? b.t : 1;
    if (t1 - t0 > 1e-12) pieces.push(sliceBezier(path.pieces[i], t0, t1));
  }
  if (!pieces.length) throw new Error('截取的一段没有长度。');
  pieces[0][0] = copy(a.point); pieces.at(-1)[pieces.at(-1).length - 1] = copy(b.point);
  return pieces;
}

// ---------------------------------------------------------------- how far two shapes are apart
function toSegment(p, a, b) { const ab = sub(b, a), l2 = dot(ab, ab), t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0; return distance(p, add(a, scale(ab, t))); }
function farthest(points, polyline) {
  let worst = { distance: 0, index: 0 }, hint = 1;
  points.forEach((p, index) => {
    // the nearest segment moves along steadily, so search around the last one first and widen only when needed
    let best = Infinity, at = hint;
    for (let i = Math.max(1, hint - 6); i < Math.min(polyline.length, hint + 7); i++) { const d = toSegment(p, polyline[i - 1], polyline[i]); if (d < best) { best = d; at = i; } }
    if (best > 1e-4) for (let i = 1; i < polyline.length; i++) { const d = toSegment(p, polyline[i - 1], polyline[i]); if (d < best) { best = d; at = i; } }
    hint = at; if (best > worst.distance) worst = { distance: best, index };
  });
  return worst;
}
const display = curve => sampleCurve({ ...curve, samplingTolerance: .0005 }).points;
/** The largest distance between two shapes given by the points along them, looked at from both sides. */
export function shapeGap(first, second) { return Math.max(farthest(first, second).distance, farthest(second, first).distance); }

// ---------------------------------------------------------------- a curve through points that keeps a shape
function along(points) { const at = [0]; for (let i = 1; i < points.length; i++) at.push(at[i - 1] + distance(points[i - 1], points[i])); return at; }
/**
 * A curve through points, in ET's form, that stays within the tolerance of a shape given by many points along it.
 * It starts from the seed points (which lie on the shape, the two ends first and last) and adds a point where it is
 * farthest off until it fits. Returns null when even the largest allowed number of points does not hold the shape.
 */
export function fitShape(target, seeds, tolerance = SHAPE_TOLERANCE) {
  const positions = along(target), total = positions.at(-1);
  const where = p => { let best = Infinity, at = 0; for (let i = 1; i < target.length; i++) { const a = target[i - 1], ab = sub(target[i], a), l2 = dot(ab, ab), t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0, d = distance(p, add(a, scale(ab, t))); if (d < best) { best = d; at = positions[i - 1] + Math.sqrt(l2) * t; } } return at; };
  const pointAt = s => { let i = 1; while (i < target.length - 1 && positions[i] < s) i++; const span = positions[i] - positions[i - 1], t = span > 0 ? (s - positions[i - 1]) / span : 0; return add(target[i - 1], scale(sub(target[i], target[i - 1]), t)); };
  let pins = seeds.map(p => ({ at: where(p), point: copy(p) })); pins[0].at = 0; pins[pins.length - 1].at = total;
  pins.sort((p, q) => p.at - q.at); pins = pins.filter((p, i) => i === 0 || p.at - pins[i - 1].at > .02 || i === pins.length - 1);
  if (pins.length > 2 && pins.at(-1).at - pins.at(-2).at <= .02) pins.splice(pins.length - 2, 1);
  for (let round = 0; round < 400; round++) {
    let curve; try { curve = fitClampedSpline(pins.map(p => p.point)).curve; } catch { return null; }
    const shown = display(curve), off = farthest(target, shown), back = farthest(shown, target), gap = Math.max(off.distance, back.distance);
    if (gap <= tolerance) return { curve, points: pins.length, gap };
    if (pins.length >= MAX_POINTS) return null;
    let wanted = off.distance >= back.distance ? positions[off.index] : where(shown[back.index]);
    // never two points on top of each other: move into the wider neighbouring gap instead
    const next = pins.findIndex(p => p.at > wanted), before = pins[Math.max(0, (next < 0 ? pins.length : next) - 1)], after = pins[next < 0 ? pins.length - 1 : next];
    if (wanted - before.at < .05 || after.at - wanted < .05) wanted = (before.at + after.at) / 2;
    if (after.at - before.at < .1) {   // this gap cannot take another point: split the widest one
      let widest = 1; for (let i = 2; i < pins.length; i++) if (pins[i].at - pins[i - 1].at > pins[widest].at - pins[widest - 1].at) widest = i;
      if (pins[widest].at - pins[widest - 1].at < .1) return null;
      wanted = (pins[widest].at + pins[widest - 1].at) / 2;
    }
    pins.push({ at: wanted, point: pointAt(wanted) }); pins.sort((p, q) => p.at - q.at);
  }
  return null;
}
/** The curve points of a curve; a curve that has none (an arc, or one whose control points were edited) is given some. */
export function pointsOf(entity) {
  if (!entity || !entity.curve) throw new Error('这不是一条曲线。');
  const own = nativeFitPoints(entity.curve); if (own) return { points: own.map(copy), refitted: false, gap: 0 };
  const target = display(entity.curve), path = measured(entity), seeds = [0, .25, .5, .75, 1].map(share => placeAt(path, path.total * share).point);
  const fitted = fitShape(target, seeds); if (!fitted) throw new Error('这条曲线无法在 ' + SHAPE_TOLERANCE + ' mm 以内改成按点的曲线。');
  return { points: nativeFitPoints(fitted.curve).map(copy), refitted: true, gap: fitted.gap };
}
/** A part of a path as a curve through points; the original curve points inside the part are kept. */
function partAsCurve(entity, path, from, to) {
  const pieces = partPieces(path, from, to), exact = curveFromPieces(pieces), target = display(exact);
  const own = entity.curve ? nativeFitPoints(entity.curve) : null, inside = [];
  if (own) { const stations = own.map(p => stationOf(path, p)); own.forEach((p, i) => { if (stations[i] > from + .05 && stations[i] < to - .05) inside.push(p); }); }
  const fitted = fitShape(target, [target[0], ...inside, target.at(-1)]);
  return fitted ? { curve: fitted.curve, fitPoints: fitted.points, shapeChangeMm: fitted.gap } : { curve: exact, fitPoints: null, shapeChangeMm: 0 };
}
/** How far along a path the point of the path nearest to a given point lies. */
function stationOf(path, point) {
  let best = { away: Infinity, at: 0 };
  path.pieces.forEach((controls, index) => {
    const steps = controls.length === 2 ? 1 : 24; let local = { away: Infinity, t: 0 };
    for (let k = 0; k <= steps; k++) { const t = k / steps, d = distance(evaluateBezier(controls, t), point); if (d < local.away) local = { away: d, t }; }
    if (controls.length === 2) { const ab = sub(controls[1], controls[0]), l2 = dot(ab, ab); local.t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(point, controls[0]), ab) / l2)) : 0; local.away = distance(evaluateBezier(controls, local.t), point); }
    else { let lo = Math.max(0, local.t - 1 / steps), hi = Math.min(1, local.t + 1 / steps); for (let k = 0; k < 50; k++) { const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3; if (distance(evaluateBezier(controls, a), point) < distance(evaluateBezier(controls, b), point)) hi = b; else lo = a; } local.t = (lo + hi) / 2; local.away = distance(evaluateBezier(controls, local.t), point); }
    if (local.away < best.away) best = { away: local.away, at: path.starts[index] + pieceLength(controls, 0, local.t) };
  });
  return best.at;
}
/** The place on a path nearest to a point: how far along it lies, the point there, and how far away the given point is. */
export function nearestOnPath(entity, point) { const path = measured(entity), at = stationOf(path, point), found = placeAt(path, at).point; return { at, point: found, away: distance(found, point), total: path.total }; }

// ---------------------------------------------------------------- where two paths cross
function refine(a, b, t, s) {
  // Newton steps on a(t) = b(s); both are Bezier pieces
  for (let k = 0; k < 12; k++) {
    const f = sub(evaluateBezier(a, t), evaluateBezier(b, s)), da = derivative(a, t), db = derivative(b, s), det = cross(da, scale(db, -1));
    if (Math.abs(det) < 1e-14) return null;
    const dt = cross(scale(f, -1), scale(db, -1)) / det, ds = cross(da, scale(f, -1)) / det; t += dt; s += ds;
    if (Math.abs(dt) + Math.abs(ds) < 1e-14) break;
  }
  if (t < -1e-9 || t > 1 + 1e-9 || s < -1e-9 || s > 1 + 1e-9) return null;
  t = Math.max(0, Math.min(1, t)); s = Math.max(0, Math.min(1, s));
  return distance(evaluateBezier(a, t), evaluateBezier(b, s)) < 1e-7 ? { t, s } : null;
}
/** Every place where a path meets another one: how far along the first path, and the point. */
export function crossings(entity, other) {
  const path = measured(entity), others = piecesOf(other), found = [];
  path.pieces.forEach((a, index) => {
    for (const b of others) {
      const chords = b.length === 2 ? 1 : 24;
      for (let k = 0; k < chords; k++) {
        const p = evaluateBezier(b, k / chords), q = evaluateBezier(b, (k + 1) / chords); if (distance(p, q) < 1e-9) continue;
        let hits; try { hits = bezierLineHits(a, p, q); } catch { continue; }
        if (hits.collinear) continue;
        for (const hit of hits.hits) {
          let t = hit.t;
          if (b.length !== 2) { const exact = refine(a, b, hit.t, (k + hit.u) / chords); if (!exact) continue; t = exact.t; }
          if (t < -1e-9 || t > 1 + 1e-9) continue; t = Math.max(0, Math.min(1, t));
          const point = evaluateBezier(a, t);
          if (!found.some(f => distance(f.point, point) < 1e-6)) found.push({ at: path.starts[index] + pieceLength(a, 0, t), point });
        }
      }
    }
  });
  return found.sort((p, q) => p.at - q.at);
}
/**
 * Where a line is cut by another one (v61): every place the cutting line crosses it, the line's own ends apart. A straight
 * cutting line that does not reach the line cuts where its extension first meets it, which is what ET's 要素打断 does.
 */
export function cutPlaces(entity, cutter) {
  const total = pathLength(entity), inner = list => list.filter(hit => hit.at > 1e-6 && hit.at < total - 1e-6), real = inner(crossings(entity, cutter));
  if (real.length || cutter.curve || cutter.points.length !== 2) return { hits: real, onExtension: false };
  const [a, b] = cutter.points, reach = distance(a, b); if (reach < 1e-9) return { hits: [], onExtension: false };
  const d = scale(sub(b, a), 1e5 / reach), away = hit => Math.min(distance(hit.point, a), distance(hit.point, b));
  const hits = inner(crossings(entity, { points: [sub(a, d), add(b, d)] })).sort((m, n) => away(m) - away(n)).slice(0, 1);
  return { hits, onExtension: hits.length > 0 };
}
/** Where a ray first meets a path; for a straight line also where it meets the line's extension. */
function rayHit(from, direction, other) {
  const far = add(from, scale(direction, 1e5)), hits = crossings({ points: [from, far] }, other).filter(hit => hit.at > 1e-6);
  if (hits.length) return { point: hits[0].point, reach: hits[0].at, onExtension: false };
  if (!other.curve && !other.closed && other.points.length === 2) {
    const [a, b] = other.points, d = sub(b, a), det = cross(direction, d);
    if (Math.abs(det) > 1e-12 * norm(d)) { const reach = cross(sub(a, from), d) / det; if (reach > 1e-6 && reach < 1e5) return { point: add(from, scale(direction, reach)), reach, onExtension: true }; }
  }
  return null;
}

// ---------------------------------------------------------------- one end to a boundary
/**
 * Bring one end of a line or curve to another line (ET's 一端修正).
 * Returns what the changed line is: `points` for a straight line or polyline, `curve` for a curve; `to` is the new end.
 */
export function correctEnd(entity, end, boundary) {
  endName(end); pathOnly(entity); pathOnly(boundary, '修正线');
  if (isClosed(entity)) throw new Error('闭合的图形没有端点。');
  const path = measured(entity), tip = end === 'end' ? entity.points.at(-1) : entity.points[0];
  const away = hit => end === 'end' ? path.total - hit.at : hit.at, touching = crossings(entity, boundary);
  if (touching.some(hit => away(hit) < 1e-6)) throw new Error('这一端已经在修正线上。');
  const met = touching.filter(hit => path.total - away(hit) > 1e-6);   // a line that starts on the boundary is not cut down to nothing there
  const cutAt = (found, onExtension) => {   // crossing: cut at the crossing nearest to the indicated end and keep the other side
    const hit = found.reduce((best, h) => away(h) < away(best) ? h : best), from = end === 'end' ? 0 : hit.at, to = end === 'end' ? hit.at : path.total;
    if (!(to - from > 1e-6)) throw new Error('修正后这条线就没有长度了。');
    const common = { action: 'cut', to: copy(hit.point), movedMm: away(hit), onExtension, lengthMm: to - from };
    if (entity.curve) return { ...common, ...partAsCurve(entity, path, from, to) };
    const points = partPieces(path, from, to); return { ...common, points: [copy(points[0][0]), ...points.map(piece => copy(piece[1]))] };
  };
  if (met.length) return cutAt(met, false);
  if (!boundary.curve && !boundary.closed && boundary.points.length === 2 && distance(boundary.points[0], boundary.points[1]) > 1e-9) {
    // v61: a straight correcting line that does not reach, but whose extension crosses the line itself: ET cuts there too
    const [a, b] = boundary.points, d = scale(sub(b, a), 1e5 / distance(a, b)), across = crossings(entity, { points: [sub(a, d), add(b, d)] }).filter(hit => away(hit) > 1e-6 && path.total - away(hit) > 1e-6);
    if (across.length) return cutAt(across, true);
  }
  const direction = outwardDirection(entity, end), hit = rayHit(tip, direction, boundary);
  if (!hit) throw new Error('这条线沿自己的方向延长，碰不到修正线。');
  const common = { action: 'extend', to: copy(hit.point), movedMm: hit.reach, onExtension: hit.onExtension };
  if (!entity.curve) { const points = entity.points.map(copy); points[end === 'end' ? points.length - 1 : 0] = copy(hit.point); return { ...common, points, lengthMm: path.total + hit.reach }; }
  const own = pointsOf(entity), points = end === 'end' ? [...own.points, copy(hit.point)] : [copy(hit.point), ...own.points];
  if (points.length > MAX_POINTS) throw new Error('曲线点已经有 ' + own.points.length + ' 个，不能再加。');
  const curve = fitClampedSpline(points).curve;
  return { ...common, curve, fitPoints: points.length, shapeChangeMm: own.gap, lengthMm: pathLength({ curve, points: [] }) };
}
/** Bring both ends of a line or curve to two other lines (ET's 两端修正): each line corrects the end that has less to move. */
export function correctEnds(entity, first, second) {
  const attempt = (a, b) => { try { const one = correctEnd(entity, 'start', a), middle = { ...entity, ...(one.curve ? { curve: one.curve, points: display(one.curve) } : { points: one.points }) }, two = correctEnd(middle, 'end', b); return { start: one, end: two, moved: one.movedMm + two.movedMm, result: two }; } catch (error) { return { error }; } };
  const straight = attempt(first, second), swapped = attempt(second, first), usable = [straight, swapped].filter(r => !r.error);
  if (!usable.length) throw new Error('两端修正做不出来：' + straight.error.message);
  const best = usable.reduce((p, q) => q.moved < p.moved ? q : p);
  return { ...best, startBoundary: best === straight ? 'first' : 'second' };
}

// ---------------------------------------------------------------- a part of a path (v59: taking a piece out of structure lines)
/** Points of a path between two lengths measured from its start: the corners of a straight path, or points close enough together to stand for a curve. */
export function sampledBetween(entity, from, to, step = 2) {
  pathOnly(entity); const path = measured(entity), a = Math.max(0, Math.min(path.total, from)), b = Math.max(a, Math.min(path.total, to));
  if (!entity.curve) {
    const points = [copy(placeAt(path, a).point)];
    path.starts.forEach((start, i) => { const corner = start + path.lengths[i]; if (corner > a + 1e-9 && corner < b - 1e-9) points.push(copy(path.pieces[i][1])); });
    points.push(copy(placeAt(path, b).point)); return points;
  }
  const count = Math.max(2, Math.ceil((b - a) / step) + 1);
  return Array.from({ length: count }, (_, i) => copy(placeAt(path, a + (b - a) * i / (count - 1)).point));
}
/** The part of a line, polyline or curve between two lengths from its start: a straight part as its points, a curved part as a
 *  curve through points that keeps the shape within SHAPE_TOLERANCE and the curve points that lie inside the part. */
export function partBetween(entity, from, to) {
  pathOnly(entity); if (!entity.curve) return { points: sampledBetween(entity, from, to) };
  return partAsCurve(entity, measured(entity), from, to);
}

// ---------------------------------------------------------------- the length of a curve
/** Give a curve a new length by changing one end (ET's 长度调整 on a curve). */
export function curveWithLength(entity, end, target) {
  endName(end); if (!entity || !entity.curve) throw new Error('这不是一条曲线。');
  if (isClosed(entity)) throw new Error('闭合的图形没有端点。');
  const path = measured(entity), before = path.total;
  if (!(target > 1e-6)) throw new Error('调整后的长度须大于 0。');
  if (Math.abs(target - before) < 1e-9) throw new Error('长度没有变化。');
  if (target < before) {
    const from = end === 'end' ? 0 : before - target, to = end === 'end' ? target : before, part = partAsCurve(entity, path, from, to);
    return { action: 'cut', ...part, to: copy(placeAt(path, end === 'end' ? target : before - target).point), beforeMm: before, lengthMm: pathLength({ curve: part.curve, points: [] }) };
  }
  const own = pointsOf(entity), tip = end === 'end' ? own.points.at(-1) : own.points[0], direction = outwardDirection(entity, end);
  if (own.points.length >= MAX_POINTS) throw new Error('曲线点已经有 ' + own.points.length + ' 个，不能再加。');
  const through = reach => { const added = add(tip, scale(direction, reach)), points = end === 'end' ? [...own.points, added] : [added, ...own.points], curve = fitClampedSpline(points).curve; return { curve, added, points: points.length, length: pathLength({ curve, points: [] }) }; };
  // the length grows with the reach of the new point: bracket the wanted length, then halve
  let lo = 0, hi = target - before, grown = through(hi);
  for (let k = 0; k < 40 && grown.length < target; k++) { lo = hi; hi *= 1.5; grown = through(hi); }
  if (grown.length < target) throw new Error('这条曲线加长不到这个长度。');
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (!(mid > 1e-6)) break; const tried = through(mid); if (tried.length < target) lo = mid; else { hi = mid; grown = tried; } if (hi - lo < 1e-9) break; }
  return { action: 'extend', curve: grown.curve, fitPoints: grown.points, to: copy(grown.added), shapeChangeMm: own.gap, beforeMm: before, lengthMm: grown.length };
}

// ---------------------------------------------------------------- one end along a direction, to a wanted length
/**
 * Move one end of a line or curve along a direction until the whole has the wanted length (ET's 定向长度调整: its prompt
 * asks for "the direction in which the end moves" and "the target length", and shows a horizontal, a vertical and a
 * perpendicular guide through the end). direction is 'horizontal', 'vertical' or 'perpendicular' (square to the line at
 * that end). There can be two places on the guide that give the length: toward picks the side, and without it the
 * nearer place is taken. A curve moves its end point only; the other curve points stay.
 * ET's own result was not compared: its tool could not be driven from outside.
 */
export function withLengthAlong(entity, end, direction, target, toward) {
  endName(end); pathOnly(entity); if (isClosed(entity)) throw new Error('闭合的图形没有端点。');
  if (!(target > 1e-6)) throw new Error('目标长度须大于 0。');
  const tip = end === 'end' ? entity.points.at(-1) : entity.points[0];
  const out = outwardDirection(entity, end), u = direction === 'horizontal' ? { x: 1, y: 0 } : direction === 'vertical' ? { x: 0, y: 1 } : direction === 'perpendicular' ? { x: -out.y, y: out.x } : null;
  if (!u) throw new Error('方向须是水平（horizontal）、垂直（vertical）或与线垂直（perpendicular）。');
  const side = toward ? Math.sign(dot(sub(toward, tip), u)) : 0, before = pathLength(entity);
  const choose = roots => { const usable = roots.filter(t => Math.abs(t) > 1e-9 && (!side || Math.sign(t) === side)); if (!usable.length) return null; return usable.reduce((a, b) => Math.abs(b) < Math.abs(a) ? b : a); };
  if (!entity.curve) {
    // the last straight piece decides: its other end stays, and the pieces before it keep their length
    const points = entity.points.map(copy), index = end === 'end' ? points.length - 1 : 0, fixed = points[end === 'end' ? points.length - 2 : 1], rest = before - distance(fixed, tip), wanted = target - rest;
    if (!(wanted > 1e-6)) throw new Error('目标长度比这条折线其余各段加起来还短。');
    const d = sub(tip, fixed), b = dot(d, u), inside = b * b - dot(d, d) + wanted * wanted;
    if (inside < 0) throw new Error('沿这个方向移动，线长最短也有 ' + (rest + Math.sqrt(dot(d, d) - b * b)).toFixed(2) + ' mm，到不了 ' + target.toFixed(2) + ' mm。');
    const t = choose([-b + Math.sqrt(inside), -b - Math.sqrt(inside)]);
    if (t === null) throw new Error(side ? '朝这一边移动到不了这个长度，请点另一边。' : '线长没有变化。');
    points[index] = add(tip, scale(u, t)); return { points, to: copy(points[index]), movedMm: Math.abs(t), beforeMm: before, lengthMm: target };
  }
  const own = pointsOf(entity), at = end === 'end' ? own.points.length - 1 : 0;
  const through = t => { const points = own.points.map(copy); points[at] = add(own.points[at], scale(u, t)); const curve = fitClampedSpline(points).curve; return { curve, length: pathLength({ curve, points: [] }), to: points[at] }; };
  // the length is looked at along the guide on both sides, then the crossings of the wanted length are narrowed down
  const reach = Math.abs(target - before) * 3 + 50, steps = 240, roots = []; let previous = null;
  for (let i = 0; i <= steps; i++) {
    const t = -reach + 2 * reach * i / steps; let value; try { value = through(t).length - target; } catch { previous = null; continue; }
    if (previous && previous.value * value <= 0 && previous.value !== value) { let lo = previous.t, hi = t, low = previous.value; for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2, m = through(mid).length - target; if (low * m <= 0) hi = mid; else { lo = mid; low = m; } } roots.push((lo + hi) / 2); }
    previous = { t, value };
  }
  const t = choose(roots); if (t === null) throw new Error(roots.length ? '朝这一边移动到不了这个长度，请点另一边。' : '沿这个方向移动，曲线到不了这个长度。');
  const result = through(t); return { curve: result.curve, fitPoints: own.points.length, to: copy(result.to), movedMm: Math.abs(t), beforeMm: before, lengthMm: result.length, shapeChangeMm: own.gap };
}

// ---------------------------------------------------------------- the points of a curve
const evenly = (path, count) => Array.from({ length: count }, (_, i) => placeAt(path, path.total * i / (count - 1)).point);
/** The same curve through a chosen number of points, spaced evenly along it. shapeChangeMm tells how far the shape moved. */
export function withPointCount(entity, count) {
  if (!entity || !entity.curve) throw new Error('这不是一条曲线。');
  if (entity.closed) throw new Error('闭合的曲线不能重设点数。');
  if (!Number.isInteger(count) || count < 2 || count > MAX_POINTS) throw new Error('曲线点数须是 2 到 ' + MAX_POINTS + ' 的整数。');
  const path = measured(entity), points = evenly(path, count); points[0] = copy(entity.points[0]); points[count - 1] = copy(entity.points.at(-1));
  const curve = fitClampedSpline(points).curve;
  return { curve, points: count, shapeChangeMm: shapeGap(display(entity.curve), display(curve)) };
}
/**
 * Fewer curve points: again and again the point is taken out whose removal moves the curve least, as long as the
 * curve stays within the tolerance of its first shape, or until the wanted number of points is left.
 */
export function withFewerPoints(entity, { tolerance, count } = {}) {
  if (!entity || !entity.curve) throw new Error('这不是一条曲线。');
  const own = nativeFitPoints(entity.curve); if (!own) throw new Error('这条曲线的形状不是由曲线点决定的，没有点可以减。');
  if (count !== undefined && (!Number.isInteger(count) || count < 2)) throw new Error('要保留的曲线点数须是不小于 2 的整数。');
  if (count === undefined && !(tolerance > 0)) throw new Error('需要给出允许的形状变化，或要保留的点数。');
  const first = display(entity.curve), ends = own.length - 1; let points = own.map(copy), curve = entity.curve, gap = 0;
  const closedEnds = entity.closed || distance(own[0], own[ends]) < 1e-9, least = closedEnds ? 4 : 2;
  while (points.length > Math.max(least, count ?? least)) {
    let best = null;
    for (let i = 1; i < points.length - 1; i++) {
      const tried = points.filter((_, k) => k !== i); let fitted; try { fitted = fitClampedSpline(tried).curve; } catch { continue; }
      const moved = shapeGap(first, display(fitted)); if (!best || moved < best.moved) best = { moved, points: tried, curve: fitted };
    }
    if (!best || (count === undefined && best.moved > tolerance)) break;
    points = best.points; curve = best.curve; gap = best.moved;
  }
  return { curve, points: points.length, removed: own.length - points.length, shapeChangeMm: gap };
}
/** Move several curve points by the same amount. The ends stay where they are. */
export function withPointsMoved(entity, indices, by) {
  if (!entity || !entity.curve) throw new Error('这不是一条曲线。');
  const own = nativeFitPoints(entity.curve); if (!own) throw new Error('这条曲线的形状不是由曲线点决定的（它是圆弧，或它的控制点被单独改过），请用节点工具修改。');
  if (!(Math.hypot(by.dx || 0, by.dy || 0) > 1e-9)) throw new Error('移动量不能为零。');
  const chosen = new Set(indices); if (chosen.size !== indices.length) throw new Error('曲线点的编号有重复。');
  for (const index of chosen) {
    if (!Number.isInteger(index) || index < 0 || index >= own.length) throw new Error('这条曲线只有 ' + own.length + ' 个曲线点（编号 0 到 ' + (own.length - 1) + '）。');
    if (index === 0 || index === own.length - 1) throw new Error('端点不在点群里移动，请用端移动。');
  }
  const points = own.map((p, i) => chosen.has(i) ? { x: p.x + (by.dx || 0), y: p.y + (by.dy || 0) } : copy(p));
  for (let i = 1; i < points.length; i++) if (distance(points[i], points[i - 1]) < 1e-6) throw new Error('移动后有两个曲线点重合。');
  return { curve: fitClampedSpline(points).curve, points: points.length, moved: chosen.size };
}
/**
 * Change a curve between two fixed places only (ET's 局部曲线编辑): the place that is taken hold of moves to its new
 * position, and outside the two fixed places the curve keeps its shape within the tolerance. This is done with points:
 * the curve points outside stay, and more are put on the old curve there until it holds.
 */
export function withLocalChange(entity, fixedFrom, fixedTo, grab, to, tolerance = SHAPE_TOLERANCE) {
  if (!entity || !entity.curve) throw new Error('这不是一条曲线。');
  if (entity.closed) throw new Error('闭合的曲线请先打断再做局部修改。');
  const own = pointsOf(entity), path = measured(entity), old = display(entity.curve), marks = along(old);
  let a = stationOf(path, fixedFrom), b = stationOf(path, fixedTo); if (a > b) [a, b] = [b, a];
  const g = stationOf(path, grab);
  if (!(b - a > 1)) throw new Error('两个固定点离得太近。');
  if (!(g > a + .5 && g < b - .5)) throw new Error('要移动的位置须在两个固定点之间。');
  const stations = own.points.map(p => stationOf(path, p));
  let pins = own.points.map((p, i) => ({ at: stations[i], point: copy(p) })).filter(pin => Math.abs(pin.at - a) > .05 && Math.abs(pin.at - b) > .05);
  pins.push({ at: a, point: placeAt(path, a).point }, { at: b, point: placeAt(path, b).point });
  // the point that moves: a curve point already there, or a new one
  const near = pins.filter(pin => pin.at > a && pin.at < b).sort((p, q) => Math.abs(p.at - g) - Math.abs(q.at - g))[0];
  if (near && Math.abs(near.at - g) < .5) near.point = copy(to); else pins.push({ at: g, point: copy(to), moved: true });
  const outside = position => position <= a + 1e-9 || position >= b - 1e-9;
  const kept = old.filter((_, i) => outside(marks[i])), keptAt = marks.filter(outside);
  for (let round = 0; round < 200; round++) {
    pins.sort((p, q) => p.at - q.at);
    for (let i = 1; i < pins.length; i++) if (distance(pins[i].point, pins[i - 1].point) < 1e-6) throw new Error('移动后有两个曲线点重合。');
    const curve = fitClampedSpline(pins.map(pin => pin.point)).curve, shown = display(curve);
    // how far the parts outside the fixed places have moved, looked at from the old curve
    let worst = { distance: 0, at: 0 };
    kept.forEach((p, i) => { let best = Infinity; for (let k = 1; k < shown.length; k++) { const d = toSegment(p, shown[k - 1], shown[k]); if (d < best) best = d; } if (best > worst.distance) worst = { distance: best, at: keptAt[i] }; });
    if (worst.distance <= tolerance) return { curve, points: pins.length, outsideChangeMm: worst.distance, addedPoints: pins.length - own.points.length, shapeChangeMm: own.gap };
    if (pins.length >= MAX_POINTS) throw new Error('固定点之外的形状保不住：曲线点已经加到 ' + MAX_POINTS + ' 个。请把两个固定点放得离要改的地方远一些。');
    const next = pins.findIndex(pin => pin.at > worst.at), before = pins[Math.max(0, (next < 0 ? pins.length : next) - 1)], after = pins[next < 0 ? pins.length - 1 : next];
    let wanted = worst.at; if (wanted - before.at < .05 || after.at - wanted < .05) wanted = (before.at + after.at) / 2;
    if (!outside(wanted) || after.at - before.at < .1) {   // put the new point into the widest gap that lies outside
      let widest = null; for (let i = 1; i < pins.length; i++) { const mid = (pins[i].at + pins[i - 1].at) / 2; if (outside(mid) && (!widest || pins[i].at - pins[i - 1].at > widest.width)) widest = { width: pins[i].at - pins[i - 1].at, mid }; }
      if (!widest || widest.width < .1) throw new Error('固定点之外的形状保不住，请把两个固定点放得离要改的地方远一些。');
      wanted = widest.mid;
    }
    pins.push({ at: wanted, point: placeAt(path, wanted).point });
  }
  throw new Error('局部修改没有算出来。');
}
