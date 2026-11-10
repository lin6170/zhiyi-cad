import { prepareLineEdit, applyLineEdit, lineEditStamp } from './line-edit.mjs';
import { pathMetrics } from './path-metrics.mjs';
import { bezierSpans } from './curves.mjs';

export function createLineEditPanel({getProject,getSelection,getTool,commit,setTool,render,fit,notify}){
  const $=id=>document.getElementById(id),format=value=>Number.isFinite(value)?value.toFixed(6).replace(/0+$/,'').replace(/\.$/,''):'—';
  let ids=[],directions=[],preview=null,rowsKey='',message='选择原线，设置参数后生成预览。';
  const guard=fn=>()=>{try{fn();}catch(error){notify(error.message);message=error.message;refresh();render();}};
  const number=id=>$(id).value.trim()?Number($(id).value):NaN;
  function config(){return {operation:$('line-operation').value,ids:[...ids],directions:[...directions],unit:$('line-position-unit').value,a:number('line-position-a'),b:number('line-position-b'),gapTolerance:number('line-gap'),close:$('line-close').checked,keepOriginals:$('line-keep').checked};}
  function invalidate(text='设置已变化，请重新生成预览。'){preview=null;message=text;}
  function reset(){ids=[];directions=[];rowsKey='';invalidate('选择原线，设置参数后生成预览。');}
  function select(values){
    const project=getProject();
    for(const id of values){const entity=project.entities.find(item=>item.id===id);if(!entity||entity.type==='text'||entity.derivedFrom||entity.notchFrom)throw new Error('请选择原始线条；文字和仍有关联的输出线不能修整');}
    if(values.length>64)throw new Error('每次最多连接 64 条线');
    if($('line-operation').value==='split'&&values.length>1)throw new Error('剪开只接受一条线；可直接在画布点选，或关闭整组选取');
    ids=[...values];directions=ids.map(()=>null);invalidate();refresh();render();
  }
  function capture(){select([...getSelection()]);}
  function pick(entity){try{
    if($('line-operation').value==='split')select([entity.id]);
    else if(!ids.includes(entity.id)){const before=[...directions];select([...ids,entity.id]);directions=ids.map((_,i)=>before[i]??null);rowsKey='';refresh();}
  }catch(error){notify(error.message);}}
  function refresh(){
    const project=getProject(),byId=new Map(project.entities.map(entity=>[entity.id,entity])),isSplit=$('line-operation').value==='split',closed=ids.length===1&&byId.get(ids[0])?.closed;
    if(preview&&preview.signature!==lineEditStamp(project))invalidate('工程已变化，请重新生成预览。');
    $('line-split-fields').hidden=!isSplit;$('line-join-fields').hidden=isSplit;$('line-position-b-field').hidden=!closed;
    $('line-position-a-label').textContent=closed?'位置 A':'分割位置';
    $('line-apply').disabled=!preview;$('line-fit').disabled=!preview;
    $('line-apply').textContent=$('line-keep').checked?'保留原线并应用':'替换原线并应用';
    const key=JSON.stringify([ids,directions,ids.map(id=>[byId.get(id)?.name,byId.get(id)?.closed]),isSplit]);
    if(key!==rowsKey){rowsKey=key;$('line-sources').replaceChildren();ids.forEach((id,i)=>{
      const row=document.createElement('div');row.className='line-source-row';row.dataset.lineSource=id;
      const name=document.createElement('span');name.textContent=(i+1)+'. '+(byId.get(id)?.name||'原线已删除');row.append(name);
      if(!isSplit){
        const direction=document.createElement('select');direction.setAttribute('aria-label','第 '+(i+1)+' 条方向');
        for(const [value,label] of [['auto','自动定向'],['forward','原方向'],['reverse','反向']]){const option=document.createElement('option');option.value=value;option.textContent=label;direction.append(option);}
        direction.value=directions[i]===null?'auto':directions[i]?'reverse':'forward';direction.onchange=()=>{directions[i]=direction.value==='auto'?null:direction.value==='reverse';invalidate();refresh();render();};row.append(direction);
        for(const [label,delta] of [['↑',-1],['↓',1]]){const button=document.createElement('button');button.textContent=label;button.title='调整第 '+(i+1)+' 条连接顺序';button.disabled=i+delta<0||i+delta>=ids.length;button.onclick=()=>{[ids[i],ids[i+delta]]=[ids[i+delta],ids[i]];[directions[i],directions[i+delta]]=[directions[i+delta],directions[i]];invalidate();refresh();render();};row.append(button);}
      }
      const remove=document.createElement('button');remove.textContent='×';remove.title='移除第 '+(i+1)+' 条';remove.onclick=()=>{ids.splice(i,1);directions.splice(i,1);invalidate();refresh();render();};row.append(remove);$('line-sources').append(row);
    });}
    $('line-source-info').textContent=ids.length+' 条原线'+(closed?' · 闭合轮廓需 A、B 两处剪开':'');
    if(ids.length===1&&byId.has(ids[0]))try{const m=pathMetrics(byId.get(ids[0]),{preserveShortPieces:true});$('line-source-info').textContent+=' · 总长 '+format(m.total)+' '+(project.units==='mm'?'mm':'原始单位');}catch{}
    const status=$('line-status');status.replaceChildren();const text=document.createElement('p');text.textContent=preview?preview.outputs.length+' 条结果 · 长度 '+preview.lengths.map(format).join(' / ')+' mm':message;status.append(text);
    if(preview){
      const details=[preview.config.keepOriginals?'原线与原关联保留；生成独立副本。':'应用后替换原线；可撤销。',
        '弧长定位数值误差估计 ≤ '+preview.uncertainty.toExponential(2)+' mm。'];
      if(preview.connectors.length)details.push('补入 '+preview.connectors.length+' 段直线，总长 '+format(preview.connectors.reduce((sum,c)=>sum+c.length,0))+' mm（红色虚线）。');
      if(preview.config.operation==='join')details.push('连接方向：'+preview.directions.map((reverse,i)=>(i+1)+(reverse?' 反向':' 正向')).join('，')+'。');
      if(preview.mixedLayers)details.push('原线图层不同，结果使用第一条线的图层。');
      if(preview.dissolved.length)details.push('合并为单图元，原组合转为图元名称：'+preview.dissolved.join('、')+'。');
      if(preview.effects.length)details.push('以下关联将失效，须重新建立：'+preview.effects.map(effect=>effect.label+' '+effect.count+' 项'+(effect.names.length?'（'+effect.names.join('、')+'）':'')).join('；')+'。旧输出保留供核对，不能继续作为有效输出。');
      for(const item of details){const p=document.createElement('p');p.className='muted';p.textContent=item;status.append(p);}
    }
  }
  function draw({node,overlay,screen,pathData}){
    if(getTool()!=='line-edit')return;
    const project=getProject();
    ids.forEach((id,i)=>{const entity=project.entities.find(item=>item.id===id);if(!entity)return;const p=screen(entity.points[0]);node('circle',{cx:p.x,cy:p.y,r:5,fill:'#fff',stroke:'#377f9c','stroke-width':2,'data-line-start':id},overlay);const label=node('text',{x:p.x+8,y:p.y-8,fill:'#377f9c','font-size':13},overlay);label.textContent=(i+1)+' 起';});
    if(!preview)return;
    const nativePath=entity=>{
      if(!entity.curve)return pathData(entity.points,entity.closed);
      let d='';for(const span of bezierSpans(entity.curve)){const points=span.controlPoints.map(screen);if(!d)d='M '+points[0].x+' '+points[0].y;d+=' '+(points.length===3?'Q ':'C ')+points.slice(1).map(p=>p.x+' '+p.y).join(' ');}return d+(entity.closed?' Z':'');
    };
    preview.outputs.forEach((entity,i)=>node('path',{d:nativePath(entity),fill:'none',stroke:i%2?'#e48b35':'#178d9e','stroke-width':3,'data-line-preview':i},overlay));
    preview.stations.forEach((station,i)=>{const p=screen(station.point);node('circle',{cx:p.x,cy:p.y,r:6,fill:'#fff',stroke:'#d46b39','stroke-width':2,'data-line-cut':i},overlay);const label=node('text',{x:p.x+9,y:p.y+17,fill:'#b85d31','font-size':13},overlay);label.textContent=preview.stations.length===1?'剪开':i?'B':'A';});
    for(const connector of preview.connectors)node('path',{d:pathData([connector.a,connector.b]),fill:'none',stroke:'#e35650','stroke-width':4,'stroke-dasharray':'5 3','data-line-connector':'true'},overlay);
  }
  $('line-operation').onchange=()=>{reset();refresh();render();};
  for(const id of ['line-position-unit','line-position-a','line-position-b','line-gap','line-close','line-keep'])$(id).addEventListener('input',()=>{invalidate();refresh();render();});
  $('line-capture').onclick=guard(capture);$('line-clear').onclick=()=>{reset();refresh();render();};
  $('line-preview').onclick=guard(()=>{preview=null;preview=prepareLineEdit(getProject(),config());setTool('line-edit');refresh();render();});
  $('line-fit').onclick=guard(()=>{if(preview)fit(preview.outputs);});
  $('line-apply').onclick=guard(()=>{const result=applyLineEdit(getProject(),preview,()=>crypto.randomUUID());reset();commit(result.project,result.outputIds);notify('线条修整已应用，可撤销。请保存工程文件。');});
  return {reset,refresh,pick,draw,begin(){setTool('line-edit');if(!ids.length&&getSelection().size)try{capture();}catch(error){message=error.message;}refresh();$('line-edit-panel').scrollIntoView({block:'center'});}};
}
