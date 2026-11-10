import {exactPolynomialKernel as K} from './polynomial-roots.mjs';
import {validateCurve} from './curves.mjs';

const zero={n:0n,d:1n},one={n:1n,d:1n},isZero=p=>p.every(v=>!v.n),trim=p=>{p=p.slice();while(p.length>1&&!p.at(-1).n)p.pop();return p;};
const same=(a,b)=>a.x===b.x&&a.y===b.y;
const rationalDyadic=(value,A)=>{const d=K.dyadic(value);return d.e>=0?A.rat(d.n<<BigInt(d.e)):A.rat(d.n,1n<<BigInt(-d.e));};
function gcd(a,b){a=a<0n?-a:a;b=b<0n?-b:b;while(b)[a,b]=[b,a%b];return a;}
function power(points,key,origin){
  const p=points.map(v=>K.sub(K.dyadic(v[key]),K.dyadic(origin[key]))),{sub,plus,multiple}=K;
  if(p.length===2)return [p[0],sub(p[1],p[0])];
  if(p.length===3)return [p[0],multiple(sub(p[1],p[0]),2),plus(sub(p[2],multiple(p[1],2)),p[0])];
  return [p[0],multiple(sub(p[1],p[0]),3),multiple(plus(sub(p[2],multiple(p[1],2)),p[0]),3),sub(plus(sub(p[3],multiple(p[2],3)),multiple(p[1],3)),p[0])];
}
function arithmetic(maxOperations,maxBits){
  let operations=0;
  function tick(...values){if(++operations>maxOperations)throw new Error('交点精确计算超过运算上限，请放大或减少候选线条');for(const n of values)if((n<0n?-n:n).toString(2).length>maxBits)throw new Error('交点精确系数超过位数上限，请调整几何比例');}
  function rat(n,d=1n){tick(n,d);if(!d)throw new Error('交点代数计算遇到零除数');if(!n)return zero;if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return {n:n/g,d:d/g};}
  const add=(a,b)=>rat(a.n*b.d+b.n*a.d,a.d*b.d),neg=a=>({n:-a.n,d:a.d}),sub=(a,b)=>add(a,neg(b)),mul=(a,b)=>rat(a.n*b.n,a.d*b.d),div=(a,b)=>rat(a.n*b.d,a.d*b.n);
  const pAdd=(a,b)=>trim(Array.from({length:Math.max(a.length,b.length)},(_,i)=>add(a[i]||zero,b[i]||zero))),pNeg=a=>a.map(neg),pSub=(a,b)=>pAdd(a,pNeg(b)),pScale=(a,c)=>trim(a.map(v=>mul(v,c)));
  function pMul(a,b){const p=Array(a.length+b.length-1).fill(zero);for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)p[i+j]=add(p[i+j],mul(a[i],b[j]));return trim(p);}
  function pDiv(a,b){a=trim(a);b=trim(b);if(isZero(b))throw new Error('交点多项式除数为零');const q=Array(Math.max(1,a.length-b.length+1)).fill(zero);while(a.length>=b.length&&!isZero(a)){const index=a.length-b.length,c=div(a.at(-1),b.at(-1));q[index]=c;const next=a.slice();for(let j=0;j<b.length;j++)next[index+j]=sub(next[index+j],mul(c,b[j]));a=trim(next);}return {q:trim(q),r:a};}
  function integers(p){let denominator=1n;for(const v of p){denominator=denominator/gcd(denominator,v.d)*v.d;tick(denominator);}return {values:p.map(v=>v.n*(denominator/v.d)),denominator};}
  return {rat,add,neg,sub,mul,div,pAdd,pNeg,pSub,pScale,pMul,pDiv,integers,tick,get operations(){return operations;}};
}
function resultant(F,G,A){
  const m=F.length-1,n=G.length-1,size=m+n;
  if(!size)return [zero];
  const matrix=Array.from({length:size},()=>Array.from({length:size},()=>[zero]));
  for(let row=0;row<n;row++)for(let j=0;j<=m;j++)matrix[row][row+j]=F[m-j];
  for(let row=0;row<m;row++)for(let j=0;j<=n;j++)matrix[n+row][row+j]=G[n-j];
  const memo=new Map();function determinant(row,mask){
    if(row===size)return [one];if(memo.has(mask))return memo.get(mask);let sum=[zero],position=0;
    for(let column=0;column<size;column++)if(mask&(1<<column)){const entry=matrix[row][column];if(!isZero(entry)){const product=A.pMul(entry,determinant(row+1,mask^(1<<column)));sum=position%2?A.pSub(sum,product):A.pAdd(sum,product);}position++;}
    memo.set(mask,sum);return sum;
  }
  return determinant(0,(1<<size)-1);
}
function ringGcd(F,G,R,A){
  const modulus=R.map(n=>A.rat(n)),reduce=p=>A.pDiv(p,modulus).r;
  const add=(a,b)=>A.pAdd(a,b),sub=(a,b)=>A.pSub(a,b),mul=(a,b)=>reduce(A.pMul(a,b));
  function inverse(value){
    let r0=modulus,r1=reduce(value),t0=[zero],t1=[one];
    while(!isZero(r1)){const {q,r}=A.pDiv(r0,r1);[r0,r1]=[r1,r];[t0,t1]=[t1,A.pSub(t0,A.pMul(q,t1))];}
    if(r0.length!==1){const error=new Error('split');error.factor=K.primitive(A.integers(r0).values);throw error;}
    return reduce(A.pScale(t0,A.div(one,r0[0])));
  }
  const trimS=p=>{p=p.slice();while(p.length>1&&isZero(p.at(-1)))p.pop();return p;},zeroS=p=>p.every(isZero);
  function remainderS(a,b){a=trimS(a);b=trimS(b);const inv=inverse(b.at(-1));while(a.length>=b.length&&!zeroS(a)){const index=a.length-b.length,c=mul(a.at(-1),inv),next=a.slice();for(let j=0;j<b.length;j++)next[index+j]=sub(next[index+j],mul(c,b[j]));a=trimS(next);}return a;}
  let a=trimS(F.map(reduce)),b=trimS(G.map(reduce));while(!zeroS(b)){const r=remainderS(a,b);a=b;b=r;}
  if(zeroS(a))throw new Error('交点方程在此分支退化，无法确定孤立参数');
  const inv=inverse(a.at(-1));return a.map(v=>mul(v,inv));
}
function rationalNumber(value){
  if(!value.n)return 0;const n=value.n<0n?-value.n:value.n,ns=Math.max(0,n.toString(2).length-54),ds=Math.max(0,value.d.toString(2).length-54),m=Number(n>>BigInt(ns))/Number(value.d>>BigInt(ds)),number=m*2**(ns-ds);return value.n<0n?-number:number;
}
function parameterSign(values,R,root){
  if(values.every(v=>!v))return 0;
  const sign=K.intervalSign(values.map(n=>({n,e:0})),root.lo,root.hi);if(sign)return sign;
  const common=K.polynomialGcd(R,values);
  if(common.length>1){const coefficients=common.map(n=>({n,e:0}));if(root.lo===root.hi?K.sign(K.exactValue(coefficients,root.t))===0:K.sign(K.exactValue(coefficients,root.lo))*K.sign(K.exactValue(coefficients,root.hi))<0)return 0;}
  throw new Error('交点参数过于接近有限曲线端点，当前数值精度无法判定');
}
function valueAt(polynomial,t,A){const dyadic=K.dyadic(t),x=dyadic.e>=0?A.rat(dyadic.n<<BigInt(dyadic.e)):A.rat(dyadic.n,1n<<BigInt(-dyadic.e));let result=zero;for(let i=polynomial.length-1;i>=0;i--)result=A.add(A.mul(result,x),polynomial[i]);return rationalNumber(result);}
function preparedPower(points,exact,A){
  if(exact){for(const key of ['x','y'])if(!Array.isArray(exact[key])||!exact[key].length||exact[key].length>4||exact[key].some(v=>typeof v?.n!=='bigint'||typeof v?.d!=='bigint'||v.d<=0n))throw new Error('交点精确曲线系数无效');return {x:trim(exact.x.map(v=>A.rat(v.n,v.d))),y:trim(exact.y.map(v=>A.rat(v.n,v.d)))};}
  return Object.fromEntries(['x','y'].map(key=>[key,trim(power(points,key,{x:0,y:0}).map(v=>v.e>=0?A.rat(v.n<<BigInt(v.e)):A.rat(v.n,1n<<BigInt(-v.e))))]));
}
function parameterValue(polynomial,R,root,A){
  const {values,denominator}=A.integers(polynomial),oneLess=values.slice();oneLess[0]-=denominator;
  const lower=parameterSign(values,R,root),upper=parameterSign(oneLess,R,root);if(lower<0||upper>0)return null;if(!lower)return 0;if(!upper)return 1;
  const number=valueAt(polynomial,root.t,A);if(!Number.isFinite(number)||number<=0||number>=1)throw new Error('交点内部参数在当前数值精度下无法与端点区分');return number;
}
function representedRoot(root){if(root.lo!==root.hi&&(root.t===0||root.t===1))throw new Error('交点内部参数在当前数值精度下无法与端点区分');return root;}
function rootPair(first,second,t,u,interval,firstPower,secondPower,A){
  representedRoot({...interval,t});
  const evaluate=(P,v)=>({x:valueAt(P.x,v,A),y:valueAt(P.y,v,A)}),a=evaluate(firstPower,t),b=evaluate(secondPower,u);
  const point=t===0||t===1?a:u===0||u===1?b:a,residual=Math.hypot(a.x-b.x,a.y-b.y);
  const speed=(first.length-1)*Math.max(...first.slice(1).map((p,i)=>Math.hypot(p.x-first[i].x,p.y-first[i].y)));
  const uncertainty=speed*(interval.hi-interval.lo)+Math.max(...first.concat(second).flatMap(p=>[Math.abs(p.x),Math.abs(p.y)]),Number.MIN_VALUE)*Number.EPSILON*32+residual+Number.MIN_VALUE*32;
  if(![point.x,point.y,residual,uncertainty].every(Number.isFinite))throw new Error('交点坐标数值换算失败');
  return {point:{...point},parameterA:t,parameterB:u,parameterIntervalA:[interval.lo,interval.hi],residual,uncertainty};
}

function powerControls(P,A,degree=Math.max(P.x.length,P.y.length)-1){
  const choose=(n,k)=>k===0||k===n?1:n===3&&k===1||n===3&&k===2?3:2;
  return Array.from({length:degree+1},(_,i)=>{const p={};for(const key of ['x','y']){let value=zero;for(let k=0;k<=i;k++)value=A.add(value,A.mul(P[key][k]||zero,A.rat(BigInt(choose(i,k)),BigInt(choose(degree,k)))));p[key]=value;}return p;});
}
function exactEnd(P,end,A){return Object.fromEntries(['x','y'].map(k=>[k,end?P[k].reduce(A.add,zero):P[k][0]]));}
function separatedOnSupport(first,second,A){
  const a=powerControls(first,A),b=powerControls(second,A),equal=(p,q)=>A.sub(p.x,q.x).n===0n&&A.sub(p.y,q.y).n===0n,common=[];
  for(const t of [0,1])for(const u of [0,1])if(equal(exactEnd(first,t,A),exactEnd(second,u,A)))common.push({t,u});
  const axes=[{x:one,y:zero},{x:zero,y:one}];for(const controls of [a,b])for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++)axes.push({x:A.neg(A.sub(controls[j].y,controls[i].y)),y:A.sub(controls[j].x,controls[i].x)});
  const compare=(p,q)=>{const d=A.sub(p,q).n;return d<0n?-1:d>0n?1:0;};
  for(const axis of axes){
    if(!axis.x.n&&!axis.y.n)continue;
    const projected=controls=>controls.map(p=>A.add(A.mul(p.x,axis.x),A.mul(p.y,axis.y))),pa=projected(a),pb=projected(b),extent=values=>values.reduce((r,v)=>({min:compare(v,r.min)<0?v:r.min,max:compare(v,r.max)>0?v:r.max}),{min:values[0],max:values[0]}),ea=extent(pa),eb=extent(pb);
    if(compare(ea.max,eb.min)<0||compare(eb.max,ea.min)<0)return [];
    for(const center of [ea.max,eb.max]){
      function side(values,which){const signs=values.map(v=>compare(v,center));if(signs.includes(1)&&signs.includes(-1))return null;const s=signs.find(Boolean)||0;if(!s)return null;for(const end of [0,1])if(signs[end?signs.length-1:0]===0&&!common.some(pair=>pair[which]===end))return null;return s;}
      const sa=side(pa,'t'),sb=side(pb,'u');if(sa!==null&&sb!==null&&sa*sb<0)return common;
    }
  }
  throw new Error('候选曲线具有公共代数路径，尚不能确定孤立交点；可切换端点吸附');
}

// Restrict a B-spline to each nonzero knot span with rational de Boor algebra.
// Floating knot insertion can split a true tangency into two false crossings.
export function prepareIntersectionSpans(input,{maxOperations=500000,maxSpans=4096}={}){
  if(!Number.isInteger(maxOperations)||maxOperations<1||!Number.isInteger(maxSpans)||maxSpans<1)throw new Error('交点分段上限无效');
  const curve=validateCurve(input),A=arithmetic(maxOperations,32768),degree=curve.degree,controls=curve.controlPoints,knots=curve.knots.map(v=>rationalDyadic(v,A)),spans=[];
  if(controls.length===degree+1)return [{points:controls.map(p=>({...p})),spanIndex:0,knotRange:[curve.knots[degree],curve.knots[controls.length]]}];
  for(let k=degree;k<controls.length;k++){
    if(curve.knots[k]===curve.knots[k+1])continue;if(spans.length>=maxSpans)throw new Error('交点样条分段超过上限');
    const start=knots[k],width=A.sub(knots[k+1],start),d=controls.slice(k-degree,k+1).map(p=>({x:[rationalDyadic(p.x,A)],y:[rationalDyadic(p.y,A)]}));
    for(let r=1;r<=degree;r++)for(let j=degree;j>=r;j--){
      const index=k-degree+j,denominator=A.sub(knots[index+degree-r+1],knots[index]),alpha=[A.div(A.sub(start,knots[index]),denominator),A.div(width,denominator)],other=A.pSub([one],alpha);
      for(const key of ['x','y'])d[j][key]=A.pAdd(A.pMul(other,d[j-1][key]),A.pMul(alpha,d[j][key]));
    }
    const exactPower=d[degree],points=powerControls(exactPower,A).map(p=>({x:rationalNumber(p.x),y:rationalNumber(p.y)}));
    // A reduced point/line still uses a valid Bezier control-array shape.
    if(points.length===1)points.push({...points[0]});
    spans.push({points,exactPower,spanIndex:spans.length,knotRange:[curve.knots[k],curve.knots[k+1]]});
  }
  return spans;
}

export function selfBezierIntersections(points,{exactPower,maxOperations=100000,maxBits=32768}={}){
  if(!Array.isArray(points)||points.length<2||points.length>4||points.some(p=>!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1e8||Math.abs(p.y)>1e8))throw new Error('自交曲线无效');
  if(!Number.isInteger(maxOperations)||maxOperations<1||!Number.isInteger(maxBits)||maxBits<64)throw new Error('交点计算上限无效');
  const A=arithmetic(maxOperations,maxBits),P=preparedPower(points,exactPower,A),a=P.x,b=P.y,coefficient=(p,i)=>p[i]||zero,cross=(x,y,u,v)=>A.sub(A.mul(x,v),A.mul(y,u)),det=cross(coefficient(a,2),coefficient(a,3),coefficient(b,2),coefficient(b,3));
  if(!det.n)return {hits:[],operations:A.operations};
  const sum=A.div(cross(A.neg(coefficient(a,1)),coefficient(a,3),A.neg(coefficient(b,1)),coefficient(b,3)),det),term=A.div(cross(coefficient(a,2),A.neg(coefficient(a,1)),coefficient(b,2),A.neg(coefficient(b,1))),det),product=A.sub(A.mul(sum,sum),term);
  const roots=K.rootIntervals(A.integers([product,A.neg(sum),one]).values).map(representedRoot);
  return {hits:roots.length===2?[rootPair(points,points,roots[0].t,roots[1].t,roots[0],P,P,A)]:[],operations:A.operations};
}

// The resultant only generates candidates. GCD in Q[t]/R proves a common
// parameter factor, splitting R whenever a coefficient is a non-unit. This
// rejects real projection roots whose only corresponding parameter is complex.
export function intersectBezier(first,second,{maxOperations=100000,maxBits=32768,firstPower,secondPower,parameterCertificates=false,coordinateLimit=1e8}={}){
  if(!Number.isFinite(coordinateLimit)||coordinateLimit<1||coordinateLimit>1e12)throw new Error('临时交点搜索坐标上限无效');
  for(const points of [first,second])if(!Array.isArray(points)||points.length<2||points.length>4||points.some(p=>!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>coordinateLimit||Math.abs(p.y)>coordinateLimit))throw new Error('交点曲线须为有效直线、二次或三次 Bezier');
  if(!Number.isInteger(maxOperations)||maxOperations<1||!Number.isInteger(maxBits)||maxBits<64)throw new Error('交点计算上限无效');
  const A=arithmetic(maxOperations,maxBits);
  const P=preparedPower(first,firstPower,A),Q=preparedPower(second,secondPower,A),polynomials=[P.x,P.y,Q.x,Q.y],integers=A.integers(polynomials.flat()).values;let cursor=0;
  const [ax,ay,bx,by]=polynomials.map(p=>{const v=integers.slice(cursor,cursor+p.length);cursor+=p.length;return v;});
  const pair=(t,u,r,equation)=>({...rootPair(first,second,t,u,r,P,Q,A),...(parameterCertificates?{parameterEquationA:(equation||[BigInt(-t),1n]).map(String)}:{})});
  function equation(a,b){const constant=a.slice();constant[0]-=b[0];return [constant.map(n=>A.rat(n)),...b.slice(1).map(n=>[A.rat(-n)])];}
  const F=equation(ax,bx),G=equation(ay,by),hits=[];
  // A point parameterization has infinitely many parameter pairs, but its
  // finite geometric image is one point; find the other curve's exact preimages.
  if(bx.length===1&&by.length===1){
    const x=ax.slice(),y=ay.slice();x[0]-=bx[0];y[0]-=by[0];const common=K.polynomialGcd(x,y);
    if(common.every(v=>!v))hits.push(pair(0,0,{lo:0,hi:0}));else for(const r of K.rootIntervals(common))hits.push(pair(r.t,0,r,common));
    return {hits,operations:A.operations};
  }
  if(ax.length===1&&ay.length===1){const result=intersectBezier(second,first,{maxOperations,maxBits,firstPower:Q,secondPower:P,parameterCertificates,coordinateLimit});return {...result,hits:result.hits.map(h=>({...h,parameterA:h.parameterB,parameterB:h.parameterA,parameterIntervalA:[0,0],...(parameterCertificates?{parameterEquationA:['0','1']}:{})}))};}
  const elimination=K.primitive(A.integers(resultant(F,G,A)).values);
  if(elimination.every(v=>!v)){
    return {hits:separatedOnSupport(P,Q,A).map(v=>pair(v.t,v.u,{lo:v.t,hi:v.t})),operations:A.operations};
  }
  // Square-free integer root isolation is already exact for represented inputs.
  // Its returned binary64 intervals remain explicit numerical output bounds.
  const pending=[K.squareFreeIntegers(elimination)];let branches=0;
  while(pending.length){
    if(++branches>24)throw new Error('交点代数分支超过上限');const R=pending.pop();const roots=K.rootIntervals(R);if(!roots.length)continue;
    let H;try{H=ringGcd(F,G,R,A);}catch(error){if(error.factor&&error.factor.length>1&&error.factor.length<R.length){pending.push(error.factor,K.dividePolynomial(R,error.factor));continue;}throw error;}
    if(H.length===1)continue;
    if(H.length===2){const polynomial=A.pNeg(H[0]);for(const r of roots){const u=parameterValue(polynomial,R,r,A);if(u!==null)hits.push(pair(r.t,u,r,R));}}
    else if(H.every(p=>p.length===1)){const parameters=K.rootIntervals(A.integers(H.map(p=>p[0])).values).map(representedRoot);for(const r of roots)for(const s of parameters)hits.push(pair(r.t,s.t,r,R));}
    else throw new Error('交点对应多个相关参数，当前算法尚不能完整隔离');
  }
  hits.sort((a,b)=>a.parameterA-b.parameterA||a.parameterB-b.parameterB);
  return {hits,operations:A.operations};
}

// Certificates come from intersectBezier({parameterCertificates:true}): each interval isolates one root of
// its equation. Equal rounded parameters or touching brackets are NOT proof
// of the same root. An unresolved order must abort a destructive operation.
export function compareIntersectionParameters(a,b){
  const [al,ah]=a.parameterIntervalA,[bl,bh]=b.parameterIntervalA;
  if(al===ah&&bl===bh)return Math.sign(al-bl);
  if(ah<=bl)return -1;if(bh<=al)return 1;
  const pa=a.parameterEquationA.map(BigInt),pb=b.parameterEquationA.map(BigInt),value=(p,t)=>K.sign(K.exactValue(p.map(n=>({n,e:0})),t));
  if(al===ah){if(value(pb,al)===0)return 0;}
  else if(bl===bh){if(value(pa,bl)===0)return 0;}
  else{
    const common=K.polynomialGcd(pa,pb),lo=Math.max(al,bl),hi=Math.min(ah,bh);
    if(common.length>1&&value(common,lo)*value(common,hi)<0)return 0;
  }
  throw new Error('切点参数过于接近，无法证明其顺序或是否相同；未生成修剪结果');
}

const floatBuffer=new ArrayBuffer(8),floatView=new DataView(floatBuffer);
function nextFloat(value,up){
  if(value===0)return up?Number.MIN_VALUE:-Number.MIN_VALUE;
  floatView.setFloat64(0,value);let bits=floatView.getBigUint64(0);bits+=(value>0)===up?1n:-1n;floatView.setBigUint64(0,bits);return floatView.getFloat64(0);
}
function outwardNumber(value,up,A){
  let number=rationalNumber(value);if(!Number.isFinite(number))throw new Error('修剪误差换算超出数值范围');
  for(let i=0;i<8;i++){
    const difference=A.sub(rationalDyadic(number,A),value).n;
    if(up?difference>=0n:difference<=0n)return number;
    number=nextFloat(number,up);
  }
  throw new Error('无法给出修剪数值误差上界');
}

// Substitute at represented cut parameters in exact rational power form,
// then round Bernstein controls once. The returned bound covers both this
// rounding and displacement from each algebraic root in its isolating interval.
export function restrictNativeSpan(points,start,end,{exactPower,degree=Math.max(1,points.length-1),startInterval=[start,start],endInterval=[end,end]}={}){
  if(![start,end,...startInterval,...endInterval].every(v=>Number.isFinite(v)&&v>=0&&v<=1)||!(end>start)||start<startInterval[0]||start>startInterval[1]||end<endInterval[0]||end>endInterval[1])throw new Error('原生修剪参数区间无效');
  const A=arithmetic(200000,32768),P=preparedPower(points,exactPower,A),powerDegree=Math.max(P.x.length,P.y.length)-1;
  if(!Number.isInteger(degree)||degree<Math.max(1,powerDegree)||degree>3)throw new Error('原生修剪曲线阶数无效');
  const a=rationalDyadic(start,A),b=rationalDyadic(end,A),affine=[a,A.sub(b,a)],substitute=polynomial=>{
    let result=[zero];for(let i=polynomial.length-1;i>=0;i--)result=A.pAdd(A.pMul(result,affine),[polynomial[i]]);return result;
  },restricted={x:substitute(P.x),y:substitute(P.y)},controls=powerControls(restricted,A,degree),sourceControls=powerControls(P,A,Math.max(1,powerDegree)),abs=v=>v.n<0n?A.neg(v):v,max=(a,b)=>A.sub(a,b).n>=0n?a:b;
  let rounding=zero,speed=zero,parameterError=zero;
  const rounded=controls.map(control=>{const p={x:rationalNumber(control.x),y:rationalNumber(control.y)};if(!Number.isFinite(p.x)||!Number.isFinite(p.y))throw new Error('修剪控制点换算失败');rounding=max(rounding,A.add(abs(A.sub(control.x,rationalDyadic(p.x,A))),abs(A.sub(control.y,rationalDyadic(p.y,A)))));return p;});
  for(let i=1;i<sourceControls.length;i++)speed=max(speed,A.mul(A.rat(BigInt(sourceControls.length-1)),A.add(abs(A.sub(sourceControls[i].x,sourceControls[i-1].x)),abs(A.sub(sourceControls[i].y,sourceControls[i-1].y)))));
  for(const [t,interval] of [[a,startInterval],[b,endInterval]])for(const endpoint of interval)parameterError=max(parameterError,abs(A.sub(t,rationalDyadic(endpoint,A))));
  const errorBound=outwardNumber(A.add(rounding,A.mul(speed,parameterError)),true,A),bounds={};
  for(const key of ['x','y']){
    let min=controls[0][key],maximum=min;for(const c of controls){if(A.sub(c[key],min).n<0n)min=c[key];maximum=max(maximum,c[key]);}
    bounds['min'+key.toUpperCase()]=outwardNumber(min,false,A);bounds['max'+key.toUpperCase()]=outwardNumber(maximum,true,A);
  }
  return {points:rounded,errorBound,bounds,constant:powerDegree===0};
}

// Internal exact arithmetic shared by native continuation and length proofs.
// Keep rational powers separate from binary64 display/control-point output.
export const exactNativeKernel=Object.freeze({arithmetic,preparedPower,powerControls,rationalDyadic,rationalNumber,outwardNumber,nextFloat,zero,one});
