#!/usr/bin/env node
/**
 * 熔断策略回测 v2 — 全量数据，更细粒度
 * 
 * 核心思路：连败1次就冷却 vs 连败3次再冷却
 * 测试：每种阈值 x 每种冷却长度
 * 全量1265球回测，不漏任何数据
 */

const engine = require('./engine');
const storage = require('./storage');
const { state } = storage;

const balls = state.balls;
console.log(`📊 全量回测: ${balls.length} 球\n`);

function simulate(cfg) {
  const { threshold, cooldown, label } = cfg;
  
  let wins = 0, losses = 0, skipped = 0;
  let cooldownLeft = 0;
  let curLoseStreak = 0, curWinStreak = 0;
  let maxLoseStreak = 0, maxWinStreak = 0;
  let allLoseStreaks = [], allWinStreaks = [];
  let tempLose = 0, tempWin = 0;
  let inLossPhase = false; // 是否在连败阶段（用来判断冷却是否打断了连败链）
  let totalCooldowns = 0; // 熔断触发次数

  for (let i = 0; i < balls.length; i++) {
    const ball = balls[i];

    // 冷却中 → 跳过预测，但继续统计实际走势
    if (cooldownLeft > 0) {
      cooldownLeft--;
      skipped++;
      // 冷却期间实际结果也跟踪
      if (ball.resultMark === 'W') {
        if (tempLose > 0) { allLoseStreaks.push(tempLose); tempLose = 0; }
        tempWin++;
      } else if (ball.resultMark === 'L') {
        if (tempWin > 0) { allWinStreaks.push(tempWin); tempWin = 0; }
        tempLose++;
      }
      continue;
    }

    // 数据不足时跳过
    const history = balls.slice(0, i);
    if (history.length < 10) continue;
    if (!ball.parity) continue;

    // 运行预测引擎
    const engineResult = engine.runPredictionEngine(history, {
      ruleEnabled: state.ruleEnabled,
      ruleReversed: state.ruleReversed,
      ruleStats: state.ruleStats
    });

    if (!engineResult.finalPrediction) continue;

    const isCorrect = engineResult.finalPrediction === ball.parity;

    if (isCorrect) {
      wins++;
      curWinStreak++;
      curLoseStreak = 0;
      if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
      if (tempLose > 0) { allLoseStreaks.push(tempLose); tempLose = 0; }
      tempWin++;
    } else {
      losses++;
      curLoseStreak++;
      curWinStreak = 0;
      if (curLoseStreak > maxLoseStreak) maxLoseStreak = curLoseStreak;
      if (tempWin > 0) { allWinStreaks.push(tempWin); tempWin = 0; }
      tempLose++;

    // 触发熔断？
    if (threshold === 0) {
      // 特殊模式：每输1次就冷却
      if (cooldown > 0) {
        cooldownLeft = cooldown;
        totalCooldowns++;
      }
    } else if (threshold > 0 && curLoseStreak >= threshold) {
      cooldownLeft = cooldown;
      totalCooldowns++;
      curLoseStreak = 0; // 重置连败计数（冷却后重新开始）
    }
    }
  }

  if (tempLose > 0) allLoseStreaks.push(tempLose);
  if (tempWin > 0) allWinStreaks.push(tempWin);

  const total = wins + losses;
  const winRate = total > 0 ? (wins / total * 100) : 0;
  const avgLose = allLoseStreaks.length > 0 ? allLoseStreaks.reduce((a, b) => a + b, 0) / allLoseStreaks.length : 0;
  const avgWin = allWinStreaks.length > 0 ? allWinStreaks.reduce((a, b) => a + b, 0) / allWinStreaks.length : 0;
  const highLose5 = allLoseStreaks.filter(s => s >= 5).length;
  const highLose3 = allLoseStreaks.filter(s => s >= 3).length;
  const skipRate = balls.length > 0 ? (skipped / balls.length * 100) : 0;

  // 综合评分：胜率高好，连败低好，跳过率别太高
  const score = winRate * 3 - maxLoseStreak * 5 - avgLose * 3 - highLose5 * 3 - highLose3 * 1 - skipRate * 0.3;

  return {
    label, threshold, cooldown, total, wins, losses, winRate,
    maxLoseStreak, avgLoseStreak: avgLose.toFixed(1), avgWinStreak: avgWin.toFixed(1),
    highLose5, highLose3, skipRate: skipRate.toFixed(1), totalCooldowns, score
  };
}

// ========== 测试方案 ==========

const configs = [];

// 基线
configs.push({ threshold: -1, cooldown: 0, label: '无熔断(基线)' });

// 每输1次就冷却 (threshold=0)
for (const cd of [1, 2, 3, 4, 5]) {
  configs.push({ threshold: 0, cooldown: cd, label: `每输1次冷却${cd}块` });
}

// 连败2次后冷却
for (const cd of [1, 2, 3, 4, 5]) {
  configs.push({ threshold: 2, cooldown: cd, label: `连败2次冷却${cd}块` });
}

// 连败3次后冷却
for (const cd of [1, 2, 3, 4, 5]) {
  configs.push({ threshold: 3, cooldown: cd, label: `连败3次冷却${cd}块` });
}

// 连败4次后冷却
for (const cd of [1, 2, 3, 4, 5]) {
  configs.push({ threshold: 4, cooldown: cd, label: `连败4次冷却${cd}块` });
}

// 连败5次后冷却
for (const cd of [1, 2, 3, 4, 5]) {
  configs.push({ threshold: 5, cooldown: cd, label: `连败5次冷却${cd}块` });
}

// 运行所有
const results = configs.map(simulate);

// 打印全部结果
console.log('策略                          | 胜率   | 总预测 | 跳过 | 最高连败 | 平均连败 | 连败≥5 | 连败≥3 | 冷却次数 | 评分');
console.log('-'.repeat(120));

for (const r of results) {
  const flag = r.maxLoseStreak <= 7 ? ' ✅' : r.maxLoseStreak <= 9 ? ' ⚠️' : ' ❌';
  console.log(
    `${r.label.padEnd(28)}| ${r.winRate.toFixed(1).padStart(5)}% | ${String(r.total).padStart(5)}  | ${String(r.skipRate).padStart(4)}% |    ${String(r.maxLoseStreak).padStart(3)}    |   ${r.avgLoseStreak.padStart(5)}   |  ${String(r.highLose5).padStart(3)}   |  ${String(r.highLose3).padStart(3)}   |    ${String(r.totalCooldowns).padStart(4)}    | ${r.score.toFixed(1).padStart(6)}${flag}`
  );
}

// 排序取TOP10
console.log();
console.log('🏆 综合评分 TOP 10：');
console.log('-'.repeat(120));
const sorted = [...results].sort((a, b) => b.score - a.score);
for (let i = 0; i < 10; i++) {
  const r = sorted[i];
  console.log(`  #${i + 1} ${r.label.padEnd(28)} 胜率${r.winRate.toFixed(1)}% 最高连败${r.maxLoseStreak} 平均连败${r.avgLoseStreak} 跳过${r.skipRate}% 评分${r.score.toFixed(1)}`);
}

// 专门看"最高连败最低"的策略
console.log();
console.log('🎯 最高连败最低 TOP 5（牺牲胜率换稳定性）：');
console.log('-'.repeat(120));
const byMaxLose = [...results].filter(r => r.total > 200).sort((a, b) => a.maxLoseStreak - b.maxLoseStreak || b.winRate - a.winRate);
for (let i = 0; i < Math.min(5, byMaxLose.length); i++) {
  const r = byMaxLose[i];
  console.log(`  #${i + 1} ${r.label.padEnd(28)} 胜率${r.winRate.toFixed(1)}% 最高连败${r.maxLoseStreak} 平均连败${r.avgLoseStreak} 跳过${r.skipRate}%`);
}

// 基线对比
console.log();
console.log('📈 与基线对比（TOP5 vs 基线）：');
const bl = results[0];
for (let i = 0; i < Math.min(5, sorted.length); i++) {
  const r = sorted[i];
  if (r.label === '无熔断(基线)') continue;
  const wrDiff = (r.winRate - bl.winRate).toFixed(1);
  const mlDiff = r.maxLoseStreak - bl.maxLoseStreak;
  console.log(`  ${r.label} → 胜率${wrDiff >= 0 ? '+' : ''}${wrDiff}% 连败${mlDiff >= 0 ? '+' : ''}${mlDiff} 跳过${r.skipRate}%`);
  if (i >= 4) break;
}
