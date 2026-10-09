// ============================================================
// AI 搜索增强
//
// 包含：
//   - install()           战术评分注入（保留旧接口）
//   - quiescence()        静态搜索（吃子+将军延续）
//   - getTacticalMoves()  吃子+将军走法生成
//   - sortTactical2()     强制走法 MVV-LVA 排序
//   - generateMoves()     全部合法走法
//   - orderMoves()        综合排序：杀手走法 + MVV-LVA + 历史启发
//   - ab()                alpha-beta + 置换表 + 杀手/历史/回溯
//   - resetHeuristics()    清空杀手走法/历史表（每次搜索前）
//
// 依赖：ChessBoard、PIECE_VALUE、KING/.../PAWN、SIDE_RED/SIDE_BLACK、
//       Tactics、TT
// ============================================================
(function(global){
  'use strict';

  // ===== 战术评分注入 =====
  function installTacticsIntoEvaluate(){
    if(!globalThis.ChessBoard) return false;
    const proto = globalThis.ChessBoard.prototype;
    if(proto.__tacticsPatched) return true;
    const orig = proto.evaluate;
    proto.evaluate = function(){
      const s = orig.call(this);
      if(globalThis.Tactics && globalThis.Tactics.detect){
        try{ return s + globalThis.Tactics.detect(this); }
        catch(e){ return s; }
      }
      return s;
    };
    proto.__tacticsPatched = true;
    return true;
  }

  // ===== 走法生成 =====
  function generateMoves(board, side){
    const moves = [];
    for(const p of board.getPieces(side)){
      const legals = board.getLegalMoves(p.row, p.col);
      for(const m of legals){
        moves.push({ fr:p.row, fc:p.col, tr:m.row, tc:m.col });
      }
    }
    return moves;
  }

  // ===== 取本方所有"强制着法"：吃子 + 将军 =====
  function getTacticalMoves(board, side){
    const moves = [];
    for(const p of board.getPieces(side)){
      const raws = board.getRawMoves(p.row, p.col);
      for(const m of raws){
        const target = board.board[m.row][m.col];
        if(target && target.side !== side){
          moves.push({ fr:p.row, fc:p.col, tr:m.row, tc:m.col, kind:'cap',
                              capVal: PIECE_VALUE[target.type] });
        } else {
          const c = board.clone();
          c.move(p.row, p.col, m.row, m.col);
          if(c.inCheck(1-side)){
            moves.push({ fr:p.row, fc:p.col, tr:m.row, tc:m.col, kind:'check' });
          }
        }
      }
    }
    return moves;
  }

  // ===== 强制走法排序 =====
  function sortTactical2(board, moves){
    moves.sort((a,b)=>{
      const va = board.board[a.tr][a.tc] ? PIECE_VALUE[board.board[a.tr][a.tc].type] : 0;
      const vb = board.board[b.tr][b.tc] ? PIECE_VALUE[board.board[b.tr][b.tc].type] : 0;
      const ka = va && (board.board[a.tr][a.tc].type===KING) ? 2 : 0;
      const kb = vb && (board.board[b.tr][b.tc].type===KING) ? 2 : 0;
      if(va !== vb) return vb - va;
      return kb - ka;
    });
  }

  // ===== 静态搜索 =====
  function quiescence(board, alpha, beta, side, ctx){
    ctx = ctx || {};
    if(Date.now() - (ctx.startTime||0) > (ctx.timeLimit||1e9)){
      return board.evaluate();
    }
    const stand_pat = board.evaluate();
    if(side === SIDE_RED){
      if(stand_pat >= beta) return beta;
      if(stand_pat > alpha) alpha = stand_pat;
    } else {
      if(stand_pat <= alpha) return alpha;
      if(stand_pat < beta) beta = stand_pat;
    }
    const moves = getTacticalMoves(board, side);
    if(moves.length === 0) return stand_pat;
    sortTactical2(board, moves);
    const qDepth = (ctx.qDepth || 0);
    if(qDepth >= (ctx.qMax || 8)) return stand_pat;

    let localAlpha = alpha, localBeta = beta;
    for(const m of moves){
      const c = board.clone();
      c.move(m.fr, m.fc, m.tr, m.tc);
      const s = -quiescence(c, -localBeta, -localAlpha, 1-side,
        Object.assign({}, ctx, { qDepth: qDepth+1 }));
      if(side === SIDE_RED){
        if(s >= localBeta) return localBeta;
        if(s > localAlpha) localAlpha = s;
      } else {
        if(s <= localAlpha) return localAlpha;
        if(s < localBeta) localBeta = s;
      }
    }
    return side === SIDE_RED ? localAlpha : localBeta;
  }

  // ===== 杀手走法 + 历史启发 =====
  // 杀手走法表：killers[depth] = [move1, move2]
  const killers = {};
  // 历史表：history["fr,fc,tr,tc"] = int
  const history = {};

  function historyKey(m){
    return m.fr*9000 + m.fc*100 + m.tr*10 + m.tc;
  }

  function isSameMove(a, b){
    return a && b && a.fr===b.fr && a.fc===b.fc && a.tr===b.tr && a.tc===b.tc;
  }

  function storeKiller(depth, m){
    if(!killers[depth]) killers[depth] = [];
    const arr = killers[depth];
    if(arr.length === 0){
      arr.push(m);
    } else if(!isSameMove(arr[0], m)){
      arr.unshift(m);
      if(arr.length > 2) arr.pop();
    }
  }

  function recordHistory(m, depth){
    const k = historyKey(m);
    history[k] = (history[k] || 0) + depth * depth;
  }

  // 综合排序：杀手走法 + MVV-LVA + 历史
  function orderMoves(board, moves, depth){
    const ks = killers[depth] || [];
    moves.sort((a, b) => {
      // 1) 杀手走法优先
      const aIsK = isKillerInArr(a, ks) ? 1 : 0;
      const bIsK = isKillerInArr(b, ks) ? 1 : 0;
      if(aIsK !== bIsK) return bIsK - aIsK;
      // 2) MVV-LVA（吃子按被吃子价值）
      const va = board.board[a.tr][a.tc] ? PIECE_VALUE[board.board[a.tr][a.tc].type] : 0;
      const vb = board.board[b.tr][b.tc] ? PIECE_VALUE[board.board[b.tr][b.tc].type] : 0;
      if(va !== vb) return vb - va;
      // 3) 历史
      const ha = history[historyKey(a)] || 0;
      const hb = history[historyKey(b)] || 0;
      return hb - ha;
    });
  }
  function isKillerInArr(m, ks){
    for(let i=0;i<ks.length;i++) if(isSameMove(ks[i], m)) return true;
    return false;
  }

  function resetHeuristics(){
    for(const k in killers) delete killers[k];
    for(const k in history) delete history[k];
  }

  // ===== Alpha-Beta 搜索（带 TT + 杀手/历史） =====
  // side: SIDE_RED=0 / SIDE_BLACK=1
  function ab(board, depth, alpha, beta, side, ctx){
    ctx = ctx || {};
    const startTime = ctx.startTime || 0;
    const timeLimit = ctx.timeLimit || 1e9;
    let timeUp = false;

    // 时间检查
    if(Date.now() - startTime > timeLimit){
      return board.evaluate();
    }

    // TT probe
    let zHash = 0;
    let tte = null;
    if(globalThis.TT){
      zHash = globalThis.TT.hash(board);
      tte = globalThis.TT.probe(zHash, depth, alpha, beta);
      if(tte){
        ctx.lastBestMove = tte.bestMove;
        return tte.score;
      }
    }

    // 叶子节点走静态搜索
    if(depth <= 0){
      return quiescence(board, alpha, beta, side, ctx);
    }

    // 走法生成
    const moves = generateMoves(board, side);
    if(moves.length === 0){
      return -99999 - depth;
    }

    // 排序：杀手 + MVV-LVA + 历史
    orderMoves(board, moves, depth);
    // TT bestMove 优先
    if(globalThis.TT) globalThis.TT.moveOrder(board, moves);

    const origAlpha = alpha;
    let bestScore = alpha;
    let bestMove = null;
    for(const m of moves){
      if(Date.now() - startTime > timeLimit){
        timeUp = true;
        break;
      }
      const c = board.clone();
      c.move(m.fr, m.fc, m.tr, m.tc);
      const score = -ab(c, depth-1, -beta, -bestScore, 1-side, ctx);
      if(score > bestScore){
        bestScore = score;
        bestMove = m;
      }
      if(bestScore >= beta){
        storeKiller(depth, m);
        recordHistory(m, depth);
        break;
      }
    }

    // TT store：即使 timeUp 也要保留已搜索的结果（bestMove != null）
    if(globalThis.TT && bestMove){
      let flag = 'EXACT';
      if(timeUp) flag = 'UPPER';  // timeUp 时只保证下界
      else if(bestScore <= origAlpha) flag = 'UPPER';
      else if(bestScore >= beta) flag = 'LOWER';
      globalThis.TT.store(zHash, depth, bestScore, flag, bestMove);
    }

    return bestScore;
  }

  // ===== 顶层迭代加深入口（暴露给 ChessAI 调用） =====
  // AI 走子方为 board.turn，调用 ab 时 1-side
  // 返回 { move, score, depth }
  function iterativeDeepening(board, maxDepth, ctx){
    const side = board.turn;
    let bestMove = null;
    let bestScore = -Infinity;
    let lastBest = null;
    let lastScore = -Infinity;
    let reachedDepth = 0;

    for(let d = 1; d <= maxDepth; d++){
      if(Date.now() - ctx.startTime > ctx.timeLimit) break;

      // 走法生成
      const moves = generateMoves(board, side);
      if(moves.length === 0) break;

      // PV first：上一轮 bestMove
      if(lastBest){
        for(let i=1;i<moves.length;i++){
          if(isSameMove(moves[i], lastBest)){
            const tmp = moves[0]; moves[0] = moves[i]; moves[i] = tmp;
            break;
          }
        }
      }
      // TT bestMove first
      if(globalThis.TT) globalThis.TT.moveOrder(board, moves);
      // 杀手/历史排序
      orderMoves(board, moves, d);

      let localBest = null;
      let localScore = -Infinity;
      let alpha = -Infinity, beta = Infinity;

      for(const m of moves){
        if(Date.now() - ctx.startTime > ctx.timeLimit) break;
        const c = board.clone();
        c.move(m.fr, m.fc, m.tr, m.tc);
        // 立即杀棋
        if(c.isCheckmate()){
          return { move: m, score: 1e5, depth: d };
        }
        const score = -ab(c, d-1, -beta, -alpha, 1-side, ctx);
        if(score > localScore){
          localScore = score;
          localBest = m;
          if(score > alpha) alpha = score;
        }
      }

      if(localBest){
        bestMove = localBest;
        bestScore = localScore;
        lastBest = localBest;
        lastScore = localScore;
        reachedDepth = d;
      }

      // 早停：必胜局面（高分阈值）
      if(bestScore > 90000) break;
    }

    return { move: bestMove, score: bestScore, depth: reachedDepth };
  }

  globalThis.Search = {
    install: installTacticsIntoEvaluate,
    quiescence,
    getTacticalMoves,
    sortTactical2,
    generateMoves,
    orderMoves,
    ab,
    iterativeDeepening,
    resetHeuristics,
    storeKiller,
    recordHistory,
    isSameMove,
  };
})(typeof window !== 'undefined' ? window : globalThis);