import Clipper from './vendor/clipper.mjs';
import { assertSimplePolygon } from './polygon.mjs';
export const MARKER_GRID=1000;
export function polygonArea(path){let area=0n;for(let i=0;i<path.length;i++){const a=path[i],b=path[(i+1)%path.length];area+=BigInt(a.X)*BigInt(b.Y)-BigInt(a.Y)*BigInt(b.X);}return Number(area)/2;}
export function polygonBounds(path){return {minX:Math.min(...path.map(p=>p.X)),maxX:Math.max(...path.map(p=>p.X)),minY:Math.min(...path.map(p=>p.Y)),maxY:Math.max(...path.map(p=>p.Y))};}
export const translatePolygon=(path,x,y)=>path.map(p=>({X:p.X+x,Y:p.Y+y}));
export function positivePolygon(path){return polygonArea(path)<0?path.slice().reverse():path;}
export function integerPolygon(points){
  let error=0;const path=[];
  for(const p of points){const q={X:Math.round(p.x*MARKER_GRID),Y:Math.round(p.y*MARKER_GRID)};error=Math.max(error,Math.hypot(q.X/MARKER_GRID-p.x,q.Y/MARKER_GRID-p.y));if(!path.length||q.X!==path.at(-1).X||q.Y!==path.at(-1).Y)path.push(q);}
  if(path.length>1&&path[0].X===path.at(-1).X&&path[0].Y===path.at(-1).Y)path.pop();
  if(path.length<3||!polygonArea(path))throw new Error('裁剪边界在 0.001 mm 网格上退化');
  assertSimplePolygon(path);
  // Remove only exact collinear vertices; keep the accepted boundary unchanged.
  const clean=path.filter((b,i)=>{const a=path[(i+path.length-1)%path.length],c=path[(i+1)%path.length];return BigInt(b.X-a.X)*BigInt(c.Y-b.Y)!==BigInt(b.Y-a.Y)*BigInt(c.X-b.X);});
  if(clean.length<3)throw new Error('裁剪边界面积为零');return {path:positivePolygon(clean),error};
}
export function booleanPaths(subject,clip,type){
  const result=[],engine=new Clipper.Clipper();engine.AddPaths(subject,Clipper.PolyType.ptSubject,true);if(clip.length)engine.AddPaths(clip,Clipper.PolyType.ptClip,true);
  engine.Execute(Clipper.ClipType[type],result,Clipper.PolyFillType.pftNonZero,Clipper.PolyFillType.pftNonZero);return result;
}
export function offsetOccupancy(path,padding){
  if(padding<=0)return [path];
  const result=[],offset=new Clipper.ClipperOffset(2,.1);offset.AddPath(path,Clipper.JoinType.jtMiter,Clipper.EndType.etClosedPolygon);offset.Execute(result,Math.ceil(padding));
  // Pieces are treated as solid cutting envelopes. New offset cavities are
  // deliberately occupied; NFP holes are different and must remain intact.
  const outers=result.filter(path=>polygonArea(path)>0);if(!outers.length)throw new Error('无法计算裁片的间距占用区域');return outers;
}
export function polygonsOverlap(a,b){
  const x=polygonBounds(a),y=polygonBounds(b);if(x.maxX<=y.minX||y.maxX<=x.minX||x.maxY<=y.minY||y.maxY<=x.minY)return false;
  // Integer clipping may round a real sub-grid triangular intersection away.
  // Use exact predicates for the acceptance check, including containment,
  // boundary-only vertices, coincident cuts and collinear edge overlap.
  const cross=(p,q,r)=>BigInt(q.X-p.X)*BigInt(r.Y-p.Y)-BigInt(q.Y-p.Y)*BigInt(r.X-p.X);
  const sign=n=>n>0n?1:n<0n?-1:0;
  const segments=path=>path.map((p,i)=>({p,q:path[(i+1)%path.length]}));
  const aa=segments(a),bb=segments(b),winding=Math.sign(polygonArea(a))*Math.sign(polygonArea(b));
  for(const {p,q} of aa)for(const {p:r,q:s} of bb){
    if(Math.max(p.X,q.X)<Math.min(r.X,s.X)||Math.max(r.X,s.X)<Math.min(p.X,q.X)||Math.max(p.Y,q.Y)<Math.min(r.Y,s.Y)||Math.max(r.Y,s.Y)<Math.min(p.Y,q.Y))continue;
    const c1=cross(p,q,r),c2=cross(p,q,s),c3=cross(r,s,p),c4=cross(r,s,q);
    if(sign(c1)*sign(c2)<0&&sign(c3)*sign(c4)<0)return true;
    if(c1===0n&&c2===0n){
      const axis=p.X===q.X?'Y':'X',overlap=Math.min(Math.max(p[axis],q[axis]),Math.max(r[axis],s[axis]))-Math.max(Math.min(p[axis],q[axis]),Math.min(r[axis],s[axis]));
      const dot=BigInt(q.X-p.X)*BigInt(s.X-r.X)+BigInt(q.Y-p.Y)*BigInt(s.Y-r.Y);
      if(overlap>0&&sign(dot)*winding>0)return true;
    }
  }
  function strictlyInside(point,path){
    let inside=false;
    for(let i=0;i<path.length;i++){
      const p={X:path[i].X*2,Y:path[i].Y*2},q={X:path[(i+1)%path.length].X*2,Y:path[(i+1)%path.length].Y*2},c=cross(p,q,point);
      if(c===0n&&point.X>=Math.min(p.X,q.X)&&point.X<=Math.max(p.X,q.X)&&point.Y>=Math.min(p.Y,q.Y)&&point.Y<=Math.max(p.Y,q.Y))return false;
      if((p.Y>point.Y)!==(q.Y>point.Y)&&sign(c)===(q.Y>p.Y?1:-1))inside=!inside;
    }
    return inside;
  }
  return aa.some(({p,q})=>strictlyInside({X:p.X*2,Y:p.Y*2},b)||strictlyInside({X:p.X+q.X,Y:p.Y+q.Y},b))||bb.some(({p,q})=>strictlyInside({X:p.X*2,Y:p.Y*2},a)||strictlyInside({X:p.X+q.X,Y:p.Y+q.Y},a));
}
export function occupancyOverlap(a,b){return a.some(first=>b.some(second=>polygonsOverlap(first,second)));}
export function noFitPolygon(fixed,moving){
  if(fixed.length*moving.length>250000)throw new Error('轮廓过于复杂，已停止禁区搜索；可用手动排料或提高曲线计算容差');
  const boundary=Clipper.Clipper.MinkowskiDiff(moving,fixed);
  const a0=fixed[0],b0=moving[0];
  // Edge sweeps alone miss complete containment in either direction.
  const fixedFill=positivePolygon(translatePolygon(fixed,-b0.X,-b0.Y));
  const movingFill=positivePolygon(moving.map(p=>({X:a0.X-p.X,Y:a0.Y-p.Y})));
  return booleanPaths([...boundary,fixedFill,movingFill],[],'ctUnion');
}
export function polygonContainsPoint(path,p){return Clipper.Clipper.PointInPolygon({X:Math.round(p.x*MARKER_GRID),Y:Math.round(p.y*MARKER_GRID)},path)!==0;}
