/** Experimental v5 reader. The observed single-size layout is checked against
 * serialized counts and references. Unsupported extensions remain explicit;
 * this module does not write the format or use preview images. */
import { prjCurveStats } from './prj-curves.mjs';
import { scanV5Curves as scanPrjCurves } from "./prj-v5-curves.mjs";
export const nativeV5Signature = [0x48,0x72,1,1,0,0,0xa0,0x40];

export function parseNativeV5Prj(bytes, filename) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal:true, ignoreBOM:true });
  const require = (ok, message) => { if (!ok) throw new Error('新版 PRJ：' + message); };
  const range = (o,n=4) => require(Number.isInteger(o) && o>=0 && o+n<=bytes.length, '记录被截断。');
  const u32 = o => { range(o); return view.getUint32(o,true); };
  const f32 = o => { range(o); return view.getFloat32(o,true); };
  const zero = (o,n) => { range(o,n); return bytes.subarray(o,o+n).every(v=>v===0); };
  const finite = values => values.every(v=>Number.isFinite(v) && Math.abs(v)<100000);
  function string(o, maximum=4096) {
    range(o,2); const n=view.getUint16(o,true); range(o+2,n);
    require(n<=maximum,'文字长度异常。');
    let text; try { text=decoder.decode(bytes.subarray(o+2,o+2+n)); } catch { throw new Error('新版 PRJ：UTF-8 文字编码无效。'); }
    require(![...text].some(c=>c.codePointAt(0)<32 && !'\r\n\t'.includes(c)), '文字含非法控制字符。');
    return {text,next:o+2+n,textOffset:o+2,textByteLength:n};
  }
  const headerStrings=[];let headerCursor=12;
  for(let i=0;i<3;i++){const s=string(headerCursor);headerStrings.push(s.text);headerCursor=s.next;}
  const roots=[];
  for(let o=100;o+20<=bytes.length;o++) {
    if(u32(o-8)!==1 || u32(o-4)!==1 || u32(o+4)!==0 || f32(o+11)!==1 || u32(o+15)!==0 || ![0x01,0x80,0x81].includes(bytes[o+19])) continue;
      const s=string(o+20,128);
      if(u32(s.next)!==9)continue;
      require(u32(s.next+4)===0xffffffff,'尚不支持此计数表布局。');
      const table=s.next+8;range(table,1200);const seed=u32(table+17*4);
      const count=(slot,bias)=>{const n=u32(table+(slot+17)*4)-seed-bias;require(n>=0&&n<=10000,'计数表数值异常。');return n;};
      const nodeCount=count(40,3201),nodeOffset=table+1200;
      const curveCount=count(6,1280),textCount=count(136,1987),pieceCount=count(115,987);
      require(s.text && nodeCount>=1 && nodeCount<=10000,'尺码点数量无效。');
      range(nodeOffset,34);require([6,7].includes(u32(nodeOffset)),'尺码首个点记录无效。');
      roots.push({id:`prj-size-${o}`,offset:o,name:s.text,base:(bytes[o+19]&1)===1,flags:bytes[o+19],nodeCount,nodeOffset,curveCount,textCount,pieceCount,auxiliaryCount:count(174,1243),tableOffset:table,color:Array.from(bytes.subarray(o+8,o+11))});
      o=nodeOffset-1;
  }
  require(roots.length===1,'目前只支持已验证的单尺码 v5 结构。');
  require(new Set(roots.map(r=>r.name)).size===roots.length,'重复尺码记录尚未支持。');

  function pieceHeader(o) {
    if(o+160>bytes.length || ![0x20,0xa0].includes(bytes[o+7]) || !zero(o+8,13) || u32(o+21)!==1 || u32(o+25)!==u32(o+32))return null;
    try {
      let c=o+36; const read=()=>{const s=string(c);c=s.next;return s.text;};
      const style=read(), name=read(), size=read(), material=read(), scale=u32(c);c+=4;
      const symmetry=read();c+=16;const labelFormat=read(), mode=u32(c);c+=4;
      if(![1,3].includes(mode))return null;
      const positions=[0,12,28,40].map(d=>({x:f32(c+d),y:f32(c+d+4),z:f32(c+d+8)}));
      if(!positions.every(p=>finite([p.x,p.y])&&p.z===0) || positions[0].x!==positions[2].x || positions[0].y!==positions[2].y || u32(c+24)!==0 || u32(c+52)!==0)return null;
      return {offset:o,sourceId:u32(o),vectorOffset:c,style,name,size,material,scale,symmetry,labelFormat,mode,positions,color:Array.from(bytes.subarray(o+4,o+7)),flag:bytes[o+7]};
    } catch { return null; }
  }
  const pieceCandidates=[];
  for(let o=100;o+160<bytes.length;o++){const p=pieceHeader(o);if(p){pieceCandidates.push(p);o=p.vectorOffset+55;}}
  require(pieceCandidates.length>0,'未找到裁片记录。');
  const allEntities=[],allGroups=[],allPieces=[],allNodes=[],variants=[],ranges=[];
  let standaloneTotal=0,embeddedTotal=0,seenPieces=0;

  function textEntity(id,text,fields,source) {
    const [x,y,cosine,sine,width,height]=fields;
    require(finite(fields) && Math.abs(cosine*cosine+sine*sine-1)<.05 && width>0 && height>0 && height<=1000, '文字位置或尺寸无效。');
    return {id,type:'text',text,name:text,points:[{x,y}],width,height,rotation:Math.atan2(sine,cosine)*180/Math.PI,
      verticalAlign:'middle',layer:'annotation',source:{format:'ET PRJ',encoding:'utf-8',originalText:text,cosine,sine,...source}};
  }
  for(let ri=0;ri<roots.length;ri++) {
    const root=roots[ri], limit=roots[ri+1]?.offset ?? bytes.length;
    const pieces=pieceCandidates.filter(p=>p.offset>root.nodeOffset && p.offset<limit);
    require(pieces.length>0 && root.pieceCount===pieces.length,`尺码 ${root.name} 的裁片数量不一致。`);
    require(pieces.every(p=>p.size===root.name),`尺码 ${root.name} 的裁片标签不一致。`);
    seenPieces+=pieces.length;
    const records=scanPrjCurves(bytes,{start:root.nodeOffset,end:pieces[0].offset});
    require(records.length>0 && root.curveCount===records.length,`尺码 ${root.name} 的曲线数量不一致，拒绝部分导入。`);
    const standalone=[],embedded=[],pendingGroups=[];let textCountOffset=0,textStart=0;
    // Standalone annotations precede the main curve table in this layout.
    for(let o=root.nodeOffset;o+229<records[0].offset;o++){
      if(u32(o+4)===0&&f32(o+11)===1&&u32(o+15)===0&&u32(o+20)===1&&u32(o+25)===1&&u32(o+53)===0){textStart=o;break;}
    }
    require(root.textCount>0&&textStart>root.nodeOffset,'独立文字区尚未识别。');
    let textCursor=textStart;
    for(let ti=0;ti<root.textCount;ti++){
      const o=textCursor;range(o,229);
      require(u32(o+4)===0&&f32(o+11)===1&&u32(o+15)===0&&u32(o+20)===1&&u32(o+25)===1&&u32(o+53)===0,'独立文字记录结构不一致。');
      const s=string(o+57),next=o+229+s.textByteLength;range(o,next-o);
      require(s.text&&zero(o+67+s.textByteLength,6),'独立文字结尾无效。');
      const extension=o+73+s.textByteLength;
      for(let j=0;j<156;j++){
        const expected=j>=38&&j<=45?255:[74,90,106,122].includes(j)?128:[75,91,107,123].includes(j)?63:j===127?1:0;
        require(bytes[extension+j]===expected,'文字附加记录尚未支持。');
      }
      standalone.push(textEntity(`prj-text-${o}`,s.text,Array.from({length:6},(_,i)=>f32(o+29+i*4)),{offset:o,textOffset:s.textOffset,textByteLength:s.textByteLength,sourceId:u32(o),color:Array.from(bytes.subarray(o+8,o+11)),flags:bytes[o+19],secondaryAnchor:{x:f32(s.next),y:f32(s.next+4)},size:root.name,sizeId:root.id,extensionOffset:o+73+s.textByteLength,extensionLength:156}));textCursor=next;
    }
    require(textCursor===records[0].offset,'文字区与曲线区边界不一致。');
    const entities=records.map(r=>r.entity),groups=[],nodes=[];
    for(let o=root.nodeOffset;o+34<=textStart;o++) {
      const type=u32(o);if(![6,7].includes(type)||bytes[o+8]!==0||bytes[o+9]!==0||bytes[o+10]!==255)continue;
      const x=f32(o+14),y=f32(o+18);if(!finite([x,y])||f32(o+22)!==0)continue;
      const ownerIndex=u32(o+26);require(ownerIndex<=records.length,'点的曲线归属越界。');
      nodes.push({offset:o,recordType:type,sourceId:u32(o+4),x,y,ownerIndex,flags:Array.from(bytes.subarray(o+11,o+14)),sizeId:root.id});o+=33;
    }
    require(nodes.length===root.nodeCount && nodes[0]?.offset===root.nodeOffset,`尺码 ${root.name} 的点数量不一致。`);
    for(let ci=0;ci<records.length;ci++) {
      const record=records[ci];let c=record.geometryEnd;
      if(record.kind===4&&!record.parametersIncluded){const n=u32(c);require(n<=10000,'曲线参数数量异常。');c+=4+n*4;}
      if(record.kind===23){require(u32(c)===0,'多段线扩展尚未支持。');c+=4;}
      const refs=[];
      for(let list=0;list<2;list++){const n=u32(c);require(n<=10000,'曲线点引用数量异常。');c+=4;range(c,n*4);const ids=Array.from({length:n},(_,i)=>u32(c+i*4));c+=n*4;require(ids.every(i=>i>=1&&i<=nodes.length),'曲线点索引越界。');refs.push(ids);}
      require(refs[0].length>=2,'曲线缺少首尾节点引用。');
      for(let e=0;e<2;e++){const n=nodes[refs[0][e]-1],p=e?record.points.at(-1):record.points[0];require(n.ownerIndex===ci+1 && n.x===p.x && n.y===p.y,`曲线 ${ci+1} 与首尾节点坐标不一致。`);}
      require(c< (records[ci+1]?.offset ?? pieces[0].offset),'曲线记录边界异常。');
      if(ci===records.length-1){
        require([2,23].includes(record.kind) && c+36<=pieces[0].offset,'曲线表尾部结构尚未支持。');
        ranges.push({offset:c+36,length:pieces[0].offset-c-36,scope:'between-curves-and-pieces',structure:'unresolved-v5-auxiliary-records',declaredCount:root.auxiliaryCount});
      }
      Object.assign(record.entity.source,{size:root.name,sizeId:root.id,pointReferences:refs[0],secondaryPointReferences:refs[1]});
    }
    for(let pi=0;pi<pieces.length;pi++) {
      const p=pieces[pi];let c=p.vectorOffset+56;
      require(zero(c,28),'裁片标签前缀不受支持。');c+=28;
      const labelMode=bytes[c++];require(labelMode<=1,'裁片标签模式不受支持。');
      const labelName=string(c);c=labelName.next;const extra=string(c);c=extra.next;const labels=[];
      for(let li=0;li<8;li++) {
        const o=c,fields=Array.from({length:7},(_,i)=>f32(c+i*4));c+=28;
        const s=string(c);c=s.next;require(finite(fields)&&fields[6]===0,'裁片标签扩展不受支持。');
        labels.push({offset:o,fields,text:s.text,textOffset:s.textOffset,textByteLength:s.textByteLength});
      }
      range(c,20);const labelFlags=Array.from(bytes.subarray(c,c+8));c+=8;
      require(labelFlags.every(v=>v===1),'裁片标签显示标志尚未验证。');
      const labelRefs=[u32(c),u32(c+4),u32(c+8)];c+=12;
      require(labelRefs[2]===0,'裁片标签附加引用尚未支持。');
      for(let i=0;i<2;i++){const n=nodes[labelRefs[i]-1],v=p.positions[i?1:3];require(n&&n.ownerIndex===0&&n.x===v.x&&n.y===v.y,'裁片布纹节点引用不一致。');}
      const chainCount=u32(c);c+=4;require(chainCount>=1&&chainCount<=100,'裁片轮廓组数异常。');
      function references(max,label){const countOffset=c,n=u32(c);c+=4;require(n<=10000,'裁片引用数量异常。');range(c,n*4);const indices=Array.from({length:n},(_,i)=>u32(c+i*4));c+=n*4;require(indices.every(i=>i>=1&&i<=max),`裁片 ${p.name} 的${label}索引越界。`);return {countOffset,indices};}
      const chains=[];
      for(let k=0;k<chainCount;k++) {
        range(c,2);const flags=[bytes[c],bytes[c+1]];c+=2;require(flags.every(v=>v<=1),'轮廓标志尚未支持。');
        const list=references(records.length,'轮廓曲线'),owner=u32(c);c+=4;require(owner===pi+1,'轮廓裁片编号不一致。');
        const entityIds=list.indices.map(i=>entities[i-1].id);
        chains.push({...list,flags,pieceIndex:owner,entityIds,role:k===0?'primary-contour':'additional-chain'});
      }
      const ownedCurves=references(records.length,'所属曲线'),ownedNodes=references(nodes.length,'所属点'),auxiliaryIndices=references(100000,'辅助对象'),ownedTexts=references(10000,'所属文字'),unattachedIndices=references(100000,'独立对象');
      const tail=c;range(tail,208);
      for(const delta of [0,56]){for(let j=0;j<13;j++)require(f32(tail+delta+j*4)===(j%4===0?1:0),'裁片包含未支持的主变换。');require(u32(tail+delta+52)===0x01000000,'裁片变换尾部异常。');}
      require(zero(tail+112,2)&&u32(tail+166)===0x01000000&&zero(tail+170,38),'裁片附加变换结构异常。');
      const additionalTransform=Array.from({length:13},(_,i)=>f32(tail+114+i*4));require(finite(additionalTransform),'裁片附加变换无效。');c+=208;
      if(pi+1<pieces.length)require(c===pieces[pi+1].offset,'裁片记录边界不一致。');else textCountOffset=c;
      const ownedSet=new Set(ownedCurves.indices);require(ownedSet.size===ownedCurves.indices.length && chains.every(chain=>chain.indices.every(i=>ownedSet.has(i))),'裁片曲线归属集合不一致。');
      require(ownedNodes.indices.every(i=>nodes[i-1].ownerIndex===0||ownedSet.has(nodes[i-1].ownerIndex)),'裁片点与曲线归属不一致。');
      const groupId=`prj-piece-${p.offset}`,grainId=`prj-grain-${p.offset}`,labelEntities=[];
      for(const [li,label] of labels.entries())if(label.text){labelEntities.push(textEntity(`prj-label-${label.offset}`,label.text,label.fields,{offset:label.offset,textOffset:label.textOffset,textByteLength:label.textByteLength,recordType:'embedded-piece-label',labelIndex:li,labelFlag:labelFlags[li],size:root.name,sizeId:root.id,pieceOffset:p.offset,color:p.color,anchorInterpretation:'middle-inferred'}));}
      embedded.push(...labelEntities);
      entities.push({id:grainId,type:'polyline',closed:false,name:`${p.name} · 布纹方向（推定）`,layer:'grain',points:[p.positions[3],p.positions[1]].map(({x,y})=>({x,y})),arrowStart:p.mode===3,arrowEnd:true,
        source:{format:'ET PRJ',offset:p.offset,sourceId:p.sourceId,vectorOffset:p.vectorOffset,arrowMode:p.mode,pieceName:p.name,material:p.material,size:p.size,sizeId:root.id,center:p.positions[0],interpretation:'grainline-vectors-with-inferred-arrow-flags'}});
      const curveIds=ownedCurves.indices.map(i=>records[i-1].entity.id);
      pendingGroups.push({id:groupId,name:`${p.name} · ${root.name}`,entityIds:[...curveIds,...labelEntities.map(e=>e.id),grainId],contours:chains.map(chain=>({role:chain.role,entityIds:chain.entityIds})),
        source:{format:'ET PRJ',offset:p.offset,sourceId:p.sourceId,pieceIndex:pi+1,recordEnd:c,transformOffset:tail,curveIds,textIds:[],grainId,contourChains:chains,material:p.material,size:p.size,sizeId:root.id,symmetry:p.symmetry,ownedCurves,ownedNodes,auxiliaryIndices,ownedTexts,unattachedIndices,labelMode,labelName:labelName.text,labelExtra:extra.text,labels,labelFlags,labelRefs,additionalTransform,additionalTransformOffset:tail+114,interpretation:'serialized-piece-ownership-index-arrays'}});
      Object.assign(p,{sizeId:root.id,recordEnd:c,transformOffset:tail});
    }
    const cursor=textCountOffset,textCount=root.textCount;
    require(cursor<limit,'裁片记录与后缀重叠。');
    const ownership=new Set();
    for(const group of pendingGroups){const ids=group.source.ownedTexts.indices;require(ids.every(i=>i<=standalone.length),'裁片文字索引越界。');group.source.textIds=ids.map(i=>standalone[i-1].id);group.entityIds.push(...group.source.textIds);for(const id of group.entityIds){require(!ownership.has(id),'实体被多个裁片重复引用。');ownership.add(id);}groups.push(group);}
    entities.push(...standalone,...embedded);
    const unownedCurveIds=records.filter(r=>!ownership.has(r.entity.id)).map(r=>r.entity.id);
    for(const entity of entities)Object.assign(entity.source,{sizeId:root.id,size:root.name});
    variants.push({...root,entityIds:entities.map(e=>e.id),groupIds:groups.map(g=>g.id),curveCount:records.length,pieceCount:pieces.length,standaloneTextCount:textCount,embeddedTextCount:embedded.length,curveOffset:records[0].offset,pieceOffset:pieces[0].offset,textCountOffset,textEnd:cursor,unownedCurveIds});
    const following={offset:cursor,length:limit-cursor,scope:ri+1<roots.length?'between-size-sections':'after-main-drawing'};
    following.structure='unresolved-v5-extension';
    ranges.push(following);
    allEntities.push(...entities);allGroups.push(...groups);allPieces.push(...pieces);allNodes.push(...nodes);standaloneTotal+=standalone.length;embeddedTotal+=embedded.length;
  }
  require(seenPieces===pieceCandidates.length,'有裁片未归入任何尺码，拒绝部分导入。');
  const curves=allEntities.filter(e=>[2,4,23].includes(e.source?.recordKind)),stats=prjCurveStats(curves);
  const baseSize=roots.find(r=>r.base)?.name||roots[0].name,unownedCurveIds=variants.flatMap(v=>v.unownedCurveIds);
  return {name:allPieces[0]?.style||filename,entities:allEntities,groups:allGroups,
    metadata:{format:'ET PRJ experimental',layout:'native-v5-7248',unit:'unknown',sourceFile:filename,encoding:'utf-8',headerStrings,baseSize,style:allPieces[0]?.style||'',compatibility:'experimental-bounded-line-writeback',
      ...stats,declaredCurveCount:curves.length,firstCurveOffset:curves[0].source.offset,lastCurveOffset:curves.at(-1).source.offset,
      parsedTextCount:standaloneTotal+embeddedTotal,declaredStandaloneTextCount:standaloneTotal,parsedStandaloneTextCount:standaloneTotal,parsedEmbeddedTextCount:embeddedTotal,
      declaredPieceCount:allPieces.length,parsedPieceCount:allPieces.length,decodedPieceCount:allGroups.length,declaredPointCount:allNodes.length,parsedPointCount:allNodes.length,
      ownedCurveCount:curves.length-unownedCurveIds.length,unownedCurveCount:unownedCurveIds.length,unownedCurveIds,pieces:allPieces,nodes:allNodes,sizeVariants:variants,unparsedFollowingRanges:ranges},
    warnings:[
      `新版 v5 PRJ 实验导入：${curves.length} 条主图曲线、${allPieces.length} 份裁片；已核对声明数量、局部索引和曲线首尾节点。当前仅验证单尺码、直线、样条与两点连续线。`,
      `文字直接按 UTF-8 从文件读取：${embeddedTotal} 条裁片标签、${standaloneTotal} 条独立文字。标签锚点按居中显示，开关标志和 ET 字体排版仍需核对。`,
      `按原控制点恢复 ${stats.smoothSplineCount} 条样条，${stats.polylineCount} 条多段线按原始顶点保留。${stats.fallbackSplineCount ? stats.fallbackSplineCount+' 条样条未通过重建核对，暂按原拟合点折线显示。' : ''}`,
      ...(stats.endpointNormalizedSplineCount?[`${stats.endpointNormalizedSplineCount} 条样条含完全重复的端点：移除不参与曲线的端部控制项后恢复为可编辑曲线；原控制点与拟合点完整保留。`]:[]),
      '坐标物理单位尚未确认。主变换已核对为单位矩阵；额外变换仅保留为来源记录，未用于修改主图坐标。',
      '尺码仅代表文件内已保存的纸样，不代表已恢复 ET 放码规则。刀口、缝份、标签开关及主图后扩展数据的完整语义仍未恢复；后缀未混入主图。',
      '保存 PRJ 支持符合条件的独立直线单端点修改，或新增普通独立直线；需分别回存。v5 标注、曲线、连续线及裁片修改请保存 .zycad 工程。有限样本已通过 ET 打开、继续绘图、保存和重开，不代表全部文件已验证。',
    ]};
}
