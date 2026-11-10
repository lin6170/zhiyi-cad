import {createRecoveryStore,createRecoveryWriter,decodeRecovery} from './recovery.mjs';

export function createRecoveryPanel({canRestore,restore,captureNow,notify}){
  const $=id=>document.getElementById(id),dialog=$('recovery-dialog'),button=$('recovery-open');
  // The local QA server supplies a separate database; production has no such tag.
  const scope=document.querySelector('meta[name="cad-recovery-qa"]')?.content;
  const database=scope&&/^[a-z0-9-]{1,80}$/.test(scope)?'zhiyi-cad-qa-'+scope:'zhiyi-cad-recovery-v1';
  const preference=database+'-enabled',store=createRecoveryStore({name:database});
  let status={status:'idle'},count=0,busy=false,listGeneration=0;
  const labels={idle:'等待编辑',pending:'待写入',writing:'写入中',saved:'已写入',error:'写入失败',disabled:'已关闭'};
  function paint(){
    button.textContent='本机恢复 · '+(status.status==='idle'&&count?count+' 份':labels[status.status]);button.dataset.status=status.status;
    button.title='本机恢复：'+labels[status.status]+(status.error?' · '+status.error:'');
    $('recovery-status').textContent='当前工程：'+labels[status.status]+(status.updatedAt&&status.status==='saved'?' · '+new Date(status.updatedAt).toLocaleTimeString():'')+(status.error?'。'+status.error:'');
    $('recovery-status').dataset.status=status.status;$('recovery-enabled').checked=writer.enabled;
  }
  const writer=createRecoveryWriter({store,onStatus:value=>{status=value;paint();if(value.status==='saved')void list();},onBackgroundError:message=>notify('之前工程的恢复记录写入失败：'+message+'。可在本机恢复中重试。')});
  async function list(){
    const generation=++listGeneration;
    try{
      const records=await store.list();if(generation!==listGeneration)return;
      count=records.length;paint();$('recovery-list').replaceChildren();
      if(!records.length){const text=document.createElement('p');text.className='muted';text.textContent='尚无本机恢复记录。编辑后会自动保存一份。';$('recovery-list').append(text);}
      for(const record of records){
        const row=document.createElement('article');row.className='recovery-record';row.dataset.recoveryId=record.id;
        const info=document.createElement('div'),name=document.createElement('strong'),meta=document.createElement('small');
        name.textContent=record.name;meta.textContent=new Date(record.updatedAt).toLocaleString()+' · '+record.entities+' 个图元'+(record.draftPoints?' · '+record.draftPoints+' 个草稿点':'')+' · '+(record.units==='mm'?'mm':'单位待确认')+' · '+(record.bytes/1024).toFixed(1)+' KiB';info.append(name,meta);
        const actions=document.createElement('div'),open=document.createElement('button'),remove=document.createElement('button');open.textContent='恢复副本';open.dataset.recoveryAction='restore';remove.textContent='删除记录';remove.dataset.recoveryAction='delete';
        open.onclick=()=>operate(async()=>{
          const state=await decodeRecovery(await store.get(record.id));
          if(!canRestore())return;
          await restore(state);dialog.close();notify('已恢复本机副本。请核对后下载保存工程。');
        });
        remove.onclick=()=>operate(async()=>{await writer.remove(record.id);await list();});
        actions.append(open,remove);row.append(info,actions);$('recovery-list').append(row);
      }
      $('recovery-error').textContent='';
    }catch(error){$('recovery-error').textContent='读取恢复记录失败：'+error.message;button.dataset.status='error';button.title=error.message;}
  }
  async function operate(action){
    if(busy)return;busy=true;dialog.classList.add('recovery-busy');$('recovery-close').disabled=true;$('recovery-enabled').disabled=true;$('recovery-error').textContent='';
    try{await action();}catch(error){$('recovery-error').textContent=error.message;}finally{busy=false;dialog.classList.remove('recovery-busy');$('recovery-close').disabled=false;$('recovery-enabled').disabled=false;}
  }
  function enabled(value,persist){
    writer.setEnabled(value);
    if(persist)try{localStorage.setItem(preference,value?'1':'0');}catch{notify('本次设置已应用，浏览器未能记住开关状态。');}
    if(value)captureNow();
  }
  button.onclick=()=>{dialog.showModal();void list();};$('recovery-close').onclick=()=>dialog.close();
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  $('recovery-enabled').onchange=()=>enabled($('recovery-enabled').checked,true);
  $('recovery-retry').onclick=()=>operate(async()=>{captureNow();await writer.retry();await list();});
  window.addEventListener('storage',event=>{if(event.key===preference)enabled(event.newValue!=='0',false);});
  try{if(localStorage.getItem(preference)==='0')writer.setEnabled(false);}catch{}
  paint();void list();
  return {writer,isOpen:()=>dialog.open};
}
