import { gradeSource, gradePoints, gradePointKey, normalizeGradingPlan, resolveGradeSources } from './grading-schema.mjs';
import { validateProject, bounds } from './geometry.mjs';
import { refreshCurve } from './curves.mjs';
import { contoursForGroup, inspectProject } from './topology.mjs';
import { syncAllowances } from './seams.mjs';
import { syncNotches } from './notches.mjs';
import { syncSeamChecks } from './seam-checks.mjs';
export { gradePoints, gradePointKey, normalizeGradingPlan } from './grading-schema.mjs';
const clone=value=>JSON.parse(JSON.stringify(value)),cache=new WeakMap();
export function createGradingPlan(project,ids,makeId){
  if(project.units!=='mm')throw new Error('请先校准毫米单位，再设置放码');
  const originals=project.entities.filter(e=>ids.has(e.id)&&!e.derivedFrom&&!e.notchFrom);
  if(!originals.length)throw new Error('请选择基码的原始裁片或图元');
  const group=(project.groups||[]).find(group=>originals.every(entity=>group.entityIds.includes(entity.id)));
  const baseSize=String(group?.source?.size||project.metadata?.baseSize||'M').trim().slice(0,50)||'M';
  const plan=normalizeGradingPlan({name:(group?.name||'纸样')+'放码',baseSize,sources:originals.map(gradeSource),sizes:[{id:makeId(),label:baseSize==='M'?'S':'小一码',step:-1},{id:makeId(),label:baseSize==='M'?'L':'大一码',step:1}],rules:[],interpolation:'interpolate'});
  scopedProject(project,plan);return plan;
}
function scopedProject(project,plan){
  resolveGradeSources(project,plan);
  const ids=new Set(plan.sources.map(source=>source.entityId));
  const seamAllowances=(project.seamAllowances||[]).filter(recipe=>recipe.baseEntityIds.some(id=>ids.has(id)));
  if(seamAllowances.some(recipe=>recipe.baseEntityIds.some(id=>!ids.has(id))))throw new Error('所选基准只覆盖部分关联缝份，请选择完整裁片');
  const seams=new Set(seamAllowances.map(recipe=>recipe.id)),notches=(project.notches||[]).filter(recipe=>ids.has(recipe.baseEntityId));
  if(notches.some(recipe=>recipe.targetSeamId&&!seams.has(recipe.targetSeamId)))throw new Error('刀口的目标缝份未包含在方案中，请修复关联或选择完整裁片');
  for(const recipe of [...seamAllowances,...notches])for(const id of recipe.outputIds)ids.add(id);
  const notchIds=new Set(notches.map(recipe=>recipe.id));
  const checks=(project.seamChecks||[]).filter(check=>[...check.a.edges,...check.b.edges].every(ref=>ids.has(ref.entityId))&&(check.landmarks||[]).every(mark=>[mark.a,mark.b].every(locator=>locator.kind!=='notch'||notchIds.has(locator.notchId))));
  const touched=(project.seamChecks||[]).filter(check=>[...check.a.edges,...check.b.edges].some(ref=>ids.has(ref.entityId)));
  const warnings=[];if(touched.length>checks.length)warnings.push((touched.length-checks.length)+' 组对缝关系跨出所选范围，未包含在此尺码中。');
  let partialContours=0;
  const groups=(project.groups||[]).map(group=>{
    const entityIds=group.entityIds.filter(id=>ids.has(id)),contours=contoursForGroup(group);
    partialContours+=contours.filter(contour=>contour.entityIds.some(id=>ids.has(id))&&!contour.entityIds.every(id=>ids.has(id))).length;
    return {...clone(group),entityIds,contours:clone(contours.filter(contour=>contour.entityIds.every(id=>ids.has(id)))),source:{...clone(group.source||{}),gradingScope:true}};
  }).filter(group=>group.entityIds.length>=2);
  if(partialContours)warnings.push(partialContours+' 条原轮廓未完整选入，不能核验其闭合性。');
  return {format:'zhiyi-cad',version:8,name:project.name,units:'mm',entities:clone(project.entities.filter(e=>ids.has(e.id))),groups,seamAllowances:clone(seamAllowances),notches:clone(notches),seamChecks:clone(checks),gradingPlans:[],warnings};
}
export function gradedDisplacements(entity,plan,sizeId){
  const points=gradePoints(entity),rules=plan.rules.filter(rule=>rule.entityId===entity.id).sort((a,b)=>a.index-b.index);
  const anchors=new Map(rules.map(rule=>[rule.index,rule.deltas.find(delta=>delta.sizeId===sizeId)]));
  if([...anchors.values()].some(value=>!value))throw new Error('目标尺码的放码规则缺失');
  const zero=()=>({dx:0,dy:0}),cumulative=[0];
  for(let i=1;i<points.length;i++)cumulative.push(cumulative.at(-1)+Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y));
  const perimeter=cumulative.at(-1)+(entity.closed?Math.hypot(points.at(-1).x-points[0].x,points.at(-1).y-points[0].y):0);
  return points.map((p,index)=>{
    if(anchors.has(index)){const {dx,dy}=anchors.get(index);return {dx,dy};}
    if(!rules.length||plan.interpolation==='fixed')return zero();
    if(rules.length===1){const {dx,dy}=anchors.values().next().value;return {dx,dy};}
    let previous=rules.filter(rule=>rule.index<index).at(-1),next=rules.find(rule=>rule.index>index),from,to,at=cumulative[index];
    if(entity.closed){
      previous??=rules.at(-1);next??=rules[0];from=cumulative[previous.index];to=cumulative[next.index];
      if(previous.index>index)at+=perimeter;
      if(next.index<previous.index)to+=perimeter;
    }else{
      previous??=rules[0];next??=rules.at(-1);from=cumulative[previous.index];to=cumulative[next.index];
    }
    const a=anchors.get(previous.index),b=anchors.get(next.index);
    const t=to>from?Math.max(0,Math.min(1,(at-from)/(to-from))):0;
    return {dx:a.dx+(b.dx-a.dx)*t,dy:a.dy+(b.dy-a.dy)*t};
  });
}
export function generateGradedSize(project,value,sizeId){
  const plan=normalizeGradingPlan(value),size=plan.sizes.find(size=>size.id===sizeId);if(!size)throw new Error('目标尺码已缺失');
  const result=scopedProject(project,plan),sourceIds=new Set(plan.sources.map(source=>source.entityId));
  result.name=project.name+' · '+size.label;
  for(const entity of result.entities)if(sourceIds.has(entity.id)){
    const displacements=gradedDisplacements(entity,plan,sizeId),points=gradePoints(entity).map((p,i)=>({x:p.x+displacements[i].dx,y:p.y+displacements[i].dy}));
    if(entity.curve){entity.curve.controlPoints=points;refreshCurve(entity);}else entity.points=points;
    if(entity.source)entity.source.modified=true;
    entity.gradingSource={baseEntityId:entity.id,baseSize:plan.baseSize,size:size.label};
  }
  validateProject(result);
  let serial=0;const used=new Set([...result.entities,...result.groups,...result.seamAllowances,...result.notches,...result.seamChecks].map(item=>item.id));
  const makeId=()=>{let id;do{id='grade-generated-'+(++serial);}while(used.has(id));used.add(id);return id;};
  syncAllowances(result,makeId);syncNotches(result,makeId);syncSeamChecks(result);
  const invalid=[...result.seamAllowances,...result.notches].filter(recipe=>recipe.status!=='current');
  if(invalid.length)throw new Error('尺码 '+size.label+' 的关联输出无法生成：'+invalid[0].error);
  if(result.entities.length>30000||result.entities.reduce((n,e)=>n+e.points.length,0)>1000000||result.entities.some(e=>e.points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1e8||Math.abs(p.y)>1e8)))throw new Error('放码结果坐标或节点数量超出工程范围');
  result.metadata={format:'制衣 CAD 放码输出',baseSize:plan.baseSize,gradedSize:size.label,planName:plan.name};
  const inspection=inspectProject(result,.1),issues=inspection.results.filter(item=>item.status!=='within-tolerance');
  const checkIssues=result.seamChecks.filter(check=>check.status!=='current'||check.result?.status!=='match');
  if(issues.length)result.warnings.push(issues.length+' 项轮廓检查需核对（0.1 mm 容差）；不自动修补。');
  if(checkIssues.length)result.warnings.push(checkIssues.length+' 组对缝关系需核对。');
  const box=bounds(result.entities),baseBox=bounds(result.entities.filter(entity=>sourceIds.has(entity.id)));
  return {size,project:result,inspection,summary:{sizeId:size.id,label:size.label,status:result.warnings.length?'review':'ready',entityCount:result.entities.length,contoursChecked:inspection.results.length,seamChecksCount:result.seamChecks.length,contourIssues:issues.length,seamCheckIssues:checkIssues.length,width:box?.width||0,height:box?.height||0,baseWidth:baseBox?.width||0,baseHeight:baseBox?.height||0,warnings:[...result.warnings]}};
}
export function evaluateGradingPlan(project,value){
  const plan=normalizeGradingPlan(value);resolveGradeSources(project,plan);
  return plan.sizes.map(size=>{try{return generateGradedSize(project,plan,size.id);}catch(error){return {size,error:error.message,summary:{sizeId:size.id,label:size.label,status:'error',error:error.message}};}});
}
function signature(project,plan){return JSON.stringify([normalizeGradingPlan(plan),project.units,project.entities,project.groups,project.seamAllowances,project.notches,project.seamChecks]);}
export function syncGradingPlans(project){
  for(const plan of project.gradingPlans||[]){
    let key;try{
      key=signature(project,plan);if(cache.get(plan)?.key===key)continue;
      const results=evaluateGradingPlan(project,plan);cache.set(plan,{key,results});plan.report=results.map(result=>clone(result.summary));plan.status=results.some(result=>result.error)?'error':results.some(result=>result.summary.status==='review')?'review':'current';delete plan.error;
    }catch(error){cache.set(plan,{key,results:[]});plan.status='error';plan.error=error.message;delete plan.report;}
  }
}
export function gradingResults(project,plan){syncGradingPlans(project);return clone(cache.get(plan)?.results||[]);}
export function applyGradingPlan(project,value,makeId,planId=null){
  const config=normalizeGradingPlan(value);resolveGradeSources(project,config);scopedProject(project,config);
  const plans=project.gradingPlans||[],existing=plans.find(plan=>plan.id===planId);
  if(planId&&!existing)throw new Error('待更新的放码方案已缺失');if(!existing&&plans.length>=30)throw new Error('最多支持 30 个放码方案');
  const plan=existing||{id:makeId()};Object.assign(plan,config);if(!existing)plans.push(plan);project.gradingPlans=plans;project.version=Math.max(project.version,8);syncGradingPlans(project);return plan;
}
export function coincidentGradePoints(project,value,entityId,index,tolerance=.01){
  const plan=normalizeGradingPlan(value),entities=resolveGradeSources(project,plan),entity=entities.find(e=>e.id===entityId),point=entity&&gradePoints(entity)[index];
  if(!point||!Number.isFinite(tolerance)||tolerance<0||tolerance>1)throw new Error('放码点或同位点容差无效');
  const refs=[{entityId,index}];
  for(const other of entities){if(other.type==='text')continue;const points=gradePoints(other);
    for(let i=0;i<points.length;i++)if(!(other.id===entityId&&i===index)&&(!other.curve||i===0||i===points.length-1)&&Math.hypot(points[i].x-point.x,points[i].y-point.y)<=tolerance)refs.push({entityId:other.id,index:i});
  }
  return refs;
}
