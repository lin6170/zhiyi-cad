import { generateNotches } from './notches.mjs';
import { pathMetrics } from './path-metrics.mjs';

export function normalizeLocator(input){
  if(!input||!['start','end','ratio','notch'].includes(input.kind))throw new Error('分界点定位方式无效');
  if(input.kind==='notch'){
    if(typeof input.notchId!=='string'||!input.notchId||![1,2,3].includes(input.count)||!Number.isInteger(input.ordinal)||input.ordinal<0||input.ordinal>=input.count)throw new Error('分界点刀口引用无效');
    return {kind:'notch',notchId:input.notchId,ordinal:input.ordinal,count:input.count};
  }
  if(!Number.isFinite(input.value)||input.value<0||input.value>(input.kind==='ratio'?100:1e8))throw new Error('分界点距离或比例无效');
  return {kind:input.kind,value:input.value};
}
export function reconcileSectionTargets(landmarks,previous=[],tolerance=.5){
  const ids=['start',...landmarks.map(mark=>mark.id),'end'];
  return ids.slice(1).map((to,i)=>{
    const from=ids[i],prior=previous.find(target=>target.from===from&&target.to===to);
    return prior?{...prior}:{from,to,easeMode:'mm',easeValue:0,tolerance};
  });
}
export function normalizeSections(value){
  const checkMode=value.checkMode??'whole';
  if(!['whole','sections'].includes(checkMode))throw new Error('缝合核对模式无效');
  if(checkMode==='whole')return {checkMode,landmarks:[],sectionTargets:[]};
  if(!Array.isArray(value.landmarks)||value.landmarks.length>30)throw new Error('分段核对最多支持 30 对分界点');
  const seen=new Set(['start','end']);
  const landmarks=value.landmarks.map(mark=>{
    if(!mark||typeof mark.id!=='string'||!mark.id||mark.id.length>200||seen.has(mark.id))throw new Error('分界点 ID 无效或重复');
    seen.add(mark.id);
    return {id:mark.id,name:String(mark.name||'分界点').slice(0,100),a:normalizeLocator(mark.a),b:normalizeLocator(mark.b)};
  });
  const expected=reconcileSectionTargets(landmarks);
  if(!Array.isArray(value.sectionTargets)||value.sectionTargets.length!==expected.length)throw new Error('分段目标数量与分界点不符');
  const sectionTargets=value.sectionTargets.map((target,i)=>{
    if(!target||target.from!==expected[i].from||target.to!==expected[i].to)throw new Error('分段目标顺序与分界点不符，请重新确认各段吃势');
    if(!['mm','percent'].includes(target.easeMode)||!Number.isFinite(target.easeValue)||Math.abs(target.easeValue)>1e6||!Number.isFinite(target.tolerance)||target.tolerance<0||target.tolerance>1e4)throw new Error('分段吃势或容差无效');
    return {from:target.from,to:target.to,easeMode:target.easeMode,easeValue:target.easeValue,tolerance:target.tolerance};
  });
  return {checkMode,landmarks,sectionTargets};
}
export function resolveSectionLandmarks(project,config,a,b,chainPoint){
  const cache=new Map();
  function position(locator,chain){
    if(locator.kind!=='notch')return {value:locator.kind==='ratio'?chain.length*locator.value/100:locator.kind==='end'?chain.length-locator.value:locator.value};
    const recipe=project.notches?.find(item=>item.id===locator.notchId);
    if(!recipe)throw new Error('引用的关联刀口已缺失或解除关联');
    if(recipe.count!==locator.count)throw new Error('引用的刀口数量已变化，请重新选择具体刀口');
    const output=project.entities.find(entity=>entity.id===recipe.outputIds?.[locator.ordinal]);
    if(!output||output.notchFrom!==recipe.id)throw new Error('引用的刀口输出已缺失或解除关联');
    if(recipe.status==='error')throw new Error('引用的刀口已失效：'+recipe.error);
    if(!cache.has(recipe.id)){
      const generated=generateNotches(project,recipe.baseEntityId,recipe);
      const base=project.entities.find(entity=>entity.id===recipe.baseEntityId);
      cache.set(recipe.id,{generated,metrics:pathMetrics(base)});
    }
    const {generated,metrics}=cache.get(recipe.id),station=generated.stations[locator.ordinal].position,candidates=[];
    for(const edge of chain.edges){
      if(edge.ref.entityId!==recipe.baseEntityId)continue;
      let local=station;
      if(edge.ref.segmentIndex!==null){
        const base=project.entities.find(entity=>entity.id===recipe.baseEntityId);
        let prefix=0;for(let i=0;i<edge.ref.segmentIndex;i++)prefix+=Math.hypot(base.points[i+1].x-base.points[i].x,base.points[i+1].y-base.points[i].y);
        local-=prefix;
      }
      const epsilon=metrics.uncertainty+Number.EPSILON*metrics.total*32;
      if(local< -epsilon||local>edge.metrics.total+epsilon)continue;
      local=Math.max(0,Math.min(edge.metrics.total,local));
      candidates.push(edge.offset+(edge.ref.reverse?edge.metrics.total-local:local)-chain.trimStart);
    }
    if(!candidates.length)throw new Error('引用的刀口不在所选缝合边上');
    if(candidates.some(value=>Math.abs(value-candidates[0])>1e-7))throw new Error('刀口对应多个沿线位置，请重新选边');
    // A source station can depend on the full source path, beyond selected edges.
    chain.uncertainty+=metrics.uncertainty+Number.EPSILON*metrics.total*32;
    return {value:candidates[0],point:generated.stations[locator.ordinal].point};
  }
  let previousA=0,previousB=0;
  return config.landmarks.map((mark,i)=>{
    const resolvedA=position(mark.a,a),resolvedB=position(mark.b,b),pa=resolvedA.value,pb=resolvedB.value;
    for(const [label,p,previous,chain] of [['A',pa,previousA,a],['B',pb,previousB,b]]){
      if(!Number.isFinite(p)||p<=1e-7||p>=chain.length-1e-7)throw new Error('第 '+(i+1)+' 对分界点的 '+label+' 位置必须位于扣除后的缝线内部');
      if(p<=previous+1e-7)throw new Error(label+' 侧分界点顺序交叉或重合，请按缝合顺序确认对应关系');
    }
    previousA=pa;previousB=pb;
    return {id:mark.id,name:mark.name,a:pa,b:pb,aPoint:resolvedA.point||chainPoint(a,pa),bPoint:resolvedB.point||chainPoint(b,pb)};
  });
}
export function reverseSectionDefinition(value,reverseSide){
  const next={...value,landmarks:(value.landmarks||[]).map(mark=>({...mark,a:{...mark.a},b:{...mark.b}})),sectionTargets:(value.sectionTargets||[]).map(target=>({...target}))};
  for(const side of ['a','b'])next[side]=reverseSide(next[side]);
  if(next.checkMode!=='sections')return next;
  const reverseLocator=locator=>locator.kind==='notch'?locator:locator.kind==='ratio'?{...locator,value:100-locator.value}:{...locator,kind:locator.kind==='start'?'end':'start'};
  next.landmarks.reverse();
  for(const mark of next.landmarks)for(const side of ['a','b'])mark[side]=reverseLocator(mark[side]);
  const endpoint=id=>id==='start'?'end':id==='end'?'start':id;
  next.sectionTargets=next.sectionTargets.slice().reverse().map(target=>({...target,from:endpoint(target.to),to:endpoint(target.from)}));
  return next;
}
