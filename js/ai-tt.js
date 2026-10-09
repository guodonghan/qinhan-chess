// ============================================================
// 置换表 (Transposition Table) + Zobrist 哈希
//
// 作用：
//   - 缓存搜索过的局面 → 同样的局面不重复搜
//   - 提供 bestMove → 下一轮迭代深化时优先尝试 PV 走法
//   - 显著加速：相同深度可搜 3~10 倍节点
//
// 公开 API：
//   TT.init()                           —— 初始化（默认自动）
//   TT.hash(board) -> int               —— 当前局面的 Zobrist 哈希
//   TT.probe(hash, depth, alpha, beta)  —— 查表：
//                                          返回 {score, bestMove} 或 null
//   TT.store(hash, depth, score, flag, bestMove)
//   TT.moveOrder(board, moves)          —— 在 moves 数组上把 bestMove 移到首位
//   TT.clear()                          —— 清空表（开局库搜索建议）
//   TT.size()                           —— 当前 entry 数
// ============================================================
(function(global){
  'use strict';

  // 置换表（hash -> {depth, score, flag, bestMove}）
  const TABLE = new Map();
  // 最大 entry 数（防止内存爆炸）
  const MAX_SIZE = 200000;

  // Zobrist 哈希生成（确定性伪随机）
  // 32-bit xorshift
  function prng(seed){
    let x = seed >>> 0;
    return () => {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      return x;
    };
  }

  // 每个 (side, type, row, col) 一个独立 hash
  const ZOB = new Int32Array(2 * 7 * 10 * 9);  // side 0/1, type 0~6, row 0~9, col 0~8
  const TURN_KEY = 0x12345678 | 0;

  let _initialized = false;
  function init(){
    if(_initialized) return;
    const rand = prng(0xDEADBEEF);
    for(let s=0;s<2;s++)
      for(let t=0;t<7;t++)
        for(let r=0;r<10;r++)
          for(let c=0;c<9;c++){
            const idx = ((s*7 + t)*10 + r)*9 + c;
            ZOB[idx] = rand();
          }
    _initialized = true;
  }

  // 计算当前局面的 Zobrist 哈希
  function hash(board){
    if(!_initialized) init();
    let h = 0;
    for(let r=0;r<10;r++) for(let c=0;c<9;c++){
      const p = board.board[r][c];
      if(!p) continue;
      // 只算 type，因为 side 包含在 moveHistory 中（可通过 turn 区分）
      // 实际上我们用 (side, type, row, col) 全维 hash
      const idx = ((p.side*7 + p.type)*10 + r)*9 + c;
      h ^= ZOB[idx];
    }
    if(board.turn === 1) h ^= TURN_KEY;
    return h | 0;
  }

  // 查表
  function probe(zHash, depth, alpha, beta){
    const e = TABLE.get(zHash);
    if(!e) return null;
    // depth 不足则不命中
    if(e.depth < depth) return null;
    if(e.flag === 'EXACT') return { score: e.score, bestMove: e.bestMove };
    if(e.flag === 'LOWER' && e.score >= beta) return { score: e.score, bestMove: e.bestMove };
    if(e.flag === 'UPPER' && e.score <= alpha) return { score: e.score, bestMove: e.bestMove };
    return null;
  }

  // 存表
  function store(zHash, depth, score, flag, bestMove){
    // 内存保护
    if(TABLE.size > MAX_SIZE){
      // 简单策略：清空一半旧 entry（按插入顺序）
      let i = 0;
      const target = TABLE.size / 2;
      for(const k of TABLE.keys()){
        if(i++ >= target) break;
        TABLE.delete(k);
      }
    }
    const existing = TABLE.get(zHash);
    // 总是替换条件：EXACT 总是替换；非 EXACT 时新 depth >= 旧 depth 才替换
    if(existing && existing.flag === 'EXACT' && flag !== 'EXACT') return;
    if(existing && existing.depth > depth && flag !== 'EXACT') return;
    TABLE.set(zHash, { depth:depth, score:score, flag:flag, bestMove:bestMove });
  }

  // 把 bestMove 移到 moves 首位（PV first）
  function moveOrder(board, moves){
    const z = hash(board);
    const e = TABLE.get(z);
    if(!e || !e.bestMove) return;
    const bm = e.bestMove;
    for(let i=0;i<moves.length;i++){
      const m = moves[i];
      if(m.fr === bm.fr && m.fc === bm.fc && m.tr === bm.tr && m.tc === bm.tc){
        if(i > 0){
          const tmp = moves[0];
          moves[0] = m;
          moves[i] = tmp;
        }
        return;
      }
    }
  }

  function clear(){ TABLE.clear(); }
  function size(){ return TABLE.size; }

  // 自动初始化
  init();

  globalThis.TT = { init, hash, probe, moveOrder, store, clear, size };
})(typeof window !== 'undefined' ? window : globalThis);