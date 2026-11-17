/**
 * Demonstration mode: no model and no key. It answers through the same interface as a real
 * provider, so the whole path (page, service, plan check, preview, apply) can be tried
 * before a model is connected. It understands exactly one kind of sentence, a rectangle
 * given as "宽 x 高" in centimetres, and says so for everything else.
 */
const between = (text, tag) => { const match = new RegExp('<' + tag + '>\\n([\\s\\S]*?)\\n</' + tag + '>').exec(text); if (!match) return null; try { return JSON.parse(match[1]); } catch { return null; } };

export function createDemoModel() {
  function start({ user, tool }) {
    let asked = false;
    async function next() {
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      if (asked) return { kind: 'text', text: '演示模式不能改正计划。', usage };
      asked = true;
      const instruction = String(between(user, 'instruction') ?? ''), scene = between(user, 'scene') || {};
      const size = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i.exec(instruction);
      const commands = tool.input_schema.properties.steps.items.properties.type.enum, actions = tool.input_schema.properties.actions.items.enum;
      if (!size || !/矩形|长方形|方块|方形/.test(instruction) || !commands.includes('draw.rectangle')) {
        return { kind: 'plan', usage, input: { reply: '这是演示模式：服务已经连通，但还没有接大模型，所以只认识一句话——“画一个 20x10 的矩形”（数字按厘米）。画布上现在有 ' + (scene.pieceCount ?? 0) + ' 个裁片。接上模型的办法见服务文件夹里的 README。', steps: [],
          choices: [{ label: '画一个 20x10 的矩形', send: '画一个 20x10 的矩形' }] } };
      }
      const width = Number(size[1]) * 10, height = Number(size[2]) * 10, x = scene.bbox ? Math.ceil(scene.bbox.maxX + 50) : 0, y = scene.bbox ? Math.floor(scene.bbox.minY) : 0;
      return { kind: 'plan', usage, input: { reply: '演示模式：画一个宽 ' + size[1] + ' cm、高 ' + size[2] + ' cm 的矩形。',
        steps: [{ type: 'draw.rectangle', parameters: { x, y, width, height, name: '演示矩形' } }], actions: actions.includes('view.fit') ? ['view.fit'] : [],
        assumptions: ['演示模式下数字固定按厘米理解。', scene.bbox ? '放在现有图形右边 5 cm 处。' : '从原点开始画。'] } };
    }
    return { next };
  }
  return Object.freeze({ id: 'demo', model: '演示模式（没有接模型）', start });
}
