/**
 * Cutting a figure of loose lines into strips and spreading the strips (v60): ET's 固定等分割, 指定分割 and 多边分割展开.
 *
 * What ET 2017 does was learned by repeating its tools on probe drawings (the files ET saved are the fixtures of the test):
 *
 *  Two sides (固定等分割, 指定分割). The figure has a fixed side and a spread side, each one line or several lines end
 *  to end. It is cut from the fixed side to the spread side: into equal parts (each side is divided by length and the
 *  dividing points are joined), or along lines drawn for it. The strip at the start end stays where it is. At every cut,
 *  all that lies beyond it is moved as one rigid body. An amount is the straight distance between the two points that were
 *  one. With no amount on the fixed side the body turns about the cut's point on the fixed side; with the same amount on
 *  both sides it shifts square to the cut. Otherwise ET's two tools differ:
 *   - 固定等分割 makes two turns: first about the cut's point on the spread side, which opens the fixed side by its amount,
 *     then about the new point on the fixed side, which opens the spread side by its amount;
 *   - 指定分割 shifts the body square to the cut by the fixed side's amount and then turns it about the shifted fixed point
 *     (by the angle whose tangent is the difference of the amounts over the length of the cut).
 *  Both are followed here, each for its own tool.
 *  Every line of the figure is cut where it crosses a cut and each part goes with its strip; every cut becomes two lines,
 *  one on each strip. On request the parts of a side are replaced by a curve through points of the strips (one point in
 *  the middle of each strip's part, or two at 35% and 75% of it when the curve runs over two strips only): one curve for
 *  each line the side was made of (曲线分段拟合), or one for the whole side (曲线合并拟合); the cuts are then left out.
 *
 *  Base line (多边分割展开). The two ends of the base line stay. The cuts run from the base line to the other side and
 *  are taken one after the other in the order they are given. At each cut the part toward the start of the base line turns
 *  about that start and the part toward its end turns the other way about that end, by angles in inverse proportion to
 *  the two lengths of base line, until the far end of the cut has opened by the amount. The base line stays closed except
 *  for a gap of the second order (0.15 mm for 25 mm on 300 mm).
 *
 * Differences from ET, all measured in tests/spread-v60.mjs against ET's own results:
 *  - A side that stays closed (no amount) and is replaced by a curve: ET moves the curve points outward, square to the
 *    line between the curve's ends, and so gives back part of the length lost by rounding the corners (its curve came out
 *    0.003 to 0.03 mm shorter than the side was). Its rule for how far was not found. Here the points are moved the same
 *    way until the curve has exactly the length of the side.
 *  - In 多边分割展开 ET's far ends open by the amount to within 0.01 mm; here exactly. In 指定分割 with amounts on both
 *    sides ET's turn leaves the spread side up to 0.03 mm short of its amount; here the turn goes on until it is exact.
 *  - ET's dividing points lie up to 0.03 mm from the equal division, and on a curved side they are taken on the polyline
 *    ET displays, 0.15 mm off the curve in the probe; here they are exact and on the curve.
 *  - ET stores every straight part as a curve of three points; here it stays a straight line.
 * Not done: ET's "R" option of 固定等分割 (growing amounts), 普通/纱向 of 指定分割 (no difference was seen on lines without
 * a grain line), Ctrl + right click (automatic connection), and 单边分割展开, which refused every probe drawing.
 *
 * Millimetres, y up. Pure functions, no DOM.
 */
import { pathLength, nearestOnPath, crossings, partBetween, sampledBetween } from './construct-trim.mjs';
import { fitClampedSpline } from './fit-spline.mjs';

export const MEET = .05;   // mm: an end this close to another line is taken to lie on it
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y }), scale = (v, k) => ({ x: v.x * k, y: v.y * k });
const dot = (a, b) => a.x * b.x + a.y * b.y, cross = (a, b) => a.x * b.y - a.y * b.x, distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y), copy = p => ({ x: p.x, y: p.y });
const isClosed = e => Boolean(e.closed) || (e.points.length > 2 && distance(e.points[0], e.points.at(-1)) < 1e-9);
/** Lines that can take part: no texts, no lines the page makes itself (seam lines, notches, marks, darts), no grain lines. */
export const canSpread = e => Boolean(e) && e.type !== 'text' && Array.isArray(e.points) && e.points.length >= 2 && !e.derivedFrom && !e.notchFrom && !e.mark && !e.dart && e.layer !== 'grain';
const pointAt = (entity, length) => sampledBetween(entity, length, length)[0];
const endsOf = e => [e.points[0], e.points.at(-1)];

// ---------------------------------------------------------------- rigid motions: p -> R p + t
const STAY = { c: 1, s: 0, x: 0, y: 0 };
const moved = (m, p) => ({ x: m.c * p.x - m.s * p.y + m.x, y: m.s * p.x + m.c * p.y + m.y });
const turnAbout = (centre, angle) => { const c = Math.cos(angle), s = Math.sin(angle); return { c, s, x: centre.x - c * centre.x + s * centre.y, y: centre.y - s * centre.x - c * centre.y }; };
const shiftBy = v => ({ c: 1, s: 0, x: v.x, y: v.y });
/** first, then second */
const then = (first, second) => ({ c: second.c * first.c - second.s * first.s, s: second.s * first.c + second.c * first.s, x: second.c * first.x - second.s * first.y + second.x, y: second.s * first.x + second.c * first.y + second.y });
const angleOf = m => Math.atan2(m.s, m.c) * 180 / Math.PI;
const movedGeometry = (m, g) => g.curve ? { curve: { ...g.curve, controlPoints: g.curve.controlPoints.map(p => moved(m, p)), knots: [...g.curve.knots] } } : { points: g.points.map(p => moved(m, p)) };

// ---------------------------------------------------------------- a side: lines end to end
/** Put lines that join end to end in order. Each item: the line, whether it is run through backwards, its length, where it starts. */
function chainOf(entities, what) {
  if (!entities.length) throw new Error('请给出' + what + '。');
  for (const e of entities) { if (!canSpread(e)) throw new Error('“' + (e && e.name) + '”不能作' + what + '。'); if (isClosed(e)) throw new Error('“' + e.name + '”是闭合的图形，不能作' + what + '。'); }
  const left = entities.slice(), touches = (p, e) => endsOf(e).some(q => distance(p, q) <= MEET);
  const first = left.find(e => endsOf(e).some(p => !left.some(o => o !== e && touches(p, o))));
  if (!first) throw new Error(what + '的线连成了一圈，分不出两头。');
  let current = first, reversed = left.some(o => o !== first && touches(endsOf(first)[0], o)), at = 0; const items = [];
  for (;;) {
    const length = pathLength(current); items.push({ entity: current, reversed, length, from: at }); at += length; left.splice(left.indexOf(current), 1);
    const tip = endsOf(current)[reversed ? 0 : 1], next = left.filter(e => touches(tip, e));
    if (!next.length) break;
    if (next.length > 1) throw new Error(what + '在“' + current.name + '”的一头分了岔。');
    current = next[0]; reversed = distance(tip, endsOf(current)[0]) > distance(tip, endsOf(current)[1]);
  }
  if (left.length) throw new Error(what + '的线须首尾相接：“' + left[0].name + '”接不上。');
  return { items, total: at };
}
const flipped = chain => { let at = 0; const items = chain.items.slice().reverse().map(item => { const out = { ...item, reversed: !item.reversed, from: at }; at += item.length; return out; }); return { items, total: chain.total }; };
function itemAt(chain, station) { const s = Math.max(0, Math.min(chain.total, station)); return chain.items.find(item => s <= item.from + item.length + 1e-9) || chain.items.at(-1); }
const own = (item, station) => { const local = Math.max(0, Math.min(item.length, station - item.from)); return item.reversed ? item.length - local : local; };
const chainPoint = (chain, station) => { const item = itemAt(chain, station); return pointAt(item.entity, own(item, station)); };
/** The place on a side nearest to a point. */
function chainStation(chain, point) {
  let best = null;
  for (const item of chain.items) { const near = nearestOnPath(item.entity, point); if (!best || near.away < best.away) best = { away: near.away, point: near.point, station: item.from + (item.reversed ? item.length - near.at : near.at) }; }
  return best;
}
const startingNear = (chain, near) => near && distance(near, chainPoint(chain, chain.total)) < distance(near, chainPoint(chain, 0)) ? flipped(chain) : chain;

// ---------------------------------------------------------------- pieces of the lines, strip by strip
/** The part of a line between two lengths from its start, as it is (points or curve). */
function partOf(entity, from, to, total) {
  if (from <= 1e-7 && to >= total - 1e-7) return entity.curve ? { curve: entity.curve } : { points: entity.points.map(copy) };
  const part = partBetween(entity, from, to); return part.curve ? { curve: part.curve, shapeChangeMm: part.shapeChangeMm || 0 } : { points: part.points };
}
/** The parts of a side that fall into each strip; `bounds` are the places of the cuts along the side, in order. */
function sidePieces(chain, bounds) {
  const edges = [0, ...bounds, chain.total], pieces = [];
  for (const item of chain.items) for (let strip = 0; strip + 1 < edges.length; strip++) {
    const a = Math.max(item.from, edges[strip]), b = Math.min(item.from + item.length, edges[strip + 1]);
    if (b - a > 1e-6) pieces.push({ item, strip, a, b });
  }
  return pieces.sort((p, q) => p.a - q.a);
}
const pieceGeometry = piece => { const { item, a, b } = piece, from = own(item, item.reversed ? b : a), to = own(item, item.reversed ? a : b); return partOf(item.entity, from, to, item.length); };
/** On which side of every cut a point lies: the number of cuts it is beyond. */
const stripOf = (cuts, p) => cuts.reduce((n, cut) => n + (cut.side * cross(sub(cut.far, cut.near), sub(p, cut.near)) > 0 ? 1 : 0), 0);
/** Cut the other lines of the figure where they cross the cuts. */
function otherPieces(others, cuts) {
  const out = [];
  for (const e of others) {
    const total = pathLength(e), stations = [];
    for (const cut of cuts) { let hits = []; try { hits = crossings(e, cut.path); } catch { hits = []; } for (const hit of hits) stations.push(hit.at); }
    if (isClosed(e)) {
      if (stations.length) throw new Error('“' + e.name + '”是闭合的图形，又跨过了分割线；请先把它打断。');
      out.push({ entity: e, strip: stripOf(cuts, e.points[0]), geometry: e.curve ? { curve: e.curve } : { points: e.points.map(copy) }, whole: true }); continue;
    }
    const marks = [0, ...stations.sort((p, q) => p - q).filter(s => s > 1e-6 && s < total - 1e-6), total].filter((s, i, list) => i === 0 || s - list[i - 1] > 1e-6);
    for (let i = 1; i < marks.length; i++) out.push({ entity: e, strip: stripOf(cuts, pointAt(e, (marks[i - 1] + marks[i]) / 2)), geometry: partOf(e, marks[i - 1], marks[i], total), whole: marks.length === 2, part: i });
  }
  return out;
}
/** Where a cut line meets a side: a crossing, or an end of the cut line lying on the side. */
function meeting(line, chain, what) {
  const total = pathLength(line), found = [];
  const take = (point, lineAt) => { if (!found.some(f => distance(f.point, point) <= MEET)) { const near = chainStation(chain, point); found.push({ point: near.point, lineAt, station: near.station }); } };
  for (const item of chain.items) { let hits = []; try { hits = crossings(line, item.entity); } catch { hits = []; } for (const hit of hits) take(hit.point, hit.at); }
  endsOf(line).forEach((end, i) => { const near = chainStation(chain, end); if (near.away <= MEET) take(near.point, i ? total : 0); });
  if (!found.length) throw new Error('分割线“' + line.name + '”没有碰到' + what + '。');
  if (found.length > 1) throw new Error('分割线“' + line.name + '”与' + what + '相交不止一处。');
  return found[0];
}
const asPath = geometry => geometry.curve ? { points: [], curve: geometry.curve } : { points: geometry.points };
const endsOfGeometry = g => g.curve ? [g.curve.controlPoints[0], g.curve.controlPoints.at(-1)] : [g.points[0], g.points.at(-1)];
const backwards = g => g.curve ? { curve: { ...g.curve, controlPoints: g.curve.controlPoints.slice().reverse().map(copy), knots: g.curve.knots.map(k => g.curve.knots.at(-1) + g.curve.knots[0] - k).reverse() } } : { points: g.points.slice().reverse().map(copy) };

// ---------------------------------------------------------------- one cut between two sides
/** The motion of all that lies beyond a cut. near: the cut's point on the fixed side, far: on the spread side, both where they are now. */
function opening(near, far, fixedAmount, spreadAmount, side, rule) {
  const reach = distance(near, far); if (!(reach > 1e-6)) throw new Error('分割线没有长度。');
  if (Math.abs(fixedAmount) >= 2 * reach || Math.abs(spreadAmount) >= 2 * reach) throw new Error('展开量超过了分割线长度的两倍（' + (2 * reach).toFixed(1) + ' mm），转不出来。');
  const u = scale(sub(far, near), 1 / reach), square = { x: -u.y * side, y: u.x * side };   // square to the cut, toward the part that moves
  if (Math.abs(fixedAmount - spreadAmount) < 1e-9) return shiftBy(scale(square, spreadAmount));
  if (rule === 'shift') {   // 指定分割: out by the fixed amount square to the cut, then a turn about the shifted fixed point
    const first = shiftBy(scale(square, fixedAmount)), pivot = moved(first, near), shifted = moved(first, far);
    const open = angle => { const at = moved(turnAbout(pivot, side * angle), shifted), by = sub(at, far); return Math.sign(dot(by, square) || 1) * Math.hypot(by.x, by.y); };
    let lo = -1, hi = 1; if (!(open(lo) < spreadAmount && open(hi) > spreadAmount)) throw new Error('展开量超出了这条分割线转得出来的范围。');
    for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (open(mid) < spreadAmount) lo = mid; else hi = mid; }
    return then(first, turnAbout(pivot, side * (lo + hi) / 2));
  }
  const first = turnAbout(far, -side * 2 * Math.asin(fixedAmount / (2 * reach)));
  return then(first, turnAbout(moved(first, near), side * 2 * Math.asin(spreadAmount / (2 * reach))));
}

// ---------------------------------------------------------------- a side as a curve
const curveThrough = points => fitClampedSpline(points).curve, lengthThrough = points => pathLength({ points: [], curve: curveThrough(points) });
/** Move the inner points of a curve square to the line between its ends, all in the same proportion, until the curve has the wanted length. */
function withLength(points, target) {
  const a = points[0], b = points.at(-1), chord = distance(a, b), before = lengthThrough(points);
  if (!(chord > 1e-9) || Math.abs(before - target) < 1e-7) return { points, stretch: 1, before, after: before };
  const u = scale(sub(b, a), 1 / chord), across = p => cross(u, sub(p, a)), along = p => dot(u, sub(p, a));
  if (points.every(p => Math.abs(across(p)) < 1e-7)) return { points, stretch: 1, before, after: before };
  const stretched = k => points.map((p, i) => i === 0 || i === points.length - 1 ? copy(p) : { x: a.x + along(p) * u.x - k * across(p) * u.y, y: a.y + along(p) * u.y + k * across(p) * u.x });
  let lo, hi;
  if (before < target) { lo = 1; hi = 1.25; while (lengthThrough(stretched(hi)) < target && hi < 40) hi *= 1.5; if (lengthThrough(stretched(hi)) < target) return { points, stretch: 1, before, after: before }; }
  else { hi = 1; lo = 0; if (lengthThrough(stretched(0)) > target) return { points, stretch: 1, before, after: before }; }
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (lengthThrough(stretched(mid)) < target) lo = mid; else hi = mid; }
  const stretch = (lo + hi) / 2, out = stretched(stretch);
  return { points: out, stretch, before, after: lengthThrough(out) };
}
/** The lines a side becomes. fit: 'none' (its parts, strip by strip), 'each' (one curve for each line of the side), 'merged' (one curve). */
function sideLines(chain, bounds, motions, amounts, fit, role) {
  const pieces = sidePieces(chain, bounds), plain = piece => ({ role, strip: piece.strip, source: piece.item.entity, geometry: movedGeometry(motions[piece.strip], pieceGeometry(piece)), whole: piece.b - piece.a >= piece.item.length - 1e-6 });
  if (fit === 'none') return { lines: pieces.map(plain), curves: [] };
  const groups = fit === 'merged' ? [pieces] : chain.items.map(item => pieces.filter(piece => piece.item === item)), lines = [], curves = [];
  for (const group of groups) {
    if (group.length < 2) { lines.push(...group.map(plain)); continue; }
    const shares = group.length >= 3 ? [.5] : [.35, .75], first = group[0], last = group.at(-1);
    const through = [moved(motions[first.strip], chainPoint(chain, first.a)), ...group.flatMap(piece => shares.map(share => moved(motions[piece.strip], chainPoint(chain, piece.a + (piece.b - piece.a) * share)))), moved(motions[last.strip], chainPoint(chain, last.b))];
    const closed = group.slice(1).every(piece => Math.abs(amounts[piece.strip - 1]) < 1e-9), was = group.reduce((sum, piece) => sum + piece.b - piece.a, 0);
    const kept = closed ? withLength(through, was) : { points: through, stretch: 1, before: lengthThrough(through), after: lengthThrough(through) };
    const curve = curveThrough(kept.points);
    lines.push({ role, strip: first.strip, source: fit === 'merged' ? null : first.item.entity, geometry: { curve }, fitted: true, strips: [first.strip, last.strip], ends: [[through[0], curve.controlPoints[0]], [through.at(-1), curve.controlPoints.at(-1)]] });
    curves.push({ role, lines: [...new Set(group.map(piece => piece.item.entity.name))], strips: group.length, points: kept.points.length, lengthBeforeMm: was, lengthMm: kept.after, keptLength: closed, pointsMovedMm: closed ? Math.max(0, ...kept.points.map((p, i) => distance(p, through[i]))) : 0 });
  }
  return { lines, curves };
}

// ---------------------------------------------------------------- 固定等分割 and 指定分割
/**
 * Cut a figure between its fixed side and its spread side and spread the strips.
 *   lines        every line of the figure, the two sides included (and the cut lines, when there are any)
 *   fixedIds     the fixed side: one line or several end to end; spreadIds the same for the spread side
 *   parts        cut into this many equal parts ...
 *   cutIds       ... or cut along these lines; each must reach both sides
 *   spreadAmount / fixedAmount   how far every cut opens on each side, mm; amounts[cut line id] = { spread, fixed } for one cut line
 *   from         a point: the end of the fixed side nearest to it is where the strips are counted from (that strip stays)
 *   fit          'none', 'each' or 'merged'
 */
export function spreadBetweenSides(lines, { fixedIds, spreadIds, parts = null, cutIds = null, spreadAmount = 0, fixedAmount = 0, amounts = {}, from = null, fit = 'none' }) {
  if (!['none', 'each', 'merged'].includes(fit)) throw new Error('拟合方式须是 none、each 或 merged。');
  const byId = new Map(lines.map(e => [e.id, e])), pick = (ids, what) => (ids || []).map(id => { const e = byId.get(id); if (!e) throw new Error(what + '的线须在参与切展的线里面。'); return e; });
  for (const e of lines) if (!canSpread(e)) throw new Error('“' + (e && e.name) + '”不能参与切展。');
  const fixedLines = pick(fixedIds, '固定侧'), spreadLines = pick(spreadIds, '展开侧'), cutLines = pick(cutIds, '分割线');
  if (fixedLines.some(e => spreadLines.includes(e))) throw new Error('一条线不能既是固定侧又是展开侧。');
  if (cutLines.some(e => fixedLines.includes(e) || spreadLines.includes(e))) throw new Error('分割线不能同时是固定侧或展开侧。');
  const fixed = startingNear(chainOf(fixedLines, '固定侧'), from); let spread = chainOf(spreadLines, '展开侧');
  { const f0 = chainPoint(fixed, 0), f1 = chainPoint(fixed, fixed.total), s0 = chainPoint(spread, 0), s1 = chainPoint(spread, spread.total); if (distance(f0, s0) + distance(f1, s1) > distance(f0, s1) + distance(f1, s0)) spread = flipped(spread); }
  let cuts;
  if (cutLines.length) {
    if (parts !== null) throw new Error('等分数和分割线只能给一样。');
    cuts = cutLines.map(line => {
      const onFixed = meeting(line, fixed, '固定侧'), onSpread = meeting(line, spread, '展开侧'), total = pathLength(line), a = Math.min(onFixed.lineAt, onSpread.lineAt), b = Math.max(onFixed.lineAt, onSpread.lineAt);
      if (!(b - a > 1e-6)) throw new Error('分割线“' + line.name + '”在两侧之间没有长度。');
      let geometry = partOf(line, a, b, total); if (onFixed.lineAt > onSpread.lineAt) geometry = backwards(geometry);
      const own = amounts[line.id] || {};
      return { name: line.name, source: line, fixedAt: onFixed.station, spreadAt: onSpread.station, near: onFixed.point, far: onSpread.point, geometry, fixed: own.fixed ?? fixedAmount, spread: own.spread ?? spreadAmount, cutOffMm: a + total - b };
    }).sort((p, q) => p.fixedAt - q.fixedAt);
  } else {
    if (!Number.isInteger(parts) || parts < 2 || parts > 200) throw new Error('等分数须是 2 到 200 的整数。');
    cuts = Array.from({ length: parts - 1 }, (_, i) => { const fixedAt = fixed.total * (i + 1) / parts, spreadAt = spread.total * (i + 1) / parts, near = chainPoint(fixed, fixedAt), far = chainPoint(spread, spreadAt); return { name: '分割线' + (i + 1), source: null, fixedAt, spreadAt, near, far, geometry: { points: [near, far] }, fixed: fixedAmount, spread: spreadAmount, cutOffMm: 0 }; });
  }
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i];
    if (cut.fixedAt < MEET || cut.fixedAt > fixed.total - MEET || cut.spreadAt < MEET || cut.spreadAt > spread.total - MEET) throw new Error('“' + cut.name + '”落在了一侧的端点上，那里没有可以分开的两条。');
    if (i && (cut.fixedAt - cuts[i - 1].fixedAt < MEET || cut.spreadAt - cuts[i - 1].spreadAt < MEET)) throw new Error('“' + cuts[i - 1].name + '”和“' + cut.name + '”在两侧之间交叉或者碰在一起，分不出先后。');
    const step = at => Math.min(1, at / 2), ahead = add(sub(chainPoint(fixed, cut.fixedAt + step(fixed.total - cut.fixedAt)), cut.near), sub(chainPoint(spread, cut.spreadAt + step(spread.total - cut.spreadAt)), cut.far)), turn = cross(sub(cut.far, cut.near), ahead);
    if (!(Math.abs(turn) > 1e-9)) throw new Error('“' + cut.name + '”顺着边走，分不出哪一边是后面的条。');
    cut.side = Math.sign(turn); cut.path = asPath(cut.geometry);
  }
  // the strips: the first stays, each cut moves all that lies beyond it
  const motions = [STAY];
  for (const cut of cuts) { const now = motions.at(-1); motions.push(then(now, opening(moved(now, cut.near), moved(now, cut.far), cut.fixed, cut.spread, cut.side, cutLines.length ? 'shift' : 'turns'))); }
  const sides = new Set([...fixedLines, ...spreadLines, ...cutLines]), others = lines.filter(e => !sides.has(e));
  const fixedSide = sideLines(fixed, cuts.map(cut => cut.fixedAt), motions, cuts.map(cut => cut.fixed), fit, 'fixed'), spreadSide = sideLines(spread, cuts.map(cut => cut.spreadAt), motions, cuts.map(cut => cut.spread), fit, 'spread');
  const out = [...fixedSide.lines, ...spreadSide.lines];
  if (fit === 'none') cuts.forEach((cut, i) => { out.push({ role: 'cut', strip: i, source: cut.source, cut: i + 1, face: 'before', geometry: movedGeometry(motions[i], cut.geometry) }, { role: 'cut', strip: i + 1, source: cut.source, cut: i + 1, face: 'after', geometry: movedGeometry(motions[i + 1], cut.geometry) }); });
  for (const piece of otherPieces(others, cuts)) out.push({ role: 'other', strip: piece.strip, source: piece.entity, part: piece.part, whole: piece.whole, geometry: movedGeometry(motions[piece.strip], piece.geometry) });
  // a curve through points is kept in single precision, so its ends lie a few millionths of a millimetre from where they were
  // meant to be: the straight lines that end there are brought to the curve's own ends, and the figure stays closed exactly
  for (const fitted of out.filter(line => line.fitted)) for (const [meant, actual] of fitted.ends) if (distance(meant, actual) > 1e-9) for (const line of out) if (line.geometry.points) line.geometry.points = line.geometry.points.map(q => distance(q, meant) < 1e-6 ? copy(actual) : q);
  return {
    lines: out, strips: motions.length, replaced: lines,
    cuts: cuts.map((cut, i) => ({ name: cut.name, fixedOpeningMm: distance(moved(motions[i], cut.near), moved(motions[i + 1], cut.near)), spreadOpeningMm: distance(moved(motions[i], cut.far), moved(motions[i + 1], cut.far)), lengthMm: distance(cut.near, cut.far), stripTurnedDeg: angleOf(motions[i + 1]), cutOffMm: cut.cutOffMm })),
    fixedLengthMm: fixed.total, spreadLengthMm: spread.total, curves: [...fixedSide.curves, ...spreadSide.curves],
    largestCurveChangeMm: Math.max(0, ...out.map(line => line.geometry.shapeChangeMm || 0)),
  };
}

// ---------------------------------------------------------------- 多边分割展开
/**
 * Spread a figure at its cut lines while both ends of the base line stay.
 *   lines     every line of the figure, the base line and the cut lines included
 *   baseIds   the base line: one line or several end to end
 *   cutIds    the cut lines, in the order they are to be opened; each starts on the base line
 *   amount    how far the far end of every cut opens, mm; amounts[cut line id] for one cut line
 */
export function spreadFromBase(lines, { baseIds, cutIds, amount = 0, amounts = {} }) {
  const byId = new Map(lines.map(e => [e.id, e])), pick = (ids, what) => (ids || []).map(id => { const e = byId.get(id); if (!e) throw new Error(what + '须在参与切展的线里面。'); return e; });
  for (const e of lines) if (!canSpread(e)) throw new Error('“' + (e && e.name) + '”不能参与切展。');
  const baseLines = pick(baseIds, '基线'), cutLines = pick(cutIds, '分割线');
  if (!cutLines.length) throw new Error('请给出分割线。');
  if (cutLines.some(e => baseLines.includes(e))) throw new Error('分割线不能同时是基线。');
  const base = chainOf(baseLines, '基线'), start = chainPoint(base, 0), end = chainPoint(base, base.total);
  const given = cutLines.map(line => {
    if (isClosed(line)) throw new Error('“' + line.name + '”是闭合的图形，不能作分割线。');
    const on = meeting(line, base, '基线'), total = pathLength(line), toEnd = total - on.lineAt >= on.lineAt, a = toEnd ? on.lineAt : 0, b = toEnd ? total : on.lineAt;
    if (!(b - a > 1e-6)) throw new Error('分割线“' + line.name + '”没有长度。');
    let geometry = partOf(line, a, b, total); if (!toEnd) geometry = backwards(geometry);
    const far = endsOfGeometry(geometry)[1], open = amounts[line.id] ?? amount;
    if (!(open > 0)) throw new Error('“' + line.name + '”的展开量须大于 0。');
    if (on.station < MEET || on.station > base.total - MEET) throw new Error('“' + line.name + '”落在了基线的端点上。');
    const step = Math.min(1, on.station / 2, (base.total - on.station) / 2), turn = cross(sub(far, on.point), sub(chainPoint(base, on.station + step), chainPoint(base, on.station - step)));
    if (!(Math.abs(turn) > 1e-9)) throw new Error('“' + line.name + '”顺着基线走，展不开。');
    return { name: line.name, source: line, at: on.station, near: on.point, far, geometry, path: asPath(geometry), amount: open, side: Math.sign(turn), cutOffMm: toEnd ? on.lineAt : total - on.lineAt };
  });
  const cuts = given.slice().sort((p, q) => p.at - q.at);
  for (let i = 1; i < cuts.length; i++) if (cuts[i].at - cuts[i - 1].at < MEET) throw new Error('“' + cuts[i - 1].name + '”和“' + cuts[i].name + '”在基线上碰在一起。');
  const motions = cuts.map(() => STAY).concat([STAY]), report = [];
  for (const cut of given) {   // in the order given
    const index = cuts.indexOf(cut), now = motions[index], near = moved(now, cut.near), far = moved(now, cut.far), before = distance(start, near), after = distance(end, near);
    if (!(before > 1e-6) || !(after > 1e-6)) throw new Error('“' + cut.name + '”离基线的端点太近。');
    const pair = angle => [turnAbout(start, -cut.side * angle * after / (before + after)), turnAbout(end, cut.side * angle * before / (before + after))], gap = angle => { const [first, second] = pair(angle); return distance(moved(first, far), moved(second, far)); };
    let lo = 0, hi = .01; while (gap(hi) < cut.amount && hi < 1.5) hi *= 2;
    if (gap(hi) < cut.amount) throw new Error('“' + cut.name + '”展不到 ' + cut.amount + ' mm。');
    for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (gap(mid) < cut.amount) lo = mid; else hi = mid; }
    const [first, second] = pair((lo + hi) / 2);
    for (let k = 0; k < motions.length; k++) motions[k] = then(motions[k], k <= index ? first : second);
    report.push({ name: cut.name, index });
  }
  const sides = new Set([...baseLines, ...cutLines]), others = lines.filter(e => !sides.has(e)), out = [];
  for (const piece of sidePieces(base, cuts.map(cut => cut.at))) out.push({ role: 'base', strip: piece.strip, source: piece.item.entity, geometry: movedGeometry(motions[piece.strip], pieceGeometry(piece)), whole: piece.b - piece.a >= piece.item.length - 1e-6 });
  cuts.forEach((cut, i) => { out.push({ role: 'cut', strip: i, source: cut.source, cut: i + 1, face: 'before', geometry: movedGeometry(motions[i], cut.geometry) }, { role: 'cut', strip: i + 1, source: cut.source, cut: i + 1, face: 'after', geometry: movedGeometry(motions[i + 1], cut.geometry) }); });
  for (const piece of otherPieces(others, cuts)) out.push({ role: 'other', strip: piece.strip, source: piece.entity, part: piece.part, whole: piece.whole, geometry: movedGeometry(motions[piece.strip], piece.geometry) });
  return {
    lines: out, strips: motions.length, replaced: lines, baseLengthMm: base.total,
    cuts: cuts.map((cut, i) => ({ name: cut.name, order: given.indexOf(cut) + 1, farOpeningMm: distance(moved(motions[i], cut.far), moved(motions[i + 1], cut.far)), baseGapMm: distance(moved(motions[i], cut.near), moved(motions[i + 1], cut.near)), lengthMm: distance(cut.near, cut.far), cutOffMm: cut.cutOffMm })),
    stripsTurnedDeg: motions.map(angleOf), baseEndsMovedMm: Math.max(distance(moved(motions[0], start), start), distance(moved(motions.at(-1), end), end)),
    largestCurveChangeMm: Math.max(0, ...out.map(line => line.geometry.shapeChangeMm || 0)),
  };
}
