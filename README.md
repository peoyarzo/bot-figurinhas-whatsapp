# Zapfig

Bot de figurinhas para WhatsApp. Recebe imagem, GIF ou vídeo curto e devolve uma figurinha. Se o vídeo tiver áudio, a figurinha pode sair com som. Os planos são pagos com Pix do Mercado Pago, em sandbox. A sessão do WhatsApp fica no Turso, porque o disco do Render some. Este repositório é um protótipo: os testes e o `npm run demo` rodam com mocks e **não conectam número nenhum**.

O código foi escrito do zero. A referência conceitual (um bot de figurinhas conhecido) não tem licença, então nada dela foi copiado.

## O chip

O bot precisa de um **número novo**, comprado para isso. Não pareie o seu WhatsApp pessoal.

O (11) 97688-2096, `5511976882096`, pode ser admin: isso só entra em `ADMIN_NUMBERS` no deploy, nunca neste repositório. O processo recusa iniciar se esse número for o chip pareado (`PAIRING_NUMBER` ou a sessão salva).

## Por que Baileys 6.7.24

O pacote está fixado em `@whiskeysockets/baileys@6.7.24`.

A linha 6.7 é a estável. Ela já tem `makeWASocket`, o par `creds` + `keys` do auth state, `requestPairingCode` e o `DisconnectReason.loggedOut` (401) com o mesmo contrato há bastante tempo. A 7.0 ainda é release candidate (`7.0.0-rc.x`) e muda o protocolo entre RCs. Num serviço grátis que dorme e reconecta, uma RC aumenta a chance de a sessão cair a cada atualização. Por isso o pin é o último 6.7, não a 7.

A figurinha com som não muda esse pin. O campo novo (`Message` 134) também não existe na `7.0.0-rc14`: o relato [WhiskeySockets/Baileys#2932](https://github.com/WhiskeySockets/Baileys/issues/2932) foi aberto nessa RC. Subir para a 7 não traz o proto e ainda troca o protocolo entre RCs. O envio com som fica num patch local de `proto.Message.encode`, só quando há áudio registrado para aquele webp. Sem esse registro, o encode original segue igual. Não usei `patch-package`: um patch em `node_modules` quebra no próximo `npm ci` de um Baileys patch, e o contorno é pequeno o bastante para ficar no código e nos testes.

## Arquitetura

```text
WhatsApp (Baileys 6.7)           HTTP (Fastify)
  QR / código de pareamento        GET /health
  só responde quem chamou          GET /qr?token=
  ignora grupo                     POST /webhooks/mercadopago
        |                          POST /session/reset
        v
  fila (1–2 por vez, jitter, "digitando")
        |
        v
  sharp (imagem → webp 512)  ou  ffmpeg (GIF/vídeo → webp animado + opus, se houver áudio)
        |
        v
  Turso / libSQL  —  creds, chaves, saldo, planos, pagamentos
```

- **Sessão.** `src/whatsapp/auth-state.ts` implementa o auth state do Baileys em cima do `@libsql/client`. Credenciais viram um JSON; cada `keys.set` (a lib já agrupa as mutações) vira **um** `batch` no banco. Na reconexão o processo lê de novo e reaproveita a mesma sessão. Localmente a URL é `file:local.db`. No Render, `libsql://…turso.io`. O código é o mesmo.
- **Conexão.** `src/whatsapp/connection.ts` tira os listeners e chama `end()` no socket antigo **antes** de abrir outro. O intervalo dobra (1s, 2s, 4s…) até 30s. `loggedOut` para, não abre outro socket e deixa no log a frase `Sessão do WhatsApp encerrada (loggedOut)`. `markOnlineOnConnect` sai do config e o padrão é `false`.
- **Pareamento sem terminal.** `GET /qr?token=SEU_ADMIN_TOKEN` mostra o QR e, se `PAIRING_NUMBER` estiver definido, o código do `requestPairingCode`. O header `x-admin-token` também serve. `POST /session/reset?token=` apaga credenciais e chaves e pede outro QR — use depois de um `loggedOut`.
- **HTTP.** `GET /health` responde 200 enquanto o banco responde, mesmo com o WhatsApp reconectando (é o que o UptimeRobot precisa). O webhook valida `x-signature` (HMAC-SHA256 do manifesto `id:…;request-id:…;ts:…;`, com `data.id` em minúsculas e tolerância de 10 minutos). A liberação é idempotente pelo id do pagamento (`payment_grants`). Se o processamento falha, a rota devolve 500 para o Mercado Pago tentar de novo. Não há conversão de figurinha nesse caminho.
- **Pagamento.** Pix via `POST /v1/payments` com o token de teste. O copia-e-cola vai para quem pediu. O plano só entra quando a consulta do pagamento volta `approved`. Se o webhook não chegar, a próxima mensagem da pessoa (e o `/status`, sempre) consulta de novo.
- **Modo mock.** `MOCK_WHATSAPP=1` não abre socket. `MOCK_MP=1` não chama o Mercado Pago. `POST /mock/inbound` e `POST /mock/payments/:id/approve` existem só nesses modos, protegidos pelo mesmo token.

## Custo

Nada aqui pede cartão: Render free, Turso starter, UptimeRobot free e credenciais de **teste** do Mercado Pago. Se algum cadastro exigir cartão, pare. Não assine plano pago para este bot.

## Rodar aqui

Node 20 ou mais novo.

```bash
cp .env.example .env
npm install
npm test
npm run demo
npm run dev
```

O `.env.example` já liga os dois mocks. `npm run demo` simula, sem WhatsApp e sem cobrança:

1. `/menu` e `/planos`
2. `/comprar 15` devolve um Pix falso
3. o pagamento é aprovado como o sandbox faria com o pagador de teste **APRO**
4. o webhook assinado libera o pacote; o segundo webhook **não** soma de novo
5. uma imagem pergunta como encaixar. O saldo continua 15. A resposta `1` vira figurinha webp 512×512 e o saldo vai para 14. O pacote de 15 fica com validade de 30 dias; não há figurinha grátis
6. `/status` manda o cartão e `/vendas` mostra R$ 3,50

Na demo o atraso aleatório da fila fica em zero para ela terminar na hora. Em produção o intervalo está em `safety.jitterMinMs` / `jitterMaxMs`.

Com o servidor no ar (`npm run dev`, porta 8787 se `PORT` não vier do ambiente):

- [saúde](http://127.0.0.1:8787/health)
- [QR](http://127.0.0.1:8787/qr?token=o-valor-de-ADMIN_TOKEN) — em mock, a página explica que não há sessão

Para simular uma mensagem:

```bash
curl -s -X POST http://127.0.0.1:8787/mock/inbound \
  -H 'content-type: application/json' \
  -H 'x-admin-token: o-valor-de-ADMIN_TOKEN' \
  -d '{"phone":"5511900000001","text":"/menu","pushName":"Lia"}'
```

`5511900000001` é exemplo fictício.

## Contas grátis, nesta ordem

### 1. Turso

1. Crie a conta em [turso.tech](https://turso.tech) (login com GitHub). Fique no plano starter. Se pedirem cartão, pare.
2. Instale a CLI deles ou use o painel.
3. `turso db create figurinhas`
4. `turso db show figurinhas --url` → `LIBSQL_URL` (começa com `libsql://`)
5. `turso db tokens create figurinhas` → `LIBSQL_AUTH_TOKEN`

Não use o Postgres free do Render para isso: ele expira. O arquivo local também não serve no Render, porque o disco é apagado em todo restart e a sessão do WhatsApp iria junto.

### 2. Mercado Pago, só teste

1. Entre em [Mercado Pago Developers](https://www.mercadopago.com.br/developers/panel/app) e crie uma aplicação.
2. Em credenciais de **teste**, copie o Access Token. Ele começa com `TEST-`. Esse valor é o `MP_ACCESS_TOKEN`. Não use o token de produção: este projeto não move dinheiro real.
3. Crie um usuário de teste no mesmo painel e coloque o e-mail dele em `MP_PAYER_EMAIL`. Não use o seu e-mail.
4. Deixe `MP_PAYER_FIRST_NAME=APRO`. No sandbox, o pagador de teste com nome **APRO** é o caminho documentado para o status `approved` (é o gatilho clássico dos cartões de teste). Pix de teste muitas vezes continua `pending` até você simular o pagamento ou a notificação no painel. O bot não libera no escuro: ele consulta `GET /v1/payments/:id` e só credita com `approved`.
5. Em Webhooks, a URL de produção de teste será `https://SEU-APP.onrender.com/webhooks/mercadopago`, evento de **pagamentos**. Revele a chave secreta e guarde em `MP_WEBHOOK_SECRET`.
6. `PUBLIC_BASE_URL` é essa mesma origem, sem barra no fim. O bot manda esse endereço como `notification_url` ao criar o Pix.

Para repetir o fluxo sem a API, use `MOCK_MP=1` e `POST /mock/payments/:id/approve` antes do webhook. É o que a demo faz no lugar do APRO.

### 3. Render, web service free

A documentação atual do Render diz que o web service Free não pede cartão, dá 750 horas por mês por workspace e **dorme depois de 15 minutos sem HTTP**. Confirme na hora do cadastro. Se pedirem cartão, pare.

1. Conta em [render.com](https://render.com).
2. New → Web Service, apontando para este repositório.
3. Runtime Node. O `render.yaml` já descreve o serviço: plano `free`, build `npm ci && npm run build`, start `npm start`, health check `/health`.
4. Environment: `NODE_VERSION=20`. Copie as variáveis do `.env.example` com os valores reais. Em produção: `MOCK_WHATSAPP=0` e `MOCK_MP=0`.
5. `ADMIN_TOKEN`: uma string longa e aleatória. Quem tem esse token vê o QR.
6. `ADMIN_NUMBERS`: só no painel do Render, dígitos com DDI, separados por vírgula. Não commite esse número. O chip do bot é outro número, novo.
7. `PAIRING_NUMBER`: o **chip novo** do bot, só dígitos com DDI, sem `+`.

O plano free reinicia quando quer e não tem disco persistente. Por isso a sessão está no Turso. Um restart derruba o socket; o processo sobe, lê as credenciais e reconecta sozinho, desde que não tenha sido `loggedOut`.

### 4. UptimeRobot

O free dorme aos 15 minutos sem request. O ping em `/health` a cada 5 minutos segura o processo acordado (enquanto sobrar hora do mês).

1. Conta em [uptimerobot.com](https://uptimerobot.com). O plano free chega para um monitor de 5 minutos.
2. Monitor HTTP(s) em `https://SEU-APP.onrender.com/health`.
3. Intervalo de 5 minutos. Alerta se deixar de responder 200.

Isso não impede o restart do próprio Render. Só evita o sono por inatividade. 750 horas cobrem um serviço o mês inteiro; se passar, o Render suspende até o mês seguinte. Não adicione cartão para “estourar” a cota.

### 5. Parear o chip

1. Com o serviço no ar e `MOCK_WHATSAPP=0`, abra `https://SEU-APP.onrender.com/qr?token=SEU_ADMIN_TOKEN`.
2. A página avisa para usar um chip novo. Escaneie o QR no WhatsApp desse chip (Aparelhos conectados → Conectar aparelho) **ou** digite o código de pareamento (Conectar com número de telefone). O código sai do `requestPairingCode` usando `PAIRING_NUMBER`.
3. Quando conectar, a página diz que a sessão está aberta. As credenciais já estão no Turso.
4. Se o log mostrar `loggedOut`, a sessão foi encerrada de propósito (alguém desconectou o aparelho, ou o WhatsApp invalidou). O bot **para**. Use o botão da página, ou `POST /session/reset?token=…`, e pareie de novo. Não espere reconexão automática nesse caso.

Não há terminal no Render. Não dependa de `printQRInTerminal`.

### 6. Webhook

Com `PUBLIC_BASE_URL` e o segredo configurados, crie um Pix de teste pelo `/comprar 15` a partir do chip de um cliente (não do número proibido). Pague no sandbox ou dispare a notificação de teste no painel. O bot consulta o pagamento e, se `approved`, manda a confirmação para quem já tinha chamado. Um segundo aviso do mesmo id não soma o saldo de novo.

## Variáveis

Estão todas no `.env.example`.

| Variável | Função |
| --- | --- |
| `PORT` / `HOST` | HTTP. O Render preenche `PORT`. Local: 8787. |
| `ADMIN_TOKEN` | Protege `/qr`, o reset e as rotas mock. |
| `ADMIN_NUMBERS` | Quem tem saldo ilimitado e os comandos de admin. Dígitos com DDI, separados por vírgula. |
| `MOCK_WHATSAPP` | `1` não conecta. `0` no Render. |
| `MOCK_MP` | `1` não chama o Mercado Pago. `0` no Render. |
| `LIBSQL_URL` / `LIBSQL_AUTH_TOKEN` | `file:local.db` ou Turso. |
| `MP_ACCESS_TOKEN` | Token de teste (`TEST-…`). |
| `MP_WEBHOOK_SECRET` | Assinatura `x-signature`. Sem ela o webhook responde 503. |
| `MP_PAYER_EMAIL` / `MP_PAYER_FIRST_NAME` | Usuário de teste. O nome padrão é `APRO`. |
| `PUBLIC_BASE_URL` | Origem pública, sem barra final. |
| `PAIRING_NUMBER` | Chip novo, só dígitos. |
| `FFMPEG_PATH` | Opcional. Se vazio, o bot procura `bin/ffmpeg`, o binário do `ffmpeg-static` e o `ffmpeg` do sistema, e fica com o primeiro que tenha `libwebp`. |
| `SOUND_STICKERS` | Padrão ligado. `0`, `false` ou `off` desliga a figurinha com som no servidor. |
| `BAILEYS_LOG_LEVEL` | Padrão `silent`. |

## Planos e texto

Preço, validade, limites e o EXIF da figurinha ficam em `src/config.ts`. O pacote da figurinha se chama Zapfig. As frases ficam em `src/bot/texts.ts`.

| Id | O que é | Preço no config |
| --- | --- | --- |
| `pack15` | 15 figurinhas, vencem 30 dias depois da compra | R$ 3,50 |
| `pack25` | 25 figurinhas, não vencem | R$ 5,50 |
| `weekly` | 7 dias sem limite | R$ 7,90 |
| `days30` | 30 dias sem limite | R$ 14,90 |
| `months3` | 90 dias sem limite | R$ 19,90 |

Não há teste grátis. Quem não é admin nem VIP e está sem saldo recebe a lista de `/planos` no lugar da figurinha. Admin (`ADMIN_NUMBERS`) e a lista `/vip` continuam com figurinhas ilimitadas, sem descontar saldo.

Cada compra de créditos vira um lote com `expires_at`. No pacote de 15, `creditsExpireDays` é 30: o que não foi usado some 30 dias depois da compra. No de 25, `creditsExpireDays` é nulo e o lote não vence. Se a pessoa tem os dois, o bot gasta primeiro o lote que vence antes. `/status` mostra o saldo e a validade de cada lote.

No boot, plano que ninguém editou pelo chat é atualizado a partir do config. Plano com `edited` (via `/planos set`) fica como o admin deixou. `/planos reset <id>` volta ao config.

Plano ilimitado vale até `plan_expires_at` e, se comprar de novo antes de vencer, os dias somam a partir do vencimento, não de hoje.

## Comandos

Quem usa o bot:

- `/menu` — o que o bot faz
- `/planos` — preços
- `/comprar 15`, `/comprar 25`, `/comprar semanal`, `/comprar 30`, `/comprar trimestral`
- `/status` ou `/saldo` — cartão (nome, plano, saldo ou validade, figurinhas usadas)
- `/som on` — padrão. Vídeo ou GIF com áudio vira figurinha com som
- `/som off` — a figurinha sai muda. A escolha fica no usuário
- `/formato perguntar` — padrão. O bot pergunta como encaixar
- `/formato recortar` — corta no quadrado, sem distorcer, sem perguntar
- `/formato esticar` — estica até ocupar o quadrado, sem perguntar
- `/ajuda` — o mesmo que `/menu`

Admin (o número tem que estar em `ADMIN_NUMBERS`):

- `/vendas` — pedidos aprovados de hoje, da semana (desde segunda) e do mês, no horário de Brasília
- `/liberar <numero> <plano>` — credita sem Pix. Se a pessoa nunca chamou, o bot **não** manda mensagem para ela
- `/vip` lista; `/vip <numero>` e `/unvip <numero>`
- `/pausar` e `/retomar` — a pausa fica no banco, então um restart não liga o bot sozinho
- `/planos set <id> preco|creditos|dias|nome|ativo|placeholder …`
- `/planos reset <id>`

Número de admin, de VIP e de `/liberar`: só dígitos, com DDI, do jeito que o WhatsApp mostra no JID.

## Contra ban

Tudo isso é configurável em `safety` e não existe um caminho de broadcast no código.

- Só responde a quem mandou mensagem primeiro. O `GuardedMessenger` recusa envio se `has_inbound` for falso. Não há lista de transmissão nem mensagem para contato que nunca chamou.
- Grupo é ignorado (`ignoreGroups: true`), sem resposta.
- No máximo 4 figurinhas por minuto por pessoa e 12 no total (`perUserPerMinute`, `globalPerMinute`). O limite global vale também para admin.
- Fila com no máximo 2 envios ao mesmo tempo, atraso aleatório entre 800 e 2200 ms e presença "digitando" antes da figurinha.
- Aquecimento: 30, 60 e 120 figurinhas nos três primeiros dias, depois 400. A data de nascimento do bot fica em `settings`, então um restart do Render não volta para o dia 1.
- `markOnlineOnConnect: false`.
- `/pausar` cala as respostas. O recibo de um Pix que acabou de aprovar ainda sai, porque a pessoa já estava nessa conversa esperando o pagamento.
- Admin não gasta saldo, fura o limite por usuário e o aquecimento. VIP não gasta saldo, mas entra no limite e no aquecimento: a figurinha sai do mesmo chip.

Nada disso torna o cliente oficial. Continua sendo WhatsApp Web não oficial. Veja os riscos abaixo.

## Figurinha e ffmpeg

- Imagem: `sharp`, 512×512, webp. Tenta qualidades até caber em ~100 KB. Se não cabe, recusa.
- GIF e vídeo: `ffmpeg`, corta em 6 segundos, 512×512, webp animado, até ~500 KB, com quedas de qualidade e de fps. Se não cabe, recusa.
- Encaixe: o padrão é perguntar. `1` ou `recortar` corta no centro (`cover` no sharp, `scale` + `crop` no ffmpeg). `2` ou `esticar` estica (`fill`, `scale=512:512`). Nenhum dos dois coloca faixa. Se o encaixe antigo (`contain`) for usado, a sobra é `rgba(0,0,0,0)`, nunca branco. A mídia fica no banco por 5 minutos, uma por pessoa; mídia nova substitui a anterior. O crédito só sai quando a figurinha é gerada. Se os 5 minutos passam, o bot avisa e não gera.
- `/formato recortar` e `/formato esticar` guardam a escolha e pulam a pergunta. `/formato perguntar` volta a perguntar. `/ajuda` lista isso.
- O EXIF de pacote (`sticker-pack-name`, `sticker-pack-publisher`, id e emoji) sai de `config.sticker`. O pacote se chama Zapfig.

O `ffmpeg-static` usado aqui inclui `libwebp`, `libwebp_anim` e `libopus`, então o `npm install` no Render já traz o binário certo para o Linux do build. Se um dia esse binário não tiver o encoder, `npm run fetch-ffmpeg` baixa um ffmpeg estático público para `bin/ffmpeg` (sem conta e sem cartão) e o boot prefere esse arquivo. Dá para apontar `FFMPEG_PATH` para qualquer binário com `libwebp`.

## Figurinha com som

Quando o vídeo ou o GIF tem faixa de áudio, `SOUND_STICKERS` está ligado (padrão) e a pessoa não mandou `/som off`, o Zapfig gera o webp animado de sempre e um clipe Opus no mesmo tempo da figurinha. O áudio fica em no máximo 10 segundos e cerca de 1 MB. O ffmpeg usa `-vn -map 0:a:0 -c:a libopus`, mono, sem capa e sem Theora. O mimetype tem que ser exatamente `audio/ogg; codecs=opus` — `audio/ogg` sozinho desenha a figurinha e não toca.

Os dois arquivos sobem com `prepareWAMessageMedia`. A mensagem continua sendo um sticker (`mediatype="sticker"`). Na hora de codificar, o `stickerMessage` de topo sai e entra o campo 134 (um FutureProof) com o sticker e, dentro dele, o campo 24 em 0 e o áudio no campo 26. É o contorno do issue 2932, já testado pela comunidade em envio e recebimento. Vale uma figurinha, não duas. Se extrair ou enviar o som falhar, sai a figurinha muda.

O recurso está no beta do WhatsApp. Quem ainda não tem a versão pode receber a figurinha muda, sem mensagem de erro.

## Testes

```bash
npm test
npm run lint
npm run demo
```

Vitest cobre conversão (tamanho, transparência, recorte, estique, EXIF, recusa), a escolha de formato, a preferência, o prazo de 5 minutos, planos e saldo, comandos de admin, rate limit, fila, aquecimento, webhook idempotente, auth state no libSQL em arquivo e a demo de ponta a ponta. O auth state de teste usa `file:` no diretório temporário, o mesmo cliente do Turso.

## Limites e riscos

- **Render free dorme, reinicia e esquece o disco.** O ping de 5 minutos reduz o sono, não o restart. A sessão sobrevive porque está no Turso. Se as 750 horas acabarem, o serviço para até o mês seguinte.
- **Cold start** leva cerca de um minuto. Nesse intervalo o UptimeRobot pode marcar uma falha curta e o WhatsApp fica desconectado até o processo voltar e reler a sessão.
- **Ban.** Baileys não é o app oficial. O WhatsApp pode desconectar ou banir o chip mesmo com limite, jitter e sem broadcast. Use um número novo, não o seu. Não mande figurinha em massa. Se cair em `loggedOut`, pareie de novo e diminua `dailyLimitAfterWarmup` e os limites por minuto.
- **Som.** O campo 134 não está no proto oficial do Baileys. O patch só altera o encode quando o webp tem áudio registrado; o resto das mensagens usa o encoder original. Se o WhatsApp mudar o número do campo, o envio com som falha e o bot cai na figurinha muda. Um retry tardio, depois que o registro do áudio já foi apagado, também sai mudo. Clientes fora do beta recebem a figurinha sem som.
- **Dinheiro.** Com token `TEST-` ninguém é cobrado. Não troque para o token de produção sem revisar o fluxo. O semanal custa R$ 7,90. O pacote de 25 custa R$ 5,50 e não vence; o de 15 custa R$ 3,50 e vence em 30 dias. Os ilimitados de 30 dias e de 3 meses custam R$ 14,90 e R$ 19,90.
- **Grupos e desconhecidos.** O padrão é silêncio. Não adicione um comando de disparo: o guard existe para impedir exatamente isso.

`.npmrc` tem `legacy-peer-deps=true` porque o npm 10 quebra o cálculo de peer dependencies deste conjunto (Baileys + Vitest). O `npm ci` do Render lê esse arquivo.
