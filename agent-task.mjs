/** A bounded task contract shared by browser planning and the local ET executor.
 * This first pilot is deterministic; no remote model or hidden API is called. */
export const PANTS_OPERATION='extend-trouser-hem';
export function validateAgentProfile(profile){
  if(!profile||profile.schema!=='zhiyi-agent-profile/v1'||profile.operation!==PANTS_OPERATION||
    typeof profile.id!=='string'||!/^[a-z0-9-]{1,80}$/.test(profile.id)||
    typeof profile.name!=='string'||profile.name.length>200||
    !/^[a-f0-9]{64}$/.test(profile.sourceSha256)||
    profile.mmPerSourceUnit!==10||profile.validatedDeltaMm!==20||
    profile.backend!=='et-native-ui'||profile.rule!=='knee-fixed-hem-vertical')
    throw Error('母版规则未通过验证，当前仅接受已验收的裤脚垂直加长 20 mm 规则。');
  return profile;
}
export function planAgentTask(instruction,profile,sourceSha256){
  validateAgentProfile(profile);
  if(sourceSha256!==profile.sourceSha256)throw Error('PRJ 与已验证母版不一致，请使用对应母版和规则。');
  if(typeof instruction!=='string'||instruction.length>120)throw Error('改版要求无效。');
  const text=instruction.trim();
  const match=text.match(/^裤长\s*(?:增加|加长|加)\s*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米)$/i);
  if(!match)throw Error('本次试验只接受“裤长加长 20 mm”或“裤长加长 2 cm”；其他改版要求尚未验证。');
  const delta=Number(match[1])*(/^(cm|厘米)$/i.test(match[2])?10:1);
  if(delta!==profile.validatedDeltaMm)throw Error('本母版目前只验收了加长 20 mm，其他数值暂不执行。');
  return {schema:'zhiyi-agent-task/v1',profileId:profile.id,sourceSha256,
    instruction:text,operation:PANTS_OPERATION,parameters:{deltaMm:delta,axis:'vertical',fixed:'knee-and-above',hemWidth:'preserve',hemInternalLines:'translate'},
    backend:'et-native-ui',status:'planned',acceptance:['原文件哈希保持','前后裤脚垂直加长 20 mm','膝线及上段固定','脚口宽度及内部线关系保持','原文字和其他裁片保持','ET 保存、重开及再次保存的几何一致']};
}
export function validateAgentTask(task,profile){
  const expected=planAgentTask(task?.instruction,profile,task?.sourceSha256);
  if(JSON.stringify(task)!==JSON.stringify(expected))throw Error('任务参数与已验证规则不一致，已拒绝执行。');
  return expected;
}
