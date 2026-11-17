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
const NUM = '(\\d+(?:\\.\\d+)?(?:[ \'-]\\d+\\/\\d+|\\/\\d+)?)', UNIT = '(mm|毫米|cm|厘米|公分|英寸|吋|inch|in|"|″|市寸|寸|m|米|%)';
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
// Replies are written in centimetres and rewritten for another unit afterwards; then the centimetres keep enough digits for an exact inch fraction.
const cm = mm => String(bareUnit && bareUnit !== 'cm' ? Math.round(mm * 1e5) / 1e6 : Math.round(mm * 100) / 1000);
const show = (key, value) => INFO[key]?.percent ? String(value) + '%' : cm(value) + ' cm';
const tenth = value => Math.round(value * 10) / 10;
// Drafting rules work in tenths of a millimetre. Free lines keep what was typed: 3/8 inch is 9.525 mm, not 9.5.
const fine = value => Math.round(value * 1e4) / 1e4;
const quoted = pieces => pieces.map(p => '“' + p.name + '”').join('、');
const FIT = [{ id: 'view.fit' }];

/** Half-width digits, letters and punctuation; one kind of quote; lower case. */
export function normalize(text) {
  return [...String(text)].map(c => { const code = c.codePointAt(0); return code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : code === 0x3000 ? ' ' : c; }).join('')
    .replace(/[“”「」『』]/g, '"').replace(/[‘’]/g, "'").replace(/、/g, ',').replace(/[。!]/g, ';').replace(/\s+/g, ' ').trim().toLowerCase();
}
function toNumber(raw) {
  const mixed = raw.match(/^(\d+(?:\.\d+)?)[ '-](\d+)\/(\d+)$/); // 1 3/8, 1-3/8 or, as ET writes it, 1'3/8
  if (mixed) { if (!Number(mixed[3])) refuse('分数“' + raw + '”的分母不能为 0。'); return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]); }
  if (!raw.includes('/')) return Number(raw); const [a, b] = raw.split('/').map(Number); if (!b) refuse('分数“' + raw + '”的分母不能为 0。'); return a / b; }
// The unit of a number written without one, for the sentence in hand: the user's stored choice, or null before they have chosen.
let bareUnit = null, sentenceInHand = '';
const BARE = { cm: 10, inch: 25.4, mm: 1 }, UNIT_WORD = { cm: '厘米', inch: '英寸', mm: '毫米' };
/** Millimetres per bare number. Asks once, with the sentence kept so that it is carried out after the answer. */
function bareScale(raw) {
  if (!bareUnit) ask('“' + raw + '”没有写单位，是厘米还是英寸？我会记住你的选择，以后不再问。', [{ label: '厘米', send: '按厘米' }, { label: '英寸', send: '按英寸' }], { pending: { text: sentenceInHand } });
  return BARE[bareUnit];
}
/** A length in millimetres. A number without a unit is read in the unit the user chose. */
function toMm(raw, unit) {
  if (unit === '寸') ask('“寸”是英寸还是市寸？请写“英寸”或“市寸”。');
  if (unit === '%') refuse('这里需要长度，不能用百分比“' + raw + '%”。');
  return toNumber(raw) * (unit ? UNITS[unit] : bareScale(raw));
}
/** A millimetre value written in the user's unit; inches as sixteenths when they fit. */
function inUnit(mm) {
  if (bareUnit === 'mm') return String(Math.round(mm * 100) / 100);
  if (bareUnit !== 'inch') return String(Math.round(mm * 100) / 1000);
  const value = mm / 25.4, parts = Math.round(value * 16);
  if (Math.abs(value * 16 - parts) > 1e-6) return String(Math.round(value * 1000) / 1000);
  let top = Math.abs(parts) % 16, bottom = 16; const whole = Math.floor(Math.abs(parts) / 16); while (top && top % 2 === 0) { top /= 2; bottom /= 2; }
  return (parts < 0 ? '-' : '') + (top ? (whole ? whole + ' ' : '') + top + '/' + bottom : String(whole));
}
/** The replies are written in centimetres; for another unit every “number cm” in them is rewritten. */
function inChosenUnit(text) {
  if (!bareUnit || bareUnit === 'cm') return text;
  const n = '(-?\\d+(?:\\.\\d+)?)', word = UNIT_WORD[bareUnit], to = v => inUnit(Number(v) * 10);
  return text.replace(new RegExp('\\(' + n + ', ' + n + '\\) 到 \\(' + n + ', ' + n + '\\) cm', 'g'), (_, a, b, c, d) => '(' + to(a) + ', ' + to(b) + ') 到 (' + to(c) + ', ' + to(d) + ') ' + word)
    .replace(new RegExp('\\(' + n + ', ' + n + '\\) cm', 'g'), (_, a, b) => '(' + to(a) + ', ' + to(b) + ') ' + word)
    .replace(new RegExp(n + '((?:(?:、| / | × )' + n.replace('(', '(?:') + ')*) cm', 'g'), (_, first, rest) => to(first) + rest.replace(/-?\d+(?:\.\d+)?/g, to) + ' ' + word);
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
    const asMm = toNumber(change.raw); if (asMm >= info.min && asMm <= info.max) { value = asMm; notes.push(change.term.name + ' ' + change.raw + ' 没写单位，按毫米理解（按' + UNIT_WORD[bareUnit || 'cm'] + '会超出范围）。'); }
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
  // A straight leg has the same round measure at the knee and at the hem. Given only one of the two, a new trouser takes the
  // other from it; in a later change the other stays as it is. Either way the master is told.
  const leg = ['kneeCirc', 'hemCirc'].filter(key => touched.has(key));
  if (leg.length === 1) {
    const given = leg[0], other = given === 'hemCirc' ? 'kneeCirc' : 'hemCirc', short = key => INFO[key].label.replace('成衣', '');
    if (creating) { next.rules[other] = next.rules[given]; notes.push('没有提供' + short(other) + '，直筒裤按与' + short(given) + '相同处理：' + cm(next.rules[other]) + ' cm。'); }
    else if (current.rules.kneeCirc === current.rules.hemCirc && next.rules.kneeCirc !== next.rules.hemCirc) notes.push(short(other) + '保持 ' + cm(next.rules[other]) + ' cm 不变，裤腿不再上下一样宽；要保持直筒，请再说“' + short(other) + ' ' + cm(next.rules[given]) + '”。');
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
// ---- notches on a named edge of a piece, and auxiliary lines
const END_WORDS = [['left', /左端|左头|从左/, '左端'], ['right', /右端|右头|从右/, '右端'], ['top', /上端|上头|从上/, '上端'], ['bottom', /下端|下头|从下/, '下端']];
function planNotch(sentence, scene, context) {
  if (/辅助线/.test(sentence)) {
    if (/(删除|删掉|去掉|清除|清掉)/.test(sentence)) return plan('删掉图上全部辅助线，其他线不动。', { steps: [{ type: 'line.deleteAuxiliary', parameters: {} }] });
    const byId = new Map(drawnLines(scene).map(l => [l.id, l])), lines = (context.selection?.entityIds || []).map(id => byId.get(id)).filter(Boolean);
    if (!lines.length) refuse('请先在画布上选中要设置的线，再说一遍；也可以打开左侧的“画线”工具，用“辅助线”直接点选。');
    const back = /(恢复|取消|改回|普通线)/.test(sentence);
    return plan('把选中的 ' + lines.length + ' 条线' + (back ? '恢复成普通线。' : '设成辅助线：显示为蓝色虚线，可以用“删除辅助线”一次删掉。'), { steps: [{ type: 'line.setAuxiliary', parameters: { entityIds: lines.map(l => l.id), auxiliary: !back } }] });
  }
  const dart = /(做省|打省|收省|省道|开省)/.test(sentence) && !/转省|两点做省|斜省|单向省|插入省|掰开省/.test(sentence);
  if (!dart && !/刀口/.test(sentence)) return null;
  const what = dart ? '省' : '刀口';
  const pieces = targetPieces(sentence, scene, context, dart ? '要在哪个裁片上做省？' : '要在哪个裁片上打刀口？');
  if (pieces.length > 1) refuse(what + '一次只做在一个裁片上，请说出裁片名称。');
  const piece = pieces[0], name = '“' + piece.name + '”';
  const edges = piece.contour.flatMap(e => e.points ? e.points.map((p, i) => ({ entityId: e.entityId, segmentIndex: i, from: p, to: e.points[(i + 1) % e.points.length] })) : e.kind === 'closed-polyline' ? [] : [{ entityId: e.entityId, from: e.from, to: e.to }]);
  if (!edges.length) refuse(name + '的轮廓上没有可以' + (dart ? '做省' : '打刀口') + '的边。');
  const edgeWord = EDGE_WORDS.find(item => item[1].test(sentence));
  if (!edgeWord) ask((dart ? '做' : '打') + '在哪一条边上？请说上边、下边、左边或右边，例如“' + piece.name + (dart ? '上边中点做省，省量 2，省长 9”。' : '上边打刀口，离左端 5”。'), EDGE_WORDS.map(item => ({ label: item[2], send: sentence + ' ' + item[2] })));
  const mid = e => ({ x: (e.from.x + e.to.x) / 2, y: (e.from.y + e.to.y) / 2 }), score = { top: e => mid(e).y, bottom: e => -mid(e).y, left: e => -mid(e).x, right: e => mid(e).x }[edgeWord[0]];
  const edge = edges.reduce((best, item) => score(item) > score(best) ? item : best), at = { entityId: edge.entityId, ...(edge.segmentIndex === undefined ? {} : { segmentIndex: edge.segmentIndex }) };
  if (dart) {
    // a dart: where on the edge, how wide, how long
    const width = sentence.match(new RegExp('省量\\s*(?:为|是|=)?\\s*' + NUM + '\\s*' + UNIT + '?')), long = sentence.match(new RegExp('省长\\s*(?:为|是|=)?\\s*' + NUM + '\\s*' + UNIT + '?'));
    if (!width || !long) ask('省量和省长各是多少？例如“' + piece.name + edgeWord[2] + '中点做省，省量 2，省长 9”。');
    const widthMm = fine(toMm(width[1], width[2])), lengthMm = fine(toMm(long[1], long[2])); if (!(widthMm > 0 && lengthMm > 0)) refuse('省量和省长都要大于 0。');
    const cap = /省山|省折线/.test(sentence) ? (/倒向(左|上|起点)/.test(sentence) ? 'start' : 'end') : 'none', sideOf = { left: edge.from.x <= edge.to.x, right: edge.from.x > edge.to.x, top: edge.from.y >= edge.to.y, bottom: edge.from.y < edge.to.y };
    let where = null, placeWord = '中点';
    if (!/中点|中间|正中/.test(sentence)) { const endWord = END_WORDS.find(item => item[1].test(sentence)), tail = endWord ? sentence.slice(sentence.search(endWord[1])).match(LENGTH) : null; if (!endWord || !tail) ask('省做在这条边的什么位置？例如“中点”，或“离左端 8”。'); const distance = fine(toMm(tail[1], tail[2])); where = { from: sideOf[endWord[0]] ? 'start' : 'end', distance }; placeWord = '离' + endWord[2] + ' ' + cm(distance) + ' cm'; }
    return plan('在' + name + edgeWord[2] + placeWord + '做省：省量 ' + cm(widthMm) + ' cm，省长 ' + cm(lengthMm) + ' cm，垂直于这条边，朝裁片里面' + (cap === 'none' ? '' : '，并画省山') + '。', { steps: [{ type: 'dart.make', parameters: { ...at, at: where || { ratio: 50 }, width: widthMm, length: lengthMm, ...(cap === 'none' ? {} : { cap }) } }], assumptions: cap === 'none' ? [] : ['省山按省倒向这条边的' + (cap === 'start' ? '起点' : '终点') + '一侧来画。'] });
  }
  if (/(删除|删掉|去掉|取消)/.test(sentence)) return plan('删掉' + name + edgeWord[2] + '上的刀口。', { steps: [{ type: 'notch.remove', parameters: at }] });
  const count = /(两个|2\s*个|双刀)/.test(sentence) ? 2 : /(三个|3\s*个)/.test(sentence) ? 3 : 1, many = count > 1 ? { count } : {};
  if (/中点|中间|正中/.test(sentence)) return plan('在' + name + edgeWord[2] + '的中点打 ' + count + ' 个刀口。', { steps: [{ type: 'notch.add', parameters: { ...at, ratio: 50, ...many } }] });
  const level = Math.abs(edge.to.x - edge.from.x) >= Math.abs(edge.to.y - edge.from.y), endWord = END_WORDS.find(item => item[1].test(sentence));
  const fits = endWord && (level ? ['left', 'right'] : ['top', 'bottom']).includes(endWord[0]);
  if (!fits) ask('刀口离这条边的哪一端多远？例如“' + piece.name + edgeWord[2] + '打刀口，离' + (level ? '左端' : '上端') + ' 5”，或者说“中点”。', (level ? ['左端', '右端'] : ['上端', '下端']).map(word => ({ label: '离' + word + ' 5', send: piece.name + edgeWord[2] + '打刀口，离' + word + ' 5' })));
  const tail = sentence.slice(sentence.search(endWord[1])), m = tail.match(LENGTH);
  if (!m) ask('离' + endWord[2] + '多远？例如“' + piece.name + edgeWord[2] + '打刀口，离' + endWord[2] + ' 5”。');
  const distance = fine(toMm(m[1], m[2])), startIs = { left: edge.from.x <= edge.to.x, right: edge.from.x > edge.to.x, top: edge.from.y >= edge.to.y, bottom: edge.from.y < edge.to.y }[endWord[0]];
  if (!(distance >= 0)) refuse('距离不能是负数。');
  return plan('在' + name + edgeWord[2] + '打 ' + count + ' 个刀口，离' + endWord[2] + ' ' + cm(distance) + ' cm。这条边有缝份时，刀口从缝边线向里切。', { steps: [{ type: 'notch.add', parameters: { ...at, from: startIs ? 'start' : 'end', distance, ...many } }] });
}
// ---- v66: ET's extended seam (生成扩展缝边, 修改扩展缝边线宽度), 净边延长处理 and 延长到环边
function planSeamTools(sentence, scene, context) {
  const extension = /扩展缝[边份]/.test(sentence), net = /净边延长/.test(sentence), toOutline = /延长到(环边|轮廓|裁片边|边上|边)|环边/.test(sentence);
  if (!extension && !net && !toOutline) return null;
  const pieces = targetPieces(sentence, scene, context, extension ? '给哪个裁片加扩展缝边？' : net ? '给哪个裁片做净边延长？' : '延长哪个裁片的内部线？');
  if (pieces.length > 1) refuse('这件事一次只做一个裁片，请说出裁片名称。');
  const piece = pieces[0], name = '“' + piece.name + '”';
  const seamFirst = () => { if (!piece.seam) refuse(name + '还没有缝份。请先加缝份，例如“给' + piece.name + '加缝份 1”。'); };
  if (extension) {
    seamFirst();
    if (/(去掉|删除|取消|不要|清除)/.test(sentence)) { if (!piece.seam.extension) refuse(name + '没有扩展缝边。'); return plan('去掉' + name + '的扩展缝边。', { steps: [{ type: 'seam.extension', parameters: { groupId: piece.id, width: 0 } }] }); }
    // the width is said after the word (a digit in the piece's name is not it)
    const m = sentence.slice(sentence.search(/扩展缝[边份]/)).split(piece.name).join(' ').match(LENGTH);
    if (!m) ask('扩展缝边离缝边线多宽？例如“给' + piece.name + '加扩展缝边 1”。');
    const width = fine(toMm(m[1], m[2]));
    if (!(width > 0)) refuse('扩展缝边的宽度须大于 0；要去掉扩展缝边，请说“去掉' + piece.name + '的扩展缝边”。');
    const edgeWord = EDGE_WORDS.find(item => item[1].test(sentence));
    if (edgeWord) {
      if (!piece.seam.extension) refuse(name + '还没有扩展缝边。请先给整片加，例如“给' + piece.name + '加扩展缝边 1”，再改' + edgeWord[2] + '。');
      const middle = e => ({ x: (e.from.x + e.to.x) / 2, y: (e.from.y + e.to.y) / 2 }), score = e => ({ top: middle(e).y, bottom: -middle(e).y, left: -middle(e).x, right: middle(e).x })[edgeWord[0]];
      const edges = piece.contour.filter(e => e.from && e.to); if (!edges.length) refuse(name + '的轮廓是一条闭合折线，请用画线面板里的“扩展缝边”工具点那条边。');
      const edge = edges.reduce((best, e) => score(e) > score(best) ? e : best);
      return plan('把' + name + edgeWord[2] + '的扩展缝边改成离缝边线 ' + cm(width) + ' cm，其余的边不变。', { steps: [{ type: 'seam.extensionEdges', parameters: { groupId: piece.id, entityIds: [edge.entityId], width } }] });
    }
    return plan('给' + name + '加扩展缝边：缝份外面再加一圈虚线，离缝边线 ' + cm(width) + ' cm，转角处延长相交成尖角。', { steps: [{ type: 'seam.extension', parameters: { groupId: piece.id, width } }] });
  }
  if (net) { seamFirst(); return plan('给' + name + '做净边延长：每个转角的两条净样边各自延长到另一条边的缝边线，画成粉色的内部线。', { steps: [{ type: 'piece.netExtensions', parameters: { groupId: piece.id } }] }); }
  // 延长到环边: the inner lines chosen on the canvas, otherwise every inner line of the piece but the lines of 净边延长
  const inner = (piece.otherMembers || []).filter(e => e.layer !== 'grain' && e.kind !== 'text' && !e.netExtension);
  if (!inner.length) refuse(name + '里没有可以延长的内部线。');
  const chosen = new Set(context.selection?.entityIds || []), picked = inner.filter(e => chosen.has(e.entityId)), lines = picked.length ? picked : inner;
  return plan('把' + name + (picked.length ? '选中的 ' + lines.length + ' 条' : '的') + '内部线两端沿自己的方向延长到裁片的净样轮廓；已经在轮廓上的一端不动。', { steps: [{ type: 'piece.extendToOutline', parameters: { groupId: piece.id, entityIds: lines.map(e => e.entityId) } }] });
}
// ---- seam corner treatments: fold-back and stepped hem corners on a named edge, a cut corner at a named corner
const CORNER_WORD = /(反转角|反折角|切角|台阶角|偷角|角处理|普通转角|折叠角|七字角|反转直角|可调反转|双延长角|双投影角|缝边直角|缝份直角|单边直角|曲线断差|反转翻角|翻角|开叉|半止口|全止口)/;
const EDGE_WORDS = [['top', /上口|上边|上面|顶边|腰口|袋口|上沿/, '上边'], ['bottom', /下摆|下边|下口|底边|脚口|下沿/, '下边'], ['left', /左边|左侧/, '左边'], ['right', /右边|右侧/, '右边']];
const CORNER_SPOTS = [['left-top', /左上/, '左上角'], ['right-top', /右上/, '右上角'], ['left-bottom', /左下/, '左下角'], ['right-bottom', /右下/, '右下角']];
function planCorner(sentence, scene, context) {
  if (!CORNER_WORD.test(sentence)) return null;
  // v63: “切角” said of two selected lines, with no piece named, is the 切角 of ET's 圆角处理 (planConstruct)
  if (/切角/.test(sentence) && !namedPieces(sentence, scene, context).pieces.length && twoLinesChosen(scene, context)) return null;
  // v65: the treatments of two sewn pieces need the sewn edge on each piece; the panel tool picks them
  if (/延长反转角|缝边直角|缝份直角/.test(sentence)) refuse('直角、包边延长反转角和延长反转角是两片缝合处的角，要分别点出两片上缝合的边：请用画线面板里的“缝边角”工具，先点这一片的缝合边，再点另一片的缝合边，都点在转角附近。');
  const pieces = targetPieces(sentence, scene, context, '要处理哪个裁片的转角？');
  if (pieces.length > 1) refuse('角处理一次只做一个裁片，请说出裁片名称。');
  const piece = pieces[0], name = '“' + piece.name + '”';
  if (!piece.seam) refuse(name + '还没有缝份。请先加缝份，例如“给' + piece.name + '加缝份 1”。');
  // every line or curve of the contour, and every side of a contour drawn as one closed polyline
  const edges = piece.contour.flatMap(e => e.points ? e.points.map((p, i) => ({ entityId: e.entityId, segmentIndex: i, from: p, to: e.points[(i + 1) % e.points.length] })) : e.kind === 'closed-polyline' ? [] : [{ entityId: e.entityId, from: e.from, to: e.to }]);
  if (edges.length < 2) refuse(name + '的轮廓没有可以处理的转角。');
  const middle = e => ({ x: (e.from.x + e.to.x) / 2, y: (e.from.y + e.to.y) / 2 }), most = (list, value) => list.reduce((best, item) => value(item) > value(best) ? item : best);
  const same = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < .01;
  const edgeWord = EDGE_WORDS.find(item => item[1].test(sentence)), spotWord = edgeWord ? null : CORNER_SPOTS.find(item => item[1].test(sentence));
  const edgeAt = side => most(edges, e => ({ top: middle(e).y, bottom: -middle(e).y, left: -middle(e).x, right: middle(e).x })[side]);
  const vertexAt = spot => most(edges.flatMap(e => [e.from, e.to]), p => ({ 'left-top': -p.x + p.y, 'right-top': p.x + p.y, 'left-bottom': -p.x - p.y, 'right-bottom': p.x - p.y })[spot]);
  const step = (edge, near, kind, sizes = {}) => ({ type: 'seam.corner', parameters: { groupId: piece.id, entityId: edge.entityId, ...(edge.segmentIndex === undefined ? {} : { segmentIndex: edge.segmentIndex }), ...(near ? { near: { x: near.x, y: near.y } } : {}), kind, ...sizes } });
  const whichEdge = example => ask('是哪一条边？请说上边、下边、左边或右边，例如“' + piece.name + example + '”。', EDGE_WORDS.map(item => ({ label: item[2], send: sentence + ' ' + item[2] })));
  if (/普通转角|恢复|(取消|去掉|删除|不要|清除).*(角处理|反转角|切角|台阶角|折叠角|七字角|反转直角|可调反转|双延长角|双投影角|单边直角|曲线断差|反转翻角|开叉|止口)/.test(sentence)) {
    if (edgeWord) return plan('把' + name + edgeWord[2] + '两端恢复成普通转角。', { steps: [step(edgeAt(edgeWord[0]), null, 'plain')] });
    if (spotWord) { const vertex = vertexAt(spotWord[0]); return plan('把' + name + spotWord[2] + '恢复成普通转角。', { steps: [step(edges.find(e => same(e.from, vertex) || same(e.to, vertex)), vertex, 'plain')] }); }
    ask('恢复哪个转角？例如“' + piece.name + '右下角恢复普通转角”或“' + piece.name + '上边恢复普通转角”。');
  }
  // v65: corners of ET's 缝边角处理 and 专用角处理 that a corner or an edge names
  const atCorner = (kind, word, text) => {
    if (!spotWord) ask('做哪一个角？例如“' + piece.name + '右下角做' + word + '”。', CORNER_SPOTS.map(item => ({ label: item[2], send: sentence + ' ' + item[2] })));
    const vertex = vertexAt(spotWord[0]);
    return plan('把' + name + spotWord[2] + '做成' + word + '：' + text, { steps: [step(edges.find(e => same(e.from, vertex) || same(e.to, vertex)), vertex, kind)] });
  };
  // v67: the corners of ET's 专用角处理 that v65 left; sizes A to D as ET's dialog names them
  const letter = l => { const m = sentence.match(new RegExp('(?<![A-Za-z])' + l + '\\s*[:：=]?\\s*' + NUM + '\\s*' + UNIT + '?', 'i')); return m ? fine(toMm(m[1], m[2])) : null; };
  const after = word => { const at = sentence.indexOf(word); if (at < 0) return null; const m = sentence.slice(at + word.length).match(LENGTH); return m ? fine(toMm(m[1], m[2])) : null; };
  const widthOf = e => { const own = (piece.seam.edges || []).find(w => w.entityId === e.entityId && (w.segmentIndex ?? undefined) === e.segmentIndex); return own ? own.widthMm : piece.seam.widthsMm[0]; };
  // the smooth joints where the seam width changes (two edges in line within 15 degrees): a vent meeting the side above it
  const smoothJoints = () => {
    const found = [], dir = (a, b) => { const d = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: (b.x - a.x) / d, y: (b.y - a.y) / d }; };
    edges.forEach((e1, i) => edges.forEach((e2, j) => { if (j <= i) return; for (const p of [e1.from, e1.to]) if (same(p, e2.from) || same(p, e2.to)) {
      const d1 = dir(same(e1.from, p) ? e1.to : e1.from, p), d2 = dir(p, same(e2.from, p) ? e2.to : e2.from), w1 = widthOf(e1), w2 = widthOf(e2);
      if (d1.x * d2.x + d1.y * d2.y > Math.cos(15 * Math.PI / 180) && Math.abs(w1 - w2) > 1e-6) found.push({ p, wide: w1 > w2 ? e1 : e2, wideMm: Math.max(w1, w2), narrowMm: Math.min(w1, w2) });
    } }));
    return found;
  };
  const sideOf = p => { const b = piece.bbox, cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2; return Math.abs(p.x - cx) / (b.maxX - b.minX || 1) >= Math.abs(p.y - cy) / (b.maxY - b.minY || 1) ? (p.x < cx ? '左边' : '右边') : (p.y > cy ? '上边' : '下边'); };
  const pickJoint = (word, example) => {
    const joints = smoothJoints();
    if (!joints.length) refuse(name + '没有缝份宽度不同、接近相切相接的两条边（断差）。' + word + '要做在这样的地方，例如开衩那条边比上面的边缝份宽：先给开衩那条边改缝份，再说“' + piece.name + example + '”。');
    if (joints.length === 1) return joints[0];
    const side = EDGE_WORDS.find(item => item[1].test(sentence)), named = side && joints.filter(j => sideOf(j.p) === side[2]);
    if (named && named.length === 1) return named[0];
    ask(name + '有 ' + joints.length + ' 处缝份宽度不同的相接点，做哪一处？', joints.map(j => ({ label: sideOf(j.p) + '（' + cm(j.wideMm) + ' 接 ' + cm(j.narrowMm) + '）', send: sentence + ' ' + sideOf(j.p) })));
  };
  const jointWhere = j => sideOf(j.p) + '缝份 ' + cm(j.wideMm) + ' cm 接 ' + cm(j.narrowMm) + ' cm 的地方';
  if (/单边直角/.test(sentence)) {
    const a = letter('A') ?? after('延长') ?? after('单边直角');
    if (a === null) ask('单边直角延长多少（A）？例如“' + piece.name + '右下角做单边直角，下边延长 2.6”。');
    if (!(a >= 0)) refuse('A 不能是负数。');
    const spot = CORNER_SPOTS.find(item => item[1].test(sentence));
    if (spot) {
      const vertex = vertexAt(spot[0]), touching = edges.filter(e => same(e.from, vertex) || same(e.to, vertex)), side = EDGE_WORDS.find(item => item[1].test(sentence));
      if (!side) ask('哪一条边的缝边线越过转角延长？请说' + touching.map(e => sideOf(middle(e))).join('或') + '，例如“' + piece.name + spot[2] + '做单边直角，下边延长 2.6”。', touching.map(e => ({ label: sideOf(middle(e)), send: sentence + ' ' + sideOf(middle(e)) + '延长' })));
      const edge = touching.find(e => sideOf(middle(e)) === side[2]) || most(touching, e => ({ top: middle(e).y, bottom: -middle(e).y, left: -middle(e).x, right: middle(e).x })[side[0]]);
      return plan('把' + name + spot[2] + '做成单边直角：' + side[2] + '的缝边线越过转角延长 ' + cm(a) + ' cm（从净线转角量），再垂直于' + side[2] + '连到另一条缝边线。', { steps: [step(edge, vertex, 'singleSquare', { a })] });
    }
    const joint = pickJoint('单边直角', '做单边直角，A 2');
    return plan('在' + name + jointWhere(joint) + '做单边直角：缝份的台阶挪到离相接点 ' + cm(a) + ' cm 处。', { steps: [step(joint.wide, joint.p, 'singleSquare', { a })] });
  }
  if (/曲线断差/.test(sentence)) {
    const n = (sentence.match(/曲线断差\s*([123一二三])/) || [])[1];
    if (!n) ask('做曲线断差几？1：宽的缝边线延长 A，再直线过渡 B；2：从相接点起曲线过渡到 A + B 处；3：宽的缝边线延长 A，再曲线过渡 B。', [1, 2, 3].map(k => ({ label: '曲线断差' + k, send: sentence.replace('曲线断差', '曲线断差' + k) })));
    const k = { 一: 1, 二: 2, 三: 3 }[n] || +n, joint = pickJoint('曲线断差', '做曲线断差' + k + '，A 2 B 1'), a = letter('A'), b = letter('B');
    if (a === null || b === null) ask('曲线断差要两个尺寸：A（宽的缝边线越过相接点延长多少）和 B（过渡段多长），例如“' + piece.name + '做曲线断差' + k + '，A 2 B 1”。');
    if (!(a >= 0 && b >= 0 && a + b > 0)) refuse('A、B 不能是负数，也不能都是 0。');
    const text = { 1: '宽的缝边线越过相接点延长 ' + cm(a) + ' cm，再用 ' + cm(b) + ' cm 的直线过渡到窄的缝边线', 2: '从相接点起用曲线过渡，到离相接点 ' + cm(a + b) + ' cm 处接上窄的缝边线', 3: '宽的缝边线越过相接点延长 ' + cm(a) + ' cm，再用 ' + cm(b) + ' cm 的曲线过渡到窄的缝边线' }[k];
    return plan('在' + name + jointWhere(joint) + '做曲线断差' + k + '：' + text + '。', { steps: [step(joint.wide, joint.p, 'curveStep' + k, { a, b })] });
  }
  if (/反转翻角|翻角/.test(sentence)) {
    if (!edgeWord) whichEdge('下边做反转翻角，A 1');
    const hem = edgeAt(edgeWord[0]), width = widthOf(hem), a = letter('A') ?? after('翻角');
    if (a === null) ask('反转翻角第一折多深（A）？B 取' + edgeWord[2] + '缝份宽减 A。例如“' + piece.name + edgeWord[2] + '做反转翻角，A 1”。');
    if (!(a > 0 && width - a > a)) refuse('A 要大于 0、小于' + edgeWord[2] + '缝份宽 ' + cm(width) + ' cm 的一半（B = 缝份宽 − A，ET 要求 B 大于 A）。');
    return plan('把' + name + edgeWord[2] + '的两端做成反转翻角（卷边）：两侧的缝边线停在' + edgeWord[2] + '的净线上，以' + edgeWord[2] + '为轴镜像往外走 ' + cm(a) + ' cm，再按侧边原来的方向走 ' + cm(width - a) + ' cm 到' + edgeWord[2] + '的缝边线。', { steps: [step(hem, null, 'turnUp', { a, b: fine(width - a) })] });
  }
  if (/开叉|半止口|全止口/.test(sentence)) {
    const full = /全止口/.test(sentence);
    if (!full && !/半止口/.test(sentence)) ask('做开叉半止口还是开叉全止口？', [{ label: '开叉半止口', send: sentence + ' 半止口' }, { label: '开叉全止口', send: sentence + ' 全止口' }]);
    const word = full ? '开叉全止口' : '开叉半止口', joint = pickJoint(word, '开衩做' + word + '，A 2 B 1'), a = letter('A'), b = letter('B'), c = letter('C') ?? 0, d = letter('D') ?? 0;
    if (a === null || b === null) ask(word + '要 A、B（C、D 不说就是 0）：上面那条边的缝边线停在离相接点 A + B 处，C 是折边上曲线的落点离相接点多远，D 是半止口外边再加宽多少。例如“' + piece.name + '开衩做' + word + '，A 2 B 1”。');
    if (!(a >= 0 && b >= 0 && c >= 0 && d >= 0)) refuse('A、B、C、D 不能是负数。');
    if (!(a + b > c)) refuse('A + B 要大于 C。');
    const w = joint.wideMm, outer = full ? '外面加两层止口，中间又是一条虚线折边，外边离净线 ' + cm(3 * w) + ' cm' : '外面加一层止口，外边离净线 ' + cm(2 * w + d) + ' cm';
    return plan('把' + name + '的开衩（' + jointWhere(joint) + '，往下到下摆）做成' + word + '：上面那条边的缝边线停在离相接点 ' + cm(a + b) + ' cm 处，用曲线连到折边上离相接点 ' + cm(c) + ' cm 的点；开衩的缝边线变成虚线折边，' + outer + '；下摆的缝边线延长到止口外边。', { steps: [step(joint.wide, null, full ? 'ventFull' : 'ventHalf', { a, b, c, d })] });
  }
  if (/折叠角/.test(sentence)) return atCorner('mitre', '折叠角', '两边的缝份沿净线折回后，各自离转角的对角线 1 cm。');
  if (/双延长角/.test(sentence)) return atCorner('doubleExtend', '双延长角', '一条边的缝边线与另一条边的净线相交处，直线连到另一条边的缝边线与这条边净线延长线的交点。');
  if (/双投影角/.test(sentence)) return atCorner('doubleProject', '双投影角', '两条缝边线都停在从净线转角垂直量过去的地方，经过净线转角连起来。');
  if (/七字角|反转直角|可调反转/.test(sentence)) {
    const word = sentence.match(/七字角|反转直角|可调反转/)[0], kind = { 七字角: 'sevenStep', 反转直角: 'foldSquare', 可调反转: 'foldShift' }[word];
    if (!edgeWord) whichEdge('下边做' + word + (kind === 'foldShift' ? ' 2' : ''));
    const hem = edgeAt(edgeWord[0]);
    let shift = 0;
    if (kind === 'foldShift') { const m = sentence.slice(sentence.indexOf(word) + word.length).match(LENGTH); if (!m) ask('可调反转往外移多少？例如“' + piece.name + edgeWord[2] + '做可调反转 2”（可以是 0）。'); shift = fine(toMm(m[1], m[2])); if (!(shift >= 0)) refuse('往外移的距离不能是负数。'); }
    const text = { sevenStep: '侧边的缝边线停在这条边的净线上，向里走到侧边缝份的一半，再平行侧边走到这条边缝份的一半，斜着连到侧边净线延长后与这条边缝边线的交点。', foldSquare: '侧边的缝边线停在这条边的净线上，往外是它的镜像，到这条边缝份的一半处再垂直走到这条边的缝边线。', foldShift: '侧边的缝边线停在这条边的净线上，直线连到反转角落在这条边缝边线上的那一点，再往外移 ' + cm(shift) + ' cm。' }[kind];
    return plan('把' + name + edgeWord[2] + '的两端做成' + word + '：' + text, { steps: kind === 'foldShift' ? [step(hem, null, kind, { shift })] : [step(hem, hem.from, kind), step(hem, hem.to, kind)] });
  }
  if (/反转角|反折角/.test(sentence)) {
    if (!edgeWord) whichEdge('上边做反转角');
    return plan('把' + name + edgeWord[2] + '的两端做成反转角：这条边的缝份向里折回后，两头正好和裁片对齐。', { steps: [step(edgeAt(edgeWord[0]), null, 'fold')] });
  }
  if (/台阶角|偷角/.test(sentence)) {
    if (!edgeWord) whichEdge('上边做台阶角，高 0.8 宽 1.9');
    const high = sentence.match(new RegExp('高\\s*' + NUM + '\\s*' + UNIT + '?')), wide = sentence.match(new RegExp('宽\\s*' + NUM + '\\s*' + UNIT + '?'));
    if (!high || !wide) ask('台阶角要两个尺寸：台阶高多少、宽多少？例如“' + piece.name + edgeWord[2] + '做台阶角，高 0.8 宽 1.9”。');
    const drop = fine(toMm(high[1], high[2])), run = fine(toMm(wide[1], wide[2])), hem = edgeAt(edgeWord[0]);
    if (!(drop > 0 && run > 0)) refuse('台阶的高和宽都须大于 0。');
    const sides = [hem.from, hem.to].map(vertex => ({ vertex, edge: edges.find(e => e !== hem && (same(e.from, vertex) || same(e.to, vertex))) }));
    if (sides.some(item => !item.edge)) refuse('没有找到' + name + edgeWord[2] + '两端相邻的边。');
    return plan('把' + name + edgeWord[2] + '的两端做成台阶角：侧缝的缝边线在这条边的缝边线以下 ' + cm(drop) + ' cm 处停住，台阶的竖边在侧缝缝边线以内 ' + cm(run) + ' cm。', { steps: sides.map(item => step(item.edge, item.vertex, 'step', { drop, run })) });
  }
  if (/切角/.test(sentence)) {
    if (!spotWord) ask('切哪一个角？例如“' + piece.name + '右下角切角 1”。', CORNER_SPOTS.map(item => ({ label: item[2], send: sentence + ' ' + item[2] })));
    const m = sentence.slice(sentence.indexOf('切角') + 2).match(LENGTH);
    if (!m) ask('两条缝边线各截掉多长？例如“' + piece.name + spotWord[2] + '切角 1”。');
    const first = fine(toMm(m[1], m[2])), vertex = vertexAt(spotWord[0]); if (!(first > 0)) refuse('切角的长度须大于 0。');
    return plan('把' + name + spotWord[2] + '的缝份切角：两条缝边线在交点前各截掉 ' + cm(first) + ' cm，再连成一条斜边。', { steps: [step(edges.find(e => same(e.from, vertex) || same(e.to, vertex)), vertex, 'cut', { first, second: first })],
      assumptions: ['两条边截掉的长度相同。要两边不同，请用画线面板里的“缝边角”工具。'] });
  }
  ask('要做哪一种角处理？', [{ label: '反转角', send: piece.name + '上边做反转角' }, { label: '切角', send: piece.name + '右下角切角 1' }, { label: '台阶角', send: piece.name + '上边做台阶角，高 0.8 宽 1.9' }, { label: '折叠角', send: piece.name + '右下角做折叠角' }]);
}
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
  const steps = [{ type: 'draw.rectangle', parameters: { x: place.x, y: place.y, width: fine(size.width), height: fine(size.height), name }, as: 'shape' }];
  if (asPiece) steps.push({ type: 'piece.create', parameters: { name, contourEntityIds: ['@shape'] }, as: 'piece' });
  if (width) steps.push({ type: 'seam.apply', parameters: { groupId: '@piece', width: checkSeam(width) } });
  return plan('画“' + name + '”：横向 ' + cm(size.width) + ' cm，纵向 ' + cm(size.height) + ' cm' + (asPiece ? '，建成裁片' : '') + (width ? '，四边加 ' + cm(width) + ' cm 缝份' : '') + '。放在现有图形右侧。',
    { steps, actions: FIT, assumptions: size.how ? [size.how] : [], choices: asPiece ? [] : [{ label: '建成裁片并加 1 cm 缝份', send: '把刚才的图形建成裁片，叫' + name + '，缝份1cm' }] });
}
function planLine(sentence, scene) {
  if (!/画/.test(sentence) || !/线/.test(sentence) || /(曲线|弧线|布纹)/.test(sentence)) return null;
  const coordinate = '\\(?\\s*(-?\\d+(?:\\.\\d+)?)\\s*,\\s*(-?\\d+(?:\\.\\d+)?)\\s*\\)?', through = sentence.match(new RegExp('从\\s*' + coordinate + '\\s*(?:到|至)\\s*' + coordinate + '\\s*' + UNIT + '?'));
  if (through) {
    if (through[5] === '寸' || through[5] === '%') refuse('坐标请用 mm、cm 或英寸。');
    const scale = through[5] ? UNITS[through[5]] : bareScale(through[1]), [x1, y1, x2, y2] = through.slice(1, 5).map(v => fine(Number(v) * scale));
    if (x1 === x2 && y1 === y2) refuse('直线的两个端点不能重合。');
    return plan('画直线：从 (' + cm(x1) + ', ' + cm(y1) + ') 到 (' + cm(x2) + ', ' + cm(y2) + ') cm，长 ' + cm(Math.hypot(x2 - x1, y2 - y1)) + ' cm。', { steps: [{ type: 'draw.line', parameters: { from: { x: x1, y: y1 }, to: { x: x2, y: y2 } } }], actions: FIT, assumptions: ['坐标 x 向右、y 向上。'] });
  }
  const length = sentence.match(LENGTH); if (!length) ask('这条线要多长？例如“画一条 30 cm 的横线”。');
  const mm = fine(toMm(length[1], length[2])), vertical = /(竖|垂直|纵)/.test(sentence), place = freePlace(scene, vertical ? mm : 0);
  if (!(mm > 0 && mm <= 5000)) refuse('线长须大于 0 且不超过 500 cm。');
  return plan('画一条 ' + cm(mm) + ' cm 的' + (vertical ? '竖线' : '横线') + '，放在现有图形右侧。', { steps: [{ type: 'draw.line', parameters: { from: { x: place.x, y: place.y }, to: vertical ? { x: place.x, y: fine(place.y + mm) } : { x: fine(place.x + mm), y: place.y } } }],
    actions: FIT, assumptions: /(横|水平|竖|垂直|纵)/.test(sentence) ? [] : ['没有说方向，按横线画。'] });
}
function planText(sentence, scene, context, original) {
  const m = original.match(/写(?:上|下|字|文字)*\s*[:：]?\s*["“”'‘’「]([^"“”'‘’」]{1,200})["“”'‘’」]/); if (!m) return null;
  const named = namedPieces(sentence, scene, context), size = sentence.match(new RegExp('字高\\s*' + NUM + '\\s*' + UNIT + '?')), height = size ? fine(toMm(size[1], size[2])) : 8;
  if (!(height > 0 && height <= 1000)) refuse('字高须大于 0 且不超过 100 cm。');
  const piece = named.pieces[0], at = piece?.bbox ? { x: fine((piece.bbox.minX + piece.bbox.maxX) / 2), y: fine((piece.bbox.minY + piece.bbox.maxY) / 2) } : freePlace(scene, height);
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

// ---------------------------------------------------------------- drafting constructions on selected lines
const HEADINGS = { 上: { x: 0, y: 1 }, 下: { x: 0, y: -1 }, 左: { x: -1, y: 0 }, 右: { x: 1, y: 0 } };
/** Lines an instruction can be about: loose lines and the outline edges of pieces, with their end points. */
const twoLinesChosen = (scene, context) => { const ids = new Set(context.selection?.entityIds || []); return drawnLines(scene).filter(l => ids.has(l.id)).length === 2; };
function drawnLines(scene) {
  const lines = (scene.looseEntities || []).filter(e => e.kind !== 'text').map(e => ({ id: e.id, name: e.name, kind: e.kind, from: e.from, to: e.to }));
  for (const piece of scene.pieces || []) for (const edge of piece.contour || []) if (edge.from && edge.to) lines.push({ id: edge.entityId, name: edge.name, kind: edge.kind, from: edge.from, to: edge.to });
  return lines;
}
/** The lines meant by "选中的线" or "它": the canvas selection, otherwise what the last plan drew. */
function meantLines(scene, context, howMany) {
  const byId = new Map(drawnLines(scene).map(l => [l.id, l])), pick = ids => (ids || []).map(id => byId.get(id)).filter(Boolean);
  let lines = pick(context.selection?.entityIds); if (!lines.length) lines = pick(context.last?.entityIds);
  if (lines.length !== howMany) refuse('这句话需要先在画布上选中' + (howMany === 1 ? '一条线' : ' ' + howMany + ' 条直线') + '，现在选中了 ' + lines.length + ' 条。请用选择工具选好，再说一遍；也可以打开左侧的“画线”工具直接点选。');
  return lines;
}
const headingIn = sentence => { const m = sentence.match(/(?:向|往|朝)(上|下|左|右)|(上|下|左|右)(?:方|边|侧|面)/); return m ? m[1] || m[2] : null; };
const middle = l => ({ x: (l.from.x + l.to.x) / 2, y: (l.from.y + l.to.y) / 2 });
const beside = (l, heading) => { const m = middle(l), v = HEADINGS[heading]; return { x: fine(m.x + v.x * 10000), y: fine(m.y + v.y * 10000) }; };
const flat = l => Math.abs(l.to.x - l.from.x) >= Math.abs(l.to.y - l.from.y);
function askHeading(sentence, l, question) { const options = flat(l) ? ['上', '下'] : ['左', '右']; ask(question, options.map(h => ({ label: '向' + h, send: sentence + ' 向' + h }))); }
/** Which end of a line "左端" and the like means: start or end. */
function endOf(l, word) {
  const axis = word === '左' || word === '右' ? 'x' : 'y', more = word === '右' || word === '上';
  if (Math.abs(l.from[axis] - l.to[axis]) < 1e-6) refuse('这条线的两端' + (axis === 'x' ? '左右' : '上下') + '对齐，分不出' + word + '端。请改说' + (axis === 'x' ? '上端或下端' : '左端或右端') + '。');
  return (l.from[axis] > l.to[axis]) === more ? 'start' : 'end';
}
function planConstruct(sentence, scene, context, changes) {
  const quote = l => '“' + l.name + '”';
  // v64: ET's dart tools on selected lines (dart-tools.mjs); 插入省 and 掰开省 need several picks and are left to the panel
  if (/插入省|掰开省/.test(sentence)) { const tool = /插入省/.test(sentence) ? '插入省' : '掰开省'; refuse(tool + '要点选好几样：参与的线、' + (tool === '插入省' ? '展开方向参考线和省线' : '省线、省基线和转动的点') + '。请先选中参与的线，再打开左侧“画线”里的“' + tool + '”工具点选。'); }
  if (/斜省|省折线|折倒|倒向|单向省|两点做省/.test(sentence) && !/做省.*(上边|下边|左边|右边|上口|下摆|腰口)/.test(sentence)) {
    const size = word => { const m = sentence.match(new RegExp(word + '\\s*(?:为|是|=)?\\s*' + NUM + '\\s*' + UNIT + '?')); return m ? fine(toMm(m[1], m[2])) : null; };
    const apart = (a, b) => Math.hypot(a.x - b.x, a.y - b.y), toSegment = (q, l) => { const dx = l.to.x - l.from.x, dy = l.to.y - l.from.y, d2 = dx * dx + dy * dy, t = d2 ? Math.max(0, Math.min(1, ((q.x - l.from.x) * dx + (q.y - l.from.y) * dy) / d2)) : 0; return Math.hypot(q.x - l.from.x - t * dx, q.y - l.from.y - t * dy); };
    const loose = l => (scene.looseEntities || []).some(e => e.id === l.id), wordOf = { left: '左', right: '右', top: '上', bottom: '下' };
    if (/斜省/.test(sentence)) {
      const [a, b] = meantLines(scene, context, 2), gap = (l, other) => Math.min(toSegment(l.from, other), toSegment(l.to, other)), [edge, centre] = gap(a, b) <= gap(b, a) ? [b, a] : [a, b];
      if (centre.kind !== 'line') refuse('省中线要是一条直线：' + quote(centre) + '不是。');
      const width = size('省量'); if (!width) ask('省量是多少？例如“斜省，省量 2”。'); if (!(width > 0 && width <= 500)) refuse('省量须大于 0、不超过 50 cm。');
      const folded = /省山|省折|倒向/.test(sentence), word = (sentence.match(/倒向(左|右|上|下)/) || [])[1];
      if (folded && !word) ask('省倒向哪一侧？', (flat(edge) ? ['左', '右'] : ['上', '下']).map(h => ({ label: '倒向' + h, send: sentence + ' 倒向' + h })));
      const cap = folded ? endOf(edge, word) : 'none';
      return plan('沿' + quote(centre) + '在' + quote(edge) + '上做斜省：省口以' + quote(centre) + '与边的交点为中点，沿边两边各 ' + cm(width / 2) + ' cm（省量 ' + cm(width) + ' cm），省尖是' + quote(centre) + '的另一头，' + quote(centre) + '用完删掉' + (loose(edge) ? '，边线在省口处剪开' : '') + (folded ? '；省倒向' + word + '侧，画省山、省中线和倒向记号' : '') + '。',
        { steps: [{ type: 'dart.slant', parameters: { entityId: edge.id, centreEntityId: centre.id, width, ...(folded ? { cap } : {}) } }] });
    }
    if (/单向省/.test(sentence)) {
      const [leg] = meantLines(scene, context, 1), width = size('省量'); if (!width) ask('省量是多少？例如“单向省，省量 2，向右”。'); if (!(width > 0 && width <= 500)) refuse('省量须大于 0、不超过 50 cm。');
      const word = (sentence.match(/省尖在?([左右上下])端/) || [])[1]; let tipEnd = word ? endOf(leg, word) : null;
      if (!tipEnd) { const others = drawnLines(scene).filter(l => l.id !== leg.id), touched = q => others.some(l => apart(l.from, q) < .5 || apart(l.to, q) < .5 || (l.kind === 'line' && toSegment(q, l) < .5)), a = touched(leg.from), b = touched(leg.to); if (a !== b) tipEnd = a ? 'end' : 'start'; }
      if (!tipEnd) ask('省尖在' + quote(leg) + '的哪一端？', (flat(leg) ? ['左', '右'] : ['上', '下']).map(h => ({ label: '省尖在' + h + '端', send: sentence + ' 省尖在' + h + '端' })));
      const heading = headingIn(sentence.replace(/省尖在?[左右上下]端/, '')); if (!heading) askHeading(sentence, leg, '新省边转向哪一侧？');
      const end = tipEnd === 'start' ? leg.to : leg.from, toward = { x: fine(end.x + HEADINGS[heading].x * 1000), y: fine(end.y + HEADINGS[heading].y * 1000) };
      return plan('把' + quote(leg) + '复制一条，绕' + (tipEnd === 'start' ? '起点' : '终点') + '（省尖）向' + heading + '转开，两条省边另一头之间相距 ' + cm(width) + ' cm（单向省）；原来的线不改。', { steps: [{ type: 'dart.single', parameters: { entityId: leg.id, end: tipEnd, width, toward } }] });
    }
    if (/两点做省/.test(sentence)) {
      const [edge] = meantLines(scene, context, 1); if (edge.kind !== 'line') refuse('按距离说的两点做省只用于直线；曲线请用左侧“画线”里的“两点做省”工具点两个点。');
      const depth = size('省深度'); if (!depth) ask('省深度是多少？例如“两点做省，离左端 5 和 8，省深度 9，朝下”。'); if (!(depth > 0 && depth <= 2000)) refuse('省深度须大于 0、不超过 200 cm。');
      const rest = sentence.replace(new RegExp('省深度\\s*(?:为|是|=)?\\s*' + NUM + '\\s*' + UNIT + '?'), ' '), endWord = END_WORDS.find(item => item[1].test(rest));
      const numbers = endWord ? [...rest.slice(rest.search(endWord[1])).matchAll(new RegExp(LENGTH.source, 'g'))] : [];
      if (!endWord || numbers.length < 2) ask('省口的两个点离这条线的哪一端多远？例如“两点做省，离左端 5 和 8，省深度 9，朝下”。');
      const end = endOf(edge, wordOf[endWord[0]]), start = end === 'start' ? edge.from : edge.to, other = end === 'start' ? edge.to : edge.from, total = apart(start, other), u = { x: (other.x - start.x) / total, y: (other.y - start.y) / total };
      const [d1, d2] = numbers.slice(0, 2).map(m => fine(toMm(m[1], m[2] || numbers[1][2] || numbers[0][2])));
      if (!(d1 >= 0 && d2 >= 0 && d1 <= total + 1e-6 && d2 <= total + 1e-6 && Math.abs(d1 - d2) > 1e-6)) refuse('两个点要在这条线上、而且不重合（线长 ' + cm(total) + ' cm）。');
      const heading = headingIn(rest); if (!heading) askHeading(sentence, edge, '省尖在' + quote(edge) + '的哪一侧？');
      const at = d => ({ x: fine(start.x + u.x * d), y: fine(start.y + u.y * d) }), mid = middle(edge), toward = { x: fine(mid.x + HEADINGS[heading].x * 1000), y: fine(mid.y + HEADINGS[heading].y * 1000) };
      return plan('在' + quote(edge) + '上离' + endWord[2] + ' ' + cm(d1) + ' cm 和 ' + cm(d2) + ' cm 的两点之间做省（两点做省）：省尖在两点连线中点的' + heading + '侧，省深度 ' + cm(depth) + ' cm' + (loose(edge) ? '，边线在两点之间剪开' : '') + '。', { steps: [{ type: 'dart.twoPoints', parameters: { entityId: edge.id, first: at(d1), second: at(d2), depth, toward } }] });
    }
    // 省折线: two selected legs that meet in the tip, folded to the side named
    const [a, b] = meantLines(scene, context, 2); if (a.kind !== 'line' || b.kind !== 'line') refuse('省折线要先选中省的两条省边（两条直线）。');
    const pairs = [[a.from, b.from], [a.from, b.to], [a.to, b.from], [a.to, b.to]], pair = pairs.reduce((p, q) => apart(q[0], q[1]) < apart(p[0], p[1]) ? q : p);
    if (apart(pair[0], pair[1]) > .5) refuse('选中的两条线没有在省尖相交，不是一个省的两条省边。');
    const tip = pair[0], mouthA = apart(a.from, tip) < apart(a.to, tip) ? a.to : a.from, mouthB = apart(b.from, tip) < apart(b.to, tip) ? b.to : b.from, word = (sentence.match(/倒向(左|右|上|下)/) || [])[1];
    if (!word) ask('省倒向哪一侧？', ['左', '右', '上', '下'].map(h => ({ label: '倒向' + h, send: sentence + ' 倒向' + h })));
    const v = HEADINGS[word], toward = (mouthA.x - tip.x) * v.x + (mouthA.y - tip.y) * v.y >= (mouthB.x - tip.x) * v.x + (mouthB.y - tip.y) * v.y ? mouthA : mouthB, depth = size('省深度');
    return plan('把' + quote(a) + '和' + quote(b) + '这个省倒向' + word + '侧（省折线）：倒向一侧的省边不动，另一条改成一样长；画出省山、省中线和倒向记号' + (depth ? '，省边从省口量到 ' + cm(depth) + ' cm 为止' : '') + '。', { steps: [{ type: 'dart.fold', parameters: { legIds: [a.id, b.id], toward: { x: fine(toward.x), y: fine(toward.y) }, ...(depth ? { depth } : {}) } }] });
  }
  if (/平行/.test(sentence)) {
    const [base] = meantLines(scene, context, 1), counted = sentence.match(/(\d+)\s*条/), rest = counted ? sentence.replace(counted[0], ' ') : sentence, m = rest.match(LENGTH);
    if (!m) ask('平行线离原线多远？例如“向下平行 3”（厘米）。');
    const distance = fine(toMm(m[1], m[2])), heading = headingIn(sentence), count = counted ? Number(counted[1]) : 1;
    if (!(distance > 0 && distance <= 5000)) refuse('平行距离须大于 0 且不超过 500 cm。');
    if (!(count >= 1 && count <= 50)) refuse('一次最多作 50 条平行线。');
    if (!heading) askHeading(sentence, base, '平行线放在' + quote(base) + '的哪一侧？');
    return plan('在' + quote(base) + '的' + heading + '侧作平行线，间距 ' + cm(distance) + ' cm' + (count > 1 ? '，共 ' + count + ' 条' : '') + '。', { steps: [{ type: 'draw.parallel', parameters: { entityId: base.id, distance, toward: beside(base, heading), ...(count > 1 ? { count } : {}) } }] });
  }
  if (/等分|平分|分成/.test(sentence)) {
    const m = sentence.match(/(\d+)\s*(?:等分|等份|份|段)/) || sentence.match(/(?:等分|平分)(?:成|为)?\s*(\d+)/); if (!m) ask('要分成几份？例如“把选中的线分成 4 份”。');
    const [base] = meantLines(scene, context, 1), count = Number(m[1]); if (!(count >= 2 && count <= 100)) refuse('等分数须在 2 到 100 之间。');
    return plan('把' + quote(base) + '按长度分成 ' + count + ' 份，在 ' + (count - 1) + ' 个分点各画一条短标记，标记的中点就是分点。', { steps: [{ type: 'draw.divide', parameters: { entityId: base.id, count } }] });
  }
  if (/圆角|切角/.test(sentence) && !/接角圆顺/.test(sentence)) {
    // v63: lines or curves; two numbers are the distances on the first and the second line (ET's two radii); 切角 joins the cuts straight
    const sizes = [...sentence.matchAll(new RegExp(LENGTH.source, 'g'))], chamfer = /切角/.test(sentence);
    if (!sizes.length) ask(chamfer ? '切角切多少？例如“选中的两条线切角 1.5”（厘米），两边不一样就说“切角 1 和 2”。' : '圆角半径多大？例如“选中的两条线做圆角 2”（厘米）；说两个数是两条线上各切开多少，例如“圆角 1 和 2”。');
    if (sizes.length > 2) refuse('圆角最多说两个数：一个是半径，两个是两条线上各切开多少。');
    const [first, second] = meantLines(scene, context, 2), radius = fine(toMm(sizes[0][1], sizes[0][2])), radius2 = sizes[1] ? fine(toMm(sizes[1][1], sizes[1][2] || sizes[0][2])) : undefined;
    if (!(radius > 0) || (radius2 !== undefined && !(radius2 > 0))) refuse('圆角的尺寸须大于 0。');
    const params = { firstEntityId: first.id, secondEntityId: second.id, radius, ...(radius2 !== undefined ? { radius2 } : {}), ...(chamfer ? { style: 'chamfer' } : {}) };
    if (chamfer) return plan('在' + quote(first) + '和' + quote(second) + '的转角切角：两条线在离转角 ' + cm(radius) + (radius2 !== undefined ? ' cm 和 ' + cm(radius2) : '') + ' cm 处切开（沿线量），中间连一条直线。', { steps: [{ type: 'line.fillet', parameters: params }] });
    if (radius2 !== undefined) return plan('在' + quote(first) + '和' + quote(second) + '的转角做曲线圆角：' + quote(first) + '在离转角 ' + cm(radius) + ' cm、' + quote(second) + '在离转角 ' + cm(radius2) + ' cm 处切开（沿线量），中间连一条圆顺的曲线。', { steps: [{ type: 'line.fillet', parameters: params }] });
    return plan('用半径 ' + cm(radius) + ' cm 的圆弧连接' + quote(first) + '和' + quote(second) + '的转角，两条线各改到切点。', { steps: [{ type: 'line.fillet', parameters: params }] });
  }
  // v63: 曲线端矢调整 — the direction of one end of a selected curve, turned by an angle
  if (/(端矢|方向)/.test(sentence) && /转/.test(sentence) && /度/.test(sentence) && !/(裁片|纱向)/.test(sentence)) {
    const [base] = meantLines(scene, context, 1); if (base.kind !== 'curve') refuse(quote(base) + '不是曲线；曲线端矢调整只用于曲线。');
    const word = (sentence.match(/([左右上下])端/) || [])[1], end = /起点/.test(sentence) ? 'start' : /终点/.test(sentence) ? 'end' : word ? endOf(base, word) : ask('转' + quote(base) + '的哪一端？例如“左端方向逆时针转 10 度”。');
    const m = sentence.match(/(\d+(?:\.\d+)?)\s*度/), sense = /顺时针/.test(sentence) ? -1 : /逆时针/.test(sentence) ? 1 : 0;
    if (!sense) ask('往哪边转？请说“顺时针”或“逆时针”。', [{ label: '逆时针', send: sentence + ' 逆时针' }, { label: '顺时针', send: sentence + ' 顺时针' }]);
    const degrees = Number(m[1]) * sense; if (!(Math.abs(degrees) > 0 && Math.abs(degrees) < 180)) refuse('转角须大于 0 度、小于 180 度。');
    return plan('把' + quote(base) + '的' + (end === 'start' ? '起点' : '终点') + '方向' + (sense > 0 ? '逆时针' : '顺时针') + '转 ' + Math.abs(degrees) + ' 度：两个端点不动，中间的曲线点按 ET 曲线端矢调整的规则跟着转，离这一端越近转得越多。', { steps: [{ type: 'curve.turnEnd', parameters: { entityId: base.id, end, turn: degrees } }] });
  }
  // v63: 接角圆顺 — two curves and their seam lines called by their names, the seam lines after the word 缝合线
  if (/接角圆顺|接顺/.test(sentence)) {
    const lines = drawnLines(scene).filter(l => l.name), seamAt = sentence.indexOf('缝合线'), taken = [], found = [];
    for (const l of lines.slice().sort((p, q) => q.name.length - p.name.length)) {
      for (let at = sentence.indexOf(l.name); at >= 0; at = sentence.indexOf(l.name, at + 1)) { if (taken.some(([a, b]) => at < b && at + l.name.length > a)) continue; taken.push([at, at + l.name.length]); found.push({ ...l, at }); break; }
    }
    found.sort((p, q) => p.at - q.at);
    const curves = found.filter(l => seamAt < 0 || l.at < seamAt), seams = seamAt < 0 ? [] : found.filter(l => l.at > seamAt), example = '“前摆和后摆接角圆顺，缝合线 前侧 后侧，与缝合线垂直”';
    if (curves.length !== 2 || seams.length !== 2) refuse('请说出两条要接顺的曲线和它们各自的缝合线（用线的名字），例如' + example + '。');
    for (const l of curves) if (l.kind !== 'curve') refuse(quote(l) + '不是曲线；接角圆顺要转动曲线的端部方向。');
    const mode = /垂直/.test(sentence) ? 'square' : /(平均|顺成一个方向|一个方向)/.test(sentence) ? 'smooth' : null;
    if (!mode) ask('怎样接顺？两条曲线都与缝合线垂直地接到接点，还是顺成它们的平均方向？', [{ label: '与缝合线垂直', send: sentence + ' 与缝合线垂直' }, { label: '顺成平均方向', send: sentence + ' 顺成平均方向' }]);
    return plan('把' + quote(curves[1]) + '按缝合线' + quote(seams[1]) + '接到' + quote(seams[0]) + '上看接点：' + (mode === 'square' ? '两条曲线在接点那一端都转成与缝合线垂直' : '两条曲线在接点那一端都转到平均方向') + '，接起来顺成一条；接点、另一端和缝合线都不动。', { steps: [{ type: 'curve.smoothCorner', parameters: { firstEntityId: curves[0].id, secondEntityId: curves[1].id, firstSeamId: seams[0].id, secondSeamId: seams[1].id, mode } }] });
  }
  if (/角连接|连成角|接成角|连成一个角/.test(sentence)) {
    const [first, second] = meantLines(scene, context, 2);
    return plan('把' + quote(first) + '和' + quote(second) + '延长或剪短到它们的交点。', { steps: [{ type: 'line.cornerJoin', parameters: { firstEntityId: first.id, secondEntityId: second.id } }] });
  }
  if (/圆/.test(sentence) && /(半径|直径)/.test(sentence) && /(画|作|加)/.test(sentence)) {
    const m = sentence.match(new RegExp('(半径|直径)\\s*(?:为|是|=)?\\s*' + NUM + '\\s*' + UNIT + '?')); if (!m) ask('圆的半径多大？例如“画一个半径 5 的圆”。');
    const radius = fine(toMm(m[2], m[3]) / (m[1] === '直径' ? 2 : 1)); if (!(radius > 0 && radius <= 5000)) refuse('半径须大于 0 且不超过 500 cm。');
    const given = sentence.match(/圆心\s*(?:在|为)?\s*\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?/), corner = freePlace(scene, 2 * radius);
    const center = given ? { x: fine(Number(given[1]) * bareScale(given[1])), y: fine(Number(given[2]) * bareScale(given[2])) } : { x: fine(corner.x + radius), y: fine(corner.y + radius) };
    return plan('画一个半径 ' + cm(radius) + ' cm 的圆，' + (given ? '圆心在 (' + cm(center.x) + ', ' + cm(center.y) + ') cm。' : '放在现有图形右侧。'), { steps: [{ type: 'draw.circle', parameters: { center, radius } }], actions: FIT });
  }
  if (/垂线|垂直线/.test(sentence)) {
    const [base] = meantLines(scene, context, 1), placed = sentence.match(new RegExp('距?(左|右|上|下)端\\s*' + NUM + '?\\s*' + UNIT + '?')), rest = placed ? sentence.replace(placed[0], ' ') : sentence, m = rest.match(LENGTH);
    if (!m) ask('垂线画多长？例如“在选中的线中点作垂线 5，向上”。');
    const where = /中点|中间|正中/.test(sentence) ? { ratio: .5 } : placed ? { from: endOf(base, placed[1]), distance: placed[2] ? fine(toMm(placed[2], placed[3])) : 0 } : null;
    if (!where) ask('垂线从线上的哪个位置起？', [{ label: '中点', send: sentence + ' 中点' }, ...(flat(base) ? ['左', '右'] : ['上', '下']).map(h => ({ label: h + '端', send: sentence + ' ' + h + '端' }))]);
    const heading = headingIn(rest), length = fine(toMm(m[1], m[2])); if (!(length > 0 && length <= 5000)) refuse('垂线长度须大于 0 且不超过 500 cm。');
    if (!heading) askHeading(sentence, base, '垂线朝' + quote(base) + '的哪一侧画？');
    const spot = where.ratio !== undefined ? '中点' : '距' + placed[1] + '端 ' + cm(where.distance) + ' cm 处';
    return plan('在' + quote(base) + '的' + spot + '向' + heading + '作垂线，长 ' + cm(length) + ' cm。', { steps: [{ type: 'draw.perpendicular', parameters: { entityId: base.id, at: where, length, toward: beside(base, heading) } }] });
  }
  if (/结束对称/.test(sentence)) {   // v62: ET's 对称修改, ended
    const keep = /只留镜像|只要镜像|留镜像/.test(sentence) ? 'image' : /只留原线|只要原线|去掉镜像|不要镜像/.test(sentence) ? 'original' : 'both';
    return plan('结束对称修改：' + { both: '原线和镜像都留下', original: '只留原线，去掉镜像', image: '只留镜像，去掉原线' }[keep] + '。镜像不再跟着原线变。', { steps: [{ type: 'symmetry.end', parameters: { keep } }] });
  }
  if (/对称修改/.test(sentence)) {
    const [base, axis] = meantLines(scene, context, 2);
    return plan('以' + quote(axis) + '为对称轴，给' + quote(base) + '做一条跟着它变的镜像。之后改' + quote(base) + '，镜像会一起变；改好以后说“结束对称修改”。', { steps: [{ type: 'symmetry.begin', parameters: { entityIds: [base.id], axisEntityId: axis.id } }] });
  }
  if (/切断|打断/.test(sentence)) {   // v61: ET's 要素打断, the smart pen's 要素切断
    const [base, cutter] = meantLines(scene, context, 2);
    return plan('把' + quote(base) + '在' + quote(cutter) + '与它相交的地方切开，切成的各段是独立的线；' + quote(cutter) + '不变。', { steps: [{ type: 'line.cut', parameters: { cutterEntityId: cutter.id, entityIds: [base.id] } }] });
  }
  if (/两端修正|两端(?:都)?修/.test(sentence)) {
    const [base, first, second] = meantLines(scene, context, 3);
    return plan('把' + quote(base) + '的两端分别修到' + quote(first) + '和' + quote(second) + '上：够不着的延长，越过的剪掉。', { steps: [{ type: 'line.correctEnds', parameters: { entityId: base.id, boundaryEntityIds: [first.id, second.id] } }] });
  }
  if (/一端修正|修正到|修到|延长到|延伸到|剪到|修剪到/.test(sentence)) {
    const [base, boundary] = meantLines(scene, context, 2), ended = sentence.match(/(左|右|上|下)端/);
    // without a named end: the end that lies nearer to the other line
    const reach = q => { const a = boundary.from, b = boundary.to, dx = b.x - a.x, dy = b.y - a.y, k = dx * dx + dy * dy, t = k ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / k)) : 0; return Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy); };
    const end = ended ? endOf(base, ended[1]) : reach(base.from) <= reach(base.to) ? 'start' : 'end';
    return plan('把' + quote(base) + (ended ? '的' + ended[1] + '端' : '靠近' + quote(boundary) + '的一端') + '修到' + quote(boundary) + '上：够不着就延长过去，越过了就剪掉。', { steps: [{ type: 'line.correctEnd', parameters: { entityId: base.id, boundaryEntityId: boundary.id, end } }] });
  }
  if (/减点/.test(sentence)) {
    const every = /(全部|所有|整层|整张)/.test(sentence), chosen = every ? drawnLines(scene).filter(l => l.kind === 'curve') : meantLines(scene, context, 1), m = sentence.match(LENGTH);
    if (!chosen.length) refuse('图上没有曲线。');
    if (chosen.some(l => l.kind !== 'curve')) refuse(quote(chosen.find(l => l.kind !== 'curve')) + '不是曲线，没有曲线点可以减。');
    const tolerance = m ? fine(toMm(m[1], m[2])) : .1; if (!(tolerance > 0 && tolerance <= 10)) refuse('允许的形状变化须大于 0 且不超过 1 cm。');
    return plan((every ? '给图上全部 ' + chosen.length + ' 条曲线' : '给' + quote(chosen[0])) + '减点：去掉对形状影响最小的曲线点，形状变化不超过 ' + cm(tolerance) + ' cm。', { steps: [{ type: 'curve.reducePoints', parameters: { entityIds: chosen.map(l => l.id), tolerance } }] });
  }
  if (/(曲线点|点数)/.test(sentence) && /(\d+)\s*个/.test(sentence)) {
    const [base] = meantLines(scene, context, 1), count = Number(sentence.match(/(\d+)\s*个/)[1]);
    if (base.kind !== 'curve') refuse(quote(base) + '不是曲线。');
    if (!(count >= 2 && count <= 120)) refuse('曲线点数须在 2 到 120 之间。');
    return plan('把' + quote(base) + '改成 ' + count + ' 个等距的曲线点，两端不动。', { steps: [{ type: 'curve.setPointCount', parameters: { entityId: base.id, count } }] });
  }
  if (!changes.length && /(加长|延长|放长|缩短|改短|剪短|长度改|线长改|改成长|改为长)/.test(sentence) && /(线|选中|它|这条)/.test(sentence)) {
    const [base] = meantLines(scene, context, 1), ended = sentence.match(/(左|右|上|下)端/), rest = ended ? sentence.replace(ended[0], ' ') : sentence, m = rest.match(LENGTH);
    if (!m) ask('要加长或缩短多少，或者改成多长？例如“把选中的线右端加长 2”。');
    if (base.kind !== 'line' && base.kind !== 'curve') refuse(quote(base) + '不是直线或曲线，不能调整长度。');
    if (!ended) ask('调整' + quote(base) + '的哪一端？', (flat(base) ? ['左', '右'] : ['上', '下']).map(h => ({ label: h + '端', send: sentence + ' ' + h + '端' })));
    const value = fine(toMm(m[1], m[2])), absolute = /(长度改|线长改|改成长|改为长|改成|改为|改到)/.test(sentence), shorter = /(缩短|改短|剪短)/.test(sentence), end = endOf(base, ended[1]);
    if (!(value > 0)) refuse('数值须大于 0。');
    const how = base.kind === 'curve' ? (absolute ? '曲线加长时顺着端部的方向加一个曲线点，缩短时按长度截断。' : shorter ? '曲线按长度截断，留下的部分形状不变。' : '顺着端部的方向加一个曲线点。') : '';
    return plan((absolute ? '移动' + quote(base) + '的' + ended[1] + '端，使线长为 ' + cm(value) + ' cm。' : '把' + quote(base) + '的' + ended[1] + '端' + (shorter ? '缩短 ' : '加长 ') + cm(value) + ' cm。') + how,
      { steps: [{ type: 'line.setLength', parameters: { entityId: base.id, end, ...(absolute ? { length: value } : { delta: shorter ? -value : value }) } }] });
  }
  return null;
}

// ---------------------------------------------------------------- piece operations
function planPieceOperation(sentence, scene, context) {
  const bare = withoutNames(sentence, scene), number = bare.match(LENGTH), draftNote = (pieces, verb) => pieces.some(p => p.draftId) ? [verb + '后这套纸样被视为手工修改，再按尺寸重算时需要确认丢弃。'] : [];
  if (/(裁片合并|合并裁片|合成一片|并成一片|合成一个裁片|并到|并过去)/.test(sentence) || (/合并/.test(sentence) && !/(拟合|拼接)/.test(sentence))) if (!/(选中的线|这条线|这些线|这几条线|条线|文字)/.test(sentence)) {   // v62: ET's 裁片合并
    const named = namedPieces(sentence, scene, context).pieces;
    if (named.length !== 2) refuse('裁片合并要两个裁片：请说出两个裁片的名称，例如“把后片并到前片上”，或者先选中这两个裁片再说“合并选中的裁片”。也可以打开左侧“画线”里的“裁片合并”，在两片上各点一条边。');
    // "把 X 并到 Y 上": Y stays where it is. Otherwise the piece named first stays.
    const onto = sentence.match(/并(?:到|在|过去到|入)(.+?)(?:上|里|$)/), stay = onto ? named.find(p => onto[1].includes(normalize(p.name))) || named[0] : [...named].sort((x, y) => sentence.indexOf(normalize(x.name)) - sentence.indexOf(normalize(y.name)))[0], move = named.find(p => p !== stay);
    const pairs = stay.contour.flatMap(a => move.contour.filter(b => a.from && b.from && Math.abs(Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y) - Math.hypot(b.to.x - b.from.x, b.to.y - b.from.y)) <= 1).map(b => [a, b]));
    const said = pairs.filter(([a, b]) => sentence.includes(normalize(a.name)) && sentence.includes(normalize(b.name))), use = said.length === 1 ? said : pairs;
    if (!use.length) refuse('“' + stay.name + '”和“' + move.name + '”没有一样长的两条边（两端的距离相差 1 mm 以内）。不一样长也可以合并，但要指明是哪两条边：请打开左侧“画线”里的“裁片合并”，在两片上各点一条边。');
    if (use.length > 1) ask('沿哪两条边合并？', use.slice(0, 6).map(([a, b]) => ({ label: a.name + ' 对 ' + b.name, send: '把' + move.name + '并到' + stay.name + '上，' + a.name + '对' + b.name })));
    const [[a, b]] = use;
    return plan('把“' + move.name + '”并到“' + stay.name + '”上：“' + move.name + '”整体转过去、移过去，它的“' + b.name + '”与“' + stay.name + '”的“' + a.name + '”对在一起。“' + b.name + '”删掉，“' + a.name + '”留作内部线；合成的裁片叫“' + stay.name + '”，缝份合成一圈。',
      { steps: [{ type: 'piece.merge', parameters: { first: { entityId: a.entityId }, second: { entityId: b.entityId } } }], assumptions: ['两片分在这条边的两侧，不翻转也不缩放。'] });
  }
  if (/(移动|平移|移|挪)/.test(sentence) && /(左|右|上|下)/.test(bare)) {
    if (!number) ask('要移动多少？例如“向右移动 10”（厘米）。');
    const distance = fine(toMm(number[1], number[2])), pieces = targetPieces(sentence, scene, context, '要移动哪个裁片？');
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
  { label: '按尺寸画直筒裤', send: '画一条直筒裤，腰围76cm 臀围96cm 裤长102cm' },
  { label: '裤长加 2 cm', send: '裤长加2cm' },
  { label: '缝份改成 1.2 cm', send: '缝份改成1.2cm' },
  { label: '画后袋并加缝份', send: '画一个后袋 16x18cm，建成裁片，缝份1cm' },
];
const HELP = '我可以按一句话完成下面这些事。每次先给出计划，你确认后才改图，随时可以撤销：\n· 按尺寸生成直筒裤：“画一条直筒裤，腰围76 臀围96 裤长102”\n· 改尺寸重算：“裤长加2，腰围减1”“脚口改成40”“后翘2.5”\n· 缝份：“缝份改成1.2”“脚口折边4”“给后袋加1cm缝份”“去掉后袋的缝份”\n· 缝边角处理：“后袋上边做反转角”“后片右下角切角1”“后袋上边做台阶角，高0.8 宽1.9”“后片右下角做折叠角”“后片下边做七字角”“后片下边做反转直角”“后片下边做可调反转 2”“后片左下角做双延长角”“后片左下角做双投影角”“后片右下角做单边直角，下边延长 2.6”“后片做曲线断差1，A 2 B 1”（缝份宽度不同的相接处）“裤片下边做反转翻角，A 1”“后片开衩做开叉半止口，A 2 B 1”（也有开叉全止口）“后袋上边恢复普通转角”；两片缝合处的直角、包边延长反转角、延长反转角用画线工具里的“缝边角”\n· 扩展缝边和净边延长：“给后片加扩展缝边 1”“后片下边扩展缝边改成 2”“去掉后片的扩展缝边”“后片净边延长”“后片的内部线延长到环边”\n· 刀口和辅助线：“后袋上边打刀口，离左端5”“后片左边中点打刀口”“删掉后袋上边的刀口”；选中线后“设为辅助线”；“删除辅助线”\n· 提取裁片：选中围成一块的结构线后，“把选中的线提取成裁片，叫袋片，缝份1”（出头的线不用先修剪，原来的线不动）\n· 切展：选中图形全部的结构线后，“等分割展开 4 份，固定侧 上边，展开侧 下边，每刀 2”“沿分割线 割1 割2 展开，固定侧 上边，展开侧 下边，每刀 1.5”“多边展开，基线 上边，分割线 割1 割2，每刀 1”（上边、下边、割1 是线的名字；加“合并拟合”或“分段拟合”把两侧画成曲线）\n· 内部线：选中画在裁片里的线或文字后，“把选中的线加入后袋”“把选中的线移出后袋”\n· 放码（按尺寸表，和 ET 一样）：“放码：号型 S M L XL，基码 M”“尺寸表加 胸围 88 档差 4”“后袋右上角放码 水平 胸围/4 竖直 0.5”“后袋左下角固定”\n· 画部件：“画一个后袋 16x18，建成裁片，缝份1”“画一条30cm的横线”\n· 裁片：“把后袋向右移动10”“复制后袋”“后袋旋转90度”“删除后袋”“把选中的线建成裁片”\n· 选中的线：“向下平行3，2条”“分成4份”“在中点作垂线5，向上”“右端加长2”；选中两条线（直线或曲线）后“做圆角2”“圆角 1 和 2”（两条线上各切开 1 和 2，中间连曲线）“切角 1.5”，选中两条直线后“角连接”；“画一个半径5的圆”\n· 裁片管理：“锁定后袋”“解锁后袋”“把所有裁片排列一下”“前片和后片上边对齐”“裁片面积”\n· 裁片属性：“后袋布料改成里料”“后袋片数改成 2”“后袋设为对称”“给后袋写属性文字”“后袋纱向垂直补正”\n· 修正和曲线点：选中两条线后“把选中的线修到另一条线”（一端修正），选中三条线后“两端修正”；选中两条线后“切断”（先选的线在后选的线那里切开）；“把后片并到前片上”（裁片合并：两片沿一样长的边并成一片）；选中两条线后“对称修改”（后选的直线是对称轴，先选的线多出一条跟着变的镜像），改好以后“结束对称修改”（可以说“只留原线”“只留镜像”）；选中曲线后“右端加长 2”“曲线点改成 8 个”“减点”，“全部曲线减点”\n· 曲线：选中曲线后“左端方向逆时针转 10 度”（曲线端矢调整，两端不动）；“前摆和后摆接角圆顺，缝合线 前侧 后侧，与缝合线垂直”（也可以说“顺成平均方向”）；定长调曲线用画线工具里的“定长调曲线”\n· 测量和文字：选中线后“量一下长度”；选中两条直线后“量夹角”；“在后袋上写文字 样板”；选中文字后“字高改成1”\n· 做省：“后片上边中点做省，省量 2，省长 9”“前片上边离左端 8 做省，省量 2.5，省长 10，画省山”；选中边线和省中线后“斜省，省量 2”；选中两条省边后“省折线，倒向右”；选中一条省边后“单向省，省量 2，向右”；选中一条直线后“两点做省，离左端 5 和 8，省深度 9，朝下”；枣弧省、插入省、掰开省用画线工具\n· 扣位和扣眼：选中一条直线后“排 5 个扣位，直径 1.5”“开 5 个扣眼，长 2”；“删除扣位”；打孔和打枣用画线工具点位置\n· 其他：“撤销”“重做”“保存为PRJ”“全图显示”“现在的尺寸”\n数字可以带单位（mm、cm、英寸，英寸可以写 3/8、1 3/8）；没写单位的数字第一次出现时，我会问是厘米还是英寸并记住，说“按厘米”或“按英寸”可以更换。目前用的是本机内置指令，只认识上面这类说法；接入大模型服务后可以理解更自由的描述。';
function describe(scene) {
  const lines = [];
  for (const draft of scene.drafts || []) lines.push('按尺寸生成的直筒裤：' + ['waist', 'hip', 'thigh', 'hipDepth', 'crotchDepth', 'kneeDepth', 'length'].map(key => INFO[key].label + ' ' + cm(draft.input.measurements[key]) + ' cm').join('，') + '；' +
    ['waistEase', 'hipEase', 'kneeCirc', 'hemCirc', 'seamAllowance', 'hemAllowance'].map(key => INFO[key].label + ' ' + cm(draft.input.rules[key]) + ' cm').join('，') + '。');
  for (const piece of scene.pieces || []) lines.push('裁片“' + piece.name + '”：' + (piece.bbox ? '净样外框 ' + cm(piece.bbox.maxX - piece.bbox.minX) + ' × ' + cm(piece.bbox.maxY - piece.bbox.minY) + ' cm，' : '') + (piece.seam ? '缝份 ' + piece.seam.widthsMm.map(cm).join(' / ') + ' cm' : '没有缝份') + '。');
  if (scene.looseEntities?.length) lines.push('另有 ' + scene.looseEntities.length + ' 个不属于裁片的图元。');
  if (scene.grading) lines.push(describeGradingOf(scene.grading));
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
// ---------------------------------------------------------------- managing pieces, and measuring (v53)
const ALIGN_WORD = { left: '左边', right: '右边', top: '上边', bottom: '下边', centerX: '左右居中', centerY: '上下居中' };
const squareCm = mm2 => String(Math.round(mm2) / 100);
function planManage(sentence, scene, context) {
  const pieces = scene.pieces || [];
  if (/锁定|锁住|锁上|解锁/.test(sentence)) {
    const unlock = /解锁|解除锁定|取消锁定|不再锁定/.test(sentence), targets = targetPieces(sentence, scene, context, unlock ? '要解锁哪个裁片？' : '要锁定哪个裁片？'), change = targets.filter(p => Boolean(p.locked) === unlock);
    if (!change.length) refuse(quoted(targets) + (unlock ? '没有锁定。' : '已经锁定了。'));
    return plan((unlock ? '解锁' : '锁定') + quoted(change) + (unlock ? '。' : '。锁定后不能移动、修改或删除，说“解锁”可以恢复。'), { steps: [{ type: 'piece.setLocked', parameters: { groupIds: change.map(p => p.id), locked: !unlock } }] });
  }
  if (/(排列|排一下|排整齐|摆整齐|摆开|排开|分类放置)/.test(sentence) && /(裁片|纸样|全部|所有)/.test(sentence)) {
    const free = pieces.filter(p => !p.locked); if (!free.length) refuse(pieces.length ? '裁片都锁定了，没有可以排列的。' : '画布上还没有裁片。');
    if (free.length < 2) refuse('只有“' + free[0].name + '”一个裁片没有锁定，不需要排列。');
    const gap = withoutNames(sentence, scene).match(LENGTH), parameters = gap ? { gap: fine(toMm(gap[1], gap[2])) } : {};
    if (gap && !(parameters.gap >= 0 && parameters.gap <= 1000)) refuse('间隔须在 0 到 100 cm 之间。');
    return plan('把 ' + free.length + ' 个裁片排成几行，互不重叠，间隔 ' + cm(gap ? parameters.gap : 20) + ' cm。' + (free.length < pieces.length ? '锁定的裁片不动。' : ''), { steps: [{ type: 'piece.arrange', parameters }], actions: FIT });
  }
  const side = sentence.match(/(左右居中|上下居中|水平居中|垂直居中|[左右上下顶底])(?:部|边|端|侧)?(?:对齐|靠齐|齐平)/) || sentence.match(/(左右居中|上下居中)/);
  if (side && /裁片|片|袋|对齐|居中/.test(sentence)) {
    const edge = { 左: 'left', 右: 'right', 上: 'top', 顶: 'top', 下: 'bottom', 底: 'bottom', 左右居中: 'centerX', 水平居中: 'centerX', 上下居中: 'centerY', 垂直居中: 'centerY' }[side[1]], named = namedPieces(sentence, scene, context);
    // the piece named first is the one the others move to
    const order = named.how === 'named' ? [...named.pieces].sort((a, b) => sentence.indexOf(normalize(a.name)) - sentence.indexOf(normalize(b.name))) : named.pieces;
    if (order.length < 2) ask('要对齐哪几个裁片？请说出至少两个裁片的名称，先说的那个是基准，例如“' + (pieces[0]?.name || '前片') + '和' + (pieces[1]?.name || '后片') + '左边对齐”。');
    return plan('以“' + order[0].name + '”为准，把' + quoted(order.slice(1)) + '移到' + ALIGN_WORD[edge] + '对齐。', { steps: [{ type: 'piece.align', parameters: { groupIds: order.map(p => p.id), edge } }], assumptions: named.how === 'named' ? [] : ['没有说以哪个为准，按“' + order[0].name + '”。'] });
  }
  // what a piece is cut from: fabric, how many, symmetric or not
  const fabric = sentence.match(/(面料|里料|里布)/), pieceCount = sentence.match(/(?:片数|裁)\s*(?:改成|改为|设为|为|是|=)?\s*(\d+)\s*片?/) || sentence.match(/(\d+)\s*片/);
  const asksSymmetry = /对称/.test(sentence) && /(设为|设成|改成|改为|属性|不对称|不是对称|是对称)/.test(sentence);
  if (!/(属性文字|面积|周长|几片|多少片)/.test(sentence) && (/(布料|片数)/.test(sentence) || (fabric && /(改成|改为|换成|设为|用)/.test(sentence)) || pieceCount || asksSymmetry)) {
    const targets = targetPieces(sentence, scene, context, '要设置哪个裁片的属性？'), parameters = {};
    if (fabric) parameters.material = fabric[1];
    if (pieceCount) { parameters.count = Number(pieceCount[1]); if (!(parameters.count >= 1 && parameters.count <= 99)) refuse('片数须在 1 到 99 之间。'); }
    if (asksSymmetry) parameters.symmetric = !/(不对称|不是对称)/.test(sentence);
    if (!Object.keys(parameters).length) ask('要改成什么？例如“' + targets[0].name + '布料改成里料”“' + targets[0].name + '片数改成 2”“' + targets[0].name + '设为对称”。目前认识的布料是面料、里料、里布。');
    const change = targets.filter(p => (parameters.material !== undefined && p.fabric !== parameters.material) || (parameters.count !== undefined && p.count !== parameters.count) || (parameters.symmetric !== undefined && Boolean(p.symmetric) !== parameters.symmetric));
    if (!change.length) refuse(quoted(targets) + '已经是这样了。');
    const words = [parameters.material && '布料' + parameters.material, parameters.count && parameters.count + ' 片', parameters.symmetric === true && '对称', parameters.symmetric === false && '不对称'].filter(Boolean).join('，');
    return plan('把' + quoted(change) + '设为：' + words + '。保存为 ET 文件时一起写入。', { steps: change.map(p => ({ type: 'piece.setAttributes', parameters: { groupId: p.id, ...parameters } })) });
  }
  if (/(属性文字|标注属性|裁片标注|写上属性)/.test(sentence)) {
    const targets = targetPieces(sentence, scene, context, '要给哪个裁片写属性文字？'), size = sentence.match(new RegExp('字高\\s*(?:为|是|=)?\\s*' + NUM + '\\s*' + UNIT + '?')), height = size ? fine(toMm(size[1], size[2])) : null;
    if (height !== null && !(height > 0 && height <= 1000)) refuse('字高须大于 0 且不超过 100 cm。');
    return plan('在' + quoted(targets) + '上写一行属性文字（名称、布料、片数）' + (height ? '，字高 ' + cm(height) + ' cm' : '') + '。之后改名称或属性，文字跟着变。', { steps: targets.map(p => ({ type: 'piece.label', parameters: { groupId: p.id, ...(height ? { height } : {}) } })) });
  }
  if (/(纱向|布纹)/.test(sentence) && /(垂直|竖直|水平|横)/.test(sentence) && /(补正|摆正|转正|调正|转成|改成)/.test(sentence)) {
    const axis = /(水平|横)/.test(sentence) ? 'horizontal' : 'vertical', targets = targetPieces(sentence, scene, context, '要补正哪个裁片的纱向？');
    return plan('把' + quoted(targets) + '整片转动，使布纹线' + (axis === 'vertical' ? '垂直' : '水平') + '。', { steps: targets.map(p => ({ type: 'piece.alignGrain', parameters: { groupId: p.id, axis } })) });
  }
  if (/(面积|周长|裁片清单|裁片列表|裁片信息|几个裁片|多少个裁片|多少片|几片)/.test(sentence)) {
    if (!pieces.length) return plan('画布上还没有裁片。');
    const named = namedPieces(sentence, scene, context), list = named.pieces.length ? named.pieces : pieces, known = list.filter(p => typeof p.areaMm2 === 'number');
    const lines = list.map(p => '“' + p.name + '”：' + (typeof p.areaMm2 === 'number' ? '净样面积 ' + squareCm(p.areaMm2) + ' 平方厘米，周长 ' + cm(p.perimeterMm) + ' cm' : '轮廓不完整，算不出面积') + (p.locked ? '，已锁定' : '') + '。');
    return plan((list.length > 1 ? '共 ' + list.length + ' 个裁片，净样面积合计 ' + squareCm(known.reduce((sum, p) => sum + p.areaMm2, 0)) + ' 平方厘米。\n' : '') + lines.join('\n') + '\n毛样面积、缝份和刀口数在顶部的“裁片清单”里，可以导出表格。');
  }
  if (/(量一下|量量|量出|测量|量长度|多长|总长|长度是多少|夹角|角度是多少|量角)/.test(sentence)) {
    const chosen = new Set(context.selection?.entityIds || []), lines = [...(scene.looseEntities || []).filter(e => chosen.has(e.id) && e.kind !== 'text').map(e => ({ ...e, entityId: e.id })), ...pieces.flatMap(p => p.contour.filter(e => chosen.has(e.entityId)))];
    if (!lines.length) refuse('请先在画布上选中要量的线（可以选多条），再说“量一下长度”；选中两条直线后可以说“量夹角”。画线工具里还有量角度、三点角度、线上两点、综合测量和皮尺。');
    if (/夹角|角度|量角/.test(sentence)) {
      if (lines.length !== 2 || lines.some(l => l.kind !== 'line')) refuse('量夹角需要正好选中两条直线，现在选中的是 ' + lines.length + ' 条线' + (lines.some(l => l.kind !== 'line') ? '，其中有曲线或折线' : '') + '。曲线的夹角请用画线工具里的“量角度”，它按点击处的切线算。');
      const [a, b] = lines.map(l => ({ x: l.to.x - l.from.x, y: l.to.y - l.from.y })), angle = Math.atan2(Math.abs(a.x * b.y - a.y * b.x), a.x * b.x + a.y * b.y) * 180 / Math.PI, acute = Math.min(angle, 180 - angle);
      return plan('“' + lines[0].name + '”和“' + lines[1].name + '”' + (acute < 1e-6 ? '互相平行。' : '的夹角是 ' + fine(acute) + '°，另一侧是 ' + fine(180 - acute) + '°。'));
    }
    const total = lines.reduce((sum, l) => sum + l.lengthMm, 0);
    return plan(lines.length === 1 ? '“' + lines[0].name + '”长 ' + cm(lines[0].lengthMm) + ' cm。' : '选中的 ' + lines.length + ' 条线总长 ' + cm(total) + ' cm：' + lines.slice(0, 12).map(l => '“' + l.name + '” ' + cm(l.lengthMm) + ' cm').join('，') + (lines.length > 12 ? ' 等' : '') + '。');
  }
  const size = sentence.match(new RegExp('(?:字高|字号|字的?大小|文字大小)\\s*(?:改成|改为|改到|设为|设成|调成|调到|为|是|=)?\\s*' + NUM + '\\s*' + UNIT + '?'));
  if (size) {
    const chosen = new Set(context.selection?.entityIds || []), texts = [...(scene.looseEntities || []).filter(e => e.kind === 'text' && chosen.has(e.id)).map(e => ({ id: e.id, name: e.name })), ...pieces.flatMap(p => p.otherMembers.filter(e => e.kind === 'text' && chosen.has(e.entityId)).map(e => ({ id: e.entityId, name: e.name })))];
    if (!texts.length) refuse('请先在画布上选中要改的文字，再说一遍；也可以用画线工具里的“改文字”直接点选。');
    const height = fine(toMm(size[1], size[2])); if (!(height > 0 && height <= 1000)) refuse('字高须大于 0 且不超过 100 cm。');
    return plan('把选中的 ' + texts.length + ' 行文字的字高改成 ' + cm(height) + ' cm。', { steps: texts.map(t => ({ type: 'text.edit', parameters: { entityId: t.id, height } })) });
  }
  return null;
}

// ---------------------------------------------------------------- buttons, buttonholes, drill holes, bartacks (v53)
function planMarks(sentence, scene, context) {
  const kind = /扣眼/.test(sentence) ? 'buttonhole' : /(扣位|扣子|钮扣|纽扣|钉扣)/.test(sentence) ? 'button' : /(打孔|钻孔|孔位)/.test(sentence) ? 'drill' : /打枣/.test(sentence) ? 'bartack' : null;
  if (!kind) return null;
  const word = { button: '扣位', buttonhole: '扣眼', drill: '打孔', bartack: '打枣' }[kind];
  const rows = [...(scene.looseMarks || []), ...(scene.pieces || []).flatMap(p => p.marks || [])].filter(row => row.kind === kind);
  if (/(删除|删掉|去掉|清除|清掉)/.test(sentence)) {
    if (!rows.length) refuse('画布上没有' + word + '。');
    if (rows.length > 1) refuse('画布上有 ' + rows.length + ' 排' + word + '。请打开左侧的“画线”工具，用“删标记”点要删的那一排。');
    return plan('删掉这排' + word + '（' + rows[0].count + ' 个）。', { steps: [{ type: 'mark.remove', parameters: { entityId: rows[0].entityId } }] });
  }
  if (kind === 'drill' || kind === 'bartack') refuse(word + '的位置要在图上点：请打开左侧的“画线”工具，用“' + word + '”点位置。');
  const byId = new Map(drawnLines(scene).map(l => [l.id, l])), lines = (context.selection?.entityIds || []).map(id => byId.get(id)).filter(l => l && l.kind === 'line');
  if (lines.length !== 1) refuse('请先在画布上选中一条直线，' + word + '排在它的两端之间，再说一遍，例如“在选中的线上排 5 个' + word + '，' + (kind === 'button' ? '直径 1.5' : '长 2') + '”。也可以用画线工具里的“' + word + '”直接点第一个和最后一个的位置。');
  const count = sentence.match(/(\d+)\s*(?:个|粒|颗|只)/); if (!count) ask('要排几个' + word + '？例如“5 个”。');
  const n = Number(count[1]); if (!(n >= 1 && n <= 100)) refuse('个数须在 1 到 100 之间。');
  const size = sentence.replace(count[0], ' ').match(new RegExp('(?:直径|长度|长|大小)\\s*(?:为|是|=)?\\s*' + NUM + '\\s*' + UNIT + '?'));
  if (!size) ask(kind === 'button' ? '扣子直径多少？例如“直径 1.5”。' : '扣眼多长？例如“长 2”。');
  const mm = fine(toMm(size[1], size[2])); if (!(mm > 0 && mm <= 500)) refuse((kind === 'button' ? '直径' : '长度') + '须大于 0 且不超过 50 cm。');
  const l = lines[0], along = /顺|竖/.test(sentence);
  return plan('在“' + l.name + '”的两端之间等距排 ' + n + ' 个' + word + '，' + (kind === 'button' ? '直径 ' : '长 ') + cm(mm) + ' cm' + (kind === 'buttonhole' ? (along ? '，顺着这条线' : '，横着（与这条线垂直）') : '') + '。',
    { steps: [{ type: kind === 'button' ? 'mark.buttons' : 'mark.buttonholes', parameters: { from: l.from, ...(n > 1 ? { to: l.to } : {}), count: n, ...(kind === 'button' ? { diameter: mm } : { length: mm, direction: along ? 'along' : 'across' }) } }],
      assumptions: kind === 'buttonhole' && !/横|顺|竖/.test(sentence) ? ['没有说方向，扣眼按横向。'] : [] });
}

// ---- a piece taken out of structure lines (v59): the selected lines enclose it, the parts between their crossings are copied
function planExtract(sentence, scene, context, changes) {
  if (!/(提取|取出)/.test(sentence) || !/(裁片|样片)/.test(sentence)) return null;
  const chosen = context.selection?.entityIds || [], loose = new Set((scene.looseEntities || []).filter(e => e.kind !== 'text').map(e => e.id)), ids = chosen.filter(id => loose.has(id));
  if (!ids.length) refuse('请先在画布上选中围成这个裁片的结构线（出头的不用修剪），再说一遍；也可以用画线工具里的“提取裁片”，在那一块里面点一下。');
  const called = sentence.match(/(?:叫做|叫|名叫|名字叫|名为|命名为|取名)\s*[“"「]?([^，。,；;\s”"」]+)/), name = called ? called[1] : '裁片 ' + ((scene.pieces || []).length + 1);
  const width = seamWidth(sentence, changes); if (width === undefined) refuse('请直接说缝份宽度，例如“缝份 1”。');
  return plan('从选中的 ' + ids.length + ' 条结构线里取出裁片“' + name + '”：各条线在交点之间的那一段被复制出来连成轮廓，原来的线不动' + (width ? '；加 ' + cm(width) + ' cm 缝份' : '') + '。',
    { steps: [{ type: 'piece.extract', parameters: { name, entityIds: ids, ...(width ? { seamWidth: checkSeam(width) } : {}) } }], assumptions: [...(called ? [] : ['没有说名字，先叫“' + name + '”。']), ...(ids.length < chosen.length ? ['选中的里面有 ' + (chosen.length - ids.length) + ' 个已经属于裁片或不是线，没有用。'] : [])] });
}

// ---- cutting a figure of loose lines into strips and spreading them (v60): the selected lines are the figure, its sides
// and cut lines are called by their names after the words 固定侧, 展开侧, 分割线 and 基线
function planSpread(sentence, scene, context) {
  const base = /多边(分割)?(展开|切展)/.test(sentence), equal = !base && /(等分割|等分展开|等分切展|固定等分)/.test(sentence), atLines = !base && !equal && /(指定分割|沿.{0,40}(展开|切展)|按分割线.{0,4}(展开|切展))/.test(sentence) && /分割/.test(sentence);
  if (!base && !equal && !atLines) return null;
  const example = base ? '多边展开，基线 上边，分割线 割1 割2，每刀 1' : equal ? '等分割展开 4 份，固定侧 上边，展开侧 下边，每刀 2' : '沿分割线 割1 割2 展开，固定侧 上边，展开侧 下边，每刀 1.5';
  const chosen = new Set(context.selection?.entityIds || []), lines = (scene.looseEntities || []).filter(e => e.kind !== 'text' && chosen.has(e.id));
  if (lines.length < 3) refuse('请先在画布上选中这个图形全部的线（两侧的线、两头的线、里面的线；须是还没有做成裁片的线），再说一遍，例如“' + example + '”。也可以用画线工具里的切展工具。');
  // every name of a selected line found in the sentence belongs to the word before it
  const WORDS = ['固定侧', '展开侧', '分割线', '基线'], marks = WORDS.flatMap(word => [...sentence.matchAll(new RegExp(word, 'g'))].map(m => ({ word, at: m.index }))).sort((p, q) => p.at - q.at);
  const told = Object.fromEntries(WORDS.map(word => [word, []])), taken = [];
  for (const l of lines.slice().sort((p, q) => q.name.length - p.name.length)) {
    if (!l.name) continue;
    const where = sentence.toLowerCase(), name = l.name.toLowerCase();   // the sentence may have been put in lower case on its way here
    for (let at = where.indexOf(name); at >= 0; at = where.indexOf(name, at + 1)) {
      if (taken.some(([from, to]) => at < to && at + l.name.length > from)) continue;
      const before = marks.filter(mark => mark.at < at).at(-1); if (!before) continue;
      taken.push([at, at + l.name.length]); told[before.word].push({ id: l.id, name: l.name, at });
    }
  }
  const of = word => told[word].sort((p, q) => p.at - q.at).filter((l, i, list) => list.findIndex(x => x.id === l.id) === i), called = list => list.map(l => l.name).join('、');
  const need = (word, list) => { if (!list.length) refuse('请说出' + word + '是哪条线（用线的名字，须是选中的线），例如“' + example + '”。选中的线有：' + lines.slice(0, 12).map(l => l.name).join('、') + (lines.length > 12 ? ' 等' : '') + '。'); return list; };
  // "固定侧张开 0.5" is the fixed side's amount (the verb must be there: after 固定侧 alone comes a name); what is left gives the amount of every cut
  const NUMBER = '\\s*(-?)\\s*' + NUM + '\\s*' + UNIT + '?', value = m => (m[1] ? -1 : 1) * toMm(m[2], m[3]);
  const fixedTold = sentence.match(new RegExp('固定侧(?:也|各|每刀|每一刀)*(?:张开|展开|开)' + NUMBER)), onFixed = fixedTold ? value(fixedTold) : null, remaining = fixedTold ? sentence.replace(fixedTold[0], ' ') : sentence;
  const eachTold = remaining.match(new RegExp('(?:每一?刀|每条线?|展开量|分割量|展开侧(?:各|每刀|每一刀)*(?:张开|展开|开))\\s*(?:张开|展开|开|为|是|[:：])?' + NUMBER)); if (!eachTold) refuse('请说每一刀张开多少，例如“每刀 2”。');
  const each = value(eachTold);
  const entityIds = lines.map(l => l.id), fit = /合并拟合/.test(sentence) ? 'merged' : /分段拟合/.test(sentence) ? 'each' : 'none', fitted = fit === 'merged' ? '；每一侧合并拟合成一条曲线' : fit === 'each' ? '；两侧原来的每条线各拟合成一条曲线' : '';
  const tail = '原来的线被换成切开的各段，可以撤销。';
  if (base) {
    const baseLines = need('基线', of('基线')), cuts = need('分割线', of('分割线')); if (!(each > 0)) refuse('多边展开的量须大于 0。');
    return plan('把选中的 ' + lines.length + ' 条线多边展开：基线（' + called(baseLines) + '）两端不动，依次沿 ' + called(cuts) + ' 展开，每条分割线的远端张开 ' + cm(each) + ' cm。' + tail,
      { steps: [{ type: 'spread.fromBase', parameters: { entityIds, baseIds: baseLines.map(l => l.id), cutIds: cuts.map(l => l.id), amount: each } }] });
  }
  const fixed = need('固定侧', of('固定侧')), spread = need('展开侧', of('展开侧')), sides ='固定侧（' + called(fixed) + '）' + (onFixed ? '每刀张开 ' + cm(onFixed) + ' cm' : '不张开') + '，展开侧（' + called(spread) + '）每刀张开 ' + cm(each) + ' cm';
  const common = { entityIds, fixedIds: fixed.map(l => l.id), spreadIds: spread.map(l => l.id), spreadAmount: each, ...(onFixed ? { fixedAmount: onFixed } : {}), ...(fit === 'none' ? {} : { fit }) };
  if (equal) {
    const count = sentence.match(/(\d+)\s*(?:等分|份)/) || sentence.match(/(?:等分|分)(?:成|为)\s*(\d+)/) || sentence.match(/(?:等分割展开|等分展开|等分切展)\s*(\d+)/); if (!count) refuse('请说等分成几条，例如“4 份”。');
    const parts = Number(count[1]); if (!(parts >= 2 && parts <= 200)) refuse('等分数须是 2 到 200。');
    return plan('把选中的 ' + lines.length + ' 条线等分割展开：从固定侧到展开侧等分成 ' + parts + ' 条，' + sides + fitted + '。' + tail, { steps: [{ type: 'spread.equal', parameters: { ...common, parts } }] });
  }
  const cuts = need('分割线', of('分割线'));
  return plan('把选中的 ' + lines.length + ' 条线沿分割线（' + called(cuts) + '）切开展开：' + sides + fitted + '。' + tail, { steps: [{ type: 'spread.atLines', parameters: { ...common, cutIds: cuts.map(l => l.id) } }] });
}

// ---- lines and texts put into a piece, or taken out of it (v58)
function planMembers(sentence, scene, context) {
  const into = /(加入|加进|加到|归入|并入|放进|算进)/.test(sentence), outOf = /(移出|拿出|剔出|退出)/.test(sentence);
  if ((!into && !outOf) || !/(选中|所选|选的|这条线|这些线|这行字|这些字)/.test(sentence)) return null;
  const named = namedPieces(withoutWords(sentence), scene, context); if (named.how !== 'named' || named.pieces.length !== 1) return null;
  const piece = named.pieces[0], chosen = context.selection?.entityIds || [];
  if (!chosen.length) refuse('请先在画布上选中要' + (into ? '加进' : '移出') + '“' + piece.name + '”的线或文字，再说一遍。');
  if (into) {
    const loose = new Set((scene.looseEntities || []).map(e => e.id)), ids = chosen.filter(id => loose.has(id));
    if (!ids.length) refuse('选中的线或文字都已经属于裁片了；只有不属于任何裁片的才能加进去。');
    return plan('把选中的 ' + ids.length + ' 个线或文字加进“' + piece.name + '”，成为它的内部线：之后跟着这个裁片移动、复制和保存。', { steps: [{ type: 'piece.addMembers', parameters: { groupId: piece.id, entityIds: ids } }],
      assumptions: ids.length < chosen.length ? ['选中的里面有 ' + (chosen.length - ids.length) + ' 个已经属于裁片，没有动。'] : [] });
  }
  const inside = new Set((piece.otherMembers || []).filter(e => e.layer !== 'grain').map(e => e.entityId)), ids = chosen.filter(id => inside.has(id));
  if (!ids.length) refuse('选中的线或文字不是“' + piece.name + '”的内部线。轮廓线和布纹线不能移出。');
  return plan('把选中的 ' + ids.length + ' 个线或文字从“' + piece.name + '”里移出来，变成不属于裁片的线；线本身不删。', { steps: [{ type: 'piece.removeMembers', parameters: { groupId: piece.id, entityIds: ids } }] });
}
const withoutWords = sentence => sentence.replace(/(选中的?|所选的?|选的)/g, ' ');

// ---- grading by a size table (v57): the sizes, the rows of the size table, the rule of a corner of a piece
const GRADE_WORD = /(放码|号型|尺寸表|档差|推板|推档)/;
// v68: sentences about ET's 对齐 / 对齐移动点 (they need not say 放码)
const LOCK_GRADE = /锁定|解锁|锁住|整码保持|[A-Za-z0-9]码[^,，;；]*?(往|向)(左|右|上|下)/;   // v69: ET's locks and moves in one size
// the sizes a sentence names (longest names first, so that L is not found inside XL)
function sizesNamed(raw, names) {
  let rest = raw; const found = [];
  for (const name of [...names].sort((a, b) => b.length - a.length)) { const pattern = new RegExp('(?<![A-Za-z0-9])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])'); if (pattern.test(rest)) { found.push(name); rest = rest.replace(pattern, ' '); } }
  return names.filter(name => found.includes(name));
}
const ALIGN_GRADE = /(各码|叠码|网状).*对齐|对齐.*(各码|叠码)|^(取消|去掉|清除)(各码的?|放码的?)?对齐$|(左上|右上|左下|右下)角?相对(于)?(左上|右上|左下|右下)角?/;
// a corner of a piece's outline, as the rule sentences pick it: the outline point farthest that way
function cornerOf(piece, spot) {
  const edges = piece.contour.flatMap(e => e.points ? e.points.map((p, i) => ({ entityId: e.entityId, from: p, to: e.points[(i + 1) % e.points.length] })) : e.kind === 'closed-polyline' ? [] : [{ entityId: e.entityId, from: e.from, to: e.to }]);
  if (!edges.length) refuse('“' + piece.name + '”的轮廓太复杂，请在放码面板里点线来设。');
  const vertex = edges.flatMap(e => [e.from, e.to]).reduce((best, p) => { const value = q => ({ 'left-top': -q.x + q.y, 'right-top': q.x + q.y, 'left-bottom': -q.x - q.y, 'right-bottom': q.x - q.y })[spot[0]]; return value(p) > value(best) ? p : best; });
  const edge = edges.find(e => Math.hypot(e.from.x - vertex.x, e.from.y - vertex.y) < .01 || Math.hypot(e.to.x - vertex.x, e.to.y - vertex.y) < .01);
  return { entityId: edge.entityId, at: { x: vertex.x, y: vertex.y } };
}
// (names of sizes, of table rows and formulas keep their capitals: the sentence as typed, with only its punctuation made plain)
const plain = text => [...String(text)].map(c => { const code = c.codePointAt(0); return code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : code === 0x3000 ? ' ' : c; }).join('').replace(/、/g, ',').replace(/[。!]/g, ';').replace(/\s+/g, ' ').trim();
const inCm = (raw, unit) => Math.round(toMm(raw, unit) / 10 * 1e6) / 1e6;
const GRADE_EXAMPLES = [{ label: '设号型', send: '放码：号型 S M L XL，基码 M' }, { label: '尺寸表加一项', send: '尺寸表加 胸围 88 档差 4' }, { label: '给转角设规则', send: '右上角放码 水平 胸围/4 竖直 0.5' }];
function describeGradingOf(grading) {
  return '放码（按尺寸表）：号型 ' + grading.sizes.map(name => name === grading.baseSize ? name + '（基码）' : name).join('、') + '；尺寸表 ' + (grading.measures.length ? grading.measures.map(m => m.name + ' ' + m.valuesCm.join('/')).join('，') + '（厘米）' : '还是空的')
    + '；' + grading.ruleCount + ' 个点有放码规则。' + (grading.rulesLostToEdits ? '有 ' + grading.rulesLostToEdits + ' 条规则因为改图失去了位置。' : '');
}
function planGrading(sentence, scene, context, original) {
  const grading = scene.grading || null, tight = sentence.replace(/\s/g, '');
  // (“后袋左下角固定” is about grading when the drawing has a grading plan)
  if (!GRADE_WORD.test(sentence) && !(grading && /固定点?$/.test(tight) && CORNER_SPOTS.some(item => item[1].test(sentence))) && !(grading && ALIGN_GRADE.test(tight)) && !(grading && LOCK_GRADE.test(tight))) return null;
  const raw = plain(original ?? sentence);
  const none = () => refuse('这张图还没有按尺寸表放码的方案。先说号型，例如“放码：号型 S M L XL，基码 M”。', { choices: GRADE_EXAMPLES.slice(0, 1) });
  if (/^(现在|当前|目前)?的?放码(方案)?(情况|状态|是什么|有哪些|怎么样)?\??$/.test(tight)) return plan(grading ? describeGradingOf(grading) : '这张图还没有按尺寸表放码的方案。', { choices: grading ? [] : GRADE_EXAMPLES.slice(0, 1) });
  if (/^(删除|删掉|去掉|清除|取消)(全部|所有|整套|这套)?的?放码(方案)?$/.test(tight)) { if (!grading) none(); return plan('删掉这套放码：号型、尺寸表和全部规则。基码纸样不动。', { steps: [{ type: 'grade.clear', parameters: {} }] }); }
  // 号型 S M L XL，基码 M
  const listed = raw.match(/号型\s*(?:为|是|有|:)?\s*([^;]*?)\s*(?:[,;]?\s*基码|$)/);
  if (listed && listed[1]) {
    const names = listed[1].split(/[\s,/]+/).map(s => s.trim()).filter(Boolean), base = raw.match(/基码\s*(?:为|是|:)?\s*([^\s,;]+)/);
    if (names.length < 2) ask('请给出至少两个号型，从小到大，例如“号型 S M L XL，基码 M”。');
    if (names.length > 13) refuse('号型最多 13 个。');
    if (new Set(names).size !== names.length) refuse('号型名称有重复：' + names.join('、') + '。');
    if (!base) ask('哪个是基码？', names.slice(0, 8).map(name => ({ label: '基码 ' + name, send: raw + '，基码 ' + name })));
    if (!names.includes(base[1])) refuse('基码“' + base[1] + '”不在号型里：' + names.join('、') + '。');
    return plan((grading ? '把号型改成 ' + names.join('、') + '，基码 ' + base[1] + '。尺寸表和规则保留。' : '建立按尺寸表放码的方案（和 ET 一样，一张图一套），号型 ' + names.join('、') + '，基码 ' + base[1] + '。接着可以说“尺寸表加 胸围 88 档差 4”，再给点设规则，例如“右上角放码 水平 胸围/4 竖直 0.5”。'),
      { steps: [{ type: 'grade.setSizes', parameters: { sizes: names, base: base[1] } }] });
  }
  // 尺寸表加 胸围 88 档差 4 · 尺寸表 胸围 XL 100 · 尺寸表去掉 胸围
  const table = raw.match(/尺寸表\s*(?:里|中)?\s*(加上|加入|添加|增加|加|设|改|去掉|删除|删掉)?\s*(?:一项)?\s*([^\s\d,;:=]+)\s*(.*)$/);
  if (table) {
    if (!grading) none();
    const name = table[2], rest = table[3].replace(/^[\s,:=]+/, '');
    if (/去掉|删除|删掉/.test(table[1] || '')) return plan('从尺寸表里去掉“' + name + '”。', { steps: [{ type: 'grade.removeMeasure', parameters: { name } }] });
    const known = grading.measures.some(m => m.name === name), number = '(-?)\\s*' + NUM + '\\s*' + UNIT + '?';
    const ofSize = grading.sizes.map(size => ({ size, m: rest.match(new RegExp('^' + escapeRe(size) + '\\s*码?\\s*(?:为|是|改成|改为|=|:)?\\s*' + number)) })).find(item => item.m);
    if (ofSize) {
      if (!known) refuse('尺寸表里还没有“' + name + '”。先加上，例如“尺寸表加 ' + name + ' 88 档差 4”。');
      const value = (ofSize.m[1] ? -1 : 1) * inCm(ofSize.m[2], ofSize.m[3]);
      return plan('尺寸表“' + name + '”的 ' + ofSize.size + ' 码改成 ' + cm(value * 10) + ' cm。', { steps: [{ type: 'grade.setMeasure', parameters: { name, values: [{ size: ofSize.size, value }] } }] });
    }
    const step = rest.match(new RegExp('(?:档差|每码|每档|码差|每个码)\\s*(?:加|为|是|=|:)?\\s*' + number)), first = (step ? rest.slice(0, step.index) : rest).match(new RegExp('^(?:基码)?\\s*(?:为|是|=|:)?\\s*' + number));
    if (!first && !step) ask(known ? '“' + name + '”要改成多少？例如“尺寸表 ' + name + ' 88 档差 4”，或者只改一个码：“尺寸表 ' + name + ' ' + grading.sizes.at(-1) + ' 100”。' : '“' + name + '”基码是多少、每码差多少？例如“尺寸表加 ' + name + ' 88 档差 4”。');
    if (!first && !known) ask('“' + name + '”基码是多少？例如“尺寸表加 ' + name + ' 88 档差 4”。');
    const parameters = { name, ...(first ? { base: (first[1] ? -1 : 1) * inCm(first[2], first[3]) } : {}), ...(step ? { step: (step[1] ? -1 : 1) * inCm(step[2], step[3]) } : {}) };
    return plan((known ? '把尺寸表的“' + name + '”改成' : '尺寸表加一项“' + name + '”：') + (first ? '基码 ' + cm(parameters.base * 10) + ' cm' : '') + (step ? (first ? '，' : '') + '每大一个码' + (parameters.step < 0 ? '减 ' : '加 ') + cm(Math.abs(parameters.step) * 10) + ' cm' : (known ? '，各码一起平移' : '，各码相同')) + '。',
      { steps: [{ type: 'grade.setMeasure', parameters }], assumptions: !known && !step ? ['没有说档差，各码先填成一样；之后可以说“尺寸表 ' + name + ' 档差 4”。'] : [] });
  }
  // v68: ET's 对齐 / 对齐移动点 on corners of a piece: 后片各码按右上角对齐 · 后片右下角相对右上角每码横向放 0.5
  if (grading && /对齐/.test(tight) && /^(取消|去掉|清除|撤销)/.test(tight) && !CORNER_SPOTS.some(item => item[1].test(sentence))) return plan(grading.alignment ? '取消各码的对齐，叠码恢复原样。' : '各码现在没有对齐，不用取消。', grading.alignment ? { steps: [{ type: 'grade.align', parameters: { clear: true } }] } : {});
  // v69: ET's 锁定放码点, 解锁放码点, 锁定解锁当前层 and a point moved in one size
  if (grading && LOCK_GRADE.test(tight)) {
    const named = sizesNamed(raw, grading.sizes), corner = CORNER_SPOTS.find(item => item[1].test(sentence)), unlock = /解锁/.test(tight);
    if (named.includes(grading.baseSize)) refuse('基码 ' + grading.baseSize + ' 的点不能锁定或单独改（ET 也不锁基码上的点）；基码要改就直接改图。');
    const move = tight.match(/(往|向)(左|右|上|下)(?:移|挪|移动|放)?(-?\d+(?:\.\d+)?)(mm|毫米|cm|厘米|公分)?/);
    if (move && corner) {
      if (named.length !== 1) ask('在哪一个号型里移动？例如“XL 码的' + corner[2] + '往右移 10 毫米”。', grading.sizes.filter(name => name !== grading.baseSize).slice(0, 6).map(name => ({ label: name + ' 码', send: raw.replace(/^/, name + '码 ') })));
      const pieces = targetPieces(sentence, scene, context, '是哪个裁片的转角？'); if (pieces.length > 1) refuse('一次改一个裁片的点，请说出裁片名称。');
      const piece = pieces[0], at = cornerOf(piece, corner), amount = toMm(move[3], move[4] || (bareUnit === 'mm' ? 'mm' : 'cm')), dx = move[2] === '右' ? amount : move[2] === '左' ? -amount : 0, dy = move[2] === '上' ? amount : move[2] === '下' ? -amount : 0;
      return plan('在 ' + named[0] + ' 码里把“' + piece.name + '”' + corner[2] + '往' + move[2] + '移 ' + cm(amount) + ' cm（别的号型不变）；和 ET 一样，这个点和经过它的线的另一端在 ' + named[0] + ' 码里锁定，以后重新生成不会改回去。',
        { steps: [{ type: 'grade.moveInSize', parameters: { size: named[0], at: at.at, ...(dx ? { dx } : {}), ...(dy ? { dy } : {}) } }] });
    }
    if (!corner) {   // a whole size (ET's 锁定解锁当前层)
      if (!named.length) ask('锁定哪个号型？例如“锁定 XL 码”（整码保持），或者“锁定 XL 码的右下角”（只锁一个点）。');
      if (named.length > 1) refuse('整码锁定一次一个号型，请分开说。');
      const locked = (grading.lockedSizes || []).includes(named[0]);
      if (unlock && !locked) return plan(named[0] + ' 码没有整码锁定，不用解锁。');
      if (!unlock && locked) return plan(named[0] + ' 码已经整码锁定了。');
      return plan(unlock ? named[0] + ' 码解锁，重新按放码规则生成（单独锁定的点仍然锁定）。' : named[0] + ' 码整码锁定（ET 的“锁定解锁当前层”）：以后改规则、改基码，这个码都不变。',
        { steps: [{ type: 'grade.lockSize', parameters: { size: named[0], locked: !unlock } }] });
    }
    const pieces = targetPieces(sentence, scene, context, '是哪个裁片的转角？'); if (pieces.length > 1) refuse('一次锁一个裁片的点，请说出裁片名称。');
    const piece = pieces[0], at = cornerOf(piece, corner), where = named.length ? named.join('、') + ' 码' : (unlock ? '全部号型' : '除基码以外的全部号型');
    return plan('“' + piece.name + '”' + corner[2] + '在' + where + '里' + (unlock ? '解锁，下次生成时回到规则给的位置。' : '锁定在现在的位置（ET 的“锁定放码点”），以后改规则、改基码都不再动。'),
      { steps: [{ type: unlock ? 'grade.unlock' : 'grade.lock', parameters: { at: at.at, ...(named.length ? { sizes: named } : {}) } }] });
  }
  const relative = tight.match(/(左上|右上|左下|右下)角?相对(?:于)?(左上|右上|左下|右下)角?/);
  if (grading && relative) {
    const pieces = targetPieces(sentence, scene, context, '是哪个裁片的转角？'); if (pieces.length > 1) refuse('对齐移动点一次设一个裁片，请说出裁片名称。');
    const piece = pieces[0], key = word => CORNER_SPOTS.find(item => item[1].test(word)), target = key(relative[1]), base = key(relative[2]);
    if (target[0] === base[0]) refuse('目标点和对齐点是同一个角。');
    const number = words => { const m = raw.match(new RegExp('(?:' + words + ')(?:方向)?\\s*(?:放|移|加|为|是|=|:)?\\s*(-?)\\s*' + NUM + '\\s*' + UNIT + '?')); return m ? (m[1] ? -1 : 1) * inCm(m[2], m[3]) : undefined; };
    const x = number('横向|水平|左右'), y = number('纵向|竖直|垂直|上下');
    if (x === undefined && y === undefined) ask('“' + piece.name + '”' + target[2] + '相对' + base[2] + '每码横向、纵向各放多少？例如“' + piece.name + target[2] + '相对' + base[2] + '每码横向放 0.5 纵向 0”（厘米，向右、向上为正）。');
    const keep = /保留|写进规则/.test(tight), a = cornerOf(piece, base), t = cornerOf(piece, target);
    return plan('按“' + piece.name + '”' + base[2] + '把各码对齐，' + target[2] + '在对齐后每大一个码' + [x !== undefined ? '横向移动 ' + cm(x * 10) + ' cm' : '', y !== undefined ? '纵向移动 ' + cm(y * 10) + ' cm' : ''].filter(Boolean).join('、') + '（ET 的“点对齐移动点规则”）' + (keep ? '；先把对齐写进外轮廓角点的规则（保留）。' : '。'),
      { steps: [{ type: 'grade.alignedMove', parameters: { entityId: a.entityId, at: a.at, mode: 'point', target: t.at, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}), ...(keep ? { keep: true } : {}) } }] });
  }
  if (grading && /对齐/.test(tight) && /(各码|放码|推板|叠码|网状|按)/.test(tight)) {
    const corner = CORNER_SPOTS.find(item => item[1].test(sentence));
    if (corner) {
      const pieces = targetPieces(sentence, scene, context, '是哪个裁片的转角？'); if (pieces.length > 1) refuse('对齐一次对一个裁片，请说出裁片名称。');
      const piece = pieces[0], at = cornerOf(piece, corner), axis = /只对齐?(高低|上下|高度)|高低对齐|上下对齐/.test(tight) ? 'y' : /只对齐?(左右|横向)|左右对齐/.test(tight) ? 'x' : 'both', keep = /保留|写进规则/.test(tight);
      return plan('“' + piece.name + '”的各码按' + corner[2] + '对齐' + (axis === 'y' ? '，只对齐高低' : axis === 'x' ? '，只对齐左右' : '') + (keep ? '，并把对齐写进外轮廓角点的规则（ET 的“保留”）：' + corner[2] + (axis === 'y' ? '的高低不再动，左右照旧。' : axis === 'x' ? '的左右不再动，高低照旧。' : '成为不动点。') + '这些角点的规则成了数，不再跟着尺寸表变。' : '（只改看的样子，ET 的“对齐”）。预览叠码时就这样画；说“取消放码对齐”恢复。'),
        { steps: [{ type: 'grade.align', parameters: { entityId: at.entityId, at: at.at, mode: 'point', ...(axis !== 'both' ? { axis } : {}), ...(keep ? { keep: true } : {}) } }] });
    }
  }
  // 后袋右上角放码 水平 袋宽 竖直 袋深 · 左下角固定 · 去掉右上角的放码规则
  const spot = CORNER_SPOTS.find(item => item[1].test(sentence));
  if (spot) {
    if (!grading) none();
    const pieces = targetPieces(sentence, scene, context, '是哪个裁片的转角？'); if (pieces.length > 1) refuse('放码规则一次设一个裁片的一个角，请说出裁片名称。');
    const piece = pieces[0], name = '“' + piece.name + '”' + spot[2];
    const edges = piece.contour.flatMap(e => e.points ? e.points.map((p, i) => ({ entityId: e.entityId, from: p, to: e.points[(i + 1) % e.points.length] })) : e.kind === 'closed-polyline' ? [] : [{ entityId: e.entityId, from: e.from, to: e.to }]);
    if (!edges.length) refuse('“' + piece.name + '”的轮廓太复杂，请在放码面板里点线来设规则。');
    const vertex = edges.flatMap(e => [e.from, e.to]).reduce((best, p) => { const value = q => ({ 'left-top': -q.x + q.y, 'right-top': q.x + q.y, 'left-bottom': -q.x - q.y, 'right-bottom': q.x - q.y })[spot[0]]; return value(p) > value(best) ? p : best; });
    const edge = edges.find(e => Math.hypot(e.from.x - vertex.x, e.from.y - vertex.y) < .01 || Math.hypot(e.to.x - vertex.x, e.to.y - vertex.y) < .01), where = { entityId: edge.entityId, at: { x: vertex.x, y: vertex.y } };
    if (/(去掉|删除|删掉|取消|清除).*(放码|规则)/.test(sentence)) return plan('去掉' + name + '的放码规则。', { steps: [{ type: 'grade.removeRule', parameters: where }] });
    const part = words => raw.match(new RegExp('(?:' + words + ')(?:方向)?\\s*(?:按|为|是|=|:)?\\s*([^\\s,;]+)')), fx = part('水平|横向'), fy = part('竖直|垂直|纵向'), still = text => /^(不动|不变|固定|无)$/.test(text) ? '' : text;
    if (/固定/.test(sentence) && !fx && !fy) return plan('把' + name + '设成固定点：各码都不动。', { steps: [{ type: 'grade.setRule', parameters: { ...where, x: '', y: '' } }] });
    if (!fx && !fy) ask(name + '水平、竖直各按什么放？例如“' + piece.name + spot[2] + '放码 水平 胸围/4 竖直 0.5”。公式里用尺寸表的项目名称，只写一个数是每码的步长（厘米）。');
    const x = fx ? still(fx[1]) : undefined, y = fy ? still(fy[1]) : undefined;
    return plan('给' + name + '设放码规则：' + [x !== undefined ? '水平 ' + (x || '不动') : '', y !== undefined ? '竖直 ' + (y || '不动') : ''].filter(Boolean).join('，') + '。公式里的名称是尺寸表的项目，每个码按它与基码的差来算；只写一个数是每码的步长，单位厘米。',
      { steps: [{ type: 'grade.setRule', parameters: { ...where, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) } }] });
  }
  return plan('放码可以这样说：先设号型，“放码：号型 S M L XL，基码 M”；再填尺寸表，“尺寸表加 胸围 88 档差 4”；然后给裁片的转角设规则，“后袋右上角放码 水平 胸围/4 竖直 0.5”“后袋左下角固定”。其他位置的点在左侧“放码”面板里点线来设。各码的预览和导出也在放码面板里。', { choices: GRADE_EXAMPLES, unrecognised: true });
}

function planSentence(sentence, scene, context, original) {
  if (NEW_OTHER.test(sentence) && !NEW_PANTS.test(sentence) && namedPieces(sentence, scene, context).how !== 'named') refuse('目前只有成人基础直筒裤可以按尺寸自动生成。裙装、上衣等款式需要先补充制版规则，或接入大模型服务后由它逐步画线；这两项都在路线图里。现在可以先用“画一个 宽×高 的矩形”这类指令画部件。');
  if (/^(帮助|help|\?|你能做什么|你会什么|怎么用|能做什么|有什么功能|使用说明)\??$/.test(sentence)) return plan(HELP, { choices: EXAMPLES });
  if (/^(现在|当前|目前)?的?(尺寸|参数|状态|情况|画布)(是多少|是什么|怎么样|有什么|有哪些)?\??$/.test(sentence) || /^(画布上)?有(什么|哪些)(裁片|东西|图形)?\??$/.test(sentence)) return plan(describe(scene));
  for (const [pattern, id, reply] of ACTIONS) if (pattern.test(sentence.replace(/\s/g, ''))) return plan(reply, { actions: [{ id }] });
  const { changes, rest } = extractChanges(sentence);
  return planSeamTools(sentence, scene, context) || planGrading(sentence, scene, context, original) || planMembers(sentence, scene, context) || planSpread(sentence, scene, context) || planExtract(sentence, scene, context, changes) ||planMarks(sentence, scene, context) || planManage(sentence, scene, context) || planNotch(sentence, scene, context) || planCorner(sentence, scene, context) || planText(sentence, scene, context, original) || planRectangle(sentence, scene, context, changes) || planPieceFromLines(sentence, scene, context, changes) || planSeam(sentence, scene, context, changes)
    || (changes.length || NEW_PANTS.test(sentence) ? planDraft(sentence, scene, context, changes, rest) : null)
    || planConstruct(sentence, scene, context, changes) || planLine(sentence, scene) || planPieceOperation(sentence, scene, context) || unfinished(sentence, scene)
    || plan('这句话我还不能执行。目前用的是本机内置指令，只认识固定的说法；说“帮助”可以看到全部例子。接入大模型服务后可以理解更自由的描述。', { choices: EXAMPLES.slice(0, 3), unrecognised: true });
}
/** Plan one user instruction against the current canvas. Never throws for bad input; the reply explains. */
export function planLocally(request) {
  const chosen = request?.context?.preferences?.lengthUnit; bareUnit = BARE[chosen] ? chosen : null; sentenceInHand = String(request?.text ?? '').trim();
  const result = planInUnit(request);
  return { ...result, reply: inChosenUnit(result.reply), assumptions: result.assumptions.map(inChosenUnit), questions: result.questions.map(inChosenUnit), choices: result.choices.map(choice => ({ ...choice, label: inChosenUnit(choice.label) })) };
}
const UNIT_ANSWER = /^(?:按|用|都按|都用|单位|单位用|单位是|是)?(厘米|公分|cm|英寸|吋|inch|毫米|mm)$/, UNIT_ONCE = /^按(厘米|公分|cm|英寸|吋|inch|毫米|mm)[:：,，]\s*(.+)$/;
const unitNamed = word => (/厘米|公分|cm/.test(word) ? 'cm' : /毫米|mm/.test(word) ? 'mm' : 'inch');
function planInUnit({ text, scene, context = {} }) {
  let original = String(text ?? '').trim(), source = normalize(original);
  // “按英寸：……” reads one sentence in another unit without changing the stored choice
  const once = source.match(UNIT_ONCE); if (once) { bareUnit = unitNamed(once[1]); source = once[2]; original = original.replace(/^[^:：,，]*[:：,，]\s*/, ''); sentenceInHand = original; }
  const answer = source.match(UNIT_ANSWER);
  if (answer) {
    const unit = unitNamed(answer[1]), pending = context.pending?.text; bareUnit = unit;
    if (!pending) return plan('好的，之后没写单位的数字都按' + UNIT_WORD[unit] + '理解。', { remember: { lengthUnit: unit } });
    sentenceInHand = pending;
    const result = planInUnit({ text: pending, scene, context: { ...context, pending: null, preferences: { ...context.preferences, lengthUnit: unit } } });
    return { ...result, remember: { ...(result.remember || {}), lengthUnit: unit }, assumptions: ['没写单位的数字按' + UNIT_WORD[unit] + '理解；说“按' + (unit === 'inch' ? '厘米' : '英寸') + '”可以更换。', ...result.assumptions] };
  }
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
