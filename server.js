#!/usr/bin/env node
/*
 * Porta-Retrato — servidor opcional (sem dependências).
 *
 * Rode `node server.js` em um computador da casa e abra o endereço mostrado
 * no tablet, na TV e no celular. As fotos e músicas ficam na pasta ./data e
 * todos os aparelhos enxergam a mesma biblioteca e os mesmos ajustes.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PORT = Number(process.env.PORT) || 8080;

const DIRS = {
  photos: path.join(DATA, 'photos'),
  thumbs: path.join(DATA, 'thumbs'),
  music: path.join(DATA, 'music'),
};
const DB_FILE = path.join(DATA, 'db.json');

const MAX_PHOTO = 40 * 1024 * 1024;
const MAX_THUMB = 2 * 1024 * 1024;
const MAX_MUSIC = 200 * 1024 * 1024;
const MAX_JSON = 64 * 1024;

const ID_RE = /^[a-z0-9]{8,40}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Só estes caminhos do repositório são servidos como arquivos estáticos.
const STATIC_FILES = new Set(['/index.html', '/sw.js', '/manifest.webmanifest']);
const STATIC_DIRS = ['/css/', '/js/', '/icons/'];

/* ---------- banco de dados (um JSON simples) ---------- */

for (const dir of Object.values(DIRS)) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.tmp')) fs.unlinkSync(path.join(dir, f));
  }
}

let db = { photos: [], music: [], settings: null };
try {
  const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db = {
    photos: Array.isArray(loaded.photos) ? loaded.photos : [],
    music: Array.isArray(loaded.music) ? loaded.music : [],
    settings: loaded.settings && typeof loaded.settings === 'object' ? loaded.settings : null,
  };
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.error('Não foi possível ler ' + DB_FILE + ': ' + err.message);
    process.exit(1);
  }
}

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------- eventos em tempo real (SSE) ---------- */

const clients = new Set();

function broadcast(event) {
  const line = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const res of clients) res.write(line);
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000).unref();

/* ---------- utilidades HTTP ---------- */

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendFile(req, res, file, type, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'não encontrado' });
    const headers = { 'Content-Type': type, 'Cache-Control': cache, 'Accept-Ranges': 'bytes' };
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] !== '' || m[2] !== '') && st.size > 0) {
      if (m[1] === '') {
        start = Math.max(0, st.size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(end, Number(m[2]));
      }
      if (start > end) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    }
    headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

/** Grava o corpo da requisição em `dest` (via arquivo temporário). */
function receiveFile(req, dest, limit) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.' + process.pid + '.' + Date.now() + '.tmp';
    const out = fs.createWriteStream(tmp);
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      req.unpipe(out);
      out.destroy();
      fs.unlink(tmp, () => {});
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) fail(httpError(413, 'arquivo grande demais'));
    });
    req.on('aborted', () => fail(httpError(400, 'envio interrompido')));
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (done) return;
      done = true;
      if (!size) {
        fs.unlink(tmp, () => {});
        return reject(httpError(400, 'arquivo vazio'));
      }
      fs.rename(tmp, dest, (err) => (err ? reject(err) : resolve(size)));
    });
    req.pipe(out);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON) return reject(httpError(413, 'corpo grande demais'));
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(httpError(400, 'JSON inválido'));
      }
    });
  });
}

function cleanText(value, fallback) {
  const s = String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  return s || fallback;
}

function cleanInt(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push('http://' + net.address + ':' + PORT);
    }
  }
  return out;
}

/* ---------- rotas da API ---------- */

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', recurso, id]
  const resource = parts[1];
  const id = parts[2];
  const method = req.method;
  const q = url.searchParams;

  if (parts.length > 3) throw httpError(404, 'não encontrado');
  if (id !== undefined && !ID_RE.test(id)) throw httpError(400, 'id inválido');

  if (resource === 'info' && method === 'GET') {
    return sendJson(res, 200, { app: 'porta-retrato', addresses: lanAddresses(), port: PORT });
  }

  if (resource === 'events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (resource === 'photos') {
    if (method === 'GET' && !id) return sendJson(res, 200, db.photos);
    if (method === 'PUT' && id) {
      await receiveFile(req, path.join(DIRS.photos, id + '.jpg'), MAX_PHOTO);
      const item = {
        id,
        name: cleanText(q.get('name'), 'Foto'),
        date: cleanInt(q.get('date')) || Date.now(),
        w: cleanInt(q.get('w')),
        h: cleanInt(q.get('h')),
      };
      db.photos = db.photos.filter((p) => p.id !== id).concat(item);
      saveDb();
      broadcast({ type: 'library' });
      return sendJson(res, 200, item);
    }
    if (method === 'DELETE' && id) {
      db.photos = db.photos.filter((p) => p.id !== id);
      saveDb();
      fs.unlink(path.join(DIRS.photos, id + '.jpg'), () => {});
      fs.unlink(path.join(DIRS.thumbs, id + '.jpg'), () => {});
      broadcast({ type: 'library' });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (resource === 'thumbs' && method === 'PUT' && id) {
    await receiveFile(req, path.join(DIRS.thumbs, id + '.jpg'), MAX_THUMB);
    return sendJson(res, 200, { ok: true });
  }

  if (resource === 'music') {
    if (method === 'GET' && !id) return sendJson(res, 200, db.music);
    if (method === 'PUT' && id) {
      await receiveFile(req, path.join(DIRS.music, id), MAX_MUSIC);
      const type = String(q.get('type') || '');
      const item = {
        id,
        name: cleanText(q.get('name'), 'Música'),
        type: /^audio\/[\w.+-]+$/.test(type) ? type : 'audio/mpeg',
      };
      db.music = db.music.filter((t) => t.id !== id).concat(item);
      saveDb();
      broadcast({ type: 'music' });
      return sendJson(res, 200, item);
    }
    if (method === 'DELETE' && id) {
      db.music = db.music.filter((t) => t.id !== id);
      saveDb();
      fs.unlink(path.join(DIRS.music, id), () => {});
      broadcast({ type: 'music' });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (resource === 'settings' && !id) {
    if (method === 'GET') return sendJson(res, 200, db.settings || {});
    if (method === 'PUT') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'ajustes inválidos');
      db.settings = body;
      saveDb();
      broadcast({ type: 'settings', from: cleanText(q.get('from'), '') });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (resource === 'command' && method === 'POST' && !id) {
    const body = await readJson(req);
    const action = String((body && body.action) || '');
    if (!['next', 'prev', 'toggle', 'start', 'stop'].includes(action)) throw httpError(400, 'comando inválido');
    broadcast({ type: 'command', action, from: cleanText(body.from, '') });
    return sendJson(res, 200, { ok: true });
  }

  throw httpError(404, 'não encontrado');
}

/* ---------- servidor ---------- */

function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    return sendJson(res, 400, { error: 'URL inválida' });
  }
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    return handleApi(req, res, url).catch((err) => {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.destroy();
      // Em erro de envio, fecha a conexão em vez de ler o resto do corpo.
      res.setHeader('Connection', 'close');
      sendJson(res, status, { error: err.message });
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'método não permitido' });
  }

  const media = /^\/media\/(photos|thumbs|music)\/([a-z0-9]{8,40})(\.jpg)?$/.exec(pathname);
  if (media) {
    const kind = media[1];
    const id = media[2];
    const immutable = 'public, max-age=31536000, immutable';
    if (kind === 'music') {
      const track = db.music.find((t) => t.id === id);
      if (!track || media[3]) return sendJson(res, 404, { error: 'não encontrado' });
      return sendFile(req, res, path.join(DIRS.music, id), track.type, immutable);
    }
    if (!media[3]) return sendJson(res, 404, { error: 'não encontrado' });
    return sendFile(req, res, path.join(DIRS[kind], id + '.jpg'), 'image/jpeg', immutable);
  }

  const rel = pathname === '/' ? '/index.html' : pathname;
  const allowed =
    STATIC_FILES.has(rel) ||
    (STATIC_DIRS.some((dir) => rel.startsWith(dir)) && /^[\w./-]+$/.test(rel) && !rel.includes('..'));
  if (!allowed) return sendJson(res, 404, { error: 'não encontrado' });
  sendFile(req, res, path.join(ROOT, rel), MIME[path.extname(rel)] || 'application/octet-stream', 'no-cache');
}

const server = http.createServer(handle);
server.listen(PORT, () => {
  console.log('\n  Porta-Retrato no ar!\n');
  console.log('  Neste computador:   http://localhost:' + PORT);
  for (const addr of lanAddresses()) console.log('  Tablet, TV, celular: ' + addr);
  console.log('\n  Fotos e músicas ficam em: ' + DATA + '\n');
});
