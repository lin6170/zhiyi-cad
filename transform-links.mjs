// A manually declared grain direction is in source-paper coordinates, so it
// follows a rigid/uniform transform when the entire source item is selected.
export function transformMarkerGrains(project,ids,vector){
  const changed=[],partial=[],following=new Set(ids),seams=new Set();
  // Generated outputs follow a fully transformed base even if the user only
  // selected its net line. Include those members when deciding whole-piece grain.
  for(const seam of project.seamAllowances||[])if(seam.baseEntityIds.every(id=>ids.has(id))){seams.add(seam.id);for(const id of seam.outputIds)following.add(id);}
  for(const notch of project.notches||[])if(ids.has(notch.baseEntityId)&&(!notch.targetSeamId||seams.has(notch.targetSeamId)))for(const id of notch.outputIds)following.add(id);
  for(const plan of project.markerPlans||[])for(const item of plan.items){
    if(item.grainEntityId||!item.memberIds.some(id=>following.has(id)))continue;
    if(!item.memberIds.every(id=>following.has(id))){partial.push({planId:plan.id,itemId:item.id,name:item.name});continue;}
    const radians=item.grainAngle*Math.PI/180,v=vector({x:Math.cos(radians),y:Math.sin(radians)});
    if(!Number.isFinite(v.x)||!Number.isFinite(v.y)||Math.hypot(v.x,v.y)===0)throw new Error('变换后的布纹方向无效');
    item.grainAngle=Math.atan2(v.y,v.x)*180/Math.PI;changed.push({planId:plan.id,itemId:item.id,name:item.name});
  }
  return {changed,partial};
}
