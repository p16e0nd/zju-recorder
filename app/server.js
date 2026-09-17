#!/usr/bin/env node
// ============================================================
//  ZJU 课程直播录制 - Web 版后端（正规接口版）
//  零依赖：仅用 Node 内置模块 + 系统 ffmpeg
//  运行: node server.js   然后浏览器打开 http://127.0.0.1:8787
//
//  数据流：
//   1) 列表：classroom.zju.edu.cn 按 search_time(日期)+quantum_id(时段)+tenant 查
//      - 一次"探路"调用(quantum_id=0)拿到当天 6 个时段 id
//      - 再按每个时段取课，course_student_type: 1=本科 2=研究生
//   2) 取流：点录制时用 course_id+sub_id 调 yjapi 详情，解析直播 m3u8
//   3) ffmpeg -c copy 分段录制
// ============================================================
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { login: zjuLogin } = require('./zjuauth');

// ---------- 配置 ----------
const PORT = process.env.PORT || 8787;
const JWT_FILE = path.join(os.homedir(), '.zju_jwt');
const CREDS_FILE = path.join(os.homedir(), '.zju_credentials');
const OUTPUT_DIR = path.join(os.homedir(), 'ZJU-Recordings');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEGMENT_SECONDS = 1800; // 每30分钟切一个文件
// 停止录制后等 ffmpeg 写完 moov 收尾的上限；超时仍未退出则强杀兜底
const STOP_GRACE_MS = 8000;
// 前端详情页布局存档。
const UI_LAYOUT_FILE = path.join(os.homedir(), 'ZJU-Recordings-ai', 'ui-layout.json');

// ---------- 播放诊断相关配置 ----------
// 诊断产物写到 home 下的独立目录：不进录制目录，避免污染存储统计与压缩工具的课程发现
const DIAG_DIR = path.join(os.homedir(), 'ZJU-Recordings-diag');
const PLAY_LOG_FILE = path.join(DIAG_DIR, 'play-diag.jsonl');
const PROXY_TIMEOUT_MS = Number(process.env.ZJU_PROXY_TIMEOUT_MS || 20000); // 上游无响应上限
const DIAG_LOG_ROTATE_BYTES = 8 * 1024 * 1024;
const PLAY_LOG_KEEP = 4000; // 内存环形缓冲条数（供网页直接查看，不必开 DevTools）

// 列表接口（本研都返回）。详情/取流接口默认 yjapi，可用环境变量覆盖。
const LIST_BASE = process.env.ZJU_LIST_BASE
  || 'https://classroom.zju.edu.cn/courseapi/v2/course-live';
const DETAIL_BASE = process.env.ZJU_DETAIL_BASE
  || 'https://yjapi.cmc.zju.edu.cn/courseapi/v2/course-live';
const TENANT = process.env.ZJU_TENANT || '112';

// ---------- 录制任务表 ----------
const jobs = new Map();
let jobSeq = 0;

// ---------- JWT ----------
function readJwt() {
  try { return fs.readFileSync(JWT_FILE, 'utf8').replace(/\s/g, ''); }
  catch { return ''; }
}
function saveJwt(token) { fs.writeFileSync(JWT_FILE, token.trim(), { mode: 0o600 }); }

// ---------- 账密 + 自动登录（过期自动重登拿新 JWT）----------
function readCreds() {
  try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')); } catch { return null; }
}
function saveCreds(username, password) {
  fs.writeFileSync(CREDS_FILE, JSON.stringify({ username, password }), { mode: 0o600 });
}
function hasCreds() { const c = readCreds(); return !!(c && c.username && c.password); }

let reloginInFlight = null;
let lastReloginAt = 0;
// 真正执行一次登录并落地 JWT
// 每次登录后，把「当前能拿到的全部」重签一遍：地址窗口是按下发时刻算的，
// 只有重新向 API 要一次地址，才能把窗口重置成完整的 ~7 小时。
// 不会阻塞登录返回（后台跑），并用 5 分钟节流避免重登风暴时反复全量刷新。
let lastAfterLoginRefreshAt = 0;
function refreshCacheAfterLogin(reason) {
  const now = Date.now();
  if (now - lastAfterLoginRefreshAt < 5 * 60 * 1000) return;
  lastAfterLoginRefreshAt = now;
  const jwt = readJwt();
  if (!jwt) return;
  setTimeout(() => {
    precacheLive(jwt, { force: true, reason: 'after-login:' + reason })
      .then((r) => console.log(`[cache] ${new Date().toLocaleTimeString('zh-CN')} 登录后强制刷新：重签 ${r.refreshed}/${r.total}，窗口 ~${(r.windowMaxMin / 60).toFixed(1)}h`))
      .catch(() => {});
  }, 800);
}

async function doLogin() {
  const c = readCreds();
  if (!c || !c.username || !c.password) throw new Error('未配置账密');
  const jwt = await zjuLogin(c.username, c.password, {});
  saveJwt(jwt);
  lastReloginAt = Date.now();
  console.log(`[auth] ${new Date().toLocaleTimeString('zh-CN')} 自动登录成功，JWT 已更新`);
  refreshCacheAfterLogin('doLogin');
  return jwt;
}
// 去重 + 限频（30s 内只登一次），返回进行中的 promise
function autoRelogin() {
  if (!hasCreds()) return Promise.reject(new Error('未配置账密'));
  if (reloginInFlight) return reloginInFlight;
  if (Date.now() - lastReloginAt < 30000) return Promise.reject(new Error('刚登录过，稍后再试'));
  reloginInFlight = doLogin().finally(() => { reloginInFlight = null; });
  return reloginInFlight;
}
function isAuthError(e) {
  return !!(e && (e.authFail || /认证失败|未登录|登录失效|token|unauthor/i.test(e.message || '')));
}
// 包一层：调用失败若是鉴权问题且配了账密，则自动重登再重试一次
async function withRelogin(fn) {
  try { return await fn(); }
  catch (e) {
    if (isAuthError(e) && hasCreds()) { await autoRelogin(); return await fn(); }
    throw e;
  }
}

function inspectJwt(jwt) {
  if (!jwt) return { present: false };
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    const exp = payload.exp || 0;
    return {
      present: true, exp,
      expired: exp > 0 && now > exp,
      expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
    };
  } catch { return { present: true, malformed: true }; }
}

// ---------- 公共：请求头 / 日期 ----------
function zjuHeaders(jwt) {
  return {
    authorization: `Bearer ${jwt}`,
    accept: 'application/json',
    origin: 'https://classroom.zju.edu.cn',
    referer: 'https://classroom.zju.edu.cn/',
  };
}
// 查询用日期：与网站一致的非补零格式 2026-6-3
function queryDate(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
// 显示/筛选用日期：补零 2026-06-03
function dispDate(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// ---------- 列表接口 ----------
async function fetchList(jwt, searchTime, quantumId) {
  const qs = new URLSearchParams({
    need_time_quantum: '1',
    unique_course: '1',
    with_sub_duration: '1',
    with_sub_data: '1',
    search_time: searchTime,
    quantum_id: String(quantumId),
    tenant: TENANT,
  });
  const res = await fetch(`${LIST_BASE}/search-live-course-list?${qs}`, {
    headers: zjuHeaders(jwt),
  });
  const data = await res.json();
  if (String(data.code) !== '0') {
    const err = new Error(data.msg || '列表接口请求失败（可能 JWT 已失效）');
    err.apiCode = data.code;
    throw err;
  }
  return data.list || []; // 6 个时段
}

// 取某一天的全部课程
async function fetchDay(jwt, dateObj) {
  const searchTime = queryDate(dateObj);
  const display = dispDate(dateObj);

  // 1) 探路：拿当天 6 个时段的 id / 名称 / 时间
  const boot = await fetchList(jwt, searchTime, 0);
  const quantums = boot.map((q) => ({
    id: q.id,
    name: q.name,
    time: `${String(q.class_begin_time || '').slice(0, 5)}-${String(q.class_end_time || '').slice(0, 5)}`,
  }));

  // 2) 每个时段并发取课
  const perQuantum = await Promise.all(
    quantums.map(async (q) => {
      const list = await fetchList(jwt, searchTime, q.id);
      const hit = list.find((x) => String(x.id) === String(q.id));
      return { q, courses: (hit && hit.list) || [] };
    })
  );

  // 3) 拍平 + 映射
  const out = [];
  for (const { q, courses } of perQuantum) {
    for (const c of courses) out.push(mapCourse(c, display, q));
  }
  return out;
}

// 当前时间落在哪个时段（用于自动缓存的轻量拉取）。课间返回 null。
function pickCurrentQuantum(rawQuantums) {
  const now = new Date();
  const hm = now.getHours() * 60 + now.getMinutes();
  for (const q of rawQuantums) {
    const b = String(q.class_begin_time || '').split(':').map(Number);
    const e = String(q.class_end_time || '').split(':').map(Number);
    if (b.length < 2 || e.length < 2) continue;
    if (hm >= b[0] * 60 + b[1] && hm <= e[0] * 60 + e[1]) return q;
  }
  return null;
}

// 只拉「今天 + 当前时段」的课（autoCacheTick 用，省流量）。课间返回 []。
async function fetchCurrentLive(jwt) {
  const searchTime = queryDate(new Date());
  const display = dispDate(new Date());
  const boot = await fetchList(jwt, searchTime, 0); // 探路：6 时段（空列表，很小）
  const q = pickCurrentQuantum(boot);
  if (!q) return [];
  const list = await fetchList(jwt, searchTime, q.id);
  const hit = list.find((x) => String(x.id) === String(q.id));
  const qmeta = {
    id: q.id, name: q.name,
    time: `${String(q.class_begin_time || '').slice(0, 5)}-${String(q.class_end_time || '').slice(0, 5)}`,
  };
  return ((hit && hit.list) || []).map((c) => mapCourse(c, display, qmeta));
}

function mapCourse(c, date, q) {
  const label = String(c.status_label || '');
  return {
    id: `${c.course_id}-${c.sub_id}`,
    course_id: c.course_id,
    sub_id: c.sub_id,
    title: c.title || '',
    teacher: c.lecturer_name || c.realname || '',
    college: c.kkxy_name || '',
    room: c.room_name || '',
    date,
    quantum: q.name || '',          // 第N时段
    quantum_time: q.time || '',     // HH:MM-HH:MM
    quantum_id: q.id,
    student_type: String(c.course_student_type || ''), // "1"=本科 "2"=研究生
    status_label: label,
    live: /直播/.test(label),                          // 真正"正在直播"
    cached: hasCachedStream(c.course_id, c.sub_id),    // 缓存地址在有效期内时仍可使用
    sub_title: c.sub_title || '',
  };
}

// 该场次是否有"仍未过期"的缓存直播流（auth_key 约 4h 有效）
function hasCachedStream(courseId, subId) {
  const c = streamCache.get(`${courseId}-${subId}`);
  return !!(c && c.expiry > Math.floor(Date.now() / 1000) + 5);
}

// 最近一次课程快照（给星标做"现在有没有开课"的实时匹配，避免每次都重拉）
let coursesSnapshot = { at: 0, courses: [] };

// 拉取昨天、今天与明天的课程；有效缓存地址可继续用于播放或录制。
async function fetchCourses(jwt) {
  const yesterday = new Date(Date.now() - 86400000);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const days = await Promise.all([
    fetchDay(jwt, yesterday), fetchDay(jwt, today), fetchDay(jwt, tomorrow),
  ]);

  const seen = new Set();
  const out = [];
  for (const c of days.flat()) {
    if (seen.has(c.id)) continue; // 去重
    seen.add(c.id);
    out.push(c);
  }
  coursesSnapshot = { at: Date.now(), courses: out };
  clObserveCourses(out, true);      // 查老师：完整课程表 → 攒教师池 + 记下"能看的课"
  return out;
}

// ---------- 详情：解析直播 m3u8（带缓存）----------
// m3u8 的 auth_key 第一段是过期时间戳（约 4h 有效）。一旦解析到，缓存到过期为止；
// 之后实时接口拿不到时（课间、或列表 status 滞后），回退用仍有效的缓存地址，
// 这样课间也能继续看/录。
const streamCache = new Map(); // `${courseId}-${subId}` -> { streams, expiry, title, room }
const STREAMCACHE_FILE = path.join(os.homedir(), '.zju_stream_cache.json');
// 可通过环境变量配置 auth_key 的缓存余量与回退有效期。
const AUTHKEY_GRACE_SEC = Number(process.env.ZJU_AUTHKEY_GRACE) || 10800;
const STREAM_FALLBACK_TTL_SEC = Number(process.env.ZJU_STREAM_FALLBACK_TTL) || 1800;

function loadStreamCache() {
  try {
    const obj = JSON.parse(fs.readFileSync(STREAMCACHE_FILE, 'utf8')) || {};
    const now = Math.floor(Date.now() / 1000);
    for (const [k, v] of Object.entries(obj)) if (v && v.expiry > now + 5) streamCache.set(k, v);
  } catch {}
}
function saveStreamCache() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const obj = {};
    for (const [k, v] of streamCache) if (v.expiry > now + 5) obj[k] = v;
    fs.writeFileSync(STREAMCACHE_FILE, JSON.stringify(obj));
  } catch {}
}

function streamsExpiry(streams) {
  let min = Infinity;
  for (const s of streams) {
    const urls = [s.url, s.watchUrl, s.recordUrl, ...((s.alternates || []).map((a) => a.url))].filter(Boolean);
    for (const u of urls) {
      const m = /auth_key=(\d+)-/.exec(u);
      if (m) min = Math.min(min, Number(m[1]));
      const tx = /[?&]txTime=([0-9a-fA-F]+)/.exec(u);
      if (tx) {
        const v = parseInt(tx[1], 16);
        if (v > 1600000000) min = Math.min(min, v);
      }
    }
  }
  return Number.isFinite(min) ? min : 0;
}

async function fetchDetailCourse(jwt, courseId, subId) {
  const qs = new URLSearchParams({
    all: '1', course_id: String(courseId), sub_id: String(subId),
    with_sub_data: '1', with_room_data: '1', show_all: '1', show_delete: '2',
  });
  const res = await fetch(`${DETAIL_BASE}/search-live-course-list?${qs}`, {
    headers: zjuHeaders(jwt),
  });
  const data = await res.json();
  if (String(data.code) !== '0') throw new Error(data.msg || '详情接口请求失败');
  return (data.list || [])[0] || null;
}

async function fetchDetailStreams(jwt, courseId, subId) {
  const c = await fetchDetailCourse(jwt, courseId, subId);
  if (!c) return [];
  const direct = extractStreams(c.sub_content);
  if (direct.length) return direct;
  return fetchMetaStreams(jwt, courseId, subId, c.sub_content);
}

async function resolveStreams(jwt, courseId, subId, meta = {}) {
  const key = `${courseId}-${subId}`;
  const now = Math.floor(Date.now() / 1000);

  // 1) 先实时解析
  let streams = [];
  try { streams = await fetchDetailStreams(jwt, courseId, subId); }
  catch { /* 失败则尝试缓存 */ }

  if (streams.length) {
    const baseExpiry = streamsExpiry(streams);
    const expiry = baseExpiry ? baseExpiry + AUTHKEY_GRACE_SEC : now + STREAM_FALLBACK_TTL_SEC;
    const prev = streamCache.get(key);
    // 新调用没带 meta 时，保留已有的教室名/课程名，避免被清空
    streamCache.set(key, {
      streams, expiry,
      title: meta.title || (prev && prev.title) || '',
      room: meta.room || (prev && prev.room) || '',
    });
    saveStreamCache(); // 持久化到磁盘，重启不丢
    return { streams, source: 'live', expiry, dropped: streams.dropped || [] };
  }

  // 2) 实时拿不到（下课了，API 不再签发）→ 直接复用缓存地址，~7h 内仍可访问（含下课后）
  const cached = streamCache.get(key);
  if (cached && cached.expiry > now + 5)
    return { streams: cached.streams, source: 'cached', expiry: cached.expiry, dropped: [] };
  if (cached) { streamCache.delete(key); saveStreamCache(); } // 真过期了（超 7h）才清

  return { streams: [], source: 'none', expiry: 0, dropped: [] };
}

// ---------- 自动续缓存：指定教学区在播的课，自动解析并持久化，过期自动续 ----------
// 目的：随时想看这些区的任一在播教室，地址已经备好（含课间/状态滞后兜底）。
const AUTOCACHE_ROOMS = (process.env.ZJU_AUTOCACHE_ROOMS || '紫金港西,紫金港东,紫金港北')
  .split(',').map((s) => s.trim()).filter(Boolean);
const AUTOCACHE_INTERVAL_MS = (Number(process.env.ZJU_AUTOCACHE_INTERVAL) || 600) * 1000; // 默认10分钟
let autoCacheBusy = false;

async function autoCacheTick() {
  if (autoCacheBusy || !AUTOCACHE_ROOMS.length) return;
  if (!readJwt()) { if (hasCreds()) { try { await autoRelogin(); } catch { return; } } else return; }
  autoCacheBusy = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    // 省流量：只拉「今天 + 当前时段」（在播的课都在这一个时段里），不再拉 3 天×6 时段
    const courses = await withRelogin(() => fetchCurrentLive(readJwt()));
    coursesSnapshot = { at: Date.now(), courses }; // 顺带刷新星标用的"在播"快照
    clObserveCourses(courses, false);              // 查老师：只攒教师，不动"能看的课"（这份名单是不全的）
    const targets = courses.filter((c) =>
      c.live && AUTOCACHE_ROOMS.some((r) => (c.room || '').includes(r)));
    let renewed = 0;
    for (const c of targets) {
      const cur = streamCache.get(`${c.course_id}-${c.sub_id}`);
      if (cur && cur.expiry > now + 1200) continue; // 还够 20 分钟就不重复解析
      try {
        if ((await resolveStreams(jwt, c.course_id, c.sub_id, { title: c.title, room: c.room })).streams.length)
          renewed++;
      } catch {}
    }
    // 清理：仅丢掉真正过期（超 ~7h 授权窗）的条目，无需联网。下课但未过期的保留——仍可复用观看。
    let pruned = 0;
    for (const [k, v] of [...streamCache]) {
      if (v.expiry <= now + 5) { streamCache.delete(k); pruned++; }
    }
    if (pruned) saveStreamCache();
    if (targets.length || pruned)
      console.log(`[autocache] ${new Date().toLocaleTimeString('zh-CN')} 在播命中 ${targets.length} · 新解析/续 ${renewed} · 过期清理 ${pruned} · 缓存共 ${streamCache.size}`);
  } catch { /* 下个周期再来 */ }
  finally { autoCacheBusy = false; }
}

loadStreamCache();
setInterval(autoCacheTick, AUTOCACHE_INTERVAL_MS);
setTimeout(autoCacheTick, 8000); // 启动后 8 秒先跑一次

// ---------- 星标：课程/教室/老师，实时显示是否在播 ----------
const STARS_FILE = path.join(os.homedir(), '.zju_stars.json');
let stars = [];
let starSeq = 0;
function loadStars() {
  try { stars = JSON.parse(fs.readFileSync(STARS_FILE, 'utf8')) || []; } catch { stars = []; }
  for (const s of stars) starSeq = Math.max(starSeq, s.id || 0);
}
function saveStars() { try { fs.writeFileSync(STARS_FILE, JSON.stringify(stars, null, 2)); } catch {} }

function starMatches(star, courses) {
  return courses.filter((c) => {
    if (star.type === 'course') return c.title === star.value;
    if (star.type === 'room') return c.room === star.value;
    if (star.type === 'teacher') return c.teacher === star.value;
    return false;
  });
}
function starView(star) {
  const now = Math.floor(Date.now() / 1000);
  const byKey = new Map();
  // 1) 当前快照里的匹配（正在直播 或 其 cached 标记为真）
  for (const c of starMatches(star, coursesSnapshot.courses)) {
    if (!c.live && !c.cached) continue;
    byKey.set(`${c.course_id}-${c.sub_id}`, {
      course_id: c.course_id, sub_id: c.sub_id, title: c.title, room: c.room,
      teacher: c.teacher, live: c.live, cached: c.cached, quantum_time: c.quantum_time, date: c.date,
    });
  }
  // 2) 缓存里仍有效的（已下课但 7h 内可看）；教室/课程可匹配（缓存条目无老师信息）
  if (star.type === 'room' || star.type === 'course') {
    for (const [k, v] of streamCache) {
      if (v.expiry <= now + 5) continue;
      const ok = star.type === 'room' ? v.room === star.value : v.title === star.value;
      if (!ok || byKey.has(k)) continue;
      const i = k.indexOf('-');
      byKey.set(k, {
        course_id: k.slice(0, i), sub_id: k.slice(i + 1), title: v.title, room: v.room,
        teacher: '', live: false, cached: true, quantum_time: '', date: '',
      });
    }
  }
  const matches = [...byKey.values()].sort((a, b) => (b.live - a.live));
  return { id: star.id, type: star.type, value: star.value, label: star.label || star.value, matches };
}
loadStars();

function classifyMediaUrl(url) {
  const s = String(url || '').trim();
  if (!s) return 'unknown';
  if (/^rtmp:\/\//i.test(s)) return 'rtmp';
  if (/^webrtc:\/\//i.test(s) || /webrtc|rtc|sdp/i.test(s)) return 'webrtc';
  if (/\.m3u8(?:[?#]|$)|format=m3u8|type=m3u8/i.test(s)) return 'hls';
  if (/\.flv(?:[?#]|$)|format=flv|type=flv|http-?flv/i.test(s)) return 'flv';
  try {
    const u = new URL(s);
    if (/^https?:$/i.test(u.protocol) && /mcloudpush\.cmc\.zju\.edu\.cn$/i.test(u.hostname) && /^\/live\//i.test(u.pathname))
      return 'flv';
  } catch {}
  if (/\.mp4(?:[?#]|$)/i.test(s)) return 'mp4';
  if (/\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(s)) return 'image';
  return 'unknown';
}

function extractMediaString(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  const m = /(https?:\/\/[^\s"'<>\\]+|rtmp:\/\/[^\s"'<>\\]+)/i.exec(text);
  const candidate = m ? m[1] : text;
  return classifyMediaUrl(candidate) !== 'unknown' ? candidate : '';
}

function findMediaUrl(value, allowedTypes = new Set(['hls', 'flv', 'rtmp']), seen = new Set()) {
  if (!value) return '';
  if (typeof value === 'string') {
    const url = extractMediaString(value);
    return allowedTypes.has(classifyMediaUrl(url)) ? url : '';
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);

  const priorityKeys = [
    'm3u8', 'hls', 'hls_url', 'hlsUrl',
    'flv', 'flv_url', 'flvUrl',
    'rtmp', 'rtmp_url', 'rtmpUrl',
    'live_url', 'liveUrl', 'stream_url', 'streamUrl',
    'play_url', 'playUrl', 'url', 'src',
  ];
  for (const key of priorityKeys) {
    const hit = findMediaUrl(value[key], allowedTypes, seen);
    if (hit) return hit;
  }
  for (const child of Object.values(value)) {
    const hit = findMediaUrl(child, allowedTypes, seen);
    if (hit) return hit;
  }
  return '';
}

function streamAlt(role, url) {
  const type = classifyMediaUrl(url);
  return url && ['hls', 'flv', 'rtmp'].includes(type) ? { role, url, type } : null;
}

function pushStream(out, seenUrls, key, label, url, opts = {}) {
  const rawRecordUrl = opts.recordUrl || url;
  const rawWatchUrl = opts.watchUrl || url;
  const rawRecordType = classifyMediaUrl(rawRecordUrl);
  const rawWatchType = classifyMediaUrl(rawWatchUrl);
  const recordUrl = ['hls', 'flv', 'rtmp'].includes(rawRecordType) ? rawRecordUrl : '';
  const watchUrl = ['hls', 'flv', 'rtmp'].includes(rawWatchType) ? rawWatchUrl : recordUrl;
  const recordType = recordUrl ? rawRecordType : 'unknown';
  const watchType = watchUrl === rawWatchUrl ? rawWatchType : recordType;
  const primaryUrl = watchUrl || recordUrl;
  const primaryType = watchType !== 'unknown' ? watchType : recordType;
  if (!primaryUrl || !['hls', 'flv', 'rtmp'].includes(primaryType)) {
    // 不能播不等于不存在：北教部分教室只给 webrtc://，
    // 以前这里直接 return，界面表现为「这个机位凭空消失」，查不出原因。
    // 现在记进 dropped，由接口透出，前端会明确说明「只提供 xx，浏览器放不了」。
    if (primaryUrl) {
      if (!out.dropped) out.dropped = [];
      out.dropped.push({ key, label, type: primaryType, host: (() => { try { return new URL(primaryUrl).hostname; } catch { return ''; } })() });
    }
    return;
  }

  const dedupeKey = [key, watchUrl || '', recordUrl || ''].join('|');
  if (seenUrls.has(dedupeKey)) return;
  seenUrls.add(dedupeKey);

  const alternates = [
    streamAlt('watch', watchUrl),
    streamAlt('record', recordUrl),
    ...(opts.alternates || []).map((a) => streamAlt(a.role || 'alternate', a.url)),
  ].filter(Boolean);
  out.push({
    key, label,
    url: primaryUrl,
    type: primaryType,
    watchUrl,
    watchType: primaryType,
    recordUrl: recordUrl || primaryUrl,
    recordType: recordType !== 'unknown' ? recordType : primaryType,
    alternates,
  });
}

function parseSubContent(subContent) {
  try { return typeof subContent === 'string' ? JSON.parse(subContent) : subContent; }
  catch { return null; }
}

function streamKeyFromName(name, type) {
  const text = String(name || '');
  if (/教师/.test(text) || Number(type) === 3) return 'teacher';
  if (/ppt|屏幕|白板|板书/i.test(text) || Number(type) === 2 || Number(type) === 1) return 'screen';
  if (/学生|教室/i.test(text) || Number(type) === 4) return 'student';
  return 'extra';
}

function streamLabelFromName(name, key) {
  const text = String(name || '').trim();
  if (key === 'teacher') return text || '主画面';
  if (key === 'screen') return text || '屏幕/板书';
  if (key === 'student') return text || '学生机位';
  return text || '其他流';
}

function extractMetaStreamRefs(subContent) {
  const sc = parseSubContent(subContent);
  if (!sc || typeof sc !== 'object') return [];
  const refs = [];
  for (const v of Object.values(sc)) {
    if (!v || typeof v !== 'object' || !v.stream_id) continue;
    refs.push({
      stream_id: String(v.stream_id),
      key: streamKeyFromName(v.stream_name, v.stream_type),
      label: streamLabelFromName(v.stream_name, streamKeyFromName(v.stream_name, v.stream_type)),
    });
  }
  return refs;
}

async function fetchMetaStreams(jwt, courseId, subId, subContent) {
  const refs = extractMetaStreamRefs(subContent);
  if (!refs.length) return [];
  const out = [];
  const seenUrls = new Set();
  for (const ref of refs) {
    const before = out.length;
    const qs = new URLSearchParams({
      course_id: String(courseId),
      sub_id: String(subId),
      stream_id: ref.stream_id,
    });
    try {
      const res = await fetch(`https://classroom.zju.edu.cn/courseapi/index.php/v2/meta/getscreenstream?${qs}`, {
        headers: zjuHeaders(jwt),
      });
      const data = await res.json();
      const list = data && data.result && Array.isArray(data.result.data) ? data.result.data : [];
      for (const item of list) {
        const parsedKey = streamKeyFromName(item.stream_name, item.type || item.stream_type);
        const key = parsedKey === 'extra' ? ref.key : parsedKey;
        const label = streamLabelFromName(item.stream_name, key);
        const recordUrl = item.stream_m3u8 || item.stream_play;
        const watchUrl = item.stream_m3u8 || item.stream_play;
        pushStream(out, seenUrls, key, label, watchUrl || recordUrl, {
          watchUrl,
          recordUrl,
          alternates: [
            { role: 'hls', url: item.stream_m3u8 },
            { role: 'play', url: item.stream_play },
          ],
        });
      }
      if (out.length > before) break;
    } catch {}
  }
  return out;
}

function findMediaUrlByKey(value, pattern, allowedTypes = new Set(['hls', 'flv', 'rtmp']), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (pattern.test(key)) {
      const hit = findMediaUrl(child, allowedTypes);
      if (hit) return hit;
    }
    const nested = findMediaUrlByKey(child, pattern, allowedTypes, seen);
    if (nested) return nested;
  }
  return '';
}

function redactUrl(raw) {
  const url = String(raw || '');
  try {
    const u = new URL(url);
    const queryKeys = [...u.searchParams.keys()];
    return {
      type: classifyMediaUrl(url),
      scheme: u.protocol.replace(':', ''),
      host: u.hostname,
      path: u.pathname,
      queryKeys,
    };
  } catch {
    return { type: classifyMediaUrl(url), scheme: url.split(':', 1)[0] || '', host: '', path: '', queryKeys: [] };
  }
}

function collectMediaCandidates(value, pathName = '$', out = [], seen = new Set()) {
  if (!value || out.length >= 120) return out;
  if (typeof value === 'string') {
    const url = extractMediaString(value);
    const type = classifyMediaUrl(url);
    if (type !== 'unknown') out.push({ path: pathName, ...redactUrl(url) });
    return out;
  }
  if (typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    collectMediaCandidates(child, `${pathName}.${key}`, out, seen);
    if (out.length >= 120) break;
  }
  return out;
}

function safeSubContentShape(subContent) {
  let sc;
  try { sc = typeof subContent === 'string' ? JSON.parse(subContent) : subContent; }
  catch { return { parseable: false, topKeys: [], candidates: [], parsedStreams: [] }; }
  if (!sc || typeof sc !== 'object') return { parseable: !!sc, topKeys: [], candidates: [], parsedStreams: [] };
  return {
    parseable: true,
    topKeys: Object.keys(sc).slice(0, 80),
    candidates: collectMediaCandidates(sc),
    metaRefs: extractMetaStreamRefs(sc).map((r) => ({
      key: r.key,
      label: r.label,
      stream_id_len: r.stream_id.length,
    })),
    parsedStreams: extractStreams(sc).map((s) => ({
      key: s.key,
      label: s.label,
      type: s.type,
      url: redactUrl(s.url),
    })),
  };
}

// 从 sub_content 抽取直播各机位。图片快照会进入诊断候选，但不会被当成可录视频流。
function extractStreams(subContent) {
  let sc;
  try { sc = typeof subContent === 'string' ? JSON.parse(subContent) : subContent; }
  catch { return []; }
  if (!sc) return [];
  const out = [];
  const seenUrls = new Set();
  pushStream(out, seenUrls, 'teacher', '主画面',
    findMediaUrl(sc.output || sc.teacher || sc.main)
    || findMediaUrlByKey(sc, /^(output|teacher|main|video)$/i));
  pushStream(out, seenUrls, 'screen', '屏幕/板书',
    findMediaUrl(sc.tts || sc.screen || sc.board || sc.ppt || sc.output_screen)
    || findMediaUrlByKey(sc, /(tts|screen|board|ppt|slide|capture)/i));
  pushStream(out, seenUrls, 'student', '学生机位',
    findMediaUrl(sc.output_student || sc.student || sc.students)
    || findMediaUrlByKey(sc, /(student|audience|classroom)/i));
  return out;
}

// ---------- 播放诊断：只观测、不干预播放策略 ----------
// 记录代理层请求、网页播放事件与候选地址探测结果。
// 三块数据：① 代理层逐请求遥测 ② 网页端播放事件上报 ③ 事前候选探测。
const playLog = [];
let playLogSeq = 0;
let diagBytes = 0;

function diagLog(kind, data = {}) {
  const rec = Object.assign({ t: Date.now(), seq: ++playLogSeq, kind }, data);
  playLog.push(rec);
  if (playLog.length > PLAY_LOG_KEEP) playLog.splice(0, playLog.length - PLAY_LOG_KEEP);
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    if (diagBytes > DIAG_LOG_ROTATE_BYTES) {
      try { fs.renameSync(PLAY_LOG_FILE, path.join(DIAG_DIR, 'play-diag.1.jsonl')); } catch {}
      diagBytes = 0;
    }
    const line = JSON.stringify(rec) + '\n';
    fs.appendFileSync(PLAY_LOG_FILE, line);
    diagBytes += Buffer.byteLength(line);
  } catch {}
  return rec;
}

const PROXY_HEADERS = {
  'user-agent': 'Mozilla/5.0',
  referer: 'https://classroom.zju.edu.cn/',
  origin: 'https://classroom.zju.edu.cn',
};

function hostAllowedForProbe(host) {
  return /\.zju\.edu\.cn$/i.test(host);
}

function redactTarget(u) {
  try {
    const t = new URL(u);
    return { host: t.hostname, path: t.pathname, type: classifyMediaUrl(u) };
  } catch { return { host: '', path: '', type: 'unknown' }; }
}

// 解析 m3u8 里能拿到的过期信息（与 streamCache 同一套规则）
function urlExpiry(url) {
  const m = /auth_key=(\d+)-/.exec(url) || /[?&]txTime=([0-9a-fA-F]+)/.exec(url);
  if (!m) return null;
  let ts = Number(m[1]);
  if (ts < 1.6e9) ts = parseInt(m[1], 16); // txTime 是十六进制
  return Number.isFinite(ts) ? ts : null;
}

// 带超时的取数：读满 maxBytes 就主动断开，避免为了测速把整个分片都拉下来
async function diagFetch(url, { maxBytes = 64 * 1024, timeoutMs = PROXY_TIMEOUT_MS, headers, wantText = false } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const t0 = Date.now();
  const out = { status: 0, contentType: '', ttfbMs: null, ms: 0, bytes: 0, firstByte: null, complete: false, error: '', text: '' };
  try {
    const r = await fetch(url, { headers: headers || PROXY_HEADERS, signal: ac.signal });
    out.status = r.status;
    out.contentType = r.headers.get('content-type') || '';
    out.ttfbMs = Date.now() - t0;
    if (r.body) {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { out.complete = true; break; }
        if (value && value.length) {
          if (out.firstByte === null) out.firstByte = value[0];
          out.bytes += value.length;
          if (wantText) out.text += Buffer.from(value).toString('utf8');
        }
        if (out.bytes >= maxBytes) { try { await reader.cancel(); } catch {} break; }
      }
    } else out.complete = true;
  } catch (e) {
    const msg = String((e && e.message) || e);
    out.error = /abort|timeout/i.test(msg) || (e && e.name === 'AbortError') ? 'timeout' : msg;
  }
  clearTimeout(timer);
  out.ms = Date.now() - t0;
  return out;
}

// 事前探测一个候选地址：它到底能不能播、慢在哪、什么时候过期
async function probeStreamUrl(rawUrl, { deep = true } = {}) {
  const info = redactTarget(rawUrl);
  const res = Object.assign({ url: rawUrl }, info, { hostAllowed: hostAllowedForProbe(info.host) });
  if (!res.hostAllowed) {
    res.verdict = 'host-not-allowed';
    res.note = '域名不在放行白名单内，代理会 403；网页端只会显示「暂无画面」';
    return res;
  }
  const expiry = urlExpiry(rawUrl);
  if (expiry) { res.expiresAt = expiry; res.remainingSec = expiry - Math.floor(Date.now() / 1000); }

  const head = await diagFetch(rawUrl);
  Object.assign(res, {
    status: head.status, contentType: head.contentType, ttfbMs: head.ttfbMs, ms: head.ms,
    bytes: head.bytes, error: head.error,
  });
  const isM3u8 = /mpegurl|m3u8/i.test(head.contentType) || /\.m3u8(\?|$)/i.test(new URL(rawUrl).pathname + new URL(rawUrl).search);
  if (!isM3u8) { res.verdict = head.status === 200 ? 'ok-non-hls' : 'http-' + head.status; return res; }

  // 播放列表：判定 live/vod、统计分片数、抽样两个分片验证
  const list = await diagFetch(rawUrl, { maxBytes: 2 * 1024 * 1024, wantText: true });
  res.playlistBytes = list.bytes;
  if (!list.text) {
    res.verdict = 'playlist-empty';
    res.note = list.error || '播放列表读不到内容';
    return res;
  }
  const lines = list.text.split('\n').map((s) => s.trim()).filter(Boolean);
  res.live = !lines.some((l) => l.includes('EXT-X-ENDLIST'));
  const tgt = lines.find((l) => l.includes('EXT-X-TARGETDURATION'));
  if (tgt) res.targetDuration = Number(tgt.split(':')[1]);
  const seq = lines.find((l) => l.includes('EXT-X-MEDIA-SEQUENCE'));
  if (seq) res.mediaSequence = Number(seq.split(':')[1]);
  const segs = lines.filter((l) => !l.startsWith('#'));
  res.segmentCount = segs.length;
  res.lastSegment = segs.length ? path.basename(new URL(segs[segs.length - 1], rawUrl).pathname) : '';

  if (deep && segs.length) {
    const picks = segs.length > 1 ? [segs[0], segs[Math.floor(segs.length / 2)]] : [segs[0]];
    res.segmentSamples = [];
    for (const s of picks) {
      const abs = new URL(s, rawUrl).href;
      const r = await diagFetch(abs, { maxBytes: 4 * 1024 * 1024 });
      res.segmentSamples.push({
        name: path.basename(new URL(abs).pathname),
        status: r.status, ttfbMs: r.ttfbMs, ms: r.ms, bytes: r.bytes,
        complete: r.complete, sync: r.firstByte === 0x47 ? 'TS(0x47)' : '0x' + (r.firstByte ?? 0).toString(16),
        error: r.error,
      });
    }
    const bad = res.segmentSamples.filter((x) => x.status !== 200 || x.error);
    const slow = res.segmentSamples.filter((x) => (x.ttfbMs || 0) > 3000);
    res.verdict = bad.length ? ('segment-http-' + bad[0].status) : slow.length ? 'segment-slow' : (list.status === 200 ? 'ok' : 'http-' + list.status);
  } else {
    res.verdict = list.status === 200 ? 'ok' : 'http-' + list.status;
  }
  return res;
}

async function diagFetchText(url) {
  const r = await diagFetch(url, { maxBytes: 2 * 1024 * 1024, wantText: true });
  return r.text;
}

// 播放列表是否在推进（停滞的直播流会让播放器反复读同一个分片）
async function probePlaylistAdvance(url, targetDurationSec) {
  const parse = (t) => {
    const seqM = /EXT-X-MEDIA-SEQUENCE:\s*(\d+)/.exec(t);
    const segs = t.split('\n').map((s) => s.trim()).filter((l) => l && !l.startsWith('#'));
    return { seq: seqM ? Number(seqM[1]) : null, last: segs.length ? segs[segs.length - 1] : '', count: segs.length };
  };
  const a = parse(await diagFetchText(url));
  // 列表很短时（只有两三个分片）3 秒窗口可能刚好没跨过一次滚动，会误报「停滞」——
  // 已知情况：某路报「停滞」，而它的分片（200 / 415KB / 76ms）完全健康。
  // 所以等 2 个目标时长再比，并优先比对 media sequence。
  const waitMs = Math.max(3000, Math.round((Number(targetDurationSec) || 3) * 2000) + 1000);
  await new Promise((r) => setTimeout(r, waitMs));
  const b = parse(await diagFetchText(url));
  const advancing = (a.seq !== null && b.seq !== null) ? b.seq > a.seq : a.last !== b.last;
  return {
    waitMs, seqBefore: a.seq, seqAfter: b.seq, beforeCount: a.count, afterCount: b.count,
    lastBefore: a.last, lastAfter: b.last, advancing,
  };
}

let lastSessionProbe = null;

// 报告/日志里不写完整地址（query 带签名），只留 host/path 与判定结果
function redactProbeForLog(p) {
  return {
    key: p.key, label: p.label, role: p.role, host: p.host, path: p.path, type: p.type,
    verdict: p.verdict, status: p.status, ttfbMs: p.ttfbMs, live: p.live,
    segmentCount: p.segmentCount, remainingSec: p.remainingSec,
    segmentSamples: p.segmentSamples, advance: p.advance,
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i];
}

function countBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = String(keyFn(x));
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// 汇总一份可读报告。只陈述数据支持的结论，不做因果断言。
function buildDiagReport() {
  const events = playLog;
  const byKind = countBy(events, (e) => e.kind);
  const proxied = events.filter((e) => e.kind === 'proxy-body');
  const incomplete = proxied.filter((e) => e.how !== 'complete');
  const m3u8s = events.filter((e) => e.kind === 'proxy-m3u8');
  const proxyErr = events.filter((e) => e.kind === 'proxy-error');
  const upstreamBad = events.filter((e) => e.kind === 'proxy-upstream');
  const rejects = events.filter((e) => e.kind === 'proxy-reject');
  const clients = events.filter((e) => e.kind === 'client');
  const clientByEvent = countBy(clients, (e) => e.event || 'unknown');

  const ttfb = proxied.map((e) => e.ttfbMs).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const stalls = clients.filter((e) => e.event === 'stall');
  const hlsErrs = clients.filter((e) => e.event === 'hls-error');
  const flvErrs = clients.filter((e) => e.event === 'flv-error');
  const libErrs = clients.filter((e) => e.event === 'lib-load' && e.ok === false);
  const abResults = clients.filter((e) => e.event === 'ab-result');

  const L = [];
  const P = (s) => L.push(s);
  P('# 播放诊断报告');
  P('');
  P(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  P(`- 服务：127.0.0.1:${PORT}　·　代理上游超时：${PROXY_TIMEOUT_MS} ms`);
  P(`- 事件总数（本次进程启动以来）：${events.length}　·　落盘文件：${PLAY_LOG_FILE}`);
  P('');
  P('## 1. 事件汇总');
  P('');
  if (!byKind.length) P('（暂无数据：需要先点开一路流播放一会儿）');
  else {
    P('| 事件 | 条数 |');
    P('| --- | --- |');
    for (const [k, n] of byKind) P(`| ${k} | ${n} |`);
  }
  P('');
  P('## 2. 代理层（服务端 → 上游）');
  P('');
  P(`- 播放列表请求：${m3u8s.length} 次（其中直播类型 ${m3u8s.filter((e) => e.live).length} 次）`);
  P(`- 分片转发：${proxied.length} 次`);
  P(`- 上游非 200：${upstreamBad.length} 次${upstreamBad.length ? '（状态码 ' + countBy(upstreamBad, (e) => e.status).map(([k, n]) => `${k}×${n}`).join(', ') + '）' : ''}`);
  P(`- 域名被白名单拒绝：${rejects.length} 次${rejects.length ? '（' + countBy(rejects, (e) => e.host).map(([k, n]) => `${k}×${n}`).join(', ') + '）' : ''}`);
  P(`- 连接/读取错误：${proxyErr.length} 次${proxyErr.length ? '（超时 ' + proxyErr.filter((e) => e.timeout).length + ' 次）' : ''}`);
  P(`- 分片转发未完整结束：${incomplete.length} 次${proxied.length ? `（占 ${(incomplete.length * 100 / proxied.length).toFixed(1)}%）` : ''}${incomplete.length ? '，how=' + countBy(incomplete, (e) => e.how || e.phase || 'error').map(([k, n]) => `${k}×${n}`).join(', ') : ''}`);
  P(`- 分片首字节延迟：p50 ${quantile(ttfb, 0.5) ?? '-'} ms　p90 ${quantile(ttfb, 0.9) ?? '-'} ms　max ${ttfb.length ? ttfb[ttfb.length - 1] : '-'} ms`);
  P('');
  P('## 3. 网页端播放');
  P('');
  if (!clients.length) P('（暂无数据）');
  else {
    P(`- 客户端事件：${countBy(clients, (e) => e.event || 'unknown').map(([k, n]) => `${k}×${n}`).join('　')}`);
    const libs = countBy(clients.filter((e) => e.event === 'play-start'), (e) => e.lib || '?');
    if (libs.length) P(`- 实际播放路径：${libs.map(([k, n]) => `${k}×${n}`).join('　')}`);
    P(`- 播放器库加载失败：${libErrs.length} 次${libErrs.length ? '（' + libErrs.map((e) => e.lib).join(', ') + '）' : ''}`);
    P(`- hls.js 错误：${hlsErrs.length} 次${hlsErrs.length ? '，明细 ' + countBy(hlsErrs, (e) => e.details || '?').map(([k, n]) => `${k}×${n}`).join(', ') : ''}`);
    P(`- flv.js 错误：${flvErrs.length} 次${flvErrs.length ? '，明细 ' + countBy(flvErrs, (e) => e.details || '?').map(([k, n]) => `${k}×${n}`).join(', ') : ''}`);
    const rec = clients.filter((e) => e.event === 'stall-recovered').map((e) => Number(e.recoverSec)).filter(Number.isFinite);
    P(`- 卡顿（画面不再前进）：${stalls.length} 次${rec.length ? `，已恢复的平均耗时 ${(rec.reduce((a, b) => a + b, 0) / rec.length).toFixed(1)} 秒` : ''}`);
    // 直连时没有代理层遥测，靠客户端每分钟汇总的分片数据
    const stats = clients.filter((e) => e.event === 'play-stats');
    if (stats.length) {
      const avg = stats.map((e) => Number(e.avgFragMs)).filter(Number.isFinite).sort((x, y) => x - y);
      const mx = stats.map((e) => Number(e.maxFragMs)).filter(Number.isFinite);
      const fr = stats.reduce((a, e) => a + (Number(e.fragments) || 0), 0);
      P(`- 客户端分片汇总：${stats.length} 次上报 / 共 ${fr} 个分片；每段平均分片耗时 p50 ${quantile(avg, 0.5) ?? '-'} ms、p90 ${quantile(avg, 0.9) ?? '-'} ms；单分片最大 ${mx.length ? Math.max.apply(null, mx) : '-'} ms`);
      const fb = clients.filter((e) => e.event === 'proxy-fallback');
      if (fb.length) P(`- 直连失败退回代理：${fb.length} 次（${countBy(fb, (e) => e.details || '?').map(([k, n]) => `${k}×${n}`).join(', ')}）`);
      const rs = clients.filter((e) => e.event === 'live-edge-resync');
      if (rs.length) P(`- 直播空档后跳到最新位置：${rs.length} 次`);
    }
  }
  P('');
  P('## 4. 候选探测（最近一次 /api/probe/session）');
  P('');
  if (!lastSessionProbe) P('（尚未做过候选探测）');
  else {
    P(`- 场次 course_id=${lastSessionProbe.courseId} sub_id=${lastSessionProbe.subId}　来源=${lastSessionProbe.source}`);
    P('');
    P('| 机位 | 角色 | 类型 | 判定 | HTTP | 首字节(ms) | 分片数 | 直播 | 剩余有效期 |');
    P('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const p of lastSessionProbe.probes) {
      const rem = Number.isFinite(p.remainingSec) ? Math.round(p.remainingSec / 60) + ' 分' : '-';
      P(`| ${p.label || p.key || ''} | ${p.role || ''} | ${p.type || ''} | ${p.verdict || ''} | ${p.status ?? '-'} | ${p.ttfbMs ?? '-'} | ${p.segmentCount ?? '-'} | ${p.live ? '是' : '否'} | ${rem} |`);
    }
    const adv = lastSessionProbe.probes.filter((p) => p.advance);
    if (adv.length) {
      P('');
      for (const p of adv) P(`- ${p.label || p.key} 播放列表推进：${p.advance.advancing ? '在推进' : '**停滞**'}（等待 ${p.advance.waitMs}ms，分片数 ${p.advance.beforeCount}→${p.advance.afterCount}）`);
    }
  }
  P('');
  P('## 5. 直连 vs 代理（网页端）');
  P('');
  if (!abResults.length) P('（尚未做过对比测试）');
  else {
    P('| 模式 | 分片数 | 卡顿 | 错误 | 平均分片耗时 | 首帧耗时 |');
    P('| --- | --- | --- | --- | --- | --- |');
    for (const r of abResults) {
      P(`| ${r.mode} | ${r.fragments ?? '-'} | ${r.stalls ?? '-'} | ${r.errors ?? '-'} | ${r.avgFragMs ?? '-'} ms | ${r.firstFrameMs ?? '-'} ms |`);
    }
  }
  P('');
  P('## 6. 数据支持的判断');
  P('');
  const notes = [];
  const badUpstream = upstreamBad.length + rejects.length;
  if (rejects.length) notes.push('代理层出现域名被拒：该流不在放行白名单内，网页端只会显示「暂无画面」，与「老师没投屏」是两回事。');
  if (upstreamBad) notes.push('上游返回非 200 占一定比例：属于上游本身没有内容（未投屏/未开播）或地址过期，不是浏览器或代理的问题。');
  if (proxied.length && incomplete.length / proxied.length > 0.05) notes.push('分片转发未完整结束的比例偏高：上游中途断流或客户端主动断开，代理层需要补超时与重连策略。这条是「反复读同一片段」的直接嫌疑。');
  if (hlsErrs.some((e) => /bufferStalled|levelLoadError|fragLoadError/i.test(String(e.details)))) notes.push('hls.js 报分片加载/缓冲类错误：与上游分片慢或偶发 404 吻合（录制侧靠 ffmpeg 的 -reconnect 掩盖了同样的问题）。');
  if (libErrs.length) notes.push('播放器库（hls.js/flv.js）从 CDN 加载失败：校园网可达性问题，把库打包进 public/ 即可彻底消除。');
  const nativeBad = clients.filter((e) => e.event === 'native-no-data' || e.event === 'native-error');
  if (nativeBad.length) notes.push('原生 HLS 分支播不出来（' + nativeBad.length + ' 次）：浏览器 canPlayType 自称支持 HLS，于是 hls.js 根本没被加载，而 Chromium 桌面其实不实现 HLS → 这条分支应当只作兜底，优先走 hls.js。');
  const statsArr = clients.filter((e) => e.event === 'play-stats').map((e) => Number(e.avgFragMs)).filter(Number.isFinite);
  if (statsArr.length) {
    const med = quantile(statsArr.slice().sort((a, b) => a - b), 0.5);
    if (med !== null && med > 1500) notes.push(`客户端平均分片耗时中位数 ${med} ms，偏高（正常在数百毫秒级）：优先怀疑上游 CDN 到本机的带宽/链路，而不是播放器。`);
  }
  const pfb = clients.filter((e) => e.event === 'proxy-fallback');
  if (pfb.length) notes.push('出现直连失败退回代理：说明浏览器直连上游被跨域或网络策略挡住，播放路径应保持"代理优先"。');
  const resyncs = clients.filter((e) => e.event === 'live-edge-resync');
  if (resyncs.length) notes.push(`出现「直播空档」自愈 ${resyncs.length} 次：上游中途断过流，播放器掉出直播窗口后一直重试已经 404 的分片 —— 这就是「卡住 / 反复播同一片段」的机制，已自动跳到直播边缘恢复。`);
  const frag404 = upstreamBad.filter((e) => e.status === 404);
  if (frag404.length) notes.push(`代理层看到 ${frag404.length} 次上游 404（多为分片）：上游直播流存在空档或播放器已落后于直播窗口，浏览器侧没有录制侧那样的 -reconnect 兜底。`);
  if (stalls.length && !incomplete.length && !upstreamBad) notes.push('有卡顿但代理层看不出异常：需要看第 5 节的直连/代理对比，差别在浏览器侧。');
  if (abResults.length >= 2) {
    const d = abResults.find((r) => r.mode === 'direct');
    const p = abResults.find((r) => r.mode === 'proxy');
    if (d && p && (p.stalls > d.stalls || p.avgFragMs > d.avgFragMs * 1.5)) notes.push('直连明显优于经代理：播放路径应改为直连优先、代理兜底。');
    else if (d && p && d.errors > p.errors) notes.push('经代理反而更稳：保留代理为默认路径。');
  }
  if (!notes.length) notes.push(badUpstream || proxied.length ? '样本量还不足以判断，建议在有课在播时完整播放几分钟后再生成报告。' : '暂无数据。');
  for (const n of notes) P(`- ${n}`);
  P('');
  P('## 附：原始事件（最近 200 条）');
  P('');
  P('```json');
  P(JSON.stringify(events.slice(-200), null, 1));
  P('```');

  const md = L.join('\n');
  let file = '';
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    file = path.join(DIAG_DIR, `play-diag-${stamp}.md`);
    fs.writeFileSync(file, md, 'utf8');
    fs.writeFileSync(file.replace(/\.md$/, '.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), proxyTimeoutMs: PROXY_TIMEOUT_MS,
      byKind, upstreamBad, rejects, incomplete: incomplete.length,
      lastSessionProbe, abResults, events,
    }, null, 1), 'utf8');
  } catch (e) { file = '写入失败: ' + e.message; }
  return { markdown: md, file, dir: DIAG_DIR, eventCount: events.length };
}

// ---------- HLS 代理（给网页内嵌播放器用，绕过跨域）----------
// 把 m3u8 里的子播放列表/分片地址都改写成继续走本代理
function rewriteM3u8(text, baseUrl) {
  return text.split('\n').map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      // 处理 #EXT-X-KEY / #EXT-X-MAP 里的 URI="..."
      return line.replace(/URI="([^"]+)"/g, (_, uri) =>
        `URI="/api/hls?u=${encodeURIComponent(new URL(uri, baseUrl).href)}"`);
    }
    return `/api/hls?u=${encodeURIComponent(new URL(t, baseUrl).href)}`;
  }).join('\n');
}

async function proxyHls(res, target) {
  let tu;
  try { tu = new URL(target); } catch { res.writeHead(400); return res.end('bad url'); }
  const base = { host: tu.hostname, path: tu.pathname };
  // 仅允许校内流媒体域名，避免变成开放代理。
  if (!/\.zju\.edu\.cn$/i.test(tu.hostname)) {
    diagLog('proxy-reject', Object.assign({ reason: 'host not allowed' }, base));
    res.writeHead(403); return res.end('host not allowed');
  }

  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), PROXY_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(target, { headers: PROXY_HEADERS, signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    const msg = String((e && e.message) || e);
    const timeout = /abort|timeout/i.test(msg) || (e && e.name === 'AbortError');
    diagLog('proxy-error', Object.assign({ phase: 'connect', ms: Date.now() - t0, timeout, error: msg }, base));
    if (!res.headersSent) { res.writeHead(timeout ? 504 : 502); res.end('upstream ' + (timeout ? 'timeout' : 'error')); }
    return;
  }
  const ttfbMs = Date.now() - t0;
  if (!upstream.ok) {
    clearTimeout(timer);
    diagLog('proxy-upstream', Object.assign({ status: upstream.status, ttfbMs }, base));
    res.writeHead(upstream.status); return res.end('upstream ' + upstream.status);
  }
  const ct = upstream.headers.get('content-type') || '';
  const isM3u8 = /mpegurl|m3u8/i.test(ct) || /\.m3u8(\?|$)/i.test(tu.pathname + tu.search);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-store');
  if (isM3u8) {
    try {
      const text = await upstream.text();
      clearTimeout(timer);
      // 记下播放列表序号与末段名：这样才能区分「上游给了一份不推进的陈旧列表」和
      // 「播放器自己掉出了直播窗口」—— 两者都会表现为分片 404。
      const seqM = /EXT-X-MEDIA-SEQUENCE:\s*(\d+)/.exec(text);
      const segs = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      diagLog('proxy-m3u8', Object.assign({
        status: 200, ttfbMs, ms: Date.now() - t0, bytes: Buffer.byteLength(text),
        live: !/EXT-X-ENDLIST/.test(text),
        mediaSeq: seqM ? Number(seqM[1]) : null,
        segCount: segs.length,
        lastSeg: segs.length ? path.basename(new URL(segs[segs.length - 1], target).pathname) : '',
      }, base));
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl; charset=utf-8' });
      res.end(rewriteM3u8(text, target));
    } catch (e) {
      clearTimeout(timer);
      diagLog('proxy-error', Object.assign({ phase: 'm3u8', error: String((e && e.message) || e) }, base));
      if (!res.headersSent) { res.writeHead(502); res.end('upstream read error'); }
    }
    return;
  }

  // 分片等二进制：逐块转发并统计字节数。上游中途断流会在这里留下记录 ——
  // 将此路径记入日志，用于定位重复分片与播放停顿。
  let bytes = 0;
  const body = Readable.fromWeb(upstream.body);
  const done = (how) => {
    clearTimeout(timer);
    diagLog('proxy-body', Object.assign({ status: 200, ttfbMs, ms: Date.now() - t0, bytes, how }, base));
  };
  body.on('data', (c) => { bytes += c.length; });
  body.on('end', () => done('complete'));
  body.on('error', (e) => {
    diagLog('proxy-error', Object.assign({ phase: 'body', bytes, error: String((e && e.message) || e) }, base));
    try { res.destroy(); } catch {}
  });
  res.on('error', () => { try { body.destroy(); } catch {} });
  res.on('close', () => { if (!res.writableEnded) { try { body.destroy(); } catch {} } });
  res.writeHead(200, { 'content-type': ct || 'video/mp2t' });
  body.pipe(res);
}

// ---------- 录制中转：让 ffmpeg 只跟本机说话 ----------
// 已知某些教室的流会让 ffmpeg 在开流阶段直接失败（TLS: IO error -138 或 5XX），
// 而同一地址经本服务（Node 的 TLS 栈，与网页/代理那条已可用的路一致）能取到。
// 所以录制改为：本服务去上游取，ffmpeg 只读 http://127.0.0.1:PORT/relay?u=...，
// 录制与网页从此共用同一套网络栈。取不到时仍会退回直连上游（见 spawnAttempt）。
// ffmpeg 的 HLS 解复用器要求分片地址带可识别的扩展名（allowed_segment_extensions，
// 否则报 "is not in allowed_segment_extensions" 直接拒绝）。所以把上游文件名的
// 扩展名保留在路径里：/relay/<name>.ts?u=... ，而不是 /relay?u=...
// ---------- ASR sidecar：可选的本地实时语音识别（独立进程）----------
//
// 安全边界：浏览器只能提交服务器生成的 opaque streamRef，不能传 URL /
// 可执行路径 / 参数；worker 固定路径固定参数，不联网、不读 JWT。
// 关键设计：**ffmpeg 与 worker 都不直接面对 CDN** —— ffmpeg 走本机 /relay/（复用录制
// 那条已验证可用的 Node 网络栈），ASR 崩了也绝不会影响录制（另一条独立链路）。
const ASR = {
  dir: path.join(__dirname, '..', 'asr'),
  modelsRoot: process.env.ZJU_ASR_MODELS || path.join(__dirname, '..', 'runtime', 'asr', 'models'),
  python: process.env.ZJU_ASR_PYTHON
    || path.join(__dirname, '..', 'runtime', 'asr', 'venv', 'Scripts', 'python.exe'),
  worker: process.env.ZJU_ASR_WORKER || path.join(__dirname, '..', 'asr', 'worker.py'),
  profile: process.env.ZJU_ASR_PROFILE || 'streaming-zh',
  direct: process.env.ZJU_ASR_DIRECT === '1',   // 1 = 不给 ffmpeg 走 /relay，直连上游
  maxLine: 64 * 1024,          // 协议规定一行 <= 64KiB（protocol.md §1）
  eventKeep: 256,              // 每个 session 给断线重连保留的事件条数
  stderrKeep: 256 * 1024,      // worker stderr 环形缓冲上限
  maxRestart: 1,               // worker 崩溃最多自动重启一次
  hungMs: Number(process.env.ZJU_ASR_HUNG_MS || 10000),
  maxSessions: 1,              // MVP 只允许一路
};

// 浏览器只拿到这个不透明 token；真实 URL 留在服务端内存里
const streamRefs = new Map();          // ref -> {url, courseId, subId, kind, label, expiry, title}
const STREAM_REF_TTL_SEC = 2 * 3600;

function makeStreamRef(stream, meta) {
  const ref = 'sr_' + crypto.randomBytes(16).toString('hex');
  const nowSec = Math.floor(Date.now() / 1000);
  streamRefs.set(ref, {
    url: stream.recordUrl || stream.url,
    courseId: String(meta.course_id || ''),
    subId: String(meta.sub_id || ''),
    kind: stream.key || '',
    label: stream.label || '',
    title: meta.title || '',
    room: meta.room || '',
    expiry: Math.min(meta.expiry || nowSec + STREAM_REF_TTL_SEC, nowSec + STREAM_REF_TTL_SEC),
  });
  // 顺手清理过期的，避免无限增长
  for (const [k, v] of streamRefs) if (v.expiry <= nowSec) streamRefs.delete(k);
  return ref;
}

function getStreamRef(ref) {
  const rec = streamRefs.get(String(ref || ''));
  if (!rec) return null;
  if (rec.expiry <= Math.floor(Date.now() / 1000)) { streamRefs.delete(ref); return null; }
  return rec;
}

// 模型是否就位（读清单，不猜文件名）
function asrModelFiles() {
  const manifest = path.join(ASR.dir, 'models', 'manifest.json');
  let entry = null;
  try {
    const obj = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    entry = (obj.profiles || {})[ASR.profile] || null;
  } catch (e) {
    return { ok: false, reason: '读不到模型清单 asr/models/manifest.json：' + e.message, missing: [] };
  }
  if (!entry) return { ok: false, reason: `清单里没有 profile ${ASR.profile}`, missing: [] };
  const dir = path.join(ASR.modelsRoot, entry.dir || ASR.profile);
  const missing = [];
  for (const name of Object.keys(entry.files || {})) {
    if (!fs.existsSync(path.join(dir, name))) missing.push(name);
  }
  if (missing.length) return { ok: false, reason: `模型文件缺失（${dir}）：${missing.join(', ')}`, missing, dir };
  return { ok: true, dir, missing: [] };
}

// 可用性：一次性把三样东西都查清楚，界面直接照实显示（不要只说"不可用"）
let asrAvailCache = { at: 0, value: null };
function asrAvailability(fresh = false) {
  if (!fresh && asrAvailCache.value && Date.now() - asrAvailCache.at < 10000) return asrAvailCache.value;
  const problems = [];
  if (!fs.existsSync(ASR.python)) problems.push(`缺 Python venv：${ASR.python}（跑 asr\\scripts\\setup-windows.ps1）`);
  if (!fs.existsSync(ASR.worker)) problems.push(`缺 worker：${ASR.worker}`);
  const m = asrModelFiles();
  if (!m.ok) problems.push(m.reason);
  const active = [...asrSessions.values()].find((s) => s.status !== 'stopped' && s.status !== 'error');
  const value = {
    available: problems.length === 0,
    problems,
    profile: ASR.profile,
    python: ASR.python,
    modelDir: m.dir || null,
    viaRelay: !ASR.direct,
    activeSessionId: active ? active.id : null,
  };
  asrAvailCache = { at: Date.now(), value };
  return value;
}

const asrSessions = new Map();
let asrSeq = 0;

function asrEvent(session, type, data = {}) {
  const ev = Object.assign({ seq: ++session.eventSeq, t: Date.now(), type }, data);
  session.events.push(ev);
  if (session.events.length > ASR.eventKeep) session.events.splice(0, session.events.length - ASR.eventKeep);
  pushSse(session, ev);
  return ev;
}

// —— SSE：给浏览器推 transcript。每 15 秒一个注释心跳——
function pushSse(session, ev) {
  const payload = 'id: ' + ev.seq + '\ndata: ' + JSON.stringify(ev) + '\n\n';
  for (const res of session.clients) {
    try { res.write(payload); } catch { session.clients.delete(res); }
  }
}

function attachSse(session, res, lastEventId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  // 断线重连：把最近事件补上（Last-Event-ID 之后的）
  const since = Number(lastEventId || 0);
  for (const ev of session.events) if (ev.seq > since) res.write('id: ' + ev.seq + '\ndata: ' + JSON.stringify(ev) + '\n\n');
  session.clients.add(res);
  const beat = setInterval(() => {
    try { res.write(': ping ' + Date.now() + '\n\n'); } catch {}
  }, 15000);
  const done = () => { clearInterval(beat); session.clients.delete(res); };
  res.on('close', done);
  res.on('error', done);
}

function asrSessionView(s) {
  return {
    id: s.id, status: s.status, profile: s.profile,
    course: s.course, room: s.room, label: s.label, kind: s.kind,
    startedAt: s.startedAt, endedAt: s.endedAt || null,
    durationSec: Math.floor(((s.endedAt || Date.now()) - s.startedAt) / 1000),
    audioMs: Math.round(s.audioMs || 0),
    partial: s.partial,
    finals: s.finals,
    error: s.error || '',
    restarts: s.restarts || 0,
    stats: { rtf: s.rtf, rssMb: s.rssMb, bytesIn: s.bytesIn, events: s.eventSeq },
  };
}

// worker 的一行 JSONL：严格校验，坏行只记不崩
function handleWorkerLine(session, line) {
  let ev;
  try { ev = JSON.parse(line); } catch (e) {
    session.protocolErrors++;
    diagLog('asr-protocol-error', { session: session.id, why: 'bad-json', bytes: line.length });
    return;
  }
  if (!ev || typeof ev !== 'object') return;
  if (ev.v !== 1) {
    session.protocolErrors++;
    diagLog('asr-protocol-error', { session: session.id, why: 'bad-version', v: ev.v });
    return;
  }
  switch (ev.type) {
    case 'ready':
      session.status = 'running';
      session.model = ev.model || '';
      asrEvent(session, 'ready', { model: ev.model, sampleRate: ev.sampleRate });
      diagLog('asr-ready', { session: session.id, profile: session.profile, model: ev.model });
      break;
    case 'partial':
      if (typeof ev.seq === 'number') {
        if (ev.seq <= session.lastSeq) { session.protocolErrors++; return; }  // 重复/倒序：丢弃
        session.lastSeq = ev.seq;
      }
      session.partial = String(ev.text == null ? '' : ev.text);
      session.audioMs = Number(ev.audioMs) || session.audioMs;
      asrEvent(session, 'partial', { text: session.partial, audioMs: Math.round(session.audioMs) });
      break;
    case 'final': {
      if (typeof ev.seq === 'number') {
        if (ev.seq <= session.lastSeq) { session.protocolErrors++; return; }
        session.lastSeq = ev.seq;
      }
      const text = String(ev.text == null ? '' : ev.text);
      session.partial = '';
      if (text.trim()) {
        session.finals.push({ segment: session.finals.length + 1, text, t0Ms: Number(ev.t0Ms) || 0, t1Ms: Number(ev.t1Ms) || 0 });
        // transcript 只在内存里，默认不落盘；上限防止无限增长
        if (session.finals.length > 10000) session.finals.splice(0, session.finals.length - 10000);
      }
      session.audioMs = Number(ev.t1Ms) || session.audioMs;
      asrEvent(session, 'final', { text, t0Ms: Number(ev.t0Ms) || 0, t1Ms: Number(ev.t1Ms) || 0 });
      break;
    }
    case 'metric':
      session.rtf = Number(ev.rtf);
      session.rssMb = Number(ev.rssMb);
      session.lastBeatAt = Date.now();
      asrEvent(session, 'metric', { rtf: session.rtf, rssMb: session.rssMb, audioMs: Math.round(Number(ev.audioMs) || 0) });
      break;
    case 'error':
      session.error = (ev.code || 'ERROR') + (ev.message ? '：' + ev.message : '');
      asrEvent(session, 'error', { code: ev.code, message: ev.message, recoverable: !!ev.recoverable });
      diagLog('asr-error', { session: session.id, code: ev.code, message: String(ev.message || '').slice(0, 200) });
      break;
    case 'stopped':
      session.stopReason = ev.reason || 'eof';
      session.audioMs = Number(ev.audioMs) || session.audioMs;
      asrEvent(session, 'stopped', { reason: session.stopReason, segments: ev.segments });
      break;
    default:
      session.protocolErrors++;
      diagLog('asr-protocol-error', { session: session.id, why: 'unknown-type', type: String(ev.type).slice(0, 40) });
  }
}

function spawnAsrWorker(session) {
  const args = [
    '-I', '-u', ASR.worker,
    '--profile', ASR.profile,
    '--sample-rate', '16000',
    '--input-format', 'f32le',
    '--metric-ms', '5000',
  ];
  const proc = spawn(ASR.python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  session.worker = proc;
  session.status = 'loading';

  // stdout：手动按行切，显式限长。**不用 readline** —— readline 不设上限，
  // 一个坏掉的 worker 狂发超长行就能把内存吃光的"无界缓冲"红线）。
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    if (buf.length > ASR.maxLine * 4) {           // 连行尾都没有：判定协议崩坏
      session.protocolErrors++;
      diagLog('asr-protocol-error', { session: session.id, why: 'no-newline-overflow', bytes: buf.length });
      buf = '';
      return;
    }
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      if (line.length > ASR.maxLine) {
        session.protocolErrors++;
        diagLog('asr-protocol-error', { session: session.id, why: 'line-too-long', bytes: line.length });
        continue;
      }
      // 解析器自己出 bug 也不能把服务带走（wrap 住，只记不改流程）
      try { handleWorkerLine(session, line); }
      catch (e) {
        session.protocolErrors++;
        diagLog('asr-protocol-error', { session: session.id, why: 'handler-threw', message: String(e && e.message).slice(0, 200) });
      }
    }
  });
  proc.stderr.on('data', (chunk) => {
    session.stderrBytes += chunk.length;
    session.stderrTail += chunk.toString('utf8');
    if (session.stderrTail.length > ASR.stderrKeep) {
      session.stderrTail = session.stderrTail.slice(-ASR.stderrKeep);   // 环形，防刷爆内存
    }
  });
  proc.on('error', (e) => {
    session.error = 'worker 启动失败：' + e.message;
    session.status = 'error';
    asrEvent(session, 'error', { code: 'SPAWN_FAILED', message: e.message });
    diagLog('asr-error', { session: session.id, code: 'SPAWN_FAILED', message: e.message });
  });
  proc.on('exit', (code, signal) => {
    clearInterval(session.hungTimer);
    const wasStopping = session.status === 'stopping';
    if (session.ffmpeg) { try { session.ffmpeg.kill(); } catch {} }
    // 非正常退出：最多自动重启一次。重启只重开 worker，ffmpeg 已经死了就一起
    // 收尾 —— 任何情况下都不抛到主流程，录制/播放不受影响。
    if (!wasStopping && session.status !== 'stopped' && (session.restarts || 0) < ASR.maxRestart
        && code !== 0) {
      session.restarts = (session.restarts || 0) + 1;
      session.error = `worker 异常退出（code=${code}），已自动重启 1 次`;
      asrEvent(session, 'restart', { code, restarts: session.restarts });
      diagLog('asr-restart', { session: session.id, code, signal });
      startAsrPipeline(session).catch(() => {});
      return;
    }
    session.status = wasStopping ? 'stopped' : (code === 0 ? 'stopped' : 'error');
    session.endedAt = Date.now();
    if (!session.error && code !== 0) session.error = 'worker 退出码 ' + code;
    // 强制停止（卡死看门狗）已经发过 closed 了，不要重复发 —— 前端是按事件驱动的，
    // 同一个会话收到两次 closed 会让状态机来回跳。
    if (!session.closedEmitted) {
      session.closedEmitted = true;
      asrEvent(session, 'closed', { status: session.status, code });
    }
    diagLog('asr-worker-exit', { session: session.id, code, signal, status: session.status, segments: session.finals.length });
    asrAvailCache.value = null;
  });
  return proc;
}

// 音频输入：ffmpeg 只取音轨、转 16k 单声道 f32le 到 stdout，再 pipe 给 worker。
// 走本机 /relay/ 的理由与录制一致：ffmpeg 自己的 TLS/HTTP
// 实现在某些教室会开流失败，而 Node 那套网络栈是验证过可用的。
function spawnAsrFfmpeg(session) {
  const input = ASR.direct ? session.url : relayUrl(session.url);
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'warning',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-rw_timeout', '15000000',
    '-headers', 'Referer: https://classroom.zju.edu.cn/\r\nOrigin: https://classroom.zju.edu.cn\r\nUser-Agent: Mozilla/5.0\r\n',
    '-i', input,
    '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1',
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  session.ffmpeg = proc;
  session.inputVia = ASR.direct ? 'direct' : 'relay';

  proc.stdout.on('data', (c) => { session.bytesIn += c.length; });
  let errTail = '';
  proc.stderr.on('data', (c) => {
    errTail = (errTail + c.toString('utf8')).slice(-4000);
    session.ffmpegStderr = errTail;
  });
  proc.on('error', (e) => {
    session.error = 'ffmpeg 启动失败：' + e.message;
    asrEvent(session, 'error', { code: 'FFMPEG_SPAWN_FAILED', message: e.message });
  });
  proc.on('exit', (code, signal) => {
    diagLog('asr-ffmpeg-exit', { session: session.id, code, signal, bytesIn: session.bytesIn });
    // ffmpeg 结束（正常收尾或上游断流）→ 关掉 worker 的 stdin，让 worker 走 EOF 收尾。
    // **这是 Windows 上唯一可靠的优雅停止路径**：Node 的 kill() 是 TerminateProcess，
    // worker 收不到信号、没机会 flush（见 protocol.md §5）。
    if (session.worker) { try { session.worker.stdin.end(); } catch {} }
    if (session.status !== 'stopping' && code !== 0 && !session.error) {
      const hint = /403/.test(errTail) ? '（上游 403）' : /404/.test(errTail) ? '（上游 404）' : '';
      session.error = `音频输入中断${hint}：ffmpeg 退出码 ${code}`;
      asrEvent(session, 'error', { code: 'AUDIO_INPUT_ENDED', message: session.error });
    }
  });
  return proc;
}

async function startAsrPipeline(session) {
  session.status = 'loading';
  session.error = '';
  session.lastBeatAt = Date.now();
  const worker = spawnAsrWorker(session);
  const ffmpeg = spawnAsrFfmpeg(session);

  // backpressure：音频比推理快时让 pipe 自然阻塞，**不建立无界队列**。
  //
  // ⚠️ 这里所有流都必须挂 'error' 处理，否则**整个服务会被带走**：
  // 已知崩溃场景：ffmpeg 的 stdout 在 worker.stdin 已经 end 之后又写出数据，
  // Node 对 Socket 抛 `ERR_STREAM_WRITE_AFTER_END`，没人接 → Unhandled 'error' event
  // → 进程直接退出（exit 1）。录制正开着的时候这一下就全没了。
  // ASR 流异常不应影响录制任务。
  const swallow = (where) => (e) => {
    session.streamErrors = (session.streamErrors || 0) + 1;
    diagLog('asr-stream-error', { session: session.id, where, code: e && e.code, message: String((e && e.message) || e).slice(0, 200) });
  };
  ffmpeg.stdout.on('error', swallow('ffmpeg.stdout'));
  worker.stdin.on('error', swallow('worker.stdin'));
  worker.stdout.on('error', swallow('worker.stdout'));
  worker.stderr.on('error', swallow('worker.stderr'));
  ffmpeg.stdout.pipe(worker.stdin, { end: true });

  // 卡死看门狗：10 秒既没有 metric 也没有任何事件 → 判定 hung（protocol.md §6）
  clearInterval(session.hungTimer);
  session.hungTimer = setInterval(() => {
    if (session.status !== 'running' && session.status !== 'loading') return;
    if (Date.now() - (session.lastBeatAt || session.startedAt) > ASR.hungMs * 3) {
      session.error = 'worker 超过 ' + Math.round(ASR.hungMs * 3 / 1000) + ' 秒没有任何心跳，已停止';
      asrEvent(session, 'error', { code: 'WORKER_HUNG', message: session.error });
      diagLog('asr-error', { session: session.id, code: 'WORKER_HUNG' });
      stopAsrSession(session.id, { force: true });   // 卡死的 worker 不会 flush，直接杀
    }
  }, 5000);
  return session;
}

function startAsrSession(ref, opts = {}) {
  const rec = getStreamRef(ref);
  if (!rec) { const e = new Error('streamRef 无效或已过期，请重新解析该课程'); e.statusCode = 400; throw e; }
  const avail = asrAvailability(true);
  if (!avail.available) { const e = new Error('ASR 未就绪：' + avail.problems.join('；')); e.statusCode = 503; throw e; }
  const active = [...asrSessions.values()].find((s) => s.status !== 'stopped' && s.status !== 'error');
  if (active) { const e = new Error(`已有一路识别在进行（session ${active.id}），先停掉它`); e.statusCode = 409; throw e; }

  const id = ++asrSeq;
  const session = {
    id, ref, profile: ASR.profile,
    url: rec.url, courseId: rec.courseId, subId: rec.subId,
    kind: rec.kind, label: rec.label, course: rec.title, room: rec.room,
    status: 'starting', startedAt: Date.now(), endedAt: null,
    finals: [], partial: '', events: [], eventSeq: 0, lastSeq: 0,
    clients: new Set(), protocolErrors: 0, restarts: 0,
    bytesIn: 0, audioMs: 0, rtf: null, rssMb: null,
    stderrTail: '', stderrBytes: 0, ffmpegStderr: '', error: '',
  };
  asrSessions.set(id, session);
  startAsrPipeline(session).catch((e) => {
    session.status = 'error';
    session.error = '启动失败：' + e.message;
  });
  diagLog('asr-start', {
    session: id, profile: ASR.profile, kind: rec.kind, via: ASR.direct ? 'direct' : 'relay',
    host: (() => { try { return new URL(rec.url).hostname; } catch { return ''; } })(),
  });
  return session;
}

// 优雅停止：先断音频输入（关 worker 的 stdin = EOF）→ 等 worker 自己 flush 出 stopped
// → 超时才强杀。**顺序不能颠倒**，否则最后一段文字会丢（protocol.md §5）。
//
// force=true 用于**已经判定卡死**的 worker：它根本不会读 stdin、也不会 flush，
// 等它只会白等 STOP_GRACE_MS 那么久，界面上会一直挂着「正在停止」。所以直接杀。
function stopAsrSession(id, { force = false } = {}) {
  const s = asrSessions.get(id);
  if (!s) return false;
  if (s.status === 'stopped' || s.status === 'error') return true;

  if (force) {
    clearInterval(s.hungTimer);
    clearTimeout(s.killTimer);
    if (s.ffmpeg) { try { s.ffmpeg.kill(); } catch {} }
    if (s.worker) { try { s.worker.kill(); } catch {} }
    s.status = 'stopped';
    s.endedAt = Date.now();
    if (!s.closedEmitted) {
      s.closedEmitted = true;
      asrEvent(s, 'closed', { status: 'stopped', forced: true });
    }
    diagLog('asr-stop', { session: id, forced: true, segments: s.finals.length });
    asrAvailCache.value = null;
    return true;
  }

  s.status = 'stopping';
  clearInterval(s.hungTimer);
  if (s.ffmpeg) { try { s.ffmpeg.kill(); } catch {} }
  if (s.worker) {
    try { if (s.ffmpeg) s.ffmpeg.stdout.unpipe(s.worker.stdin); } catch {}
    try { s.worker.stdin.end(); } catch {}      // ← EOF：worker 收到后 flush + stopped + 退出
    s.killTimer = setTimeout(() => {
      if (s.worker && s.worker.exitCode === null) {
        try { s.worker.kill(); } catch {}
        s.error = s.error || 'worker 未在超时内退出，已强制结束';
      }
      if (s.status === 'stopping') { s.status = 'stopped'; s.endedAt = Date.now(); }
    }, STOP_GRACE_MS);
  } else {
    s.status = 'stopped';
    s.endedAt = Date.now();
  }
  asrEvent(s, 'stopping', {});
  diagLog('asr-stop', { session: id, segments: s.finals.length });
  return true;
}

function stopAllAsr() {
  for (const s of asrSessions.values()) {
    if (s.status !== 'stopped' && s.status !== 'error') stopAsrSession(s.id);
  }
}

// 导出：TXT（带时间戳）/ SRT / JSON。默认不落盘，仅在点击导出时产出
function asrExport(s, format) {
  const ts = (ms) => {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const sec = String(total % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
  };
  const srtTs = (ms) => {
    const total = Math.max(0, Math.round(ms));
    const h = String(Math.floor(total / 3600000)).padStart(2, '0');
    const m = String(Math.floor((total % 3600000) / 60000)).padStart(2, '0');
    const sec = String(Math.floor((total % 60000) / 1000)).padStart(2, '0');
    const msec = String(total % 1000).padStart(3, '0');
    return `${h}:${m}:${sec},${msec}`;      // SRT 要求 HH:MM:SS,mmm
  };
  const stamp = new Date(s.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `zju-asr-${s.id}-${stamp}`;
  if (format === 'json') {
    return { name: base + '.json', type: 'application/json; charset=utf-8',
      body: JSON.stringify({ id: s.id, course: s.course, room: s.room, label: s.label,
        startedAt: s.startedAt, endedAt: s.endedAt, segments: s.finals }, null, 2) };
  }
  if (format === 'srt') {
    const body = s.finals.map((f, i) =>
      `${i + 1}\n${ts(f.t0Ms).replace(/:/g, ':')},000 --> ${ts(f.t1Ms).replace(/:/g, ':')},000\n${f.text}\n`
    ).join('\n');
    return { name: base + '.srt', type: 'application/x-subrip; charset=utf-8', body };
  }
  const body = s.finals.map((f) => `[${ts(f.t0Ms)}] ${f.text}`).join('\n') + '\n';
  return { name: base + '.txt', type: 'text/plain; charset=utf-8', body };
}

// ---------- 封面缩略图 ----------
// 直播卡片没有封面就会像一堆彩色方块，所以这里现抓一帧真实画面当封面。
// 三条约束（都是为了让这件事不添麻烦）：
//   1. **有磁盘缓存**（默认 8 分钟），所以同一张卡不会反复去拉上游；
//   2. **并发上限 2**，抢不到就回 404，前端用渐变占位图兜底 —— 绝不排队堆 ffmpeg；
//   3. **只抓一帧**（-frames:v 1）且缩到 480 宽，几 KB，不碰录制与 ASR。
// 产物写 ~/ZJU-Recordings-ai/thumbs（录制目录之外），因此不会被算进存储占用统计，
// 也不会被 compress-local.ps1 的一层目录扫描误判成一门课。
const THUMB_DIR = path.join(os.homedir(), 'ZJU-Recordings-ai', 'thumbs');
const THUMB_TTL_MS = Number(process.env.ZJU_THUMB_TTL_MS || 30 * 60 * 1000);
const THUMB_WIDTH = 480;
const THUMB_MAX_CONCURRENT = Number(process.env.ZJU_THUMB_PARALLEL || 5);
let thumbBusy = 0;
const thumbInflight = new Map();     // key -> Promise（同一张卡并发只抓一次）

function thumbPath(courseId, subId) {
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(THUMB_DIR, `${safe(courseId)}-${safe(subId)}.jpg`);
}

function grabThumb(url, outPath, jwt) {
  return new Promise((resolve) => {
    const input = ASR.direct ? url : relayUrl(url);
    // ffmpeg 不会自动创建输出目录。
    try { fs.mkdirSync(THUMB_DIR, { recursive: true }); } catch {}
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      // 超时必须比中转自己的上游预算（PROXY_TIMEOUT_MS=20s）更宽，否则会出现
      // 「中转还在等上游、ffmpeg 已经放弃」的假失败。该 CDN 有时需要 7~11 秒
      // 低速上游可能需要较长时间才返回完整 m3u8。
      '-rw_timeout', '25000000',
      '-headers', 'Referer: https://classroom.zju.edu.cn/\r\nOrigin: https://classroom.zju.edu.cn\r\nUser-Agent: Mozilla/5.0\r\n',
      // 不 seek：直播流的窗口在滚，-ss 会让它去够一个可能已经滚出去的位置；
      // 反正只需要一帧，直接取第一帧即可。
      '-i', input,
      '-frames:v', '1', '-vf', `scale=${THUMB_WIDTH}:-2`, '-q:v', '6', '-y', outPath,
    ];
    let done = false;
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { if (!done) { try { proc.kill(); } catch {} } }, 32000);
    let err = '';
    proc.stderr.on('data', (c) => { err = (err + c.toString()).slice(-500); });
    proc.on('error', (e) => { done = true; clearTimeout(timer); resolve({ ok: false, err: e.message }); });
    proc.on('exit', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      let size = 0;
      try { size = fs.statSync(outPath).size; } catch {}
      if (code === 0 && size > 0) return resolve({ ok: true, size });
      try { fs.unlinkSync(outPath); } catch {}
      resolve({ ok: false, err: err.slice(0, 200) || ('ffmpeg 退出码 ' + code) });
    });
  });
}

async function serveThumb(res, courseId, subId, jwt) {
  const key = `${courseId}-${subId}`;
  const file = thumbPath(courseId, subId);
  const fresh = () => {
    try { return Date.now() - fs.statSync(file).mtimeMs < THUMB_TTL_MS; } catch { return false; }
  };
  const send = () => {
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('no thumb'); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=300' });
      res.end(buf);
    });
  };
  if (fresh()) return send();

  if (thumbBusy >= THUMB_MAX_CONCURRENT) {   // 忙就直说，让前端先用占位图
    res.writeHead(503, { 'retry-after': '3' }); return res.end('busy');
  }
  if (!thumbInflight.has(key)) {
    const job = (async () => {
      thumbBusy++;
      try {
        // 先看流地址缓存：命中就**不用再问一次学校接口**（每张封面少一跳、也少打扰上游）。
        // 只有缓存里没有 / 已过期时才去 resolveStreams。
        const now = Math.floor(Date.now() / 1000);
        const hit = streamCache.get(`${courseId}-${subId}`);
        let streams = (hit && hit.expiry > now + 5) ? hit.streams : null;
        if (!streams || !streams.length) {
          const r = await withRelogin(() => resolveStreams(jwt, courseId, subId, {}));
          streams = r.streams || [];
        }
        const s = streams.find((x) => x.key === 'teacher') || streams[0];
        if (!s) return { ok: false, err: '没有可用机位' };
        const url = s.recordUrl || s.url;
        if (!/^https?:/i.test(url || '')) return { ok: false, err: '地址不可用' };
        return await grabThumb(url, file, jwt);
      } catch (e) {
        return { ok: false, err: String(e.message || e).slice(0, 160) };
      } finally {
        thumbBusy--;
        thumbInflight.delete(key);
      }
    })();
    thumbInflight.set(key, job);
  }
  const r = await thumbInflight.get(key);
  if (r && r.ok) return send();
  diagLog('thumb-fail', { courseId, subId, err: r && r.err });
  res.writeHead(404); res.end('thumb unavailable');
}

function relayUrl(target) {
  let name = 'seg.ts';
  try {
    const b = path.basename(new URL(target).pathname);
    if (/\.(ts|m4s|m4v|m4a|mp4|aac|vtt|key|m3u8)$/i.test(b)) name = b;
    else if (/\.m3u8/i.test(target)) name = 'index.m3u8';
  } catch {}
  name = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return `http://127.0.0.1:${PORT}/relay/${name}?u=${encodeURIComponent(target)}`;
}

async function relayStream(res, target) {
  const t0 = Date.now();
  let base;
  try { const t = new URL(target); base = { host: t.hostname, path: t.pathname }; }
  catch { res.writeHead(400); return res.end('bad url'); }
  if (!/\.zju\.edu\.cn$/i.test(base.host)) {
    diagLog('relay-reject', Object.assign({ reason: 'host not allowed' }, base));
    res.writeHead(403); return res.end('host not allowed');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), PROXY_TIMEOUT_MS);
  let up;
  try {
    up = await fetch(target, { headers: PROXY_HEADERS, signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    const msg = String((e && e.message) || e);
    const timeout = /abort|timeout/i.test(msg) || (e && e.name === 'AbortError');
    diagLog('relay-error', Object.assign({ phase: 'connect', ms: Date.now() - t0, timeout, error: msg }, base));
    if (!res.headersSent) { res.writeHead(timeout ? 504 : 502); res.end('relay ' + msg); }
    return;
  }
  const ct = up.headers.get('content-type') || '';
  const isM3u8 = /mpegurl|m3u8/i.test(ct) || /\.m3u8(\?|$)/i.test(base.path);
  if (!up.ok) {
    clearTimeout(timer);
    diagLog('relay-upstream', Object.assign({ status: up.status, ms: Date.now() - t0 }, base));
    res.writeHead(up.status); return res.end('upstream ' + up.status);
  }
  if (isM3u8) {
    try {
      const text = await up.text();
      clearTimeout(timer);
      diagLog('relay-m3u8', Object.assign({
        bytes: Buffer.byteLength(text), ms: Date.now() - t0, live: !/EXT-X-ENDLIST/.test(text),
      }, base));
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text.split('\n').map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${relayUrl(new URL(u, target).href)}"`);
        }
        return relayUrl(new URL(t, target).href);
      }).join('\n'));
    } catch (e) {
      clearTimeout(timer);
      diagLog('relay-error', Object.assign({ phase: 'm3u8', error: String((e && e.message) || e) }, base));
      if (!res.headersSent) { res.writeHead(502); res.end('relay read error'); }
    }
    return;
  }
  let bytes = 0;
  const body = Readable.fromWeb(up.body);
  body.on('data', (c) => { bytes += c.length; });
  body.on('end', () => { clearTimeout(timer); diagLog('relay-body', Object.assign({ bytes, how: 'complete', ms: Date.now() - t0 }, base)); });
  body.on('error', (e) => {
    clearTimeout(timer);
    diagLog('relay-error', Object.assign({ phase: 'body', bytes, error: String((e && e.message) || e) }, base));
    try { res.destroy(); } catch {}
  });
  res.on('error', () => { try { body.destroy(); } catch {} });
  res.on('close', () => { if (!res.writableEnded) { try { body.destroy(); } catch {} } });
  res.writeHead(200, { 'content-type': ct || 'video/mp2t', 'cache-control': 'no-store' });
  body.pipe(res);
}

// ---------- 录制 ----------
// 开流失败自动重试：已知 ffmpeg 会在 TLS 层直接失败（IO error -138）、
// 或遇到上游 403，这类多为瞬时。若一次失败即终止任务且不产出文件，
// 整场录制报废还查不出原因。
const RECORD_MAX_ATTEMPTS = 3;
const RECORD_RETRY_DELAY_MS = 3000;

function listMp4(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')); } catch { return []; }
}

// 从 ffmpeg.log 尾部取最后一条有效错误，用于说明录制失败原因
function lastFfmpegError(dir) {
  try {
    const txt = fs.readFileSync(path.join(dir, 'ffmpeg.log'), 'utf8').slice(-4000);
    const lines = txt.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (/^#/.test(l)) continue;
      if (/error|invalid|forbidden|not found|403|404|fail|timed out|refused|reset/i.test(l)) return l.slice(0, 300);
    }
  } catch {}
  return '';
}

function recordArgs(job) {
  // 默认走本机中转（与网页同一套网络栈）；最后一次尝试退回直连上游，
  // 万一中转本身有问题，录制仍有机会成功。
  const viaRelay = job.attempts < RECORD_MAX_ATTEMPTS;
  const input = viaRelay ? job.relayUrl : job.url;
  return [
    // 直播流网络抖动/瞬时 TLS 错误时自动重连，避免整场录制因一次闪断而中断
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '15000000', // 15s 无数据则视为超时再重连（微秒）
    // 让 ffmpeg 的请求头和网页/代理那条已验证可用的路径保持一致（直连时才起作用）
    '-headers', 'Referer: https://classroom.zju.edu.cn/\r\nOrigin: https://classroom.zju.edu.cn\r\nUser-Agent: Mozilla/5.0\r\n',
    '-i', input, '-c', 'copy', '-f', 'segment',
    '-segment_time', String(SEGMENT_SECONDS),
    '-strftime', '1', '-reset_timestamps', '1',
    // 分段是普通（非 fragmented）MP4：moov 索引表在文件尾部，由 ffmpeg
    // 退出前的收尾阶段写入。因此停止录制必须走 gracefulStop()，不能强杀进程，
    // 否则最后一段只有 mdat 没有 moov（表现为“格式错误，没有正确结尾”）。
    // 注意：movflags 是 mp4 子 muxer 的选项，写在下面这行的输出上会被 segment
    // muxer 静默忽略；若确实需要 fragmented 输出，得用
    // -segment_format_options movflags=+empty_moov+frag_keyframe
    path.join(job.dir, '%H%M%S.mp4'),
  ];
}

function finishJob(job) {
  if (job.logFd !== undefined && job.logFd !== null) {
    try { fs.closeSync(job.logFd); } catch {}
    job.logFd = null;
  }
}

function spawnAttempt(job) {
  job.attempts++;
  try {
    fs.appendFileSync(path.join(job.dir, 'ffmpeg.log'),
      `\n# ==== 第 ${job.attempts} 次开流尝试 ${new Date().toLocaleString('zh-CN')} ====\n`);
  } catch {}
  // stdin 必须是管道：停止时靠向 ffmpeg 写 'q' 让它正常退出并写完 moov
  const proc = spawn('ffmpeg', recordArgs(job), { stdio: ['pipe', job.logFd, job.logFd] });
  job.proc = proc;
  job.status = 'recording';
  proc.on('exit', (code, signal) => {
    const clean = job.status === 'stopping' || signal === 'SIGINT' || signal === 'SIGTERM' || code === 0 || code === 255;
    clearTimeout(job.stopTimer);
    if (clean) { job.status = 'stopped'; job.exitCode = code; job.endedAt = Date.now(); finishJob(job); return; }

    // 一个 mp4 都没产出，说明是“开流就失败”，而不是录到一半断的
    const wrote = listMp4(job.dir).length > 0;
    job.lastError = lastFfmpegError(job.dir);
    if (!wrote && job.attempts < RECORD_MAX_ATTEMPTS) {
      job.status = 'retrying';
      job.error = (job.lastError || ('退出码 ' + code)) + `（第 ${job.attempts} 次失败，${RECORD_RETRY_DELAY_MS / 1000} 秒后重试）`;
      diagLog('record-retry', { job: job.id, course: job.course, attempt: job.attempts, error: job.lastError });
      job.retryTimer = setTimeout(() => { if (job.status === 'retrying') spawnAttempt(job); }, RECORD_RETRY_DELAY_MS);
      return;
    }
    job.status = 'error'; job.exitCode = code; job.endedAt = Date.now();
    job.error = wrote ? '' : (job.lastError || `ffmpeg 退出码 ${code}`);
    diagLog('record-error', { job: job.id, course: job.course, code, signal, attempts: job.attempts, wrote, error: job.error });
    finishJob(job);
  });
}

function startRecording({ url, label, course }) {
  const safeName = `${course}_${label}`.replace(/[/:*?"<>|]/g, '_').replace(/\s/g, '_');
  const dateStr = dispDate(new Date()).replace(/-/g, '');
  const dir = path.join(OUTPUT_DIR, safeName, dateStr);
  fs.mkdirSync(dir, { recursive: true });

  const logFd = fs.openSync(path.join(dir, 'ffmpeg.log'), 'a');
  const id = ++jobSeq;
  const job = {
    id, course, label, url, dir, logFd, relayUrl: relayUrl(url),
    startedAt: Date.now(), status: 'recording', attempts: 0, error: '',
  };
  jobs.set(id, job);
  spawnAttempt(job);
  return job;
}

// 停止录制。Windows 上 Node 无法投递 POSIX 信号，proc.kill() 底层是
// TerminateProcess（等价于强杀），ffmpeg 跑不到写 moov 的收尾阶段，
// 最后一段分段就只剩 mdat、没有正确的结尾。这里改成让 ffmpeg 自己退出。
function gracefulStop(job) {
  if (job.status === 'retrying') {          // 还在等重试：直接取消，不必再开流
    clearTimeout(job.retryTimer);
    job.status = 'stopped'; job.endedAt = Date.now(); finishJob(job);
    return;
  }
  if (job.status !== 'recording') return;
  job.status = 'stopping';
  const proc = job.proc;
  try { proc.stdin.write('q'); proc.stdin.end(); } catch {}
  job.stopTimer = setTimeout(() => { try { proc.kill(); } catch {} }, STOP_GRACE_MS);
}

function stopRecording(id) {
  const job = jobs.get(id);
  if (!job) return false;
  gracefulStop(job);
  return true;
}

function jobView(j) {
  return {
    id: j.id, course: j.course, label: j.label, dir: j.dir, status: j.status,
    startedAt: j.startedAt, endedAt: j.endedAt || null,
    durationSec: Math.floor(((j.endedAt || Date.now()) - j.startedAt) / 1000),
    attempts: j.attempts || 1, error: j.error || '',
  };
}

// ---------- 一门课的全部场次（只给 course_id，一次拿全学期）----------
async function fetchSessions(jwt, courseId) {
  const qs = new URLSearchParams({
    all: '1', course_id: String(courseId),
    with_sub_data: '1', show_all: '1', show_delete: '2',
  });
  const res = await fetch(`${DETAIL_BASE}/search-live-course-list?${qs}`, { headers: zjuHeaders(jwt) });
  const data = await res.json();
  if (String(data.code) !== '0') throw new Error(data.msg || '获取场次失败');
  return (data.list || []).map((c) => ({
    sub_id: c.sub_id,
    sub_title: c.sub_title || '',
    title: c.title || '',
    begin: Number(c.course_begin) || 0,
    over: Number(c.course_over) || 0,
    status: c.status_label || '',
  }));
}

// ---------- 预约录制（mark）----------
const MARKS_FILE = path.join(os.homedir(), '.zju_marks.json');
let marks = [];
let markSeq = 0;

function loadMarks() {
  try { marks = JSON.parse(fs.readFileSync(MARKS_FILE, 'utf8')) || []; } catch { marks = []; }
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const m of marks) {
    delete m._starting;
    markSeq = Math.max(markSeq, m.id || 0);
    if (m.streamPref !== 'teacher') { m.streamPref = 'teacher'; changed = true; }
    // 重启前正在录的：未结束的恢复为待录（下次到点重连），已结束的标记完成
    if (m.status === 'recording') { m.status = now < m.over ? 'pending' : 'done'; m.jobIds = []; }
  }
  if (changed) saveMarks();
}
function saveMarks() {
  const slim = marks.map(({ _starting, ...m }) => m);
  try { fs.writeFileSync(MARKS_FILE, JSON.stringify(slim, null, 2)); } catch {}
}
function markView(m) {
  return {
    id: m.id, course_id: m.course_id, sub_id: m.sub_id,
    course_title: m.course_title, sub_title: m.sub_title,
    begin: m.begin, over: m.over, streamPref: m.streamPref,
    status: m.status, note: m.note || '',
  };
}

async function startMarkRecording(m, jwt) {
  if (m._starting) return;
  m._starting = true;
  try {
    if (!jwt) { m.note = 'JWT 未设置/已失效'; return; }
    const r = await resolveStreams(jwt, m.course_id, m.sub_id);
    if (!r.streams.length) { m.note = '等待开播…'; return; } // 还没真直播，下个 tick 再试
    const chosen = r.streams.filter((s) => s.key === 'teacher');
    if (!chosen.length) { m.note = '未解析到主画面直播流'; return; }
    m.jobIds = chosen.map((s) => startRecording({ url: s.recordUrl || s.url, label: s.label, course: m.course_title }).id);
    m.status = 'recording';
    m.note = '';
    saveMarks();
  } catch (e) {
    m.note = e.message;
  } finally {
    m._starting = false;
  }
}

function schedulerTick() {
  const jwt = readJwt();
  const now = Math.floor(Date.now() / 1000);
  for (const m of marks) {
    if (m.status === 'done' || m.status === 'cancelled' || m.status === 'missed') continue;
    if (m.status === 'recording') {
      if (now >= m.over) { // 到结束时间，自动停止
        for (const id of (m.jobIds || [])) stopRecording(id);
        m.status = 'done'; saveMarks();
      }
      continue;
    }
    // pending：进入 [begin, over) 时间窗就尝试开录（轮询直到拿到直播流）
    if (now >= m.begin && now < m.over) startMarkRecording(m, jwt);
    else if (now >= m.over) { m.status = 'missed'; m.note = '服务未运行或未解析到直播流'; saveMarks(); }
  }
}

loadMarks();
setInterval(schedulerTick, 20000); // 每 20 秒检查一次预约

// ---------- 预缓存：把当前所有直播课的流解析进缓存 ----------
// 批量刷新直播地址缓存。
// 关键点：地址的可用窗口是「auth_key 签发时间 + 4h(+3h CDN 宽容)」，所以窗口是从**签发时刻**
// 起算的。想让窗口重新变成完整 7 小时，只能重新向 API 要一次地址（重新签发）。
// force=false：只补缺失/快过期的（省 API 调用）；force=true：不管有没有、剩多久，一律重签。
async function precacheLive(jwt, { force = false, reason = 'manual' } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const courses = (await fetchCourses(jwt)).filter((c) => c.live);
  const targets = new Map();
  for (const c of courses) targets.set(`${c.course_id}-${c.sub_id}`, c);
  // 强制模式下，把缓存里"还没过期但已不在播"的也试一遍（API 不再签发时保持原样，不吃亏）
  if (force) {
    for (const [key, v] of streamCache) {
      if (v.expiry <= nowSec || targets.has(key)) continue;
      const i = key.indexOf('-');
      targets.set(key, { course_id: key.slice(0, i), sub_id: key.slice(i + 1), title: v.title, room: v.room, notLive: true });
    }
  }
  const beforeExp = new Map([...streamCache].map(([k, v]) => [k, v.expiry]));
  let refreshed = 0, keptOld = 0, failed = 0, skipped = 0, extended = 0;
  await Promise.all([...targets.values()].map(async (c) => {
    const key = `${c.course_id}-${c.sub_id}`;
    const prevExp = beforeExp.get(key) || 0;
    // 普通刷新：还剩 1 小时以上的不折腾，省上游调用
    if (!force && prevExp - nowSec > 3600) { skipped++; return; }
    try {
      const r = await resolveStreams(jwt, c.course_id, c.sub_id, { title: c.title, room: c.room });
      if (r.source === 'live' && r.streams.length) {
        refreshed++;
        const after = (streamCache.get(key) || {}).expiry || 0;
        if (after > prevExp + 60) extended++;
      } else if (r.streams.length) keptOld++;   // 拿不到新地址，只能用旧的
      else failed++;
    } catch { failed++; }
  }));
  const remains = [...streamCache.values()].map((v) => v.expiry - nowSec).filter((x) => x > 0);
  const out = {
    reason, force, total: targets.size, refreshed, keptOld, failed, skipped, extended,
    windowMaxMin: remains.length ? Math.round(Math.max.apply(null, remains) / 60) : 0,
    windowMinMin: remains.length ? Math.round(Math.min.apply(null, remains) / 60) : 0,
  };
  diagLog('precache', out);
  return out;
}

// ---------- 查老师（浙大匿名教评）----------
// 设计约定：**手动同步、不实时访问** —— 点击「同步」时增量抓取并保存到本地，
// 之后只读本地 JSON。查老师的服务器不是学校的服务器，一个学期拉一次就够，别去打扰它。
// 当前域名 dahua309.uk（旧域名 chalaoshi.de 在国内 DNS 被污染，会解析到无关 IP，
// 所以域名做成列表 + 逐个回退）；没有 JSON 接口，只有 HTML 片段。
const CHALAOSHI_FILE = path.join(os.homedir(), '.zju_chalaoshi.json');
const CHALAOSHI_BASES = (process.env.ZJU_CHALAOSHI_BASES
  || 'https://dahua309.uk,https://chalaoshi.de')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const CL_GAP_MS = Number(process.env.ZJU_CHALAOSHI_GAP_MS || 1200);   // 两个请求之间歇一下（对人家客气点）
const CL_TIMEOUT_MS = Number(process.env.ZJU_CHALAOSHI_TIMEOUT_MS || 9000);
const CL_RETRY_DAYS = 30;      // 查不到 / 同名撞车的，隔一个月再试
const CL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZJU-Recorder (personal use)';

let chalaoshi = { updatedAt: 0, source: '', teachers: {} };
let clBase = CHALAOSHI_BASES[0];
let clSeq = 0;
let clSync = { id: 0, running: false, cancelled: false, total: 0, done: 0, ok: 0, none: 0, multiple: 0,
  failed: 0, current: '', startedAt: 0, finishedAt: 0, lastError: '' };

function loadChalaoshi() {
  try {
    const j = JSON.parse(fs.readFileSync(CHALAOSHI_FILE, 'utf8'));
    if (j && j.teachers && typeof j.teachers === 'object') chalaoshi = j;
  } catch {}
}
function saveChalaoshi() {
  try { fs.writeFileSync(CHALAOSHI_FILE, JSON.stringify(chalaoshi, null, 1)); } catch {}
}
loadChalaoshi();

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
function decEnt(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&').trim();
}
// 搜索结果：每个结果是一段 <div class="item" onclick="window.location='/t/<tid>/'">
//   <div class="left"><h3>姓名</h3><p>学院</p></div><div class="right"><h2>9.8</h2></div>
function parseClSearch(html) {
  const out = [];
  for (const seg of String(html || '').split('<div class="item"').slice(1)) {
    const tid = (seg.match(/\/t\/(\d+)\//) || [])[1];
    const name = (seg.match(/<h3>([^<]*)<\/h3>/) || [])[1];
    if (!tid || !name) continue;
    const college = (seg.match(/<p>([^<]*)<\/p>/) || [])[1];
    const score = (seg.match(/<h2>([\d.]+)<\/h2>/) || [])[1];
    out.push({ tid, name: decEnt(name), college: decEnt(college || ''), score: score ? Number(score) : null });
  }
  return out;
}
// 教师详情页：<h2>9.84</h2><p>474人参与评分</p> + 「19.8%的人认为该老师会点名」+ 各课平均绩点
function parseClDetail(html) {
  const t = String(html || '');
  const m = t.match(/<h2>([\d.]+)<\/h2>\s*<p>(\d+)\s*人参与评分<\/p>/)
    || t.match(/([\d.]+)\s*分\s*(\d+)\s*人打分/);      // 兜底：从 <title> 里取
  const rc = t.match(/([\d.]+)%\s*的人认为该老师会点名/);
  const courses = [];
  const re = /<p class="course_name">([^<]*)<\/p>[\s\S]{0,240}?<p>([\d.]+)\/([^<]*)<\/p>/g;
  let mm;
  while ((mm = re.exec(t))) courses.push({ name: decEnt(mm[1]), gpa: Number(mm[2]), count: decEnt(mm[3]) });
  return {
    score: m ? Number(m[1]) : null,
    ratingCount: m ? Number(m[2]) : null,
    rollCallRate: rc ? rc[1] + '%' : '',
    courses,
  };
}
async function clFetch(pathname) {
  const order = [clBase].concat(CHALAOSHI_BASES.filter((b) => b !== clBase));
  let lastErr = null;
  for (const base of order) {
    try {
      const r = await fetch(base + pathname, {
        signal: AbortSignal.timeout(CL_TIMEOUT_MS),
        headers: { 'user-agent': CL_UA, accept: 'text/html,*/*' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      clBase = base;
      return txt;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('查老师站点不可达');
}
// 课程里的学院 vs 站上的学院：完全相同 > 互相包含 > 都不沾
function clCollegeHit(courseColleges, siteCollege) {
  let best = 0;
  for (const cc of courseColleges || []) {
    if (!cc || !siteCollege) continue;
    if (cc === siteCollege) best = Math.max(best, 2);
    else if (cc.includes(siteCollege) || siteCollege.includes(cc)) best = Math.max(best, 1);
  }
  return best;
}
// 抓详情页补全（分数两位小数 / 评分人数 / 点名率 / 各课绩点）
async function clEnrich(entry) {
  if (!entry.tid) return;
  try {
    const d = parseClDetail(await clFetch('/t/' + entry.tid + '/'));
    if (d.score != null) entry.score = d.score;
    if (d.ratingCount != null) entry.ratingCount = d.ratingCount;
    if (d.rollCallRate) entry.rollCallRate = d.rollCallRate;
    if (d.courses.length) entry.courses = d.courses;
    entry.detailError = '';
  } catch (e) { entry.detailError = e.message; }
  entry.detailAt = Date.now();
}
// 教师池不能挂在 coursesSnapshot 上：`autoCacheTick` 每 10 分钟会把那个快照换成
// 「今天 + 当前时段」的小名单（只为在播课备地址），一换就把 1544 位教师缩成 ~95 位。
// 所以这边自己攒：**见过的都留着**（顺带把学院攒下来给同名撞车用），
// 另外记住"最近一次完整课程表里能看的课"是谁 —— 默认同步就抓这批。
const clKnown = new Map();       // 姓名 -> Set(学院)
let clWatch = new Set();         // 最近一次完整课程表里 live||cached 的教师
function clObserveCourses(courses, full) {
  if (full) clWatch = new Set();
  for (const c of courses || []) {
    if (!c.teacher) continue;
    let set = clKnown.get(c.teacher);
    if (!set) { set = new Set(); clKnown.set(c.teacher, set); }
    if (c.college) set.add(c.college);
    if (full && (c.live || c.cached)) clWatch.add(c.teacher);
  }
}
// 同步范围：默认只取「能看的课」的老师（约 400 余位；全量约 1500 位、耗时约一小时）。
// 星标里的老师一定带上。
function clTeacherBag(scope) {
  if (scope === 'all') return new Map(clKnown);
  const want = new Map();
  for (const name of clWatch) want.set(name, new Set(clKnown.get(name) || []));
  for (const s of stars) {
    if (s.type !== 'teacher' || !s.value) continue;
    if (!want.has(s.value)) want.set(s.value, new Set(clKnown.get(s.value) || []));
  }
  return want;
}
function clPending(force, scope) {
  const want = clTeacherBag(scope);

  const stale = Date.now() - CL_RETRY_DAYS * 86400000;
  const list = [];
  for (const [name, colleges] of want) {
    const e = chalaoshi.teachers[name];
    let need;
    if (force || !e || !e.at) need = true;
    else if (e.status !== 'ok') need = e.at < stale;      // 没查到 / 同名撞车：隔月再试
    else need = e.ratingCount == null;                    // 有分数但没抓到人数：补详情
    if (need) list.push({ name, colleges: [...colleges] });
  }
  list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return list;
}
// 「补全详情」的名单：已经匹配到人、但还没抓到评分人数的
function clNeedDetail() {
  const want = clTeacherBag('all');
  const out = [];
  for (const [name] of want) {
    const e = chalaoshi.teachers[name];
    if (e && e.status === 'ok' && e.tid && e.ratingCount == null) out.push({ name, colleges: [...want.get(name)] });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return out;
}
async function clSyncOne(t, withDetail) {
  const items = parseClSearch(await clFetch('/search?q=' + encodeURIComponent(t.name)));
  const exact = items.filter((x) => x.name === t.name);
  const entry = {
    name: t.name, at: Date.now(), courseColleges: t.colleges,
    candidates: exact.map((x) => ({ tid: x.tid, name: x.name, college: x.college, score: x.score })),
  };
  if (!exact.length) { entry.status = 'none'; clSync.none++; chalaoshi.teachers[t.name] = entry; return; }
  let pick = exact[0];
  if (exact.length > 1) {
    // 同名冲突：用课程里的学院与站点上的学院比对消歧
    const scored = exact.map((x) => ({ x, hit: clCollegeHit(t.colleges, x.college) }))
      .sort((a, b) => b.hit - a.hit);
    if (scored[0].hit > 0 && (scored.length === 1 || scored[0].hit > scored[1].hit)) pick = scored[0].x;
    else { entry.status = 'multiple'; clSync.multiple++; chalaoshi.teachers[t.name] = entry; return; }
  }
  entry.status = 'ok';
  entry.tid = pick.tid;
  entry.score = pick.score;
  entry.siteCollege = pick.college;
  chalaoshi.teachers[t.name] = entry;      // 先落 search 的结果，详情失败也不白跑
  if (withDetail) {
    await sleepMs(CL_GAP_MS);
    await clEnrich(entry);
  }
  clSync.ok++;
}
async function runClSync(list, withDetail) {
  for (const t of list) {
    if (clSync.cancelled) break;
    clSync.current = t.name;
    try { await clSyncOne(t, withDetail); }
    catch (e) {
      clSync.failed++;
      if (!clSync.lastError) clSync.lastError = t.name + '：' + e.message;
    }
    clSync.done++;
    clSync.current = '';
    chalaoshi.updatedAt = Date.now();
    chalaoshi.source = clBase;
    saveChalaoshi();                        // 每抓一个就落盘：中断了也不白跑
    if (clSync.done < list.length) await sleepMs(CL_GAP_MS);
  }
  clSync.running = false;
  clSync.finishedAt = Date.now();
  chalaoshi.updatedAt = Date.now();
  chalaoshi.source = clBase;
  saveChalaoshi();
  diagLog('chalaoshi-sync', { total: clSync.total, done: clSync.done, ok: clSync.ok,
    none: clSync.none, multiple: clSync.multiple, failed: clSync.failed, base: clBase,
    detail: !!withDetail, cancelled: clSync.cancelled });
}

// ---------- HTTP 工具 ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
function serveStatic(res, urlPath) {
  const file = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(full).slice(1);
    const types = {
      html: 'text/html',
      js: 'text/javascript',
      css: 'text/css',
      svg: 'image/svg+xml',
      png: 'image/png',
      ico: 'image/x-icon',
    };
    // 页面/样式/脚本一律不缓存：这是本机工具，改完就该立刻生效 ——
    // no-store 避免浏览器使用过期页面。
    // 只有 hls.js / flv.js 这类"大且不会变"的库才让浏览器缓存。
    const noStore = /^(html|css|js)$/.test(ext) && !/\.min\.js$/.test(full);
    res.writeHead(200, {
      'content-type': (types[ext] || 'text/plain') + '; charset=utf-8',
      'cache-control': noStore ? 'no-store, must-revalidate' : 'public, max-age=86400',
    });
    res.end(buf);
  });
}

// 录制目录占用（带 10s 缓存，避免频繁遍历）
let storageCache = { at: 0, bytes: 0, files: 0 };
function getStorage() {
  if (Date.now() - storageCache.at < 10000) return storageCache;
  let bytes = 0, files = 0;
  const stack = [OUTPUT_DIR];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { bytes += fs.statSync(p).size; files++; } catch {} }
    }
  }
  storageCache = { at: Date.now(), bytes, files };
  return storageCache;
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/api/status' && method === 'GET')
      return sendJson(res, 200, { jwt: inspectJwt(readJwt()), autoLogin: hasCreds() });

    if (p === '/api/storage' && method === 'GET') {
      const { bytes, files } = getStorage();
      return sendJson(res, 200, { bytes, files });
    }

    if (p === '/api/jwt' && method === 'POST') {
      const body = await readBody(req);
      if (!body.token) return sendJson(res, 400, { error: 'token 为空' });
      saveJwt(body.token);
      return sendJson(res, 200, { ok: true, jwt: inspectJwt(readJwt()) });
    }

    // 保存账密（启用自动登录）；密码本地 600 存储，绝不入库/打印
    if (p === '/api/credentials' && method === 'POST') {
      const body = await readBody(req);
      if (!body.username || !body.password) return sendJson(res, 400, { error: '缺少学号/密码' });
      saveCreds(String(body.username).trim(), String(body.password));
      return sendJson(res, 200, { ok: true });
    }
    // 立即用已存账密登录一次
    if (p === '/api/login' && method === 'POST') {
      if (!hasCreds()) return sendJson(res, 400, { error: '尚未配置账密' });
      try { await doLogin(); return sendJson(res, 200, { ok: true, jwt: inspectJwt(readJwt()) }); }
      catch (e) { return sendJson(res, 502, { error: '登录失败: ' + e.message }); }
    }

    if (p === '/api/courses' && method === 'GET') {
      try {
        if (!readJwt() && hasCreds()) await autoRelogin().catch(() => {});
        if (!readJwt()) return sendJson(res, 400, { error: '尚未设置 JWT，且未配置自动登录' });
        return sendJson(res, 200, { courses: await withRelogin(() => fetchCourses(readJwt())) });
      } catch (e) {
        return sendJson(res, 502, { error: e.message, apiCode: e.apiCode });
      }
    }

    if (p === '/api/streams' && method === 'GET') {
      const courseId = url.searchParams.get('course_id');
      const subId = url.searchParams.get('sub_id');
      if (!courseId || !subId) return sendJson(res, 400, { error: '缺少 course_id/sub_id' });
      try {
        if (!readJwt() && hasCreds()) await autoRelogin().catch(() => {});
        if (!readJwt()) return sendJson(res, 400, { error: '尚未设置 JWT token' });
        const meta = { title: url.searchParams.get('title') || '', room: url.searchParams.get('room') || '' };
        const r = await withRelogin(() => resolveStreams(readJwt(), courseId, subId, meta));
        // 给每个机位配一个不透明 streamRef：ASR 接口只认它，浏览器不传 URL。
        // 只有 http(s) 的 hls/flv 才配 —— ffmpeg 能拉这两种，rtmp 这边不走。
        const streams = (r.streams || []).map((s) => {
          const u = s.recordUrl || s.url || '';
          if (!/^https?:/i.test(u)) return s;
          return Object.assign({}, s, {
            ref: makeStreamRef(s, { course_id: courseId, sub_id: subId, title: meta.title, room: meta.room, expiry: r.expiry }),
          });
        });
        return sendJson(res, 200, { streams, source: r.source, expiry: r.expiry, dropped: r.dropped || [] });
      } catch (e) {
        return sendJson(res, 502, { error: e.message });
      }
    }

    if (p === '/api/stream-debug' && method === 'GET') {
      const jwt = readJwt();
      if (!jwt) return sendJson(res, 400, { error: '尚未设置 JWT token' });
      const courseId = url.searchParams.get('course_id');
      const subId = url.searchParams.get('sub_id');
      if (!courseId || !subId) return sendJson(res, 400, { error: '缺少 course_id/sub_id' });
      try {
        const c = await fetchDetailCourse(jwt, courseId, subId);
        if (!c) return sendJson(res, 404, { error: '未找到课程详情' });
        return sendJson(res, 200, {
          course: {
            course_id: c.course_id,
            sub_id: c.sub_id,
            title: c.title || '',
            room: c.room_name || '',
            status: c.status_label || '',
          },
          subContent: safeSubContentShape(c.sub_content),
        });
      } catch (e) {
        return sendJson(res, 502, { error: e.message });
      }
    }

    if (p === '/api/sessions' && method === 'GET') {
      const jwt = readJwt();
      if (!jwt) return sendJson(res, 400, { error: '尚未设置 JWT token' });
      const courseId = url.searchParams.get('course_id');
      if (!courseId) return sendJson(res, 400, { error: '缺少 course_id' });
      try {
        const now = Math.floor(Date.now() / 1000);
        const all = await fetchSessions(jwt, courseId);
        // 只返回未来未上的场次（正在直播/已结束的不用预约）
        const future = all.filter((s) => s.begin > now).sort((a, b) => a.begin - b.begin);
        return sendJson(res, 200, { sessions: future });
      } catch (e) {
        return sendJson(res, 502, { error: e.message });
      }
    }

    if (p === '/api/marks' && method === 'GET')
      return sendJson(res, 200, { marks: marks.map(markView) });

    if (p === '/api/marks' && method === 'POST') {
      const body = await readBody(req);
      const items = Array.isArray(body.marks) ? body.marks : [];
      let added = 0;
      for (const it of items) {
        if (!it.course_id || !it.sub_id) continue;
        if (marks.some((m) => String(m.sub_id) === String(it.sub_id)
          && m.status !== 'cancelled' && m.status !== 'missed')) continue; // 去重
        marks.push({
          id: ++markSeq,
          course_id: String(it.course_id), sub_id: String(it.sub_id),
          course_title: it.course_title || '', sub_title: it.sub_title || '',
          begin: Number(it.begin) || 0, over: Number(it.over) || 0,
          streamPref: 'teacher',
          status: 'pending', jobIds: [], note: '',
        });
        added++;
      }
      saveMarks();
      return sendJson(res, 200, { added, marks: marks.map(markView) });
    }

    if (p === '/api/marks/delete' && method === 'POST') {
      const body = await readBody(req);
      const m = marks.find((x) => x.id === Number(body.id));
      if (!m) return sendJson(res, 404, { error: '预约不存在' });
      if (m.status === 'recording') for (const id of (m.jobIds || [])) stopRecording(id);
      marks = marks.filter((x) => x.id !== Number(body.id));
      saveMarks();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/precache' && method === 'POST') {
      const jwt = readJwt();
      if (!jwt) return sendJson(res, 400, { error: '尚未设置 JWT token' });
      const body = await readBody(req).catch(() => ({}));
      try { return sendJson(res, 200, await precacheLive(jwt, { force: !!body.force, reason: body.force ? 'force' : 'manual' })); }
      catch (e) { return sendJson(res, 502, { error: e.message }); }
    }

    if (p === '/api/stars' && method === 'GET') {
      return sendJson(res, 200, { stars: stars.map(starView), snapshotAt: coursesSnapshot.at });
    }
    if (p === '/api/stars' && method === 'POST') {
      const body = await readBody(req);
      const type = body.type, value = String(body.value || '').trim();
      if (!['course', 'room', 'teacher'].includes(type) || !value)
        return sendJson(res, 400, { error: '缺少/非法 type 或 value' });
      if (!stars.some((s) => s.type === type && s.value === value)) {
        stars.push({ id: ++starSeq, type, value, label: String(body.label || value).trim() });
        saveStars();
      }
      return sendJson(res, 200, { stars: stars.map(starView) });
    }
    if (p === '/api/stars/delete' && method === 'POST') {
      const body = await readBody(req);
      stars = stars.filter((s) => s.id !== Number(body.id));
      saveStars();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/cache' && method === 'GET') {
      const now = Math.floor(Date.now() / 1000);
      const list = [];
      for (const [k, v] of streamCache) {
        if (!v || v.expiry <= now + 5) continue;
        const i = k.indexOf('-');
        list.push({
          course_id: k.slice(0, i), sub_id: k.slice(i + 1),
          title: v.title || '', room: v.room || '',
          expiry: v.expiry, count: (v.streams || []).length,
        });
      }
      list.sort((a, b) => (a.room || '').localeCompare(b.room || '') || (a.title || '').localeCompare(b.title || ''));
      return sendJson(res, 200, { autoRooms: AUTOCACHE_ROOMS, list });
    }

    if (p === '/api/thumb' && method === 'GET') {
      const courseId = url.searchParams.get('course_id');
      const subId = url.searchParams.get('sub_id');
      if (!courseId || !subId) { res.writeHead(400); return res.end('missing ids'); }
      try {
        if (!readJwt() && hasCreds()) await autoRelogin().catch(() => {});
        if (!readJwt()) { res.writeHead(404); return res.end('no jwt'); }
        return await serveThumb(res, courseId, subId, readJwt());
      } catch (e) { res.writeHead(404); return res.end('thumb error'); }
    }

    // 布局存档：详情页布局保存在浏览器 localStorage 中，服务端读不到；
    // 因此在服务端也留一份 JSON，便于排障与恢复默认布局。仅存本机。
    if (p === '/api/ui-layout' && method === 'GET') {
      try {
        const raw = fs.readFileSync(UI_LAYOUT_FILE, 'utf8');
        return sendJson(res, 200, { layout: JSON.parse(raw) });
      } catch { return sendJson(res, 200, { layout: null }); }
    }
    if (p === '/api/ui-layout' && method === 'POST') {
      const body = await readBody(req);
      try {
        fs.writeFileSync(UI_LAYOUT_FILE, JSON.stringify((body && body.layout) ? body.layout : body, null, 1));
        return sendJson(res, 200, { ok: true, file: UI_LAYOUT_FILE });
      } catch (e) { return sendJson(res, 500, { error: e.message }); }
    }

    // 查老师（教评）：只读本地缓存；同步是一个显式的手动动作，进度走轮询（跟录制任务同一套做法）。
    // 列表接口只回"姓名 -> 分数"这种轻量数据（首页/详情页要显示），绩点那种重的按需单独取。
    if (p === '/api/chalaoshi' && method === 'GET') {
      const teachers = {};
      let ok = 0, none = 0, multiple = 0;
      for (const [name, e] of Object.entries(chalaoshi.teachers || {})) {
        if (e.status === 'ok') ok++;
        else if (e.status === 'multiple') multiple++;
        else none++;
        teachers[name] = (e.status === 'ok')
          ? { status: 'ok', score: e.score == null ? null : e.score,
              ratingCount: e.ratingCount == null ? null : e.ratingCount,
              tid: e.tid || null, siteCollege: e.siteCollege || '' }
          : { status: e.status, candidates: (e.candidates || []).map((x) => ({ tid: x.tid, college: x.college, score: x.score })) };
      }
      return sendJson(res, 200, {
        updatedAt: chalaoshi.updatedAt || 0,
        source: chalaoshi.source || clBase,
        bases: CHALAOSHI_BASES,
        gapMs: CL_GAP_MS,
        stats: {
          total: Object.keys(teachers).length, ok, none, multiple,
          pendingWatch: clPending(false, 'watch').length,
          pendingAll: clPending(false, 'all').length,
          needDetail: clNeedDetail().length,
        },
        // 教师池的真实规模：同步范围就是这么算出来的，出问题时先看这几个数
        pool: {
          known: clKnown.size, watch: clWatch.size,
          snapshotCourses: (coursesSnapshot.courses || []).length,
          snapshotAt: coursesSnapshot.at || 0,
        },
        running: clSync.running,
        teachers,
      });
    }
    if (p === '/api/chalaoshi/teacher' && method === 'GET') {
      const name = url.searchParams.get('name') || '';
      const e = chalaoshi.teachers[name];
      if (!e) return sendJson(res, 200, { found: false, name, updatedAt: chalaoshi.updatedAt || 0 });
      return sendJson(res, 200, { found: true, name, entry: e, source: chalaoshi.source || clBase, updatedAt: chalaoshi.updatedAt || 0 });
    }
    if (p === '/api/chalaoshi/sync' && method === 'POST') {
      const body = await readBody(req);
      if (clSync.running) return sendJson(res, 200, { started: false, reason: 'running', id: clSync.id, total: clSync.total, done: clSync.done });
      // 三种同步：默认只抓"能看的课"的老师（437 位，约 15 分钟）；
      // scope=all 抓快照里的全部（1543 位，约一小时）；detailOnly 只给已匹配的补详情。
      const scope = body.scope === 'all' ? 'all' : 'watch';
      let list, withDetail = !!body.detail;
      if (body.detailOnly) { list = clNeedDetail(); withDetail = true; }
      else list = clPending(!!body.force, scope);
      if (!list.length) return sendJson(res, 200, { started: false, reason: 'nothing', pending: 0, scope });
      clSync = { id: ++clSeq, running: true, cancelled: false, total: list.length, done: 0, ok: 0,
        none: 0, multiple: 0, failed: 0, current: '', startedAt: Date.now(), finishedAt: 0, lastError: '' };
      runClSync(list, withDetail).catch((e) => { clSync.running = false; clSync.lastError = e.message; });
      // 估时：每个教师 1 或 2 个请求，每个带 1 个间隔
      const perMs = CL_GAP_MS + 1200 + (withDetail ? CL_GAP_MS + 1100 : 0);
      return sendJson(res, 200, { started: true, id: clSync.id, total: list.length, scope,
        detail: withDetail, gapMs: CL_GAP_MS, etaMs: Math.round(list.length * perMs), source: clBase });
    }
    if (p === '/api/chalaoshi/sync' && method === 'GET') {
      const elapsed = clSync.startedAt ? Date.now() - clSync.startedAt : 0;
      const eta = (clSync.running && clSync.done) ? Math.round(elapsed / clSync.done * (clSync.total - clSync.done)) : 0;
      return sendJson(res, 200, Object.assign({}, clSync, { elapsedMs: elapsed, etaMs: eta }));
    }
    if (p === '/api/chalaoshi/sync/stop' && method === 'POST') {
      if (clSync.running) clSync.cancelled = true;
      return sendJson(res, 200, { ok: true, running: clSync.running });
    }
    // 同名撞车时人工挑一个（抽屉里把候选列出来，点一下就定下来）
    if (p === '/api/chalaoshi/pick' && method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const tid = String(body.tid || '').trim();
      const e = chalaoshi.teachers[name];
      const cand = e && (e.candidates || []).find((x) => String(x.tid) === tid);
      if (!cand) return sendJson(res, 400, { error: '没有这个候选' });
      e.status = 'ok';
      e.tid = cand.tid;
      e.score = cand.score;
      e.siteCollege = cand.college;
      e.at = Date.now();
      try { await clEnrich(e); } catch {}
      chalaoshi.updatedAt = Date.now();
      saveChalaoshi();
      return sendJson(res, 200, { ok: true, name, entry: e });
    }

    if (p === '/api/hls' && method === 'GET') {
      const target = url.searchParams.get('u');
      if (!target) { res.writeHead(400); return res.end('missing u'); }
      try { return await proxyHls(res, target); }
      catch (e) { if (!res.headersSent) res.writeHead(502); return res.end('proxy error: ' + e.message); }
    }

    // 录制中转：ffmpeg 只读本机，由本服务去上游取（与网页同一套网络栈）
    if (p.startsWith('/relay/') && method === 'GET') {
      const target = url.searchParams.get('u');
      if (!target) { res.writeHead(400); return res.end('missing u'); }
      return relayStream(res, target);
    }

    if (p === '/api/record' && method === 'POST') {
      const body = await readBody(req);
      const { label, course, key } = body;
      const streamUrl = body.recordUrl || body.url;
      if (!streamUrl || !label || !course)
        return sendJson(res, 400, { error: '缺少 url/label/course' });
      if ((key && key !== 'teacher') || (!key && !/主画面|教师/.test(String(label))))
        return sendJson(res, 400, { error: '当前只支持录制主画面' });
      return sendJson(res, 200, { job: jobView(startRecording({ url: streamUrl, label, course })) });
    }

    if (p === '/api/jobs' && method === 'GET')
      return sendJson(res, 200, { jobs: [...jobs.values()].map(jobView) });

    if (p === '/api/stop' && method === 'POST') {
      const body = await readBody(req);
      if (!stopRecording(Number(body.id))) return sendJson(res, 404, { error: '任务不存在' });
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/shutdown' && method === 'POST') {
      sendJson(res, 200, { ok: true });
      shutdown();
      return;
    }

    // ---------- ASR sidecar（可选；未安装时 available:false，其余接口原样） ----------
    if (p === '/api/asr/status' && method === 'GET') {
      const avail = asrAvailability(true);
      const active = avail.activeSessionId ? asrSessions.get(avail.activeSessionId) : null;
      return sendJson(res, 200, Object.assign(avail, {
        session: active ? asrSessionView(active) : null,
        // 诊断信息：只给判定与字节数，不带路径中的用户名
        protocolErrors: active ? active.protocolErrors : 0,
      }));
    }

    if (p === '/api/asr/start' && method === 'POST') {
      const body = await readBody(req);
      if (!body.streamRef) return sendJson(res, 400, { error: '缺少 streamRef' });
      try {
        const s = startAsrSession(String(body.streamRef), {});
        return sendJson(res, 200, { session: asrSessionView(s) });
      } catch (e) {
        return sendJson(res, e.statusCode || 500, { error: e.message });
      }
    }

    if (p === '/api/asr/stop' && method === 'POST') {
      const body = await readBody(req);
      const id = Number(body.id);
      if (!asrSessions.has(id)) return sendJson(res, 404, { error: '会话不存在' });
      stopAsrSession(id);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/asr/session' && method === 'GET') {
      const s = asrSessions.get(Number(url.searchParams.get('id')));
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      return sendJson(res, 200, asrSessionView(s));
    }

    if (p === '/api/asr/events' && method === 'GET') {
      const s = asrSessions.get(Number(url.searchParams.get('id')));
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      const lastId = url.searchParams.get('lastEventId') || req.headers['last-event-id'];
      return attachSse(s, res, Number(lastId) || 0);
    }

    if (p === '/api/asr/export' && method === 'GET') {
      const s = asrSessions.get(Number(url.searchParams.get('id')));
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      const fmt = ['txt', 'srt', 'json'].includes(url.searchParams.get('format'))
        ? url.searchParams.get('format') : 'txt';
      const out = asrExport(s, fmt);
      res.writeHead(200, {
        'content-type': out.type,
        'content-disposition': `attachment; filename="${out.name}"`,
        'cache-control': 'no-store',
      });
      return res.end(out.body);
    }

    if (p === '/api/asr/debug' && method === 'GET') {
      // 排障用：worker 的 stderr 尾部 + ffmpeg 的 stderr 尾部（都不含 URL 签名）
      const s = asrSessions.get(Number(url.searchParams.get('id')));
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      const stripUrls = (t) => String(t || '').replace(/https?:\/\/[^\s"']+/g, (m) => {
        try { const u = new URL(m); return u.origin + u.pathname + '?<redacted>'; } catch { return '<url>'; }
      });
      return sendJson(res, 200, {
        session: asrSessionView(s),
        protocolErrors: s.protocolErrors,
        stderrBytes: s.stderrBytes,
        workerStderr: stripUrls(s.stderrTail).slice(-4000),
        ffmpegStderr: stripUrls(s.ffmpegStderr).slice(-4000),
      });
    }

    // ---------- 播放诊断 ----------
    // 网页端播放事件上报（照旧写 console 的同时也送到这里，便于不开 DevTools 排障）
    if (p === '/api/play-log' && method === 'POST') {
      const body = await readBody(req);
      const list = Array.isArray(body.events) ? body.events : [body];
      let n = 0;
      for (const e of list.slice(0, 300)) {
        if (!e || typeof e !== 'object') continue;
        const clean = {};
        for (const [k, v] of Object.entries(e)) {
          if (v === undefined || v === null) continue;
          clean[String(k).slice(0, 40)] = typeof v === 'object' ? v : String(v).slice(0, 300);
        }
        diagLog('client', clean);
        n++;
      }
      return sendJson(res, 200, { ok: true, stored: n, total: playLogSeq });
    }

    if (p === '/api/play-log' && method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 300) || 300, 2000);
      return sendJson(res, 200, {
        total: playLogSeq,
        file: PLAY_LOG_FILE,
        events: playLog.slice(-limit),
      });
    }

    // 探一个候选地址：能不能播、慢在哪、什么时候过期
    if (p === '/api/probe' && method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return sendJson(res, 400, { error: '缺少 url' });
      const r = await probeStreamUrl(String(body.url), { deep: body.deep !== false });
      diagLog('probe', { host: r.host, path: r.path, verdict: r.verdict, status: r.status, ttfbMs: r.ttfbMs });
      return sendJson(res, 200, r);
    }

    // 探一个场次的全部候选（含当前被前端静默丢弃的 webrtc/mp4 候选）+ 播放列表是否在推进
    if (p === '/api/probe/session' && method === 'GET') {
      const courseId = url.searchParams.get('course_id');
      const subId = url.searchParams.get('sub_id');
      if (!courseId || !subId) return sendJson(res, 400, { error: '缺少 course_id/sub_id' });
      try {
        if (!readJwt() && hasCreds()) await autoRelogin().catch(() => {});
        if (!readJwt()) return sendJson(res, 400, { error: '尚未设置 JWT token' });
        const meta = { title: url.searchParams.get('title') || '', room: url.searchParams.get('room') || '' };
        const r = await withRelogin(() => resolveStreams(readJwt(), courseId, subId, meta));

        // 收集全部候选：watch / record / alternates，逐个去重
        const cands = [];
        for (const s of r.streams) {
          if (s.watchUrl) cands.push({ key: s.key, label: s.label, role: 'watch', url: s.watchUrl });
          if (s.recordUrl && s.recordUrl !== s.watchUrl) cands.push({ key: s.key, label: s.label, role: 'record', url: s.recordUrl });
          for (const a of (s.alternates || [])) if (a && a.url) cands.push({ key: s.key, label: s.label, role: a.role || 'alt', url: a.url });
        }
        const seen = new Set();
        const uniq = cands.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));

        const probes = [];
        for (const c of uniq) {
          // 必须抽样分片：只看播放列表会漏掉「列表正常但分片 404」这类致命情况
          // （已知：m3u8 返回 200 且为 live，而播放器需要的分片全部 404）
          const p1 = await probeStreamUrl(c.url, { deep: true });
          probes.push(Object.assign({ key: c.key, label: c.label, role: c.role }, p1));
        }
        // 对能读出播放列表的直播候选，再测一次列表是否在推进（停滞会让播放器反复读同一分片）
        for (const p1 of probes) {
          if (p1.live && p1.segmentCount) {
            try { p1.advance = await probePlaylistAdvance(p1.url, p1.targetDuration); } catch (e) { p1.advance = { error: String(e.message || e) }; }
          }
        }
        // 不支持网页播放的候选（北教部分教室只给 webrtc）也列出来，否则表现为「机位凭空消失」
        for (const d of (r.dropped || [])) {
          probes.push({
            key: d.key, label: d.label, role: 'unsupported', type: d.type, host: d.host,
            hostAllowed: false, verdict: 'unsupported-' + d.type,
            note: d.type === 'webrtc'
              ? '该机位只提供 webrtc，浏览器无法直接播放（这不是老师没投屏，也不是网络问题）'
              : '该地址类型不支持网页播放',
          });
        }
        lastSessionProbe = { at: Date.now(), courseId, subId, source: r.source, expiry: r.expiry, probes: probes.map(redactProbeForLog) };
        diagLog('probe-session', { courseId, subId, source: r.source, count: probes.length });
        return sendJson(res, 200, { source: r.source, expiry: r.expiry, probes });
      } catch (e) {
        return sendJson(res, 502, { error: e.message });
      }
    }

    // 汇总一份可读报告，落到 home 下的诊断目录（不进录制目录，不污染存储统计）
    if (p === '/api/diag/report' && method === 'GET') {
      const rep = buildDiagReport();
      return sendJson(res, 200, rep);
    }

    if (method === 'GET') return serveStatic(res, p);
    res.writeHead(404); res.end('not found');
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// 只绑定回环地址：仅本机可访问
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ZJU 录制 Web 已启动（仅限本机）→  http://127.0.0.1:${PORT}\n`);
  console.log(`  租户(tenant): ${TENANT}  ·  录制保存到: ${OUTPUT_DIR}\n`);
});

function shutdown() {
  // ASR 先停：它不产出需要收尾的文件，但要把子进程带走，避免留下孤儿
  try { stopAllAsr(); } catch {}
  const active = [...jobs.values()].filter((j) => j.status === 'recording');
  if (!active.length) { process.exit(0); return; }
  // 等待 ffmpeg 退出并写完最后一段的 moov 后再结束进程。
  let left = active.length;
  for (const j of active) {
    j.proc.once('exit', () => { if (--left === 0) process.exit(0); });
    gracefulStop(j);
  }
  // 兜底：ffmpeg 卡住不退出时也要能关掉服务
  setTimeout(() => process.exit(0), STOP_GRACE_MS + 2000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------- 进程级兜底 ----------
// 未捕获异常会写入诊断日志，避免中断已在运行的录制任务。
process.on('uncaughtException', (e) => {
  const msg = (e && e.stack) || String(e);
  console.error('[fatal-guard] 未捕获异常（已记录，进程继续运行）:', msg);
  try { diagLog('uncaught-exception', { message: String((e && e.message) || e).slice(0, 300), code: e && e.code }); } catch {}
});
process.on('unhandledRejection', (e) => {
  const msg = (e && e.stack) || String(e);
  console.error('[fatal-guard] 未处理的 Promise 拒绝（已记录，进程继续运行）:', msg);
  try { diagLog('unhandled-rejection', { message: String((e && e.message) || e).slice(0, 300), code: e && e.code }); } catch {}
});
