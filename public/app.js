// Renders exactly what /api/alert returns. It does not decide anything: no
// thresholds are compared here, no state is inferred, and nothing is shown when
// the request fails. A dashboard that computes its own verdict can disagree
// with the watcher, and then two honest-looking pages tell different stories.

const els = {
  chainId: document.getElementById("chainId"),
  headBlock: document.getElementById("headBlock"),
  banner: document.getElementById("banner"),
  window: document.getElementById("window"),
  evaluate: document.getElementById("evaluate"),
  auto: document.getElementById("auto"),
  stamp: document.getElementById("stamp"),
  summary: document.getElementById("summary"),
  cTriggered: document.getElementById("cTriggered"),
  cOk: document.getElementById("cOk"),
  cError: document.getElementById("cError"),
  cRange: document.getElementById("cRange"),
  cAt: document.getElementById("cAt"),
  rules: document.getElementById("rules"),
  rows: document.getElementById("rows"),
  empty: document.getElementById("empty"),
  rpcHost: document.getElementById("rpcHost"),
};

const EXPLORER = "https://www.pharosscan.xyz";
let timer = null;
let inFlight = false;

function num(n) {
  return typeof n === "number" ? n.toLocaleString("en-US") : String(n ?? "—");
}

function clearTable() {
  els.rows.replaceChildren();
  els.rules.hidden = true;
  els.summary.hidden = true;
}

function showEmpty(text) {
  els.empty.textContent = text;
  els.empty.hidden = false;
}

function showBanner(html) {
  els.banner.replaceChildren(...html);
  els.banner.hidden = false;
}

function hideBanner() {
  els.banner.hidden = true;
  els.banner.replaceChildren();
}

// Built as nodes, never as an HTML string: rule names and error text come off
// the wire and must never be able to inject markup.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderRow(result) {
  const tr = el("tr");

  const stateTd = el("td");
  stateTd.append(el("span", `state ${result.state}`, result.state));
  tr.append(stateTd);

  const nameTd = el("td");
  nameTd.append(el("div", "rule-name", result.name));
  if (result.why) nameTd.append(el("span", "rule-why", result.why));

  if (result.evidence?.length) {
    const ul = el("ul", "evidence");
    for (const line of result.evidence) ul.append(el("li", null, line));
    nameTd.append(ul);
  }

  if (result.state === "ERROR" && result.error) {
    nameTd.append(el("p", "err-line", `${result.error.kind}: ${result.error.message}`));
  }
  if (result.state === "SKIPPED" && result.reason) {
    nameTd.append(el("p", "err-line", result.reason));
  }
  if (result.detail?.largest?.txHash) {
    const p = el("p", "evidence");
    const a = el("a", null, `tx ${result.detail.largest.txHash.slice(0, 14)}…`);
    a.href = `${EXPLORER}/tx/${result.detail.largest.txHash}`;
    a.target = "_blank";
    a.rel = "noreferrer";
    p.append(a);
    nameTd.append(p);
  }
  tr.append(nameTd);

  tr.append(el("td", "num", result.observedFormatted ?? (result.state === "ERROR" ? "not measured" : "—")));
  tr.append(el("td", "num", result.thresholdFormatted ? `${result.comparator} ${result.thresholdFormatted}` : "—"));

  const targetTd = el("td", "target");
  targetTd.textContent = result.target ?? "network-wide";
  tr.append(targetTd);

  return tr;
}

function render(payload) {
  hideBanner();
  els.empty.hidden = true;

  els.chainId.textContent = String(payload.chainId ?? "—");
  els.headBlock.textContent = num(payload.head ?? payload.blockRange?.to);
  els.cTriggered.textContent = num(payload.counts.triggered);
  els.cOk.textContent = num(payload.counts.ok);
  els.cError.textContent = num(payload.counts.error);
  els.cRange.textContent = `${num(payload.blockRange.from)}–${num(payload.blockRange.to)}`;
  els.cAt.textContent = new Date(payload.evaluatedAt).toLocaleTimeString();
  els.summary.hidden = false;

  els.rows.replaceChildren(...payload.results.map(renderRow));
  els.rules.hidden = false;
  els.stamp.textContent = `window ${payload.window} blocks · ${new Date(payload.evaluatedAt).toLocaleTimeString()}`;

  if (payload.degraded) {
    showBanner([
      el("strong", null, "Degraded. "),
      el("span", null, `${payload.counts.error} rule(s) could not be measured. Those are not reported as ok.`),
    ]);
  }
}

function renderError(err) {
  clearTable();
  showEmpty("No data. The evaluation failed, so nothing is shown.");
  const detail = `${err.kind || "error"}: ${err.message || "unknown"}`;
  showBanner([
    el("strong", null, "Chain read failed. "),
    el("span", null, "This page will not display a verdict it could not measure. "),
    el("code", null, detail),
  ]);
  els.stamp.textContent = "failed " + new Date().toLocaleTimeString();
}

async function load() {
  if (inFlight) return;
  inFlight = true;
  els.evaluate.disabled = true;
  try {
    const window = Math.max(1, Math.min(999, Number(els.window.value) || 60));
    els.window.value = String(window);
    const res = await fetch(`/api/alert?window=${window}`, { headers: { accept: "application/json" } });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.error) {
      renderError(body?.error || { kind: `http_${res.status}`, message: res.statusText || "request failed" });
      return;
    }
    if (body.network?.rpc) els.rpcHost.textContent = new URL(body.network.rpc).host;
    render(body);
  } catch (err) {
    renderError({ kind: "network", message: err.message });
  } finally {
    inFlight = false;
    els.evaluate.disabled = false;
  }
}

function syncAuto() {
  if (timer) clearInterval(timer);
  timer = null;
  if (els.auto.checked) timer = setInterval(load, 30_000);
}

els.evaluate.addEventListener("click", load);
els.auto.addEventListener("change", syncAuto);
els.window.addEventListener("change", load);

syncAuto();
load();
