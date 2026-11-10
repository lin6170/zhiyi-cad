import { pathMetrics, stationOnPath } from './path-metrics.mjs';
import { refreshCurve } from './curves.mjs';
import { validateProject } from './geometry.mjs';
import { contoursForGroup, orientChain } from './topology.mjs';
import { syncAllowances } from './seams.mjs';
import { syncNotches } from './notches.mjs';
import { syncSeamChecks } from './seam-checks.mjs';
import { syncGradingPlans } from './grading.mjs';
import { syncMarkerPlans } from './marker.mjs';

const clone=value=>JSON.parse(JSON.stringify(value));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const MIN_LENGTH=1e-6;
export const lineEditStamp=project=>JSON.stringify(project);

// All subdivision and degree elevation happens in local coordinates. Native
// Bezier spans are reassembled into a clamped spline; no display samples enter.
function subdivide(points,t){
  const left=[points[0]],right=[points.at(-1)];let row=points;
  while(row.length>1){row=row.slice(0,-1).map((point,i)=>lerp(point,row[i+1],t));left.push(row[0]);right.unshift(row.at(-1));}
  return [left,right];
}
function interval(metrics,start,end){
  if(end<=start)return [];
  const a=stationOnPath(metrics,start,{pointOnly:true}),b=stationOnPath(metrics,end,{pointOnly:true}),result=[];
  for(let i=a.pieceIndex;i<=b.pieceIndex;i++){
    let points=metrics.pieces[i].points;
    const lo=i===a.pieceIndex?a.parameter:0,hi=i===b.pieceIndex?b.parameter:1;
    if(hi<=lo)continue;
    if(hi<1)points=subdivide(points,hi)[0];
    if(lo>0)points=subdivide(points,lo/hi)[1];
    result.push(points);
  }
  return result;
}
function elevate(points,degree){
  let current=points;
  while(current.length<degree+1){const n=current.length;current=[current[0],...Array.from({length:n-1},(_,i)=>lerp(current[i+1],current[i],(i+1)/n)),current.at(-1)];}
  return current;
}
function assemble(spans,origin,source,id,name,degree,closed=false){
  if(!spans.length)throw new Error('分割结果为空，请调整位置');
  const world=p=>({x:p.x+origin.x,y:p.y+origin.y});
  const entity={id,type:'polyline',name,layer:source.layer,closed,source:{...clone(source.source||{}),modified:true}};
  if(degree){
    const pieces=spans.map(points=>elevate(points,degree)),controlPoints=pieces[0].map(world),knots=Array(degree+1).fill(0);
    for(let i=1;i<pieces.length;i++){controlPoints.push(...pieces[i].slice(1).map(world));knots.push(...Array(degree).fill(i));}
    knots.push(...Array(degree+1).fill(pieces.length));
    if(controlPoints.length>1002)throw new Error('结果超过 1002 个样条控制点上限，请减少连接数量或先分段处理');
    entity.curve={kind:'bspline',degree,controlPoints,knots,samplingTolerance:source.curve?.samplingTolerance??.002};
    refreshCurve(entity);
  }else{
    entity.points=[world(spans[0][0]),...spans.map(points=>world(points.at(-1)))];
    if(closed&&distance(entity.points[0],entity.points.at(-1))===0)entity.points.pop();
  }
  return entity;
}
function sourceEntities(project,ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>64||new Set(ids).size!==ids.length)throw new Error('请选择 1 至 64 条不同的原始线条');
  const byId=new Map(project.entities.map(entity=>[entity.id,entity]));
  return ids.map(id=>{
    const entity=byId.get(id);if(!entity)throw new Error('原线已删除，请重新选取');
    if(entity.type==='text')throw new Error('文字不能剪开或连接');
    if(entity.derivedFrom||entity.notchFrom)throw new Error('请先解除所选缝份或刀口的关联，再修整线条');
    return entity;
  });
}
function split(entity,config,makeId){
  if(!Number.isFinite(config.a)||entity.closed&&!Number.isFinite(config.b))throw new Error('请输入有效的分割位置');
  const metrics=pathMetrics(entity,{preserveShortPieces:true});
  const station=value=>config.unit==='percent'?(value===100?metrics.total:value/100*metrics.total):value;
  const a=station(config.a),b=entity.closed?station(config.b):metrics.total;
  if(!['mm','percent'].includes(config.unit)||!Number.isFinite(a)||!Number.isFinite(b))throw new Error('请输入有效的分割位置');
  const margin=Math.max(MIN_LENGTH,metrics.uncertainty*4);
  if(entity.closed){
    if(a<0||b>metrics.total||b-a<margin||metrics.total-b+a<margin)throw new Error('闭合线需两个不同位置：0 ≤ A < B ≤ 总长，并保留两段有效长度');
  }else if(a<margin||metrics.total-a<margin)throw new Error('分割位置必须在线内，并离两端至少 0.000001 mm');
  const pieces=entity.closed?[interval(metrics,a,b),[...interval(metrics,b,metrics.total),...interval(metrics,0,a)]]:[interval(metrics,0,a),interval(metrics,a,metrics.total)];
  const outputs=pieces.map((spans,i)=>assemble(spans,metrics.origin,entity,makeId(),entity.name+' · 分段 '+(i+1),entity.curve?.degree||0));
  if(!entity.closed){if(entity.arrowStart)outputs[0].arrowStart=true;if(entity.arrowEnd)outputs[1].arrowEnd=true;}
  const stations=[a,...(entity.closed?[b]:[])].map(value=>stationOnPath(metrics,value,{pointOnly:true}));
  return {outputs,stations,total:metrics.total,lengths:entity.closed?[b-a,metrics.total-b+a]:[a,metrics.total-a],connectors:[],directions:[false],uncertainty:Math.max(metrics.uncertainty,...stations.map(station=>station.uncertainty))};
}

// The user supplies the chain order. Dynamic programming selects orientations
// across the whole open chain (or closed cycle), respecting pinned directions.
function directionsFor(entities,metrics,config){
  const world=(i,reverse,end)=>{const points=entities[i].curve?.controlPoints||entities[i].points;return reverse!==end?points.at(-1):points[0];};
  const allowed=(index,reverse)=>config.directions?.[index]==null||config.directions[index]===reverse;
  let best=null;
  for(const first of [false,true]){
    if(!allowed(0,first))continue;
    let states=[null,null];states[Number(first)]={cost:0,directions:[first]};
    for(let i=1;i<metrics.length;i++){
      const next=[null,null];
      for(const current of [false,true])if(allowed(i,current))for(const previous of [false,true]){
        const state=states[Number(previous)];if(!state)continue;
        const gap=distance(world(i-1,previous,true),world(i,current,false));
        if(gap>config.gapTolerance)continue;
        const cost=state.cost+gap;
        if(!next[Number(current)]||cost<next[Number(current)].cost)next[Number(current)]={cost,directions:[...state.directions,current]};
      }
      states=next;
    }
    for(const state of states.filter(Boolean)){
      const gap=config.close?distance(world(metrics.length-1,state.directions.at(-1),true),world(0,first,false)):0;
      if(gap>config.gapTolerance)continue;
      const cost=state.cost+gap;if(!best||cost<best.cost)best={...state,cost};
    }
  }
  if(!best)throw new Error('按当前顺序无法在间隙上限内连接，请调整顺序、方向或上限');
  return best.directions;
}
function join(entities,config,makeId){
  if(typeof config.close!=='boolean')throw new Error('闭合设置无效');
  if(entities.length<2)throw new Error('连接至少需要两条原线');
  if(entities.some(entity=>entity.closed))throw new Error('连接仅接受开放线条；请先剪开闭合线');
  if(!Number.isFinite(config.gapTolerance)||config.gapTolerance<0||config.gapTolerance>10)throw new Error('连接间隙上限须在 0 至 10 mm 之间');
  if(config.directions!==undefined&&(!Array.isArray(config.directions)||config.directions.length!==entities.length||config.directions.some(value=>![null,false,true].includes(value))))throw new Error('连接方向设置无效');
  const metrics=entities.map(entity=>pathMetrics(entity,{preserveShortPieces:true})),directions=directionsFor(entities,metrics,config),origin=metrics[0].origin,spans=[],connectors=[];
  for(let i=0;i<entities.length;i++){
    const offset={x:metrics[i].origin.x-origin.x,y:metrics[i].origin.y-origin.y};
    let segments=metrics[i].pieces.map(piece=>piece.points.map(point=>({x:point.x+offset.x,y:point.y+offset.y})));
    const endpoints=entities[i].curve?.controlPoints||entities[i].points;
    segments[0][0]={x:endpoints[0].x-origin.x,y:endpoints[0].y-origin.y};
    segments.at(-1)[segments.at(-1).length-1]={x:endpoints.at(-1).x-origin.x,y:endpoints.at(-1).y-origin.y};
    if(directions[i])segments=segments.reverse().map(points=>points.reverse());
    if(spans.length){const a=spans.at(-1).at(-1),b=segments[0][0],gap=distance(a,b);if(gap>0){spans.push([a,b]);connectors.push({a:{x:a.x+origin.x,y:a.y+origin.y},b:{x:b.x+origin.x,y:b.y+origin.y},length:gap});}}
    spans.push(...segments);
  }
  if(config.close){const a=spans.at(-1).at(-1),b=spans[0][0],gap=distance(a,b);if(gap>0){spans.push([a,b]);connectors.push({a:{x:a.x+origin.x,y:a.y+origin.y},b:{x:b.x+origin.x,y:b.y+origin.y},length:gap});}}
  const degree=Math.max(...entities.map(entity=>entity.curve?.degree||0)),entity=assemble(spans,origin,entities[0],makeId(),entities[0].name+' · 连接',degree,Boolean(config.close));
  if(!config.close){const first=entities[0],last=entities.at(-1);if(directions[0]?first.arrowEnd:first.arrowStart)entity.arrowStart=true;if(directions.at(-1)?last.arrowStart:last.arrowEnd)entity.arrowEnd=true;}
  return {outputs:[entity],stations:[],total:metrics.reduce((sum,m)=>sum+m.total,0),lengths:[metrics.reduce((sum,m)=>sum+m.total,0)+connectors.reduce((sum,c)=>sum+c.length,0)],connectors,directions,uncertainty:metrics.reduce((sum,m)=>sum+m.uncertainty,0)};
}
export function replaceGroups(project,sourceIds,outputs,operation){
  const selected=new Set(sourceIds),byId=new Map(project.entities.map(entity=>[entity.id,entity])),dissolved=[];
  if(operation==='join'){
    const memberships=sourceIds.map(id=>(project.groups||[]).find(group=>group.entityIds.includes(id))?.id||null);
    if(new Set(memberships).size>1)throw new Error('原线分属不同组合；请整理组合，或选择保留原线生成副本');
  }
  project.groups=(project.groups||[]).map(group=>{
    if(!group.entityIds.some(id=>selected.has(id)))return group;
    const contours=contoursForGroup(group).map(contour=>{
      if(!contour.entityIds.some(id=>selected.has(id)))return clone(contour);
      if(operation==='split'||operation==='trim'||operation==='extend'){
        const entities=contour.entityIds.map(id=>byId.get(id));
        if(entities.some(entity=>!entity))throw new Error('受影响的轮廓已有缺失图元，请先修复或保留原线');
        const oriented=orientChain(entities);
        return {...clone(contour),entityIds:contour.entityIds.flatMap((id,i)=>selected.has(id)?(oriented[i].reversed?[...outputs].reverse():outputs).map(entity=>entity.id):[id])};
      }
      // A joined chain can replace only one contiguous cyclic run in the
      // original contour, with the same edge order (possibly reversed).
      const ids=contour.entityIds,hit=ids.filter(id=>selected.has(id));
      if(hit.length!==sourceIds.length)throw new Error('连接会改变部分轮廓定义，请改选完整连续边链或保留原线');
      let ordered=ids;
      if(ids.length>hit.length){const boundary=ids.findIndex((id,i)=>selected.has(id)&&!selected.has(ids[(i+ids.length-1)%ids.length]));ordered=[...ids.slice(boundary),...ids.slice(0,boundary)];}
      const run=ordered.slice(0,hit.length),cyclic=ids.length===hit.length;
      const sameOrder=sequence=>{for(let shift=0;shift<(cyclic?sequence.length:1);shift++)if(run.every((id,i)=>id===sequence[(i+shift)%sequence.length]))return true;return false;};
      if(run.some(id=>!selected.has(id))||!sameOrder(sourceIds)&&!sameOrder([...sourceIds].reverse()))throw new Error('所选线在轮廓中不连续或顺序不同，请调整顺序或保留原线');
      return {...clone(contour),entityIds:[outputs[0].id,...ordered.slice(hit.length)]};
    });
    const ids=[];for(const id of group.entityIds){if(selected.has(id)){for(const output of outputs)if(!ids.includes(output.id))ids.push(output.id);}else ids.push(id);}
    if(ids.length<2){dissolved.push(group.name);outputs[0].name=group.name+(operation==='trim'?' · 修剪':' · 连接');return null;}
    return {...group,entityIds:ids,contours,source:{...group.source,membershipModified:true}};
  }).filter(Boolean);
  return dissolved;
}
export function dependencies(project,sourceIds){
  const ids=new Set(sourceIds),effects=[];
  const record=(label,items)=>{if(items.length)effects.push({label,count:items.length,names:items.map(item=>item.name||item.id)});return new Set(items.map(item=>item.id));};
  const seams=(project.seamAllowances||[]).filter(recipe=>recipe.baseEntityIds.some(id=>ids.has(id))),seamIds=record('缝份',seams);
  for(const recipe of seams)for(const id of recipe.outputIds)ids.add(id);
  const notches=(project.notches||[]).filter(recipe=>ids.has(recipe.baseEntityId)||seamIds.has(recipe.targetSeamId)),notchIds=record('刀口',notches);
  for(const recipe of notches)for(const id of recipe.outputIds)ids.add(id);
  record('对缝核对',(project.seamChecks||[]).filter(check=>[check.a,check.b].some(side=>side.edges.some(edge=>ids.has(edge.entityId)))||(check.landmarks||[]).some(mark=>[mark.a,mark.b].some(locator=>locator.kind==='notch'&&notchIds.has(locator.notchId)))));
  const gradeIds=record('放码方案',(project.gradingPlans||[]).filter(plan=>plan.sources.some(source=>ids.has(source.entityId))));
  const markerIds=record('排料方案',(project.markerPlans||[]).filter(plan=>plan.items.some(item=>gradeIds.has(item.gradePlanId)||item.memberIds.some(id=>ids.has(id))||ids.has(item.grainEntityId)||(item.boundary.kind==='chain'?item.boundary.entityIds.some(id=>ids.has(id)):seamIds.has(item.boundary.recipeId)))));
  const plot=project.plotSettings;if(plot&&(plot.source==='selection'&&plot.selectionIds.some(id=>ids.has(id))||plot.source==='grade'&&gradeIds.has(plot.sourceId)||['marker','marker-cuts'].includes(plot.source)&&markerIds.has(plot.sourceId)))effects.push({label:'已保存的出图来源',count:1,names:[]});
  return effects;
}
export function prepareLineEdit(project,value){
  if(project.units!=='mm')throw new Error('请先确认毫米比例，再修整线条');
  if(!value||!['split','join'].includes(value.operation)||typeof value.keepOriginals!=='boolean')throw new Error('线条修整设置无效');
  const config=clone(value),entities=sourceEntities(project,config.ids);
  if(config.operation==='split'&&entities.length!==1)throw new Error('剪开时请选择一条原线');
  let serial=0;const used=new Set(project.entities.map(entity=>entity.id)),makeId=()=>{let id;do{id='line-preview-'+(++serial);}while(used.has(id));used.add(id);return id;};
  const result=config.operation==='split'?split(entities[0],config,makeId):join(entities,config,makeId);
  for(const entity of result.outputs)entity.source.lineEdit={operation:config.operation,entityIds:[...config.ids]};
  const next=clone(project),dissolved=config.keepOriginals?[]:replaceGroups(next,config.ids,result.outputs,config.operation);
  if(!config.keepOriginals)next.entities=next.entities.filter(entity=>!config.ids.includes(entity.id));
  next.entities.push(...result.outputs);validateProject(next);
  const effects=config.keepOriginals?[]:dependencies(project,config.ids);
  return {...result,project:next,config,signature:lineEditStamp(project),effects,dissolved,mixedLayers:new Set(entities.map(entity=>entity.layer)).size>1};
}
export function applyLineEdit(project,preview,makeId){
  if(!preview||preview.signature!==lineEditStamp(project))throw new Error('工程已变化，请重新生成修整预览');
  const next=clone(preview.project),mapping=new Map(preview.outputs.map(entity=>[entity.id,makeId()]));
  for(const entity of next.entities)if(mapping.has(entity.id))entity.id=mapping.get(entity.id);
  for(const group of next.groups||[]){group.entityIds=group.entityIds.map(id=>mapping.get(id)||id);for(const contour of group.contours||[])contour.entityIds=contour.entityIds.map(id=>mapping.get(id)||id);}
  validateProject(next);syncAllowances(next,makeId);syncNotches(next,makeId);syncSeamChecks(next);syncGradingPlans(next);syncMarkerPlans(next);
  return {project:next,outputIds:[...mapping.values()]};
}
