/** Serialized node references for the supplied PRJ layout.
 * Coordinate equality is deliberately separate from an explicit index reference.
 * The remaining curve trailer is preserved as an opaque range: it is not an
 * editable seam allowance or grading rule until its native behavior is verified.
 */
export function readPrjCurveReferences(input, parsed) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  const fail = message => { throw new Error('PRJ 曲线引用：' + message); };
  if (!bytes || bytes.length < 100 || bytes.length > 16 * 1024 * 1024) fail('原始字节范围无效。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadata = parsed?.metadata;
  if (!metadata || !Array.isArray(metadata.nodes) || !Array.isArray(parsed.entities)) fail('缺少原始节点或曲线信息。');
  const curves = parsed.entities.filter(entity => [2, 4].includes(entity.source?.recordKind))
    .slice().sort((a, b) => a.source.offset - b.source.offset);
  const sectionEnd = metadata.pieceSectionOffset - 4;
  if (!curves.length || curves.length !== metadata.declaredCurveCount ||
      !Number.isInteger(sectionEnd) || sectionEnd > bytes.length ||
      curves[0].source.offset !== metadata.firstCurveOffset) fail('曲线记录数量或边界不一致。');

  return curves.map((entity, index) => {
    const start = entity.source.offset, end = curves[index + 1]?.source.offset ?? sectionEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 4 ||
        end <= start || end > sectionEnd || start + 34 > end) fail('曲线记录越界或重叠。');
    const kind = view.getUint32(start + 10, true);
    if (kind !== entity.source.recordKind || view.getUint32(start, true) !== entity.source.sourceId ||
        view.getUint32(start + 14, true) !== 0) fail('曲线身份与原始记录不一致。');
    let cursor = start + (kind === 4 ? 41 : 34);
    const range = size => {
      if (!Number.isSafeInteger(size) || size < 0 || cursor + size > end) fail('曲线记录被截断。');
      const offset = cursor; cursor += size; return offset;
    };
    const word = () => view.getUint32(range(4), true);
    const vectorArray = count => {
      if (!Number.isInteger(count) || count < 2 || count > 1000) fail('曲线坐标数量异常。');
      const offset = range(count * 12), points = [];
      for (let n = 0; n < count; n++) {
        const at = offset + n * 12, x = view.getFloat32(at, true), y = view.getFloat32(at + 4, true);
        if (![x, y].every(v => Number.isFinite(v) && Math.abs(v) <= 100000) || view.getFloat32(at + 8, true) !== 0) fail('曲线坐标无效。');
        points.push({ x, y });
      }
      return { offset, count, points };
    };
    const fitPoints = vectorArray(kind === 4 ? word() : 2);
    let controlPoints = null, parameterArray = null;
    if (kind === 4) {
      controlPoints = vectorArray(word());
      if (controlPoints.count !== fitPoints.count + 2) fail('样条控制点数量不一致。');
      const countOffset = cursor, count = word();
      if (count > 10000) fail('样条附加数组数量异常。');
      parameterArray = { countOffset, count, offset: range(count * 4) };
    }
    const references = () => {
      const countOffset = cursor, count = word();
      if (count > 10000) fail('节点引用数量异常。');
      const offset = range(count * 4), indices = [];
      for (let n = 0; n < count; n++) {
        const value = view.getUint32(offset + n * 4, true);
        if (value < 1 || value > metadata.nodes.length) fail('节点引用索引超界。');
        indices.push(value);
      }
      return { countOffset, offset, indices };
    };
    const directReferences = references(), secondaryReferences = references();
    return { entity, index: index + 1, start, end,
      direct: directReferences.indices, secondary: secondaryReferences.indices,
      directReferences, secondaryReferences,
      geometry: { fitPoints, controlPoints, parameterArray }, tailOffset: cursor };
  });
}

/** Inverse edges are derived only from stored node indices, never proximity. */
export function indexPrjNodeReferences(records, nodeCount) {
  if (!Number.isInteger(nodeCount) || nodeCount < 0 || nodeCount > 100000) throw new Error('PRJ 节点数量无效。');
  const users = Array.from({ length: nodeCount }, () => []);
  for (const record of records) {
    for (const kind of ['direct', 'secondary']) record[kind].forEach((nodeIndex, ordinal) => {
      if (!Number.isInteger(nodeIndex) || nodeIndex < 1 || nodeIndex > nodeCount) throw new Error('PRJ 节点引用索引超界。');
      users[nodeIndex - 1].push({ curveIndex: record.index, entityId: record.entity.id, kind, ordinal });
    });
  }
  return users;
}
