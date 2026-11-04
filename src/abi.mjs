// Minimal ABI decoding for the handful of shapes a monitor actually reads.
// Not a general ABI library: no arrays of structs, no dynamic tuples. If a
// reader here needs more than this, it should say so rather than guess.

export function strip0x(hex) {
  return String(hex).replace(/^0x/, "");
}

export function word(hex, index) {
  const body = strip0x(hex);
  const start = index * 64;
  if (body.length < start + 64) throw new Error(`word(${index}): response too short (${body.length} nibbles)`);
  return body.slice(start, start + 64);
}

export function decodeUint(hex, index = 0) {
  return BigInt("0x" + word(hex, index));
}

export function encodeUint(value) {
  return "0x" + BigInt(value).toString(16).padStart(64, "0");
}

export function decodeInt(hex, index = 0) {
  const w = BigInt("0x" + word(hex, index));
  // Two's complement in 256 bits.
  return w >= 1n << 255n ? w - (1n << 256n) : w;
}

export function decodeBool(hex, index = 0) {
  // Deliberately not strict. A token that answers paused() with anything
  // non-zero is not a token whose transfers should be trusted, so the
  // fail-safe reading is "paused" — the direction that alerts a human, not the
  // direction that stays quiet.
  return decodeUint(hex, index) !== 0n;
}

export function decodeAddress(hex, index = 0) {
  return "0x" + word(hex, index).slice(24);
}

// ABI-encoded dynamic string: offset word, then length word, then bytes.
export function decodeString(hex) {
  const offset = Number(decodeUint(hex, 0));
  const len = Number(BigInt("0x" + strip0x(hex).slice(offset * 2, offset * 2 + 64)));
  const body = strip0x(hex).slice(offset * 2 + 64, offset * 2 + 64 + len * 2);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

// Topic payloads are left-padded to 32 bytes; an address is the last 20.
export function topicToAddress(topic) {
  const body = strip0x(topic);
  if (body.length !== 64) throw new Error(`topicToAddress: expected 32 bytes, got ${body.length / 2}`);
  return "0x" + body.slice(24);
}

// Human units, without floating point drift on big integers.
export function formatUnits(raw, decimals) {
  const v = BigInt(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = decimals === 0 ? "" : "." + frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (fracStr === "." ? "" : fracStr);
}

export function toChecksumLower(addr) {
  return String(addr).toLowerCase();
}

export function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function shortAddr(addr) {
  if (!isAddress(addr)) return String(addr);
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
