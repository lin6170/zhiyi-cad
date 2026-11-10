import { pathMetrics, stationOnPath } from './path-metrics.mjs';
import { seamWidthAt } from './seam-widths.mjs';

const defaults={mode:'start',position:25,side:1,count:1,spacing:3,depth:3,shape:'line',width:3,targetSeamId:null};
export function notchSettings(options={}){
  const config=Object.fromEntries(Object.keys(defaults).map(key=>[key,options[key]??defaults[key]]));
  if(!['start','end','ratio'].includes(config.mode)||!Number.isFinite(config.position)||config.position<0||config.position>(config.mode==='ratio'?100:1e8))throw new Error('刀口位置须为有效距离或 0–100% 比例');
  if(![-1,1].includes(config.side)||![1,2,3].includes(config.count)||!['line','v'].includes(config.shape))throw new Error('刀口方向、数量或形状无效');
  for(const key of ['spacing','depth','width'])if(!Number.isFinite(config[key])||config[key]<.01||config[key]>1e5)throw new Error('刀口深度、宽度和间距须在 0.01 至 100000 mm 之间');
  if(config.targetSeamId!==null&&typeof config.targetSeamId!=='string')throw new Error('刀口缝份引用无效');
  return config;
}
const offset=(p,v,d)=>({x:p.x+v.x*d,y:p.y+v.y*d});
const cross=(a,b)=>a.x*b.y-a.y*b.x;
function projectToSeam(project,base,station,normal,recipe){
  if(!recipe||recipe.status!=='current'||!recipe.baseEntityIds.includes(base.id))throw new Error('目标缝份缺失、失效或不属于此基准线');
  const expected=seamWidthAt(recipe,base,station.position),tolerance=4*(recipe.curveTolerance+recipe.arcTolerance+.001);
  if(expected<=0)throw new Error('此边缝份为零，不能投影切入刀口');
  const hits=[];
  for(const id of recipe.outputIds){
    const entity=project.entities.find(item=>item.id===id);
    if(!entity||!entity.closed)throw new Error('目标缝份输出缺失');
    const points=entity.points;
    for(let i=0;i<points.length;i++){
      const a=points[i],b=points[(i+1)%points.length],edge={x:b.x-a.x,y:b.y-a.y},delta={x:a.x-station.point.x,y:a.y-station.point.y},den=cross(normal,edge);
      if(Math.abs(den)<1e-12)continue;
      const ray=cross(delta,edge)/den,u=cross(delta,normal)/den;
      if(ray>0&&u>=-1e-9&&u<=1+1e-9)hits.push(ray);
    }
  }
  // A wrong side or swallowed narrow region must not jump to a remote edge.
  const nearest=hits.reduce((best,value)=>Math.min(best,value),Infinity);
  if(!Number.isFinite(nearest)||Math.abs(nearest-expected)>tolerance)throw new Error('此侧未找到对应缝份；请切换左右侧或调整位置');
  return {point:offset(station.point,normal,nearest),distance:nearest};
}
export function generateNotches(project,baseEntityId,options={}){
  if(project.units!=='mm')throw new Error('请先校准毫米单位，再创建刀口');
  const config=notchSettings(options),base=project.entities.find(entity=>entity.id===baseEntityId);
  if(!base)throw new Error('刀口基准线已缺失');
  if(base.derivedFrom||base.notchFrom)throw new Error('请选择原始基准线；缝份投影请在刀口面板中设置');
  const metrics=pathMetrics(base),center=config.mode==='ratio'?metrics.total*config.position/100:config.mode==='end'?metrics.total-config.position:config.position;
  const target=config.targetSeamId?(project.seamAllowances||[]).find(recipe=>recipe.id===config.targetSeamId):null;
  const stations=[],paths=[];
  for(let i=0;i<config.count;i++){
    const station=stationOnPath(metrics,center+(i-(config.count-1)/2)*config.spacing);
    const normal={x:-station.tangent.y*config.side,y:station.tangent.x*config.side};
    let anchor=station.point,direction=normal,projectionDistance=0;
    if(config.targetSeamId){
      const projected=projectToSeam(project,base,station,normal,target);
      anchor=projected.point;projectionDistance=projected.distance;
      if(config.depth>=projectionDistance)throw new Error('刀口深度达到或超过此处缝份宽度，请减小深度');
      direction={x:-normal.x,y:-normal.y};
    }
    const tip=offset(anchor,direction,config.depth);
    const points=config.shape==='v'?[offset(anchor,station.tangent,-config.width/2),tip,offset(anchor,station.tangent,config.width/2)]:[anchor,tip];
    if(points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1e8||Math.abs(p.y)>1e8))throw new Error('刀口坐标超出范围');
    paths.push({points});stations.push({...station,anchor,projectionDistance});
  }
  return {paths,stations,total:metrics.total,center,config};
}
function signature(project,recipe){
  const base=project.entities.find(entity=>entity.id===recipe.baseEntityId),target=(project.seamAllowances||[]).find(item=>item.id===recipe.targetSeamId);
  return JSON.stringify([project.units,notchSettings(recipe),recipe.baseEntityId,base&&[base.curve||base.points,base.closed,base.derivedFrom,base.notchFrom],target&&[target.id,target.status,target.distance,target.widthMode,target.edgeWidths,target.curveTolerance,target.arcTolerance,target.baseEntityIds,target.outputIds.map(id=>project.entities.find(entity=>entity.id===id)?.points)]]);
}
export function syncNotches(project,makeId){
  for(const recipe of project.notches||[]){
    let current;
    try{
      current=signature(project,recipe);if(current===recipe.signature)continue;
      const result=generateNotches(project,recipe.baseEntityId,recipe),oldIds=recipe.outputIds||[];
      const outputs=result.paths.map((path,index)=>{
        const old=project.entities.find(entity=>entity.id===oldIds[index]);
        return {...old,id:old?.id||makeId(),type:'polyline',name:old?.name||(recipe.name+' '+(index+1)),layer:old?.layer||'notch',closed:false,points:path.points,notchFrom:recipe.id};
      });
      const group=(project.groups||[]).find(item=>item.entityIds.includes(recipe.baseEntityId))||(project.groups||[]).find(item=>item.entityIds.includes(oldIds[0]));
      project.entities=project.entities.filter(entity=>!oldIds.includes(entity.id)).concat(outputs);
      recipe.outputIds=outputs.map(entity=>entity.id);
      for(const item of project.groups||[])item.entityIds=item.entityIds.filter(id=>!oldIds.includes(id)||recipe.outputIds.includes(id));
      if(group)group.entityIds.push(...recipe.outputIds.filter(id=>!oldIds.includes(id)));
      project.groups=(project.groups||[]).filter(item=>item.entityIds.length>=2);
      recipe.signature=current;recipe.status='current';recipe.baseLength=result.total;delete recipe.error;
    }catch(error){recipe.signature=current??null;recipe.status='error';recipe.error=error.message;}
  }
}
export function applyNotches(project,baseEntityId,options,makeId,recipeId=null){
  const generated=generateNotches(project,baseEntityId,options);
  project.notches??=[];project.groups??=[];
  let recipe=recipeId?project.notches.find(item=>item.id===recipeId):null;
  if(recipeId&&(!recipe||recipe.baseEntityId!==baseEntityId))throw new Error('待更新刀口的基准不匹配');
  const isNew=!recipe;
  if(!recipe){recipe={id:makeId(),name:'关联刀口',baseEntityId,outputIds:[]};project.notches.push(recipe);}
  Object.assign(recipe,generated.config,{signature:null,status:'stale'});
  syncNotches(project,makeId);
  if(recipe.status!=='current')throw new Error(recipe.error);
  if(isNew){
    let group=project.groups.find(item=>item.entityIds.includes(baseEntityId));
    if(!group){group={id:makeId(),name:project.entities.find(entity=>entity.id===baseEntityId).name,entityIds:[baseEntityId],source:{kind:'manual'}};project.groups.push(group);}
    group.entityIds=[...new Set([...group.entityIds,...recipe.outputIds])];
    if(group.source?.format==='ET PRJ')group.source={...group.source,membershipModified:true};
  }
  project.version=Math.max(project.version,4);return recipe;
}
export function detachNotches(project,recipeId){
  for(const entity of project.entities)if(entity.notchFrom===recipeId)delete entity.notchFrom;
  project.notches=(project.notches||[]).filter(recipe=>recipe.id!==recipeId);
}
export function assertNotchTransform(project,ids){
  for(const recipe of project.notches||[])if(recipe.outputIds.some(id=>ids.has(id))&&!ids.has(recipe.baseEntityId))throw new Error('关联刀口随基准变化。单独编辑前请先解除关联。');
}
export function validateNotches(project){
  project.notches??=[];
  if(!Array.isArray(project.notches)||project.notches.length>3000)throw new Error('刀口关联定义无效');
  const recipeIds=new Set(),outputs=new Set(),byId=new Map(project.entities.map(entity=>[entity.id,entity]));
  for(const recipe of project.notches){
    if(!recipe||typeof recipe.id!=='string'||recipeIds.has(recipe.id)||typeof recipe.name!=='string'||typeof recipe.baseEntityId!=='string'||!Array.isArray(recipe.outputIds)||!recipe.outputIds.length||recipe.outputIds.length>3)throw new Error('刀口关联定义无效');
    Object.assign(recipe,notchSettings(recipe));recipeIds.add(recipe.id);
    for(const id of recipe.outputIds){const entity=byId.get(id);if(outputs.has(id)||!entity||entity.notchFrom!==recipe.id||entity.derivedFrom||entity.closed||entity.type==='text'||entity.curve)throw new Error('刀口输出引用无效');outputs.add(id);}
    const base=byId.get(recipe.baseEntityId);if(base&&(base.type==='text'||base.derivedFrom||base.notchFrom))throw new Error('刀口基准必须是原始线条');
    recipe.signature=null;recipe.status='stale';
  }
  for(const entity of project.entities)if(entity.notchFrom!==undefined&&(!recipeIds.has(entity.notchFrom)||!outputs.has(entity.id)))throw new Error('图元的刀口关联缺失');
  if(project.notches.length)project.version=Math.max(project.version,4);
}
