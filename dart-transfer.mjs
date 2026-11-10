import { spreadBoundary, interval, polygon, entityFromPart, copyCutAttachments, createCutProject, assertCutInside, spreadStamp } from './spread.mjs';
import { stationOnPath } from './path-metrics.mjs';
import { bezierArea } from './bezier-cut.mjs';
const clone=v=>JSON.parse(JSON.stringify(v)),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),add=(a,b)=>({x:a.x+b.x,y:a.y+b.y}),sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y}),cross=(a,b)=>a.x*b.y-a.y*b.x,dot=(a,b)=>a.x*b.x+a.y*b.y;
const LEG_TOLERANCE=1e-6,STRAIGHT_TOLERANCE=1e-7;
const cyclic=(x,n)=>(x%n+n)%n;
function straight(points){
  const a=points[0],v=sub(points.at(-1),a),length=Math.hypot(v.x,v.y);if(!(length>0))return false;let previous=-Infinity;
  for(const p of points){const q=sub(p,a),t=dot(q,v)/length;if(Math.abs(cross(q,v))/length>STRAIGHT_TOLERANCE||t<previous-STRAIGHT_TOLERANCE||t< -STRAIGHT_TOLERANCE||t>length+STRAIGHT_TOLERANCE)return false;previous=t;}return true;
}
function legRun(boundary,index,direction,pivot){
  const pieces=boundary.pieces,n=pieces.length,indices=[];let end=pivot,total=0,chain=[pivot];
  for(let k=0;k<n-1;k++){
    const i=cyclic(index+k*direction,n),piece=pieces[i],near=direction<0?piece.points.at(-1):piece.points[0],far=direction<0?piece.points[0]:piece.points.at(-1);
    if(!piece.sourceId||distance(end,near)>STRAIGHT_TOLERANCE||distance(pivot,far)<=distance(pivot,end))break;
    // Recheck the full chain against its farthest endpoint. A tiny first span
    // must neither suppress a valid leg nor amplify its direction roundoff.
    const proposed=[...chain,...(direction<0?[...piece.points].reverse():piece.points)];
    if(!straight(proposed))break;
    indices.push(i);end=far;total+=piece.length;chain=proposed;
  }
  if(!indices.length||distance(pivot,end)<.001)return null;const outer=pieces[indices.at(-1)],station=direction<0?outer.start:cyclic(outer.start+outer.length,boundary.total);
  return {indices,outer:end,station,length:distance(pivot,end),pathLength:total};
}
export function dartCandidates(boundary){
  const pieces=boundary.pieces,n=pieces.length,winding=Math.sign(pieces.reduce((sum,p)=>sum+bezierArea(p.points),0)),result=[];
  for(let i=0;i<n;i++){
    const before=pieces[cyclic(i-1,n)],after=pieces[i],pivot=after.points[0];
    if(distance(before.points.at(-1),pivot)>STRAIGHT_TOLERANCE||!straight(before.points)||!straight(after.points))continue;
    const first=legRun(boundary,cyclic(i-1,n),-1,pivot),second=legRun(boundary,i,1,pivot);if(!first||!second||first.indices.some(id=>second.indices.includes(id)))continue;
    const a=sub(first.outer,pivot),b=sub(second.outer,pivot),scale=first.length*second.length;if(cross(a,b)*winding<=scale*1e-10)continue;
    const angle=Math.atan2(Math.abs(cross(a,b)),dot(a,b))*180/Math.PI;if(angle<=.0001||angle>=170)continue;
    result.push({id:'dart-'+i,index:i,pivot:{...pivot},mouth1:{...first.outer},mouth2:{...second.outer},firstStation:first.station,apexStation:after.start,lastStation:second.station,firstLength:first.length,secondLength:second.length,lengthDifference:Math.abs(first.length-second.length),angle,legIndices:[...first.indices,...second.indices],world:{pivot:add(pivot,boundary.origin),mouth1:add(first.outer,boundary.origin),mouth2:add(second.outer,boundary.origin)}});
  }return result.sort((a,b)=>a.angle-b.angle);
}
function cycleInterval(boundary,a,b){return a<b?interval(boundary,a,b):[...interval(boundary,a,boundary.total),...interval(boundary,0,b)];}
function shapeDart(pivot,a,b,retreat,role){
  const center={x:(a.x+b.x)/2,y:(a.y+b.y)/2},axis=sub(center,pivot),depth=Math.hypot(axis.x,axis.y);
  if(retreat>=depth||depth-retreat<.001)throw new Error((role==='new'?'新省':'剩余原省')+'退量过大，退尖后中心深度须至少 0.001 mm');
  const tip=retreat?{x:pivot.x+axis.x/depth*retreat,y:pivot.y+axis.y/depth*retreat}:{...pivot},u=sub(a,tip),v=sub(b,tip),width=distance(a,b),angle=Math.atan2(Math.abs(cross(u,v)),dot(u,v))*180/Math.PI;
  // Moving the tip toward the mouth fills a triangle; it does not preserve area.
  const areaAdded=Math.abs(cross(sub(b,a),sub(tip,pivot)))/2;
  return {role,tip,mouth:[a,b],center,width,depth:depth-retreat,legLengths:[Math.hypot(u.x,u.y),Math.hypot(v.x,v.y)],angle,retreat,areaAdded};
}
export function prepareDartTransfer(project,config,makeId){
  if(!config||!['after','before'].includes(config.side)||!['fixed','moving'].includes(config.onCut)||typeof config.keepOriginals!=='boolean'||typeof config.dartId!=='string')throw new Error('转省设置无效');
  const transferPercent=config.transferPercent===undefined?100:config.transferPercent,newTipRetreat=config.newTipRetreat===undefined?0:config.newTipRetreat,remainingTipRetreat=config.remainingTipRetreat===undefined?0:config.remainingTipRetreat;
  if(!Number.isFinite(transferPercent)||transferPercent<=0||transferPercent>100)throw new Error('省角转移比例须大于 0 且不超过 100%');
  if(!Number.isFinite(newTipRetreat)||!Number.isFinite(remainingTipRetreat)||newTipRetreat<0||remainingTipRetreat<0)throw new Error('省尖退量须为非负有限毫米数');
  const partial=transferPercent<100;
  if(partial&&newTipRetreat===0&&remainingTipRetreat===0)throw new Error('部分转省须设置至少一处省尖退量，避免两省共尖造成轮廓夹点');
  if(!partial&&remainingTipRetreat!==0)throw new Error('整省转移无剩余原省，原省尖退量须为 0');
  const boundary=spreadBoundary(project,config.basis,config.gapTolerance),candidates=dartCandidates(boundary),dart=candidates.find(d=>d.id===config.dartId),{origin}=boundary;
  if(!dart)throw new Error('未找到所选直线省口，请重新记录裁片并确认省口');
  if(dart.lengthDifference>LEG_TOLERANCE)throw new Error('两条省边长度不等，差 '+dart.lengthDifference.toFixed(8)+' mm；须先修整至差值 ≤ 0.000001 mm');
  if(!Number.isFinite(config.target)||config.target<0||config.target>=100)throw new Error('新省口位置须为 0（含）至 100（不含）的周长百分比');
  const target=config.target/100*boundary.total;
  const oldArc=cyclic(dart.lastStation-dart.firstStation,boundary.total),along=cyclic(target-dart.firstStation,boundary.total);if(along<=oldArc+1e-5||boundary.total-along<1e-5)throw new Error('新省口不能位于所选原省边或省尖');
  const P=dart.pivot,D1=dart.mouth1,D2=dart.mouth2,station=stationOnPath(boundary,target,{pointOnly:true}),T=sub(station.point,origin),pivotToTarget=distance(P,T),sourcePath=polygon(boundary.pieces);
  assertCutInside(boundary,P,T,sourcePath);
  const after=config.side==='after',movingBase=cycleInterval(boundary,after?dart.apexStation:target,after?target:dart.apexStation),fixedBase=cycleInterval(boundary,after?target:dart.apexStation,after?dart.apexStation:target);
  const movingPath=polygon([...movingBase,{points:[movingBase.at(-1).points.at(-1),movingBase[0].points[0]]}]),fixedPath=polygon([...fixedBase,{points:[fixedBase.at(-1).points.at(-1),fixedBase[0].points[0]]}]);
  const from=sub(after?D2:D1,P),to=sub(after?D1:D2,P),fLength=Math.hypot(from.x,from.y),tLength=Math.hypot(to.x,to.y),u={x:from.x/fLength,y:from.y/fLength},v={x:to.x/tLength,y:to.y/tLength},cosine=dot(u,v),sine=cross(u,v),norm=Math.hypot(cosine,sine),fullRadians=Math.atan2(sine,cosine),radians=fullRadians*transferPercent/100,c=partial?Math.cos(radians):cosine/norm,s=partial?Math.sin(radians):sine/norm;
  const move=p=>({x:P.x+(p.x-P.x)*c-(p.y-P.y)*s,y:P.y+(p.x-P.x)*s+(p.y-P.y)*c}),closure=partial?null:distance(move(after?D2:D1),after?D1:D2);if(closure!==null&&closure>LEG_TOLERANCE)throw new Error('原省口闭合残差超过 0.000001 mm，请修整省边');
  // The complete selected old legs are removed by source identity. Summed
  // arc stations may round to the preceding span and leave a tiny remnant.
  const legKey=p=>JSON.stringify([p.sourceId,p.sourcePiece]),removedLegs=new Set(dart.legIndices.map(i=>legKey(boundary.pieces[i]))),withoutOldLegs=parts=>parts.filter(p=>!removedLegs.has(legKey(p)));
  const first=withoutOldLegs(cycleInterval(boundary,dart.lastStation,target)).map(p=>({...p,points:after?p.points.map(move):p.points,moving:after})),last=withoutOldLegs(cycleInterval(boundary,target,dart.firstStation)).map(p=>({...p,points:after?p.points:p.points.map(move),moving:!after}));
  if(!first.length||!last.length)throw new Error('新省口离原省边过近');
  // A roundoff-sized closure residual is explicitly reported. Snap only the
  // touching outer endpoint; both removed old dart legs are absent in output.
  if(!partial){if(after)first[0].points[0]={...last.at(-1).points.at(-1)};else last.at(-1).points[last.at(-1).points.length-1]={...first[0].points[0]};}
  // Use the endpoints of the actual native slices. Re-evaluating the same
  // station separately can introduce an ULP-sized backtracking connector.
  const newShape=shapeDart(P,first.at(-1).points.at(-1),last[0].points[0],newTipRetreat,'new'),remainingShape=partial?shapeDart(P,last.at(-1).points.at(-1),first[0].points[0],remainingTipRetreat,'remaining'):null;
  const newLegs=[{points:[newShape.mouth[0],newShape.tip],newDart:true,moving:after},{points:[newShape.tip,newShape.mouth[1]],newDart:true,moving:!after}],remainingLegs=remainingShape?[{points:[remainingShape.mouth[0],remainingShape.tip],remainingDart:true,moving:!after},{points:[remainingShape.tip,remainingShape.mouth[1]],remainingDart:true,moving:after}]:[],parts=[...first,...newLegs,...last,...remainingLegs];
  try{polygon(parts);}catch(error){throw new Error('转省结果的轮廓检查未通过：'+error.message+'；请调整转移比例、省尖退量或新省口位置',{cause:error});}
  const areaBefore=Math.abs(boundary.pieces.reduce((sum,p)=>sum+bezierArea(p.points),0)),areaAfter=Math.abs(parts.reduce((sum,p)=>sum+bezierArea(p.points),0)),areaAdded=newShape.areaAdded+(remainingShape?.areaAdded||0),expectedArea=areaBefore+areaAdded,areaTolerance=Math.max(1e-6,areaBefore*1e-11,(closure||0)*boundary.total);
  if(Math.abs(areaAfter-expectedArea)>areaTolerance)throw new Error('转省结果未通过面积与退尖增量核对，请调整位置');
  const byId=new Map(project.entities.map(e=>[e.id,e])),outputs=parts.map(p=>{const e=entityFromPart(p,origin,byId.get(p.sourceId)||{name:p.newDart?'新省边':p.remainingDart?'剩余原省边':'连接边'},makeId(),'dartTransfer','转省');if(p.newDart||p.remainingDart)e.source.dartTransfer.role=p.newDart?'new-leg':'remaining-leg';return e;}),boundaryIds=outputs.map(e=>e.id),newLegIds=parts.flatMap((p,i)=>p.newDart?[outputs[i].id]:[]),remainingLegIds=parts.flatMap((p,i)=>p.remainingDart?[outputs[i].id]:[]);
  const attachments=copyCutAttachments(project,{config,origin,A:P,B:T,movingPath,fixedPath,move,radians,operation:'dartTransfer',label:'转省'},makeId);outputs.push(...attachments.outputs);
  const {group,sourceIds,warnings,splitCount}=attachments;
  for(const shape of [newShape,remainingShape].filter(Boolean))if(shape.angle>=170)warnings.push((shape.role==='new'?'新省':'剩余原省')+'实际省角达到 '+shape.angle.toFixed(6)+'°；当前省口候选只识别小于 170°，该省不能直接再次转省，请核对退量');
  if(config.centerline!==undefined&&typeof config.centerline!=='boolean')throw new Error('省中心线设置无效');
  if(config.centerline)for(const shape of [newShape,remainingShape].filter(Boolean)){const centerline=entityFromPart({points:[shape.tip,shape.center],sourceId:null},origin,{name:shape.role==='new'?'新省中心线':'剩余原省中心线',layer:'internal'},makeId(),'dartTransfer','转省');centerline.source.dartTransfer.role=shape.role==='new'?'centerline':'remaining-centerline';outputs.push(centerline);}
  const worldShape=shape=>shape?{...shape,tip:add(shape.tip,origin),mouth:shape.mouth.map(p=>add(p,origin)),center:add(shape.center,origin)}:null,newDartShape=worldShape(newShape),remainingDartShape=worldShape(remainingShape);
  const metadata={kind:'dart-transfer',basis:clone(config.basis),pivot:dart.world.pivot,oldMouth:[dart.world.mouth1,dart.world.mouth2],target:station.point,side:config.side,angle:radians*180/Math.PI,transferPercent,newTipRetreat,remainingTipRetreat,closureResidual:closure,newLegIds,remainingLegIds,darts:[newDartShape,remainingDartShape].filter(Boolean),areaAdded};
  const {project:next,effects}=createCutProject(project,{config,outputs,boundaryIds,sourceIds,group,metadata,label:'转省'},makeId);
  return {project:next,signature:spreadStamp(project),config:clone({...config,transferPercent,newTipRetreat,remainingTipRetreat}),outputs,outputIds:outputs.map(e=>e.id),boundaryIds,newLegIds,remainingLegIds,movingIds:outputs.filter(e=>e.source?.dartTransfer?.attachment==='moving').map(e=>e.id),sourceIds,effects,warnings,splitCount,dart,partial,transferPercent,newDartShape,remainingDartShape,cut:[dart.world.pivot,station.point],newDart:[newDartShape.mouth[0],newDartShape.tip,newDartShape.mouth[1]],closedPoint:partial?null:add(after?D1:D2,origin),areaBefore,areaAfter,areaAdded,expectedArea,areaTolerance,closureResidual:closure,angle:radians*180/Math.PI,remainingAngle:Math.abs(fullRadians-radians)*180/Math.PI,pivotToTarget,newLength:newShape.legLengths[0],oldWidth:distance(D1,D2),newWidth:newShape.width,remainingWidth:remainingShape?.width||0,bridges:boundary.bridges};
}
export function applyDartTransfer(project,preview){if(!preview||preview.signature!==spreadStamp(project))throw new Error('工程已变化，请重新预览转省结果');return {project:clone(preview.project),outputIds:[...preview.outputIds]};}
