/*
 * Player: escolhe o motor certo (hls.js, mpegts.js ou nativo), passa pelo proxy
 * do servidor, troca sozinho para a próxima versão quando uma falha e responde
 * ao controle remoto da TV.
 */
(function (w) {
  'use strict';
  var $ = U.$;

  var S = {
    open: false, id: null, ep: null, info: null, altIdx: 0, token: 0, hls: null, mpegts: null,
    ctx: { ids: [], idx: -1 }, idleTimer: null, watchdog: null, forceDirect: false, tried: 0,
    live: true, recovered: false
  };
  var hooks = { isFav: function () { return false; }, toggleFav: function () {}, cast: function () {}, report: function () {}, back: function () {}, opened: function () {}, settings: function () { return { proxy: true }; } };
  var vid;

  function el(id) { return $(id); }

  function proxied(alt) {
    var s = '/api/proxy?u=' + encodeURIComponent(alt.u);
    if (alt.r) s += '&r=' + encodeURIComponent(alt.r);
    if (alt.ua) s += '&ua=' + encodeURIComponent(alt.ua);
    return s;
  }

  function quickType(u) {
    var p = u.split('?')[0].toLowerCase();
    if (/\.m3u8?$/.test(p)) return 'hls';
    if (/\.(mp4|m4v|mkv|webm|mov)$/.test(p)) return 'file';
    if (/\.ts$/.test(p)) return 'ts';
    return '';
  }

  function detect(alt) {
    var q = quickType(alt.u);
    if (q) return Promise.resolve(q);
    var url = '/api/probe?u=' + encodeURIComponent(alt.u) + (alt.r ? '&r=' + encodeURIComponent(alt.r) : '') + (alt.ua ? '&ua=' + encodeURIComponent(alt.ua) : '');
    return U.api(url).then(function (r) {
      if (!r.ok) throw new Error(r.status ? 'HTTP ' + r.status : (r.error || 'sem resposta'));
      return r.type;
    });
  }

  function destroyEngines() {
    clearTimeout(S.watchdog);
    if (S.hls) { try { S.hls.destroy(); } catch (e) { /* ok */ } S.hls = null; }
    if (S.mpegts) { try { S.mpegts.pause(); S.mpegts.unload(); S.mpegts.detachMediaElement(); S.mpegts.destroy(); } catch (e) { /* ok */ } S.mpegts = null; }
    try { vid.removeAttribute('src'); vid.load(); } catch (e) { /* ok */ }
  }

  function spin(on) { el('pSpin').hidden = !on; }
  function pToast(msg, ms) {
    var t = el('pToast'); t.textContent = msg; t.hidden = false;
    clearTimeout(pToast.t); pToast.t = setTimeout(function () { t.hidden = true; }, ms || 2200);
  }

  function setIcon(btn, name) { var i = btn.querySelector('i'); i.setAttribute('data-ic', name); i.innerHTML = U.icon(name); }

  function tryPlay() {
    var p = vid.play();
    if (p && p.catch) p.catch(function () {
      if (!vid.muted) { vid.muted = true; syncUi(); pToast('Som desligado pelo navegador — pressione OK para ativar'); vid.play().catch(function () {}); }
    });
  }

  function fail(reason) {
    var my = S.token;
    destroyEngines();
    if (my !== S.token) return;
    var alts = S.info.alts;
    if (S.altIdx + 1 < alts.length) {
      pToast('Versão ' + (S.altIdx + 1) + ' falhou (' + reason + '). Tentando a ' + (S.altIdx + 2) + '…', 2600);
      S.altIdx++;
      return attempt();
    }
    spin(false);
    el('pErrMsg').textContent = 'Não consegui reproduzir "' + S.info.n + '". ' + reason + '. Pode ser um link fora do ar.';
    el('pErr').hidden = false;
    U.api('/api/bad', { body: { id: S.id, on: true } }).catch(function () {});
    wake(true);
    setTimeout(function () { el('pRetry').focus(); }, 50);
  }

  function attempt() {
    var my = ++S.token;
    destroyEngines();
    el('pErr').hidden = true;
    spin(true);
    var alt = S.info.alts[S.altIdx];
    setIcon(el('bPlay'), 'pause');
    el('altTxt').textContent = (S.altIdx + 1) + '/' + S.info.alts.length;
    el('pSub').textContent = [S.info.g, alt.l || ''].filter(Boolean).join(' · ');
    var direct = S.forceDirect || !hooks.settings().proxy;
    var src = direct ? alt.u : proxied(alt);
    S.recovered = false;
    detect(alt).then(function (type) {
      if (my !== S.token) return;
      start(type, src, my);
    }, function (e) { if (my === S.token) fail(e.message || 'erro'); });
  }

  function armWatchdog(my) {
    clearTimeout(S.watchdog);
    S.watchdog = setTimeout(function () { if (my === S.token) fail('sem resposta em 25 s'); }, 25000);
  }

  function start(type, src, my) {
    armWatchdog(my);
    var useHls = type === 'hls' && w.Hls && w.Hls.isSupported();
    var useTs = type === 'ts' && w.mpegts && w.mpegts.getFeatureList && w.mpegts.getFeatureList().mseLivePlayback;
    if (useHls) {
      var h = new w.Hls({ maxBufferLength: 30, enableWorker: true, manifestLoadingTimeOut: 15000, levelLoadingTimeOut: 15000, fragLoadingTimeOut: 25000 });
      S.hls = h;
      h.on(w.Hls.Events.ERROR, function (ev, d) {
        if (my !== S.token || !d.fatal) return;
        if (d.type === w.Hls.ErrorTypes.MEDIA_ERROR && !S.recovered) { S.recovered = true; h.recoverMediaError(); return; }
        if (d.type === w.Hls.ErrorTypes.NETWORK_ERROR && !S.recovered && d.details !== 'manifestLoadError') { S.recovered = true; h.startLoad(); return; }
        fail(d.details || 'erro no HLS');
      });
      h.loadSource(src);
      h.attachMedia(vid);
      h.on(w.Hls.Events.MANIFEST_PARSED, function () { tryPlay(); });
    } else if (useTs) {
      var m = w.mpegts.createPlayer({ type: 'mpegts', isLive: S.live, url: src }, { enableWorker: false, liveBufferLatencyChasing: true, lazyLoadMaxDuration: 60 });
      S.mpegts = m;
      m.on(w.mpegts.Events.ERROR, function (t, d) { if (my === S.token) fail(d || t || 'erro no TS'); });
      m.attachMediaElement(vid);
      m.load();
      tryPlay();
    } else {
      vid.src = src;   // nativo: HLS na Safari/webOS, MP4/MKV em geral
      tryPlay();
    }
  }

  // ----- eventos do <video> -----
  function bindVideo() {
    vid.addEventListener('playing', function () {
      clearTimeout(S.watchdog); spin(false); el('pErr').hidden = true; syncUi(); wake();
      if (S.info) U.api('/api/bad', { body: { id: S.id, on: false } }).catch(function () {});
    });
    vid.addEventListener('waiting', function () { if (S.open) spin(true); });
    vid.addEventListener('canplay', function () { spin(false); });
    vid.addEventListener('pause', syncUi);
    vid.addEventListener('play', syncUi);
    vid.addEventListener('volumechange', syncUi);
    vid.addEventListener('error', function () {
      if (!S.open || !vid.getAttribute('src')) return;
      var c = vid.error ? vid.error.code : 0;
      fail(c === 4 ? 'formato não suportado' : 'erro de mídia');
    });
    vid.addEventListener('ended', function () { if (S.info && S.info.next) go(1); });
    vid.addEventListener('timeupdate', updateSeek);
    vid.addEventListener('loadedmetadata', updateSeek);
    vid.addEventListener('click', function () { if (el('player').classList.contains('idle')) wake(); else el('player').classList.add('idle'); });
  }

  function isVod() { return !S.live && isFinite(vid.duration) && vid.duration > 0; }

  function updateSeek() {
    var show = isVod();
    el('seekRow').hidden = !show;
    if (!show) return;
    if (!updateSeek.drag) el('seek').value = Math.round(vid.currentTime / vid.duration * 1000);
    el('tCur').textContent = U.fmtTime(vid.currentTime);
    el('tDur').textContent = U.fmtTime(vid.duration);
  }

  function syncUi() {
    if (!S.open) return;
    setIcon(el('bPlay'), vid.paused ? 'play' : 'pause');
    setIcon(el('bMute'), vid.muted || vid.volume === 0 ? 'mute' : 'vol');
    el('bFav').classList.toggle('on', hooks.isFav(S.id));
    el('bPrev').style.visibility = el('bNext').style.visibility = canGo() ? 'visible' : 'hidden';
    el('bAlt').style.display = S.info && S.info.alts.length > 1 ? '' : 'none';
    report();
  }

  function report() {
    hooks.report(S.open && S.info ? { id: S.id, ep: S.ep, n: S.info.n, lg: S.info.lg, paused: vid.paused, muted: vid.muted, vol: vid.volume } : null);
  }

  function canGo() { return !!(S.info && (S.info.k === 's' ? (S.info.next || S.info.prev) : S.ctx.ids.length > 1)); }

  // ----- controles visíveis / ociosos -----
  function wake(keep) {
    var p = el('player');
    p.classList.remove('idle');
    clearTimeout(S.idleTimer);
    if (keep) return;
    S.idleTimer = setTimeout(function () {
      if (!vid.paused && el('pErr').hidden) { p.classList.add('idle'); if (p.contains(document.activeElement)) document.activeElement.blur(); }
    }, 4500);
  }

  function go(dir) {
    if (!S.info) return;
    if (S.info.k === 's') {
      var t = dir > 0 ? S.info.next : S.info.prev;
      if (t) return load(S.id, t, null);
      return pToast(dir > 0 ? 'Último episódio' : 'Primeiro episódio');
    }
    var i = S.ctx.idx + dir;
    if (i < 0 || i >= S.ctx.ids.length) return pToast('Fim da lista');
    S.ctx.idx = i;
    load(S.ctx.ids[i], null, null);
  }

  function load(id, ep, ids) {
    if (ids) { S.ctx.ids = ids; S.ctx.idx = ids.indexOf(id); }
    else if (!ep) { var k = S.ctx.ids.indexOf(id); if (k >= 0) S.ctx.idx = k; }
    destroyEngines();
    spin(true);
    el('pErr').hidden = true;
    return U.api('/api/stream/' + encodeURIComponent(id) + (ep ? '?ep=' + encodeURIComponent(ep) : '')).then(function (info) {
      S.id = id; S.ep = ep; S.info = info; S.altIdx = 0; S.forceDirect = false; S.live = info.k === 'l';
      el('pTitle').textContent = info.n;
      el('pSub').textContent = info.g || '';
      if (!info.alts.length) return fail('sem links');
      U.api('/api/recent', { body: { id: id } }).catch(function () {});
      attempt();
      syncUi();
    }, function (e) { spin(false); el('pErrMsg').textContent = 'Item indisponível: ' + e.message; el('pErr').hidden = false; });
  }

  function open(id, ep, ids) {
    if (!S.open) {
      S.open = true;
      el('player').hidden = false;
      document.body.style.overflow = 'hidden';
      hooks.opened();
    }
    wake();
    return load(id, ep, ids);
  }

  function close() {
    if (!S.open) return;
    S.open = false; S.token++;
    destroyEngines();
    el('player').hidden = true;
    document.body.style.overflow = '';
    clearTimeout(S.idleTimer);
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) { /* ok */ }
    }
    hooks.report(null);
  }

  function togglePlay() { if (vid.paused) tryPlay(); else vid.pause(); }
  function seekBy(d) { if (isVod()) vid.currentTime = Math.max(0, Math.min(vid.duration, vid.currentTime + d)); }
  function nextAlt() {
    if (!S.info || S.info.alts.length < 2) return pToast('Só há uma versão deste item');
    S.altIdx = (S.altIdx + 1) % S.info.alts.length; S.forceDirect = false; attempt();
    pToast('Versão ' + (S.altIdx + 1) + ' de ' + S.info.alts.length);
  }
  function fullscreen() {
    var p = el('player'), on = document.fullscreenElement || document.webkitFullscreenElement;
    try {
      if (on) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else (p.requestFullscreen || p.webkitRequestFullscreen).call(p);
    } catch (e) { /* TVs já estão em tela cheia */ }
  }

  // ----- teclado / controle remoto -----
  w.IPTV_PLAYER_KEY = function (e, dir) {
    if (!S.open) return false;
    var k = e.keyCode, idle = el('player').classList.contains('idle');
    if (k === 461 || k === 10009 || k === 27 || (k === 8 && e.target.tagName !== 'INPUT')) { hooks.back(); return true; }
    if (k === 415) { tryPlay(); return true; }
    if (k === 19) { vid.pause(); return true; }
    if (k === 413) { hooks.back(); return true; }
    if (k === 417) { seekBy(30); return true; }
    if (k === 412) { seekBy(-30); return true; }
    if (k === 427) { go(1); return true; }
    if (k === 428) { go(-1); return true; }
    if (k === 403) { hooks.toggleFav(S.id); return true; }
    if (k === 404) { nextAlt(); return true; }
    if (k === 32 && e.target.tagName !== 'BUTTON') { togglePlay(); wake(); return true; }
    if (vid.muted && k === 13) { vid.muted = false; }
    if (idle) {
      wake();
      if (dir === 'up') { go(1); return true; }
      if (dir === 'down') { go(-1); return true; }
      if (dir === 'left' || dir === 'right') { if (isVod()) seekBy(dir === 'left' ? -10 : 10); return true; }
      if (k === 13) { setTimeout(function () { el('bPlay').focus(); }, 0); return true; }
      return false;
    }
    wake();
    if (!el('player').contains(document.activeElement) && dir) { el('bPlay').focus(); return true; }
    return false;
  };

  function wire() {
    vid = el('vid');
    bindVideo();
    var p = el('player');
    ['mousemove', 'touchstart'].forEach(function (ev) { p.addEventListener(ev, function () { wake(); }, { passive: true }); });
    el('pBack').onclick = function () { hooks.back(); };
    el('pClose').onclick = function () { hooks.back(); };
    el('bPlay').onclick = togglePlay;
    el('bPrev').onclick = function () { go(-1); };
    el('bNext').onclick = function () { go(1); };
    el('bAlt').onclick = nextAlt;
    el('bFav').onclick = function () { hooks.toggleFav(S.id); syncUi(); };
    el('bMute').onclick = function () { vid.muted = !vid.muted; syncUi(); };
    el('bFull').onclick = fullscreen;
    el('bCast').onclick = function () { hooks.cast(S.id, S.ep); };
    el('pRetry').onclick = function () { S.altIdx = 0; S.forceDirect = false; attempt(); };
    el('pDirect').onclick = function () { S.forceDirect = true; attempt(); };
    var seek = el('seek');
    seek.addEventListener('input', function () { updateSeek.drag = true; el('tCur').textContent = U.fmtTime(seek.value / 1000 * vid.duration); });
    seek.addEventListener('change', function () { if (isVod()) vid.currentTime = seek.value / 1000 * vid.duration; updateSeek.drag = false; });
  }

  // ----- comandos vindos do celular (modo TV) -----
  function command(cmd, data) {
    data = data || {};
    switch (cmd) {
      case 'play': return open(data.id, data.ep || null, data.ids || null);
      case 'pause': vid.pause(); break;
      case 'resume': tryPlay(); break;
      case 'toggle': togglePlay(); break;
      case 'mute': vid.muted = !vid.muted; break;
      case 'vol': vid.muted = false; vid.volume = Math.max(0, Math.min(1, vid.volume + (data.d || 0))); break;
      case 'next': go(1); break;
      case 'prev': go(-1); break;
      case 'seek': seekBy(data.d || 0); break;
      case 'stop': hooks.back(); break;
    }
    wake();
  }

  w.Player = {
    hooks: hooks, init: wire, open: open, close: close, command: command,
    isOpen: function () { return S.open; }
  };
})(window);
