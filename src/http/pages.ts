import type { ConnectionSnapshot } from '../whatsapp/connection.js';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function homePage(input: { whatsapp: string; paused: boolean }): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Figurinhas</title>
  <style>
    body { margin: 0; font-family: Inter, Liberation Sans, sans-serif; background: #101218; color: #f4f1ea; }
    main { max-width: 36rem; margin: 0 auto; padding: 2.5rem 1.25rem; }
    h1 { font-size: 1.8rem; font-weight: 600; }
    p { color: #a39e93; line-height: 1.5; }
    code { color: #f0b429; }
  </style>
</head>
<body>
  <main>
    <h1>Figurinhas</h1>
    <p>WhatsApp: <code>${escapeHtml(input.whatsapp)}</code></p>
    <p>Pausado: <code>${input.paused ? 'sim' : 'não'}</code></p>
    <p>Saúde do processo: <code>/health</code></p>
  </main>
</body>
</html>`;
}

export function qrPage(input: { snapshot: ConnectionSnapshot; qrDataUrl: string | null; token: string }): string {
  const snap = input.snapshot;
  const pairing = snap.pairingCode ? formatPairing(snap.pairingCode) : '';
  const refresh = snap.status === 'open' || snap.status === 'mock' || snap.status === 'logged_out' ? '' : '<meta http-equiv="refresh" content="5"/>';
  let body = '';
  if (snap.status === 'mock') {
    body = '<p>Modo MOCK_WHATSAPP=1: não conectei no WhatsApp. Para parear de verdade, suba com MOCK_WHATSAPP=0.</p>';
  } else if (snap.status === 'open') {
    body = '<p>Sessão conectada. Não precisa escanear de novo.</p>';
  } else if (snap.status === 'logged_out') {
    body = `<p>A sessão foi encerrada (loggedOut). Apague a sessão salva para gerar outro QR.</p>
      <form method="post" action="/session/reset?token=${encodeURIComponent(input.token)}">
        <button type="submit">Apagar sessão e pedir QR de novo</button>
      </form>`;
  } else if (input.qrDataUrl) {
    body = `<img alt="QR de pareamento" src="${input.qrDataUrl}"/>
      <p>No chip novo: WhatsApp, Aparelhos conectados, Conectar aparelho.</p>`;
  } else {
    body = `<p>Ainda não há QR. O socket está em ${escapeHtml(snap.status)}.</p>`;
  }
  const code = pairing ? `<p class="code">${escapeHtml(pairing)}</p><p>Ou use o código em Aparelhos conectados, Conectar com número de telefone.</p>` : '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  ${refresh}
  <title>Parear WhatsApp</title>
  <style>
    body { margin: 0; font-family: Inter, Liberation Sans, sans-serif; background: #101218; color: #f4f1ea; }
    main { max-width: 32rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
    .warn { background: #2a2418; color: #f0b429; padding: 0.9rem 1rem; border-radius: 12px; line-height: 1.45; }
    img { width: min(100%, 320px); height: auto; background: white; border-radius: 12px; margin-top: 1.25rem; }
    .code { font-size: 2rem; letter-spacing: 0.2rem; font-family: "JetBrains Mono", ui-monospace, monospace; }
    button { background: #f0b429; color: #1a1408; border: 0; border-radius: 999px; padding: 0.75rem 1rem; font-weight: 650; }
    p { line-height: 1.5; color: #d9d3c7; }
  </style>
</head>
<body>
  <main>
    <h1>Parear o chip do bot</h1>
    <p class="warn">Use um número novo, só do bot. Não pareie o seu WhatsApp pessoal. O README lista o número que está proibido.</p>
    ${body}
    ${code}
  </main>
</body>
</html>`;
}

function formatPairing(code: string): string {
  const clean = code.replace(/\s/g, '');
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}
