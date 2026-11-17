/**
 * Claude, through the official Anthropic SDK (@anthropic-ai/sdk; it needs Node.js 20 or later).
 *
 * The key stays in this process: the SDK reads ANTHROPIC_API_KEY from the environment, and
 * nothing here logs or returns it. The request is streamed and read with finalMessage(), so
 * a long answer does not run into a request timeout.
 *
 * The plan comes back as the input of one tool. Forcing a tool call is not available on the
 * current models, so tool_choice stays "auto": an answer in plain text is handed to the
 * planner as text, and the planner decides what to do with it. The tool input streams
 * eagerly; in exchange nothing may be assumed about it, which is why the planner checks
 * every plan against the catalogue, and why a cut-off or refused answer is never used.
 */
import { ModelError } from '../lib/planner.mjs';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * model: a Claude model id. maxTokens: the limit for one answer. effort: optional thinking depth.
 * sdk: the SDK's default export, injected by the tests; left out, the installed package is loaded.
 */
export async function createAnthropicModel({ model = DEFAULT_MODEL, maxTokens = 16000, effort = '', sdk = null, log = () => {} } = {}) {
  if (effort && !EFFORTS.includes(effort)) throw new ModelError('config', 'ANTHROPIC_EFFORT 须为 ' + EFFORTS.join('、') + ' 之一。');
  let Anthropic = sdk;
  if (!Anthropic) {
    try { Anthropic = (await import('@anthropic-ai/sdk')).default; }
    catch { throw new ModelError('config', '没有找到 @anthropic-ai/sdk。请在 model-service 文件夹里运行一次 npm install（需要 Node.js 20 或更新的版本）。'); }
  }
  // Credentials are resolved by the SDK from the environment (ANTHROPIC_API_KEY).
  const client = new Anthropic();
  const is = (error, name) => typeof Anthropic[name] === 'function' && error instanceof Anthropic[name];

  function translate(error) {
    log('模型接口报错：' + (error.status ?? '') + ' ' + String(error.message).slice(0, 500));
    if (is(error, 'AuthenticationError') || is(error, 'PermissionDeniedError')) return new ModelError('auth', '模型密钥无效或没有权限，请检查服务端的 ANTHROPIC_API_KEY。');
    if (is(error, 'RateLimitError')) return new ModelError('rate', '模型接口正忙或额度已用完，请稍后再试。');
    if (is(error, 'APIConnectionTimeoutError')) return new ModelError('timeout', '模型接口在限定时间内没有回应。');
    if (is(error, 'APIConnectionError')) return new ModelError('connection', '服务端连不上模型接口，请检查网络。');
    if (is(error, 'BadRequestError') || is(error, 'NotFoundError')) return new ModelError('upstream', '模型接口不接受这次请求，详情见服务端窗口里的记录。');
    return new ModelError('upstream', '模型接口暂时出错' + (error.status ? '（HTTP ' + error.status + '）' : '') + '，请稍后再试。');
  }

  function start({ instructions, catalogue, user, tool, deadline, signal }) {
    const tools = [{ name: tool.name, description: tool.description, input_schema: tool.input_schema, eager_input_streaming: true }];
    // The instructions and the catalogue are the same for every request of one page version: cache them.
    const system = [{ type: 'text', text: instructions }, { type: 'text', text: catalogue, cache_control: { type: 'ephemeral' } }];
    const messages = [{ role: 'user', content: user }];
    let last = null;

    async function next(correction) {
      if (correction) {
        // The previous answer goes back unchanged, then the reason it was not usable.
        const calls = last ? last.content.filter(block => block.type === 'tool_use') : [];
        if (last && last.content.length) messages.push({ role: 'assistant', content: last.content });
        messages.push({ role: 'user', content: calls.length
          ? calls.map((call, index) => ({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: index === 0 ? correction.text : '每次只能交一份计划。' }))
          : correction.text });
      }
      for (let unreadable = 0; ;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0 || signal?.aborted) throw new ModelError('timeout', '模型在限定时间内没有答完。');
        const stream = client.messages.stream({ model, max_tokens: maxTokens, thinking: { type: 'adaptive' }, ...(effort ? { output_config: { effort } } : {}), system, tools, messages });
        let stopped = false;
        const stop = () => { stopped = true; stream.abort(); }, timer = setTimeout(stop, remaining);
        signal?.addEventListener('abort', stop, { once: true });
        let message;
        try { message = await stream.finalMessage(); }
        catch (error) {
          if (stopped) throw new ModelError('timeout', '模型在限定时间内没有答完。');
          if (error instanceof Anthropic.APIError) throw translate(error);
          // A tool input that is not JSON at all rejects here. Ask again, a limited number of times.
          if (++unreadable > 2) throw new ModelError('upstream', '模型连续几次给出无法读取的计划。');
          continue;
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
        last = message;
        const usage = { inputTokens: message.usage?.input_tokens || 0, outputTokens: message.usage?.output_tokens || 0, cacheReadTokens: message.usage?.cache_read_input_tokens || 0, cacheWriteTokens: message.usage?.cache_creation_input_tokens || 0 };
        // A refusal or a cut-off answer can leave a tool input half written: never use it.
        if (message.stop_reason === 'refusal') return { kind: 'refusal', text: message.stop_details?.explanation || '', usage };
        if (message.stop_reason === 'max_tokens') return { kind: 'truncated', usage };
        const call = message.content.find(block => block.type === 'tool_use' && block.name === tool.name);
        if (call) return { kind: 'plan', input: call.input, usage };
        return { kind: 'text', text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), usage };
      }
    }
    return { next };
  }
  return Object.freeze({ id: 'anthropic', model, start });
}
