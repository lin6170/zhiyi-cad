import { planNewPrj, createNewPrjExport, NEW_PRJ_FORMAT } from './prj-new-export.mjs';

/** Save-dialog entry and preview for writing a complete new ET PRJ from a millimetre project. */
export function createPrjNewPanel({ getProject, canPreview, download, notify, saveDialog }) {
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'prj-new.css'; document.head.append(css);
  const section = document.createElement('section'); section.setAttribute('aria-labelledby', 'prj-save-new-title');
  section.innerHTML = '<h3 id="prj-save-new-title">新建纸样 · 保存为完整 ET PRJ</h3>' +
    '<p>用于从尺寸生成或在毫米工程中绘制的整套纸样，不需要原始 PRJ。裁片净样、内部线、布纹线、文字和逐边缝份写入一个新文件，坐标按 1 cm = 10 mm 换算。</p>' +
    '<p id="prj-save-new-status" class="prj-save-status" role="status"></p><button id="prj-save-new">预览新建 PRJ</button>';
  saveDialog.querySelector('section').before(section);
  const dialog = document.createElement('dialog'); dialog.id = 'prj-new-dialog'; dialog.setAttribute('aria-labelledby', 'prj-new-title');
  dialog.innerHTML = '<h2 id="prj-new-title">新建 ET PRJ · 保存预览</h2><p id="prj-new-message" role="status"></p>' +
    '<table><thead><tr><th>裁片</th><th>轮廓边</th><th>内部线</th><th>文字</th><th>缝份宽度</th><th>对称</th></tr></thead><tbody id="prj-new-rows"></tbody></table>' +
    '<ul id="prj-new-notes"></ul>' +
    '<p class="prj-new-scope">文件为 ' + NEW_PRJ_FORMAT + ' 布局，已用 ET 2017 完成打开、更新缝边、继续画线、保存和重开验收；其他 ET 版本请先用副本核对。净线曲线按 ET 曲线点重新拟合，缝份线按 ET 默认的尖角延长写入，ET 更新缝边后以 ET 的计算结果为准。版型本身仍是演示公式，需师傅确认。</p>' +
    '<div class="pair"><button id="prj-new-cancel">返回编辑</button><button id="prj-new-download" class="primary" disabled>下载 ET PRJ</button></div>';
  document.body.append(dialog);
  const $ = id => document.getElementById(id);
  let prepared = null;
  function describe(report) {
    const parts = [report.pieces.length + ' 个裁片', report.curves + ' 条线（直线 ' + report.lines + '、曲线 ' + report.splines + '）', report.texts + ' 条文字'];
    if (report.seamCurves) parts.push(report.seamCurves + ' 条缝份线');
    if (report.looseCurves || report.looseTexts) parts.push('其中独立线条 ' + report.looseCurves + ' 条、独立文字 ' + report.looseTexts + ' 条');
    return parts.join('，');
  }
  /** Status for the save dialog. Planning is repeated at preview time. */
  function status() {
    const button = $('prj-save-new'), message = $('prj-save-new-status'); button.disabled = true;
    const project = getProject();
    if (!project.entities.length) { message.textContent = '画布为空。请先从尺寸生成纸样或绘制裁片。'; return; }
    if (!canPreview()) { message.textContent = '请先完成或取消当前编辑，并切换到选择或节点工具。'; return; }
    try { const { report } = planNewPrj(project); message.textContent = describe(report) + '可以保存为新的 ET PRJ。'; button.disabled = false; }
    catch (error) { message.textContent = error.message; }
  }
  function open() {
    prepared = null; $('prj-new-download').disabled = true; $('prj-new-rows').replaceChildren(); $('prj-new-notes').replaceChildren();
    try {
      if (!canPreview()) throw new Error('请先完成或取消当前编辑，并切换到选择或节点工具。');
      const project = getProject(), result = createNewPrjExport(project), report = result.report;
      for (const piece of report.pieces) {
        const row = document.createElement('tr');
        for (const value of [piece.name, piece.contourEdges, piece.internalLines, piece.texts, piece.hasSeam ? piece.seamWidthsMm.map(w => w + ' mm').join(' / ') : '无缝份', piece.symmetric ? '对称' : '不对称']) {
          const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell);
        }
        $('prj-new-rows').append(row);
      }
      const notes = [...report.notes, ...report.omitted.map(text => '未写入：' + text + '。')];
      if (report.splines) notes.unshift('曲线转换的最大偏差 ' + report.maxCurveDeviationMm.toFixed(4) + ' mm（上限 0.01 mm）。');
      notes.push(report.reopenChecked ? '已核对：文件可回读，并能由本工具重新导入。' : '已核对：文件可回读。本工具重新导入需要至少一个裁片和一条文字。');
      for (const text of notes) { const item = document.createElement('li'); item.textContent = text; $('prj-new-notes').append(item); }
      $('prj-new-message').textContent = describe(report) + '。文件 ' + report.byteLength + ' 字节，坐标单位 cm。';
      prepared = { snapshot: JSON.stringify(project), bytes: result.bytes, filename: result.filename };
      $('prj-new-download').disabled = false;
    } catch (error) { $('prj-new-message').textContent = error.message; }
    dialog.showModal();
  }
  $('prj-save-new').onclick = () => { saveDialog.close(); open(); };
  $('prj-new-cancel').onclick = () => dialog.close();
  $('prj-new-download').onclick = () => {
    try {
      if (!prepared || !canPreview() || prepared.snapshot !== JSON.stringify(getProject())) throw new Error('工程在预览后已变化，请重新预览。');
      download(prepared.bytes, prepared.filename, 'application/octet-stream'); dialog.close();
      notify('已下载新的 ET PRJ。原工程未改变；后续修改请同时保存 .zycad 工程。');
    } catch (error) { $('prj-new-message').textContent = error.message; $('prj-new-download').disabled = true; }
  };
  dialog.addEventListener('close', () => { prepared = null; });
  return { open, status, isOpen: () => dialog.open, reset: () => { dialog.close(); prepared = null; } };
}
