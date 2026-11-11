/** Read the interleaved spline representation in the verified v5 layout.
 * The temporary buffer contains one geometry record, never an exported PRJ.
 */
import {readPrjCurve} from './prj-curves.mjs';
export function readV5Curve(bytes,offset,index=0,end=bytes.length){
  if(offset<0||offset+100>end||end>bytes.length)return null;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),u=o=>view.getUint32(o,true);
  if(u(offset+10)!==4)return readPrjCurve(bytes,offset,index,{end});
  if(u(offset+14)!==0||u(offset+41)!==0xffffffff)return null;
  const base=u(offset+45),extraFit=u(offset+49),extraControl=u(offset+53),extraScalar=u(offset+57);
  if(base<2||base>1000||extraFit>1000||extraControl>1000||extraScalar>10000||base+extraFit+2!==base+extraControl)return null;
  let c=offset+61;const fit=[],control=[],scalars=[];
  const read=(list,n)=>{if(c+n>end)throw Error('truncated');list.push(bytes.subarray(c,c+n));c+=n;};
  const readers={f:()=>read(fit,12),c:()=>read(control,12),s:()=>read(scalars,4)};
  const order=['fcs','cfs','fsc','sfc','fcs','fcs','csf','fcs','fcs','fcs'];
  try{
    for(let i=0;i<base;i++)for(const key of order[i%10])readers[key]();
    for(let i=0;i<extraFit;i++)readers.f();
    for(let i=0;i<extraControl;i++)readers.c();
    for(let i=0;i<extraScalar;i++)readers.s();
  }catch{return null;}
  if(scalars.some(s=>!Number.isFinite(new DataView(s.buffer,s.byteOffset,4).getFloat32(0,true))))return null;
  const virtual=new Uint8Array(53+fit.length*12+control.length*12+scalars.length*4),v=new DataView(virtual.buffer);
  virtual.set(bytes.subarray(offset,offset+41));let p=41;
  for(const list of [fit,control,scalars]){v.setUint32(p,list.length,true);p+=4;for(const part of list){virtual.set(part,p);p+=part.length;}}
  const record=readPrjCurve(virtual,0,index);
  if(!record)return null;
  record.offset=offset;record.entity.id=`prj-${offset}-${record.entity.source.sourceId}`;record.entity.source.offset=offset;
  record.entity.source.storage='v5-interleaved';
  record.pointOffset=null;record.pointEnd=c;record.geometryEnd=c;
  record.parametersIncluded=true;
  return record;
}
export function scanV5Curves(bytes,{start=100,end=bytes.length}={}){
  const records=[],view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let o=start;o+100<=end;o++){
    if(![2,4].includes(view.getUint32(o+10,true)))continue;
    const r=readV5Curve(bytes,o,records.length,end);
    if(r){records.push(r);o=r.pointEnd-1;}
  }
  return records;
}
