/*
 * Apresentação (PR.Player) e música (PR.Music).
 * PR.store precisa estar definido antes de usar qualquer um dos dois.
 */
(function () {
  'use strict';

  var PR = window.PR;

  function $(id) {
    return document.getElementById(id);
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function setIcon(button, name) {
    button.querySelector('use').setAttribute('href', '#i-' + name);
  }

  /* ======================= Música ======================= */

  PR.Music = (function () {
    var audio = null;
    var tracks = [];
    var order = [];
    var pos = -1;
    var current = null;
    var release = null;
    var wanted = false; // o usuário quer música tocando
    var shuffled = false;
    var token = 0;
    var errors = 0;
    var listeners = [];

    function emit() {
      listeners.forEach(function (fn) {
        fn();
      });
    }

    function rebuildOrder() {
      order = tracks.slice();
      if (shuffled) shuffle(order);
      pos = current ? order.indexOf(current) : -1;
    }

    function unload() {
      token++;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if (release) release();
      release = null;
      current = null;
      pos = -1;
    }

    function playAt(p) {
      if (!order.length) return;
      if (p >= order.length) {
        if (shuffled && order.length > 1) {
          var last = order[order.length - 1];
          shuffle(order);
          if (order[0] === last) order.push(order.shift());
        }
        p = 0;
      }
      if (p < 0) p = order.length - 1;
      pos = p;
      var track = order[p];
      var mine = ++token;
      wanted = true;
      current = track;
      emit();
      PR.store.musicUrl(track).then(
        function (u) {
          if (mine !== token) return u.release();
          if (release) release();
          release = u.release;
          audio.src = u.url;
          startAudio();
        },
        function () {
          if (mine === token) onError();
        }
      );
    }

    function startAudio() {
      var p = audio.play();
      if (p && p.catch) {
        p.catch(function (err) {
          // O navegador só deixa tocar depois de um toque na tela.
          if (err && err.name === 'NotAllowedError') {
            wanted = false;
            emit();
          }
        });
      }
    }

    function onError() {
      if (!wanted) return;
      errors++;
      if (errors >= order.length) {
        wanted = false;
        errors = 0;
        return emit();
      }
      setTimeout(function () {
        if (wanted) playAt(pos + 1);
      }, 800);
    }

    return {
      init: function () {
        audio = $('audio');
        audio.addEventListener('ended', function () {
          playAt(pos + 1);
        });
        audio.addEventListener('playing', function () {
          errors = 0;
        });
        audio.addEventListener('error', function () {
          if (audio.getAttribute('src')) onError();
        });
      },
      onChange: function (fn) {
        listeners.push(fn);
      },
      setTracks: function (list, shuffleOn) {
        var keepId = current && current.id;
        tracks = list;
        shuffled = !!shuffleOn;
        var still = null;
        for (var i = 0; i < list.length; i++) if (list[i].id === keepId) still = list[i];
        if (current && !still) {
          var was = wanted;
          unload();
          rebuildOrder();
          if (was && order.length) playAt(0);
          else wanted = false;
        } else {
          current = still;
          rebuildOrder();
        }
        emit();
      },
      setVolume: function (percent) {
        audio.volume = Math.max(0, Math.min(1, percent / 100));
      },
      play: function () {
        if (!order.length) return;
        if (current && current.url) {
          playAt(pos); // rádio ao vivo: reconecta em vez de tocar o que ficou parado
        } else if (current && audio.getAttribute('src')) {
          wanted = true;
          startAudio();
          emit();
        } else {
          playAt(Math.max(pos, 0));
        }
      },
      pause: function () {
        wanted = false;
        audio.pause();
        if (current && current.url) {
          // Rádio: solta a conexão para não ficar baixando em silêncio.
          audio.removeAttribute('src');
          audio.load();
        }
        emit();
      },
      toggle: function () {
        if (wanted) this.pause();
        else this.play();
      },
      next: function () {
        playAt(pos + 1);
      },
      playTrack: function (id) {
        for (var i = 0; i < order.length; i++) if (order[i].id === id) return playAt(i);
      },
      isPlaying: function () {
        return wanted;
      },
      current: function () {
        return current;
      },
      hasTracks: function () {
        return tracks.length > 0;
      },
    };
  })();

  /* ======================= Apresentação ======================= */

  PR.Player = (function () {
    var Music = PR.Music;
    var root, controls, dimmer, clockEl, clockTime, clockDate, captionEl, msgEl, pauseBadge;
    var layers = [];
    var top = 0; // índice da camada visível
    var settings = null;
    var photos = [];
    var order = [];
    var pos = -1;
    var shown = null; // foto na tela
    var active = false;
    var playing = true;
    var token = 0;
    var slideTimer = null;
    var tickTimer = null;
    var hideTimer = null;
    var controlsOn = false;
    var controlsSince = 0;
    var failures = 0;
    var wakeLock = null;
    var pushedState = false;
    var nightPausedMusic = false;
    var lastTouchNav = 0;
    var touchStart = null;
    var listeners = [];

    function emit() {
      listeners.forEach(function (fn) {
        fn();
      });
    }

    /* ---------- ordem ---------- */

    function buildOrder() {
      var keep = shown && shown.id;
      order = photos.slice();
      var mode = settings.order;
      if (mode === 'shuffle') shuffle(order);
      else if (mode === 'date') order.sort(function (a, b) { return a.date - b.date; });
      else if (mode === 'date-desc') order.sort(function (a, b) { return b.date - a.date; });
      else if (mode === 'name') order.sort(function (a, b) { return a.name.localeCompare(b.name, 'pt-BR', { numeric: true }); });
      pos = -1;
      for (var i = 0; i < order.length; i++) if (order[i].id === keep) pos = i;
      // No modo aleatório, a foto atual vai para o começo para não se repetir logo.
      if (mode === 'shuffle' && pos > 0) {
        order.unshift(order.splice(pos, 1)[0]);
        pos = 0;
      }
    }

    /* ---------- troca de foto ---------- */

    function go(target, dir) {
      clearTimeout(slideTimer);
      slideTimer = null;
      if (!order.length) {
        shown = null;
        clearLayers();
        showMsg(PR.store.mode === 'server' ? 'Aguardando fotos…' : 'Nenhuma foto para mostrar.');
        return;
      }
      showMsg('');
      if (target >= order.length) {
        if (settings.order === 'shuffle' && order.length > 2) {
          var last = order[order.length - 1];
          shuffle(order);
          if (order[0] === last) order.push(order.shift());
        }
        target = 0;
      }
      if (target < 0) target = order.length - 1;
      pos = target;
      var photo = order[target];
      var mine = ++token;

      function failed() {
        if (mine !== token) return;
        failures++;
        if (api.onLoadError) api.onLoadError(photo);
        if (failures >= order.length) {
          // Nada carregou (sem rede?). Tenta de novo daqui a pouco.
          failures = 0;
          slideTimer = setTimeout(function () { go(pos + 1, 1); }, 10000);
        } else {
          go(pos + (dir || 1), dir);
        }
      }

      PR.store.photoUrl(photo).then(function (u) {
        if (mine !== token) return u.release();
        var probe = new Image();
        probe.onload = function () {
          if (mine !== token) return u.release();
          failures = 0;
          swap(photo, u, dir);
          schedule();
        };
        probe.onerror = function () {
          u.release();
          failed();
        };
        probe.src = u.url;
      }, failed);
    }

    function resetLayer(layer) {
      clearTimeout(layer.cleanup);
      layer.cleanup = null;
      layer.el.style.transition = 'none';
      layer.el.style.opacity = 0;
      layer.el.style.transform = 'none';
      layer.img.style.animation = 'none';
      layer.img.removeAttribute('src');
      layer.bg.style.backgroundImage = 'none';
      if (layer.release) layer.release();
      layer.release = null;
      layer.url = null;
    }

    function clearLayers() {
      layers.forEach(resetLayer);
    }

    function applyFit(layer) {
      layer.img.style.objectFit = settings.fit === 'cover' ? 'cover' : 'contain';
      var blur = settings.blurBg && settings.fit !== 'cover' && layer.url;
      layer.bg.style.backgroundImage = blur ? 'url("' + layer.url + '")' : 'none';
    }

    function startMotion(img, ms) {
      img.style.animation = 'none';
      if (!settings.motion) return;
      var zoomIn = Math.random() < 0.5;
      var x = (Math.random() * 3 - 1.5).toFixed(2) + '%';
      var y = (Math.random() * 3 - 1.5).toFixed(2) + '%';
      img.style.setProperty('--kb-s0', zoomIn ? 1 : 1.08);
      img.style.setProperty('--kb-s1', zoomIn ? 1.08 : 1);
      img.style.setProperty('--kb-x0', zoomIn ? '0%' : x);
      img.style.setProperty('--kb-y0', zoomIn ? '0%' : y);
      img.style.setProperty('--kb-x1', zoomIn ? x : '0%');
      img.style.setProperty('--kb-y1', zoomIn ? y : '0%');
      void img.offsetWidth;
      var dur = Math.max(6000, Math.min(45000, ms));
      img.style.animation = 'kb ' + dur + 'ms ease-in-out infinite alternate';
    }

    function transitionMs() {
      return settings.transition === 'none' ? 0 : settings.transitionMs;
    }

    function swap(photo, u, dir) {
      var first = !shown;
      var inc = layers[1 - top];
      var out = layers[top];
      top = 1 - top;

      var kind = settings.transition;
      if (kind === 'random') kind = ['fade', 'slide', 'zoom'][Math.floor(Math.random() * 3)];
      var T = transitionMs();
      if (first) {
        kind = 'fade';
        T = Math.min(T, 700);
      }

      resetLayer(inc);
      inc.release = u.release;
      inc.url = u.url;
      inc.img.src = u.url;
      applyFit(inc);
      startMotion(inc.img, settings.interval * 1000 + T * 2);

      inc.el.style.zIndex = 2;
      out.el.style.zIndex = 1;
      if (kind === 'slide') {
        inc.el.style.opacity = 1;
        inc.el.style.transform = 'translateX(' + (dir < 0 ? -100 : 100) + '%)';
      } else if (kind === 'zoom') {
        inc.el.style.transform = 'scale(1.12)';
      }
      void inc.el.offsetWidth;
      var ease = 'opacity ' + T + 'ms ease-in-out, transform ' + T + 'ms ease-in-out';
      inc.el.style.transition = ease;
      inc.el.style.opacity = 1;
      inc.el.style.transform = 'none';
      if (kind === 'slide') {
        out.el.style.transition = ease;
        out.el.style.transform = 'translateX(' + (dir < 0 ? 100 : -100) + '%)';
      }
      clearTimeout(out.cleanup);
      out.cleanup = setTimeout(function () {
        resetLayer(out);
      }, T + 80);

      shown = photo;
      updateCaption();
    }

    function schedule() {
      clearTimeout(slideTimer);
      slideTimer = null;
      if (!active || !playing || order.length < 2) return;
      slideTimer = setTimeout(function () {
        go(pos + 1, 1);
      }, settings.interval * 1000 + transitionMs());
    }

    /* ---------- relógio, legenda, brilho ---------- */

    function showMsg(text) {
      msgEl.textContent = text;
      msgEl.hidden = !text;
    }

    function updateCaption() {
      var mode = settings.caption;
      var parts = [];
      if (shown && mode !== 'off') {
        if (mode === 'name' || mode === 'both') parts.push(shown.name.replace(/\.[a-z0-9]{2,5}$/i, ''));
        if (mode === 'date' || mode === 'both') {
          parts.push(new Date(shown.date).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }));
        }
      }
      captionEl.textContent = parts.join(' · ');
      captionEl.hidden = !parts.length;
      captionEl.className = settings.clock !== 'off' && settings.clockPos === 'bl' ? 'right' : '';
    }

    function minutesOf(hhmm) {
      var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    }

    function isNight(now) {
      if (settings.night === 'off') return false;
      var start = minutesOf(settings.nightStart);
      var end = minutesOf(settings.nightEnd);
      if (start === null || end === null || start === end) return false;
      var cur = now.getHours() * 60 + now.getMinutes();
      return start < end ? cur >= start && cur < end : cur >= start || cur < end;
    }

    function tick() {
      var now = new Date();

      if (settings.clock === 'off') {
        clockEl.hidden = true;
      } else {
        clockEl.hidden = false;
        clockEl.className = settings.clockPos;
        var time = now.toLocaleTimeString('pt-BR', { hour: settings.clock24 ? '2-digit' : 'numeric', minute: '2-digit', hour12: !settings.clock24 });
        if (!settings.clock24) time = time.replace(/\s?(AM|PM|a\.\s?m\.|p\.\s?m\.)/i, '');
        if (clockTime.textContent !== time) clockTime.textContent = time;
        var date = settings.clock === 'time-date'
          ? now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
          : '';
        if (clockDate.textContent !== date) clockDate.textContent = date;
      }

      var night = isNight(now);
      var dark = 1 - Math.max(20, Math.min(100, settings.brightness)) / 100;
      if (night) dark = settings.night === 'black' ? 1 : Math.max(dark, 0.8);
      dimmer.style.opacity = dark;

      // "Apagar a tela" também silencia a música e a devolve de manhã.
      var blackout = night && settings.night === 'black';
      if (blackout && Music.isPlaying()) {
        Music.pause();
        nightPausedMusic = true;
      } else if (!blackout && nightPausedMusic) {
        nightPausedMusic = false;
        Music.play();
      }
    }

    /* ---------- controles ---------- */

    function showControls(focus) {
      if (!controlsOn) controlsSince = Date.now();
      controlsOn = true;
      controls.classList.remove('off');
      root.classList.remove('idle');
      if (focus) $('c-play').focus();
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideControls, 4500);
    }

    function hideControls() {
      controlsOn = false;
      clearTimeout(hideTimer);
      controls.classList.add('off');
      root.classList.add('idle');
      if (controls.contains(document.activeElement)) document.activeElement.blur();
    }

    function refreshButtons() {
      setIcon($('c-play'), playing ? 'pause' : 'play');
      pauseBadge.hidden = playing;
      var has = Music.hasTracks();
      $('c-music').hidden = $('c-track').hidden = !has;
      $('c-music').className = Music.isPlaying() ? '' : 'dim';
      var cur = Music.current();
      $('c-trackName').textContent = has && Music.isPlaying() && cur ? cur.name : '';
    }

    function moveFocus(step) {
      var buttons = [].filter.call(controls.querySelectorAll('button'), function (b) { return !b.hidden; });
      var i = buttons.indexOf(document.activeElement);
      buttons[(i + step + buttons.length) % buttons.length].focus();
    }

    function toggleFullscreen() {
      var doc = document;
      var el = doc.documentElement;
      var isFull = doc.fullscreenElement || doc.webkitFullscreenElement;
      try {
        var p;
        if (isFull) p = (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
        else if (el.requestFullscreen || el.webkitRequestFullscreen) p = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    }

    function enterFullscreen() {
      if (!(document.fullscreenElement || document.webkitFullscreenElement)) toggleFullscreen();
    }

    function requestWake() {
      if (!navigator.wakeLock || !active) return;
      navigator.wakeLock.request('screen').then(
        function (lock) { wakeLock = lock; },
        function () {}
      );
    }

    function onKey(e) {
      if (!active) return;
      var c = e.keyCode;
      var inside = controlsOn && controls.contains(document.activeElement);
      if (inside) showControls(false);

      if (c === 39 || c === 37) {
        if (inside) moveFocus(c === 39 ? 1 : -1);
        else if (c === 39) api.next();
        else api.prev();
      } else if (c === 13) {
        if (inside) return; // o botão em foco recebe o clique
        showControls(true);
      } else if (c === 32) {
        if (inside) return;
        api.toggle();
      } else if (c === 38 || c === 40) {
        showControls(true);
      } else if (c === 27 || c === 8 || c === 10009 || c === 461) {
        if (inside) hideControls();
        else api.stop();
      } else if (c === 70) {
        toggleFullscreen();
      } else if (c === 77) {
        Music.toggle();
      } else if (c === 415 || c === 19 || c === 10252) {
        api.toggle(); // teclas play/pause de controle remoto
      } else if (c === 417) {
        api.next();
      } else if (c === 412) {
        api.prev();
      } else {
        return;
      }
      e.preventDefault();
    }

    function onStageClick(e) {
      if (Date.now() - lastTouchNav < 500) return; // já tratado como deslize
      var x = e.clientX / root.clientWidth;
      if (settings.tapNav && x < 0.3) api.prev();
      else if (settings.tapNav && x > 0.7) api.next();
      // Com mouse, o próprio movimento acabou de abrir os controles: não os feche.
      else if (controlsOn && Date.now() - controlsSince > 400) hideControls();
      else showControls(false);
    }

    function bind() {
      root.addEventListener('click', onStageClick);
      controls.addEventListener('click', function (e) {
        e.stopPropagation();
        showControls(false);
      });
      root.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'mouse') showControls(false);
      });
      root.addEventListener('touchstart', function (e) {
        touchStart = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
      }, { passive: true });
      root.addEventListener('touchend', function (e) {
        if (!touchStart || controls.contains(e.target)) return;
        var t = e.changedTouches[0];
        var dx = t.clientX - touchStart.x;
        var dy = t.clientY - touchStart.y;
        touchStart = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          lastTouchNav = Date.now();
          if (dx < 0) api.next();
          else api.prev();
        }
      }, { passive: true });

      $('c-prev').onclick = function () { api.prev(); };
      $('c-next').onclick = function () { api.next(); };
      $('c-play').onclick = function () { api.toggle(); };
      $('c-music').onclick = function () { Music.toggle(); };
      $('c-track').onclick = function () { Music.next(); };
      $('c-full').onclick = toggleFullscreen;
      $('c-exit').onclick = function () { api.stop(); };

      document.addEventListener('keydown', onKey);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') requestWake();
      });
      window.addEventListener('popstate', function () {
        if (active) {
          pushedState = false;
          doStop();
        }
      });
      Music.onChange(refreshButtons);
    }

    function doStop() {
      if (!active) return;
      active = false;
      token++;
      clearTimeout(slideTimer);
      clearInterval(tickTimer);
      clearTimeout(hideTimer);
      clearLayers();
      shown = null;
      nightPausedMusic = false;
      Music.pause();
      root.hidden = true;
      document.body.classList.remove('playing');
      if (wakeLock) wakeLock.release().catch(function () {});
      wakeLock = null;
      if (document.fullscreenElement || document.webkitFullscreenElement) toggleFullscreen();
      emit();
    }

    var api = {
      init: function () {
        root = $('player');
        controls = $('controls');
        dimmer = $('dimmer');
        clockEl = $('clock');
        clockTime = clockEl.querySelector('.clock-time');
        clockDate = clockEl.querySelector('.clock-date');
        captionEl = $('caption');
        msgEl = $('playerMsg');
        pauseBadge = $('pauseBadge');
        [].forEach.call(root.querySelectorAll('.slide'), function (el) {
          layers.push({ el: el, bg: el.querySelector('.slide-bg'), img: el.querySelector('.slide-img'), release: null, url: null, cleanup: null });
        });
        bind();
      },
      onChange: function (fn) {
        listeners.push(fn);
      },
      isActive: function () {
        return active;
      },

      /** `gesture`: veio de um toque do usuário (permite tela cheia e música). */
      start: function (gesture) {
        if (active) return;
        active = true;
        playing = true;
        failures = 0;
        root.hidden = false;
        document.body.classList.add('playing');
        hideControls();
        refreshButtons();
        buildOrder();
        go(0, 1);
        tick();
        tickTimer = setInterval(tick, 1000);
        if (gesture) enterFullscreen();
        requestWake();
        if (settings.musicOn && !isNight(new Date())) Music.play();
        try {
          history.pushState({ pr: 1 }, '');
          pushedState = true;
        } catch (e) {}
        emit();
      },
      stop: function () {
        if (!active) return;
        if (pushedState) history.back(); // o popstate termina de fechar
        else doStop();
      },
      next: function () {
        if (active) go(pos + 1, 1);
      },
      prev: function () {
        if (active) go(pos - 1, -1);
      },
      toggle: function () {
        if (!active) return;
        playing = !playing;
        refreshButtons();
        schedule();
      },

      setPhotos: function (list) {
        photos = list;
        if (!active) return;
        var had = shown;
        buildOrder();
        if (!order.length) go(0, 1);
        else if (!had || pos < 0) go(Math.max(0, Math.min(pos, order.length - 1)), 1);
        else if (!slideTimer) schedule(); // não reinicia a contagem da foto atual
      },

      setSettings: function (next) {
        var prev = settings;
        settings = next;
        if (!active || !prev) return;
        if (prev.order !== next.order) buildOrder();
        layers.forEach(function (layer) {
          if (layer.img.getAttribute('src')) applyFit(layer);
        });
        if (prev.motion !== next.motion) startMotion(layers[top].img, next.interval * 1000);
        updateCaption();
        tick();
        if (prev.interval !== next.interval) schedule();
      },
    };

    return api;
  })();
})();
