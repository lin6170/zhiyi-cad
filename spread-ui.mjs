import { prepareSpread, applySpread, spreadBoundary, pickSpreadStation, spreadStamp } from './spread.mjs';
import { seamBases } from './seams.mjs';
import { stationOnPath } from './path-metrics.mjs';
import { bezierSpans } from './curves.mjs';
export function createSpreadPanel({getProject,getSelection,getTool,setTool,commit,render,fit,notify}){
  const $=id=>document.getElementById(id),number=id=>$(id).value.trim()?Number($(id).value):NaN,format=n=>Number.isFinite(n)?Number(n.toFixed(5)).toString():'—';
  let choices=[],basis=null,boundary=null,boundaryKey='',preview=null,picking=null,message='选择裁片组合或单条闭合线，再记录轮廓。';
  const guard=fn=>()=>{try{fn();}catch(error){invalidate(error.message);notify(error.message);refresh();render();}};
  function invalidate(text='参数已变化，请重新生成预览。'){preview=null;message=text;}
  function reset(){choices=[];basis=null;boundary=null;boundaryKey='';picking=null;invalidate('选择裁片组合或单条闭合线，再记录轮廓。');$('spread-basis').replaceChildren();}
  function config(){return {basis,a:number('spread-a'),b:number('spread-b'),side:$('spread-side').value,mode:$('spread-mode').value,angle:number('spread-angle'),width:number('spread-width'),gapTolerance:number('spread-gap'),onCut:$('spread-on-cut').value,keepOriginals:$('spread-keep').checked};}
  function getBoundary(){const key=JSON.stringify([basis,$('spread-gap').value,spreadStamp(getProject())]);if(key!==boundaryKey){boundary=null;boundaryKey='';boundary=spreadBoundary(getProject(),basis,number('spread-gap'));boundaryKey=key;}return boundary;}
  function capture(){
    choices=seamBases(getProject(),getSelection());if(!choices.length)throw new Error('请选择完整裁片组合或单条闭合线；多条边需先定义轮廓');
    const select=$('spread-basis');select.replaceChildren();choices.forEach((choice,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=choice.name;select.append(option);});basis=choices[0];boundaryKey='';picking=null;invalidate('轮廓已记录。请确认净线，并指定切点 A、B。');getBoundary();refresh();render();
  }
  function refresh(){
    if(preview&&preview.signature!==spreadStamp(getProject()))invalidate('工程已变化，请重新预览。');
    const rotate=$('spread-mode').value==='rotate';$('spread-angle-field').hidden=!rotate;$('spread-width-field').hidden=rotate;
    $('spread-apply').disabled=!preview;$('spread-fit').disabled=!preview;$('spread-apply').textContent=$('spread-keep').checked?'保留原片并生成展开片':'替换原片并应用';
    for(const slot of ['a','b']){$('spread-pick-'+slot).classList.toggle('active',picking===slot);$('spread-pick-'+slot).setAttribute('aria-pressed',String(picking===slot));}
    $('spread-pick-status').textContent=picking?'在所选轮廓附近单击切点 '+picking.toUpperCase()+'。':'A 为旋转支点；B 为展开口。拾取会定位到原生曲线上。';$('spread-cancel-pick').hidden=!picking;
    try{const b=basis?getBoundary():null;$('spread-source').textContent=b?basis.entityIds.length+' 条边 · 周长 '+format(b.total)+' mm':'尚未记录轮廓';}catch(error){$('spread-source').textContent=error.message;}
    const status=$('spread-status');status.replaceChildren();const row=(text,warn=false)=>{const p=document.createElement('p');p.textContent=text;if(warn)p.className='spread-warning';status.append(p);};
    if(!preview){row(message);return;}
    row('预览就绪 · 切线 '+format(preview.cutLength)+' mm · 展开口 '+format(preview.mouthGap)+' mm');
    row('面积 '+format(preview.areaBefore/100)+' → '+format(preview.areaAfter/100)+' cm²，增加 '+format((preview.areaAfter-preview.areaBefore)/100)+' cm²。');
    row(preview.splitCount+' 处内部线切分 · '+preview.outputs.filter(e=>e.curve).length+' 段原生曲线保留。');
    if(preview.bridges.length)row('原轮廓 '+preview.bridges.length+' 处间隙已补直线，最大 '+format(Math.max(...preview.bridges.map(b=>b.gap)))+' mm。',true);
    row(preview.config.keepOriginals?'原片及其工艺关联保留；展开片为独立裁片，可重新添加缝份、刀口和放码。':'应用后替换原始图元；原工艺引用将失效，旧输出保留供核对。',!preview.config.keepOriginals);
    if(preview.effects.length)row('涉及的原工艺：'+preview.effects.map(e=>e.label+' '+e.count+' 项').join('；')+'。',true);
    preview.warnings.forEach(w=>row(w,true));
    row('原生轮廓自交检查已通过；另核对 0.001 mm 网格可用性。');
  }
  function pick(world,tolerance){try{if(!picking){notify('请先在展开面板选择拾取 A 或 B');return;}const station=pickSpreadStation(getBoundary(),world);if(station.distance>tolerance)throw new Error('请在所选轮廓附近拾取');$('spread-'+picking).value=String(station.percent===100?0:station.percent);picking=null;invalidate('切点已定位，请预览展开结果。');refresh();render();}catch(error){notify(error.message);}}
  function draw({node,overlay,screen,pathData,scale}){
    if(getTool()!=='spread')return;
    const nativePath=entity=>{if(!entity.curve)return pathData(entity.points,entity.closed);let d='';for(const span of bezierSpans(entity.curve)){const p=span.controlPoints.map(screen);if(!d)d=`M ${p[0].x} ${p[0].y}`;d+=' '+(p.length===3?'Q ':'C ')+p.slice(1).map(q=>q.x+' '+q.y).join(' ');}return d+(entity.closed?' Z':'');};
    let cut=preview?.cut;
    if(!cut&&basis)try{const b=getBoundary();cut=[number('spread-a'),number('spread-b')].map(s=>stationOnPath(b,s/100*b.total,{pointOnly:true}).point);}catch{}
    if(cut){node('path',{d:pathData(cut),stroke:'#48aeb7','stroke-width':2,'stroke-dasharray':'6 4',fill:'none','data-spread-cut':'true'},overlay);cut.forEach((p,i)=>{const q=screen(p);node('circle',{cx:q.x,cy:q.y,r:5,fill:'#fff',stroke:'#2c899b','stroke-width':2},overlay);const t=node('text',{x:q.x+9,y:q.y-9,fill:'#27a6b9','font-size':14},overlay);t.textContent=i?'B 展开口':'A 支点';});}
    if(!preview)return;
    const moving=new Set(preview.movingIds);
    for(const entity of preview.outputs){
      if(entity.type==='text'){if(!$('show-text').checked)continue;const p=screen(entity.points[0]),text=node('text',{x:0,y:0,fill:'#da8a41','font-size':entity.height*scale,transform:`translate(${p.x} ${p.y}) rotate(${-(entity.rotation||0)}) scale(1 ${entity.mirrorY?-1:1})`,'dominant-baseline':entity.verticalAlign==='middle'?'central':'auto',textLength:entity.width*scale,lengthAdjust:'spacingAndGlyphs','data-spread-preview':entity.id},overlay);text.textContent=entity.text;}
      else node('path',{d:nativePath(entity),fill:'none',stroke:moving.has(entity.id)?'#d4893f':'#2c99a7','stroke-width':2.5,'data-spread-preview':entity.id},overlay);
    }
    for(const points of preview.connectors)node('path',{d:pathData(points),fill:'none',stroke:'#bf6b37','stroke-width':3,'stroke-dasharray':'5 3','data-spread-bridge':'true'},overlay);
    node('path',{d:pathData(preview.movedCut),fill:'none',stroke:'#d4893f','stroke-width':1.5,'stroke-dasharray':'4 4'},overlay);
  }
  $('spread-capture').onclick=guard(capture);$('spread-return').onclick=()=>{picking=null;setTool('select');refresh();};
  $('spread-basis').onchange=guard(()=>{basis=choices[Number($('spread-basis').value)];boundaryKey='';invalidate();refresh();render();});
  for(const slot of ['a','b'])$('spread-pick-'+slot).onclick=()=>{picking=picking===slot?null:slot;setTool('spread');refresh();render();};
  $('spread-cancel-pick').onclick=()=>{picking=null;refresh();render();};
  for(const id of ['spread-a','spread-b','spread-side','spread-mode','spread-angle','spread-width','spread-gap','spread-on-cut','spread-keep'])$(id).addEventListener('input',()=>{invalidate();refresh();render();});
  $('spread-preview').onclick=guard(()=>{preview=null;picking=null;preview=prepareSpread(getProject(),config(),()=>crypto.randomUUID());setTool('spread');refresh();render();});
  $('spread-fit').onclick=guard(()=>{if(preview){const ids=new Set(preview.sourceIds);fit([...getProject().entities.filter(e=>ids.has(e.id)),...preview.outputs]);}});
  $('spread-apply').onclick=guard(()=>{const result=applySpread(getProject(),preview);reset();commit(result.project,result.outputIds);notify('展开片已生成，可撤销。请核对轮廓后添加工艺关联并保存工程。');});
  return {refresh,reset,pick,draw,begin(){setTool('spread');if(getSelection().size)try{capture();}catch(error){message=error.message;}refresh();$('spread-panel').scrollIntoView({block:'start'});}};
}
