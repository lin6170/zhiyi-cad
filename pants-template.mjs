import {planPantsGeometry} from './pants-command.mjs';
import {reconstructSpline} from './spline.mjs';
import {refreshCurve} from './curves.mjs';
import {changedSpline,fitParameters} from './fit-spline.mjs';
import {pathMetrics} from './path-metrics.mjs';
const copy=x=>JSON.parse(JSON.stringify(x));
function near(a,b,tolerance=.00001){
  return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((p,i)=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.hypot(p.x-b[i].x,p.y-b[i].y)<=tolerance);
}
/** Identify the private template by stable IDs, ownership and unchanged anchors.
 * Unrelated entities and annotations may have been edited in ET and are retained. */
export function verifyPantsContinuation(project,profile){
  if(profile.schema!=='zhiyi-web-pants-profile/v2')throw Error('ET 回存文件请使用新版母版规则。');
  const curves=project.entities.filter(e=>e.source?.recordKind),map=new Map(curves.map(e=>[e.source.sourceId,e]));
  if(map.size!==curves.length)throw Error('曲线身份重复，不能确认母版。');
  const baseline=copy(project),baseMap=new Map(baseline.entities.filter(e=>e.source?.recordKind).map(e=>[e.source.sourceId,e]));
  let total=null;
  for(const rule of profile.pieces){
    const group=project.groups.find(g=>g.source?.sourceId===rule.pieceId);
    if(!group)throw Error('未找到此规则对应的前后裤片。');
    for(const ref of [...rule.baseline,...rule.anchors]){
      const e=map.get(ref.id);
      if(!e||!group.entityIds.includes(e.id)||e.source.recordKind!==ref.kind)throw Error('母版曲线身份或归属改变，请重新建立改版规则。');
    }
    for(const ref of rule.anchors){
      const e=map.get(ref.id);
      if(ref.fit&&!near(e.source.fitPoints,ref.fit)||ref.controls&&!near(e.source.controlPoints,ref.controls)||ref.points&&!near(e.points,ref.points))throw Error('裤片上段或定位线已改变，请先重新核对母版规则。');
    }
    const hem=map.get(rule.hemId),ref=rule.baseline.find(e=>e.id===rule.hemId);
    const displacement=(ref.fit[0].y-hem.source.fitPoints[0].y)*10;
    if(total!==null&&Math.abs(displacement-total)>.002)throw Error('前后裤长增量不一致，请分别核对。');
    total=displacement;
    for(const ref of rule.baseline){
      const e=baseMap.get(ref.id),spline=reconstructSpline(ref.fit,ref.controls);
      e.source.fitPoints=copy(ref.fit);e.source.controlPoints=copy(ref.controls);delete e.source.modified;
      e.curve={...e.curve,controlPoints:spline.controlPoints,knots:spline.knots};refreshCurve(e);
    }
  }
  // Recover the user-entered tenth of a millimetre after float32 serialization.
  const rounded=Math.round(total*10)/10;
  if(Math.abs(rounded-total)>.002||Math.abs(rounded)>100)throw Error('当前累计裤长变化超出已验证范围（原母版 ±100 mm）。');
  const expected=Math.abs(rounded)<.00001?null:planPantsGeometry(baseline,profile,{deltaMm:rounded});
  const changes=new Map(expected?.changes.map(c=>[c.before.source.sourceId,c])||[]);
  for(const rule of profile.pieces)for(const ref of rule.baseline){
    const actual=map.get(ref.id),expect=changes.get(ref.id)?.geometry||ref;
    if(!near(actual.source.fitPoints,expect.fit,.002)||!near(actual.source.controlPoints,expect.controls,.002))throw Error('裤脚几何不符合已验证改版规则，请重新核对母版。');
  }
  return {totalDeltaMm:rounded,baseline};
}

// Recompute from the original template at the requested cumulative length.
// This prevents sequential seam approximations from accumulating drift.
export function planPantsContinuation(current,profile,verified,deltaMm){
  const total= Math.round((verified.totalDeltaMm+deltaMm)*10)/10;
  const calculated=total===0?null:planPantsGeometry(verified.baseline,profile,{deltaMm:total});
  const currentMap=new Map(current.entities.filter(e=>e.source?.recordKind).map(e=>[e.source.sourceId,e]));
  const originalMap=new Map(verified.baseline.entities.filter(e=>e.source?.recordKind).map(e=>[e.source.sourceId,e]));
  const refs=profile.pieces.flatMap(r=>r.baseline),changes=refs.map(ref=>{
    const before=currentMap.get(ref.id),c=calculated?.changes.find(c=>c.before.source.sourceId===ref.id),e=originalMap.get(ref.id);
    const geometry=c?.geometry||{fit:copy(ref.fit),controls:copy(ref.controls),parameters:fitParameters(ref.fit),curve:copy(e.curve)};
    const translated=profile.pieces.some(r=>r.translate.includes(ref.id));
    return {before,after:changedSpline(before,geometry),geometry,mode:translated?'translate':'refit'};
  });
  const result=copy(current),changed=new Map(changes.map(c=>[c.before.id,c.after]));result.entities=result.entities.map(e=>changed.get(e.id)||e);
  const measurements=profile.pieces.map(rule=>{
    const before=currentMap.get(rule.hemId),after=changed.get(before.id);
    return {piece:current.groups.find(g=>g.source.sourceId===rule.pieceId).name,verticalDeltaMm:deltaMm,hemWidthBeforeMm:pathMetrics(before).total*10,hemWidthAfterMm:pathMetrics(after).total*10,kneePreserved:true};
  });
  return {project:result,changes,measurements,summary:{operation:'pattern.extendPantsHem',deltaMm,totalDeltaMm:total,changedEntities:22,pieces:measurements.map(m=>m.piece),unchanged:'膝线及以上、脚口宽、原文字和其他裁片'}};
}
