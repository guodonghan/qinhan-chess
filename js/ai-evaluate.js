// ============================================================
// 评估函数增强
//
//  包含：
//    1. 阶段感（开局/中局/残局）
//    2. 子力价值动态化（残局马比车值钱、兵值钱）
//    3. 将军感知（主动将军奖励、被将军惩罚）
//    4. 将帅安全（缺士象扣分、对方有车威胁）
//    5. 残局面知识（单车难破士象全、双车必胜等）
//
//  依赖：ChessBoard、PIECE_VALUE、KING/ADVISOR/ELEPHANT/HORSE/ROOK/CANNON/PAWN、
//        SIDE_RED/SIDE_BLACK、Tactics
//
//  安装：
//    EvalEnhancer.install() —— 在 Tactics / Search 注入之后调用，
//                             否则会丢掉之前的注入。
// ============================================================
(function(global){
  'use strict';

  // 工具：countByType(board) -> [type: 总子力数]
  function countByType(board){
    const c = [0,0,0,0,0,0,0];
    for(let r=0;r<10;r++) for(let cc=0;cc<9;cc++){
      const p = board.board[r][cc];
      if(p) c[p.type]++;
    }
    return c;
  }
  // countBySideType(board, side, type) -> int
  function countSideType(board, side, type){
    let n = 0;
    for(let r=0;r<10;r++) for(let c=0;c<9;c++){
      const p = board.board[r][c];
      if(p && p.side === side && p.type === type) n++;
    }
    return n;
  }

  // ============ 1. 阶段感 ============
  // open/middle/end
  function getPhase(board){
    let total = 0, major = 0;
    for(let r=0;r<10;r++) for(let c=0;c<9;c++){
      const p = board.board[r][c];
      if(!p) continue;
      total++;
      // 主力：车马炮
      if(p.type === HORSE || p.type === ROOK || p.type === CANNON) major++;
    }
    if(total >= 30 && major >= 8) return 'open';
    if(total >= 18) return 'middle';
    return 'end';
  }

  // ============ 2. 子力价值动态化 ============
  // type 索引: 0=KING 1=ADVISOR 2=ELEPHANT 3=HORSE 4=ROOK 5=CANNON 6=PAWN
  // 返回各阶段下每个 type 相对 PIECE_VALUE 的乘子
  function phaseWeight(phase){
    if(phase === 'open'){
      return [1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00];
    }
    if(phase === 'middle'){
      return [1.00, 1.00, 1.00, 1.00, 1.05, 1.05, 1.10];
    }
    // end 残局
    //   - 兵卒：残局过河能攻将，价值激增
    //   - 马：残局空间小+能吃车，八分天下其三
    //   - 炮：残局减少炮架，价值略降（保留 1.10 以保留分量）
    //   - 车：略升
    return [1.00, 1.05, 1.05, 1.25, 1.10, 1.05, 1.80];
  }

  // 返回棋盘所有子在当前阶段下的子力加权偏移（symmetric to PIECE_VALUE）
  // 即：原 evaluate 用 PIECE_VALUE[p.type]*sign，我们返回 (w-1)*PIECE_VALUE[p.type]*sign 的累加
  function phaseBonus(board){
    const phase = getPhase(board);
    const w = phaseWeight(phase);
    let s = 0;
    for(let r=0;r<10;r++) for(let c=0;c<9;c++){
      const p = board.board[r][c];
      if(!p) continue;
      const sign = p.side === SIDE_RED ? 1 : -1;
      const factor = w[p.type];
      s += sign * PIECE_VALUE[p.type] * (factor - 1);
    }
    return s;
  }

  // ============ 3. 将帅安全 ============
  // 缺士/象：扣分（每缺一士/象扣 8 分）
  // 对方有车：己方将帅粗暴暴露，扣 12 分
  function kingSafety(board){
    let s = 0;
    for(const side of [SIDE_RED, SIDE_BLACK]){
      const sign = side === SIDE_RED ? 1 : -1;
      const opp = 1 - side;
      const adv = countSideType(board, side, ADVISOR);
      const ele = countSideType(board, side, ELEPHANT);
      // 完整 = 士 2 + 象 2 = 4
      const missing = 4 - (adv + ele);
      if(missing > 0) s -= sign * missing * 8;
      // 对方有车：己方帅位危险
      const oppRook = countSideType(board, opp, ROOK);
      if(oppRook > 0){
        // 对方没象则威胁更大（车不被象挡）
        const oppHasElephant = countSideType(board, opp, ELEPHANT) > 0;
        if(!oppHasElephant) s -= sign * 18;
        else s -= sign * 10;
      }
      // 对方有炮：抽将压力
      const oppCannon = countSideType(board, opp, CANNON);
      if(oppCannon > 0) s -= sign * 5;
    }
    return s;
  }

  // ============ 4. 将军感知 ============
  // ⚠ 同样必须是纯局面函数：只按"谁被将"判分，不能看 board.turn。
  //   旧版用 board.turn 判定"己方"，导致同一个局面在红走/黑走时得分不同。
  // 被将军的一方扣 50（红方为正的对称值）
  function checkBonus(board){
    let s = 0;
    try{
      if(board.inCheck(SIDE_RED)) s -= 50;
      if(board.inCheck(SIDE_BLACK)) s += 50;
    } catch(e){}
    return s;
  }

  // ============ 5. 残局面知识 ============
  // 仅在 end 阶段生效。
  // 给出常见残局面（"红方走子方"为视角）的先验估值：
  //   - 单车难破士象全：-50
  //   - 双车 vs 士象全：+200（必胜）
  //   - 双马 vs 双士：+200（必胜）
  //   - 双象 vs 单士：+150（必胜）
  //   - 单车 vs 单马：-15（车略强但马能守和）
  //   - 单马 vs 单士象：和棋 0
  //   - 单炮 vs 单士：和棋 0
  //   - 单兵过河 vs 无士象：+30（带将死威胁）
  // 注意：返回值仍是"红方为正、黑方为负"的对称值
  function residueBonus(board){
    const phase = getPhase(board);
    if(phase !== 'end') return 0;
    const rc = countSideType(board, SIDE_RED, ROOK);
    const rm = countSideType(board, SIDE_RED, HORSE);
    const rx = countSideType(board, SIDE_RED, ELEPHANT);
    const ra = countSideType(board, SIDE_RED, ADVISOR);
    const rp = countSideType(board, SIDE_RED, CANNON);
    const rpPawn = countSideType(board, SIDE_RED, PAWN);
    const bc = countSideType(board, SIDE_BLACK, ROOK);
    const bm = countSideType(board, SIDE_BLACK, HORSE);
    const bx = countSideType(board, SIDE_BLACK, ELEPHANT);
    const ba = countSideType(board, SIDE_BLACK, ADVISOR);
    const bp = countSideType(board, SIDE_BLACK, CANNON);
    const bpPawn = countSideType(board, SIDE_BLACK, PAWN);
    // 总主力量（车马炮）
    const redMain = rc + rp + rm;
    const blkMain = bc + bp + bm;

    let s = 0;
    // ===== 红方为强方（黑方无主力） =====
    if(blkMain === 0 && redMain > 0){
      const blkDefense = ba + bx + (bpPawn > 0 ? 1 : 0);  // 黑方的防御力
      if(rc === 1 && redMain === 1){
        // 单车 vs 无主力的黑方：黑方有士象全则红方难赢
        if(blkDefense >= 4) s -= 50;        // 单车难破士象全
        else if(blkDefense >= 2) s += 30;   // 缺一士/象：可胜但需细致
        else s += 80;                        // 几乎裸奔：必胜
      }
      if(rc === 2 && redMain === 2){
        // 双车 vs 黑方士象全（黑方无主力）：必胜
        if(blkDefense >= 4) s += 200;
        else s += 250;
      }
      if(rm === 2 && redMain === 2){
        // 双马 vs 双士（黑方无象、无主力）：必胜
        if(ba === 2 && bx === 0) s += 200;
        else s += 80;
      }
      if(rx === 2 && redMain === 0){
        // 双象 vs 单士：必胜
        if(ba === 1) s += 150;
        else if(ba === 0) s += 200;
        else s += 30;
      }
      if(rp === 1 && redMain === 1){
        // 单炮 vs 单士
        if(ba === 1) s -= 20;  // 和棋
        else s += 80;
      }
      if(rm === 1 && redMain === 1){
        // 单马 vs 单士
        if(ba === 1) s -= 10;  // 马不胜单士
        else s += 30;
      }
      if(rpPawn >= 1 && redMain === 0){
        // 单/多兵无主力：有士象防御也难赢
        const totalPawnVal = rpPawn * 10;
        s += totalPawnVal;
        if(blkDefense === 4) s -= 50;
      }
    }

    // ===== 黑方为强方（红方无主力）=====
    if(redMain === 0 && blkMain > 0){
      // 镜像：用负号翻转
      s -= residueBonusMirror(rc, rm, rx, ra, rp, rpPawn,
                              bc, bm, bx, ba, bp, bpPawn);
    }

    // ===== 双车 vs 双车简化估值（车换车不会大幅改变估值）=====
    if(rc >= 1 && bc >= 1 && rm === 0 && bm === 0){
      // 双车对双车：相等 +10 鼓励保车
      s += 10 * (rc - bc);
    }

    // ===== 多兵 vs 少兵的残局优势 =====
    const pawnDiff = rpPawn - bpPawn;
    if(Math.abs(pawnDiff) >= 1){
      s += pawnDiff * 15;  // 每多一个兵加 15
    }

    return s;
  }

  // 镜像函数（黑方为强方时调用，参数顺序为红→黑）
  function residueBonusMirror(rc, rm, rx, ra, rp, rpn, bc, bm, bx, ba, bp, bpn){
    // 重新调用自己但 swap 红黑参数 → 但为避免循环，简单手写
    let s = 0;
    const redMain = rc + rp + rm;
    const blkMain = bc + bp + bm;
    if(redMain === 0 && blkMain > 0){
      const redDefense = ra + rx + (rpn > 0 ? 1 : 0);
      if(bc === 1 && blkMain === 1){
        if(redDefense >= 4) s += 50;
        else if(redDefense >= 2) s -= 30;
        else s -= 80;
      }
      if(bc === 2 && blkMain === 2){
        if(redDefense >= 4) s -= 200;
        else s -= 250;
      }
      if(bm === 2 && blkMain === 2){
        if(ra === 2 && rx === 0) s -= 200;
        else s -= 80;
      }
      if(bx === 2 && blkMain === 0){
        if(ra === 1) s -= 150;
        else if(ra === 0) s -= 200;
        else s -= 30;
      }
      if(bp === 1 && blkMain === 1){
        if(ra === 1) s += 20;
        else s -= 80;
      }
      if(bm === 1 && blkMain === 1){
        if(ra === 1) s += 10;
        else s -= 30;
      }
      if(bpn >= 1 && blkMain === 0){
        const totalPawnVal = bpn * 10;
        s -= totalPawnVal;
        if(redDefense === 4) s += 50;
      }
    }
    return s;
  }

  // ============ 安装 ============
  // 把以上增强注入到 ChessBoard.prototype.evaluate
  function install(){
    if(!globalThis.ChessBoard) return false;
    const proto = globalThis.ChessBoard.prototype;
    if(proto.__evalEnhanced) return true;
    const orig = proto.evaluate;  // 已经是 Tactics 注入过的
    proto.evaluate = function(){
      let s = 0;
      try{ s = orig.call(this); } catch(e){ return 0; }
      try{
        s += phaseBonus(this);
        s += checkBonus(this);
        s += kingSafety(this);
        s += residueBonus(this);
      } catch(e){}
      return s;
    };
    proto.__evalEnhanced = true;
    return true;
  }

  globalThis.EvalEnhancer = {
    install, getPhase, phaseWeight, phaseBonus,
    kingSafety, checkBonus, residueBonus,
    countByType, countSideType,
  };
})(typeof window !== 'undefined' ? window : globalThis);