/**
 * 中国象棋 - 核心逻辑单元测试
 * 提取 index.html 中的 <script>，stub 掉 DOM 依赖，纯逻辑测试
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error('未找到 script'); process.exit(1); }
let code = scriptMatch[1];

// ---- stub DOM 依赖 ----
const domStub = `
const __stubLog = [];
function __stub(name){ return (...args) => { __stubLog.push(name + ':' + JSON.stringify(args)); }; }
const audio = { init:__stub('audio.init'), place:__stub('audio.place'), capture:__stub('audio.capture'), check:__stub('audio.check'), win:__stub('audio.win'), setSfxVol:__stub('setSfxVol') };
const canvas = { width:0, height:0, getContext:()=>({ fillRect:()=>{}, beginPath:()=>{}, moveTo:()=>{}, lineTo:()=>{}, stroke:()=>{}, arc:()=>{}, fill:()=>{}, strokeRect:()=>{}, fillText:()=>{}, save:()=>{}, restore:()=>{}, setTransform:()=>{}, createRadialGradient:()=>({addColorStop:()=>{}}), strokeStyle:'', fillStyle:'', lineWidth:1, font:'', textAlign:'', textBaseline:'', shadowColor:'', shadowBlur:0, shadowOffsetY:0 }), addEventListener:()=>{}, getBoundingClientRect:()=>({left:0,top:0,width:600,height:600}) };
let __lastBoard = null;
function setTestBoard(b){ __lastBoard = b; }
const game = { selected:null, legalMoves:[], phase:'play', currentMode:'classic', lastMove:null, epoch:0, banRed:null, banBlack:null, heartRed:null, heartBlack:null, innerRed:null, innerBlack:null, innerRevealed:false };
const renderer = { draw: () => {}, board: null };
function boardToPixelStub(r,c){ return {x:32+c*56, y:32+r*56}; }
function pixelToBoardStub(){ return null; }
const board = { board:null, turn:0, moveHistory:[], gameOver:false, aiThinking:false, selected:null, legalMoves:[], lastMove:null };
function updateStatus(t){ __stubLog.push('updateStatus:'+t); }
function showModal(t,d,i,b,cb){ __stubLog.push('showModal:'+t+'|'+d); }
function hideModal(){}
`;

// 移除原 DOM 初始化/事件绑定段（从 "const canvas=" 到末尾），保留类与模式定义
const cutIdx = code.indexOf("const canvas=document.getElementById('board')");
if (cutIdx < 0) { console.error('未找到 canvas 初始化位置'); process.exit(1); }
code = code.slice(0, cutIdx);

// 移除原代码中会与 stub 冲突的全局声明：audio / canvas / board / game / renderer
code = code.replace(/const audio=\{[\s\S]*?\n\};/, '');           // audio 对象
code = code.replace(/const canvas=document\.getElementById\('board'\);\n?/, '');
code = code.replace(/const board=new ChessBoard\(\);\n?/, '');
code = code.replace(/const game=\{[\s\S]*?\};\n?/, '');            // game 对象
code = code.replace(/const renderer=new Renderer\(canvas,board\);\n?/, '');

code = code + `
module.exports = { ChessBoard, ChessAI, MODES, SIDE_RED, SIDE_BLACK, KING, ADVISOR, ELEPHANT, HORSE, ROOK, CANNON, PAWN, PIECE_TYPES, setTestBoard, boardToPixel, game };
`;

// 用 Node 的 vm 模块运行：把 stub 的全局变量注入
const vm = require('vm');
const sandbox = {
  console, Math, Date, JSON, setTimeout, clearTimeout,
  document: {
    getElementById: () => ({ value: '0', textContent: '', innerHTML: '', classList: { add:()=>{}, remove:()=>{}, contains:()=>false }, addEventListener:()=>{}, style:{} }),
    querySelectorAll: () => [],
    addEventListener: () => {},
  },
  window: {},
  AudioContext: function(){},
  webkitAudioContext: function(){},
  __stubLog: [],
};
sandbox.globalThis = sandbox;
sandbox.module = { exports: {} };
sandbox.exports = sandbox.module.exports;

// 先注入 DOM stub 代码，再注入业务代码
const fullCode = domStub + '\n' + code;
try {
  vm.runInNewContext(fullCode, sandbox, { filename: 'chess-logic.js' });
} catch (e) {
  console.error('加载失败:', e.message);
  process.exit(1);
}

const exported = sandbox.module.exports;
const { ChessBoard, ChessAI, MODES, SIDE_RED, SIDE_BLACK, KING, ADVISOR, ELEPHANT, HORSE, ROOK, CANNON, PAWN, PIECE_TYPES, boardToPixel, game } = exported;

// ============================================================
// 测试工具
// ============================================================
let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try {
    fn();
    pass++;
    results.push({ name, status: 'PASS' });
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    results.push({ name, status: 'FAIL', msg: e.message });
    console.log(`  ❌ ${name} -> ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ` 期望=${b} 实际=${a}`); }

function freshBoard() { const b = new ChessBoard(); b.reset(); return b; }

// 找棋子位置
function findPiece(b, side, type) {
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = b.board[r][c];
    if (p && p.side === side && p.type === type) return { r, c, p };
  }
  return null;
}
function countPieces(b) {
  let n = 0;
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) if (b.board[r][c]) n++;
  return n;
}

// ============================================================
// 一、棋盘初始化
// ============================================================
console.log('\n=== 一、棋盘初始化 ===');
test('初始棋子数量 = 32', () => {
  const b = freshBoard();
  assertEq(countPieces(b), 32, '棋子数量');
});
test('红方先行', () => {
  const b = freshBoard();
  assertEq(b.turn, SIDE_RED, 'turn');
});
test('双方将帅位置正确', () => {
  const b = freshBoard();
  const rk = findPiece(b, SIDE_RED, KING), bk = findPiece(b, SIDE_BLACK, KING);
  assert(rk && rk.r === 9 && rk.c === 4, '红帅应在(9,4)');
  assert(bk && bk.r === 0 && bk.c === 4, '黑将应在(0,4)');
});
test('兵卒位置正确', () => {
  const b = freshBoard();
  const redPawn = findPiece(b, SIDE_RED, PAWN);
  assert(redPawn && redPawn.r === 6, '红兵应在第6行');
  const blackPawn = findPiece(b, SIDE_BLACK, PAWN);
  assert(blackPawn && blackPawn.r === 3, '黑卒应在第3行');
});
test('炮位置正确', () => {
  const b = freshBoard();
  let redCannons = 0, blackCannons = 0;
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = b.board[r][c];
    if (p && p.type === CANNON && p.side === SIDE_RED) redCannons++;
    if (p && p.type === CANNON && p.side === SIDE_BLACK) blackCannons++;
  }
  assertEq(redCannons, 2, '红炮数量');
  assertEq(blackCannons, 2, '黑炮数量');
});

// ============================================================
// 二、基本走棋规则
// ============================================================
console.log('\n=== 二、基本走棋规则 ===');
test('兵初始只能向前走1格', () => {
  const b = freshBoard();
  const pawn = findPiece(b, SIDE_RED, PAWN); // 第6行
  const moves = b.getLegalMoves(pawn.r, pawn.c);
  assert(moves.length === 1, `红兵初始应只有1个合法走法, 实际${moves.length}`);
  assertEq(moves[0].row, 5, '目标行');
  assertEq(moves[0].col, pawn.c, '目标列');
});
test('兵过河后可以左右走', () => {
  const b = freshBoard();
  // 模拟红兵到第4行（过河）
  b.board[4][0] = { type: PAWN, side: SIDE_RED };
  b.board[6][0] = null;
  const moves = b.getLegalMoves(4, 0);
  const dirs = moves.map(m => m.row + ',' + m.col).sort();
  assert(dirs.includes('3,0'), '应能向前到(3,0)');
  assert(dirs.includes('4,1'), '应能向右到(4,1)');
});
test('马走日且不被蹩马腿', () => {
  const b = freshBoard();
  // 马在(0,1)，初始位置（黑方）测试红方马
  const redHorse = findPiece(b, SIDE_RED, HORSE); // (9,1)
  const moves = b.getLegalMoves(redHorse.r, redHorse.c);
  // 红马在(9,1)，无蹩腿时应有2个走法（(7,0),(7,2)）
  assert(moves.length === 2, `(9,1)红马应有2个合法走法, 实际${moves.length}`);
  // 测试蹩马腿：在(8,1)放棋子
  b.board[8][1] = { type: PAWN, side: SIDE_RED };
  const moves2 = b.getLegalMoves(9, 1);
  assert(moves2.length === 0, `蹩马腿后应无合法走法, 实际${moves2.length}`);
  b.board[8][1] = null;
});
test('车直线走棋', () => {
  const b = freshBoard();
  const rook = findPiece(b, SIDE_RED, ROOK); // (9,0)
  const moves = b.getLegalMoves(rook.r, rook.c);
  // (9,0)车：向上(8,0),(7,0)可走，(6,0)是自己兵挡住；右侧(9,1)被自己马堵
  // 合法走法 = (8,0),(7,0) = 2 个
  assert(moves.length === 2, `(9,0)车应有2个合法走法, 实际${moves.length}`);
});
test('炮隔山打子', () => {
  const b = freshBoard();
  const cannon = findPiece(b, SIDE_RED, CANNON); // (7,1)
  const moves = b.getLegalMoves(cannon.r, cannon.c);
  // (7,1)炮：横向(7,0)可走，(7,2)-(7,8)被兵堵后可越过吗？前方(6,1)无子，(5,1)... 
  // 向下：(8,1),(9,1) 被马堵，(9,1)是自己马不能吃
  // 向上：(6,1)空可走，(5,1)空，(4,1)空，(3,1)空，(2,1)是炮（自己黑炮？不，红方视角）
  // 简化：只需验证炮可以隔子吃子
  const b2 = freshBoard();
  // 构造场景：炮在(5,5)，中间(4,5)有子，(3,5)有对方子
  b2.board[5][5] = { type: CANNON, side: SIDE_RED };
  b2.board[4][5] = { type: PAWN, side: SIDE_RED };
  b2.board[3][5] = { type: PAWN, side: SIDE_BLACK };
  b2.board[7][1] = null;
  const m2 = b2.getLegalMoves(5, 5);
  assert(m2.some(m => m.row === 3 && m.col === 5), '炮应能隔子吃子');
});
test('将帅不能走出九宫格', () => {
  const b = freshBoard();
  const king = findPiece(b, SIDE_RED, KING); // (9,4)
  const moves = b.getLegalMoves(king.r, king.c);
  // 九宫格内：(8,4),(9,3),(9,5) 但需验证 (7,4) 不在
  assert(!moves.some(m => m.row === 7 && m.col === 4), '将帅不能走出九宫格');
  assert(moves.some(m => m.row === 8 && m.col === 4), '将帅可上下移动');
});
test('不能走出送将的棋', () => {
  const b = freshBoard();
  // 构造：红帅(9,4)，黑车(0,4)同列，红仕不能走到挡住的位置导致送将
  // 简单验证：红帅被黑车将军时，合法走法有限
  b.board[9][4] = { type: KING, side: SIDE_RED };
  b.board[0][4] = { type: ROOK, side: SIDE_BLACK };
  const kingMoves = b.getLegalMoves(9, 4);
  // 黑车在(0,4)同列，红帅可往(8,4)避开，(9,3),(9,5)仍会被车照到？车在(0,4)，(9,3)不在同列可走
  assert(kingMoves.some(m => m.row === 8 && m.col === 4), '红帅可上前躲避');
});

// ============================================================
// 三、吃子与将杀
// ============================================================
console.log('\n=== 三、吃子与将杀 ===');
test('吃子后 captured 返回正确', () => {
  const b = freshBoard();
  // 红车吃黑卒？ 构造简单场景
  b.board[6][0] = { type: PAWN, side: SIDE_BLACK };
  const captured = b.move(9, 0, 6, 0);
  assert(captured && captured.type === PAWN && captured.side === SIDE_BLACK, '吃子返回错误');
  assert(b.board[6][0].side === SIDE_RED, '吃子后目标位置应为红车');
});
test('isCheckmate 正常对局返回 false', () => {
  const b = freshBoard();
  assert(!b.isCheckmate(), '初始局面不应是将死');
});
test('isCheckmate 无子可动返回 true', () => {
  const b = freshBoard();
  // 构造将死：红帅(9,4)，黑车(0,4)，黑车(0,3)，黑车(0,5) 控制所有
  b.board = Array(10).fill(null).map(() => Array(9).fill(null));
  b.board[9][4] = { type: KING, side: SIDE_RED };
  b.board[0][3] = { type: ROOK, side: SIDE_BLACK };
  b.board[0][4] = { type: ROOK, side: SIDE_BLACK };
  b.board[0][5] = { type: ROOK, side: SIDE_BLACK };
  b.board[8][4] = { type: ROOK, side: SIDE_BLACK };
  b.turn = SIDE_RED;
  assert(b.inCheck(SIDE_RED), '红帅应被将军');
  assert(b.isCheckmate(), '红方应是将死');
});
test('AI 搜索不崩溃并返回合法走法（BUG-2 核心验证）', () => {
  const b = freshBoard();
  const ai = new ChessAI(b, 2);
  const move = ai.search(3000);
  assert(move, 'AI 应返回走法');
  assert(move.fr >= 0 && move.fr < 10 && move.fc >= 0 && move.fc < 9, '起点合法');
  assert(move.tr >= 0 && move.tr < 10 && move.tc >= 0 && move.tc < 9, '终点合法');
  const legal = b.getLegalMoves(move.fr, move.fc).some(m => m.row === move.tr && m.col === move.tc);
  assert(legal, 'AI 走法必须是合法走法');
});

// ============================================================
// 四、模式逻辑
// ============================================================
console.log('\n=== 四、模式逻辑 ===');

// ---- 经典模式 ----
test('经典模式 init 设置 phase=play', () => {
  game.phase = 'x';
  MODES.classic.init(freshBoard(), game);
  assertEq(game.phase, 'play', 'phase');
});

// ---- ban 局 ----
test('ban 局 init 进入选禁阶段', () => {
  const b = freshBoard();
  const g = { ...game, phase: 'play' };
  MODES.ban.init(b, g);
  assertEq(g.phase, 'ban', 'ban阶段');
  assertEq(g.banSide, SIDE_RED, '先红方禁');
});
test('ban 局点击非红方棋子被忽略', () => {
  const b = freshBoard();
  const g = { ...game, phase: 'ban', banRed: null, banBlack: null, banSide: SIDE_RED };
  const r = MODES.ban.onClick(b, g, 0, 0); // 黑方将位置
  assert(r === true, '应返回true拦截');
  assert(g.banRed === null, '不应设置banRed');
});
test('ban 局红方禁子后进入 AI 禁', () => {
  const b = freshBoard();
  const g = { ...game, phase: 'ban', banRed: null, banBlack: null, banSide: SIDE_RED };
  const pawn = findPiece(b, SIDE_RED, PAWN);
  MODES.ban.onClick(b, g, pawn.r, pawn.c);
  assert(g.banRed && g.banRed.type === PAWN, '红方应禁一个兵');
  assertEq(g.banSide, SIDE_BLACK, '轮到AI禁');
});

// ---- 心腹局 ----
test('心腹局 init 进入选心腹阶段', () => {
  const b = freshBoard();
  const g = { ...game, phase: 'play' };
  MODES.heart.init(b, g);
  assertEq(g.phase, 'chooseHeart', '选心腹阶段');
});
test('心腹局选择红方棋子', () => {
  const b = freshBoard();
  const g = { ...game, phase: 'chooseHeart', heartRed: null };
  const pawn = findPiece(b, SIDE_RED, PAWN);
  const r = MODES.heart.onClick(b, g, pawn.r, pawn.c);
  assert(g.heartRed && g.heartRed.type === PAWN, '红方心腹应为兵');
  assertEq(g.phase, 'chooseHeartAI', '进入AI选心腹');
});
test('心腹局心腹存活时拦截吃将', () => {
  const b = freshBoard();
  b.board = Array(10).fill(null).map(() => Array(9).fill(null));
  // 红帅(9,4)，红心腹兵(6,0)，黑车(8,4)可以吃帅
  b.board[9][4] = { type: KING, side: SIDE_RED };
  b.board[8][4] = { type: ROOK, side: SIDE_BLACK };
  b.board[6][0] = { type: PAWN, side: SIDE_RED };
  b.turn = SIDE_RED;
  const g = { ...game, heartRed: { row: 6, col: 0, type: PAWN }, heartBlack: null };
  // 心腹存活时，吃帅走法应被拦截
  const result = MODES.heart.canMove(b, g, 8, 4, 9, 4, b.board[9][4]);
  assertEq(result, false, '心腹存活时应拦截吃将');
  assert(b.board[6][0] !== null, '心腹不应被移除');
  // 心腹被吃后，吃帅不再拦截
  b.board[6][0] = null;
  const result2 = MODES.heart.canMove(b, g, 8, 4, 9, 4, b.board[9][4]);
  assertEq(result2, true, '心腹死后不应拦截吃将');
});

// ---- 内臣局 ----
test('内臣局 init 进入选内臣阶段', () => {
  const b = freshBoard();
  const g = { ...game, phase: 'play' };
  MODES.inner.init(b, g);
  assertEq(g.phase, 'chooseInner', '选内臣阶段');
});
test('内臣局吃将后内臣继位（BUG-3 核心验证）', () => {
  const b = freshBoard();
  b.board = Array(10).fill(null).map(() => Array(9).fill(null));
  b.board[9][4] = { type: KING, side: SIDE_RED };
  b.board[0][4] = { type: KING, side: SIDE_BLACK };
  b.board[5][0] = { type: ROOK, side: SIDE_BLACK }; // 黑方内臣（车）
  b.turn = SIDE_RED;
  const g = { ...game, phase: 'play', innerRed: null, innerBlack: { row: 5, col: 0, type: ROOK }, innerRevealed: false };
  // 红车吃黑将：红车在(9,0)？不行中间有子。直接在(0,0)放红车
  b.board[0][0] = { type: ROOK, side: SIDE_RED };
  const captured = b.move(0, 0, 0, 4); // 红车吃黑将
  assert(captured && captured.type === KING && captured.side === SIDE_BLACK, '应吃掉黑将');
  MODES.inner.onMove(b, g, 0, 0, 0, 4, captured);
  assertEq(g.innerRevealed, true, '内臣应继位');
  assert(b.board[5][0].innerKing === true, '内臣应有 innerKing 标记');
  assertEq(b.board[5][0].side, SIDE_BLACK, '内臣应属于黑方（被吃方）');
});

// ============================================================
// 五、悔棋与历史
// ============================================================
console.log('\n=== 五、悔棋与历史 ===');
test('undo 回退一步', () => {
  const b = freshBoard();
  const before = countPieces(b);
  const pawn = findPiece(b, SIDE_RED, PAWN);
  b.move(pawn.r, pawn.c, pawn.r - 1, pawn.c);
  assert(b.moveHistory.length === 1, 'moveHistory应为1');
  const ok = b.undo();
  assert(ok, 'undo应成功');
  assertEq(b.moveHistory.length, 0, 'undo后history应为0');
  assertEq(countPieces(b), before, '棋子数量应恢复');
});
test('空历史 undo 返回 false', () => {
  const b = freshBoard();
  assert(b.undo() === false, '空历史undo应返回false');
});

// ============================================================
// 六、AI 深度与难度
// ============================================================
console.log('\n=== 六、AI 深度 ===');
test('AI 各难度搜索不崩溃', () => {
  for (let d = 1; d <= 5; d++) {
    const b = freshBoard();
    const ai = new ChessAI(b, d);
    const move = ai.search(500);
    assert(move, `depth=${d} 应返回走法`);
  }
});
test('AI 在吃子场景优先吃子', () => {
  const b = freshBoard();
  b.board = Array(10).fill(null).map(() => Array(9).fill(null));
  b.board[9][0] = { type: ROOK, side: SIDE_RED };
  b.board[8][0] = { type: PAWN, side: SIDE_BLACK }; // 黑兵可直接吃
  b.board[5][5] = { type: PAWN, side: SIDE_RED };
  b.board[9][4] = { type: KING, side: SIDE_RED };
  b.board[0][8] = { type: KING, side: SIDE_BLACK }; // 黑将放在远离红帅的角落
  b.turn = SIDE_RED;
  const ai = new ChessAI(b, 2);
  const move = ai.search(1000);
  assert(move, 'AI应返回走法');
  // 高手深度下应优先吃子
  assert(move.fr === 9 && move.fc === 0 && move.tr === 8 && move.tc === 0, 'AI应吃掉黑兵');
});

// ============================================================
// 输出汇总
// ============================================================
console.log('\n========================================');
console.log(`逻辑测试结果: ✅ ${pass} 通过 | ❌ ${fail} 失败 | 共 ${pass + fail} 用例`);
console.log('========================================');
if (fail > 0) process.exit(1);
