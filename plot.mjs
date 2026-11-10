import { defaultPlotSettings,normalizePlotSettings,plotPapers } from './plot-schema.mjs';
import { bezierSpans,localizeCurve } from './curves.mjs';
import { textWidth,textCorners } from './geometry.mjs';
import { syncAllowances } from './seams.mjs';
import { syncNotches } from './notches.mjs';
import { generateGradedSize } from './grading.mjs';
import { exportMarkerProject } from './marker.mjs';
export { defaultPlotSettings,normalizePlotSettings,plotPapers } from './plot-schema.mjs';
const clone=v=>JSON.parse(JSON.stringify(v));
export const escapePlotText=value=>String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'\ufffd').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>{if(!Number.isFinite(n))throw new Error('出图包含无效坐标');return String(Number(n.toFixed(6)));};
const HEADER=9,FOOTER=17;
export function plotSourceStamp(project){return JSON.stringify([project.units,project.name,project.entities,project.groups,project.seamAllowances,project.notches,project.seamChecks,project.gradingPlans,project.markerPlans,project.metadata,project.calibration]);}
export function resolvePlotSource(project,value){
  const config=normalizePlotSettings(value);if(project.units!=='mm')throw new Error('请先按已知尺寸校准毫米单位，再进行 1:1 出图');
  let source;
  if(config.source==='grade'){
    const plan=project.gradingPlans?.find(p=>p.id===config.sourceId);if(!plan)throw new Error('放码来源已缺失');source=generateGradedSize(project,plan,config.sizeId).project;
  }else if(config.source.startsWith('marker')){
    const plan=project.markerPlans?.find(p=>p.id===config.sourceId);if(!plan)throw new Error('排料来源已缺失');source=exportMarkerProject(project,plan,{cutOnly:config.source==='marker-cuts'});
  }else{
    source=clone(project);let serial=0;const used=new Set(source.entities.map(e=>e.id)),id=()=>{let next;do{next='plot-generated-'+(++serial);}while(used.has(next));used.add(next);return next;};
    syncAllowances(source,id);syncNotches(source,id);
  }
  let entities=source.entities;
  if(config.source==='selection'){
    if(!config.selectionIds.length)throw new Error('请先选择要出图的图元');const present=new Set(entities.map(e=>e.id));if(config.selectionIds.some(id=>!present.has(id)))throw new Error('出图选区含已缺失图元，请重新选择');entities=entities.filter(e=>config.selectionIds.includes(e.id));
  }
  const layers=[...new Set(entities.map(e=>e.layer||'outline'))].sort();
  entities=entities.filter(e=>!config.excludedLayers.includes(e.layer||'outline')&&(config.showText||e.type!=='text'));
  if(!entities.length)throw new Error('当前来源和图层筛选没有可出图的图元');
  for(const e of entities){
    if(e.derivedFrom&&!source.seamAllowances?.some(r=>r.id===e.derivedFrom&&r.status==='current'&&r.outputIds.includes(e.id)))throw new Error('所选图形包含失效缝份，请先修复');
    if(e.notchFrom&&!source.notches?.some(r=>r.id===e.notchFrom&&r.status==='current'&&r.outputIds.includes(e.id)))throw new Error('所选图形包含失效刀口，请先修复');
  }
  return {entities:clone(entities),layers,name:source.name,warnings:[...(source.warnings||[])],sizeLabel:source.metadata?.gradedSize||source.metadata?.baseSize||'',source:config.source};
}
function turnPoint(p,rotation){return rotation===90?{x:-p.y,y:p.x}:rotation===180?{x:-p.x,y:-p.y}:rotation===270?{x:p.y,y:-p.x}:{...p};}
function bezierAt(points,t){let row=points;while(row.length>1)row=row.slice(0,-1).map((p,i)=>({x:p.x*(1-t)+row[i+1].x*t,y:p.y*(1-t)+row[i+1].y*t}));return row[0];}
function derivativeRoots(points,axis){
  if(points.length===3){const a=points[1][axis]-points[0][axis],b=points[2][axis]-points[1][axis],d=b-a;return d?[-a/d]:[];}
  const d=points.slice(1).map((p,i)=>p[axis]-points[i][axis]);let a=d[0]-2*d[1]+d[2],b=2*(d[1]-d[0]),c=d[0];
  const scale=Math.max(Math.abs(a),Math.abs(b),Math.abs(c));if(!scale)return [];a/=scale;b/=scale;c/=scale;
  if(a===0)return b===0?[]:[-c/b];const discriminant=b*b-4*a*c;if(discriminant<0)return [];
  const q=-.5*(b+(b>=0?1:-1)*Math.sqrt(discriminant));return q===0?[-b/(2*a)]:[q/a,c/q];
}
export function plotBezierBounds(points){const candidates=[points[0],points.at(-1)];for(const axis of ['x','y'])for(const t of derivativeRoots(points,axis))if(t>0&&t<1)candidates.push(bezierAt(points,t));return pointsBounds(candidates);}
function pointsBounds(points){return points.reduce((b,p)=>({minX:Math.min(b.minX,p.x),minY:Math.min(b.minY,p.y),maxX:Math.max(b.maxX,p.x),maxY:Math.max(b.maxY,p.y)}),{minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity});}
function mergeBounds(a,b){return {minX:Math.min(a.minX,b.minX),minY:Math.min(a.minY,b.minY),maxX:Math.max(a.maxX,b.maxX),maxY:Math.max(a.maxY,b.maxY)};}
function entityGraphics(entity,reference,config){
  const local=p=>turnPoint({x:p.x-reference.x,y:p.y-reference.y},config.rotation),base={id:entity.id,name:entity.name,layer:entity.layer||'outline',color:entity.source?.color,dashed:entity.source?.lineStyle===1||Boolean(entity.derivedFrom)},arrows=[];
  if(entity.type==='text'){
    const copy={...entity,points:[local(entity.points[0])],rotation:(entity.rotation||0)+config.rotation,width:entity.width||textWidth(entity.text,entity.height)};
    const b=pointsBounds(textCorners(copy)),pad=entity.height*.3;
    return {...base,type:'text',text:copy,bounds:{minX:b.minX-pad,minY:b.minY-pad,maxX:b.maxX+pad,maxY:b.maxY+pad}};
  }
  let spans,points;
  if(entity.curve){
    const localized=localizeCurve(entity.curve),offset={x:localized.origin.x-reference.x,y:localized.origin.y-reference.y};
    spans=bezierSpans(localized.curve).map(span=>span.controlPoints.map(p=>turnPoint({x:p.x+offset.x,y:p.y+offset.y},config.rotation)));points=[spans[0][0],spans.at(-1).at(-1)];
  }else points=entity.points.map(local);
  const control=spans?spans.flatMap(points=>points):points;
  function arrow(start){const list=start?control:control.slice().reverse(),tip=list[0],next=list.find(p=>Math.hypot(p.x-tip.x,p.y-tip.y)>1e-9);if(!next)return;const angle=Math.atan2(tip.y-next.y,tip.x-next.x);arrows.push([{x:tip.x-3*Math.cos(angle-.35),y:tip.y-3*Math.sin(angle-.35)},tip,{x:tip.x-3*Math.cos(angle+.35),y:tip.y-3*Math.sin(angle+.35)}]);}
  if(entity.arrowStart)arrow(true);if(entity.arrowEnd)arrow(false);
  let bounds=spans?spans.map(plotBezierBounds).reduce(mergeBounds):pointsBounds(points);for(const arrow of arrows)bounds=mergeBounds(bounds,pointsBounds(arrow));
  return {...base,type:'path',points,spans,closed:entity.closed,arrows,bounds};
}
export function preparePlot(project,value){
  const config=normalizePlotSettings(value),source=resolvePlotSource(project,config),first=source.entities[0],reference={...(first.curve?.controlPoints[0]||first.points[0])};
  const graphics=source.entities.map(e=>entityGraphics(e,reference,config)),raw=graphics.map(g=>g.bounds).reduce(mergeBounds),pad=config.lineWidth/2+.001;
  const box={minX:raw.minX-pad,minY:raw.minY-pad,maxX:raw.maxX+pad,maxY:raw.maxY+pad};box.width=box.maxX-box.minX;box.height=box.maxY-box.minY;
  let [paperWidth,paperHeight]=config.paper==='custom'?[config.customWidth,config.customHeight]:plotPapers[config.paper];if(config.orientation==='landscape')[paperWidth,paperHeight]=[paperHeight,paperWidth];
  if(config.mode==='full'){paperWidth=config.rollWidth;paperHeight=Math.max(config.calibration?170+2*config.margin:150,Math.ceil((box.height+2*config.margin+HEADER+FOOTER)*1000)/1000);}
  if(paperWidth>5000||paperHeight>5000)throw new Error('单页超过 5000 mm，请改用分页拼接');
  const contentWidth=paperWidth-2*config.margin,contentHeight=paperHeight-2*config.margin-HEADER-FOOTER;
  if(contentWidth<20||contentHeight<20)throw new Error('纸张扣除边距和标题后不足 20 mm');
  if(config.mode==='full'&&box.width>contentWidth+1e-9)throw new Error('整幅宽度不足，请加宽纸卷、旋转图形或改用分页');
  const overlap=config.mode==='tiles'?config.overlap:0;if(overlap>=Math.min(contentWidth,contentHeight)-5)throw new Error('重叠宽度过大，分页步长至少需要 5 mm');
  if(config.calibration&&(contentWidth<105||paperHeight-2*config.margin<170))throw new Error('当前纸张无法容纳 100 mm 校准页，请增大纸张或关闭附加校准页');
  const stepX=contentWidth-overlap,stepY=contentHeight-overlap,cols=config.mode==='full'?1:Math.max(1,1+Math.ceil((box.width-contentWidth-1e-9)/stepX)),rows=config.mode==='full'?1:Math.max(1,1+Math.ceil((box.height-contentHeight-1e-9)/stepY));
  if(cols*rows+(config.calibration?1:0)>200)throw new Error('出图超过 200 页，请改用较大纸张、排料整幅或缩小选区');
  const pages=[];if(config.calibration)pages.push({kind:'calibration',label:'校准页',number:1});
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++)pages.push({kind:'drawing',label:'R'+(row+1)+'C'+(col+1),row,col,number:pages.length+1,left:box.minX+col*stepX,top:box.maxY-row*stepY});
  let work=0;for(const page of pages.filter(p=>p.kind==='drawing'))for(const g of graphics)if(g.bounds.maxX>=page.left-config.lineWidth&&g.bounds.minX<=page.left+contentWidth+config.lineWidth&&g.bounds.maxY>=page.top-contentHeight-config.lineWidth&&g.bounds.minY<=page.top+config.lineWidth){work+=g.type==='text'?g.text.text.length:g.spans?g.spans.reduce((sum,p)=>sum+p.length,0):g.points.length;if(work>1000000)throw new Error('出图总绘制量过大，请使用较大纸张或分批选择裁片');}
  return {config,source,graphics,reference,box,paperWidth,paperHeight,contentWidth,contentHeight,stepX,stepY,overlap,rows,cols,pages};
}
function colorOf(graphic,config){
  if(!config.color)return '#111';const rgb=graphic.color;if(Array.isArray(rgb)&&rgb.length===3&&rgb.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&!rgb.every(n=>n>200))return 'rgb('+rgb.join(',')+')';
  return ({grain:'#267039',seam:'#a05a24',notch:'#a43e28',internal:'#35758a',annotation:'#222'})[graphic.layer]||'#193b49';
}
function graphicSvg(graphic,config){
  const color=colorOf(graphic,config),attributes=' data-plot-entity="'+escapePlotText(graphic.id)+'" data-layer="'+escapePlotText(graphic.layer)+'"';
  if(graphic.type==='text'){
    const e=graphic.text;return '<text'+attributes+' transform="translate('+fmt(e.points[0].x)+' '+fmt(-e.points[0].y)+') rotate('+fmt(-e.rotation)+') scale(1 '+(e.mirrorY?-1:1)+')" font-size="'+fmt(e.height)+'" fill="'+color+'" dominant-baseline="'+(e.verticalAlign==='middle'?'central':'auto')+'" textLength="'+fmt(e.width)+'" lengthAdjust="spacingAndGlyphs">'+escapePlotText(e.text)+'</text>';
  }
  const pair=p=>fmt(p.x)+' '+fmt(-p.y),poly=points=>'M '+points.map(pair).join(' L ');
  let d=graphic.spans?'M '+pair(graphic.spans[0][0])+' '+graphic.spans.map(p=>(p.length===3?'Q ':'C ')+p.slice(1).map(pair).join(' ')).join(' '):poly(graphic.points);if(graphic.closed)d+=' Z';
  return '<path'+attributes+' d="'+d+'" fill="none" stroke="'+color+'" stroke-width="'+fmt(config.lineWidth)+'" stroke-linejoin="round" stroke-linecap="round"'+(graphic.dashed?' stroke-dasharray="2 1"':'')+'/>'+graphic.arrows.map(points=>'<path d="'+poly(points)+'" fill="none" stroke="'+color+'" stroke-width="'+fmt(config.lineWidth)+'"/>').join('');
}
const svgText=(x,y,text,size=3,extra='')=>'<text x="'+fmt(x)+'" y="'+fmt(y)+'" font-size="'+fmt(size)+'" '+extra+'>'+escapePlotText(text)+'</text>';
export function plotRegistrationMarks(plot,page){
  if(!plot.config.marks||page.kind!=='drawing'||!plot.overlap)return [];
  const result=[],w=plot.contentWidth,h=plot.contentHeight,o=plot.overlap;
  for(const y of [h*.25,h*.75]){if(page.col>0)result.push({x:o/2,y,neighbor:'R'+(page.row+1)+'C'+page.col});if(page.col<plot.cols-1)result.push({x:w-o/2,y,neighbor:'R'+(page.row+1)+'C'+(page.col+2)});}
  for(const x of [w*.25,w*.75]){if(page.row>0)result.push({x,y:o/2,neighbor:'R'+page.row+'C'+(page.col+1)});if(page.row<plot.rows-1)result.push({x,y:h-o/2,neighbor:'R'+(page.row+2)+'C'+(page.col+1)});}
  return result.map(p=>({...p,world:{x:page.left+p.x,y:page.top-p.y}}));
}
export function plotPageContent(plot,index){
  const page=plot.pages[index];if(!page)throw new Error('出图页码无效');
  const {paperWidth:w,paperHeight:h,config:c,contentWidth:cw,contentHeight:ch}=plot,m=c.margin,title=(plot.source.name+' '+plot.source.sizeLabel).trim();
  let content='<rect width="'+fmt(w)+'" height="'+fmt(h)+'" fill="white"/><g font-family="Arial, Microsoft YaHei, sans-serif" fill="#111">';
  if(page.kind==='calibration'){
    const left=m+(cw-100)/2,top=m+35;
    content+=svgText(m,m+5,'1:1 输出校准',5)+svgText(m,m+14,'先打印本页，用直尺分别检查 X、Y 两方向。',3.5)+svgText(m,m+22,'比例 100% / 实际大小；关闭适合页面和页眉页脚。',3.3);
    content+='<rect data-calibration-square="100" x="'+fmt(left)+'" y="'+fmt(top)+'" width="100" height="100" fill="none" stroke="#111" stroke-width=".18"/>';
    content+=svgText(left+50,top-4,'X = 100 mm',3.5,'text-anchor="middle"')+svgText(left+50,top+53,'100 × 100 mm',4,'text-anchor="middle"');
    content+='<text transform="translate('+fmt(left-4)+' '+fmt(top+50)+') rotate(-90)" font-size="3.5" text-anchor="middle">Y = 100 mm</text>';
    content+=svgText(m,top+111,'测量线条中心间距；两方向都应为 100 mm。',3.3)+svgText(m,top+120,'若不相符，调整打印设置后重打本页；不要直接裁剪。',3.3);
  }else{
    const x=m,y=m+HEADER,clip='plot-clip-'+page.number;
    let shortTitle=title;while(shortTitle.length&&textWidth(shortTitle+'…',3.2)>cw-65)shortTitle=shortTitle.slice(0,-1);
    content+=svgText(m,m-2,shortTitle===title?title:shortTitle+'…',3.2)+svgText(w-m,m-2,page.label+' · '+page.number+'/'+plot.pages.length+' · 1:1',3.2,'text-anchor="end"');
    content+=svgText(m,m+4,'按行从左到右拼接 · 重叠 '+fmt(plot.overlap)+' mm · '+fmt(w)+' × '+fmt(h)+' mm',2.7);
    content+='<defs><clipPath id="'+clip+'"><rect x="'+fmt(x)+'" y="'+fmt(y)+'" width="'+fmt(cw)+'" height="'+fmt(ch)+'"/></clipPath></defs><g clip-path="url(#'+clip+')"><g transform="translate('+fmt(x-page.left)+' '+fmt(y+page.top)+')">';
    const bottom=page.top-ch,right=page.left+cw;
    for(const g of plot.graphics)if(g.bounds.maxX>=page.left-c.lineWidth&&g.bounds.minX<=right+c.lineWidth&&g.bounds.maxY>=bottom-c.lineWidth&&g.bounds.minY<=page.top+c.lineWidth)content+=graphicSvg(g,c);
    content+='</g></g>';
    if(c.marks){
      content+='<rect x="'+fmt(x)+'" y="'+fmt(y)+'" width="'+fmt(cw)+'" height="'+fmt(ch)+'" fill="none" stroke="#777" stroke-width=".1" stroke-dasharray="2 1" data-plot-frame="true"/>';
      for(const p of plotRegistrationMarks(plot,page)){const px=x+p.x,py=y+p.y;content+='<path data-plot-registration="'+escapePlotText(p.neighbor)+'" d="M '+fmt(px-2)+' '+fmt(py)+' h 4 M '+fmt(px)+' '+fmt(py-2)+' v 4" stroke="#666" stroke-width=".15"/>';}
    }
    const length=Math.min(100,Math.floor(cw/10)*10),ry=h-m-8;
    content+='<path data-calibration-ruler="'+length+'" d="M '+fmt(m)+' '+fmt(ry)+' h '+length+' M '+fmt(m)+' '+fmt(ry-2)+' v 4 M '+fmt(m+length)+' '+fmt(ry-2)+' v 4" fill="none" stroke="#111" stroke-width=".18"/>';
    content+=svgText(m+length/2,ry+5,length+' mm · 100% 打印',2.7,'text-anchor="middle"')+svgText(w-m,ry+5,page.label+' · 1:1',2.7,'text-anchor="end"');
  }
  return content+'</g>';
}
export function plotPageSvg(plot,index){return '<svg xmlns="http://www.w3.org/2000/svg" width="'+fmt(plot.paperWidth)+'mm" height="'+fmt(plot.paperHeight)+'mm" viewBox="0 0 '+fmt(plot.paperWidth)+' '+fmt(plot.paperHeight)+'">'+plotPageContent(plot,index)+'</svg>';}
export function wholePlotSvg(plot){
  const b=plot.box,width=b.width,height=b.height;
  return '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="'+fmt(width)+'mm" height="'+fmt(height)+'mm" viewBox="0 0 '+fmt(width)+' '+fmt(height)+'"><title>'+escapePlotText(plot.source.name)+' · 1:1 mm</title><g font-family="Arial, Microsoft YaHei, sans-serif" transform="translate('+fmt(-b.minX)+' '+fmt(b.maxY)+')">'+plot.graphics.map(g=>graphicSvg(g,plot.config)).join('')+'</g></svg>';
}
export function plotReport(plot){return {format:'zhiyi-plot-report',version:1,name:plot.source.name,scale:1,units:'mm',settings:plot.config,sourceReference:plot.reference,rotatedBounds:plot.box,entityCount:plot.graphics.length,nativeCurveCount:plot.graphics.filter(g=>g.spans).length,textCount:plot.graphics.filter(g=>g.type==='text').length,paper:{width:plot.paperWidth,height:plot.paperHeight,contentWidth:plot.contentWidth,contentHeight:plot.contentHeight},rows:plot.rows,cols:plot.cols,pages:plot.pages.map(p=>({...p,marks:plotRegistrationMarks(plot,p)})),warnings:plot.source.warnings,instructions:['打印比例选择 100% 或实际大小，关闭适合页面和页眉页脚。','裁去后一页内容框左/上方空白边，叠放重叠区域并对齐相同位置的十字。','校准页 100 mm 方框需在 X/Y 两方向量测；纸张和打印机驱动可能重新缩放。','矢量输出使用当前控制点转换的 Bezier 段；文字采用本机字体，不保证与 ET 字形一致。']};}
export function plotPrintHtml(plot){
  const width=fmt(plot.paperWidth),height=fmt(plot.paperHeight),report=plotReport(plot);
  let html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapePlotText(plot.source.name)+' · 1:1 打印</title><style>@page{size:'+width+'mm '+height+'mm;margin:0}*{box-sizing:border-box}body{margin:0;background:#e8ece7;font-family:Arial,"Microsoft YaHei",sans-serif;color:#24392c}aside{max-width:900px;padding:24px;margin:auto;line-height:1.8}button{padding:10px 16px;border:0;border-radius:5px;background:#2e674d;color:white;font:inherit;cursor:pointer}.sheet{width:'+width+'mm;height:'+height+'mm;margin:14px auto;background:white;box-shadow:0 3px 16px #0002;break-after:page;page-break-after:always;break-inside:avoid;overflow:hidden}.sheet:last-child{break-after:auto;page-break-after:auto}.sheet>svg{display:block;width:100%;height:100%}@media print{html,body{margin:0;padding:0;background:white}aside{display:none}.sheet{margin:0;box-shadow:none}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body><aside><h1>1:1 纸样出图</h1><p>'+escapePlotText(plot.source.name)+' · '+plot.pages.length+' 页 · '+width+' × '+height+' mm</p><ol>'+report.instructions.map(t=>'<li>'+escapePlotText(t)+'</li>').join('')+'</ol><p>这是生成时的静态快照。修改纸样后，请重新生成打印文件。</p><button id="print-dialog">打印 / 保存为 PDF</button><p id="print-note">正在准备字体…</p></aside>';
  html+=plot.pages.map((page,i)=>'<section class="sheet" aria-label="'+escapePlotText(page.label)+'">'+plotPageSvg(plot,i)+'</section>').join('');
  return html+'<script>const button=document.getElementById("print-dialog");button.disabled=true;document.fonts.ready.then(()=>{button.disabled=false;document.getElementById("print-note").textContent="选择相同纸张尺寸，比例 100%，关闭页眉页脚。也可使用 Ctrl+P。"});button.onclick=()=>window.print();<\/script></body></html>';
}
