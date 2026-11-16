import { parsePrj } from './prj-parser.mjs';
import { createNewPrjExport } from './prj-new-export.mjs';
import { convertPrjToEditable, checkRewrite, EDITABLE_SOURCE_FORMAT } from './prj-editable.mjs';

/**
 * An opened ET file is a read-only view. A bar over the canvas offers to turn it into an editable
 * millimetre project; a dialog first shows what will be carried over and what will not. Nothing is
 * replaced before the user confirms, and the ET file itself is never changed.
 */
export function createPrjEditablePanel({ host, getProject, getSource, canReplace, load, notify }) {
  const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'prj-editable.css' }); document.head.append(css);
  const bar = document.createElement('div'); bar.id = 'prj-editable-bar'; bar.className = 'prj-editable-bar'; bar.hidden = true; bar.setAttribute('role', 'status');
  bar.innerHTML = '<span>这个 ET 文件现在只能查看。转成可编辑工程后，可以用全部工具修改，并另存为 ET PRJ；原文件不会改动。</span><button id="prj-editable-open" type="button" class="primary">转成可编辑工程</button><button id="prj-editable-dismiss" type="button" aria-label="关闭这条提示">×</button>';
  host.append(bar);
  const dialog = document.createElement('dialog'); dialog.id = 'prj-editable-dialog'; dialog.setAttribute('aria-labelledby', 'prj-editable-title');
  dialog.innerHTML = '<h2 id="prj-editable-title">把 ET 文件转成可编辑工程</h2><p id="prj-editable-message" role="status"></p>' +
    '<div class="prj-editable-scroll"><table><thead><tr><th>裁片</th><th>轮廓边</th><th>内部线</th><th>文字</th><th>缝份</th></tr></thead><tbody id="prj-editable-rows"></tbody></table></div>' +
    '<ul id="prj-editable-notes"></ul>' +
    '<p class="prj-editable-scope">转换得到的是一份新的毫米工程（1 cm = 10 mm），曲线保留 ET 里原来的曲线点。缝份按每条轮廓边上记录的宽度重新生成；ET 的切角、台阶角、反转角这三种缝边角处理会带入，其他类型的角处理还不认识，有那类转角的裁片，缝边线在转角处会和原文件不同。刀口按原来的位置和方向带入；辅助线保持辅助线。</p>' +
    '<div class="pair"><button id="prj-editable-cancel" type="button">取消</button><button id="prj-editable-confirm" type="button" class="primary" disabled>转换并打开</button></div>';
  document.body.append(dialog);
  const $ = id => document.getElementById(id);
  let prepared = null, dismissed = null;
  const applicable = () => { const project = getProject(), source = getSource(); return Boolean(source?.bytes && project?.units === 'unknown' && project.metadata?.format === EDITABLE_SOURCE_FORMAT); };
  function refresh() { bar.hidden = !applicable() || dismissed === getSource(); }
  const cell = (row, value) => { const td = document.createElement('td'); td.textContent = String(value); row.append(td); return td; };
  const widths = list => list.map(w => w + ' mm').join(' / ');
  function seamText(seam) {
    if (!seam) return '没有缝份';
    if (seam.none) return '宽度为 0';
    if (!seam.rebuilt) return '没有重建：' + seam.reason;
    const difference = seam.writtenVsOriginalMm, treated = seam.corners ? [['切角', seam.corners.cut], ['台阶角', seam.corners.step], ['反转角', seam.corners.fold]].filter(item => item[1]).map(item => item[0] + ' ' + item[1]).join('、') : '';
    return widths(seam.widthsMm) + (treated ? '；' + treated : '') + (seam.cornersNotCarried ? '；' + seam.cornersNotCarried + ' 个角处理没有带入' : '')
      + (difference === undefined ? '' : difference <= 1 ? '；与原缝边线一致' : '；与原缝边线最大相差 ' + difference + ' mm');
  }
  function open() {
    prepared = null; $('prj-editable-confirm').disabled = true; $('prj-editable-rows').replaceChildren(); $('prj-editable-notes').replaceChildren();
    try {
      if (!applicable()) throw new Error('当前打开的不是可以转换的 ET 文件。');
      const source = getSource(), parsed = parsePrj(source.bytes, source.filename), result = convertPrjToEditable(source.bytes, parsed);
      checkRewrite(source.bytes, parsed, result.project, result.report, { createExport: project => createNewPrjExport(project), parse: parsePrj });
      const report = result.report;
      for (const piece of report.pieces) { const row = document.createElement('tr'); for (const value of [piece.name, piece.contourEdges, piece.internalLines, piece.texts]) cell(row, value); const seam = cell(row, seamText(piece.seam)); if (piece.seam && !piece.seam.none && (!piece.seam.rebuilt || piece.seam.writtenVsOriginalMm > 1 || piece.seam.cornersNotCarried)) seam.className = 'prj-editable-warn'; $('prj-editable-rows').append(row); }
      const notes = [...report.notes];
      notes.unshift(report.rewrite.possible ? '转换后的工程可以整套另存为 ET PRJ。' + (report.rewrite.seamPiecesCompared ? report.rewrite.seamPiecesCompared + ' 个裁片的缝边线已和原文件比对，' + report.rewrite.seamPiecesWithin1Mm + ' 个一致（相差不超过 1 mm）。' : '') : '转换后的工程现在还不能另存为 ET PRJ：' + report.rewrite.reason);
      if (report.curves.splines) notes.push('曲线 ' + report.curves.splines + ' 条，按 ET 原来的曲线点重新计算，控制点与文件里的相差不超过 ' + report.curves.refittedMaxDifferenceMm.toFixed(3) + ' mm。');
      const joined = report.pieces.filter(p => p.joinedEnds && p.largestGapClosedMm >= .005); if (joined.length) notes.push('有 ' + joined.length + ' 个裁片的轮廓线端点没有完全对上，已对齐，最大移动 ' + Math.max(...joined.map(p => p.largestGapClosedMm)).toFixed(2) + ' mm。');
      for (const text of notes) { const item = document.createElement('li'); item.textContent = text; $('prj-editable-notes').append(item); }
      $('prj-editable-message').textContent = report.pieces.length + ' 个裁片' + (report.piecesFailed.length ? '（另有 ' + report.piecesFailed.length + ' 个没有建成裁片）' : '') + '，' + (report.curves.lines + report.curves.splines) + ' 条线，' + report.texts + ' 条文字，' + report.totals.seams + ' 个裁片带缝份。';
      prepared = { source, project: result.project, report }; $('prj-editable-confirm').disabled = false;
    } catch (error) { $('prj-editable-message').textContent = '不能转换：' + error.message; }
    dialog.showModal();
  }
  $('prj-editable-open').onclick = open;
  $('prj-editable-dismiss').onclick = () => { dismissed = getSource(); refresh(); };
  $('prj-editable-cancel').onclick = () => dialog.close();
  $('prj-editable-confirm').onclick = () => {
    if (!prepared || prepared.source !== getSource()) { $('prj-editable-message').textContent = '打开的文件已经变了，请重新转换。'; $('prj-editable-confirm').disabled = true; return; }
    if (!canReplace()) return;
    const { project, report } = prepared; project.name = (project.name || '未命名纸样').replace(/\.prj$/i, '') + '（可编辑）';
    dialog.close(); load(project);
    notify('已转成可编辑工程：' + report.pieces.length + ' 个裁片。原来的 ET 文件没有改动；修改后用“保存 PRJ”另存为新的 ET 文件，并保存 .zycad 工程。');
  };
  dialog.addEventListener('close', () => { prepared = null; });
  return { refresh, open, isOpen: () => dialog.open, reset: () => { if (dialog.open) dialog.close(); prepared = null; dismissed = null; refresh(); } };
}
