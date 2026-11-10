import { bezierSpans, bezierIntegrationBreaks, localizeCurve } from './curves.mjs';

const EPS=1e-7;
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const norm=p=>Math.hypot(p.x,p.y);
function evaluate(points,t){
  let row=points;
  while(row.length>1)row=row.slice(0,-1).map((p,i)=>({x:p.x*(1-t)+row[i+1].x*t,y:p.y*(1-t)+row[i+1].y*t}));
  return {...row[0]};
}
function derivative(points){return points.slice(0,-1).map((p,i)=>({x:(points.length-1)*(points[i+1].x-p.x),y:(points.length-1)*(points[i+1].y-p.y)}));}
function zeroTolerance(points){
  return Math.max(1e-12,...derivative(points).map(norm))*1e-12+Math.max(...points.flatMap(p=>[Math.abs(p.x),Math.abs(p.y)]))*Number.EPSILON*8;
}
function collinear(points){
  const vectors=points.slice(1).map(point=>sub(point,points[0])),axis=vectors.reduce((best,v)=>norm(v)>norm(best)?v:best,{x:0,y:0});
  return vectors.every(v=>Math.abs(axis.x*v.y-axis.y*v.x)<=64*Number.EPSILON*(Math.abs(axis.x*v.y)+Math.abs(axis.y*v.x)));
}
function arcLength(points,end=1){
  if(points.length===2){const value=norm(sub(points[1],points[0]))*end;return {value,error:value*Number.EPSILON*8};}
  const controls=derivative(points),roundoffRate=Math.max(...controls.map(norm))*Number.EPSILON*64;let evaluations=0,error=0;
  const speed=t=>{if(++evaluations>100000)throw new Error('弧长定位未达到精度要求');return norm(evaluate(controls,t));};
  const simpson=(a,b,fa,fm,fb)=>(b-a)*(fa+4*fm+fb)/6;
  function integrate(a,b,fa,fm,fb,whole,tol,depth){
    const m=(a+b)/2,fl=speed((a+m)/2),fr=speed((m+b)/2),l=simpson(a,m,fa,fl,fm),r=simpson(m,b,fm,fr,fb),delta=l+r-whole;
    const estimate=Math.abs(delta)/15+roundoffRate*(b-a);
    if(Math.abs(delta)/15<=tol+roundoffRate*(b-a)||depth>=24){error+=estimate;return l+r+delta/15;}
    return integrate(a,m,fa,fl,fm,l,tol/2,depth+1)+integrate(m,b,fm,fr,fb,r,tol/2,depth+1);
  }
  let result=0;
  const breaks=bezierIntegrationBreaks(points,end);
  for(let segment=0;segment<breaks.length-1;segment++)for(let i=0;i<8;i++){
    const width=breaks[segment+1]-breaks[segment],a=breaks[segment]+width*i/8,b=breaks[segment]+width*(i+1)/8,fa=speed(a),fm=speed((a+b)/2),fb=speed(b),whole=simpson(a,b,fa,fm,fb);
    result+=integrate(a,b,fa,fm,fb,whole,1e-12*width/8+2e-15*Math.abs(whole),0);
  }
  if(!Number.isFinite(result)||error>1e-6+Math.abs(result)*1e-12)throw new Error('弧长定位未达到精度要求');
  return {value:result,error};
}
function tangent(points,t){
  let v=evaluate(derivative(points),t);const tolerance=zeroTolerance(points);
  // Repeated endpoint controls have a well-defined one-sided tangent.
  if(t===0||t===1){
    const endpoint=t===0?points[0]:points.at(-1);
    const candidates=t===0?points.slice(1):points.slice(0,-1).reverse();
    for(const candidate of candidates){v=t===0?sub(candidate,endpoint):sub(endpoint,candidate);if(norm(v)>0)return {x:v.x/norm(v),y:v.y/norm(v)};}
  }
  if(norm(v)<=tolerance&&t>0&&t<1&&points.length===4){
    const second=derivative(derivative(points));
    if(norm(evaluate(second,t))<=tolerance){
      if(!collinear(points))throw new Error('此处法线对位置误差过于敏感，请避开尖点附近');
      v=derivative(second)[0];
    }
  }
  const magnitude=norm(v);if(magnitude<=tolerance)throw new Error('刀口落在尖点，无法确定法线；请调整位置');
  return {x:v.x/magnitude,y:v.y/magnitude};
}
export function pathMetrics(entity,{preserveShortPieces=false}={}){
  if(!entity||entity.type==='text'||!Array.isArray(entity.points)||entity.points.length<2)throw new Error('请选择有效的基准线');
  // Convert and integrate near the local origin. Converting short splines at
  // large world coordinates otherwise loses digits in their Bezier controls.
  const localized=entity.curve?localizeCurve(entity.curve):null,origin=localized?.origin||{...entity.points[0]};
  const local=p=>sub(p,origin);
  const localPoints=entity.points.map(local);
  const controls=entity.curve?bezierSpans(localized.curve).map(span=>span.controlPoints):localPoints.slice(0,-1).map((p,i)=>[p,localPoints[i+1]]);
  if(entity.closed)controls.push([controls.at(-1).at(-1),controls[0][0]]);
  let total=0,uncertainty=0;
  const pieces=[];
  for(const points of controls){
    const measured=arcLength(points),length=measured.value;
    if(length<=(preserveShortPieces?0:1e-10))continue;
    const critical=bezierIntegrationBreaks(points).slice(1,-1).filter(t=>norm(evaluate(derivative(points),t))<=zeroTolerance(points)).map(t=>({t,length:arcLength(points,t).value}));
    const coordinateScale=Math.max(...points.flatMap(p=>[Math.abs(p.x),Math.abs(p.y)]));
    const conversionError=coordinateScale*Number.EPSILON*(entity.curve?128*points.length:16);
    const error=1e-12+measured.error+length*Number.EPSILON*8+conversionError;
    pieces.push({points,start:total,length,critical,uncertainty:error});total+=length;uncertainty+=error;
  }
  if(!Number.isFinite(total)||total<=EPS)throw new Error('基准线长度为零');
  return {pieces,total,uncertainty,closed:Boolean(entity.closed),origin};
}
export function stationOnPath(metrics,position,{pointOnly=false}={}){
  if(!Number.isFinite(position)||position < -EPS||position>metrics.total+EPS)throw new Error('刀口位置超出基准线长度');
  const s=Math.max(0,Math.min(metrics.total,position)),{pieces}=metrics;
  let index=pieces.findIndex(piece=>s<=piece.start+piece.length+(pointOnly?0:EPS));
  // Cumulative length can round away a tiny trailing piece on a very long
  // path. Its physical endpoint must still be retained for geometry edits.
  if(pointOnly&&s===metrics.total)index=pieces.length-1;
  if(index<0)index=pieces.length-1;
  const piece=pieces[index],local=pointOnly&&s===metrics.total?piece.length:Math.max(0,Math.min(piece.length,s-piece.start));
  const snapTolerance=pointOnly?0:EPS;
  let t=local<=snapTolerance?0:piece.length-local<=snapTolerance?1:local/piece.length;
  const candidates=piece.critical.filter(candidate=>Math.abs(candidate.length-local)<=snapTolerance);
  // Multiple component roots can differ by roundoff at a stationary point.
  // Prefer the stable double-root vertex rather than a spurious split root.
  candidates.sort((a,b)=>norm(evaluate(derivative(derivative(piece.points)),a.t))-norm(evaluate(derivative(derivative(piece.points)),b.t)));
  const critical=candidates[0];
  if(critical)t=critical.t;
  let inverseError=Math.abs(s-piece.start-local)+Math.abs(local-(t===0?0:t===1?piece.length:critical?.length??local));
  if(!critical&&piece.points.length>2&&t>0&&t<1){
    let lo=0,hi=1;
    for(let i=0;i<64;i++){
      t=(lo+hi)/2;const measured=arcLength(piece.points,t),value=measured.value;
      inverseError=measured.error+Math.abs(value-local);
      // Arc residual alone does not constrain the normal near zero speed.
      // Keep tightening the parameter bracket as well.
      if(Math.abs(value-local)<=Math.max(1e-11,piece.uncertainty*2,measured.error*2)&&hi-lo<1e-13)break;
      if(value<local)lo=t;else hi=t;
      if(i===63)throw new Error('弧长定位未达到精度要求');
    }
  }
  const localPoint=evaluate(piece.points,t),point={x:localPoint.x+(metrics.origin?.x||0),y:localPoint.y+(metrics.origin?.y||0)};
  if(pointOnly)return {point,position:s,total:metrics.total,pieceIndex:index,parameter:t,uncertainty:metrics.uncertainty+inverseError+Math.max(Math.abs(point.x),Math.abs(point.y))*Number.EPSILON*2};
  const direction=tangent(piece.points,t);
  if(!critical&&t>0&&t<1&&piece.points.length>2){
    const velocity=evaluate(derivative(piece.points),t),acceleration=evaluate(derivative(derivative(piece.points)),t);
    const speed=norm(velocity),curvature=Math.abs(velocity.x*acceleration.y-velocity.y*acceleration.x)/speed**3;
    const uncertainty=Math.max(1e-11,metrics.uncertainty+inverseError,metrics.total*Number.EPSILON*16);
    const jerk=piece.points.length===4?derivative(derivative(derivative(piece.points)))[0]:{x:0,y:0};
    const higherOrder=.5*Math.abs(velocity.x*jerk.y-velocity.y*jerk.x)/speed**2*(uncertainty/speed)**2;
    if(!Number.isFinite(curvature)||curvature*uncertainty+higherOrder>1e-5)throw new Error('此处法线对位置误差过于敏感，请避开尖点附近');
  }
  const neighbor=t===0?(index>0?pieces[index-1]:metrics.closed?pieces.at(-1):null):t===1?(index<pieces.length-1?pieces[index+1]:metrics.closed?pieces[0]:null):null;
  if(neighbor){
    const other=tangent(neighbor.points,t===0?1:0);
    if(direction.x*other.x+direction.y*other.y<1-1e-8)throw new Error('刀口落在转角，法线不唯一；请调整位置');
  }
  return {point,tangent:direction,position:s,total:metrics.total};
}
