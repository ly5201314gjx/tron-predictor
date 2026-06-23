#!/usr/bin/env node
/**
 * 周期切换检测回测
 * 
 * 算法：检测近N球的单双比例，如果偏移超过阈值，则给对应方向加权
 * 参数：窗口大小、偏移阈值、加权力度
 * 
 * 评估指标：胜率、最高连败、平均连败
 */

const engine = require('./engine');
const storage = require('./storage');
const { state } = storage;

const balls = state.balls;
console.log(`📊 全量回测: ${balls.length} 球\n`);

function detectPeriod(history, window) {
  const recent = history.slice(-window);
  if (recent.length < 10) return null;
  const singles = recent.filter(b => b.parity === 'single').length;
  const doubles = recent.filter(b => b.parity === 'double').length;
  const total = singles + doubles;
  if (total === 0) return null;
  const singleRatio = singles / total;
  // 返回偏移值：正数=偏单，负数=偏双，0=平衡
  return singleRatio - 0.5; // [-0.5, +0.5]
}

function simulate(cfg) {
  const { window = 50, threshold = 0.08, boostFactor = 0.15, enabled = true } = cfg;
  let wins = 0, losses = 0;
  let curLose = 0, curWin = 0;
  let maxLose = 0, maxWin = 0;
  let allLoseStreaks = [], allWinStreaks = [];
  let tempLose = 0, tempWin = 0;
  
  const ruleStats = {};

  for (let i = 0; i < balls.length; i++) {
    const ball = balls[i];
    const history = balls.slice(0, i);
    if (history.length < window + 5 || !ball.parity) continue;

    const engineResult = engine.runPredictionEngine(history, {
      ruleEnabled: state.ruleEnabled,
      ruleReversed: state.ruleReversed,
      ruleStats
    });

    if (!engineResult.finalPrediction) continue;

    let pred = engineResult.finalPrediction;
    let conf = engineResult.combinedConfidence;

    // 周期检测：偏移超阈值时给对应方向加分
    if (enabled) {
      const bias = detectPeriod(history, window);
      if (bias !== null && Math.abs(bias) > threshold) {
        const engineScore = pred === 'single' ? 0.5 + conf * 0.5 : 0.5 - conf * 0.5;
        let boostedScore = engineScore;
        if (bias > 0) {
          // 偏单周期：给单加分
          boostedScore += boostFactor * Math.abs(bias) / 0.5;
        } else {
          // 偏双周期：给双加分
          boostedScore -= boostFactor * Math.abs(bias) / 0.5;
        }
        const newPred = boostedScore >= 0.5 ? 'single' : 'double';
        if (newPred !== pred) {
          pred = newPred;
          // 用周期检测翻转后，置信度取两者较高值
          conf = Math.max(conf, 0.5 + Math.abs(bias) * 0.3);
        }
      }
    }

    // 更新规则统计
    const isCorrect = pred === ball.parity;
    for (const ro of engineResult.ruleOutputs) {
      if (ro.ruleId && !ro.ruleId.startsWith('DRAGON')) {
        if (!ruleStats[ro.ruleId]) {
          ruleStats[ro.ruleId] = { name: ro.ruleName, used: 0, wins: 0, losses: 0 };
        }
        ruleStats[ro.ruleId].used++;
        if (isCorrect) ruleStats[ro.ruleId].wins++;
        else ruleStats[ro.ruleId].losses++;
      }
    }

    if (isCorrect) {
      wins++; curWin++; curLose = 0;
      if (curWin > maxWin) maxWin = curWin;
      if (tempLose > 0) { allLoseStreaks.push(tempLose); tempLose = 0; }
      tempWin++;
    } else {
      losses++; curLose++; curWin = 0;
      if (curLose > maxLose) maxLose = curLose;
      if (tempWin > 0) { allWinStreaks.push(tempWin); tempWin = 0; }
      tempLose++;
    }
  }

  if (tempLose > 0) allLoseStreaks.push(tempLose);
  if (tempWin > 0) allWinStreaks.push(tempWin);

  const total = wins + losses;
  const winRate = total > 0 ? (wins / total * 100) : 0;
  const avgLose = allLoseStreaks.length > 0 ? allLoseStreaks.reduce((a, b) => a + b, 0) / allLoseStreaks.length : 0;
  const avgWin = allWinStreaks.length > 0 ? allWinStreaks.reduce((a, b) => a + b, 0) / allWinStreaks.length : 0;
  const lose5plus = allLoseStreaks.filter(s => s >= 5).length;
  const lose3plus = allLoseStreaks.filter(s => s >= 3).length;

  return { total, wins, losses, winRate, maxLose, maxWin, avgLose: avgLose.toFixed(1), avgWin: avgWin.toFixed(1), lose5plus, lose3plus };
}

// ========== 基线 ==========
const baseline = simulate({ enabled: false });
console.log(`${'='.repeat(90)}`);
console.log(`无周期检测（基线）`);
console.log(`${'='.repeat(90)}`);
console.log(`  胜率: ${baseline.winRate.toFixed(2)}%  总预测: ${baseline.total}  最高连败: ${baseline.maxLose}  连败≥5: ${baseline.lose5plus}`);

// ========== 测试不同参数 ==========
console.log(`\n${'='.repeat(90)}`);
console.log(`周期检测参数扫描`);
console.log(`${'='.repeat(90)}`);

const configs = [];
for (const window of [30, 50, 80]) {
  for (const threshold of [0.05, 0.08, 0.10, 0.12]) {
    for (const boost of [0.10, 0.15, 0.20, 0.25]) {
      configs.push({ window, threshold, boostFactor: boost, enabled: true });
    }
  }
}

let best = null;
let bestScore = -Infinity;

console.log(`窗口 | 阈值  | 加权  | 胜率    | 总预测 | 最高连败 | 平均连败 | 连败≥3 | 连败≥5 | 评分`);
console.log(`-`.repeat(95));

for (const cfg of configs) {
  const r = simulate(cfg);
  const score = r.winRate * 3 - r.maxLose * 5 - parseFloat(r.avgLose) * 2 - r.lose5plus * 3 - r.lose3plus * 1;
  
  if (score > bestScore) {
    bestScore = score;
    best = { ...cfg, ...r, score };
  }
}

// 只输出评分TOP15和一些有代表性的
const allResults = configs.map(cfg => {
  const r = simulate(cfg);
  const score = r.winRate * 3 - r.maxLose * 5 - parseFloat(r.avgLose) * 2 - r.lose5plus * 3 - r.lose3plus * 1;
  return { ...cfg, ...r, score };
}).sort((a, b) => b.score - a.score);

console.log(`\n🏆 TOP 15 最优参数：`);
console.log(`-`.repeat(95));
for (let i = 0; i < Math.min(15, allResults.length); i++) {
  const r = allResults[i];
  console.log(`  #${String(i+1).padStart(2)} ${String(r.window).padStart(4)}  ${r.threshold.toFixed(2)}   ${r.boostFactor.toFixed(2)}   ${r.winRate.toFixed(2).padStart(6)}%  ${String(r.total).padStart(5)}  |   ${String(r.maxLose).padStart(3)}    |   ${r.avgLose.padStart(5)}   |  ${String(r.lose3plus).padStart(3)}   |  ${String(r.lose5plus).padStart(3)}  | ${r.score.toFixed(1).padStart(6)}`);
}

console.log(`\n📈 与基线对比（TOP5）：`);
console.log(`-`.repeat(95));
const bl = baseline;
for (let i = 0; i < Math.min(5, allResults.length); i++) {
  const r = allResults[i];
  const wrDiff = (r.winRate - bl.winRate).toFixed(2);
  const mlDiff = r.maxLose - bl.maxLose;
  console.log(`  #${i+1} 窗口${r.window}/阈值${r.threshold}/加权${r.boostFactor} → 胜率${wrDiff >= 0 ? '+' : ''}${wrDiff}% 最高连败${mlDiff >= 0 ? '+' : ''}${mlDiff} 连败≥5 ${bl.lose5plus}→${r.lose5plus}`);
}

console.log(`\n🏆 最终推荐参数：`);
console.log(`  窗口: ${best.window}球`);
console.log(`  偏移阈值: ${(best.threshold * 100).toFixed(0)}%`);
console.log(`  加权力度: ${best.boostFactor}`);
console.log(`  胜率: ${best.winRate.toFixed(2)}%（基线${bl.winRate.toFixed(2)}%，提升${(best.winRate - bl.winRate).toFixed(2)}%）`);
console.log(`  最高连败: ${best.maxLose}（基线${bl.maxLose}）`);
console.log(`  连败≥5: ${best.lose5plus}（基线${bl.lose5plus}）`);
