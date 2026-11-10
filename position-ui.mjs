import { preparePosition, applyPosition, positionStamp } from './position.mjs';
import { bounds } from './geometry.mjs';
import { bezierSpans } from './curves.mjs';

export function createPositionPanel({getProject,getSelection,getTool,commit,setTool,render,fit,notify}){
  const $=id=>document.getElementById(id),slots=['a','b','target-a','target-b'],labels={a:'A',b:'B','target-a':'目标 A','target-b':'目标 B'};
  const format=n=>Number.isFinite(n)?Number(n.toFixed(8)).toString():'—';
  let ids=[],preview=null,picking=null,message='先选择纸样，再设置基准点。';
  const number=id=>$(id).value.trim()?Number($(id).value):NaN;
  const point=slot=>({x:number('position-'+slot+'-x'),y:number('position-'+slot+'-y')});
  const setPoint=(slot,p)=>{for(const axis of ['x','y'])$('position-'+slot+'-'+axis).value=String(p[axis]);};
  function visibleSlots(){const op=$('position-operation').value;return op==='align'?slots:op==='move'?['a','target-a']:op==='mirror'?['a','b']:['a'];}
  function config(){return {ids:[...ids],operation:$('position-operation').value,a:point('a'),b:point('b'),targetA:point('target-a'),targetB:point('target-b'),angle:number('position-angle'),factor:number('position-factor'),alignScale:$('position-align-scale').checked,copy:$('position-copy').checked};}
  function invalidate(text='设置已变化，请重新预览。'){preview=null;message=text;}
  function reset(){ids=[];picking=null;invalidate('先选择纸样，再设置基准点。');}
  const guard=fn=>()=>{try{fn();}catch(error){invalidate(error.message);notify(error.message);refresh();render();}};
  function capture(){
    ids=[...getSelection()];if(!ids.length)throw new Error('请先用选择工具选中需要定位的图元');
    const box=bounds(getProject().entities.filter(e=>ids.includes(e.id)));
    if(box){const a={x:(box.minX+box.maxX)/2,y:(box.minY+box.maxY)/2};setPoint('a',a);setPoint('b',{x:a.x+50,y:a.y});setPoint('target-a',{x:a.x+100,y:a.y});setPoint('target-b',{x:a.x+150,y:a.y});}
    picking=null;invalidate('选区已记录；可输入坐标或拾取基准点。');refresh();render();
  }
  function refresh(){
    const project=getProject(),unit=project.units==='mm'?'mm':'原始单位',op=$('position-operation').value;
    if(preview&&preview.signature!==positionStamp(project))invalidate('工程已变化，请重新预览。');
    const visible=visibleSlots();for(const slot of slots){$('position-'+slot+'-field').hidden=!visible.includes(slot);$('position-pick-'+slot).classList.toggle('active',picking===slot);$('position-pick-'+slot).setAttribute('aria-pressed',String(picking===slot));}
    $('position-angle-field').hidden=op!=='rotate';$('position-factor-field').hidden=op!=='scale';$('position-align-field').hidden=op!=='align';
    $('position-unit').textContent=unit;$('position-count').textContent=ids.length+' 个图元 · '+(ids.length?getProject().entities.filter(e=>ids.includes(e.id)).slice(0,3).map(e=>e.name||e.id).join('、'):'尚未记录选区');
    $('position-pick-status').textContent=picking?'在画布单击 '+labels[picking]+'，可吸附原图端点。':'输入坐标，或点“拾取”后在画布指定点。';
    $('position-cancel-pick').hidden=!picking;$('position-apply').disabled=!preview;$('position-fit').disabled=!preview;
    $('position-apply').textContent=$('position-copy').checked?'应用并生成副本':'应用定位';
    const status=$('position-status');status.replaceChildren();
    const row=(text,warn=false)=>{const p=document.createElement('p');p.textContent=text;if(warn)p.className='position-warning';status.append(p);};
    if(!preview){row(message);return;}
    row('预览就绪 · '+preview.selectionIds.length+' 个结果图元 · '+preview.affected.length+' 项关联已重算');
    if(preview.endResidual!==null)row('A 对齐目标 A；B 与目标 B 相距 '+format(preview.endResidual)+' '+unit+'。'+(preview.config.alignScale?'已按基准长度等比缩放。':'保持原尺寸，仅对齐方向。'));
    if(preview.matrix.scale!==1)row('几何与放码增量 × '+format(preview.matrix.scale)+'；缝份宽度、刀口深度/间距/绝对位置、对缝工艺值与排料位置保留原值。');
    if(preview.copied)row('新增 '+preview.copied.entities+' 图元、'+preview.copied.groups+' 组合、'+preview.copied.seamAllowances+' 缝份、'+preview.copied.notches+' 刀口、'+preview.copied.gradingPlans+' 放码方案。仅复制完整选中的关联；排料订单保留原引用。');
    if(preview.grains.changed.length)row(preview.grains.changed.length+' 项手动布纹角度已随整片变换。');
    for(const item of preview.grains.partial)row('排料「'+item.name+'」只选中部分图元，手动布纹方向未改，请核对。',true);
    for(const issue of preview.issues)row(issue.kind+'「'+issue.name+'」：'+issue.message,true);
    if(preview.issues.length)row('可应用后继续修复。失效的关联输出仍保留供核对。',true);
  }
  function pick(p){if(!picking){notify('请先在定位面板选择要拾取的基准点');return;}setPoint(picking,p);picking=null;invalidate('基准点已拾取，请预览定位结果。');refresh();render();}
  function draw({node,overlay,screen,pathData,scale}){
    if(getTool()!=='position')return;
    for(const slot of visibleSlots()){
      const p=point(slot);if(!Number.isFinite(p.x)||!Number.isFinite(p.y))continue;const s=screen(p),color=slot.startsWith('target')?'#b86b2d':'#2c899b';
      node('path',{d:`M ${s.x-6} ${s.y} h 12 M ${s.x} ${s.y-6} v 12`,stroke:color,'stroke-width':2,'data-position-point':slot},overlay);
      const label=node('text',{x:s.x+8,y:s.y-8,fill:color,'font-size':12},overlay);label.textContent=labels[slot];
    }
    if(!preview)return;
    const display=new Set(preview.displayIds);
    for(const entity of preview.project.entities){
      if(!display.has(entity.id))continue;
      const attrs={'data-position-preview':entity.id};
      if(entity.type==='text'){
        if(!$('show-text').checked)continue;const origin=screen(entity.points[0]);
        const text=node('text',{...attrs,x:0,y:0,fill:'#ba6e32','font-size':entity.height*scale,'font-family':'Arial,"Microsoft YaHei",sans-serif','dominant-baseline':entity.verticalAlign==='middle'?'central':'auto',transform:`translate(${origin.x} ${origin.y}) rotate(${-(entity.rotation||0)}) scale(1 ${entity.mirrorY?-1:1})`,textLength:entity.width*scale,lengthAdjust:'spacingAndGlyphs'},overlay);text.textContent=entity.text;continue;
      }
      let d=pathData(entity.points,entity.closed);
      if(entity.curve){d='';for(const span of bezierSpans(entity.curve)){const points=span.controlPoints.map(screen);if(!d)d='M '+points[0].x+' '+points[0].y;d+=' '+(points.length===3?'Q ':'C ')+points.slice(1).map(p=>p.x+' '+p.y).join(' ');}if(entity.closed)d+=' Z';}
      node('path',{...attrs,d,fill:'none',stroke:'#cb7a37','stroke-width':2.2,'stroke-dasharray':entity.derivedFrom?'6 3':'none'},overlay);
    }
  }
  for(const slot of slots){$('position-pick-'+slot).onclick=()=>{picking=picking===slot?null:slot;setTool('position');refresh();render();};for(const axis of ['x','y'])$('position-'+slot+'-'+axis).addEventListener('input',()=>{invalidate();refresh();render();});}
  for(const id of ['position-operation','position-angle','position-factor','position-align-scale','position-copy'])$(id).addEventListener('input',()=>{picking=null;invalidate();refresh();render();});
  $('position-cancel-pick').onclick=()=>{picking=null;refresh();render();};
  $('position-capture').onclick=guard(capture);$('position-return').onclick=()=>{picking=null;setTool('select');refresh();};
  $('position-preview').onclick=guard(()=>{preview=null;picking=null;preview=preparePosition(getProject(),config(),()=>crypto.randomUUID());setTool('position');refresh();render();});
  $('position-fit').onclick=guard(()=>{if(preview){const display=new Set(preview.displayIds),original=new Set(ids);fit([...getProject().entities.filter(e=>original.has(e.id)),...preview.project.entities.filter(e=>display.has(e.id))]);}});
  $('position-apply').onclick=guard(()=>{const result=applyPosition(getProject(),preview);reset();commit(result.project,result.selectionIds);notify('定位已应用，可撤销。请保存工程文件。');});
  return {refresh,reset,pick,draw,begin(){setTool('position');if(getSelection().size)try{capture();}catch(error){message=error.message;}refresh();$('position-panel').scrollIntoView({block:'start'});}};
}
