import {fitClampedSpline,changedSpline,fitParameters,mapFitParameter} from './fit-spline.mjs';
import {evaluateBSpline,refreshCurve} from './curves.mjs';
import {reconstructSpline} from './spline.mjs';
import {pathMetrics} from './path-metrics.mjs';
import {validatePantsDelta} from './pants-command.mjs';
export const PANTS_RULE_SCHEMA='zhiyi-web-pants-profile/v3';
const copy=x=>JSON.parse(JSON.stringify(x)),dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const finite=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.abs(p.x)<100000&&Math.abs(p.y)<100000;
const near=(a,b,t=.002)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((p,i)=>finite(p)&&finite(b[i])&&dist(p,b[i])<=t);
const fits=e=>e.source?.recordKind===2?e.points:e.source?.fitPoints;
const ends=e=>[fits(e)?.[0],fits(e)?.at(-1)];
const getMap=p=>new Map(p.entities.filter(e=>e.source?.recordKind).map(e=>[e.source.sourceId,e]));
function clamped(e){
  const f=fits(e),c=e.source?.controlPoints;
  return e.source?.recordKind===4&&e.curve&&f?.length>=2&&f.length<=128&&c?.length===f.length+2&&dist(c[0],c[1])<.00001&&dist(c.at(-1),c.at(-2))<.00001;
}
function geometry(e){return {id:e.source.sourceId,kind:e.source.recordKind,fit:copy(fits(e)),...(e.curve?{controls:copy(e.source.controlPoints)}:{})};}
function restore(e,ref){
  const next=copy(e);delete next.source.modified;
  if(ref.kind===4){const rebuilt=reconstructSpline(ref.fit,ref.controls);next.source.fitPoints=copy(ref.fit);next.source.controlPoints=copy(ref.controls);next.curve={...next.curve,controlPoints:rebuilt.controlPoints,knots:rebuilt.knots};refreshCurve(next);}
  else {next.points=copy(ref.fit);}
  return next;
}
function straight(e,tolerance){
  const [a,b]=ends(e)||[],len=a&&b&&dist(a,b);if(!len||len<tolerance*10)return false;
  return e.points.every(p=>Math.abs((p.x-a.x)*(b.y-a.y)-(p.y-a.y)*(b.x-a.x))/len<=tolerance);
}
export function pantsRuleChoices(project){
  const byId=new Map(project.entities.map(e=>[e.id,e]));
  return project.groups.filter(g=>g.source?.sourceId&&g.entityIds.length).map(g=>({id:g.source.sourceId,name:g.name||'未命名裁片',curves:g.entityIds.map(id=>byId.get(id)).filter(e=>[2,4].includes(e?.source?.recordKind)).map(e=>({id:e.source.sourceId,entity:e,primary:g.contours?.[0]?.entityIds.includes(e.id)||false}))}));
}
/** Discover only bounded lower-leg structures. Unknown curves in the moving
 * region fail closed; the operator sees every included curve before applying. */
function discover(project,selection,mm,bandMm){
  const map=getMap(project),group=project.groups.find(g=>g.source?.sourceId===selection.pieceId);
  if(!group)throw Error('请选择文件中的裤片。');
  const curves=group.entityIds.map(id=>project.entities.find(e=>e.id===id)).filter(e=>e?.source?.recordKind);
  const knee=map.get(selection.kneeId),hem=map.get(selection.hemId),belongs=e=>e&&group.entityIds.includes(e.id);
  if(!belongs(knee)||!belongs(hem)||knee===hem)throw Error(group.name+'：请分别指定本片的膝线和裤脚。');
  const primary=new Set(group.contours?.[0]?.entityIds||[]);
  if(!primary.has(hem.id))throw Error(group.name+'：裤脚请选择净样轮廓的脚口线。');
  if(!straight(knee,.1/mm)||!straight(hem,.2/mm))throw Error(group.name+'：当前规则要求膝线和脚口为直线或近直线。');
  const [ka,kb]=ends(knee),[ha,hb]=ends(hem),length=dist(ka,kb);
  let axis={x:-(kb.y-ka.y)/length,y:(kb.x-ka.x)/length};
  const station=p=>(p.x-ka.x)*axis.x+(p.y-ka.y)*axis.y;
  if(station(ha)+station(hb)<0)axis={x:-axis.x,y:-axis.y};
  const hemMin=Math.min(station(ha),station(hb)),hemMax=Math.max(station(ha),station(hb));
  if(hemMin*mm<150||Math.abs(hemMax-hemMin)*mm>10)throw Error(group.name+'：膝脚距离须至少 150 mm，脚口与膝线的倾斜差不能超过 10 mm。请核对定位线和单位。');
  const sides=[ha,hb].map(end=>{
    const matches=curves.filter(e=>primary.has(e.id)&&e!==hem&&[2,4].includes(e.source.recordKind)&&ends(e).some(p=>dist(p,end)*mm<.05)&&ends(e).some(p=>Math.abs(station(p))*mm<.1));
    if(matches.length!==1)throw Error(group.name+'：净样侧缝须在所选膝线处分段，并连接到脚口端点；请先在 ET 整理分段。');
    const e=matches[0],f=fits(e),moving=dist(f[0],end)<dist(f.at(-1),end)?0:f.length-1;
    if(e.source.recordKind===4&&!clamped(e))throw Error(group.name+'：下段侧缝的样条结构暂不支持。');
    if(e.points.some(p=>station(p)*mm<-.1))throw Error(group.name+'：下段侧缝越过膝线。');
    const stationary=moving===0?1:f.length-2;
    return {id:e.source.sourceId,moving,stationary};
  });
  if(sides[0].id===sides[1].id)throw Error('左右侧缝不能是同一条线。');
  if(sides.some(s=>{const f=fits(map.get(s.id));return (station(f[s.moving])-station(f[s.stationary]))*mm<=bandMm+5;}))throw Error(group.name+'：裤脚整体移动区接近下段固定点，请缩小移动区。');
  const used=new Set([selection.kneeId,selection.hemId,...sides.map(s=>s.id)]),seams=[];
  for(const side of sides){
    const base=map.get(side.id),[a,b]=ends(base),candidates=curves.filter(e=>!used.has(e.source.sourceId)&&!primary.has(e.id)&&clamped(e)).map(e=>{
      const [c,d]=ends(e),forward=dist(a,c)+dist(b,d),reverse=dist(a,d)+dist(b,c);
      return {e,score:Math.min(forward,reverse),reversed:reverse<forward};
    }).filter(c=>c.score*mm<=60).sort((a,b)=>a.score-b.score);
    if(candidates.length>1&&Math.abs(candidates[0].score-candidates[1].score)*mm<2)throw Error(group.name+'：侧缝的缝份关联不唯一，暂不能自动建立规则。');
    if(candidates.length){const c=candidates[0];used.add(c.e.source.sourceId);seams.push({id:c.e.source.sourceId,sideId:side.id,reversed:c.reversed});}
  }
  const translate=[selection.hemId],cutoff=hemMin-bandMm/mm;
  for(const e of curves){
    const id=e.source.sourceId;if(used.has(id))continue;
    const points=fits(e)||e.points,min=Math.min(...points.map(station)),max=Math.max(...points.map(station));
    if(max*mm<=3)continue; // untouched upper seam join can sit slightly below the knee
    if(min>=cutoff){
      if(![2,4].includes(e.source.recordKind)||e.source.recordKind===4&&!clamped(e))throw Error(group.name+'：裤脚区域有暂不支持的曲线 #'+id+'。');
      translate.push(id);used.add(id);continue;
    }
    throw Error(group.name+'：线 #'+id+' 跨越未定义的联动区域，请调整裤脚整体移动区或先整理线条分段。');
  }
  if(curves.some(e=>![2,4].includes(e.source.recordKind)))throw Error(group.name+'：当前裁片含未支持的几何类型。');
  // Grainlines and text are retained. Do not claim those are geometric seams.
  return {...selection,name:group.name,axis,origin:copy(ka),sides,seams,translate,refs:curves.map(geometry)};
}
export function createUserPantsRule(project,{name='我的裤长规则',mmPerSourceUnit,hemBandMm=40,pieces}){
  if(![1,10].includes(mmPerSourceUnit))throw Error('请明确选择 PRJ 原文件的单位：毫米或厘米。');
  if(!Number.isFinite(hemBandMm)||hemBandMm<5||hemBandMm>100)throw Error('裤脚整体移动区须在 5～100 mm 之间。');
  if(!Array.isArray(pieces)||pieces.length!==2||pieces[0].pieceId===pieces[1].pieceId)throw Error('请选择两个不同的前、后裤片。');
  if(project.units!=='unknown'||project.entities.some(e=>e.source?.modified))throw Error('请在刚打开的 PRJ 上建立规则。');
  const mapped=pieces.map(s=>discover(project,{pieceId:s.pieceId,kneeId:s.kneeId,hemId:s.hemId},mmPerSourceUnit,hemBandMm));
  const all=mapped.flatMap(r=>r.refs.map(e=>e.id));
  if(new Set(all).size!==all.length)throw Error('前后片共享曲线，暂不支持独立改裤长。');
  return {schema:PANTS_RULE_SCHEMA,name:String(name).trim().slice(0,80)||'我的裤长规则',mmPerSourceUnit,hemBandMm,pieces:mapped};
}
export function validateUserPantsRule(profile){
  if(profile?.schema!==PANTS_RULE_SCHEMA||typeof profile.name!=='string'||profile.name.length>80||![1,10].includes(profile.mmPerSourceUnit)||!Number.isFinite(profile.hemBandMm)||profile.hemBandMm<5||profile.hemBandMm>100||profile.pieces?.length!==2)throw Error('自定义裤长规则格式无效。');
  const ids=[];
  for(const r of profile.pieces){
    if(![r.pieceId,r.kneeId,r.hemId].every(Number.isSafeInteger)||!Array.isArray(r.refs)||r.refs.length<3||r.refs.length>500)throw Error('规则裁片身份无效。');
    for(const e of r.refs){
      ids.push(e.id);
      if(!Number.isSafeInteger(e.id)||![2,4].includes(e.kind)||!Array.isArray(e.fit)||e.fit.length<2||e.fit.length>1000||!e.fit.every(finite)||e.kind===2&&e.fit.length!==2||e.kind===4&&(!Array.isArray(e.controls)||e.controls.length!==e.fit.length+2||!e.controls.every(finite)))throw Error('规则中的原始几何无效。');
    }
  }
  if(new Set(ids).size!==ids.length)throw Error('规则中的曲线身份重复。');
  return copy(profile);
}
function closest(curve,p){
  const end=curve.knots.at(-1),at=t=>evaluateBSpline(curve.controlPoints,curve.knots,t,curve.degree),d=t=>dist(at(t),p);
  let best=0;for(let i=1;i<=256;i++)if(d(end*i/256)<d(end*best/256))best=i;
  let a=end*Math.max(0,best-1)/256,b=end*Math.min(256,best+1)/256;
  for(let i=0;i<40;i++){const u=a+(b-a)/3,v=b-(b-a)/3;if(d(u)<d(v))b=v;else a=u;}
  return (a+b)/2;
}
function changedEntity(e,g){if(e.source.recordKind===4)return changedSpline(e,g);const n=copy(e);n.points=copy(g.fit);n.source.modified=true;return n;}
function fromFits(e,fit){return e.source.recordKind===4?fitClampedSpline(fit):{fit:copy(fit),controls:null};}
function calculate(project,profile,total){
  const byId=getMap(project),changes=new Map(),mm=profile.mmPerSourceUnit;
  for(const r of profile.pieces){
    const move=p=>({x:Math.fround(p.x+r.axis.x*total/mm),y:Math.fround(p.y+r.axis.y*total/mm)});
    const add=(id,g,mode)=>{const before=byId.get(id);changes.set(id,{before,after:changedEntity(before,g),geometry:g,mode});};
    for(const id of r.translate){
      const e=byId.get(id),fit=fits(e).map(move);
      const g=e.source.recordKind===4?{fit,controls:e.source.controlPoints.map(move),parameters:fitParameters(fit)}:{fit,controls:null};
      if(g.controls){const s=reconstructSpline(g.fit,g.controls);g.curve={...copy(e.curve),controlPoints:s.controlPoints,knots:s.knots};}
      add(id,g,'translate');
    }
    for(const side of r.sides){
      const e=byId.get(side.id),fit=copy(fits(e));fit[side.moving]=move(fit[side.moving]);
      const gap=(fit[side.moving].x-fit[side.stationary].x)*r.axis.x+(fit[side.moving].y-fit[side.stationary].y)*r.axis.y;
      if(gap*mm<5)throw Error(r.name+'：缩短后裤脚过于接近下段固定点，请减少缩短量。');
      add(side.id,fromFits(e,fit),'refit');
    }
    for(const seam of r.seams){
      const side=r.sides.find(s=>s.id===seam.sideId),e=byId.get(seam.id),base=byId.get(side.id),after=changes.get(side.id),f=fits(e);
      const moving=(side.moving===0)!==seam.reversed?0:f.length-1;
      const geometry=fromFits(e,f.map((p,i)=>{
        if(i===moving)return move(p);if(i===0||i===f.length-1)return copy(p);
        if(base.curve){
          const t=closest(base.curve,p),q=evaluateBSpline(base.curve.controlPoints,base.curve.knots,t,3),u=mapFitParameter(t,fitParameters(fits(base)),after.geometry.parameters),v=evaluateBSpline(after.after.curve.controlPoints,after.after.curve.knots,u,3);
          return {x:Math.fround(p.x+v.x-q.x),y:Math.fround(p.y+v.y-q.y)};
        }
        const [a,b]=ends(base),dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy))),w=side.moving===0?1-t:t;
        return {x:Math.fround(p.x+r.axis.x*total/mm*w),y:Math.fround(p.y+r.axis.y*total/mm*w)};
      }));add(seam.id,geometry,'refit');
    }
  }
  return changes;
}
export function verifyUserPantsContinuation(project,input){
  const profile=validateUserPantsRule(input),map=getMap(project),baseline=copy(project),baseMap=getMap(baseline);
  if(map.size!==project.entities.filter(e=>e.source?.recordKind).length)throw Error('PRJ 曲线身份重复。');
  let total=null;
  for(const r of profile.pieces){
    const group=project.groups.find(g=>g.source?.sourceId===r.pieceId);
    if(!group)throw Error('此文件未找到规则对应的裤片。');
    const actual=group.entityIds.map(id=>project.entities.find(e=>e.id===id)).filter(e=>e?.source?.recordKind);
    if(actual.length!==r.refs.length)throw Error('裤片曲线数量改变，请重新建立规则。');
    for(const ref of r.refs){
      const e=map.get(ref.id);if(!e||e.source.recordKind!==ref.kind||!group.entityIds.includes(e.id))throw Error('裁片或曲线身份改变，请重新建立规则。');
      Object.assign(baseMap.get(ref.id),restore(e,ref));
    }
  }
  // Re-discover from trusted coordinates, never execute relationships supplied by JSON.
  const rebuilt=createUserPantsRule(baseline,{name:profile.name,mmPerSourceUnit:profile.mmPerSourceUnit,hemBandMm:profile.hemBandMm,pieces:profile.pieces});
  for(const r of rebuilt.pieces){
    const ref=r.refs.find(e=>e.id===r.hemId),hem=map.get(r.hemId),a=ref.fit[0],b=fits(hem)[0];
    const displacement=((b.x-a.x)*r.axis.x+(b.y-a.y)*r.axis.y)*profile.mmPerSourceUnit;
    if(total!==null&&Math.abs(total-displacement)>.003)throw Error('前后裤片累计改长量不一致。');
    total=displacement;
  }
  const rounded=Math.round(total*10)/10;
  if(Math.abs(total-rounded)>.003||Math.abs(rounded)>100)throw Error('累计改长量超出规则范围（±100 mm）。');
  const expected=calculate(baseline,rebuilt,rounded);
  for(const r of rebuilt.pieces)for(const ref of r.refs){
    const e=map.get(ref.id),want=expected.get(ref.id)?.geometry||ref;
    if(!near(fits(e),want.fit,.0003)||ref.kind===4&&!near(e.source.controlPoints,want.controls,.0003))throw Error('裤片几何已在规则外改变，请在当前文件重新建立规则。');
  }
  return {baseline,profile:rebuilt,totalDeltaMm:rounded};
}
export function planUserPantsContinuation(current,verified,deltaMm){
  validatePantsDelta(deltaMm);const total=Math.round((verified.totalDeltaMm+deltaMm)*10)/10;
  if(Math.abs(total)>100)throw Error('相对建立规则时的累计变化须在 ±100 mm 内。');
  const computed=calculate(verified.baseline,verified.profile,total),map=getMap(current),changes=[];
  for(const [id,c] of computed){
    const before=map.get(id);let g=c.geometry;
    if(total===0){const ref=verified.profile.pieces.flatMap(r=>r.refs).find(e=>e.id===id),base=getMap(verified.baseline).get(id);g={fit:copy(ref.fit),controls:ref.controls?copy(ref.controls):null,...(ref.controls?{parameters:fitParameters(ref.fit),curve:copy(base.curve)}:{})};}
    changes.push({...c,before,geometry:g,after:changedEntity(before,g)});
  }
  const changed=new Map(changes.map(c=>[c.before.id,c.after])),project=copy(current);project.entities=project.entities.map(e=>changed.get(e.id)||e);
  const measurements=verified.profile.pieces.map(r=>{const before=map.get(r.hemId),after=changed.get(before.id);return {piece:r.name,verticalDeltaMm:deltaMm,hemWidthBeforeMm:pathMetrics(before).total*verified.profile.mmPerSourceUnit,hemWidthAfterMm:pathMetrics(after).total*verified.profile.mmPerSourceUnit,kneePreserved:true};});
  if(measurements.some(m=>Math.abs(m.hemWidthAfterMm-m.hemWidthBeforeMm)>.003))throw Error('脚口宽度校验失败。');
  return {project,changes,measurements,summary:{operation:'pattern.extendPantsHem',deltaMm,totalDeltaMm:total,changedEntities:changes.length,pieces:measurements.map(m=>m.piece),unchanged:'膝线及上段净样、脚口宽、原文字和其他裁片',note:'沿各片膝线法向移动脚口，下段侧缝固定点保留；缝份随侧缝变形，尺寸表和纱向保留原值。'}};
}
