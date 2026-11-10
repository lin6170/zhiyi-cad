// Conservative separation and simple-boundary certificates for native Beziers.
// Subdivision uses exact dyadic rationals (binary64 inputs are dyadic), so a
// tangency cannot disappear between display samples or after subdivision.
const bits=new DataView(new ArrayBuffer(8)),zero={n:0n,e:0};
function dyadic(x){if(!Number.isFinite(x))throw new Error('原生边界包含非有限坐标');if(x===0)return zero;bits.setFloat64(0,x,false);const hi=bits.getUint32(0,false),lo=bits.getUint32(4,false),exponent=(hi>>>20)&2047;let n=(BigInt(hi&0xfffff)<<32n)|BigInt(lo);if(exponent)n|=1n<<52n;if(hi>>>31)n=-n;return {n,e:exponent?exponent-1075:-1074};}
function plus(a,b){if(!a.n)return b;if(!b.n)return a;const e=Math.min(a.e,b.e);return {n:(a.n<<BigInt(a.e-e))+(b.n<<BigInt(b.e-e)),e};}
const negative=a=>({n:-a.n,e:a.e}),minus=(a,b)=>plus(a,negative(b)),times=(a,b)=>!a.n||!b.n?zero:{n:a.n*b.n,e:a.e+b.e},compare=(a,b)=>{const n=minus(a,b).n;return n<0n?-1:n>0n?1:0;};
function numeric(a){if(!a.n)return 0;const number=Number(a.n);if(Number.isFinite(number))return number*2**a.e;const n=a.n<0n?-a.n:a.n,shift=Math.max(0,n.toString(2).length-53);return (a.n<0n?-1:1)*Number(n>>BigInt(shift))*2**(a.e+shift);}
const exactPoint=p=>({x:dyadic(p.x),y:dyadic(p.y)}),same=(a,b)=>compare(a.x,b.x)===0&&compare(a.y,b.y)===0,mid=(a,b)=>{const p=plus(a,b);return p.n?{n:p.n,e:p.e-1}:zero;};
function packet(exact,depth=0,originalEnds=[true,true]){const points=exact.map(p=>({x:numeric(p.x),y:numeric(p.y)}));return {exact,points,depth,originalEnds,minX:Math.min(...points.map(p=>p.x)),maxX:Math.max(...points.map(p=>p.x)),minY:Math.min(...points.map(p=>p.y)),maxY:Math.max(...points.map(p=>p.y))};}
function split(part){let row=part.exact;const a=[row[0]],b=[row.at(-1)];while(row.length>1){row=row.slice(0,-1).map((p,i)=>({x:mid(p.x,row[i+1].x),y:mid(p.y,row[i+1].y)}));a.push(row[0]);b.unshift(row.at(-1));}return [packet(a,part.depth+1,[part.originalEnds[0],false]),packet(b,part.depth+1,[false,part.originalEnds[1]])];}
function axes(a,b){const result=[{x:1,y:0,length:1},{x:0,y:1,length:1}];for(const part of [a,b])for(let i=0;i<part.exact.length;i++)for(let j=i+1;j<part.exact.length;j++){const dx=minus(part.exact[j].x,part.exact[i].x),dy=minus(part.exact[j].y,part.exact[i].y),length=Math.hypot(numeric(dx),numeric(dy));if(length)result.push({exact:{x:negative(dy),y:dx},length});}return result;}
function flatness(part){const a=part.points[0],b=part.points.at(-1),dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);return length?Math.max(...part.points.map(p=>Math.abs((p.x-a.x)*dy-(p.y-a.y)*dx)/length)):Math.hypot(part.maxX-part.minX,part.maxY-part.minY);}
function project(points,origin,axis){const x=axis.exact?.x||dyadic(axis.x),y=axis.exact?.y||dyadic(axis.y);return points.map(p=>plus(times(minus(p.x,origin.x),x),times(minus(p.y,origin.y),y)));}
function extent(values){let min=values[0],max=min;for(const v of values){if(compare(v,min)<0)min=v;if(compare(v,max)>0)max=v;}return {min,max};}
export function exactLineContact(first,second){
  const [a,b]=first.map(exactPoint),[c,d]=second.map(exactPoint),cross=(p,q,r)=>minus(times(minus(q.x,p.x),minus(r.y,p.y)),times(minus(q.y,p.y),minus(r.x,p.x))),sign=v=>compare(v,zero),plain=p=>({x:numeric(p.x),y:numeric(p.y)}),between=(p,q,r)=>['x','y'].every(k=>compare(r[k],compare(p[k],q[k])<0?p[k]:q[k])>=0&&compare(r[k],compare(p[k],q[k])>0?p[k]:q[k])<=0);
  const o1=sign(cross(a,b,c)),o2=sign(cross(a,b,d)),o3=sign(cross(c,d,a)),o4=sign(cross(c,d,b));
  if(same(a,b))return !o3&&between(c,d,a)?{kind:'touch',point:plain(a)}:null;
  if(same(c,d))return !o1&&between(a,b,c)?{kind:'touch',point:plain(c)}:null;
  if(!o1&&!o2){const k=compare(a.x,b.x)?'x':'y',order=(p,q)=>compare(p[k],q[k]),A=[a,b].sort(order),B=[c,d].sort(order),lo=order(A[0],B[0])>0?A[0]:B[0],hi=order(A[1],B[1])<0?A[1]:B[1],difference=order(lo,hi);return difference>0?null:difference===0?{kind:'touch',point:plain(lo)}:{kind:'overlap',start:plain(lo),end:plain(hi)};}
  if(o1*o2>0||o3*o4>0)return null;
  for(const [p,q,r] of [[a,b,c],[a,b,d],[c,d,a],[c,d,b]])if(!sign(cross(p,q,r))&&between(p,q,r))return {kind:'touch',point:plain(r)};
  // Existence/classification is exact; the display location is approximate.
  const rx=minus(b.x,a.x),ry=minus(b.y,a.y),sx=minus(d.x,c.x),sy=minus(d.y,c.y),den=minus(times(rx,sy),times(ry,sx)),num=minus(times(minus(c.x,a.x),sy),times(minus(c.y,a.y),sx)),t=numeric(num)/numeric(den);
  const point={x:first[0].x+(first[1].x-first[0].x)*t,y:first[0].y+(first[1].y-first[0].y)*t};
  return {kind:'crossing',point:Number.isFinite(point.x)&&Number.isFinite(point.y)?point:undefined,pointApproximate:true};
}
function endpointCertificate(a,b,pa,pb,center,allowed){
  function side(part,values){const signs=values.map(p=>compare(p,center));if(signs.includes(1)&&signs.includes(-1))return null;const s=signs.find(Boolean)||0;
    // Positive Bernstein weights prove strict interior separation when at
    // least one control is strictly on that side. Only endpoints can remain
    // on the separator, and those must be one of the two allowed join points.
    if(s)for(const end of [0,1]){const i=end?values.length-1:0;if(signs[i]===0&&(!part.originalEnds[end]||!allowed.some(p=>same(p,part.exact[i]))))return null;}
    return s;
  }
  const sa=side(a,pa),sb=side(b,pb);return sa!==null&&sb!==null&&(sa!==0||sb!==0)&&sa*sb<=0;
}
function elevated(points,degree){
  // Exact degree elevation with an integer common denominator. Do not round
  // 1/3 to binary64: equality of the projected polynomials is the certificate.
  let controls=points,scale=1;
  while(controls.length<=degree){const n=controls.length,next=[controls[0]];for(let i=1;i<n;i++)next.push({x:plus(times(dyadic(i),controls[i-1].x),times(dyadic(n-i),controls[i].x)),y:plus(times(dyadic(i),controls[i-1].y),times(dyadic(n-i),controls[i].y))});next[0]={x:times(dyadic(n),controls[0].x),y:times(dyadic(n),controls[0].y)};next.push({x:times(dyadic(n),controls.at(-1).x),y:times(dyadic(n),controls.at(-1).y)});controls=next;scale*=n;}
  return {controls,scale};
}
function strictlyMonotone(values){const increments=values.slice(1).map((v,i)=>minus(v,values[i]));return increments.some(v=>v.n!==0n)&&(nonnegativeDerivative(increments)||nonnegativeDerivative(increments.map(negative)));}
function sharedProjectionCertificate(a,b,allowed){
  const degree=Math.max(a.exact.length,b.exact.length)-1,A=elevated(a.exact,degree),B=elevated(b.exact,degree),scaled=(controls,scale)=>controls.map(p=>({x:times(p.x,dyadic(scale)),y:times(p.y,dyadic(scale))})),first=scaled(A.controls,B.scale),second=scaled(B.controls,A.scale);
  for(const reverse of [false,true]){
    const other=reverse?[...second].reverse():second,deltas=first.map((p,i)=>({x:minus(other[i].x,p.x),y:minus(other[i].y,p.y)})),direction=deltas.find(p=>p.x.n||p.y.n);if(!direction)continue;
    const axis={exact:{x:negative(direction.y),y:direction.x}},pa=project(first,first[0],axis),pb=project(other,first[0],axis);
    if(pa.some((v,i)=>compare(v,pb[i])!==0)||!strictlyMonotone(pa))continue;
    // Identical strictly monotone projections force any intersection to have
    // equal parameters. Positive Bernstein weights then exclude all interior
    // equal-parameter contacts when one difference component has one sign.
    const component=direction.x.n?'x':'y',signs=deltas.map(p=>compare(p[component],zero));if(signs.includes(1)&&signs.includes(-1))continue;
    let legal=true;
    for(const end of [0,1]){const otherEnd=reverse?1-end:end,p=end?a.exact.at(-1):a.exact[0],q=otherEnd?b.exact.at(-1):b.exact[0];if(same(p,q)&&(!a.originalEnds[end]||!b.originalEnds[otherEnd]||!allowed.some(v=>same(v,p)))){legal=false;break;}}
    if(legal)return true;
  }
  return false;
}
function separationChecker(tolerance,maxNodes){
  const stats={pairs:0,checks:0,subdivisions:0,graphCertificates:0};
  function check(a,b,allowed){
    stats.pairs++;
    const pending=[[a,b]];
    while(pending.length){const [left,right]=pending.pop();if(++stats.checks>maxNodes)throw new Error('原生边界接触检查超过复杂度上限，无法确认分离');
      const broadTolerance=tolerance+Math.max(1,Math.abs(left.minX),Math.abs(left.maxX),Math.abs(left.minY),Math.abs(left.maxY),Math.abs(right.minX),Math.abs(right.maxX),Math.abs(right.minY),Math.abs(right.maxY))*Number.EPSILON*8;
      if(left.maxX<right.minX-broadTolerance||right.maxX<left.minX-broadTolerance||left.maxY<right.minY-broadTolerance||right.maxY<left.minY-broadTolerance)continue;
      // A subdivision point is never promoted to an allowed original join.
      const originalEnd=(part,p)=>[0,1].some(end=>part.originalEnds[end]&&same(p,end?part.exact.at(-1):part.exact[0]));
      const common=allowed.filter(p=>originalEnd(left,p)&&originalEnd(right,p)),origin=left.exact[0];let separated=false;
      for(const axis of axes(left,right)){
        const pa=project(left.exact,origin,axis),pb=project(right.exact,origin,axis),ea=extent(pa),eb=extent(pb);
        const margin=times(dyadic(tolerance),dyadic(axis.length));
        if(compare(minus(eb.min,ea.max),margin)>0||compare(minus(ea.min,eb.max),margin)>0){separated=true;break;}
        // Every contact on this separator must be a legal end of this pair,
        // not merely a globally allowed coordinate on some other span.
        for(const point of common){const center=project([point],origin,axis)[0];if(endpointCertificate(left,right,pa,pb,center,common)){separated=true;break;}}if(separated)break;
      }
      if(separated)continue;
      // This proves non-contact, not a positive metric clearance. Never use it
      // to waive the caller's nonzero distance requirement.
      if(tolerance===0&&sharedProjectionCertificate(left,right,common)){stats.graphCertificates++;continue;}
      if(left.depth+right.depth>=80||left.exact.length===2&&right.exact.length===2){const failure=new Error('原生边界有额外接触、重叠，或间距不足以确认分离');failure.nativeReason=tolerance===0&&left.exact.length===2&&right.exact.length===2?'linear-contact':'unresolved';throw failure;}
      const splitLeft=right.exact.length===2||left.exact.length!==2&&(flatness(left)>flatness(right)||flatness(left)===flatness(right)&&Math.hypot(left.maxX-left.minX,left.maxY-left.minY)>=Math.hypot(right.maxX-right.minX,right.maxY-right.minY));
      const halves=split(splitLeft?left:right);stats.subdivisions++;for(const half of halves)pending.push(splitLeft?[half,right]:[left,half]);
    }
  }
  return {check,stats};
}
function settings(tolerance,maxNodes){if(!Number.isFinite(tolerance)||tolerance<0||!Number.isInteger(maxNodes)||maxNodes<1)throw new Error('原生接触检查设置无效');}
function inputPackets(parts){if(!Array.isArray(parts)||parts.length>20000)throw new Error('原生边界分段数量无效');return parts.map(part=>{if(!Array.isArray(part.points)||part.points.length<2||part.points.length>4)throw new Error('原生边界须为直线、二次或三次 Bezier 分段');return packet(part.points.map(exactPoint));});}
export function assertNativeSeparated(first,second,allowedPoints,{tolerance=1e-10,maxNodes=200000}={}){
  settings(tolerance,maxNodes);
  // Only each chain's terminal endpoints can be actual joins. An internal
  // span endpoint at the same coordinate must not inherit this permission.
  const chain=parts=>inputPackets(parts).map((p,i)=>({...p,originalEnds:[i===0,i===parts.length-1]}));
  const A=chain(first),B=chain(second),allowed=allowedPoints.map(exactPoint),{check,stats}=separationChecker(tolerance,maxNodes);
  // Sweep broad-phase control hull bounds before the exact pair certificates.
  const sorted=B.slice().sort((a,b)=>a.minX-b.minX),broad=tolerance+Math.max(1,...A.flatMap(p=>[Math.abs(p.minX),Math.abs(p.maxX)]),...B.flatMap(p=>[Math.abs(p.minX),Math.abs(p.maxX)]))*Number.EPSILON*8;
  for(const a of A)for(const b of sorted){if(b.minX>a.maxX+broad)break;if(b.maxX<a.minX-broad||b.maxY<a.minY-broad||b.minY>a.maxY+broad)continue;check(a,b,allowed);}
  return stats;
}

function nonnegativeDerivative(values){
  if(values.some(v=>compare(v,zero)<0)){
    if(values.length!==3||compare(values[0],zero)<0||compare(values[2],zero)<0)return false;
    // For q(t)=a*t²+b*t+c the only possible interior minimum is its vertex.
    // Compare 4*a*c-b² exactly, avoiding an approximate double-root solver.
    const two=dyadic(2),four=dyadic(4),c=values[0],b=times(two,minus(values[1],c)),a=plus(minus(c,times(two,values[1])),values[2]);
    if(compare(a,zero)>0&&compare(b,zero)<0&&compare(negative(b),times(two,a))<0)return compare(minus(times(times(four,a),c),times(b,b)),zero)>=0;
  }
  return true;
}
function injective(part){
  // A projected derivative that is nonnegative and not identically zero
  // gives a strictly monotone polynomial curve, including isolated zero
  // velocities. A chosen binary64 axis is itself projected exactly.
  const directions=[];
  for(let i=1;i<part.exact.length;i++){
    const x=numeric(minus(part.exact[i].x,part.exact[i-1].x)),y=numeric(minus(part.exact[i].y,part.exact[i-1].y)),length=Math.hypot(x,y);
    if(length)directions.push({x:x/length,y:y/length});
  }
  const candidates=[{x:1,y:0},{x:0,y:1},...directions];
  for(let i=0;i<directions.length;i++)for(let j=i+1;j<directions.length;j++){
    const x=directions[i].x+directions[j].x,y=directions[i].y+directions[j].y,length=Math.hypot(x,y);if(length)candidates.push({x:x/length,y:y/length});
  }
  return candidates.some(axis=>strictlyMonotone(project(part.exact,part.exact[0],axis)));
}
export function assertNativeSimpleBoundary(parts,{connectGaps=false,maxNodes=200000,maxPairs=2000000}={}){
  settings(0,maxNodes);if(typeof connectGaps!=='boolean'||!Number.isInteger(maxPairs)||maxPairs<1)throw new Error('原生轮廓检查设置无效');
  const original=inputPackets(parts).map((p,sourcePart)=>({...p,sourcePart})).filter(p=>!p.exact.every(q=>same(q,p.exact[0]))),closed=[];
  if(!original.length)throw new Error('原生轮廓退化为空');
  let bridges=0,monotoneChecks=0,monotoneSubdivisions=0;
  original.forEach((part,i)=>{closed.push(part);const next=original[(i+1)%original.length],end=part.exact.at(-1),start=next.exact[0];if(!same(end,start)){if(!connectGaps)throw new Error('原生轮廓未闭合，请核对连接间隙');closed.push({...packet([end,start]),sourcePart:null,bridgeBetween:[part.sourcePart,next.sourcePart]});bridges++;}});
  const leaves=[];
  for(const part of closed){
    const pending=[{packet:part,t0:0,t1:1}];while(pending.length){const {packet:current,t0,t1}=pending.pop();if(++monotoneChecks>maxNodes)throw new Error('原生轮廓单段检查超过复杂度上限');
      if(injective(current)){leaves.push({...packet(current.exact),sourcePart:part.sourcePart,bridgeBetween:part.bridgeBetween,parameterRange:[t0,t1]});continue;}
      if(current.depth>=60){const failure=new Error('原生曲线存在回折、尖点，或无法确认单段无自交');failure.nativeContact={sourceParts:[part.sourcePart],parameterRanges:[[t0,t1]],controls:[current.points],reason:'unresolved-injectivity'};throw failure;}
      const [a,b]=split(current),middle=(t0+t1)/2;pending.push({packet:b,t0:middle,t1},{packet:a,t0,t1:middle});monotoneSubdivisions++;
    }
  }
  if(leaves.length<2)throw new Error('原生轮廓无法形成简单闭合边界');
  const {check,stats}=separationChecker(0,maxNodes),sorted=leaves.map((p,index)=>({...p,index})).sort((a,b)=>a.minX-b.minX);
  let scale=1;for(const p of leaves)scale=Math.max(scale,Math.abs(p.minX),Math.abs(p.maxX),Math.abs(p.minY),Math.abs(p.maxY));
  const broad=scale*Number.EPSILON*8;let pairVisits=0;
  for(let i=0;i<sorted.length;i++)for(let j=i+1;j<sorted.length;j++){
    const a=sorted[i],b=sorted[j];if(b.minX>a.maxX+broad)break;if(++pairVisits>maxPairs)throw new Error('原生轮廓分段比较超过复杂度上限');
    if(b.maxY<a.minY-broad||b.minY>a.maxY+broad)continue;
    const allowed=[];if((a.index+1)%leaves.length===b.index)allowed.push(a.exact.at(-1));if((b.index+1)%leaves.length===a.index)allowed.push(b.exact.at(-1));
    try{check(a,b,allowed);}catch(error){const failure=new Error('原生轮廓无法确认无自交（分段 '+(a.index+1)+' / '+(b.index+1)+'）：'+error.message);failure.nativeContact={indices:[a.index,b.index],sourceParts:[a.sourcePart,b.sourcePart],bridgeBetween:[a.bridgeBetween||null,b.bridgeBetween||null],parameterRanges:[a.parameterRange,b.parameterRange],controls:[a.points,b.points],allowed:allowed.map(p=>({x:numeric(p.x),y:numeric(p.y)})),reason:error.nativeReason||'unresolved'};throw failure;}
  }
  return {...stats,monotoneChecks,monotoneSubdivisions,pairVisits,parts:original.length,leaves:leaves.length,bridges};
}
