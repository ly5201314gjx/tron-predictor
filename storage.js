// ============================================================
// storage.js — JSON 文件持久化
// ============================================================
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ---------- 状态 ----------
const MAX_BALLS = 2000;
const state = {
  balls: [],
  lastKnownBlockHeight: null,
  totalWins: 0,
  totalLosses: 0,
  currentWinStreak: 0,
  currentLoseStreak: 0,
  bestWinStreak: 0,
  bestLoseStreak: 0,
  highestPushedHeight: 0,
  circuitBreakerEnabled: false,
  circuitBreakerThreshold: 2,
  circuitBreakerArmed: false,
  reverseModeEnabled: false,
  reversePhase: false,
  ruleEnabled: {},
  ruleReversed: {},
  ruleHighTag: {},
  ruleLowTag: {},
  ruleStats: {},
  // 智能熔断（回测最优：连败2次冷却1块）
  smartBreakerEnabled: false,
  smartBreakerThreshold: 2,
  smartBreakerCooldown: 1,
  smartBreakerCoolingUntil: 0,
  smartBreakerCooldownCount: 0,
  // 周期检测（回测最优：窗口50/阈值0.08/加权0.25）
  periodDetectionEnabled: false,
  periodDetectionWindow: 50,
  periodDetectionThreshold: 0.08,
  periodDetectionBoost: 0.25,
  periodDetectionBias: 0,
  // 连胜连败推送：达到N次才推钉钉，否则静默处理
  streakPushEnabled: false,
  streakPushThreshold: 3,
  // 输赢交替推送：交替N次后推钉钉，然后持续推送直到交替结束
  altPushEnabled: false,
  altPushThreshold: 3,
  altPushCount: 0,
  altLastResult: null,
  altForcePush: false,
  altModeActive: false, // 交替模式是否激活（持续推送中）
  altRound: 0,          // 当前交替轮次
  logs: []
};

function loadState() {
  ensureDataDir();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const data = JSON.parse(raw);
      Object.assign(state, data);
      // 确保关键数组存在
      if (!Array.isArray(state.balls)) state.balls = [];
      if (!Array.isArray(state.logs)) state.logs = [];
      return true;
    }
  } catch (err) {
    console.error('加载状态失败:', err.message);
  }
  return false;
}

function saveState() {
  ensureDataDir();
  try {
    // 限制球数
    while (state.balls.length > MAX_BALLS) {
      state.balls.shift();
    }
    // 限制日志数
    while (state.logs.length > 500) {
      state.logs.shift();
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('保存状态失败:', err.message);
    return false;
  }
}

// ---------- 配置 ----------
let config = {
  dingWebhook: '',
  dingModeHighWinRate: true,
  dingModeHighWinThreshold: 62,
  dingModeFail: false,
  dingModeFailThreshold: 3,
  dingModeWin: false,
  dingModeWinThreshold: 3,
  pollingInterval: 8000
};

function loadConfig() {
  ensureDataDir();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      Object.assign(config, JSON.parse(raw));
    }
  } catch (err) {
    console.error('加载配置失败:', err.message);
  }
}

function saveConfig() {
  ensureDataDir();
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('保存配置失败:', err.message);
    return false;
  }
}

function updateConfig(partial) {
  Object.assign(config, partial);
  saveConfig();
}

// ---------- 日志 ----------
function log(message, level = 'info') {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const entry = { time: Date.now(), timeStr: ts, level, message };
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();
  console.log(`[${ts}] [${level}] ${message}`);
  return entry;
}

// ---------- 状态修改辅助 ----------
function addBall(ball) {
  // 二次去重：确保同一高度不会重复添加
  if (state.balls.some(b => b.height === ball.height)) {
    console.log(`[去重] 高度 ${ball.height} 已存在，跳过添加`);
    return false;
  }
  state.balls.push(ball);
  while (state.balls.length > MAX_BALLS) {
    state.balls.shift();
  }
  return true;
}

function getBalls() {
  return state.balls;
}

function clearAllData() {
  state.balls = [];
  state.totalWins = 0;
  state.totalLosses = 0;
  state.currentWinStreak = 0;
  state.currentLoseStreak = 0;
  state.bestWinStreak = 0;
  state.bestLoseStreak = 0;
  state.lastKnownBlockHeight = null;
  saveState();
}

// 初始化
loadState();
loadConfig();

// 启动时清理重复球
function deduplicateBalls() {
  const seen = new Set();
  const unique = [];
  let dupCount = 0;
  for (const b of state.balls) {
    const key = b.height;
    if (seen.has(key)) {
      dupCount++;
    } else {
      seen.add(key);
      unique.push(b);
    }
  }
  if (dupCount > 0) {
    console.log(`[清理] 发现 ${dupCount} 个重复球，已清理`);
    state.balls = unique;
    saveState();
  }
}
deduplicateBalls();

module.exports = {
  state,
  config,
  loadState,
  saveState,
  loadConfig,
  saveConfig,
  updateConfig,
  log,
  addBall,
  getBalls,
  clearAllData
};
