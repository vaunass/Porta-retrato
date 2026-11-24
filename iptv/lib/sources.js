'use strict';
/*
 * Fontes de listas: baixa, guarda em cache no disco e entrega os itens já
 * classificados. Tipos:
 *   repo  – repositório do GitHub (arquivos conhecidos e/ou descoberta pela API)
 *   user  – todos os repositórios de um usuário do GitHub
 *   urls  – links diretos de listas M3U
 *   paste – texto M3U colado pelo usuário
 *   web   – página/site: procura links .m3u/.m3u8 e dados JSON com streams
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildEntries } = require('./m3u');

const TTL = 12 * 3600 * 1000;
const DISCOVERY_TTL = 24 * 3600 * 1000;
const MAX_LIST_BYTES = 120 * 1024 * 1024;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const GUESS_FILES = [
  'playlist.m3u', 'playlist.m3u8', 'lista.m3u', 'lista.m3u8', 'canais.m3u', 'iptv.m3u',
  'index.m3u', 'tv.m3u', 'brasil.m3u', 'brazil.m3u', 'filmes.m3u', 'series.m3u',
  'lists/brazil.m3u', 'lists/brasil.m3u',
];

function sha(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12); }

async function fetchText(url, opts) {
  opts = opts || {};
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, opts.timeout || 40000);
  try {
    const headers = Object.assign({ 'User-Agent': UA, Accept: '*/*' }, opts.headers || {});
    const res = await fetch(url, { headers: headers, signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    const max = opts.max || MAX_LIST_BYTES;
    const chunks = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > max) { ctl.abort(); throw new Error('arquivo grande demais'); }
      chunks.push(Buffer.from(r.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

function rawUrl(repo, branch, p) {
  return 'https://raw.githubusercontent.com/' + repo + '/' + (branch || 'HEAD') + '/' +
    p.split('/').map(encodeURIComponent).join('/');
}

/** Converte links do GitHub (blob/raw) para raw.githubusercontent.com. */
function toRaw(u) {
  let m = u.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(?:blob|raw)\/(.+)$/i);
  if (m) return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2].replace(/^refs\/heads\//, '');
  return u;
}

function extractPlaylistLinks(text) {
  const out = new Set();
  const re = /https?:\/\/[^\s"'<>)\]\\]+?\.m3u8?(?:\?[^\s"'<>)\]\\]*)?/gi;
  let m;
  while ((m = re.exec(text))) {
    const u = toRaw(m[0]);
    if (/SEU-USUARIO|example\.com|localhost/i.test(u)) continue;
    out.add(u);
  }
  return Array.from(out);
}

class Sources {
  /**
   * @param dir pasta de dados
   * @param defaults lista padrão
   * @param store { custom: [], enabled: {}, save() }
   * @param onChange chamado quando a biblioteca precisa ser refeita
   */
  constructor(dir, defaults, store, onChange) {
    this.dir = path.join(dir, 'cache');
    fs.mkdirSync(this.dir, { recursive: true });
    this.defaults = defaults;
    this.store = store;
    this.onChange = onChange;
    this.status = new Map();   // id -> {state, error, fetchedAt, docs, entries}
    this.entries = new Map();  // id -> entries[]
    this.token = process.env.GITHUB_TOKEN || '';
    this.discovery = this._readJson(path.join(this.dir, 'discovery.json')) || {};
    this.queue = [];
    this.running = 0;
    this.timer = null;
  }

  _readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

  defs() { return this.defaults.concat(this.store.custom || []); }
  get(id) { return this.defs().find(function (d) { return d.id === id; }); }
  isEnabled(id) { return this.store.enabled[id] !== false; }

  list() {
    const self = this;
    return this.defs().map(function (d) {
      const st = self.status.get(d.id) || {};
      return {
        id: d.id, name: d.name, type: d.type, home: d.home || d.url || '',
        custom: !!d.custom, enabled: self.isEnabled(d.id),
        state: st.state || 'idle', error: st.error || '', fetchedAt: st.fetchedAt || 0,
        docs: st.docs || 0,
      };
    });
  }

  /** Itens das fontes ativas, na ordem de prioridade. */
  active() {
    const self = this;
    return this.defs().filter(function (d) { return self.isEnabled(d.id) && self.entries.has(d.id); })
      .map(function (d) { return { id: d.id, entries: self.entries.get(d.id) }; });
  }

  // ---------- cache em disco ----------
  _dir(id) { const d = path.join(this.dir, id.replace(/[^a-z0-9_-]/gi, '_')); fs.mkdirSync(d, { recursive: true }); return d; }

  _saveDocs(id, docs, meta) {
    const d = this._dir(id);
    fs.readdirSync(d).forEach(function (f) { fs.unlinkSync(path.join(d, f)); });
    docs.forEach(function (doc) { fs.writeFileSync(path.join(d, sha(doc.key) + '.m3u'), doc.text); });
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta));
  }

  async loadCache() {
    for (const def of this.defs()) {
      const d = this._dir(def.id);
      const meta = this._readJson(path.join(d, 'meta.json'));
      if (!meta) continue;
      try {
        const docs = fs.readdirSync(d).filter(function (f) { return f.endsWith('.m3u'); })
          .map(function (f) { return { key: f, text: fs.readFileSync(path.join(d, f), 'utf8') }; });
        await this._ingest(def, docs, meta.fetchedAt, meta.error || '');
      } catch (e) { /* cache ruim é ignorado */ }
    }
  }

  async _ingest(def, docs, fetchedAt, error) {
    let all = [];
    for (const doc of docs) {
      const r = await buildEntries(doc.text, def.id, def.max);
      all = all.concat(r.entries);
    }
    this.entries.set(def.id, all);
    this.status.set(def.id, {
      state: all.length ? 'ok' : 'error', fetchedAt: fetchedAt, docs: docs.length,
      error: all.length ? '' : (error || 'nenhum canal encontrado'),
    });
  }

  // ---------- descoberta no GitHub ----------
  async _gh(url) {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'porta-retrato-iptv' };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    return JSON.parse(await fetchText(url, { headers: headers, timeout: 20000, max: 30 * 1024 * 1024 }));
  }

  async _discoverRepo(repo, branch) {
    const hit = this.discovery[repo];
    if (hit && Date.now() - hit.t < DISCOVERY_TTL) return hit.urls;
    let urls = [];
    try {
      const tree = await this._gh('https://api.github.com/repos/' + repo + '/git/trees/HEAD?recursive=1');
      const pref = /br|brasil|brazil|canais|filmes|series|lista|iptv|tv|playlist/i;
      const files = (tree.tree || []).filter(function (n) {
        return n.type === 'blob' && /\.m3u8?$/i.test(n.path) && (n.size || 0) < 100 * 1024 * 1024 &&
          !/(^|\/)(node_modules|\.github|epg)\//i.test(n.path);
      }).sort(function (a, b) { return (pref.test(b.path) ? 1 : 0) - (pref.test(a.path) ? 1 : 0); }).slice(0, 25);
      urls = files.map(function (n) { return rawUrl(repo, branch, n.path); });
    } catch (e) {
      // API indisponível (limite/ rede): tenta o README e nomes comuns
      try {
        const readme = await fetchText(rawUrl(repo, branch, 'README.md'), { timeout: 15000, max: 2e6 });
        urls = extractPlaylistLinks(readme);
      } catch (e2) { /* sem README */ }
      const probes = await Promise.all(GUESS_FILES.map(async function (f) {
        const u = rawUrl(repo, branch, f);
        try { const r = await fetch(u, { method: 'HEAD', headers: { 'User-Agent': UA } }); return r.ok ? u : null; } catch (x) { return null; }
      }));
      probes.forEach(function (u) { if (u && urls.indexOf(u) < 0) urls.push(u); });
    }
    if (urls.length) {
      this.discovery[repo] = { t: Date.now(), urls: urls };
      try { fs.writeFileSync(path.join(this.dir, 'discovery.json'), JSON.stringify(this.discovery)); } catch (e) { /* ok */ }
    }
    return urls;
  }

  async _urlsFor(def) {
    if (def.type === 'urls') return def.urls || [];
    if (def.type === 'repo') {
      const urls = (def.files || []).map(function (f) { return rawUrl(def.repo, def.branch, f); });
      if (def.discover || !urls.length) {
        (await this._discoverRepo(def.repo, def.branch)).forEach(function (u) { if (urls.indexOf(u) < 0) urls.push(u); });
      }
      return urls;
    }
    if (def.type === 'user') {
      const repos = await this._gh('https://api.github.com/users/' + def.user + '/repos?per_page=100&sort=pushed');
      const urls = [];
      const chosen = repos.filter(function (r) { return !r.fork && !r.archived; }).slice(0, def.maxRepos || 12);
      for (const r of chosen) {
        (await this._discoverRepo(r.full_name, r.default_branch || 'HEAD')).forEach(function (u) { urls.push(u); });
      }
      return urls;
    }
    return [];
  }

  // ---------- raspagem de sites ----------
  async _scrapeWeb(pageUrl) {
    const docs = [];
    const base = new URL(pageUrl);
    const found = new Set();
    const jsons = new Set();
    const synth = [];
    const grab = function (text, from) {
      text = text.replace(/\\\//g, '/');
      const re = /(?:https?:)?\/\/[^\s"'`<>\\)]+?\.(?:m3u8?|json)(?:\?[^\s"'`<>\\)]*)?|["'`](\/?[\w.\/%~-]+\.(?:m3u8?|json))["'`]/gi;
      let m;
      while ((m = re.exec(text))) {
        let u = m[1] || m[0];
        try { u = new URL(u.startsWith('//') ? 'https:' + u : u, from).href; } catch (e) { continue; }
        u = toRaw(u);
        if (/\.json(\?|$)/i.test(u)) { if (new URL(u).origin === base.origin) jsons.add(u); } else found.add(u);
      }
    };

    const html = await fetchText(pageUrl, { timeout: 25000, max: 4e6 });
    grab(html, pageUrl);
    const scripts = [];
    html.replace(/<script[^>]+src=["']([^"']+)["']/gi, function (_, s) {
      try { const u = new URL(s, pageUrl); if (u.origin === base.origin) scripts.push(u.href); } catch (e) { /* ignora */ }
      return _;
    });
    for (const s of scripts.slice(0, 8)) {
      try { grab(await fetchText(s, { timeout: 20000, max: 6e6 }), s); } catch (e) { /* ignora */ }
    }
    ['/channels.json', '/canais.json', '/data/channels.json', '/api/channels', '/playlist.m3u', '/lista.m3u']
      .forEach(function (p) { if (p.endsWith('.m3u')) found.add(new URL(p, base).href); else jsons.add(new URL(p, base).href); });

    for (const u of Array.from(found).slice(0, 40)) {
      try {
        const t = await fetchText(u, { timeout: 25000 });
        if (!/^\s*#EXTM3U/.test(t) && t.indexOf('#EXTINF') < 0) continue;
        if (/#EXT-X-(?:TARGETDURATION|STREAM-INF)/.test(t)) {
          synth.push({ name: decodeURIComponent(u.split('/').slice(-2, -1)[0] || 'Canal'), url: u });
        } else docs.push({ key: u, text: t });
      } catch (e) { /* tenta o próximo */ }
    }
    for (const u of Array.from(jsons).slice(0, 12)) {
      try {
        const t = await fetchText(u, { timeout: 20000, max: 40e6 });
        walkJson(JSON.parse(t), synth, 0);
      } catch (e) { /* não é JSON de canais */ }
    }
    if (synth.length) {
      const esc = function (s) { return String(s || '').replace(/["\r\n]/g, ' '); };
      const lines = ['#EXTM3U'];
      synth.slice(0, 100000).forEach(function (c) {
        lines.push('#EXTINF:-1 tvg-logo="' + esc(c.logo) + '" group-title="' + esc(c.group) + '",' + esc(c.name).replace(/,/g, ' '));
        lines.push(c.url);
      });
      docs.push({ key: pageUrl + '#web', text: lines.join('\n') });
    }
    return docs;
  }

  // ---------- atualização ----------
  async _fetchDocs(def) {
    if (def.type === 'paste') return [{ key: 'paste', text: def.text || '' }];
    if (def.type === 'web') return this._scrapeWeb(def.url);
    const urls = await this._urlsFor(def);
    const docs = [];
    const errors = [];
    for (const u of urls) {
      try {
        const text = await fetchText(u, { timeout: 90000 });
        if (text.indexOf('#EXTINF') >= 0) docs.push({ key: u, text: text });
        else errors.push('sem itens: ' + u);
      } catch (e) { errors.push((e.name === 'AbortError' ? 'tempo esgotado' : e.message) + ' — ' + u); }
    }
    if (!docs.length) throw new Error(urls.length ? errors.slice(0, 2).join('; ') : 'nenhuma lista M3U encontrada (rede bloqueada ou limite da API do GitHub; defina GITHUB_TOKEN)');
    return docs;
  }

  async refreshOne(id, force) {
    const def = this.get(id);
    if (!def) return;
    const st = this.status.get(id) || {};
    if (!force && st.state === 'ok' && Date.now() - st.fetchedAt < TTL) return;
    this.status.set(id, Object.assign({}, st, { state: 'loading' }));
    try {
      const docs = await this._fetchDocs(def);
      const now = Date.now();
      await this._ingest(def, docs, now, '');
      this._saveDocs(id, docs, { fetchedAt: now });
    } catch (e) {
      const cur = this.status.get(id) || {};
      const had = this.entries.has(id) && this.entries.get(id).length;
      this.status.set(id, {
        state: had ? 'ok' : 'error', fetchedAt: cur.fetchedAt || 0, docs: cur.docs || 0,
        error: (e && e.message) || String(e),
      });
    }
    this._changed();
  }

  _changed() {
    const self = this;
    clearTimeout(this.timer);
    this.timer = setTimeout(function () { self.onChange(); }, 1200);
  }

  /** Atualiza fontes (3 ao mesmo tempo). ids vazio = todas as ativas. */
  refresh(ids, force) {
    const self = this;
    const list = ids && ids.length ? ids : this.defs().filter(function (d) { return self.isEnabled(d.id); }).map(function (d) { return d.id; });
    list.forEach(function (id) { if (!self.queue.some(function (j) { return j.id === id; })) self.queue.push({ id: id, force: !!force }); });
    return this._pump();
  }

  _pump() {
    const self = this;
    return new Promise(function (resolve) {
      const next = function () {
        while (self.running < 3 && self.queue.length) {
          const job = self.queue.shift();
          if (!job || !job.id) continue;
          self.running++;
          self.refreshOne(job.id, job.force).then(function () { self.running--; next(); });
        }
        if (!self.running && !self.queue.length) resolve();
      };
      next();
    });
  }

  // ---------- gerenciamento ----------
  add(def) {
    def.custom = true;
    def.id = 'c' + sha(def.name + Date.now() + Math.random());
    this.store.custom = (this.store.custom || []).concat([def]);
    this.store.save();
    return def;
  }

  remove(id) {
    const before = (this.store.custom || []).length;
    this.store.custom = (this.store.custom || []).filter(function (d) { return d.id !== id; });
    if (this.store.custom.length === before) return false;
    this.entries.delete(id); this.status.delete(id);
    try { fs.rmSync(this._dir(id), { recursive: true, force: true }); } catch (e) { /* ok */ }
    this.store.save();
    this._changed();
    return true;
  }

  setEnabled(id, on) {
    this.store.enabled[id] = !!on;
    this.store.save();
    this._changed();
  }
}

const NAME_KEYS = ['name', 'title', 'nome', 'channel', 'canal', 'label'];
const URL_KEYS = ['url', 'stream', 'src', 'link', 'streamurl', 'stream_url', 'm3u8', 'source', 'video'];
const LOGO_KEYS = ['logo', 'image', 'icon', 'poster', 'thumbnail', 'cover', 'img'];
const GROUP_KEYS = ['group', 'category', 'categoria', 'genre', 'grupo'];

function pick(o, keys) {
  for (const k of Object.keys(o)) {
    if (keys.indexOf(k.toLowerCase()) >= 0 && typeof o[k] === 'string' && o[k]) return o[k];
  }
  return '';
}

function walkJson(node, out, depth) {
  if (depth > 8 || out.length > 100000 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(function (n) { walkJson(n, out, depth + 1); }); return; }
  const url = pick(node, URL_KEYS);
  const name = pick(node, NAME_KEYS);
  if (url && name && /^https?:\/\//i.test(url)) {
    out.push({ name: name, url: url, logo: pick(node, LOGO_KEYS), group: pick(node, GROUP_KEYS) });
  }
  Object.keys(node).forEach(function (k) { if (node[k] && typeof node[k] === 'object') walkJson(node[k], out, depth + 1); });
}

module.exports = { Sources, fetchText, extractPlaylistLinks, toRaw, walkJson };
