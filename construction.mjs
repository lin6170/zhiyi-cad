import {quadraticCurve} from './curves.mjs';
import {degreeSinCos} from './angles.mjs';
const tools=new Set(['line','polyline','curve','rectangle','grain','measure']);
const point=p=>{if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1e8||Math.abs(p.y)>1e8)throw new Error('绘图坐标须在 ±100000000 当前单位以内');return {x:p.x,y:p.y};};
const equal=(a,b)=>a.x===b.x&&a.y===b.y;
function number(value,label){
  if(typeof value==='string'){
    const text=value.trim();if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text))throw new Error(label+' 需要十进制数值，不支持表达式或单位后缀');
    value=Number(text);if(value===0&&/[1-9]/.test(text.split(/e/i)[0]))throw new Error(label+' 太小，超出当前数值精度');
  }
  if(typeof value!=='number'||!Number.isFinite(value))throw new Error(label+' 必须是有限数值');return value;
}
export function resolveConstructionPoint(value,anchor=null){
  if(!value||!['absolute','relative','polar'].includes(value.mode))throw new Error('数值输入方式无效');
  const first=number(value.first,value.mode==='polar'?'长度':'第一个数值'),second=number(value.second,value.mode==='polar'?'角度':'第二个数值');
  if(value.mode==='absolute')return point({x:first,y:second});
  if(!anchor)throw new Error('请先在画布或坐标输入中记录起点');const a=point(anchor);let dx=first,dy=second;
  if(value.mode==='polar'){
    if(!(first>0))throw new Error('长度必须大于 0');if(Math.abs(second)>360000)throw new Error('角度须在 ±360000° 以内');
    const {c,s}=degreeSinCos(second);dx=first*c;dy=first*s;
  }
  const result=point({x:a.x+dx,y:a.y+dy});
  if(dx!==0&&result.x===a.x||dy!==0&&result.y===a.y)throw new Error('当前坐标精度无法表示所需位移，请调整起点或数值');
  return result;
}
function draftPoints(value){if(!Array.isArray(value)||value.length>10000)throw new Error('绘图草稿点数无效或超过 10000');return value.map(point);}
export function constructionStep(tool,draft,nextPoint){
  if(!tools.has(tool))throw new Error('当前工具不支持数值绘图');const previous=draftPoints(draft),next=point(nextPoint);
  const limit=tool==='polyline'?10000:tool==='curve'?3:2;if(previous.length>=limit)throw new Error('绘图草稿状态无效，请取消后重试');
  if(previous.length&&['line','grain','polyline'].includes(tool)&&equal(previous.at(-1),next))throw new Error('新点与上一点重合，未记录此点');
  const points=[...previous,next];if(tool==='polyline'||points.length<(tool==='curve'?3:2))return {kind:'draft',draft:points};
  if(tool==='measure'){const [a,b]=points;return {kind:'measurement',draft:[],measurement:{from:a,to:b,length:Math.hypot(b.x-a.x,b.y-a.y),dx:b.x-a.x,dy:b.y-a.y}};}
  if(tool==='curve'){
    if(points.every(p=>equal(p,points[0])))throw new Error('三个控制点重合，无法创建曲线');
    return {kind:'entity',draft:[],entity:{type:'polyline',points:[{...points[0]},{...points[2]}],curve:quadraticCurve(...points),closed:false,layer:'outline',name:'二次曲线'}};
  }
  const [a,b]=points;
  if(tool==='rectangle'){
    if(a.x===b.x||a.y===b.y)throw new Error('矩形宽和高都必须非零，未记录此点');
    return {kind:'entity',draft:[],entity:{type:'polyline',points:[a,{x:b.x,y:a.y},b,{x:a.x,y:b.y}],closed:true,layer:'outline',name:'矩形裁片'}};
  }
  return {kind:'entity',draft:[],entity:{type:'polyline',points,closed:false,layer:tool==='grain'?'grain':'outline',arrowEnd:tool==='grain',name:tool==='grain'?'布纹方向线':'直线'}};
}
export function finishConstructionPolyline(draft,{closed=false}={}){
  let points=draftPoints(draft);if(typeof closed!=='boolean')throw new Error('折线闭合设置无效');
  if(closed&&points.length>1&&equal(points[0],points.at(-1)))points.pop();
  if(points.length<(closed?3:2))throw new Error(closed?'闭合折线至少需要三个点':'折线至少需要两个点');
  if(points.some((p,i)=>i>0&&equal(p,points[i-1])))throw new Error('折线包含连续重合点，请退回修改');
  return {type:'polyline',points,closed,layer:'outline',name:closed?'闭合轮廓':'折线'};
}
