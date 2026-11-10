import { emptyMarkerPlan, normalizeMarkerPlan, markerChoices, markerItem, markerTurns, markerInstanceKey, markerSourceSignature, evaluateMarkerPlan, applyMarkerPlan, exportMarkerProject, markerPoint, placedMarkerShape, markerDomain } from './marker.mjs';
import { polygonContainsPoint, MARKER_GRID as GRID } from './marker-polygons.mjs';
import { toDxf } from './geometry.mjs';
const colors=['#4d8b72','#558fa5','#b48b45','#a57499','#8b8c50','#7b7caa'];
const darkColors=['#84c9ab','#8cc9de','#e2be78','#d9a6ca','#c4c887','#b8b4e2'];
export function createMarkerPanel({getProject,getSelection,getTool,isDark=()=>false,commit,setTool,render,fit,notify,download,getDxfOptions=()=>({})}){
  const $=id=>document.getElementById(id),clone=value=>JSON.parse(JSON.stringify(value)),num=id=>$(id).value.trim()?Number($(id).value):NaN;
  const fields=[['marker-name','name'],['marker-width','fabricWidth'],['marker-length','maxLength'],['marker-spacing','spacing'],['marker-margin','edgeMargin'],['marker-gap','gapTolerance'],['marker-tolerance','curveTolerance']];
  let draft=emptyMarkerPlan(),selectedId='',itemId='',instanceKey='',result=null,error='',lastProject=null,stamp='',choiceStamp='',choices=[],worker=null,progress='',search=null,drag=null,history=[];
  const action=fn=>()=>{try{fn();}catch(e){notify(e.message);}};
  const item=()=>draft.items.find(i=>i.id===itemId);
  function stop(){if(worker){worker.terminate();worker=null;}progress='';}
  function reset(){stop();draft=emptyMarkerPlan();selectedId='';itemId='';instanceKey='';result=null;error='';search=null;drag=null;history=[];lastProject=getProject();stamp=markerSourceSignature(getProject());choiceStamp='';loadFields();}
  function loadFields(){for(const [id,key] of fields)$(id).value=draft[key];loadItem();}
  function remember(){history.push(clone(draft));if(history.length>40)history.shift();}
  function invalidate(){stop();result=null;error='';search=null;status();render();}
  function compute(){stop();try{result=evaluateMarkerPlan(getProject(),draft);draft=result.config;error='';}catch(e){result=null;error=e.message;}status();render();return result;}
  function frame(){const height=result?.report.usedLength||Math.min(draft.maxLength,draft.fabricWidth*1.2);return [{type:'polyline',points:[{x:0,y:0},{x:draft.fabricWidth,y:height}]}];}
  function fitLayout(){if(!Number.isFinite(draft.fabricWidth)||!Number.isFinite(draft.maxLength))return;setTool('marker');fit(frame());}
  function loadItem(){
    const current=item();$('marker-item-fields').hidden=!current;if(!current)return;
    $('marker-quantity').value=current.quantity;$('marker-mirror-quantity').value=current.mirroredQuantity;$('marker-direction').value=current.direction;$('marker-angle').value=current.grainAngle;
    const select=$('marker-grain');select.replaceChildren(new Option('手动输入原图角度',''));
    for(const e of getProject().entities.filter(e=>current.memberIds.includes(e.id)&&e.type!=='text'&&!e.curve&&e.points.length===2))select.add(new Option(e.name,e.id));
    if(current.grainEntityId&&![...select.options].some(o=>o.value===current.grainEntityId))select.add(new Option('缺失布纹线',current.grainEntityId));
    select.value=current.grainEntityId||'';$('marker-angle-label').hidden=Boolean(current.grainEntityId);
  }
  function instances(){return draft.items.flatMap(i=>[false,true].flatMap(mirrored=>Array.from({length:Number.isInteger(mirrored?i.mirroredQuantity:i.quantity)&&Math.min(200,mirrored?i.mirroredQuantity:i.quantity)>0?Math.min(200,mirrored?i.mirroredQuantity:i.quantity):0},(_,ordinal)=>({itemId:i.id,mirrored,ordinal,key:markerInstanceKey(i.id,mirrored,ordinal)}))));}
  function loadPlacement(){
    const instance=instances().find(i=>i.key===instanceKey);$('marker-placement-fields').hidden=!instance;if(!instance)return;
    const current=draft.items.find(i=>i.id===instance.itemId),placement=draft.placements.find(p=>markerInstanceKey(p.itemId,p.mirrored,p.ordinal)===instanceKey);
    const select=$('marker-turn');select.replaceChildren();for(const turn of markerTurns(current))select.add(new Option(turn+'°',turn));
    if(placement&&!markerTurns(current).includes(placement.turn))select.add(new Option(placement.turn+'°（已不允许）',placement.turn));select.value=placement?.turn??0;
    let domain;try{const shape=result?.prepared.templates.find(t=>t.item.id===current.id)?.shapes.find(s=>s.mirrored===instance.mirrored&&s.turn===Number(select.value));if(shape)domain=markerDomain(shape,draft);}catch{}
    $('marker-x').value=placement?.x??(domain?domain.minX/GRID:draft.edgeMargin);$('marker-y').value=placement?.y??(domain?domain.minY/GRID:draft.edgeMargin);$('marker-unplace').disabled=!placement;
  }
  function refreshLists(){
    const select=$('marker-item');select.replaceChildren();for(const i of draft.items)select.add(new Option(i.name+' · '+i.quantity+' + 镜像 '+i.mirroredQuantity,i.id));
    if(!draft.items.some(i=>i.id===itemId))itemId=draft.items[0]?.id||'';select.value=itemId;loadItem();
    const list=$('marker-instance');list.replaceChildren();const all=instances();
    for(const instance of all){const i=draft.items.find(i=>i.id===instance.itemId),placed=draft.placements.some(p=>markerInstanceKey(p.itemId,p.mirrored,p.ordinal)===instance.key);list.add(new Option((placed?'已排 · ':'待排 · ')+i.name+' #'+(instance.ordinal+1)+(instance.mirrored?' 镜像':''),instance.key));}
    if(!all.some(i=>i.key===instanceKey))instanceKey=all[0]?.key||'';list.value=instanceKey;loadPlacement();
  }
  function status(){
    const r=result?.report;
    $('marker-status').dataset.status=error||r?.errors.length?'error':r?.complete?'current':'incomplete';
    const names=new Map(instances().map(instance=>[instance.key,(draft.items.find(i=>i.id===instance.itemId)?.name||'裁片')+' #'+(instance.ordinal+1)+(instance.mirrored?' 镜像':'')]));
    $('marker-status').textContent=progress||error||(!r?'参数已改变，请核验或自动排料。':
      '已排 '+r.placed+' / '+r.requested+' 片 · 待排 '+r.missing.length+'\n布长 '+r.usedLength.toFixed(3)+' mm · 利用率 '+(r.utilization===null?'—':r.utilization.toFixed(2)+'%')+'\n'+
      (r.complete?'数量、边距和片间距核验通过。':r.errors.slice(0,8).map(e=>names.get(e.key)+'：'+e.message+(e.otherKey?'（与 '+names.get(e.otherKey)+'）':'')).join('\n')||'请继续放置待排裁片。')+
      (r.errors.length>8?'\n另有 '+(r.errors.length-8)+' 项问题；详见报告。':'')+(r.warnings.length?'\n'+r.warnings.join('\n'):'')+
      (search?'\n'+search.method+(search.limited?'；已达到搜索上限，部分放置采用顶部顺排。':''):'') );
    const ready=Boolean(r?.complete)&&!worker&&!drag;
    $('marker-export-project').disabled=!ready;$('marker-export-dxf').disabled=!ready;$('marker-export-layout-dxf').disabled=!ready;$('marker-report').disabled=!result||Boolean(worker)||Boolean(drag);
    $('marker-cancel').disabled=!worker;$('marker-auto').disabled=!draft.items.length||Boolean(worker);$('marker-save').disabled=!draft.items.length||Boolean(worker)||Boolean(drag);$('marker-undo').disabled=!history.length||Boolean(worker);
    $('marker-save').textContent=selectedId?'更新排料方案':'保存排料方案';$('marker-delete').hidden=!selectedId;
  }
  function refresh(){
    const project=getProject(),nextStamp=markerSourceSignature(project);
    if(project!==lastProject){const saved=project.markerPlans?.find(p=>p.id===selectedId);if(saved){stop();draft=normalizeMarkerPlan(saved);history=[];loadFields();compute();}else reset();lastProject=project;}
    if(stamp!==nextStamp){stop();history=[];search=null;compute();choiceStamp='';}stamp=nextStamp;
    const saved=$('marker-saved');saved.replaceChildren(new Option(selectedId?'选择方案':'未保存草稿',''));for(const plan of project.markerPlans||[])saved.add(new Option(plan.name+' · '+({current:'已核验',error:'需修复',incomplete:'未排完'}[plan.status]||'待核验'),plan.id));saved.value=selectedId;
    const size=$('marker-size'),old=size.value;size.replaceChildren(new Option('当前基码',''));for(const plan of project.gradingPlans||[])for(const s of plan.sizes)size.add(new Option(plan.name+' / '+s.label,JSON.stringify([plan.id,s.id])));size.value=[...size.options].some(o=>o.value===old)?old:'';
    const key=JSON.stringify([stamp,[...getSelection()].sort(),size.value]);
    if(key!==choiceStamp){
      choiceStamp=key;const value=$('marker-boundary').value;choices=[];
      try{const [planId,sizeId]=size.value?JSON.parse(size.value):[null,null];choices=markerChoices(project,getSelection(),planId,sizeId).choices;}catch(e){$('marker-boundary').title=e.message;}
      const select=$('marker-boundary');select.replaceChildren();for(const choice of choices)select.add(new Option(choice.label,choice.key));if(choices.some(c=>c.key===value))select.value=value;
      if(!choices.length)select.add(new Option(project.units==='mm'?'请先选择完整裁片或闭合边界':'请先校准工程单位',''));$('marker-add').disabled=!choices.length;
    }
    refreshLists();status();
  }
  $('marker-new').onclick=()=>{reset();refresh();setTool('marker');fitLayout();};
  $('marker-source').onclick=()=>{setTool('select');fit();};
  $('marker-size').onchange=()=>{choiceStamp='';refresh();};
  $('marker-saved').onchange=action(()=>{const id=$('marker-saved').value;if(!id){reset();refresh();render();return;}stop();selectedId=id;draft=normalizeMarkerPlan(getProject().markerPlans.find(p=>p.id===id));history=[];search=null;loadFields();compute();refresh();fitLayout();});
  $('marker-add').onclick=action(()=>{
    const choice=choices.find(c=>c.key===$('marker-boundary').value);if(!choice)throw new Error('请先选定裁剪边界');
    const next=clone(draft),added=markerItem(choice,()=>crypto.randomUUID());next.items.push(added);evaluateMarkerPlan(getProject(),next);remember();draft=next;itemId=added.id;instanceKey=markerInstanceKey(added.id,false,0);compute();refresh();fitLayout();
  });
  for(const [id,key] of fields)$(id).oninput=()=>{draft[key]=key==='name'?$(id).value:num(id);invalidate();};
  $('marker-item').onchange=()=>{itemId=$('marker-item').value;loadItem();};
  for(const [id,key] of [['marker-quantity','quantity'],['marker-mirror-quantity','mirroredQuantity'],['marker-angle','grainAngle'],['marker-direction','direction'],['marker-grain','grainEntityId']])$(id).oninput=()=>{
    if(!item())return;item()[key]=key==='direction'?$(id).value:key==='grainEntityId'?$(id).value||null:num(id);
    if(key==='quantity'||key==='mirroredQuantity')draft.placements=draft.placements.filter(p=>p.itemId!==itemId||p.ordinal<(p.mirrored?item().mirroredQuantity:item().quantity));
    $('marker-angle-label').hidden=Boolean(item().grainEntityId);invalidate();
  };
  $('marker-remove-item').onclick=()=>{remember();draft.items=draft.items.filter(i=>i.id!==itemId);draft.placements=draft.placements.filter(p=>p.itemId!==itemId);compute();refresh();};
  $('marker-validate').onclick=()=>{compute();refresh();setTool('marker');};
  $('marker-fit').onclick=fitLayout;
  $('marker-auto').onclick=action(()=>{
    const config=normalizeMarkerPlan(draft);if(!config.items.length)throw new Error('请先加入裁片');stop();drag=null;search=null;
    const initialStamp=markerSourceSignature(getProject()),initialConfig=JSON.stringify(draft);
    worker=new Worker(new URL('./marker-worker.mjs',import.meta.url),{type:'module'});const running=worker;
    progress='正在计算裁剪轮廓与允许方向…';status();setTool('marker');
    worker.onmessage=event=>{
      if(worker!==running)return;
      if(initialStamp!==markerSourceSignature(getProject())||initialConfig!==JSON.stringify(draft)){stop();error='基准或参数已变化，请重新排料';status();return;}
      if(event.data.progress){const p=event.data.progress;progress='搜索 '+p.attempt+' / '+p.attempts+' · 已处理 '+p.processed+' / '+p.total+' · 已排 '+p.placed+' 片';status();return;}
      stop();
      if(event.data.error){error=event.data.error;result=null;status();render();return;}
      remember();draft.placements=event.data.result.placements;search=event.data.result.search;compute();refresh();fitLayout();
    };
    worker.onerror=()=>{if(worker===running){stop();error='排料计算线程失败，请重试或手动放置';status();}};
    worker.postMessage({project:getProject(),config});
  });
  $('marker-cancel').onclick=()=>{stop();status();notify('已停止搜索，保留搜索前的排料位置。');};
  $('marker-instance').onchange=()=>{instanceKey=$('marker-instance').value;loadPlacement();render();};
  $('marker-place').onclick=action(()=>{
    const instance=instances().find(i=>i.key===instanceKey);if(!instance)throw new Error('请选择实例');
    const {key,...identity}=instance,next={...identity,turn:Number($('marker-turn').value),x:num('marker-x'),y:num('marker-y')};
    const placements=draft.placements.filter(p=>markerInstanceKey(p.itemId,p.mirrored,p.ordinal)!==instanceKey);placements.push(next);
    normalizeMarkerPlan({...draft,placements});remember();draft.placements=placements;search=null;compute();refresh();setTool('marker');
  });
  function unplace(){remember();draft.placements=draft.placements.filter(p=>markerInstanceKey(p.itemId,p.mirrored,p.ordinal)!==instanceKey);search=null;compute();refresh();render();}
  $('marker-unplace').onclick=unplace;
  $('marker-undo').onclick=()=>{if(!history.length)return;stop();draft=history.pop();search=null;loadFields();compute();refresh();render();};
  $('marker-save').onclick=action(()=>{const next=clone(getProject()),plan=applyMarkerPlan(next,draft,()=>crypto.randomUUID(),selectedId||null);selectedId=plan.id;commit(next);notify('排料方案已记入当前工程，请保存工程文件。');});
  $('marker-delete').onclick=action(()=>{const next=clone(getProject());next.markerPlans=(next.markerPlans||[]).filter(p=>p.id!==selectedId);reset();commit(next);});
  const filename=()=>draft.name.replace(/[<>:"/\\|?*]/g,'_');
  $('marker-export-project').onclick=action(()=>{download(JSON.stringify(exportMarkerProject(getProject(),draft),null,2),filename()+'-排料.zycad','application/json');});
  $('marker-export-dxf').onclick=action(()=>{download(toDxf(exportMarkerProject(getProject(),draft,{cutOnly:true}),getDxfOptions()),filename()+'-裁剪边界.dxf','application/dxf');});
  $('marker-export-layout-dxf').onclick=action(()=>{download(toDxf(exportMarkerProject(getProject(),draft),getDxfOptions()),filename()+'-排料图形.dxf','application/dxf');});
  $('marker-report').onclick=action(()=>{const current=evaluateMarkerPlan(getProject(),draft);download(JSON.stringify({format:'zhiyi-marker-report',version:1,definition:current.config,report:current.report,search},null,2),filename()+'-排料核验.json','application/json');});
  function down(point){
    if(worker||!result)return;const record=result.placed.slice().reverse().find(r=>polygonContainsPoint(r.path,point));if(!record){instanceKey='';refreshLists();render();return;}
    instanceKey=record.key;drag={start:point,original:clone(record.placement),placement:clone(record.placement),key:record.key,moved:false};loadPlacement();$('marker-instance').value=instanceKey;status();render();
  }
  function move(point){if(!drag)return;drag.placement.x=Math.round((drag.original.x+point.x-drag.start.x)*GRID)/GRID;drag.placement.y=Math.round((drag.original.y+point.y-drag.start.y)*GRID)/GRID;drag.moved=drag.placement.x!==drag.original.x||drag.placement.y!==drag.original.y;render();}
  function end(cancel=false){if(!drag)return;const current=drag;drag=null;if(!cancel&&current.moved){remember();draft.placements=draft.placements.map(p=>markerInstanceKey(p.itemId,p.mirrored,p.ordinal)===current.key?current.placement:p);search=null;compute();}refreshLists();status();render();}
  function draw({node,overlay,screen,pathData,scale}){
    if(getTool()!=='marker'||!Number.isFinite(draft.fabricWidth)||!Number.isFinite(draft.maxLength))return;
    const height=result?.report.usedLength||Math.min(draft.maxLength,draft.fabricWidth*1.2),width=draft.fabricWidth;
    node('path',{d:pathData([{x:0,y:0},{x:width,y:0},{x:width,y:height},{x:0,y:height}],true),fill:'#e5eee51c',stroke:'#8ea68b','stroke-width':1.5,'data-marker-fabric':'true'},overlay);
    const titlePosition=screen({x:0,y:height}),title=node('text',{x:titlePosition.x,y:titlePosition.y-13,fill:'#799c80','font-size':13},overlay);title.textContent='布宽 '+width+' mm · 布长 '+height.toFixed(3)+' mm · Y ↑';
    if(!result)return;const invalid=new Set(result.report.errors.flatMap(e=>[e.key,e.otherKey].filter(Boolean)));
    for(let i=0;i<result.placed.length;i++){
      let record=result.placed[i];if(drag?.key===record.key)record=placedMarkerShape(result.prepared,drag.placement);
      const palette=isDark()?darkColors:colors,color=invalid.has(record.key)?'#e97760':palette[result.prepared.templates.indexOf(record.template)%palette.length],selected=record.key===instanceKey;
      const group=node('g',{'data-marker-instance':record.key},overlay);
      node('path',{d:pathData(record.path.map(p=>({x:p.X/GRID,y:p.Y/GRID})),true),fill:color+'20',stroke:selected?'#d8b05d':color,'stroke-width':selected?2.5:1.5},group);
      for(const e of record.template.entities){
        if(e.type==='text'){
          const origin=screen(markerPoint(e.points[0],record.shape,record.placement)),r=(e.rotation||0)*Math.PI/180,m=record.shape.matrix,x=m.a*Math.cos(r)+m.b*Math.sin(r),y=m.c*Math.cos(r)+m.d*Math.sin(r),rotation=Math.atan2(y,x)*180/Math.PI;
          const text=node('text',{x:0,y:0,fill:color,'font-size':e.height*scale,'font-family':'Arial,"Microsoft YaHei",sans-serif','dominant-baseline':e.verticalAlign==='middle'?'central':'auto',transform:'translate('+origin.x+' '+origin.y+') rotate('+(-rotation)+') scale(1 '+(Boolean(e.mirrorY)!==record.placement.mirrored?-1:1)+')','data-marker-source-text':e.id},group);text.textContent=e.text;if(e.width){text.setAttribute('textLength',e.width*scale);text.setAttribute('lengthAdjust','spacingAndGlyphs');}continue;
        }
        const points=e.points.map(p=>markerPoint(p,record.shape,record.placement)),stroke=e.layer==='grain'?(isDark()?'#89cf90':'#538b59'):color;
        node('path',{d:pathData(points,e.closed),fill:'none',stroke,'stroke-width':.8,'stroke-opacity':.75},group);
        for(const [tip,previous] of [...(e.arrowEnd?[[points.at(-1),points.at(-2)]]:[]),...(e.arrowStart?[[points[0],points[1]]]:[])]){
          const a=screen(tip),b=screen(previous),angle=Math.atan2(a.y-b.y,a.x-b.x),left={x:a.x-7*Math.cos(angle-.35),y:a.y-7*Math.sin(angle-.35)},right={x:a.x-7*Math.cos(angle+.35),y:a.y-7*Math.sin(angle+.35)};
          node('path',{d:'M '+left.x+' '+left.y+' L '+a.x+' '+a.y+' L '+right.x+' '+right.y,fill:'none',stroke,'stroke-width':1},group);
        }
      }
      const p=screen({x:record.placement.x+(record.shape.bounds.maxX+record.shape.bounds.minX)/(2*GRID),y:record.placement.y+(record.shape.bounds.maxY+record.shape.bounds.minY)/(2*GRID)});
      const label=node('text',{x:p.x,y:p.y,'text-anchor':'middle',fill:color,'font-size':Math.max(11,Math.min(14,scale*4))},group);label.textContent=record.template.item.name+' '+record.template.sizeLabel+' #'+(record.placement.ordinal+1)+(record.placement.mirrored?' 镜':'');
    }
  }
  return {reset,refresh,draw,down,move,end,unplace,frame,begin(){refresh();setTool('marker');if(result?.placed.length)fitLayout();$('marker-panel').scrollIntoView({block:'start'});}};
}
