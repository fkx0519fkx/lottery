'use strict';
/*
 * 抽奖系统 · 服务端(重写版 v2)
 * 纯 Node 标准库,无第三方依赖;设 DATABASE_URL 时自动切换 PostgreSQL(云端部署用)。
 *
 * 端口:8788(被占自动顺延,最多 +10;发现是自己已在跑则直接复用)
 * 管理员密码:默认 fkxfkxfkx,环境变量 ADMIN_PASSWORD 覆盖
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

/* ---------------------------------- 配置 ---------------------------------- */

const PORT = parseInt(process.env.PORT || '8788', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'fkxfkxfkx';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'lottery.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 天

const COOKIE_PARTICIPANT = 'lottery_token';
const COOKIE_ADMIN = 'lottery_admin';

/* ---------------------------------- 数据 ---------------------------------- */

let db = load();
let pg = null;          // 云端 PostgreSQL 客户端
let ACTIVE_PORT = PORT; // 实际监听端口(8788 被占时会顺延)
const adminSessions = new Set(); // 内存态管理员会话(重启后需重新登录,可接受)

function newToken() {
  return crypto.randomBytes(6).toString('hex'); // 12 位,用于 URL 和参与者身份
}

function normalize(obj) {
  const o = obj || {};
  return {
    config: {
      participantToken: (o.config && o.config.participantToken) || newToken(),
      // 结果是否已公布:公布前参与者看不到自己的奖项,只能看进度
      revealed: !!(o.config && o.config.revealed),
    },
    prizes: Array.isArray(o.prizes) ? o.prizes.map(p => ({
      id: p.id || crypto.randomBytes(4).toString('hex'),
      name: String(p.name || '').slice(0, 60),
      count: Math.max(0, Math.min(9999, parseInt(p.count, 10) || 0)),
    })).filter(p => p.name) : [],
    participants: Array.isArray(o.participants) ? o.participants.map(p => ({
      name: String(p.name || '').slice(0, 40),
      token: p.token || newToken(),
      prize: p.prize ? { id: p.prize.id, name: p.prize.name } : null,
      drawnAt: p.drawnAt || null,
    })) : [],
  };
}

function load() {
  try {
    return normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')));
  } catch (e) {
    return normalize(null);
  }
}

// 原子写入:先写临时文件再改名,断电/崩溃也不会写坏数据
function save() {
  if (pg) return Promise.resolve();
  const tmp = DATA_FILE + '.tmp';
  return new Promise((resolve, reject) => {
    fs.mkdir(path.dirname(DATA_FILE), { recursive: true }, () => {
      fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf-8', err => {
        if (err) return reject(err);
        fs.rename(tmp, DATA_FILE, err2 => (err2 ? reject(err2) : resolve()));
      });
    });
  });
}

/* ------------------------- 云端持久化(可选,PostgreSQL) ------------------------- */

async function initPersistence() {
  if (!DATABASE_URL) return;
  const { Client } = require('pg'); // 本地不装 pg 也不会触发这一行
  const client = new Client({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('sslmode') ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  await client.query('CREATE TABLE IF NOT EXISTS lottery_state (id INT PRIMARY KEY, data JSONB NOT NULL)');
  const r = await client.query('SELECT data FROM lottery_state WHERE id = 1');
  if (r.rows.length) db = normalize(r.rows[0].data);
  pg = client;
  console.log('[storage] PostgreSQL mode enabled');
}

async function persist() {
  if (!pg) return save();
  await pg.query(
    'INSERT INTO lottery_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
    [JSON.stringify(db)]
  );
}

/* --------------------------------- 工具函数 --------------------------------- */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, data = '';
    req.on('data', c => {
      size += c.length;
      if (size > 100 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// 无取模偏差的随机整数(拒绝采样)
function cryptoRandomInt(n) {
  if (n <= 0) return 0;
  const max = Math.floor(0xFFFFFFFF / n) * n;
  const buf = Buffer.alloc(4);
  for (;;) {
    crypto.randomFillSync(buf);
    const v = buf.readUInt32BE(0);
    if (v < max) return v % n;
  }
}

function lanIPs() {
  const out = [];
  const ifaces = require('os').networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const it of ifaces[name] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

/* --------------------------------- 业务逻辑 --------------------------------- */

// 还能抽的奖品槽位池(每个名额一个槽)
function remainingSlots() {
  const won = {};
  for (const p of db.participants) if (p.prize) won[p.prize.id] = (won[p.prize.id] || 0) + 1;
  const pool = [];
  for (const prize of db.prizes) {
    const left = prize.count - (won[prize.id] || 0);
    for (let i = 0; i < left; i++) pool.push({ id: prize.id, name: prize.name });
  }
  return pool;
}

// 抽奖:同一名字/token 只抽一次;先抽的人概率与后抽的人完全一致
function drawOnce(participant) {
  if (participant.drawnAt) return participant; // 已抽过,直接返回原结果
  const pool = remainingSlots();
  if (pool.length === 0) {
    participant.prize = null; // 奖品抽完了,标记为已抽未中
  } else {
    participant.prize = pool[cryptoRandomInt(pool.length)];
  }
  participant.drawnAt = new Date().toISOString();
  return participant;
}

// 所有名额都抽完了吗(自动公布的条件)
function allSlotsFilled() {
  if (!db.prizes.length) return false;
  return remainingSlots().length === 0;
}

// 对外公布用的中奖名单(按中奖时间排序,不含落选者)
function winnerList() {
  return db.participants
    .filter(p => p.prize)
    .slice()
    .sort((a, b) => new Date(a.drawnAt || 0) - new Date(b.drawnAt || 0))
    .map(p => ({
      name: p.name,
      prize: { id: p.prize.id, name: p.prize.name },
      drawnAt: p.drawnAt,
    }));
}

/* ---------------------------------- 路由 ---------------------------------- */

async function handleAPI(req, res, url) {
  const cookies = parseCookies(req);
  const adminToken = cookies[COOKIE_ADMIN];
  const isAdmin = !!(adminToken && adminSessions.has(adminToken));
  const myToken = cookies[COOKIE_PARTICIPANT];

  /* ---- GET /api/state:页面状态 ---- */
  if (url.pathname === '/api/state' && req.method === 'GET') {
    const me = (myToken && db.participants.find(p => p.token === myToken)) || null;
    const revealed = !!db.config.revealed;
    // 管理员随时可看;参与者只有公布后才能看到奖项和名单
    const canSee = isAdmin || revealed;
    return sendJSON(res, 200, {
      ok: true,
      isAdmin,
      participantToken: db.config.participantToken,
      // 内网访问地址:管理员用 localhost 打开时,页面用它拼出同事能打开的链接
      lanUrls: lanIPs().map(ip => `http://${ip}:${ACTIVE_PORT}/`),
      prizes: db.prizes,
      revealed,
      // 中奖名单只有管理员能看;普通用户只给统计数字
      stats: {
        totalPrizes: db.prizes.reduce((s, p) => s + p.count, 0),
        totalParticipants: db.participants.length,
        totalWinners: db.participants.filter(p => p.prize).length,
        slotsLeft: remainingSlots().length,
      },
      participants: isAdmin ? db.participants : [],
      winners: canSee ? winnerList() : [],
      me: me ? {
        name: me.name,
        drawnAt: me.drawnAt,
        prize: canSee ? me.prize : null,
        // 已抽但结果尚未公布
        pending: !!me.drawnAt && !canSee,
      } : null,
    });
  }

  /* ---- POST /api/draw:参与者抽奖(无需密码) ---- */
  if (url.pathname === '/api/draw' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return sendJSON(res, 400, { ok: false, error: '请先填写名字' });

    // 身份以"名字"为准:同名多次请求返回同一结果,防止换设备/刷新重抽
    let me = db.participants.find(p => p.name === name);
    if (!me) {
      me = { name, token: newToken(), prize: null, drawnAt: null };
      db.participants.push(me);
    }
    const alreadyDrawn = !!me.drawnAt; // 进来前就抽过 = 重复请求
    drawOnce(me);
    // 名额刚好抽完 → 自动公布结果
    if (allSlotsFilled()) db.config.revealed = true;
    await persist();
    const canSee = isAdmin || !!db.config.revealed;
    res.setHeader('Set-Cookie',
      `${COOKIE_PARTICIPANT}=${encodeURIComponent(me.token)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly`);
    return sendJSON(res, 200, {
      ok: true,
      name: me.name,
      prize: canSee ? me.prize : null,
      drawnAt: me.drawnAt,
      revealed: !!db.config.revealed,
      pending: !canSee,
      alreadyDrawn,
    });
  }

  /* ---- POST /api/admin/login ---- */
  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body.password !== 'string' || body.password !== ADMIN_PASSWORD) {
      return sendJSON(res, 401, { ok: false, error: '密码不对' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    adminSessions.add(token);
    res.setHeader('Set-Cookie',
      `${COOKIE_ADMIN}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly`);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- POST /api/admin/logout ---- */
  if (url.pathname === '/api/admin/logout' && req.method === 'POST') {
    if (adminToken) adminSessions.delete(adminToken);
    res.setHeader('Set-Cookie', `${COOKIE_ADMIN}=; Path=/; Max-Age=0`);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- 以下全部需要管理员 ---- */
  if (!isAdmin) return sendJSON(res, 401, { ok: false, error: '需要管理员密码' });

  if (url.pathname === '/api/admin/setup' && req.method === 'POST') {
    const body = await readBody(req);
    if (!Array.isArray(body.prizes)) return sendJSON(res, 400, { ok: false, error: 'prizes 必须是数组' });
    db.prizes = body.prizes.map(p => ({
      id: p.id || crypto.randomBytes(4).toString('hex'),
      name: String(p.name || '').trim().slice(0, 60),
      count: Math.max(0, Math.min(9999, parseInt(p.count, 10) || 0)),
    })).filter(p => p.name && p.count > 0);
    await persist();
    return sendJSON(res, 200, { ok: true, prizes: db.prizes });
  }

  if (url.pathname === '/api/admin/regen-token' && req.method === 'POST') {
    db.config.participantToken = newToken();
    await persist();
    return sendJSON(res, 200, { ok: true, participantToken: db.config.participantToken });
  }

  if (url.pathname === '/api/admin/reveal' && req.method === 'POST') {
    const body = await readBody(req);
    db.config.revealed = body.revealed !== false;
    await persist();
    return sendJSON(res, 200, { ok: true, revealed: db.config.revealed });
  }

  if (url.pathname === '/api/admin/reset' && req.method === 'POST') {
    db.participants = [];
    db.config.revealed = false; // 新的一轮,重新保密
    await persist();
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { ok: false, error: 'not found' });
}

/* ------------------------------- 静态文件服务 ------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      return res.end();
    }
    try { return await handleAPI(req, res, url); }
    catch (e) {
      console.error('[api error]', e.message);
      return sendJSON(res, 500, { ok: false, error: '服务器开小差了,请重试' });
    }
  }

  // SPA 回退:任何页面路径都回 index.html(?p=xxx 参数由前端 JS 处理)
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (rel.indexOf('..') !== -1) { res.writeHead(404); return res.end(); }

  fs.readFile(path.join(PUBLIC_DIR, rel), (err, data) => {
    if (err) {
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, idx) => {
        if (err2) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(idx);
      });
    }
    const ext = path.extname(rel).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* ------------------------------- 启动与端口策略 ------------------------------- */

function printBanner(port) {
  // 控制台输出一律 ASCII,避免 Windows 代码页(936/65001)不一致导致乱码
  const line = '='.repeat(60);
  console.log(line);
  console.log('   LOTTERY SERVER IS RUNNING');
  console.log(line);
  console.log('');
  console.log('   [1] ADMIN PAGE  (only for you, password required)');
  console.log(`       http://localhost:${port}/`);
  console.log(`       password: ${ADMIN_PASSWORD}`);
  console.log('');
  console.log('   [2] PARTICIPANT LINK  (copy one line and send to colleagues)');
  for (const ip of lanIPs()) {
    console.log(`       http://${ip}:${port}/?p=${db.config.participantToken}`);
  }
  console.log(`       http://localhost:${port}/?p=${db.config.participantToken}`);
  console.log('');
  console.log('   Keep this window open. Press Ctrl+C to stop.');
  console.log(line);
  console.log('');
}

// 启动后自动打开浏览器(仅 Windows;云端或 AUTO_OPEN=0 时跳过)
function openBrowser(url) {
  if (process.platform !== 'win32' || process.env.AUTO_OPEN === '0') return;
  try {
    const { exec } = require('child_process');
    exec(`start "" "${url}"`, { shell: 'cmd.exe', windowsHide: true });
  } catch (e) { /* 打不开也无妨,手动点链接即可 */ }
}

// 探测端口上跑的是不是我们自己的抽奖服务
function probeExisting(port) {
  return new Promise(resolve => {
    const mod = DATABASE_URL.startsWith('https') ? https : http;
    const req = mod.get({ host: '127.0.0.1', port, path: '/api/state', timeout: 1500 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(!!(j && j.ok === true && typeof j.participantToken === 'string'));
        } catch (e) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function tryListen(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handleRequest);
    s.once('error', reject);
    s.listen(port, HOST, () => { s.removeListener('error', reject); resolve(s); });
  });
}

async function start() {
  for (let i = 0; i <= 10; i++) {
    const port = PORT + i;
    try {
      await tryListen(port);
      ACTIVE_PORT = port;
      if (i > 0) {
        console.log('');
        console.log(`[note] port ${PORT} is busy, this run uses port ${port} instead.`);
        console.log('');
      }
      printBanner(port);
      openBrowser(`http://localhost:${port}/`);
      return;
    } catch (e) {
      if (e && e.code !== 'EADDRINUSE') {
        console.error('[start failed]', e && e.message ? e.message : e);
        process.exit(1);
      }
      if (await probeExisting(port)) {
        console.log('');
        console.log(`[already running] a lottery server is already running on port ${port}.`);
        console.log(`[already running] browser opened: http://localhost:${port}/`);
        console.log('');
        console.log('  To use the newest version, close the OTHER black window first,');
        console.log('  then run this launcher again.');
        console.log('');
        openBrowser(`http://localhost:${port}/`);
        return;
      }
      // 被其他程序占用,换下一个端口继续
    }
  }
  console.error(`[start failed] ports ${PORT}-${PORT + 10} are all in use. Close some programs and retry.`);
  process.exit(1);
}

initPersistence()
  .then(start)
  .catch(e => {
    console.error('[start failed]', e && e.message ? e.message : e);
    process.exit(1);
  });
