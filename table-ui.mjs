import {findTextTables,tableTextEntries,editTableTexts,tableCsv,tableData} from './table-text.mjs';

export function createTableTextEditor({getProject,getSelection,commit,locate,notify,download}){
  const dialog=document.createElement('dialog');dialog.id='table-editor';dialog.className='table-editor';dialog.setAttribute('aria-labelledby','table-title');
  dialog.innerHTML=`<div class="table-dialog-shell"><header class="table-dialog-header"><div><span class="table-eyebrow">文件里的文字与格线</span><h2 id="table-title">尺寸表文字</h2></div><button type="button" id="table-close" aria-label="关闭表格编辑">×</button></header><div class="table-controls"><label>查找范围<select id="table-scope"><option value="all">整个工程</option><option value="selection">当前选区</option></select></label><label>连接容差 <span id="table-unit"></span><input id="table-tolerance" type="number" min="0" max="1" step="any" value="0.001"></label><button type="button" id="table-rescan">查找表格</button><label class="table-choice">表格候选<select id="table-choice"></select></label><button type="button" id="table-locate">定位表格</button></div><p id="table-summary" class="table-summary" role="status"></p><p class="table-explanation">按现有格线和文字位置整理，不使用图像识别。同格多条文字分别保留；虚线标示缺边，不会补画到纸样。空格不自动添加文字。</p><div class="table-scroll" id="table-grid-wrap"><table id="table-grid"></table></div><section class="table-unresolved" id="table-unresolved" hidden><h3>边界或跨格文字</h3><p>这些文字的位置存在歧义，单独保留，可直接编辑；不猜测所属单元格，也不放入 CSV。表格数据文件会包含它们。</p><div id="table-unresolved-list"></div></section><p id="table-message" class="table-message" role="status"></p><footer class="table-dialog-footer"><div><button type="button" id="table-csv">导出文字 CSV</button><button type="button" id="table-json">导出表格数据</button></div><span id="table-draft-status">没有待应用修改</span><button type="button" id="table-cancel">取消</button><button type="button" id="table-apply" class="primary">应用到纸样</button></footer></div>`;
  document.body.append(dialog);const $=id=>dialog.querySelector('#'+id);
  let candidates=[],active=null,drafts=new Map(),selection=[];
  const setMessage=(message,error=false)=>{$('table-message').textContent=message;$('table-message').classList.toggle('error',error);};
  function pending(){return [...drafts].filter(([id,value])=>tableTextEntries(active||{cells:[],unresolved:[]}).find(e=>e.entityId===id)?.text!==value);}
  function updateDraftStatus(){const n=pending().length;$('table-draft-status').textContent=n?`${n} 项文字待应用`:'没有待应用修改';$('table-apply').disabled=!n;}
  function inputFor(entry,label){
    const wrap=document.createElement('div');wrap.className='table-text-entry';
    const input=document.createElement('input');input.type='text';input.value=drafts.has(entry.entityId)?drafts.get(entry.entityId):entry.text;input.maxLength=10000;input.dataset.entityId=entry.entityId;input.setAttribute('aria-label',label);input.spellcheck=false;
    input.title=entry.sourceOffset===null?'当前工程文字':`来源偏移：${entry.sourceOffset}${entry.originalText===null?'':'\n原文：'+entry.originalText}`;
    if(/[\r\n]/.test(entry.text)){input.readOnly=true;input.title+='\n原对象含换行，本面板只读，避免丢失换行。';}
    input.addEventListener('input',()=>{drafts.set(entry.entityId,input.value);updateDraftStatus();setMessage('应用后保留文字位置和字高，字宽随内容长度调整。可在画布撤销。');});wrap.append(input);
    if(entry.overflows){const note=document.createElement('small');note.textContent='字框跨格，锚点与中心同格';wrap.append(note);}
    return wrap;
  }
  function renderTable(){
    $('table-grid').replaceChildren();$('table-unresolved-list').replaceChildren();$('table-unresolved').hidden=true;
    $('table-locate').disabled=$('table-csv').disabled=$('table-json').disabled=!active;
    if(!active){$('table-summary').textContent='没有找到含定位文字的表格。当前支持与坐标轴平行、至少 2 行 × 2 列的格线表；可框选目标区域后重试。';updateDraftStatus();return;}
    $('table-summary').textContent=`${active.rows} 行 × ${active.columns} 列 · ${active.assignedCount} 项入格文字${active.mergedCellCount?' · '+active.mergedCellCount+' 个合并格':''}${active.openCellCount?' · '+active.openCellCount+' 格缺边':''}${active.unsupportedCellCount?' · '+active.unsupportedCellCount+' 处缺少格线依据':''}${active.unresolved.length?' · '+active.unresolved.length+' 项边界或跨格文字':''}`;
    const head=document.createElement('thead'),hr=document.createElement('tr');hr.append(document.createElement('th'));
    for(let c=0;c<active.columns;c++){const th=document.createElement('th');th.scope='col';th.textContent=`第 ${c+1} 列`;hr.append(th);}head.append(hr);$('table-grid').append(head);
    const body=document.createElement('tbody');
    for(const row of active.cells){const tr=document.createElement('tr'),number=document.createElement('th');number.scope='row';number.textContent=row[0].row+1;tr.append(number);
      for(const cell of row){if(cell.coveredBy)continue;const td=document.createElement('td');td.dataset.row=cell.row;td.dataset.column=cell.column;td.rowSpan=cell.rowSpan;td.colSpan=cell.columnSpan;
        if(!cell.supported){td.className='table-unsupported';td.textContent='缺少格线依据';tr.append(td);continue;}
        const names={top:'上',bottom:'下',left:'左',right:'右'},missing=Object.entries(cell.borders).filter(([,present])=>!present).map(([key])=>key);
        for(const side of missing)td.classList.add('table-missing-'+side);
        if(missing.length){const mark=document.createElement('small');mark.className='table-missing-label';mark.textContent='缺'+missing.map(k=>names[k]).join('、')+'边';td.append(mark);}
        cell.entries.forEach((entry,i)=>td.append(inputFor(entry,`第 ${cell.row+1} 行第 ${cell.column+1} 列文字 ${i+1}`)));
        if(!cell.entries.length){const empty=document.createElement('span');empty.className='table-empty-cell';empty.textContent='—';empty.setAttribute('aria-label','没有原文字');td.append(empty);}tr.append(td);
      }body.append(tr);
    }$('table-grid').append(body);
    if(active.unresolved.length){$('table-unresolved').hidden=false;
      for(const entry of active.unresolved){const row=document.createElement('div');row.className='table-unresolved-row';row.append(inputFor(entry,'边界或跨格文字'));
        const note=document.createElement('span'),cellLabel=cell=>cell?`第 ${cell.row+1} 行第 ${cell.column+1} 列`:'格外或边线上';note.textContent=`锚点：${cellLabel(entry.anchorCell)}；字框中心：${cellLabel(entry.centerCell)}`;row.append(note);$('table-unresolved-list').append(row);}
    }updateDraftStatus();
  }
  function scan(){
    try{
      if(drafts.size&&pending().length){setMessage('请先应用或取消当前修改，再重新查找表格。',true);return;}
      const raw=$('table-tolerance').value;if(!raw.trim())throw new Error('请输入格线连接容差。');
      const ids=$('table-scope').value==='selection'?selection:null;if(ids&&!ids.length)throw new Error('当前没有选区，请关闭窗口后框选表格，或选择整个工程。');
      candidates=findTextTables(getProject(),{tolerance:Number(raw),entityIds:ids});drafts=new Map();
      $('table-choice').replaceChildren(...candidates.map((t,i)=>new Option(`表格 ${i+1} · ${t.rows} 行 × ${t.columns} 列`,String(i))));active=candidates[0]||null;renderTable();setMessage('容差仅用于归类，不移动格线。这里整理的是当前纸样文字，不包含 ET 表格公式或尺寸驱动关系。');
    }catch(error){setMessage(error.message,true);}
  }
  $('table-choice').onchange=()=>{if(pending().length){$('table-choice').value=String(candidates.indexOf(active));setMessage('请先应用或取消当前修改，再切换表格。',true);return;}active=candidates[Number($('table-choice').value)]||null;drafts=new Map();renderTable();};
  $('table-rescan').onclick=scan;
  const close=()=>dialog.close();$('table-close').onclick=$('table-cancel').onclick=close;
  dialog.addEventListener('close',()=>{drafts=new Map();});
  dialog.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();setMessage('请点击“应用到纸样”，再保存工程。');}});
  $('table-apply').onclick=()=>{try{if(!active)return;const result=editTableTexts(getProject(),active,pending().map(([entityId,text])=>({entityId,text})));if(!result.changed)return;commit(result.project);dialog.close();notify(`已更新 ${result.changed} 项纸样文字，可撤销；工程保存仍使用 .zycad。`);}catch(error){setMessage(error.message,true);}};
  $('table-locate').onclick=()=>{if(!active)return;if(pending().length){setMessage('请先应用或取消修改，再定位纸样。',true);return;}const ids=[...active.lineEntityIds,...tableTextEntries(active).map(e=>e.entityId)];dialog.close();locate(ids);};
  const exportCurrent=kind=>{try{if(!active)return;if(pending().length)throw new Error('请先应用修改再导出，确保表格与纸样一致。');editTableTexts(getProject(),active,[]);const name=(getProject().name||'纸样')+'-表格'+(candidates.indexOf(active)+1);if(kind==='csv')download(tableCsv(active),name+'.csv','text/csv;charset=utf-8');else download(JSON.stringify(tableData(active),null,2),name+'.json','application/json');setMessage(kind==='csv'&&active.unresolved.length?`已导出入格文字；${active.unresolved.length} 项边界或跨格文字保留在纸样和表格数据中。`:'已导出当前表格文字。');}catch(error){setMessage(error.message,true);}};
  $('table-csv').onclick=()=>exportCurrent('csv');$('table-json').onclick=()=>exportCurrent('json');
  return {isOpen:()=>dialog.open,open(){selection=[...getSelection()];drafts=new Map();candidates=[];active=null;$('table-choice').replaceChildren();renderTable();$('table-scope').value='all';$('table-unit').textContent=getProject().units==='mm'?'mm':'原始单位';scan();dialog.showModal();}};
}
