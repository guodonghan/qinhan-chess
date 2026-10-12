// 校验脚本：新引擎 vs 旧规则实现 一致性 + 新旧引擎强度对比
const fs = require('fs'), path = require('path'), vm = require('vm');
const log = (...a) => fs.writeSync(1, a.join(' ') + '\n');
const ROOT = 'D:/code/qinhan-chess';
(()=>{const h=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');vm.runInThisContext(h.slice(h.indexOf('const COLS=9,ROWS=10,CELL=56'),h.indexOf('// 模式策略')),{filename:'core.js'});})();
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', 'ai-engine.js'), 'utf8'), { filename: 'ai-engine.js' });
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', 'ai-tactics.js'), 'utf8'), { filename: 't.js' });
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', 'ai-search.js'), 'utf8'), { filename: 's.js' });
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', 'ai-tt.js'), 'utf8'), { filename: 'tt.js' });
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', 'ai-evaluate.js'), 'utf8'), { filename: 'e.js' });
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', 'ai-opening.js'), 'utf8'), { filename: 'o.js' });
Search.install(); TT.init(); EvalEnhancer.install(); globalThis.Opening.install();
const I = AIEngine._internals;
const f = m => m ? `(${m.fr},${m.fc})->(${m.tr},${m.tc})` : '--';
const nm = lv => AIEngine.LEVELS[lv].name;

// ---------- 1. 一致性 fuzz ----------
log('=== 1. 新引擎 vs 旧规则实现（随机对局 fuzz，验证规则没改坏）===');
let posChecked = 0, moveMismatch = 0, checkMismatch = 0, totalMoves = 0;
let seed = 20261012;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let game = 0; game < 40; game++) {
  const b = new ChessBoard(); b.reset();
  for (let step = 0; step < 60; step++) {
    posChecked++;
    I.loadFromBoard(b, null);
    const oldSet = new Set();
    for (const p of b.getPieces(b.turn))
      for (const m of b.getLegalMoves(p.row, p.col)) oldSet.add(`${p.row},${p.col},${m.row},${m.col}`);
    const newSet = new Set();
    for (const m of I.allLegal()) {
      const fr = m >> 7, to = m & 127;
      newSet.add(`${(fr / 9) | 0},${fr % 9},${(to / 9) | 0},${to % 9}`);
    }
    totalMoves += oldSet.size;
    if (oldSet.size !== newSet.size || [...oldSet].some(x => !newSet.has(x))) {
      moveMismatch++;
      if (moveMismatch <= 3) {
        log(`  x 着法不一致(对局${game} 步${step})`);
        log(`    旧: ${[...oldSet].sort().join(' | ')}`);
        log(`    新: ${[...newSet].sort().join(' | ')}`);
      }
    }
    for (const side of [0, 1]) {
      I.loadFromBoard(b, null);
      if (b.inCheck(side) !== I.isChecked(side)) {
        checkMismatch++;
        if (checkMismatch <= 5) log(`  x inCheck 不一致 side=${side}`);
      }
    }
    const all = [...oldSet];
    if (!all.length) break;
    const pick = all[Math.floor(rnd() * all.length)].split(',').map(Number);
    b.move(pick[0], pick[1], pick[2], pick[3]);
  }
}
log(`  局面数=${posChecked} 比对着法=${totalMoves} 着法不一致=${moveMismatch} 被将判定不一致=${checkMismatch}`);
log(moveMismatch === 0 && checkMismatch === 0 ? '  ✅ 完全一致 —— 走棋规则一个字都没改' : '  ❌ 存在不一致');

// ---------- 2. 合法开局 ----------
function buildOpening() {
  const b = new ChessBoard(); b.reset();
  const seq = [[7, 7, 7, 4], [0, 7, 2, 6], [9, 7, 7, 6], [0, 1, 2, 2],
               [9, 8, 9, 7], [0, 0, 0, 1], [6, 2, 5, 2]];
  for (const [a, c, d, e] of seq) {
    if (!b.getLegalMoves(a, c).some(m => m.row === d && m.col === e)) throw new Error(`构造开局失败: ${a},${c}->${d},${e}`);
    b.move(a, c, d, e);
  }
  return b;
}
const quiet = (() => {   // 让引擎自己对走 12 手，得到一个平静的中局局面
  const b = new ChessBoard(); b.reset();
  for (let i = 0; i < 12; i++) {
    const r = AIEngine.pickMove(b, { level: 2, timeLimit: 600, seed: 42 + i });
    if (!r) break;
    b.move(r.fr, r.fc, r.tr, r.tc);
  }
  return b;
})();

log('\n=== 2. 新旧引擎同局面对比（游戏里"高手"档）===');
{
  const b1 = buildOpening(), b2 = buildOpening();
  // 旧引擎
  const t0 = Date.now();
  const ai = new ChessAI(b1, AI_DEPTH[2]);
  const mvOld = ai.search(8000);
  const dtOld = Date.now() - t0;
  // 新引擎
  const t1 = Date.now();
  const r = AIEngine.pickMove(b2, { level: 2, timeLimit: 8000, seed: 1 });
  const dtNew = Date.now() - t1;
  log(`  旧引擎(高手) → 用时 ${dtOld}ms  着法 ${f(mvOld)}   （实质深度 1，等于没搜）`);
  log(`  新引擎(高手) → 用时 ${dtNew}ms  着法 ${f(r)}  实到深度 ${r.depth}  节点 ${r.nodes}`);
}

log('\n=== 3. 各难度实际能搜多深（都是合法开局局面）===');
for (let lv = 0; lv < 5; lv++) {
  const b = buildOpening();
  const r = AIEngine.pickMove(b, { level: lv, timeLimit: 8000, seed: 1 });
  const p = AIEngine.LEVELS[lv];
  log(`  ${p.name.padEnd(3, '　')} 上限d${p.depth} → 实到深度=${r.depth} 用时=${r.ms}ms 节点=${r.nodes} 速度=${(r.nodes / Math.max(1, r.ms) * 1000 / 1000).toFixed(0)}k/s 着法=${f(r)}`);
}
log('  （旧引擎在相同 8 秒里只能"走完"深度 1，所以才四个难度一模一样）');

// ---------- 4. 战术 ----------
function mk(list, turn) {
  const b = new ChessBoard(); b.board = Array(10).fill(null).map(() => Array(9).fill(null));
  for (const [r, c, t, s] of list) b.board[r][c] = { type: t, side: s };
  b.turn = turn; b.moveHistory = []; return b;
}
const ask = (lv, list, turn, ms) => AIEngine.pickMove(mk(list, turn), { level: lv, timeLimit: ms || 3000, seed: 7 });
log('\n=== 4. 战术测试 ===');
{
  const P = [[9, 4, 0, 0], [0, 4, 0, 1], [5, 4, 4, 0], [5, 0, 4, 1], [9, 0, 1, 0], [0, 0, 1, 1]];
  for (const lv of [2, 4]) {
    const r = ask(lv, P, 1);
    log(`  [${nm(lv)}] 对方白送车 → ${f(r)} ${r.tr === 5 && r.tc === 4 ? '✅ 吃掉' : '❌ 不吃了'}`);
  }
}
{
  const P = [[9, 4, 0, 0], [0, 4, 0, 1], [4, 4, 6, 0], [3, 4, 3, 1], [4, 8, 4, 0], [0, 0, 4, 1]];
  for (const lv of [2, 4]) {
    const r = ask(lv, P, 1);
    log(`  [${nm(lv)}] 马被"有保护的兵"捉 → ${f(r)} ${!(r.tr === 4 && r.tc === 4) ? '✅ 躲开' : '❌ 白送马'}`);
  }
}
{
  const P = [[9, 4, 0, 0], [0, 4, 0, 1], [2, 4, 4, 0], [0, 3, 1, 1], [0, 0, 4, 1], [4, 4, 6, 0]];
  for (const lv of [2, 4]) {
    const r = ask(lv, P, 1);
    const b = mk(P, 1); b.move(r.fr, r.fc, r.tr, r.tc);
    log(`  [${nm(lv)}] 正被将军 → ${f(r)} ${!b.inCheck(1) ? '✅ 解将' : '❌ 没解将'}`);
  }
}
{
  const P = [[9, 4, 0, 0], [0, 4, 0, 1], [2, 4, 5, 1], [7, 4, 5, 0], [0, 0, 4, 1], [9, 8, 4, 0]];
  for (const lv of [0, 2, 4]) {
    const r = ask(lv, P, 1);
    log(`  [${nm(lv)}] 可一步吃将 → ${f(r)} ${r.tr === 9 && r.tc === 4 ? '✅ 找到' : '❌ 漏了'} 分=${r.score}`);
  }
}
{
  const P = [[9, 4, 0, 0], [0, 4, 0, 1], [4, 4, 6, 0], [1, 4, 4, 1], [4, 8, 4, 0], [0, 0, 4, 1]];
  for (const lv of [0, 2, 4]) {
    const r = ask(lv, P, 1);
    const ate = (r.tr === 4 && r.tc === 4);
    log(`  [${nm(lv)}] 毒饵兵(吃了会被反吃) → ${f(r)} ${ate ? '⚠ 上钩' : '✅ 没上当'} 分=${r.score} 深度=${r.depth}`);
  }
}

// ---------- 5. 难度区分 ----------
log('\n=== 5. 平静中局下各难度给出的着法（每档 6 个随机种子）===');
{
  for (let lv = 0; lv < 5; lv++) {
    const outs = [];
    for (let k = 0; k < 6; k++) {
      const b = quiet.clone();
      const r = AIEngine.pickMove(b, { level: lv, timeLimit: 8000, seed: 100 + k * 37 });
      outs.push(`${f(r)}/d${r.depth}`);
    }
    const uniq = [...new Set(outs)];
    log(`  ${nm(lv)}: 出现 ${uniq.length} 种 → ${uniq.join('  ')}`);
  }
}

// ---------- 6. 强度验证 ----------
log('\n=== 6. 自对弈强度验证（关掉开局库，纯比搜索强度）===');
globalThis.Opening.lookup = () => null;
function play(lvRed, lvBlack, maxPlies, msRed, msBlack) {
  const b = new ChessBoard(); b.reset();
  for (let p = 0; p < maxPlies; p++) {
    const turn = b.turn;
    const r = AIEngine.pickMove(b, { level: turn === 0 ? lvRed : lvBlack, timeLimit: turn === 0 ? msRed : msBlack, seed: 11 + p });
    if (!r) return { plies: p, result: `${turn === 0 ? '红' : '黑'}方无着法`, b };
    const cap = b.board[r.tr][r.tc];
    b.move(r.fr, r.fc, r.tr, r.tc);
    if (cap && (cap.type === 0 || cap.innerKing || cap.lordKing)) return { plies: p + 1, result: `${cap.side === 0 ? '黑' : '红'}方吃掉将帅取胜`, b };
    if (b.isCheckmate()) return { plies: p + 1, result: `${b.turn === 0 ? '黑' : '红'}方将死取胜`, b };
  }
  return { plies: maxPlies, result: '未分胜负', b };
}
const mat = (b, s) => { let v = 0; for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) { const q = b.board[r][c]; if (q && q.side === s && (q.type === 4 || q.type === 5 || q.type === 3)) v += q.type === 4 ? 5 : q.type === 5 ? 3 : 2; } return v; };
const ladder = [
  { hi: 4, lo: 0, msHi: 3000, msLo: 300, plies: 56 },
  { hi: 4, lo: 2, msHi: 3000, msLo: 800, plies: 56 },
];
for (const { hi, lo, msHi, msLo, plies } of ladder) {
  const g = play(hi, lo, plies, msHi, msLo);   // 强方执红
  log(`  ${nm(hi)}(红·${msHi}ms) vs ${nm(lo)}(黑·${msLo}ms): ${g.plies}手 → ${g.result}`);
  log(`      剩余主力量  强方(红)=${mat(g.b, 0)}   弱方(黑)=${mat(g.b, 1)}`);
}

// ---------- 7. 新版 vs 旧版 ----------
log('\n=== 7. 直接对决：新版"高手"(黑) vs 旧版"高手"(红) ===');
{
  const b = new ChessBoard(); b.reset();
  let plies = 0, result = '未分胜负';
  for (; plies < 60; plies++) {
    let mv;
    if (b.turn === 0) {
      const old = new ChessAI(b, AI_DEPTH[2]);
      mv = old.search(700);
    } else {
      mv = AIEngine.pickMove(b, { level: 2, timeLimit: 700, seed: 3 + plies });
    }
    if (!mv) { result = `${b.turn === 0 ? '红' : '黑'}方无着法`; break; }
    const cap = b.board[mv.tr][mv.tc];
    b.move(mv.fr, mv.fc, mv.tr, mv.tc);
    if (cap && (cap.type === 0 || cap.innerKing || cap.lordKing)) { result = `${cap.side === 0 ? '黑' : '红'}方吃掉将帅取胜`; plies++; break; }
    if (b.isCheckmate()) { result = `${b.turn === 0 ? '黑' : '红'}方将死取胜`; plies++; break; }
  }
  log(`  ${plies}手 → ${result}；剩余主力量 红(旧) = ${mat(b, 0)}  黑(新) = ${mat(b, 1)}`);
}
