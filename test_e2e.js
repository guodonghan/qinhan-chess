/**
 * 中国象棋 - 浏览器端到端测试（CDP）
 * 前置条件：本地 HTTP 服务已启动（python -m http.server 8765）
 * 运行：node test_e2e.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
const PAGE_URL = 'http://localhost:8765/index.html';
const PROFILE = path.join(__dirname, '_chrome_profile_e2e');

try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(port) {
    const list = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
    const page = list.find(t => t.type === 'page');
    if (!page) throw new Error('no page target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
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
    if (r.exceptionDetails) throw new Error('JS EXC: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
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
  console.log('GLOBAL TIMEOUT - force exit');
  try { chromeProc.kill(); } catch (e) {}
  process.exit(2);
}, 90000);

(async () => {
  let cdp;
  for (let i = 0; i < 15; i++) {
    try { cdp = await CDP.connect(PORT); break; } catch (e) { await new Promise(r => setTimeout(r, 1000)); }
  }
  if (!cdp) { console.log('CDP 连接失败'); process.exit(1); }
  console.log('CDP connected');

  const consoleErrors = [];
  const origOnMessage = cdp.ws.onmessage;
  cdp.ws.onmessage = e => {
    try { origOnMessage.call(cdp.ws, e); } catch (err) {}
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(JSON.stringify(msg.params.args).slice(0, 200));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXC: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 200));
    }
  };

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await new Promise(r => setTimeout(r, 2500));

  console.log('=== 1. 页面加载与首屏 ===');
  await test('页面标题', async () => {
    const t = await cdp.evaluate('document.title');
    if (!t.includes('中国象棋')) throw new Error('title=' + t);
  });
  await test('canvas 尺寸', async () => {
    const s = await cdp.evaluate('document.getElementById("board").width + "x" + document.getElementById("board").height');
    if (s !== '512x568') throw new Error('canvas=' + s);
  });
  await test('首屏棋盘已绘制', async () => {
    const nz = await cdp.evaluate(`(()=>{const c=document.getElementById('board');const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=16)if(d[i]>0)n++;return n;})()`);
    if (!nz || nz < 1000) throw new Error('nonZero=' + nz);
  });
  await test('状态栏红方走棋', async () => {
    const st = await cdp.evaluate('document.getElementById("gameStatus").textContent');
    if (!st.includes('红方')) throw new Error('st=' + st);
  });

  console.log('=== 2. 经典局对弈 ===');
  await test('红兵前进 + AI 回手', async () => {
    await cdp.evaluate(`(()=>{const c=document.getElementById('board');const r=c.getBoundingClientRect();const fire=(px,py)=>{const ev=new MouseEvent('click',{clientX:r.left+px*(c.width/r.width),clientY:r.top+py*(c.height/r.height)});c.dispatchEvent(ev);};fire(88,368);fire(88,312);return 1;})()`);
    await new Promise(r => setTimeout(r, 2500));
    const st = await cdp.evaluate('document.getElementById("gameStatus").textContent');
    if (!st.includes('红方')) throw new Error('AI 未回手 st=' + st);
  });

  console.log('=== 3. 悔棋 ===');
  await test('悔棋回到红方回合', async () => {
    await cdp.evaluate(`document.getElementById('btnUndo').click()`);
    await new Promise(r => setTimeout(r, 300));
    const st = await cdp.evaluate('document.getElementById("gameStatus").textContent');
    if (!st.includes('红方')) throw new Error('st=' + st);
  });
  await test('连续悔棋无异常', async () => {
    for (let i = 0; i < 5; i++) {
      await cdp.evaluate(`document.getElementById('btnUndo').click()`);
      await new Promise(r => setTimeout(r, 100));
    }
    const st = await cdp.evaluate('document.getElementById("gameStatus").textContent');
    if (!st.includes('红方')) throw new Error('st=' + st);
  });

  console.log('=== 4. 模式切换 ===');
  await test('ban 局', async () => {
    await cdp.evaluate(`document.querySelectorAll('.mode-btn').forEach(b=>{if(b.dataset.mode==='ban')b.click()})`);
    await new Promise(r => setTimeout(r, 200));
    const st = await cdp.evaluate('document.getElementById("gameStatus").textContent');
    if (!st.includes('禁用')) throw new Error('st=' + st);
    await cdp.evaluate(`(()=>{const c=document.getElementById('board');const r=c.getBoundingClientRect();const ev=new MouseEvent('click',{clientX:r.left+32*(c.width/r.width),clientY:r.top+368*(c.height/r.height)});c.dispatchEvent(ev);return 1;})()`);
    await new Promise(r => setTimeout(r, 1800));
    const modal = await cdp.evaluate('document.getElementById("modalOverlay").classList.contains("show")');
    if (!modal) throw new Error('ban 弹窗未显示');
    await cdp.evaluate(`document.getElementById('modalBtn').click()`);
    await new Promise(r => setTimeout(r, 200));
  });
  await test('心腹局', async () => {
    await cdp.evaluate(`document.querySelectorAll('.mode-btn').forEach(b=>{if(b.dataset.mode==='heart')b.click()})`);
    await new Promise(r => setTimeout(r, 200));
    const st = await cdp.evaluate('document.getElementById("gameStatus").textContent');
    if (!st.includes('心腹')) throw new Error('st=' + st);
    await cdp.evaluate(`(()=>{const c=document.getElementById('board');const r=c.getBoundingClientRect();const ev=new MouseEvent('click',{clientX:r.left+32*(c.width/r.width),clientY:r.top+368*(c.height/r.height)});c.dispatchEvent(ev);return 1;})()`);
    await new Promise(r => setTimeout(r, 1800));
    const modal = await cdp.evaluate('document.getElementById("modalOverlay").classList.contains("show")');
    if (!modal) throw new Error('心腹弹窗未显示');
    await cdp.evaluate(`document.getElementById('modalBtn').click()`);
    await new Promise(r => setTimeout(r, 200));
  });
  await test('内臣局', async () => {
    await cdp.evaluate(`document.querySelectorAll('.mode-btn').forEach(b=>{if(b.dataset.mode==='inner')b.click()})`);
    await new Promise(r => setTimeout(r, 200));
    const st = await cdp.evaluate('document.getElementById("gameStatus").textContent');
    if (!st.includes('内臣')) throw new Error('st=' + st);
    await cdp.evaluate(`(()=>{const c=document.getElementById('board');const r=c.getBoundingClientRect();const ev=new MouseEvent('click',{clientX:r.left+32*(c.width/r.width),clientY:r.top+368*(c.height/r.height)});c.dispatchEvent(ev);return 1;})()`);
    await new Promise(r => setTimeout(r, 1800));
    const modal = await cdp.evaluate('document.getElementById("modalOverlay").classList.contains("show")');
    if (!modal) throw new Error('内臣弹窗未显示');
    await cdp.evaluate(`document.getElementById('modalBtn').click()`);
    await new Promise(r => setTimeout(r, 200));
  });
  await test('切回经典局', async () => {
    await cdp.evaluate(`document.querySelectorAll('.mode-btn').forEach(b=>{if(b.dataset.mode==='classic')b.click()})`);
    await new Promise(r => setTimeout(r, 200));
    const st = await cdp.evaluate('document.getElementById("gameStatus").textContent');
    if (!st.includes('红方')) throw new Error('st=' + st);
  });

  console.log('=== 5. 重新开局 ===');
  await test('重新开局', async () => {
    await cdp.evaluate(`document.getElementById('btnRestart').click()`);
    await new Promise(r => setTimeout(r, 300));
    const st = await cdp.evaluate('document.getElementById("gameStatus").textContent');
    if (!st.includes('红方')) throw new Error('st=' + st);
  });

  console.log('=== 6. 竞态验证 ===');
  await test('AI 思考期间重开无污染', async () => {
    await cdp.evaluate(`(()=>{const c=document.getElementById('board');const r=c.getBoundingClientRect();const fire=(px,py)=>{const ev=new MouseEvent('click',{clientX:r.left+px*(c.width/r.width),clientY:r.top+py*(c.height/r.height)});c.dispatchEvent(ev);};fire(88,368);fire(88,312);return 1;})()`);
    await new Promise(r => setTimeout(r, 80));
    await cdp.evaluate(`document.getElementById('btnRestart').click()`);
    await new Promise(r => setTimeout(r, 2500));
    const st = await cdp.evaluate('document.getElementById("gameStatus").textContent');
    if (!st.includes('红方')) throw new Error('st=' + st);
  });

  console.log('=== 7. 控制台错误 ===');
  await test('无 JS 错误', async () => {
    const errs = consoleErrors.filter(e => !e.includes('favicon') && !e.includes('Failed to load resource'));
    if (errs.length > 0) throw new Error(errs.slice(0, 3).join(' | '));
  });

  console.log('RESULT: pass=' + pass + ' fail=' + fail);
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
