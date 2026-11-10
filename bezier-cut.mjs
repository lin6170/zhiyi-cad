// Polynomial calculations use local coordinates and exact filtered signs.
import { polynomialRoots,bezierDistanceRoots } from './polynomial-roots.mjs';
export { polynomialRoots } from './polynomial-roots.mjs';
export const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
export function evaluateBezier(points,t){let row=points;while(row.length>1)row=row.slice(0,-1).map((p,i)=>mix(p,row[i+1],t));return {...row[0]};}
export function splitBezier(points,t){let row=points;const a=[row[0]],b=[row.at(-1)];while(row.length>1){row=row.slice(0,-1).map((p,i)=>mix(p,row[i+1],t));a.push(row[0]);b.unshift(row.at(-1));}return [a,b];}
export function sliceBezier(points,a,b){let result=points;if(b<1)result=splitBezier(result,b)[0];if(a>0)result=splitBezier(result,a/b)[1];return result.map(p=>({...p}));}
export function power(values){
  if(values.length===2)return [values[0],values[1]-values[0]];
  if(values.length===3)return [values[0],2*(values[1]-values[0]),values[2]-2*values[1]+values[0]];
  if(values.length===4)return [values[0],3*(values[1]-values[0]),3*(values[2]-2*values[1]+values[0]),values[3]-3*values[2]+3*values[1]-values[0]];
  throw new Error('仅支持直线、二次与三次曲线');
}
export const derivative=a=>a.slice(1).map((v,i)=>v*(i+1));
export function bezierLineHits(points,a,b){
  const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);if(length<1e-7)throw new Error('切线两端过近');
  const signed=points.map(p=>((p.x-a.x)*dy-(p.y-a.y)*dx)/length),scale=Math.max(1,...points.flatMap(p=>[Math.abs(p.x-a.x),Math.abs(p.y-a.y)]));
  if(signed.every(v=>Math.abs(v)<=scale*Number.EPSILON*64))return {collinear:true,hits:[]};
  const roots=polynomialRoots(power(signed)),hits=[];
  for(const t of roots){const p=evaluateBezier(points,t),u=((p.x-a.x)*dx+(p.y-a.y)*dy)/(length*length);if(u>=-1e-10&&u<=1+1e-10)hits.push({t,u,point:p});}
  return {collinear:false,hits};
}
export function nearestBezier(points,query){
  let best=null;for(const t of [0,1,...bezierDistanceRoots(points,query)]){const point=evaluateBezier(points,t),distance=Math.hypot(point.x-query.x,point.y-query.y);if(!best||distance<best.distance)best={t,point,distance};}return best;
}
export function bezierArea(points){
  const x=power(points.map(p=>p.x)),y=power(points.map(p=>p.y));let value=0;
  for(let i=0;i<x.length;i++)for(let j=1;j<y.length;j++)value+=(x[i]*y[j]-y[i]*x[j])*j/(i+j);
  return value/2;
}
