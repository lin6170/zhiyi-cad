import { emptyMarkerPlan, normalizeMarkerPlan, markerTurns, markerInstanceKey } from './marker-schema.mjs';
import { MARKER_GRID as GRID, integerPolygon, polygonArea, polygonBounds, offsetOccupancy, translatePolygon, occupancyOverlap } from './marker-polygons.mjs';
import { sampleCurve } from './curves.mjs';
import { contoursForGroup, orientChain } from './topology.mjs';
import { syncAllowances } from './seams.mjs';
import { syncNotches } from './notches.mjs';
import { generateGradedSize } from './grading.mjs';
import { validateProject } from './geometry.mjs';
export { emptyMarkerPlan, normalizeMarkerPlan, markerTurns, markerInstanceKey } from './marker-schema.mjs';
const clone=value=>JSON.parse(JSON.stringify(value)),cache=new WeakMap();
export function markerSourceSignature(project){return JSON.stringify([project.units,project.entities,project.groups,project.seamAllowances,project.notches,project.seamChecks,project.gradingPlans,project.metadata?.baseSize,project.metadata?.gradedSize]);}
function sourceProject(project,item,sources){
  const key=JSON.stringify([item.gradePlanId,item.sizeId]);if(sources.has(key))return sources.get(key);
  let source;
  if(item.gradePlanId){const plan=project.gradingPlans?.find(plan=>plan.id===item.gradePlanId);if(!plan)throw new Error('引用的放码方案已缺失');source=generateGradedSize(project,plan,item.sizeId).project;}
  else{
    source=clone({...project,gradingPlans:[],markerPlans:[]});let id=0;const used=new Set(source.entities.map(e=>e.id)),nextId=()=>{let value;do{value='marker-generated-'+(++id);}while(used.has(value));used.add(value);return value;};
    syncAllowances(source,nextId);syncNotches(source,nextId);
  }
  sources.set(key,source);return source;
}
export function markerChoices(project,selected,gradePlanId=null,sizeId=null){
  if(project.units!=='mm')throw new Error('请先校准毫米单位，再设置排料');
  const source=sourceProject(project,{gradePlanId,sizeId},new Map()),byId=new Map(source.entities.map(e=>[e.id,e])),choices=[],covered=new Set();
  function addChoices(name,members,chains){
    const originalIds=members.filter(id=>{const e=byId.get(id);return e&&!e.derivedFrom&&!e.notchFrom;});if(!originalIds.length)return;
    const common={name,memberIds:originalIds,gradePlanId,sizeId};
    for(const [index,chain] of chains.entries())if(chain.entityIds.length&&chain.entityIds.every(id=>byId.has(id)))choices.push({...common,key:JSON.stringify(['chain',chain.entityIds]),label:name+' · '+(chain.role==='primary-contour'?'主轮廓':'轮廓 '+(index+1)),boundary:{kind:'chain',entityIds:[...chain.entityIds]}});
    for(const recipe of source.seamAllowances||[])if(recipe.baseEntityIds.every(id=>originalIds.includes(id)))choices.push({...common,key:'seam-'+recipe.id,label:name+' · '+recipe.name+'（外边界）',boundary:{kind:'seam',recipeId:recipe.id}});
    const grains=originalIds.map(id=>byId.get(id)).filter(e=>e.type!=='text'&&!e.curve&&e.points.length===2&&(e.layer==='grain'||e.arrowEnd||e.arrowStart));
    for(const choice of choices.filter(choice=>choice.memberIds===originalIds))choice.grains=grains.map(e=>({id:e.id,name:e.name}));
  }
  for(const group of source.groups||[]){
    const originalIds=group.entityIds.filter(id=>{const e=byId.get(id);return e&&!e.derivedFrom&&!e.notchFrom;});
    if(!originalIds.length||!originalIds.every(id=>selected.has(id)))continue;
    let chains=contoursForGroup(group);if(!chains.length)chains=originalIds.filter(id=>byId.get(id).closed&&byId.get(id).type!=='text').map(id=>({role:'additional-chain',entityIds:[id]}));
    addChoices(group.name,group.entityIds,chains);originalIds.forEach(id=>covered.add(id));
  }
  for(const entity of source.entities)if(selected.has(entity.id)&&!covered.has(entity.id)&&!entity.notchFrom){
    if(entity.derivedFrom){const recipe=source.seamAllowances?.find(recipe=>recipe.id===entity.derivedFrom);if(recipe)addChoices(entity.name,recipe.baseEntityIds,[]);}
    else if(entity.closed&&entity.type!=='text')addChoices(entity.name,[entity.id],[{role:'primary-contour',entityIds:[entity.id]}]);
  }
  const unique=new Map(choices.map(choice=>[choice.key,choice]));return {source,choices:[...unique.values()]};
}
export function markerItem(choice,makeId){return {id:makeId(),name:choice.name,memberIds:[...choice.memberIds],boundary:clone(choice.boundary),gradePlanId:choice.gradePlanId,sizeId:choice.sizeId,grainEntityId:choice.grains?.length===1?choice.grains[0].id:null,grainAngle:90,quantity:1,mirroredQuantity:0,direction:'one-way'};}
function boundaryPoints(source,item,config){
  let entities;
  if(item.boundary.kind==='seam'){
    const recipe=source.seamAllowances?.find(recipe=>recipe.id===item.boundary.recipeId);
    if(!recipe||recipe.status!=='current'||!recipe.baseEntityIds.every(id=>item.memberIds.includes(id)))throw new Error('裁剪缝份失效或不属于此裁片');
    const outers=recipe.outputIds.map(id=>source.entities.find(e=>e.id===id)).filter(e=>e&&e.seamRole!=='hole');
    if(outers.length!==1)throw new Error('裁剪缝份已分裂为多个外边界，请先拆分为独立裁片');entities=outers;
  }else entities=item.boundary.entityIds.map(id=>{
    const entity=source.entities.find(entity=>entity.id===id);if(!entity||!item.memberIds.includes(id)||entity.type==='text'||entity.notchFrom||entity.derivedFrom)throw new Error('裁剪边界缺失或不属于原始裁片');return entity;
  });
  if(!entities.length||entities.length===1&&!entities[0].closed||entities.length>1&&entities.some(e=>e.closed))throw new Error('请选择独立闭合边界或完整的多曲线轮廓链');
  const curved=entities.some(e=>e.curve),sampled=entities.map(entity=>{if(!entity.curve)return entity;const result=sampleCurve({...entity.curve,samplingTolerance:config.curveTolerance});if(result.capped)throw new Error('裁剪曲线采样达到上限');return {...entity,points:result.points};});
  const ordered=orientChain(sampled),points=[];let maxGap=0,bridgeCount=0;
  ordered.forEach((item,index)=>{
    points.push(...item.points);
    if(ordered.length===1&&item.entity.closed)return;
    const a=item.points.at(-1),b=ordered[(index+1)%ordered.length].points[0],gap=Math.hypot(a.x-b.x,a.y-b.y);maxGap=Math.max(maxGap,gap);
    if(gap>config.gapTolerance+1e-9)throw new Error('裁剪轮廓间隙 '+gap.toFixed(4)+' mm 超出容差');if(gap>1e-9)bridgeCount++;
  });
  if(points.length>20000)throw new Error('裁剪边界超过 20000 个计算节点');
  return {points,curved,maxGap,bridgeCount};
}
function trig(degrees){
  const turn=((degrees%360)+360)%360,index=Math.round(turn/90);
  if(Math.abs(turn-index*90)<1e-10)return {c:[1,0,-1,0,1][index],s:[0,1,0,-1,0][index]};
  const angle=turn*Math.PI/180;return {c:Math.cos(angle),s:Math.sin(angle)};
}
function makeShape(item,boundary,grainAngle,mirrored,turn,config){
  const origin={...boundary.points[0]},base=trig(90-grainAngle),rotation=trig(turn),sign=mirrored?-1:1;
  const matrix={a:rotation.c*sign*base.c-rotation.s*base.s,b:-rotation.c*sign*base.s-rotation.s*base.c,c:rotation.s*sign*base.c+rotation.c*base.s,d:-rotation.s*sign*base.s+rotation.c*base.c};
  const points=boundary.points.map(p=>({x:matrix.a*(p.x-origin.x)+matrix.b*(p.y-origin.y),y:matrix.c*(p.x-origin.x)+matrix.d*(p.y-origin.y)}));
  const minX=Math.min(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),integer=integerPolygon(points.map(p=>({x:p.x-minX,y:p.y-minY})));
  const uncertainty=integer.error+(boundary.curved?config.curveTolerance:0),padding=Math.ceil((config.spacing/2+uncertainty)*GRID);
  return {key:JSON.stringify([item.id,mirrored,turn]),itemId:item.id,mirrored,turn,origin,matrix,minX,minY,path:integer.path,bounds:polygonBounds(integer.path),occupancy:offsetOccupancy(integer.path,padding),uncertainty,area:Math.abs(polygonArea(integer.path))/(GRID*GRID)};
}
export function markerPoint(point,shape,placement){const x=point.x-shape.origin.x,y=point.y-shape.origin.y;return {x:shape.matrix.a*x+shape.matrix.b*y-shape.minX+placement.x,y:shape.matrix.c*x+shape.matrix.d*y-shape.minY+placement.y};}
export function prepareMarker(project,value){
  const config=normalizeMarkerPlan(value);if(project.units!=='mm')throw new Error('请先校准毫米单位，再排料');
  const sources=new Map(),templates=config.items.map(item=>{
    const source=sourceProject(project,item,sources),byId=new Map(source.entities.map(e=>[e.id,e])),ids=new Set(item.memberIds);
    for(const id of ids){const entity=byId.get(id);if(!entity||entity.derivedFrom||entity.notchFrom)throw new Error(item.name+' 的原始裁片图元已缺失');}
    const seams=(source.seamAllowances||[]).filter(recipe=>recipe.baseEntityIds.some(id=>ids.has(id)));
    if(seams.some(recipe=>recipe.baseEntityIds.some(id=>!ids.has(id))))throw new Error(item.name+' 仅包含部分关联缝份基准');
    const notches=(source.notches||[]).filter(recipe=>ids.has(recipe.baseEntityId));
    for(const recipe of [...seams,...notches]){if(recipe.status!=='current'||recipe.outputIds.some(id=>!byId.has(id)))throw new Error(item.name+' 的缝份或刀口失效：'+(recipe.error||'输出缺失'));recipe.outputIds.forEach(id=>ids.add(id));}
    const boundary=boundaryPoints(source,item,config),grain=item.grainEntityId?byId.get(item.grainEntityId):null;
    if(item.grainEntityId&&(!grain||!item.memberIds.includes(grain.id)||grain.type==='text'||grain.curve||grain.points.length!==2||Math.hypot(grain.points[1].x-grain.points[0].x,grain.points[1].y-grain.points[0].y)<1e-7))throw new Error(item.name+' 的布纹基准必须是裁片内有效的两点直线');
    const grainAngle=grain?Math.atan2(grain.points[1].y-grain.points[0].y,grain.points[1].x-grain.points[0].x)*180/Math.PI:item.grainAngle,shapes=[];
    for(const mirrored of [false,true])if(mirrored?item.mirroredQuantity:item.quantity)for(const turn of markerTurns(item))shapes.push(makeShape(item,boundary,grainAngle,mirrored,turn,config));
    const warnings=[];if(boundary.bridgeCount)warnings.push(boundary.bridgeCount+' 处间隙在排料边界中直线连接，最大 '+boundary.maxGap.toFixed(4)+' mm；原图元未改动。');
    if(item.boundary.kind==='seam'){const recipe=source.seamAllowances.find(recipe=>recipe.id===item.boundary.recipeId);if(recipe.outputIds.some(id=>byId.get(id)?.seamRole==='hole'))warnings.push('外边界按实心占料，内孔不用于嵌套，也不从利用率面积扣除。');}
    return {item,entities:clone(source.entities.filter(e=>ids.has(e.id))),grain:grain?clone(grain):null,shapes,warnings,sizeLabel:source.metadata?.gradedSize||source.metadata?.baseSize||''};
  });
  const instances=[];for(const template of templates)for(const mirrored of [false,true])for(let ordinal=0;ordinal<(mirrored?template.item.mirroredQuantity:template.item.quantity);ordinal++)instances.push({key:markerInstanceKey(template.item.id,mirrored,ordinal),itemId:template.item.id,mirrored,ordinal});
  return {config,templates,instances};
}
export function markerDomain(shape,config){return {minX:Math.ceil((config.edgeMargin+shape.uncertainty)*GRID-shape.bounds.minX),maxX:Math.floor((config.fabricWidth-config.edgeMargin-shape.uncertainty)*GRID-shape.bounds.maxX),minY:Math.ceil((config.edgeMargin+shape.uncertainty)*GRID-shape.bounds.minY),maxY:Math.floor((config.maxLength-config.edgeMargin-shape.uncertainty)*GRID-shape.bounds.maxY)};}
export function placedMarkerShape(prepared,placement){
  const template=prepared.templates.find(template=>template.item.id===placement.itemId),shape=template?.shapes.find(shape=>shape.mirrored===placement.mirrored&&shape.turn===placement.turn);
  if(!shape)throw new Error('裁片方向不在允许范围内');
  const x=Math.round(placement.x*GRID),y=Math.round(placement.y*GRID);
  return {template,shape,placement,key:markerInstanceKey(placement.itemId,placement.mirrored,placement.ordinal),x,y,path:translatePolygon(shape.path,x,y),occupancy:shape.occupancy.map(path=>translatePolygon(path,x,y))};
}
export function validateMarkerLayout(prepared,placements){
  const config=normalizeMarkerPlan({...prepared.config,placements}),errors=[],placed=[];let usedLength=0,area=0;
  for(const placement of config.placements){
    const key=markerInstanceKey(placement.itemId,placement.mirrored,placement.ordinal);
    try{
      const record=placedMarkerShape(prepared,placement),domain=markerDomain(record.shape,config);
      if(record.x<domain.minX||record.x>domain.maxX||record.y<domain.minY||record.y>domain.maxY)errors.push({kind:'outside',key,message:'超出布幅、边距或最大排料长度'});
      for(const previous of placed)if(occupancyOverlap(record.occupancy,previous.occupancy))errors.push({kind:'collision',key,otherKey:previous.key,message:'裁剪边界重叠或间距不足'});
      placed.push(record);usedLength=Math.max(usedLength,(record.y+record.shape.bounds.maxY)/GRID+config.edgeMargin+record.shape.uncertainty);area+=record.shape.area;
    }catch(error){errors.push({kind:'direction',key,message:error.message});}
  }
  const present=new Set(config.placements.map(p=>markerInstanceKey(p.itemId,p.mirrored,p.ordinal))),missing=prepared.instances.filter(instance=>!present.has(instance.key)),complete=prepared.instances.length>0&&!missing.length&&!errors.length;
  return {config,placed,report:{requested:prepared.instances.length,placed:placed.length,missing:missing.map(instance=>instance.key),errors,complete,usedLength,cutArea:area,fabricArea:usedLength*config.fabricWidth,utilization:complete&&usedLength>0?100*area/(usedLength*config.fabricWidth):null,warnings:prepared.templates.flatMap(template=>template.warnings.map(warning=>template.item.name+'：'+warning)),grid:1/GRID,curveTolerance:config.curveTolerance,scope:'按指定实心裁剪边界及间距核验；不在内孔内排料，不推断净线/毛线、布料正反面或对条对格。'}};
}
export function evaluateMarkerPlan(project,value){const prepared=prepareMarker(project,value);return {prepared,...validateMarkerLayout(prepared,prepared.config.placements)};}
export function syncMarkerPlans(project){
  const sourceKey=markerSourceSignature(project);
  for(const plan of project.markerPlans||[]){let key;try{
    key=JSON.stringify([sourceKey,normalizeMarkerPlan(plan)]);if(cache.get(plan)?.key===key&&plan.status!=='stale'&&plan.report)continue;
    const result=evaluateMarkerPlan(project,plan);cache.set(plan,{key,result});plan.report=clone(result.report);plan.status=result.report.complete?'current':result.report.errors.length?'error':'incomplete';delete plan.error;
  }catch(error){cache.set(plan,{key,result:null});plan.status='error';plan.error=error.message;delete plan.report;}}
}
export function markerResult(project,plan){syncMarkerPlans(project);const result=cache.get(plan)?.result;return result?clone(result):null;}
export function applyMarkerPlan(project,value,makeId,planId=null){
  const config=normalizeMarkerPlan(value);if(!config.items.length)throw new Error('请先添加排料裁片');prepareMarker(project,config);
  const plans=project.markerPlans||[],existing=plans.find(plan=>plan.id===planId);if(planId&&!existing)throw new Error('待更新排料方案已缺失');if(!existing&&plans.length>=30)throw new Error('最多支持 30 个排料方案');
  const plan=existing||{id:makeId()};Object.assign(plan,config);if(!existing)plans.push(plan);project.markerPlans=plans;project.version=Math.max(project.version,9);syncMarkerPlans(project);return plan;
}
export function exportMarkerProject(project,value,{cutOnly=false}={}){
  const result=evaluateMarkerPlan(project,value);if(!result.report.complete)throw new Error('排料尚未完整通过边界、间距和数量核验，不能导出');
  const entities=[],groups=[];let serial=0;const makeId=()=> 'marker-output-'+(++serial);
  for(const record of result.placed){
    const {template,shape,placement}=record,label=template.item.name+' '+(template.sizeLabel||'')+' #'+(placement.ordinal+1)+(placement.mirrored?' 镜像':''),members=[];
    if(cutOnly){const id=makeId();members.push(id);entities.push({id,name:label,type:'polyline',layer:'CUT_BOUNDARY',closed:true,points:record.path.map(p=>({x:p.X/GRID,y:p.Y/GRID}))});}
    else for(const entity of template.entities){
      const copy=clone(entity);copy.id=makeId();copy.points=entity.points.map(p=>markerPoint(p,shape,placement));
      if(copy.curve)copy.curve.controlPoints=entity.curve.controlPoints.map(p=>markerPoint(p,shape,placement));
      if(copy.type==='text'){const r=(entity.rotation||0)*Math.PI/180,v={x:Math.cos(r),y:Math.sin(r)},x=shape.matrix.a*v.x+shape.matrix.b*v.y,y=shape.matrix.c*v.x+shape.matrix.d*v.y;copy.rotation=Math.atan2(y,x)*180/Math.PI;copy.mirrorY=Boolean(entity.mirrorY)!==placement.mirrored;}
      delete copy.derivedFrom;delete copy.notchFrom;delete copy.seamRole;if(copy.source)copy.source.modified=true;copy.markerSource={itemId:placement.itemId,sourceEntityId:entity.id,ordinal:placement.ordinal,mirrored:placement.mirrored};members.push(copy.id);entities.push(copy);
    }
    const center={x:placement.x+(shape.bounds.minX+shape.bounds.maxX)/(2*GRID),y:placement.y+(shape.bounds.minY+shape.bounds.maxY)/(2*GRID)},id=makeId();entities.push({id,name:label,type:'text',layer:'MARKER_LABEL',text:label,height:3,points:[center]});members.push(id);
    groups.push({id:makeId(),name:label,entityIds:members,contours:cutOnly?[{role:'primary-contour',entityIds:[members[0]]}]:[],source:{kind:'marker-output'}});
  }
  entities.push({id:makeId(),name:'布幅',type:'polyline',layer:'FABRIC_BORDER',closed:true,points:[{x:0,y:0},{x:result.config.fabricWidth,y:0},{x:result.config.fabricWidth,y:result.report.usedLength},{x:0,y:result.report.usedLength}]});
  return validateProject({format:'zhiyi-cad',version:9,name:result.config.name,units:'mm',entities,groups,seamAllowances:[],notches:[],seamChecks:[],gradingPlans:[],markerPlans:[],metadata:{format:'制衣 CAD 排料输出'},warnings:['排料输出是独立静态几何；源基码和排料方案保留在原工程。'],markerReport:result.report});
}
