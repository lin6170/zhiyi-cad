import {evaluateBSpline,refreshCurve} from './curves.mjs';
import {reconstructSpline} from './spline.mjs';

export function fitParameters(points){
  const values=[0];
  for(let i=1;i<points.length;i++){
    const d=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);
    if(!Number.isFinite(d)||d<1e-8)throw Error('拟合点重合，无法稳定改版。');
    values.push(values.at(-1)+d*(i===1||i===points.length-1?1.5:1));
  }
  return values;
}
export function parameterKnots(parameters){const end=parameters.at(-1);return [0,0,0,0,...parameters.slice(1,-1),end,end,end,end];}
export function mapFitParameter(t,before,after){
  if(t<=0)return 0;if(t>=before.at(-1))return after.at(-1);
  let i=0;while(before[i+1]<t)i++;
  return after[i]+(after[i+1]-after[i])*(t-before[i])/(before[i+1]-before[i]);
}
// Interpolate existing fit points with the observed repeated endpoint controls.
// Solve locally around the first point, avoiding cancellation at large coordinates.
export function fitClampedSpline(points){
  if(points.length<2||points.length>128)throw Error('拟合点数量超出已验证范围。');
  const fit=points.map(p=>({x:Math.fround(p.x),y:Math.fround(p.y)}));
  const parameters=fitParameters(fit),knots=parameterKnots(parameters),count=fit.length+2;
  const origin=fit[0],local=fit.map(p=>({x:p.x-origin.x,y:p.y-origin.y}));
  const controls=Array.from({length:count},()=>({x:0,y:0}));
  controls[0]={...local[0]};controls[1]={...local[0]};controls[count-2]={...local.at(-1)};controls[count-1]={...local.at(-1)};
  const unknown=fit.length-2;
  if(unknown){
    const a=[];
    for(let row=0;row<unknown;row++){
      const t=parameters[row+1],fixed=evaluateBSpline(controls,knots,t,3),coeff=[];
      for(let column=0;column<unknown;column++){
        const basis=Array.from({length:count},(_,i)=>({x:i===column+2?1:0,y:0}));
        coeff.push(evaluateBSpline(basis,knots,t,3).x);
      }
      a.push([...coeff,local[row+1].x-fixed.x,local[row+1].y-fixed.y]);
    }
    for(let col=0;col<unknown;col++){
      let pivot=col;for(let row=col+1;row<unknown;row++)if(Math.abs(a[row][col])>Math.abs(a[pivot][col]))pivot=row;
      if(Math.abs(a[pivot][col])<1e-12)throw Error('样条求解不稳定。');
      [a[col],a[pivot]]=[a[pivot],a[col]];const d=a[col][col];for(let k=col;k<unknown+2;k++)a[col][k]/=d;
      for(let row=0;row<unknown;row++)if(row!==col){const f=a[row][col];for(let k=col;k<unknown+2;k++)a[row][k]-=f*a[col][k];}
    }
    for(let i=0;i<unknown;i++)controls[i+2]={x:a[i][unknown],y:a[i][unknown+1]};
  }
  const storedControls=controls.map(p=>({x:Math.fround(p.x+origin.x),y:Math.fround(p.y+origin.y)}));
  const rebuilt=reconstructSpline(fit,storedControls);
  return {fit,controls:storedControls,parameters,curve:{kind:'bspline',degree:3,controlPoints:rebuilt.controlPoints,knots:rebuilt.knots,samplingTolerance:.002}};
}
export function changedSpline(entity,geometry){
  const next=JSON.parse(JSON.stringify(entity));next.curve=geometry.curve;next.source.modified=true;refreshCurve(next);return next;
}
