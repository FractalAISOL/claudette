import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PROMPT_PATH } from './config.js';

export function loadPrompt(path = PROMPT_PATH): { text: string; sha256: string } {
  const buf = readFileSync(path);
  return { text: buf.toString('utf8'), sha256: createHash('sha256').update(buf).digest('hex') };
}
