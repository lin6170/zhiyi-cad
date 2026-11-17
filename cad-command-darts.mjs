/**
 * Darts (v53, v64).
 *
 * v53 drew a dart on an edge as two legs (and, folded to one side, two cap lines) without touching the edge, and a
 * double-pointed dart as two arcs. v64 makes them the way ET 2017's own tools do, each rule checked against files ET saved
 * after running its tool on the same drawing (dart-tools.mjs says which rule comes from which tool):
 * - on a loose line (a structure line, or an inner line of a piece) the dart cuts the line at its mouth, as ET's 省道 tool does;
 *   on the outline of a piece the outline stays and the dart lines are inner lines of the piece, as before;
 * - folded to one side, the legs are made equal, the caps follow the edge (curved on a curved edge), and the crease and ET's
 *   fold mark are drawn too;
 * - 斜省 (along a centre line), 省折线 (folding a dart drawn as four lines), 单向省, 两点做省, 插入省 and 掰开省 are new;
 * - 枣弧省 can be four straight lines or ET's two curves, with an opening at one end.
 * Removing a dart that cut its edge gives the edge back.
 */
import { LIMIT, number, point, text, object, idList, requireMm, entityOf, addEntity, round } from './cad-command-kit.mjs';
import { contoursForGroup } from './topology.mjs';
import { station } from './construct.mjs';
import { fitClampedSpline, nativeFitPoints } from './fit-spline.mjs';
import { refreshCurve } from './curves.mjs';
import { pieceOutline } from './piece-info.mjs';
import * as trim from './construct-trim.mjs';
import * as D from './dart-tools.mjs';

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), add = (a, v, k = 1) => ({ x: a.x + v.x * k, y: a.y + v.y * k }), dot = (a, b) => a.x * b.x + a.y * b.y, cross = (a, b) => a.x * b.y - a.y * b.x, norm = v => Math.hypot(v.x, v.y);
const unit = v => { const n = norm(v); return { x: v.x / n, y: v.y / n }; }, at = q => ({ x: round(q.x), y: round(q.y) });
const inside = (p, loop) => { let hit = false; for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) { const a = loop[i], b = loop[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit; } return hit; };
const ownerOf = (project, id) => (project.groups || []).find(group => group.entityIds.includes(id)) || null;
const far = (a, b) => Math.hypot(a.x - b.x, a.y - b.y), endsOf = e => [e.points[0], e.points.at(-1)];

/**
 * The geometry of a dart on an edge (v53; kept for its callers). edge: a line or curve entity (or one side of a closed outline
 * as a two-point line). where: { from, distance } or { ratio }. inward: a unit vector test, called with the place and the edge
 * normal, that says whether that normal points to the side the dart goes to. cap: 'none', or the end of the edge the folded dart lies towards.
 */
export function dartOnEdge(edge, where, width, length, inward, cap = 'none') {
  const middle = station(edge, where), half = width / 2;
  if (middle.position - half < -1e-9 || middle.position + half > middle.total + 1e-9) throw new Error('省口超出了这条边：省的位置离边的一端只有 ' + round(Math.min(middle.position, middle.total - middle.position)) + ' mm，省量的一半是 ' + round(half) + ' mm。');
  const first = station(edge, { from: 'start', distance: Math.max(0, middle.position - half) }), second = station(edge, { from: 'start', distance: Math.min(middle.total, middle.position + half) });
  let normal = { x: -middle.tangent.y, y: middle.tangent.x }; if (!inward(middle.point, normal)) normal = { x: -normal.x, y: -normal.y };
  const tip = add(middle.point, normal, length), result = { mouth: [first.point, second.point], middle: middle.point, tip, normal, halfAngleDegrees: Math.atan2(norm(sub(second.point, first.point)) / 2, length) * 180 / Math.PI, cap: null };
  if (cap !== 'none') {
    // Folded towards one end, the dart lies over the piece beyond that leg. The cap line that leaves the mouth point on that side
    // is the edge beyond it, mirrored in the leg; it runs to the centre line of the dart, and the other mouth point is joined to the same peak.
    const toEnd = cap === 'end', corner = toEnd ? second : first, onward = toEnd ? corner.tangent : { x: -corner.tangent.x, y: -corner.tangent.y };
    const leg = unit(sub(corner.point, tip)), mirrored = sub({ x: 2 * dot(onward, leg) * leg.x, y: 2 * dot(onward, leg) * leg.y }, onward);
    const axis = unit(sub(middle.point, tip)), denominator = cross(mirrored, axis);
    if (Math.abs(denominator) < 1e-9) throw new Error('这个省太宽或太短，画不出省山。');
    const along = cross(sub(tip, corner.point), axis) / denominator;
    if (!(along > 0)) throw new Error('这个省太宽或太短，画不出省山。');
    const peak = add(corner.point, mirrored, along);
    result.cap = { peak, heightMm: norm(sub(peak, middle.point)), towards: cap };
  }
  return result;
}

const lengthOf = (description, most = LIMIT) => ({ type: 'number', exclusiveMinimum: 0, maximum: most, description });
const capField = { type: 'string', enum: ['none', 'start', 'end'], description: '省山（省折）：不画（不填就是不画），或省缝合后倒向边的起点一侧、终点一侧；倒向的一侧要有边' };
const endField = { type: 'string', enum: ['start', 'end'], description: '起点或终点' };
function addLine(project, env, name, points, dart) { return addEntity(project, env, { name, type: 'polyline', layer: 'internal', points: points.map(q => ({ x: q.x, y: q.y })), dart }); }
function addShape(project, env, base, shape) { return shape.curve ? refreshCurve(addEntity(project, env, { type: 'polyline', layer: 'internal', ...base, points: [], curve: shape.curve })) : addEntity(project, env, { type: 'polyline', layer: 'internal', ...base, points: shape.points.map(q => ({ x: q.x, y: q.y })) }); }
function setShape(entity, shape) {
  if (shape.curve) { entity.curve = shape.curve; refreshCurve(entity); } else { delete entity.curve; delete entity.curveSamplingCapped; entity.points = shape.points.map(q => ({ x: q.x, y: q.y })); }
  if (entity.source) entity.source.modified = true;
}
const shapeOf = entity => entity.curve ? { curve: entity.curve } : { points: entity.points.map(q => ({ x: q.x, y: q.y })) };
/** A line or curve with one end moved to a point; a curve keeps its other curve points. */
function withEnd(entity, end, to) {
  if (entity.curve) { const fit = nativeFitPoints(entity.curve).slice(); fit[end === 'start' ? 0 : fit.length - 1] = to; return { curve: fitClampedSpline(fit).curve }; }
  const points = entity.points.map(q => ({ x: q.x, y: q.y })); points[end === 'start' ? 0 : points.length - 1] = { x: to.x, y: to.y }; return { points };
}
const endAt = (entity, point, tolerance = .05) => far(entity.points[0], point) <= tolerance ? 'start' : far(entity.points.at(-1), point) <= tolerance ? 'end' : null;
const gradedIds = project => JSON.stringify(project.gradingPlans || []);

/** A line whose shape a dart command may change: a loose line or an inner line of a piece (never an outline), without notches,
 *  grading rules, mirror ties or marks. Lines of darts made earlier may be changed when `darts` is set. */
function changeable(project, id, what, { darts = false } = {}) {
  const entity = entityOf(project, id);
  if (entity.type === 'text') throw new Error(what + '不能是文字。');
  if (entity.derivedFrom || entity.notchFrom) throw new Error('“' + entity.name + '”是缝份或刀口的派生线，不能用来做省。');
  if (entity.mirrorOf) throw new Error('“' + entity.name + '”是对称修改里跟着原线变的镜像，请改它的原线。');
  if (entity.mark || (entity.dart && !darts)) throw new Error('“' + entity.name + '”是' + (entity.mark ? '扣位、打孔一类标记' : '另一个省') + '的一部分。');
  if (entity.closed) throw new Error('“' + entity.name + '”是闭合的图形，' + what + '要用单独的一条线。');
  const owner = ownerOf(project, id);
  if (owner && contoursForGroup(owner).some(contour => contour.entityIds.includes(id))) throw new Error('“' + entity.name + '”是裁片“' + owner.name + '”的轮廓线；' + what + '只用于结构线和裁片里面的线。');
  if ((project.notches || []).some(notch => notch.baseEntityId === id)) throw new Error('“' + entity.name + '”上有刀口，请先删除刀口。');
  if (gradedIds(project).includes('"entityId":' + JSON.stringify(id))) throw new Error('“' + entity.name + '”上有放码规则，请先删除规则。');
  return { entity, owner };
}
/** The edge a dart goes on. A loose line (or an inner line of a piece) is cut at the mouth, as ET does; on the outline of a piece,
 *  or on one side of a closed outline, the edge stays and the dart lines become inner lines of the piece (v53). */
function dartEdge(project, p, { segments = true } = {}) {
  const entity = entityOf(project, p.entityId);
  if (entity.type === 'text' || entity.derivedFrom || entity.notchFrom) throw new Error('省要做在一条线或曲线上，不能做在文字、缝边线或刀口上。');
  if (entity.mark || entity.dart) throw new Error('“' + entity.name + '”是' + (entity.mark ? '扣位、打孔一类标记' : '一个省') + '的一部分，不能在上面做省。');
  const owner = ownerOf(project, entity.id);
  if (entity.closed && !entity.curve) {
    if (!segments) throw new Error('“' + entity.name + '”是闭合折线，这个工具要用单独的一条边。');
    if (!Number.isInteger(p.segmentIndex) || p.segmentIndex >= entity.points.length) throw new Error('这是一条闭合折线，请用 segmentIndex 说明是哪一条边。');
    return { entity, owner, cut: false, edge: { type: 'polyline', points: [entity.points[p.segmentIndex], entity.points[(p.segmentIndex + 1) % entity.points.length]] } };
  }
  if (p.segmentIndex !== undefined) throw new Error('只有闭合折线才用 segmentIndex。');
  const outline = entity.closed || (owner && contoursForGroup(owner).some(contour => contour.entityIds.includes(entity.id)));
  if (!outline) changeable(project, entity.id, '做省的边');
  return { entity, owner, cut: !outline, edge: entity };
}
/** The side the tip goes to: towards a given point, or into the piece the edge belongs to. */
function tipSide(project, owner, p, length) {
  const loop = owner ? pieceOutline(project, owner) : null;
  if (!loop && !p.toward) throw new Error('这条边不属于裁片，请用 toward 给出省尖所在一侧的一个点。');
  return (place, normal) => p.toward ? dot(sub(p.toward, place), normal) > 0 : inside(add(place, normal, Math.min(1, length / 2)), loop);
}
/** Cut the mouth out of a loose edge: the edge keeps the part before the mouth (or the part after when there is none before),
 *  a new line takes the part after. What the edge was is kept with the dart, so that removing the dart gives it back. */
function cutEdge(project, env, entity, owner, cut) {
  const original = shapeOf(entity), parts = [cut.before, cut.after].filter(Boolean);
  if (!parts.length) throw new Error('省口占满了整条边。');
  setShape(entity, parts[0]); let rest = null;
  if (parts.length === 2) { rest = addShape(project, env, { name: entity.name + '·2', layer: entity.layer, ...(entity.aux ? { aux: true } : {}) }, parts[1]); if (owner) owner.entityIds.push(rest.id); }
  return { before: cut.before ? entity : null, after: cut.after ? (cut.before ? rest : entity) : null, record: { entityId: entity.id, ...(rest ? { restId: rest.id } : {}), shape: original } };
}
/**
 * Fold a dart to one side (ET's 省折 and 省折线): equal legs, the caps, the crease and the fold mark. foldPart: the line beyond the
 * folded mouth; otherLeg / otherPart: the lines at the other mouth whose ends move when that leg gets the folded leg's length
 * (null when they are not to change). Returns the fold and the lines it drew.
 */
function drawFold(project, env, { tip, foldMouth, otherMouth, foldPart, otherLeg, otherPart, depth = 0, legs = null, label, note }) {
  const beyond = D.beyondMouth(foldPart, foldMouth), f = D.foldDart({ tip, foldMouth, otherMouth, beyond, depth });
  if (otherLeg) { const end = endAt(otherLeg, otherMouth) || 'start'; setShape(otherLeg, withEnd(otherLeg, end, f.otherMouth)); }
  if (otherPart) { const end = endAt(otherPart, otherMouth); if (end) setShape(otherPart, withEnd(otherPart, end, f.otherMouth)); }
  if (depth > 0 && legs) for (const [leg, inner] of [[legs.fold, f.legs.fold[1]], [legs.other, f.legs.other[1]]]) { const end = endAt(leg, tip, .05); if (end) setShape(leg, withEnd(leg, end, inner)); }
  // ET draws the caps the way the edge beyond the folded mouth runs: away from the mouths, or towards them
  const outward = far(foldPart.points[0], foldMouth) <= far(foldPart.points.at(-1), foldMouth), orient = shape => outward ? shape : reversed(shape);
  const made = [addLine(project, env, label + ' · 省中线', f.centre, note('centre')), addShape(project, env, { name: label + ' · 省山（倒向一侧）', dart: note('cap1') }, orient(f.foldCap)),
    addShape(project, env, { name: label + ' · 省山（另一侧）', dart: note('cap2') }, orient(f.otherCap)), addShape(project, env, { name: label + ' · 倒向记号', dart: note('mark') }, { curve: fitClampedSpline(f.mark).curve })];
  return { f, made };
}
function reversed(shape) { return shape.curve ? { curve: fitClampedSpline(nativeFitPoints(shape.curve).slice().reverse()).curve } : { points: shape.points.slice().reverse() }; }
/** The place on an edge a dart command is given: a share of the length, a distance from one end, or the place nearest to a point. */
function placeOnEdge(edge, p) {
  const total = trim.pathLength(edge);
  if (p.near) { if (p.at) throw new Error('位置请用 at 或 near 说明其中一种。'); return trim.nearestOnPath(edge, p.near).at; }
  if (!p.at) throw new Error('位置须写成“从哪一端量多远”，或一个百分比，或用 near 给出边上的一点。');
  if (typeof p.at.ratio === 'number') return total * p.at.ratio / 100;
  if (typeof p.at.distance !== 'number' || !p.at.from) throw new Error('位置须写成“从哪一端量多远”，或一个百分比。');
  if (p.at.distance > total + 1e-7) throw new Error('位置超出线的长度（线长 ' + total.toFixed(2) + ' mm）。');
  return p.at.from === 'start' ? p.at.distance : total - p.at.distance;
}
/** What happens on the edge and around the legs of a dart on an edge (法向省, 斜省, 两点做省): cut a loose edge, draw the legs,
 *  fold when asked. Returns the lines made, the mouth points and the fold. */
function finishEdgeDart(project, env, { entity, owner, cut: cutting, edge }, d, { cap = 'none', label, note, mouthFrom, mouthTo }) {
  let mouth = d.mouthPoints, parts = null;
  if (cutting) { parts = cutEdge(project, env, entity, owner, d.cut); mouth = d.cut.mouth; }
  const legs = [addLine(project, env, label + ' · 省边 1', [mouth[0], d.tip], note('leg1')), addLine(project, env, label + ' · 省边 2', [mouth[1], d.tip], note('leg2'))], made = [...legs];
  if (parts) legs[0].dart.edge = parts.record;
  let fold = null;
  if (cap !== 'none') {
    const toEnd = cap === 'end', foldMouth = mouth[toEnd ? 1 : 0], otherMouth = mouth[toEnd ? 0 : 1];
    let foldPart = parts ? (toEnd ? parts.after : parts.before) : null;
    if (!parts) { const total = trim.pathLength(edge), part = toEnd ? (total - mouthTo > 1e-3 ? trim.partBetween(edge, mouthTo, total) : null) : (mouthFrom > 1e-3 ? trim.partBetween(edge, 0, mouthFrom) : null); foldPart = part && (part.curve ? refreshCurve({ type: 'polyline', points: [], curve: part.curve }) : { type: 'polyline', points: part.points }); }
    if (!foldPart) throw new Error('省口' + (toEnd ? '终点' : '起点') + '一侧没有边了，画不出省山。');
    fold = drawFold(project, env, { tip: d.tip, foldMouth, otherMouth, foldPart, otherLeg: legs[toEnd ? 0 : 1], otherPart: parts ? (toEnd ? parts.before : parts.after) : null, label, note });
    made.push(...fold.made);
  }
  if (owner) owner.entityIds.push(...made.map(e => e.id));
  return { made, mouth: [legs[0].points[0], legs[1].points[0]], fold, parts };
}
const foldSummary = fold => fold ? { capHeightMm: round(fold.f.peakHeightMm), peak: at(fold.f.peak), legLengthMm: round(fold.f.legLengthMm), otherMouthMovedMm: round(fold.f.otherMoved) } : {};

export const dartCommands = [
  { type: 'dart.make', title: '做省', description: '在一条边上做省（ET 的省道工具，法向省）：at 说明省口的中点在这条边的什么位置（from 是从哪一端量，distance 是沿线的距离；或者用 ratio 给出占全长的百分比），也可以用 near 给出边上的一点（取边上离它最近的地方）；width 是省量（省口的宽度，沿边量），length 是省长（省口中点到省尖）。省垂直于这条边：边属于裁片时自动朝裁片里面，toward 可以不给（给了就按它定方向）；边不属于裁片时必须用 toward 给出省尖所在一侧的一个点。给了 segmentIndex 时，at 里的 from、distance、ratio 都按这一条边算。结构线（还没有做成裁片的线）和裁片里面的线在省口处剪开，中间一段去掉，与 ET 相同：原来的线留下省口前面（起点那一侧）的一段，后面那一段是新的线，名字是“原线名·2”（省口在线的一端时只剩一段）；裁片的轮廓线不剪，两条省边画成裁片的内部线，缝份不会跟着省走。cap 为 start 或 end 时再画省山（省折）：省缝合后倒向这条边的起点或终点一侧；与 ET 的“省折”相同，两条省边改成一样长，省山顺着边的形状（曲线边上是曲线），并画出省中线和倒向记号。',
    input_schema: object({ entityId: text(120, '做省的边'), segmentIndex: { type: 'integer', minimum: 0, maximum: 10000, description: '闭合折线的第几条边，从 0 起；普通线条不填' },
      at: object({ from: { type: 'string', enum: ['start', 'end'], description: '从起点还是终点量' }, distance: number(0, LIMIT, '沿线的距离，毫米'), ratio: number(0, 100, '占全长的百分比') }, []),
      near: point('边上（或靠近边）的一点，省口的中点取边上离它最近的地方；与 at 二选一'),
      width: lengthOf('省量，毫米', 500), length: lengthOf('省长，毫米', 2000), toward: point('省尖所在一侧的一个点'), cap: capField, name: text(40, '名称') }, ['entityId', 'width', 'length']),
    run(project, p, env) {
      requireMm(project);
      const site = dartEdge(project, p), place = placeOnEdge(site.edge, p), setId = env.makeId(), label = p.name || '省';
      const d = D.normalDart(site.edge, { at: place }, p.width, p.length, tipSide(project, site.owner, p, p.length)), note = part => ({ id: setId, part, widthMm: p.width, lengthMm: p.length });
      const done = finishEdgeDart(project, env, site, d, { cap: p.cap || 'none', label, note, mouthFrom: d.from, mouthTo: d.to });
      return { summary: { operation: 'dart.make', setId, widthMm: p.width, lengthMm: p.length, tip: at(d.tip), mouth: done.mouth.map(at), angleDegrees: round(Math.atan2(far(d.mouthPoints[0], d.mouthPoints[1]) / 2, p.length) * 360 / Math.PI),
        edgeCut: site.cut, ...(p.cap && p.cap !== 'none' ? { foldedTowards: p.cap, ...foldSummary(done.fold) } : {}), piece: site.owner ? site.owner.name : null, lines: done.made.length }, created: done.made[0].id };
    } },
  { type: 'dart.slant', title: '斜省', description: '沿一条省中线做省（ET 省道工具的斜省）：entityId 是做省的边，centreEntityId 是省中线（一头在边上或靠近边，另一头是省尖）。省口以省中线与边的交点为中点（省中线碰不到边时取它的延长线），沿边两边各量省量的一半；省尖就是省中线的另一头。省中线用完后删掉，与 ET 相同。结构线和裁片里面的线在省口处剪开，中间一段去掉，剪开后的两段与“做省”相同；裁片的轮廓线不剪。cap 与“做省”相同，可以画省山，不填就是不画。',
    input_schema: object({ entityId: text(120, '做省的边'), centreEntityId: text(120, '省中线'), width: lengthOf('省量，毫米', 500), cap: capField, name: text(40, '名称') }, ['entityId', 'centreEntityId', 'width']),
    run(project, p, env) {
      requireMm(project);
      if (p.centreEntityId === p.entityId) throw new Error('省中线不能就是做省的边。');
      const site = dartEdge(project, p, { segments: false }), centre = entityOf(project, p.centreEntityId);
      if (centre.type === 'text' || centre.curve || centre.closed || centre.points.length !== 2) throw new Error('省中线要是一条直线。');
      if (centre.dart || centre.mark || centre.derivedFrom || centre.notchFrom) throw new Error('“' + centre.name + '”不能用作省中线。');
      const centreOwner = ownerOf(project, centre.id); if (centreOwner && contoursForGroup(centreOwner).some(c => c.entityIds.includes(centre.id))) throw new Error('“' + centre.name + '”是裁片的轮廓线，不能用作省中线。');
      const d = D.slantDart(site.edge, centre, p.width), setId = env.makeId(), label = p.name || '省', note = part => ({ id: setId, part, widthMm: p.width, lengthMm: round(d.length) });
      project.entities = project.entities.filter(e => e.id !== centre.id); if (centreOwner) centreOwner.entityIds = centreOwner.entityIds.filter(id => id !== centre.id);
      const done = finishEdgeDart(project, env, site, d, { cap: p.cap || 'none', label, note, mouthFrom: d.from, mouthTo: d.to });
      return { summary: { operation: 'dart.slant', setId, widthMm: p.width, lengthMm: round(d.length), foot: at(d.foot), tip: at(d.tip), mouth: done.mouth.map(at), removedCentre: centre.name, edgeCut: site.cut,
        ...(p.cap && p.cap !== 'none' ? { foldedTowards: p.cap, ...foldSummary(done.fold) } : {}), piece: site.owner ? site.owner.name : null, lines: done.made.length }, created: done.made[0].id };
    } },
  { type: 'dart.fold', title: '省折线', description: '把画好的省折倒到一侧，画出省山（ET 的省折线）：legIds 是两条省边（两条直线，在省尖相交）。倒向一侧的省口上必须接着边线，另一侧的省口可以没有。toward 是倒向一侧的一个点：它在省中线（两条省边的角平分线）的哪一侧，省就倒向哪一侧。与 ET 相同：倒向一侧的省边不动，另一条省边改成一样长：它的省口沿这条省边移动，接在那里的边线的端点跟着移到新省口；省山顺着边的形状；画出省中线和倒向记号。depth（省深度）不填时省边画到省尖；填了时两条省边从省口量到这个长度为止，省中线从省山往下画这么长。',
    input_schema: object({ legIds: { type: 'array', description: '两条省边（正好两条）', items: { type: 'string', minLength: 1, maxLength: 120 }, minItems: 2, maxItems: 2 }, toward: point('倒向一侧的一个点：在省中线（两条省边的角平分线）的哪一侧，省就倒向哪一侧'), depth: lengthOf('省深度，毫米；不填时画到省尖', 2000), name: text(40, '名称') }, ['legIds', 'toward']),
    run(project, p, env) {
      requireMm(project);
      if (p.legIds.length !== 2 || p.legIds[0] === p.legIds[1]) throw new Error('请给出两条不同的省边。');
      const legs = p.legIds.map(id => changeable(project, id, '省边', { darts: true }));
      for (const { entity } of legs) if (entity.curve || entity.points.length !== 2) throw new Error('省边要是直线：“' + entity.name + '”不是。');
      const [a, b] = legs.map(l => l.entity), pairs = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([i, j]) => ({ i, j, d: far(endsOf(a)[i], endsOf(b)[j]) })).sort((x, y) => x.d - y.d)[0];
      if (pairs.d > .05) throw new Error('两条省边没有相交在省尖上。');
      const tip = endsOf(a)[pairs.i], mouths = [endsOf(a)[1 - pairs.i], endsOf(b)[1 - pairs.j]];
      // the edge lines at each mouth: the other lines with an end there
      const partAt = m => project.entities.filter(e => e.type !== 'text' && !p.legIds.includes(e.id) && !e.derivedFrom && !e.notchFrom && !e.closed && e.points.length >= 2 && endAt(e, m, .05));
      const crease = add(unit(sub(mouths[0], tip)), unit(sub(mouths[1], tip))), sideOfToward = Math.sign(cross(crease, sub(p.toward, tip)));
      if (!sideOfToward) throw new Error('toward 正好在省的中线上，看不出倒向哪一侧。');
      const fi = Math.sign(cross(crease, sub(mouths[0], tip))) === sideOfToward ? 0 : 1, foldMouth = mouths[fi], otherMouth = mouths[1 - fi];
      const foldParts = partAt(foldMouth), otherParts = partAt(otherMouth);
      if (!foldParts.length) throw new Error('倒向一侧的省口上没有接着边线，画不出省山。'); if (foldParts.length > 1) throw new Error('倒向一侧的省口上接着不止一条线（' + foldParts.map(e => e.name).join('、') + '），看不出哪一条是边线。');
      if (otherParts.length > 1) throw new Error('另一侧的省口上接着不止一条线（' + otherParts.map(e => e.name).join('、') + '），看不出哪一条是边线。');
      const otherPart = otherParts[0] || null; if (otherPart) changeable(project, otherPart.id, '省口的边线');
      const setId = env.makeId(), label = p.name || '省', note = part => ({ id: setId, part, lengthMm: round(far(foldMouth, tip)) });
      const owner = legs[0].owner || legs[1].owner, foldLeg = [a, b][fi], otherLeg = [a, b][1 - fi];
      const fold = drawFold(project, env, { tip, foldMouth, otherMouth, foldPart: foldParts[0], otherLeg, otherPart, depth: p.depth || 0, legs: { fold: foldLeg, other: otherLeg }, label, note });
      if (owner) owner.entityIds.push(...fold.made.map(e => e.id));
      return { summary: { operation: 'dart.fold', setId, foldedTo: foldLeg.name, ...foldSummary(fold), ...(p.depth ? { depthMm: p.depth } : {}), edge: foldParts[0].name, ...(otherPart ? { otherEdge: otherPart.name } : {}), piece: owner ? owner.name : null, lines: fold.made.length }, created: fold.made[0].id };
    } },
  { type: 'dart.fish', title: '枣弧省', description: '在裁片里面做一个两头尖的省（枣弧省、腰省）：from 和 to 是两个省尖，width 是最宽处的省量，widest 是最宽处在两个省尖之间的位置（从 from 量起的百分比，默认 50）。省量与两个省尖的连线垂直。shape 是画法：curves（默认）画左右两条曲线，曲线的形状与 ET 的“曲线处理”相同；lines 画四条直线，与 ET 枣弧省对话框默认的画法相同。opening 是 to 那一头的开口宽度（省一直开到边上时用），开口时那一头的两段是直线。两个省尖都在同一个裁片的净样轮廓里面时，线条是这个裁片的内部线，否则是散线。最宽处离 from 多远要换算成占两个省尖之间距离的百分比给 widest。',
    input_schema: object({ from: point('一个省尖'), to: point('另一个省尖（开口在这一头）'), width: lengthOf('最宽处的省量，毫米', 500), widest: { type: 'number', exclusiveMinimum: 0, maximum: 100, description: '最宽处的位置，从 from 量起占两个省尖之间长度的百分比，默认 50' },
      shape: { type: 'string', enum: ['curves', 'lines'], description: 'curves 两条曲线（默认），lines 四条直线' }, opening: { type: 'number', minimum: 0, maximum: 500, description: 'to 那一头的开口宽度，毫米，默认 0' }, name: text(40, '名称') }, ['from', 'to', 'width']),
    run(project, p, env) {
      requireMm(project);
      const span = norm(sub(p.to, p.from)); if (!(span > 1)) throw new Error('两个省尖太近。');
      const share = (p.widest ?? 50) / 100; if (!(share > 0 && share < 1)) throw new Error('最宽处要在两个省尖之间。');
      if (p.width >= span) throw new Error('省量不能大于省的长度。'); if ((p.opening || 0) >= p.width) throw new Error('开口要小于省量。');
      const u = unit(sub(p.to, p.from)), centre = add(p.from, u, span * share), curved = (p.shape || 'curves') === 'curves', opening = p.opening || 0;
      let result; try { result = D.fishDart({ base: centre, top: p.from, width: p.width, below: span * (1 - share), opening, curved }); } catch (error) { throw new Error('省的线画不出来：' + error.message); }
      const setId = env.makeId(), label = p.name || '枣弧省', parts = curved ? (opening ? ['upperLeft', 'upperRight', 'lowerLeft', 'lowerRight'] : ['left', 'right']) : ['upperRight', 'lowerRight', 'lowerLeft', 'upperLeft'];
      const titles = { left: '左', right: '右', upperLeft: '左上', upperRight: '右上', lowerLeft: '左下', lowerRight: '右下' };
      const made = result.shapes.map((shape, i) => addShape(project, env, { name: label + ' · ' + titles[parts[i]], dart: { id: setId, part: parts[i], widthMm: p.width, lengthMm: round(span) } }, shape));
      const owners = (project.groups || []).filter(group => { const loop = pieceOutline(project, group); return loop && inside(p.from, loop) && inside(p.to, loop); }), owner = owners.length === 1 ? owners[0] : null;
      if (owner) owner.entityIds.push(...made.map(e => e.id));
      return { summary: { operation: 'dart.fish', setId, widthMm: p.width, lengthMm: round(span), widestAt: at(centre), shape: curved ? 'curves' : 'lines', ...(opening ? { openingMm: opening } : {}), piece: owner ? owner.name : null, lines: made.length }, created: made[0].id };
    } },
  { type: 'dart.single', title: '单向省', description: '单向省（ET 的单向省）：entityId 是已经画好的一条省边，end 是省尖在它的哪一端（或用 near 给出靠近省尖那一端的一点）。把这条省边复制一条，绕省尖转开，转到两条省边另一头之间的距离等于省量 width；toward 是转向哪一侧的一个点。新省边与原来的一样长，所以它的口一般不会正好落在边线上；原来的线不改，边线也不剪开、不改，与 ET 相同。新线的名字是 name（默认“单向省”）加“ · 省边”。',
    input_schema: object({ entityId: text(120, '已有的一条省边'), end: endField, near: point('靠近省尖那一端的一点'), width: lengthOf('省量，毫米', 500), toward: point('新省边转向哪一侧的一个点'), name: text(40, '名称') }, ['entityId', 'width', 'toward']),
    run(project, p, env) {
      requireMm(project);
      const leg = entityOf(project, p.entityId); if (leg.type === 'text' || leg.closed || leg.derivedFrom || leg.notchFrom || leg.mark) throw new Error('单向省要从一条线开始。');
      if (p.end && p.near) throw new Error('省尖请用 end 或 near 说明其中一种。'); if (!p.end && !p.near) throw new Error('需要说明省尖在这条线的哪一端：用 end，或用 near。');
      const tipEnd = p.end || (trim.nearestOnPath(leg, p.near).at <= trim.pathLength(leg) / 2 ? 'start' : 'end'), d = D.singleDart(leg, tipEnd, p.width, p.toward);
      const setId = env.makeId(), owner = ownerOf(project, leg.id), made = addShape(project, env, { name: (p.name || '单向省') + ' · 省边', dart: { id: setId, part: 'leg2', widthMm: p.width, lengthMm: round(far(d.mouth[0], d.tip)) } }, d.shape);
      if (owner) owner.entityIds.push(made.id);
      return { summary: { operation: 'dart.single', setId, from: leg.name, tip: at(d.tip), mouth: d.mouth.map(at), widthMm: p.width, angleDegrees: round(d.angleDegrees), piece: owner ? owner.name : null, lines: 1 }, created: made.id };
    } },
  { type: 'dart.twoPoints', title: '两点做省', description: '两点做省（ET 的两点做省）：在边 entityId 上给出省口的两个点 first 和 second（取边上离它们最近的地方），depth 是省深度。省尖从两点连线的中点出发，沿连线的垂直方向量 depth，朝 toward 那一侧。结构线和裁片里面的线在两点之间剪开，两点之间的一段去掉，剪开后的两段与“做省”相同；裁片的轮廓线不剪，省线画成裁片的内部线。',
    input_schema: object({ entityId: text(120, '做省的边'), first: point('省口的一个点'), second: point('省口的另一个点'), depth: lengthOf('省深度，毫米', 2000), toward: point('省尖所在一侧的一个点'), name: text(40, '名称') }, ['entityId', 'first', 'second', 'depth', 'toward']),
    run(project, p, env) {
      requireMm(project);
      const site = dartEdge(project, p, { segments: false }), d = D.twoPointDart(site.edge, p.first, p.second, p.depth, p.toward), setId = env.makeId(), label = p.name || '省';
      const note = part => ({ id: setId, part, widthMm: round(d.widthMm), lengthMm: p.depth }), done = finishEdgeDart(project, env, site, d, { label, note });
      return { summary: { operation: 'dart.twoPoints', setId, widthMm: round(d.widthMm), depthMm: p.depth, tip: at(d.tip), mouth: done.mouth.map(at), edgeCut: site.cut, piece: site.owner ? site.owner.name : null, lines: done.made.length }, created: done.made[0].id };
    } },
  { type: 'dart.insert', title: '插入省', description: '插入省（ET 切展工具里的插入省）：dartEntityId 是省线（一条直线，一头在边上，另一头是省尖），referenceEntityId 是展开方向的参考线，entityIds 是参与的线。把省线绕省尖转开省量 width，作为新的省边：以省线为界，参考线在哪一边，新省边就转到另一边；那一边接在省口上的参与的线改接到新的省口。参考线本身也在 entityIds 里时，其余参与的线（不论在省线的哪一边）都沿参考线平移省量，方向朝参考线的 end 那一端（或 near 那一端）：改接到新省口的那条线也先一起平移，再把它在省口的那一端接到新省口；参考线本身不动，也不加长，与 ET 相同。参考线不在 entityIds 里时只转出新省边、改接那条线，end 和 near 不起作用。省线列不列在 entityIds 里都行，它不动。用于结构线和裁片里面的线。',
    input_schema: object({ dartEntityId: text(120, '省线'), referenceEntityId: text(120, '展开方向参考线'), entityIds: idList('参与的线'), width: lengthOf('省量，毫米', 500), end: { type: 'string', enum: ['start', 'end'], description: '展开的方向：朝参考线的起点还是终点那一端（说的是参考线的端点，不是省线的）' }, near: point('参考线上靠近展开方向那一端的一点'), name: text(40, '名称') }, ['dartEntityId', 'referenceEntityId', 'entityIds', 'width']),
    run(project, p, env) {
      requireMm(project);
      const dart = entityOf(project, p.dartEntityId), reference = entityOf(project, p.referenceEntityId);
      if (dart.type === 'text' || dart.curve || dart.closed || dart.points.length !== 2) throw new Error('省线要是一条直线。');
      if (reference.type === 'text' || reference.closed) throw new Error('参考线要是一条线。'); if (dart.id === reference.id) throw new Error('参考线不能就是省线。');
      if (p.end && p.near) throw new Error('展开方向请用 end 或 near 说明其中一种。');
      const chosen = [...new Set(p.entityIds)].filter(id => id !== dart.id).map(id => entityOf(project, id)), others = [...chosen, reference].filter(e => e.type !== 'text' && e.points.length >= 2);
      const touching = q => others.some(e => endAt(e, q, .05)), [d0, d1] = endsOf(dart);
      if (touching(d0) === touching(d1)) throw new Error('看不出省线哪一头在边上：要有一头接在参与的线（或参考线）的端点上，另一头是省尖。');
      const mouth = touching(d0) ? d0 : d1, tip = touching(d0) ? d1 : d0, leg = D.insertedLeg(tip, mouth, p.width, D.middleOf(shapeOf(reference)));
      const [r0, r1] = endsOf(reference), towardEnd = p.end || (p.near ? (trim.nearestOnPath(reference, p.near).at <= trim.pathLength(reference) / 2 ? 'start' : 'end') : 'end');
      const along = unit(towardEnd === 'end' ? sub(r1, r0) : sub(r0, r1)), shift = p.entityIds.includes(reference.id) ? { x: along.x * p.width, y: along.y * p.width } : { x: 0, y: 0 }, moving = shift.x || shift.y;
      const newSide = D.sideOf(tip, mouth, leg.newMouth), joined = [], shifted = [];
      for (const e of chosen) {
        if (e.id === reference.id || e.type === 'text') continue;
        const end = endAt(e, mouth, .05), onNewSide = D.sideOf(tip, mouth, D.middleOf(shapeOf(e))) === newSide;
        if (end && onNewSide) { changeable(project, e.id, '参与的线'); let shape = moving ? D.mappedShape(shapeOf(e), D.shifting(shift)) : shapeOf(e); setShape(e, shape); setShape(e, withEnd(e, end, leg.newMouth)); joined.push(e.name); }
        else if (moving) { changeable(project, e.id, '参与的线'); setShape(e, D.mappedShape(shapeOf(e), D.shifting(shift))); shifted.push(e.name); }
      }
      if (!joined.length) throw new Error('参与的线里没有在参考线另一侧、接在省口上的线：新省边接不到边上。');
      const setId = env.makeId(), owner = ownerOf(project, dart.id), made = addLine(project, env, (p.name || '插入省') + ' · 省边', [tip, leg.newMouth], { id: setId, part: 'leg2', widthMm: p.width, lengthMm: round(far(tip, mouth)) });
      if (owner) owner.entityIds.push(made.id);
      return { summary: { operation: 'dart.insert', setId, widthMm: p.width, angleDegrees: round(leg.angleDegrees), tip: at(tip), mouth: [at(mouth), at(leg.newMouth)], joined, ...(moving ? { shifted, shiftMm: p.width, towards: towardEnd } : {}), lines: 1 }, created: made.id };
    } },
  { type: 'dart.open', title: '掰开省', description: '掰开省（ET 切展工具里的掰开省）：dartEntityId 是省线（一条直线），省尖在它的 end 那一端（或用 near 给出靠近省尖的一点），另一头是省口；baseEntityId 是省基线，就是掰开的那一侧接在省口上的边线；hingeEntityId 和 hinge 给出转动的点（在这条线上，线在这里断开）；entityIds 是参与的线。掰开那一侧的线（省基线、参与的线里在那一侧的、转动点所在那条线在那一侧的一段）绕转动的点转开，转到省口移动的距离（直线距离）等于省量 width。转动点所在的线总是在转动点断开，列不列在 entityIds 里都一样：只有它在掰开那一侧的一段跟着转，另一段留在原处；断开后原来的线留下从起点到转动点的一段，另一段是新的线，名字是“原线名·2”；新的省边从省尖连到移动后的省口。省基线和转动点所在的线不必列在 entityIds 里；省线列不列都行，它不动。用于结构线和裁片里面的线。',
    input_schema: object({ dartEntityId: text(120, '省线'), end: endField, near: point('靠近省尖那一端的一点'), baseEntityId: text(120, '省基线（掰开一侧接在省口上的边线）'), hingeEntityId: text(120, '转动的点所在的线'), hinge: point('转动的点'),
      entityIds: idList('参与的线'), width: lengthOf('省量，毫米', 500), name: text(40, '名称') }, ['dartEntityId', 'baseEntityId', 'hingeEntityId', 'hinge', 'entityIds', 'width']),
    run(project, p, env) {
      requireMm(project);
      const dart = entityOf(project, p.dartEntityId); if (dart.type === 'text' || dart.curve || dart.closed || dart.points.length !== 2) throw new Error('省线要是一条直线。');
      if (p.end && p.near) throw new Error('省尖请用 end 或 near 说明其中一种。'); if (!p.end && !p.near) throw new Error('需要说明省尖在省线的哪一端：用 end，或用 near。');
      const tipEnd = p.end || (far(dart.points[0], p.near) <= far(dart.points[1], p.near) ? 'start' : 'end'), tip = tipEnd === 'start' ? dart.points[0] : dart.points[1], mouth = tipEnd === 'start' ? dart.points[1] : dart.points[0];
      const base = changeable(project, p.baseEntityId, '省基线').entity, baseEnd = endAt(base, mouth, .05); if (!baseEnd) throw new Error('省基线“' + base.name + '”没有接在省口上。');
      const hingeLine = changeable(project, p.hingeEntityId, '转动的点所在的线').entity, near = trim.nearestOnPath(hingeLine, p.hinge);
      if (near.away > 1) throw new Error('转动的点不在“' + hingeLine.name + '”上（相差 ' + round(near.away) + ' mm）。');
      const baseFar = baseEnd === 'start' ? base.points.at(-1) : base.points[0], turn = D.openingTurn(tip, mouth, near.point, p.width, baseFar), map = D.turning(near.point, turn.angle), inSector = D.inSector(tip, mouth, near.point, baseFar);
      // a hinge on the edge that ends at the mouth on the other side: ET turns only the chosen lines; the base line and that edge stay
      const fixedHinge = Boolean(endAt(hingeLine, mouth, .05)) && hingeLine.id !== base.id, moved = [];
      const moving = new Set([...(fixedHinge ? [] : [base.id]), ...[...new Set(p.entityIds)].filter(id => id !== dart.id && id !== hingeLine.id && !(fixedHinge && id === base.id)).filter(id => { const e = entityOf(project, id); return e.type !== 'text' && e.points.length >= 2 && inSector(D.middleOf(shapeOf(e))); })]);
      for (const id of moving) { const { entity } = changeable(project, id, '参与的线'); setShape(entity, D.mappedShape(shapeOf(entity), map)); moved.push(entity.name); }
      const split = D.splitAt(hingeLine, near.point); let splitInfo = null;
      if (split.parts) {
        const [first, second] = split.parts, turnFirst = !fixedHinge && inSector(D.middleOf(first)), turnSecond = !fixedHinge && inSector(D.middleOf(second)), owner = ownerOf(project, hingeLine.id);
        setShape(hingeLine, turnFirst ? D.mappedShape(first, map) : first);
        const rest = addShape(project, env, { name: hingeLine.name + '·2', layer: hingeLine.layer, ...(hingeLine.aux ? { aux: true } : {}) }, turnSecond ? D.mappedShape(second, map) : second); if (owner) owner.entityIds.push(rest.id);
        splitInfo = { line: hingeLine.name, turned: turnFirst ? 'first' : turnSecond ? 'second' : 'none' };
      } else if (!fixedHinge && !moving.has(hingeLine.id) && inSector(D.middleOf(shapeOf(hingeLine)))) { setShape(hingeLine, D.mappedShape(shapeOf(hingeLine), map)); moved.push(hingeLine.name); }
      const setId = env.makeId(), owner = ownerOf(project, dart.id), made = addLine(project, env, (p.name || '掰开省') + ' · 省边', [tip, turn.moved], { id: setId, part: 'leg2', widthMm: p.width, lengthMm: round(far(tip, turn.moved)) });
      if (owner) owner.entityIds.push(made.id);
      return { summary: { operation: 'dart.open', setId, widthMm: p.width, angleDegrees: round(turn.angleDegrees), hinge: at(near.point), tip: at(tip), mouth: [at(mouth), at(turn.moved)], moved, ...(splitInfo ? { split: splitInfo } : {}), lines: 1 }, created: made.id };
    } },
  { type: 'dart.remove', title: '删除省', description: '删除一个省：entityId 给它的任意一条线（省边、省山、省中线、倒向记号或枣弧省的一条线），整个省一起删掉。省在结构线上剪开过边线的，边线恢复原样。',
    input_schema: object({ entityId: text(120, '省的任意一条线') }, ['entityId']),
    run(project, p) {
      requireMm(project);
      const picked = entityOf(project, p.entityId); if (!picked.dart) throw new Error('“' + picked.name + '”不是用做省命令画的省。');
      const members = project.entities.filter(e => e.dart?.id === picked.dart.id), ids = new Set(members.map(e => e.id)), record = members.map(e => e.dart.edge).find(Boolean);
      project.entities = project.entities.filter(e => !ids.has(e.id));
      for (const group of project.groups || []) group.entityIds = group.entityIds.filter(id => !ids.has(id));
      let restored = null;
      if (record) {
        const edge = project.entities.find(e => e.id === record.entityId), rest = record.restId ? project.entities.find(e => e.id === record.restId) : null;
        if (edge && (!record.restId || rest)) {
          setShape(edge, record.shape); restored = edge.name;
          if (rest) { project.entities = project.entities.filter(e => e.id !== rest.id); for (const group of project.groups || []) group.entityIds = group.entityIds.filter(id => id !== rest.id); }
        }
      }
      return { summary: { operation: 'dart.remove', lines: ids.size, ...(restored ? { edgeRestored: restored } : {}) } };
    } },
];
