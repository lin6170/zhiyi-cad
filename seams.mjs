import Clipper from './vendor/clipper.mjs';
import { distance } from './geometry.mjs';
import { sampleCurve } from './curves.mjs';
import { nativeFitPoints } from './fit-spline.mjs';
import { contoursForGroup, orientChain } from './topology.mjs';
import { assertNotchTransform } from './notches.mjs';
import { normalizeEdgeWidths, normalizeCorners, normalizeExtension, extensionWidthMap, edgeWidthMap, edgeKey } from './seam-widths.mjs';
import { cutCorner, stepCorner, foldCorner, mitreCorner, squareCorner, sewnReach, lineCorner, boundFoldLine, sewingMap, crossingSeam, specialCorner, singleSquareCorner, turnUpCorner, MITRE_GAP_MM, PAIR_KINDS } from './seam-corners.mjs';
import { jointShape, ventShape, JOINT_KINDS, VENT_KINDS } from './seam-joints.mjs';
import { SMOOTH_JOINT_COS } from './variable-offset.mjs';
import { variableOffset } from './variable-offset.mjs';
import { assertSimplePolygon } from './polygon.mjs';
import { syncMirrorLinks } from './mirror-links.mjs';
export { assertSimplePolygon } from './polygon.mjs';

const GRID = 1000, JOINT_SNAP = .005;
// A sharp corner keeps its point, as in ET, where the two seam lines are carried on until they meet (checked with triangles from
// 25 to 75 degrees). The limit only stops needles: corners sharper than about 6 degrees.
export const SHARP_CORNER_LIMIT = 20;
const defaults = { distance:10, join:'miter', miterLimit:SHARP_CORNER_LIMIT, gapTolerance:.1, curveTolerance:.01, arcTolerance:.01 };
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
  const extension=normalizeExtension(options.extension);
  if(extension){if(result.distance<0)throw new Error('向内的偏移不能加扩展缝边');result.extension=extension;}
  return result;
}
/** The contour as cornerShapes walks it: edges counter-clockwise, each with its points, the entity and segment it comes from and its width. */
function orderedEdges(ordered,widthMap){
  let edges=[];
  for(const item of ordered){
    const n=item.points.length;
    if(item.entity.closed&&!item.entity.curve)for(let j=0;j<n;j++){const index=item.reversed?(n-2-j+n)%n:j;edges.push({entityId:item.entity.id,segmentIndex:index,points:[item.points[j],item.points[(j+1)%n]],reversed:item.reversed,width:widthMap.get(edgeKey(item.entity.id,index))});}
    else edges.push({entityId:item.entity.id,segmentIndex:null,points:item.points,reversed:item.reversed,width:widthMap.get(edgeKey(item.entity.id,null))});
  }
  let twice=0;const all=edges.flatMap(edge=>edge.points);
  for(let i=0;i<all.length;i++){const a=all[i],b=all[(i+1)%all.length];twice+=a.x*b.y-a.y*b.x;}
  if(twice<0)edges=edges.reverse().map(edge=>({...edge,points:[...edge.points].reverse(),reversed:!edge.reversed}));
  return edges;
}
const unitOf=(a,b)=>{const d=Math.hypot(b.x-a.x,b.y-a.y);if(!(d>1e-9))throw new Error('轮廓线在转角处长度为零');return {x:(b.x-a.x)/d,y:(b.y-a.y)/d};},rightOf=t=>({x:t.y,y:-t.x});
/** The corner at one end of a contour edge: the edge that arrives there, the one that leaves, and whether the given edge arrives. */
function frameAt(edges,entityId,segmentIndex,end){
  const count=edges.length,k=edges.findIndex(edge=>edge.entityId===entityId&&edge.segmentIndex===(segmentIndex??null));
  if(k<0)throw new Error('角处理引用的边已不在轮廓上，请重新设置角处理');
  const arrives=(end==='end')!==edges[k].reversed,v=arrives?k:(k+count-1)%count,first=edges[v],second=edges[(v+1)%count];
  return {v,arrives,first,second,vertex:first.points.at(-1),arriving:{tangent:unitOf(first.points.at(-2),first.points.at(-1)),width:first.width},leaving:{tangent:unitOf(second.points[0],second.points[1]),width:second.width}};
}
function sampledBases(project,baseEntityIds,config){
  const byId=new Map(project.entities.map(entity=>[entity.id,entity]));
  return baseEntityIds.map(id=>{
    const entity=byId.get(id);
    if(!entity||entity.type==='text')throw new Error('缝份基准线已缺失');
    if(entity.curve){const sampled=sampleCurve({...entity.curve,samplingTolerance:config.curveTolerance});if(sampled.capped)throw new Error('基准曲线采样达到上限');return {...entity,points:sampled.points};}
    return entity;
  });
}
/** The corner of the piece a pair treatment is sewn to, from that piece's own seam recipe (v65: 直角, 延长反转角, 包边延长反转角). */
function partnerFrame(project,partner){
  const recipe=(project.seamAllowances||[]).find(item=>item.baseEntityIds.includes(partner.entityId));
  if(!recipe)throw new Error('缝合的另一片还没有缝份，请先给它加缝份');
  const config=settings({...recipe,corners:null});
  return frameAt(orderedEdges(orientChain(sampledBases(project,recipe.baseEntityIds,config)),edgeWidthMap(project,recipe.baseEntityIds,config)),partner.entityId,partner.segmentIndex??null,partner.end);
}
/** v66: the contour edges of a recipe counter-clockwise, as the seam is built: each with its points (curves sampled), entity, segment and width. */
export function seamContourEdges(project,recipe){
  const config=settings({...recipe,corners:null,extension:null});
  return orderedEdges(orientChain(sampledBases(project,recipe.baseEntityIds,config)),edgeWidthMap(project,recipe.baseEntityIds,config));
}
/** What a pair treatment of this recipe depends on in the other piece, for the signature that decides when a seam is rebuilt. */
function partnerSignature(project,recipe){
  const pairs=(recipe.corners||[]).filter(item=>PAIR_KINDS.includes(item.kind));if(!pairs.length)return null;
  const byId=new Map(project.entities.map(entity=>[entity.id,entity]));
  return pairs.map(item=>{const other=(project.seamAllowances||[]).find(r=>r.baseEntityIds.includes(item.partner.entityId));
    return other?[other.distance,other.widthMode,other.edgeWidths,other.baseEntityIds.map(id=>{const e=byId.get(id);return e?[e.curve||e.points,e.closed]:null;})]:null;});
}
/**
 * The seam shape at every treated corner, in millimetres. `ordered` is the contour as orientChain returns it; widths come per edge.
 * The contour is turned counter-clockwise first, as seam-corners expects. Pair treatments look up the corner they are sewn to.
 */
function cornerShapes(ordered,widthMap,corners,project){
  const edges=orderedEdges(ordered,widthMap),count=edges.length;
  // the seam line of a curved edge as points that start at one of its corners; null for a straight edge
  const seamPath=(edge,fromStart)=>{
    if(edge.points.length<3)return null;
    const pts=edge.points,last=pts.length-1,path=pts.map((p,i)=>{const n=rightOf(unitOf(pts[Math.max(i-1,0)],pts[Math.min(i+1,last)]));return {x:p.x+n.x*edge.width,y:p.y+n.y*edge.width};});
    return fromStart?path:path.reverse();
  };
  // where the seam lines of two edges meet at the corner after edge a, as the plain outline has it
  const plainTip=(a,b)=>{const t1=unitOf(a.points.at(-2),a.points.at(-1)),t2=unitOf(b.points[0],b.points[1]),p=a.points.at(-1),A={x:p.x+rightOf(t1).x*a.width,y:p.y+rightOf(t1).y*a.width},B={x:p.x+rightOf(t2).x*b.width,y:p.y+rightOf(t2).y*b.width},den=t1.x*t2.y-t1.y*t2.x;
    if(Math.abs(den)<1e-9)return {x:(A.x+B.x)/2,y:(A.y+B.y)/2};const f=((B.x-A.x)*t2.y-(B.y-A.y)*t2.x)/den;return {x:A.x+t1.x*f,y:A.y+t1.y*f};};
  const shapes=[],taken=new Set();
  const cornerFrame=v=>{const first=edges[v],second=edges[(v+1)%count];return {v,first,second,vertex:first.points.at(-1),arriving:{tangent:unitOf(first.points.at(-2),first.points.at(-1)),width:first.width},leaving:{tangent:unitOf(second.points[0],second.points[1]),width:second.width}};};
  const smooth=f=>f.arriving.tangent.x*f.leaving.tangent.x+f.arriving.tangent.y*f.leaving.tangent.y>SMOOTH_JOINT_COS&&Math.abs(f.first.width-f.second.width)>1e-6;
  // v67: a smooth joint seen from its wider edge: that edge running into the narrower side, and the narrower edge from the joint on
  const jointSides=f=>f.first.width>f.second.width
    ?{wide:{tangent:f.arriving.tangent,normal:rightOf(f.arriving.tangent),width:f.first.width,points:[...f.first.points].reverse()},narrow:{points:f.second.points,outwardSign:1,width:f.second.width}}
    :{wide:{tangent:{x:-f.leaving.tangent.x,y:-f.leaving.tangent.y},normal:rightOf(f.leaving.tangent),width:f.second.width,points:f.second.points},narrow:{points:[...f.first.points].reverse(),outwardSign:-1,width:f.first.width}};
  const keep=(v,shape)=>{if(taken.has(v))throw new Error('同一个转角有两种角处理');taken.add(v);shapes.push(shape);};
  for(const item of corners){
    if(item.kind==='turnUp'||VENT_KINDS.includes(item.kind)){
      const k=edges.findIndex(edge=>edge.entityId===item.entityId&&edge.segmentIndex===(item.segmentIndex??null));
      if(k<0)throw new Error('角处理引用的边已不在轮廓上，请重新设置角处理');
      const atEnd=cornerFrame(k),atStart=cornerFrame((k+count-1)%count);
      if(item.kind==='turnUp'){
        // 反转翻角: both ends of the hem; ET takes it only when A + B is the hem's width
        if(Math.abs(item.a+item.b-edges[k].width)>.01)throw new Error('反转翻角的 A + B 要等于下摆的缝份宽度 '+edges[k].width+' mm（ET 也这样要求）');
        for(const [f,hem] of [[atStart,'leaving'],[atEnd,'arriving']]){
          const shape=turnUpCorner(f.vertex,f.arriving,f.leaving,{hem,depth:item.a,rest:item.b});
          keep(f.v,{...shape,v:f.v,vertex:f.vertex,alongArriving:f.arriving.tangent,alongLeaving:f.leaving.tangent,outArriving:rightOf(f.arriving.tangent),outLeaving:rightOf(f.leaving.tangent)});
        }
      }else{
        // 开叉: one end of the vent edge is a smooth joint where it is the wider edge, the other its hem corner
        const top=[atEnd,atStart].find(f=>smooth(f)&&(f===atEnd?f.first:f.second).width>(f===atEnd?f.second:f.first).width);
        if(!top)throw new Error('开叉要做在比相接的边缝份宽、与它接近相切的边上（例如开衩的边）');
        const hemFrame=top===atEnd?atStart:atEnd,{wide,narrow}=jointSides(top),hemEdge=top===atEnd?hemFrame.first:hemFrame.second;
        const hemTangent=top===atEnd?hemFrame.arriving.tangent:hemFrame.leaving.tangent,hemCorner=hemFrame.vertex;
        const ventEntity=ordered.find(item=>item.entity.id===edges[k].entityId)?.entity,ventFit=ventEntity?.curve?nativeFitPoints(ventEntity.curve):null;   // v75: a curved vent is mirrored from its fit points, as ET does
        const vent={...wide,points:top===atEnd?[...edges[k].points].reverse():edges[k].points,...(ventFit&&ventFit.length>2?{fit:ventFit}:{})};
        const made=ventShape(item.kind,top.vertex,vent,narrow,{seamPoint:{x:hemCorner.x+rightOf(hemTangent).x*hemEdge.width,y:hemCorner.y+rightOf(hemTangent).y*hemEdge.width},tangent:hemTangent},item);
        keep(top.v,{region:made.region,cut:made.zone,lines:[{points:made.foldLine,dashed:true},...made.lines],v:top.v,vertex:top.vertex});
        if(taken.has(hemFrame.v))throw new Error('同一个转角有两种角处理');taken.add(hemFrame.v);
      }
      continue;
    }
    if(JOINT_KINDS.includes(item.kind)||item.kind==='singleSquare'){
      const {v,arrives,first,second,vertex,arriving,leaving}=frameAt(edges,item.entityId,item.segmentIndex,item.end),f={v,first,second,vertex,arriving,leaving};
      if(smooth(f)){
        const {wide,narrow}=jointSides(f),made=jointShape(item.kind,vertex,wide,narrow,{extend:item.a,run:item.b??0});
        keep(v,{region:made.region,v,vertex});
      }else if(item.kind==='singleSquare'){
        const shape=singleSquareCorner(vertex,arriving,leaving,{picked:arrives?'arriving':'leaving',size:item.a});
        // cut the plain tip off only when the square line's two ends lie on the parts of the seam lines the plain outline has; else add,
        // as the bare triangle when it meets the other seam line beyond the tip or past the far end of that edge (ET draws that spike)
        const p=arrives?arriving:leaving,o=arrives?leaving:arriving,up=arrives?p.tangent:{x:-p.tangent.x,y:-p.tangent.y},uo=arrives?{x:-o.tangent.x,y:-o.tangent.y}:o.tangent;
        const past=arrives?shape.end:shape.start,met=arrives?shape.start:shape.end,along2=(a,b,u)=>(a.x-b.x)*u.x+(a.y-b.y)*u.y;
        const otherEdge=arrives?second:first,otherLength=otherEdge.points.slice(1).reduce((sum,q,i)=>sum+Math.hypot(q.x-otherEdge.points[i].x,q.y-otherEdge.points[i].y),0);
        const pastOut=along2(past,shape.tip,up)>1e-6,metOut=along2(met,shape.tip,uo)>1e-6,metFar=along2(met,vertex,{x:-uo.x,y:-uo.y})>otherLength;
        keep(v,{...shape,mode:pastOut||metOut?'add':'cut',bare:metOut||metFar,v,vertex,alongArriving:arriving.tangent,alongLeaving:leaving.tangent,outArriving:rightOf(arriving.tangent),outLeaving:rightOf(leaving.tangent)});
      }else throw new Error('曲线断差要做在缝份宽度不同、接近相切（转折不到 15 度）的两条边之间');
      continue;
    }
    const {v,arrives,first,second,vertex,arriving,leaving}=frameAt(edges,item.entityId,item.segmentIndex,item.end);
    if(taken.has(v))throw new Error('同一个转角有两种角处理');taken.add(v);
    const role=arrives?'arriving':'leaving';let shape;
    if(item.kind==='cut')shape=cutCorner(vertex,arriving,leaving,{arrivingCut:arrives?item.first:item.second,leavingCut:arrives?item.second:item.first,owner:role});
    else if(item.kind==='step')shape=stepCorner(vertex,arriving,leaving,{side:role,drop:item.drop,run:item.run});
    else if(item.kind==='fold')shape=foldCorner(vertex,arriving,leaving,{fold:role,sidePath:arrives?seamPath(second,true):seamPath(first,false)});
    else if(item.kind==='mitre')shape=mitreCorner(vertex,arriving,leaving,{gap:MITRE_GAP_MM});
    else if(item.kind==='square'){
      const other=partnerFrame(project,item.partner),reach=Math.max(sewnReach(vertex,arriving,leaving,{sewn:role}),sewnReach(other.vertex,other.arriving,other.leaving,{sewn:other.arrives?'arriving':'leaving'}));
      shape=squareCorner(vertex,arriving,leaving,{sewn:role,reach});
      if(shape.outside){
        // this piece reaches less far than its partner: the crossing seam line is drawn again to Q, from its far corner on a straight
        // edge (as ET does), from the foot of the square from Q on a curved one
        const crossing=arrives?second:first,Q=arrives?shape.start:shape.end,B=arrives?shape.end:shape.start;let base,between=[];
        if(crossing.points.length<3)base=arrives?plainTip(second,edges[(v+2)%count]):plainTip(edges[(v+count-1)%count],first);
        else{
          const path=seamPath(crossing,arrives);let best=Infinity,bi=1,bp=path[0];
          for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i],dx=b.x-a.x,dy=b.y-a.y,q=dx*dx+dy*dy,t=q?Math.max(0,Math.min(1,((Q.x-a.x)*dx+(Q.y-a.y)*dy)/q)):0,p={x:a.x+t*dx,y:a.y+t*dy},d=Math.hypot(Q.x-p.x,Q.y-p.y);if(d<best){best=d;bi=i;bp=p;}}
          base=bp;between=path.slice(1,bi);   // from the corner end of the crossing seam line to just before the foot
        }
        shape.extend=arrives?[shape.tip,B,Q,base,...[...between].reverse()]:[...between,base,Q,B,shape.tip];
      }
    }
    else if(item.kind==='boundFold'||item.kind==='extendFold'){
      const other=partnerFrame(project,item.partner),otherRole=other.arrives?'arriving':'leaving',own=crossingSeam(vertex,arriving,leaving,{sewn:role}).corner;
      let line;
      if(item.kind==='boundFold'&&item.role!=='second')line=boundFoldLine(vertex,arriving,leaving,{sewn:role});
      else{
        // 包边延长反转角 on the second piece takes the first piece's line, 延长反转角 its partner's crossing seam line, laid over by sewing
        const source=item.kind==='boundFold'?boundFoldLine(other.vertex,other.arriving,other.leaving,{sewn:otherRole}):crossingSeam(other.vertex,other.arriving,other.leaving,{sewn:otherRole}).line;
        const map=sewingMap(crossingSeam(other.vertex,other.arriving,other.leaving,{sewn:otherRole}).corner,own);
        line={point:map.point(source.point),direction:map.direction(source.direction)};
      }
      shape=lineCorner(vertex,arriving,leaving,{line,owner:role});
    }
    else shape=specialCorner(vertex,arriving,leaving,{kind:item.kind,hem:role,shift:item.shift});
    shapes.push({...shape,v,vertex,alongArriving:arriving.tangent,alongLeaving:leaving.tangent,outArriving:rightOf(arriving.tangent),outLeaving:rightOf(leaving.tangent)});
  }
  return shapes;
}
/** Replace the plain corner of the seam outline by the treated shape: cut away what lies beyond it, or add what it adds. */
function applyCornerShapes(solution,shapes,origin){
  const grid=p=>({X:Math.round((p.x-origin.x)*GRID),Y:Math.round((p.y-origin.y)*GRID)}),move=(p,n,f)=>({x:p.x+n.x*f,y:p.y+n.y*f}),MARGIN=.02;
  let current=solution;
  for(const shape of shapes){
    if(shape.region){   // v67: the area between the net edges and the new seam line at a smooth joint (曲线断差, 单边直角, 开叉)
      if(shape.cut){   // a band the new seam line replaces (开叉: the narrower edge's band up to where K1 starts)
        const cutter=new Clipper.Clipper(),left=[];
        cutter.AddPaths(current,Clipper.PolyType.ptSubject,true);cutter.AddPath(shape.cut.map(grid),Clipper.PolyType.ptClip,true);
        cutter.Execute(Clipper.ClipType.ctDifference,left,Clipper.PolyFillType.pftNonZero,Clipper.PolyFillType.pftNonZero);current=left;
      }
      const clipper=new Clipper.Clipper(),next=[];
      clipper.AddPaths(current,Clipper.PolyType.ptSubject,true);clipper.AddPath(shape.region.map(grid),Clipper.PolyType.ptClip,true);
      clipper.Execute(Clipper.ClipType.ctUnion,next,Clipper.PolyFillType.pftNonZero,Clipper.PolyFillType.pftNonZero);
      current=next.map(p=>Clipper.Clipper.CleanPolygon(p,Math.SQRT2)).filter(p=>p.length>=3);continue;
    }
    if(shape.extend){   // a whole area to add (直角 that reaches beyond the crossing seam line)
      const clipper=new Clipper.Clipper(),next=[];
      clipper.AddPaths(current,Clipper.PolyType.ptSubject,true);clipper.AddPath(shape.extend.map(grid),Clipper.PolyType.ptClip,true);
      clipper.Execute(Clipper.ClipType.ctUnion,next,Clipper.PolyFillType.pftNonZero,Clipper.PolyFillType.pftNonZero);
      current=next.map(p=>Clipper.Clipper.CleanPolygon(p,Math.SQRT2)).filter(p=>p.length>=3);continue;
    }
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
    const added=shape.bare?[...path,shape.tip]:endOnOutline&&!startOnOutline?[...path,shape.tip,shape.vertex]:startOnOutline&&!endOnOutline?[...path,shape.vertex,shape.tip]:[...path,shape.tip];
    const cut=shape.mode?shape.mode==='cut':twice<0;   // v67: 单边直角 says which itself
    const polygon=(cut?[...path,move(shape.start,shape.outLeaving,MARGIN),move(move(shape.tip,shape.outArriving,MARGIN),shape.outLeaving,MARGIN),move(shape.end,shape.outArriving,MARGIN)]:added).map(grid);
    const clipper=new Clipper.Clipper(),next=[];
    clipper.AddPaths(current,Clipper.PolyType.ptSubject,true);clipper.AddPath(polygon,Clipper.PolyType.ptClip,true);
    clipper.Execute(cut?Clipper.ClipType.ctDifference:Clipper.ClipType.ctUnion,next,Clipper.PolyFillType.pftNonZero,Clipper.PolyFillType.pftNonZero);
    current=next.map(p=>Clipper.Clipper.CleanPolygon(p,Math.SQRT2)).filter(p=>p.length>=3);
  }
  return current;
}
/**
 * v66: ET's extended seam (生成扩展缝边, 修改扩展缝边线宽度): every piece of the seam outline `outer` (grid units, counter-clockwise)
 * moves out by the extension of the edge it belongs to, and neighbouring pieces meet in sharp corners. A piece of a treated corner
 * belongs to the edge seam-corners names as its owner (a cut corner's to the edge it is set on, a fold-back's flap to the side, the
 * pieces of 折叠角 to the edge they continue, 偷角处理's riser and the pieces of 专用角处理 to the hem); any other piece to the edge
 * whose seam line it lies on. Checked against ET: with one width ET's line is the outline moved out with mitred corners (within
 * 0.001 mm on straight edges, at every kind of corner probed); with a wider hem every piece took the width named here.
 */
function extendedOutline(outer,origin,edges,shapes,widths,config){
  const count=edges.length,mm=p=>({x:origin.x+p.X/GRID,y:origin.y+p.Y/GRID}),TOL=.01;
  const segDist=(p,a,b)=>{const dx=b.x-a.x,dy=b.y-a.y,q=dx*dx+dy*dy,t=q?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/q)):0;return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);};
  const pathDist=(p,points)=>{let best=Infinity;for(let i=1;i<points.length;i++)best=Math.min(best,segDist(p,points[i-1],points[i]));return best;};
  const pieces=shapes.flatMap(shape=>(shape.pieces||[]).filter(piece=>piece.points.length>1).map(piece=>({points:piece.points,edge:(piece.extensionOwner??piece.owner)==='arriving'?shape.v:(shape.v+1)%count})));
  const owners=outer.map((P,i)=>{
    const a=mm(P),b=mm(outer[(i+1)%outer.length]),m={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    for(const piece of pieces)if(pathDist(a,piece.points)<TOL&&pathDist(b,piece.points)<TOL&&pathDist(m,piece.points)<TOL)return piece.edge;
    // the edge whose seam line holds this piece: the whole line of a straight edge (right of travel is outside), the offset of a curve
    let found=-1,error=Infinity;
    edges.forEach((edge,k)=>{
      let d;
      if(edge.points.length===2){const p=edge.points[0],q=edge.points[1],L=Math.hypot(q.x-p.x,q.y-p.y),off=r=>((r.x-p.x)*(q.y-p.y)-(r.y-p.y)*(q.x-p.x))/L;d=Math.max(Math.abs(off(a)-edge.width),Math.abs(off(b)-edge.width));}
      else d=Math.max(...[a,m,b].map(r=>Math.abs(pathDist(r,edge.points)-edge.width)));
      if(d<error){error=d;found=k;}
    });
    if(error<2*TOL)return found;
    let near=0,nearest=Infinity;edges.forEach((edge,k)=>{const d=pathDist(m,edge.points);if(d<nearest){nearest=d;near=k;}});
    return near;
  });
  const grid=owners.map(k=>widths.get(edgeKey(edges[k].entityId,edges[k].segmentIndex))*GRID);
  const best=joinedOffset(outer,grid,config.miterLimit).map(path=>Clipper.Clipper.CleanPolygon(path,Math.SQRT2)).filter(path=>path.length>=3&&signedArea(path)>0).reduce((b,path)=>!b||signedArea(path)>signedArea(b)?path:b,null);
  if(!best)throw new Error('扩展缝边算不出来，请减小扩展缝边的宽度');
  return {role:'extension',area:Math.abs(signedArea(best))/(GRID*GRID),points:best.map(mm),owners};
}
/**
 * v66: a closed path (grid units, counter-clockwise) moved out piece by piece, each piece by its own width, as ET makes its extended
 * seam: every moved piece is carried on until it meets the next one, even where a short piece then runs backwards (the top of a
 * stepped corner with a wider hem: ET keeps that step), and loops left by a piece that ran backwards are cut away afterwards (the
 * piece of 折叠角 next to a wider hem: ET drops it). Two neighbours that run side by side are joined end to end; a meeting point
 * farther from the corner than miterLimit times the wider width is replaced by the two ends (a needle).
 */
function joinedOffset(path,widths,miterLimit){
  const lines=[];
  path.forEach((a,i)=>{const b=path[(i+1)%path.length],dx=b.X-a.X,dy=b.Y-a.Y,L=Math.hypot(dx,dy);if(!(L>0))return;const t={X:dx/L,Y:dy/L},w=widths[i];lines.push({a:{X:a.X+t.Y*w,Y:a.Y-t.X*w},b:{X:b.X+t.Y*w,Y:b.Y-t.X*w},t,w,corner:b});});
  const raw=[];
  lines.forEach((p,i)=>{
    const q=lines[(i+1)%lines.length],den=p.t.X*q.t.Y-p.t.Y*q.t.X;
    if(Math.abs(den)<1e-9){raw.push(p.b,q.a);return;}
    const f=((q.a.X-p.a.X)*q.t.Y-(q.a.Y-p.a.Y)*q.t.X)/den,x={X:p.a.X+p.t.X*f,Y:p.a.Y+p.t.Y*f};
    if(Math.hypot(x.X-p.corner.X,x.Y-p.corner.Y)>miterLimit*Math.max(p.w,q.w))raw.push(p.b,q.a);else raw.push(x);
  });
  const clipper=new Clipper.Clipper(),solution=[];
  clipper.AddPath(raw.map(p=>({X:Math.round(p.X),Y:Math.round(p.Y)})),Clipper.PolyType.ptSubject,true);
  clipper.Execute(Clipper.ClipType.ctUnion,solution,Clipper.PolyFillType.pftPositive,Clipper.PolyFillType.pftPositive);
  return solution;
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
  let discardedFragments=0,shapes=[];
  if(config.widthMode==='edges'&&!sameWidth){
    solution=solution.map(path=>Clipper.Clipper.CleanPolygon(path,Math.SQRT2)).filter(path=>{const valid=path.length>=3&&signedArea(path)!==0;if(!valid)discardedFragments++;return valid;});
  }
  if(!solution.length)throw new Error('偏移后轮廓消失，请减小宽度');
  if(config.corners){
    shapes=cornerShapes(ordered,widthMap,config.corners,project);solution=applyCornerShapes(solution,shapes,origin);if(!solution.length)throw new Error('角处理后缝份轮廓消失');
    // Cutting a corner can leave a sliver where its tip was (seen in one size of a real pattern: three points, 0.003 mm2).
    // A loop thinner than a hundredth of a millimetre is not allowance.
    const thin=path=>{let around=0;for(let i=0;i<path.length;i++){const a=path[i],b=path[(i+1)%path.length];around+=Math.hypot(b.X-a.X,b.Y-a.Y);}return 2*Math.abs(signedArea(path))<.01*GRID*around;};
    const kept=solution.filter(path=>!thin(path));if(kept.length&&kept.length<solution.length){discardedFragments+=solution.length-kept.length;solution=kept;}
  }
  const paths=solution.map(path=>{
    const area=signedArea(path);return {role:area<0?'hole':'outer',area:Math.abs(area)/(GRID*GRID),points:path.map(point=>({x:origin.x+point.X/GRID,y:origin.y+point.Y/GRID}))};
  }).sort((a,b)=>a.role===b.role?b.area-a.area:a.role==='outer'?-1:1);
  // v67: lines inside the allowance that a treatment draws (开叉: the dashed fold lines and the solid marks), as open polylines
  for(const shape of shapes)for(const line of shape.lines||[])if(line.points.length>1)paths.push({role:line.dashed?'fold':'mark',open:true,area:0,points:line.points});
  if(config.extension){
    // v66: the extended seam, ET's 生成扩展缝边; it comes after the outline and the holes
    const outer=solution.filter(path=>signedArea(path)>0).reduce((best,path)=>!best||signedArea(path)>signedArea(best)?path:best,null);
    if(outer)paths.push(extendedOutline(outer,origin,orderedEdges(ordered,widthMap),shapes,extensionWidthMap(project,baseEntityIds,config.extension),config));
  }
  if(paths.flatMap(path=>path.points).some(point=>Math.abs(point.x)>1e8||Math.abs(point.y)>1e8))throw new Error('缝份坐标超出工程范围');
  return {config,paths,basePoints:clean.map(point=>({x:origin.x+point.X/GRID,y:origin.y+point.Y/GRID})),bridges,maxGap:bridges.reduce((n,b)=>Math.max(n,b.distance),0),area:Math.abs(area)/(GRID*GRID),grid:.001,cleanupTolerance:config.widthMode==='edges'&&!sameWidth?Math.SQRT2/GRID:0,discardedFragments};
}

function signature(project,recipe){
  const byId=new Map(project.entities.map(entity=>[entity.id,entity]));
  return JSON.stringify([project.units,settings(recipe),recipe.baseEntityIds.map(id=>{const e=byId.get(id);return e?[id,e.closed,e.curve||e.points,e.derivedFrom,e.notchFrom]:[id,null];}),partnerSignature(project,recipe)]);
}
export function syncAllowances(project,makeId) {
  syncMirrorLinks(project);   // v62: mirror images of symmetric editing follow their lines wherever the drawing is brought up to date
  for(const recipe of project.seamAllowances||[]){
    let current;
    try{
      current=signature(project,recipe);
      if(recipe.signature===current&&['current','error'].includes(recipe.status))continue;
      const generated=generateAllowance(project,recipe.baseEntityIds,recipe),oldIds=[...recipe.outputIds];
      const lineRole=role=>role==='fold'||role==='mark';
      const before=oldIds.map(id=>project.entities.find(entity=>entity.id===id)),oldExtension=before.find(entity=>entity?.seamRole==='extension'),oldSeams=before.filter(entity=>entity?.seamRole!=='extension'&&!lineRole(entity?.seamRole)),oldLines=before.filter(entity=>lineRole(entity?.seamRole));
      let seamIndex=0,lineIndex=0;
      const outputs=generated.paths.map(path=>{
        // v67: the lines a treatment draws inside the allowance are open polylines of their own (dashed fold lines, solid marks)
        if(lineRole(path.role)){const old=oldLines[lineIndex++];return {...old,id:old?.id||makeId(),type:'polyline',name:old?.name||recipe.name+(path.role==='fold'?' · 折边线':' · 止口线'),layer:old?.layer||'seam',closed:false,points:path.points,derivedFrom:recipe.id,seamRole:path.role};}
        // v66: the extended seam keeps its own entity; the outline and the holes are matched by their place, as before
        const index=path.role==='extension'?-1:seamIndex++,old=path.role==='extension'?oldExtension:oldSeams[index];
        const name=path.role==='extension'?recipe.name+' · 扩展缝边':recipe.name+(path.role==='hole'?' · 内孔':'')+(index?' '+(index+1):'');
        return {...old,id:old?.id||makeId(),type:'polyline',name:old?.name||name,layer:old?.layer||'seam',closed:true,points:path.points,derivedFrom:recipe.id,seamRole:path.role,...(path.role==='extension'?{color:[127,204,204]}:{})};   // ET draws the extended seam in 7fcccc
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
  if(!generated.config.extension)delete recipe.extension;
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
