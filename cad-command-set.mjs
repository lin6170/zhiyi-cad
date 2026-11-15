/**
 * Drawing and pattern commands shared by the toolbar, the assistant and any
 * later model service. Each command declares its parameters as a JSON Schema,
 * so one definition drives validation, help text and tool definitions.
 * Commands mutate a staged copy only; the caller validates and commits it.
 * Coordinates are millimetres, x to the right and y upward.
 */
import { bounds, length as entityLength } from './geometry.mjs';
import { refreshCurve } from './curves.mjs';
import { fitClampedSpline } from './fit-spline.mjs';
import { orientChain, contoursForGroup } from './topology.mjs';
import { moveSelection, rotateSelection, mirrorSelection, deleteSelection, duplicateSelection } from './selection.mjs';
import { applyAllowance } from './seams.mjs';
import { seamEdgeDefinitions, edgeKey } from './seam-widths.mjs';
import { draftStraightPants, draftFields, validateDraftInput, DRAFT_COMMAND, DRAFT_SCHEMA } from './pants-draft.mjs';
import { transform } from './geometry.mjs';

export const COMMAND_SET_VERSION = 'zhiyi-command-set/v1';
const LIMIT = 100000;
const number = (minimum, maximum, description) => ({ type: 'number', minimum, maximum, description });
const point = description => ({ type: 'object', description, properties: { x: number(-LIMIT, LIMIT, '横坐标，毫米，向右为正'), y: number(-LIMIT, LIMIT, '纵坐标，毫米，向上为正') }, required: ['x', 'y'], additionalProperties: false });
const idList = (description, minItems = 1) => ({ type: 'array', description, items: { type: 'string', minLength: 1, maxLength: 120 }, minItems, maxItems: 5000 });
const text = (maxLength, description) => ({ type: 'string', minLength: 1, maxLength, description });
const object = (properties, required, description) => ({ type: 'object', description, properties, required, additionalProperties: false });
const layer = { type: 'string', enum: ['outline', 'internal'], description: 'outline 为净样或普通线，internal 为内部线' };

/** Validate a value against the JSON Schema subset used by the command set. */
export function validateInput(schema, value, path = '参数') {
  const fail = message => { throw new Error(path + message); };
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('必须是对象。');
    for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) fail('含未定义的字段“' + key + '”。');
    for (const key of schema.required || []) if (value[key] === undefined) fail('缺少“' + key + '”。');
    for (const [key, child] of Object.entries(schema.properties)) if (value[key] !== undefined) validateInput(child, value[key], path + '.' + key);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('必须是数组。');
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail('的数量须在 ' + (schema.minItems ?? 0) + ' 至 ' + schema.maxItems + ' 之间。');
    value.forEach((item, index) => validateInput(schema.items, item, path + '[' + index + ']'));
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) fail('必须是有限数字。');
    if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) fail('须在 ' + schema.minimum + ' 至 ' + schema.maximum + ' 之间。');
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail('须大于 ' + schema.exclusiveMinimum + '。');
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') fail('必须是文字。');
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) fail('的长度不符合要求。');
    if (schema.enum && !schema.enum.includes(value)) fail('须为 ' + schema.enum.join('、') + ' 之一。');
    if ([...value].some(c => c.codePointAt(0) < 32)) fail('含控制字符。');
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail('必须是布尔值。');
  } else throw new Error('命令定义的参数类型无效。');
  return value;
}

// ---------------------------------------------------------------- helpers
const requireMm = project => { if (project.units !== 'mm') throw new Error('当前工程的单位未确认为毫米，不能执行绘图命令。'); };
const samePoint = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;
function entityOf(project, id) { const entity = project.entities.find(e => e.id === id); if (!entity) throw new Error('找不到图元 ' + id + '。'); return entity; }
function groupOf(project, id) { const group = (project.groups || []).find(g => g.id === id); if (!group) throw new Error('找不到裁片 ' + id + '。'); return group; }
function primaryContour(group) { const contour = contoursForGroup(group).find(c => c.role === 'primary-contour' && c.entityIds.length); if (!contour) throw new Error('裁片“' + group.name + '”没有轮廓定义。'); return contour; }
function addEntity(project, env, entity) { const created = { id: env.makeId(), closed: false, layer: 'outline', ...entity }; project.entities.push(created); return created; }
function assertWholePieces(project, ids) {
  for (const group of project.groups || []) if (group.entityIds.some(id => ids.has(id)) && !group.entityIds.every(id => ids.has(id))) throw new Error('需包含完整裁片“' + group.name + '”，不能只处理其中一部分。');
}
function existingIds(project, list) { const ids = new Set(list); if (ids.size !== list.length) throw new Error('图元列表有重复。'); for (const id of ids) entityOf(project, id); return ids; }
const round = value => Math.round(value * 1000) / 1000;
function chainGap(entities) {
  if (entities.length === 1) return entities[0].closed ? 0 : Infinity;
  const end = (item, last) => { const pts = item.entity.curve?.controlPoints || item.entity.points; return pts[(item.reversed !== last) ? pts.length - 1 : 0]; };
  const oriented = orientChain(entities); let gap = 0;
  oriented.forEach((item, i) => { const next = oriented[(i + 1) % oriented.length]; gap = Math.max(gap, Math.hypot(end(item, true).x - end(next, false).x, end(item, true).y - end(next, false).y)); });
  return gap;
}
/** Put contour lines in order around the outline: start with the first, then keep taking the line whose end is nearest. */
function orderChain(entities) {
  if (entities.length < 3) return entities;
  const ends = e => { const pts = e.curve?.controlPoints || e.points; return [pts[0], pts.at(-1)]; };
  const rest = entities.slice(1), ordered = [entities[0]]; let tip = ends(entities[0])[1];
  while (rest.length) {
    let best = 0, bestGap = Infinity, flip = false;
    rest.forEach((e, i) => { const [a, b] = ends(e), da = Math.hypot(a.x - tip.x, a.y - tip.y), db = Math.hypot(b.x - tip.x, b.y - tip.y); if (Math.min(da, db) < bestGap) { bestGap = Math.min(da, db); best = i; flip = db < da; } });
    const [next] = rest.splice(best, 1), [a, b] = ends(next); tip = flip ? a : b; ordered.push(next);
  }
  return ordered;
}
function defaultGrain(project, ids) {
  const box = bounds(project.entities.filter(e => ids.includes(e.id))), half = Math.max(5, Math.min(150, box.height / 4)), x = (box.minX + box.maxX) / 2, y = (box.minY + box.maxY) / 2;
  return [{ x, y: y + half }, { x, y: y - half }];
}

// ---------------------------------------------------------------- parametric draft update
function draftRecord(project, draftId) {
  const drafts = project.metadata?.parametricDrafts || [];
  if (!drafts.length) throw new Error('画布上没有由尺寸生成的纸样。');
  const record = draftId ? drafts.find(d => d.id === draftId) : drafts.at(-1);
  if (!record) throw new Error('找不到指定的尺寸纸样。');
  if (record.schema !== DRAFT_SCHEMA) throw new Error('此纸样的生成规则版本不受支持。');
  return record;
}
const closeTo = (a, b, dx, dy) => Math.abs(a.x - b.x - dx) < 1e-6 && Math.abs(a.y - b.y - dy) < 1e-6;
/** The seam allowance whose base is exactly the primary contour of a piece. */
function seamOf(project, group) {
  const contour = contoursForGroup(group).find(c => c.role === 'primary-contour');
  return contour ? (project.seamAllowances || []).find(r => r.baseEntityIds.length === contour.entityIds.length && r.baseEntityIds.every(id => contour.entityIds.includes(id))) || null : null;
}
/** True when a generated draft still equals its recipe, apart from one translation per piece. Seam lines are compared through their settings. */
function draftUntouched(project, record, baseline) {
  if (record.groupIds.length !== baseline.groups.length) return false;
  const byId = new Map(project.entities.map(e => [e.id, e])), baseById = new Map(baseline.entities.map(e => [e.id, e]));
  const own = (map, group) => group.entityIds.map(id => map.get(id)).filter(e => e && !e.derivedFrom);
  for (let g = 0; g < baseline.groups.length; g++) {
    const group = (project.groups || []).find(x => x.id === record.groupIds[g]), base = baseline.groups[g];
    if (!group || group.name !== base.name || group.entityIds.some(id => !byId.has(id))) return false;
    const now = own(byId, group), was = own(baseById, base);
    if (now.length !== was.length) return false;
    const dx = now[0].points[0].x - was[0].points[0].x, dy = now[0].points[0].y - was[0].points[0].y;
    for (let i = 0; i < was.length; i++) {
      const a = now[i], b = was[i];
      if (a.type !== b.type || a.name !== b.name || a.layer !== b.layer || Boolean(a.closed) !== Boolean(b.closed) || a.text !== b.text || a.points.length !== b.points.length || Boolean(a.curve) !== Boolean(b.curve)) return false;
      if (!a.points.every((q, k) => closeTo(q, b.points[k], dx, dy))) return false;
      if (a.curve && (a.curve.controlPoints.length !== b.curve.controlPoints.length || !a.curve.controlPoints.every((q, k) => closeTo(q, b.curve.controlPoints[k], dx, dy)))) return false;
      if (a.type === 'text' && (Math.abs(a.height - b.height) > 1e-6 || Math.abs((a.rotation || 0) - (b.rotation || 0)) > 1e-6 || Boolean(a.mirrorY) !== Boolean(b.mirrorY))) return false;
    }
    const seamNow = seamOf(project, group), seamWas = seamOf(baseline, base), widths = recipe => JSON.stringify((recipe.edgeWidths || []).map(w => w.width));
    if (Boolean(seamNow) !== Boolean(seamWas)) return false;
    if (seamNow && (seamNow.widthMode !== seamWas.widthMode || seamNow.join !== seamWas.join || seamNow.distance !== seamWas.distance || widths(seamNow) !== widths(seamWas))) return false;
  }
  return true;
}
const outlineBox = (entities, withSeam) => bounds(entities.filter(e => e.type !== 'text' && (withSeam || !e.derivedFrom)));
function updateDraft(project, p, env) {
  requireMm(project);
  const record = draftRecord(project, p.draftId), oldGroups = record.groupIds.map(id => (project.groups || []).find(g => g.id === id));
  if (oldGroups.some(g => !g)) throw new Error('这套尺寸纸样的裁片已被删除或拆散，不能按尺寸重算。');
  let serial = 0; const baseline = draftStraightPants(record.input, { makeId: () => 'base-' + (++serial) }).project;
  if (!p.discardManualEdits && !draftUntouched(project, record, baseline)) throw Object.assign(new Error('这套纸样生成后被手工修改过。按尺寸重算会丢弃这些修改；确认要丢弃时请明确说明。'), { code: 'draft-edited' });
  const oldIds = new Set([...record.entityIds, ...oldGroups.flatMap(g => g.entityIds)]);
  for (const recipe of project.seamAllowances || []) if (recipe.baseEntityIds.some(id => oldIds.has(id))) for (const id of recipe.outputIds) oldIds.add(id);
  const linked = JSON.stringify([project.notches || [], project.seamChecks || [], project.gradingPlans || [], project.markerPlans || [], project.plotSettings || null]);
  if ([...oldIds, ...record.groupIds].some(id => linked.includes(JSON.stringify(id)))) throw new Error('这套纸样已有刀口、对缝、放码、排料或出图关联，不能自动按尺寸重算。');
  const input = { measurements: { ...record.input.measurements, ...(p.measurements || {}) }, rules: { ...record.input.rules, ...(p.rules || {}) } };
  const changed = [];
  for (const type of ['measurements', 'rules']) for (const [key, label] of draftFields[type]) if (input[type][key] !== record.input[type][key]) changed.push({ field: key, name: label, before: record.input[type][key], after: input[type][key] });
  if (!changed.length && !p.discardManualEdits) throw new Error('尺寸和规则没有变化。');
  validateDraftInput(input);
  const generated = draftStraightPants(input, { makeId: env.makeId }), entitiesOf = (source, group) => source.entities.filter(e => group.entityIds.includes(e.id));
  // Each regenerated piece keeps the top-left corner of the net outline it replaces.
  // Pieces that stood side by side keep the gap between them, so a wider piece does not run into its neighbour.
  let previousOld = null, previousNew = null;
  generated.project.groups.forEach((group, index) => {
    const oldMembers = entitiesOf(project, oldGroups[index]), members = entitiesOf(generated.project, group);
    const before = outlineBox(oldMembers, false), after = outlineBox(members, false), oldFull = outlineBox(oldMembers, true), full = outlineBox(members, true);
    let dx = before.minX - after.minX; const dy = before.maxY - after.maxY;
    if (previousOld && oldFull.minX >= previousOld.maxX) dx = previousNew.maxX + (oldFull.minX - previousOld.maxX) - full.minX;
    for (const entity of members) transform(entity, q => ({ x: q.x + dx, y: q.y + dy }));
    previousOld = oldFull; previousNew = outlineBox(members, true);
  });
  // The new lines and pieces take the place of the old ones in the drawing order and in the piece list.
  const entityAt = project.entities.findIndex(e => oldIds.has(e.id)), groupAt = project.groups.findIndex(g => record.groupIds.includes(g.id));
  const keptBefore = project.entities.slice(0, entityAt).filter(e => !oldIds.has(e.id)), keptAfter = project.entities.slice(entityAt).filter(e => !oldIds.has(e.id));
  project.entities = [...keptBefore, ...generated.project.entities, ...keptAfter];
  const groupsBefore = project.groups.slice(0, groupAt), groupsAfter = project.groups.slice(groupAt).filter(g => !record.groupIds.includes(g.id));
  project.groups = [...groupsBefore, ...generated.project.groups, ...groupsAfter];
  project.seamAllowances = (project.seamAllowances || []).filter(r => !r.baseEntityIds.some(id => oldIds.has(id))).concat(generated.project.seamAllowances);
  Object.assign(record, { input: generated.input, report: generated.report, entityIds: generated.project.entities.map(e => e.id), groupIds: generated.project.groups.map(g => g.id) });
  return { summary: { operation: 'pattern.updateDraft', draftId: record.id, changed, report: generated.report }, measurements: generated.report.checks, created: record.id };
}
const draftSchema = partial => object(Object.fromEntries(['measurements', 'rules'].map(type => [type, object(Object.fromEntries(draftFields[type].map(([key, label, , min, max, hint, unit]) => [key, number(min, max, label + '，' + (unit === 'percent' ? '百分比' : '毫米') + '。' + hint)])), partial ? [] : draftFields[type].map(f => f[0]), type === 'measurements' ? '人体与长度尺寸，毫米' : '松量、成衣规格和制版系数')])), partial ? [] : ['measurements', 'rules']);

// ---------------------------------------------------------------- the command set
export const commandSet = [
  { type: 'draw.line', title: '画直线', description: '在两点之间画一条直线。',
    input_schema: object({ from: point('起点'), to: point('终点'), name: text(60, '线条名称'), layer }, ['from', 'to']),
    run(project, p, env) {
      requireMm(project); if (samePoint(p.from, p.to)) throw new Error('直线的两个端点不能重合。');
      const e = addEntity(project, env, { name: p.name || '直线', type: 'polyline', layer: p.layer || 'outline', points: [{ ...p.from }, { ...p.to }] });
      return { summary: { operation: 'draw.line', entityId: e.id, lengthMm: round(entityLength(e)) }, created: e.id };
    } },
  { type: 'draw.polyline', title: '画折线', description: '按顺序连接多个点。closed 为 true 时首尾相连成闭合轮廓。',
    input_schema: object({ points: { type: 'array', description: '顶点，按顺序', items: point('顶点'), minItems: 2, maxItems: 500 }, closed: { type: 'boolean', description: '是否闭合' }, name: text(60, '线条名称'), layer }, ['points']),
    run(project, p, env) {
      requireMm(project);
      if (p.points.some((q, i) => samePoint(q, p.points[(i + 1) % p.points.length]) && (p.closed || i < p.points.length - 1))) throw new Error('折线含重合的相邻顶点。');
      if (p.closed && p.points.length < 3) throw new Error('闭合折线至少需要三个顶点。');
      const e = addEntity(project, env, { name: p.name || (p.closed ? '闭合折线' : '折线'), type: 'polyline', closed: Boolean(p.closed), layer: p.layer || 'outline', points: p.points.map(q => ({ ...q })) });
      return { summary: { operation: 'draw.polyline', entityId: e.id, lengthMm: round(entityLength(e)) }, created: e.id };
    } },
  { type: 'draw.rectangle', title: '画矩形', description: '按左下角和宽高画一个闭合矩形。',
    input_schema: object({ x: number(-LIMIT, LIMIT, '左下角横坐标，毫米'), y: number(-LIMIT, LIMIT, '左下角纵坐标，毫米'), width: { type: 'number', exclusiveMinimum: 0, maximum: LIMIT, description: '宽，毫米' }, height: { type: 'number', exclusiveMinimum: 0, maximum: LIMIT, description: '高，毫米' }, name: text(60, '名称') }, ['x', 'y', 'width', 'height']),
    run(project, p, env) {
      requireMm(project);
      const e = addEntity(project, env, { name: p.name || '矩形', type: 'polyline', closed: true, points: [{ x: p.x, y: p.y }, { x: p.x + p.width, y: p.y }, { x: p.x + p.width, y: p.y + p.height }, { x: p.x, y: p.y + p.height }] });
      return { summary: { operation: 'draw.rectangle', entityId: e.id, widthMm: p.width, heightMm: p.height }, created: e.id };
    } },
  { type: 'draw.curve', title: '画曲线', description: '画一条顺次通过各点的光滑曲线，形状与 ET 的曲线一致。',
    input_schema: object({ points: { type: 'array', description: '曲线经过的点，按顺序，3 至 60 个', items: point('经过点'), minItems: 3, maxItems: 60 }, name: text(60, '线条名称'), layer }, ['points']),
    run(project, p, env) {
      requireMm(project);
      let fitted; try { fitted = fitClampedSpline(p.points); } catch (error) { throw new Error('曲线的点无法拟合：' + error.message); }
      const e = refreshCurve(addEntity(project, env, { name: p.name || '曲线', type: 'polyline', layer: p.layer || 'outline', points: [], curve: fitted.curve }));
      return { summary: { operation: 'draw.curve', entityId: e.id, lengthMm: round(entityLength(e)), throughPoints: p.points.length }, created: e.id };
    } },
  { type: 'draw.text', title: '写文字', description: '在指定位置写一行文字，位置为文字左下角。',
    input_schema: object({ text: text(200, '文字内容'), at: point('文字左下角'), height: { type: 'number', exclusiveMinimum: 0, maximum: 1000, description: '字高，毫米，默认 8' }, rotation: number(-360, 360, '逆时针旋转角度') }, ['text', 'at']),
    run(project, p, env) {
      requireMm(project);
      const e = addEntity(project, env, { name: p.text, type: 'text', text: p.text, layer: 'annotation', height: p.height ?? 8, points: [{ ...p.at }], ...(p.rotation ? { rotation: p.rotation } : {}) });
      return { summary: { operation: 'draw.text', entityId: e.id }, created: e.id };
    } },
  { type: 'entity.delete', title: '删除图元', description: '删除指定图元。裁片的线条只能整片一起删除。',
    input_schema: object({ entityIds: idList('要删除的图元') }, ['entityIds']),
    run(project, p) {
      const ids = existingIds(project, p.entityIds); assertWholePieces(project, ids);
      const before = project.entities.length; deleteSelection(project, ids);
      return { summary: { operation: 'entity.delete', removed: before - project.entities.length } };
    } },
  { type: 'entity.rename', title: '重命名图元', description: '修改一个图元的名称。',
    input_schema: object({ entityId: text(120, '图元'), name: text(60, '新名称') }, ['entityId', 'name']),
    run(project, p) { const e = entityOf(project, p.entityId); if (e.name === p.name) throw new Error('名称没有变化。'); e.name = p.name; return { summary: { operation: 'entity.rename', entityId: e.id } }; } },
  { type: 'selection.move', title: '移动', description: '把图元或整个裁片平移。裁片必须包含它的全部图元。',
    input_schema: object({ entityIds: idList('要移动的图元'), dx: number(-LIMIT, LIMIT, '向右的位移，毫米'), dy: number(-LIMIT, LIMIT, '向上的位移，毫米') }, ['entityIds', 'dx', 'dy']),
    run(project, p) {
      requireMm(project); if (!p.dx && !p.dy) throw new Error('位移不能为零。');
      const ids = existingIds(project, p.entityIds); assertWholePieces(project, ids); moveSelection(project, ids, p.dx, p.dy);
      return { summary: { operation: 'selection.move', entities: ids.size, dx: p.dx, dy: p.dy } };
    } },
  { type: 'selection.rotate', title: '旋转', description: '绕所选图元的外框中心逆时针旋转。',
    input_schema: object({ entityIds: idList('要旋转的图元'), degrees: number(-360, 360, '逆时针角度') }, ['entityIds', 'degrees']),
    run(project, p) {
      if (!p.degrees) throw new Error('旋转角度不能为零。');
      const ids = existingIds(project, p.entityIds); assertWholePieces(project, ids); rotateSelection(project, ids, p.degrees);
      return { summary: { operation: 'selection.rotate', entities: ids.size, degrees: p.degrees } };
    } },
  { type: 'selection.mirror', title: '左右镜像', description: '以所选图元外框的竖直中线为轴左右翻转。',
    input_schema: object({ entityIds: idList('要镜像的图元') }, ['entityIds']),
    run(project, p) { const ids = existingIds(project, p.entityIds); assertWholePieces(project, ids); mirrorSelection(project, ids); return { summary: { operation: 'selection.mirror', entities: ids.size } }; } },
  { type: 'piece.create', title: '建立裁片', description: '把首尾相接的线条定义为一个裁片的净样轮廓，可同时带上内部线和文字。未给布纹线时在裁片中心加一条竖直布纹线。',
    input_schema: object({ name: text(60, '裁片名称'), contourEntityIds: idList('轮廓线，首尾相接成闭合；或一条闭合折线'), memberEntityIds: idList('裁片内的其他线条和文字', 0), grain: object({ from: point('布纹线起点'), to: point('布纹线箭头端') }, ['from', 'to'], '布纹线') }, ['name', 'contourEntityIds']),
    run(project, p, env) {
      requireMm(project);
      let contour = [...existingIds(project, p.contourEntityIds)]; const members = [...existingIds(project, p.memberEntityIds || [])];
      if (members.some(id => contour.includes(id))) throw new Error('轮廓线不能同时列为内部成员。');
      const taken = new Set((project.groups || []).flatMap(g => g.entityIds));
      for (const id of [...contour, ...members]) { const e = entityOf(project, id); if (taken.has(id)) throw new Error('“' + e.name + '”已属于其他裁片。'); if (e.derivedFrom || e.notchFrom) throw new Error('“' + e.name + '”是缝份或刀口的派生线，不能编入裁片。'); }
      let edges = contour.map(id => entityOf(project, id));
      if (edges.some(e => e.type === 'text')) throw new Error('轮廓不能包含文字。');
      if (edges.length > 1 && edges.some(e => e.closed)) throw new Error('闭合折线只能单独作为轮廓。');
      edges = orderChain(edges); contour = edges.map(e => e.id);
      const gap = chainGap(edges); if (!(gap <= .1)) throw new Error(gap === Infinity ? '单条轮廓线必须闭合。' : '轮廓没有闭合，端点最大间隙 ' + gap.toFixed(3) + ' mm。');
      const grainPoints = p.grain ? [{ ...p.grain.from }, { ...p.grain.to }] : defaultGrain(project, contour);
      if (samePoint(grainPoints[0], grainPoints[1])) throw new Error('布纹线的两端不能重合。');
      const grain = addEntity(project, env, { name: p.name + ' · 布纹', type: 'polyline', layer: 'grain', points: grainPoints, arrowEnd: true });
      const group = { id: env.makeId(), name: p.name, entityIds: [...contour, ...members, grain.id], contours: [{ role: 'primary-contour', entityIds: contour }], source: { kind: 'command' } };
      project.groups.push(group);
      return { summary: { operation: 'piece.create', groupId: group.id, contourEdges: contour.length, members: members.length, maxGapMm: round(gap) }, created: group.id };
    } },
  { type: 'piece.rename', title: '重命名裁片', description: '修改裁片名称。',
    input_schema: object({ groupId: text(120, '裁片'), name: text(60, '新名称') }, ['groupId', 'name']),
    run(project, p) { const g = groupOf(project, p.groupId); if (g.name === p.name) throw new Error('名称没有变化。'); g.name = p.name; return { summary: { operation: 'piece.rename', groupId: g.id } }; } },
  { type: 'seam.apply', title: '加缝份', description: '给裁片的净样轮廓加缝份。width 是各边的默认宽度，overrides 可单独指定某些边。0 表示该边不加缝份。',
    input_schema: object({ groupId: text(120, '裁片'), width: number(0, 300, '默认缝份宽度，毫米'), overrides: { type: 'array', description: '单独指定宽度的边', maxItems: 500, minItems: 0, items: object({ entityId: text(120, '轮廓线'), segmentIndex: { type: 'integer', minimum: 0, maximum: 10000, description: '闭合折线的第几条边，从 0 起；普通线条不填' }, width: number(0, 300, '该边缝份宽度，毫米') }, ['entityId', 'width']) } }, ['groupId', 'width']),
    run(project, p, env) {
      requireMm(project);
      const group = groupOf(project, p.groupId), ids = primaryContour(group).entityIds, edges = seamEdgeDefinitions(project, ids), widths = new Map(edges.map(edge => [edge.key, p.width]));
      for (const item of p.overrides || []) { const key = edgeKey(item.entityId, item.segmentIndex ?? null); if (!widths.has(key)) throw new Error('指定的边不在这个裁片的轮廓上。'); widths.set(key, item.width); }
      const largest = Math.max(...widths.values()); if (!(largest > 0)) throw new Error('缝份宽度全为 0。要去掉缝份请用删除缝份。');
      const recipe = applyAllowance(project, { name: group.name, entityIds: ids }, { distance: largest, widthMode: 'edges', join: 'miter', miterLimit: 2, edgeWidths: edges.map(edge => ({ entityId: edge.entityId, segmentIndex: edge.segmentIndex, segmentCount: edge.segmentCount, width: widths.get(edge.key) })) }, env.makeId);
      return { summary: { operation: 'seam.apply', groupId: group.id, edges: edges.length, widthsMm: [...new Set(widths.values())].sort((a, b) => a - b) }, created: recipe.id };
    } },
  { type: 'seam.remove', title: '删除缝份', description: '去掉裁片的缝份，净样线保留。',
    input_schema: object({ groupId: text(120, '裁片') }, ['groupId']),
    run(project, p) {
      const group = groupOf(project, p.groupId), recipe = seamOf(project, group);
      if (!recipe) throw new Error('裁片“' + group.name + '”没有缝份。');
      deleteSelection(project, recipe.outputIds); project.seamAllowances = (project.seamAllowances || []).filter(r => r !== recipe);
      return { summary: { operation: 'seam.remove', groupId: group.id } };
    } },
  { type: 'piece.move', title: '移动裁片', description: '把整个裁片连同缝份、文字和内部线一起平移。',
    input_schema: object({ groupId: text(120, '裁片'), dx: number(-LIMIT, LIMIT, '向右的位移，毫米'), dy: number(-LIMIT, LIMIT, '向上的位移，毫米') }, ['groupId', 'dx', 'dy']),
    run(project, p) {
      requireMm(project); if (!p.dx && !p.dy) throw new Error('位移不能为零。');
      const group = groupOf(project, p.groupId); moveSelection(project, new Set(group.entityIds), p.dx, p.dy);
      return { summary: { operation: 'piece.move', groupId: group.id, dx: p.dx, dy: p.dy } };
    } },
  { type: 'piece.rotate', title: '旋转裁片', description: '绕裁片外框中心逆时针旋转整个裁片。',
    input_schema: object({ groupId: text(120, '裁片'), degrees: number(-360, 360, '逆时针角度') }, ['groupId', 'degrees']),
    run(project, p) {
      if (!p.degrees) throw new Error('旋转角度不能为零。');
      const group = groupOf(project, p.groupId); rotateSelection(project, new Set(group.entityIds), p.degrees);
      return { summary: { operation: 'piece.rotate', groupId: group.id, degrees: p.degrees } };
    } },
  { type: 'piece.mirror', title: '裁片左右镜像', description: '以裁片外框的竖直中线为轴翻转整个裁片。',
    input_schema: object({ groupId: text(120, '裁片') }, ['groupId']),
    run(project, p) { const group = groupOf(project, p.groupId); mirrorSelection(project, new Set(group.entityIds)); return { summary: { operation: 'piece.mirror', groupId: group.id } }; } },
  { type: 'piece.duplicate', title: '复制裁片', description: '复制整个裁片连同缝份。未给位移时副本放在原裁片右侧。',
    input_schema: object({ groupId: text(120, '裁片'), dx: number(-LIMIT, LIMIT, '副本向右的位移，毫米'), dy: number(-LIMIT, LIMIT, '副本向上的位移，毫米'), name: text(60, '副本名称') }, ['groupId']),
    run(project, p, env) {
      requireMm(project);
      const group = groupOf(project, p.groupId), ids = new Set(group.entityIds), box = bounds(project.entities.filter(e => ids.has(e.id)));
      const copies = duplicateSelection(project, ids, env.makeId, { offsetX: p.dx ?? (p.dy === undefined ? box.width + 50 : 0), offsetY: p.dy ?? 0 });
      const copy = project.groups.find(g => g.entityIds.length && g.entityIds.every(id => copies.has(id)));
      if (!copy) throw new Error('裁片复制失败。');
      if (p.name) copy.name = p.name;
      return { summary: { operation: 'piece.duplicate', groupId: copy.id, from: group.id, entities: copies.size }, created: copy.id };
    } },
  { type: 'piece.delete', title: '删除裁片', description: '删除整个裁片及其缝份、文字和内部线。',
    input_schema: object({ groupId: text(120, '裁片') }, ['groupId']),
    run(project, p) {
      const group = groupOf(project, p.groupId), before = project.entities.length; deleteSelection(project, new Set(group.entityIds));
      return { summary: { operation: 'piece.delete', groupId: group.id, name: group.name, removed: before - project.entities.length } };
    } },
  { type: DRAFT_COMMAND, title: '按尺寸生成直筒裤', description: '输入人体尺寸和制版规则，从零生成成人基础直筒裤的前后裤片、省、布纹线、定位线和缝份。全部尺寸为毫米。公式是演示规则，未经试衣确认。',
    input_schema: draftSchema(false), external: true },
  { type: 'pattern.updateDraft', title: '按新尺寸重算纸样', description: '修改已生成直筒裤的部分尺寸或规则，整套纸样在原位置重新生成。纸样被手工改过时会拒绝，除非 discardManualEdits 为 true。',
    input_schema: { ...draftSchema(true), properties: { ...draftSchema(true).properties, draftId: text(120, '要重算的纸样，省略时为最近生成的一套'), discardManualEdits: { type: 'boolean', description: '是否丢弃生成后的手工修改' } } },
    run: updateDraft },
];
const byType = new Map(commandSet.map(command => [command.type, command]));
export const findCommand = type => byType.get(type) || null;
/** Tool definitions for a model service. Tool names cannot contain dots. */
export function toolDefinitions() {
  return commandSet.map(command => ({ name: command.type.replace(/\./g, '_'), description: command.title + '。' + command.description, input_schema: command.input_schema }));
}
export const commandFromToolName = name => commandSet.find(command => command.type.replace(/\./g, '_') === name) || null;

/** Compact description of the canvas for a planner: pieces with their contour edges and seam widths, loose lines, drafts. */
export function describeScene(project) {
  const byId = new Map(project.entities.map(e => [e.id, e])), grouped = new Set((project.groups || []).flatMap(g => g.entityIds));
  const drafts = project.metadata?.parametricDrafts || [], box = b => b && { minX: round(b.minX), minY: round(b.minY), maxX: round(b.maxX), maxY: round(b.maxY) };
  const kind = e => e.type === 'text' ? 'text' : e.curve ? 'curve' : e.closed ? 'closed-polyline' : e.points.length === 2 ? 'line' : 'polyline';
  const pieces = (project.groups || []).slice(0, 200).map(group => {
    const members = group.entityIds.map(id => byId.get(id)).filter(Boolean), contourIds = contoursForGroup(group).find(c => c.role === 'primary-contour')?.entityIds || [], recipe = seamOf(project, group);
    return { id: group.id, name: group.name, bbox: box(bounds(members.filter(e => e.type !== 'text' && !e.derivedFrom))),
      contour: contourIds.map(id => byId.get(id)).filter(Boolean).map(e => ({ entityId: e.id, name: e.name, kind: kind(e), lengthMm: round(entityLength(e)), ...(e.closed ? { segments: e.points.length } : {}) })),
      otherMembers: members.filter(e => !e.derivedFrom && !contourIds.includes(e.id)).slice(0, 60).map(e => ({ entityId: e.id, name: e.name, kind: kind(e), layer: e.layer })),
      seam: recipe ? { widthsMm: recipe.widthMode === 'edges' ? [...new Set(recipe.edgeWidths.map(w => w.width))].sort((a, b) => a - b) : [Math.abs(recipe.distance)],
        ...(recipe.widthMode === 'edges' ? { edges: recipe.edgeWidths.map(w => ({ entityId: w.entityId, ...(w.segmentIndex === null || w.segmentIndex === undefined ? {} : { segmentIndex: w.segmentIndex }), widthMm: w.width })) } : {}) } : null,
      draftId: drafts.find(d => d.groupIds.includes(group.id))?.id || null };
  });
  const loose = project.entities.filter(e => !grouped.has(e.id) && !e.derivedFrom).slice(0, 300).map(e => ({ id: e.id, name: e.name, kind: kind(e), layer: e.layer,
    ...(e.type === 'text' ? { text: e.text, at: e.points[0] } : { lengthMm: round(entityLength(e)), from: e.points[0], to: e.points.at(-1) }) }));
  return { units: project.units, name: project.name, entityCount: project.entities.length, pieceCount: (project.groups || []).length, bbox: box(bounds(project.entities)), pieces, looseEntities: loose,
    drafts: drafts.map(d => ({ id: d.id, schema: d.schema, input: d.input, pieceIds: d.groupIds })) };
}
