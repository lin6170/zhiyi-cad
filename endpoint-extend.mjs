import {endpointContinuation,continuationSearch,continuationPiece} from './extension-math.mjs';
import {intersectBezier,compareIntersectionParameters} from './intersections.mjs';
import {nativeParts} from './intersection-trim.mjs';
import {refreshCurve,validateCurve} from './curves.mjs';
import {validateProject} from './geometry.mjs';
import {contoursForGroup} from './topology.mjs';
import {lineEditStamp,replaceGroups,dependencies,applyLineEdit} from './line-edit.mjs';
const clone=v=>JSON.parse(JSON.stringify(v)),same=(p,q)=>p.x===q.x&&p.y===q.y;
const overlap=(a,b)=>a.minX<=b.maxX&&b.minX<=a.maxX&&a.minY<=b.maxY&&b.minY<=a.maxY;
const originParameter={parameterA:0,parameterIntervalA:[0,0],parameterEquationA:['0','1']};

function assemble(source,piece,continuation,id){
  const entity=clone(source);entity.id=id;entity.name=source.name+' · 延伸';entity.modified=true;entity.closed=false;
  const first=continuation.end==='start',controls=source.curve?.controlPoints||source.points,anchor=first?controls[0]:controls.at(-1);
  if(!same(piece.points[0],anchor))throw new Error('延伸段起点与原端点不一致，未移动或补线');
  if(source.curve){
    const {degree,knots,controlPoints}=source.curve,points=piece.points;
    if(points.length!==degree+1)throw new Error('延伸段阶数与原曲线不一致');
    if(controlPoints.length+degree>1002)throw new Error('延伸后控制点超过 1002 个');
    const width=(continuation.knotRange[1]-continuation.knotRange[0])*piece.nativeParameterExtent;
    if(!(width>0)||!Number.isFinite(width))throw new Error('延伸后的样条结点范围无效');
    if(first){
      const start=knots[0]-width;if(!Number.isFinite(start)||!(start<knots[0]))throw new Error('无法在原样条起点之前表示新的结点');
      entity.curve={...source.curve,controlPoints:[...points.slice(1).reverse().map(p=>({...p})),...controlPoints.map(p=>({...p}))],knots:[...Array(degree+1).fill(start),...knots.slice(1)]};
    }else{
      const end=knots.at(-1)+width;if(!Number.isFinite(end)||!(end>knots.at(-1)))throw new Error('无法在原样条终点之后表示新的结点');
      entity.curve={...source.curve,controlPoints:[...controlPoints.map(p=>({...p})),...points.slice(1).map(p=>({...p}))],knots:[...knots.slice(0,-1),...Array(degree+1).fill(end)]};
    }
    validateCurve(entity.curve);refreshCurve(entity);
  }else{
    const end=piece.points.at(-1);entity.points=source.points.map(p=>({...p}));entity.points[first?0:entity.points.length-1]={...end};
    // A zero-length terminal edge keeps the previous endpoint as the start of
    // the new straight extension. Earlier original vertices remain untouched.
  }
  return entity;
}

export function prepareEndpointExtension(project,{targetId,referenceIds,end='end',mode='native',maxLength=100,errorTolerance=1e-6,lengthTolerance=1e-4,keepOriginals=false,maxPairs=2048,maxOperations=2000000,maxLengthSegments=4096}={}){
  if(project.units!=='mm')throw new Error('请先确认毫米比例，再延伸端点');
  if(!Number.isFinite(errorTolerance)||errorTolerance<=0||errorTolerance>.01||!Number.isFinite(lengthTolerance)||lengthTolerance<=0||lengthTolerance>.01)throw new Error('几何误差和长度核对精度须大于 0 且不超过 0.01 mm');
  if(typeof keepOriginals!=='boolean'||!Number.isInteger(maxPairs)||maxPairs<1||!Number.isInteger(maxOperations)||maxOperations<1)throw new Error('延伸设置或计算上限无效');
  const source=project.entities.find(e=>e.id===targetId);
  if(!source||source.type==='text'||source.closed||source.derivedFrom||source.notchFrom)throw new Error('目标须为一条开放的原始线；关联输出须先解除关联');
  if(!Array.isArray(referenceIds)||!referenceIds.length||referenceIds.length>64||new Set(referenceIds).size!==referenceIds.length||referenceIds.includes(targetId))throw new Error('请选择 1 至 64 条不同参考线，不能包含目标线');
  const references=referenceIds.map(id=>project.entities.find(e=>e.id===id));if(references.some(e=>!e||e.type==='text'))throw new Error('参考线已删除或不是线条');
  const continuation=endpointContinuation(source,end,mode),search=continuationSearch(continuation,maxLength),parts=[];
  for(const entity of references){for(const [i,part] of nativeParts(entity).entries())parts.push({...part,entityId:entity.id,partIndex:i});if(parts.length>4096)throw new Error('参考线原生分段超过 4096 个');}
  const hits=[],stats={pairs:0,operations:0,referenceParts:parts.length};
  for(const part of parts){
    if(!overlap(search.bounds,part.bounds))continue;
    if(++stats.pairs>maxPairs||stats.operations>=maxOperations)throw new Error('延伸交点计算超过上限，未采用部分结果');
    const result=intersectBezier(search.points,part.points,{firstPower:search.exactPower,secondPower:part.exactPower,coordinateLimit:1e12,parameterCertificates:true,maxOperations:Math.min(100000,maxOperations-stats.operations)});stats.operations+=result.operations;
    for(const hit of result.hits)if(compareIntersectionParameters(hit,originParameter)>0)hits.push({...hit,contributors:[{entityId:part.entityId,partIndex:part.partIndex,parameter:hit.parameterB}]});
    if(hits.length>4096)throw new Error('延伸候选交点超过上限');
  }
  hits.sort(compareIntersectionParameters);const candidates=[];
  for(const hit of hits){const previous=candidates.at(-1);if(previous&&compareIntersectionParameters(previous,hit)===0)previous.contributors.push(...hit.contributors);else candidates.push(hit);}
  if(!candidates.length)throw new Error('最大延伸长度范围内未找到可确定的参考交点');
  const hit=candidates[0],piece=continuationPiece(continuation,search,hit,{errorTolerance,lengthTolerance,maxLengthSegments});
  if(piece.lengthBounds.upper>maxLength)throw new Error(piece.lengthBounds.lower>maxLength?'最近交点所需延伸长度超过上限':'最近交点的长度上界仍超过上限，请增大长度上限或提高长度核对精度');
  const used=new Set(project.entities.map(e=>e.id));let serial=0,id;do{id='extend-preview-'+(++serial);}while(used.has(id));
  const output=assemble(source,piece,continuation,id);
  output.source={...clone(source.source||{}),lineEdit:{operation:'extend',entityIds:[targetId],referenceIds:[...referenceIds],end,mode,maxLength,errorBound:piece.errorBound,lengthBounds:piece.lengthBounds,parameterExtent:piece.nativeParameterExtent}};
  const next=clone(project),dissolved=keepOriginals?[]:replaceGroups(next,[targetId],[output],'extend');
  if(!keepOriginals)next.entities=next.entities.filter(e=>e.id!==targetId);next.entities.push(output);validateProject(next);
  return {project:next,outputs:[output],signature:lineEditStamp(project),config:{targetId,referenceIds:[...referenceIds],end,mode,maxLength,errorTolerance,lengthTolerance,keepOriginals},continuation,piece,hit,candidateCount:candidates.length,stats,effects:keepOriginals?[]:dependencies(project,[targetId]),dissolved,affectedContours:keepOriginals?[]:(project.groups||[]).filter(g=>contoursForGroup(g).some(c=>c.entityIds.includes(targetId))).map(g=>g.name)};
}

export const applyEndpointExtension=applyLineEdit;
