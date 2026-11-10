// Exact dyadic signs for the represented binary64 coefficients. Normalized
// coefficient division, epsilon-zero endpoints, and fixed parameter merging
// can all lose spatially significant roots on a long curve.
const bits=new DataView(new ArrayBuffer(8)),zero={n:0n,e:0};
function dyadic(x){
  if(!Number.isFinite(x))throw new Error('曲线求根包含非有限数值');if(x===0)return zero;
  bits.setFloat64(0,x,false);const hi=bits.getUint32(0,false),lo=bits.getUint32(4,false),exponent=(hi>>>20)&2047;
  let n=(BigInt(hi&0xfffff)<<32n)|BigInt(lo);if(exponent)n|=1n<<52n;if(hi>>>31)n=-n;
  return {n,e:exponent?exponent-1023-52:-1074};
}
function plus(a,b){if(!a.n)return b;if(!b.n)return a;const e=Math.min(a.e,b.e);return {n:(a.n<<BigInt(a.e-e))+(b.n<<BigInt(b.e-e)),e};}
function times(a,b){return !a.n||!b.n?zero:{n:a.n*b.n,e:a.e+b.e};}
function compare(a,b){const value=plus(a,{n:-b.n,e:b.e}).n;return value>0n?1:value<0n?-1:0;}
const sign=a=>a.n>0n?1:a.n<0n?-1:0;
function exactValue(coefficients,t){const x=dyadic(t);let result=zero;for(let i=coefficients.length-1;i>=0;i--)result=plus(times(result,x),coefficients[i]);return result;}
function asNumber(a){return Number(a.n)*2**a.e;}
function signAt(coefficients,t){
  // Use a conservative floating filter; uncertain signs fall back to integers.
  let value=0,bound=0;for(let i=coefficients.length-1;i>=0;i--){const c=asNumber(coefficients[i]);value=value*t+c;bound=bound*Math.abs(t)+Math.abs(c);}
  if(Number.isFinite(value)&&Number.isFinite(bound)&&Math.abs(value)>bound*Number.EPSILON*(8*coefficients.length+16)&&Math.abs(value)>1e-280)return Math.sign(value);
  return sign(exactValue(coefficients,t));
}
function intervalSign(coefficients,lo,hi){
  const x=dyadic(lo),y=dyadic(hi);let lower=zero,upper=zero;
  for(let i=coefficients.length-1;i>=0;i--){const candidates=[times(lower,x),times(lower,y),times(upper,x),times(upper,y)];let min=candidates[0],max=min;for(const item of candidates){if(compare(item,min)<0)min=item;if(compare(item,max)>0)max=item;}lower=plus(min,coefficients[i]);upper=plus(max,coefficients[i]);}
  return sign(lower)>0?1:sign(upper)<0?-1:0;
}
function bisect(coefficients,lo,hi){
  let left=signAt(coefficients,lo);for(let i=0;i<1100;i++){
    const mid=lo+(hi-lo)/2;if(mid===lo||mid===hi)return {lo,hi,t:mid};const current=signAt(coefficients,mid);
    if(!current)return {lo:mid,hi:mid,t:mid};if(current===left){lo=mid;left=current;}else hi=mid;
  }throw new Error('曲线交点未达到参数精度，请调整切线');
}
function isolate(coefficients){
  while(coefficients.length>1&&!coefficients.at(-1).n)coefficients=coefficients.slice(0,-1);if(coefficients.length<2)return [];
  const derived=coefficients.slice(1).map((c,i)=>({n:c.n*BigInt(i+1),e:c.e})),critical=coefficients.length>2?isolate(squareFree(derived)).filter(r=>r.t>0&&r.t<1):[],roots=[],knots=[];
  for(const t of [0,1])if(!signAt(coefficients,t))roots.push({lo:t,hi:t,t});
  for(const root of critical){
    const at=signAt(coefficients,root.t);
    if(!at&&signAt(derived,root.t)===0){roots.push({lo:root.t,hi:root.t,t:root.t});knots.push({lo:root.t,hi:root.t,sign:0});continue;}
    const whole=root.lo===root.hi?at:intervalSign(coefficients,root.lo,root.hi);
    if(!whole)throw new Error('曲线存在数值不确定的近重交点，请调整切线或拾取位置');
    knots.push({...root,sign:whole});
  }
  const intervals=[{lo:0,hi:0,sign:signAt(coefficients,0)},...knots,{lo:1,hi:1,sign:signAt(coefficients,1)}];
  for(let i=1;i<intervals.length;i++){const a=intervals[i-1],b=intervals[i];if(a.sign*b.sign<0)roots.push(bisect(coefficients,a.hi,b.lo));}
  roots.sort((a,b)=>a.t-b.t);
  for(let i=1;i<roots.length;i++)if(roots[i].t===roots[i-1].t)throw new Error('两个曲线交点无法在当前数值精度下区分，请调整切线');
  return roots;
}
export function polynomialRoots(coefficients){if(!Array.isArray(coefficients)||!coefficients.length||coefficients.length>6)throw new Error('曲线求根次数超出范围');return isolate(coefficients.map(dyadic)).map(root=>root.t);}

const neg=a=>({n:-a.n,e:a.e}),sub=(a,b)=>plus(a,neg(b)),multiple=(a,n)=>({n:a.n*BigInt(n),e:a.e});
function integerGcd(a,b){a=a<0n?-a:a;b=b<0n?-b:b;while(b)[a,b]=[b,a%b];return a;}
function primitive(values){while(values.length>1&&values.at(-1)===0n)values.pop();let divisor=0n;for(const v of values)divisor=integerGcd(divisor,v);if(!divisor)return [0n];if(values.at(-1)<0n)divisor=-divisor;return values.map(v=>v/divisor);}
function remainder(a,b){let r=a.slice();while(r.length>=b.length&&r.some(v=>v!==0n)){const n=r.length-b.length,lead=r.at(-1),divisor=b.at(-1);r=r.map(v=>v*divisor);for(let i=0;i<b.length;i++)r[i+n]-=lead*b[i];r=primitive(r);}return r;}
function squareFree(coefficients){
  const nonzero=coefficients.filter(c=>c.n);if(!nonzero.length)return [zero];const exponent=Math.min(...nonzero.map(c=>c.e)),original=primitive(coefficients.map(c=>c.n<<BigInt(c.e-exponent))),derived=primitive(original.slice(1).map((v,i)=>v*BigInt(i+1)));
  if(original.length<=1)return [{n:original[0],e:0}];let a=original,b=derived;
  while(b.some(v=>v!==0n)){const r=remainder(a,b);a=b;b=r;}
  if(a.length===1)return original.map(n=>({n,e:0}));
  const quotient=Array(original.length-a.length+1).fill(0n);let r=original.slice();
  while(r.length>=a.length&&r.some(v=>v!==0n)){const n=r.length-a.length;if(r.at(-1)%a.at(-1)!==0n)throw new Error('原生最近点重根消除未完成');const q=r.at(-1)/a.at(-1);quotient[n]=q;for(let i=0;i<a.length;i++)r[i+n]-=q*a[i];while(r.length>1&&r.at(-1)===0n)r.pop();}
  if(r.some(v=>v!==0n))throw new Error('原生最近点重根消除残差非零');return primitive(quotient).map(n=>({n,e:0}));
}
// Form (B(t)-q) dot B'(t) directly from represented binary64 controls using
// exact dyadic differences/products. Removing repeated polynomial factors by
// an exact integer GCD preserves every distinct stationary root, including
// non-dyadic zero-speed parameters such as 1/3, before interval isolation.
export function bezierDistanceRoots(points,query){
  if(!Array.isArray(points)||points.length<2||points.length>4)throw new Error('原生最近点次数无效');
  function powerOf(key){const p=points.map(v=>sub(dyadic(v[key]),dyadic(query[key])));if(p.length===2)return [p[0],sub(p[1],p[0])];if(p.length===3)return [p[0],multiple(sub(p[1],p[0]),2),plus(sub(p[2],multiple(p[1],2)),p[0])];return [p[0],multiple(sub(p[1],p[0]),3),multiple(plus(sub(p[2],multiple(p[1],2)),p[0]),3),sub(plus(sub(p[3],multiple(p[2],3)),multiple(p[1],3)),p[0])];}
  const x=powerOf('x'),y=powerOf('y'),dx=x.slice(1).map((v,i)=>multiple(v,i+1)),dy=y.slice(1).map((v,i)=>multiple(v,i+1)),dot=Array(x.length+dx.length-1).fill(zero);
  for(let i=0;i<x.length;i++)for(let j=0;j<dx.length;j++)dot[i+j]=plus(dot[i+j],plus(times(x[i],dx[j]),times(y[i],dy[j])));
  return isolate(squareFree(dot)).map(root=>root.t);
}

function integerPolynomial(coefficients){const nonzero=coefficients.filter(c=>c.n);if(!nonzero.length)return [0n];const exponent=Math.min(...nonzero.map(c=>c.e));return primitive(coefficients.map(c=>c.n<<BigInt(c.e-exponent)));}
function polynomialGcd(a,b){a=primitive(a.slice());b=primitive(b.slice());while(b.some(v=>v!==0n)){const r=remainder(a,b);a=b;b=r;}return a;}
function dividePolynomial(a,b,normalize=true){
  if(a.every(v=>v===0n))return [0n];
  if(b.length===1)return a;const quotient=Array(a.length-b.length+1).fill(0n);let r=a.slice();
  while(r.length>=b.length&&r.some(v=>v!==0n)){const n=r.length-b.length;if(r.at(-1)%b.at(-1)!==0n)throw new Error('约束曲线的精确因子消除未完成');const q=r.at(-1)/b.at(-1);quotient[n]=q;for(let i=0;i<b.length;i++)r[i+n]-=q*b[i];while(r.length>1&&r.at(-1)===0n)r.pop();}
  if(r.some(v=>v!==0n))throw new Error('约束曲线的因子消除残差非零');return normalize?primitive(quotient):quotient;
}
function commonIntegerPolynomials(polynomials){const nonzero=polynomials.flat().filter(c=>c.n);if(!nonzero.length)return polynomials.map(()=>[0n]);const exponent=Math.min(...nonzero.map(c=>c.e));return polynomials.map(p=>{const values=p.map(c=>c.n<<BigInt(c.e-exponent));while(values.length>1&&values.at(-1)===0n)values.pop();return values;});}
function unitExactPair(a,b){
  const top=v=>v.n?(v.n<0n?-v.n:v.n).toString(2).length-1+v.e:-Infinity,exponent=Math.max(top(a),top(b));if(!Number.isFinite(exponent))throw new Error('曲线极限切线无法确定');
  const value=v=>{if(!v.n)return 0;const magnitude=v.n<0n?-v.n:v.n,shift=Math.max(0,magnitude.toString(2).length-53),number=Number(magnitude>>BigInt(shift))*2**(v.e+shift-exponent);return v.n<0n?-number:number;},x=value(a),y=value(b),length=Math.hypot(x,y);return {x:x/length,y:y/length};
}
// Divide out the full common derivative factor before finding constraint
// roots. This removes vacuous zero-speed roots while retaining true limiting
// tangents/normals at stationary parameterizations and polynomial cusps.
// Zero anchor-to-curve chords are removed after square-free reduction.
export function bezierConstraintRoots(points,anchor,mode){
  if(!Array.isArray(points)||points.length<2||points.length>4||!['perpendicular','tangent'].includes(mode))throw new Error('垂足或切点设置无效');
  function powerOf(key){const p=points.map(v=>sub(dyadic(v[key]),dyadic(anchor[key])));if(p.length===2)return [p[0],sub(p[1],p[0])];if(p.length===3)return [p[0],multiple(sub(p[1],p[0]),2),plus(sub(p[2],multiple(p[1],2)),p[0])];return [p[0],multiple(sub(p[1],p[0]),3),multiple(plus(sub(p[2],multiple(p[1],2)),p[0]),3),sub(plus(sub(p[3],multiple(p[2],3)),multiple(p[1],3)),p[0])];}
  const x=powerOf('x'),y=powerOf('y'),dx=x.slice(1).map((v,i)=>multiple(v,i+1)),dy=y.slice(1).map((v,i)=>multiple(v,i+1)),equation=Array(x.length+dx.length-1).fill(zero);
  for(let i=0;i<x.length;i++)for(let j=0;j<dx.length;j++)equation[i+j]=plus(equation[i+j],mode==='perpendicular'?plus(times(x[i],dx[j]),times(y[i],dy[j])):sub(times(x[i],dy[j]),times(y[i],dx[j])));
  if(equation.every(c=>!c.n))return {roots:[],nonUnique:true};
  const [integerDx,integerDy]=commonIntegerPolynomials([dx,dy]),velocityFactor=polynomialGcd(integerDx,integerDy),reduced=dividePolynomial(integerPolynomial(equation),velocityFactor),vx=dividePolynomial(integerDx,velocityFactor,false).map(n=>({n,e:0})),vy=dividePolynomial(integerDy,velocityFactor,false).map(n=>({n,e:0}));
  let allowed=squareFree(reduced.map(n=>({n,e:0}))).map(c=>c.n);const coincident=polynomialGcd(integerPolynomial(x),integerPolynomial(y));allowed=dividePolynomial(allowed,polynomialGcd(allowed,coincident));
  return {roots:isolate(allowed.map(n=>({n,e:0}))).map(r=>r.t),nonUnique:false,directionAt:t=>unitExactPair(exactValue(vx,t),exactValue(vy,t))};
}

// Internal exact kernel for two-parameter intersection elimination. This does
// not widen the older public floating-coefficient solver or change its users.
export const exactPolynomialKernel={dyadic,plus,sub,times,multiple,commonIntegerPolynomials,primitive,polynomialGcd,dividePolynomial,intervalSign,exactValue,sign,
  squareFreeIntegers:values=>squareFree(values.map(n=>({n,e:0}))).map(v=>v.n),
  rootIntervals:values=>{if(!Array.isArray(values)||values.length>13||values.some(v=>typeof v!=='bigint'))throw new Error('交点消元次数超出范围');return isolate(squareFree(values.map(n=>({n,e:0}))));}
};
