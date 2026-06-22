// ============================================================
// dingtalk.js — 钉钉推送（高胜率模式 + 规则展示 + 关键词"监控"）
// ============================================================

let dingConfig = {
  webhook: '',
  modeHighWinRate: true,        // 高胜率推送（取代旧的 modeAll）
  modeHighWinThreshold: 62,     // 规则平均胜率 ≥ 62% 才推送
  modeFail: false,
  modeFailThreshold: 3,
  modeWin: false,
  modeWinThreshold: 3
};

// 运行时状态
const dingRuntime = {
  failModeArmed: false,
  failPushActive: false,
  winModeArmed: false,
  winPushActive: false
};

function hasValidDingWebhook() {
  const url = (dingConfig.webhook || '').trim();
  return url.startsWith('https://oapi.dingtalk.com/') || url.startsWith('https://api.dingtalk.com/');
}

async function sendDingTalkMessage(content, logFn) {
  const url = (dingConfig.webhook || '').trim();
  if (!url) {
    if (logFn) logFn('钉钉推送未执行：未填写 Webhook 地址', 'warn');
    return false;
  }
  if (!hasValidDingWebhook()) {
    if (logFn) logFn('钉钉推送未执行：Webhook 格式不正确', 'warn');
    return false;
  }
  try {
    // 确保消息包含关键词"监控"
    const finalContent = content.indexOf('监控') === -1 ? '【监控】' + content : content;
    const payload = { msgtype: 'text', text: { content: finalContent } };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (resp.ok) {
      const result = await resp.json();
      if (result.errcode === 0) {
        if (logFn) logFn('钉钉推送成功');
        return true;
      } else {
        if (logFn) logFn('钉钉推送返回错误: ' + JSON.stringify(result), 'error');
        return false;
      }
    } else {
      if (logFn) logFn('钉钉推送 HTTP 失败: ' + resp.status, 'error');
      return false;
    }
  } catch (err) {
    if (logFn) logFn('钉钉推送网络错误: ' + err.message, 'error');
    return false;
  }
}

// 计算推送触发条件
function computeDingTriggers() {
  if (!hasValidDingWebhook()) return { send: false, triggers: [] };
  const triggers = [];
  let send = false;

  // 高胜率推送（取代全量推送）
  if (dingConfig.modeHighWinRate) {
    // 这个触发条件在 buildPredictionMessage 中根据实际规则胜率判断
    // 这里先标记为可能触发，实际由外部判断胜率后调用
  }

  if (dingConfig.modeFail) {
    if (dingRuntime.failModeArmed) {
      dingRuntime.failModeArmed = false;
      dingRuntime.failPushActive = true;
      send = true;
      triggers.push('连败推送');
    } else if (dingRuntime.failPushActive) {
      send = true;
      triggers.push('连败推送');
    }
  }

  if (dingConfig.modeWin) {
    if (dingRuntime.winModeArmed) {
      dingRuntime.winModeArmed = false;
      dingRuntime.winPushActive = true;
      send = true;
      triggers.push('连胜推送');
    } else if (dingRuntime.winPushActive) {
      send = true;
      triggers.push('连胜推送');
    }
  }

  return { send, triggers };
}

// 更新推送运行时状态
function updateDingRuntime(currentLoseStreak, currentWinStreak, resultMark) {
  if (dingConfig.modeFail && resultMark === 'L') {
    if (dingRuntime.failPushActive) dingRuntime.failPushActive = false;
    if (currentLoseStreak === dingConfig.modeFailThreshold) dingRuntime.failModeArmed = true;
  }
  if (dingConfig.modeWin && resultMark === 'W') {
    if (currentWinStreak === dingConfig.modeWinThreshold) dingRuntime.winModeArmed = true;
  } else if (resultMark === 'L') {
    if (dingRuntime.winPushActive) dingRuntime.winPushActive = false;
  }
}

// 构建预测消息（含规则胜率）
function buildPredictionMessage(ball, prediction, confidence, triggers, ruleStats) {
  const dirLabel = prediction === 'single' ? '单' : '双';
  const confText = (confidence * 100).toFixed(1) + '%';
  const parts = [];
  
  parts.push(`📊 波场单双监控`);
  parts.push(`━━━━━━━━━━━━━━`);
  parts.push(`📍 高度 #${ball.height}`);
  parts.push(`🎯 预测：${dirLabel}  |  置信：${confText}`);
  
  // 添加使用的规则及胜率（按胜率排序，只显示前8条）
  if (ruleStats && ruleStats.length > 0) {
    const sorted = [...ruleStats].filter(r => r.ruleId && !r.ruleId.startsWith('DRAGON')).sort((a, b) => (b.ruleRate || 0) - (a.ruleRate || 0));
    const topRules = sorted.slice(0, 8);
    if (topRules.length > 0) {
      parts.push(`━━━ 参与规则 ━━━`);
      topRules.forEach(r => {
        const rateStr = r.ruleRate ? r.ruleRate.toFixed(1) + '%' : 'N/A';
        parts.push(`  ${r.ruleId} ${rateStr}`);
      });
      if (sorted.length > 8) parts.push(`  ...等 ${sorted.length} 条规则`);
    }
  }
  
  if (triggers && triggers.length) parts.push(`━━━ ${triggers.join(' ')} ━━━`);
  
  return parts.join('\n');
}

// 构建结果消息
function buildResultMessage(ball, currentWinStreak, currentLoseStreak) {
  const actualLabel = ball.parity === 'single' ? '单' : '双';
  const predLabel = ball.prediction === 'single' ? '单' : ball.prediction === 'double' ? '双' : '-';
  const resText = ball.resultMark === 'W' ? '✅ 正确' : ball.resultMark === 'L' ? '❌ 错误' : '—';
  const parts = [];
  
  parts.push(`📊 波场单双监控`);
  parts.push(`━━━━━━━━━━━━━━`);
  parts.push(`📍 高度 #${ball.height}`);
  parts.push(`📌 实际：${actualLabel}  |  预测：${predLabel}`);
  parts.push(`🏷 结果：${resText}`);
  parts.push(`📈 连胜 ${currentWinStreak}  ·  连败 ${currentLoseStreak}`);
  
  return parts.join('\n');
}

// 更新配置
function updateDingConfig(config) {
  if (config.webhook !== undefined) dingConfig.webhook = config.webhook;
  else if (config.dingWebhook !== undefined) dingConfig.webhook = config.dingWebhook;
  if (config.modeHighWinRate !== undefined) dingConfig.modeHighWinRate = config.modeHighWinRate;
  if (config.modeHighWinThreshold !== undefined) dingConfig.modeHighWinThreshold = config.modeHighWinThreshold;
  if (config.modeFail !== undefined) dingConfig.modeFail = config.modeFail;
  if (config.modeFailThreshold !== undefined) dingConfig.modeFailThreshold = config.modeFailThreshold;
  if (config.modeWin !== undefined) dingConfig.modeWin = config.modeWin;
  if (config.modeWinThreshold !== undefined) dingConfig.modeWinThreshold = config.modeWinThreshold;
}

function getDingConfig() {
  return { ...dingConfig };
}

module.exports = {
  sendDingTalkMessage,
  computeDingTriggers,
  updateDingRuntime,
  buildPredictionMessage,
  buildResultMessage,
  updateDingConfig,
  getDingConfig,
  hasValidDingWebhook
};
