'use strict';
/*
 * Proxy de streams. O navegador da TV/celular fala só com este servidor:
 *  - resolve CORS e conteúdo misto (http dentro de página https)
 *  - envia Referer/User-Agent exigidos por alguns provedores
 *  - reescreve playlists HLS (.m3u8) para que os segmentos também passem por aqui
 *  - repassa Range (avançar/voltar em filmes)
 */

const http = require('http');
const https = require('https');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_MANIFEST = 6 * 1024 * 1024;

function blocked(host) {
  if (process.env.IPTV_ALLOW_LOOPBACK) return false; // só para testes
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1' ||
    /^127\./.test(host) || /^169\.254\./.test(host) || host.endsWith('.localhost');
}

/** GET/HEAD seguindo redirecionamentos. Resolve { res, url }. */
function open(url, opts, hops) {
  hops = hops || 0;
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL inválida')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('protocolo não suportado'));
    if (blocked(u.hostname)) return reject(new Error('destino bloqueado'));
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': opts.ua || UA, Accept: '*/*', 'Accept-Encoding': 'identity', Connection: 'close' };
    if (opts.referer) {
      headers.Referer = opts.referer;
      try { headers.Origin = new URL(opts.referer).origin; } catch (e) { /* ok */ }
    }
    if (opts.range) headers.Range = opts.range;
    const req = lib.request(u, {
      method: opts.method || 'GET', headers: headers, rejectUnauthorized: false,
      insecureHTTPParser: true, timeout: opts.timeout || 20000,
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 6) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).href; } catch (e) { return reject(new Error('redirecionamento inválido')); }
        return resolve(open(next, opts, hops + 1));
      }
      resolve({ res: res, url: u.href, req: req });
    });
    req.on('timeout', function () { req.destroy(new Error('tempo esgotado')); });
    req.on('error', reject);
    if (opts.signal) opts.signal.once('abort', function () { req.destroy(); });
    req.end();
  });
}

function proxyUrl(abs, opts) {
  let s = '/api/proxy?u=' + encodeURIComponent(abs);
  if (opts.referer) s += '&r=' + encodeURIComponent(opts.referer);
  if (opts.ua) s += '&ua=' + encodeURIComponent(opts.ua);
  return s;
}

/** Reescreve uma playlist HLS para apontar para o proxy. */
function rewriteManifest(text, baseUrl, opts) {
  const abs = function (ref) { try { return new URL(ref, baseUrl).href; } catch (e) { return ref; } };
  return text.split(/\r?\n/).map(function (line) {
    const t = line.trim();
    if (!t) return line;
    if (t.charAt(0) === '#') {
      return line.replace(/URI="([^"]+)"/g, function (_, ref) {
        if (/^data:/i.test(ref)) return _;
        return 'URI="' + proxyUrl(abs(ref), opts) + '"';
      });
    }
    return proxyUrl(abs(t), opts);
  }).join('\n');
}

function isManifest(ct, url, head) {
  if (/mpegurl/i.test(ct || '')) return true;
  if (/\.m3u8?(?:$|\?)/i.test(url)) return true;
  return head.slice(0, 7).toString('latin1') === '#EXTM3U';
}

/** Detecta o tipo de stream pelos primeiros bytes. */
function sniff(ct, head) {
  ct = (ct || '').toLowerCase();
  if (head.slice(0, 7).toString('latin1') === '#EXTM3U' || /mpegurl/.test(ct)) return 'hls';
  if (head.length > 188 && head[0] === 0x47 && head[188] === 0x47) return 'ts';
  if (/mp2t/.test(ct)) return 'ts';
  if (head.slice(4, 8).toString('latin1') === 'ftyp' || /mp4/.test(ct)) return 'file';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'file';
  if (/^video\//.test(ct) || /matroska|webm/.test(ct)) return 'file';
  return 'unknown';
}

function readHead(res, n) {
  return new Promise(function (resolve) {
    const bufs = [];
    let size = 0;
    let done = false;
    const finish = function () {
      if (done) return;
      done = true;
      res.destroy();
      resolve(Buffer.concat(bufs));
    };
    res.on('data', function (b) { bufs.push(b); size += b.length; if (size >= n) finish(); });
    res.on('end', finish);
    res.on('error', finish);
    res.on('close', finish);
    setTimeout(finish, 8000);
  });
}

async function probe(url, opts) {
  const r = await open(url, Object.assign({ range: 'bytes=0-2047', timeout: 15000 }, opts));
  const head = await readHead(r.res, 2048);
  const status = r.res.statusCode;
  const ct = r.res.headers['content-type'] || '';
  return { ok: status < 400, status: status, type: status < 400 ? sniff(ct, head) : 'error', ct: ct };
}

/** Atende /api/proxy?u=...&r=...&ua=... */
async function handleProxy(req, res, query) {
  const target = query.get('u');
  if (!target) { res.writeHead(400); return res.end('falta u'); }
  const opts = { referer: query.get('r') || '', ua: query.get('ua') || '' };
  if (req.headers.range) opts.range = req.headers.range;
  const ctl = new (require('events'))();
  res.on('close', function () { ctl.emit('abort'); });
  opts.signal = ctl;
  let up;
  try {
    up = await open(target, Object.assign({ method: req.method === 'HEAD' ? 'HEAD' : 'GET' }, opts));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end('Falha no servidor de origem: ' + e.message);
  }
  const ur = up.res;
  const ct = ur.headers['content-type'] || '';
  const base = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

  if (req.method === 'HEAD') {
    res.writeHead(ur.statusCode, Object.assign({ 'Content-Type': ct || 'application/octet-stream' }, base));
    ur.destroy();
    return res.end();
  }

  // espia o começo para saber se é playlist
  let ended = false;
  let endCb = null;
  const onEnd = function () { ended = true; if (endCb) endCb(); };
  ur.on('end', onEnd);
  ur.on('close', onEnd);
  ur.on('error', onEnd);
  const first = await new Promise(function (resolve) {
    let settled = false;
    const done = function (b) { if (!settled) { settled = true; ur.pause(); resolve(b); } };
    ur.once('data', function (b) { done(b); });
    endCb = function () { done(Buffer.alloc(0)); };
    if (ended) done(Buffer.alloc(0));
    setTimeout(function () { done(Buffer.alloc(0)); }, 20000);
  });
  endCb = null;

  if (ur.statusCode < 400 && isManifest(ct, up.url, first)) {
    const bufs = [first];
    let size = first.length;
    await new Promise(function (resolve) {
      ur.on('data', function (b) { size += b.length; if (size <= MAX_MANIFEST) bufs.push(b); });
      if (ended) return resolve();
      endCb = resolve;
      ur.resume();
    });
    const text = Buffer.concat(bufs).toString('utf8');
    if (text.indexOf('#EXTM3U') >= 0) {
      const out = rewriteManifest(text, up.url, opts);
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/vnd.apple.mpegurl' }, base));
      return res.end(out);
    }
    res.writeHead(ur.statusCode, Object.assign({ 'Content-Type': ct || 'text/plain' }, base));
    return res.end(text);
  }

  const h = Object.assign({ 'Content-Type': ct || 'application/octet-stream' }, base);
  ['content-length', 'content-range', 'accept-ranges'].forEach(function (k) { if (ur.headers[k]) h[k] = ur.headers[k]; });
  res.writeHead(ur.statusCode, h);
  res.write(first);
  ur.pipe(res);
  ur.resume();
  res.on('close', function () { ur.destroy(); });
}

module.exports = { handleProxy, probe, rewriteManifest, sniff, open };
