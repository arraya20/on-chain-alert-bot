// Delivery. A dispatch result is only "sent" when an HTTP call returned 2xx.
//
// The previous version of this bot returned `{ status: "DELIVERED" }` from a
// function that never touched the network. That is the worst failure mode a
// notifier has: the audit trail says the user was told, and nobody was.

import { payloadFor } from "./format.mjs";

const PRIVATE_V4 = [
  [/^10\./, "10.0.0.0/8"],
  [/^127\./, "loopback"],
  [/^169\.254\./, "link-local (cloud metadata)"],
  [/^192\.168\./, "192.168.0.0/16"],
  [/^172\.(1[6-9]|2\d|3[01])\./, "172.16.0.0/12"],
  [/^0\./, "0.0.0.0/8"],
];

// Webhook targets come from operator env, never from a request body. This is
// defence in depth: if someone later wires a request field into this, the guard
// still refuses to POST the deployment's metadata service.
export function assertDeliverableUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("delivery url is not a valid URL");
  }
  if (u.protocol !== "https:") throw new Error(`delivery url must be https, got ${u.protocol}`);
  if (u.username || u.password) throw new Error("delivery url must not contain credentials in the authority");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("delivery url must not point at localhost");
  // Chat providers are reached by hostname. An IPv6 literal (::1, fc00::/7,
  // fe80::/10, ::ffff:10.0.0.1) has no legitimate use here, so all are refused
  // instead of trying to classify them. Hostnames are not resolved: this guard
  // checks literals only and does not defend against DNS that points at a
  // private address. The URL comes from operator env, not from a request.
  if (host.startsWith("[")) throw new Error("delivery url must not use an IPv6 literal");
  for (const [pattern, label] of PRIVATE_V4) {
    if (pattern.test(host)) throw new Error(`delivery url must not point at ${label}`);
  }
  return u.toString();
}

// Bot tokens live in the URL path for Telegram. Never let one reach a log.
export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname === "api.telegram.org") {
      // The path is /bot<token>/sendMessage, so the secret is inside the
      // first segment, not a segment of its own.
      const parts = u.pathname.split("/");
      // URL keeps the path percent-encoded, so the placeholder must be
      // encoding-safe: "<redacted>" would surface as "%3Credacted%3E".
      if (parts[1]?.startsWith("bot")) parts[1] = "bot-REDACTED";
      u.pathname = parts.join("/");
    }
    return u.toString();
  } catch {
    return "<invalid url>";
  }
}

export function channelConfig(channel, env = process.env) {
  const norm = String(channel || "").toLowerCase();
  if (norm === "telegram") {
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return null;
    return {
      url: `https://api.telegram.org/bot${token}/sendMessage`,
      headers: { "content-type": "application/json" },
      auth: "url-token",
    };
  }
  if (norm === "discord") {
    const url = env.DISCORD_WEBHOOK_URL;
    return url ? { url, headers: { "content-type": "application/json" } } : null;
  }
  if (norm === "slack") {
    const url = env.SLACK_WEBHOOK_URL;
    return url ? { url, headers: { "content-type": "application/json" } } : null;
  }
  if (norm === "webhook") {
    const url = env.ALERT_WEBHOOK_URL;
    if (!url) return null;
    const headers = { "content-type": "application/json" };
    if (env.ALERT_WEBHOOK_SECRET) headers["x-alert-secret"] = env.ALERT_WEBHOOK_SECRET;
    return { url, headers };
  }
  return null;
}

/**
 * Send one alert to one channel.
 *
 * Returns status:
 *   sent         2xx from the provider
 *   failed       reached the provider (or tried to) and it did not accept
 *   unconfigured no credentials for this channel in the environment
 *   blocked      the configured URL failed the safety guard
 *
 * There is deliberately no "delivered": only the provider can say that, and the
 * closest we can honestly get is "it returned 2xx".
 */
export async function dispatch(channel, payload, { env = process.env, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const cfg = channelConfig(channel, env);
  if (!cfg) {
    return {
      channel,
      status: "unconfigured",
      httpStatus: null,
      detail: `no credentials for ${channel} (set ${channel === "telegram" ? "TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID" : channel.toUpperCase() + "_WEBHOOK_URL"})`,
    };
  }

  let url;
  try {
    url = assertDeliverableUrl(cfg.url);
  } catch (err) {
    return { channel, status: "blocked", httpStatus: null, detail: err.message };
  }

  const body = buildBody(channel, payload, env);

  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      channel,
      status: "failed",
      httpStatus: null,
      detail: `${err?.name === "TimeoutError" ? "timeout" : "network error"} posting to ${redactUrl(url)}: ${err?.cause?.code || err?.message || "unknown"}`,
    };
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return {
      channel,
      status: "failed",
      httpStatus: res.status,
      detail: `${redactUrl(url)} returned ${res.status}: ${text.slice(0, 200)}`,
    };
  }

  // Telegram returns 200 with {ok:false} for some errors. A 2xx is not proof.
  if (channel === "telegram") {
    try {
      const json = JSON.parse(text);
      if (json.ok === false) {
        return { channel, status: "failed", httpStatus: res.status, detail: `telegram rejected: ${json.description || "ok:false"}` };
      }
    } catch {
      return { channel, status: "failed", httpStatus: res.status, detail: "telegram returned 2xx with a non-JSON body" };
    }
  }

  return { channel, status: "sent", httpStatus: res.status, detail: null };
}

function buildBody(channel, payload, env) {
  const norm = String(channel).toLowerCase();
  if (norm === "telegram") {
    return {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: payload.text,
      parse_mode: payload.parse_mode || "MarkdownV2",
      link_preview_options: { is_disabled: payload.disable_web_page_preview !== false },
    };
  }
  if (norm === "discord") return { content: payload.content, embeds: payload.embeds };
  if (norm === "slack") return { text: payload.text, blocks: payload.blocks };
  return payload;
}

// Dispatch a batch of triggered results, one entry per channel, so a broken
// channel does not suppress the others.
export async function dispatchResults(results, opts = {}) {
  const out = [];
  for (const result of results) {
    const payload = payloadFor(result.channel, result, opts.message);
    out.push({ ruleId: result.ruleId, ...(await dispatch(result.channel, payload, opts)) });
  }
  return out;
}
