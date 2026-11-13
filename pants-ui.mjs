import {createPantsPrjSession,PANTS_NATIVE_VERIFIED} from './pants-prj-export.mjs';
const ns='http://www.w3.org/2000/svg';
export function createPantsPanel({commands,getSource,getProject,getRevision,setSession,getSession,download}){
  const style=document.createElement('link');style.rel='stylesheet';style.href='pants.css';document.head.append(style);
  const dialog=document.createElement('dialog');dialog.id='pants-dialog';dialog.className='pants-dialog';
  dialog.innerHTML='<header><div><p class="pants-kicker">网页自动改版 · 母版试验</p><h2>裤脚垂直加长</h2></div><button id="pants-close" aria-label="关闭自动改版">关闭</button></header>'+
  '<div class="pants-layout"><section class="pants-controls"><p>在浏览器中计算和修改，应用后可一次撤销。</p><label>已验证的母版规则 JSON<input id="pants-profile" type="file" accept=".json"></label><p id="pants-profile-status" class="pants-muted">请打开原始 PRJ，再选择本机规则文件。文件不会上传。</p>'+
  '<label>垂直加长量<input id="pants-delta" type="number" value="20" min="20" max="20" step="1" readonly> mm</label><p class="pants-muted">当前验收范围：此母版 +20 mm。保持膝线以上和脚口宽，内部折边线同步移动；尺寸表原值保留。</p>'+
  '<button id="pants-preview" class="primary">生成前后对比</button><div id="pants-metrics"></div><p id="pants-status" role="status">尚未生成计划，工程未改变。</p>'+
  '<button id="pants-apply" disabled>应用改版 · 可撤销</button><div class="pants-buttons"><button id="pants-undo">撤销</button><button id="pants-redo">重做</button></div><button id="pants-export" disabled>保存改版 PRJ 副本</button><p class="pants-muted">保存 PRJ 仅覆盖这项完整计划；若又做了其他修改，将停止导出。</p></section>'+
  '<section class="pants-comparison"><div class="pants-viewbar"><label>查看<select id="pants-view"><option value="overlay">前后叠加</option><option value="before">修改前</option><option value="after">修改后</option></select></label><span><i class="before"></i>修改前 <i class="after"></i>修改后</span></div><svg id="pants-compare" role="img" aria-label="裤脚修改前后对比"></svg><p class="pants-muted">放大显示前、后裤片的下段；青色虚线为修改前，橙色实线为修改后。</p></section></div>';
  document.body.append(dialog);const $=id=>dialog.querySelector('#'+id);let plan=null,comparison=null,loading=false,applied=false,token=0;
  const sourceLabel=()=>getSource()?.filename||'未打开 PRJ';
  function message(text,error=false){$('pants-status').textContent=text;$('pants-status').dataset.error=String(error);}
  function sync(){const state=commands.read();$('pants-undo').disabled=!state.canUndo;$('pants-redo').disabled=!state.canRedo;$('pants-apply').disabled=!plan||applied||plan.revision!==getRevision();$('pants-export').disabled=!applied||!PANTS_NATIVE_VERIFIED||!getSession();}
  function render(){
    const svg=$('pants-compare');svg.replaceChildren();if(!comparison)return;
    const {changes}=comparison,all=changes.flatMap(c=>[...c.before.points,...c.after.points]);
    const minX=Math.min(...all.map(p=>p.x))-2,maxX=Math.max(...all.map(p=>p.x))+2,minY=Math.min(...all.map(p=>p.y))-2,maxY=Math.max(...all.map(p=>p.y))+2;
    svg.setAttribute('viewBox',[minX,-maxY,maxX-minX,maxY-minY].join(' '));const mode=$('pants-view').value;
    for(const side of ['before','after']){if(mode!=='overlay'&&mode!==side)continue;for(const change of changes){const e=change[side],path=document.createElementNS(ns,'path');path.setAttribute('d',e.points.map((p,i)=>(i?'L':'M')+p.x+' '+(-p.y)).join(' '));path.setAttribute('fill','none');path.setAttribute('stroke',side==='before'?'#4ccad3':'#ffbc70');path.setAttribute('stroke-width','1.6');path.setAttribute('vector-effect','non-scaling-stroke');path.dataset.comparison=side;if(side==='before'&&mode==='overlay')path.setAttribute('stroke-dasharray','5 3');svg.append(path);}}
  }
  $('pants-profile').onchange=async event=>{
    const current=++token;setSession(null);plan=null;comparison=null;applied=false;render();sync();
    const file=event.target.files[0],source=getSource();if(!file)return;
    if(!source){message('请先在工作台打开原始 PRJ。',true);return;}
    if(file.size>16000){message('规则文件过大。',true);return;}
    loading=true;$('pants-preview').disabled=true;const revision=getRevision();
    try{const profile=JSON.parse(await file.text()),session=await createPantsPrjSession(source.bytes,source.filename,getProject(),profile);if(current!==token||revision!==getRevision()||source!==getSource())return;setSession(session);$('pants-profile-status').textContent=session.profileName+' · '+sourceLabel();message('母版与规则已核对，可以生成前后对比。');}
    catch(e){if(current===token)message(e.message,true);}
    finally{if(current===token){loading=false;$('pants-preview').disabled=false;sync();}}
  };
  $('pants-preview').onclick=()=>{try{if(loading)throw Error('正在核对文件。');plan=commands.preview({schema:'zhiyi-cad-command/v1',type:'pattern.extendPantsHem',expectedRevision:getRevision(),parameters:{deltaMm:20}});comparison=plan;applied=false;$('pants-metrics').replaceChildren();for(const m of plan.measurements){const p=document.createElement('p');p.textContent=m.piece+'：垂直 +'+m.verticalDeltaMm+' mm；脚口 '+m.hemWidthBeforeMm.toFixed(2)+' → '+m.hemWidthAfterMm.toFixed(2)+' mm';$('pants-metrics').append(p);}message(plan.changes.length+' 条关联线将同步修改。当前仅预览，工程未改变。');render();sync();}catch(e){plan=null;sync();message(e.message,true);}};
  $('pants-apply').onclick=()=>{try{commands.apply(plan.id);applied=true;message('已在网页应用改版。可以撤销或保存独立 PRJ。');sync();}catch(e){plan=null;sync();message(e.message,true);}};
  for(const [id,type] of [['pants-undo','history.undo'],['pants-redo','history.redo']])$(id).onclick=()=>{try{commands.execute({schema:'zhiyi-cad-command/v1',type,expectedRevision:getRevision(),parameters:{}});plan=null;applied=type==='history.redo'&&Boolean(comparison);message(type==='history.undo'?'已撤销。当前工程恢复到上一步；对比图保留供核对。':'已重做。保存前还会核对完整计划。');sync();}catch(e){message(e.message,true);}};
  $('pants-export').onclick=()=>{try{if(!PANTS_NATIVE_VERIFIED)throw Error('此项 PRJ 输出尚未完成原生验收。');const bytes=getSession().exportPrj(getProject());download(bytes,getSource().filename.replace(/\.prj$/i,'')+'-裤脚加长20mm.prj','application/octet-stream');message('已下载改版 PRJ 副本。原文件保持不变。');}catch(e){message(e.message,true);}};
  $('pants-view').onchange=render;$('pants-close').onclick=()=>dialog.close();
  return {open(){sync();dialog.showModal();},isOpen:()=>dialog.open,reset(){token++;loading=false;plan=null;comparison=null;applied=false;setSession(null);$('pants-profile').value='';$('pants-preview').disabled=false;$('pants-profile-status').textContent='请选择本机规则文件。';$('pants-metrics').replaceChildren();message('尚未生成计划，工程未改变。');render();sync();dialog.close();}};
}
