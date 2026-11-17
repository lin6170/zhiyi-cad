/**
 * Marks for buttons, buttonholes, drill holes and bartacks (v53).
 *
 * A row of marks is placed between two points. Every mark is made of ordinary lines (a
 * circle is a closed curve), so that it is plotted and saved like any other line; each line
 * carries a note of the row it belongs to, and a row can be resized or removed as a whole.
 * A row that lies inside one piece becomes part of that piece and moves with it.
 *
 * In an ET file these marks are written as plain circles and lines: ET shows and plots them,
 * but does not know them as its own button or drill objects.
 */
import { LIMIT, number, point, text, object, requireMm, entityOf, addEntity, round } from './cad-command-kit.mjs';
import { refreshCurve } from './curves.mjs';
import { circleCurve } from './construct.mjs';
import { pieceOutline } from './piece-info.mjs';

export const MARK_KINDS = { button: '扣位', buttonhole: '扣眼', drill: '打孔', bartack: '打枣' };
const sizeOf = (description, most = 500) => ({ type: 'number', exclusiveMinimum: 0, maximum: most, description });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), add = (a, v, k = 1) => ({ x: a.x + v.x * k, y: a.y + v.y * k }), norm = v => Math.hypot(v.x, v.y);

/** The places of a row: count marks from one point to the other, the first and the last moved inwards by the two margins. */
export function rowPlaces(from, to, count, startMargin = 0, endMargin = 0) {
  const span = norm(sub(to, from));
  if (count > 1 && !(span > 1e-9)) throw new Error('两个点重合，排不开 ' + count + ' 个。');
  const u = span > 1e-9 ? { x: (to.x - from.x) / span, y: (to.y - from.y) / span } : { x: 1, y: 0 };
  if (count === 1) return { direction: u, places: [add(from, u, startMargin)], spacingMm: 0 };
  const usable = span - startMargin - endMargin;
  if (!(usable > 1e-9)) throw new Error('两端留出的距离加起来超过了两点之间的长度（' + round(span) + ' mm）。');
  const spacing = usable / (count - 1);
  return { direction: u, places: Array.from({ length: count }, (_, i) => add(from, u, startMargin + spacing * i)), spacingMm: spacing };
}
const inside = (p, loop) => { let hit = false; for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) { const a = loop[i], b = loop[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit; } return hit; };
/** The piece all of the places lie in, if there is exactly one; marks outside every piece stay loose. */
function pieceAround(project, places) {
  const found = (project.groups || []).filter(group => { const loop = pieceOutline(project, group); return loop && places.every(p => inside(p, loop)); });
  return found.length === 1 ? found[0] : null;
}

/** The lines of one mark at one place: [{ name, points } | { name, circle: radius }]. direction is the row's direction. */
export function markShapes(kind, at, direction, size, { across = true, shift = 0 } = {}) {
  const u = direction, v = { x: -u.y, y: u.x }, line = (name, a, b) => ({ name, points: [a, b] });
  if (kind === 'button') { const r = size / 2; return [{ name: '圆', circle: r, at }, line('横', add(at, u, -r), add(at, u, r)), line('竖', add(at, v, -r), add(at, v, r))]; }
  if (kind === 'drill') { const r = size / 2, arm = r * 1.6; return [{ name: '圆', circle: r, at }, line('横', add(at, u, -arm), add(at, u, arm)), line('竖', add(at, v, -arm), add(at, v, arm))]; }
  // a buttonhole and a bartack are a bar; the buttonhole has a short tick across each end
  const along = across ? v : u, side = across ? u : v, centre = add(at, along, shift), a = add(centre, along, -size / 2), b = add(centre, along, size / 2);
  if (kind === 'bartack') return [line('线', a, b)];
  const tick = Math.min(3, size / 4);
  return [line('线', a, b), line('端 1', add(a, side, -tick / 2), add(a, side, tick / 2)), line('端 2', add(b, side, -tick / 2), add(b, side, tick / 2))];
}

function place(project, env, kind, p, shapesAt) {
  requireMm(project);
  const row = rowPlaces(p.from, p.to ?? p.from, p.count ?? 1, p.startMargin ?? 0, p.endMargin ?? 0), setId = env.makeId(), label = p.name || MARK_KINDS[kind], made = [];
  row.places.forEach((at, index) => {
    for (const shape of shapesAt(at, row.direction)) {
      // the note says which row and which part this line is; where the mark stands is read from the lines themselves, so it stays right when the piece is moved or turned
      const mark = { id: setId, kind, index, part: shape.name, sizeMm: p.diameter ?? p.length, ...(kind === 'buttonhole' || kind === 'bartack' ? { across: p.direction !== 'along', shiftMm: p.shift ?? 0 } : {}) };
      const name = label + ' ' + (index + 1) + (shape.name === '圆' || shape.name === '线' ? '' : ' · ' + shape.name);
      const entity = shape.circle ? refreshCurve(addEntity(project, env, { name, type: 'polyline', layer: 'internal', points: [], curve: circleCurve(shape.at, shape.circle), mark }))
        : addEntity(project, env, { name, type: 'polyline', layer: 'internal', points: shape.points.map(q => ({ x: q.x, y: q.y })), mark });
      made.push(entity.id);
    }
  });
  const owner = pieceAround(project, row.places);
  if (owner) owner.entityIds.push(...made);
  return { summary: { operation: 'mark.' + kind, kind, setId, count: row.places.length, spacingMm: round(row.spacingMm), lines: made.length, piece: owner ? owner.name : null, first: { x: round(row.places[0].x), y: round(row.places[0].y) }, last: { x: round(row.places.at(-1).x), y: round(row.places.at(-1).y) } }, created: made[0] };
}
const rowFields = { from: point('第一个的位置'), to: point('最后一个的位置；只做 1 个时可以不给'), count: { type: 'integer', minimum: 1, maximum: 100, description: '个数，默认 1；多于 1 个时在两点之间等距排开，两头各一个' },
  startMargin: number(0, LIMIT, '第一个离第一点多远，毫米，默认 0'), endMargin: number(0, LIMIT, '最后一个离第二点多远，毫米，默认 0'), name: text(40, '名称') };
const barFields = { direction: { type: 'string', enum: ['across', 'along'], description: 'across：与这一排的方向垂直（默认）；along：顺着这一排的方向。说的是相对这一排，不是画布上的横竖' }, shift: number(-500, 500, '沿它自己的方向挪动多少，毫米，默认 0（以定位点为中心）。正数：across 时挪向这一排前进方向的左边，along 时挪向前方') };
const rowChecks = p => { if ((p.count ?? 1) > 1 && !p.to) throw new Error('多于 1 个时要给出最后一个的位置。'); };
const marksOf = (project, setId) => project.entities.filter(e => e.mark?.id === setId);

export const markCommands = [
  { type: 'mark.buttons', title: '扣位', description: '在两点之间等距排一排扣位，每个扣位画成一个圆和一个十字。diameter 是扣子直径。排在一个裁片里面时，这排扣位属于这个裁片，随裁片一起移动。保存为 ET 文件时写成普通的圆和线。',
    input_schema: object({ ...rowFields, diameter: sizeOf('扣子直径，毫米') }, ['from', 'diameter']),
    run(project, p, env) { rowChecks(p); return place(project, env, 'button', p, (at, u) => markShapes('button', at, u, p.diameter)); } },
  { type: 'mark.buttonholes', title: '扣眼', description: '在两点之间等距排一排扣眼，每个扣眼画成一条线，两头各有一小横。length 是扣眼长度。direction 为 across 时扣眼与这一排垂直，为 along 时顺着这一排。这是相对这一排说的，不是画布上的横竖：师傅说“横着”“竖着”时按这一排的走向换算，一排从上往下排，水平的扣眼是 across；一排从左往右排，水平的是 along。shift 让扣眼沿自己的方向挪一点，例如与门襟垂直的扣眼向门襟边挪 2 到 3 毫米。位置按画布坐标给。全部落在同一个裁片的净样轮廓里面时，这些记号属于这个裁片，随它移动。',
    input_schema: object({ ...rowFields, length: sizeOf('扣眼长度，毫米'), ...barFields }, ['from', 'length']),
    run(project, p, env) { rowChecks(p); return place(project, env, 'buttonhole', p, (at, u) => markShapes('buttonhole', at, u, p.length, { across: p.direction !== 'along', shift: p.shift ?? 0 })); } },
  { type: 'mark.drill', title: '打孔', description: '在一个点上做打孔标记（一个小圆和一个十字），常用在省尖、袋位。也可以给 to 和 count，在两点之间等距打一排。diameter 是孔的直径，默认 3 毫米。位置按画布坐标给。全部落在同一个裁片的净样轮廓里面时，这些记号属于这个裁片，随它移动。',
    input_schema: object({ ...rowFields, diameter: sizeOf('孔的直径，毫米，默认 3', 100) }, ['from']),
    run(project, p, env) { rowChecks(p); const diameter = p.diameter ?? 3; return place(project, env, 'drill', { ...p, diameter }, (at, u) => markShapes('drill', at, u, diameter)); } },
  { type: 'mark.bartack', title: '打枣', description: '在一个点上做打枣标记（一条短线），常用在袋口两端、开衩止点。length 是长度，direction 和 shift 的意思与扣眼相同；方向以 from 到 to 为准，只给一个点时以水平方向为准：这时 along 是水平的，across 是竖直的。位置按画布坐标给。全部落在同一个裁片的净样轮廓里面时，这些记号属于这个裁片，随它移动。',
    input_schema: object({ ...rowFields, length: sizeOf('打枣长度，毫米'), ...barFields }, ['from', 'length']),
    run(project, p, env) { rowChecks(p); return place(project, env, 'bartack', p, (at, u) => markShapes('bartack', at, u, p.length, { across: p.direction !== 'along', shift: p.shift ?? 0 })); } },
  { type: 'mark.resize', title: '修改标记大小', description: '修改一排扣位、扣眼、打孔或打枣的大小：扣位和打孔是直径，扣眼和打枣是长度。entityId 给这一排里的任意一条线。位置不变。',
    input_schema: object({ entityId: text(120, '这一排标记里的任意一条线'), size: sizeOf('新的直径或长度，毫米') }, ['entityId', 'size']),
    run(project, p) {
      requireMm(project);
      const picked = entityOf(project, p.entityId); if (!picked.mark) throw new Error('“' + picked.name + '”不是扣位、扣眼、打孔或打枣标记。');
      const set = marksOf(project, picked.mark.id), kind = picked.mark.kind;
      if (Math.abs(picked.mark.sizeMm - p.size) < 1e-9) throw new Error('大小没有变化。');
      const round_ = kind === 'button' || kind === 'drill', byIndex = new Map();
      for (const entity of set) { if (!byIndex.has(entity.mark.index)) byIndex.set(entity.mark.index, []); byIndex.get(entity.mark.index).push(entity); }
      for (const parts of byIndex.values()) {
        // the bar of the mark gives its place and direction as they are now
        const bar = parts.find(e => e.mark.part === (round_ ? '横' : '线'));
        if (!bar || bar.curve || bar.points.length !== 2 || !(norm(sub(bar.points[1], bar.points[0])) > 1e-9)) throw new Error('这排标记的线被改动过，无法按原样修改大小。可以删掉重做。');
        const [a, b] = bar.points, span = norm(sub(b, a)), along = { x: (b.x - a.x) / span, y: (b.y - a.y) / span }, middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, m = bar.mark;
        const at = round_ ? middle : add(middle, along, -(m.shiftMm || 0)), u = round_ || !m.across ? along : { x: along.y, y: -along.x };
        const shapes = markShapes(kind, at, u, p.size, { across: m.across, shift: m.shiftMm || 0 });
        for (const entity of parts) {
          const shape = shapes.find(candidate => candidate.name === entity.mark.part);
          if (!shape) throw new Error('标记“' + entity.name + '”的记录不完整，无法修改。');
          if (shape.circle) { entity.curve = circleCurve(shape.at, shape.circle); refreshCurve(entity); } else entity.points = shape.points.map(q => ({ x: q.x, y: q.y }));
          entity.mark.sizeMm = p.size;
        }
      }
      return { summary: { operation: 'mark.resize', kind, setId: picked.mark.id, count: new Set(set.map(e => e.mark.index)).size, sizeMm: p.size } };
    } },
  { type: 'mark.remove', title: '删除标记', description: '删除一排扣位、扣眼、打孔或打枣。entityId 给这一排里的任意一条线，整排一起删掉。',
    input_schema: object({ entityId: text(120, '这一排标记里的任意一条线') }, ['entityId']),
    run(project, p) {
      requireMm(project);
      const picked = entityOf(project, p.entityId); if (!picked.mark) throw new Error('“' + picked.name + '”不是扣位、扣眼、打孔或打枣标记。');
      const ids = new Set(marksOf(project, picked.mark.id).map(e => e.id)), count = new Set(marksOf(project, picked.mark.id).map(e => e.mark.index)).size;
      project.entities = project.entities.filter(e => !ids.has(e.id));
      for (const group of project.groups || []) group.entityIds = group.entityIds.filter(id => !ids.has(id));
      return { summary: { operation: 'mark.remove', kind: picked.mark.kind, count, lines: ids.size } };
    } },
];
