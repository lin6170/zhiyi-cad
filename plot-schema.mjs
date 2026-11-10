export const plotPapers={A4:[210,297],A3:[297,420],A2:[420,594],A1:[594,841],A0:[841,1189],Letter:[215.9,279.4],Legal:[215.9,355.6]};
export function defaultPlotSettings(){return {source:'project',sourceId:null,sizeId:null,selectionIds:[],mode:'tiles',paper:'A4',orientation:'portrait',customWidth:210,customHeight:297,rollWidth:914,margin:10,overlap:10,rotation:0,lineWidth:.18,color:false,showText:true,marks:true,calibration:true,excludedLayers:[]};}
export function normalizePlotSettings(value){
  if(!value||!['project','selection','grade','marker','marker-cuts'].includes(value.source)||!['tiles','full'].includes(value.mode)||![...Object.keys(plotPapers),'custom'].includes(value.paper)||!['portrait','landscape'].includes(value.orientation)||![0,90,180,270].includes(value.rotation))throw new Error('出图来源、纸张或旋转设置无效');
  for(const [key,min,max] of [['customWidth',100,5000],['customHeight',100,5000],['rollWidth',100,5000],['margin',5,50],['overlap',0,50],['lineWidth',.05,1]])if(!Number.isFinite(value[key])||value[key]<min||value[key]>max)throw new Error('出图尺寸、边距、重叠或线宽无效');
  for(const key of ['color','showText','marks','calibration'])if(typeof value[key]!=='boolean')throw new Error('出图显示设置无效');
  for(const [key,max] of [['selectionIds',30000],['excludedLayers',300]])if(!Array.isArray(value[key])||value[key].length>max||value[key].some(id=>typeof id!=='string'||id.length>1000)||new Set(value[key]).size!==value[key].length)throw new Error('出图图层或选择引用无效');
  if(value.sourceId!==null&&typeof value.sourceId!=='string'||value.sizeId!==null&&typeof value.sizeId!=='string')throw new Error('出图方案引用无效');
  if(['grade','marker','marker-cuts'].includes(value.source)&&!value.sourceId||value.source==='grade'&&!value.sizeId)throw new Error('请选择出图方案和目标尺码');
  return Object.fromEntries(Object.keys(defaultPlotSettings()).map(key=>[key,Array.isArray(value[key])?[...value[key]]:value[key]]));
}
export function validatePlotSettings(project){if(project.plotSettings!==undefined){project.plotSettings=normalizePlotSettings(project.plotSettings);project.version=Math.max(project.version,10);}}
