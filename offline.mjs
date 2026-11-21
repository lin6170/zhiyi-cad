// v74: the page side of the offline copy (sw.js) and of installing the page as an app.
//  - registers the service worker once the page has loaded and tells how far it is: preparing, ready (the page opens with no
//    network), failed, or not possible in this browser (an http page other than this computer, an old browser);
//  - offers 安装到桌面 where the browser allows it (it then opens in its own window, like a program);
//  - when a new version has been fetched in the background, offers to reload into it (the work in hand is saved first by the user;
//    the page asks before leaving unsaved work, as it always does);
//  - shows 离线 in the header while the computer has no network (the assistant's model service, which is elsewhere, then cannot answer).
export const OFFLINE_VERSION = 77;
export const OFFLINE_TEXT = Object.freeze({
  unsupported: '这个浏览器不能离线使用，联网时照常可用。',
  preparing: '正在准备离线使用…',
  ready: '已可离线使用：没有网络也能打开这个页面。',
  failed: '离线准备没有完成，下次联网打开时会再试。',
});

export function createOffline({ status = [], installButtons = [], header = null, host = document.body, notify = () => {} } = {}) {
  let state = 'preparing', deferred = null, waiting = null, reloading = false;
  const listeners = new Set();
  const badge = document.createElement('span');
  badge.id = 'offline-badge'; badge.className = 'offline-badge'; badge.textContent = '离线'; badge.title = '现在没有网络：页面照常可用，助手的模型服务连不上。'; badge.hidden = navigator.onLine !== false;
  header?.append(badge);
  const bar = document.createElement('div');
  bar.id = 'update-bar'; bar.className = 'update-bar'; bar.hidden = true; bar.setAttribute('role', 'status');
  bar.innerHTML = '<span>新版本已经下载好。保存手上的工作以后，点“刷新”换用新版本。</span><button type="button" id="update-reload" class="primary">刷新</button><button type="button" id="update-later">稍后</button>';
  host.append(bar);
  const show = () => {
    for (const element of status) if (element) { element.textContent = OFFLINE_TEXT[state]; element.dataset.state = state; }
    const installable = Boolean(deferred);
    for (const button of installButtons) if (button) button.hidden = !installable;
    for (const listener of listeners) listener(info());
  };
  const set = next => { state = next; show(); };
  const info = () => ({ state, text: OFFLINE_TEXT[state], installable: Boolean(deferred), installed: standalone(), updateWaiting: Boolean(waiting) });
  const standalone = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; } };
  function offerUpdate(worker) { waiting = worker; bar.hidden = false; show(); }
  bar.querySelector('#update-reload').onclick = () => { if (!waiting) return; reloading = true; waiting.postMessage('skip-waiting'); };
  bar.querySelector('#update-later').onclick = () => { bar.hidden = true; };
  window.addEventListener('online', () => { badge.hidden = true; });
  window.addEventListener('offline', () => { badge.hidden = false; });
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferred = event; show(); });
  window.addEventListener('appinstalled', () => { deferred = null; show(); notify('已安装到桌面，以后可以像程序一样打开，没有网络也能用。'); });
  for (const button of installButtons) if (button) button.onclick = async () => {
    if (!deferred) return;
    const prompt = deferred; deferred = null; show();
    try { await prompt.prompt(); await prompt.userChoice; } catch { /* the browser declined to ask */ }
  };
  async function register() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) { set('unsupported'); return; }
    try {
      const registration = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      const follow = worker => worker && worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller && worker !== navigator.serviceWorker.controller) offerUpdate(worker);
        if (worker.state === 'activated' && state !== 'ready') set('ready');
        if (worker.state === 'redundant' && state === 'preparing') set('failed');
      });
      if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
      if (registration.active && !registration.installing) set('ready');
      else follow(registration.installing);
      registration.addEventListener('updatefound', () => follow(registration.installing));
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) location.reload(); });
      registration.update().catch(() => { /* no network: the copy keeps working */ });
    } catch { set('failed'); }
  }
  show();
  return {
    start() { if (document.readyState === 'complete') register(); else window.addEventListener('load', register, { once: true }); },
    info, subscribe(listener) { listeners.add(listener); listener(info()); return () => listeners.delete(listener); },
    install() { return installButtons[0]?.onclick?.(); },
  };
}
