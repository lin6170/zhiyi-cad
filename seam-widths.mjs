export const edgeKey=(entityId,segmentIndex)=>JSON.stringify([entityId,segmentIndex]);
export function seamEdgeDefinitions(project,ids){
  const definitions=[];
  for(const id of ids){
    const entity=project.entities.find(item=>item.id===id);
    if(!entity||entity.type==='text')throw new Error('缝份基准线已缺失');
    if(entity.closed&&!entity.curve){
      for(let index=0;index<entity.points.length;index++)definitions.push({key:edgeKey(id,index),entityId:id,segmentIndex:index,segmentCount:entity.points.length,name:entity.name+' · 第 '+(index+1)+' 边',points:[entity.points[index],entity.points[(index+1)%entity.points.length]]});
    }else definitions.push({key:edgeKey(id,null),entityId:id,segmentIndex:null,segmentCount:null,name:entity.name,points:entity.points});
  }
  return definitions;
}
export function normalizeEdgeWidths(options,baseIds=null){
  const widthMode=options.widthMode??'uniform';
  if(!['uniform','edges'].includes(widthMode))throw new Error('缝份宽度模式无效');
  if(widthMode==='uniform')return {widthMode,edgeWidths:null};
  if(!Array.isArray(options.edgeWidths)||!options.edgeWidths.length||options.edgeWidths.length>20000)throw new Error('逐边宽度定义无效');
  const keys=new Set(),edgeWidths=[];
  for(const entry of options.edgeWidths){
    if(!entry||typeof entry.entityId!=='string'||(baseIds&&!baseIds.includes(entry.entityId))||!Number.isFinite(entry.width)||entry.width<0||entry.width>1e6)throw new Error('逐边宽度须在 0 至 1000000 mm 之间，且属于当前基准');
    if(entry.segmentIndex!==null&&(!Number.isInteger(entry.segmentIndex)||entry.segmentIndex<0||!Number.isInteger(entry.segmentCount)||entry.segmentCount<2||entry.segmentIndex>=entry.segmentCount))throw new Error('逐边线段引用无效');
    if(entry.segmentIndex===null&&entry.segmentCount!=null)throw new Error('曲线边不使用采样段序号');
    const key=edgeKey(entry.entityId,entry.segmentIndex);if(keys.has(key))throw new Error('逐边宽度引用重复');keys.add(key);
    edgeWidths.push({entityId:entry.entityId,segmentIndex:entry.segmentIndex,segmentCount:entry.segmentCount??null,width:entry.width});
  }
  return {widthMode,edgeWidths};
}
/** Corner treatments of a seam recipe: each names a contour edge, one of its ends and what happens at that corner. */
export function normalizeCorners(corners,baseIds=null){
  if(corners==null)return [];
  if(!Array.isArray(corners)||corners.length>2000)throw new Error('角处理定义无效');
  const seen=new Set(),result=[],size=(value,label)=>{if(!Number.isFinite(value)||value<=0||value>1000)throw new Error(label+'须大于 0，且不超过 1000 mm');return value;};
  for(const item of corners){
    if(!item||typeof item.entityId!=='string'||(baseIds&&!baseIds.includes(item.entityId))||!['start','end'].includes(item.end))throw new Error('角处理须指明轮廓线和它的哪一端');
    const segmentIndex=item.segmentIndex??null;
    if(segmentIndex!==null&&(!Number.isInteger(segmentIndex)||segmentIndex<0||segmentIndex>20000))throw new Error('角处理的线段序号无效');
    const key=JSON.stringify([item.entityId,segmentIndex,item.end]);if(seen.has(key))throw new Error('同一个转角有两种角处理');seen.add(key);
    const at={entityId:item.entityId,segmentIndex,end:item.end};
    if(item.kind==='cut')result.push({...at,kind:'cut',first:size(item.first,'切角距离'),second:size(item.second,'切角距离')});
    else if(item.kind==='step')result.push({...at,kind:'step',drop:size(item.drop,'台阶高度'),run:size(item.run,'台阶宽度')});
    else if(item.kind==='fold')result.push({...at,kind:'fold'});
    else throw new Error('不认识的角处理');
  }
  return result;
}
export function edgeWidthMap(project,ids,config){
  const definitions=seamEdgeDefinitions(project,ids);
  if(config.widthMode!=='edges')return new Map(definitions.map(edge=>[edge.key,Math.abs(config.distance)]));
  const normalized=normalizeEdgeWidths(config,ids),map=new Map(normalized.edgeWidths.map(entry=>[edgeKey(entry.entityId,entry.segmentIndex),entry]));
  if(map.size!==definitions.length||definitions.some(edge=>!map.has(edge.key)||map.get(edge.key).segmentCount!==edge.segmentCount))throw new Error('基准分边数量已变化，请重新核对逐边宽度');
  return new Map([...map].map(([key,entry])=>[key,entry.width]));
}
export function seamWidthAt(recipe,base,position){
  if(recipe.widthMode!=='edges')return Math.abs(recipe.distance);
  let index=null;
  if(base.closed&&!base.curve){
    let sum=0;
    for(let i=0;i<base.points.length;i++){
      const a=base.points[i],b=base.points[(i+1)%base.points.length],length=Math.hypot(b.x-a.x,b.y-a.y);
      if(length>1e-10&&position<=sum+length+1e-7){index=i;break;}sum+=length;
    }
  }
  const entry=recipe.edgeWidths?.find(item=>item.entityId===base.id&&item.segmentIndex===index);
  if(!entry)throw new Error('刀口位置的逐边缝份定义缺失');
  return entry.width;
}
