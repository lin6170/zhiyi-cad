import { parsePrj } from './prj-parser.mjs';
import { validateProject } from './geometry.mjs';
import { previewPrjTextWriteback, applyPrjTextWriteback } from './prj-writeback.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

/** Whole-project gate: never export just text while silently losing other edits. */
export function createPrjTextExportSession(input, filename) {
  const original = input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(input.slice(0));
  if (![0x51, 0x7f, 1, 1, 0, 0, 0, 0x40].every((v, i) => original[i] === v)) throw new Error('此 PRJ 布局尚不支持标注回存。');
  const baseline = clone(validateProject({ format: 'zhiyi-cad', version: 6, units: 'unknown',
    seamAllowances: [], notches: [], seamChecks: [], ...parsePrj(original, filename) }));
  const previews = new WeakMap();
  return Object.freeze({
    filename,
    preview(project) {
      const current = clone(project), expected = clone(baseline), edits = [];
      if (!Array.isArray(current.entities) || current.entities.length !== expected.entities.length) throw new Error('图元数量已变化；PRJ 标注回存不能包含新增或删除图元，请保存工程。');
      if (!Number.isInteger(current.version) || current.version < baseline.version || current.version > 10) throw new Error('工程版本已变化，请重新导入原始 PRJ。');
      expected.version = current.version;
      for (let i = 0; i < expected.entities.length; i++) {
        const old = expected.entities[i], next = current.entities[i];
        if (old.id !== next.id || old.type !== next.type) throw new Error('图元或顺序已变化，请保存工程。');
        if (old.type === 'text' && old.text !== next.text) {
          edits.push({ entityId: old.id, expectedText: old.text, text: next.text });
          old.text = next.text; old.name = next.text || '空文字';
        }
        // This flag only tracks editing in our application; its source fields stay checked.
        if (next.source?.modified === true) delete next.source.modified;
        if (old.source?.modified === true) delete old.source.modified;
      }
      if (canonical(current) !== canonical(expected)) throw new Error('工程还包含几何、排版、单位或其他修改，不能只回存标注；请保存工程，或撤销这些修改后重试。');
      if (!edits.length) throw new Error('没有需要回存的标注修改。');
      const plan = previewPrjTextWriteback(original, edits);
      previews.set(plan, JSON.stringify(project));
      return plan;
    },
    export(project, plan) {
      if (previews.get(plan) !== JSON.stringify(project)) throw new Error('工程在预览后已变化，请关闭窗口并重新预览。');
      return applyPrjTextWriteback(original, plan);
    },
  });
}
