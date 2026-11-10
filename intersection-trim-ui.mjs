import {analyzeIntersectionTrim,prepareIntersectionTrim,applyIntersectionTrim} from './intersection-trim.mjs';
import {lineEditStamp} from './line-edit.mjs';
import {nearestBezier,evaluateBezier} from './bezier-cut.mjs';

export function createIntersectionTrimPanel({getProject,getSelection,getTool,commit,setTool,render,fit,notify}){
  const $=id=>document.getElementById(id),format=n=>n.toFixed(5).replace(/0+$/,'').replace(/\.$/,'');
  let targetId=null,cutterIds=[],mode='target',analysis=null,preview=null,regionIndex=null,message='先记录一条目标线，再记录切割参考线。',rowsKey='';
  const guard=fn=>(...args)=>{try{fn(...args);}catch(error){message=error.message;notify(message);refresh();render();}};
  function invalidate(text='选择或误差上限已变化，请重新分析交点。'){analysis=null;preview=null;regionIndex=null;message=text;rowsKey='';}
  function reset(){targetId=null;cutterIds=[];mode='target';invalidate('先记录一条目标线，再记录切割参考线。');}
  function setTarget(id){
    const entity=getProject().entities.find(e=>e.id===id);if(!entity||entity.type==='text'||entity.derivedFrom||entity.notchFrom)throw new Error('目标须为一条原始线；关联输出须先解除关联');
    targetId=id;cutterIds=cutterIds.filter(v=>v!==id);invalidate();mode='cutters';setTool('trim');refresh();render();
  }
  function setCutters(ids){
    if(!targetId)throw new Error('请先记录目标线');
    const values=[...new Set(ids)].filter(id=>id!==targetId);
    if(values.length>64)throw new Error('最多记录 64 条切割参考线');
    if(values.some(id=>{const e=getProject().entities.find(e=>e.id===id);return !e||e.type==='text';}))throw new Error('切割参考只能选择线条');
    cutterIds=values;invalidate();mode='cutters';setTool('trim');refresh();render();
  }
  function buildPreview(){
    preview=null;if(analysis&&regionIndex!==null)preview=prepareIntersectionTrim(getProject(),analysis,{regionIndex,action:$('trim-action').value,keepOriginals:$('trim-keep').checked});
  }
  function selectRegion(index){regionIndex=index;message='';buildPreview();mode='region';refresh();render();}
  function pick(entity,point,radius){guard(()=>{
    if(mode==='target'){if(!entity)throw new Error('请点选目标线');setTarget(entity.id);return;}
    if(mode==='cutters'){if(!entity)throw new Error('请点选切割参考线');if(entity.id===targetId)throw new Error('目标线不能同时作为切割参考');setCutters(cutterIds.includes(entity.id)?cutterIds.filter(id=>id!==entity.id):[...cutterIds,entity.id]);return;}
    if(!analysis)throw new Error('请先分析交点');
    const candidates=analysis.regions.map(region=>({index:region.index,distance:Math.min(...region.spans.map(span=>nearestBezier(span.points,point).distance))})).sort((a,b)=>a.distance-b.distance);
    if(candidates[0].distance>radius)throw new Error('请点击目标线上的区间中部，或使用区间列表');
    if(candidates[1]&&candidates[1].distance-candidates[0].distance<radius*.2)throw new Error('此处靠近切点或重叠区间，请点击区间中部或使用列表');
    selectRegion(candidates[0].index);
  })();}
  function refresh(){
    const project=getProject(),byId=new Map(project.entities.map(e=>[e.id,e]));
    if(analysis&&analysis.signature!==lineEditStamp(project))invalidate('工程已变化，请重新分析交点。');
    $('trim-target-name').textContent=targetId?(byId.get(targetId)?.name||'目标已删除'):'尚未记录目标';
    for(const value of ['target','cutters','region'])$('trim-pick-'+value).classList.toggle('active',mode===value&&getTool()==='trim');
    $('trim-pick-region').disabled=!analysis;$('trim-analyze').disabled=!targetId||!cutterIds.length;
    $('trim-pick-status').textContent=mode==='target'?'画布：点选一条目标线':mode==='cutters'?'画布：点选参考线；再次点选可移除':'画布：点选要处理的区间中部';
    $('trim-apply').disabled=!preview;$('trim-fit').disabled=!analysis;
    $('trim-apply').textContent=$('trim-keep').checked?'保留原线并应用':'替换目标线并应用';
    const key=JSON.stringify([targetId,cutterIds,cutterIds.map(id=>byId.get(id)?.name),analysis?.signature,regionIndex]);
    if(key!==rowsKey){rowsKey=key;$('trim-cutters').replaceChildren();
      for(const id of cutterIds){const row=document.createElement('div');row.className='trim-cutter-row';const label=document.createElement('span');label.textContent=byId.get(id)?.name||'参考已删除';const remove=document.createElement('button');remove.textContent='×';remove.title='移除 '+label.textContent;remove.onclick=guard(()=>setCutters(cutterIds.filter(v=>v!==id)));row.append(label,remove);$('trim-cutters').append(row);}
      $('trim-regions').replaceChildren();
      for(const region of analysis?.regions||[]){const button=document.createElement('button');button.dataset.trimRegion=region.index;button.classList.toggle('active',regionIndex===region.index);button.setAttribute('aria-pressed',String(regionIndex===region.index));button.textContent='区间 '+(region.index+1)+' · '+format(region.length)+' mm'+(analysis.closed&&region.index===analysis.regions.length-1?' · 跨起点':'');button.onclick=guard(()=>selectRegion(region.index));$('trim-regions').append(button);}
    }
    const status=$('trim-status');status.replaceChildren();const add=text=>{const p=document.createElement('p');p.textContent=text;status.append(p);};
    if(!analysis)add(message);
    else{
      add(analysis.cuts.length+' 个路径切点 · '+analysis.regions.length+' 个区间。'+(regionIndex===null?'请选择一个区间。':'已选区间 '+(regionIndex+1)+'。'));
      if(preview){
        add((preview.config.action==='remove'?'删除所选区间':'只保留所选区间')+'，得到 '+preview.outputs.length+' 条开放线。绿色保留，红色虚线移除。');
        add('切段几何误差上界 ≤ '+preview.errorBound.toExponential(2)+' mm；列表长度为数值积分值。');
        if(preview.config.keepOriginals)add('原线及原关联保留；结果是独立副本。');
        if(preview.opensClosed||preview.affectedContours.length)add('修剪可能使裁片轮廓断开'+(preview.affectedContours.length?'（'+preview.affectedContours.join('、')+'）':'')+'。请修复轮廓后再生成缝份或排料。');
        if(preview.effects.length)add('以下关联将失效，须重建：'+preview.effects.map(e=>e.label+' '+e.count+' 项').join('；')+'。旧输出保留供核对。');
        if(preview.dissolved.length)add('组合已转为独立图元名称：'+preview.dissolved.join('、')+'。');
      }
      if(message&&message!=='选择或误差上限已变化，请重新分析交点。')add(message);
    }
  }
  function draw({node,overlay,screen,pathData}){
    if(getTool()!=='trim')return;
    const path=spans=>spans.map((span,i)=>{const p=span.points.map(screen);return(i?'':'M '+p[0].x+' '+p[0].y+' ')+(p.length===2?'L ':p.length===3?'Q ':'C ')+p.slice(1).map(p=>p.x+' '+p.y).join(' ');}).join(' ');
    if(analysis){for(const region of analysis.regions){
      const chosen=region.index===regionIndex,kept=preview&&(preview.config.action==='keep'?chosen:!chosen),removed=preview&&!kept,color=preview?(kept?'#178868':'#df6450'):'#c58b32';
      node('path',{d:path(region.spans),fill:'none',stroke:color,'stroke-width':chosen?4:2.5,...(removed?{'stroke-dasharray':'6 4'}:{}),'data-trim-preview':region.index,'data-trim-kept':String(Boolean(kept))},overlay);
      const span=region.spans[Math.floor(region.spans.length/2)],p=screen(evaluateBezier(span.points,.5)),label=node('text',{x:p.x+8,y:p.y-9,fill:color,'font-size':13,'font-weight':700,'paint-order':'stroke',stroke:'#fff','stroke-width':2,'data-trim-label':region.index},overlay);label.textContent=String(region.index+1);
    }
    for(const [i,cut] of analysis.cuts.entries()){const p=screen(cut.point||analysis.parts[cut.partIndex]?.points[0]||analysis.parts.at(-1).points.at(-1));node('circle',{cx:p.x,cy:p.y,r:4,fill:'#fff',stroke:'#296a8e','stroke-width':1.5,'data-trim-cut':i},overlay);}
    }else{
      for(const id of [targetId,...cutterIds]){const e=getProject().entities.find(e=>e.id===id);if(e)node('path',{d:pathData(e.points,e.closed),fill:'none',stroke:id===targetId?'#c58b32':'#3394ae','stroke-width':3,'stroke-dasharray':id===targetId?'':'4 3','data-trim-source':id},overlay);}
    }
  }
  $('trim-capture-target').onclick=guard(()=>{const ids=[...getSelection()];if(ids.length!==1)throw new Error('请选中一条目标线，或使用画布拾取');setTarget(ids[0]);});
  $('trim-capture-cutters').onclick=guard(()=>{const ids=[...getSelection()].filter(id=>id!==targetId);if(!ids.length)throw new Error('当前选区没有可用的切割参考线');setCutters(ids);});
  for(const value of ['target','cutters','region'])$('trim-pick-'+value).onclick=()=>{mode=value;setTool('trim');refresh();render();};
  $('trim-clear').onclick=()=>{reset();refresh();render();};
  $('trim-analyze').onclick=guard(()=>{invalidate('');analysis=analyzeIntersectionTrim(getProject(),{targetId,cutterIds,errorTolerance:$('trim-error').value.trim()?Number($('trim-error').value):NaN});mode='region';setTool('trim');refresh();render();});
  $('trim-error').oninput=()=>{invalidate();refresh();render();};
  for(const id of ['trim-action','trim-keep'])$(id).oninput=guard(()=>{message='';buildPreview();refresh();render();});
  $('trim-fit').onclick=()=>{if(analysis)fit(analysis.regions.map(r=>r.entity));};
  $('trim-apply').onclick=guard(()=>{const result=applyIntersectionTrim(getProject(),preview,()=>crypto.randomUUID());reset();commit(result.project,result.outputIds);notify('交点修剪已应用，可撤销。请保存工程文件。');});
  return {reset,refresh,draw,pick,begin(){setTool('trim');if(!targetId&&getSelection().size===1)try{setTarget([...getSelection()][0]);}catch(error){message=error.message;}refresh();$('trim-panel').scrollIntoView({block:'center'});}};
}
