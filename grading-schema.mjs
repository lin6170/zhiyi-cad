export const gradePointKey=(entityId,index)=>JSON.stringify([entityId,index]);
export const gradePoints=entity=>entity.curve?.controlPoints||entity.points;
export function gradeSource(entity){
  if(!entity||entity.derivedFrom||entity.notchFrom)throw new Error('放码须选择原始纸样，关联缝份和刀口由基准重算');
  return {entityId:entity.id,kind:entity.type==='text'?'text':entity.curve?'curve':'polyline',count:gradePoints(entity).length,closed:Boolean(entity.closed),degree:entity.curve?.degree??null,knots:entity.curve?[...entity.curve.knots]:null};
}
export function normalizeGradingPlan(value){
  if(!value||!Array.isArray(value.sources)||!value.sources.length||value.sources.length>2000||!Array.isArray(value.sizes)||!value.sizes.length||value.sizes.length>12||!Array.isArray(value.rules)||value.rules.length>10000)throw new Error('放码方案须含 1–2000 个基准、1–12 个目标尺码，最多 10000 个放码点');
  const name=String(value.name||'放码方案').slice(0,200),baseSize=String(value.baseSize||'').trim().slice(0,50);
  if(!baseSize||!['fixed','interpolate'].includes(value.interpolation))throw new Error('请输入基码名称并选择未设规则点的处理方式');
  const ids=new Set(),labels=new Set([baseSize]),sizes=value.sizes.map(size=>{
    if(!size||typeof size.id!=='string'||!size.id||size.id.length>200||ids.has(size.id)||typeof size.label!=='string'||!size.label.trim()||size.label.trim().length>50||labels.has(size.label.trim())||!Number.isFinite(size.step)||Math.abs(size.step)>100||size.step===0)throw new Error('尺码 ID、名称或档数无效；目标尺码名称须唯一且不同于基码');
    ids.add(size.id);labels.add(size.label.trim());return {id:size.id,label:size.label.trim(),step:size.step};
  });
  const sourceIds=new Set(),sources=value.sources.map(source=>{
    if(!source||typeof source.entityId!=='string'||sourceIds.has(source.entityId)||!['text','curve','polyline'].includes(source.kind)||!Number.isInteger(source.count)||source.count<(source.kind==='text'?1:2)||source.count>100000||typeof source.closed!=='boolean')throw new Error('放码基准结构无效');
    if(source.kind==='text'&&(source.count!==1||source.closed)||source.kind==='curve'&&(!Number.isInteger(source.degree)||source.degree<1||source.degree>3||!Array.isArray(source.knots)||source.knots.length!==source.count+source.degree+1||source.knots.some((n,i)=>!Number.isFinite(n)||i>0&&n<source.knots[i-1]))||source.kind!=='curve'&&(source.degree!==null||source.knots!==null))throw new Error('放码基准类型或样条结构无效');
    sourceIds.add(source.entityId);return {entityId:source.entityId,kind:source.kind,count:source.count,closed:source.closed,degree:source.degree,knots:source.knots?[...source.knots]:null};
  });
  const seen=new Set(),rules=value.rules.map(rule=>{
    const source=sources.find(source=>source.entityId===rule?.entityId),key=gradePointKey(rule?.entityId,rule?.index);
    if(!source||!Number.isInteger(rule.index)||rule.index<0||rule.index>=source.count||seen.has(key)||!Array.isArray(rule.deltas)||rule.deltas.length!==sizes.length)throw new Error('放码点重复、序号无效或尺码增量不完整');
    seen.add(key);const present=new Set();
    const deltas=rule.deltas.map(delta=>{
      if(!delta||!ids.has(delta.sizeId)||present.has(delta.sizeId)||!Number.isFinite(delta.dx)||!Number.isFinite(delta.dy)||Math.abs(delta.dx)>1e6||Math.abs(delta.dy)>1e6)throw new Error('各尺码 X/Y 位移须是 ±1000000 mm 内的有限数值，且每个尺码恰有一项');
      present.add(delta.sizeId);return {sizeId:delta.sizeId,dx:delta.dx,dy:delta.dy};
    });return {entityId:rule.entityId,index:rule.index,deltas};
  });
  return {name,baseSize,interpolation:value.interpolation,sources,sizes,rules};
}
export function resolveGradeSources(project,plan){
  if(project.units!=='mm')throw new Error('请先校准毫米单位，再设置放码');
  return plan.sources.map(source=>{
    const entity=project.entities.find(entity=>entity.id===source.entityId);
    if(!entity)throw new Error('放码基准已缺失，请恢复图元或重新建立方案');
    const current=gradeSource(entity);
    if(JSON.stringify(current)!==JSON.stringify(source))throw new Error('基准 '+entity.name+' 的节点数、类型、闭合状态或结点向量已变化，请重新建立对应规则');
    return entity;
  });
}
export function validateGradingPlans(project){
  project.gradingPlans??=[];
  if(!Array.isArray(project.gradingPlans)||project.gradingPlans.length>30)throw new Error('最多支持 30 个放码方案');
  const ids=new Set();for(const plan of project.gradingPlans){
    if(!plan||typeof plan.id!=='string'||!plan.id||ids.has(plan.id))throw new Error('放码方案 ID 无效');ids.add(plan.id);
    Object.assign(plan,normalizeGradingPlan(plan),{status:'stale'});delete plan.report;delete plan.error;delete plan.signature;
  }
  if(project.gradingPlans.length)project.version=Math.max(project.version,8);
}
export function prepareGradeVectorTransform(project,ids,vector){
  const updates=[];
  for(const plan of project.gradingPlans||[])for(const rule of plan.rules)if(ids.has(rule.entityId))for(const delta of rule.deltas){
    const p=vector({x:delta.dx,y:delta.dy});
    if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1e6+Number.EPSILON*1e6*16||Math.abs(p.y)>1e6+Number.EPSILON*1e6*16)throw new Error('变换后的放码增量超出 ±1000000 mm，未修改纸样');
    updates.push({delta,x:Math.max(-1e6,Math.min(1e6,p.x)),y:Math.max(-1e6,Math.min(1e6,p.y))});
  }
  return ()=>{for(const {delta,x,y} of updates){delta.dx=x;delta.dy=y;}};
}
export function transformGradeVectors(project,ids,vector){prepareGradeVectorTransform(project,ids,vector)();}
