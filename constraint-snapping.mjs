import {bezierConstraintRoots} from './polynomial-roots.mjs';
import {evaluateBezier} from './bezier-cut.mjs';

// All isolated solutions on the finite span, never a clamped nearest
// endpoint or an extension. Returned values remain numerical coordinates.
export function constrainedBezierPoints(points,anchor,mode){
  const result=bezierConstraintRoots(points,anchor,mode);
  return result.roots.map(parameter=>{
    const point=evaluateBezier(points,parameter),dx=point.x-anchor.x,dy=point.y-anchor.y,length=Math.hypot(dx,dy);
    if(!length||![length,point.x,point.y].every(Number.isFinite))throw new Error('垂足或切点方向在当前坐标精度下无法确定');
    const tangent=result.directionAt(parameter),relationResidual=Math.abs(mode==='perpendicular'?dx/length*tangent.x+dy/length*tangent.y:dx/length*tangent.y-dy/length*tangent.x);
    if(relationResidual>1e-8)throw new Error('垂足或切点的方向残差过大，请调整起点或缩放');
    return {point,parameter,kind:mode,tangent,relationResidual,spanSide:parameter===0?'start':parameter===1?'end':'interior'};
  });
}
