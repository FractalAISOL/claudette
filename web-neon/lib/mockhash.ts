// Mock-only stand-in for sha256 (sync, not cryptographic): mock attempts just need a stable 64-char hex.
export function createHash(s: string): string {
  let h = 0x811c9dc5;
  let out = '';
  for (let r = 0; r < 8; r++) {
    for (const ch of s + r) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}
