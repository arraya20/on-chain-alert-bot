// Metric readers. Each one returns a measurement and the evidence behind it,
// or throws. Nothing here ever returns a default that looks like data.

import { eventTopicOf, selectorOf } from "./keccak.mjs";
import { decodeUint, decodeBool, decodeString, formatUnits, topicToAddress, strip0x } from "./abi.mjs";

export const TRANSFER_TOPIC = eventTopicOf("Transfer(address,address,uint256)");
export const PAUSED_SELECTOR = selectorOf("paused()");
export const SYMBOL_SELECTOR = selectorOf("symbol()");
export const DECIMALS_SELECTOR = selectorOf("decimals()");

// Upper bound on events a single reading carries. The largest ones are kept.
const MAX_EVENTS = 200;

// Fetch a block range with bounded concurrency. A sequential scan of a
// 60-block window takes ~60 round trips; unbounded Promise.all gets you rate
// limited. Concurrency 8 measured at roughly one rate-limit failure per three
// 60-block scans, and a retry storm makes that worse rather than better, so the
// scan runs at 3 (see readNativeTransferMax) and the client backs off on top.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Largest native-value transfer in the window. This is what a "whale moved
// PROS" alert actually needs, and it requires reading blocks: eth_getLogs only
// sees contract events, and native transfers emit nothing.
export async function readNativeTransferMax(client, { fromBlock, toBlock }) {
  const numbers = [];
  for (let n = fromBlock; n <= toBlock; n += 1) numbers.push(n);
  const blocks = await mapLimit(numbers, 3, (n) => client.block(n, true));

  let best = { value: 0n, hash: null, from: null, to: null, block: null };
  let txCount = 0;
  let valueTxCount = 0;
  let missingBlocks = 0;
  // Every value-bearing transaction, so the caller can alert per event rather
  // than only on the single largest one in the window.
  const events = [];

  for (const b of blocks) {
    if (!b) { missingBlocks += 1; continue; }
    for (const tx of b.transactions) {
      txCount += 1;
      const value = BigInt(tx.value);
      if (value > best.value) {
        best = { value, hash: tx.hash, from: tx.from, to: tx.to, block: b.number };
      }
      if (value > 0n) {
        valueTxCount += 1;
        events.push({ key: tx.hash, value, txHash: tx.hash, from: tx.from, to: tx.to ?? null, block: b.number });
      }
    }
  }
  events.sort((x, y) => (x.value > y.value ? -1 : x.value < y.value ? 1 : 0));
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;

  // A window where every block 404s means the node is behind or pruned, not
  // that the chain was quiet. Distinguish the two.
  if (missingBlocks === numbers.length) {
    throw new Error(`readNativeTransferMax: all ${numbers.length} blocks were unavailable in ${fromBlock}..${toBlock}`);
  }

  return {
    value: best.value,
    unit: "wei",
    decimals: 18,
    detail: {
      largest: best.hash
        ? { txHash: best.hash, from: best.from, to: best.to, block: best.block, value: best.value.toString() }
        : null,
      blocksScanned: numbers.length,
      blocksMissing: missingBlocks,
      transactions: txCount,
      valueTransactions: valueTxCount,
    },
    events,
    evidence: best.hash
      ? [`${formatUnits(best.value, 18)} PROS in tx ${best.hash.slice(0, 10)}… (block ${best.block})`]
      : [`no native value transfers across ${numbers.length} blocks`],
  };
}

// Largest ERC-20 Transfer in the window, for one token.
export async function readErc20TransferMax(client, { address, fromBlock, toBlock, decimals, symbol }) {
  const logs = await client.getLogs({
    address,
    topics: [TRANSFER_TOPIC],
    fromBlock,
    toBlock,
  });

  // A Transfer log with anything other than 2 indexed topics is not the shape
  // we can decode (ERC-721 shares the topic). Say so instead of guessing.
  const decodable = logs.filter((l) => l.topics.length === 3);
  let best = { value: 0n, hash: null, from: null, to: null, block: null };
  const events = [];
  for (const l of decodable) {
    const value = BigInt(l.data === "0x" ? "0x0" : l.data);
    const from = topicToAddress(l.topics[1]);
    const to = topicToAddress(l.topics[2]);
    const block = Number(BigInt(l.blockNumber));
    if (value > best.value) best = { value, hash: l.transactionHash, from, to, block };
    if (value > 0n) {
      // One transaction can emit several Transfers, so the log index is part
      // of the identity.
      events.push({ key: `${l.transactionHash}:${l.logIndex ?? "0x0"}`, value, txHash: l.transactionHash, from, to, block });
    }
  }
  events.sort((x, y) => (x.value > y.value ? -1 : x.value < y.value ? 1 : 0));
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;

  return {
    value: best.value,
    unit: "token",
    decimals,
    detail: {
      symbol: symbol ?? null,
      decimals,
      token: address,
      largest: best.hash ? { txHash: best.hash, from: best.from, to: best.to, block: best.block, value: best.value.toString() } : null,
      transfers: logs.length,
      undecodable: logs.length - decodable.length,
    },
    events,
    evidence: best.hash
      ? [`${formatUnits(best.value, decimals)} ${symbol || "tokens"} in tx ${best.hash.slice(0, 10)}… (block ${best.block})`]
      : [`no ${symbol || "token"} transfers across ${toBlock - fromBlock + 1} blocks (${logs.length} Transfer logs seen)`],
  };
}

export async function readNativeBalance(client, { address }) {
  const [balance, code] = await Promise.all([client.balance(address), client.code(address)]);
  return {
    value: balance,
    unit: "wei",
    decimals: 18,
    detail: { address, isContract: code !== "0x", codeSize: (code.length - 2) / 2 },
    evidence: [`eth_getBalance(${address}) = ${formatUnits(balance, 18)} PROS`, code === "0x" ? `address has no code` : `${(code.length - 2) / 2} bytes of code`],
  };
}

export async function readPaused(client, { address, symbol }) {
  let raw;
  try {
    raw = await client.call(address, PAUSED_SELECTOR);
  } catch (err) {
    // paused() is not part of every token. A missing method is a configuration
    // mistake, not a security event, and must not read as "not paused".
    throw new Error(`${symbol || address} does not answer paused(): ${err.message}`);
  }
  const paused = decodeBool(raw);
  return {
    value: paused,
    unit: "bool",
    detail: { address, selector: PAUSED_SELECTOR, symbol: symbol ?? null },
    evidence: [`eth_call ${PAUSED_SELECTOR} on ${address} → ${paused ? "paused" : "not paused"}`],
  };
}

export async function readChainStall(client, { nowMs = Date.now() } = {}) {
  const head = await client.blockNumber();
  const b = await client.block(head, false);
  if (!b) throw new Error(`readChainStall: head block ${head} unavailable`);
  const ageSeconds = Math.max(0, Math.round((nowMs - b.timestamp * 1000) / 1000));
  return {
    value: ageSeconds,
    unit: "seconds",
    decimals: 0,
    raw: { headBlock: head, headTimestamp: b.timestamp },
    detail: { headBlock: head, headTimestamp: b.timestamp },
    evidence: [`head block ${head} timestamp ${new Date(b.timestamp * 1000).toISOString()}`, `${ageSeconds}s behind local clock`],
  };
}

export async function readGasPrice(client) {
  const wei = await client.gasPrice();
  return {
    value: wei,
    unit: "wei/gas",
    decimals: 9,
    detail: { wei: wei.toString() },
    evidence: [`eth_gasPrice = ${formatUnits(wei, 9)} gwei`],
  };
}

// Token identity check used by the verifier and at startup: a rule that names
// "USDC" should fail loudly if the address is not actually USDC.
export async function readTokenIdentity(client, { address }) {
  const [symRaw, decRaw] = await Promise.all([client.call(address, SYMBOL_SELECTOR), client.call(address, DECIMALS_SELECTOR)]);
  let symbol;
  try {
    symbol = decodeString(symRaw);
  } catch {
    symbol = null;
  }
  return { address, symbol, decimals: Number(decodeUint(decRaw)) };
}
