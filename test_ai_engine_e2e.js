const fs=require('fs'),path=require('path'),vm=require('vm');
const log=(...a)=>fs.writeSync(1,a.join(' ')+'\n');
const ROOT='D:/code/qinhan-chess';
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
// 1) 引擎与规则
const _s=html.indexOf('const COLS=9,ROWS=10,CELL=56'),_e=html.indexOf('// 模式策略');
vm.runInThisContext(html.slice(_s,_e),{filename:'core.js'});
for(const f of ['ai-tactics.js','ai-search.js','ai-opening.js','ai-tt.js','ai-evaluate.js','ai-engine.js'])
  vm.runInThisContext(fs.readFileSync(path.join(ROOT,'js',f),'utf8'),{filename:f});
Search.install();TT.init();EvalEnhancer.install();globalThis.Opening.install();

// 2) 抽出 index.html 里真实的 pickAIMove（花括号配对截取）
const src=html.slice(html.indexOf('function pickAIMove()'));
let d=0,end=-1;
for(let i=src.indexOf('{');i<src.length;i++){const c=src[i];if(c==='{')d++;else if(c==='}'){d--;if(d===0){end=i+1;break;}}}
const fn=src.slice(0,end);
vm.runInThisContext(fn,{filename:'pickAIMove.js'});
log('已从 index.html 抽出 pickAIMove（'+fn.split('\n').length+' 行）');

// 3) 浏览器环境替身
globalThis.showToast=()=>{};
const DIFF={value:'2'},THINK={value:'10'};
globalThis.document={getElementById:id=>id==='difficulty'?DIFF:id==='thinkTime'?THINK:null};

// 4) 各难度各要一步，检查合法性
function legal(b,m){if(!m)return false;return b.getLegalMoves(m.fr,m.fc).some(x=>x.row===m.tr&&x.col===m.tc);}
log('\n--- 各难度第一步 ---');
for(let lv=0;lv<5;lv++){
  DIFF.value=String(lv);
  THINK.value='10';
  globalThis.board=new ChessBoard();board.reset();board.move(7,7,7,4);
  globalThis.game={currentMode:'classic',epoch:0,phase:'play'};
  const t0=Date.now();
  const m=pickAIMove();
  log(`  ${AIEngine.LEVELS[lv].name}: (${m&&m.fr},${m&&m.fc})->(${m&&m.tr},${m&&m.tc}) 合法=${legal(board,m)} 用时=${Date.now()-t0}ms`);
}

// 5) 完整对局：黑方走 pickAIMove，红方随机合法走（模拟玩家）
log('\n--- 完整对局（红=随机玩家，黑=游戏AI"高手"）---');
DIFF.value='2';
globalThis.board=new ChessBoard();board.reset();
globalThis.game={currentMode:'classic',epoch:0,phase:'play'};
let plies=0,illegal=0,err=null;
try{
  for(;plies<80;plies++){
    if(board.turn===SIDE_BLACK){
      const m=pickAIMove();
      if(!m){log('  AI 无着法');break;}
      if(!legal(board,m)){illegal++;log('  ✗ AI 走了非法着法 '+JSON.stringify(m));break;}
      const cap=board.move(m.fr,m.fc,m.tr,m.tc);
      if(cap&&(cap.type===0||cap.innerKing||cap.lordKing)){log(`  第${plies+1}手 AI吃掉将帅 → 黑胜`);break;}
      if(board.isCheckmate()){log(`  第${plies+1}手 黑方将死红方`);break;}
    }else{
      const all=[];for(const p of board.getPieces(SIDE_RED))for(const mv of board.getLegalMoves(p.row,p.col))all.push({fr:p.row,fc:p.col,tr:mv.row,tc:mv.col});
      if(!all.length){log(`  第${plies+1}手 红方无着法 → 黑胜`);break;}
      const m=all[Math.floor(Math.random()*all.length)];
      const cap=board.move(m.fr,m.fc,m.tr,m.tc);
      if(cap&&(cap.type===0||cap.innerKing||cap.lordKing)){log(`  第${plies+1}手 红方吃掉将帅 → 红胜`);break;}
    }
  }
}catch(e){err=e;}
log(`  共 ${plies} 手，非法着法 ${illegal} 次，异常: ${err?err.message:'无'}`);

// 6) 心腹局（protectedKing）不能吃被保护的将帅
log('\n--- 心腹局：AI 不能吃"有心腹护着"的将帅 ---');
globalThis.board=new ChessBoard();
board.board=Array(10).fill(null).map(()=>Array(9).fill(null));
// 黑炮(2,4) 借红炮(7,4) 当炮架可打红帅(9,4)，但红方心腹=红兵(6,0)存活
board.board[0][4]={type:0,side:1};board.board[2][4]={type:5,side:1};
board.board[9][4]={type:0,side:0};board.board[7][4]={type:5,side:0};board.board[6][0]={type:6,side:0};
board.turn=SIDE_BLACK;board.moveHistory=[];
globalThis.game={currentMode:'heart',epoch:0,phase:'play',heartRed:{row:6,col:0,type:6},heartBlack:null};
// 先看没保护的版本会怎么走
const b2=board.clone();globalThis.board=b2;game.currentMode='classic';
const m1=pickAIMove();
log(`  无护主时: (${m1.fr},${m1.fc})->(${m1.tr},${m1.tc}) ${m1.tr===9&&m1.tc===4?'→ 直接吃将':'→ 没吃将'}`);
globalThis.board=new ChessBoard();
board.board=Array(10).fill(null).map(()=>Array(9).fill(null));
board.board[0][4]={type:0,side:1};board.board[2][4]={type:5,side:1};
board.board[9][4]={type:0,side:0};board.board[7][4]={type:5,side:0};board.board[6][0]={type:6,side:0};
board.turn=SIDE_BLACK;board.moveHistory=[];
game.currentMode='heart';
const m2=pickAIMove();
log(`  有心腹护主时: (${m2.fr},${m2.fc})->(${m2.tr},${m2.tc}) ${m2.tr===9&&m2.tc===4?'❌ 仍然吃了将（会被 canMove 拦下，白走一步）':'✅ 没去吃被保护的将'}`);
