'use strict';
/*
 * Biblioteca: junta os itens de todas as fontes ativas, agrupa duplicados
 * (o mesmo canal/filme em várias listas vira um item com "versões" para
 * trocar quando uma cair) e responde às buscas com paginação.
 */

const crypto = require('crypto');
const { searchText } = require('./m3u');

function hashId(prefix, key) {
  return prefix + crypto.createHash('sha1').update(key).digest('base64url').slice(0, 10);
}

function tick() { return new Promise(function (r) { setImmediate(r); }); }

class Library {
  constructor() {
    this.items = new Map();
    this.order = { l: [], m: [], s: [] };
    this.groups = { l: [], m: [], s: [] };
    this.sourceCounts = new Map();
    this.builtAt = 0;
  }

  /** sources: [{ id, entries }] na ordem de prioridade. */
  async rebuild(sources) {
    const items = new Map();
    const order = { l: [], m: [], s: [] };
    const counts = new Map();
    let n = 0;

    for (const src of sources) {
      const c = { l: 0, m: 0, s: 0 };
      counts.set(src.id, c);
      for (const e of src.entries) {
        if (++n % 30000 === 0) await tick();
        const id = hashId(e.k, e.key);
        let it = items.get(id);
        if (!it) {
          it = { id: id, k: e.k, n: e.n, nn: searchText(e.n), lg: e.lg || '', g: e.g, ss: [], alts: [] };
          if (e.k === 's') it.eps = new Map();
          items.set(id, it);
          order[e.k].push(it);
        } else {
          if (!it.lg && e.lg) it.lg = e.lg;
        }
        if (it.ss.indexOf(e.s) < 0) it.ss.push(e.s);
        const alt = { u: e.u, s: e.s, l: e.l };
        if (e.r) alt.r = e.r;
        if (e.ua) alt.ua = e.ua;

        if (e.k === 's') {
          const ek = e.ep.s + ':' + e.ep.e;
          let ep = it.eps.get(ek);
          if (!ep) { ep = { s: e.ep.s, e: e.ep.e, alts: [] }; it.eps.set(ek, ep); c.s++; }
          if (!ep.alts.some(function (a) { return a.u === alt.u; })) ep.alts.push(alt);
        } else {
          if (!it.alts.some(function (a) { return a.u === alt.u; })) it.alts.push(alt);
          if (it.alts.length === 1) c[e.k]++;
        }
      }
    }

    order.m.sort(function (a, b) { return a.nn < b.nn ? -1 : a.nn > b.nn ? 1 : 0; });
    order.s.sort(function (a, b) { return a.nn < b.nn ? -1 : a.nn > b.nn ? 1 : 0; });

    const groups = { l: [], m: [], s: [] };
    for (const k of ['l', 'm', 's']) {
      const g = new Map();
      for (const it of order[k]) g.set(it.g, (g.get(it.g) || 0) + 1);
      groups[k] = Array.from(g.entries())
        .map(function (p) { return { g: p[0], c: p[1] }; })
        .sort(function (a, b) { return b.c - a.c; });
    }

    this.items = items;
    this.order = order;
    this.groups = groups;
    this.sourceCounts = counts;
    this.all = order.l.concat(order.m, order.s);
    this.builtAt = Date.now();
  }

  totals() {
    return { l: this.order.l.length, m: this.order.m.length, s: this.order.s.length };
  }

  card(it) {
    return {
      id: it.id, k: it.k, n: it.n, lg: it.lg, g: it.g,
      c: it.k === 's' ? it.eps.size : it.alts.length,
    };
  }

  /** Busca com filtros e paginação. */
  query(p) {
    const lim = Math.max(1, Math.min(200, p.lim || 60));
    const off = Math.max(0, p.off || 0);
    const tokens = p.q ? searchText(p.q).split(' ').filter(Boolean) : [];
    let base;
    if (p.ids) {
      base = [];
      for (const id of p.ids) { const it = this.items.get(id); if (it) base.push(it); }
    } else {
      base = p.k === 'all' ? (this.all || []) : (this.order[p.k] || this.order.l);
    }
    const bad = p.hide;
    const out = [];
    let total = 0;
    const exact = [];
    for (let i = 0; i < base.length; i++) {
      const it = base[i];
      if (p.g && it.g !== p.g) continue;
      if (p.src && it.ss.indexOf(p.src) < 0) continue;
      if (bad && bad.has(it.id)) continue;
      if (tokens.length) {
        let ok = true;
        for (let t = 0; t < tokens.length; t++) if (it.nn.indexOf(tokens[t]) < 0) { ok = false; break; }
        if (!ok) continue;
        if (it.nn.indexOf(tokens[0]) === 0) exact.push(it);
      }
      out.push(it);
      total++;
    }
    let list = out;
    if (tokens.length && exact.length && exact.length < out.length) {
      const set = new Set(exact);
      list = exact.concat(out.filter(function (it) { return !set.has(it); }));
    }
    const self = this;
    return { total: total, items: list.slice(off, off + lim).map(function (it) { return self.card(it); }) };
  }

  /** Fileiras da tela inicial. */
  home(favIds, recentIds) {
    const self = this;
    const rows = [];
    const cards = function (ids) { return ids.map(function (id) { return self.items.get(id); }).filter(Boolean).slice(0, 30).map(function (it) { return self.card(it); }); };
    const rec = cards(recentIds || []);
    if (rec.length) rows.push({ id: 'recent', title: 'Continuar assistindo', items: rec });
    const fav = cards((favIds || []).slice().reverse());
    if (fav.length) rows.push({ id: 'fav', title: 'Minha lista', view: 'fav', items: fav });

    const day = Math.floor(Date.now() / 86400000);
    const pick = function (k, g, n) {
      const arr = self.order[k];
      const out = [];
      const seen = new Set();
      let seed = day * 9301 + g.length * 49297 + k.charCodeAt(0);
      for (let tries = 0; tries < 4000 && out.length < n && arr.length; tries++) {
        seed = (seed * 9301 + 49297) % 233280;
        const it = arr[Math.floor(seed / 233280 * arr.length)];
        if (!it || seen.has(it.id) || it.g !== g || (k !== 'l' && !it.lg)) continue;
        seen.add(it.id);
        out.push(self.card(it));
      }
      if (out.length < n) {
        for (let i = 0; i < arr.length && out.length < n; i++) {
          if (arr[i].g === g && !seen.has(arr[i].id)) { seen.add(arr[i].id); out.push(self.card(arr[i])); }
        }
      }
      return out;
    };
    const BR = /bras|brazil|aberta|not[ií]cia|esporte|infantil|24 horas|document|variedade|m[uú]sica/i;
    const add = function (k, label, count, skip) {
      const gs = self.groups[k].filter(function (x) { return x.g !== 'Sem categoria' && x.g !== 'Geral' && !(skip && skip.test(x.g)) && x.c >= 6; }).sort(function (a, b) { return (BR.test(b.g) ? 1 : 0) - (BR.test(a.g) ? 1 : 0); }).slice(0, count);
      gs.forEach(function (x) {
        const items = pick(k, x.g, 24);
        if (items.length) rows.push({ id: k + ':' + x.g, title: label ? label + ' · ' + x.g : x.g, k: k, g: x.g, items: items });
      });
    };
    add('l', '', 3);
    add('m', 'Filmes', 4);
    add('s', 'Séries', 2);
    return rows;
  }

  seriesDetail(id) {
    const it = this.items.get(id);
    if (!it || it.k !== 's') return null;
    const seasons = new Map();
    for (const ep of it.eps.values()) {
      if (!seasons.has(ep.s)) seasons.set(ep.s, []);
      seasons.get(ep.s).push({ e: ep.e, c: ep.alts.length });
    }
    return {
      id: it.id, n: it.n, lg: it.lg, g: it.g,
      seasons: Array.from(seasons.keys()).sort(function (a, b) { return a - b; }).map(function (s) {
        return { s: s, eps: seasons.get(s).sort(function (a, b) { return a.e - b.e; }) };
      }),
    };
  }

  /** Versões reproduzíveis de um item (ou de um episódio "s:e"). */
  streams(id, ep) {
    const it = this.items.get(id);
    if (!it) return null;
    let alts = it.alts;
    let name = it.n;
    if (it.k === 's') {
      const e = ep ? it.eps.get(ep) : null;
      if (!e) return null;
      alts = e.alts;
      const pad = function (x) { return (x < 10 ? '0' : '') + x; };
      name = it.n + ' · T' + pad(e.s) + ' E' + pad(e.e);
    }
    return { id: it.id, k: it.k, n: name, title: it.n, lg: it.lg, g: it.g, alts: alts, ep: ep || null };
  }

  /** Próximo/anterior episódio, para tocar em sequência. */
  neighbor(id, ep, dir) {
    const it = this.items.get(id);
    if (!it || it.k !== 's') return null;
    const list = Array.from(it.eps.values()).sort(function (a, b) { return a.s - b.s || a.e - b.e; });
    const i = list.findIndex(function (x) { return (x.s + ':' + x.e) === ep; });
    const t = list[i + dir];
    return t ? t.s + ':' + t.e : null;
  }
}

module.exports = { Library };
