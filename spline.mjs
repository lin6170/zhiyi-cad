/**
 * Experimental ET spline model inferred from both supplied PRJ samples.
 * Cubic clamped B-splines reproduce their stored fit points within float32 error.
 * This does not establish the behavior of every ET version.
 */
import { evaluateBSpline, validateCurve } from './curves.mjs';
export function evaluateSpline(controlPoints, knots, parameter) { return evaluateBSpline(controlPoints, knots, parameter, 3); }

function chordDistance(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const squared = dx * dx + dy * dy;
  const t = squared ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / squared)) : 0;
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}

export function reconstructSpline(fitPoints, controlPoints) {
  if (!Array.isArray(fitPoints) || fitPoints.length < 2 || fitPoints.length > 1000 || !Array.isArray(controlPoints) || controlPoints.length !== fitPoints.length + 2) {
    throw new Error('Unsupported spline array lengths');
  }
  for (const p of [...fitPoints, ...controlPoints]) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 100000 || Math.abs(p.y) > 100000) throw new Error('Invalid spline coordinates');
  }
  const intervals = fitPoints.slice(1).map((point,i)=>Math.hypot(point.x-fitPoints[i].x,point.y-fitPoints[i].y));
  const firstPositive=intervals.findIndex(length=>length>0),lastPositive=intervals.length-1-[...intervals].reverse().findIndex(length=>length>0);
  if(firstPositive<0)throw new Error('Spline fit points have no nonzero parameter interval');
  const parameters = [0];
  for (let i = 1; i < fitPoints.length; i++) {
    const length = intervals[i-1];
    if(length===0 && i-1>=firstPositive && i-1<=lastPositive)throw new Error('Repeated interior spline fit points require separate validation');
    if(length>0 && length<1e-8)throw new Error('Near-repeated spline fit points require separate validation');
    const endInterval = i === 1 || i === fitPoints.length - 1;
    parameters.push(parameters[i - 1] + length * (endInterval ? 1.5 : 1));
    if(length>0 && parameters[i]===parameters[i-1])throw new Error('Spline parameter interval lost to rounding');
  }
  const end = parameters[parameters.length - 1];
  const originalKnots = [0, 0, 0, 0, ...parameters.slice(1, -1), end, end, end, end];
  const removedStart=firstPositive,removedEnd=intervals.length-1-lastPositive;
  // Excess endpoint knots create zero-support basis functions. Remove only those
  // basis functions; never merge near points or alter the active control polygon.
  const knots=originalKnots.slice(removedStart,originalKnots.length-removedEnd);
  const controls=controlPoints.slice(removedStart,controlPoints.length-removedEnd).map(p=>({...p}));
  const normalization=removedStart||removedEnd?{removedStart,removedEnd,sourceControlPointIndices:controls.map((_,i)=>i+removedStart)}:null;
  if(normalization){
    const same=(a,b)=>a.x===b.x&&a.y===b.y;
    if(!same(controls[0],fitPoints[0])||!same(controls.at(-1),fitPoints.at(-1))||!same(controlPoints[0],fitPoints[0])||!same(controlPoints.at(-1),fitPoints.at(-1)))throw new Error('Normalized spline endpoint does not equal the stored endpoint');
  }
  validateCurve({kind:'bspline',degree:3,knots,controlPoints:controls});
  let maxFitError = 0;
  for (let i = 0; i < fitPoints.length; i++) {
    const p = evaluateSpline(controls, knots, parameters[i]);
    maxFitError = Math.max(maxFitError, Math.hypot(p.x - fitPoints[i].x, p.y - fitPoints[i].y));
  }
  if (maxFitError > 0.002) throw new Error('Spline model does not reproduce stored fit points');

  // Tessellate each knot span using three flatness probes, limiting CPU and size.
  const samplingTolerance = 0.002, maxPoints = 1024;
  const points = [evaluateSpline(controls, knots, 0)];
  let samplingCapped = false;
  function subdivide(startT, endT, startPoint, endPoint, depth, budget) {
    const quarter = (endT - startT) / 4;
    const probes = [1, 2, 3].map(i => evaluateSpline(controls, knots, startT + quarter * i));
    const flat = probes.every(p => chordDistance(p, startPoint, endPoint) <= samplingTolerance);
    if (flat || depth >= 12 || budget <= 1) {
      if (!flat) samplingCapped = true;
      points.push(endPoint);
      return 1;
    }
    const leftBudget = Math.floor(budget / 2);
    const left = subdivide(startT, startT + 2 * quarter, startPoint, probes[1], depth + 1, leftBudget);
    const right = subdivide(startT + 2 * quarter, endT, probes[1], endPoint, depth + 1, budget - left);
    return left + right;
  }
  const distinctParameters=[...new Set(parameters)];
  for (let i = 1; i < distinctParameters.length; i++) {
    const remainingSpans = distinctParameters.length - i;
    const remainingPoints = maxPoints - points.length;
    const budget = Math.max(1, Math.floor(remainingPoints / remainingSpans));
    subdivide(distinctParameters[i - 1], distinctParameters[i], points[points.length - 1], evaluateSpline(controls, knots, distinctParameters[i]), 0, budget);
  }
  return { points, degree: 3, controlPoints:controls, knots, originalKnots, normalization, parameters, maxFitError, samplingTolerance, samplingCapped, method: normalization?'inferred-clamped-cubic-bspline-endpoint-normalized':'inferred-clamped-cubic-bspline' };
}
