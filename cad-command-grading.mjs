/**
 * Commands for grading by a size table, the way ET does it (v57): the sizes and the base size, the rows of the size table,
 * the rule of a point, taking a rule away, and removing the grading. They work on the one plan of this kind a drawing has;
 * the first of them makes it. With these the assistant can grade a pattern, not only the grading panel.
 */
import { number, point, text, object, requireMm, entityOf, round } from './cad-command-kit.mjs';
import { createTablePlan, applyGradingPlan, normalizeGradingPlan, generateGradedSize } from './grading.mjs';
import { stationsOf, placeOnLine, ruleDisplacement } from './grading-table.mjs';
import { parseFormula, formulaNames } from './size-formula.mjs';
import { alignmentPlace, bakeAlignment, alignedMove } from './grading-align.mjs';
import { lockPoints, unlockPoints, lockSize, moveInSize, stationsAtPlace, SAME_MM as LOCK_MM } from './grading-locks.mjs';
import { SERIES_LETTERS, seriesIndex, useSeries, nameSeries, describeSeries } from './size-series.mjs';
import { PATTERN_SLOT } from './size-input.mjs';

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
// v69: the sizes a lock is for (by their names; the base size is refused, as ET never locks a point of the base size)
const labelOf = (value, id) => (value.sizes.find(size => size.id === id) || {}).label || id;
function sizeIdsOf(value, labels, what) {
  if (labels === undefined || labels === null) return value.sizes.map(size => size.id);
  if (!Array.isArray(labels) || !labels.length) throw new Error('sizes 要列出号型名称；不给时是除基码以外的全部号型。');
  return [...new Set(labels.map(label => sizeIdOf(value, label, what)))];
}
function sizeIdOf(value, label, what) {
  const name = String(label ?? '').trim();
  if (name === value.baseSize) throw new Error('基码“' + name + '”的点不能' + what + '（ET 也不锁基码上的点）；基码要改就直接改图。');
  const size = value.sizes.find(item => item.label === name); if (!size) throw new Error('号型里没有“' + name + '”。现有：' + value.sizes.map(item => item.label).join('、') + '（基码 ' + value.baseSize + '）。');
  return size.id;
}
const maker = (project, value) => sizeId => generateGradedSize(project, value, sizeId);
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
  { type: 'grade.setSizes', title: '设置号型', description: '按尺寸表放码（ET 的做法）的第一步：给出从小到大的全部号型名称，并指出其中的基码。这份名单就是正在用的那组号型系列的名称（ET 号型名称里 A 到 E 正在用的一组，见“号型系列”）。图里还没有这种放码方案时会建立一个，它管整张图；已经有时按新的名单增减号型，尺寸表和规则保留；新加的号型，尺寸表每一项按该项基码的数值和档差顺延出数值（档差是建立这一项或最后一次给 step 时的每码增量；场景里只有各码的数值，均匀时就是相邻两码的差），不用再逐项填，个别码要不一样时再用“尺寸表项目”改。之后用“尺寸表项目”填尺寸表，用“放码规则”给点设规则。',
    input_schema: object({ sizes: { type: 'array', description: '全部号型的名称，从小到大，含基码', items: text(50, '号型名称'), minItems: 2, maxItems: 13 }, base: text(50, '基码的名称，必须在名单里') }, ['sizes', 'base']),
    run(project, p, env) {
      requireMm(project);
      const names = p.sizes.map(name => name.trim()); if (names.some(name => !name) || new Set(names).size !== names.length) throw new Error('号型名称不能重复，也不能是空的。');
      const at = names.indexOf(p.base.trim()); if (at < 0) throw new Error('基码“' + p.base + '”不在号型名单里。');
      const existing = tablePlanOf(project), value = existing ? open(existing) : JSON.parse(JSON.stringify(createTablePlan(project, env.makeId))), table = value.sizeTable, baseSlot = table.baseSlot;
      if (baseSlot - at < 0 || baseSlot + names.length - 1 - at > PATTERN_SLOT - 1) throw new Error('号型太多，排不进号型表。');   // v71: the last position is ET's 纸样尺寸
      const before = new Map(value.sizes.map(size => [size.slot, size]));
      value.baseSize = names[at];
      value.sizes = names.map((label, i) => ({ label, slot: baseSlot + i - at })).filter(size => size.slot !== baseSlot).map(size => ({ id: before.get(size.slot)?.id || env.makeId(), label: size.label, step: size.slot - baseSlot, slot: size.slot }));
      table.series[table.activeSeries] = names.map((name, i) => ({ slot: baseSlot + i - at, name }));
      const plan = store(project, env, value, existing);
      return { summary: { operation: 'grade.setSizes', created: !existing, sizes: sizesInOrder(plan).map(size => size.label), baseSize: plan.baseSize, measures: plan.sizeTable.rows.length, rules: plan.anchors.filter(anchor => !anchor.plain).length } };
    } },
  { type: 'grade.setMeasure', title: '尺寸表项目', description: '在放码的尺寸表里加一项或改一项，单位厘米。新的一项要给基码的数值 base；step 是每大一个码增加多少（可以是负数，不给就是 0）；个别码不按 step 走时用 values 单独给。已有的项目：只给 values 就只改那几个码；只给 base 时各码一起平移；给 step 时按 base 和 step 重排。放码规则的公式里用项目名称，例如“胸围/4”。pattern 是这一项的纸样尺寸（ET 尺寸表里“纸样尺寸”那一栏）：在画线工具的长度框里写这一项的名称（如“袖长/10”）时，和 ET 一样取的是纸样尺寸，不是基码的数值；新的一项不给 pattern 时纸样尺寸是 0（ET 自己的文件也是 0），改 base、step 不动纸样尺寸；已有的项目只给 pattern 就只改纸样尺寸。',
    input_schema: object({ name: text(50, '项目名称，如 胸围；不能以数字开头，不能带 + - * / ( ) 和空格'), base: number(-100000, 100000, '基码的数值，厘米'), step: number(-1000, 1000, '每大一个码增加多少，厘米'), pattern: number(-100000, 100000, '纸样尺寸，厘米：在工具里写这一项的名称时取的数'),
      values: { type: 'array', description: '个别号型的数值', minItems: 0, maxItems: 13, items: object({ size: text(50, '号型名称'), value: number(-100000, 100000, '这个号型的数值，厘米') }, ['size', 'value']) } }, ['name']),
    run(project, p, env) {
      requireMm(project);
      const existing = need(project), value = open(existing), table = value.sizeTable, name = p.name.trim(), sizes = sizesInOrder(value);
      let row = table.rows.find(item => item.name === name); const created = !row;
      // v71: the last position of a row is ET's 纸样尺寸 (what a name typed into a tool stands for); the sizes never touch it
      if (!row) { if (p.base === undefined) throw new Error('尺寸表里还没有“' + name + '”，请给出基码的数值。'); row = { name, values: Array.from({ length: 50 }, (_, slot) => slot === PATTERN_SLOT ? p.pattern ?? 0 : p.base + (slot - table.baseSlot) * (p.step ?? 0)) }; table.rows.push(row); }
      else if (p.step !== undefined) { const base = p.base ?? row.values[table.baseSlot]; row.values = row.values.map((v, slot) => slot === PATTERN_SLOT ? v : base + (slot - table.baseSlot) * p.step); }
      else if (p.base !== undefined) { const shift = p.base - row.values[table.baseSlot]; row.values = row.values.map((v, slot) => slot === PATTERN_SLOT ? v : v + shift); }
      else if (!(p.values || []).length && p.pattern === undefined) throw new Error('请给出要改的数值。');
      if (p.pattern !== undefined) row.values[PATTERN_SLOT] = p.pattern;
      for (const item of p.values || []) { const size = sizes.find(s => s.label === item.size.trim()); if (!size) throw new Error('号型里没有“' + item.size + '”。现有：' + sizes.map(s => s.label).join('、') + '。'); row.values[size.slot] = item.value; }
      const plan = store(project, env, value, existing), saved = plan.sizeTable.rows.find(item => item.name === name);
      return { summary: { operation: 'grade.setMeasure', name, created, valuesCm: sizesInOrder(plan).map(size => ({ size: size.label, value: round(saved.values[size.slot]) })), patternCm: round(saved.values[PATTERN_SLOT]) } };
    } },
  { type: 'grade.sizeSeries', title: '号型系列', description: 'ET 号型名称里的五组号型系列（A 到 E 系列）。每个系列给号型表的位置起名，基码在每个系列里都是同一个位置；同一时间只用一个系列，它的名称就是各码的名称（ET 尺码栏里的号型、推板展开的各层）。尺寸表按位置存，换用系列只改哪些位置是号型、叫什么，尺寸表的数值和放码规则不变。names 是这个系列从小到大的全部名称（含基码，base 指出其中哪个是基码，排在基码的位置上，其余排在两边）；use 为 true 时换用这个系列，这个系列在基码的位置上必须有名称（ET 也不换：基础号型为空）。只给 use 就只换用；只给 names 就只改这个系列的名称，改的是正在用的系列时各码一起改名、增减；names 为空数组时清空一个没在用的系列；不给 use 就不换用。尺寸表的每一项在每个位置上都有数（新加的项目按基码的数值和档差排满所有位置），一个位置换用后成了号型，用的就是这个位置上原有的数，个别要改再用“尺寸表项目”。只是给正在用的系列加减号型时，用“设置号型”也一样。换用后号型变了的码，它们的锁定去掉。',
    input_schema: object({ series: { type: 'string', enum: SERIES_LETTERS, description: '哪个系列：A、B、C、D、E' }, names: { type: 'array', description: '这个系列从小到大的全部号型名称，含基码', items: text(50, '号型名称'), minItems: 0, maxItems: 30 }, base: text(50, '基码在这个系列里的名称，必须在 names 里'), use: { type: 'boolean', description: 'true：换用这个系列' } }, ['series']),
    run(project, p, env) {
      requireMm(project);
      const existing = need(project), value = open(existing), k = seriesIndex(p.series);
      if (p.names === undefined && p.use !== true) throw new Error('请给出 names（这个系列的名称）或 use: true（换用这个系列）。');
      if (p.names !== undefined && p.names.length && p.base === undefined) throw new Error('请用 base 指出哪个名称是基码。');
      let dropped = { droppedLocks: 0, droppedSizeLocks: 0 }, before = value.sizeTable.activeSeries;
      if (p.names !== undefined) dropped = { ...dropped, ...nameSeries(value, k, p.names, p.base, env.makeId) };
      if (p.use === true && value.sizeTable.activeSeries !== k) dropped = useSeries(value, k, env.makeId);
      const plan = store(project, env, value, existing), seen = describeSeries(plan.sizeTable);
      return { summary: { operation: 'grade.sizeSeries', series: SERIES_LETTERS[k], inUse: seen.inUse, switched: before !== plan.sizeTable.activeSeries, sizes: sizesInOrder(plan).map(size => size.label), baseSize: plan.baseSize, names: seen.series[SERIES_LETTERS[k]] || [], ...(dropped.droppedLocks ? { locksRemoved: dropped.droppedLocks } : {}), ...(dropped.droppedSizeLocks ? { sizeLocksRemoved: dropped.droppedSizeLocks } : {}) } };
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
      // v68: a rule ET wrote in inches (its numbers are inches) is changed as a whole: both formulas are given and are centimetres
      if (own && own.unit === 'in' && (p.x === undefined || p.y === undefined)) throw new Error('这个点的规则是 ET 按英寸写的（公式里的数字按英寸算）。改它时请同时给出 x 和 y 两个公式，按厘米写。');
      const change = rule => { if (p.x !== undefined) rule.x = p.x.trim(); if (p.y !== undefined) rule.y = p.y.trim(); if (p.angle !== undefined) Object.assign(rule, axesOf(p.angle)); delete rule.unit; };
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
  { type: 'grade.align', title: '放码对齐', description: 'ET 推板里的“对齐”和“线对齐”。mode point：各码的这一片按一个点重合，at 是这片上一条线的端点或曲线经过的点（裁片轮廓是一条闭合折线时，它的转角也算）；axis 为 both 时点重合，y 只对齐高低（ET 按 Shift），x 只对齐左右（ET 按 Ctrl）。mode line：各码的这一片按它的一条直线重合，at 是这条直线上的位置（轮廓是折线时，at 落在哪一段就用哪一段）：各码这条线长短不同，对到 at 的是每个码在这条线上离较近那一端同样远的点，不是各码自己的中点（ET 就是这样；at 正好在中点时从线的起点量，闭合折线的起点是 at 所在这一段在折线里的前一个点），线转到基码的方向，所以结果是各码这条线较近的那一端重合、线叠在一起。师傅没说保留、写进规则或改放码基准时不给 keep。keep 不给或为 false（ET 的“普通”）时只改看的样子：对齐记在放码方案里（场景的 grading.alignment），预览叠码时这样画，这也算一次修改。keep 为 true（ET 的“保留”）时把对齐写进这片外轮廓各角点的规则，各码就这样放出来：axis both 时对齐的角点成为不动点；axis 为 y 或 x 时只把这个方向写进规则，另一个方向的移动照旧（和 ET 按 Shift、Ctrl 保留一样）；在各码都不动的角点不再有规则（曲线中间带规则的点、线上的放码点、内部线不改，和 ET 一样）；新规则每码一样时写成一个数，不一样时在尺寸表里加 MS…ID… 行，之后不再留着看的对齐；这些规则不再跟着尺寸表的项目变，之后改尺寸表不会带动它们，宜在回复里告诉师傅。clear 为 true 时去掉看的对齐（其他参数不用给）；用 keep 写进规则的不会因此撤回，要撤回用撤销。散线和别的裁片不动。',
    input_schema: object({ entityId: text(120, '对齐点或对齐直线所在的线（要在裁片上）'), at: point('对齐的位置：点，或直线上的位置（毫米，和场景一样）'), mode: { type: 'string', enum: ['point', 'line'], description: 'point 按点对齐，line 按直线对齐' }, axis: { type: 'string', enum: ['both', 'x', 'y'], description: '按点对齐时：both 点重合（默认），y 只对齐高低，x 只对齐左右（keep 时也只把这个方向写进规则）' }, keep: { type: 'boolean', description: 'true 把对齐写进外轮廓角点的规则（ET 的“保留”）；默认 false 只改看的样子' }, clear: { type: 'boolean', description: 'true 去掉对齐' } }, []),
    run(project, p, env) {
      requireMm(project);
      const existing = need(project), value = open(existing);
      if (p.clear) { const had = Boolean(value.alignment); delete value.alignment; store(project, env, value, existing); return { summary: { operation: 'grade.align', cleared: had } }; }
      if (!p.entityId || !p.at || !p.mode) throw new Error('对齐要给出 entityId、at 和 mode（point 或 line）；去掉对齐用 clear。');
      const alignment = { mode: p.mode, entityId: p.entityId, at: { x: p.at.x, y: p.at.y }, axis: p.mode === 'point' ? (p.axis || 'both') : 'both' }, place = alignmentPlace(project, alignment);
      if (p.keep) {
        const baked = bakeAlignment(project, value, alignment), plan = store(project, env, baked.value, existing);
        return { summary: { operation: 'grade.align', kept: true, mode: p.mode, piece: place.piece.name, cornersChanged: baked.changed, cornersFixed: baked.fixed, rows: plan.sizeTable.rows.length } };
      }
      value.alignment = alignment; store(project, env, value, existing);
      return { summary: { operation: 'grade.align', kept: false, mode: p.mode, piece: place.piece.name, at: { x: round(place.point.x), y: round(place.point.y) }, ...(p.mode === 'point' ? { axis: alignment.axis } : { from: place.from, distanceMm: round(place.distance) }) } };
    } },
  { type: 'grade.lock', title: '锁定放码点', description: 'ET 推板里的“锁定放码点”（这是放码里的锁定；把裁片锁住、防止误改是 piece.setLocked）：at 位置上的点（线的端点、曲线经过的点、闭合折线的转角或线上的放码点；同一位置上几条线的点一起，和 ET 框选一样）在 sizes 列出的号型里锁定在它在这个号型里现在的位置，以后改规则、改尺寸表、改基码、重新生成各码都不再移动它们；写进 ET 文件时是锁定的点，ET 推板展开也不动它们。sizes 不给时锁定除基码以外的全部号型（ET 显示全部号型时就是这样）。基码的点不能锁（ET 也不锁），基码要改就直接改图。要先把点挪到别处再锁定，用 grade.moveInSize（它移动后自动锁定）。at 是基码图上的位置（毫米，和场景一样）。加上锁定就算一次修改，即使各码现在看起来没有变。',
    input_schema: object({ at: point('点在基码图上的位置（毫米）'), sizes: { type: 'array', minItems: 1, maxItems: 13, items: text(50, '号型名称'), description: '在哪些号型里锁定；不给时是除基码以外的全部号型' } }, ['at']),
    run(project, p, env) {
      requireMm(project);
      const existing = need(project), value = open(existing), ids = sizeIdsOf(value, p.sizes, '锁定'), result = lockPoints(project, value, p.at, ids, maker(project, value));
      store(project, env, result.value, existing);
      return { summary: { operation: 'grade.lock', at: { x: round(result.stations[0].at.x), y: round(result.stations[0].at.y) }, points: result.stations.length, sizes: ids.map(id => labelOf(value, id)) } };
    } },
  { type: 'grade.unlock', title: '解锁放码点', description: 'ET 推板里的“解锁放码点”：at 位置上的点（同 grade.lock）在 sizes 列出的号型里不再锁定，下次生成各码时回到规则给的位置。sizes 不给时解锁全部号型。整码锁定（grade.lockSize）的号型仍然整码保持，要用 grade.lockSize 解锁那个码。去掉锁定就算一次修改，即使规则给的位置和锁定的位置一样。这个位置在这些号型里没有单独锁定的点时这条命令报错，不要这样排步骤。',
    input_schema: object({ at: point('点在基码图上的位置（毫米）'), sizes: { type: 'array', minItems: 1, maxItems: 13, items: text(50, '号型名称'), description: '在哪些号型里解锁；不给时是全部号型' } }, ['at']),
    run(project, p, env) {
      requireMm(project);
      const existing = need(project), value = open(existing), ids = sizeIdsOf(value, p.sizes, '解锁'), result = unlockPoints(project, value, p.at, ids);
      if (!result.stations.length) throw new Error('这个位置上没有放码方案里的线的端点或放码点（离它 ' + LOCK_MM + ' mm 以内）。');
      if (!result.unlocked) throw new Error('这个位置的点在' + ids.map(id => labelOf(value, id)).join('、') + '里没有单独锁定' + ((value.lockedSizes || []).some(id => ids.includes(id)) ? '（所在的号型是整码锁定的，要用 grade.lockSize 解锁）' : '') + '。');
      store(project, env, result.value, existing);
      return { summary: { operation: 'grade.unlock', points: result.stations.length, unlocked: result.unlocked, sizes: ids.map(id => labelOf(value, id)) } };
    } },
  { type: 'grade.lockSize', title: '锁定解锁当前码', description: 'ET 推板里的“锁定解锁当前层”：locked 为 true 时把 size 这个号型现在的样子整码保持（这个码里放码方案的每条线的每个点都锁定），以后改规则、改基码都不再变；写进 ET 文件时这个码的图层是锁定的。locked 为 false 时解锁，这个码重新按规则生成（单独锁定的点仍然锁定）。基码不能锁。已经是要的状态时这条命令报错（不算修改），不要这样排步骤。',
    input_schema: object({ size: text(50, '号型名称（不是基码）'), locked: { type: 'boolean', description: 'true 整码锁定，false 解锁' } }, ['size', 'locked']),
    run(project, p, env) {
      requireMm(project);
      const existing = need(project), value = open(existing), id = sizeIdOf(value, p.size, p.locked ? '锁定' : '解锁'), was = (value.lockedSizes || []).includes(id);
      if (was === Boolean(p.locked)) throw new Error('号型“' + labelOf(value, id) + '”' + (was ? '已经整码锁定了。' : '没有整码锁定。'));
      const result = lockSize(project, value, id, Boolean(p.locked), maker(project, value));
      store(project, env, result.value, existing);
      return { summary: { operation: 'grade.lockSize', size: labelOf(value, id), locked: Boolean(p.locked), points: result.stations } };
    } },
  { type: 'grade.moveInSize', title: '在一个码上改点', description: 'ET 推板里在某一个号型上单独改点（推板状态下把这个码设为当前层再用“端移动”）：at（基码图上的位置，毫米；线的端点、曲线经过的点或闭合折线的转角）上的点在 size 这个号型里移到 to（这个号型里的位置，毫米），或者从它在这个号型里现在的位置移动 dx、dy（毫米，向右、向上为正；只给一个时另一个是 0；给了 to 就不看 dx、dy）；别的号型和放码规则都不变。和 ET 一样，移动的点在这个号型里锁定，经过它的线的另一端也锁定在现在的位置：直线锁另一端，曲线锁两端，折线（包括闭合折线）锁这个转角两边相邻的点；以后重新生成、推板展开都不会改回去，要回到规则给的位置用 grade.unlock。基码不能这样改，基码要直接改图。',
    input_schema: object({ size: text(50, '号型名称（不是基码）'), at: point('点在基码图上的位置（毫米）'), to: point('在这个号型里移到哪里（毫米）'), dx: number(-10000, 10000, '或者：在这个号型里向右移动多少毫米'), dy: number(-10000, 10000, '或者：在这个号型里向上移动多少毫米') }, ['size', 'at']),
    run(project, p, env) {
      requireMm(project);
      const existing = need(project), value = open(existing), id = sizeIdOf(value, p.size, '这样改'), generate = maker(project, value);
      const stations = stationsAtPlace(project, value, p.at); if (!stations.length) throw new Error('这个位置上没有放码方案里的线的端点或放码点（离它 ' + LOCK_MM + ' mm 以内）。');
      let to = p.to;
      if (!to) {
        if (p.dx === undefined && p.dy === undefined) throw new Error('请给出 to（这个号型里的新位置），或者 dx、dy（移动多少毫米）。');
        const sized = generate(id).project.entities.find(item => item.id === stations[0].entityId), now = stationsOf(sized).points[stations[0].index];
        to = { x: now.x + (p.dx || 0), y: now.y + (p.dy || 0) };
      }
      const result = moveInSize(project, value, id, p.at, to, generate);
      store(project, env, result.value, existing);
      return { summary: { operation: 'grade.moveInSize', size: labelOf(value, id), at: { x: round(stations[0].at.x), y: round(stations[0].at.y) }, to: { x: round(to.x), y: round(to.y) }, points: result.stations.length, endsLocked: result.ends.length } };
    } },
  { type: 'grade.alignedMove', title: '对齐移动点', description: 'ET 推板里的“点对齐移动点规则”和“线对齐移动点规则”：先按一个点（mode point）或一条直线（mode line，at 是直线上的位置，规则同“对齐”）把这片的各码对齐，再给同一片上的目标点 target 设规则，使它在对齐后的样子里每大一个码移动 x、y 厘米。x 向右为正、y 向上为正，沿基码的水平、竖直方向（往外是离开裁片中间：右边的点往外放是正数，左边的点是负数）；不给的那一项保持目标点现在在对齐后的样子里的移动，只改给了的方向（和“放码规则”不给的一项保持原样一样）；要它在这个方向相对对齐点不动就给 0。也可以用 perSize 按号型逐个给出离基码的移动量（没给的方向同样保持）。目标点原来的规则换成新的，不是在原来的规则上加。按点对齐时，目标点在每个码里的移动 = 对齐点在这个码里的移动 + 给的量；按线对齐时还要随这条线转。例如“口袋右上角相对左上角每码横向放 0.8”：对齐点是口袋左上角，target 是口袋右上角，x 0.8，不给 y，右上角在竖直方向照旧。规则按 ET 的写法存：每码一样就写一个数，否则在尺寸表里加一行 MS…ID…，所以目标点的新规则不再跟着尺寸表的项目变，之后改尺寸表不会带动它（给不给 keep 都这样），宜在回复里告诉师傅。keep 为 true（ET 的“保留”）时先把对齐写进外轮廓角点的规则（同“对齐”的 keep），对齐点不再动，目标点给了的方向的规则就是给的数；这些角点的规则同样成了数（或 MS 行）。目标位置上的几个点（转角处两条线的端点）一起设；at 和 target 也可以是闭合折线的转角。这条命令不改看的对齐（场景的 grading.alignment 不变）。',
    input_schema: object({ entityId: text(120, '对齐点或对齐直线所在的线（要在裁片上）'), at: point('对齐的位置'), mode: { type: 'string', enum: ['point', 'line'], description: 'point 按点对齐，line 按直线对齐' }, target: point('目标点的位置（同一片上线的端点或曲线经过的点）'), x: number(-1000, 1000, '每大一个码横向移动多少厘米'), y: number(-1000, 1000, '每大一个码纵向移动多少厘米'),
      perSize: { type: 'array', description: '按号型逐个给出离基码的移动量（厘米），给了就不看 x、y', minItems: 1, maxItems: 13, items: object({ size: text(50, '号型名称'), x: number(-10000, 10000, '横向，厘米'), y: number(-10000, 10000, '纵向，厘米') }, ['size']) },
      keep: { type: 'boolean', description: 'true 先把对齐写进外轮廓角点的规则（ET 的“保留”）' } }, ['entityId', 'at', 'mode', 'target']),
    run(project, p, env) {
      requireMm(project);
      const existing = need(project), value = open(existing), alignment = { mode: p.mode, entityId: p.entityId, at: { x: p.at.x, y: p.at.y }, axis: 'both' };
      let amounts;
      if (p.perSize && p.perSize.length) {
        amounts = { perSize: value.sizes.map(size => { const given = p.perSize.find(item => item.size.trim() === size.label); if (!given) throw new Error('perSize 里缺少号型“' + size.label + '”（基码不用给）。'); return { sizeId: size.id, x: given.x, y: given.y }; }) };
        for (const item of p.perSize) if (item.size.trim() !== value.baseSize && !value.sizes.some(size => size.label === item.size.trim())) throw new Error('号型“' + item.size + '”不在这套放码里。');
      } else { if (p.x === undefined && p.y === undefined) throw new Error('请给出每码横向 x 或纵向 y 移动多少厘米，或用 perSize 逐码给出。'); amounts = { x: p.x, y: p.y }; }
      const result = alignedMove(project, value, alignment, p.target, amounts, Boolean(p.keep)), plan = store(project, env, result.value, existing);
      return { summary: { operation: 'grade.alignedMove', mode: p.mode, piece: result.place.piece.name, kept: Boolean(p.keep), points: result.stations, x: result.x, y: result.y, rows: plan.sizeTable.rows.length } };
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
// v69: the locked points by size and place (the lines meeting at a corner count once), the sizes kept whole
function lockedOf(plan) {
  const seen = new Set(), locks = [];
  for (const lock of plan.locks || []) {
    if (lock.layer || !lock.at) continue; const size = labelOf(plan, lock.sizeId), key = size + '|' + round(lock.at.x) + '|' + round(lock.at.y); if (seen.has(key)) continue; seen.add(key);
    if (locks.length < 200) locks.push({ size, at: { x: round(lock.at.x), y: round(lock.at.y) }, x: round(lock.x), y: round(lock.y) });
  }
  return { ...(locks.length ? { locks } : {}), ...((plan.lockedSizes || []).length ? { lockedSizes: plan.lockedSizes.map(id => labelOf(plan, id)) } : {}) };
}
export function describeGrading(project) {
  const plan = tablePlanOf(project); if (!plan) return null;
  const sizes = sizesInOrder(plan);
  const named = describeSeries(plan.sizeTable);   // v71: ET's five series and the one in use; a row's 纸样尺寸 when it is not 0
  // v77: the plan of a trouser drafted from measurements has its rules from the trouser's formulas (hundreds); the scene names the draft
  const fromDraft = (project.metadata?.parametricDrafts || []).find(draft => draft.gradingPlanId === plan.id) || null;
  return { planId: plan.id, name: plan.name, baseSize: plan.baseSize, sizes: sizes.map(size => size.label), seriesInUse: named.inUse, series: named.series,
    measures: plan.sizeTable.rows.slice(0, 60).map(row => ({ name: row.name, valuesCm: sizes.map(size => round(row.values[size.slot])), ...(row.values[PATTERN_SLOT] ? { patternCm: round(row.values[PATTERN_SLOT]) } : {}) })),
    ...(fromDraft ? { fromDraft: { draftId: fromDraft.id, notchRules: (plan.notchRules || []).length, howToChange: '这套放码是按尺寸生成的整套裤子的，每个点和刀口的规则由纸样公式推出（不逐条列出）；改号型、基码、档差或去掉放码用 pattern.updateDraft 的 grading、removeGrading，用 grade.* 改算手工修改' } } : {}),
    rules: fromDraft ? [] : plan.anchors.filter(anchor => !anchor.plain).slice(0, 200).map(anchor => { const at = placeOfAnchor(project, anchor); return { entityId: anchor.entityId, ...(at ? { at: { x: round(at.x), y: round(at.y) } } : {}), x: anchor.x, y: anchor.y, ...(angleOf(anchor) ? { angleDeg: angleOf(anchor) } : {}), ...(anchor.between !== undefined ? { onLine: true } : {}), ...(anchor.unit === 'in' ? { inches: true } : {}) }; }),
    ruleCount: plan.anchors.filter(anchor => !anchor.plain).length, ...(plan.lostRules ? { rulesLostToEdits: plan.lostRules } : {}),
    ...(plan.alignment ? { alignment: { mode: plan.alignment.mode, entityId: plan.alignment.entityId, at: { x: round(plan.alignment.at.x), y: round(plan.alignment.at.y) }, ...(plan.alignment.mode === 'point' && plan.alignment.axis !== 'both' ? { axis: plan.alignment.axis } : {}) } } : {}),
    ...lockedOf(plan) };
}
