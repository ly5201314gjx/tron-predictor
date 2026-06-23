#!/usr/bin/env node
/**
 * 智能熔断全量回测 — 连败2次冷却1块 详细报告
 * 对比：无熔断 vs 智能熔断
 */

const engine = require('./engine');
const storage = require('./storage');
const { state } = storage;

const balls = state.balls;
console.log(`📊 全量数据: ${balls.length} 球\n`);

function runSmartBreakbacktest(smartEnabled, threshold, cooldown) {
  let wins = 0, losses = 0, skipped = 0;
  let curLose = 0, curWin = 0;
  let maxWin = 0, maxLose = 0;
  let cooldownUntil = 0;
  let cooldownCount = 0;
  let totalPredictions = 0;

  // 逐球详细记录
  const detail = [];
  // 连败连胜分布
  const loseStreaks = [];
  const winStreaks = [];
  let tempLose = 0, tempWin = 0;

  // 每50球胜率统计
  const windows = [];
  let wWins = 0, wLosses = 0;

  const ruleStats = {};

  for (let i = 0; i < balls.length; i++) {
    const ball = balls[i];
    const h = ball.height;
    const actual = ball.parity;

    // 冷却期检查
    if (smartEnabled && cooldownUntil > 0 && h <= cooldownUntil) {
      skipped++;
      detail.push({ height: h, actual, predicted: '-', result: '冷却', streak: '-' });
      // 冷却期间也统计实际走势
      if (actual === 'single') { /* count */ }
      continue;
    }

    // 冷却结束
    if (smartEnabled && cooldownUntil > 0 && h > cooldownUntil) {
      cooldownUntil = 0;
      curLose = 0;
    }

    // 数据不足
    const history = balls.slice(0, i);
    if (history.length < 10 || !actual) {
      detail.push({ height: h, actual, predicted: '-', result: '无数据', streak: '-' });
      continue;
    }

    // 运行引擎
    const engineResult = engine.runPredictionEngine(history, {
      ruleEnabled: state.ruleEnabled,
      ruleReversed: state.ruleReversed,
      ruleStats
    });

    if (!engineResult.finalPrediction) {
      detail.push({ height: h, actual, predicted: '-', result: '无预测', streak: '-' });
      continue;
    }

    const pred = engineResult.finalPrediction;
    const isCorrect = pred === actual;
    totalPredictions++;

    if (isCorrect) {
      wins++;
      curWin++;
      curLose = 0;
      if (curWin > maxWin) maxWin = curWin;
      if (tempLose > 0) { loseStreaks.push(tempLose); tempLose = 0; }
      tempWin++;
    } else {
      losses++;
      curLose++;
      curWin = 0;
      if (curLose > maxLose) maxLose = curLose;
      if (tempWin > 0) { winStreaks.push(tempWin); tempWin = 0; }
      tempLose++;

      // 智能熔断触发
      if (smartEnabled && curLose >= threshold) {
        cooldownUntil = h + 20 * cooldown;
        cooldownCount++;
        curLose = 0;
      }
    }

    const predLabel = pred === 'single' ? '单' : '双';
    const actualLabel = actual === 'single' ? '单' : '双';
    detail.push({
      height: h,
      actual: actualLabel,
      predicted: predLabel,
      result: isCorrect ? '✅' : '❌',
      streak: isCorrect ? `W${curWin || 1}` : `L${curLose || 1}`
    });

    wWins += isCorrect ? 1 : 0;
    wLosses += isCorrect ? 0 : 1;
    if ((wWins + wLosses) % 50 === 0 && wWins + wLosses > 0) {
      windows.push({ from: detail[Math.max(0, detail.length - 50)].height, rate: (wWins / (wWins + wLosses) * 100).toFixed(1) });
    }
  }

  if (tempLose > 0) loseStreaks.push(tempLose);
  if (tempWin > 0) winStreaks.push(tempWin);

  const total = wins + losses;
  const winRate = total > 0 ? (wins / total * 100) : 0;
  const avgLose = loseStreaks.length > 0 ? (loseStreaks.reduce((a, b) => a + b, 0) / loseStreaks.length) : 0;
  const avgWin = winStreaks.length > 0 ? (winStreaks.reduce((a, b) => a + b, 0) / winStreaks.length) : 0;

  return {
    total, wins, losses, winRate, skipped, cooldownCount,
    maxWin, maxLose, avgLose: avgLose.toFixed(1), avgWin: avgWin.toFixed(1),
    loseStreaks, winStreaks, detail, windows,
    totalPredictions
  };
}

// ========== 运行回测 ==========
console.log('⏳ 正在运行无熔断基线...');
const baseline = runSmartBreakbacktest(false, 0, 0);

console.log('⏳ 正在运行智能熔断（连败2次冷却1块）...');
const smart21 = runSmartBreakbacktest(true, 2, 1);

console.log('⏳ 正在运行智能熔断（连败3次冷却1块）...');
const smart31 = runSmartBreakbacktest(true, 3, 1);

console.log('⏳ 正在运行智能熔断（连败3次冷却2块）...');
const smart32 = runSmartBreakbacktest(true, 3, 2);

console.log('⏳ 正在运行智能熔断（连败4次冷却1块）...');
const smart41 = runSmartBreakbacktest(true, 4, 1);

// ========== 输出报告 ==========
function printReport(label, r) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(80)}`);
  console.log(`  总预测: ${r.totalPredictions}  跳过: ${r.skipped}  冷却触发: ${r.cooldownCount} 次`);
  console.log(`  胜: ${r.wins}  负: ${r.losses}  胜率: ${r.winRate.toFixed(2)}%`);
  console.log(`  最高连胜: ${r.maxWin}  最高连败: ${r.maxLose}`);
  console.log(`  平均连胜: ${r.avgWin}  平均连败: ${r.avgLose}`);
  console.log(`  连败分布: ${r.loseStreaks.length > 0 ? r.loseStreaks.map(s => s + '连败').join(', ') : '无'}`);
  console.log(`  连胜分布: ${r.winStreaks.length > 0 ? r.winStreaks.map(s => s + '连胜').join(', ') : '无'}`);

  // 连败统计
  const loseDist = {};
  for (const s of r.loseStreaks) { loseDist[s] = (loseDist[s] || 0) + 1; }
  console.log(`  连败频率:`);
  for (const [len, cnt] of Object.entries(loseDist).sort((a, b) => b[0] - a[0])) {
    console.log(`    ${len}连败: ${cnt} 次`);
  }

  // 连胜统计
  const winDist = {};
  for (const s of r.winStreaks) { winDist[s] = (winDist[s] || 0) + 1; }
  console.log(`  连胜频率:`);
  for (const [len, cnt] of Object.entries(winDist).sort((a, b) => b[0] - a[0])) {
    console.log(`    ${len}连胜: ${cnt} 次`);
  }

  // 连败≥3统计
  const lose3plus = r.loseStreaks.filter(s => s >= 3).length;
  const lose5plus = r.loseStreaks.filter(s => s >= 5).length;
  const lose7plus = r.loseStreaks.filter(s => s >= 7).length;
  console.log(`  连败≥3: ${lose3plus}次  连败≥5: ${lose5plus}次  连败≥7: ${lose7plus}次`);
}

printReport('无熔断（基线）', baseline);
printReport('智能熔断: 连败2次 冷却1块', smart21);
printReport('智能熔断: 连败3次 冷却1块', smart31);
printReport('智能熔断: 连败3次 冷却2块', smart32);
printReport('智能熔断: 连败4次 冷却1块', smart41);

// ========== 对比表 ==========
console.log(`\n${'='.repeat(100)}`);
console.log(`  📊 全面对比`);
console.log(`${'='.repeat(100)}`);
console.log(`策略                  | 胜率     | 最高连败 | 最高连胜 | 平均连败 | 平均连胜 | 连败≥5 | 跳过 | 冷却次数`);
console.log(`-`.repeat(100));

const all = [
  { label: '无熔断(基线)', r: baseline },
  { label: '连败2次冷却1块', r: smart21 },
  { label: '连败3次冷却1块', r: smart31 },
  { label: '连败3次冷却2块', r: smart32 },
  { label: '连败4次冷却1块', r: smart41 }
];

for (const a of all) {
  const r = a.r;
  const l5 = r.loseStreaks.filter(s => s >= 5).length;
  console.log(
    `${a.label.padEnd(20)}| ${r.winRate.toFixed(2).padStart(7)}% |    ${String(r.maxLose).padStart(3)}    |    ${String(r.maxWin).padStart(3)}    |   ${r.avgLose.padStart(5)}   |   ${r.avgWin.padStart(5)}   |  ${String(l5).padStart(3)}   | ${String(r.skipped).padStart(4)} |    ${String(r.cooldownCount).padStart(4)}`
  );
}

// ========== 与基线对比 ==========
console.log(`\n${'='.repeat(100)}`);
console.log(`  📈 与基线对比`);
console.log(`${'='.repeat(100)}`);

for (const a of all.slice(1)) {
  const r = a.r;
  const b = baseline;
  const wrDiff = (r.winRate - b.winRate).toFixed(2);
  const mlDiff = r.maxLose - b.maxLose;
  const l5 = r.loseStreaks.filter(s => s >= 5).length;
  const bL5 = b.loseStreaks.filter(s => s >= 5).length;
  console.log(`  ${a.label}: 胜率${wrDiff >= 0 ? '+' : ''}${wrDiff}% 最高连败${mlDiff >= 0 ? '+' : ''}${mlDiff} 连败≥5 ${bL5}→${l5} 跳过${r.skipped}球`);
}

// ========== 逐球明细（最后50球）==========
console.log(`\n${'='.repeat(100)}`);
console.log(`  📝 智能熔断(2/1) 逐球明细（最后50球）`);
console.log(`${'='.repeat(100)}`);
console.log(`高度       预测  实际  结果   连胜连败`);
console.log(`-`.repeat(60));
const detail = smart21.detail.slice(-50);
for (const d of detail) {
  const h = String(d.height).padStart(10);
  const p = d.predicted.padEnd(4);
  const a = d.actual.padEnd(4);
  const r = d.result.padEnd(6);
  const s = d.streak;
  console.log(`${h}  ${p}  ${a}  ${r}  ${s}`);
}

// ========== 长期趋势（每100球胜率）==========
console.log(`\n${'='.repeat(100)}`);
console.log(`  📈 智能熔断(2/1) 每100球胜率趋势`);
console.log(`${'='.repeat(100)}`);

let tw = 0, tl = 0;
let windowStart = 0;
for (let i = 0; i < smart21.detail.length; i++) {
  const d = smart21.detail[i];
  if (d.result === '✅') tw++;
  else if (d.result === '❌') tl++;
  if ((tw + tl) >= 100) {
    const rate = (tw / (tw + tl) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(rate / 2));
    console.log(`  #${String(smart21.detail[windowStart].height).padStart(10)}~#${String(d.height).padEnd(10)} ${rate.padStart(5)}% ${bar} (${tw}胜/${tl}负)`);
    tw = 0; tl = 0;
    windowStart = i + 1;
  }
}
if (tw + tl > 0) {
  const rate = (tw / (tw + tl) * 100).toFixed(1);
  const bar = '█'.repeat(Math.round(rate / 2));
  console.log(`  #${String(smart21.detail[windowStart].height).padStart(10)}~#${String(smart21.detail[smart21.detail.length-1].height).padEnd(10)} ${rate.padStart(5)}% ${bar} (${tw}胜/${tl}负)`);
}

// ========== 结论 ==========
console.log(`\n${'='.repeat(100)}`);
console.log(`  🏆 结论`);
console.log(`${'='.repeat(100)}`);
const b = baseline, s = smart21;
console.log(`  基线最高连败: ${b.maxLose} → 智能熔断(2/1): ${s.maxLose}  降了 ${b.maxLose - s.maxLose}`);
console.log(`  基线胜率: ${b.winRate.toFixed(2)}% → 智能熔断(2/1): ${s.winRate.toFixed(2)}%  ${s.winRate >= b.winRate ? '提升了' : '降低了'} ${Math.abs(s.winRate - b.winRate).toFixed(2)}%`);
console.log(`  基线连败≥5: ${b.loseStreaks.filter(s => s >= 5).length} → 智能熔断: ${s.loseStreaks.filter(s => s >= 5).length}`);
console.log(`  跳过率: ${s.skipped}球 / ${balls.length}球 = ${(s.skipped / balls.length * 100).toFixed(1)}%`);
