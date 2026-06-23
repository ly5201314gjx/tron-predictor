#!/usr/bin/env node
/**
 * 组合回测：周期检测 + 智能熔断
 * 
 * 测试4种组合：
 * A. 无任何优化（基线）
 * B. 仅智能熔断
 * C. 仅周期检测
 * D. 智能熔断 + 周期检测
 */

const engine = require('./engine');
const storage = require('./storage');
const { state } = storage;

const balls = state.balls;
console.log(`📊 全量回测: ${balls.length} 球\n`);

function simulate(cfg) {
  const {
    periodEnabled = false, periodWindow = 50, periodThreshold = 0.08, periodBoost = 0.15,
    smartEnabled = false, smartThreshold = 2, smartCooldown = 2
  } = cfg;

  let wins = 0, losses = 0, skipped = 0, smartTriggered = 0;
  let curLose = 0, curWin = 0;
  let maxLose = 0, maxWin = 0;
  let smartCooldownUntil = 0;
  let allLoseStreaks = [], allWinStreaks = [];
  let tempLose = 0, tempWin = 0;

  const ruleStats = {};

  for (let i = 0; i < balls.length; i++) {
    const ball = balls[i];
    const h = ball.height;

    // 智能熔断冷却检查
    if (smartEnabled && smartCooldownUntil > 0 && h <= smartCooldownUntil) {
      skipped++;
      continue;
    }
    if (smartEnabled && smartCooldownUntil > 0 && h > smartCooldownUntil) {
      smartCooldownUntil = 0;
      // 连败不重置
    }

    const history = balls.slice(0, i);
    if (history.length < 10 || !ball.parity) continue;

    const engineResult = engine.runPredictionEngine(history, {
      ruleEnabled: state.ruleEnabled,
      ruleReversed: state.ruleReversed,
      ruleStats
    });

    if (!engineResult.finalPrediction) continue;

    let pred = engineResult.finalPrediction;
    const conf = engineResult.combinedConfidence;

    // 周期检测
    if (periodEnabled) {
      const recent = history.slice(-periodWindow);
      if (recent.length >= 10) {
        const singles = recent.filter(b => b.parity === 'single').length;
        const doubles = recent.filter(b => b.parity === 'double').length;
        const total = singles + doubles;
        if (total > 0) {
          const bias = singles / total - 0.5;
          if (Math.abs(bias) > periodThreshold) {
            const engineScore = pred === 'single' ? 0.5 + conf * 0.5 : 0.5 - conf * 0.5;
            let boostedScore = engineScore;
            boostedScore += bias > 0 ? periodBoost * Math.abs(bias) / 0.5 : -periodBoost * Math.abs(bias) / 0.5;
            pred = boostedScore >= 0.5 ? 'single' : 'double';
          }
        }
      }
    }

    // 规则统计
    const isCorrect = pred === ball.parity;
    for (const ro of engineResult.ruleOutputs) {
      if (ro.ruleId && !ro.ruleId.startsWith('DRAGON')) {
        if (!ruleStats[ro.ruleId]) ruleStats[ro.ruleId] = { name: ro.ruleName, used: 0, wins: 0, losses: 0 };
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

      // 智能熔断触发
      if (smartEnabled && curLose >= smartThreshold && smartCooldownUntil === 0) {
        const effectiveCooldown = Math.min(smartCooldown + smartTriggered, 5);
        smartCooldownUntil = h + 20 * effectiveCooldown;
        smartTriggered++;
      }
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

  return { total, wins, losses, winRate, maxLose, maxWin, avgLose: avgLose.toFixed(1), avgWin: avgWin.toFixed(1), lose5plus, lose3plus, skipped, smartTriggered };
}

// ========== 四种组合 ==========

console.log('⏳ 回测中...\n');

const A = simulate({}); // 基线
const B = simulate({ smartEnabled: true, smartThreshold: 2, smartCooldown: 2 }); // 仅熔断
const C = simulate({ periodEnabled: true, periodWindow: 50, periodThreshold: 0.08, periodBoost: 0.15 }); // 仅周期
const D = simulate({ smartEnabled: true, smartThreshold: 2, smartCooldown: 2, periodEnabled: true, periodWindow: 50, periodThreshold: 0.08, periodBoost: 0.15 }); // 组合

// 额外测试：不同周期参数组合熔断
console.log('⏳ 扫描周期+熔断最优参数...\n');

let bestCombo = null;
let bestScore = -Infinity;
const comboResults = [];

for (const pw of [30, 50, 80]) {
  for (const pt of [0.05, 0.08, 0.12]) {
    for (const pb of [0.10, 0.15, 0.20, 0.25]) {
      for (const st of [2, 3]) {
        for (const sc of [1, 2, 3]) {
          const r = simulate({ smartEnabled: true, smartThreshold: st, smartCooldown: sc, periodEnabled: true, periodWindow: pw, periodThreshold: pt, periodBoost: pb });
          const score = r.winRate * 3 - r.maxLose * 5 - parseFloat(r.avgLose) * 2 - r.lose5plus * 3 - r.lose3plus * 1;
          comboResults.push({ pw, pt, pb, st, sc, ...r, score });
          if (score > bestScore) {
            bestScore = score;
            bestCombo = comboResults[comboResults.length - 1];
          }
        }
      }
    }
  }
}

comboResults.sort((a, b) => b.score - a.score);

// ========== 输出报告 ==========

function printRow(label, r) {
  console.log(`  ${label.padEnd(28)}| 胜率${r.winRate.toFixed(1).padStart(5)}% | 总${String(r.total).padStart(5)} | 最高连败${String(r.maxLose).padStart(3)} | 平均连败${r.avgLose.padStart(5)} | 连败≥5${String(r.lose5plus).padStart(3)} | 跳过${String(r.skipped).padStart(4)} | 触发${String(r.smartTriggered).padStart(3)}次`);
}

console.log(`${'='.repeat(130)}`);
console.log(`  📊 四种组合对比`);
console.log(`${'='.repeat(130)}`);
console.log(`  策略                       | 胜率     | 总预测 | 最高连败 | 平均连败 | 连败≥5 | 跳过  | 触发`);
console.log(`  ${'-'.repeat(125)}`);
printRow('A. 无优化(基线)', A);
printRow('B. 仅智能熔断(2/2)', B);
printRow('C. 仅周期检测', C);
printRow('D. 熔断+周期 组合', D);

console.log(`\n${'='.repeat(130)}`);
console.log(`  📈 与基线对比`);
console.log(`${'='.repeat(130)}`);
for (const [label, r] of [['仅熔断', B], ['仅周期', C], ['组合', D]]) {
  const wrDiff = (r.winRate - A.winRate).toFixed(2);
  const mlDiff = r.maxLose - A.maxLose;
  const l5Diff = r.lose5plus - A.lose5plus;
  console.log(`  ${label}: 胜率${wrDiff >= 0 ? '+' : ''}${wrDiff}% | 最高连败${mlDiff >= 0 ? '+' : ''}${mlDiff} | 连败≥5 ${A.lose5plus}→${r.lose5plus}(${l5Diff >= 0 ? '+' : ''}${l5Diff}) | 跳过${r.skipped}球`);
}

console.log(`\n${'='.repeat(130)}`);
console.log(`  🏆 TOP 10 组合参数`);
console.log(`${'='.repeat(130)}`);
for (let i = 0; i < Math.min(10, comboResults.length); i++) {
  const r = comboResults[i];
  console.log(`  #${String(i+1).padStart(2)} 窗口${r.pw} 阈值${r.pt} 加权${r.pb} | 熔断${r.st}/${r.sc} → 胜率${r.winRate.toFixed(1)}% 连败${r.maxLose} 连败≥5=${r.lose5plus} 评分${r.score.toFixed(1)}`);
}

console.log(`\n${'='.repeat(130)}`);
console.log(`  🏆 最终推荐`);
console.log(`${'='.repeat(130)}`);
console.log(`  组合策略D: 智能熔断(${bestCombo.st}/${bestCombo.sc}) + 周期检测(窗口${bestCombo.pw}/阈值${bestCombo.pt}/加权${bestCombo.pb})`);
console.log(`  胜率: ${bestCombo.winRate.toFixed(2)}%（基线${A.winRate.toFixed(2)}%，提升${(bestCombo.winRate - A.winRate).toFixed(2)}%）`);
console.log(`  最高连败: ${bestCombo.maxLose}（基线${A.maxLose}）`);
console.log(`  连败≥5: ${bestCombo.lose5plus}（基线${A.lose5plus}）`);
console.log(`  跳过: ${bestCombo.skipped}球`);
