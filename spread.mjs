import { validateProject, textWidth } from './geometry.mjs';
import { pathMetrics, stationOnPath } from './path-metrics.mjs';
import { refreshCurve, sampleCurve } from './curves.mjs';
import { orientChain } from './topology.mjs';
import { integerPolygon } from './marker-polygons.mjs';
import Clipper from './vendor/clipper.mjs';
import { dependencies } from './line-edit.mjs';
import { syncAllowances } from './seams.mjs';
import { syncNotches } from './notches.mjs';
import { syncSeamChecks } from './seam-checks.mjs';
import { syncGradingPlans } from './grading.mjs';
import { syncMarkerPlans } from './marker.mjs';
import { evaluateBezier, sliceBezier, bezierLineHits, nearestBezier, bezierArea } from './bezier-cut.mjs';
import { assertNativeSimpleBoundary } from './native-contact.mjs';
const clone=v=>JSON.parse(JSON.stringify(v)),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),add=(a,b)=>({x:a.x+b.x,y:a.y+b.y}),sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
export const spreadStamp=project=>JSON.stringify(project);
const finitePoint=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y);
function lineMetrics(points){const length=distance(points[0],points[1]);return {points,length,critical:[],uncertainty:length*Number.EPSILON*8};}
export function spreadBoundary(project,basis,gapTolerance=.1){
  if(project.units!=='mm')throw new Error('请先确认毫米比例，再剪开展开');
  if(!basis||!Array.isArray(basis.entityIds)||!basis.entityIds.length||basis.entityIds.length>2000||new Set(basis.entityIds).size!==basis.entityIds.length)throw new Error('请选择完整且有序的裁片轮廓');
  if(!Number.isFinite(gapTolerance)||gapTolerance<0||gapTolerance>1)throw new Error('连接容差须在 0–1 mm 之间');
  const byId=new Map(project.entities.map(e=>[e.id,e])),entities=basis.entityIds.map(id=>byId.get(id));
  if(entities.some(e=>!e||e.type==='text'||e.derivedFrom||e.notchFrom))throw new Error('轮廓须由原始线条组成，请确认所选是需要展开的净线');
  if(basis.groupId&&!project.groups?.some(g=>g.id===basis.groupId&&basis.entityIds.every(id=>g.entityIds.includes(id))))throw new Error('所选轮廓不属于该裁片组合');
  if(entities.length===1&&!entities[0].closed||entities.length>1&&entities.some(e=>e.closed))throw new Error('请选择单条闭合线，或一组开放边构成的完整轮廓');
  const ordered=entities.length===1?[{entity:entities[0],reversed:false}]:orientChain(entities),origin={...entities[0].points[0]},pieces=[],bridges=[];let total=0,uncertainty=0;
  const push=(piece,sourceId,sourcePiece,reversed=false)=>{pieces.push({...piece,start:total,sourceId,sourcePiece,reversed});total+=piece.length;uncertainty+=piece.uncertainty;};
  for(let i=0;i<ordered.length;i++){
    const {entity,reversed}=ordered[i],metrics=pathMetrics(entity,{preserveShortPieces:true}),raw=metrics.pieces.map((piece,index)=>({...piece,sourcePiece:index,points:piece.points.map(p=>add(p,sub(metrics.origin,origin)))}));
    if(reversed)raw.reverse();
    for(const piece of raw){if(reversed){piece.points.reverse();piece.critical=piece.critical.map(c=>({t:1-c.t,length:piece.length-c.length}));}push(piece,entity.id,piece.sourcePiece,reversed);}
    if(ordered.length>1){const current=reversed?(entity.curve?.controlPoints||entity.points)[0]:(entity.curve?.controlPoints||entity.points).at(-1),next=ordered[(i+1)%ordered.length],points=next.entity.curve?.controlPoints||next.entity.points,end=next.reversed?points.at(-1):points[0],gap=distance(current,end);
      if(gap>gapTolerance)throw new Error('轮廓间隙 '+gap.toFixed(6)+' mm 超出连接容差');
      if(gap>0){const a=sub(current,origin),b=sub(end,origin);push(lineMetrics([a,b]),null,null);bridges.push({a:current,b:end,gap});}
    }
  }
  if(pieces.length>10000)throw new Error('轮廓分段超过 10000，请拆分工程');
  return {pieces,total,origin,uncertainty,closed:true,basis:clone(basis),bridges};
}
export function pickSpreadStation(boundary,world){
  if(!finitePoint(world))throw new Error('拾取坐标无效');const query=sub(world,boundary.origin);let best=null;
  boundary.pieces.forEach((piece,i)=>{
    const minX=Math.min(...piece.points.map(p=>p.x)),maxX=Math.max(...piece.points.map(p=>p.x)),minY=Math.min(...piece.points.map(p=>p.y)),maxY=Math.max(...piece.points.map(p=>p.y));
    if(best&&Math.hypot(Math.max(0,minX-query.x,query.x-maxX),Math.max(0,minY-query.y,query.y-maxY))>best.distance)return;
    const candidate=nearestBezier(piece.points,query);if(!best||candidate.distance<best.distance)best={...candidate,pieceIndex:i};
  });
  const piece=boundary.pieces[best.pieceIndex];let local=0;
  if(best.t===1)local=piece.length;else if(best.t>0){const points=sliceBezier(piece.points,0,best.t),e=entityFromPart({points,sourceId:piece.sourceId},boundary.origin,{},'pick');local=pathMetrics(e,{preserveShortPieces:true}).total;}
  const position=piece.start+local;return {point:add(best.point,boundary.origin),position,percent:position/boundary.total*100,distance:best.distance};
}
export function interval(boundary,start,end){
  if(end<=start)return [];const a=stationOnPath(boundary,start,{pointOnly:true}),b=stationOnPath(boundary,end,{pointOnly:true}),result=[];
  for(let i=a.pieceIndex;i<=b.pieceIndex;i++){const piece=boundary.pieces[i],lo=i===a.pieceIndex?a.parameter:0,hi=i===b.pieceIndex?b.parameter:1;if(hi>lo)result.push({...piece,points:sliceBezier(piece.points,lo,hi),t0:lo,t1:hi});}return result;
}
function sampled(parts){const result=[];for(const part of parts){let points=part.points;if(points.length>2){const degree=points.length-1,sample=sampleCurve({kind:'bspline',degree,controlPoints:points,knots:[...Array(degree+1).fill(0),...Array(degree+1).fill(1)],samplingTolerance:.002});if(sample.capped)throw new Error('轮廓采样未达到 0.002 mm 检查容差');points=sample.points;}for(const p of points)if(!result.length||distance(p,result.at(-1))>1e-10)result.push(p);if(result.length>20000)throw new Error('轮廓检查节点超过 20000');}return result;}
export function polygon(parts){const path=integerPolygon(sampled(parts)).path;assertNativeSimpleBoundary(parts,{connectGaps:true});return path;}
export function assertStoredBoundary(entities,ids){
  const byId=new Map(entities.map(e=>[e.id,e])),parts=ids.flatMap(id=>{const e=byId.get(id);if(!e||e.type==='text')throw new Error('原生输出轮廓引用无效');if(e.curve)return [{points:e.curve.controlPoints}];return e.points.slice(1).map((p,i)=>({points:[e.points[i],p]}));});
  return assertNativeSimpleBoundary(parts,{connectGaps:true});
}
export function inside(point,path){return Clipper.Clipper.PointInPolygon({X:Math.round(point.x*1000),Y:Math.round(point.y*1000)},path)!==0;}
export function entityFromPart(part,origin,source,id,operation='spread',label='展开'){
  const entity={id,name:(source.name||'轮廓')+' · '+label,type:'polyline',layer:source.layer||'outline',closed:false,points:part.points.map(p=>add(p,origin)),source:{...clone(source.source||{}),modified:true,[operation]:{entityId:part.sourceId??null,piece:part.sourcePiece??null,t0:part.t0??0,t1:part.t1??1,reversed:!!part.reversed,attachment:part.moving?'moving':'fixed'}}};
  if(part.points.length>2){const degree=part.points.length-1;entity.curve={kind:'bspline',degree,controlPoints:entity.points,knots:[...Array(degree+1).fill(0),...Array(degree+1).fill(1)],samplingTolerance:source.curve?.samplingTolerance??.002};refreshCurve(entity);}return entity;
}
function transformText(entity,fn,angle){const copy=clone(entity);copy.points=copy.points.map(fn);copy.width=copy.width||textWidth(copy.text,copy.height);copy.rotation=(copy.rotation||0)+angle;if(copy.source)copy.source.modified=true;return copy;}
export function assertCutInside(boundary,A,B,originalPath=polygon(boundary.pieces)){
  const cutLength=distance(A,B);if(cutLength<.001)throw new Error('切线长度须大于 0.001 mm');
  for(const piece of boundary.pieces){const result=bezierLineHits(piece.points,A,B);if(result.collinear){const hits=piece.points.map(p=>((p.x-A.x)*(B.x-A.x)+(p.y-A.y)*(B.y-A.y))/cutLength**2);if(Math.min(...hits)<1-1e-9&&Math.max(...hits)>1e-9)throw new Error('切线与轮廓重合，请重新选择两个切点');}for(const hit of result.hits)if(distance(hit.point,A)>1e-5&&distance(hit.point,B)>1e-5)throw new Error('切线还穿过或接触了其他边界；请换一条位于裁片内部的切线');}
  if(!inside({x:(A.x+B.x)/2,y:(A.y+B.y)/2},originalPath))throw new Error('切线不在裁片内部');
}
export function prepareSpread(project,config,makeId){
  if(!config||!['rotate','parallel'].includes(config.mode)||!['first','second'].includes(config.side)||!['fixed','moving'].includes(config.onCut)||typeof config.keepOriginals!=='boolean')throw new Error('展开设置无效');
  const boundary=spreadBoundary(project,config.basis,config.gapTolerance),{origin}=boundary,byId=new Map(project.entities.map(e=>[e.id,e]));
  if(!Number.isFinite(config.a)||!Number.isFinite(config.b)||config.a<0||config.a>=100||config.b<0||config.b>=100)throw new Error('切点位置须为 0（含）至 100（不含）的轮廓弧长百分比');
  let a=config.a/100*boundary.total,b=config.b/100*boundary.total;if(Math.min(Math.abs(a-b),boundary.total-Math.abs(a-b))<1e-5)throw new Error('切点 A、B 必须不同');
  const sa=stationOnPath(boundary,a,{pointOnly:true}),sb=stationOnPath(boundary,b,{pointOnly:true}),A=sub(sa.point,origin),B=sub(sb.point,origin),cutLength=distance(A,B);if(cutLength<.001)throw new Error('切线长度须大于 0.001 mm');
  const originalPath=polygon(boundary.pieces),areaBefore=Math.abs(boundary.pieces.reduce((sum,p)=>sum+bezierArea(p.points),0)),winding=Math.sign(boundary.pieces.reduce((sum,p)=>sum+bezierArea(p.points),0));
  assertCutInside(boundary,A,B,originalPath);
  const first=a<b?interval(boundary,a,b):[...interval(boundary,a,boundary.total),...interval(boundary,0,b)],second=b<a?interval(boundary,b,a):[...interval(boundary,b,boundary.total),...interval(boundary,0,a)];
  const moving=config.side==='first'?first:second,fixed=config.side==='first'?second:first,movingPath=polygon([...moving,{points:[moving.at(-1).points.at(-1),moving[0].points[0]]}]),fixedPath=polygon([...fixed,{points:[fixed.at(-1).points.at(-1),fixed[0].points[0]]}]);
  const sign=winding*(config.side==='first'?-1:1);let radians=0,dx=0,dy=0;
  if(config.mode==='rotate'){if(!Number.isFinite(config.angle)||config.angle<=0||config.angle>170)throw new Error('展开角度须大于 0 且不超过 170°');radians=config.angle*Math.PI/180*sign;}
  else{if(!Number.isFinite(config.width)||config.width<=0||config.width>100000)throw new Error('平行展开宽度须大于 0 且不超过 100000 mm');dx=-(B.y-A.y)/cutLength*config.width*sign;dy=(B.x-A.x)/cutLength*config.width*sign;}
  const c=Math.cos(radians),s=Math.sin(radians),move=p=>({x:A.x+(p.x-A.x)*c-(p.y-A.y)*s+dx,y:A.y+(p.x-A.x)*s+(p.y-A.y)*c+dy}),movingFirst=config.side==='first';
  const outputParts=[],connectors=[];
  function push(part){if(outputParts.length){const prev=outputParts.at(-1).points.at(-1),next=part.points[0];if(distance(prev,next)>1e-9){const bridge={points:[prev,next],bridge:true,sourceId:null};outputParts.push(bridge);connectors.push(bridge);}}outputParts.push(part);}
  first.forEach(p=>push({...p,points:movingFirst?p.points.map(move):p.points,moving:movingFirst}));second.forEach(p=>push({...p,points:!movingFirst?p.points.map(move):p.points,moving:!movingFirst}));
  const last=outputParts.at(-1).points.at(-1),start=outputParts[0].points[0];if(distance(last,start)>1e-9){const bridge={points:[last,start],bridge:true,sourceId:null};outputParts.push(bridge);connectors.push(bridge);}
  // Check every candidate with fresh native sampling, independent of display cache.
  polygon(outputParts);const areaAfter=Math.abs(outputParts.reduce((sum,p)=>sum+bezierArea(p.points),0));if(areaAfter<areaBefore-1e-5)throw new Error('展开结果发生面积损失，请调整切线或侧向');
  const outputs=outputParts.map(part=>entityFromPart(part,origin,byId.get(part.sourceId)||{name:part.bridge?'展开连接边':'容差连接边'},makeId())),boundaryIds=outputs.map(e=>e.id);
  const attachments=copyCutAttachments(project,{config,origin,A,B,movingPath,fixedPath,move,radians},makeId);outputs.push(...attachments.outputs);
  const {group,sourceIds,warnings,splitCount}=attachments;
  const {project:next,effects}=createCutProject(project,{config,outputs,boundaryIds,sourceIds,group,metadata:{kind:'spread',basis:clone(config.basis),angle:radians*180/Math.PI,width:config.mode==='parallel'?config.width:null}},makeId);
  return {project:next,config:clone(config),signature:spreadStamp(project),outputs,outputIds:outputs.map(e=>e.id),boundaryIds,movingIds:outputs.filter(e=>e.source?.spread?.attachment==='moving').map(e=>e.id),sourceIds,effects,warnings,splitCount,bridges:boundary.bridges,connectors:connectors.map(p=>p.points.map(q=>add(q,origin))),cut:[sa.point,sb.point],movedCut:[add(move(A),origin),add(move(B),origin)],areaBefore,areaAfter,cutLength,mouthGap:distance(B,move(B)),angle:radians*180/Math.PI,uncertainty:boundary.uncertainty+sa.uncertainty+sb.uncertainty};
}
export function copyCutAttachments(project,{config,origin,A,B,movingPath,fixedPath,move,radians,operation='spread',label='展开'},makeId){
  const byId=new Map(project.entities.map(e=>[e.id,e])),outputs=[],cutLength=distance(A,B);
  const group=config.basis.groupId?project.groups.find(g=>g.id===config.basis.groupId):null;if(config.basis.groupId&&!group)throw new Error('裁片组合已缺失，请重新选择');
  const members=group?group.entityIds:config.basis.entityIds,sourceIds=members.filter(id=>{const e=byId.get(id);return e&&!e.derivedFrom&&!e.notchFrom;}),boundarySet=new Set(config.basis.entityIds),warnings=[],extras=sourceIds.filter(id=>!boundarySet.has(id));let splitCount=0,onCutCount=0,outsideCount=0;
  const selectSide=p=>{const m=inside(p,movingPath),f=inside(p,fixedPath);if(m&&f){onCutCount++;return config.onCut==='moving';}if(m)return true;if(f)return false;outsideCount++;return false;};
  for(const sourceId of extras){const entity=byId.get(sourceId);
    if(entity.type==='text'){const follows=selectSide(sub(entity.points[0],origin)),copy=transformText(entity,p=>follows?add(move(sub(p,origin)),origin):p,follows?radians*180/Math.PI:0);copy.id=makeId();copy.name+=' · '+label;copy.source={...copy.source,modified:true,[operation]:{entityId:entity.id,attachment:follows?'moving':'fixed'}};outputs.push(copy);continue;}
    const metrics=pathMetrics(entity,{preserveShortPieces:true});
    metrics.pieces.forEach((piece,index)=>{
      const points=piece.points.map(p=>add(p,sub(metrics.origin,origin))),hits=bezierLineHits(points,A,B),cuts=[0,...hits.hits.map(h=>h.t).filter(t=>t>0&&t<1),1].sort((a,b)=>a-b).filter((t,i,all)=>!i||t!==all[i-1]);if(cuts.length>2)splitCount+=cuts.length-2;
      for(let i=0;i<cuts.length-1;i++){const pointsPart=sliceBezier(points,cuts[i],cuts[i+1]),mid=evaluateBezier(pointsPart,.5),u=((mid.x-A.x)*(B.x-A.x)+(mid.y-A.y)*(B.y-A.y))/cutLength**2,onSegment=hits.collinear&&u>=0&&u<=1,follows=onSegment?(onCutCount++,config.onCut==='moving'):selectSide(mid),part={points:follows?pointsPart.map(move):pointsPart,sourceId,sourcePiece:index,t0:cuts[i],t1:cuts[i+1],moving:follows},copy=entityFromPart(part,origin,entity,makeId(),operation,label);if(index===0&&i===0&&entity.arrowStart)copy.arrowStart=true;if(index===metrics.pieces.length-1&&i===cuts.length-2&&entity.arrowEnd)copy.arrowEnd=true;outputs.push(copy);}
    });
  }
  if(onCutCount)warnings.push(onCutCount+' 项位于切线上，按设置归属'+(config.onCut==='moving'?'移动侧':'固定侧')+'。');
  if(outsideCount)warnings.push(outsideCount+' 项位于所选轮廓外，保留在固定侧，请核对归属。');
  if(group?.contours?.length>1)warnings.push('组合中的其余轮廓按内部线分割和移动；请核对净线、毛线与内部轮廓的用途。');
  if(extras.some(id=>byId.get(id).type==='text'))warnings.push('文字按锚点归属一侧，整项随该侧移动；未识别或改写文字内容。');
  return {outputs,group,sourceIds,warnings,splitCount};
}
export function createCutProject(project,{config,outputs,boundaryIds,sourceIds,group,metadata,label='展开'},makeId){
  assertStoredBoundary(outputs,boundaryIds);
  const next=clone(project),effects=dependencies(project,sourceIds);
  if(!config.keepOriginals){const removed=new Set(sourceIds);next.entities=next.entities.filter(e=>!removed.has(e.id));next.groups=next.groups.map(g=>({...g,entityIds:g.entityIds.filter(id=>!removed.has(id))})).filter(g=>g.entityIds.length>=2);}
  next.entities.push(...outputs);next.groups.push({id:makeId(),name:(group?.name||config.basis.name||'裁片')+' · '+label,entityIds:outputs.map(e=>e.id),contours:[{role:'primary-contour',entityIds:boundaryIds}],source:metadata});
  validateProject(next);syncAllowances(next,makeId);syncNotches(next,makeId);syncSeamChecks(next);syncGradingPlans(next);syncMarkerPlans(next);
  return {project:next,effects};
}
export function applySpread(project,preview){if(!preview||preview.signature!==spreadStamp(project))throw new Error('工程已变化，请重新预览展开结果');return {project:clone(preview.project),outputIds:[...preview.outputIds]};}
