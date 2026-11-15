/**
 * Client for a model service that plans drawing commands. The browser never holds a
 * model key: it posts the instruction, a description of the canvas and the command
 * catalogue to a service the user has configured, and receives a plan in the same
 * format the offline parser produces. The plan is validated and previewed like any other.
 *
 *   POST {serviceUrl}/v1/plan      Content-Type: application/json
 *   request  { schema: 'zhiyi-agent-request/v1', locale, units, instruction, history, scene,
 *              selection, last, preferences, commands, actions, feedback }
 *   response { schema: 'zhiyi-agent-plan/v1', reply, steps, actions, assumptions, questions, choices }
 *
 * "feedback" is set when the previous plan failed its preview: { error, step, steps }.
 */
export const REQUEST_SCHEMA = 'zhiyi-agent-request/v1';
const MAX_RESPONSE = 1024 * 1024;

/** A service address the page may call: https, or http on this computer only. Returns the normalised base address. */
export function checkServiceUrl(value) {
  let url; try { url = new URL(String(value).trim()); } catch { throw new Error('服务地址不是有效的网址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('服务地址须以 https:// 开头；只有本机地址（localhost）可以用 http://。');
  if (url.username || url.password) throw new Error('服务地址里不能带用户名或密码。');
  if (url.search || url.hash) throw new Error('服务地址里不能带参数。');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** getSettings(): { serviceUrl, accessCode? }. fetchImpl is injectable for tests. */
export function createRemotePlanner({ getSettings, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 90000 }) {
  async function plan({ text, scene, catalog, actions, history, feedback, context }) {
    const settings = getSettings() || {};
    if (!settings.serviceUrl) throw new Error('还没有设置模型服务地址。');
    const base = checkServiceUrl(settings.serviceUrl), controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const body = JSON.stringify({ schema: REQUEST_SCHEMA, locale: 'zh-CN', units: 'mm', instruction: text, history: history || [], scene, selection: context?.selection || { entityIds: [], pieceIds: [] },
      last: context?.last || { entityIds: [], pieceIds: [] }, preferences: context?.preferences || {}, commands: catalog.commands, actions: actions || [], feedback: feedback || null });
    let response;
    try {
      response = await fetchImpl(base + '/v1/plan', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(settings.accessCode ? { Authorization: 'Bearer ' + settings.accessCode } : {}) }, body,
        signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    } catch (error) {
      throw new Error(controller.signal.aborted ? '模型服务在 ' + Math.round(timeoutMs / 1000) + ' 秒内没有回应。' : '连不上模型服务，请检查地址和网络。');
    } finally { clearTimeout(timer); }
    if (response.status === 401 || response.status === 403) throw new Error('模型服务拒绝了访问，请检查访问码。');
    if (response.status === 429) throw new Error('模型服务正忙或额度已用完，请稍后再试。');
    if (!response.ok) throw new Error('模型服务出错（HTTP ' + response.status + '）。');
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE) throw new Error('模型服务返回的内容过大。');
    try { return JSON.parse(raw); } catch { throw new Error('模型服务返回的不是有效的计划。'); }
  }
  return Object.freeze({ id: 'remote', name: '模型服务', canRevise: true, plan });
}
