/**
 * Commands for managing what is already on the canvas (v53): editing a text, aligning pieces,
 * laying pieces out in rows, and locking pieces. A locked piece is refused by every other
 * command; that check lives in cad-commands.mjs so that no command can forget it.
 */
import { LIMIT, number, point, text, idList, object, requireMm, entityOf, groupOf, addEntity, round } from './cad-command-kit.mjs';
import { moveSelection, rotateSelection } from './selection.mjs';
import { pieceExtent, pieceOutline } from './piece-info.mjs';
import { attributesOf, materialTable, labelText, refreshPieceLabel } from './piece-attributes.mjs';

function grainOf(project, group) { const ids = new Set(group.entityIds), grain = project.entities.find(e => ids.has(e.id) && e.layer === 'grain' && e.type !== 'text' && !e.curve && e.points.length === 2); if (!grain) throw new Error('裁片“' + group.name + '”没有布纹线。'); return grain; }
const EDGES = { left: '左边', right: '右边', top: '上边', bottom: '下边', centerX: '左右居中', centerY: '上下居中' };
function pieces(project, ids, what) {
  if (new Set(ids).size !== ids.length) throw new Error(what + '有重复。');
  return ids.map(id => { const group = groupOf(project, id), extent = pieceExtent(project, group); if (!extent) throw new Error('裁片“' + group.name + '”里没有线条。'); return { group, extent }; });
}

export const manageCommands = [
  { type: 'text.edit', title: '修改文字', description: '修改一行已有文字的内容、字高或旋转角度，至少给出一项。文字的位置不变，位置是它的左下角。',
    input_schema: object({ entityId: text(120, '要修改的文字'), text: text(200, '新的文字内容'), height: { type: 'number', exclusiveMinimum: 0, maximum: 1000, description: '新的字高，毫米' }, rotation: number(-360, 360, '新的逆时针旋转角度') }, ['entityId']),
    run(project, p) {
      requireMm(project);
      const entity = entityOf(project, p.entityId);
      if (entity.type !== 'text') throw new Error('“' + entity.name + '”不是文字。');
      if (p.text === undefined && p.height === undefined && p.rotation === undefined) throw new Error('请给出新的内容、字高或旋转角度。');
      const before = { text: entity.text, heightMm: entity.height, rotation: entity.rotation || 0 };
      if (p.text !== undefined) { if (!p.text.trim()) throw new Error('文字内容不能是空的。'); if (entity.name === entity.text) entity.name = p.text; entity.text = p.text; }
      if (p.height !== undefined) { if (entity.width) entity.width = entity.width * p.height / entity.height; entity.height = p.height; }
      if (p.rotation !== undefined) { if (p.rotation) entity.rotation = p.rotation; else delete entity.rotation; }
      if (entity.source) entity.source.modified = true;
      return { summary: { operation: 'text.edit', entityId: entity.id, text: entity.text, heightMm: entity.height, rotation: entity.rotation || 0, before } };
    } },
  { type: 'piece.align', title: '裁片对齐', description: '把几个裁片排齐：以第一个裁片为准，其余裁片整片平移，使它们的同一条边（或中线）对齐。范围按裁片的全部线条算，包括缝份线，不包括文字。left、right 对齐左、右边，top、bottom 对齐上、下边，centerX 左右居中，centerY 上下居中。',
    input_schema: object({ groupIds: idList('要对齐的裁片，第一个是基准', 2), edge: { type: 'string', enum: Object.keys(EDGES), description: '对齐哪一条边或中线' } }, ['groupIds', 'edge']),
    run(project, p) {
      requireMm(project);
      const list = pieces(project, p.groupIds, '裁片列表'), [base, ...others] = list;
      const value = e => ({ left: e.minX, right: e.maxX, top: e.maxY, bottom: e.minY, centerX: (e.minX + e.maxX) / 2, centerY: (e.minY + e.maxY) / 2 })[p.edge], target = value(base.extent), horizontal = ['left', 'right', 'centerX'].includes(p.edge);
      let moved = 0;
      for (const { group, extent } of others) { const shift = target - value(extent); if (Math.abs(shift) < 1e-9) continue; moveSelection(project, new Set(group.entityIds), horizontal ? shift : 0, horizontal ? 0 : shift); moved++; }
      if (!moved) throw new Error('这些裁片的' + EDGES[p.edge] + '已经对齐。');
      return { summary: { operation: 'piece.align', edge: p.edge, base: base.group.name, moved } };
    } },
  { type: 'piece.arrange', title: '裁片排列', description: '把裁片一个挨一个排成几行，互不重叠，方便查看和出图。不给 groupIds 时排列全部没有锁定的裁片。gap 是裁片之间的间隔；rowWidth 是一行的最大宽度，超过就换行，不给时按总面积估一个宽度，排出来大约是一个横放的长方形。一行里各裁片的宽度加上它们之间的间隔，总和不超过 rowWidth 就排在同一行；要排成一横排，rowWidth 给一个比这个总和大的数。第一行从这些裁片现在所占范围的左上角开始，高的裁片排在前面。范围按裁片的全部线条算，包括缝份线。',
    input_schema: object({ groupIds: idList('要排列的裁片', 1), gap: number(0, 1000, '裁片之间的间隔，毫米，默认 20'), rowWidth: { type: 'number', exclusiveMinimum: 0, maximum: LIMIT, description: '一行的最大宽度，毫米' } }, []),
    run(project, p) {
      requireMm(project);
      const ids = p.groupIds || (project.groups || []).filter(group => !group.locked).map(group => group.id);
      if (!ids.length) throw new Error('没有可以排列的裁片。');
      const list = pieces(project, ids, '裁片列表'), gap = p.gap ?? 20, size = item => ({ w: item.extent.maxX - item.extent.minX, h: item.extent.maxY - item.extent.minY });
      const left = Math.min(...list.map(item => item.extent.minX)), top = Math.max(...list.map(item => item.extent.maxY));
      const widest = Math.max(...list.map(item => size(item).w)), total = list.reduce((sum, item) => sum + (size(item).w + gap) * (size(item).h + gap), 0);
      const rowWidth = Math.max(widest, p.rowWidth ?? Math.sqrt(total * 2.5));
      // tall pieces first; pieces of the same height keep the order they were given in
      const order = list.map((item, index) => ({ ...item, index })).sort((a, b) => size(b).h - size(a).h || a.index - b.index);
      let x = left, rowTop = top, rowHeight = 0, rows = 1, moved = 0;
      for (const item of order) {
        const { w, h } = size(item);
        if (x > left && x + w - left > rowWidth + 1e-9) { x = left; rowTop -= rowHeight + gap; rowHeight = 0; rows++; }
        const dx = x - item.extent.minX, dy = rowTop - item.extent.maxY;
        if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) { moveSelection(project, new Set(item.group.entityIds), dx, dy); moved++; }
        x += w + gap; rowHeight = Math.max(rowHeight, h);
      }
      if (!moved) throw new Error('这些裁片已经是这样排列的。');
      return { summary: { operation: 'piece.arrange', pieces: list.length, rows, moved, rowWidthMm: round(rowWidth), gapMm: gap } };
    } },
  { type: 'piece.setLocked', title: '锁定或解锁裁片', description: '锁定裁片：锁定之后，这个裁片不能被移动、修改或删除，直到解锁。locked 为 true 锁定，为 false 解锁。',
    input_schema: object({ groupIds: idList('裁片', 1), locked: { type: 'boolean', description: 'true 锁定，false 解锁' } }, ['groupIds', 'locked']),
    run(project, p) {
      requireMm(project);
      if (new Set(p.groupIds).size !== p.groupIds.length) throw new Error('裁片列表有重复。');
      let changed = 0;
      for (const id of p.groupIds) { const group = groupOf(project, id); if (Boolean(group.locked) === p.locked) continue; if (p.locked) group.locked = true; else delete group.locked; changed++; }
      if (!changed) throw new Error(p.locked ? '这些裁片已经锁定。' : '这些裁片没有锁定。');
      return { summary: { operation: 'piece.setLocked', locked: p.locked, pieces: changed } };
    } },
  { type: 'piece.setAttributes', title: '裁片属性', description: '设置裁片的布料、片数和是否对称，至少给出一项。material 是布料名称：面料、里料、里布，或这份图里从 ET 文件带来的布料名（ET 文件里布料按编号记，名称来自各台电脑上 ET 自己的布料表）；count 是片数；symmetric 为 true 表示对称裁片：每一片还要再裁一片左右相反的，实际裁的数量是片数的两倍（ET 告诉其它系统数量时就是这样算的）。裁片上有属性文字时，文字跟着更新。保存为 ET 文件时这些属性一起写入。',
    input_schema: object({ groupId: text(120, '裁片'), material: text(20, '布料名称'), count: { type: 'integer', minimum: 1, maximum: 99, description: '片数' }, symmetric: { type: 'boolean', description: '是否对称裁片（每片再裁一片左右相反的）' } }, ['groupId']),
    run(project, p) {
      requireMm(project);
      const group = groupOf(project, p.groupId), before = attributesOf(group);
      if (p.material === undefined && p.count === undefined && p.symmetric === undefined) throw new Error('请给出布料、片数或是否对称。');
      const table = materialTable(project);
      if (p.material !== undefined && !table.has(p.material)) throw new Error('不认识布料“' + p.material + '”。可以用的布料：' + [...table.keys()].join('、') + '。');
      const next = { material: p.material ?? before.material, count: p.count ?? before.count, symmetric: p.symmetric ?? before.symmetric };
      if (next.material === before.material && next.count === before.count && next.symmetric === before.symmetric) throw new Error('属性没有变化。');
      // the fabric is kept as a name and the number ET knows it by
      group.attributes = { ...(group.attributes || {}), ...next, ...(p.material !== undefined ? { materialCode: table.get(p.material) } : before.materialCode === null ? {} : { materialCode: before.materialCode }) };
      refreshPieceLabel(project, group);
      return { summary: { operation: 'piece.setAttributes', groupId: group.id, name: group.name, ...next, before: { material: before.material, count: before.count, symmetric: before.symmetric } } };
    } },
  { type: 'piece.label', title: '属性文字', description: '在裁片上写一行属性文字：裁片名称、布料和片数，例如“后袋 面料 × 2”。之后改名称、布料或片数，这行文字会跟着更新。裁片已经有属性文字时，用这条命令改它的字高或位置。at 是文字左下角的位置，不给时放在裁片中间、布纹线的右边；height 是字高，默认 8 毫米。',
    input_schema: object({ groupId: text(120, '裁片'), height: { type: 'number', exclusiveMinimum: 0, maximum: 1000, description: '字高，毫米' }, at: point('文字左下角') }, ['groupId']),
    run(project, p, env) {
      requireMm(project);
      const group = groupOf(project, p.groupId), existing = refreshPieceLabel(project, group), words = labelText(group);
      if (existing) {
        if (p.height === undefined && p.at === undefined) throw new Error('这个裁片已经有属性文字。要改字高或位置，请给出 height 或 at。');
        if (p.height !== undefined) existing.height = p.height;
        if (p.at) existing.points = [{ x: p.at.x, y: p.at.y }];
        return { summary: { operation: 'piece.label', groupId: group.id, text: existing.text, heightMm: existing.height, updated: true } };
      }
      const height = p.height ?? 8, outline = pieceOutline(project, group);
      if (!outline && !p.at) throw new Error('这个裁片没有完整的轮廓，请用 at 给出文字的位置。');
      let at = p.at;
      if (!at) { const xs = outline.map(q => q.x), ys = outline.map(q => q.y); at = { x: round((Math.min(...xs) + Math.max(...xs)) / 2 + height), y: round((Math.min(...ys) + Math.max(...ys)) / 2 - height / 2) }; }
      const entity = addEntity(project, env, { name: words, type: 'text', text: words, layer: 'annotation', height, points: [{ x: at.x, y: at.y }], pieceLabel: true });
      group.entityIds.push(entity.id);
      return { summary: { operation: 'piece.label', groupId: group.id, text: words, heightMm: height, updated: false }, created: entity.id };
    } },
  { type: 'piece.alignGrain', title: '纱向补正', description: '把整个裁片转动，使它的布纹线成为垂直（vertical）或水平（horizontal），按转动角度较小的方向转。与 ET 的“纱向垂直补正”“纱向水平补正”相同。',
    input_schema: object({ groupId: text(120, '裁片'), axis: { type: 'string', enum: ['vertical', 'horizontal'], description: '补正到垂直还是水平' } }, ['groupId', 'axis']),
    run(project, p) {
      requireMm(project);
      const group = groupOf(project, p.groupId), grain = grainOf(project, group), [a, b] = grain.points;
      const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI, target = p.axis === 'vertical' ? 90 : 0;
      let turn = ((target - angle) % 180 + 180) % 180; if (turn > 90) turn -= 180;
      if (Math.abs(turn) < 1e-7) throw new Error('布纹线已经是' + (p.axis === 'vertical' ? '垂直' : '水平') + '的。');
      rotateSelection(project, new Set(group.entityIds), turn);
      return { summary: { operation: 'piece.alignGrain', groupId: group.id, axis: p.axis, degrees: round(turn) } };
    } },
  { type: 'piece.setGrain', title: '布纹线端点', description: '把裁片的布纹线改到两个新的端点之间，裁片本身不动。与 ET 的“更新纱向端点”相同。布纹线带箭头时，箭头在 to 这一端。',
    input_schema: object({ groupId: text(120, '裁片'), from: point('布纹线的一端'), to: point('布纹线的另一端') }, ['groupId', 'from', 'to']),
    run(project, p) {
      requireMm(project);
      const group = groupOf(project, p.groupId), grain = grainOf(project, group), near = (q, r) => Math.hypot(q.x - r.x, q.y - r.y) < 1e-9;
      if (Math.hypot(p.to.x - p.from.x, p.to.y - p.from.y) < 1) throw new Error('布纹线的两个端点太近。');
      if (near(grain.points[0], p.from) && near(grain.points[1], p.to)) throw new Error('布纹线没有变化。');
      grain.points = [{ x: p.from.x, y: p.from.y }, { x: p.to.x, y: p.to.y }];
      return { summary: { operation: 'piece.setGrain', groupId: group.id, lengthMm: round(Math.hypot(p.to.x - p.from.x, p.to.y - p.from.y)) } };
    } },
];
