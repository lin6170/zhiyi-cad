/** Integrity checking for the observed ET v5 storage envelope. MD5 here is a
 * file-format checksum, not authentication or a security boundary. */
const shifts=[7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
const constants=Array.from({length:64},(_,i)=>Math.floor(Math.abs(Math.sin(i+1))*4294967296)>>>0);
export function prjMd5(bytes){
  const size=Math.ceil((bytes.length+9)/64)*64,padded=new Uint8Array(size),view=new DataView(padded.buffer);
  padded.set(bytes);padded[bytes.length]=128;
  view.setUint32(size-8,(bytes.length*8)>>>0,true);view.setUint32(size-4,Math.floor(bytes.length/536870912),true);
  const state=[0x67452301,0xefcdab89,0x98badcfe,0x10325476];
  for(let block=0;block<size;block+=64){
    let [a,b,c,d]=state;
    for(let i=0;i<64;i++){
      const round=i>>>4,g=round===0?i:round===1?(5*i+1)%16:round===2?(3*i+5)%16:(7*i)%16;
      const f=round===0?(b&c)|(~b&d):round===1?(d&b)|(~d&c):round===2?b^c^d:c^(b|~d);
      const sum=(a+f+constants[i]+view.getUint32(block+g*4,true))>>>0,s=shifts[round*4+i%4];
      const next=(b+((sum<<s)|(sum>>>(32-s))))>>>0;a=d;d=c;c=b;b=next;
    }
    for(const [i,v] of [a,b,c,d].entries())state[i]=(state[i]+v)>>>0;
  }
  const digest=new Uint8Array(16),out=new DataView(digest.buffer);state.forEach((v,i)=>out.setUint32(i*4,v,true));return digest;
}
export const encodedV5Signature=[0x48,0x01,0x00,0xa0];
export function decodePrjStorage(bytes){
  const fail=message=>{throw new Error('新版 PRJ：'+message);};
  if(!(bytes instanceof Uint8Array)||bytes.length<512||bytes.length>16*1024*1024)fail('文件大小不受支持。');
  if(!encodedV5Signature.every((v,i)=>bytes[i]===v))fail('文件头不受支持。');
  const payload=bytes.subarray(0,-16),digest=prjMd5(payload);
  if(!digest.every((v,i)=>v===bytes[bytes.length-16+i]))fail('文件完整性校验失败，可能已损坏或未保存完整。');
  if(payload.length%496>480)fail('此文件的末块布局尚未验证。');
  const decoded=new Uint8Array(payload);
  for(let o=0;o+496<bytes.length;o+=496){for(let i=0;i<248;i++){decoded[o+2*i]=bytes[o+i];decoded[o+2*i+1]=bytes[o+248+i];}}
  if(![0x48,0x72,1,1,0,0,0xa0,0x40].every((v,i)=>decoded[i]===v))fail('解码版本不受支持。');
  return decoded;
}
