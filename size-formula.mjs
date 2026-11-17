/**
 * Formulas over the names of a size table, as ET writes them in the grading rule of a point: "胸围/4+衣长/10",
 * "衣长-(A+B)/2-C*2". Numbers, names, + - * /, brackets and a leading minus. A name is whatever stands between operators.
 */
const OPERATORS = '+-*/()';
/** A formula as a tree. Names are whatever stands between operators; a number may have a decimal point. Throws on anything else. */
export function parseFormula(text) {
  const s = String(text ?? '').replace(/[\s　]+/g, '').replace(/[（]/g, '(').replace(/[）]/g, ')'); let i = 0;
  if (!s) return { type: 'number', value: 0 };
  const digit = c => c !== undefined && ((c >= '0' && c <= '9') || c === '.');
  function factor() {
    const c = s[i];
    if (c === '-') { i++; return { type: 'negate', of: factor() }; }
    if (c === '+') { i++; return factor(); }
    if (c === '(') { i++; const inner = sum(); if (s[i] !== ')') throw new Error('括号不成对'); i++; return inner; }
    if (digit(c)) { let j = i; while (digit(s[j])) j++; const value = Number(s.slice(i, j)); if (!Number.isFinite(value)) throw new Error('数字写法不对'); if (j < s.length && !OPERATORS.includes(s[j])) throw new Error('数字后面缺少运算符'); i = j; return { type: 'number', value }; }
    let j = i; while (j < s.length && !OPERATORS.includes(s[j])) j++;
    if (j === i) throw new Error(c === undefined ? '公式不完整' : '这里不能是“' + c + '”'); const name = s.slice(i, j); i = j; return { type: 'name', name };
  }
  function product() { let left = factor(); while (s[i] === '*' || s[i] === '/') { const op = s[i++]; left = { type: op, left, right: factor() }; } return left; }
  function sum() { let left = product(); while (s[i] === '+' || s[i] === '-') { const op = s[i++]; left = { type: op, left, right: product() }; } return left; }
  const tree = sum(); if (i !== s.length) throw new Error('这里不能是“' + s[i] + '”'); return tree;
}
export function formulaNames(tree, into = new Set()) { if (tree.type === 'name') into.add(tree.name); for (const key of ['of', 'left', 'right']) if (tree[key]) formulaNames(tree[key], into); return into; }
/** The value of a formula; `value(name)` gives the number of a name. */
export function evaluateFormula(tree, value) {
  switch (tree.type) {
    case 'number': return tree.value;
    case 'name': { const v = value(tree.name); if (!Number.isFinite(v)) throw new Error('尺寸表里没有“' + tree.name + '”'); return v; }
    case 'negate': return -evaluateFormula(tree.of, value);
    case '+': return evaluateFormula(tree.left, value) + evaluateFormula(tree.right, value);
    case '-': return evaluateFormula(tree.left, value) - evaluateFormula(tree.right, value);
    case '*': return evaluateFormula(tree.left, value) * evaluateFormula(tree.right, value);
    case '/': { const d = evaluateFormula(tree.right, value); if (d === 0) throw new Error('公式里除以了 0'); return evaluateFormula(tree.left, value) / d; }
    default: throw new Error('公式结构不对');
  }
}
