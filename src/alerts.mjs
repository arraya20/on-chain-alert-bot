// Alert planning and delivery, separated from the watcher script so it can be
// tested without a process, a clock, or a network.
//
// Two kinds of rule, two kinds of dedupe:
//
//   Event rules (whale transfers) produce discrete events. Identity is the
//   event itself (rule + tx hash, plus log index for token transfers). Each
//   event alerts once, however many other whales moved in the same window and
//   however recently the previous one alerted. A time-based cooldown is the
//   wrong tool here: it would silently swallow a different, equally large
//   transfer.
//
//   State rules (balance, paused, head age, and any ERROR) describe a
//   condition that stays true. Those alert once per episode and then at most
//   once per cooldown. When the rule measures OK again the episode ends, so a
//   later recurrence alerts immediately instead of waiting out a stale timer.
//
// A failed send never marks anything as seen. Failed events go to a pending
// queue and are retried first on the next pass, independent of the block
// cursor, so a whale alert that failed to deliver is not lost when the cursor
// moves past its block.

import { linkFor } from "./links.mjs";

export const SEEN_TTL_MS = 6 * 60 * 60 * 1000;
export const PENDING_MAX_ATTEMPTS = 5;
export const PENDING_MAX_AGE_MS = 60 * 60 * 1000;
export const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

export function emptyState() {
  return { cursor: null, alerts: {}, seen: {}, pending: [], passes: 0 };
}

export function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    cursor: Number.isSafeInteger(s.cursor) ? s.cursor : null,
    alerts: s.alerts && typeof s.alerts === "object" ? s.alerts : {},
    seen: s.seen && typeof s.seen === "object" ? s.seen : {},
    pending: Array.isArray(s.pending) ? s.pending : [],
    passes: Number.isSafeInteger(s.passes) ? s.passes : 0,
  };
}

// A single event, shaped like a result so the formatters need no special case.
function eventResult(result, event) {
  const { events, eventsTotal, ...rest } = result;
  const unit = result.metric === "native_transfer_max" ? "native" : "token";
  const observedFormatted = formatEventValue(result, event.value);
  return {
    ...rest,
    state: "TRIGGERED",
    observed: event.value,
    observedFormatted,
    detail: {
      ...(result.detail ?? {}),
      eventKind: unit,
      largest: { txHash: event.txHash, from: event.from, to: event.to, block: event.block, value: event.value },
    },
    evidence: [`${observedFormatted} in tx ${String(event.txHash).slice(0, 10)}… (block ${event.block})`],
    // Not inherited: the window result links its single largest tx, which is
    // a different event from this one.
    link: linkFor({ detail: { largest: { txHash: event.txHash } } }),
  };
}

// The observation string is derived from the rule's own formatting so an event
// alert and a window summary never disagree on units.
function formatEventValue(result, rawValue) {
  const big = BigInt(rawValue);
  const decimals = result.metric === "native_transfer_max" ? 18 : result.detail?.decimals;
  if (!Number.isInteger(decimals)) throw new Error(`event for ${result.ruleId} has no decimals to format with`);
  const symbol = result.metric === "native_transfer_max" ? "PROS" : (result.detail?.symbol ?? "");
  return `${formatDecimal(big, decimals)} ${symbol}`.trim();
}

function formatDecimal(value, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

const eventKey = (ruleId, event) => `${ruleId}:${event.key}`;

/**
 * Decide what to send for this pass.
 * Returns { items, truncated } where each item is
 *   { key, ruleId, channel, result, kind: "event" | "state", stateKey? }
 * Pure: it reads state and never changes it.
 */
export function planAlerts(results, state, { now = Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const items = [];
  let truncated = 0;
  const pendingKeys = new Set(state.pending.map((p) => p.key));

  for (const result of results) {
    if (result.state === "TRIGGERED" && Array.isArray(result.events)) {
      truncated += Math.max(0, (result.eventsTotal ?? 0) - result.events.length);
      for (const event of result.events) {
        const key = eventKey(result.ruleId, event);
        if (state.seen[key] || pendingKeys.has(key)) continue;
        items.push({ key, ruleId: result.ruleId, channel: result.channel, kind: "event", result: eventResult(result, event) });
      }
      continue;
    }

    if (result.state !== "TRIGGERED" && result.state !== "ERROR") continue;
    const stateKey = result.state;
    const prev = state.alerts[result.ruleId];
    const due = !prev || prev.state !== stateKey || now - (prev.at ?? 0) >= cooldownMs;
    if (!due) continue;
    const key = `${result.ruleId}:${stateKey}`;
    if (pendingKeys.has(key)) continue;
    items.push({ key, ruleId: result.ruleId, channel: result.channel, kind: "state", stateKey, result });
  }

  return { items, truncated };
}

// Plain-data copy that survives JSON (BigInt-free), for the pending queue.
const portable = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

/**
 * Plan and send. Returns the next state and one delivery record per attempt.
 * `send(channel, result)` must resolve to { channel, status, httpStatus, detail }.
 * With dryRun, nothing is sent and the returned state is the input state
 * itself, so a dry run can never move a cursor or mark an event as seen.
 */
export async function deliver({ results, state, send, dryRun = false, now = Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS }) {
  const next = normalizeState(JSON.parse(JSON.stringify(state)));
  const deliveries = [];

  // Housekeeping first, so an old entry can never block a new alert.
  for (const [k, at] of Object.entries(next.seen)) if (now - at > SEEN_TTL_MS) delete next.seen[k];

  // A state rule that measured OK has ended its episode.
  for (const r of results) if (r.state === "OK") delete next.alerts[r.ruleId];

  const dropped = [];
  const retry = [];
  for (const p of next.pending) {
    if (now - p.firstAt > PENDING_MAX_AGE_MS || p.attempts >= PENDING_MAX_ATTEMPTS) {
      dropped.push({ key: p.key, ruleId: p.ruleId, reason: p.attempts >= PENDING_MAX_ATTEMPTS ? "max attempts" : "too old" });
    } else {
      retry.push(p);
    }
  }
  next.pending = [];

  // Items being retried this pass must not be planned again as new.
  const { items, truncated } = planAlerts(results, { ...next, pending: retry }, { now, cooldownMs });
  const queue = [
    ...retry.map((p) => ({ ...p, retried: true })),
    ...items.map((i) => ({ ...i, result: portable(i.result), attempts: 0, firstAt: now, retried: false })),
  ];

  for (const item of queue) {
    if (dryRun) {
      deliveries.push({ key: item.key, ruleId: item.ruleId, channel: item.channel, status: "dry-run", httpStatus: null, detail: null, retried: item.retried });
      if (item.retried) next.pending.push(item);
      continue;
    }

    const d = await send(item.channel, item.result);
    deliveries.push({ key: item.key, ruleId: item.ruleId, retried: item.retried, ...d });

    if (d.status === "sent") {
      if (item.kind === "event") next.seen[item.key] = now;
      else next.alerts[item.ruleId] = { state: item.stateKey, at: now, channel: item.channel };
      continue;
    }

    // A transient failure is queued and retried. A misconfiguration (no
    // credentials, blocked URL) is reported in the delivery record and is not
    // queued: it will not fix itself within the retry window, and the event is
    // not marked seen. State rules need no queue; they are re-measured and
    // re-planned on the next pass because a failed send is never recorded.
    if (d.status === "failed" && item.kind === "event") {
      next.pending.push({ ...item, attempts: item.attempts + 1 });
    }
  }

  return { state: dryRun ? state : next, deliveries, truncated, dropped };
}
