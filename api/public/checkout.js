// Page script for checkout.html, kept out of the HTML so the Content-Security-Policy
// can forbid inline scripts. Loaded after the shared helpers it uses.
const $ = (id) => document.getElementById(id);
const usdc = (units) => {
  const v = BigInt(units);
  return `$${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
};
const every = (sec) => ({ 604800: "week", 2592000: "month (30 days)", 7776000: "quarter (90 days)", 31536000: "year" })[sec]
  ?? `${+(sec / 86400).toFixed(2)} days`;
function status(text, cls = "") { $("status").textContent = text; $("status").className = cls; }
/** Replaces "Loading plan..." (and its spinner) with why the plan cannot be shown. */
function planMsg(text) { $("planMsg").textContent = text; $("planMsg").className = "muted"; }
const date = (sec) => new Date(sec * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
function row(dl, term, value, mono) {
  const dt = document.createElement("dt"); dt.textContent = term;
  const dd = document.createElement("dd"); dd.textContent = value; if (mono) dd.className = "mono";
  dl.append(dt, dd);
}

let cfg, plan, account, ref, approved = false;

/**
 * The merchant's reference from the link (?ref=), as bytes32: either 0x plus
 * 64 hex digits, or up to 31 printable ASCII characters (left-aligned,
 * zero-padded). Null when the link has none; undefined when it is invalid.
 */
function parseRef(raw) {
  const ZERO = "0x" + "0".repeat(64);
  if (raw === null || raw === "") return { hex: ZERO, label: null };
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return { hex: raw.toLowerCase(), label: raw };
  if (/^[\x20-\x7e]{1,31}$/.test(raw)) {
    const hex = [...raw].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    return { hex: "0x" + hex.padEnd(64, "0"), label: raw };
  }
  return undefined;
}

async function init() {
  const params = new URLSearchParams(location.search);
  const planId = params.get("plan");
  if (!planId || !/^\d+$/.test(planId)) { planMsg("No plan in the link. Ask the merchant for their checkout link."); return; }
  ref = parseRef(params.get("ref"));
  if (!ref) { planMsg("This checkout link has an invalid reference. Ask the merchant for a new link."); return; }
  const [config, plans] = await Promise.all([
    fetch("/api/config").then((r) => r.json()),
    fetch("/api/plans").then((r) => r.json()),
  ]);
  cfg = config;
  plan = plans.find((p) => p.planId === planId);
  if (!plan) { planMsg(`Plan #${planId} was not found.`); return; }
  if (!cfg.managerAddress || !cfg.usdcAddress) { planMsg("Checkout is not configured on this server yet."); return; }

  const card = $("plan");
  card.replaceChildren();
  const h = document.createElement("div"); h.className = "muted"; h.textContent = `Plan #${plan.planId}`;
  const p = document.createElement("div"); p.className = "price"; p.textContent = usdc(plan.price) + " ";
  const s = document.createElement("small"); s.textContent = `USDC every ${every(plan.cycleSeconds)}`; p.append(s);
  const dl = document.createElement("dl");
  const trialDays = plan.trialSeconds / 86400;
  row(dl, "First charge", plan.trialSeconds > 0
    ? `after a ${+trialDays.toFixed(2)}-day free trial` : "today, when you subscribe");
  row(dl, "Merchant", plan.merchant, true);
  if (ref.label) row(dl, "Reference", ref.label, true);
  row(dl, "Levy contract", cfg.managerAddress, true);
  row(dl, "Network", LevyWallet.chainName(cfg.chainId));
  card.append(h, p, dl);
  $("pay").hidden = false;
  showBudget();
}

/** The cycles field as a whole number from 1 to 120, or null when it is not one. */
function cycles() {
  const v = $("cycles").value.trim();
  return /^\d+$/.test(v) && +v >= 1 && +v <= 120 ? +v : null;
}
function showBudget() {
  const n = cycles();
  $("budget").textContent = n === null ? "Enter a whole number from 1 to 120." : `= ${usdc(BigInt(plan.price) * BigInt(n))} USDC`;
  $("budget").className = n === null ? "invalid" : "muted";
}
$("cycles").oninput = showBudget;

async function refreshWallet() {
  const [bal, allow] = await Promise.all([
    LevyWallet.balanceOf(cfg.usdcAddress, account),
    LevyWallet.allowance(cfg.usdcAddress, account, cfg.managerAddress),
  ]);
  $("account").textContent = account;
  $("balance").textContent = usdc(bal);
  $("allowanceNow").textContent = usdc(allow);
  $("walletInfo").hidden = false;
  return { bal, allow };
}

$("connect").onclick = async () => {
  try {
    status("Connecting to your wallet...", "busy");
    account = await LevyWallet.connect(cfg.chainId);
    const { bal } = await refreshWallet();
    $("connect").hidden = true;
    $("go").hidden = false;
    if (plan.trialSeconds === 0 && bal < BigInt(plan.price)) {
      status(`Your USDC balance does not cover the first charge (${usdc(plan.price)}), which is due today.`, "warn");
      $("go").disabled = true;
    } else {
      status("");
    }
  } catch (e) { status(e.message || String(e), "bad"); }
};

$("go").onclick = async () => {
  if (cycles() === null) { status("Enter a whole number of billing cycles from 1 to 120.", "bad"); return; }
  $("go").disabled = true;
  try {
    if (!approved) {
      const { allow } = await refreshWallet();
      const total = allow + BigInt(plan.price) * BigInt(cycles());
      status("Step 1 of 2: approve the USDC allowance in your wallet...", "busy");
      await LevyWallet.approve(account, cfg.usdcAddress, cfg.managerAddress, total);
      approved = true; // a retry after a failed subscribe must not approve again
      await refreshWallet();
    }
    status("Step 2 of 2: confirm the subscription in your wallet...", "busy");
    const result = await LevyWallet.subscribe(account, cfg.managerAddress, plan.planId, ref.hex);
    status("Subscribed. Loading your receipt...", "busy");
    const allow = await LevyWallet.allowance(cfg.usdcAddress, account, cfg.managerAddress).catch(() => null);
    try {
      showReceipt(result, allow);
    } catch {
      // Subscribed either way: never fall through to the error path, which re-enables Subscribe.
      status(`Subscribed${result.subId ? `: subscription #${result.subId}` : ""}. Transaction ${result.txHash}.`, "ok");
      $("go").hidden = true;
    }
  } catch (e) {
    status(e.message || String(e), "bad");
    $("go").disabled = false;
    $("go").textContent = approved ? "Subscribe" : "Approve and subscribe";
  }
};

/**
 * Replaces the plan and payment cards with a receipt: what was bought, what was
 * paid and when the next charge is, and the transaction as the on-chain record.
 */
function showReceipt({ subId, nextChargeAt, txHash }, allow) {
  const box = $("receipt");
  const head = document.createElement("div"); head.className = "receipt-head";
  const tick = document.createElement("span"); tick.className = "tick"; tick.setAttribute("aria-hidden", "true"); tick.textContent = "✓";
  const h = document.createElement("h2"); h.textContent = "You're subscribed";
  head.append(tick, h);

  // Subscribed carries the first charge time; if its log was not found, estimate it.
  const next = nextChargeAt ?? Math.floor(Date.now() / 1000) + (plan.trialSeconds || plan.cycleSeconds);
  const dl = document.createElement("dl");
  row(dl, "Subscription", subId ? `#${subId}` : "created (see the transaction)");
  row(dl, "Plan", `#${plan.planId}, ${usdc(plan.price)} USDC every ${every(plan.cycleSeconds)}`);
  if (plan.trialSeconds > 0) {
    row(dl, "First charge", `${usdc(plan.price)} USDC on ${date(next)}, when the free trial ends`);
  } else {
    row(dl, "Paid today", `${usdc(plan.price)} USDC`);
    row(dl, "Next charge", date(next));
  }
  row(dl, "Merchant", plan.merchant, true);
  if (ref.label) row(dl, "Reference", ref.label, true);
  if (allow !== null) {
    const left = allow / BigInt(plan.price);
    row(dl, "Allowance left", `${usdc(allow)} USDC, enough for ${left} more charge${left === 1n ? "" : "s"} at this price`);
  }
  const dt = document.createElement("dt"); dt.textContent = "Transaction";
  const dd = document.createElement("dd"); dd.className = "mono";
  const url = LevyWallet.txUrl(cfg.chainId, txHash);
  if (url) {
    const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = txHash;
    dd.append(a);
  } else {
    dd.textContent = txHash;
  }
  dl.append(dt, dd);

  const actions = document.createElement("div"); actions.className = "actions";
  const portal = document.createElement("a"); portal.className = "button"; portal.href = "/portal.html"; portal.textContent = "Manage in the portal";
  actions.append(portal);
  const note = document.createElement("p"); note.className = "note";
  note.textContent = "The transaction is your receipt: it is the on-chain record of this subscription and payment. Pause or cancel any time from the portal.";

  box.replaceChildren(head, dl, actions, note);
  $("plan").hidden = true;
  $("pay").hidden = true;
  box.hidden = false;
  box.scrollIntoView({ block: "start" });
}

init().catch((e) => { planMsg("Could not load the plan: " + (e.message || e)); });
