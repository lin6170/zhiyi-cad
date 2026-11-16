import {validateProject} from './geometry.mjs';
import {moveSelection} from './selection.mjs';
import {PANTS_COMMAND,validatePantsDelta} from './pants-command.mjs';
import {syncAllowances} from './seams.mjs';
import {syncNotches} from './notches.mjs';
import {syncSeamChecks} from './seam-checks.mjs';
import {syncGradingPlans} from './grading.mjs';
import {syncMarkerPlans} from './marker.mjs';
import {DRAFT_COMMAND,appendPantsDraft} from './pants-draft.mjs';
import {findCommand,validateInput,commandSet,describeScene,COMMAND_SET_VERSION} from './cad-command-set.mjs';
const copy=x=>JSON.parse(JSON.stringify(x));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// What a command can change, without the bookkeeping fields that validation and syncing rewrite.
const fingerprint=p=>JSON.stringify([p.name,p.units,p.entities,p.groups,(p.seamAllowances||[]).map(r=>[r.id,r.baseEntityIds,r.outputIds.length,r.distance,r.widthMode,r.edgeWidths,r.join,r.corners||null]),p.metadata?.parametricDrafts||null]);
const finite=n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=100000;
const point=p=>p&&Object.keys(p).sort().join(',')==='x,y'&&finite(p.x)&&finite(p.y);
function keys(object,allowed){if(!object||typeof object!=='object'||Array.isArray(object)||Object.keys(object).some(k=>!allowed.includes(k)))throw Error('命令参数不受支持。');}

/** Every edit is staged and checked, then committed as one history transaction. */
export function createCadCommands({getProject,getRevision,canExecute,commit,undo,redo,history,getPantsSession,makeId=()=>crypto.randomUUID()}){
  const plans=new Map();
  function idle(){if(!canExecute())throw Error('请先完成或取消当前编辑，再运行命令。');}
  function revision(expected){if(!Number.isSafeInteger(expected)||expected!==getRevision())throw Error('工程版本已经变化，请重新生成计划。');}
  function describe(){return {schema:'zhiyi-cad-commands/v1',commands:[
    {type:'line.add',parameters:['points: [Point, Point]','units: mm | source']},
    {type:'selection.translate',parameters:['entityIds: string[]','dx: number','dy: number','units: mm | source']},
    {type:'line.moveEndpoint',parameters:['entityId: string','endpoint: 0 | 1','point: Point','units: mm | source']},
    {type:PANTS_COMMAND,parameters:['deltaMm: -100..100, nonzero, 0.1 mm'],requires:'verified private template profile'},
    {type:DRAFT_COMMAND,parameters:['measurements: body dimensions in mm','rules: demonstration formula parameters'],requires:'empty canvas or millimetre project; no PRJ template'},
    {type:'history.undo',parameters:[]},{type:'history.redo',parameters:[]},
    ...commandSet.filter(c=>c.type!==DRAFT_COMMAND).map(c=>({type:c.type,title:c.title,parameters:'catalog()'}))
  ],catalog:COMMAND_SET_VERSION,contract:'preview({schema,type,expectedRevision,parameters}) or previewBatch({schema,expectedRevision,steps}) → apply(planId); failure leaves project/history unchanged'};}
  function read(){return {revision:getRevision(),name:getProject().name,units:getProject().units,entityCount:getProject().entities.length,groupCount:getProject().groups.length,...history()};}
  // Run one command on a detached project. The result is synced and validated before anyone sees it.
  function runStep(before,type,p){
    let next=copy(before),summary={},measurements=[],created=null;
    const units=()=>{if(p.units!==(before.units==='mm'?'mm':'source'))throw Error('命令单位与工程不一致。');};
    const extra=findCommand(type);
    if(type===DRAFT_COMMAND){
      keys(p,['measurements','rules']);const result=appendPantsDraft(before,p,makeId);next=result.project;summary=result.summary;measurements=result.measurements;created=next.metadata.parametricDrafts.at(-1).id;
    }else if(type===PANTS_COMMAND){
      keys(p,['deltaMm']);validatePantsDelta(p.deltaMm);const session=getPantsSession();if(!session)throw Error('请先加载并核对本母版的改版规则。');
      const result=session.plan(before,p);next=result.project;summary=result.summary;measurements=result.measurements;
    }else if(type==='line.add'){
      keys(p,['points','units']);units();if(!Array.isArray(p.points)||p.points.length!==2||!p.points.every(point)||equal(p.points[0],p.points[1]))throw Error('直线需要两个不同的有效端点。');
      next.entities.push({id:makeId(),type:'polyline',points:copy(p.points),closed:false,name:'命令新增直线',layer:'outline'});
    }else if(type==='selection.translate'){
      keys(p,['entityIds','dx','dy','units']);units();
      if(!Array.isArray(p.entityIds)||!p.entityIds.length||p.entityIds.length>30000||new Set(p.entityIds).size!==p.entityIds.length||!finite(p.dx)||!finite(p.dy)||(!p.dx&&!p.dy))throw Error('移动参数无效。');
      const ids=new Set(p.entityIds);if([...ids].some(id=>!next.entities.some(e=>e.id===id)))throw Error('移动对象不存在。');
      for(const group of next.groups)if(group.entityIds.some(id=>ids.has(id))&&!group.entityIds.every(id=>ids.has(id)))throw Error('命令移动需包含完整裁片，不能遗漏关联对象。');
      moveSelection(next,ids,p.dx,p.dy);
    }else if(type==='line.moveEndpoint'){
      keys(p,['entityId','endpoint','point','units']);units();const e=next.entities.find(e=>e.id===p.entityId);
      if(!e||e.type==='text'||e.curve||e.closed||e.points.length!==2||e.derivedFrom||e.notchFrom||![0,1].includes(p.endpoint)||!point(p.point)||next.groups.some(g=>g.entityIds.includes(e.id)))throw Error('当前端点命令仅支持开放的独立直线。');
      if(equal(e.points[1-p.endpoint],p.point))throw Error('端点重合会产生零长度线。');
      e.points[p.endpoint]=copy(p.point);if(e.source)e.source.modified=true;
    }else if(extra?.run){
      validateInput(extra.input_schema,p);const result=extra.run(next,p,{makeId});summary=result.summary||{};measurements=result.measurements||[];created=result.created||null;
    }else throw Error('未知的编辑命令。');
    syncAllowances(next,makeId);syncNotches(next,makeId);syncSeamChecks(next);syncGradingPlans(next);syncMarkerPlans(next);
    validateProject(next);
    if(fingerprint(next)===fingerprint(before))throw Error('命令没有产生修改。');
    return {next,summary,measurements,created};
  }
  function difference(before,next){
    const oldMap=new Map(before.entities.map(e=>[e.id,e])),kept=new Set(next.entities.map(e=>e.id));
    return {changes:next.entities.filter(e=>!equal(e,oldMap.get(e.id))).map(e=>({id:e.id,before:oldMap.get(e.id)||null,after:e})),removed:before.entities.filter(e=>!kept.has(e.id)).map(e=>({id:e.id,before:e}))};
  }
  function preview(command){
    idle();keys(command,['schema','type','expectedRevision','parameters']);revision(command.expectedRevision);
    if(command.schema!=='zhiyi-cad-command/v1')throw Error('命令版本不受支持。');
    const before=copy(getProject()),{next,summary,measurements}=runStep(before,command.type,command.parameters),{changes,removed}=difference(before,next);
    const id=makeId();plans.clear();plans.set(id,{before,next,revision:getRevision(),command:copy(command),changes,summary,measurements});
    return copy({id,revision:getRevision(),type:command.type,summary,measurements,changes,removed});
  }
  // Several commands as one plan: either every step succeeds and the plan can be applied as a single undo step, or nothing changes.
  // A step may be named with "as"; in a later step, "@name" in a parameter that takes an object id stands for the object that step created.
  function previewBatch(batch){
    idle();keys(batch,['schema','expectedRevision','steps','label']);revision(batch.expectedRevision);
    if(batch.schema!=='zhiyi-cad-batch/v1')throw Error('批量命令版本不受支持。');
    if(!Array.isArray(batch.steps)||!batch.steps.length||batch.steps.length>200)throw Error('批量命令需要 1 至 200 步。');
    if(batch.label!==undefined&&(typeof batch.label!=='string'||batch.label.length>200))throw Error('批量命令的说明无效。');
    const before=copy(getProject()),refs=new Map(),steps=[];let current=before;
    const missing=name=>{throw Error('引用了尚未创建的对象 @'+name+'。');};
    // Only parameters that name objects (…Id, …Ids) are references, so a text or a name may start with "@".
    const resolve=(value,key='')=>typeof value==='string'?(/Ids?$/.test(key)&&value.startsWith('@')?(refs.has(value.slice(1))?refs.get(value.slice(1)):missing(value.slice(1))):value):Array.isArray(value)?value.map(item=>resolve(item,key)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v,k)])):value;
    batch.steps.forEach((step,index)=>{
      try{
        keys(step,['type','parameters','as']);
        if(typeof step.type!=='string'||['history.undo','history.redo'].includes(step.type))throw Error('批量命令不能包含撤销或重做。');
        if(step.as!==undefined&&(typeof step.as!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(step.as)||refs.has(step.as)))throw Error('步骤名称无效或重复。');
        const result=runStep(current,step.type,resolve(copy(step.parameters)));
        if(step.as){if(!result.created)throw Error('这一步没有可供引用的新对象。');refs.set(step.as,result.created);}
        current=result.next;steps.push({index:index+1,type:step.type,summary:result.summary,measurements:result.measurements,created:result.created});
      }catch(error){throw Object.assign(Error('第 '+(index+1)+' 步（'+(findCommand(step?.type)?.title||step?.type||'未知命令')+'）：'+error.message),{step:index+1,...(error.code?{code:error.code}:{})});}
    });
    const {changes,removed}=difference(before,current),id=makeId();
    plans.clear();plans.set(id,{before,next:current,revision:getRevision(),command:{type:'batch',label:batch.label||'',steps:copy(batch.steps)},changes,summary:{steps:steps.length},measurements:[]});
    return copy({id,revision:getRevision(),type:'batch',label:batch.label||'',steps,changes,removed,counts:{added:changes.filter(c=>!c.before).length,changed:changes.filter(c=>c.before).length,removed:removed.length}});
  }
  function apply(id){
    idle();const plan=plans.get(id);if(!plan)throw Error('计划不存在或已经失效。');revision(plan.revision);
    if(!equal(getProject(),plan.before))throw Error('工程在预览后改变，请重新预览。');
    commit(copy(plan.next),plan.changes.map(c=>c.id));plans.clear();return {...read(),applied:plan.command.type};
  }
  function historyCommand(type,expected){idle();revision(expected);const h=history();if(type==='history.undo'?!h.canUndo:!h.canRedo)throw Error(type==='history.undo'?'没有可以撤销的修改。':'没有可以重做的修改。');plans.clear();(type==='history.undo'?undo:redo)();return read();}
  function execute(command){if(['history.undo','history.redo'].includes(command?.type)){keys(command,['schema','type','expectedRevision','parameters']);if(command.schema!=='zhiyi-cad-command/v1')throw Error('命令版本不受支持。');keys(command.parameters,[]);return historyCommand(command.type,command.expectedRevision);}return apply(preview(command).id);}
  const catalog=()=>({version:COMMAND_SET_VERSION,units:'mm',commands:commandSet.map(c=>copy({type:c.type,title:c.title,description:c.description,input_schema:c.input_schema}))});
  const scene=()=>({revision:getRevision(),...describeScene(copy(getProject()))});
  return Object.freeze({describe,read,readProject:()=>copy(getProject()),preview,previewBatch,apply,execute,catalog,scene,clear:()=>plans.clear()});
}
