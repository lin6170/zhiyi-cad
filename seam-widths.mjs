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
  // v67: 反转翻角 and the two vent treatments always take both ends of their edge, as ET records them (end 'both')
  const lengthOf=(value,label)=>{if(!Number.isFinite(value)||value<0||value>1000)throw new Error(label+'须在 0 至 1000 mm 之间');return value;};
  for(const item of corners){
    const both=BOTH_END_KINDS.includes(item?.kind);
    if(!item||typeof item.entityId!=='string'||(baseIds&&!baseIds.includes(item.entityId))||!(both?['both','start','end'].includes(item.end):['start','end'].includes(item.end)))throw new Error('角处理须指明轮廓线和它的哪一端');
    const segmentIndex=item.segmentIndex??null;
    if(segmentIndex!==null&&(!Number.isInteger(segmentIndex)||segmentIndex<0||segmentIndex>20000))throw new Error('角处理的线段序号无效');
    for(const end of both?['start','end']:[item.end]){const key=JSON.stringify([item.entityId,segmentIndex,end]);if(seen.has(key))throw new Error('同一个转角有两种角处理');seen.add(key);}
    const at={entityId:item.entityId,segmentIndex,end:both?'both':item.end};
    if(item.kind==='cut')result.push({...at,kind:'cut',first:size(item.first,'切角距离'),second:size(item.second,'切角距离')});
    else if(item.kind==='step')result.push({...at,kind:'step',drop:size(item.drop,'台阶高度'),run:size(item.run,'台阶宽度')});
    else if(['fold','mitre','sevenStep','foldSquare','doubleExtend','doubleProject'].includes(item.kind))result.push({...at,kind:item.kind});
    else if(item.kind==='foldShift'){if(!Number.isFinite(item.shift)||item.shift<0||item.shift>1000)throw new Error('可调反转的移动量须在 0 至 1000 mm 之间');result.push({...at,kind:'foldShift',shift:item.shift});}
    else if(['square','extendFold','boundFold'].includes(item.kind)){
      // v65: treatments of a corner sewn to a corner of another piece; `partner` is that piece's sewn edge and its end there
      const partner=item.partner;
      if(!partner||typeof partner.entityId!=='string'||!['start','end'].includes(partner.end)||(baseIds&&baseIds.includes(partner.entityId)))throw new Error('这种角处理要说明缝合的另一片上的那条边和它的哪一端');
      const partnerSegment=partner.segmentIndex??null;
      if(partnerSegment!==null&&(!Number.isInteger(partnerSegment)||partnerSegment<0||partnerSegment>20000))throw new Error('角处理的线段序号无效');
      const role=item.role??'first';if(!['first','second'].includes(role)||(item.kind==='extendFold'&&role!=='first'))throw new Error('角处理的先后无效');
      result.push({...at,kind:item.kind,partner:{entityId:partner.entityId,segmentIndex:partnerSegment,end:partner.end},role});
    }
    // v67: the corners of ET's 专用角处理 that v65 left
    // sizes as ET's dialog names them, A to D (mm): 单边直角 A how far the seam line runs on; 曲线断差 A how far the wider seam line runs on
    // and B the length of the change; 反转翻角 A the first fold and B the rest of the hem; 开叉 A to D (see seam-joints.mjs)
    else if(item.kind==='singleSquare')result.push({...at,kind:'singleSquare',a:lengthOf(item.a,'单边直角的 A ')});
    else if(['curveStep1','curveStep2','curveStep3'].includes(item.kind)){
      const a=lengthOf(item.a,'曲线断差的 A '),b=lengthOf(item.b,'曲线断差的 B ');if(!(a+b>0))throw new Error('曲线断差的 A 与 B 不能都为 0');
      result.push({...at,kind:item.kind,a,b});
    }
    else if(item.kind==='turnUp'){
      const a=size(item.a,'反转翻角的 A '),b=size(item.b,'反转翻角的 B ');if(!(b>a))throw new Error('反转翻角的 B 要大于 A（ET 也这样要求）');
      result.push({...at,kind:'turnUp',a,b});
    }
    else if(['ventHalf','ventFull'].includes(item.kind)){
      const a=lengthOf(item.a,'开叉的 A '),b=lengthOf(item.b,'开叉的 B '),c=lengthOf(item.c??0,'开叉的 C '),d=lengthOf(item.d??0,'开叉的 D ');
      if(!(a+b>c))throw new Error('开叉的 A + B 要大于 C');
      result.push({...at,kind:item.kind,a,b,c,d});
    }
    else throw new Error('不认识的角处理');
  }
  return result;
}
/** v67: treatments that take both ends of their edge: 反转翻角 (both ends of a hem) and 开叉半止口, 开叉全止口 (the two ends of a vent). */
export const BOTH_END_KINDS=['turnUp','ventHalf','ventFull'];
/**
 * v66: the extended seam of a recipe (ET's 生成扩展缝边 and 修改扩展缝边线宽度): a second outline `width` outside the seam outline,
 * the edges in `edges` with a width of their own. Null when the recipe has none (ET removes it with width 0).
 */
export function normalizeExtension(extension,baseIds=null){
  if(extension==null)return null;
  if(typeof extension!=='object'||!Number.isFinite(extension.width)||extension.width<=0||extension.width>1000)throw new Error('扩展缝边的宽度须大于 0，且不超过 1000 mm');
  const edges=extension.edges??[];
  if(!Array.isArray(edges)||edges.length>20000)throw new Error('扩展缝边的逐边宽度定义无效');
  const seen=new Set(),result=[];
  for(const entry of edges){
    if(!entry||typeof entry.entityId!=='string'||(baseIds&&!baseIds.includes(entry.entityId))||!Number.isFinite(entry.width)||entry.width<=0||entry.width>1000)throw new Error('扩展缝边的逐边宽度须大于 0，且不超过 1000 mm，边须属于这片的轮廓');
    const segmentIndex=entry.segmentIndex??null;
    if(segmentIndex!==null&&(!Number.isInteger(segmentIndex)||segmentIndex<0||segmentIndex>20000))throw new Error('扩展缝边的线段序号无效');
    const key=edgeKey(entry.entityId,segmentIndex);if(seen.has(key))throw new Error('扩展缝边的逐边宽度引用重复');seen.add(key);
    if(entry.width!==extension.width)result.push({entityId:entry.entityId,segmentIndex,width:entry.width});
  }
  return {width:extension.width,edges:result};
}
/** The extension width of every contour edge (v66), keyed as edgeWidthMap. */
export function extensionWidthMap(project,ids,extension){
  const own=new Map(extension.edges.map(entry=>[edgeKey(entry.entityId,entry.segmentIndex),entry.width]));
  return new Map(seamEdgeDefinitions(project,ids).map(edge=>[edge.key,own.get(edge.key)??extension.width]));
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
