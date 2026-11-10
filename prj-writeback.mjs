/**
 * Local interoperability experiment: equal-byte-length ASCII annotation edits.
 * No geometry, resizing, Chinese encoding, or generic project export is supported.
 * Reparse/byte checks are not native ET validation. The UI adds a whole-project gate.
 */
import { parsePrj } from './prj-parser.mjs';

const prepared = new WeakMap();
const signature = [0x51, 0x7f, 1, 1, 0, 0, 0, 0x40];
const printableAscii = /^[\x20-\x7e]+$/;
const clone = value => JSON.parse(JSON.stringify(value));

function bytesOf(input) {
  if (input instanceof Uint8Array) return new Uint8Array(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  throw new Error('PRJ 写回必须提供原始文件字节。');
}
function sameBytes(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Preview is opaque, immutable and bound to this exact original file. */
export function previewPrjTextWriteback(input, edits) {
  const original = bytesOf(input);
  if (!signature.every((value, i) => original[i] === value)) {
    throw new Error('此 PRJ 文件布局尚未支持标注写回。');
  }
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 1000) {
    throw new Error('每次标注写回需包含 1–1000 项修改。');
  }
  const before = parsePrj(original);
  const byId = new Map(before.entities.map(entity => [entity.id, entity]));
  const expected = clone(before);
  const expectedById = new Map(expected.entities.map(entity => [entity.id, entity]));
  const candidate = original.slice();
  const seen = new Set(), changes = [], byteChanges = [];
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit) ||
        Object.keys(edit).some(key => !['entityId', 'expectedText', 'text'].includes(key)) ||
        typeof edit.entityId !== 'string' || typeof edit.expectedText !== 'string' || typeof edit.text !== 'string') {
      throw new Error('标注修改必须明确提供 entityId、expectedText 和 text，不能包含其他操作。');
    }
    if (seen.has(edit.entityId)) throw new Error('同一标注不能在一次写回中重复修改。');
    seen.add(edit.entityId);
    const entity = byId.get(edit.entityId);
    if (!entity || entity.type !== 'text') throw new Error('指定对象不是原文件中的独立文字标注。');
    if (entity.text !== edit.expectedText) throw new Error('原标注内容已变化，请重新生成预览。');
    if (!printableAscii.test(entity.text) || !printableAscii.test(edit.text)) {
      throw new Error('当前试验仅支持可打印 ASCII 标注；中文、换行和空字符串尚不支持写回。');
    }
    const { textOffset, textByteLength } = entity.source;
    if (edit.text.length !== textByteLength || entity.text.length !== textByteLength) {
      throw new Error('当前试验要求新旧文字字节长度相同，不能增删文字记录。');
    }
    for (let i = 0; i < textByteLength; i++) {
      const offset = textOffset + i, value = edit.text.charCodeAt(i);
      if (original[offset] !== entity.text.charCodeAt(i)) throw new Error('标注字节与解析结果不一致。');
      if (original[offset] !== value) byteChanges.push({ offset, before: original[offset], after: value });
      candidate[offset] = value;
    }
    const expectedEntity = expectedById.get(entity.id);
    expectedEntity.text = edit.text;
    expectedEntity.name = edit.text;
    expectedEntity.source.originalText = edit.text;
    if (edit.text !== entity.text) changes.push({ entityId: entity.id, before: entity.text, after: edit.text, textOffset, textByteLength });
  }
  const after = parsePrj(candidate);
  if (JSON.stringify(after) !== JSON.stringify(expected)) {
    throw new Error('写回后出现预期之外的解析变化，已拒绝生成文件。');
  }
  const plan = freeze({
    operation: 'replace_prj_annotation_text', version: 1,
    scope: 'equal-byte-length-ascii-annotations-only',
    byteLength: original.length, changedAnnotations: changes.length,
    changedBytes: byteChanges.length, changes, byteChanges,
    checks: { reparsed: true, otherDecodedDataUnchanged: true, originalLengthRetained: true },
    nativeEtValidation: 'pending',
    warning: '此预览仅验证指定标注的字节修改，不包含其他工程修改，也未证明 ET 往返兼容。',
  });
  prepared.set(plan, { original, candidate });
  return plan;
}

/** Commit an issued preview only if its full original byte snapshot still matches. */
export function applyPrjTextWriteback(input, plan) {
  const stored = prepared.get(plan);
  if (!stored) throw new Error('写回预览无效或来自其他会话，请重新预览。');
  if (!sameBytes(bytesOf(input), stored.original)) {
    throw new Error('原文件已变化，不能应用旧的写回预览。');
  }
  return stored.candidate.slice();
}
