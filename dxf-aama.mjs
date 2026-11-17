/**
 * Pieces as an AAMA DXF file, the form garment CAD systems and cutting rooms exchange, and back.
 *
 * The layout follows the files ET 2017 writes with "保存DXF文件" (system type 其它服装CAD系统): a first
 * line "999 / ANSI/AAMA", one BLOCK per piece named 款式.裁片.号型, and in it
 *   layer 1   the cut line, a closed POLYLINE (the seam line; the net line when there is no seam allowance)
 *   layer 14  the sew line (the net line), when the piece has a seam allowance
 *   layer 2   turn points (corners) and layer 3 curve points of both lines, each turn point followed by a "# n" text
 *   layer 4   notches: a POINT whose z is the notch depth in centimetres and whose angle (50) points into the piece
 *   layer 8   internal lines; layer 13 drill holes; layer 7 the grain line; layer 15 texts on the piece
 *   layer 1   six TEXT lines: Piece Name, Size, Annotation, Quantity, Material, Category
 * and in ENTITIES one INSERT per block (ET puts it at the middle of the piece and still means the block as drawn) and the
 * lines STYLE NAME, CREATION DATE, AUTHOR, SAMPLE SIZE, GRADE RULE TABLE, UNITS: METRIC. Lengths are millimetres.
 * Quantity is the number of pieces to cut: the piece count, doubled for a symmetric piece, as ET writes it. Reading it back, an even
 * quantity may be a symmetric pair or not; it is taken as that many single pieces (ET takes an even quantity as pairs).
 */
import { contoursForGroup, orientChain } from './topology.mjs';
import { pieceOutline } from './piece-info.mjs';
import { attributesOf, piecesToCut, MATERIAL_CODES, materialName } from './piece-attributes.mjs';
import { fitClampedSpline } from './fit-spline.mjs';
import { refreshCurve } from './curves.mjs';
import { nearestStation } from './construct.mjs';
import { findCommand } from './cad-command-set.mjs';
import { validateProject } from './geometry.mjs';
import { encodeGbk } from './prj-new-export.mjs';

const f = value => (Math.abs(value) < 5e-7 ? 0 : value).toFixed(6), near = (a, b, t = .02) => Math.hypot(a.x - b.x, a.y - b.y) <= t;
const area = points => { let sum = 0; for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; sum += a.x * b.y - b.x * a.y; } return sum / 2; };
const box = points => ({ minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)) });
/** Corners of a closed loop: where the direction turns by more than a few degrees. */
function cornersByAngle(points, degrees = 12) {
  const turns = [];
  for (let i = 0; i < points.length; i++) { const a = points[(i - 1 + points.length) % points.length], b = points[i], c = points[(i + 1) % points.length], u = { x: b.x - a.x, y: b.y - a.y }, v = { x: c.x - b.x, y: c.y - b.y }; if (Math.abs(Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y)) * 180 / Math.PI > degrees) turns.push(i); }
  return turns;
}
export function isAamaDxf(text) { return /^\s*999\s*\r?\n\s*ANSI\/AAMA/i.test(text) || (/\r?\n\s*BLOCKS\s*\r?\n/.test(text) && /Piece Name:/i.test(text)); }

// ---------------------------------------------------------------- writing
/** project: a millimetre drawing with pieces. Returns { text, report }; the text is to be saved in GBK, as ET does. */
export function toAamaDxf(project, { author = 'ZHIYI-CAD', now = new Date() } = {}) {
  if (project.units !== 'mm') throw new Error('只有毫米单位的工程才能导出裁片 DXF。');
  const byId = new Map(project.entities.map(e => [e.id, e])), style = String(project.name || '未命名纸样').replace(/[\r\n.]/g, ' ').slice(0, 60), size = 'F';
  const out = ['999', 'ANSI/AAMA', '0', 'SECTION', '2', 'BLOCKS'], inserts = [], report = { pieces: [], skipped: [] }; let serial = 0;
  const pair = (...items) => { for (let i = 0; i < items.length; i += 2) out.push(String(items[i]), String(items[i + 1])); };
  const polyline = (layer, points, closed) => { pair(0, 'POLYLINE', 8, layer, 66, 1, 70, closed ? 1 : 0); for (const p of points) pair(0, 'VERTEX', 8, layer, 10, f(p.x), 20, f(p.y)); pair(0, 'SEQEND', 8, layer); };
  const marks = (points, turns) => { points.forEach((p, i) => { if (turns.has(i)) { pair(0, 'POINT', 8, 2, 10, f(p.x), 20, f(p.y)); pair(0, 'TEXT', 8, 2, 10, f(p.x), 20, f(p.y), 40, f(0), 1, '# ' + (++serial)); } }); points.forEach((p, i) => { if (!turns.has(i)) pair(0, 'POINT', 8, 3, 10, f(p.x), 20, f(p.y)); }); };
  const notchPoints = list => { for (const n of list) { pair(0, 'POINT', 8, 4, 10, f(n.at.x), 20, f(n.at.y), 30, f(n.depthMm / 10), 50, (Math.round(n.angle * 100) / 100).toFixed(2)); pair(0, 'TEXT', 8, 4, 10, f(n.at.x), 20, f(n.at.y), 40, f(0), 50, f(0), 1, '# ' + (++serial)); } };
  for (const group of project.groups || []) {
    const contour = contoursForGroup(group).find(c => c.role === 'primary-contour'), edges = contour ? contour.entityIds.map(id => byId.get(id)).filter(Boolean) : [], net = pieceOutline(project, group);
    if (!net) { report.skipped.push({ name: group.name, reason: '轮廓不完整' }); continue; }
    // the corners of the net line are where its edges meet; a closed outline drawn as one polyline has a corner at every vertex
    const netTurns = new Set();
    if (edges.length === 1) net.forEach((p, i) => netTurns.add(i)); else for (const part of orientChain(edges)) { const index = net.findIndex(p => near(p, part.points[0], 1e-6)); if (index >= 0) netTurns.add(index); }
    const recipe = (project.seamAllowances || []).find(r => contour && r.baseEntityIds.length === contour.entityIds.length && r.baseEntityIds.every(id => contour.entityIds.includes(id)));
    const loops = recipe ? (recipe.outputIds || []).map(id => byId.get(id)).filter(e => e && e.closed && e.points.length >= 3 && e.seamRole !== 'extension') : [], cut = loops.length ? loops.reduce((a, b) => Math.abs(area(b.points)) > Math.abs(area(a.points)) ? b : a).points.map(p => ({ x: p.x, y: p.y })) : null;
    const members = group.entityIds.map(id => byId.get(id)).filter(Boolean), name = style + '.' + String(group.name).replace(/[\r\n.]/g, ' ') + '.' + size, cutAttributes = attributesOf(group);
    // notches of this piece: where each is cut, which way it points, and the matching place on the net line
    const notches = []; const contourIds = new Set(contour.entityIds);
    for (const line of project.entities) {
      if (!line.notchFrom || line.points.length < 2) continue;
      const made = (project.notches || []).find(n => n.id === line.notchFrom); if (!made || !contourIds.has(made.baseEntityId)) continue;
      const a = line.points[0], b = line.points.at(-1), depth = Math.hypot(b.x - a.x, b.y - a.y); if (!(depth > 0)) continue;
      const direction = { x: (b.x - a.x) / depth, y: (b.y - a.y) / depth }, angle = (Math.atan2(direction.y, direction.x) * 180 / Math.PI + 360) % 360;
      let onNet = a;
      if (cut && made.targetSeamId) { let best = null; for (let i = 0; i < net.length; i++) { const p = net[i], q = net[(i + 1) % net.length], d = { x: q.x - p.x, y: q.y - p.y }, den = direction.x * d.y - direction.y * d.x; if (Math.abs(den) < 1e-12) continue; const t = ((p.x - a.x) * d.y - (p.y - a.y) * d.x) / den, s = ((p.x - a.x) * direction.y - (p.y - a.y) * direction.x) / den; if (t > -1e-6 && s >= -1e-9 && s <= 1 + 1e-9 && (!best || t < best)) best = t; } if (best !== null) onNet = { x: a.x + direction.x * best, y: a.y + direction.y * best }; }
      notches.push({ at: a, onNet, angle, depthMm: depth, onCut: Boolean(cut && made.targetSeamId) });
    }
    pair(0, 'BLOCK', 8, 1, 2, name, 70, 0, 10, '0.0', 20, '0.0');
    const outer = cut || net, outerTurns = cut ? new Set(cornersByAngle(cut)) : netTurns;
    // ET writes every notch place as a vertex of the line it lies on (and lists it among the curve points); its reader looks for it there
    const withPlaces = (loop, turns, places) => {
      const list = loop.map((q, i) => ({ x: q.x, y: q.y, turn: turns.has(i) })), extra = [];
      for (const q of places) { let best = null; for (let i = 0; i < loop.length; i++) { const a = loop[i], z = loop[(i + 1) % loop.length], dx = z.x - a.x, dy = z.y - a.y, len = dx * dx + dy * dy; if (!len) continue; const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len)), d = Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy); if (!best || d < best.d) best = { d, i, t }; } if (best && best.d <= .05 && best.t > 1e-6 && best.t < 1 - 1e-6) extra.push({ i: best.i, t: best.t, q }); }
      extra.sort((x, y) => y.i - x.i || y.t - x.t);   // from the end, so that the places found stay valid
      for (const item of extra) list.splice(item.i + 1, 0, { x: item.q.x, y: item.q.y, turn: false });
      return { points: list.map(q => ({ x: q.x, y: q.y })), turns: new Set(list.map((q, i) => q.turn ? i : -1).filter(i => i >= 0)) };
    };
    const outerNotches = cut ? notches.filter(n => n.onCut) : notches.map(n => ({ ...n, at: n.onNet })), netNotches = notches.map(n => ({ ...n, at: n.onNet }));
    const outerLine = withPlaces(outer, outerTurns, outerNotches.map(n => n.at));
    polyline(1, outerLine.points, true); marks(outerLine.points, outerLine.turns); notchPoints(outerNotches);
    if (cut) { const netLine = withPlaces(net, netTurns, netNotches.map(n => n.at)); polyline(14, netLine.points, true); marks(netLine.points, netLine.turns); notchPoints(netNotches); }
    let internal = 0, drills = 0, texts = 0; const drilled = new Set();
    for (const member of members) {
      if (member.type === 'text') { if (member.pieceLabel) continue; pair(0, 'TEXT', 8, 15, 10, f(member.points[0].x), 20, f(member.points[0].y), 40, f(member.height), 50, f(member.rotation || 0), 1, String(member.text).replace(/[\r\n]/g, ' ')); texts++; continue; }
      if (contourIds.has(member.id) || member.derivedFrom || member.notchFrom || member.layer === 'grain') continue;
      if (member.mark?.kind === 'drill') { const key = member.mark.id + ':' + member.mark.index; if (member.mark.part === '圆' && !drilled.has(key)) { drilled.add(key); const b = box(member.points); pair(0, 'POINT', 8, 13, 10, f((b.minX + b.maxX) / 2), 20, f((b.minY + b.maxY) / 2)); drills++; } continue; }
      const loop = member.closed || (member.points.length > 2 && near(member.points[0], member.points.at(-1), 1e-6));
      polyline(8, loop && !member.closed ? member.points.slice(0, -1) : member.points, loop); internal++;
    }
    const grain = members.find(e => e.layer === 'grain' && e.type !== 'text' && e.points.length === 2);
    if (grain) pair(0, 'LINE', 8, 7, 10, f(grain.points[0].x), 20, f(grain.points[0].y), 11, f(grain.points[1].x), 21, f(grain.points[1].y));
    const b = box(net), centre = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, quantity = piecesToCut(cutAttributes), category = { 100: 0, 110: 1, 111: 2 }[cutAttributes.materialCode] ?? 0;
    ['Piece Name: ' + name, 'Size: ' + size, 'Annotation: ', 'Quantity: ' + quantity, 'Material: ' + cutAttributes.material, 'Category: ' + category].forEach((line, i) => pair(0, 'TEXT', 8, 1, 10, f(centre.x), 20, f(centre.y + 15 * Math.min(i, 4)), 40, f(10), 50, f(0), 1, line));
    pair(0, 'ENDBLK', 8, 1);
    inserts.push({ name, centre });
    report.pieces.push({ name: group.name, block: name, cutLinePoints: outer.length, sewLine: Boolean(cut), notches: notches.length, internalLines: internal, drillHoles: drills, texts, grain: Boolean(grain), quantity, material: cutAttributes.material });
  }
  if (!inserts.length) throw new Error('没有可以导出的裁片。裁片 DXF 只包含裁片；不属于裁片的线请用普通 DXF 导出。');
  pair(0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');
  for (const item of inserts) pair(0, 'INSERT', 8, 1, 2, item.name, 10, f(item.centre.x), 20, f(item.centre.y));
  const all = box(inserts.map(item => item.centre)), pad = n => String(n), stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()].map(pad).join('/');
  ['STYLE NAME: ' + style, 'CREATION DATE: ' + stamp, 'AUTHOR: ' + author, 'SAMPLE SIZE: ' + size, 'GRADE RULE TABLE: ' + style, 'UNITS: METRIC'].forEach((line, i) => pair(0, 'TEXT', 8, 1, 10, f(all.minX), 20, f(all.minY - 300 - 15 * i), 40, f(10), 50, f(0), 1, line));
  pair(0, 'ENDSEC', 0, 'EOF');
  report.looseEntitiesLeftOut = project.entities.filter(e => !(project.groups || []).some(g => g.entityIds.includes(e.id))).length;
  return { text: out.join('\r\n') + '\r\n', report };
}

/** The file as bytes in GBK, line by line: the encoding ET writes and reads. Throws when a name or a text has a character GBK lacks. */
export function aamaDxfBytes(text) {
  const bytes = [];
  for (const line of String(text).split('\r\n')) { for (const value of encodeGbk(line)) bytes.push(value); bytes.push(13, 10); }
  return Uint8Array.from(bytes.slice(0, -2));
}

// ---------------------------------------------------------------- reading
function readPairs(text) {
  const lines = String(text).split(/\r?\n/), entities = []; let current = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim(), value = lines[i + 1];
    if (code === '0') { current = { type: value.trim(), attrs: {} }; entities.push(current); }
    else if (current && !(code in current.attrs)) current.attrs[code] = value.trim();
  }
  return entities;
}
/** An AAMA DXF as an editable millimetre drawing. Returns { project, report }. */
export function fromAamaDxf(text, { makeId = () => crypto.randomUUID(), name = 'AAMA DXF' } = {}) {
  const entities = readPairs(text), blocks = new Map(), top = { inserts: [], texts: [] }; let block = null, poly = null;
  const num = value => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
  for (const e of entities) {
    const a = e.attrs, layer = a['8'] || '', target = block || top;
    if (e.type === 'BLOCK') { block = { name: a['2'] || '', polylines: [], points: [], lines: [], texts: [] }; blocks.set(block.name, block); poly = null; }
    else if (e.type === 'ENDBLK') { block = null; poly = null; }
    else if (e.type === 'POLYLINE' && block) { poly = { layer, closed: (num(a['70']) & 1) === 1, points: [] }; block.polylines.push(poly); }
    else if (e.type === 'VERTEX' && poly) poly.points.push({ x: num(a['10']), y: num(a['20']) });
    else if (e.type === 'SEQEND') poly = null;
    else if (e.type === 'POINT' && block) block.points.push({ layer, x: num(a['10']), y: num(a['20']), z: num(a['30']), angle: num(a['50']) });
    else if (e.type === 'LINE' && block) block.lines.push({ layer, a: { x: num(a['10']), y: num(a['20']) }, b: { x: num(a['11']), y: num(a['21']) } });
    else if (e.type === 'TEXT') target.texts.push({ layer, text: a['1'] || '', x: num(a['10']), y: num(a['20']), height: num(a['40']), angle: num(a['50']) });
    else if (e.type === 'INSERT' && !block) top.inserts.push({ name: a['2'] || '', x: num(a['10']), y: num(a['20']) });
  }
  if (!blocks.size) throw new Error('这份 DXF 里没有裁片块，不是裁片格式（AAMA）的 DXF。');
  const field = (texts, label) => { const found = texts.find(t => t.text.toLowerCase().startsWith(label.toLowerCase() + ':')); return found ? found.text.slice(label.length + 1).trim() : ''; };
  const units = field(top.texts, 'UNITS').toUpperCase(), scale = units === 'ENGLISH' ? 25.4 : 1, style = field(top.texts, 'STYLE NAME') || name;
  const project = { format: 'zhiyi-cad', version: 6, name: style, units: 'mm', entities: [], groups: [], seamAllowances: [] }, env = { makeId };
  const report = { units: units || 'METRIC（文件没有写，按毫米）', style, pieces: [], skipped: [], notches: 0, drillHoles: 0 };
  const run = (type, parameters) => findCommand(type).run(project, parameters, env);
  const add = entity => { const made = { id: makeId(), closed: false, layer: 'outline', type: 'polyline', ...entity }; project.entities.push(made); return made; };
  for (const [blockName, b] of blocks) {
    const insert = top.inserts.find(i => i.name === blockName), every = b.polylines.flatMap(p => p.points);
    if (!every.length) { report.skipped.push({ block: blockName, reason: '块里没有线' }); continue; }
    // ET puts the insertion point at the middle of the piece and still means the block as drawn; an insertion point outside the piece is a real shift
    const extent = box(every), inside = insert && insert.x >= extent.minX && insert.x <= extent.maxX && insert.y >= extent.minY && insert.y <= extent.maxY, shift = insert && !inside ? { x: insert.x, y: insert.y } : { x: 0, y: 0 };
    const place = p => ({ x: (p.x + shift.x) * scale, y: (p.y + shift.y) * scale });
    const sew = b.polylines.find(p => p.layer === '14' && p.closed && p.points.length >= 3), cut = b.polylines.find(p => p.layer === '1' && p.closed && p.points.length >= 3), outline = sew || cut;
    if (!outline) { report.skipped.push({ block: blockName, reason: '没有闭合的裁剪线或净线' }); continue; }
    // ET names a piece 款式.裁片.号型; the middle part is the name of the piece
    const written = field(b.texts, 'Piece Name') || blockName, parts = written.split('.'), pieceName = (parts.length >= 3 ? parts.slice(1, -1).join('.') : written) || blockName;
    let points = outline.points.map(place); if (points.length > 3 && near(points[0], points.at(-1), 1e-6)) points = points.slice(0, -1);
    // edges run from corner to corner: the corners are the turn points the file names, or else where the line turns
    const turnPoints = b.points.filter(p => p.layer === '2').map(place); let corners = points.map((p, i) => turnPoints.some(t => near(t, p)) ? i : -1).filter(i => i >= 0);
    if (corners.length < 2) corners = cornersByAngle(points, 20);
    const contourIds = []; let lines = 0, curves = 0;
    if (corners.length < 2) contourIds.push(add({ name: pieceName, closed: true, points }).id);
    else corners.forEach((start, k) => {
      const end = corners[(k + 1) % corners.length], run_ = []; for (let i = start; ; i = (i + 1) % points.length) { run_.push(points[i]); if (i === end && run_.length > 1) break; }
      const a = run_[0], z = run_.at(-1), chord = Math.hypot(z.x - a.x, z.y - a.y), off = Math.max(0, ...run_.map(p => chord > 0 ? Math.abs((z.x - a.x) * (a.y - p.y) - (a.x - p.x) * (z.y - a.y)) / chord : Math.hypot(p.x - a.x, p.y - a.y)));
      const edgeName = pieceName + ' · 边 ' + (k + 1);
      if (off <= .02 || run_.length === 2) { contourIds.push(add({ name: edgeName, points: [a, z] }).id); lines++; return; }
      let through = run_; if (through.length > 60) { const step = (through.length - 1) / 39; through = Array.from({ length: 40 }, (_, i) => run_[Math.round(i * step)]); }
      try { const fitted = fitClampedSpline(through); contourIds.push(refreshCurve(add({ name: edgeName, points: [], curve: fitted.curve })).id); curves++; }
      catch { contourIds.push(add({ name: edgeName, points: run_ }).id); lines++; }
    });
    const memberIds = [];
    if (sew && cut) memberIds.push(add({ name: pieceName + ' · 裁剪线', layer: 'internal', closed: true, points: cut.points.map(place), importedCutLine: true }).id);
    for (const p of b.polylines.filter(p => p.layer === '8' || p.layer === '11')) if (p.points.length >= 2) memberIds.push(add({ name: pieceName + ' · 内部线', layer: 'internal', closed: p.closed && p.points.length > 2, points: p.points.map(place) }).id);
    for (const t of b.texts.filter(t => t.layer === '15' && t.text)) memberIds.push(add({ name: t.text, type: 'text', text: t.text, layer: 'annotation', height: (t.height || 8) * scale, points: [place(t)], ...(t.angle ? { rotation: t.angle } : {}) }).id);
    const grainLine = b.lines.find(l => l.layer === '7'), created = run('piece.create', { name: pieceName, contourEntityIds: contourIds, ...(memberIds.length ? { memberEntityIds: memberIds } : {}), ...(grainLine ? { grain: { from: place(grainLine.a), to: place(grainLine.b) } } : {}) });
    const group = project.groups.find(g => g.id === created.created), quantity = Number(field(b.texts, 'Quantity')), material = field(b.texts, 'Material');
    group.source = { kind: 'aama-dxf-import', block: blockName };
    // the fabric is taken by its name when this program knows the name; ET's category number is not relied on (ET itself reads it back differently)
    const code = MATERIAL_CODES[material];
    group.attributes = { symmetric: false, count: Number.isInteger(quantity) && quantity >= 1 && quantity <= 99 ? quantity : 1, ...(code !== undefined ? { material: materialName(material, code), materialCode: code } : {}) };
    // A cut line beside the sew line is a seam allowance. Its width is measured on every edge, square to the edge at its middle;
    // when a seam allowance of those widths gives the cut line of the file, the piece gets that allowance instead of a loose line.
    let seamWidths = null;
    if (sew && cut && corners.length >= 2) {
      const cutPoints = cut.points.map(place), outside = area(points) > 0 ? 1 : -1, widths = [];
      const hit = (from, way) => { let best = null; for (let i = 0; i < cutPoints.length; i++) { const a = cutPoints[i], z = cutPoints[(i + 1) % cutPoints.length], d = { x: z.x - a.x, y: z.y - a.y }, den = way.x * d.y - way.y * d.x; if (Math.abs(den) < 1e-12) continue; const t = ((a.x - from.x) * d.y - (a.y - from.y) * d.x) / den, u = ((a.x - from.x) * way.y - (a.y - from.y) * way.x) / den; if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 && (best === null || t < best)) best = t; } return best; };
      for (const id of contourIds) {
        const entity = project.entities.find(e => e.id === id), list = entity.points, mid = Math.floor(list.length / 2), a = list.length === 2 ? list[0] : list[mid - 1], z = list.length === 2 ? list[1] : list[mid], span = Math.hypot(z.x - a.x, z.y - a.y);
        const width = span > 0 ? hit({ x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 }, { x: outside * (z.y - a.y) / span, y: -outside * (z.x - a.x) / span }) : null;
        widths.push(width === null ? null : Math.round(width * 100) / 100);
      }
      if (widths.every(w => w !== null && w >= 0 && w <= 300) && widths.some(w => w > 0)) {
        const counts = new Map(); for (const w of widths) counts.set(w, (counts.get(w) || 0) + 1);
        const usual = [...counts].sort((x, y) => y[1] - x[1])[0][0];
        try {
          run('seam.apply', { groupId: group.id, width: usual, overrides: contourIds.map((id, i) => ({ entityId: id, width: widths[i] })).filter(o => o.width !== usual) });
          const recipe = project.seamAllowances.at(-1), made = recipe.outputIds.map(id => project.entities.find(e => e.id === id)).filter(e => e && e.closed && e.seamRole !== 'extension').reduce((x, y) => !x || Math.abs(area(y.points)) > Math.abs(area(x.points)) ? y : x, null);
          const toLoop = (q, loop) => { let best = Infinity; for (let i = 0; i < loop.length; i++) { const a = loop[i], z = loop[(i + 1) % loop.length], dx = z.x - a.x, dy = z.y - a.y, len = dx * dx + dy * dy, t = len ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len)) : 0; best = Math.min(best, Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy)); } return best; };
          const apart = made ? Math.max(...made.points.map(q => toLoop(q, cutPoints)), ...cutPoints.map(q => toLoop(q, made.points))) : Infinity;
          if (apart <= .2) { seamWidths = [...new Set(widths)].sort((x, y) => x - y); const loose = project.entities.find(e => e.importedCutLine && group.entityIds.includes(e.id)); project.entities = project.entities.filter(e => e !== loose); group.entityIds = group.entityIds.filter(id => id !== loose.id); }
          else run('seam.remove', { groupId: group.id });
        } catch { if (project.seamAllowances.some(r => r.baseEntityIds.every(id => contourIds.includes(id)))) run('seam.remove', { groupId: group.id }); }
      }
    }
    // notches that lie on the outline taken; a drill hole becomes a drill mark
    let notched = 0, drilled = 0;
    for (const p of b.points.filter(p => p.layer === '4')) {
      const at = place(p); let best = null;
      for (const id of contourIds) { const entity = project.entities.find(e => e.id === id), found = nearestStation(entity, at); if (!best || found.away < best.found.away) best = { entity, found }; }
      if (!best || best.found.away > .05) continue;
      const inwards = { x: at.x + Math.cos(p.angle * Math.PI / 180), y: at.y + Math.sin(p.angle * Math.PI / 180) };
      try { run('notch.add', { entityId: best.entity.id, from: 'start', distance: Math.round(best.found.position * 1000) / 1000, ...(p.z > 0 ? { depth: Math.round(p.z * 10 * scale * 1000) / 1000 } : {}), toward: inwards }); notched++; } catch { /* a notch at a corner cannot be placed; it is counted as not carried */ }
    }
    for (const p of b.points.filter(p => p.layer === '13')) { try { run('mark.drill', { from: place(p) }); drilled++; } catch { /* outside the limits */ } }
    report.notches += notched; report.drillHoles += drilled;
    report.pieces.push({ name: pieceName, block: blockName, outlineFrom: sew ? '净线（14 层）' : '裁剪线（1 层）', edges: contourIds.length, lines, curves, cutLineKept: Boolean(sew && cut && !seamWidths), ...(seamWidths ? { seamWidthsMm: seamWidths } : {}), notches: notched, notchesInFile: b.points.filter(p => p.layer === '4').length, drillHoles: drilled, quantity: group.attributes.count, material: material || '' });
  }
  if (!project.groups.length) throw new Error('这份 DXF 里没有能读出的裁片。');
  project.metadata = { ...(project.metadata || {}), aamaImport: { style, units: report.units, pieces: report.pieces.length } };
  validateProject(project);
  return { project, report };
}
