import {parsePrj} from './prj-parser.mjs';
import {validateProject} from './geometry.mjs';
import {readPrjCurveReferences} from './prj-references.mjs';
import {fitParameters,mapFitParameter} from './fit-spline.mjs';
import {planPantsGeometry,validatePantsDelta} from './pants-command.mjs';
import {verifyPantsContinuation,planPantsContinuation} from './pants-template.mjs';
import {readV5References} from './prj-v5-layout.mjs';
import {decodePrjStorage,encodePrjStorage} from './prj-storage.mjs';
import {PANTS_RULE_SCHEMA,validateUserPantsRule,verifyUserPantsContinuation,planUserPantsContinuation} from './pants-rules.mjs';
const copy=x=>JSON.parse(JSON.stringify(x));
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).filter(k=>x[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
export const PANTS_NATIVE_VERIFIED=true;
export const WEB_PANTS_PROFILE_SHA256='dc92a203a49c7f98c2bf1c6b48ba8750aeea7a8581d5cb5133016a7b135047bf';
export const WEB_PANTS_V2_SHA256='37a62d5b2ab46844e85fa24fc5843603e0aa69af2fa2ecdeda2e6a2b590a0a87';
export async function sha256(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');}
export async function verifyWebPantsProfile(profile){
  if(profile?.schema===PANTS_RULE_SCHEMA){if(JSON.stringify(profile).length>1000000)throw Error('规则文件过大。');return validateUserPantsRule(profile);}
  if(!profile||JSON.stringify(profile).length>160000||![WEB_PANTS_PROFILE_SHA256,WEB_PANTS_V2_SHA256].includes(await sha256(new TextEncoder().encode(JSON.stringify(profile)))))throw Error('规则文件未经本版本验证，不能执行。');
  return copy(profile);
}
export async function createPantsPrjSession(input,filename,project,profile){
  profile=await verifyWebPantsProfile(profile);
  const inputBytes=new Uint8Array(input),sourceSha256=await sha256(inputBytes);
  const baseline=copy(validateProject(copy(project))),parsed=parsePrj(inputBytes,filename);
  const encoded=parsed.metadata.storage==='v5-496-interleave-md5',v5=parsed.metadata.layout==='native-v5-7248',bytes=encoded?decodePrjStorage(inputBytes):inputBytes;
  if(profile.schema==='zhiyi-web-pants-profile/v1'&&sourceSha256!==profile.sourceSha256)throw Error('ET 回存文件请使用新版母版规则。');
  const userRule=profile.schema===PANTS_RULE_SCHEMA;
  const continuation=userRule?verifyUserPantsContinuation({...parsed,units:'unknown'},profile):profile.schema==='zhiyi-web-pants-profile/v2'?verifyPantsContinuation(parsed,profile):{totalDeltaMm:0};
  const checked=validateProject({format:'zhiyi-cad',version:6,units:'unknown',...copy(parsed)});
  for(const key of ['entities','groups','metadata'])if(canonical(baseline[key])!==canonical(checked[key]))throw Error('导入后已有修改，请重新打开原始 PRJ。');
  if(baseline.units!=='unknown')throw Error('当前比例已经改变，请重新打开原始 PRJ。');
  if(v5&&(!encoded||parsed.metadata.sizeVariants?.length!==1||!(userRule?[1,129]:[1]).includes(parsed.metadata.sizeVariants[0].flags)))throw Error('此 v5 母版变体尚未验收。');
  const records=v5?readV5References(bytes,parsed,{verifiedPantsTemplate:true}):readPrjCurveReferences(bytes,parsed),byId=new Map(records.map(r=>[r.entity.source.sourceId,r]));
  const originalView=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let plannedDelta=null;
  function plan(current,parameters){
    if(canonical(current)!==canonical(baseline))throw Error('工程已经修改，请撤销到原始母版再生成改版计划。');
    validatePantsDelta(parameters.deltaMm);
    if(Math.abs(continuation.totalDeltaMm+parameters.deltaMm)>100.00001)throw Error('改后相对原母版的累计变化须在 -100 至 +100 mm 内。');
    const result=userRule?planUserPantsContinuation(baseline,continuation,parameters.deltaMm):continuation.baseline?planPantsContinuation(baseline,profile,continuation,parameters.deltaMm):planPantsGeometry(baseline,profile,parameters);validateProject(result.project);plannedDelta=parameters.deltaMm;return result;
  }
  function exportPrj(current){
    if(plannedDelta===null)throw Error('请先生成改版计划。');
    const result=plan(baseline,{deltaMm:plannedDelta});
    if(canonical(current)!==canonical(result.project))throw Error('当前工程包含计划之外的修改，不能导出这项改版 PRJ。请撤销其他修改或保存工程。');
    const candidate=bytes.slice(),view=new DataView(candidate.buffer),allowed=new Set(),changedNodes=new Set();
    const write=(offset,value)=>{if(!Number.isInteger(offset)||offset<0||offset+4>candidate.length||!Number.isFinite(value))throw Error('PRJ 写入字段无效。');view.setFloat32(offset,value,true);for(let i=0;i<4;i++)allowed.add(offset+i);};
    const writePoint=(offset,p)=>{write(offset,p.x);write(offset+4,p.y);};
    for(const change of result.changes){
      const r=byId.get(change.before.source.sourceId),g=r?.geometry;
      const line=r?.entity.source.recordKind===2;
      if(!g?.fitPoints||r.direct.length!==2||change.geometry.fit.length!==g.fitPoints.count||!line&&(!g.controlPoints||change.geometry.controls.length!==g.controlPoints.count))throw Error('曲线或节点结构超出已验证范围。');
      change.geometry.fit.forEach((p,i)=>writePoint(g.fitPoints.offsets?.[i]??g.fitPoints.offset+i*12,p));
      if(!line)change.geometry.controls.forEach((p,i)=>writePoint(g.controlPoints.offsets?.[i]??g.controlPoints.offset+i*12,p));
      if(!line&&change.mode!=='translate'){
        const old=fitParameters(change.before.source.fitPoints),next=change.geometry.parameters;
        for(let i=0;i<g.parameterArray.count;i++){
          const offset=g.parameterArray.offsets?.[i]??g.parameterArray.offset+i*4,t=originalView.getFloat32(offset,true);
          if(!Number.isFinite(t)||t<0||t>old.at(-1)+.0001)throw Error('样条参数超出范围。');
          write(offset,mapFitParameter(t,old,next));
        }
      }
      r.direct.forEach((index,i)=>{
        const node=parsed.metadata.nodes[index-1];
        if(changedNodes.has(index)||node.recordType!==6||node.ownerIndex!==r.index||records.some(other=>other!==r&&other.direct.includes(index)))throw Error('存在未验证的共享端点。');
        changedNodes.add(index);writePoint(node.offset+14,i?change.geometry.fit.at(-1):change.geometry.fit[0]);
      });
    }
    for(let i=0;i<bytes.length;i++)if(bytes[i]!==candidate[i]&&!allowed.has(i))throw Error('出现非预期的 PRJ 字节修改。');
    const output=encoded?encodePrjStorage(candidate):candidate;
    const roundtrip=parsePrj(output,filename),newMap=new Map(roundtrip.entities.map(e=>[e.id,e])),changes=new Map(result.changes.map(c=>[c.before.id,c]));
    if(roundtrip.entities.length!==parsed.entities.length||canonical(roundtrip.groups)!==canonical(parsed.groups))throw Error('写回后图元或裁片引用改变。');
    for(const old of parsed.entities){
      const actual=newMap.get(old.id),change=changes.get(old.id);
      if(!change){if(canonical(actual)!==canonical(old))throw Error('写回改变了其他纸样或文字。');continue;}
      if(actual.source.recordKind===2){if(canonical(actual.points)!==canonical(change.geometry.fit))throw Error('写回直线与网页结果不一致。');}
      else if(canonical(actual.source.fitPoints)!==canonical(change.geometry.fit)||canonical(actual.source.controlPoints)!==canonical(change.geometry.controls)||canonical(actual.points)!==canonical(change.after.points)||!actual.curve)throw Error('写回曲线与网页结果不一致。');
    }
    return output;
  }
  return Object.freeze({filename,profileName:profile.name,plan,exportPrj,sourceSha256,totalDeltaMm:continuation.totalDeltaMm,layout:v5?'ET v5':'原始 PRJ'});
}
