// ============================================================
// ai-engine.js —— 高速象棋搜索引擎（替换 ChessAI + Search 的旧路径）
//
// 为什么重写：
//   旧实现每生成一个着法就要 clone() 一次整盘（90 个对象），
//   静态搜索还会递归 8 层"吃子+将军"，实测一个节点要 25 次 clone。
//   结果：深度 1 就要 200 秒，任何时限下都只能搜到深度 1，
//   于是 4 个难度全部返回同一个"着法列表第一个"，既笨又没有分级。
//
// 本引擎的做法：
//   - 定长数组表示棋盘 + make/unmake，**零 clone、零分配**
//   - 攻击检测直接几何判定，不做子力枚举
//   - 静态搜索只走吃子（被将时走全部应将），深度有限
//   - Alpha-Beta + 置换表 + 杀手着法 + 历史启发 + 空着裁剪
//   - 迭代加深，只接受"完整跑完"的那一层，超时不会交半成品
//   - 每个难度有独立的 深度上限 / 时间预算 / 着法容差(slack)
//
// 对外开放：
//   AIEngine.pickMove(board, {level, timeLimit, protectedKing, seed})
//     -> {fr, fc, tr, tc, score, depth, nodes, ms, level}
// ============================================================
(function (global) {
  'use strict';

  // ---------------- 常量 ----------------
  const KING = 0, ADVISOR = 1, ELEPHANT = 2, HORSE = 3, ROOK = 4, CANNON = 5, PAWN = 6;
  const RED = 0, BLACK = 1;
  const MATE = 1000000, INF = 2000000;
  const MAXPLY = 256;

  const RI = new Int8Array(90), CI = new Int8Array(90);
  for (let i = 0; i < 90; i++) { RI[i] = (i / 9) | 0; CI[i] = i % 9; }
  const mk = (from, to) => (from << 7) | to;
  const mvFrom = m => m >> 7;
  const mvTo = m => m & 127;

  // ---------------- 棋盘状态 ----------------
  const T = new Int8Array(90);   // 类型，-1 = 空
  const S = new Int8Array(90);   // 阵营，-1 = 空
  const KF = new Int8Array(90);  // 1=lordKing 2=innerKing（都会改变走法）
  const Ksq = [-1, -1];
  let turn = RED, key = 0, sp = 0;
  let PROT = null;               // Int8Array(2)：该方将帅"不可被吃"（心腹局）

  const uFrom = new Int32Array(MAXPLY), uTo = new Int32Array(MAXPLY);
  const uCapT = new Int8Array(MAXPLY), uCapS = new Int8Array(MAXPLY), uCapF = new Int8Array(MAXPLY);
  const uKey = new Int32Array(MAXPLY);
  const uCapKsq = new Int32Array(MAXPLY);   // -2 = 该步没吃将帅类子

  // ---------------- Zobrist ----------------
  const Z = new Int32Array(2 * 7 * 4 * 90);
  let ZTURN = 0;
  (function initZob() {
    let x = 0x9e3779b9;
    const rnd = () => {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      return x | 0;
    };
    for (let i = 0; i < Z.length; i++) Z[i] = rnd();
    ZTURN = rnd();
  })();
  const zIdx = (i) => ((S[i] * 7 + T[i]) * 4 + KF[i]) * 90 + i;

  // ---------------- 评估：子力 + 位置 ----------------
  let PVAL = [10000, 20, 20, 60, 100, 45, 10];
  let PSTF = new Int16Array(7 * 2 * 90);   // [type*2+side][sq]
  let evalReady = false;
  function buildEvalTables() {
    if (evalReady) return;
    if (typeof PIECE_VALUE !== 'undefined') PVAL = PIECE_VALUE;
    if (typeof POS_VALUE === 'function') {
      for (let t = 0; t < 7; t++)
        for (let s = 0; s < 2; s++)
          for (let r = 0; r < 10; r++)
            for (let c = 0; c < 9; c++)
              PSTF[(t * 2 + s) * 90 + r * 9 + c] = POS_VALUE(t, r, c, s);
    }
    evalReady = true;
  }

  // 红方为正的静态评估（纯局面函数，不含"该谁走"）
  function evalRed() {
    let s = 0, dR = 0, dB = 0;
    for (let i = 0; i < 90; i++) {
      const t = T[i];
      if (t < 0) continue;
      const side = S[i];
      const v = PVAL[t] + PSTF[(t * 2 + side) * 90 + i];
      if (side === RED) s += v; else s -= v;
      if (t === ADVISOR || t === ELEPHANT) { if (side === RED) dR++; else dB++; }
    }
    // 将帅护卫：缺士象要扣分（比子力价值更敏感一点，避免"裸奔"）
    s -= (4 - dR) * 6;
    s += (4 - dB) * 6;
    return s;
  }
  const evalFor = (side) => (side === RED ? evalRed() : -evalRed());

  // ---------------- 攻击判定（几何法，不做子力枚举） ----------------
  function attacks(a, k) {
    if (a === k) return false;   // 防御：自身不构成"攻击自己"
    const t = T[a], s = S[a], f = KF[a];
    const r0 = RI[a], c0 = CI[a], r1 = RI[k], c1 = CI[k];
    const dr = r1 - r0, dc = c1 - c0;
    const ad = dr < 0 ? -dr : dr, ac = dc < 0 ? -dc : dc;
    switch (t) {
      case KING:
        if (ad + ac !== 1) return false;
        if (f) return true;
        if (s === RED) return r1 >= 7 && r1 <= 9 && c1 >= 3 && c1 <= 5;
        return r1 >= 0 && r1 <= 2 && c1 >= 3 && c1 <= 5;
      case ADVISOR:
        if (f) return (ad + ac) === 1;
        if (ad !== 1 || ac !== 1) return false;
        if (s === RED) return r1 >= 7 && r1 <= 9 && c1 >= 3 && c1 <= 5;
        return r1 >= 0 && r1 <= 2 && c1 >= 3 && c1 <= 5;
      case ELEPHANT:
        if (f) return (ad + ac) === 1;
        if (ad !== 2 || ac !== 2) return false;
        if (s === RED) { if (r1 < 5 || r1 > 9) return false; }
        else { if (r1 < 0 || r1 > 4) return false; }
        return T[(r0 + (dr > 0 ? 1 : -1)) * 9 + (c0 + (dc > 0 ? 1 : -1))] < 0;
      case HORSE: {
        if (!((ad === 2 && ac === 1) || (ad === 1 && ac === 2))) return false;
        let lr, lc;
        if (ad === 2) { lr = r0 + (dr > 0 ? 1 : -1); lc = c0; }
        else { lr = r0; lc = c0 + (dc > 0 ? 1 : -1); }
        return T[lr * 9 + lc] < 0;
      }
      case ROOK: {
        if (dr !== 0 && dc !== 0) return false;
        const step = dr === 0 ? (dc > 0 ? 1 : -1) : (dr > 0 ? 9 : -9);
        let g = 0;
        for (let i = a + step; i !== k; i += step) { if (++g > 20) break; if (T[i] >= 0) return false; }
        return true;
      }
      case CANNON: {
        if (dr !== 0 && dc !== 0) return false;
        const step = dr === 0 ? (dc > 0 ? 1 : -1) : (dr > 0 ? 9 : -9);
        let cnt = 0, g = 0;
        for (let i = a + step; i !== k; i += step) { if (++g > 20) break; if (T[i] >= 0) cnt++; }
        return cnt === 1;
      }
      case PAWN: {
        const fwd = s === RED ? -1 : 1;
        if (dr === fwd && dc === 0) return true;
        const crossed = s === RED ? r0 <= 4 : r0 >= 5;
        if (crossed && dr === 0 && ac === 1) return true;
        if (f && dr === fwd * 2 && dc === 0) return true;
        return false;
      }
    }
    return false;
  }

  // side 的将帅是否被攻击（找不到将 → 视为已被将，与旧 inCheck 一致）
  function isChecked(side) {
    const k = Ksq[side];
    if (k < 0) return true;
    const opp = 1 - side;
    for (let i = 0; i < 90; i++) {
      if (S[i] !== opp) continue;
      if (attacks(i, k)) return true;
    }
    // 白脸将（将帅照面）
    const ok = Ksq[opp];
    if (ok >= 0 && CI[ok] === CI[k]) {
      const lo = RI[k] < RI[ok] ? RI[k] : RI[ok], hi = RI[k] < RI[ok] ? RI[ok] : RI[k];
      let blocked = false;
      for (let r = lo + 1; r < hi; r++) if (T[r * 9 + CI[k]] >= 0) { blocked = true; break; }
      if (!blocked && !(KF[k] & 1) && !(KF[ok] & 1)) return true;
    }
    return false;
  }

  // ---------------- 着法生成 ----------------
  function canLand(to, side) {
    const tt = T[to];
    if (tt < 0) return true;
    if (S[to] === side) return false;
    if (PROT && (tt === KING || KF[to] !== 0) && PROT[S[to]]) return false;
    return true;
  }

  const STRAIGHT = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];

  // capsOnly=true 时只生成吃子着法（静态搜索用）
  function genMoves(side, buf, off, capsOnly) {
    let n = off;
    for (let i = 0; i < 90; i++) {
      if (S[i] !== side) continue;
      const t = T[i], r = RI[i], c = CI[i], f = KF[i];
      switch (t) {
        case KING:
          if (f) {
            for (let d = 0; d < 4; d++) {
              const nr = r + STRAIGHT[d][0], nc = c + STRAIGHT[d][1];
              if (nr < 0 || nr > 9 || nc < 0 || nc > 8) continue;
              const to = nr * 9 + nc;
              if (capsOnly && T[to] < 0) continue;
              if (canLand(to, side)) buf[n++] = mk(i, to);
            }
          } else {
            const mr = side === RED ? 7 : 0, xr = side === RED ? 9 : 2;
            for (let d = 0; d < 4; d++) {
              const nr = r + STRAIGHT[d][0], nc = c + STRAIGHT[d][1];
              if (nr < mr || nr > xr || nc < 3 || nc > 5) continue;
              const to = nr * 9 + nc;
              if (capsOnly && T[to] < 0) continue;
              if (canLand(to, side)) buf[n++] = mk(i, to);
            }
          }
          break;
        case ADVISOR:
          if (f) {
            for (let d = 0; d < 4; d++) {
              const nr = r + STRAIGHT[d][0], nc = c + STRAIGHT[d][1];
              if (nr < 0 || nr > 9 || nc < 0 || nc > 8) continue;
              const to = nr * 9 + nc;
              if (capsOnly && T[to] < 0) continue;
              if (canLand(to, side)) buf[n++] = mk(i, to);
            }
          } else {
            const mr = side === RED ? 7 : 0, xr = side === RED ? 9 : 2;
            for (let d = 0; d < 4; d++) {
              const nr = r + DIAG[d][0], nc = c + DIAG[d][1];
              if (nr < mr || nr > xr || nc < 3 || nc > 5) continue;
              const to = nr * 9 + nc;
              if (capsOnly && T[to] < 0) continue;
              if (canLand(to, side)) buf[n++] = mk(i, to);
            }
          }
          break;
        case ELEPHANT:
          if (f) {
            for (let d = 0; d < 4; d++) {
              const nr = r + STRAIGHT[d][0], nc = c + STRAIGHT[d][1];
              if (nr < 0 || nr > 9 || nc < 0 || nc > 8) continue;
              const to = nr * 9 + nc;
              if (capsOnly && T[to] < 0) continue;
              if (canLand(to, side)) buf[n++] = mk(i, to);
            }
          } else {
            const mr = side === RED ? 5 : 0, xr = side === RED ? 9 : 4;
            for (let d = 0; d < 4; d++) {
              const nr = r + DIAG[d][0] * 2, nc = c + DIAG[d][1] * 2;
              if (nr < mr || nr > xr || nc < 0 || nc > 8) continue;
              const er = r + DIAG[d][0], ec = c + DIAG[d][1];
              if (T[er * 9 + ec] >= 0) continue;
              const to = nr * 9 + nc;
              if (capsOnly && T[to] < 0) continue;
              if (canLand(to, side)) buf[n++] = mk(i, to);
            }
          }
          break;
        case HORSE:
          for (let d = 0; d < 8; d++) {
            const nr = r + KNIGHT[d][0], nc = c + KNIGHT[d][1];
            if (nr < 0 || nr > 9 || nc < 0 || nc > 8) continue;
            const lr = r + (KNIGHT[d][0] === 2 ? 1 : KNIGHT[d][0] === -2 ? -1 : 0);
            const lc = c + (KNIGHT[d][1] === 2 ? 1 : KNIGHT[d][1] === -2 ? -1 : 0);
            if (T[lr * 9 + lc] >= 0) continue;
            const to = nr * 9 + nc;
            if (capsOnly && T[to] < 0) continue;
            if (canLand(to, side)) buf[n++] = mk(i, to);
          }
          break;
        case ROOK:
          for (let d = 0; d < 4; d++) {
            let nr = r + STRAIGHT[d][0], nc = c + STRAIGHT[d][1];
            while (nr >= 0 && nr < 10 && nc >= 0 && nc < 9) {
              const to = nr * 9 + nc;
              if (T[to] < 0) { if (!capsOnly) buf[n++] = mk(i, to); }
              else { if (canLand(to, side)) buf[n++] = mk(i, to); break; }
              nr += STRAIGHT[d][0]; nc += STRAIGHT[d][1];
            }
          }
          break;
        case CANNON:
          for (let d = 0; d < 4; d++) {
            let nr = r + STRAIGHT[d][0], nc = c + STRAIGHT[d][1], jumped = false;
            while (nr >= 0 && nr < 10 && nc >= 0 && nc < 9) {
              const to = nr * 9 + nc;
              if (!jumped) {
                if (T[to] < 0) { if (!capsOnly) buf[n++] = mk(i, to); }
                else jumped = true;
              } else if (T[to] >= 0) {
                if (canLand(to, side)) buf[n++] = mk(i, to);
                break;
              }
              nr += STRAIGHT[d][0]; nc += STRAIGHT[d][1];
            }
          }
          break;
        case PAWN: {
          const fwd = side === RED ? -1 : 1;
          const nr = r + fwd;
          if (nr >= 0 && nr < 10) {
            const to = nr * 9 + c;
            if ((!capsOnly || T[to] >= 0) && canLand(to, side)) buf[n++] = mk(i, to);
          }
          const crossed = side === RED ? r <= 4 : r >= 5;
          if (crossed) {
            for (let dc = -1; dc <= 1; dc += 2) {
              const nc = c + dc;
              if (nc < 0 || nc > 8) continue;
              const to = r * 9 + nc;
              if ((!capsOnly || T[to] >= 0) && canLand(to, side)) buf[n++] = mk(i, to);
            }
          }
          if (f) {
            const nr2 = r + fwd * 2;
            if (nr2 >= 0 && nr2 < 10) {
              const to = nr2 * 9 + c;
              if ((!capsOnly || T[to] >= 0) && canLand(to, side)) buf[n++] = mk(i, to);
            }
          }
          break;
        }
      }
    }
    return n;
  }

  // ---------------- make / unmake ----------------
  function make(m) {
    const from = m >> 7, to = m & 127;
    if (sp >= MAXPLY) return false;
    const capT = T[to], capS = S[to], capF = KF[to];
    uKey[sp] = key; uFrom[sp] = from; uTo[sp] = to;
    uCapT[sp] = capT; uCapS[sp] = capS; uCapF[sp] = capF;
    // 吃掉的是"将帅类"子 → 暂时标记该方没有将帅，否则 Ksq 会指向已被占用的格子
    if (capT >= 0 && (capT === KING || capF !== 0)) {
      uCapKsq[sp] = Ksq[capS]; Ksq[capS] = -1;
    } else uCapKsq[sp] = -2;
    sp++;

    key ^= Z[zIdx(from)];
    if (capT >= 0) key ^= Z[zIdx(to)];
    T[to] = T[from]; S[to] = S[from]; KF[to] = KF[from];
    key ^= Z[zIdx(to)];
    if (T[from] === KING || KF[from] !== 0) Ksq[S[from]] = to;
    T[from] = -1; S[from] = -1; KF[from] = 0;
    key ^= ZTURN;
    turn ^= 1;
    return true;
  }
  function unmake() {
    sp--;
    if (uCapKsq[sp] !== -2) Ksq[uCapS[sp]] = uCapKsq[sp];
    const from = uFrom[sp], to = uTo[sp];
    const capT = uCapT[sp], capS = uCapS[sp], capF = uCapF[sp];
    if (T[to] === KING || KF[to] !== 0) Ksq[S[to]] = from;
    T[from] = T[to]; S[from] = S[to]; KF[from] = KF[to];
    T[to] = capT; S[to] = capS; KF[to] = capF;
    key = uKey[sp];
    turn ^= 1;
  }

  // ---------------- 置换表 ----------------
  const TTBITS = 19, TTSIZE = 1 << TTBITS, TTMASK = TTSIZE - 1;
  const ttKey = new Int32Array(TTSIZE), ttMove = new Int32Array(TTSIZE);
  const ttScore = new Int32Array(TTSIZE), ttMeta = new Int8Array(TTSIZE);

  function ttStore(depth, score, flag, move, ply) {
    if (depth < 0) return;
    let sc = score;
    if (sc > MATE - 1000) sc += ply; else if (sc < -(MATE - 1000)) sc -= ply;
    const i = key & TTMASK;
    const meta = (((depth > 60 ? 60 : depth) + 1) << 2) | flag;
    if (ttKey[i] === key && ttMeta[i] !== 0 && ((ttMeta[i] >> 2) - 1) > depth) return;
    ttKey[i] = key; ttScore[i] = sc; ttMeta[i] = meta; ttMove[i] = move;
  }
  function ttProbe(depth, alpha, beta, ply) {
    const i = key & TTMASK;
    if (ttMeta[i] === 0 || ttKey[i] !== key) return null;
    if (((ttMeta[i] >> 2) - 1) < depth) return null;
    const flag = ttMeta[i] & 3;
    let sc = ttScore[i];
    if (sc > MATE - 1000) sc -= ply; else if (sc < -(MATE - 1000)) sc += ply;
    if (flag === 0) return sc;
    if (flag === 1 && sc >= beta) return sc;
    if (flag === 2 && sc <= alpha) return sc;
    return null;
  }
  function ttBestMove() {
    const i = key & TTMASK;
    if (ttMeta[i] === 0 || ttKey[i] !== key) return 0;
    return ttMove[i];
  }
  function ttClear() { ttKey.fill(0); ttMeta.fill(0); ttMove.fill(0); ttScore.fill(0); }

  // ---------------- 启发 ----------------
  const killers = new Int32Array(MAXPLY * 2);
  const hist = new Int32Array(90 * 90);
  function resetHeur() { killers.fill(0); hist.fill(0); }

  const MB = new Int32Array(MAXPLY * 160);
  function mbuf(ply) { return MB.subarray(ply * 160, ply * 160 + 160); }

  function scoreMove(m, ply) {
    const to = m & 127, from = m >> 7;
    const victim = T[to];
    let sc = 0;
    if (victim >= 0) sc = 1000000 + PVAL[victim] - PVAL[T[from]];
    if (m === killers[ply * 2]) sc += 500000;
    else if (m === killers[ply * 2 + 1]) sc += 400000;
    sc += hist[from * 90 + to];
    return sc;
  }
  function orderMoves(buf, off, n, ply, ttMove) {
    const arr = buf.subarray(off, n);
    const sc = new Int32Array(n - off);
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i];
      sc[i] = (m === ttMove) ? 2000000 : scoreMove(m, ply);
    }
    for (let i = 1; i < arr.length; i++) {
      const k = sc[i], km = arr[i];
      let j = i - 1;
      while (j >= 0 && sc[j] < k) { sc[j + 1] = sc[j]; arr[j + 1] = arr[j]; j--; }
      sc[j + 1] = k; arr[j + 1] = km;
    }
  }

  // ---------------- 搜索状态 ----------------
  let nodes = 0, deadline = 0, aborted = false, qMax = 4, maxDepth = 4, plyLimit = 40;
  let nodeCap = 4e6;

  function timeUp() {
    if (aborted) return true;
    if (nodes > nodeCap) { aborted = true; return true; }
    if (Date.now() > deadline) { aborted = true; return true; }
    return false;
  }

  function qsearch(alpha, beta, ply, qd) {
    if ((++nodes & 1023) === 0 && timeUp()) return 0;
    if (aborted) return 0;
    if (ply >= plyLimit) return evalFor(turn);

    const side = turn;
    const inChk = isChecked(side);
    let best;
    if (inChk) {
      best = -INF;
    } else {
      const stand = evalFor(side);
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      best = stand;
      if (qd <= 0) return best;
    }

    const buf = mbuf(ply);
    let n = genMoves(side, buf, 0, !inChk);
    if (inChk && n === 0) return -MATE + ply;

    orderMoves(buf, 0, n, ply, 0);
    let legalCnt = 0;
    for (let i = 0; i < n; i++) {
      const m = buf[i];
      const to = m & 127, from = m >> 7;
      // Delta 剪枝：吃回来的子都不够本就不看
      if (!inChk) {
        const victim = T[to];
        if (victim >= 0 && best + PVAL[victim] + 200 < alpha) continue;
      }
      if (!make(m)) break;
      if (isChecked(side)) { unmake(); continue; }
      legalCnt++;
      const sc = -qsearch(-beta, -alpha, ply + 1, inChk ? qd : qd - 1);
      unmake();
      if (aborted) return 0;
      if (sc > best) {
        best = sc;
        if (sc > alpha) alpha = sc;
        if (alpha >= beta) break;
      }
    }
    // 被将时必须找到解将着法；一个都找不到才是被杀
    if (inChk && legalCnt === 0) return -MATE + ply;
    return best;
  }

  function negamax(depth, alpha, beta, ply, allowNull) {
    if ((++nodes & 1023) === 0 && timeUp()) return 0;
    if (aborted) return 0;
    if (ply >= plyLimit) return evalFor(turn);
    if (Ksq[turn] < 0) return -MATE + ply;

    const side = turn;
    const inChk = isChecked(side);

    // 注意：这里**不能**做"被将就加深一层"的延伸。
    // 一旦延伸，depth 在连续将军的线路上永不衰减，搜索树会无限加深
    // （实测：一进入这种局面就再也跑不完）。被将线路交由静态搜索处理。

    if (depth <= 0) return qsearch(alpha, beta, ply, qMax);

    const ttm = ttProbe(depth, alpha, beta, ply);
    if (ttm !== null) return ttm;

    // 空着裁剪：不在被将、有足够子力、不在连续空着时
    if (allowNull && !inChk && depth >= 3 && ply > 0 &&
        (beta < MATE - 1000) && hasHeavyMaterial(side)) {
      const savedKey = key, savedTurn = turn;
      // 简单"空着"：只翻转走子权
      const savedKsq = Ksq[side];
      key ^= ZTURN; turn ^= 1;
      const sc = -negamax(depth - 3, -beta, -beta + 1, ply + 1, false);
      turn = savedTurn; key = savedKey; Ksq[side] = savedKsq;
      if (aborted) return 0;
      if (sc >= beta) return beta;
    }

    const buf = mbuf(ply);
    const n = genMoves(side, buf, 0, false);
    if (n === 0) return -MATE + ply;

    const ttMove = ttBestMove();
    orderMoves(buf, 0, n, ply, ttMove);

    const origAlpha = alpha;
    let best = -INF, bestMove = 0, legal = 0;
    for (let i = 0; i < n; i++) {
      const m = buf[i];
      const from = m >> 7, to = m & 127;
      if (!make(m)) break;
      if (isChecked(side)) { unmake(); continue; }
      legal++;
      let sc;
      if (legal === 1) {
        sc = -negamax(depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        // PVS：先用窄窗试，失败再全窗重搜
        sc = -negamax(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (sc > alpha && sc < MATE - 1000 && !aborted)
          sc = -negamax(depth - 1, -beta, -alpha, ply + 1, true);
      }
      unmake();
      if (aborted) return 0;
      if (sc > best) { best = sc; bestMove = m; }
      if (sc > alpha) alpha = sc;
      if (alpha >= beta) {
        if (T[to] < 0) {
          if (killers[ply * 2] !== m) { killers[ply * 2 + 1] = killers[ply * 2]; killers[ply * 2] = m; }
          hist[from * 90 + to] += depth * depth;
        }
        break;
      }
    }
    if (legal === 0) return -MATE + ply;

    let flag = 0;
    if (best <= origAlpha) flag = 2;       // UPPER
    else if (best >= beta) flag = 1;       // LOWER
    ttStore(depth, best, flag, bestMove, ply);
    return best;
  }

  function hasHeavyMaterial(side) {
    for (let i = 0; i < 90; i++) {
      if (S[i] !== side) continue;
      const t = T[i];
      if (t === ROOK || t === CANNON || t === HORSE) return true;
    }
    return false;
  }

  // ---------------- 难度档案 ----------------
  // depth : 搜索深度上限（决定"看多远"）
  // time  : 该档自己的思考时间上限（还会被界面上的"思考时间"再压一层）
  // qMax  : 静态搜索深度（吃子/应将纵深）
  // slack : 允许比最优着法差多少分再随机挑一个 —— 数值越大越"随手"
  // topK  : 在容差范围内最多从几个候选里抽
  // blunder/blunderMargin : 低难度"人味"失误率——以该概率挑一个"不是最优但也
  //                         不至于白送子"的着法（margin 限定不会挑到明显亏分的）
  // useBounds : 是否也把"只知道上界"的着法算进候选（只有最弱两档开）
  const LEVELS = [
    { name: '新手', depth: 2, time: 500, qMax: 0, slack: 140, topK: 5, blunder: 0.35, blunderMargin: 180, useBounds: 1, nodes: 500000 },
    { name: '熟手', depth: 3, time: 900, qMax: 2, slack: 70, topK: 3, blunder: 0.15, blunderMargin: 120, useBounds: 1, nodes: 1000000 },
    { name: '高手', depth: 4, time: 1500, qMax: 4, slack: 25, topK: 2, blunder: 0, blunderMargin: 0, useBounds: 0, nodes: 3000000 },
    { name: '大师', depth: 6, time: 2500, qMax: 6, slack: 12, topK: 2, blunder: 0, blunderMargin: 0, useBounds: 0, nodes: 6000000 },
    { name: '宗师', depth: 8, time: 4000, qMax: 8, slack: 0, blunder: 0, blunderMargin: 0, useBounds: 0, nodes: 12000000 },
  ];

  let rngState = 123456789;
  function rand() {
    rngState ^= rngState << 13; rngState >>>= 0;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5; rngState >>>= 0;
    return rngState / 4294967296;
  }

  // ---------------- 从游戏棋盘载入 ----------------
  function loadFromBoard(board, protectedKing) {
    T.fill(-1); S.fill(-1); KF.fill(0);
    Ksq[0] = -1; Ksq[1] = -1;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = board.board[r][c];
        if (!p) continue;
        const i = r * 9 + c;
        T[i] = p.type; S[i] = p.side;
        KF[i] = (p.lordKing ? 1 : 0) | (p.innerKing ? 2 : 0);
        if ((p.type === KING || KF[i] !== 0) && Ksq[p.side] < 0) Ksq[p.side] = i;
      }
    }
    turn = board.turn;
    sp = 0;
    PROT = protectedKing || null;
    key = 0;
    for (let i = 0; i < 90; i++) if (T[i] >= 0) key ^= Z[zIdx(i)];
    if (turn === BLACK) key ^= ZTURN;
  }

  // ---------------- 迭代加深 + 难度选择 ----------------
  function pickMove(board, opts) {
    opts = opts || {};
    buildEvalTables();
    const li = Math.max(0, Math.min(LEVELS.length - 1, opts.level | 0));
    const profile = LEVELS[li];
    const hardCap = opts.timeLimit > 0 ? opts.timeLimit : profile.time;
    const budget = Math.max(120, Math.min(hardCap, profile.time));
    if (opts.seed !== undefined) rngState = (opts.seed | 0) || 123456789;

    loadFromBoard(board, opts.protectedKing);
    if (board.moveHistory && board.moveHistory.length === 0) ttClear();

    qMax = profile.qMax;
    maxDepth = profile.depth;
    plyLimit = profile.depth + profile.qMax + 8;
    nodeCap = profile.nodes || 4e6;
    // 容差大的低难度：根节点全窗搜（深度浅，代价可接受），换取"在同一档里走法有变化"
    const fullRoot = profile.slack >= 20;
    nodes = 0; aborted = false; sp = 0;
    resetHeur();
    deadline = Date.now() + budget;

    const side = turn;
    const rootBuf = mbuf(0);
    const rn = genMoves(side, rootBuf, 0, false);
    const rootMoves = [];
    for (let i = 0; i < rn; i++) {
      const m = rootBuf[i];
      if (!make(m)) continue;
      const ok = !isChecked(side);
      unmake();
      if (ok) rootMoves.push(m);
    }
    if (rootMoves.length === 0) return null;

    let best = rootMoves[0], bestScore = 0, doneDepth = 0;
    let rootScores = null, rootExact = null;

    for (let d = 1; d <= maxDepth; d++) {
      // 把上一轮最优着法排到最前
      if (doneDepth > 0) {
        const idx = rootMoves.indexOf(best);
        if (idx > 0) { rootMoves.splice(idx, 1); rootMoves.unshift(best); }
      }
      const scores = new Float64Array(rootMoves.length);
      const exact = new Uint8Array(rootMoves.length);
      let alpha = -INF, localBest = rootMoves[0], localScore = -INF, complete = true;

      for (let i = 0; i < rootMoves.length; i++) {
        const m = rootMoves[i];
        if (Date.now() > deadline) { complete = false; break; }
        make(m);
        let sc;
        if (i === 0 || fullRoot) {
          // 低难度：根节点每个着法都全窗搜，拿到准确分，才谈得上"容差里随机挑"
          sc = -negamax(d - 1, -INF, INF, 1, true);
          exact[i] = 1;
        } else {
          // PVS：先用窄窗试探
          sc = -negamax(d - 1, -alpha - 1, -alpha, 1, true);
          // 只要上界还落在 slack 范围内，就全窗重搜拿准确分
          if (sc > alpha - profile.slack - 1 && sc < MATE - 1000 && !aborted) {
            sc = -negamax(d - 1, -INF, INF, 1, true);
            exact[i] = 1;
          }
        }
        unmake();
        if (aborted) { complete = false; break; }
        scores[i] = sc;
        if (sc > localScore) { localScore = sc; localBest = m; }
        if (sc > alpha) alpha = sc;
      }

      // 只接受完整跑完的一层，杜绝"半成品着法"
      if (!complete) break;
      best = localBest; bestScore = localScore; doneDepth = d;
      rootScores = scores; rootExact = exact;
      if (bestScore > MATE - 1000) break;
      if (Date.now() > deadline) break;
    }

    // ---- 难度差异：只在"确定误差在 slack 以内"的着法里随机挑 ----
    let chosen = best;
    if (profile.slack > 0 && rootScores && rootExact && doneDepth > 0) {
      const cand = [];
      for (let i = 0; i < rootMoves.length; i++) {
        if ((rootExact[i] || profile.useBounds) && bestScore - rootScores[i] <= profile.slack) cand.push(rootMoves[i]);
      }
      if (cand.length > 1) {
        const k = Math.min(cand.length, profile.topK);
        chosen = cand[Math.floor(rand() * k)];
      }
    }

    // ---- 低难度"人味"失误：以一定概率挑一个"不是最优、但也没明显亏分"的着法 ----
    if (profile.blunder > 0 && rootScores && doneDepth > 0 && rand() < profile.blunder) {
      const pool = [];
      for (let i = 0; i < rootMoves.length; i++) {
        const d = bestScore - rootScores[i];
        if (d >= 10 && d <= profile.blunderMargin) pool.push(rootMoves[i]);
      }
      if (pool.length) chosen = pool[Math.floor(rand() * pool.length)];
    }

    const fromSq = chosen >> 7, toSq = chosen & 127;
    return {
      fr: (fromSq / 9) | 0, fc: fromSq % 9,
      tr: (toSq / 9) | 0, tc: toSq % 9,
      score: bestScore, depth: doneDepth, nodes: nodes,
      ms: budget - Math.max(0, deadline - Date.now()),
      level: li, levelName: profile.name,
    };
  }

  // 调试/校验用：返回当前已载入局面的全部合法着法（内部编码）
  function allLegal() {
    const side = turn;
    const buf = new Int32Array(200);
    const n = genMoves(side, buf, 0, false);
    const out = [];
    for (let i = 0; i < n; i++) {
      const m = buf[i];
      if (!make(m)) continue;
      const ok = !isChecked(side);
      unmake();
      if (ok) out.push(m);
    }
    return out;
  }

  global.AIEngine = {
    pickMove,
    LEVELS,
    _internals: {
      loadFromBoard, genMoves, isChecked, evalRed, attacks, allLegal,
      ttClear, resetHeur,
      getT: () => T, getS: () => S, getKF: () => KF, getKsq: () => Ksq,
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
