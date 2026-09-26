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
  if (!planId || !/^\d+$/.test(planId)) { $("planMsg").textContent = "No plan in the link. Ask the merchant for their checkout link."; return; }
  ref = parseRef(params.get("ref"));
  if (!ref) { $("planMsg").textContent = "This checkout link has an invalid reference. Ask the merchant for a new link."; return; }
  const [config, plans] = await Promise.all([
    fetch("/api/config").then((r) => r.json()),
    fetch("/api/plans").then((r) => r.json()),
  ]);
  cfg = config;
  plan = plans.find((p) => p.planId === planId);
  if (!plan) { $("planMsg").textContent = `Plan #${planId} was not found.`; return; }
  if (!cfg.managerAddress || !cfg.usdcAddress) { $("planMsg").textContent = "Checkout is not configured on this server yet."; return; }

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
  row(dl, "Network", `chain ${cfg.chainId}`);
  card.append(h, p, dl);
  $("pay").hidden = false;
  showBudget();
}

function cycles() { return Math.max(1, Math.min(120, Math.trunc(+$("cycles").value) || 12)); }
function showBudget() { $("budget").textContent = `= ${usdc(BigInt(plan.price) * BigInt(cycles()))} USDC`; }
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
    status("Connecting...");
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
  $("go").disabled = true;
  try {
    if (!approved) {
      const { allow } = await refreshWallet();
      const total = allow + BigInt(plan.price) * BigInt(cycles());
      status("Step 1 of 2: approve the USDC allowance in your wallet...");
      await LevyWallet.approve(account, cfg.usdcAddress, cfg.managerAddress, total);
      approved = true; // a retry after a failed subscribe must not approve again
      await refreshWallet();
    }
    status("Step 2 of 2: confirm the subscription in your wallet...");
    const { subId, txHash } = await LevyWallet.subscribe(account, cfg.managerAddress, plan.planId, ref.hex);
    const done = document.createElement("span");
    done.textContent = `Subscribed${subId ? `: subscription #${subId}` : ""}. `;
    const portal = document.createElement("a"); portal.href = "/portal.html"; portal.textContent = "Manage it in the portal";
    done.append(portal);
    const base = LevyWallet.explorer(cfg.chainId);
    if (base) {
      const tx = document.createElement("a"); tx.href = `${base}/tx/${txHash}`; tx.textContent = "transaction";
      tx.target = "_blank"; tx.rel = "noopener";
      done.append(" · ", tx);
    }
    $("status").replaceChildren(done);
    $("status").className = "ok";
    $("go").hidden = true;
    $("cycles").disabled = true;
    await refreshWallet();
  } catch (e) {
    status(e.message || String(e), "bad");
    $("go").disabled = false;
    $("go").textContent = approved ? "Subscribe" : "Approve and subscribe";
  }
};

init().catch((e) => { $("planMsg").textContent = "Could not load the plan: " + (e.message || e); });
