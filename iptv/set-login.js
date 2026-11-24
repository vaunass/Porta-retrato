#!/usr/bin/env node
'use strict';
/*
 * Define o login deste servidor guardando só o hash.
 *   node set-login.js              (pergunta usuário e senha)
 *   node set-login.js usuario 'senha'
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { hashPassword } = require('./lib/auth');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let muted = false;
const writeOut = rl._writeToOutput;
rl._writeToOutput = function (str) { if (!muted || /[\r\n]/.test(str)) writeOut.call(rl, str); };
rl.setPrompt('');
const lines = [];
let waiter = null;
rl.on('line', function (l) { if (waiter) { const w = waiter; waiter = null; muted = false; w(l); } else lines.push(l); });
function ask(q, hidden) {
  process.stdout.write(q);
  muted = !!hidden;
  if (lines.length) { muted = false; return Promise.resolve(lines.shift()); }
  return new Promise(function (resolve) { waiter = resolve; });
}

(async function () {
  let user = process.argv[2];
  let pass = process.argv[3];
  if (!user || !pass) {
    user = (await ask('Usuário: ')).trim();
    pass = await ask('Senha (mínimo 8 caracteres): ', true);
  }
  if (!user || !pass || pass.length < 8) {
    console.error('\nUsuário vazio ou senha com menos de 8 caracteres. Nada foi salvo.');
    rl.close();
    process.exit(1);
  }
  rl.close();
  const dir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  fs.mkdirSync(dir, { recursive: true });
  const h = hashPassword(pass);
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ user: user, salt: h.salt, hash: h.hash }), { mode: 0o600 });
  try { fs.unlinkSync(path.join(dir, 'sessions.json')); } catch (e) { /* ok */ }
  console.log('\nLogin salvo (usuário: ' + user + ').');
})();
