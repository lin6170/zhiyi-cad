import { validateCurve, evaluateBSpline } from './curves.mjs';
const copyPoint=p=>({x:p.x,y:p.y});
// The model's closed flag includes a straight end-to-start segment. Encode that
// segment inside the spline, rather than asking another CAD to invent closure.
export function closedDxfCurve(curve){
  validateCurve(curve);const p=curve.degree,points=curve.controlPoints;
  const first=points[0],last=points.at(-1);
  if(first.x===last.x&&first.y===last.y)return curve;
  if(points.length+p>1002)throw new Error('闭合样条补边后超过 1002 个控制点，请改用兼容折线 DXF');
  const start=curve.knots[p],end=curve.knots[points.length],range=end-start;
  const knots=curve.knots.map(k=>(k-start)/range);
  if(knots.some((k,i)=>i&&curve.knots[i]>curve.knots[i-1]&&k<=knots[i-1]))throw new Error('样条参数范围无法稳定编码闭合补边');
  knots.pop();knots.push(...Array(p+1).fill(2));
  const controlPoints=points.map(copyPoint);
  for(let i=1;i<=p;i++)controlPoints.push(i===p?copyPoint(first):{x:last.x+(first.x-last.x)*i/p,y:last.y+(first.y-last.y)*i/p});
  return validateCurve({...curve,controlPoints,knots});
}

// Convert an unclamped, non-rational B-spline's active domain into exact Bezier
// spans. Interior multiplicity above degree is discontinuous and is rejected.
export function clampDxfCurve(curve){
  const {degree:p,controlPoints,knots}=curve,n=controlPoints.length;
  if(![2,3].includes(p)||n<p+1||n>1002||knots.length!==n+p+1)throw new Error('DXF 样条控制点、次数或结点数量不匹配');
  if(knots.some((k,i)=>!Number.isFinite(k)||i&&k<knots[i-1]))throw new Error('DXF 样条结点必须有限且不递减');
  const start=knots[p],end=knots[n];if(!(end>start)||!Number.isFinite(end-start))throw new Error('DXF 样条参数区间无效');
  let run=0,previous=null;for(const knot of knots){run=knot===previous?run+1:1;previous=knot;if(knot>start&&knot<end&&run>p)throw new Error('DXF 样条内部断开结点暂不支持');}
  if(knots.slice(0,p+1).every(k=>k===start)&&knots.slice(-p-1).every(k=>k===end))return {curve:validateCurve(curve),converted:false};
  const origin=controlPoints[0],local=controlPoints.map(point=>({x:point.x-origin.x,y:point.y-origin.y})),spans=[];
  for(let i=p;i<n;i++){
    const a=knots[i],b=knots[i+1],width=b-a;if(!width)continue;
    const first=evaluateBSpline(local,knots,a,p,'right'),last=evaluateBSpline(local,knots,b,p,'left');
    const scaledDerivatives=local.slice(0,-1).map((point,j)=>{const denominator=knots[j+p+1]-knots[j+1],ratio=denominator?width/denominator:0;return {x:(local[j+1].x-point.x)*ratio,y:(local[j+1].y-point.y)*ratio};});
    const da=evaluateBSpline(scaledDerivatives,knots.slice(1,-1),a,p-1,'right'),db=evaluateBSpline(scaledDerivatives,knots.slice(1,-1),b,p-1,'left');
    const points=[first,{x:first.x+da.x,y:first.y+da.y}];if(p===3)points.push({x:last.x-db.x,y:last.y-db.y});points.push(last);spans.push(points);
  }
  if(spans.length*p+1>1002)throw new Error('DXF 样条转换后超过 1002 个控制点');
  const world=point=>({x:point.x+origin.x,y:point.y+origin.y}),points=spans[0].map(world),outKnots=Array(p+1).fill(0);
  for(let i=1;i<spans.length;i++){points.push(...spans[i].slice(1).map(world));outKnots.push(...Array(p).fill(i));}
  outKnots.push(...Array(p+1).fill(spans.length));
  return {curve:validateCurve({...curve,controlPoints:points,knots:outKnots}),converted:true};
}
