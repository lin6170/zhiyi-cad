/**
 * Offline instruction parser for the assistant. No model is involved: a fixed
 * vocabulary of patternmaking terms is recognised and turned into commands of
 * the shared command set. What it does not recognise is reported, never guessed.
 * Lengths in the produced commands are millimetres; numbers without a unit are
 * read as centimetres and the reply says so.
 */
import { draftFields, defaultDraftInput, DRAFT_COMMAND } from './pants-draft.mjs';

export const PLAN_SCHEMA = 'zhiyi-agent-plan/v1';
export const LOCAL_PLANNER = Object.freeze({ id: 'local', name: '本机指令', version: 'zhiyi-local-planner/v1' });

// ---------------------------------------------------------------- vocabulary
const INFO = {};
for (const [type, fields] of Object.entries(draftFields)) for (const [key, label, value, min, max, , unit] of fields) INFO[key] = { key, type, label, value, min, max, percent: unit === 'percent' };
// [field, names, options]. "girth": a body girth whose finished size adds the named ease.
// "garment": the name denotes the finished garment measure; the stored value is the measure minus the named ease.
const VOCABULARY = [
  ['waist', ['人体腰围', '净腰围', '腰围', '腰'], { girth: 'waistEase' }],
  ['waist', ['成衣腰围', '成品腰围'], { garment: 'waistEase' }],
  ['hip', ['人体臀围', '净臀围', '臀围', '坐围', '臀'], { girth: 'hipEase' }],
  ['hip', ['成衣臀围', '成品臀围'], { garment: 'hipEase' }],
  ['thigh', ['人体大腿围', '净大腿围', '大腿围', '腿根围', '脾围', '大腿'], { girth: 'thighEase' }],
  ['thigh', ['成衣大腿围', '成品大腿围', '成衣脾围', '成品脾围'], { garment: 'thighEase' }],
  ['hipDepth', ['腰线至臀线', '腰至臀', '臀高', '臀深']],
  ['crotchDepth', ['坐姿裆深', '人体裆深', '裆深', '股上']],
  ['crotchDepth', ['立裆', '上裆', '直裆'], { garment: 'riseEase' }],
  ['kneeDepth', ['腰线至膝线', '腰至膝', '膝位', '膝线', '膝长']],
  ['length', ['目标裤长', '裤子长', '裤长', '外侧长', '侧缝长']],
  ['waistEase', ['腰围松量', '腰围放松量', '腰松量']],
  ['hipEase', ['臀围松量', '臀围放松量', '臀松量']],
  ['thighEase', ['大腿围松量', '大腿松量', '脾围松量']],
  ['kneeCirc', ['成衣膝围', '膝围']],
  ['hemCirc', ['成衣脚口围', '裤脚口围', '脚口围', '裤脚口', '脚口', '裤口']],
  ['riseEase', ['裆深放松', '裆深松量', '立裆松量']],
  ['seamAllowance', ['一般缝份', '缝份', '缝边', '止口', '做缝', '放缝']],
  ['hemAllowance', ['脚口折边', '裤脚折边', '裤口折边', '脚口贴边', '折边', '卷边']],
  ['frontShare', ['前片分配比例', '前片比例']],
  ['frontCrotchShare', ['前裆伸出分配', '前裆比例']],
  ['backRaise', ['后腰中心抬高', '后腰抬高', '后腰起翘', '后翘']],
  ['frontInset', ['前腰中心内移', '前腰内移', '前中内移']],
  ['backShift', ['后腰中心横移', '后中横移']],
  ['frontDartLength', ['前省长']],
  ['backDartLength', ['后省长']],
  ['frontDartWidth', ['前片省量', '前省量', '前省大', '前省']],
  ['backDartWidth', ['后片省量', '后省量', '后省大', '后省']],
];
const TERMS = new Map();
for (const [key, names, options = {}] of VOCABULARY) for (const name of names) TERMS.set(name, { key, name, ...options });
/** The words the offline parser understands, per drafting field. */
export const knownTerms = () => VOCABULARY.map(([key, names]) => ({ field: key, label: INFO[key].label, names: [...names] }));
const SEAM_FIELDS = new Set(['seamAllowance', 'hemAllowance']), HALF_HINT = new Set(['kneeCirc', 'hemCirc']);
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAMES = [...TERMS.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
const NUM = '(\\d+(?:\\.\\d+)?(?:\\/\\d+)?)', UNIT = '(mm|毫米|cm|厘米|公分|英寸|吋|inch|in|"|″|市寸|寸|m|米|%)';
const UNITS = { mm: 1, 毫米: 1, cm: 10, 厘米: 10, 公分: 10, m: 1000, 米: 1000, 英寸: 25.4, 吋: 25.4, inch: 25.4, in: 25.4, '"': 25.4, '″': 25.4, 市寸: 100 / 3 };
const OP_BEFORE = '(加长|加大|加宽|增加|增大|放大|放长|减少|减短|减小|缩短|缩小|收小|加|减|放|收)';
const OP_AFTER = '(加长|加大|加宽|增加|增大|放大|放长|放宽|改大|改长|改宽|调大|减少|减短|减小|缩短|缩小|收小|改小|改短|改窄|调小|等于|加|减|放|收|多|少|长|短|大|小|改|调|设|定|\\+|-)';
const UP = /^(加长|加大|加宽|增加|增大|放大|放长|放宽|改大|改长|改宽|调大|加|放|多|长|大|\+)$/, DOWN = /^(减少|减短|减小|缩短|缩小|收小|改小|改短|改窄|调小|减|收|少|短|小|-)$/;
const CHANGE = new RegExp(OP_BEFORE + '?(' + NAMES + ')的?(?:尺寸|大小|宽度)?\\s*' + OP_AFTER + '?\\s*(到|至|成|为|是|=|:)?\\s*' + NUM + '\\s*' + UNIT + '?', 'g');
const SEAM_BEFORE = new RegExp(NUM + '\\s*' + UNIT + '?\\s*的?(缝份|缝边|止口|做缝)');
const LENGTH = new RegExp(NUM + '\\s*' + UNIT + '?');
const OTHER_GARMENTS = /(裙|衬衫|衬衣|上衣|西装|西服|外套|夹克|马甲|背心|t恤|卫衣|大衣|风衣|连衣|旗袍|内衣|文胸|帽|袖子)/;
// A request for something new: "画…", "生成…", or 做 / 打 / 出 / 来 / 要 followed by a measure word. "复制" and "导出" are not such requests.
const NEW_VERB = '(?:画|生成|新建|设计|制作|打版|打板|起版|起板|(?:做|打|出|来|要|起)(?=一|个|条|套|件|款))';
// "画一条直筒裤", "做条裤子": a new pair of trousers, not 裤长 / 裤脚 / 裤襻 and the like.
const NEW_PANTS = new RegExp(NEW_VERB + '[^,;]{0,8}?(直筒裤|西裤|长裤|裤子|裤(?![长脚口片腰襻袢耳头]))');
const NEW_OTHER = new RegExp(NEW_VERB + '[^,;]{0,8}?' + OTHER_GARMENTS.source);

// ---------------------------------------------------------------- small helpers
class Reply extends Error { constructor(result) { super(result.reply); this.plan = result; } }
const plan = (reply, extra = {}) => ({ schema: PLAN_SCHEMA, planner: LOCAL_PLANNER.id, reply, steps: [], actions: [], assumptions: [], questions: [], choices: [], ...extra });
const refuse = (reply, extra) => { throw new Reply(plan(reply, extra)); };
const ask = (question, choices = [], extra = {}) => { throw new Reply(plan(question, { questions: [question], choices, ...extra })); };
const cm = mm => String(Math.round(mm * 100) / 1000);
const show = (key, value) => INFO[key]?.percent ? String(value) + '%' : cm(value) + ' cm';
const tenth = value => Math.round(value * 10) / 10;
const quoted = pieces => pieces.map(p => '“' + p.name + '”').join('、');
const FIT = [{ id: 'view.fit' }];

/** Half-width digits, letters and punctuation; one kind of quote; lower case. */
export function normalize(text) {
  return [...String(text)].map(c => { const code = c.codePointAt(0); return code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : code === 0x3000 ? ' ' : c; }).join('')
    .replace(/[“”「」『』]/g, '"').replace(/[‘’]/g, "'").replace(/、/g, ',').replace(/[。!]/g, ';').replace(/\s+/g, ' ').trim().toLowerCase();
}
function toNumber(raw) { if (!raw.includes('/')) return Number(raw); const [a, b] = raw.split('/').map(Number); if (!b) refuse('分数“' + raw + '”的分母不能为 0。'); return a / b; }
/** A length in millimetres. Without a unit the number is centimetres. */
function toMm(raw, unit) {
  if (unit === '寸') ask('“寸”是英寸还是市寸？请写“英寸”或“市寸”。');
  if (unit === '%') refuse('这里需要长度，不能用百分比“' + raw + '%”。');
  return toNumber(raw) * (unit ? UNITS[unit] : 10);
}

// ---------------------------------------------------------------- field changes
/** Every "name [operator] number [unit]" in the sentence, in order, with the text that no rule consumed. */
function extractChanges(sentence) {
  const changes = []; let rest = sentence;
  for (const m of sentence.matchAll(CHANGE)) {
    const [whole, before, name, after, to, raw, unit] = m, term = TERMS.get(name), info = INFO[term.key];
    if (before && after) continue;
    const op = before || after || '', seam = SEAM_FIELDS.has(term.key);
    // "加缝份 1" and "缝份加 1" give a width; so does anything followed by 到 / 成 / 为.
    const mode = to || !op || /^(改|调|设|定|等于)$/.test(op) || (seam && /^(加|放)$/.test(op)) ? 'set' : UP.test(op) ? 'up' : DOWN.test(op) ? 'down' : 'set';
    if (info.percent && unit && unit !== '%') refuse(info.label + '是百分比，不能写成“' + raw + unit + '”。');
    if (!info.percent && unit === '%') refuse(info.label + '是长度，不能写成百分比。');
    changes.push({ term, mode, raw, unit: unit || null, value: info.percent ? toNumber(raw) : toMm(raw, unit), text: whole.trim(), widthByAdding: seam && !to && /^(加|放)$/.test(op) });
    rest = rest.replace(whole, ' ');
  }
  return { changes, rest };
}
const NOISE = /(成衣尺寸|成品尺寸|净尺寸|人体尺寸|成人|基础|直筒裤|直筒|裤子|西裤|长裤|生成|新建|尺寸|成衣|成品|净体|人体|帮我|给我|麻烦|谢谢|你好|请|把|将|画|做|打版|打板|打|出|制|来|要|一条|一套|一个|一下|条|套|个|件|按|用|的|和|及|与|并且|并|同时|修改|调整|改|调|纸样|裤|版|板|新|再|也|都|是|为|净|,|;|:|\.|\(|\)|"|\s)/g;
/** Words that no rule consumed, quoted back to the user. */
function unrecognised(rest) { return rest.replace(NOISE, ' ').replace(/\s+/g, ' ').trim(); }

// ---------------------------------------------------------------- canvas lookups
function withoutNames(sentence, scene) { let text = sentence; for (const piece of [...(scene.pieces || [])].sort((a, b) => b.name.length - a.name.length)) { const name = normalize(piece.name); if (name) text = text.split(name).join(' '); } return text; }
function namedPieces(sentence, scene, context) {
  const pieces = scene.pieces || [], found = [];
  if (/(所有|全部|每个|每片|各片|各个)/.test(sentence)) return { pieces: [...pieces], how: 'all' };
  let text = sentence;
  for (const piece of [...pieces].sort((a, b) => b.name.length - a.name.length)) { const name = normalize(piece.name); if (name && text.includes(name)) { found.push(piece); text = text.split(name).join(' '); } }
  for (const [alias, full] of [['前片', '前裤片'], ['后片', '后裤片']]) if (text.includes(alias)) for (const piece of pieces) if (piece.name === full && !found.includes(piece)) found.push(piece);
  if (found.length) return { pieces: found, how: 'named' };
  if (/(选中|所选|选择的|选的)/.test(sentence)) { const ids = context.selection?.pieceIds || []; return { pieces: pieces.filter(p => ids.includes(p.id)), how: 'selection' }; }
  if (/(它|这个|这片|刚才|刚画|刚建|上一个|那个)/.test(sentence)) { const ids = context.last?.pieceIds || []; return { pieces: pieces.filter(p => ids.includes(p.id)), how: 'last' }; }
  return { pieces: [], how: 'none' };
}
/** The pieces an instruction is about. One piece on the canvas needs no name; several lead to a question. */
function targetPieces(sentence, scene, context, question) {
  const { pieces, how } = namedPieces(sentence, scene, context);
  if (pieces.length) return pieces;
  if (how === 'selection') refuse('画布上没有选中的裁片。请先在画布上选中裁片，或直接说出裁片名称。');
  if (how === 'last') refuse('没有找到刚才建立的裁片。请说出裁片名称。');
  if (!scene.pieces?.length) refuse('画布上还没有裁片。');
  if (scene.pieces.length === 1) return [scene.pieces[0]];
  ask(question, [...scene.pieces.slice(0, 6).map(p => ({ label: p.name, send: p.name + ' ' + sentence })), { label: '全部裁片', send: '所有裁片 ' + sentence }]);
}
/** Free space to the right of everything on the canvas, top edges aligned. */
function freePlace(scene, height) { const box = scene.bbox; return box ? { x: tenth(box.maxX + 100), y: tenth(box.maxY - height) } : { x: 0, y: 0 }; }

// ---------------------------------------------------------------- drafting from measurements
const BASIS_GARMENT = /(成衣|成品)尺寸|按成衣|按成品/, BASIS_BODY = /净体|净尺寸|人体尺寸|按净/;
function basisOf(sentence, context) { return BASIS_GARMENT.test(sentence) ? 'garment' : BASIS_BODY.test(sentence) ? 'body' : context.preferences?.measureBasis || null; }
/** The millimetre value of a change, rounded to the precision of the drafting rules. A bare number that only fits as millimetres is read as millimetres. */
function resolveValue(change, notes, absolute) {
  const info = INFO[change.term.key]; let value = change.value;
  if (absolute && !info.percent && !change.unit && !change.term.garment && (value < info.min || value > info.max)) {
    const asMm = toNumber(change.raw); if (asMm >= info.min && asMm <= info.max) { value = asMm; notes.push(change.term.name + ' ' + change.raw + ' 没写单位，按毫米理解（按厘米会超出范围）。'); }
  }
  const rounded = tenth(value); if (Math.abs(rounded - value) > 1e-9) notes.push(change.term.name + ' ' + change.raw + (change.unit || '') + ' = ' + Number(value.toFixed(3)) + ' mm，按 ' + rounded + ' mm 处理（规则精度 0.1 mm）。');
  return rounded;
}
function checkRange(key, value) {
  const info = INFO[key];
  if (value >= info.min && value <= info.max) return;
  const hint = HALF_HINT.has(key) && value * 2 >= info.min && value * 2 <= info.max ? '这里要的是单腿整圈尺寸；如果 ' + show(key, value) + ' 是平量宽度，请改说“' + info.label.replace('成衣', '') + ' ' + cm(value * 2) + '”。' : '请核对数值和单位。';
  refuse(info.label + ' ' + show(key, value) + ' 超出可用范围（' + show(key, info.min) + ' 至 ' + show(key, info.max) + '）。' + hint);
}
const DISCARD = /,?\s*(并且|并|同时)?(确认)?(丢弃|放弃|覆盖|不保留)(这些|之前的|原来的|全部)?手工(修改|改动)/;
/** Extra parameter and a warning when the user has said that manual edits may be discarded. */
function discarding(context, notes) {
  if (!context.discardManualEdits) return {};
  notes.unshift('会丢弃这套纸样生成后的手工修改，例如单独改过的缝份、旋转、镜像和改名。');
  return { discardManualEdits: true };
}
function planDraft(sentence, scene, context, changes, rest) {
  const drafts = scene.drafts || [], draft = drafts.at(-1) || null;
  const creating = NEW_PANTS.test(sentence) || (!draft && changes.length > 0 && changes.every(c => c.mode === 'set') && /裤/.test(sentence));
  if (!creating && !draft) refuse('画布上还没有按尺寸生成的纸样，所以没有可以修改的尺寸。可以先说“画一条直筒裤，腰围76 臀围96 裤长102”。');
  const strange = unrecognised(rest);
  if (strange) refuse('有一部分没有认出来：“' + strange + '”。我认识的尺寸名称有：' + TERM_LIST + '。请换成这些名称，或去掉这一部分。');
  const basis = basisOf(sentence, context), notes = [], current = creating ? defaultDraftInput() : JSON.parse(JSON.stringify(draft.input));
  const next = JSON.parse(JSON.stringify(current)), touched = new Map();
  if (changes.some(c => c.term.girth && c.mode === 'set') && !basis) ask('这些围度是人体净尺寸，还是成衣尺寸？净尺寸会再加松量；成衣尺寸按所给数值出样。之后都按这次的选择理解，随时可以说“按净尺寸”或“按成衣尺寸”更换。',
    [{ label: '成衣尺寸', send: '按成衣尺寸' }, { label: '人体净尺寸', send: '按净尺寸' }], { pending: { text: sentence } });
  // Eases first, so that a finished measure given in the same sentence uses the new ease.
  const ordered = [...changes].sort((a, b) => Number(INFO[b.term.key].type === 'rules') - Number(INFO[a.term.key].type === 'rules'));
  for (const change of ordered) {
    const { key, girth, garment } = change.term, info = INFO[key], easeKey = garment || (girth && basis === 'garment' ? girth : null);
    if (touched.has(key)) refuse(info.label + '在这句话里出现了两次（“' + touched.get(key) + '”和“' + change.text + '”），请只保留一个。');
    touched.set(key, change.text);
    if (change.mode !== 'set') {
      if (creating) refuse('新生成纸样需要具体尺寸；“' + change.text + '”这样的加减只能用于已经生成的纸样。');
      next[info.type][key] = tenth(current[info.type][key] + (change.mode === 'up' ? 1 : -1) * resolveValue(change, notes, false));
    } else {
      const value = resolveValue(change, notes, true);
      next[info.type][key] = easeKey ? tenth(value - next.rules[easeKey]) : value;
      if (easeKey) notes.push(change.term.name + ' ' + cm(value) + ' cm 按成衣尺寸理解：' + info.label + ' ' + cm(next[info.type][key]) + ' cm + ' + INFO[easeKey].label + ' ' + cm(next.rules[easeKey]) + ' cm。');
    }
    checkRange(key, next[info.type][key]);
  }
  const changed = Object.keys(INFO).filter(key => next[INFO[key].type][key] !== current[INFO[key].type][key]);
  for (const change of changes) if (change.widthByAdding && !creating) notes.push('“' + change.text + '”按宽度 ' + cm(change.value) + ' cm 理解；要在原来基础上加宽，请说“' + change.term.name + '加大 ' + cm(change.value) + '”。');
  if (creating) {
    const given = [...new Set(changes.map(c => c.term.key))], missing = Object.keys(INFO).filter(key => INFO[key].type === 'measurements' && !given.includes(key));
    if (missing.length) notes.push('没有提供' + missing.map(key => INFO[key].label).join('、') + '，暂用示例值 ' + missing.map(key => cm(current.measurements[key])).join('、') + ' cm，请核对。');
    notes.push('制版公式是演示规则，尚未经师傅试衣确认；松量和各项系数可以继续用文字调整。');
    const finished = ['waist', 'hip'].map(key => INFO[key].label.replace('人体', '成衣') + ' ' + cm(next.measurements[key] + next.rules[key + 'Ease']) + ' cm').join('，');
    const echo = changes.map(c => c.term.name + ' ' + (INFO[c.term.key].percent ? c.value + '%' : cm(resolveValue(c, [], true)) + ' cm')).join('，');
    return plan('按尺寸生成成人基础直筒裤的前后片：' + (given.length ? echo : '全部使用示例尺寸') + '。出样后' + finished + '。',
      { steps: [{ type: DRAFT_COMMAND, parameters: next, as: 'draft' }], assumptions: notes, actions: FIT });
  }
  if (!changes.length) return null;
  if (!changed.length) refuse('这些尺寸和现在的纸样一样，没有需要修改的地方。');
  if (drafts.length > 1) notes.push('画布上有 ' + drafts.length + ' 套按尺寸生成的纸样，这次修改最近生成的一套。');
  const parameters = { draftId: draft.id, ...discarding(context, notes) };
  for (const key of changed) (parameters[INFO[key].type] ??= {})[key] = next[INFO[key].type][key];
  return plan('按新尺寸重算纸样：' + changed.map(key => INFO[key].label + ' ' + show(key, current[INFO[key].type][key]) + ' → ' + show(key, next[INFO[key].type][key])).join('，') + '。',
    { steps: [{ type: 'pattern.updateDraft', parameters }], assumptions: notes });
}

// ---------------------------------------------------------------- seam allowances
const SEAM_WORD = /(缝份|缝边|止口|做缝|放缝)/;
/** A seam width given in the sentence: millimetres, null when there is none, undefined when it is a relative change. */
function seamWidth(sentence, changes) {
  const change = changes.find(c => c.term.key === 'seamAllowance');
  if (change) return change.mode === 'set' ? change.value : undefined;
  const m = sentence.match(SEAM_BEFORE); return m ? toMm(m[1], m[2]) : null;
}
function checkSeam(width) { if (!(width > 0 && width <= 300)) refuse('缝份宽度须大于 0 且不超过 30 cm。要去掉缝份请说“去掉缝份”。'); return width; }
function planSeam(sentence, scene, context, changes) {
  if (!SEAM_WORD.test(sentence)) return null;
  const removing = /(去掉|删除|删掉|取消|不要|清除|去除|不加)/.test(sentence), named = namedPieces(sentence, scene, context), drafts = scene.drafts || [], all = scene.pieces || [];
  // "裤长加2，缝份1.2" without a piece name: the seam is one of the drafting changes.
  if (named.how === 'none' && drafts.length && !removing && changes.some(c => c.term.key !== 'seamAllowance')) return null;
  const pieces = named.how === 'none' && drafts.length && all.every(p => p.draftId) ? all.filter(p => p.draftId === drafts.at(-1).id)
    : targetPieces(sentence, scene, context, removing ? '要去掉哪个裁片的缝份？' : '要给哪个裁片加缝份？');
  // A drafted pattern whose pieces are all meant is changed through its drafting rules, so it stays linked to its measurements.
  const whole = drafts.filter(d => d.pieceIds.every(id => pieces.some(p => p.id === id))), inWhole = new Set(whole.flatMap(d => d.pieceIds)), others = pieces.filter(p => !inWhole.has(p.id));
  const manual = others.some(p => p.draftId) ? ['其中有按尺寸生成的裁片；只改其中一片会被视为手工修改，之后按尺寸重算时需要确认丢弃这些改动。'] : [];
  const discard = whole.length ? discarding(context, manual) : {};
  for (const change of changes) if (change.widthByAdding) manual.push('“' + change.text + '”按宽度 ' + cm(change.value) + ' cm 理解。');
  if (removing) {
    const withSeam = others.filter(p => p.seam), live = whole.filter(d => d.input.rules.seamAllowance || d.input.rules.hemAllowance);
    if (!withSeam.length && !live.length) refuse((pieces.length === 1 ? '“' + pieces[0].name + '”' : '这些裁片') + '没有缝份。');
    return plan('去掉' + quoted([...all.filter(p => live.some(d => d.pieceIds.includes(p.id))), ...withSeam]) + '的缝份' + (live.length ? '和脚口折边' : '') + '，净样线保留。',
      { steps: [...live.map(d => ({ type: 'pattern.updateDraft', parameters: { draftId: d.id, ...discard, rules: { seamAllowance: 0, hemAllowance: 0 } } })), ...withSeam.map(p => ({ type: 'seam.remove', parameters: { groupId: p.id } }))], assumptions: manual });
  }
  const width = seamWidth(sentence, changes), alone = whole.length === 1 && !others.length;
  if (alone && width !== null) return null; // one drafted pattern: handled with the other drafting changes
  if (width === undefined) refuse('缝份的加减只适用于按尺寸生成的整套纸样；其他裁片请直接说宽度，例如“缝份 1.2”。');
  if (width === null) ask('缝份要多宽？例如“缝份 1”（厘米）。');
  checkSeam(width);
  if (changes.some(c => c.term.key !== 'seamAllowance')) refuse('这句话同时改了尺寸和几个裁片的缝份，请分成两句说。');
  if (whole.length && (width > INFO.seamAllowance.max || Math.abs(tenth(width) - width) > 1e-9)) refuse('按尺寸生成的纸样，一般缝份须在 0 至 ' + cm(INFO.seamAllowance.max) + ' cm 之间，精度 0.1 mm。');
  return plan('给' + quoted(pieces) + '的全部边加 ' + cm(width) + ' cm 缝份。', {
    steps: [...whole.map(d => ({ type: 'pattern.updateDraft', parameters: { draftId: d.id, ...discard, rules: { seamAllowance: width } } })), ...others.map(p => ({ type: 'seam.apply', parameters: { groupId: p.id, width } }))],
    assumptions: [...manual, ...(whole.length ? ['按尺寸生成的裤片只改一般缝份，脚口折边不变。'] : []), ...(others.some(p => p.seam && p.seam.widthsMm.length > 1) ? ['原来各边宽度不同的缝份会统一成这个宽度。'] : [])] });
}

// ---------------------------------------------------------------- shapes
const GENERIC = /^(矩形|长方形|方形|方块|正方形|四边形|图形|形状|线|直线|横线|竖线|水平线|垂直线)$/;
function shapeName(sentence) {
  const explicit = sentence.match(/(?:(?:名称|名字)(?:叫做|叫|为|是|:)?|命名为|叫做|叫)\s*"?([^",;\s]{1,20})"?/); if (explicit) return explicit[1];
  const direct = sentence.match(/(?:画|加|做|新建)(?:一个|一条|一片|一块|个|条|片|块)?(?!一个|一条|一片|一块|个|条|片|块)([^\d,;\s"长宽高边横竖x×*]{1,10})/), after = sentence.match(/的([^\d,;\s的"]{1,10})(?:,|;|$|建|做|加|并|裁片)/);
  for (const m of [direct, after]) { const name = m?.[1].split(/并|建成|做成|加缝|加|然后|再/)[0]; if (name && !GENERIC.test(name)) return name; }
  return null;
}
function rectangleSize(sentence) {
  const pair = sentence.match(new RegExp(NUM + '\\s*' + UNIT + '?\\s*(?:x|×|\\*|乘以|乘)\\s*' + NUM + '\\s*' + UNIT + '?'));
  if (pair) return { width: toMm(pair[1], pair[2] || pair[4]), height: toMm(pair[3], pair[4] || pair[2]), how: '“A×B”按 横向×纵向 理解。' };
  const side = sentence.match(new RegExp('边长\\s*' + NUM + '\\s*' + UNIT + '?')); if (side) return { width: toMm(side[1], side[2]), height: toMm(side[1], side[2]), how: null };
  const dims = {}; for (const m of sentence.matchAll(new RegExp('(长|宽|高)度?\\s*(?:为|是|=|:)?\\s*' + NUM + '\\s*' + UNIT + '?', 'g'))) { if (dims[m[1]] !== undefined) return null; dims[m[1]] = toMm(m[2], m[3]); }
  if (dims.宽 !== undefined && dims.高 !== undefined) return { width: dims.宽, height: dims.高, how: '宽按横向、高按纵向理解。' };
  if (dims.长 !== undefined && dims.宽 !== undefined) return { width: dims.长, height: dims.宽, how: '长按横向、宽按纵向理解。' };
  if (dims.长 !== undefined && dims.高 !== undefined) return { width: dims.长, height: dims.高, how: '长按横向、高按纵向理解。' };
  return null;
}
function planRectangle(sentence, scene, context, changes) {
  if (!/画|加一个|做一个|新建/.test(sentence) || NEW_PANTS.test(sentence)) return null;
  const size = rectangleSize(sentence); if (!size) return null;
  for (const value of [size.width, size.height]) if (!(value > 0 && value <= 5000)) refuse('矩形的边长须大于 0 且不超过 500 cm。');
  const name = shapeName(sentence) || '矩形', place = freePlace(scene, size.height), width = seamWidth(sentence, changes), asPiece = /(裁片|样片)/.test(sentence) || Boolean(width);
  if (width === undefined) refuse('请直接说缝份宽度，例如“缝份 1”。');
  const steps = [{ type: 'draw.rectangle', parameters: { x: place.x, y: place.y, width: tenth(size.width), height: tenth(size.height), name }, as: 'shape' }];
  if (asPiece) steps.push({ type: 'piece.create', parameters: { name, contourEntityIds: ['@shape'] }, as: 'piece' });
  if (width) steps.push({ type: 'seam.apply', parameters: { groupId: '@piece', width: checkSeam(width) } });
  return plan('画“' + name + '”：横向 ' + cm(size.width) + ' cm，纵向 ' + cm(size.height) + ' cm' + (asPiece ? '，建成裁片' : '') + (width ? '，四边加 ' + cm(width) + ' cm 缝份' : '') + '。放在现有图形右侧。',
    { steps, actions: FIT, assumptions: size.how ? [size.how] : [], choices: asPiece ? [] : [{ label: '建成裁片并加 1 cm 缝份', send: '把刚才的图形建成裁片，叫' + name + '，缝份1' }] });
}
function planLine(sentence, scene) {
  if (!/画/.test(sentence) || !/线/.test(sentence) || /(曲线|弧线|布纹)/.test(sentence)) return null;
  const coordinate = '\\(?\\s*(-?\\d+(?:\\.\\d+)?)\\s*,\\s*(-?\\d+(?:\\.\\d+)?)\\s*\\)?', through = sentence.match(new RegExp('从\\s*' + coordinate + '\\s*(?:到|至)\\s*' + coordinate + '\\s*' + UNIT + '?'));
  if (through) {
    if (through[5] === '寸' || through[5] === '%') refuse('坐标请用 mm、cm 或英寸。');
    const scale = through[5] ? UNITS[through[5]] : 10, [x1, y1, x2, y2] = through.slice(1, 5).map(v => tenth(Number(v) * scale));
    if (x1 === x2 && y1 === y2) refuse('直线的两个端点不能重合。');
    return plan('画直线：从 (' + cm(x1) + ', ' + cm(y1) + ') 到 (' + cm(x2) + ', ' + cm(y2) + ') cm，长 ' + cm(Math.hypot(x2 - x1, y2 - y1)) + ' cm。', { steps: [{ type: 'draw.line', parameters: { from: { x: x1, y: y1 }, to: { x: x2, y: y2 } } }], actions: FIT, assumptions: ['坐标 x 向右、y 向上。'] });
  }
  const length = sentence.match(LENGTH); if (!length) ask('这条线要多长？例如“画一条 30 cm 的横线”。');
  const mm = tenth(toMm(length[1], length[2])), vertical = /(竖|垂直|纵)/.test(sentence), place = freePlace(scene, vertical ? mm : 0);
  if (!(mm > 0 && mm <= 5000)) refuse('线长须大于 0 且不超过 500 cm。');
  return plan('画一条 ' + cm(mm) + ' cm 的' + (vertical ? '竖线' : '横线') + '，放在现有图形右侧。', { steps: [{ type: 'draw.line', parameters: { from: { x: place.x, y: place.y }, to: vertical ? { x: place.x, y: tenth(place.y + mm) } : { x: tenth(place.x + mm), y: place.y } } }],
    actions: FIT, assumptions: /(横|水平|竖|垂直|纵)/.test(sentence) ? [] : ['没有说方向，按横线画。'] });
}
function planText(sentence, scene, context, original) {
  const m = original.match(/写(?:上|下|字|文字)*\s*[:：]?\s*["“”'‘’「]([^"“”'‘’」]{1,200})["“”'‘’」]/); if (!m) return null;
  const named = namedPieces(sentence, scene, context), size = sentence.match(new RegExp('字高\\s*' + NUM + '\\s*' + UNIT + '?')), height = size ? tenth(toMm(size[1], size[2])) : 8;
  if (!(height > 0 && height <= 1000)) refuse('字高须大于 0 且不超过 100 cm。');
  const piece = named.pieces[0], at = piece?.bbox ? { x: tenth((piece.bbox.minX + piece.bbox.maxX) / 2), y: tenth((piece.bbox.minY + piece.bbox.maxY) / 2) } : freePlace(scene, height);
  return plan('写文字“' + m[1] + '”，字高 ' + cm(height) + ' cm，' + (piece ? '放在“' + piece.name + '”中间' : '放在现有图形右侧') + '。', { steps: [{ type: 'draw.text', parameters: { text: m[1], at, height } }],
    actions: piece ? [] : FIT, assumptions: piece ? ['文字只是放在裁片范围内，还没有编入这个裁片。'] : [] });
}
function planPieceFromLines(sentence, scene, context, changes) {
  if (!/(建成|做成|设为|定义为|定义成|生成|建立|变成|编成).{0,4}(裁片|样片)|建裁片/.test(sentence)) return null;
  const loose = new Map((scene.looseEntities || []).map(e => [e.id, e])), fromSelection = /(选中|所选|选择的|选的)/.test(sentence);
  const ids = (fromSelection ? context.selection?.entityIds : context.last?.entityIds?.some(id => loose.has(id)) ? context.last.entityIds : context.selection?.entityIds) || [];
  const lines = ids.filter(id => loose.has(id) && loose.get(id).kind !== 'text'), texts = ids.filter(id => loose.get(id)?.kind === 'text');
  if (!lines.length) refuse(fromSelection ? '选中的图元里没有可以作为轮廓的独立线条。请先在画布上选中首尾相接的轮廓线。' : '没有找到可以建成裁片的线条。请先在画布上选中首尾相接的轮廓线，再说“把选中的线建成裁片”。');
  const name = shapeName(sentence.replace(/建成|做成|建立/g, ' ')) || (lines.length === 1 ? loose.get(lines[0]).name : null) || '裁片', width = seamWidth(sentence, changes);
  if (width === undefined) refuse('请直接说缝份宽度，例如“缝份 1”。');
  const steps = [{ type: 'piece.create', parameters: { name, contourEntityIds: lines, ...(texts.length ? { memberEntityIds: texts } : {}) }, as: 'piece' }];
  if (width) steps.push({ type: 'seam.apply', parameters: { groupId: '@piece', width: checkSeam(width) } });
  return plan('把 ' + lines.length + ' 条线建成裁片“' + name + '”' + (texts.length ? '，带上 ' + texts.length + ' 条文字' : '') + '，自动加一条竖直布纹线' + (width ? '，各边加 ' + cm(width) + ' cm 缝份' : '') + '。', { steps });
}

// ---------------------------------------------------------------- piece operations
function planPieceOperation(sentence, scene, context) {
  const bare = withoutNames(sentence, scene), number = bare.match(LENGTH), draftNote = (pieces, verb) => pieces.some(p => p.draftId) ? [verb + '后这套纸样被视为手工修改，再按尺寸重算时需要确认丢弃。'] : [];
  if (/(移动|平移|移|挪)/.test(sentence) && /(左|右|上|下)/.test(bare)) {
    if (!number) ask('要移动多少？例如“向右移动 10”（厘米）。');
    const distance = tenth(toMm(number[1], number[2])), pieces = targetPieces(sentence, scene, context, '要移动哪个裁片？');
    if (!(distance > 0 && distance <= 100000)) refuse('移动距离须大于 0。');
    const dx = /右/.test(bare) ? distance : /左/.test(bare) ? -distance : 0, dy = /上/.test(bare) ? distance : /下/.test(bare) ? -distance : 0, word = [dx > 0 && '右', dx < 0 && '左', dy > 0 && '上', dy < 0 && '下'].filter(Boolean).join('');
    return plan('把' + quoted(pieces) + '向' + word + '移动 ' + cm(distance) + ' cm。', { steps: pieces.map(p => ({ type: 'piece.move', parameters: { groupId: p.id, dx, dy } })) });
  }
  if (/旋转|转动/.test(sentence)) {
    const angle = bare.match(/(\d+(?:\.\d+)?)\s*(?:度|°)?/); if (!angle) ask('要旋转多少度？例如“逆时针旋转 90 度”。');
    const degrees = Number(angle[1]) * (/顺时针/.test(sentence) ? -1 : 1), pieces = targetPieces(sentence, scene, context, '要旋转哪个裁片？');
    if (!(Math.abs(degrees) > 0 && Math.abs(degrees) <= 360)) refuse('旋转角度须大于 0 且不超过 360 度。');
    return plan('把' + quoted(pieces) + (degrees < 0 ? '顺时针' : '逆时针') + '旋转 ' + Math.abs(degrees) + ' 度。', { steps: pieces.map(p => ({ type: 'piece.rotate', parameters: { groupId: p.id, degrees } })),
      assumptions: [.../顺时针|逆时针/.test(sentence) ? [] : ['没有说方向，按逆时针旋转。'], ...draftNote(pieces, '旋转')] });
  }
  if (/镜像|翻转|翻面|对称/.test(sentence)) {
    if (/上下/.test(sentence)) refuse('目前只能左右镜像；上下翻转可以先左右镜像再旋转 180 度。');
    const pieces = targetPieces(sentence, scene, context, '要镜像哪个裁片？');
    return plan('把' + quoted(pieces) + '左右镜像。', { steps: pieces.map(p => ({ type: 'piece.mirror', parameters: { groupId: p.id } })), assumptions: draftNote(pieces, '镜像') });
  }
  if (/复制|拷贝|克隆|再来一片/.test(sentence)) {
    const pieces = targetPieces(sentence, scene, context, '要复制哪个裁片？');
    return plan('复制' + quoted(pieces) + '，副本放在原裁片右侧。', { steps: pieces.map(p => ({ type: 'piece.duplicate', parameters: { groupId: p.id } })), actions: FIT });
  }
  const rename = bare.match(/(?:改名|重命名|命名|改叫|名称改)(?:为|成|叫)?\s*"?([^",;\s]{1,30})"?/);
  if (rename) { const pieces = targetPieces(sentence, scene, context, '要给哪个裁片改名？'); if (pieces.length > 1) refuse('一次只能给一个裁片改名。'); return plan('把“' + pieces[0].name + '”改名为“' + rename[1] + '”。', { steps: [{ type: 'piece.rename', parameters: { groupId: pieces[0].id, name: rename[1] } }] }); }
  if (/(删除|删掉|移除|去掉)/.test(sentence)) {
    const named = namedPieces(sentence, scene, context); if (!named.pieces.length) refuse('要删除哪个裁片？请说出裁片名称，例如“删除' + (scene.pieces?.[0]?.name || '后袋') + '”。没有指明对象时我不会删除任何东西。');
    return plan('删除' + quoted(named.pieces) + '，连同缝份、文字和内部线。应用后可以撤销。', { steps: named.pieces.map(p => ({ type: 'piece.delete', parameters: { groupId: p.id } })) });
  }
  return null;
}

// ---------------------------------------------------------------- other replies
export const EXAMPLES = [
  { label: '按尺寸画直筒裤', send: '画一条直筒裤，腰围76 臀围96 裤长102' },
  { label: '裤长加 2', send: '裤长加2' },
  { label: '缝份改成 1.2', send: '缝份改成1.2' },
  { label: '画后袋并加缝份', send: '画一个后袋 16x18，建成裁片，缝份1' },
];
const HELP = '我可以按一句话完成下面这些事。每次先给出计划，你确认后才改图，随时可以撤销：\n· 按尺寸生成直筒裤：“画一条直筒裤，腰围76 臀围96 裤长102”\n· 改尺寸重算：“裤长加2，腰围减1”“脚口改成40”“后翘2.5”\n· 缝份：“缝份改成1.2”“脚口折边4”“给后袋加1cm缝份”“去掉后袋的缝份”\n· 画部件：“画一个后袋 16x18，建成裁片，缝份1”“画一条30cm的横线”\n· 裁片：“把后袋向右移动10”“复制后袋”“后袋旋转90度”“删除后袋”“把选中的线建成裁片”\n· 其他：“撤销”“重做”“保存为PRJ”“全图显示”“现在的尺寸”\n没写单位的数字按厘米理解，也可以写 mm、cm、英寸。目前用的是本机内置指令，只认识上面这类说法；接入大模型服务后可以理解更自由的描述。';
function describe(scene) {
  const lines = [];
  for (const draft of scene.drafts || []) lines.push('按尺寸生成的直筒裤：' + ['waist', 'hip', 'thigh', 'hipDepth', 'crotchDepth', 'kneeDepth', 'length'].map(key => INFO[key].label + ' ' + cm(draft.input.measurements[key])).join('，') + ' cm；' +
    ['waistEase', 'hipEase', 'kneeCirc', 'hemCirc', 'seamAllowance', 'hemAllowance'].map(key => INFO[key].label + ' ' + cm(draft.input.rules[key])).join('，') + ' cm。');
  for (const piece of scene.pieces || []) lines.push('裁片“' + piece.name + '”：' + (piece.bbox ? '净样外框 ' + cm(piece.bbox.maxX - piece.bbox.minX) + ' × ' + cm(piece.bbox.maxY - piece.bbox.minY) + ' cm，' : '') + (piece.seam ? '缝份 ' + piece.seam.widthsMm.map(cm).join(' / ') + ' cm' : '没有缝份') + '。');
  if (scene.looseEntities?.length) lines.push('另有 ' + scene.looseEntities.length + ' 个不属于裁片的图元。');
  return lines.length ? lines.join('\n') : '画布是空的。可以说“画一条直筒裤，腰围76 臀围96 裤长102”。';
}
const ACTIONS = [
  [/^(撤销|撤回|撤消|退一步|后退一步|取消上一步|undo)$/, 'history.undo', '撤销上一步。'],
  [/^(重做|恢复|恢复上一步|redo)$/, 'history.redo', '重做刚才撤销的一步。'],
  [/^(全图|全图显示|显示全部|适应窗口|看全图|缩放到全部)$/, 'view.fit', '显示全部图形。'],
  [/^(保存|另存|导出|存|输出)(为|成)?(一个|一份)?(et的?(prj)?|prj)(文件|格式)?$/, 'file.savePrj', '打开“保存为 ET PRJ”窗口，在那里核对内容后下载。'],
  [/^(导出|保存|输出)(为|成)?dxf(文件|格式)?$/, 'file.exportDxf', '导出当前图形的 DXF 文件。'],
  [/^(保存|保存工程|存盘|保存文件)$/, 'file.saveProject', '保存工程文件。'],
];

const TERM_LIST = '腰围、臀围、大腿围、臀高、裆深（或立裆）、膝位、裤长、膝围、脚口、缝份、脚口折边、后翘、前省、后省，以及各项松量';
/** A measure without a number, or a number under a name that is not in the vocabulary. */
function unfinished(sentence, scene) {
  const named = sentence.match(new RegExp('(' + NAMES + ')'));
  if (named && !/\d/.test(sentence)) ask('“' + named[1] + '”要改成多少，或者加减多少？例如“' + named[1] + '加2”或“' + named[1] + '改成' + cm(INFO[TERMS.get(named[1]).key].value) + '”。');
  const strange = sentence.match(/([一-龥]{2,6})\s*(?:改成|改为|加|减|为|是|=|:)?\s*\d/);
  if (strange && ((scene.drafts || []).length || /裤/.test(sentence))) refuse('没有认出“' + strange[1] + '”这个尺寸名称。我认识的有：' + TERM_LIST + '。');
  return null;
}

// ---------------------------------------------------------------- entry
function planSentence(sentence, scene, context, original) {
  if (NEW_OTHER.test(sentence) && !NEW_PANTS.test(sentence) && namedPieces(sentence, scene, context).how !== 'named') refuse('目前只有成人基础直筒裤可以按尺寸自动生成。裙装、上衣等款式需要先补充制版规则，或接入大模型服务后由它逐步画线；这两项都在路线图里。现在可以先用“画一个 宽×高 的矩形”这类指令画部件。');
  if (/^(帮助|help|\?|你能做什么|你会什么|怎么用|能做什么|有什么功能|使用说明)\??$/.test(sentence)) return plan(HELP, { choices: EXAMPLES });
  if (/^(现在|当前|目前)?的?(尺寸|参数|状态|情况|画布)(是多少|是什么|怎么样|有什么|有哪些)?\??$/.test(sentence) || /^(画布上)?有(什么|哪些)(裁片|东西|图形)?\??$/.test(sentence)) return plan(describe(scene));
  for (const [pattern, id, reply] of ACTIONS) if (pattern.test(sentence.replace(/\s/g, ''))) return plan(reply, { actions: [{ id }] });
  const { changes, rest } = extractChanges(sentence);
  return planText(sentence, scene, context, original) || planRectangle(sentence, scene, context, changes) || planPieceFromLines(sentence, scene, context, changes) || planSeam(sentence, scene, context, changes)
    || (changes.length || NEW_PANTS.test(sentence) ? planDraft(sentence, scene, context, changes, rest) : null)
    || planLine(sentence, scene) || planPieceOperation(sentence, scene, context) || unfinished(sentence, scene)
    || plan('这句话我还不能执行。目前用的是本机内置指令，只认识固定的说法；说“帮助”可以看到全部例子。接入大模型服务后可以理解更自由的描述。', { choices: EXAMPLES.slice(0, 3), unrecognised: true });
}
/** Plan one user instruction against the current canvas. Never throws for bad input; the reply explains. */
export function planLocally({ text, scene, context = {} }) {
  const original = String(text ?? '').trim(); let source = normalize(original);
  if (!source) return plan('请输入要做的事，例如“画一条直筒裤，腰围76 臀围96 裤长102”。', { choices: EXAMPLES.slice(0, 2) });
  if (source.length > 500) return plan('这句话太长了，请分成几句发送。');
  if (DISCARD.test(source)) { source = source.replace(DISCARD, ' ').replace(/^[\s,]+|[\s,]+$/g, ''); context = { ...context, discardManualEdits: true }; }
  if (context.discardManualEdits && !source) {
    const draft = (scene.drafts || []).at(-1), notes = [];
    return draft ? plan('按记录的尺寸重新生成这套纸样。', { steps: [{ type: 'pattern.updateDraft', parameters: { draftId: draft.id, ...discarding(context, notes) } }], assumptions: notes }) : plan('画布上没有按尺寸生成的纸样。');
  }
  try {
    const basis = /^(按|用|都按|都是|是)?(成衣|成品)(尺寸)?$/.test(source) ? 'garment' : /^(按|用|都按|都是|是)?(净体|净尺寸|人体净尺寸|人体尺寸|净)$/.test(source) ? 'body' : null;
    if (basis) {
      const label = basis === 'garment' ? '成衣尺寸' : '人体净尺寸', pending = context.pending?.text;
      if (!pending) return plan('好的，之后没有特别说明的围度都按' + label + '理解。', { remember: { measureBasis: basis } });
      let result; try { result = planSentence(normalize(pending), scene, { ...context, preferences: { ...context.preferences, measureBasis: basis } }, pending); } catch (error) { if (!(error instanceof Reply)) throw error; result = error.plan; }
      return { ...result, remember: { measureBasis: basis }, assumptions: ['围度按' + label + '理解；随时可以说“按' + (basis === 'garment' ? '净尺寸' : '成衣尺寸') + '”更换。', ...result.assumptions] };
    }
    const sentences = source.split(/;|\n|然后|接着|之后再|,再(?=画|把|给|加|写)/).map(s => s.trim()).filter(Boolean);
    if (sentences.length <= 1) return planSentence(source, scene, context, original);
    const first = planSentence(sentences[0], scene, context, sentences[0]);
    return { ...first, reply: '这句话里有 ' + sentences.length + ' 件事，我先做第一件。' + first.reply, choices: [...sentences.slice(1, 5).map(s => ({ label: '接着：' + (s.length > 14 ? s.slice(0, 14) + '…' : s), send: s })), ...first.choices] };
  } catch (error) {
    if (error instanceof Reply) return error.plan;
    throw error;
  }
}
/** The offline parser as a planner for the assistant. It cannot revise a plan after a failed preview. */
export const localPlanner = Object.freeze({ ...LOCAL_PLANNER, canRevise: false, plan: request => planLocally(request) });
