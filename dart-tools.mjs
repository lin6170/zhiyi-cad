/**
 * Darts the way ET 2017 makes them (v64). Each rule below was learned by running ET's own tool on a test drawing and reading
 * back the file it saved; tests/dart-tools-v64.mjs repeats every run and compares the lines with the files ET saved.
 *
 * - 法向省 (ET's 省道 tool, first mode): the mouth is centred on the place of the edge nearest to where the drag began, half the
 *   intake to each side measured along the edge; the tip lies square to the edge at that place, the dart length away, on the side
 *   the drag went to. ET cuts the edge at the two mouth points and leaves the part between them out.
 * - 斜省 (second mode): the foot is where the centre line, or its extension, meets the edge; the mouth lies around the foot as
 *   above; the tip is the other end of the centre line, which ET then removes.
 * - 省折 and 省折线 (the dart folded to one side): the leg on the folded side stays and the other leg gets the same length along
 *   its own direction, its mouth point and the end of the edge there moving with it; the crease is the bisector of the two legs;
 *   the cap on the folded side is the edge beyond that mouth mirrored in the folded leg, up to the crease; the cap on the other
 *   side is the same piece of edge turned about the tip from the folded leg onto the other leg. Both caps end in the same peak on
 *   the crease. ET also draws the crease, from the tip to the peak (with a 省深度 from the peak down that far, the legs then being
 *   cut that far from their mouths), and a mark showing the fold: a curve through p1, 0.7 of the way from the inner end of the
 *   folded leg to its mouth, p2, 0.3 of the way along the other leg, and p1 + (0.5 + 0.1 i)(p2 - p1).
 * - 枣弧省: a base point, the upper tip a given by its offset from the base point, the intake across the line from a to the base
 *   point, the lower tip that line's continuation by the L amount; four straight lines, or (曲线处理) two curves through the
 *   tips and the widest points, at a third and two thirds of each half taking 2/3 and 1/4 of the half intake; an opening splits
 *   the lower tip in two across the dart, and the lower halves are then straight.
 * - 单向省: a copy of one leg turned about its tip until its other end is the intake away from the other end of the leg.
 * - 两点做省: the mouth runs between two points of the edge, which is cut there; the tip lies square to the chord, from the middle
 *   of the chord, the depth away.
 * - 插入省: a copy of the dart line turned about the tip until its mouth end is the intake away, to the side away from the
 *   reference line; the line meeting the mouth on that side is joined to the new mouth. When the reference line is among the
 *   chosen lines, every other chosen line is also moved the intake along the reference line, towards the end that was pointed at.
 * - 掰开省: the lines on the opening side turn about a hinge point until the mouth has moved the intake; the line the hinge is
 *   on is cut there; a new leg runs from the tip to the moved mouth.
 * All lengths are millimetres. The functions take and return plain shapes ({ points } or { curve }) and leave projects alone.
 */
import * as trim from './construct-trim.mjs';
import { fitClampedSpline, nativeFitPoints } from './fit-spline.mjs';

const P = (x, y) => ({ x, y });
const sub = (a, b) => P(a.x - b.x, a.y - b.y), add = (a, v, k = 1) => P(a.x + v.x * k, a.y + v.y * k), scale = (v, k) => P(v.x * k, v.y * k);
const dot = (a, b) => a.x * b.x + a.y * b.y, cross = (a, b) => a.x * b.y - a.y * b.x, norm = v => Math.hypot(v.x, v.y);
const distance = (a, b) => norm(sub(a, b)), middle = (a, b) => P((a.x + b.x) / 2, (a.y + b.y) / 2), copy = q => P(q.x, q.y);
const unit = (v, message = '方向不确定。') => { const n = norm(v); if (!(n > 1e-12)) throw new Error(message); return P(v.x / n, v.y / n); };
const round = v => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- maps that keep distances
/** A turn about a point by an angle (radians, counter-clockwise). */
export function turning(centre, angle) { const c = Math.cos(angle), s = Math.sin(angle); return q => { const v = sub(q, centre); return P(centre.x + c * v.x - s * v.y, centre.y + s * v.x + c * v.y); }; }
/** A mirror in the line through a point along a direction. */
export function mirroring(origin, direction) { const u = unit(direction); return q => { const v = sub(q, origin), k = 2 * dot(v, u); return P(origin.x + k * u.x - v.x, origin.y + k * u.y - v.y); }; }
/** A shift by a vector. */
export const shifting = v => q => add(q, v);
/** A shape ({ points } or { curve }) moved by a map that keeps distances. A curve is fitted again through its moved curve points,
 *  which gives the moved curve (the fit depends only on the distances between the points). */
export function mappedShape(shape, map) {
  if (shape.curve) return { curve: fitClampedSpline(nativeFitPoints(shape.curve).map(map)).curve };
  return { points: shape.points.map(map) };
}
/** The first and last point of a shape. */
export function endsOf(shape) { if (shape.curve) { const fit = nativeFitPoints(shape.curve); return [fit[0], fit.at(-1)]; } return [shape.points[0], shape.points.at(-1)]; }
const asEntity = shape => shape.curve ? { type: 'polyline', points: [...endsOf(shape)], curve: shape.curve } : { type: 'polyline', points: shape.points };
/** The shape of a line or curve entity. */
export const shapeOfEntity = entity => entity.curve ? { curve: entity.curve } : { points: entity.points.map(copy) };

// ---------------------------------------------------------------- the mouth on an edge
/** The mouth of a dart around a place of an edge (a length from its start): half the intake to each side, along the edge. */
export function mouthAround(edge, at, width) {
  if (!(width > 0)) throw new Error('省量须大于 0。');
  const total = trim.pathLength(edge), half = width / 2;
  if (at - half < -1e-7 || at + half > total + 1e-7) throw new Error('省口超出了这条边：省的位置离边的一端只有 ' + round(Math.min(at, total - at)) + ' mm，省量的一半是 ' + round(half) + ' mm。');
  const from = Math.max(0, at - half), to = Math.min(total, at + half), centre = trim.placeAlong(edge, at);
  return { at, from, to, total, centre: centre.point, tangent: centre.direction, first: trim.placeAlong(edge, from).point, second: trim.placeAlong(edge, to).point };
}
/** What is left of an edge when the part between two lengths from its start is cut out: the part before and the part after
 *  (null when shorter than 0.001 mm). The mouth points are taken from the parts, so that lines drawn to them meet the parts. */
export function cutOut(edge, from, to, mouth = [trim.placeAlong(edge, from).point, trim.placeAlong(edge, to).point]) {
  const total = trim.pathLength(edge), before = from > 1e-3 ? trim.partBetween(edge, 0, from) : null, after = total - to > 1e-3 ? trim.partBetween(edge, to, total) : null;
  if (before && !before.curve) before.points[before.points.length - 1] = copy(mouth[0]);
  if (after && !after.curve) after.points[0] = copy(mouth[1]);
  return { before: before && (before.curve ? { curve: before.curve } : { points: before.points }), after: after && (after.curve ? { curve: after.curve } : { points: after.points }),
    mouth: [before && before.curve ? endsOf(before)[1] : copy(mouth[0]), after && after.curve ? endsOf(after)[0] : copy(mouth[1])] };
}
const sideSign = (from, along, point) => Math.sign(cross(along, sub(point, from)));

// ---------------------------------------------------------------- 法向省, 斜省, 两点做省
/** 法向省: the mouth around the place of the edge nearest to `near` (or at a length `at`), the tip square to the edge on the side
 *  of `toward` (a point, or a function of the place and the normal that says whether that normal points to the right side). */
export function normalDart(edge, { at, near }, width, length, toward) {
  if (!(length > 0)) throw new Error('省长须大于 0。');
  const place = typeof at === 'number' ? at : trim.nearestOnPath(edge, near).at, mouth = mouthAround(edge, place, width);
  let normal = P(-mouth.tangent.y, mouth.tangent.x);
  const right = typeof toward === 'function' ? toward(mouth.centre, normal) : dot(sub(toward, mouth.centre), normal) > 0;
  if (!right) normal = scale(normal, -1);
  const cut = cutOut(edge, mouth.from, mouth.to, [mouth.first, mouth.second]);
  return { ...mouth, normal, tip: add(mouth.centre, normal, length), cut, mouthPoints: cut.mouth };
}
/** 斜省: the foot is the end of the centre line on the edge, or where the centre line's extension meets it; the tip is its other end. */
export function slantDart(edge, centreLine, width) {
  const [a, b] = [centreLine.points[0], centreLine.points.at(-1)], na = trim.nearestOnPath(edge, a), nb = trim.nearestOnPath(edge, b);
  let tip = na.away <= nb.away ? b : a, near = na.away <= nb.away ? a : b, foot = null;
  // the crossing of the centre line, extended, with the edge, nearest to the end that is meant to stand on it
  const reach = Math.max(trim.pathLength(edge), distance(a, b)) * 4, dir = unit(sub(near, tip), '省中线没有长度。');
  const ray = { type: 'polyline', points: [copy(tip), add(tip, dir, reach)] }, hits = trim.crossings(edge, ray);
  if (hits.length) foot = hits.reduce((p, q) => distance(q.point, near) < distance(p.point, near) ? q : p);
  if (!foot) { const n = trim.nearestOnPath(edge, near); if (n.away > .05) throw new Error('省中线（或它的延长线）碰不到做省的边。'); foot = { at: n.at, point: n.point }; }
  const at = foot.at ?? trim.nearestOnPath(edge, foot.point).at, mouth = mouthAround(edge, at, width), cut = cutOut(edge, mouth.from, mouth.to, [mouth.first, mouth.second]);
  return { ...mouth, foot: foot.point, tip: copy(tip), cut, mouthPoints: cut.mouth, length: distance(tip, foot.point) };
}
/** 两点做省: the mouth between two points of the edge (the nearest places), the tip square to the chord from its middle. */
export function twoPointDart(edge, first, second, depth, toward) {
  if (!(depth > 0)) throw new Error('省深度须大于 0。');
  let a = trim.nearestOnPath(edge, first).at, b = trim.nearestOnPath(edge, second).at; if (a > b) [a, b] = [b, a];
  if (!(b - a > 1e-3)) throw new Error('两个点在边上重合了。');
  const cut = cutOut(edge, a, b), [m1, m2] = cut.mouth, chord = unit(sub(m2, m1)), centre = middle(m1, m2);
  let normal = P(-chord.y, chord.x); if (dot(sub(toward, centre), normal) < 0) normal = scale(normal, -1);
  return { from: a, to: b, total: trim.pathLength(edge), cut, mouthPoints: [m1, m2], centre, normal, tip: add(centre, normal, depth), widthMm: distance(m1, m2) };
}

// ---------------------------------------------------------------- the dart folded to one side (省折, 省折线)
/** The cap of a dart folded to one side. tip; foldMouth, otherMouth: the mouth points of the folded leg and the other leg;
 *  beyond: the edge beyond the folded mouth as an entity running away from the dart (its start at the mouth); depth: 0, or the
 *  省深度 of ET's 省折线 tool. */
export function foldDart({ tip, foldMouth, otherMouth, beyond, depth = 0 }) {
  const lf = distance(foldMouth, tip), uf = unit(sub(foldMouth, tip), '省边没有长度。'), uo = unit(sub(otherMouth, tip), '省边没有长度。');
  const other = add(tip, uo, lf), angle = Math.atan2(cross(uf, uo), dot(uf, uo));
  if (!(Math.abs(angle) > 1e-9) || Math.abs(angle) > Math.PI - 1e-6) throw new Error('两条省边重合或在一条直线上，不能折倒。');
  const crease = unit(add(uf, uo)), mirror = mirroring(tip, uf), turn = turning(tip, angle);
  // where the edge beyond the folded mouth, mirrored in the folded leg, reaches the crease
  const total = trim.pathLength(beyond), side = s => cross(crease, sub(mirror(trim.placeAlong(beyond, s).point), tip));
  const steps = Math.max(8, Math.ceil(total / 2)); let lo = null, hi = null;
  for (let k = 1; k <= steps; k++) { const s0 = total * (k - 1) / steps, s1 = total * k / steps; if (side(s0) === 0) { lo = hi = s0; break; } if (Math.sign(side(s0)) !== Math.sign(side(s1))) { lo = s0; hi = s1; break; } }
  if (lo === null) throw new Error('省口外面的那段边太短，折倒后到不了省的中线，画不出省山。');
  for (let k = 0; k < 80 && hi - lo > 1e-12; k++) { const m = (lo + hi) / 2; if (Math.sign(side(m)) === Math.sign(side(lo))) lo = m; else hi = m; }
  const reach = (lo + hi) / 2; if (!(reach > 1e-6)) throw new Error('这个省太宽或太短，画不出省山。');
  const part = trim.partBetween(beyond, 0, reach), piece = part.curve ? { curve: part.curve } : { points: part.points };
  const foldCap = mappedShape(piece, mirror), otherCap = mappedShape(piece, turn), peak = endsOf(foldCap)[1];
  // with a 省深度 the legs stop that far from their mouths and the crease is drawn that far down from the peak
  const cutAt = depth > 0 ? Math.min(depth, lf) : lf, foldInner = add(foldMouth, scale(uf, -1), cutAt), otherInner = add(other, scale(uo, -1), cutAt);
  const centre = depth > 0 ? [add(peak, crease, -depth), peak] : [copy(tip), peak];
  const p1 = add(foldInner, sub(foldMouth, foldInner), .7), p2 = add(otherInner, sub(other, otherInner), .3), d = sub(p2, p1);
  const mark = [p1, p2, add(p1, P(.5 * d.x - .1 * d.y, .5 * d.y + .1 * d.x))];
  return { tip: copy(tip), foldMouth: copy(foldMouth), otherMouth: other, otherMoved: distance(other, otherMouth), crease, peak, peakHeightMm: Math.abs(cross(sub(other, foldMouth), sub(peak, foldMouth))) / distance(other, foldMouth),
    foldCap, otherCap, centre, mark, legs: { fold: [copy(foldMouth), foldInner], other: [copy(other), otherInner] }, angleDegrees: Math.abs(angle) * 180 / Math.PI, legLengthMm: lf };
}
/** The edge beyond a mouth point as an entity starting at the mouth: `edge` is the edge part (entity) that ends or starts there. */
export function beyondMouth(edgePart, mouth) {
  const ends = [edgePart.points[0], edgePart.points.at(-1)], atStart = distance(ends[0], mouth) <= distance(ends[1], mouth);
  if (Math.min(distance(ends[0], mouth), distance(ends[1], mouth)) > .05) throw new Error('这条边没有接在省口上。');
  if (atStart) return edgePart;
  const shape = shapeOfEntity(edgePart);
  if (shape.curve) return asEntity({ curve: fitClampedSpline(nativeFitPoints(shape.curve).slice().reverse()).curve });
  return { type: 'polyline', points: shape.points.slice().reverse() };
}

// ---------------------------------------------------------------- 枣弧省
/** 枣弧省 as ET draws it: base (the widest place), top (the upper tip), width, below (from the base point on to the lower tip),
 *  opening (the lower tip split in two, across the dart), curved (ET's 曲线处理). The shapes in ET's order. */
export function fishDart({ base, top, width, below, opening = 0, curved = false }) {
  if (!(width > 0) || !(below > 0)) throw new Error('省量和 L 量须大于 0。');
  const above = distance(top, base); if (!(above > 1e-6)) throw new Error('上面的省尖和基准点重合了。');
  if (opening < 0 || opening >= width) throw new Error('开口须小于省量。');
  const v = unit(sub(top, base)), u = P(v.y, -v.x), at = (across, along) => add(add(base, u, across), v, along), h = width / 2;
  const right = at(h, 0), left = at(-h, 0), bottom = at(0, -below), lowRight = at(opening / 2, -below), lowLeft = at(-opening / 2, -below);
  if (!curved) return { shapes: opening > 0 ? [[top, right], [right, lowRight], [lowLeft, left], [left, top]].map(points => ({ points: points.map(copy) })) : [[top, right], [right, bottom], [bottom, left], [left, top]].map(points => ({ points: points.map(copy) })), top: copy(top), bottom, left, right };
  const upper = s => [top, at(s * h / 4, 2 * above / 3), at(s * h * 2 / 3, above / 3), at(s * h, 0)], lower = s => [at(s * h * 2 / 3, -below / 3), at(s * h / 4, -2 * below / 3), bottom];
  const shapes = opening > 0 ? [{ curve: fitClampedSpline(upper(-1)).curve }, { curve: fitClampedSpline(upper(1)).curve }, { points: [left, lowLeft] }, { points: [right, lowRight] }]
    : [{ curve: fitClampedSpline([...upper(-1), ...lower(-1)]).curve }, { curve: fitClampedSpline([...upper(1), ...lower(1)]).curve }];
  return { shapes, top: copy(top), bottom, left, right };
}

// ---------------------------------------------------------------- 单向省, 插入省, 掰开省
/** The turn that moves a point `reach` away from a centre by a chord of `width`, the sign chosen so the point lands on the side of `toward` (a point, relative to the line from the centre to the point). */
function chordTurn(centre, point, width, toward) {
  const radius = distance(point, centre); if (!(radius > 1e-6)) throw new Error('转动的中心和省口重合了。');
  if (!(width > 0)) throw new Error('省量须大于 0。'); if (width >= 2 * radius) throw new Error('省量太大：省口离转动中心只有 ' + round(radius) + ' mm。');
  const angle = 2 * Math.asin(width / (2 * radius)), wanted = Math.sign(cross(sub(point, centre), sub(toward, centre))) || 1;
  return wanted * angle;
}
/** 单向省: a copy of a leg (entity) turned about its tip end (start or end) so that its other end moves by the intake, to the side of `toward`. */
export function singleDart(leg, tipEnd, width, toward) {
  const shape = shapeOfEntity(leg), [s, e] = endsOf(shape), tip = tipEnd === 'start' ? s : e, far = tipEnd === 'start' ? e : s;
  const angle = chordTurn(tip, far, width, toward), turned = mappedShape(shape, turning(tip, angle));
  return { shape: turned, tip: copy(tip), mouth: [copy(far), turning(tip, angle)(far)], angleDegrees: Math.abs(angle) * 180 / Math.PI };
}
/** The side of a line (from → along) a point is on: 1, -1 or 0. */
export const sideOf = (from, to, point) => sideSign(from, sub(to, from), point);
/** 插入省: dart: { tip, mouth }; reference: the shape of the reference line; the new mouth is on the side away from it. */
export function insertedLeg(tip, mouth, width, referencePoint) {
  const away = sideOf(tip, mouth, referencePoint) || 1, normal = P(-(mouth.y - tip.y), mouth.x - tip.x), toward = add(mouth, normal, -away);
  const angle = chordTurn(tip, mouth, width, toward), newMouth = turning(tip, angle)(mouth);
  return { newMouth, angle, angleDegrees: Math.abs(angle) * 180 / Math.PI };
}
/** 掰开省: the turn about the hinge that moves the mouth by the intake. Its sense is the one that, about the tip, would carry the
 *  mouth towards the opening side (where `openSide` lies); ET keeps that sense wherever the hinge is. */
export function openingTurn(tip, mouth, hinge, width, openSide) {
  const sign = sideOf(tip, mouth, openSide); if (!sign) throw new Error('看不出省往哪一边掰开。');
  const radius = distance(mouth, hinge); if (!(radius > 1e-6)) throw new Error('转动的点和省口重合了。');
  if (!(width > 0)) throw new Error('省量须大于 0。'); if (width >= 2 * radius) throw new Error('省量太大：省口离转动的点只有 ' + round(radius) + ' mm。');
  const angle = sign * 2 * Math.asin(width / (2 * radius));
  return { angle, moved: turning(hinge, angle)(mouth), angleDegrees: Math.abs(angle) * 180 / Math.PI };
}
/** Whether a point lies in the sector about the tip, between the rays to `a` and `b`, that holds `inside`. */
export function inSector(tip, a, b, inside) {
  const angleOf = q => Math.atan2(q.y - tip.y, q.x - tip.x), A = angleOf(a), span = ((angleOf(b) - A) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const at = q => ((angleOf(q) - A) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI), first = at(inside) < span;
  return q => (at(q) < span) === first;
}
/** A point on a shape halfway along it, to tell on which side a line lies. */
export function middleOf(shape) { const entity = asEntity(shape); return trim.placeAlong(entity, trim.pathLength(entity) / 2).point; }
/** A line or curve cut in two at a point on it (the nearest place): the part from its start and the part to its end. */
export function splitAt(entity, point) {
  const near = trim.nearestOnPath(entity, point), total = trim.pathLength(entity);
  if (near.at < 1e-3 || total - near.at < 1e-3) return { at: near.at, point: near.at < 1e-3 ? endsOf(shapeOfEntity(entity))[0] : endsOf(shapeOfEntity(entity))[1], parts: null, away: near.away };
  const cut = cutOut(entity, near.at, near.at, [near.point, near.point]);
  return { at: near.at, point: cut.before && cut.before.curve ? endsOf(cut.before)[1] : near.point, parts: [cut.before, cut.after], away: near.away };
}
