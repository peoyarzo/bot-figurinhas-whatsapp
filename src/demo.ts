import { startDemo } from './demo-flow.js';

const report = await startDemo();
console.log(report.transcript);
console.log(`saldo ${report.balance} · teste ${report.trial} · figurinha ${report.stickerBytes} bytes · cartão ${report.cardBytes} bytes`);
