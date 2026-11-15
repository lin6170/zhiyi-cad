import {draftFields,defaultDraftInput,validateDraftInput,DRAFT_SCHEMA,DRAFT_COMMAND} from './pants-draft.mjs';
import {bounds} from './geometry.mjs';
export function createPantsDraftPanel({commands,getRevision,download,reveal,savePrj}){
  const css=document.createElement('link');css.rel='stylesheet';css.href='pants-draft.css';document.head.append(css);
  const dialog=document.createElement('dialog');dialog.id='draft-dialog';dialog.className='draft-dialog';
  dialog.innerHTML='<header><div><p>从尺寸开始 · 无需母版文件</p><h2>自动制版 / 成人基础裤</h2></div><button id="draft-close">关闭</button></header>'+
  '<div class="draft-body"><section class="draft-inputs"><p class="draft-intro">输入人体净量，再设置松量与成衣规格。默认生成直筒基础裤；公式为可调整的演示规则，供师傅核对版型。加入画布后可保存为完整的 ET PRJ。</p><label class="draft-unit-label">尺寸单位<select id="draft-units"><option value="10">cm 厘米</option><option value="1">mm 毫米</option></select></label>'+
  '<fieldset><legend>1 · 人体与长度</legend><div id="draft-measurements" class="draft-fields"></div></fieldset><fieldset><legend>2 · 松量与成衣规格</legend><div id="draft-style" class="draft-fields"></div></fieldset>'+
  '<details id="draft-advanced"><summary>3 · 调整制版公式系数</summary><div id="draft-rule-fields" class="draft-fields"></div><p>每项系数都有明确含义；可在右侧查看完整公式和结果。</p></details><details><summary>尺寸方案文件</summary><label>载入本机方案 JSON<input id="draft-file" type="file" accept=".json"></label><button id="draft-defaults">恢复演示尺寸</button></details></section>'+
  '<section class="draft-output"><div class="draft-viewbar"><strong>生成预览</strong><span>净样 · 内部线 · 缝份</span></div><svg id="draft-preview-canvas" role="img" aria-label="由尺寸生成的前后裤片"></svg><div id="draft-checks"></div><details id="draft-formulas"><summary>计算公式与版型核对项</summary><div id="draft-report"></div><a href="https://freesewing.eu/docs/about/faq/measurements-issues/" target="_blank" rel="noopener noreferrer">量体基准说明参考</a><p>参考链接用于量体说明；本演示公式独立定义，没有采用 Titan 的制版算法。报告记录生成时的几何；画布手工修改后需重新量取。</p></details></section></div>'+
  '<footer><p id="draft-status" role="status">示例尺寸已填写。请调整为需要的数值，再生成纸样。</p><div class="draft-actions"><button id="draft-preview" class="primary">按尺寸生成纸样</button><button id="draft-apply" disabled>加入画布 · 可撤销</button><button id="draft-undo">撤销</button><button id="draft-redo">重做</button><button id="draft-save-plan" disabled>保存尺寸方案</button><button id="draft-reveal" disabled>去画布编辑 / 出图</button><button id="draft-save-prj" disabled>保存为 ET PRJ</button></div><p class="draft-footnote">生成新的可编辑几何，可保存工程、导出 DXF 和 1:1 出图，也可保存为含裁片、文字和缝份的 ET PRJ。</p></footer>';
  document.body.append(dialog);
  const $=id=>dialog.querySelector('#'+id),ns='http://www.w3.org/2000/svg';let plan=null,input=null,appliedRevision=null,scale=10,token=0;
  function message(t,error=false){$('draft-status').textContent=t;$('draft-status').dataset.error=String(error);}
  function sync(){const state=commands.read();$('draft-apply').disabled=!plan||plan.revision!==getRevision();$('draft-save-plan').disabled=!input||!plan;$('draft-undo').disabled=!state.canUndo;$('draft-redo').disabled=!state.canRedo;$('draft-reveal').disabled=appliedRevision===null||!state.entityCount;$('draft-save-prj').disabled=$('draft-reveal').disabled;}
  function invalidate(){token++;plan=null;input=null;appliedRevision=null;$('draft-preview-canvas').replaceChildren();$('draft-checks').replaceChildren();$('draft-report').replaceChildren();sync();message('尺寸已变化，请重新生成纸样；画布保持原样。');}
  for(const [type,fields] of Object.entries(draftFields))for(const [index,f] of fields.entries()){
    const [key,label,,min,max,hint,unit]=f,parent=$(type==='measurements'?'draft-measurements':index<8?'draft-style':'draft-rule-fields'),box=document.createElement('label');
    const title=document.createElement('span');title.textContent=label;const field=document.createElement('input');field.id='draft-'+key;field.type='number';field.dataset.type=type;field.dataset.key=key;field.dataset.percent=String(unit==='percent');field.oninput=invalidate;
    const help=document.createElement('small');help.textContent=hint;box.append(title,field,help);parent.append(box);
  }
  function fill(value){for(const [type,fields] of Object.entries(draftFields))for(const [key,,,min,max,,unit] of fields){const s=unit==='percent'?1:scale,e=$('draft-'+key);e.value=String(Number((value[type][key]/s).toFixed(4)));e.min=String(min/s);e.max=String(max/s);e.step=String(.1/s);}}
  function read(){return validateDraftInput(Object.fromEntries(Object.entries(draftFields).map(([type,fields])=>[type,Object.fromEntries(fields.map(([key,,,,,,unit])=>[key,$('draft-'+key).value===''?NaN:Math.round(Number($('draft-'+key).value)*(unit==='percent'?1:scale)*1000000)/1000000]))])));}
  fill(defaultDraftInput());
  function render(result){
    const svg=$('draft-preview-canvas');svg.replaceChildren();const entities=result.changes.map(c=>c.after),b=bounds(entities),pad=20;
    svg.setAttribute('viewBox',[b.minX-pad,-b.maxY-pad,b.width+2*pad,b.height+2*pad].join(' '));
    for(const e of entities){
      if(e.type==='text'){const t=document.createElementNS(ns,'text');t.setAttribute('x',e.points[0].x);t.setAttribute('y',-e.points[0].y);t.setAttribute('font-size',e.height);t.setAttribute('fill','#ced9d1');t.textContent=e.text;svg.append(t);continue;}
      const p=document.createElementNS(ns,'path');p.setAttribute('d',e.points.map((v,i)=>(i?'L':'M')+v.x+' '+(-v.y)).join(' ')+(e.closed?' Z':''));p.setAttribute('fill','none');p.setAttribute('stroke',e.layer==='seam'?'#eeb474':e.layer==='grain'?'#91b889':e.layer==='internal'?'#65c4d3':'#e8eee7');p.setAttribute('stroke-width',e.layer==='outline'?'1.7':'1');p.setAttribute('vector-effect','non-scaling-stroke');p.dataset.draftPart=e.layer;svg.append(p);
    }
    const report=result.summary.report,table=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody');
    const row=values=>{const tr=document.createElement('tr');for(const v of values){const td=document.createElement('td');td.textContent=v;tr.append(td);}return tr;};
    head.append(row(['生成时几何核对（cm）','目标','生成结果']));for(const c of report.checks)body.append(row([c.name,(c.target/10).toFixed(2),(c.actual/10).toFixed(2)]));table.append(head,body);
    $('draft-checks').replaceChildren(table);const seam=document.createElement('p');seam.className='draft-review';seam.textContent='内缝：前 '+(report.pieces[0].inseamMm/10).toFixed(2)+' cm / 后 '+(report.pieces[1].inseamMm/10).toFixed(2)+' cm；差 '+report.inseamDifferenceMm.toFixed(2)+' mm，待师傅确认吃势或修顺。';$('draft-checks').append(seam);
    $('draft-report').replaceChildren();for(const text of [...report.formulas,...report.notes]){const p=document.createElement('p');p.textContent=text;$('draft-report').append(p);}
  }
  $('draft-preview').onclick=()=>{try{input=read();plan=commands.preview({schema:'zhiyi-cad-command/v1',type:DRAFT_COMMAND,expectedRevision:getRevision(),parameters:input});render(plan);message('已从尺寸计算两片新纸样，当前为预览。'+(commands.read().entityCount?'加入后会放在现有图形右侧，保留原图。':'可以加入空白画布继续编辑。'));sync();}catch(e){plan=null;input=null;sync();message(e.message,true);}};
  $('draft-apply').onclick=()=>{try{commands.apply(plan.id);appliedRevision=getRevision();message('已加入两片新纸样，可一次撤销。可直接保存为 ET PRJ，或前往画布改线、保存工程、导出 DXF 和出图。');sync();}catch(e){sync();message(e.message,true);}};
  for(const [id,type] of [['draft-undo','history.undo'],['draft-redo','history.redo']])$(id).onclick=()=>{try{commands.execute({schema:'zhiyi-cad-command/v1',type,expectedRevision:getRevision(),parameters:{}});message(type==='history.undo'?'已撤销，画布恢复；预览仍保留供比较。':'已重做，生成纸样恢复。');sync();}catch(e){message(e.message,true);}};
  $('draft-save-plan').onclick=()=>{if(input&&plan)download(JSON.stringify({schema:DRAFT_SCHEMA,units:'mm',input,report:plan.summary.report},null,2),'直筒裤-尺寸与演示公式.json','application/json');};
  $('draft-units').onchange=()=>{const previous=scale;scale=Number($('draft-units').value);for(const [type,fields] of Object.entries(draftFields))for(const [key,,,min,max,,unit] of fields){const e=$('draft-'+key),s=unit==='percent'?1:scale;if(unit!=='percent'&&e.value!=='')e.value=String(Number((Number(e.value)*previous/scale).toFixed(4)));e.min=String(min/s);e.max=String(max/s);e.step=String(.1/s);}invalidate();};
  $('draft-defaults').onclick=()=>{fill(defaultDraftInput());invalidate();message('已恢复示例尺寸；这不是个人量体数据。');};
  $('draft-file').onchange=async event=>{const current=++token,file=event.target.files[0];if(!file)return;try{if(file.size>100000)throw Error('尺寸方案文件过大。');const data=JSON.parse(await file.text());if(current!==token)return;if(data.schema!==DRAFT_SCHEMA||data.units!=='mm')throw Error('不是此版本的尺寸方案。');const value=validateDraftInput(data.input);fill(value);invalidate();message('尺寸方案已载入，请生成纸样。');}catch(e){if(current===token)message(e.message,true);}finally{event.target.value='';}};
  $('draft-close').onclick=()=>dialog.close();$('draft-reveal').onclick=()=>{dialog.close();reveal();};$('draft-save-prj').onclick=()=>{dialog.close();savePrj();};
  return {open(){sync();dialog.showModal();},isOpen:()=>dialog.open,reset(){invalidate();dialog.close();}};
}
