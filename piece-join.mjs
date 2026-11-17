/**
 * Putting shapes together (v62).
 *
 *  dockTransform   ET's 形状对接及复制: a figure is moved and turned so that one segment on it comes to lie on another
 *                  segment. The start of the first segment goes to the start of the second and the direction of the first
 *                  is turned to the direction of the second; nothing is scaled, so the end points meet only when the two
 *                  segments have the same length.
 *  spliceEdges     ET's 拼接合并: one edge of each of two pieces, as one new line. At the end that was pointed at, each edge
 *                  has a corner with another edge of its piece. The second piece is turned to where it lies when the two
 *                  pieces are sewn together there: those two other edges on one another, corner on corner. The first edge
 *                  keeps its direction and its free end goes where the new line is wanted; the second follows from the joint.
 *                  Measured on ET 2017 with pieces whose edges are straight and curved (five runs).
 *  mergePlan       ET's 裁片合并 (保形): two pieces into one along an edge of each; see there.
 * Where the other edge is a curve its direction at the corner is taken over its last 3 mm, as everywhere in this program;
 * ET takes it from the polyline it displays, so the turn can differ by a degree or two there.
 * Millimetres, y up. Pure functions, no DOM.
 */
import { outwardDirection, fitShape, shapeGap } from './construct-trim.mjs';
import { nativeFitPoints } from './fit-spline.mjs';
import { contoursForGroup, orientChain } from './topology.mjs';

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y }), norm = v => Math.hypot(v.x, v.y), dist = (a, b) => norm(sub(a, b)), copy = p => ({ x: p.x, y: p.y });
const turned = (v, radians) => ({ x: v.x * Math.cos(radians) - v.y * Math.sin(radians), y: v.x * Math.sin(radians) + v.y * Math.cos(radians) });
const within = degrees => { let d = degrees % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; };
const MEET = 1e-6;

/** The turn (degrees, counterclockwise, about fromStart) and the shift that dock a figure: fromStart to toStart, fromStart→fromEnd onto toStart→toEnd. */
export function dockTransform(fromStart, fromEnd, toStart, toEnd) {
  const a = sub(fromEnd, fromStart), b = sub(toEnd, toStart), before = norm(a), after = norm(b);
  if (!(before > 1e-6)) throw new Error('对接前的起点和终点重合，定不出方向。');
  if (!(after > 1e-6)) throw new Error('对接后的起点和终点重合，定不出方向。');
  return { degrees: within((Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x)) * 180 / Math.PI), dx: toStart.x - fromStart.x, dy: toStart.y - fromStart.y, lengthBeforeMm: before, lengthAfterMm: after };
}

const closedPolyline = e => !e.curve && e.points.length > 2 && (e.closed || dist(e.points[0], e.points.at(-1)) < MEET);
/** The edges of the outlines of a piece in order: a whole line or curve, or one side of a closed polyline (segmentIndex). */
export function pieceEdges(project, group) {
  const byId = new Map(project.entities.map(e => [e.id, e])), edges = [];
  contoursForGroup(group).forEach((contour, index) => {
    for (const id of contour.entityIds) {
      const e = byId.get(id); if (!e || e.type === 'text') continue;
      if (closedPolyline(e)) { const corners = e.closed ? e.points : e.points.slice(0, -1); corners.forEach((p, i) => edges.push({ contour: index, entity: e, segmentIndex: i, from: copy(p), to: copy(corners[(i + 1) % corners.length]) })); }
      else edges.push({ contour: index, entity: e, from: copy(e.points[0]), to: copy(e.points.at(-1)) });
    }
  });
  return edges;
}
const closed = edge => edge.segmentIndex === undefined && dist(edge.from, edge.to) < MEET;
/** The points along an edge from its start to its end: the corners of straight edges, the displayed points of a curve. */
const along = edge => edge.segmentIndex !== undefined ? [copy(edge.from), copy(edge.to)] : edge.entity.points.map(copy);
/** The direction in which an edge leaves one of its ends, into the edge. */
function into(edge, end) {
  if (edge.segmentIndex !== undefined || (!edge.entity.curve && edge.entity.points.length === 2)) { const v = end === 'start' ? sub(edge.to, edge.from) : sub(edge.from, edge.to), n = norm(v); return { x: v.x / n, y: v.y / n }; }
  const out = outwardDirection(edge.entity, end); return { x: -out.x, y: -out.y };
}
/** One of the two edges that are joined: the edge, the end that joins, the corner there and the direction of the piece's other edge at that corner. */
function joining(project, pick, what) {
  const entity = project.entities.find(e => e.id === pick.entityId); if (!entity) throw new Error('找不到' + what + '。');
  const group = (project.groups || []).find(g => contoursForGroup(g).some(c => c.entityIds.includes(entity.id)));
  if (!group) throw new Error(what + '“' + entity.name + '”不是裁片的轮廓边。拼接合并接的是两个裁片的边：它按两片在连接处缝在一起的位置来摆。');
  const edges = pieceEdges(project, group), mine = edges.filter(e => e.entity.id === entity.id); let edge = mine[0];
  if (mine.length > 1) {
    if (Number.isInteger(pick.segmentIndex)) edge = mine.find(e => e.segmentIndex === pick.segmentIndex);
    else if (pick.near) edge = mine.reduce((best, e) => (toSegment(pick.near, e.from, e.to) < toSegment(pick.near, best.from, best.to) ? e : best));
    else throw new Error(what + '“' + entity.name + '”是一条闭合的轮廓，请用 segmentIndex 说明是它的第几条边（从 0 数起）。');
    if (!edge) throw new Error(what + '“' + entity.name + '”没有第 ' + pick.segmentIndex + ' 条边。');
  }
  if (closed(edge)) throw new Error(what + '“' + entity.name + '”自己首尾相接，没有可以连接的端。');
  const end = pick.joinEnd || (pick.near ? (dist(pick.near, edge.from) <= dist(pick.near, edge.to) ? 'start' : 'end') : null);
  if (end !== 'start' && end !== 'end') throw new Error('请说明' + what + '的哪一端是连接端：joinEnd 写 start 或 end，或者用 near 给出靠近那一端的点。');
  const corner = end === 'start' ? edge.from : edge.to;
  const other = edges.find(e => e !== edge && e.contour === edge.contour && (dist(e.from, corner) < MEET || dist(e.to, corner) < MEET));
  if (!other) throw new Error('在' + what + '“' + entity.name + '”的连接端找不到这个裁片的相邻边。');
  const path = along(edge), free = end === 'start' ? edge.to : edge.from;
  return { entity, group, edge, end, corner: copy(corner), free: copy(free), other, neighbour: into(other, dist(other.from, corner) < MEET ? 'start' : 'end'), path, straight: path.length === 2 };
}
function toSegment(p, a, b) { const ab = sub(b, a), l2 = ab.x * ab.x + ab.y * ab.y, t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2)) : 0; return dist(p, add(a, { x: ab.x * t, y: ab.y * t })); }
const lengthOf = points => points.slice(1).reduce((sum, p, i) => sum + dist(points[i], p), 0);

/**
 * Two edges of two pieces as one line (ET's 拼接合并).
 *   first, second   { entityId, segmentIndex?, joinEnd?: 'start' | 'end', near?: point }: the edge and the end of it that joins
 *   at              where the free end of the first edge goes
 * Returns the new line as `points` (straight edges: its corners) or as `curve` with `points` along it, and what was done:
 * the joint, the turn of the second piece, the angle between the two edges at the joint (0: they run on smoothly) and how
 * far a fitted curve leaves the true shape.
 */
export function spliceEdges(project, first, second, at) {
  const a = joining(project, first, '第一条边'), b = joining(project, second, '第二条边');
  if (a.group.id === b.group.id) throw new Error('两条边属于同一个裁片“' + a.group.name + '”。拼接合并接的是两个裁片的边。');
  const radians = Math.atan2(a.neighbour.y, a.neighbour.x) - Math.atan2(b.neighbour.y, b.neighbour.x);   // the second piece's other edge onto the first piece's
  const shift = sub(at, a.free), joint = add(a.corner, shift);
  const one = (a.end === 'end' ? a.path : a.path.slice().reverse()).map(p => add(p, shift));               // from the free end to the joint
  const two = (b.end === 'start' ? b.path : b.path.slice().reverse()).map(p => add(joint, turned(sub(p, b.corner), radians)));   // from the joint to the free end
  const arriving = sub(one.at(-1), one.at(-2)), leaving = sub(two[1], two[0]);
  const kink = Math.abs(within((Math.atan2(leaving.y, leaving.x) - Math.atan2(arriving.y, arriving.x)) * 180 / Math.PI));
  const target = [...one, ...two.slice(1)], facts = { joint, turnedDegrees: within(radians * 180 / Math.PI), kinkDegrees: kink, firstLengthMm: lengthOf(one), secondLengthMm: lengthOf(two), pieces: [a.group.name, b.group.name], edges: [a.entity.name, b.entity.name] };
  if (a.straight && b.straight) return { ...facts, points: kink < 1e-7 ? [one[0], two.at(-1)] : [one[0], joint, two.at(-1)], shapeChangeMm: 0 };
  // a curve through points, as ET stores it: the curve points of the two edges, the joint, and as many more as the shape needs
  const place = (side, move) => (side.entity.curve && side.edge.segmentIndex === undefined ? (nativeFitPoints(side.entity.curve) || []) : side.path).map(move);
  const seeds = [...place(a, p => add(p, shift)), joint, ...place(b, p => add(joint, turned(sub(p, b.corner), radians)))];
  // points close to the joint on both sides hold the corner there; without them the fitting looks for them one by one
  const beside = (points, from) => [.1, .4, 1.5, 5].map(reach => { let left = reach, i = from ? 1 : points.length - 2, last = from ? points[0] : points.at(-1); for (; i > 0 && i < points.length - 1 && dist(points[i], last) < left; from ? i++ : i--) { left -= dist(points[i], last); last = points[i]; } const span = dist(points[i], last); return span > left ? add(last, { x: (points[i].x - last.x) * left / span, y: (points[i].y - last.y) * left / span }) : null; }).filter(Boolean);
  const ordered = [target[0], ...[...seeds, ...(kink > .5 ? [...beside(one, false), ...beside(two, true)] : [])].filter(p => dist(p, target[0]) > .05 && dist(p, target.at(-1)) > .05), target.at(-1)];
  // a line that turns back on itself at the joint is no curve of this kind: it is kept as points
  if (kink <= 120) for (const tolerance of [.01, .05]) { const fitted = fitShape(target, ordered, tolerance); if (fitted) return { ...facts, curve: fitted.curve, fitPoints: fitted.points, shapeChangeMm: fitted.gap }; }
  // no curve of this kind holds the shape (a sharp corner at the joint): the line is kept as the points along the two edges, thinned
  const apart = Math.max(2, (facts.firstLengthMm + facts.secondLengthMm) / 110), keep = [target[0]];
  for (const p of target.slice(1, -1)) if (dist(p, joint) < 1e-9 || (dist(p, keep.at(-1)) >= apart && dist(p, joint) >= apart / 2)) keep.push(p);
  keep.push(target.at(-1));
  return { ...facts, points: keep, shapeChangeMm: shapeGap(target, keep), asPoints: true };
}

/** The point at half the length of a path. */
function halfway(points) {
  const half = lengthOf(points) / 2; let run = 0;
  for (let i = 1; i < points.length; i++) { const d = dist(points[i - 1], points[i]); if (d > 0 && run + d >= half) { const t = (half - run) / d; return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t }; } run += d; }
  return copy(points.at(-1));
}
const CORNER = .15;   // edges of one outline meet within this (an outline may be closed with gaps of up to 0.1 mm)
/** An edge that is to be joined in a merge: a whole line of the outline of a piece, the other lines of that outline and which way round the outline runs. */
function mergeSide(project, pick, what) {
  const entity = project.entities.find(e => e.id === pick.entityId); if (!entity) throw new Error('找不到' + what + '。');
  const group = (project.groups || []).find(g => contoursForGroup(g).some(c => c.entityIds.includes(entity.id)));
  if (!group) throw new Error(what + '“' + entity.name + '”不是裁片的轮廓边。裁片合并并的是两个裁片：各指一条轮廓边。');
  const contour = contoursForGroup(group).find(c => c.entityIds.includes(entity.id));
  if (contour.role !== 'primary-contour') throw new Error(what + '“' + entity.name + '”是裁片“' + group.name + '”里面的孔的边，不能用来合并。');
  const lines = contour.entityIds.map(id => project.entities.find(e => e.id === id)).filter(Boolean);
  if (lines.some(closedPolyline) || lines.length < 2) throw new Error('裁片“' + group.name + '”的轮廓是一条闭合的线，没有分开的边。裁片合并要去掉其中一条边，请先把轮廓分成几条边。');
  const from = copy(entity.points[0]), to = copy(entity.points.at(-1));
  if (dist(from, to) < MEET) throw new Error(what + '“' + entity.name + '”自己首尾相接，不能用来合并。');
  const end = pick.joinEnd || (pick.near ? (dist(pick.near, from) <= dist(pick.near, to) ? 'start' : 'end') : null);
  if (end !== null && end !== 'start' && end !== 'end') throw new Error(what + '的 joinEnd 只能写 start 或 end。');
  // which way round: the outline in its own order, every line turned the way the chain runs
  const chain = orientChain(lines), ring = chain.flatMap(item => item.points.slice(0, -1)); let area = 0;
  ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; area += p.x * q.y - q.x * p.y; });
  if (!(Math.abs(area) > 1e-6)) throw new Error('裁片“' + group.name + '”的轮廓围不出面积。');
  const mine = chain.find(item => item.entity.id === entity.id);
  // true when the inside of the piece is on the left of the edge as it runs from its first point to its last
  const insideLeft = (area > 0) !== mine.reversed;
  const others = lines.filter(e => e.id !== entity.id), beside = corner => {
    let best = null;
    for (const e of others) for (const at of ['start', 'end']) { const d = dist(at === 'start' ? e.points[0] : e.points.at(-1), corner); if (d <= CORNER && (!best || d < best.gap)) best = { entity: e, end: at, gap: d }; }
    if (!best) throw new Error('在' + what + '“' + entity.name + '”的一端找不到裁片“' + group.name + '”的相邻边。');
    return best;
  };
  return { entity, group, contour, lines, from, to, end, insideLeft, path: entity.points.map(copy), neighbours: { start: beside(from), end: beside(to) } };
}

/**
 * Two pieces into one along an edge of each (ET's 裁片合并 in its 保形 mode), as measured on ET 2017 in six runs:
 *   - the second piece is turned (not mirrored, not scaled) until its edge, from its docking start to its other end, has the
 *     direction of the first edge from its docking start to its other end;
 *   - and moved until the point at half the length of its edge lies on the middle between the two ends of the first edge;
 *   - its edge goes; the two lines of its outline that met that edge are each turned and scaled about their far end until
 *     their near end lies on the end of the first edge (nothing changes when the two edges are equally long);
 *   - the first edge stays, as a line inside the merged piece.
 * first, second: { entityId, joinEnd?: 'start' | 'end', near?: point }. The docking starts decide which of two ways round
 * the second piece goes on. When one is not given, the way is taken in which the two pieces lie on different sides of the
 * joined edge; when both are given and the pieces would lie on one another, this throws (ET makes the piece and then calls
 * its seam abnormal).
 * Returns the turn (degrees, about `pivot`), the shift after it, and for each line beside the second edge where its near end
 * is after the move and where it has to go.
 */
export function mergePlan(project, first, second) {
  const a = mergeSide(project, first, '第一条边'), b = mergeSide(project, second, '第二条边');
  if (a.group.id === b.group.id) throw new Error('两条边属于同一个裁片“' + a.group.name + '”。裁片合并并的是两个裁片。');
  // The inside of a piece keeps its side when the piece is turned. The pieces lie apart when, seen along the common
  // direction, one has its inside on the left and the other on the right.
  const insideLeft = (side, end) => (end === 'start') === side.insideLeft, flip = end => (end === 'start' ? 'end' : 'start');
  let endA = a.end, endB = b.end; const chosen = !(endA && endB);
  if (!endA && !endB) endA = 'start';
  if (!endB) endB = insideLeft(b, 'start') !== insideLeft(a, endA) ? 'start' : 'end';
  if (!endA) endA = insideLeft(a, 'start') !== insideLeft(b, endB) ? 'start' : 'end';
  if (insideLeft(a, endA) === insideLeft(b, endB)) throw new Error('这样对接，“' + b.group.name + '”会转过去压在“' + a.group.name + '”上面：两条边的对接起点要选在缝合时碰在一起的那一头。把其中一条边的 joinEnd 换成 ' + flip(endB) + '，或者两个都不给，由程序来定。');
  const s1 = endA === 'start' ? a.from : a.to, e1 = endA === 'start' ? a.to : a.from, s2 = endB === 'start' ? b.from : b.to, e2 = endB === 'start' ? b.to : b.from;
  const radians = Math.atan2(e1.y - s1.y, e1.x - s1.x) - Math.atan2(e2.y - s2.y, e2.x - s2.x), pivot = halfway(b.path), target = { x: (s1.x + e1.x) / 2, y: (s1.y + e1.y) / 2 };
  const place = p => add(target, turned(sub(p, pivot), radians));
  // the lines beside the second edge: where their near end is after the move, and the end of the first edge it has to reach
  const near = [{ ...b.neighbours[endB], goes: s1, was: place(s2) }, { ...b.neighbours[flip(endB)], goes: e1, was: place(e2) }];
  for (const n of near) { const ends = [n.entity.points[0], n.entity.points.at(-1)]; n.far = place(n.end === 'start' ? ends[1] : ends[0]); n.near = place(n.end === 'start' ? ends[0] : ends[1]); }
  return { first: a, second: b, joinEnds: [endA, endB], chosen, degrees: within(radians * 180 / Math.PI), radians, pivot, target, shift: sub(target, pivot),
    firstLengthMm: lengthOf(a.path), secondLengthMm: lengthOf(b.path), chordsMm: [dist(s1, e1), dist(s2, e2)], ends: [copy(s1), copy(e1)], near };
}
