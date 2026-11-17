import Clipper from './vendor/clipper.mjs';
import { assertSimplePolygon } from './polygon.mjs';
export const MARKER_GRID=1000;
const SPIKE=2;   // grid steps: the longest spike that rounding alone can make is one step in each direction
export function polygonArea(path){let area=0n;for(let i=0;i<path.length;i++){const a=path[i],b=path[(i+1)%path.length];area+=BigInt(a.X)*BigInt(b.Y)-BigInt(a.Y)*BigInt(b.X);}return Number(area)/2;}
export function polygonBounds(path){return {minX:Math.min(...path.map(p=>p.X)),maxX:Math.max(...path.map(p=>p.X)),minY:Math.min(...path.map(p=>p.Y)),maxY:Math.max(...path.map(p=>p.Y))};}
export const translatePolygon=(path,x,y)=>path.map(p=>({X:p.X+x,Y:p.Y+y}));
export function positivePolygon(path){return polygonArea(path)<0?path.slice().reverse():path;}
export function integerPolygon(points){
  let error=0;const path=[];
  for(const p of points){const q={X:Math.round(p.x*MARKER_GRID),Y:Math.round(p.y*MARKER_GRID)};error=Math.max(error,Math.hypot(q.X/MARKER_GRID-p.x,q.Y/MARKER_GRID-p.y));if(!path.length||q.X!==path.at(-1).X||q.Y!==path.at(-1).Y)path.push(q);}
  if(path.length>1&&path[0].X===path.at(-1).X&&path[0].Y===path.at(-1).Y)path.pop();
  // Two lines of an outline can end in points that differ by less than the grid (an ET file holds 32-bit numbers), and those can
  // round to two grid points one step apart. When that step runs straight back along the line before it, the outline has a spike
  // of zero width, a thousandth of a millimetre long. That is an artefact of the rounding, not a fold in the pattern: the tip of
  // such a spike is left out, and its length is counted in the uncertainty. A longer fold is still refused below.
  let spike=0;
  for(let i=0,guard=path.length*2;path.length>3&&i<path.length&&guard>0;){
    const a=path[(i+path.length-1)%path.length],b=path[i],c=path[(i+1)%path.length];
    const back=BigInt(b.X-a.X)*BigInt(c.Y-a.Y)===BigInt(b.Y-a.Y)*BigInt(c.X-a.X)&&BigInt(b.X-a.X)*BigInt(c.X-b.X)+BigInt(b.Y-a.Y)*BigInt(c.Y-b.Y)<0n;
    const reach=Math.min(Math.hypot(b.X-a.X,b.Y-a.Y),Math.hypot(c.X-b.X,c.Y-b.Y));
    if(!back||reach>SPIKE){i++;continue;}
    path.splice(i,1);spike=Math.max(spike,reach);guard--;
    const j=i%path.length,before=path[(j+path.length-1)%path.length];if(path.length>1&&before.X===path[j].X&&before.Y===path[j].Y)path.splice(j,1);
    i=Math.max(0,i-2);
  }
  error+=spike/MARKER_GRID;
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
// A simpler outline around a piece, for the search of the automatic layout. The outline of a real piece has hundreds of points
// (its curves are followed within a hundredth of a millimetre), and the search compares every pair of pieces point by point.
// Here the points that stray less than `tolerance` (grid steps) from the line through their neighbours are left out, and the
// result is moved outward by the same amount: no point of the piece lies outside the new outline, and the new outline lies at
// most twice the tolerance outside the piece. A place found with it is still checked against the real outlines.
function fewerPoints(path,tolerance){
  if(path.length<=8)return path;
  let far=0,most=-1;for(let i=1;i<path.length;i++){const d=(path[i].X-path[0].X)**2+(path[i].Y-path[0].Y)**2;if(d>most){most=d;far=i;}}
  const ring=[...path,path[0]],keep=new Uint8Array(ring.length),stack=[[0,far],[far,path.length]];keep[0]=keep[far]=1;
  while(stack.length){
    const [a,b]=stack.pop(),p=ring[a],q=ring[b],dx=q.X-p.X,dy=q.Y-p.Y,square=dx*dx+dy*dy;let worst=0,at=-1;
    for(let i=a+1;i<b;i++){const r=ring[i],t=square?Math.max(0,Math.min(1,((r.X-p.X)*dx+(r.Y-p.Y)*dy)/square)):0,d=Math.hypot(r.X-p.X-t*dx,r.Y-p.Y-t*dy);if(d>worst){worst=d;at=i;}}
    if(worst>tolerance){keep[at]=1;stack.push([a,at],[at,b]);}
  }
  return path.filter((_,i)=>keep[i]);
}
export function outerOutline(paths,tolerance){
  const result=[],offset=new Clipper.ClipperOffset(2,.1);
  for(const path of paths){const fewer=fewerPoints(path,tolerance);if(fewer.length<3||!polygonArea(fewer))return paths;offset.AddPath(fewer,Clipper.JoinType.jtMiter,Clipper.EndType.etClosedPolygon);}
  offset.Execute(result,Math.ceil(tolerance)+2);
  const outers=result.filter(path=>polygonArea(path)>0);return outers.length?outers:paths;
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
      const p={X:path[i].X*2,Y:path[i].Y*2},q={X:path[(i+1)%path.length].X*2,Y:path[(i+1)%path.length].Y*2};
      if(point.Y<Math.min(p.Y,q.Y)||point.Y>Math.max(p.Y,q.Y))continue;   // such an edge can neither hold the point nor be crossed by the ray from it
      const c=cross(p,q,point);
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
