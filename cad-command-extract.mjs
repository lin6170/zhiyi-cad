/**
 * The command that takes a piece out of structure lines (v59), ET's 提取裁片.
 * The region is found by piece-extract.mjs; here its parts become new lines, a piece is made of them the way piece.create
 * makes one, and the structure lines stay as they are.
 */
import { LIMIT, number, point, idList, text, object, requireMm, entityOf, addEntity, existingIds, round } from './cad-command-kit.mjs';
import { findRegion, canBound, grainLikeEt, MEET } from './piece-extract.mjs';
import { refreshCurve } from './curves.mjs';
import { applyAllowance, SHARP_CORNER_LIMIT } from './seams.mjs';
import { seamEdgeDefinitions } from './seam-widths.mjs';
import { moveSelection } from './selection.mjs';

const copy = p => ({ x: p.x, y: p.y });

export const extractCommands = [
  { type: 'piece.extract', title: '提取裁片', description: '从结构线里取出一个裁片（ET 的“提取裁片”）。结构线互相交叉、两头出头也可以：围成一块封闭区域的各条线，在交点之间的那一段被复制出来，连成这个裁片的净样轮廓，加上布纹线；原来的结构线不动。用 at 给出这一块里面的任意一点，程序自己找出围着它的线；或者用 entityIds 给出围成它的线（这些线只围成一块时可以不给 at）。两者都给时，只在 entityIds 这些线里找包含 at 的那一块。innerEntityIds 是要一起带进裁片的内部线，原样复制。dx、dy 把取出来的裁片平移开，不给就留在原处，与结构线重叠；要接着加工的裁片通常移到空白的地方（在 ET 里，更新所有缝边会把压在裁片上的散线收进这个裁片）。seamWidth 同时加一圈缝份。已经属于裁片的线、缝份线、刀口不能用来围。',
    input_schema: object({ name: text(60, '裁片名称'), at: point('要取的那一块里面的任意一点'), entityIds: idList('围成这一块的线', 0), innerEntityIds: idList('一起带进裁片的内部线', 0),
      dx: number(-LIMIT, LIMIT, '取出来的裁片向右平移多少，毫米，默认 0'), dy: number(-LIMIT, LIMIT, '向上平移多少，毫米，默认 0'), seamWidth: number(0, 300, '同时加的缝份宽度，毫米；不给或 0 就不加') }, ['name']),
    run(project, p, env) {
      requireMm(project);
      if (!p.at && !(p.entityIds || []).length) throw new Error('请给出要取的那一块里面的一点（at），或者围成它的线（entityIds）。');
      const taken = new Map((project.groups || []).flatMap(g => g.entityIds.map(id => [id, g])));
      const loose = e => { const owner = taken.get(e.id); if (owner) throw new Error('“' + e.name + '”已属于裁片“' + owner.name + '”，不能用来提取。'); if (!canBound(e)) throw new Error('“' + e.name + '”不是可以围成裁片的线。'); return e; };
      const lines = (p.entityIds || []).length ? [...existingIds(project, p.entityIds)].map(id => loose(entityOf(project, id))) : project.entities.filter(e => !taken.has(e.id) && canBound(e));
      const inner = [...existingIds(project, p.innerEntityIds || [])].map(id => { const e = entityOf(project, id); if (taken.has(id)) throw new Error('“' + e.name + '”已属于裁片“' + taken.get(id).name + '”。'); if (e.derivedFrom || e.notchFrom) throw new Error('“' + e.name + '”是缝份或刀口的派生线，不能带进裁片。'); return e; });
      const region = findRegion(lines, p.at || null);
      if (inner.some(e => region.parts.some(part => part.source === e))) throw new Error('围成裁片的线不能同时列为内部线。');
      // the parts of the lines around the region become lines of their own
      const contour = region.parts.map(part => {
        const base = { name: p.name + ' · ' + part.source.name, type: 'polyline', layer: 'outline' };
        if (part.curve) return refreshCurve(addEntity(project, env, { ...base, points: [], curve: part.curve, ...(part.closed ? { closed: Boolean(part.source.closed) } : {}) }));
        const points = part.points.map(copy);
        // a straight part ends exactly where its neighbours do, also where a line only reached the other within MEET
        if (!part.closed) { if (Math.hypot(points[0].x - part.startsAt.x, points[0].y - part.startsAt.y) <= MEET) points[0] = copy(part.startsAt); if (Math.hypot(points.at(-1).x - part.endsAt.x, points.at(-1).y - part.endsAt.y) <= MEET) points[points.length - 1] = copy(part.endsAt); }
        return addEntity(project, env, { ...base, points, closed: Boolean(part.closed) });
      });
      const members = inner.map(e => { const { id: sourceId, source, ...rest } = JSON.parse(JSON.stringify(e)); return addEntity(project, env, { ...rest, name: p.name + ' · ' + e.name, ...(e.type === 'text' ? {} : { layer: 'internal' }) }); });
      const grain = addEntity(project, env, { name: p.name + ' · 布纹', type: 'polyline', layer: 'grain', points: grainLikeEt(region.box), arrowEnd: true });
      const ids = contour.map(e => e.id), group = { id: env.makeId(), name: p.name, entityIds: [...ids, ...members.map(e => e.id), grain.id], contours: [{ role: 'primary-contour', entityIds: ids }], source: { kind: 'command' } };
      project.groups.push(group);
      const dx = p.dx || 0, dy = p.dy || 0;
      if (dx || dy) moveSelection(project, new Set(group.entityIds), dx, dy);
      let seam = null;
      if (p.seamWidth > 0) {
        const edges = seamEdgeDefinitions(project, ids);
        seam = applyAllowance(project, { name: p.name, entityIds: ids }, { distance: p.seamWidth, widthMode: 'edges', join: 'miter', miterLimit: SHARP_CORNER_LIMIT, edgeWidths: edges.map(edge => ({ entityId: edge.entityId, segmentIndex: edge.segmentIndex, segmentCount: edge.segmentCount, width: p.seamWidth })), corners: [] }, env.makeId);
      }
      return { summary: { operation: 'piece.extract', groupId: group.id, name: p.name, edges: contour.length, fromLines: region.parts.map(part => part.source.name), innerLines: members.length, areaMm2: round(region.areaMm2), perimeterMm: round(region.perimeterMm), widthMm: round(region.box.maxX - region.box.minX), heightMm: round(region.box.maxY - region.box.minY),
        movedBy: { dx, dy }, regionsAmongTheLines: region.regionsFound, ...(seam ? { seamWidthMm: p.seamWidth } : {}), largestCurveChangeMm: round(Math.max(0, ...region.parts.map(part => part.shapeChangeMm || 0))) }, created: group.id };
    } },
];
