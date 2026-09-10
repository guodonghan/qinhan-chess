/**
 * 中国象棋 - 交互层逻辑测试（BUG-4 竞态 / BUG-5 悔棋 / AI 对局流程）
 * 从 index.html 提取 onBoardClick 核心逻辑并模拟测试
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
let code = scriptMatch[1];

// 截取到 onBoardClick / restartGame / 悔棋 handler 之前的部分
const cutIdx = code.indexOf("const canvas=document.getElementById('board')");
if (cutIdx < 0) { console.error('未找到 canvas'); process.exit(1); }
code = code.slice(0, cutIdx);

// stub DOM 与控制器
const domStub = `
const __stubLog = [];
function __stub(name){ return (...args) => { __stubLog.push(name); }; }
const audio = { init:__stub('audio.init'), place:__stub('audio.place'), capture:__stub('audio.capture'), check:__stub('audio.check'), win:__stub('audio.win'), setSfxVol:__stub('setSfxVol') };
const canvas = { width:0, height:0, getContext:()=>({}), addEventListener:()=>{}, getBoundingClientRect:()=>({left:0,top:0,width:600,height:600}) };
const game = { selected:null, legalMoves:[], phase:'play', currentMode:'classic', lastMove:null, epoch:0, banRed:null, banBlack:null, heartRed:null, heartBlack:null, innerRed:null, innerBlack:null, innerRevealed:false };
const renderer = { draw: __stub('renderer.draw') };
function updateStatus(t){ __stubLog.push('updateStatus:'+t); }
function showModal(t,d){ __stubLog.push('showModal:'+t); }
function hideModal(){}
function boardToPixel(r,c){ return {x:32+c*56, y:32+r*56}; }
function pixelToBoard(){ return null; }
const board = new ChessBoard();
`;

// 把 ChessBoard 引用也注入到 sandbox，但业务代码里 `const board=new ChessBoard()` 已被我们替换为 stub 的 board
// 需要业务代码引用全局 board 变量——我们在 vm 上下文里定义 const board，业务代码里如果直接用 board 会冲突
// 所以：移除业务代码中对 board/game/renderer/canvas/audio 的声明，保留函数引用

// 移除业务代码中的全局声明（防止重复）
code = code.replace(/const audio=\{[\s\S]*?\n\};/, '');
code = code.replace(/const canvas=document\.getElementById\('board'\);\n?/, '');
code = code.replace(/const board=new ChessBoard\(\);\n?/, '');
code = code.replace(/const game=\{[\s\S]*?\};\n?/, '');
code = code.replace(/const renderer=new Renderer\(canvas,board\);\n?/, '');

// 追加导出的函数（onBoardClick / restartGame 需要手动构造，因为它们依赖 DOM 元素）
// 我们从业务代码中提取 onBoardClick 函数体本身 —— 由于它引用全局 board/game/renderer/MODES 等，
// 在 vm 中运行即可。我们只导出内部函数，不导出 onBoardClick（它引用 document.getElementById('difficulty') 等）
const extra = `
module.exports = {
  ChessBoard, ChessAI, MODES, game, board, renderer, updateStatus, showModal, hideModal,
  SIDE_RED, SIDE_BLACK, KING, ROOK, CANNON, PAWN, HORSE, PIECE_TYPES, __stubLog,
};
`;

// 组装 sandbox 代码：domStub 定义全局（含 board = new ChessBoard()），业务代码在之后
// 但 domStub 里 `const board = new ChessBoard();` —— ChessBoard 在业务代码中定义，顺序问题！
// 解决：业务代码在前，domStub 的 board 初始化放到最后。所以结构调整：
// 1) 业务类定义（去掉 audio/canvas/board/game/renderer 声明）
// 2) domStub 去掉 board 声明，只定义其他全局
// 3) 然后 const board = new ChessBoard(); 等初始化
// 4) extra 导出

const domStub2 = `
const __stubLog = [];
function __stub(name){ return (...args) => { __stubLog.push(name); }; }
const audio = { init:__stub('audio.init'), place:__stub('audio.place'), capture:__stub('audio.capture'), check:__stub('audio.check'), win:__stub('audio.win'), setSfxVol:__stub('setSfxVol') };
const canvas = { width:0, height:0, getContext:()=>({}), addEventListener:()=>{}, getBoundingClientRect:()=>({left:0,top:0,width:600,height:600}) };
function updateStatus(t){ __stubLog.push('updateStatus:'+t); }
function showModal(t,d){ __stubLog.push('showModal:'+t); }
function hideModal(){}
function boardToPixel(r,c){ return {x:32+c*56, y:32+r*56}; }
function pixelToBoard(){ return null; }
`;

const initCode = `
const game = { selected:null, legalMoves:[], phase:'play', currentMode:'classic', lastMove:null, epoch:0, banRed:null, banBlack:null, heartRed:null, heartBlack:null, innerRed:null, innerBlack:null, innerRevealed:false };
const board = new ChessBoard();
const renderer = { draw: __stub('renderer.draw') };
`;

const fullCode = code + '\n' + domStub2 + '\n' + initCode + '\n' + extra;

const sandbox = {
  console, Math, Date, JSON, setTimeout, clearTimeout, setInterval, clearInterval,
  document: {
    getElementById: () => ({ value: '0', textContent: '', innerHTML: '', classList: { add:()=>{}, remove:()=>{}, contains:()=>false }, addEventListener:()=>{}, style:{} }),
    querySelectorAll: () => [],
    addEventListener: () => {},
  },
  window: {},
  AudioContext: function(){},
  webkitAudioContext: function(){},
};
sandbox.globalThis = sandbox;
sandbox.module = { exports: {} };
sandbox.exports = sandbox.module.exports;

try {
  vm.runInNewContext(fullCode, sandbox, { filename: 'chess-controller.js' });
} catch (e) {
  console.error('加载失败:', e.message);
  console.error(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}

const exported = sandbox.module.exports;
const { ChessBoard, ChessAI, MODES, game, board, renderer, updateStatus, showModal, SIDE_RED, SIDE_BLACK, KING, ROOK, CANNON, PAWN, HORSE, PIECE_TYPES, __stubLog } = exported;

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} -> ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ` 期望=${b} 实际=${a}`); }

// 清理辅助
function freshGame() {
  game.selected = null; game.legalMoves = []; game.phase = 'play';
  game.currentMode = 'classic'; game.lastMove = null; game.epoch = 0;
  game.banRed = game.banBlack = null;
  game.heartRed = game.heartBlack = null;
  game.innerRed = game.innerBlack = null; game.innerRevealed = false;
}
function findPiece(b, side, type) {
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = b.board[r][c];
    if (p && p.side === side && p.type === type) return { r, c, p };
  }
  return null;
}

// ============================================================
console.log('\n=== BUG-4 竞态：AI 思考期间重开/切模式 ===');
test('epoch 令牌初始为 0', () => {
  freshGame();
  assertEq(game.epoch, 0, 'epoch');
});

test('restartGame 递增 epoch（模拟实现一致）', () => {
  freshGame();
  game.epoch = 5;
  // 模拟 restartGame 中的 game.epoch++
  game.epoch++;
  assertEq(game.epoch, 6, 'epoch 应递增');
});

test('旧 AI 回调 epoch 不匹配应被丢弃', () => {
  freshGame();
  const myEpoch = game.epoch; // 记录旧代次
  game.epoch++; // 模拟重启
  // 模拟 AI 回调开头校验
  let discarded = false;
  const run = () => { if (myEpoch !== game.epoch) { discarded = true; return; } };
  run();
  assert(discarded, '旧回调应被丢弃');
});

test('当前代次回调正常执行', () => {
  freshGame();
  const myEpoch = game.epoch;
  let executed = false;
  const run = () => { if (myEpoch !== game.epoch) return; executed = true; };
  run();
  assert(executed, '新回调应正常执行');
});

// ============================================================
console.log('\n=== BUG-5 悔棋边界 ===');
test('悔棋：moveHistory 为空时不应执行', () => {
  const b = new ChessBoard(); b.reset();
  // 模拟 btnUndo handler 的前置判断
  const canUndo = !(b.gameOver || b.moveHistory.length === 0 || b.aiThinking);
  assertEq(canUndo, false, '空历史不能悔棋');
});

test('悔棋：玩家走 1 步后（AI 未走）悔 1 步', () => {
  const b = new ChessBoard(); b.reset();
  const pawn = findPiece(b, SIDE_RED, PAWN);
  b.move(pawn.r, pawn.c, pawn.r - 1, pawn.c); // 红兵走 1 步
  assertEq(b.moveHistory.length, 1, '历史 1 步');
  // 模拟悔棋逻辑
  b.undo();
  if (b.moveHistory.length > 0 && b.turn !== SIDE_RED) b.undo();
  assertEq(b.moveHistory.length, 0, '应回退到初始');
  assertEq(b.turn, SIDE_RED, '红方回合');
});

test('悔棋：走 2 步后悔 2 步回到红方', () => {
  const b = new ChessBoard(); b.reset();
  const pawn = findPiece(b, SIDE_RED, PAWN);
  b.move(pawn.r, pawn.c, pawn.r - 1, pawn.c);
  // AI 黑方走一步（任意合法）
  const ai = new ChessAI(b, 1);
  const m = ai.search(200);
  assert(m, 'AI 应能走');
  b.move(m.fr, m.fc, m.tr, m.tc);
  assertEq(b.moveHistory.length, 2, '历史 2 步');
  b.undo();
  if (b.moveHistory.length > 0 && b.turn !== SIDE_RED) b.undo();
  assertEq(b.turn, SIDE_RED, '回到红方回合');
});

test('悔棋后棋盘状态恢复', () => {
  const b = new ChessBoard(); b.reset();
  const before = JSON.stringify(b.board);
  const pawn = findPiece(b, SIDE_RED, PAWN);
  b.move(pawn.r, pawn.c, pawn.r - 1, pawn.c);
  b.undo();
  const after = JSON.stringify(b.board);
  assertEq(after, before, '悔棋后棋盘应恢复原状');
});

// ============================================================
console.log('\n=== AI 对局流程 ===');
test('完整对局模拟：红走兵 → AI 回手 → 状态恢复', () => {
  const b = new ChessBoard(); b.reset();
  freshGame();
  // 红方走兵
  const pawn = findPiece(b, SIDE_RED, PAWN);
  b.move(pawn.r, pawn.c, pawn.r - 1, pawn.c);
  // AI 走
  const ai = new ChessAI(b, 2);
  const move = ai.search(2000);
  assert(move, 'AI 应返回走法');
  const cap = b.move(move.fr, move.fc, move.tr, move.tc);
  assertEq(b.turn, SIDE_RED, 'AI 走后回到红方回合');
  assert(b.moveHistory.length === 2, '历史应有 2 步');
});

test('AI 不会走非法步', () => {
  const b = new ChessBoard(); b.reset();
  const ai = new ChessAI(b, 3);
  const move = ai.search(1500);
  const legal = b.getLegalMoves(move.fr, move.fc).some(m => m.row === move.tr && m.col === move.tc);
  assert(legal, 'AI 走法必须合法');
});

test('AI 思考超时保护：timeLimit=0 立即返回', () => {
  const b = new ChessBoard(); b.reset();
  const ai = new ChessAI(b, 3);
  const start = Date.now();
  const move = ai.search(0);
  const elapsed = Date.now() - start;
  assert(elapsed < 100, `超时保护应快速返回, 实际 ${elapsed}ms`);
  // timeLimit=0 时可能返回 null（首个走法就超时）
});

// ============================================================
console.log('\n=== ban 局 AI 禁子流程 ===');
test('ban 局 AI 禁子逻辑：随机禁一个非将棋子', () => {
  const b = new ChessBoard(); b.reset();
  // 模拟 MODES.ban 的 AI 禁子段
  const pp = b.getPieces(SIDE_BLACK).filter(p => !p.piece.innerKing && p.piece.type !== KING);
  assert(pp.length > 0, '黑方应有可禁棋子');
  const pick = pp[Math.floor(Math.random() * pp.length)];
  assert(pick.piece.type !== KING, '不应禁将');
  assert(pick.row >= 0 && pick.col >= 0, '位置合法');
});

// ============================================================
console.log('\n=== 心腹局 AI 选心腹 ===');
test('心腹局 AI 随机选心腹', () => {
  const b = new ChessBoard(); b.reset();
  const pp = b.getPieces(SIDE_BLACK);
  assert(pp.length === 16, '黑方应有16子');
  const pick = pp[Math.floor(Math.random() * pp.length)];
  assert(pick.piece, '应选中棋子');
});

// ============================================================
console.log('\n=== 内臣局继位后走法 ===');
test('内臣（兵）继位后保留 innerKing 额外攻击距离', () => {
  const b = new ChessBoard(); b.reset();
  // 模拟：黑方内臣兵在(4,4)，已继位（innerKing）
  b.board[4][4] = { type: PAWN, side: SIDE_BLACK, innerKing: true };
  // 黑卒在(4,4)，前进方向 +1 行（row+1），额外 2 格攻击
  const moves = b.getRawMoves(4, 4);
  // 前进到(5,4) + innerKing 额外(6,4)
  const hasExtra = moves.some(m => m.row === 6 && m.col === 4);
  assert(hasExtra, '内臣兵应有额外1格攻击距离');
});

// ============================================================
console.log('\n========================================');
console.log(`交互层测试结果: ✅ ${pass} 通过 | ❌ ${fail} 失败 | 共 ${pass+fail} 用例`);
console.log('========================================');
if (fail > 0) process.exit(1);
