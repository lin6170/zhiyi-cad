import {exactNativeKernel as K,prepareIntersectionSpans,restrictNativeSpan} from './intersections.mjs';
const {zero,one}=K,keys=['x','y'];
const abs=(v,A)=>v.n<0n?A.neg(v):v,max=(a,b,A)=>A.sub(a,b).n>=0n?a:b;
const pointEqual=(a,b,A)=>keys.every(k=>A.sub(a[k],b[k]).n===0n);
function compose(P,anchor,scale,A){
  const affine=[anchor,scale];return Object.fromEntries(keys.map(k=>{let result=[zero];for(let i=P[k].length-1;i>=0;i--)result=A.pAdd(A.pMul(result,affine),[P[k][i]]);return [k,result];}));
}
function at(P,t,A){return Object.fromEntries(keys.map(k=>{let value=zero;for(let i=P[k].length-1;i>=0;i--)value=A.add(A.mul(value,t),P[k][i]);return [k,value];}));}
const convert=controls=>controls.map(p=>({x:K.rationalNumber(p.x),y:K.rationalNumber(p.y)}));

export function endpointContinuation(entity,end='end',mode='native'){
  if(!['start','end'].includes(end)||!['native','tangent'].includes(mode)||entity.closed||entity.type==='text')throw new Error('延伸须选择开放线条的起点或终点');
  const A=K.arithmetic(200000,32768),first=end==='start',degree=entity.curve?.degree||1;let points,power,knotRange;
  if(entity.curve){const spans=prepareIntersectionSpans(entity.curve),span=first?spans[0]:spans.at(-1);points=span.points;power=K.preparedPower(points,span.exactPower,A);knotRange=span.knotRange;}
  else{
    const all=entity.points,endpoint=first?all[0]:all.at(-1),others=first?all.slice(1):all.slice(0,-1).reverse(),other=others.find(p=>p.x!==endpoint.x||p.y!==endpoint.y);
    if(!other)throw new Error('目标线没有可延伸的方向');points=first?[endpoint,other]:[other,endpoint];power=K.preparedPower(points,undefined,A);
  }
  const controls=K.powerControls(power,A,degree),origin=first?controls[0]:controls.at(-1);
  if(mode==='tangent'){
    const rest=first?controls.slice(1):controls.slice(0,-1).reverse(),other=rest.find(p=>!pointEqual(p,origin,A));
    if(!other)throw new Error('端部原生跨度恒定，无法确定切向');
    power=Object.fromEntries(keys.map(k=>[k,[origin[k],A.sub(origin[k],other[k])]]));
  }else power=compose(power,first?zero:one,first?A.neg(one):one,A);
  if(keys.every(k=>power[k].slice(1).every(v=>v.n===0n)))throw new Error('端部原生跨度恒定，不能沿原曲线延续');
  return {power,degree,origin,anchor:convert([origin])[0],end,mode,knotRange};
}

export function continuationSearch(continuation,maxLength,{maxDoublings=64}={}){
  if(!Number.isFinite(maxLength)||maxLength<=0||maxLength>1e6||!Number.isInteger(maxDoublings)||maxDoublings<1||maxDoublings>256)throw new Error('最大延伸长度须大于 0 且不超过 1000000 mm');
  const A=K.arithmetic(200000,32768),limit=K.rationalDyadic(maxLength,A),limitSquared=A.mul(limit,limit),P=continuation.power;
  const outside=s=>{const p=at(P,K.rationalDyadic(s,A),A);let squared=zero;for(const k of keys){const d=A.sub(p[k],continuation.origin[k]);squared=A.add(squared,A.mul(d,d));}return A.sub(squared,limitSquared).n>0n;};
  let scale=1,proved=false;
  for(let i=0;i<maxDoublings;i++){if(outside(scale)){proved=true;break;}scale*=2;}
  if(!proved)throw new Error('未能在搜索上限内证明延伸范围，请调整线形或长度');
  // Any smaller endpoint whose distance already exceeds the length limit is
  // also a valid stopping bound, even when the continuation turns or loops.
  for(let i=0;i<maxDoublings&&outside(scale/2);i++)scale/=2;
  const exactPower=compose(P,zero,K.rationalDyadic(scale,A),A),points=convert(K.powerControls(exactPower,A,continuation.degree));
  if(points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1e12||Math.abs(p.y)>1e12))throw new Error('临时延伸搜索范围超出数值上限');
  const geometry=restrictNativeSpan(points,0,1,{exactPower,degree:continuation.degree});
  return {points,exactPower,scale,bounds:geometry.bounds};
}

// Math.hypot supplies only a starting guess. Squared rational comparisons
// move each value outward until it is a proven lower/upper Euclidean bound.
function normBound(a,b,up,A){
  const dx=A.sub(a.x,b.x),dy=A.sub(a.y,b.y),squared=A.add(A.mul(dx,dx),A.mul(dy,dy));
  let value=Math.hypot(K.rationalNumber(dx),K.rationalNumber(dy));
  if(!Number.isFinite(value))throw new Error('弧长距离超出数值范围');
  for(let i=0;i<16;i++){const v=K.rationalDyadic(value,A),delta=A.sub(A.mul(v,v),squared).n;if(up?delta>=0n:delta<=0n)return v;value=K.nextFloat(value,up);}
  throw new Error('弧长距离无法给出向外舍入界');
}

export function certifiedBezierLength(points,{tolerance=1e-6,maxSegments=4096,maxOperations=2000000}={}){
  if(!Array.isArray(points)||points.length<2||points.length>4||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y))||!Number.isFinite(tolerance)||tolerance<=0||!Number.isInteger(maxSegments)||maxSegments<1)throw new Error('弧长证明设置无效');
  const A=K.arithmetic(maxOperations,32768),half=A.rat(1n,2n),controls=points.map(p=>Object.fromEntries(keys.map(k=>[k,K.rationalDyadic(p[k],A)]))),target=K.rationalDyadic(tolerance,A);
  const bounds=p=>{const lower=normBound(p[0],p.at(-1),false,A);let upper=zero;for(let i=1;i<p.length;i++)upper=A.add(upper,normBound(p[i-1],p[i],true,A));return {controls:p,lower,upper,gap:A.sub(upper,lower)};};
  const split=p=>{const left=[p[0]],right=[p.at(-1)];let row=p;while(row.length>1){row=row.slice(1).map((v,i)=>Object.fromEntries(keys.map(k=>[k,A.mul(A.add(row[i][k],v[k]),half)])));left.push(row[0]);right.unshift(row.at(-1));}return [left,right];};
  const heap=[],larger=(a,b)=>A.sub(a.gap,b.gap).n>0n;
  function push(value){heap.push(value);let i=heap.length-1;while(i){const parent=(i-1)>>1;if(!larger(heap[i],heap[parent]))break;[heap[i],heap[parent]]=[heap[parent],heap[i]];i=parent;}}
  function pop(){const result=heap[0],last=heap.pop();if(heap.length){heap[0]=last;let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&larger(heap[child+1],heap[child]))child++;if(!larger(heap[child],heap[i]))break;[heap[i],heap[child]]=[heap[child],heap[i]];i=child;}}return result;}
  const initial=bounds(controls);push(initial);let lower=initial.lower,upper=initial.upper,segments=1;
  while(A.sub(A.sub(upper,lower),target).n>0n){
    if(segments>=maxSegments)throw new Error('弧长上下界尚未收敛，请调整误差上限或线形');
    const old=pop(),children=split(old.controls).map(bounds);lower=A.sub(lower,old.lower);upper=A.sub(upper,old.upper);
    for(const child of children){lower=A.add(lower,child.lower);upper=A.add(upper,child.upper);push(child);}segments++;
  }
  return {lower:K.outwardNumber(lower,false,A),upper:K.outwardNumber(upper,true,A),segments,operations:A.operations};
}

export function continuationPiece(continuation,search,hit,{errorTolerance=1e-6,lengthTolerance=1e-6,maxLengthSegments=4096}={}){
  const t=hit.parameterA;if(!(t>0&&t<=1))throw new Error('延伸交点不能是原端点');
  const piece=restrictNativeSpan(search.points,0,t,{exactPower:search.exactPower,degree:continuation.degree,endInterval:hit.parameterIntervalA});
  if(piece.errorBound>errorTolerance)throw new Error('延伸几何误差上界超过设置值');
  if(piece.points.every(p=>p.x===piece.points[0].x&&p.y===piece.points[0].y))throw new Error('延伸段在数值换算后坍缩');
  const A=K.arithmetic(200000,32768),numeric=K.rationalDyadic(t,A),exactPower=compose(search.exactPower,zero,numeric,A),exactControls=K.powerControls(exactPower,A,continuation.degree),errors=exactControls.map((p,i)=>Object.fromEntries(keys.map(k=>[k,A.sub(K.rationalDyadic(piece.points[i][k],A),p[k])])));
  let variation=zero;for(let i=1;i<errors.length;i++)for(const k of keys)variation=A.add(variation,abs(A.sub(errors[i][k],errors[i-1][k]),A));
  const searchControls=K.powerControls(search.exactPower,A,continuation.degree);let speed=zero;
  for(let i=1;i<searchControls.length;i++){let length=zero;for(const k of keys)length=A.add(length,abs(A.sub(searchControls[i][k],searchControls[i-1][k]),A));speed=max(speed,A.mul(A.rat(BigInt(continuation.degree)),length),A);}
  let parameterError=zero;for(const endpoint of hit.parameterIntervalA)parameterError=max(parameterError,abs(A.sub(numeric,K.rationalDyadic(endpoint,A)),A),A);
  const delta=A.add(variation,A.mul(speed,parameterError)),stored=certifiedBezierLength(piece.points,{tolerance:lengthTolerance,maxSegments:maxLengthSegments}),lower=A.sub(K.rationalDyadic(stored.lower,A),delta),upper=A.add(K.rationalDyadic(stored.upper,A),delta);
  return {...piece,lengthBounds:{lower:lower.n<0n?0:K.outwardNumber(lower,false,A),upper:K.outwardNumber(upper,true,A),storedLower:stored.lower,storedUpper:stored.upper,segments:stored.segments,roundingAndRootBound:K.outwardNumber(delta,true,A)},nativeParameterExtent:search.scale*t};
}
