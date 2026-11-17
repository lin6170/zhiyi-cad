/** Experimental reader for the supplied and official-learning PRJ layouts. */
import { parsePrjAnnotations } from './prj-annotations.mjs';
import { scanPrjCurves, prjCurveStats, curveTail } from './prj-curves.mjs';
import { parsePrjGroups } from './prj-groups.mjs';
import { parseLegacyPrj, legacyPrjSignature } from './prj-legacy.mjs';
import { parseNativeV5Prj, nativeV5Signature } from './prj-v5.mjs';
import { decodePrjStorage, encodedV5Signature } from './prj-storage.mjs';
import { readEtMarks } from './prj-marks.mjs';
import { baseSizeLayer, readSizes } from './prj-sizes.mjs';
export function parsePrj(input, filename = 'ET project.prj') {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 100 || bytes.byteLength > 16 * 1024 * 1024) {
    throw new Error('PRJ 文件大小不在当前支持范围内（100 字节至 16 MB）。');
  }
  if (encodedV5Signature.every((value,index)=>bytes[index]===value)) {
    const project=parseNativeV5Prj(decodePrjStorage(bytes),filename);
    project.metadata.storage='v5-496-interleave-md5';
    return project;
  }
  if (nativeV5Signature.every((value,index)=>bytes[index]===value)) return parseNativeV5Prj(bytes,filename);
  if (legacyPrjSignature.every((value,index)=>bytes[index]===value)) return parseLegacyPrj(bytes,filename);
  const signature = [0x51, 0x7f, 1, 1, 0, 0, 0, 0x40];
  if (!signature.every((value, index) => bytes[index] === value)) {
    throw new Error('尚不支持此 PRJ 文件头，请使用相应 ET 版本核对。');
  }
  // A file ET saved after expanding its sizes holds one layer per size. The base size is read here, as a single-size file
  // (offsets in the result refer to baseSizeLayer(bytes).bytes); the other sizes are what the rules of the points give.
  const layered = baseSizeLayer(bytes);
  if (layered.spliced) {
    const project = parsePrj(layered.bytes, filename);
    project.metadata.sizeLayers = layered.layers.map(layer => ({ name: layer.name, base: layer.base, slot: layer.slot }));
    // v69: the locks of the other sizes are read from the whole file (the rules and offsets above stay those of the base's copy)
    const whole = readSizes(bytes, []); if (whole.readable && project.metadata.sizeSystem?.readable) project.metadata.sizeSystem.layers = whole.layers;
    project.warnings.splice(1, 0, '文件里存着 ' + layered.layers.length + ' 个码的图形（' + layered.layers.map(layer => layer.name).join('、') + '）。这里读入的是基码 ' + layered.base + '；其余各码按放码规则生成，转成可编辑工程后可以预览和导出。');
    return project;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = offset => view.getUint32(offset, true);
  const decoder = new TextDecoder('gb18030', { fatal: true });
  let textOffset = 12;
  function readString() {
    if (textOffset + 2 > bytes.length) throw new Error('PRJ 文本字段被截断。');
    const length = view.getUint16(textOffset, true);
    textOffset += 2;
    if (length > 4096 || textOffset + length > bytes.length) throw new Error('PRJ 文本字段长度异常。');
    const value = decoder.decode(bytes.subarray(textOffset, textOffset + length));
    textOffset += length;
    return value;
  }
  const metadata = { format: 'ET PRJ experimental', unit: 'unknown', sourceFile: filename };
  try {
    // "PD", the undo marker and the save date ET 2017 adds precede a fixed 41-byte block.
    readString(); readString(); readString(); textOffset += 41;
    metadata.collection = readString();
    metadata.style = readString();
    metadata.note = readString();
    metadata.savedAt = readString();
    metadata.baseSize = readString();
  } catch {
    throw new Error('PRJ 文件头文本结构与已验证样本不一致。');
  }

  const records = scanPrjCurves(bytes);
  const entities = records.map(record => record.entity);
  if (!entities.length) throw new Error('未识别到支持的 PRJ 曲线记录。');
  const firstCurveOffset = records[0].offset, lastCurveOffset = records.at(-1).offset;
  const declaredCurveCount = u32(firstCurveOffset - 4);
  if (declaredCurveCount !== entities.length) {
    throw new Error(`PRJ 曲线结构验证失败。声明 ${declaredCurveCount} 条，识别 ${entities.length} 条，当前版本拒绝部分导入。`);
  }
  const stats = prjCurveStats(entities);
  const { smoothSplineCount, fallbackSplineCount, maxSplineFitError } = stats;
  Object.assign(metadata, stats, { declaredCurveCount, firstCurveOffset, lastCurveOffset });
  metadata.compatibility = 'experimental-read-only-source';
  // Where the line records end. With no text and no piece in the file, the sections after the lines are found from here.
  let afterCurves = null; try { afterCurves = curveTail(bytes, lastCurveOffset).end; } catch { afterCurves = null; }
  const annotations = parsePrjAnnotations(bytes, { afterCurves });
  Object.assign(metadata, annotations.metadata);
  const allEntities = [...entities, ...annotations.entities];
  const ownership = parsePrjGroups(bytes, { entities: allEntities, metadata });
  Object.assign(metadata, ownership.metadata);
  // ET's own marks: rows of buttons and buttonholes, drill holes. The read-only view does not draw them; turning the file into an editable drawing carries them.
  const etMarks = metadata.etMarks = readEtMarks(bytes, metadata, ownership.groups), inRows = etMarks.rows.reduce((sum, row) => sum + row.count, 0);
  // The sizes of the file: names, the size table, the rule of each point. The read-only view shows the base size only.
  const sizes = metadata.sizeSystem = readSizes(bytes, metadata.nodes), moved = sizes.rules.filter(rule => rule.kind === 2).length;
  return {
    name: metadata.style || filename,
    entities: allEntities,
    groups: ownership.groups,
    metadata,
    warnings: [
      'PRJ 实验导入。已核对曲线、文字和裁片记录数量。两份样本的整体布局已与用户提供的 ET 照片对照，精度仍需核对。',
      '已根据原控制点重建 ' + smoothSplineCount + ' 条可编辑三次样条。长度按曲线速度数值积分，显示与轮廓检查使用自适应折线。源记录最大拟合残差 ' + maxSplineFitError.toFixed(6) + ' 原始单位。',
      ...(fallbackSplineCount ? ['有 ' + fallbackSplineCount + ' 条样条未通过重建核对，保留为原拟合点折线。'] : []),
      '原始坐标的物理单位尚未确认，测量显示原始单位。',
      '刀口语义、缝份生成规则和放码规则尚未恢复。当前工程保存为自有格式。',
      ...ownership.warnings,
      ...(etMarks.rows.length || etMarks.drills.length ? ['文件里有 ' + [etMarks.rows.length ? etMarks.rows.length + ' 排扣子或扣眼（共 ' + inRows + ' 个）' : '', etMarks.drills.length ? etMarks.drills.length + ' 个打孔' : ''].filter(Boolean).join('、') + '。只读预览不显示它们，转成可编辑工程后会带入。'] : []),
      ...(!etMarks.readable ? ['文件里有 ' + etMarks.declaredRows + ' 个扣子扣眼一类的对象没有读懂（' + etMarks.problem + '），转成可编辑工程时带不过来。'] : []),
      ...(sizes.readable && (moved || sizes.table.length || sizes.names.length > 1) ? ['文件里的放码数据：号型 ' + (sizes.names.map(size => size.name).join('、') || '只有基码') + '（基码 ' + sizes.baseName + '），尺寸表 ' + sizes.table.length + ' 项，' + moved + ' 个点有放码规则。转成可编辑工程后带入。'] : []),
      ...(!sizes.readable ? ['文件里的号型、尺寸表或放码规则没有读懂（' + sizes.problem + '），转成可编辑工程时带不过来。'] : []),
      ...annotations.warnings,
      '线条颜色直接读取显示 RGB；线型 1 按虚线显示，其余线型的精确短划样式仍需核对。',
    ],
  };
}
