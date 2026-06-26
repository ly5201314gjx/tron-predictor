#!/usr/bin/env node
// ============================================================
// test-parity.js — 验证单双计算逻辑与官方一致
// ============================================================
// 连接 WebSocket，收集 20 个区块，验证 parity 计算
// ============================================================

const WebSocket = require('ws');
const engine = require('./engine');

const WS_URL = 'wss://www.v2hs9.com/ws/';
const BLOCKS_TO_COLLECT = 20;

console.log('🔗 连接 WebSocket:', WS_URL);
console.log('📊 收集', BLOCKS_TO_COLLECT, '个区块验证单双计算...\n');

const ws = new WebSocket(WS_URL);
const blocks = [];
let blockCount = 0;

ws.on('open', () => {
  console.log('✅ WebSocket 连接成功\n');
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (!msg.message) return;
    const m = msg.message;
    
    if (m.type === 'lottery_v2_broadcast') {
      const blockNum = parseInt(m.block_num) || 0;
      if (blocks.some(b => b.height === blockNum)) return; // 去重
      
      const hash = m.block_hash;
      const lastChar = hash.slice(-1);
      
      // 我们的计算逻辑
      const parityResult = engine.deriveParityFromHash(hash);
      const parity = parityResult.parity;
      
      // 简单的 parseInt 计算（旧逻辑，可能不准确）
      const val = parseInt(lastChar, 16);
      const simpleParity = val % 2 === 1 ? 'single' : 'double';
      
      // 判断是否需要字母后退
      const needsBackward = lastChar >= 'a' && lastChar <= 'f';
      
      blocks.push({
        height: blockNum,
        hash: hash,
        lastChar: lastChar,
        val: val,
        parity: parity,
        simpleParity: simpleParity,
        method: parityResult.method,
        numericValue: parityResult.numericValue,
        needsBackward: needsBackward,
        agree: parity === simpleParity
      });
      
      blockCount++;
      console.log(`#${blockCount}/${BLOCKS_TO_COLLECT} 高度: ${blockNum}`);
      console.log(`  哈希最后位: ${lastChar} (值: ${val})`);
      console.log(`  方法: ${parityResult.method}, 数值: ${parityResult.numericValue}`);
      console.log(`  我们的结果: ${parity === 'single' ? '单' : '双'}`);
      console.log(`  简单计算: ${simpleParity === 'single' ? '单' : '双'}`);
      console.log(`  需要字母后退: ${needsBackward ? '是' : '否'}`);
      console.log(`  一致: ${parity === simpleParity ? '✅' : '❌'}`);
      console.log('');
      
      if (blockCount >= BLOCKS_TO_COLLECT) {
        console.log('📊 验证结果汇总:');
        console.log('='.repeat(50));
        
        const agreeCount = blocks.filter(b => b.agree).length;
        const disagreeCount = blocks.filter(b => !b.agree).length;
        const backwardCount = blocks.filter(b => b.needsBackward).length;
        
        console.log(`总区块数: ${blocks.length}`);
        console.log(`一致数: ${agreeCount}`);
        console.log(`不一致数: ${disagreeCount}`);
        console.log(`需要字母后退: ${backwardCount}`);
        console.log(`一致率: ${(agreeCount / blocks.length * 100).toFixed(1)}%`);
        
        if (disagreeCount > 0) {
          console.log('\n❌ 不一致的区块:');
          blocks.filter(b => !b.agree).forEach(b => {
            console.log(`  高度 ${b.height}: 最后位 ${b.lastChar}, 我们: ${b.parity === 'single' ? '单' : '双'}, 简单: ${b.simpleParity === 'single' ? '单' : '双'}`);
          });
        }
        
        console.log('\n✅ 验证完成');
        ws.close();
        process.exit(0);
      }
    }
  } catch (e) {
    // ignore
  }
});

ws.on('error', (err) => {
  console.error('❌ WebSocket 错误:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  if (blockCount < BLOCKS_TO_COLLECT) {
    console.log('⚠️ WebSocket 连接断开，已收集', blockCount, '个区块');
  }
});

// 超时处理
setTimeout(() => {
  console.log('⏰ 超时，已收集', blockCount, '个区块');
  ws.close();
  process.exit(1);
}, 60000); // 60秒超时