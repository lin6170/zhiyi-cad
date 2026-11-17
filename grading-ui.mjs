import { createGradingPlan, createTablePlan, normalizeGradingPlan, gradePoints, gradedDisplacements, evaluateGradingPlan, applyGradingPlan, gradingResults, coincidentGradePoints } from './grading.mjs';
import { toDxf } from './geometry.mjs';
import { stationsOf, placeOnLine } from './grading-table.mjs';
import { parseFormula, formulaNames } from './size-formula.mjs';
const colors=['#4da6ce','#d78cb5','#d89545','#77aa69','#a28ad4','#d97465','#5bb4a8','#9b9953','#6881cd','#b7799e','#a9a55e','#80a4a1'];
export function createGradingPanel({getProject,getSelection,commit,setTool,getTool,render,fit,notify,download,getDxfOptions=()=>({})}){
  const $=id=>document.getElementById(id),clone=value=>JSON.parse(JSON.stringify(value)),format=value=>Number.isFinite(value)?value.toFixed(3):'—';
  let draft=null,selectedId='',entityId='',pointIndex=0,lastProject=null,sourceStamp='',preview=null,sizeRowsKey='',pointRows=[],pointKey='',draftEdited=false,baseChanged=false;
  const action=fn=>()=>{try{fn();}catch(error){notify(error.message);}};
  const num=id=>$(id).value.trim()?Number($(id).value):NaN;
  const sourceSignature=()=>JSON.stringify([getProject().units,getProject().entities,getProject().groups,getProject().seamAllowances,getProject().notches,getProject().seamChecks]);
  const currentEntity=()=>getProject().entities.find(entity=>entity.id===entityId);
  const currentRule=()=>draft?.rules.find(rule=>rule.entityId===entityId&&rule.index===pointIndex);
  // A plan that grades by a size table (carried from an ET file): its size table and the formulas of the points of the current line.
  const isTable=()=>draft?.method==='table';
  let tableKey='',sizesKey='',addingOnLine=false;
  const lineName=id=>getProject().entities.find(entity=>entity.id===id)?.name||'缺失的线';
  const typingIn=holder=>{const active=document.activeElement;return Boolean(active&&active.tagName==='INPUT'&&holder.contains(active));};
  const tableSizes=()=>[{label:draft.baseSize,slot:draft.sizeTable.baseSlot,base:true},...draft.sizes].sort((a,b)=>a.slot-b.slot);
  const tableChanged=()=>{draftEdited=true;preview=null;refresh();render();};
  // Points of several lines on one place usually carry the same rule (in an ET file each end at a corner has its own copy).
  // They are changed together, as in ET where a rule is set on every point at the place: otherwise the piece would come apart there.
  const placeOf=anchor=>{if(anchor.between!==undefined)return anchor.at;const entity=getProject().entities.find(item=>item.id===anchor.entityId),stations=entity&&stationsOf(entity);return stations?.points[anchor.index]||null;};
  const twinsOf=anchor=>{const here=anchor.index===undefined?null:placeOf(anchor);if(!here)return [];const axes=JSON.stringify([anchor.axisX,anchor.axisY]);
    return draft.anchors.filter(other=>{if(other===anchor||other.plain||other.index===undefined||other.x!==anchor.x||other.y!==anchor.y||JSON.stringify([other.axisX,other.axisY])!==axes)return false;const there=placeOf(other);return Boolean(there)&&Math.hypot(there.x-here.x,there.y-here.y)<=.05;});};
  function checkFormula(text){const tree=parseFormula(text),names=new Set(draft.sizeTable.rows.map(row=>row.name));for(const name of formulaNames(tree))if(!names.has(name))throw new Error('尺寸表里没有“'+name+'”');}
  // a name for a new size: the next number when the names are numbers in even steps, else a name to be changed
  function nextSizeName(sizes,smaller){
    const numbers=sizes.map(size=>size.label.trim()===''?NaN:Number(size.label));
    if(sizes.length>1&&numbers.every(Number.isFinite)){const step=numbers[1]-numbers[0];if(step&&numbers.every((n,i)=>i===0||Math.abs(n-numbers[i-1]-step)<1e-9)){const text=String(Number((smaller?numbers[0]-step:numbers.at(-1)+step).toFixed(4)));if(!sizes.some(size=>size.label===text))return text;}}
    for(let n=1;;n++){const text=(smaller?'小':'大')+n+'码';if(!sizes.some(size=>size.label===text))return text;}
  }
  function addTableSize(smaller){
    const sizes=tableSizes(),slot=smaller?sizes[0].slot-1:sizes.at(-1).slot+1;
    if(draft.sizes.length>=12)throw new Error('最多 12 个目标尺码');if(slot<0||slot>49)throw new Error('号型表这一头已经排满');
    draft.sizes.push({id:crypto.randomUUID(),label:nextSizeName(sizes,smaller),step:slot-draft.sizeTable.baseSlot,slot});tableChanged();
  }
  function addTableRow(){
    const name=$('grade-table-new-name').value.trim(),base=num('grade-table-new-base'),step=$('grade-table-new-step').value.trim()?Number($('grade-table-new-step').value):0;
    if(!name||!Number.isFinite(base)||!Number.isFinite(step))throw new Error('请填名称和基码的数值（厘米）；每码差可以不填');
    draft.sizeTable.rows.push({name,values:Array.from({length:50},(_,slot)=>base+(slot-draft.sizeTable.baseSlot)*step)});
    try{normalizeGradingPlan(draft);}catch(error){draft.sizeTable.rows.pop();throw error;}
    for(const id of ['grade-table-new-name','grade-table-new-base','grade-table-new-step'])$(id).value='';tableChanged();
  }
  function removeTableRow(index){
    const name=draft.sizeTable.rows[index].name,uses=[...draft.anchors.filter(anchor=>!anchor.plain),...(draft.notchRules||[])].filter(rule=>[rule.x,rule.y].some(text=>{try{return formulaNames(parseFormula(text)).has(name);}catch{return false;}})).length;
    if(uses)throw new Error('还有 '+uses+' 个放码点的公式用到“'+name+'”，先改掉这些公式');
    draft.sizeTable.rows.splice(index,1);tableChanged();
  }
  function refreshTable(){
    const table=draft.sizeTable,sizes=tableSizes();
    $('grade-table-info').textContent='这个方案按尺寸表和公式放码（ET 的做法），管整张图。号型：'+sizes.map(size=>size.label+(size.base?'（基码）':'')).join('、')+'。有规则的点按公式移动，同一位置上没有规则的点跟着走，曲线在放码点之间整体转动缩放。在画布上点一条线，下面列出它的点，可以加规则、改公式。保存为 ET 文件时，号型、尺寸表和规则一起写入。'+(draft.lostRules?'\n有 '+draft.lostRules+' 个放码点因为改图失去了位置，规则已去掉；核对后“更新放码方案”。':'');
    // the sizes: a name can be changed; a size is added or taken away at either end
    const sizeHolder=$('grade-table-sizes'),sizeKey=JSON.stringify(sizes.map(size=>[size.slot,Boolean(size.base),size.base?size.label:'']));
    if(sizesKey!==sizeKey||!typingIn(sizeHolder)){
      sizesKey=sizeKey;sizeHolder.replaceChildren();
      sizes.forEach((size,index)=>{
        const row=document.createElement('div');row.className='grade-table-size';
        if(size.base){const text=document.createElement('span');text.textContent=size.label+' *（基码，名称在上面改）';row.append(text);sizeHolder.append(row);return;}
        const input=document.createElement('input'),remove=document.createElement('button'),target=draft.sizes.find(item=>item.slot===size.slot);
        input.value=size.label;input.maxLength=50;input.dataset.slot=size.slot;input.setAttribute('aria-label','号型 '+(index+1)+' 的名称');input.oninput=()=>{target.label=input.value;tableChanged();};
        remove.textContent='×';remove.dataset.removeSize=size.slot;remove.setAttribute('aria-label','去掉号型 '+size.label);remove.disabled=draft.sizes.length<=1||(index!==0&&index!==sizes.length-1);remove.title=remove.disabled?'只能从两头去掉号型，而且至少留一个':'去掉这个号型';
        remove.onclick=()=>{draft.sizes=draft.sizes.filter(item=>item!==target);table.series[table.activeSeries]=table.series[table.activeSeries].filter(item=>item.slot!==size.slot);tableChanged();};
        row.append(input,remove);sizeHolder.append(row);
      });
    }
    const key=JSON.stringify([table.rows.map(row=>row.name),sizes.map(size=>[size.slot,size.label])]),holder=$('grade-table-rows');
    if(tableKey!==key||!typingIn(holder)){
      tableKey=key;const grid=document.createElement('table'),head=grid.insertRow();head.append(Object.assign(document.createElement('th'),{textContent:'名称'}));
      for(const size of sizes){const cell=document.createElement('th');cell.textContent=size.label+(size.base?' *':'');if(size.base)cell.className='base';head.append(cell);}
      head.append(document.createElement('th'));
      table.rows.forEach((row,index)=>{const line=grid.insertRow();line.insertCell().textContent=row.name;
        for(const size of sizes){const input=document.createElement('input');input.type='number';input.step='any';input.value=Number(row.values[size.slot].toFixed(4));input.dataset.row=index;input.dataset.slot=size.slot;input.setAttribute('aria-label',row.name+' '+size.label+' cm');
          input.oninput=()=>{const value=input.value.trim()?Number(input.value):NaN;if(!Number.isFinite(value))return;draft.sizeTable.rows[index].values[size.slot]=value;draftEdited=true;preview=null;refreshStatusOnly();render();};line.insertCell().append(input);}
        const remove=document.createElement('button');remove.textContent='×';remove.dataset.removeRow=index;remove.setAttribute('aria-label','去掉尺寸表的“'+row.name+'”');remove.onclick=action(()=>removeTableRow(index));line.insertCell().append(remove);
      });
      if(!table.rows.length){const none=grid.insertRow().insertCell();none.colSpan=sizes.length+2;none.className='empty';none.textContent='尺寸表还是空的。在下面加一项，例如：胸围，基码 88，每码差 4。';}
      holder.replaceChildren(grid);
    }
    // the lines that have grading points, the line picked on the canvas, and the points of the current line
    const lines=new Set(draft.sources.filter(source=>source.kind!=='text').map(source=>source.entityId)),withPoints=[...new Set(draft.anchors.filter(anchor=>!anchor.plain).map(anchor=>anchor.entityId))],select=$('grade-table-entity');
    if(!lines.has(entityId))entityId=withPoints[0]||[...lines][0]||'';
    select.replaceChildren();for(const id of withPoints.includes(entityId)||!entityId?withPoints:[entityId,...withPoints])select.add(new Option(lineName(id)+' · '+draft.anchors.filter(anchor=>anchor.entityId===id&&!anchor.plain).length+' 个放码点',id));select.value=entityId;
    const list=$('grade-table-anchors');if(typingIn(list))return;list.replaceChildren();
    const entity=currentEntity(),stations=entity&&stationsOf(entity);
    if(!stations){const none=document.createElement('p');none.className='muted';none.textContent='在画布上点一条线。';list.append(none);$('grade-table-on-line').disabled=true;return;}
    const last=stations.points.length-1;
    const placed=(box,point)=>{box.dataset.x=Number(point.x.toFixed(3));box.dataset.y=Number(point.y.toFixed(3));const where=document.createElement('span');where.className='muted grade-anchor-place';where.textContent='X '+format(point.x)+' / Y '+format(point.y);return where;};
    const ruleBox=(anchor,order,text,point)=>{
      const box=document.createElement('div');box.className='grade-anchor';box.dataset.anchor=order;const title=document.createElement('strong');title.textContent=text;
      const turned=Math.abs(anchor.axisX[0]-1)>1e-4||Math.abs(anchor.axisX[1])>1e-4;if(turned)title.textContent+=' · 方向转了 '+(Math.atan2(anchor.axisX[1],anchor.axisX[0])*180/Math.PI).toFixed(1)+'°';
      box.append(title,placed(box,point));
      for(const [axis,label] of [['x','水平'],['y','竖直']]){const row=document.createElement('label'),input=document.createElement('input');row.textContent=label;input.value=anchor[axis];input.maxLength=300;input.setAttribute('aria-label',title.textContent+' '+label+'公式');input.dataset.axis=axis;
        input.onchange=()=>{
          try{checkFormula(input.value);}catch(error){notify('公式“'+input.value+'”不能用：'+error.message);input.value=anchor[axis];return;}
          const value=input.value.trim(),twins=twinsOf(anchor);anchor[axis]=value;for(const twin of twins)twin[axis]=value;draftEdited=true;preview=null;refreshStatusOnly();render();
          if(twins.length)notify('同一位置上另外 '+twins.length+' 个点带着相同的规则，一起改了。');
        };row.append(input);box.append(row);}
      const turnRow=document.createElement('label'),turnInput=document.createElement('input'),degreesOf=()=>Number((Math.atan2(anchor.axisX[1],anchor.axisX[0])*180/Math.PI).toFixed(3));
      turnRow.textContent='方向°';turnInput.type='number';turnInput.step='any';turnInput.value=degreesOf();turnInput.dataset.axis='angle';turnInput.title='规则的方向逆时针转多少度。0：水平、竖直就是图上的左右、上下';turnInput.setAttribute('aria-label',text+' 方向（度）');
      turnInput.onchange=()=>{
        const degrees=turnInput.value.trim()?Number(turnInput.value):NaN;if(!Number.isFinite(degrees)||Math.abs(degrees)>360){notify('方向请填 -360 到 360 之间的度数');turnInput.value=degreesOf();return;}
        const a=degrees*Math.PI/180,tidy=v=>Math.abs(v)<1e-12?0:v,axes={axisX:[tidy(Math.cos(a)),tidy(Math.sin(a))],axisY:[tidy(-Math.sin(a)),tidy(Math.cos(a))]},twins=twinsOf(anchor);
        for(const item of [anchor,...twins])Object.assign(item,axes);tableChanged();if(twins.length)notify('同一位置上另外 '+twins.length+' 个点带着相同的规则，方向一起改了。');
      };turnRow.append(turnInput);box.append(turnRow);
      const remove=document.createElement('button');remove.textContent='去掉这个点的规则';remove.dataset.removeRule=order;
      remove.onclick=()=>{const gone=new Set([anchor,...twinsOf(anchor)]);draft.anchors=draft.anchors.filter(item=>!gone.has(item));tableChanged();if(gone.size>1)notify('同一位置上另外 '+(gone.size-1)+' 个点的相同规则一起去掉了。');};box.append(remove);
      return box;
    };
    stations.points.forEach((point,index)=>{
      const text=index===0?'起点':index===last?'终点':'第 '+(index+1)+' 个'+(stations.curve?'曲线点':'点'),order=draft.anchors.findIndex(anchor=>anchor.entityId===entityId&&anchor.index===index&&!anchor.plain);
      if(order>=0){const box=ruleBox(draft.anchors[order],order,text,point);box.dataset.station=index;list.append(box);return;}
      const box=document.createElement('div'),title=document.createElement('strong'),add=document.createElement('button');box.className='grade-anchor grade-anchor-free';box.dataset.station=index;title.textContent=text;add.textContent='加规则';add.dataset.addRule=index;
      add.onclick=()=>{draft.anchors=draft.anchors.filter(anchor=>!(anchor.entityId===entityId&&anchor.index===index));draft.anchors.push({entityId,index,x:'',y:'',axisX:[1,0],axisY:[0,1]});tableChanged();};
      const head=document.createElement('div');head.append(title,placed(box,point));box.append(head,add);list.append(box);
    });
    $('grade-table-on-line').textContent=addingOnLine?'取消（正在等你点线上的位置）':'在这条线上加放码点';$('grade-table-on-line').disabled=Boolean(entity.curve)&&!stations.fitted;
    draft.anchors.forEach((anchor,order)=>{if(anchor.entityId===entityId&&anchor.between!==undefined&&!anchor.plain)list.append(ruleBox(anchor,order,'线上的点（第 '+(anchor.between+1)+'、'+(anchor.between+2)+' 点之间）',anchor.at));});
  }
  function loadFields(){if(!draft)return;$('grade-name').value=draft.name;$('grade-base-size').value=draft.baseSize;$('grade-interpolation').value=draft.interpolation;sizeRowsKey='';pointKey='';}
  function reset(){addingOnLine=false;draft=null;selectedId='';entityId='';pointIndex=0;preview=null;lastProject=getProject();sourceStamp=sourceSignature();sizeRowsKey='';pointKey='';draftEdited=false;baseChanged=false;}
  function invalidate(){draftEdited=true;preview=null;refresh();render();}
  function readDeltas(){return pointRows.map(row=>({sizeId:row.size.id,dx:row.x.value.trim()?Number(row.x.value):NaN,dy:row.y.value.trim()?Number(row.y.value):NaN}));}
  function storeRule(deltas){
    let rule=currentRule();if(!rule){rule={entityId,index:pointIndex,deltas:[]};draft.rules.push(rule);}rule.deltas=deltas;invalidate();
  }
  function refreshPoint(force=false){
    if(!draft)return;
    if(isTable()){refreshTable();return;}
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
      if(existing){draft=normalizeGradingPlan(existing);loadFields();preview=gradingResults(project,existing,{compute:false});draftEdited=false;baseChanged=false;}else reset();lastProject=project;
    }else if(sourceStamp!==stamp){
      const existing=project.gradingPlans?.find(plan=>plan.id===selectedId);
      if(existing&&!draftEdited){draft=normalizeGradingPlan(existing);loadFields();preview=gradingResults(project,existing,{compute:false});baseChanged=false;}
      else{preview=null;pointKey='';baseChanged=Boolean(draft);}
    }
    sourceStamp=stamp;
    const saved=$('grade-saved');saved.replaceChildren(new Option(draft&&!selectedId?'未保存草稿':'未选择方案',''));for(const plan of project.gradingPlans||[])saved.add(new Option(plan.name+' · '+(plan.method==='table'?(plan.status==='error'?'有问题':'按尺寸表'):{current:'已计算',review:'需核对',error:'有失效尺码',stale:'待计算'}[plan.status]||'待计算'),plan.id));saved.value=selectedId;
    $('grade-controls').hidden=!draft;if(!draft)return;
    $('grade-table-controls').hidden=!isTable();$('grade-point-controls').hidden=isTable();
    $('grade-save').textContent=selectedId?'更新放码方案':'保存放码方案';$('grade-delete').hidden=!selectedId;
    const sizeKey=JSON.stringify(draft.sizes.map(size=>size.id));
    if(sizeRowsKey!==sizeKey){
      sizeRowsKey=sizeKey;$('grade-sizes').replaceChildren();draft.sizes.forEach((size,index)=>{
        const row=document.createElement('div');row.className='grade-size-row';const label=document.createElement('input'),step=document.createElement('input'),remove=document.createElement('button');label.value=size.label;label.maxLength=50;label.setAttribute('aria-label','目标尺码 '+(index+1));step.type='number';step.step='any';step.value=size.step;step.setAttribute('aria-label','尺码 '+(index+1)+' 档数');remove.textContent='×';remove.setAttribute('aria-label','移除尺码 '+size.label);remove.disabled=draft.sizes.length<=1;
        label.oninput=()=>{size.label=label.value;pointKey='';invalidate();};step.oninput=()=>{size.step=step.value.trim()?Number(step.value):NaN;invalidate();};remove.onclick=()=>{draft.sizes.splice(index,1);for(const rule of draft.rules)rule.deltas=rule.deltas.filter(delta=>delta.sizeId!==size.id);pointKey='';invalidate();};row.append(label,step,remove);$('grade-sizes').append(row);
      });
    }
    const entitySelect=$('grade-entity');entitySelect.replaceChildren();
    if(!isTable()){   // (a plan that grades by a size table covers every line of the drawing: its lines are picked on the canvas)
      const names=new Map(project.entities.map(entity=>[entity.id,entity.name]));for(const source of draft.sources)entitySelect.add(new Option(names.get(source.entityId)||'缺失基准',source.entityId));
      if(!draft.sources.some(source=>source.entityId===entityId)){entityId=draft.sources[0].entityId;pointIndex=0;}entitySelect.value=entityId;
    }
    refreshPoint();
    const view=$('grade-view'),viewValue=view.value,exportSelect=$('grade-export-size'),exportValue=exportSelect.value;view.replaceChildren(new Option('全部尺码叠码','all'));exportSelect.replaceChildren();
    for(const size of draft.sizes){view.add(new Option(size.label,size.id));exportSelect.add(new Option(size.label,size.id));}view.value=draft.sizes.some(size=>size.id===viewValue)?viewValue:'all';exportSelect.value=draft.sizes.some(size=>size.id===exportValue)?exportValue:draft.sizes[0].id;
    const list=$('grade-rule-list');list.replaceChildren();const note=document.createElement('p');note.className='muted';note.textContent=isTable()?'基准 '+draft.sources.length+' 个 · 放码点 '+draft.anchors.filter(anchor=>!anchor.plain).length+' 个 · 尺寸表 '+draft.sizeTable.rows.length+' 项':'基准 '+draft.sources.length+' 个 · 已设规则 '+draft.rules.length+' 点';list.append(note);
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
    }else $('grade-status').textContent=isTable()&&!draftEdited?'这个方案的各尺码在用到时才计算：点“预览各尺码”。':(baseChanged?'基码已变化，未保存草稿的增量按当前坐标轴保留，请逐点确认。':'规则或基准已修改，请预览各尺码。')+'未预览的草稿不能导出。';
    const chosen=preview?.find(result=>result.size.id===exportSelect.value),canExport=Boolean(chosen?.project&&!chosen.error);
    $('grade-export-project').disabled=!canExport;$('grade-export-dxf').disabled=!canExport;$('grade-export-all').disabled=!preview?.length||preview.some(result=>result.error);$('grade-report').disabled=!preview;$('grade-fit').disabled=!preview?.some(result=>result.project);
  }
  function refreshStatusOnly(){$('grade-status').textContent='规则或尺寸表已修改，请预览各尺码。未预览的草稿不能导出。';$('grade-results').replaceChildren();for(const id of ['grade-export-project','grade-export-dxf','grade-export-all','grade-fit'])$(id).disabled=true;$('grade-report').disabled=true;}
  function compute(){try{const config=normalizeGradingPlan(draft);preview=evaluateGradingPlan(getProject(),config);refresh();render();}catch(error){preview=null;refresh();$('grade-status').textContent='预览失败：'+error.message;render();throw error;}}
  function chosen(){if(!preview)throw new Error('请先预览当前规则');const result=preview.find(result=>result.size.id===$('grade-export-size').value);if(!result?.project||result.error)throw new Error(result?.error||'该尺码不能导出');return result;}
  function filename(name){return name.replace(/[<>:"/\\|?*]/g,'_');}
  $('grade-create').onclick=action(()=>{draft=createGradingPlan(getProject(),getSelection(),()=>crypto.randomUUID());selectedId='';entityId=draft.sources[0].entityId;pointIndex=0;preview=null;lastProject=getProject();sourceStamp=sourceSignature();draftEdited=true;baseChanged=false;loadFields();setTool('grading');refresh();render();});
  $('grade-create-table').onclick=action(()=>{draft=createTablePlan(getProject(),()=>crypto.randomUUID());selectedId='';entityId='';pointIndex=0;preview=null;lastProject=getProject();sourceStamp=sourceSignature();draftEdited=true;baseChanged=false;loadFields();setTool('grading');refresh();render();});
  $('grade-table-on-line').onclick=()=>{addingOnLine=!addingOnLine;refresh();if(addingOnLine)notify('在画布上点这条线上要加放码点的位置。');};
  $('grade-table-smaller').onclick=action(()=>addTableSize(true));$('grade-table-larger').onclick=action(()=>addTableSize(false));$('grade-table-add-row').onclick=action(addTableRow);
  $('grade-saved').onchange=action(()=>{selectedId=$('grade-saved').value;if(!selectedId){reset();refresh();render();return;}const plan=getProject().gradingPlans.find(plan=>plan.id===selectedId);draft=normalizeGradingPlan(plan);preview=gradingResults(getProject(),plan);draftEdited=false;baseChanged=false;loadFields();refresh();render();});
  for(const [id,key] of [['grade-name','name'],['grade-base-size','baseSize'],['grade-interpolation','interpolation']])$(id).oninput=()=>{if(!draft)return;draft[key]=$(id).value;if(key!=='name')pointKey='';invalidate();};
  $('grade-add-size').onclick=action(()=>{
    if(draft.sizes.length>=12)throw new Error('最多支持 12 个目标尺码');const label=$('grade-new-size').value.trim(),step=num('grade-new-step');
    if(!label||label===draft.baseSize||draft.sizes.some(size=>size.label===label)||!Number.isFinite(step)||step===0||Math.abs(step)>100)throw new Error('请输入唯一尺码名称和非零档数（±100 以内）');
    const size={id:crypto.randomUUID(),label,step};draft.sizes.push(size);for(const rule of draft.rules)rule.deltas.push({sizeId:size.id,dx:0,dy:0});$('grade-new-size').value='';pointKey='';invalidate();
  });
  $('grade-entity').onchange=()=>{entityId=$('grade-entity').value;pointIndex=0;pointKey='';refresh();render();};
  $('grade-table-entity').onchange=()=>{entityId=$('grade-table-entity').value;refresh();render();const entity=currentEntity();if(entity)fit([entity]);};
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
  $('grade-preview').onclick=action(compute);$('grade-show-rules').onchange=render;$('grade-show').onchange=render;$('grade-show-text').onchange=render;$('grade-view').onchange=render;$('grade-export-size').onchange=refresh;
  $('grade-fit').onclick=()=>{const entities=preview?.filter(result=>result.project).flatMap(result=>result.project.entities)||[];for(const source of draft.sources){const e=getProject().entities.find(e=>e.id===source.entityId);if(e)entities.push(e);}if(entities.length)fit(entities);};
  $('grade-save').onclick=action(()=>{const next=clone(getProject()),table=isTable();if(table)draft.lostRules=0;const plan=applyGradingPlan(next,draft,()=>crypto.randomUUID(),selectedId||null);selectedId=plan.id;commit(next);notify('放码方案已记入工程；请保存 .zycad 文件。'+(table?'保存为 ET 文件时，号型、尺寸表和规则一起写入。':''));});
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
    if(!draft||getTool()!=='grading')return;
    if(isTable()&&$('grade-show-rules').checked){   // every rule beside its point (ET: 显示放码规则); rules that say the same on one place are written once
      const seen=new Set(),lines=new Map(),placeOn=anchor=>{if(anchor.between!==undefined)return anchor.at;if(!lines.has(anchor.entityId)){const line=getProject().entities.find(item=>item.id===anchor.entityId);lines.set(anchor.entityId,line?stationsOf(line):null);}return lines.get(anchor.entityId)?.points[anchor.index]||null;};
      for(const anchor of draft.anchors){
        if(anchor.plain)continue;const p=placeOn(anchor);if(!p)continue;const turned=Math.atan2(anchor.axisX[1],anchor.axisX[0])*180/Math.PI;
        const text=([anchor.x?'→ '+anchor.x:'',anchor.y?'↑ '+anchor.y:''].filter(Boolean).join('   ')||'固定')+(Math.abs(turned)>1e-4?'   ∠'+Number(turned.toFixed(1))+'°':''),key=Math.round(p.x*10)+','+Math.round(p.y*10)+'|'+text;if(seen.has(key))continue;seen.add(key);
        const at=screen(p),label=node('text',{x:at.x+9,y:at.y-7,fill:'#2f6e4a','font-size':11,'paint-order':'stroke',stroke:'#fff','stroke-width':3,'data-grade-rule':anchor.entityId},overlay);label.textContent=text;
        node('circle',{cx:at.x,cy:at.y,r:2.5,fill:'#66ab80','data-grade-rule-dot':anchor.entityId},overlay);
      }
    }
    const entity=currentEntity();if(!entity)return;
    if(isTable()){   // the points the current line is drawn through, with its grading points marked
      const stations=stationsOf(entity);if(!stations)return;const ruled=new Set(draft.anchors.filter(anchor=>anchor.entityId===entity.id&&!anchor.plain&&anchor.index!==undefined).map(anchor=>anchor.index));
      stations.points.forEach((p,index)=>{const at=screen(p);node('circle',{cx:at.x,cy:at.y,r:ruled.has(index)?5:3,fill:ruled.has(index)?'#66ab80':'#fff',stroke:'#bd8b3c','stroke-width':2,'data-grade-station':index},overlay);});
      for(const anchor of draft.anchors)if(anchor.entityId===entity.id&&anchor.between!==undefined&&!anchor.plain){const at=screen(anchor.at);node('circle',{cx:at.x,cy:at.y,r:5,fill:'#66ab80',stroke:'#bd8b3c','stroke-width':2,'data-grade-on-line':anchor.between},overlay);}
      return;
    }
    const points=gradePoints(entity);
    if(entity.curve)node('path',{d:pathData(points),fill:'none',stroke:'#d8ab56','stroke-dasharray':'4 4'},overlay);
    points.forEach((p,index)=>{const s=screen(p),rule=draft.rules.some(rule=>rule.entityId===entity.id&&rule.index===index);node('circle',{cx:s.x,cy:s.y,r:index===pointIndex?6:4,fill:rule?'#66ab80':'#fff',stroke:'#bd8b3c','stroke-width':2,'data-grade-point':index},overlay);if(points.length<=100||index===pointIndex){const label=node('text',{x:s.x+7,y:s.y-8,fill:'#c68d37','font-size':12},overlay);label.textContent=String(index+1);}});
  }
  function pick(point,scale,target){
    if(!draft){notify('先选取基码裁片，再建立放码方案。');return;}
    if(isTable()&&addingOnLine){   // ET's 增加放码点: a grading point on the current line, where the click falls on it
      const entity=currentEntity(),path=entity?.points||[];let best=null;
      for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i],dx=b.x-a.x,dy=b.y-a.y,q=dx*dx+dy*dy,t=q?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/q)):0,at={x:a.x+t*dx,y:a.y+t*dy},distance=Math.hypot(point.x-at.x,point.y-at.y);if(!best||distance<best.distance)best={distance,at};}
      if(!best||best.distance>10/scale){notify('请点在当前这条线上（“'+(entity?.name||'')+'”）');return;}
      const where=placeOnLine(entity,best.at);addingOnLine=false;
      if(!where||where.index!==undefined){notify('这里已经是这条线的一个点：在列表里给它加规则就行');refresh();return;}
      draft.anchors.push({entityId,between:where.between,at:best.at,x:'',y:'',axisX:[1,0],axisY:[0,1]});tableChanged();notify('放码点加在线上了，给它填公式；不填就是固定点，曲线在这里分成两段。');return;
    }
    if(isTable()){   // a click on a line of the plan shows its grading points
      if(target&&draft.sources.some(source=>source.entityId===target.entity.id&&source.kind!=='text')){entityId=target.entity.id;refresh();render();$('grade-table-anchors').scrollIntoView({block:'nearest'});}else notify('请点一条线（刚画的线要先“更新放码方案”才进方案；文字不带放码点）');return;
    }
    let chosen=null,closest=8/scale;
    for(const source of draft.sources){const entity=getProject().entities.find(e=>e.id===source.entityId);if(!entity)continue;gradePoints(entity).forEach((p,index)=>{const d=Math.hypot(p.x-point.x,p.y-point.y);if(d<closest){closest=d;chosen={entityId:entity.id,index};}});}
    if(chosen){entityId=chosen.entityId;pointIndex=chosen.index;}else if(target&&draft.sources.some(source=>source.entityId===target.entity.id)){entityId=target.entity.id;pointIndex=0;}else{notify('请点选方案内的基准线或控制点');return;}
    pointKey='';refresh();render();$('grade-deltas').scrollIntoView({block:'center'});
  }
  reset();return {reset,refresh,draw,pick,begin:()=>{setTool('grading');refresh();$('grading-panel').scrollIntoView({block:'start'});}};
}
