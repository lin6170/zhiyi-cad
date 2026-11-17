/**
 * What a piece is cut from and how many times: the fabric, the number of pieces, whether it
 * is a symmetric pair; and the one-line label that states these on the piece.
 *
 * A fabric in an ET file is a number. The name beside it comes from the fabric table of the
 * ET installation that saved the file: ET 2017 keeps the number, the piece count and the
 * symmetry of a file it opens, and writes the name its own table has for that number
 * (checked with a made-up file: 110 written as 里料 came back as 里, 111 came back without a
 * name, 100 stayed 面料). So the number is what identifies the fabric; the name is for people.
 */

/** Fabric names and their numbers as found in the user's own ET files; 100 is 面料 in every file seen. */
export const MATERIAL_CODES = Object.freeze({ 面料: 100, 里料: 110, 里布: 111 });
const NAME_OF = Object.fromEntries(Object.entries(MATERIAL_CODES).map(([name, code]) => [code, name]));

/** The name shown for a fabric number that came without a name. */
export const materialName = (name, code) => name || NAME_OF[code] || '布料 ' + code;

/** The fabrics a piece of this drawing may have, name to number: the known ones, and those that came from an ET file. */
export function materialTable(project) {
  const table = new Map(Object.entries(MATERIAL_CODES));
  for (const group of project.groups || []) { const a = group.attributes; if (a && a.material && Number.isInteger(a.materialCode) && !table.has(a.material)) table.set(a.material, a.materialCode); }
  return table;
}
export function attributesOf(group) {
  const a = group.attributes || {}, code = Number.isInteger(a.materialCode) ? a.materialCode : MATERIAL_CODES[a.material] ?? (a.material ? null : 100);
  return { material: materialName(a.material, code ?? 100), materialCode: code, count: Number.isInteger(a.count) && a.count >= 1 ? a.count : 1, symmetric: a.symmetric === true };
}
/**
 * How many pieces are really cut. A symmetric piece is cut once more, mirrored, for each piece: this is how ET counts when it
 * tells another system the quantity (its DXF export writes 4 for a piece with count 2 that is symmetric, 3 for count 3 that is not).
 */
export function piecesToCut(attributes) { return attributes.count * (attributes.symmetric ? 2 : 1); }

/** The label of a piece: its name, fabric and count on one line, for example "后袋 面料 × 2（对称）". */
export function labelText(group) { const a = attributesOf(group); return group.name + ' ' + a.material + ' × ' + a.count + (a.symmetric ? '（对称）' : ''); }

/** The label text of a piece, if it has one, is brought up to date. Returns the text entity or null. */
export function refreshPieceLabel(project, group) {
  const ids = new Set(group.entityIds), label = project.entities.find(e => ids.has(e.id) && e.type === 'text' && e.pieceLabel === true);
  if (!label) return null;
  const text = labelText(group);
  if (label.text !== text) { if (label.width) delete label.width; label.text = text; label.name = text; }
  return label;
}
