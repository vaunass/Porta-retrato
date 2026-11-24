/* Porta IPTV — interface. Escrito em ES2015 sem async/await para rodar em TVs LG mais antigas. */
(function (w) {
  'use strict';
  var $ = U.$, esc = U.esc, api = U.api, store = U.store;

  var UA = navigator.userAgent;
  var IS_TV = /Web0S|webOS|SMART-TV|SmartTV|Tizen|HbbTV|NetCast/i.test(UA);
  var qs = (function () { var o = {}; location.search.replace(/^\?/, '').split('&').forEach(function (p) { if (p) { var k = p.split('='); o[k[0]] = decodeURIComponent(k[1] || ''); } }); return o; })();
  if (qs.tv === '1') IS_TV = true;
  if (qs.tv === '0') IS_TV = false;
  if (IS_TV) document.body.className += ' tv';

  var TITLES = { home: 'Início', l: 'Ao vivo', m: 'Filmes', s: 'Séries', fav: 'Minha lista', tvs: 'TVs', src: 'Fontes', more: 'Mais' };

  // ----- configurações deste aparelho -----
  var cfg = {
    id: store.get('device', null) || (function () { var i = U.uid(); store.set('device', i); return i; })(),
    name: store.get('name', IS_TV ? 'TV LG' : 'Meu celular'),
    receiver: store.get('receiver', IS_TV),
    proxy: store.get('proxy', true),
    hideBad: store.get('hideBad', false),
    target: store.get('target', '')
  };
  if (qs.tv === '1') cfg.receiver = true;
  function saveCfg() { ['name', 'receiver', 'proxy', 'hideBad', 'target'].forEach(function (k) { store.set(k, cfg[k]); }); }

  var S = {
    view: 'home', g: '', src: '', q: '', items: [], total: 0, loading: false, gen: 0, done: false,
    fav: {}, homeGen: 0, homeRows: [], info: null, devices: [], builtAt: 0, groupsFor: ''
  };

  // ----- camadas (voltar do celular / controle da TV fecha player e janelas) -----
  var layers = [];
  function pushLayer(name, closeFn) { layers.push({ name: name, close: closeFn }); try { history.pushState({ l: layers.length }, ''); } catch (e) { /* ok */ } }
  w.addEventListener('popstate', function () { var L = layers.pop(); if (L) L.close(); });
  function back() { if (layers.length) history.back(); }

  // ----- helpers de UI -----
  function initials(n) {
    var p = String(n).replace(/[^A-Za-z0-9À-ÿ ]/g, ' ').trim().split(/\s+/);
    return ((p[0] || '?').charAt(0) + (p[1] ? p[1].charAt(0) : (p[0] || '').charAt(1) || '')).toUpperCase();
  }

  function hue(n) { var h = 0; for (var i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) % 360; return h; }

  function cardHtml(it) {
    var poster = it.k !== 'l';
    var sub = it.k === 's' ? it.c + ' episódios' : (it.c > 1 ? it.g + ' · ' + it.c + ' versões' : it.g);
    return '<button class="card' + (poster ? ' p' : '') + '" data-id="' + it.id + '" data-k="' + it.k + '">' +
      '<span class="art" style="background:hsl(' + hue(it.n) + ',18%,' + (poster ? 20 : 17) + '%)">' +
      '<span class="ini">' + esc(initials(it.n)) + '</span>' +
      (it.lg ? '<img src="' + esc(it.lg) + '" alt="" referrerpolicy="no-referrer">' : '') +
      (poster ? '' : '<span class="live-dot"></span>') +
      '<span class="star' + (S.fav[it.id] ? ' on' : '') + '" data-star="1"><i data-ic="star"></i></span></span>' +
      '<span class="t">' + esc(it.n) + '</span><span class="s">' + esc(sub) + '</span></button>';
  }

  function skelHtml(n, poster) {
    var h = '';
    for (var i = 0; i < n; i++) h += '<span class="card skel' + (poster ? ' p' : '') + '"><span class="art"></span><span class="t"></span><span class="s"></span></span>';
    return h;
  }

  function chip(label, on, attrs, count) {
    return '<button class="chip' + (on ? ' on' : '') + '" ' + attrs + '>' + esc(label) + (count ? '<small>' + count + '</small>' : '') + '</button>';
  }

  // ===================== listagem =====================
  function kindOfView() { return S.view === 'fav' ? '' : S.view === 'home' ? 'all' : S.view; }

  function loadGroups() {
    var k = kindOfView();
    var chips = $('chips'), sel = $('srcSel');
    $('filters').style.display = (k && k !== 'all') ? '' : 'none';
    if (!k || k === 'all') return;
    api('/api/groups?k=' + k).then(function (gs) {
      if (kindOfView() !== k) return;
      var h = chip('Todos', !S.g, 'data-g=""');
      gs.slice().sort(function (x, y) { return (x.g === 'Sem categoria') - (y.g === 'Sem categoria'); }).slice(0, 40).forEach(function (g) { h += chip(g.g, S.g === g.g, 'data-g="' + esc(g.g) + '"', g.c); });
      chips.innerHTML = h;
    }).catch(function () {});
    var opts = '<option value="">Todas as fontes</option>';
    ((S.info && S.info.sources) || []).forEach(function (s) {
      if (s.enabled && s.counts && s.counts[k] > 0) opts += '<option value="' + s.id + '"' + (S.src === s.id ? ' selected' : '') + '>' + esc(s.name) + ' (' + s.counts[k] + ')</option>';
    });
    sel.innerHTML = opts;
  }

  function resetList() {
    S.gen++; S.items = []; S.total = 0; S.done = false; S.loading = false;
    $('grid').innerHTML = '';
    $('empty').hidden = true;
    fetchPage();
  }

  function fetchPage() {
    if (S.loading || S.done) return;
    S.loading = true;
    var gen = S.gen, k = kindOfView();
    var url = '/api/items?lim=60&off=' + S.items.length + '&q=' + encodeURIComponent(S.q);
    if (S.view === 'fav') url += '&fav=1'; else url += '&k=' + k + '&g=' + encodeURIComponent(S.g) + '&src=' + encodeURIComponent(S.src);
    if (cfg.hideBad) url += '&hide=1';
    $('more').textContent = 'Carregando…'; $('more').hidden = false;
    api(url).then(function (r) {
      if (gen !== S.gen) return;
      S.loading = false;
      S.total = r.total;
      S.items = S.items.concat(r.items);
      var html = r.items.map(cardHtml).join('');
      $('grid').insertAdjacentHTML('beforeend', html);
      U.paintIcons($('grid'));
      S.done = S.items.length >= S.total;
      $('more').hidden = S.done;
      showEmpty();
      if (!S.done) maybeMore();
    }).catch(function (e) { if (gen !== S.gen) return; S.loading = false; $('more').textContent = 'Erro: ' + e.message; });
  }

  function showEmpty() {
    var e = $('empty');
    if (S.items.length) { e.hidden = true; return; }
    e.hidden = false;
    var t = S.info ? S.info.totals : { l: 0, m: 0, s: 0 };
    var loading = S.info && (S.info.building || S.info.sources.some(function (s) { return s.state === 'loading'; }));
    if (S.view === 'fav' && !S.q) e.innerHTML = '<b>Nenhum favorito ainda</b>Toque na estrela de um canal, filme ou série.';
    else if (loading && !(t.l + t.m + t.s)) e.innerHTML = '<b>Baixando as listas…</b>Na primeira vez pode levar um ou dois minutos. Esta tela atualiza sozinha.';
    else if (!(t.l + t.m + t.s)) e.innerHTML = '<b>Nenhuma lista carregada</b>Veja a aba <i>Fontes</i> para ver o que aconteceu e adicionar listas.';
    else e.innerHTML = '<b>Nada encontrado</b>Tente outro nome ou categoria.';
    $('more').hidden = true;
  }

  function maybeMore() {
    var m = $('more');
    if (m.hidden || S.loading || S.done) return;
    var r = m.getBoundingClientRect();
    if (r.top < window.innerHeight + 500) fetchPage();
  }
  w.addEventListener('scroll', U.debounce(maybeMore, 60), { passive: true });
  w.addEventListener('resize', U.debounce(maybeMore, 120));

  function currentIds() { return S.items.slice(0, 200).filter(function (i) { return i.k !== 's'; }).map(function (i) { return i.id; }); }

  // ===================== favoritos =====================
  function isFav(id) { return !!S.fav[id]; }
  function toggleFav(id) {
    var on = !S.fav[id];
    if (on) S.fav[id] = 1; else delete S.fav[id];
    paintStars(id);
    U.toast(on ? 'Adicionado aos favoritos' : 'Removido dos favoritos', 1500);
    api('/api/fav', { body: { id: id, on: on } }).catch(function () {});
    if (S.view === 'fav' && !on) {
      var c = $('grid').querySelector('[data-id="' + id + '"]');
      if (c) c.parentNode.removeChild(c);
    }
  }
  function paintStars(id) {
    var list = document.querySelectorAll('.card[data-id="' + id + '"] .star');
    for (var i = 0; i < list.length; i++) list[i].classList.toggle('on', !!S.fav[id]);
    var b = $('sheetFav'); if (b && b.getAttribute('data-id') === id) b.classList.toggle('on', !!S.fav[id]);
  }

  // ===================== reproduzir =====================
  function target() {
    if (!cfg.target || cfg.receiver) return null;
    for (var i = 0; i < S.devices.length; i++) if (S.devices[i].id === cfg.target) return S.devices[i];
    return null;
  }

  function play(id, ep) {
    var t = target();
    if (t) return castTo(t, id, ep);
    Player.open(id, ep || null, ep ? null : currentIds());
  }

  function castTo(t, id, ep) {
    api('/api/cast', { body: { to: t.id, cmd: 'play', data: { id: id, ep: ep || null, ids: ep ? null : currentIds() } } })
      .then(function () { U.toast('Enviado para ' + t.name); })
      .catch(function (e) { U.toast('Não consegui enviar: ' + e.message); });
  }

  function activate(id, k) {
    if (k === 's') openSeries(id); else play(id, null);
  }

  // ===================== série =====================
  var seriesState = null;
  function openSeries(id) {
    api('/api/series/' + encodeURIComponent(id)).then(function (d) {
      seriesState = { d: d, season: d.seasons.length ? d.seasons[0].s : 0 };
      showModal(renderSeries(), true);
    }).catch(function (e) { U.toast('Erro: ' + e.message); });
  }

  function renderSeries() {
    var d = seriesState.d;
    var h = '<h3>' + esc(d.n) + '</h3><p class="sub">' + esc(d.g) + ' · ' + d.seasons.length + ' temporada(s)</p>' +
      '<div class="row wrap"><button id="sheetFav" class="btn sm ghost' + (S.fav[d.id] ? ' on' : '') + '" data-id="' + d.id + '"><i data-ic="star"></i> Favorito</button></div>' +
      '<div class="seasons">';
    d.seasons.forEach(function (s) { h += chip('Temporada ' + s.s, s.s === seriesState.season, 'data-season="' + s.s + '"'); });
    h += '</div><div class="eps">';
    d.seasons.forEach(function (s) {
      if (s.s !== seriesState.season) return;
      s.eps.forEach(function (e) {
        h += '<div class="ep"><button data-ep="' + s.s + ':' + e.e + '"><em>E' + (e.e < 10 ? '0' : '') + e.e + '</em>Episódio ' + e.e + (e.c > 1 ? '<small>' + e.c + ' versões</small>' : '') + '<i data-ic="play"></i></button></div>';
      });
    });
    return h + '</div>';
  }

  // ===================== janela (modal) =====================
  function showModal(html, focus) {
    var m = $('modal');
    var wasOpen = !m.hidden;
    $('sheetBody').innerHTML = html;
    U.paintIcons($('sheetBody'));
    m.hidden = false;
    if (!wasOpen) pushLayer('modal', function () { m.hidden = true; seriesState = null; });
    if (focus) setTimeout(function () { var b = $('sheetBody').querySelector('[data-ep], .chip.on, button, input'); if (b) b.focus(); }, 30);
  }

  // ===================== páginas: Fontes =====================
  function ago(ts) {
    if (!ts) return 'nunca';
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'agora há pouco';
    if (m < 60) return 'há ' + m + ' min';
    var h = Math.round(m / 60);
    return h < 48 ? 'há ' + h + ' h' : 'há ' + Math.round(h / 24) + ' dias';
  }

  function sw(on, attrs) { return '<span class="sw' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '" tabindex="0" ' + attrs + '></span>'; }

  function renderSources() {
    var info = S.info; if (!info) return;
    var t = info.totals;
    var h = '<h2>Fontes de listas</h2><p class="sub">' + t.l + ' canais · ' + t.m + ' filmes · ' + t.s + ' séries na biblioteca. As listas são baixadas dos endereços abaixo e guardadas no servidor; versões repetidas do mesmo item viram "versões" para trocar quando uma cair.</p>' +
      '<div class="row wrap"><button class="btn" data-act="refreshAll"><i data-ic="refresh"></i> Atualizar tudo</button><button class="btn ghost" data-act="addSrc"><i data-ic="plus"></i> Adicionar fonte</button></div><div style="height:10px"></div>';
    info.sources.forEach(function (s) {
      var c = s.counts;
      var counts = c ? [c.l ? c.l + ' canais' : '', c.m ? c.m + ' filmes' : '', c.s ? c.s + ' episódios' : ''].filter(Boolean).join(' · ') : '';
      h += '<div class="box"><div class="row"><div class="grow"><b><span class="dot ' + s.state + '"></span>' + esc(s.name) + '</b>' +
        '<small>' + (s.state === 'loading' ? 'Atualizando…' : (s.state === 'ok' ? counts + ' · ' + ago(s.fetchedAt) : '')) + '</small>' +
        (s.error ? '<small style="color:var(--bad)">' + esc(s.error) + '</small>' : '') +
        (s.home ? '<small>' + esc(s.home) + '</small>' : '') + '</div>' +
        '<button class="btn sm ghost" data-act="refresh" data-id="' + s.id + '" aria-label="Atualizar"><i data-ic="refresh"></i></button>' +
        (s.custom ? '<button class="btn sm danger" data-act="del" data-id="' + s.id + '"><i data-ic="x"></i></button>' : '') +
        sw(s.enabled, 'data-act="toggle" data-id="' + s.id + '"') + '</div></div>';
    });
    h += '<h2 style="margin-top:22px">Ajustes</h2>' +
      '<div class="box"><div class="row"><div class="grow"><b>Passar pelo servidor (recomendado)</b><small>Resolve bloqueios de CORS e links que exigem cabeçalhos. Desligue só se o seu servidor for lento.</small></div>' + sw(cfg.proxy, 'data-act="cfgProxy"') + '</div></div>' +
      '<div class="box"><div class="row"><div class="grow"><b>Ocultar canais que falharam</b><small>Esconde o que não abriu da última vez (volta a aparecer se funcionar).</small></div>' + sw(cfg.hideBad, 'data-act="cfgBad"') + '</div></div>';
    $('src').innerHTML = h;
    U.paintIcons($('src'));
  }

  function addSourceForm() {
    showModal('<h3>Adicionar fonte</h3><p class="sub">Cole um link de lista M3U, um repositório do GitHub, ou o texto da lista.</p>' +
      '<label class="field"><span>Tipo</span><select id="fType"><option value="urls">Link de lista M3U/M3U8</option><option value="repo">Repositório do GitHub (dono/repo)</option><option value="user">Usuário do GitHub (todos os repositórios)</option><option value="web">Site/página (procura listas)</option><option value="paste">Colar o texto da lista</option></select></label>' +
      '<label class="field"><span>Nome</span><input id="fName" placeholder="Ex.: Minha lista"></label>' +
      '<label class="field"><span id="fLabel">Endereço</span><input id="fVal" placeholder="https://…"></label>' +
      '<label class="field" id="fTextWrap" hidden><span>Texto M3U</span><textarea id="fText" placeholder="#EXTM3U&#10;#EXTINF:-1,Canal&#10;http://…"></textarea></label>' +
      '<button class="btn" data-act="saveSrc">Adicionar</button>', true);
    var type = $('fType');
    type.onchange = function () {
      var t = type.value;
      $('fTextWrap').hidden = t !== 'paste';
      $('fVal').parentNode.hidden = t === 'paste';
      $('fLabel').textContent = t === 'repo' ? 'Repositório (dono/repo)' : t === 'user' ? 'Usuário do GitHub' : 'Endereço';
      $('fVal').placeholder = t === 'repo' ? 'iptv-org/iptv' : t === 'user' ? 'nome-do-usuario' : 'https://…';
    };
  }

  function saveSource() {
    var t = $('fType').value, body = { type: t, name: $('fName').value };
    var v = $('fVal').value.trim();
    if (t === 'urls' || t === 'web') body.url = v; else if (t === 'repo') body.repo = v; else if (t === 'user') body.user = v; else body.text = $('fText').value;
    api('/api/sources', { body: body }).then(function () { back(); U.toast('Fonte adicionada. Baixando…'); pollInfo(true); }).catch(function (e) { U.toast('Erro: ' + e.message); });
  }

  // ===================== página: TVs =====================
  function renderTvs() {
    var info = S.info;
    var urls = (info && info.urls) || [];
    var here = location.origin;
    var h = '<h2>TV e controle remoto</h2><p class="sub">Abra o endereço abaixo no navegador da TV LG (Wi-Fi da casa) e ative o <b>Modo TV</b>. Depois use o celular como controle: escolha a TV, toque num canal e ele toca na TV.</p>' +
      '<div class="box"><b>Endereço para abrir na TV</b>';
    (urls.length ? urls : [here]).forEach(function (u) { h += '<span class="urlbox">' + esc(u) + '</span>'; });
    h += '<small>Se a TV não abrir, confira se o computador do servidor está ligado e se o firewall permite a porta ' + esc(String(info ? info.port : '')) + '.</small></div>' +
      '<div class="box"><div class="row"><div class="grow"><b>Usar este aparelho como TV (Modo TV)</b><small>Ele fica esperando comandos do celular e toca o que você mandar.</small></div>' + sw(cfg.receiver, 'data-act="cfgReceiver"') + '</div>' +
      '<label class="field" style="margin:12px 0 0"><span>Nome deste aparelho</span><input id="devName" value="' + esc(cfg.name) + '" maxlength="30"></label></div>';

    var list = S.devices.filter(function (d) { return d.id !== cfg.id; });
    h += '<h2 style="margin-top:20px">TVs online</h2>';
    if (!list.length) h += '<div class="box"><small>Nenhuma TV em Modo TV agora. Abra o endereço acima na TV e ative o Modo TV.</small></div>';
    list.forEach(function (d) {
      var sel = cfg.target === d.id;
      var st = d.state;
      h += '<div class="box"><div class="row"><div class="grow"><b><span class="dot ok"></span>' + esc(d.name) + '</b><small>' + (st ? (st.paused ? 'Pausado: ' : 'Tocando: ') + esc(st.n) : 'Aguardando') + '</small></div>' +
        '<button class="btn sm ' + (sel ? '' : 'ghost') + '" data-act="target" data-id="' + d.id + '">' + (sel ? 'Selecionada ✓' : 'Usar esta TV') + '</button></div>';
      if (sel) h += '<div class="remote">' + [['prev', 'prev'], ['toggle', 'play'], ['next', 'next'], ['mute', 'mute'], ['volm', 'vol'], ['stop', 'stop']].map(function (b) {
        return '<button class="btn ghost" data-act="remote" data-cmd="' + b[0] + '" data-to="' + d.id + '">' + (b[0] === 'volm' ? '<i data-ic="vol"></i> −' : b[0] === 'mute' ? '<i data-ic="mute"></i>' : '<i data-ic="' + b[1] + '"></i>') + '</button>';
      }).join('') + '<button class="btn ghost" data-act="remote" data-cmd="volp" data-to="' + d.id + '"><i data-ic="vol"></i> +</button></div>';
      h += '</div>';
    });
    if (cfg.target) h += '<button class="btn ghost" data-act="target" data-id="">Voltar a tocar neste aparelho</button>';
    $('tvs').innerHTML = h;
    U.paintIcons($('tvs'));
    var nm = $('devName');
    if (nm) nm.onchange = function () { cfg.name = nm.value.trim() || 'Meu aparelho'; saveCfg(); connect(); };
  }

  function sendRemote(to, cmd) {
    var map = { toggle: ['toggle'], prev: ['prev'], next: ['next'], mute: ['mute'], stop: ['stop'], volm: ['vol', { d: -0.1 }], volp: ['vol', { d: 0.1 }] };
    var m = map[cmd]; if (!m) return;
    api('/api/cast', { body: { to: to, cmd: m[0], data: m[1] || {} } }).catch(function (e) { U.toast('Erro: ' + e.message); });
  }

  // ===================== castPill =====================
  function paintPill() {
    var p = $('castPill'), n = $('castName');
    var t = target();
    if (cfg.receiver) { p.classList.add('on'); n.textContent = 'Modo TV · ' + cfg.name; }
    else if (t) { p.classList.add('on'); n.textContent = 'Na TV: ' + t.name; }
    else { p.classList.remove('on'); n.textContent = 'Este aparelho'; }
  }

  // ===================== navegação entre seções =====================
  function setView(v, group) {
    S.view = v;
    var btns = document.querySelectorAll('#nav button[data-view]');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].getAttribute('data-view') === v || (v === 'menu' && btns[i].getAttribute('data-view') === 'more'));
    $('title').textContent = TITLES[v] || '';
    var page = v === 'tvs' || v === 'src' || v === 'more';
    var searching = v === 'home' && S.q;
    $('home').hidden = !(v === 'home' && !S.q);
    $('browse').hidden = page || (v === 'home' && !S.q);
    $('tvs').hidden = v !== 'tvs'; $('src').hidden = v !== 'src'; $('menu').hidden = v !== 'more';
    $('top').querySelector('.search').style.display = page ? 'none' : '';
    if (v !== 'more') store.set('view', v);
    window.scrollTo(0, 0);
    var sec = v === 'home' ? $('home') : v === 'tvs' ? $('tvs') : v === 'src' ? $('src') : v === 'more' ? $('menu') : $('browse');
    sec.classList.remove('enter'); void sec.offsetWidth; sec.classList.add('enter');
    if (v === 'tvs') renderTvs();
    else if (v === 'src') renderSources();
    else if (v === 'more') renderMenu();
    else if (v === 'home' && !searching) renderHome(true);
    else { S.g = group || ''; S.src = ''; loadGroups(); resetList(); }
  }

  // ===================== início (fileiras) =====================
  function renderHome(skeleton) {
    var el = $('home');
    if (skeleton) el.innerHTML = '<div class="rowx"><div class="rh"><h2>&nbsp;</h2></div><div class="rs">' + skelHtml(8, false) + '</div></div><div class="rowx"><div class="rh"><h2>&nbsp;</h2></div><div class="rs">' + skelHtml(8, true) + '</div></div>';
    var gen = ++S.homeGen;
    api('/api/home').then(function (r) {
      if (gen !== S.homeGen || S.view !== 'home') return;
      S.homeRows = r.rows;
      if (!r.rows.length) { el.innerHTML = ''; var e = $('empty'); el.innerHTML = '<div class="empty" style="padding-top:60px"><b>' + (S.info && S.info.building ? 'Baixando as listas…' : 'Nada por aqui ainda') + '</b>' + (S.info && S.info.building ? 'Na primeira vez pode levar um ou dois minutos. Esta tela atualiza sozinha.' : 'Veja a aba Fontes para adicionar listas.') + '</div>'; return; }
      el.innerHTML = r.rows.map(function (row, i) {
        return '<section class="rowx"><div class="rh"><h2>' + esc(row.title) + '</h2>' + (row.view || row.k ? '<button class="all" data-row="' + i + '">Ver tudo</button>' : '') + '</div>' +
          '<div class="rs">' + row.items.map(cardHtml).join('') + '</div></section>';
      }).join('');
      U.paintIcons(el);
    }).catch(function () {});
  }

  function renderMenu() {
    var who = S.info && S.info.user ? S.info.user : '';
    var items = [['fav', 'star', 'Minha lista'], ['tvs', 'cast', 'TVs e controle remoto'], ['src', 'list', 'Fontes de listas']];
    var h = '<h2>Mais</h2><div class="box menu-list">' + items.map(function (i) {
      return '<button data-view="' + i[0] + '"><i data-ic="' + i[1] + '"></i><span>' + i[2] + '</span><i class="chv" data-ic="chev"></i></button>';
    }).join('') + '<button data-act="logout"><i data-ic="logout"></i><span>Sair' + (who ? ' (' + esc(who) + ')' : '') + '</span></button></div>';
    $('menu').innerHTML = h;
    U.paintIcons($('menu'));
  }

  function logout() {
    api('/api/logout', { body: {} }).catch(function () {}).then(function () { location.href = '/login.html'; });
  }

  function applySearch() {
    var v = S.view;
    if (v === 'home') {
      $('home').hidden = !!S.q; $('browse').hidden = !S.q;
      if (S.q) { loadGroups(); resetList(); } else renderHome(false);
    } else if (v === 'l' || v === 'm' || v === 's' || v === 'fav') resetList();
  }

  // ===================== info / atualização periódica =====================
  var pollTimer = null;
  function pollInfo(force) {
    clearTimeout(pollTimer);
    api('/api/info').then(function (info) {
      var changed = !S.info || S.info.builtAt !== info.builtAt;
      S.info = info;
      if (S.view === 'src' && !document.activeElement.closest('#src input')) renderSourcesKeepFocus();
      if (changed && S.view === 'home' && !S.q) renderHome(false);
      else if (changed && (S.view === 'l' || S.view === 'm' || S.view === 's' || S.view === 'fav' || (S.view === 'home' && S.q))) { loadGroups(); resetList(); }
      var busy = info.building || info.sources.some(function (s) { return s.state === 'loading'; });
      pollTimer = setTimeout(pollInfo, busy ? 2500 : 20000);
    }).catch(function () { pollTimer = setTimeout(pollInfo, 6000); });
  }

  function renderSourcesKeepFocus() {
    var a = document.activeElement, key = a && a.getAttribute && (a.getAttribute('data-act') + ':' + (a.getAttribute('data-id') || ''));
    renderSources();
    if (key) { var els = $('src').querySelectorAll('[data-act]'); for (var i = 0; i < els.length; i++) if (els[i].getAttribute('data-act') + ':' + (els[i].getAttribute('data-id') || '') === key) { els[i].focus(); break; } }
  }

  // ===================== tempo real (SSE) =====================
  var es = null;
  function connect() {
    if (es) es.close();
    if (!w.EventSource) return;
    es = new EventSource('/api/events?device=' + cfg.id + '&name=' + encodeURIComponent(cfg.name) + '&role=' + (cfg.receiver ? 'receiver' : 'controller'));
    es.addEventListener('hello', function (e) { S.devices = JSON.parse(e.data).devices; devicesChanged(); });
    es.addEventListener('devices', function (e) { S.devices = JSON.parse(e.data); devicesChanged(); });
    es.addEventListener('state', function (e) { var d = JSON.parse(e.data); S.fav = {}; d.fav.forEach(function (id) { S.fav[id] = 1; }); });
    es.addEventListener('command', function (e) { if (cfg.receiver) { var c = JSON.parse(e.data); Player.command(c.cmd, c.data); } });
  }

  function devicesChanged() {
    if (cfg.target && !target() && !cfg.receiver) { /* TV saiu do ar: continua selecionada até o usuário trocar */ }
    paintPill();
    if (S.view === 'tvs' && !document.activeElement.closest('#tvs input')) renderTvs();
  }

  var reportTimer = null;
  Player.hooks.report = function (st) {
    if (!cfg.receiver) return;
    clearTimeout(reportTimer);
    reportTimer = setTimeout(function () { api('/api/device-state', { body: { id: cfg.id, state: st } }).catch(function () {}); }, 300);
  };
  Player.hooks.isFav = isFav;
  Player.hooks.toggleFav = toggleFav;
  Player.hooks.settings = function () { return { proxy: cfg.proxy }; };
  Player.hooks.opened = function () { pushLayer('player', Player.close); };
  Player.hooks.back = function () { if (layers.length && layers[layers.length - 1].name === 'player') history.back(); else Player.close(); };
  Player.hooks.cast = function (id, ep) {
    var t = target();
    if (!t) {
      var list = S.devices.filter(function (d) { return d.id !== cfg.id; });
      if (list.length === 1) { cfg.target = list[0].id; saveCfg(); paintPill(); t = list[0]; }
      else { U.toast(list.length ? 'Escolha uma TV na aba TVs' : 'Nenhuma TV em Modo TV encontrada'); return; }
    }
    castTo(t, id, ep);
    back();
  };

  // ===================== eventos =====================
  function bind() {
    $('nav').addEventListener('click', function (e) {
      if (e.target.closest('[data-act="logout"]')) return logout();
      var b = e.target.closest('button[data-view]'); if (b) setView(b.getAttribute('data-view'));
    });
    $('menu').addEventListener('click', function (e) {
      if (e.target.closest('[data-act="logout"]')) return logout();
      var b = e.target.closest('button[data-view]'); if (b) setView(b.getAttribute('data-view'));
    });
    $('home').addEventListener('click', function (e) {
      var all = e.target.closest('[data-row]');
      if (all) { var row = S.homeRows[parseInt(all.getAttribute('data-row'), 10)]; if (row) { if (row.view) setView(row.view); else setView(row.k, row.g); } return; }
      var card = e.target.closest('.card'); if (!card) return;
      if (e.target.closest('[data-star]')) return toggleFav(card.getAttribute('data-id'));
      activate(card.getAttribute('data-id'), card.getAttribute('data-k'));
    });
    // segurar o dedo num card = favoritar
    var lp = null, lpFired = false;
    document.addEventListener('touchstart', function (e) { var c = e.target.closest && e.target.closest('.card'); if (!c || c.classList.contains('skel')) return; lpFired = false; lp = setTimeout(function () { lpFired = true; toggleFav(c.getAttribute('data-id')); if (navigator.vibrate) navigator.vibrate(18); }, 520); }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(function (ev) { document.addEventListener(ev, function () { clearTimeout(lp); }, { passive: true }); });
    document.addEventListener('click', function (e) { if (lpFired) { lpFired = false; e.stopPropagation(); e.preventDefault(); } }, true);
    $('castPill').onclick = function () { setView('tvs'); };

    $('grid').addEventListener('click', function (e) {
      var card = e.target.closest('.card'); if (!card) return;
      var id = card.getAttribute('data-id');
      if (e.target.closest('[data-star]')) { toggleFav(id); return; }
      activate(id, card.getAttribute('data-k'));
    });
    document.addEventListener('error', function (e) { if (e.target.tagName === 'IMG' && e.target.parentNode && e.target.parentNode.className === 'art') e.target.style.display = 'none'; }, true);
    $('grid').addEventListener('keydown', function (e) {
      var card = e.target.closest && e.target.closest('.card');
      if (card && (e.keyCode === 403 || e.key === 'f')) toggleFav(card.getAttribute('data-id'));
    });

    $('chips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      S.g = b.getAttribute('data-g');
      var all = $('chips').querySelectorAll('.chip');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i] === b);
      resetList();
    });
    $('srcSel').onchange = function () { S.src = this.value; resetList(); };

    var q = $('q');
    q.addEventListener('input', U.debounce(function () { S.q = q.value.trim(); applySearch(); }, 300));
    q.addEventListener('keydown', function (e) { if (e.keyCode === 13) q.blur(); });

    $('modal').addEventListener('click', function (e) {
      if (e.target === $('modal')) return back();
      var t = e.target;
      var season = t.closest('[data-season]');
      if (season && seriesState) { seriesState.season = parseInt(season.getAttribute('data-season'), 10); $('sheetBody').innerHTML = renderSeries(); U.paintIcons($('sheetBody')); var on = $('sheetBody').querySelector('.chip.on'); if (on) on.focus(); return; }
      var ep = t.closest('[data-ep]');
      if (ep && seriesState) { var id = seriesState.d.id; var epk = ep.getAttribute('data-ep'); if (target()) { castTo(target(), id, epk); back(); } else Player.open(id, epk, null); return; }
      if (t.closest('#sheetFav') && seriesState) { toggleFav(seriesState.d.id); return; }
      var act = t.closest('[data-act]');
      if (act && act.getAttribute('data-act') === 'saveSrc') saveSource();
    });
    $('modalX').onclick = back;

    var pages = function (e) {
      var a = e.target.closest('[data-act]'); if (!a) return;
      var act = a.getAttribute('data-act'), id = a.getAttribute('data-id');
      if (act === 'refreshAll') { api('/api/refresh', { body: {} }).then(function () { U.toast('Atualizando todas as fontes…'); pollInfo(true); }); }
      else if (act === 'refresh') { api('/api/refresh', { body: { id: id } }).then(function () { pollInfo(true); }); }
      else if (act === 'del') { if (confirm('Remover esta fonte?')) api('/api/sources/' + id, { method: 'DELETE' }).then(function () { pollInfo(true); }); }
      else if (act === 'toggle') { var on = !a.classList.contains('on'); a.classList.toggle('on', on); api('/api/sources/' + id, { method: 'PATCH', body: { enabled: on } }).then(function () { pollInfo(true); }); }
      else if (act === 'addSrc') addSourceForm();
      else if (act === 'cfgProxy') { cfg.proxy = !cfg.proxy; saveCfg(); a.classList.toggle('on', cfg.proxy); }
      else if (act === 'cfgBad') { cfg.hideBad = !cfg.hideBad; saveCfg(); a.classList.toggle('on', cfg.hideBad); }
      else if (act === 'cfgReceiver') { cfg.receiver = !cfg.receiver; if (cfg.receiver) cfg.target = ''; saveCfg(); connect(); paintPill(); renderTvs(); U.toast(cfg.receiver ? 'Modo TV ligado' : 'Modo TV desligado'); }
      else if (act === 'target') { cfg.target = id; saveCfg(); paintPill(); renderTvs(); if (id) U.toast('Agora os canais tocam nessa TV'); }
      else if (act === 'remote') sendRemote(a.getAttribute('data-to'), a.getAttribute('data-cmd'));
    };
    $('src').addEventListener('click', pages);
    $('tvs').addEventListener('click', pages);
    // interruptores também respondem a Enter/Espaço
    document.addEventListener('keydown', function (e) {
      if ((e.keyCode === 13 || e.keyCode === 32) && e.target.classList && e.target.classList.contains('sw')) { e.preventDefault(); e.target.click(); }
    });
  }

  // ===================== início =====================
  function init() {
    U.paintIcons();
    Player.init();
    bind();
    api('/api/state').then(function (st) { st.fav.forEach(function (id) { S.fav[id] = 1; }); }).catch(function () {})
      .then(function () { return api('/api/info').catch(function () { return null; }); })
      .then(function (info) {
        S.info = info;
        paintPill();
        var lv = store.get('view', 'home'); setView(lv === 'l' || lv === 'm' || lv === 's' ? lv : 'home');
        connect();
        pollInfo();
        if (IS_TV && !store.get('tvhint', false)) { store.set('tvhint', true); U.toast('Modo TV ligado: este aparelho toca o que você mandar pelo celular.', 5000); }
      });
  }
  init();
})(window);
