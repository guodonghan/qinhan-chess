// ============================================================
// 开局面数据库（Opening Book）
//
// 设计：扁平 key 表 —— key = "红1.黑1.红2.黑2...红N" 的紧凑编码，
// 当 AI（黑方）即将走第 N+1 步时，用"到目前为止的全局走法序列"
// 查表，命中 → 返回候选着法（按权重抽样）。
//
// 编码：每步固定 4 字符 = fr + fc + tr + tc（每位 < 10，无歧义）
//
// 注意：moveHistory 元素的字段是 {fromRow, fromCol, toRow, toCol, ...}
//       不是 fr/fc/tr/tc，需要适配。
//
// 公开 API：
//   Opening.install()       —— 构建开局库（构造时调一次）
//   Opening.lookup(board)   —— 若当前局面命中开局库，返回候选走法对象，否则 null
// ============================================================
(function(global){
  'use strict';

  // 解析紧凑 4 字符 key → {fr, fc, tr, tc}
  function parseKey(k){
    return {
      fr: +k.charAt(0),
      fc: +k.charAt(1),
      tr: +k.charAt(2),
      tc: +k.charAt(3),
    };
  }

  // 把 moveHistory 条目转为紧凑 4 字符 key
  function historyKey(m){
    return '' + m.fromRow + m.fromCol + m.toRow + m.toCol;
  }

  // ===========================================================
  // 坐标速查表（仅注释用，便于评审）：
  //   红方 1~9 路 = col 8~0 （从右往左）
  //   黑方 1~9 路 = col 0~8
  //   红方原位：车(9,8)=车一, 车(9,0)=车九
  //             马(9,7)=马二, 马(9,1)=马八
  //             相(9,6)=相三, 相(9,2)=相七
  //             仕(9,5)=仕四, 仕(9,3)=仕六
  //             帅(9,4)=帅五
  //             炮(7,7)=炮二, 炮(7,1)=炮八
  //             兵(6,8)=兵一,(6,6)=兵三,(6,4)=兵五,(6,2)=兵七,(6,0)=兵九
  //   黑方对称：行 9-r、列 8-c
  //
  // 注意：红方"2 路"是 col=7，"2 路"的车不存在（马二在 (9,7)）。
  //       红方车只有"1 路" (col=8) 和"9 路" (col=0)。
  //       "车九平六" = (9,0)→(9,3) = "9093"。
  // ===========================================================
  const VARIATIONS = [
    // ============ 1. 中炮过河车对屏风马 ============
    { name: '中炮过河车-屏风马', weight: 1, seq: [
      '7774','0122',  // 红:炮二平五 / 黑:马2进3
      '9938','0726',  // 红:车一进六 / 黑:马8进7
      '9674','0224',  // 红:相三进五 / 黑:象3进5
    ]},

    // ============ 2. 中炮对屏风马（最经典） ============
    { name: '中炮-盘河马-7卒', weight: 2, seq: [
      '7774','0122',  // 红:炮二平五 / 黑:马2进3
      '9776','0726',  // 红:马二进三 / 黑:马8进7
      '6252','3646',  // 红:兵七进一 / 黑:卒7进1
    ]},
    { name: '中炮-盘河马-3卒', weight: 1, seq: [
      '7774','0122',
      '9776','0726',
      '6252','3242',  // 黑:卒3进1
    ]},

    // ============ 3. 中炮对反宫马 ============
    { name: '中炮-反宫马', weight: 1, seq: [
      '7774','2141',  // 红:炮二平五 / 黑:炮2平5
      '9776','0726',  // 红:马二进三 / 黑:马8进7
      '6252','3646',  // 红:兵七进一 / 黑:卒7进1
    ]},

    // ============ 4. 仙人指路对卒底炮 ============
    { name: '仙人指路-卒底炮', weight: 1, seq: [
      '6252','2122',  // 红:兵七进一 / 黑:炮2平3
      '7774','0726',  // 红:炮二平五 / 黑:马8进7
      '9776','0122',  // 红:马二进三 / 黑:马2进3
    ]},
    { name: '仙人指路-挺3卒', weight: 1, seq: [
      '6252','3242',  // 红:兵七进一 / 黑:卒3进1
      '9170','0726',  // 红:马八进七 / 黑:马8进7
      '7774','0122',  // 红:炮二平五 / 黑:马2进3
    ]},

    // ============ 5. 飞象局 ============
    { name: '飞象-屏风马', weight: 1, seq: [
      '9674','0726',  // 红:相三进五 / 黑:马8进7
      '9776','0122',  // 红:马二进三 / 黑:马2进3
      '6252','3646',  // 红:兵七进一 / 黑:卒7进1
    ]},

    // ============ 6. 起马局 ============
    { name: '起马-屏风马', weight: 1, seq: [
      '9776','0726',  // 红:马二进三 / 黑:马8进7
      '9170','0122',  // 红:马八进七 / 黑:马2进3
      '7774','2141',  // 红:炮二平五 / 黑:炮2平5
    ]},

    // ============ 7. 顺手炮 ============
    { name: '顺手炮-横车', weight: 1, seq: [
      '7774','2724',  // 红:炮二平五 / 黑:炮8平5
      '9888','0224',  // 红:车一进一 / 黑:象3进5
      '9776','0122',  // 红:马二进三 / 黑:马2进3
    ]},

    // ============ 8. 列手炮 ============
    { name: '列手炮', weight: 1, seq: [
      '7174','2724',  // 红:炮八平五 / 黑:炮8平5
      '9776','0122',  // 红:马二进三 / 黑:马2进3
      '9170','0726',  // 红:马八进七 / 黑:马8进7
    ]},

    // ============ 9. 仕角炮 ============
    { name: '仕角炮-跳正马', weight: 1, seq: [
      '9384','0726',  // 红:仕六进五 / 黑:马8进7
      '9776','2141',  // 红:马二进三 / 黑:炮2平5
      '7774','0122',  // 红:炮二平五 / 黑:马2进3
    ]},
  ];

  // ===========================================================
  // 扁平化构建开局库
  // seq 索引 0/2/4... = 红方走子, 1/3/5... = 黑方走子
  // 在每个"黑方即将走子"的位置生成 entry：
  //   key   = seq[0..i-1] 中"红方走过的步"（偶数索引）拼接
  //   value = 候选着法（按权重抽样）
  // 这样与 lookup() 用红方走过的步拼接 key 一致
  // ===========================================================
  function buildBook(){
    const book = {};
    for(const v of VARIATIONS){
      const seq = v.seq;
      for(let i = 1; i < seq.length; i += 2){
        let k = '';
        for(let j = 0; j < i; j += 2){
          k += seq[j];
        }
        if(!book[k]) book[k] = [];
        book[k].push({
          move: parseKey(seq[i]),
          name: v.name + ' · 第' + (i/2 + 1) + '手',
          weight: v.weight || 1,
        });
      }
    }
    return book;
  }

  let BOOK = null;

  function install(){
    if(!BOOK) BOOK = buildBook();
    return BOOK;
  }

  // 查表：若当前局面命中开局库，返回候选走法对象，否则 null
  // AI 走子时 board.turn === SIDE_BLACK，moveHistory 长度为偶数
  // key 由 moveHistory 中偶数索引（红方走过的步）拼接而成
  function lookup(board){
    if(!BOOK) install();
    if(!board.moveHistory || board.moveHistory.length === 0) return null;
    if(board.moveHistory.length > 12) return null; // 只覆盖前 6 步
    const parts = [];
    for(let i = 0; i < board.moveHistory.length; i += 2){
      parts.push(historyKey(board.moveHistory[i]));
    }
    const k = parts.join('');
    const list = BOOK[k];
    if(!list || list.length === 0) return null;
    // 按权重随机选
    let total = 0;
    for(const c of list) total += (c.weight || 1);
    let r = Math.random() * total;
    for(const c of list){
      r -= (c.weight || 1);
      if(r <= 0){
        // 验证：候选着法在当前局面是否合法（棋子在起点、终点不挡自己）
        const p = board.board[c.move.fr][c.move.fc];
        if(!p || p.side !== board.turn) continue;
        const target = board.board[c.move.tr][c.move.tc];
        if(target && target.side === board.turn) continue;
        return c;
      }
    }
    return list[list.length - 1];
  }

  // 调试用：列出开局库覆盖的所有 key 前缀
  function debug(){
    if(!BOOK) install();
    return Object.keys(BOOK);
  }

  globalThis.Opening = { install, lookup, parseKey, historyKey, debug };
})(typeof window !== 'undefined' ? window : globalThis);