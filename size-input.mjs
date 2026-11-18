/**
 * Sizes typed into a tool with the names of the size table (v71), the way ET 2017 takes them.
 *
 * ET takes a formula in any number box of a tool (平行线 "袖长/10", 刀口 "袋位+1"). It works the formula out once, when the tool
 * runs: every name stands for the row's 纸样尺寸 (the last of the fifty positions of the row, 49) in centimetres, and every plain
 * number for the box's unit (inches on an ET set to inches: "袋位+1" with 袋位 10 cm gave 100 mm + 1 inch = 125.4 mm). What the
 * tool draws keeps only its geometry: a later change of the size table does not move it, in ET as here. With 纸样尺寸 0, which is
 * what ET's own files hold, a name counts 0 (ET then draws nothing).
 */
import { parseFormula, formulaNames, evaluateFormula } from './size-formula.mjs';

export const PATTERN_SLOT = 49;                       // ET's 纸样尺寸 column of the size table
export const UNIT_MM = { mm: 1, cm: 10, inch: 25.4 };

/** The size table of a drawing: the one of its plan that grades by a size table, or null. */
export const drawingSizeTable = project => (project?.gradingPlans || []).find(plan => plan.method === 'table')?.sizeTable || null;

/** Whether a text is meant as a formula with names (it has a character that is not part of a number or of ET's fractions). */
export const hasNames = text => /[^0-9.\s'+\-*/()（）]/.test(String(text ?? ''));

/**
 * The size a formula gives, in millimetres. `unit` is the unit of the box (mm, cm, inch) and the unit of every plain number of the
 * formula; `table` is the drawing's size table (or null). Returns { mm, names, zero } (zero: the names whose 纸样尺寸 is 0).
 * Throws with a message for the box when the formula cannot be read or names something the table lacks.
 */
export function sizeFromFormula(text, unit, table) {
  const scale = UNIT_MM[unit]; if (!scale) throw new Error('单位不对');
  let tree; try { tree = parseFormula(text); } catch (error) { throw new Error('“' + String(text).trim() + '”读不懂：' + error.message); }
  const names = [...formulaNames(tree)], rows = new Map((table?.rows || []).map(row => [row.name, row]));
  if (names.length && !table) throw new Error('这张图还没有尺寸表：先在放码面板里建立尺寸表放码，再用“' + names[0] + '”这样的名称');
  const missing = names.filter(name => !rows.has(name));
  if (missing.length) throw new Error('尺寸表里没有“' + missing[0] + '”。尺寸表现有：' + ([...rows.keys()].join('、') || '还没有项目'));
  const zero = names.filter(name => !rows.get(name).values[PATTERN_SLOT]);
  // a name is centimetres; in the box's unit it is cm / (mm per unit / 10)
  const value = evaluateFormula(tree, name => rows.get(name).values[PATTERN_SLOT] * 10 / scale);
  if (!Number.isFinite(value)) throw new Error('“' + String(text).trim() + '”算不出一个数');
  return { mm: value * scale, names, zero };
}

/** A short note for the status of a box that holds a formula: what it came to, and the names whose 纸样尺寸 is still 0. */
export function describeFormula(result, show) {
  return '= ' + show(result.mm) + (result.zero.length ? '（尺寸表里' + result.zero.map(name => '“' + name + '”').join('、') + '的纸样尺寸是 0，和 ET 一样按 0 算）' : '');
}
