/**
 * Drafting tools on the canvas. A tool collects what its command needs: lines and points
 * picked on the canvas and sizes typed in the panel. The result is shown on the canvas as
 * soon as the parameters are complete and is drawn only when it is applied.
 * Every tool is one command of the catalogue; the panel holds no geometry of its own.
 */
import { nearestStation } from './construct.mjs';
import { nativeFitPoints } from './fit-spline.mjs';
import { linesAngle, threePointAngle, alongBetween, compareGroups, tapeMarks } from './measure.mjs';

const STORE = 'zhiyi-construct/v1';
const line = (key, label, extra = {}) => ({ key, label, kind: 'entity', ...extra });
const spot = (key, label, extra = {}) => ({ key, label, kind: 'point', ...extra });
const size = (key, label, initial) => ({ key, label, kind: 'length', initial });
const whole = (key, label, initial, min, max) => ({ key, label, kind: 'count', initial, min, max });
const choice = (key, label, options) => ({ key, label, kind: 'choice', options, initial: options[0][0] });
const words = (key, label) => ({ key, label, kind: 'text', initial: '' });
// several lines picked one after another for one slot: a click adds a line, a second click on it takes it out again
const many = (key, label, extra = {}) => ({ key, label, kind: 'entities', ...extra });
const turn = { key: 'rotation', label: '旋转', kind: 'angle', initial: 0 };
const pieceOf = (project, id) => (project.groups || []).find(group => group.entityIds.includes(id))?.id || '不在裁片上';
// cut-and-spread (v60): the figure is what was selected plus the lines picked in the tool; the strip that stays is at one end of the fixed side
const FITS = [['none', '保留各段和分割线'], ['each', '原来的每条线各拟合成曲线'], ['merged', '每一侧合并拟合成一条曲线']];
const figureOf = (selection, ...picked) => [...new Set([...selection, ...picked.flat()])];
function startOf(project, fixedIds, which) {
  if (which !== 'last') return {};
  const lines = fixedIds.map(id => project.entities.find(e => e.id === id)).filter(Boolean), tips = lines.flatMap(e => [e.points[0], e.points.at(-1)]);
  const free = tips.filter(p => tips.filter(q => Math.hypot(p.x - q.x, p.y - q.y) < .05).length === 1);   // the two ends of the side
  if (!lines.length || free.length !== 2) return {};
  const first = lines[0].points[0], startsAt = free.reduce((a, b) => Math.hypot(a.x - first.x, a.y - first.y) <= Math.hypot(b.x - first.x, b.y - first.y) ? a : b), other = free.find(p => p !== startsAt);
  return { from: { x: other.x, y: other.y } };
}
const ENDS = [['start', '起点'], ['end', '终点']];
// "station" tools take a place on the base line: the click sets it, the two fields refine it.
const stationFields = [choice('from', '量起端', ENDS), { key: 'offset', label: '离该端', kind: 'length', initial: 0, allowZero: true }];
const place = s => ({ from: s.from, distance: s.offset });
const endPoint = (entity, end) => end === 'start' ? entity.points[0] : entity.points.at(-1), apart = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const nearerEnd = (entity, point) => { const found = nearestStation(entity, point); return found.position <= found.total / 2 ? 'start' : 'end'; };
/** Every line end on one point. They move together, as when ET's end move frames a corner. */
function endsAt(project, point) {
  const ends = [];
  for (const entity of project.entities) {
    if (entity.type === 'text' || entity.closed || entity.derivedFrom || entity.notchFrom || entity.points.length < 2) continue;
    for (const end of ['start', 'end']) if (apart(endPoint(entity, end), point) <= .01) ends.push({ entityId: entity.id, end });
  }
  return ends;
}
/** The curve point nearest to a place, for the tools that work on the points of a curve. */
function curvePointNear(entity, point) {
  const fit = entity && entity.curve ? nativeFitPoints(entity.curve) : null; if (!fit) return null;
  let index = 0; fit.forEach((q, i) => { if (apart(q, point) < apart(fit[index], point)) index = i; });
  return { index, count: fit.length, point: fit[index] };
}
const find = (project, id) => project.entities.find(e => e.id === id);

export const CONSTRUCT_TOOLS = [
  { id: 'parallel', title: '平行线', hint: '点选基准线，再在要放的一侧点一下。', slots: [line('base', '基准线'), spot('toward', '放在哪一侧', { free: true })], fields: [size('distance', '距离', 30), whole('count', '条数', 1, 1, 50)],
    command: s => ({ type: 'draw.parallel', parameters: { entityId: s.base.id, distance: s.distance, toward: s.toward, ...(s.count > 1 ? { count: s.count } : {}) } }) },
  { id: 'perpendicular', title: '垂线', hint: '在基准线上要起垂线的位置点一下，再在要画的一侧点一下。', slots: [line('base', '基准线和位置', { station: true }), spot('toward', '朝哪一侧', { free: true })], fields: [...stationFields, size('length', '垂线长', 100)],
    command: s => ({ type: 'draw.perpendicular', parameters: { entityId: s.base.id, at: place(s), length: s.length, toward: s.toward } }) },
  { id: 'angle', title: '角度线', hint: '在基准线上的位置点一下，再在要画的一侧点一下。角度从基准线的前进方向量起。', slots: [line('base', '基准线和位置', { station: true }), spot('toward', '朝哪一侧', { free: true })], fields: [...stationFields, { key: 'angle', label: '角度', kind: 'angle', initial: 45 }, size('length', '线长', 100)],
    command: s => ({ type: 'draw.angleLine', parameters: { entityId: s.base.id, at: place(s), angle: s.angle, length: s.length, toward: s.toward } }) },
  { id: 'bisector', title: '角平分线', hint: '点选两条直线。', slots: [line('first', '第一条直线'), line('second', '第二条直线')], fields: [size('length', '线长', 100)],
    command: s => ({ type: 'draw.bisector', parameters: { firstEntityId: s.first.id, secondEntityId: s.second.id, length: s.length } }) },
  { id: 'divide', title: '等分', hint: '点选要等分的线。每一份上方画一条小弧线，弧的两端就是等分点（与 ET 相同）；也可以改成在分点上画短线。', slots: [line('base', '要等分的线')], fields: [whole('count', '等分数', 2, 2, 100), choice('style', '画法', [['arcs', '弧线'], ['marks', '短线']])],
    command: s => ({ type: 'draw.divide', parameters: { entityId: s.base.id, count: s.count, style: s.style } }) },
  { id: 'compass', title: '双圆规', hint: '点选两个起点，再在想要的交点附近点一下。四个可能的位置里取最近的一个，两个线长可能对调（与 ET 相同）。', slots: [spot('a', '第一点'), spot('b', '第二点'), spot('toward', '交点大概在哪里', { free: true })], fields: [size('lengthA', '第一条线长', 100), size('lengthB', '第二条线长', 100)],
    command: s => ({ type: 'draw.compass', parameters: { a: s.a, b: s.b, lengthA: s.lengthA, lengthB: s.lengthB, toward: s.toward, nearest: true } }) },
  { id: 'gauge', title: '量规', hint: '点选起点，再在目标线上想要的落点附近点一下。', slots: [spot('from', '起点'), line('target', '目标线', { near: 'toward' })], fields: [size('length', '线长', 100)],
    command: s => ({ type: 'draw.gauge', parameters: { from: s.from, entityId: s.target.id, length: s.length, toward: s.toward } }) },
  { id: 'circle', title: '圆', hint: '点选圆心。', slots: [spot('center', '圆心')], fields: [size('radius', '半径', 50)],
    command: s => ({ type: 'draw.circle', parameters: { center: s.center, radius: s.radius } }) },
  { id: 'fillet', title: '圆角', hint: '点选两条线（直线或曲线），每条都点在靠近要做圆角的那一端（与 ET 相同）。圆弧只用第一个半径；曲线圆角和切角按两个距离在两条线上切开（沿线量），曲线圆角中间连一条圆顺的曲线，切角连一条直线。裁片的轮廓线不能用，裁片里面的线可以。',
    slots: [line('first', '第一条线，点在连接端附近', { near: 'firstNear' }), line('second', '第二条线，点在连接端附近', { near: 'secondNear' })], fields: [choice('style', '做法', [['arc', '圆弧（一个半径）'], ['curve', '曲线圆角（两个距离）'], ['chamfer', '切角（两个距离）']]), size('radius', '半径或第一条线上的距离', 20), size('radius2', '第二条线上的距离', 20)],
    command: s => ({ type: 'line.fillet', parameters: { firstEntityId: s.first.id, secondEntityId: s.second.id, radius: s.radius, ...(s.style === 'arc' ? {} : { radius2: s.radius2 }), ...(s.style === 'chamfer' ? { style: 'chamfer' } : {}), firstNear: s.firstNear, secondNear: s.secondNear } }) },
  { id: 'corner', title: '角连接', hint: '点选两条直线，每条都点在靠近要连接的那一端（与 ET 相同），它们会延长或剪短到交点。裁片的轮廓线不能用，裁片里面的线可以。', slots: [line('first', '第一条直线，点在连接端附近', { near: 'firstNear' }), line('second', '第二条直线，点在连接端附近', { near: 'secondNear' })], fields: [],
    command: s => ({ type: 'line.cornerJoin', parameters: { firstEntityId: s.first.id, secondEntityId: s.second.id, firstNear: s.firstNear, secondNear: s.secondNear } }) },
  { id: 'length', title: '长度调整', hint: '在直线或曲线上靠近要移动的一端点一下。曲线加长时顺着端部的方向加一个曲线点，缩短时按长度截断。裁片的轮廓线不能用。', slots: [line('base', '线和要移动的一端', { end: true })], fields: [choice('end', '移动', ENDS), choice('mode', '方式', [['length', '改成'], ['delta', '加减']]), { key: 'value', label: '数值', kind: 'signed', initial: 100 }],
    command: s => ({ type: 'line.setLength', parameters: { entityId: s.base.id, end: s.end, [s.mode]: s.value } }) },
  { id: 'lengthAlong', title: '定向长度', hint: '在线或曲线上靠近要移动的一端点一下，再在要移向的那一边点一下。这一端沿所选的方向移动，直到线长等于目标长度（ET 的定向长度调整）。', slots: [line('base', '线和要移动的一端', { end: true }), spot('toward', '移向哪一边（在那一侧点一下）', { free: true })],
    fields: [choice('end', '移动', ENDS), choice('direction', '方向', [['horizontal', '水平'], ['vertical', '垂直'], ['perpendicular', '与线垂直']]), size('length', '目标长度', 100)],
    command: s => ({ type: 'line.setLengthAlong', parameters: { entityId: s.base.id, end: s.end, direction: s.direction, length: s.length, toward: s.toward } }) },
  { id: 'trimOne', title: '一端修正', hint: '先在要修正的线或曲线上靠近要修的一端点一下，再点修正线。没碰到修正线的延长过去，越过的剪掉，和 ET 的一端修正一样。裁片的轮廓线不能用。', slots: [line('base', '被修正的线，点在要修的一端附近', { near: 'near' }), line('boundary', '修正线')], fields: [],
    command: s => ({ type: 'line.correctEnd', parameters: { entityId: s.base.id, boundaryEntityId: s.boundary.id, near: s.near } }) },
  { id: 'trimTwo', title: '两端修正', hint: '点选要修正的线或曲线，再点两条修正线。两端各修到离它近的那条修正线上。', slots: [line('base', '被修正的线'), line('first', '第一条修正线'), line('second', '第二条修正线')], fields: [],
    command: s => ({ type: 'line.correctEnds', parameters: { entityId: s.base.id, boundaryEntityIds: [s.first.id, s.second.id] } }) },
  { id: 'mirror', title: '按轴镜像', hint: '先在选择工具里选中要镜像的图元或裁片，再打开本工具点选作为轴的直线。', slots: [line('axis', '镜像轴（一条直线）')], fields: [{ key: 'copy', label: '保留原件，生成副本', kind: 'check', initial: false }], needsSelection: true,
    command: (s, selection) => ({ type: 'selection.mirrorAxis', parameters: { entityIds: selection, axisEntityId: s.axis.id, copy: s.copy } }) },
  { id: 'elbow', title: '直角连接', hint: '点选两个点，再在拐角所在的一边点一下。画出一横一竖两条线。', slots: [spot('from', '第一点'), spot('to', '第二点'), spot('toward', '拐角在哪一边', { free: true })], fields: [],
    command: s => ({ type: 'draw.elbow', parameters: { from: s.from, to: s.to, toward: s.toward } }) },
  { id: 'rungs', title: '间隔线', hint: '点选两条线，每条都点在靠近起量的一端。两条线上对应的等分点连成直线，常用来画褶位。', slots: [line('first', '第一条线，点在起量端附近', { near: 'firstNear' }), line('second', '第二条线，点在起量端附近', { near: 'secondNear' })], fields: [whole('count', '等分数', 4, 2, 100)],
    command: s => ({ type: 'draw.rungs', parameters: { firstEntityId: s.first.id, secondEntityId: s.second.id, count: s.count, firstNear: s.firstNear, secondNear: s.secondNear } }) },
  { id: 'drop', title: '点垂线', hint: '点选起点，再点选目标线。从起点向目标线作垂线，画到垂足。', slots: [spot('from', '起点'), line('target', '目标线', { near: 'toward' })], fields: [],
    command: s => ({ type: 'draw.perpendicularFrom', parameters: { from: s.from, entityId: s.target.id, toward: s.toward } }) },
  { id: 'tangent', title: '切线', hint: '点选起点，再在曲线或圆上想要的切点附近点一下。', slots: [spot('from', '起点'), line('target', '目标曲线或圆', { near: 'toward' })], fields: [],
    command: s => ({ type: 'draw.tangent', parameters: { from: s.from, entityId: s.target.id, toward: s.toward } }) },
  { id: 'moveEnd', title: '端移动', hint: '在线或曲线上靠近要移动的一端点一下，再点新的位置；也可以按住这一端直接拖到新位置再松开。同一点上的其他线端一起移动，裁片的角不会断开。', slots: [line('base', '线和要移动的一端', { near: 'near' }), spot('to', '新的位置')], fields: [],
    command: (s, selection, project) => { const entity = find(project, s.base.id); return { type: 'line.moveEnd', parameters: { ends: endsAt(project, endPoint(entity, nearerEnd(entity, s.near))), to: s.to } }; } },
  { id: 'align', title: '补正', hint: '先在选择工具里选中要一起转动的图元或裁片，再打开本工具，在参考直线上靠近一端点一下：这一端转到下方（垂直）或左侧（水平）。', slots: [line('reference', '参考直线，点在一端附近', { near: 'near' })], fields: [choice('axis', '补正到', [['vertical', '垂直'], ['horizontal', '水平']])], needsSelection: true,
    command: (s, selection) => ({ type: 'selection.alignAxis', parameters: { entityIds: selection, referenceEntityId: s.reference.id, axis: s.axis, near: s.near } }) },
  { id: 'curveMove', title: '移曲线点', hint: '在曲线上靠近要移动的曲线点点一下，再点新的位置；也可以按住这个点直接拖到新位置再松开。曲线按新的点重新圆顺。', slots: [line('base', '曲线和要移动的点', { near: 'near', points: true }), spot('to', '新的位置')], fields: [],
    command: (s, selection, project) => {
      const entity = find(project, s.base.id), hit = curvePointNear(entity, s.near);
      if (hit && (hit.index === 0 || hit.index === hit.count - 1)) return { type: 'line.moveEnd', parameters: { ends: endsAt(project, hit.point), to: s.to } };
      return { type: 'curve.movePoint', parameters: { entityId: s.base.id, index: hit ? hit.index : 1, to: s.to } };
    } },
  { id: 'curveAdd', title: '加曲线点', hint: '在曲线上要加点的位置点一下。', slots: [line('base', '曲线和加点的位置', { near: 'near', points: true })], fields: [],
    command: s => ({ type: 'curve.insertPoint', parameters: { entityId: s.base.id, near: s.near } }) },
  { id: 'curveRemove', title: '删曲线点', hint: '在曲线上靠近要删的曲线点点一下。端点不能删。', slots: [line('base', '曲线和要删的点', { near: 'near', points: true })], fields: [],
    command: (s, selection, project) => { const hit = curvePointNear(find(project, s.base.id), s.near); return { type: 'curve.removePoint', parameters: { entityId: s.base.id, index: hit ? hit.index : 1 } }; } },
  { id: 'curveCount', title: '曲线点数', hint: '点选一条曲线，输入曲线点的个数。点沿曲线等距排开，两端不动；点少了形状会变，画到画布之前先看变动多少。', slots: [line('base', '曲线', { points: true })], fields: [whole('count', '点数', 6, 2, 120)],
    command: s => ({ type: 'curve.setPointCount', parameters: { entityId: s.base.id, count: s.count } }) },
  { id: 'curveReduce', title: '曲线减点', hint: '点选一条曲线：去掉对形状影响最小的点，直到再减就超过允许的变化。先在选择工具里选中几条曲线再打开本工具，可以一起减。', slots: [line('base', '曲线', { points: true })], fields: [size('tolerance', '允许的形状变化', .1)],
    command: (s, selection, project) => ({ type: 'curve.reducePoints', parameters: { entityIds: [...new Set([s.base.id, ...selection.filter(id => find(project, id)?.curve && !find(project, id).derivedFrom)])], tolerance: s.tolerance } }) },
  { id: 'curveGroup', title: '点群移动', hint: '在曲线上靠近要移动的第一个曲线点点一下，再靠近最后一个点一下，这两个点和它们之间的曲线点一起移动。端点不在内。', slots: [line('base', '曲线，点在第一个要移动的曲线点附近', { near: 'near', points: true }), spot('last', '最后一个要移动的曲线点附近', { free: true })],
    fields: [{ key: 'dx', label: '向右', kind: 'signed', initial: 0 }, { key: 'dy', label: '向上', kind: 'signed', initial: -5 }],
    command: (s, selection, project) => {
      const entity = find(project, s.base.id), a = curvePointNear(entity, s.near), b = curvePointNear(entity, s.last); if (!a || !b) return { type: 'curve.movePoints', parameters: { entityId: s.base.id, indices: [1], by: { dx: s.dx, dy: s.dy } } };
      const from = Math.max(1, Math.min(a.index, b.index)), to = Math.min(a.count - 2, Math.max(a.index, b.index)), indices = []; for (let i = from; i <= to; i++) indices.push(i);
      return { type: 'curve.movePoints', parameters: { entityId: s.base.id, indices: indices.length ? indices : [1], by: { dx: s.dx, dy: s.dy } } };
    } },
  { id: 'curveLocal', title: '局部曲线', hint: '在曲线上点第一个固定点，再点第二个固定点，然后点要移动的地方，最后点它的新位置。两个固定点之外的形状不变。', slots: [line('base', '曲线，点在第一个固定点上', { near: 'fixedFrom', points: true }), spot('fixedTo', '第二个固定点（点在曲线上）'), spot('at', '要移动的地方（两个固定点之间）'), spot('to', '新的位置', { free: true })], fields: [],
    command: s => ({ type: 'curve.editLocal', parameters: { entityId: s.base.id, fixedFrom: s.fixedFrom, fixedTo: s.fixedTo, at: s.at, to: s.to } }) },
  // v63: ET's 定长调曲线, 曲线端矢调整 and 接角圆顺 (curve-tools.mjs)
  { id: 'keepLength', title: '定长调曲线', hint: '在曲线上靠近要移动的曲线点点一下，再点它的新位置；曲线长度不变，其余曲线点沿两端连线的垂直方向跟着移动，离得越远动得越少。要让某个曲线点不动，接着在它旁边点一下（可以不点）。两个端点不动。',
    slots: [line('base', '曲线和要移动的点', { near: 'near', points: true }), spot('to', '新的位置', { free: true }), spot('fixed', '不动的曲线点', { optional: true })], fields: [],
    command: (s, selection, project) => {
      const entity = find(project, s.base.id), hit = curvePointNear(entity, s.near), keep = s.fixed ? curvePointNear(entity, s.fixed) : null;
      return { type: 'curve.moveKeepLength', parameters: { entityId: s.base.id, index: hit ? hit.index : 1, to: s.to, ...(keep && hit && keep.index !== hit.index ? { fixedIndices: [keep.index] } : {}) } };
    } },
  { id: 'turnEnd', title: '曲线端矢', hint: '在曲线上靠近要转的那一端点一下，再点这一端要朝向的地方。两个端点不动，中间的曲线点跟着转，离这一端越近转得越多（与 ET 的曲线端矢调整相同）。',
    slots: [line('base', '曲线，点在要转的那一端附近', { near: 'near' }), spot('toward', '这一端朝向哪里', { free: true })], fields: [],
    command: s => ({ type: 'curve.turnEnd', parameters: { entityId: s.base.id, near: s.near, toward: s.toward } }) },
  { id: 'smoothCorner', title: '接角圆顺', hint: '依次点两条要接顺的曲线（例如前片下摆、后片下摆），再依次点它们各自的缝合线（前侧缝、后侧缝）。第二片按缝合线接到第一片上看接点处顺不顺，再把两条曲线在接点那一端转成与缝合线垂直，或顺成平均方向；接点和另一端不动，缝合线不改。',
    slots: [line('first', '第一条要接顺的曲线'), line('second', '第二条要接顺的曲线'), line('firstSeam', '第一条曲线的缝合线'), line('secondSeam', '第二条曲线的缝合线')], fields: [choice('mode', '圆顺方式', [['square', '与缝合线垂直'], ['smooth', '顺成平均方向']])],
    command: s => ({ type: 'curve.smoothCorner', parameters: { firstEntityId: s.first.id, secondEntityId: s.second.id, firstSeamId: s.firstSeam.id, secondSeamId: s.secondSeam.id, mode: s.mode } }) },
  { id: 'notch', title: '刀口', hint: '按距离：在线上点一下，点在靠近量起的那一端，距离从这一端沿线量。指定位置：点在哪里，刀口就打在哪里。这条边有缝份时，刀口从缝边线向里切。',
    slots: [line('base', '要打刀口的线', { near: 'near' })], fields: [choice('place', '位置', [['distance', '按距离'], ['click', '指定位置（点在哪里打在哪里）']]), size('distance', '按距离：离点的这一端', 50), whole('count', '个数', 1, 1, 3), size('depth', '刀口深度', 3)],
    command: (s, selection, project) => {
      const entity = find(project, s.base.id), far = (a, b) => Math.hypot(a.x - b.x, a.y - b.y); let segmentIndex, a = entity?.points[0], b = entity?.points.at(-1);
      // on an outline drawn as one closed polyline the nearest side is the edge that is meant
      if (entity && entity.closed && !entity.curve && s.near) { let best = Infinity; entity.points.forEach((p, i) => { const q = entity.points[(i + 1) % entity.points.length], dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy, t = d2 ? Math.max(0, Math.min(1, ((s.near.x - p.x) * dx + (s.near.y - p.y) * dy) / d2)) : 0, d = Math.hypot(s.near.x - p.x - t * dx, s.near.y - p.y - t * dy); if (d < best) { best = d; segmentIndex = i; a = p; b = q; } }); }
      const from = s.near && a && b && far(s.near, b) < far(s.near, a) ? 'end' : 'start';
      if (s.place === 'click' && entity && s.near) {
        // the place that was clicked, as a distance along the line (or along the side of a closed outline) from its start
        const pts = segmentIndex === undefined ? entity.points : [a, b]; let best = Infinity, along = 0, walked = 0;
        for (let i = 1; i < pts.length; i++) { const p = pts[i - 1], q = pts[i], dx = q.x - p.x, dy = q.y - p.y, size = Math.hypot(dx, dy); if (!(size > 0)) continue; const t = Math.max(0, Math.min(1, ((s.near.x - p.x) * dx + (s.near.y - p.y) * dy) / (size * size))), d = Math.hypot(s.near.x - p.x - t * dx, s.near.y - p.y - t * dy); if (d < best) { best = d; along = walked + t * size; } walked += size; }
        return { type: 'notch.add', parameters: { entityId: s.base.id, ...(segmentIndex === undefined ? {} : { segmentIndex }), from: 'start', distance: Math.round(along * 1000) / 1000, ...(s.count > 1 ? { count: s.count } : {}), depth: s.depth } };
      }
      return { type: 'notch.add', parameters: { entityId: s.base.id, ...(segmentIndex === undefined ? {} : { segmentIndex }), from, distance: s.distance, ...(s.count > 1 ? { count: s.count } : {}), depth: s.depth } };
    } },
  { id: 'auxiliary', title: '辅助线', hint: '点一条线，把它设成辅助线（蓝色虚线）或恢复成普通线。裁片的轮廓线不能设成辅助线。', slots: [line('base', '要设置的线')], fields: [choice('auxiliary', '设为', [['yes', '辅助线'], ['no', '普通线']])],
    command: s => ({ type: 'line.setAuxiliary', parameters: { entityIds: [s.base.id], auxiliary: s.auxiliary === 'yes' } }) },
  { id: 'auxDelete', title: '删辅助线', hint: '一次删掉图上全部辅助线，其他线不动。点“画到画布”执行，可以撤销。', slots: [], fields: [],
    command: () => ({ type: 'line.deleteAuxiliary', parameters: {} }) },
  { id: 'seamCorner', title: '缝边角', hint: '在裁片的轮廓线上，靠近要处理的转角点一下。切角、折叠角、双延长角、双投影角：点这个转角的任意一条边。台阶角（偷角）：点缝边线要拐台阶的那条边。反转角、七字角、反转直角、可调反转：点折边那条边。直角、包边延长反转角、延长反转角是两片缝合处的角：再点另一片上缝合的那条边，也点在转角附近；直角和包边延长反转角两片一起改，延长反转角只改先点的这一片。单边直角：点缝边线要越过转角延长 A 的那条边。曲线断差1、2、3：点缝份宽度不同、接近相切相接的两条边中的任一条（例如开衩的边），点在相接处附近，用 A、B。反转翻角：点下摆，两端一起做，只用 A（B 是下摆缝份宽减 A）。开叉半止口、开叉全止口：点开衩那条边，两端一起做，用 A、B、C、D。裁片要先有缝份。',
    slots: [line('base', '轮廓线，点在转角附近', { near: 'near' }), line('partner', '两片的角：另一片上缝合的边，点在转角附近', { near: 'partnerNear', optional: true })],
    fields: [choice('kind', '处理', [['cut', '切角'], ['mitre', '折叠角'], ['fold', '反转角'], ['step', '台阶角（偷角）'], ['sevenStep', '七字角'], ['foldSquare', '反转直角'], ['foldShift', '可调反转'], ['doubleExtend', '双延长角'], ['doubleProject', '双投影角'],
      ['singleSquare', '单边直角'], ['curveStep1', '曲线断差1'], ['curveStep2', '曲线断差2'], ['curveStep3', '曲线断差3'], ['turnUp', '反转翻角'], ['ventHalf', '开叉半止口'], ['ventFull', '开叉全止口'],
      ['square', '直角（两片）'], ['boundFold', '包边延长反转角（两片）'], ['extendFold', '延长反转角（两片）'], ['plain', '普通转角']]),
      size('first', '切角：这条边截掉', 10), size('second', '切角：另一条边截掉', 10), size('drop', '台阶角：台阶高度', 8), size('run', '台阶角：离缝边线', 19), { key: 'shift', label: '可调反转：往外移', kind: 'length', initial: 20, allowZero: true },
      { key: 'a', label: 'A（单边直角、曲线断差、反转翻角、开叉）', kind: 'length', initial: 20, allowZero: true }, { key: 'b', label: 'B（曲线断差、开叉）', kind: 'length', initial: 10, allowZero: true },
      { key: 'c', label: 'C（开叉）', kind: 'length', initial: 0, allowZero: true }, { key: 'd', label: 'D（开叉半止口）', kind: 'length', initial: 0, allowZero: true }],
    command: (s, selection, project) => {
      const entity = find(project, s.base.id), group = (project.groups || []).find(g => g.entityIds.includes(s.base.id));
      // on a closed outline drawn as one polyline the nearest side is the edge that is meant
      let segmentIndex; if (entity && entity.closed && !entity.curve && s.near) { let best = Infinity; entity.points.forEach((a, i) => { const b = entity.points[(i + 1) % entity.points.length], dx = b.x - a.x, dy = b.y - a.y, q = dx * dx + dy * dy, t = q ? Math.max(0, Math.min(1, ((s.near.x - a.x) * dx + (s.near.y - a.y) * dy) / q)) : 0, d = Math.hypot(s.near.x - a.x - t * dx, s.near.y - a.y - t * dy); if (d < best) { best = d; segmentIndex = i; } }); }
      const pair = ['square', 'boundFold', 'extendFold'].includes(s.kind);
      return { type: 'seam.corner', parameters: { groupId: group ? group.id : '不在裁片上', entityId: s.base.id, ...(segmentIndex === undefined ? {} : { segmentIndex }), near: s.near, kind: s.kind,
        ...(s.kind === 'cut' ? { first: s.first, second: s.second } : s.kind === 'step' ? { drop: s.drop, run: s.run } : s.kind === 'foldShift' ? { shift: s.shift } : {}),
        // v67: ET's sizes; 反转翻角 takes A only (ET wants A + B to be the hem's width), the vents all four
        ...(s.kind === 'singleSquare' || s.kind === 'turnUp' ? { a: s.a } : ['curveStep1', 'curveStep2', 'curveStep3'].includes(s.kind) ? { a: s.a, b: s.b } : ['ventHalf', 'ventFull'].includes(s.kind) ? { a: s.a, b: s.b, c: s.c, d: s.d } : {}),
        ...(pair && s.partner ? { partnerEntityId: s.partner.id, partnerNear: s.partnerNear } : {}) } };
    } },
  // v66: the seam tools of ET that v65 left: 生成扩展缝边 and 修改扩展缝边线宽度 in one tool, 延长到环边, 净边延长处理
  { id: 'seamExtension', title: '扩展缝边', hint: '在缝份外面再加一圈扩展缝边（虚线）。点裁片轮廓上的一条边：选“整片”时整片一样宽（宽度填 0 去掉扩展缝边）；选“只改这条边”时只改点的这条边（裁片要先有扩展缝边）。',
    slots: [line('base', '裁片轮廓上的一条边')], fields: [choice('scope', '范围', [['piece', '整片'], ['edge', '只改这条边']]), { key: 'width', label: '扩展宽', kind: 'length', initial: 10, allowZero: true }],
    command: (s, selection, project) => {
      const group = (project.groups || []).find(g => g.entityIds.includes(s.base.id)), groupId = group ? group.id : '不在裁片上';
      return s.scope === 'edge' ? { type: 'seam.extensionEdges', parameters: { groupId, entityIds: [s.base.id], width: s.width } } : { type: 'seam.extension', parameters: { groupId, width: s.width } };
    } },
  { id: 'extendToOutline', title: '延长到环边', hint: '点裁片里要延长的内部线（可以点几条），它们的两端沿自己的方向延长到裁片的净样轮廓；已经在轮廓上的一端不动。', slots: [many('lines', '裁片里的内部线')], fields: [],
    command: (s, selection, project) => { const ids = [...s.lines], group = (project.groups || []).find(g => g.entityIds.includes(ids[0])); return { type: 'piece.extendToOutline', parameters: { groupId: group ? group.id : '不在裁片上', entityIds: ids } }; } },
  { id: 'netExtension', title: '净边延长', hint: '点裁片上的任意一条线：每个转角的两条净样边各自延长到另一条边的缝边线（粉色内部线）。裁片要先有缝份；再做一次会换掉原来的。', slots: [line('base', '裁片上的一条线')], fields: [],
    command: (s, selection, project) => { const group = (project.groups || []).find(g => g.entityIds.includes(s.base.id)); return { type: 'piece.netExtensions', parameters: { groupId: group ? group.id : '不在裁片上' } }; } },
  { id: 'text', title: '文字', hint: '在要写字的地方点一下，这里是文字的左下角。再填内容和字高。', slots: [spot('at', '文字位置', { free: true })], fields: [words('text', '内容'), size('height', '字高', 8), turn],
    command: s => ({ type: 'draw.text', parameters: { text: s.text, at: s.at, height: s.height, ...(s.rotation ? { rotation: s.rotation } : {}) } }) },
  { id: 'textEdit', title: '改文字', hint: '点一行文字，改它的内容、字高或旋转角度。', slots: [line('base', '要改的文字', { accept: 'text' })], fields: [words('text', '内容'), size('height', '字高', 8), turn],
    command: s => ({ type: 'text.edit', parameters: { entityId: s.base.id, text: s.text, height: s.height, rotation: s.rotation } }) },
  { id: 'pieceAlign', title: '裁片对齐', hint: '先点基准裁片上的任意一条线，再点要对齐过去的裁片（可以点几个）。范围按裁片的全部线条算，包括缝份线。', slots: [line('base', '基准裁片'), many('others', '要对齐过去的裁片')],
    fields: [choice('edge', '对齐', [['left', '左边'], ['right', '右边'], ['top', '上边'], ['bottom', '下边'], ['centerX', '左右居中'], ['centerY', '上下居中']])],
    command: (s, selection, project) => ({ type: 'piece.align', parameters: { groupIds: [...new Set([pieceOf(project, s.base.id), ...s.others.map(id => pieceOf(project, id))])], edge: s.edge } }) },
  { id: 'pieceArrange', title: '裁片排列', hint: '把全部没有锁定的裁片排成几行，互不重叠。点“画到画布”执行，可以撤销。', slots: [], fields: [size('gap', '间隔', 20), { key: 'rowWidth', label: '一行最宽（0 为自动）', kind: 'length', initial: 0, allowZero: true }],
    command: s => ({ type: 'piece.arrange', parameters: { gap: s.gap, ...(s.rowWidth > 0 ? { rowWidth: s.rowWidth } : {}) } }) },
  { id: 'pieceExtract', title: '提取裁片', hint: '在结构线围成的一块里面点一下：围着这一点的各条线在交点之间的那一段被复制出来，连成一个裁片，加上布纹线；原来的结构线不动，出头的线也不用先修剪。平移填 0 时裁片留在原处，与结构线重叠；通常把它移到空白的地方（在 ET 里，更新所有缝边会把压在裁片上的散线收进这个裁片）。要一起带进裁片的内部线，点完里面的一点以后接着一条一条点（在 ET 里也是第二步点选），再点一次取消；不带内部线就不用点。',
    slots: [spot('at', '裁片里面的一点', { free: true }), many('inner', '带进裁片的内部线', { optional: true })], fields: [words('name', '裁片名称'), { key: 'seam', label: '缝份（0 为不加）', kind: 'length', initial: 10, allowZero: true }, { key: 'dx', label: '向右平移', kind: 'signed', initial: 0 }, { key: 'dy', label: '向上平移', kind: 'signed', initial: 0 }],
    command: s => ({ type: 'piece.extract', parameters: { name: s.name, at: s.at, ...(s.inner.length ? { innerEntityIds: s.inner } : {}), ...(s.seam > 0 ? { seamWidth: s.seam } : {}), ...(s.dx ? { dx: s.dx } : {}), ...(s.dy ? { dy: s.dy } : {}) } }) },
  { id: 'pieceLock', title: '锁定裁片', hint: '点裁片上的任意一条线，锁定或解锁这个裁片。锁定后它不能被移动、修改或删除，画成灰色。', slots: [line('base', '裁片')], fields: [choice('locked', '设为', [['yes', '锁定'], ['no', '解锁']])],
    command: (s, selection, project) => ({ type: 'piece.setLocked', parameters: { groupIds: [pieceOf(project, s.base.id)], locked: s.locked === 'yes' } }) },
  // ---- what a piece is cut from, its label and its grain line
  { id: 'pieceAttr', title: '裁片属性', hint: '点裁片上的任意一条线，设置它的布料、片数和是否对称。对称的裁片每片再裁一片相反的，实际裁片数是片数的两倍。保存为 ET 文件时一起写入。', fields: [choice('material', '布料', [['面料', '面料'], ['里料', '里料'], ['里布', '里布']]), whole('count', '片数', 1, 1, 99), choice('symmetric', '对称', [['no', '不对称'], ['yes', '对称']])],
    slots: [line('base', '裁片', { prefill: (entity, project) => { const group = (project.groups || []).find(g => g.entityIds.includes(entity.id)), a = group?.attributes || {}; return group ? { material: ['面料', '里料', '里布'].includes(a.material) ? a.material : '面料', count: Number.isInteger(a.count) && a.count >= 1 ? a.count : 1, symmetric: a.symmetric === true ? 'yes' : 'no' } : {}; } })],
    command: (s, selection, project) => ({ type: 'piece.setAttributes', parameters: { groupId: pieceOf(project, s.base.id), material: s.material, count: s.count, symmetric: s.symmetric === 'yes' } }) },
  { id: 'pieceLabel', title: '属性文字', hint: '点裁片上的任意一条线，在裁片上写一行属性文字（名称、布料、片数）。已经有属性文字的裁片，改的是它的字高。之后改名称或属性，这行文字跟着变。', slots: [line('base', '裁片')], fields: [size('height', '字高', 8)],
    command: (s, selection, project) => ({ type: 'piece.label', parameters: { groupId: pieceOf(project, s.base.id), height: s.height } }) },
  { id: 'grainAlign', title: '纱向补正', hint: '点裁片上的任意一条线，把整个裁片转到布纹线垂直或水平（与 ET 的纱向垂直补正、水平补正相同）。', slots: [line('base', '裁片')], fields: [choice('axis', '补正到', [['vertical', '垂直'], ['horizontal', '水平']])],
    command: (s, selection, project) => ({ type: 'piece.alignGrain', parameters: { groupId: pieceOf(project, s.base.id), axis: s.axis } }) },
  { id: 'grainSet', title: '布纹线', hint: '点裁片上的任意一条线，再点布纹线的两个新端点。裁片不动，只改布纹线。', slots: [line('base', '裁片'), spot('from', '布纹线的一端', { free: true }), spot('to', '布纹线的另一端', { free: true })], fields: [],
    command: (s, selection, project) => ({ type: 'piece.setGrain', parameters: { groupId: pieceOf(project, s.base.id), from: s.from, to: s.to } }) },
  // ---- darts
  { id: 'dart', title: '做省', hint: '在边上要做省的位置点一下（省口的中点），再在省尖所在的一侧点一下。省垂直于这条边（ET 的法向省）。结构线和裁片里面的线在省口处剪开，与 ET 相同；裁片的轮廓线不剪。要省山时，按省缝合后倒向哪一端来画：两条省边改成一样长，并画出省中线和倒向记号（ET 的省折）。', slots: [line('base', '做省的边和位置', { station: true, sides: true }), spot('toward', '省尖在哪一侧', { free: true })],
    fields: [...stationFields, size('width', '省量', 20), size('length', '省长', 90), choice('cap', '省山', [['none', '不画'], ['start', '倒向起点'], ['end', '倒向终点']])],
    command: s => ({ type: 'dart.make', parameters: { entityId: s.base.id, ...(s.base.segmentIndex === undefined ? {} : { segmentIndex: s.base.segmentIndex }), at: place(s), width: s.width, length: s.length, toward: s.toward, cap: s.cap } }) },
  { id: 'fishDart', title: '枣弧省', hint: '点省的两个尖（开口在第二个尖那一头）。省量与两个尖的连线垂直，最宽处的位置从第一个尖量起。两条曲线的形状与 ET 的“曲线处理”相同；四条直线是 ET 枣弧省对话框默认的画法。',
    slots: [spot('from', '一个省尖', { free: true }), spot('to', '另一个省尖', { free: true })], fields: [size('width', '最宽处的省量', 20), whole('widest', '最宽处在第一个尖起的百分之几', 50, 1, 99), choice('shape', '画法', [['curves', '两条曲线'], ['lines', '四条直线']]), { key: 'opening', label: '第二个尖的开口（0 为不开）', kind: 'length', initial: 0, allowZero: true }],
    command: s => ({ type: 'dart.fish', parameters: { from: s.from, to: s.to, width: s.width, ...(s.widest && s.widest !== 50 ? { widest: s.widest } : {}), ...(s.shape && s.shape !== 'curves' ? { shape: s.shape } : {}), ...(s.opening > 0 ? { opening: s.opening } : {}) } }) },
  // v64: ET's other dart tools (dart-tools.mjs)
  { id: 'slantDart', title: '斜省', hint: '点做省的边，再点省中线（一头在边上或靠近边，另一头是省尖）。省口以省中线与边的交点为中点，沿边两边各量省量的一半；省中线用完后删掉（ET 省道工具的斜省）。',
    slots: [line('base', '做省的边'), line('centre', '省中线')], fields: [size('width', '省量', 20), choice('cap', '省山', [['none', '不画'], ['start', '倒向起点'], ['end', '倒向终点']])],
    command: s => ({ type: 'dart.slant', parameters: { entityId: s.base.id, centreEntityId: s.centre.id, width: s.width, cap: s.cap } }) },
  { id: 'dartFold', title: '省折线', hint: '点画好的省的两条省边（两条直线，在省尖相交，省口上接着边线），再在省要倒向的一侧点一下。倒向一侧的省边不动，另一条改成一样长；画出省山、省中线和倒向记号（ET 的省折线）。省深度填了时，省边从省口量到这个长度为止。',
    slots: [line('first', '一条省边'), line('second', '另一条省边'), spot('toward', '倒向哪一侧', { free: true })], fields: [{ key: 'depth', label: '省深度（0 为画到省尖）', kind: 'length', initial: 0, allowZero: true }],
    command: s => ({ type: 'dart.fold', parameters: { legIds: [s.first.id, s.second.id], toward: s.toward, ...(s.depth > 0 ? { depth: s.depth } : {}) } }) },
  { id: 'singleDart', title: '单向省', hint: '在已有的一条省边上靠近省尖的那一端点一下，再在新省边要转向的一侧点一下。新省边是这条线绕省尖转开的复制，两条省边另一头之间的距离等于省量（ET 的单向省）。',
    slots: [line('base', '省边，点在省尖那一端附近', { near: 'near' }), spot('toward', '转向哪一侧', { free: true })], fields: [size('width', '省量', 20)],
    command: s => ({ type: 'dart.single', parameters: { entityId: s.base.id, near: s.near, width: s.width, toward: s.toward } }) },
  { id: 'twoPointDart', title: '两点做省', hint: '在边上点省口的第一个点，再点第二个点，然后在省尖所在的一侧点一下。省尖在两点连线的中点，沿连线的垂直方向量省深度（ET 的两点做省）。结构线在两点之间剪开。',
    slots: [line('base', '做省的边，点在省口的第一个点上', { near: 'first' }), spot('second', '省口的第二个点', { free: true }), spot('toward', '省尖在哪一侧', { free: true })], fields: [size('depth', '省深度', 90)],
    command: s => ({ type: 'dart.twoPoints', parameters: { entityId: s.base.id, first: s.first, second: s.second, depth: s.depth, toward: s.toward } }) },
  { id: 'insertDart', title: '插入省', hint: '先用选择工具选中参与的线，再打开本工具：点展开方向的参考线（点在展开方向那一端附近），再点省线（一头在边上，另一头是省尖）。省线绕省尖转开省量，作为新的省边，在参考线的另一侧；那一侧接在省口上的线改接到新省口。参考线也选中时，其余选中的线都沿参考线平移省量（ET 的插入省）。',
    slots: [line('reference', '展开方向参考线，点在展开方向那一端附近', { near: 'near' }), line('dart', '省线')], needsSelection: true, selectionLabel: '参与的线', fields: [size('width', '省量', 20)],
    command: (s, selection) => ({ type: 'dart.insert', parameters: { dartEntityId: s.dart.id, referenceEntityId: s.reference.id, entityIds: [...new Set([...selection])], width: s.width, near: s.near } }) },
  { id: 'openDart', title: '掰开省', hint: '先用选择工具选中参与的线，再打开本工具：点省线（点在省尖那一端附近），点省基线（掰开那一侧接在省口上的边线），再在转动的点上点一下（点在一条线上，这条线在那里断开）。掰开那一侧的线绕这一点转开，省口移动的距离等于省量（ET 的掰开省）。',
    slots: [line('dart', '省线，点在省尖那一端附近', { near: 'near' }), line('base', '省基线'), line('hingeLine', '转动的点（点在线上）', { near: 'hinge' })], needsSelection: true, selectionLabel: '参与的线', fields: [size('width', '省量', 20)],
    command: (s, selection) => ({ type: 'dart.open', parameters: { dartEntityId: s.dart.id, near: s.near, baseEntityId: s.base.id, hingeEntityId: s.hingeLine.id, hinge: s.hinge, entityIds: [...new Set([...selection])], width: s.width } }) },
  { id: 'dartRemove', title: '删省', hint: '点省的任意一条线（省边、省山或枣弧省的一条弧），整个省一起删掉。', slots: [line('base', '省的任意一条线')], fields: [],
    command: s => ({ type: 'dart.remove', parameters: { entityId: s.base.id } }) },
  // ---- cutting a figure into strips and spreading them (v60): the lines selected before the tool is opened are the figure
  { id: 'spreadEqual', title: '等分割展开', hint: '先用选择工具选中这个图形全部的线（还没有做成裁片的），再打开本工具：点固定侧的线，点下面的“展开侧的线”后再点展开侧的线；一侧由几条线接成的，几条都点上。两侧各按长度等分，逐条转开：展开侧每刀张开一个量（负数是收拢），固定侧一般填 0，连着不断开。不动的一条在固定侧第一条线的起点一端（ET 的固定等分割）。',
    slots: [many('fixed', '固定侧的线'), many('spread', '展开侧的线')], needsSelection: true, selectionLabel: '参与切展的线',
    fields: [whole('parts', '等分数', 4, 2, 200), { key: 'spreadAmount', label: '展开侧每刀张开', kind: 'signed', initial: 20 }, { key: 'fixedAmount', label: '固定侧每刀张开', kind: 'signed', initial: 0 }, choice('start', '不动的一条', [['first', '在固定侧起点一端'], ['last', '在另一端']]), choice('fit', '两侧', FITS)],
    command: (s, selection, project) => ({ type: 'spread.equal', parameters: { entityIds: figureOf(selection, s.fixed, s.spread), fixedIds: s.fixed, spreadIds: s.spread, parts: s.parts, spreadAmount: s.spreadAmount, ...(s.fixedAmount ? { fixedAmount: s.fixedAmount } : {}), ...startOf(project, s.fixed, s.start), ...(s.fit === 'none' ? {} : { fit: s.fit }) } }) },
  { id: 'spreadLines', title: '指定分割', hint: '先用选择工具选中这个图形全部的线（分割线也在内），再打开本工具：依次点固定侧的线、展开侧的线和画好的分割线。分割线须从固定侧通到展开侧，出头的部分会去掉。各条分割线用同一个量；各线的量不同时分几次做，或者对助手说（ET 的指定分割）。',
    slots: [many('fixed', '固定侧的线'), many('spread', '展开侧的线'), many('cuts', '分割线')], needsSelection: true, selectionLabel: '参与切展的线',
    fields: [{ key: 'spreadAmount', label: '展开侧每刀张开', kind: 'signed', initial: 20 }, { key: 'fixedAmount', label: '固定侧每刀张开', kind: 'signed', initial: 0 }, choice('start', '不动的一条', [['first', '在固定侧起点一端'], ['last', '在另一端']]), choice('fit', '两侧', FITS)],
    command: (s, selection, project) => ({ type: 'spread.atLines', parameters: { entityIds: figureOf(selection, s.fixed, s.spread, s.cuts), fixedIds: s.fixed, spreadIds: s.spread, cutIds: s.cuts, spreadAmount: s.spreadAmount, ...(s.fixedAmount ? { fixedAmount: s.fixedAmount } : {}), ...startOf(project, s.fixed, s.start), ...(s.fit === 'none' ? {} : { fit: s.fit }) } }) },
  { id: 'spreadBase', title: '多边展开', hint: '先用选择工具选中这个图形全部的线（基线和分割线也在内），再打开本工具：点基线，再按展开的先后点分割线。基线的两端不动，每条分割线两边的部分各绕基线的一端向外转，分割线的远端张开所填的量（ET 的多边分割展开）。',
    slots: [many('base', '基线'), many('cuts', '分割线，按展开的先后点')], needsSelection: true, selectionLabel: '参与切展的线', fields: [size('amount', '每条分割线远端张开', 20)],
    command: (s, selection) => ({ type: 'spread.fromBase', parameters: { entityIds: figureOf(selection, s.base, s.cuts), baseIds: s.base, cutIds: s.cuts, amount: s.amount } }) },
  // ---- v62: putting shapes together (ET's 形状对接及复制, 对称修改, 拼接合并)
  { id: 'dock', title: '形状对接', hint: '先用选择工具选中要对接的线或整个裁片，再打开本工具，依次点四个点：对接前的起点、终点（在要移动的图形上），对接后的起点、终点（要对到的位置）。图形整体移动并转动，起点对起点，方向对方向，大小不变（ET 的形状对接及复制）。',
    slots: [spot('fromStart', '对接前的起点'), spot('fromEnd', '对接前的终点'), spot('toStart', '对接后的起点'), spot('toEnd', '对接后的终点')], needsSelection: true, selectionLabel: '要对接的图元', fields: [{ key: 'copy', label: '保留原件，对接副本', kind: 'check', initial: false }],
    command: (s, selection) => ({ type: 'selection.dock', parameters: { entityIds: selection, fromStart: s.fromStart, fromEnd: s.fromEnd, toStart: s.toStart, toEnd: s.toEnd, copy: s.copy } }) },
  { id: 'symBegin', title: '对称修改', hint: '先用选择工具选中要修改的线（还没有编入裁片的线），再打开本工具点对称轴的两个点。每条线多出一条镜像；之后用节点工具、智能笔或别的工具改原线，镜像跟着变。改好以后用“结束对称”。',
    slots: [spot('axisFrom', '对称轴的起点'), spot('axisTo', '对称轴的终点')], needsSelection: true, selectionLabel: '要对称修改的线', fields: [],
    command: (s, selection) => ({ type: 'symmetry.begin', parameters: { entityIds: selection, axisFrom: s.axisFrom, axisTo: s.axisTo } }) },
  { id: 'symEnd', title: '结束对称', hint: '结束对称修改，镜像不再跟着原线变：可以原线和镜像都留下，只留原线，或者只留镜像（在 ET 里是右键、Shift 加右键、Ctrl 加右键）。', slots: [], fields: [choice('keep', '留下', [['both', '原线和镜像'], ['original', '只留原线'], ['image', '只留镜像']])],
    command: s => ({ type: 'symmetry.end', parameters: { keep: s.keep } }) },
  { id: 'splice', title: '拼接合并', hint: '点两个裁片各一条轮廓边，每条都点在靠近连接端的地方，再点新线的起点放在哪里。第二片按两片在连接处缝在一起的位置转过去，两条边接成一条新线，原来的裁片不动（ET 的拼接合并）。常用来把前后袖窿接起来，看顺不顺、量总长。',
    slots: [line('first', '第一条边，点在连接端附近', { near: 'firstNear' }), line('second', '第二条边，点在连接端附近', { near: 'secondNear' }), spot('at', '新线的起点放在哪里', { free: true })], fields: [],
    command: s => ({ type: 'piece.spliceEdges', parameters: { first: { entityId: s.first.id, near: s.firstNear }, second: { entityId: s.second.id, near: s.secondNear }, at: s.at } }) },
  { id: 'pieceMerge', title: '裁片合并', hint: '点两个裁片各一条轮廓边：先点留在原处的那一片的边，再点要并过来的那一片的边。第二片整体转过去、移过去，两条边对在一起，两片分在这条边的两侧；第二条边删掉，第一条边留作内部线，合成一个裁片，缝份合成一圈（ET 的裁片合并，保形）。两条边不一样长时，第二片上相邻的两条边把端点拉到第一条边的两端。',
    slots: [line('first', '留在原处的裁片的一条边'), line('second', '并过来的裁片的一条边')], fields: [],
    command: s => ({ type: 'piece.merge', parameters: { first: { entityId: s.first.id }, second: { entityId: s.second.id } } }) },
  // ---- marks: buttons, buttonholes, drill holes and bartacks
  { id: 'buttons', title: '扣位', hint: '点第一个扣位和最后一个扣位的位置，中间的等距排开。排在裁片里面的扣位属于这个裁片。', slots: [spot('from', '第一个的位置'), spot('to', '最后一个的位置')], fields: [whole('count', '个数', 5, 2, 100), size('diameter', '扣子直径', 15)],
    command: s => ({ type: 'mark.buttons', parameters: { from: s.from, to: s.to, count: s.count, diameter: s.diameter } }) },
  { id: 'buttonholes', title: '扣眼', hint: '点第一个扣眼和最后一个扣眼的位置，中间的等距排开。“横”是与这一排垂直，“顺”是顺着这一排；“挪动”让扣眼沿自己的方向移一点，正数向这一排前进方向的左边（横）或前方（顺）。', slots: [spot('from', '第一个的位置'), spot('to', '最后一个的位置')],
    fields: [whole('count', '个数', 5, 2, 100), size('length', '扣眼长', 18), choice('direction', '方向', [['across', '横'], ['along', '顺']]), { key: 'shift', label: '挪动', kind: 'signed', initial: 0 }],
    command: s => ({ type: 'mark.buttonholes', parameters: { from: s.from, to: s.to, count: s.count, length: s.length, direction: s.direction, ...(s.shift ? { shift: s.shift } : {}) } }) },
  { id: 'drill', title: '打孔', hint: '在要打孔的位置点一下，例如省尖、袋位。画成一个小圆和一个十字。', slots: [spot('from', '打孔的位置')], fields: [size('diameter', '孔径', 3)],
    command: s => ({ type: 'mark.drill', parameters: { from: s.from, diameter: s.diameter } }) },
  { id: 'bartack', title: '打枣', hint: '点打枣的位置，再点一下它朝哪个方向。画成一条短线，以第一点为中心。', slots: [spot('from', '打枣的位置'), spot('toward', '朝哪个方向', { free: true })], fields: [size('length', '长度', 10)],
    command: s => ({ type: 'mark.bartack', parameters: { from: s.from, to: s.toward, count: 1, length: s.length, direction: 'along' } }) },
  { id: 'markSize', title: '改标记', hint: '点一排扣位、扣眼、打孔或打枣里的任意一条线，改整排的大小（扣位和打孔是直径，扣眼和打枣是长度）。', slots: [line('base', '标记里的任意一条线')], fields: [size('size', '新的直径或长度', 15)],
    command: s => ({ type: 'mark.resize', parameters: { entityId: s.base.id, size: s.size } }) },
  { id: 'markRemove', title: '删标记', hint: '点一排扣位、扣眼、打孔或打枣里的任意一条线，整排一起删掉。', slots: [line('base', '标记里的任意一条线')], fields: [],
    command: s => ({ type: 'mark.remove', parameters: { entityId: s.base.id } }) },
  // ---- measuring: these tools draw nothing; the result is written below and marked on the canvas
  { id: 'measureAngle', title: '量角度', hint: '点选两条线，各点在想量的那一侧。量的是从两线的交点出发、指向两个点击位置的两条边之间的角；曲线按点击处的切线算。', slots: [line('first', '第一条线', { near: 'firstNear' }), line('second', '第二条线', { near: 'secondNear' })], fields: [],
    report: (s, project) => { const r = linesAngle(find(project, s.first.id), s.firstNear, find(project, s.second.id), s.secondNear); return { lines: [r.parallel ? '两条线平行，夹角 0°' : '夹角 ' + r.degrees + '°，另一侧 ' + r.otherSideDegrees + '°'], marks: r.meet ? [{ kind: 'point', at: r.meet }] : [] }; } },
  { id: 'measureThree', title: '三点角度', hint: '依次点三个点：一条边上的点、角的顶点、另一条边上的点。', slots: [spot('a', '第一条边上的点'), spot('vertex', '角的顶点'), spot('b', '第二条边上的点')], fields: [],
    report: (s, project, show) => { const r = threePointAngle(s.a, s.vertex, s.b); return { lines: ['角度 ' + r.degrees + '°', '两条边长 ' + show(r.firstArmMm) + ' 和 ' + show(r.secondArmMm)], marks: [{ kind: 'path', points: [s.a, s.vertex, s.b] }] }; } },
  { id: 'measureOn', title: '线上两点', hint: '点一条线，再在这条线上点两个位置，量它们之间沿线的长度。', slots: [line('base', '线'), spot('p1', '线上第一点'), spot('p2', '线上第二点')], fields: [],
    report: (s, project, show) => { const r = alongBetween(find(project, s.base.id), s.p1, s.p2); return { lines: ['沿线 ' + show(r.alongMm) + (r.otherWayMm !== undefined ? '（从另一边绕过去 ' + show(r.otherWayMm) + '）' : '') + '，直线距离 ' + show(r.straightMm), '两点离线的起点 ' + show(r.firstFromStartMm) + ' 和 ' + show(r.secondFromStartMm) + '，线长 ' + show(r.lineLengthMm)], marks: r.points.map(at => ({ kind: 'point', at })) }; } },
  { id: 'measureSum', title: '综合测量', hint: '点第一组线，可以点多条，再点一次就取消。要比较两组，点下面的“第二组线”，再点第二组。显示每组的总长和两组相差多少。', slots: [many('first', '第一组线'), many('second', '第二组线', { optional: true })], fields: [],
    report: (s, project, show) => { const r = compareGroups(s.first.map(id => find(project, id)), s.second.map(id => find(project, id)));
      return { lines: ['第一组 ' + r.first.length + ' 条，总长 ' + show(r.firstTotalMm), ...(r.second.length ? ['第二组 ' + r.second.length + ' 条，总长 ' + show(r.secondTotalMm), '第一组比第二组' + (r.differenceMm >= 0 ? '长 ' : '短 ') + show(Math.abs(r.differenceMm))] : [])], marks: [] }; } },
  { id: 'tape', title: '皮尺', hint: '在线上靠近量起的一端点一下。沿线每隔一段标出从这一端量起的长度。', slots: [line('base', '线和量起的一端', { end: true })], fields: [choice('end', '量起端', ENDS), size('step', '刻度间隔', 10)],
    report: (s, project, show) => { const r = tapeMarks(find(project, s.base.id), s.end, s.step); return { lines: ['线长 ' + show(r.lineLengthMm) + '，' + r.marks.length + ' 个刻度'], marks: r.marks.map(m => ({ kind: 'tick', at: m.point, normal: m.normal, label: show(m.distanceMm, false) })) }; } },
];

/** What the preview says about a result, in the panel's unit. */
export function describe(summary, show) {
  const parts = [];
  if (summary.lengthMm !== undefined) parts.push('长 ' + show(summary.lengthMm));
  if (summary.count > 1) parts.push(summary.count + ' 条');
  if (summary.maxDeviationMm) parts.push('与等距线相差不超过 ' + summary.maxDeviationMm + ' mm');
  if (summary.partLengthMm !== undefined) parts.push('每份 ' + show(summary.partLengthMm));
  if (summary.point) parts.push('交点 (' + show(summary.point.x, false) + ', ' + show(summary.point.y) + ')');
  if (summary.fromStartMm !== undefined) parts.push('位置距起点 ' + show(summary.fromStartMm));
  if (summary.setbackMm !== undefined) parts.push('切点离交点 ' + show(summary.setbackMm) + '，弧长 ' + show(summary.arcLengthMm));
  else if (summary.operation === 'line.fillet') parts.push(({ arc: '圆弧', curve: '曲线圆角', chamfer: '切角' })[summary.kind] + '：两条线在离转角 ' + summary.cutsMm.map(v => show(v)).join(' 和 ') + ' 处切开');
  if (summary.operation === 'curve.moveKeepLength') parts.push('其余 ' + summary.moved + ' 个曲线点跟着移动（最多 ' + show(summary.largestFollowMm) + '），曲线长度不变');
  if (summary.operation === 'curve.turnEnd') parts.push('“' + summary.name + '”的' + (summary.end === 'start' ? '起点' : '终点') + '方向转 ' + summary.turnDeg + '°（端部方向 ' + summary.directionBeforeDeg + '° → ' + summary.directionAfterDeg + '°），两端不动');
  if (summary.operation === 'curve.smoothCorner') parts.push('接起来以后接点处的折角 ' + summary.bendBeforeDeg + '° → ' + summary.bendAfterDeg + '°，两条线合长 ' + show(summary.joinedLengthMm));
  if (summary.lengthsMm && summary.corner) parts.push('两条线长 ' + summary.lengthsMm.map(v => show(v)).join(' 和 '));
  if (summary.beforeMm !== undefined) parts.push('线长 ' + show(summary.beforeMm) + ' → ' + show(summary.afterMm));
  if (summary.operation === 'line.setLengthAlong') parts.push('“' + summary.name + '”的' + (summary.end === 'start' ? '起点' : '终点') + '沿' + ({ horizontal: '水平', vertical: '垂直', perpendicular: '与线垂直的' })[summary.direction] + '方向移动 ' + show(summary.movedMm));
  if (summary.operation === 'line.correctEnd') parts.push('“' + summary.name + '”的' + (summary.end === 'start' ? '起点' : '终点') + (summary.action === 'cut' ? '剪短 ' : '延长 ') + show(summary.movedMm) + '，到“' + summary.boundary + '”' + (summary.boundaryExtended ? '的延长线上（修正线够不着）' : '上'));
  if (summary.operation === 'line.correctEnds') parts.push('“' + summary.name + '”的两端修到“' + summary.corrections[0].boundary + '”和“' + summary.corrections[1].boundary + '”上');
  if (summary.operation === 'line.setLength' && summary.curve) parts.push(summary.action === 'cut' ? '曲线按长度截短' : '顺着端部的方向加一个曲线点');
  if (summary.operation === 'curve.setPointCount') parts.push('曲线点改成等距排开（原来 ' + summary.before + ' 个）');
  if (summary.operation === 'curve.reducePoints') parts.push(summary.curves.length + ' 条曲线减掉 ' + summary.removed + ' 个曲线点' + (summary.curves.length === 1 ? '，还剩 ' + summary.curves[0].points + ' 个' : ''));
  if (summary.operation === 'curve.movePoints') parts.push(summary.moved + ' 个曲线点一起移动');
  if (summary.operation === 'curve.editLocal') parts.push('只改两个固定点之间的一段；为了定住两边补了 ' + summary.addedPoints + ' 个曲线点，固定点之外变动 ' + show(summary.outsideChangeMm));
  if (summary.operation === 'selection.mirrorAxis') parts.push(summary.entities + ' 个图元' + (summary.copy ? '的镜像副本' : '翻到另一侧'));
  if (summary.operation === 'selection.alignAxis') parts.push(summary.entities + ' 个图元转动 ' + Math.abs(summary.degrees) + '°，参考线变成' + (summary.axis === 'vertical' ? '垂直' : '水平'));
  if (summary.operation === 'draw.rungs') parts.push((summary.count - 1) + ' 条间隔线');
  if (summary.operation === 'notch.add') parts.push(summary.count + ' 个刀口，离线的起点 ' + show(summary.fromStartMm) + '，线长 ' + show(summary.lineLengthMm) + (summary.onSeamLine ? '，从缝边线向里切' : '，画在这条线上'));
  if (summary.operation === 'line.setAuxiliary') parts.push(summary.lines + ' 条线' + (summary.auxiliary ? '设成辅助线' : '恢复成普通线'));
  if (summary.operation === 'line.deleteAuxiliary') parts.push('删掉 ' + summary.lines + ' 条辅助线');
  if (summary.operation === 'draw.text') parts.push('写一行文字');
  if (summary.operation === 'text.edit') parts.push('文字改成“' + summary.text + '”，字高 ' + show(summary.heightMm) + (summary.rotation ? '，旋转 ' + summary.rotation + '°' : ''));
  if (summary.operation === 'piece.align') parts.push(summary.moved + ' 个裁片移到与“' + summary.base + '”对齐');
  if (summary.operation === 'piece.arrange') parts.push(summary.pieces + ' 个裁片排成 ' + summary.rows + ' 行，间隔 ' + show(summary.gapMm));
  if (summary.operation === 'piece.extract') parts.push('取出裁片“' + summary.name + '”：' + summary.edges + ' 条边，取自 ' + summary.fromLines.join('、') + (summary.seamWidthMm ? '，缝份 ' + show(summary.seamWidthMm) : ''));
  if (summary.operation === 'spread.equal' || summary.operation === 'spread.atLines') parts.push('切成 ' + summary.strips + ' 条展开：' + summary.cuts.map(cut => cut.name + ' 展开侧 ' + show(cut.spreadOpeningMm) + (cut.fixedOpeningMm ? '、固定侧 ' + show(cut.fixedOpeningMm) : '')).slice(0, 6).join('；') + (summary.cuts.length > 6 ? ' 等' : '') + '。' + summary.linesBefore + ' 条线换成 ' + summary.linesAfter + ' 条'
    + summary.curves.map(curve => '；' + (curve.side === 'fixed' ? '固定侧' : '展开侧') + '曲线（' + curve.fromLines.join('、') + '）长 ' + show(curve.lengthMm) + '，原来 ' + show(curve.lengthBeforeMm)).join('') + (summary.cuts.some(cut => cut.cutOffMm) ? '；分割线出头的部分已去掉' : ''));
  if (summary.operation === 'spread.fromBase') parts.push('基线两端不动，切成 ' + summary.strips + ' 条向两边展开：' + summary.cuts.map(cut => cut.name + ' 远端张开 ' + show(cut.farOpeningMm)).join('；') + '。基线在分割处留 ' + show(Math.max(...summary.cuts.map(cut => cut.baseGapMm))) + ' 以内的缝；' + summary.linesBefore + ' 条线换成 ' + summary.linesAfter + ' 条');
  if (summary.operation === 'piece.addMembers') parts.push('加入裁片 ' + summary.added + ' 个');
  if (summary.operation === 'piece.removeMembers') parts.push('移出裁片 ' + summary.removed + ' 个');
  if (summary.operation === 'piece.setLocked') parts.push(summary.pieces + ' 个裁片' + (summary.locked ? '锁定' : '解锁'));
  if (summary.operation === 'piece.setAttributes') parts.push('“' + summary.name + '”：' + summary.material + '，' + summary.count + ' 片' + (summary.symmetric ? '，对称（共裁 ' + summary.count * 2 + ' 片）' : ''));
  if (summary.operation === 'piece.label') parts.push((summary.updated ? '属性文字改成字高 ' : '写上属性文字“' + summary.text + '”，字高 ') + show(summary.heightMm));
  if (summary.operation === 'piece.alignGrain') parts.push('裁片转动 ' + Math.abs(summary.degrees) + '°，布纹线变成' + (summary.axis === 'vertical' ? '垂直' : '水平'));
  if (summary.operation === 'piece.setGrain') parts.push('布纹线长 ' + show(summary.lengthMm));
  if (summary.operation === 'dart.make') parts.push('省量 ' + show(summary.widthMm) + '，省长 ' + show(summary.lengthMm) + '，省角 ' + summary.angleDegrees + '°' + (summary.capHeightMm !== undefined ? '，省山高 ' + show(summary.capHeightMm) : '') + (summary.piece ? '，属于裁片“' + summary.piece + '”' : ''));
  if (summary.operation === 'dart.fish') parts.push('枣弧省长 ' + show(summary.lengthMm) + '，最宽 ' + show(summary.widthMm) + (summary.shape === 'lines' ? '，四条直线' : '') + (summary.openingMm ? '，开口 ' + show(summary.openingMm) : '') + (summary.piece ? '，属于裁片“' + summary.piece + '”' : ''));
  if (summary.operation === 'dart.make' && summary.edgeCut) parts.push('边线在省口处剪开');
  if (summary.operation === 'dart.slant') parts.push('省量 ' + show(summary.widthMm) + '，省长 ' + show(summary.lengthMm) + '，省中线“' + summary.removedCentre + '”用完删掉' + (summary.capHeightMm !== undefined ? '，省山高 ' + show(summary.capHeightMm) : '') + (summary.edgeCut ? '，边线在省口处剪开' : ''));
  if (summary.operation === 'dart.fold') parts.push('倒向“' + summary.foldedTo + '”一侧，省山高 ' + show(summary.capHeightMm) + (summary.otherMouthMovedMm ? '，另一条省边改成一样长（省口移动 ' + show(summary.otherMouthMovedMm) + '）' : '') + (summary.depthMm ? '，省深度 ' + show(summary.depthMm) : ''));
  if (summary.operation === 'dart.single') parts.push('新省边绕省尖转开 ' + summary.angleDegrees + '°，省量 ' + show(summary.widthMm));
  if (summary.operation === 'dart.twoPoints') parts.push('省口宽 ' + show(summary.widthMm) + '，省深度 ' + show(summary.depthMm) + (summary.edgeCut ? '，边线在两点之间剪开' : ''));
  if (summary.operation === 'dart.insert') parts.push('新省边转开 ' + summary.angleDegrees + '°，接上“' + summary.joined.join('、') + '”' + (summary.shiftMm ? '，其余 ' + summary.shifted.length + ' 条线平移 ' + show(summary.shiftMm) : ''));
  if (summary.operation === 'dart.open') parts.push('绕转动的点转开 ' + summary.angleDegrees + '°，转动 ' + summary.moved.length + ' 条线' + (summary.split ? '，“' + summary.split.line + '”在转动的点断开' : ''));
  if (summary.operation === 'dart.remove') parts.push('删掉这个省的 ' + summary.lines + ' 条线' + (summary.edgeRestored ? '，边线“' + summary.edgeRestored + '”恢复原样' : ''));
  const markName = { button: '扣位', buttonhole: '扣眼', drill: '打孔', bartack: '打枣' }[summary.kind];
  if (markName && summary.first) parts.push(summary.count + ' 个' + markName + (summary.count > 1 ? '，间距 ' + show(summary.spacingMm) : '') + (summary.piece ? '，属于裁片“' + summary.piece + '”' : '，不在裁片里面'));
  if (summary.operation === 'mark.resize') parts.push(summary.count + ' 个' + markName + '改成 ' + show(summary.sizeMm));
  if (summary.operation === 'mark.remove') parts.push('删掉 ' + summary.count + ' 个' + markName);
  if (summary.operation === 'seam.corner') parts.push(({ cut: '切角', step: '台阶角', fold: '反转角', mitre: '折叠角', sevenStep: '七字角', foldSquare: '反转直角', foldShift: '可调反转', doubleExtend: '双延长角', doubleProject: '双投影角', square: '直角', boundFold: '包边延长反转角', extendFold: '延长反转角', singleSquare: '单边直角', curveStep1: '曲线断差1', curveStep2: '曲线断差2', curveStep3: '曲线断差3', turnUp: '反转翻角', ventHalf: '开叉半止口', ventFull: '开叉全止口', plain: '恢复普通转角' })[summary.kind] + '，' + summary.cornersChanged + ' 个转角；这个裁片现在有 ' + summary.treatedCorners + ' 个转角做了角处理' + (summary.piecesChanged > 1 ? '，另一片也改了' : ''));
  if (summary.operation === 'seam.extension') parts.push(summary.removed ? '去掉扩展缝边' : '扩展缝边离缝边线 ' + show(summary.widthMm));
  if (summary.operation === 'seam.extensionEdges') parts.push(summary.edgesChanged + ' 条边的扩展缝边改成离缝边线 ' + show(summary.widthMm));
  if (summary.operation === 'piece.extendToOutline') parts.push(summary.lines.length + ' 条线延长到轮廓，共延长 ' + summary.lines.reduce((n, l) => n + l.ends.length, 0) + ' 个线端');
  if (summary.operation === 'piece.netExtensions') parts.push(summary.lines + ' 条净边延长线' + (summary.replaced ? '，换掉原来的 ' + summary.replaced + ' 条' : ''));
  if (summary.onExtension) parts.push('垂足在目标线的延长线上');
  if (summary.possibleLines > 1) parts.push('共有 ' + summary.possibleLines + ' 条切线，已取切点离点击处近的一条');
  if (summary.ends) parts.push('移动 ' + summary.ends.length + ' 个线端' + (summary.ends.length === 1 ? '，线长 ' + show(summary.ends[0].lengthMm) : ''));
  if (typeof summary.points === 'number') parts.push('共 ' + summary.points + ' 个曲线点');
  if (summary.shapeChangeMm !== undefined) parts.push('曲线形状最多变动 ' + show(summary.shapeChangeMm));
  if (summary.swapped) parts.push('两个线长已对调');
  if (summary.solutions > 1) parts.push('共有 ' + summary.solutions + ' 个可选位置，已取离点击处近的一个');
  return parts.join('，');
}

export function createConstructPanel({ commands, host, getProject, getSelection, getTool, setTool, render, notify }) {
  const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'construct.css' }); document.head.append(css);
  let stored = {}; try { stored = JSON.parse(localStorage.getItem(STORE)) || {}; } catch { stored = {}; }
  let unit = ['cm', 'mm', 'inch'].includes(stored.unit) ? stored.unit : 'cm', toolId = CONSTRUCT_TOOLS.some(t => t.id === stored.tool) ? stored.tool : 'parallel', plan = null, report = null, message = '', failed = false, targets = [];
  const scale = () => (unit === 'cm' ? 10 : unit === 'inch' ? 25.4 : 1), unitName = () => (unit === 'inch' ? '英寸' : unit), sized = kind => kind === 'length' || kind === 'signed';
  /** A size in the panel's unit. Inch sizes that fall on a sixty-fourth are written as fractions, the way they are typed. */
  function format(mm) {
    const value = mm / scale();
    if (unit !== 'inch') return String(Math.round(value * 1000) / 1000);
    const parts = Math.round(value * 64); if (Math.abs(value * 64 - parts) > 1e-6) return String(Math.round(value * 10000) / 10000);
    let top = Math.abs(parts) % 64, bottom = 64; const whole = Math.floor(Math.abs(parts) / 64); while (top && top % 2 === 0) { top /= 2; bottom /= 2; }
    return (parts < 0 ? '-' : '') + (top ? (whole ? whole + ' ' : '') + top + '/' + bottom : String(whole));
  }
  /** A typed size: a decimal, a fraction such as 3/8, or a whole number with a fraction such as 1 3/8, 1-3/8 or, as ET writes it, 1'3/8. Null when it is none of these. */
  function parseSize(text) {
    const m = String(text).trim().match(/^(-)?(?:(\d+(?:\.\d+)?|\.\d+)(?:[\s'-]+(\d+)\/(\d+))?|(\d+)\/(\d+))$/); if (!m) return null;
    const sign = m[1] ? -1 : 1;
    if (m[5] !== undefined) return Number(m[6]) ? sign * Number(m[5]) / Number(m[6]) : null;
    if (m[3] !== undefined) return Number(m[4]) ? sign * (Number(m[2]) + Number(m[3]) / Number(m[4])) : null;
    return sign * Number(m[2]);
  }
  const show = (mm, withUnit = true) => format(mm) + (withUnit ? ' ' + unitName() : '');
  // Sizes are kept in millimetres whatever the panel's unit is, so changing the unit changes only how they are written.
  const states = Object.fromEntries(CONSTRUCT_TOOLS.map(tool => [tool.id, { picks: {}, values: Object.fromEntries(tool.fields.map(f => [f.key, f.initial])), active: 0 }]));
  const tool = () => CONSTRUCT_TOOLS.find(t => t.id === toolId), state = () => states[toolId];
  const remember = () => { try { localStorage.setItem(STORE, JSON.stringify({ unit, tool: toolId })); } catch { /* kept for this visit only */ } };

  const panel = Object.assign(document.createElement('section'), { id: 'construct-panel', className: 'construct-panel', hidden: true }); panel.setAttribute('aria-label', '画线工具');
  panel.innerHTML = '<header><strong>画线工具</strong><label class="construct-unit">单位<select id="construct-unit"><option value="cm">cm</option><option value="mm">mm</option><option value="inch">英寸</option></select></label><button id="construct-close" type="button">关闭</button></header>' +
    '<div id="construct-tools" class="construct-tools" role="tablist"></div><p id="construct-hint" class="construct-hint"></p><div id="construct-slots" class="construct-slots"></div><div id="construct-fields" class="construct-fields"></div>' +
    '<p id="construct-status" class="construct-status" role="status"></p><div class="construct-actions"><button id="construct-apply" type="button" class="primary" disabled>画到画布</button><button id="construct-clear" type="button">重新点选</button></div>';
  host.append(panel);
  const $ = id => panel.querySelector('#' + id), active = () => getTool() === 'construct';
  for (const item of CONSTRUCT_TOOLS) { const button = Object.assign(document.createElement('button'), { type: 'button', textContent: item.title, id: 'construct-tool-' + item.id }); button.setAttribute('role', 'tab'); button.onclick = () => choose(item.id); $('construct-tools').append(button); }
  $('construct-unit').value = unit;

  const entityOf = id => getProject().entities.find(e => e.id === id);
  /** Parameters for the command, or the reason they are not complete yet. */
  function collect() {
    const current = tool(), s = state(), values = {};
    for (const slot of current.slots) {
      const pick = s.picks[slot.key];
      if (slot.kind === 'entities') { const ids = (pick?.ids || []).filter(id => entityOf(id)); if (!ids.length && !slot.optional) return { wait: '请点选：' + slot.label }; values[slot.key] = ids; }
      else if (slot.kind === 'entity') { if (!pick || !entityOf(pick.id)) { if (slot.optional) { values[slot.key] = null; continue; } return { wait: '请点选：' + slot.label }; } values[slot.key] = { id: pick.id, ...(pick.segmentIndex === undefined ? {} : { segmentIndex: pick.segmentIndex }) }; if (slot.near && pick.near) values[slot.near] = pick.near; }
      else { if (!pick) { if (slot.optional) { values[slot.key] = null; continue; } return { wait: '请点选：' + slot.label }; } values[slot.key] = pick; }
    }
    for (const field of current.fields) {
      const raw = s.values[field.key];
      if (field.kind === 'choice' || field.kind === 'check') { values[field.key] = raw; continue; }
      if (field.kind === 'text') { const typed = String(raw ?? '').trim(); if (!typed) return { wait: '请填写：' + field.label }; values[field.key] = typed; continue; }
      if (sized(field.kind)) {
        if (!(typeof raw === 'number' && Number.isFinite(raw))) return { wait: '请填写：' + field.label + (unit === 'inch' ? '（可以写 3/8 或 1 3/8）' : '') };
        if (field.kind === 'length' && !(raw > 0 || (field.allowZero && raw === 0))) return { wait: field.label + '须大于 0' };
        values[field.key] = raw; continue;
      }
      const number = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (String(raw).trim() === '' || !Number.isFinite(number)) return { wait: '请填写：' + field.label };
      if (field.kind === 'count') { if (!Number.isInteger(number) || number < field.min || number > field.max) return { wait: field.label + '须是 ' + field.min + ' 到 ' + field.max + ' 的整数' }; values[field.key] = number; }
      else values[field.key] = number;
    }
    if (current.needsSelection) { targets = targets.filter(id => entityOf(id)); if (!targets.length) return { wait: '没有选中图元。请先用选择工具选中，再回到这里。' }; }
    return current.report ? { report: values } : { command: current.command(values, [...targets], getProject()) };
  }
  function update() {
    plan = null; report = null; failed = false; message = '';
    if (!active()) { refresh(); return; }
    const ready = collect();
    if (ready.wait) message = ready.wait;
    else if (ready.report) { try { report = tool().report(ready.report, getProject(), show); message = report.lines.join('\n'); } catch (error) { failed = true; message = error.message; } }
    else try { plan = commands.preview({ schema: 'zhiyi-cad-command/v1', type: ready.command.type, expectedRevision: commands.read().revision, parameters: ready.command.parameters }); message = describe(plan.summary, show) || '可以画到画布。'; }
    catch (error) { failed = true; message = error.message; }
    refresh(); render();
  }
  function refresh() {
    panel.hidden = !active(); if (panel.hidden) return;
    const current = tool(), s = state();
    for (const item of CONSTRUCT_TOOLS) { const button = $('construct-tool-' + item.id); button.classList.toggle('active', item.id === toolId); button.setAttribute('aria-selected', String(item.id === toolId)); }
    $('construct-hint').textContent = current.hint;
    const firstEmpty = current.slots.findIndex(slot => !s.picks[slot.key]); if (!current.slots[s.active] || (firstEmpty >= 0 && s.picks[current.slots[s.active].key] && current.slots[s.active].kind !== 'entities')) s.active = Math.max(0, firstEmpty);
    $('construct-slots').replaceChildren(...current.slots.map((slot, index) => {
      const pick = s.picks[slot.key], several = slot.kind === 'entities', button = Object.assign(document.createElement('button'), { type: 'button', className: 'construct-slot' + (index === s.active && (firstEmpty >= 0 || !pick || several) ? ' active' : '') + (pick ? ' filled' : '') });
      button.dataset.slot = slot.key; button.textContent = (index + 1) + ' · ' + slot.label + '：' + (several ? (pick?.ids.length ? '已点 ' + pick.ids.length + ' 条' : slot.optional ? '可以不点' : '待点选') + (index === s.active ? '，继续点可以再加' : '') : !pick ? (slot.optional ? '可以不点' : '待点选') : slot.kind === 'entity' ? (entityOf(pick.id)?.name || '已删除') : '(' + show(pick.x, false) + ', ' + show(pick.y) + ')');
      // a slot that holds several lines is cleared only when it is clicked while it is already the active one
      button.onclick = () => { if (!several || index === s.active) delete s.picks[slot.key]; s.active = index; update(); };
      return button;
    }));
    if (current.needsSelection) $('construct-slots').prepend(Object.assign(document.createElement('p'), { className: 'construct-targets', textContent: (current.selectionLabel || '要镜像的图元') + '：' + targets.filter(id => entityOf(id)).length + ' 个（打开工具前选中的）' }));
    const fields = $('construct-fields');
    if (fields.dataset.tool !== toolId + unit) {
      fields.dataset.tool = toolId + unit;
      fields.replaceChildren(...current.fields.map(field => {
        const label = document.createElement('label'), value = s.values[field.key]; let input;
        if (field.kind === 'choice') { input = document.createElement('select'); for (const [v, text] of field.options) input.append(Object.assign(document.createElement('option'), { value: v, textContent: text })); input.value = value; }
        else if (field.kind === 'check') { input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(value) }); label.className = 'construct-check'; }
        else if (sized(field.kind)) input = Object.assign(document.createElement('input'), { type: 'text', inputMode: 'decimal', autocomplete: 'off', value: Number.isFinite(value) ? format(value) : '' });
        else if (field.kind === 'text') input = Object.assign(document.createElement('input'), { type: 'text', autocomplete: 'off', maxLength: 200, value: String(value ?? '') });
        else input = Object.assign(document.createElement('input'), { type: 'number', step: 'any', value: String(value) });
        input.id = 'construct-field-' + field.key;
        const suffix = sized(field.kind) ? ' ' + unitName() : field.kind === 'angle' ? ' 度' : '';
        input.oninput = () => {
          if (sized(field.kind)) { const typed = parseSize(input.value); s.values[field.key] = typed === null ? NaN : typed * scale(); }
          else s.values[field.key] = field.kind === 'check' ? input.checked : input.value;
          update();
        };
        input.onkeydown = event => { if (event.key === 'Enter' && plan) { event.preventDefault(); apply(); } };
        label.append(field.kind === 'check' ? input : Object.assign(document.createElement('span'), { textContent: field.label + suffix }), field.kind === 'check' ? Object.assign(document.createElement('span'), { textContent: field.label }) : input);
        return label;
      }));
    } else for (const field of current.fields) {
      const input = $('construct-field-' + field.key), value = s.values[field.key];
      if (field.kind === 'check') input.checked = Boolean(value);
      else if (document.activeElement === input) continue;
      else if (!sized(field.kind)) input.value = String(value);
      else if (Number.isFinite(value)) input.value = format(value);
    }
    const status = $('construct-status'); status.textContent = message; status.dataset.state = failed ? 'error' : plan ? 'ready' : 'wait';
    $('construct-apply').disabled = !plan; $('construct-apply').hidden = Boolean(current.report);
  }
  // Entering a tool starts it afresh: earlier picks are dropped, typed sizes stay.
  function choose(id) { toolId = id; state().picks = {}; state().active = 0; remember(); if (tool().needsSelection && !targets.length) targets = [...getSelection()]; update(); }
  /** A click on the canvas while a drafting tool is active. point is the snapped position, raw the position under the pointer. */
  function pick({ point, raw, entity }) {
    const current = tool(), s = state(), slot = current.slots[s.active]; if (!slot) return;
    if (slot.kind === 'entities') {
      if (!entity || entity.type === 'text') { notify('请点在一条线上：' + slot.label); return; }
      const ids = s.picks[slot.key]?.ids || [], kept = ids.filter(id => id !== entity.id);
      if (kept.length === ids.length) kept.push(entity.id);
      if (kept.length) s.picks[slot.key] = { ids: kept }; else delete s.picks[slot.key];
      update(); return;
    }
    if (slot.kind === 'entity') {
      const wantsText = slot.accept === 'text';
      if (!entity || (entity.type === 'text') !== wantsText) { notify((wantsText ? '请点在一行文字上：' : '请点在一条线上：') + slot.label); return; }
      s.picks[slot.key] = { id: entity.id, near: { x: point.x, y: point.y } };
      // a tool may start its fields from what the clicked object has now
      if (slot.prefill) { Object.assign(s.values, slot.prefill(entity, getProject())); panel.querySelector('#construct-fields').dataset.tool = ''; }
      // the fields start from what the text is now, so only what is typed over changes
      if (wantsText) { s.values.text = entity.text; s.values.height = entity.height; s.values.rotation = entity.rotation || 0; panel.querySelector('#construct-fields').dataset.tool = ''; }
      // on a closed outline drawn as one polyline, a tool may want the side that was clicked: the position is then counted on that side
      let stationLine = entity;
      if (slot.sides && entity.closed && !entity.curve) { let best = Infinity, side = 0; entity.points.forEach((a, i) => { const b = entity.points[(i + 1) % entity.points.length], dx = b.x - a.x, dy = b.y - a.y, q = dx * dx + dy * dy, t = q ? Math.max(0, Math.min(1, ((raw.x - a.x) * dx + (raw.y - a.y) * dy) / q)) : 0, d = Math.hypot(raw.x - a.x - t * dx, raw.y - a.y - t * dy); if (d < best) { best = d; side = i; } }); s.picks[slot.key].segmentIndex = side; stationLine = { type: 'polyline', points: [entity.points[side], entity.points[(side + 1) % entity.points.length]] }; }
      if (slot.station) { const found = nearestStation(stationLine, point), fromStart = found.position <= found.total / 2; s.values.from = fromStart ? 'start' : 'end'; s.values.offset = Math.round((fromStart ? found.position : found.total - found.position) * 100) / 100; panel.querySelector('#construct-fields').dataset.tool = ''; }
      if (slot.end) { const found = nearestStation(entity, raw); s.values.end = found.position <= found.total / 2 ? 'start' : 'end'; panel.querySelector('#construct-fields').dataset.tool = ''; }
    } else s.picks[slot.key] = slot.free ? { x: raw.x, y: raw.y } : { x: point.x, y: point.y };
    const next = current.slots.findIndex(candidate => !s.picks[candidate.key]); s.active = next >= 0 ? next : s.active;
    update();
  }
  function apply() {
    if (!plan) return;
    // The picks are cleared first: applying refreshes the page, and the same picks must not be previewed again.
    const id = plan.id, done = tool().title, picked = state().picks; plan = null; state().picks = {}; state().active = 0;
    try { commands.apply(id); } catch (error) { state().picks = picked; failed = true; message = error.message; refresh(); render(); return; }
    if (tool().needsSelection) targets = [];
    update(); message = done + '已画到画布，可以撤销。'; refresh();
  }
  function draw({ node, overlay, screen, pathData }) {
    if (!active()) return;
    const current = tool(), s = state();
    for (const slot of current.slots) {
      const pick = s.picks[slot.key]; if (!pick) continue;
      if (slot.kind === 'entities') {
        for (const id of pick.ids) { const entity = entityOf(id); if (entity) node('path', { d: pathData(entity.points, entity.closed), fill: 'none', stroke: slot.key === 'second' ? '#b0672a' : '#3a8fb7', 'stroke-width': 4, 'stroke-opacity': .45, 'data-construct-pick': slot.key }, overlay); }
      } else if (slot.kind === 'entity') {
        const entity = entityOf(pick.id); if (!entity) continue;
        if (entity.type === 'text') { const q = screen(entity.points[0]); node('circle', { cx: q.x, cy: q.y, r: 6, fill: 'none', stroke: '#3a8fb7', 'stroke-width': 2, 'data-construct-pick': slot.key }, overlay); continue; }
        node('path', { d: pathData(entity.points, entity.closed), fill: 'none', stroke: '#3a8fb7', 'stroke-width': 4, 'stroke-opacity': .45, 'data-construct-pick': slot.key }, overlay);
        if (slot.points && entity.curve) (nativeFitPoints(entity.curve) || []).forEach((p, index) => { const q = screen(p); node('rect', { x: q.x - 4, y: q.y - 4, width: 8, height: 8, fill: '#fff', stroke: '#3a8fb7', 'stroke-width': 2, 'data-construct-curve-point': index }, overlay); });
        if (slot.station || slot.end) for (const [text, p] of [['起', entity.points[0]], ['终', entity.points.at(-1)]]) { const q = screen(p); node('circle', { cx: q.x, cy: q.y, r: 4, fill: '#fff', stroke: '#3a8fb7', 'stroke-width': 2 }, overlay); node('text', { x: q.x + 7, y: q.y - 7, fill: '#2d6f8f', 'font-size': 12 }, overlay).textContent = text; }
      } else { const q = screen(pick); node('circle', { cx: q.x, cy: q.y, r: slot.free ? 3 : 5, fill: slot.free ? '#d08a2e' : '#fff', stroke: '#d08a2e', 'stroke-width': 2, 'data-construct-pick': slot.key }, overlay); }
    }
    // a measurement: its points, arms and scale marks, drawn over the lines they belong to
    for (const mark of report?.marks || []) {
      if (mark.kind === 'point') { const q = screen(mark.at); node('circle', { cx: q.x, cy: q.y, r: 4, fill: '#fff', stroke: '#b0672a', 'stroke-width': 2, 'data-construct-measure': 'point' }, overlay); }
      else if (mark.kind === 'path') node('path', { d: pathData(mark.points, false), fill: 'none', stroke: '#b0672a', 'stroke-width': 2, 'stroke-dasharray': '5 3', 'data-construct-measure': 'path' }, overlay);
      else if (mark.kind === 'tick') {
        // the mark is a fixed number of pixels long whatever the zoom: its direction is read off the screen
        const q = screen(mark.at), toward = screen({ x: mark.at.x + mark.normal.x, y: mark.at.y + mark.normal.y }), span = Math.hypot(toward.x - q.x, toward.y - q.y) || 1, ux = (toward.x - q.x) / span, uy = (toward.y - q.y) / span;
        node('path', { d: 'M ' + q.x + ' ' + q.y + ' L ' + (q.x + ux * 8) + ' ' + (q.y + uy * 8), fill: 'none', stroke: '#b0672a', 'stroke-width': 1.5, 'data-construct-measure': 'tick' }, overlay);
        node('text', { x: q.x + ux * 12, y: q.y + uy * 12 + 4, fill: '#8a4d1c', 'font-size': 11, 'text-anchor': ux < -.3 ? 'end' : ux > .3 ? 'start' : 'middle', 'data-construct-measure': 'label' }, overlay).textContent = mark.label;
      }
    }
    if (!plan) return;
    for (const change of plan.changes) {
      const entity = change.after;
      // a text is previewed as its own words at its own place; the zoom is read off the screen
      if (entity.type === 'text') { const q = screen(entity.points[0]), up = screen({ x: entity.points[0].x, y: entity.points[0].y + 1 }), zoom = Math.hypot(up.x - q.x, up.y - q.y) || 1;
        node('text', { x: 0, y: 0, fill: '#dc8129', 'font-size': entity.height * zoom, 'font-family': 'Arial,"Microsoft YaHei",sans-serif', transform: 'translate(' + q.x + ' ' + q.y + ') rotate(' + -(entity.rotation || 0) + ')', 'data-construct-preview': 'text' }, overlay).textContent = entity.text; continue; }
      node('path', { d: pathData(entity.points, entity.closed), fill: 'none', stroke: '#dc8129', 'stroke-width': 2.5, 'data-construct-preview': 'true' }, overlay);
    }
    // what the command would delete is shown crossed out in red
    for (const gone of plan.removed || []) { const entity = gone.before; if (!entity || entity.type === 'text') continue; node('path', { d: pathData(entity.points, entity.closed), fill: 'none', stroke: '#c2413a', 'stroke-width': 2.5, 'stroke-dasharray': '6 4', 'data-construct-removal': 'true' }, overlay); }
  }
  $('construct-apply').onclick = apply;
  $('construct-clear').onclick = () => { state().picks = {}; state().active = 0; update(); };
  $('construct-close').onclick = () => setTool('select');
  // The fields are rewritten in the new unit; the sizes themselves do not change: 3 cm is shown as 30 mm or as 1 3/16 inch.
  $('construct-unit').onchange = () => { unit = ['cm', 'mm', 'inch'].includes($('construct-unit').value) ? $('construct-unit').value : 'cm'; remember(); update(); };
  return {
    pick, draw, apply,
    /** After a press on a curve point or a line end: is its new place the next thing wanted? Then dragging and letting go gives it. */
    dragWanted() { if (!active()) return false; const current = tool(), s = state(), slot = current.slots[s.active]; return ['curveMove', 'moveEnd'].includes(current.id) && s.active > 0 && Boolean(slot) && slot.kind === 'point' && !s.picks[slot.key]; },
    /** Called whenever the page refreshes: the drawing or the active tool may have changed. */
    refresh() { if (active()) { if (plan && plan.revision !== commands.read().revision) { update(); return; } } refresh(); },
    begin(id) { if (id && CONSTRUCT_TOOLS.some(t => t.id === id)) toolId = id; targets = [...getSelection()]; const chosen = getProject().entities.filter(e => getSelection().has(e.id) && e.type !== 'text'); setTool('construct');
      const current = tool(), s = state(), slots = current.slots.filter(slot => slot.kind === 'entity' && !slot.station && !slot.end && !slot.near && !slot.accept);
      s.picks = {}; s.active = 0;
      // Lines that are already selected become the tool's lines, in the order they were drawn.
      if (!current.needsSelection && chosen.length && chosen.length <= slots.length) chosen.forEach((entity, index) => { s.picks[slots[index].key] = { id: entity.id }; });
      remember(); update(); },
    /** Points snap to existing geometry; a click that only chooses a side or a line does not. */
    wantsSnap() { const slot = tool().slots[state().active]; return Boolean(slot && (slot.station || (slot.kind === 'point' && !slot.free))); },
    isOpen: () => !panel.hidden, element: panel,
  };
}
