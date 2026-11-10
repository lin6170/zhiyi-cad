import { pathMetrics, stationOnPath } from './path-metrics.mjs';
import { normalizeSections, resolveSectionLandmarks, reverseSectionDefinition } from './seam-sections.mjs';

const metricCache=new WeakMap();
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export const checkEdgeKey=ref=>JSON.stringify([ref.entityId,ref.segmentIndex]);
export function emptySeamCheck(){return {name:'缝合核对',a:{edges:[],trimStart:0,trimEnd:0},b:{edges:[],trimStart:0,trimEnd:0},easeMode:'mm',easeValue:0,tolerance:.5,gapTolerance:.1,checkMode:'whole',landmarks:[],sectionTargets:[]};}
export function checkEdgeRef(entity,index=null){
  if(!entity||entity.type==='text'||entity.derivedFrom||entity.notchFrom)throw new Error('请选择原始缝合基准线，关联输出不能用于核对');
  const split=entity.closed&&!entity.curve;
  if(split&&(!Number.isInteger(index)||index<0||index>=entity.points.length))throw new Error('请在闭合轮廓上点选一条边');
  return {entityId:entity.id,segmentIndex:split?index:null,segmentCount:split?entity.points.length:null,reverse:false};
}
export function normalizeSeamCheck(value){
  if(!value||!['mm','percent'].includes(value.easeMode)||!Number.isFinite(value.easeValue)||Math.abs(value.easeValue)>1e6)throw new Error('目标吃势参数无效');
  if(!Number.isFinite(value.tolerance)||value.tolerance<0||value.tolerance>1e4)throw new Error('核对容差须在 0 至 10000 mm 之间');
  if(!Number.isFinite(value.gapTolerance)||value.gapTolerance<0||value.gapTolerance>10)throw new Error('连续边的端点容差须在 0 至 10 mm 之间');
  const result={name:String(value.name||'缝合核对').slice(0,200),easeMode:value.easeMode,easeValue:value.easeValue,tolerance:value.tolerance,gapTolerance:value.gapTolerance},seen=new Set();
  for(const side of ['a','b']){
    const input=value[side];
    if(!input||!Array.isArray(input.edges)||!input.edges.length||input.edges.length>100||!Number.isFinite(input.trimStart)||!Number.isFinite(input.trimEnd)||input.trimStart<0||input.trimEnd<0||input.trimStart>1e8||input.trimEnd>1e8)throw new Error(side.toUpperCase()+' 侧须选择 1 至 100 条连续边，且两端扣除长度有效');
    result[side]={trimStart:input.trimStart,trimEnd:input.trimEnd,edges:input.edges.map(ref=>{
      if(!ref||typeof ref.entityId!=='string'||typeof ref.reverse!=='boolean'||ref.segmentIndex!==null&&(!Number.isInteger(ref.segmentIndex)||!Number.isInteger(ref.segmentCount)||ref.segmentIndex<0||ref.segmentCount<2||ref.segmentIndex>=ref.segmentCount)||ref.segmentIndex===null&&ref.segmentCount!==null)throw new Error('缝合边引用无效');
      const key=checkEdgeKey(ref);if(seen.has(key))throw new Error('同一条边不能重复加入或同时作为 A、B 两侧');seen.add(key);
      return {entityId:ref.entityId,segmentIndex:ref.segmentIndex,segmentCount:ref.segmentCount,reverse:ref.reverse};
    })};
  }
  return Object.assign(result,normalizeSections(value));
}
export function resolveCheckEdge(project,ref){
  const original=project.entities.find(entity=>entity.id===ref.entityId);
  if(!original)throw new Error('缝合基准线已缺失');
  if(original.type==='text'||original.derivedFrom||original.notchFrom)throw new Error('缝合基准已变成非原始线条');
  if(ref.segmentIndex!==null){
    if(original.curve||!original.closed||original.points.length!==ref.segmentCount)throw new Error('缝合基准分边数量已变化，请重新选边');
    const index=ref.segmentIndex;
    if(!original.points[index])throw new Error('缝合边序号无效');
    return {original,entity:{...original,name:original.name+' · 第 '+(index+1)+' 边',closed:false,points:[original.points[index],original.points[(index+1)%original.points.length]]}};
  }
  if(original.closed&&!original.curve)throw new Error('闭合折线须指定原始边');
  return {original,entity:original};
}
function measureEdge(project,ref){
  const {original,entity}=resolveCheckEdge(project,ref),key=checkEdgeKey(ref),signature=JSON.stringify([entity.closed,entity.curve||entity.points]);
  let entries=metricCache.get(original);if(!entries){entries=new Map();metricCache.set(original,entries);}
  if(entries.get(key)?.signature!==signature)entries.set(key,{signature,metrics:pathMetrics(entity)});
  const metrics=entries.get(key).metrics;
  const first=stationOnPath(metrics,0,{pointOnly:true}).point,last=stationOnPath(metrics,metrics.total,{pointOnly:true}).point;
  return {ref,entity,metrics,start:ref.reverse?last:first,end:ref.reverse?first:last};
}
function measureChain(project,side,gapTolerance,label){
  let total=0,uncertainty=0,maxGap=0,gapTotal=0;
  const edges=side.edges.map((ref,index)=>{
    const edge=measureEdge(project,ref);edge.offset=total;
    total+=edge.metrics.total;uncertainty+=edge.metrics.uncertainty;
    return edge;
  });
  for(let i=1;i<edges.length;i++){
    const gap=distance(edges[i-1].end,edges[i].start);maxGap=Math.max(maxGap,gap);gapTotal+=gap;
    if(gap>gapTolerance+1e-9)throw new Error(label+' 侧第 '+i+'、'+(i+1)+' 边间隙 '+gap.toFixed(4)+' mm 超出容差；请核对顺序和方向');
  }
  const length=total-side.trimStart-side.trimEnd;
  if(!Number.isFinite(length)||length<=1e-7)throw new Error(label+' 侧扣除后无有效长度，请减少两端扣除量');
  uncertainty+=Number.EPSILON*(total+side.trimStart+side.trimEnd)*16;
  return {edges,total,length,uncertainty,maxGap,gapTotal,trimStart:side.trimStart,trimEnd:side.trimEnd};
}
function chainPoint(chain,position){
  const station=chain.trimStart+Math.max(0,Math.min(chain.length,position));
  const edge=chain.edges.find(edge=>station<=edge.offset+edge.metrics.total)||chain.edges.at(-1);
  const local=Math.max(0,Math.min(edge.metrics.total,station-edge.offset));
  return stationOnPath(edge.metrics,edge.ref.reverse?edge.metrics.total-local:local,{pointOnly:true}).point;
}
function evaluate(project,value){
  if(project.units!=='mm')throw new Error('请先校准毫米单位，再核对缝合长度');
  const config=normalizeSeamCheck(value),a=measureChain(project,config.a,config.gapTolerance,'A'),b=measureChain(project,config.b,config.gapTolerance,'B');
  const landmarks=config.checkMode==='sections'?resolveSectionLandmarks(project,config,a,b,chainPoint):[];
  const classify=(residual,uncertainty,tolerance)=>Math.abs(residual)+uncertainty<=tolerance?'match':Math.abs(residual)-uncertainty>tolerance?'mismatch':'uncertain';
  const boundaries=[{id:'start',name:'起点',a:0,b:0},...landmarks,{id:'end',name:'终点',a:a.length,b:b.length}];
  const sections=config.sectionTargets.map((target,i)=>{
    const start=boundaries[i],end=boundaries[i+1],aLength=end.a-start.a,bLength=end.b-start.b;
    const targetEase=target.easeMode==='percent'?aLength*target.easeValue/100:target.easeValue,expectedB=aLength+targetEase;
    if(!Number.isFinite(expectedB)||expectedB<=1e-7)throw new Error('第 '+(i+1)+' 段目标吃势使 B 侧目标长度非正');
    const residual=bLength-expectedB,uncertainty=2*(b.uncertainty+a.uncertainty*Math.abs(target.easeMode==='percent'?1+target.easeValue/100:1))+Number.EPSILON*(a.total+b.total+Math.abs(targetEase))*64;
    return {...target,index:i+1,name:start.name+' → '+end.name,aStart:start.a,aEnd:end.a,bStart:start.b,bEnd:end.b,aLength,bLength,targetEase,expectedB,residual,uncertainty,status:classify(residual,uncertainty,target.tolerance)};
  });
  const targetEase=config.checkMode==='sections'?sections.reduce((sum,section)=>sum+section.targetEase,0):config.easeMode==='percent'?a.length*config.easeValue/100:config.easeValue,expectedB=a.length+targetEase;
  if(!Number.isFinite(expectedB)||expectedB<=1e-7)throw new Error('目标吃势使 B 侧目标长度非正，请调整吃势');
  const delta=b.length-a.length,residual=b.length-expectedB;
  const uncertainty=config.checkMode==='sections'?sections.reduce((sum,section)=>sum+section.uncertainty,0):b.uncertainty+a.uncertainty*Math.abs(config.easeMode==='percent'?1+config.easeValue/100:1)+Number.EPSILON*(b.length+expectedB)*16;
  const totalStatus=classify(residual,uncertainty,config.tolerance),statuses=[totalStatus,...sections.map(section=>section.status)],status=statuses.includes('mismatch')?'mismatch':statuses.includes('uncertain')?'uncertain':'match';
  const summarize=chain=>({length:chain.length,total:chain.total,trimStart:chain.trimStart,trimEnd:chain.trimEnd,maxGap:chain.maxGap,gapTotal:chain.gapTotal,uncertainty:chain.uncertainty,edges:chain.edges.map(edge=>({ref:{...edge.ref},name:edge.entity.name,length:edge.metrics.total}))});
  return {a,b,report:{name:config.name,units:'mm',checkMode:config.checkMode,landmarks,sections,totalStatus,a:summarize(a),b:summarize(b),delta,actualEasePercent:delta/a.length*100,targetEase,expectedB,residual,uncertainty,status,tolerance:config.tolerance,easeMode:config.easeMode,easeValue:config.easeValue,gapTolerance:config.gapTolerance}};
}
export function evaluateSeamCheck(project,value){return evaluate(project,value).report;}
export function walkSeamCheck(project,value,fraction){
  if(!Number.isFinite(fraction)||fraction<0||fraction>1)throw new Error('步进比例须在 0 至 1 之间');
  const {a,b,report}=evaluate(project,value),aPosition=a.length*fraction;
  const section=report.sections.find(section=>aPosition<=section.aEnd)||report.sections.at(-1);
  const bRequested=section?section.bStart+(aPosition-section.aStart)/section.aLength*section.expectedB:report.expectedB*fraction,bLimit=section?section.bEnd:b.length,bPosition=Math.min(bLimit,bRequested);
  // At a permitted chain gap, a notch may belong to the following edge. Keep
  // its source point instead of choosing the previous edge's same arc station.
  const locatedPoint=(chain,side,position)=>report.landmarks.find(mark=>Math.abs(mark[side]-position)<=Number.EPSILON*Math.max(1,Math.abs(position))*4)?.[side+'Point']||chainPoint(chain,position);
  return {report,section:section?{index:section.index,name:section.name,remaining:bLimit-bPosition,residual:section.residual}:null,a:{start:chainPoint(a,0),end:chainPoint(a,a.length),point:locatedPoint(a,'a',aPosition),position:aPosition,remaining:a.length-aPosition},b:{start:chainPoint(b,0),end:chainPoint(b,b.length),point:locatedPoint(b,'b',bPosition),position:bPosition,remaining:b.length-bPosition,overrun:Math.max(0,bRequested-bLimit)}};
}
export function reverseCheckSide(side){return {...side,trimStart:side.trimEnd,trimEnd:side.trimStart,edges:side.edges.slice().reverse().map(ref=>({...ref,reverse:!ref.reverse}))};}
export function reverseSeamCheck(value){return reverseSectionDefinition(value,reverseCheckSide);}
export function appendCheckEdge(project,side,ref){
  const next={...ref};
  if(side.edges.some(edge=>checkEdgeKey(edge)===checkEdgeKey(next)))throw new Error('此边已在当前缝合链中');
  if(side.edges.length){
    const previous=measureEdge(project,side.edges.at(-1)),candidate=measureEdge(project,next);
    if(distance(previous.end,candidate.end)<distance(previous.end,candidate.start))next.reverse=!next.reverse;
  }
  return {...side,edges:[...side.edges,next]};
}
function checkSignature(project,check){
  const config=normalizeSeamCheck(check),notchIds=new Set(config.landmarks.flatMap(mark=>[mark.a,mark.b]).filter(locator=>locator.kind==='notch').map(locator=>locator.notchId));
  const dependencies=[...notchIds].map(id=>{const recipe=project.notches?.find(item=>item.id===id);return recipe?[recipe,recipe.outputIds.map(id=>project.entities.find(entity=>entity.id===id)),project.seamAllowances?.find(item=>item.id===recipe.targetSeamId)]:[id,null];});
  return JSON.stringify([project.units,config,dependencies,[...check.a.edges,...check.b.edges].map(ref=>{const e=project.entities.find(item=>item.id===ref.entityId);return e?[e.id,e.name,e.closed,e.curve||e.points,e.derivedFrom,e.notchFrom]:[ref.entityId,null];})]);
}
export function syncSeamChecks(project){
  for(const check of project.seamChecks||[]){
    let signature;
    try{
      signature=checkSignature(project,check);
      if(signature===check.signature&&['current','error'].includes(check.status))continue;
      check.result=evaluateSeamCheck(project,check);check.status='current';delete check.error;
    }catch(error){check.status='error';check.error=error.message;delete check.result;}
    check.signature=signature??null;
  }
}
export function applySeamCheck(project,value,makeId,checkId=null){
  const config=normalizeSeamCheck(value),result=evaluateSeamCheck(project,config);
  project.seamChecks??=[];
  let check=project.seamChecks.find(item=>item.id===checkId);
  if(checkId&&!check)throw new Error('待更新的缝合核对已缺失');
  if(!check){if(project.seamChecks.length>=100)throw new Error('缝合核对数量达到 100 组上限');check={id:makeId()};project.seamChecks.push(check);}
  Object.assign(check,config,{result,status:'current',signature:null});delete check.error;
  check.signature=checkSignature(project,check);project.version=Math.max(project.version,config.checkMode==='sections'?7:6);return check;
}
export function validateSeamChecks(project){
  project.seamChecks??=[];
  if(!Array.isArray(project.seamChecks)||project.seamChecks.length>100)throw new Error('缝合核对定义无效');
  const ids=new Set();
  for(const check of project.seamChecks){
    if(!check||typeof check.id!=='string'||ids.has(check.id))throw new Error('缝合核对 ID 无效');ids.add(check.id);
    Object.assign(check,normalizeSeamCheck(check),{signature:null,status:'stale'});delete check.result;delete check.error;
  }
  if(project.seamChecks.length)project.version=Math.max(project.version,project.seamChecks.some(check=>check.checkMode==='sections')?7:6);
}
