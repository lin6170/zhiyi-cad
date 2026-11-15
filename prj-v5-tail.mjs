/** Bounded native spline tail. Counts and flag 0x10 were checked against
 * all 420 records of an ET conversion and the same last spline after a
 * native line was appended. Preserve these fields; do not edit their meaning. */
export function v5SplineTailEnd(bytes,offset,limit,record,nodeCount,curveCount){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const fail=()=>{throw Error('新版 PRJ：样条尾部结构尚未支持。');};
  const u=o=>{if(o<offset||o+4>limit)fail();return view.getUint32(o,true);};
  const n=u(offset);if(n>10000)fail();
  let c=offset+4;for(let i=0;i<n;i++){const id=u(c);if(id<1||id>curveCount)fail();c+=4;}
  const scalars=record.entity.source.flags[1]&16?2:1;
  for(let i=0;i<scalars;i++){u(c);const f=view.getFloat32(c,true);if(!Number.isFinite(f)||f<=0||f>1000)fail();c+=4;}
  const links=u(c);c+=4;if(links>10000)fail();
  for(let i=0;i<links;i++){if(u(c)!==7||u(c+4)<1||u(c+4)>nodeCount)fail();c+=8;}
  if(c+24>limit||view.getFloat32(c+17,true)!==-1||!bytes.subarray(c+21,c+24).every(v=>v===0))fail();
  return c+24;
}
