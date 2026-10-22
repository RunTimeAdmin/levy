// Page script for checkout.html, kept out of the HTML so the Content-Security-Policy
// can forbid inline scripts. Loaded after the shared helpers it uses.
const $ = (id) => document.getElementById(id);
const usdc = (units) => LevyWallet.usdcText(units); // exact, never rounded to cents
// The checkout names cycles for a customer ("every month (30 days)").
const CYCLE_NAMES = { 604800: "week", 2592000: "month (30 days)", 7776000: "quarter (90 days)", 31536000: "year" };
const every = (sec) => LevyFormat.every(sec, CYCLE_NAMES);
const { date, externalLink } = LevyFormat;
function status(text, cls = "") { $("status").textContent = text; $("status").className = cls; }
/** Replaces "Loading plan..." (and its spinner) with why the plan cannot be shown. */
function planMsg(text) { $("planMsg").textContent = text; $("planMsg").className = "muted"; }
function row(dl, term, value, mono) {
  const dt = document.createElement("dt"); dt.textContent = term;
  const dd = document.createElement("dd"); dd.textContent = value; if (mono) dd.className = "mono";
  dl.append(dt, dd);
}

let cfg, plan, account, ref, approved = false;

/**
 * Transactions this page sent for this plan and wallet, kept across reloads:
 * { approveTarget, approveHash, subscribeHash, at }. A subscribe whose result
 * is unknown must never be sent again blind (it could create a second paid
 * subscription), and an approval is a fixed total, so a retry cannot add the
 * cycles twice. Kept for a day.
 */
const pendingKey = () => `levy-checkout:${cfg.chainId}:${plan.planId}:${account.toLowerCase()}`;
function loadPending() {
  try {
    const p = JSON.parse(localStorage.getItem(pendingKey()) || "null");
    return p && Date.now() - p.at < 86_400_000 ? p : {};
  } catch { return {}; }
}
function savePending(p) {
  try { localStorage.setItem(pendingKey(), JSON.stringify({ ...p, at: Date.now() })); } catch {}
}
function clearPending() {
  try { localStorage.removeItem(pendingKey()); } catch {}
}

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
    // Something sent from this page earlier (before a reload, say): settle it first.
    const p = loadPending();
    if (p.subscribeHash || p.approveHash) {
      await refreshWallet();
      $("connect").hidden = true;
      $("go").hidden = false;
      if (p.approveHash) $("cycles").disabled = true;
      await checkPending();
      return;
    }
    const { bal } = await refreshWallet();
    $("connect").hidden = true;
    $("go").hidden = false;
    if (plan.trialSeconds === 0 && bal < BigInt(plan.price)) {
      status(`Your USDC balance does not cover the first charge (${usdc(plan.price)}), which is due today.`, "warn");
      const faucet = LevyWallet.faucet(cfg.chainId);
      if (faucet) {
        $("status").append(" ", externalLink(faucet, "Get test USDC"), " (choose Arc Testnet), then connect again.");
        $("connect").hidden = false;
        $("go").hidden = true;
      }
      $("go").disabled = true;
    } else {
      status("");
      $("go").disabled = false;
    }
  } catch (e) { status(e.message || String(e), "bad"); }
};

$("go").onclick = async () => {
  if (!approved && cycles() === null) { status("Enter a whole number of billing cycles from 1 to 120.", "bad"); return; }
  $("go").disabled = true;
  try {
    let p = loadPending();
    if (!approved) {
      // The total is fixed when the approval is sent; approve() sets the
      // allowance to it, so sending the same approval again changes nothing.
      const { allow } = await refreshWallet();
      const total = allow + BigInt(plan.price) * BigInt(cycles());
      status("Step 1 of 2: approve the USDC allowance in your wallet...", "busy");
      await LevyWallet.approve(account, cfg.usdcAddress, cfg.managerAddress, total, (hash) => {
        p = { ...p, approveTarget: total.toString(), approveHash: hash };
        savePending(p);
        $("cycles").disabled = true;
      });
      approved = true; // a retry after a failed subscribe must not approve again
      await refreshWallet();
    }
    status("Step 2 of 2: confirm the subscription in your wallet...", "busy");
    const result = await LevyWallet.subscribe(account, cfg.managerAddress, plan.planId, ref.hex, (hash) => {
      p = { ...p, subscribeHash: hash };
      savePending(p);
    });
    clearPending();
    await subscribed(result);
  } catch (e) {
    if (e.unknown) { unknownOutcome(e.hash); return; } // Subscribe stays disabled until checked
    if (e.failed) forget(e.hash);
    status(e.message || String(e), "bad");
    $("go").disabled = false;
    $("go").textContent = approved ? "Subscribe" : "Approve and subscribe";
  }
};

async function subscribed(result) {
  status("Subscribed. Loading your receipt...", "busy");
  const allow = await LevyWallet.allowance(cfg.usdcAddress, account, cfg.managerAddress).catch(() => null);
  try {
    showReceipt(result, allow);
  } catch {
    // Subscribed either way: never fall through to the error path, which re-enables Subscribe.
    status(`Subscribed${result.subId ? `: subscription #${result.subId}` : ""}. Transaction ${result.txHash}.`, "ok");
    $("go").hidden = true;
  }
}

/** Drops a transaction that failed on-chain from the record: it changed nothing. */
function forget(hash) {
  const p = loadPending();
  if (p.subscribeHash === hash) delete p.subscribeHash;
  if (p.approveHash === hash) { delete p.approveHash; delete p.approveTarget; $("cycles").disabled = false; }
  if (p.subscribeHash || p.approveHash) savePending(p); else clearPending();
}

/**
 * Reads how the recorded transactions ended. A confirmed subscribe shows the
 * receipt; a confirmed approval moves on to step 2; a failed one is forgotten
 * so the customer can try again; one still unknown keeps Subscribe disabled.
 */
async function checkPending() {
  const p = loadPending();
  const hash = p.subscribeHash || p.approveHash;
  if (!hash) return;
  status("Checking the transaction you sent earlier...", "busy");
  const r = await LevyWallet.receipt(hash);
  if (!r) { unknownOutcome(hash); return; }
  if (r.status !== "0x1") {
    forget(hash);
    status("That transaction failed on-chain, so nothing changed. You can try again.", "warn");
    $("go").disabled = false;
    $("go").textContent = approved ? "Subscribe" : "Approve and subscribe";
    return;
  }
  if (hash === p.subscribeHash) {
    clearPending();
    await subscribed(LevyWallet.subscribedFrom(r, cfg.managerAddress));
    return;
  }
  approved = true; // the approval landed: only the subscription is left
  await refreshWallet();
  status("Your approval is confirmed. Now confirm the subscription.", "ok");
  $("go").disabled = false;
  $("go").textContent = "Subscribe";
}

/** The wallet sent it but its result is not known yet: never invite a blind retry. */
function unknownOutcome(hash) {
  status("Your transaction was sent, but its result is not confirmed yet. Do not pay again until it is. ", "warn");
  const url = LevyWallet.txUrl(cfg.chainId, hash);
  if (url) $("status").append(externalLink(url, "See it on the explorer"), " ");
  const again = document.createElement("button");
  again.className = "ghost small";
  again.textContent = "Check again";
  again.onclick = () => { again.disabled = true; checkPending(); };
  $("status").append(again);
  $("go").disabled = true;
}

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
    dd.append(externalLink(url, txHash));
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
