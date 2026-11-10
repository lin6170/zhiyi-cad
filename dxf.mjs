import { validateCurve, refreshCurve, sampleCurve } from './curves.mjs';
import { closedDxfCurve, clampDxfCurve } from './dxf-splines.mjs';
import { textWidth } from './geometry.mjs';
const decode=value=>value.replace(/\\U\+([0-9a-f]{4})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
const encode=value=>String(value).replace(/[\r\n\x00-\x1f]/g,' ').replace(/\\(?=U\+[0-9a-f]{4})/gi,'\\U+005C').replace(/[^\x20-\x7e]/g,char=>'\\U+'+char.charCodeAt(0).toString(16).toUpperCase().padStart(4,'0'));
const finite=value=>{const number=Number(value);if(value===undefined||String(value).trim()===''||!Number.isFinite(number))throw new Error('DXF 包含无效数值');return number;};
const pointOK=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.abs(p.x)<=1e8&&Math.abs(p.y)<=1e8;
export function decodeDxfBytes(input){
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
  if(bytes.length>16*1024*1024)throw new Error('DXF 文件大小超过 16 MB');
  const bom=bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf;
  const prefix=new TextDecoder('windows-1252').decode(bytes.subarray(bom?3:0,Math.min(bytes.length,1024*1024))).split(/\r?\n/);
  let section='',version=null,codePage=null;
  for(let i=0;i+1<prefix.length;i+=2){const code=prefix[i].trim(),value=prefix[i+1].trim();if(code==='0'&&value==='SECTION'){section=prefix[i+3]?.trim()||'';i+=2;continue;}if(code==='0'&&value==='ENDSEC')section='';if(section!=='HEADER'||code!=='9')continue;if(value==='$ACADVER'&&prefix[i+2]?.trim()==='1')version=prefix[i+3]?.trim()||null;if(value==='$DWGCODEPAGE'&&prefix[i+2]?.trim()==='3')codePage=prefix[i+3]?.trim()||null;}
  if(section==='HEADER'&&bytes.length>1024*1024)throw new Error('DXF HEADER 超过读取上限');
  const labels={ANSI_936:'gb18030',ANSI_950:'big5',ANSI_932:'shift_jis',ANSI_949:'euc-kr',ANSI_874:'windows-874',UTF_8:'utf-8',UTF8:'utf-8'};
  for(let i=1250;i<=1258;i++)labels['ANSI_'+i]='windows-'+i;
  const modern=version&&Number(version.slice(2))>=1021,encoding=bom||modern?'utf-8':codePage?labels[codePage.toUpperCase()]:'windows-1252';
  if(!encoding)throw new Error('暂不支持 DXF 字符编码 '+codePage+'，请转存 UTF-8 DXF');
  try{return {text:new TextDecoder(encoding,{fatal:true}).decode(bytes),encoding,codePage,version};}catch{throw new Error('DXF 字节与声明编码 '+(codePage||encoding)+' 不一致，请检查编码后重试');}
}
export function toDxf(project,{curveMode='native',tolerance=.01}={}){
  if(project.units!=='mm')throw new Error('请先确认 PRJ 的毫米比例，再导出 DXF');
  if((project.seamAllowances||[]).some(recipe=>recipe.status!=='current'))throw new Error('缝份尚未有效重算，请修复基准或解除关联后导出');
  if((project.notches||[]).some(recipe=>recipe.status!=='current'))throw new Error('刀口尚未有效重算，请修复基准或解除关联后导出');
  if(!['native','polyline'].includes(curveMode)||!Number.isFinite(tolerance)||tolerance<.001||tolerance>.5)throw new Error('DXF 模式或采样偏差无效（0.001–0.5 mm）');
  if(!Array.isArray(project.entities)||project.entities.length>30000)throw new Error('DXF 图元数量超过限制');
  const pairs=[],push=(...values)=>pairs.push(...values.map(String));let nextHandle=0x10;const handle=()=> (++nextHandle).toString(16).toUpperCase();
  const layerMap=new Map(),used=new Set(['0']);
  for(const entity of project.entities){const raw=String(entity.layer||'outline');if(layerMap.has(raw))continue;if(raw==='0'){layerMap.set(raw,'0');continue;}let layer=raw.replace(/[<>/\\":;?*|=\x00-\x1f]/g,'_').slice(0,200)||'outline',suffix=1;while(used.has(layer))layer=raw.slice(0,170).replace(/[<>/\\":;?*|=\x00-\x1f]/g,'_')+'_'+(++suffix);used.add(layer);layerMap.set(raw,layer);}
  push(0,'SECTION',2,'HEADER',9,'$ACADVER',1,'AC1015',9,'$DWGCODEPAGE',3,'ANSI_1252',9,'$INSUNITS',70,4,0,'ENDSEC',0,'SECTION',2,'TABLES');
  const ltypeHandle=handle();push(0,'TABLE',2,'LTYPE',5,ltypeHandle,330,0,100,'AcDbSymbolTable',70,1,0,'LTYPE',5,handle(),330,ltypeHandle,100,'AcDbSymbolTableRecord',100,'AcDbLinetypeTableRecord',2,'CONTINUOUS',70,0,3,'Solid line',72,65,73,0,40,0,0,'ENDTAB');
  const layerHandle=handle();push(0,'TABLE',2,'LAYER',5,layerHandle,330,0,100,'AcDbSymbolTable',70,used.size);
  for(const layer of used)push(0,'LAYER',5,handle(),330,layerHandle,100,'AcDbSymbolTableRecord',100,'AcDbLayerTableRecord',2,encode(layer),70,0,62,7,6,'CONTINUOUS');
  const styleHandle=handle();push(0,'ENDTAB',0,'TABLE',2,'STYLE',5,styleHandle,330,0,100,'AcDbSymbolTable',70,1,0,'STYLE',5,handle(),330,styleHandle,100,'AcDbSymbolTableRecord',100,'AcDbTextStyleTableRecord',2,'STANDARD',70,0,40,0,41,1,50,0,71,0,42,2.5,3,'Arial.ttf',4,'',0,'ENDTAB',0,'ENDSEC',0,'SECTION',2,'ENTITIES');
  let vertexCount=0;
  for(const entity of project.entities){
    const layer=encode(layerMap.get(String(entity.layer||'outline')));
    const start=type=>push(0,type,5,handle(),100,'AcDbEntity',8,layer);
    if(entity.type==='text'){
      if(!pointOK(entity.points?.[0])||!Number.isFinite(entity.height)||entity.height<=0||typeof entity.text!=='string')throw new Error('DXF 文字数据无效');
      // Empty editor slots have no visible DXF text; their layout lives in .zycad.
      if(entity.text==='')continue;
      const factor=(entity.width||textWidth(entity.text,entity.height))/Math.max(textWidth(entity.text,entity.height),1e-9);
      if(!Number.isFinite(factor)||factor<=0||encode(entity.text).length>2049)throw new Error('DXF 单行文字为空、宽度无效或超过 2049 字节；请调整文字后导出');
      start('TEXT');push(100,'AcDbText',10,entity.points[0].x,20,entity.points[0].y,30,0,40,entity.height,1,encode(entity.text),50,entity.rotation||0,41,factor,7,'STANDARD',71,entity.mirrorY?4:0);
      if(entity.verticalAlign==='middle')push(11,entity.points[0].x,21,entity.points[0].y,31,0,100,'AcDbText',73,2);
      continue;
    }
    if(entity.curve&&curveMode==='native'){
      const curve=entity.closed?closedDxfCurve(entity.curve):validateCurve(entity.curve),points=curve.controlPoints;
      start('SPLINE');push(100,'AcDbSpline',210,0,220,0,230,1,70,entity.closed?9:8,71,curve.degree,72,curve.knots.length,73,points.length,74,0,42,0,43,0,44,0);
      for(const knot of curve.knots)push(40,knot);
      for(const point of points)push(10,point.x,20,point.y,30,0);
      vertexCount+=points.length;
    }else{
      let points=entity.points;
      if(entity.curve){const sampled=sampleCurve({...entity.curve,samplingTolerance:tolerance},8192);if(sampled.capped)throw new Error('曲线采样未达到指定偏差，请增大偏差或使用原生 DXF');points=sampled.points;}
      if(!Array.isArray(points)||points.length<2||points.some(point=>!pointOK(point)))throw new Error('DXF 坐标无效');
      start('LWPOLYLINE');push(100,'AcDbPolyline',90,points.length,70,entity.closed?1:0);
      for(const point of points)push(10,point.x,20,point.y);
      vertexCount+=points.length;
    }
    if(vertexCount>1000000)throw new Error('DXF 输出节点超过 1000000 个上限');
  }
  push(0,'ENDSEC',0,'EOF');return pairs.join('\n')+'\n';
}

const unitTable=new Map([[1,['英寸',25.4]],[2,['英尺',304.8]],[3,['英里',1609344]],[4,['毫米',1]],[5,['厘米',10]],[6,['米',1000]],[7,['千米',1e6]],[8,['微英寸',.0000254]],[9,['密耳',.0254]],[10,['码',914.4]],[11,['埃',1e-7]],[12,['纳米',1e-6]],[13,['微米',.001]],[14,['分米',100]],[15,['十米',10000]],[16,['百米',100000]]]);
export function fromDxf(text){
  if(typeof text!=='string'||text.length>16*1024*1024)throw new Error('DXF 文本大小超过 16 MB');
  text=text.replace(/^\uFEFF/,'');if(text.startsWith('AutoCAD Binary DXF'))throw new Error('暂时支持文本 DXF，请导出 ASCII DXF');
  const lines=text.replace(/\r/g,'').split('\n');while(lines.length&&lines.at(-1)==='')lines.pop();
  if(lines.length%2)throw new Error('DXF 组码和值不成对，文件可能截断');
  const pairs=[];
  for(let i=0;i<lines.length;i+=2){const code=Number(lines[i].trim());if(!/^\d+$/.test(lines[i].trim())||!Number.isInteger(code)||code>1071)throw new Error('DXF 组码无效（第 '+(i+1)+' 行）');if(code!==999)pairs.push([code,lines[i+1]]);}
  let section='',current=null,polyline=null,unitCode=0,eof=false,converted=0,splineCount=0,recordCount=0,vertexCount=0;
  const records=[],skipped=new Map(),entities=[],warnings=[];
  const get=(record,code,fallback)=>record.find(pair=>pair[0]===code)?.[1]??fallback;
  const num=(record,code,fallback)=>finite(get(record,code,fallback));
  const integer=(record,code,fallback)=>{const value=num(record,code,fallback);if(!Number.isSafeInteger(value)||value<0)throw new Error('DXF 数量或标志无效');return value;};
  for(let i=0;i<pairs.length;i++){
    const [code,raw]=pairs[i],value=raw.trim();
    if(code===0&&value==='EOF'){if(section)throw new Error('DXF 缺少 ENDSEC');eof=true;if(i!==pairs.length-1)throw new Error('DXF EOF 后包含额外记录');break;}
    if(code===0&&value==='SECTION'){if(section||pairs[i+1]?.[0]!==2)throw new Error('DXF SECTION 结构无效');section=pairs[++i][1].trim();continue;}
    if(code===0&&value==='ENDSEC'){if(!section)throw new Error('DXF ENDSEC 结构无效');if(section==='ENTITIES'&&current)records.push(current);current=null;section='';continue;}
    if(section==='HEADER'&&code===9&&value==='$INSUNITS'){if(pairs[i+1]?.[0]!==70)throw new Error('DXF 单位字段无效');unitCode=integer([pairs[++i]],70);}
    if(section!=='ENTITIES')continue;
    if(code===0){if(current)records.push(current);current=[[0,value]];}else if(current)current.push([code,raw]);
  }
  if(!eof||section)throw new Error('DXF 缺少 EOF 或文件未完整结束');
  const unit=unitTable.get(unitCode),scale=unit?.[1]??1,units=unit?'mm':'unknown';
  const skip=(type,reason)=>{const key=type+'：'+reason,previous=skipped.get(key);skipped.set(key,{type,reason,count:(previous?.count||0)+1});};
  const point=(record,xcode,ycode)=>({x:num(record,xcode)*scale,y:num(record,ycode)*scale});
  function common(record){return {id:'dxf-'+entities.length,name:record[0][1]+' '+(entities.length+1),layer:decode(get(record,8,'outline')),type:'polyline',closed:false,source:{kind:'dxf',entityType:record[0][1],handle:get(record,5,null),unitCode,scaleToMillimeters:unit?scale:null}};}
  function add(entity){
    if(entity.points.some(p=>!pointOK(p)))throw new Error('DXF 坐标不完整或换算后超过范围');
    vertexCount+=entity.points.length;if(vertexCount>1000000||entities.length>=30000)throw new Error('DXF 图元或节点数量超过限制');entities.push(entity);
  }
  function planar(record,wcs=false){
    const normal=[num(record,210,0),num(record,220,0),num(record,230,1)];
    if(normal[0]!==0||normal[1]!==0||(wcs?Math.abs(normal[2])!==1:normal[2]!==1))return false;
    if(num(record,39,0)!==0||num(record,38,0)!==0)return false;
    return record.every(([code,value])=>![30,31,32,33].includes(code)||finite(value)===0);
  }
  function coordinates(record,xcode,ycode,zcode){
    const points=[];let current=null;
    for(const [code,value] of record){
      if(code===xcode){if(current&&current.y===undefined)throw new Error('DXF 坐标不完整');current={x:finite(value)*scale};points.push(current);}
      else if(code===ycode){if(!current||current.y!==undefined)throw new Error('DXF 坐标顺序无效');current.y=finite(value)*scale;}
      else if(code===zcode){if(!current)throw new Error('DXF 坐标顺序无效');finite(value);}
    }
    if(points.some(p=>!pointOK(p)))throw new Error('DXF 坐标不完整或换算后超过范围');return points;
  }
  for(const record of records){
    const type=record[0][1];if(!['VERTEX','SEQEND'].includes(type))recordCount++;
    if(polyline&&!['VERTEX','SEQEND'].includes(type))throw new Error('DXF POLYLINE 缺少 SEQEND');
    if(type==='POLYLINE'){
      const flags=integer(record,70,0);polyline={entity:{...common(record),closed:Boolean(flags&1),points:[]},reason:null};
      if(integer(record,67,0)!==0)polyline.reason='非模型空间图元';else if(flags&126)polyline.reason='非二维普通折线';else if(!planar(record))polyline.reason='非 XY 零高程平面';continue;
    }
    if(type==='VERTEX'){
      if(!polyline)throw new Error('DXF VERTEX 缺少 POLYLINE');
      if(num(record,42,0)!==0)polyline.reason='带圆弧凸度';if(!planar(record))polyline.reason='非 XY 零高程平面';
      polyline.entity.points.push(point(record,10,20));continue;
    }
    if(type==='SEQEND'){
      if(!polyline)throw new Error('DXF SEQEND 缺少 POLYLINE');
      if(polyline.reason)skip('POLYLINE',polyline.reason);else{if(polyline.entity.points.length<2)throw new Error('DXF 折线节点不足');add(polyline.entity);}polyline=null;continue;
    }
    if(!['LINE','LWPOLYLINE','TEXT','SPLINE'].includes(type)){skip(type,'未支持的图元');continue;}
    if(integer(record,67,0)!==0){skip(type,'非模型空间图元');continue;}
    if(!planar(record,['LINE','SPLINE'].includes(type))){skip(type,'非 XY 零高程平面');continue;}
    const entity=common(record);
    if(type==='SPLINE'){
      const flags=integer(record,70,0),degree=integer(record,71),knotCount=integer(record,72),controlCount=integer(record,73),fitCount=integer(record,74,0);
      const points=coordinates(record,10,20,30),fitPoints=coordinates(record,11,21,31),knots=record.filter(([code])=>code===40).map(([,value])=>finite(value)),weights=record.filter(([code])=>code===41).map(([,value])=>finite(value));
      if(points.length!==controlCount||knots.length!==knotCount||fitPoints.length!==fitCount)throw new Error('DXF SPLINE 声明数量与实际记录不符');
      if(controlCount>1002||knotCount>1006)throw new Error('DXF 样条超过控制点或结点数量限制');
      if(weights.length&&weights.length!==controlCount||weights.some(w=>w<=0))throw new Error('DXF 样条权重无效');
      if(flags&2){skip(type,'周期样条暂不支持');continue;}
      if(!controlCount){skip(type,'仅拟合点定义，缺少控制点');continue;}
      if(weights.some(w=>w!==weights[0])){skip(type,'非等权有理样条暂不支持');continue;}
      if(![2,3].includes(degree)){skip(type,'仅支持二次、三次非有理样条');continue;}
      const result=clampDxfCurve({kind:'bspline',degree,controlPoints:points,knots,samplingTolerance:.002});entity.curve=result.curve;
      entity.closed=Boolean(flags&1);entity.source.convertedToClamped=result.converted;
      if(entity.closed){const a=entity.curve.controlPoints[0],b=entity.curve.controlPoints.at(-1);if(a.x!==b.x||a.y!==b.y){skip(type,'闭合标志与样条端点不一致');continue;}}
      refreshCurve(entity);add(entity);splineCount++;if(result.converted)converted++;continue;
    }
    if(type==='TEXT'){
      const alignment=integer(record,72,0),vertical=integer(record,73,0),generation=integer(record,71,0);
      if(alignment!==0||![0,2].includes(vertical)||generation&~4){skip(type,'文字对齐或镜像方式暂不支持');continue;}
      entity.type='text';entity.text=decode(get(record,1,''));entity.name=entity.text;entity.height=num(record,40)*scale;entity.rotation=num(record,50,0);entity.width=textWidth(entity.text,entity.height)*num(record,41,1);entity.verticalAlign=vertical===2?'middle':'baseline';entity.mirrorY=Boolean(generation&4);
      entity.points=[vertical===2?point(record,11,21):point(record,10,20)];
      if(entity.height<=0||entity.width<=0||entity.height>1e6||entity.width>1e8||entity.text.length>10000)throw new Error('DXF 文字数据无效');add(entity);continue;
    }
    if(type==='LINE')entity.points=[point(record,10,20),point(record,11,21)];
    else{
      if(record.some(([code,value])=>code===42&&finite(value)!==0)){skip(type,'带圆弧凸度');continue;}
      entity.points=coordinates(record,10,20,30);if(entity.points.length!==integer(record,90))throw new Error('DXF 折线节点数量不符');entity.closed=Boolean(integer(record,70,0)&1);
    }
    if(entity.points.length<2)throw new Error('DXF 线条节点不足');add(entity);
  }
  if(polyline)throw new Error('DXF POLYLINE 缺少 SEQEND');
  const skippedRecords=[...skipped.values()],skippedCount=skippedRecords.reduce((sum,r)=>sum+r.count,0);
  if(!entities.length)throw new Error('DXF 中未发现可导入图元'+(skippedRecords.length?'：'+skippedRecords.map(r=>r.type+' '+r.reason).join('；'):''));
  if(skippedCount)warnings.push('部分导入：跳过 '+skippedCount+' 个图元。'+skippedRecords.map(r=>r.type+' ×'+r.count+'（'+r.reason+'）').join('；'));
  warnings.push('DXF 已读取 '+entities.length+' 个图元，其中 '+splineCount+' 条原生样条'+(converted?'；'+converted+' 条非夹持样条已精确转换为夹持跨度':'')+'。');
  if(!unit)warnings.push('DXF 未声明受支持的物理单位，请确认导入比例。');else if(scale!==1)warnings.push('根据 DXF 声明单位 '+unit[0]+'，所有坐标和文字尺寸乘 '+scale+' 换算为毫米；请核对已知尺寸。');
  warnings.push('DXF 保留二维几何、源文字与图层；不恢复 ET 裁片归属、刀口、缝份关联或服装放码规则。');
  return {entities,units,warnings,metadata:{format:'DXF',dxfImport:{recordCount,importedCount:entities.length,splineCount,convertedSplineCount:converted,skippedCount,skippedRecords,complete:!skippedCount,unitCode,scaleToMillimeters:unit?scale:null}}};
}
