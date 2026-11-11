import { parsePrj } from './prj-parser.mjs';
import { validateProject } from './geometry.mjs';
import { readPrjCurveReferences as referenceRecords } from './prj-references.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const signature = [0x51, 0x7f, 1, 1, 0, 0, 0, 0x40];
const plainTail = [0,0,0,0,0,0,128,63,0,0,0,0,0,0,0,0,0,0];
const pointEqual = (a,b) => a.x === b.x && a.y === b.y;
function canonical(value) {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
function freeze(value) { if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value; }
function copyBytes(input) {
  if(input instanceof Uint8Array)return new Uint8Array(input);
  if(input instanceof ArrayBuffer)return new Uint8Array(input.slice(0));
  throw new Error('端点回存需要原始 PRJ 字节。');
}

function coordinateCopies(bytes, offset) {
  const matches=[];
  for(let i=0;i+8<=bytes.length;i++){
    let same=true;for(let j=0;j<8;j++)if(bytes[i+j]!==bytes[offset+j]){same=false;break;}
    if(same){matches.push(i);if(matches.length>2)break;}
  }
  return matches;
}
function inspectLine(bytes,parsed,records,record) {
  const fail=reason=>({eligible:false,reason});
  const entity=record.entity,source=entity.source,nodes=parsed.metadata.nodes;
  if(source.recordKind!==2||entity.points.length!==2||entity.curve||entity.closed)return fail('当前仅支持开放独立直线，不支持曲线或闭合线。');
  if(parsed.groups.some(g=>g.entityIds.includes(entity.id)))return fail('这条线属于裁片或组合，关联修改尚未验证。');
  if(record.direct.length!==2||new Set(record.direct).size!==2||record.secondary.length)return fail('这条线含共享点或额外点引用，暂不支持。');
  if(record.end-record.tailOffset!==plainTail.length||!plainTail.every((b,i)=>bytes[record.tailOffset+i]===b))return fail('这条线包含尚未验证的附加记录。');
  if(source.flags.some(Boolean)||pointEqual(...entity.points))return fail('线条标志或端点结构尚不支持。');
  if(nodes.filter(n=>n.ownerIndex===record.index).length!==2)return fail('这条线还有附加节点，暂不支持。');
  const endpoints=[];
  for(let i=0;i<2;i++){
    const nodeIndex=record.direct[i],node=nodes[nodeIndex-1],pointOffset=source.offset+34+i*12;
    if(!node||node.recordType!==6||node.ownerIndex!==record.index||node.flags.some(Boolean)||!pointEqual(entity.points[i],node))return fail('线条端点与节点记录不一致。');
    if(bytes.subarray(node.offset+30,node.offset+34).some(Boolean))return fail('节点含尚未验证的附加字段。');
    if(records.some(r=>r!==record&&(r.direct.includes(nodeIndex)||r.secondary.includes(nodeIndex))))return fail('端点被其他线条引用，暂不支持。');
    if(parsed.groups.some(g=>g.source?.ownedNodes?.indices.includes(nodeIndex)))return fail('端点属于裁片，暂不支持。');
    const copies=coordinateCopies(bytes,pointOffset);
    if(copies.length!==2||!copies.includes(pointOffset)||!copies.includes(node.offset+14))return fail('端点坐标还出现在其他记录中，关联未确认。');
    endpoints.push({nodeIndex,pointOffset,nodeOffset:node.offset+14});
  }
  return {eligible:true,entityId:entity.id,name:entity.name,endpoints,points:clone(entity.points)};
}

/** Experimental isolated-line writer. Does not infer unknown links or physical units. */
export function createPrjEndpointExportSession(input,filename='ET project.prj') {
  const original=copyBytes(input);
  if(!signature.every((b,i)=>original[i]===b))throw new Error('此 PRJ 布局尚不支持端点回存。');
  const parsed=parsePrj(original,filename),records=referenceRecords(original,parsed);
  const baseline=clone(validateProject({format:'zhiyi-cad',version:6,units:'unknown',seamAllowances:[],notches:[],seamChecks:[],...clone(parsed)}));
  const inspections=new Map(records.map(r=>[r.entity.id,freeze(inspectLine(original,parsed,records,r))]));
  const previews=new WeakMap();
  return Object.freeze({
    filename,
    eligibleLines:freeze([...inspections.values()].filter(r=>r.eligible).map(r=>({id:r.entityId,name:r.name,points:clone(r.points)}))),
    inspect:entityId=>inspections.get(entityId)||freeze({eligible:false,reason:'这个对象不是支持的原始独立直线。'}),
    preview(project) {
      const current=clone(project),expected=clone(baseline),changes=[];
      if(!Array.isArray(current.entities)||current.entities.length!==expected.entities.length)throw new Error('图元数量已变化；端点回存不能新增或删除对象。');
      if(!Number.isInteger(current.version)||current.version<baseline.version||current.version>10)throw new Error('工程版本不受支持。');
      expected.version=current.version;
      for(let i=0;i<expected.entities.length;i++){
        const old=expected.entities[i],next=current.entities[i];
        if(old.id!==next.id||old.type!==next.type)throw new Error('对象或顺序已变化，请保存工程。');
        if(canonical(old.points)!==canonical(next.points)){
          const inspection=inspections.get(old.id);
          if(!inspection?.eligible)throw new Error(inspection?.reason||'此对象尚不支持端点回存。');
          if(!Array.isArray(next.points)||next.points.length!==2)throw new Error('端点数量不能改变。');
          const changed=old.points.map((p,j)=>pointEqual(p,next.points[j])?null:j).filter(j=>j!==null);
          if(changed.length!==1)throw new Error('当前一次只回存一条独立直线的一个端点。');
          const endpointIndex=changed[0],requested=next.points[endpointIndex];
          if(Object.keys(requested).sort().join(',')!=='x,y'||![requested.x,requested.y].every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=100000))throw new Error('端点坐标必须是范围内的有限数字。');
          const stored={x:Math.fround(requested.x),y:Math.fround(requested.y)};
          if(pointEqual(stored,old.points[endpointIndex]))throw new Error('修改小于 PRJ 单精度坐标的分辨率，没有可保存的变化。');
          if(pointEqual(stored,old.points[1-endpointIndex]))throw new Error('回存后直线会变成零长度，已拒绝。');
          changes.push({entityId:old.id,name:old.name,endpointIndex,before:{...old.points[endpointIndex]},requested:{...requested},stored,roundingError:Math.hypot(stored.x-requested.x,stored.y-requested.y),...inspection.endpoints[endpointIndex]});
          old.points=clone(next.points);
        }
        if(next.source?.modified===true)delete next.source.modified;
        if(old.source?.modified===true)delete old.source.modified;
      }
      if(canonical(current)!==canonical(expected))throw new Error('还包含标注、单位、排版或其他修改；不能只回存端点，请保存工程或撤销这些修改。');
      if(changes.length!==1)throw new Error(changes.length?'当前一次只回存一条独立直线的一个端点。':'没有需要回存的端点修改。');
      const change=changes[0],candidate=original.slice(),view=new DataView(candidate.buffer);
      for(const offset of [change.pointOffset,change.nodeOffset]){view.setFloat32(offset,change.stored.x,true);view.setFloat32(offset+4,change.stored.y,true);}
      const reparsed=parsePrj(candidate,filename),expectedParsed=clone(parsed);
      expectedParsed.entities.find(e=>e.id===change.entityId).points[change.endpointIndex]={...change.stored};
      Object.assign(expectedParsed.metadata.nodes[change.nodeIndex-1],change.stored);
      if(canonical(reparsed)!==canonical(expectedParsed))throw new Error('写回后出现其他解析变化，已拒绝导出。');
      const nextRecords=referenceRecords(candidate,reparsed);
      const reinspection=inspectLine(candidate,reparsed,nextRecords,nextRecords.find(r=>r.entity.id===change.entityId));
      if(!reinspection.eligible)throw new Error('修改后端点可能建立未验证的关联：'+reinspection.reason);
      const copies=coordinateCopies(candidate,change.pointOffset);
      if(copies.length!==2||!copies.includes(change.nodeOffset))throw new Error('新端点与其他记录重合，暂不支持回存。');
      const plan=freeze({operation:'replace_prj_isolated_endpoint',changes,units:'原始单位（物理比例未确认）',byteLength:original.length,nativeEtValidation:'pending'});
      previews.set(plan,{snapshot:JSON.stringify(project),candidate});return plan;
    },
    export(project,plan){const stored=previews.get(plan);if(!stored||stored.snapshot!==JSON.stringify(project))throw new Error('工程在预览后已变化，请重新预览。');return stored.candidate.slice();},
  });
}
