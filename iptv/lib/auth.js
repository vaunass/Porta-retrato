'use strict';
/*
 * Login simples (um usuário). A senha vem de:
 *   1. variáveis IPTV_USER / IPTV_PASS (ou arquivo .env), ou
 *   2. data/auth.json, criado por `node set-login.js` (guarda só o hash scrypt).
 * Sessões ficam em cookie HttpOnly por 90 dias. Tentativas erradas são limitadas por IP.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_MS = 90 * 24 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const COOKIE = 'iptv_s';

const sha = function (s) { return crypto.createHash('sha256').update(s).digest(); };
const same = function (a, b) { return crypto.timingSafeEqual(sha(String(a)), sha(String(b))); };

function hashPassword(pass, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  return { salt: salt, hash: crypto.scryptSync(pass, salt, 32).toString('hex') };
}

class Auth {
  constructor(dir) {
    this.authFile = path.join(dir, 'auth.json');
    this.sessFile = path.join(dir, 'sessions.json');
    this.fails = new Map();
    this.timer = null;
    this.envUser = process.env.IPTV_USER || '';
    this.envPass = process.env.IPTV_PASS || '';
    this.file = null;
    try { this.file = JSON.parse(fs.readFileSync(this.authFile, 'utf8')); } catch (e) { /* sem arquivo */ }
    this.sessions = {};
    try { this.sessions = JSON.parse(fs.readFileSync(this.sessFile, 'utf8')); } catch (e) { /* novo */ }
    this.prune();
  }

  get enabled() { return !!(this.envPass || (this.file && this.file.hash)); }
  get user() { return this.envPass ? (this.envUser || 'admin') : (this.file ? this.file.user : ''); }

  prune() {
    const now = Date.now();
    Object.keys(this.sessions).forEach(function (k) { if (this.sessions[k] < now) delete this.sessions[k]; }, this);
  }

  save() {
    clearTimeout(this.timer);
    const self = this;
    this.timer = setTimeout(function () { fs.writeFile(self.sessFile, JSON.stringify(self.sessions), { mode: 0o600 }, function () {}); }, 300);
  }

  verify(user, pass) {
    user = String(user || '').trim().toLowerCase();
    pass = String(pass || '');
    if (this.envPass) {
      const okU = same(user, (this.envUser || 'admin').toLowerCase());
      const okP = same(pass, this.envPass);
      return okU && okP;
    }
    if (this.file) {
      const okU = same(user, String(this.file.user || '').toLowerCase());
      const h = crypto.scryptSync(pass, this.file.salt, 32);
      const okP = crypto.timingSafeEqual(h, Buffer.from(this.file.hash, 'hex'));
      return okU && okP;
    }
    return false;
  }

  locked(ip) {
    const f = this.fails.get(ip);
    return !!(f && f.until > Date.now());
  }

  /** Resolve { ok, token, wait } */
  login(ip, user, pass) {
    if (this.locked(ip)) return { ok: false, locked: true };
    if (!this.verify(user, pass)) {
      const f = this.fails.get(ip) || { n: 0, until: 0 };
      f.n++;
      if (f.n >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.n = 0; }
      this.fails.set(ip, f);
      return { ok: false, locked: f.until > Date.now() };
    }
    this.fails.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions[sha(token).toString('hex')] = Date.now() + SESSION_MS;
    this.save();
    return { ok: true, token: token };
  }

  token(req) {
    const c = req.headers.cookie || '';
    const m = c.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
    return m ? m[1] : '';
  }

  check(req) {
    if (!this.enabled) return true;
    const t = this.token(req);
    if (!t) return false;
    const exp = this.sessions[sha(t).toString('hex')];
    return !!exp && exp > Date.now();
  }

  logout(req) {
    const t = this.token(req);
    if (t) { delete this.sessions[sha(t).toString('hex')]; this.save(); }
  }

  cookie(token, secure) {
    return COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_MS / 1000) + (secure ? '; Secure' : '');
  }
  clearCookie() { return COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'; }
}

module.exports = { Auth, hashPassword };
