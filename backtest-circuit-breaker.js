#!/usr/bin/env node
/**
 * 熔断策略回测 — 用历史数据找最优参数
 * 
 * 测试维度：
 * 1. 连败阈值（触发熔断的连败次数）
 * 2. 冷却区块数（跳过多少个区块）
 * 3. 恢复策略（固定跳过 vs 滚动跳过）
 * 
 * 评估指标：
 * - 胜率
 * - 最高连败
 * - 平均连败
 * - 总预测次数
 * - 回报率（假设单双 1:1 赔率）
 */

const engine = require('./engine');
const storage = require('./storage');
const { state } = storage;

const balls = state.balls;
console.log(`📊 共 ${balls.length} 球数据用于回测\n`);

// ========== 基线：无熔断 ==========
function runBacktest(config) {
  const { cooldownBlocks = 0, loseThreshold = 999, strategy = 'fixed' } = config;
  
  let wins = 0, losses = 0;
  let currentLoseStreak = 0;
  let bestWinStreak = 0, currentWinStreak = 0;
  let bestLoseStreak = 0;
  let cooldownRemaining = 0;
  let skipped = 0;
  let maxLoseStreak = 0;
  
  // 连败长度分布
  const loseStreakDist = {};
  const winStreakDist = {};
  let tempLoseStreak = 0;
  let tempWinStreak = 0;
  let currentTempType = null; // 'W' or 'L'
  const allLoseStreaks = [];
  const allWinStreaks = [];
  
  const ruleStats = {};
  
  for (let i = 0; i < balls.length; i++) {
    const ball = balls[i];
    
    // 如果在冷却期，跳过
    if (cooldownRemaining > 0) {
      cooldownRemaining--;
      skipped++;
      
      // 记录冷却期间的连败继续
      if (ball.resultMark === 'L') {
        tempLoseStreak++;
      } else if (ball.resultMark === 'W') {
        if (tempLoseStreak > 0) { allLoseStreaks.push(tempLoseStreak); tempLoseStreak = 0; }
        tempWinStreak++;
      }
      continue;
    }
    
    // 用历史数据预测
    const history = balls.slice(0, i);
    if (history.length < 10) continue;
    
    const engineResult = engine.runPredictionEngine(history, {
      ruleEnabled: state.ruleEnabled,
      ruleReversed: state.ruleReversed,
      ruleStats: ruleStats
    });
    
    if (!engineResult.finalPrediction) continue;
    
    const finalPred = engineResult.finalPrediction;
    const parity = ball.parity;
    
    if (!parity) continue;
    
    const isCorrect = finalPred === parity;
    
    // 更新规则统计
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
      wins++;
      currentWinStreak++;
      currentLoseStreak = 0;
      if (currentWinStreak > bestWinStreak) bestWinStreak = currentWinStreak;
      
      // 连败记录
      if (tempLoseStreak > 0) { allLoseStreaks.push(tempLoseStreak); tempLoseStreak = 0; }
      tempWinStreak++;
    } else {
      losses++;
      currentLoseStreak++;
      currentWinStreak = 0;
      if (currentLoseStreak > bestLoseStreak) bestLoseStreak = currentLoseStreak;
      if (currentLoseStreak > maxLoseStreak) maxLoseStreak = currentLoseStreak;
      
      // 连胜记录
      if (tempWinStreak > 0) { allWinStreaks.push(tempWinStreak); tempWinStreak = 0; }
      tempLoseStreak++;
      
      // 触发熔断
      if (currentLoseStreak >= loseThreshold) {
        if (strategy === 'fixed') {
          cooldownRemaining = cooldownBlocks;
        } else if (strategy === 'escalating') {
          // 连败越多，冷却越长
          const extra = currentLoseStreak - loseThreshold;
          cooldownRemaining = cooldownBlocks * (1 + extra);
        } else if (strategy === 'percent') {
          // 跳过接下来 N% 的区块
          cooldownRemaining = Math.ceil(cooldownBlocks * (1 + currentLoseStreak * 0.2));
        }
      }
    }
  }
  
  // 收尾
  if (tempLoseStreak > 0) allLoseStreaks.push(tempLoseStreak);
  if (tempWinStreak > 0) allWinStreaks.push(tempWinStreak);
  
  const total = wins + losses;
  const winRate = total > 0 ? (wins / total * 100) : 0;
  const avgLoseStreak = allLoseStreaks.length > 0 ? (allLoseStreaks.reduce((a, b) => a + b, 0) / allLoseStreaks.length) : 0;
  const avgWinStreak = allWinStreaks.length > 0 ? (allWinStreaks.reduce((a, b) => a + b, 0) / allWinStreaks.length) : 0;
  const highLose = allLoseStreaks.filter(s => s >= 5).length;
  const maxLose = allLoseStreaks.length > 0 ? Math.max(...allLoseStreaks) : 0;
  const skipRate = balls.length > 0 ? (skipped / balls.length * 100) : 0;
  
  return {
    total, wins, losses, winRate, bestWinStreak, bestLoseStreak: bestLoseStreak,
    maxLoseStreak: maxLose, avgLoseStreak: avgLoseStreak.toFixed(1),
    avgWinStreak: avgWinStreak.toFixed(1), highLoseCount: highLose,
    skipped, skipRate: skipRate.toFixed(1)
  };
}

// ========== 测试不同策略 ==========

console.log('=' .repeat(100));
console.log('策略A: 无熔断（基线）');
console.log('=' .repeat(100));
const baseline = runBacktest({ loseThreshold: 999, cooldownBlocks: 0 });
console.log(`  胜率: ${baseline.winRate.toFixed(1)}%  总预测: ${baseline.total}  跳过: ${baseline.skipped}`);
console.log(`  最高连败: ${baseline.maxLoseStreak}  平均连败: ${baseline.avgLoseStreak}  平均连胜: ${baseline.avgWinStreak}`);
console.log(`  连败≥5次数: ${baseline.highLoseCount}`);
console.log();

console.log('=' .repeat(100));
console.log('策略B: 固定冷却 — 连败N次后跳过M个区块');
console.log('=' .repeat(100));

const configs = [];
for (const threshold of [2, 3, 4, 5]) {
  for (const cooldown of [1, 2, 3]) {
    configs.push({ loseThreshold: threshold, cooldownBlocks: cooldown, strategy: 'fixed' });
  }
}

console.log('连败阈值 | 冷却区块 | 胜率   | 总预测 | 最高连败 | 平均连败 | 平均连胜 | 连败≥5 | 跳过率');
console.log('-'.repeat(100));

let best = null;
let bestScore = -Infinity;

for (const cfg of configs) {
  const r = runBacktest(cfg);
  // 综合评分：胜率权重高，连败惩罚大
  const score = r.winRate * 2 - r.maxLoseStreak * 5 - r.avgLoseStreak * 3 - r.highLoseCount * 2;
  
  if (score > bestScore) {
    bestScore = score;
    best = { ...cfg, ...r, score };
  }
  
  console.log(`  ${String(cfg.loseThreshold).padStart(4)}    |    ${String(cfg.cooldownBlocks).padStart(2)}    | ${r.winRate.toFixed(1).padStart(5)}% | ${String(r.total).padStart(5)}  |    ${String(r.maxLoseStreak).padStart(3)}    |   ${r.avgLoseStreak.padStart(5)}   |   ${r.avgWinStreak.padStart(5)}   |  ${String(r.highLoseCount).padStart(3)}   |  ${r.skipRate.padStart(4)}%`);
}

console.log();
console.log('=' .repeat(100));
console.log('策略C: 递增冷却 — 连败越多冷却越长');
console.log('=' .repeat(100));

const escConfigs = [];
for (const threshold of [3, 4, 5]) {
  for (const cooldown of [1, 2]) {
    escConfigs.push({ loseThreshold: threshold, cooldownBlocks: cooldown, strategy: 'escalating' });
  }
}

console.log('连败阈值 | 基础冷却 | 胜率   | 总预测 | 最高连败 | 平均连败 | 平均连胜 | 连败≥5 | 跳过率');
console.log('-'.repeat(100));

for (const cfg of escConfigs) {
  const r = runBacktest(cfg);
  const score = r.winRate * 2 - r.maxLoseStreak * 5 - r.avgLoseStreak * 3 - r.highLoseCount * 2;
  
  if (score > bestScore) {
    bestScore = score;
    best = { ...cfg, ...r, score };
  }
  
  console.log(`  ${String(cfg.loseThreshold).padStart(4)}    |    ${String(cfg.cooldownBlocks).padStart(2)}    | ${r.winRate.toFixed(1).padStart(5)}% | ${String(r.total).padStart(5)}  |    ${String(r.maxLoseStreak).padStart(3)}    |   ${r.avgLoseStreak.padStart(5)}   |   ${r.avgWinStreak.padStart(5)}   |  ${String(r.highLoseCount).padStart(3)}   |  ${r.skipRate.padStart(4)}%`);
}

console.log();
console.log('=' .repeat(100));
console.log('🏆 最优策略');
console.log('=' .repeat(100));
console.log(`  策略: ${best.strategy}`);
console.log(`  连败阈值: ${best.loseThreshold}`);
console.log(`  冷却区块: ${best.cooldownBlocks}`);
console.log(`  胜率: ${best.winRate.toFixed(1)}%`);
console.log(`  最高连败: ${best.maxLoseStreak}`);
console.log(`  平均连败: ${best.avgLoseStreak}`);
console.log(`  平均连胜: ${best.avgWinStreak}`);
console.log(`  连败≥5次数: ${best.highLoseCount}`);
console.log(`  总预测: ${best.total}`);
console.log(`  跳过率: ${best.skipRate}%`);
console.log(`  综合评分: ${best.score.toFixed(1)}`);
