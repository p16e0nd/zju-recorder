'use strict';
// ZJUAM 统一认证自动登录 — 零依赖（Node 内置 BigInt + fetch）。
//
// 链路（逆向自 classroom 的 SSO）：
//   casapi auth/login → cas/oauth2.0/authorize → cas/login(输账密)
//   → POST(username + RSA(密码反转) + execution) → ticket
//   → callbackAuthorize → tgmedia get-info?code=ST-xxx
//   → 该响应 Set-Cookie: _token=<Yii签名>{... "eyJ...JWT..." } → 302 classroom
// JWT 即藏在 _token cookie 里。
//
// 用法（本机测试，密码走环境变量、不进 argv）：
//   ZJU_USER=学号 ZJU_PASS=密码 node zjuauth.js

// ---------- 密码 RSA（复刻 ohdave，已对真库逐字节验证）----------
function modpow(base, exp, mod) {
  let r = 1n; base %= mod;
  while (exp > 0n) { if (exp & 1n) r = (r * base) % mod; exp >>= 1n; base = (base * base) % mod; }
  return r;
}
function bigToHexDigits(x) {
  if (x === 0n) return '0000';
  const ds = [];
  while (x > 0n) { ds.push((x & 0xffffn).toString(16).padStart(4, '0')); x >>= 16n; }
  return ds.reverse().join('');
}
function encryptPassword(password, modulusHex, exponentHex) {
  const m = BigInt('0x' + modulusHex), e = BigInt('0x' + exponentHex);
  let dc = 0, t = m; while (t > 0n) { dc++; t >>= 16n; }
  const chunkSize = 2 * (dc - 1);
  const a = [];
  const rev = password.split('').reverse().join('');
  for (let i = 0; i < rev.length; i++) a.push(rev.charCodeAt(i));
  while (a.length % chunkSize !== 0) a.push(0);
  const parts = [];
  for (let i = 0; i < a.length; i += chunkSize) {
    let block = 0n;
    for (let j = 0, k = i; k < i + chunkSize; j++) {
      const lo = a[k++], hi = a[k++];
      block += (BigInt(lo) + (BigInt(hi) << 8n)) << BigInt(16 * j);
    }
    parts.push(bigToHexDigits(modpow(block, e, m)));
  }
  return parts.join(' ');
}

// ---------- 极简 cookie jar（按域/路径匹配，含 dom、host-only）----------
class CookieJar {
  constructor() { this.cookies = []; }
  setFrom(urlStr, setCookieList) {
    const host = new URL(urlStr).hostname;
    for (const sc of setCookieList || []) {
      const [nv, ...attrs] = sc.split(';');
      const eq = nv.indexOf('=');
      if (eq < 0) continue;
      const name = nv.slice(0, eq).trim();
      const value = nv.slice(eq + 1).trim();
      let domain = host, hostOnly = true, path = '/';
      for (const a of attrs) {
        const i = a.indexOf('=');
        const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
        const v = i < 0 ? '' : a.slice(i + 1).trim();
        if (k === 'domain' && v) { domain = v.replace(/^\./, ''); hostOnly = false; }
        else if (k === 'path' && v) path = v;
      }
      this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === domain && c.path === path));
      this.cookies.push({ name, value, domain, path, hostOnly });
    }
  }
  headerFor(urlStr) {
    const u = new URL(urlStr), host = u.hostname, path = u.pathname || '/';
    return this.cookies
      .filter((c) => {
        const domOk = c.hostOnly ? host === c.domain : (host === c.domain || host.endsWith('.' + c.domain));
        return domOk && path.startsWith(c.path);
      })
      .map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 手动跟随跳转 + 带 cookie jar；返回最终响应（已读 body）
async function follow(jar, url, { method = 'GET', body, headers = {}, trace } = {}, max = 15) {
  let curUrl = url, curMethod = method, curBody = body;
  for (let hop = 0; hop < max; hop++) {
    const h = { 'user-agent': UA, accept: 'text/html,application/json,*/*', ...headers };
    const cookie = jar.headerFor(curUrl);
    if (cookie) h.cookie = cookie;
    if (curBody && !h['content-type']) h['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(curUrl, { method: curMethod, body: curBody, headers: h, redirect: 'manual' });
    jar.setFrom(curUrl, res.headers.getSetCookie ? res.headers.getSetCookie() : []);
    if (trace) console.error(`  [${res.status}] ${curMethod} ${curUrl.slice(0, 90)}`);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      curUrl = new URL(loc, curUrl).href;
      curMethod = 'GET'; curBody = undefined; // 302/303 → GET
      continue;
    }
    const text = await res.text();
    return { status: res.status, url: curUrl, headers: res.headers, text };
  }
  throw new Error('跳转过多');
}

function extractJwtFromJar(jar) {
  const tok = jar.cookies.find((c) => c.name === '_token');
  if (!tok) return null;
  const decoded = decodeURIComponent(tok.value);
  const m = decoded.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
  return m ? m[0] : null;
}

async function login(username, password, { forward = 'https://classroom.zju.edu.cn/', tenant = '112', trace = false, dryRun = false } = {}) {
  const jar = new CookieJar();
  // 1) 入口 → 一路跳到 cas/login 表单页
  const start = `https://yjapi.cmc.zju.edu.cn/casapi/index.php?r=auth/login&forward=${encodeURIComponent(forward)}&tenant_code=${tenant}`;
  if (trace) console.error('① 走 SSO 链到登录页');
  const page = await follow(jar, start, { trace });
  if (!/zjuam\.zju\.edu\.cn\/cas\/login/.test(page.url))
    throw new Error('未跳到 cas 登录页（可能已被风控或链路变化），落在: ' + page.url);
  const exec = page.text.match(/name="execution"\s+value="([^"]+)"/);
  if (!exec) throw new Error('登录页未找到 execution 字段');
  const loginUrl = page.url;

  // 2) 公钥 + 加密
  if (trace) console.error('② 取公钥并加密密码');
  const pub = JSON.parse((await follow(jar, 'https://zjuam.zju.edu.cn/cas/v2/getPubKey', { trace })).text);
  const encPwd = encryptPassword(password, pub.modulus, pub.exponent);
  if (dryRun)
    return { dryRun: true, loginUrl, hasExecution: !!exec[1], pubKeyOk: !!pub.modulus, encLen: encPwd.length };

  // 3) POST 登录 → 跟随 ticket→oauth→tgmedia get-info（种下 _token）→ classroom
  if (trace) console.error('③ 提交登录并跟随回调链');
  const form = new URLSearchParams({ username, password: encPwd, execution: exec[1], _eventId: 'submit', authcode: '' });
  await follow(jar, loginUrl, { method: 'POST', body: form.toString(), trace });

  // 4) 从 cookie jar 抠出 JWT
  const jwt = extractJwtFromJar(jar);
  if (!jwt) throw new Error('登录后未拿到 _token/JWT（账号或密码错误？或回调链变化）');
  return jwt;
}

module.exports = { encryptPassword, login };

if (require.main === module) {
  const readline = require('readline');
  // 交互式问一句（hidden=true 时密码不回显，用 * 遮）
  function ask(q, hidden) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      if (hidden) rl._writeToOutput = (s) => { if (s.startsWith(q)) process.stdout.write(q); else process.stdout.write('*'); };
      rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
    });
  }
  (async () => {
    const u = process.env.ZJU_USER || await ask('学号: ', false);
    const p = process.env.ZJU_PASS || await ask('密码（输入不显示）: ', true);
    if (!u || !p) { console.error('学号/密码不能为空'); process.exit(1); }
    try {
      const jwt = await login(u, p, { trace: true });
      console.error('\n✅ 登录成功，拿到 JWT（前 40 位）：' + jwt.slice(0, 40) + '…  长度 ' + jwt.length);
    } catch (e) { console.error('\n❌ 失败:', e.message); process.exit(1); }
  })();
}
