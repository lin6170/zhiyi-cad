/** Experimental reader for the supplied and official-learning PRJ layouts. */
import { parsePrjAnnotations } from './prj-annotations.mjs';
import { scanPrjCurves, prjCurveStats } from './prj-curves.mjs';
import { parsePrjGroups } from './prj-groups.mjs';
import { parseLegacyPrj, legacyPrjSignature } from './prj-legacy.mjs';
export function parsePrj(input, filename = 'ET project.prj') {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 100 || bytes.byteLength > 16 * 1024 * 1024) {
    throw new Error('PRJ 文件大小不在当前支持范围内（100 字节至 16 MB）。');
  }
  if (legacyPrjSignature.every((value,index)=>bytes[index]===value)) return parseLegacyPrj(bytes,filename);
  const signature = [0x51, 0x7f, 1, 1, 0, 0, 0, 0x40];
  if (!signature.every((value, index) => bytes[index] === value)) {
    throw new Error('尚不支持此 PRJ 文件头，请使用相应 ET 版本核对。');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = offset => view.getUint32(offset, true);
  const decoder = new TextDecoder('gb18030', { fatal: true });
  let textOffset = 61;
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
  const annotations = parsePrjAnnotations(bytes);
  Object.assign(metadata, annotations.metadata);
  const allEntities = [...entities, ...annotations.entities];
  const ownership = parsePrjGroups(bytes, { entities: allEntities, metadata });
  Object.assign(metadata, ownership.metadata);
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
      ...annotations.warnings,
      '线条颜色直接读取显示 RGB；线型 1 按虚线显示，其余线型的精确短划样式仍需核对。',
    ],
  };
}
