// Payload construction per channel.
//
// Telegram is the one that bites: MarkdownV2 requires 18 characters to be
// backslash-escaped, and the escaping is only correct if parse_mode is
// MarkdownV2. A payload built with MarkdownV2 escapes but sent as legacy
// "Markdown" renders the backslashes literally, so a rule named
// "USDC (paused)" arrives as "USDC \(paused\)".
//
// Every channel must also survive a result that was never measured (state
// ERROR): no observed value, and a comparator that may be missing. Printing
// "undefined" or sending an empty Discord field value gets the whole message
// rejected, so the missing pieces are named explicitly here.

import { explorerTx, linkFor } from "./links.mjs";

export { explorerTx };

const MDV2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text) {
  return String(text ?? "").replace(MDV2_RESERVED, (c) => "\\" + c);
}

// Inside the (...) of a MarkdownV2 link only ")" and "\" need escaping.
function escapeMarkdownV2Url(url) {
  return String(url).replace(/[)\\]/g, (c) => "\\" + c);
}

const clip = (value, max) => {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
};

const present = (value, fallback) => {
  const text = value == null ? "" : String(value);
  return text.length > 0 ? text : fallback;
};

const observedText = (r) => present(r.observedFormatted, "not measured");

function ruleText(r) {
  if (r.comparator && r.thresholdFormatted != null) return `${r.comparator} ${r.thresholdFormatted}`;
  return present(r.thresholdFormatted, "n/a");
}

function errorText(r) {
  if (r.state !== "ERROR") return null;
  return clip(`${r.error?.kind ?? "error"}: ${r.error?.message ?? "unknown"}`, 300);
}

function partiesOf(r) {
  const l = r.detail?.largest;
  return l?.from ? { from: l.from, to: l.to ?? null } : null;
}

const linkOf = (r) => r.link ?? linkFor(r);

// The plain-text form is the source of truth; channel payloads derive from it
// so every channel reports the same numbers.
export function plainMessage(result, { network = "Pharos Pacific (1672)", at = new Date().toISOString() } = {}) {
  const lines = [];
  lines.push(`[${result.state}] ${result.name}`);
  lines.push(`network  ${network}`);
  if (result.target) lines.push(`target   ${result.target}`);
  lines.push(`observed ${observedText(result)}   (rule: ${ruleText(result)})`);
  const parties = partiesOf(result);
  if (parties) {
    lines.push(`from     ${parties.from}`);
    if (parties.to) lines.push(`to       ${parties.to}`);
  }
  const link = linkOf(result);
  if (link) lines.push(`${result.detail?.largest?.txHash ? "tx      " : "link    "} ${link.url}`);
  if (result.why) lines.push(`why      ${result.why}`);
  lines.push(`at       ${at}`);
  const err = errorText(result);
  if (err) lines.push(`error    ${err}`);
  return lines.join("\n");
}

const COLOR = { critical: 0xd93025, warning: 0xe8a33d, error: 0x6b7280 };

export function payloadFor(channel, result, opts = {}) {
  const at = opts.at || new Date().toISOString();
  const network = opts.network || "Pharos Pacific (1672)";
  const norm = String(channel || "webhook").toLowerCase();
  const link = linkOf(result);
  const parties = partiesOf(result);
  const err = errorText(result);

  if (norm === "telegram") {
    const text = [
      `*${escapeMarkdownV2(result.state === "TRIGGERED" ? "ALERT" : result.state)}* \\| ${escapeMarkdownV2(result.name)}`,
      "",
      `*observed* \`${escapeMarkdownV2(observedText(result))}\``,
      `*rule* \`${escapeMarkdownV2(ruleText(result))}\``,
      result.target ? `*target* \`${escapeMarkdownV2(result.target)}\`` : null,
      parties ? `*from* \`${escapeMarkdownV2(parties.from)}\`` : null,
      parties?.to ? `*to* \`${escapeMarkdownV2(parties.to)}\`` : null,
      link ? `*link* [${escapeMarkdownV2(link.label)}](${escapeMarkdownV2Url(link.url)})` : null,
      err ? `*error* \`${escapeMarkdownV2(err)}\`` : null,
      "",
      `_${escapeMarkdownV2(network)} · ${escapeMarkdownV2(at)}_`,
    ]
      .filter((l) => l !== null)
      .join("\n");

    return { channel: "telegram", parse_mode: "MarkdownV2", text, disable_web_page_preview: true };
  }

  if (norm === "discord") {
    // Discord rejects the whole embed if any field value is empty, so every
    // value goes through present()/clip().
    return {
      channel: "discord",
      content: result.state === "TRIGGERED" ? `**${clip(result.name, 200)}**` : undefined,
      embeds: [
        {
          title: clip(present(result.name, "alert"), 250),
          description: result.why ? clip(result.why, 1000) : undefined,
          color: result.state === "ERROR" ? COLOR.error : result.severity === "critical" ? COLOR.critical : COLOR.warning,
          fields: [
            { name: "State", value: present(result.state, "n/a"), inline: true },
            { name: "Observed", value: clip(observedText(result), 1000), inline: true },
            { name: "Rule", value: clip(ruleText(result), 1000), inline: true },
            ...(result.target ? [{ name: "Target", value: `\`${result.target}\``, inline: false }] : []),
            ...(parties ? [{ name: "From", value: `\`${parties.from}\``, inline: false }] : []),
            ...(parties?.to ? [{ name: "To", value: `\`${parties.to}\``, inline: false }] : []),
            ...(link ? [{ name: "Link", value: link.url, inline: false }] : []),
            ...(err ? [{ name: "Error", value: clip(err, 1000), inline: false }] : []),
          ],
          footer: { text: `${network} · ${at}` },
        },
      ],
    };
  }

  if (norm === "slack") {
    return {
      channel: "slack",
      text: `${result.state}: ${result.name} — ${observedText(result)}`,
      blocks: [
        { type: "header", text: { type: "plain_text", text: clip(`${result.state} · ${result.name}`, 150), emoji: false } },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Observed*\n\`${observedText(result)}\`` },
            { type: "mrkdwn", text: `*Rule*\n\`${ruleText(result)}\`` },
          ],
        },
        ...(result.target ? [{ type: "context", elements: [{ type: "mrkdwn", text: `target \`${result.target}\` · ${network}` }] }] : []),
        ...(link ? [{ type: "section", text: { type: "mrkdwn", text: `<${link.url}|${link.label}>` } }] : []),
        ...(err ? [{ type: "section", text: { type: "mrkdwn", text: `*Error*\n\`${err}\`` } }] : []),
      ],
    };
  }

  return {
    channel: "webhook",
    event: "pharos.alert",
    data: {
      state: result.state,
      ruleId: result.ruleId,
      name: result.name,
      severity: result.severity,
      metric: result.metric ?? null,
      target: result.target ?? null,
      observed: result.observed ?? null,
      observedFormatted: result.observedFormatted ?? null,
      comparator: result.comparator ?? null,
      threshold: result.threshold,
      thresholdFormatted: result.thresholdFormatted,
      from: parties?.from ?? null,
      to: parties?.to ?? null,
      txHash: result.detail?.largest?.txHash ?? null,
      link: link?.url ?? null,
      error: result.error ?? null,
      network,
      at,
    },
  };
}
