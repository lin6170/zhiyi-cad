import {resolveConstructionPoint,constructionStep,finishConstructionPolyline} from './construction.mjs';
const supported=new Set(['line','polyline','curve','rectangle','grain','measure']);
export function createConstructionInput({getState,commit,finish,back,cancel,locate,render}){
  const $=id=>document.getElementById(id),panel=$('construction-panel');let previous=null,candidate=null;
  const clear=()=>{$('construction-first').value='';$('construction-second').value='';candidate=null;};
  const pending=()=>Boolean($('construction-first').value.trim()||$('construction-second').value.trim());
  const fmt=n=>Number(n.toPrecision(12)).toString();
  function sync(){
    const state=getState(),active=supported.has(state.tool),anchor=state.draft.at(-1),unit=state.units==='mm'?'mm':'原始单位';
    if(!previous||previous.tool!==state.tool||previous.draft!==state.draft||previous.units!==state.units||previous.project!==state.project)clear();previous=state;
    panel.hidden=!active;if(!active){candidate=null;return;}
    for(const option of $('construction-mode').options)option.disabled=option.value!=='absolute'&&!anchor;
    if(!anchor)$('construction-mode').value='absolute';
    const mode=$('construction-mode').value,role=!anchor?'起点':state.tool==='curve'?(state.draft.length===1?'控制点':'终点'):state.tool==='rectangle'?'对角点':state.tool==='polyline'?'下一节点':'终点';
    $('construction-title').textContent='数值绘图 · '+role;$('construction-unit').textContent=unit;
    $('construction-anchor').textContent=anchor?'上一点：X '+fmt(anchor.x)+' · Y '+fmt(anchor.y)+' '+unit:'输入起点坐标，或在画布拾取起点。';
    $('construction-first-label').textContent=mode==='polar'?'长度 '+unit:mode==='relative'?'ΔX '+unit:'X '+unit;
    $('construction-second-label').textContent=mode==='polar'?'角度 °':mode==='relative'?'ΔY '+unit:'Y '+unit;
    $('construction-policy').textContent='数值落点使用输入坐标。角度从 X 正方向逆时针计算。'+(state.tool==='curve'?'长度表示控制点间距，不是曲线弧长。':state.tool==='rectangle'?'相对位移表示宽、高；极坐标长度表示对角线。':'');
    const a=$('construction-first').value,b=$('construction-second').value,status=$('construction-status');candidate=null;status.dataset.status='hint';
    if(!a.trim()||!b.trim())status.textContent=pending()?'请填完两个数值后记录此点。':'填写两个数值可预览落点。';
    else try{const p=resolveConstructionPoint({mode,first:a,second:b},anchor);if(state.tool==='polyline'&&state.draft.length>2&&p.x===state.draft[0].x&&p.y===state.draft[0].y)finishConstructionPolyline(state.draft,{closed:true});else constructionStep(state.tool,state.draft,p);candidate=p;status.textContent='预览：X '+fmt(candidate.x)+' · Y '+fmt(candidate.y)+' '+unit;status.dataset.status='ready';}catch(error){status.textContent=error.message;status.dataset.status='error';}
    $('construction-apply').disabled=!candidate;$('construction-locate').disabled=!candidate;$('construction-clear').disabled=!pending();
    $('construction-back').disabled=!state.draft.length;$('construction-cancel').disabled=!state.draft.length&&!pending();
    $('construction-polyline-actions').hidden=state.tool!=='polyline';$('construction-finish').disabled=state.draft.length<2||pending();$('construction-close').disabled=state.draft.length<3||pending();
  }
  function apply(){sync();if(!candidate)return;try{commit({...candidate});clear();sync();render();$('construction-first').focus();}catch(error){$('construction-status').textContent=error.message;$('construction-status').dataset.status='error';}}
  $('construction-apply').onclick=apply;
  for(const id of ['construction-first','construction-second','construction-mode'])$(id).addEventListener('input',()=>{sync();render();});
  $('construction-mode').addEventListener('change',()=>{sync();render();});
  for(const id of ['construction-first','construction-second'])$(id).addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();apply();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();clear();sync();render();}});
  $('construction-clear').onclick=()=>{clear();sync();render();};
  $('construction-back').onclick=()=>{clear();back();sync();render();};
  $('construction-cancel').onclick=()=>{clear();cancel();sync();render();};
  $('construction-locate').onclick=()=>{sync();if(candidate)locate({...candidate});};
  for(const [id,closed] of [['construction-finish',false],['construction-close',true]])$(id).onclick=()=>{try{if(pending())throw new Error('请先记录或清空待输入数值');finish(closed);sync();render();}catch(error){$('construction-status').textContent=error.message;$('construction-status').dataset.status='error';}};
  return {sync,preview:()=>candidate?{...candidate}:null,reset:()=>{clear();previous=null;},hasPending:()=>!panel.hidden&&pending(),snapshot:()=>({mode:$('construction-mode').value,first:$('construction-first').value,second:$('construction-second').value}),restore:input=>{sync();$('construction-mode').value=input.mode;$('construction-first').value=input.first;$('construction-second').value=input.second;sync();},reveal:()=>{if(!panel.hidden)panel.scrollIntoView({block:'start'});}};
}
