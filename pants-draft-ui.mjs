import {draftFields,partFields,defaultDraftInput,validateDraftInput,DRAFT_SCHEMA,DRAFT_COMMAND,defaultGrading,GRADE_FIELDS} from './pants-draft.mjs';
// v76: the choices of the parts that are switched rather than measured
const CHOICE_NOTES={waistband:'一片，对折',fly:'门襟按左前片画',sidePocket:'袋垫布和袋布前后层',backPocket:'嵌线、垫布和袋布'};
const CHOICES={waistband:[[1,'生成'],[0,'不要']],fly:[[1,'生成'],[0,'不要']],sidePocket:[[1,'斜插袋'],[0,'不要']],backPocket:[[1,'单嵌线'],[2,'双嵌线'],[0,'不要']]};
import {bounds} from './geometry.mjs';
export function createPantsDraftPanel({commands,getRevision,download,reveal,savePrj,showGrading=null}){
  const css=document.createElement('link');css.rel='stylesheet';css.href='pants-draft.css';document.head.append(css);
  const dialog=document.createElement('dialog');dialog.id='draft-dialog';dialog.className='draft-dialog';
  dialog.innerHTML='<header><div><p>从尺寸开始 · 无需母版文件</p><h2>自动制版 / 成人基础裤</h2></div><button id="draft-close">关闭</button></header>'+
  '<div class="draft-body"><section class="draft-inputs"><p class="draft-intro">输入人体净量，再设置松量与成衣规格。默认生成整套直筒基础裤：前后裤片、腰头、门襟、里襟、斜插袋、后袋和裤袢；公式为可调整的演示规则，供师傅核对版型。加入画布后可保存为完整的 ET PRJ。</p><label class="draft-unit-label">尺寸单位<select id="draft-units"><option value="10">cm 厘米</option><option value="1">mm 毫米</option></select></label>'+
  '<fieldset><legend>1 · 人体与长度</legend><div id="draft-measurements" class="draft-fields"></div></fieldset><fieldset><legend>2 · 松量与成衣规格</legend><div id="draft-style" class="draft-fields"></div></fieldset>'+
  '<fieldset id="draft-parts-set"><legend>3 · 部件</legend><label class="draft-whole-label">生成内容<select id="draft-whole"><option value="1">整套裤子（前后片、腰头、门襟、里襟、口袋、裤袢）</option><option value="0">只要前后裤片</option></select></label><div id="draft-parts" class="draft-fields"></div></fieldset>'+
  '<fieldset id="draft-grading-set"><legend>4 · 放码</legend><label class="draft-whole-label">放码<select id="draft-grading"><option value="0">不放码（只出这一个码）</option><option value="1">整套放码（各码规则一起写入 ET 文件）</option></select></label><div id="draft-grading-fields" class="draft-fields"><label><span>号型</span><input id="draft-grade-sizes" type="text" spellcheck="false" autocomplete="off"><small>从小到大，用空格分开，含基码</small></label><label><span>基码</span><input id="draft-grade-base" type="text" spellcheck="false" autocomplete="off"><small>上面填的尺寸就是基码的尺寸</small></label></div><p class="draft-grading-note">按纸样自己的公式推出每个点和刀口的放码规则（ET 的尺寸表放码），每个码都和直接按该码尺寸制版比较。保存的 ET 文件只有基码，在 ET 里“推板展开”得到各码；布纹线留在原处（与 ET 相同），打孔、扣位和文字不放码。</p></fieldset>'+
  '<details id="draft-advanced"><summary>5 · 调整制版公式系数</summary><div id="draft-rule-fields" class="draft-fields"></div><p>每项系数都有明确含义；可在右侧查看完整公式和结果。</p></details><details><summary>尺寸方案文件</summary><label>载入本机方案 JSON<input id="draft-file" type="file" accept=".json"></label><button id="draft-defaults">恢复演示尺寸</button></details></section>'+
  '<section class="draft-output"><div class="draft-viewbar"><strong>生成预览</strong><span>净样 · 内部线 · 缝份</span></div><svg id="draft-preview-canvas" role="img" aria-label="由尺寸生成的裤子纸样"></svg><div id="draft-checks"></div><details id="draft-formulas"><summary>计算公式与版型核对项</summary><div id="draft-report"></div><a href="https://freesewing.eu/docs/about/faq/measurements-issues/" target="_blank" rel="noopener noreferrer">量体基准说明参考</a><p>参考链接用于量体说明；本演示公式独立定义，没有采用 Titan 的制版算法。报告记录生成时的几何；画布手工修改后需重新量取。</p></details></section></div>'+
  '<footer><p id="draft-status" role="status">示例尺寸已填写。请调整为需要的数值，再生成纸样。</p><div class="draft-actions"><button id="draft-preview" class="primary">按尺寸生成纸样</button><button id="draft-apply" disabled>加入画布 · 可撤销</button><button id="draft-undo">撤销</button><button id="draft-redo">重做</button><button id="draft-save-plan" disabled>保存尺寸方案</button><button id="draft-show-grading" disabled hidden>看各码叠码</button><button id="draft-reveal" disabled>去画布编辑 / 出图</button><button id="draft-save-prj" disabled>保存为 ET PRJ</button></div><p class="draft-footnote">生成新的可编辑几何，可保存工程、导出 DXF 和 1:1 出图，也可保存为含裁片、文字、缝份、刀口、扣位和打孔的 ET PRJ。</p></footer>';
  document.body.append(dialog);
  const $=id=>dialog.querySelector('#'+id),ns='http://www.w3.org/2000/svg';let plan=null,input=null,appliedRevision=null,appliedGraded=false,scale=10,token=0;
  function message(t,error=false){$('draft-status').textContent=t;$('draft-status').dataset.error=String(error);}
  function sync(){const state=commands.read();$('draft-apply').disabled=!plan||plan.revision!==getRevision();$('draft-save-plan').disabled=!input||!plan;$('draft-undo').disabled=!state.canUndo;$('draft-redo').disabled=!state.canRedo;$('draft-reveal').disabled=appliedRevision===null||!state.entityCount;$('draft-save-prj').disabled=$('draft-reveal').disabled;$('draft-show-grading').hidden=!showGrading;$('draft-show-grading').disabled=$('draft-reveal').disabled||!appliedGraded;}
  function invalidate(){token++;plan=null;input=null;appliedRevision=null;$('draft-preview-canvas').replaceChildren();$('draft-checks').replaceChildren();$('draft-report').replaceChildren();sync();message('尺寸已变化，请重新生成纸样；画布保持原样。');}
  for(const [type,fields] of Object.entries(draftFields))for(const [index,f] of fields.entries()){
    const [key,label,,min,max,hint,unit]=f,parent=$(type==='measurements'?'draft-measurements':index<8?'draft-style':'draft-rule-fields'),box=document.createElement('label');
    const title=document.createElement('span');title.textContent=label;const field=document.createElement('input');field.id='draft-'+key;field.type='number';field.dataset.type=type;field.dataset.key=key;field.dataset.percent=String(unit==='percent');field.oninput=invalidate;
    const help=document.createElement('small');help.textContent=hint;box.append(title,field,help);parent.append(box);
  }
  for(const [key,label,,min,max,hint,unit] of partFields){
    const box=document.createElement('label'),title=document.createElement('span');title.textContent=label;let field;
    if(unit==='choice'){field=document.createElement('select');for(const [value,text] of CHOICES[key]){const o=document.createElement('option');o.value=String(value);o.textContent=text;field.append(o);}field.onchange=invalidate;}
    else{field=document.createElement('input');field.type='number';field.oninput=invalidate;}
    field.id='draft-'+key;field.dataset.type='parts';field.dataset.key=key;const help=document.createElement('small');help.textContent=unit==='choice'?CHOICE_NOTES[key]:hint;box.append(title,field,help);$('draft-parts').append(box);
  }
  // v77: a step for each item of the size table, in the dialog's unit
  for(const [key,,row,,,label] of GRADE_FIELDS){
    const box=document.createElement('label'),title=document.createElement('span');title.textContent=label+'档差';const field=document.createElement('input');field.type='number';field.id='draft-step-'+key;field.dataset.step=key;field.oninput=invalidate;
    const help=document.createElement('small');help.textContent='每大一个码加多少（尺寸表“'+row+'”）';box.append(title,field,help);$('draft-grading-fields').append(box);
  }
  const whole=()=>$('draft-whole').value==='1',partInput=key=>$('draft-'+key),grading=()=>whole()&&$('draft-grading').value==='1';
  const gradingChanged=()=>{$('draft-grading').disabled=!whole();for(const e of $('draft-grading-fields').querySelectorAll('input'))e.disabled=!grading();$('draft-grading-set').dataset.off=String(!grading());};
  const wholeChanged=()=>{for(const [key] of partFields)partInput(key).disabled=!whole();gradingChanged();};
  const stepLimits=()=>{for(const [key] of GRADE_FIELDS){const e=$('draft-step-'+key);e.min=String(-200/scale);e.max=String(200/scale);e.step=String(.1/scale);}};
  $('draft-whole').onchange=()=>{wholeChanged();invalidate();};$('draft-grading').onchange=()=>{gradingChanged();invalidate();};$('draft-grade-sizes').oninput=invalidate;$('draft-grade-base').oninput=invalidate;
  function fill(value){for(const [type,fields] of Object.entries(draftFields))for(const [key,,,min,max,,unit] of fields){const s=unit==='percent'?1:scale,e=$('draft-'+key);e.value=String(Number((value[type][key]/s).toFixed(4)));e.min=String(min/s);e.max=String(max/s);e.step=String(.1/s);}
    const parts=value.parts||defaultDraftInput({parts:true}).parts;$('draft-whole').value=value.parts?'1':'0';
    for(const [key,,,min,max,,unit] of partFields){const e=partInput(key);if(unit==='choice'){e.value=String(parts[key]);continue;}const s=unit==='count'||unit==='percent'?1:scale;e.value=String(Number((parts[key]/s).toFixed(4)));e.min=String(min/s);e.max=String(max/s);e.step=String(unit==='count'?1:.1/s);}
    const g=value.grading||defaultGrading();$('draft-grading').value=value.grading?'1':'0';$('draft-grade-sizes').value=g.sizes.join(' ');$('draft-grade-base').value=g.base;
    for(const [key] of GRADE_FIELDS)$('draft-step-'+key).value=String(Number(((g.steps[key]||0)/scale).toFixed(4)));stepLimits();
    wholeChanged();}
  function read(){
    const value=Object.fromEntries(Object.entries(draftFields).map(([type,fields])=>[type,Object.fromEntries(fields.map(([key,,,,,,unit])=>[key,$('draft-'+key).value===''?NaN:Math.round(Number($('draft-'+key).value)*(unit==='percent'?1:scale)*1000000)/1000000]))]));
    if(grading())value.grading={sizes:$('draft-grade-sizes').value.split(/[\s,，、;；]+/).filter(Boolean),base:$('draft-grade-base').value.trim(),steps:Object.fromEntries(GRADE_FIELDS.map(([key])=>{const v=$('draft-step-'+key).value;return [key,v===''?0:Math.round(Number(v)*scale*1000000)/1000000];}))};
    if(whole())value.parts=Object.fromEntries(partFields.map(([key,,,,,,unit])=>{const e=partInput(key);return [key,e.value===''?NaN:unit==='choice'||unit==='count'||unit==='percent'?Number(e.value):Math.round(Number(e.value)*scale*1000000)/1000000];}));
    return validateDraftInput(value);
  }
  fill(defaultDraftInput({parts:true}));
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
    $('draft-checks').replaceChildren(table);
    // v76: the delivery checks and the cutting list of a whole trouser
    const cm=v=>(v/10).toFixed(2),addTable=(caption,header,rows,cls)=>{const t=document.createElement('table'),h=document.createElement('thead'),b=document.createElement('tbody');if(cls)t.className=cls;h.append(row(header));for(const values of rows)b.append(row(values));const c=document.createElement('caption');c.textContent=caption;t.append(c,h,b);$('draft-checks').append(t);return t;};
    if(report.delivery){const t=addTable('交付检查（按画出的纸样量）',['检查','结果','量得','应为'],report.delivery.map(c=>[c.name,c.statusText,c.value===undefined?'':c.unit==='°'?c.value.toFixed(2)+'°':c.unit==='mm'?cm(c.value)+' cm':String(c.value),c.target===undefined?'':c.unit==='°'?c.target+'°':c.unit==='mm'?cm(c.target)+' cm':String(c.target)]),'draft-delivery');[...t.tBodies[0].rows].forEach((tr,i)=>{tr.dataset.status=report.delivery[i].status;if(report.delivery[i].note)tr.title=report.delivery[i].note;});}
    if(report.cutList)addTable('裁片清单（共 '+report.cutList.reduce((s,c)=>s+c.pieces,0)+' 片）',['裁片','布料','片数','实裁'],report.cutList.map(c=>[c.name+(c.gross?'（毛样）':'')+(c.shrink?'（缩水 经 '+c.shrink.warp+'%、纬 '+c.shrink.weft+'%）':''),c.material,c.count+(c.symmetric?'（对称）':''),String(c.pieces)]),'draft-cutlist');
    // v77: every size of the grading, made by the rules as ET makes it, against the size drafted directly; its delivery checks
    if(report.grading){const g=report.grading,steps=(g.sizes||[]).map(s=>s.base?[s.label+'（基码）','—','—','']:[s.label,s.maxDifferenceMm.toFixed(2)+' mm',s.delivery.failed.length?'不通过：'+s.delivery.failed.join('、'):s.delivery.review.length?s.delivery.passed+' 项通过；需核对：'+s.delivery.review.join('、'):'全部 '+s.delivery.passed+' 项通过',[...(s.worstPiece?['最大处：'+s.worstPiece+' · '+String(s.worstLine).replace(/^.*· /,'')]:[]),...(s.warnings||[])].join('；')]);
      const t=addTable('整套放码：尺寸表 '+g.rows.length+' 项，'+g.rules+' 个点、'+g.notchRules+' 个刀口的放码规则',['号型','和直接按该码制版比','交付检查','说明'],steps,'draft-grading-table');
      [...t.tBodies[0].rows].forEach((tr,i)=>{const s=g.sizes[i];tr.dataset.status=s.base?'ok':s.delivery.failed.length?'fail':s.maxDifferenceMm>1?'review':'ok';});}
    const seam=document.createElement('p');seam.className='draft-review';seam.textContent='内缝：前 '+(report.pieces[0].inseamMm/10).toFixed(2)+' cm / 后 '+(report.pieces[1].inseamMm/10).toFixed(2)+' cm；差 '+report.inseamDifferenceMm.toFixed(2)+' mm，待师傅确认吃势或修顺。';$('draft-checks').append(seam);
    $('draft-report').replaceChildren();for(const text of [...report.formulas,...report.notes]){const p=document.createElement('p');p.textContent=text;$('draft-report').append(p);}
  }
  $('draft-preview').onclick=()=>{try{input=read();plan=commands.preview({schema:'zhiyi-cad-command/v1',type:DRAFT_COMMAND,expectedRevision:getRevision(),parameters:input});render(plan);message('已从尺寸计算 '+(plan.summary.newPieces||2)+' 片新纸样'+(plan.summary.report.grading?'，并整套放码（号型 '+plan.summary.report.grading.sizes.map(s=>s.label).join('、')+'）':'')+'，当前为预览。'+(commands.read().entityCount?'加入后会放在现有图形右侧，保留原图。':'可以加入空白画布继续编辑。'));sync();}catch(e){plan=null;input=null;sync();message(e.message,true);}};
  $('draft-apply').onclick=()=>{try{const count=plan.summary.newPieces||2;appliedGraded=Boolean(plan.summary.report.grading);commands.apply(plan.id);appliedRevision=getRevision();message('已加入 '+count+' 片新纸样，可一次撤销。'+(appliedGraded?'放码已一起加入：点“看各码叠码”在放码面板里看各码；保存的 ET PRJ 里有尺寸表和放码规则。':'')+'可直接保存为 ET PRJ，或前往画布改线、保存工程、导出 DXF 和出图。');sync();}catch(e){sync();message(e.message,true);}};
  for(const [id,type] of [['draft-undo','history.undo'],['draft-redo','history.redo']])$(id).onclick=()=>{try{commands.execute({schema:'zhiyi-cad-command/v1',type,expectedRevision:getRevision(),parameters:{}});message(type==='history.undo'?'已撤销，画布恢复；预览仍保留供比较。':'已重做，生成纸样恢复。');sync();}catch(e){message(e.message,true);}};
  $('draft-save-plan').onclick=()=>{if(input&&plan)download(JSON.stringify({schema:DRAFT_SCHEMA,units:'mm',input,report:plan.summary.report},null,2),'直筒裤-尺寸与演示公式.json','application/json');};
  $('draft-units').onchange=()=>{const previous=scale;scale=Number($('draft-units').value);for(const [type,fields] of Object.entries(draftFields))for(const [key,,,min,max,,unit] of fields){const e=$('draft-'+key),s=unit==='percent'?1:scale;if(unit!=='percent'&&e.value!=='')e.value=String(Number((Number(e.value)*previous/scale).toFixed(4)));e.min=String(min/s);e.max=String(max/s);e.step=String(.1/s);}
    for(const [key,,,min,max,,unit] of partFields){if(unit==='choice'||unit==='count'||unit==='percent')continue;const e=partInput(key);if(e.value!=='')e.value=String(Number((Number(e.value)*previous/scale).toFixed(4)));e.min=String(min/scale);e.max=String(max/scale);e.step=String(.1/scale);}
    for(const [key] of GRADE_FIELDS){const e=$('draft-step-'+key);if(e.value!=='')e.value=String(Number((Number(e.value)*previous/scale).toFixed(4)));}stepLimits();invalidate();};
  $('draft-defaults').onclick=()=>{fill(defaultDraftInput({parts:true}));invalidate();message('已恢复示例尺寸；这不是个人量体数据。');};
  $('draft-file').onchange=async event=>{const current=++token,file=event.target.files[0];if(!file)return;try{if(file.size>100000)throw Error('尺寸方案文件过大。');const data=JSON.parse(await file.text());if(current!==token)return;if(data.schema!==DRAFT_SCHEMA||data.units!=='mm')throw Error('不是此版本的尺寸方案。');const value=validateDraftInput(data.input);fill(value);invalidate();message('尺寸方案已载入，请生成纸样。');}catch(e){if(current===token)message(e.message,true);}finally{event.target.value='';}};
  $('draft-close').onclick=()=>dialog.close();$('draft-reveal').onclick=()=>{dialog.close();reveal();};$('draft-save-prj').onclick=()=>{dialog.close();savePrj();};$('draft-show-grading').onclick=()=>{dialog.close();showGrading?.();};
  return {open(){sync();dialog.showModal();},isOpen:()=>dialog.open,reset(){invalidate();dialog.close();}};
}
