// Minimal Salsa20 stream cipher (pure JS) — used to decrypt GT7 telemetry.

function rotl(v, c) { return ((v << c) | (v >>> (32 - c))) >>> 0; }

function core(input, output) {
  const x = input.slice();
  for (let i = 0; i < 20; i += 2) {
    x[4] ^= rotl((x[0] + x[12]) >>> 0, 7);  x[8] ^= rotl((x[4] + x[0]) >>> 0, 9);
    x[12] ^= rotl((x[8] + x[4]) >>> 0, 13); x[0] ^= rotl((x[12] + x[8]) >>> 0, 18);
    x[9] ^= rotl((x[5] + x[1]) >>> 0, 7);   x[13] ^= rotl((x[9] + x[5]) >>> 0, 9);
    x[1] ^= rotl((x[13] + x[9]) >>> 0, 13); x[5] ^= rotl((x[1] + x[13]) >>> 0, 18);
    x[14] ^= rotl((x[10] + x[6]) >>> 0, 7); x[2] ^= rotl((x[14] + x[10]) >>> 0, 9);
    x[6] ^= rotl((x[2] + x[14]) >>> 0, 13); x[10] ^= rotl((x[6] + x[2]) >>> 0, 18);
    x[3] ^= rotl((x[15] + x[11]) >>> 0, 7); x[7] ^= rotl((x[3] + x[15]) >>> 0, 9);
    x[11] ^= rotl((x[7] + x[3]) >>> 0, 13); x[15] ^= rotl((x[11] + x[7]) >>> 0, 18);
    x[1] ^= rotl((x[0] + x[3]) >>> 0, 7);   x[2] ^= rotl((x[1] + x[0]) >>> 0, 9);
    x[3] ^= rotl((x[2] + x[1]) >>> 0, 13);  x[0] ^= rotl((x[3] + x[2]) >>> 0, 18);
    x[6] ^= rotl((x[5] + x[4]) >>> 0, 7);   x[7] ^= rotl((x[6] + x[5]) >>> 0, 9);
    x[4] ^= rotl((x[7] + x[6]) >>> 0, 13);  x[5] ^= rotl((x[4] + x[7]) >>> 0, 18);
    x[11] ^= rotl((x[10] + x[9]) >>> 0, 7); x[8] ^= rotl((x[11] + x[10]) >>> 0, 9);
    x[9] ^= rotl((x[8] + x[11]) >>> 0, 13); x[10] ^= rotl((x[9] + x[8]) >>> 0, 18);
    x[12] ^= rotl((x[15] + x[14]) >>> 0, 7); x[13] ^= rotl((x[12] + x[15]) >>> 0, 9);
    x[14] ^= rotl((x[13] + x[12]) >>> 0, 13); x[15] ^= rotl((x[14] + x[13]) >>> 0, 18);
  }
  for (let i = 0; i < 16; i++) output[i] = (x[i] + input[i]) >>> 0;
}

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]; // "expand 32-byte k"

/**
 * Decrypt/encrypt (XOR) `data` with Salsa20.
 * @param {Buffer} key 32 bytes
 * @param {Buffer} nonce 8 bytes
 * @param {Buffer} data
 * @returns {Buffer}
 */
export function salsa20(key, nonce, data) {
  const state = new Uint32Array(16);
  state[0] = SIGMA[0];
  for (let i = 0; i < 4; i++) state[1 + i] = key.readUInt32LE(i * 4);
  state[5] = SIGMA[1];
  state[6] = nonce.readUInt32LE(0);
  state[7] = nonce.readUInt32LE(4);
  state[8] = 0; state[9] = 0; // block counter
  state[10] = SIGMA[2];
  for (let i = 0; i < 4; i++) state[11 + i] = key.readUInt32LE(16 + i * 4);
  state[15] = SIGMA[3];

  const out = Buffer.alloc(data.length);
  const block = new Uint32Array(16);
  const keystream = Buffer.alloc(64);
  let counter = 0n;

  for (let pos = 0; pos < data.length; pos += 64) {
    state[8] = Number(counter & 0xffffffffn);
    state[9] = Number((counter >> 32n) & 0xffffffffn);
    core(state, block);
    for (let i = 0; i < 16; i++) keystream.writeUInt32LE(block[i], i * 4);
    const n = Math.min(64, data.length - pos);
    for (let i = 0; i < n; i++) out[pos + i] = data[pos + i] ^ keystream[i];
    counter++;
  }
  return out;
}
