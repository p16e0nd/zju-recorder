// ============================================================
//  zju-core —— 前端共用的 DOM、HTTP、格式化与主题工具。
//  无前端框架和构建步骤。
// ============================================================
(function (global) {
  'use strict';

  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));

  // 建元素：el('div', 'cls', '文本') —— 文本一律走 textContent（XSS 硬要求）
  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 2800);
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || (text || '').slice(0, 160) || ('HTTP ' + res.status);
      const e = new Error(msg);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }
  const postJson = (path, body) => api(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });

  function fmtDur(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
  }
  function fmtRemain(exp) {
    const s = (exp || 0) - Math.floor(Date.now() / 1000);
    if (s <= 0) return '已过期';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `剩 ${h}h${m}m` : `剩 ${m}m`;
  }
  function fmtBytes(b) {
    if (!b) return '0';
    const u = ['B', 'K', 'M', 'G', 'T'];
    let i = 0, n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : n) + u[i];
  }
  // 大数量的紧凑显示。
  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }
  const fmtClock = (ts) => {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const fmtDateTime = (ts) => {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  // ---------- 主题（选择记在 localStorage）----------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('theme', t); } catch {}
    const btn = document.getElementById('themeToggle');
    // 仅更新纯文字按钮，避免覆盖 SVG 图标。
    if (btn && !btn.querySelector('svg')) btn.textContent = t === 'dark' ? '亮色' : '暗色';
  }
  function initTheme() {
    let t = 'light';
    try { t = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch {}
    applyTheme(t);
  }
  const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

  global.ZJU = {
    $, $$, el, esc, toast, api, postJson,
    fmtDur, fmtRemain, fmtBytes, fmtCount, fmtClock, fmtDateTime,
    initTheme, toggleTheme, applyTheme,
  };
})(window);
