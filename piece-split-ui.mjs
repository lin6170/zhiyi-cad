import { preparePieceSplit, applyPieceSplit } from './piece-split.mjs';
import { spreadBoundary, pickSpreadStation, spreadStamp } from './spread.mjs';
import { seamBases } from './seams.mjs';
import { stationOnPath } from './path-metrics.mjs';
import { bezierSpans } from './curves.mjs';
export function createPieceSplitPanel({getProject,getSelection,getTool,setTool,commit,render,fit,notify}){
  const $=id=>document.getElementById(id),number=id=>$(id).value.trim()?Number($(id).value):NaN,format=n=>Number.isFinite(n)?Number(n.toFixed(6)).toString():'—';
  let choices=[],basis=null,boundary=null,boundaryKey='',preview=null,picking=null,message='选择裁片组合或单条闭合线，再记录轮廓。';
  const invalidate=(text='参数已变化，请重新预览。')=>{preview=null;message=text;},guard=fn=>()=>{try{fn();}catch(error){invalidate(error.message);notify(error.message);refresh();render();}};
  function reset(){choices=[];basis=null;boundary=null;boundaryKey='';picking=null;invalidate('选择裁片组合或单条闭合线，再记录轮廓。');$('split-basis').replaceChildren();}
  function config(){return {basis,a:number('split-a'),b:number('split-b'),gapTolerance:number('split-gap'),onCut:$('split-on-cut').value,outside:$('split-outside').value,keepOriginals:$('split-keep').checked};}
  function getBoundary(){const key=JSON.stringify([basis,$('split-gap').value,spreadStamp(getProject())]);if(key!==boundaryKey){boundary=null;boundaryKey='';boundary=spreadBoundary(getProject(),basis,number('split-gap'));boundaryKey=key;}return boundary;}
  function capture(){
    choices=seamBases(getProject(),getSelection());if(!choices.length)throw new Error('请选择完整裁片组合或单条闭合线');
    $('split-basis').replaceChildren();choices.forEach((choice,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=choice.name;$('split-basis').append(option);});basis=choices[0];boundaryKey='';picking=null;getBoundary();invalidate('轮廓已记录，请确认切点 A、B。分片 1 沿原轮廓 A → B，分片 2 沿 B → A。');refresh();render();
  }
  function refresh(){
    if(preview&&preview.signature!==spreadStamp(getProject()))invalidate('工程已变化，请重新预览。');
    $('split-apply').disabled=!preview;$('split-fit').disabled=!preview;$('split-apply').textContent=$('split-keep').checked?'保留原片并生成两片':'替换原片并生成两片';
    for(const slot of ['a','b']){$('split-pick-'+slot).classList.toggle('active',picking===slot);$('split-pick-'+slot).setAttribute('aria-pressed',String(picking===slot));}
    $('split-pick-status').textContent=picking?'在所选轮廓附近单击切点 '+picking.toUpperCase()+'。':'切线必须位于裁片内部，不能再次穿过或接触其他边界。';$('split-cancel-pick').hidden=!picking;
    try{const b=basis?getBoundary():null;$('split-source').textContent=b?basis.entityIds.length+' 条边 · 周长 '+format(b.total)+' mm':'尚未记录轮廓';}catch(error){$('split-source').textContent=error.message;}
    const status=$('split-status');status.replaceChildren();const row=(text,warn=false,className='')=>{const p=document.createElement('p');p.textContent=text;p.className=className||(warn?'split-warning':'');status.append(p);};
    if(!preview){row(message);return;}
    row('预览就绪 · 新分割边长 '+format(preview.cutLength)+' mm。');
    preview.pieces.forEach((piece,i)=>row('分片 '+piece.part+'：面积 '+format(piece.area/100)+' cm²；周长 '+format(preview.perimeters[i])+' mm。',false,'split-part-'+piece.part));
    row('两片面积之和 '+format((preview.areas[0]+preview.areas[1])/100)+' cm²，与原片一致。');
    row(preview.splitCount+' 处内部线切分；'+preview.outputs.filter(e=>e.curve).length+' 条原生曲线。');
    row('两片保留原坐标。应用后可在“裁片与组合”中分别选取、移动或添加缝份。');
    row(preview.config.keepOriginals?'原片与原工艺关联保留；两片独立建立新的工艺关联。':'替换后旧工艺引用失效，旧输出保留供核对。',!preview.config.keepOriginals);
    if(preview.effects.length)row('涉及：'+preview.effects.map(e=>e.label+' '+e.count+' 项').join('；')+'。',true);
    if(preview.bridges.length)row('原轮廓 '+preview.bridges.length+' 处间隙已按容差补直线，请核对。',true);
    preview.warnings.forEach(w=>row(w,true));row('原生轮廓自交检查已通过，分片归属按原生曲线判断；另核对 0.001 mm 网格可用性。');
  }
  function pick(world,tolerance){try{if(!picking){notify('请先选择“拾取 A”或“拾取 B”');return;}const station=pickSpreadStation(getBoundary(),world);if(station.distance>tolerance)throw new Error('请在所选轮廓附近拾取');$('split-'+picking).value=String(station.percent===100?0:station.percent);picking=null;invalidate('切点已记录，请预览两片轮廓。');refresh();render();}catch(error){notify(error.message);}}
  function draw({node,overlay,screen,pathData,scale}){
    if(getTool()!=='split')return;
    const nativePath=e=>{if(!e.curve)return pathData(e.points,e.closed);let d='';for(const span of bezierSpans(e.curve)){const p=span.controlPoints.map(screen);if(!d)d=`M ${p[0].x} ${p[0].y}`;d+=' '+(p.length===3?'Q ':'C ')+p.slice(1).map(q=>q.x+' '+q.y).join(' ');}return d+(e.closed?' Z':'');};
    if(preview)for(const piece of preview.pieces)for(const e of piece.outputs){const color=piece.part===1?'#d2843d':'#2b9aa7';
      if(e.type==='text'){if(!$('show-text').checked)continue;const p=screen(e.points[0]),t=node('text',{x:0,y:0,fill:color,'font-size':e.height*scale,transform:`translate(${p.x} ${p.y}) rotate(${-(e.rotation||0)}) scale(1 ${e.mirrorY?-1:1})`,'dominant-baseline':e.verticalAlign==='middle'?'central':'auto',textLength:e.width*scale,lengthAdjust:'spacingAndGlyphs','data-split-preview':e.id,'data-split-part':piece.part},overlay);t.textContent=e.text;continue;}
      node('path',{d:nativePath(e),fill:'none',stroke:color,'stroke-width':2.5,'data-split-preview':e.id,'data-split-part':piece.part},overlay);
      const tips=[];if(e.arrowEnd)tips.push([e.points.at(-1),e.points.at(-2)]);if(e.arrowStart)tips.push([e.points[0],e.points[1]]);
      for(const [tip,near] of tips){const p=screen(tip),q=screen(near),angle=Math.atan2(p.y-q.y,p.x-q.x);node('path',{d:`M ${p.x-7*Math.cos(angle-.35)} ${p.y-7*Math.sin(angle-.35)} L ${p.x} ${p.y} L ${p.x-7*Math.cos(angle+.35)} ${p.y-7*Math.sin(angle+.35)}`,fill:'none',stroke:color,'stroke-width':1.5,'data-split-arrow':e.id},overlay);}
    }
    let cut=preview?.cut;if(!cut&&basis)try{const b=getBoundary();cut=[number('split-a'),number('split-b')].map(s=>stationOnPath(b,s/100*b.total,{pointOnly:true}).point);}catch{}
    if(cut){node('path',{d:pathData(cut),stroke:'#ad67a6','stroke-width':2,'stroke-dasharray':'6 4',fill:'none','data-split-cut':'true'},overlay);cut.forEach((p,i)=>{const q=screen(p);node('circle',{cx:q.x,cy:q.y,r:5,fill:'#fff',stroke:'#ad67a6','stroke-width':2,'data-split-point':i?'b':'a'},overlay);const t=node('text',{x:q.x+9,y:q.y-9,fill:'#ad67a6','font-size':14},overlay);t.textContent=i?'B':'A';});}
  }
  $('split-capture').onclick=guard(capture);$('split-return').onclick=()=>{picking=null;setTool('select');refresh();};
  $('split-basis').onchange=guard(()=>{basis=choices[Number($('split-basis').value)];boundaryKey='';invalidate();refresh();render();});
  for(const slot of ['a','b'])$('split-pick-'+slot).onclick=()=>{picking=picking===slot?null:slot;setTool('split');refresh();render();};
  $('split-cancel-pick').onclick=()=>{picking=null;refresh();render();};
  for(const id of ['split-a','split-b','split-gap','split-on-cut','split-outside','split-keep'])$(id).addEventListener('input',()=>{invalidate();refresh();render();});
  $('split-preview').onclick=guard(()=>{preview=null;picking=null;preview=preparePieceSplit(getProject(),config(),()=>crypto.randomUUID());setTool('split');refresh();render();});
  $('split-fit').onclick=guard(()=>{if(preview)fit(preview.outputs);});
  $('split-apply').onclick=guard(()=>{const result=applyPieceSplit(getProject(),preview);reset();commit(result.project,result.outputIds);notify('已生成两片独立裁片，可分别选择、移动和设置工艺。');});
  return {refresh,reset,pick,draw,begin(){setTool('split');if(getSelection().size)try{capture();}catch(error){message=error.message;}refresh();$('split-panel').scrollIntoView({block:'start'});}};
}
