/**
 * Commands of v63 for curves: 定长调曲线 (move a curve point and keep the length), 曲线端矢调整 (turn an end of a curve) and
 * 接角圆顺 (make two lines that are sewn together run on smoothly across the seam). The geometry and what was watched on
 * ET are in curve-tools.mjs; 圆角处理 between curves is line.fillet in cad-command-construct.mjs.
 */
import { number, point, text, object, requireMm, entityOf, changeableLine, round } from './cad-command-kit.mjs';
import { pathLength, nearestOnPath } from './construct-trim.mjs';
import { applyShape } from './cad-command-trim.mjs';
import { movedKeepingLength, turnedEnd, turnTowards, endDirection, smoothedCorner } from './curve-tools.mjs';

const at = q => ({ x: round(q.x), y: round(q.y) });
const endOf = { type: 'string', enum: ['start', 'end'], description: '起点或终点' };
const degreesOf = v => round(Math.atan2(v.y, v.x) * 180 / Math.PI);
function curveOf(project, id, what) { const { entity } = changeableLine(project, id, what); if (!entity.curve) throw new Error('“' + entity.name + '”不是曲线。'); return entity; }
function chosenEnd(entity, end, near) {
  if (end && near) throw new Error('曲线的一端请用 end 或 near 说明其中一种。');
  if (end) return end;
  if (near) { const found = nearestOnPath(entity, near); return found.at <= found.total / 2 ? 'start' : 'end'; }
  throw new Error('需要说明转曲线的哪一端：用 end，或用 near 给出靠近那一端的点。');
}
const index = (description, minimum = 0) => ({ type: 'integer', minimum, maximum: 200, description });

export const curveCommands = [
  { type: 'curve.moveKeepLength', title: '定长调曲线', description: '移动曲线上的一个曲线点，同时保持曲线的长度不变（ET 的定长调曲线）。index 是要移动的曲线点编号（从 0 数起，两个端点不能用这条命令移动），to 是它的新位置。两个端点和 fixedIndices 里的点不动；其余曲线点沿两端连线的垂直方向一起移动，移动量从被移动的点向两端线性减小到 0（按移动以后相邻曲线点之间的直线距离一段段加起来算）；固定点只是不动，其余点的分摊照样按没有固定点时算；被移动的点某一侧没有可以跟着动的点时，只靠另一侧补。总量正好使曲线长度回到原来（相差不超过 0.001 毫米），往哪一边移由补回长度决定，取移动最少的那一种。跟着移动的量常常比被移动的点移得还多，结果里 largestFollowMm 是其余曲线点里移得最多的距离；曲线点少、固定点多或移得太远时可能补不回原长，命令会报错并说明还差多少。除了两端、被移动的点和固定点，至少还要有一个曲线点。裁片的轮廓线不能用，裁片里面的线可以。',
    input_schema: object({ entityId: text(120, '曲线'), index: index('要移动的曲线点编号', 1), to: point('这个曲线点的新位置'), fixedIndices: { type: 'array', description: '不动的曲线点编号', items: index('曲线点编号'), maxItems: 118 } }, ['entityId', 'index', 'to']),
    run(project, p) {
      requireMm(project); const entity = curveOf(project, p.entityId, '曲线'), before = pathLength(entity), result = movedKeepingLength(entity, p.index, p.to, p.fixedIndices || []);
      applyShape(entity, result);
      return { summary: { operation: 'curve.moveKeepLength', entityId: entity.id, name: entity.name, index: p.index, to: at(p.to), moved: result.moved, largestFollowMm: round(result.largestFollowMm), points: result.points, fixed: (p.fixedIndices || []).length, beforeMm: round(before), afterMm: round(pathLength(entity)) } };
    } },
  { type: 'curve.turnEnd', title: '曲线端矢调整', description: '转动曲线一端的方向（ET 的曲线端矢调整）：两个端点都不动，中间的曲线点绕这一端转动，离这一端越近转得越多。规则与 ET 相同：曲线点 Q 移向 Q 绕这一端转过 turn 之后的位置，移过去的比例是 |Q-另一端|² ÷ (|Q-这一端|² + |Q-另一端|²)。end 说明转哪一端，也可以用 near 给出靠近那一端的点（两个都不给时报错）。turn 是这条规则里的转角，度，逆时针为正；因为各曲线点只按比例移向转过以后的位置，端部方向实际转过的角度与 turn 接近，但不一定正好相等，结果里有转前、转后的端部方向。也可以改给 toward：按这一端现在的方向（取靠近这一端的 3 毫米曲线）到这个点的方向算出 turn，再按同样的规则转，转完以后这一端大致朝向这个点。turn 和 toward 要给且只给一个，否则报错。曲线至少要有 3 个曲线点。裁片的轮廓线不能用，裁片里面的线可以。',
    input_schema: object({ entityId: text(120, '曲线'), end: endOf, near: point('靠近要转的那一端的点'), turn: number(-179, 179, '转角，度，逆时针为正'), toward: point('让这一端朝向这个点') }, ['entityId']),
    run(project, p) {
      requireMm(project); const entity = curveOf(project, p.entityId, '曲线'), end = chosenEnd(entity, p.end, p.near);
      if ((p.turn === undefined) === (p.toward === undefined)) throw new Error('转角 turn 和朝向点 toward 要给其中一个。');
      const degrees = p.turn ?? turnTowards(entity, end, p.toward);
      if (!(Math.abs(degrees) > 1e-6)) throw new Error('转角为零，曲线不会变。');
      const before = endDirection(entity, end), result = turnedEnd(entity, end, degrees); applyShape(entity, result);
      return { summary: { operation: 'curve.turnEnd', entityId: entity.id, name: entity.name, end, turnDeg: round(degrees), directionBeforeDeg: degreesOf(before), directionAfterDeg: degreesOf(endDirection(entity, end)), points: result.points, lengthMm: round(pathLength(entity)) } };
    } },
  { type: 'curve.smoothCorner', title: '接角圆顺', description: '把要缝在一起的两条线在缝合处接顺（ET 的接角圆顺），例如前后片的下摆在侧缝处、前后袖窿在肩缝处。firstEntityId、secondEntityId 是要接顺的两条曲线，firstSeamId、secondSeamId 是它们各自的缝合线，每条缝合线要与它的曲线首尾相接（接点就是要接顺的地方）。第二条曲线连同它的缝合线绕接点转动、平移，使第二条缝合线落在第一条上（接点对接点、方向对方向），这时两条曲线像缝好以后那样在接点处连着，下面叫接起来的样子。然后二选一（mode 和 moves 要给且只给一个，否则报错）：mode 为 square 时两条曲线在接点那一端都改成与缝合线垂直，接起来就顺成一条；mode 为 smooth 时两条曲线在接点那一端都转到它们的平均方向。两种都按曲线端矢调整的规则转动接点那一端，所以两条曲线都至少要有 3 个曲线点，接点和另一端都不动；两条曲线谁做第一条，自动圆顺的结果都一样。或者给 moves 逐个移动曲线点：which 说明是第一条（first）还是第二条（second）曲线，index 是曲线点编号（两端不能动），to 是这个点在接起来的样子里的新位置（与第一条曲线同一个坐标），第二条曲线上的点再按相反的转动放回原处。结果里 bendBeforeDeg、bendAfterDeg 是接起来以后接点处的折角，0 表示顺成一条。缝合线不会被改动。要接顺的曲线不能是裁片的轮廓线，裁片里面的线可以。',
    input_schema: object({ firstEntityId: text(120, '第一条要接顺的曲线'), secondEntityId: text(120, '第二条要接顺的曲线'), firstSeamId: text(120, '第一条曲线的缝合线'), secondSeamId: text(120, '第二条曲线的缝合线'),
      mode: { type: 'string', enum: ['square', 'smooth'], description: 'square 两条曲线都与缝合线垂直地接到接点；smooth 顺成两条曲线的平均方向' },
      moves: { type: 'array', description: '要移动的曲线点', minItems: 1, maxItems: 40, items: object({ which: { type: 'string', enum: ['first', 'second'], description: '第一条还是第二条曲线' }, index: index('曲线点编号', 1), to: point('在接起来的样子里的新位置') }, ['which', 'index', 'to']) } },
      ['firstEntityId', 'secondEntityId', 'firstSeamId', 'secondSeamId']),
    run(project, p) {
      requireMm(project); const ids = [p.firstEntityId, p.secondEntityId, p.firstSeamId, p.secondSeamId];
      if (new Set(ids).size !== 4) throw new Error('两条要接顺的曲线和两条缝合线须是四条不同的线。');
      if ((p.mode === undefined) === (p.moves === undefined)) throw new Error('mode（自动圆顺）和 moves（移动曲线点）要给其中一个。');
      const first = curveOf(project, p.firstEntityId, '第一条要接顺的曲线'), second = curveOf(project, p.secondEntityId, '第二条要接顺的曲线');
      const seam = (id, what) => { const entity = entityOf(project, id); if (entity.type === 'text') throw new Error(what + '不能是文字。'); return entity; };
      const result = smoothedCorner(first, second, seam(p.firstSeamId, '第一条缝合线'), seam(p.secondSeamId, '第二条缝合线'), { mode: p.mode, moves: p.moves });
      if (result.first) applyShape(first, result.first); if (result.second) applyShape(second, result.second);
      return { summary: { operation: 'curve.smoothCorner', first: first.name, second: second.name, ...(p.mode ? { mode: p.mode, turnsDeg: [round(result.first.degrees), round(result.second.degrees)] } : { moved: p.moves.length }),
        joint: at(result.view.joint), seamTurnDeg: round(result.view.turn * 180 / Math.PI), bendBeforeDeg: round(result.bendBefore), bendAfterDeg: round(result.bendAfter), joinedLengthMm: round(pathLength(first) + pathLength(second)) } };
    } },
];
