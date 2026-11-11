import { parsePrj } from './prj-parser.mjs';
import { validateProject } from './geometry.mjs';
import {decodePrjStorage,encodedV5Signature} from './prj-storage.mjs';
import {insertV5Lines} from './prj-v5-line-insert.mjs';

const signature = [0x51, 0x7f, 1, 1, 0, 0, 0, 0x40];
const clone = value => JSON.parse(JSON.stringify(value));
const equalPoint = (a, b) => a.x === b.x && a.y === b.y;
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function copyBytes(input) {
  if (input instanceof Uint8Array) return new Uint8Array(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  throw new Error('新增直线回存需要原始 PRJ 字节。');
}
function joinBytes(parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function countBytes(count) {
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, count, true); return bytes;
}

// Native additions use three distinct 32-bit identities. Avoid every existing
// four-byte occurrence, including identities in records we do not yet decode.
function unusedIdentityRange(bytes, count, preferred) {
  if (!Number.isInteger(preferred) || preferred < 1 || preferred + count > 0xffffffff) throw new Error('新对象编号范围无效。');
  const used = new Set(), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 4 <= bytes.length; offset++) used.add(view.getUint32(offset, true));
  let start = preferred;
  for (let index = 0; index < count; index++) {
    if (used.has(start + index)) { start += index + 1; index = -1; }
    if (start + count > 0xffffffff) throw new Error('没有可用的新对象编号范围。');
  }
  return start;
}
function encodeLine(points, sourceId, ownerIndex, firstNodeIndex) {
  const nodes = new Uint8Array(68), curve = new Uint8Array(92);
  const nv = new DataView(nodes.buffer), cv = new DataView(curve.buffer);
  cv.setUint32(0, sourceId, true);
  curve.set([255, 255, 255], 4); curve.set([255, 255, 255], 22);
  cv.setUint32(10, 2, true); cv.setFloat32(25, 1, true);
  cv.setUint32(58, 2, true); cv.setFloat32(78, 1, true);
  for (let index = 0; index < 2; index++) {
    const offset = index * 34, point = points[index];
    nv.setUint32(offset, 6, true); nv.setUint32(offset + 4, sourceId + index + 1, true);
    nodes[offset + 10] = 255;
    nv.setFloat32(offset + 14, point.x, true); nv.setFloat32(offset + 18, point.y, true);
    nv.setUint32(offset + 26, ownerIndex, true);
    cv.setFloat32(34 + index * 12, point.x, true); cv.setFloat32(38 + index * 12, point.y, true);
    cv.setUint32(62 + index * 4, firstNodeIndex + index, true);
  }
  return { nodes, curve };
}

function insertLines(original, parsed, additions, identityStart) {
  const m = parsed.metadata, count = additions.length;
  const pointCountOffset = m.pointSectionOffset - 4;
  const curveCountOffset = m.firstCurveOffset - 4;
  const pieceCountOffset = m.pieceSectionOffset - 4;
  if (!(pointCountOffset >= 100 && pointCountOffset < curveCountOffset && curveCountOffset < pieceCountOffset) ||
      m.nodes.some(node => node.offset < m.pointSectionOffset || node.offset + 34 > curveCountOffset || node.ownerIndex > m.declaredCurveCount)) {
    throw new Error('节点、曲线和裁片的记录边界不支持新增直线。');
  }
  const sourceIdStart = unusedIdentityRange(original, count * 3, identityStart);
  const records = additions.map((line, index) => encodeLine(line.stored, sourceIdStart + index * 3, m.declaredCurveCount + index + 1, m.declaredPointCount + index * 2 + 1));
  const candidate = joinBytes([
    original.subarray(0, pointCountOffset), countBytes(m.declaredPointCount + count * 2),
    original.subarray(m.pointSectionOffset, curveCountOffset), ...records.map(r => r.nodes),
    countBytes(m.declaredCurveCount + count), original.subarray(m.firstCurveOffset, pieceCountOffset),
    ...records.map(r => r.curve), original.subarray(pieceCountOffset),
  ]);
  if (candidate.length > 16 * 1024 * 1024) throw new Error('新增线条后文件超过 16 MB。');

  // Offset-based UI identities move, but serialized ownership indices do not.
  // Compare the complete decoded result, including all old entities, text,
  // nodes, groups and reference lists, against those expected relocations.
  const shift = offset => offset + (offset >= curveCountOffset ? count * 68 : 0) + (offset >= pieceCountOffset ? count * 92 : 0);
  const idMap = new Map([...parsed.entities, ...parsed.groups].map(record => [record.id,
    record.id.replace(/^(prj-(?:text-|grain-|piece-)?)(\d+)/, (_, prefix, offset) => prefix + shift(Number(offset)))]));
  function relocate(value, key = '') {
    if (typeof value === 'string') return idMap.get(value) || value;
    if (typeof value === 'number' && (key === 'offset' || key === 'recordEnd' || key.endsWith('Offset'))) return shift(value);
    if (Array.isArray(value)) return value.map(item => relocate(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, item]) => [k, relocate(item, k)]));
    return value;
  }
  const expected = relocate(parsed), next = expected.metadata, newEntities = [];
  for (let index = 0; index < count; index++) {
    const sourceId = sourceIdStart + index * 3, curveIndex = m.declaredCurveCount + index + 1;
    const offset = pieceCountOffset + count * 68 + index * 92, points = clone(additions[index].stored);
    const entity = { id: `prj-${offset}-${sourceId}`, type: 'polyline', points, closed: false,
      name: `直线 ${curveIndex}`, layer: 'ET 导入', source: { format: 'ET PRJ', offset, sourceId, recordKind: 2,
        interpolation: 'line', controlPoints: null, color: [255,255,255], baseColor: [255,255,255], lineStyle: 0, flags: [0,0,0] } };
    newEntities.push(entity);
    for (let endpoint = 0; endpoint < 2; endpoint++) next.nodes.push({
      offset: curveCountOffset + index * 68 + endpoint * 34, recordType: 6, sourceId: sourceId + endpoint + 1,
      ...points[endpoint], ownerIndex: curveIndex, flags: [0,0,0],
    });
  }
  expected.entities.splice(m.declaredCurveCount, 0, ...newEntities);
  for (const key of ['declaredCurveCount','parsedCurveCount','lineCount','unownedCurveCount']) next[key] += count;
  for (const key of ['declaredPointCount','parsedPointCount']) next[key] += count * 2;
  next.lastCurveOffset = newEntities.at(-1).source.offset;
  next.unownedCurveIds.push(...newEntities.map(entity => entity.id));
  const reparsed = parsePrj(candidate, parsed.metadata.sourceFile);
  if (canonical(reparsed) !== canonical(expected)) throw new Error('新增直线后出现预期之外的解析变化，已拒绝导出。');
  return { candidate, sourceIdStart };
}

/** Append standalone straight lines; preserve original sections and unknown bytes. */
export function createPrjLineExportSession(input, filename = 'ET project.prj', { identityStart = Math.floor(Date.now() / 1000) } = {}) {
  const storedOriginal = copyBytes(input),v5=encodedV5Signature.every((b,i)=>storedOriginal[i]===b);
  if (!v5&&!signature.every((byte, index) => storedOriginal[index] === byte)) throw new Error('此 PRJ 布局尚不支持新增直线回存。');
  const original=v5?decodePrjStorage(storedOriginal):storedOriginal;
  const parsed = parsePrj(storedOriginal, filename);
  const baseline = clone(validateProject({ format: 'zhiyi-cad', version: 6, units: 'unknown', seamAllowances: [], notches: [], seamChecks: [], ...clone(parsed) }));
  const previews = new WeakMap();
  return Object.freeze({
    filename,
    preview(project) {
      const current = clone(project), expected = clone(baseline);
      if (!Array.isArray(current.entities) || current.entities.length <= expected.entities.length) throw new Error('没有新增的独立直线；本项不能修改或删除原有图元。');
      if (!Number.isInteger(current.version) || current.version < baseline.version || current.version > 10) throw new Error('工程版本不受支持。');
      expected.version = current.version;
      const added = current.entities.splice(expected.entities.length);
      if (added.length > 1000) throw new Error('一次最多新增 1000 条独立直线。');
      for (const entity of current.entities) if (entity.source?.modified === true) delete entity.source.modified;
      if (canonical(current) !== canonical(expected)) throw new Error('还包含原线、文字、裁片、单位或其他修改，不能只保存新增直线；请先保存工程。');
      const ids = new Set(expected.entities.map(entity => entity.id));
      const additions = added.map(entity => {
        const allowed = ['id','type','points','closed','name','layer','arrowEnd'];
        if (!entity || typeof entity.id !== 'string' || ids.has(entity.id) || entity.type !== 'polyline' || entity.closed !== false ||
            entity.layer !== 'outline' || typeof entity.name !== 'string' || (entity.arrowEnd !== undefined && entity.arrowEnd !== false) || Object.keys(entity).some(key => !allowed.includes(key)) ||
            !Array.isArray(entity.points) || entity.points.length !== 2) throw new Error('新增对象须为未编组的普通直线，曲线、折线、布纹及工艺对象尚不支持。');
        ids.add(entity.id);
        const requested = entity.points.map(point => {
          if (!point || Object.keys(point).sort().join(',') !== 'x,y' || ![point.x,point.y].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 100000)) throw new Error('新线坐标必须是 ±100000 范围内的有限数字。');
          return { ...point };
        });
        const stored = requested.map(point => ({ x: Math.fround(point.x), y: Math.fround(point.y) }));
        if (stored.some(point => Math.abs(point.x) >= 100000 || Math.abs(point.y) >= 100000) || equalPoint(...stored)) throw new Error('新线在 PRJ 坐标精度下会超界或变成零长度，已拒绝。');
        return { entityId: entity.id, name: entity.name, requested, stored,
          roundingError: Math.max(...stored.map((point, index) => Math.hypot(point.x - requested[index].x, point.y - requested[index].y))) };
      });
      const { candidate, sourceIdStart } = v5?insertV5Lines(original,parsed,additions,unusedIdentityRange(original,additions.length*3,identityStart)):insertLines(original, parsed, additions, identityStart);
      const plan = freeze({ operation: 'append_prj_standalone_lines', addedLines: additions.length, additions, sourceIdStart,
        originalByteLength: storedOriginal.length, byteLength: candidate.length, addedNodes: additions.length * 2,
        units: '原始单位（物理比例未确认）', nativeEtValidation: 'pending',
        checks: { reparsed: true, originalDecodedDataPreserved: true, originalSectionsRetained: true } });
      previews.set(plan, { snapshot: JSON.stringify(project), candidate });
      return plan;
    },
    export(project, plan) {
      const stored = previews.get(plan);
      if (!stored || stored.snapshot !== JSON.stringify(project)) throw new Error('工程在预览后已变化，请重新预览。');
      return stored.candidate.slice();
    },
  });
}
