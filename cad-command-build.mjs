/**
 * Commands that put shapes together (v62): ET's 形状对接及复制, 对称修改, 拼接合并 and 裁片合并.
 * The geometry is in piece-join.mjs and mirror-links.mjs.
 */
import { text, point, idList, object, requireMm, entityOf, groupOf, addEntity, existingIds, assertWholePieces, round } from './cad-command-kit.mjs';
import { dockTransform, spliceEdges, mergePlan } from './piece-join.mjs';
import { reflectInto, reflector } from './mirror-links.mjs';
import { rotateSelection, moveSelection, duplicateSelection, deleteSelection } from './selection.mjs';
import { transform } from './geometry.mjs';
import { applyAllowance, SHARP_CORNER_LIMIT } from './seams.mjs';
import { contoursForGroup, orientChain } from './topology.mjs';
import { refreshCurve } from './curves.mjs';
import { straightEnds } from './construct.mjs';

const at = q => ({ x: round(q.x), y: round(q.y) }), far = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const edgeOf = what => ({ type: 'object', description: what, additionalProperties: false, required: ['entityId'], properties: {
  entityId: text(120, '这条边的图元'), segmentIndex: { type: 'integer', minimum: 0, maximum: 10000, description: '裁片的轮廓是一条闭合折线时，说明是它的第几条边，从 0 数起' },
  joinEnd: { type: 'string', enum: ['start', 'end'], description: '这条边的哪一端是连接端：start 是起点，end 是终点' }, near: point('也可以给一个靠近连接端的点，代替 joinEnd') } });
const sideOf = what => ({ type: 'object', description: what, additionalProperties: false, required: ['entityId'], properties: {
  entityId: text(120, '这条边的图元：裁片轮廓上的一条线或曲线'), joinEnd: { type: 'string', enum: ['start', 'end'], description: '对接起点是这条边的哪一端：start 是起点，end 是终点。一般不用给' }, near: point('也可以给一个靠近对接起点的点，代替 joinEnd') } });
const KEEP = { both: '原线和镜像都留下', original: '只留原线', image: '只留镜像' };
/** A line that can take part in symmetric editing: a loose line or curve that the page did not make itself. */
function looseLine(project, id) {
  const e = entityOf(project, id);
  if (e.type === 'text') throw new Error('“' + e.name + '”是文字，不能做对称修改。');
  if (e.derivedFrom || e.notchFrom || e.mark || e.dart) throw new Error('“' + e.name + '”是缝份、刀口、标记或省的一部分，不能做对称修改。');
  if (e.mirrorOf) throw new Error('“' + e.name + '”自己就是一条镜像，请选它的原线。');
  const owner = (project.groups || []).find(group => group.entityIds.includes(id));
  if (owner) throw new Error('“' + e.name + '”属于裁片“' + owner.name + '”。对称修改只对还没有编入裁片的线做；整个裁片要镜像请用“按轴镜像”。');
  return e;
}

export const buildCommands = [
  { type: 'selection.dock', title: '形状对接', description: '把图元或整个裁片整体移动并转动，使它上面的一条线段落到另一条线段上（ET 的“形状对接及复制”）：fromStart 移到 toStart，fromStart→fromEnd 的方向转到 toStart→toEnd 的方向。只移动和转动，不翻转，大小不变，所以两条线段不一样长时 fromEnd 落在 toStart→toEnd 这条线上，不一定落在 toEnd。四个点只用来定出怎么移、怎么转，通常取图元的端点，不在图元上也可以；几条不相连的线可以一起对接，它们之间的相对位置不变。copy 为 true 时原件不动，对接的是副本。常用来把两片的缝合边对在一起，看接缝是否圆顺。要对接整个裁片时用 groupIds 给出裁片，缝份、布纹线和里面的线都跟着走；零散的线用 entityIds；两样可以一起给，至少给一样。',
    input_schema: object({ entityIds: idList('要对接的零散图元'), groupIds: idList('要整个对接的裁片'), fromStart: point('对接前的起点：通常是图元上的一点'), fromEnd: point('对接前的终点：通常是图元上的另一点'), toStart: point('对接后的起点：fromStart 要去的位置'), toEnd: point('对接后的终点：给出方向'), copy: { type: 'boolean', description: '是否保留原件、对接副本，默认否' } }, ['fromStart', 'fromEnd', 'toStart', 'toEnd']),
    run(project, p, env) {
      requireMm(project); const move = dockTransform(p.fromStart, p.fromEnd, p.toStart, p.toEnd);
      if (Math.abs(move.degrees) < 1e-9 && Math.abs(move.dx) < 1e-9 && Math.abs(move.dy) < 1e-9 && !p.copy) throw new Error('对接前后的位置相同，没有可做的。');
      if (!p.entityIds?.length && !p.groupIds?.length) throw new Error('请给出要对接的图元（entityIds）或裁片（groupIds）。');
      let ids = existingIds(project, p.entityIds || []); for (const groupId of new Set(p.groupIds || [])) for (const id of groupOf(project, groupId).entityIds) ids.add(id);
      assertWholePieces(project, ids);
      const groupsBefore = new Set((project.groups || []).map(group => group.id));
      if (p.copy) ids = duplicateSelection(project, ids, env.makeId, { offsetX: 0, offsetY: 0 });
      if (Math.abs(move.degrees) >= 1e-9) rotateSelection(project, ids, move.degrees, p.fromStart);
      if (Math.abs(move.dx) >= 1e-9 || Math.abs(move.dy) >= 1e-9) moveSelection(project, ids, move.dx, move.dy);
      const copyGroup = p.copy ? (project.groups || []).find(group => !groupsBefore.has(group.id)) : null;
      return { summary: { operation: 'selection.dock', entities: ids.size, turnedDegrees: round(move.degrees), movedMm: { dx: round(move.dx), dy: round(move.dy) }, segmentBeforeMm: round(move.lengthBeforeMm), segmentAfterMm: round(move.lengthAfterMm),
        endsMeet: Math.abs(move.lengthBeforeMm - move.lengthAfterMm) < 1e-6, copy: Boolean(p.copy), entityIds: p.copy ? [...ids] : undefined }, created: p.copy ? (copyGroup?.id || [...ids][0]) : null };
    } },
  { type: 'symmetry.begin', title: '对称修改', description: '给几条线各做一条跟着它变的镜像（ET 的“对称修改”）：entityIds 是要修改的线，对称轴由两个点给出，或者用一条直线 axisEntityId。之后用任何办法改这些线（移动曲线点、长度调整、修正……），镜像都会跟着变；改好以后用“结束对称修改”决定留下哪些。只对还没有编入裁片的线做；镜像的名字是“原线名 · 镜像”，镜像本身不能直接改；画布描述里镜像带着 mirrorImageOf，是它原线的编号，看到这个字段就知道有对称修改还没有结束。只想要一份不再跟随的镜像副本时，用“按轴镜像”并把 copy 设为 true。',
    input_schema: object({ entityIds: idList('要对称修改的线'), axisFrom: point('对称轴上的一点'), axisTo: point('对称轴上的另一点'), axisEntityId: text(120, '作为对称轴的直线，代替两个点') }, ['entityIds']),
    run(project, p, env) {
      requireMm(project); const byPoints = p.axisFrom !== undefined || p.axisTo !== undefined;
      if (Boolean(p.axisEntityId) === byPoints) throw new Error('对称轴请给出一条直线，或给出两个点，二选一。');
      if (byPoints && !(p.axisFrom && p.axisTo)) throw new Error('对称轴的两个点都要给出。');
      const [from, to] = byPoints ? [p.axisFrom, p.axisTo] : straightEnds(entityOf(project, p.axisEntityId), '对称轴');
      reflector(from, to);
      const link = { id: env.makeId(), axisFrom: { x: from.x, y: from.y }, axisTo: { x: to.x, y: to.y }, pairs: [] }, lines = [];
      for (const id of existingIds(project, p.entityIds)) {
        if (id === p.axisEntityId) throw new Error('对称轴不能同时是要修改的线。');
        const source = looseLine(project, id);
        if ((project.mirrorLinks || []).some(other => other.pairs.some(pair => pair.sourceId === id))) throw new Error('“' + source.name + '”已经在做对称修改，请先结束。');
        const image = addEntity(project, env, { name: source.name + ' · 镜像', type: source.type, layer: source.layer, points: [], mirrorOf: source.id, ...(source.aux ? { aux: true } : {}) });
        reflectInto(image, source, link); link.pairs.push({ sourceId: source.id, imageId: image.id }); lines.push({ name: source.name, image: image.name });
      }
      project.mirrorLinks = [...(project.mirrorLinks || []), link];
      return { summary: { operation: 'symmetry.begin', linkId: link.id, axis: [at(from), at(to)], lines } };
    } },
  { type: 'symmetry.end', title: '结束对称修改', description: '结束“对称修改”，镜像不再跟着原线变。keep 决定留下什么：both（默认）原线和镜像都留下，original 只留原线、去掉镜像，image 只留镜像、去掉原线。entityIds 是要结束的线，给原线或者给它的镜像都可以；不给就结束全部。留下来的镜像成为普通的线，名字不变。',
    input_schema: object({ keep: { type: 'string', enum: Object.keys(KEEP), description: 'both：都留下；original：只留原线；image：只留镜像。默认 both' }, entityIds: idList('要结束的线：原线或它的镜像；不给就全部结束') }, []),
    run(project, p) {
      const keep = p.keep || 'both', wanted = p.entityIds ? existingIds(project, p.entityIds) : null, links = project.mirrorLinks || [], gone = new Set(), done = [];
      if (!links.length) throw new Error('现在没有在做对称修改的线。');
      for (const link of links) link.pairs = link.pairs.filter(pair => {
        if (wanted && !wanted.has(pair.sourceId) && !wanted.has(pair.imageId)) return true;
        const source = project.entities.find(e => e.id === pair.sourceId), image = project.entities.find(e => e.id === pair.imageId);
        if (image) delete image.mirrorOf;
        if (keep === 'original' && image) gone.add(image.id);
        if (keep === 'image' && source) gone.add(source.id);
        done.push({ name: source?.name || image?.name, kept: KEEP[keep] }); return false;
      });
      if (!done.length) throw new Error('给出的线都不在做对称修改。');
      project.entities = project.entities.filter(e => !gone.has(e.id));
      project.mirrorLinks = links.filter(link => link.pairs.length); if (!project.mirrorLinks.length) delete project.mirrorLinks;
      return { summary: { operation: 'symmetry.end', keep, lines: done, removed: gone.size } };
    } },
  { type: 'piece.spliceEdges', title: '拼接合并', description: '把两个裁片各一条轮廓边接成一条新的线（ET 的“拼接合并”），原来的裁片不动。常用来把前后袖窿、前后领口接起来看接得顺不顺、量总长。first 和 second 各指一条边和它的连接端（joinEnd，或者用 near 给一个靠近那一端的点）。摆法是两片在连接端缝在一起的样子：两个连接角上各自的另一条边互相重合，第二片绕连接角转过去；第一条边方向不变，它的自由端放在 at，第二条边从连接点接下去。结果里 kinkDegrees 是两条边在连接点的夹角，0 表示接得顺。两条边都是直线时得到折线，否则得到一条过点的曲线（转折太急时保留成一串点）。只能用裁片的轮廓边：要靠相邻的边才知道怎么摆。例如两个并排的长方形裁片，前片的右边和后片的左边都以上端为连接端：后片转半圈，接出来的是一条直线，从 at 起先是前片的右边（从下端到上端），过了连接点接着是后片的左边，总长是两条边的长度之和。',
    input_schema: object({ first: edgeOf('第一条边：它的方向不变'), second: edgeOf('第二条边：接在第一条边的连接端上'), at: point('新线的起点：第一条边的自由端放在这里'), name: text(80, '新线的名称，默认“拼接线”') }, ['first', 'second', 'at']),
    run(project, p, env) {
      requireMm(project); const made = spliceEdges(project, p.first, p.second, p.at), name = p.name || '拼接线';
      const created = made.curve ? refreshCurve(addEntity(project, env, { name, type: 'polyline', points: [], curve: made.curve })) : addEntity(project, env, { name, type: 'polyline', points: made.points.map(q => ({ x: q.x, y: q.y })) });
      return { summary: { operation: 'piece.spliceEdges', entityId: created.id, name, pieces: made.pieces, edges: made.edges, joint: at(made.joint), turnedDegrees: round(made.turnedDegrees), kinkDegrees: round(made.kinkDegrees),
        lengthsMm: [round(made.firstLengthMm), round(made.secondLengthMm)], lengthMm: round(made.firstLengthMm + made.secondLengthMm), curve: Boolean(made.curve), ...(made.curve ? { curvePoints: made.fitPoints } : {}), shapeChangeMm: round(made.shapeChangeMm), ...(made.asPoints ? { keptAsPoints: made.points.length } : {}) }, created: created.id };
    } },
  { type: 'piece.merge', title: '裁片合并', description: '把两个裁片沿各自的一条轮廓边并成一个裁片（ET 的“裁片合并”，保形）。first 是留在原处的那个裁片的一条边，second 是并过来的那个裁片的一条边。第二片整体转动、移动，不翻转也不缩放，直到这两条边叠在一起、两片分在这条边的两侧：第二条边的中点落在第一条边两个端点连线的中点上（直边就是它自己的中点；曲线边取两端的连线，所以弯度不同的两条边也能并）。两条边哪一头对哪一头一般不用说：只有一种对法两片不会叠在一起，程序取这一种，第二片只转到这个位置所需要的角度（两片本来并排摆着、两条边平行时只是平移过去）。然后第二条边删掉；第一条边留在合并后的裁片里成为内部线，不再有缝份；两片其余的边连成新的一圈轮廓。名称、属性和布纹线用第一片的，缝份合成一圈，各边保留原来的宽度，第二片里面的线和文字跟着过来。joinEnd（或 near）用来像 ET 那样自己指定两条边各自的“对接起点”，起点对起点；指定的对法会让两片叠在一起时，命令拒绝。两条边不一样长时照样合并：第二片上与那条边相邻的两条边把端点拉到第一条边的两端，形状略有变化，结果里 adjustedEdges 列出它们各自拉动了多少。这两条边上的刀口随之删除。带放码方案的裁片、轮廓是一条闭合折线的裁片不能合并。只想看两条边接起来顺不顺、量总长时用“拼接合并”，它不动裁片。',
    input_schema: object({ first: sideOf('第一条边：它所在的裁片留在原处'), second: sideOf('第二条边：它所在的裁片并过去') }, ['first', 'second']),
    run(project, p, env) {
      requireMm(project);
      const plan = mergePlan(project, p.first, p.second), one = plan.first.group, two = plan.second.group, kept = plan.first.entity, gone = plan.second.entity;
      const members = new Set([...one.entityIds, ...two.entityIds]);
      if ((project.gradingPlans || []).some(g => (g.sources || []).some(s => members.has(s.entityId)))) throw new Error('这两个裁片带着放码方案。合并会改掉轮廓，请先删除放码方案，合并以后重新设置。');
      const seamOf = side => (project.seamAllowances || []).find(r => r.baseEntityIds.length === side.contour.entityIds.length && r.baseEntityIds.every(id => side.contour.entityIds.includes(id))) || null;
      const seams = [seamOf(plan.first), seamOf(plan.second)], widthOf = new Map();
      [plan.first, plan.second].forEach((side, i) => { const r = seams[i]; for (const e of side.lines) widthOf.set(e.id, !r ? null : r.widthMode === 'edges' ? (r.edgeWidths.find(w => w.entityId === e.id)?.width ?? Math.abs(r.distance)) : Math.abs(r.distance)); });
      const inner = [contoursForGroup(one), contoursForGroup(two)].map(list => list.filter(c => c.role !== 'primary-contour'));
      // 1. the second piece goes to its place, whole
      const ids = new Set(two.entityIds);
      if (Math.abs(plan.degrees) > 1e-12) rotateSelection(project, ids, plan.degrees, plan.pivot);
      if (far(plan.shift, { x: 0, y: 0 }) > 1e-12) moveSelection(project, ids, plan.shift.x, plan.shift.y);
      // 2. what goes: the second edge, the notches on the two edges, the second piece's seam allowance, grain line and attribute text
      const doomed = new Set([gone.id]), firstHas = what => project.entities.some(e => one.entityIds.includes(e.id) && what(e));
      for (const e of project.entities) if (ids.has(e.id) && ((e.layer === 'grain' && firstHas(x => x.layer === 'grain')) || e.pieceLabel === true)) doomed.add(e.id);
      const notchesGone = (project.notches || []).filter(n => n.baseEntityId === gone.id || n.baseEntityId === kept.id);
      for (const n of notchesGone) for (const id of n.outputIds || []) doomed.add(id);
      if (seams[0] && seams[1]) for (const id of seams[1].outputIds) doomed.add(id);
      const rest = two.entityIds.filter(id => !doomed.has(id));
      deleteSelection(project, doomed);
      project.notches = (project.notches || []).filter(n => !notchesGone.includes(n));
      // 3. the lines beside the second edge reach the ends of the first
      const similar = (entity, from0, from1, to0, to1) => {   // the turn and scaling that take from0 to to0 and from1 to to1
        const a = { x: from1.x - from0.x, y: from1.y - from0.y }, b = { x: to1.x - to0.x, y: to1.y - to0.y }, la = Math.hypot(a.x, a.y), lb = Math.hypot(b.x, b.y);
        if (!(la > 1e-6) || !(lb > 1e-6)) throw new Error('“' + entity.name + '”太短，合并时没法把它接到第一条边的端点上。');
        const turn = Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x), c = Math.cos(turn) * lb / la, s = Math.sin(turn) * lb / la;
        transform(entity, q => ({ x: to0.x + (q.x - from0.x) * c - (q.y - from0.y) * s, y: to0.y + (q.x - from0.x) * s + (q.y - from0.y) * c }));
      };
      const pin = n => { if (!n.entity.curve) n.entity.points[n.end === 'start' ? 0 : n.entity.points.length - 1] = { x: n.goes.x, y: n.goes.y }; }, adjusted = [];
      const [n0, n1] = plan.near;
      if (n0.entity === n1.entity) { if (far(n0.near, n0.goes) > 1e-9 || far(n1.near, n1.goes) > 1e-9) { similar(n0.entity, n0.near, n1.near, n0.goes, n1.goes); pin(n0); pin(n1); adjusted.push({ name: n0.entity.name, movedMm: round(Math.max(far(n0.near, n0.goes), far(n1.near, n1.goes))) }); } }
      else for (const n of plan.near) if (far(n.near, n.goes) > 1e-9) { similar(n.entity, n.far, n.near, n.far, n.goes); pin(n); adjusted.push({ name: n.entity.name, movedMm: round(far(n.near, n.goes)) }); }
      // 4. one piece: the outline goes round the first piece from one end of its edge to the other and back round the second
      const group = project.groups.find(g => g.id === one.id); project.groups = project.groups.filter(g => g.id !== two.id);
      const round1 = side => { const i = side.lines.indexOf(side.entity); return [...side.lines.slice(i + 1), ...side.lines.slice(0, i)]; };
      const gapOf = lines => { const chain = orientChain(lines), tip = (item, last) => { const pts = item.entity.curve?.controlPoints || item.entity.points; return pts[(item.reversed !== last) ? pts.length - 1 : 0]; }; return Math.max(...chain.map((item, i) => far(tip(item, true), tip(chain[(i + 1) % chain.length], false)))); };
      let outline = [...round1(plan.first), ...round1(plan.second)]; const otherWay = [...round1(plan.first), ...round1(plan.second).reverse()];
      if (gapOf(otherWay) < gapOf(outline)) outline = otherWay;
      const gap = gapOf(outline), outlineIds = outline.map(e => e.id);
      if (!(gap <= .1)) throw new Error('合并后的轮廓没有闭合，端点最大间隙 ' + gap.toFixed(3) + ' mm。');
      group.entityIds = [...new Set([...group.entityIds, ...rest])];
      group.contours = [{ role: 'primary-contour', entityIds: outlineIds }, ...inner[0], ...inner[1]];
      if (group.source?.format === 'ET PRJ') group.source = { ...group.source, membershipModified: true };
      kept.layer = 'internal';
      // 5. one seam allowance: every edge keeps the width it had
      const recipe = seams[0] || seams[1]; let widths = [];
      if (recipe) {
        const usual = Math.abs(recipe.distance); widths = outline.map(e => widthOf.get(e.id) ?? usual);
        const atJoint = c => { const e = project.entities.find(x => x.id === c.entityId), at = c.end === 'start' ? e.points[0] : e.points.at(-1); return plan.ends.some(q => far(at, q) < .2); };
        const corners = [...(seams[0]?.corners || []), ...(seams[1]?.corners || [])].filter(c => outlineIds.includes(c.entityId) && !atJoint(c));
        recipe.baseEntityIds = [...outlineIds]; recipe.name = group.name + ' · 缝份'; recipe.basisLabel = group.name;
        for (const n of project.notches || []) if (seams[1] && n.targetSeamId === seams[1].id) n.targetSeamId = recipe.id;
        if (Math.max(...widths) > 0) applyAllowance(project, { name: group.name, entityIds: outlineIds, recipeId: recipe.id }, { distance: Math.max(...widths), widthMode: 'edges', join: 'miter', miterLimit: SHARP_CORNER_LIMIT, edgeWidths: outline.map((e, i) => ({ entityId: e.id, segmentIndex: null, segmentCount: null, width: widths[i] })), corners }, env.makeId);
        else deleteSelection(project, new Set(recipe.outputIds));
      }
      return { summary: { operation: 'piece.merge', groupId: group.id, name: group.name, mergedPiece: two.name, innerLine: kept.name, removedEdge: gone.name, joinEnds: plan.joinEnds, joinEndsChosenHere: plan.chosen, turnedDegrees: round(plan.degrees),
        edgeLengthsMm: [round(plan.firstLengthMm), round(plan.secondLengthMm)], endToEndMm: plan.chordsMm.map(round), adjustedEdges: adjusted, contourEdges: outline.length, removedNotches: notchesGone.length,
        ...(recipe ? { seamWidthsMm: [...new Set(widths)].sort((x, y) => x - y) } : {}) } };
    } },
];
