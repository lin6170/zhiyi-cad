import { prepareMarker, markerDomain, placedMarkerShape, validateMarkerLayout } from './marker.mjs';
import { MARKER_GRID as GRID, polygonBounds, translatePolygon, booleanPaths, noFitPolygon, occupancyOverlap } from './marker-polygons.mjs';

// Deterministic greedy contour nesting. Every accepted candidate is checked
// against the actual expanded cutting polygons, independently of the NFP.
export function packMarker(project,value,{onProgress=()=>{},timeLimit=30000}={}){
  const prepared=prepareMarker(project,value),started=Date.now(),deadline=started+Math.max(0,timeLimit),cache=new Map();
  let work=0,limited=false;
  const templateById=new Map(prepared.templates.map(t=>[t.item.id,t]));
  const variants=instance=>templateById.get(instance.itemId).shapes.filter(s=>s.mirrored===instance.mirrored);
  const metrics=instance=>{const s=variants(instance)[0];return {area:s.area,height:s.bounds.maxY-s.bounds.minY,width:s.bounds.maxX-s.bounds.minX};};
  const orders=['area','height','width'].map(metric=>prepared.instances.slice().sort((a,b)=>metrics(b)[metric]-metrics(a)[metric]||a.key.localeCompare(b.key)));
  let best=null;
  for(let attempt=0;attempt<orders.length;attempt++){
    if(attempt&&Date.now()>deadline){limited=true;break;}
    const placed=[],placements=[];
    for(const instance of orders[attempt]){
      let winner=null;
      for(const shape of variants(instance)){
        const domain=markerDomain(shape,prepared.config);if(domain.minX>domain.maxX||domain.minY>domain.maxY)continue;
        const candidates=new Map(),add=(x,y)=>{
          x=Math.round(x);y=Math.round(y);
          if(x>=domain.minX&&x<=domain.maxX&&y>=domain.minY&&y<=domain.maxY&&candidates.size<12000)candidates.set(x+','+y,{x,y});
        };
        const neighbor=(x,y)=>{for(const dx of [-1,0,1])for(const dy of [-1,0,1])add(x+dx,y+dy);};
        for(const x of [domain.minX,domain.maxX])for(const y of [domain.minY,domain.maxY])add(x,y);
        // Guaranteed non-overlapping top stack remains available when the
        // bounded contour search is exhausted. It is still width/length checked.
        const movingBottom=Math.min(...shape.occupancy.map(p=>polygonBounds(p).minY));
        const top=placed.length?Math.max(...placed.flatMap(p=>p.occupancy.map(path=>polygonBounds(path).maxY)))-movingBottom:domain.minY;
        const stackY=Math.max(top,domain.minY),fallbackKeys=new Set([domain.minX+','+stackY,domain.maxX+','+stackY]);
        for(const x of [domain.minX,domain.maxX])add(x,stackY);
        if(placed.length&&Date.now()<=deadline){
          try{
            const forbidden=[];
            for(const fixed of placed){
              if(Date.now()>deadline)throw new Error('搜索时间上限');
              const key=JSON.stringify([fixed.shape.key,shape.key]);let nfp=cache.get(key);
              if(!nfp){
                const cost=fixed.shape.occupancy.reduce((n,a)=>n+shape.occupancy.reduce((m,b)=>m+a.length*b.length,0),0);
                work+=cost;if(work>2000000)throw new Error('搜索复杂度上限');
                nfp=booleanPaths(fixed.shape.occupancy.flatMap(a=>shape.occupancy.flatMap(b=>noFitPolygon(a,b))),[],'ctUnion');cache.set(key,nfp);
              }
              forbidden.push(...nfp.map(path=>translatePolygon(path,fixed.x,fixed.y)));
            }
            const union=booleanPaths(forbidden,[],'ctUnion');
            if(union.reduce((n,p)=>n+p.length,0)>30000)throw new Error('搜索节点上限');
            const rectangle=[{X:domain.minX,Y:domain.minY},{X:domain.maxX,Y:domain.minY},{X:domain.maxX,Y:domain.maxY},{X:domain.minX,Y:domain.maxY}];
            const feasible=domain.minX<domain.maxX&&domain.minY<domain.maxY?booleanPaths([rectangle],union,'ctDifference'):[];
            for(const path of [...feasible,...union])for(let i=0;i<path.length;i++){
              const a=path[i],b=path[(i+1)%path.length];neighbor(a.X,a.Y);
              // A zero-width feasible domain is a line, which polygon clipping
              // omits. Preserve its contacts with obstacle boundaries explicitly.
              for(const x of [domain.minX,domain.maxX])if(b.X!==a.X&&(x-a.X)*(x-b.X)<=0)neighbor(x,a.Y+(b.Y-a.Y)*(x-a.X)/(b.X-a.X));
              for(const y of [domain.minY,domain.maxY])if(b.Y!==a.Y&&(y-a.Y)*(y-b.Y)<=0)neighbor(a.X+(b.X-a.X)*(y-a.Y)/(b.Y-a.Y),y);
            }
          }catch{limited=true;}
        }else if(placed.length)limited=true;
        const sorted=[...candidates.values()].sort((a,b)=>a.y-b.y||a.x-b.x);
        let checked=0;
        for(const candidate of sorted){
          if(++checked>12000){limited=true;break;}
          if(Date.now()>deadline&&!fallbackKeys.has(candidate.x+','+candidate.y)){limited=true;continue;}
          const placement={itemId:instance.itemId,mirrored:instance.mirrored,ordinal:instance.ordinal,turn:shape.turn,x:candidate.x/GRID,y:candidate.y/GRID},record=placedMarkerShape(prepared,placement);
          if(placed.some(previous=>occupancyOverlap(previous.occupancy,record.occupancy)))continue;
          const height=record.y+shape.bounds.maxY+shape.uncertainty*GRID;
          const score=[Math.max(height,...placed.map(p=>p.y+p.shape.bounds.maxY+p.shape.uncertainty*GRID)),record.y,record.x,shape.turn];
          if(!winner||score.some((n,i)=>n<winner.score[i]&&score.slice(0,i).every((m,j)=>m===winner.score[j])))winner={record,placement,score};
          break;
        }
      }
      if(winner){placed.push(winner.record);placements.push(winner.placement);}
      onProgress({attempt:attempt+1,attempts:orders.length,placed:placements.length,total:prepared.instances.length,processed:orders[attempt].indexOf(instance)+1});
    }
    const result=validateMarkerLayout(prepared,placements);
    if(result.report.errors.length)throw new Error('排料复核未通过，未采用自动结果');
    if(!best||result.report.placed>best.report.placed||result.report.placed===best.report.placed&&result.report.usedLength<best.report.usedLength)best=result;
  }
  best??=validateMarkerLayout(prepared,[]);
  return {placements:best.config.placements,report:best.report,search:{limited,elapsedMs:Date.now()-started,method:'三种排序的贪心轮廓搜索；非全局最优',unplaced:best.report.missing.length}};
}
