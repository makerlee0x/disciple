/** Minimal monotonic ULID (Crockford base32, 48-bit ms time + 80-bit random). */
const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastT = -1; let lastR: number[] = [];
export function ulid(now = Date.now()): string {
  let r: number[];
  if (now === lastT) { r = lastR.slice(); for (let i = 15; i >= 0; i--) { if (r[i] < 31) { r[i]++; break; } r[i] = 0; } }
  else { r = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32)); }
  lastT = now; lastR = r;
  let t = ""; let x = now;
  for (let i = 0; i < 10; i++) { t = A[x % 32] + t; x = Math.floor(x / 32); }
  return t + r.map((i) => A[i]).join("");
}
