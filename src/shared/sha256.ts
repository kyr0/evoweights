// SHA-256 per FIPS 180-4. WebCrypto is preferred; the standalone path also
// works on HTTP origins where browsers do not expose crypto.subtle.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);
const ror = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
const hex32 = (n: number): string => n.toString(16).padStart(8, '0');

export function sha256JS(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('SHA-256 input must be a Uint8Array');
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  function compress(block: DataView, base: number): void {
    for (let i = 0; i < 16; i++) w[i] = block.getUint32(base + 4 * i, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15],
        y = w[i - 2];
      w[i] = w[i - 16] + (ror(x, 7) ^ ror(x, 18) ^ (x >>> 3)) + w[i - 7] + (ror(y, 17) ^ ror(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, j] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (j + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      j = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += j;
  }
  const n = bytes.byteLength,
    end = n - (n % 64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n);
  for (let i = 0; i < end; i += 64) compress(view, i);
  const tail = new Uint8Array(n - end < 56 ? 64 : 128);
  tail.set(bytes.subarray(end));
  tail[n - end] = 0x80;
  const suffix = new DataView(tail.buffer),
    bits = n * 8;
  suffix.setUint32(tail.length - 8, Math.floor(bits / 0x100000000), false);
  suffix.setUint32(tail.length - 4, bits >>> 0, false);
  for (let i = 0; i < tail.length; i += 64) compress(suffix, i);
  return Array.from(h, hex32).join('');
}

/** Hex SHA-256 of `bytes`. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(hash), (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return sha256JS(bytes);
}
