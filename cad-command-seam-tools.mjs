/**
 * Commands of v66 for the seam tools of ET's 缝边 menu that v65 left: 生成扩展缝边 and 修改扩展缝边线宽度 (the extended seam, a second
 * outline outside the seam outline; its geometry is extendedOutline in seams.mjs), 延长到环边 (inner lines of a piece carried on to
 * its outline) and 净边延长处理 (every net edge carried on beyond its corners to the seam line of the next edge). What was watched on
 * ET 2017 is with each command.
 */
import { number, text, object, idList, requireMm, groupOf, addEntity, changeableLine, round } from './cad-command-kit.mjs';
import { contoursForGroup } from './topology.mjs';
import { applyAllowance, seamContourEdges } from './seams.mjs';
import { seamEdgeDefinitions, edgeKey } from './seam-widths.mjs';
import { correctEnd, outwardDirection, nearestOnPath } from './construct-trim.mjs';
import { applyShape } from './cad-command-trim.mjs';
import { refreshCurve } from './curves.mjs';
import { deleteSelection } from './selection.mjs';

const at = q => ({ x: round(q.x), y: round(q.y) });
/** ET draws the lines of 净边延长 in this colour (ff80ff). */
export const NET_EXTENSION_COLOR = [255, 128, 255];
function primaryContour(group) { const contour = contoursForGroup(group).find(c => c.role === 'primary-contour' && c.entityIds.length); if (!contour) throw new Error('裁片“' + group.name + '”没有轮廓定义。'); return contour; }
function seamOf(project, group) {
  const contour = contoursForGroup(group).find(c => c.role === 'primary-contour');
  return contour ? (project.seamAllowances || []).find(r => r.baseEntityIds.length === contour.entityIds.length && r.baseEntityIds.every(id => contour.entityIds.includes(id))) || null : null;
}
function seamed(project, group) { const recipe = seamOf(project, group); if (!recipe) throw new Error('裁片“' + group.name + '”还没有缝份，请先加缝份。'); return recipe; }
const rebuild = (project, group, recipe, extension, env) => applyAllowance(project, { name: group.name, entityIds: primaryContour(group).entityIds, recipeId: recipe.id }, { ...recipe, extension }, env.makeId);
const touchSource = group => { if (group.source?.format === 'ET PRJ') group.source = { ...group.source, membershipModified: true }; };

// ---------------------------------------------------------------- geometry of 延长到环边 and 净边延长
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), cross = (a, b) => a.x * b.y - a.y * b.x, unit = v => { const d = Math.hypot(v.x, v.y); return { x: v.x / d, y: v.y / d }; };
/** Where a ray from `from` in direction `d` first meets a polyline (nearest point ahead), or null. */
function rayOnPolyline(from, d, points) {
  let best = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], e = sub(points[i], a), den = cross(d, e); if (Math.abs(den) < 1e-12) continue;
    const s = cross(sub(a, from), e) / den, u = cross(sub(a, from), d) / den;
    if (s > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 && (!best || s < best.s)) best = { s, point: { x: from.x + d.x * s, y: from.y + d.y * s } };
  }
  return best;
}
/** Even-odd test against the outline edges (their points; a curve's points are its display polyline). */
function inside(point, outline) {
  let crossings = 0;
  for (const edge of outline) for (let i = 1; i < edge.points.length; i++) {
    const a = edge.points[i - 1], b = edge.points[i];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y)) crossings++;
  }
  return crossings % 2 === 1;
}
/** The seam line of a contour edge as a polyline: a straight edge's line reaching far beyond its ends, a curve's offset carried on straight. */
function seamLineOf(edge) {
  const p = edge.points, n = p.length, normal = i => { const t = unit(sub(p[Math.min(i + 1, n - 1)], p[Math.max(i - 1, 0)])); return { x: t.y, y: -t.x }; };
  const moved = p.map((q, i) => { const m = normal(i); return { x: q.x + m.x * edge.width, y: q.y + m.y * edge.width }; });
  const head = unit(sub(moved[0], moved[1])), tail = unit(sub(moved[n - 1], moved[n - 2])), far = 1e5;
  return [{ x: moved[0].x + head.x * far, y: moved[0].y + head.y * far }, ...moved, { x: moved[n - 1].x + tail.x * far, y: moved[n - 1].y + tail.y * far }];
}
/** The direction in which a contour edge leaves one of its two ends, away from the edge: a straight edge's own, a curve's over its last 3 mm. */
function awayFrom(project, edge, atCorner) {
  if (edge.points.length === 2) return unit(atCorner === 'last' ? sub(edge.points[1], edge.points[0]) : sub(edge.points[0], edge.points[1]));
  const entity = project.entities.find(e => e.id === edge.entityId), entityEnd = (atCorner === 'last') !== edge.reversed ? 'end' : 'start';
  return unit(outwardDirection(entity, entityEnd));
}

export const seamToolCommands = [
  { type: 'seam.extension', title: '生成扩展缝边', description: '在裁片的缝份外面再加一圈扩展缝边（ET 的生成扩展缝边），画成虚线，跟着裁片和缝份一起变。width 是扩展缝边离缝边线的宽度（毫米），整片一样宽；width 为 0 去掉这片的扩展缝边。缝边线的每一段按它所属的边往外移 width，转角处两段延长相交成尖角；角处理的那一段按 ET 的归属：切角的斜边归设置切角的那条边（entityId 那条），反转角折回的那段归侧边，偷角处理的竖边和七字角、反转直角、可调反转、双延长角、双投影角那一段归折边，折叠角两段各归它接着的那条边。要让某几条边宽度不同，先用这条命令生成，再用 seam.extensionEdges；再用这条命令会把整片改回一样宽。裁片要先有缝份。',
    input_schema: object({ groupId: text(120, '裁片'), width: number(0, 1000, '扩展缝边离缝边线的宽度，毫米；0 去掉扩展缝边') }, ['groupId', 'width']),
    run(project, p, env) {
      requireMm(project);
      const group = groupOf(project, p.groupId), recipe = seamed(project, group);
      if (p.width === 0 && !recipe.extension) throw new Error('裁片“' + group.name + '”没有扩展缝边。');
      if (p.width > 0 && recipe.extension && recipe.extension.width === p.width && !recipe.extension.edges.length) throw new Error('扩展缝边没有变化。');
      rebuild(project, group, recipe, p.width > 0 ? { width: p.width, edges: [] } : null, env);
      return { summary: { operation: 'seam.extension', groupId: group.id, widthMm: p.width, ...(p.width > 0 ? {} : { removed: true }) } };
    } },
  { type: 'seam.extensionEdges', title: '修改扩展缝边宽度', description: '改裁片扩展缝边在某几条边上的宽度（ET 的修改扩展缝边线宽度），其余的边不变。entityIds 是这一片轮廓上的净样边，width 是这些边上扩展缝边离缝边线的新宽度（毫米，大于 0）。角处理的那一段跟着它所属的边（见 seam.extension）。裁片要先有扩展缝边；要整片一样宽或去掉扩展缝边，用 seam.extension。',
    input_schema: object({ groupId: text(120, '裁片'), entityIds: idList('要改的净样边，这一片的轮廓线'), width: number(.01, 1000, '这些边上扩展缝边离缝边线的宽度，毫米') }, ['groupId', 'entityIds', 'width']),
    run(project, p, env) {
      requireMm(project);
      const group = groupOf(project, p.groupId), recipe = seamed(project, group);
      if (!recipe.extension) throw new Error('裁片“' + group.name + '”还没有扩展缝边，请先生成扩展缝边。');
      const edges = seamEdgeDefinitions(project, primaryContour(group).entityIds), widths = new Map(recipe.extension.edges.map(e => [edgeKey(e.entityId, e.segmentIndex ?? null), e.width]));
      let changed = 0;
      for (const id of new Set(p.entityIds)) {
        const found = edges.filter(e => e.entityId === id); if (!found.length) throw new Error('指定的边不在裁片“' + group.name + '”的轮廓上。');
        for (const e of found) { if ((widths.get(e.key) ?? recipe.extension.width) !== p.width) changed++; widths.set(e.key, p.width); }
      }
      if (!changed) throw new Error('扩展缝边没有变化。');
      const extension = { width: recipe.extension.width, edges: [...widths].map(([key, width]) => { const [entityId, segmentIndex] = JSON.parse(key); return { entityId, segmentIndex, width }; }) };
      rebuild(project, group, recipe, extension, env);
      return { summary: { operation: 'seam.extensionEdges', groupId: group.id, edgesChanged: changed, widthMm: p.width } };
    } },
  { type: 'piece.extendToOutline', title: '延长到环边', description: '把裁片里的内部线（直线或曲线）两端都延长到裁片的净样轮廓（ET 的延长到环边）：直线沿自己的方向延长；曲线沿端点的方向（最后 3 毫米的方向）延长，在碰到轮廓的地方加一个曲线点后重新拟合。已经在轮廓上的端点不动，两端都已经在轮廓上的线跳过（全部都在轮廓上时报错）。entityIds 是要延长的内部线，都要属于 groupId 这一片，不能是轮廓线、缝份线、刀口线或文字。',
    input_schema: object({ groupId: text(120, '裁片'), entityIds: idList('要延长到轮廓的内部线') }, ['groupId', 'entityIds']),
    run(project, p) {
      requireMm(project);
      const group = groupOf(project, p.groupId), outline = primaryContour(group).entityIds.map(id => project.entities.find(e => e.id === id)), lines = [], skipped = [];
      const onOutline = q => outline.some(edge => { const found = nearestOnPath(edge, q); return Math.hypot(found.point.x - q.x, found.point.y - q.y) < .01; });
      for (const id of new Set(p.entityIds)) {
        const { entity, owner } = changeableLine(project, id, '内部线');
        if (owner !== group) throw new Error('“' + entity.name + '”不是裁片“' + group.name + '”的内部线。');
        if (entity.closed) throw new Error('“' + entity.name + '”是闭合图形，没有端点。');
        let shape = entity; const ends = [];
        for (const end of ['start', 'end']) {
          const tip = end === 'end' ? shape.points.at(-1) : shape.points[0];
          if (onOutline(tip)) continue;
          if (!inside(tip, outline)) throw new Error('“' + entity.name + '”的' + (end === 'start' ? '起点' : '终点') + '在裁片外面。');
          const tries = outline.map(edge => { try { return correctEnd(shape, end, edge); } catch { return null; } }).filter(r => r && r.action === 'extend');
          if (!tries.length) throw new Error('“' + entity.name + '”沿自己的方向延长，碰不到裁片的轮廓。');
          const best = tries.reduce((a, b) => b.movedMm < a.movedMm ? b : a);
          shape = best.curve ? refreshCurve({ ...shape, curve: best.curve }) : { ...shape, points: best.points };
          ends.push({ end, to: at(best.to), movedMm: round(best.movedMm) });
        }
        if (!ends.length) { skipped.push(entity.name); continue; }
        applyShape(entity, shape.curve ? { curve: shape.curve } : { points: shape.points });
        lines.push({ entityId: entity.id, name: entity.name, ends });
      }
      if (!lines.length) throw new Error((skipped.length > 1 ? '这些线' : '“' + skipped[0] + '”') + '的两端都已经在轮廓上。');
      return { summary: { operation: 'piece.extendToOutline', groupId: group.id, lines, ...(skipped.length ? { alreadyOnOutline: skipped } : {}) } };
    } },
  { type: 'piece.netExtensions', title: '净边延长', description: '在裁片的每个转角，把两条净样边各自沿原来的方向延长到另一条边的缝边线（ET 的净边延长处理），延长的线是这一片的内部线（ET 画成粉色）。不管转角的角处理：量到另一条边的缝边线本身（直线边就是它的延长线，曲线边沿缝边曲线）。裁片要先有缝份。再做一次时，这一片原来的净边延长线先去掉。',
    input_schema: object({ groupId: text(120, '裁片') }, ['groupId']),
    run(project, p, env) {
      requireMm(project);
      const group = groupOf(project, p.groupId), recipe = seamed(project, group), edges = seamContourEdges(project, recipe), count = edges.length;
      // what an earlier run left (also the pink lines ET drew, which start at a corner of the outline)
      const corners = edges.map(edge => edge.points.at(-1)), atCorner = q => corners.some(c => Math.hypot(c.x - q.x, c.y - q.y) < .01);
      const old = group.entityIds.map(id => project.entities.find(e => e.id === id)).filter(e => e && (e.netExtension || (!e.curve && e.points?.length === 2 && JSON.stringify(e.color) === JSON.stringify(NET_EXTENSION_COLOR) && (atCorner(e.points[0]) || atCorner(e.points[1])))));
      if (old.length) { deleteSelection(project, new Set(old.map(e => e.id))); group.entityIds = group.entityIds.filter(id => !old.some(e => e.id === id)); }
      const made = [];
      for (let v = 0; v < count; v++) {
        const a = edges[v], b = edges[(v + 1) % count], corner = a.points.at(-1);
        for (const [from, to, side] of [[a, b, 'last'], [b, a, 'first']]) {
          const hit = rayOnPolyline(corner, awayFrom(project, from, side), seamLineOf(to));
          if (!hit || hit.s < .001) continue;
          const line = addEntity(project, env, { name: group.name + ' 净边延长 ' + (made.length + 1), type: 'polyline', layer: 'internal', points: [{ ...corner }, hit.point], color: [...NET_EXTENSION_COLOR], netExtension: true, etAttribute: 1 });   // ET's own lines of 净边延长 carry attribute word 1
          group.entityIds.push(line.id); made.push({ entityId: line.id, from: at(corner), to: at(hit.point), lengthMm: round(hit.s) });
        }
      }
      if (!made.length) throw new Error('裁片“' + group.name + '”的转角处延长不到另一条边的缝边线。');
      touchSource(group);
      return { summary: { operation: 'piece.netExtensions', groupId: group.id, lines: made.length, replaced: old.length, lengthsMm: made.map(m => m.lengthMm) } };
    } },
];
