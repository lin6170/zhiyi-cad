import Clipper from './vendor/clipper.mjs';
import { assertSimplePolygon } from './polygon.mjs';

const cross=(a,b)=>a.X*b.Y-a.Y*b.X;
const sub=(a,b)=>({X:a.X-b.X,Y:a.Y-b.Y});
const add=(a,b,f=1)=>({X:a.X+b.X*f,Y:a.Y+b.Y*f});
function supportEnvelope(path,widths,tangent,normal,direction=1){
  const count=path.length;
  if(direction>0&&tangent.every((t,i)=>cross(tangent[(i+count-1)%count],t)>=-1e-12)){
    // Every nonuniform convex offset lies inside the uniform unlimited-miter
    // offset at the maximum width. Its bounds provide a finite clipping box.
    const width=Math.max(...widths),outer=path.map((v,j)=>{
      const k=(j+count-1)%count,denominator=1+tangent[k].X*tangent[j].X+tangent[k].Y*tangent[j].Y;
      const p=add(v,add(normal[k],normal[j]),width/denominator);
      if(!Number.isFinite(p.X)||!Number.isFinite(p.Y)||Math.max(Math.abs(p.X),Math.abs(p.Y))>1e14)throw new Error('变宽交接过于接近平行，无法稳定计算');
      return p;
    }),bounds=Clipper.Clipper.GetBounds([outer]);
    let clipped=[{X:bounds.left-1,Y:bounds.top-1},{X:bounds.right+1,Y:bounds.top-1},{X:bounds.right+1,Y:bounds.bottom+1},{X:bounds.left-1,Y:bounds.bottom+1}];
    if(count*count>2000000)throw new Error('轮廓过于复杂，暂不能生成逐边缝份');
    for(let i=0;i<count&&clipped.length;i++)clipped=clipHalfPlane(clipped,path[i],tangent[i],-widths[i]);
    return Clipper.Clipper.CleanPolygon(clipped.map(p=>({X:Math.round(p.X),Y:Math.round(p.Y)})),.5);
  }
  const corners=path.map((v,j)=>{
    const k=(j+count-1)%count,a=add(v,normal[k],widths[k]),b=add(v,normal[j],widths[j]),turn=cross(tangent[k],tangent[j]);
    if(Math.abs(turn)<1e-12)return {before:a,after:b};
    const intersection=add(a,tangent[k],cross(sub(b,a),tangent[j])/turn);
    if(Math.max(Math.abs(intersection.X),Math.abs(intersection.Y))>1e14)throw new Error('变宽交接过于接近平行，无法稳定计算');
    return {before:intersection,after:intersection};
  });
  for(let i=0;i<count;i++){
    const edge=sub(corners[(i+1)%count].before,corners[i].after);
    if(edge.X*tangent[i].X+edge.Y*tangent[i].Y< -1e-6)throw new Error('逐边宽度使局部边消失或反向，请减小宽度差或改用统一宽度');
  }
  const envelope=[];
  for(const corner of corners)for(const p of [corner.before,corner.after]){
    const q={X:Math.round(p.X),Y:Math.round(p.Y)};
    if(!envelope.length||q.X!==envelope.at(-1).X||q.Y!==envelope.at(-1).Y)envelope.push(q);
  }
  if(envelope.length>1&&envelope[0].X===envelope.at(-1).X&&envelope[0].Y===envelope.at(-1).Y)envelope.pop();
  if(envelope.length<3||Clipper.Clipper.Area(envelope)<=0)throw new Error('偏移后轮廓消失，请减小宽度');
  try{assertSimplePolygon(envelope);}catch(error){throw new Error('逐边宽度使偏移边界交叉或接触，请减小宽度差或改用统一宽度');}
  // A zero-width side should not disappear through winding cancellation.
  const check=new Clipper.Clipper(),missing=[];
  check.AddPath(direction>0?path:envelope,Clipper.PolyType.ptSubject,true);check.AddPath(direction>0?envelope:path,Clipper.PolyType.ptClip,true);
  check.Execute(Clipper.ClipType.ctDifference,missing,Clipper.PolyFillType.pftNonZero,Clipper.PolyFillType.pftNonZero);
  if(missing.some(p=>Clipper.Clipper.CleanPolygon(p,Math.SQRT2).length>=3))throw new Error('逐边偏移超出有效区域，请减小宽度差或改用统一宽度');
  return envelope;
}
function joinPoints(vertex,intersection,previous,next,normalPrevious,normalNext,widthPrevious,widthNext,turn,config){
  const dot=previous.X*next.X+previous.Y*next.Y,angle=Math.atan2(turn,dot);
  if(config.join==='miter'&&1+dot>=2/(config.miterLimit**2))return [intersection];
  if(config.join==='round'){
    // Interpolate the radial distance over the turn. Bound the second
    // derivative as well as the radius when choosing chord samples.
    const curvatureBound=Math.hypot(Math.max(widthPrevious,widthNext),2*(widthNext-widthPrevious)/angle);
    const start=Math.atan2(normalPrevious.Y,normalPrevious.X),steps=Math.max(1,Math.ceil(Math.abs(angle)*Math.sqrt(curvatureBound/(8*config.arcTolerance))));
    if(steps>200000)throw new Error('变宽圆角采样超过上限');
    return Array.from({length:steps+1},(_,i)=>{const radius=widthPrevious+(widthNext-widthPrevious)*i/steps;return {X:vertex.X+radius*Math.cos(start+angle*i/steps),Y:vertex.Y+radius*Math.sin(start+angle*i/steps)};});
  }
  const cut=Math.tan(Math.abs(angle)/4);
  return [add(add(vertex,normalPrevious,widthPrevious),previous,widthPrevious*cut),add(add(vertex,normalNext,widthNext),next,-widthNext*cut)];
}
function clipHalfPlane(points,origin,tangent,width){
  const value=p=>cross(tangent,sub(p,origin))-width,result=[];
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length],fa=value(a),fb=value(b);
    if(fa>=0)result.push(a);
    if((fa<0)!==(fb<0))result.push(add(a,sub(b,a),fa/(fa-fb)));
  }
  return result;
}
export function variableOffset(path,widths,direction,config){
  const count=path.length,tangent=path.map((p,i)=>{const v=sub(path[(i+1)%count],p),length=Math.hypot(v.X,v.Y);return {X:v.X/length,Y:v.Y/length};});
  const normal=tangent.map(t=>({X:t.Y*direction,Y:-t.X*direction}));
  if(direction<0){
    const convex=tangent.every((t,i)=>cross(tangent[(i+count-1)%count],t)>=-1e-12);
    if(!convex){
      if(config.join!=='miter')throw new Error('不等宽凹形内缩目前仅支持尖角，请选择尖角或改用统一宽度');
      if(tangent.some((t,i)=>{const previous=tangent[(i+count-1)%count];return cross(previous,t)<-1e-12&&1+previous.X*t.X+previous.Y*t.Y<2/(config.miterLimit**2);}))throw new Error('不等宽内缩的凹角达到尖角限长，请调整限长倍数或改用统一宽度');
      return [supportEnvelope(path,widths,tangent,normal,-1)];
    }
    if(count*count>2000000)throw new Error('轮廓过于复杂，暂不能生成逐边缝份');
    let clipped=path.map(p=>({...p}));
    for(let i=0;i<count&&clipped.length;i++)clipped=clipHalfPlane(clipped,path[i],tangent[i],widths[i]);
    const rounded=clipped.map(p=>({X:Math.round(p.X),Y:Math.round(p.Y)}));
    return rounded.length>=3&&Clipper.Clipper.Area(rounded)>0?[rounded]:[];
  }
  const envelope=supportEnvelope(path,widths,tangent,normal);
  const raw=[];
  function push(p){
    if(raw.length>=200000)throw new Error('变宽转角采样超过上限，请增加圆角容差');
    const q={X:Math.round(p.X),Y:Math.round(p.Y)};
    if(!Number.isFinite(q.X)||!Number.isFinite(q.Y))throw new Error('变宽转角无法稳定计算');
    if(!raw.length||q.X!==raw.at(-1).X||q.Y!==raw.at(-1).Y)raw.push(q);
  }
  for(let j=0;j<count;j++){
    const k=(j+count-1)%count,v=path[j],a=add(v,normal[k],widths[k]),b=add(v,normal[j],widths[j]),turn=cross(tangent[k],tangent[j]);
    if(Math.abs(turn)<1e-12){push(a);push(b);continue;}
    if(turn<0){push(a);push(v);push(b);continue;}
    const u=cross(sub(b,a),tangent[j])/turn,intersection=add(a,tangent[k],u);
    if(Math.max(Math.abs(intersection.X),Math.abs(intersection.Y))>1e14)throw new Error('变宽交接过于接近平行，无法稳定计算');
    // Keep the join choice tied to the corner angle, as in Clipper. A test
    // based on unequal radii can switch styles and shrink an enlarged seam.
    for(const p of joinPoints(v,intersection,tangent[k],tangent[j],normal[k],normal[j],widths[k],widths[j],turn,config))push(p);
  }
  const clipper=new Clipper.Clipper(),solution=[];
  clipper.AddPath(raw,Clipper.PolyType.ptSubject,true);
  clipper.Execute(Clipper.ClipType.ctUnion,solution,Clipper.PolyFillType.pftPositive,Clipper.PolyFillType.pftPositive);
  // Unequal radial/square joins can cross a neighbouring offset support.
  // Clip to the unlimited-miter region, without forcing a zero-width corner
  // to its miter intersection (which would make later widening shrink it).
  const bounded=[],trim=new Clipper.Clipper();
  trim.AddPaths(solution,Clipper.PolyType.ptSubject,true);trim.AddPath(envelope,Clipper.PolyType.ptClip,true);
  trim.Execute(Clipper.ClipType.ctIntersection,bounded,Clipper.PolyFillType.pftNonZero,Clipper.PolyFillType.pftNonZero);
  return bounded;
}
