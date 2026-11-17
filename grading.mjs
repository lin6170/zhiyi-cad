import { gradeSource, gradePoints, gradePointKey, normalizeGradingPlan, resolveGradeSources } from './grading-schema.mjs';
import { validateProject, bounds } from './geometry.mjs';
import { refreshCurve } from './curves.mjs';
import { contoursForGroup, inspectProject } from './topology.mjs';
import { syncAllowances } from './seams.mjs';
import { syncNotches } from './notches.mjs';
import { syncSeamChecks } from './seam-checks.mjs';
import { applyTableGrading, ruleDisplacement, stationsOf, placeOnLine, FOLLOW_TOLERANCE_MM } from './grading-table.mjs';
import { generateNotches } from './notches.mjs';
import { closeContourGaps } from './contour-heal.mjs';
const GRADED_JOINT_LIMIT=3;   // mm: how far apart two neighbouring contour ends may be in a graded size and still be brought together
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
/** A new plan that grades by a size table, the way ET does: one for the whole drawing, with the base size and one size either side. */
export function createTablePlan(project,makeId){
  if(project.units!=='mm')throw new Error('请先校准毫米单位，再设置放码');
  const other=(project.gradingPlans||[]).find(plan=>plan.method==='table');if(other)throw new Error('这张图已经有按尺寸表放码的方案“'+other.name+'”；一张图只有一套号型和尺寸表，请直接修改它');
  const originals=project.entities.filter(entity=>!entity.derivedFrom&&!entity.notchFrom);if(!originals.some(entity=>entity.type!=='text'))throw new Error('图里还没有线，先画好基码纸样');
  const base=String(project.metadata?.baseSize||'M').trim().slice(0,50)||'M',names=base==='M'?['S','L']:['小一码','大一码'];
  return normalizeGradingPlan({name:'尺寸表放码',baseSize:base,interpolation:'fixed',method:'table',rules:[],sources:originals.map(gradeSource),
    sizes:[{id:makeId(),label:names[0],step:-1,slot:8},{id:makeId(),label:names[1],step:1,slot:10}],
    sizeTable:{unit:'cm',activeSeries:0,baseSlot:9,series:[[],[],[],[],[]],rows:[]},anchors:[],notchRules:[]});
}
/**
 * Brings a plan that grades by a size table up to date with the drawing. As in ET, where rules sit on points, such a plan covers
 * every original line of the drawing: lines drawn later join it (their ends follow the grading points they lie on). A rule stays
 * with its point while its line keeps its number of points. When the line was deleted, cut, joined or redrawn, the rule is handed
 * to a point of a line on the same place; when no point is left there it is dropped and counted in `lostRules`.
 * Returns the plan (a new object) and what was done.
 */
export function reconcileTablePlan(project,plan){
  const originals=project.entities.filter(entity=>!entity.derivedFrom&&!entity.notchFrom),byId=new Map(originals.map(entity=>[entity.id,entity]));
  const stations=new Map(),stationsFor=id=>{if(!stations.has(id))stations.set(id,byId.has(id)?stationsOf(byId.get(id)):null);return stations.get(id);};
  const anchors=[],orphans=[],taken=new Set(),near=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y)<=FOLLOW_TOLERANCE_MM;
  const keep=(anchor,entityId,index,line)=>{const p=line.points[index],{between,...rest}=anchor;anchors.push({...rest,entityId,index,at:{x:p.x,y:p.y},stations:line.points.length});taken.add(entityId+'#'+index);};
  const keepOn=(anchor,entityId,between,line)=>{const {index,...rest}=anchor;anchors.push({...rest,entityId,between,stations:line.points.length});};
  for(const anchor of plan.anchors){
    const line=stationsFor(anchor.entityId);if(!line){orphans.push(anchor);continue;}
    const count=line.points.length,same=anchor.stations===undefined||anchor.stations===count;
    if(anchor.index!==undefined){
      if(same&&anchor.index<count){keep(anchor,anchor.entityId,anchor.index,line);continue;}
      // the line has another number of points now: the point on the same place, else the same end of the line
      let index=anchor.at?line.points.findIndex((p,i)=>!taken.has(anchor.entityId+'#'+i)&&near(p,anchor.at)):-1;
      if(index<0&&anchor.index===0)index=0;else if(index<0&&anchor.stations!==undefined&&anchor.index===anchor.stations-1)index=count-1;
      if(index>=0&&!taken.has(anchor.entityId+'#'+index))keep(anchor,anchor.entityId,index,line);else orphans.push(anchor);
    }else{
      if(same&&anchor.between<count-1){keepOn(anchor,anchor.entityId,anchor.between,line);continue;}
      const place=placeOnLine(byId.get(anchor.entityId),anchor.at);
      if(place&&place.index!==undefined&&!anchor.plain&&!taken.has(anchor.entityId+'#'+place.index))keep(anchor,anchor.entityId,place.index,line);
      else if(place&&place.between!==undefined)keepOn(anchor,anchor.entityId,place.between,line);else orphans.push(anchor);
    }
  }
  let reattached=0,lost=0;
  if(orphans.length){
    const lines=originals.filter(entity=>entity.type!=='text').map(entity=>{let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const p of entity.points){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}return {entity,minX,minY,maxX,maxY};});
    for(const anchor of orphans){
      if(anchor.plain)continue;if(!anchor.at){lost++;continue;}
      let done=false;const q=anchor.at,t=FOLLOW_TOLERANCE_MM;
      for(const {entity,minX,minY,maxX,maxY} of lines){
        if(q.x<minX-t||q.x>maxX+t||q.y<minY-t||q.y>maxY+t)continue;
        const place=placeOnLine(entity,q);if(!place)continue;const line=stationsFor(entity.id);
        if(place.index!==undefined){if(taken.has(entity.id+'#'+place.index))continue;keep(anchor,entity.id,place.index,line);done=true;break;}
        if(anchor.index===undefined){keepOn(anchor,entity.id,place.between,line);done=true;break;}
      }
      if(done)reattached++;
      // another grading point stands on the place: the lines there follow it, nothing is lost
      else if(anchor.index===undefined||!anchors.some(other=>!other.plain&&other.index!==undefined&&near(other.at,q)))lost++;
    }
  }
  const notchIds=new Set((project.notches||[]).map(notch=>notch.id)),notchRules=(plan.notchRules||[]).filter(rule=>notchIds.has(rule.notchId));lost+=(plan.notchRules||[]).length-notchRules.length;
  const {alignment,locks:oldLocks,lockedSizes:oldSizes,...rest}=plan,kept=alignment&&byId.has(alignment.entityId)&&byId.get(alignment.entityId).type!=='text'?{alignment}:{};   // the view's alignment goes when its line goes (v68)
  // v69: a lock stays on its station: the same number when the line keeps its number of points, else the point on the same place
  const locks=[];let lostLocks=0;
  for(const lock of oldLocks||[]){
    const line=stationsFor(lock.entityId),entity=byId.get(lock.entityId);if(!line||!entity||entity.type==='text'){lostLocks++;continue;}
    const count=line.points.length;let index=(lock.stations===undefined||lock.stations===count)&&lock.index<count?lock.index:-1;
    if(index<0&&lock.at)index=line.points.findIndex(p=>near(p,lock.at));
    if(index<0){lostLocks++;continue;}
    locks.push({...lock,index,at:{x:line.points[index].x,y:line.points[index].y},stations:count});
  }
  const sizeIds=new Set(plan.sizes.map(size=>size.id)),lockedSizes=(oldSizes||[]).filter(id=>sizeIds.has(id));
  return {plan:{...rest,...kept,sources:originals.map(gradeSource),anchors,notchRules,lostRules:(plan.lostRules||0)+lost,...(locks.length?{locks}:{}),...(lockedSizes.length?{lockedSizes}:{}),...(lostLocks||plan.lostLocks?{lostLocks:(plan.lostLocks||0)+lostLocks}:{})},reattached,lost};
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
  let plan=normalizeGradingPlan(value);if(plan.method==='table')plan=reconcileTablePlan(project,plan).plan;
  const size=plan.sizes.find(size=>size.id===sizeId);if(!size)throw new Error('目标尺码已缺失');
  const result=scopedProject(project,plan),sourceIds=new Set(plan.sources.map(source=>source.entityId));
  result.name=project.name+' · '+size.label;
  // a plan that grades by a size table moves whole lines and curves at once (grading-table.mjs)
  if(plan.method==='table'){
    applyTableGrading(result.entities,plan,size);
    if(plan.lostRules)result.warnings.push('有 '+plan.lostRules+' 个放码点原来所在的线被删除或改动以后，原来的位置上找不到点了，它们的规则已经去掉。核对后“更新放码方案”，这条提示就消掉。');
    if(plan.lostLocks)result.warnings.push('有 '+plan.lostLocks+' 个锁定的点原来所在的线被删除或改动以后找不到了，这些锁定已经去掉。');
    // The rules of two points on the same place can differ a little (other axes, another divisor), and then two neighbouring
    // contour edges come apart by a fraction of a millimetre in a size. They are brought together as when an ET file is opened.
    const byId=new Map(result.entities.map(entity=>[entity.id,entity]));
    for(const group of result.groups)for(const contour of contoursForGroup(group)){
      const edges=contour.entityIds.map(id=>byId.get(id));if(edges.length<2||edges.some(edge=>!edge))continue;
      try{const healed=closeContourGaps(edges,GRADED_JOINT_LIMIT);if(healed.count&&healed.largest>.05)result.warnings.push('裁片“'+group.name+'”有 '+healed.count+' 处相邻的线端在这个码里对不上（最大 '+healed.largest.toFixed(2)+' mm），已合拢；请核对这几个点的放码规则。');}
      catch(error){result.warnings.push('裁片“'+group.name+'”：'+error.message);}
    }
    // A notch with a rule of its own moves by its formulas and is put back on its edge, as ET does: its place along the edge
    // in this size is where the moved point lies nearest to the graded edge.
    for(const rule of plan.notchRules||[]){
      const recipe=result.notches.find(notch=>notch.id===rule.notchId),original=(project.notches||[]).find(notch=>notch.id===rule.notchId),edge=recipe&&byId.get(recipe.baseEntityId);if(!recipe||!original||!edge)continue;
      try{
        const from=generateNotches(project,original.baseEntityId,{...original,targetSeamId:null}).stations,centre=from[Math.floor(from.length/2)].point,d=ruleDisplacement(plan,size,rule),to={x:centre.x+d.dx,y:centre.y+d.dy};
        let best=null,walked=0;const points=edge.points;
        for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],ux=b.x-a.x,uy=b.y-a.y,q=ux*ux+uy*uy,t=q?Math.max(0,Math.min(1,((to.x-a.x)*ux+(to.y-a.y)*uy)/q)):0,distance=Math.hypot(to.x-a.x-t*ux,to.y-a.y-t*uy),piece=Math.sqrt(q);if(!best||distance<best.distance)best={distance,along:walked+t*piece};walked+=piece;}
        recipe.mode='start';recipe.position=Math.round(best.along*1e4)/1e4;
      }catch(error){result.warnings.push('刀口“'+(recipe.name||'')+'”的放码规则没有用上：'+error.message);}
    }
  }
  for(const entity of result.entities)if(sourceIds.has(entity.id)){
    if(plan.method!=='table'){
    const displacements=gradedDisplacements(entity,plan,sizeId),points=gradePoints(entity).map((p,i)=>({x:p.x+displacements[i].dx,y:p.y+displacements[i].dy}));
    if(entity.curve){entity.curve.controlPoints=points;refreshCurve(entity);}else entity.points=points;
    }
    if(entity.source)entity.source.modified=true;
    entity.gradingSource={baseEntityId:entity.id,baseSize:plan.baseSize,size:size.label};
  }
  validateProject(result);
  let serial=0;const used=new Set([...result.entities,...result.groups,...result.seamAllowances,...result.notches,...result.seamChecks].map(item=>item.id));
  const makeId=()=>{let id;do{id='grade-generated-'+(++serial);}while(used.has(id));used.add(id);return id;};
  syncAllowances(result,makeId);syncNotches(result,makeId);syncSeamChecks(result);
  const invalid=[...result.seamAllowances,...result.notches].filter(recipe=>recipe.status!=='current');
  // A size made from the rules of an ET file is kept even when a seam allowance or a notch cannot be made in it (ET itself
  // warns about such sizes when it saves them): what is missing is named, and the size is marked for checking.
  if(invalid.length&&plan.method==='table'){
    const owner=recipe=>{const base=recipe.baseEntityIds?recipe.baseEntityIds[0]:recipe.baseEntityId,group=result.groups.find(group=>group.entityIds.includes(base));return group?'裁片“'+group.name+'”的':'';};
    for(const recipe of invalid)result.warnings.push(owner(recipe)+(result.seamAllowances.includes(recipe)?'缝份':'刀口')+'在这个码里没有生成：'+recipe.error);
  }else if(invalid.length)throw new Error('尺码 '+size.label+' 的关联输出无法生成：'+invalid[0].error);
  if(result.entities.length>30000||result.entities.reduce((n,e)=>n+e.points.length,0)>1000000||result.entities.some(e=>e.points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1e8||Math.abs(p.y)>1e8)))throw new Error('放码结果坐标或节点数量超出工程范围');
  result.metadata={format:'制衣 CAD 放码输出',baseSize:plan.baseSize,gradedSize:size.label,planName:plan.name};
  const inspection=inspectProject(result,.1),issues=inspection.results.filter(item=>item.status!=='within-tolerance');
  const checkIssues=result.seamChecks.filter(check=>check.status!=='current'||check.result?.status!=='match');
  if(issues.length)result.warnings.push(issues.length+' 项轮廓检查需核对（0.1 mm 容差）；不自动修补。');
  if(checkIssues.length)result.warnings.push(checkIssues.length+' 组对缝关系需核对。');
  const box=bounds(result.entities),baseBox=bounds(result.entities.filter(entity=>sourceIds.has(entity.id)));
  return {size,project:result,inspection,summary:{sizeId:size.id,label:size.label,status:result.warnings.length?'review':'ready',entityCount:result.entities.length,contoursChecked:inspection.results.length,seamChecksCount:result.seamChecks.length,contourIssues:issues.length,seamCheckIssues:checkIssues.length,width:box?.width||0,height:box?.height||0,baseWidth:baseBox?.width||0,baseHeight:baseBox?.height||0,warnings:[...result.warnings]}};
}
// The sizes of plans that grade by a size table are made when they are asked for, not after every command: such a plan covers
// the whole drawing, and making every size of a real pattern takes about a second. The last few results are kept.
const tableCache=new Map();
function tableSizes(project,plan){
  const key=signature(project,plan);let found=tableCache.get(key);
  if(!found){
    found=plan.sizes.map(size=>{try{return generateGradedSize(project,plan,size.id);}catch(error){return {size,error:error.message,summary:{sizeId:size.id,label:size.label,status:'error',error:error.message}};}});
    tableCache.set(key,found);while(tableCache.size>3)tableCache.delete(tableCache.keys().next().value);
  }
  return clone(found);
}
export function evaluateGradingPlan(project,value){
  const plan=normalizeGradingPlan(value);if(plan.method==='table')return tableSizes(project,reconcileTablePlan(project,plan).plan);
  resolveGradeSources(project,plan);
  return plan.sizes.map(size=>{try{return generateGradedSize(project,plan,size.id);}catch(error){return {size,error:error.message,summary:{sizeId:size.id,label:size.label,status:'error',error:error.message}};}});
}
function signature(project,plan){return JSON.stringify([normalizeGradingPlan(plan),project.units,project.entities,project.groups,project.seamAllowances,project.notches,project.seamChecks]);}
export function syncGradingPlans(project){
  for(const plan of project.gradingPlans||[]){
    if(plan.method==='table'){   // brought up to date with the drawing here; its sizes are made on demand (gradingResults)
      try{Object.assign(plan,reconcileTablePlan(project,normalizeGradingPlan(plan)).plan);plan.status='current';delete plan.error;}catch(error){plan.status='error';plan.error=error.message;}
      delete plan.report;continue;
    }
    let key;try{
      key=signature(project,plan);if(cache.get(plan)?.key===key)continue;
      const results=evaluateGradingPlan(project,plan);cache.set(plan,{key,results});plan.report=results.map(result=>clone(result.summary));plan.status=results.some(result=>result.error)?'error':results.some(result=>result.summary.status==='review')?'review':'current';delete plan.error;
    }catch(error){cache.set(plan,{key,results:[]});plan.status='error';plan.error=error.message;delete plan.report;}
  }
}
/** The sizes of a saved plan. For a plan that grades by a size table, `compute: false` gives them only when they are already made (else null). */
export function gradingResults(project,plan,{compute=true}={}){
  if(plan.method==='table'){
    let ready;try{ready=reconcileTablePlan(project,normalizeGradingPlan(plan)).plan;}catch(error){if(!compute)return null;throw error;}
    if(!compute&&!tableCache.has(signature(project,ready)))return null;return tableSizes(project,ready);
  }
  syncGradingPlans(project);return clone(cache.get(plan)?.results||[]);
}
export function applyGradingPlan(project,value,makeId,planId=null){
  let config=normalizeGradingPlan(value);if(config.method==='table')config=reconcileTablePlan(project,config).plan;resolveGradeSources(project,config);scopedProject(project,config);
  const plans=project.gradingPlans||[],existing=plans.find(plan=>plan.id===planId);
  if(planId&&!existing)throw new Error('待更新的放码方案已缺失');if(!existing&&plans.length>=30)throw new Error('最多支持 30 个放码方案');
  const plan=existing||{id:makeId()};Object.assign(plan,config);for(const key of ['alignment','locks','lockedSizes','lostLocks'])if(config[key]===undefined)delete plan[key];   // v68, v69: what the new value leaves out goes
  if(!existing)plans.push(plan);project.gradingPlans=plans;project.version=Math.max(project.version,8);syncGradingPlans(project);return plan;
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
