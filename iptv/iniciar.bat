@echo off
chcp 65001 >nul
title Porta IPTV
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo O Node.js nao esta instalado. Baixe em https://nodejs.org ^(versao LTS^), instale e abra este arquivo de novo.
  pause
  exit /b 1
)

if not exist "data\auth.json" if not exist ".env" (
  echo.
  echo === Primeira vez: crie o seu login ===
  node set-login.js
  if errorlevel 1 ( pause & exit /b 1 )
)

set TRUST_PROXY=1
echo.
echo Ligando o servidor numa janela separada...
start "Servidor IPTV (nao feche)" cmd /k node server.js

set CF=
where cloudflared >nul 2>nul && set CF=cloudflared
if "%CF%"=="" if exist "%~dp0cloudflared.exe" set CF="%~dp0cloudflared.exe"

if "%CF%"=="" (
  echo.
  echo Servidor ligado para a sua rede Wi-Fi: veja o endereco na outra janela.
  echo.
  echo Para acessar de QUALQUER lugar, instale o cloudflared UMA vez:
  echo     winget install --id Cloudflare.cloudflared
  echo Depois feche tudo e abra este arquivo de novo.
  echo.
  pause
  exit /b 0
)

echo.
echo ================================================================
echo  Aguarde alguns segundos: abaixo vai aparecer um endereco
echo  https://alguma-coisa.trycloudflare.com  - e ele que voce abre
echo  no celular ou na TV de qualquer lugar. Nao feche esta janela.
echo ================================================================
echo.
timeout /t 3 >nul
%CF% tunnel --url http://localhost:8787
pause
