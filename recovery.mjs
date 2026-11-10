import {validateProject} from './geometry.mjs';

export const RECOVERY_LIMITS=Object.freeze({recordBytes:20*1024*1024,totalBytes:80*1024*1024,records:10});
const drawingTools=new Set(['line','polyline','curve','rectangle','grain','measure']);
const bytes=text=>new TextEncoder().encode(text);
export function validateRecoveryState(state,{validateGeometry=true}={}){
  if(!state||state.format!=='zhiyi-recovery'||state.version!==1)throw new Error('无法识别的恢复记录');
  if(validateGeometry)validateProject(state.project);
  else if(!state.project||state.project.format!=='zhiyi-cad'||!Array.isArray(state.project.entities))throw new Error('恢复工程无效');
  if(!Array.isArray(state.draft)||state.draft.length>10000||state.draft.some(p=>!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1e8||Math.abs(p.y)>1e8))throw new Error('恢复草稿坐标无效');
  if(state.tool!=='select'&&!drawingTools.has(state.tool))throw new Error('恢复绘图工具无效');
  const max=state.tool==='polyline'?10000:state.tool==='curve'?2:state.tool==='select'?0:1;
  if(state.draft.length>max)throw new Error('恢复草稿步骤无效');
  const input=state.input;
  if(!input||!['absolute','relative','polar'].includes(input.mode)||typeof input.first!=='string'||typeof input.second!=='string'||input.first.length>200||input.second.length>200)throw new Error('恢复数值输入无效');
  if(!state.draft.length&&input.mode!=='absolute')throw new Error('恢复数值输入缺少起点');
  if(state.tool==='select'&&(input.first||input.second))throw new Error('恢复记录含无效的待输入数值');
  if(typeof state.dark!=='boolean'||typeof state.grid!=='boolean'||typeof state.showText!=='boolean')throw new Error('恢复显示设置无效');
  return state;
}
export function encodeRecovery(state){
  validateRecoveryState(state,{validateGeometry:false});
  const payload=JSON.stringify(state),size=bytes(payload).byteLength;
  if(size>RECOVERY_LIMITS.recordBytes)throw new Error('工程超过本机恢复的 20 MiB 单条上限，请下载保存工程');
  return {payload,bytes:size};
}
export async function recoveryDigest(payload){
  if(!globalThis.crypto?.subtle)throw new Error('当前浏览器无法校验恢复数据，请下载保存工程');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes(payload)))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function decodeRecovery(record){
  const {payload,size,digest}=record?{payload:record.payload,size:record.bytes,digest:record.digest}:{};
  if(typeof payload!=='string'||payload.length>RECOVERY_LIMITS.recordBytes||bytes(payload).byteLength!==size||size>RECOVERY_LIMITS.recordBytes)throw new Error('恢复记录不完整或超过限制');
  if(await recoveryDigest(payload)!==digest)throw new Error('恢复记录校验失败，当前画布未替换');
  return validateRecoveryState(JSON.parse(payload));
}

export function createRecoveryStore({name='zhiyi-cad-recovery-v1',indexedDB=globalThis.indexedDB,limits=RECOVERY_LIMITS}={}){
  let connection=null;
  function open(){
    if(connection)return connection;
    connection=new Promise((resolve,reject)=>{
      if(!indexedDB){reject(new Error('浏览器不支持本机恢复存储'));return;}
      const request=indexedDB.open(name,2);let abandoned=false;
      request.onupgradeneeded=()=>{for(const store of ['metadata','payloads','deleted'])if(!request.result.objectStoreNames.contains(store))request.result.createObjectStore(store,{keyPath:'id'});};
      request.onerror=()=>reject(request.error||new Error('无法打开本机恢复存储'));
      request.onblocked=()=>{abandoned=true;reject(new Error('恢复存储正被旧页面占用，请关闭旧页面后重试'));};
      request.onsuccess=()=>{const db=request.result;if(abandoned){db.close();return;}db.onversionchange=()=>{db.close();connection=null;};resolve(db);};
    }).catch(error=>{connection=null;throw error;});
    return connection;
  }
  async function transaction(mode,run){
    const db=await open();return new Promise((resolve,reject)=>{
      const tx=db.transaction(['metadata','payloads','deleted'],mode);let result,error;
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(error||tx.error||new Error('本机恢复写入已中止，旧记录保留'));
      try{run(tx,value=>{result=value;},reason=>{error=reason;tx.abort();});}catch(reason){error=reason;tx.abort();}
    });
  }
  return {
    list:()=>transaction('readonly',(tx,done)=>{const r=tx.objectStore('metadata').getAll();r.onsuccess=()=>done(r.result.sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id)));}),
    get:id=>transaction('readonly',(tx,done)=>{const r=tx.objectStore('payloads').get(id);r.onsuccess=()=>done(r.result);}),
    remove:id=>transaction('readwrite',tx=>{tx.objectStore('deleted').put({id});tx.objectStore('metadata').delete(id);tx.objectStore('payloads').delete(id);}),
    put:record=>transaction('readwrite',(tx,done,abort)=>{
      if(!record||typeof record.id!=='string'||!Number.isFinite(record.updatedAt)||!Number.isInteger(record.bytes)||record.bytes<0||record.bytes>limits.recordBytes||record.bytes>limits.totalBytes){abort(new Error('恢复记录超过存储限制'));return;}
      const meta=tx.objectStore('metadata'),data=tx.objectStore('payloads'),tombstone=tx.objectStore('deleted').get(record.id);
      tombstone.onsuccess=()=>{
        if(tombstone.result){const error=new Error('此恢复记录已被删除');error.code='RECOVERY_DELETED';abort(error);return;}
        const read=meta.getAll();read.onsuccess=()=>{
        const others=read.result.filter(r=>r.id!==record.id).sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
        let count=1,total=record.bytes;
        for(const old of others){if(count<limits.records&&total+old.bytes<=limits.totalBytes){count++;total+=old.bytes;}else{meta.delete(old.id);data.delete(old.id);}}
        const {payload,digest,...metadata}=record;meta.put(metadata);data.put({id:record.id,payload,digest,bytes:record.bytes});done(metadata);
        };
      };
    }),
    close:async()=>{if(connection)(await connection).close();connection=null;}
  };
}

// Capture immutable JSON now, then serialize asynchronous writes. A page never writes
// another page's record; restoring always starts a fresh context.
export function createRecoveryWriter({store,onStatus=()=>{},onBackgroundError=()=>{},delay=750,digest=recoveryDigest,newId=()=>crypto.randomUUID(),now=()=>Date.now(),bufferLimit=RECOVERY_LIMITS.totalBytes}={}){
  let id=newId(),enabled=true,epoch=0,sequence=0,timer=null,running=null,lastPayload=null;
  const pending=new Map(),failed=new Map();let inflight=null;
  const emit=(job,status,error)=>{if(enabled&&job.id===id&&job.epoch===epoch&&job.sequence===sequence)onStatus({status,error,updatedAt:job.updatedAt});};
  const clearTimer=()=>{clearTimeout(timer);timer=null;};
  function flush(){
    clearTimer();if(running)return running;
    if(!enabled||!pending.size)return Promise.resolve();
    running=(async()=>{
      while(enabled&&pending.size){
        const job=pending.values().next().value;pending.delete(job.id);inflight=job;
        try{
          emit(job,'writing');const hash=await digest(job.payload);
          if(job.epoch===epoch&&enabled){await store.put({...job,digest:hash});failed.delete(job.id);emit(job,'saved');}
        }catch(error){
          if(job.epoch===epoch&&enabled){
            if(error.code==='RECOVERY_DELETED'){
              const latest=pending.get(job.id)||job;pending.delete(job.id);failed.delete(job.id);
              if(job.id===id){const isLatest=latest.sequence===sequence;id=newId();const replacement={...latest,id,sequence:isLatest?++sequence:latest.sequence,updatedAt:now()};pending.set(id,replacement);if(isLatest){lastPayload=replacement.payload;emit(replacement,'pending');}}
            }else if(!pending.has(job.id)){failed.set(job.id,job);emit(job,'error',error.message);if(job.id!==id)onBackgroundError(error.message);}
          }
        }
        finally{inflight=null;}
      }
    })().finally(()=>{running=null;if(enabled&&pending.size)return flush();});return running;
  }
  return {
    get id(){return id;},get enabled(){return enabled;},
    capture(state){
      if(!enabled)return;
      try{
        const encoded=encodeRecovery(state);if(encoded.payload===lastPayload)return;
        const retained=new Map([...failed,...pending]);retained.delete(id);
        const total=[...retained.values()].reduce((sum,j)=>sum+j.bytes,0)+(inflight?.bytes||0)+encoded.bytes;
        if(total>bufferLimit||retained.size>=RECOVERY_LIMITS.records)throw new Error('恢复写入积压，请重试或下载保存工程');
        const job={...encoded,id,epoch,sequence:++sequence,updatedAt:now(),name:String(state.project.name).slice(0,300),entities:state.project.entities.length,draftPoints:state.draft.length,units:state.project.units};
        pending.set(id,job);failed.delete(id);lastPayload=encoded.payload;emit(job,'pending');clearTimer();timer=setTimeout(flush,delay);
      }catch(error){sequence++;lastPayload=null;onStatus({status:'error',error:error.message});}
    },
    newContext(){flush();id=newId();sequence++;lastPayload=null;onStatus({status:enabled?'idle':'disabled'});},
    setEnabled(value){enabled=Boolean(value);epoch++;clearTimer();pending.clear();failed.clear();lastPayload=null;sequence++;onStatus({status:enabled?'idle':'disabled'});},
    async retry(){for(const [key,job] of failed)if(!pending.has(key))pending.set(key,job);failed.clear();await flush();},
    async remove(key){pending.delete(key);failed.delete(key);if(key===id){id=newId();lastPayload=null;sequence++;onStatus({status:enabled?'idle':'disabled'});}if(running)await running;await store.remove(key);},
    flush
  };
}
