import { prjCurveStats } from './prj-curves.mjs';

/** An explicit import choice; the other sizes are still in the original PRJ. */
export function selectPrjVariant(parsed, id) {
  if(id==='all')return parsed;
  const variants=parsed.metadata?.sizeVariants||[], selected=variants.find(v=>v.id===id);
  if(!selected)throw new Error('所选 PRJ 尺码不存在。');
  const value=JSON.parse(JSON.stringify(parsed)),ids=new Set(selected.entityIds),groups=new Set(selected.groupIds);
  value.entities=value.entities.filter(e=>ids.has(e.id));value.groups=value.groups.filter(g=>groups.has(g.id));
  const curves=value.entities.filter(e=>[2,4,23].includes(e.source?.recordKind));
  const m=value.metadata;m.nodes=m.nodes.filter(n=>n.sizeId===id);m.pieces=m.pieces.filter(p=>p.sizeId===id);
  Object.assign(m,prjCurveStats(curves),{declaredCurveCount:curves.length,firstCurveOffset:curves[0].source.offset,lastCurveOffset:curves.at(-1).source.offset,
    parsedTextCount:value.entities.filter(e=>e.type==='text').length,declaredStandaloneTextCount:selected.standaloneTextCount,parsedStandaloneTextCount:selected.standaloneTextCount,parsedEmbeddedTextCount:selected.embeddedTextCount,
    declaredPieceCount:value.groups.length,parsedPieceCount:value.groups.length,decodedPieceCount:value.groups.length,declaredPointCount:m.nodes.length,parsedPointCount:m.nodes.length,
    baseSize:selected.name,sizeVariants:m.sizeVariants.filter(v=>v.id===id),ownedCurveCount:curves.length-selected.unownedCurveIds.length,unownedCurveCount:selected.unownedCurveIds.length,unownedCurveIds:selected.unownedCurveIds,
    importSelection:{mode:'single-size',selectedSize:selected.name,availableSizes:variants.map(v=>v.name),originalCurveCount:parsed.metadata.parsedCurveCount}});
  value.name += ' · '+selected.name;
  value.warnings=value.warnings.filter(w=>!w.startsWith('旧版 PRJ 实验导入：')&&!w.startsWith('按原控制点恢复 ')&&!w.startsWith('文字直接按 UTF-8')&&!/^\d+ 条样条含完全重复的端点：/.test(w));
  value.warnings.unshift(`按原控制点恢复 ${m.smoothSplineCount} 条样条，${m.polylineCount} 条多段线按原始顶点保留。${m.fallbackSplineCount?m.fallbackSplineCount+' 条样条未通过重建核对，暂按原拟合点折线显示。':''}${m.endpointNormalizedSplineCount?'其中 '+m.endpointNormalizedSplineCount+' 条重复端点样条已移除不参与曲线的端部控制项；原记录完整保留。':''}`);
  value.warnings.unshift(`文字直接按 UTF-8 从文件读取：${m.parsedEmbeddedTextCount} 条裁片标签、${m.parsedStandaloneTextCount} 条独立文字。标签锚点按居中显示，开关标志和 ET 字体排版仍需核对。`);
  value.warnings.unshift(`本次仅导入 ${selected.name}：${curves.length} 条主图曲线、${value.groups.length} 份裁片。原文件共 ${variants.length} 个尺码；重新打开 PRJ 可选择其他尺码或全部叠放。`);
  return value;
}

export function createPrjImportDialog() {
  const dialog=document.createElement('dialog');dialog.className='prj-import-dialog';dialog.id='prj-import-dialog';
  dialog.setAttribute('aria-labelledby','prj-import-title');
  dialog.innerHTML='<form method="dialog"><h2 id="prj-import-title">选择 PRJ 尺码</h2><p id="prj-import-summary"></p><label>本次打开<select id="prj-import-size"></select></label><p class="muted">选择单个尺码后，其他尺码仍在原 PRJ 中，可重新打开选择。各尺码作为独立纸样导入，不自动建立放码规则。</p><div class="prj-import-actions"><button value="cancel">取消</button><button value="open" class="primary" id="prj-import-confirm">打开纸样</button></div></form>';
  document.body.append(dialog);
  const select=dialog.querySelector('select');let pending=null;
  dialog.addEventListener('close',()=>{if(!pending)return;const done=pending;pending=null;done(dialog.returnValue==='open'?select.value:null);});
  return {async choose(parsed){
    const variants=parsed.metadata?.sizeVariants||[];
    if(variants.length<2)return parsed;
    if(pending)throw new Error('已有一个 PRJ 导入正在等待尺码选择。');
    select.replaceChildren(...variants.map(v=>new Option(`${v.name} · ${v.pieceCount} 份裁片${v.base?' · 文件基码标记':''}`,v.id)),new Option(`所有 ${variants.length} 个尺码（按原坐标叠放）`,'all'));
    select.value=(variants.find(v=>v.base)||variants[0]).id;
    dialog.querySelector('#prj-import-summary').textContent=`文件包含 ${variants.map(v=>v.name).join('、')}，共 ${variants.length} 个尺码。`;
    dialog.returnValue='cancel';const promise=new Promise(resolve=>pending=resolve);dialog.showModal();select.focus();
    const choice=await promise;return choice===null?null:selectPrjVariant(parsed,choice);
  }};
}
