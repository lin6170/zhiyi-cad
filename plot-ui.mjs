import { defaultPlotSettings,normalizePlotSettings,preparePlot,resolvePlotSource,plotSourceStamp,plotPageContent,plotPageSvg,plotPrintHtml,wholePlotSvg,plotReport } from './plot.mjs';
export function createPlotPanel({getProject,getSelection,getTool,commit,setTool,render,fit,notify,download}){
  const $=id=>document.getElementById(id),clone=v=>JSON.parse(JSON.stringify(v)),num=id=>$(id).value.trim()?Number($(id).value):NaN;
  const fields=[['plot-mode','mode'],['plot-paper','paper'],['plot-orientation','orientation'],['plot-custom-width','customWidth'],['plot-custom-height','customHeight'],['plot-roll-width','rollWidth'],['plot-margin','margin'],['plot-overlap','overlap'],['plot-rotation','rotation'],['plot-line-width','lineWidth'],['plot-color','color'],['plot-text','showText'],['plot-marks','marks'],['plot-calibration','calibration']];
  const numeric=new Set(['customWidth','customHeight','rollWidth','margin','overlap','rotation','lineWidth']),booleans=new Set(['color','showText','marks','calibration']);
  let settings=defaultPlotSettings(),preview=null,pageIndex=0,lastProject=null,stamp='',storedStamp='',error='',layers=[],layerKey='',pageCache=new Map();
  const action=fn=>()=>{try{fn();}catch(e){notify(e.message);}};
  function sourceValue(){return JSON.stringify([settings.source,settings.sourceId,settings.sizeId]);}
  function loadFields(){for(const [id,key] of fields)if(booleans.has(key))$(id).checked=settings[key];else $(id).value=settings[key];layoutFields();}
  function layoutFields(){$('plot-paper-fields').hidden=settings.mode==='full';$('plot-roll-field').hidden=settings.mode!=='full';$('plot-overlap-field').hidden=settings.mode!=='tiles';$('plot-custom-fields').hidden=settings.paper!=='custom';}
  function invalidate(message='参数或来源已改变，请重新生成预览。'){preview=null;pageCache.clear();error='';$('plot-status').textContent=message;$('plot-status').dataset.status='stale';updateControls();render();}
  function reset(){settings=getProject().plotSettings?normalizePlotSettings(getProject().plotSettings):defaultPlotSettings();preview=null;pageIndex=0;lastProject=getProject();stamp=plotSourceStamp(getProject());storedStamp=JSON.stringify(getProject().plotSettings||null);error='';layers=[];layerKey='';pageCache.clear();loadFields();}
  function frame(){return [{type:'polyline',points:[{x:0,y:0},{x:preview?.paperWidth||210,y:preview?.paperHeight||297}]}];}
  function fitPage(){if(preview){setTool('plot');fit(frame());}}
  function updateControls(){
    for(const id of ['plot-fit','plot-print','plot-html','plot-svg','plot-page-svg','plot-report','plot-page'])$(id).disabled=!preview;
    $('plot-prev').disabled=!preview||pageIndex<=0;$('plot-next').disabled=!preview||pageIndex>=preview.pages.length-1;
    $('plot-paper-fields').hidden=settings.mode==='full';$('plot-selection-info').textContent=settings.source==='selection'?'已记录 '+settings.selectionIds.length+' 个图元；改变选区后可重新点击“用当前选区”。':'纸样位置、已保存尺码或排料方案直接作为出图来源。';
    const page=$('plot-page');page.replaceChildren();if(preview)for(let i=0;i<preview.pages.length;i++)page.add(new Option((i+1)+' / '+preview.pages.length+' · '+preview.pages[i].label,i));page.value=pageIndex;
    const map=$('plot-map');map.replaceChildren();if(preview){map.style.gridTemplateColumns='repeat('+preview.cols+',minmax(40px,1fr))';for(const [i,p] of preview.pages.entries()){const button=document.createElement('button');button.textContent=p.label;button.title='第 '+(i+1)+' 页';button.classList.toggle('active',i===pageIndex);if(p.kind==='calibration'){button.style.gridColumn='1 / -1';button.style.textAlign='left';}button.onclick=()=>{pageIndex=i;updateControls();render();};map.append(button);}}
  }
  function refreshLayers(){
    const key=JSON.stringify([stamp,settings.source,settings.sourceId,settings.sizeId,settings.selectionIds]);if(key!==layerKey){layerKey=key;try{layers=resolvePlotSource(getProject(),{...settings,excludedLayers:[],showText:true}).layers;}catch{layers=[];}}
    const container=$('plot-layers');container.replaceChildren();for(const layer of layers){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=!settings.excludedLayers.includes(layer);input.dataset.plotLayer=layer;input.onchange=()=>{settings.excludedLayers=input.checked?settings.excludedLayers.filter(value=>value!==layer):[...new Set([...settings.excludedLayers,layer])];invalidate();};label.append(input,document.createTextNode(layer));container.append(label);}
  }
  function refresh(){
    const project=getProject(),nextStamp=plotSourceStamp(project),stored=JSON.stringify(project.plotSettings||null);
    if(project!==lastProject&&stored!==storedStamp){settings=project.plotSettings?normalizePlotSettings(project.plotSettings):defaultPlotSettings();loadFields();layerKey='';invalidate('已恢复工程中的出图设置，请生成预览。');}
    if(stamp!==nextStamp){layerKey='';invalidate('纸样或来源已变化，请重新生成预览。');}lastProject=project;stamp=nextStamp;storedStamp=stored;
    const select=$('plot-source');select.replaceChildren(new Option('当前基码全图',JSON.stringify(['project',null,null])),new Option('记录的选区',JSON.stringify(['selection',null,null])));
    for(const plan of project.gradingPlans||[])for(const size of plan.sizes)select.add(new Option('尺码 · '+plan.name+' / '+size.label,JSON.stringify(['grade',plan.id,size.id])));
    for(const plan of project.markerPlans||[]){select.add(new Option('排料全图 · '+plan.name,JSON.stringify(['marker',plan.id,null])));select.add(new Option('排料裁剪边界 · '+plan.name,JSON.stringify(['marker-cuts',plan.id,null])));}
    if(![...select.options].some(o=>o.value===sourceValue()))select.add(new Option('原来源已缺失',sourceValue()));select.value=sourceValue();refreshLayers();updateControls();
    if(!preview&&error){$('plot-status').textContent=error;$('plot-status').dataset.status='error';}
  }
  function compute(){
    try{
      preview=preparePlot(getProject(),settings);settings=preview.config;pageIndex=Math.min(pageIndex,preview.pages.length-1);pageCache.clear();error='';
      $('plot-status').dataset.status='ready';const report=plotReport(preview);$('plot-status').textContent='1:1 · '+preview.pages.length+' 页（'+preview.rows+' 行 × '+preview.cols+' 列'+(settings.calibration?' + 校准页':'')+'）\n纸张 '+preview.paperWidth.toFixed(3)+' × '+preview.paperHeight.toFixed(3)+' mm\n图形 '+preview.box.width.toFixed(3)+' × '+preview.box.height.toFixed(3)+' mm\n'+report.entityCount+' 个图元 · '+report.nativeCurveCount+' 条原生曲线 · '+report.textCount+' 项源文字'+(preview.source.warnings.length?'\n来源有 '+preview.source.warnings.length+' 条说明，详见出图报告。':'');
      refresh();fitPage();
    }catch(e){preview=null;pageCache.clear();error='出图失败：'+e.message;refresh();render();throw e;}
  }
  $('plot-source').onchange=()=>{const [source,sourceId,sizeId]=JSON.parse($('plot-source').value);Object.assign(settings,{source,sourceId,sizeId});if(source==='selection')settings.selectionIds=[...getSelection()];layerKey='';invalidate();refresh();};
  $('plot-capture').onclick=()=>{Object.assign(settings,{source:'selection',sourceId:null,sizeId:null,selectionIds:[...getSelection()]});layerKey='';invalidate();refresh();};
  $('plot-return').onclick=()=>{setTool('select');fit();};
  for(const [id,key] of fields)$(id).oninput=()=>{settings[key]=booleans.has(key)?$(id).checked:numeric.has(key)?num(id):$(id).value;layoutFields();invalidate();};
  $('plot-preview').onclick=action(compute);$('plot-fit').onclick=fitPage;
  $('plot-page').onchange=()=>{pageIndex=Number($('plot-page').value);updateControls();render();};
  $('plot-prev').onclick=()=>{pageIndex=Math.max(0,pageIndex-1);updateControls();render();};$('plot-next').onclick=()=>{pageIndex=Math.min(preview.pages.length-1,pageIndex+1);updateControls();render();};
  function current(){if(!preview||stamp!==plotSourceStamp(getProject()))throw new Error('请重新生成当前纸样的出图预览');return preview;}
  const filename=()=>current().source.name.replace(/[<>:"/\\|?*]/g,'_')+'-1比1';
  $('plot-print').onclick=action(()=>{const html=plotPrintHtml(current()),popup=window.open('about:blank','_blank');if(!popup)throw new Error('打印窗口被浏览器阻止，可允许弹窗或保存打印文件后打开');popup.opener=null;popup.document.open();popup.document.write(html);popup.document.close();notify('已打开静态打印快照。请在新页选择打印或保存 PDF。');});
  $('plot-html').onclick=action(()=>download(plotPrintHtml(current()),filename()+'-打印.html','text/html;charset=utf-8'));
  $('plot-svg').onclick=action(()=>download(wholePlotSvg(current()),filename()+'.svg','image/svg+xml'));
  $('plot-page-svg').onclick=action(()=>download(plotPageSvg(current(),pageIndex),filename()+'-'+preview.pages[pageIndex].label+'.svg','image/svg+xml'));
  $('plot-report').onclick=action(()=>download(JSON.stringify(plotReport(current()),null,2),filename()+'-出图报告.json','application/json'));
  $('plot-save-settings').onclick=action(()=>{const config=normalizePlotSettings(settings);preparePlot(getProject(),config);const next=clone(getProject());next.plotSettings=config;next.version=Math.max(next.version,10);commit(next);compute();notify('已记录出图设置，请保存工程文件。');});
  function draw({node,overlay,screen,scale}){
    if(getTool()!=='plot'||!preview)return;if(!pageCache.has(pageIndex))pageCache.set(pageIndex,plotPageContent(preview,pageIndex));
    const p=screen({x:0,y:preview.paperHeight}),svg=node('svg',{x:p.x,y:p.y,width:preview.paperWidth*scale,height:preview.paperHeight*scale,viewBox:'0 0 '+preview.paperWidth+' '+preview.paperHeight,'data-plot-page':preview.pages[pageIndex].label},overlay);svg.innerHTML=pageCache.get(pageIndex);
  }
  return {reset,refresh,draw,frame,begin(){refresh();setTool('plot');if(preview)fitPage();$('plot-panel').scrollIntoView({block:'start'});}};
}
