/**
 * Any model service that speaks the widely used "chat completions" format with function
 * calling. Many services reachable from mainland China offer it, and so do local runners.
 * Set MODEL_BASE_URL (for example https://api.example.com/v1), MODEL_NAME and MODEL_API_KEY.
 *
 * This file talks plain HTTP on purpose: there is no single official SDK for these services.
 * It is not used for Claude; Claude goes through providers/anthropic.mjs.
 */
import { ModelError } from '../lib/planner.mjs';

const CHOICES = ['auto', 'required', 'function'];

/** fetchImpl is injected by the tests; left out, the built-in fetch of Node.js 18 or later is used. */
export function createOpenAiCompatibleModel({ baseUrl, apiKey = '', model, maxTokens = 0, toolChoice = 'auto', fetchImpl = null, log = () => {} } = {}) {
  let base;
  try { base = new URL(String(baseUrl || '')); } catch { throw new ModelError('config', 'MODEL_BASE_URL 不是有效的网址，例如 https://api.example.com/v1 。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) throw new ModelError('config', 'MODEL_BASE_URL 须以 https:// 开头；只有本机地址可以用 http://。');
  if (base.username || base.password || base.search || base.hash) throw new ModelError('config', 'MODEL_BASE_URL 里不能带用户名、密码或参数。');
  if (!model) throw new ModelError('config', '请用 MODEL_NAME 指定模型名称。');
  if (!apiKey && !local) throw new ModelError('config', '请用 MODEL_API_KEY 提供模型密钥。');
  if (!CHOICES.includes(toolChoice)) throw new ModelError('config', 'MODEL_TOOL_CHOICE 须为 ' + CHOICES.join('、') + ' 之一。');
  const send = fetchImpl || ((...args) => { if (typeof globalThis.fetch !== 'function') throw new ModelError('config', '这个模式需要 Node.js 18 或更新的版本。'); return globalThis.fetch(...args); });
  const endpoint = base.origin + base.pathname.replace(/\/+$/, '') + '/chat/completions';

  function start({ instructions, catalogue, user, tool, deadline, signal }) {
    const messages = [{ role: 'system', content: instructions + '\n\n' + catalogue }, { role: 'user', content: user }];
    const tools = [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }];
    let last = null;

    async function next(correction) {
      if (correction) {
        const calls = last?.tool_calls || [];
        if (calls.length) {
          messages.push({ role: 'assistant', content: last.content ?? null, tool_calls: calls });
          calls.forEach((call, index) => messages.push({ role: 'tool', tool_call_id: call.id, content: index === 0 ? correction.text : '每次只能交一份计划。' }));
        } else {
          if (last && typeof last.content === 'string' && last.content) messages.push({ role: 'assistant', content: last.content });
          messages.push({ role: 'user', content: correction.text });
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal?.aborted) throw new ModelError('timeout', '模型在限定时间内没有答完。');
      const controller = new AbortController(), stop = () => controller.abort(), timer = setTimeout(stop, remaining);
      signal?.addEventListener('abort', stop, { once: true });
      let status, raw;
      try {
        const response = await send(endpoint, { method: 'POST', signal: controller.signal, redirect: 'error',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
          body: JSON.stringify({ model, messages, tools, tool_choice: toolChoice === 'function' ? { type: 'function', function: { name: tool.name } } : toolChoice, stream: false, ...(maxTokens ? { max_tokens: maxTokens } : {}) }) });
        status = response.status; raw = await response.text();
      } catch (error) {
        if (error instanceof ModelError) throw error;
        throw controller.signal.aborted ? new ModelError('timeout', '模型在限定时间内没有答完。') : new ModelError('connection', '服务端连不上模型接口，请检查 MODEL_BASE_URL 和网络。');
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
      if (status === 401 || status === 403) throw new ModelError('auth', '模型密钥无效或没有权限，请检查服务端的 MODEL_API_KEY。');
      if (status === 429) throw new ModelError('rate', '模型接口正忙或额度已用完，请稍后再试。');
      if (status < 200 || status >= 300) { log('模型接口报错：HTTP ' + status + ' ' + String(raw).slice(0, 500)); throw new ModelError('upstream', status >= 500 ? '模型接口暂时出错（HTTP ' + status + '），请稍后再试。' : '模型接口不接受这次请求（HTTP ' + status + '），详情见服务端窗口里的记录。'); }
      let body; try { body = JSON.parse(raw); } catch { throw new ModelError('upstream', '模型接口返回的不是 JSON。'); }
      const choice = body?.choices?.[0], message = choice?.message;
      if (!message || typeof message !== 'object') throw new ModelError('upstream', '模型接口的回答里没有内容。');
      last = { content: typeof message.content === 'string' ? message.content : null, tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls.filter(c => c && typeof c.id === 'string' && c.function && typeof c.function.name === 'string').map(c => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) } })) : [] };
      const usage = { inputTokens: body.usage?.prompt_tokens || 0, outputTokens: body.usage?.completion_tokens || 0, cacheReadTokens: body.usage?.prompt_tokens_details?.cached_tokens || 0, cacheWriteTokens: 0 };
      if (choice.finish_reason === 'length') return { kind: 'truncated', usage };
      if (choice.finish_reason === 'content_filter') return { kind: 'refusal', text: '', usage };
      const call = last.tool_calls.find(c => c.function.name === tool.name);
      if (call) { let input = null; try { input = JSON.parse(call.function.arguments); } catch { /* the planner reports an unusable plan and asks again */ } return { kind: 'plan', input, usage }; }
      return { kind: 'text', text: last.content || '', usage };
    }
    return { next };
  }
  return Object.freeze({ id: 'openai-compatible', model, start });
}
