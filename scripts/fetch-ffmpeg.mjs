import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Readable } from 'node:stream';

const execFileAsync = promisify(execFile);
const dest = path.join(process.cwd(), 'bin', 'ffmpeg');

if (existsSync(dest)) {
  console.log(`bin/ffmpeg já existe: ${dest}`);
  process.exit(0);
}

// Build estático público, sem conta e sem cartão. O pacote ffmpeg-static
// desta versão já inclui libwebp; use este script só se ele falhar no Render.
const url = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';
mkdirSync(path.dirname(dest), { recursive: true });
const archive = path.join(process.cwd(), 'bin', 'ffmpeg-static.tar.xz');

const response = await fetch(url);
if (!response.ok || !response.body) {
  console.error(`Falha ao baixar ffmpeg (${response.status}).`);
  process.exit(1);
}
await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
await execFileAsync('tar', ['-xJf', archive, '-C', path.join(process.cwd(), 'bin'), '--wildcards', '--no-anchored', 'ffmpeg', '--transform', 's|.*/||']);
if (!existsSync(dest)) {
  console.error('O arquivo veio, mas o binário ffmpeg não apareceu em bin/.');
  process.exit(1);
}
await execFileAsync('chmod', ['+x', dest]);
console.log(`ffmpeg salvo em ${dest}`);
