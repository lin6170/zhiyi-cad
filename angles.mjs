// Preserve small signed angles: adding 360 before sin/cos can erase an angle
// that is tiny in degrees but still creates a representable CAD displacement.
export function degreeSinCos(degrees){
  if(!Number.isFinite(degrees))throw new Error('角度必须是有限数值');
  const angle=degrees%360,q=angle/90;
  if(angle%90===0){const index=((q%4)+4)%4;return {c:[1,0,-1,0][index],s:[0,1,0,-1][index]};}
  const radians=angle*Math.PI/180;if(radians===0)throw new Error('角度太小，超出当前方向数值精度');return {c:Math.cos(radians),s:Math.sin(radians)};
}
