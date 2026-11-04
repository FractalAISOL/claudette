// Generates ~/claudette/.keys/agent-sol.json (Solana CLI keypair format) if missing. Prints the address only.
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';

const here = dirname(fileURLToPath(import.meta.url));
const keysDir = resolve(here, '../../.keys');
mkdirSync(keysDir, { recursive: true, mode: 0o700 });
chmodSync(keysDir, 0o700);

for (const name of ['agent']) {
  const file = resolve(keysDir, `${name}-sol.json`);
  if (existsSync(file)) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8')) as number[]));
    chmodSync(file, 0o600);
    console.log(`${name}: ${kp.publicKey.toBase58()} (exists, unchanged)`);
    continue;
  }
  const kp = Keypair.generate();
  writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)) + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  console.log(`${name}: ${kp.publicKey.toBase58()} (generated)`);
}
