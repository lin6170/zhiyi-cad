import Clipper from './vendor/clipper.mjs';
import { distance } from './geometry.mjs';
import { sampleCurve } from './curves.mjs';
import { contoursForGroup, orientChain } from './topology.mjs';
import { assertNotchTransform } from './notches.mjs';
import { normalizeEdgeWidths, normalizeCorners, edgeWidthMap, edgeKey } from './seam-widths.mjs';
import { cutCorner, stepCorner, foldCorner } from './seam-corners.mjs';
import { variableOffset } from './variable-offset.mjs';
import { assertSimplePolygon } from './polygon.mjs';
export { assertSimplePolygon } from './polygon.mjs';

const GRID = 1000, JOINT_SNAP = .005;
const defaults = { distance:10, join:'miter', miterLimit:2, gapTolerance:.1, curveTolerance:.01, arcTolerance:.01 };
export function seamBases(project, selected) {
  const entity=selected.size===1?project.entities.find(item=>selected.has(item.id)):null;
  if(entity?.derivedFrom){
    const recipe=(project.seamAllowances||[]).find(item=>item.id===entity.derivedFrom);
    return recipe?[{key:'recipe-'+recipe.id,name:recipe.basisLabel,entityIds:[...recipe.baseEntityIds],recipeId:recipe.id}]:[];
  }
  const group=(project.groups||[]).find(item=>item.entityIds.length===selected.size&&item.entityIds.every(id=>selected.has(id)));
  if(group){
    const contours=contoursForGroup(group).filter(item=>item.entityIds.length);
    if(contours.length)return contours.map((item,i)=>({key:group.id+'-'+i,name:group.name+' · '+(item.role==='primary-contour'?'主轮廓':'额外轮廓 '+i),entityIds:[...item.entityIds],groupId:group.id}));
    return project.entities.filter(item=>group.entityIds.includes(item.id)&&item.closed&&item.type!=='text'&&!item.derivedFrom).map(item=>({key:item.id,name:item.name,entityIds:[item.id],groupId:group.id}));
  }
  return entity?.closed&&entity.type!=='text'?[{key:entity.id,name:entity.name,entityIds:[entity.id]}]:[];
}

function settings(options) {
  const result=Object.fromEntries(Object.keys(defaults).map(key=>[key,options[key]??defaults[key]]));
  if(!Number.isFinite(result.distance)||Math.abs(result.distance)<.001||Math.abs(result.distance)>1e6)throw new Error('偏移宽度须在 0.001 至 1000000 mm 之间');
  if(!['miter','round','square'].includes(result.join))throw new Error('不支持的转角方式');
  if(!Number.isFinite(result.miterLimit)||result.miterLimit<2||result.miterLimit>20)throw new Error('尖角限长须在 2 至 20 倍之间');
  if(!Number.isFinite(result.gapTolerance)||result.gapTolerance<0||result.gapTolerance>10)throw new Error('端点连接容差须在 0 至 10 mm 之间');
  for(const field of ['curveTolerance','arcTolerance'])if(!Number.isFinite(result[field])||result[field]<.001||result[field]>.5)throw new Error('曲线计算容差超出范围');
  Object.assign(result,normalizeEdgeWidths(options));
  const corners=normalizeCorners(options.corners);
  if(corners.length){
    if(result.distance<0)throw new Error('向内的偏移不能做角处理');
    if(result.join!=='miter')throw new Error('做了角处理的缝份只能用尖角；要改成圆角或方角，请先把角处理恢复成普通转角');
    result.corners=corners;
  }
  return result;
}
/**
 * The seam shape at every treated corner (cut, step, fold-back), in millimetres. `ordered` is the contour as
 * orientChain returns it; widths come per edge. The contour is turned counter-clockwise first, as seam-corners expects.
 */
function cornerShapes(ordered,widthMap,corners){
  let edges=[];
  for(const item of ordered){
    const n=item.points.length;
    if(item.entity.closed&&!item.entity.curve)for(let j=0;j<n;j++){const index=item.reversed?(n-2-j+n)%n:j;edges.push({entityId:item.entity.id,segmentIndex:index,points:[item.points[j],item.points[(j+1)%n]],reversed:item.reversed,width:widthMap.get(edgeKey(item.entity.id,index))});}
    else edges.push({entityId:item.entity.id,segmentIndex:null,points:item.points,reversed:item.reversed,width:widthMap.get(edgeKey(item.entity.id,null))});
  }
  let twice=0;const all=edges.flatMap(edge=>edge.points);
  for(let i=0;i<all.length;i++){const a=all[i],b=all[(i+1)%all.length];twice+=a.x*b.y-a.y*b.x;}
  if(twice<0)edges=edges.reverse().map(edge=>({...edge,points:[...edge.points].reverse(),reversed:!edge.reversed}));
  const count=edges.length,unit=(a,b)=>{const d=Math.hypot(b.x-a.x,b.y-a.y);if(!(d>1e-9))throw new Error('轮廓线在转角处长度为零');return {x:(b.x-a.x)/d,y:(b.y-a.y)/d};},right=t=>({x:t.y,y:-t.x});
  // the seam line of a curved edge as points that start at one of its corners; null for a straight edge
  const seamPath=(edge,fromStart)=>{
    if(edge.points.length<3)return null;
    const pts=edge.points,last=pts.length-1,path=pts.map((p,i)=>{const n=right(unit(pts[Math.max(i-1,0)],pts[Math.min(i+1,last)]));return {x:p.x+n.x*edge.width,y:p.y+n.y*edge.width};});
    return fromStart?path:path.reverse();
  };
  const shapes=[],taken=new Set();
  for(const item of corners){
    const k=edges.findIndex(edge=>edge.entityId===item.entityId&&edge.segmentIndex===item.segmentIndex);
    if(k<0)throw new Error('角处理引用的边已不在轮廓上，请重新设置角处理');
    const arrives=(item.end==='end')!==edges[k].reversed,v=arrives?k:(k+count-1)%count,first=edges[v],second=edges[(v+1)%count];
    if(taken.has(v))throw new Error('同一个转角有两种角处理');taken.add(v);
    const vertex=first.points.at(-1),arriving={tangent:unit(first.points.at(-2),first.points.at(-1)),width:first.width},leaving={tangent:unit(second.points[0],second.points[1]),width:second.width};
    const shape=item.kind==='cut'?cutCorner(vertex,arriving,leaving,{arrivingCut:arrives?item.first:item.second,leavingCut:arrives?item.second:item.first})
      :item.kind==='step'?stepCorner(vertex,arriving,leaving,{side:arrives?'arriving':'leaving',drop:item.drop,run:item.run})
      :foldCorner(vertex,arriving,leaving,{fold:arrives?'arriving':'leaving',sidePath:arrives?seamPath(second,true):seamPath(first,false)});
    shapes.push({...shape,vertex,alongArriving:arriving.tangent,alongLeaving:leaving.tangent,outArriving:right(arriving.tangent),outLeaving:right(leaving.tangent)});
  }
  return shapes;
}
/** Replace the plain corner of the seam outline by the treated shape: cut away what lies beyond it, or add what it adds. */
function applyCornerShapes(solution,shapes,origin){
  const grid=p=>({X:Math.round((p.x-origin.x)*GRID),Y:Math.round((p.y-origin.y)*GRID)}),move=(p,n,f)=>({x:p.x+n.x*f,y:p.y+n.y*f}),MARGIN=.02;
  let current=solution;
  for(const shape of shapes){
    const path=[shape.end];
    for(const piece of shape.pieces)for(const p of piece.points)if(Math.hypot(p.x-path.at(-1).x,p.y-path.at(-1).y)>1e-6)path.push(p);
    if(Math.hypot(shape.start.x-path.at(-1).x,shape.start.y-path.at(-1).y)>1e-6)path.push(shape.start);
    if(path.length<2)continue;
    const loop=[...path,shape.tip];let twice=0;
    for(let i=0;i<loop.length;i++){const a=loop[i],b=loop[(i+1)%loop.length];twice+=a.x*b.y-a.y*b.x;}
    if(Math.abs(twice)<1e-9)continue;
    // A negative loop lies inside the plain seam and is cut away, with a margin beyond the two seam lines so that nothing thin
    // is left. A positive one is added. One of its ends lies on the plain outline, the other beyond the old tip; next to the
    // end on the outline the added area reaches in to the corner of the net outline, so the two overlap instead of touching.
    const endOnOutline=(shape.tip.x-shape.end.x)*shape.alongArriving.x+(shape.tip.y-shape.end.y)*shape.alongArriving.y>=-1e-9;
    const startOnOutline=(shape.start.x-shape.tip.x)*shape.alongLeaving.x+(shape.start.y-shape.tip.y)*shape.alongLeaving.y>=-1e-9;
    const added=endOnOutline&&!startOnOutline?[...path,shape.tip,shape.vertex]:startOnOutline&&!endOnOutline?[...path,shape.vertex,shape.tip]:[...path,shape.tip];
    const polygon=(twice<0?[...path,move(shape.start,shape.outLeaving,MARGIN),move(move(shape.tip,shape.outArriving,MARGIN),shape.outLeaving,MARGIN),move(shape.end,shape.outArriving,MARGIN)]:added).map(grid);
    const clipper=new Clipper.Clipper(),next=[];
    clipper.AddPaths(current,Clipper.PolyType.ptSubject,true);clipper.AddPath(polygon,Clipper.PolyType.ptClip,true);
    clipper.Execute(twice<0?Clipper.ClipType.ctDifference:Clipper.ClipType.ctUnion,next,Clipper.PolyFillType.pftNonZero,Clipper.PolyFillType.pftNonZero);
    current=next.map(p=>Clipper.Clipper.CleanPolygon(p,Math.SQRT2)).filter(p=>p.length>=3);
  }
  return current;
}
function signedArea(path) {
  let sum=0n;
  for(let i=0;i<path.length;i++){const a=path[i],b=path[(i+1)%path.length];sum+=BigInt(a.X)*BigInt(b.Y)-BigInt(a.Y)*BigInt(b.X);}
  return Number(sum)/2;
}
export function generateAllowance(project, baseEntityIds, options={}) {
  if(project.units!=='mm')throw new Error('请先校准毫米单位，再生成缝份');
  const config=settings(options),byId=new Map(project.entities.map(entity=>[entity.id,entity]));
  if(!Array.isArray(baseEntityIds)||!baseEntityIds.length||new Set(baseEntityIds).size!==baseEntityIds.length)throw new Error('缝份基准引用无效');
  const entities=baseEntityIds.map(id=>{
    const entity=byId.get(id);
    if(!entity||entity.type==='text')throw new Error('缝份基准线已缺失');
    if(entity.derivedFrom||entity.notchFrom)throw new Error('不能以关联输出作为新的缝份基准，请先解除关联');
    if(entity.curve){const sampled=sampleCurve({...entity.curve,samplingTolerance:config.curveTolerance});if(sampled.capped)throw new Error('基准曲线采样达到上限');return {...entity,points:sampled.points};}
    return entity;
  });
  if(entities.length>1&&entities.some(entity=>entity.closed))throw new Error('请单独选择闭合轮廓');
  if(entities.length===1&&!entities[0].closed)throw new Error('基准必须是闭合轮廓或已定义的多曲线轮廓链');
  const widthMap=edgeWidthMap(project,baseEntityIds,config),ordered=orientChain(entities),points=[],pointWidths=[],bridges=[];
  for(let i=0;i<ordered.length;i++){
    const item=ordered[i],next=ordered[(i+1)%ordered.length];
    points.push(...item.points);
    for(let j=0;j<item.points.length;j++){
      const n=item.points.length,index=item.entity.closed&&!item.entity.curve?(item.reversed?(n-2-j+n)%n:j):null;
      let width=widthMap.get(edgeKey(item.entity.id,index));
      if(j===n-1&&!(ordered.length===1&&item.entity.closed))width=Math.min(width,widthMap.get(edgeKey(next.entity.id,null)));
      pointWidths.push(width);
    }
    if(!(ordered.length===1&&item.entity.closed)){
      const a=item.points.at(-1),b=next.points[0],gap=distance(a,b);
      if(gap>config.gapTolerance)throw new Error('轮廓端点间隙 '+gap.toFixed(4)+' mm 超出连接容差');
      if(gap>1e-9)bridges.push({start:{...a},end:{...b},distance:gap});
      // Ends that miss each other by less than the calculation grid can resolve are one corner: the next edge starts there.
      // Kept as two points they would make an edge of about a thousandth of a millimetre in an arbitrary direction.
      if(gap>0&&gap<=JOINT_SNAP&&item.points.length>1){points.pop();pointWidths.pop();}
    }
  }
  if(points.length>20000)throw new Error('基准节点超过本次计算上限');
  const origin={...points[0]},path=[],widths=[];
  for(let i=0;i<points.length;i++){
    const point=points[i];
    if(!Number.isFinite(point.x)||!Number.isFinite(point.y)||Math.abs(point.x)>1e8||Math.abs(point.y)>1e8)throw new Error('基准坐标超出范围');
    const q={X:Math.round((point.x-origin.x)*GRID),Y:Math.round((point.y-origin.y)*GRID)};
    if(!path.length||q.X!==path.at(-1).X||q.Y!==path.at(-1).Y){path.push(q);widths.push(pointWidths[i]);}
    else widths[widths.length-1]=pointWidths[i];
  }
  if(path.length>1&&path[0].X===path.at(-1).X&&path[0].Y===path.at(-1).Y){path.pop();widths.pop();}
  if(path.length<3)throw new Error('基准轮廓在 0.001 mm 网格上退化');
  assertSimplePolygon(path);
  let area=signedArea(path);if(!area)throw new Error('基准轮廓面积为零');
  if(area<0){const old=[...widths];path.reverse();for(let i=0;i<widths.length;i++)widths[i]=old[(old.length-2-i+old.length)%old.length];}
  const sameWidth=widths.every(width=>width===widths[0]),clean=config.widthMode==='edges'?path:Clipper.Clipper.CleanPolygon(path,.5);
  let solution=[];
  if(config.widthMode==='edges'&&!sameWidth)solution=variableOffset(path,widths.map(width=>width*GRID),Math.sign(config.distance),{...config,arcTolerance:config.arcTolerance*GRID});
  else{
    const offset=new Clipper.ClipperOffset(config.miterLimit,config.arcTolerance*GRID);
    offset.AddPath(clean,Clipper.JoinType[{miter:'jtMiter',round:'jtRound',square:'jtSquare'}[config.join]],Clipper.EndType.etClosedPolygon);
    offset.Execute(solution,(config.widthMode==='edges'?widths[0]*Math.sign(config.distance):config.distance)*GRID);
  }
  let discardedFragments=0;
  if(config.widthMode==='edges'&&!sameWidth){
    solution=solution.map(path=>Clipper.Clipper.CleanPolygon(path,Math.SQRT2)).filter(path=>{const valid=path.length>=3&&signedArea(path)!==0;if(!valid)discardedFragments++;return valid;});
  }
  if(!solution.length)throw new Error('偏移后轮廓消失，请减小宽度');
  if(config.corners){solution=applyCornerShapes(solution,cornerShapes(ordered,widthMap,config.corners),origin);if(!solution.length)throw new Error('角处理后缝份轮廓消失');}
  const paths=solution.map(path=>{
    const area=signedArea(path);return {role:area<0?'hole':'outer',area:Math.abs(area)/(GRID*GRID),points:path.map(point=>({x:origin.x+point.X/GRID,y:origin.y+point.Y/GRID}))};
  }).sort((a,b)=>a.role===b.role?b.area-a.area:a.role==='outer'?-1:1);
  if(paths.flatMap(path=>path.points).some(point=>Math.abs(point.x)>1e8||Math.abs(point.y)>1e8))throw new Error('缝份坐标超出工程范围');
  return {config,paths,basePoints:clean.map(point=>({x:origin.x+point.X/GRID,y:origin.y+point.Y/GRID})),bridges,maxGap:bridges.reduce((n,b)=>Math.max(n,b.distance),0),area:Math.abs(area)/(GRID*GRID),grid:.001,cleanupTolerance:config.widthMode==='edges'&&!sameWidth?Math.SQRT2/GRID:0,discardedFragments};
}

function signature(project,recipe){
  const byId=new Map(project.entities.map(entity=>[entity.id,entity]));
  return JSON.stringify([project.units,settings(recipe),recipe.baseEntityIds.map(id=>{const e=byId.get(id);return e?[id,e.closed,e.curve||e.points,e.derivedFrom,e.notchFrom]:[id,null];})]);
}
export function syncAllowances(project,makeId) {
  for(const recipe of project.seamAllowances||[]){
    let current;
    try{
      current=signature(project,recipe);
      if(recipe.signature===current&&['current','error'].includes(recipe.status))continue;
      const generated=generateAllowance(project,recipe.baseEntityIds,recipe),oldIds=[...recipe.outputIds];
      const outputs=generated.paths.map((path,index)=>{
        const old=project.entities.find(entity=>entity.id===oldIds[index]);
        return {...old,id:old?.id||makeId(),type:'polyline',name:old?.name||(recipe.name+(path.role==='hole'?' · 内孔':'')+(index?' '+(index+1):'')),layer:old?.layer||'seam',closed:true,points:path.points,derivedFrom:recipe.id,seamRole:path.role};
      });
      project.entities=project.entities.filter(entity=>!oldIds.includes(entity.id)).concat(outputs);
      recipe.outputIds=outputs.map(entity=>entity.id);
      const target=(project.groups||[]).find(group=>recipe.baseEntityIds.every(id=>group.entityIds.includes(id)))||(project.groups||[]).find(group=>group.entityIds.includes(oldIds[0]));
      for(const group of project.groups||[])group.entityIds=group.entityIds.filter(id=>!oldIds.includes(id)||recipe.outputIds.includes(id));
      if(target)target.entityIds.push(...recipe.outputIds.filter(id=>!oldIds.includes(id)));
      project.groups=(project.groups||[]).filter(group=>group.entityIds.length>=2);
      recipe.signature=current;recipe.status='current';delete recipe.error;
      recipe.maxGap=generated.maxGap;recipe.bridgeCount=generated.bridges.length;
      recipe.discardedFragments=generated.discardedFragments;recipe.cleanupTolerance=generated.cleanupTolerance;
    }catch(error){recipe.signature=current??null;recipe.status='error';recipe.error=error.message;}
  }
}
export function applyAllowance(project,base,options,makeId) {
  const generated=generateAllowance(project,base.entityIds,options);
  project.seamAllowances??=[];
  let recipe=project.seamAllowances.find(item=>item.id===base.recipeId)||project.seamAllowances.find(item=>JSON.stringify(item.baseEntityIds)===JSON.stringify(base.entityIds));
  const isNew=!recipe;
  let group=(project.groups||[]).find(group=>base.entityIds.every(id=>group.entityIds.includes(id)));
  if(isNew&&!group&&(project.groups||[]).some(group=>base.entityIds.some(id=>group.entityIds.includes(id))))throw new Error('基准线分属不同组合，请先整理组合');
  if(!recipe){recipe={id:makeId(),name:base.name+' · 缝份',basisLabel:base.name,baseEntityIds:[...base.entityIds],outputIds:[]};project.seamAllowances.push(recipe);}
  Object.assign(recipe,generated.config,{signature:null,status:'stale'});
  if(!generated.config.corners)delete recipe.corners;
  syncAllowances(project,makeId);
  if(recipe.status!=='current')throw new Error(recipe.error);
  if(isNew){
    group=(project.groups||[]).find(item=>item.id===group?.id);
    if(!group){group={id:makeId(),name:base.name,entityIds:[...base.entityIds],contours:[{role:'primary-contour',entityIds:[...base.entityIds]}],source:{kind:'manual'}};project.groups.push(group);}
    group.entityIds=[...new Set([...group.entityIds,...recipe.outputIds])];
    if(group.source?.format==='ET PRJ')group.source={...group.source,membershipModified:true};
  }
  project.version=Math.max(project.version,3);
  if(recipe.widthMode==='edges')project.version=Math.max(project.version,5);
  return recipe;
}
export function detachAllowance(project,recipeId){
  for(const entity of project.entities)if(entity.derivedFrom===recipeId){delete entity.derivedFrom;delete entity.seamRole;}
  project.seamAllowances=(project.seamAllowances||[]).filter(recipe=>recipe.id!==recipeId);
}
export function assertIndependentTransform(project,ids){
  assertNotchTransform(project,ids);
  for(const recipe of project.seamAllowances||[])if(recipe.outputIds.some(id=>ids.has(id))&&!recipe.baseEntityIds.every(id=>ids.has(id)))throw new Error('关联缝份随基准变化。单独编辑前请先解除关联。');
}
