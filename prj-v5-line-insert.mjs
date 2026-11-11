import {parsePrj} from './prj-parser.mjs';
import {encodePrjStorage} from './prj-storage.mjs';
import {readV5References,ordinaryV5Tail,ordinaryV5Node,v5TextStart} from './prj-v5-layout.mjs';

const clone=v=>JSON.parse(JSON.stringify(v));
function canonical(v){
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
  if(v&&typeof v==='object')return '{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  return JSON.stringify(v);
}

/** Extend the observed single-size v5 layout without rewriting old records. */
export function insertV5Lines(original,parsed,additions,sourceIdStart){
  const m=parsed.metadata,root=m.sizeVariants[0],count=additions.length;
  const records=readV5References(original,parsed),textStart=v5TextStart(parsed);
  const curveEnd=m.unparsedFollowingRanges.find(r=>r.scope==='between-curves-and-pieces').offset;
  const template=records.find(r=>r.entity.source.recordKind===2&&r.end-r.start===110&&r.tailOffset===r.start+74&&
    !parsed.groups.some(g=>g.entityIds.includes(r.entity.id))&&r.direct.length===2&&new Set(r.direct).size===2&&!r.secondary.length&&
    !r.entity.source.flags.some(Boolean)&&r.entity.source.lineStyle===0&&
    [...r.entity.source.color,...r.entity.source.baseColor].every(c=>c===255)&&ordinaryV5Tail(original,r)&&
    r.direct.every(i=>ordinaryV5Node(original,m.nodes,i,textStart)&&m.nodes[i-1].ownerIndex===r.index)&&
    m.nodes.filter(n=>n.ownerIndex===r.index).length===2);
  if(!template)throw new Error('此 v5 文件没有已验证结构的独立普通直线模板，暂不能新增回存。');
  const oldView=new DataView(original.buffer,original.byteOffset,original.byteLength);
  const nodeCountOffset=root.tableOffset+57*4,curveCountOffset=root.tableOffset+23*4,seed=oldView.getUint32(root.tableOffset+17*4,true);
  if(!(nodeCountOffset<root.nodeOffset&&root.nodeOffset<textStart&&textStart<m.firstCurveOffset&&m.lastCurveOffset<curveEnd&&curveEnd<original.length)||
    root.nodeCount!==m.nodes.length||root.curveCount!==records.length||root.nodeCount+count*2>10000||root.curveCount+count>10000||
    oldView.getUint32(nodeCountOffset,true)!==seed+3201+root.nodeCount||oldView.getUint32(curveCountOffset,true)!==seed+1280+root.curveCount||
    seed+3201+root.nodeCount+count*2>0xffffffff||seed+1280+root.curveCount+count>0xffffffff)
    throw new Error('v5 节点或曲线计数边界不支持新增。');
  const nodes=new Uint8Array(count*84),curves=new Uint8Array(count*110);
  const nv=new DataView(nodes.buffer),cv=new DataView(curves.buffer);
  for(let i=0;i<count;i++){
    const id=sourceIdStart+i*3,co=i*110;
    curves.set(original.subarray(template.start,template.end),co);cv.setUint32(co,id,true);
    for(let j=0;j<2;j++){
      const no=i*84+j*42,p=additions[i].stored[j],source=m.nodes[template.direct[j]-1];
      nodes.set(original.subarray(source.offset,source.offset+42),no);
      nv.setUint32(no+4,id+j+1,true);nv.setFloat32(no+14,p.x,true);nv.setFloat32(no+18,p.y,true);
      nv.setUint32(no+26,root.curveCount+i+1,true);
      cv.setFloat32(co+34+j*12,p.x,true);cv.setFloat32(co+38+j*12,p.y,true);
      cv.setUint32(co+62+j*4,root.nodeCount+i*2+j+1,true);
    }
  }
  const payload=new Uint8Array(original.length+nodes.length+curves.length);
  payload.set(original.subarray(0,textStart));payload.set(nodes,textStart);
  payload.set(original.subarray(textStart,curveEnd),textStart+nodes.length);
  payload.set(curves,curveEnd+nodes.length);payload.set(original.subarray(curveEnd),curveEnd+nodes.length+curves.length);
  const view=new DataView(payload.buffer);
  view.setUint32(nodeCountOffset,oldView.getUint32(nodeCountOffset,true)+count*2,true);
  view.setUint32(curveCountOffset,oldView.getUint32(curveCountOffset,true)+count,true);

  const shift=o=>o+(o>=textStart?nodes.length:0)+(o>=curveEnd?curves.length:0);
  const ids=new Map([...parsed.entities,...parsed.groups].map(e=>[e.id,e.id.replace(/^(prj-(?:text-|label-|grain-|piece-)?)(\d+)/,(_,prefix,o)=>prefix+shift(+o))]));
  function relocate(v,key=''){
    if(typeof v==='string')return ids.get(v)||v;
    if(typeof v==='number'&&(key==='offset'||key==='recordEnd'||key==='textEnd'||key.endsWith('Offset')))return shift(v);
    if(Array.isArray(v))return v.map(x=>relocate(x));
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,relocate(x,k)]));
    return v;
  }
  const expected=relocate(parsed),next=expected.metadata,variant=next.sizeVariants[0],added=[];
  for(let i=0;i<count;i++){
    const id=sourceIdStart+i*3,offset=curveEnd+nodes.length+i*110,index=root.curveCount+i+1;
    const entity=clone(template.entity);entity.id=`prj-${offset}-${id}`;entity.name=`直线 ${index}`;entity.points=clone(additions[i].stored);
    Object.assign(entity.source,{offset,sourceId:id,pointReferences:[root.nodeCount+i*2+1,root.nodeCount+i*2+2]});added.push(entity);
    for(let j=0;j<2;j++)next.nodes.push({offset:textStart+i*84+j*42,recordType:6,sourceId:id+j+1,...entity.points[j],ownerIndex:index,flags:[0,0,0],sizeId:root.id});
  }
  expected.entities.splice(root.curveCount,0,...added);variant.entityIds.splice(root.curveCount,0,...added.map(e=>e.id));
  for(const key of ['declaredCurveCount','parsedCurveCount','lineCount','unownedCurveCount'])next[key]+=count;
  for(const key of ['declaredPointCount','parsedPointCount'])next[key]+=count*2;
  variant.curveCount+=count;variant.nodeCount+=count*2;
  next.lastCurveOffset=added.at(-1).source.offset;
  next.unownedCurveIds.push(...added.map(e=>e.id));variant.unownedCurveIds.push(...added.map(e=>e.id));
  expected.warnings=expected.warnings.map(s=>s.replace(`${root.curveCount} 条主图曲线`,`${root.curveCount+count} 条主图曲线`));
  const candidate=encodePrjStorage(payload),reparsed=parsePrj(candidate,m.sourceFile);
  if(canonical(reparsed)!==canonical(expected))throw new Error('v5 新增后出现预期之外的解析变化，已拒绝导出。');
  return {candidate,sourceIdStart};
}
