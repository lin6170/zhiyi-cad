/**
 * The rule table (规则表, v71): ET 2017's 放码规则表, a library of named grading rules in groups.
 *
 * ET keeps it on the computer, not in the pattern file (its system folder, file MyRuleRecord.rtb). In ET's point rule dialog
 * (放码规则) the button 导入或导出规则 opens it, and a click on a rule copies its two formulas into the point: the point keeps only
 * the copied formulas, so a later change of the library changes no drawing. The page keeps its library in the browser, the way
 * ET keeps it on the computer, and reads and writes ET's file so that a patternmaker's library can come over from ET and go back.
 *
 * ET's file, as ET's own sample shows it (every string a u16 length and GBK text):
 *   "ET_RULE_RECORD", u32 number of groups, then for each group its name and exactly 100 rules of three strings each
 *   (rule name, X formula, Y formula); a row of the grid that is not used is three empty strings.
 */
import { encodeGbk } from './prj-new-export.mjs';
import { parseFormula, formulaNames } from './size-formula.mjs';

export const RULE_TABLE_MAGIC = 'ET_RULE_RECORD', RULES_PER_GROUP = 100, MAX_GROUPS = 200;
export const RULE_LIBRARY_STORE = 'zhiyi-rule-table/v1';

const text = (value, max, what) => { const s = String(value ?? '').trim(); if (s.length > max) throw new Error(what + '最长 ' + max + ' 个字'); return s; };
/** A library as it can be kept: { groups: [{ name, rules: [{ name, x, y }] }] }. Throws when a part is not of that shape. */
export function normalizeLibrary(value) {
  const groups = Array.isArray(value?.groups) ? value.groups : [];
  if (groups.length > MAX_GROUPS) throw new Error('规则组最多 ' + MAX_GROUPS + ' 个');
  return { groups: groups.map(group => {
    const rules = Array.isArray(group?.rules) ? group.rules : [];
    if (rules.length > RULES_PER_GROUP) throw new Error('一个规则组最多 ' + RULES_PER_GROUP + ' 条规则（ET 的规则表每组 100 行）');
    return { name: text(group?.name, 60, '规则组名称'), rules: rules.map(rule => ({ name: text(rule?.name, 60, '规则名称'), x: text(rule?.x, 300, '公式'), y: text(rule?.y, 300, '公式') })) };
  }) };
}

/** ET's rule table file read into a library. Rows of the grid that are empty (three empty strings) are left out. */
export function readRuleTable(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder('gb18030', { fatal: true });
  let o = 0;
  const str = () => { if (o + 2 > bytes.length) throw new Error('文件不完整'); const n = view.getUint16(o, true); o += 2; if (o + n > bytes.length || n > 4096) throw new Error('文件不完整'); const s = decoder.decode(bytes.subarray(o, o + n)); o += n; return s; };
  let magic; try { magic = str(); } catch { magic = ''; }
  if (magic !== RULE_TABLE_MAGIC) throw new Error('这不是 ET 的规则表文件（文件开头不是 ' + RULE_TABLE_MAGIC + '）');
  if (o + 4 > bytes.length) throw new Error('文件不完整'); const count = view.getUint32(o, true); o += 4;
  if (count > MAX_GROUPS) throw new Error('规则组数不对（' + count + '）');
  const groups = [];
  for (let g = 0; g < count; g++) {
    const name = str(), rules = [];
    for (let r = 0; r < RULES_PER_GROUP; r++) { const rule = { name: str(), x: str(), y: str() }; if (rule.name || rule.x || rule.y) rules.push(rule); }
    groups.push({ name, rules });
  }
  if (o !== bytes.length) throw new Error('文件后面还有 ' + (bytes.length - o) + ' 个字节读不懂');
  return normalizeLibrary({ groups });
}

/** A library written as ET's rule table file (each group padded to 100 rows, as ET writes it). */
export function writeRuleTable(library) {
  const { groups } = normalizeLibrary(library), parts = [], push = s => { const b = encodeGbk(s); parts.push(Uint8Array.of(b.length & 255, b.length >> 8), b); };
  push(RULE_TABLE_MAGIC); const n = new Uint8Array(4); new DataView(n.buffer).setUint32(0, groups.length, true); parts.push(n);
  for (const group of groups) {
    push(group.name);
    for (let r = 0; r < RULES_PER_GROUP; r++) { const rule = group.rules[r] || { name: '', x: '', y: '' }; push(rule.name); push(rule.x); push(rule.y); }
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let o = 0; for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}

/** The names of the size table a rule uses that the table lacks (a rule from another style may use names this one has not). */
export function missingNames(rule, rows) {
  const known = new Set((rows || []).map(row => row.name)), missing = new Set();
  for (const formula of [rule.x, rule.y]) { let tree; try { tree = parseFormula(formula); } catch (error) { throw new Error('规则“' + rule.name + '”的公式“' + formula + '”读不懂：' + error.message); } for (const name of formulaNames(tree)) if (!known.has(name)) missing.add(name); }
  return [...missing];
}

/** The library kept in this browser (an empty one when there is none or the storage cannot be read). */
export function loadLibrary(storage = globalThis.localStorage) {
  try { const raw = storage?.getItem(RULE_LIBRARY_STORE); return raw ? normalizeLibrary(JSON.parse(raw)) : { groups: [] }; } catch { return { groups: [] }; }
}
/** Keeps the library in this browser. Returns false when the storage refuses (a private window). */
export function saveLibrary(library, storage = globalThis.localStorage) {
  try { storage.setItem(RULE_LIBRARY_STORE, JSON.stringify(normalizeLibrary(library))); return true; } catch { return false; }
}
