import { createGradingPlan, normalizeGradingPlan, gradePoints, gradedDisplacements, evaluateGradingPlan, applyGradingPlan, gradingResults, coincidentGradePoints } from './grading.mjs';
import { toDxf } from './geometry.mjs';
const colors=['#4da6ce','#d78cb5','#d89545','#77aa69','#a28ad4','#d97465','#5bb4a8','#9b9953','#6881cd','#b7799e','#a9a55e','#80a4a1'];
export function createGradingPanel({getProject,getSelection,commit,setTool,getTool,render,fit,notify,download,getDxfOptions=()=>({})}){
  const $=id=>document.getElementById(id),clone=value=>JSON.parse(JSON.stringify(value)),format=value=>Number.isFinite(value)?value.toFixed(3):'—';
  let draft=null,selectedId='',entityId='',pointIndex=0,lastProject=null,sourceStamp='',preview=null,sizeRowsKey='',pointRows=[],pointKey='',draftEdited=false,baseChanged=false;
  const action=fn=>()=>{try{fn();}catch(error){notify(error.message);}};
  const num=id=>$(id).value.trim()?Number($(id).value):NaN;
  const sourceSignature=()=>JSON.stringify([getProject().units,getProject().entities,getProject().groups,getProject().seamAllowances,getProject().notches,getProject().seamChecks]);
  const currentEntity=()=>getProject().entities.find(entity=>entity.id===entityId);
  const currentRule=()=>draft?.rules.find(rule=>rule.entityId===entityId&&rule.index===pointIndex);
  function loadFields(){if(!draft)return;$('grade-name').value=draft.name;$('grade-base-size').value=draft.baseSize;$('grade-interpolation').value=draft.interpolation;sizeRowsKey='';pointKey='';}
  function reset(){draft=null;selectedId='';entityId='';pointIndex=0;preview=null;lastProject=getProject();sourceStamp=sourceSignature();sizeRowsKey='';pointKey='';draftEdited=false;baseChanged=false;}
  function invalidate(){draftEdited=true;preview=null;refresh();render();}
  function readDeltas(){return pointRows.map(row=>({sizeId:row.size.id,dx:row.x.value.trim()?Number(row.x.value):NaN,dy:row.y.value.trim()?Number(row.y.value):NaN}));}
  function storeRule(deltas){
    let rule=currentRule();if(!rule){rule={entityId,index:pointIndex,deltas:[]};draft.rules.push(rule);}rule.deltas=deltas;invalidate();
  }
  function refreshPoint(force=false){
    if(!draft)return;
    const entity=currentEntity(),points=entity&&gradePoints(entity);
    if(!points){$('grade-point-info').textContent='基准已缺失，请恢复图元或重建方案。';$('grade-deltas').replaceChildren();pointRows=[];return;}
    pointIndex=Math.max(0,Math.min(points.length-1,pointIndex));$('grade-point').value=pointIndex+1;$('grade-point').max=points.length;
    const point=points[pointIndex],rule=currentRule();
    $('grade-point-info').textContent=(entity.curve?'样条控制点':entity.type==='text'?'文字锚点':'折线节点')+' '+(pointIndex+1)+' · X '+format(point.x)+' / Y '+format(point.y)+' mm\n'+(rule?'已设独立规则':'未设独立规则；下表显示当前计算位移');
    const key=JSON.stringify([entityId,pointIndex,draft.sizes.map(size=>[size.id,size.label]),draft.baseSize]);
    if(force||pointKey!==key){
      pointKey=key;pointRows=[];const table=$('grade-deltas');table.replaceChildren();
      const heading=document.createElement('div');heading.className='grade-delta-row';for(const text of ['尺码','ΔX mm','ΔY mm']){const span=document.createElement('strong');span.textContent=text;heading.append(span);}table.append(heading);
      const base=document.createElement('div');base.className='grade-delta-row grade-base';for(const text of [draft.baseSize,'0','0']){const span=document.createElement('span');span.textContent=text;base.append(span);}table.append(base);
      draft.sizes.forEach(size=>{
        let delta=rule?.deltas.find(delta=>delta.sizeId===size.id);if(!delta){try{delta=gradedDisplacements(entity,draft,size.id)[pointIndex];}catch{delta={dx:0,dy:0};}}
        const row=document.createElement('div');row.className='grade-delta-row';const label=document.createElement('span');label.textContent=size.label;const x=document.createElement('input'),y=document.createElement('input');
        for(const [input,axis,value] of [[x,'X',delta.dx],[y,'Y',delta.dy]]){input.type='number';input.step='any';input.value=Number.isFinite(value)?value:'';input.setAttribute('aria-label',size.label+' Δ'+axis+' mm');input.dataset.gradeAxis=axis.toLowerCase();input.dataset.sizeId=size.id;input.oninput=()=>storeRule(readDeltas());}
        row.append(label,x,y);table.append(row);pointRows.push({size,x,y});
      });
    }
    for(const axis of ['x','y']){
      const values=pointRows.map(row=>row[axis].value.trim()?Number(row[axis].value)/row.size.step:NaN),first=values[0];
      $('grade-step-'+axis).value=Number.isFinite(first)&&values.every(value=>Number.isFinite(value)&&Math.abs(value-first)<=1e-10*Math.max(1,Math.abs(first)))?first:'';
    }
    $('grade-remove-rule').disabled=!rule;
    try{const refs=coincidentGradePoints(getProject(),draft,entityId,pointIndex,num('grade-coincident-tolerance'));$('grade-coincident-list').textContent=refs.map(ref=>(getProject().entities.find(e=>e.id===ref.entityId)?.name||ref.entityId)+' · 点 '+(ref.index+1)).join('\n');$('grade-copy-coincident').disabled=refs.length<2;}
    catch(error){$('grade-coincident-list').textContent=error.message;$('grade-copy-coincident').disabled=true;}
  }
  function refresh(){
    const project=getProject(),stamp=sourceSignature();
    if(project!==lastProject){
      const existing=project.gradingPlans?.find(plan=>plan.id===selectedId);
      if(existing){draft=normalizeGradingPlan(existing);loadFields();preview=gradingResults(project,existing);draftEdited=false;baseChanged=false;}else reset();lastProject=project;
    }else if(sourceStamp!==stamp){
      const existing=project.gradingPlans?.find(plan=>plan.id===selectedId);
      if(existing&&!draftEdited){draft=normalizeGradingPlan(existing);loadFields();preview=gradingResults(project,existing);baseChanged=false;}
      else{preview=null;pointKey='';baseChanged=Boolean(draft);}
    }
    sourceStamp=stamp;
    const saved=$('grade-saved');saved.replaceChildren(new Option(draft&&!selectedId?'未保存草稿':'未选择方案',''));for(const plan of project.gradingPlans||[])saved.add(new Option(plan.name+' · '+({current:'已计算',review:'需核对',error:'有失效尺码',stale:'待计算'}[plan.status]||'待计算'),plan.id));saved.value=selectedId;
    $('grade-controls').hidden=!draft;if(!draft)return;
    $('grade-save').textContent=selectedId?'更新放码方案':'保存放码方案';$('grade-delete').hidden=!selectedId;
    const sizeKey=JSON.stringify(draft.sizes.map(size=>size.id));
    if(sizeRowsKey!==sizeKey){
      sizeRowsKey=sizeKey;$('grade-sizes').replaceChildren();draft.sizes.forEach((size,index)=>{
        const row=document.createElement('div');row.className='grade-size-row';const label=document.createElement('input'),step=document.createElement('input'),remove=document.createElement('button');label.value=size.label;label.maxLength=50;label.setAttribute('aria-label','目标尺码 '+(index+1));step.type='number';step.step='any';step.value=size.step;step.setAttribute('aria-label','尺码 '+(index+1)+' 档数');remove.textContent='×';remove.setAttribute('aria-label','移除尺码 '+size.label);remove.disabled=draft.sizes.length<=1;
        label.oninput=()=>{size.label=label.value;pointKey='';invalidate();};step.oninput=()=>{size.step=step.value.trim()?Number(step.value):NaN;invalidate();};remove.onclick=()=>{draft.sizes.splice(index,1);for(const rule of draft.rules)rule.deltas=rule.deltas.filter(delta=>delta.sizeId!==size.id);pointKey='';invalidate();};row.append(label,step,remove);$('grade-sizes').append(row);
      });
    }
    const entitySelect=$('grade-entity');entitySelect.replaceChildren();for(const source of draft.sources){const entity=project.entities.find(e=>e.id===source.entityId);entitySelect.add(new Option(entity?.name||'缺失基准',source.entityId));}
    if(!draft.sources.some(source=>source.entityId===entityId)){entityId=draft.sources[0].entityId;pointIndex=0;}entitySelect.value=entityId;refreshPoint();
    const view=$('grade-view'),viewValue=view.value,exportSelect=$('grade-export-size'),exportValue=exportSelect.value;view.replaceChildren(new Option('全部尺码叠码','all'));exportSelect.replaceChildren();
    for(const size of draft.sizes){view.add(new Option(size.label,size.id));exportSelect.add(new Option(size.label,size.id));}view.value=draft.sizes.some(size=>size.id===viewValue)?viewValue:'all';exportSelect.value=draft.sizes.some(size=>size.id===exportValue)?exportValue:draft.sizes[0].id;
    const list=$('grade-rule-list');list.replaceChildren();const note=document.createElement('p');note.className='muted';note.textContent='基准 '+draft.sources.length+' 个 · 已设规则 '+draft.rules.length+' 点';list.append(note);
    for(const rule of draft.rules.slice(0,100)){const button=document.createElement('button');button.className='grade-rule-link';button.textContent=(project.entities.find(e=>e.id===rule.entityId)?.name||'缺失基准')+' · '+(rule.index+1);button.onclick=()=>{entityId=rule.entityId;pointIndex=rule.index;pointKey='';refresh();render();};list.append(button);}
    const results=$('grade-results');results.replaceChildren();
    const savedError=!draftEdited&&project.gradingPlans?.find(plan=>plan.id===selectedId)?.error;
    if(savedError&&!preview?.length){$('grade-status').textContent='放码方案失效：'+savedError;}
    else if(preview){
      const failed=preview.filter(result=>result.error).length,review=preview.filter(result=>result.summary.status==='review').length;
      $('grade-status').textContent='已计算 '+preview.length+' 个尺码 · '+failed+' 个生成失败 · '+review+' 个需核对。基码几何未改变。';
      preview.forEach((result,index)=>{
        const card=document.createElement('div');card.className='grade-result-card';card.style.borderLeftColor=colors[index%colors.length];card.dataset.gradeSize=result.size.id;card.dataset.status=result.summary.status;
        const title=document.createElement('strong');title.textContent=result.size.label+' · '+({ready:'已生成',review:'需核对',error:'生成失败'}[result.summary.status]);const text=document.createElement('p');text.textContent=result.error||'基准范围 '+format(result.summary.baseWidth)+' × '+format(result.summary.baseHeight)+' mm\n含输出范围 '+format(result.summary.width)+' × '+format(result.summary.height)+' mm\n检查 '+result.summary.contoursChecked+' 项轮廓 / '+result.summary.seamChecksCount+' 组对缝\n'+(result.summary.warnings.join('\n')||'上述检查未报告问题。');card.append(title,text);results.append(card);
      });
    }else $('grade-status').textContent=(baseChanged?'基码已变化，未保存草稿的增量按当前坐标轴保留，请逐点确认。':'规则或基准已修改，请预览各尺码。')+'未预览的草稿不能导出。';
    const chosen=preview?.find(result=>result.size.id===exportSelect.value),canExport=Boolean(chosen?.project&&!chosen.error);
    $('grade-export-project').disabled=!canExport;$('grade-export-dxf').disabled=!canExport;$('grade-export-all').disabled=!preview?.length||preview.some(result=>result.error);$('grade-report').disabled=!preview;$('grade-fit').disabled=!preview?.some(result=>result.project);
  }
  function compute(){try{const config=normalizeGradingPlan(draft);preview=evaluateGradingPlan(getProject(),config);refresh();render();}catch(error){preview=null;refresh();$('grade-status').textContent='预览失败：'+error.message;render();throw error;}}
  function chosen(){if(!preview)throw new Error('请先预览当前规则');const result=preview.find(result=>result.size.id===$('grade-export-size').value);if(!result?.project||result.error)throw new Error(result?.error||'该尺码不能导出');return result;}
  function filename(name){return name.replace(/[<>:"/\\|?*]/g,'_');}
  $('grade-create').onclick=action(()=>{draft=createGradingPlan(getProject(),getSelection(),()=>crypto.randomUUID());selectedId='';entityId=draft.sources[0].entityId;pointIndex=0;preview=null;lastProject=getProject();sourceStamp=sourceSignature();draftEdited=true;baseChanged=false;loadFields();setTool('grading');refresh();render();});
  $('grade-saved').onchange=action(()=>{selectedId=$('grade-saved').value;if(!selectedId){reset();refresh();render();return;}const plan=getProject().gradingPlans.find(plan=>plan.id===selectedId);draft=normalizeGradingPlan(plan);preview=gradingResults(getProject(),plan);draftEdited=false;baseChanged=false;loadFields();refresh();render();});
  for(const [id,key] of [['grade-name','name'],['grade-base-size','baseSize'],['grade-interpolation','interpolation']])$(id).oninput=()=>{if(!draft)return;draft[key]=$(id).value;if(key!=='name')pointKey='';invalidate();};
  $('grade-add-size').onclick=action(()=>{
    if(draft.sizes.length>=12)throw new Error('最多支持 12 个目标尺码');const label=$('grade-new-size').value.trim(),step=num('grade-new-step');
    if(!label||label===draft.baseSize||draft.sizes.some(size=>size.label===label)||!Number.isFinite(step)||step===0||Math.abs(step)>100)throw new Error('请输入唯一尺码名称和非零档数（±100 以内）');
    const size={id:crypto.randomUUID(),label,step};draft.sizes.push(size);for(const rule of draft.rules)rule.deltas.push({sizeId:size.id,dx:0,dy:0});$('grade-new-size').value='';pointKey='';invalidate();
  });
  $('grade-entity').onchange=()=>{entityId=$('grade-entity').value;pointIndex=0;pointKey='';refresh();render();};
  $('grade-point').onchange=action(()=>{const index=num('grade-point')-1;if(!Number.isInteger(index)||index<0||index>=gradePoints(currentEntity()).length)throw new Error('点序号超出范围');pointIndex=index;pointKey='';refresh();render();});
  $('grade-locate-point').onclick=()=>{const e=currentEntity();if(e)fit([e.curve?{...e,points:e.curve.controlPoints}:e]);};
  $('grade-fill-step').onclick=action(()=>{const dx=num('grade-step-x'),dy=num('grade-step-y');if(!Number.isFinite(dx)||!Number.isFinite(dy))throw new Error('请输入有效档差');const deltas=draft.sizes.map(size=>({sizeId:size.id,dx:dx*size.step,dy:dy*size.step}));storeRule(deltas);refreshPoint(true);});
  $('grade-fix-point').onclick=()=>{storeRule(draft.sizes.map(size=>({sizeId:size.id,dx:0,dy:0})));refreshPoint(true);};
  $('grade-remove-rule').onclick=()=>{draft.rules=draft.rules.filter(rule=>rule!==currentRule());pointKey='';invalidate();};
  $('grade-coincident-tolerance').oninput=()=>refreshPoint();
  $('grade-copy-coincident').onclick=action(()=>{
    const deltas=readDeltas(),refs=coincidentGradePoints(getProject(),draft,entityId,pointIndex,num('grade-coincident-tolerance'));
    for(const ref of refs){let rule=draft.rules.find(rule=>rule.entityId===ref.entityId&&rule.index===ref.index);if(!rule){rule={...ref,deltas:[]};draft.rules.push(rule);}rule.deltas=deltas.map(delta=>({...delta}));}invalidate();notify('已将规则写入 '+refs.length+' 个点；请预览核对。');
  });
  $('grade-preview').onclick=action(compute);$('grade-show').onchange=render;$('grade-show-text').onchange=render;$('grade-view').onchange=render;$('grade-export-size').onchange=refresh;
  $('grade-fit').onclick=()=>{const entities=preview?.filter(result=>result.project).flatMap(result=>result.project.entities)||[];for(const source of draft.sources){const e=getProject().entities.find(e=>e.id===source.entityId);if(e)entities.push(e);}if(entities.length)fit(entities);};
  $('grade-save').onclick=action(()=>{const next=clone(getProject()),plan=applyGradingPlan(next,draft,()=>crypto.randomUUID(),selectedId||null);selectedId=plan.id;commit(next);notify('放码方案已记入工程；请保存 .zycad 文件。');});
  $('grade-delete').onclick=()=>{const next=clone(getProject());next.gradingPlans=next.gradingPlans.filter(plan=>plan.id!==selectedId);reset();commit(next);};
  $('grade-export-project').onclick=action(()=>{const result=chosen();download(JSON.stringify(result.project,null,2),filename(result.project.name)+'.zycad','application/json');});
  $('grade-export-dxf').onclick=action(()=>{const result=chosen();download(toDxf(result.project,getDxfOptions()),filename(result.project.name)+'.dxf','application/dxf');});
  $('grade-export-all').onclick=action(()=>{
    if(!preview?.length||preview.some(result=>result.error))throw new Error('全部尺码须生成成功后才能合并导出');
    const entities=preview.flatMap((result,index)=>result.project.entities.map(entity=>({...entity,layer:'SIZE_'+String(index+1).padStart(2,'0')+'_'+result.size.label.replace(/[^A-Za-z0-9_-]/g,'_')+'_'+entity.layer.replace(/[^A-Za-z0-9_-]/g,'_')})));
    download(toDxf({units:'mm',entities},getDxfOptions()),filename(getProject().name)+'-多尺码.dxf','application/dxf');
  });
  $('grade-report').onclick=action(()=>{if(!preview)throw new Error('请先预览');download(JSON.stringify({format:'zhiyi-grading-report',version:1,definition:normalizeGradingPlan(draft),sizes:preview.map((result,index)=>({summary:result.summary,dxfLayerPrefix:'SIZE_'+String(index+1).padStart(2,'0')+'_'+result.size.label.replace(/[^A-Za-z0-9_-]/g,'_')+'_',inspection:result.inspection,seamChecks:result.project?.seamChecks}))},null,2),filename(getProject().name)+'-放码报告.json','application/json');});
  function draw({node,overlay,screen,pathData,scale}){
    if(draft&&$('grade-show').checked&&preview)preview.forEach((result,index)=>{
      if(!result.project||!['all',result.size.id].includes($('grade-view').value))return;const color=colors[index%colors.length];
      const legend=node('text',{x:18,y:28+index*18,fill:color,'font-size':12},overlay);legend.textContent=result.size.label+' · '+(result.summary.status==='review'?'需核对':'放码预览');
      for(const entity of result.project.entities){
        if(entity.type==='text'){
          if(!$('grade-show-text').checked)continue;const p=screen(entity.points[0]),text=node('text',{x:0,y:0,fill:color,'font-size':entity.height*scale,'dominant-baseline':entity.verticalAlign==='middle'?'central':'auto',transform:'translate('+p.x+' '+p.y+') rotate('+-(entity.rotation||0)+') scale(1 '+(entity.mirrorY?-1:1)+')','data-grade-size':result.size.id},overlay);text.textContent=entity.text;if(entity.width){text.setAttribute('textLength',entity.width*scale);text.setAttribute('lengthAdjust','spacingAndGlyphs');}continue;
        }
        node('path',{d:pathData(entity.points,entity.closed),fill:'none',stroke:color,'stroke-width':1.6,'stroke-dasharray':entity.derivedFrom?'7 3':'none','data-grade-size':result.size.id,'data-grade-entity':entity.id},overlay);
        for(const [tip,previous] of [[entity.arrowEnd&&entity.points.at(-1),entity.points.at(-2)],[entity.arrowStart&&entity.points[0],entity.points[1]]])if(tip){const p=screen(tip),q=screen(previous),angle=Math.atan2(p.y-q.y,p.x-q.x);node('path',{d:'M '+(p.x-7*Math.cos(angle-.35))+' '+(p.y-7*Math.sin(angle-.35))+' L '+p.x+' '+p.y+' L '+(p.x-7*Math.cos(angle+.35))+' '+(p.y-7*Math.sin(angle+.35)),stroke:color,fill:'none'},overlay);}
      }
    });
    if(!draft||getTool()!=='grading')return;const entity=currentEntity();if(!entity)return;const points=gradePoints(entity);
    if(entity.curve)node('path',{d:pathData(points),fill:'none',stroke:'#d8ab56','stroke-dasharray':'4 4'},overlay);
    points.forEach((p,index)=>{const s=screen(p),rule=draft.rules.some(rule=>rule.entityId===entity.id&&rule.index===index);node('circle',{cx:s.x,cy:s.y,r:index===pointIndex?6:4,fill:rule?'#66ab80':'#fff',stroke:'#bd8b3c','stroke-width':2,'data-grade-point':index},overlay);if(points.length<=100||index===pointIndex){const label=node('text',{x:s.x+7,y:s.y-8,fill:'#c68d37','font-size':12},overlay);label.textContent=String(index+1);}});
  }
  function pick(point,scale,target){
    if(!draft){notify('先选取基码裁片，再建立放码方案。');return;}
    let chosen=null,closest=8/scale;
    for(const source of draft.sources){const entity=getProject().entities.find(e=>e.id===source.entityId);if(!entity)continue;gradePoints(entity).forEach((p,index)=>{const d=Math.hypot(p.x-point.x,p.y-point.y);if(d<closest){closest=d;chosen={entityId:entity.id,index};}});}
    if(chosen){entityId=chosen.entityId;pointIndex=chosen.index;}else if(target&&draft.sources.some(source=>source.entityId===target.entity.id)){entityId=target.entity.id;pointIndex=0;}else{notify('请点选方案内的基准线或控制点');return;}
    pointKey='';refresh();render();$('grade-deltas').scrollIntoView({block:'center'});
  }
  reset();return {reset,refresh,draw,pick,begin:()=>{setTool('grading');refresh();$('grading-panel').scrollIntoView({block:'start'});}};
}
