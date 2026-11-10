/** Decode ET piece ownership from serialized index arrays, without spatial assignment. */
export function parsePrjGroups(input, parsed) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 100 || bytes.length > 16 * 1024 * 1024) throw new Error('PRJ 文件大小不受支持。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const curves = parsed.entities.filter(entity => entity.source?.recordKind === 2 || entity.source?.recordKind === 4)
    .slice().sort((a, b) => a.source.offset - b.source.offset);
  const texts = parsed.entities.filter(entity => entity.type === 'text')
    .slice().sort((a, b) => a.source.offset - b.source.offset);
  const pieces = parsed.metadata.pieces;
  const nodes = parsed.metadata.nodes;
  if (curves.length !== parsed.metadata.declaredCurveCount || texts.length !== parsed.metadata.declaredTextCount) {
    throw new Error('PRJ 裁片引用所需的几何和文字记录数量不一致。');
  }
  const u32 = offset => view.getUint32(offset, true);
  const ownership = new Map();
  const groups = [];
  for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex++) {
    const piece = pieces[pieceIndex];
    const recordEnd = pieceIndex + 1 < pieces.length ? pieces[pieceIndex + 1].offset : parsed.metadata.textSectionOffset - 4;
    if (recordEnd > bytes.length || piece.vectorOffset + 62 > recordEnd) throw new Error('PRJ 裁片引用范围越界。');
    let cursor = piece.vectorOffset + 58;
    function word() {
      if (cursor + 4 > recordEnd) throw new Error(`裁片 ${piece.name} 的引用数据被截断。`);
      const value = u32(cursor);
      cursor += 4;
      return value;
    }
    function references(maximum, label) {
      const countOffset = cursor;
      const count = word();
      if (count > 10000 || cursor + count * 4 > recordEnd) throw new Error(`裁片 ${piece.name} 的${label}数量异常。`);
      const indices = [];
      for (let index = 0; index < count; index++) {
        const value = word();
        if (value < 1 || value > maximum) throw new Error(`裁片 ${piece.name} 的${label}索引越界。`);
        indices.push(value);
      }
      return { countOffset, indices };
    }
    const chainCount = word();
    if (chainCount < 1 || chainCount > 1000) throw new Error(`裁片 ${piece.name} 的轮廓组数异常。`);
    const chains = [];
    for (let chainIndex = 0; chainIndex < chainCount; chainIndex++) {
      if (cursor + 2 > recordEnd) throw new Error('裁片轮廓标志被截断。');
      const flags = Array.from(bytes.subarray(cursor, cursor + 2));
      cursor += 2;
      const list = references(curves.length, '轮廓曲线');
      const serializedPieceIndex = word();
      if (serializedPieceIndex !== pieceIndex + 1) throw new Error(`裁片 ${piece.name} 的轮廓归属编号不一致。`);
      let maxAdjacentEndpointGap = null;
      if (list.indices.length > 1) {
        maxAdjacentEndpointGap = 0;
        for (let index = 0; index < list.indices.length; index++) {
          const left = curves[list.indices[index] - 1];
          const right = curves[list.indices[(index + 1) % list.indices.length] - 1];
          const leftPoints = left.source.fitPoints || left.points;
          const rightPoints = right.source.fitPoints || right.points;
          const distances = [leftPoints[0], leftPoints[leftPoints.length - 1]].flatMap(a =>
            [rightPoints[0], rightPoints[rightPoints.length - 1]].map(b => Math.hypot(a.x - b.x, a.y - b.y)));
          maxAdjacentEndpointGap = Math.max(maxAdjacentEndpointGap, Math.min(...distances));
        }
      }
      chains.push({ ...list, flags, pieceIndex: serializedPieceIndex,
        entityIds: list.indices.map(index => curves[index - 1].id),
        role: chainIndex === 0 ? 'primary-contour' : 'additional-chain',
        maxAdjacentEndpointGap,
      });
    }
    const ownedCurves = references(curves.length, '所属曲线');
    const ownedNodes = references(nodes.length, '所属点');
    // The following list has a separate numbering domain whose object semantics
    // remain unverified. Preserve it, rather than interpreting it as curve indices.
    const auxiliaryIndices = references(100000, '辅助对象');
    const ownedTexts = references(texts.length, '所属文字');
    const unattachedIndices = references(100000, '独立对象');
    if (cursor + 112 !== recordEnd) throw new Error(`裁片 ${piece.name} 的记录边界不符合已验证结构。`);
    // Both supplied samples have the same 112-byte identity transform trailer.
    // Reject other transforms until their geometric semantics are implemented.
    for (let block = 0; block < 2; block++) {
      const start = cursor + block * 56;
      for (let component = 0; component < 13; component++) {
        const expected = component % 4 === 0 ? 1 : 0;
        if (view.getFloat32(start + component * 4, true) !== expected) throw new Error('此裁片包含尚未支持的变换记录。');
      }
      if (u32(start + 52) !== 0x01000000) throw new Error('此裁片的变换记录尾部尚未支持。');
    }
    const ownedSet = new Set(ownedCurves.indices);
    if (ownedSet.size !== ownedCurves.indices.length || chains.some(chain => chain.indices.some(index => !ownedSet.has(index)))) {
      throw new Error(`裁片 ${piece.name} 的曲线引用集合不一致。`);
    }
    for (const index of ownedNodes.indices) {
      const owner = nodes[index - 1].ownerIndex;
      if (owner !== 0 && !ownedSet.has(owner)) throw new Error(`裁片 ${piece.name} 的点与曲线归属不一致。`);
    }
    const groupId = `prj-piece-${piece.offset}`;
    const curveIds = ownedCurves.indices.map(index => curves[index - 1].id);
    const textIds = ownedTexts.indices.map(index => texts[index - 1].id);
    const grainId = `prj-grain-${piece.offset}`;
    const entityIds = [...curveIds, ...textIds, grainId];
    if (!parsed.entities.some(entity => entity.id === grainId)) throw new Error(`裁片 ${piece.name} 缺少对应布纹实体。`);
    for (const id of entityIds) {
      if (ownership.has(id)) throw new Error(`实体 ${id} 被多份裁片引用，当前版本无法独立分组。`);
      ownership.set(id, groupId);
    }
    groups.push({
      id: groupId, name: piece.name, entityIds,
      contours: chains.map(chain => ({ role: chain.role, entityIds: [...chain.entityIds] })),
      source: { format: 'ET PRJ', offset: piece.offset, sourceId: piece.sourceId,
        pieceIndex: pieceIndex + 1, recordEnd, transformOffset: cursor,
        curveIds, textIds, grainId, contourChains: chains,
        material: piece.material, size: piece.size, symmetry: piece.symmetry,
        ownedCurves, ownedNodes, auxiliaryIndices, ownedTexts, unattachedIndices,
        interpretation: 'serialized-piece-ownership-index-arrays',
      },
    });
  }
  const unownedCurveIds = curves.filter(entity => !ownership.has(entity.id)).map(entity => entity.id);
  return {
    groups,
    metadata: { decodedPieceCount: groups.length,
      ownedCurveCount: curves.length - unownedCurveIds.length,
      unownedCurveCount: unownedCurveIds.length, unownedCurveIds,
      associatedTextCount: groups.reduce((count, group) => count + group.source.textIds.length, 0),
    },
    warnings: ['裁片归属直接读取自 PRJ 引用表。轮廓链保留原始顺序与标志，额外链的业务含义仍需核对。'],
  };
}
