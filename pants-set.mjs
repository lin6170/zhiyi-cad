/**
 * v76: a whole basic trouser from measurements. Besides the front and back of the demonstration draft it makes the small
 * pieces a sample needs: waistband, fly facing and fly shield, slant side pockets (facing, front and back layer of the bag),
 * back welt pockets (welt, facing, bag) and belt loops. Every piece has its fabric, count, label, grain line and seam
 * allowance; the legs have notches at the hip and knee and at the darts, fold-back corners at the hem and drill holes at the
 * dart points; the waistband has notches at the side seams, the centre back and the front, a buttonhole and a button.
 *
 * pants-draft.mjs calls this when the input has a `parts` section. A draft without it is made exactly as before.
 *
 * The rules are this tool's own and have not been fitted on people. The legs use the formulas of the demonstration draft;
 * two things differ: the back waist is a curve that meets the centre back seam and the side seam square (a straight back
 * waist leaves a dip at the centre back and a peak at the side when the pieces are sewn), and the legs have notches. The
 * delivery checks at the end measure the pattern as it is drawn, so that they can be repeated after the master edits it.
 */
import {bounds,length,validateProject,transform,textWidth} from './geometry.mjs';
import {refreshCurve} from './curves.mjs';
import {fitClampedSpline} from './fit-spline.mjs';
import {generateAllowance,applyAllowance,syncAllowances,SHARP_CORNER_LIMIT} from './seams.mjs';
import {applyNotches,syncNotches} from './notches.mjs';
import {markShapes} from './cad-command-marks.mjs';
import {circleCurve} from './construct.mjs';
import {MATERIAL_CODES,labelText,piecesToCut,attributesOf} from './piece-attributes.mjs';
import {applyShrink,finishedMap,mapPoint} from './shrink.mjs';

export const SET_REPORT_SCHEMA='zhiyi-pants-set-demo/v1';
// [key, label, example, min, max, hint, unit]; 'choice' and 'count' are whole numbers, the others millimetres
export const partFields=[
  ['waistband','腰头',1,0,1,'1 生成腰头（一片，对折），0 不要','choice'],
  ['waistbandWidth','腰头宽',35,20,60,'成品宽度'],
  ['underlap','腰头搭门',35,0,80,'里襟一端比腰围多出的长度；25 mm 以上时画扣眼和扣位'],
  ['fly','门襟里襟',1,0,1,'1 生成门襟和里襟（门襟按左前片画），0 不要','choice'],
  ['flyLength','门襟长',180,120,260,'从腰口沿前中缝量到门襟止口'],
  ['flyWidth','门襟宽',35,25,50,'门襟和里襟的成品宽'],
  ['sidePocket','侧袋',1,0,1,'1 斜插袋，0 不要','choice'],
  ['pocketSlant','斜袋口腰口宽',40,25,70,'袋口在腰口离侧缝的距离'],
  ['pocketOpening','斜袋口长',160,110,200,'袋口斜线的直线长度'],
  ['backPocket','后袋',1,0,2,'1 单嵌线，2 双嵌线，0 不要','choice'],
  ['backPocketWidth','后袋口宽',130,90,160,'袋口长度'],
  ['backPocketDepth','后袋口离腰口',70,45,100,'从腰口垂直量到袋口'],
  ['beltLoops','裤袢数',6,0,8,'0 不要','count'],
  ['warpShrink','面料经向缩水',0,0,10,'沿布纹线方向，长度 ÷（1 − 缩水）；0 不加','percent'],
  ['weftShrink','面料纬向缩水',0,0,10,'垂直布纹线方向；里料裁片不加缩水','percent']
];
// fixed sizes of the small pieces (mm); the report lists them
export const PART_SIZES=Object.freeze({facingExtra:30,facingBelow:30,bagInner:60,bagBelow:100,bagCorner:40,shieldBelow:20,weltExtra:20,weltSingle:50,weltDouble:60,backFacing:70,backBagDepth:170,loopWidth:30,loopLength:90,pocketMargin:25,drill:3,drillInside:10,button:15,buttonhole:18,buttonFromEnd:20});
export const defaultParts=()=>Object.fromEntries(partFields.map(([key,,value])=>[key,value]));
export function validateParts(parts){
  if(!parts||typeof parts!=='object'||Array.isArray(parts)||Object.keys(parts).length!==partFields.length)throw Error('部件设置的字段不完整。');
  for(const [key,label,,min,max,,unit] of partFields){
    const n=parts[key],whole=unit==='choice'||unit==='count';
    if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max||(whole?!Number.isInteger(n):Math.abs(n*10-Math.round(n*10))>1e-6))throw Error(label+(whole?'须为 '+min+'～'+max+' 的整数。':'须在 '+min+'～'+max+(unit==='percent'?'%':' mm')+' 内，最多一位小数。'));
  }
  if(parts.sidePocket&&parts.pocketOpening<parts.pocketSlant+60)throw Error('斜袋口长至少要比斜袋口腰口宽长 60 mm。');
  return {...parts};
}

// ---------------------------------------------------------------- plane and curve helpers
const P=(x,depth)=>({x,y:-depth||0});
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y}),plus=(a,v,k=1)=>({x:a.x+v.x*k,y:a.y+v.y*k}),norm=v=>Math.hypot(v.x,v.y),unit=v=>{const l=norm(v);return {x:v.x/l,y:v.y/l};};
const lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t}),dot=(a,b)=>a.x*b.x+a.y*b.y,dist=(a,b)=>norm(sub(a,b)),copy=p=>({x:p.x,y:p.y});
const bez=(c,t)=>{const u=1-t,a=u*u*u,b=3*u*u*t,d=3*u*t*t,e=t*t*t;return {x:a*c[0].x+b*c[1].x+d*c[2].x+e*c[3].x,y:a*c[0].y+b*c[1].y+d*c[2].y+e*c[3].y};};
const dbez=(c,t)=>{const u=1-t,a=3*u*u,b=6*u*t,d=3*t*t;return {x:a*(c[1].x-c[0].x)+b*(c[2].x-c[1].x)+d*(c[3].x-c[2].x),y:a*(c[1].y-c[0].y)+b*(c[2].y-c[1].y)+d*(c[3].y-c[2].y)};};
const GL=[[-.9739065285171717,.0666713443086881],[-.8650633666889845,.1494513491505806],[-.6794095682990244,.219086362515982],[-.4333953941292472,.2692667193099963],[-.1488743389816312,.2955242247147529],[.1488743389816312,.2955242247147529],[.4333953941292472,.2692667193099963],[.6794095682990244,.219086362515982],[.8650633666889845,.1494513491505806],[.9739065285171717,.0666713443086881]];
// arc length of a span: Gauss-Legendre on 48 equal parameter steps, kept per span; inverted with Newton steps
const ARC=new WeakMap();
function gauss(c,a,b){let t=0;const h=(b-a)/2,m=(a+b)/2;for(const [x,w] of GL){const d=dbez(c,m+h*x);t+=w*Math.hypot(d.x,d.y)*h;}return t;}
function arcTable(c){let t=ARC.get(c);if(!t){const n=48,cum=[0];for(let i=0;i<n;i++)cum.push(cum[i]+gauss(c,i/n,(i+1)/n));t={n,cum};ARC.set(c,t);}return t;}
function arcTo(c,t){const {n,cum}=arcTable(c);if(t<=0)return 0;if(t>=1)return cum[n];const i=Math.min(n-1,Math.floor(t*n));return cum[i]+gauss(c,i/n,t);}
const arcOf=(c,t0=0,t1=1)=>arcTo(c,t1)-arcTo(c,t0);
function paramAt(c,L){
  const {n,cum}=arcTable(c);if(L<=0)return 0;if(L>=cum[n])return 1;
  let i=0;while(cum[i+1]<L)i++;let t=(i+(L-cum[i])/(cum[i+1]-cum[i]))/n;
  for(let k=0;k<5;k++){const d=dbez(c,t),speed=Math.hypot(d.x,d.y);if(speed<1e-12)break;t=Math.max(i/n,Math.min((i+1)/n,t-(arcTo(c,t)-L)/speed));}
  return t;
}
function splitAt(c,t){const a=lerp(c[0],c[1],t),b=lerp(c[1],c[2],t),d=lerp(c[2],c[3],t),e=lerp(a,b,t),f=lerp(b,d,t),g=lerp(e,f,t);return [[c[0],a,e,g],[g,f,d,c[3]]];}
function between(c,t0,t1){if(t0<=0&&t1>=1)return c.map(copy);const right=t0>0?splitAt(c,t0)[1]:c.map(copy);if(t1>=1)return right;return splitAt(right,(t1-t0)/(1-t0))[0];}
// an element of an outline: a straight line or one cubic Bezier span; 'fit' is a curve through points (ET's own spline form)
const elLength=e=>e.kind==='line'?dist(e.c[0],e.c[1]):e.kind==='cubic'?arcOf(e.c):length(fitEntity(e.c));
function elAt(e,s){
  if(e.kind==='line'){const L=dist(e.c[0],e.c[1]),t=L?Math.max(0,Math.min(1,s/L)):0;return {point:lerp(e.c[0],e.c[1],t),tangent:unit(sub(e.c[1],e.c[0]))};}
  const t=paramAt(e.c,s);return {point:bez(e.c,t),tangent:unit(dbez(e.c,t))};
}
function elBetween(e,s0,s1){
  const L=elLength(e);
  if(e.kind==='line')return {...e,c:[lerp(e.c[0],e.c[1],s0/L),lerp(e.c[0],e.c[1],s1/L)]};
  return {...e,c:between(e.c,s0<=1e-9?0:paramAt(e.c,s0),s1>=L-1e-9?1:paramAt(e.c,s1))};
}
const reversed=e=>({...e,c:e.c.slice().reverse()});
const pathLength=path=>path.reduce((sum,e)=>sum+elLength(e),0);
function pathAt(path,s){let acc=0;for(const [i,e] of path.entries()){const L=elLength(e);if(s<=acc+L+1e-9||i===path.length-1)return {index:i,...elAt(e,Math.max(0,Math.min(L,s-acc)))};acc+=L;}}
function subPath(path,s0,s1){const out=[];let acc=0;for(const e of path){const L=elLength(e),a=Math.max(s0-acc,0),b=Math.min(s1-acc,L);if(b-a>1e-6)out.push(elBetween(e,a,b));acc+=L;}return out;}
const reversePath=path=>path.slice().reverse().map(reversed);
/** The distance along a path at which f changes sign (f negative at the start). */
function rootAlong(path,f,limit){let a=0,b=limit;if(f(pathAt(path,b).point)<0)return null;for(let i=0;i<50;i++){const m=(a+b)/2;if(f(pathAt(path,m).point)<0)a=m;else b=m;}return (a+b)/2;}
function fitEntity(points){const fitted=fitClampedSpline(points);return refreshCurve({id:'fit',name:'',type:'polyline',closed:false,layer:'outline',points:[],curve:fitted.curve});}
function samples(e){if(e.kind==='line')return e.c;if(e.kind==='fit')return e.c;return Array.from({length:33},(_,i)=>bez(e.c,i/32));}
/** Where two lines cross: a + s·u = b + t·v. */
function crossLines(a,u,b,v){const den=u.x*v.y-u.y*v.x;if(Math.abs(den)<1e-12)return null;const s=((b.x-a.x)*v.y-(b.y-a.y)*v.x)/den;return plus(a,u,s);}
const leftOf=v=>({x:-v.y,y:v.x});
// v77: the points an ET curve is drawn through in place of a cubic span: its ends, a point 2 mm in from each end (they keep the end
// directions) and five between at equal steps along it; a span shorter than 20 mm gets its ends and three points between.
// A notch on the span (`extra`: its length from the start) takes the place of the nearest of the points between (of a 2 mm point when
// it is within 4 mm of that end), so that the notch and a point of its curve move together in every size: ET adds a notch that is not
// one of a curve's points to that curve's points in each size, and a point close beside it could cross it in another size and fold
// the curve. `chosen` are the places given way in the base drawing: every draft a grading is derived from gives way at the same place.
export function throughPlaces(c,extra=[],chosen=null){
  const L=arcOf(c),at=s=>bez(c,paramAt(c,s)),places=L<20?[0,L*.25,L*.5,L*.75,L]:[0,2,...[1,2,3,4,5].map(k=>L*k/6),L-2,L],last=places.length-1;
  const between=L<20?[1,2,3]:[2,3,4,5,6],given=extra.map(()=>null);
  extra.forEach((s,n)=>{
    if(!(s>0&&s<L))return;
    const open=[...between,...(L>=20&&s<4?[1]:[]),...(L>=20&&s>L-4?[last-1]:[])].filter(i=>!given.includes(i));
    const pick=chosen?.[n],k=Number.isInteger(pick)&&pick>0&&pick<last&&!given.includes(pick)?pick:open.length?open.reduce((b,i)=>Math.abs(places[i]-s)<Math.abs(places[b]-s)?i:b):null;
    if(k===null)return;given[n]=k;places[k]=s;
  });
  const order=places.map((s,i)=>i).sort((a,b)=>places[a]-places[b]);
  return {points:order.map(i=>i===0?copy(c[0]):i===last?copy(c[3]):at(places[i])),chosen:given};
}
export const throughPoints=(c,extra=[],chosen=null)=>throughPlaces(c,extra,chosen).points;

// ---------------------------------------------------------------- the whole trouser
export function draftPantsSet(input,{makeId,geometryOnly=false,stations=null}){
  const m=input.measurements,r=input.rules,q=validateParts(input.parts),S=PART_SIZES,share=r.frontShare/100;
  const totals={waist:m.waist+r.waistEase,hip:m.hip+r.hipEase,thigh:m.thigh+r.thighEase};
  const extension=totals.thigh-totals.hip/2,rise=m.crotchDepth+r.riseEase;
  // the two legs, in the frame of the demonstration draft: x across, y up, the waist at the side seam at y = 0
  const legs=[0,1].map(index=>{
    const label=index?'后裤片':'前裤片',part=index?1-share:share,hip=totals.hip/2*part,dart=index?r.backDartWidth:r.frontDartWidth;
    const waistNet=totals.waist/2*part,waistGross=waistNet+dart,raise=index?r.backRaise:0,shift=index?r.backShift:r.frontInset;
    if(waistGross<=raise+60)throw Error('腰口长度不足以形成当前后腰抬高。');
    const ext=extension*(index?1-r.frontCrotchShare/100:r.frontCrotchShare/100),center=(hip-ext)/2,knee=r.kneeCirc*part,hem=r.hemCirc*part;
    const wc=P(shift,-raise);let ws,waist;
    if(raise){
      // the back waist leaves the centre back and the side seam square: both seams arrive vertically, so the curve is level at
      // both ends; its side end is placed so that its length is the waist with the dart
      const curveTo=X=>{const k=(X-wc.x)/3;return [copy(wc),{x:wc.x+k,y:wc.y},{x:X-k,y:0},{x:X,y:0}];};
      let lo=wc.x+1,hi=wc.x+waistGross;for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(arcOf(curveTo(mid))<waistGross)lo=mid;else hi=mid;}
      ws={x:(lo+hi)/2,y:0};waist={name:'腰口',kind:'cubic',c:curveTo(ws.x)};
    }else{ws=P(shift+waistGross,0);waist={name:'腰口',kind:'line',c:[copy(wc),copy(ws)]};}
    const hs=P(hip,m.hipDepth),cs=P(hip,rise),ct=P(-ext,rise),hc=P(0,m.hipDepth),ko=P(center+knee/2,m.kneeDepth),ki=P(center-knee/2,m.kneeDepth);
    if(ws.x<hip*.55||ws.x>hip+25||ki.x<=ct.x||ko.x>=cs.x+20)throw Error(label+' 的腰口或腿部比例超出当前规则，请调整分配比例、松量或围度。');
    const sideUpper={name:'上侧缝',kind:'cubic',c:[copy(ws),P(ws.x,m.hipDepth*.5),P(hip,m.hipDepth*.7),copy(hs)]},sideHip={name:'臀裆侧缝',kind:'line',c:[copy(hs),copy(cs)]};
    const sideLower={name:'膝上侧缝',kind:'cubic',c:[copy(cs),P(cs.x,rise+(m.kneeDepth-rise)*.4),P(ko.x,m.kneeDepth-(m.kneeDepth-rise)*.35),copy(ko)]};
    const upperSide=elLength(sideUpper)+elLength(sideHip)+elLength(sideLower),remaining=m.length-upperSide,dx=(hem-knee)/2;
    if(remaining<120||remaining<=Math.abs(dx))throw Error('目标侧缝裤长不足，请增加裤长或减少膝深。');
    // below the knee: straight lines on a straight leg; on a tapered or flared leg a curve that leaves the knee and reaches the hem
    // vertically, so that the straight hem is square to both seams (front and back then sew into a straight hem, and ET folds the hem
    // allowance back the same way as the page); its drop is found so that the side seam is the target length
    const lowerTo=(from,to)=>({kind:'cubic',c:[copy(from),{x:from.x,y:from.y-(from.y-to.y)/3},{x:to.x,y:to.y+(from.y-to.y)/3},copy(to)]});
    let drop=remaining;
    if(Math.abs(dx)>1e-6){let lo=Math.sqrt(remaining**2-dx**2)*.9,hi=remaining;for(let i=0;i<60;i++){const mid=(lo+hi)/2,c=lowerTo(ko,P(center+hem/2,m.kneeDepth+mid));if(arcOf(c.c)<remaining)lo=mid;else hi=mid;}drop=(lo+hi)/2;}
    const bottom=m.kneeDepth+drop,ho=P(center+hem/2,bottom),hi=P(center-hem/2,bottom);
    // v77: with grading every size has the same lines: the lower seams are curves in every size when the knee and the hem grade by
    // different steps (a draft the rules are derived from, which moves the knee alone, may still bend them: grading takes their ends)
    const steps=input.grading?.steps||{},straightLeg=Math.abs(dx)<=1e-6&&!(input.grading&&(steps.kneeCirc||0)!==(steps.hemCirc||0));
    const side=[sideUpper,sideHip,sideLower,straightLeg?{name:'膝下侧缝',kind:'line',c:[copy(ko),copy(ho)]}:{name:'膝下侧缝',...lowerTo(ko,ho)}];
    const hemLine={name:'裤脚',kind:'line',c:[copy(ho),copy(hi)]};
    const innerBottom=straightLeg?{name:'膝下内缝',kind:'line',c:[copy(hi),copy(ki)]}:{name:'膝下内缝',...lowerTo(hi,ki)};
    const innerUpper={name:'膝上内缝',kind:'cubic',c:[copy(ki),P(ki.x,m.kneeDepth-(m.kneeDepth-rise)*.35),P(ct.x,rise+(m.kneeDepth-rise)*.35),copy(ct)]};
    const crotch={name:'裆弯',kind:'cubic',c:[copy(ct),P(-ext*.35,rise),P(0,m.hipDepth+(rise-m.hipDepth)*.65),copy(hc)]};
    const centerSeam={name:'中心缝',kind:'cubic',c:[copy(hc),P(0,m.hipDepth*.65),P(shift,m.hipDepth*.3-raise),copy(wc)]};
    // the dart, on the waist at the same share of its length as in the demonstration draft, square to the waist
    let darts=null;
    if(dart){
      const L=elLength(waist),at=(index?.58:.5)*L,c=elAt(waist,at),a=elAt(waist,at-dart/2).point,b=elAt(waist,at+dart/2).point,depth=index?r.backDartLength:r.frontDartLength;
      const inward={x:c.tangent.y,y:-c.tangent.x},tip=plus(c.point,inward,depth);
      darts={a,b,tip,center:c.point,inward,tangent:c.tangent,fromWaistStart:[at-dart/2,at+dart/2],depth};
    }
    return {index,label,part,hip,dart,waistNet,waistGross,raise,shift,ext,center,knee,hem,wc,ws,hs,cs,ct,hc,ko,ki,ho,hi,bottom,waist,side,hemLine,innerBottom,innerUpper,crotch,centerSeam,darts,sideLength:upperSide+elLength(side[3])};
  });
  const [F,B]=legs;
  const pieces=[],notes=[],notchesWanted=[];
  // ---------------------------------------------------------------- front: slant pocket
  let frontOutline=[F.waist,...F.side,F.hemLine,F.innerBottom,F.innerUpper,F.crotch,F.centerSeam],pocket=null;
  if(q.sidePocket){
    const toCenter=unit(sub(F.wc,F.ws)),PW=plus(F.ws,toCenter,q.pocketSlant);
    if(F.darts&&dist(F.ws,F.darts.b)<q.pocketSlant+10)throw Error('前省与斜袋口相碰，请减少斜袋口腰口宽或前省量。');
    const sideToKnee=elLength(F.side[0])+elLength(F.side[1])+elLength(F.side[2]);
    const sPS=rootAlong(F.side,p=>dist(p,PW)-q.pocketOpening,elLength(F.side[0])+elLength(F.side[1]));
    if(sPS===null)throw Error('斜袋口太长：袋口下端低于横裆线，请减少斜袋口长。');
    const PS=pathAt(F.side,sPS).point,u=unit(sub(PS,PW));let n=leftOf(u);if(n.x>0)n={x:-n.x,y:-n.y};
    if(F.darts){const side=dot(sub(F.darts.tip,PW),n);if(side<5)throw Error('前省尖离斜袋口太近，请减少前省长或斜袋口腰口宽。');}
    const opening={name:'斜袋口',kind:'line',c:[copy(PW),copy(PS)]},rest=subPath(F.side,sPS,pathLength(F.side));
    frontOutline=[{...F.waist,c:[copy(F.wc),copy(PW)]},opening,...rest,F.hemLine,F.innerBottom,F.innerUpper,F.crotch,F.centerSeam];
    // the pocket facing: from the side seam to 30 mm past the opening, down to 30 mm below its lower end
    const F1=crossLines(plus(PW,n,S.facingExtra),u,F.wc,sub(F.ws,F.wc)),F2=plus(plus(PS,n,S.facingExtra),u,S.facingBelow),sF3=sPS+S.facingBelow,F3=pathAt(F.side,sF3).point;
    const facingSide=reversePath(subPath(F.side,0,sF3));
    pocket={PW,PS,sPS,u,n,F1,F2,F3,facingSide};
    pieces.push({key:'facing',name:'斜插袋垫布',material:'面料',count:1,symmetric:true,
      outline:[{name:'腰口',kind:'line',c:[copy(F.ws),copy(F1)]},{name:'里口',kind:'line',c:[copy(F1),copy(F2)]},{name:'下口',kind:'line',c:[copy(F2),copy(F3)]},...facingSide],
      widths:[r.seamAllowance,0,0,...facingSide.map(()=>r.seamAllowance)],grain:'auto',
      label:{at:plus(plus(PW,n,S.facingExtra/2+3),u,12),rotation:Math.atan2(u.y,u.x)*180/Math.PI,height:6}});
    // the bag: its top runs on the waist past the opening, it hangs 100 mm below the lower end of the opening
    const dartB=F.darts?dist(F.ws,F.darts.b):dist(F.ws,F.wc)-20,bagTop=Math.max(q.pocketSlant+S.facingExtra+10,Math.min(q.pocketSlant+S.bagInner,dartB-10));
    const B1=plus(F.ws,toCenter,bagTop),sB3=sPS+S.bagBelow;
    if(sB3>=sideToKnee-20)throw Error('斜插袋袋布超过膝线，请减少斜袋口长。');
    const B3=pathAt(F.side,sB3).point,B2={x:B1.x,y:B3.y+S.bagCorner};
    const bottom={name:'袋底',kind:'cubic',c:[copy(B2),{x:B2.x,y:B3.y},{x:B2.x+.45*(B3.x-B2.x),y:B3.y},copy(B3)]};
    if(B3.x-B2.x<S.bagCorner+20)throw Error('斜插袋袋布太窄，请检查斜袋口尺寸。');
    const backSide=reversePath(subPath(F.side,0,sB3)),frontSide=subPath(F.side,sPS,sB3);
    pocket.bag={B1,B2,B3,sB3,bagTop};
    pieces.push({key:'bagFront',name:'斜插袋布 前层',material:'里料',count:1,symmetric:true,
      outline:[{name:'腰口',kind:'line',c:[copy(B1),copy(PW)]},{...opening,name:'袋口'},...frontSide,reversed(bottom),{name:'里口',kind:'line',c:[copy(B2),copy(B1)]}],
      widths:null,grain:'auto',labelBeside:true});
    pieces.push({key:'bagBack',name:'斜插袋布 后层',material:'里料',count:1,symmetric:true,
      outline:[{name:'腰口',kind:'line',c:[copy(F.ws),copy(B1)]},{name:'里口',kind:'line',c:[copy(B1),copy(B2)]},bottom,...backSide],
      widths:null,grain:'auto',labelBeside:true});
  }
  // ---------------------------------------------------------------- front: fly facing and shield
  let fly=null;
  if(q.fly){
    const down=[reversed(F.centerSeam),reversed(F.crotch)],cfLength=elLength(F.centerSeam),limit=cfLength+.4*elLength(F.crotch);
    if(q.flyLength>limit)throw Error('门襟长超过前中缝可用的长度（约 '+(limit/10).toFixed(1)+' cm），请减少门襟长。');
    const stop=pathAt(down,q.flyLength).point,cf=subPath(down,0,q.flyLength),straight=q.flyLength-q.flyWidth;
    const inward=s=>{const at=pathAt(down,s);let n=leftOf(at.tangent);if(n.x<0)n={x:-n.x,y:-n.y};return {point:at.point,tangent:at.tangent,n};};
    const offsets=Array.from({length:6},(_,i)=>{const at=inward(straight*i/5);return plus(at.point,at.n,q.flyWidth);});
    const lowEnd=inward(straight),atStop=inward(q.flyLength),k=.55*q.flyWidth;
    const j={name:'下口',kind:'cubic',c:[copy(offsets[5]),plus(offsets[5],lowEnd.tangent,k),plus(stop,atStop.n,k),copy(stop)]};
    fly={stop,cfLength};
    pieces.push({key:'fly',name:'门襟',material:'面料',count:1,symmetric:false,
      outline:[...cf.map(e=>({...e,name:'前中'})),reversed(j),{name:'外口',kind:'fit',c:offsets.slice().reverse().map(copy)},{name:'腰口',kind:'line',c:[copy(offsets[0]),copy(F.wc)]}],
      widths:[...cf.map(()=>r.seamAllowance),0,0,r.seamAllowance],grain:[{x:F.wc.x+q.flyWidth*.3,y:-25},{x:F.wc.x+q.flyWidth*.3,y:-Math.max(60,straight-15)}],labelVertical:true,labelX:F.wc.x+q.flyWidth*.68,labelHeight:6});
    const w=2*q.flyWidth,h=q.flyLength+S.shieldBelow;
    pieces.push({key:'shield',name:'里襟',material:'面料',count:1,symmetric:false,...rectangle(w,h,['下口','外口','腰口','前中']),
      widths:null,inner:[{name:'对折线',a:{x:w/2,y:0},b:{x:w/2,y:-h}}],grain:[{x:w*.25,y:-25},{x:w*.25,y:-(h-25)}],labelVertical:true,labelX:w*.75});
  }
  // ---------------------------------------------------------------- back: welt pocket position
  let backPocket=null;
  if(q.backPocket){
    // the pocket line runs parallel to the waist at the middle of the waist; along it the pocket stands in the middle of the room
    // between the centre back seam and the side seam, 25 mm from each; a width that does not fit is narrowed (not below 90 mm)
    const L=elLength(B.waist),at=elAt(B.waist,.5*L),inward={x:at.tangent.y,y:-at.tangent.x},through=plus(at.point,inward,q.backPocketDepth);
    const meet=path=>{const pts=path.flatMap(samples);let best=null;for(let i=1;i<pts.length;i++){const a=pts[i-1],b=pts[i],d=sub(b,a),den=at.tangent.x*d.y-at.tangent.y*d.x;if(Math.abs(den)<1e-12)continue;const w=sub(a,through),t=(w.x*d.y-w.y*d.x)/den,u=(w.x*at.tangent.y-w.y*at.tangent.x)/den;if(u>=-1e-9&&u<=1+1e-9&&(!best||Math.abs(t)<Math.abs(best)))best=t;}return best;};
    const tCentre=meet([B.centerSeam,B.crotch]),tSide=meet(B.side.slice(0,3));
    if(tCentre===null||tSide===null||tSide<=tCentre)throw Error('后袋口的位置不在后片里，请减少后袋口离腰口的距离。');
    const room=tSide-tCentre-2*S.pocketMargin,width=Math.min(q.backPocketWidth,room),mid=(tCentre+tSide)/2;
    if(width<90)throw Error('后袋口放不下：袋口线上离后中缝和侧缝各 '+S.pocketMargin+' mm 以内只有 '+(Math.max(0,room)/10).toFixed(1)+' cm，至少要 9 cm；请减少后袋口离腰口的距离，或不要后袋。');
    if(width<q.backPocketWidth)notes.push('后袋口宽 '+(q.backPocketWidth/10).toFixed(1)+' cm 放不下（袋口线上离后中缝、侧缝各 '+(S.pocketMargin/10).toFixed(1)+' cm 以内只有 '+(room/10).toFixed(1)+' cm），按 '+(width/10).toFixed(1)+' cm 画；嵌线、垫布和袋布跟着变窄。');
    const centre=plus(through,at.tangent,mid),e1=plus(centre,at.tangent,-width/2),e2=plus(centre,at.tangent,width/2);
    if(B.darts&&q.backPocketDepth>=B.darts.depth-5)notes.push('后省长 '+(B.darts.depth/10).toFixed(1)+' cm，没有超过后袋口，省尖在袋口附近；请师傅确认省长。');
    backPocket={e1,e2,tangent:at.tangent,width};
    const long=width+2*S.weltExtra,welt=q.backPocket===2?S.weltDouble:S.weltSingle;
    pieces.push({key:'welt',name:'后袋嵌线',material:'面料',count:2,symmetric:false,gross:true,...rectangle(long,welt,['下口','右端','上口','左端'],true),widths:null,grain:[{x:long*.3,y:welt*.7},{x:long*.7,y:welt*.7}],labelAt:{x:8,y:welt*.2},grossAt:{x:long*.55,y:welt*.2}});
    pieces.push({key:'backFacing',name:'后袋垫布',material:'面料',count:2,symmetric:false,gross:true,...rectangle(long,S.backFacing,['下口','右端','上口','左端'],true),widths:null,grain:[{x:long*.2,y:12},{x:long*.2,y:S.backFacing-12}],labelAt:{x:long*.3,y:S.backFacing*.55},grossAt:{x:long*.3,y:S.backFacing*.2}});
    const bagH=2*S.backBagDepth;
    pieces.push({key:'backBag',name:'后袋布',material:'里料',count:2,symmetric:false,...rectangle(long,bagH,['下口','右边','上口','左边'],true),widths:null,inner:[{name:'对折线',a:{x:0,y:bagH/2},b:{x:long,y:bagH/2}}],grain:[{x:long*.2,y:30},{x:long*.2,y:bagH/2-30}],labelAt:{x:long*.3,y:40}});
  }
  // ---------------------------------------------------------------- waistband and loops
  const frontWaist=F.waistGross-F.dart,backWaist=B.waistGross-B.dart,waistSeam=2*(frontWaist+backWaist);
  if(q.waistband){
    const L=waistSeam+q.underlap,H=2*q.waistbandWidth;
    pieces.push({key:'waistband',name:'腰头',material:'面料',count:1,symmetric:false,...rectangle(L,H,['腰口','里襟端','上口','门襟端'],true),widths:null,
      inner:[{name:'对折线',a:{x:0,y:H/2},b:{x:L,y:H/2}}],grain:[{x:L*.35,y:H*.75},{x:L*.65,y:H*.75}],labelAt:{x:L*.08,y:H*.25-4},
      bandNotches:[frontWaist,frontWaist+backWaist,frontWaist+2*backWaist,...(q.underlap>0?[waistSeam]:[])],
      buttons:q.underlap>=25?{hole:{x:S.buttonFromEnd,y:H/4},button:{x:waistSeam+S.buttonFromEnd,y:H/4}}:null});
  }
  if(q.beltLoops)pieces.push({key:'loops',name:'裤袢',material:'面料',count:q.beltLoops,symmetric:false,gross:true,...rectangle(S.loopWidth,S.loopLength,['下口','右边','上口','左边'],true),widths:null,grain:[{x:S.loopWidth*.25,y:12},{x:S.loopWidth*.25,y:S.loopLength-12}],labelVertical:true,labelX:S.loopWidth*.82,labelHeight:5,grossVertical:{x:S.loopWidth*.52,height:4}});
  // ---------------------------------------------------------------- the legs as pieces
  const legPiece=(L,outline,extra)=>({key:L.index?'back':'front',name:L.label,material:'面料',count:1,symmetric:true,leg:L,outline,
    widths:outline.map(e=>e===L.hemLine?r.hemAllowance:r.seamAllowance),...extra});
  const backOutline=[B.waist,...B.side,B.hemLine,B.innerBottom,B.innerUpper,B.crotch,B.centerSeam];
  const ORDER=['waistband','fly','shield','facing','bagFront','bagBack','welt','backFacing','backBag','loops'];
  pieces.sort((a,b)=>ORDER.indexOf(a.key)-ORDER.indexOf(b.key));
  pieces.unshift(legPiece(F,frontOutline,{}),legPiece(B,backOutline,{}));
  // a vertical grain line through the middle of a piece, where it is drawn automatically
  for(const p of pieces.filter(p=>p.grain==='auto')){
    const loop=p.outline.flatMap(samples),cx=loop.reduce((t,v)=>t+v.x,0)/loop.length,ys=[];
    for(let i=0,j=loop.length-1;i<loop.length;j=i++){const a=loop[i],b=loop[j];if((a.x>cx)!==(b.x>cx))ys.push(a.y+(b.y-a.y)*(cx-a.x)/(b.x-a.x));}
    const lo=Math.min(...ys),hi=Math.max(...ys),span=hi-lo;p.grain=[{x:cx,y:lo+span*.18},{x:cx,y:hi-span*.18}];
  }
  // ---------------------------------------------------------------- layout: legs side by side, the waistband below them, then the rest in rows
  const boxOf=p=>{const pts=p.outline.flatMap(samples),margin=p.margin;return {minX:Math.min(...pts.map(v=>v.x))-margin,maxX:Math.max(...pts.map(v=>v.x))+margin,minY:Math.min(...pts.map(v=>v.y))-margin,maxY:Math.max(...pts.map(v=>v.y))+margin};};
  const grow=1/(1-Math.max(q.warpShrink,q.weftShrink)/100);
  for(const p of pieces){p.margin=(p.gross?0:Math.max(...(p.widths||[r.seamAllowance])))+6;p.box=boxOf(p);
    if(p.material==='面料'&&grow>1){const cx=(p.box.minX+p.box.maxX)/2,cy=(p.box.minY+p.box.maxY)/2,hw=(p.box.maxX-p.box.minX)/2*grow,hh=(p.box.maxY-p.box.minY)/2*grow;p.box={minX:cx-hw,maxX:cx+hw,minY:cy-hh,maxY:cy+hh};}}
  const front=pieces[0],back=pieces[1];
  front.offset={x:30-front.box.minX,y:0};back.offset={x:front.offset.x+front.box.maxX+100-back.box.minX,y:0};
  let rowTop=Math.min(front.box.minY,back.box.minY)-120,x=30;const rowWidth=Math.max(back.offset.x+back.box.maxX,1000);
  let rowHeight=0;
  for(const p of pieces.slice(2)){
    const w=p.box.maxX-p.box.minX,h=p.box.maxY-p.box.minY;
    if(p.key==='waistband'||x>30&&x+w>rowWidth+30){rowTop-=rowHeight+(rowHeight?80:0);x=30;rowHeight=0;}
    p.offset={x:x-p.box.minX,y:rowTop-p.box.maxY};x+=w+80;rowHeight=Math.max(rowHeight,h);
    if(p.key==='waistband'){rowTop-=h+80;x=30;rowHeight=0;}
  }
  // ---------------------------------------------------------------- where the notches go
  // v77: worked out on the drafted shapes before the lines are made, and the same requests place the notches afterwards. A curve gets
  // a through point at each of its notches: ET adds a notch that is not one of a curve's points to that curve's points in each size,
  // in the base size's order, and one that crossed a point of the curve near it folded the curve in that size.
  const notchRequests=[],throughAt=new Map();
  {
    const named=(p,name)=>p.outline.findIndex(e=>e.name===name),len=(p,i)=>elLength(p.outline[i]);
    const ask=(p,i,mode,position)=>{notchRequests.push({p,i,mode,position});const e=p.outline[i],L=len(p,i),at=mode==='end'?L-position:position;if(e.kind==='cubic'&&at>=1&&at<=L-1){if(!throughAt.has(e))throughAt.set(e,[]);throughAt.get(e).push(at);}};
    const walk=(p,indices,rest,mode)=>{for(const i of indices){const L=len(p,i);if(rest<=L+1e-6){ask(p,i,mode,Math.min(rest,L));return;}rest-=L;}};
    const [front,back]=pieces,sides=p=>p.outline.map((e,i)=>/侧缝$/.test(e.name)?i:-1).filter(i=>i>=0);
    for(const p of [front,back])if(p.leg.darts)for(const at of p.leg.darts.fromWaistStart)ask(p,named(p,'腰口'),'start',at);
    // side seams: the front's notches at its hip and knee lines, the back's at the same distances from the waist; with a slant pocket
    // the back also has one where the pocket's lower end meets the side seam, matching the facing's
    const pocketTop=pocket?pocket.sPS:0,sideMarks=[elLength(F.side[0]),elLength(F.side[0])+elLength(F.side[1])+elLength(F.side[2]),...(pocket?[pocket.sPS]:[])];
    for(const at of sideMarks)for(const [p,offset] of [[front,pocketTop],[back,0]]){const rest=at-offset;if(rest>1e-6)walk(p,sides(p),rest,'start');}
    // inseam: the knee notch at the same distance from the hem on both
    const kneeFromHem=elLength(F.innerBottom);
    for(const p of [front,back]){const lower=named(p,'膝下内缝'),upper=named(p,'膝上内缝'),L=len(p,lower);if(kneeFromHem<=L+1e-6)ask(p,lower,'start',Math.min(kneeFromHem,L));else ask(p,upper,'start',kneeFromHem-L);}
    if(fly){const cf=named(front,'中心缝'),L=len(front,cf);if(q.flyLength<=L)ask(front,cf,'end',q.flyLength);else ask(front,named(front,'裆弯'),'end',q.flyLength-L);}
    const bandPiece=pieces.find(p=>p.key==='waistband');if(bandPiece)for(const at of bandPiece.bandNotches)ask(bandPiece,named(bandPiece,'腰口'),'start',at);
    const facingPiece=pieces.find(p=>p.key==='facing');if(facingPiece)walk(facingPiece,facingPiece.outline.map((e,i)=>i).slice(3).reverse(),pocket.sPS,'end');
  }
  // ---------------------------------------------------------------- entities
  const project={format:'zhiyi-cad',version:6,name:'成人基础裤 · 公式演示',units:'mm',entities:[],groups:[],seamAllowances:[],notches:[]};
  const add=e=>{project.entities.push(e);return e;};
  // v77: points in single precision, as ET keeps them and as the ET curves keep theirs, so that where a line meets a curve the two
  // ends are the same point (a hundred-thousandth of a millimetre apart, a corner could not be checked)
  const mv=(p,o)=>({x:Math.fround(p.x+o.x),y:Math.fround(p.y+o.y)});
  const stationLayout={};
  const entityOf=(e,name,o,key)=>{
    if(e.kind==='line')return add({id:makeId(),name,type:'polyline',closed:false,layer:'outline',points:e.c.map(v=>mv(v,o))});
    // v77: a curve is written as ET draws curves, through points: nine points of the span, two of them 2 mm from its ends (that keeps
    // the directions at the ends, where seams meet, within 0.3°; the curve stays within 0.2 mm of the span). Every point can then carry
    // a grading rule, and the curve is stored in an ET file exactly.
    if(e.kind==='cubic'){const extra=throughAt.get(e)||[],placed=throughPlaces(e.c,extra,stations?.[key]);if(extra.length)stationLayout[key]=placed.chosen;const fitted=fitClampedSpline(placed.points.map(v=>mv(v,o)));return add(refreshCurve({id:makeId(),name,type:'polyline',closed:false,layer:'outline',points:[],curve:fitted.curve}));}
    const fitted=fitClampedSpline(e.c.map(v=>mv(v,o)));return add(refreshCurve({id:makeId(),name,type:'polyline',closed:false,layer:'outline',points:[],curve:fitted.curve}));
  };
  const lineOf=(a,b,name,layer,o)=>add({id:makeId(),name,type:'polyline',closed:false,layer,points:[mv(a,o),mv(b,o)]});
  const textOf=(value,at,height,o,extra={})=>add({id:makeId(),name:value,type:'text',text:value,layer:'annotation',height,closed:false,points:[mv(at,o)],...extra});
  const roles={},made=[];
  for(const p of pieces){
    const o=p.offset,start=project.entities.length,outline=p.outline.map((e,i)=>entityOf(e,p.name+' · '+e.name,o,p.key+'|'+i));
    p.entities=outline;
    for(const line of p.inner||[])lineOf(line.a,line.b,p.name+' · '+line.name,'internal',o);
    if(!p.leg){const grain=lineOf(p.grain[0],p.grain[1],p.name+' · 布纹','grain',o);grain.arrowEnd=true;}
    const group={id:makeId(),name:p.name,entityIds:[],contours:[{role:'primary-contour',entityIds:outline.map(e=>e.id)}],source:{kind:'parametric-set',recipe:SET_REPORT_SCHEMA},
      attributes:{material:p.material,materialCode:MATERIAL_CODES[p.material],count:p.count,symmetric:p.symmetric}};
    p.group=group;made.push(p);
    if(p.leg)legDetails(p,o);
    group.entityIds=project.entities.slice(start).map(e=>e.id);
    // the label: on the legs to the right of the grain line, on narrow pieces turned upright, on the facing along the pocket
    const words=labelText(group),height=p.label?.height??p.labelHeight??(p.leg?9:6);
    let at,extra={pieceLabel:true};
    if(p.leg)at={x:p.leg.center+6,y:-(rise+95)};
    else if(p.label){at=p.label.at;extra.rotation=p.label.rotation;}
    else if(p.labelVertical||p.labelBeside){
      const box=p.box,w=textWidth(words,height),x0=p.labelBeside?p.grain[0].x+8+height:(p.labelX+height/2),low=Math.min(p.grain[0].y,p.grain[1].y),high=Math.max(p.grain[0].y,p.grain[1].y);
      at={x:x0,y:p.labelBeside?(low+high)/2-w/2:box.minY+p.margin+Math.max(4,(box.maxY-box.minY-2*p.margin-w)/2)};extra.rotation=90;
    }
    else at=p.labelAt;
    group.entityIds.push(textOf(words,at,height,o,extra).id);
    if(p.leg)group.entityIds.push(textOf('公式演示 · 待师傅确认版型',{x:p.leg.center+6,y:-(rise+113)},8,o).id);
    if(p.gross){
      const words='毛样（已含缝份）';
      if(p.grossVertical){const h=p.grossVertical.height,w=textWidth(words,h),box=p.box;group.entityIds.push(textOf(words,{x:p.grossVertical.x+h/2,y:box.minY+p.margin+Math.max(3,(box.maxY-box.minY-2*p.margin-w)/2)},h,o,{rotation:90}).id);}
      else group.entityIds.push(textOf(words,p.grossAt,5,o).id);
    }
    project.groups.push(group);
    // a net-only outline must still be closed and simple; then the seam allowance, with fold-back corners at the hem
    if(geometryOnly)continue;
    const ids=outline.map(e=>e.id);generateAllowance(project,ids,{distance:.1});
    const widths=p.gross?ids.map(()=>0):p.widths||ids.map(()=>r.seamAllowance),largest=Math.max(...widths);
    if(largest>0){
      const corners=p.leg&&r.hemAllowance>0&&r.seamAllowance>0?['start','end'].map(end=>({entityId:outline[p.outline.indexOf(p.leg.hemLine)].id,end,kind:'fold'})):[];
      applyAllowance(project,{name:p.name,entityIds:ids},{distance:largest,widthMode:'edges',edgeWidths:ids.map((id,i)=>({entityId:id,segmentIndex:null,width:widths[i]})),join:'miter',miterLimit:SHARP_CORNER_LIMIT,corners},makeId);
      group.entityIds=[...new Set([...group.entityIds,...project.seamAllowances.at(-1).outputIds])];
    }
  }
  function legDetails(p,o){
    const L=p.leg,name=L.label;
    lineOf(L.hc,L===F&&pocket&&-pocket.PS.y>m.hipDepth?crossLines(pocket.PW,pocket.u,L.hc,{x:1,y:0}):L.hs,name+' · 臀线','internal',o);
    lineOf(L.ki,L.ko,name+' · 膝线','internal',o);lineOf(L.ct,L.cs,name+' · 裆线平量','internal',o);
    if(L.darts){
      lineOf(L.darts.a,L.darts.tip,name+' · 省边 A','internal',o);lineOf(L.darts.tip,L.darts.b,name+' · 省边 B','internal',o);
      textOf('省 '+(L.dart/10).toFixed(1)+' cm',plus(plus(L.darts.center,L.darts.inward,L.darts.depth/2),L.darts.tangent,10),7,o);
      mark('drill',mv(plus(L.darts.tip,L.darts.inward,-S.drillInside),o),{x:1,y:0},S.drill,'省尖打孔');
    }
    if(L===B&&backPocket){
      lineOf(backPocket.e1,backPocket.e2,name+' · 后袋口','internal',o);
      for(const [end,sign] of [[backPocket.e1,1],[backPocket.e2,-1]])mark('drill',mv(plus(end,backPocket.tangent,sign*5),o),backPocket.tangent,S.drill,'袋口打孔');
    }
    const grain=lineOf(P(L.center,rise+60),P(L.center,L.bottom-80),name+' · 布纹','grain',o);grain.arrowEnd=true;
    textOf('臀线 '+(L.hip/10).toFixed(2),P(30,m.hipDepth-10),7,o);textOf('膝 '+(L.knee/10).toFixed(2),P(L.ki.x+12,m.kneeDepth-10),7,o);textOf('脚口 '+(L.hem/10).toFixed(2),P(L.hi.x+10,L.bottom-12),7,o);
  }
  function mark(kind,at,direction,size,name,options={}){
    const setId=makeId(),owner=project.entities.length;
    for(const shape of markShapes(kind,at,direction,size,options)){
      const note={id:setId,kind,index:0,part:shape.name,sizeMm:size,...(kind==='buttonhole'||kind==='bartack'?{across:options.across!==false,shiftMm:options.shift??0}:{})};
      const label=name+' 1'+(shape.name==='圆'||shape.name==='线'?'':' · '+shape.name);
      if(shape.circle)add(refreshCurve({id:makeId(),name:label,type:'polyline',closed:false,layer:'internal',points:[],curve:circleCurve(shape.at,shape.circle),mark:note}));
      else add({id:makeId(),name:label,type:'polyline',closed:false,layer:'internal',points:shape.points.map(copy),mark:note});
    }
    return project.entities.slice(owner);
  }
  // waistband buttonhole and button
  const band=made.find(p=>p.key==='waistband');
  if(band?.buttons){
    const o=band.offset,made_=[...mark('buttonhole',mv(band.buttons.hole,o),{x:0,y:1},S.buttonhole,'扣眼',{across:true}),...mark('button',mv(band.buttons.button,o),{x:1,y:0},S.button,'扣位')];
    band.group.entityIds.push(...made_.map(e=>e.id));
  }
  // ---------------------------------------------------------------- notches (after the seam allowances: they are cut into the seam line)
  if(!geometryOnly)syncAllowances(project,makeId);
  const ownerOf=id=>made.find(p=>p.entities.some(e=>e.id===id));
  function notch(entity,mode,position){
    // a notch within 1 mm of a corner stands on the corner (one 0.1 mm from it was lost on the way through an ET file)
    const total=length(entity);if(position<1)position=0;else if(total-position<1)position=total;
    // at the end of an edge it stands at the start of the next one (one at the end of 膝下内缝, where it meets the curve above, did not
    // come back from an ET file; at the start of an edge it does)
    if((mode==='start'&&position===total)||(mode==='end'&&position===0)){const end=entity.points.at(-1),piece=ownerOf(entity.id),next=piece?.entities.find(e=>e!==entity&&Math.hypot(e.points[0].x-end.x,e.points[0].y-end.y)<1e-3);if(next)return notch(next,'start',0);}
    // v77: for the drafts grading is derived from, the place of the notch is all that is needed
    if(geometryOnly){const bare={id:makeId(),name:'刀口',baseEntityId:entity.id,mode,position};project.notches.push(bare);return bare;}
    const recipe=project.seamAllowances.find(x=>x.status==='current'&&x.baseEntityIds.includes(entity.id))||null,options={mode,position,count:1,spacing:3,depth:3,shape:'line'};
    let made_=null;
    if(recipe)for(const side of [1,-1]){try{made_=applyNotches(project,entity.id,{...options,side,targetSeamId:recipe.id},makeId);break;}catch(error){if(/超出基准线长度|有效距离/.test(error.message))throw error;}}
    if(!made_){
      // no seam allowance on this edge: on the net line, toward the inside of the piece
      const piece=ownerOf(entity.id),loop=piece.outline.flatMap(samples).map(v=>mv(v,piece.offset)),probe=entity.points[Math.floor(entity.points.length/2)],next=entity.points[Math.min(entity.points.length-1,Math.floor(entity.points.length/2)+1)];
      const left=leftOf(unit(sub(next,probe))),test=plus(probe,left,1),inside=(()=>{let hit=false;for(let i=0,j=loop.length-1;i<loop.length;j=i++){const a=loop[i],b=loop[j];if((a.y>test.y)!==(b.y>test.y)&&test.x<(b.x-a.x)*(test.y-a.y)/(b.y-a.y)+a.x)hit=!hit;}return hit;})();
      made_=applyNotches(project,entity.id,{...options,side:inside?1:-1,targetSeamId:null},makeId);
    }
    made_.name='刀口';
    return made_;
  }
  const edgeOf=(p,name,which=0)=>p.entities.filter(e=>e.name===p.name+' · '+name)[which];
  const sideOf=p=>p.entities.filter((e,i)=>/侧缝$/.test(p.outline[i].name)),inseamOf=p=>[edgeOf(p,'膝下内缝'),edgeOf(p,'膝上内缝')];
  const frontPiece=made[0],backPiece=made[1],frontSide=sideOf(frontPiece),backSide=sideOf(backPiece);
  // v77: the notches asked for before the lines were made, in the same order (darts, side seams, inseam, fly, waistband, facing)
  for(const r of notchRequests)notch(r.p.entities[r.i],r.mode,r.position);
  const facing=made.find(p=>p.key==='facing');
  // ---------------------------------------------------------------- shrinkage: the fabric pieces, as ET's 缩水操作 does it (shrink.mjs)
  if(q.warpShrink||q.weftShrink)for(const p of made.filter(p=>p.material==='面料'))applyShrink(project,p.group,{warp:q.warpShrink,weft:q.weftShrink});
  const params={frontDart:F.dart,backDart:B.dart,pocketSlant:pocket?q.pocketSlant:0,facingBelow:S.facingBelow,flyLength:q.fly?q.flyLength:0,underlap:q.underlap,shieldBelow:S.shieldBelow,pocketMargin:S.pocketMargin};
  if(geometryOnly)return {project,stationLayout,params};
  // ---------------------------------------------------------------- report
  const validated=validateProject(project);syncAllowances(validated,makeId);syncNotches(validated,makeId);
  if(validated.seamAllowances.some(x=>x.status!=='current'))throw Error('生成缝份未通过重算核对。');
  if((validated.notches||[]).some(x=>x.status!=='current'))throw Error('生成刀口未通过重算核对：'+validated.notches.find(x=>x.status!=='current').error);
  const ids=list=>list.filter(Boolean).map(e=>e.id),find=key=>made.find(p=>p.key===key);
  Object.assign(roles,{groups:made.map(p=>p.group.id),
    front:{group:frontPiece.group.id,waist:ids([edgeOf(frontPiece,'腰口')]),side:ids(frontSide),inseam:ids(inseamOf(frontPiece)),hem:edgeOf(frontPiece,'裤脚').id,crotch:edgeOf(frontPiece,'裆弯').id,center:edgeOf(frontPiece,'中心缝').id,opening:pocket?edgeOf(frontPiece,'斜袋口').id:null},
    back:{group:backPiece.group.id,waist:ids([edgeOf(backPiece,'腰口')]),side:ids(backSide),inseam:ids(inseamOf(backPiece)),hem:edgeOf(backPiece,'裤脚').id,crotch:edgeOf(backPiece,'裆弯').id,center:edgeOf(backPiece,'中心缝').id,
      pocketLine:backPocket?project.entities.find(e=>e.name==='后裤片 · 后袋口').id:null},
    ...(band?{waistband:{group:band.group.id,seam:edgeOf(band,'腰口').id}}:{}),
    ...(find('fly')?{fly:{group:find('fly').group.id,center:ids(find('fly').entities.filter(e=>/· 前中$/.test(e.name)))}}:{}),
    ...(find('shield')?{shield:{group:find('shield').group.id,center:edgeOf(find('shield'),'前中').id}}:{}),
    ...(facing?{facing:{group:facing.group.id,waist:edgeOf(facing,'腰口').id,side:ids(facing.entities.slice(3))}}:{}),
    ...(find('bagFront')?{bagFront:{group:find('bagFront').group.id,opening:edgeOf(find('bagFront'),'袋口').id}}:{})
  });
  const checks=[
    {name:'腰围（扣省后，整圈）',target:totals.waist,actual:waistSeam},
    {name:'臀围（整圈）',target:totals.hip,actual:2*(F.hip+B.hip)},
    {name:'裆线平量合计（大腿演示指标）',target:totals.thigh,actual:(F.hip+F.ext)+(B.hip+B.ext)},
    {name:'单腿膝围',target:r.kneeCirc,actual:F.knee+B.knee},
    {name:'单腿脚口围',target:r.hemCirc,actual:F.hem+B.hem},
    {name:'前片侧缝裤长',target:m.length,actual:F.sideLength},
    {name:'后片侧缝裤长',target:m.length,actual:B.sideLength}
  ].map(c=>({...c,difference:c.actual-c.target}));
  if(checks.some(c=>Math.abs(c.difference)>.01))throw Error('生成尺寸未通过几何核对。');
  const inseams=[F,B].map(L=>elLength(L.innerBottom)+elLength(L.innerUpper)),inseamDifference=inseams[1]-inseams[0];
  const legReport=L=>({name:L.label,waistGrossMm:L.waistGross,dartMm:L.dart,waistNetMm:L.waistGross-L.dart,hipWidthMm:L.hip,thighFlatMm:L.hip+L.ext,kneeWidthMm:L.knee,hemWidthMm:L.hem,sideLengthMm:L.sideLength,inseamMm:elLength(L.innerBottom)+elLength(L.innerUpper),crotchArcMm:elLength(L.crotch)+elLength(L.centerSeam),verticalHemMm:L.bottom,extensionMm:L.ext});
  const cutList=made.map(p=>{const a=attributesOf(p.group),b=bounds(validated.entities.filter(e=>p.group.entityIds.includes(e.id)&&e.type!=='text'&&!e.derivedFrom&&!e.notchFrom&&!e.mark)),shrink=p.group.attributes.shrink;return {name:p.name,material:a.material,count:a.count,symmetric:a.symmetric,pieces:piecesToCut(a),gross:Boolean(p.gross),widthMm:b.maxX-b.minX,heightMm:b.maxY-b.minY,...(shrink?{shrink:{warp:shrink.warp,weft:shrink.weft}}:{})};});
  const delivery=pantsDeliveryChecks(validated,roles,params);
  notes.unshift('此规则由本工具定义用于演示，未经试衣确认。输出整套基础裤：前后裤片'+(q.waistband?'、腰头':'')+(q.fly?'、门襟、里襟':'')+(q.sidePocket?'、斜插袋（袋垫布、袋布前后层）':'')+(q.backPocket?'、'+(q.backPocket===2?'双':'单')+'嵌线后袋（嵌线、垫布、袋布）':'')+(q.beltLoops?'、裤袢':'')+'，每片带布料、片数、属性文字、布纹线和缝份。',
    '大腿指标用于分配裆线水平宽度，不代表已验证实际成衣腿围或贴合人体。裆弧、体型修正及省道位置需师傅核对。',
    '前后内缝差 '+inseamDifference.toFixed(2)+' mm（后减前）。没有自动消除差值或假定吃势；请师傅确认后修顺与对缝。',
    ...(q.fly?['门襟按左前片画（男装习惯）；女装门襟在右前片时，请把门襟、里襟镜像使用。']:[]),
    '衬料（腰头、门襟、里襟、嵌线的粘衬）没有单独生成裁片；嵌线、后袋垫布和裤袢是毛样（已含缝份），其余裁片为净样加缝份。',
    ...(q.beltLoops?['裤袢位置没有标在腰头上，请师傅按款式确定。']:[]),
    ...(q.warpShrink||q.weftShrink?['面料裁片加了缩水：经向 '+q.warpShrink+'%、纬向 '+q.weftShrink+'%（沿布纹线的长度 ÷（1 − 经向缩水），垂直方向 ÷（1 − 纬向缩水），与 ET 的缩水操作相同）；里料裁片没有加。交付检查按缩水前的成品尺寸量。']:[]));
  const formulas=[
    '成衣腰/臀围 = 人体净量 + 对应整圈松量。前片腰/臀净宽 = 成衣周长 ÷ 2 × 前片比例；后片取余量。腰口先加每片省量，再按该省量绘省。',
    '裆伸出总量 =（人体大腿围 + 大腿松量）− 成衣臀围 ÷ 2；按前裆伸出比例分到前后。前片膝/脚口平宽 = 单腿成衣周长 × 前片比例；后片取余量。',
    '后腰口为曲线，与后中缝、侧缝都成直角；曲线长 = 后片含省腰口长，抬高量同演示规则。前腰口为直线。',
    '上侧缝由原生三次曲线构成；膝下侧缝长度 = 目标裤长 − 已算上侧缝弧长，据此求脚口高度。膝围与脚口不同时，膝下侧缝和内缝是从膝线竖直出发、竖直到达脚口的曲线，脚口线与两条缝都成直角。',
    ...(q.waistband?['腰头长 = 腰口合计（扣省）+ 搭门 '+q.underlap+' mm；宽 = 2 × 腰头宽，对折。刀口在两侧缝、后中和里襟端前中。']:[]),
    ...(q.fly?['门襟：沿前中缝从腰口量门襟长，宽 '+q.flyWidth+' mm，下端圆角。里襟：宽 2 × 门襟宽（对折），长 = 门襟长 + '+S.shieldBelow+' mm。前中缝在门襟止口打刀口。']:[]),
    ...(q.sidePocket?['斜插袋：腰口离侧缝 '+q.pocketSlant+' mm 起，直线长 '+q.pocketOpening+' mm 落在侧缝上；袋垫布超出袋口 '+S.facingExtra+' mm、低于袋口 '+S.facingBelow+' mm；袋布腰口到袋口外 '+(pocket.bag.bagTop-q.pocketSlant).toFixed(1)+' mm，沿侧缝到袋口下 '+S.bagBelow+' mm。']:[]),
    ...(q.backPocket?['后袋：袋口平行于后腰口中点处的腰口，离腰口 '+q.backPocketDepth+' mm，在袋口线上后中缝与侧缝之间居中，长 '+backPocket.width.toFixed(1)+' mm（离两条缝各至少 '+S.pocketMargin+' mm），两端各进 5 mm 打孔；嵌线、垫布、袋布长 = 袋口 + 2 × '+S.weltExtra+' mm，嵌线宽 '+(q.backPocket===2?S.weltDouble:S.weltSingle)+' mm，垫布宽 '+S.backFacing+' mm，袋布深 '+S.backBagDepth+' mm（对折）。']:[]),
    ...(q.beltLoops?['裤袢：毛样 '+S.loopWidth+' × '+S.loopLength+' mm，裁 '+q.beltLoops+' 片。']:[]),
    ...(q.warpShrink||q.weftShrink?['缩水：面料裁片以沿布纹和横布纹的中间为中心，沿布纹线方向 ÷（1 − '+q.warpShrink+'%），垂直方向 ÷（1 − '+q.weftShrink+'%）；缝份宽度不变，刀口跟着线走，扣位和打孔只移动位置。']:[]),
    '侧缝刀口：前片在臀线、膝线，后片在离腰口同样的距离；内缝膝位刀口离脚口同样的距离；省位在腰口打刀口，省尖往里 '+S.drillInside+' mm 打孔。脚口两端用反转角。',
    '裆弯与侧缝采用固定示范曲线控制比例。调整字段改变几何；不执行用户输入代码。'
  ];
  validated.warnings=notes;
  return {project:validated,stationLayout,report:{schema:SET_REPORT_SCHEMA,units:'mm',status:'demonstration-awaiting-patternmaker',checks,pieces:[legReport(F),legReport(B)],inseamDifferenceMm:inseamDifference,notes,formulas,cutList,delivery,roles,params,
    measurementReference:'https://freesewing.eu/docs/about/faq/measurements-issues/'}};
}
function rectangle(w,h,names,up=false){
  // corners counter-clockwise from the bottom left; `up` puts the rectangle above y = 0, otherwise it hangs below
  const y0=up?0:-h,y1=up?h:0,a={x:0,y:y0},b={x:w,y:y0},c={x:w,y:y1},d={x:0,y:y1};
  return {outline:[{name:names[0],kind:'line',c:[a,b]},{name:names[1],kind:'line',c:[b,c]},{name:names[2],kind:'line',c:[c,d]},{name:names[3],kind:'line',c:[d,a]}]};
}

// ---------------------------------------------------------------- delivery checks, on the pattern as it is now
const STATUS={ok:'通过',review:'请师傅确认',fail:'不通过'};
function endDirection(entity,atStart){
  // the direction a line leaves its end point, along the line
  const c=entity.curve?.controlPoints;
  if(c){const list=atStart?c:c.slice().reverse(),first=list[0];for(const p of list.slice(1))if(dist(p,first)>1e-6)return unit(sub(p,first));}
  const pts=atStart?entity.points:entity.points.slice().reverse();return unit(sub(pts[1],pts[0]));
}
/** The inside angle (degrees) at the point two lines share. */
function cornerAngle(a,b){
  const ends=e=>[{p:e.points[0],start:true},{p:e.points.at(-1),start:false}];let best=null;
  for(const x of ends(a))for(const y of ends(b)){const d=dist(x.p,y.p);if(!best||d<best.d)best={d,x,y};}
  if(!best||best.d>.5)return null;
  const u=endDirection(a,best.x.start),v=endDirection(b,best.y.start);return Math.acos(Math.max(-1,Math.min(1,dot(u,v))))*180/Math.PI;
}
export function pantsDeliveryChecks(project,roles,params){
  // v76: a piece with shrinkage is measured at its finished size: its points are mapped back before lengths and angles are taken
  const owner=new Map();for(const g of project.groups||[])for(const id of g.entityIds)owner.set(id,g);
  const maps=new Map(),mapOf=e=>{const g=owner.get(e.id);if(!g)return null;if(!maps.has(g.id))maps.set(g.id,finishedMap(project,g));return maps.get(g.id);};
  const finished=e=>{const m=mapOf(e);if(!m)return e;return {...e,points:e.points.map(p=>mapPoint(m,p)),...(e.curve?{curve:{...e.curve,controlPoints:e.curve.controlPoints.map(p=>mapPoint(m,p))}}:{})};};
  const lengthOf=e=>{const m=mapOf(e);if(!m)return length(e);let s=0;const pts=e.points.map(p=>mapPoint(m,p));for(let i=1;i<pts.length;i++)s+=dist(pts[i-1],pts[i]);return s;};
  const byId=new Map(project.entities.map(e=>[e.id,e])),get=id=>{const e=byId.get(id);return e&&finished(e);},all=list=>list.map(get),len=list=>list.reduce((s,e)=>s+lengthOf(byId.get(e.id)),0),out=[];
  const missing=list=>list.some(e=>!e);
  const row=(name,value,target,tolerance,unitName,note='',strict=true)=>{
    if(value===null||target===null){out.push({name,status:'fail',statusText:STATUS.fail,note:'找不到这条检查用到的线，可能已被删除或拆分。'});return;}
    const difference=value-target,within=Math.abs(difference)<=tolerance;
    out.push({name,value,target,difference,unit:unitName,tolerance,status:within?'ok':strict?'fail':'review',statusText:within?STATUS.ok:strict?STATUS.fail:STATUS.review,note});
  };
  const f=roles.front,b=roles.back;
  // side seams: the front with the part of the facing above the pocket's lower end, against the back
  {const fs=all(f.side),bs=all(b.side),fc=roles.facing?all(roles.facing.side):[];
    if(missing(fs)||missing(bs)||missing(fc))row('侧缝：前片（含袋垫布）对后片',null,null);
    else row('侧缝：前片（含袋垫布）对后片',len(fs)+(fc.length?len(fc)-params.facingBelow:0),len(bs),.5,'mm','两边一样长才能对齐缝合。');}
  {const fi=all(f.inseam),bi=all(b.inseam);
    if(missing(fi)||missing(bi))row('内缝：后片对前片',null,null);
    else{const d=len(bi)-len(fi);row('内缝：后片对前片',len(bi),len(fi),.5,'mm','后片内缝比前片'+(Math.abs(d)<.005?'一样长':(d<0?'短 ':'长 ')+Math.abs(d).toFixed(2)+' mm')+'（量得是后片，应为是前片）；没有自动处理吃势或拔量，请师傅确认。',false);}}
  if(roles.waistband){
    const fw=all(f.waist),bw=all(b.waist),band=get(roles.waistband.seam);
    if(missing(fw)||missing(bw)||!band)row('腰头对腰口（扣省）',null,null);
    else row('腰头对腰口（扣省）',lengthOf(byId.get(band.id))-params.underlap,2*(len(fw)+params.pocketSlant-params.frontDart+len(bw)-params.backDart),.5,'mm','腰头长扣掉搭门，等于前后腰口合计（扣省，含袋垫布露出的一段）。');
  }
  if(roles.fly){const cf=all(roles.fly.center);if(missing(cf))row('门襟对前中缝',null,null);else row('门襟对前中缝',len(cf),params.flyLength,.5,'mm','门襟前中边等于前片腰口到门襟止口刀口。');}
  if(roles.shield&&roles.fly){const s=get(roles.shield.center),cf=all(roles.fly.center);if(!s||missing(cf))row('里襟对门襟',null,null);else row('里襟对门襟',lengthOf(byId.get(s.id)),len(cf)+params.shieldBelow,.5,'mm','里襟比门襟长出 '+params.shieldBelow+' mm。');}
  if(roles.bagFront&&f.opening){const a=get(roles.bagFront.opening),o=get(f.opening);if(!a||!o)row('斜插袋口：袋布前层对前片',null,null);else row('斜插袋口：袋布前层对前片',lengthOf(byId.get(a.id)),lengthOf(byId.get(o.id)),.5,'mm');}
  if(b.pocketLine){
    const line=get(b.pocketLine),side=all(b.side.slice(0,3)),center=[get(b.center),get(b.crotch)];
    if(!line||missing(side)||missing(center))row('后袋口离侧缝、后中缝',null,null);
    else{
      // measured along the pocket line, from each end to the seam it points to, as the pocket was placed
      const a=line.points[0],z=line.points.at(-1),span=dist(a,z),u=unit(sub(z,a));
      const meet=list=>{let best=null;for(const e of list)for(let i=1;i<e.points.length;i++){const p=e.points[i-1],d=sub(e.points[i],p),den=u.x*d.y-u.y*d.x;if(Math.abs(den)<1e-12)continue;const w=sub(p,a),t=(w.x*d.y-w.y*d.x)/den,s=(w.x*u.y-w.y*u.x)/den;if(s>=-1e-9&&s<=1+1e-9&&(best===null||Math.abs(t-span/2)<Math.abs(best-span/2)))best=t;}return best;};
      const tCentre=meet(center),tSide=meet(side),value=tCentre===null||tSide===null?0:Math.min(-tCentre,tSide-span);
      out.push({name:'后袋口离侧缝、后中缝',value,target:params.pocketMargin,difference:value-params.pocketMargin,unit:'mm',tolerance:0,status:value>=params.pocketMargin?'ok':'fail',statusText:value>=params.pocketMargin?STATUS.ok:STATUS.fail,note:'袋口两端到缝线至少 '+params.pocketMargin+' mm。'});}
  }
  // smooth joins: the inside angles of the two pieces where they are sewn add up to a straight line
  const join=(name,pairs,note)=>{
    const angles=pairs.map(([x,y])=>{const a=get(x),c=get(y);return a&&c?cornerAngle(a,c):null;});
    if(angles.some(v=>v===null))row(name,null,null);else row(name,angles.reduce((s,v)=>s+v,0),180,1,'°',note,false);
  };
  const facing=roles.facing;
  join('腰口在侧缝处顺直',[facing?[facing.waist,facing.side.at(-1)]:[f.waist[0],f.side[0]],[b.waist.at(-1),b.side[0]]],'前后片（有斜插袋时为袋垫布）在腰口与侧缝的夹角合计 180° 时，缝合后腰口不起角。');
  join('腰口在后中顺直',[[b.waist[0],b.center],[b.waist[0],b.center]],'左右后片在后中缝合，腰口与后中缝的夹角合计 180°。');
  join('裆弯在内缝处顺直',[[f.crotch,f.inseam.at(-1)],[b.crotch,b.inseam.at(-1)]],'前后裆弯与内缝的夹角合计 180° 时，缝合后裆弯是一条顺滑的线。');
  join('脚口在侧缝处顺直',[[f.hem,f.side.at(-1)],[b.hem,b.side.at(-1)]],'');
  join('脚口在内缝处顺直',[[f.hem,f.inseam[0]],[b.hem,b.inseam[0]]],'');
  // every piece has a grain line and, where it has one, a seam allowance that is up to date
  const groups=(project.groups||[]).filter(g=>(roles.groups||[]).includes(g.id));
  const noGrain=groups.filter(g=>!g.entityIds.some(id=>get(id)?.layer==='grain'));
  out.push({name:'每片都有布纹线',value:groups.length-noGrain.length,target:groups.length,status:noGrain.length?'fail':'ok',statusText:noGrain.length?STATUS.fail:STATUS.ok,note:noGrain.length?'没有布纹线：'+noGrain.map(g=>g.name).join('、'):''});
  // a seam allowance that cannot be made (status error); stale ones are made again by the page before they are drawn
  const broken=(project.seamAllowances||[]).filter(x=>x.status==='error'&&groups.some(g=>x.baseEntityIds.some(id=>g.entityIds.includes(id))));
  out.push({name:'缝份都能生成',value:broken.length,target:0,status:broken.length?'fail':'ok',statusText:broken.length?STATUS.fail:STATUS.ok,note:broken.length?broken.map(x=>x.name+'：'+(x.error||'不能生成')).join('；'):''});
  const badNotches=(project.notches||[]).filter(n=>n.status==='error'&&groups.some(g=>g.entityIds.includes(n.baseEntityId)));
  out.push({name:'刀口都在缝边上',value:badNotches.length,target:0,status:badNotches.length?'fail':'ok',statusText:badNotches.length?STATUS.fail:STATUS.ok,note:badNotches.length?badNotches.map(n=>n.error).join('；'):''});
  return out;
}
