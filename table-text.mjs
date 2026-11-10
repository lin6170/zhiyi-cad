import {textCorners,textWidth} from './geometry.mjs';

const clone=value=>JSON.parse(JSON.stringify(value));
const snapshot=project=>JSON.stringify(project.entities);
const domain=entity=>entity.source?.sizeId||'';
const sortedIds=values=>[...new Set(values)].sort();

// These are geometric table candidates, not recovered ET table/formula records.
function segmentsOf(entity,tolerance){
  if(entity.type==='text'||entity.arrowStart||entity.arrowEnd||entity.layer==='grain')return [];
  let points=entity.points;
  if(entity.curve){
    points=entity.curve.controlPoints;
    const roundoff=32*Number.EPSILON*Math.max(1,...points.flatMap(p=>[Math.abs(p.x),Math.abs(p.y)]));
    const dx=points.at(-1).x-points[0].x,dy=points.at(-1).y-points[0].y;
    const axis=Math.abs(dx)<=roundoff?'x':Math.abs(dy)<=roundoff?'y':null;
    if(!axis||points.some(p=>Math.abs(p[axis]-points[0][axis])>roundoff))return [];
    const along=axis==='x'?'y':'x',sign=Math.sign(points.at(-1)[along]-points[0][along]);
    if(!sign||points.some((p,i)=>i&&(p[along]-points[i-1][along])*sign < -roundoff))return [];
    points=[points[0],points.at(-1)];
  }
  const segments=[];
  for(let i=0;i<points.length-(entity.closed&&!entity.curve?0:1);i++){
    const p=points[i],q=points[(i+1)%points.length],dx=Math.abs(p.x-q.x),dy=Math.abs(p.y-q.y);
    if(dx<=tolerance&&dy>2*tolerance)segments.push({axis:'v',at:(p.x+q.x)/2,from:Math.min(p.y,q.y),to:Math.max(p.y,q.y),entityId:entity.id,segment:i,domain:domain(entity)});
    else if(dy<=tolerance&&dx>2*tolerance)segments.push({axis:'h',at:(p.y+q.y)/2,from:Math.min(p.x,q.x),to:Math.max(p.x,q.x),entityId:entity.id,segment:i,domain:domain(entity)});
    if(segments.length>2500)throw new Error('可用格线过多，请框选目标表格后使用“当前选区”。');
  }
  return segments;
}
function clusters(values,tolerance){
  const groups=[];
  for(const value of [...values].sort((a,b)=>a-b)){
    const previous=groups.at(-1);
    if(previous&&value-previous[0]<=tolerance)previous.push(value);else groups.push([value]);
  }
  return groups.map(g=>g.reduce((a,b)=>a+b,0)/g.length);
}
function covered(segments,axis,at,from,to,tolerance){
  const intervals=segments.filter(s=>s.axis===axis&&Math.abs(s.at-at)<=tolerance&&s.to>=from-tolerance&&s.from<=to+tolerance).sort((a,b)=>a.from-b.from);
  let end=from;
  for(const s of intervals){if(s.from>end+tolerance)return false;end=Math.max(end,s.to);if(end>=to-tolerance)return true;}
  return false;
}
function unions(count){
  const parent=Array.from({length:count},(_,i)=>i),root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  return {root,join:(i,j)=>{const a=root(i),b=root(j);if(a!==b)parent[b]=a;}};
}
function gridTopology(lines,tolerance){
  const x=clusters(lines.filter(s=>s.axis==='v').map(s=>s.at),tolerance),y=clusters(lines.filter(s=>s.axis==='h').map(s=>s.at),tolerance).reverse(),rows=y.length-1,columns=x.length-1;
  if(rows<2||columns<2||rows>200||columns>50||rows*columns>5000||x.some((v,i)=>i&&v-x[i-1]<=2*tolerance)||y.some((v,i)=>i&&y[i-1]-v<=2*tolerance))return null;
  const borders=(r,c,rEnd=r+1,cEnd=c+1)=>({top:covered(lines,'h',y[r],x[c],x[cEnd],tolerance),bottom:covered(lines,'h',y[rEnd],x[c],x[cEnd],tolerance),left:covered(lines,'v',x[c],y[rEnd],y[r],tolerance),right:covered(lines,'v',x[cEnd],y[rEnd],y[r],tolerance)});
  const cells=Array.from({length:rows},(_,row)=>Array.from({length:columns},(_,column)=>({row,column,rowSpan:1,columnSpan:1,borders:borders(row,column),entries:[],supported:false})));
  const absent=(axis,at,from,to)=>!lines.some(s=>s.axis===axis&&Math.abs(s.at-at)<=tolerance&&Math.min(s.to,to)-Math.max(s.from,from)>tolerance);
  const faceSet=unions(rows*columns);
  for(let r=0;r<rows;r++)for(let c=0;c<columns;c++){
    if(c+1<columns&&absent('v',x[c+1],y[r+1],y[r]))faceSet.join(r*columns+c,r*columns+c+1);
    if(r+1<rows&&absent('h',y[r+1],x[c],x[c+1]))faceSet.join(r*columns+c,(r+1)*columns+c);
  }
  const rawFaces=new Map();
  for(let r=0;r<rows;r++)for(let c=0;c<columns;c++){const key=faceSet.root(r*columns+c);if(!rawFaces.has(key))rawFaces.set(key,[]);rawFaces.get(key).push({row:r,column:c});}
  const faces=[],faceAt=Array(rows*columns).fill(-1);
  for(const members of rawFaces.values()){
    const r=Math.min(...members.map(m=>m.row)),rEnd=Math.max(...members.map(m=>m.row))+1,c=Math.min(...members.map(m=>m.column)),cEnd=Math.max(...members.map(m=>m.column))+1;
    if(members.length!==(rEnd-r)*(cEnd-c))continue;
    const edges=borders(r,c,rEnd,cEnd);if(Object.values(edges).filter(Boolean).length<3)continue;
    const cell=cells[r][c];Object.assign(cell,{supported:true,rowSpan:rEnd-r,columnSpan:cEnd-c,borders:edges});
    const index=faces.length;faces.push(cell);
    for(const member of members){faceAt[member.row*columns+member.column]=index;if(member.row!==r||member.column!==c)cells[member.row][member.column].coveredBy={row:r,column:c};}
  }
  const regionSet=unions(faces.length);
  for(let r=0;r<rows;r++)for(let c=0;c<columns;c++){
    const a=faceAt[r*columns+c];if(a<0)continue;
    for(const b of [c+1<columns?faceAt[r*columns+c+1]:-1,r+1<rows?faceAt[(r+1)*columns+c]:-1])if(b>=0)regionSet.join(a,b);
  }
  const regions=new Map();faces.forEach((face,i)=>{const key=regionSet.root(i);if(!regions.has(key))regions.set(key,[]);regions.get(key).push(face);});
  return {x,y,rows,columns,cells,faces,regions:[...regions.values()]};
}
function insideCell(point,grid,tolerance){
  for(const cell of grid.faces){const {row:r,column:c,rowSpan,columnSpan}=cell;
    if(point.y<grid.y[r]-tolerance&&point.y>grid.y[r+rowSpan]+tolerance&&point.x>grid.x[c]+tolerance&&point.x<grid.x[c+columnSpan]-tolerance)return {row:r,column:c};
  }
  return null;
}
const sameCell=(a,b)=>a&&b&&a.row===b.row&&a.column===b.column;
function textIntersectsGrid(corners,x,y,tolerance){
  const rectangle=[{x:x[0],y:y[0]},{x:x.at(-1),y:y[0]},{x:x.at(-1),y:y.at(-1)},{x:x[0],y:y.at(-1)}];
  const axes=[{x:1,y:0},{x:0,y:1},...corners.slice(0,2).map((p,i)=>({x:corners[i+1].y-p.y,y:p.x-corners[i+1].x}))];
  return axes.every(axis=>{const length=Math.hypot(axis.x,axis.y);if(!length)return true;const project=p=>(p.x*axis.x+p.y*axis.y)/length,a=corners.map(project),b=rectangle.map(project);return Math.max(...a)>=Math.min(...b)-tolerance&&Math.max(...b)>=Math.min(...a)-tolerance;});
}

export function findTextTables(project,{tolerance=.001,entityIds=null}={}){
  if(!Number.isFinite(tolerance)||tolerance<0||tolerance>1)throw new Error('格线连接容差须在 0 至 1 之间。');
  const scope=entityIds?new Set(entityIds):null,entities=project.entities.filter(e=>!scope||scope.has(e.id));
  const segments=[];
  for(const entity of entities){segments.push(...segmentsOf(entity,tolerance));if(segments.length>2500)throw new Error('可用格线过多，请框选目标表格后使用“当前选区”。');}
  const parent=segments.map((_,i)=>i),root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const join=(i,j)=>{const a=root(i),b=root(j);if(a!==b)parent[b]=a;};
  for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++){
    const a=segments[i],b=segments[j];if(a.domain!==b.domain)continue;
    if(a.axis===b.axis){if(Math.abs(a.at-b.at)<=tolerance&&Math.max(a.from,b.from)<=Math.min(a.to,b.to)+tolerance)join(i,j);}
    else{const h=a.axis==='h'?a:b,v=a.axis==='v'?a:b;if(v.at>=h.from-tolerance&&v.at<=h.to+tolerance&&h.at>=v.from-tolerance&&h.at<=v.to+tolerance)join(i,j);}
  }
  const components=new Map();segments.forEach((s,i)=>{const key=root(i);if(!components.has(key))components.set(key,[]);components.get(key).push(s);});
  const signature=snapshot(project),candidates=[];
  for(const component of components.values()){
    const whole=gridTopology(component,tolerance);if(!whole)continue;
    for(const region of whole.regions){
    const minColumn=Math.min(...region.map(c=>c.column)),maxColumn=Math.max(...region.map(c=>c.column+c.columnSpan)),minRow=Math.min(...region.map(c=>c.row)),maxRow=Math.max(...region.map(c=>c.row+c.rowSpan));
    const minX=whole.x[minColumn],maxX=whole.x[maxColumn],minY=whole.y[maxRow],maxY=whole.y[minRow];
    const lines=component.filter(s=>s.axis==='h'?s.at>=minY-tolerance&&s.at<=maxY+tolerance&&Math.min(s.to,maxX)-Math.max(s.from,minX)>tolerance:s.at>=minX-tolerance&&s.at<=maxX+tolerance&&Math.min(s.to,maxY)-Math.max(s.from,minY)>tolerance);
    // Rebuild local coordinates so another touching table cannot add phantom rows.
    const grid=gridTopology(lines,tolerance);if(!grid||grid.faces.length<3)continue;
    const {x,y,rows,columns,cells}=grid,closedCells=grid.faces.filter(c=>Object.values(c.borders).every(Boolean)).length;
    if(closedCells<2)continue;
    const unresolved=[];
    for(const entity of entities.filter(e=>e.type==='text'&&domain(e)===lines[0].domain)){
      const corners=textCorners(entity),center={x:corners.reduce((v,p)=>v+p.x,0)/4,y:corners.reduce((v,p)=>v+p.y,0)/4};
      const anchorCell=insideCell(entity.points[0],grid,tolerance),centerCell=insideCell(center,grid,tolerance);
      const minX=Math.min(...corners.map(p=>p.x)),maxX=Math.max(...corners.map(p=>p.x)),minY=Math.min(...corners.map(p=>p.y)),maxY=Math.max(...corners.map(p=>p.y));
      const intersects=maxX>=x[0]-tolerance&&minX<=x.at(-1)+tolerance&&maxY>=y.at(-1)-tolerance&&minY<=y[0]+tolerance&&textIntersectsGrid(corners,x,y,tolerance);
      if(!anchorCell&&!centerCell&&!intersects)continue;
      const entry={entityId:entity.id,text:entity.text,anchor:{...entity.points[0]},center,anchorCell,centerCell,sourceOffset:entity.source?.textOffset??entity.source?.offset??null,originalText:entity.source?.originalText??null};
      if(sameCell(anchorCell,centerCell)){
        const {row,column}=anchorCell,cell=cells[row][column];entry.overflows=minX<x[column]-tolerance||maxX>x[column+cell.columnSpan]+tolerance||minY<y[row+cell.rowSpan]-tolerance||maxY>y[row]+tolerance;
        cells[row][column].entries.push(entry);
      }else unresolved.push({...entry,reason:anchorCell&&centerCell?'anchor-center-conflict':!anchorCell&&centerCell?'anchor-outside-or-on-edge':'boundary-or-overlap'});
    }
    for(const cell of cells.flat())cell.entries.sort((a,b)=>b.center.y-a.center.y||a.anchor.x-b.anchor.x||a.entityId.localeCompare(b.entityId));
    const assignedCount=cells.flat().reduce((n,c)=>n+c.entries.length,0);
    if(!assignedCount&&!unresolved.length)continue;
    const lineEntityIds=sortedIds(lines.map(l=>l.entityId));
    candidates.push({id:JSON.stringify([lineEntityIds,x,y]),rows,columns,x,y,cells,unresolved,lineEntityIds,closedCells,assignedCount,openCellCount:grid.faces.length-closedCells,mergedCellCount:grid.faces.filter(c=>c.rowSpan>1||c.columnSpan>1).length,unsupportedCellCount:cells.flat().filter(c=>!c.supported&&!c.coveredBy).length,domain:lines[0].domain,tolerance,signature,
      bounds:{minX:x[0],maxX:x.at(-1),minY:y.at(-1),maxY:y[0]}});
    }
  }
  return candidates.sort((a,b)=>b.assignedCount-a.assignedCount||b.bounds.maxY-a.bounds.maxY||a.bounds.minX-b.bounds.minX);
}

export function tableTextEntries(table){return [...table.cells.flatMap(row=>row.flatMap(cell=>cell.entries)),...table.unresolved];}

export function editTableTexts(project,table,changes){
  if(table.signature!==snapshot(project))throw new Error('纸样已变化，请重新打开表格后编辑。');
  const allowed=new Set(tableTextEntries(table).map(e=>e.entityId)),updates=new Map();
  if(!Array.isArray(changes))throw new Error('表格修改列表无效。');
  for(const change of changes){
    if(!change||!allowed.has(change.entityId)||updates.has(change.entityId)||typeof change.text!=='string'||change.text.length>10000||/[\r\n]/.test(change.text))throw new Error('表格修改无效；每个原文字对象分别编辑，暂不支持换行。');
    updates.set(change.entityId,change.text);
  }
  const next=clone(project);let changed=0;
  for(const entity of next.entities){
    if(!updates.has(entity.id)||entity.text===updates.get(entity.id))continue;
    if(entity.type!=='text')throw new Error('表格引用的文字已失效。');
    const value=updates.get(entity.id),reference=entity.text||(typeof entity.emptyTextReference==='string'&&entity.emptyTextReference.length<=10000?entity.emptyTextReference:''),oldWidth=textWidth(reference,entity.height),newWidth=textWidth(value,entity.height);
    if(newWidth>0){entity.width=oldWidth>0?(entity.width||oldWidth)*newWidth/oldWidth:newWidth;delete entity.emptyTextReference;}
    else if(entity.text)entity.emptyTextReference=entity.text;
    if(entity.width!==undefined&&(!Number.isFinite(entity.width)||entity.width<=0||entity.width>1e8))throw new Error('修改后的文字宽度超出可用范围。');
    entity.text=value;entity.name=value||'空文字';if(entity.source)entity.source.modified=true;changed++;
  }
  return {project:next,changed};
}

export function tableCsv(table){
  const field=value=>{
    // CSV cannot declare cell types. Guard spreadsheet formulas while keeping numbers numeric.
    if(/^[\s\u0000-\u001f]*[=+@-]/.test(value)&&!/^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(value))value="'"+value;
    return '"'+value.replaceAll('"','""')+'"';
  };
  return '\ufeff'+table.cells.map(row=>row.map(cell=>field(cell.entries.map(e=>e.text).join('\n'))).join(',')).join('\r\n')+'\r\n';
}

export function tableData(table){
  const {signature,id,...data}=table;
  return {format:'zhiyi-table-text',version:1,...data,interpretation:'geometric-grid-and-positioned-text',note:'Cell membership is inferred from current geometry. Missing borders and unresolved text are preserved; this is not an ET formula/table schema.'};
}
