import {prepareEndpointExtension,applyEndpointExtension} from './endpoint-extend.mjs';
import {lineEditStamp} from './line-edit.mjs';

export function createEndpointExtendPanel({getProject,getSelection,getTool,commit,setTool,render,fit,notify}){
  const $=id=>document.getElementById(id),format=n=>Number(n.toPrecision(10)).toString();
  let targetId=null,referenceIds=[],pickMode='target',preview=null,rowsKey='',message='记录开放目标线与有限参考线，再预览延伸。';
  const guard=fn=>(...args)=>{try{fn(...args);}catch(error){message=error.message.replace('修剪','延伸').replace('；可切换端点吸附','');notify(message);refresh();render();}};
  const number=id=>$(id).value.trim()?Number($(id).value):NaN;
  const source=()=>getProject().entities.find(e=>e.id===targetId);
  function selectedOriginal(){
    const ids=getSelection(),originals=getProject().entities.filter(e=>ids.has(e.id)&&e.type!=='text'&&!e.derivedFrom&&!e.notchFrom);
    if(originals.length!==1)throw new Error('目标选区须有唯一一条原始线；请单独选中或在画布拾取');return originals[0].id;
  }
  function invalidate(text='设置已变化，请重新生成延伸预览。'){preview=null;message=text;}
  function reset(){targetId=null;referenceIds=[];pickMode='target';rowsKey='';invalidate('记录开放目标线与有限参考线，再预览延伸。');}
  function recordTarget(id){
    const entity=getProject().entities.find(e=>e.id===id);
    if(!entity||entity.type==='text'||entity.closed||entity.derivedFrom||entity.notchFrom)throw new Error('目标须为一条开放原线；关联输出须先解除关联');
    targetId=id;referenceIds=referenceIds.filter(v=>v!==id);pickMode='references';invalidate();setTool('extend');refresh();render();
  }
  function recordReferences(ids){
    if(!targetId)throw new Error('请先记录目标线');const values=[...new Set(ids)].filter(id=>id!==targetId);
    if(values.length>64)throw new Error('最多使用 64 条参考线');
    if(values.some(id=>{const e=getProject().entities.find(e=>e.id===id);return !e||e.type==='text';}))throw new Error('参考只能选择线条');
    referenceIds=values;pickMode='references';invalidate();setTool('extend');refresh();render();
  }
  function pick(entity,point,radius){guard(()=>{
    if(pickMode==='target'){if(!entity)throw new Error('请点选开放目标线');recordTarget(entity.id);return;}
    if(pickMode==='references'){if(!entity)throw new Error('请点选参考线');if(entity.id===targetId)throw new Error('目标不能同时作为参考线');recordReferences(referenceIds.includes(entity.id)?referenceIds.filter(id=>id!==entity.id):[...referenceIds,entity.id]);return;}
    const target=source();if(!target)throw new Error('请先记录目标线');const controls=target.curve?.controlPoints||target.points,a=controls[0],b=controls.at(-1),da=Math.hypot(point.x-a.x,point.y-a.y),db=Math.hypot(point.x-b.x,point.y-b.y);
    if(Math.min(da,db)>radius)throw new Error('请点击原线的起点或终点圆点');
    if(Math.abs(da-db)<radius*.2)throw new Error('首尾端点过于接近，请在端点列表中明确选择');
    $('extend-end').value=da<db?'start':'end';invalidate();refresh();render();
  })();}
  function refresh(){
    const project=getProject(),byId=new Map(project.entities.map(e=>[e.id,e]));
    if(preview&&preview.signature!==lineEditStamp(project))invalidate('工程已变化，请重新生成延伸预览。');
    $('extend-target-name').textContent=targetId?(byId.get(targetId)?.name||'目标已删除'):'尚未记录目标';
    $('extend-preview').disabled=!targetId||!referenceIds.length;$('extend-pick-end').disabled=!targetId;$('extend-apply').disabled=!preview;$('extend-fit').disabled=!preview;
    $('extend-apply').textContent=$('extend-keep').checked?'保留原线并应用':'替换目标线并应用';
    for(const mode of ['target','references','end'])$('extend-pick-'+mode).classList.toggle('active',pickMode===mode&&getTool()==='extend');
    $('extend-pick-status').textContent=pickMode==='target'?'画布：点选开放目标线':pickMode==='references'?'画布：点选参考线；再次点选可移除':'画布：点选原线的起点或终点';
    $('extend-mode-note').textContent=$('extend-mode').value==='native'?'沿端部原生曲线继续；遇到停驻点可能回折，请核对预览。':'沿端点的切向直线继续，保留原曲线。';
    const key=JSON.stringify(referenceIds.map(id=>[id,byId.get(id)?.name]));
    if(key!==rowsKey){rowsKey=key;$('extend-references').replaceChildren();for(const id of referenceIds){const row=document.createElement('div');row.className='extend-reference-row';const label=document.createElement('span');label.textContent=byId.get(id)?.name||'参考已删除';const remove=document.createElement('button');remove.textContent='×';remove.title='移除 '+label.textContent;remove.onclick=guard(()=>recordReferences(referenceIds.filter(v=>v!==id)));row.append(label,remove);$('extend-references').append(row);}}
    const status=$('extend-status');status.replaceChildren();const add=text=>{const p=document.createElement('p');p.textContent=text;status.append(p);};
    if(!preview)add(message);
    else{
      const bounds=preview.piece.lengthBounds,names=[...new Set(preview.hit.contributors.map(c=>byId.get(c.entityId)?.name||c.entityId))];
      add('沿延伸路径的第一个交点：'+names.join('、')+'。橙色为新增部分。');
      add('延伸长度约 '+format((bounds.lower+bounds.upper)/2)+' mm，已证明不超过 '+format(preview.config.maxLength)+' mm。');
      add('长度上下界：'+format(bounds.lower)+' — '+format(bounds.upper)+' mm；几何误差上界 ≤ '+preview.piece.errorBound.toExponential(2)+' mm。');
      if(preview.config.keepOriginals)add('原线与原关联保留；生成独立延伸副本。');
      if(preview.affectedContours.length)add('端点移动可能断开原裁片轮廓（'+preview.affectedContours.join('、')+'），请核对接边。');
      if(preview.effects.length)add('以下关联将失效，须重建：'+preview.effects.map(e=>e.label+' '+e.count+' 项').join('；')+'。旧输出保留供核对。');
    }
  }
  function draw({node,overlay,screen,pathData}){
    if(getTool()!=='extend')return;const entity=source();if(!entity)return;
    const controls=entity.curve?.controlPoints||entity.points;
    for(const [end,point] of [['start',controls[0]],['end',controls.at(-1)]]){const p=screen(point),chosen=$('extend-end').value===end;node('circle',{cx:p.x,cy:p.y,r:chosen?6:4,fill:'#fff',stroke:chosen?'#d38227':'#397b9a','stroke-width':2,'data-extend-endpoint':end},overlay);const label=node('text',{x:p.x+8,y:p.y-10,fill:chosen?'#b36b1d':'#397b9a','font-size':12},overlay);label.textContent=end==='start'?'起点':'终点';}
    for(const id of referenceIds){const reference=getProject().entities.find(e=>e.id===id);if(reference)node('path',{d:pathData(reference.points,reference.closed),fill:'none',stroke:'#3694ac','stroke-width':2,'stroke-dasharray':'5 4','data-extend-reference':id},overlay);}
    if(!preview)return;
    const p=preview.piece.points.map(screen),d='M '+p[0].x+' '+p[0].y+' '+(p.length===2?'L ':p.length===3?'Q ':'C ')+p.slice(1).map(q=>q.x+' '+q.y).join(' ');
    node('path',{d,fill:'none',stroke:'#dc8129','stroke-width':3.5,'data-extend-preview':'true'},overlay);
    const point=p.at(-1);node('circle',{cx:point.x,cy:point.y,r:6,fill:'#fff',stroke:'#dc8129','stroke-width':2,'data-extend-hit':'true'},overlay);const label=node('text',{x:point.x+9,y:point.y+16,fill:'#bc6c21','font-size':12},overlay);label.textContent='延伸交点';
  }
  $('extend-capture-target').onclick=guard(()=>recordTarget(selectedOriginal()));
  $('extend-capture-references').onclick=guard(()=>{const ids=[...getSelection()].filter(id=>id!==targetId);if(!ids.length)throw new Error('当前选区没有可用参考线');recordReferences(ids);});
  for(const mode of ['target','references','end'])$('extend-pick-'+mode).onclick=()=>{pickMode=mode;setTool('extend');refresh();render();};
  for(const id of ['extend-end','extend-mode','extend-length','extend-error','extend-length-error','extend-keep'])$(id).oninput=()=>{invalidate();refresh();render();};
  $('extend-clear').onclick=()=>{reset();refresh();render();};
  $('extend-preview').onclick=guard(()=>{preview=null;preview=prepareEndpointExtension(getProject(),{targetId,referenceIds,end:$('extend-end').value,mode:$('extend-mode').value,maxLength:number('extend-length'),errorTolerance:number('extend-error'),lengthTolerance:number('extend-length-error'),keepOriginals:$('extend-keep').checked});setTool('extend');refresh();render();});
  $('extend-fit').onclick=()=>{if(preview)fit(preview.outputs);};
  $('extend-apply').onclick=guard(()=>{const result=applyEndpointExtension(getProject(),preview,()=>crypto.randomUUID());reset();commit(result.project,result.outputIds);notify('端点延伸已应用，可撤销。请保存工程文件。');});
  return {reset,refresh,draw,pick,begin(){setTool('extend');if(!targetId&&getSelection().size)try{recordTarget(selectedOriginal());}catch(error){message=error.message;}refresh();$('extend-panel').scrollIntoView({block:'center'});}};
}
