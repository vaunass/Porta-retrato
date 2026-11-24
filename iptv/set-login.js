#!/usr/bin/env node
'use strict';
/* Define o login deste servidor guardando só o hash:  node set-login.js usuario 'senha' */
const fs = require('fs');
const path = require('path');
const { hashPassword } = require('./lib/auth');

const user = process.argv[2];
const pass = process.argv[3];
if (!user || !pass || pass.length < 8) {
  console.error("Uso: node set-login.js USUARIO 'SENHA'   (senha com 8+ caracteres)");
  process.exit(1);
}
const dir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(dir, { recursive: true });
const h = hashPassword(pass);
fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ user: user, salt: h.salt, hash: h.hash }), { mode: 0o600 });
try { fs.unlinkSync(path.join(dir, 'sessions.json')); } catch (e) { /* ok */ }
console.log('Login salvo em ' + path.join(dir, 'auth.json') + '. Reinicie o servidor.');
