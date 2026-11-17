import {bounds,length,validateProject,transform} from './geometry.mjs';
import {refreshCurve} from './curves.mjs';
import {generateAllowance,applyAllowance,syncAllowances,SHARP_CORNER_LIMIT} from './seams.mjs';

export const DRAFT_COMMAND='pattern.draftStraightPants';
export const DRAFT_SCHEMA='zhiyi-straight-pants-demo/v1';
// Original, deliberately explicit demonstration rules. These are not a
// certified tailoring system or an implementation of FreeSewing Titan.
export const draftFields={
  measurements:[
    ['waist','人体腰围',800,500,1500,'周长，在选定腰线测量'],
    ['hip','人体臀围',1000,650,1700,'周长，臀部最丰满处'],
    ['thigh','人体大腿围',580,350,1000,'单腿周长，靠近裆部'],
    ['hipDepth','腰线至臀线',200,100,350,'竖直距离，使用同一腰线基准'],
    ['crotchDepth','坐姿裆深',280,180,450,'腰侧至椅面竖直距离，不是前后裆弧长'],
    ['kneeDepth','腰线至膝线',600,350,850,'竖直距离，使用同一腰线基准'],
    ['length','目标裤长',1040,700,1300,'腰侧至脚口的侧缝弧长，不含另加腰头']
  ],
  rules:[
    ['waistEase','腰围松量',20,0,120,'整圈加量'],
    ['hipEase','臀围松量',40,0,160,'整圈加量'],
    ['thighEase','大腿围松量',60,0,160,'单腿整圈加量'],
    ['kneeCirc','成衣膝围',440,280,800,'单腿整圈；直筒裤与脚口相同'],
    ['hemCirc','成衣脚口围',440,280,800,'单腿整圈，等于前后两片脚口宽之和'],
    ['riseEase','裆深放松',10,0,40,'竖直加量'],
    ['seamAllowance','一般缝份',10,0,30,'0 表示该边不加缝份'],
    ['hemAllowance','脚口折边',30,0,60,'脚口边单独设置'],
    ['frontShare','前片分配比例',48,42,50,'%，作用于腰、臀、膝与脚口的前后分配','percent'],
    ['frontCrotchShare','前裆伸出分配',33.3,20,45,'%，余量分配给后裆','percent'],
    ['backRaise','后腰中心抬高',20,0,60,'从腰侧基准向上'],
    ['frontInset','前腰中心内移',10,-20,30,'相对前臀中心线，正数向侧缝'],
    ['backShift','后腰中心横移',-15,-40,10,'相对后臀中心线，负数向后裆伸出侧'],
    ['frontDartWidth','前片省量',10,0,35,'每片单省；0 表示无省'],
    ['backDartWidth','后片省量',25,0,50,'每片单省；0 表示无省'],
    ['frontDartLength','前省长',80,40,160,'从腰口向片内'],
    ['backDartLength','后省长',120,60,200,'从腰口向片内']
  ]
};
export const defaultDraftInput=()=>Object.fromEntries(Object.entries(draftFields).map(([type,fields])=>[type,Object.fromEntries(fields.map(([key,,value])=>[key,value]))]));
const clone=x=>JSON.parse(JSON.stringify(x)),point=(x,y)=>({x,y:-y||0});
export function validateDraftInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['measurements','rules'].includes(k)))throw Error('尺寸方案格式无效。');
  for(const [type,fields] of Object.entries(draftFields)){
    const obj=input[type];if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).length!==fields.length)throw Error('尺寸方案的字段不完整。');
    for(const [key,label,,min,max] of fields){const n=obj[key];if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max||Math.abs(n*10-Math.round(n*10))>1e-6)throw Error(label+'须在 '+min+'～'+max+' '+(fields.find(f=>f[0]===key)[6]==='percent'?'%':'mm')+' 内，最多一位小数。');}
  }
  const m=input.measurements,r=input.rules;
  if(m.hipDepth+30>=m.crotchDepth+r.riseEase||m.crotchDepth+r.riseEase+120>=m.kneeDepth||m.kneeDepth+120>=m.length)throw Error('纵向关系不成立：臀线、裆线、膝线和脚口需要依次向下，并留足制版空间。');
  if(m.waist+r.waistEase>=m.hip+r.hipEase-40)throw Error('此演示规则要求成衣臀围至少比成衣腰围大 40 mm。');
  const extension=m.thigh+r.thighEase-(m.hip+r.hipEase)/2;
  if(extension<50||extension>260)throw Error('大腿围与臀围不适合此演示规则：总裆伸出量须在 50～260 mm 内。请核对净量与松量。');
  if(r.kneeCirc>m.thigh+r.thighEase-60||r.hemCirc>r.kneeCirc+80)throw Error('膝围/脚口超过基础裤装范围，请核对成衣单腿周长。');
  if(r.frontDartWidth&&r.frontDartLength>=m.hipDepth-20||r.backDartWidth&&r.backDartLength>=m.hipDepth-20)throw Error('省尖过于接近臀线，请减少省长或核对臀深。');
  return clone(input);
}
function curve(points,id,name,layer='outline'){
  const e={id,name,type:'polyline',closed:false,layer,points:[],curve:{kind:'bspline',degree:3,controlPoints:points,knots:[0,0,0,0,1,1,1,1],samplingTolerance:.01}};
  return refreshCurve(e);
}
export function draftStraightPants(input,{makeId=()=>crypto.randomUUID()}={}){
  input=validateDraftInput(input);const m=input.measurements,r=input.rules,s=r.frontShare/100;
  const project={format:'zhiyi-cad',version:6,name:'成人基础裤 · 公式演示',units:'mm',entities:[],groups:[],seamAllowances:[]},pieces=[];
  const totals={waist:m.waist+r.waistEase,hip:m.hip+r.hipEase,thigh:m.thigh+r.thighEase};
  const extension=totals.thigh-totals.hip/2,rise=m.crotchDepth+r.riseEase;
  const add=e=>{project.entities.push(e);return e;};
  function line(a,b,name,layer='outline'){return add({id:makeId(),name,type:'polyline',closed:false,layer,points:[a,b]});}
  function cubic(ps,name,layer='outline'){return add(curve(ps,makeId(),name,layer));}
  function text(value,p,height=9){return add({id:makeId(),name:value,type:'text',text:value,layer:'annotation',height,closed:false,points:[p]});}
  for(const [index,label] of ['前裤片','后裤片'].entries()){
    const start=project.entities.length,share=index?1-s:s,hip=totals.hip/2*share,dart=index?r.backDartWidth:r.frontDartWidth;
    const waistNet=totals.waist/2*share,waistGross=waistNet+dart,raise=index?r.backRaise:0,shift=index?r.backShift:r.frontInset;
    if(waistGross<=raise+60)throw Error('腰口长度不足以形成当前后腰抬高。');
    const ext=extension*(index?1-r.frontCrotchShare/100:r.frontCrotchShare/100),center=(hip-ext)/2,knee=r.kneeCirc*share,hem=r.hemCirc*share;
    const wc=point(shift,-raise),ws=point(shift+Math.sqrt(waistGross**2-raise**2),0),hs=point(hip,m.hipDepth),cs=point(hip,rise),ct=point(-ext,rise),hc=point(0,m.hipDepth);
    const ko=point(center+knee/2,m.kneeDepth),ki=point(center-knee/2,m.kneeDepth);
    if(ws.x<hip*.55||ws.x>hip+25||ki.x<=ct.x||ko.x>=cs.x+20)throw Error(label+' 的腰口或腿部比例超出当前规则，请调整分配比例、松量或围度。');
    const waist=line(wc,ws,label+' · 腰口');
    const sideUpper=cubic([ws,point(ws.x,m.hipDepth*.5),point(hip,m.hipDepth*.7),hs],label+' · 上侧缝');
    const sideHip=line(hs,cs,label+' · 臀裆侧缝');
    const sideLower=cubic([cs,point(cs.x,rise+(m.kneeDepth-rise)*.4),point(ko.x,m.kneeDepth-(m.kneeDepth-rise)*.35),ko],label+' · 膝上侧缝');
    const upperSide=length(sideUpper)+length(sideHip)+length(sideLower),remaining=m.length-upperSide,dx=(hem-knee)/2;
    if(remaining<120||remaining<=Math.abs(dx))throw Error('目标侧缝裤长不足，请增加裤长或减少膝深。');
    const bottom=m.kneeDepth+Math.sqrt(remaining**2-dx**2),ho=point(center+hem/2,bottom),hi=point(center-hem/2,bottom);
    const sideBottom=line(ko,ho,label+' · 膝下侧缝'),hemLine=line(ho,hi,label+' · 裤脚');
    const innerBottom=line(hi,ki,label+' · 膝下内缝');
    const innerUpper=cubic([ki,point(ki.x,m.kneeDepth-(m.kneeDepth-rise)*.35),point(ct.x,rise+(m.kneeDepth-rise)*.35),ct],label+' · 膝上内缝');
    const crotch=cubic([ct,point(-ext*.35,rise),point(0,m.hipDepth+(rise-m.hipDepth)*.65),hc],label+' · 裆弯');
    const centerSeam=cubic([hc,point(0,m.hipDepth*.65),point(shift,m.hipDepth*.3-raise),wc],label+' · 中心缝');
    const boundary=[waist,sideUpper,sideHip,sideLower,sideBottom,hemLine,innerBottom,innerUpper,crotch,centerSeam];
    const hipGuide=line(hc,hs,label+' · 臀线','internal'),kneeGuide=line(ki,ko,label+' · 膝线','internal'),thighGuide=line(ct,cs,label+' · 裆线平量','internal');
    const grain=line(point(center,rise+60),point(center,bottom-80),label+' · 布纹','grain');grain.arrowEnd=true;
    if(dart){
      const t=index ? .58 : .5,dx=ws.x-wc.x,dy=ws.y-wc.y,c={x:wc.x+dx*t,y:wc.y+dy*t},half=dart/2/waistGross,depth=index?r.backDartLength:r.frontDartLength;
      const a={x:wc.x+dx*(t-half),y:wc.y+dy*(t-half)},b={x:wc.x+dx*(t+half),y:wc.y+dy*(t+half)},tip={x:c.x+dy/waistGross*depth,y:c.y-dx/waistGross*depth};
      line(a,tip,label+' · 省边 A','internal');line(tip,b,label+' · 省边 B','internal');
      text('省 '+(dart/10).toFixed(1)+' cm',point(c.x+12,-c.y+depth/2),7);
    }
    text(label+' · 裁 2 片（镜像）',point(-ext,-75),12);
    text('公式演示 · 待师傅确认版型',point(-ext,-52),9);
    text('臀线 '+(hip/10).toFixed(2),point(30,m.hipDepth-10),7);
    text('膝 '+(knee/10).toFixed(2),point(ki.x+12,m.kneeDepth-10),7);
    text('脚口 '+(hem/10).toFixed(2),point(hi.x+10,bottom-12),7);
    const group={id:makeId(),name:label,entityIds:project.entities.slice(start).map(e=>e.id),contours:[{role:'primary-contour',entityIds:boundary.map(e=>e.id)}],source:{kind:'parametric-demo',recipe:DRAFT_SCHEMA}};
    project.groups.push(group);
    // Even a net-only draft must have a closed, simple outline.
    generateAllowance(project,boundary.map(e=>e.id),{distance:.1});
    if(r.seamAllowance||r.hemAllowance){
      applyAllowance(project,{name:label,entityIds:boundary.map(e=>e.id)},{distance:Math.max(r.seamAllowance,r.hemAllowance),widthMode:'edges',edgeWidths:boundary.map(e=>({entityId:e.id,segmentIndex:null,width:e===hemLine?r.hemAllowance:r.seamAllowance})),join:'miter',miterLimit:SHARP_CORNER_LIMIT},makeId);
    }
    pieces.push({name:label,groupId:group.id,waistGrossMm:length(waist),dartMm:dart,waistNetMm:length(waist)-dart,hipWidthMm:length(hipGuide),thighFlatMm:length(thighGuide),kneeWidthMm:length(kneeGuide),hemWidthMm:length(hemLine),sideLengthMm:upperSide+length(sideBottom),inseamMm:length(innerUpper)+length(innerBottom),crotchArcMm:length(crotch)+length(centerSeam),verticalHemMm:bottom,extensionMm:ext,hemId:hemLine.id});
    const own=project.entities.filter(e=>group.entityIds.includes(e.id)),box=bounds(own),offset=index?(bounds(project.entities.filter(e=>!group.entityIds.includes(e.id))).maxX+100-box.minX):-box.minX+30;
    for(const e of own)transform(e,p=>({x:p.x+offset,y:p.y}));
  }
  const [front,back]=pieces;
  const checks=[
    {name:'腰围（扣省后，整圈）',target:totals.waist,actual:2*(front.waistNetMm+back.waistNetMm)},
    {name:'臀围（整圈）',target:totals.hip,actual:2*(front.hipWidthMm+back.hipWidthMm)},
    {name:'裆线平量合计（大腿演示指标）',target:totals.thigh,actual:front.thighFlatMm+back.thighFlatMm},
    {name:'单腿膝围',target:r.kneeCirc,actual:front.kneeWidthMm+back.kneeWidthMm},
    {name:'单腿脚口围',target:r.hemCirc,actual:front.hemWidthMm+back.hemWidthMm},
    {name:'前片侧缝裤长',target:m.length,actual:front.sideLengthMm},
    {name:'后片侧缝裤长',target:m.length,actual:back.sideLengthMm}
  ].map(c=>({...c,difference:c.actual-c.target}));
  if(checks.some(c=>Math.abs(c.difference)>.01))throw Error('生成尺寸未通过几何核对。');
  const inseamDifference=back.inseamMm-front.inseamMm;
  const notes=['此规则由本工具定义用于演示，未经试衣确认。输出为前后裤片基础净样及可选缝份，不含腰头、门襟和口袋。',
    '大腿指标用于分配裆线水平宽度，不代表已验证实际成衣腿围或贴合人体。裆弧、体型修正及省道位置需师傅核对。',
    '前后内缝差 '+inseamDifference.toFixed(2)+' mm（后减前）。没有自动消除差值或假定吃势；请师傅确认后修顺与对缝。'];
  const formulas=[
    '成衣腰/臀围 = 人体净量 + 对应整圈松量。',
    '前片腰/臀净宽 = 成衣周长 ÷ 2 × 前片比例；后片取余量。腰口先加每片省量，再按该省量绘省。',
    '裆伸出总量 =（人体大腿围 + 大腿松量）− 成衣臀围 ÷ 2；按前裆伸出比例分到前后。',
    '前片膝/脚口平宽 = 单腿成衣周长 × 前片比例；后片取余量。',
    '后腰中心按抬高量提升；斜腰口水平投影 = √（含省腰口长度² − 抬高量²）。',
    '上侧缝由原生三次曲线构成；膝下侧缝长度 = 目标裤长 − 已算上侧缝弧长，据此求脚口高度。',
    '裆弯与侧缝采用固定示范曲线控制比例。调整字段改变几何；不执行用户输入代码。'
  ];
  project.warnings=notes;
  const validated=validateProject(project);syncAllowances(validated,makeId);
  if(validated.seamAllowances.some(s=>s.status!=='current'))throw Error('生成缝份未通过重算核对。');
  return {project:validated,input,report:{schema:DRAFT_SCHEMA,units:'mm',status:'demonstration-awaiting-patternmaker',checks,pieces,inseamDifferenceMm:inseamDifference,notes,formulas,measurementReference:'https://freesewing.eu/docs/about/faq/measurements-issues/'}};
}
export function appendPantsDraft(before,input,makeId){
  if(before.entities.length&&before.units!=='mm')throw Error('当前工程单位未确认。请先保存当前文件并新建毫米工程，再从尺寸生成纸样。');
  const generated=draftStraightPants(input,{makeId}),next=clone(before),box=bounds(before.entities),own=bounds(generated.project.entities),dx=box?box.maxX+100-own.minX:0;
  if(dx)for(const e of generated.project.entities)transform(e,p=>({x:p.x+dx,y:p.y}));
  next.units='mm';if(!next.entities.length)next.name='成人基础裤 · 公式演示';
  next.entities.push(...generated.project.entities);next.groups.push(...generated.project.groups);next.seamAllowances??=[];next.seamAllowances.push(...generated.project.seamAllowances);
  next.version=Math.max(next.version,6);next.warnings=[...new Set([...(next.warnings||[]),...generated.project.warnings])];
  next.metadata??={};next.metadata.parametricDrafts??=[];next.metadata.parametricDrafts.push({id:makeId(),schema:DRAFT_SCHEMA,input:generated.input,report:generated.report,entityIds:generated.project.entities.map(e=>e.id),groupIds:generated.project.groups.map(g=>g.id)});
  return {project:next,summary:{operation:DRAFT_COMMAND,recipe:DRAFT_SCHEMA,newPieces:2,generatedFromMeasurements:true,report:generated.report},measurements:generated.report.checks};
}
