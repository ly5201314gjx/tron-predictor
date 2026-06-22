// ============================================================
// fetcher.js — 波场区块链抓取器（含限流）
// ============================================================
const TRONGRID_API = 'https://api.trongrid.io';

// 简单限流：最多每秒1个请求
let lastRequestTime = 0;
const MIN_INTERVAL = 1100; // 毫秒

async function rateLimitedFetch(url, options) {
	  const now = Date.now();
	  const wait = Math.max(0, MIN_INTERVAL - (now - lastRequestTime));
	  if (wait > 0) {
	    await new Promise(r => setTimeout(r, wait));
	  }
	  lastRequestTime = Date.now();
	  
	  // 最多重试3次
	  for (let attempt = 1; attempt <= 3; attempt++) {
	    const controller = new AbortController();
	    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15秒超时
	    try {
	      const resp = await fetch(url, { ...options, signal: controller.signal });
	      clearTimeout(timeoutId);
	      if (resp.status === 429) {
	        // 被限流了，等更久再重试
	        const retryAfter = parseInt(resp.headers.get('retry-after') || '3');
	        await new Promise(r => setTimeout(r, retryAfter * 1000));
	        continue;
	      }
	      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
	      return await resp.json();
	    } catch (err) {
	      clearTimeout(timeoutId);
	      if (attempt < 3) {
	        await new Promise(r => setTimeout(r, 2000 * attempt));
	      } else {
	        throw err;
	      }
	    }
	  }
	}

// 需要监控的区块高度尾数
function isInterestingHeight(height) {
  const mod = height % 100;
  return mod === 0 || mod === 20 || mod === 40 || mod === 60 || mod === 80;
}

// 查找下一个符合条件的区块高度
function getNextInterestingHeight(fromHeight, maxSteps = 300) {
  for (let i = 1; i <= maxSteps; i++) {
    const h = fromHeight + i;
    if (isInterestingHeight(h)) return h;
  }
  return null;
}

// 获取最新区块号
async function fetchLatestBlockNumber() {
  const data = await rateLimitedFetch(`${TRONGRID_API}/wallet/getnowblock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  return data.block_header.raw_data.number;
}

// 获取指定高度的区块
async function fetchBlockByNumber(height) {
  return await rateLimitedFetch(`${TRONGRID_API}/wallet/getblockbynum`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ num: height })
  });
}

module.exports = {
  isInterestingHeight,
  getNextInterestingHeight,
  fetchLatestBlockNumber,
  fetchBlockByNumber
};
