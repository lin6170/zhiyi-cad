/**
 * Second group of drafting commands (v49): right-angle connection, lines between division points,
 * a perpendicular or a tangent from a point, moving ends, vertical or horizontal correction and
 * editing the points of a curve. Each follows the behaviour observed on ET 2017's own tool with
 * probe files. Geometry lives in construct-edit.mjs.
 */
import { LIMIT, number, point, text, idList, object, layer, requireMm, entityOf, addEntity, existingIds, assertWholePieces, round } from './cad-command-kit.mjs';
import { refreshCurve } from './curves.mjs';
import { length as entityLength } from './geometry.mjs';
import { rotateSelection } from './selection.mjs';
import { nearestStation } from './construct.mjs';
import * as edit from './construct-edit.mjs';

const names = { name: text(60, '名称'), layer }, endOf = { type: 'string', enum: ['start', 'end'], description: '起点或终点' };
const at = q => ({ x: round(q.x), y: round(q.y) }), same = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= .01;
const addLine = (project, env, name, layerName, ends) => addEntity(project, env, { name, type: 'polyline', layer: layerName || 'outline', points: ends.map(q => ({ x: q.x, y: q.y })) });
function pathEntity(project, id, what) { const entity = entityOf(project, id); if (entity.type === 'text') throw new Error(what + '不能是文字。'); return entity; }
function editable(project, id, what) {
  const entity = pathEntity(project, id, what);
  if (entity.derivedFrom || entity.notchFrom) throw new Error('“' + entity.name + '”是缝份或刀口的派生线，不能直接修改。');
  return entity;
}
const ownerOf = (project, id) => (project.groups || []).find(group => group.entityIds.includes(id)) || null;
const endPoint = (entity, end) => end === 'start' ? entity.points[0] : entity.points.at(-1);
/** Which end is meant: named, or the one nearer to a picked point. */
function chosenEnd(entity, end, near, what) {
  if (end && near) throw new Error(what + '的端点请用 end 或 near 说明其中一种。');
  if (end) return end; if (near) return edit.nearerEnd(entity, near);
  throw new Error('需要说明' + what + '的哪一端：用 end，或用 near 给出靠近那一端的点。');
}
/** Largest distance between two sampled lines, each way: how far a curve moved when its points changed. */
function shapeChange(before, after) {
  const away = (q, line) => { let best = Infinity; for (let i = 1; i < line.length; i++) { const a = line[i - 1], b = line[i], dx = b.x - a.x, dy = b.y - a.y, k = dx * dx + dy * dy, t = k ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / k)) : 0; best = Math.min(best, Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy)); } return best; };
  return Math.max(...after.map(q => away(q, before)), ...before.map(q => away(q, after)));
}
function setCurve(entity, curve) { entity.curve = curve; refreshCurve(entity); if (entity.source) entity.source.modified = true; }

export const constructMoreCommands = [
  { type: 'draw.elbow', title: '直角连接', description: '用一横一竖两条直线把两个点连起来，中间是一个直角拐角。corner 为 vertical-first 时从第一点先走竖线，为 horizontal-first 时先走横线；也可以用 toward 给出靠近拐角的点。',
    input_schema: object({ from: point('第一点'), to: point('第二点'), corner: { type: 'string', enum: ['vertical-first', 'horizontal-first'], description: '拐角位置：从第一点先竖后横，或先横后竖' }, toward: point('靠近拐角的点'), ...names }, ['from', 'to']),
    run(project, p, env) {
      requireMm(project); const result = edit.elbow(p.from, p.to, { corner: p.corner, toward: p.toward }), label = p.name || '直角连接';
      const first = addLine(project, env, label + ' A', p.layer, result.lines[0]), second = addLine(project, env, label + ' B', p.layer, result.lines[1]);
      return { summary: { operation: 'draw.elbow', entityIds: [first.id, second.id], corner: at(result.corner), choice: result.choice, lengthsMm: [round(entityLength(first)), round(entityLength(second))] }, created: first.id };
    } },
  { type: 'draw.rungs', title: '等分间隔线', description: '把两条线各分成相同的等份，再把对应的等分点两两连成直线，常用来画褶位或间隔线。等分数为 4 时连出 3 条线。每条线从哪一端量起用 firstFrom、secondFrom 说明，或用 firstNear、secondNear 给出靠近起量端的点；都不给时从各自的起点量。',
    input_schema: object({ firstEntityId: text(120, '第一条线'), secondEntityId: text(120, '第二条线'), count: { type: 'integer', minimum: 2, maximum: 100, description: '等分数' },
      firstFrom: endOf, secondFrom: endOf, firstNear: point('靠近第一条线起量端的点'), secondNear: point('靠近第二条线起量端的点'), ...names }, ['firstEntityId', 'secondEntityId', 'count']),
    run(project, p, env) {
      requireMm(project); if (p.firstEntityId === p.secondEntityId) throw new Error('需要两条不同的线。');
      const first = pathEntity(project, p.firstEntityId, '第一条线'), second = pathEntity(project, p.secondEntityId, '第二条线');
      const from = (entity, end, near, what) => end || near ? chosenEnd(entity, end, near, what) : 'start', firstFrom = from(first, p.firstFrom, p.firstNear, '第一条线'), secondFrom = from(second, p.secondFrom, p.secondNear, '第二条线');
      const lines = edit.rungs(first, second, p.count, firstFrom, secondFrom), label = p.name || '间隔线';
      const made = lines.map(line => addLine(project, env, label + ' ' + line.index + '/' + p.count, p.layer, line.points));
      return { summary: { operation: 'draw.rungs', entityIds: made.map(e => e.id), count: p.count, measuredFrom: [firstFrom, secondFrom], lengthsMm: made.map(e => round(entityLength(e))) }, created: made[0].id };
    } },
  { type: 'draw.perpendicularFrom', title: '点到线的垂线', description: '从一个点向一条直线或曲线作垂线，画到垂足为止。目标是直线时，垂足可以落在它的延长线上；目标是曲线并且有几个垂足时，取离 toward 最近的一个。',
    input_schema: object({ from: point('起点'), entityId: text(120, '目标线'), toward: point('靠近想要的垂足的点'), ...names }, ['from', 'entityId']),
    run(project, p, env) {
      requireMm(project); const target = pathEntity(project, p.entityId, '目标线'), result = edit.footFrom(p.from, target, p.toward), entity = addLine(project, env, p.name || '垂线', p.layer, result.points);
      return { summary: { operation: 'draw.perpendicularFrom', entityId: entity.id, foot: at(result.foot), lengthMm: round(result.length), onExtension: result.onExtension }, created: entity.id };
    } },
  { type: 'draw.tangent', title: '切线', description: '从一个点画一条与曲线或圆相切的直线，画到切点为止。有几条切线时，取切点离 toward 最近的一条。',
    input_schema: object({ from: point('起点'), entityId: text(120, '目标曲线或圆'), toward: point('靠近想要的切点的点'), ...names }, ['from', 'entityId']),
    run(project, p, env) {
      requireMm(project); const target = pathEntity(project, p.entityId, '目标曲线'), result = edit.tangentFrom(p.from, target, p.toward), entity = addLine(project, env, p.name || '切线', p.layer, result.points);
      return { summary: { operation: 'draw.tangent', entityId: entity.id, touch: at(result.touch), lengthMm: round(result.length), possibleLines: result.candidates }, created: entity.id };
    } },
  { type: 'line.moveEnd', title: '端移动', description: '把线或曲线的一端移到新的位置。ends 可以列出几个端点，一起移动；to 是新位置（这时几个端点原来必须在同一点上），by 是移动量。曲线只移动端部的曲线点，其余曲线点不动。移动裁片上的端点时，同一位置上属于这个裁片的其他端点必须一起列出，轮廓才不会断开。',
    input_schema: object({ ends: { type: 'array', minItems: 1, maxItems: 40, description: '要移动的端点', items: object({ entityId: text(120, '线或曲线'), end: endOf, near: point('靠近要移动的一端的点') }, ['entityId']) },
      to: point('新的位置'), by: object({ dx: number(-LIMIT, LIMIT, '向右的移动量，毫米'), dy: number(-LIMIT, LIMIT, '向上的移动量，毫米') }, ['dx', 'dy'], '移动量') }, ['ends']),
    run(project, p) {
      requireMm(project); if ((p.to === undefined) === (p.by === undefined)) throw new Error('to 和 by 需要给出其中一个。');
      const picked = p.ends.map(item => { const entity = editable(project, item.entityId, '要移动的线'); if (entity.closed) throw new Error('“' + entity.name + '”是闭合图形，没有端点。'); return { entity, end: chosenEnd(entity, item.end, item.near, '“' + entity.name + '”') }; });
      const keys = new Set(picked.map(item => item.entity.id + ':' + item.end)); if (keys.size !== picked.length) throw new Error('端点列表有重复。');
      const before = picked.map(item => ({ ...endPoint(item.entity, item.end) }));
      if (p.to && before.some(q => !same(q, before[0]))) throw new Error('这几个端点不在同一个位置，不能移到同一点；请改用 by 给出移动量。');
      if (p.by && !p.by.dx && !p.by.dy) throw new Error('移动量不能为零。');
      // a corner of a piece moves as a whole, so that its outline stays closed
      for (const [index, item] of picked.entries()) {
        const owner = ownerOf(project, item.entity.id); if (!owner) continue;
        for (const id of owner.entityIds) {
          const other = project.entities.find(e => e.id === id); if (!other || other.type === 'text' || other.derivedFrom || other.notchFrom || other.closed) continue;
          for (const end of ['start', 'end']) if (same(endPoint(other, end), before[index]) && !keys.has(other.id + ':' + end)) throw new Error('裁片“' + owner.name + '”里的“' + other.name + '”也有一端在这个位置，请把它一起列入，否则轮廓会断开。');
        }
      }
      picked.forEach((item, index) => {
        const wanted = p.to || { x: before[index].x + p.by.dx, y: before[index].y + p.by.dy }, target = { x: Math.fround(wanted.x), y: Math.fround(wanted.y) }, result = edit.moveEnd(item.entity, item.end, target);
        if (result.curve) setCurve(item.entity, result.curve); else { item.entity.points = result.points; if (item.entity.source) item.entity.source.modified = true; }
      });
      return { summary: { operation: 'line.moveEnd', ends: picked.map((item, index) => ({ entityId: item.entity.id, end: item.end, from: at(before[index]), to: at(endPoint(item.entity, item.end)), lengthMm: round(entityLength(item.entity)) })) } };
    } },
  { type: 'selection.alignAxis', title: '水平垂直补正', description: '把选中的图元一起转动，直到参考直线成为垂直或水平。转动中心是参考线的中点。near 给出靠近参考线一端的点时，这一端转到下方（垂直）或左侧（水平）；不给时取转动角度较小的方向。',
    input_schema: object({ entityIds: idList('要一起转动的图元'), referenceEntityId: text(120, '参考直线'), axis: { type: 'string', enum: ['vertical', 'horizontal'], description: '补正到垂直还是水平' }, near: point('靠近参考线一端的点') }, ['entityIds', 'referenceEntityId', 'axis']),
    run(project, p) {
      requireMm(project); const reference = pathEntity(project, p.referenceEntityId, '参考线'), turn = edit.alignTurn(reference, p.axis, p.near);
      if (Math.abs(turn.degrees) < 1e-9) throw new Error('参考线已经是' + (p.axis === 'vertical' ? '垂直' : '水平') + '的。');
      const ids = existingIds(project, p.entityIds); assertWholePieces(project, ids); rotateSelection(project, ids, turn.degrees, turn.center);
      return { summary: { operation: 'selection.alignAxis', entities: ids.size, axis: p.axis, degrees: round(turn.degrees), center: at(turn.center) } };
    } },
  { type: 'curve.movePoint', title: '移动曲线点', description: '把曲线经过的一个点移到新的位置，曲线按新的点重新圆顺。index 从 0 数起，0 和最后一个是端点，端点请用端移动。只适用于按点画出的曲线。',
    input_schema: object({ entityId: text(120, '曲线'), index: { type: 'integer', minimum: 0, maximum: 200, description: '第几个曲线点，从 0 数起' }, to: point('新的位置') }, ['entityId', 'index', 'to']),
    run(project, p) {
      requireMm(project); const entity = editable(project, p.entityId, '曲线'), points = edit.curvePoints(entity).map(q => ({ x: q.x, y: q.y }));
      if (p.index >= points.length) throw new Error('这条曲线只有 ' + points.length + ' 个曲线点（编号 0 到 ' + (points.length - 1) + '）。');
      if (p.index === 0 || p.index === points.length - 1) throw new Error('这是曲线的端点，请用端移动。');
      if (same(points[p.index], p.to)) throw new Error('曲线点已经在这个位置。');
      const before = at(points[p.index]); points[p.index] = { x: p.to.x, y: p.to.y }; setCurve(entity, edit.curveThrough(points));
      return { summary: { operation: 'curve.movePoint', entityId: entity.id, index: p.index, from: before, to: at(p.to), points: points.length, lengthMm: round(entityLength(entity)) } };
    } },
  { type: 'curve.insertPoint', title: '增加曲线点', description: '在曲线上离给定位置最近的地方增加一个曲线点，之后可以移动这个点来调整。曲线会按新的一组点重新圆顺，原来点少的曲线形状会有变化，结果里的 shapeChangeMm 是变化的最大值。只适用于按点画出的曲线。',
    input_schema: object({ entityId: text(120, '曲线'), near: point('靠近要加点的位置') }, ['entityId', 'near']),
    run(project, p) {
      requireMm(project); const entity = editable(project, p.entityId, '曲线'), points = edit.curvePoints(entity).map(q => ({ x: q.x, y: q.y })), found = nearestStation(entity, p.near);
      const positions = points.map(q => nearestStation(entity, q).position), index = positions.findIndex(position => position > found.position);
      if (index <= 0) throw new Error('这个位置在曲线的端点上，不能加点。');
      if (points.some(q => same(q, found.point))) throw new Error('这个位置已经有一个曲线点。');
      if (points.length >= 120) throw new Error('曲线点已经有 ' + points.length + ' 个，不能再加。');
      const before = entity.points.map(q => ({ x: q.x, y: q.y })); points.splice(index, 0, { x: found.point.x, y: found.point.y }); setCurve(entity, edit.curveThrough(points));
      return { summary: { operation: 'curve.insertPoint', entityId: entity.id, index, at: at(found.point), points: points.length, lengthMm: round(entityLength(entity)), shapeChangeMm: round(shapeChange(before, entity.points)) } };
    } },
  { type: 'curve.removePoint', title: '删除曲线点', description: '去掉曲线经过的一个点，曲线按剩下的点重新圆顺。端点不能删，至少保留两个点。只适用于按点画出的曲线。',
    input_schema: object({ entityId: text(120, '曲线'), index: { type: 'integer', minimum: 0, maximum: 200, description: '第几个曲线点，从 0 数起' } }, ['entityId', 'index']),
    run(project, p) {
      requireMm(project); const entity = editable(project, p.entityId, '曲线'), points = edit.curvePoints(entity).map(q => ({ x: q.x, y: q.y }));
      if (p.index >= points.length) throw new Error('这条曲线只有 ' + points.length + ' 个曲线点（编号 0 到 ' + (points.length - 1) + '）。');
      if (p.index === 0 || p.index === points.length - 1) throw new Error('端点不能删除。');
      const before = entity.points.map(q => ({ x: q.x, y: q.y })), removed = at(points[p.index]); points.splice(p.index, 1); setCurve(entity, edit.curveThrough(points));
      return { summary: { operation: 'curve.removePoint', entityId: entity.id, index: p.index, removed, points: points.length, lengthMm: round(entityLength(entity)), shapeChangeMm: round(shapeChange(before, entity.points)) } };
    } },
];
