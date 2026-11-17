/**
 * Drafting commands of the catalogue: parallels, perpendiculars, angle lines, bisectors,
 * division marks, compass and gauge lines, circles, fillets, corner joins, length changes
 * and mirroring about an axis. The geometry lives in construct.mjs; a command looks up its
 * objects, checks what may be changed and records the result.
 * "left" and "right" are seen while travelling along a line from its first point to its last.
 * Instead of a side, "toward" may name a point; the result is placed on the side of that point.
 */
import { LIMIT, number, point, text, idList, object, layer, requireMm, entityOf, addEntity, existingIds, assertWholePieces, changeableLine, round } from './cad-command-kit.mjs';
import { refreshCurve } from './curves.mjs';
import { length as entityLength } from './geometry.mjs';
import { duplicateSelection, mirrorAboutAxis } from './selection.mjs';
import * as construct from './construct.mjs';
import { divisionArcs, compassNearest } from './construct-edit.mjs';
import { curveWithLength } from './construct-trim.mjs';
import { filletBetween } from './curve-tools.mjs';
import { applyShape } from './cad-command-trim.mjs';

const side = { type: 'string', enum: ['left', 'right'], description: '沿基准线从起点走向终点时的左侧或右侧；也可以改用 toward' };
const toward = point('结果放在这一点所在的一侧');
const where = object({ from: { type: 'string', enum: ['start', 'end'], description: '从起点还是终点量起' }, distance: number(0, LIMIT, '沿线量出的距离，毫米'), ratio: number(0, 1, '占全长的比例，0 为起点，1 为终点') }, [], '线上的位置：给出 from 和 distance，或只给 ratio；可以就在端点上（distance 为 0）');
const lengthOf = description => ({ type: 'number', exclusiveMinimum: 0, maximum: LIMIT, description });
const names = { name: text(60, '名称'), layer };

function pathEntity(project, id, what = '基准线') { const entity = entityOf(project, id); if (entity.type === 'text') throw new Error(what + '不能是文字。'); return entity; }
function chosenSide(entity, p) {
  if (p.side && p.toward) throw new Error('side 和 toward 只能给一个。');
  if (p.side) return p.side;
  if (p.toward) return construct.sideOf(entity, p.toward);
  throw new Error('需要用 side 或 toward 说明放在哪一侧。');
}
/** A straight line that a command may change: open, not derived, and not on the outline of a piece (a line inside a piece may be changed). */
function looseLine(project, id, what) {
  const entity = pathEntity(project, id, what); construct.straightEnds(entity, '“' + entity.name + '”');
  return changeableLine(project, id, what).entity;
}
/** A line, polyline or curve that a fillet may change (v63): open, not derived, not on the outline of a piece. */
function cornerLine(project, id, what) {
  const entity = pathEntity(project, id, what);
  if (entity.closed || (entity.points.length > 2 && Math.hypot(entity.points[0].x - entity.points.at(-1).x, entity.points[0].y - entity.points.at(-1).y) < 1e-9)) throw new Error('“' + entity.name + '”是闭合的图形，不能做圆角。');
  return changeableLine(project, id, what).entity;
}
const ownerOf = (project, id) => (project.groups || []).find(group => group.entityIds.includes(id)) || null;
function moveEnds(entity, ends) { entity.points = ends.map(p => ({ x: p.x, y: p.y })); if (entity.source) entity.source.modified = true; }
function addLine(project, env, p, fallback, ends, extra = {}) { return addEntity(project, env, { name: p.name || fallback, type: 'polyline', layer: p.layer || 'outline', points: ends.map(q => ({ x: q.x, y: q.y })), ...extra }); }
function addCurve(project, env, name, layerName, curve) { return refreshCurve(addEntity(project, env, { name, type: 'polyline', layer: layerName, points: [], curve })); }
const at = q => ({ x: round(q.x), y: round(q.y) });

export const constructCommands = [
  { type: 'draw.parallel', title: '平行线', description: '在一条直线、折线或曲线的一侧，按给定距离作平行线。count 大于 1 时按同样的间距连作几条。曲线的平行线与真实等距线相差不超过 0.005 毫米。基准是折线或闭合折线（例如矩形裁片的轮廓）而只要其中一条边的平行线时，用 segmentIndex 指出是第几条边，结果是一条与这条边等长的直线；要它在裁片里面，toward 给裁片里面的一点。',
    input_schema: object({ entityId: text(120, '基准线'), segmentIndex: { type: 'integer', minimum: 0, maximum: 10000, description: '折线或闭合折线的第几条边，从 0 起（第 n 条边是第 n 个点到下一个点）；不填是整条线' }, distance: lengthOf('平行距离，毫米'), side, toward, count: { type: 'integer', minimum: 1, maximum: 50, description: '条数，默认 1' }, ...names }, ['entityId', 'distance']),
    run(project, p, env) {
      requireMm(project); let base = pathEntity(project, p.entityId);
      if (p.segmentIndex !== undefined) {
        if (base.curve) throw new Error('“' + base.name + '”是曲线，没有一条一条的边；不要给 segmentIndex。');
        const sides = base.closed ? base.points.length : base.points.length - 1; if (p.segmentIndex >= sides) throw new Error('“' + base.name + '”只有 ' + sides + ' 条边，segmentIndex 从 0 到 ' + (sides - 1) + '。');
        const a = base.points[p.segmentIndex], b = base.points[(p.segmentIndex + 1) % base.points.length]; base = { ...base, id: base.id, name: base.name + ' 第 ' + (p.segmentIndex + 1) + ' 边', closed: false, points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] };
      }
      const chosen = chosenSide(base, p), count = p.count ?? 1, made = []; let deviation = 0;
      for (let k = 1; k <= count; k++) {
        const result = construct.parallel(base, p.distance * k, chosen); deviation = Math.max(deviation, result.deviation);
        const entity = addEntity(project, env, { name: (p.name || base.name + ' 平行') + (count > 1 ? ' ' + k : ''), type: 'polyline', layer: p.layer || (base.layer === 'internal' ? 'internal' : 'outline'), ...result.geometry });
        made.push(entity.curve ? refreshCurve(entity) : entity);
      }
      return { summary: { operation: 'draw.parallel', entityIds: made.map(e => e.id), side: chosen, distanceMm: p.distance, count, lengthMm: round(entityLength(made[0])), maxDeviationMm: round(deviation) }, created: made[0].id };
    } },
  { type: 'draw.perpendicular', title: '垂线', description: '在线上的一个位置，向一侧作垂直于该线的直线。曲线上按该位置的切线方向垂直。',
    input_schema: object({ entityId: text(120, '基准线'), at: where, length: lengthOf('垂线长度，毫米'), side, toward, ...names }, ['entityId', 'at', 'length']),
    run(project, p, env) {
      requireMm(project); const base = pathEntity(project, p.entityId), result = construct.angleLine(base, p.at, 90, p.length, chosenSide(base, p)), entity = addLine(project, env, p, '垂线', result.points);
      return { summary: { operation: 'draw.perpendicular', entityId: entity.id, foot: at(result.foot), fromStartMm: round(result.position), lengthMm: p.length }, created: entity.id };
    } },
  { type: 'draw.angleLine', title: '角度线', description: '在线上的一个位置，作与该线成给定角度的直线。角度从基准线的前进方向量起，向所选的一侧转。',
    input_schema: object({ entityId: text(120, '基准线'), at: where, angle: { type: 'number', exclusiveMinimum: 0, maximum: 180, description: '与基准线前进方向的夹角，度，大于 0 小于 180' }, length: lengthOf('线长，毫米'), side, toward, ...names }, ['entityId', 'at', 'angle', 'length']),
    run(project, p, env) {
      requireMm(project); const base = pathEntity(project, p.entityId), result = construct.angleLine(base, p.at, p.angle, p.length, chosenSide(base, p)), entity = addLine(project, env, p, '角度线', result.points);
      return { summary: { operation: 'draw.angleLine', entityId: entity.id, foot: at(result.foot), fromStartMm: round(result.position), angle: p.angle, lengthMm: p.length }, created: entity.id };
    } },
  { type: 'draw.bisector', title: '角平分线', description: '从两条直线的交点出发，作平分它们夹角的直线。每条线以离交点较远的一端所在的方向为准。',
    input_schema: object({ firstEntityId: text(120, '第一条直线'), secondEntityId: text(120, '第二条直线'), length: lengthOf('线长，毫米'), ...names }, ['firstEntityId', 'secondEntityId', 'length']),
    run(project, p, env) {
      requireMm(project); if (p.firstEntityId === p.secondEntityId) throw new Error('需要两条不同的直线。');
      const result = construct.bisector(pathEntity(project, p.firstEntityId), pathEntity(project, p.secondEntityId), p.length), entity = addLine(project, env, p, '角平分线', result.points);
      return { summary: { operation: 'draw.bisector', entityId: entity.id, corner: at(result.corner), lengthMm: p.length }, created: entity.id };
    } },
  { type: 'draw.divide', title: '等分', description: '把一条线或曲线按长度分成相等的几份。默认照 ET 的画法，在每一份的上方画一条小圆弧，弧的两端正好是等分点；style 为 marks 时改为在每个分点画一条横跨该线的短标记。也可以给出两个点，等分它们之间的线段。',
    input_schema: object({ entityId: text(120, '要等分的线'), from: point('线段起点，不给 entityId 时使用'), to: point('线段终点，不给 entityId 时使用'), count: { type: 'integer', minimum: 2, maximum: 100, description: '等分数' }, style: { type: 'string', enum: ['arcs', 'marks'], description: '画法：arcs 为每一份上方的小圆弧（默认），marks 为分点上的短线' }, side: { type: 'string', enum: ['left', 'right'], description: '圆弧画在线的哪一侧，沿起点走向终点时看，默认左侧' }, markLength: { type: 'number', exclusiveMinimum: 0, maximum: 1000, description: '短线的长度，毫米，默认 6' }, name: text(60, '名称') }, ['count']),
    run(project, p, env) {
      requireMm(project); const byPoints = p.from !== undefined || p.to !== undefined;
      if (Boolean(p.entityId) === byPoints) throw new Error('请给出要等分的线，或给出两个点，二选一。');
      if (byPoints && !(p.from && p.to)) throw new Error('两个点都要给出。');
      const base = byPoints ? { type: 'polyline', name: '线段', points: [p.from, p.to], closed: false } : pathEntity(project, p.entityId, '要等分的线');
      if (byPoints) construct.straightEnds(base, '这两个点之间的线段');
      const style = p.style || 'arcs', label = p.name || base.name + ' 等分';
      if (style === 'arcs') {
        if (p.markLength !== undefined) throw new Error('markLength 只用于短线画法（style 为 marks）。');
        const points = Array.from({ length: p.count + 1 }, (_, k) => construct.station(base, { ratio: k / p.count }).point), arcs = divisionArcs(points, p.side || 'left');
        const curves = arcs.map(arc => addCurve(project, env, label + ' ' + arc.index + '/' + p.count, 'internal', arc.curve));
        return { summary: { operation: 'draw.divide', style, entityIds: curves.map(e => e.id), count: p.count, points: points.slice(1, -1).map(at), partLengthMm: round(entityLength(base) / p.count) }, created: curves[0].id };
      }
      if (p.side) throw new Error('side 只用于圆弧画法（style 为 arcs）。');
      const marks = construct.divisionMarks(base, p.count, p.markLength ?? 6);
      const made = marks.map(mark => addEntity(project, env, { name: label + ' ' + mark.index + '/' + p.count, type: 'polyline', layer: 'internal', points: mark.points }));
      return { summary: { operation: 'draw.divide', style, entityIds: made.map(e => e.id), count: p.count, points: marks.map(m => at(m.point)), partLengthMm: round(entityLength(base) / p.count) }, created: made[0].id };
    } },
  { type: 'draw.compass', title: '双圆规', description: '从两个点各画一条给定长度的直线，使两条线在同一点相接。用 side 或 toward 说明交点在第一点到第二点连线的哪一侧。nearest 为 true 时照 ET 的做法：两个线长可以对调，在四个可能的位置里取离 toward 最近的一个。',
    input_schema: object({ a: point('第一点'), b: point('第二点'), lengthA: lengthOf('从第一点出发的线长，毫米'), lengthB: lengthOf('从第二点出发的线长，毫米'), side, toward, nearest: { type: 'boolean', description: '是否允许两个线长对调并取离 toward 最近的位置，默认否' }, ...names }, ['a', 'b', 'lengthA', 'lengthB']),
    run(project, p, env) {
      requireMm(project); const base = { type: 'polyline', points: [p.a, p.b], closed: false }; construct.straightEnds(base, '两个起点之间的连线');
      if (p.nearest && (!p.toward || p.side)) throw new Error('nearest 需要和 toward 一起使用。');
      const result = p.nearest ? compassNearest(p.a, p.b, p.lengthA, p.lengthB, p.toward) : construct.compass(p.a, p.b, p.lengthA, p.lengthB, chosenSide(base, p)), label = p.name || '圆规线';
      const first = addLine(project, env, { ...p, name: label + ' A' }, '', result.lines[0]), second = addLine(project, env, { ...p, name: label + ' B' }, '', result.lines[1]);
      return { summary: { operation: 'draw.compass', entityIds: [first.id, second.id], point: at(result.point), lengthsMm: result.lengths || [p.lengthA, p.lengthB], ...(p.nearest ? { swapped: result.swapped } : {}) }, created: first.id };
    } },
  { type: 'draw.gauge', title: '量规', description: '从一个点画一条给定长度的直线，终点落在目标线或曲线上。有两个位置可选时，用 pick 按目标线的走向选第一个或最后一个，或用 toward 选离某点近的那个。',
    input_schema: object({ from: point('起点'), entityId: text(120, '目标线'), length: lengthOf('线长，毫米'), pick: { type: 'string', enum: ['first', 'last'], description: '按目标线从起点到终点的顺序选第一个或最后一个位置' }, toward: point('选离这一点最近的位置'), ...names }, ['from', 'entityId', 'length']),
    run(project, p, env) {
      requireMm(project); if (p.pick && p.toward) throw new Error('pick 和 toward 只能给一个。');
      const solutions = construct.gauge(p.from, pathEntity(project, p.entityId, '目标线'), p.length);
      if (solutions.length > 1 && !p.pick && !p.toward) throw new Error('目标线上有 ' + solutions.length + ' 个位置都满足这个长度，请用 pick 或 toward 指定要哪一个。');
      const chosen = p.toward ? solutions.reduce((best, s) => Math.hypot(s.point.x - p.toward.x, s.point.y - p.toward.y) < Math.hypot(best.point.x - p.toward.x, best.point.y - p.toward.y) ? s : best) : p.pick === 'last' ? solutions.at(-1) : solutions[0];
      const entity = addLine(project, env, p, '量规线', chosen.line);
      return { summary: { operation: 'draw.gauge', entityId: entity.id, point: at(chosen.point), lengthMm: p.length, solutions: solutions.length }, created: entity.id };
    } },
  { type: 'draw.circle', title: '画圆', description: '按圆心和半径画一个圆。圆是一条首尾相接的曲线，从最右边的点起逆时针一圈。',
    input_schema: object({ center: point('圆心'), radius: lengthOf('半径，毫米'), ...names }, ['center', 'radius']),
    run(project, p, env) {
      requireMm(project); const entity = addCurve(project, env, p.name || '圆', p.layer || 'outline', construct.circleCurve(p.center, p.radius));
      return { summary: { operation: 'draw.circle', entityId: entity.id, radiusMm: p.radius, lengthMm: round(entityLength(entity)) }, created: entity.id };
    } },
  // v63: lines and curves, two distances (ET's two radii) and cut corners (切角); the geometry is in curve-tools.mjs
  { type: 'line.fillet', title: '圆角', description: '在两条线（直线、折线或曲线）的转角处做圆角或切角。转角是两条线相交或首尾相接的地方，两条直线也可以是延长线的交点。只给 radius：用这个半径的圆弧同时与两条线相切。再给 radius2：radius 是第一条线上、radius2 是第二条线上切开处离转角的距离（沿线量，曲线也沿曲线量），两个切开处之间连一条圆顺的曲线（ET 的两个半径的圆角）。style 为 chamfer 是切角：两个切开处连一条直线，不给 radius2 就两边都按 radius。每条线保留离转角较远的那一部分；两条线交叉、要指定哪一端被切掉时，用 firstNear、secondNear 给出靠近要切掉那一端的点。不给 name 时，圆弧和曲线圆角叫“圆角”，切角的直线叫“切角”。闭合的图形、裁片的轮廓线不能用；裁片里面的线可以，两条线须在同一个裁片里，圆角也归这个裁片。',
    input_schema: object({ firstEntityId: text(120, '第一条线'), secondEntityId: text(120, '第二条线'), radius: lengthOf('圆弧的半径；曲线圆角和切角时是第一条线上切开处离转角的距离（沿线量，曲线也沿曲线量），切角不给 radius2 时两条线都在这个距离处切开；毫米'), radius2: lengthOf('第二条线上切开处离转角的距离，毫米；给了就不是圆弧，而是曲线圆角或两边不等的切角'), style: { type: 'string', enum: ['round', 'chamfer'], description: 'round 圆角（默认），chamfer 切角（连直线）' }, firstNear: point('靠近第一条线要切掉那一端的点'), secondNear: point('靠近第二条线要切掉那一端的点'), name: text(60, '圆角线的名称') }, ['firstEntityId', 'secondEntityId', 'radius']),
    run(project, p, env) {
      requireMm(project); if (p.firstEntityId === p.secondEntityId) throw new Error('需要两条不同的线。');
      const first = cornerLine(project, p.firstEntityId, '第一条线'), second = cornerLine(project, p.secondEntityId, '第二条线'), owner = ownerOf(project, first.id);
      if (owner !== ownerOf(project, second.id)) throw new Error('两条线须在同一个裁片里，或者都不属于裁片。');
      const result = filletBetween(first, second, { radius: p.radius, radius2: p.radius2, style: p.style || 'round', firstNear: p.firstNear, secondNear: p.secondNear });
      applyShape(first, result.first); applyShape(second, result.second);
      const fallback = result.kind === 'chamfer' ? '切角' : '圆角', made = result.joint.curve ? addCurve(project, env, p.name || fallback, first.layer || 'outline', result.joint.curve) : addLine(project, env, { name: p.name, layer: first.layer || 'outline' }, fallback, result.joint.points);
      if (owner) owner.entityIds.push(made.id);
      return { summary: { operation: 'line.fillet', entityId: made.id, kind: result.kind, radiusMm: p.radius, ...(p.radius2 !== undefined ? { radius2Mm: p.radius2 } : {}), corner: at(result.corner), tangentPoints: result.tangentPoints.map(at), cutsMm: result.cuts.map(round),
        ...(result.kind === 'arc' && Math.abs(result.cuts[0] - result.cuts[1]) < 1e-9 ? { setbackMm: round(result.cuts[0]) } : {}), ...(result.kind === 'arc' ? { arcLengthMm: round(entityLength(made)) } : {}), lengthMm: round(entityLength(made)), firstLengthMm: round(entityLength(first)), secondLengthMm: round(entityLength(second)) }, created: made.id };
    } },
  { type: 'line.cornerJoin', title: '角连接', description: '把两条直线延长或剪短到它们的交点，形成一个角。每条线中离交点较近的一端移到交点；两条线交叉、需要指定连接哪一端时，用 firstNear、secondNear 给出靠近那一端的点。裁片的轮廓线不能用，裁片里面的线可以。',
    input_schema: object({ firstEntityId: text(120, '第一条直线'), secondEntityId: text(120, '第二条直线'), firstNear: point('靠近第一条线连接端的点'), secondNear: point('靠近第二条线连接端的点') }, ['firstEntityId', 'secondEntityId']),
    run(project, p) {
      requireMm(project); if (p.firstEntityId === p.secondEntityId) throw new Error('需要两条不同的直线。');
      const first = looseLine(project, p.firstEntityId, '第一条线'), second = looseLine(project, p.secondEntityId, '第二条线'), result = construct.cornerJoin(first, second, { firstNear: p.firstNear, secondNear: p.secondNear });
      moveEnds(first, result.first); moveEnds(second, result.second);
      return { summary: { operation: 'line.cornerJoin', corner: at(result.corner), lengthsMm: [round(entityLength(first)), round(entityLength(second))] } };
    } },
  { type: 'line.setLength', title: '长度调整', description: '改变一条直线或曲线的长度：移动它的一端，使长度等于 length，或在原长上加减 delta。直线沿自身的方向移动端点。曲线加长时顺着端部的方向加一个曲线点，位置正好使整条曲线达到要求的长度；曲线缩短时按长度截断，留下的部分形状不变。裁片的轮廓线不能用（用端移动），裁片里面的线可以。',
    input_schema: object({ entityId: text(120, '直线或曲线'), end: { type: 'string', enum: ['start', 'end'], description: '移动起点还是终点' }, length: lengthOf('新的线长，毫米'), delta: number(-LIMIT, LIMIT, '线长的增减量，毫米，正数加长') }, ['entityId', 'end']),
    run(project, p) {
      requireMm(project); if ((p.length === undefined) === (p.delta === undefined)) throw new Error('length 和 delta 需要给出其中一个。');
      if (pathEntity(project, p.entityId, '这条线').curve) {   // a curve: one more point in its end direction, or a cut at the wanted length
        const { entity } = changeableLine(project, p.entityId, '这条曲线'), before = entityLength(entity), target = p.length ?? before + p.delta;
        if (!(target > 1e-6)) throw new Error('调整后的长度须大于 0（现在长 ' + before.toFixed(2) + ' mm）。');
        const result = curveWithLength(entity, p.end, target); entity.curve = result.curve; refreshCurve(entity); if (entity.source) entity.source.modified = true;
        return { summary: { operation: 'line.setLength', entityId: entity.id, beforeMm: round(before), afterMm: round(entityLength(entity)), curve: true, action: result.action, to: at(result.to), ...(result.fitPoints ? { points: result.fitPoints } : {}), shapeChangeMm: round(result.shapeChangeMm || 0) } };
      }
      const entity = looseLine(project, p.entityId, '这条线'), before = entityLength(entity), target = p.length ?? before + p.delta;
      if (!(target > 1e-6)) throw new Error('调整后的线长须大于 0（现在长 ' + before.toFixed(2) + ' mm）。');
      if (Math.abs(target - before) < 1e-9) throw new Error('线长没有变化。');
      moveEnds(entity, construct.withLength(entity, p.end, target));
      return { summary: { operation: 'line.setLength', entityId: entity.id, beforeMm: round(before), afterMm: round(target) } };
    } },
  { type: 'selection.mirrorAxis', title: '按轴镜像', description: '把图元或整个裁片翻到一条轴线的另一侧。轴线可以是一条直线图元，也可以由两个点给出。copy 为 true 时保留原件，生成镜像副本。',
    input_schema: object({ entityIds: idList('要镜像的图元'), axisEntityId: text(120, '作为镜像轴的直线'), axisFrom: point('镜像轴上的一点'), axisTo: point('镜像轴上的另一点'), copy: { type: 'boolean', description: '是否保留原件并生成副本，默认否' } }, ['entityIds']),
    run(project, p, env) {
      const byPoints = p.axisFrom !== undefined || p.axisTo !== undefined;
      if (Boolean(p.axisEntityId) === byPoints) throw new Error('镜像轴请给出一条直线，或给出两个点，二选一。');
      if (byPoints && !(p.axisFrom && p.axisTo)) throw new Error('镜像轴的两个点都要给出。');
      const [from, to] = byPoints ? [p.axisFrom, p.axisTo] : construct.straightEnds(pathEntity(project, p.axisEntityId, '镜像轴'), '镜像轴');
      construct.reflection(from, to);
      let ids = existingIds(project, p.entityIds); assertWholePieces(project, ids);
      const groupsBefore = new Set((project.groups || []).map(group => group.id));
      if (p.copy) ids = duplicateSelection(project, ids, env.makeId, { offsetX: 0, offsetY: 0 });
      mirrorAboutAxis(project, ids, from, to);
      const copyGroup = p.copy ? (project.groups || []).find(group => !groupsBefore.has(group.id)) : null;
      return { summary: { operation: 'selection.mirrorAxis', entities: ids.size, copy: Boolean(p.copy), entityIds: p.copy ? [...ids] : undefined }, created: p.copy ? (copyGroup?.id || [...ids][0]) : null };
    } },
];
