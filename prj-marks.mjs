/**
 * ET's own marks in a 2.0 (08) file: rows of buttons and buttonholes, and drill holes (v55).
 * Learned from what ET 2017's own tools 扣子, 扣眼 and 打孔 wrote for a probe drawing, and checked on a real pattern.
 *
 *  - A drill hole is a point record (type 6) whose third flag byte is 5. No line owns it; a piece lists it among its points.
 *    ET's two ways of drilling (全切, 普通) write the same record, and the size of the hole is a setting of ET, not of the file.
 *  - A row of buttons or buttonholes is an object in the section after the texts: an identity, three flag bytes (the second is 0
 *    for buttons and 1 for buttonholes), the number of marks, their radius, for buttonholes how far the hole reaches past the
 *    row, the base line of the row as a curve through two points, and for every mark its place with its distance, its share and
 *    its curve parameter along the base line. The two ends of the base line are point records with flag byte 7, which the
 *    object names by number. A piece lists its rows in the last of its five reference lists.
 *  - ET draws a buttonhole across its row: from `offset` on the left of the row's direction to twice the radius on the right.
 *  - Point records with flag byte 6 lie on the line that owns them. What ET uses them for was not found out; they are counted.
 *
 * Reading gives file units (centimetres, y up). Pure functions, no DOM.
 */
const HOLE = 5, ON_LINE = 6, ROW_END = 7;

/** A buttonhole of ET (radius, offset past the row) as the page draws one: a bar of this length, moved along itself by this shift. */
export const holeFromEt = (radius, offset) => ({ length: 2 * radius + offset, shift: offset / 2 - radius });
/** The other way round; null when the bar does not reach the row's line, which ET's buttonhole always does. */
export function holeToEt(length, shift) {
  const offset = length / 2 + shift, radius = (length / 2 - shift) / 2;
  return offset >= -1e-9 && radius > 1e-9 ? { radius, offset: Math.max(0, offset) } : null;
}

/**
 * The marks of an opened ET file. `metadata` is what the parser collected (point records, the end of the texts); `groups` are
 * the parsed pieces. Rows that cannot be read are reported as not readable instead of being guessed at.
 */
export function readEtMarks(bytes, metadata, groups = []) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), nodes = metadata.nodes || [];
  const pieceWith = (list, index) => { const at = groups.findIndex(group => (group.source?.[list]?.indices || []).includes(index)); return at < 0 ? null : at; };
  const drills = [], linePoints = [];
  nodes.forEach((node, i) => {
    if (node.recordType !== 6) return;
    if (node.flags[2] === HOLE && !node.ownerIndex) drills.push({ node: i + 1, x: node.x, y: node.y, piece: pieceWith('ownedNodes', i + 1) });
    else if (node.flags[2] === ON_LINE) linePoints.push({ node: i + 1, x: node.x, y: node.y, owner: node.ownerIndex });
  });
  const result = { rows: [], drills, linePoints, readable: true, problem: '', declaredRows: 0 };
  let o = metadata.textSectionEndOffset;
  if (!Number.isInteger(o) || o < 0 || o + 4 > bytes.length) return result;   // nothing after the texts
  const need = n => { if (o + n > bytes.length) throw new Error('对象记录被截断'); };
  const u8 = () => { need(1); return bytes[o++]; }, u32 = () => { need(4); const v = view.getUint32(o, true); o += 4; return v; }, f32 = () => { need(4); const v = view.getFloat32(o, true); o += 4; return v; };
  const point = () => { const x = f32(), y = f32(), z = f32(); if (!Number.isFinite(x) || !Number.isFinite(y) || z !== 0) throw new Error('对象里的坐标无效'); return { x, y }; };
  try {
    const declared = u32(); result.declaredRows = declared; if (declared > 10000) throw new Error('对象数量无效');
    for (let i = 0; i < declared; i++) {
      const id = u32(); o += 3; const flags = [u8(), u8(), u8()], one = u8(), count = u32(), radius = f32(), offset = f32(), mark = u32(); u8();
      o += 3; u8(); if (u32() !== 0 || u32() !== 0) throw new Error('对象的基线结构不认识'); o += 3; if (f32() !== 1) throw new Error('对象的基线比例不是 1'); u32();
      const fitCount = u32(); if (fitCount < 2 || fitCount > 1000) throw new Error('对象的基线点数无效');
      const fit = Array.from({ length: fitCount }, point), controlCount = u32(); if (controlCount !== fitCount + 2) throw new Error('对象的基线控制点数无效');
      for (let k = 0; k < controlCount; k++) point();
      const parameterCount = u32(); if (parameterCount > 100000) throw new Error('对象的基线参数表无效'); need(parameterCount * 4); o += parameterCount * 4;
      const itemCount = u32(); if (itemCount > 1000) throw new Error('对象的个数无效');
      const items = Array.from({ length: itemCount }, () => ({ ...point(), along: f32(), share: f32(), parameter: f32() })), ends = [u32(), u32()];
      if (![0, 1].includes(flags[1]) || one !== 1 || itemCount !== count || !(radius > 0) || !(offset >= 0)) throw new Error('对象不是认识的扣子或扣眼');
      for (const end of ends) { const node = nodes[end - 1]; if (!node || node.recordType !== 6 || node.flags[2] !== ROW_END) throw new Error('对象的基线端点不是基线端点记录'); }
      result.rows.push({ id, kind: flags[1] === 1 ? 'buttonhole' : 'button', count, radius, offset, baseLine: [fit[0], fit.at(-1)], items, ends, piece: pieceWith('unattachedIndices', i + 1), flags, mark });
    }
  } catch (error) { result.rows = []; result.readable = false; result.problem = error.message; }
  return result;
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), norm = v => Math.hypot(v.x, v.y), mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
/**
 * The marks of an editable drawing that an ET file can hold as ET's own objects (millimetres): rows of buttons, rows of
 * buttonholes that lie across their row and reach its line, and drill holes. `entityIds` are the drawn lines of those marks,
 * which are then not written as lines. Everything else (bartacks, buttonholes along their row, incomplete marks) is left out
 * here and stays plain lines.
 */
export function planEtMarks(project) {
  const sets = new Map();
  for (const entity of project.entities) if (entity.mark && entity.type !== 'text') { if (!sets.has(entity.mark.id)) sets.set(entity.mark.id, []); sets.get(entity.mark.id).push(entity); }
  const rows = [], drills = [], entityIds = [], pieceOf = ids => { const owners = (project.groups || []).filter(group => ids.some(id => group.entityIds.includes(id))); return owners.length === 1 && ids.every(id => owners[0].entityIds.includes(id)) ? owners[0].id : null; };
  for (const [id, lines] of sets) {
    const kind = lines[0].mark.kind, byIndex = new Map();
    if (lines.some(line => line.mark.kind !== kind)) continue;
    for (const line of lines) { if (!byIndex.has(line.mark.index)) byIndex.set(line.mark.index, {}); byIndex.get(line.mark.index)[line.mark.part] = line; }
    const indices = [...byIndex.keys()].sort((a, b) => a - b), ids = lines.map(line => line.id), owners = (project.groups || []).filter(group => ids.some(id2 => group.entityIds.includes(id2)));
    if (owners.length > 1 || (owners.length === 1 && !ids.every(id2 => owners[0].entityIds.includes(id2)))) continue;   // a row torn between pieces stays lines
    const straight = line => line && !line.curve && line.points.length === 2 && norm(sub(line.points[1], line.points[0])) > 1e-9;
    if (kind === 'button' || kind === 'drill') {
      const parts = indices.map(index => byIndex.get(index));
      if (parts.some(p => !p['圆'] || !p['圆'].curve || !straight(p['横']) || !straight(p['竖']))) continue;
      const places = parts.map(p => mid(p['横'].points[0], p['横'].points[1])), first = parts[0]['横'], u = sub(first.points[1], first.points[0]), length = norm(u);
      if (kind === 'drill') { places.forEach(place => drills.push({ ...place, groupId: pieceOf(ids), setId: id })); entityIds.push(...ids); continue; }
      const size = lines[0].mark.sizeMm; if (!(size > 0)) continue;
      rows.push({ kind, setId: id, radius: size / 2, offset: 0, places, direction: { x: u.x / length, y: u.y / length }, groupId: pieceOf(ids) }); entityIds.push(...ids);
    } else if (kind === 'buttonhole') {
      const parts = indices.map(index => byIndex.get(index)), mark = lines[0].mark;
      if (mark.across === false || parts.some(p => !straight(p['线']))) continue;
      const bar = parts[0]['线'], v = sub(bar.points[1], bar.points[0]), length = norm(v), et = holeToEt(length, mark.shiftMm || 0);
      if (!et) continue;
      const along = { x: v.x / length, y: v.y / length }, places = parts.map(p => { const centre = mid(p['线'].points[0], p['线'].points[1]); return { x: centre.x - along.x * (mark.shiftMm || 0), y: centre.y - along.y * (mark.shiftMm || 0) }; });
      // ET counts the reach of a buttonhole on the left of the row's direction. A mirrored piece has it on the right: the row is then walked the other way.
      let direction = { x: along.y, y: -along.x }; const span = sub(places.at(-1), places[0]);
      if (places.length > 1 && span.x * direction.x + span.y * direction.y < 0) places.reverse();
      rows.push({ kind, setId: id, radius: et.radius, offset: et.offset, places, direction, groupId: pieceOf(ids) }); entityIds.push(...ids);
    }
  }
  // a row of several marks runs from its first place to its last: the two must not coincide
  const usable = rows.filter(row => row.places.length === 1 || norm(sub(row.places.at(-1), row.places[0])) > 1e-6), dropped = new Set(rows.filter(row => !usable.includes(row)).map(row => row.setId));
  return { rows: usable, drills, entityIds: entityIds.filter(id => { const entity = project.entities.find(e => e.id === id); return !dropped.has(entity.mark.id); }) };
}
