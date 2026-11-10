// Non-rational, clamped B-spline geometry. Source bytes remain separate provenance.
export function validateCurve(curve) {
  if (!curve || curve.kind !== 'bspline' || ![2,3].includes(curve.degree) || !Array.isArray(curve.controlPoints) || !Array.isArray(curve.knots)) throw new Error('样条定义无效');
  const { degree: p, controlPoints: points, knots } = curve;
  if (points.length < p + 1 || points.length > 1002 || knots.length !== points.length + p + 1) throw new Error('样条控制点或结点数量无效');
  if (points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x)>1e8 || Math.abs(point.y)>1e8)) throw new Error('样条控制点坐标无效');
  if (knots.some((k,i) => !Number.isFinite(k) || (i && k < knots[i-1]))) throw new Error('样条结点必须有限且不递减');
  const start=knots[p],end=knots[points.length];
  if (!(end > start) || !Number.isFinite(end-start) || knots.slice(0,p+1).some(k=>k!==start) || knots.slice(-p-1).some(k=>k!==end)) throw new Error('仅支持具有有效区间的夹持样条');
  let run=0,previous=null;
  for(const knot of knots.slice(p+1,-p-1)) {
    run=knot===previous?run+1:1; previous=knot;
    if(knot<=start || knot>=end || run>p) throw new Error('不支持断开的样条结点');
  }
  if(curve.samplingTolerance!==undefined && (!Number.isFinite(curve.samplingTolerance)||curve.samplingTolerance<=0)) throw new Error('样条显示容差无效');
  return curve;
}

export function evaluateBSpline(controlPoints, knots, parameter, degree, side='right') {
  return evaluateWithAccessor(controlPoints.length,knots,parameter,degree,i=>controlPoints[i],side);
}
function evaluateWithAccessor(count,knots,parameter,degree,pointAt,side) {
  const last=count-1, start=knots[degree], end=knots[last+1];
  const t=Math.max(start,Math.min(end,parameter));
  let span=last;
  if(t<end) {
    let low=degree,high=last+1;
    while(high-low>1) { const middle=Math.floor((low+high)/2); if(t<knots[middle] || (side==='left' && t===knots[middle] && t>start)) high=middle; else low=middle; }
    span=low;
  }
  const work=Array.from({length:degree+1},(_,i)=>({...pointAt(span-degree+i)}));
  for(let level=1;level<=degree;level++) for(let j=degree;j>=level;j--) {
    const index=j+span-degree, width=knots[j+1+span-level]-knots[index];
    const alpha=width?(t-knots[index])/width:0;
    work[j]={x:(1-alpha)*work[j-1].x+alpha*work[j].x,y:(1-alpha)*work[j-1].y+alpha*work[j].y};
  }
  return work[degree];
}

export function bezierSpans(curve) {
  validateCurve(curve);
  const {degree:p,controlPoints:points,knots}=curve;
  const derivativeKnots=knots.slice(1,-1), result=[];
  const value=(t,side)=>evaluateBSpline(points,knots,t,p,side);
  // Multiply by span length before division. This avoids derivative overflow
  // for tiny parameter domains while preserving exactly the same geometry.
  const tangentOffset=(t,side,width)=>evaluateWithAccessor(points.length-1,derivativeKnots,t,p-1,i=>{
    const divisor=knots[i+p+1]-knots[i+1],ratio=divisor?width/divisor:0;
    return {x:(points[i+1].x-points[i].x)*ratio,y:(points[i+1].y-points[i].y)*ratio};
  },side);
  for(let i=p;i<points.length;i++) {
    const start=knots[i],end=knots[i+1];if(end<=start)continue;
    const a=value(start,'right'),b=value(end,'left'),da=tangentOffset(start,'right',end-start),db=tangentOffset(end,'left',end-start);
    const controls=[a,{x:a.x+da.x,y:a.y+da.y}];
    if(p===3) controls.push({x:b.x-db.x,y:b.y-db.y});
    controls.push(b);
    if(controls.some(point=>!Number.isFinite(point.x)||!Number.isFinite(point.y)))throw new Error('样条参数范围无法稳定计算');
    result.push({start,end,controlPoints:controls});
  }
  return result;
}

function pointOnBezier(points,t) {
  const work=points.map(point=>({...point}));
  for(let n=work.length-1;n>0;n--)for(let i=0;i<n;i++)work[i]={x:work[i].x*(1-t)+work[i+1].x*t,y:work[i].y*(1-t)+work[i+1].y*t};
  return work[0];
}
function splitBezier(points) {
  const left=[points[0]],right=[points.at(-1)];let row=points;
  while(row.length>1){row=row.slice(0,-1).map((point,i)=>({x:(point.x+row[i+1].x)/2,y:(point.y+row[i+1].y)/2}));left.push(row[0]);right.unshift(row.at(-1));}
  return [left,right];
}
function chordDistance(point,a,b) {
  const dx=b.x-a.x,dy=b.y-a.y,squared=dx*dx+dy*dy;
  const t=squared?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/squared)):0;
  return Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy);
}
export function sampleCurve(curve,maxPoints=8192) {
  const spans=bezierSpans(curve),tolerance=curve.samplingTolerance??.002;
  const points=[{...spans[0].controlPoints[0]}];let capped=false;
  function subdivide(controls,depth,budget) {
    const flat=controls.slice(1,-1).every(point=>chordDistance(point,controls[0],controls.at(-1))<=tolerance);
    if(flat||depth>=20||budget<=1){if(!flat)capped=true;points.push({...controls.at(-1)});return 1;}
    const [a,b]=splitBezier(controls),used=subdivide(a,depth+1,Math.floor(budget/2));
    return used+subdivide(b,depth+1,budget-used);
  }
  spans.forEach((span,i)=>subdivide(span.controlPoints,0,Math.max(1,Math.floor((maxPoints-points.length)/(spans.length-i)))));
  return {points,capped,tolerance};
}

// Split at derivative-component zeros and extrema before quadrature. An
// arbitrarily narrow reversal can otherwise fall between every sample and
// give a false zero Simpson error, even with many initial intervals.
export function bezierIntegrationBreaks(points,end=1){
  const p=points.length-1,derivative=points.slice(0,-1).map((point,i)=>({x:p*(points[i+1].x-point.x),y:p*(points[i+1].y-point.y)}));
  const roots=[0,end];
  const add=t=>{if(Number.isFinite(t)&&t>0&&t<end)roots.push(t);};
  for(const key of ['x','y']){
    const d=derivative.map(point=>point[key]);
    if(d.length===2){if(d[1]!==d[0])add(-d[0]/(d[1]-d[0]));}
    if(d.length===3){
      const a=d[0]-2*d[1]+d[2],b=2*(d[1]-d[0]),c=d[0];
      if(a===0){if(b!==0)add(-c/b);continue;}
      add(-b/(2*a));
      let discriminant=b*b-4*a*c;
      if(Math.abs(discriminant)<=Number.EPSILON*8*(b*b+Math.abs(4*a*c)))discriminant=0;
      if(discriminant<0)continue;
      const q=-.5*(b+(b>=0?1:-1)*Math.sqrt(discriminant));
      if(q===0)add(-b/(2*a));else {add(q/a);add(c/q);}
    }
  }
  return [...new Set(roots)].sort((a,b)=>a-b);
}

export function localizeCurve(curve){
  validateCurve(curve);
  const origin={};
  for(const axis of ['x','y']){const values=curve.controlPoints.map(p=>p[axis]),low=Math.min(...values),high=Math.max(...values);origin[axis]=low+(high-low)/2;}
  return {origin,curve:{...curve,controlPoints:curve.controlPoints.map(p=>({x:p.x-origin.x,y:p.y-origin.y}))}};
}
export function curveLength(curve,absoluteTolerance=1e-6,relativeTolerance=1e-10) {
  if(!Number.isFinite(absoluteTolerance)||absoluteTolerance<0||!Number.isFinite(relativeTolerance)||relativeTolerance<0)throw new Error('弧长误差容差无效');
  const spans=bezierSpans(localizeCurve(curve).curve);let value=0,estimatedError=0,evaluations=0,converged=true;
  for(const span of spans) {
    const points=span.controlPoints,p=points.length-1;
    estimatedError+=Math.max(...points.flatMap(point=>[Math.abs(point.x),Math.abs(point.y)]))*Number.EPSILON*128*points.length;
    const derivative=points.slice(0,-1).map((point,i)=>({x:p*(points[i+1].x-point.x),y:p*(points[i+1].y-point.y)}));
    const speed=t=>{evaluations++;const v=pointOnBezier(derivative,t),speed=Math.hypot(v.x,v.y);if(!Number.isFinite(speed))throw new Error('样条弧长无法稳定计算');return speed;};
    const simpson=(a,b,fa,fm,fb)=>(b-a)*(fa+4*fm+fb)/6;
    function integrate(a,b,fa,fm,fb,whole,tolerance,depth) {
      const middle=(a+b)/2,fl=speed((a+middle)/2),fr=speed((middle+b)/2);
      const left=simpson(a,middle,fa,fl,fm),right=simpson(middle,b,fm,fr,fb),delta=left+right-whole,error=Math.abs(delta)/15;
      if(error<=tolerance||depth>=20||evaluations>=100000){
        if(error>tolerance)converged=false;
        value+=left+right+delta/15;estimatedError+=error;return;
      }
      integrate(a,middle,fa,fl,fm,left,tolerance/2,depth+1);integrate(middle,b,fm,fr,fb,right,tolerance/2,depth+1);
    }
    const breaks=bezierIntegrationBreaks(points);
    for(let segment=0;segment<breaks.length-1;segment++)for(let i=0;i<8;i++) {
      const width=breaks[segment+1]-breaks[segment],a=breaks[segment]+width*i/8,b=breaks[segment]+width*(i+1)/8,fa=speed(a),fm=speed((a+b)/2),fb=speed(b),whole=simpson(a,b,fa,fm,fb);
      integrate(a,b,fa,fm,fb,whole,absoluteTolerance*width/(spans.length*8)+relativeTolerance*Math.abs(whole),0);
    }
  }
  converged=converged&&estimatedError<=absoluteTolerance+relativeTolerance*Math.abs(value);
  return {value,estimatedError,converged,evaluations,method:'adaptive-simpson-bezier-speed'};
}

export function refreshCurve(entity) {
  validateCurve(entity.curve);
  const sampled=sampleCurve(entity.curve);
  entity.points=sampled.points;entity.curveSamplingCapped=sampled.capped;
  return entity;
}
export function editControlPoint(entity,index,point) {
  if(!entity.curve || !Number.isInteger(index) || index<0 || index>=entity.curve.controlPoints.length) throw new Error('无效的控制点');
  const candidate={...entity.curve,controlPoints:entity.curve.controlPoints.map((p,i)=>({... (i===index?point:p)}))};
  validateCurve(candidate);
  entity.curve=candidate;refreshCurve(entity);
  if(entity.source)entity.source.modified=true;
}
export function quadraticCurve(a,control,b) {
  return {kind:'bspline',degree:2,controlPoints:[a,control,b].map(point=>({...point})),knots:[0,0,0,1,1,1],samplingTolerance:.002};
}
