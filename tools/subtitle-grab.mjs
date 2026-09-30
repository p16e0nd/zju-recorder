#!/usr/bin/env node
// 智云课堂实时字幕抓取。
//
// 用法：
//   node tools/subtitle-grab.mjs [--course <course_id>] [--sub <sub_id>] [--out 前缀] [--duration 秒]
//   不带参数 = 自动发现正在直播的课程并抓取。
// 产物：JSONL + 同名 .txt。
// 需先登录：~/.zju_jwt，与 server.js 共用。

import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORIGIN = 'https://interactivemeta.cmc.zju.edu.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';
// 与 server.js 同一套环境变量。
const DETAIL_BASE = process.env.ZJU_DETAIL_BASE || 'https://yjapi.cmc.zju.edu.cn/courseapi/v2/course-live';
const LIST_BASE = process.env.ZJU_LIST_BASE || 'https://classroom.zju.edu.cn/courseapi/v2/course-live';
const TENANT = process.env.ZJU_TENANT || '112';

// ---------- JWT ----------
function readJwt() {
  const p = path.join(os.homedir(), '.zju_jwt');
  if (!fs.existsSync(p)) throw new Error(`找不到 ${p}（先用本工具所在服务的 /api/login 或 zjuauth.js 登录）`);
  const jwt = fs.readFileSync(p, 'utf8').trim();
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
  if (payload.exp * 1000 < Date.now()) throw new Error('JWT 已过期，请重新登录刷新 ~/.zju_jwt');
  return jwt;
}

function apiGet(url, jwt) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/json',
        origin: 'https://classroom.zju.edu.cn',
        referer: 'https://classroom.zju.edu.cn/',
        'user-agent': UA,
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error(`非 JSON 响应 HTTP ${res.statusCode}: ${body.slice(0, 120)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

// ---------- 课程发现 ----------
async function findTarget(jwt, courseId, subId) {
  if (courseId && subId) {
    const u = `${DETAIL_BASE}/search-live-course-list?all=1&course_id=${courseId}&sub_id=${subId}&with_sub_data=1&with_room_data=1&show_all=1&show_delete=2`;
    const r = await apiGet(u, jwt);
    const c = r.list && r.list[0];
    if (!c) throw new Error('该场次不存在或接口无返回');
    return c;
  }
  // 自动发现：先按时间窗筛出正在直播的课，再逐个确认语音识别。
  const now = new Date();
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const nowSec = Math.floor(now.getTime() / 1000);
  const u = `${LIST_BASE}/search-live-course-list?need_time_quantum=1&unique_course=1&with_sub_duration=1&with_sub_data=1&search_time=${day}&quantum_id=0&tenant=${TENANT}`;
  const r = await apiGet(u, jwt);
  const quanta = (r.list || []).filter((q) => q && q.id);
  const live = [];
  for (const q of quanta) {
    const u2 = `${LIST_BASE}/search-live-course-list?need_time_quantum=1&unique_course=1&with_sub_duration=1&with_sub_data=1&search_time=${day}&quantum_id=${q.id}&tenant=${TENANT}`;
    const r2 = await apiGet(u2, jwt);
    for (const seg of r2.list || []) {
      for (const c of seg.list || []) {
        const begin = Number(c.course_begin) || 0;
        const over = Number(c.course_over) || 0;
        if (begin - 300 <= nowSec && nowSec <= over + 300) live.push(c);
      }
    }
  }
  console.error(`时间窗内候选 ${live.length} 门，逐个确认语音识别…`);
  // 限并发 4 + 每次详情请求间隔 ≥300ms。命中第一个即返回。
  const queue = [...live];
  const winner = await new Promise((resolve) => {
    let done = 0, finished = false;
    const check = async () => {
      while (queue.length) {
        const c = queue.shift();
        try {
          const d = await apiGet(`${DETAIL_BASE}/search-live-course-list?all=1&course_id=${c.course_id}&sub_id=${c.sub_id}&with_sub_data=1&with_room_data=1&show_all=1&show_delete=2`, jwt);
          const det = d.list && d.list[0];
          let sc = {};
          try { sc = JSON.parse((det && det.sub_content) || '{}'); } catch {}
          if (sc.trans_socket_url && sc.api_pass && sc.api_pass.qlite_status === 'running') {
            if (!finished) { finished = true; resolve(det); }
            return;
          }
        } catch {}
        done++;
        await new Promise((r) => setTimeout(r, 300));
      }
      done++;
      if (done >= live.length && !finished) resolve(null);
    };
    for (let i = 0; i < Math.min(4, live.length); i++) check();
  });
  if (!winner) throw new Error('当前没有「直播中且开启语音识别」的课程');
  console.error(`自动发现: ${winner.title} ${winner.sub_title} ${winner.room_name || ''}`);
  return winner;
}

// ---------- glue WebSocket 客户端 ----------
function connectGlue(wsUrl, onFrame) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const req = https.request({
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
      headers: {
        Host: u.hostname, Upgrade: 'websocket', Connection: 'Upgrade',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        Origin: ORIGIN, 'User-Agent': UA,
      },
      timeout: 15000,
    });
    req.on('upgrade', (res, socket) => {
      let buf = Buffer.alloc(0);
      let pending = [];
      const send = (str) => {
        const payload = Buffer.from(str, 'utf8');
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
        let header;
        if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
        else {
          header = Buffer.alloc(4);
          header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
        }
        socket.write(Buffer.concat([header, mask, masked]));
      };
      send('in' + JSON.stringify({ version: '1.9.1' })); // glue 握手
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          const len0 = buf[1] & 0x7f;
          let off = 2, len = len0;
          if (len0 === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
          else if (len0 === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) break;
          const opcode = buf[0] & 0x0f;
          const payload = buf.slice(off, off + len).toString('utf8');
          buf = buf.slice(off + len);
          if (opcode !== 1) continue;
          if (payload.startsWith('in')) continue;          // socketID 确认
          if (payload.startsWith('pi')) { send('po'); continue; } // ping->pong
          if (payload.startsWith('cd')) pending.push(payload.slice(2));
        }
      });
      socket.on('error', reject);
      resolve({
        stop: () => { try { socket.end(); } catch {} },
      });
      const pump = setInterval(() => {
        while (pending.length) {
          const raw = pending.shift();
          const m = raw.match(/^(\d+)&/);
          if (!m) continue;
          const chLen = parseInt(m[1], 10);
          const body = raw.slice(m[0].length + chLen);
          try { onFrame(JSON.parse(body)); } catch (e) { console.error('解析失败:', e.message, raw.slice(0, 100)); }
        }
      }, 100);
      req.socket?.setKeepAlive?.(true);
      const cleanup = () => clearInterval(pump);
      socket.on('close', cleanup);
      socket.on('error', cleanup);
    });
    req.on('response', (res) => reject(new Error(`WS 升级被拒: HTTP ${res.statusCode}（检查 trans_socket_url 是否已失效）`)));
    req.on('timeout', () => req.destroy(new Error('握手超时')));
    req.on('error', reject);
    req.end();
  });
}

// ---------- 字幕组装 ----------
class Transcript {
  constructor() {
    this.current = null;   // 进行中的一句
    this.segments = [];    // 已定稿
    this.listeners = [];
  }
  onFrame(f) {
    if (typeof f.sourcetext !== 'string') return;
    const done = Number(f.end_time) > 0;
    this.current = {
      sourcetext: f.sourcetext,
      transtext: f.transtext || '',
      beginMs: Number(f.text_begin_time) || Number(f.time) || Date.now(),
      endMs: Number(f.text_end_time) || Date.now(),
    };
    for (const l of this.listeners) l('partial', this.current);
    if (done) {
      this.segments.push(this.current);
      for (const l of this.listeners) l('final', this.current);
      this.current = null;
    }
  }
}

// ---------- main ----------
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const courseId = opt('course');
const subId = opt('sub');
const outPrefix = opt('out');
const durationSec = Number(opt('duration', 0)) || 0; // 0 = 一直跑到 Ctrl+C

const jwt = readJwt();
const course = await findTarget(jwt, courseId, subId);
let sc = {};
try { sc = JSON.parse(course.sub_content || '{}'); } catch {}
if (!sc.trans_socket_url) throw new Error('该课程未开启平台语音识别（sub_content 里没有 trans_socket_url）');

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const base = outPrefix || `subtitle_${course.sub_id}_${stamp}`;
const jsonlPath = base + '.jsonl';
const txtPath = base + '.txt';
const jsonl = fs.createWriteStream(jsonlPath, { flags: 'a' });
const txt = fs.createWriteStream(txtPath, { flags: 'a' });

console.error(`课程: ${course.title} ${course.sub_title}（${course.room_name || ''} ${course.lecturer_name || ''}）`);
console.error(`字幕服务: ${sc.trans_socket_url.replace(/^http/, 'ws')}/glue/ws`);
console.error(`输出: ${jsonlPath} / ${txtPath}`);
console.error('---');

const t = new Transcript();
t.listeners.push((kind, seg) => {
  const rec = {
    kind, sourcetext: seg.sourcetext, transtext: seg.transtext,
    beginMs: seg.beginMs, endMs: seg.endMs, wallClock: new Date().toISOString(),
  };
  jsonl.write(JSON.stringify(rec) + '\n');
  if (kind === 'final') {
    const line = `[${new Date(seg.endMs).toLocaleTimeString('zh-CN', { hour12: false })}] ${seg.sourcetext}\n`;
    txt.write(line);
    process.stdout.write(line);
  } else {
    process.stdout.write(`\r  ${seg.sourcetext.slice(-60)}`);
  }
});

const wsUrl = `${sc.trans_socket_url.replace(/^http/, 'ws')}/glue/ws`;
const conn = await connectGlue(wsUrl, (f) => t.onFrame(f));
console.error('已连接，开始接收字幕…');

const stop = () => {
  console.error('\n停止。');
  conn.stop();
  jsonl.end(); txt.end();
  process.exit(0);
};
process.on('SIGINT', stop);
if (durationSec > 0) setTimeout(stop, durationSec * 1000);
