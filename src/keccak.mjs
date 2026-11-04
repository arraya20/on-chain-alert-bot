// Dependency-free keccak-256, EVM function selectors, and event topics.
//
// These values are DERIVED, never typed. A hand-copied topic constant and its
// hand-copied test agree with each other forever while disagreeing with the
// chain; deriving both from the signature makes that impossible.
//
// Adapted from the dependency-free implementation in the generated-code-audit
// skill, which self-tests against published vectors before emitting anything.

const MASK = (1n << 64n) - 1n;

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROTATIONS = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const RATE = 136; // 1088 bits

function rotl(value, shift) {
  const n = BigInt(shift);
  if (n === 0n) return value & MASK;
  return ((value << n) | (value >> (64n - n))) & MASK;
}

function keccakF(lanes) {
  const C = new Array(5);
  const D = new Array(5);
  const B = new Array(25);
  for (let round = 0; round < 24; round += 1) {
    for (let x = 0; x < 5; x += 1) {
      C[x] = lanes[x] ^ lanes[x + 5] ^ lanes[x + 10] ^ lanes[x + 15] ^ lanes[x + 20];
    }
    for (let x = 0; x < 5; x += 1) {
      D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) lanes[x + 5 * y] ^= D[x];
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(lanes[x + 5 * y], ROTATIONS[x][y]);
      }
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        lanes[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & MASK & B[((x + 2) % 5) + 5 * y]);
      }
    }
    lanes[0] ^= ROUND_CONSTANTS[round];
  }
  return lanes;
}

export function keccak256(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const lanes = new Array(25).fill(0n);
  const padded = new Uint8Array(Math.floor(bytes.length / RATE) * RATE + RATE);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let i = 0; i < RATE / 8; i += 1) {
      let lane = 0n;
      for (let b = 7; b >= 0; b -= 1) {
        lane = (lane << 8n) | BigInt(padded[offset + i * 8 + b]);
      }
      lanes[i] ^= lane;
    }
    keccakF(lanes);
  }

  const digest = new Uint8Array(32);
  for (let i = 0; i < 4; i += 1) {
    let lane = lanes[i];
    for (let b = 0; b < 8; b += 1) {
      digest[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return digest;
}

export function toHex(bytes) {
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A selector is keccak256(canonical signature)[0:4].
export function selectorOf(signature) {
  return toHex(keccak256(signature)).slice(0, 10);
}

// An EVM event topic is the FULL keccak256 of the canonical signature.
export function eventTopicOf(signature) {
  return toHex(keccak256(signature));
}

// Published vectors. Run from a test: if this copy drifts, nothing else it
// emits can be trusted, so callers should treat a failure as fatal.
export const VECTORS = [
  ["keccak256('')", () => toHex(keccak256("")), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
  ["transfer(address,uint256)", () => selectorOf("transfer(address,uint256)"), "0xa9059cbb"],
  ["paused()", () => selectorOf("paused()"), "0x5c975abb"],
  ["decimals()", () => selectorOf("decimals()"), "0x313ce567"],
  ["symbol()", () => selectorOf("symbol()"), "0x95d89b41"],
  ["totalSupply()", () => selectorOf("totalSupply()"), "0x18160ddd"],
  [
    "Transfer(address,address,uint256)",
    () => eventTopicOf("Transfer(address,address,uint256)"),
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  ],
  [
    "Paused(address)",
    () => eventTopicOf("Paused(address)"),
    "0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258",
  ],
];

export function selfTest() {
  const failures = [];
  for (const [name, compute, expected] of VECTORS) {
    const actual = compute();
    if (actual !== expected) failures.push({ name, expected, actual });
  }
  return failures;
}
