import { spreadBoundary, polygon, entityFromPart, spreadStamp, assertStoredBoundary } from './spread.mjs';
import { unfoldCandidates } from './unfold.mjs';
import { bezierArea } from './bezier-cut.mjs';
import { pathMetrics } from './path-metrics.mjs';
import { refreshCurve } from './curves.mjs';
import { validateProject, textWidth } from './geometry.mjs';
import { dependencies } from './line-edit.mjs';
import { syncAllowances } from './seams.mjs';
import { syncNotches } from './notches.mjs';
import { syncSeamChecks } from './seam-checks.mjs';
import { syncGradingPlans } from './grading.mjs';
import { syncMarkerPlans } from './marker.mjs';
import { assertNativeSeparated } from './native-contact.mjs';
const clone=v=>JSON.parse(JSON.stringify(v)),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),add=(a,b)=>({x:a.x+b.x,y:a.y+b.y}),sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
function remaining(boundary,edge){const removed=new Set(edge.indices),parts=[];for(let i=1;i<=boundary.pieces.length;i++){const index=(edge.indices.at(-1)+i)%boundary.pieces.length;if(!removed.has(index))parts.push(boundary.pieces[index]);}return parts;}
function sourcePiece(project,choice,gapTolerance){
  if(!choice||typeof choice.edgeId!=='string')throw new Error('请分别记录两片及其直线接合边');
  const boundary=spreadBoundary(project,choice.basis,gapTolerance),edge=unfoldCandidates(boundary).find(e=>e.id===choice.edgeId);if(!edge)throw new Error('接合边须是轮廓中的连续直边，请重新选择');polygon(boundary.pieces);
  const signedArea=boundary.pieces.reduce((sum,p)=>sum+bezierArea(p.points),0),group=choice.basis.groupId?project.groups.find(g=>g.id===choice.basis.groupId):null,byId=new Map(project.entities.map(e=>[e.id,e])),sourceIds=(group?group.entityIds:choice.basis.entityIds).filter(id=>{const e=byId.get(id);return e&&!e.derivedFrom&&!e.notchFrom;});
  return {boundary,edge,group,sourceIds,signedArea,rest:remaining(boundary,edge)};
}
export function preparePieceMerge(project,config,makeId){
  if(!config||typeof config.keepOriginals!=='boolean'||typeof config.mirrorSecond!=='boolean'||typeof config.guide!=='boolean')throw new Error('合片设置无效');
  const first=sourcePiece(project,config.first,config.gapTolerance),second=sourcePiece(project,config.second,config.gapTolerance),sourceIds=[...first.sourceIds,...second.sourceIds];
  if(new Set(sourceIds).size!==sourceIds.length)throw new Error('两片不能来自同一裁片或共享原始图元');
  let worldScale=1,localScale=1;
  for(const item of [first,second])for(const part of item.boundary.pieces)for(const p of part.points){localScale=Math.max(localScale,Math.abs(p.x),Math.abs(p.y));worldScale=Math.max(worldScale,Math.abs(p.x+item.boundary.origin.x),Math.abs(p.y+item.boundary.origin.y));}
  const lengthTolerance=worldScale*Number.EPSILON*8+localScale*Number.EPSILON*128,lengthDifference=Math.abs(first.edge.length-second.edge.length);
  if(lengthDifference>lengthTolerance)throw new Error('两条接合边长度不等，差 '+lengthDifference.toPrecision(8)+' mm；合片不拉伸，请先修整边长');
  const determinant=config.mirrorSecond?-1:1,reverseSecond=Math.sign(second.signedArea)*determinant!==Math.sign(first.signedArea),targetStart=reverseSecond?first.edge.a:first.edge.b,targetEnd=reverseSecond?first.edge.b:first.edge.a,sourceStart=second.edge.a,sourceEnd=second.edge.b;
  const u={x:(sourceEnd.x-sourceStart.x)/second.edge.length,y:(sourceEnd.y-sourceStart.y)/second.edge.length},v={x:(targetEnd.x-targetStart.x)/first.edge.length,y:(targetEnd.y-targetStart.y)/first.edge.length};
  // Orthonormal frames implement rotation or the explicitly requested
  // reflection. Boundary winding changes traversal, never silently mirrors.
  const matrix={a:v.x*u.x+determinant*v.y*u.y,b:v.y*u.x-determinant*v.x*u.y,c:v.x*u.y-determinant*v.y*u.x,d:v.y*u.y+determinant*v.x*u.x,determinant};
  const vector=p=>({x:matrix.a*p.x+matrix.c*p.y,y:matrix.b*p.x+matrix.d*p.y}),localPoint=p=>add(targetStart,vector(sub(p,sourceStart))),worldPoint=p=>add(first.boundary.origin,localPoint(sub(p,second.boundary.origin)));
  const firstParts=first.rest.map(p=>({...p,owner:'first'}));let secondParts=second.rest.map(p=>({...p,points:p.points.map(localPoint),owner:'second'}));
  if(reverseSecond)secondParts.reverse().forEach(part=>{part.points.reverse();part.reversed=!part.reversed;});
  const residuals=[distance(firstParts.at(-1).points.at(-1),secondParts[0].points[0]),distance(secondParts.at(-1).points.at(-1),firstParts[0].points[0])],closureResidual=Math.max(...residuals);
  if(closureResidual>lengthTolerance*2)throw new Error('接合端点超出坐标舍入范围，请核对边长与位置');
  // Only roundoff-sized endpoint corrections are permitted and reported.
  secondParts[0].points[0]={...firstParts.at(-1).points.at(-1)};secondParts.at(-1).points[secondParts.at(-1).points.length-1]={...firstParts[0].points[0]};
  const parts=[...firstParts,...secondParts];try{polygon(parts);}catch(error){throw new Error('合片后的轮廓发生重叠、接触或自交，或精度不足：'+error.message);}
  const areas=[Math.abs(first.signedArea),Math.abs(second.signedArea)],expectedArea=areas[0]+areas[1],areaAfter=Math.abs(parts.reduce((sum,p)=>sum+bezierArea(p.points),0)),areaTolerance=Math.max(1e-6,expectedArea*1e-11,closureResidual*(first.boundary.total+second.boundary.total)*4);
  if(Math.abs(areaAfter-expectedArea)>areaTolerance)throw new Error('合片面积与两片面积之和不一致，请核对重叠区域');
  const byId=new Map(project.entities.map(e=>[e.id,e])),outputs=parts.map(part=>{const e=entityFromPart(part,first.boundary.origin,byId.get(part.sourceId)||{name:'容差连接边'},makeId(),'pieceMerge','合片');e.source.pieceMerge={...e.source.pieceMerge,owner:part.owner,role:'boundary'};return e;}),boundaryIds=outputs.map(e=>e.id),warnings=[];
  const storedParts=outputs.map(e=>({points:e.curve?.controlPoints||e.points})),nativeContactCheck=assertNativeSeparated(storedParts.slice(0,firstParts.length),storedParts.slice(firstParts.length),[storedParts[0].points[0],storedParts[firstParts.length-1].points.at(-1)],{tolerance:lengthTolerance});
  assertStoredBoundary(outputs,boundaryIds);
  let textCount=0,internalCount=0;
  for(const [owner,item,choice] of [['first',first,config.first],['second',second,config.second]]){
    const boundarySet=new Set(choice.basis.entityIds);
    for(const id of item.sourceIds.filter(id=>!boundarySet.has(id))){const original=byId.get(id),e=clone(original);e.id=makeId();e.name=(e.name||'图元')+' · 合片';e.source={...e.source,modified:true,pieceMerge:{entityId:id,owner,role:e.type==='text'?'text':'internal'}};
      if(e.type==='text')textCount++;else internalCount++;
      if(owner==='second'){
        e.points=e.points.map(worldPoint);if(e.curve){e.curve.controlPoints=e.curve.controlPoints.map(worldPoint);refreshCurve(e);}
        if(e.type==='text'){const radians=(e.rotation||0)*Math.PI/180,direction=vector({x:Math.cos(radians),y:Math.sin(radians)});e.rotation=Math.atan2(direction.y,direction.x)*180/Math.PI;e.mirrorY=Boolean(e.mirrorY)!==config.mirrorSecond;e.width=e.width||textWidth(e.text,e.height);}
      }
      outputs.push(e);
    }
    if(item.group?.contours?.length>1)warnings.push((owner==='first'?'第一片':'第二片')+'的其余轮廓按内部线保留，请核对净线与毛线用途。');
  }
  if(textCount)warnings.push(config.mirrorSecond?'两片文字保留原内容；第二片字形也随镜像反射，请核对可读方向。':'两片文字保留原内容；第二片文字随裁片旋转和平移。');
  if(internalCount)warnings.push('两片内部线、布纹线均保留；接合处重叠的内部图元未自动删除。');
  let guideId=null;
  if(config.guide){const e=entityFromPart({points:[first.edge.a,first.edge.b]},first.boundary.origin,{name:'接合参考线',layer:'internal'},makeId(),'pieceMerge','合片');e.source.pieceMerge.role='join-guide';e.source.pieceMerge.owner='first';guideId=e.id;outputs.push(e);}
  const perimeterAfter=outputs.filter(e=>boundaryIds.includes(e.id)).reduce((sum,e)=>sum+pathMetrics(e,{preserveShortPieces:true}).total,0),expectedPerimeter=first.boundary.total+second.boundary.total-first.edge.length-second.edge.length;
  if(Math.abs(perimeterAfter-expectedPerimeter)>Math.max(1e-6,expectedPerimeter*1e-11,lengthTolerance*8))throw new Error('合片周长未通过去除接合边后的长度核对');
  const next=clone(project),effects=dependencies(project,sourceIds),groupId=makeId();
  if(!config.keepOriginals){const removed=new Set(sourceIds);next.entities=next.entities.filter(e=>!removed.has(e.id));next.groups=next.groups.map(g=>({...g,entityIds:g.entityIds.filter(id=>!removed.has(id))})).filter(g=>g.entityIds.length>=2);}
  next.entities.push(...outputs);next.groups.push({id:groupId,name:(first.group?.name||config.first.basis.name||'第一片')+' + '+(second.group?.name||config.second.basis.name||'第二片')+' · 合片',entityIds:outputs.map(e=>e.id),contours:[{role:'primary-contour',entityIds:boundaryIds}],source:{kind:'piece-merge',first:clone(config.first),second:clone(config.second),mirrorSecond:config.mirrorSecond,matrix,sourceAnchor:add(sourceStart,second.boundary.origin),targetAnchor:add(targetStart,first.boundary.origin),lengthDifference,closureResidual,guideId}});
  validateProject(next);syncAllowances(next,makeId);syncNotches(next,makeId);syncSeamChecks(next);syncGradingPlans(next);syncMarkerPlans(next);
  return {project:next,signature:spreadStamp(project),config:clone(config),outputs,outputIds:outputs.map(e=>e.id),boundaryIds,sourceIds,groupId,effects,warnings,areas,areaAfter,perimeterAfter,expectedPerimeter,joinLength:first.edge.length,lengthDifference,lengthTolerance,closureResidual,matrix,reverseSecond,guideId,nativeContactCheck,firstEdge:first.edge.world,secondEdge:second.edge.world,alignedSecondEdge:second.edge.world.map(worldPoint),removedPartCount:first.edge.indices.length+second.edge.indices.length,bridges:[...first.boundary.bridges,...second.boundary.bridges]};
}
export function applyPieceMerge(project,preview){if(!preview||preview.signature!==spreadStamp(project))throw new Error('工程已变化，请重新预览合片结果');return {project:clone(preview.project),outputIds:[...preview.outputIds]};}
