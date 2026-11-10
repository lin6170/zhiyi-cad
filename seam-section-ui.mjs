import { normalizeLocator, reconcileSectionTargets } from './seam-sections.mjs';
import { reverseSeamCheck } from './seam-checks.mjs';

export function createSectionEditor({getDraft,setDraft,getProject,changed,notify}){
  const $=id=>document.getElementById(id),format=value=>Number.isFinite(value)?value.toFixed(3):'—',labels={match:'符合目标',mismatch:'需核对',uncertain:'临界，需核对'};
  let editId=null,targetKey='',targetRows=[];
  const number=id=>$(id).value.trim()?Number($(id).value):NaN;
  function reset(){
    editId=null;$('match-landmark-name').value='';
    for(const side of ['a','b']){$('match-landmark-'+side+'-kind').value='start';$('match-landmark-'+side+'-value').value='';$('match-landmark-'+side+'-notch').value='';}
    $('match-landmark-title').textContent='添加一对分界点';$('match-landmark-apply').textContent='添加对应点';
    updateEditor();
  }
  function updateEditor(){
    const draft=getDraft(),project=getProject();
    for(const side of ['a','b']){
      const prefix='match-landmark-'+side,kind=$(prefix+'-kind').value,input=$(prefix+'-value'),select=$(prefix+'-notch');
      input.parentElement.hidden=kind==='notch';select.hidden=kind!=='notch';$(prefix+'-caption').textContent=kind==='ratio'?'比例 %':'距离 mm';input.max=kind==='ratio'?'100':'100000000';
      const options=[];
      for(const recipe of project.notches||[]){
        if(!draft[side].edges.some(ref=>ref.entityId===recipe.baseEntityId))continue;
        const base=project.entities.find(entity=>entity.id===recipe.baseEntityId);
        for(let ordinal=0;ordinal<recipe.count;ordinal++)options.push([JSON.stringify({kind:'notch',notchId:recipe.id,ordinal,count:recipe.count}),(base?.name||'缺失基准')+' · '+recipe.name+' · '+(ordinal+1)+'/'+recipe.count]);
      }
      const selected=select.value,key=JSON.stringify(options);
      if(select.dataset.options!==key){select.replaceChildren(new Option('请选择具体刀口',''));for(const [value,label] of options)select.add(new Option(label,value));select.value=selected;select.dataset.options=key;}
    }
  }
  function reconcile(){const draft=getDraft();draft.sectionTargets=reconcileSectionTargets(draft.landmarks,draft.sectionTargets,Number.isFinite(draft.tolerance)?draft.tolerance:.5);changed();}
  function edit(mark){
    editId=mark.id;$('match-landmark-name').value=mark.name;updateEditor();
    for(const side of ['a','b']){const locator=mark[side],prefix='match-landmark-'+side;$(prefix+'-kind').value=locator.kind;$(prefix+'-value').value=locator.kind==='notch'?'':locator.value;$(prefix+'-notch').value=locator.kind==='notch'?JSON.stringify(locator):'';}
    $('match-landmark-title').textContent='编辑对应点';$('match-landmark-apply').textContent='更新对应点';$('match-landmark-editor').open=true;updateEditor();
  }
  function refresh(report){
    const draft=getDraft(),sections=draft.checkMode==='sections';
    $('match-mode').value=draft.checkMode||'whole';$('match-sections').hidden=!sections;$('match-whole-ease').hidden=sections;
    $('match-tolerance-label').textContent=sections?'合计允许偏差 ± mm':'允许偏差 ± mm';
    for(const side of ['a','b'])$('match-reverse-'+side).disabled=sections&&draft.landmarks.length>0;
    $('match-walk-help').textContent=sections?'B 在当前区间按该段目标吃势均匀步进；越过 A 分界点时重新从对应 B 分界点开始，保留局部余量或不足提示。此预览不移动纸样。':'B 按目标吃势均匀分配步长。此预览不移动纸样。';
    updateEditor();
    const list=$('match-landmarks');list.replaceChildren();
    (draft.landmarks||[]).forEach((mark,index)=>{
      const row=document.createElement('div');row.className='match-landmark-row';
      const text=document.createElement('span'),resolved=report?.landmarks?.find(item=>item.id===mark.id);text.textContent=(index+1)+' · '+mark.name+'\n'+(resolved?'A '+format(resolved.a)+' / B '+format(resolved.b)+' mm':'位置待核验');row.append(text);
      for(const [title,action,disabled] of [
        ['编辑',()=>edit(mark),false],
        ['↑',()=>{[draft.landmarks[index-1],draft.landmarks[index]]=[draft.landmarks[index],draft.landmarks[index-1]];reconcile();},index===0],
        ['↓',()=>{[draft.landmarks[index+1],draft.landmarks[index]]=[draft.landmarks[index],draft.landmarks[index+1]];reconcile();},index===draft.landmarks.length-1],
        ['×',()=>{draft.landmarks.splice(index,1);if(editId===mark.id)reset();reconcile();},false]
      ]){const button=document.createElement('button');button.textContent=title;button.setAttribute('aria-label',mark.name+' '+title);button.disabled=disabled;button.onclick=action;row.append(button);}list.append(row);
    });
    const targets=draft.sectionTargets||[],key=JSON.stringify(targets.map(target=>[target.from,target.to]));
    if(key!==targetKey){
      targetKey=key;targetRows=[];$('match-section-targets').replaceChildren();
      targets.forEach((target,index)=>{
        const card=document.createElement('div');card.className='match-section-card';card.dataset.sectionIndex=index;
        const title=document.createElement('strong'),lengths=document.createElement('p'),fields=document.createElement('div'),status=document.createElement('p');fields.className='match-section-fields';status.className='match-section-status';
        const controls={};
        for(const [key,label] of [['easeMode','吃势单位'],['easeValue','B 多于 A'],['tolerance','容差 ± mm']]){
          const wrapper=document.createElement('label');wrapper.append(label);const control=document.createElement(key==='easeMode'?'select':'input');
          if(key==='easeMode'){control.add(new Option('mm','mm'));control.add(new Option('A 的 %','percent'));}else{control.type='number';control.step='any';if(key==='tolerance'){control.min='0';control.max='10000';}}
          control.dataset.sectionField=key;control.setAttribute('aria-label','第 '+(index+1)+' 段 '+label);
          control.oninput=()=>{getDraft().sectionTargets[index][key]=key==='easeMode'?control.value:control.value.trim()?Number(control.value):NaN;changed();};
          controls[key]=control;wrapper.append(control);fields.append(wrapper);
        }
        card.append(title,lengths,fields,status);$('match-section-targets').append(card);targetRows.push({card,title,lengths,status,controls});
      });
    }
    const name=id=>id==='start'?'起点':id==='end'?'终点':draft.landmarks.find(mark=>mark.id===id)?.name||'缺失点';
    targetRows.forEach((row,index)=>{
      const target=targets[index],section=report?.sections?.[index];row.title.textContent=(index+1)+' · '+name(target.from)+' → '+name(target.to);
      row.lengths.textContent=section?'A '+format(section.aLength)+' / B '+format(section.bLength)+' mm':'长度待核验';
      for(const [key,control] of Object.entries(row.controls))if(document.activeElement!==control)control.value=Number.isNaN(target[key])?'':target[key];
      row.status.textContent=section?labels[section.status]+' · 偏差 '+(section.residual>=0?'+':'')+format(section.residual)+' mm':'请先确认分界位置';row.card.dataset.status=section?.status||'error';
    });
  }
  $('match-mode').onchange=()=>{
    const draft=getDraft();draft.checkMode=$('match-mode').value;draft.landmarks=[];draft.sectionTargets=draft.checkMode==='sections'?reconcileSectionTargets([],[],Number.isFinite(draft.tolerance)?draft.tolerance:.5):[];draft.easeMode='mm';draft.easeValue=0;reset();changed(true);
  };
  for(const side of ['a','b'])$('match-landmark-'+side+'-kind').onchange=updateEditor;
  $('match-landmark-cancel').onclick=reset;
  $('match-landmark-apply').onclick=()=>{
    try{
      const draft=getDraft();if(!editId&&draft.landmarks.length>=30)throw new Error('最多支持 30 对分界点');
      const mark={id:editId||crypto.randomUUID(),name:$('match-landmark-name').value.trim()||'分界点 '+(draft.landmarks.length+1)};
      for(const side of ['a','b']){const prefix='match-landmark-'+side,kind=$(prefix+'-kind').value;if(kind==='notch'&&!$(prefix+'-notch').value)throw new Error('请选择 '+side.toUpperCase()+' 侧的具体关联刀口');mark[side]=normalizeLocator(kind==='notch'?JSON.parse($(prefix+'-notch').value):{kind,value:number(prefix+'-value')});}
      if(editId){const index=draft.landmarks.findIndex(item=>item.id===editId);if(index<0)throw new Error('待编辑分界点已缺失');draft.landmarks[index]=mark;}else draft.landmarks.push(mark);
      reset();reconcile();
    }catch(error){notify(error.message);}
  };
  $('match-reverse-both').onclick=()=>{setDraft(reverseSeamCheck(getDraft()));reset();changed(true);};
  return {refresh,reset};
}
