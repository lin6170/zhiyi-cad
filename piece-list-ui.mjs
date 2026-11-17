/**
 * The piece list: every piece with its areas, perimeter, size and seam allowance, with
 * switches to hide and to lock it, and a table that can be saved for a spreadsheet.
 * Locking goes through the command set, so it can be undone like any other step.
 */
import { pieceList, pieceListCsv } from './piece-info.mjs';

const cm = value => value === null ? '—' : String(Math.round(value) / 10), cm2 = value => value === null ? '—' : String(Math.round(value) / 100);

export function createPieceList({ host, commands, getProject, view, selectPiece, refresh, notify = () => {} }) {
  const dialog = Object.assign(document.createElement('dialog'), { id: 'piece-list-dialog', className: 'piece-list-dialog' });
  dialog.innerHTML = '<form method="dialog"><header><strong>裁片清单</strong><span id="piece-list-total"></span></header>' +
    '<div class="piece-list-scroll"><table><thead><tr><th>序号</th><th>裁片</th><th>布料</th><th>片数</th><th>净样面积<br>cm²</th><th>毛样面积<br>cm²</th><th>净样周长<br>cm</th><th>宽 × 高<br>cm</th><th>缝份<br>cm</th><th>刀口</th><th>显示</th><th>锁定</th></tr></thead><tbody id="piece-list-rows"></tbody></table></div>' +
    '<p class="piece-list-note">面积按画出的轮廓计算；毛样面积是加了缝份之后裁下来的面积。对称的裁片每一片还要再裁一片左右相反的，实际裁的数量是片数的两倍，ET 也是这样算的。“按片数算用料”是每个裁片的毛样面积（没有缝份的按净样）乘以实际裁的数量再相加，不含排料的空隙。点一行可以在画布上选中这个裁片；布料和片数用画线工具里的“裁片属性”修改。</p>' +
    '<footer><button id="piece-list-csv" type="button">导出表格（CSV）</button><button id="piece-list-close" value="close" class="primary">关闭</button></footer></form>';
  host.append(dialog);
  const $ = id => dialog.querySelector('#' + id);
  let chosenId = null;   // the row clicked last; the table is rebuilt whenever the drawing changes, so the mark is kept here
  function fill() {
    const project = getProject(), { pieces, totals } = pieceList(project);
    $('piece-list-total').textContent = pieces.length ? '共 ' + totals.count + ' 种裁片、' + totals.cutCount + ' 片，净样合计 ' + cm2(totals.areaMm2) + ' cm²，按片数算用料 ' + cm2(totals.fabricAreaMm2) + ' cm²' : '画布上还没有裁片';
    $('piece-list-rows').replaceChildren(...pieces.map((piece, index) => {
      const row = document.createElement('tr'); row.dataset.piece = piece.id; row.classList.toggle('chosen', piece.id === chosenId);
      const cell = text => Object.assign(document.createElement('td'), { textContent: text });
      const shown = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !view.hiddenPieces.has(piece.id), title: '在画布上显示这个裁片' }); shown.dataset.role = 'shown';
      const locked = Object.assign(document.createElement('input'), { type: 'checkbox', checked: piece.locked, title: '锁定后不能移动、修改或删除' }); locked.dataset.role = 'locked';
      shown.onchange = () => { if (shown.checked) view.show([piece.id]); else view.hide([piece.id]); };
      locked.onchange = () => {
        try { commands.execute({ schema: 'zhiyi-cad-command/v1', type: 'piece.setLocked', expectedRevision: commands.read().revision, parameters: { groupIds: [piece.id], locked: locked.checked } }); refresh(); }
        catch (error) { locked.checked = !locked.checked; notify(error.message); }
        fill();
      };
      const wrap = input => { const td = document.createElement('td'); td.append(input); td.onclick = event => event.stopPropagation(); return td; };
      row.append(cell(index + 1), cell(piece.name), cell(piece.material), cell(piece.count + (piece.symmetric ? '（对称，共裁 ' + piece.cutPieces + ' 片）' : '')), cell(cm2(piece.areaMm2)), cell(cm2(piece.cutAreaMm2)), cell(cm(piece.perimeterMm)), cell(piece.widthMm === null ? '—' : cm(piece.widthMm) + ' × ' + cm(piece.heightMm)),
        cell(piece.seamWidthsMm ? piece.seamWidthsMm.map(w => w / 10).join(' / ') : '—'), cell(piece.notches || '—'), wrap(shown), wrap(locked));
      row.onclick = () => { chosenId = piece.id; selectPiece(piece.id); fill(); };
      return row;
    }));
    $('piece-list-csv').disabled = !pieces.length;
  }
  $('piece-list-csv').onclick = () => {
    const blob = new Blob([pieceListCsv(getProject())], { type: 'text/csv;charset=utf-8' }), link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: (getProject().name || '纸样') + '-裁片清单.csv' });
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  return { open() { chosenId = null; fill(); if (!dialog.open) dialog.showModal(); }, refresh() { if (dialog.open) fill(); }, element: dialog };
}
