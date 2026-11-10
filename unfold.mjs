import { spreadBoundary, polygon, entityFromPart, createCutProject, spreadStamp } from './spread.mjs';
import { bezierArea, power, derivative, polynomialRoots, nearestBezier } from './bezier-cut.mjs';
import { positionMatrix, positionPoint, positionVector } from './position.mjs';
import { refreshCurve } from './curves.mjs';
import { textWidth } from './geometry.mjs';
const clone=v=>JSON.parse(JSON.stringify(v)),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),add=(a,b)=>({x:a.x+b.x,y:a.y+b.y});
const value=(coeff,t)=>coeff.reduceRight((sum,c)=>sum*t+c,0);
function range(coeff){return [0,1,...(coeff.length>1?polynomialRoots(derivative(coeff)):[])].map(t=>({t,value:value(coeff,t)}));}
function tolerance(boundary){
  let scale=1,worldScale=1;
  for(const part of boundary.pieces)for(const p of part.points){scale=Math.max(scale,Math.abs(p.x),Math.abs(p.y));worldScale=Math.max(worldScale,Math.abs(p.x+boundary.origin.x),Math.abs(p.y+boundary.origin.y));}
  // Local arithmetic plus a few ULPs already lost when world coordinates were
  // stored after a transform. User gap tolerance never straightens a fold.
  return scale*Number.EPSILON*64+worldScale*Number.EPSILON*4;
}
function axis(a,b){const length=distance(a,b);return {length,x:(b.x-a.x)/length,y:(b.y-a.y)/length};}
const signed=(p,a,u)=>(p.x-a.x)*u.y-(p.y-a.y)*u.x;
function straight(points,eps){
  const a=points[0],b=points.at(-1),u=axis(a,b);if(!(u.length>eps))return false;
  if(points.some(p=>Math.abs(signed(p,a,u))>eps))return false;
  const along=power(points.map(p=>(p.x-a.x)*u.x+(p.y-a.y)*u.y));
  return range(derivative(along)).every(p=>p.value>=-eps);
}
function canJoin(parts,left,right,eps){
  const first=parts[left.at(-1)],last=parts[right[0]],a=parts[left[0]].points[0],b=parts[right.at(-1)].points.at(-1),u=axis(a,b);
  if(distance(first.points.at(-1),last.points[0])>eps||u.length<=eps)return false;
  // Check full native controls against the proposed common axis. No flattening
  // or user gap tolerance is used to turn a bent edge into a fold edge.
  let previous=-Infinity;
  for(const i of [...left,...right]){const p=parts[i];if(p.points.some(q=>Math.abs(signed(q,a,u))>eps))return false;const near=(p.points[0].x-a.x)*u.x+(p.points[0].y-a.y)*u.y,far=(p.points.at(-1).x-a.x)*u.x+(p.points.at(-1).y-a.y)*u.y;if(near<previous-eps||far<near-eps)return false;previous=far;}
  return true;
}
export function unfoldCandidates(boundary){
  const parts=boundary.pieces,eps=tolerance(boundary),runs=[];
  for(let i=0;i<parts.length;i++){
    if(!parts[i].sourceId||!straight(parts[i].points,eps)){runs.push(null);continue;}
    const last=runs.at(-1);if(last&&canJoin(parts,last,[i],eps))last.push(i);else runs.push([i]);
  }
  if(runs.length>1&&runs[0]&&runs.at(-1)&&canJoin(parts,runs.at(-1),runs[0],eps)){runs[0]=[...runs.pop(),...runs[0]];}
  return runs.filter(Boolean).filter(indices=>indices.length<parts.length).map(indices=>{
    const a=parts[indices[0]].points[0],b=parts[indices.at(-1)].points.at(-1);
    return {id:'fold-'+indices[0],indices,a:{...a},b:{...b},world:[add(a,boundary.origin),add(b,boundary.origin)],length:distance(a,b)};
  }).filter(candidate=>candidate.length>=.001);
}
export function pickUnfoldEdge(boundary,world){
  const q={x:world.x-boundary.origin.x,y:world.y-boundary.origin.y};let best=null;
  for(const candidate of unfoldCandidates(boundary)){const hit=nearestBezier([candidate.a,candidate.b],q);if(!best||hit.distance<best.distance)best={...hit,candidate};}return best;
}
export function prepareUnfold(project,config,makeId){
  if(!config||typeof config.edgeId!=='string'||typeof config.keepOriginals!=='boolean'||typeof config.centerline!=='boolean'||typeof config.mirrorText!=='boolean')throw new Error('对折展开设置无效');
  const boundary=spreadBoundary(project,config.basis,config.gapTolerance),candidate=unfoldCandidates(boundary).find(c=>c.id===config.edgeId);
  if(!candidate)throw new Error('请选择轮廓上的直线折边；弯曲边不能作为对折轴');
  polygon(boundary.pieces);
  const {a,b,indices}=candidate,u=axis(a,b),eps=tolerance(boundary),removed=new Set(indices),rest=[];
  for(let k=1;k<=boundary.pieces.length;k++){const index=(indices.at(-1)+k)%boundary.pieces.length;if(!removed.has(index))rest.push(boundary.pieces[index]);}
  const ranges=rest.map(part=>range(power(part.points.map(p=>signed(p,a,u))))),extremes=ranges.flat(),farthest=extremes.reduce((best,p)=>Math.abs(p.value)>Math.abs(best.value)?p:best,{value:0}),side=Math.sign(farthest.value);
  if(!side||Math.abs(farthest.value)<=eps)throw new Error('半片轮廓退化，无法对折展开');
  ranges.forEach((samples,index)=>{for(const sample of samples){
    const allowed=(index===0&&sample.t===0)||(index===rest.length-1&&sample.t===1);
    if(sample.value*side< -eps)throw new Error('轮廓跨越对折轴；请选择半片边界上的折边');
    if(!allowed&&Math.abs(sample.value)<=eps)throw new Error('其余轮廓接触对折轴，展开会形成夹点或重叠边');
  }});
  const localMatrix=positionMatrix({operation:'mirror',a,b}),worldMatrix=positionMatrix({operation:'mirror',a:candidate.world[0],b:candidate.world[1]});
  const mirrored=[...rest].reverse().map(part=>({...part,points:[...part.points].reverse().map(p=>positionPoint(localMatrix,p)),reversed:!part.reversed,mirrored:true}));
  // Reflection fixes the fold endpoints mathematically; use their existing
  // stored coordinates so the full contour closes exactly after roundoff.
  mirrored[0].points[0]={...rest.at(-1).points.at(-1)};mirrored.at(-1).points[mirrored.at(-1).points.length-1]={...rest[0].points[0]};
  const parts=[...rest,...mirrored];polygon(parts);
  const areaBefore=Math.abs(boundary.pieces.reduce((sum,p)=>sum+bezierArea(p.points),0)),areaAfter=Math.abs(parts.reduce((sum,p)=>sum+bezierArea(p.points),0)),areaTolerance=Math.max(1e-6,areaBefore*1e-11,eps*boundary.total*4);
  if(Math.abs(areaAfter-2*areaBefore)>areaTolerance)throw new Error('展开面积未通过两倍面积核对');
  const byId=new Map(project.entities.map(e=>[e.id,e])),outputs=parts.map(part=>{
    const e=entityFromPart(part,boundary.origin,byId.get(part.sourceId)||{name:'容差连接边'},makeId(),'unfold','对折展开');e.source.unfold.role=part.mirrored?'mirrored-boundary':'original-boundary';return e;
  }),boundaryIds=outputs.map(e=>e.id),group=config.basis.groupId?project.groups.find(g=>g.id===config.basis.groupId):null,members=group?group.entityIds:config.basis.entityIds,sourceIds=members.filter(id=>{const e=byId.get(id);return e&&!e.derivedFrom&&!e.notchFrom;}),boundarySet=new Set(config.basis.entityIds),warnings=[];
  let axisOnlyCount=0,textCount=0,outsideCount=0;
  for(const sourceId of sourceIds.filter(id=>!boundarySet.has(id))){
    const entity=byId.get(sourceId),copy=clone(entity);copy.id=makeId();copy.name=(copy.name||'图元')+' · 对折展开';copy.source={...copy.source,modified:true,unfold:{entityId:sourceId,role:'original-internal'}};outputs.push(copy);
    if(entity.type==='text'){textCount++;if(!config.mirrorText)continue;}
    const controls=entity.curve?.controlPoints||entity.points,local=controls.map(p=>({x:p.x-boundary.origin.x,y:p.y-boundary.origin.y})),onAxis=entity.type!=='text'&&local.every(p=>Math.abs(signed(p,a,u))<=eps);
    if(onAxis){axisOnlyCount++;continue;}
    if(local.some(p=>signed(p,a,u)*side< -eps))outsideCount++;
    const mirror=clone(copy);mirror.id=makeId();mirror.points=mirror.points.map(p=>positionPoint(worldMatrix,p));mirror.source.unfold.role='mirrored-internal';
    if(mirror.curve){mirror.curve.controlPoints=mirror.curve.controlPoints.map(p=>positionPoint(worldMatrix,p));refreshCurve(mirror);}
    if(mirror.type==='text'){const radians=(mirror.rotation||0)*Math.PI/180,v=positionVector(worldMatrix,{x:Math.cos(radians),y:Math.sin(radians)});mirror.rotation=Math.atan2(v.y,v.x)*180/Math.PI;mirror.mirrorY=!Boolean(mirror.mirrorY);mirror.width=mirror.width||textWidth(mirror.text,mirror.height);}
    outputs.push(mirror);
  }
  let foldLineId=null;
  if(config.centerline){const e=entityFromPart({points:[a,b]},boundary.origin,{name:'对折线',layer:'internal'},makeId(),'unfold','展开');e.source.unfold.role='fold-line';foldLineId=e.id;outputs.push(e);}
  if(textCount)warnings.push(config.mirrorText?'文字内容保持原样，另一侧字形也按轴反射，请核对可读方向。':'文字只保留原侧一份，内容与位置不变。');
  if(outsideCount)warnings.push(outsideCount+' 项内部图元的控制点越过对折轴；已按整个图元镜像，请核对归属与重叠。');
  if(group?.contours?.length>1)warnings.push('其余轮廓按内部线复制和镜像；请核对净线与毛线用途。');
  const metadata={kind:'unfold',basis:clone(config.basis),fold:candidate.world,removedParts:indices.map(i=>({entityId:boundary.pieces[i].sourceId,piece:boundary.pieces[i].sourcePiece})),mirrorText:config.mirrorText,foldLineId};
  const {project:next,effects}=createCutProject(project,{config,outputs,boundaryIds,sourceIds,group,metadata,label:'对折展开'},makeId);
  return {project:next,signature:spreadStamp(project),config:clone(config),outputs,outputIds:outputs.map(e=>e.id),boundaryIds,sourceIds,effects,warnings,areaBefore,areaAfter,fold:candidate.world,foldLength:candidate.length,foldLineId,axisOnlyCount,textCount,bridges:boundary.bridges,removedPartCount:indices.length};
}
export function applyUnfold(project,preview){if(!preview||preview.signature!==spreadStamp(project))throw new Error('工程已变化，请重新预览对折展开结果');return {project:clone(preview.project),outputIds:[...preview.outputIds]};}
