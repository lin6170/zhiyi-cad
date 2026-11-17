/**
 * Plotter output: a prepared plot (see plot.mjs) written as an HPGL file (.plt), the format
 * plotters and cutters read and ET opens with "打开PLT文件".
 *
 * One plotter unit is 0.025 mm, so 40 units are one millimetre. The whole pattern is written
 * at 1:1 as one sheet, with its lower left corner at the plotter's origin; curves are written
 * as short straight strokes that stay within 0.01 mm of the curve. Outlines and seam lines go
 * to pen 1, everything else (internal lines, grain lines, notches) to pen 2. Texts are left
 * out: plotters have no Chinese characters, and a text drawn as strokes belongs to a later step.
 */
export const HPGL_UNITS_PER_MM = 40;
const CHORD_TOLERANCE = .01;   // mm

const at = (controls, t) => { let points = controls; while (points.length > 1) points = points.slice(1).map((p, i) => ({ x: points[i].x + (p.x - points[i].x) * t, y: points[i].y + (p.y - points[i].y) * t })); return points[0]; };
/** A Bézier span as points: the number of strokes follows from how far its control points stray from the chord. */
export function flattenSpan(controls, tolerance = CHORD_TOLERANCE) {
  const a = controls[0], b = controls.at(-1), chord = Math.hypot(b.x - a.x, b.y - a.y);
  let stray = 0;
  for (const p of controls.slice(1, -1)) stray = Math.max(stray, chord > 1e-12 ? Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / chord : Math.hypot(p.x - a.x, p.y - a.y));
  // the largest distance between a curve and its chord shrinks with the square of the number of pieces
  const count = Math.max(1, Math.min(2000, Math.ceil(Math.sqrt(stray / tolerance) * 1.1)));
  const points = []; for (let i = 0; i <= count; i++) points.push(at(controls, i / count));
  return points;
}
function strokes(graphic) {
  let points;
  if (graphic.spans) { points = []; for (const span of graphic.spans) { const part = flattenSpan(span); points.push(...(points.length ? part.slice(1) : part)); } }
  else points = graphic.points.map(p => ({ x: p.x, y: p.y }));
  if (graphic.closed && points.length > 2 && Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y) > 1e-9) points.push({ ...points[0] });
  return [points, ...(graphic.arrows || []).map(arrow => arrow.map(p => ({ x: p.x, y: p.y })))];
}

/** plot: the result of preparePlot. Returns the file text and what was written. */
export function plotHpgl(plot) {
  const box = plot.box, unit = value => Math.round(value * HPGL_UNITS_PER_MM), x = p => unit(p.x - box.minX), y = p => unit(p.y - box.minY);
  const pens = { 1: [], 2: [] }; let texts = 0, lines = 0, points = 0;
  for (const graphic of plot.graphics) {
    if (graphic.type === 'text') { texts++; continue; }
    const pen = ['outline', 'seam'].includes(graphic.layer) ? 1 : 2;
    for (const path of strokes(graphic)) {
      // consecutive points that fall on the same plotter unit are written once
      const steps = []; for (const p of path) { const q = [x(p), y(p)]; if (!steps.length || steps.at(-1)[0] !== q[0] || steps.at(-1)[1] !== q[1]) steps.push(q); }
      if (steps.length < 2) continue;
      pens[pen].push('PU' + steps[0].join(',') + ';PD' + steps.slice(1).map(q => q.join(',')).join(',') + ';'); lines++; points += steps.length;
    }
  }
  if (!lines) throw new Error('没有可以输出的线条。');
  const parts = ['IN;'];
  for (const pen of [1, 2]) if (pens[pen].length) parts.push('SP' + pen + ';', ...pens[pen]);
  parts.push('PU0,0;', 'SP0;');
  return { text: parts.join('\n') + '\n', lines, points, textsLeftOut: texts, widthMm: box.width, heightMm: box.height, unitsPerMm: HPGL_UNITS_PER_MM };
}

/** Read the pen strokes of an HPGL file back as polylines in millimetres (IN, SP, PU, PD, PA only). For checks. */
export function readHpgl(text) {
  const paths = []; let pen = 0, down = false, current = null, position = { x: 0, y: 0 };
  for (const raw of String(text).split(';')) {
    const command = raw.trim(); if (!command) continue;
    const code = command.slice(0, 2).toUpperCase(), numbers = command.slice(2).split(',').map(s => s.trim()).filter(Boolean).map(Number);
    if (numbers.some(n => !Number.isFinite(n)) || (['PU', 'PD', 'PA'].includes(code) && numbers.length % 2)) throw new Error('HPGL 命令无法读取：' + command.slice(0, 40));
    if (code === 'IN') { pen = 0; down = false; current = null; }
    else if (code === 'SP') pen = numbers[0] || 0;
    else if (code === 'PU' || code === 'PD' || code === 'PA') {
      if (code !== 'PA') { if (code === 'PD' && !down) { current = { pen, points: [{ ...position }] }; paths.push(current); } if (code === 'PU') current = null; down = code === 'PD'; }
      for (let i = 0; i < numbers.length; i += 2) { position = { x: numbers[i] / HPGL_UNITS_PER_MM, y: numbers[i + 1] / HPGL_UNITS_PER_MM }; if (down && current) current.points.push({ ...position }); }
    } else throw new Error('不认识的 HPGL 命令：' + code);
  }
  return paths.filter(path => path.points.length > 1);
}
