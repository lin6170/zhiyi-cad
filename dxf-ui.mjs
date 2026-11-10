export function createDxfSettings(){
  const $=id=>document.getElementById(id);let config={curveMode:'native',tolerance:.01};
  const show=()=>{$('dxf-mode').value=config.curveMode;$('dxf-tolerance').value=config.tolerance;update();$('dxf-settings').showModal();};
  const update=()=>{$('dxf-tolerance-field').hidden=$('dxf-mode').value!=='polyline';};
  $('dxf-mode').onchange=update;
  for(const button of document.querySelectorAll('[data-dxf-settings]'))button.onclick=show;
  $('dxf-settings-cancel').onclick=()=>$('dxf-settings').close();
  $('dxf-settings-apply').onclick=()=>{
    const tolerance=Number($('dxf-tolerance').value);
    if(!Number.isFinite(tolerance)||tolerance<.001||tolerance>.5){$('dxf-tolerance').setCustomValidity('请输入 0.001 至 0.5 mm');$('dxf-tolerance').reportValidity();return;}
    config={curveMode:$('dxf-mode').value,tolerance};$('export').textContent=config.curveMode==='native'?'原生 DXF':'折线 DXF';$('dxf-settings').close();
  };
  $('dxf-tolerance').oninput=()=>$('dxf-tolerance').setCustomValidity('');
  return {options:()=>({...config})};
}
