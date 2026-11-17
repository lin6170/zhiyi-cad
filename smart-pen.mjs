/**
 * The smart pen (v61): ET's 智能工具, one tool that draws and changes lines by gesture, without picking a tool for each step.
 *
 * The gestures are the ones ET 2017 states in its own prompt lines and that were repeated there on a probe drawing:
 *   drawing   click points; right click ends: two points are a straight line, three or more a curve. With a length typed
 *             first, the line runs from the first point toward the second and has that length; with a length and a width
 *             it is a rectangle of four lines from the first point toward the second. Ctrl switches the T-square on and off
 *             (丁字尺: level, upright or 45 degrees; a click on a line then lands where that direction meets the line).
 *             A right click on a line or curve while nothing is being drawn opens its points for editing (曲线编辑).
 *   changing  drag a box over lines first; the end of a line that is nearer to the lower right corner of the box is the
 *             end that is changed (box the end itself and it is that end). Then
 *             - a second box and a right click: the two ends are joined in a corner (角连接);
 *             - a length or an amount typed and a right click: the end is moved until the line has that length, or by that
 *               amount (长度调整);
 *             - a click on one or two other lines and a right click: the end is brought to that line, or both ends to the
 *               two lines (一端修正, 两端修正);
 *             - Delete: the boxed lines are deleted;
 *             - Ctrl + click on another line and a right click: the boxed lines are cut where that line crosses them
 *               (要素切断); the cutting line may also be clicked first and the lines boxed after it, which is the order of
 *               ET's prompt.
 *             A box takes every line it touches. A boxed line that is then clicked is the correcting or the cutting line
 *             and no longer one of the lines to change, as in ET; a line boxed a second time counts as boxed the later
 *             way (ET keeps both and then joins no corner).
 * Every gesture ends in commands the page already had (and line.cut, new with the pen), so each result is the result of a
 * command that was compared with ET on its own.
 *
 * This file is the grammar only: a state, an event and the drawing give the next state and, when a gesture is complete, the
 * commands to run. smart-pen-ui.mjs feeds it from the canvas. Millimetres, y up.
 */
import { entitiesInBox } from './selection.mjs';
import { cutPlaces, crossings } from './construct-trim.mjs';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y), copy = p => ({ x: p.x, y: p.y });
export const emptyPen = () => ({ mode: 'idle', points: [], ortho: false, picked: [], boundaries: [], cutter: null });
/** Lines the pen may box: no texts, no lines the page makes itself (seam lines, notches, marks, darts, mirror images), no grain lines. */
export const penCanTake = e => Boolean(e) && e.type !== 'text' && Array.isArray(e.points) && e.points.length >= 2 && !e.derivedFrom && !e.notchFrom && !e.mark && !e.dart && !e.mirrorOf && e.layer !== 'grain';
const closedLine = e => Boolean(e.closed) || (e.points.length > 2 && dist(e.points[0], e.points.at(-1)) < 1e-9);

/**
 * The lines a box touches, each with the end the box stands for. ET takes the end that is nearer to the lower right corner of
 * the box, whichever way the box was dragged and whether or not an end lies inside it (seen in twelve runs in ET 2017). With
 * a small box around an end, which is how the tool is meant to be used, that is the end in the box.
 */
export function caughtBy(project, from, to, visible = () => true) {
  const lines = project.entities.filter(e => penCanTake(e) && visible(e)), ids = entitiesInBox(lines, from, to, true);
  const corner = { x: Math.max(from.x, to.x), y: Math.min(from.y, to.y) };
  return lines.filter(e => ids.has(e.id)).map(e => {
    const a = e.points[0], b = e.points.at(-1), end = dist(a, corner) <= dist(b, corner) ? 'start' : 'end';
    return { id: e.id, name: e.name, end, at: copy(end === 'start' ? a : b), ...(closedLine(e) ? { closed: true } : {}) };
  });
}
/**
 * T-square (丁字尺), ET's rule as measured on seven lines it drew: within 30 degrees of level the line is level, within 30
 * degrees of upright it is upright, between them it runs at 45 degrees; it is as long as the pointer is far from the last
 * point.
 */
export function squared(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, reach = Math.hypot(dx, dy); if (reach < 1e-9) return copy(to);
  const angle = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI, sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
  if (angle < 30) return { x: from.x + sx * reach, y: from.y };
  if (angle > 60) return { x: from.x, y: from.y + sy * reach };
  return { x: from.x + sx * reach * Math.SQRT1_2, y: from.y + sy * reach * Math.SQRT1_2 };
}
/** What the pen is waiting for, in words for the status line. */
export function penHint(state) {
  if (state.mode === 'draw') return '已点 ' + state.points.length + ' 个点。继续点；右键或回车结束：两点是直线，三点以上是曲线。Ctrl 切换丁字尺' + (state.ortho ? '（现在开着）' : '') + '，退格去掉上一个点，Esc 取消。';
  if (state.mode === 'picked') {
    const what = state.cutter ? '已点切断线：右键在它那里切断。' : state.boundaries.length ? '已点 ' + state.boundaries.length + ' 条修正线：右键' + (state.boundaries.length === 2 ? '两端修正' : '一端修正（再点一条就是两端修正）') + '。'
      : '再框一条后右键是角连接；填“长度”或“调整量”后右键是长度调整；点一条或两条修正线后右键是修正；按住 Ctrl 点一条线后右键是切断；Delete 删除。';
    if (!state.picked.length) return '已点切断线：请框住要切断的线，再右键。Esc 取消。';
    return '框住了 ' + state.picked.length + ' 条线（' + state.picked.slice(0, 4).map(p => p.name).join('、') + (state.picked.length > 4 ? ' 等' : '') + '）。' + what + ' Esc 取消。';
  }
  return '点空白处或线上的点开始画线（两点直线，三点以上曲线；先填长度是定长线，再填宽度是矩形）；拖一个框框住线端再修改；右键点一条线改它的点。数字可以直接敲，回车等于右键。';
}

/**
 * One step of the pen.
 *   event   { type: 'click', point, entityId, ctrl } | { type: 'box', from, to } | { type: 'finish', entityId } | { type: 'key', key }
 *   fields  { length, width, amount } in millimetres; 0 when a box is empty
 * Returns the next state and, when a gesture is complete, `steps` (commands to run as one step back), `label` (what was
 * done) and `used` (the boxes that are spent); `action` asks the page for something that is not a command; `message` is said.
 */
export function penStep(state, event, project, fields = {}) {
  const s = { ...state, points: state.points.map(copy), picked: state.picked.slice(), boundaries: state.boundaries.slice() }, stay = (more = {}) => ({ state: s, ...more });
  const rest = () => ({ ...emptyPen(), ortho: s.ortho }), length = fields.length > 0 ? fields.length : 0, width = fields.width > 0 ? fields.width : 0, amount = Number.isFinite(fields.amount) ? fields.amount : 0;
  if (event.type === 'key') {
    if (event.key === 'Escape') return { state: rest(), ...(s.mode === 'idle' ? {} : { message: '已取消。' }) };
    if (event.key === 'Enter') return penStep(state, { type: 'finish', entityId: null }, project, fields);
    if (event.key === 'Control' && s.mode !== 'picked') { s.ortho = !s.ortho; return stay({ message: s.ortho ? '丁字尺开：只画横、竖和 45 度方向。' : '丁字尺关：任意方向。' }); }
    if (s.mode === 'draw' && event.key === 'Backspace') { s.points.pop(); return s.points.length ? stay() : { state: rest() }; }
    if (s.mode === 'picked' && (event.key === 'Delete' || event.key === 'Backspace')) return { state: rest(), steps: [{ type: 'entity.delete', parameters: { entityIds: s.picked.map(p => p.id) } }], label: '删除 ' + s.picked.length + ' 条线' };
    return stay();
  }
  if (event.type === 'click') {
    if (s.mode === 'picked') {
      if (!event.entityId) return stay({ message: '请点修正线，或者右键执行、Esc 取消。' });
      const boxed = s.picked.findIndex(p => p.id === event.entityId);
      if (boxed >= 0) {   // the box touched this line as well; clicking it says it is the other line, and ET takes it so
        if (s.picked.length === 1) return stay({ message: '只框住了这一条线；修正线和切断线要点另一条。' });
        s.picked.splice(boxed, 1);
      }
      if (event.ctrl) { s.cutter = event.entityId; s.boundaries = []; return stay(); }
      if (s.boundaries.includes(event.entityId)) return stay();
      if (s.boundaries.length >= 2) return stay({ message: '修正线最多两条。' });
      s.cutter = null; s.boundaries.push(event.entityId); return stay();
    }
    if (s.mode === 'idle' && event.ctrl && event.entityId) { s.mode = 'picked'; s.cutter = event.entityId; return stay(); }   // ET's order: the cutting line first, then the box
    const last = s.points.at(-1); let point = s.ortho && last ? squared(last, event.point) : copy(event.point);
    if (s.ortho && last && event.entityId) {   // a click on a line with the T-square on: the point is where that direction meets the line, as in ET
      const target = project.entities.find(e => e.id === event.entityId), reach = dist(last, point);
      if (target && target.type !== 'text' && reach > 1e-9) { const far = { x: last.x + (point.x - last.x) / reach * 1e5, y: last.y + (point.y - last.y) / reach * 1e5 }, hits = crossings({ points: [last, far] }, target).filter(hit => hit.at > 1e-6); if (hits.length) point = copy(hits[0].point); }
    }
    if (last && dist(last, point) < 1e-6) return stay();
    s.mode = 'draw'; s.points.push(point); return stay();
  }
  if (event.type === 'box') {
    if (s.mode === 'draw') return stay({ message: '正在画线：先右键结束或按 Esc 取消，再框选。' });
    const caught = caughtBy(project, event.from, event.to, event.visible).filter(c => c.id !== s.cutter && !s.boundaries.includes(c.id));
    if (!caught.length) return stay(s.mode === 'picked' ? {} : { message: '框里没有线。' });
    for (const c of caught) { const i = s.picked.findIndex(p => p.id === c.id); if (i >= 0) s.picked[i] = c; else s.picked.push(c); }   // boxed again: the later box counts
    s.mode = 'picked'; return stay();
  }
  if (event.type !== 'finish') return stay();
  if (s.mode === 'draw') {
    const [a, b] = s.points;
    if (s.points.length < 2) return { state: rest(), message: '只点了一个点，没有画线。' };
    if (length) {
      if (width) {   // ET draws the rectangle as four lines: from the first point along the length, then along the width
        const sx = b.x >= a.x ? 1 : -1, sy = b.y >= a.y ? 1 : -1, c = [a, { x: a.x + sx * length, y: a.y }, { x: a.x + sx * length, y: a.y + sy * width }, { x: a.x, y: a.y + sy * width }];
        return { state: rest(), steps: c.map((q, i) => ({ type: 'draw.line', parameters: { from: q, to: c[(i + 1) % 4] } })), label: '画矩形', used: ['length', 'width'] };
      }
      const reach = dist(a, b);
      return { state: rest(), steps: [{ type: 'draw.line', parameters: { from: a, to: { x: a.x + (b.x - a.x) / reach * length, y: a.y + (b.y - a.y) / reach * length } } }], label: '画定长线', used: ['length'] };
    }
    if (s.points.length === 2) return { state: rest(), steps: [{ type: 'draw.line', parameters: { from: a, to: b } }], label: '画直线' };
    return { state: rest(), steps: [{ type: 'draw.curve', parameters: { points: s.points } }], label: '画曲线' };
  }
  if (s.mode === 'picked') {
    const open = s.picked.filter(p => !p.closed), needOpen = what => open.length === s.picked.length ? null : stay({ message: '闭合的图形没有端点，不能' + what + '；它只能删除。' });
    if (s.cutter) {   // a box is a loose way to choose: lines in it that the cutting line does not cross are left alone
      const entity = id => project.entities.find(e => e.id === id), cutter = entity(s.cutter), crossed = s.picked.filter(p => cutPlaces(entity(p.id), cutter).hits.length);
      if (!s.picked.length) return stay({ message: '请先框住要切断的线，再右键。' });
      if (!crossed.length) return stay({ message: '框住的线都没有与切断线相交。' });
      return { state: rest(), steps: [{ type: 'line.cut', parameters: { cutterEntityId: s.cutter, entityIds: crossed.map(p => p.id) } }], label: '切断 ' + crossed.length + ' 条线' };
    }
    if (s.boundaries.length === 1) return needOpen('修正') || { state: rest(), steps: open.map(p => ({ type: 'line.correctEnd', parameters: { entityId: p.id, boundaryEntityId: s.boundaries[0], end: p.end } })), label: '一端修正 ' + open.length + ' 条线' };
    if (s.boundaries.length === 2) return needOpen('修正') || { state: rest(), steps: open.map(p => ({ type: 'line.correctEnds', parameters: { entityId: p.id, boundaryEntityIds: s.boundaries.slice() } })), label: '两端修正 ' + open.length + ' 条线' };
    if (length || amount) return needOpen('调整长度') || { state: rest(), steps: open.map(p => ({ type: 'line.setLength', parameters: { entityId: p.id, end: p.end, ...(length ? { length } : { delta: amount }) } })), label: '长度调整 ' + open.length + ' 条线', used: ['length', 'amount'] };
    if (s.picked.length === 2) return needOpen('角连接') || { state: rest(), steps: [{ type: 'line.cornerJoin', parameters: { firstEntityId: open[0].id, secondEntityId: open[1].id, firstNear: open[0].at, secondNear: open[1].at } }], label: '角连接' };
    return stay({ message: s.picked.length === 1 ? '只框住了一条线：再框一条是角连接；或者填长度、点修正线、按 Delete。' : '框住了 ' + s.picked.length + ' 条线：角连接要正好两条；或者填长度、点修正线、按 Delete。' });
  }
  if (event.entityId) return { state: rest(), action: { type: 'edit-points', entityId: event.entityId } };
  return stay();
}
