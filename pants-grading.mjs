/**
 * v77: grading the whole trouser (pants-set.mjs) by a size table, the way ET grades (grading-table.mjs), with rules derived from the
 * trouser's own formulas.
 *
 * The master gives the sizes, the base size and how much each measurement grows per size (档差). Every size is the base input with
 * the steps added (S = M − one step, XL = M + two steps). The rules: for every point of every line and curve of every piece (an end
 * of a line, a point a curve passes through) and for every notch, how far it moves for one millimetre of each measurement, worked
 * out by drafting the trouser one step above and one step below the base for each measurement in turn (a central difference).
 * A point's rule is then the sum over the measurements of that rate times the row of the size table, for example
 * "0.2401*腰围+0.0103*臀围", along the drawing's x and y. ET and the page make a size from such rules the same way.
 *
 * Each piece grades about a point of its own: the legs about the place where the grain line crosses the crotch line (as trousers
 * are usually graded), every other piece about the middle of its outline. A point's rule is its movement relative to that point,
 * so the pieces do not drift apart in the sizes.
 *
 * The curves of the trouser are ET curves through nine points (pants-set.mjs), so every point along a seam has a rule of its own
 * and a graded curve follows the shape the formulas give that size: checked on the example sizes, within 0.04 mm of drafting the
 * size directly one size away and 0.2 mm two sizes away (what is left is that the formulas are not quite linear). Every size is
 * made and compared with drafting it directly, and its delivery checks are run (`report.sizes`).
 *
 * Not graded: the marks (drill holes, buttons, buttonholes) and the texts stay where they are in the base size: ET keeps marks as
 * objects of its own, and rules on them are not written to ET files yet.
 */
import { stationsOf } from './grading-table.mjs';
import { normalizeGradingPlan, gradeSource } from './grading-schema.mjs';
import { generateGradedSize } from './grading.mjs';
import { pathMetrics, stationOnPath } from './path-metrics.mjs';
import { pantsDeliveryChecks } from './pants-set.mjs';

// [key, section of the input, name in the size table, ease that is added for the table (finished size), example step mm, label]
export const GRADE_FIELDS = Object.freeze([
  ['waist', 'measurements', '腰围', 'waistEase', 40, '腰围'],
  ['hip', 'measurements', '臀围', 'hipEase', 36, '臀围'],
  ['thigh', 'measurements', '大腿围', 'thighEase', 20, '大腿围'],
  ['hipDepth', 'measurements', '臀高', null, 5, '腰线至臀线'],
  ['crotchDepth', 'measurements', '立裆', 'riseEase', 5, '裆深'],
  ['kneeDepth', 'measurements', '膝位', null, 15, '腰线至膝线'],
  ['length', 'measurements', '裤长', null, 30, '裤长'],
  ['kneeCirc', 'rules', '膝围', null, 10, '膝围'],
  ['hemCirc', 'rules', '脚口', null, 10, '脚口围'],
  ['flyLength', 'parts', '门襟长', null, 0, '门襟长'],
  ['pocketOpening', 'parts', '斜袋口长', null, 0, '斜袋口长'],
  ['backPocketWidth', 'parts', '后袋口宽', null, 0, '后袋口宽']
]);
const FIELD = new Map(GRADE_FIELDS.map(f => [f[0], f]));
export const GRADING_SCHEMA = 'zhiyi-pants-grading/v1';
export const defaultGrading = () => ({ sizes: ['S', 'M', 'L', 'XL'], base: 'M', steps: Object.fromEntries(GRADE_FIELDS.map(f => [f[0], f[4]])) });
const copy = x => JSON.parse(JSON.stringify(x));
/** A digest of what a grading plan says (sizes, size table, rules, alignment, locks; not its id or the snapshots of its lines), to tell a
 * plan changed in the grading panel from the one a draft made. */
export function gradingDigest(plan) {
  if (!plan) return null;
  // what each rule says, without the positions and status the command system keeps beside them
  const anchors = (plan.anchors || []).map(a => [a.entityId, a.index ?? null, a.between ?? null, a.x ?? '', a.y ?? '', a.axisX || null, a.axisY || null, a.unit || 'cm', Boolean(a.plain)]);
  const notchRules = (plan.notchRules || []).map(r => [r.notchId, r.x ?? '', r.y ?? '', r.axisX || null, r.axisY || null, r.unit || 'cm']);
  const text = JSON.stringify([plan.name, plan.baseSize, plan.method, plan.interpolation, (plan.sizes || []).map(s => [s.id, s.label, s.slot, s.step]), plan.sizeTable || null, anchors, notchRules, plan.rules || [], plan.alignment || null, plan.locks || null, plan.lockedSizes || null]);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Checks and tidies the grading of a draft: 2 to 13 sizes from small to large, the base among them, a step (mm per size) for each field. */
export function validateGrading(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['sizes', 'base', 'steps'].includes(k))) throw Error('放码设置格式无效。');
  if (!Array.isArray(value.sizes) || value.sizes.length < 2 || value.sizes.length > 13) throw Error('放码要 2 到 13 个号型，从小到大。');
  const sizes = value.sizes.map(s => String(s ?? '').trim());
  if (sizes.some(s => !s || s.length > 20 || /[\s,，、;；]/.test(s))) throw Error('号型名称不能为空、不能带空格或逗号，最多 20 个字。');
  if (new Set(sizes).size !== sizes.length) throw Error('号型名称有重复。');
  const base = String(value.base ?? '').trim(); if (!sizes.includes(base)) throw Error('基码“' + base + '”不在号型里。号型：' + sizes.join('、') + '。');
  const index = sizes.indexOf(base); if (index > 9 || sizes.length - 1 - index > 39) throw Error('基码两边的号型太多。');
  if (!value.steps || typeof value.steps !== 'object' || Array.isArray(value.steps)) throw Error('放码要给每项的档差。');
  for (const key of Object.keys(value.steps)) if (!FIELD.has(key)) throw Error('不认识的放码项目“' + key + '”。');
  const steps = Object.fromEntries(GRADE_FIELDS.map(([key, , , , , label]) => {
    const n = value.steps[key] ?? 0;
    if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 200 || Math.abs(n * 10 - Math.round(n * 10)) > 1e-6) throw Error(label + '的档差须在 ±200 mm 内，最多一位小数。');
    return [key, n];
  }));
  if (Object.values(steps).every(n => n === 0)) throw Error('各项档差都是 0，各码会一模一样。');
  return { sizes, base, steps };
}
/** The input of every size: the base input with the steps added as many times as the size is away from the base (the grading kept). */
export function sizeInputs(input) {
  const g = input.grading, baseIndex = g.sizes.indexOf(g.base);
  return g.sizes.map((label, i) => {
    const offset = i - baseIndex, next = copy(input);
    for (const [key, section] of GRADE_FIELDS) if (g.steps[key]) next[section][key] = Math.round((next[section][key] + offset * g.steps[key]) * 1e6) / 1e6;
    return { label, offset, input: next };
  });
}
const shifted = (input, key, mm) => { const next = copy(input), [, section] = FIELD.get(key); next[section][key] = Math.round((next[section][key] + mm) * 1e6) / 1e6; return next; };

// the point each piece grades about, in the drawing of one draft
function referenceOf(project, group) {
  const byId = new Map(project.entities.map(e => [e.id, e])), members = group.entityIds.map(id => byId.get(id)).filter(Boolean);
  const grain = members.find(e => e.layer === 'grain'), crotch = members.find(e => e.name === group.name + ' · 裆线平量');
  if (grain && crotch) return { x: grain.points[0].x, y: crotch.points[0].y };
  const pts = group.contours[0].entityIds.flatMap(id => byId.get(id)?.points || []);
  return { x: (Math.min(...pts.map(p => p.x)) + Math.max(...pts.map(p => p.x))) / 2, y: (Math.min(...pts.map(p => p.y)) + Math.max(...pts.map(p => p.y))) / 2 };
}
/** The points that carry rules, relative to their piece's point, keyed by piece, line name and order; and the notches in order. */
function gradePlaces(project) {
  const byId = new Map(project.entities.map(e => [e.id, e])), lines = new Map(), notches = [], refs = new Map(), owner = new Map(), byName = new Map();
  for (const group of project.groups) {
    const ref = referenceOf(project, group), seen = new Map(); refs.set(group.id, ref); byName.set(group.name, ref);
    for (const id of group.entityIds) {
      const e = byId.get(id); owner.set(id, group);
      if (!e || e.type === 'text' || e.derivedFrom || e.notchFrom || e.mark) continue;
      const stations = stationsOf(e); if (!stations) continue;
      const name = group.name + '|' + e.name, n = (seen.get(name) || 0) + 1; seen.set(name, n);
      const rel = p => ({ x: p.x - ref.x, y: p.y - ref.y });
      lines.set(name + '|' + n, { entity: e, points: stations.points.map(rel), drawn: e.points.map(rel) });
    }
  }
  for (const recipe of project.notches || []) {
    const base = byId.get(recipe.baseEntityId), group = owner.get(recipe.baseEntityId); if (!base || !group) continue;
    const metrics = pathMetrics(base), along = recipe.mode === 'end' ? metrics.total - recipe.position : recipe.mode === 'ratio' ? metrics.total * recipe.position / 100 : recipe.position;
    const p = stationOnPath(metrics, Math.max(0, Math.min(metrics.total, along)), { pointOnly: true }).point, ref = refs.get(group.id);
    notches.push({ recipe, point: { x: p.x - ref.x, y: p.y - ref.y } });
  }
  return { lines, notches, refs: byName };
}
const UNIT_FRACTIONS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20];
function termText(c, name) {
  const a = Math.abs(c); if (a < 5e-5) return '';
  const sign = c < 0 ? '-' : '+';
  if (Math.abs(a - 1) < 5e-5) return sign + name;
  const n = UNIT_FRACTIONS.find(k => Math.abs(a - 1 / k) < 5e-5); if (n) return sign + name + '/' + n;
  return sign + (+a.toFixed(4)) + '*' + name;
}
const formulaOf = (rates, axis) => { const text = Object.keys(rates).map(key => termText(rates[key][axis], FIELD.get(key)[2])).join(''); return text.startsWith('+') ? text.slice(1) : text; };

/**
 * The grading plan of a whole trouser and how its sizes came out. `project` is the drafted trouser (its pieces, lines, notches);
 * `draft(input)` drafts the trouser for another input and returns { project } (pants-set.mjs, geometry only).
 */
export function gradeTrouser(input, project, { draft, makeId, roles, params }) {
  const g = input.grading, sizes = sizeInputs(input), baseIndex = g.sizes.indexOf(g.base), base = gradePlaces(project);
  const varying = GRADE_FIELDS.filter(([key]) => g.steps[key]).map(f => f[0]), rates = new Map(), notchRates = base.notches.map(() => ({}));
  const placesOf = (key, mm) => { try { return gradePlaces(draft(shifted(input, key, mm)).project); } catch (error) { return { error }; } };
  // the stations of a line in another draft that match the base's: the same points, or the two ends where the base has a straight line
  // and the other draft a curve (a straight leg whose knee alone was moved)
  const matching = (other, count) => !other ? null : other.points.length === count ? other.points : count === 2 ? [other.points[0], other.points.at(-1)] : null;
  const structure = (places, label) => {
    for (const [name, line] of base.lines) if (!matching(places.lines.get(name), line.points.length)) throw Error('放码时“' + name.split('|')[1] + '”在' + label + '里的线和基码不一样，不能推出规则。');
    if (places.notches.length !== base.notches.length) throw Error('放码时' + label + '的刀口和基码不一样多。');
  };
  for (const key of varying) {
    const step = g.steps[key], up = placesOf(key, step), down = placesOf(key, -step), label = FIELD.get(key)[5];
    if (up.error && down.error) throw Error('放码时' + label + '加或减一个档差都生成不了纸样：' + up.error.message);
    const hi = up.error ? base : up, lo = down.error ? base : down, span = (up.error ? 0 : step) + (down.error ? 0 : step);
    structure(hi, label + (up.error ? '' : '加一档')); structure(lo, label + (down.error ? '' : '减一档'));
    for (const [name, line] of base.lines) {
      const list = rates.get(name) || line.points.map(() => ({})), a = matching(hi.lines.get(name), line.points.length), b = matching(lo.lines.get(name), line.points.length);
      line.points.forEach((p, i) => { list[i][key] = { x: (a[i].x - b[i].x) / span, y: (a[i].y - b[i].y) / span }; }); rates.set(name, list);
    }
    base.notches.forEach((n, i) => { notchRates[i][key] = { x: (hi.notches[i].point.x - lo.notches[i].point.x) / span, y: (hi.notches[i].point.y - lo.notches[i].point.y) / span }; });
  }
  // the plan
  const anchors = [];
  // a grain line has no rules: ET keeps it where it stands in the base size (its file keeps the grain line in the piece record,
  // with no place for a rule)
  for (const [name, line] of base.lines) if (line.entity.layer !== 'grain') rates.get(name)?.forEach((r, index) => { const x = formulaOf(r, 'x'), y = formulaOf(r, 'y'); if (x || y) anchors.push({ entityId: line.entity.id, index, stations: line.points.length, x, y, axisX: [1, 0], axisY: [0, 1] }); });
  // every notch has a rule, 0 where it does not move: a notch without a rule keeps its distance from the start of its line (in ET too)
  const notchRules = base.notches.map((n, i) => { const x = formulaOf(notchRates[i], 'x'), y = formulaOf(notchRates[i], 'y'); return { notchId: n.recipe.id, x: x || y ? x : '0', y, axisX: [1, 0], axisY: [0, 1] }; });
  const valueOf = ([key, section, , ease]) => input[section][key] + (ease ? input.rules[ease] : 0);
  const rows = GRADE_FIELDS.filter(f => f[1] !== 'parts' || g.steps[f[0]]).map(f => ({ name: f[2], values: Array.from({ length: 50 }, (_, slot) => slot === 49 ? 0 : Math.round((valueOf(f) + (slot - 9) * g.steps[f[0]]) * 1e4) / 1e5) }));
  const others = sizes.filter(s => s.offset !== 0).map(s => ({ id: makeId(), label: s.label, step: s.offset, slot: 9 + s.offset }));
  const plan = normalizeGradingPlan({ name: '整套放码 ' + g.sizes.join(' '), baseSize: g.base, interpolation: 'fixed', method: 'table', rules: [],
    sources: project.entities.filter(e => !e.derivedFrom && !e.notchFrom).map(gradeSource), sizes: others,
    sizeTable: { unit: 'cm', activeSeries: 0, baseSlot: 9, series: [[], [], [], [], []], rows }, anchors, notchRules });
  // every size, made by the rules as ET makes it, against drafting it directly; and its delivery checks
  const withPlan = { ...project, gradingPlans: [{ id: 'grading-check', ...plan }] }, report = [];
  for (const s of sizes) {
    if (s.offset === 0) { report.push({ label: s.label, offset: 0, base: true }); continue; }
    const size = others.find(o => o.label === s.label), made = generateGradedSize(withPlan, withPlan.gradingPlans[0], size.id), direct = draft(s.input), exact = gradePlaces(direct.project);
    const byId = new Map(made.project.entities.map(e => [e.id, e])); let worst = { mm: 0 };
    for (const [name, line] of base.lines) {
      if (line.entity.layer === 'grain') continue;   // where a grain line stands does not change the piece
      const other = exact.lines.get(name), drawn = byId.get(line.entity.id); if (!other || !drawn) continue;
      // the line of the size made by the rules, about its piece's point (which stays where it is in the base), against the line of
      // the size drafted directly, about its piece's point in that draft
      const ref = base.refs.get(name.split('|')[0]), mine = drawn.points.map(p => ({ x: p.x - ref.x, y: p.y - ref.y }));
      const mm = Math.max(...mine.map(p => nearest(p, other.drawn)), ...other.drawn.map(p => nearest(p, mine)));
      if (mm > worst.mm) worst = { mm, piece: name.split('|')[0], line: name.split('|')[1] };
    }
    const checks = pantsDeliveryChecks(made.project, roles, direct.params || params), open = checks.filter(c => c.status !== 'ok');
    report.push({ label: s.label, offset: s.offset, maxDifferenceMm: Math.round(worst.mm * 1000) / 1000, ...(worst.mm > .05 ? { worstPiece: worst.piece, worstLine: worst.line } : {}),
      delivery: { passed: checks.length - open.length, review: open.filter(c => c.status === 'review').map(c => c.name), failed: open.filter(c => c.status === 'fail').map(c => c.name) }, warnings: warningsOf(made) });
  }
  return { plan, report: { schema: GRADING_SCHEMA, sizes: report, baseSize: g.base, rules: anchors.length, notchRules: notchRules.length, rows: rows.map(r => r.name), steps: g.steps } };
}
// the warnings of a made size, without the outline check's note when all it found is that it could not prove two ET curves never cross
// (it is cautious with such curves; the gaps it measured are a hundred-thousandth of a millimetre)
function warningsOf(made) {
  const real = made.inspection.results.filter(r => r.status !== 'within-tolerance' && ((r.maxGap || 0) > .1 || (r.issues || []).some(i => i.evidence !== 'inconclusive')));
  return made.summary.warnings.filter(w => !/项轮廓检查需核对/.test(w)).concat(real.length ? [real.length + ' 处轮廓有大于 0.1 mm 的缺口或交叉，需核对。'] : []);
}
function nearest(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0; best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y)); }
  return pts.length === 1 ? Math.hypot(pts[0].x - p.x, pts[0].y - p.y) : best;
}
