// Page script for index.html, kept out of the HTML so the Content-Security-Policy
// can forbid inline scripts. Loaded after the shared helpers it uses.
const $ = (id) => document.getElementById(id);

const EVENTS = ["subscription.created","subscription.updated","charge.succeeded","charge.failed","dunning.started","subscription.paused","subscription.resumed","subscription.cancelled","invoice.ready","allowance.low","subscription.completed","subscription.transferred","merchant.updated"];
$("hookEvents").innerHTML = EVENTS.map(e =>
  `<label><input type="checkbox" value="${e}" checked> ${e}</label>`).join("");

const short = (a) => a ? a.slice(0, 6) + "..." + a.slice(-4) : "";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// USDC amounts arrive as 6-decimal strings ("29.000000"). Show cents, and
// further digits only when they are not zero, so no amount is misstated.
const usd = (s) => "$" + s.replace(/(\.\d\d\d*?)0+$/, "$1");
const units = (v) => { const b = BigInt(v); return `${b / 1_000_000n}.${(b % 1_000_000n).toString().padStart(6, "0")}`; };
const every = (sec) => ({ 86400: "day", 604800: "week", 2592000: "30 days", 7776000: "90 days", 31536000: "year" })[sec]
  ?? `${+(sec / 86400).toFixed(2)} days`;
// The signed-in wallet, which sends every transaction, and the merchant account
// it is acting for: its own unless it handed that on, or one handed to it.
const merchant = () => LevyAuth.address;
let account = null;
let accounts = { owned: [], offered: [] };
const api = (p, opts) => LevyAuth.api(p, opts);
let cfg = {}; // chain id and contract addresses from /api/config
const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(v);
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";
function txCell(hash) {
  const url = LevyWallet.txUrl(cfg.chainId, hash);
  return url ? `<a href="${url}" target="_blank" rel="noopener">${short(hash)}</a>` : short(hash);
}
const checkoutUrl = (planId) => `${location.origin}/checkout.html?plan=${planId}`;

function pill(text, cls) { return `<span class="pill ${cls || text}">${text}</span>`; }
// The subscription's merchant reference: readable text when it is ASCII
// (as the checkout encodes short refs), otherwise shortened hex.
function refText(ref) {
  if (!ref) return `<span class="muted">none</span>`;
  const bytes = ref.slice(2).match(/../g).map((h) => parseInt(h, 16));
  const end = bytes.findLastIndex((b) => b !== 0) + 1;
  const text = String.fromCharCode(...bytes.slice(0, end));
  return end > 0 && /^[\x20-\x7e]+$/.test(text) && bytes.slice(end).every((b) => b === 0)
    ? esc(text) : short(ref);
}
function line(el, text, cls = "") { el.textContent = text; el.className = `status-line ${cls}`; el.hidden = !text; }

/** Connect the wallet on Levy's chain and make sure it is the signed-in merchant. */
async function merchantWallet() {
  const wallet = await LevyWallet.connect(cfg.chainId);
  if (wallet.toLowerCase() !== merchant().toLowerCase()) {
    throw new Error(`Your wallet is on ${short(wallet)}; switch it to ${short(merchant())}, the account you signed in with.`);
  }
  return wallet;
}

function showSession() {
  const m = merchant();
  $("booting").hidden = true;
  // Signed out, the panel below has the sign-in button; the header shows the session only.
  $("session").hidden = !m;
  $("who").textContent = m ? short(m) : "";
  // Signed out, the panels would be empty shells: show one message instead.
  $("signedOut").hidden = !!m;
  $("app").hidden = !m;
}

// Placeholders while the panels load, so the page does not jump from empty to full.
function showLoading() {
  $("cards").innerHTML = `<div class="skeleton"></div>`.repeat(6);
  for (const id of ["plans", "subs", "dunning", "hooks", "invoices"]) $(id).innerHTML = `<p class="loading">Loading...</p>`;
}

async function load() {
  showSession();
  if (!merchant()) return;
  showLoading();
  cfg = await fetch("/api/config").then((r) => r.json());
  accounts = await api("/api/accounts");
  if (!accounts.owned.some((a) => same(a.account, account))) account = accounts.owned[0]?.account ?? null;
  renderAccount();
  $("accountData").hidden = !account;
  if (!account) return;
  const m = account;
  const subs = api(`/api/subscriptions?merchant=${m}`);
  await Promise.all([loadMetrics(m), loadPlans(m, subs), loadSubs(subs), loadDunning(m), loadHooks(m), loadInvoices(m)]);
}

// ---- merchant account ----

const you = (a) => (same(a, merchant()) ? `you (<span class="mono">${short(a)}</span>)` : `<span class="mono">${esc(a)}</span>`);

function renderAccount() {
  const pick = $("accountPick");
  pick.hidden = accounts.owned.length < 2;
  pick.innerHTML = accounts.owned.map((a) =>
    `<option value="${esc(a.account)}"${same(a.account, account) ? " selected" : ""}>${short(a.account)}</option>`).join("");
  const offered = accounts.offered.map((a) => `<div class="row">
      <span>The owner of merchant account <span class="mono">${esc(a.account)}</span> offered it to this wallet.</span>
      <button class="small" data-accept="${esc(a.account)}">Accept the account</button></div>`).join("");
  const a = accounts.owned.find((x) => same(x.account, account));
  if (!a) {
    $("account").innerHTML = offered + `<p class="empty">This wallet does not own a merchant account: it handed its own on. Sign in with the wallet that owns the account now.</p>`;
  } else {
    $("account").innerHTML = `<dl class="kv">
        <dt>Account</dt><dd class="mono">${esc(a.account)}</dd>
        <dt>Owner</dt><dd>${you(a.owner)}</dd>
        <dt>Payments go to</dt><dd>${a.payout ? `<span class="mono">${esc(a.payout)}</span> (fixed)` : `the owner, ${you(a.owner)}`}</dd>
        <dt>Handover</dt><dd>${a.pendingOwner ? `offered to <span class="mono">${esc(a.pendingOwner)}</span>, until it accepts` : `<span class="muted">none</span>`}</dd>
      </dl>
      <div class="account-actions">
        <div class="row"><input id="payoutAddr" placeholder="0x... payout address, for example a Safe" aria-label="Payout address" autocomplete="off">
          <button class="ghost small" id="setPayout">Set payout</button>
          ${a.payout ? `<button class="ghost small" id="followOwner">Pay the owner again</button>` : ""}</div>
        <div class="row"><input id="newOwner" placeholder="0x... wallet to hand the account to" aria-label="New owner" autocomplete="off">
          <button class="ghost small" id="handOver">Offer the account</button>
          ${a.pendingOwner ? `<button class="ghost small" id="withdrawOffer">Withdraw the offer</button>` : ""}</div>
      </div>${offered}`;
    $("setPayout").onclick = () => {
      const to = $("payoutAddr").value.trim();
      if (!isAddr(to)) return line($("accountStatus"), "Enter a 0x address with 40 hex digits.", "bad");
      ownerTx(`Send this account's payments to ${to} from the next charge? Check the address: a payment sent to a wrong address cannot be recovered.`,
        (from) => LevyWallet.setPayout(from, cfg.managerAddress, a.account, to), `Payments now go to ${short(to)}.`);
    };
    if ($("followOwner")) $("followOwner").onclick = () => ownerTx("Send this account's payments to its owner again, from the next charge?",
      (from) => LevyWallet.setPayout(from, cfg.managerAddress, a.account, ZERO), "Payments now go to the owner.");
    $("handOver").onclick = () => {
      const to = $("newOwner").value.trim();
      if (!isAddr(to)) return line($("accountStatus"), "Enter a 0x address with 40 hex digits.", "bad");
      ownerTx(`Offer this merchant account to ${to}? Nothing changes until that wallet accepts. Then it controls the account's plans, subscriptions, webhooks and payout, and this wallet loses access.`,
        (from) => LevyWallet.transferOwnership(from, cfg.managerAddress, a.account, to), `Offered to ${short(to)}; it takes over when it accepts.`);
    };
    if ($("withdrawOffer")) $("withdrawOffer").onclick = () => ownerTx("Withdraw the offer of this account?",
      (from) => LevyWallet.transferOwnership(from, cfg.managerAddress, a.account, ZERO), "Offer withdrawn.");
  }
  $("account").querySelectorAll("[data-accept]").forEach((b) => {
    b.onclick = () => ownerTx(`Take over merchant account ${b.dataset.accept}? This wallet will control its plans, subscriptions, webhooks and payout.`,
      (from) => LevyWallet.acceptOwnership(from, cfg.managerAddress, b.dataset.accept),
      "You own the account now. Check where its payments go in this panel: a fixed payout set by the previous owner stays until you change it.");
  });
}

$("accountPick").onchange = () => { account = $("accountPick").value; load(); };

/** One account transaction from the signed-in wallet; the panel catches up at Levy's next sync. */
async function ownerTx(question, send, done) {
  if (!confirm(question)) return;
  const buttons = $("account").querySelectorAll("button");
  buttons.forEach((b) => { b.disabled = true; });
  try {
    line($("accountStatus"), "Confirm in your wallet...", "busy");
    await send(await merchantWallet());
    line($("accountStatus"), `Done on-chain. ${done} The dashboard shows it within a minute, after Levy's next sync.`, "ok");
  } catch (e) {
    line($("accountStatus"), e.message || String(e), "bad");
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

async function loadMetrics(m) {
  const d = await api(`/api/metrics?merchant=${m}`);
  const rate = d.successRate === null ? "n/a" : (d.successRate * 100).toFixed(1) + "%";
  $("cards").innerHTML = `
    <div class="card"><div class="label">MRR</div><div class="value">$${(+d.mrrUsdc).toFixed(2)}</div></div>
    <div class="card"><div class="label">Active subs</div><div class="value">${d.activeSubs}</div></div>
    <div class="card"><div class="label">Charge success</div><div class="value">${rate}</div></div>
    <div class="card"><div class="label">Dunning queue</div><div class="value">${d.dunningDepth}</div></div>
    <div class="card"><div class="label">Collected (all time)</div><div class="value">${usd(d.totalChargedUsdc)}</div></div>
    <div class="card"><div class="label">Past due / paused</div><div class="value">${d.pastDueSubs} / ${d.pausedSubs}</div></div>`;
}

// ---- plans ----

const LIVE = new Set(["trial", "active", "past_due"]);

async function loadPlans(m, subsP = api(`/api/subscriptions?merchant=${m}`)) {
  const [plans, subs] = await Promise.all([fetch("/api/plans").then((r) => r.json()), subsP]);
  const mine = plans.filter((p) => p.merchant.toLowerCase() === m.toLowerCase());
  $("linkTip").hidden = !mine.length;
  if (!mine.length) {
    $("plans").innerHTML = `<p class="empty">No plans yet. Create your first one below.</p>`;
    $("planForm").hidden = false;
    return mine;
  }
  $("plans").innerHTML = `<table><thead><tr>
    <th>Plan</th><th>Price</th><th>Terms</th><th>Free trial</th><th title="Failed payments before a subscription is past due; it pauses after twice as many">Past due after</th>
    <th title="Subscriptions on this plan that are trial, active or past due">Subscribers</th><th>Checkout link</th><th></th></tr></thead><tbody>` +
    mine.map((p) => {
      const onPlan = subs.filter((s) => s.planId === p.planId);
      const live = onPlan.filter((s) => LIVE.has(s.statusName)).length;
      return `<tr><td>#${p.planId}${p.retired ? ` ${pill("retired")}` : ""}</td>
        <td>${p.maxCycles === 1 ? `${usd(p.priceUsdc)} once` : `${usd(p.priceUsdc)} every ${every(p.cycleSeconds)}`}</td>
        <td>${termsText(p)}</td>
        <td>${p.trialSeconds ? `${+(p.trialSeconds / 86400).toFixed(2)} days` : `<span class="muted">none</span>`}</td>
        <td>${p.maxFailed} failed</td>
        <td title="${onPlan.length} in total">${live}</td>
        <td><div class="link-cell"><code>/checkout.html?plan=${p.planId}</code>
          <button class="ghost small" data-copy="${p.planId}">Copy</button>
          <a class="button ghost small" href="${checkoutUrl(p.planId)}" target="_blank" rel="noopener">Open</a></div></td>
        <td><button class="ghost small" data-retire="${p.planId}" data-retired="${p.retired ? 1 : 0}">${p.retired ? "Reopen" : "Retire"}</button></td></tr>`;
    }).join("") + `</tbody></table>`;
  $("plans").querySelectorAll("[data-copy]").forEach((b) => { b.onclick = () => copyLink(b, checkoutUrl(b.dataset.copy)); });
  $("plans").querySelectorAll("[data-retire]").forEach((b) => { b.onclick = () => retirePlan(b); });
  return mine;
}

/** The v2 terms of a plan in a few words. */
function termsText(p) {
  const parts = [];
  if (p.introCycles > 0) parts.push(`first ${p.introCycles} at ${usd(p.introPriceUsdc)}`);
  if (p.maxCycles > 0) parts.push(p.maxCycles === 1 ? "one payment" : `${p.maxCycles} payments`);
  if (p.transferable) parts.push("transferable");
  return parts.length ? parts.join(", ") : `<span class="muted">until cancelled</span>`;
}

async function retirePlan(button) {
  const id = button.dataset.retire;
  const retire = button.dataset.retired !== "1";
  if (!confirm(retire
    ? `Retire plan #${id}? New customers can no longer subscribe or switch to it, and its checkout link stops working. Current subscribers keep paying as before. You can reopen it later.`
    : `Reopen plan #${id} to new subscribers?`)) return;
  button.disabled = true;
  try {
    const from = await merchantWallet();
    await LevyWallet.setPlanRetired(from, cfg.managerAddress, id, retire);
    button.dataset.retired = retire ? "1" : "0";
    button.textContent = retire ? "Reopen" : "Retire";
    alert(`Plan #${id} is ${retire ? "retired" : "open again"} on-chain. The table shows it after Levy's next sync.`);
  } catch (e) {
    alert(e.message || String(e));
  } finally {
    button.disabled = false;
  }
}

async function copyLink(button, url) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    prompt("Copy the checkout link:", url); // clipboard blocked: let them copy it by hand
    return;
  }
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = label; }, 1500);
}

/** The plan form's values, or an error message. Limits are the contract's. */
function readPlanForm() {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec($("pfPrice").value.trim());
  const price = m ? BigInt(m[1]) * 1_000_000n + BigInt((m[2] || "").padEnd(6, "0")) : 0n;
  if (price <= 0n) return { error: "Enter a price in USDC, for example 29 or 29.50." };
  const preset = $("pfCycle").value;
  const days = preset === "custom" ? Number($("pfCustom").value) : Number(preset);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return { error: "The billing cycle must be a whole number of days from 1 to 3650." };
  const trial = Number($("pfTrial").value || 0);
  if (!Number.isInteger(trial) || trial < 0 || trial >= days) return { error: `The free trial must be a whole number of days, shorter than the cycle (${days} days).` };
  const maxFailed = Number($("pfMaxFailed").value);
  if (!Number.isInteger(maxFailed) || maxFailed < 1 || maxFailed > 255) return { error: "Failed payments before past due must be from 1 to 255." };
  const limit = $("pfMaxCycles").value.trim();
  const maxCycles = limit === "" ? 0 : Number(limit);
  if (!Number.isInteger(maxCycles) || maxCycles < 0 || maxCycles > 4294967295) return { error: "The number of payments must be a whole number, or blank for no limit." };
  const introText = $("pfIntroPrice").value.trim();
  const im = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(introText);
  if (introText && !im) return { error: "Enter the intro price in USDC, for example 1 or 0.50." };
  const introPrice = im ? BigInt(im[1]) * 1_000_000n + BigInt((im[2] || "").padEnd(6, "0")) : 0n;
  const introCycles = Number($("pfIntroCycles").value || 0);
  if (!Number.isInteger(introCycles) || introCycles < 0 || introCycles > 4294967295) return { error: "Payments at the intro price must be a whole number." };
  if (introCycles > 0 && introPrice === 0n) return { error: "Enter an intro price above zero, or set its payments to 0. For free time, use a free trial." };
  if (introCycles === 0 && introPrice > 0n) return { error: "Set how many payments the intro price applies to." };
  if (introCycles > 0 && introPrice >= price) return { error: "The intro price must be below the regular price." };
  if (maxCycles > 0 && introCycles > maxCycles) return { error: `Payments at the intro price cannot be more than the plan's ${maxCycles}.` };
  return {
    price, days, trial, maxFailed, cycleSeconds: days * 86400, trialSeconds: trial * 86400,
    maxCycles, introPrice, introCycles, transferable: $("pfTransferable").checked,
  };
}

function showPlanSummary() {
  const f = readPlanForm();
  if (f.error) { $("pfSummary").textContent = ""; return; }
  const s = (n) => (n === 1 ? "" : "s");
  $("pfSummary").textContent =
    `Customers pay ${usd(units(f.price))} USDC every ${every(f.cycleSeconds)}` +
    (f.trial ? `, after a ${f.trial}-day free trial. ` : ", starting the day they subscribe. ") +
    (f.introCycles ? `The first ${f.introCycles} payment${s(f.introCycles)} cost${f.introCycles === 1 ? "s" : ""} ${usd(units(f.introPrice))} each. ` : "") +
    (f.maxCycles === 1 ? "It is a single payment. " : f.maxCycles ? `It ends after ${f.maxCycles} payments. ` : "") +
    (f.transferable ? "Customers can move it to another wallet. " : "") +
    `After ${f.maxFailed} failed payment${s(f.maxFailed)} a subscription is past due, and after ${f.maxFailed * 2} it pauses. ` +
    `Levy keeps 1% of each payment (${usd(units(f.price / 100n))}).`;
}

$("newPlan").onclick = () => {
  $("planForm").hidden = false;
  line($("pfStatus"), "");
  showPlanSummary();
  $("pfPrice").focus();
};
$("pfCancel").onclick = () => { $("planForm").hidden = true; };
$("pfCycle").onchange = () => { $("pfCustomWrap").hidden = $("pfCycle").value !== "custom"; showPlanSummary(); };
for (const id of ["pfPrice", "pfCustom", "pfTrial", "pfMaxFailed", "pfMaxCycles", "pfIntroPrice", "pfIntroCycles", "pfTransferable"]) {
  $(id).oninput = showPlanSummary;
}

$("planForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = readPlanForm();
  if (f.error) { line($("pfStatus"), f.error, "bad"); return; }
  if (!cfg.managerAddress) { line($("pfStatus"), "This server has no Levy contract configured.", "bad"); return; }
  $("pfCreate").disabled = true;
  try {
    line($("pfStatus"), "Confirm the transaction in your wallet...", "busy");
    const from = await merchantWallet();
    const { planId, txHash } = await LevyWallet.createPlan(from, cfg.managerAddress, account, f);
    $("planForm").reset();
    $("pfCustomWrap").hidden = true;
    showPlanCreated(planId, txHash);
    if (planId) waitForPlan(planId);
  } catch (err) {
    line($("pfStatus"), err.message || String(err), "bad");
  } finally {
    $("pfCreate").disabled = false;
  }
};

function showPlanCreated(planId, txHash) {
  const el = $("pfStatus");
  el.className = "status-line ok";
  el.hidden = false;
  el.replaceChildren(`Plan #${planId ?? "?"} created. `);
  if (planId) {
    const b = document.createElement("button");
    b.className = "ghost small";
    b.textContent = "Copy checkout link";
    b.onclick = () => copyLink(b, checkoutUrl(planId));
    el.append(b, " ");
  }
  const url = LevyWallet.txUrl(cfg.chainId, txHash);
  if (url) {
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "transaction";
    el.append(a);
  }
}

/** The list comes from the keeper's index, which sees a new plan within a minute. */
async function waitForPlan(planId) {
  for (let i = 0; i < 18; i++) {
    await new Promise((ok) => setTimeout(ok, 5000));
    const mine = await loadPlans(account).catch(() => []);
    if (mine.some((p) => p.planId === planId)) return;
  }
}

// ---- subscriptions ----

const ACTIONS = { trial: ["pause", "cancel"], active: ["pause", "cancel"], past_due: ["pause", "cancel"], paused: ["resume", "cancel"] };
const DONE = { pause: "paused", resume: "active", cancel: "cancelled" };
const CONFIRM = {
  pause: (id) => `Pause subscription #${id}? Nothing is charged while it is paused. You or the customer can resume it.`,
  resume: (id) => `Resume subscription #${id}? If its billing date passed while it was paused, the customer is charged again from today.`,
  cancel: (id) => `Cancel subscription #${id}? This is final: it cannot be resumed, and time already paid for is not refunded on-chain.`,
};

// The contract lets a merchant resume only a pause it made itself; a pause by
// the customer or after failed payments is the customer's to resume.
function actionButtons(subId, status, pausedByMerchant) {
  const customerPause = status === "paused" && !pausedByMerchant;
  const actions = (ACTIONS[status] || []).filter((a) => !(customerPause && a === "resume"));
  return (customerPause ? `<span class="muted">customer resumes</span> ` : "") + actions.map((a) =>
    `<button class="${a === "cancel" ? "danger" : "ghost"} small" data-act="${a}" data-sub="${subId}">${a[0].toUpperCase() + a.slice(1)}</button>`).join("");
}

async function loadSubs(subsP) {
  const subs = await subsP;
  if (!subs.length) { $("subs").innerHTML = `<p class="empty">No subscriptions yet. They appear here when customers subscribe through a checkout link.</p>`; return; }
  $("subs").innerHTML = `<table><thead><tr>
    <th>ID</th><th class="addr">Subscriber</th><th class="addr">Ref</th><th>Plan</th><th>Price</th><th>Status</th>
    <th>Next charge</th><th>Failed</th><th title="Rounds of the subscriber's Levy charges their allowance still covers">Allowance</th><th></th></tr></thead><tbody>` +
    subs.map(s => `<tr>
      <td>${s.subId}</td><td class="addr">${short(s.subscriber)}</td><td class="addr">${refText(s.ref)}</td>
      <td>#${s.planId}</td><td>${usd(s.priceUsdc)}/cycle</td><td data-pill="${s.subId}">${pill(s.statusName)}</td>
      <td>${s.nextChargeAtIso.slice(0, 10)}${s.statusName === "completed" ? ` <span class="muted">(paid through)</span>` : ""}</td><td>${s.failedAttempts}</td>
      <td>${s.fundsLow === 1 ? pill(`low: ${s.cyclesCovered}`, "past_due")
           : s.cyclesCovered == null ? `<span class="muted">not checked</span>` : `${s.cyclesCovered} cycles`}</td>
      <td><div class="actions-cell" data-actions="${s.subId}">${actionButtons(s.subId, s.statusName, s.pausedByMerchant === 1)}</div></td></tr>`).join("") +
    `</tbody></table>`;
  bindActions($("subs"));
}

function bindActions(root) {
  root.querySelectorAll("[data-act]").forEach((b) => { b.onclick = () => merchantAct(b.dataset.sub, b.dataset.act); });
}

async function merchantAct(subId, action) {
  if (!confirm(CONFIRM[action](subId))) return;
  const box = document.querySelector(`[data-actions="${subId}"]`);
  box.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  try {
    line($("subsStatus"), `Subscription #${subId}: confirm in your wallet...`, "busy");
    const from = await merchantWallet();
    await LevyWallet.manage(from, cfg.managerAddress, action, subId);
    // The table refreshes from the keeper's index later; show the on-chain result now.
    const status = DONE[action];
    document.querySelector(`[data-pill="${subId}"]`).innerHTML = pill(status);
    box.innerHTML = actionButtons(subId, status, action === "pause");
    bindActions(box);
    line($("subsStatus"), `Done: subscription #${subId} is ${status} on-chain.`, "ok");
  } catch (e) {
    line($("subsStatus"), e.message || String(e), "bad");
    box.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  }
}

async function loadDunning(m) {
  const rows = await api(`/api/dunning?merchant=${m}`);
  if (!rows.length) { $("dunning").innerHTML = `<p class="empty">Queue empty: no payment is being retried.</p>`; return; }
  $("dunning").innerHTML = `<table><thead><tr>
    <th>Sub</th><th class="addr">Subscriber</th><th>Attempts</th><th>Next retry</th></tr></thead><tbody>` +
    rows.map(r => `<tr><td>${r.subId}</td><td class="addr">${short(r.subscriber)}</td>
      <td>${r.attempts}</td><td>${r.nextRetryAtIso.replace("T", " ").slice(0, 19)}Z</td></tr>`).join("") +
    `</tbody></table>`;
}

// ---- webhooks ----

async function loadHooks(m) {
  const hooks = await api(`/api/webhooks?merchant=${m}`);
  if (!hooks.length) { $("hooks").innerHTML = `<p class="empty">No endpoints registered.</p>`; return; }
  const rows = await Promise.all(hooks.map(async (h) => {
    const del = await api(`/api/deliveries?merchant=${m}&webhookId=${h.id}&limit=1`).catch(() => []);
    const last = del[0];
    return `<tr><td>${Number(h.id)}</td><td class="url-cell" title="${esc(h.url)}">${esc(h.url)}</td>
      <td title="${esc(h.events.join(", "))}">${h.events.length === EVENTS.length ? "all events" : `${h.events.length} events`}</td>
      <td>${h.active ? "on" : "off"}</td>
      <td>${last ? `${pill(last.status)} ${esc(last.event_type)}` : `<span class="muted">none</span>`}</td>
      <td><div class="actions-cell"><button class="ghost small" data-log="${h.id}">Deliveries</button>
      <button class="ghost small" data-toggle="${h.id}" data-active="${h.active}">${h.active ? "Disable" : "Enable"}</button>
      <button class="danger small" data-del="${h.id}">Delete</button></div></td></tr>`;
  }));
  $("hooks").innerHTML = `<table><thead><tr>
    <th title="Your receiver checks signatures against this id (X-Levy-Webhook)">ID</th><th>URL</th><th>Events</th><th>Active</th><th>Last delivery</th><th></th></tr></thead>
    <tbody>${rows.join("")}</tbody></table>`;
  $("hooks").querySelectorAll("[data-log]").forEach(b => b.onclick = () => toggleLog(b));
  $("hooks").querySelectorAll("[data-toggle]").forEach(b => b.onclick = async () => {
    const enable = b.dataset.active !== "1";
    if (!enable && !confirm("Disable this endpoint? Events while it is off are not queued, and deliveries still waiting for it are dropped.")) return;
    await api(`/api/webhooks/${b.dataset.toggle}`, { method: "PATCH", body: { active: enable } }).catch(e => alert(e.message));
    loadHooks(m);
  });
  $("hooks").querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this webhook?")) return;
    await api(`/api/webhooks/${b.dataset.del}`, { method: "DELETE" }).catch(e => alert(e.message));
    loadHooks(m);
  });
}

/** The endpoint's last 20 deliveries, in a row under it. */
async function toggleLog(button) {
  const row = button.closest("tr");
  if (row.nextElementSibling?.classList.contains("log")) { row.nextElementSibling.remove(); return; }
  const log = document.createElement("tr");
  log.className = "log";
  log.innerHTML = `<td colspan="5"><p class="loading">Loading...</p></td>`;
  row.after(log);
  const rows = await api(`/api/deliveries?merchant=${account}&webhookId=${button.dataset.log}&limit=20`).catch((e) => { log.firstChild.textContent = e.message; return null; });
  if (!rows) return;
  log.firstChild.innerHTML = rows.length
    ? `<table><thead><tr><th>Delivery</th><th>Created (UTC)</th><th>Event</th><th>Status</th><th>Attempts</th><th>Last error</th></tr></thead><tbody>` +
      rows.map((d) => `<tr><td>#${d.id}</td><td>${new Date(d.created_at * 1000).toISOString().replace("T", " ").slice(0, 19)}</td>
        <td>${esc(d.event_type)}</td><td>${pill(d.status)}</td><td>${d.attempts}</td>
        <td>${d.last_error ? esc(d.last_error) : `<span class="muted">none</span>`}</td></tr>`).join("") + `</tbody></table>`
    : `<p class="empty">No deliveries yet.</p>`;
}

async function loadInvoices(m) {
  const rows = await api(`/api/charges?merchant=${m}`);
  if (!rows.length) { $("invoices").innerHTML = `<p class="empty">No charges yet.</p>`; return; }
  $("invoices").innerHTML = `<table><thead><tr>
    <th>Invoice ref</th><th>Sub</th><th>Amount</th><th>Fee</th><th>Tx</th></tr></thead><tbody>` +
    rows.slice(0, 50).map(c => `<tr><td class="addr">${short(c.invoiceRef)}</td>
      <td>${c.subId}</td><td>${usd(c.amountUsdc)}</td><td>${usd(c.feeUsdc)}</td>
      <td class="addr">${txCell(c.txHash)}</td></tr>`).join("") +
    `</tbody></table>` + (rows.length > 50 ? `<p class="muted" style="font-size:13px;margin:10px 0 0">Showing the latest 50 of ${rows.length}. Export CSV for all of them.</p>` : "");
}

$("signInMain").onclick = () => LevyAuth.signIn().then(load).catch(e => alert("Sign-in failed: " + e.message));
$("signOut").onclick = () => LevyAuth.signOut().then(() => location.reload());
// The CSV is fetched and saved rather than linked, so a failure shows as an alert.
$("csvLink").onclick = async (e) => {
  e.preventDefault();
  const csv = await api(`/api/invoices?merchant=${account}&format=csv`).catch(err => { alert(err.message); return null; });
  if (csv === null) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "levy-invoices.csv";
  a.click();
  URL.revokeObjectURL(a.href);
};
$("addHook").onclick = async () => {
  const m = account;
  const url = $("hookUrl").value.trim();
  const events = [...$("hookEvents").querySelectorAll("input:checked")].map(i => i.value);
  if (!m) { alert("Sign in first"); return; }
  if (!url) { alert("Enter an endpoint URL"); return; }
  if (!events.length) { alert("Tick at least one event"); return; }
  try {
    await api("/api/webhooks", { method: "POST", body: { merchant: m, url, events } });
  } catch (e) { alert("Register failed: " + e.message); return; }
  $("hookUrl").value = "";
  loadHooks(m);
};
LevyAuth.ready.then(load).catch(e => { showSession(); if (merchant()) alert("Load failed: " + e.message); });
