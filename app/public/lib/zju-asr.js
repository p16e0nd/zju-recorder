// ============================================================
//  zju-asr —— 实时字幕面板。
//  按 seq 去重 + 接回会话时对齐 lastEventId，否则刷新/重连会把 final 重复追加。
//
//  用法：
//    ZJU.Asr.mount({ panel, dot, state, meta, live, body, hint, buttons... })
//    ZJU.Asr.start(stream)   // stream 需要带 streamRef
//    ZJU.Asr.stop()
// ============================================================
(function (global) {
  'use strict';
  const { api, toast, fmtDur, el } = global.ZJU;

  let D = null;                 // DOM 引用
  let session = null, es = null, segs = [], lastSeq = 0, metaRef = null, timer = null;

  function mount(refs) { D = refs; syncIdle(); }   // 挂载时先按「未开启」摆好按钮，别把停止/导出都亮着
  function els() { return D; }

  function showState(status, error) {
    if (!D) return;
    const map = {
      idle: ['', '未开启'],
      starting: ['load', '模型加载中…'], loading: ['load', '模型加载中…'],
      running: ['live', '识别中'], stopping: ['load', '正在停止…'],
      stopped: ['', '已停止'], error: ['err', '出错'],
    };
    const [kind, text] = map[status] || ['', '未开启'];
    D.dot.className = 'asr-dot ' + kind;
    D.state.textContent = text;
    if (error) { D.dot.className = 'asr-dot err'; D.state.textContent = '已降级'; }
  }
  const hint = (t) => { if (D) D.hint.textContent = t || ''; };

  // 墙钟时间才是能对上录像（HHMMSS.mp4）的锚点；直播流没有可 seek 的时间轴
  function wallClock(t0Ms) {
    const base = (metaRef && metaRef.startedAt) ? metaRef.startedAt : Date.now();
    const d = new Date(base + (t0Ms || 0));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  // **新的在最上面**（直播的读法）：最新的段落在列表顶部，往回看要往下滑。
  // 已经向下滚动阅读时不要强制滚回顶部，否则会打断阅读。
  function renderSegs() {
    if (!D) return;
    const atTop = D.body.scrollTop <= 8;
    D.body.textContent = '';
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      const row = el('div', 'asr-seg');
      const ts = el('span', 'ts', wallClock(s.t0Ms));
      ts.title = '点一下复制这句';
      ts.onclick = () => copyText(s.text);
      const tx = el('span', 'tx', s.text);       // 只走 textContent
      row.appendChild(ts); row.appendChild(tx);
      D.body.appendChild(row);
    }
    if (atTop) D.body.scrollTop = 0;
    syncIdle();
  }
  // 未开启时也要占住位置（右栏的"空格"），并给出开始入口
  function syncIdle() {
    if (!D || !D.panel) return;
    const running = !!(session && !['stopped', 'error'].includes(session.status));
    D.panel.classList.toggle('idle', !running && !segs.length);
    if (D.startBtn) D.startBtn.style.display = running ? 'none' : '';
    if (D.stopBtn) D.stopBtn.style.display = running ? '' : 'none';
    if (D.expoBtns) for (const b of D.expoBtns) b.style.display = segs.length ? '' : 'none';
  }
  function setLive(text) {
    if (!D) return;
    D.live.textContent = '';
    if (!text) return;
    D.live.appendChild(el('span', 'ts', '正在听'));
    D.live.appendChild(el('span', null, text));
  }
  function metaText() {
    if (!D || !session) { if (D) D.meta.textContent = ''; return; }
    const secs = Math.floor(((session.endedAt || Date.now()) - (session.startedAt || Date.now())) / 1000);
    const parts = [];
    if (session.course) parts.push(session.course);
    if (session.label) parts.push(session.label);
    parts.push('已听 ' + fmtDur(secs), segs.length + ' 段');
    if (session.rtf != null) parts.push('RTF ' + Number(session.rtf).toFixed(2));
    if (session.rssMb != null) parts.push(Math.round(session.rssMb) + 'MB');
    D.meta.textContent = parts.join(' · ');
  }
  function copyText(t) {
    const text = t != null ? t : segs.map((s) => '[' + wallClock(s.t0Ms) + '] ' + s.text).join('\n');
    if (!text) { toast('还没有内容'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('已复制 ' + text.length + ' 字'), () => toast('复制失败'));
    } else toast('这个浏览器不支持自动复制，请用「导出 TXT」');
  }
  function exportAs(kind) {
    const lines = kind === 'srt'
      ? segs.map((s, i) => {
          const f = (ms) => {
            const t = Math.max(0, Math.round(ms));
            const p = (n, w) => String(n).padStart(w, '0');
            return p(Math.floor(t / 3600000), 2) + ':' + p(Math.floor(t % 3600000 / 60000), 2) + ':' +
                   p(Math.floor(t % 60000 / 1000), 2) + ',' + p(t % 1000, 3);
          };
          return (i + 1) + '\n' + f(s.t0Ms) + ' --> ' + f(s.t1Ms) + '\n' + s.text + '\n';
        }).join('\n')
      : segs.map((s) => '[' + wallClock(s.t0Ms) + '] ' + s.text).join('\n');
    if (!lines) { toast('还没有内容'); return; }
    const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'zju-字幕-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.' + kind;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function closeSse() { if (es) { try { es.close(); } catch {} es = null; } }
  function handleEvent(ev) {
    // **必须按 seq 去重**：接回/断线重连时服务端会重放最近事件，不去重 final 就会重复
    if (typeof ev.seq === 'number') {
      if (ev.seq <= lastSeq) return;
      lastSeq = ev.seq;
    }
    if (ev.audioMs != null && session) session.audioMs = ev.audioMs;
    if (ev.type === 'ready') showState('running');
    else if (ev.type === 'partial') setLive(ev.text || '');
    else if (ev.type === 'final') {
      setLive('');
      if (ev.text && ev.text.trim()) { segs.push({ t0Ms: ev.t0Ms || 0, t1Ms: ev.t1Ms || 0, text: ev.text }); renderSegs(); }
    } else if (ev.type === 'metric') {
      if (session) { session.rtf = ev.rtf; session.rssMb = ev.rssMb; }
    } else if (ev.type === 'error') {
      showState('error', ev.message || ev.code);
      hint('识别出错：' + (ev.message || ev.code));
    } else if (ev.type === 'restart') {
      showState('loading'); hint('正在自动重启');
    } else if (ev.type === 'stopped' || ev.type === 'closed') {
      showState(ev.type === 'closed' && ev.status === 'error' ? 'error' : 'stopped');
      closeSse();
    }
    metaText();
  }
  function connect(id) {
    closeSse();
    const src = '/api/asr/events?id=' + encodeURIComponent(id) + '&lastEventId=' + lastSeq;
    es = new EventSource(src);
    es.onmessage = (m) => { try { handleEvent(JSON.parse(m.data)); } catch {} };
    es.onerror = () => {
      if (es && es.readyState === 2) {
        api('/api/asr/session?id=' + encodeURIComponent(id)).then((s) => {
          metaRef = s; session = Object.assign({}, session, s);
          segs = (s.finals || []).map((f) => ({ t0Ms: f.t0Ms, t1Ms: f.t1Ms, text: f.text }));
          renderSegs(); showState(s.status, s.error); metaText(); syncIdle(); closeSse();
        }).catch(() => {});
      }
    };
  }

  async function start(stream) {
    if (!D) return;
    hint(''); showState('starting'); D.state.textContent = '正在准备…';
    let st;
    try { st = await api('/api/asr/status'); }
    catch (err) { showState('error'); hint('取不到 ASR 状态：' + err.message); return; }
    if (!st.available) {
      showState('error');
      D.hint.textContent = '';
      D.hint.appendChild(el('div', null, '语音识别不可用：'));
      const ul = el('ul', 'asr-problem');
      for (const p of (st.problems || ['原因未知'])) ul.appendChild(el('li', null, p));
      D.hint.appendChild(ul);
      D.meta.textContent = '';
      return;
    }
    // 服务端是单路的，且刷新页面不会停掉它 —— 有在跑的会话就接回去，别去撞 409
    if (st.activeSessionId && st.session) {
      session = st.session; metaRef = st.session;
      segs = (st.session.finals || []).map((f) => ({ t0Ms: f.t0Ms, t1Ms: f.t1Ms, text: f.text }));
      lastSeq = (st.session.stats && st.session.stats.events) || 0;
      renderSegs(); setLive(st.session.partial || '');
      showState(st.session.status, st.session.error);
      metaText(); connect(st.session.id);
      return;
    }
    if (!stream || !stream.ref) {
      showState('error');
      hint('这一路没有字幕引用，重新打开这门课');
      return;
    }
    try {
      const r = await api('/api/asr/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamRef: stream.ref }),
      });
      session = r.session; metaRef = r.session;
      segs = []; lastSeq = 0; renderSegs(); setLive(''); syncIdle();
      showState(session.status || 'loading');
      metaText(); connect(session.id);
    } catch (err) { showState('error'); hint('启动识别失败：' + err.message); }
  }

  async function stop() {
    if (!session) return;
    showState('stopping');
    try { await api('/api/asr/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: session.id }) }); } catch {}
    try {
      const s = await api('/api/asr/session?id=' + encodeURIComponent(session.id));
      session = Object.assign({}, session, s);
      segs = (s.finals || []).map((f) => ({ t0Ms: f.t0Ms, t1Ms: f.t1Ms, text: f.text }));
      lastSeq = (s.stats && s.stats.events) || lastSeq;
      renderSegs(); showState(s.status, s.error); metaText(); syncIdle();
    } catch {}
    closeSse();
  }

  const isRunning = () => !!(session && !['stopped', 'error'].includes(session.status));
  const current = () => session;
  function tick() { if (D && session && !D.panel.hidden) metaText(); }
  function bind() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 1000);
  }

  global.ZJU.Asr = {
    mount, bind, start, stop, isRunning, current, els, syncIdle,
    setIdle() { closeSse(); session = null; metaRef = null; segs = []; lastSeq = 0; renderSegs(); setLive(''); showState('idle'); syncIdle(); },
    exportAs, copyText, showState, hint, wallClockSegments: () => segs,
    reset() { closeSse(); session = null; metaRef = null; segs = []; lastSeq = 0; renderSegs(); setLive(''); },
  };
})(window);
