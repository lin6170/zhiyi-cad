import {pantsRuleChoices,createUserPantsRule} from './pants-rules.mjs';
const ns='http://www.w3.org/2000/svg';
export function createPantsRuleEditor({container,getProject,onProfile,onInvalidate,download}){
  container.innerHTML='<details id="pants-rule-builder"><summary>为当前 PRJ 建立裤长规则</summary><div class="rule-body"><p>选择前、后裤片，再选定位目标并点击图中线条，也可使用线条列表。当前支持单尺码裤装，净样侧缝在膝线处分段；膝脚距离至少 150 mm，膝线和脚口近似平行。</p>'+
  '<label>规则名称<input id="rule-name" maxlength="80" value="我的裤长规则"></label><div class="rule-row"><label>原文件单位<select id="rule-units"><option value="">请选择</option><option value="10">厘米（1 = 10 mm）</option><option value="1">毫米（1 = 1 mm）</option></select></label><label>裤脚整体移动区<input id="rule-band" type="number" min="5" max="100" step="1" value="40"> mm</label></div>'+
  ['front','back'].map((side,i)=>'<fieldset><legend>'+(i?'后裤片':'前裤片')+'</legend><label>裁片<select id="rule-'+side+'-piece"></select></label><div class="rule-row"><label>膝线<select id="rule-'+side+'-knee"></select></label><label>净样裤脚<select id="rule-'+side+'-hem"></select></label></div></fieldset>').join('')+
  '<label>图上点选目标<select id="rule-target"><option value="front-knee">前片 · 膝线</option><option value="front-hem">前片 · 裤脚</option><option value="back-knee">后片 · 膝线</option><option value="back-hem">后片 · 裤脚</option></select></label>'+
  '<svg id="pants-rule-canvas" role="img" aria-label="点选裤片膝线和裤脚"></svg><p class="pants-muted">青色：膝线 · 橙色：裤脚。40 mm 移动区表示脚口附近折边线整体移动；缝份与下段侧缝同步变形。纱向和尺寸表保持原值。</p><div class="pants-buttons"><button id="rule-build">核对并使用规则</button><button id="rule-download" disabled>下载规则 JSON</button></div><p id="rule-status" role="status">规则只保存在本机；每款首次指定一次。</p></div></details>';
  const $=id=>container.querySelector('#'+id);let profile=null,choices=[],locked=false,busy=false;
  const status=(s,error=false)=>{$('rule-status').textContent=s;$('rule-status').dataset.error=String(error);};
  function options(select,items){select.replaceChildren(new Option('请选择',''));for(const item of items)select.add(new Option(item.label,String(item.id)));}
  function populate(side){
    const group=choices.find(g=>String(g.id)===$('rule-'+side+'-piece').value);
    const lines=(group?.curves||[]).map(c=>({id:c.id,label:(c.primary?'净样 · ':'内部/缝份 · ')+c.entity.name+' #'+c.id}));
    for(const type of ['knee','hem'])options($('rule-'+side+'-'+type),lines);
  }
  function invalidate(){profile=null;$('rule-download').disabled=true;onInvalidate();status('定位或参数已变化，请重新核对规则。');render();}
  function render(){
    const svg=$('pants-rule-canvas');svg.replaceChildren();
    const groups=['front','back'].map(side=>({side,group:choices.find(g=>String(g.id)===$('rule-'+side+'-piece').value)})).filter(x=>x.group);
    const points=groups.flatMap(x=>x.group.curves.flatMap(c=>c.entity.points));if(!points.length)return;
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),pad=Math.max(maxX-minX,maxY-minY)*.04;
    svg.setAttribute('viewBox',[minX-pad,-maxY-pad,maxX-minX+2*pad,maxY-minY+2*pad].join(' '));
    for(const {side,group} of groups)for(const c of group.curves){
      const path=document.createElementNS(ns,'path'),knee=$('rule-'+side+'-knee').value===String(c.id),hem=$('rule-'+side+'-hem').value===String(c.id);
      path.setAttribute('d',c.entity.points.map((p,i)=>(i?'L':'M')+p.x+' '+(-p.y)).join(' '));path.setAttribute('fill','none');path.setAttribute('stroke',knee?'#4ce2ee':hem?'#ffb55e':c.primary?'#d9e3dc':'#708979');path.setAttribute('stroke-width',knee||hem?'3':'1.4');path.setAttribute('vector-effect','non-scaling-stroke');svg.append(path);
      const hit=path.cloneNode();hit.setAttribute('stroke','transparent');hit.setAttribute('stroke-width','12');hit.setAttribute('tabindex','0');hit.setAttribute('role','button');hit.setAttribute('aria-label',group.name+' '+c.entity.name+' #'+c.id);hit.dataset.sourceId=String(c.id);hit.dataset.piece=side;hit.classList.add('rule-hit');
      const select=()=>{
        if(locked||busy)return;
        const [target,type]=$('rule-target').value.split('-');
        if(target!==side){status('请在'+(target==='front'?'前':'后')+'裤片上选择，或先切换点选目标。',true);return;}
        $('rule-'+side+'-'+type).value=String(c.id);invalidate();status('已指定'+(side==='front'?'前':'后')+'片'+(type==='knee'?'膝线':'裤脚')+'，请继续指定其余定位线。');
      };
      hit.onclick=select;hit.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select();}};svg.append(hit);
    }
  }
  for(const side of ['front','back']){
    $('rule-'+side+'-piece').onchange=()=>{populate(side);invalidate();};
    for(const type of ['knee','hem'])$('rule-'+side+'-'+type).onchange=invalidate;
  }
  for(const id of ['rule-name','rule-units','rule-band'])$(id).oninput=invalidate;
  $('rule-build').onclick=async()=>{
    if(locked||busy)return;busy=true;$('rule-build').disabled=true;
    try{
      const rule=createUserPantsRule(getProject(),{name:$('rule-name').value,mmPerSourceUnit:Number($('rule-units').value),hemBandMm:Number($('rule-band').value),pieces:['front','back'].map(side=>({pieceId:Number($('rule-'+side+'-piece').value),kneeId:Number($('rule-'+side+'-knee').value),hemId:Number($('rule-'+side+'-hem').value)}))});
      const accepted=await onProfile(rule);
      if(accepted){profile=rule;$('rule-download').disabled=false;const count=rule.pieces.reduce((n,r)=>n+r.translate.length+r.sides.length+r.seams.length,0);status('规则已就绪：'+rule.pieces.map(r=>r.name).join('、')+'，共 '+count+' 条联动线。请生成前后对比，核对后再应用。');}
    }catch(e){status(e.message,true);}
    finally{busy=false;$('rule-build').disabled=locked;}
  };
  $('rule-download').onclick=()=>{if(profile)download(new TextEncoder().encode(JSON.stringify(profile,null,2)),profile.name.replace(/[\\/:*?"<>|]/g,'_')+'.json','application/json');};
  function refresh(){
    choices=pantsRuleChoices(getProject());
    for(const side of ['front','back']){options($('rule-'+side+'-piece'),choices.map(g=>({id:g.id,label:g.name+' · '+g.curves.length+' 条线'})));populate(side);}
    profile=null;$('rule-download').disabled=true;status('规则只保存在本机；每款首次指定一次。');render();
  }
  function load(rule){
    if(rule.schema!=='zhiyi-web-pants-profile/v3')return;
    profile=JSON.parse(JSON.stringify(rule));$('rule-name').value=rule.name;$('rule-units').value=String(rule.mmPerSourceUnit);$('rule-band').value=String(rule.hemBandMm);
    for(const [i,side] of ['front','back'].entries()){const r=rule.pieces[i];$('rule-'+side+'-piece').value=String(r.pieceId);populate(side);$('rule-'+side+'-knee').value=String(r.kneeId);$('rule-'+side+'-hem').value=String(r.hemId);}
    $('rule-download').disabled=false;status('已载入本机规则，定位线如图；可下载备份或生成改版对比。');render();
  }
  return {refresh,load,lock(value){locked=value;for(const e of container.querySelectorAll('input,select,button'))e.disabled=value||busy;$('rule-download').disabled=value||!profile;},reset(){refresh();$('pants-rule-builder').open=false;}};
}
