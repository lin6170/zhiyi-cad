/** Annotation records decoded from ET PRJ bytes, independently of any screenshots. */
export function parsePrjAnnotations(input, { afterCurves = null } = {}) {
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
  // A drawing may hold no text at all, and no piece either. Nothing then marks where those sections begin, so they are
  // located from what comes before them, and accepted only when the counts written in the file really are zero.
  const textsFound = Boolean(textSection);
  if (!textSection) textSection = { offset: bytes.length, endOffset: bytes.length, count: 0, texts: [] };

  function pieceRecord(offset) {
    // The byte after the colour is 0x20 on the pieces of every file seen so far, and 0xA0 on a piece ET made with its 提取裁片 tool
    // (v59: seen in files saved by ET 2017 after that tool; what the extra bit says is not known, ET keeps it when it saves again).
    // v76: and 0x24 on a piece ET has shrunk with 缩水操作 or given a shrinkage with 裁片自带缩水 (the note follows the grain points)
    if (offset + 160 > textSection.offset || (bytes[offset + 7] & 0x7b) !== 0x20 || !zeroRange(offset + 8, 13)) return null;
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
      if (cursor + 4 > bytes.length) return null;
      const materialCode = u32(cursor);
      cursor += 4;
      const symmetry = string();
      if (cursor + 16 > bytes.length) return null;
      // the number of pieces to cut, a second count that is 0 on a piece that is not symmetric, and an angle whose meaning is not known
      const count = u32(cursor), symmetricCount = u32(cursor + 4), angle = f32(cursor + 8);
      cursor += 16;
      const labelFormat = string();
      if (cursor + 60 > bytes.length) return null;
      const mode = u32(cursor);
      cursor += 4;
      if (mode !== 1 && mode !== 3) return null;
      const positions = [0, 12, 28, 40].map(delta => ({ x: f32(cursor + delta), y: f32(cursor + delta + 4), z: f32(cursor + delta + 8) }));
      if (!positions.every(point => finite([point.x, point.y]) && point.z === 0)) return null;
      if (positions[0].x !== positions[2].x || positions[0].y !== positions[2].y) return null;
      if (u32(cursor + 24) !== 0) return null;
      // v76: after the second grain point ET keeps a note of the shrinkage it applied (缩水操作, 裁片自带缩水), a text with a 16-bit length, then a zero word
      const noteLength = u16(cursor + 52);
      if (noteLength > 200 || cursor + 58 + noteLength > bytes.length || u32(cursor + 54 + noteLength) !== 0) return null;
      const shrinkNote = noteLength ? decoder.decode(bytes.subarray(cursor + 54, cursor + 54 + noteLength)) : '';
      return { offset, sourceId: u32(offset), flag: bytes[offset + 7], style, name, size, material, materialCode, symmetry, count, symmetricCount, angle, labelFormat, mode, vectorOffset: cursor, positions, noteLength, shrinkNote };
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
  /** Where a piece record ends: its outline chains, five reference lists and a fixed block follow the grain line. */
  function pieceEnd(piece) {
    let cursor = piece.vectorOffset + 58 + piece.noteLength;
    const list = () => { if (cursor + 4 > bytes.length) throw new Error('truncated'); const count = u32(cursor); if (count > 100000) throw new Error('count'); cursor += 4 + count * 4; };
    try {
      if (cursor + 4 > bytes.length) return null;
      const chains = u32(cursor); cursor += 4; if (chains < 1 || chains > 1000) return null;
      for (let index = 0; index < chains; index++) { cursor += 2; list(); cursor += 4; }
      for (let index = 0; index < 5; index++) list();
      cursor += 112 + (bytes[piece.offset + 7] & 0x04 ? 8 : 0);   // v76: a shrunk piece ends with its two stretch factors
      return cursor <= bytes.length ? cursor : null;
    } catch { return null; }
  }
  if (pieces.length) {
    if (u32(pieces[0].offset - 4) !== pieces.length) throw new Error('PRJ 裁片记录数量或结构校验未通过。');
    if (!textsFound) {
      const end = pieceEnd(pieces.at(-1));
      if (end === null || end + 4 > bytes.length || u32(end) !== 0) throw new Error('PRJ 文本记录数量或结构校验未通过。');
      textSection = { offset: end + 4, endOffset: end + 4, count: 0, texts: [] };
    }
  } else {
    // no piece record was recognised: the count after the last line must say so
    const pieceCountOffset = textsFound ? textSection.offset - 8 : afterCurves;
    if (pieceCountOffset === null || pieceCountOffset < 100 || pieceCountOffset + 8 > bytes.length || (afterCurves !== null && pieceCountOffset !== afterCurves) || u32(pieceCountOffset) !== 0) throw new Error('PRJ 裁片记录数量或结构校验未通过。');
    if (!textsFound) {
      if (u32(pieceCountOffset + 4) !== 0) throw new Error('PRJ 文本记录数量或结构校验未通过。');
      textSection = { offset: pieceCountOffset + 8, endOffset: pieceCountOffset + 8, count: 0, texts: [] };
    }
  }
  const nodes = [], nodeBound = pieces.length ? pieces[0].offset : textSection.offset - 8;
  for (let offset = 100; offset + 34 < nodeBound; offset++) {
    const recordType = u32(offset);
    if ((recordType !== 6 && recordType !== 7) || bytes[offset + 8] !== 0 || bytes[offset + 9] !== 0 || bytes[offset + 10] !== 255) continue;
    const x = f32(offset + 14), y = f32(offset + 18), z = f32(offset + 22);
    if (!finite([x, y]) || !(Math.abs(z) < 1e-9)) continue;   // v65: the end nodes of ET's extra corner seam lines can carry leftover z
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
      pieceSectionOffset: pieces.length ? pieces[0].offset : textSection.offset - 4, pieces,
      declaredPointCount: nodes.length, parsedPointCount: nodes.length,
      pointSectionOffset: nodes[0].offset, nodes,
    },
    warnings: ['文字内容、位置和尺寸直接读取自 PRJ。按表格坐标关系使用垂直居中锚点；浏览器字体字形与 ET 可能存在差异。',
      '布纹线端点直接读取自裁片记录，单/双箭头含义根据记录模式推断。'],
  };
}
