import {readV5Curve} from './prj-v5-curves.mjs';

export function readV5References(bytes,parsed){
  const fail=()=>{throw new Error('新版 PRJ：回存所需的曲线引用或边界不受支持。');};
  const m=parsed.metadata,roots=m.sizeVariants,ranges=m.unparsedFollowingRanges;
  if(m.layout!=='native-v5-7248'||roots?.length!==1)fail();
  const root=roots[0],end=ranges.find(r=>r.scope==='between-curves-and-pieces')?.offset;
  const curves=parsed.entities.filter(e=>[2,4,23].includes(e.source?.recordKind));
  if(!Number.isInteger(end)||end>bytes.length||curves.length!==root.curveCount)fail();
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  return curves.map((entity,i)=>{
    const start=entity.source.offset,limit=curves[i+1]?.source.offset??end;
    const geometry=readV5Curve(bytes,start,i,limit);
    if(!geometry||limit<=start||geometry.entity.source.sourceId!==entity.source.sourceId)fail();
    let cursor=geometry.geometryEnd;
    if(geometry.kind===4&&!geometry.parametersIncluded)fail();
    if(geometry.kind===23){if(cursor+4>limit||view.getUint32(cursor,true)!==0)fail();cursor+=4;}
    const refs=()=>{
      if(cursor+4>limit)fail();const countOffset=cursor,count=view.getUint32(cursor,true);cursor+=4;
      if(count>10000||cursor+4*count>limit)fail();
      const offset=cursor,indices=Array.from({length:count},(_,j)=>view.getUint32(cursor+4*j,true));cursor+=4*count;
      if(indices.some(n=>n<1||n>m.nodes.length))fail();return {countOffset,offset,indices};
    };
    const directReferences=refs(),secondaryReferences=refs();
    if(cursor>limit)fail();
    return {entity,index:i+1,start,end:limit,tailOffset:cursor,direct:directReferences.indices,
      secondary:secondaryReferences.indices,directReferences,secondaryReferences};
  });
}

// An opaque four-byte field is preserved from the source record.
// Its semantics are not inferred; all other observed ordinary-line tail bytes
// must match. New lines inherit this existing ordinary-line record's styling.
export function ordinaryV5Tail(bytes,record){
  // The observed trailer is 36 bytes: style identity at indices 21..24,
  // float -1 at 29..32, and three trailing zeros.
  const tail=new Uint8Array(36);tail[6]=128;tail[7]=63;tail[31]=128;tail[32]=191;
  return record.end-record.tailOffset===36&&tail.every((v,i)=>i>=21&&i<=24||bytes[record.tailOffset+i]===v);
}
export function ordinaryV5Node(bytes,nodes,index,textStart){
  const node=nodes[index-1];if(!node)return false;
  const end=nodes[index]?.offset??textStart;
  const tail=[0,0,0,0,0,0,0,0,128,62,0,0];
  return end-node.offset===42&&node.recordType===6&&!node.flags.some(Boolean)&&
    tail.every((v,i)=>bytes[node.offset+30+i]===v);
}
export function v5TextStart(parsed){
  return Math.min(...parsed.entities.filter(e=>e.type==='text'&&e.source?.sourceId).map(e=>e.source.offset));
}
