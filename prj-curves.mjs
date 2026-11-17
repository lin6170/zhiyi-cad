/** Byte-level curve records shared by the separately validated PRJ layouts. */
import { reconstructSpline } from './spline.mjs';
import { refreshCurve } from './curves.mjs';

export function readPrjCurve(bytes, offset, index = 0, { end = bytes.length, polylines = false } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || end > bytes.length || offset + 100 > end) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = o => view.getUint32(o, true), f32 = o => view.getFloat32(o, true);
  const kind = u32(offset + 10);
  if (![2, 4, ...(polylines ? [23] : [])].includes(kind) || u32(offset + 14) !== 0) return null;
  if (f32(offset + (kind === 4 ? 33 : 25)) !== 1) return null;
  function pointsAt(start, count) {
    if (count < 2 || count > 1000 || start + count * 12 > end) return null;
    const points = [];
    for (let i = 0; i < count; i++) {
      const o = start + i * 12, x = f32(o), y = f32(o + 4), z = f32(o + 8);
      // v65: ET leaves leftovers of memory in the z of some extra seam lines it adds for a treated corner (延长反转角): far below
      // anything that could be a coordinate, so they count as zero
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100000 || Math.abs(y) > 100000 || !(Math.abs(z) < 1e-9)) return null;
      points.push({ x, y });
    }
    return points.some(p => Math.abs(p.x) + Math.abs(p.y) > .001) ? points : null;
  }
  const count = kind === 4 ? u32(offset + 41) : kind === 23 ? u32(offset + 34) : 2;
  const pointOffset = offset + (kind === 4 ? 45 : kind === 23 ? 38 : 34);
  const points = pointsAt(pointOffset, count);
  if (!points) return null;
  let geometryEnd = pointOffset + count * 12, controls = null, reconstruction = null;
  if (kind === 4) {
    if (geometryEnd + 4 > end || u32(geometryEnd) !== count + 2) return null;
    controls = pointsAt(geometryEnd + 4, count + 2);
    if (!controls || controls[0].x !== points[0].x || controls[0].y !== points[0].y || controls.at(-1).x !== points.at(-1).x || controls.at(-1).y !== points.at(-1).y) return null;
    geometryEnd += 4 + (count + 2) * 12;
    try {
      reconstruction = reconstructSpline(points, controls);
      if (reconstruction.samplingCapped) reconstruction = null;
    } catch { reconstruction = null; }
  }
  const sourceId = u32(offset);
  const entity = {
    id: `prj-${offset}-${sourceId}`, type: 'polyline', points: reconstruction?.points || points,
    ...(reconstruction ? { curve: { kind:'bspline', degree:3, controlPoints:reconstruction.controlPoints.map(p=>({...p})), knots:[...reconstruction.knots], samplingTolerance:.002 } } : {}),
    closed: false,
    name: `${kind === 4 ? (reconstruction ? '样条曲线' : '曲线拟合点') : kind === 23 ? '原始多段线' : '直线'} ${index + 1}`,
    layer: 'ET 导入',
    source: {
      format: 'ET PRJ', offset, sourceId, recordKind: kind,
      interpolation: reconstruction?.method || (kind === 4 ? 'fit-point-polyline-approximation' : kind === 23 ? 'stored-polyline' : 'line'),
      fitPoints: controls ? points : undefined,
      spline: reconstruction ? { degree:reconstruction.degree, knots:reconstruction.originalKnots, maxFitError:reconstruction.maxFitError, samplingTolerance:reconstruction.samplingTolerance,
        ...(reconstruction.normalization?{normalization:{...reconstruction.normalization,knots:[...reconstruction.knots]}}:{}) } : undefined,
      controlPoints: controls,
      color:Array.from(bytes.subarray(offset + (kind === 4 ? 30 : 22), offset + (kind === 4 ? 33 : 25))),
      baseColor:Array.from(bytes.subarray(offset + 4, offset + 7)),
      lineStyle:u32(offset + (kind === 4 ? 37 : 29)), flags:Array.from(bytes.subarray(offset + 7, offset + 10)),
    },
  };
  if (reconstruction) refreshCurve(entity);
  return { entity, offset, pointOffset, pointEnd:pointOffset + count * 12, geometryEnd, points, kind };
}

export function scanPrjCurves(bytes, { start = 100, end = bytes.length, polylines = false } = {}) {
  const records = [];
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for (let offset = start; offset + 100 <= end; offset++) {
    const kind=view.getUint32(offset+10,true);
    if(kind!==2 && kind!==4 && !(polylines && kind===23))continue;
    const record = readPrjCurve(bytes, offset, records.length, { end, polylines });
    if (record) { records.push(record); offset = record.pointEnd - 1; }
  }
  return records;
}

export function prjCurveStats(entities) {
  const splines = entities.filter(e => e.source.recordKind === 4);
  return {
    parsedCurveCount:entities.length, lineCount:entities.filter(e => e.source.recordKind === 2).length,
    polylineCount:entities.filter(e => e.source.recordKind === 23).length, splineCount:splines.length,
    smoothSplineCount:splines.filter(e => e.curve).length, fallbackSplineCount:splines.filter(e => !e.curve).length,
    endpointNormalizedSplineCount:splines.filter(e=>e.source.spline?.normalization).length,
    maxSplineFitError:Math.max(0, ...splines.map(e => e.source.spline?.maxFitError || 0)),
  };
}

/** What an ET curve record holds after its geometry: reference lists, the seam width of a contour edge, attachments. */
export function curveTail(bytes, offset) {
  const record = readPrjCurve(bytes, offset); if (!record) throw new Error('曲线记录无法读取。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u32 = o => view.getUint32(o, true), f32 = o => view.getFloat32(o, true);
  const flags = Array.from(bytes.subarray(offset + 7, offset + 10)); let o = record.geometryEnd;
  const need = n => { if (o + n > bytes.length) throw new Error('曲线记录被截断。'); };
  if (record.kind === 4) { need(4); const count = u32(o); o += 4; if (count > 10000) throw new Error('曲线显示表长度异常。'); need(count * 4); o += count * 4; }
  const list = () => { need(4); const count = u32(o); o += 4; if (count > 1000) throw new Error('曲线引用表长度异常。'); need(count * 4); const ids = []; for (let i = 0; i < count; i++) { ids.push(u32(o)); o += 4; } return ids; };
  const direct = list(), secondary = list(), links = list(); need(4); const width = f32(o); o += 4;
  let width2 = null; if (flags[1] & 0x10) { need(4); width2 = f32(o); o += 4; }
  // Bit 0x40 marks a record with a different ending (seen on notch marks); its seam width is not meaningful.
  const special = Boolean(flags[0] & 0x40); let attribute = 0;
  if (!special) { need(4); const attached = u32(o); o += 4; if (attached > 1000) throw new Error('曲线附着表长度异常。'); need(attached * 8 + 6); o += attached * 8; attribute = u32(o); }
  // attribute: ET's element attribute word; 0 for an ordinary line, set for auxiliary lines and the like
  // end: where the next record begins; not known for the records with the different ending
  return { flags, kind: record.kind, direct, secondary, links, width, width2, special, attribute, end: special ? null : o + 6 };
}
