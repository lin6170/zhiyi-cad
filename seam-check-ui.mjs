import { emptySeamCheck, checkEdgeRef, checkEdgeKey, resolveCheckEdge, appendCheckEdge, reverseCheckSide, evaluateSeamCheck, walkSeamCheck, applySeamCheck, normalizeSeamCheck } from './seam-checks.mjs';
import { createSectionEditor } from './seam-section-ui.mjs';

export function createSeamCheckPanel({getProject,commit,setTool,render,fit,notify,download}){
  const $=id=>document.getElementById(id),panel=$('match-panel');
  let draft=emptySeamCheck(),selectedId='',activeSide='a',lastProject=null,walk=null,result=null;
  const sectionEditor=createSectionEditor({getDraft:()=>draft,setDraft:value=>{draft=value;},getProject,changed:reload=>{if(reload)loadForm();refresh();render();},notify});
  const format=value=>Number.isFinite(value)?value.toFixed(3):'—',signed=value=>(value>=0?'+':'')+format(value);
  const catchAction=fn=>()=>{try{fn();}catch(error){notify(error.message);}};
  const statusLabel=check=>check.status==='error'?'失效':check.result?.status==='match'?'符合目标':check.result?.status==='mismatch'?'需核对':'临界 / 待核对';
  function loadForm(){
    $('match-name').value=draft.name;$('match-ease-mode').value=draft.easeMode;$('match-ease').value=draft.easeValue;$('match-tolerance').value=draft.tolerance;$('match-gap').value=draft.gapTolerance;
    for(const side of ['a','b']){$('match-'+side+'-start').value=draft[side].trimStart;$('match-'+side+'-end').value=draft[side].trimEnd;}
  }
  function readForm(){
    const number=id=>{const raw=$(id).value;return raw.trim()?Number(raw):NaN;};
    draft.name=$('match-name').value;draft.easeMode=$('match-ease-mode').value;draft.easeValue=number('match-ease');draft.tolerance=number('match-tolerance');draft.gapTolerance=number('match-gap');
    for(const side of ['a','b']){draft[side].trimStart=number('match-'+side+'-start');draft[side].trimEnd=number('match-'+side+'-end');}
  }
  function reset(){selectedId='';draft=emptySeamCheck();walk=null;result=null;lastProject=getProject();activeSide='a';$('match-walk').value=0;loadForm();sectionEditor.reset();}
  function refresh(){
    const project=getProject();
    if(project!==lastProject){
      const existing=project.seamChecks?.find(check=>check.id===selectedId);
      if(existing){draft=normalizeSeamCheck(existing);loadForm();sectionEditor.reset();}else reset();
      lastProject=project;
    }
    const select=$('match-saved');select.replaceChildren(new Option('新建核对',''));
    for(const check of project.seamChecks||[])select.add(new Option(check.name+' · '+statusLabel(check),check.id));select.value=selectedId;
    $('match-delete').hidden=!selectedId;$('match-save').textContent=selectedId?'更新核对关系':'保存核对关系';
    for(const side of ['a','b']){
      $('match-pick-'+side).classList.toggle('primary',activeSide===side);
      const list=$('match-'+side+'-edges');list.replaceChildren();
      draft[side].edges.forEach((ref,index)=>{
        const row=document.createElement('div');row.className='match-edge-row';
        const label=document.createElement('span');
        try{label.textContent=(index+1)+' · '+resolveCheckEdge(project,ref).entity.name+(ref.reverse?' ←':' →');}catch(error){label.textContent=(index+1)+' · '+error.message;row.classList.add('invalid');}
        label.title=label.textContent;row.append(label);
        for(const [text,title,action] of [
          ['↑','上移',()=>{if(index)[draft[side].edges[index-1],draft[side].edges[index]]=[draft[side].edges[index],draft[side].edges[index-1]];}],
          ['⇄','反向此边',()=>{ref.reverse=!ref.reverse;}],
          ['×','移除此边',()=>{draft[side].edges.splice(index,1);}]
        ]){const button=document.createElement('button');button.textContent=text;button.title=title;button.setAttribute('aria-label',side.toUpperCase()+' 第 '+(index+1)+' 边 '+title);button.onclick=()=>{action();refresh();render();};if(text==='↑')button.disabled=index===0;row.append(button);}
        list.append(row);
      });
      if(!draft[side].edges.length){const note=document.createElement('p');note.className='muted';note.textContent='点击“拾取 '+side.toUpperCase()+'”，再在画布上按顺序点选缝合边。';list.append(note);}
    }
    walk=null;result=null;
    try{
      result=evaluateSeamCheck(project,draft);
      const labels={match:'符合目标',mismatch:'偏差超出容差',uncertain:'临界值，需人工核对'};
      const sections=result.checkMode==='sections';
      $('match-result').textContent='A '+format(result.a.length)+' mm　B '+format(result.b.length)+' mm\n实际长差 B − A：'+signed(result.delta)+' mm（'+signed(result.actualEasePercent)+'%）\n'+(sections?'各段目标合计':'目标吃势')+'：'+signed(result.targetEase)+' mm\n'+(sections?'合计偏差':'目标后的偏差')+'：'+signed(result.residual)+' mm\n'+(sections?'合计：':'')+labels[sections?result.totalStatus:result.status]+' · 容差 ±'+format(result.tolerance)+' mm';
      $('match-result').dataset.status=result.status;
      if(sections)$('match-result').textContent+='\n分段核对：'+result.sections.filter(section=>section.status==='match').length+' / '+result.sections.length+' 段符合目标\n'+labels[result.status]+'（各段另按各自容差判定）';
      if(result.a.gapTotal+result.b.gapTotal>1e-9)$('match-result').textContent+='\n链内间隙 A '+format(result.a.gapTotal)+' / B '+format(result.b.gapTotal)+' mm，未计入缝长。';
      $('match-numerics').textContent='弧长数值误差估计：'+result.uncertainty.toExponential(2)+' mm。判定计入此估计；不包含源纸样和采样显示误差。';
      try{walk=walkSeamCheck(project,draft,Number($('match-walk').value)/100);$('match-walk-status').textContent='A 已行 '+format(walk.a.position)+' mm · B 已行 '+format(walk.b.position)+' mm\nB 剩余 '+format(walk.b.remaining)+' mm'+(walk.section?'\n第 '+walk.section.index+' 段 · 本段 B 剩余 '+format(walk.section.remaining)+' mm':'')+(walk.b.overrun>0?' · 超出 B '+(walk.section?'本段':'')+'终点 '+format(walk.b.overrun)+' mm':'');}
      catch(error){$('match-walk-status').textContent='步进定位失败：'+error.message;}
    }catch(error){$('match-result').textContent=error.message;$('match-result').dataset.status='error';$('match-numerics').textContent='';$('match-walk-status').textContent='选择有效的两侧后可沿线步进。';}
    sectionEditor.refresh(result);
    $('match-save').disabled=!result;$('match-export').disabled=!result;$('match-walk').disabled=!result;
    $('match-fit').disabled=!draft.a.edges.length&&!draft.b.edges.length;
    $('match-pick-status').textContent='当前拾取 '+activeSide.toUpperCase()+' · 单击追加原始边；重复边会提示。两侧应选实际缝合线。';
  }
  function begin(side){activeSide=side;setTool('match');refresh();render();panel.scrollIntoView({block:'center'});}
  function pick(entity,index){
    try{
      readForm();const ref=checkEdgeRef(entity,index),other=activeSide==='a'?'b':'a';
      if(draft[other].edges.some(edge=>checkEdgeKey(edge)===checkEdgeKey(ref)))throw new Error('此边已用于另一侧，请选对应的另一条缝合边');
      if(draft[activeSide].edges.length>=100)throw new Error('每侧最多选择 100 条边');
      draft[activeSide]=appendCheckEdge(getProject(),draft[activeSide],ref);refresh();render();
    }catch(error){notify(error.message);}
  }
  function draw({node,overlay,screen,pathData}){
    if(!$('match-show').checked)return;
    for(const side of ['a','b']){
      const color=side==='a'?'#58c4d6':'#dc8bb9',labelPrefix=side.toUpperCase();
      for(const [index,ref] of draft[side].edges.entries())try{
        const entity=resolveCheckEdge(getProject(),ref).entity,points=entity.closed?[...entity.points,entity.points[0]]:entity.points,ordered=ref.reverse?points.slice().reverse():points;
        node('path',{d:pathData(ordered),fill:'none',stroke:color,'stroke-width':3,'stroke-opacity':.7,'data-match-side':side},overlay);
        const s=screen(ordered[0]),label=node('text',{x:s.x+7,y:s.y-8,fill:color,'font-size':12},overlay);label.textContent=labelPrefix+(index+1)+' 起';
        const next=ordered.find(p=>Math.hypot(p.x-ordered[0].x,p.y-ordered[0].y)>1e-9);
        if(next){const q=screen(next),angle=Math.atan2(q.y-s.y,q.x-s.x),end={x:s.x+20*Math.cos(angle),y:s.y+20*Math.sin(angle)};node('path',{d:'M '+s.x+' '+s.y+' L '+end.x+' '+end.y+' L '+(end.x-7*Math.cos(angle-.4))+' '+(end.y-7*Math.sin(angle-.4))+' M '+end.x+' '+end.y+' L '+(end.x-7*Math.cos(angle+.4))+' '+(end.y-7*Math.sin(angle+.4)),stroke:color,fill:'none','stroke-width':2},overlay);}
      }catch{}
      if(walk){
        for(const key of ['start','end','point']){const p=screen(walk[side][key]);node('circle',{cx:p.x,cy:p.y,r:key==='point'?6:3.5,fill:key==='point'?color:'none',stroke:color,'stroke-width':2,'data-match-marker':side+'-'+key},overlay);}
      }
      for(const [index,mark] of (result?.landmarks||[]).entries()){
        const p=screen(mark[side+'Point']);node('rect',{x:p.x-4,y:p.y-4,width:8,height:8,fill:'#fff',stroke:color,'stroke-width':2,'data-match-landmark':side+'-'+mark.id},overlay);
        const text=node('text',{x:p.x+9,y:p.y+16,fill:color,'font-size':12},overlay);text.textContent=labelPrefix+' · '+(index+1)+' '+mark.name;
      }
    }
  }
  $('match-pick-a').onclick=()=>begin('a');$('match-pick-b').onclick=()=>begin('b');
  for(const side of ['a','b']){
    $('match-reverse-'+side).onclick=()=>{readForm();draft[side]=reverseCheckSide(draft[side]);loadForm();refresh();render();};
    $('match-clear-'+side).onclick=()=>{draft[side]={edges:[],trimStart:0,trimEnd:0};loadForm();refresh();render();};
  }
  for(const id of ['match-name','match-ease-mode','match-ease','match-tolerance','match-gap','match-a-start','match-a-end','match-b-start','match-b-end'])$(id).oninput=()=>{readForm();refresh();render();};
  $('match-walk').oninput=()=>{refresh();render();};$('match-show').onchange=render;
  $('match-new').onclick=()=>{reset();refresh();render();};
  $('match-saved').onchange=()=>{selectedId=$('match-saved').value;draft=selectedId?normalizeSeamCheck(getProject().seamChecks.find(check=>check.id===selectedId)):emptySeamCheck();$('match-walk').value=0;loadForm();sectionEditor.reset();refresh();render();};
  $('match-save').onclick=catchAction(()=>{
    readForm();const next=structuredClone(getProject()),check=applySeamCheck(next,draft,()=>crypto.randomUUID(),selectedId||null);selectedId=check.id;commit(next);notify('核对关系已记入工程；请保存工程文件。');
  });
  $('match-delete').onclick=()=>{const next=structuredClone(getProject());next.seamChecks=next.seamChecks.filter(check=>check.id!==selectedId);reset();commit(next);};
  $('match-fit').onclick=()=>{const entities=[];for(const ref of [...draft.a.edges,...draft.b.edges])try{entities.push(resolveCheckEdge(getProject(),ref).entity);}catch{}if(entities.length)fit(entities);};
  $('match-export').onclick=catchAction(()=>{readForm();const report=evaluateSeamCheck(getProject(),draft);download(JSON.stringify({format:'zhiyi-seam-check-report',version:draft.checkMode==='sections'?2:1,project:getProject().name,definition:normalizeSeamCheck(draft),result:report},null,2),getProject().name+'-缝合核对.json','application/json');});
  reset();return {refresh,reset,pick,draw,begin:()=>begin(activeSide)};
}
