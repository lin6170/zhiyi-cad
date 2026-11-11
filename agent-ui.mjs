import {planAgentTask} from './agent-task.mjs';
const $=id=>document.getElementById(id);let task=null,revision=0;
function clear(){revision++;task=null;$('agent-download').disabled=true;$('agent-summary').replaceChildren();$('agent-checks').replaceChildren();$('agent-status').textContent='内容已变化，请重新核对。';delete $('agent-status').dataset.error;}
for(const id of ['agent-source','agent-profile','agent-instruction'])$(id).addEventListener('input',clear);
$('agent-plan').onclick=async()=>{
 clear();const token=revision;$('agent-plan').disabled=true;
 try{
  const source=$('agent-source').files[0],profileFile=$('agent-profile').files[0];
  if(!source||!profileFile)throw Error('请选择母版 PRJ 和对应规则 JSON。');
  if(!/\.prj$/i.test(source.name)||source.size>16*1024*1024||source.size<100||profileFile.size>10000)throw Error('文件类型或大小不受支持。');
  const bytes=await source.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  const profile=JSON.parse(await profileFile.text());if(token!==revision)return;
  task=planAgentTask($('agent-instruction').value,profile,hash);
  for(const [label,value] of [['母版',profile.name],['文件',source.name],['修改', '前幅与后幅裤脚垂直加长 20 mm'],['保持','膝线及以上、脚口宽度；内部线随裤脚平移'],['执行方式','本机 ET · 正常编辑工具'],['状态','计划已生成，尚未执行']]){
   const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;$('agent-summary').append(dt,dd);
  }
  for(const text of task.acceptance){const li=document.createElement('li');li.textContent=text;$('agent-checks').append(li);}
  $('agent-status').textContent='母版指纹与规则匹配，任务可交给本机执行器。';$('agent-download').disabled=false;
 }catch(e){if(token===revision){task=null;$('agent-status').textContent=e.message;$('agent-status').dataset.error='true';}}
 finally{$('agent-plan').disabled=false;}
};
$('agent-download').onclick=()=>{
 if(!task)return;const url=URL.createObjectURL(new Blob([JSON.stringify(task,null,2)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download='pants-task.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 $('agent-status').textContent='任务已下载，尚未执行。运行本机执行器后再打开输出 PRJ。';
};
