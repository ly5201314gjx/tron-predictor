// ============================================================
// engine.js — 波场单双预测引擎 (50条规则 + 龙策略 + 熔断 + 逆向 + 自适应)
// ============================================================

// ---------- 辅助函数 ----------
function isOddNumeric(val) { return val % 2 === 1; }

function hexCharToValue(ch) {
  if (!ch) return null;
  if (ch >= '0' && ch <= '9') return parseInt(ch, 10);
  const lower = ch.toLowerCase();
  if (lower >= 'a' && lower <= 'f') return 10 + (lower.charCodeAt(0) - 97);
  return null;
}

function findLastDigitFromHash(hash) {
  if (!hash) return null;
  for (let i = hash.length - 1; i >= 0; i--) {
    const ch = hash[i];
    if (ch >= '0' && ch <= '9') return { digit: parseInt(ch, 10), index: i };
  }
  return null;
}

function deriveParityFromHash(hash) {
  if (!hash || typeof hash !== 'string') {
    return { parity: null, lastChar: null, numericValue: null, method: 'invalid-hash' };
  }
  const lastChar = hash[hash.length - 1];
  const val = hexCharToValue(lastChar);
  if (val !== null && lastChar >= '0' && lastChar <= '9') {
    return {
      parity: isOddNumeric(val) ? 'single' : 'double',
      lastChar, numericValue: val, method: 'last-digit'
    };
  }
  const found = findLastDigitFromHash(hash);
  if (found) {
    return {
      parity: isOddNumeric(found.digit) ? 'single' : 'double',
      lastChar, numericValue: found.digit, method: 'backward-digit'
    };
  }
  return { parity: null, lastChar, numericValue: null, method: 'no-digit-found' };
}

function parityToLabel(p) {
  if (p === 'single') return '单';
  if (p === 'double') return '双';
  return '-';
}

function reverseParity(p) {
  if (p === 'single') return 'double';
  if (p === 'double') return 'single';
  return null;
}

// ---------- 长龙检测 ----------
function getDragonInfo(history) {
  if (!history || history.length === 0) return { length: 0, parity: null };
  let last = history[history.length - 1].parity;
  if (!last) return { length: 0, parity: null };
  let len = 1;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].parity === last) len++;
    else break;
  }
  return { length: len, parity: last };
}

// ---------- 哈希分析辅助 ----------
function analyzeHash(hash) {
  if (!hash || typeof hash !== 'string') return null;
  const result = {
    length: hash.length,
    sum: 0,
    digitCount: 0,
    letterCount: 0,
    evenDigits: 0,
    oddDigits: 0,
    firstChar: null,
    lastChar: null,
    firstVal: null,
    lastVal: null,
    consecutiveRepeats: 0
  };
  
  let maxConsecutive = 1, currentConsecutive = 1;
  for (let i = 0; i < hash.length; i++) {
    const ch = hash[i];
    const val = hexCharToValue(ch);
    if (val === null) continue;
    
    if (ch >= '0' && ch <= '9') {
      result.digitCount++;
      if (isOddNumeric(val)) result.oddDigits++;
      else result.evenDigits++;
    } else {
      result.letterCount++;
    }
    result.sum += val;
    
    if (i === 0) { result.firstChar = ch; result.firstVal = val; }
    if (i === hash.length - 1) { result.lastChar = ch; result.lastVal = val; }
    
    // 连续重复字符
    if (i > 0 && hash[i] === hash[i-1]) {
      currentConsecutive++;
      if (currentConsecutive > maxConsecutive) maxConsecutive = currentConsecutive;
    } else {
      currentConsecutive = 1;
    }
  }
  result.consecutiveRepeats = maxConsecutive;
  return result;
}

// ---------- 马尔可夫链 ----------
function buildMarkovChain(history, order) {
  // 构建 order 阶马尔可夫链
  const chain = {};
  if (history.length < order + 1) return chain;
  
  for (let i = order; i < history.length; i++) {
    const state = [];
    for (let j = order; j >= 1; j--) {
      state.push(history[i - j].parity);
    }
    const stateKey = state.join(',');
    const next = history[i].parity;
    
    if (!chain[stateKey]) {
      chain[stateKey] = { single: 0, double: 0, total: 0 };
    }
    chain[stateKey][next]++;
    chain[stateKey].total++;
  }
  
  // 添加拉普拉斯平滑
  for (const key of Object.keys(chain)) {
    chain[key].single += 1;
    chain[key].double += 1;
    chain[key].total += 2;
    chain[key].probSingle = chain[key].single / chain[key].total;
    chain[key].probDouble = chain[key].double / chain[key].total;
  }
  
  return chain;
}

// ---------- 近期胜率跟踪 ----------
const recentPerformance = {
  windowSize: 30,
  ruleResults: {}, // { ruleId: [true, false, true, ...] }
  
  recordResult(ruleId, isCorrect) {
    if (!this.ruleResults[ruleId]) this.ruleResults[ruleId] = [];
    this.ruleResults[ruleId].push(isCorrect);
    if (this.ruleResults[ruleId].length > this.windowSize) {
      this.ruleResults[ruleId].shift();
    }
  },
  
  getRecentWinRate(ruleId) {
    const results = this.ruleResults[ruleId];
    if (!results || results.length < 5) return null;
    const wins = results.filter(r => r).length;
    return wins / results.length;
  },
  
  getRecentAccuracy() {
    // 所有规则的综合近期准确率
    let total = 0, correct = 0;
    for (const ruleId of Object.keys(this.ruleResults)) {
      for (const r of this.ruleResults[ruleId]) {
        total++;
        if (r) correct++;
      }
    }
    return total > 0 ? correct / total : null;
  }
};

// ---------- 50条规则 ----------
const RULES = [
  // ===== 基础跟随/反向规则 (R1-R9) =====
  {
    id: 'R1', baseWeight: 1.0,
    name: '规则1：最近1球跟随',
    fn: (history) => {
      if (history.length < 1) return null;
      return { prediction: history[history.length - 1].parity, confidence: 0.60 };
    }
  },
  {
    id: 'R2', baseWeight: 0.9,
    name: '规则2：最近1球反向',
    fn: (history) => {
      if (history.length < 1) return null;
      const last = history[history.length - 1].parity;
      if (!last) return null;
      return { prediction: last === 'single' ? 'double' : 'single', confidence: 0.55 };
    }
  },
  {
    id: 'R3', baseWeight: 1.0,
    name: '规则3：最近3球多数跟随',
    fn: (history) => {
      if (history.length < 3) return null;
      const slice = history.slice(-3);
      let s = 0, d = 0;
      slice.forEach(b => { if (b.parity === 'single') s++; else if (b.parity === 'double') d++; });
      if (s === d) return null;
      const pred = s > d ? 'single' : 'double';
      return { prediction: pred, confidence: Math.min(0.55 + Math.abs(s - d) * 0.05, 0.75) };
    }
  },
  {
    id: 'R4', baseWeight: 1.0,
    name: '规则4：最近5球多数跟随',
    fn: (history) => {
      if (history.length < 5) return null;
      const slice = history.slice(-5);
      let s = 0, d = 0;
      slice.forEach(b => { if (b.parity === 'single') s++; else if (b.parity === 'double') d++; });
      if (s === d) return null;
      const pred = s > d ? 'single' : 'double';
      return { prediction: pred, confidence: Math.min(0.55 + Math.abs(s - d) * 0.04, 0.78) };
    }
  },
  {
    id: 'R5', baseWeight: 1.0,
    name: '规则5：最近10球多数跟随',
    fn: (history) => {
      if (history.length < 10) return null;
      const slice = history.slice(-10);
      let s = 0, d = 0;
      slice.forEach(b => { if (b.parity === 'single') s++; else if (b.parity === 'double') d++; });
      if (s === d) return null;
      const pred = s > d ? 'single' : 'double';
      const ratio = Math.max(s, d) / 10;
      return { prediction: pred, confidence: Math.min(Math.max(0.55 + (ratio - 0.5) * 0.8, 0.55), 0.9) };
    }
  },
  {
    id: 'R6', baseWeight: 0.9,
    name: '规则6：最近5球反向多数',
    fn: (history) => {
      if (history.length < 5) return null;
      const slice = history.slice(-5);
      let s = 0, d = 0;
      slice.forEach(b => { if (b.parity === 'single') s++; else if (b.parity === 'double') d++; });
      if (s === d) return null;
      const majority = s > d ? 'single' : 'double';
      return { prediction: majority === 'single' ? 'double' : 'single', confidence: Math.min(0.52 + Math.abs(s - d) * 0.03, 0.7) };
    }
  },
  {
    id: 'R7', baseWeight: 1.1,
    name: '规则7：短龙追',
    fn: (history) => {
      if (history.length < 2) return null;
      const dragon = getDragonInfo(history);
      if (!dragon.parity) return null;
      if (dragon.length >= 2 && dragon.length <= 3) {
        return { prediction: dragon.parity, confidence: 0.65 + (dragon.length - 2) * 0.1 };
      }
      return null;
    }
  },
  {
    id: 'R8', baseWeight: 1.2,
    name: '规则8：大长龙砍',
    fn: (history) => {
      if (history.length < 7) return null;
      const dragon = getDragonInfo(history);
      if (!dragon.parity || dragon.length < 7) return null;
      const pred = dragon.parity === 'single' ? 'double' : 'single';
      return { prediction: pred, confidence: Math.min(0.7 + Math.min((dragon.length - 7) * 0.05, 0.2), 0.9) };
    }
  },
  {
    id: 'R9', baseWeight: 0.9,
    name: '规则9：振荡识别',
    fn: (history) => {
      if (history.length < 4) return null;
      const last4 = history.slice(-4).map(b => b.parity);
      if (last4.some(p => !p)) return null;
      const alt1 = last4[0] !== last4[1] && last4[1] !== last4[2] && last4[2] !== last4[3];
      const alt2 = last4[0] !== last4[2] && last4[1] !== last4[3];
      if (alt1 && alt2) {
        return { prediction: last4[3] === 'single' ? 'double' : 'single', confidence: 0.65 };
      }
      return null;
    }
  },

  // ===== 动能/动量规则 (R10-R17) =====
  {
    id: 'R10', baseWeight: 1.0,
    name: '规则10：单/双动能（最近8球）',
    fn: (history) => {
      if (history.length < 8) return null;
      const slice = history.slice(-8);
      let s = 0, d = 0;
      slice.forEach(b => { if (b.parity === 'single') s++; else if (b.parity === 'double') d++; });
      const total = s + d;
      if (total < 5) return null;
      const ratioSingle = s / total;
      if (ratioSingle > 0.6) return { prediction: 'single', confidence: 0.6 + (ratioSingle - 0.6) * 0.5 };
      if (ratioSingle < 0.4) return { prediction: 'double', confidence: 0.6 + (1 - ratioSingle - 0.6) * 0.5 };
      return null;
    }
  },
  {
    id: 'R11', baseWeight: 1.0,
    name: '规则11：单/双动能（指数加权）',
    fn: (history) => {
      if (history.length < 6) return null;
      const slice = history.slice(-12);
      let wSingle = 0, wDouble = 0;
      for (let i = 0; i < slice.length; i++) {
        const b = slice[slice.length - 1 - i];
        const w = Math.pow(2, i);
        if (b.parity === 'single') wSingle += w;
        else if (b.parity === 'double') wDouble += w;
      }
      const total = wSingle + wDouble;
      if (total === 0) return null;
      const ratioSingle = wSingle / total;
      if (ratioSingle > 0.55) return { prediction: 'single', confidence: 0.6 + (ratioSingle - 0.55) * 0.7 };
      if (ratioSingle < 0.45) return { prediction: 'double', confidence: 0.6 + (0.55 - ratioSingle) * 0.7 };
      return null;
    }
  },
  {
    id: 'R12', baseWeight: 0.9,
    name: '规则12：数值均值偏移',
    fn: (history) => {
      const slice = history.slice(-20).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 5) return null;
      const avg = slice.reduce((sum, b) => sum + b.numericValue, 0) / slice.length;
      if (avg > 7.5) return { prediction: 'single', confidence: 0.55 + (avg - 7.5) * 0.05 };
      if (avg < 7.5) return { prediction: 'double', confidence: 0.55 + (7.5 - avg) * 0.05 };
      return null;
    }
  },
  {
    id: 'R13', baseWeight: 0.8,
    name: '规则13：数值标准差收缩',
    fn: (history) => {
      const slice = history.slice(-15).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 8) return null;
      const values = slice.map(b => b.numericValue);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
      const std = Math.sqrt(variance);
      if (std < 3) {
        const lastParity = slice[slice.length - 1].parity;
        if (!lastParity) return null;
        return { prediction: lastParity, confidence: 0.6 + (3 - std) * 0.05 };
      }
      return null;
    }
  },
  {
    id: 'R14', baseWeight: 1.0,
    name: '规则14：线性回归斜率',
    fn: (history) => {
      const slice = history.slice(-12).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 6) return null;
      const n = slice.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
      for (let i = 0; i < n; i++) {
        const x = i + 1;
        const y = slice[i].numericValue;
        sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
      }
      const denom = n * sumXX - sumX * sumX;
      if (denom === 0) return null;
      const slope = (n * sumXY - sumX * sumY) / denom;
      if (slope > 0.1) return { prediction: 'single', confidence: 0.6 + Math.min(slope * 0.05, 0.2) };
      if (slope < -0.1) return { prediction: 'double', confidence: 0.6 + Math.min(-slope * 0.05, 0.2) };
      return null;
    }
  },
  {
    id: 'R15', baseWeight: 0.9,
    name: '规则15：布林带偏离',
    fn: (history) => {
      const slice = history.slice(-20).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 10) return null;
      const values = slice.map(b => b.numericValue);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
      const std = Math.sqrt(variance);
      const last = values[values.length - 1];
      const upper = mean + 2 * std;
      const lower = mean - 2 * std;
      if (last > upper) return { prediction: 'double', confidence: 0.6 + Math.min((last - upper) * 0.05, 0.2) };
      if (last < lower) return { prediction: 'single', confidence: 0.6 + Math.min((lower - last) * 0.05, 0.2) };
      return null;
    }
  },
  {
    id: 'R16', baseWeight: 0.9,
    name: '规则16：RSI 动能指标',
    fn: (history) => {
      const slice = history.slice(-14).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 8) return null;
      let gains = 0, losses = 0, count = 0;
      for (let i = 1; i < slice.length; i++) {
        const diff = slice[i].numericValue - slice[i - 1].numericValue;
        if (diff > 0) gains += diff;
        else if (diff < 0) losses -= diff;
        count++;
      }
      if (count === 0) return null;
      const avgGain = gains / count, avgLoss = losses / count;
      if (avgLoss === 0 && avgGain === 0) return null;
      if (avgLoss === 0) return { prediction: 'single', confidence: 0.7 };
      const rs = avgGain / avgLoss;
      const rsi = 100 - 100 / (1 + rs);
      if (rsi > 70) return { prediction: 'double', confidence: 0.6 + (rsi - 70) * 0.005 };
      if (rsi < 30) return { prediction: 'single', confidence: 0.6 + (30 - rsi) * 0.005 };
      return null;
    }
  },
  {
    id: 'R17', baseWeight: 0.9,
    name: '规则17：MACD 差值方向',
    fn: (history) => {
      const values = history.filter(b => typeof b.numericValue === 'number').map(b => b.numericValue);
      if (values.length < 15) return null;
      const ema = (period) => {
        const k = 2 / (period + 1);
        let emaVal = values[0];
        for (let i = 1; i < values.length; i++) emaVal = values[i] * k + emaVal * (1 - k);
        return emaVal;
      };
      const diff = ema(5) - ema(13);
      if (diff > 0.2) return { prediction: 'single', confidence: 0.6 + Math.min(diff * 0.1, 0.2) };
      if (diff < -0.2) return { prediction: 'double', confidence: 0.6 + Math.min(-diff * 0.1, 0.2) };
      return null;
    }
  },

  // ===== 统计回归规则 (R18-R27) =====
  {
    id: 'R18', baseWeight: 0.9,
    name: '规则18：奇偶比率回归',
    fn: (history) => {
      if (history.length < 30) return null;
      const slice = history.slice(-60);
      let s = 0, d = 0;
      slice.forEach(b => { if (b.parity === 'single') s++; else if (b.parity === 'double') d++; });
      const total = s + d;
      if (total < 30) return null;
      const ratioSingle = s / total;
      if (ratioSingle > 0.65) return { prediction: 'double', confidence: 0.6 + (ratioSingle - 0.65) * 0.6 };
      if (ratioSingle < 0.35) return { prediction: 'single', confidence: 0.6 + (0.35 - ratioSingle) * 0.6 };
      return null;
    }
  },
  {
    id: 'R19', baseWeight: 0.8,
    name: '规则19：周期性模式（长度3）',
    fn: (history) => {
      if (history.length < 6) return null;
      const last6 = history.slice(-6).map(b => b.parity);
      if (last6.some(p => !p)) return null;
      if (last6.slice(0, 3).join(',') === last6.slice(3, 6).join(',')) {
        return { prediction: last6[0], confidence: 0.65 };
      }
      return null;
    }
  },
  {
    id: 'R20', baseWeight: 0.8,
    name: '规则20：周期性模式（长度4）',
    fn: (history) => {
      if (history.length < 8) return null;
      const last8 = history.slice(-8).map(b => b.parity);
      if (last8.some(p => !p)) return null;
      if (last8.slice(0, 4).join(',') === last8.slice(4, 8).join(',')) {
        return { prediction: last8[0], confidence: 0.65 };
      }
      return null;
    }
  },
  {
    id: 'R21', baseWeight: 1.0,
    name: '规则21：哈希尾字母回退序',
    fn: (history) => {
      if (history.length < 1) return null;
      const last = history[history.length - 1];
      if (!last.blockHash) return null;
      const hash = last.blockHash;
      const lastChar = hash[hash.length - 1];
      if (lastChar >= '0' && lastChar <= '9') return null;
      const found = findLastDigitFromHash(hash);
      if (!found) return null;
      return { prediction: isOddNumeric(found.digit) ? 'single' : 'double', confidence: 0.6 };
    }
  },
  {
    id: 'R22', baseWeight: 0.7,
    name: '规则22：高位偏好',
    fn: (history) => {
      if (history.length < 3) return null;
      const last = history[history.length - 1];
      if (typeof last.numericValue !== 'number') return null;
      if (last.numericValue >= 8) return { prediction: 'single', confidence: 0.58 + (last.numericValue - 8) * 0.03 };
      if (last.numericValue <= 7) return { prediction: 'double', confidence: 0.58 + (7 - last.numericValue) * 0.03 };
      return null;
    }
  },
  {
    id: 'R23', baseWeight: 0.7,
    name: '规则23：低位偏好反转',
    fn: (history) => {
      const slice = history.slice(-6).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 4) return null;
      const lowCount = slice.filter(b => b.numericValue <= 5).length;
      const highCount = slice.filter(b => b.numericValue >= 10).length;
      if (lowCount >= 4) return { prediction: 'single', confidence: 0.62 + (lowCount - 4) * 0.05 };
      if (highCount >= 4) return { prediction: 'double', confidence: 0.62 + (highCount - 4) * 0.05 };
      return null;
    }
  },
  {
    id: 'R24', baseWeight: 1.1,
    name: '规则24：组合线性模型',
    fn: (history) => {
      if (history.length < 8) return null;
      const last5 = history.slice(-5);
      let s = 0, d = 0;
      last5.forEach(b => { if (b.parity === 'single') s++; else if (b.parity === 'double') d++; });
      const votes = { single: 0, double: 0 };
      if (s !== d) votes[s > d ? 'single' : 'double'] += 0.8;
      const slice = history.slice(-10).filter(b => typeof b.numericValue === 'number');
      if (slice.length >= 6) {
        const n = slice.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        for (let i = 0; i < n; i++) {
          const x = i + 1, y = slice[i].numericValue;
          sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
        }
        const denom = n * sumXX - sumX * sumX;
        if (denom !== 0) {
          const slope = (n * sumXY - sumX * sumY) / denom;
          if (slope > 0.1) votes.single += 0.7;
          else if (slope < -0.1) votes.double += 0.7;
        }
      }
      const last8 = history.slice(-8);
      let s8 = 0, d8 = 0;
      last8.forEach(b => { if (b.parity === 'single') s8++; else if (b.parity === 'double') d8++; });
      const total8 = s8 + d8;
      if (total8 > 0) {
        const ratioSingle = s8 / total8;
        if (ratioSingle > 0.55) votes.single += (ratioSingle - 0.5);
        else if (ratioSingle < 0.45) votes.double += (0.5 - ratioSingle);
      }
      if (votes.single === 0 && votes.double === 0) return null;
      const pred = votes.single >= votes.double ? 'single' : 'double';
      const diff = Math.abs(votes.single - votes.double);
      return { prediction: pred, confidence: Math.min(0.6 + diff * 0.2, 0.9) };
    }
  },
  {
    id: 'R25', baseWeight: 1.0,
    name: '规则25：哈希数值总和奇偶',
    fn: (history) => {
      if (history.length < 1) return null;
      const last = history[history.length - 1];
      if (!last.blockHash) return null;
      const analysis = analyzeHash(last.blockHash);
      if (!analysis) return null;
      const isSumOdd = analysis.sum % 2 === 1;
      return { prediction: isSumOdd ? 'single' : 'double', confidence: 0.58 };
    }
  },
  {
    id: 'R26', baseWeight: 1.0,
    name: '规则26：短期均线突破',
    fn: (history) => {
      const vals = history.filter(b => typeof b.numericValue === 'number');
      if (vals.length < 7) return null;
      const v = vals.map(b => b.numericValue);
      const ma = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const ma3 = ma(v.slice(-3)), ma7 = ma(v.slice(-7));
      if (ma3 > ma7 + 0.5) return { prediction: 'single', confidence: 0.62 + Math.min((ma3 - ma7) * 0.05, 0.18) };
      if (ma3 < ma7 - 0.5) return { prediction: 'double', confidence: 0.62 + Math.min((ma7 - ma3) * 0.05, 0.18) };
      return null;
    }
  },
  {
    id: 'R27', baseWeight: 0.9,
    name: '规则27：数值中枢偏离',
    fn: (history) => {
      const slice = history.slice(-5).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 5) return null;
      let above = 0, below = 0;
      slice.forEach(b => { if (b.numericValue > 7.5) above++; else if (b.numericValue < 7.5) below++; });
      if (above >= 4) return { prediction: 'single', confidence: 0.6 + (above - 3) * 0.05 };
      if (below >= 4) return { prediction: 'double', confidence: 0.6 + (below - 3) * 0.05 };
      return null;
    }
  },

  // ===== 高级模式规则 (R28-R40) =====
  {
    id: 'R28', baseWeight: 0.9,
    name: '规则28：最近4球涨跌动能',
    fn: (history) => {
      const slice = history.slice(-5).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 5) return null;
      let up = 0, down = 0;
      for (let i = 1; i < slice.length; i++) {
        const diff = slice[i].numericValue - slice[i - 1].numericValue;
        if (diff > 0) up++; else if (diff < 0) down++;
      }
      if (up >= 3 && up > down) return { prediction: 'single', confidence: 0.6 + (up - 2) * 0.05 };
      if (down >= 3 && down > up) return { prediction: 'double', confidence: 0.6 + (down - 2) * 0.05 };
      return null;
    }
  },
  {
    id: 'R29', baseWeight: 0.8,
    name: '规则29：极值反转',
    fn: (history) => {
      const slice = history.slice(-10).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 6) return null;
      const highExtreme = slice.filter(b => b.numericValue >= 14).length;
      const lowExtreme = slice.filter(b => b.numericValue <= 1).length;
      if (highExtreme >= 3) return { prediction: 'double', confidence: 0.62 + (highExtreme - 2) * 0.05 };
      if (lowExtreme >= 3) return { prediction: 'single', confidence: 0.62 + (lowExtreme - 2) * 0.05 };
      return null;
    }
  },
  {
    id: 'R30', baseWeight: 0.8,
    name: '规则30：长序列反转',
    fn: (history) => {
      if (history.length < 6) return null;
      const last6 = history.slice(-6);
      let maxRun = 1, run = 1;
      for (let i = 1; i < last6.length; i++) {
        if (last6[i].parity && last6[i].parity === last6[i - 1].parity) { run++; if (run > maxRun) maxRun = run; }
        else run = 1;
      }
      const lastParity = last6[last6.length - 1].parity;
      if (!lastParity) return null;
      if (maxRun >= 4) return { prediction: lastParity === 'single' ? 'double' : 'single', confidence: 0.65 + (maxRun - 4) * 0.05 };
      return null;
    }
  },
  {
    id: 'R31', baseWeight: 0.8,
    name: '规则31：短周期 RSI',
    fn: (history) => {
      const slice = history.slice(-7).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 7) return null;
      let gains = 0, losses = 0;
      for (let i = 1; i < slice.length; i++) {
        const diff = slice[i].numericValue - slice[i - 1].numericValue;
        if (diff > 0) gains += diff; else if (diff < 0) losses -= diff;
      }
      if (gains === 0 && losses === 0) return null;
      if (losses === 0) return { prediction: 'single', confidence: 0.68 };
      const rs = gains / losses;
      const rsi = 100 - 100 / (1 + rs);
      if (rsi > 75) return { prediction: 'double', confidence: 0.63 + (rsi - 75) * 0.006 };
      if (rsi < 25) return { prediction: 'single', confidence: 0.63 + (25 - rsi) * 0.006 };
      return null;
    }
  },
  {
    id: 'R32', baseWeight: 0.8,
    name: '规则32：中值回归',
    fn: (history) => {
      const slice = history.slice(-9).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 9) return null;
      const arr = slice.map(b => b.numericValue).sort((a, b) => a - b);
      const mid = arr[Math.floor(arr.length / 2)];
      if (mid > 9) return { prediction: 'double', confidence: 0.6 + (mid - 9) * 0.04 };
      if (mid < 6) return { prediction: 'single', confidence: 0.6 + (6 - mid) * 0.04 };
      return null;
    }
  },
  {
    id: 'R33', baseWeight: 0.9,
    name: '规则33：单双动量差',
    fn: (history) => {
      if (history.length < 12) return null;
      const slice = history.slice(-12);
      let s = 0, d = 0;
      slice.forEach(b => { if (b.parity === 'single') s++; else if (b.parity === 'double') d++; });
      const diff = Math.abs(s - d);
      if (diff <= 2) return null;
      return { prediction: s > d ? 'single' : 'double', confidence: 0.6 + (diff - 2) * 0.04 };
    }
  },
  {
    id: 'R34', baseWeight: 0.7,
    name: '规则34：交替失败修正',
    fn: (history) => {
      if (history.length < 6) return null;
      const last6 = history.slice(-6);
      const p = last6.map(b => b.parity);
      if (p.some(x => !x)) return null;
      let altViolations = 0;
      for (let i = 1; i < p.length; i++) { if (p[i] === p[i - 1]) altViolations++; }
      if (altViolations >= 2) return { prediction: p[p.length - 1], confidence: 0.6 + (altViolations - 1) * 0.05 };
      return null;
    }
  },
  {
    id: 'R35', baseWeight: 0.8,
    name: '规则35：差值动能加速度',
    fn: (history) => {
      const slice = history.slice(-6).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 6) return null;
      let up = 0, down = 0;
      for (let i = 1; i < slice.length; i++) {
        const diff = slice[i].numericValue - slice[i - 1].numericValue;
        if (diff > 0) up++; else if (diff < 0) down++;
      }
      if (up >= 4 && up > down) return { prediction: 'single', confidence: 0.64 + (up - 3) * 0.04 };
      if (down >= 4 && down > up) return { prediction: 'double', confidence: 0.64 + (down - 3) * 0.04 };
      return null;
    }
  },
  {
    id: 'R36', baseWeight: 0.8,
    name: '规则36：区间分布偏态',
    fn: (history) => {
      const slice = history.slice(-20).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 15) return null;
      const high = slice.filter(b => b.numericValue >= 11).length;
      const low = slice.filter(b => b.numericValue <= 4).length;
      const total = slice.length;
      if (high / total > 0.6) return { prediction: 'single', confidence: 0.62 + (high / total - 0.6) * 0.3 };
      if (low / total > 0.6) return { prediction: 'double', confidence: 0.62 + (low / total - 0.6) * 0.3 };
      return null;
    }
  },
  {
    id: 'R37', baseWeight: 0.7,
    name: '规则37：单双切换惯性',
    fn: (history) => {
      if (history.length < 7) return null;
      const slice = history.slice(-7);
      const p = slice.map(b => b.parity);
      if (p.some(x => !x)) return null;
      let switches = 0;
      for (let i = 1; i < p.length; i++) { if (p[i] !== p[i - 1]) switches++; }
      if (switches <= 2) return { prediction: p[p.length - 1], confidence: 0.6 + (2 - switches) * 0.06 };
      return null;
    }
  },
  {
    id: 'R38', baseWeight: 0.7,
    name: '规则38：长龙长度奇偶效应',
    fn: (history) => {
      const dragon = getDragonInfo(history);
      if (!dragon.parity || dragon.length < 2) return null;
      if (dragon.length % 2 === 1) return { prediction: dragon.parity, confidence: 0.6 + Math.min((dragon.length - 1) * 0.03, 0.12) };
      return { prediction: dragon.parity === 'single' ? 'double' : 'single', confidence: 0.6 + Math.min((dragon.length - 2) * 0.03, 0.12) };
    }
  },
  {
    id: 'R39', baseWeight: 0.8,
    name: '规则39：尾两位组合奇偶',
    fn: (history) => {
      if (history.length < 1) return null;
      const last = history[history.length - 1];
      if (!last.blockHash) return null;
      const h = last.blockHash;
      const digits = [];
      for (let i = h.length - 1; i >= 0 && digits.length < 2; i--) {
        const ch = h[i];
        if (ch >= '0' && ch <= '9') digits.push(parseInt(ch, 10));
      }
      if (digits.length < 2) return null;
      const sum = digits[0] + digits[1];
      return { prediction: sum % 2 === 1 ? 'single' : 'double', confidence: 0.6 + Math.min(Math.abs(sum - 9) * 0.02, 0.16) };
    }
  },
  {
    id: 'R40', baseWeight: 1.1,
    name: '规则40：综合动能平衡',
    fn: (history) => {
      const slice = history.slice(-16).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 10) return null;
      const values = slice.map(b => b.numericValue);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
      const std = Math.sqrt(variance);
      let s = 0, d = 0;
      slice.forEach(b => { if (b.parity === 'single') s++; else if (b.parity === 'double') d++; });
      const total = s + d;
      if (total === 0) return null;
      const ratioSingle = s / total;
      let score = 0;
      score += (mean - 7.5) * 0.15;
      score += (ratioSingle - 0.5) * 1.2;
      score -= (std - 4) * 0.05;
      if (score > 0.1) return { prediction: 'single', confidence: 0.62 + Math.min(score * 0.2, 0.2) };
      if (score < -0.1) return { prediction: 'double', confidence: 0.62 + Math.min(-score * 0.2, 0.2) };
      return null;
    }
  },

  // ===== 新增强力规则 (R41-R50) =====
  {
    id: 'R41', baseWeight: 1.0,
    name: '规则41：马尔可夫2阶链',
    fn: (history) => {
      if (history.length < 4) return null;
      const chain = buildMarkovChain(history, 2);
      if (Object.keys(chain).length < 3) return null;
      const last2 = history.slice(-2).map(b => b.parity);
      if (last2.some(p => !p)) return null;
      const stateKey = last2.join(',');
      const probs = chain[stateKey];
      if (!probs || probs.total < 3) return null;
      const confidence = Math.min(Math.abs(probs.probSingle - 0.5) * 2.5 + 0.55, 0.88);
      return {
        prediction: probs.probSingle > probs.probDouble ? 'single' : 'double',
        confidence
      };
    }
  },
  {
    id: 'R42', baseWeight: 1.0,
    name: '规则42：马尔可夫3阶链',
    fn: (history) => {
      if (history.length < 5) return null;
      const chain = buildMarkovChain(history, 3);
      if (Object.keys(chain).length < 3) return null;
      const last3 = history.slice(-3).map(b => b.parity);
      if (last3.some(p => !p)) return null;
      const stateKey = last3.join(',');
      const probs = chain[stateKey];
      if (!probs || probs.total < 3) return null;
      const confidence = Math.min(Math.abs(probs.probSingle - 0.5) * 2.8 + 0.55, 0.9);
      return {
        prediction: probs.probSingle > probs.probDouble ? 'single' : 'double',
        confidence
      };
    }
  },
  {
    id: 'R43', baseWeight: 0.9,
    name: '规则43：哈希首尾字节关联',
    fn: (history) => {
      if (history.length < 1) return null;
      const last = history[history.length - 1];
      if (!last.blockHash) return null;
      const analysis = analyzeHash(last.blockHash);
      if (!analysis) return null;
      if (analysis.firstVal === null || analysis.lastVal === null) return null;
      const sum = analysis.firstVal + analysis.lastVal;
      const diff = Math.abs(analysis.firstVal - analysis.lastVal);
      // 首尾和奇偶 + 差值置信
      const pred = sum % 2 === 1 ? 'single' : 'double';
      const conf = 0.55 + Math.min(diff * 0.015, 0.15);
      return { prediction: pred, confidence: conf };
    }
  },
  {
    id: 'R44', baseWeight: 0.9,
    name: '规则44：趋势动量综合评分',
    fn: (history) => {
      if (history.length < 15) return null;
      const windows = [5, 10, 15];
      let score = 0;
      for (const w of windows) {
        const slice = history.slice(-w);
        let s = 0, d = 0;
        slice.forEach(b => { if (b.parity === 'single') s++; else if (b.parity === 'double') d++; });
        const ratio = s / (s + d || 1);
        score += (ratio - 0.5) * (w / 5);
      }
      // 再加指数加权
      const expSlice = history.slice(-20);
      let wSingle = 0, wDouble = 0;
      for (let i = 0; i < expSlice.length; i++) {
        const b = expSlice[expSlice.length - 1 - i];
        const w = Math.pow(1.5, i);
        if (b.parity === 'single') wSingle += w;
        else if (b.parity === 'double') wDouble += w;
      }
      const expRatio = wSingle / (wSingle + wDouble || 1);
      score += (expRatio - 0.5) * 3;
      
      const absScore = Math.abs(score);
      if (absScore < 0.8) return null;
      return { prediction: score > 0 ? 'single' : 'double', confidence: Math.min(0.6 + absScore * 0.04, 0.88) };
    }
  },
  {
    id: 'R45', baseWeight: 0.8,
    name: '规则45：连胜连败修正',
    fn: (history) => {
      if (history.length < 4) return null;
      const dragon = getDragonInfo(history);
      if (!dragon.parity || dragon.length < 3) return null;
      // 长龙越长，跟/砍的置信度周期变化
      if (dragon.length >= 3 && dragon.length <= 4) {
        return { prediction: dragon.parity, confidence: 0.65 };
      }
      if (dragon.length >= 5 && dragon.length <= 6) {
        // 中段龙 - 谨慎追
        return { prediction: dragon.parity, confidence: 0.58 };
      }
      if (dragon.length === 7) {
        // 7龙是一个常见转折点
        const pred = dragon.parity === 'single' ? 'double' : 'single';
        return { prediction: pred, confidence: 0.7 };
      }
      if (dragon.length >= 8) {
        // 超级长龙继续砍
        const pred = dragon.parity === 'single' ? 'double' : 'single';
        return { prediction: pred, confidence: Math.min(0.7 + (dragon.length - 8) * 0.03, 0.88) };
      }
      return null;
    }
  },
  {
    id: 'R46', baseWeight: 0.9,
    name: '规则46：哈希字母数字比',
    fn: (history) => {
      if (history.length < 1) return null;
      const last = history[history.length - 1];
      if (!last.blockHash) return null;
      const analysis = analyzeHash(last.blockHash);
      if (!analysis || analysis.digitCount === 0) return null;
      const total = analysis.letterCount + analysis.digitCount;
      if (total === 0) return null;
      const digitRatio = analysis.digitCount / total;
      const oddRatio = analysis.oddDigits / analysis.digitCount;
      // 数字占比高 + 奇数多 -> 倾向单
      const score = (digitRatio - 0.5) * 1.5 + (oddRatio - 0.5) * 1.0;
      const absScore = Math.abs(score);
      if (absScore < 0.3) return null;
      return { prediction: score > 0 ? 'single' : 'double', confidence: Math.min(0.58 + absScore * 0.08, 0.78) };
    }
  },
  {
    id: 'R47', baseWeight: 0.8,
    name: '规则47：方差波动率检测',
    fn: (history) => {
      const slice = history.slice(-20).filter(b => typeof b.numericValue === 'number');
      if (slice.length < 12) return null;
      const values = slice.map(b => b.numericValue);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
      const std = Math.sqrt(variance);
      // 波动率高 -> 趋势强；波动率低 -> 震荡
      const last3 = values.slice(-3);
      const lastMean = last3.reduce((a, b) => a + b, 0) / last3.length;
      const zScore = (lastMean - mean) / (std || 1);
      const absZ = Math.abs(zScore);
      if (absZ < 0.3) return null;
      return { prediction: zScore > 0 ? 'single' : 'double', confidence: Math.min(0.58 + absZ * 0.06, 0.8) };
    }
  },
  {
    id: 'R48', baseWeight: 1.0,
    name: '规则48：哈希连续重复模式',
    fn: (history) => {
      if (history.length < 1) return null;
      const last = history[history.length - 1];
      if (!last.blockHash) return null;
      const analysis = analyzeHash(last.blockHash);
      if (!analysis) return null;
      // 哈希中重复字符多 -> 可能是某种模式
      if (analysis.consecutiveRepeats >= 3) {
        // 连续重复多 -> 预测基于重复位置
        const pred = analysis.consecutiveRepeats % 2 === 1 ? 'single' : 'double';
        return { prediction: pred, confidence: Math.min(0.58 + (analysis.consecutiveRepeats - 3) * 0.03, 0.72) };
      }
      // 哈希中字母数 vs 数字数
      if (analysis.letterCount > analysis.digitCount * 1.5) {
        return { prediction: 'single', confidence: 0.6 };
      }
      if (analysis.digitCount > analysis.letterCount * 1.5) {
        return { prediction: 'double', confidence: 0.6 };
      }
      return null;
    }
  },
  {
    id: 'R49', baseWeight: 1.1,
    name: '规则49：自适应集成投票',
    fn: (history, options = {}) => {
      if (history.length < 5) return null;
      const recentPerf = options.recentPerformance || { single: 0, double: 0 };
      // 5个不同时间窗口投票
      const windows = [3, 5, 8, 13, 21];
      const votes = { single: 0, double: 0 };
      let totalWeight = 0;
      for (const w of windows) {
        if (history.length < w) continue;
        const slice = history.slice(-w);
        let s = 0, d = 0;
        slice.forEach(b => { if (b.parity === 'single') s++; else if (b.parity === 'double') d++; });
        if (s === d) continue;
        const weight = Math.sqrt(w);
        totalWeight += weight;
        if (s > d) votes.single += weight;
        else votes.double += weight;
      }
      if (totalWeight === 0) return null;
      const singleRatio = votes.single / (votes.single + votes.double);
      const bias = Math.abs(singleRatio - 0.5);
      if (bias < 0.05) return null;
      const pred = votes.single >= votes.double ? 'single' : 'double';
      const confidence = Math.min(0.6 + bias * 1.5, 0.85);
      return { prediction: pred, confidence };
    }
  },
  {
    id: 'R50', baseWeight: 1.2,
    name: '规则50：趋势一致性强化',
    fn: (history) => {
      if (history.length < 10) return null;
      // 检查多个指标是否指向同一方向
      const macdSlice = history.filter(b => typeof b.numericValue === 'number').map(b => b.numericValue);
      let macdDirection = 0;
      if (macdSlice.length >= 15) {
        const ema = (period) => {
          const k = 2 / (period + 1);
          let emaVal = macdSlice[0];
          for (let i = 1; i < macdSlice.length; i++) emaVal = macdSlice[i] * k + emaVal * (1 - k);
          return emaVal;
        };
        const diff = ema(5) - ema(13);
        macdDirection = diff > 0.2 ? 1 : (diff < -0.2 ? -1 : 0);
      }
      
      // 近期单双比
      const recent = history.slice(-10);
      let s = 0, d = 0;
      recent.forEach(b => { if (b.parity === 'single') s++; else if (b.parity === 'double') d++; });
      const parityDirection = s > d + 2 ? 1 : (d > s + 2 ? -1 : 0);
      
      // 龙方向
      const dragon = getDragonInfo(history);
      const dragonDirection = dragon.parity === 'single' ? 1 : -1;
      
      // 均值方向
      const vals = history.slice(-8).filter(b => typeof b.numericValue === 'number').map(b => b.numericValue);
      let meanDirection = 0;
      if (vals.length >= 6) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        meanDirection = avg > 7.8 ? 1 : (avg < 7.2 ? -1 : 0);
      }
      
      // 统计一致性
      const signals = [macdDirection, parityDirection, dragonDirection, meanDirection].filter(s => s !== 0);
      if (signals.length < 2) return null;
      const allSame = signals.every(s => s === signals[0]);
      if (!allSame) return null;
      const strength = Math.min(signals.length * 0.05, 0.2);
      return { prediction: signals[0] > 0 ? 'single' : 'double', confidence: 0.65 + strength };
    }
  },
  // ===== 新发现的高胜率规则 (R51-R54) =====
  {
    id: 'R51', baseWeight: 1.2,
    name: '规则51：跳转概率矩阵',
    fn: (history) => {
      if (history.length < 10) return null;
      const m = { ss:0, sd:0, ds:0, dd:0 };
      for (let i = 1; i < history.length; i++) {
        const from = history[i-1].parity, to = history[i].parity;
        if (from === 'single' && to === 'single') m.ss++;
        else if (from === 'single' && to === 'double') m.sd++;
        else if (from === 'double' && to === 'single') m.ds++;
        else if (from === 'double' && to === 'double') m.dd++;
      }
      const last = history[history.length - 1].parity;
      if (last === 'single') {
        const total = m.ss + m.sd;
        if (total < 5) return null;
        const prob = m.ss / total;
        if (Math.abs(prob - 0.5) < 0.08) return null;
        return { prediction: prob > 0.5 ? 'single' : 'double', confidence: 0.58 + Math.abs(prob-0.5)*0.3 };
      } else {
        const total = m.ds + m.dd;
        if (total < 5) return null;
        const prob = m.dd / total;
        if (Math.abs(prob - 0.5) < 0.08) return null;
        return { prediction: prob > 0.5 ? 'double' : 'single', confidence: 0.58 + Math.abs(prob-0.5)*0.3 };
      }
    }
  },
  {
    id: 'R52', baseWeight: 1.1,
    name: '规则52：硬币反转检验',
    fn: (history) => {
      if (history.length < 30) return null;
      const slice = history.slice(-30);
      let switches = 0;
      for (let i = 1; i < slice.length; i++) {
        if (slice[i].parity !== slice[i-1].parity) switches++;
      }
      const expected = (slice.length - 1) / 2;
      const diff = switches - expected;
      if (Math.abs(diff) < 3) return null;
      const last = slice[slice.length - 1].parity;
      if (diff < -3) return { prediction: last, confidence: 0.62 + Math.min(Math.abs(diff) * 0.015, 0.15) };
      if (diff > 3) return { prediction: last === 'single' ? 'double' : 'single', confidence: 0.62 + Math.min(diff * 0.015, 0.15) };
      return null;
    }
  },
  {
    id: 'R53', baseWeight: 1.0,
    name: '规则53：多周期和谐共振',
    fn: (history) => {
      if (history.length < 30) return null;
      const periods = [2, 3, 5, 7, 11];
      const votes = { single: 0, double: 0 };
      let activePeriods = 0;
      for (const p of periods) {
        const indices = [];
        for (let i = history.length - 1 - p; i < history.length; i++) {
          indices.push(history[i].parity);
        }
        if (indices.some(x => !x)) continue;
        const first = indices[0];
        const allSame = indices.every(x => x === first);
        if (allSame) { votes[first]++; activePeriods++; }
      }
      if (activePeriods < 2) return null;
      if (votes.single === 0 && votes.double === 0) return null;
      const pred = votes.single >= votes.double ? 'single' : 'double';
      const bias = Math.abs(votes.single - votes.double) / activePeriods;
      return { prediction: pred, confidence: 0.6 + bias * 0.15 };
    }
  },
  {
    id: 'R54', baseWeight: 1.0,
    name: '规则54：综合熵值预测',
    fn: (history) => {
      if (history.length < 10) return null;
      const slice = history.slice(-20);
      let s = 0, d = 0;
      slice.forEach(b => { if (b.parity === 'single') s++; else if (b.parity === 'double') d++; });
      const total = s + d;
      if (total < 10) return null;
      const pS = s / total, pD = d / total;
      const entropy = -(pS > 0 ? pS * Math.log2(pS) : 0) - (pD > 0 ? pD * Math.log2(pD) : 0);
      if (entropy > 0.95) return null;
      if (entropy < 0.8) {
        return { 
          prediction: s > d ? 'single' : 'double',
          confidence: Math.min(0.6 + (0.95 - entropy) * 0.6, 0.82) 
        };
      }
      return null;
    }
  },
  // ===== 第二批新发现高胜率规则 (R55-R61) =====
  {
    id: 'R55', baseWeight: 1.2,
    name: '规则55：条件概率熵减',
    fn: (history) => {
      if (history.length < 15) return null;
      let ss=0, sd=0, ds=0, dd=0;
      for (let i = 1; i < history.length; i++) {
        if (history[i-1].parity === 'single' && history[i].parity === 'single') ss++;
        else if (history[i-1].parity === 'single' && history[i].parity === 'double') sd++;
        else if (history[i-1].parity === 'double' && history[i].parity === 'single') ds++;
        else if (history[i-1].parity === 'double' && history[i].parity === 'double') dd++;
      }
      let ts = ss + ds, td = sd + dd, tt = ts + td;
      if (tt < 10) return null;
      const pS = ts / tt;
      const H = -(pS > 0 ? pS * Math.log2(pS) : 0) - ((1-pS) > 0 ? (1-pS) * Math.log2(1-pS) : 0);
      const last = history[history.length-1].parity;
      if (last === 'single') {
        const total = ss + sd;
        if (total < 5) return null;
        const pSS = ss / total;
        const condH = -(pSS > 0 ? pSS * Math.log2(pSS) : 0) - ((1-pSS) > 0 ? (1-pSS) * Math.log2(1-pSS) : 0);
        if (H - condH < 0.05) return null;
        return { prediction: pSS > 0.5 ? 'single' : 'double', confidence: 0.6 + (H - condH) * 0.8 };
      } else {
        const total = ds + dd;
        if (total < 5) return null;
        const pDD = dd / total;
        const condH = -(pDD > 0 ? pDD * Math.log2(pDD) : 0) - ((1-pDD) > 0 ? (1-pDD) * Math.log2(1-pDD) : 0);
        if (H - condH < 0.05) return null;
        return { prediction: pDD > 0.5 ? 'double' : 'single', confidence: 0.6 + (H - condH) * 0.8 };
      }
    }
  },
  {
    id: 'R56', baseWeight: 1.1,
    name: '规则56：马尔可夫切换模型',
    fn: (history) => {
      if (history.length < 20) return null;
      const slice = history.slice(-10);
      let switches = 0;
      for (let i = 1; i < slice.length; i++) {
        if (slice[i].parity !== slice[i-1].parity) switches++;
      }
      const switchRate = switches / 9;
      const last = slice[slice.length-1].parity;
      if (switchRate <= 0.3) {
        return { prediction: last, confidence: 0.62 + (0.3 - switchRate) * 0.2 };
      }
      if (switchRate >= 0.7) {
        return { prediction: last === 'single' ? 'double' : 'single', confidence: 0.62 + (switchRate - 0.7) * 0.2 };
      }
      return null;
    }
  },
  {
    id: 'R57', baseWeight: 1.1,
    name: '规则57：赫斯特指数',
    fn: (history) => {
      if (history.length < 30) return null;
      const vals = history.slice(-50).map(b => b.parity === 'single' ? 1 : (b.parity === 'double' ? 0 : null)).filter(v => v !== null);
      if (vals.length < 20) return null;
      const n = vals.length;
      const mean = vals.reduce((a,b) => a+b, 0) / n;
      const deviations = vals.map(v => v - mean);
      let cumSum = 0, maxVal = -Infinity, minVal = Infinity;
      for (const d of deviations) {
        cumSum += d;
        if (cumSum > maxVal) maxVal = cumSum;
        if (cumSum < minVal) minVal = cumSum;
      }
      const R = maxVal - minVal;
      const S = Math.sqrt(vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n);
      if (S === 0) return null;
      const RS = R / S;
      const H = Math.log(RS) / Math.log(n);
      if (Math.abs(H - 0.5) < 0.1) return null;
      const last = history[history.length-1].parity;
      if (H > 0.6) return { prediction: last, confidence: 0.6 + Math.min((H-0.5)*0.3, 0.15) };
      if (H < 0.4) return { prediction: last === 'single' ? 'double' : 'single', confidence: 0.6 + Math.min((0.5-H)*0.3, 0.15) };
      return null;
    }
  },
  {
    id: 'R58', baseWeight: 1.0,
    name: '规则58：蒙特卡洛概率模拟',
    fn: (history) => {
      if (history.length < 15) return null;
      let ss=0, sd=0, ds=0, dd=0;
      for (let i = 1; i < history.length; i++) {
        if (history[i-1].parity === 'single' && history[i].parity === 'single') ss++;
        else if (history[i-1].parity === 'single' && history[i].parity === 'double') sd++;
        else if (history[i-1].parity === 'double' && history[i].parity === 'single') ds++;
        else if (history[i-1].parity === 'double' && history[i].parity === 'double') dd++;
      }
      const last = history[history.length-1].parity;
      let pNextS, total;
      if (last === 'single') { pNextS = ss / ((ss + sd) || 1); total = ss + sd; }
      else { pNextS = ds / ((ds + dd) || 1); total = ds + dd; }
      if (total < 5) return null;
      let simS = 0;
      for (let m = 0; m < 1000; m++) {
        if (Math.random() < pNextS) simS++;
      }
      const prob = simS / 1000;
      if (Math.abs(prob - 0.5) < 0.06) return null;
      return {
        prediction: prob > 0.5 ? 'single' : 'double',
        confidence: 0.58 + Math.abs(prob - 0.5) * 0.3
      };
    }
  },
  {
    id: 'R59', baseWeight: 1.0,
    name: '规则59：最长公共子序列',
    fn: (history) => {
      if (history.length < 12) return null;
      const recent4 = history.slice(-4).map(b => b.parity);
      if (recent4.some(x => !x)) return null;
      const pattern = recent4.join(',');
      let nextS = 0, nextD = 0;
      for (let i = 0; i < history.length - 5; i++) {
        const p = history.slice(i, i + 4).map(b => b.parity).join(',');
        if (p === pattern) {
          const next = history[i + 4];
          if (next && next.parity === 'single') nextS++;
          else if (next && next.parity === 'double') nextD++;
        }
      }
      const total = nextS + nextD;
      if (total < 3) return null;
      const prob = nextS / total;
      if (Math.abs(prob - 0.5) < 0.15) return null;
      return {
        prediction: prob > 0.5 ? 'single' : 'double',
        confidence: 0.6 + Math.abs(prob - 0.5) * 0.25
      };
    }
  },
  {
    id: 'R60', baseWeight: 1.0,
    name: '规则60：游程分布卡方检验',
    fn: (history) => {
      if (history.length < 30) return null;
      let runs = 1, s = 0, d = 0;
      for (let i = 1; i < history.length; i++) {
        if (history[i].parity === 'single') s++;
        else if (history[i].parity === 'double') d++;
        if (history[i].parity !== history[i-1].parity) runs++;
      }
      const n = s + d;
      const expectedRuns = 2 * s * d / n + 1;
      const stdRuns = Math.sqrt(2 * s * d * (2 * s * d - n) / (n * n * (n - 1)));
      if (stdRuns === 0) return null;
      const z = (runs - expectedRuns) / stdRuns;
      if (Math.abs(z) < 1) return null;
      const last = history[history.length - 1].parity;
      if (z < -1) return { prediction: last, confidence: 0.6 + Math.min(Math.abs(z) * 0.03, 0.15) };
      return { prediction: last === 'single' ? 'double' : 'single', confidence: 0.6 + Math.min(z * 0.03, 0.15) };
    }
  },
  {
    id: 'R61', baseWeight: 1.1,
    name: '规则61：多指标一致性',
    fn: (history) => {
      if (history.length < 15) return null;
      const votes = { single: 0, double: 0 };
      const r5 = history.slice(-5);
      let s5=0; r5.forEach(b => { if(b.parity==='single') s5++; });
      if (s5 > 3) votes.single++; else if (s5 < 2) votes.double++;
      const r3 = history.slice(-3);
      let s3=0; r3.forEach(b => { if(b.parity==='single') s3++; });
      if (s3 > 2) votes.single++; else if (s3 < 1) votes.double++;
      const vals = history.filter(b => typeof b.numericValue === 'number').map(b => b.numericValue);
      if (vals.length >= 5) {
        const avg = vals.slice(-10).reduce((a,b) => a+b, 0) / Math.min(10, vals.slice(-10).length);
        if (avg > 7.8) votes.single++;
        else if (avg < 7.2) votes.double++;
      }
      const dragon = getDragonInfo(history);
      if (dragon.parity && dragon.length >= 3) {
        if (dragon.parity === 'single') votes.single++;
        else votes.double++;
      }
      if (vals.length >= 6) {
        let up = 0, down = 0;
        const lastVals = vals.slice(-6);
        for (let i = 1; i < lastVals.length; i++) {
          if (lastVals[i] > lastVals[i-1]) up++; else if (lastVals[i] < lastVals[i-1]) down++;
        }
        if (up > down + 2) votes.single++;
        else if (down > up + 2) votes.double++;
      }
      let sw = 0;
      for (let i = 1; i < 8 && i < history.length; i++) {
        if (history[history.length-i].parity !== history[history.length-i-1].parity) sw++;
      }
      if (sw <= 2) { if (history[history.length-1].parity === 'single') votes.single++; else votes.double++; }
      else if (sw >= 5) { if (history[history.length-1].parity === 'single') votes.double++; else votes.single++; }
      if (votes.single === 0 && votes.double === 0) return null;
      const bias = Math.abs(votes.single - votes.double);
      if (bias < 2) return null;
      return {
        prediction: votes.single > votes.double ? 'single' : 'double',
        confidence: 0.6 + bias * 0.04
      };
    }
  }
];

// ---------- 预测引擎主函数 ----------
// history: balls array (按时间正序)
// options: { ruleEnabled, ruleReversed, ruleStats, enableAdaptive }
// 返回: { finalPrediction, combinedConfidence, ruleOutputs }
function runPredictionEngine(history, options = {}) {
  const ruleEnabled = options.ruleEnabled || {};
  const ruleReversed = options.ruleReversed || {};
  const ruleStats = options.ruleStats || {};
  const enableAdaptive = options.enableAdaptive !== false;

  if (history.length < 1) {
    return { finalPrediction: null, combinedConfidence: 0, ruleOutputs: [] };
  }

  let scoreSingle = 0, scoreDouble = 0;
  let weightSingle = 0, weightDouble = 0;
  const ruleOutputs = [];
  const dragon = getDragonInfo(history);

  for (const rule of RULES) {
    if (ruleEnabled[rule.id] === false) continue;

    try {
      const result = rule.fn(history, { recentPerformance: recentPerformance.getRecentAccuracy() });
      if (!result) continue;

      let { prediction, confidence } = result;

      // 规则逆向
      if (ruleReversed[rule.id]) {
        prediction = reverseParity(prediction);
      }

      // 自适应权重
      let effectiveWeight = rule.baseWeight || 1.0;
      if (enableAdaptive && ruleStats[rule.id] && ruleStats[rule.id].used >= 10) {
        const winRate = ruleStats[rule.id].used > 0
          ? ruleStats[rule.id].wins / ruleStats[rule.id].used : 0.5;
        const adaptiveFactor = Math.min(Math.max(0.8 + (winRate - 0.5) * 1.2, 0.4), 1.3);
        effectiveWeight *= adaptiveFactor;
      }

      // 近期表现微调（最近30次）
      const recentRate = recentPerformance.getRecentWinRate(rule.id);
      if (recentRate !== null && ruleStats[rule.id] && ruleStats[rule.id].used >= 5) {
        const recentFactor = Math.min(Math.max(0.85 + (recentRate - 0.5) * 0.6, 0.5), 1.2);
        effectiveWeight *= recentFactor;
      }

      const weightedConf = confidence * effectiveWeight;
      
      if (prediction === 'single') {
        scoreSingle += weightedConf;
        weightSingle += effectiveWeight;
      } else if (prediction === 'double') {
        scoreDouble += weightedConf;
        weightDouble += effectiveWeight;
      }

      ruleOutputs.push({ 
        ruleId: rule.id, 
        ruleName: rule.name, 
        prediction, 
        confidence: Math.round(confidence * 1000) / 1000,
        weight: Math.round(effectiveWeight * 100) / 100
      });
    } catch (err) {
      // 规则出错跳过
    }
  }

  // ===== 龙策略（改进版：不再覆盖，而是加权增强） =====
  if (dragon.parity && dragon.length >= 2) {
    if (dragon.length >= 2 && dragon.length <= 3) {
      // 短龙追 - 给龙方向加分
      const boost = 0.25 + (dragon.length - 2) * 0.1;
      if (dragon.parity === 'single') scoreSingle += boost;
      else scoreDouble += boost;
      ruleOutputs.push({ 
        ruleId: 'DRAGON_SHORT', ruleName: '短龙追', 
        prediction: dragon.parity, confidence: 0.7, weight: boost 
      });
    } else if (dragon.length >= 7) {
      // 大长龙砍 - 给反方向加分
      const cutPred = dragon.parity === 'single' ? 'double' : 'single';
      const boost = 0.3 + Math.min((dragon.length - 7) * 0.05, 0.25);
      if (cutPred === 'single') scoreSingle += boost;
      else scoreDouble += boost;
      ruleOutputs.push({ 
        ruleId: 'DRAGON_BIG', ruleName: '大长龙砍', 
        prediction: cutPred, confidence: 0.75, weight: boost 
      });
    } else if (dragon.length >= 4 && dragon.length <= 6) {
      // 中龙 - 轻微倾向龙方向
      const boost = 0.1 + (dragon.length - 4) * 0.05;
      if (dragon.parity === 'single') scoreSingle += boost;
      else scoreDouble += boost;
      ruleOutputs.push({ 
        ruleId: 'DRAGON_MID', ruleName: '中龙跟', 
        prediction: dragon.parity, confidence: 0.5, weight: boost 
      });
    }
  }

  const totalScore = scoreSingle + scoreDouble;
  if (totalScore === 0) {
    return { finalPrediction: null, combinedConfidence: 0, ruleOutputs };
  }

  // ===== 新置信度算法：基于规则质量，不再看单双差距 =====
  const finalPrediction = scoreSingle >= scoreDouble ? 'single' : 'double';
  
  // 取出非龙规则
  const realOutputs = ruleOutputs.filter(r => !r.ruleId.startsWith('DRAGON'));
  const totalReal = realOutputs.length;
  
  if (totalReal === 0) {
    return { finalPrediction, combinedConfidence: 0.55, ruleOutputs };
  }
  
  // 1. 一致性比例：支持最终预测的规则占比
  const agreeingOutputs = realOutputs.filter(r => r.prediction === finalPrediction);
  const agreementRatio = agreeingOutputs.length / totalReal;
  
  // 2. 历史胜率：支持方规则的平均历史胜率
  let histTotal = 0, histCount = 0;
  for (const ro of agreeingOutputs) {
    const st = ruleStats[ro.ruleId];
    if (st && st.used >= 10) {
      histTotal += st.wins / st.used;
      histCount++;
    }
  }
  const avgHistoricalWinRate = histCount > 0 ? histTotal / histCount : 0.5;
  
  // 3. 近期表现：支持方规则近30次平均胜率
  let recentTotal = 0, recentCount = 0;
  for (const ro of agreeingOutputs) {
    const rate = recentPerformance.getRecentWinRate(ro.ruleId);
    if (rate !== null) {
      recentTotal += rate;
      recentCount++;
    }
  }
  const avgRecentWinRate = recentCount > 0 ? recentTotal / recentCount : avgHistoricalWinRate;
  
  // 综合评分：一致性25% + 历史胜率35% + 近期表现40%（近期权重最高）
  const rawScore = 0.25 * agreementRatio + 0.35 * avgHistoricalWinRate + 0.40 * avgRecentWinRate;
  
  // 映射到 [0.50, 0.92]
  const combinedConfidence = Math.min(0.92, Math.max(0.50, 0.52 + (rawScore - 0.5) * 1.2));

  return { finalPrediction, combinedConfidence, ruleOutputs };
}

// ---------- 回测 ----------
function runBacktest(sample, options = {}) {
  const results = [];
  const ruleStatsBT = {};
  let revPhase = false;
  let cbArmed = false;
  let curLoseBT = 0;
  const cbThreshold = options.circuitBreakerThreshold || 2;
  const cbEnabled = options.circuitBreakerEnabled || false;
  const revEnabled = options.reverseModeEnabled || false;

  // 初始化规则统计
  for (const rule of RULES) {
    ruleStatsBT[rule.id] = { name: rule.name, used: 0, wins: 0, losses: 0 };
  }

  for (let i = 0; i < sample.length; i++) {
    const ball = sample[i];
    const history = sample.slice(0, i);
    let result = { height: ball.height, actual: ball.parity, prediction: null, confidence: 0, correct: null };

    if (history.length > 0) {
      if (cbEnabled && cbArmed) {
        cbArmed = false;
        result.prediction = null;
        result.note = '熔断跳过';
      } else {
        const engineResult = runPredictionEngine(history, options);
        let pred = engineResult.finalPrediction;
        let conf = engineResult.combinedConfidence;

        if (revEnabled && revPhase && pred) {
          pred = reverseParity(pred);
        }
        if (revEnabled && pred && ball.parity && pred !== ball.parity) {
          revPhase = !revPhase;
        }

        result.prediction = pred;
        result.confidence = conf;
        result.rules = engineResult.ruleOutputs;

        if (pred && ball.parity) {
          result.correct = pred === ball.parity;
          for (const ro of engineResult.ruleOutputs) {
            if (ro.ruleId && !ro.ruleId.startsWith('DRAGON')) {
              if (!ruleStatsBT[ro.ruleId]) {
                ruleStatsBT[ro.ruleId] = { name: ro.ruleName || ro.ruleId, used: 0, wins: 0, losses: 0 };
              }
              ruleStatsBT[ro.ruleId].used++;
              if (result.correct) ruleStatsBT[ro.ruleId].wins++;
              else ruleStatsBT[ro.ruleId].losses++;
            }
          }
          if (result.correct) {
            curLoseBT = 0;
          } else {
            curLoseBT++;
            if (cbEnabled && curLoseBT >= cbThreshold) cbArmed = true;
          }
        }
      }
    }
    results.push(result);
  }

  return { results, ruleStatsBT };
}

// ========== 周期检测：单双分布偏移补偿 ==========
// 参数：window=检测窗口, threshold=偏移阈值(0.08=8%), boost=加权力度(0.25)
function applyPeriodDetection(balls, engineResult, options = {}) {
  const { window = 50, threshold = 0.08, boost = 0.25 } = options;
  
  if (!engineResult || !engineResult.finalPrediction || balls.length < window + 5) {
    return { pred: engineResult?.finalPrediction, conf: engineResult?.combinedConfidence, periodBias: 0, flipped: false };
  }
  
  const recent = balls.slice(-window);
  const singles = recent.filter(b => b.parity === 'single').length;
  const doubles = recent.filter(b => b.parity === 'double').length;
  const total = singles + doubles;
  if (total === 0) return { pred: engineResult.finalPrediction, conf: engineResult.combinedConfidence, periodBias: 0, flipped: false };
  
  const singleRatio = singles / total;
  const bias = singleRatio - 0.5; // 正=偏单，负=偏双
  
  let pred = engineResult.finalPrediction;
  let conf = engineResult.combinedConfidence;
  let flipped = false;
  
  if (Math.abs(bias) > threshold) {
    // 计算引擎的"方向分数"
    const engineScore = pred === 'single' ? 0.5 + conf * 0.5 : 0.5 - conf * 0.5;
    // 加上周期偏移
    let boostedScore = engineScore + boost * (bias / 0.5);
    
    const newPred = boostedScore >= 0.5 ? 'single' : 'double';
    if (newPred !== pred) {
      flipped = true;
      pred = newPred;
      // 翻转后置信度：取引擎置信和偏移强度的加权平均
      conf = Math.max(conf, 0.5 + Math.abs(bias) * 0.3);
    }
  }
  
  return { pred, conf, periodBias: bias, flipped };
}

module.exports = {
  RULES,
  runPredictionEngine,
  runBacktest,
  deriveParityFromHash,
  getDragonInfo,
  parityToLabel,
  reverseParity,
  recentPerformance,
  applyPeriodDetection
};
