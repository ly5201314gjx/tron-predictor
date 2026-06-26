/**
 * Cloudflare Worker — TRON API 代理
 * 
 * 功能：代理 trongrid.io API 请求，利用 CF 边缘网络加速
 * 部署：独立 Worker，不影响现有 sub2api 和 tron 路由
 * 
 * 使用方式：
 *   1. 在 Cloudflare Dashboard → Workers → 创建 Worker
 *   2. 粘贴此脚本
 *   3. 部署后得到一个 *.workers.dev 域名
 *   4. 修改后端代码使用这个代理地址
 */

const TRON_API = 'https://api.trongrid.io';
const CACHE_TTL = 2; // 区块号缓存 2 秒

export default {
  async fetch(request) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // 获取请求路径
    const url = new URL(request.url);
    const tronPath = url.pathname.replace('/tron/', '/');
    const tronUrl = TRON_API + tronPath + url.search;

    // 克隆请求
    const proxyRequest = new Request(tronUrl, {
      method: request.method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: request.method !== 'GET' ? await request.text() : undefined,
    });

    // 发起请求
    const response = await fetch(proxyRequest, {
      cf: {
        cacheTtl: CACHE_TTL,
        cacheEverything: false,
      }
    });

    // 返回结果，带 CORS 头
    const newResponse = new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': `max-age=${CACHE_TTL}`,
      }
    });

    return newResponse;
  }
};
