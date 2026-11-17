/**
 * Symmetric editing (v62), ET's 对称修改.
 *
 * In ET the tool takes lines and an axis, shows a mirror image of every line and lets the lines be changed while the images
 * follow; the right button ends it and both the lines and their images stay (Shift: only the lines, Ctrl: only the images).
 * Here the images are real lines of the drawing that are kept up to date: a link is stored in the project
 *   project.mirrorLinks = [{ id, axisFrom, axisTo, pairs: [{ sourceId, imageId }] }]
 * and every image carries `mirrorOf`, the id of its line. After every change of the drawing the images are made again from
 * their lines (syncMirrorLinks, called where seam allowances are brought up to date), so any tool or command that changes a
 * line changes its image too. Ending the link turns the images into ordinary lines or removes them.
 * A line that is deleted or cut leaves its image behind as a line of its own; an image that is deleted ends its pair.
 * Pure functions, no DOM.
 */
import { refreshCurve } from './curves.mjs';

const copy = p => ({ x: p.x, y: p.y });
/** The reflection about the line through two points. */
export function reflector(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
  if (!(length > 1e-9)) throw new Error('对称轴的两个点重合。');
  const ux = dx / length, uy = dy / length;
  return p => { const x = p.x - from.x, y = p.y - from.y, along = x * ux + y * uy; return { x: from.x + 2 * along * ux - x, y: from.y + 2 * along * uy - y }; };
}
/** Give `image` the shape of `source` on the other side of the axis. */
export function reflectInto(image, source, link) {
  const reflect = reflector(link.axisFrom, link.axisTo);
  image.type = source.type; image.closed = Boolean(source.closed);
  if (source.curve) { image.curve = { ...source.curve, controlPoints: source.curve.controlPoints.map(reflect), knots: source.curve.knots.slice() }; image.points = source.points.map(reflect); refreshCurve(image); }
  else { delete image.curve; delete image.curveSamplingCapped; image.points = source.points.map(p => reflect(p)); }
  return image;
}
/** Bring every image up to date with its line; drop the pairs that have lost their line or their image. */
export function syncMirrorLinks(project) {
  const links = project.mirrorLinks; if (!Array.isArray(links) || !links.length) { if (links) delete project.mirrorLinks; return; }
  const byId = new Map(project.entities.map(e => [e.id, e]));
  for (const link of links) {
    link.pairs = (Array.isArray(link.pairs) ? link.pairs : []).filter(pair => {
      const source = byId.get(pair.sourceId), image = byId.get(pair.imageId);
      if (!image) return false;                                   // the image was deleted: the pair is over
      if (!source || source.type === 'text') { delete image.mirrorOf; return false; }   // the line is gone: its image stays as a line of its own
      image.mirrorOf = source.id; reflectInto(image, source, link); return true;
    });
  }
  const linked = new Set(links.flatMap(link => link.pairs.map(pair => pair.imageId)));
  for (const e of project.entities) if (e.mirrorOf && !linked.has(e.id)) delete e.mirrorOf;
  project.mirrorLinks = links.filter(link => link.pairs.length);
  if (!project.mirrorLinks.length) delete project.mirrorLinks;
}
/** The pairs a line takes part in as the line that is changed. */
export const linkedImages = (project, sourceId) => (project.mirrorLinks || []).flatMap(link => link.pairs.filter(pair => pair.sourceId === sourceId).map(pair => ({ link, pair })));
export { copy as copyPoint };
