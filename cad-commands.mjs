import {validateProject} from './geometry.mjs';
import {moveSelection} from './selection.mjs';
import {PANTS_COMMAND} from './pants-command.mjs';
import {syncAllowances} from './seams.mjs';
import {syncNotches} from './notches.mjs';
import {syncSeamChecks} from './seam-checks.mjs';
import {syncGradingPlans} from './grading.mjs';
import {syncMarkerPlans} from './marker.mjs';
const copy=x=>JSON.parse(JSON.stringify(x));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
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
    {type:PANTS_COMMAND,parameters:['deltaMm: 20'],requires:'verified private template profile'},
    {type:'history.undo',parameters:[]},{type:'history.redo',parameters:[]}
  ],contract:'preview({schema,type,expectedRevision,parameters}) → apply(planId); failure leaves project/history unchanged'};}
  function read(){return {revision:getRevision(),name:getProject().name,units:getProject().units,entityCount:getProject().entities.length,groupCount:getProject().groups.length,...history()};}
  function preview(command){
    idle();keys(command,['schema','type','expectedRevision','parameters']);revision(command.expectedRevision);
    if(command.schema!=='zhiyi-cad-command/v1')throw Error('命令版本不受支持。');
    const before=copy(getProject()),p=command.parameters;let next=copy(before),summary={},measurements=[];
    const units=()=>{if(p.units!==(before.units==='mm'?'mm':'source'))throw Error('命令单位与工程不一致。');};
    if(command.type===PANTS_COMMAND){
      keys(p,['deltaMm']);if(p.deltaMm!==20)throw Error('当前加长量仅支持 20 mm。');const session=getPantsSession();if(!session)throw Error('请先加载并核对本母版的改版规则。');
      const result=session.plan(before,p);next=result.project;summary=result.summary;measurements=result.measurements;
    }else if(command.type==='line.add'){
      keys(p,['points','units']);units();if(!Array.isArray(p.points)||p.points.length!==2||!p.points.every(point)||equal(p.points[0],p.points[1]))throw Error('直线需要两个不同的有效端点。');
      next.entities.push({id:makeId(),type:'polyline',points:copy(p.points),closed:false,name:'命令新增直线',layer:'outline'});
    }else if(command.type==='selection.translate'){
      keys(p,['entityIds','dx','dy','units']);units();
      if(!Array.isArray(p.entityIds)||!p.entityIds.length||p.entityIds.length>30000||new Set(p.entityIds).size!==p.entityIds.length||!finite(p.dx)||!finite(p.dy)||(!p.dx&&!p.dy))throw Error('移动参数无效。');
      const ids=new Set(p.entityIds);if([...ids].some(id=>!next.entities.some(e=>e.id===id)))throw Error('移动对象不存在。');
      for(const group of next.groups)if(group.entityIds.some(id=>ids.has(id))&&!group.entityIds.every(id=>ids.has(id)))throw Error('命令移动需包含完整裁片，不能遗漏关联对象。');
      moveSelection(next,ids,p.dx,p.dy);
    }else if(command.type==='line.moveEndpoint'){
      keys(p,['entityId','endpoint','point','units']);units();const e=next.entities.find(e=>e.id===p.entityId);
      if(!e||e.type==='text'||e.curve||e.closed||e.points.length!==2||e.derivedFrom||e.notchFrom||![0,1].includes(p.endpoint)||!point(p.point)||next.groups.some(g=>g.entityIds.includes(e.id)))throw Error('当前端点命令仅支持开放的独立直线。');
      if(equal(e.points[1-p.endpoint],p.point))throw Error('端点重合会产生零长度线。');
      e.points[p.endpoint]=copy(p.point);if(e.source)e.source.modified=true;
    }else throw Error('未知的编辑命令。');
    syncAllowances(next,makeId);syncNotches(next,makeId);syncSeamChecks(next);syncGradingPlans(next);syncMarkerPlans(next);
    validateProject(next);const oldMap=new Map(before.entities.map(e=>[e.id,e]));
    const changes=next.entities.filter(e=>!equal(e,oldMap.get(e.id))).map(e=>({id:e.id,before:oldMap.get(e.id)||null,after:e}));
    if(!changes.length)throw Error('命令没有产生修改。');
    const id=makeId();plans.clear();plans.set(id,{before,next,revision:getRevision(),command:copy(command),changes,summary,measurements});
    return copy({id,revision:getRevision(),type:command.type,summary,measurements,changes});
  }
  function apply(id){
    idle();const plan=plans.get(id);if(!plan)throw Error('计划不存在或已经失效。');revision(plan.revision);
    if(!equal(getProject(),plan.before))throw Error('工程在预览后改变，请重新预览。');
    commit(copy(plan.next),plan.changes.map(c=>c.id));plans.clear();return {...read(),applied:plan.command.type};
  }
  function historyCommand(type,expected){idle();revision(expected);const h=history();if(type==='history.undo'?!h.canUndo:!h.canRedo)throw Error(type==='history.undo'?'没有可以撤销的修改。':'没有可以重做的修改。');plans.clear();(type==='history.undo'?undo:redo)();return read();}
  function execute(command){if(['history.undo','history.redo'].includes(command?.type)){keys(command,['schema','type','expectedRevision','parameters']);if(command.schema!=='zhiyi-cad-command/v1')throw Error('命令版本不受支持。');keys(command.parameters,[]);return historyCommand(command.type,command.expectedRevision);}return apply(preview(command).id);}
  return Object.freeze({describe,read,readProject:()=>copy(getProject()),preview,apply,execute,clear:()=>plans.clear()});
}
