export function createPrjWritebackPanel({ getProject, getSession, canPreview, download, notify }) {
  const $ = id => document.getElementById(id);
  const dialog = $('prj-writeback-dialog'); let plan = null, session = null;
  $('prj-writeback-open').onclick = () => {
    plan = null; session = null; $('prj-writeback-download').disabled = true;
    $('prj-writeback-rows').replaceChildren(); $('prj-writeback-message').textContent = '';
    try {
      if (!canPreview()) throw new Error('请先完成或取消当前编辑，并切换到选择或节点工具。');
      session = getSession();
      if (!session) throw new Error('请直接打开支持的原始 PRJ 后修改标注；恢复记录或工程文件不包含原始 PRJ 字节。');
      plan = session.preview(getProject());
      for (const change of plan.changes) {
        const row = document.createElement('tr');
        for (const value of [change.before, change.after]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
        $('prj-writeback-rows').append(row);
      }
      $('prj-writeback-message').textContent = `${plan.changedAnnotations} 项标注可回存。原始文件保留，下载为独立 PRJ。`;
      $('prj-writeback-download').disabled = false;
    } catch (error) { $('prj-writeback-message').textContent = error.message; }
    dialog.showModal();
  };
  $('prj-writeback-cancel').onclick = () => dialog.close();
  $('prj-writeback-download').onclick = () => {
    try {
      if (!session || session !== getSession() || !canPreview()) throw new Error('工程状态已变化，请重新预览。');
      const bytes = session.export(getProject(), plan);
      const name = session.filename.replace(/\.prj$/i, '').replace(/[<>:"/\\|?*]/g, '_') + '-标注修改.prj';
      download(bytes, name, 'application/octet-stream'); dialog.close();
      notify('已下载 PRJ 标注副本。请在 ET 核对后使用；工程保存状态保持不变。');
    } catch (error) { $('prj-writeback-message').textContent = error.message; $('prj-writeback-download').disabled = true; }
  };
  dialog.addEventListener('close', () => { plan = null; session = null; });
  return { isOpen: () => dialog.open, reset: () => { dialog.close(); plan = null; session = null; } };
}
