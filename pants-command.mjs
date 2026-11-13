import {evaluateBSpline,refreshCurve} from './curves.mjs';
import {fitClampedSpline,fitParameters,mapFitParameter,changedSpline} from './fit-spline.mjs';
import {pathMetrics} from './path-metrics.mjs';
import {reconstructSpline} from './spline.mjs';

export const PANTS_COMMAND='pattern.extendPantsHem';
const copy=x=>JSON.parse(JSON.stringify(x));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const pointAt=(curve,t)=>evaluateBSpline(curve.controlPoints,curve.knots,t,curve.degree);
function closestParameter(curve,p){
  const end=curve.knots.at(-1),distance=t=>{const q=pointAt(curve,t);return (q.x-p.x)**2+(q.y-p.y)**2;};
  let best=0,bestD=Infinity;const steps=256;
  for(let i=0;i<=steps;i++){const t=end*i/steps,d=distance(t);if(d<bestD){bestD=d;best=i;}}
  let a=end*Math.max(0,best-1)/steps,b=end*Math.min(steps,best+1)/steps;
  for(let i=0;i<50;i++){const u=a+(b-a)/3,v=b-(b-a)/3;if(distance(u)<distance(v))b=v;else a=u;}
  return (a+b)/2;
}
export function planPantsGeometry(project,profile,{deltaMm=20}={}){
  if(profile?.schema!=='zhiyi-web-pants-profile/v1'||profile.mmPerSourceUnit!==10||profile.validatedDeltaMm!==20||deltaMm!==20||profile.pieces?.length!==2)throw Error('当前只支持已验收母版的裤脚垂直加长 20 mm。');
  if(project.units!=='unknown'&&project.units!==undefined)throw Error('请重新打开原始 PRJ；当前单位或比例已经改变。');
  const next=copy(project),byId=new Map(project.entities.map(e=>[e.source?.sourceId,e])),changed=new Map(),dy=-deltaMm/profile.mmPerSourceUnit;
  const get=id=>{const e=byId.get(id);if(!e?.curve||e.source.recordKind!==4||e.source.modified)throw Error('母版曲线缺失或已经改变，请重新打开原始 PRJ。');return e;};
  function translate(id){
    if(changed.has(id))throw Error('改版对象重复。');const e=get(id),fit=e.source.fitPoints.map(p=>({x:p.x,y:Math.fround(p.y+dy)})),controls=e.source.controlPoints.map(p=>({x:p.x,y:Math.fround(p.y+dy)}));
    const rebuilt=reconstructSpline(fit,controls);
    const geometry={fit,controls,parameters:fitParameters(fit),curve:{...copy(e.curve),controlPoints:rebuilt.controlPoints,knots:rebuilt.knots}};
    changed.set(id,{before:e,after:changedSpline(e,geometry),geometry,mode:'translate'});
  }
  const measurements=[];
  for(const rule of profile.pieces){
    const group=project.groups.find(g=>g.source?.sourceId===rule.pieceId);if(!group)throw Error('裁片归属不匹配。');
    const allowed=[...rule.translate,...rule.sides.flatMap(s=>[s.boundaryId,s.seamId])];
    if(allowed.some(id=>!group.entityIds.includes(get(id).id)))throw Error('改版对象不属于指定裁片。');
    for(const id of rule.translate)translate(id);
    for(const side of rule.sides){
      const e=get(side.boundaryId),fit=copy(e.source.fitPoints);
      if(fit.length!==3||!same(e.source.controlPoints[0],e.source.controlPoints[1])||!same(e.source.controlPoints.at(-1),e.source.controlPoints.at(-2)))throw Error('下段侧缝结构不受支持。');
      fit.at(-1).y=Math.fround(fit.at(-1).y+dy);
      const geometry=fitClampedSpline(fit),after=changedSpline(e,geometry);
      changed.set(side.boundaryId,{before:e,after,geometry,mode:'refit'});
      const seam=get(side.seamId),oldParameters=fitParameters(e.source.fitPoints);
      const seamFit=seam.source.fitPoints.map((p,i)=>{
        if(i===0)return {...p};if(i===seam.source.fitPoints.length-1)return {x:p.x,y:Math.fround(p.y+dy)};
        const t=closestParameter(e.curve,p),old=pointAt(e.curve,t),moved=pointAt(after.curve,mapFitParameter(t,oldParameters,geometry.parameters));
        return {x:Math.fround(p.x+moved.x-old.x),y:Math.fround(p.y+moved.y-old.y)};
      });
      const seamGeometry=fitClampedSpline(seamFit);
      changed.set(side.seamId,{before:seam,after:changedSpline(seam,seamGeometry),geometry:seamGeometry,mode:'refit-seam'});
    }
    const hem=get(rule.hemId),after=changed.get(rule.hemId).after;
    measurements.push({piece:group.name,verticalDeltaMm:deltaMm,hemWidthBeforeMm:pathMetrics(hem).total*10,hemWidthAfterMm:pathMetrics(after).total*10,kneePreserved:true});
  }
  if(changed.size!==22)throw Error('预期 22 条关联线参与改版，实际数量不符。');
  next.entities=next.entities.map(e=>changed.get(e.source?.sourceId)?.after||e);
  for(const m of measurements)if(Math.abs(m.hemWidthAfterMm-m.hemWidthBeforeMm)>.001)throw Error('脚口宽度校验失败。');
  return {project:next,changes:[...changed.values()],measurements,summary:{operation:PANTS_COMMAND,deltaMm,changedEntities:changed.size,pieces:measurements.map(m=>m.piece),unchanged:'膝线及以上、脚口宽、原文字和其他裁片',note:'按垂直方向加长，缝份随相邻侧缝同步；尺寸表不自动改写。'}};
}
