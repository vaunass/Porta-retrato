/*
 * Tela inicial: biblioteca de fotos e músicas, ajustes e controle remoto.
 */
(function () {
  'use strict';

  var PR = window.PR;
  var Player = PR.Player;
  var Music = PR.Music;

  var DEFAULTS = {
    interval: 10, // segundos
    order: 'shuffle',
    transition: 'fade',
    transitionMs: 1200,
    fit: 'contain',
    blurBg: true,
    motion: true,
    tapNav: true,
    clock: 'off',
    clockPos: 'br',
    clock24: true,
    caption: 'off',
    brightness: 100,
    night: 'off',
    nightStart: '22:00',
    nightEnd: '07:00',
    musicOn: true,
    musicShuffle: false,
    volume: 60,
  };

  var MAX_SIDE = 2560; // lado maior da foto guardada
  var THUMB_SIDE = 360;

  var store = null;
  var settings = {};
  var photos = [];
  var tracks = [];
  var selected = {};
  var busy = false;

  function $(id) {
    return document.getElementById(id);
  }

  function each(selector, fn) {
    [].forEach.call(document.querySelectorAll(selector), fn);
  }

  function icon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  var toastTimer = null;
  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.hidden = true;
    }, 4000);
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  /* ---------- ajustes ---------- */

  function normalize(raw) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (key) {
      var def = DEFAULTS[key];
      var val = raw ? raw[key] : undefined;
      out[key] = typeof val === typeof def ? val : def;
    });
    out.interval = Math.max(1, Math.min(999 * 3600, Math.round(out.interval) || DEFAULTS.interval));
    return out;
  }

  function fillForm() {
    each('[data-key]', function (el) {
      var val = settings[el.getAttribute('data-key')];
      if (el.type === 'checkbox') el.checked = !!val;
      else el.value = val;
    });
    var sec = settings.interval;
    var unit = sec % 3600 === 0 ? 3600 : sec % 60 === 0 ? 60 : 1;
    $('intervalUnit').value = unit;
    $('intervalValue').value = sec / unit;
    refreshOutputs();
  }

  function refreshOutputs() {
    each('output[data-for]', function (out) {
      var key = out.getAttribute('data-for');
      var val = settings[key];
      out.textContent = key === 'transitionMs' ? (val / 1000).toFixed(1).replace('.', ',') + ' s' : val + '%';
    });
    each('#intervalChips button', function (b) {
      b.classList.toggle('on', Number(b.getAttribute('data-sec')) === settings.interval);
    });
  }

  function applySettings() {
    Player.setSettings(settings);
    Music.setVolume(settings.volume);
    Music.setTracks(tracks, settings.musicShuffle);
  }

  var saveTimer = null;
  function settingsChanged() {
    settings = normalize(settings);
    refreshOutputs();
    applySettings();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      store.saveSettings(settings).catch(function () {
        toast('Não foi possível salvar os ajustes.');
      });
    }, 300);
  }

  function bindSettings() {
    each('[data-key]', function (el) {
      function read() {
        var key = el.getAttribute('data-key');
        var next = Object.assign({}, settings);
        if (el.type === 'checkbox') next[key] = el.checked;
        else if (typeof DEFAULTS[key] === 'number') next[key] = Number(el.value);
        else next[key] = el.value;
        settings = next;
        settingsChanged();
      }
      el.addEventListener('change', read);
      if (el.type === 'range') el.addEventListener('input', read);
    });

    function readInterval() {
      var value = Number($('intervalValue').value);
      if (!(value >= 1)) return;
      settings = Object.assign({}, settings, { interval: Math.round(value * Number($('intervalUnit').value)) });
      settingsChanged();
    }
    $('intervalValue').addEventListener('change', readInterval);
    $('intervalUnit').addEventListener('change', readInterval);
    $('intervalChips').addEventListener('click', function (e) {
      var sec = Number(e.target.getAttribute('data-sec'));
      if (!sec) return;
      settings = Object.assign({}, settings, { interval: sec });
      fillForm();
      settingsChanged();
    });

    var auto = $('autoStart');
    try {
      auto.checked = localStorage.getItem('pr.autoStart') === '1';
    } catch (e) {}
    auto.addEventListener('change', function () {
      try {
        localStorage.setItem('pr.autoStart', auto.checked ? '1' : '0');
      } catch (e) {}
    });
  }

  /* ---------- fotos ---------- */

  function renderPhotos() {
    var grid = $('photoGrid');
    grid.textContent = '';
    var ids = {};
    photos.forEach(function (photo) {
      ids[photo.id] = true;
      var btn = document.createElement('button');
      btn.className = 'thumb' + (selected[photo.id] ? ' selected' : '');
      btn.setAttribute('data-id', photo.id);
      btn.setAttribute('aria-pressed', selected[photo.id] ? 'true' : 'false');
      btn.title = photo.name;
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = photo.name;
      img.src = store.thumbUrl(photo);
      var mark = document.createElement('span');
      mark.className = 'mark';
      mark.appendChild(icon('check'));
      btn.appendChild(img);
      btn.appendChild(mark);
      grid.appendChild(btn);
    });
    Object.keys(selected).forEach(function (id) {
      if (!ids[id]) delete selected[id];
    });
    $('photoCount').textContent = photos.length || '';
    $('photoEmpty').hidden = photos.length > 0;
    refreshSelection();
  }

  function refreshSelection() {
    var n = Object.keys(selected).length;
    $('selectAllBtn').hidden = !photos.length || n === photos.length;
    $('clearSelBtn').hidden = n === 0;
    $('deleteSelBtn').hidden = n === 0;
    $('deleteSelBtn').querySelector('span').textContent = 'Excluir ' + plural(n, 'foto', 'fotos');
    $('photoHint').hidden = !photos.length || n > 0;
  }

  function loadPhotos() {
    return store.listPhotos().then(function (list) {
      photos = list;
      renderPhotos();
      Player.setPhotos(photos);
    });
  }

  function setProgress(id, done, total, label) {
    var el = $(id);
    el.hidden = total === 0;
    el.querySelector('.bar').style.width = (total ? (done / total) * 100 : 0) + '%';
    el.querySelector('span').textContent = label || '';
  }

  function decode(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        resolve({ img: img, url: url });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Formato não suportado'));
      };
      img.src = url;
    });
  }

  function toJpeg(img, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      var k = Math.min(1, maxSide / Math.max(w, h));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * k));
      canvas.height = Math.max(1, Math.round(h * k));
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        function (blob) {
          var out = { blob: blob, w: canvas.width, h: canvas.height };
          canvas.width = canvas.height = 0; // libera a memória já
          if (blob) resolve(out);
          else reject(new Error('Não foi possível converter a imagem'));
        },
        'image/jpeg',
        quality
      );
    });
  }

  // Reduz a foto para caber bem em uma TV e gera a miniatura.
  function prepare(file) {
    return decode(file).then(function (d) {
      return toJpeg(d.img, MAX_SIDE, 0.88)
        .then(function (full) {
          return toJpeg(d.img, THUMB_SIDE, 0.8).then(function (thumb) {
            return { full: full, thumb: thumb };
          });
        })
        .then(
          function (r) {
            URL.revokeObjectURL(d.url);
            return r;
          },
          function (err) {
            URL.revokeObjectURL(d.url);
            throw err;
          }
        );
    });
  }

  function isImage(file) {
    return /^image\//.test(file.type) || /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i.test(file.name);
  }

  function isAudio(file) {
    return /^audio\//.test(file.type) || /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i.test(file.name);
  }

  async function addPhotos(files) {
    files = [].filter.call(files, isImage);
    if (!files.length || busy) return;
    busy = true;
    var ok = 0;
    var failed = 0;
    for (var i = 0; i < files.length; i++) {
      setProgress('photoProgress', i, files.length, 'Preparando foto ' + (i + 1) + ' de ' + files.length + '…');
      try {
        var r = await prepare(files[i]);
        var meta = { name: files[i].name, date: files[i].lastModified || Date.now(), w: r.full.w, h: r.full.h };
        await store.addPhoto(meta, r.full.blob, r.thumb.blob);
        ok++;
      } catch (err) {
        failed++;
      }
    }
    setProgress('photoProgress', 0, 0);
    busy = false;
    await loadPhotos().catch(function () {});
    if (failed && !ok) toast('Não foi possível adicionar ' + (failed === 1 ? 'a foto' : 'as fotos') + '. O formato pode não ser suportado por este navegador.');
    else if (failed) toast(plural(ok, 'foto adicionada', 'fotos adicionadas') + '; ' + plural(failed, 'falhou', 'falharam') + '.');
    else toast(plural(ok, 'foto adicionada', 'fotos adicionadas') + '.');
  }

  async function deleteSelected() {
    var ids = Object.keys(selected);
    if (!ids.length || busy) return;
    if (!confirm('Excluir ' + plural(ids.length, 'foto', 'fotos') + '? Não dá para desfazer.')) return;
    busy = true;
    var failed = 0;
    for (var i = 0; i < ids.length; i++) {
      try {
        await store.deletePhoto(ids[i]);
        delete selected[ids[i]];
      } catch (err) {
        failed++;
      }
    }
    busy = false;
    await loadPhotos().catch(function () {});
    if (failed) toast('Não foi possível excluir ' + plural(failed, 'foto', 'fotos') + '.');
  }

  function bindPhotos() {
    $('photoInput').addEventListener('change', function () {
      var files = [].slice.call(this.files);
      this.value = '';
      addPhotos(files);
    });
    $('photoGrid').addEventListener('click', function (e) {
      var btn = e.target.closest('.thumb');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      if (selected[id]) delete selected[id];
      else selected[id] = true;
      btn.classList.toggle('selected', !!selected[id]);
      btn.setAttribute('aria-pressed', selected[id] ? 'true' : 'false');
      refreshSelection();
    });
    $('selectAllBtn').onclick = function () {
      photos.forEach(function (p) {
        selected[p.id] = true;
      });
      renderPhotos();
    };
    $('clearSelBtn').onclick = function () {
      selected = {};
      renderPhotos();
    };
    $('deleteSelBtn').onclick = deleteSelected;

    // Arrastar e soltar (no computador).
    var depth = 0;
    function hasFiles(e) {
      return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
    }
    document.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      depth++;
      document.body.classList.add('dragging');
    });
    document.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) document.body.classList.remove('dragging');
    });
    document.addEventListener('dragover', function (e) {
      if (hasFiles(e)) e.preventDefault();
    });
    document.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      var files = [].slice.call(e.dataTransfer.files);
      if (files.some(isImage)) addPhotos(files);
      if (files.some(isAudio)) addMusic(files);
    });
  }

  /* ---------- músicas ---------- */

  function renderMusic() {
    var list = $('musicList');
    list.textContent = '';
    var cur = Music.current();
    tracks.forEach(function (track) {
      var isCur = cur && cur.id === track.id;
      var li = document.createElement('li');
      if (isCur) li.className = 'current';
      var play = document.createElement('button');
      play.className = 'icon-btn';
      play.setAttribute('data-play', track.id);
      play.setAttribute('aria-label', 'Tocar ' + track.name);
      play.appendChild(icon(isCur && Music.isPlaying() ? 'pause' : 'play'));
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = track.name;
      var del = document.createElement('button');
      del.className = 'icon-btn ghost';
      del.setAttribute('data-del', track.id);
      del.setAttribute('aria-label', 'Excluir ' + track.name);
      del.appendChild(icon('trash'));
      li.appendChild(play);
      li.appendChild(name);
      li.appendChild(del);
      list.appendChild(li);
    });
    $('musicCount').textContent = tracks.length || '';
    $('musicEmpty').hidden = tracks.length > 0;
  }

  function loadMusic() {
    return store.listMusic().then(function (list) {
      tracks = list;
      Music.setTracks(tracks, settings.musicShuffle); // dispara renderMusic
    });
  }

  async function addMusic(files) {
    files = [].filter.call(files, isAudio);
    if (!files.length || busy) return;
    busy = true;
    var ok = 0;
    var failed = 0;
    for (var i = 0; i < files.length; i++) {
      setProgress('musicProgress', i, files.length, 'Enviando música ' + (i + 1) + ' de ' + files.length + '…');
      try {
        await store.addMusic(files[i], files[i].name.replace(/\.[a-z0-9]{2,5}$/i, ''));
        ok++;
      } catch (err) {
        failed++;
      }
    }
    setProgress('musicProgress', 0, 0);
    busy = false;
    await loadMusic().catch(function () {});
    if (failed) toast(plural(failed, 'música não pôde ser adicionada', 'músicas não puderam ser adicionadas') + '.');
    else toast(plural(ok, 'música adicionada', 'músicas adicionadas') + '.');
  }

  function bindMusic() {
    $('musicInput').addEventListener('change', function () {
      var files = [].slice.call(this.files);
      this.value = '';
      addMusic(files);
    });
    $('musicList').addEventListener('click', function (e) {
      var play = e.target.closest('[data-play]');
      var del = e.target.closest('[data-del]');
      if (play) {
        var id = play.getAttribute('data-play');
        var cur = Music.current();
        if (cur && cur.id === id) Music.toggle();
        else Music.playTrack(id);
      } else if (del) {
        if (!confirm('Excluir esta música?')) return;
        store.deleteMusic(del.getAttribute('data-del')).then(loadMusic, function () {
          toast('Não foi possível excluir a música.');
        });
      }
    });
    Music.onChange(renderMusic);
  }

  /* ---------- abas, início, controle remoto ---------- */

  function bindTabs() {
    each('.tab', function (tab) {
      tab.addEventListener('click', function () {
        each('.tab', function (t) {
          t.classList.toggle('active', t === tab);
        });
        each('.panel', function (p) {
          p.hidden = p.id !== 'tab-' + tab.getAttribute('data-tab');
        });
      });
    });
  }

  function start(gesture) {
    if (!photos.length && store.mode !== 'server') {
      toast('Adicione algumas fotos primeiro.');
      return;
    }
    Player.start(gesture);
  }

  function setupRemote() {
    if (store.mode !== 'server') return;
    $('remoteTab').hidden = false;
    var box = $('addresses');
    var list = (store.info.addresses || []).slice();
    if (!list.length) list.push(location.origin);
    list.forEach(function (addr) {
      var div = document.createElement('div');
      div.textContent = addr;
      box.appendChild(div);
    });
    each('[data-cmd]', function (btn) {
      btn.addEventListener('click', function () {
        store.sendCommand(btn.getAttribute('data-cmd')).catch(function () {
          toast('Sem conexão com o servidor.');
        });
      });
    });

    var timers = {};
    function soon(key, fn) {
      clearTimeout(timers[key]);
      timers[key] = setTimeout(fn, 400);
    }
    function reloadSettings() {
      store.getSettings().then(function (raw) {
        settings = normalize(raw);
        fillForm();
        applySettings();
      }, function () {});
    }
    function reloadPhotos() {
      if (!busy) loadPhotos().catch(function () {});
    }
    function reloadMusic() {
      if (!busy) loadMusic().catch(function () {});
    }

    store.onEvent(function (ev) {
      if (ev.type === 'library') soon('photos', reloadPhotos);
      else if (ev.type === 'music') soon('music', reloadMusic);
      else if (ev.type === 'settings') soon('settings', reloadSettings);
      else if (ev.type === 'reconnect') {
        soon('photos', reloadPhotos);
        soon('music', reloadMusic);
        soon('settings', reloadSettings);
      } else if (ev.type === 'command') {
        if (ev.action === 'start') start(false);
        else if (ev.action === 'stop') Player.stop();
        else if (ev.action === 'next') Player.next();
        else if (ev.action === 'prev') Player.prev();
        else if (ev.action === 'toggle') Player.toggle();
      }
    });
  }

  /* ---------- partida ---------- */

  async function boot() {
    bindTabs();
    try {
      store = PR.store = await PR.createStore();
    } catch (err) {
      $('modeLabel').textContent = 'Este navegador não permite guardar as fotos (modo anônimo?).';
      return;
    }
    $('modeLabel').textContent =
      store.mode === 'server'
        ? 'Biblioteca compartilhada na rede de casa'
        : 'Fotos guardadas neste aparelho';

    Music.init();
    Player.init();
    settings = normalize(await store.getSettings().catch(function () { return {}; }));
    fillForm();
    applySettings();

    bindSettings();
    bindPhotos();
    bindMusic();
    setupRemote();

    await Promise.all([loadPhotos(), loadMusic()]).catch(function () {
      toast('Não foi possível carregar a biblioteca.');
    });

    $('startBtn').disabled = false;
    $('startBtn').onclick = function () {
      start(true);
    };

    var auto = false;
    try {
      auto = localStorage.getItem('pr.autoStart') === '1';
    } catch (e) {}
    if (/[?&]play=1\b/.test(location.search)) auto = true;
    if (auto && (photos.length || store.mode === 'server')) start(false);

    var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if ('serviceWorker' in navigator && secure) navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  boot();
})();
