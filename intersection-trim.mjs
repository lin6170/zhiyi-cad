import {prepareIntersectionSpans,intersectBezier,compareIntersectionParameters,restrictNativeSpan} from './intersections.mjs';
import {refreshCurve,curveLength} from './curves.mjs';
import {validateProject} from './geometry.mjs';
import {contoursForGroup} from './topology.mjs';
import {dependencies,replaceGroups,lineEditStamp,applyLineEdit} from './line-edit.mjs';

const clone=v=>JSON.parse(JSON.stringify(v)),same=(p,q)=>p.x===q.x&&p.y===q.y;
const endpoint=(partIndex,t=0)=>({partIndex,parameterA:t,parameterIntervalA:[t,t],parameterEquationA:[String(-t),'1'],contributors:[]});
const compare=(a,b)=>a.partIndex-b.partIndex||compareIntersectionParameters(a,b);
const overlap=(a,b)=>a.minX<=b.maxX&&b.minX<=a.maxX&&a.minY<=b.maxY&&b.minY<=a.maxY;

export function nativeParts(entity){
  if(!entity.curve&&entity.points.length-(entity.closed?0:1)>4096)throw new Error('原生分段超过 4096 个，请先剪开目标或减少参考线');
  const raw=entity.curve?prepareIntersectionSpans(entity.curve):entity.points.slice(1).map((p,i)=>({points:[entity.points[i],p],segmentIndex:i}));
  const controls=entity.curve?.controlPoints||entity.points;
  if(entity.closed&&!same(controls.at(-1),controls[0]))raw.push({points:[controls.at(-1),controls[0]],segmentIndex:controls.length-1,closing:true});
  const parts=[];
  for(const span of raw){
    const geometry=restrictNativeSpan(span.points,0,1,{exactPower:span.exactPower,degree:entity.curve?.degree||1});
    // Only algebraically constant spans disappear. Rounded control points are
    // not a test of whether a tiny native span is constant.
    if(!geometry.constant)parts.push({...span,bounds:geometry.bounds});
  }
  if(!parts.length)throw new Error('所选线没有非零的原生线段');
  return parts;
}

function rangeSpans(analysis,start,end){
  const {parts,degree,errorTolerance}=analysis,n=parts.length,wrap=compare(start,end)>0;
  if(wrap&&!analysis.closed)throw new Error('开放线修剪区间顺序无效');
  const stop=end.partIndex+(wrap?n:0),spans=[];
  for(let i=start.partIndex;i<=stop;i++){
    const a=i===start.partIndex?start.parameterA:0,b=i===stop?end.parameterA:1;
    if(a===b){if(i===start.partIndex&&i===stop)throw new Error('不同切点无法用当前数值精度分离，未生成修剪结果');continue;}
    if(b<a)throw new Error('切点数值参数顺序不一致');
    const part=parts[i%n],slice=restrictNativeSpan(part.points,a,b,{exactPower:part.exactPower,degree,startInterval:i===start.partIndex?start.parameterIntervalA:[0,0],endInterval:i===stop?end.parameterIntervalA:[1,1]});
    if(slice.errorBound>errorTolerance)throw new Error('原生修剪误差上界 '+slice.errorBound.toExponential(3)+' mm 超过设置的 '+errorTolerance+' mm');
    if(slice.points.every(p=>same(p,slice.points[0])))throw new Error('保留区间在数值换算后坍缩，未生成修剪结果');
    if(spans.length&&!same(spans.at(-1).points.at(-1),slice.points[0]))throw new Error('相邻原生段端点换算不一致，不能自动补线或移动端点');
    spans.push({...slice,partIndex:i%n,parameterRange:[a,b]});
  }
  if(!spans.length)throw new Error('修剪区间为空');return spans;
}

function assemble(source,spans,id,name){
  const degree=source.curve?.degree||1,entity={id,name,type:'polyline',closed:false,layer:source.layer,modified:true,source:clone(source.source||{}),points:[...spans[0].points]};
  if(degree===1)entity.points=[spans[0].points[0],...spans.map(span=>span.points.at(-1))].map(p=>({...p}));
  else{
    const controlPoints=[...spans[0].points];for(const span of spans.slice(1))controlPoints.push(...span.points.slice(1));
    if(controlPoints.length>1002)throw new Error('修剪结果控制点超过 1002 个，请减少原线分段');
    const knots=[...Array(degree+1).fill(0)];for(let i=1;i<spans.length;i++)knots.push(...Array(degree).fill(i));knots.push(...Array(degree+1).fill(spans.length));
    entity.curve={kind:'bspline',degree,controlPoints:controlPoints.map(p=>({...p})),knots,samplingTolerance:source.curve.samplingTolerance??.002};refreshCurve(entity);
  }
  return entity;
}

function lengthOf(entity){
  if(entity.curve){const m=curveLength(entity.curve);return {length:m.value,lengthEstimatedError:m.estimatedError,lengthConverged:m.converged};}
  return {length:entity.points.slice(1).reduce((s,p,i)=>s+Math.hypot(p.x-entity.points[i].x,p.y-entity.points[i].y),0),lengthEstimatedError:0,lengthConverged:true};
}

export function analyzeIntersectionTrim(project,{targetId,cutterIds,errorTolerance=1e-6,maxPairs=2048,maxOperations=2000000,maxScans=100000,maxCuts=256}={}){
  if(project.units!=='mm')throw new Error('请先确认毫米比例，再按交点修剪');
  if(!Number.isFinite(errorTolerance)||errorTolerance<=0||errorTolerance>.01)throw new Error('修剪误差上限须大于 0 且不超过 0.01 mm');
  if(![maxPairs,maxOperations,maxScans,maxCuts].every(v=>Number.isInteger(v)&&v>=1))throw new Error('修剪计算上限无效');
  const source=project.entities.find(e=>e.id===targetId);
  if(!source||source.type==='text'||source.derivedFrom||source.notchFrom)throw new Error('请选择一条原始目标线；关联输出须先解除关联');
  if(!Array.isArray(cutterIds)||!cutterIds.length||cutterIds.length>64||new Set(cutterIds).size!==cutterIds.length||cutterIds.includes(targetId))throw new Error('请选择 1 至 64 条不同的切割参考线，不能包含目标线');
  const cutters=cutterIds.map(id=>project.entities.find(e=>e.id===id));
  if(cutters.some(e=>!e||e.type==='text'))throw new Error('切割参考线已删除或不是线条');
  const parts=nativeParts(source),references=[];
  for(const cutter of cutters){for(const [index,part] of nativeParts(cutter).entries())references.push({...part,entityId:cutter.id,partIndex:index});if(references.length+parts.length>4096)throw new Error('原生分段超过 4096 个，请减少切割参考线');}
  const cuts=[],stats={pairs:0,operations:0,scans:0};
  for(let i=0;i<parts.length;i++)for(const reference of references){
    if(++stats.scans>maxScans)throw new Error('修剪候选检查超过上限，请减少参考线或先剪开目标');
    const part=parts[i];if(!overlap(part.bounds,reference.bounds))continue;
    if(++stats.pairs>maxPairs||stats.operations>=maxOperations)throw new Error('修剪交点计算超过上限，未使用部分结果');
    const result=intersectBezier(part.points,reference.points,{firstPower:part.exactPower,secondPower:reference.exactPower,parameterCertificates:true,maxOperations:Math.min(100000,maxOperations-stats.operations)});stats.operations+=result.operations;
    for(const h of result.hits){
      let cut={...h,partIndex:i};
      if(h.parameterA===1)cut={...h,...endpoint(i+1)};
      if(source.closed&&cut.partIndex===parts.length)cut={...h,...endpoint(0)};
      cut.contributors=[{entityId:reference.entityId,partIndex:reference.partIndex,parameter: h.parameterB}];cuts.push(cut);
      if(cuts.length>maxCuts*8)throw new Error('交点候选过多，请减少切割参考线');
    }
  }
  cuts.sort(compare);const distinct=[];
  for(const cut of cuts){const last=distinct.at(-1);if(last&&compare(last,cut)===0)last.contributors.push(...cut.contributors);else distinct.push(cut);}
  if(distinct.length>maxCuts)throw new Error('修剪切点超过 '+maxCuts+' 个');
  const closed=Boolean(source.closed),start=endpoint(0),end=endpoint(parts.length),interior=closed?distinct:distinct.filter(c=>compare(start,c)<0&&compare(c,end)<0);
  if(closed?interior.length<2:!interior.length)throw new Error(closed?'闭合线至少需要两个不同的路径切点':'没有内部交点可供修剪；仅端点接触不能分出区间');
  const boundaries=closed?interior:[start,...interior,end],analysis={targetId,cutterIds:[...cutterIds],source:clone(source),parts,degree:source.curve?.degree||1,closed,errorTolerance,cuts:distinct,boundaries,signature:lineEditStamp(project),stats,regions:[]};
  for(let i=0;i<boundaries.length-(closed?0:1);i++){
    const start=boundaries[i],end=boundaries[(i+1)%boundaries.length],spans=rangeSpans(analysis,start,end),entity=assemble(source,spans,'trim-region-'+i,'区间 '+(i+1));
    analysis.regions.push({index:i,start,end,spans,entity,...lengthOf(entity),errorBound:Math.max(...spans.map(s=>s.errorBound))});
  }
  return analysis;
}

export function prepareIntersectionTrim(project,analysis,{regionIndex,action='remove',keepOriginals=false}={}){
  if(!analysis||analysis.signature!==lineEditStamp(project))throw new Error('工程已变化，请重新分析交点');
  if(!Number.isInteger(regionIndex)||!analysis.regions[regionIndex]||!['remove','keep'].includes(action)||typeof keepOriginals!=='boolean')throw new Error('请选择有效区间与修剪操作');
  const region=analysis.regions[regionIndex],ranges=[];
  if(action==='keep')ranges.push([region.start,region.end]);
  else if(analysis.closed)ranges.push([region.end,region.start]);
  else{
    if(regionIndex>0)ranges.push([analysis.boundaries[0],region.start]);
    if(regionIndex<analysis.regions.length-1)ranges.push([region.end,analysis.boundaries.at(-1)]);
  }
  let serial=0;const used=new Set(project.entities.map(e=>e.id)),id=()=>{let value;do{value='trim-preview-'+(++serial);}while(used.has(value));used.add(value);return value;};
  const outputs=[],lengths=[];let errorBound=0;
  for(const [a,b] of ranges){
    const spans=rangeSpans(analysis,a,b),entity=assemble(analysis.source,spans,id(),analysis.source.name+' · 修剪 '+(outputs.length+1));
    errorBound=Math.max(errorBound,...spans.map(s=>s.errorBound));
    if(!analysis.closed&&a.partIndex===0&&a.parameterA===0&&analysis.source.arrowStart)entity.arrowStart=true;
    if(!analysis.closed&&b.partIndex===analysis.parts.length&&analysis.source.arrowEnd)entity.arrowEnd=true;
    entity.source.lineEdit={operation:'trim',entityIds:[analysis.targetId],cutterIds:[...analysis.cutterIds],action,regionIndex,errorBound:Math.max(...spans.map(s=>s.errorBound)),parameterRanges:spans.map(s=>({partIndex:s.partIndex,range:s.parameterRange}))};
    outputs.push(entity);lengths.push(lengthOf(entity).length);
  }
  if(!outputs.length)throw new Error('修剪必须保留至少一个区间');
  const next=clone(project),dissolved=keepOriginals?[]:replaceGroups(next,[analysis.targetId],outputs,'trim');
  if(!keepOriginals)next.entities=next.entities.filter(e=>e.id!==analysis.targetId);next.entities.push(...outputs);validateProject(next);
  const contours=keepOriginals?[]:(project.groups||[]).filter(g=>contoursForGroup(g).some(c=>c.entityIds.includes(analysis.targetId))).map(g=>g.name);
  return {project:next,outputs,lengths,errorBound,config:{operation:'trim',regionIndex,action,keepOriginals},signature:analysis.signature,effects:keepOriginals?[]:dependencies(project,[analysis.targetId]),dissolved,affectedContours:contours,opensClosed:!keepOriginals&&analysis.closed};
}

export const applyIntersectionTrim=applyLineEdit;
