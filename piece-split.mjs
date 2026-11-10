import { spreadBoundary, interval, polygon, assertCutInside, entityFromPart, spreadStamp, assertStoredBoundary } from './spread.mjs';
import { pathMetrics } from './path-metrics.mjs';
import { evaluateBezier, sliceBezier, bezierLineHits, bezierArea, polynomialRoots, power } from './bezier-cut.mjs';
import { nativeLocator } from './native-location.mjs';
import { validateProject, textWidth } from './geometry.mjs';
import { dependencies } from './line-edit.mjs';
import { syncAllowances } from './seams.mjs';
import { syncNotches } from './notches.mjs';
import { syncSeamChecks } from './seam-checks.mjs';
import { syncGradingPlans } from './grading.mjs';
import { syncMarkerPlans } from './marker.mjs';
const clone=v=>JSON.parse(JSON.stringify(v)),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),add=(a,b)=>({x:a.x+b.x,y:a.y+b.y}),sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const cycleInterval=(boundary,a,b)=>a<b?interval(boundary,a,b):[...interval(boundary,a,boundary.total),...interval(boundary,0,b)];
export function preparePieceSplit(project,config,makeId){
  if(!config||typeof config.keepOriginals!=='boolean'||!['first','second','both'].includes(config.onCut)||!['first','second'].includes(config.outside))throw new Error('裁片分割设置无效');
  for(const key of ['a','b'])if(!Number.isFinite(config[key])||config[key]<0||config[key]>=100)throw new Error('切点位置须为 0（含）至 100（不含）的轮廓弧长百分比');
  const boundary=spreadBoundary(project,config.basis,config.gapTolerance),{origin}=boundary,a=config.a/100*boundary.total,b=config.b/100*boundary.total;
  if(Math.min(Math.abs(a-b),boundary.total-Math.abs(a-b))<1e-5)throw new Error('切点 A、B 必须不同');
  const first=cycleInterval(boundary,a,b),second=cycleInterval(boundary,b,a);
  if(!first.length||!second.length)throw new Error('分片轮廓为空，请调整切点');
  const A=first[0].points[0],B=first.at(-1).points.at(-1),cutLength=distance(A,B),originalPath=polygon(boundary.pieces);
  assertCutInside(boundary,A,B,originalPath);
  const parts=[first.concat({points:[B,A],cutEdge:true}),second.concat({points:[A,B],cutEdge:true})];parts.forEach(polygon);
  const areaBefore=Math.abs(boundary.pieces.reduce((sum,p)=>sum+bezierArea(p.points),0)),areas=parts.map(list=>Math.abs(list.reduce((sum,p)=>sum+bezierArea(p.points),0))),areaTolerance=Math.max(1e-6,areaBefore*1e-11);
  if(Math.abs(areas[0]+areas[1]-areaBefore)>areaTolerance)throw new Error('两片面积之和未通过原片面积核对');
  let scale=1;for(const part of boundary.pieces)for(const p of part.points)scale=Math.max(scale,Math.abs(p.x),Math.abs(p.y));
  const epsilon=scale*Number.EPSILON*64+Math.max(1,Math.abs(origin.x),Math.abs(origin.y))*Number.EPSILON*4,locators=parts.map(list=>nativeLocator(list,epsilon));
  const byId=new Map(project.entities.map(e=>[e.id,e])),group=config.basis.groupId?project.groups.find(g=>g.id===config.basis.groupId):null,boundarySet=new Set(config.basis.entityIds),sourceIds=(group?group.entityIds:config.basis.entityIds).filter(id=>{const e=byId.get(id);return e&&!e.derivedFrom&&!e.notchFrom;}),warnings=[],pieces=parts.map((list,index)=>{
    const outputs=list.map(part=>{const e=entityFromPart(part,origin,byId.get(part.sourceId)||{name:part.cutEdge?'新分割边':'容差连接边'},makeId(),'pieceSplit','分片 '+(index+1));e.source.pieceSplit={...e.source.pieceSplit,part:index+1,role:part.cutEdge?'cut-edge':'boundary'};return e;});return {part:index+1,outputs,boundaryIds:outputs.map(e=>e.id),area:areas[index],cutEdgeId:outputs.at(-1).id};
  });
  pieces.forEach(piece=>assertStoredBoundary(piece.outputs,piece.boundaryIds));
  const cutVector=sub(B,A),cutSquared=cutLength**2,onCut=p=>{const q=sub(p,A),t=(q.x*cutVector.x+q.y*cutVector.y)/cutSquared;return t>=-epsilon/cutLength&&t<=1+epsilon/cutLength&&Math.abs(q.x*cutVector.y-q.y*cutVector.x)/cutLength<=epsilon;};
  let splitCount=0,onCutCount=0,outsideCount=0,duplicatedCount=0,textCount=0;
  function owners(p){
    if(onCut(p)){onCutCount++;if(config.onCut==='both'){duplicatedCount++;return [0,1];}return [config.onCut==='first'?0:1];}
    const hits=locators.map(l=>l(p));if(hits[0]>=0&&hits[1]>=0)throw new Error('内部图元的分片归属不明确，请调整切线或图元位置');
    if(hits[0]>=0)return [0];if(hits[1]>=0)return [1];outsideCount++;return [config.outside==='first'?0:1];
  }
  function push(source,part,index){const e=entityFromPart(part,origin,source,makeId(),'pieceSplit','分片 '+(index+1));e.source.pieceSplit={...e.source.pieceSplit,part:index+1,role:'internal'};pieces[index].outputs.push(e);return e;}
  for(const sourceId of sourceIds.filter(id=>!boundarySet.has(id))){
    const entity=byId.get(sourceId);
    if(entity.type==='text'){
      textCount++;for(const index of owners(sub(entity.points[0],origin))){const e=clone(entity);e.id=makeId();e.name=(e.name||'文字')+' · 分片 '+(index+1);e.width=e.width||textWidth(e.text,e.height);e.source={...e.source,modified:true,pieceSplit:{entityId:sourceId,part:index+1,role:'text'}};pieces[index].outputs.push(e);}continue;
    }
    const metrics=pathMetrics(entity,{preserveShortPieces:true}),plans=[];let entitySplits=0;
    metrics.pieces.forEach((piece,sourcePiece)=>{
      const points=piece.points.map(p=>add(p,sub(metrics.origin,origin))),hits=bezierLineHits(points,A,B);let parameters=hits.hits.map(hit=>hit.t);
      if(hits.collinear){const projections=points.map(p=>{const q=sub(p,A);return (q.x*cutVector.x+q.y*cutVector.y)/cutSquared;});parameters=[...polynomialRoots(power(projections)),...polynomialRoots(power(projections.map(x=>x-1)))];}
      const cuts=[0,...parameters.filter(t=>t>0&&t<1),1].sort((x,y)=>x-y).filter((t,i,all)=>!i||t!==all[i-1]);entitySplits+=cuts.length-2;
      for(let i=0;i<cuts.length-1;i++){
        const controls=sliceBezier(points,cuts[i],cuts[i+1]),part={points:controls,sourceId,sourcePiece,t0:cuts[i],t1:cuts[i+1]};
        plans.push({part,owners:owners(evaluateBezier(controls,.5)),arrowStart:sourcePiece===0&&i===0&&entity.arrowStart,arrowEnd:sourcePiece===metrics.pieces.length-1&&i===cuts.length-2&&entity.arrowEnd});
      }
    });
    // A tangent touch or span boundary need not fragment an internal curve if
    // every interval belongs to the same piece(s). Retain its closure and knots.
    if(plans.length&&plans.every(p=>p.owners.join(',')===plans[0].owners.join(','))){
      for(const index of plans[0].owners){const e=clone(entity);e.id=makeId();e.name=(e.name||'内部线')+' · 分片 '+(index+1);e.source={...e.source,modified:true,pieceSplit:{entityId:sourceId,part:index+1,role:'internal',wholeEntity:true}};pieces[index].outputs.push(e);}
    }else{
      splitCount+=entitySplits;
      for(const plan of plans)for(const index of plan.owners){const e=push(entity,plan.part,index);if(entity.layer==='grain'?entity.arrowStart:plan.arrowStart)e.arrowStart=true;if(entity.layer==='grain'?entity.arrowEnd:plan.arrowEnd)e.arrowEnd=true;}
    }
  }
  if(textCount)warnings.push('文字按锚点归属，整项保留原内容、位置和字形；跨切线的文字框不会被截断。');
  if(sourceIds.length>boundarySet.size)warnings.push('内部线在有限切线处切分，以各段中点判断归属；越出原轮廓的延伸部分不会被裁除，请核对。');
  if(onCutCount)warnings.push(onCutCount+' 项位于有限切线上，按设置分配到'+(config.onCut==='both'?'两片':config.onCut==='first'?'分片 1':'分片 2')+'。');
  if(outsideCount)warnings.push(outsideCount+' 项的定位点在两片轮廓外，保留在'+(config.outside==='first'?'分片 1':'分片 2')+'，请核对归属。');
  if(group?.contours?.length>1)warnings.push('其余轮廓按内部线处理；请确认所选为需要分割的净线轮廓。');
  const next=clone(project),effects=dependencies(project,sourceIds),cut=[add(A,origin),add(B,origin)];
  if(!config.keepOriginals){const removed=new Set(sourceIds);next.entities=next.entities.filter(e=>!removed.has(e.id));next.groups=next.groups.map(g=>({...g,entityIds:g.entityIds.filter(id=>!removed.has(id))})).filter(g=>g.entityIds.length>=2);}
  for(const piece of pieces){piece.groupId=makeId();next.entities.push(...piece.outputs);next.groups.push({id:piece.groupId,name:(group?.name||config.basis.name||'裁片')+' · 分片 '+piece.part,entityIds:piece.outputs.map(e=>e.id),contours:[{role:'primary-contour',entityIds:[...piece.boundaryIds]}],source:{kind:'piece-split',part:piece.part,basis:clone(config.basis),cut,cutEdgeId:piece.cutEdgeId,onCut:config.onCut,outside:config.outside}});}
  validateProject(next);syncAllowances(next,makeId);syncNotches(next,makeId);syncSeamChecks(next);syncGradingPlans(next);syncMarkerPlans(next);
  const arcFirst=a<b?b-a:boundary.total-a+b,outputs=pieces.flatMap(p=>p.outputs);
  return {project:next,signature:spreadStamp(project),config:clone(config),pieces,outputs,outputIds:outputs.map(e=>e.id),sourceIds,effects,warnings,cut,cutLength,areaBefore,areas,perimeters:[arcFirst+cutLength,boundary.total-arcFirst+cutLength],originalPerimeter:boundary.total,splitCount,onCutCount,outsideCount,duplicatedCount,textCount,bridges:boundary.bridges};
}
export function applyPieceSplit(project,preview){if(!preview||preview.signature!==spreadStamp(project))throw new Error('工程已变化，请重新预览分片结果');return {project:clone(preview.project),outputIds:[...preview.outputIds]};}
