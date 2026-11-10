import { preparePieceMerge, applyPieceMerge } from './piece-merge.mjs';
import { spreadBoundary, spreadStamp } from './spread.mjs';
import { unfoldCandidates, pickUnfoldEdge } from './unfold.mjs';
import { seamBases } from './seams.mjs';
import { bezierSpans } from './curves.mjs';
export function createPieceMergePanel({getProject,getSelection,getTool,setTool,commit,render,fit,notify}){
  const $=id=>document.getElementById(id),number=id=>$(id).value.trim()?Number($(id).value):NaN,format=n=>Number.isFinite(n)?Number(n.toFixed(6)).toString():'—',fresh=()=>({choices:[],basis:null,boundary:null,candidates:[],key:''});
  let sources={first:fresh(),second:fresh()},preview=null,picking=null,message='先记录第一片，再选取另一片并记录为第二片。';
  const invalidate=(text='设置已变化，请重新预览。')=>{preview=null;message=text;},guard=fn=>()=>{try{fn();}catch(error){invalidate(error.message);notify(error.message);refresh();render();}};
  function reset(){sources={first:fresh(),second:fresh()};picking=null;invalidate('先记录第一片，再选取另一片并记录为第二片。');for(const slot of ['first','second'])for(const field of ['basis','edge'])$('merge-'+slot+'-'+field).replaceChildren();}
  function getBoundary(slot){
    const state=sources[slot],key=JSON.stringify([state.basis,$('merge-gap').value,spreadStamp(getProject())]);if(key===state.key)return state.boundary;
    state.boundary=null;state.candidates=[];state.key='';const b=spreadBoundary(getProject(),state.basis,number('merge-gap')),list=unfoldCandidates(b),select=$('merge-'+slot+'-edge'),previous=select.value;
    state.boundary=b;state.candidates=list;state.key=key;select.replaceChildren();list.forEach((edge,i)=>{const option=document.createElement('option');option.value=edge.id;option.textContent=(i+1)+' · '+format(edge.length)+' mm · '+edge.indices.length+' 段';select.append(option);});if(list.some(c=>c.id===previous))select.value=previous;return b;
  }
  const chosen=slot=>sources[slot].candidates.find(c=>c.id===$('merge-'+slot+'-edge').value);
  function capture(slot){const state=sources[slot];state.choices=seamBases(getProject(),getSelection());if(!state.choices.length)throw new Error('请选择完整裁片组合或单条闭合线');
    const select=$('merge-'+slot+'-basis');select.replaceChildren();state.choices.forEach((basis,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=basis.name;select.append(option);});state.basis=state.choices[0];state.key='';getBoundary(slot);picking=null;invalidate((slot==='first'?'第一片':'第二片')+'已记录，请确认接合直边。');setTool('merge');refresh();render();
  }
  function config(){return {first:{basis:sources.first.basis,edgeId:$('merge-first-edge').value},second:{basis:sources.second.basis,edgeId:$('merge-second-edge').value},gapTolerance:number('merge-gap'),mirrorSecond:$('merge-mirror').checked,guide:$('merge-guide').checked,keepOriginals:$('merge-keep').checked};}
  function refresh(){
    if(preview&&preview.signature!==spreadStamp(getProject()))invalidate('工程已变化，请重新预览。');
    for(const slot of ['first','second']){let text='尚未记录';try{if(sources[slot].basis){getBoundary(slot);const e=chosen(slot);text=e?'接边长 '+format(e.length)+' mm':'未找到直线接边';}}catch(error){text=error.message;}$('merge-'+slot+'-info').textContent=text;$('merge-pick-'+slot).classList.toggle('active',picking===slot);$('merge-pick-'+slot).setAttribute('aria-pressed',String(picking===slot));}
    $('merge-pick-status').textContent=picking?'在'+(picking==='first'?'第一片':'第二片')+'原轮廓的直线接边附近单击。':'第一片保持原位，第二片按接边对齐；不缩放或拉伸。';$('merge-cancel-pick').hidden=!picking;
    $('merge-apply').disabled=!preview;$('merge-fit').disabled=!preview;$('merge-apply').textContent=$('merge-keep').checked?'保留两片并生成合片':'替换两片并应用';
    const status=$('merge-status');status.replaceChildren();const row=(text,warn=false)=>{const p=document.createElement('p');p.textContent=text;if(warn)p.className='merge-warning';status.append(p);};
    if(!preview){row(message);return;}
    row('预览就绪 · 接边长 '+format(preview.joinLength)+' mm；移除 '+preview.removedPartCount+' 段接合外边。');
    row('面积 '+preview.areas.map(a=>format(a/100)).join(' + ')+' = '+format(preview.areaAfter/100)+' cm²。');
    row('合片周长 '+format(preview.perimeterAfter)+' mm；已核对去除两条接合边后的长度。');
    row('边长差 '+preview.lengthDifference.toExponential(2)+' mm；端点舍入修正 '+preview.closureResidual.toExponential(2)+' mm。');
    row(preview.config.keepOriginals?'原两片及原工艺关联保留；合片为独立裁片，需重新设置工艺。':'替换后旧工艺引用失效，旧输出保留供核对。',!preview.config.keepOriginals);
    if(preview.effects.length)row('涉及：'+preview.effects.map(e=>e.label+' '+e.count+' 项').join('；')+'。',true);
    if(preview.bridges.length)row('原轮廓 '+preview.bridges.length+' 处间隙已按容差补线，请核对。',true);
    preview.warnings.forEach(w=>row(w,true));row('两片原生边界已通过接触检查；无法确认分离时会拒绝合片。');row('原生轮廓自交检查已通过；另核对 0.001 mm 网格可用性。');
  }
  function pick(world,tolerance){try{if(!picking){notify('请先选择要拾取的接合边');return;}const hit=pickUnfoldEdge(getBoundary(picking),world);if(!hit||hit.distance>tolerance)throw new Error('请在该片原轮廓的直边附近拾取');$('merge-'+picking+'-edge').value=hit.candidate.id;picking=null;invalidate('接合边已记录，请预览。');refresh();render();}catch(error){notify(error.message);}}
  function draw({node,overlay,screen,pathData,scale}){
    if(getTool()!=='merge')return;
    const nativePath=e=>{if(!e.curve)return pathData(e.points,e.closed);let d='';for(const span of bezierSpans(e.curve)){const p=span.controlPoints.map(screen);if(!d)d=`M ${p[0].x} ${p[0].y}`;d+=' '+(p.length===3?'Q ':'C ')+p.slice(1).map(q=>q.x+' '+q.y).join(' ');}return d+(e.closed?' Z':'');};
    if(preview)for(const e of preview.outputs){const role=e.source?.pieceMerge?.role,color=role==='join-guide'?'#ad67a6':e.source?.pieceMerge?.owner==='second'?'#d2843d':'#2b9aa7';
      if(e.type==='text'){if(!$('show-text').checked)continue;const p=screen(e.points[0]),t=node('text',{x:0,y:0,fill:color,'font-size':e.height*scale,transform:`translate(${p.x} ${p.y}) rotate(${-(e.rotation||0)}) scale(1 ${e.mirrorY?-1:1})`,'dominant-baseline':e.verticalAlign==='middle'?'central':'auto',textLength:e.width*scale,lengthAdjust:'spacingAndGlyphs','data-merge-preview':e.id},overlay);t.textContent=e.text;continue;}
      node('path',{d:nativePath(e),fill:'none',stroke:color,'stroke-width':2.5,'stroke-dasharray':role==='join-guide'?'6 4':'none','data-merge-preview':e.id},overlay);
      const tips=[];if(e.arrowEnd)tips.push([e.points.at(-1),e.points.at(-2)]);if(e.arrowStart)tips.push([e.points[0],e.points[1]]);for(const [tip,near] of tips){const p=screen(tip),q=screen(near),a=Math.atan2(p.y-q.y,p.x-q.x);node('path',{d:`M ${p.x-7*Math.cos(a-.35)} ${p.y-7*Math.sin(a-.35)} L ${p.x} ${p.y} L ${p.x-7*Math.cos(a+.35)} ${p.y-7*Math.sin(a+.35)}`,fill:'none',stroke:color,'stroke-width':1.5,'data-merge-arrow':e.id},overlay);}
    }
    for(const slot of ['first','second']){let edge;try{if(sources[slot].basis)getBoundary(slot);edge=chosen(slot);}catch{continue;}if(!edge)continue;const color=slot==='first'?'#2b9aa7':'#d2843d';node('path',{d:pathData(edge.world),stroke:color,'stroke-width':3,'stroke-dasharray':'5 4',fill:'none','data-merge-edge':slot},overlay);const p=screen(edge.world[0]),t=node('text',{x:p.x+9,y:p.y-9,fill:color,'font-size':13},overlay);t.textContent=slot==='first'?'片 1 接边':'片 2 原接边';}
  }
  for(const slot of ['first','second']){
    $('merge-capture-'+slot).onclick=guard(()=>capture(slot));$('merge-'+slot+'-basis').onchange=guard(()=>{sources[slot].basis=sources[slot].choices[Number($('merge-'+slot+'-basis').value)];sources[slot].key='';getBoundary(slot);invalidate();refresh();render();});
    $('merge-'+slot+'-edge').addEventListener('input',()=>{invalidate();refresh();render();});$('merge-pick-'+slot).onclick=()=>{picking=picking===slot?null:slot;setTool('merge');refresh();render();};
  }
  $('merge-return').onclick=()=>{picking=null;setTool('select');refresh();};$('merge-cancel-pick').onclick=()=>{picking=null;refresh();render();};
  for(const id of ['merge-gap','merge-mirror','merge-guide','merge-keep'])$(id).addEventListener('input',()=>{invalidate();refresh();render();});
  $('merge-preview').onclick=guard(()=>{preview=null;picking=null;preview=preparePieceMerge(getProject(),config(),()=>crypto.randomUUID());setTool('merge');refresh();render();});
  $('merge-fit').onclick=guard(()=>{if(preview)fit(preview.outputs);});
  $('merge-apply').onclick=guard(()=>{const result=applyPieceMerge(getProject(),preview);reset();commit(result.project,result.outputIds);notify('已生成完整合片，可撤销。请核对内部线、布纹与工艺设置。');});
  return {refresh,reset,pick,draw,begin(){setTool('merge');if(getSelection().size&&!sources.first.basis)try{capture('first');}catch(error){message=error.message;}refresh();$('merge-panel').scrollIntoView({block:'start'});}};
}
