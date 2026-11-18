/**
 * v72: measurements in every size, as ET 2017's table 要素检查 shows them after 长度测量 or 综合测量: the sizes of the drawing's
 * grading from small to large with the base among them, the total length of the measured lines in each size, and the 层间差.
 * ET's 层间差 (its default) is each size against its neighbour toward the base (S − M, L − M, XL − L; the base 0); with
 * 基础号型层间差 ticked it is each size against the base. Nothing here changes the drawing.
 */
import { generateGradedSize } from './grading.mjs';
import { length } from './geometry.mjs';

/** The plan whose sizes are measured: the one that grades by a size table (ET's), else the first plan that has sizes. */
export function gradingPlanForMeasuring(project) {
  const plans = (project.gradingPlans || []).filter(plan => Array.isArray(plan.sizes) && plan.sizes.length);
  return plans.find(plan => plan.method === 'table') || plans[0] || null;
}

/** The sizes of a plan from small to large, the base among them: by position in the size table, else by step. */
export function sizesInOrder(plan) {
  const base = String(plan.baseSize || 'M'), bySlot = plan.method === 'table' && plan.sizes.every(size => Number.isInteger(size.slot));
  const baseKey = bySlot ? (Number.isInteger(plan.sizeTable?.baseSlot) ? plan.sizeTable.baseSlot : 9) : 0;
  const rows = plan.sizes.map(size => ({ id: size.id, label: size.label, base: false, key: bySlot ? size.slot : Number(size.step) || 0 }));
  rows.push({ id: null, label: base, base: true, key: baseKey });
  return rows.sort((a, b) => a.key - b.key || (a.base ? -1 : b.base ? 1 : 0)).map(({ key, ...row }) => row);
}

/** 层间差 of one column: against the neighbour toward the base, or against the base when fromBase. Missing values stay null. */
export function stepDifferences(values, baseIndex, fromBase = false) {
  return values.map((value, i) => {
    if (i === baseIndex) return value === null ? null : 0;
    const other = fromBase ? values[baseIndex] : values[i < baseIndex ? i + 1 : i - 1];
    return value === null || other === null || other === undefined ? null : value - other;
  });
}

/**
 * The total length of each group of lines in every size. groups: arrays of entity ids. Returns null when the drawing has no
 * grading with sizes; else { planId, baseSize, sizes: [{ label, base, totalsMm: [one per group], missing: [names], error? }] }.
 * A line that a size does not have (a plan that grades only some lines) leaves that total null and is named in `missing`.
 */
export function lengthsInSizes(project, groups, plan = gradingPlanForMeasuring(project)) {
  if (!plan) return null;
  const order = sizesInOrder(plan), name = id => project.entities.find(e => e.id === id)?.name || id;
  const totals = (entities, row) => groups.map(ids => {
    let sum = 0;
    for (const id of ids) { const entity = entities.find(e => e.id === id); if (!entity) { row.missing.push(name(id)); return null; } sum += length(entity); }
    return sum;
  });
  return {
    planId: plan.id, baseSize: String(plan.baseSize || 'M'),
    sizes: order.map(size => {
      const row = { label: size.label, base: size.base, totalsMm: [], missing: [] };
      try { row.totalsMm = totals(size.base ? project.entities : generateGradedSize(project, plan, size.id).project.entities, row); }
      catch (error) { row.totalsMm = groups.map(() => null); row.error = error.message; }
      row.missing = [...new Set(row.missing)];
      return row;
    }),
  };
}

/**
 * The table of 综合测量 in every size: a column for each group's total, the difference of the two groups when there are two, and
 * after each of these its 层间差 when steps is on (ET's 层间差模式). Values in millimetres; null where a size could not be measured.
 */
export function sizeTable(measured, { steps = true, fromBase = false } = {}) {
  const sizes = measured.sizes, baseIndex = sizes.findIndex(size => size.base), groups = sizes[0]?.totalsMm.length || 0;
  const columns = [], add = (title, values) => { columns.push({ title, values }); if (steps) columns.push({ title: '层间差', values: stepDifferences(values, baseIndex, fromBase), step: true }); };
  const totals = index => sizes.map(size => size.totalsMm[index] ?? null);
  if (groups === 1) add('总长', totals(0));
  else {
    add('第一组', totals(0)); add('第二组', totals(1));
    add('相差', sizes.map(size => size.totalsMm[0] === null || size.totalsMm[1] === null ? null : size.totalsMm[0] - size.totalsMm[1]));
  }
  return { sizes: sizes.map(size => ({ label: size.label, base: size.base })), columns, fromBase: steps && fromBase };
}
