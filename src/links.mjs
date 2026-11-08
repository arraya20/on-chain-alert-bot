// Explorer links. Every alert must point somewhere a reader can verify it, not
// only the ones that happen to carry a transaction. The most specific link the
// result supports wins: tx, then address, then block.

export const EXPLORER = "https://www.pharosscan.xyz";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function explorerTx(hash) {
  return `${EXPLORER}/tx/${hash}`;
}

export function explorerAddress(address) {
  return `${EXPLORER}/address/${address}`;
}

export function explorerBlock(number) {
  return `${EXPLORER}/block/${number}`;
}

// Values come off the wire. A string that is not a hash or an address never
// becomes part of a URL.
export function linkFor(result) {
  const tx = result?.detail?.largest?.txHash;
  if (typeof tx === "string" && TX_HASH.test(tx)) {
    return { label: `tx ${tx.slice(0, 12)}…`, url: explorerTx(tx) };
  }
  const target = result?.target;
  if (typeof target === "string" && ADDRESS.test(target)) {
    return { label: `address ${target.slice(0, 8)}…${target.slice(-4)}`, url: explorerAddress(target) };
  }
  const block = result?.detail?.headBlock;
  if (Number.isSafeInteger(block) && block >= 0) {
    return { label: `block ${block}`, url: explorerBlock(block) };
  }
  return null;
}
