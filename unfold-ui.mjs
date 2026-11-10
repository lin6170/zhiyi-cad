import { unfoldCandidates, pickUnfoldEdge, prepareUnfold, applyUnfold } from './unfold.mjs';
import { spreadBoundary, spreadStamp } from './spread.mjs';
import { seamBases } from './seams.mjs';
import { bezierSpans } from './curves.mjs';
export function createUnfoldPanel({getProject,getSelection,getTool,setTool,commit,render,fit,notify}){
  const $=id=>document.getElementById(id),format=n=>Number(n.toFixed(6)).toString();
  let choices=[],basis=null,boundary=null,candidates=[],cacheKey='',preview=null,picking=false,message='选择闭合半片，再记录轮廓并确认直线折边。';
  const invalidate=(text='参数已变化，请重新预览。')=>{preview=null;message=text;};
  const guard=fn=>()=>{try{fn();}catch(error){invalidate(error.message);notify(error.message);refresh();render();}};
  function reset(){choices=[];basis=null;boundary=null;candidates=[];cacheKey='';preview=null;picking=false;invalidate('选择闭合半片，再记录轮廓并确认直线折边。');$('unfold-basis').replaceChildren();$('unfold-edge').replaceChildren();}
  const gap=()=>Number($('unfold-gap').value.trim()||NaN);
  function getBoundary(){
    const key=JSON.stringify([basis,gap(),spreadStamp(getProject())]);if(key===cacheKey)return boundary;
    boundary=null;candidates=[];cacheKey='';const b=spreadBoundary(getProject(),basis,gap()),list=unfoldCandidates(b),previous=$('unfold-edge').value;
    boundary=b;candidates=list;cacheKey=key;$('unfold-edge').replaceChildren();
    list.forEach((edge,i)=>{const option=document.createElement('option');option.value=edge.id;option.textContent=(i+1)+' · 长 '+format(edge.length)+' mm · '+edge.indices.length+' 段';$('unfold-edge').append(option);});if(list.some(c=>c.id===previous))$('unfold-edge').value=previous;
    return boundary;
  }
  const chosen=()=>candidates.find(c=>c.id===$('unfold-edge').value);
  function config(){return {basis,edgeId:$('unfold-edge').value,gapTolerance:gap(),keepOriginals:$('unfold-keep').checked,centerline:$('unfold-centerline').checked,mirrorText:$('unfold-text').checked};}
  function capture(){
    choices=seamBases(getProject(),getSelection());if(!choices.length)throw new Error('请选择完整裁片组合或单条闭合线');
    $('unfold-basis').replaceChildren();choices.forEach((choice,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=choice.name;$('unfold-basis').append(option);});basis=choices[0];cacheKey='';picking=false;getBoundary();invalidate(candidates.length?'候选为几何直边，请确认实际对折边。':'未找到直线折边；请核对所选半片轮廓。');refresh();render();
  }
  function refresh(){
    if(preview&&preview.signature!==spreadStamp(getProject()))invalidate('工程已变化，请重新预览。');
    let error=null;try{if(basis)getBoundary();}catch(e){error=e.message;}
    const edge=chosen();$('unfold-info').textContent=error||(!edge?'尚未记录可用折边。':'折边长 '+format(edge.length)+' mm；展开后从外轮廓移除。');
    $('unfold-pick').classList.toggle('active',picking);$('unfold-pick').setAttribute('aria-pressed',String(picking));$('unfold-pick').textContent=picking?'取消拾取折边':'在画布拾取折边';
    $('unfold-apply').disabled=!preview;$('unfold-fit').disabled=!preview;$('unfold-apply').textContent=$('unfold-keep').checked?'保留半片并生成完整片':'替换半片并应用';
    const status=$('unfold-status');status.replaceChildren();const row=(text,warn=false)=>{const p=document.createElement('p');p.textContent=text;if(warn)p.className='unfold-warning';status.append(p);};
    if(!preview){row(error||message);return;}
    row('预览就绪 · 移除 '+preview.removedPartCount+' 段折边 · 完整轮廓 '+preview.boundaryIds.length+' 段。');
    row('面积 '+format(preview.areaBefore/100)+' → '+format(preview.areaAfter/100)+' cm²；已通过两倍面积核对。');
    row('原生曲线 '+preview.outputs.filter(e=>e.curve).length+' 段；'+preview.axisOnlyCount+' 项轴上线只保留一份。');
    row(preview.config.keepOriginals?'原片与原工艺关联保留；新片为独立裁片，需重新设置缝份、刀口等。':'替换后原工艺引用将失效；旧输出保留供核对。',!preview.config.keepOriginals);
    if(preview.effects.length)row('涉及：'+preview.effects.map(e=>e.label+' '+e.count+' 项').join('；')+'。',true);
    if(preview.bridges.length)row('原轮廓 '+preview.bridges.length+' 处间隙已按容差补线，请核对。',true);
    preview.warnings.forEach(w=>row(w,true));row('原生轮廓自交与单侧检查已通过；另核对 0.001 mm 网格可用性。');
  }
  function pick(p,tolerance){try{if(!picking){notify('请先点击“在画布拾取折边”');return;}const hit=pickUnfoldEdge(getBoundary(),p);if(!hit||hit.distance>tolerance)throw new Error('请在所选半片的直线折边附近单击');$('unfold-edge').value=hit.candidate.id;picking=false;invalidate('折边已记录，请预览完整片。');refresh();render();}catch(error){notify(error.message);}}
  function draw({node,overlay,screen,pathData,scale}){
    if(getTool()!=='unfold')return;let edge;try{if(basis)getBoundary();edge=chosen();}catch{return;}
    if(edge){node('path',{d:pathData(edge.world),fill:'none',stroke:'#bd75b6','stroke-width':3,'stroke-dasharray':'7 4','data-unfold-axis':'true'},overlay);for(const p of edge.world){const q=screen(p);node('circle',{cx:q.x,cy:q.y,r:5,fill:'#fff',stroke:'#bd75b6','stroke-width':2},overlay);}}
    if(!preview)return;
    for(const e of preview.outputs){const role=e.source?.unfold?.role,color=role==='fold-line'?'#bd75b6':role?.startsWith('mirrored')?'#d2843d':'#2b9aa7';
      if(e.type==='text'){if(!$('show-text').checked)continue;const p=screen(e.points[0]),text=node('text',{x:0,y:0,fill:color,'font-size':e.height*scale,transform:`translate(${p.x} ${p.y}) rotate(${-(e.rotation||0)}) scale(1 ${e.mirrorY?-1:1})`,'dominant-baseline':e.verticalAlign==='middle'?'central':'auto',textLength:e.width*scale,lengthAdjust:'spacingAndGlyphs','data-unfold-preview':e.id},overlay);text.textContent=e.text;continue;}
      let path=pathData(e.points,e.closed);if(e.curve){path='';for(const span of bezierSpans(e.curve)){const points=span.controlPoints.map(screen);if(!path)path=`M ${points[0].x} ${points[0].y}`;path+=' '+(points.length===3?'Q ':'C ')+points.slice(1).map(p=>p.x+' '+p.y).join(' ');}if(e.closed)path+=' Z';}
      node('path',{d:path,fill:'none',stroke:color,'stroke-width':2.3,'stroke-dasharray':role==='fold-line'?'7 4':'none','data-unfold-preview':e.id},overlay);
      const tips=[];if(e.arrowEnd)tips.push([e.points.at(-1),e.points.at(-2)]);if(e.arrowStart)tips.push([e.points[0],e.points[1]]);
      for(const [tip,neighbor] of tips){const end=screen(tip),previous=screen(neighbor),angle=Math.atan2(end.y-previous.y,end.x-previous.x),a={x:end.x-7*Math.cos(angle-.35),y:end.y-7*Math.sin(angle-.35)},b={x:end.x-7*Math.cos(angle+.35),y:end.y-7*Math.sin(angle+.35)};node('path',{d:`M ${a.x} ${a.y} L ${end.x} ${end.y} L ${b.x} ${b.y}`,fill:'none',stroke:color,'stroke-width':1.5,'data-unfold-arrow':e.id},overlay);}
    }
  }
  $('unfold-capture').onclick=guard(capture);$('unfold-return').onclick=()=>{picking=false;setTool('select');refresh();};
  $('unfold-basis').onchange=guard(()=>{basis=choices[Number($('unfold-basis').value)];cacheKey='';getBoundary();invalidate();refresh();render();});
  for(const id of ['unfold-edge','unfold-gap','unfold-keep','unfold-centerline','unfold-text'])$(id).addEventListener('input',()=>{invalidate();refresh();render();});
  $('unfold-pick').onclick=()=>{picking=!picking;setTool('unfold');refresh();render();};
  $('unfold-preview').onclick=guard(()=>{preview=null;picking=false;preview=prepareUnfold(getProject(),config(),()=>crypto.randomUUID());setTool('unfold');refresh();render();});
  $('unfold-fit').onclick=guard(()=>{if(preview){const ids=new Set(preview.sourceIds);fit([...getProject().entities.filter(e=>ids.has(e.id)),...preview.outputs]);}});
  $('unfold-apply').onclick=guard(()=>{const result=applyUnfold(getProject(),preview);reset();commit(result.project,result.outputIds);notify('完整片已生成，可撤销。请核对布纹、文字与工艺设置。');});
  return {reset,refresh,pick,draw,begin(){setTool('unfold');if(getSelection().size)try{capture();}catch(error){message=error.message;}refresh();$('unfold-panel').scrollIntoView({block:'start'});}};
}
