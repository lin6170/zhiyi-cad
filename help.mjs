// v74: 帮助 — the page's keys beside ET 2017's (ET's keys as its own menus name them), what the built-in assistant understands (a
// test has it plan every sentence here), and offline use and installing.
export const SHORTCUTS = Object.freeze([
  { group: '常用', rows: [
    ['Ctrl+S 或 F2', '保存工程文件（.zycad）；存成 ET 文件用“保存 PRJ”', 'F2、Ctrl+S 保存'],
    ['Ctrl+O 或 F3', '打开文件：ET 的 PRJ、DXF、工程文件（也可以拖进窗口）', 'F3、Ctrl+O 打开'],
    ['Ctrl+Z', '撤销', 'Ctrl+Z 撤消'],
    ['Ctrl+X、Ctrl+Y 或 Ctrl+Shift+Z', '重做（恢复刚撤销的）', 'Ctrl+X 恢复'],
    ['Delete 或 Backspace', '删除选中的图形', ''],
    ['Esc', '放下手上的操作，回到选择', ''],
    ['Ctrl+A', '选中看得见的全部图形', ''],
    ['Ctrl+G、Ctrl+Shift+G', '成组、取消成组', ''],
    ['Ctrl+P', '出图（1:1 打印、分页）', 'Ctrl+P 打印'],
    ['?', '打开这页帮助', ''],
  ] },
  { group: '看图', rows: [
    ['V 或 F', '全屏：整张图放进窗口', 'V 全屏'],
    ['Z', '放大：框选要放大的区域，或按住 Shift 点一下；右键或 Esc 结束', 'Z 放大'],
    ['X', '缩小', 'X 缩小'],
    ['C', '屏幕移动：按住左键拖一次，拖完回到原来的工具', 'C 屏幕移动'],
    ['F10', '前画面：回到上一个画面', 'F10 前画面'],
    ['F7', '单片全屏：点一个裁片，让它占满窗口', 'F7 单片全屏'],
    ['滚轮', '以鼠标为中心放大、缩小', ''],
    ['按住空格拖动，或按住滚轮拖动', '移动画面', ''],
  ] },
  { group: '画线工具', rows: [
    ['~（Esc 下面的键）', '智能笔', '~ 智能工具'],
    ['L', '直线', ''], ['P', '折线，Enter 完成', ''], ['R', '矩形', ''],
    ['S', '多点曲线，Enter、右键或双击完成；Backspace 去掉最后一点', ''],
    ['N', '编辑节点', ''], ['M', '两点测量', ''], ['G', '布纹线', ''],
  ] },
  { group: '智能笔里', rows: [
    ['直接打数字', '填进“长度”框；框好线以后打 - 号，填进“调整量”', ''],
    ['单按一下 Ctrl', '丁字尺开、关', 'Ctrl 丁字尺'],
    ['Enter 或右键', '完成手上的（同右键）', ''],
    ['Backspace', '去掉刚点的一点；框好线时删除这些线', ''],
    ['Esc', '放下手上的', ''],
  ] },
]);
export const SHORTCUT_NOTES = Object.freeze([
  'ET 的 Ctrl+1 到 Ctrl+6（测量）在浏览器里是切换标签页，网页用不了；网页的测量是 M（两点测量）和画线工具里的“综合测量”。',
  'ET 的 Alt+A 裁片平移、Alt+S 缝边刷新、Alt+Z 推板展开、Alt+C 移动点，网页还没有对应的快捷键。',
  '网页原来的 V（选择）和 C（曲线）让给了 ET 的全屏和屏幕移动：回到选择按 Esc，曲线用左边工具栏的按钮。',
]);
// when: the drawing a sentence needs (empty, drafted: trousers drafted by the page, etPants: an ET trousers file opened as it is with
// the rules of 自动改裤长 set); does: what the assistant then plans, checked by the test
export const PHRASES = Object.freeze([
  { group: '画裤子、改尺寸', items: [
    { say: '画一条直筒裤，腰围76 臀围96 裤长102', when: 'empty', does: 'pattern.draftStraightPants' },
    { say: '裤长加2厘米', when: 'drafted', does: 'pattern.updateDraft' },
    { say: '脚口改成40厘米', when: 'drafted', does: 'pattern.updateDraft' },
    { say: '缝份改成1.2厘米', when: 'drafted', does: 'pattern.updateDraft' },
  ] },
  { group: '改 ET 裤子文件（先在“自动改裤长”里设好规则）', items: [
    { say: '裤长加2厘米', when: 'etPants', does: 'pattern.extendPantsHem' },
    { say: '裤长减1.5厘米', when: 'etPants', does: 'pattern.extendPantsHem' },
  ] },
  { group: '画小裁片、缝份', items: [
    { say: '画一个后袋 16x18cm，建成裁片，缝份1cm', when: 'empty', does: 'draw.rectangle' },
    { say: '前片缝份改成1厘米', when: 'drafted', does: 'seam.apply' },
    { say: '把裁片排整齐', when: 'drafted', does: 'piece.arrange' },
  ] },
  { group: '放码', items: [
    { say: '放码：号型 S M L XL，基码 M', when: 'drafted', does: 'grade.setSizes' },
  ] },
  { group: '文件和画面', items: [
    { say: '保存为ET文件', when: 'drafted', does: 'file.savePrj' },
    { say: '导出DXF', when: 'drafted', does: 'file.exportDxf' },
    { say: '全图显示', when: 'drafted', does: 'view.fit' },
    { say: '撤销', when: 'drafted', does: 'history.undo' },
  ] },
  { group: '不知道怎么说时', items: [
    { say: '帮助', when: 'empty', does: 'reply' },
  ] },
]);
const OFFLINE_WORDS = [
  '第一次打开以后，页面的文件就存在这台电脑的浏览器里：没有网络也能打开，打开也更快。纸样文件只在这台电脑上，不会上传。',
  '新版本发布后，联网打开时会在后台下载；下载好了，页面上方会提示“刷新”换用新版本。',
  '装到桌面以后，可以像程序一样从桌面或开始菜单打开，在自己的窗口里用。Chrome、Edge 会出现“安装到桌面”；其他浏览器用菜单里的“安装”或“添加到主屏幕”。',
  '没有网络时，页眉会显示“离线”：页面照常可用，只有接在别处的模型服务连不上，助手改用本机指令。',
];

export function createHelp({ host = document.body, offline = null, tryPhrase = null } = {}) {
  const dialog = document.createElement('dialog');
  dialog.id = 'help-dialog'; dialog.className = 'help-dialog'; dialog.setAttribute('aria-labelledby', 'help-title');
  const tabs = [['keys', '快捷键（和 ET 对照）'], ['assistant', '助手能听懂的话'], ['offline', '离线和安装']];
  dialog.innerHTML = '<header><h2 id="help-title">帮助</h2><button type="button" id="help-close" aria-label="关闭帮助">关闭</button></header>' +
    '<nav class="help-tabs" role="tablist">' + tabs.map(([id, label]) => '<button type="button" role="tab" data-tab="' + id + '" id="help-tab-' + id + '">' + label + '</button>').join('') + '</nav>' +
    '<section data-panel="keys" role="tabpanel"></section><section data-panel="assistant" role="tabpanel"></section><section data-panel="offline" role="tabpanel"></section>';
  host.append(dialog);
  const panel = id => dialog.querySelector('[data-panel="' + id + '"]');
  const keys = panel('keys');
  for (const { group, rows } of SHORTCUTS) {
    const title = document.createElement('h3'); title.textContent = group; keys.append(title);
    const table = document.createElement('table'); table.className = 'help-keys';
    table.innerHTML = '<thead><tr><th>按键</th><th>做什么</th><th>ET 里</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const [key, what, et] of rows) {
      const row = document.createElement('tr');
      for (const [text, kbd] of [[key, true], [what, false], [et || '—', false]]) { const cell = document.createElement('td'); if (kbd) { const k = document.createElement('kbd'); k.textContent = text; cell.append(k); } else cell.textContent = text; row.append(cell); }
      body.append(row);
    }
    table.append(body); keys.append(table);
  }
  for (const note of SHORTCUT_NOTES) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = note; keys.append(p); }
  const assistant = panel('assistant');
  const intro = document.createElement('p'); intro.textContent = '打开右上角的“AI 助手”，照下面的说法打字。助手先给出计划和预演，你确认后才改图，随时可以撤销。没有接模型服务时，助手只认识这类固定的说法。';
  assistant.append(intro);
  for (const { group, items } of PHRASES) {
    const title = document.createElement('h3'); title.textContent = group; assistant.append(title);
    const list = document.createElement('ul'); list.className = 'help-phrases';
    for (const { say } of items) {
      const item = document.createElement('li'), words = document.createElement('q'); words.textContent = say; item.append(words);
      if (tryPhrase) { const button = document.createElement('button'); button.type = 'button'; button.textContent = '填进助手'; button.onclick = () => { close(); tryPhrase(say); }; item.append(button); }
      list.append(item);
    }
    assistant.append(list);
  }
  const offlinePanel = panel('offline');
  const status = document.createElement('p'); status.id = 'help-offline-status'; status.className = 'help-offline-status'; status.setAttribute('role', 'status'); offlinePanel.append(status);
  const install = document.createElement('button'); install.type = 'button'; install.id = 'help-install'; install.textContent = '安装到桌面'; install.hidden = true; install.onclick = () => offline?.install(); offlinePanel.append(install);
  for (const words of OFFLINE_WORDS) { const p = document.createElement('p'); p.textContent = words; offlinePanel.append(p); }
  offline?.subscribe(info => { status.textContent = info.installed ? '已经装在这台电脑上，' + info.text : info.text; status.dataset.state = info.state; install.hidden = !info.installable; });
  function show(tab) {
    for (const [id] of tabs) { const on = id === tab; panel(id).hidden = !on; dialog.querySelector('[data-tab="' + id + '"]').setAttribute('aria-selected', String(on)); }
  }
  dialog.querySelectorAll('[data-tab]').forEach(button => { button.onclick = () => show(button.dataset.tab); });
  const close = () => { if (dialog.open) dialog.close(); };
  dialog.querySelector('#help-close').onclick = close;
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  show('keys');
  return {
    open(tab = 'keys') { show(tab); if (!dialog.open) dialog.showModal(); },
    close, isOpen: () => dialog.open, element: dialog,
  };
}
