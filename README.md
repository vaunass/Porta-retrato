# Porta-Retrato

Porta-retrato digital que roda no navegador do tablet, da TV, do celular ou do computador.
Você envia suas fotos, escolhe o tempo de cada uma, coloca música e deixa passando.

## O que ele faz

- **Fotos**: envie várias de uma vez, uma pasta inteira (no computador) ou arraste para a página. Elas são reduzidas automaticamente para carregar rápido em qualquer tela.
- **Pasta do Google Drive**: ligue uma pasta do Drive e as fotos dela entram sozinhas na apresentação — é só colocar ou tirar fotos da pasta.
- **Tempo de cada foto**: de 1 segundo a várias horas, com atalhos (5 s, 10 s, 30 s, 1 min, 5 min, 1 h).
- **Troca manual**: toque nas laterais da tela, deslize o dedo ou use as setas do teclado / controle remoto.
- **Música**: envie seus arquivos de áudio, procure **rádios on-line** por nome ou estilo, ou cole o link de um áudio; toca em sequência ou em ordem aleatória, com volume ajustável.
- **Visual**: transições (esmaecer, deslizar, zoom, sorteada), movimento suave nas fotos, fundo desfocado, foto inteira ou preenchendo a tela, ordem aleatória / por data / por nome.
- **Relógio e legenda**: hora, data e nome/data da foto, se quiser.
- **Brilho e modo noturno**: escurece ou apaga a tela (e pausa a música) no horário que você definir.
- **Controle remoto** (com o servidor): troque de foto, pause e mude os ajustes pelo celular enquanto a TV exibe.

## Como usar

Há duas formas. O app descobre sozinho em qual delas está.

### 1. Com o servidor — recomendado para a TV

Um computador da casa guarda as fotos e todos os aparelhos da mesma rede Wi-Fi enxergam a mesma biblioteca.
É o jeito mais prático para a TV: você envia as fotos pelo celular e a TV só exibe.

Precisa do [Node.js](https://nodejs.org) 16 ou mais novo (não há mais nada para instalar):

```bash
node server.js
```

O terminal mostra o endereço, algo como `http://192.168.0.10:8080`. Abra esse endereço no navegador da TV, do tablet e do celular.

- As fotos e músicas ficam na pasta `data/`. Para fazer backup, copie essa pasta.
- Para mudar a porta ou a pasta: `PORT=3000 DATA_DIR=/caminho/das/fotos node server.js`.
- Não há senha: qualquer pessoa na sua rede Wi-Fi pode ver e alterar as fotos. Use apenas na rede de casa e não exponha a porta na internet.

### 2. Sem servidor — só um aparelho

Abra o `index.html` por qualquer hospedagem de arquivos estáticos (por exemplo o GitHub Pages deste repositório: *Settings → Pages → Deploy from a branch*).
As fotos ficam guardadas **naquele aparelho**, dentro do navegador — nada é enviado para a internet.

Bom para um tablet que vira porta-retrato. Em Android/iPad dá para "Adicionar à tela inicial" e ele abre em tela cheia, funcionando até sem internet.
Atenção: se você limpar os dados do navegador, as fotos guardadas ali são apagadas.

## Fotos de uma pasta do Google Drive

Na aba **Fotos**, toque em **Google Drive**, cole o link da pasta e uma chave de API do Google.

1. No Drive, compartilhe a pasta como **"Qualquer pessoa com o link"** (leitor) e copie o link.
2. Crie a chave (gratuita, uma vez só):
   - entre em [console.cloud.google.com](https://console.cloud.google.com) e crie um projeto;
   - em *APIs e serviços → Biblioteca*, ative a **Google Drive API**;
   - em *APIs e serviços → Credenciais*, escolha *Criar credenciais → Chave de API*.
3. Cole o link e a chave no app e toque em **Conectar**.

Como funciona:

- As fotos **não são copiadas**: o app lê a lista da pasta e mostra direto do Drive, então precisa de internet. A lista é atualizada sozinha a cada 20 minutos (ou no botão *Atualizar agora*).
- Só as fotos que estão diretamente na pasta entram; subpastas são ignoradas.
- Para tirar uma foto da apresentação, tire-a da pasta no Drive. As fotos do Drive aparecem com uma nuvem na grade.
- Quem tiver o link da pasta consegue ver as fotos — não use para fotos que você não mostraria a ninguém.
- Ao criar a chave, restrinja-a à *Google Drive API*, mas **não** use a restrição por "referenciador HTTP" (o app não envia esse dado).

Sem chave também dá: no celular ou tablet, o botão **Adicionar fotos** abre o seletor do aparelho, que já deixa escolher fotos do Google Drive, Google Fotos ou iCloud. Nesse caso as fotos são copiadas para o app.

## Música on-line

Na aba **Músicas**, em *Música on-line*:

- **Rádios**: busque por nome ou estilo (MPB, jazz, lo-fi…) e toque em **+**. A busca usa o [Radio Browser](https://www.radio-browser.info), um diretório aberto e gratuito de rádios da internet; não precisa de conta.
- **Link direto**: cole o endereço de um arquivo de áudio (`.mp3`, `.ogg`…) ou de uma transmissão.

YouTube, Spotify e Deezer não funcionam: esses serviços só tocam dentro dos próprios aplicativos.
Uma rádio toca sem parar; para trocar, use o botão de próxima música nos controles.

## Durante a apresentação

| Ação | Toque | Teclado / controle remoto |
| --- | --- | --- |
| Próxima / anterior | lateral direita / esquerda, ou deslizar | `→` / `←` |
| Mostrar os controles | centro da tela | `OK` / `Enter` |
| Pausar / continuar | botão nos controles | `Espaço` |
| Música liga / desliga | botão nos controles | `M` |
| Tela cheia | botão nos controles | `F` |
| Sair | botão ✕ | `Esc` / `Voltar` |

## Dicas

- **Começar sozinho**: em *Ajustes → Neste aparelho*, ligue "Começar a apresentação ao abrir o app", ou abra o endereço com `?play=1` no final.
- **Música**: os navegadores só deixam o som começar depois de um toque na tela. Se a apresentação começou sozinha, toque uma vez e ligue a música nos controles.
- **Tela sempre ligada**: o app pede ao aparelho para não apagar a tela, mas isso só funciona em endereços `https://` ou `localhost`. Usando o servidor pela rede (`http://192.168…`), desative o descanso de tela nas configurações do tablet ou da TV.
- **Fotos do iPhone (HEIC)**: envie pelo próprio iPhone/iPad, que converte sozinho. Em outros navegadores esse formato pode não abrir.

## Estrutura

```
index.html, css/, js/   o app (HTML, CSS e JavaScript puros, sem etapa de build)
sw.js, manifest…        instalação na tela inicial e uso sem internet
server.js               servidor opcional, sem dependências
data/                   criada pelo servidor: fotos, miniaturas, músicas e ajustes
```
