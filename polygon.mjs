function cross(a,b,c){return BigInt(b.X-a.X)*BigInt(c.Y-a.Y)-BigInt(b.Y-a.Y)*BigInt(c.X-a.X);}
function onSegment(a,b,p){return p.X>=Math.min(a.X,b.X)&&p.X<=Math.max(a.X,b.X)&&p.Y>=Math.min(a.Y,b.Y)&&p.Y<=Math.max(a.Y,b.Y);}
function sign(value){return value>0n?1:value<0n?-1:0;}
export function assertSimplePolygon(path) {
  for(let i=0;i<path.length;i++){
    const a=path[i],b=path[(i+1)%path.length],c=path[(i+2)%path.length];
    if(cross(a,b,c)===0n&&BigInt(b.X-a.X)*BigInt(c.X-b.X)+BigInt(b.Y-a.Y)*BigInt(c.Y-b.Y)<0n)throw new Error('基准轮廓有重叠回折，请先修复');
  }
  const segments=path.map((a,i)=>{const b=path[(i+1)%path.length];return {a,b,i,minX:Math.min(a.X,b.X),maxX:Math.max(a.X,b.X),minY:Math.min(a.Y,b.Y),maxY:Math.max(a.Y,b.Y)};}).sort((a,b)=>a.minX-b.minX);
  let checks=0;
  for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length&&segments[j].minX<=segments[i].maxX;j++){
    if(++checks>2000000)throw new Error('轮廓过于复杂，无法完成交叉检查');
    const a=segments[i],b=segments[j];
    if(Math.abs(a.i-b.i)===1||Math.abs(a.i-b.i)===path.length-1||b.minY>a.maxY||b.maxY<a.minY)continue;
    const c1=cross(a.a,a.b,b.a),c2=cross(a.a,a.b,b.b),c3=cross(b.a,b.b,a.a),c4=cross(b.a,b.b,a.b);
    if((sign(c1)*sign(c2)<0&&sign(c3)*sign(c4)<0)||(c1===0n&&onSegment(a.a,a.b,b.a))||(c2===0n&&onSegment(a.a,a.b,b.b))||(c3===0n&&onSegment(b.a,b.b,a.a))||(c4===0n&&onSegment(b.a,b.b,a.b)))throw new Error('基准轮廓存在自交、接触或重叠，请先修复');
  }
}
