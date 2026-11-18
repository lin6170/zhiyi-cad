/**
 * ET's five size series (五组号型系列, v71), as ET 2017's 号型名称设定 dialog keeps them.
 *
 * The dialog shows five columns, A 系列 to E 系列, and one row per position of the size table (fifty positions, position 9 is the
 * base size in every series). One series is in use: its names are the sizes of the drawing (ET's size bar, the layers it expands).
 * A click on another column's header makes that series the one in use; the size table is kept by position, so the switch only
 * says which positions are sizes and what they are called (B: 36 38 40 42 at positions 8 to 11; D: 2 3 4 5 at positions 7 to 10,
 * which grades positions 7, 8 and 10). A series without a name at the base position is refused, as ET refuses it
 * ("基础号型为空，请仔细检查!"). In a file the series in use is the u32 before the names (see prj-sizes.mjs).
 *
 * The functions take and return a plan value that can be stored again (a copy of a normalized plan that grades by a size table).
 */
export const SERIES_LETTERS = ['A', 'B', 'C', 'D', 'E'];
const MAX_SIZES = 12, SLOTS = 50;

/** The index of a series given as a letter (A to E, also a to e) or a number 0 to 4. Throws otherwise. */
export function seriesIndex(series) {
  const k = typeof series === 'number' ? series : SERIES_LETTERS.indexOf(String(series ?? '').trim().toUpperCase());
  if (!Number.isInteger(k) || k < 0 || k > 4) throw new Error('号型系列是 A、B、C、D、E 之一');
  return k;
}
/** The names of one series by position, smallest position first: [{ slot, name }]. */
export const seriesNames = (table, k) => (table.series[k] || []).filter(item => item.name).slice().sort((a, b) => a.slot - b.slot);

/**
 * Makes series k the one in use. The sizes of the plan become the names of that series: the base position must have a name,
 * every other named position is a size (at most twelve); a size keeps its id when its position was a size before (so its locks
 * stay). Locks and whole-size locks of positions that are no longer sizes go, and are counted.
 * Returns { value, droppedLocks, droppedSizeLocks }.
 */
export function useSeries(value, series, makeId) {
  const k = seriesIndex(series), table = value.sizeTable, names = seriesNames(table, k), letter = SERIES_LETTERS[k];
  const base = names.find(item => item.slot === table.baseSlot);
  if (!base) throw new Error('基础号型为空，请仔细检查!（' + letter + ' 系列在基码的位置上没有名称，ET 也不换）');
  const others = names.filter(item => item.slot !== table.baseSlot);
  if (!others.length) throw new Error(letter + ' 系列只有基码“' + base.name + '”，至少还要有一个号型才能放码');
  if (others.length > MAX_SIZES) throw new Error(letter + ' 系列有 ' + others.length + ' 个号型，放码最多 12 个（另加基码）');
  const labels = names.map(item => item.name.trim()); if (new Set(labels).size !== labels.length) throw new Error('发现有重复的号型名称，请仔细检查!（' + letter + ' 系列）');
  const before = new Map(value.sizes.map(size => [size.slot, size]));
  value.baseSize = base.name.trim();
  value.sizes = others.map(item => ({ id: before.get(item.slot)?.id || makeId(), label: item.name.trim(), step: item.slot - table.baseSlot, slot: item.slot }));
  table.activeSeries = k;
  const ids = new Set(value.sizes.map(size => size.id)), locks = value.locks || [], sizeLocks = value.lockedSizes || [];
  const keptLocks = locks.filter(lock => ids.has(lock.sizeId)), keptSizes = sizeLocks.filter(id => ids.has(id));
  if (keptLocks.length) value.locks = keptLocks; else delete value.locks;
  if (keptSizes.length) value.lockedSizes = keptSizes; else delete value.lockedSizes;
  return { value, droppedLocks: locks.length - keptLocks.length, droppedSizeLocks: sizeLocks.length - keptSizes.length };
}

/**
 * Gives series k its names: `names` from the smallest size to the largest, `base` among them stands at the base position and the
 * others on either side (as grade.setSizes lays out the series in use). An empty list clears a series that is not in use. For the
 * series in use the sizes of the plan follow (as useSeries). Returns the result of useSeries for the series in use, else { value }.
 */
export function nameSeries(value, series, names, base, makeId) {
  const k = seriesIndex(series), table = value.sizeTable, letter = SERIES_LETTERS[k];
  if (!Array.isArray(names)) throw new Error('请给出号型名称');
  const list = names.map(name => String(name ?? '').trim());
  if (!list.length) { if (k === table.activeSeries) throw new Error(letter + ' 系列正在用，不能清空；先换用别的系列'); table.series[k] = []; return { value }; }
  if (list.some(name => !name || name.length > 50)) throw new Error('号型名称不能是空的，最长 50 个字');
  if (new Set(list).size !== list.length) throw new Error('发现有重复的号型名称，请仔细检查!');
  const at = list.indexOf(String(base ?? '').trim()); if (at < 0) throw new Error('基码“' + (base ?? '') + '”不在 ' + letter + ' 系列的名单里');
  const first = table.baseSlot - at; if (first < 0 || first + list.length > SLOTS) throw new Error('号型太多，排不进号型表');
  table.series[k] = list.map((name, i) => ({ slot: first + i, name }));
  return k === table.activeSeries ? useSeries(value, k, makeId) : { value };
}

/** The five series for a summary: { A: ['S', 'M*', ...], ... } from the smallest named position to the largest, the base marked
 * by a star and an empty position inside the range as '', and the letter of the one in use. */
export function describeSeries(table) {
  const out = {};
  table.series.forEach((list, k) => {
    const names = seriesNames(table, k); if (!names.length) return;
    const bySlot = new Map(names.map(item => [item.slot, item.name])), row = [];
    for (let slot = names[0].slot; slot <= names.at(-1).slot; slot++) row.push(bySlot.has(slot) ? bySlot.get(slot) + (slot === table.baseSlot ? '*' : '') : '');
    out[SERIES_LETTERS[k]] = row;
  });
  return { inUse: SERIES_LETTERS[table.activeSeries], series: out };
}
