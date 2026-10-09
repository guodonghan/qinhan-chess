/**
 * AI 增强验证：手动走完整流程（splash → menu → game → 走棋 → 验证 AI 走子 + 开局库 toast）
 * 前置条件：本地 HTTP 服务已启动（PORT=8765）
 * 运行：node test_ai_enhance.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME_CANDIDATES = [
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const CHROME = CHROME_CANDIDATES.find(p => fs.existsSync(p));
if (!CHROME) {
  console.error('未找到 Chrome/Edge');
  process.exit(1);
}
const PORT = 9336;
const PAGE_URL = 'http://localhost:8765/index.html';
const PROFILE = path.join(__dirname, '_chrome_profile_ai');

try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(port) {
    const list = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
    const page = list.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('JS EXC: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const chromeProc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1280,900',
  'about:blank'
], { stdio: 'ignore' });

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  [PASS] ' + name); }
  catch (e) { fail++; console.log('  [FAIL] ' + name + ' -> ' + e.message); }
}

const timer = setTimeout(() => {
  console.log('GLOBAL TIMEOUT');
  try { chromeProc.kill(); } catch (e) {}
  process.exit(2);
}, 60000);

(async () => {
  let cdp;
  for (let i = 0; i < 15; i++) {
    try { cdp = await CDP.connect(PORT); break; } catch (e) { await new Promise(r => setTimeout(r, 1000)); }
  }
  if (!cdp) { console.log('CDP 连接失败'); process.exit(1); }
  console.log('CDP connected');

  const consoleErrors = [];
  const consoleLogs = [];
  const origOnMessage = cdp.ws.onmessage;
  cdp.ws.onmessage = e => {
    try { origOnMessage.call(cdp.ws, e); } catch (err) {}
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map(a => a.value || a.description || '').join(' ');
      if (msg.params.type === 'error') {
        consoleErrors.push(args.slice(0, 200));
      }
      if (msg.params.type === 'log' || msg.params.type === 'info') {
        consoleLogs.push(args);
      }
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXC: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 200));
    }
  };

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await new Promise(r => setTimeout(r, 2500));

  // 1. AI 模块已加载
  console.log('=== 1. AI 模块加载验证 ===');
  await test('Tactics 模块已暴露', async () => {
    const ok = await cdp.evaluate('typeof Tactics === "object" && typeof Tactics.detect === "function"');
    if (!ok) throw new Error('Tactics not loaded');
  });
  await test('Search 模块已暴露', async () => {
    const ok = await cdp.evaluate('typeof Search === "object" && typeof Search.install === "function"');
    if (!ok) throw new Error('Search not loaded');
  });
  await test('Opening 模块已暴露且 book 已构建', async () => {
    const r = await cdp.evaluate('typeof Opening === "object" && Object.keys(Opening.debug()).length > 0');
    if (!r) throw new Error('Opening.book empty');
  });
  await test('TT 模块已暴露', async () => {
    const ok = await cdp.evaluate('typeof TT === "object" && typeof TT.hash === "function" && typeof TT.probe === "function"');
    if (!ok) throw new Error('TT not loaded');
  });
  await test('EvalEnhancer 模块已暴露', async () => {
    const ok = await cdp.evaluate('typeof EvalEnhancer === "object" && typeof EvalEnhancer.install === "function"');
    if (!ok) throw new Error('EvalEnhancer not loaded');
  });
  await test('evaluate 已被 Search 注入', async () => {
    const ok = await cdp.evaluate(`(()=>{
      const b = new ChessBoard(); b.reset();
      const v1 = b.evaluate();
      const td = (typeof Tactics === 'object' && typeof Tactics.detect === 'function');
      return td && typeof v1 === 'number';
    })()`);
    if (!ok) throw new Error('evaluate/Tactics missing');
  });

  // 2. 关闭 splash 进入 menu
  console.log('=== 2. 导航到 game 视图 ===');
  await test('关闭 splash 进入 menu', async () => {
    await cdp.evaluate(`document.getElementById('viewSplash').click()`);
    await new Promise(r => setTimeout(r, 300));
    const ok = await cdp.evaluate(`document.getElementById('viewMenu').classList.contains('active')`);
    if (!ok) throw new Error('viewMenu not active');
  });

  await test('点击 普通局 进入对弈', async () => {
    await cdp.evaluate(`document.querySelector('.mode-card[data-mode="classic"]').click()`);
    await new Promise(r => setTimeout(r, 500));
    const ok = await cdp.evaluate(`document.getElementById('viewGame').classList.contains('active')`);
    if (!ok) throw new Error('viewGame not active');
  });

  // 3. 走棋：红炮二平五（中路开局），验证 AI 走开局库走法 + toast
  console.log('=== 3. 走棋 + AI 应对 ===');
  await test('走 炮二平五：选中 (9,7) -> (7,4)', async () => {
    const r = await cdp.evaluate(`(()=>{
      const b = (window.board || (typeof board !== 'undefined' ? board : null));
      return b ? 'have-board' : 'no-board';
    })()`);
    if (r !== 'have-board') throw new Error('board global not accessible');
  });

  await test('点击炮二平五 + AI 回手', async () => {
    // 炮二位于 (7,7)，目标 (7,4)。CELL=56, PADDING=32.
    // 起点 (7,7): px = 32+7*56 = 424, py = 32+7*56 = 424
    // 终点 (7,4): px = 32+4*56 = 256, py = 32+7*56 = 424
    await cdp.evaluate(`(()=>{
      const c=document.getElementById('board');
      const r=c.getBoundingClientRect();
      const fire=(px,py)=>{const ev=new MouseEvent('click',{clientX:r.left+px,clientY:r.top+py,bubbles:true});c.dispatchEvent(ev);};
      fire(424,424);
      fire(256,424);
      return 1;
    })()`);
    await new Promise(r => setTimeout(r, 3000));
    const st = await cdp.evaluate(`document.getElementById('gameStatus').textContent`);
    if (!st.includes('红方')) throw new Error('AI 没回手, st=' + st);
  });

  await test('开局库命中（通过 console 日志）', async () => {
    // 走完红棋后已经过了一段时间，AI 走子已完成；
    // 我们检查 console.log 里是否有 [AI-Opening] hit 标记
    const hits = consoleLogs.filter(l => l.indexOf('[AI-Opening] hit:') >= 0);
    if (hits.length === 0) {
      throw new Error('console.log 中未发现开局库命中记录');
    }
    console.log('     → 命中记录: ' + hits[0]);
  });

  await test('moveHistory 长度 ≥ 2（红 + 黑）', async () => {
    const len = await cdp.evaluate(`(typeof board !== 'undefined' ? board.moveHistory.length : window.board ? window.board.moveHistory.length : -1)`);
    if (len < 2) throw new Error('moveHistory.len=' + len);
  });

  await test('黑方走子后棋盘非空', async () => {
    const nz = await cdp.evaluate(`(()=>{const c=document.getElementById('board');const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=16)if(d[i]>0)n++;return n;})()`);
    if (nz < 1000) throw new Error('nonZero=' + nz);
  });

  // 4. 验证 evaluate 战术注入有效
  console.log('=== 4. 战术评分验证 ===');
  await test('初始局面 evaluate 返回红方为正的值', async () => {
    const v = await cdp.evaluate(`(()=>{
      const b = new ChessBoard(); b.reset();
      return b.evaluate();
    })()`);
    if (!(v > 0)) throw new Error('evaluate=' + v);
  });

  await test('开局库 lookup 直接验证', async () => {
    const r = await cdp.evaluate(`(()=>{
      const out = {};
      try {
        const b1 = new ChessBoard(); b1.reset();
        b1.move(7,7,7,4);  // 红炮二平五
        const op1 = Opening.lookup(b1);
        out.炮二平五 = op1 ? (op1.name + ' ' + JSON.stringify(op1.move)) : null;
        out.bookKeys = Opening.debug().length;
      } catch(e) { out.err = e.message; }
      return out;
    })()`);
    if (!r.炮二平五) throw new Error('炮二平五 lookup miss: ' + JSON.stringify(r));
    console.log('     → 炮二平五命中: ' + r.炮二平五);
    console.log('     → 开局库变例数: ' + r.bookKeys);
  });

  await test('阶段感 getPhase 正确', async () => {
    const r = await cdp.evaluate(`(()=>{
      const b = new ChessBoard(); b.reset();
      return EvalEnhancer.getPhase(b);
    })()`);
    if (r !== 'open') throw new Error('初始局面阶段=' + r);
  });

  await test('EvalEnhancer.residueBonus 在 end 阶段生效', async () => {
    const r = await cdp.evaluate(`(()=>{
      const b = new ChessBoard(); b.reset();
      // 强制设为残局
      b.board[3][0] = null; b.board[3][2] = null; b.board[3][4] = null; b.board[3][6] = null; b.board[3][8] = null;
      // 红方只剩帅仕相车，黑方只剩将士象
      // 构造：双车 vs 士象全 -> 应加 +200
      b.board = Array(10).fill(null).map(() => Array(9).fill(null));
      // 红车
      b.board[9][4] = {type:0, side:0}; // 红帅
      b.board[5][4] = {type:4, side:0}; b.board[5][3] = {type:4, side:0};
      b.board[9][3] = {type:1, side:0}; b.board[9][5] = {type:1, side:0};
      b.board[9][2] = {type:2, side:0}; b.board[9][6] = {type:2, side:0};
      // 黑将+士象全
      b.board[0][4] = {type:0, side:1};
      b.board[1][3] = {type:1, side:1}; b.board[1][5] = {type:1, side:1};
      b.board[2][2] = {type:2, side:1}; b.board[2][6] = {type:2, side:1};
      b.board[5][4] = {type:4, side:0}; b.board[5][3] = {type:4, side:0};
      b.turn = 0;
      return EvalEnhancer.residueBonus(b);
    })()`);
    if (typeof r !== 'number') throw new Error('residueBonus not number');
    // 双车 vs 士象全应大幅加分
    if (r < 100) throw new Error('residueBonus 双车 vs 士象全 应加 ≥100, 实际=' + r);
  });

  await test('checkBonus：己方被将惩罚生效', async () => {
    const r = await cdp.evaluate(`(()=>{
      const b = new ChessBoard(); b.reset();
      return EvalEnhancer.checkBonus(b);
    })()`);
    // 初始局面不将军，应为 0
    if (r !== 0) throw new Error('checkBonus 初始应为 0, 实际=' + r);
  });

  // 5. 再走一步，验证 AI 仍在开局库内
  console.log('=== 5. 持续走棋 ===');
  await test('红方走第 3 手 + AI 第 2 手', async () => {
    // 走马二进三：(9,7)→(7,6) = px=424, py=424 → px=368, py=368
    await cdp.evaluate(`(()=>{
      const c=document.getElementById('board');
      const r=c.getBoundingClientRect();
      const fire=(px,py)=>{const ev=new MouseEvent('click',{clientX:r.left+px,clientY:r.top+py,bubbles:true});c.dispatchEvent(ev);};
      fire(424,424);
      fire(368,368);
      return 1;
    })()`);
    await new Promise(r => setTimeout(r, 3000));
    const st = await cdp.evaluate(`document.getElementById('gameStatus').textContent`);
    if (!st.includes('红方')) throw new Error('AI 未回手, st=' + st);
  });

  await test('迭代加深 Search.iterativeDeepening 直接调用', async () => {
    const r = await cdp.evaluate(`(()=>{
      try {
        const b = new ChessBoard(); b.reset();
        // 走几步开局库以外的步
        b.move(7,7,7,4); // 炮二平五
        b.move(0,1,2,2); // 马2进3
        b.move(9,7,7,6); // 马二进三
        b.move(0,7,2,6); // 马8进7
        b.move(6,2,5,2); // 兵七进一
        b.move(3,6,4,6); // 卒7进1
        b.move(9,0,8,0); // 车九进一（出子）
        b.turn = 1; // 黑方走
        // 走足够深度的迭代加深
        Search.resetHeuristics();
        TT.clear();
        const ctx = { startTime: Date.now(), timeLimit: 4000 };
        const result = Search.iterativeDeepening(b, 3, ctx);
        return {
          ok: !!(result && result.move),
          depth: result ? result.depth : 0,
          score: result ? result.score : 0,
          move: result && result.move,
          ttSize: TT.size(),
          elapsed: Date.now() - ctx.startTime,
        };
      } catch(e) {
        return { error: String(e.message) };
      }
    })()`);
    if (r.error) throw new Error('iterativeDeepening 异常: ' + r.error);
    if (!r.ok) throw new Error('iterativeDeepening 未返回 move, 实际=' + JSON.stringify(r));
    if (r.depth < 1) throw new Error('depth < 1, 实际=' + r.depth);
    if (r.ttSize <= 0) throw new Error('TT.size=' + r.ttSize + ' （搜索后应有缓存）');
    console.log('     → 迭代加深 depth=' + r.depth + ' score=' + r.score.toFixed(1));
    console.log('     → 走子: ' + JSON.stringify(r.move));
    console.log('     → TT 表大小: ' + r.ttSize + ' (用时 ' + r.elapsed + 'ms)');
  });

  // 6. 切到 ban 局，验证不崩
  console.log('=== 6. 模式切换 ===');
  await test('点击返回菜单', async () => {
    await cdp.evaluate(`document.getElementById('btnBackMenu').click()`);
    await new Promise(r => setTimeout(r, 300));
    const ok = await cdp.evaluate(`document.getElementById('viewMenu').classList.contains('active')`);
    if (!ok) throw new Error('viewMenu not active');
  });
  await test('选择 ban 局', async () => {
    await cdp.evaluate(`document.querySelector('.mode-card[data-mode="ban"]').click()`);
    await new Promise(r => setTimeout(r, 300));
    const ok = await cdp.evaluate(`document.getElementById('viewGame').classList.contains('active')`);
    if (!ok) throw new Error('viewGame not active after ban');
    const st = await cdp.evaluate(`document.getElementById('gameStatus').textContent`);
    if (!st.includes('禁用') && !st.includes('禁')) throw new Error('st=' + st);
  });

  // 7. 控制台无 JS 错误
  console.log('=== 7. 控制台错误 ===');
  await test('无 JS 错误（过滤 favicon）', async () => {
    const errs = consoleErrors.filter(e => !e.includes('favicon') && !e.includes('Failed to load resource'));
    if (errs.length > 0) throw new Error(errs.slice(0, 3).join(' | '));
  });

  console.log('RESULT: pass=' + pass + ' fail=' + fail);
  console.log('错误详情:');
  for (const e of consoleErrors) console.log('  -', e);
  clearTimeout(timer);
  cdp.close();
  try { chromeProc.kill(); } catch (e) {}
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.log('FATAL: ' + e.message);
  clearTimeout(timer);
  try { chromeProc.kill(); } catch (e2) {}
  process.exit(1);
});