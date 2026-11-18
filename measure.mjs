/**
 * Measuring. Nothing here changes the drawing: each function reads lines and points and
 * returns numbers in millimetres and degrees. Lengths along a curve are taken on the
 * curve itself, the same way the drafting commands place a point on it.
 */
import { nearestStation } from './construct.mjs';
import { length as entityLength } from './geometry.mjs';
import { lengthsInSizes } from './measure-sizes.mjs';

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), dot = (a, b) => a.x * b.x + a.y * b.y, cross = (a, b) => a.x * b.y - a.y * b.x, norm = a => Math.hypot(a.x, a.y);
const round = (value, digits = 3) => { const f = 10 ** digits; return Math.round(value * f) / f; };
const degrees = radians => radians * 180 / Math.PI;
function path(entity, what) { if (!entity || entity.type === 'text') throw new Error(what + '须是一条线或曲线。'); return entity; }
/** The exact length of a line or curve. */
export function lengthOf(entity) { return entityLength(path(entity, '要量的对象')); }

/** The straight distance between two points, with its horizontal and vertical parts. */
export function pointDistance(a, b) { return { lengthMm: round(norm(sub(b, a))), dxMm: round(b.x - a.x), dyMm: round(b.y - a.y) }; }

/**
 * The angle between two lines. Each line is taken at the place nearest to the point given for it
 * (for a curve, its tangent there). When the two directions meet, the angle is the one between
 * the two arms that run from the meeting point towards those places; the other side is 180 minus it.
 */
export function linesAngle(first, firstNear, second, secondNear) {
  const a = nearestStation(path(first, '第一条线'), firstNear || first.points[0]), b = nearestStation(path(second, '第二条线'), secondNear || second.points[0]);
  const u = a.direction, v = b.direction, denominator = cross(u, v);
  if (Math.abs(denominator) < 1e-12) return { degrees: 0, otherSideDegrees: 180, parallel: true, meet: null };
  const t = cross(sub(b.point, a.point), v) / denominator, meet = { x: a.point.x + u.x * t, y: a.point.y + u.y * t };
  // an arm runs from the meeting point to the place that was pointed at; at the meeting point itself the line's own direction is kept
  const arm = (place, direction) => { const w = sub(place, meet); return norm(w) > 1e-7 ? w : direction; };
  const p = arm(a.point, u), q = arm(b.point, v), angle = degrees(Math.atan2(Math.abs(cross(p, q)), dot(p, q)));
  return { degrees: round(angle), otherSideDegrees: round(180 - angle), parallel: false, meet: { x: round(meet.x), y: round(meet.y) } };
}

/** The angle at a corner between the arms to two other points, from 0 to 180 degrees, with the length of each arm. */
export function threePointAngle(a, vertex, b) {
  const p = sub(a, vertex), q = sub(b, vertex);
  if (!(norm(p) > 1e-9) || !(norm(q) > 1e-9)) throw new Error('三个点里有两个重合，量不出角度。');
  return { degrees: round(degrees(Math.atan2(Math.abs(cross(p, q)), dot(p, q)))), firstArmMm: round(norm(p)), secondArmMm: round(norm(q)) };
}

/** Two places on one line: the length along the line between them, the straight distance, and where each lies from the line's start. */
export function alongBetween(entity, first, second) {
  const a = nearestStation(path(entity, '要量的线'), first), b = nearestStation(entity, second), total = lengthOf(entity);
  // nearestStation measures on the displayed polyline; the exact curve length is at most a few thousandths longer, so positions are scaled to it
  const factor = a.total > 0 ? total / a.total : 1, from = a.position * factor, to = b.position * factor, along = Math.abs(to - from);
  // a circle is a curve that ends where it starts: there are two ways round it, as on a closed outline
  const loop = entity.closed || (entity.points.length > 2 && norm(sub(entity.points[0], entity.points.at(-1))) < 1e-6);
  return { alongMm: round(along), ...(loop ? { otherWayMm: round(total - along) } : {}), straightMm: round(norm(sub(b.point, a.point))), firstFromStartMm: round(from), secondFromStartMm: round(to), lineLengthMm: round(total),
    points: [{ x: a.point.x, y: a.point.y }, { x: b.point.x, y: b.point.y }] };
}

/** Two groups of lines: the total length of each and the difference (first minus second). The second group may be empty. */
export function compareGroups(first, second = []) {
  if (!first.length) throw new Error('第一组里还没有线。');
  const list = group => group.map(entity => ({ id: entity.id, name: entity.name, lengthMm: round(lengthOf(entity)) })), total = items => round(items.reduce((sum, item) => sum + item.lengthMm, 0));
  const a = list(first), b = list(second), totalA = total(a), totalB = total(b);
  return { first: a, second: b, firstTotalMm: totalA, secondTotalMm: totalB, ...(b.length ? { differenceMm: round(totalA - totalB) } : {}) };
}

/** Marks along a line, as on a tape measure: one every stepMm from the chosen end, each with the length up to it. */
export function tapeMarks(entity, from = 'start', stepMm = 10) {
  const total = lengthOf(path(entity, '要量的线'));
  if (!(stepMm > 0)) throw new Error('刻度间隔须大于 0。');
  if (!(total > 0)) throw new Error('这条线没有长度。');
  if (total / stepMm > 400) throw new Error('刻度太密：这条线长 ' + round(total, 1) + ' mm，间隔至少要 ' + round(total / 400, 1) + ' mm。');
  // walked on the displayed points (within a few thousandths of a millimetre of a curve), with distances scaled to the exact length
  let points = entity.closed ? [...entity.points, entity.points[0]] : [...entity.points]; if (from === 'end') points = points.reverse();
  const drawn = points.reduce((sum, q, i) => i ? sum + norm(sub(q, points[i - 1])) : 0, 0), factor = drawn / total, marks = [];
  const targets = []; for (let index = 0; index * stepMm < total - 1e-7; index++) targets.push(index * stepMm); targets.push(total);
  let segment = 1, travelled = 0;
  for (const distance of targets) {
    const goal = Math.min(drawn, distance * factor);
    while (segment < points.length - 1 && travelled + norm(sub(points[segment], points[segment - 1])) < goal - 1e-12) { travelled += norm(sub(points[segment], points[segment - 1])); segment++; }
    const a = points[segment - 1], b = points[segment], span = norm(sub(b, a)), t = span > 0 ? Math.max(0, Math.min(1, (goal - travelled) / span)) : 0, direction = span > 0 ? { x: (b.x - a.x) / span, y: (b.y - a.y) / span } : { x: 1, y: 0 };
    marks.push({ distanceMm: round(distance), point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, normal: { x: -direction.y, y: direction.x } });
  }
  return { lineLengthMm: round(total), stepMm, marks };
}

/**
 * One entry for every kind of measurement, for callers that hold ids rather than objects (the command interface, the assistant).
 * query: { kind: 'length', entityIds } | { kind: 'distance', from, to } | { kind: 'angle', firstEntityId, secondEntityId, firstNear?, secondNear? }
 *      | { kind: 'threePoint', a, vertex, b } | { kind: 'along', entityId, first, second } | { kind: 'compare', firstEntityIds, secondEntityIds? }
 * v72: when the drawing is graded, 'length' and 'compare' also give `perSize`, the totals in every size as ET's table 要素检查
 * shows them (sizes from small to large, the base marked).
 */
export function measure(project, query) {
  const entity = id => { const found = project.entities.find(e => e.id === id); if (!found) throw new Error('找不到图元 ' + id + '。'); return found; };
  const isPoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y), need = (ok, message) => { if (!ok) throw new Error(message); };
  const perSize = groups => {
    const measured = lengthsInSizes(project, groups); if (!measured) return {};
    return { perSize: { baseSize: measured.baseSize, sizes: measured.sizes.map(size => ({ label: size.label, base: size.base, totalsMm: size.totalsMm.map(v => v === null ? null : round(v)), ...(size.missing.length ? { missing: size.missing } : {}), ...(size.error ? { error: size.error } : {}) })) } };
  };
  need(query && typeof query === 'object', '缺少测量内容。');
  if (query.kind === 'length') { need(Array.isArray(query.entityIds) && query.entityIds.length, '请给出要量的线。'); const result = compareGroups(query.entityIds.map(entity)); return { kind: 'length', lines: result.first, totalMm: result.firstTotalMm, ...perSize([query.entityIds]) }; }
  if (query.kind === 'distance') { need(isPoint(query.from) && isPoint(query.to), '两点测量需要两个点。'); return { kind: 'distance', ...pointDistance(query.from, query.to) }; }
  if (query.kind === 'angle') return { kind: 'angle', ...linesAngle(entity(query.firstEntityId), isPoint(query.firstNear) ? query.firstNear : null, entity(query.secondEntityId), isPoint(query.secondNear) ? query.secondNear : null) };
  if (query.kind === 'threePoint') { need(isPoint(query.a) && isPoint(query.vertex) && isPoint(query.b), '三点角度需要三个点。'); return { kind: 'threePoint', ...threePointAngle(query.a, query.vertex, query.b) }; }
  if (query.kind === 'along') { need(isPoint(query.first) && isPoint(query.second), '线上两点测量需要两个点。'); const { points, ...rest } = alongBetween(entity(query.entityId), query.first, query.second); return { kind: 'along', ...rest }; }
  if (query.kind === 'compare') {
    need(Array.isArray(query.firstEntityIds), '综合测量需要第一组线。'); const second = query.secondEntityIds || [];
    return { kind: 'compare', ...compareGroups(query.firstEntityIds.map(entity), second.map(entity)), ...perSize(second.length ? [query.firstEntityIds, second] : [query.firstEntityIds]) };
  }
  throw new Error('不认识的测量种类。');
}
