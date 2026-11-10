import { dartCandidates, prepareDartTransfer, applyDartTransfer } from './dart-transfer.mjs';
import { spreadBoundary, pickSpreadStation, spreadStamp } from './spread.mjs';
import { seamBases } from './seams.mjs';
import { stationOnPath } from './path-metrics.mjs';
import { bezierSpans } from './curves.mjs';
export function createDartPanel({getProject,getSelection,getTool,setTool,commit,render,fit,notify}){
  const $=id=>document.getElementById(id),number=id=>$(id).value.trim()?Number($(id).value):NaN,format=n=>Number.isFinite(n)?Number(n.toFixed(6)).toString():'—';
  let choices=[],basis=null,boundary=null,candidates=[],cacheKey='',preview=null,picking=null,message='选择含直线省口的裁片，再记录轮廓。';
  const guard=fn=>()=>{try{fn();}catch(error){invalidate(error.message);notify(error.message);refresh();render();}};
  function invalidate(text='参数已变化，请重新预览。'){preview=null;message=text;}
  function reset(){choices=[];basis=null;boundary=null;candidates=[];cacheKey='';picking=null;invalidate('选择含直线省口的裁片，再记录轮廓。');$('dart-basis').replaceChildren();$('dart-source').replaceChildren();}
  function getBoundary(){
    const key=JSON.stringify([basis,$('dart-gap').value,spreadStamp(getProject())]);
    if(key!==cacheKey){boundary=null;cacheKey='';const next=spreadBoundary(getProject(),basis,number('dart-gap')),list=dartCandidates(next),previous=$('dart-source').value;boundary=next;candidates=list;cacheKey=key;
      $('dart-source').replaceChildren();list.forEach((candidate,i)=>{const option=document.createElement('option');option.value=candidate.id;option.textContent=(i+1)+' · '+format(candidate.angle)+'° · 边差 '+format(candidate.lengthDifference)+' mm';$('dart-source').append(option);});if(list.some(d=>d.id===previous))$('dart-source').value=previous;
    }return boundary;
  }
  const chosen=()=>candidates.find(d=>d.id===$('dart-source').value);
  function config(){return {basis,dartId:$('dart-source').value,target:number('dart-target'),transferPercent:number('dart-percent'),newTipRetreat:number('dart-new-retreat'),remainingTipRetreat:number('dart-percent')<100?number('dart-old-retreat'):0,side:$('dart-side').value,onCut:$('dart-on-cut').value,gapTolerance:number('dart-gap'),keepOriginals:$('dart-keep').checked,centerline:$('dart-centerline').checked};}
  function chooseDefaultTarget(){const b=getBoundary(),d=chosen();if(d)$('dart-target').value=String(((d.apexStation/b.total*100)+50)%100);}
  function capture(){
    choices=seamBases(getProject(),getSelection());if(!choices.length)throw new Error('请选择完整裁片组合或单条闭合线');
    $('dart-basis').replaceChildren();choices.forEach((choice,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=choice.name;$('dart-basis').append(option);});basis=choices[0];cacheKey='';picking=null;chooseDefaultTarget();invalidate(candidates.length?'候选仅依据几何凹角，请核对所选省口。':'未找到直线省口候选。需要两条共尖直省边形成的凹角。');refresh();render();
  }
  function refresh(){
    $('dart-old-retreat').disabled=!(number('dart-percent')>0&&number('dart-percent')<100);
    if(preview&&preview.signature!==spreadStamp(getProject()))invalidate('工程已变化，请重新预览。');
    try{if(basis)getBoundary();}catch(error){$('dart-info').textContent=error.message;}
    const d=chosen();if(boundary)$('dart-info').textContent=d?'旧省边 '+format(d.firstLength)+' / '+format(d.secondLength)+' mm；转角 '+format(d.angle)+'°。':'无可选省口；请核对轮廓是否含两条共尖直线。';
    $('dart-apply').disabled=!preview;$('dart-fit').disabled=!preview;$('dart-apply').textContent=$('dart-keep').checked?'保留原片并生成转省片':'替换原片并应用';
    for(const key of ['apex','target']){$('dart-pick-'+key).classList.toggle('active',picking===key);$('dart-pick-'+key).setAttribute('aria-pressed',String(picking===key));}
    $('dart-pick-status').textContent=picking==='apex'?'在候选省尖附近单击以确认所选凹角。':picking==='target'?'在所选外轮廓附近单击新省口位置。':'旧省尖 P 为旋转中心，新切线从 P 连到目标位置。';$('dart-cancel-pick').hidden=!picking;
    const status=$('dart-status');status.replaceChildren();const row=(text,warn=false)=>{const p=document.createElement('p');p.textContent=text;if(warn)p.className='dart-warning';status.append(p);};
    if(!preview){row(message);return;}
    row('预览就绪 · 转移 '+format(preview.transferPercent)+'% · 旋转 '+format(preview.angle)+'°'+(preview.partial?'':' · 原省口闭合残差 '+preview.closureResidual.toExponential(2)+' mm'));
    if(preview.partial)row('绕原省尖分配：新省 '+format(Math.abs(preview.angle))+'°，剩余原省 '+format(preview.remainingAngle)+'°。原口宽 '+format(preview.oldWidth)+' → '+format(preview.remainingWidth)+' mm。');
    else row('原口宽 '+format(preview.oldWidth)+' → 新口宽 '+format(preview.newWidth)+' mm。省口宽度随新省长变化。');
    for(const shape of [preview.newDartShape,preview.remainingDartShape].filter(Boolean))row((shape.role==='new'?'新省':'剩余原省')+'：口宽 '+format(shape.width)+' mm；两边 '+shape.legLengths.map(format).join(' / ')+' mm；深度 '+format(shape.depth)+' mm；实际省角 '+format(shape.angle)+'°。');
    if(preview.areaAdded>0)row('退尖增加面积 '+format(preview.areaAdded/100)+' cm²；实际省角已改变，请按版型核对。',true);
    row('面积 '+format(preview.areaBefore/100)+' → '+format(preview.areaAfter/100)+' cm²；差 '+format((preview.areaAfter-preview.areaBefore)/100)+' cm²。');
    row(preview.splitCount+' 处内部线切分 · 原生曲线 '+preview.outputs.filter(e=>e.curve).length+' 段。');
    row(preview.config.keepOriginals?'原片与原工艺关联保留；新片为独立裁片，需重建工艺关联。':'替换原始图元后，原工艺引用将失效；旧输出保留供核对。',!preview.config.keepOriginals);
    if(preview.effects.length)row('涉及：'+preview.effects.map(e=>e.label+' '+e.count+' 项').join('；')+'。',true);
    if(preview.bridges.length)row('原轮廓 '+preview.bridges.length+' 处间隙已按容差补直线，请核对。',true);
    preview.warnings.forEach(w=>row(w,true));row('原生轮廓自交检查已通过；另核对 0.001 mm 网格可用性。');
  }
  function pick(p,tolerance){try{
    if(!picking){notify('请在转省面板选择“拾取省尖”或“拾取新位置”');return;}const b=getBoundary();
    if(picking==='apex'){let best=null;for(const d of candidates){const distance=Math.hypot(d.world.pivot.x-p.x,d.world.pivot.y-p.y);if(!best||distance<best.distance)best={d,distance};}if(!best||best.distance>tolerance)throw new Error('请在候选省尖附近拾取');$('dart-source').value=best.d.id;}
    else{const result=pickSpreadStation(b,p);if(result.distance>tolerance)throw new Error('请在所选轮廓附近拾取新省口');$('dart-target').value=String(result.percent===100?0:result.percent);}
    picking=null;invalidate('位置已记录，请预览转省结果。');refresh();render();
  }catch(error){notify(error.message);}}
  function draw({node,overlay,screen,pathData,scale}){
    if(getTool()!=='dart')return;let d;try{if(basis)getBoundary();d=chosen();}catch{return;}
    if(d){const {pivot,mouth1,mouth2}=d.world;node('path',{d:pathData([mouth1,pivot,mouth2]),fill:'none',stroke:'#c46b65','stroke-width':3,'stroke-dasharray':'5 3','data-dart-old':'true'},overlay);
      const p=screen(pivot);node('circle',{cx:p.x,cy:p.y,r:6,fill:'#fff',stroke:'#c46b65','stroke-width':2,'data-dart-pivot':'true'},overlay);const label=node('text',{x:p.x+9,y:p.y-10,fill:'#c46b65','font-size':13},overlay);label.textContent='P 省尖';
      try{const t=stationOnPath(boundary,number('dart-target')/100*boundary.total,{pointOnly:true}).point;node('path',{d:pathData([pivot,t]),fill:'none',stroke:'#42a6b7','stroke-width':1.5,'stroke-dasharray':'4 4'},overlay);const q=screen(t);node('circle',{cx:q.x,cy:q.y,r:5,fill:'#fff',stroke:'#42a6b7','stroke-width':2,'data-dart-target':'true'},overlay);}catch{}
    }
    if(!preview)return;const moving=new Set(preview.movingIds),legs=new Set(preview.newLegIds),remaining=new Set(preview.remainingLegIds);
    for(const e of preview.outputs){const color=legs.has(e.id)?'#dca146':remaining.has(e.id)?'#bb90d1':moving.has(e.id)?'#d2843d':'#2b9aa7';
      if(e.type==='text'){if(!$('show-text').checked)continue;const p=screen(e.points[0]),text=node('text',{x:0,y:0,fill:color,'font-size':e.height*scale,transform:`translate(${p.x} ${p.y}) rotate(${-(e.rotation||0)}) scale(1 ${e.mirrorY?-1:1})`,'dominant-baseline':e.verticalAlign==='middle'?'central':'auto',textLength:e.width*scale,lengthAdjust:'spacingAndGlyphs','data-dart-preview':e.id},overlay);text.textContent=e.text;continue;}
      let path=pathData(e.points,e.closed);if(e.curve){path='';for(const span of bezierSpans(e.curve)){const points=span.controlPoints.map(screen);if(!path)path=`M ${points[0].x} ${points[0].y}`;path+=' '+(points.length===3?'Q ':'C ')+points.slice(1).map(p=>p.x+' '+p.y).join(' ');}}
      node('path',{d:path,fill:'none',stroke:color,'stroke-width':legs.has(e.id)||remaining.has(e.id)?3:2.3,'stroke-dasharray':e.source?.dartTransfer?.role?.includes('centerline')?'5 3':'none','data-dart-preview':e.id,...(legs.has(e.id)?{'data-dart-leg':'true'}:{}),...(remaining.has(e.id)?{'data-dart-remaining':'true'}:{})},overlay);
    }
    if(preview.closedPoint){const p=screen(preview.closedPoint);node('circle',{cx:p.x,cy:p.y,r:5,fill:'#fff',stroke:'#658871','stroke-width':2},overlay);const text=node('text',{x:p.x+8,y:p.y+16,fill:'#76a98c','font-size':12},overlay);text.textContent='原省口已闭合';}
    for(const shape of [preview.newDartShape,preview.remainingDartShape].filter(Boolean)){if(!shape.retreat)continue;const p=screen(shape.tip),color=shape.role==='new'?'#dca146':'#bb90d1';node('circle',{cx:p.x,cy:p.y,r:4,fill:'#fff',stroke:color,'stroke-width':2,'data-dart-tip':shape.role},overlay);const text=node('text',{x:p.x+8,y:p.y+(shape.role==='new'?-10:18),fill:color,'font-size':12},overlay);text.textContent=(shape.role==='new'?'新省尖':'剩余原省尖')+' · 退 '+format(shape.retreat)+' mm';}
  }
  $('dart-capture').onclick=guard(capture);$('dart-return').onclick=()=>{picking=null;setTool('select');refresh();};
  $('dart-basis').onchange=guard(()=>{basis=choices[Number($('dart-basis').value)];cacheKey='';chooseDefaultTarget();invalidate();refresh();render();});
  $('dart-source').onchange=()=>{invalidate();refresh();render();};
  for(const key of ['apex','target'])$('dart-pick-'+key).onclick=()=>{picking=picking===key?null:key;setTool('dart');refresh();render();};
  $('dart-cancel-pick').onclick=()=>{picking=null;refresh();render();};
  for(const id of ['dart-target','dart-percent','dart-new-retreat','dart-old-retreat','dart-side','dart-gap','dart-on-cut','dart-keep','dart-centerline'])$(id).addEventListener('input',()=>{invalidate();refresh();render();});
  $('dart-retreat-ten').onclick=()=>{$('dart-new-retreat').value='10';$('dart-old-retreat').value=number('dart-percent')<100?'10':'0';invalidate('退量已设为 10 mm，请核对后预览。');refresh();render();};
  $('dart-preview').onclick=guard(()=>{preview=null;picking=null;preview=prepareDartTransfer(getProject(),config(),()=>crypto.randomUUID());setTool('dart');refresh();render();});
  $('dart-fit').onclick=guard(()=>{if(preview){const ids=new Set(preview.sourceIds);fit([...getProject().entities.filter(e=>ids.has(e.id)),...preview.outputs]);}});
  $('dart-apply').onclick=guard(()=>{const result=applyDartTransfer(getProject(),preview);reset();commit(result.project,result.outputIds);notify('转省片已生成，可撤销。请核对新省口与工艺关联后保存。');});
  return {refresh,reset,pick,draw,begin(){setTool('dart');if(getSelection().size)try{capture();}catch(error){message=error.message;}refresh();$('dart-panel').scrollIntoView({block:'start'});}};
}
