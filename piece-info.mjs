/**
 * Facts about a piece: its outline as one loop, area, perimeter and size. Read only.
 * The area is taken on the outline as drawn (curves as their displayed points, which stay
 * within a few thousandths of a millimetre of the curve); the perimeter is the exact length.
 */
import { contoursForGroup, orientChain } from './topology.mjs';
import { bounds } from './geometry.mjs';
import { lengthOf } from './measure.mjs';
import { attributesOf, piecesToCut } from './piece-attributes.mjs';

const round = (value, digits = 3) => { const f = 10 ** digits; return Math.round(value * f) / f; };
/** Signed area of a closed loop of points, positive when it runs anticlockwise. */
export function loopArea(points) { let sum = 0; for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; sum += a.x * b.y - b.x * a.y; } return sum / 2; }

/** The net outline of a piece as one closed loop of points, in the order of its edges. Null when the piece has no usable outline. */
export function pieceOutline(project, group) {
  const contour = contoursForGroup(group).find(c => c.role === 'primary-contour'); if (!contour) return null;
  const byId = new Map(project.entities.map(e => [e.id, e])), edges = contour.entityIds.map(id => byId.get(id)).filter(Boolean);
  if (!edges.length || edges.length !== contour.entityIds.length) return null;
  if (edges.length === 1) return edges[0].closed && edges[0].points.length >= 3 ? edges[0].points.map(p => ({ x: p.x, y: p.y })) : null;
  const loop = [];
  for (const part of orientChain(edges)) for (const p of part.points) { const last = loop.at(-1); if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-7) loop.push({ x: p.x, y: p.y }); }
  if (loop.length > 1 && Math.hypot(loop[0].x - loop.at(-1).x, loop[0].y - loop.at(-1).y) <= 1e-7) loop.pop();
  return loop.length >= 3 ? loop : null;
}

/** The seam allowance recipe of a piece, if it has one on its net outline. */
function seamOf(project, group) {
  const contour = contoursForGroup(group).find(c => c.role === 'primary-contour');
  return contour ? (project.seamAllowances || []).find(r => r.baseEntityIds.length === contour.entityIds.length && r.baseEntityIds.every(id => contour.entityIds.includes(id))) || null : null;
}

/** Everything of a piece except its texts, for its extent on the canvas. */
export function pieceExtent(project, group) {
  const ids = new Set(group.entityIds), members = project.entities.filter(e => ids.has(e.id) && e.type !== 'text');
  return members.length ? bounds(members) : null;
}

/** Name, sizes and counts of one piece. Areas in square millimetres, lengths in millimetres. */
export function pieceInfo(project, group) {
  const ids = new Set(group.entityIds), members = project.entities.filter(e => ids.has(e.id)), outline = pieceOutline(project, group), recipe = seamOf(project, group);
  const contourIds = contoursForGroup(group).find(c => c.role === 'primary-contour')?.entityIds || [], contour = contourIds.map(id => members.find(e => e.id === id)).filter(Boolean);
  const net = outline ? bounds([{ points: outline }]) : null;
  const cut = attributesOf(group);
  const info = { id: group.id, name: group.name, locked: Boolean(group.locked), material: cut.material, count: cut.count, symmetric: cut.symmetric, cutPieces: piecesToCut(cut), areaMm2: outline ? round(Math.abs(loopArea(outline)), 2) : null, perimeterMm: contour.length ? round(contour.reduce((sum, e) => sum + lengthOf(e), 0)) : null,
    widthMm: net ? round(net.maxX - net.minX) : null, heightMm: net ? round(net.maxY - net.minY) : null, edges: contour.length,
    internalLines: members.filter(e => e.type !== 'text' && !e.derivedFrom && !e.notchFrom && !e.mark && !contourIds.includes(e.id) && e.layer !== 'grain').length, marks: new Set(members.filter(e => e.mark).map(e => e.mark.id + ':' + e.mark.index)).size, texts: members.filter(e => e.type === 'text').length,
    notches: (project.notches || []).filter(n => ids.has(n.baseEntityId)).reduce((sum, n) => sum + (n.count || 1), 0), seamWidthsMm: null, cutAreaMm2: null };
  if (recipe) {
    info.seamWidthsMm = recipe.widthMode === 'edges' ? [...new Set(recipe.edgeWidths.map(w => w.width))].sort((a, b) => a - b) : [Math.abs(recipe.distance)];
    // the cut outline is the largest closed loop the seam allowance produced
    const loops = (recipe.outputIds || []).map(id => project.entities.find(e => e.id === id)).filter(e => e && e.closed && e.points.length >= 3 && e.seamRole !== 'extension').map(e => Math.abs(loopArea(e.points)));
    if (loops.length) info.cutAreaMm2 = round(Math.max(...loops), 2);
  }
  return info;
}

/** All pieces, in the order they were made, with totals. */
export function pieceList(project) {
  const pieces = (project.groups || []).map(group => pieceInfo(project, group)), sum = key => round(pieces.reduce((total, piece) => total + (piece[key] || 0), 0), 2);
  return { pieces, totals: { count: pieces.length, cutCount: pieces.reduce((total, piece) => total + piece.cutPieces, 0), fabricAreaMm2: round(pieces.reduce((total, piece) => total + (piece.cutAreaMm2 ?? piece.areaMm2 ?? 0) * piece.cutPieces, 0), 2), areaMm2: sum('areaMm2'), cutAreaMm2: round(pieces.reduce((total, piece) => total + (piece.cutAreaMm2 ?? piece.areaMm2 ?? 0), 0), 2), perimeterMm: sum('perimeterMm') } };
}

/** The piece list as a table for a spreadsheet (CSV with a byte order mark, so that Excel reads the Chinese headings). */
export function pieceListCsv(project) {
  const { pieces, totals } = pieceList(project), cm = value => value === null ? '' : String(Math.round(value) / 10), cm2 = value => value === null ? '' : String(Math.round(value) / 100);
  const cell = value => { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text; };
  const rows = [['序号', '裁片名称', '布料', '片数', '实裁片数', '净样面积(cm²)', '毛样面积(cm²)', '净样周长(cm)', '宽(cm)', '高(cm)', '缝份(cm)', '刀口数', '内部线', '扣位打孔', '文字', '锁定']];
  pieces.forEach((p, index) => rows.push([index + 1, p.name, p.material, p.count + (p.symmetric ? '（对称）' : ''), p.cutPieces, cm2(p.areaMm2), cm2(p.cutAreaMm2), cm(p.perimeterMm), cm(p.widthMm), cm(p.heightMm), p.seamWidthsMm ? p.seamWidthsMm.map(w => w / 10).join(' / ') : '', p.notches, p.internalLines, p.marks, p.texts, p.locked ? '是' : '']));
  rows.push(['合计', totals.count + ' 种', '', '', totals.cutCount + ' 片', cm2(totals.areaMm2), cm2(totals.cutAreaMm2), cm(totals.perimeterMm), '', '', '', '', '', '', '', '']);
  return '﻿' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
