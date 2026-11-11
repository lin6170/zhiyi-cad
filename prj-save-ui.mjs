/** Visible save entry; all PRJ bytes are still produced by the existing guarded writers. */
export function createPrjSavePanel({getProject,getTextSession,getEndpointSession,getLineSession,openLinePreview,canPreview}) {
  const $=id=>document.getElementById(id),dialog=$('prj-save-dialog');
  function eligibility(session,button,message,missing){
    $(button).disabled=true;
    if(!session){$(message).textContent=missing;return;}
    if(!canPreview()){$(message).textContent='请先完成或取消当前编辑，并切换到选择或节点工具。';return;}
    try{const plan=session.preview(getProject());$(button).disabled=false;$(message).textContent=plan.addedLines?`${plan.addedLines} 条新增独立直线可以预览回存。`:plan.changedAnnotations?`${plan.changedAnnotations} 项标注修改可以预览回存。`:'1 个独立直线端点修改可以预览回存。';}
    catch(error){$(message).textContent=error.message;}
  }
  $('save-prj').onclick=()=>{
    const text=getTextSession(),endpoint=getEndpointSession(),lines=getLineSession();
    $('prj-save-source').textContent=text||endpoint||lines?'原始文件：'+(text||endpoint||lines).filename:'当前工程没有可回存的原始 PRJ 来源。请直接打开支持的原始 PRJ；.zycad、DXF、新建工程和旧版布局暂不支持回存。';
    eligibility(text,'prj-save-text','prj-save-text-status','当前来源不支持标注回存。');
    eligibility(endpoint,'prj-save-endpoint','prj-save-endpoint-status','当前来源不支持独立直线端点回存。');
    eligibility(lines,'prj-save-lines','prj-save-lines-status','当前来源不支持新增直线回存。');
    const count=endpoint?.eligibleLines.length||0;
    $('prj-save-locate').disabled=!count||!canPreview();
    $('prj-save-line-count').textContent=endpoint?`当前文件有 ${count} 条符合条件的独立直线。`:'需重新导入原始 PRJ 才能检查线条。';
    dialog.showModal();
  };
  function route(id){dialog.close();$(id).click();}
  $('prj-save-text').onclick=()=>route('prj-writeback-open');
  $('prj-save-endpoint').onclick=()=>route('prj-endpoint-open');
  $('prj-save-lines').onclick=()=>{dialog.close();openLinePreview();};
  $('prj-save-locate').onclick=()=>{dialog.close();$('prj-endpoint-tools').open=true;$('prj-endpoint-locate').click();};
  $('prj-save-project').onclick=()=>route('save');
  $('prj-save-close').onclick=()=>dialog.close();
  return {isOpen:()=>dialog.open,reset:()=>dialog.close()};
}
