/*
 * Navegação por setas (controle remoto da TV / teclado) — foco espacial.
 * O app registra camadas (modal, player) e a navegação fica dentro da camada do topo.
 */
(function (w) {
  'use strict';

  var SEL = 'button:not([disabled]), a[href], input:not([type=hidden]), select, textarea, [tabindex="0"]';
  var KEYS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };

  function visible(el) {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function scopeEl() {
    var pl = document.getElementById('player');
    if (pl && !pl.hidden) return pl;
    var modal = document.getElementById('modal');
    if (modal && !modal.hidden) return modal;
    return document.getElementById('app');
  }

  function candidates(scope) {
    var list = scope.querySelectorAll(SEL), out = [];
    for (var i = 0; i < list.length; i++) if (visible(list[i])) out.push(list[i]);
    return out;
  }

  function keepInView(el) {
    var r = el.getBoundingClientRect();
    var top = 90, bottom = window.innerHeight - (window.innerWidth < 900 ? 90 : 30);
    var scroller = el.closest('.sheet');
    if (scroller) { el.scrollIntoView(false); return; }
    if (r.top < top) window.scrollBy(0, r.top - top - 40);
    else if (r.bottom > bottom) window.scrollBy(0, r.bottom - bottom + 40);
  }

  function move(dir) {
    var scope = scopeEl();
    var all = candidates(scope);
    if (!all.length) return false;
    var cur = document.activeElement;
    if (!cur || cur === document.body || !scope.contains(cur)) { all[0].focus(); keepInView(all[0]); return true; }
    var cr = cur.getBoundingClientRect();
    var cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    var best = null, bestScore = Infinity;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === cur) continue;
      var r = el.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      var dx = x - cx, dy = y - cy, prim, sec;
      if (dir === 'right') { if (dx <= 4) continue; prim = Math.max(0, r.left - cr.right); sec = Math.abs(dy); }
      else if (dir === 'left') { if (dx >= -4) continue; prim = Math.max(0, cr.left - r.right); sec = Math.abs(dy); }
      else if (dir === 'down') { if (dy <= 4) continue; prim = Math.max(0, r.top - cr.bottom); sec = Math.abs(dx); }
      else { if (dy >= -4) continue; prim = Math.max(0, cr.top - r.bottom); sec = Math.abs(dx); }
      var score = prim * 2 + sec * 3;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) { best.focus(); keepInView(best); return true; }
    if (dir === 'down') window.scrollBy(0, 200);
    return false;
  }

  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var dir = KEYS[e.keyCode];
    if (w.IPTV_PLAYER_KEY && w.IPTV_PLAYER_KEY(e, dir)) { e.preventDefault(); return; }
    if (!dir) return;
    var t = e.target;
    var typing = t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /text|search|url|number/.test(t.type)));
    if (typing && (dir === 'left' || dir === 'right')) return;
    if (t && t.tagName === 'INPUT' && t.type === 'range' && (dir === 'left' || dir === 'right')) return;
    if (t && t.tagName === 'SELECT') return;
    if (move(dir)) e.preventDefault();
  }

  // anel de foco só quando se usa teclado/controle (não ao tocar)
  var tv = /Web0S|webOS|SmartTV|SMART-TV|Tizen|HbbTV/i.test(navigator.userAgent);
  if (tv) document.body.className += ' kb';
  document.addEventListener('keydown', function (e) { if (e.keyCode >= 9 && e.keyCode <= 40 || e.keyCode > 400) document.body.classList.add('kb'); }, true);
  ['mousedown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, function () { if (!tv) document.body.classList.remove('kb'); }, true); });
  document.addEventListener('keydown', onKey);
  w.Nav = { move: move, focusFirst: function () { var a = candidates(scopeEl()); if (a[0]) a[0].focus(); } };
})(window);
