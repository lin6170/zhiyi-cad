/**
 * Taking a piece out of structure lines (ET's 提取裁片), v59.
 *
 * Structure lines cross each other and stick out past the corners of the shapes they draw. A piece is one closed region
 * between them. ET 2017 has the patternmaker click the lines around the region one after the other; it then copies the
 * part of each line between its neighbours, makes a piece of the copies with a grain line and a seam allowance, and leaves
 * the structure lines where they are. That was repeated on a probe drawing: four straight lines in the shape of a "#", and
 * three straight lines closed by a curve. The copies ET makes are the parts between the crossings, each in the direction of
 * the line it comes from.
 *
 * Here the region may also be given by one point inside it. Every line is cut where it meets another, the ends that lead
 * nowhere are dropped, and the loop around the point is followed. A line that ends on another line counts as meeting it when
 * its end is within MEET of it.
 *
 * Millimetres, y up. Pure functions, no DOM.
 */
import { crossings, nearestOnPath, pathLength, sampledBetween, partBetween } from './construct-trim.mjs';

export const MEET = .05;   // mm: an end this close to another line is taken to lie on it
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y), copy = p => ({ x: p.x, y: p.y });
const isClosed = e => Boolean(e.closed) || (e.points.length > 2 && distance(e.points[0], e.points.at(-1)) < 1e-9);
/** Lines a region can be made of: no texts, no lines the page makes itself (seam lines, notches, marks, darts), no grain lines. */
export const canBound = e => Boolean(e) && e.type !== 'text' && Array.isArray(e.points) && e.points.length >= 2 && !e.derivedFrom && !e.notchFrom && !e.mark && !e.dart && e.layer !== 'grain';
const boxOf = e => { let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; for (const p of e.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); } return { minX: minX - MEET, minY: minY - MEET, maxX: maxX + MEET, maxY: maxY + MEET }; };
const apart = (a, b) => a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY;
const areaOf = points => { let sum = 0; for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; sum += a.x * b.y - b.x * a.y; } return sum / 2; };
const inside = (p, loop) => { let hit = false; for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) { const a = loop[i], b = loop[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit; } return hit; };

/** The lines cut where they meet, without the ends that lead nowhere: nodes, and the pieces of line between them. */
function arrangement(lines) {
  const total = new Map(lines.map(e => [e.id, pathLength(e)])), boxes = lines.map(boxOf), hits = [];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    if (apart(boxes[i], boxes[j])) continue;
    const a = lines[i], b = lines[j]; let found = [];
    try { found = crossings(a, b); } catch { found = []; }
    for (const hit of found) hits.push({ point: hit.point, on: [[a, hit.at], [b, nearestOnPath(b, hit.point).at]] });
    for (const [e, other] of [[a, b], [b, a]]) {   // an end of one that lies on the other without crossing it
      if (isClosed(e)) continue;
      for (const [end, station] of [[e.points[0], 0], [e.points.at(-1), total.get(e.id)]]) {
        if (found.some(hit => distance(hit.point, end) <= MEET)) continue;
        const near = nearestOnPath(other, end); if (near.away <= MEET) hits.push({ point: near.point, on: [[e, station], [other, near.at]] });
      }
    }
  }
  for (const e of lines) if (isClosed(e) && !hits.some(hit => hit.on.some(([x]) => x === e))) hits.push({ point: e.points[0], on: [[e, 0]] });   // a closed line that meets nothing is a loop by itself
  const nodes = [], nodeOf = point => { let id = nodes.findIndex(n => distance(n, point) <= MEET); if (id < 0) { nodes.push(copy(point)); id = nodes.length - 1; } return id; };
  const stations = new Map(lines.map(e => [e.id, []]));
  for (const hit of hits) { const node = nodeOf(hit.point); for (const [e, at] of hit.on) stations.get(e.id).push({ at, node }); }
  const edges = [];
  for (const e of lines) {
    const length = total.get(e.id), list = stations.get(e.id).sort((p, q) => p.at - q.at), unique = [];
    for (const s of list) if (!unique.length || s.node !== unique.at(-1).node || s.at - unique.at(-1).at > MEET) unique.push(s);
    if (isClosed(e) && unique.length > 1 && unique[0].node === unique.at(-1).node && unique[0].at + length - unique.at(-1).at <= MEET) unique.pop();
    for (let k = 1; k < unique.length; k++) edges.push({ entity: e, from: unique[k - 1].at, to: unique[k].at, a: unique[k - 1].node, b: unique[k].node, length });
    if (isClosed(e) && unique.length) edges.push({ entity: e, from: unique.at(-1).at, to: unique[0].at + length, a: unique.at(-1).node, b: unique[0].node, length });   // the part that runs through the start of the closed line
  }
  const alive = edges.map(edge => edge.to - edge.from > 1e-6); let changed = true;
  while (changed) {   // ends that lead nowhere
    changed = false; const degree = new Map();
    edges.forEach((edge, i) => { if (alive[i]) for (const n of [edge.a, edge.b]) degree.set(n, (degree.get(n) || 0) + 1); });
    edges.forEach((edge, i) => { if (alive[i] && (degree.get(edge.a) < 2 || degree.get(edge.b) < 2)) { alive[i] = false; changed = true; } });
  }
  return { nodes, edges: edges.filter((_, i) => alive[i]) };
}
/** The points of a piece of line between two nodes, from its first node to its second. */
function pointsOfEdge(edge) {
  if (edge.to <= edge.length + 1e-9) return sampledBetween(edge.entity, edge.from, Math.min(edge.to, edge.length));
  return [...sampledBetween(edge.entity, edge.from, edge.length), ...sampledBetween(edge.entity, 0, edge.to - edge.length).slice(1)];
}
/** The direction in which a row of points leaves its first point, taken over the first millimetre. */
function leaving(points) {
  let walked = 0; const reach = Math.min(1, points.slice(1).reduce((s, p, i) => s + distance(p, points[i]), 0) / 2);
  for (let i = 1; i < points.length; i++) { const step = distance(points[i - 1], points[i]); if (walked + step >= reach - 1e-12 && step > 0) { const t = (reach - walked) / step, q = { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t }; return Math.atan2(q.y - points[0].y, q.x - points[0].x); } walked += step; }
  return Math.atan2(points.at(-1).y - points[0].y, points.at(-1).x - points[0].x);
}
/** Every closed region the lines enclose: its outline as points (counter-clockwise) and the pieces of line it runs along. */
export function regionsOf(lines) {
  const { edges } = arrangement(lines); if (!edges.length) return [];
  const half = [];   // two for every piece of line: 2i runs along it, 2i + 1 against it
  edges.forEach((edge, i) => { const points = pointsOfEdge(edge), back = [...points].reverse(); half.push({ edge, forward: true, from: edge.a, to: edge.b, points, angle: leaving(points) }, { edge, forward: false, from: edge.b, to: edge.a, points: back, angle: leaving(back) }); });
  const out = new Map(); half.forEach((h, id) => { if (!out.has(h.from)) out.set(h.from, []); out.get(h.from).push(id); });
  for (const list of out.values()) list.sort((p, q) => half[p].angle - half[q].angle);
  // With the region on the left, the next piece at a node is the first one clockwise from the way back.
  const next = id => { const list = out.get(half[id].to), at = list.indexOf(id ^ 1); return list[(at - 1 + list.length) % list.length]; };
  const seen = new Set(), regions = [];
  for (let start = 0; start < half.length; start++) {
    if (seen.has(start)) continue;
    const loop = []; let id = start, guard = 0;
    do { seen.add(id); loop.push(id); id = next(id); } while (id !== start && ++guard <= half.length);
    if (id !== start) continue;
    const outline = loop.flatMap(h => half[h].points.slice(0, -1)), area = areaOf(outline);
    if (!(area > 1e-6)) continue;   // the outside of the drawing runs the other way round
    regions.push({ outline, areaMm2: area, runs: loop.map(h => ({ entity: half[h].edge.entity, from: half[h].edge.from, to: half[h].edge.to, length: half[h].edge.length, forward: half[h].forward, start: copy(half[h].points[0]), end: copy(half[h].points.at(-1)) })) });
  }
  return regions;
}
/** Pieces of the same line that follow one another along the outline become one. */
function joined(runs) {
  const list = runs.map(run => ({ ...run }));
  const follows = (p, q) => p.entity === q.entity && p.forward === q.forward && (p.forward ? Math.abs(p.to - q.from) < 1e-6 || Math.abs(p.to - p.length - q.from) < 1e-6 : Math.abs(p.from - q.to) < 1e-6 || Math.abs(p.from + p.length - q.to) < 1e-6);
  const merge = (p, q) => p.forward ? { ...p, to: Math.abs(p.to - q.from) < 1e-6 ? q.to : q.to + p.length, end: q.end } : { ...p, from: Math.abs(p.from - q.to) < 1e-6 ? q.from : q.from - p.length, end: q.end };
  for (let i = 0; i < list.length && list.length > 1;) { const j = (i + 1) % list.length; if (follows(list[i], list[j]) && (list.length > 2 || true)) { const merged = merge(list[i], list[j]); if (merged.to - merged.from > merged.length + 1e-6) { i++; continue; } list[i] = merged; list.splice(j, 1); if (j < i) i--; } else i++; }
  return list.map(run => { let { from, to } = run; while (from < -1e-9) { from += run.length; to += run.length; } return { ...run, from, to }; });
}
/**
 * The region to take out. `lines` are the lines it may be made of; `at` is a point inside it. Without a point the lines must
 * enclose exactly one region. Returns the parts of the lines around it, in order, each as a straight row of points or as a
 * curve, with the line it comes from.
 */
export function findRegion(lines, at = null) {
  const usable = lines.filter(canBound); if (!usable.length) throw new Error('没有可以围成裁片的线。');
  const regions = regionsOf(usable); if (!regions.length) throw new Error('这些线没有围成封闭的区域：线与线之间要相交，或者一条线的端点落在另一条线上（相差不超过 ' + MEET + ' 毫米）。');
  let chosen;
  if (at) { const around = regions.filter(region => inside(at, region.outline)); if (!around.length) throw new Error('这一点不在任何一块封闭的区域里面。'); chosen = around.reduce((best, region) => region.areaMm2 < best.areaMm2 ? region : best); }
  else if (regions.length === 1) chosen = regions[0];
  else throw new Error('这些线围成了 ' + regions.length + ' 块，请指出要哪一块：给出那一块里面的任意一点。');
  const parts = joined(chosen.runs).map(run => {
    const e = run.entity, whole = run.to - run.from >= run.length - 1e-6;
    // a whole line: a closed one is the region's outline by itself; an open one that is an edge from end to end is taken as it is (v60: it was marked closed before)
    if (whole) return { source: e, ...(isClosed(e) ? { closed: true } : { startsAt: run.forward ? run.start : run.end, endsAt: run.forward ? run.end : run.start }), ...(e.curve ? { curve: JSON.parse(JSON.stringify(e.curve)) } : { points: e.points.map(copy) }) };
    if (run.to <= run.length + 1e-9) { const part = partBetween(e, run.from, Math.min(run.to, run.length)); return { source: e, ...(part.curve ? { curve: part.curve, shapeChangeMm: part.shapeChangeMm } : { points: part.points }), startsAt: run.forward ? run.start : run.end, endsAt: run.forward ? run.end : run.start }; }
    if (e.curve) throw new Error('“' + e.name + '”是闭合的曲线，要取的一段跨过了它的起点；请先把它在别处打断。');
    return { source: e, points: [...sampledBetween(e, run.from, run.length), ...sampledBetween(e, 0, run.to - run.length).slice(1)], startsAt: run.forward ? run.start : run.end, endsAt: run.forward ? run.end : run.start };
  });
  const perimeter = chosen.outline.reduce((sum, p, i) => sum + distance(p, chosen.outline[(i + 1) % chosen.outline.length]), 0);
  const xs = chosen.outline.map(p => p.x), ys = chosen.outline.map(p => p.y);
  return { parts, outline: chosen.outline, areaMm2: chosen.areaMm2, perimeterMm: perimeter, box: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }, regionsFound: regions.length };
}
/** The grain line ET gives a piece it takes out: upright, six tenths of the height, 5 mm right of the middle, pointing up. */
export function grainLikeEt(box) {
  const x = (box.minX + box.maxX) / 2 + 5, y = (box.minY + box.maxY) / 2, half = Math.max(5, (box.maxY - box.minY) * .3);
  return [{ x, y: y - half }, { x, y: y + half }];
}
