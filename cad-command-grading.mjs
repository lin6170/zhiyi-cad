/**
 * Commands for grading by a size table, the way ET does it (v57): the sizes and the base size, the rows of the size table,
 * the rule of a point, taking a rule away, and removing the grading. They work on the one plan of this kind a drawing has;
 * the first of them makes it. With these the assistant can grade a pattern, not only the grading panel.
 */
import { number, point, text, object, requireMm, entityOf, round } from './cad-command-kit.mjs';
import { createTablePlan, applyGradingPlan, normalizeGradingPlan } from './grading.mjs';
import { stationsOf, placeOnLine, ruleDisplacement } from './grading-table.mjs';
import { parseFormula, formulaNames } from './size-formula.mjs';

const REACH_MM = .5, SAME_PLACE_MM = .05;   // how near a given place must be to a point or to the line; when two points count as one place
const formula = description => ({ type: 'string', minLength: 0, maxLength: 300, description });
export const tablePlanOf = project => (project.gradingPlans || []).find(plan => plan.method === 'table') || null;
const need = project => { const plan = tablePlanOf(project); if (!plan) throw new Error('这张图还没有按尺寸表放码的方案，先用“设置号型”建立。'); return plan; };
const open = plan => JSON.parse(JSON.stringify(normalizeGradingPlan(plan)));   // the plan as it can be changed and stored again
const store = (project, env, value, plan) => applyGradingPlan(project, value, env.makeId, plan ? plan.id : null);
export const sizesInOrder = plan => [{ label: plan.baseSize, slot: plan.sizeTable.baseSlot, base: true }, ...plan.sizes].sort((a, b) => a.slot - b.slot);
const axesOf = degrees => { const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), tidy = v => Math.abs(v) < 1e-12 ? 0 : v; return { axisX: [tidy(c), tidy(s)], axisY: [tidy(-s), tidy(c)] }; };
export const angleOf = rule => { const degrees = Math.atan2(rule.axisX[1], rule.axisX[0]) * 180 / Math.PI; return Math.abs(degrees) < 1e-6 ? 0 : round(degrees); };
const sameAxes = (a, b) => Math.hypot(a.axisX[0] - b.axisX[0], a.axisX[1] - b.axisX[1]) < 1e-6 && Math.hypot(a.axisY[0] - b.axisY[0], a.axisY[1] - b.axisY[1]) < 1e-6;
// the nearest place on a line
function footOn(path, q) {
  let best = null;
  for (let i = 1; i < path.length; i++) { const a = path[i - 1], b = path[i], dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy, t = d ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / d)) : 0, at = { x: a.x + t * dx, y: a.y + t * dy }, distance = Math.hypot(q.x - at.x, q.y - at.y); if (!best || distance < best.distance) best = { distance, at }; }
  return best;
}
function checkFormula(textValue, names, which) {
  let tree; try { tree = parseFormula(textValue); } catch (error) { throw new Error(which + '公式“' + textValue + '”读不懂：' + error.message + '。'); }
  for (const name of formulaNames(tree)) if (!names.has(name)) throw new Error(which + '公式“' + textValue + '”用到了尺寸表里没有的“' + name + '”。尺寸表现有：' + ([...names].join('、') || '还没有项目') + '。');
}
/** The line of a rule and where on it a given place lies: one of its points ({ index }) or a place between two of them ({ between }). */
function locate(project, value, entityId, at) {
  const entity = entityOf(project, entityId);
  if (entity.type === 'text' || entity.derivedFrom || entity.notchFrom) throw new Error('放码规则设在纸样自己的线上，不能设在文字、缝份线或刀口上。');
  if (!value.sources.some(source => source.entityId === entity.id)) throw new Error('“' + entity.name + '”还不在放码方案里。');
  const stations = stationsOf(entity), place = placeOnLine(entity, at, REACH_MM);
  if (!place) throw new Error('这个位置不在“' + entity.name + '”上（离它超过 ' + REACH_MM + ' mm）。');
  if (place.index !== undefined) { const last = stations.points.length - 1; return { entity, where: { index: place.index }, at: stations.points[place.index], name: place.index === 0 ? 'start' : place.index === last ? 'end' : 'point' }; }
  if (entity.curve && !stations.fitted) throw new Error('“' + entity.name + '”不是按点画的曲线，只能在它的两端设规则。');
  const foot = footOn(entity.points, at).at, exact = placeOnLine(entity, foot);
  if (!exact) throw new Error('这个位置不在“' + entity.name + '”上。');
  if (exact.index !== undefined) { const last = stations.points.length - 1; return { entity, where: { index: exact.index }, at: stations.points[exact.index], name: exact.index === 0 ? 'start' : exact.index === last ? 'end' : 'point' }; }
  return { entity, where: { between: exact.between, at: foot }, at: foot, name: 'onLine' };
}
const placeOfAnchor = (project, anchor) => { if (anchor.between !== undefined || anchor.at) return anchor.at; const entity = project.entities.find(e => e.id === anchor.entityId), stations = entity && stationsOf(entity); return stations ? stations.points[anchor.index] || null : null; };
// the rule that stands on a place of a line, and the rules of other lines on the same place that say the same (they are changed together)
function ruleAt(project, value, found) {
  const own = value.anchors.find(anchor => anchor.entityId === found.entity.id && !anchor.plain && (found.where.index !== undefined ? anchor.index === found.where.index : anchor.between !== undefined && Math.hypot(anchor.at.x - found.at.x, anchor.at.y - found.at.y) <= REACH_MM));
  const twins = own && own.index !== undefined ? value.anchors.filter(other => { if (other === own || other.plain || other.index === undefined || other.x !== own.x || other.y !== own.y || !sameAxes(other, own)) return false; const there = placeOfAnchor(project, other); return Boolean(there) && Math.hypot(there.x - found.at.x, there.y - found.at.y) <= SAME_PLACE_MM; }) : [];
  return { own, twins };
}
const movesOf = (plan, rule) => plan.sizes.slice().sort((a, b) => a.slot - b.slot).map(size => { const d = ruleDisplacement(plan, size, rule); return { size: size.label, dxMm: round(d.dx), dyMm: round(d.dy) }; });

export const gradingCommands = [
  { type: 'grade.setSizes', title: '设置号型', description: '按尺寸表放码（ET 的做法）的第一步：给出从小到大的全部号型名称，并指出其中的基码。图里还没有这种放码方案时会建立一个，它管整张图；已经有时按新的名单增减号型，尺寸表和规则保留；新加的号型，尺寸表每一项按该项基码的数值和档差顺延出数值，不用再逐项填，个别码要不一样时再用“尺寸表项目”改。之后用“尺寸表项目”填尺寸表，用“放码规则”给点设规则。',
    input_schema: object({ sizes: { type: 'array', description: '全部号型的名称，从小到大，含基码', items: text(50, '号型名称'), minItems: 2, maxItems: 13 }, base: text(50, '基码的名称，必须在名单里') }, ['sizes', 'base']),
    run(project, p, env) {
      requireMm(project);
      const names = p.sizes.map(name => name.trim()); if (names.some(name => !name) || new Set(names).size !== names.length) throw new Error('号型名称不能重复，也不能是空的。');
      const at = names.indexOf(p.base.trim()); if (at < 0) throw new Error('基码“' + p.base + '”不在号型名单里。');
      const existing = tablePlanOf(project), value = existing ? open(existing) : JSON.parse(JSON.stringify(createTablePlan(project, env.makeId))), table = value.sizeTable, baseSlot = table.baseSlot;
      if (baseSlot - at < 0 || baseSlot + names.length - 1 - at > 49) throw new Error('号型太多，排不进号型表。');
      const before = new Map(value.sizes.map(size => [size.slot, size]));
      value.baseSize = names[at];
      value.sizes = names.map((label, i) => ({ label, slot: baseSlot + i - at })).filter(size => size.slot !== baseSlot).map(size => ({ id: before.get(size.slot)?.id || env.makeId(), label: size.label, step: size.slot - baseSlot, slot: size.slot }));
      table.series[table.activeSeries] = names.map((name, i) => ({ slot: baseSlot + i - at, name }));
      const plan = store(project, env, value, existing);
      return { summary: { operation: 'grade.setSizes', created: !existing, sizes: sizesInOrder(plan).map(size => size.label), baseSize: plan.baseSize, measures: plan.sizeTable.rows.length, rules: plan.anchors.filter(anchor => !anchor.plain).length } };
    } },
  { type: 'grade.setMeasure', title: '尺寸表项目', description: '在放码的尺寸表里加一项或改一项，单位厘米。新的一项要给基码的数值 base；step 是每大一个码增加多少（可以是负数，不给就是 0）；个别码不按 step 走时用 values 单独给。已有的项目：只给 values 就只改那几个码；只给 base 时各码一起平移；给 step 时按 base 和 step 重排。放码规则的公式里用项目名称，例如“胸围/4”。',
    input_schema: object({ name: text(50, '项目名称，如 胸围；不能以数字开头，不能带 + - * / ( ) 和空格'), base: number(-100000, 100000, '基码的数值，厘米'), step: number(-1000, 1000, '每大一个码增加多少，厘米'),
      values: { type: 'array', description: '个别号型的数值', minItems: 0, maxItems: 13, items: object({ size: text(50, '号型名称'), value: number(-100000, 100000, '这个号型的数值，厘米') }, ['size', 'value']) } }, ['name']),
    run(project, p, env) {
      requireMm(project);
      const existing = need(project), value = open(existing), table = value.sizeTable, name = p.name.trim(), sizes = sizesInOrder(value);
      let row = table.rows.find(item => item.name === name); const created = !row;
      if (!row) { if (p.base === undefined) throw new Error('尺寸表里还没有“' + name + '”，请给出基码的数值。'); row = { name, values: Array.from({ length: 50 }, (_, slot) => p.base + (slot - table.baseSlot) * (p.step ?? 0)) }; table.rows.push(row); }
      else if (p.step !== undefined) { const base = p.base ?? row.values[table.baseSlot]; row.values = row.values.map((_, slot) => base + (slot - table.baseSlot) * p.step); }
      else if (p.base !== undefined) { const shift = p.base - row.values[table.baseSlot]; row.values = row.values.map(v => v + shift); }
      else if (!(p.values || []).length) throw new Error('请给出要改的数值。');
      for (const item of p.values || []) { const size = sizes.find(s => s.label === item.size.trim()); if (!size) throw new Error('号型里没有“' + item.size + '”。现有：' + sizes.map(s => s.label).join('、') + '。'); row.values[size.slot] = item.value; }
      const plan = store(project, env, value, existing), saved = plan.sizeTable.rows.find(item => item.name === name);
      return { summary: { operation: 'grade.setMeasure', name, created, valuesCm: sizesInOrder(plan).map(size => ({ size: size.label, value: round(saved.values[size.slot]) })) } };
    } },
  { type: 'grade.removeMeasure', title: '删除尺寸表项目', description: '从放码的尺寸表里去掉一项。还有放码规则的公式用到它时不能去掉。',
    input_schema: object({ name: text(50, '项目名称') }, ['name']),
    run(project, p, env) {
      requireMm(project);
      const existing = need(project), value = open(existing), name = p.name.trim(), at = value.sizeTable.rows.findIndex(row => row.name === name);
      if (at < 0) throw new Error('尺寸表里没有“' + name + '”。');
      const uses = [...value.anchors.filter(anchor => !anchor.plain), ...(value.notchRules || [])].filter(rule => [rule.x, rule.y].some(textValue => formulaNames(parseFormula(textValue)).has(name))).length;
      if (uses) throw new Error('还有 ' + uses + ' 个放码点的公式用到“' + name + '”，先改掉这些公式。');
      value.sizeTable.rows.splice(at, 1); const plan = store(project, env, value, existing);
      return { summary: { operation: 'grade.removeMeasure', name, measures: plan.sizeTable.rows.map(row => row.name) } };
    } },
  { type: 'grade.setRule', title: '放码规则', description: '给一条线上的一个点设放码规则（按尺寸表放码）。at 是这个点的位置：线的端点、曲线经过的点，或者线上的任意位置（这时在线上加一个放码点，即 ET 的“增加放码点”）。x 是水平方向的公式，y 是竖直方向的公式，向右、向上为正。公式里用尺寸表的项目名称，例如“胸围/4+0.5”，每个码按它与基码的差来算；只写一个数（如“0.5”）表示每大一个码移动这么多厘米；留空表示这个方向不动，两个都留空就是固定点。各码里本来就不动的点不必设规则，只有要压住一个否则会跟着别的放码点走的点时才设固定点。新设规则时没给的方向不动；改已有的规则时没给的那一项保持原样。同一位置上其他线的点如果规则相同，会一起改；同一位置上没有规则的点自动跟着走。',
    input_schema: object({ entityId: text(120, '点所在的线或曲线'), at: point('点的位置'), x: formula('水平方向的公式'), y: formula('竖直方向的公式'), angle: number(-360, 360, '规则的方向逆时针转多少度，默认 0；不为 0 时 x、y 沿转过的方向') }, ['entityId', 'at']),
    run(project, p, env) {
      requireMm(project);
      const existing = need(project), value = open(existing), names = new Set(value.sizeTable.rows.map(row => row.name));
      if (p.x !== undefined) checkFormula(p.x, names, '水平'); if (p.y !== undefined) checkFormula(p.y, names, '竖直');
      const found = locate(project, value, p.entityId, p.at), { own, twins } = ruleAt(project, value, found), created = !own;
      const change = rule => { if (p.x !== undefined) rule.x = p.x.trim(); if (p.y !== undefined) rule.y = p.y.trim(); if (p.angle !== undefined) Object.assign(rule, axesOf(p.angle)); };
      let rule = own;
      if (own) { for (const twin of twins) change(twin); change(own); }
      else {
        if (found.where.index !== undefined) value.anchors = value.anchors.filter(anchor => !(anchor.entityId === found.entity.id && anchor.index === found.where.index));   // a point that only divided a curve
        rule = { entityId: found.entity.id, ...found.where, x: (p.x ?? '').trim(), y: (p.y ?? '').trim(), ...axesOf(p.angle ?? 0) }; value.anchors.push(rule);
      }
      const plan = store(project, env, value, existing);
      return { summary: { operation: 'grade.setRule', entityId: found.entity.id, line: found.entity.name, where: found.name, at: { x: round(found.at.x), y: round(found.at.y) }, created, x: rule.x, y: rule.y, angleDeg: angleOf(rule), alsoChanged: twins.length, moves: movesOf(plan, rule) } };
    } },
  { type: 'grade.removeRule', title: '删除放码规则', description: '去掉一条线上一个点的放码规则；线上的放码点连同点一起去掉。同一位置上其他线的点如果规则相同，一起去掉。去掉以后这个点不再自己移动，落在别的放码点上时仍然跟着走。',
    input_schema: object({ entityId: text(120, '点所在的线或曲线'), at: point('点的位置') }, ['entityId', 'at']),
    run(project, p, env) {
      requireMm(project);
      const existing = need(project), value = open(existing), found = locate(project, value, p.entityId, p.at), { own, twins } = ruleAt(project, value, found);
      if (!own) throw new Error('“' + found.entity.name + '”的这个点上没有放码规则。');
      const gone = new Set([own, ...twins]); value.anchors = value.anchors.filter(anchor => !gone.has(anchor));
      const plan = store(project, env, value, existing);
      return { summary: { operation: 'grade.removeRule', entityId: found.entity.id, line: found.entity.name, where: found.name, at: { x: round(found.at.x), y: round(found.at.y) }, removed: gone.size, rules: plan.anchors.filter(anchor => !anchor.plain).length } };
    } },
  { type: 'grade.clear', title: '删除放码', description: '删掉这张图按尺寸表放码的方案：号型、尺寸表和全部规则。基码纸样不动。排料或出图还在用它的尺码时不能删。',
    input_schema: object({}, []),
    run(project) {
      requireMm(project);
      const plan = need(project), marker = (project.markerPlans || []).find(item => (item.items || []).some(entry => entry.gradePlanId === plan.id));
      if (marker) throw new Error('排料方案“' + marker.name + '”用着这套放码的尺码，先改排料。');
      if (project.plotSettings?.source === 'grade' && project.plotSettings.sourceId === plan.id) throw new Error('保存的出图来源用着这套放码的尺码，先改出图设置。');
      project.gradingPlans = project.gradingPlans.filter(item => item !== plan);
      return { summary: { operation: 'grade.clear', name: plan.name, sizes: plan.sizes.length + 1, measures: plan.sizeTable.rows.length, rules: plan.anchors.filter(anchor => !anchor.plain).length } };
    } },
];

/** What the assistant is told about the grading of the drawing (part of the scene). */
export function describeGrading(project) {
  const plan = tablePlanOf(project); if (!plan) return null;
  const sizes = sizesInOrder(plan);
  return { planId: plan.id, name: plan.name, baseSize: plan.baseSize, sizes: sizes.map(size => size.label),
    measures: plan.sizeTable.rows.slice(0, 60).map(row => ({ name: row.name, valuesCm: sizes.map(size => round(row.values[size.slot])) })),
    rules: plan.anchors.filter(anchor => !anchor.plain).slice(0, 200).map(anchor => { const at = placeOfAnchor(project, anchor); return { entityId: anchor.entityId, ...(at ? { at: { x: round(at.x), y: round(at.y) } } : {}), x: anchor.x, y: anchor.y, ...(angleOf(anchor) ? { angleDeg: angleOf(anchor) } : {}), ...(anchor.between !== undefined ? { onLine: true } : {}) }; }),
    ruleCount: plan.anchors.filter(anchor => !anchor.plain).length, ...(plan.lostRules ? { rulesLostToEdits: plan.lostRules } : {}) };
}
