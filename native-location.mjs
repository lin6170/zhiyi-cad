import { power, derivative, polynomialRoots, evaluateBezier, sliceBezier } from './bezier-cut.mjs';
function monotoneSpans(points,axis){
  const coefficients=power(points.map(p=>p[axis])),breaks=[0,...polynomialRoots(derivative(coefficients)).filter(t=>t>0&&t<1),1].sort((a,b)=>a-b),result=[];
  const vertices=breaks.map(t=>evaluateBezier(points,t));
  for(let i=0;i<breaks.length-1;i++){const p=sliceBezier(points,breaks[i],breaks[i+1]);p[0]=vertices[i];p[p.length-1]=vertices[i+1];result.push({points:p,a:p[0],b:p.at(-1),minX:Math.min(...p.map(q=>q.x)),maxX:Math.max(...p.map(q=>q.x))});}return result;
}
function coordinatePoint(segment,axis,q){
  const {a,b}=segment,up=b[axis]>a[axis];if(q<=Math.min(a[axis],b[axis]))return up?a:b;if(q>=Math.max(a[axis],b[axis]))return up?b:a;
  let lo=0,hi=1,t=0;
  for(let k=0;k<80;k++){t=(lo+hi)/2;if(t===lo||t===hi)break;const coordinate=evaluateBezier(segment.points,t)[axis];if(coordinate===q)break;if((coordinate<q)===up)lo=t;else hi=t;}
  return evaluateBezier(segment.points,t);
}
// Point containment for a native polynomial contour. Decompose by y extrema;
// each monotone span uses [lower, upper) crossings, so vertices and tangencies
// cannot add spurious winding. Display samples and the polygon grid are unused.
export function nativeLocator(parts,tolerance=1e-9){
  if(!Number.isFinite(tolerance)||tolerance<0)throw new Error('位置判断容差无效');
  const spans=parts.map(part=>{const points=part.points,minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y)),monotone=monotoneSpans(points,'y'),axis=maxX-minX>=maxY-minY?'x':'y';
    return {monotone,projections:axis==='y'?monotone:monotoneSpans(points,'x'),axis,minX,maxX,minY,maxY};
  });
  return point=>{
    if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))throw new Error('位置判断坐标无效');
    let winding=0;
    for(const span of spans){
      // Boundary points are found by monotone coordinate inversion, not a
      // degree-five nearest-point polynomial with nearly repeated roots.
      if(point.x>=span.minX-tolerance&&point.x<=span.maxX+tolerance&&point.y>=span.minY-tolerance&&point.y<=span.maxY+tolerance)for(const segment of span.projections){
        const q=point[span.axis];if(q<Math.min(segment.a[span.axis],segment.b[span.axis])-tolerance||q>Math.max(segment.a[span.axis],segment.b[span.axis])+tolerance)continue;
        const p=coordinatePoint(segment,span.axis,q);if(Math.hypot(p.x-point.x,p.y-point.y)<=tolerance)return 0;
      }
      for(const segment of span.monotone){const {a,b}=segment;if(a.y===b.y||point.y<Math.min(a.y,b.y)||point.y>=Math.max(a.y,b.y)||segment.maxX<point.x)continue;
        const up=b.y>a.y;if(segment.minX>point.x){winding+=up?1:-1;continue;}
        const x=coordinatePoint(segment,'y',point.y).x;if(Math.abs(x-point.x)<=tolerance)return 0;if(x>point.x)winding+=up?1:-1;
      }
    }
    return winding===0?-1:1;
  };
}
