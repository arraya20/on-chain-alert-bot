// Payload construction per channel.
//
// Telegram is the one that bites: MarkdownV2 requires 18 characters to be
// backslash-escaped, and the escaping is only correct if parse_mode is
// MarkdownV2. A payload built with MarkdownV2 escapes but sent as legacy
// "Markdown" renders the backslashes literally, so a rule named
// "USDC (paused)" arrives as "USDC \(paused\)".

const MDV2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text) {
  return String(text ?? "").replace(MDV2_RESERVED, (c) => "\\" + c);
}

export function explorerTx(hash) {
  return `https://www.pharosscan.xyz/tx/${hash}`;
}

// The plain-text form is the source of truth; channel payloads derive from it
// so every channel reports the same numbers.
export function plainMessage(result, { network = "Pharos Pacific (1672)", at = new Date().toISOString() } = {}) {
  const lines = [];
  const label = result.state === "TRIGGERED" ? "TRIGGERED" : result.state;
  lines.push(`[${label}] ${result.name}`);
  lines.push(`network  ${network}`);
  if (result.target) lines.push(`target   ${result.target}`);
  lines.push(`observed ${result.observedFormatted}   (rule: ${result.comparator} ${result.thresholdFormatted})`);
  if (result.detail?.largest?.txHash) lines.push(`tx       ${explorerTx(result.detail.largest.txHash)}`);
  if (result.why) lines.push(`why      ${result.why}`);
  lines.push(`at       ${at}`);
  if (result.state === "ERROR") lines.push(`error    ${result.error?.kind}: ${result.error?.message}`);
  return lines.join("\n");
}

export function payloadFor(channel, result, opts = {}) {
  const at = opts.at || new Date().toISOString();
  const network = opts.network || "Pharos Pacific (1672)";
  const norm = String(channel || "webhook").toLowerCase();

  if (norm === "telegram") {
    const text = [
      `*${escapeMarkdownV2(result.state === "TRIGGERED" ? "ALERT" : result.state)}* \\| ${escapeMarkdownV2(result.name)}`,
      "",
      `*observed* \`${escapeMarkdownV2(result.observedFormatted)}\``,
      `*rule* \`${escapeMarkdownV2(result.comparator + " " + result.thresholdFormatted)}\``,
      result.target ? `*target* \`${escapeMarkdownV2(result.target)}\`` : null,
      result.detail?.largest?.txHash ? `*tx* [${escapeMarkdownV2(result.detail.largest.txHash.slice(0, 12) + "…")}](${explorerTx(result.detail.largest.txHash)})` : null,
      "",
      `_${escapeMarkdownV2(network)} · ${escapeMarkdownV2(at)}_`,
    ]
      .filter((l) => l !== null)
      .join("\n");

    return { channel: "telegram", parse_mode: "MarkdownV2", text, disable_web_page_preview: true };
  }

  if (norm === "discord") {
    return {
      channel: "discord",
      content: result.state === "TRIGGERED" ? `**${result.name}**` : undefined,
      embeds: [
        {
          title: result.name,
          description: result.why || undefined,
          color: result.severity === "critical" ? 0xd93025 : 0xe8a33d,
          fields: [
            { name: "State", value: result.state, inline: true },
            { name: "Observed", value: result.observedFormatted, inline: true },
            { name: "Rule", value: `${result.comparator} ${result.thresholdFormatted}`, inline: true },
            ...(result.target ? [{ name: "Target", value: `\`${result.target}\``, inline: false }] : []),
            ...(result.detail?.largest?.txHash ? [{ name: "Transaction", value: explorerTx(result.detail.largest.txHash), inline: false }] : []),
          ],
          footer: { text: `${network} · ${at}` },
        },
      ],
    };
  }

  if (norm === "slack") {
    return {
      channel: "slack",
      text: `${result.state}: ${result.name} — ${result.observedFormatted}`,
      blocks: [
        { type: "header", text: { type: "plain_text", text: `${result.state} · ${result.name}`, emoji: false } },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Observed*\n\`${result.observedFormatted}\`` },
            { type: "mrkdwn", text: `*Rule*\n\`${result.comparator} ${result.thresholdFormatted}\`` },
          ],
        },
        ...(result.target ? [{ type: "context", elements: [{ type: "mrkdwn", text: `target \`${result.target}\` · ${network}` }] }] : []),
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
      comparator: result.comparator,
      threshold: result.threshold,
      thresholdFormatted: result.thresholdFormatted,
      txHash: result.detail?.largest?.txHash ?? null,
      error: result.error ?? null,
      network,
      at,
    },
  };
}
