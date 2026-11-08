// Rule definitions and evaluation.
//
// Every address below was checked on Pharos Pacific with eth_getCode and, for
// tokens, with symbol()/decimals() before being put in this file. Run
// `npm run verify:chain` to re-check them; if one stops answering, the rule
// that depends on it must fail loudly rather than quietly report "fine".

import {
  readNativeTransferMax,
  readErc20TransferMax,
  readNativeBalance,
  readPaused,
  readChainStall,
  readGasPrice,
} from "./metrics.mjs";
import { formatUnits } from "./abi.mjs";
import { linkFor } from "./links.mjs";

// Per-rule cap on triggering events carried in one result. Anything above it is
// counted in eventsTotal so truncation is stated, not hidden.
export const MAX_TRIGGERING_EVENTS = 25;

export const PACIFIC = {
  chainId: 1672,
  rpc: "https://rpc.pharos.xyz",
  explorer: "https://www.pharosscan.xyz",
};

// Addresses from docs.pharos.xyz (Canonical Contracts + Token Registry),
// confirmed on-chain 2026-11-05.
export const ADDRESSES = {
  usdc: "0xc879c018db60520f4355c26ed1a6d572cdac1815",
  weth: "0x1f4b7011Ee3d53969bb67F59428a9ec0477856E9",
  link: "0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29",
  wpros: "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0",
  entryPointV07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  multiCall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
};

// windowBlocks is how much history a window rule looks back over on a cold
// start. With ~0.93s blocks, 60 blocks is a little under a minute.
export const DEFAULT_RULES = [
  {
    id: "whale-native",
    name: "Large native PROS transfer",
    severity: "warning",
    metric: "native_transfer_max",
    target: null,
    comparator: ">=",
    threshold: "1000000000000000000000", // 1,000 PROS
    unit: "wei",
    decimals: 18,
    windowBlocks: 60,
    channel: "telegram",
    why: "A single wallet moving 1,000+ PROS is worth a look before it reaches a DEX.",
  },
  {
    id: "whale-usdc",
    name: "Large USDC transfer",
    severity: "warning",
    metric: "erc20_transfer_max",
    target: ADDRESSES.usdc,
    comparator: ">=",
    threshold: "1000000000", // 1,000 USDC (6 decimals)
    unit: "token",
    decimals: 6,
    symbol: "USDC",
    windowBlocks: 60,
    channel: "discord",
    why: "USDC is the only bridged stable with real supply on Pacific; size matters there.",
  },
  {
    id: "treasury-low",
    name: "EntryPoint paymaster float low",
    severity: "critical",
    metric: "native_balance",
    target: ADDRESSES.entryPointV07,
    comparator: "<=",
    threshold: "500000000000000000000", // 500 PROS
    unit: "wei",
    decimals: 18,
    channel: "telegram",
    why: "The v0.7 EntryPoint holds the gas float for account abstraction. If it drains, user operations stop landing.",
  },
  {
    id: "contract-paused",
    name: "USDC paused",
    severity: "critical",
    metric: "contract_paused",
    target: ADDRESSES.usdc,
    comparator: "==",
    threshold: true,
    unit: "bool",
    symbol: "USDC",
    channel: "telegram",
    why: "A paused stablecoin means every integration that assumes transfers are live is now broken.",
  },
  {
    id: "chain-stall",
    name: "Chain head stalled",
    severity: "critical",
    metric: "chain_head_age",
    target: null,
    comparator: ">",
    threshold: 60,
    unit: "seconds",
    decimals: 0,
    channel: "telegram",
    why: "Blocks arrive every ~0.93s. A minute of silence is not idle, it is a stalled chain.",
  },
];

// Widest look-back any rule asks for. The watcher and the API derive their
// cold-start window from this instead of hard-coding it.
export function defaultWindow(rules = DEFAULT_RULES) {
  return rules.reduce((max, r) => (typeof r.windowBlocks === "number" ? Math.max(max, r.windowBlocks) : max), 1);
}

const READERS = {
  native_transfer_max: (client, rule, range) => readNativeTransferMax(client, { ...range }),
  erc20_transfer_max: (client, rule, range) =>
    readErc20TransferMax(client, { address: rule.target, decimals: rule.decimals, symbol: rule.symbol, ...range }),
  native_balance: (client, rule) => readNativeBalance(client, { address: rule.target }),
  contract_paused: (client, rule) => readPaused(client, { address: rule.target, symbol: rule.symbol }),
  chain_head_age: (client) => readChainStall(client),
  gas_price: (client) => readGasPrice(client),
};

// Comparison is type-directed. A comparison that cannot be made is an error,
// never false: "unknown" and "safe" must not share an answer.
export function compare(observed, comparator, threshold) {
  if (typeof observed === "boolean" || typeof threshold === "boolean") {
    if (comparator !== "==" && comparator !== "!=") {
      throw new Error(`compare: comparator ${comparator} is undefined for booleans`);
    }
    const same = Boolean(observed) === Boolean(threshold);
    return comparator === "==" ? same : !same;
  }

  let a;
  let b;
  if (typeof observed === "bigint" || typeof threshold === "bigint" || /^\d+$/.test(String(observed)) && /^\d+$/.test(String(threshold))) {
    a = BigInt(observed);
    b = BigInt(threshold);
  } else if (typeof observed === "number" || typeof threshold === "number") {
    a = Number(observed);
    b = Number(threshold);
  } else {
    // Strings have no ordering we can defend without a format contract.
    if (comparator === "==") return String(observed) === String(threshold);
    if (comparator === "!=") return String(observed) !== String(threshold);
    throw new Error(`compare: ${comparator} is undefined for strings`);
  }

  switch (comparator) {
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    case "==": return a === b;
    case "!=": return a !== b;
    default: throw new Error(`compare: unknown comparator ${comparator}`);
  }
}

export function formatObserved(rule, reading) {
  if (rule.unit === "bool") return reading.value ? "true" : "false";
  if (rule.unit === "seconds") return `${reading.value}s`;
  if (rule.unit === "wei" && rule.decimals === 18) return `${formatUnits(reading.value, 18)} PROS`;
  if (rule.unit === "wei/gas") return `${formatUnits(reading.value, 9)} gwei`;
  if (rule.unit === "token") return `${formatUnits(reading.value, rule.decimals)} ${rule.symbol || ""}`.trim();
  return String(reading.value);
}

export function formatThreshold(rule) {
  return formatObserved(rule, { value: typeof rule.threshold === "string" && rule.unit === "wei" ? BigInt(rule.threshold) : rule.threshold });
}

const baseOf = (rule) => ({
  ruleId: rule.id,
  name: rule.name,
  severity: rule.severity,
  channel: rule.channel,
});

// Events from a window reading that individually satisfy the rule. Rules that
// are not about discrete events (balance, paused, head age) have none.
function triggeringEvents(rule, reading) {
  if (!Array.isArray(reading.events)) return { events: null, total: 0 };
  const hits = reading.events.filter((e) => compare(e.value, rule.comparator, rule.threshold));
  return {
    events: hits.slice(0, MAX_TRIGGERING_EVENTS).map((e) => ({ ...e, value: e.value.toString() })),
    total: hits.length,
  };
}

/**
 * Evaluate rules against the chain.
 *
 * Each result is exactly one of:
 *   TRIGGERED — the condition is true right now
 *   OK        — the condition is false right now, measured
 *   ERROR     — the measurement failed; say nothing about the condition
 *   SKIPPED   — the rule does not apply in this run (window rules on a
 *               same-block tick with no new blocks)
 *
 * The distinction between OK and ERROR is the whole point. A monitor that maps
 * a dead RPC to OK is a monitor that is quiet when it matters.
 */
export async function evaluate(client, rules = DEFAULT_RULES, { fromBlock, toBlock } = {}) {
  const results = [];
  const range = { fromBlock, toBlock };

  for (const rule of rules) {
    const reader = READERS[rule.metric];
    if (!reader) {
      results.push({ ...baseOf(rule), state: "ERROR", comparator: rule.comparator, error: { kind: "config", message: `no reader for metric ${rule.metric}` } });
      continue;
    }

    // Window rules need history. On a tick where the head has not moved there
    // is nothing new to scan, and re-measuring the same window would re-fire
    // the same alert. Point-in-time rules (paused, balance, head age) do not
    // depend on the window and must still be measured on that tick.
    const needsWindow = typeof rule.windowBlocks === "number";
    if (needsWindow && range.fromBlock != null && range.toBlock != null && range.fromBlock > range.toBlock) {
      results.push({ ...baseOf(rule), state: "SKIPPED", reason: "no new blocks since last tick" });
      continue;
    }

    try {
      const reading = await reader(client, rule, range);
      // A reader that returns nothing is not a reading of zero. Catching this
      // here names the rule that broke instead of failing later inside compare.
      if (reading == null || reading.value === undefined) {
        throw new Error(`reader for ${rule.metric} returned no value`);
      }
      const triggered = compare(reading.value, rule.comparator, rule.threshold);
      const { events, total } = triggeringEvents(rule, reading);
      const result = {
        ...baseOf(rule),
        state: triggered ? "TRIGGERED" : "OK",
        metric: rule.metric,
        target: rule.target,
        comparator: rule.comparator,
        threshold: rule.threshold,
        thresholdFormatted: formatThreshold(rule),
        observed: typeof reading.value === "bigint" ? reading.value.toString() : reading.value,
        observedFormatted: formatObserved(rule, reading),
        detail: reading.detail || null,
        evidence: reading.evidence || [],
        why: rule.why,
      };
      if (events) {
        result.events = triggered ? events : [];
        result.eventsTotal = triggered ? total : 0;
      }
      result.link = linkFor(result);
      results.push(result);
    } catch (err) {
      const result = {
        ...baseOf(rule),
        state: "ERROR",
        metric: rule.metric,
        target: rule.target,
        comparator: rule.comparator,
        threshold: rule.threshold,
        thresholdFormatted: formatThreshold(rule),
        error: { kind: err?.kind || "internal", message: err?.message || String(err) },
        why: rule.why,
      };
      result.link = linkFor(result);
      results.push(result);
    }
  }

  const startBlock = range.fromBlock ?? null;
  const endBlock = range.toBlock ?? null;

  const counts = { triggered: 0, ok: 0, error: 0, skipped: 0 };
  for (const r of results) {
    if (r.state === "TRIGGERED") counts.triggered += 1;
    else if (r.state === "OK") counts.ok += 1;
    else if (r.state === "ERROR") counts.error += 1;
    else counts.skipped += 1;
  }

  return {
    chainId: PACIFIC.chainId,
    evaluatedAt: new Date().toISOString(),
    blockRange: { from: startBlock, to: endBlock },
    counts,
    // Degraded means "some measurements failed". It is not the same as healthy
    // and it is not the same as broken; the caller decides what to do with it.
    degraded: counts.error > 0,
    results,
  };
}
