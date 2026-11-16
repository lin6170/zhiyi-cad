/**
 * Drafting tools on the canvas. A tool collects what its command needs: lines and points
 * picked on the canvas and sizes typed in the panel. The result is shown on the canvas as
 * soon as the parameters are complete and is drawn only when it is applied.
 * Every tool is one command of the catalogue; the panel holds no geometry of its own.
 */
import { nearestStation } from './construct.mjs';
import { nativeFitPoints } from './fit-spline.mjs';

const STORE = 'zhiyi-construct/v1';
const line = (key, label, extra = {}) => ({ key, label, kind: 'entity', ...extra });
const spot = (key, label, extra = {}) => ({ key, label, kind: 'point', ...extra });
const size = (key, label, initial) => ({ key, label, kind: 'length', initial });
const whole = (key, label, initial, min, max) => ({ key, label, kind: 'count', initial, min, max });
const choice = (key, label, options) => ({ key, label, kind: 'choice', options, initial: options[0][0] });
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
  { id: 'fillet', title: '圆角', hint: '点选两条直线，每条都点在靠近要做圆角的那一端（与 ET 相同）。只用于不属于裁片的直线。', slots: [line('first', '第一条直线，点在连接端附近', { near: 'firstNear' }), line('second', '第二条直线，点在连接端附近', { near: 'secondNear' })], fields: [size('radius', '圆角半径', 20)],
    command: s => ({ type: 'line.fillet', parameters: { firstEntityId: s.first.id, secondEntityId: s.second.id, radius: s.radius, firstNear: s.firstNear, secondNear: s.secondNear } }) },
  { id: 'corner', title: '角连接', hint: '点选两条直线，每条都点在靠近要连接的那一端（与 ET 相同），它们会延长或剪短到交点。只用于不属于裁片的直线。', slots: [line('first', '第一条直线，点在连接端附近', { near: 'firstNear' }), line('second', '第二条直线，点在连接端附近', { near: 'secondNear' })], fields: [],
    command: s => ({ type: 'line.cornerJoin', parameters: { firstEntityId: s.first.id, secondEntityId: s.second.id, firstNear: s.firstNear, secondNear: s.secondNear } }) },
  { id: 'length', title: '长度调整', hint: '在直线上靠近要移动的一端点一下。只用于不属于裁片的直线。', slots: [line('base', '直线和要移动的一端', { end: true })], fields: [choice('end', '移动', ENDS), choice('mode', '方式', [['length', '改成'], ['delta', '加减']]), { key: 'value', label: '数值', kind: 'signed', initial: 100 }],
    command: s => ({ type: 'line.setLength', parameters: { entityId: s.base.id, end: s.end, [s.mode]: s.value } }) },
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
  { id: 'moveEnd', title: '端移动', hint: '在线或曲线上靠近要移动的一端点一下，再点新的位置。同一点上的其他线端一起移动，裁片的角不会断开。', slots: [line('base', '线和要移动的一端', { near: 'near' }), spot('to', '新的位置')], fields: [],
    command: (s, selection, project) => { const entity = find(project, s.base.id); return { type: 'line.moveEnd', parameters: { ends: endsAt(project, endPoint(entity, nearerEnd(entity, s.near))), to: s.to } }; } },
  { id: 'align', title: '补正', hint: '先在选择工具里选中要一起转动的图元或裁片，再打开本工具，在参考直线上靠近一端点一下：这一端转到下方（垂直）或左侧（水平）。', slots: [line('reference', '参考直线，点在一端附近', { near: 'near' })], fields: [choice('axis', '补正到', [['vertical', '垂直'], ['horizontal', '水平']])], needsSelection: true,
    command: (s, selection) => ({ type: 'selection.alignAxis', parameters: { entityIds: selection, referenceEntityId: s.reference.id, axis: s.axis, near: s.near } }) },
  { id: 'curveMove', title: '移曲线点', hint: '在曲线上靠近要移动的曲线点点一下，再点新的位置。曲线按新的点重新圆顺。', slots: [line('base', '曲线和要移动的点', { near: 'near', points: true }), spot('to', '新的位置')], fields: [],
    command: (s, selection, project) => {
      const entity = find(project, s.base.id), hit = curvePointNear(entity, s.near);
      if (hit && (hit.index === 0 || hit.index === hit.count - 1)) return { type: 'line.moveEnd', parameters: { ends: endsAt(project, hit.point), to: s.to } };
      return { type: 'curve.movePoint', parameters: { entityId: s.base.id, index: hit ? hit.index : 1, to: s.to } };
    } },
  { id: 'curveAdd', title: '加曲线点', hint: '在曲线上要加点的位置点一下。', slots: [line('base', '曲线和加点的位置', { near: 'near', points: true })], fields: [],
    command: s => ({ type: 'curve.insertPoint', parameters: { entityId: s.base.id, near: s.near } }) },
  { id: 'curveRemove', title: '删曲线点', hint: '在曲线上靠近要删的曲线点点一下。端点不能删。', slots: [line('base', '曲线和要删的点', { near: 'near', points: true })], fields: [],
    command: (s, selection, project) => { const hit = curvePointNear(find(project, s.base.id), s.near); return { type: 'curve.removePoint', parameters: { entityId: s.base.id, index: hit ? hit.index : 1 } }; } },
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
  { id: 'seamCorner', title: '缝边角', hint: '在裁片的轮廓线上，靠近要处理的转角点一下。切角：点这个转角的任意一条边。台阶角：点侧缝那条边。反转角：点折边那条边。裁片要先有缝份。',
    slots: [line('base', '轮廓线，点在转角附近', { near: 'near' })],
    fields: [choice('kind', '处理', [['cut', '切角'], ['step', '台阶角'], ['fold', '反转角'], ['plain', '普通转角']]), size('first', '切角：这条边截掉', 10), size('second', '切角：另一条边截掉', 10), size('drop', '台阶角：台阶高度', 8), size('run', '台阶角：离侧缝缝边线', 19)],
    command: (s, selection, project) => {
      const entity = find(project, s.base.id), group = (project.groups || []).find(g => g.entityIds.includes(s.base.id));
      // on a closed outline drawn as one polyline the nearest side is the edge that is meant
      let segmentIndex; if (entity && entity.closed && !entity.curve && s.near) { let best = Infinity; entity.points.forEach((a, i) => { const b = entity.points[(i + 1) % entity.points.length], dx = b.x - a.x, dy = b.y - a.y, q = dx * dx + dy * dy, t = q ? Math.max(0, Math.min(1, ((s.near.x - a.x) * dx + (s.near.y - a.y) * dy) / q)) : 0, d = Math.hypot(s.near.x - a.x - t * dx, s.near.y - a.y - t * dy); if (d < best) { best = d; segmentIndex = i; } }); }
      return { type: 'seam.corner', parameters: { groupId: group ? group.id : '不在裁片上', entityId: s.base.id, ...(segmentIndex === undefined ? {} : { segmentIndex }), near: s.near, kind: s.kind,
        ...(s.kind === 'cut' ? { first: s.first, second: s.second } : s.kind === 'step' ? { drop: s.drop, run: s.run } : {}) } };
    } },
];

/** What the preview says about a result, in the panel's unit. */
function describe(summary, show) {
  const parts = [];
  if (summary.lengthMm !== undefined) parts.push('长 ' + show(summary.lengthMm));
  if (summary.count > 1) parts.push(summary.count + ' 条');
  if (summary.maxDeviationMm) parts.push('与等距线相差不超过 ' + summary.maxDeviationMm + ' mm');
  if (summary.partLengthMm !== undefined) parts.push('每份 ' + show(summary.partLengthMm));
  if (summary.point) parts.push('交点 (' + show(summary.point.x, false) + ', ' + show(summary.point.y) + ')');
  if (summary.fromStartMm !== undefined) parts.push('位置距起点 ' + show(summary.fromStartMm));
  if (summary.setbackMm !== undefined) parts.push('切点离交点 ' + show(summary.setbackMm) + '，弧长 ' + show(summary.arcLengthMm));
  if (summary.lengthsMm && summary.corner) parts.push('两条线长 ' + summary.lengthsMm.map(v => show(v)).join(' 和 '));
  if (summary.beforeMm !== undefined) parts.push('线长 ' + show(summary.beforeMm) + ' → ' + show(summary.afterMm));
  if (summary.operation === 'selection.mirrorAxis') parts.push(summary.entities + ' 个图元' + (summary.copy ? '的镜像副本' : '翻到另一侧'));
  if (summary.operation === 'selection.alignAxis') parts.push(summary.entities + ' 个图元转动 ' + Math.abs(summary.degrees) + '°，参考线变成' + (summary.axis === 'vertical' ? '垂直' : '水平'));
  if (summary.operation === 'draw.rungs') parts.push((summary.count - 1) + ' 条间隔线');
  if (summary.operation === 'notch.add') parts.push(summary.count + ' 个刀口，离线的起点 ' + show(summary.fromStartMm) + '，线长 ' + show(summary.lineLengthMm) + (summary.onSeamLine ? '，从缝边线向里切' : '，画在这条线上'));
  if (summary.operation === 'line.setAuxiliary') parts.push(summary.lines + ' 条线' + (summary.auxiliary ? '设成辅助线' : '恢复成普通线'));
  if (summary.operation === 'line.deleteAuxiliary') parts.push('删掉 ' + summary.lines + ' 条辅助线');
  if (summary.operation === 'seam.corner') parts.push(({ cut: '切角', step: '台阶角', fold: '反转角', plain: '恢复普通转角' })[summary.kind] + '，' + summary.cornersChanged + ' 个转角；这个裁片现在有 ' + summary.treatedCorners + ' 个转角做了角处理');
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
  let unit = ['cm', 'mm', 'inch'].includes(stored.unit) ? stored.unit : 'cm', toolId = CONSTRUCT_TOOLS.some(t => t.id === stored.tool) ? stored.tool : 'parallel', plan = null, message = '', failed = false, targets = [];
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
      if (slot.kind === 'entity') { if (!pick || !entityOf(pick.id)) return { wait: '请点选：' + slot.label }; values[slot.key] = { id: pick.id }; if (slot.near && pick.near) values[slot.near] = pick.near; }
      else { if (!pick) return { wait: '请点选：' + slot.label }; values[slot.key] = pick; }
    }
    for (const field of current.fields) {
      const raw = s.values[field.key];
      if (field.kind === 'choice' || field.kind === 'check') { values[field.key] = raw; continue; }
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
    return { command: current.command(values, [...targets], getProject()) };
  }
  function update() {
    plan = null; failed = false; message = '';
    if (!active()) { refresh(); return; }
    const ready = collect();
    if (ready.wait) message = ready.wait;
    else try { plan = commands.preview({ schema: 'zhiyi-cad-command/v1', type: ready.command.type, expectedRevision: commands.read().revision, parameters: ready.command.parameters }); message = describe(plan.summary, show) || '可以画到画布。'; }
    catch (error) { failed = true; message = error.message; }
    refresh(); render();
  }
  function refresh() {
    panel.hidden = !active(); if (panel.hidden) return;
    const current = tool(), s = state();
    for (const item of CONSTRUCT_TOOLS) { const button = $('construct-tool-' + item.id); button.classList.toggle('active', item.id === toolId); button.setAttribute('aria-selected', String(item.id === toolId)); }
    $('construct-hint').textContent = current.hint;
    const firstEmpty = current.slots.findIndex(slot => !s.picks[slot.key]); if (!current.slots[s.active] || (firstEmpty >= 0 && s.picks[current.slots[s.active].key])) s.active = Math.max(0, firstEmpty);
    $('construct-slots').replaceChildren(...current.slots.map((slot, index) => {
      const pick = s.picks[slot.key], button = Object.assign(document.createElement('button'), { type: 'button', className: 'construct-slot' + (index === s.active && (firstEmpty >= 0 || !pick) ? ' active' : '') + (pick ? ' filled' : '') });
      button.dataset.slot = slot.key; button.textContent = (index + 1) + ' · ' + slot.label + '：' + (!pick ? '待点选' : slot.kind === 'entity' ? (entityOf(pick.id)?.name || '已删除') : '(' + show(pick.x, false) + ', ' + show(pick.y) + ')');
      button.onclick = () => { delete s.picks[slot.key]; s.active = index; update(); };
      return button;
    }));
    if (current.needsSelection) $('construct-slots').prepend(Object.assign(document.createElement('p'), { className: 'construct-targets', textContent: '要镜像的图元：' + targets.filter(id => entityOf(id)).length + ' 个（打开工具前选中的）' }));
    const fields = $('construct-fields');
    if (fields.dataset.tool !== toolId + unit) {
      fields.dataset.tool = toolId + unit;
      fields.replaceChildren(...current.fields.map(field => {
        const label = document.createElement('label'), value = s.values[field.key]; let input;
        if (field.kind === 'choice') { input = document.createElement('select'); for (const [v, text] of field.options) input.append(Object.assign(document.createElement('option'), { value: v, textContent: text })); input.value = value; }
        else if (field.kind === 'check') { input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(value) }); label.className = 'construct-check'; }
        else if (sized(field.kind)) input = Object.assign(document.createElement('input'), { type: 'text', inputMode: 'decimal', autocomplete: 'off', value: Number.isFinite(value) ? format(value) : '' });
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
    $('construct-apply').disabled = !plan;
  }
  // Entering a tool starts it afresh: earlier picks are dropped, typed sizes stay.
  function choose(id) { toolId = id; state().picks = {}; state().active = 0; remember(); if (tool().needsSelection && !targets.length) targets = [...getSelection()]; update(); }
  /** A click on the canvas while a drafting tool is active. point is the snapped position, raw the position under the pointer. */
  function pick({ point, raw, entity }) {
    const current = tool(), s = state(), slot = current.slots[s.active]; if (!slot) return;
    if (slot.kind === 'entity') {
      if (!entity || entity.type === 'text') { notify('请点在一条线上：' + slot.label); return; }
      s.picks[slot.key] = { id: entity.id, near: { x: point.x, y: point.y } };
      if (slot.station) { const found = nearestStation(entity, point), fromStart = found.position <= found.total / 2; s.values.from = fromStart ? 'start' : 'end'; s.values.offset = Math.round((fromStart ? found.position : found.total - found.position) * 100) / 100; panel.querySelector('#construct-fields').dataset.tool = ''; }
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
      if (slot.kind === 'entity') {
        const entity = entityOf(pick.id); if (!entity) continue;
        node('path', { d: pathData(entity.points, entity.closed), fill: 'none', stroke: '#3a8fb7', 'stroke-width': 4, 'stroke-opacity': .45, 'data-construct-pick': slot.key }, overlay);
        if (slot.points && entity.curve) (nativeFitPoints(entity.curve) || []).forEach((p, index) => { const q = screen(p); node('rect', { x: q.x - 4, y: q.y - 4, width: 8, height: 8, fill: '#fff', stroke: '#3a8fb7', 'stroke-width': 2, 'data-construct-curve-point': index }, overlay); });
        if (slot.station || slot.end) for (const [text, p] of [['起', entity.points[0]], ['终', entity.points.at(-1)]]) { const q = screen(p); node('circle', { cx: q.x, cy: q.y, r: 4, fill: '#fff', stroke: '#3a8fb7', 'stroke-width': 2 }, overlay); node('text', { x: q.x + 7, y: q.y - 7, fill: '#2d6f8f', 'font-size': 12 }, overlay).textContent = text; }
      } else { const q = screen(pick); node('circle', { cx: q.x, cy: q.y, r: slot.free ? 3 : 5, fill: slot.free ? '#d08a2e' : '#fff', stroke: '#d08a2e', 'stroke-width': 2, 'data-construct-pick': slot.key }, overlay); }
    }
    if (!plan) return;
    for (const change of plan.changes) { const entity = change.after; if (entity.type === 'text') continue; node('path', { d: pathData(entity.points, entity.closed), fill: 'none', stroke: '#dc8129', 'stroke-width': 2.5, 'data-construct-preview': 'true' }, overlay); }
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
    /** Called whenever the page refreshes: the drawing or the active tool may have changed. */
    refresh() { if (active()) { if (plan && plan.revision !== commands.read().revision) { update(); return; } } refresh(); },
    begin(id) { if (id && CONSTRUCT_TOOLS.some(t => t.id === id)) toolId = id; targets = [...getSelection()]; const chosen = getProject().entities.filter(e => getSelection().has(e.id) && e.type !== 'text'); setTool('construct');
      const current = tool(), s = state(), slots = current.slots.filter(slot => slot.kind === 'entity' && !slot.station && !slot.end && !slot.near);
      s.picks = {}; s.active = 0;
      // Lines that are already selected become the tool's lines, in the order they were drawn.
      if (!current.needsSelection && chosen.length && chosen.length <= slots.length) chosen.forEach((entity, index) => { s.picks[slots[index].key] = { id: entity.id }; });
      remember(); update(); },
    /** Points snap to existing geometry; a click that only chooses a side or a line does not. */
    wantsSnap() { const slot = tool().slots[state().active]; return Boolean(slot && (slot.station || (slot.kind === 'point' && !slot.free))); },
    isOpen: () => !panel.hidden, element: panel,
  };
}
