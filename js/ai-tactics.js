// ============================================================
// 战术识别（杀形 / 章法）
// 依赖：常量 KING/ADVISOR/.../PAWN, SIDE_RED/SIDE_BLACK, PIECE_VALUE
//       ChessBoard 实例（board.board[r][c], board.findKing, board.inCheck）
// 暴露：Tactics.detect(board) -> 返回"按当前 turn 视角"的战术加分
//       （红方为正，黑方为负；调用方按 turn 取反）
// ============================================================
(function(global){
  'use strict';

  // 缓存常用值：九宫坐标
  // 红方九宫：行 7-9，列 3-5；黑方九宫：行 0-2，列 3-5
  const PALACE_COLS = [3,4,5];
  const RED_PALACE_ROWS = [7,8,9];
  const BLACK_PALACE_ROWS = [0,1,2];

  // 统计 (row,col) 范围内某种子的数量（按 side）
  function countPiece(board, type, cols, rows, side){
    let n = 0;
    for(const c of cols) for(const r of rows){
      const p = board.board[r][c];
      if(p && p.type === type && p.side === side) n++;
    }
    return n;
  }

  // 找 (type, side) 的全部子，返回 [{row,col}]
  function findAll(board, type, side){
    const list = [];
    for(let r=0;r<10;r++) for(let c=0;c<9;c++){
      const p = board.board[r][c];
      if(p && p.type === type && p.side === side) list.push({row:r,col:c});
    }
    return list;
  }

  // 沿 (r0,c0) -> (r1,c0) 之间是否有子（不含两端）
  function hasObstacleBetween(board, r0, r1, col){
    if(r0 > r1){ const t=r0; r0=r1; r1=t; }
    for(let r=r0+1; r<r1; r++) if(board.board[r][col]) return true;
    return false;
  }
  function hasObstacleBetweenH(board, row, c0, c1){
    if(c0 > c1){ const t=c0; c0=c1; c1=t; }
    for(let c=c0+1; c<c1; c++) if(board.board[row][c]) return true;
    return false;
  }

  // ====== 1. 双车错：本方两车同列，且与对方将帅同列、无挡 ======
  // 返回该 side 视角的加分
  function scoreTwoRooks(board, side){
    const rooks = findAll(board, ROOK, side);
    if(rooks.length < 2) return 0;
    const opp = 1 - side;
    const king = board.findKing(opp);
    if(!king) return 0;
    // 两车同列、该列 = 将帅所在列、且无挡
    for(const a of rooks) for(const b of rooks){
      if(a.row === b.row && a.row !== king.row) continue;
      if(a.col !== b.col) continue;
      const col = a.col;
      if(col !== king.col) continue;
      // 该列上只有：己方两车 + 对方将帅（一共三点），中间两行都得空
      if(hasObstacleBetween(board, a.row, king.row, col)) continue;
      return 60; // 双车同列对着对方将帅，几乎必得子（权重上调：必杀级）
    }
    return 0;
  }

  // ====== 2. 白脸将：双方将帅同列、中间无子（送将式强制威胁） ======
  function scoreFaceKing(board, side){
    const k1 = board.findKing(side);
    const k2 = board.findKing(1-side);
    if(!k1 || !k2) return 0;
    if(k1.col !== k2.col) return 0;
    if(hasObstacleBetween(board, k1.row, k2.row, k1.col)) return 0;
    // 谁发起进攻？若我方无挡且能反过来将军 => 强力加分；否则只是被动
    return 80;
  }

  // ====== 3. 卧槽马 ======
  // 马在 3,1 / 3,7（红方）或 6,1 / 6,7（黑方）形成"将"角度；己方有车配合
  function scoreWokao(board, side){
    // 红方卧槽马：(3,1)(3,7)；黑方：(6,1)(6,7)
    const targets = side === SIDE_RED
      ? [{r:3,c:1},{r:3,c:7}]
      : [{r:6,c:1},{r:6,c:7}];
    const opp = 1 - side;
    const oppKing = board.findKing(opp);
    if(!oppKing) return 0;
    let score = 0;
    for(const t of targets){
      const p = board.board[t.r][t.c];
      if(!p || p.type !== HORSE || p.side !== side) continue;
      // 该马下一步可跳到 (t.r - 1, t.c) 或 (t.r + 1, t.c)？
      // 卧槽：将帅在九宫受马将军。简化：只要马在卧槽位、且本方有车贴将，加分
      const rooks = findAll(board, ROOK, side);
      for(const r of rooks){
        // 车与马同行/同列、距离 <= 2 且中间无挡
        if(r.row === t.r && Math.abs(r.col - t.c) <= 2 && !hasObstacleBetweenH(board, t.r, t.c, r.col)){
          score = Math.max(score, 40);
        }
      }
    }
    return score;
  }

  // ====== 4. 钓鱼马：马在将帅侧翼 + 车配合 ======
  // 红方钓鱼马位：(4,2)(4,6) -> 跳 (3,1)/(3,7) 卧槽效果；黑方：(5,2)(5,6)
  function scoreDiaoyu(board, side){
    const targets = side === SIDE_RED
      ? [{r:4,c:2},{r:4,c:6}]
      : [{r:5,c:2},{r:5,c:6}];
    let score = 0;
    for(const t of targets){
      const p = board.board[t.r][t.c];
      if(!p || p.type !== HORSE || p.side !== side) continue;
      const rooks = findAll(board, ROOK, side);
      for(const r of rooks){
        if(r.col === t.c && Math.abs(r.row - t.r) <= 2 && !hasObstacleBetween(board, t.r, r.row, t.c)){
          score = Math.max(score, 30);
        }
      }
    }
    return score;
  }

  // ====== 5. 铁门栓：车锁肋道 + 对方中士/象完整无法解开 ======
  // 简化判定：本方车占 col=3 或 col=5，对方将帅在该列，且该列从车到将之间无子
  // 同时：对方仕/象都在原位（连将难解）
  function scoreIronGate(board, side){
    const opp = 1 - side;
    const oppKing = board.findKing(opp);
    if(!oppKing) return 0;
    const rooks = findAll(board, ROOK, side);
    let best = 0;
    for(const rk of rooks){
      if(rk.col !== 3 && rk.col !== 5) continue;
      if(rk.col !== oppKing.col) continue;
      // 车在肋道，将帅也在该列
      if(hasObstacleBetween(board, rk.row, oppKing.row, rk.col)) continue;
      // 简化：对方缺士象 -> 杀着更强
      const adv = findAll(board, ADVISOR, opp);
      const ele = findAll(board, ELEPHANT, opp);
      let bonus = 45;
      if(adv.length === 0) bonus += 15;
      if(ele.length === 0) bonus += 10;
      best = Math.max(best, bonus);
    }
    return best;
  }

  // ====== 6. 高低兵：本方同列双兵相邻两行，互相掩护 ======
  function scoreHighLowPawn(board, side){
    const pawns = findAll(board, PAWN, side);
    if(pawns.length < 2) return 0;
    // 找两个同行/同列错开 1 行的组合
    let best = 0;
    for(let i=0;i<pawns.length;i++) for(let j=i+1;j<pawns.length;j++){
      const a = pawns[i], b = pawns[j];
      if(a.col !== b.col) continue;
      if(Math.abs(a.row - b.row) !== 1) continue;
      best = Math.max(best, 25);
    }
    return best;
  }

  // ====== 7. 担子炮：双炮同列、中间一子，且本方炮在该炮位吃下一子打对方将帅 ======
  // 简化：双炮同列且之间无子 -> 加分（威慑力强）
  function scoreCannonBattery(board, side){
    const cannons = findAll(board, CANNON, side);
    if(cannons.length < 2) return 0;
    let best = 0;
    for(let i=0;i<cannons.length;i++) for(let j=i+1;j<cannons.length;j++){
      const a = cannons[i], b = cannons[j];
      if(a.col !== b.col) continue;
      // 两炮同列、中间恰好一子（炮架）—— 强攻形态
      let midCount = 0;
      const r0 = Math.min(a.row,b.row), r1 = Math.max(a.row,b.row);
      for(let r=r0+1; r<r1; r++) if(board.board[r][a.col]) midCount++;
      if(midCount === 1) best = Math.max(best, 35);
    }
    return best;
  }

  // ====== 8. 二鬼拍门：双兵入九宫准备攻将 ======
  function scoreTwoGhosts(board, side){
    const pawns = findAll(board, PAWN, side);
    const palaceCols = PALACE_COLS;
    const palaceRows = side === SIDE_RED ? RED_PALACE_ROWS : BLACK_PALACE_ROWS;
    let n = 0;
    for(const pw of pawns){
      if(palaceCols.includes(pw.col) && palaceRows.includes(pw.row)) n++;
    }
    return n >= 2 ? 40 : 0;
  }

  // ====== 9. 空头炮：本方炮占中路且对方无子挡到将（威慑） ======
  function scoreHollowCannon(board,side){
    const opp = 1 - side;
    const oppKing = board.findKing(opp);
    if(!oppKing) return 0;
    if(oppKing.col !== 4) return 0;
    const cannons = findAll(board, CANNON, side);
    let best = 0;
    for(const cn of cannons){
      if(cn.col !== 4) continue;
      // 炮与将之间无挡
      if(hasObstacleBetween(board, cn.row, oppKing.row, 4)) continue;
      best = Math.max(best, 30);
    }
    return best;
  }

  // 综合评分：返回"红方为正、黑方为负"的对称值
  // 调用约定 —— Tactics.detect(board) 直接加到 evaluate() 总分上即可
  // ⚠ 必须是"纯局面函数"：不能依赖 board.turn，否则同一局面在红/黑走时
  //   会得到不同分数，评估函数就不再自洽（旧版在这里踩过坑）。
  function rawFor(board, side){
    let raw = 0;
    raw += scoreTwoRooks(board, side);
    raw += scoreFaceKing(board, side);
    raw += scoreWokao(board, side);
    raw += scoreDiaoyu(board, side);
    raw += scoreIronGate(board, side);
    raw += scoreHighLowPawn(board, side);
    raw += scoreCannonBattery(board, side);
    raw += scoreTwoGhosts(board, side);
    raw += scoreHollowCannon(board, side);
    return raw;
  }

  function detect(board){
    return rawFor(board, SIDE_RED) - rawFor(board, SIDE_BLACK);
  }

  globalThis.Tactics = { detect, _debug:{scoreTwoRooks,scoreFaceKing,scoreWokao,scoreIronGate,scoreTwoGhosts} };
})(typeof window !== 'undefined' ? window : globalThis);