/**
 * ban 进阶局（banpro）E2E 验证
 * 前置条件：本地 HTTP 服务已启动（python -m http.server 8765）
 * 运行：node test_banpro_e2e.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const PAGE_URL = 'http://localhost:8765/index.html';
const PROFILE = path.join(__dirname, '_chrome_profile_banpro');

try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(port) {
    const list = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
    const page = list.find(t => t.type === 'page');
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
  console.log('TIMEOUT'); try { chromeProc.kill(); } catch (e) {} process.exit(2);
}, 60000);

(async () => {
  let cdp;
  for (let i = 0; i < 15; i++) {
    try { cdp = await CDP.connect(PORT); break; } catch (e) { await new Promise(r => setTimeout(r, 1000)); }
  }
  if (!cdp) { console.log('CDP 连接失败'); process.exit(1); }
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await new Promise(r => setTimeout(r, 2500));

  console.log('=== ban 进阶局（banpro）=== ');
  await test('切换 banpro：提示选择红方棋子', async () => {
    await cdp.evaluate(`document.querySelectorAll('.mode-btn').forEach(b=>{if(b.dataset.mode==='banpro')b.click()})`);
    await new Promise(r => setTimeout(r, 200));
    const st = await cdp.evaluate('document.getElementById("gameStatus").textContent');
    if (!st.includes('禁用')) throw new Error('st=' + st);
    const active = await cdp.evaluate(`document.querySelector('.mode-btn.active').dataset.mode`);
    if (active !== 'banpro') throw new Error('active=' + active);
  });

  await test('banpro：红方禁兵 → AI 禁 → 弹窗 → 开局', async () => {
    await cdp.evaluate(`(()=>{const c=document.getElementById('board');const r=c.getBoundingClientRect();const ev=new MouseEvent('click',{clientX:r.left+32*(c.width/r.width),clientY:r.top+368*(c.height/r.height)});c.dispatchEvent(ev);return 1;})()`);
    await new Promise(r => setTimeout(r, 1800));
    const modal = await cdp.evaluate('document.getElementById("modalOverlay").classList.contains("show")');
    if (!modal) throw new Error('弹窗未显示');
    const title = await cdp.evaluate('document.getElementById("resultTitle").textContent');
    if (!title.includes('ban进阶')) throw new Error('title=' + title);
    await cdp.evaluate(`document.getElementById('modalBtn').click()`);
    await new Promise(r => setTimeout(r, 200));
    const st = await cdp.evaluate('document.getElementById("gameStatus").textContent');
    if (!st.includes('红方')) throw new Error('开局后 st=' + st);
  });

  await test('banpro：开局后可正常走棋', async () => {
    await cdp.evaluate(`(()=>{const c=document.getElementById('board');const r=c.getBoundingClientRect();const fire=(px,py)=>{const ev=new MouseEvent('click',{clientX:r.left+px*(c.width/r.width),clientY:r.top+py*(c.height/r.height)});c.dispatchEvent(ev);};fire(88,368);fire(88,312);return 1;})()`);
    await new Promise(r => setTimeout(r, 2500));
    const st = await cdp.evaluate('document.getElementById("gameStatus").textContent');
    if (!st.includes('红方')) throw new Error('AI 未回手 st=' + st);
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
