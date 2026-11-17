/**
 * Commands that cut a figure of loose lines into strips and spread the strips (v60): ET's 固定等分割, 指定分割 and
 * 多边分割展开. The geometry is in cut-spread.mjs; here the lines of the figure are replaced by the lines of the result.
 */
import { LIMIT, number, point, idList, object, requireMm, entityOf, addEntity, existingIds, round } from './cad-command-kit.mjs';
import { spreadBetweenSides, spreadFromBase, canSpread } from './cut-spread.mjs';
import { refreshCurve } from './curves.mjs';

const copy = p => ({ x: p.x, y: p.y });
const FIGURE = 'entityIds 是这个图形参与切展的全部的线：两侧的线、两头的线、里面的线都要列进来，没列进来的线留在原处不动。只能用还没有做成裁片的线（结构线）；切展以后原来的线被换成切开的各段，再用“提取裁片”做成裁片。';
const fitOf = { type: 'string', enum: ['none', 'each', 'merged'], description: 'none（默认）：两侧保留切开的各段，每条分割线变成两条线，各在一边；each：两侧原来的每条线各拟合成一条曲线（ET 的“曲线分段拟合”）；merged：每一侧合并拟合成一条曲线（ET 的“曲线合并拟合”）。拟合以后不保留分割线。一侧只有一条线时 each 和 merged 的结果相同。' };
const amountOf = what => number(-1000, 1000, what);
const NEXT = '这一步没有可以用 @ 引用的新对象。要在同一份计划里接着用“提取裁片”把展开后的图形做成裁片：让两侧拟合成曲线（fit 为 each 或 merged），图形才是封闭的；at 取不动的那一条里面的一点。';

/** The lines of the figure: loose lines only. */
function figure(project, ids) {
  const taken = new Map((project.groups || []).flatMap(g => g.entityIds.map(id => [id, g])));
  return [...existingIds(project, ids)].map(id => {
    const e = entityOf(project, id), owner = taken.get(id);
    if (owner) throw new Error('“' + e.name + '”已属于裁片“' + owner.name + '”。切展只对还没有做成裁片的线做：先在结构线上切展，再提取裁片。');
    if (!canSpread(e)) throw new Error('“' + e.name + '”不能参与切展（文字、缝份线、刀口、标记和布纹线不行）。');
    if ((project.notches || []).some(notch => notch.baseEntityId === id)) throw new Error('“' + e.name + '”上有刀口，请先删除刀口。');
    return e;
  });
}
const inside = (ids, all, what) => { for (const id of ids || []) if (!all.includes(id)) throw new Error(what + '须同时列在 entityIds 里。'); return ids || []; };
function nameOf(line) {
  if (line.role === 'cut') return (line.source ? line.source.name : '分割线' + line.cut) + (line.face === 'before' ? '·前' : '·后');
  if (line.fitted) return line.source ? line.source.name : (line.role === 'fixed' ? '固定侧' : '展开侧');
  return line.whole ? line.source.name : line.source.name + '·' + (line.role === 'other' ? line.part : line.strip + 1);
}
/** Take the lines of the figure away and put the lines of the result in their place. */
function replaceLines(project, env, result) {
  const gone = new Set(result.replaced.map(e => e.id)); project.entities = project.entities.filter(e => !gone.has(e.id));
  return result.lines.map(line => {
    const base = { name: nameOf(line), type: 'polyline', layer: line.source && line.source.layer === 'internal' ? 'internal' : 'outline', ...(line.source && line.source.aux ? { aux: true } : {}) };
    if (line.geometry.curve) return refreshCurve(addEntity(project, env, { ...base, points: [], curve: line.geometry.curve }));
    return addEntity(project, env, { ...base, points: line.geometry.points.map(copy), closed: Boolean(line.whole && line.source && line.source.closed) });
  });
}
const listed = created => created.slice(0, 80).map(e => ({ id: e.id, name: e.name }));

export const spreadCommands = [
  { type: 'spread.equal', title: '等分割展开', description: '把一个由线围成的图形从固定侧到展开侧等分成几条，再逐条展开（ET 的“固定等分割”）。固定侧是连着不断开的一侧，展开侧是张开的一侧：把裙片的下摆加大，腰线是固定侧，下摆线是展开侧。两侧各是一条线或首尾相接的几条线，各按长度等分，对应的等分点连成分割线。起点端的第一条不动；每一刀把后面的各条整体转开：展开侧张开 spreadAmount，固定侧张开 fixedAmount（默认 0，固定侧连着不断开）。量取的是原来重合的两点之间的直线距离；负数表示收拢（两条重叠）。图形里别的线在分割线处被切断，各段随所在的条一起动。' + FIGURE + 'from 是靠近固定侧起点端的一点：这一端的第一条不动，后面的各条依次转开。不给 from 时，固定侧只有一条线就从它的起点数起，有几条线就从 fixedIds 里列在最前面的那条端头线的外端数起。固定侧不张开而又拟合成曲线时，曲线的长度保持与原来固定侧相同。' + NEXT,
    input_schema: object({ entityIds: idList('这个图形参与切展的全部的线', 2), fixedIds: idList('固定侧的线'), spreadIds: idList('展开侧的线'), parts: { type: 'integer', minimum: 2, maximum: 200, description: '等分成几条；4 条是切 3 刀' },
      spreadAmount: amountOf('每一刀在展开侧张开多少，毫米'), fixedAmount: amountOf('每一刀在固定侧张开多少，毫米，默认 0'), from: point('靠近固定侧起点端的一点：这一端的第一条不动'), fit: fitOf }, ['entityIds', 'fixedIds', 'spreadIds', 'parts', 'spreadAmount']),
    run(project, p, env) {
      requireMm(project);
      const lines = figure(project, p.entityIds), result = spreadBetweenSides(lines, { fixedIds: inside(p.fixedIds, p.entityIds, '固定侧的线'), spreadIds: inside(p.spreadIds, p.entityIds, '展开侧的线'), parts: p.parts, spreadAmount: p.spreadAmount, fixedAmount: p.fixedAmount || 0, from: p.from || null, fit: p.fit || 'none' });
      return { summary: twoSides('spread.equal', p, result, replaceLines(project, env, result)) };
    } },
  { type: 'spread.atLines', title: '指定分割展开', description: '沿着已经画好的分割线把图形切开，再逐条展开（ET 的“指定分割”）。每条分割线须从固定侧通到展开侧（两头超出去的部分被去掉）。按分割线在固定侧上的先后，起点端的第一条不动；每一刀把后面的各条整体移开：固定侧垂直于分割线张开 fixedAmount（默认 0），再绕固定侧的点转到展开侧张开 spreadAmount。个别分割线的量不同时写在 cuts 里。' + FIGURE + '分割线也要列在 entityIds 里。from、fit 与“等分割展开”相同。' + NEXT,
    input_schema: object({ entityIds: idList('这个图形参与切展的全部的线，分割线也在内', 3), fixedIds: idList('固定侧的线'), spreadIds: idList('展开侧的线'), cutIds: idList('分割线'),
      spreadAmount: amountOf('每条分割线在展开侧张开多少，毫米'), fixedAmount: amountOf('每条分割线在固定侧张开多少，毫米，默认 0'),
      cuts: { type: 'array', description: '量与众不同的分割线；一条线没有写的量，沿用上面的 spreadAmount 和 fixedAmount', minItems: 0, maxItems: 200, items: object({ entityId: { type: 'string', minLength: 1, maxLength: 120, description: '分割线' }, spreadAmount: amountOf('这条线在展开侧张开多少，毫米'), fixedAmount: amountOf('这条线在固定侧张开多少，毫米') }, ['entityId']) },
      from: point('靠近固定侧起点端的一点：这一端的第一条不动'), fit: fitOf }, ['entityIds', 'fixedIds', 'spreadIds', 'cutIds', 'spreadAmount']),
    run(project, p, env) {
      requireMm(project);
      const lines = figure(project, p.entityIds), amounts = {};
      for (const cut of p.cuts || []) { if (!p.cutIds.includes(cut.entityId)) throw new Error('cuts 里的线须是 cutIds 里的分割线。'); amounts[cut.entityId] = { spread: cut.spreadAmount ?? p.spreadAmount, fixed: cut.fixedAmount ?? (p.fixedAmount || 0) }; }
      const result = spreadBetweenSides(lines, { fixedIds: inside(p.fixedIds, p.entityIds, '固定侧的线'), spreadIds: inside(p.spreadIds, p.entityIds, '展开侧的线'), cutIds: inside(p.cutIds, p.entityIds, '分割线'), spreadAmount: p.spreadAmount, fixedAmount: p.fixedAmount || 0, amounts, from: p.from || null, fit: p.fit || 'none' });
      return { summary: twoSides('spread.atLines', p, result, replaceLines(project, env, result)) };
    } },
  { type: 'spread.fromBase', title: '多边分割展开', description: '基线的两个端点不动，沿分割线把图形向两边展开（ET 的“多边分割展开”）。分割线从基线通到对面；按 cutIds 的先后一条一条地展：基线起点一边的部分绕基线起点转，另一边的部分绕基线终点朝相反的方向转，两个转角与两段基线的长度成反比，直到分割线的远端张开 amount。基线在分割处下沉，保持连着（只留一条很小的缝，300 mm 长的分割线张开 25 mm 时约 0.15 mm）。' + FIGURE + '基线和分割线也要列在 entityIds 里。这一步没有可以用 @ 引用的新对象；展开以后各条在远端是张开的，图形不封闭。',
    input_schema: object({ entityIds: idList('这个图形参与切展的全部的线，基线和分割线也在内', 3), baseIds: idList('基线：一条线或首尾相接的几条线'), cutIds: idList('分割线，按展开的先后'), amount: number(.01, 1000, '每条分割线远端张开多少，毫米') }, ['entityIds', 'baseIds', 'cutIds', 'amount']),
    run(project, p, env) {
      requireMm(project);
      const lines = figure(project, p.entityIds), result = spreadFromBase(lines, { baseIds: inside(p.baseIds, p.entityIds, '基线'), cutIds: inside(p.cutIds, p.entityIds, '分割线'), amount: p.amount }), created = replaceLines(project, env, result);
      return { summary: { operation: 'spread.fromBase', strips: result.strips, linesBefore: lines.length, linesAfter: created.length, baseLengthMm: round(result.baseLengthMm), baseEndsMovedMm: round(result.baseEndsMovedMm),
        cuts: result.cuts.map(cut => ({ name: cut.name, order: cut.order, farOpeningMm: round(cut.farOpeningMm), baseGapMm: round(cut.baseGapMm), ...(cut.cutOffMm > 1e-6 ? { cutOffMm: round(cut.cutOffMm) } : {}) })),
        stripsTurnedDeg: result.stripsTurnedDeg.map(round), largestCurveChangeMm: round(result.largestCurveChangeMm), lines: listed(created) } };
    } },
];
function twoSides(operation, p, result, created) {
  return { operation, strips: result.strips, fit: p.fit || 'none', linesBefore: result.replaced.length, linesAfter: created.length, fixedLengthMm: round(result.fixedLengthMm), spreadLengthMm: round(result.spreadLengthMm),
    cuts: result.cuts.map(cut => ({ name: cut.name, fixedOpeningMm: round(cut.fixedOpeningMm), spreadOpeningMm: round(cut.spreadOpeningMm), stripTurnedDeg: round(cut.stripTurnedDeg), ...(cut.cutOffMm > 1e-6 ? { cutOffMm: round(cut.cutOffMm) } : {}) })),
    curves: result.curves.map(curve => ({ side: curve.role, fromLines: curve.lines, points: curve.points, lengthBeforeMm: round(curve.lengthBeforeMm), lengthMm: round(curve.lengthMm), ...(curve.keptLength ? { pointsMovedToKeepLengthMm: round(curve.pointsMovedMm) } : {}) })),
    largestCurveChangeMm: round(result.largestCurveChangeMm), lines: listed(created) };
}
