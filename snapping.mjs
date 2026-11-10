import {bezierSpans,localizeCurve,validateCurve} from './curves.mjs';
import {nearestBezier} from './bezier-cut.mjs';
import {pathMetrics,stationOnPath} from './path-metrics.mjs';
import {constrainedBezierPoints} from './constraint-snapping.mjs';
import {intersectBezier,selfBezierIntersections,prepareIntersectionSpans} from './intersections.mjs';
const clone=v=>JSON.parse(JSON.stringify(v)),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),rank={endpoint:0,vertex:0,midpoint:1,'half-length':1,nearest:2,perpendicular:2,tangent:2,intersection:2};
const finite=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y);
function box(points){const b={minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity};for(const p of points){if(!finite(p))throw new Error('吸附几何包含无效坐标');b.minX=Math.min(b.minX,p.x);b.maxX=Math.max(b.maxX,p.x);b.minY=Math.min(b.minY,p.y);b.maxY=Math.max(b.maxY,p.y);}return b;}
function nearBox(b,p,r){const pad=Math.max(1,Math.abs(b.minX),Math.abs(b.maxX),Math.abs(b.minY),Math.abs(b.maxY))*Number.EPSILON*8;return Math.hypot(Math.max(b.minX-p.x,0,p.x-b.maxX),Math.max(b.minY-p.y,0,p.y-b.maxY))<=r+pad;}
function tree(items){if(!items.length)return null;const b=box(items.flatMap(e=>[{x:e.box.minX,y:e.box.minY},{x:e.box.maxX,y:e.box.maxY}]));if(items.length<=12)return {box:b,items};const axis=b.maxX-b.minX>=b.maxY-b.minY?'X':'Y',ordered=items.slice().sort((a,b)=>(a.box['min'+axis]+a.box['max'+axis])-(b.box['min'+axis]+b.box['max'+axis])),m=ordered.length>>1;return {box:b,left:tree(ordered.slice(0,m)),right:tree(ordered.slice(m))};}
function lineNearest(points,p){const [a,b]=points,dx=b.x-a.x,dy=b.y-a.y,l=Math.hypot(dx,dy),t=l?Math.max(0,Math.min(1,((p.x-a.x)*(dx/l)+(p.y-a.y)*(dy/l))/l)):0;return {parameter:t,point:t===0?{...a}:t===1?{...b}:{x:a.x+t*dx,y:a.y+t*dy}};}
function nativeParts(record){
  if(record.parts)return record.parts;
  const {curve,origin}=localizeCurve(record.curve),spans=bezierSpans(curve);
  record.origin=origin;record.parts=spans.map((s,spanIndex)=>({points:s.controlPoints,spanIndex,knotRange:[s.start,s.end],parameterSpace:'bezier',segmentType:'native-curve'}));
  if(record.closed)record.parts.push({points:[curve.controlPoints.at(-1),curve.controlPoints[0]],segmentType:'closing-edge',parameterSpace:'closing-edge'});
  return record.parts;
}
function constraintNativeParts(record){
  if(record.constraintParts)return record.constraintParts;
  const curve=record.curve,spans=curve.controlPoints.length===curve.degree+1?[{controlPoints:curve.controlPoints,start:curve.knots[curve.degree],end:curve.knots[curve.controlPoints.length]}]:bezierSpans(curve);
  record.constraintParts=spans.map((s,spanIndex)=>({points:s.controlPoints,spanIndex,knotRange:[s.start,s.end],parameterSpace:'bezier',segmentType:'native-curve'}));
  if(record.closed)record.constraintParts.push({points:[curve.controlPoints.at(-1),curve.controlPoints[0]],segmentType:'closing-edge',parameterSpace:'closing-edge'});
  return record.constraintParts;
}
function halfLength(record){
  if(record.half)return record.half;
  const origin=record.curve.controlPoints[0],scale=Math.max(...record.curve.controlPoints.flatMap(p=>[Math.abs(p.x-origin.x),Math.abs(p.y-origin.y)]));
  if(!scale)return record.half={point:{...origin},kind:'half-length',position:0,total:0,uncertainty:0};
  const curve={...record.curve,controlPoints:record.curve.controlPoints.map(p=>({x:(p.x-origin.x)/scale,y:(p.y-origin.y)/scale}))},entity={type:'polyline',points:[curve.controlPoints[0],curve.controlPoints.at(-1)],curve,closed:record.closed};
  const metrics=pathMetrics(entity,{preserveShortPieces:true}),station=stationOnPath(metrics,metrics.total/2,{pointOnly:true}),parts=nativeParts(record).filter(s=>!s.points.every(p=>p.x===s.points[0].x&&p.y===s.points[0].y)),part=parts[station.pieceIndex];
  return record.half={point:{x:station.point.x*scale+origin.x,y:station.point.y*scale+origin.y},kind:'half-length',position:station.position*scale,total:station.total*scale,uncertainty:station.uncertainty*scale,spanIndex:part?.spanIndex,knotRange:part?.knotRange,segmentType:part?.segmentType,parameter:station.parameter,parameterSpace:part?.parameterSpace};
}

// Immutable source snapshot. Rebuild after geometry edits; queries never inspect
// display samples of a native curve or mutate the source/returned previous match.
export function createSnapIndex(entities,{maxEntries=250000}={}){
  if(!Array.isArray(entities)||!Number.isInteger(maxEntries)||maxEntries<0)throw new Error('吸附索引设置无效');
  const endpoints=[],midpoints=[],geometry=[],intersectionCache=new Map();let entries=0,buildError=null;
  const add=(list,entry)=>{if(++entries>maxEntries)throw new Error('吸附索引超过数量上限，请减少图元或关闭吸附');list.push(entry);};
  const feature=(record,point,meta)=>({...record,...meta,point:{...point},box:box([point])});
  try{entities.forEach((entity,order)=>{
    if(entity.type==='text')return;
    const record={entityId:entity.id,entityName:entity.name,order,closed:Boolean(entity.closed)};
    if(entity.curve){
      record.curve=clone(validateCurve(entity.curve));record.box=box(record.curve.controlPoints);
      const points=record.curve.controlPoints;
      for(const endpointIndex of [0,1])add(endpoints,feature(record,endpointIndex?points.at(-1):points[0],{kind:'endpoint',endpointIndex}));
      add(midpoints,record);add(geometry,record);
    }else{
      if(!Array.isArray(entity.points)||!entity.points.length)throw new Error('吸附图元缺少坐标');const points=entity.points.map(p=>({...p}));box(points);
      points.forEach((point,vertexIndex)=>add(endpoints,feature(record,point,{kind:'vertex',vertexIndex})));
      for(let i=0;i<points.length-(record.closed?0:1);i++){
        const pair=[points[i],points[(i+1)%points.length]],segment={...record,points:pair,segmentIndex:i,endVertexIndices:[i,(i+1)%points.length],box:box(pair)};
        add(geometry,segment);add(midpoints,feature(record,{x:pair[0].x+(pair[1].x-pair[0].x)/2,y:pair[0].y+(pair[1].y-pair[0].y)/2},{kind:'midpoint',segmentIndex:i,parameter:.5,parameterSpace:'segment'}));
      }
    }
  });}catch(error){buildError=error.message;}
  const trees=buildError?{}:{endpoint:tree(endpoints),midpoint:tree(midpoints),nearest:tree(geometry)};
  return {entryCount:entries,query(point,radius,{mode='endpoint',anchor,excludeIds=[],maxChecks=10000,maxCurveChecks=64,maxIntersectionPairs=24,maxIntersectionOperations=100000}={}){
    const constrained=['perpendicular','tangent'].includes(mode);
    if(!finite(point)||!Number.isFinite(radius)||radius<=0||!['endpoint','midpoint','nearest','perpendicular','tangent','intersection'].includes(mode)||constrained&&!finite(anchor)||!Number.isInteger(maxChecks)||maxChecks<0||!Number.isInteger(maxCurveChecks)||maxCurveChecks<0||!Number.isInteger(maxIntersectionPairs)||maxIntersectionPairs<0||!Number.isInteger(maxIntersectionOperations)||maxIntersectionOperations<1)throw new Error('吸附查询设置无效，垂足或切点需要有限起点');
    const stats={checks:0,curveChecks:0,nodes:0,intersectionPairs:0,intersectionOperations:0},excluded=new Set(excludeIds);let best=null,bestOrder=Infinity,bestPart=Infinity;
    const consider=(record,candidate)=>{
      if(!finite(candidate.point))throw new Error('原生吸附未得到有限坐标');const d=distance(point,candidate.point);if(d>radius)return;
      const part=candidate.vertexIndex??candidate.segmentIndex??candidate.spanIndex??candidate.endpointIndex??0,eps=Math.max(1,radius)*Number.EPSILON*16;
      if(!best||d<best.distance-eps||Math.abs(d-best.distance)<=eps&&(rank[candidate.kind]<rank[best.kind]||rank[candidate.kind]===rank[best.kind]&&(record.order<bestOrder||record.order===bestOrder&&part<bestPart))){best={entityId:record.entityId,entityName:record.entityName,...candidate,distance:d};bestOrder=record.order;bestPart=part;}
    };
    const curveCheck=()=>{if(++stats.curveChecks>maxCurveChecks)throw new Error('原生吸附计算超过上限，请放大或切换端点模式');};
    const visit=(entry,kind)=>{
      if(excluded.has(entry.entityId)||!nearBox(entry.box,point,radius))return;
      if(++stats.checks>maxChecks)throw new Error('吸附候选超过上限，请放大或减少图元');
      if(kind==='endpoint'||kind==='midpoint'&&!entry.curve){const {point:p,kind:k,vertexIndex,segmentIndex,parameter,parameterSpace,endpointIndex}=entry;consider(entry,{point:p,kind:k,vertexIndex,segmentIndex,parameter,parameterSpace,endpointIndex});return;}
      if(kind==='midpoint'){
        if(!entry.half)curveCheck();const half=halfLength(entry);if(half.uncertainty>radius/20)throw new Error('曲线半长点的误差估计超过当前吸附精度，请切换端点模式');consider(entry,half);return;
      }
      if(constrained&&!entry.curve){for(const candidate of constrainedBezierPoints(entry.points,anchor,mode))consider(entry,{...candidate,anchor:{...anchor},segmentIndex:entry.segmentIndex,parameterSpace:'segment'});return;}
      if(!entry.curve){const hit=lineNearest(entry.points,point),end=hit.parameter===0?0:hit.parameter===1?1:null;consider(entry,{...hit,kind:end===null?'nearest':'vertex',segmentIndex:entry.segmentIndex,vertexIndex:end===null?undefined:entry.endVertexIndices[end],parameterSpace:'segment'});return;}
      if(constrained){for(const part of constraintNativeParts(entry)){if(++stats.checks>maxChecks)throw new Error('吸附原生分段超过上限，请放大或减少图元');if(!nearBox(box(part.points),point,radius))continue;curveCheck();for(const candidate of constrainedBezierPoints(part.points,anchor,mode))consider(entry,{...candidate,anchor:{...anchor},spanIndex:part.spanIndex,knotRange:part.knotRange,segmentType:part.segmentType,parameterSpace:part.parameterSpace});}return;}
      const parts=nativeParts(entry),origin=entry.origin,local={x:point.x-origin.x,y:point.y-origin.y};
      for(const [index,part] of parts.entries()){
        if(++stats.checks>maxChecks)throw new Error('吸附原生分段超过上限，请放大或减少图元');
        if(!nearBox(box(part.points),local,radius))continue;curveCheck();
        const extent=Math.max(...part.points.flatMap(p=>[Math.abs(p.x),Math.abs(p.y)])),scale=extent?2**Math.ceil(Math.log2(extent)):1,query={x:local.x/scale,y:local.y/scale};if(!finite(query))throw new Error('原生曲线吸附的坐标比例超出计算范围');
        const hit=nearestBezier(part.points.map(p=>({x:p.x/scale,y:p.y/scale})),query),endpoint=part.segmentType==='closing-edge'?(hit.t===0?1:hit.t===1?0:null):(index===0&&hit.t===0?0:index===parts.length-(entry.closed?2:1)&&hit.t===1?1:null),p=endpoint===null?{x:hit.point.x*scale+origin.x,y:hit.point.y*scale+origin.y}:{...(endpoint===0?entry.curve.controlPoints[0]:entry.curve.controlPoints.at(-1))};
        consider(entry,{point:p,kind:endpoint===null?'nearest':'endpoint',endpointIndex:endpoint??undefined,spanIndex:part.spanIndex,knotRange:part.knotRange,segmentType:part.segmentType,parameter:hit.t,parameterSpace:part.parameterSpace});
      }
    };
    const walk=(root,kind)=>{const stack=root?[root]:[];while(stack.length){const current=stack.pop();stats.nodes++;if(!nearBox(current.box,point,radius))continue;if(current.items)current.items.forEach(e=>visit(e,kind));else stack.push(current.right,current.left);}};
    function intersections(){
      const candidates=[],stack=trees.nearest?[trees.nearest]:[],count=()=>{if(++stats.checks>maxChecks)throw new Error('交点候选超过上限，请放大或减少图元');};
      while(stack.length){const current=stack.pop();stats.nodes++;if(!nearBox(current.box,point,radius))continue;if(!current.items){stack.push(current.right,current.left);continue;}
        for(const record of current.items){if(excluded.has(record.entityId)||!nearBox(record.box,point,radius))continue;count();
          if(!record.curve){candidates.push({...record,key:record.order+':line:'+record.segmentIndex});continue;}
          if(!record.intersectionParts){curveCheck();record.intersectionParts=prepareIntersectionSpans(record.curve).map(part=>({...part,segmentType:'native-curve',parameterSpace:'bezier'}));if(record.closed)record.intersectionParts.push({points:[record.curve.controlPoints.at(-1),record.curve.controlPoints[0]],segmentType:'closing-edge',parameterSpace:'closing-edge'});}
          for(const part of record.intersectionParts){count();const bounds=box(part.points);if(nearBox(bounds,point,radius))candidates.push({...record,...part,box:bounds,key:record.order+':curve:'+(part.spanIndex??'close')});}
        }
      }
      candidates.sort((a,b)=>a.order-b.order||(a.segmentIndex??a.spanIndex??Infinity)-(b.segmentIndex??b.spanIndex??Infinity));
      const reference=(part,parameter)=>({entityId:part.entityId,entityName:part.entityName,segmentIndex:part.segmentIndex,spanIndex:part.spanIndex,knotRange:part.knotRange,segmentType:part.segmentType||'line',parameterSpace:part.parameterSpace||'segment',parameter});
      function pair(a,b,self=false){
        if(++stats.intersectionPairs>maxIntersectionPairs)throw new Error('交点曲线配对超过上限，请放大或减少重叠线条');
        const key=a.key+'|'+b.key;let result=intersectionCache.get(key);
        if(!result){if(a.points.length>2||b.points.length>2)curveCheck();const limit=maxIntersectionOperations-stats.intersectionOperations;if(limit<1)throw new Error('交点精确计算超过查询上限');result=self?selfBezierIntersections(a.points,{exactPower:a.exactPower,maxOperations:limit}):intersectBezier(a.points,b.points,{firstPower:a.exactPower,secondPower:b.exactPower,maxOperations:limit});stats.intersectionOperations+=result.operations;if(intersectionCache.size>=2048)intersectionCache.delete(intersectionCache.keys().next().value);intersectionCache.set(key,result);}
        for(const hit of result.hits){if(!nearBox(box([hit.point]),point,radius))continue;if(hit.uncertainty>radius/20)throw new Error('交点坐标误差界超过当前吸附精度，请调整视图');consider(a,{kind:'intersection',point:hit.point,parameter:hit.parameterA,parameterSpace:a.parameterSpace||'segment',spanIndex:a.spanIndex,segmentIndex:a.segmentIndex,uncertainty:hit.uncertainty,residual:hit.residual,selfIntersection:self||a.entityId===b.entityId,contributors:[reference(a,hit.parameterA),reference(b,hit.parameterB)]});}
      }
      for(let i=0;i<candidates.length;i++){
        const a=candidates[i];if(a.segmentType==='native-curve'&&a.points.length===4)pair(a,a,true);
        for(let j=i+1;j<candidates.length;j++){
          const b=candidates[j],pad=Math.max(1,...[a.box,b.box].flatMap(v=>[Math.abs(v.minX),Math.abs(v.maxX),Math.abs(v.minY),Math.abs(v.maxY)]))*Number.EPSILON*16,overlap={minX:Math.max(a.box.minX,b.box.minX)-pad,maxX:Math.min(a.box.maxX,b.box.maxX)+pad,minY:Math.max(a.box.minY,b.box.minY)-pad,maxY:Math.min(a.box.maxY,b.box.maxY)+pad};
          if(overlap.minX>overlap.maxX||overlap.minY>overlap.maxY||!nearBox(overlap,point,radius))continue;pair(a,b);
        }
      }
    }
    try{if(buildError)throw new Error(buildError);if(mode==='intersection')intersections();else{if(mode!=='nearest'&&!constrained)walk(trees.endpoint,'endpoint');if(mode!=='endpoint')walk(constrained?trees.nearest:trees[mode],mode);}return {match:best?clone(best):null,complete:true,stats};}
    catch(error){return {match:null,complete:false,reason:error.message,stats};}
  }};
}
