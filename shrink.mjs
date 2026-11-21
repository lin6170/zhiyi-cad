/**
 * v76: shrinkage (缩水) as ET 2017 applies it with 缩水操作 (menu 33299, 纱向缩水).
 *
 * A piece is stretched along its grain line to length ÷ (1 − warp) and across the grain to length ÷ (1 − weft), about the middle
 * of the piece measured along and across the grain; the seam allowance keeps its widths. Found with a made-up probe in ET: 2 %
 * along made 200 mm 204.08 mm (200 ÷ 0.98, not 200 × 1.02); 1 % along and 3 % across made 100 × 200 mm 103.09 × 202.02 mm; every
 * point of a piece with a slanted grain moved along the grain only. (For that piece ET's fixed middle was 2 mm from the middle of
 * its extent along the grain: the shape is the same, the piece stands 2 mm elsewhere.)
 *
 * ET keeps a note on the piece, " 经:1.0%，纬:3.0%", that it writes as " 横:1.0%，纵:3.0%" after the file is saved and opened again
 * (horizontal and vertical); 裁片自带缩水 (34399) writes the note alone. Shrinking a piece that has a note first takes the old
 * shrinkage out: ET read a 横/纵 note in screen directions, so a piece with a vertical grain came out with warp and weft exchanged.
 * The page keeps the shrinkage it applied on the piece, with the direction of the grain at that time, and takes it out the same
 * way; a note from an ET file is taken out as ET would: 经/纬 along and across the grain, 横/纵 along x and y.
 *
 * Marks (buttons, buttonholes, drill holes) and texts are moved with the piece but keep their size; a notch keeps its place on its
 * line (the point it stood on is carried along and found again on the stretched line).
 */
import { refreshCurve } from './curves.mjs';
import { fitClampedSpline, nativeFitPoints } from './fit-spline.mjs';
import { pathMetrics, stationOnPath } from './path-metrics.mjs';
import { contoursForGroup } from './topology.mjs';

const norm = v => Math.hypot(v.x, v.y), unit = v => { const l = norm(v); return { x: v.x / l, y: v.y / l }; }, dot = (a, b) => a.x * b.x + a.y * b.y;
const SHRINK_LIMIT = 30;

/** The shrinkage a note of ET says: { warp, weft, axes: 'grain' } for 经/纬, { warp: horizontal, weft: vertical, axes: 'screen' } for 横/纵. */
export function parseShrinkNote(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const value = word => { const m = text.match(new RegExp(word + '\\s*[:：]\\s*(-?\\d+(?:\\.\\d+)?)\\s*%')); return m ? Number(m[1]) : null; };
  const warp = value('经'), weft = value('纬'), across = value('横'), down = value('纵');
  if (warp !== null || weft !== null) return { warp: warp ?? 0, weft: weft ?? 0, axes: 'grain' };
  if (across !== null || down !== null) return { warp: across ?? 0, weft: down ?? 0, axes: 'screen' };
  return null;
}
/** The note ET writes after 缩水操作. */
export const shrinkNoteText = ({ warp, weft }) => ' 经:' + warp.toFixed(1) + '%，纬:' + weft.toFixed(1) + '%';

/** The grain direction of a piece (a unit vector; straight up when it has no grain line). */
export function grainOf(project, group) {
  const ids = new Set(group.entityIds), line = project.entities.find(e => ids.has(e.id) && e.layer === 'grain' && e.points?.length >= 2);
  if (!line) return { x: 0, y: 1 };
  const d = { x: line.points.at(-1).x - line.points[0].x, y: line.points.at(-1).y - line.points[0].y };
  return norm(d) > 1e-9 ? unit(d) : { x: 0, y: 1 };
}
function outlinePoints(project, group) {
  const byId = new Map(project.entities.map(e => [e.id, e])), contour = contoursForGroup(group).find(c => c.role === 'primary-contour');
  return (contour?.entityIds || []).flatMap(id => byId.get(id)?.points || []);
}
/** A 2 x 2 matrix [[a, b], [c, d]] as { a, b, c, d }; p → (a·x + b·y, c·x + d·y). */
const along = (u, k) => ({ a: 1 + (k - 1) * u.x * u.x, b: (k - 1) * u.x * u.y, c: (k - 1) * u.x * u.y, d: 1 + (k - 1) * u.y * u.y });
const times = (m, n) => ({ a: m.a * n.a + m.b * n.c, b: m.a * n.b + m.b * n.d, c: m.c * n.a + m.d * n.c, d: m.c * n.b + m.d * n.d });
const apply = (m, v) => ({ x: m.a * v.x + m.b * v.y, y: m.c * v.x + m.d * v.y });
/** The stretch of a shrinkage { warp, weft, axes, grain }: along the first direction by 1 / (1 − warp), across by 1 / (1 − weft). */
function stretch(shrink, grain) {
  const u = shrink.axes === 'screen' ? { x: 1, y: 0 } : (shrink.grain || grain), v = { x: -u.y, y: u.x };
  return times(along(u, 1 / (1 - shrink.warp / 100)), along(v, 1 / (1 - shrink.weft / 100)));
}
const inverse = m => { const det = m.a * m.d - m.b * m.c; return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det }; };
/**
 * The shrinkage a piece has now: what the page applied; else, for a piece from an ET file, the two stretch factors ET keeps after
 * its note (along and across the grain: 1 / (1 − warp), 1 / (1 − weft); they stay in that order when ET rewrites the note as
 * 横/纵, so the page takes out exactly what was applied, where ET itself reads the 横/纵 text in screen directions); else the note.
 */
export function shrinkOf(group) {
  const a = group.attributes || {};
  if (a.shrink && Number.isFinite(a.shrink.warp) && Number.isFinite(a.shrink.weft)) return a.shrink;
  if (a.shrinkNote && Array.isArray(a.shrinkFactors) && a.shrinkFactors.length === 2 && a.shrinkFactors.every(v => Number.isFinite(v) && v > 0)) {
    const percent = f => Math.round((1 - 1 / f) * 1000) / 10;
    return { warp: percent(a.shrinkFactors[0]), weft: percent(a.shrinkFactors[1]), axes: 'grain' };
  }
  return parseShrinkNote(a.shrinkNote);
}
/** The linear map from the piece as cut back to its finished size, or null when it has no shrinkage. Lengths and angles measured
 * on points mapped by it are those of the finished garment. */
export function finishedMap(project, group) {
  const shrink = shrinkOf(group);
  if (!shrink || (!shrink.warp && !shrink.weft)) return null;
  return inverse(stretch(shrink, grainOf(project, group)));
}
export const mapPoint = (m, p) => apply(m, p);

function transformEntity(entity, f) {
  if (entity.curve) {
    const fit = nativeFitPoints(entity.curve);
    if (fit && fit.length >= 2) { const next = fitClampedSpline(fit.map(f)); entity.curve = { ...entity.curve, controlPoints: next.curve.controlPoints, knots: next.curve.knots }; }
    else entity.curve = { ...entity.curve, controlPoints: entity.curve.controlPoints.map(f) };
    refreshCurve(entity);
  } else entity.points = entity.points.map(f);
}
/** The distance along an entity of the point on it nearest to p. */
function distanceAlong(entity, p) {
  const pts = entity.points; let best = { d: Infinity, s: 0 }, s = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy), t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (L * L))) : 0;
    const d = Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y); if (d < best.d) best = { d, s: s + t * L }; s += L;
  }
  return { position: best.s, total: s };
}

/**
 * Give a piece a shrinkage of warp and weft percent (0 to 30): the old one, if any, is taken out first; 0 and 0 take it out.
 * Returns what changed. The seam allowances and notches are brought up to date by the usual sync afterwards.
 */
export function applyShrink(project, group, { warp, weft }) {
  for (const [label, value] of [['经向缩水', warp], ['纬向缩水', weft]]) if (!Number.isFinite(value) || value < 0 || value > SHRINK_LIMIT) throw new Error(label + '须在 0 至 ' + SHRINK_LIMIT + '% 之间。');
  const grain = grainOf(project, group), old = shrinkOf(group), outline = outlinePoints(project, group);
  if (outline.length < 3) throw new Error('裁片“' + group.name + '”没有完整的净样轮廓，不能加缩水。');
  const next = { warp, weft, axes: 'grain', grain };
  const linear = times(warp || weft ? stretch(next, grain) : { a: 1, b: 0, c: 0, d: 1 }, old && (old.warp || old.weft) ? inverse(stretch(old, grain)) : { a: 1, b: 0, c: 0, d: 1 });
  // the middle of the piece along and across the grain stays where it is
  const v = { x: -grain.y, y: grain.x }, us = outline.map(p => dot(p, grain)), vs = outline.map(p => dot(p, v));
  const mu = (Math.min(...us) + Math.max(...us)) / 2, mv = (Math.min(...vs) + Math.max(...vs)) / 2, centre = { x: grain.x * mu + v.x * mv, y: grain.y * mu + v.y * mv };
  const f = p => { const q = apply(linear, { x: p.x - centre.x, y: p.y - centre.y }); return { x: centre.x + q.x, y: centre.y + q.y }; };
  const ids = new Set(group.entityIds), members = project.entities.filter(e => ids.has(e.id));
  const sizeAlong = pts => { const a = pts.map(p => dot(p, grain)), b = pts.map(p => dot(p, v)); return { along: Math.max(...a) - Math.min(...a), across: Math.max(...b) - Math.min(...b) }; };
  const before = sizeAlong(outline);
  // where each notch stands now, as a point
  const notches = (project.notches || []).filter(n => ids.has(n.baseEntityId)).map(n => {
    const base = members.find(e => e.id === n.baseEntityId), metrics = pathMetrics(base), at = n.mode === 'ratio' ? metrics.total * n.position / 100 : n.mode === 'end' ? metrics.total - n.position : n.position;
    return { recipe: n, point: stationOnPath(metrics, Math.max(0, Math.min(metrics.total, at)), { pointOnly: true }).point };
  });
  const marks = new Map();
  for (const e of members) {
    if (e.derivedFrom || e.notchFrom) continue;
    if (e.mark) { const key = e.mark.id + ':' + e.mark.index; if (!marks.has(key)) marks.set(key, []); marks.get(key).push(e); continue; }
    if (e.type === 'text') { e.points = e.points.map(f); continue; }
    transformEntity(e, f);
  }
  // a mark moves with the piece and keeps its size: the middle of its cross (or bar) goes where the piece takes it
  for (const lines of marks.values()) {
    const bar = lines.find(e => !e.curve && e.points.length === 2 && (e.mark.part === '横' || e.mark.part === '线')) || lines.find(e => !e.curve && e.points.length === 2);
    const centre0 = bar ? { x: (bar.points[0].x + bar.points[1].x) / 2, y: (bar.points[0].y + bar.points[1].y) / 2 } : lines[0].points[0], moved = f(centre0), dx = moved.x - centre0.x, dy = moved.y - centre0.y;
    for (const e of lines) { if (e.curve) { e.curve = { ...e.curve, controlPoints: e.curve.controlPoints.map(p => ({ x: p.x + dx, y: p.y + dy })) }; refreshCurve(e); } else e.points = e.points.map(p => ({ x: p.x + dx, y: p.y + dy })); }
  }
  for (const { recipe, point } of notches) {
    const base = members.find(e => e.id === recipe.baseEntityId), found = distanceAlong(base, f(point));
    recipe.position = recipe.mode === 'ratio' ? found.position / found.total * 100 : recipe.mode === 'end' ? found.total - found.position : found.position;
    recipe.signature = null; recipe.status = 'stale';
  }
  for (const recipe of project.seamAllowances || []) if (recipe.baseEntityIds.some(id => ids.has(id))) { recipe.signature = null; recipe.status = 'stale'; }
  group.attributes = { ...(group.attributes || {}) };
  if (warp || weft) { group.attributes.shrink = next; group.attributes.shrinkNote = shrinkNoteText(next); }
  else { delete group.attributes.shrink; delete group.attributes.shrinkNote; }
  const after = sizeAlong(outlinePoints(project, group));
  return { name: group.name, warp, weft, before, after, replaced: old && (old.warp || old.weft) ? { warp: old.warp, weft: old.weft, axes: old.axes } : null };
}
