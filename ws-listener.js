// ============================================================
// ws-listener.js — v2hs9 WebSocket 实时监听（主数据源）
// ============================================================
// 监听 wss://www.v2hs9.com/ws/ 获取实时区块数据
// 零延迟：区块产生后立即推送，无需轮询
// ============================================================

const WebSocket = require('ws');
const EventEmitter = require('events');
const engine = require('./engine');

const WS_URL = 'wss://www.v2hs9.com/ws/';
const RECONNECT_DELAY = 3000; // 断线重连间隔 3 秒

class V2hs9Listener extends EventEmitter {
  constructor(logFn) {
    super();
    this.log = logFn || console.log;
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.lastBlockNum = 0;
    this.messageCount = 0;
    this.lastMessageTime = 0;
  }

  start() {
    this.log('🔗 WebSocket 连接中: ' + WS_URL);
    this.connect();
  }

  connect() {
    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', () => {
        this.connected = true;
        this.log('✅ WebSocket 连接成功，开始接收实时数据');
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (e) {
          // 非JSON消息忽略
        }
      });

      this.ws.on('error', (err) => {
        this.log('❌ WebSocket 错误: ' + err.message, 'error');
        this.connected = false;
      });

      this.ws.on('close', (code, reason) => {
        this.log('⚠️ WebSocket 断开: ' + code + ' ' + reason, 'warn');
        this.connected = false;
        this.scheduleReconnect();
      });
    } catch (err) {
      this.log('❌ WebSocket 连接失败: ' + err.message, 'error');
      this.scheduleReconnect();
    }
  }

  handleMessage(msg) {
    if (!msg.message) return;

    const m = msg.message;

    // TRON 哈希游戏区块数据
    if (m.type === 'lottery_v2_broadcast') {
      this.messageCount++;
      this.lastMessageTime = Date.now();

      const blockNum = parseInt(m.block_num) || 0;
      if (blockNum <= this.lastBlockNum) return; // 跳过旧区块
      this.lastBlockNum = blockNum;

      // 发射区块事件
      // 使用 engine.deriveParityFromHash 计算单双（字母往后找数字）
      const parityResult = engine.deriveParityFromHash(m.block_hash);
      const parity = parityResult.parity;

      this.emit('block', {
        height: blockNum,
        blockHash: m.block_hash,
        parity: parity,
        timeStr: m.created,
        timestamp: new Date(m.created).getTime(),
        last5Num: m.last5_num,
        source: 'v2hs9-ws'
      });
    }

    // 新区块通知
    if (m.type === 'block-new') {
      // 仅记录，不处理（lottery_v2_broadcast 会包含完整数据）
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.log('🔄 WebSocket 重连中...');
      this.connect();
    }, RECONNECT_DELAY);
  }

  stop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.log('🛑 WebSocket 已停止');
  }

  getStatus() {
    return {
      connected: this.connected,
      lastBlockNum: this.lastBlockNum,
      messageCount: this.messageCount,
      lastMessageTime: this.lastMessageTime,
      uptime: this.lastMessageTime ? Math.round((Date.now() - this.lastMessageTime) / 1000) : 0
    };
  }
}

module.exports = V2hs9Listener;
