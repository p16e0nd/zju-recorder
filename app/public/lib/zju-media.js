// ============================================================
//  zju-media —— 播放引擎选择、故障切换与遥测。
//  引擎互为兜底、画面看门狗（videoWidth==0 判定没画面）、直播空档自愈、
//  直连失败退回代理、卡顿看门狗、分片遥测 —— 这些都是稳定性所必需，改动前先理解其作用。
//  唯一改动：把页面相关的东西（提示文案位置、课程身份）改成可注入的钩子。
//
//  注入方式：
//    ZJU.Media.config({
//      getIdentity: () => ({ course, room }),   // 遥测里带上"这是哪门课/哪间教室"
//      onMessage: (video, text) => {...},       // 播不出来时的提示放哪
//      onStream: (stream) => {...},             // 页面记下"当前这一路"
//    });
// ============================================================
(function (global) {
  'use strict';
  const { el } = global.ZJU;

  const NO_SIGNAL = '该机位暂无画面';

  // 播放器库优先用本地打包的那份（public/ 下随项目一起走，不依赖外网）
  const LIB_SOURCES = {
    Hls: ['/hls.min.js', 'https://cdn.jsdelivr.net/npm/hls.js@1.5/dist/hls.min.js'],
    flvjs: ['/flv.min.js', 'https://cdn.jsdelivr.net/npm/flv.js@1.6/dist/flv.min.js'],
  };

  let cfg = {
    getIdentity: () => ({}),
    onMessage: (v, text) => {
      let m = v.nextElementSibling;
      if (!m || !m.classList.contains('pmsg')) { m = el('div', 'pmsg'); v.after(m); }
      m.textContent = text || '';
    },
    onStream: () => {},
  };

  // ---------- 诊断上报：写 console，同时批量送后端（不开 DevTools 也能排障）----------
  let playCtx = null;
  const playQueue = [];
  let playTimer = null;

  function urlParts(u) {
    try { const t = new URL(u, location.href); return { host: t.hostname, path: t.pathname }; }
    catch { return { host: '', path: '' }; }
  }
  function reportEvent(event, extra) {
    const id = cfg.getIdentity() || {};
    playQueue.push(Object.assign({
      event,
      mode: playCtx ? playCtx.mode : '',
      lib: playCtx ? playCtx.lib : '',
      tag: playCtx ? playCtx.tag : '',
      host: playCtx ? playCtx.host : '',
      path: playCtx ? playCtx.path : '',
      course: id.course || '', room: id.room || '',
    }, extra || {}));
    if (!playTimer) playTimer = setTimeout(flushPlayLog, 1500);
  }
  function flushPlayLog() {
    playTimer = null;
    if (!playQueue.length) return;
    const events = playQueue.splice(0, playQueue.length);
    try {
      fetch('/api/play-log', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events }), keepalive: true,
      }).catch(() => {});
    } catch {}
  }
  if (typeof addEventListener === 'function') addEventListener('pagehide', flushPlayLog);

  function logPlayer(kind, data, v) {
    const meta = Object.assign({ t: v.currentTime.toFixed(1), ranges: playerRanges(v) }, data || {});
    try { console.debug('[zju-player]', kind, meta); } catch {}
    if (kind === 'hls-error' || kind === 'flv-error' || kind === 'flv-fallback') {
      reportEvent(kind, {
        details: data && data.details, type: data && data.type, fatal: data && data.fatal,
        reason: data && data.reason, currentTime: v.currentTime.toFixed(1), ranges: playerRanges(v),
      });
    }
  }

  function loadLib(globalName, label) {
    if (window[globalName]) return Promise.resolve();
    const key = '_lib' + globalName;
    if (window[key]) return window[key];
    const urls = LIB_SOURCES[globalName] || [];
    window[key] = new Promise((ok, no) => {
      const t0 = Date.now();
      let i = 0;
      const tryNext = () => {
        if (i >= urls.length) return no(new Error(label + ' 加载失败（本地与 CDN 都取不到）'));
        const url = urls[i++];
        const s = document.createElement('script');
        s.src = url;
        const timer = setTimeout(() => { s.onerror = null; try { s.remove(); } catch {} tryNext(); }, 10000);
        s.onload = () => {
          clearTimeout(timer);
          reportEvent('lib-load', { lib: label, ok: true, ms: Date.now() - t0, from: url.charAt(0) === '/' ? 'local' : 'cdn' });
          ok();
        };
        s.onerror = () => { clearTimeout(timer); try { s.remove(); } catch {} tryNext(); };
        document.head.appendChild(s);
      };
      tryNext();
    });
    return window[key];
  }
  const ensureHls = () => loadLib('Hls', 'hls.js');
  const ensureFlv = () => loadLib('flvjs', 'flv.js');

  function playerRanges(v) {
    const ranges = [];
    try {
      for (let i = 0; i < v.buffered.length; i++) ranges.push([v.buffered.start(i).toFixed(1), v.buffered.end(i).toFixed(1)]);
    } catch {}
    return ranges;
  }
  const msg = (v, text) => { try { cfg.onMessage(v, text); } catch {} };

  // 卡顿看门狗：只观测。画面长时间不前进记一条，恢复时补记恢复耗时。
  function reportPlayStats(v) {
    const m = v && v._m;
    if (!m || !m.fragments) return;
    const arr = m.fragMs || [];
    reportEvent('play-stats', {
      fragments: m.fragments, errors: m.errors || 0,
      avgFragMs: arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null,
      maxFragMs: arr.length ? Math.max.apply(null, arr) : null,
      currentTime: +v.currentTime.toFixed(1), buffered: playerRanges(v),
    });
    m.fragments = 0; m.errors = 0; m.fragMs = [];
  }
  let watchdogTimer = null, watchT = 0, watchAt = 0, stallReported = false, stallStart = 0, watchTicks = 0;
  function startWatchdog(v) {
    stopWatchdog();
    watchT = 0; watchAt = Date.now(); stallReported = false; watchTicks = 0;
    watchdogTimer = setInterval(() => {
      try {
        if (++watchTicks % 60 === 0) reportPlayStats(v);
        if (v.paused || v.ended) { watchT = v.currentTime; watchAt = Date.now(); return; }
        const now = Date.now();
        if (Math.abs(v.currentTime - watchT) < 0.05) {
          const stuck = (now - watchAt) / 1000;
          if (stuck > 5 && !stallReported) {
            stallReported = true; stallStart = watchAt;
            reportEvent('stall', {
              sec: +stuck.toFixed(1), readyState: v.readyState, networkState: v.networkState,
              currentTime: +v.currentTime.toFixed(1), ranges: playerRanges(v),
            });
          }
        } else {
          if (stallReported) {
            stallReported = false;
            reportEvent('stall-recovered', { recoverSec: +((now - stallStart) / 1000).toFixed(1) });
          }
          watchT = v.currentTime; watchAt = now;
        }
      } catch {}
    }, 1000);
  }
  function stopWatchdog() { if (watchdogTimer) clearInterval(watchdogTimer); watchdogTimer = null; stallReported = false; }

  function streamName(s) {
    const watchType = s.watchType || s.type;
    const recordType = s.recordType || s.type;
    let suffix = '';
    if (watchType && watchType !== 'hls') suffix = ' · 观看 ' + watchType.toUpperCase();
    if (recordType && recordType !== watchType) suffix += ' · 录制 ' + recordType.toUpperCase();
    return (s.label || '') + suffix;
  }

  // 画面看门狗：分片在加载、时间在走，但 videoWidth 一直为 0 = 根本没出画面。
  // 两套引擎的适用面不同（Chromium 原生分支无法播放），因此出不了画面就换另一种，每种最多一次。
  function armPictureWatch(v, m3u8, opts, engine) {
    clearTimeout(v._picTimer);
    v._engineTried = v._engineTried || {};
    v._engineTried[engine] = true;
    v._picTimer = setTimeout(() => {
      if (v.videoWidth > 0) return;
      const other = engine === 'native' ? 'hls' : 'native';
      reportEvent('no-picture', {
        engine, readyState: v.readyState, currentTime: +v.currentTime.toFixed(1),
        buffered: playerRanges(v), switching: !v._engineTried[other],
      });
      if (v._engineTried[other]) return;
      msg(v, '换播放引擎');
      playHls(v, m3u8, Object.assign({}, opts, { engine: other, tag: (opts.tag || '') + ':switch' }));
    }, 9000);
  }

  // mode: 'direct'（默认，分片耗时约为经代理的一半）| 'proxy'（经本机 /api/hls）
  // opts.engine: 'hls' | 'native' 显式指定引擎（默认优先 hls.js）
  function playHls(v, m3u8, opts) {
    opts = opts || {};
    const mode = opts.mode === 'proxy' ? 'proxy' : 'direct';
    const src = mode === 'direct' ? m3u8 : '/api/hls?u=' + encodeURIComponent(m3u8);
    const parts = urlParts(m3u8);
    const nativeType = v.canPlayType('application/vnd.apple.mpegurl');
    playCtx = { mode, lib: 'hls.js', tag: opts.tag || '', host: parts.host, path: parts.path };
    if (v._f) { try { v._f.destroy(); } catch {} v._f = null; }
    if (v._h) { try { v._h.destroy(); } catch {} v._h = null; }
    v.onplaying = () => msg(v, '');
    // 原生 HLS 只作兜底：canPlayType 会乐观回答 "maybe"，而桌面 Chromium 并不实现 HLS
    const playNative = (reason) => {
      playCtx = { mode, lib: 'native', tag: opts.tag || '', host: parts.host, path: parts.path };
      reportEvent('play-start', { canPlayType: nativeType, reason });
      startWatchdog(v);
      const t = setTimeout(() => {
        if (v.readyState < 2) reportEvent('native-no-data', { canPlayType: nativeType, readyState: v.readyState, currentTime: +v.currentTime.toFixed(1) });
      }, 6000);
      v.onloadeddata = () => clearTimeout(t);
      v.onerror = () => {
        reportEvent('native-error', { code: v.error && v.error.code, message: v.error && v.error.message });
        if (!v._engineTried || !v._engineTried.hls) {
          msg(v, '换 hls.js');
          return playHls(v, m3u8, Object.assign({}, opts, { engine: 'hls', tag: (opts.tag || '') + ':switch' }));
        }
        msg(v, NO_SIGNAL);
      };
      v.src = src;
      v.play().catch(() => reportEvent('autoplay-blocked'));
      armPictureWatch(v, m3u8, opts, 'native');
    };
    if (opts.engine === 'native') return playNative('forced');
    ensureHls().then(() => {
      if (!global.Hls.isSupported()) { reportEvent('hls-unsupported', { canPlayType: nativeType }); playNative('no-mse'); return; }
      if (v._h) try { v._h.destroy(); } catch {}
      const Hls = global.Hls;
      const h = new Hls({
        lowLatencyMode: false,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 8,
        maxLiveSyncPlaybackRate: 1.5,
        backBufferLength: 30,
      }); h.loadSource(src); h.attachMedia(v);
      const t0 = Date.now();
      const m = opts.metrics || (opts.metrics = {});
      v._m = m;
      m.hls = h; m.t0 = t0;
      h.on(Hls.Events.FRAG_LOADED, (_, d) => {
        m.fragments = (m.fragments || 0) + 1;
        const st = d && d.frag && d.frag.stats && d.frag.stats.loading;
        if (st && st.start && st.end) (m.fragMs = m.fragMs || []).push(st.end - st.start);
        if (!m.firstFrameMs && v.readyState >= 2) m.firstFrameMs = Date.now() - t0;
      });
      h.on(Hls.Events.MANIFEST_PARSED, () => {
        m.manifestMs = Date.now() - t0;
        reportEvent('play-start');
        startWatchdog(v);
        v.play().catch(() => {});
        armPictureWatch(v, m3u8, opts, 'hls');
      });
      let fragFails = 0, resyncs = 0;
      h.on(Hls.Events.ERROR, (_, d) => {
        logPlayer('hls-error', { type: d.type, details: d.details, fatal: d.fatal }, v);
        if (d.fatal) m.errors = (m.errors || 0) + 1;
        // 上游闪断会把播放器甩到已滚出直播窗口的分片上，它要的每个分片都 404、又一直重试同一个
        // —— 这就是「卡住 / 反复播同一片段」。连续失败就跳到直播边缘重来。
        const isFragFail = d.details === 'fragLoadError' || d.details === 'fragLoadTimeOut';
        if (isFragFail) {
          fragFails++;
          if ((d.fatal || fragFails >= 3) && resyncs < 2) {
            resyncs++; fragFails = 0;
            reportEvent('live-edge-resync', { after: d.details, attempt: resyncs, currentTime: +v.currentTime.toFixed(1) });
            msg(v, '跳到最新位置');
            try { h.stopLoad(); h.startLoad(-1); } catch (e) {
              reportEvent('live-edge-resync-failed', { error: String((e && e.message) || e) });
            }
            return;
          }
        }
        if (!d.fatal) return;
        const tryNative = d.type === 'mediaError' && !(v._engineTried && v._engineTried.native);
        if (tryNative) {
          reportEvent('hls-fatal-switch-native', { details: d.details });
          try { h.destroy(); } catch {}
          return playHls(v, m3u8, Object.assign({}, opts, { engine: 'native', tag: (opts.tag || '') + ':switch' }));
        }
        if (mode === 'direct' && !opts.noProxyFallback) {
          reportEvent('proxy-fallback', { details: d.details, type: d.type });
          try { h.destroy(); } catch {}
          msg(v, '改用代理');
          playHls(v, m3u8, Object.assign({}, opts, { mode: 'proxy', noProxyFallback: true, tag: (opts.tag || '') + ':proxy' }));
          return;
        }
        if (!(v._engineTried && v._engineTried.native)) {
          reportEvent('hls-fatal-switch-native', { details: d.details, after: 'proxy-fallback' });
          try { h.destroy(); } catch {}
          return playHls(v, m3u8, Object.assign({}, opts, { engine: 'native', tag: (opts.tag || '') + ':switch' }));
        }
        msg(v, NO_SIGNAL);
      }); v._h = h;
    }).catch(e => {
      reportEvent('lib-load', { lib: 'hls.js', ok: false, error: e.message });
      if (nativeType && !opts.forceHls) { global.ZJU.toast('hls.js 不可用，改用原生'); playNative('lib-failed'); return; }
      global.ZJU.toast(e.message);
    });
  }

  function hlsFallbackUrl(s) {
    if (s.recordType === 'hls' && s.recordUrl) return s.recordUrl;
    const alt = (s.alternates || []).find(a => a && a.type === 'hls' && a.url);
    return alt && alt.url;
  }

  function playFlv(v, flvUrl, fallbackUrl) {
    if (v._h) { try { v._h.destroy(); } catch {} v._h = null; }
    const parts = urlParts(flvUrl);
    playCtx = { mode: 'proxy', lib: 'flv.js', tag: '', host: parts.host, path: parts.path };
    v.onplaying = () => msg(v, '');
    ensureFlv().then(() => {
      const flvjs = global.flvjs;
      if (!flvjs.isSupported()) throw new Error('当前浏览器不支持 FLV 播放');
      if (v._f) { try { v._f.destroy(); } catch {} }
      let switched = false;
      const fallback = (reason) => {
        logPlayer('flv-fallback', { reason }, v);
        if (switched || !fallbackUrl) return false;
        switched = true;
        if (v._f) { try { v._f.destroy(); } catch {} v._f = null; }
        msg(v, '切换 HLS');
        playHls(v, fallbackUrl);
        return true;
      };
      const f = flvjs.createPlayer(
        { type: 'flv', isLive: true, url: '/api/hls?u=' + encodeURIComponent(flvUrl) },
        { enableStashBuffer: true, stashInitialSize: 1024, lazyLoad: false }
      );
      const timer = setTimeout(() => { if (!v.readyState) fallback('metadata-timeout'); }, 6000);
      v.onloadedmetadata = () => { clearTimeout(timer); startWatchdog(v); reportEvent('play-start'); };
      f.on(flvjs.Events.ERROR, (type, detail) => {
        clearTimeout(timer);
        logPlayer('flv-error', { type, detail }, v);
        if (!fallback(type + ':' + detail)) msg(v, NO_SIGNAL);
      });
      f.attachMediaElement(v); f.load(); f.play().catch(() => {}); v._f = f;
    }).catch(e => {
      reportEvent('lib-load', { lib: 'flv.js', ok: false, error: e.message });
      global.ZJU.toast(e.message);
    });
  }

  function playStream(v, s) {
    cfg.onStream(s || null);
    msg(v, '');
    const url = s.watchUrl || s.url;
    const type = s.watchType || s.type;
    if (type === 'rtmp') return msg(v, 'RTMP 流不能在浏览器内播放，可录制主画面');
    if (type === 'flv') return playFlv(v, url, hlsFallbackUrl(s));
    return playHls(v, url);
  }

  function teardown(v) {
    stopWatchdog();
    try { v.pause(); } catch {}
    if (v._h) { try { v._h.destroy(); } catch {} v._h = null; }
    if (v._f) { try { v._f.destroy(); } catch {} v._f = null; }
    try { v.removeAttribute('src'); } catch {}
  }

  global.ZJU.Media = {
    config: (c) => { cfg = Object.assign(cfg, c || {}); },
    playStream, playHls, playFlv, teardown, streamName, hlsFallbackUrl,
    reportEvent, flushPlayLog, NO_SIGNAL, urlParts,
  };
})(window);
