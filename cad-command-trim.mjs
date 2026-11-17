/**
 * Commands of v54: bringing the ends of a line or curve to other lines (ET's 一端修正 and 两端修正), moving an end along a
 * direction to a wanted length (定向长度调整) and changing the points
 * a curve goes through (point count, fewer points, moving a group of points, a change between two fixed places).
 * v61 adds cutting lines where another line crosses them (要素切断 of ET's smart tool).
 * The geometry and what was watched on ET are in construct-trim.mjs.
 */
import { number, point, text, idList, object, requireMm, entityOf, changeableLine, round, addEntity, existingIds } from './cad-command-kit.mjs';
import { refreshCurve } from './curves.mjs';
import { length as entityLength } from './geometry.mjs';
import { nativeFitPoints } from './fit-spline.mjs';
import * as trim from './construct-trim.mjs';

const at = q => ({ x: round(q.x), y: round(q.y) });
const endOf = { type: 'string', enum: ['start', 'end'], description: '起点或终点' };
function pathEntity(project, id, what) { const entity = entityOf(project, id); if (entity.type === 'text') throw new Error(what + '不能是文字。'); return entity; }
/** Put the outcome of a correction or a length change into the entity. */
export function applyShape(entity, result) {
  if (result.curve) { entity.curve = result.curve; refreshCurve(entity); }
  else { delete entity.curve; delete entity.curveSamplingCapped; entity.points = result.points.map(q => ({ x: q.x, y: q.y })); }
  if (entity.source) entity.source.modified = true;
}
function chosenEnd(entity, end, near, what) {
  if (end && near) throw new Error(what + '的端点请用 end 或 near 说明其中一种。');
  if (end) return end;
  if (near) { const found = trim.nearestOnPath(entity, near); return found.at <= found.total / 2 ? 'start' : 'end'; }
  throw new Error('需要说明' + what + '的哪一端：用 end，或用 near 给出靠近那一端的点。');
}
const curveOf = (project, id) => { const { entity } = changeableLine(project, id, '曲线'); if (!entity.curve) throw new Error('“' + entity.name + '”不是曲线。'); return entity; };
const pointCount = entity => (nativeFitPoints(entity.curve) || []).length;
const describe = (entity, result) => ({ action: result.action, to: at(result.to), movedMm: round(result.movedMm), afterMm: round(entityLength(entity)), ...(result.onExtension ? { boundaryExtended: true } : {}),
  ...(entity.curve ? { points: pointCount(entity), shapeChangeMm: round(result.shapeChangeMm || 0) } : {}) });

export const trimCommands = [
  { type: 'line.correctEnd', title: '一端修正', description: '把一条线或曲线的一端修到另一条线（修正线）上。这一端没有碰到修正线时沿自己的方向延长到修正线；越过了修正线时在交点处剪掉多出的一段。直线沿自身方向改端点；曲线延长时在修正线上加一个曲线点，剪短时在交点处截断，形状不变。end 说明修哪一端，也可以用 near 给出靠近那一端的点。修正线是直线而且够不着时，按它的延长线算（延长线穿过这条线时，也在那里剪掉多出的一段），结果里 boundaryExtended 为 true。裁片的轮廓线不能用这条命令（用端移动），裁片里面的线可以。',
    input_schema: object({ entityId: text(120, '被修正的线或曲线'), boundaryEntityId: text(120, '修正线'), end: endOf, near: point('靠近要修正那一端的点') }, ['entityId', 'boundaryEntityId']),
    run(project, p) {
      requireMm(project); if (p.entityId === p.boundaryEntityId) throw new Error('被修正的线和修正线不能是同一条。');
      const { entity } = changeableLine(project, p.entityId, '被修正的线'), boundary = pathEntity(project, p.boundaryEntityId, '修正线'), end = chosenEnd(entity, p.end, p.near, '被修正的线');
      const before = entityLength(entity), result = trim.correctEnd(entity, end, boundary); applyShape(entity, result);
      return { summary: { operation: 'line.correctEnd', entityId: entity.id, name: entity.name, end, boundary: boundary.name, beforeMm: round(before), ...describe(entity, result) } };
    } },
  { type: 'line.correctEnds', title: '两端修正', description: '把一条线或曲线的两端分别修到两条修正线上：每一端延长或剪短到离它近的那条修正线，规则与一端修正相同。裁片的轮廓线不能用这条命令。',
    input_schema: object({ entityId: text(120, '被修正的线或曲线'), boundaryEntityIds: { ...idList('两条修正线', 2), maxItems: 2 } }, ['entityId', 'boundaryEntityIds']),
    run(project, p) {
      requireMm(project); const [firstId, secondId] = p.boundaryEntityIds;
      if (firstId === secondId || firstId === p.entityId || secondId === p.entityId) throw new Error('被修正的线和两条修正线须是三条不同的线。');
      const { entity } = changeableLine(project, p.entityId, '被修正的线'), first = pathEntity(project, firstId, '修正线'), second = pathEntity(project, secondId, '修正线');
      const before = entityLength(entity), result = trim.correctEnds(entity, first, second); applyShape(entity, result.result);
      const names = result.startBoundary === 'first' ? [first.name, second.name] : [second.name, first.name];
      return { summary: { operation: 'line.correctEnds', entityId: entity.id, name: entity.name, beforeMm: round(before), afterMm: round(entityLength(entity)),
        corrections: [{ end: 'start', boundary: names[0], action: result.start.action, to: at(result.start.to), movedMm: round(result.start.movedMm) }, { end: 'end', boundary: names[1], action: result.end.action, to: at(result.end.to), movedMm: round(result.end.movedMm) }],
        ...(entity.curve ? { points: pointCount(entity) } : {}) } };
    } },
  { type: 'line.setLengthAlong', title: '定向长度调整', description: '把一条线或曲线的一端沿指定的方向移动，直到整条线的长度等于 length。direction 是移动的方向：horizontal 水平、vertical 垂直、perpendicular 与线在这一端垂直（沿线自身方向的调整用长度调整）。同一条方向线上可能有两个位置都满足，用 toward 给出要移向哪一边的一个点；不给时取移动较少的位置。直线只动这一个端点；曲线只动端部的曲线点，其余曲线点不动。裁片的轮廓线不能用。',
    input_schema: object({ entityId: text(120, '线或曲线'), end: endOf, near: point('靠近要移动那一端的点'), direction: { type: 'string', enum: ['horizontal', 'vertical', 'perpendicular'], description: '端点移动的方向' }, length: { type: 'number', exclusiveMinimum: 0, maximum: 100000, description: '目标长度，毫米' }, toward: point('端点移向哪一边') }, ['entityId', 'direction', 'length']),
    run(project, p) {
      requireMm(project); const { entity } = changeableLine(project, p.entityId, '这条线'), end = chosenEnd(entity, p.end, p.near, '这条线');
      const result = trim.withLengthAlong(entity, end, p.direction, p.length, p.toward); applyShape(entity, result);
      return { summary: { operation: 'line.setLengthAlong', entityId: entity.id, name: entity.name, end, direction: p.direction, beforeMm: round(result.beforeMm), afterMm: round(entityLength(entity)), to: at(result.to), movedMm: round(result.movedMm), ...(entity.curve ? { points: pointCount(entity) } : {}) } };
    } },
  { type: 'curve.setPointCount', title: '设置曲线点数', description: '让一条曲线改由 count 个曲线点决定，点沿曲线等距排开，两端不动。点数比原来少时形状会有变化，结果里的 shapeChangeMm 是变化的最大值；点多便于之后逐点细调。',
    input_schema: object({ entityId: text(120, '曲线'), count: { type: 'integer', minimum: 2, maximum: 120, description: '曲线点的个数，含两端' } }, ['entityId', 'count']),
    run(project, p) {
      requireMm(project); const entity = curveOf(project, p.entityId), before = pointCount(entity), result = trim.withPointCount(entity, p.count);
      if (before === p.count && result.shapeChangeMm < 1e-6) throw new Error('这条曲线已经是 ' + p.count + ' 个等距的曲线点。');
      applyShape(entity, result);
      return { summary: { operation: 'curve.setPointCount', entityId: entity.id, name: entity.name, before, points: result.points, shapeChangeMm: round(result.shapeChangeMm), lengthMm: round(entityLength(entity)) } };
    } },
  { type: 'curve.reducePoints', title: '曲线减点', description: '减少曲线点：每次去掉对形状影响最小的一个点，直到再减就会使曲线偏离原来的形状超过 tolerance（毫米，默认 0.1），或者减到 count 个点为止（给了 count 就不看 tolerance）。可以一次处理多条曲线。端点不动。结果里列出每条曲线减了几个点、形状变化多少。',
    input_schema: object({ entityIds: idList('要减点的曲线'), tolerance: { type: 'number', exclusiveMinimum: 0, maximum: 10, description: '允许的形状变化，毫米，默认 0.1' }, count: { type: 'integer', minimum: 2, maximum: 120, description: '每条曲线保留的曲线点个数' } }, ['entityIds']),
    run(project, p) {
      requireMm(project); if (new Set(p.entityIds).size !== p.entityIds.length) throw new Error('曲线列表有重复。');
      const curves = p.entityIds.map(id => curveOf(project, id)), done = [];
      for (const entity of curves) {
        const result = trim.withFewerPoints(entity, p.count !== undefined ? { count: p.count } : { tolerance: p.tolerance ?? .1 });
        if (result.removed) applyShape(entity, result);
        done.push({ entityId: entity.id, name: entity.name, before: result.points + result.removed, points: result.points, removed: result.removed, shapeChangeMm: round(result.shapeChangeMm) });
      }
      if (!done.some(item => item.removed)) throw new Error(curves.length === 1 ? '这条曲线没有可以减的点：再减就超出允许的形状变化了。' : '这些曲线都没有可以减的点。');
      return { summary: { operation: 'curve.reducePoints', curves: done, removed: done.reduce((sum, item) => sum + item.removed, 0), shapeChangeMm: Math.max(...done.map(item => item.shapeChangeMm)) } };
    } },
  { type: 'curve.movePoints', title: '曲线点群移动', description: '把一条曲线上的几个曲线点一起移动同样的量，曲线按新的点重新圆顺，其余曲线点不动。indices 是曲线点的编号，从 0 数起；端点不能列入（端点用端移动）。只适用于按点画出的曲线。',
    input_schema: object({ entityId: text(120, '曲线'), indices: { type: 'array', description: '要移动的曲线点编号', items: { type: 'integer', minimum: 0, maximum: 200 }, minItems: 1, maxItems: 118 }, by: object({ dx: number(-100000, 100000, '向右移动的量，毫米'), dy: number(-100000, 100000, '向上移动的量，毫米') }, [], '移动量') }, ['entityId', 'indices', 'by']),
    run(project, p) {
      requireMm(project); const entity = curveOf(project, p.entityId), result = trim.withPointsMoved(entity, p.indices, p.by); applyShape(entity, result);
      return { summary: { operation: 'curve.movePoints', entityId: entity.id, name: entity.name, moved: result.moved, points: result.points, by: { dx: round(p.by.dx || 0), dy: round(p.by.dy || 0) }, lengthMm: round(entityLength(entity)) } };
    } },
  { type: 'curve.editLocal', title: '局部曲线编辑', description: '只改曲线上两个固定点之间的一段：把 at 所在的地方移到 to，两个固定点（fixedFrom、fixedTo）之外的曲线形状不变（变化不超过 0.01 毫米）。做法是在固定点之外的原曲线上补曲线点把形状定住，所以曲线点会变多，结果里的 addedPoints 是补了几个。at 须在两个固定点之间。',
    input_schema: object({ entityId: text(120, '曲线'), fixedFrom: point('第一个固定点，取曲线上离它最近的位置'), fixedTo: point('第二个固定点'), at: point('要移动的位置，在两个固定点之间'), to: point('移到哪里') }, ['entityId', 'fixedFrom', 'fixedTo', 'at', 'to']),
    run(project, p) {
      requireMm(project); const entity = curveOf(project, p.entityId), before = entityLength(entity), result = trim.withLocalChange(entity, p.fixedFrom, p.fixedTo, p.at, p.to); applyShape(entity, result);
      return { summary: { operation: 'curve.editLocal', entityId: entity.id, name: entity.name, to: at(p.to), points: result.points, addedPoints: result.addedPoints, outsideChangeMm: round(result.outsideChangeMm), beforeMm: round(before), afterMm: round(entityLength(entity)) } };
    } },
  // v61: ET's smart tool cuts lines where another line crosses them (要素切断)
  { type: 'line.cut', title: '要素切断', description: '把一条或几条线在与切断线相交的地方切开（ET 的“要素打断”，智能笔里的“要素切断”）：每条线在每个交点处断成几段，各段是独立的新线，名字是“原线名·序号”，第一段排在原线的位置，序号从 1 起、顺着原线的方向数；原线不再存在，它的编号不能再用，这一步也没有可以用 @ 引用的新对象。切断线本身不变。切断线是一条直线、又没有碰到要切的线时，在它的延长线先碰到的那一处切。只想切一处时给 near：只在离这个点最近（按画布上的直线距离）的那个交点处切。直线切成直线；曲线切成几段曲线，形状不变（相差不超过 0.01 毫米）。裁片的轮廓线、带刀口或带放码规则的线、闭合的图形不能切；裁片里的内部线切开后各段仍在这个裁片里。',
    input_schema: object({ cutterEntityId: text(120, '切断线'), entityIds: idList('要切断的线'), near: point('只在离这个点最近的那个交点处切；不给就在每个交点处切') }, ['cutterEntityId', 'entityIds']),
    run(project, p, env) {
      requireMm(project); const cutter = pathEntity(project, p.cutterEntityId, '切断线'), ids = [...existingIds(project, p.entityIds)], graded = JSON.stringify(project.gradingPlans || []), done = [];
      if (ids.includes(p.cutterEntityId)) throw new Error('切断线不能同时是要切断的线。');
      for (const id of ids) {
        const { entity, owner } = changeableLine(project, id, '要切断的线');
        if (entity.closed || (entity.points.length > 2 && Math.hypot(entity.points[0].x - entity.points.at(-1).x, entity.points[0].y - entity.points.at(-1).y) < 1e-9)) throw new Error('“' + entity.name + '”是闭合的图形，不能切断。');
        if (graded.includes('"entityId":' + JSON.stringify(id))) throw new Error('“' + entity.name + '”上有放码规则，请先删除规则再切断。');
        const total = trim.pathLength(entity), places = trim.cutPlaces(entity, cutter), away = hit => Math.hypot(hit.point.x - p.near.x, hit.point.y - p.near.y);
        const hits = p.near && places.hits.length > 1 ? [places.hits.reduce((best, hit) => (away(hit) < away(best) ? hit : best))] : places.hits;
        if (!hits.length) throw new Error('“' + entity.name + '”没有与切断线“' + cutter.name + '”相交。');
        const marks = [0, ...hits.map(hit => hit.at), total], created = [];
        for (let i = 1; i < marks.length; i++) {
          const part = trim.partBetween(entity, marks[i - 1], marks[i]), base = { name: entity.name + '·' + i, type: 'polyline', layer: entity.layer, ...(entity.aux ? { aux: true } : {}) };
          created.push(part.curve ? refreshCurve(addEntity(project, env, { ...base, points: [], curve: part.curve })) : addEntity(project, env, { ...base, points: part.points.map(q => ({ x: q.x, y: q.y })) }));
        }
        const place = project.entities.findIndex(e => e.id === id);   // the first part takes the line's place and the others follow at the end, as in ET
        project.entities = project.entities.filter(e => e.id !== id && e.id !== created[0].id); project.entities.splice(place, 0, created[0]);
        if (owner) owner.entityIds.splice(owner.entityIds.indexOf(id), 1, ...created.map(e => e.id));
        done.push({ name: entity.name, parts: created.length, at: hits.map(hit => at(hit.point)), lengthsMm: created.map(e => round(trim.pathLength(e))), ...(places.onExtension ? { onExtension: true } : {}), ...(owner ? { piece: owner.name } : {}) });
      }
      return { summary: { operation: 'line.cut', cutter: cutter.name, lines: done } };
    } },
];
