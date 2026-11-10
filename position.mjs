import { validateProject, textWidth } from './geometry.mjs';
import { duplicateSelection } from './selection.mjs';
import { assertIndependentTransform, syncAllowances } from './seams.mjs';
import { syncNotches } from './notches.mjs';
import { syncSeamChecks } from './seam-checks.mjs';
import { syncGradingPlans } from './grading.mjs';
import { prepareGradeVectorTransform } from './grading-schema.mjs';
import { syncMarkerPlans } from './marker.mjs';
import { transformMarkerGrains } from './transform-links.mjs';
import {degreeSinCos} from './angles.mjs';
const clone=value=>JSON.parse(JSON.stringify(value));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export const positionStamp=project=>JSON.stringify(project);
const validPoint=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.abs(p.x)<=1e8&&Math.abs(p.y)<=1e8;
function point(value,label){if(!validPoint(value))throw new Error(label+' 坐标须在 ±100000000 以内');return {x:value.x,y:value.y};}
function axis(a,b,label){const length=distance(a,b);if(length<1e-7)throw new Error(label+' 两点过近，无法确定方向');return {x:(b.x-a.x)/length,y:(b.y-a.y)/length,length};}
export function positionMatrix(value){
  if(!value||!['move','rotate','mirror','scale','align'].includes(value.operation))throw new Error('定位操作无效');
  const from=point(value.a,'基点 A');let to={...from},a=1,b=0,c=0,d=1,scale=1,angle=0,sourceLength=null,targetLength=null;
  if(value.operation==='move')to=point(value.targetA,'目标 A');
  if(value.operation==='rotate'){
    if(!Number.isFinite(value.angle)||Math.abs(value.angle)>360000)throw new Error('旋转角度须在 ±360000° 以内');
    angle=value.angle;const t=degreeSinCos(angle);a=t.c;b=t.s;c=-t.s;d=t.c;
  }
  if(value.operation==='mirror'){
    const end=point(value.b,'轴点 B'),u=axis(from,end,'镜像轴');a=u.x*u.x-u.y*u.y;b=c=2*u.x*u.y;d=-a;
  }
  if(value.operation==='scale')scale=value.factor;
  if(value.operation==='align'){
    if(typeof value.alignScale!=='boolean')throw new Error('对齐缩放设置无效');
    const end=point(value.b,'原图 B');to=point(value.targetA,'目标 A');const targetEnd=point(value.targetB,'目标 B'),s=axis(from,end,'原图基准'),t=axis(to,targetEnd,'目标基准');
    a=d=s.x*t.x+s.y*t.y;b=s.x*t.y-s.y*t.x;c=-b;angle=Math.atan2(b,a)*180/Math.PI;
    sourceLength=s.length;targetLength=t.length;if(value.alignScale)scale=t.length/s.length;
  }
  if(!Number.isFinite(scale)||scale<.001||scale>1000)throw new Error('均匀缩放比例须在 0.001 至 1000 之间');
  a*=scale;b*=scale;c*=scale;d*=scale;
  return {a,b,c,d,from,to,scale,angle,mirrored:value.operation==='mirror',sourceLength,targetLength,operation:value.operation};
}
export function positionVector(matrix,p){return {x:matrix.a*p.x+matrix.c*p.y,y:matrix.b*p.x+matrix.d*p.y};}
export function positionPoint(matrix,p){const v=positionVector(matrix,{x:p.x-matrix.from.x,y:p.y-matrix.from.y});return {x:matrix.to.x+v.x,y:matrix.to.y+v.y};}
function transformEntity(entity,matrix){
  // Transform text basis vectors analytically, avoiding subtraction of nearly
  // equal world-space corners for small lettering at large coordinates.
  if(entity.type==='text'){
    const radians=(entity.rotation||0)*Math.PI/180,v=positionVector(matrix,{x:Math.cos(radians),y:Math.sin(radians)});
    entity.width=(entity.width||textWidth(entity.text,entity.height))*matrix.scale;
    entity.height*=matrix.scale;entity.rotation=Math.atan2(v.y,v.x)*180/Math.PI;entity.mirrorY=Boolean(entity.mirrorY)!==matrix.mirrored;
  }
  entity.points=entity.points.map(p=>positionPoint(matrix,p));
  if(entity.curve)entity.curve={...entity.curve,controlPoints:entity.curve.controlPoints.map(p=>positionPoint(matrix,p)),knots:[...entity.curve.knots],samplingTolerance:(entity.curve.samplingTolerance??.002)*matrix.scale};
  if(entity.source)entity.source.modified=true;
}
function recipeIssues(project,selected){
  const related=new Set(selected),issues=[],affected=[];
  const record=(kind,recipe,needsReview)=>{affected.push({kind,id:recipe.id,name:recipe.name,status:recipe.status});if(needsReview)issues.push({kind,id:recipe.id,name:recipe.name,message:recipe.error||'结果需核对'});};
  for(const recipe of project.seamAllowances||[])if(recipe.baseEntityIds.some(id=>related.has(id))){record('缝份',recipe,recipe.status!=='current');for(const id of recipe.outputIds)related.add(id);}
  for(const recipe of project.notches||[])if(related.has(recipe.baseEntityId)||project.seamAllowances?.some(seam=>seam.id===recipe.targetSeamId&&seam.baseEntityIds.some(id=>related.has(id)))){record('刀口',recipe,recipe.status!=='current');for(const id of recipe.outputIds)related.add(id);}
  for(const check of project.seamChecks||[])if([...check.a.edges,...check.b.edges].some(ref=>related.has(ref.entityId)))record('对缝',check,check.status!=='current'||check.result?.status!=='match');
  for(const plan of project.gradingPlans||[])if(plan.sources.some(source=>related.has(source.entityId)))record('放码',plan,plan.status!=='current');
  for(const plan of project.markerPlans||[])if(plan.items.some(item=>item.memberIds.some(id=>related.has(id))||item.boundary.kind==='chain'&&item.boundary.entityIds.some(id=>related.has(id))))record('排料',plan,plan.status!=='current');
  return {issues,affected,related};
}
export function preparePosition(project,value,makeId){
  if(!value||typeof value.copy!=='boolean'||!Array.isArray(value.ids)||!value.ids.length||value.ids.length>30000||new Set(value.ids).size!==value.ids.length)throw new Error('请选择需要定位的图元');
  const matrix=positionMatrix(value),originalIds=new Set(value.ids),byId=new Map(project.entities.map(entity=>[entity.id,entity]));
  if(value.ids.some(id=>!byId.has(id)))throw new Error('选区包含已删除图元，请重新选择');
  const next=clone(project),counts=Object.fromEntries(['entities','groups','seamAllowances','notches','seamChecks','gradingPlans'].map(key=>[key,(project[key]||[]).length]));
  let selected=originalIds;
  if(value.copy)selected=duplicateSelection(next,originalIds,makeId,{offsetX:0,offsetY:0});
  assertIndependentTransform(next,selected);
  const commitGradeVectors=prepareGradeVectorTransform(next,selected,p=>positionVector(matrix,p));
  for(const entity of next.entities)if(selected.has(entity.id))transformEntity(entity,matrix);
  if(matrix.mirrored)for(const notch of next.notches||[])if(selected.has(notch.baseEntityId))notch.side*=-1;
  commitGradeVectors();
  const grains=transformMarkerGrains(next,selected,p=>positionVector(matrix,p));
  validateProject(next);syncAllowances(next,makeId);syncNotches(next,makeId);syncSeamChecks(next);syncGradingPlans(next);syncMarkerPlans(next);
  const report=recipeIssues(next,selected),remaining=new Set(next.entities.map(entity=>entity.id)),selectionIds=[...selected].filter(id=>remaining.has(id));
  const displayIds=new Set([...selectionIds,...report.related]);
  const copied=value.copy?Object.fromEntries(Object.keys(counts).map(key=>[key,(next[key]||[]).length-counts[key]])):null;
  return {project:next,config:clone(value),signature:positionStamp(project),matrix,selectionIds,displayIds:[...displayIds],issues:report.issues,affected:report.affected,grains,copied,
    endResidual:value.operation==='align'?distance(positionPoint(matrix,value.b),value.targetB):null};
}
export function applyPosition(project,preview){
  if(!preview||preview.signature!==positionStamp(project))throw new Error('工程已变化，请重新预览定位结果');
  return {project:clone(preview.project),selectionIds:[...preview.selectionIds]};
}
