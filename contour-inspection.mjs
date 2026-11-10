import {bezierSpans,curveLength} from './curves.mjs';
import {assertNativeSimpleBoundary,exactLineContact} from './native-contact.mjs';
const clone=v=>JSON.parse(JSON.stringify(v)),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

// Receives the caller's chosen entity order/directions, never display samples.
export function inspectNativeChain(oriented,tolerance){
  const parts=[],references=[],issues=[];let nativeLength=0,lengthConverged=true;
  for(const {entity,reversed} of oriented){
    let spans;
    if(entity.curve){
      const curve=entity.curve,metrics=curveLength(curve);nativeLength+=metrics.value;lengthConverged&&=metrics.converged;
      spans=curve.controlPoints.length===curve.degree+1?[{controlPoints:curve.controlPoints,start:curve.knots[curve.degree],end:curve.knots[curve.controlPoints.length]}]:bezierSpans(curve);
      spans=spans.map((span,spanIndex)=>({points:span.controlPoints,reference:{entityId:entity.id,entityName:entity.name,kind:'native-curve',spanIndex,knotRange:[span.start,span.end],reversed}}));
      const controls=curve.controlPoints;if(entity.closed){nativeLength+=distance(controls.at(-1),controls[0]);if(distance(controls.at(-1),controls[0]))spans.push({points:[controls.at(-1),controls[0]],reference:{entityId:entity.id,entityName:entity.name,kind:'closing-edge',reversed}});}
    }else{
      spans=[];for(let i=0;i<entity.points.length-(entity.closed?0:1);i++){const points=[entity.points[i],entity.points[(i+1)%entity.points.length]];nativeLength+=distance(...points);spans.push({points,reference:{entityId:entity.id,entityName:entity.name,kind:'line',segmentIndex:i,reversed}});}
    }
    if(reversed)spans.reverse();
    for(const span of spans){const points=clone(reversed?[...span.points].reverse():span.points);parts.push({points});references.push(span.reference);if(points.length>2&&points.every(p=>p.x===points[0].x&&p.y===points[0].y))issues.push({kind:'zero-length',severity:'error',evidence:'native-controls',message:'原生曲线分段退化为单点',point:{...points[0]},entityId:entity.id,entityIds:[entity.id],highlights:[{controls:clone(points),reference:clone(span.reference)}]});}
  }
  if(!lengthConverged)issues.push({kind:'length-unresolved',severity:'review',evidence:'inconclusive',message:'原生弧长积分未收敛，长度需核对',entityIds:[...new Set(references.map(r=>r.entityId))]});
  const connections=[];
  parts.forEach((part,i)=>{const next=(i+1)%parts.length,start=part.points.at(-1),end=parts[next].points[0],gap=distance(start,end);if(gap>0)connections.push({start:{...start},end:{...end},distance:gap,from:clone(references[i]),to:clone(references[next])});});
  const base={method:'native-bezier-certificates',coordinateSpace:'project',partCount:parts.length,connections,exactlyClosed:!connections.length,usesVirtualConnections:false,nativeLength:lengthConverged?nativeLength:null,lengthConverged,issues};
  if(oriented.length>1&&oriented.some(x=>x.entity.closed))return {...base,status:'not-checked',reason:'invalid-definition',message:'轮廓定义含独立闭合图元，未作原生闭合检查'};
  if(connections.some(g=>g.distance>tolerance))return {...base,status:'not-checked',reason:'gap',message:'原生分段间隙超出容差，未作闭合证明'};
  base.usesVirtualConnections=connections.length>0;
  try{const stats=assertNativeSimpleBoundary(parts,{connectGaps:true});return {...base,status:'verified',stats,message:connections.length?'按已披露的临时直线连接，原生轮廓检查通过':'原生闭合轮廓检查通过'};}
  catch(error){
    const detail=error.nativeContact,highlights=[];
    if(detail?.controls)detail.controls.forEach((controls,i)=>{
      const sourcePart=detail.sourceParts?.[i],reference=Number.isInteger(sourcePart)?references[sourcePart]:null,between=detail.bridgeBetween?.[i];
      highlights.push({controls:clone(controls),reference:reference?clone(reference):null,virtualConnection:!reference,connectionReferences:between?between.map(n=>clone(references[n])):[],parameterRange:detail.parameterRanges?.[i]?[...detail.parameterRanges[i]]:null,parameterRangeSpace:'oriented-bezier',parameterRangeApproximate:true});
    });
    const contact=detail?.reason==='linear-contact'&&detail.controls?.length===2?exactLineContact(...detail.controls):null;
    const status=contact?'invalid':'uncertain',virtual=highlights.some(p=>p.virtualConnection),entityIds=[...new Set(highlights.flatMap(p=>p.reference?[p.reference.entityId]:p.connectionReferences.map(r=>r.entityId)))];
    const message=contact?(virtual?'临时连接轮廓中已证实直线接触或重叠':'已证实直线交叉、额外接触或重叠'):'原生曲线尚不能确认无自交，需核对标记区域';
    issues.push({kind:contact?'native-contact':'native-unresolved',severity:contact?'error':'review',evidence:contact?'exact-line-contact':'inconclusive',message,entityIds:entityIds.length?entityIds:[...new Set(references.map(r=>r.entityId))],highlights,contact:contact?clone(contact):null,detail:error.message});
    return {...base,status,reason:contact?'linear-contact':detail?.reason||'proof-unresolved',message,highlights};
  }
}
