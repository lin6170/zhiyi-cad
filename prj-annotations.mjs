/** Annotation records decoded from ET PRJ bytes, independently of any screenshots. */
export function parsePrjAnnotations(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 100 || bytes.length > 16 * 1024 * 1024) throw new Error('PRJ 文件大小不受支持。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = offset => view.getUint32(offset, true);
  const u16 = offset => view.getUint16(offset, true);
  const f32 = offset => view.getFloat32(offset, true);
  const decoder = new TextDecoder('gb18030', { fatal: true });
  const finite = values => values.every(value => Number.isFinite(value) && Math.abs(value) < 100000);
  const zeroRange = (offset, length) => bytes.subarray(offset, offset + length).every(value => value === 0);

  function textRecord(offset) {
    if (offset + 73 > bytes.length || u32(offset + 4) !== 0 || f32(offset + 11) !== 1 || u32(offset + 15) !== 0) return null;
    if (u32(offset + 20) !== 1 || u32(offset + 25) !== 1 || u32(offset + 53) !== 0) return null;
    const x = f32(offset + 29), y = f32(offset + 33);
    const cosine = f32(offset + 37), sine = f32(offset + 41);
    const width = f32(offset + 45), height = f32(offset + 49);
    const length = u16(offset + 57);
    if (!finite([x, y, cosine, sine, width, height]) || Math.abs(cosine * cosine + sine * sine - 1) > 0.05) return null;
    if (width <= 0 || height <= 0 || height > 1000 || length < 1 || length > 4096 || offset + 73 + length > bytes.length) return null;
    if (!zeroRange(offset + 67 + length, 6)) return null;
    let text;
    try { text = decoder.decode(bytes.subarray(offset + 59, offset + 59 + length)); } catch { return null; }
    if ([...text].some(character => character.codePointAt(0) < 32 && !'\r\n\t'.includes(character))) return null;
    return {
      next: offset + 73 + length,
      entity: {
        id: `prj-text-${offset}`, type: 'text', points: [{ x, y }], text, name: text,
        layer: 'annotation', width, height, verticalAlign: 'middle', rotation: Math.atan2(sine, cosine) * 180 / Math.PI,
        source: { format: 'ET PRJ', offset, textOffset: offset + 59, textByteLength: length,
          sourceId: u32(offset), originalText: text, color: Array.from(bytes.subarray(offset + 8, offset + 11)),
          cosine, sine, flags: bytes[offset + 19],
          secondaryAnchor: { x: f32(offset + 59 + length), y: f32(offset + 63 + length) },
        },
      },
    };
  }

  let textSection = null;
  for (let offset = 100; offset + 73 < bytes.length; offset++) {
    if (!textRecord(offset)) continue;
    const count = u32(offset - 4);
    if (count < 1 || count > 10000) continue;
    const texts = [];
    let cursor = offset;
    for (let index = 0; index < count; index++) {
      const result = textRecord(cursor);
      if (!result) break;
      texts.push(result.entity);
      cursor = result.next;
    }
    if (texts.length === count && !textRecord(cursor)) {
      textSection = { offset, endOffset: cursor, count, texts };
      break;
    }
  }
  if (!textSection) throw new Error('PRJ 文本记录数量或结构校验未通过。');

  function pieceRecord(offset) {
    if (offset + 160 > textSection.offset || bytes[offset + 7] !== 0x20 || !zeroRange(offset + 8, 13)) return null;
    if (u32(offset + 21) !== 1 || u32(offset + 25) !== u32(offset + 32)) return null;
    let cursor = offset + 36;
    function string() {
      if (cursor + 2 > bytes.length) throw new Error('truncated string');
      const length = u16(cursor);
      cursor += 2;
      if (length > 512 || cursor + length > bytes.length) throw new Error('invalid string');
      const value = decoder.decode(bytes.subarray(cursor, cursor + length));
      cursor += length;
      return value;
    }
    try {
      const style = string(), name = string(), size = string(), material = string();
      cursor += 4;
      const symmetry = string();
      cursor += 16;
      const labelFormat = string();
      if (cursor + 60 > bytes.length) return null;
      const mode = u32(cursor);
      cursor += 4;
      if (mode !== 1 && mode !== 3) return null;
      const positions = [0, 12, 28, 40].map(delta => ({ x: f32(cursor + delta), y: f32(cursor + delta + 4), z: f32(cursor + delta + 8) }));
      if (!positions.every(point => finite([point.x, point.y]) && point.z === 0)) return null;
      if (positions[0].x !== positions[2].x || positions[0].y !== positions[2].y) return null;
      if (u32(cursor + 24) !== 0 || u32(cursor + 52) !== 0) return null;
      return { offset, sourceId: u32(offset), style, name, size, material, symmetry, labelFormat, mode, vectorOffset: cursor, positions };
    } catch { return null; }
  }
  const pieces = [];
  for (let offset = 100; offset + 160 < textSection.offset; offset++) {
    const piece = pieceRecord(offset);
    if (piece) {
      pieces.push(piece);
      offset = piece.vectorOffset + 55;
    }
  }
  if (!pieces.length || u32(pieces[0].offset - 4) !== pieces.length) throw new Error('PRJ 裁片记录数量或结构校验未通过。');
  const nodes = [];
  for (let offset = 100; offset + 34 < pieces[0].offset; offset++) {
    const recordType = u32(offset);
    if ((recordType !== 6 && recordType !== 7) || bytes[offset + 8] !== 0 || bytes[offset + 9] !== 0 || bytes[offset + 10] !== 255) continue;
    const x = f32(offset + 14), y = f32(offset + 18), z = f32(offset + 22);
    if (!finite([x, y]) || z !== 0) continue;
    nodes.push({ offset, recordType, sourceId: u32(offset + 4), x, y, ownerIndex: u32(offset + 26), flags: Array.from(bytes.subarray(offset + 11, offset + 14)) });
    offset += 33;
  }
  if (!nodes.length || u32(nodes[0].offset - 4) !== nodes.length) throw new Error('PRJ 点记录数量或结构校验未通过。');
  const grains = pieces.map(piece => ({
    id: `prj-grain-${piece.offset}`, type: 'polyline', closed: false,
    name: `${piece.name} · 布纹方向（推定）`, layer: 'grain',
    points: [piece.positions[3], piece.positions[1]].map(({ x, y }) => ({ x, y })),
    arrowStart: piece.mode === 3, arrowEnd: true,
    source: { format: 'ET PRJ', offset: piece.offset, vectorOffset: piece.vectorOffset,
      sourceId: piece.sourceId, arrowMode: piece.mode, pieceName: piece.name,
      material: piece.material, size: piece.size, center: piece.positions[0],
      interpretation: 'grainline-vectors-with-inferred-arrow-flags',
    },
  }));
  return {
    entities: [...textSection.texts, ...grains],
    metadata: {
      declaredTextCount: textSection.count, parsedTextCount: textSection.texts.length,
      textSectionOffset: textSection.offset, textSectionEndOffset: textSection.endOffset,
      declaredPieceCount: pieces.length, parsedPieceCount: pieces.length,
      pieceSectionOffset: pieces[0].offset, pieces,
      declaredPointCount: nodes.length, parsedPointCount: nodes.length,
      pointSectionOffset: nodes[0].offset, nodes,
    },
    warnings: ['文字内容、位置和尺寸直接读取自 PRJ。按表格坐标关系使用垂直居中锚点；浏览器字体字形与 ET 可能存在差异。',
      '布纹线端点直接读取自裁片记录，单/双箭头含义根据记录模式推断。'],
  };
}
