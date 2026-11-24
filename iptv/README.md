# Porta IPTV

TV ao vivo, filmes e séries no **celular** e na **TV LG**, tudo pelo Wi-Fi de casa.
Um servidor leve (Node.js, sem dependências) baixa as listas M3U, junta tudo numa biblioteca única e serve o app. O celular e a TV só abrem o endereço no navegador.

## Como usar

Precisa do [Node.js](https://nodejs.org) 18 ou mais novo, num computador que fique ligado (PC, notebook, mini PC, Raspberry Pi):

```bash
cd iptv
node server.js
```

O terminal mostra o endereço, algo como `http://192.168.0.10:8787`.

- **Celular:** abra o endereço no navegador. Para ter um ícone na tela inicial, use "Adicionar à tela inicial".
- **TV LG:** abra o endereço no navegador da TV (app *Web Browser*) e salve nos favoritos. Ela entra sozinha no **Modo TV** e passa a tocar o que você mandar pelo celular. Também dá para navegar direto na TV com as setas e o OK do controle.
- **Celular como controle remoto:** aba **TVs** → *Usar esta TV*. Depois é só tocar num canal, filme ou episódio e ele toca na TV. Na mesma aba há anterior/próximo, pausa, volume e parar.

Na primeira vez as listas grandes (algumas passam de 30 MB) levam um ou dois minutos para baixar. Depois ficam em cache em `iptv/data/` e atualizam sozinhas a cada 12 h.

## O que tem

- **Ao vivo, Filmes e Séries** em abas, com categorias, busca e favoritos (os favoritos valem para todos os aparelhos).
- **Séries** organizadas por temporada e episódio, com "próximo episódio" automático.
- **Versões alternativas:** o mesmo canal/filme em várias listas vira um item só; se um link cair, o player troca sozinho para o próximo. Dá para trocar à mão pelo botão de camadas.
- **Proxy de streams:** o servidor repassa o vídeo, o que evita bloqueio de CORS, lida com links que exigem `Referer`/`User-Agent` e reescreve playlists HLS. Pode ser desligado em *Fontes → Ajustes*.
- **Motores de vídeo:** HLS (hls.js ou nativo), MPEG-TS ao vivo (mpegts.js) e MP4/MKV direto. O tipo é detectado automaticamente.
- **Controle remoto da TV:** setas, OK, voltar (461), CH+/CH−, play/pause/stop/avançar/voltar, vermelho = favoritar, verde = próxima versão. No player, ▲/▼ trocam de canal.
- **Fontes:** adicione listas por link, repositório ou usuário do GitHub, site ou texto colado; ative/desative cada uma.

## Fontes incluídas

| Fonte | Como é lida |
|---|---|
| Free-TV/IPTV | listas Brasil e Portugal |
| iptv-org/iptv | `streams/br.m3u` e `streams/pt.m3u` (para outros países, adicione `streams/XX.m3u` em *Fontes*) |
| iptv-com/iptv | `lists/brazil.m3u` + descoberta |
| xKzin/IPTV-Brazuka | Canais TV e Filmes e Séries |
| stream-net-lab/canais-m3u | `canais.m3u` e `filmes.m3u` |
| notfakelucas, Ramys (Iptv-Brasil-2026), SaimoTV/saimo-downloads | descoberta de arquivos `.m3u` pela API do GitHub |
| Llorchico | todos os repositórios do usuário (até 12) |
| canais-saimo / filmes-saimo / autom3u.com / doubo.tv | raspagem da página: procura links `.m3u/.m3u8` e JSON com streams |

**Limites que vale conhecer:**

- A descoberta no GitHub usa a API pública (60 consultas/hora sem login). Se bater no limite, defina `GITHUB_TOKEN` antes de iniciar: `GITHUB_TOKEN=ghp_... node server.js`.
- Os sites (Saimo, autom3u, doubo) são aplicativos web sem formato público documentado. A raspagem é de melhor esforço: se o site não expõe uma lista, a fonte aparece em *Fontes* com o erro. Nesse caso cole o link direto da lista (ou o texto M3U) em *Adicionar fonte*.
- O repositório SaimoTV/saimo-downloads só hospeda instaladores; provavelmente não terá lista.
- Este projeto **não hospeda nem cria streams**: só lê as listas que você configurar. A disponibilidade e a licença do conteúdo de listas de terceiros são responsabilidade de cada fonte e de quem usa. Algumas dessas listas apontam para servidores que podem sair do ar a qualquer momento.

## Configuração

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `8787` | porta do servidor |
| `DATA_DIR` | `iptv/data` | cache das listas, favoritos e fontes |
| `GITHUB_TOKEN` | — | aumenta o limite da API do GitHub |

## Segurança

Não há senha: qualquer aparelho na sua rede pode usar e alterar favoritos e fontes. Use só na rede de casa e **não exponha a porta na internet**. O proxy bloqueia endereços locais (`localhost`, `127.x`, `169.254.x`).

## Compatibilidade com TVs

O app evita recursos novos de JavaScript/CSS para rodar em webOS 4 (2018) ou mais novo. Se o vídeo não abrir numa TV mais antiga, teste *Fontes → Ajustes → Passar pelo servidor* ligado e o botão **Link direto** na mensagem de erro do player.

## Desenvolvimento

```bash
npm test
```

Bibliotecas incluídas em `public/vendor/`: [hls.js](https://github.com/video-dev/hls.js) e [mpegts.js](https://github.com/xqq/mpegts.js) (Apache-2.0).
