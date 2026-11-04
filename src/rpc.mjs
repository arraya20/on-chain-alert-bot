// Minimal JSON-RPC client for Pharos. No dependencies, no retries except where
// the chain explicitly says "try again later".
//
// Every failure is a distinct class. That matters more than it sounds: a
// timeout, a rate limit, and a reverted call all look like "no data" if you
// swallow them, and a monitor that reports "nothing happened" because it could
// not reach the node is worse than one that reports nothing at all.

export const PACIFIC_RPC = "https://rpc.pharos.xyz";
export const PACIFIC_CHAIN_ID = 1672;

// eth_getLogs on Pharos accepts at most 1,000 blocks counted inclusively, so
// fromBlock = head - 999 is the widest window that works and head - 1000 is
// rejected. Two traps here, both measured 2026-11-05:
//   - passing toBlock: "latest" makes the node resolve the head again at
//     execution, so a range you sized against your own head is one or two
//     blocks wider than you think and 1,000 misses.
//   - the error text says "within 1,000 blocks", which reads like an exclusive
//     bound and is not.
// getLogs() below therefore always sends explicit hex block numbers and never
// "latest".
export const MAX_LOG_SPAN = 999;

export class RpcError extends Error {
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = "RpcError";
    this.kind = kind; // "network" | "timeout" | "http" | "rpc" | "shape"
    Object.assign(this, detail);
  }
}

// The public node meters compute units per second and answers a burst with
// "cu limit exceeded; Request too fast per second". Measured 2026-11-05: a
// 60-block scan at concurrency 8 fails roughly one run in three. It is
// transient, so it is retried; it is not a reason to report the chain as
// unreadable, and it is not a reason to report a rule as OK either.
const RETRYABLE = /cu limit|too fast|rate limit|try again|temporarily/i;

function isRetryable(err) {
  if (!(err instanceof RpcError)) return false;
  if (err.httpStatus === 429) return true;
  if (err.rpcCode === -32005) return true;
  return RETRYABLE.test(err.message || "");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({ url = PACIFIC_RPC, timeoutMs = 20_000, fetchImpl = fetch, maxRetries = 3, baseDelayMs = 250 } = {}) {
  if (!url.startsWith("https://")) throw new Error(`RPC url must be https, got ${url}`);

  // Read-only client: every method here is a query, so retrying on a transient
  // failure cannot duplicate a side effect. Nothing that signs or sends belongs
  // in this file for exactly that reason.
  async function rpc(method, params = []) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await once(method, params);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === maxRetries) throw err;
        // Jitter matters: several workers hit the same limit at the same time,
        // and a fixed delay keeps them in lockstep.
        const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 120);
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  async function once(method, params) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const kind = err?.name === "TimeoutError" ? "timeout" : "network";
      throw new RpcError(kind, `${method}: ${err?.cause?.code || err?.name || "fetch failed"}`, { cause: err });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Many nodes answer a bad parameter with HTTP 400 *and* a well-formed
      // JSON-RPC error body. Reporting only "HTTP 400" throws away the one
      // sentence that explains the failure, so prefer the body when it parses.
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* not JSON, fall through */
      }
      if (parsed?.error?.message) {
        throw new RpcError("rpc", `${method}: ${parsed.error.message}`, {
          httpStatus: res.status,
          rpcCode: parsed.error.code,
          rpcMessage: parsed.error.message,
        });
      }
      throw new RpcError("http", `${method}: HTTP ${res.status}`, { httpStatus: res.status, body: body.slice(0, 300) });
    }

    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new RpcError("shape", `${method}: response was not JSON`, { cause: err });
    }

    if (json.error) {
      // Node-level errors carry a code: -32602 bad params, 429-ish rate limits.
      throw new RpcError("rpc", `${method}: ${json.error.message}`, {
        rpcCode: json.error.code,
        rpcMessage: json.error.message,
      });
    }
    if (!("result" in json)) {
      throw new RpcError("shape", `${method}: response had neither result nor error`);
    }
    return json.result;
  }

  return {
    url,
    rpc,

    async chainId() {
      return Number(BigInt(await rpc("eth_chainId")));
    },

    async blockNumber() {
      return Number(BigInt(await rpc("eth_blockNumber")));
    },

    async gasPrice() {
      return BigInt(await rpc("eth_gasPrice"));
    },

    async balance(addr) {
      return BigInt(await rpc("eth_getBalance", [addr, "latest"]));
    },

    async code(addr) {
      return await rpc("eth_getCode", [addr, "latest"]);
    },

    async block(n, withTxs = false) {
      const b = await rpc("eth_getBlockByNumber", ["0x" + Number(n).toString(16), withTxs]);
      if (!b) return null;
      return {
        number: Number(BigInt(b.number)),
        timestamp: Number(BigInt(b.timestamp)),
        gasUsed: BigInt(b.gasUsed),
        gasLimit: BigInt(b.gasLimit),
        baseFeePerGas: b.baseFeePerGas ? BigInt(b.baseFeePerGas) : null,
        transactions: withTxs ? b.transactions : b.transactions.map((t) => ({ hash: t })),
      };
    },

    async call(to, data) {
      return await rpc("eth_call", [{ to, data }, "latest"]);
    },

    // Splits the requested range into chunks the node accepts. Returns logs in
    // ascending block order and never silently drops a chunk: if any chunk
    // fails, the whole call fails.
    async getLogs({ address, topics = [], fromBlock, toBlock }) {
      const out = [];
      let from = fromBlock;
      while (from <= toBlock) {
        const to = Math.min(toBlock, from + MAX_LOG_SPAN);
        const chunk = await rpc("eth_getLogs", [
          { address, topics, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) },
        ]);
        out.push(...chunk);
        from = to + 1;
      }
      return out;
    },
  };
}

// A monitor that cannot tell "the node is down" from "nothing happened" will
// eventually page someone at 3am with silence. Surface it instead.
export function describeError(err) {
  if (err instanceof RpcError) return { kind: err.kind, message: err.message, rpcCode: err.rpcCode ?? null };
  return { kind: "internal", message: err?.message || String(err), rpcCode: null };
}
