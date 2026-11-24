'use strict';
/*
 * Leitura de listas M3U/M3U8 e classificação dos itens
 * (ao vivo / filme / série), além de normalização de nomes
 * para juntar versões repetidas do mesmo canal ou filme.
 */

const MAX_NAME = 160;

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Texto para busca: minúsculo, sem acentos, só letras e números. */
function searchText(s) {
  return stripAccents(String(s || '')).toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Marcas de qualidade que não mudam a identidade do canal.
const QUALITY = /\b(?:uhd|fhd|hd|sd|4k|8k|h\.?26[45]|hevc|avc|1080[pi]?|720p?|576p?|480p?|360p?|240p?|60fps|50fps)\b/gi;
const NOISE_TAGS = /[\[(]\s*(?:geo[- ]?blocked|not 24\/7|backup|offline|vpn|\d{3,4}[pi]|hd|fhd|sd|uhd|4k)\s*[\])]/gi;
const ANY_BRACKET = /\[[^\]]*\]/g;

/** Chave para juntar o mesmo canal ao vivo vindo de listas diferentes. */
function liveKey(name) {
  let s = String(name || '');
  s = s.replace(NOISE_TAGS, ' ').replace(ANY_BRACKET, ' ');
  s = s.replace(/\((?:op[cç][aã]o|opt(?:ion)?)\s*\d+\)/gi, ' ');
  s = s.replace(/\bop[cç][aã]o\s*\d+\b/gi, ' ');
  s = s.replace(QUALITY, ' ');
  s = stripAccents(s).toLowerCase().replace(/&/g, 'e').replace(/[^a-z0-9]+/g, '');
  return s;
}

const AUDIO_TAG = /\(\s*(?:dublado|legendado|dual|nacional|leg|dub|original|pt-?br|multi)[^)]*\)/gi;
const OPTION_TAG = /\(?\s*-?\s*op[cç][aã]o\s*\d+\s*\)?/gi;

/** Chave para juntar o mesmo filme (dublado/legendado/opções). */
function movieKey(name) {
  let s = String(name || '').replace(AUDIO_TAG, ' ').replace(OPTION_TAG, ' ');
  s = s.replace(/\[[^\]]*\]/g, ' ');
  return stripAccents(s).toLowerCase().replace(/&/g, 'e').replace(/[^a-z0-9]+/g, '');
}

/** Nome mostrado: tira as marcas de áudio/opção, que viram o rótulo da fonte. */
function cleanTitle(name) {
  let s = String(name || '').replace(AUDIO_TAG, ' ').replace(OPTION_TAG, ' ');
  s = s.replace(/\s+[-–]\s*$/, '').replace(/\s{2,}/g, ' ').trim();
  return s || String(name || '').trim();
}

/** Rótulo curto da versão: "Dublado · Opção 2". */
function altLabel(name) {
  const bits = [];
  const a = String(name || '').match(/\(\s*(dublado|legendado|dual|nacional|leg|dub|original)[^)]*\)/i);
  if (a) bits.push(a[1].charAt(0).toUpperCase() + a[1].slice(1).toLowerCase());
  const o = String(name || '').match(/op[cç][aã]o\s*(\d+)/i);
  if (o) bits.push('Opção ' + o[1]);
  const q = String(name || '').match(/\b(4k|uhd|fhd|hd|sd|1080p?|720p?|480p?)\b/i);
  if (q) bits.push(q[1].toUpperCase());
  return bits.join(' · ');
}

const SERIES_RE = /^(.*?)[\s._\-–]*[\[(]?\b[ST](\d{1,2})\s?[ ._\-]?\s?E(\d{1,4})\b[\])]?\s*(.*)$/i;
const SERIES_RE2 = /^(.*?)[\s._\-–]+(\d{1,2})x(\d{1,3})\b\s*(.*)$/i;

/** Detecta "Nome S01E02" e devolve {title, s, e} ou null. */
function parseEpisode(name) {
  const clean = String(name || '').replace(AUDIO_TAG, ' ').replace(OPTION_TAG, ' ');
  const m = clean.match(SERIES_RE) || clean.match(SERIES_RE2);
  if (!m || !m[1] || m[1].trim().length < 2) return null;
  return {
    title: m[1].replace(/[\s\-–:|]+$/, '').trim(),
    s: parseInt(m[2], 10),
    e: parseInt(m[3], 10),
  };
}

function parseAttrs(line) {
  const out = {};
  const re = /([A-Za-z0-9_-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(line))) out[m[1].toLowerCase()] = m[2];
  return out;
}

/** Posição da vírgula que separa os atributos do nome (ignora as dentro de aspas). */
function nameComma(line) {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 34) q = !q;
    else if (c === 44 && !q) return i;
  }
  return -1;
}

/** "url|User-Agent=x&Referer=y" (estilo Kodi). */
function splitPipe(url, entry) {
  const i = url.indexOf('|');
  if (i < 0) return url;
  const base = url.slice(0, i);
  url.slice(i + 1).split('&').forEach(function (kv) {
    const j = kv.indexOf('=');
    if (j < 0) return;
    const k = kv.slice(0, j).toLowerCase();
    let v = kv.slice(j + 1);
    try { v = decodeURIComponent(v); } catch (e) { /* mantém */ }
    if (k === 'user-agent') entry.ua = v;
    else if (k === 'referer' || k === 'referrer') entry.r = v;
  });
  return base;
}

/**
 * Lê o texto de uma lista M3U. Chama onEntry para cada item http(s).
 * Cede o processador de tempos em tempos para o servidor continuar respondendo.
 */
function parseM3U(text, onEntry) {
  return new Promise(function (resolve) {
    const lines = text.split(/\r?\n/);
    const stats = { entries: 0, skipped: 0, epg: '' };
    let i = 0;
    let cur = null;

    function step() {
      const end = Math.min(lines.length, i + 40000);
      for (; i < end; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (line.charCodeAt(0) === 35) { // '#'
          if (line.startsWith('#EXTINF')) {
            const c = nameComma(line);
            const head = c < 0 ? line : line.slice(0, c);
            const attrs = parseAttrs(head);
            let name = c < 0 ? '' : line.slice(c + 1).trim();
            if (!name) name = attrs['tvg-name'] || '';
            cur = {
              n: name.slice(0, MAX_NAME),
              lg: attrs['tvg-logo'] || '',
              g: attrs['group-title'] || '',
              tid: attrs['tvg-id'] || '',
              tt: (attrs['tvg-type'] || '').toLowerCase(),
            };
          } else if (cur && line.startsWith('#EXTGRP:')) {
            if (!cur.g) cur.g = line.slice(8).trim();
          } else if (cur && /^#EXTVLCOPT:/i.test(line)) {
            const kv = line.slice(11);
            const j = kv.indexOf('=');
            if (j > 0) {
              const k = kv.slice(0, j).toLowerCase();
              const v = kv.slice(j + 1).trim();
              if (k === 'http-referrer' || k === 'http-referer') cur.r = v;
              else if (k === 'http-user-agent') cur.ua = v;
            }
          } else if (line.startsWith('#EXTM3U')) {
            const a = parseAttrs(line);
            stats.epg = a['url-tvg'] || a['x-tvg-url'] || '';
          }
          continue;
        }
        // linha de URL
        if (!cur) { continue; }
        const entry = cur;
        cur = null;
        const url = splitPipe(line, entry);
        if (!/^https?:\/\//i.test(url)) { stats.skipped++; continue; }
        entry.u = url;
        if (!entry.n) {
          try { entry.n = decodeURIComponent(url.split('/').pop().split('?')[0]).replace(/\.\w{2,4}$/, ''); } catch (e) { entry.n = 'Sem nome'; }
        }
        stats.entries++;
        onEntry(entry);
      }
      if (i < lines.length) setImmediate(step);
      else resolve(stats);
    }
    step();
  });
}

const VOD_EXT = /\.(?:mp4|mkv|avi|mov|wmv|flv|webm|m4v)(?:$|[?#])/i;

/** Decide se um item é ao vivo ('l'), filme ('m') ou série ('s'). */
function classify(entry) {
  const name = entry.n;
  const group = (entry.g || '').toLowerCase();
  const url = entry.u;
  const path = url.replace(/^https?:\/\/[^/]+/i, '');
  const ep = parseEpisode(name);
  let vod = false;

  if (entry.tt === 'live') vod = false;
  else if (entry.tt === 'movie' || entry.tt === 'series') vod = true;
  else if (/\/(?:series|movie|movies|vod|filmes)\//i.test(path)) vod = true;
  else if (/\/live\//i.test(path)) vod = false;
  else if (VOD_EXT.test(path)) vod = true;
  else if (/^(?:filmes?|movies?|series?|séries?|animes?|doramas?|novelas?|vod|cinema)\b/.test(group)) vod = true;
  else if (/\.m3u8?(?:$|\?)/i.test(path) || /\.ts(?:$|\?)/i.test(path)) vod = false;

  if (!vod) return { k: 'l' };
  if (ep || entry.tt === 'series' || /\/series\//i.test(path)) {
    if (ep) return { k: 's', ep: ep };
  }
  return { k: 'm' };
}

const GROUP_PREFIX = /^(?:filmes?|movies?|s[eé]ries?|animes?|doramas?|novelas?)\s*[-|:/]+\s*/i;

function normGroup(g, kind) {
  let s = String(g || '').split(';')[0].trim();
  if (kind !== 'l') s = s.replace(GROUP_PREFIX, '').trim();
  if (!s || s === '#') s = kind === 'l' ? 'Sem categoria' : 'Geral';
  return s.slice(0, 60);
}

/** Nome do canal para exibir: tira marcas técnicas, mantém o resto. */
function liveTitle(name) {
  let s = String(name || '').replace(NOISE_TAGS, ' ').replace(ANY_BRACKET, ' ');
  s = s.replace(/\((?:op[cç][aã]o|opt(?:ion)?)\s*\d+\)/gi, ' ').replace(/\bop[cç][aã]o\s*\d+\b/gi, ' ');
  s = s.replace(/\s{2,}/g, ' ').replace(/[\s\-–]+$/, '').trim();
  return s || String(name || '').trim();
}

/**
 * Lê uma lista e devolve itens enxutos já classificados:
 * { k, key, n, lg, g, u, s, l, r, ua, ep? }
 */
async function buildEntries(text, sourceId, maxItems) {
  const entries = [];
  const limit = maxItems || 600000;
  const stats = await parseM3U(text, function (e) {
    if (entries.length >= limit) return;
    const c = classify(e);
    const out = { k: c.k, u: e.u, s: sourceId, lg: e.lg, l: altLabel(e.n) };
    if (e.r) out.r = e.r;
    if (e.ua) out.ua = e.ua;
    if (c.k === 'l') {
      out.n = liveTitle(e.n);
      out.key = liveKey(e.n);
    } else if (c.k === 's') {
      out.n = c.ep.title;
      out.key = searchText(c.ep.title).replace(/ /g, '');
      out.ep = { s: c.ep.s, e: c.ep.e };
    } else {
      out.n = cleanTitle(e.n);
      out.key = movieKey(e.n);
    }
    if (!out.key) return;
    out.g = normGroup(e.g, c.k);
    entries.push(out);
  });
  stats.kept = entries.length;
  return { entries: entries, stats: stats };
}

module.exports = {
  buildEntries, normGroup, parseM3U, classify, parseEpisode, searchText, liveKey, movieKey,
  cleanTitle, altLabel, stripAccents,
};
