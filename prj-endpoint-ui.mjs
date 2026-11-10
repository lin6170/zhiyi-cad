export function createPrjEndpointPanel({getProject,getSession,canPreview,selectLine,download,notify}) {
  const $=id=>document.getElementById(id),dialog=$('prj-endpoint-dialog');
  let renderedSession=null,session=null,plan=null;
  $('prj-endpoint-locate').onclick=()=>{const entry=getSession()?.eligibleLines.find(e=>e.id===$('prj-endpoint-line').value);if(entry)selectLine(entry.id);};
  $('prj-endpoint-open').onclick=()=>{
    session=null;plan=null;$('prj-endpoint-download').disabled=true;$('prj-endpoint-rows').replaceChildren();
    try{
      if(!canPreview())throw new Error('请先完成当前编辑，并切换到选择或节点工具。');
      session=getSession();if(!session)throw new Error('请直接打开支持的原始 PRJ；恢复记录或工程文件不包含原始字节。');
      plan=session.preview(getProject());
      const coordinate=p=>`X ${p.x}\nY ${p.y}`;
      for(const change of plan.changes){const row=document.createElement('tr');for(const value of [change.name+' · 端点 '+(change.endpointIndex+1),coordinate(change.before),coordinate(change.requested),coordinate(change.stored)]){const td=document.createElement('td');td.textContent=value;row.append(td);}$('prj-endpoint-rows').append(row);}
      $('prj-endpoint-message').textContent=`1 个端点可回存。坐标为原始单位，物理比例未确认。写入后的坐标取整误差：${plan.changes[0].roundingError.toExponential(3)} 原始单位。`;
      $('prj-endpoint-download').disabled=false;
    }catch(error){$('prj-endpoint-message').textContent=error.message;}
    dialog.showModal();
  };
  $('prj-endpoint-cancel').onclick=()=>dialog.close();
  $('prj-endpoint-download').onclick=()=>{
    try{
      if(!session||session!==getSession()||!canPreview())throw new Error('工程状态已变化，请重新预览。');
      const bytes=session.export(getProject(),plan),name=session.filename.replace(/\.prj$/i,'').replace(/[<>:"/\\|?*]/g,'_')+'-端点修改.prj';
      download(bytes,name,'application/octet-stream');dialog.close();notify('已下载端点修改 PRJ 副本。请在 ET 核对，工程未保存状态保持不变。');
    }catch(error){$('prj-endpoint-message').textContent=error.message;$('prj-endpoint-download').disabled=true;}
  };
  dialog.addEventListener('close',()=>{session=null;plan=null;});
  return {
    isOpen:()=>dialog.open,
    reset:()=>{dialog.close();session=null;plan=null;renderedSession=null;},
    refresh(){
      const imported=getProject().metadata?.format?.startsWith('ET');$('prj-endpoint-tools').hidden=!imported;
      const current=getSession();if(current===renderedSession&&$('prj-endpoint-line').options.length)return;renderedSession=current;
      const entries=current?.eligibleLines||[]; $('prj-endpoint-line').replaceChildren();
      for(const entry of entries){const option=document.createElement('option');option.value=entry.id;option.textContent=entry.name;$('prj-endpoint-line').append(option);}
      if(!entries.length){const option=document.createElement('option');option.textContent='没有符合范围的独立直线';$('prj-endpoint-line').append(option);}
      $('prj-endpoint-locate').disabled=!entries.length;$('prj-endpoint-line').disabled=!entries.length;
      $('prj-endpoint-hint').textContent=current?`${entries.length} 条独立直线可试验。选择后用节点坐标或拖动修改一个端点，再预览回存。`:'需直接打开原始 PRJ；当前来源不支持端点回存。';
    },
  };
}
