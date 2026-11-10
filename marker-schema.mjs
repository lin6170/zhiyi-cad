export const markerInstanceKey=(itemId,mirrored,ordinal)=>JSON.stringify([itemId,mirrored,ordinal]);
export const markerTurns=item=>item.direction==='one-way'?[0]:item.direction==='two-way'?[0,180]:[0,90,180,270];
const ids=(value,label)=>{if(!Array.isArray(value)||!value.length||value.length>2000||value.some(id=>typeof id!=='string')||new Set(value).size!==value.length)throw new Error(label+'引用无效');return [...value];};
export function normalizeMarkerPlan(value){
  if(!value||!Array.isArray(value.items)||value.items.length>100||!Array.isArray(value.placements)||value.placements.length>200)throw new Error('排料方案最多支持 100 种裁片、200 个实例');
  for(const [key,min,max] of [['fabricWidth',1,10000],['maxLength',1,100000],['spacing',0,100],['edgeMargin',0,1000],['gapTolerance',0,1],['curveTolerance',.005,.1]])if(!Number.isFinite(value[key])||value[key]<min||value[key]>max)throw new Error('排料布宽、长度、间距或计算容差无效');
  if(value.edgeMargin*2>=value.fabricWidth||value.edgeMargin*2>=value.maxLength)throw new Error('布边留量超过有效幅面');
  const seen=new Set();let count=0;
  const items=value.items.map(item=>{
    if(!item||typeof item.id!=='string'||!item.id||seen.has(item.id)||!['one-way','two-way','quarter'].includes(item.direction)||![item.quantity,item.mirroredQuantity].every(n=>Number.isInteger(n)&&n>=0&&n<=200)||item.quantity+item.mirroredQuantity<1)throw new Error('裁片 ID、方向或数量无效');
    seen.add(item.id);count+=item.quantity+item.mirroredQuantity;
    if(count>200)throw new Error('每个排料方案最多 200 片');
    if(item.gradePlanId!==null&&typeof item.gradePlanId!=='string'||item.sizeId!==null&&typeof item.sizeId!=='string'||Boolean(item.gradePlanId)!==Boolean(item.sizeId))throw new Error('排料尺码来源无效');
    const boundary=item.boundary;
    if(!boundary||!['chain','seam'].includes(boundary.kind))throw new Error('请明确指定裁剪边界');
    let normalizedBoundary;
    if(boundary.kind==='chain')normalizedBoundary={kind:'chain',entityIds:ids(boundary.entityIds,'裁剪边界')};
    else{if(typeof boundary.recipeId!=='string'||!boundary.recipeId)throw new Error('裁剪缝份引用无效');normalizedBoundary={kind:'seam',recipeId:boundary.recipeId};}
    if(item.grainEntityId!==null&&typeof item.grainEntityId!=='string'||!Number.isFinite(item.grainAngle)||Math.abs(item.grainAngle)>3600)throw new Error('请指定布纹线或有效的布纹角度');
    return {id:item.id,name:String(item.name||'裁片').slice(0,200),memberIds:ids(item.memberIds,'裁片图元'),boundary:normalizedBoundary,gradePlanId:item.gradePlanId,sizeId:item.sizeId,grainEntityId:item.grainEntityId,grainAngle:item.grainAngle,quantity:item.quantity,mirroredQuantity:item.mirroredQuantity,direction:item.direction};
  });
  const placed=new Set();
  const placements=value.placements.map(placement=>{
    const item=items.find(item=>item.id===placement?.itemId);
    if(!item||typeof placement.mirrored!=='boolean'||!Number.isInteger(placement.ordinal)||placement.ordinal<0||placement.ordinal>=(placement.mirrored?item.mirroredQuantity:item.quantity)||![0,90,180,270].includes(placement.turn)||![placement.x,placement.y].every(n=>Number.isFinite(n)&&Math.abs(n)<=1e6))throw new Error('排料位置、序号或角度无效');
    const key=markerInstanceKey(item.id,placement.mirrored,placement.ordinal);if(placed.has(key))throw new Error('同一裁片实例不能重复放置');placed.add(key);
    return {itemId:item.id,mirrored:placement.mirrored,ordinal:placement.ordinal,turn:placement.turn,x:Math.round(placement.x*1000)/1000,y:Math.round(placement.y*1000)/1000};
  });
  return {name:String(value.name||'排料方案').slice(0,200),fabricWidth:value.fabricWidth,maxLength:value.maxLength,spacing:value.spacing,edgeMargin:value.edgeMargin,gapTolerance:value.gapTolerance,curveTolerance:value.curveTolerance,items,placements};
}
export function emptyMarkerPlan(){return {name:'排料方案',fabricWidth:1500,maxLength:10000,spacing:3,edgeMargin:10,gapTolerance:.1,curveTolerance:.01,items:[],placements:[]};}
export function validateMarkerPlans(project){
  project.markerPlans??=[];if(!Array.isArray(project.markerPlans)||project.markerPlans.length>30)throw new Error('最多支持 30 个排料方案');
  const seen=new Set();for(const plan of project.markerPlans){if(!plan||typeof plan.id!=='string'||!plan.id||seen.has(plan.id))throw new Error('排料方案 ID 无效');seen.add(plan.id);Object.assign(plan,normalizeMarkerPlan(plan),{status:'stale'});delete plan.report;delete plan.error;}
  if(project.markerPlans.length)project.version=Math.max(project.version,9);
}
