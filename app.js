import { bounds, length, distance, transform, quadratic, pointOnSegment, textCorners, textWidth, validateProject, fromDxf, toDxf } from './geometry.mjs';
import { expandGroups, entitiesInBox, selectionBounds, moveSelection, rotateSelection, mirrorSelection, duplicateSelection, deleteSelection, groupSelection, ungroupSelection } from './selection.mjs';
import { parsePrj } from './prj-parser.mjs';
import { createPrjImportDialog } from './prj-import.mjs';
import { calibratedProject, calibrateFromReference, referenceLength } from './precision.mjs';
import { inspectProject } from './topology.mjs';
import { curveLength, editControlPoint, quadraticCurve, refreshCurve } from './curves.mjs';
import { createSnapIndex } from './snapping.mjs';
import {constructionStep,finishConstructionPolyline} from './construction.mjs';
import {createConstructionInput} from './construction-ui.mjs';
import {createRecoveryPanel} from './recovery-ui.mjs';
import { seamBases, generateAllowance, applyAllowance, syncAllowances, detachAllowance, assertIndependentTransform } from './seams.mjs';
import { generateNotches, applyNotches, syncNotches, detachNotches } from './notches.mjs';
import { seamEdgeDefinitions, edgeKey } from './seam-widths.mjs';
import { syncSeamChecks } from './seam-checks.mjs';
import { createSeamCheckPanel } from './seam-check-ui.mjs';
import { syncGradingPlans } from './grading.mjs';
import { createGradingPanel } from './grading-ui.mjs';
import { syncMarkerPlans } from './marker.mjs';
import { createMarkerPanel } from './marker-ui.mjs';
import { createPlotPanel } from './plot-ui.mjs';
import { createLineEditPanel } from './line-edit-ui.mjs';
import { createIntersectionTrimPanel } from './intersection-trim-ui.mjs';
import { createEndpointExtendPanel } from './endpoint-extend-ui.mjs';
import { createPositionPanel } from './position-ui.mjs';
import { createSpreadPanel } from './spread-ui.mjs';
import { createDartPanel } from './dart-ui.mjs';
import { createUnfoldPanel } from './unfold-ui.mjs';
import { createPieceSplitPanel } from './piece-split-ui.mjs';
import { createPieceMergePanel } from './piece-merge-ui.mjs';
import { spreadBoundary, pickSpreadStation } from './spread.mjs';
import { createDxfSettings } from './dxf-ui.mjs';
import { decodeDxfBytes } from './dxf.mjs';
import { createTableTextEditor } from './table-ui.mjs';
import { replaceAnnotationText } from './annotation-text.mjs';
import { createPrjTextExportSession } from './prj-text-export.mjs';
import { createPrjWritebackPanel } from './prj-writeback-ui.mjs';
import { createPrjEndpointExportSession } from './prj-endpoint-export.mjs';
import { createPrjEndpointPanel } from './prj-endpoint-ui.mjs';
import { createPrjSavePanel } from './prj-save-ui.mjs';
import { createPrjLineExportSession } from './prj-line-export.mjs';
import { createPrjLinePanel } from './prj-line-ui.mjs';
const $ = id => document.getElementById(id);
const svg = $('canvas'), drawing = $('drawing'), overlay = $('overlay');
const ns = 'http://www.w3.org/2000/svg';
const dxfSettings=createDxfSettings();
const prjImport=createPrjImportDialog();
let project = emptyProject(), selected = new Set(), tool = 'select', dirty = false;
let camera = { x: 100, y: 500, scale: 1 }, draft = [], pointer = { x: 0, y: 0 }, gesture = null, space = false;
let undoStack = [], redoStack = [], toastTimer;
let importPending = false;
let prjExportSession = null;
let prjEndpointSession = null;
let prjLineSession = null;
let recovery=null,recoverySuspended=false,recoveryFingerprint=null,recoveryHasRecord=false,projectRevision=0;
let snapIndex=null,snapMatch=null,snapFailure=null,lastPointerWorld=null;
let darkCanvas = false;
let inspection = null, focusedInspection = null, focusedInspectionIssue = null;
let referenceEntityId = null;
let controlEntityId = null, controlIndex = 0;
let seamPreview = null, seamChoiceKey = '', seamChoices = [];
let seamEdgeDefs=[],seamWidthsDraft=new Map(),seamRowsKey='',seamEdgeFocus=null;
let notchPreview=null,notchSelectionKey='',notchBaseKey='';
const prjWritebackPanel=createPrjWritebackPanel({getProject:()=>project,getSession:()=>prjExportSession,
  canPreview:()=>!importPending&&!draft.length&&!gesture&&!constructionInput.hasPending()&&!tableEditor.isOpen()&&!recovery?.isOpen()&&['select','node'].includes(tool),download,notify});
const prjEndpointPanel=createPrjEndpointPanel({getProject:()=>project,getSession:()=>prjEndpointSession,
  canPreview:()=>!importPending&&!draft.length&&!gesture&&!constructionInput.hasPending()&&!tableEditor.isOpen()&&!recovery?.isOpen()&&['select','node'].includes(tool),
  selectLine:id=>{selected=new Set([id]);setTool('node');refresh();fit(selectedEntities());},download,notify});
const prjLinePanel=createPrjLinePanel({getProject:()=>project,getSession:()=>prjLineSession,
  canPreview:()=>!importPending&&!draft.length&&!gesture&&!constructionInput.hasPending()&&!tableEditor.isOpen()&&!recovery?.isOpen()&&['select','node'].includes(tool),download,notify});
const prjSavePanel=createPrjSavePanel({getProject:()=>project,getTextSession:()=>prjExportSession,getEndpointSession:()=>prjEndpointSession,getLineSession:()=>prjLineSession,openLinePreview:()=>prjLinePanel.open(),
  canPreview:()=>!importPending&&!draft.length&&!gesture&&!constructionInput.hasPending()&&!tableEditor.isOpen()&&!recovery?.isOpen()&&['select','node'].includes(tool)});
function emptyProject() { return { format: 'zhiyi-cad', version: 6, name: '未命名纸样', units: 'mm', entities: [], groups: [], seamAllowances: [], notches:[], seamChecks:[], warnings: [] }; }
const matchPanel=createSeamCheckPanel({getProject:()=>project,commit:next=>{checkpoint();project=next;finishEdit();},setTool,render,fit,notify,download});
const gradingPanel=createGradingPanel({getProject:()=>project,getSelection:()=>selected,getTool:()=>tool,getDxfOptions:dxfSettings.options,commit:next=>{checkpoint();project=next;finishEdit();},setTool,render,fit,notify,download});
const markerPanel=createMarkerPanel({getProject:()=>project,getSelection:()=>selected,getTool:()=>tool,getDxfOptions:dxfSettings.options,isDark:()=>darkCanvas,commit:next=>{checkpoint();project=next;finishEdit();},setTool,render,fit,notify,download});
const plotPanel=createPlotPanel({getProject:()=>project,getSelection:()=>selected,getTool:()=>tool,commit:next=>{checkpoint();project=next;finishEdit();},setTool,render,fit,notify,download});
const lineEditPanel=createLineEditPanel({getProject:()=>project,getSelection:()=>selected,getTool:()=>tool,commit:(next,ids)=>{checkpoint();project=next;selected=new Set(ids);finishEdit();},setTool,render,fit,notify});
const trimPanel=createIntersectionTrimPanel({getProject:()=>project,getSelection:()=>selected,getTool:()=>tool,commit:(next,ids)=>{checkpoint();project=next;selected=new Set(ids);finishEdit();},setTool,render,fit,notify});
const extendPanel=createEndpointExtendPanel({getProject:()=>project,getSelection:()=>selected,getTool:()=>tool,commit:(next,ids)=>{checkpoint();project=next;selected=new Set(ids);finishEdit();},setTool,render,fit,notify});
const positionPanel=createPositionPanel({getProject:()=>project,getSelection:()=>selected,getTool:()=>tool,commit:(next,ids)=>{checkpoint();project=next;selected=new Set(ids);finishEdit();},setTool,render,fit,notify});
const spreadPanel=createSpreadPanel({getProject:()=>project,getSelection:()=>selected,getTool:()=>tool,commit:(next,ids)=>{checkpoint();project=next;selected=new Set(ids);finishEdit();},setTool,render,fit,notify});
const dartPanel=createDartPanel({getProject:()=>project,getSelection:()=>selected,getTool:()=>tool,commit:(next,ids)=>{checkpoint();project=next;selected=new Set(ids);finishEdit();},setTool,render,fit,notify});
const unfoldPanel=createUnfoldPanel({getProject:()=>project,getSelection:()=>selected,getTool:()=>tool,commit:(next,ids)=>{checkpoint();project=next;selected=new Set(ids);finishEdit();},setTool,render,fit,notify});
const pieceSplitPanel=createPieceSplitPanel({getProject:()=>project,getSelection:()=>selected,getTool:()=>tool,commit:(next,ids)=>{checkpoint();project=next;selected=new Set(ids);finishEdit();},setTool,render,fit,notify});
const pieceMergePanel=createPieceMergePanel({getProject:()=>project,getSelection:()=>selected,getTool:()=>tool,commit:(next,ids)=>{checkpoint();project=next;selected=new Set(ids);finishEdit();},setTool,render,fit,notify});
const tableEditor=createTableTextEditor({getProject:()=>project,getSelection:()=>selected,commit:next=>{checkpoint();project=next;finishEdit();},locate:ids=>{selected=new Set(ids);setTool('select');refresh();fit(selectedEntities());},notify,download});
const constructionInput=createConstructionInput({getState:()=>({tool,draft,units:project.units,project}),commit:p=>acceptConstructionPoint(p,{numeric:true}),finish:finishPolyline,back:()=>{draft=draft.slice(0,-1);snapMatch=null;snapFailure=null;},cancel:()=>{draft=[];snapMatch=null;snapFailure=null;},locate:p=>{camera.x=svg.clientWidth/2-p.x*camera.scale;camera.y=svg.clientHeight/2+p.y*camera.scale;render();},render});
recovery=createRecoveryPanel({canRestore:()=>{if(importPending||tableEditor.isOpen()){notify('请先完成文件导入或关闭尺寸表编辑。');return false;}return canReplace();},restore:state=>{
  recoverySuspended=true;
  try{loadProject(state.project);setTool(state.tool);draft=state.draft;pointer=draft.length?{...draft.at(-1)}:{x:0,y:0};constructionInput.restore(state.input);darkCanvas=state.dark;$('grid').checked=state.grid;$('show-text').checked=state.showText;dirty=true;refresh();fit(draft.length?[...project.entities,{type:'polyline',points:draft}]:project.entities);}
  finally{recoverySuspended=false;}
  captureRecovery(true);
},captureNow:()=>captureRecovery(true),notify});
function hasUnsavedWork(){return dirty||draft.length>0||constructionInput.hasPending();}
function captureRecovery(force=false){
  if(!recovery||recoverySuspended||importPending||gesture||!recovery.writer.enabled)return;
  const active=['line','polyline','curve','rectangle','grain','measure'].includes(tool),input=active?constructionInput.snapshot():{mode:'absolute',first:'',second:''};
  if(!dirty&&!draft.length&&!input.first&&!input.second&&!recoveryHasRecord)return;
  const fingerprint=[project,projectRevision,draft,active?tool:'select',input.mode,input.first,input.second,dirty,darkCanvas,$('grid').checked,$('show-text').checked];
  if(!force&&recoveryFingerprint&&fingerprint.every((value,i)=>value===recoveryFingerprint[i]))return;
  recoveryFingerprint=fingerprint;recoveryHasRecord=true;
  recovery.writer.capture({format:'zhiyi-recovery',version:1,project,tool:active?tool:'select',draft:active?draft:[],input,dark:darkCanvas,grid:$('grid').checked,showText:$('show-text').checked});
}
$('table-tool').onclick=()=>tableEditor.open();
function unit() { return project.units === 'mm' ? 'mm' : '原始单位'; }
function node(tag, attributes, parent) {
  const el = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
  parent?.append(el); return el;
}
function notify(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6000);
}
function screen(p) { return { x: camera.x + p.x * camera.scale, y: camera.y - p.y * camera.scale }; }
function world(event) {
  const rect = svg.getBoundingClientRect();
  return { x: (event.clientX - rect.left - camera.x) / camera.scale, y: (camera.y - event.clientY + rect.top) / camera.scale };
}
function pathData(points, closed = false) {
  return points.map((p, i) => {
    const s = screen(p); return (i ? 'L ' : 'M ') + s.x + ' ' + s.y;
  }).join(' ') + (closed ? ' Z' : '');
}
function selectedEntities() { return project.entities.filter(entity => selected.has(entity.id)); }
function selectedEntity() { return selected.size === 1 ? selectedEntities()[0] : null; }
function selectedGroup() { return (project.groups || []).find(group => group.entityIds.length === selected.size && group.entityIds.every(id => selected.has(id))); }
function selectEntity(entity, event, preserve = false) {
  const ids = $('whole-group').checked && tool !== 'node' && !event.altKey
    ? expandGroups(project, [entity.id]) : new Set([entity.id]);
  if (event.shiftKey) {
    const remove = [...ids].every(id => selected.has(id));
    for (const id of ids) remove ? selected.delete(id) : selected.add(id);
  } else if (!preserve || !selected.has(entity.id)) selected = ids;
}

function checkpoint() {
  projectRevision++;
  invalidateInspection();
  undoStack.push(JSON.stringify(project));
  if (undoStack.length > 40) undoStack.shift();
  redoStack = []; dirty = true;
}
function finishEdit() { dirty = true; refresh(); }
function newEntity(points, options = {}) {
  return { id: crypto.randomUUID(), type: 'polyline', points, closed: false, name: '线条 ' + (project.entities.length + 1), layer: 'outline', ...options };
}
function addEntity(points, options) {
  checkpoint(); const entity = newEntity(points, options);
  project.entities.push(entity); selected = new Set([entity.id]); finishEdit();
}
function commitConstructionEntity(spec){
  const entity=spec.curve?refreshCurve(newEntity(spec.points,spec)):newEntity(spec.points,spec);
  checkpoint();project.entities.push(entity);selected=new Set([entity.id]);draft=[];snapMatch=null;snapFailure=null;finishEdit();
}
function finishPolyline(closed=false){if(tool!=='polyline')throw new Error('请先选择折线工具');commitConstructionEntity(finishConstructionPolyline(draft,{closed}));}
function acceptConstructionPoint(p,{numeric=false}={}){
  if(numeric&&tool==='polyline'&&draft.length>2&&p.x===draft[0].x&&p.y===draft[0].y){finishPolyline(true);return;}
  const result=constructionStep(tool,draft,p);
  if(result.kind==='entity'){commitConstructionEntity(result.entity);return;}
  draft=result.draft;pointer={...p};if(numeric){snapMatch=null;snapFailure=null;lastPointerWorld=null;}
  if(result.kind==='measurement'){const m=result.measurement;$('measurement').hidden=false;$('measurement').textContent='距离 '+m.length.toFixed(3)+' '+unit()+' · ΔX '+m.dx.toFixed(2)+' · ΔY '+m.dy.toFixed(2);}
  render();
}
function usesSnap(){return !space&&gesture?.type!=='pan'&&(['line','polyline','curve','rectangle','grain','measure','position'].includes(tool)||gesture?.type==='node');}
function constraintMode(){return ['perpendicular','tangent'].includes($('snap-mode').value);}
function constraintTool(){return ['line','polyline','grain','measure'].includes(tool);}
function snap(p,{bypass=false}={}) {
  lastPointerWorld={...p};snapMatch=null;snapFailure=null;
  if(bypass||!$('snap').checked||!usesSnap())return {...p};
  try{snapIndex??=createSnapIndex(project.entities);const constrained=constraintMode(),anchor=constrained&&constraintTool()?draft.at(-1):undefined,mode=constrained&&!anchor?'endpoint':$('snap-mode').value;const result=snapIndex.query(p,9/camera.scale,{mode,anchor,excludeIds:gesture?.snapExcludeIds||[]});if(!result.complete)snapFailure=result.reason;else snapMatch=result.match;if(constrained&&anchor&&result.complete&&!result.match)snapFailure='鼠标附近没有相对于起点的'+(mode==='perpendicular'?'垂足':'孤立切点')+'；请靠近落点或切换模式';if(mode==='intersection'&&result.complete&&!result.match)snapFailure='鼠标附近没有可确定的孤立交点；请靠近交点、切换模式或按 Alt 自由落点';}
  catch(error){snapFailure=error.message;}
  return {...(snapMatch?.point||p)};
}
function hit(p) {
  let result = null, closest = 7 / camera.scale;
  for (const entity of project.entities) {
    if (entity.type === 'text') {
      if (!$('show-text').checked) continue;
      const [origin, xCorner, , yCorner] = textCorners(entity);
      const dx = xCorner.x - origin.x, dy = xCorner.y - origin.y;
      const hx = yCorner.x - origin.x, hy = yCorner.y - origin.y;
      const relativeX = p.x - origin.x, relativeY = p.y - origin.y;
      const along = (relativeX * dx + relativeY * dy) / (dx * dx + dy * dy);
      const up = (relativeX * hx + relativeY * hy) / (hx * hx + hy * hy);
      if (along >= 0 && along <= 1 && up >= -.2 && up <= 1.2) result = { entity, point: p };
      continue;
    }
    const count = entity.points.length;
    for (let i = 0; i < count - (entity.closed ? 0 : 1); i++) {
      const a = entity.points[i], b = entity.points[(i + 1) % count];
      const projected = pointOnSegment(p, a, b), d = distance(p, projected);
      if (d <= closest) { closest = d; result = { entity, point: projected, a, b, segmentIndex:i }; }
    }
  }
  return result;
}
function entityColor(entity) {
  if(entity.notchFrom&&(project.notches||[]).find(recipe=>recipe.id===entity.notchFrom)?.status!=='current')return '#e56b60';
  if(entity.derivedFrom&&(project.seamAllowances||[]).find(recipe=>recipe.id===entity.derivedFrom)?.status!=='current')return '#e56b60';
  const stored = entity.source?.color;
  if (Array.isArray(stored) && stored.length === 3 && stored.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    if (!darkCanvas && stored.every(value => value > 200)) return '#35483f';
    return 'rgb(' + stored.join(',') + ')';
  }
  const colors = darkCanvas
    ? { grain: '#66d17a', notch: '#f0b65b', internal: '#77cad2', annotation: '#e0e5e0', seam:'#eea358' }
    : { grain: '#528056', notch: '#ae6c51', internal: '#718d93', annotation: '#35483f', seam:'#bb7239' };
  return colors[entity.layer] || (darkCanvas ? '#e0e5e0' : '#517160');
}
function render() {
  constructionInput.sync();const constructionPreview=constructionInput.preview(),drawingPointer=constructionPreview||pointer;
  drawing.replaceChildren(); overlay.replaceChildren();
  if(tool==='marker')markerPanel.draw({node,overlay,screen,pathData,scale:camera.scale});
  else if(tool==='plot')plotPanel.draw({node,overlay,screen,scale:camera.scale});
  else{
  for (const entity of project.entities) {
    const active = selected.has(entity.id);
    const color = active ? '#e3bd63' : entityColor(entity);
    if (entity.type === 'text') {
      if (!$('show-text').checked) continue;
      const origin = screen(entity.points[0]);
      const text = node('text', {
        x: 0, y: 0, fill: color, 'font-size': entity.height * camera.scale,
        'font-family': 'Arial,"Microsoft YaHei",sans-serif',
        'dominant-baseline': entity.verticalAlign === 'middle' ? 'central' : 'auto',
        transform: 'translate(' + origin.x + ' ' + origin.y + ') rotate(' + -(entity.rotation || 0) + ') scale(1 ' + (entity.mirrorY ? -1 : 1) + ')',
        'data-entity-id': entity.id
      }, drawing);
      text.textContent = entity.text;
      if (entity.width) { text.setAttribute('textLength', entity.width * camera.scale); text.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
      if (active) node('path', { d: pathData(textCorners(entity), true), fill: 'none', stroke: '#e3bd63', 'stroke-width': 1, 'stroke-dasharray': '3 3' }, overlay);
      continue;
    }
    const attrs = {
      d: pathData(entity.points, entity.closed),
      fill: entity.closed&&!entity.derivedFrom ? (active ? '#98b98120' : '#80947508') : 'none',
      stroke: color,
      'stroke-width': active ? 2 : 1.25, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    };
    if (entity.source?.lineStyle === 1) attrs['stroke-dasharray'] = '4 3';
    if(entity.derivedFrom)attrs['stroke-dasharray']='7 3';
    node('path', attrs, drawing);
    const arrowTips = [];
    if (entity.arrowEnd) arrowTips.push([entity.points.at(-1), entity.points.at(-2)]);
    if (entity.arrowStart) arrowTips.push([entity.points[0], entity.points[1]]);
    for (const [tip, neighbor] of arrowTips) {
      const end = screen(tip), previous = screen(neighbor);
      const angle = Math.atan2(end.y - previous.y, end.x - previous.x), size = 7;
      const a = { x: end.x - size * Math.cos(angle - .35), y: end.y - size * Math.sin(angle - .35) };
      const b = { x: end.x - size * Math.cos(angle + .35), y: end.y - size * Math.sin(angle + .35) };
      node('path', { d: 'M '+a.x+' '+a.y+' L '+end.x+' '+end.y+' L '+b.x+' '+b.y, fill: 'none', stroke: color, 'stroke-width': 1.25 }, drawing);
    }
    if (active && selected.size === 1 && tool === 'node' && !entity.derivedFrom && !entity.notchFrom) {
      const points=entity.curve?.controlPoints || entity.points;
      if(entity.curve) node('path',{d:pathData(points),fill:'none',stroke:'#69b9c8','stroke-width':1,'stroke-dasharray':'4 4','data-control-polygon':entity.id},overlay);
      points.forEach((p,index)=>{
        const s=screen(p);
        node('circle',{cx:s.x,cy:s.y,r:4.5,fill:entity.id===controlEntityId&&index===controlIndex?'#69b9c8':'#fff',stroke:'#c48b37','stroke-width':1.5,'data-control-index':index},overlay);
      });
    }
  }
  if (selected.size > 1) {
    const box = selectionBounds(project, selected);
    if (box) node('path', { d: pathData([{x:box.minX,y:box.minY},{x:box.maxX,y:box.minY},{x:box.maxX,y:box.maxY},{x:box.minX,y:box.maxY}],true), fill:'none',stroke:'#d4b16a','stroke-width':1,'stroke-dasharray':'6 4'}, overlay);
  }
  if (gesture?.type === 'box') {
    const start = screen(gesture.start), end = screen(gesture.current);
    node('rect', {x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y),fill:gesture.current.x<gesture.start.x?'#69ba7720':'#71a7cf20',stroke:gesture.current.x<gesture.start.x?'#69ba77':'#71a7cf','stroke-dasharray':gesture.current.x<gesture.start.x?'5 3':'none'},overlay);
  }
  if (inspection && focusedInspection !== null) {
    for (const [issueIndex,issue] of (inspection.results[focusedInspection]?.issues || []).entries()) {
      if(focusedInspectionIssue!==null&&focusedInspectionIssue!==issueIndex)continue;
      const diagnosticColor=issue.severity==='review'?'#bd8734':'#ef7061';
      for(const highlight of issue.highlights||[]){const points=highlight.controls.map(screen),command=points.length===2?'L':points.length===3?'Q':'C';node('path',{d:'M '+points[0].x+' '+points[0].y+' '+command+' '+points.slice(1).map(p=>p.x+' '+p.y).join(' '),fill:'none',stroke:diagnosticColor,'stroke-width':3,'stroke-dasharray':highlight.virtualConnection?'5 3':'none','data-diagnostic-native':issue.kind},overlay);}
      if (issue.start && issue.end) node('path', { d: pathData([issue.start, issue.end]), stroke: '#ef7061', 'stroke-width': 2, 'stroke-dasharray': '3 2' }, overlay);
      for (const point of [issue.point, issue.start, issue.end].filter(Boolean)) {
        const position = screen(point);
        node('circle', { cx: position.x, cy: position.y, r: 6, fill: 'none', stroke: '#ef7061', 'stroke-width': 2, 'data-diagnostic': issue.kind }, overlay);
      }
    }
  }
  if(seamPreview){
    node('path',{d:pathData(seamPreview.basePoints,true),fill:'none',stroke:'#69bfdb','stroke-width':2,'data-seam-base':'true'},overlay);
    for(const path of seamPreview.paths)node('path',{d:pathData(path.points,true),fill:'none',stroke:'#f1a55e','stroke-width':2.5,'stroke-dasharray':'7 4','data-seam-preview':path.role},overlay);
  }
  if($('seam-width-mode').value==='edges'&&seamEdgeDefs.length){
    for(let i=0;i<seamEdgeDefs.length;i++){
      const edge=seamEdgeDefs[i],focused=edge.key===seamEdgeFocus,p=edge.points.length===2?{x:(edge.points[0].x+edge.points[1].x)/2,y:(edge.points[0].y+edge.points[1].y)/2}:edge.points[Math.floor((edge.points.length-1)/2)],s=screen(p);
      if(focused)node('path',{d:pathData(edge.points),fill:'none',stroke:'#55bfdc','stroke-width':4,'data-seam-edge':edge.key},overlay);
      if(seamEdgeDefs.length<=80||focused){const label=node('text',{x:s.x+7,y:s.y-8,fill:focused?'#55bfdc':darkCanvas?'#cbd9d1':'#547d66','font-size':12,'data-seam-edge-label':i},overlay);label.textContent=String(i+1);}
    }
  }
  if(notchPreview){
    const base=project.entities.find(entity=>entity.id===notchPreview.baseId);
    if(base){
      node('path',{d:pathData(base.points,base.closed),fill:'none',stroke:'#69bfdb','stroke-width':2,'data-notch-base':'true'},overlay);
      const points=base.closed?[base.points[0]]:[base.points[0],base.points.at(-1)];
      points.forEach((p,i)=>{const s=screen(p),label=node('text',{x:s.x+7,y:s.y-8,fill:'#69bfdb','font-size':12},overlay);label.textContent=base.closed?'起 / 终':i?'终':'起';});
    }
    for(const station of notchPreview.stations){
      const p=screen(station.point),tip={x:p.x+station.tangent.x*22,y:p.y-station.tangent.y*22};
      const wing={x:station.tangent.y*4,y:station.tangent.x*4};
      node('path',{d:'M '+p.x+' '+p.y+' L '+tip.x+' '+tip.y+' M '+(tip.x-station.tangent.x*7+wing.x)+' '+(tip.y+station.tangent.y*7+wing.y)+' L '+tip.x+' '+tip.y+' L '+(tip.x-station.tangent.x*7-wing.x)+' '+(tip.y+station.tangent.y*7-wing.y),fill:'none',stroke:'#69bfdb','stroke-width':1.5},overlay);
      node('path',{d:pathData([station.point,station.anchor]),fill:'none',stroke:'#e4b46c','stroke-dasharray':'3 3'},overlay);
      const anchor=screen(station.anchor);node('circle',{cx:anchor.x,cy:anchor.y,r:3,fill:'#f1a55e'},overlay);
    }
    for(const path of notchPreview.paths)node('path',{d:pathData(path.points),fill:'none',stroke:'#f1a55e','stroke-width':3,'data-notch-preview':'true'},overlay);
  }
  if (draft.length) {
    let points = [...draft, drawingPointer], closed = false;
    if (tool === 'rectangle') {
      const a = draft[0], b = drawingPointer;
      points = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]; closed = true;
    }
    if (tool === 'curve' && draft.length === 2) points = quadratic(draft[0], draft[1], drawingPointer);
    node('path', { d: pathData(points, closed), fill: 'none', stroke: '#b98b41', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }, overlay);
    for (const p of draft) {
      const s = screen(p); node('circle', { cx: s.x, cy: s.y, r: 3, fill: '#b98b41' }, overlay);
    }
  }
  if(!gesture?.changed)matchPanel.draw({node,overlay,screen,pathData});
  if(!gesture?.changed)gradingPanel.draw({node,overlay,screen,pathData,scale:camera.scale});
  if(!gesture?.changed)lineEditPanel.draw({node,overlay,screen,pathData});
  if(!gesture?.changed)trimPanel.draw({node,overlay,screen,pathData});
  if(!gesture?.changed)extendPanel.draw({node,overlay,screen,pathData});
  if(!gesture?.changed)positionPanel.draw({node,overlay,screen,pathData,scale:camera.scale});
  if(!gesture?.changed)spreadPanel.draw({node,overlay,screen,pathData,scale:camera.scale});
  if(!gesture?.changed)dartPanel.draw({node,overlay,screen,pathData,scale:camera.scale});
  if(!gesture?.changed)unfoldPanel.draw({node,overlay,screen,pathData,scale:camera.scale});
  if(!gesture?.changed)pieceSplitPanel.draw({node,overlay,screen,pathData,scale:camera.scale});
  if(!gesture?.changed)pieceMergePanel.draw({node,overlay,screen,pathData,scale:camera.scale});
  }
  const snapLabels={endpoint:'端点',vertex:'折线顶点',midpoint:'线段中点','half-length':'曲线半长点',nearest:snapMatch?.segmentType==='native-curve'?'曲线最近点':'线段最近点',perpendicular:'垂足',tangent:'切点',intersection:snapMatch?.selfIntersection?'自交点':'交点'},snapStatus=$('snap-status'),constraintHint=constraintMode()&&constraintTool()&&$('snap').checked?(draft.length?'从上一点捕捉'+snapLabels[$('snap-mode').value]+' · 移近落点 · Alt 临时关闭':'先选起点；下一点捕捉'+snapLabels[$('snap-mode').value]):$('snap-mode').value==='intersection'&&$('snap').checked?'捕捉有限线条的原生交点 · Alt 自由落点':'';
  snapStatus.hidden=Boolean(constructionPreview)||!snapFailure&&!snapMatch&&!constraintHint;snapStatus.classList.toggle('warning',Boolean(snapFailure));
  const snapText=snapFailure?'吸附未完成：'+snapFailure+'。可按 Alt 临时关闭。':snapMatch?snapLabels[snapMatch.kind]+' · '+(snapMatch.contributors?snapMatch.contributors.map(c=>c.entityName||'线条').join(' × '):snapMatch.entityName||'线条')+(snapMatch.spanSide&&snapMatch.spanSide!=='interior'?' · 该边单侧方向':'')+'（Alt 临时关闭）':constraintHint;if(snapStatus.textContent!==snapText)snapStatus.textContent=snapText;
  if(snapMatch&&usesSnap()&&!constructionPreview){
    const s=screen(snapMatch.point),g=node('g',{'data-snap-kind':snapMatch.kind,'data-snap-entity':snapMatch.entityId,'data-snap-x':snapMatch.point.x,'data-snap-y':snapMatch.point.y,'pointer-events':'none'},overlay);
    node('circle',{cx:s.x,cy:s.y,r:5.5,fill:'none',stroke:darkCanvas?'#f6cf7d':'#9b641b','stroke-width':2},g);
    node('path',{d:'M '+(s.x-9)+' '+s.y+' H '+(s.x+9)+' M '+s.x+' '+(s.y-9)+' V '+(s.y+9),stroke:darkCanvas?'#f6cf7d':'#9b641b','stroke-width':1},g);
    if(snapMatch.tangent){const tx=snapMatch.tangent.x*24,ty=-snapMatch.tangent.y*24;node('path',{d:'M '+(s.x-tx)+' '+(s.y-ty)+' L '+(s.x+tx)+' '+(s.y+ty),stroke:darkCanvas?'#f6cf7d':'#9b641b','stroke-width':1.5,'stroke-dasharray':'3 3'},g);}
  }
  if(constructionPreview){const s=screen(constructionPreview);node('circle',{cx:s.x,cy:s.y,r:7,fill:'none',stroke:'#277aa0','stroke-width':2,'data-construction-preview':'point','data-construction-x':constructionPreview.x,'data-construction-y':constructionPreview.y},overlay);}
  const step = 10 ** Math.floor(Math.log10(40 / camera.scale));
  const gridSize = step * camera.scale;
  $('minor-grid').setAttribute('width', gridSize); $('minor-grid').setAttribute('height', gridSize);
  $('minor-grid').setAttribute('x', camera.x % gridSize); $('minor-grid').setAttribute('y', camera.y % gridSize);
  $('minor-grid').firstElementChild.setAttribute('d', 'M ' + gridSize + ' 0 L 0 0 0 ' + gridSize);
  $('grid-bg').style.display = $('grid').checked ? '' : 'none';
  $('canvas-bg').setAttribute('fill', darkCanvas ? '#252a2b' : '#f6f7f3');
  captureRecovery();
  $('minor-grid').firstElementChild.setAttribute('stroke', darkCanvas ? '#4b5552' : '#dce1dc');
  $('workspace').classList.toggle('dark-canvas', darkCanvas);
  $('theme').textContent = darkCanvas ? '浅色画布' : '深色画布';
  $('zoom').textContent = Math.round(camera.scale * 100) + '%';
  $('welcome').hidden = project.entities.length > 0 || draft.length > 0;
}
function refresh() {
  $('prj-writeback-open').hidden=!project.metadata?.format?.startsWith('ET');
  prjEndpointPanel.refresh();
  snapIndex=null;snapMatch=null;snapFailure=null;
  syncAllowances(project,()=>crypto.randomUUID());
  syncNotches(project,()=>crypto.randomUUID());
  syncSeamChecks(project);
  syncGradingPlans(project);
  syncMarkerPlans(project);
  refreshSeamPanel();
  refreshNotchPanel();
  matchPanel.refresh();
  gradingPanel.refresh();
  markerPanel.refresh();
  plotPanel.refresh();
  lineEditPanel.refresh();
  trimPanel.refresh();
  extendPanel.refresh();
  positionPanel.refresh();
  spreadPanel.refresh();
  dartPanel.refresh();
  unfoldPanel.refresh();
  pieceSplitPanel.refresh();
  pieceMergePanel.refresh();
  render(); $('document-name').textContent = project.name; $('dirty').textContent = dirty ? '•' : '';
  $('undo').disabled = !undoStack.length; $('redo').disabled = !redoStack.length;
  $('entity-count').textContent = project.entities.length + ' 条';
  $('unit-label').textContent = '1∶1 几何 · ' + unit();
  $('cursor').textContent = 'X ' + pointer.x.toFixed(2) + '　Y ' + pointer.y.toFixed(2) + ' ' + unit();
  const warnings = project.warnings || [];
  $('import-status').classList.toggle('warning', warnings.length > 0);
  $('import-status').textContent = project.metadata?.format?.startsWith('ET')
    ? 'ET PRJ 实验导入 · ' + project.entities.filter(entity => entity.type !== 'text').length + ' 条线 / ' + project.entities.filter(entity => entity.type === 'text').length + ' 项文字 · ' + unit()
    : project.entities.length + ' 个图元 · ' + unit();
  if(project.metadata?.format==='DXF'){const report=project.metadata.dxfImport;$('import-status').textContent='DXF · '+project.entities.length+' 个图元 · '+unit()+(report?.skippedCount?' · 部分导入，跳过 '+report.skippedCount+' 项':'');}
  const invalidSeams=(project.seamAllowances||[]).filter(recipe=>recipe.status!=='current');
  if(invalidSeams.length){$('import-status').textContent+=' · '+invalidSeams.length+' 组缝份需修复';$('import-status').classList.add('warning');}
  const invalidNotches=(project.notches||[]).filter(recipe=>recipe.status!=='current');
  if(invalidNotches.length){$('import-status').textContent+=' · '+invalidNotches.length+' 组刀口需修复';$('import-status').classList.add('warning');}
  const pendingChecks=(project.seamChecks||[]).filter(check=>check.status!=='current'||check.result?.status!=='match');
  if(pendingChecks.length){$('import-status').textContent+=' · '+pendingChecks.length+' 组缝合需核对';$('import-status').classList.add('warning');}
  const pendingGrades=(project.gradingPlans||[]).filter(plan=>plan.status!=='current');
  if(pendingGrades.length){$('import-status').textContent+=' · '+pendingGrades.length+' 组放码需核对';$('import-status').classList.add('warning');}
  const pendingMarkers=(project.markerPlans||[]).filter(plan=>plan.status!=='current');
  if(pendingMarkers.length){$('import-status').textContent+=' · '+pendingMarkers.length+' 组排料需核对';$('import-status').classList.add('warning');}
  $('report').hidden = !warnings.length;
  $('report-content').textContent = warnings.join('\n\n') + (project.metadata ? '\n\n款式：' + (project.metadata.style || '—') + '\n基码：' + (project.metadata.baseSize || '—') : '');
  $('calibration').hidden = project.units === 'mm';
  $('check-unit').textContent = unit();
  $('inspect-all').disabled = !project.entities.length;
  refreshReference();
  refreshControlEditor();
  refreshInspection();
  $('precise-rect').disabled = project.units !== 'mm'; $('export').disabled = !project.entities.length;
  const query = $('filter').value.toLowerCase();
  const list = $('entity-list'); list.replaceChildren();
  const filtered = project.entities.filter(entity => (entity.name + ' ' + entity.layer).toLowerCase().includes(query));
  for (const entity of filtered.slice(0, 600)) {
    const button = document.createElement('button');
    button.className = 'entity-item' + (selected.has(entity.id) ? ' selected' : '');
    const label = document.createElement('span'); label.textContent = entity.name;
    const small = document.createElement('small'); small.textContent = entity.type === 'text' ? '文字' : entity.curve ? entity.curve.degree + ' 次样条' : entity.closed ? '闭合' : entity.points.length + ' 点';
    button.append(label, small); button.onclick = event => { selectEntity(entity, event); refresh(); }; list.append(button);
  }
  if (filtered.length > 600) {
    const note = document.createElement('p'); note.textContent = '显示前 600 条，请搜索筛选其余图元。'; list.append(note);
  }
  const entity = selectedEntity(), activeGroup = selectedGroup();
  $('no-selection').hidden = selected.size > 0; $('selected-properties').hidden = selected.size === 0;
  $('single-properties').hidden = !entity; $('source-details').hidden = !entity?.source;
  $('selection-status').textContent = selected.size ? (activeGroup ? activeGroup.name + ' · ' : '') + '已选 ' + selected.size + ' 项' : '就绪';
  $('group').disabled = selected.size < 2 || Boolean(activeGroup);
  $('ungroup').disabled = !(project.groups || []).some(group => group.entityIds.some(id => selected.has(id)));
  $('rename-group').disabled = !activeGroup;
  $('group-name').value = activeGroup?.name || '';
  $('group-source').hidden = !activeGroup?.source?.offset;
  if (activeGroup?.source?.offset) {
    const source = activeGroup.source;
    $('group-source-content').textContent = '裁片记录偏移：' + source.offset +
      '\n原面料：' + (source.material || '—') + '\n原基码：' + (source.size || '—') +
      '\n引用表直接关联 ' + (source.curveIds?.length ?? 0) + ' 条曲线、' + (source.textIds?.length ?? 0) + ' 项文字。' +
      (source.membershipModified ? '\n当前组合成员已修改。' : '') +
      (source.duplicated ? '\n当前组合为复制件，来源指向原始裁片。' : '');
  }
  if (selected.size) {
    const box = selectionBounds(project, selected);
    const totalLength = selectedEntities().reduce((sum, entity) => sum + length(entity), 0);
    $('dimensions').textContent = '已选 ' + selected.size + ' 项 · 宽 ' + box.width.toFixed(2) + ' × 高 ' + box.height.toFixed(2) + ' ' + unit() + ' · 总线长 ' + totalLength.toFixed(2) + ' ' + unit();
    if (selectedEntities().some(entity=>entity.curve)) $('dimensions').textContent += '（样条按弧长积分）';
  }
  const groupList = $('group-list'); groupList.replaceChildren();
  $('group-count').textContent = (project.groups || []).length + ' 组';
  for (const group of project.groups || []) {
    const button = document.createElement('button');
    button.className = 'entity-item' + (group.entityIds.every(id => selected.has(id)) ? ' selected' : '');
    const title = document.createElement('span'); title.textContent = group.name;
    const count = document.createElement('small'); count.textContent = group.entityIds.length + ' 项';
    button.append(title, count); button.dataset.groupId = group.id;
    button.onclick = event => {
      if (!event.shiftKey) selected = new Set(group.entityIds);
      else {
        const remove = group.entityIds.every(id => selected.has(id));
        for (const id of group.entityIds) remove ? selected.delete(id) : selected.add(id);
      }
      refresh();
    };
    button.ondblclick = () => fit(selectedEntities());
    groupList.append(button);
  }
  if (entity) {
    $('entity-name').value = entity.name;
    const select = $('entity-layer');
    for (const option of [...select.options]) if (option.dataset.custom) option.remove();
    if (![...select.options].some(option => option.value === entity.layer)) {
      const option = new Option(entity.layer, entity.layer); option.dataset.custom = 'true'; select.add(option);
    }
    select.value = entity.layer;
    $('text-properties').hidden = entity.type !== 'text';
    if (entity.type === 'text') { $('text-content').value = entity.text; $('text-height').value = entity.height; }
    $('source-details').hidden = !entity.source;
    if (entity.source) {
      const source = entity.source;
      $('source-content').textContent = '源文件：' + (project.metadata?.sourceFile || '—') +
        '\n记录偏移：' + (source.offset ?? '—') +
        (source.textOffset !== undefined ? '\n文字偏移：' + source.textOffset : '') +
        (source.originalText !== undefined ? '\n原文：' + source.originalText : '') +
        (Number.isFinite(source.spline?.maxFitError) ? '\n源记录拟合残差：' + source.spline.maxFitError.toFixed(6) + ' 原始单位（非当前编辑误差）' : '') +
        (source.spline?.normalization ? '\n重复端点样条：已去除 '+(source.spline.normalization.removedStart+source.spline.normalization.removedEnd)+' 个不参与曲线的端部控制项，原记录完整保留。' : '') +
        (Array.isArray(source.color) ? '\n原始 RGB：' + source.color.join(', ') : '') +
        '\n' + (source.modified ? '当前图元已编辑，源记录保留用于核对。' : '从源文件记录读取。');
      if(source.kind==='dxf')$('source-content').textContent='DXF 原始类型：'+source.entityType+'\n句柄：'+(source.handle||'—')+'\n原始单位编号：'+source.unitCode+'\n毫米换算系数：'+(source.scaleToMillimeters??'未确认')+(source.convertedToClamped?'\n非夹持样条已转换为精确夹持跨度。':'')+(source.modified?'\n当前图元已编辑。':'');
    }

  }
}
function refreshReference() {
  const entity = selectedEntity();
  if (referenceEntityId !== entity?.id) { $('known-length').value = ''; referenceEntityId = entity?.id; }
  $('reference-calibration').hidden = !entity || entity.type === 'text';
  if (!entity || entity.type === 'text') return;
  $('reference-mode').options[0].textContent = entity.curve ? '沿线总长（弧长积分）' : '沿线总长（折线）';
  try {
    const measured = referenceLength(entity, $('reference-mode').value);
    const known = Number($('known-length').value);
    $('reference-preview').textContent = '当前基准：' + measured.toFixed(6) + ' ' + unit() +
      (Number.isFinite(known) && known > 0 ? '\n换算系数：× ' + (known / measured).toPrecision(8) : '\n请输入在 ET 中核对的毫米长度。');
    $('calibrate-reference').disabled = !Number.isFinite(known) || known <= 0;
  } catch (error) {
    $('reference-preview').textContent = error.message; $('calibrate-reference').disabled = true;
  }
}
function invalidateInspection() { inspection = null; focusedInspection = null; focusedInspectionIssue=null; seamPreview=null; notchPreview=null; }
function refreshInspection() {
  const container = $('inspection-results'); container.replaceChildren();
  $('inspection-details').hidden=true;$('inspection-issues').replaceChildren();$('inspection-zoom').replaceChildren();$('inspection-zoom').setAttribute('hidden','');$('inspection-focus-status').textContent='';
  $('export-inspection').disabled = !inspection;
  if (!inspection) {
    $('inspection-summary').textContent = '检查端点间隙、原始线段与原生曲线。编辑后需重新检查。';
    return;
  }
  const counts = status => inspection.results.filter(result => result.status === status).length;
  $('inspection-summary').textContent = inspection.results.length + ' 条轮廓 · ' + counts('within-tolerance') + ' 条检查通过 · ' + counts('issues') + ' 条有已证问题 · '+counts('needs-review')+' 条需核对 · ' + counts('unverified') + ' 条待定义。' +
    (inspection.units !== 'mm' ? '单位未确认，当前容差按原始单位计算。' : '') +
    (inspection.additionalChains ? '另有 ' + inspection.additionalChains + ' 条额外链未检查。' : '') +
    '曲线证明未完成不等于已证实自交；不检查服装尺寸或缝份语义。';
  inspection.results.forEach((result, index) => {
    const button = document.createElement('button'); button.className = 'inspection-item ' + result.status;
    button.dataset.inspectionIndex = index;
    const title = document.createElement('strong'); title.textContent = result.name;
    const detail = document.createElement('span');
    detail.textContent = Number.isFinite(result.maxGap)
      ? (Number.isFinite(result.nativeLength)?'原生沿线长 '+result.nativeLength.toFixed(3):'显示折线长 '+result.curveLength.toFixed(3)) + ' · 最大间隙 ' + result.maxGap.toFixed(6) + ' ' + unit() + (result.issues.length ? '\n' + [...new Set(result.issues.map(issue => issue.message))].join('、') : '\n'+(result.native?.message||'本次检查未发现问题'))
      : result.issues.map(issue => issue.message).join('、');
    button.append(title, detail);
    button.onclick = () => {
      focusedInspection = index;focusedInspectionIssue=null;
      const group = project.groups.find(group => group.id === result.groupId);
      selected = new Set(group?.entityIds || result.entityIds);
      refresh(); fit(selectedEntities());
    };
    container.append(button);
  });
  const result=inspection.results[focusedInspection];if(!result)return;
  $('inspection-details').hidden=false;
  const connections=result.native?.connections||[];
  $('inspection-note').textContent=connections.length?'原始几何仍有 '+connections.length+' 处非零连接间隙；'+(result.native?.usesVirtualConnections&&result.native.status!=='not-checked'?'本次闭合检查临时用直线连接，未移动源点。':'未完成闭合证明。'):'选取问题以定位相关线条；局部视图仅放大显示，不改变尺寸。';
  result.issues.forEach((issue,index)=>{
    const button=document.createElement('button');button.className='inspection-issue '+(issue.severity==='review'?'review':'error');button.dataset.inspectionIssue=index;
    const references=(issue.highlights||[]).flatMap(h=>h.reference?[h.reference]:h.connectionReferences||[]),names=[...new Set(references.map(r=>(r.entityName||project.entities.find(e=>e.id===r.entityId)?.name||r.entityId)+(Number.isInteger(r.spanIndex)?' · 原生段 '+(r.spanIndex+1):Number.isInteger(r.segmentIndex)?' · 线段 '+(r.segmentIndex+1):'')+(r.reversed?'（反向）':'')))];
    button.textContent=(issue.severity==='review'?'需核对 · ':'已证问题 · ')+issue.message+(names.length?'\n'+names.join(' / '):'');button.setAttribute('aria-pressed',String(focusedInspectionIssue===index));
    button.onclick=()=>{focusedInspectionIssue=index;selected=new Set(issue.entityIds?.length?issue.entityIds:issue.entityId?[issue.entityId]:result.entityIds);refresh();const points=(issue.highlights||[]).flatMap(h=>h.controls).concat([issue.point,issue.start,issue.end].filter(Boolean));fit(points.length?[{type:'polyline',points}]:selectedEntities());};$('inspection-issues').append(button);
  });
  const issue=result.issues[focusedInspectionIssue];if(!issue)return;
  const shapes=(issue.highlights||[]).map(h=>({points:h.controls,virtual:h.virtualConnection}));if(!shapes.length&&issue.start&&issue.end)shapes.push({points:[issue.start,issue.end],virtual:issue.kind==='gap'});
  const all=shapes.flatMap(s=>s.points);if(!all.length)return;
  const minX=Math.min(...all.map(p=>p.x)),maxX=Math.max(...all.map(p=>p.x)),minY=Math.min(...all.map(p=>p.y)),maxY=Math.max(...all.map(p=>p.y)),width=maxX-minX,height=maxY-minY,extent=Math.max(width,height)||1,scale=Math.min(216/(width/extent||1),126/(height/extent||1)),projectPoint=p=>({x:120+((p.x-minX)/extent-width/extent/2)*scale,y:75-((p.y-minY)/extent-height/extent/2)*scale}),mini=$('inspection-zoom');mini.removeAttribute('hidden');
  shapes.forEach((shape,i)=>{const p=shape.points.map(projectPoint),color=i%2?'#8e69b0':'#cb7c31';node('path',{d:'M '+p[0].x+' '+p[0].y+' '+(p.length===2?'L':p.length===3?'Q':'C')+' '+p.slice(1).map(q=>q.x+' '+q.y).join(' '),stroke:color,'stroke-width':2,fill:'none','stroke-dasharray':shape.virtual?'5 3':'none'},mini);for(const point of [p[0],p.at(-1)])node('circle',{cx:point.x,cy:point.y,r:2.5,fill:color},mini);});
  const dimension=n=>n===0?'0':Math.abs(n)<.0001?n.toExponential(3):Number(n.toPrecision(6)).toString();
  $('inspection-focus-status').textContent='局部放大 · 范围 '+dimension(width)+' × '+dimension(height)+' '+unit()+'。'+(shapes.some(s=>s.virtual)?'虚线为临时连接。':'');
}
function selectedSeamBase(){return seamChoices.find(base=>base.key===$('seam-base').value);}
function selectedSeamRecipe(){const base=selectedSeamBase();return base&&(project.seamAllowances||[]).find(recipe=>recipe.id===base.recipeId||JSON.stringify(recipe.baseEntityIds)===JSON.stringify(base.entityIds));}
function refreshSeamPanel(){
  seamChoices=seamBases(project,selected);
  const previous=$('seam-base').value;
  $('seam-base').replaceChildren(...seamChoices.map(base=>new Option(base.name,base.key)));
  if(seamChoices.some(base=>base.key===previous))$('seam-base').value=previous;
  const key=JSON.stringify([...selected].sort())+'|'+$('seam-base').value;
  const recipe=selectedSeamRecipe();
  if(key!==seamChoiceKey){
    seamPreview=null;seamChoiceKey=key;
    if(recipe){$('seam-width').value=recipe.widthMode==='edges'?recipe.edgeWidths[0].width:Math.abs(recipe.distance);$('seam-direction').value=recipe.distance<0?'in':'out';$('seam-join').value=recipe.join;$('seam-miter').value=recipe.miterLimit;$('seam-gap').value=recipe.gapTolerance;}
    $('seam-width-mode').value=recipe?.widthMode||'uniform';
    seamWidthsDraft=new Map((recipe?.edgeWidths||[]).map(entry=>[edgeKey(entry.entityId,entry.segmentIndex),String(entry.width)]));seamRowsKey='';seamEdgeFocus=null;
  }
  refreshSeamEdges();
  $('seam-controls').hidden=!seamChoices.length;
  $('seam-hint').textContent=!seamChoices.length?'选择有轮廓定义的裁片或闭合图元。':project.units!=='mm'?'先校准毫米单位，再预览缝份。':'选择基准并预览，确认后应用。';
  $('preview-seam').disabled=project.units!=='mm';$('apply-seam').disabled=!seamPreview;$('fit-seam').disabled=!seamPreview;
  $('apply-seam').textContent=recipe?'更新缝份':'应用缝份';$('detach-seam').hidden=!recipe;
  if(!seamPreview)$('seam-status').textContent=recipe?(recipe.status==='current'?'已关联 · '+recipe.outputIds.length+' 条输出线 · '+(recipe.widthMode==='edges'?'逐边宽度':Math.abs(recipe.distance)+' mm'):('重算失败：'+recipe.error)):'尚未生成预览。';
}
function refreshSeamEdges(){
  const base=selectedSeamBase(),enabled=$('seam-width-mode').value==='edges';
  $('seam-edge-controls').hidden=!enabled;
  $('seam-width').min=enabled?'0':'.001';
  try{seamEdgeDefs=base?seamEdgeDefinitions(project,base.entityIds):[];}
  catch(error){seamEdgeDefs=[];$('seam-edge-note').textContent=error.message;}
  const key=JSON.stringify(seamEdgeDefs.map(edge=>[edge.key,edge.segmentCount]));
  if(key!==seamRowsKey){
    seamRowsKey=key;$('seam-edge-list').replaceChildren();
    seamEdgeDefs.forEach((edge,index)=>{
      if(!seamWidthsDraft.has(edge.key))seamWidthsDraft.set(edge.key,$('seam-width').value);
      const row=document.createElement('div');row.className='seam-edge-row';row.dataset.edgeKey=edge.key;
      const button=document.createElement('button');button.type='button';button.textContent=(index+1)+' · '+edge.name;button.title=edge.name;
      const input=document.createElement('input');input.type='number';input.min='0';input.max='1000000';input.step='.5';input.value=seamWidthsDraft.get(edge.key);input.setAttribute('aria-label','第 '+(index+1)+' 边缝份 mm');input.dataset.edgeKey=edge.key;
      const focus=()=>{seamEdgeFocus=edge.key;highlightSeamRow();render();};
      button.onclick=focus;input.onfocus=focus;input.oninput=()=>{seamWidthsDraft.set(edge.key,input.value);seamPreview=null;refreshSeamPanel();render();};
      row.append(button,input);$('seam-edge-list').append(row);
    });
  }
  if(seamEdgeDefs.length)$('seam-edge-note').textContent='共 '+seamEdgeDefs.length+' 边 · 0 表示此边不加缝份。曲线按整条基准设置；闭合折线按原始边设置。';
  highlightSeamRow();
}
function highlightSeamRow(){for(const row of $('seam-edge-list').children)row.classList.toggle('focused',row.dataset.edgeKey===seamEdgeFocus);}
function seamOptions(){
  const widthMode=$('seam-width-mode').value;
  const edgeWidths=widthMode==='edges'?seamEdgeDefs.map(edge=>{
    const raw=seamWidthsDraft.get(edge.key),width=Number(raw);if(!raw?.trim()||!Number.isFinite(width)||width<0||width>1e6)throw new Error('请输入有效的逐边宽度（0 至 1000000 mm）');
    return {entityId:edge.entityId,segmentIndex:edge.segmentIndex,segmentCount:edge.segmentCount,width};
  }):null;
  return {distance:(widthMode==='edges'?1:number('seam-width'))*($('seam-direction').value==='in'?-1:1),join:$('seam-join').value,miterLimit:number('seam-miter'),gapTolerance:number('seam-gap'),widthMode,edgeWidths};
}
function selectedNotchRecipe(){return (project.notches||[]).find(recipe=>recipe.id===$('notch-edit').value);}
function loadNotchSettings(recipe){
  for(const field of ['mode','position','side','count','spacing','depth','shape','width'])$('notch-'+field).value=recipe[field];
  $('notch-target').value=recipe.targetSeamId||'';
}
function refreshNotchPanel(){
  const bases=new Map(selectedEntities().filter(entity=>entity.type!=='text'&&!entity.derivedFrom&&!entity.notchFrom&&entity.layer!=='grain').map(entity=>[entity.id,entity.name]));
  for(const recipe of project.notches||[])if(recipe.outputIds.some(id=>selected.has(id)))bases.set(recipe.baseEntityId,project.entities.find(entity=>entity.id===recipe.baseEntityId)?.name||'基准线缺失');
  const oldBase=$('notch-base').value,selectionKey=JSON.stringify([...selected].sort());
  $('notch-base').replaceChildren(...[...bases].map(([id,name])=>new Option(name,id)));
  if(bases.has(oldBase))$('notch-base').value=oldBase;
  const baseId=$('notch-base').value,key=selectionKey+'|'+baseId,changed=key!==notchSelectionKey;
  const oldRecipe=$('notch-edit').value,recipes=(project.notches||[]).filter(recipe=>recipe.baseEntityId===baseId);
  $('notch-edit').replaceChildren(new Option('新建刀口',''),...recipes.map((recipe,i)=>new Option('刀口组 '+(i+1)+' · '+recipe.count+' 个',recipe.id)));
  if(!changed&&recipes.some(recipe=>recipe.id===oldRecipe))$('notch-edit').value=oldRecipe;
  if(changed){
    notchPreview=null;notchSelectionKey=key;
    const only=recipes.find(recipe=>selected.size&&[...selected].every(id=>recipe.outputIds.includes(id)));
    if(only)$('notch-edit').value=only.id;
  }
  const recipe=selectedNotchRecipe(),oldTarget=$('notch-target').value;
  const targets=(project.seamAllowances||[]).filter(item=>item.baseEntityIds.includes(baseId));
  $('notch-target').replaceChildren(new Option('基准线上',''),...targets.map(item=>new Option('投影到 '+item.name,item.id)));
  if(recipe?.targetSeamId&&!targets.some(item=>item.id===recipe.targetSeamId))$('notch-target').add(new Option('原目标缝份已缺失',recipe.targetSeamId));
  if([...$('notch-target').options].some(item=>item.value===oldTarget))$('notch-target').value=oldTarget;
  if(changed&&recipe)loadNotchSettings(recipe);
  if(baseId!==notchBaseKey&&!recipe){$('notch-target').value='';notchBaseKey=baseId;}
  $('notch-controls').hidden=!bases.size;
  $('notch-hint').textContent=!bases.size?'选择基准线或裁片，也可用刀口工具单击基准线。':project.units!=='mm'?'先校准毫米单位，再定位刀口。':'蓝色箭头沿起点→终点；左右侧始终以此方向为准。';
  $('notch-position-label').textContent=$('notch-mode').value==='ratio'?'沿线位置 %':'距所选端点 mm';
  $('notch-spacing').disabled=$('notch-count').value==='1';$('notch-width').disabled=$('notch-shape').value==='line';
  $('preview-notch').disabled=project.units!=='mm';$('apply-notch').disabled=!notchPreview;$('fit-notch').disabled=!notchPreview;
  $('apply-notch').textContent=recipe?'更新刀口':'添加关联刀口';$('detach-notch').hidden=!recipe;
  if(!notchPreview)$('notch-status').textContent=recipe?(recipe.status==='current'?'已关联 · 基准长 '+recipe.baseLength.toFixed(3)+' mm':'重算失败：'+recipe.error):'设置位置后预览。多刀口以输入位置为中心，间距沿基准弧长量取。';
}
function notchOptions(){return {mode:$('notch-mode').value,position:number('notch-position'),side:number('notch-side'),count:number('notch-count'),spacing:number('notch-spacing'),depth:number('notch-depth'),shape:$('notch-shape').value,width:number('notch-width'),targetSeamId:$('notch-target').value||null};}
function refreshControlEditor() {
  const entity=selectedEntity();
  $('control-editor').hidden=!entity||entity.type==='text'||Boolean(entity.derivedFrom||entity.notchFrom);
  if(!entity||entity.type==='text'||entity.derivedFrom||entity.notchFrom)return;
  const points=entity.curve?.controlPoints||entity.points;
  if(controlEntityId!==entity.id){controlEntityId=entity.id;controlIndex=0;}
  controlIndex=Math.min(controlIndex,points.length-1);
  $('control-title').textContent=entity.curve?'曲线控制点':'折线节点坐标';
  $('control-index').max=points.length;$('control-index').value=controlIndex+1;
  $('control-x').value=points[controlIndex].x;$('control-y').value=points[controlIndex].y;
  if(entity.curve){
    const result=curveLength(entity.curve);
    $('curve-info').textContent=entity.curve.degree+' 次样条 · '+points.length+' 个控制点\n弧长 '+result.value.toFixed(6)+' '+unit()+' · 积分误差估计 '+result.estimatedError.toExponential(2)+(result.converged?'':' · 尚未收敛')+'\n显示容差 '+(entity.curve.samplingTolerance??.002)+' '+unit()+(entity.curveSamplingCapped?' · 采样已达上限':'');
  }else $('curve-info').textContent=points.length+' 个折线节点 · '+unit();
}
function fit(entities = project.entities) {
  snapMatch=null;snapFailure=null;
  if(tool==='marker'&&(!Array.isArray(entities)||entities===project.entities))entities=markerPanel.frame();
  if(tool==='plot'&&(!Array.isArray(entities)||entities===project.entities))entities=plotPanel.frame();
  const candidates=(Array.isArray(entities)?entities:project.entities).map(entity=>tool==='node'&&selected.has(entity.id)&&entity.curve?{...entity,points:entity.curve.controlPoints}:entity);
  const box = bounds(candidates); if (!box) return;
  camera.scale = Math.max(.001, Math.min((svg.clientWidth - 100) / Math.max(box.width, 1), (svg.clientHeight - 100) / Math.max(box.height, 1), 20));
  camera.x = svg.clientWidth / 2 - (box.minX + box.maxX) / 2 * camera.scale;
  camera.y = svg.clientHeight / 2 + (box.minY + box.maxY) / 2 * camera.scale; render();
}
function zoom(factor, center = { x: svg.clientWidth / 2, y: svg.clientHeight / 2 }) {
  snapMatch=null;snapFailure=null;
  const scale = Math.max(.001, Math.min(200, camera.scale * factor)), ratio = scale / camera.scale;
  camera.x = center.x - (center.x - camera.x) * ratio; camera.y = center.y - (center.y - camera.y) * ratio;
  camera.scale = scale; render();
}
const hints = {
  select: '单击整组选取 · Shift 多选 · 空白处拖动框选 · 空格平移',
  node: '先选择图元，再拖动圆点 · 样条显示控制多边形，可在属性输入坐标',
  line: '依次单击起点、终点 · Esc 取消',
  polyline: '连续单击添加节点 · Enter 完成 · 单击起点闭合',
  curve: '依次单击起点、控制点、终点 · 创建可编辑的二次曲线',
  rectangle: '单击两个对角点绘制矩形',
  measure: '依次单击两点测量直线距离',
  grain: '单击起点和终点绘制布纹方向线',
  notch: '单击选择基准线，再在右侧设置刀口位置、深度和方向',
  seam: '先选裁片 · 逐边模式下单击基准边，在右侧输入该边宽度',
  match: '选择拾取 A 或 B · 按顺序单击原始缝合边 · 面板中可反向与移除',
  grading: '先选择基码裁片建立方案 · 点击基准线或控制点设置各尺码位移',
  marker: '拖动裁片调整位置 · 红色需修复 · 面板中保存方案，再保存工程文件',
  plot: '打印预览 · 滚轮缩放 / 空格平移 · 100% 实际大小打印，先量校准方框',
  'line-edit': '剪开：单击一条原线 · 连接：按顺序点选多条线 · 预览后应用',
  trim: '记录目标与切割参考线 · 分析交点 · 点选区间或使用列表 · 预览后应用',
  extend: '记录开放目标与参考线 · 选择起点或终点 · 设置延伸方式与最大长度 · 预览后应用',
  position: '选择定位方式 · 在面板拾取基准点或输入坐标 · 预览后应用',
  spread: '记录裁片轮廓 · 拾取 A 支点与 B 展开口 · 选择展开侧 · 预览后应用',
  dart: '记录轮廓 · 确认原省口 · 拾取新位置 · 预览闭省与新省口后应用',
  unfold: '记录半片轮廓 · 确认直线折边 · 预览完整片 · 应用',
  split: '记录裁片轮廓 · 拾取切点 A、B · 预览两片 · 应用后可分别移动',
  merge: '分别记录两片 · 选择等长直线接边 · 预览第二片对齐位置 · 应用'
};
function setTool(value) {
  if(tool==='marker'&&value!=='marker')markerPanel.end(true);
  tool = value; draft = [];snapMatch=null;snapFailure=null;
  constructionInput.reset();
  for(const option of $('snap-mode').options)if(['perpendicular','tangent'].includes(option.value))option.disabled=!constraintTool();
  if(constraintMode()&&!constraintTool())$('snap-mode').value='endpoint';
  document.querySelectorAll('[data-tool]').forEach(el => el.classList.toggle('active', el.dataset.tool === tool));
  $('seam-tool').classList.toggle('active',tool==='seam');
  $('match-tool').classList.toggle('active',tool==='match');
  $('grading-tool').classList.toggle('active',tool==='grading');
  $('marker-tool').classList.toggle('active',tool==='marker');
  $('plot-tool').classList.toggle('active',tool==='plot');
  $('line-edit-tool').classList.toggle('active',tool==='line-edit');
  $('trim-tool').classList.toggle('active',tool==='trim');
  $('extend-tool').classList.toggle('active',tool==='extend');
  $('position-tool').classList.toggle('active',tool==='position');
  $('spread-tool').classList.toggle('active',tool==='spread');
  $('dart-tool').classList.toggle('active',tool==='dart');
  $('unfold-tool').classList.toggle('active',tool==='unfold');
  $('split-tool').classList.toggle('active',tool==='split');
  $('merge-tool').classList.toggle('active',tool==='merge');
  $('tool-hint').textContent = hints[tool];
  svg.style.cursor = ['select','node'].includes(tool) ? 'default' : 'crosshair'; render();constructionInput.reveal();
  if(tool==='notch'){refreshNotchPanel();$('notch-panel').scrollIntoView({block:'center'});}
}
document.querySelectorAll('[data-tool]').forEach(button => button.onclick = () => setTool(button.dataset.tool));
svg.addEventListener('pointerdown', event => {
  if (event.button !== 0 && event.button !== 1) return;
  event.preventDefault(); svg.focus(); svg.setPointerCapture(event.pointerId);
  const p = world(event); pointer = snap(p,{bypass:event.altKey||space||event.button===1});
  if(snapFailure){notify('吸附未完成，未记录此点。请放大、切换模式或按 Alt 临时关闭。');render();return;}
  if (space || event.button === 1) {
    gesture = { type: 'pan', start: { x: event.clientX, y: event.clientY }, camera: { ...camera } }; return;
  }
  if(tool==='marker'){markerPanel.down(p);return;}
  if(tool==='plot')return;
  if(tool==='position'){positionPanel.pick(pointer);return;}
  if(tool==='spread'){spreadPanel.pick(p,10/camera.scale);return;}
  if(tool==='dart'){dartPanel.pick(p,10/camera.scale);return;}
  if(tool==='unfold'){unfoldPanel.pick(p,10/camera.scale);return;}
  if(tool==='split'){pieceSplitPanel.pick(p,10/camera.scale);return;}
  if(tool==='merge'){pieceMergePanel.pick(p,10/camera.scale);return;}
  if(tool==='line-edit'){const target=hit(p);if(target)lineEditPanel.pick(target.entity);else notify('请点选原始线条');return;}
  if(tool==='trim'){trimPanel.pick(hit(p)?.entity,p,8/camera.scale);return;}
  if(tool==='extend'){extendPanel.pick(hit(p)?.entity,p,8/camera.scale);return;}
  if (tool === 'node' && selectedEntity()?.type !== 'text' && selectedEntity()) {
    const entity = selectedEntity();
    const index = (entity.derivedFrom||entity.notchFrom?[]:entity.curve?.controlPoints||entity.points).findIndex(point => distance(point, p) < 8 / camera.scale);
    if (index >= 0) { controlEntityId=entity.id;controlIndex=index;refreshControlEditor();gesture = { type: 'node', index, entity, before: structuredClone(entity), start: p,snapExcludeIds:new Set(project.entities.filter(e=>e.id===entity.id||e.derivedFrom||e.notchFrom).map(e=>e.id)) }; render();return; }
  }
  if (tool === 'select' || tool === 'node') {
    const target = hit(p);
    if (target) {
      selectEntity(target.entity, event, tool === 'select');
      if (tool === 'select' && !event.shiftKey){try{assertIndependentTransform(project,selected);gesture = { type:'move', before:selectedEntities().map(entity=>structuredClone(entity)), start:p };}catch(error){notify(error.message);}}
    } else if (tool === 'select') {
      const base = event.shiftKey ? new Set(selected) : new Set();
      selected = new Set(base);
      gesture = {type:'box',start:p,current:p,base};
    } else selected.clear();
    refresh(); return;
  }
  if (tool === 'notch') {
    const target = hit(p); if (!target || target.entity.type === 'text') { notify('请在已有轮廓上单击'); return; }
    selected=new Set([target.entity.id]);refresh();$('notch-panel').scrollIntoView({block:'center'});return;
  }
  if(tool==='match'){
    const target=hit(p);if(target)matchPanel.pick(target.entity,target.segmentIndex);else notify('请点选原始缝合边');return;
  }
  if(tool==='grading'){gradingPanel.pick(p,camera.scale,hit(p));return;}
  if(tool==='seam'){
    const target=hit(p);if(!target){notify('请单击裁片基准线');return;}
    if(!selectedSeamBase()?.entityIds.includes(target.entity.id)){selectEntity(target.entity,event);refresh();}
    const key=edgeKey(target.entity.id,target.entity.closed&&!target.entity.curve?target.segmentIndex:null);
    if(seamEdgeDefs.some(edge=>edge.key===key)){
      seamEdgeFocus=key;highlightSeamRow();render();
      const input=[...$('seam-edge-list').querySelectorAll('input')].find(item=>item.dataset.edgeKey===key);input?.focus();input?.scrollIntoView({block:'nearest'});
    }else notify('请选取基准边，输出缝份不能作为新基准');
    return;
  }
  if (tool === 'polyline' && draft.length > 2 && ((constraintMode()||$('snap-mode').value==='intersection')&&$('snap').checked&&!event.altKey?pointer.x===draft[0].x&&pointer.y===draft[0].y:distance(pointer, draft[0]) < 10 / camera.scale)) {
    try{finishPolyline(true);}catch(error){notify(error.message);}return;
  }
  constructionInput.reset();try{acceptConstructionPoint(pointer);}catch(error){notify(error.message);render();}
});
svg.addEventListener('pointermove', event => {
  const p = world(event); pointer = snap(p,{bypass:event.altKey||space});
  if(gesture?.type==='node')gesture.snapIncomplete=Boolean(snapFailure);
  $('cursor').textContent = 'X ' + pointer.x.toFixed(2) + '　Y ' + pointer.y.toFixed(2) + ' ' + unit();
  if (gesture?.type === 'pan') {
    camera.x = gesture.camera.x + event.clientX - gesture.start.x;
    camera.y = gesture.camera.y + event.clientY - gesture.start.y;
  } else if(tool==='marker'){markerPanel.move(p);return;}
  else if(tool==='plot')return;
  else if (gesture?.type === 'box') {
    gesture.current = p;
    const visible = project.entities.filter(entity => entity.type !== 'text' || $('show-text').checked);
    let matches = entitiesInBox(visible, gesture.start, p, p.x < gesture.start.x);
    if ($('whole-group').checked) matches = expandGroups(project, matches);
    selected = new Set([...gesture.base, ...matches]);
  } else if (gesture && ['move','node'].includes(gesture.type)) {
    if(gesture.type==='node'&&snapFailure){render();return;}
    if (!gesture.changed && distance(p,gesture.start) * camera.scale > 2) {
      gesture.undoBefore = undoStack.slice(); gesture.redoBefore = redoStack; gesture.dirtyBefore = dirty;
      checkpoint(); gesture.changed = true;
    }
    if (gesture.changed) {
      if (gesture.type === 'move') {
        const originals = new Map(gesture.before.map(entity => [entity.id, entity]));
        for (const entity of selectedEntities()) {
          const original = originals.get(entity.id);
          Object.assign(entity,structuredClone(original));
          transform(entity,point=>({x:point.x+p.x-gesture.start.x,y:point.y+p.y-gesture.start.y}));
        }
      } else {
        if(gesture.entity.curve)editControlPoint(gesture.entity,gesture.index,pointer);
        else gesture.entity.points[gesture.index] = { ...pointer };
        if (gesture.entity.source) gesture.entity.source.modified = true;
      }
    }
  }
  render();
});
function endGesture() { if(gesture?.type==='node'&&gesture.snapIncomplete){cancelGesture();notify('吸附未完成，本次节点拖动已取消。可放大、切换模式或按 Alt 临时关闭。');return;}if(tool==='marker')markerPanel.end();gesture = null; refresh(); }
function cancelGesture() {
  if(tool==='marker')markerPanel.end(true);
  if (gesture?.changed) {
    project = JSON.parse(undoStack.pop()); undoStack = gesture.undoBefore; redoStack = gesture.redoBefore; dirty = gesture.dirtyBefore;
  } else if (gesture?.type === 'box') selected = gesture.base;
  gesture = null; refresh();
}
svg.addEventListener('pointerup', endGesture); svg.addEventListener('pointercancel', cancelGesture);
svg.addEventListener('wheel', event => {
  event.preventDefault(); const r = svg.getBoundingClientRect();
  zoom(Math.exp(-event.deltaY * .0015), {x:event.clientX-r.left,y:event.clientY-r.top});
}, {passive:false});
$('fit').onclick = fit; $('zoom-in').onclick = () => zoom(1.25); $('zoom-out').onclick = () => zoom(.8);
$('grid').onchange = render; $('filter').oninput = refresh;
$('snap').onchange=()=>{if(!$('snap').checked)$('snap-mode').value='off';else if($('snap-mode').value==='off')$('snap-mode').value='endpoint';snapMatch=null;snapFailure=null;if(lastPointerWorld)pointer={...lastPointerWorld};render();};
$('snap-mode').onchange=()=>{$('snap').checked=$('snap-mode').value!=='off';snapMatch=null;snapFailure=null;if(lastPointerWorld)pointer={...lastPointerWorld};render();};
svg.addEventListener('pointerleave',()=>{snapMatch=null;snapFailure=null;render();});
for(const type of ['keydown','keyup'])document.addEventListener(type,event=>{if(event.key==='Alt'&&lastPointerWorld&&!event.target.closest?.('input,textarea,select')){pointer=snap(lastPointerWorld,{bypass:type==='keydown'});if(gesture?.type==='node'&&snapFailure)gesture.snapIncomplete=true;render();}});
$('show-text').onchange = refresh;
$('theme').onclick = () => { darkCanvas = !darkCanvas; render(); };
function undo() {
  if (!undoStack.length) return;
  invalidateInspection();
  redoStack.push(JSON.stringify(project)); project = JSON.parse(undoStack.pop());
  selected = new Set(); dirty = true; draft = []; refresh();
}
function redo() {
  if (!redoStack.length) return;
  invalidateInspection();
  undoStack.push(JSON.stringify(project)); project = JSON.parse(redoStack.pop());
  selected = new Set(); dirty = true; draft = []; refresh();
}
$('undo').onclick = undo; $('redo').onclick = redo;
function editSelected(callback) {
  const entity = selectedEntity(); if (!entity) return;
  checkpoint(); callback(entity); finishEdit();
}
$('entity-name').onchange = () => editSelected(entity => entity.name = $('entity-name').value || '未命名图元');
$('entity-layer').onchange = () => editSelected(entity => entity.layer = $('entity-layer').value);
$('text-content').onchange = action(() => editSelected(entity => {
  const value = $('text-content').value.trim();
  if (!value) { $('text-content').value = entity.text; return; }
  replaceAnnotationText(entity,value);
}));
$('text-height').onchange = action(() => {
  const height = number('text-height');
  if (height <= 0) throw new Error('字高必须大于零');
  editSelected(entity => { entity.width = (entity.width || textWidth(entity.text, entity.height)) * height / entity.height; entity.height = height; if (entity.source) entity.source.modified = true; });
});
function number(id) {
  const raw = $(id).value, value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || Math.abs(value) > 1e6) throw new Error('请输入有效数值');
  return value;
}
function action(callback) { return () => { try { callback(); } catch(error) { notify(error.message); } }; }
function editSelection(operation) {
  if (!selected.size) return;
  checkpoint(); operation(); finishEdit();
}
$('translate').onclick = action(() => {
  assertIndependentTransform(project,selected);
  const dx=number('move-x'),dy=number('move-y');
  editSelection(()=>moveSelection(project,selected,dx,dy));
});
$('rotate').onclick = action(() => {
  assertIndependentTransform(project,selected);
  const angle=number('angle'); editSelection(()=>rotateSelection(project,selected,angle));
});
$('mirror').onclick = action(() => {assertIndependentTransform(project,selected);editSelection(()=>mirrorSelection(project,selected));});
$('duplicate').onclick = () => editSelection(()=>{selected=duplicateSelection(project,selected,()=>crypto.randomUUID());});
function remove() { editSelection(()=>{deleteSelection(project,selected);selected.clear();}); }
$('delete').onclick = remove;
function makeGroup() {
  if (selected.size < 2) { notify('至少选择两个图元'); return; }
  const name = $('group-name').value || '组合 ' + ((project.groups || []).length + 1);
  editSelection(()=>groupSelection(project,selected,name,()=>crypto.randomUUID()));
}
$('group').onclick=makeGroup;
$('ungroup').onclick=()=>editSelection(()=>ungroupSelection(project,selected));
$('rename-group').onclick=()=>{
  const group=selectedGroup(),name=$('group-name').value.trim();
  if(!group||!name)return;
  editSelection(()=>{group.name=name;});
};
$('fit-selected').onclick=()=>fit(selectedEntities());
$('precise-rect').onclick = action(() => {
  const width=number('rect-w'),height=number('rect-h');
  if(width<=0||height<=0)throw new Error('宽和高必须大于零');
  const cx=(svg.clientWidth/2-camera.x)/camera.scale,cy=(camera.y-svg.clientHeight/2)/camera.scale;
  addEntity([{x:cx-width/2,y:cy-height/2},{x:cx+width/2,y:cy-height/2},{x:cx+width/2,y:cy+height/2},{x:cx-width/2,y:cy+height/2}],{closed:true,name:'矩形裁片'});fit();
});
$('calibrate').onclick = action(() => {
  const next = calibratedProject(project, number('unit-scale'));
  checkpoint(); project = next; finishEdit(); fit();
});
$('known-length').oninput = refreshReference;
$('seam-tool').onclick=()=>{setTool('seam');refreshSeamPanel();$('seam-panel').scrollIntoView({block:'center'});};
$('match-tool').onclick=()=>matchPanel.begin();
$('grading-tool').onclick=()=>gradingPanel.begin();
$('marker-tool').onclick=()=>markerPanel.begin();
$('plot-tool').onclick=()=>plotPanel.begin();
$('line-edit-tool').onclick=()=>lineEditPanel.begin();
$('trim-tool').onclick=()=>trimPanel.begin();
$('extend-tool').onclick=()=>extendPanel.begin();
$('position-tool').onclick=()=>positionPanel.begin();
$('spread-tool').onclick=()=>spreadPanel.begin();
$('dart-tool').onclick=()=>dartPanel.begin();
$('unfold-tool').onclick=()=>unfoldPanel.begin();
$('split-tool').onclick=()=>pieceSplitPanel.begin();
$('merge-tool').onclick=()=>pieceMergePanel.begin();
$('merge-demo').onclick=()=>{
  if(!canReplace())return;
  const value=emptyProject();value.name='直边合片练习';value.version=10;
  const poly=(id,name,points,layer='outline')=>({id,name,type:'polyline',closed:false,layer,points:points.map(([x,y])=>({x,y}))});
  const arc=(id,name,a,c,b,layer='outline')=>{const e=poly(id,name,[a,b],layer);e.curve=quadraticCurve({x:a[0],y:a[1]},{x:c[0],y:c[1]},{x:b[0],y:b[1]});return refreshCurve(e);};
  const label=(id,text,x,y)=>({id,name:text,type:'text',layer:'annotation',text,height:7,points:[{x,y}]});
  value.entities=[poly('merge-a-lower','片 1 下边与接边',[[0,0],[200,0],[200,500]]),arc('merge-a-top','片 1 上弧',[200,500],[100,540],[0,500]),poly('merge-a-left','片 1 左边',[[0,500],[0,0]]),arc('merge-a-inner','片 1 内部弧',[20,200],[100,260],[200,230],'internal'),{...poly('merge-a-grain','片 1 布纹',[[80,40],[80,150]],'grain'),arrowEnd:true},label('merge-a-text','片 1 · 练习纸样',30,400),poly('merge-b-lower','片 2 下边与右边',[[500,0],[650,0],[650,500]]),arc('merge-b-top','片 2 上弧',[650,500],[575,520],[500,500]),poly('merge-b-left','片 2 接边',[[500,500],[500,0]]),arc('merge-b-inner','片 2 内部弧',[500,230],[570,250],[630,210],'internal'),{...poly('merge-b-grain','片 2 布纹',[[570,40],[570,150]],'grain'),arrowEnd:true},label('merge-b-text','片 2 · 练习纸样',520,400)];
  value.groups=['a','b'].map((side,i)=>({id:'merge-group-'+side,name:'练习片 '+(i+1),entityIds:value.entities.filter(e=>e.id.startsWith('merge-'+side+'-')).map(e=>e.id),contours:[{role:'primary-contour',entityIds:['lower','top','left'].map(k=>'merge-'+side+'-'+k)}],source:{kind:'example'}}));value.warnings=['此样片仅用于练习合片，未经服装版型验证。'];
  loadProject(validateProject(value));selected=new Set(value.groups[0].entityIds);pieceMergePanel.begin();selected=new Set(value.groups[1].entityIds);$('merge-capture-second').click();$('merge-first-edge').value='fold-1';$('merge-second-edge').value='fold-3';refresh();fit();
};
$('split-demo').onclick=()=>{
  if(!canReplace())return;
  const value=emptyProject();value.name='裁片分割练习';value.version=10;
  const poly=(id,name,points,layer='outline')=>({id,name,type:'polyline',closed:false,layer,points:points.map(([x,y])=>({x,y}))});
  const arc=(id,name,a,c,b,layer='outline')=>{const e=poly(id,name,[a,b],layer);e.curve=quadraticCurve({x:a[0],y:a[1]},{x:c[0],y:c[1]},{x:b[0],y:b[1]});return refreshCurve(e);};
  const label=(id,text,x,y)=>({id,name:text,type:'text',layer:'annotation',text,height:8,points:[{x,y}]});
  value.entities=[poly('split-lower','下摆与右侧',[[0,0],[400,0],[400,600]]),arc('split-top','上弧',[400,600],[200,680],[0,600]),poly('split-left','左侧',[[0,600],[0,0]]),arc('split-inner','跨切线内部弧',[70,200],[210,480],[330,200],'internal'),{...poly('split-grain','布纹线',[[200,100],[200,500]],'grain'),arrowEnd:true},label('split-upper-text','上段练习 · 原始文字',55,510),label('split-lower-text','下段练习 · 原始文字',55,130),poly('split-on-cut-demo','切线上标记',[[40,300],[160,300]],'internal')];
  value.groups=[{id:'split-group',name:'练习裁片',entityIds:value.entities.map(e=>e.id),contours:[{role:'primary-contour',entityIds:['split-lower','split-top','split-left']}],source:{kind:'example'}}];value.warnings=['此样片仅用于练习裁片分割，未经服装版型验证。'];
  loadProject(validateProject(value));selected=new Set(value.entities.map(e=>e.id));pieceSplitPanel.begin();const boundary=spreadBoundary(value,{entityIds:value.groups[0].contours[0].entityIds,groupId:value.groups[0].id});$('split-a').value=String(pickSpreadStation(boundary,{x:400,y:300}).percent);$('split-b').value=String(pickSpreadStation(boundary,{x:0,y:300}).percent);refresh();fit();
};
$('unfold-demo').onclick=()=>{
  if(!canReplace())return;
  const value=emptyProject();value.name='半片对折展开练习';value.version=10;
  const poly=(id,name,points,layer='outline')=>({id,name,type:'polyline',closed:false,layer,points:points.map(([x,y])=>({x,y}))});
  const arc=(id,name,a,c,b,layer='outline')=>{const e=poly(id,name,[a,b],layer);e.curve=quadraticCurve({x:a[0],y:a[1]},{x:c[0],y:c[1]},{x:b[0],y:b[1]});return e;};
  value.entities=[poly('fold-lower','下摆与侧边',[[0,0],[180,0],[180,300]]),arc('fold-arm','袖窿练习弧',[180,300],[140,350],[200,440]),poly('fold-shoulder','肩线',[[200,440],[80,480]]),arc('fold-neck','领弧',[80,480],[60,430],[0,430]),poly('fold-axis','对折边',[[0,430],[0,0]]),arc('fold-inner','内部弧',[35,230],[90,260],[155,230],'internal'),{...poly('fold-grain','布纹线',[[65,80],[65,195]],'grain'),arrowEnd:true},{id:'fold-text',name:'练习标注',type:'text',layer:'annotation',text:'半片练习 · 非生产纸样',height:6,points:[{x:35,y:285}]}];
  value.groups=[{id:'fold-group',name:'练习半片',entityIds:value.entities.map(e=>e.id),contours:[{role:'primary-contour',entityIds:['fold-lower','fold-arm','fold-shoulder','fold-neck','fold-axis']}],source:{kind:'example'}}];value.warnings=['此样片仅用于练习对折展开，未经服装版型验证。'];
  loadProject(validateProject(value));selected=new Set(value.entities.map(e=>e.id));unfoldPanel.begin();$('unfold-edge').value=$('unfold-edge').options[$('unfold-edge').options.length-1].value;refresh();fit();
};
$('dart-demo').onclick=()=>{
  if(!canReplace())return;
  const value=emptyProject();value.name='转省练习样片';value.version=10;
  const poly=(id,name,points,layer='outline')=>({id,name,type:'polyline',closed:false,layer,points:points.map(([x,y])=>({x,y}))});
  const arc=(id,name,a,c,b,layer)=>{const e=poly(id,name,[a,b],layer);e.curve=quadraticCurve({x:a[0],y:a[1]},{x:c[0],y:c[1]},{x:b[0],y:b[1]});return e;};
  value.entities=[poly('dart-demo-lower','原省口与外边',[[0,0],[160,0],[200,260],[240,0],[400,0],[400,600]]),arc('dart-demo-top','上弧',[400,600],[200,650],[0,600],'outline'),poly('dart-demo-left','左边',[[0,600],[0,0]]),arc('dart-demo-inner','内部弧',[60,400],[200,450],[340,400],'internal'),{...poly('dart-demo-grain','布纹线',[[90,150],[90,480]],'grain'),arrowEnd:true},{id:'dart-demo-text',name:'练习标注',type:'text',layer:'annotation',text:'转省练习 · 非生产纸样',height:7,points:[{x:70,y:540}]}];
  value.groups=[{id:'dart-demo-group',name:'练习前片',entityIds:value.entities.map(e=>e.id),contours:[{role:'primary-contour',entityIds:['dart-demo-lower','dart-demo-top','dart-demo-left']}],source:{kind:'example'}}];value.warnings=['此样片仅用于练习转省操作，未经服装版型验证。'];
  loadProject(validateProject(value));selected=new Set(value.entities.map(e=>e.id));dartPanel.begin();refresh();fit();
};
for(const id of ['seam-width-mode'])$(id).addEventListener('input',()=>{seamPreview=null;refreshSeamPanel();render();});
$('seam-fill-widths').onclick=action(()=>{const width=number('seam-width');if(width<0||width>1e6)throw new Error('宽度须在 0 至 1000000 mm 之间');seamWidthsDraft=new Map(seamEdgeDefs.map(edge=>[edge.key,String(width)]));seamRowsKey='';seamPreview=null;refreshSeamPanel();render();});
for(const id of ['seam-width','seam-direction','seam-join','seam-miter','seam-gap'])$(id).addEventListener('input',()=>{seamPreview=null;refreshSeamPanel();render();});
$('seam-base').onchange=()=>{seamChoiceKey='';seamPreview=null;refreshSeamPanel();render();};
$('preview-seam').onclick=action(()=>{
  seamPreview=null;refreshSeamPanel();
  const base=selectedSeamBase();if(!base)throw new Error('请选择基准轮廓');
  try{
    const options=seamOptions();seamPreview={...generateAllowance(project,base.entityIds,options),base,options};
    $('seam-status').textContent='预览 '+seamPreview.paths.length+' 条轮廓 · '+(seamPreview.config.distance>0?'向外 ':'向内 ')+(options.widthMode==='edges'?'逐边宽度':Math.abs(seamPreview.config.distance)+' mm')+'。'+(seamPreview.bridges.length?'计算时连接 '+seamPreview.bridges.length+' 处断点，最大 '+seamPreview.maxGap.toFixed(4)+' mm。'+(options.widthMode==='edges'?'连接段采用两侧较小宽度。':''):'基准端点无需连接。');
    if(seamPreview.cleanupTolerance)$('seam-status').textContent+='\n转角输出按 0.001414 mm 容差清理。'+(seamPreview.discardedFragments?'移除 '+seamPreview.discardedFragments+' 条退化输出。':'');
    $('apply-seam').disabled=false;$('fit-seam').disabled=false;render();
  }catch(error){$('seam-status').textContent=error.message;render();throw error;}
});
$('fit-seam').onclick=()=>{if(seamPreview)fit([{points:seamPreview.basePoints},...seamPreview.paths]);};
$('apply-seam').onclick=action(()=>{
  if(!seamPreview)return;
  const next=structuredClone(project),recipe=applyAllowance(next,seamPreview.base,seamPreview.options,()=>crypto.randomUUID());
  validateProject(next);
  checkpoint();project=next;
  selected=new Set(project.groups.find(group=>group.entityIds.includes(recipe.outputIds[0]))?.entityIds||recipe.outputIds);
  finishEdit();notify('缝份已关联到基准轮廓，可撤销。');
});
$('detach-seam').onclick=()=>{const recipe=selectedSeamRecipe();if(!recipe)return;checkpoint();detachAllowance(project,recipe.id);finishEdit();notify('已解除关联，线条可独立编辑。');};
for(const id of ['notch-mode','notch-position','notch-side','notch-count','notch-spacing','notch-depth','notch-shape','notch-width','notch-target'])$(id).addEventListener('input',()=>{notchPreview=null;refreshNotchPanel();render();});
$('notch-base').onchange=()=>{notchSelectionKey='';notchPreview=null;refreshNotchPanel();render();};
$('notch-edit').onchange=()=>{notchPreview=null;const recipe=selectedNotchRecipe();if(recipe)loadNotchSettings(recipe);refreshNotchPanel();render();};
$('preview-notch').onclick=action(()=>{
  notchPreview=null;refreshNotchPanel();
  try{
    const baseId=$('notch-base').value,options=notchOptions(),recipeId=selectedNotchRecipe()?.id||null;
    notchPreview={...generateNotches(project,baseId,options),baseId,options,recipeId};
    $('notch-status').textContent='基准长 '+notchPreview.total.toFixed(3)+' mm · 从起点 '+notchPreview.center.toFixed(3)+' mm\n预览 '+notchPreview.paths.length+' 个刀口'+(options.targetSeamId?' · 从缝份边缘朝基准切入':' · 从基准向所选侧伸出');
    $('apply-notch').disabled=false;$('fit-notch').disabled=false;render();
  }catch(error){$('notch-status').textContent=error.message;render();throw error;}
});
$('fit-notch').onclick=()=>{if(notchPreview)fit([...notchPreview.paths,{points:notchPreview.stations.map(station=>station.point)}]);};
$('apply-notch').onclick=action(()=>{
  if(!notchPreview)return;
  const next=structuredClone(project),recipe=applyNotches(next,notchPreview.baseId,notchPreview.options,()=>crypto.randomUUID(),notchPreview.recipeId);
  validateProject(next);checkpoint();project=next;selected=new Set(recipe.outputIds);finishEdit();notify('刀口已关联到基准，可撤销。');
});
$('detach-notch').onclick=()=>{const recipe=selectedNotchRecipe();if(!recipe)return;checkpoint();detachNotches(project,recipe.id);finishEdit();notify('已解除刀口关联，保留标记线。');};
$('control-index').onchange = action(()=>{
  const entity=selectedEntity(),points=entity?.curve?.controlPoints||entity?.points,index=number('control-index')-1;
  if(!points||!Number.isInteger(index)||index<0||index>=points.length)throw new Error('点序号超出范围');
  controlIndex=index;refreshControlEditor();render();
});
$('apply-control').onclick = action(()=>{
  const entity=selectedEntity();if(!entity||entity.type==='text')return;
  if(entity.derivedFrom||entity.notchFrom)throw new Error('请先解除关联再编辑节点');
  const point={x:number('control-x'),y:number('control-y')};
  if(Math.abs(point.x)>1e8||Math.abs(point.y)>1e8)throw new Error('坐标超出范围');
  const next=structuredClone(entity);
  if(next.curve)editControlPoint(next,controlIndex,point);else next.points[controlIndex]=point;
  if(next.source)next.source.modified=true;
  checkpoint();Object.assign(entity,next);finishEdit();
});
$('reference-mode').onchange = refreshReference;
$('calibrate-reference').onclick = action(() => {
  const next = calibrateFromReference(project, selectedEntity()?.id, number('known-length'), $('reference-mode').value);
  checkpoint(); project = next; finishEdit(); fit();
  notify('已按已知长度换算整个工程。请再用另一处已知尺寸交叉核对。');
});
$('inspect-all').onclick = action(() => {
  inspection = inspectProject(project, number('check-tolerance')); focusedInspection = null; focusedInspectionIssue=null;refresh();
});
$('check-tolerance').oninput = () => { invalidateInspection(); refreshInspection(); render(); };
$('export-inspection').onclick = () => {
  if (inspection) download(JSON.stringify(inspection, null, 2), project.name + '-轮廓检查.json', 'application/json');
};
function download(content, filename, type) {
  const url=URL.createObjectURL(new Blob([content],{type}));
  const a=document.createElement('a');a.href=url;a.download=filename;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function save() {
  download(JSON.stringify(project,null,2),project.name.replace(/[<>:"/\\|?*]/g,'_')+'.zycad','application/json');
  dirty=false;refresh();
}
$('save').onclick=save;
$('export').onclick=action(()=>{
  const options=dxfSettings.options();download(toDxf(project,options),project.name+'.dxf','application/dxf');
  notify('已导出当前基码 DXF · '+(options.curveMode==='native'?'保留原生样条':'折线采样偏差 '+options.tolerance+' mm')+'。各尺码在放码面板导出；不含服装关联规则。');
});
function canReplace() { return !hasUnsavedWork() || confirm('当前工程有未保存的修改或绘图草稿。继续会替换当前画布，是否继续？'); }
function loadProject(value, sourceSession=null, endpointSession=null, lineSession=null) {
  prjSavePanel.reset();
  prjWritebackPanel.reset();prjExportSession=sourceSession;
  prjEndpointPanel.reset();prjEndpointSession=endpointSession;
  prjLinePanel.reset();prjLineSession=lineSession;
  const suspended=recoverySuspended;recoverySuspended=true;
  recovery?.writer.newContext();recoveryFingerprint=null;recoveryHasRecord=false;
  constructionInput.reset();
  try{
  invalidateInspection();
  project=value;selected=new Set();draft=[];undoStack=[];redoStack=[];dirty=false;
  matchPanel.reset();
  gradingPanel.reset();
  markerPanel.reset();if(tool==='marker')setTool('select');
  plotPanel.reset();if(tool==='plot')setTool('select');
  lineEditPanel.reset();if(tool==='line-edit')setTool('select');
  trimPanel.reset();if(tool==='trim')setTool('select');
  extendPanel.reset();if(tool==='extend')setTool('select');
  positionPanel.reset();if(tool==='position')setTool('select');
  spreadPanel.reset();if(tool==='spread')setTool('select');
  dartPanel.reset();if(tool==='dart')setTool('select');
  unfoldPanel.reset();if(tool==='unfold')setTool('select');
  pieceSplitPanel.reset();if(tool==='split')setTool('select');
  pieceMergePanel.reset();if(tool==='merge')setTool('select');
  $('measurement').hidden=true;$('filter').value='';refresh();fit();
  }finally{recoverySuspended=suspended;}
  captureRecovery();
}
$('new').onclick=()=>{if(canReplace())loadProject(emptyProject());};
$('open').onclick=$('welcome-open').onclick=()=>$('file').click();
async function openFile(file) {
  if(prjSavePanel.isOpen()){notify('请先关闭保存 PRJ 窗口。');return;}
  if(prjLinePanel.isOpen()){notify('请先关闭新增直线 PRJ 预览。');return;}
  if(prjEndpointPanel.isOpen()){notify('请先关闭 PRJ 端点回存预览。');return;}
  if(prjWritebackPanel.isOpen()){notify('请先关闭 PRJ 回存预览。');return;}
  if(recovery.isOpen()){notify('请先关闭本机恢复窗口，再打开文件。');return;}
  if (tableEditor.isOpen()) { notify('请先应用或关闭表格编辑，再打开文件。'); return; }
  if (importPending) { notify('正在读取文件，请稍候'); return; }
  if(!file||!canReplace())return;
  if(file.size>16*1024*1024){notify('文件大小超过 16 MB，请使用较小文件');return;}
  importPending = true;
  document.querySelector('main').inert = true;
  $('new').disabled = true;
  try {
    let value,sourceSession=null,endpointSession=null,lineSession=null;
    if(/\.prj$/i.test(file.name)){
      const sourceBytes=new Uint8Array(await file.arrayBuffer());
      const parsed=await prjImport.choose(parsePrj(sourceBytes,file.name));
      if(!parsed){notify('已取消 PRJ 导入');return;}
      value={...emptyProject(),...parsed,units:'unknown'};
      try{sourceSession=createPrjTextExportSession(sourceBytes,file.name);}catch{sourceSession=null;}
      try{endpointSession=createPrjEndpointExportSession(sourceBytes,file.name);}catch{endpointSession=null;}
      try{lineSession=createPrjLineExportSession(sourceBytes,file.name);}catch{lineSession=null;}
      darkCanvas = true; $('grid').checked = false; $('show-text').checked = true;
    } else if(/\.dxf$/i.test(file.name)){
      const decoded=decodeDxfBytes(await file.arrayBuffer());value={...emptyProject(),...fromDxf(decoded.text),name:file.name.replace(/\.dxf$/i,'')};
      value.metadata.sourceFile=file.name;value.metadata.dxfImport.encoding=decoded.encoding;
    } else value=validateProject(JSON.parse(await file.text()));
    validateProject(value);loadProject(value,sourceSession,endpointSession,lineSession);
    notify('已打开 '+file.name+' · '+value.entities.length+' 个图元'+(value.warnings?.length?' · 请查看导入报告':''));
  } catch(error) { notify('导入失败：'+error.message); }
  finally { importPending = false; document.querySelector('main').inert = false; $('new').disabled = false; }
}
$('file').onchange=async event=>{await openFile(event.target.files[0]);event.target.value='';};
window.addEventListener('dragover',event=>event.preventDefault());
window.addEventListener('drop',event=>{event.preventDefault();openFile(event.dataTransfer.files[0]);});
$('demo').onclick=()=>{
  if(!canReplace())return;
  const body=[
    {x:0,y:0},{x:250,y:0},{x:240,y:340},
    ...quadratic({x:240,y:340},{x:175,y:355},{x:190,y:440}).slice(1),
    {x:100,y:475},...quadratic({x:100,y:475},{x:60,y:420},{x:0,y:445}).slice(1)
  ];
  const value=emptyProject();value.name='示例 · 基础衣片';
  value.entities=[
    newEntity(body,{closed:true,name:'示意前衣片'}),
    newEntity(body.map(p=>({x:560-p.x,y:p.y})),{closed:true,name:'示意后衣片'}),
    newEntity([{x:120,y:70},{x:120,y:340}],{layer:'grain',name:'前片布纹'}),
    newEntity([{x:440,y:70},{x:440,y:340}],{layer:'grain',name:'后片布纹'})
  ];
  value.warnings=['示例用于体验绘图操作，未经服装版型验证。'];loadProject(value);
};
window.addEventListener('keydown',event=>{
  if(prjLinePanel.isOpen()){if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s')event.preventDefault();return;}
  if(prjSavePanel.isOpen()){if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s')event.preventDefault();return;}
  if(prjEndpointPanel.isOpen())return;
  if(prjWritebackPanel.isOpen())return;
  if(importPending)return;
  if(recovery.isOpen())return;
  if(tableEditor.isOpen())return;
  if($('dxf-settings').open)return;
  if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))return;
  if(tool==='plot'&&(['Delete','Backspace'].includes(event.key)||(event.ctrlKey||event.metaKey)&&['a','g'].includes(event.key.toLowerCase()))){event.preventDefault();return;}
  if(tool==='marker'){
    if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();markerPanel.unplace();return;}
    if((event.ctrlKey||event.metaKey)&&['a','g'].includes(event.key.toLowerCase())){event.preventDefault();return;}
  }
  if(event.ctrlKey||event.metaKey){
    if(gesture){event.preventDefault();cancelGesture();return;}
    if(event.key.toLowerCase()==='a'){event.preventDefault();selected=new Set(project.entities.filter(entity=>entity.type!=='text'||$('show-text').checked).map(entity=>entity.id));if($('whole-group').checked)selected=expandGroups(project,selected);refresh();}
    if(event.key.toLowerCase()==='g'){event.preventDefault();event.shiftKey?$('ungroup').click():makeGroup();}
    if(event.key.toLowerCase()==='s'){event.preventDefault();save();}
    if(event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();}
    return;
  }
  if(event.code==='Space'){event.preventDefault();space=true;svg.style.cursor='grab';}
  if(event.key==='Escape'){cancelGesture();draft=[];selected=new Set();$('measurement').hidden=true;setTool('select');refresh();}
  if(event.key==='Enter'&&tool==='polyline'&&draft.length>=2){try{finishPolyline(false);}catch(error){notify(error.message);}}
  if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();remove();}
  const keys={v:'select',n:'node',l:'line',p:'polyline',c:'curve',r:'rectangle',m:'measure',g:'grain'};
  if(keys[event.key.toLowerCase()])setTool(keys[event.key.toLowerCase()]);
  if(event.key.toLowerCase()==='f')fit();
});
window.addEventListener('keyup',event=>{if(event.code==='Space'){space=false;svg.style.cursor='default';}});
window.addEventListener('blur',()=>{space=false;cancelGesture();});
function flushRecovery(){cancelGesture();captureRecovery(true);void recovery.writer.flush();}
window.addEventListener('pagehide',flushRecovery);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flushRecovery();});
window.addEventListener('beforeunload',event=>{if(hasUnsavedWork()){event.preventDefault();event.returnValue='';}});
new ResizeObserver(render).observe(svg);refresh();
