// ============================================================
// server.js — 波场单双预测服务 (Express 主入口)
// ============================================================
const express = require('express');
const path = require('path');
const engine = require('./engine');
const fetcher = require('./fetcher');
const dingtalk = require('./dingtalk');
const storage = require('./storage');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { state, config, log } = storage;

let pollTimer = null;
let isPolling = false;
let isProcessing = false;
let processingSince = 0;
let predictionSnapshot = []; // 最近的预测快照
let advancePushTimer = null; // 定时推送计时器
let lastBlockTime = Date.now(); // 上个区块处理时间
let avgBlockInterval = 62000; // 平均区块间隔(ms)，默认62秒
let lastPredictionPushBlock = 0; // 上次推送预测时的区块高度，防重复推送

// 立即推送下一期预测
async function pushNextPredictionNow() {
  try {
    // 防重复：如果没有新区块处理过，跳过推送
    const currentHeight = state.lastKnownBlockHeight || 0;
    if (currentHeight <= lastPredictionPushBlock) {
      log(`⏭️ 预测跳过: 当前高度${currentHeight} <= 已推送高度${lastPredictionPushBlock}`);
      return;
    }
    
    const balls = storage.getBalls();
    if (balls.length < 1) return;
    
    const engineResult = engine.runPredictionEngine(balls, {
      ruleEnabled: state.ruleEnabled,
      ruleReversed: state.ruleReversed,
      ruleStats: state.ruleStats
    });
    
    if (!engineResult.finalPrediction) return;
    
    let finalPred = engineResult.finalPrediction;
    let combinedConf = engineResult.combinedConfidence;
    
    if (state.reverseModeEnabled && state.reversePhase) {
      finalPred = engine.reverseParity(finalPred);
    }
    
    // 周期检测
    if (state.periodDetectionEnabled && finalPred) {
      const pd = engine.applyPeriodDetection(balls, { finalPrediction: finalPred, combinedConfidence: combinedConf }, {
        window: state.periodDetectionWindow,
        threshold: state.periodDetectionThreshold,
        boost: state.periodDetectionBoost
      });
      finalPred = pd.pred;
      combinedConf = pd.conf;
      state.periodDetectionBias = pd.periodBias;
    }
    
    // 检查推送条件
    let shouldPush = false;
    let ruleStatsWithRate = [];
    
    if (config.dingModeHighWinRate && dingtalk.hasValidDingWebhook()) {
      const ruleOutputs = engineResult.ruleOutputs.filter(r => !r.ruleId.startsWith('DRAGON'));
      let totalRate = 0, rateCount = 0;
      for (const ro of ruleOutputs) {
        const st = state.ruleStats[ro.ruleId];
        if (st && st.used >= 5) {
          const rate = st.wins / st.used;
          ruleStatsWithRate.push({ ruleId: ro.ruleId, ruleName: ro.ruleName, ruleRate: rate * 100 });
          totalRate += rate;
          rateCount++;
        }
      }
      const avgRate = rateCount > 0 ? (totalRate / rateCount) * 100 : 0;
      if (avgRate >= config.dingModeHighWinThreshold) {
        shouldPush = true;
      }
    }
    
    if (shouldPush) {
      const nextHeight = Math.ceil(((state.lastKnownBlockHeight || 0) + 1) / 20) * 20;
      const dirLabel = finalPred === 'single' ? '单' : '双';
      const confText = (combinedConf * 100).toFixed(1) + '%';
      
      const parts = [];
      parts.push(`📊 波场单双监控`);
      parts.push(`━━━━━━━━━━━━━━`);
      parts.push(`🔮 下期预测`);
      parts.push(`🎯 预测：${dirLabel}  |  置信：${confText}`);
      if (nextHeight) parts.push(`📍 目标高度：#${nextHeight}`);
      
      // 近100球统计
      const recentBalls = state.balls.slice(-100);
      const recentWins = recentBalls.filter(b => b.resultMark === 'W').length;
      const recentSingles = recentBalls.filter(b => b.parity === 'single').length;
      const recentDoubles = recentBalls.filter(b => b.parity === 'double').length;
      const recentRate = recentBalls.length > 0 ? (recentWins / recentBalls.length * 100).toFixed(1) : '-';
      parts.push(`📊 近100球: ${recentRate}%  |  单${recentSingles}双${recentDoubles}`);
      
      const sorted = ruleStatsWithRate.filter(r => r.ruleRate !== null).sort((a, b) => (b.ruleRate || 0) - (a.ruleRate || 0));
      if (sorted.length > 0) {
        parts.push(`━━━ 规则胜率 ━━━`);
        // 计算平均胜率
        const avg = sorted.reduce((s, r) => s + r.ruleRate, 0) / sorted.length;
        parts.push(`平均 ${avg.toFixed(1)}%  ·  参与 ${sorted.length} 条`);
        const ruleLine = sorted.slice(0, 10).map(r => `${r.ruleId}(${r.ruleRate.toFixed(0)}%)`).join(' ');
        parts.push(`  ${ruleLine}`);
        if (sorted.length > 10) parts.push(`  ...等 ${sorted.length} 条`);
      }
      
      await dingtalk.sendDingTalkMessage(parts.join('\n'), log);
      lastPredictionPushBlock = currentHeight;
      log(`📣 已推送下期预测: ${dirLabel} ${confText}`);
    }
    
    // 备份定时器已废弃：handleBlock 的 1s 延迟推送已足够，避免重复推送
    
  } catch (err) {
    log(`推送下期预测出错: ${err.message}`, 'error');
  }
}

// 推送本期结果
async function pushResult(ball, finalPred, combinedConf, engineResult, isCorrect) {
  try {
    if (!dingtalk.hasValidDingWebhook()) return;
    
    const dirLabel = finalPred === 'single' ? '单' : '双';
    const actualLabel = ball.parity === 'single' ? '单' : ball.parity === 'double' ? '双' : '-';
    const resText = isCorrect ? '✅ 正确' : '❌ 错误';
    
    const parts = [];
    parts.push(`📊 波场单双监控`);
    parts.push(`━━━━━━━━━━━━━━`);
    parts.push(`📍 高度 #${ball.height}`);
    parts.push(`🎯 预测：${dirLabel}  |  实际：${actualLabel}`);
    parts.push(`🏷 结果：${resText}`);
    parts.push(`📈 连胜 ${state.currentWinStreak}  ·  连败 ${state.currentLoseStreak}`);
    
    // 近100球统计
    const recentBalls = state.balls.slice(-100);
    const recentWins = recentBalls.filter(b => b.resultMark === 'W').length;
    const recentSingles = recentBalls.filter(b => b.parity === 'single').length;
    const recentDoubles = recentBalls.filter(b => b.parity === 'double').length;
    const recentRate = recentBalls.length > 0 ? (recentWins / recentBalls.length * 100).toFixed(1) : '-';
    parts.push(`📊 近100球: ${recentRate}%  |  单${recentSingles}双${recentDoubles}`);
    
    // 计算参与规则平均胜率
    const ruleOutputs = engineResult.ruleOutputs.filter(r => !r.ruleId.startsWith('DRAGON'));
    let totalRate = 0, rateCount = 0;
    const ruleStatsWithRate = [];
    for (const ro of ruleOutputs) {
      const st = state.ruleStats[ro.ruleId];
      if (st && st.used >= 5) {
        const rate = st.wins / st.used;
        ruleStatsWithRate.push({ ruleId: ro.ruleId, ruleRate: rate * 100 });
        totalRate += rate;
        rateCount++;
      }
    }
    const avgRate = rateCount > 0 ? (totalRate / rateCount) * 100 : 0;
    
    const sorted = ruleStatsWithRate.sort((a, b) => (b.ruleRate || 0) - (a.ruleRate || 0));
    if (sorted.length > 0) {
      parts.push(`━━━ 规则胜率 ━━━`);
      parts.push(`平均 ${avgRate.toFixed(1)}%  ·  参与 ${sorted.length} 条`);
      // 紧凑显示：R1(60%) R2(55%) R3(72%) ...
      const ruleLine = sorted.slice(0, 10).map(r => `${r.ruleId}(${r.ruleRate.toFixed(0)}%)`).join(' ');
      parts.push(`  ${ruleLine}`);
      if (sorted.length > 10) parts.push(`  ...等 ${sorted.length} 条`);
    }
    
    await dingtalk.sendDingTalkMessage(parts.join('\n'), log);
    log(`📣 已推送结果: #${ball.height} ${dirLabel} ${resText}`);
  } catch (err) {
    log(`推送结果出错: ${err.message}`, 'error');
  }
}

async function processNewBlocks() {
  // 防止并发：如果上一轮卡住超过30秒，强制重置
  if (isProcessing) {
    if (processingSince > 0 && Date.now() - processingSince > 30000) {
      log('⚠️ isProcessing 卡住超过30秒，强制重置', 'warn');
      isProcessing = false;
    } else {
      return;
    }
  }
  isProcessing = true;
  processingSince = Date.now();
  try {
    const latest = await fetcher.fetchLatestBlockNumber();
    if (state.lastKnownBlockHeight === null) {
      state.lastKnownBlockHeight = latest;
      log(`初始化完成，当前最新区块高度: ${latest}`);
      storage.saveState();
      return;
    }
    if (latest <= state.lastKnownBlockHeight) return;

    const startHeight = state.lastKnownBlockHeight + 1;
    // 收集所有需要抓取的高度
    const interestingHeights = [];
    for (let h = startHeight; h <= latest; h++) {
      if (fetcher.isInterestingHeight(h)) {
        interestingHeights.push(h);
      }
    }
    
    // 逐个顺序抓取（限流器会自动控制速度）
    let processedBlocks = false;
    if (interestingHeights.length > 0) {
      for (const h of interestingHeights) {
        try {
          const block = await fetcher.fetchBlockByNumber(h);
          if (block) {
            await handleBlock(block);
            processedBlocks = true;
          }
        } catch (err) {
          log(`获取区块 ${h} 失败: ${err.message}`, 'error');
        }
      }
    }
    
    state.lastKnownBlockHeight = latest;
    storage.saveState();
    
    // 只在处理了新区块后才推一次下期预测，没处理就不推
    // 智能熔断冷却中也不推
    if (processedBlocks && !(state.smartBreakerEnabled && state.smartBreakerCoolingUntil > 0)) {
      await pushNextPredictionNow();
    }
  } catch (err) {
    log(`轮询出错: ${err.message}`, 'error');
  } finally {
    isProcessing = false;
    processingSince = 0;
  }
}

async function handleBlock(block) {
  const rawNumber = block?.block_header?.raw_data?.number;
  const blockID = block?.blockID;
  if (!rawNumber || !blockID) return;

  // 去重：如果这个高度已经处理过了，跳过
  if (state.balls.some(b => b.height === rawNumber)) {
    log(`⏭️ 高度 ${rawNumber} 已存在，跳过重复`, 'warn');
    return;
  }

  const parsed = engine.deriveParityFromHash(blockID);
  const { parity, lastChar, numericValue } = parsed;

  const ball = {
    height: rawNumber,
    blockHash: blockID,
    parity,
    lastChar,
    numericValue,
    time: Date.now(),
    timeStr: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    prediction: null,
    resultMark: null,
    ruleResults: [],
    dingTalkSent: false
  };

  // 先加球再推送，防止并发 handleBlock 同时通过去重检查导致重复推送
  storage.addBall(ball);

  // 用加球前的历史数据计算预测（预测当前球，不是下一个球）
  const history = state.balls.slice(0, -1);

  if (history.length > 0) {
    // ========== 智能熔断：冷却期内跳过预测 ==========
    if (state.smartBreakerEnabled && state.smartBreakerCoolingUntil > 0 && rawNumber <= state.smartBreakerCoolingUntil) {
      log(`⏸ 智能熔断冷却中: #${rawNumber} ≤ #${state.smartBreakerCoolingUntil}，跳过预测`, 'warn');
    } else {
      // 冷却期结束（不重置连败计数，让连败延续 — 如果还继续输就再次触发熔断）
      if (state.smartBreakerEnabled && state.smartBreakerCoolingUntil > 0 && rawNumber > state.smartBreakerCoolingUntil) {
        log(`✅ 智能熔断冷却结束: #${rawNumber}，连败${state.currentLoseStreak}次继续保留`, 'warn');
        state.smartBreakerCoolingUntil = 0;
        // 不重置 currentLoseStreak，让连败跨冷却延续
      }

    // ========== 旧熔断 ==========
    if (state.circuitBreakerEnabled && state.circuitBreakerArmed) {
      state.circuitBreakerArmed = false;
      log(`🔒 旧熔断生效：跳过高度 ${rawNumber}`, 'warn');
      if (dingtalk.hasValidDingWebhook()) {
        dingtalk.sendDingTalkMessage(`🔒 熔断生效：跳过高度 ${rawNumber} 的预测`, log);
      }
    } else {
      // ========== 运行预测引擎 ==========
      const engineResult = engine.runPredictionEngine(history, {
        ruleEnabled: state.ruleEnabled,
        ruleReversed: state.ruleReversed,
        ruleStats: state.ruleStats
      });

      let finalPred = engineResult.finalPrediction;
      let combinedConf = engineResult.combinedConfidence;

      if (state.reverseModeEnabled && finalPred && state.reversePhase) {
        finalPred = engine.reverseParity(finalPred);
      }

      // 周期检测：检测单双分布偏移，可能翻转预测方向
      if (state.periodDetectionEnabled && finalPred) {
        const pd = engine.applyPeriodDetection(history, { finalPrediction: finalPred, combinedConfidence: combinedConf }, {
          window: state.periodDetectionWindow,
          threshold: state.periodDetectionThreshold,
          boost: state.periodDetectionBoost
        });
        if (pd.flipped) {
          log(`🔄 周期检测翻转: ${engine.parityToLabel(finalPred)} → ${engine.parityToLabel(pd.pred)} (偏移${(pd.periodBias*100).toFixed(1)}%)`);
        }
        finalPred = pd.pred;
        combinedConf = pd.conf;
        state.periodDetectionBias = pd.periodBias;
      }

      ball.prediction = finalPred;
      ball.ruleResults = engineResult.ruleOutputs;

      if (finalPred && parity) {
        const isCorrect = finalPred === parity;
        ball.resultMark = isCorrect ? 'W' : 'L';

        if (isCorrect) {
          state.totalWins++;
          state.currentWinStreak++;
          state.currentLoseStreak = 0;
          state.smartBreakerCooldownCount = 0; // 赢了重置冷却计数，下次从头开始
          if (state.currentWinStreak > state.bestWinStreak) state.bestWinStreak = state.currentWinStreak;
          log(`✅ 预测正确！高度 ${rawNumber}，预测 ${engine.parityToLabel(finalPred)}，实际 ${engine.parityToLabel(parity)}`);
        } else {
          state.totalLosses++;
          state.currentLoseStreak++;
          state.currentWinStreak = 0;
          if (state.currentLoseStreak > state.bestLoseStreak) state.bestLoseStreak = state.currentLoseStreak;
          log(`❌ 预测失败！高度 ${rawNumber}，预测 ${engine.parityToLabel(finalPred)}，实际 ${engine.parityToLabel(parity)}`, 'warn');

          // 旧熔断触发
          if (state.circuitBreakerEnabled && state.currentLoseStreak >= state.circuitBreakerThreshold) {
            state.circuitBreakerArmed = true;
            log(`🔒 旧熔断触发：连续 ${state.currentLoseStreak} 次失败`, 'warn');
          }

          // 智能熔断触发：连败达到阈值 → 冷却N个区块（递增冷却，避免反复触发死循环）
          if (state.smartBreakerEnabled && !state.smartBreakerCoolingUntil && state.currentLoseStreak >= state.smartBreakerThreshold) {
            // 递增冷却：第1次跳1块，第2次跳2块，第3次跳3块...
            const effectiveCooldown = Math.min(state.smartBreakerCooldown + state.smartBreakerCooldownCount, 5);
            const interestingGap = 20;
            state.smartBreakerCoolingUntil = rawNumber + interestingGap * effectiveCooldown;
            state.smartBreakerCooldownCount++;
            log(`⚡ 智能熔断触发：连续${state.currentLoseStreak}次失败，冷却${effectiveCooldown}块到 #${state.smartBreakerCoolingUntil}`, 'warn');
            if (dingtalk.hasValidDingWebhook()) {
              dingtalk.sendDingTalkMessage(`📊 波场单双监控\n━━━━━━━━━━━━━━\n⚡ 智能熔断触发\n━━━━━━━━━━━━━━\n连败${state.currentLoseStreak}次达到阈值(${state.smartBreakerThreshold})\n冷却 ${effectiveCooldown} 个区块到 #${state.smartBreakerCoolingUntil}\n累计触发 ${state.smartBreakerCooldownCount} 次`, log);
            }
          }

          // 逆向模式翻转
          if (state.reverseModeEnabled) {
            state.reversePhase = !state.reversePhase;
            log(`🔄 逆向模式翻转`);
          }
        }

        // 更新规则统计
        for (const ro of engineResult.ruleOutputs) {
          if (ro.ruleId && !ro.ruleId.startsWith('DRAGON')) {
            if (!state.ruleStats[ro.ruleId]) {
              state.ruleStats[ro.ruleId] = { name: ro.ruleName, used: 0, wins: 0, losses: 0 };
            }
            state.ruleStats[ro.ruleId].used++;
            if (isCorrect) state.ruleStats[ro.ruleId].wins++;
            else state.ruleStats[ro.ruleId].losses++;
            engine.recentPerformance.recordResult(ro.ruleId, isCorrect);
          }
        }

        // 钉钉推送结果
        dingtalk.updateDingRuntime(state.currentLoseStreak, state.currentWinStreak, ball.resultMark);
        if (dingtalk.hasValidDingWebhook() && rawNumber > state.highestPushedHeight) {
          state.highestPushedHeight = rawNumber;
          await pushResult(ball, finalPred, combinedConf, engineResult, isCorrect);
        }
      } else if (finalPred && !parity) {
        log(`⚠️ 高度 ${rawNumber}：有预测但未获取到实际结果`, 'warn');
      }

      // 保存预测快照
      predictionSnapshot.unshift({
        time: ball.timeStr,
        height: rawNumber,
        prediction: finalPred ? engine.parityToLabel(finalPred) : '-',
        actual: parity ? engine.parityToLabel(parity) : '-',
        result: ball.resultMark,
        confidence: combinedConf ? (combinedConf * 100).toFixed(1) + '%' : '-'
      });
      if (predictionSnapshot.length > 100) predictionSnapshot.pop();
    }
    } // 智能熔断 else 结束
  } else {
    log(`首球记录：高度 ${rawNumber}（无历史数据）`);
  }

  // 更新区块时间追踪
  const now = Date.now();
  const interval = now - lastBlockTime;
  if (interval > 30000 && interval < 120000) {
    avgBlockInterval = Math.round(avgBlockInterval * 0.7 + interval * 0.3);
  }
  lastBlockTime = now;
  
  // 不在这里设定时器推预测，由 processNewBlocks 统一推一次
  
  storage.saveState();
}

function startPolling() {
  if (isPolling) return;
  isPolling = true;
  log('🚀 开始实时轮询波场区块链');
  pollingLoop();
}

async function pollingLoop() {
  if (!isPolling) return;
  if (isProcessing) {
    setTimeout(pollingLoop, 1500);
    return;
  }

  try {
    await processNewBlocks();
  } catch (err) {
    log(`轮询异常: ${err.message}`, 'error');
  }

  // 智能间隔：刚处理完区块后快速再查（可能还有积压），否则正常3秒
  const elapsed = Date.now() - lastBlockTime;
  const waitMs = elapsed < 5000 ? 1500 : 3000;

  if (isPolling) {
    setTimeout(pollingLoop, waitMs);
  }
}

function stopPolling() {
  isPolling = false;
  log('⏹ 停止实时轮询');
}

// ---------- REST API ----------

// 状态信息
app.get('/api/status', (req, res) => {
  res.json({
    isPolling,
    lastKnownBlockHeight: state.lastKnownBlockHeight,
    totalBalls: state.balls.length,
    totalWins: state.totalWins,
    totalLosses: state.totalLosses,
    winRate: (state.totalWins + state.totalLosses) > 0
      ? ((state.totalWins / (state.totalWins + state.totalLosses)) * 100).toFixed(2) + '%' : '-',
    currentWinStreak: state.currentWinStreak,
    currentLoseStreak: state.currentLoseStreak,
    bestWinStreak: state.bestWinStreak,
    bestLoseStreak: state.bestLoseStreak,
    circuitBreakerEnabled: state.circuitBreakerEnabled,
    circuitBreakerArmed: state.circuitBreakerArmed,
    circuitBreakerThreshold: state.circuitBreakerThreshold,
    reverseModeEnabled: state.reverseModeEnabled,
    reversePhase: state.reversePhase,
    smartBreakerEnabled: state.smartBreakerEnabled,
    smartBreakerThreshold: state.smartBreakerThreshold,
    smartBreakerCooldown: state.smartBreakerCooldown,
    smartBreakerCoolingUntil: state.smartBreakerCoolingUntil,
    smartBreakerCooldownCount: state.smartBreakerCooldownCount,
    periodDetectionEnabled: state.periodDetectionEnabled,
    periodDetectionWindow: state.periodDetectionWindow,
    periodDetectionThreshold: state.periodDetectionThreshold,
    periodDetectionBoost: state.periodDetectionBoost,
    periodDetectionBias: (state.periodDetectionBias * 100).toFixed(1) + '%'
  });
});

// 球池数据
app.get('/api/balls', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const balls = storage.getBalls();
  const sliced = balls.slice(-limit).reverse();
  res.json(sliced);
});

// 获取全部球数据（用于回测）
app.get('/api/balls/all', (req, res) => {
  res.json(storage.getBalls());
});

// 预测快照
app.get('/api/predictions', (req, res) => {
  res.json(predictionSnapshot);
});

// 规则列表
app.get('/api/rules', (req, res) => {
  const rules = engine.RULES.map(r => ({
    id: r.id,
    name: r.name,
    baseWeight: r.baseWeight,
    enabled: state.ruleEnabled[r.id] !== false,
    reversed: !!state.ruleReversed[r.id],
    highTag: !!state.ruleHighTag[r.id],
    lowTag: !!state.ruleLowTag[r.id],
    stats: state.ruleStats[r.id] || { name: r.name, used: 0, wins: 0, losses: 0 }
  }));
  res.json(rules);
});

// 更新规则
app.post('/api/rules', (req, res) => {
  const { ruleId, enabled, reversed } = req.body;
  if (ruleId) {
    if (enabled !== undefined) state.ruleEnabled[ruleId] = enabled;
    if (reversed !== undefined) state.ruleReversed[ruleId] = reversed;
    storage.saveState();
  }
  res.json({ success: true });
});

// 批量更新规则
app.post('/api/rules/batch', (req, res) => {
  const { action, value, threshold } = req.body;
  const rules = engine.RULES;

  if (action === 'enableAll') {
    rules.forEach(r => { state.ruleEnabled[r.id] = true; });
  } else if (action === 'disableLow') {
    const t = threshold || 50;
    for (const id of Object.keys(state.ruleStats)) {
      const st = state.ruleStats[id];
      if (st.used > 0) {
        const rate = (st.wins / st.used) * 100;
        if (rate < t) state.ruleEnabled[id] = false;
      }
    }
  } else if (action === 'reverseLow') {
    const t = threshold || 40;
    for (const id of Object.keys(state.ruleStats)) {
      const st = state.ruleStats[id];
      if (st.used > 0) {
        const rate = (st.wins / st.used) * 100;
        if (rate < t) state.ruleReversed[id] = true;
      }
    }
  } else if (action === 'clearReversed') {
    for (const id of Object.keys(state.ruleReversed)) state.ruleReversed[id] = false;
  } else if (action === 'setTags') {
    const high = threshold?.high || 70;
    const low = threshold?.low || 40;
    for (const id of Object.keys(state.ruleStats)) {
      const st = state.ruleStats[id];
      if (st.used > 0) {
        const rate = (st.wins / st.used) * 100;
        state.ruleHighTag[id] = rate >= high;
        state.ruleLowTag[id] = rate <= low;
      }
    }
  } else if (action === 'clearTags') {
    for (const id of Object.keys(state.ruleHighTag)) state.ruleHighTag[id] = false;
    for (const id of Object.keys(state.ruleLowTag)) state.ruleLowTag[id] = false;
  }

  storage.saveState();
  res.json({ success: true });
});

// 下一球预测（基于当前球池）
app.get('/api/next-prediction', (req, res) => {
  const balls = storage.getBalls();
  if (balls.length < 1) {
    return res.json({ prediction: null, confidence: 0, ruleCount: 0, message: '数据不足，需要至少 1 个历史球' });
  }
  const engineResult = engine.runPredictionEngine(balls, {
    ruleEnabled: state.ruleEnabled,
    ruleReversed: state.ruleReversed,
    ruleStats: state.ruleStats
  });
  let finalPred = engineResult.finalPrediction;
  let combinedConf = engineResult.combinedConfidence;
  let usedReverse = false;

  if (state.reverseModeEnabled && finalPred) {
    if (state.reversePhase) {
      finalPred = engine.reverseParity(finalPred);
      usedReverse = true;
    }
  }

  const dragonInfo = engine.getDragonInfo(balls);
  const ruleCount = engineResult.ruleOutputs.filter(r => !r.ruleId.startsWith('DRAGON')).length;

  res.json({
    prediction: finalPred,
    predictionLabel: finalPred ? engine.parityToLabel(finalPred) : null,
    confidence: combinedConf,
    confidencePercent: (combinedConf * 100).toFixed(1) + '%',
    ruleCount,
    dragonLength: dragonInfo.length,
    dragonParity: dragonInfo.parity ? engine.parityToLabel(dragonInfo.parity) : null,
    reverseMode: state.reverseModeEnabled,
    reversePhase: state.reversePhase,
    usedReverse,
    totalBalls: balls.length,
    circuitBreakerArmed: state.circuitBreakerArmed
  });
});

// 配置
app.get('/api/config', (req, res) => {
  res.json({
    dingWebhook: config.dingWebhook || '',
    dingModeHighWinRate: config.dingModeHighWinRate !== false,
    dingModeHighWinThreshold: config.dingModeHighWinThreshold || 62,
    dingModeFail: config.dingModeFail,
    dingModeFailThreshold: config.dingModeFailThreshold,
    dingModeWin: config.dingModeWin,
    dingModeWinThreshold: config.dingModeWinThreshold,
    pollingInterval: config.pollingInterval,
    circuitBreakerEnabled: state.circuitBreakerEnabled,
    circuitBreakerThreshold: state.circuitBreakerThreshold,
    reverseModeEnabled: state.reverseModeEnabled,
    smartBreakerEnabled: state.smartBreakerEnabled,
    smartBreakerThreshold: state.smartBreakerThreshold,
    smartBreakerCooldown: state.smartBreakerCooldown,
    periodDetectionEnabled: state.periodDetectionEnabled,
    periodDetectionWindow: state.periodDetectionWindow,
    periodDetectionThreshold: state.periodDetectionThreshold,
    periodDetectionBoost: state.periodDetectionBoost
  });
});

app.post('/api/config', (req, res) => {
  const body = req.body;
  if (body.dingWebhook !== undefined) config.dingWebhook = body.dingWebhook;
  if (body.dingModeHighWinRate !== undefined) { config.dingModeHighWinRate = body.dingModeHighWinRate; dingtalk.updateDingConfig({ modeHighWinRate: body.dingModeHighWinRate }); }
  if (body.dingModeHighWinThreshold !== undefined) { config.dingModeHighWinThreshold = body.dingModeHighWinThreshold; dingtalk.updateDingConfig({ modeHighWinThreshold: body.dingModeHighWinThreshold }); }
  if (body.dingModeFail !== undefined) { config.dingModeFail = body.dingModeFail; dingtalk.updateDingConfig({ modeFail: body.dingModeFail }); }
  if (body.dingModeFailThreshold !== undefined) { config.dingModeFailThreshold = body.dingModeFailThreshold; dingtalk.updateDingConfig({ modeFailThreshold: body.dingModeFailThreshold }); }
  if (body.dingModeWin !== undefined) { config.dingModeWin = body.dingModeWin; dingtalk.updateDingConfig({ modeWin: body.dingModeWin }); }
  if (body.dingModeWinThreshold !== undefined) { config.dingModeWinThreshold = body.dingModeWinThreshold; dingtalk.updateDingConfig({ modeWinThreshold: body.dingModeWinThreshold }); }
  if (body.pollingInterval !== undefined) config.pollingInterval = body.pollingInterval;
  if (body.circuitBreakerEnabled !== undefined) state.circuitBreakerEnabled = body.circuitBreakerEnabled;
  if (body.circuitBreakerThreshold !== undefined) state.circuitBreakerThreshold = body.circuitBreakerThreshold;
  if (body.reverseModeEnabled !== undefined) { state.reverseModeEnabled = body.reverseModeEnabled; if (!body.reverseModeEnabled) state.reversePhase = false; }
  if (body.smartBreakerEnabled !== undefined) state.smartBreakerEnabled = body.smartBreakerEnabled;
  if (body.smartBreakerThreshold !== undefined) state.smartBreakerThreshold = body.smartBreakerThreshold;
  if (body.smartBreakerCooldown !== undefined) state.smartBreakerCooldown = body.smartBreakerCooldown;
  if (body.periodDetectionEnabled !== undefined) state.periodDetectionEnabled = body.periodDetectionEnabled;
  if (body.periodDetectionWindow !== undefined) state.periodDetectionWindow = body.periodDetectionWindow;
  if (body.periodDetectionThreshold !== undefined) state.periodDetectionThreshold = body.periodDetectionThreshold;
  if (body.periodDetectionBoost !== undefined) state.periodDetectionBoost = body.periodDetectionBoost;

  dingtalk.updateDingConfig(config);
  storage.saveConfig();
  storage.saveState();
  res.json({ success: true });
});

// 控制
app.post('/api/control', (req, res) => {
  const { action } = req.body;
  if (action === 'start') startPolling();
  else if (action === 'stop') stopPolling();
  else if (action === 'fetchOnce') {
    // 如果正在处理中，不重复触发，避免并发重复推送
    if (isProcessing) {
      log('⏸ fetchOnce 跳过：上一轮还在处理中');
    } else {
      processNewBlocks();
    }
  }
  else if (action === 'clearAll') {
    storage.clearAllData();
    predictionSnapshot = [];
    log('已清除所有数据');
  }
  res.json({ success: true, isPolling });
});

// 回测
app.post('/api/backtest', (req, res) => {
  const { count = 100, direction = 'latest' } = req.body;
  let sample = [...storage.getBalls()];
  if (direction === 'latest') sample = sample.slice(-count);
  else sample = sample.slice(0, count);

  if (sample.length < 2) return res.json({ error: '数据不足，至少需要 2 个球' });

  const btResult = engine.runBacktest(sample, {
    circuitBreakerEnabled: state.circuitBreakerEnabled,
    circuitBreakerThreshold: state.circuitBreakerThreshold,
    reverseModeEnabled: state.reverseModeEnabled,
    ruleEnabled: state.ruleEnabled,
    ruleReversed: state.ruleReversed,
    ruleStats: state.ruleStats
  });

  const total = btResult.results.length;
  const correct = btResult.results.filter(r => r.correct === true).length;
  const wrong = btResult.results.filter(r => r.correct === false).length;

  const ruleSummary = Object.entries(btResult.ruleStatsBT)
    .filter(([_, st]) => st.used > 0)
    .map(([id, st]) => ({
      id,
      name: st.name,
      used: st.used,
      wins: st.wins,
      losses: st.losses,
      winRate: st.used > 0 ? ((st.wins / st.used) * 100).toFixed(1) + '%' : '-'
    }))
    .sort((a, b) => parseFloat(b.winRate) - parseFloat(a.winRate));

  res.json({
    total,
    correct,
    wrong,
    accuracy: total > 0 ? ((correct / total) * 100).toFixed(2) + '%' : '-',
    ruleSummary
  });
});

// 日志
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(state.logs.slice(-limit));
});

// 钉钉测试
app.post('/api/dingtalk/test', async (req, res) => {
  const ok = await dingtalk.sendDingTalkMessage('🧪 这是一条来自波场单双系统的测试消息', log);
  res.json({ success: ok, message: ok ? '推送成功' : '推送失败' });
});

// ---------- 统计图表 API ----------

// 每日胜率统计
app.get('/api/stats/daily', (req, res) => {
  const balls = storage.getBalls();
  const dailyMap = {};
  
  for (const b of balls) {
    if (!b.timeStr) continue;
    const day = b.timeStr.split(' ')[0]; // "2026/6/22"
    if (!dailyMap[day]) dailyMap[day] = { wins: 0, losses: 0, total: 0 };
    if (b.resultMark === 'W') { dailyMap[day].wins++; dailyMap[day].total++; }
    else if (b.resultMark === 'L') { dailyMap[day].losses++; dailyMap[day].total++; }
  }
  
  const result = Object.entries(dailyMap)
    .map(([date, stats]) => ({
      date,
      wins: stats.wins,
      losses: stats.losses,
      total: stats.total,
      winRate: stats.total > 0 ? parseFloat((stats.wins / stats.total * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  
  res.json(result);
});

// 滚动胜率 (最近N球)
app.get('/api/stats/rolling', (req, res) => {
  const balls = storage.getBalls();
  const windowSizes = [10, 25, 50, 100];
  const result = {};
  
  for (const w of windowSizes) {
    const slice = balls.slice(-w);
    let wins = 0, total = 0;
    for (const b of slice) {
      if (b.resultMark === 'W') { wins++; total++; }
      else if (b.resultMark === 'L') { total++; }
    }
    result['w' + w] = {
      window: w,
      wins,
      total,
      winRate: total > 0 ? parseFloat((wins / total * 100).toFixed(1)) : 0
    };
  }
  
  // 最近50球的逐球胜率（每10球一组）
  const recent50 = balls.slice(-50);
  const points = [];
  for (let i = 10; i <= recent50.length; i += 5) {
    const slice = recent50.slice(i - 10, i);
    let w = 0, t = 0;
    for (const b of slice) {
      if (b.resultMark === 'W') { w++; t++; }
      else if (b.resultMark === 'L') { t++; }
    }
    points.push({
      index: i,
      winRate: t > 0 ? parseFloat((w / t * 100).toFixed(1)) : 0
    });
  }
  
  res.json({ summary: result, trend: points });
});

// 规则排名统计
app.get('/api/stats/rule-ranking', (req, res) => {
  const rules = engine.RULES.map(r => {
    const st = state.ruleStats[r.id] || { used: 0, wins: 0, losses: 0 };
    const rate = st.used > 0 ? parseFloat((st.wins / st.used * 100).toFixed(1)) : 0;
    return {
      id: r.id,
      name: r.name,
      used: st.used,
      wins: st.wins,
      losses: st.losses,
      winRate: rate,
      enabled: state.ruleEnabled[r.id] !== false
    };
  })
  .filter(r => r.used >= 5)
  .sort((a, b) => b.winRate - a.winRate);
  
  res.json({
    top10: rules.slice(0, 10),
    bottom10: rules.slice(-10).reverse(),
    all: rules
  });
});

// ---------- 前端页面 ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- 启动 ----------
const PORT = 3456;

// 同步钉钉配置
dingtalk.updateDingConfig({
  webhook: config.dingWebhook || '',
  modeHighWinRate: config.dingModeHighWinRate !== false,
  modeHighWinThreshold: config.dingModeHighWinThreshold || 62,
  modeFail: config.dingModeFail || false,
  modeFailThreshold: config.dingModeFailThreshold || 3,
  modeWin: config.dingModeWin || false,
  modeWinThreshold: config.dingModeWinThreshold || 3
});

app.listen(PORT, '0.0.0.0', () => {
  log(`✅ 波场单双预测服务已启动: http://0.0.0.0:${PORT}`);
  log(`📊 当前数据: ${state.balls.length} 个球, ${state.totalWins}胜/${state.totalLosses}负`);
  // 自动开始轮询
  startPolling();
	  // 预测推送由 handleBlock 处理新区块时自动触发，无需单独安排
});
