export function createPrjLinePanel({getProject,getSession,canPreview,download,notify}) {
  const $=id=>document.getElementById(id),dialog=$('prj-line-dialog');
  let session=null,plan=null;
  function open() {
    session=null;plan=null;$('prj-line-download').disabled=true;$('prj-line-rows').replaceChildren();
    try {
      if(!canPreview())throw new Error('请先完成当前编辑，并切换到选择或节点工具。');
      session=getSession();if(!session)throw new Error('请直接打开支持的原始 PRJ；工程文件和恢复记录不包含原始字节。');
      plan=session.preview(getProject());
      const coordinate=points=>points.map((point,index)=>`${index?'终点':'起点'} X ${point.x} / Y ${point.y}`).join('\n');
      for(const line of plan.additions) {
        const row=document.createElement('tr');
        for(const value of [line.name,coordinate(line.requested),coordinate(line.stored)]) {
          const cell=document.createElement('td');cell.textContent=value;row.append(cell);
        }
        $('prj-line-rows').append(row);
      }
      const error=Math.max(...plan.additions.map(line=>line.roundingError));
      $('prj-line-message').textContent=`${plan.addedLines} 条新增直线可回存。最大坐标取整误差：${error.toExponential(3)} 原始单位。物理比例尚未确认。`;
      $('prj-line-download').disabled=false;
    } catch(error) { $('prj-line-message').textContent=error.message; }
    dialog.showModal();
  }
  $('prj-line-cancel').onclick=()=>dialog.close();
  $('prj-line-download').onclick=()=>{
    try {
      if(!session||session!==getSession()||!canPreview())throw new Error('工程状态已变化，请重新预览。');
      const bytes=session.export(getProject(),plan);
      const filename=session.filename.replace(/\.prj$/i,'').replace(/[<>:"/\\|?*]/g,'_')+'-新增直线.prj';
      download(bytes,filename,'application/octet-stream');dialog.close();
      notify('已下载新增直线 PRJ 副本。请在 ET 核对；工程未保存状态保持不变。');
    } catch(error) { $('prj-line-message').textContent=error.message;$('prj-line-download').disabled=true; }
  };
  dialog.addEventListener('close',()=>{session=null;plan=null;});
  return {open,isOpen:()=>dialog.open,reset:()=>{dialog.close();session=null;plan=null;}};
}
