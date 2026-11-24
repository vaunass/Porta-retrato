'use strict';
const test = require('node:test');
const assert = require('node:assert');
const m = require('../lib/m3u');
const { rewriteManifest, sniff } = require('../lib/proxy');
const { Library } = require('../lib/library');
const { extractPlaylistLinks, toRaw, walkJson } = require('../lib/sources');

test('junta o mesmo canal com qualidades diferentes', () => {
  assert.strictEqual(m.liveKey('Globo SP HD [Geo-blocked]'), m.liveKey('Globo SP FHD (Opção 2)'));
  assert.notStrictEqual(m.liveKey('Band (SP)'), m.liveKey('Band (RS)'));
});

test('detecta episódios e filmes', () => {
  assert.deepStrictEqual(m.parseEpisode('Channel Zero S01E02'), { title: 'Channel Zero', s: 1, e: 2 });
  assert.strictEqual(m.parseEpisode('Filme Qualquer 2020'), null);
  assert.strictEqual(m.movieKey('Aftermath (2024) (Dublado - Opção 1)'), m.movieKey('Aftermath (2024) (Legendado - Opção 2)'));
});

test('lê M3U com opções VLC e sufixo estilo Kodi', async () => {
  const txt = '#EXTM3U\n#EXTINF:-1 tvg-logo="x" group-title="News;General",Band HD\n#EXTVLCOPT:http-referrer=http://a/\nhttp://h/live.m3u8|User-Agent=VLC\n' +
    '#EXTINF:-1,Série S02E03\nhttp://h/series/u/p/1.mp4\n#EXTINF:-1,Rádio\nrtmp://h/x\n';
  const r = await m.buildEntries(txt, 't');
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.stats.skipped, 1);
  assert.strictEqual(r.entries[0].k, 'l');
  assert.strictEqual(r.entries[0].r, 'http://a/');
  assert.strictEqual(r.entries[0].ua, 'VLC');
  assert.strictEqual(r.entries[0].g, 'News');
  assert.strictEqual(r.entries[1].k, 's');
});

test('proxy reescreve playlists HLS', () => {
  const out = rewriteManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:4,\nseg/1.ts', 'http://h/a/b.m3u8', {});
  assert.ok(out.includes('URI="/api/proxy?u=http%3A%2F%2Fh%2Fa%2Fk.key"'));
  assert.ok(out.includes('/api/proxy?u=http%3A%2F%2Fh%2Fa%2Fseg%2F1.ts'));
});

test('reconhece o tipo do stream pelos bytes', () => {
  assert.strictEqual(sniff('', Buffer.from('#EXTM3U\n')), 'hls');
  const ts = Buffer.alloc(400); ts[0] = 0x47; ts[188] = 0x47;
  assert.strictEqual(sniff('', ts), 'ts');
  assert.strictEqual(sniff('video/mp4', Buffer.alloc(10)), 'file');
});

test('biblioteca agrupa versões e busca', async () => {
  const lib = new Library();
  const e = (s, n, u, extra) => Object.assign({ k: 'm', key: m.movieKey(n), n: m.cleanTitle(n), lg: '', g: 'Ação', u, s, l: '' }, extra);
  await lib.rebuild([
    { id: 'a', entries: [e('a', 'Matrix (Dublado - Opção 1)', 'http://1'), e('a', 'Matrix (Dublado - Opção 2)', 'http://2')] },
    { id: 'b', entries: [e('b', 'Matrix (Legendado)', 'http://3'), { k: 's', key: 'lost', n: 'Lost', lg: '', g: 'Geral', u: 'http://4', s: 'b', l: '', ep: { s: 1, e: 1 } }, { k: 's', key: 'lost', n: 'Lost', lg: '', g: 'Geral', u: 'http://5', s: 'b', l: '', ep: { s: 1, e: 2 } }] },
  ]);
  const r = lib.query({ k: 'm', q: 'matrix' });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.items[0].c, 3);
  const s = lib.query({ k: 's' }).items[0];
  assert.strictEqual(lib.seriesDetail(s.id).seasons[0].eps.length, 2);
  assert.strictEqual(lib.neighbor(s.id, '1:1', 1), '1:2');
});

test('fontes: links de playlists e JSON de canais', () => {
  assert.deepStrictEqual(extractPlaylistLinks('veja https://github.com/o/r/blob/main/lists/a.m3u e https://x.com/b.m3u8?t=1'),
    ['https://raw.githubusercontent.com/o/r/main/lists/a.m3u', 'https://x.com/b.m3u8?t=1']);
  assert.strictEqual(toRaw('https://github.com/o/r/raw/refs/heads/main/x.m3u'), 'https://raw.githubusercontent.com/o/r/main/x.m3u');
  const out = []; walkJson({ data: { channels: [{ name: 'A', url: 'https://h/a.m3u8', logo: 'l' }, { title: 'sem url' }] } }, out, 0);
  assert.strictEqual(out.length, 1);
});

test('login: aceita só a senha certa, limita tentativas e valida a sessão', () => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  const { Auth, hashPassword } = require('../lib/auth');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-auth-'));
  const h = hashPassword('Senha-de-teste-1');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ user: 'Admin', salt: h.salt, hash: h.hash }));
  const a = new Auth(dir);
  assert.ok(a.enabled);
  assert.strictEqual(a.login('1.1.1.1', 'admin', 'errada').ok, false);
  const ok = a.login('2.2.2.2', 'ADMIN', 'Senha-de-teste-1');
  assert.ok(ok.ok);
  assert.ok(a.check({ headers: { cookie: 'x=1; iptv_s=' + ok.token } }));
  assert.ok(!a.check({ headers: { cookie: 'iptv_s=falso' } }));
  for (let i = 0; i < 5; i++) a.login('3.3.3.3', 'admin', 'x');
  assert.ok(a.login('3.3.3.3', 'admin', 'Senha-de-teste-1').locked);
});
