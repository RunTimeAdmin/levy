// Page script for portal.html, kept out of the HTML so the Content-Security-Policy
// can forbid inline scripts. Loaded after the shared helpers it uses.
const $ = (id) => document.getElementById(id);
const { short, usd, units, every, date } = LevyFormat;
let cfg; // chain id and contract addresses, for the wallet actions
let plans = []; // every plan, for plan changes (same merchant only)
const txCell = (hash) => LevyFormat.txCell(cfg.chainId, hash);

/** Connect the wallet on Levy's chain and make sure it is the signed-in account. */
async function myWallet() {
  const account = await LevyWallet.connect(cfg.chainId);
  if (account.toLowerCase() !== LevyAuth.address.toLowerCase()) {
    throw new Error(`Your wallet is on ${short(account)}; switch it to ${short(LevyAuth.address)}, the account you signed in with.`);
  }
  return account;
}

const CONFIRM = {
  pause: (id) => `Pause subscription #${id}? Nothing is charged while it is paused.`,
  resume: (id) => `Resume subscription #${id}? If a charge date passed while it was paused, billing restarts today.`,
  cancel: (id) => `Cancel subscription #${id}? This is final: it cannot be resumed, and time already paid for is not refunded on-chain (refunds are up to the merchant).`,
};
const CHANGEABLE = new Set(["trial", "active", "past_due"]);

const otherPlans = (sub) => plans.filter((p) =>
  p.merchant.toLowerCase() === sub.merchant.toLowerCase() && p.planId !== sub.planId);

function renderActions(sub, status) {
  const box = document.querySelector(`[data-actions="${sub.subId}"]`);
  const buttons = LevyWallet.actions(status).map((action) => {
    const b = document.createElement("button");
    b.className = action === "cancel" ? "ghost danger" : "ghost";
    b.textContent = action[0].toUpperCase() + action.slice(1);
    b.onclick = () => act(sub, action);
    return b;
  });
  if (CHANGEABLE.has(status) && otherPlans(sub).length) {
    const b = document.createElement("button");
    b.className = "ghost";
    b.textContent = "Change plan";
    b.onclick = () => openChange(sub);
    buttons.unshift(b);
  }
  box.replaceChildren(...buttons);
}

async function act(sub, action) {
  const subId = sub.subId;
  if (!confirm(CONFIRM[action](subId))) return;
  const note = document.querySelector(`[data-status="${subId}"]`);
  const buttons = document.querySelectorAll(`[data-actions="${subId}"] button`);
  buttons.forEach((b) => { b.disabled = true; });
  try {
    note.textContent = "Confirm in your wallet...";
    note.classList.add("busy");
    const account = await myWallet();
    await LevyWallet.manage(account, cfg.managerAddress, action, subId);
    // The portal's data refreshes after the keeper's next sync; show the
    // on-chain result now.
    const status = LevyWallet.statusAfter(action);
    setPill(subId, status);
    renderActions(sub, status);
    document.querySelector(`[data-change="${subId}"]`).hidden = true;
    note.textContent = `Done: subscription #${subId} is ${status} on-chain.`;
  } catch (e) {
    note.textContent = e.message || String(e);
    buttons.forEach((b) => { b.disabled = false; });
  } finally {
    note.classList.remove("busy");
  }
}

function setPill(subId, status) {
  const p = document.querySelector(`[data-pill="${subId}"]`);
  p.className = `pill ${status}`;
  p.textContent = status;
}

// ---- plan change ----

function openChange(sub) {
  const panel = document.querySelector(`[data-change="${sub.subId}"]`);
  if (!panel.hidden) { panel.hidden = true; return; }
  const select = panel.querySelector("select");
  select.replaceChildren(...otherPlans(sub).map((p) => {
    const o = document.createElement("option");
    o.value = p.planId;
    o.textContent = `Plan #${p.planId}: ${usd(p.priceUsdc)} every ${every(p.cycleSeconds)}`;
    return o;
  }));
  select.onchange = () => quoteChange(sub);
  panel.querySelector("[data-go]").onclick = () => doChange(sub);
  panel.querySelector("[data-close]").onclick = () => { panel.hidden = true; };
  panel.hidden = false;
  quoteChange(sub);
}

/** Shows what switching costs right now, read from the contract, and whether the allowance covers it. */
async function quoteChange(sub) {
  const panel = document.querySelector(`[data-change="${sub.subId}"]`);
  const quote = panel.querySelector("[data-quote]");
  const go = panel.querySelector("[data-go]");
  const target = plans.find((p) => p.planId === panel.querySelector("select").value);
  go.disabled = true;
  quote.className = "loading";
  quote.textContent = "Working out the price...";
  try {
    const onchain = await LevyWallet.subscription(cfg.managerAddress, sub.subId);
    const current = plans.find((p) => p.planId === onchain.planId.toString());
    const q = LevyWallet.changePlanQuote(onchain, current, target, Math.floor(Date.now() / 1000));
    const allow = await LevyWallet.allowance(cfg.usdcAddress, LevyAuth.address, cfg.managerAddress);
    const parts = [];
    if (q.due === 0n) {
      parts.push(`Nothing is charged now: your ${usd(units(q.credit))} credit for unused time pays the new plan's first cycle` +
        (q.creditLeft > 0n ? `, and ${usd(units(q.creditLeft))} carries over.` : "."));
    } else if (q.credit > 0n) {
      parts.push(`You pay about ${usd(units(q.due))} now: the new plan's ${usd(target.priceUsdc)}, less ${usd(units(q.credit))} credit for unused time on your current plan.`);
    } else {
      parts.push(`You pay ${usd(target.priceUsdc)} now for the new plan's first cycle.`);
    }
    parts.push(`Then ${usd(target.priceUsdc)} every ${every(target.cycleSeconds)}, next on ${date(q.nextChargeAt)}.`);
    quote.className = "";
    quote.textContent = parts.join(" ");
    if (allow < q.due) {
      quote.append(` Your allowance (${usd(units(allow))}) does not cover this: top it up above first.`);
      quote.className = "warn-text";
      return;
    }
    go.textContent = q.due === 0n ? `Switch to plan #${target.planId}` : `Switch and pay about ${usd(units(q.due))}`;
    go.disabled = false;
  } catch (e) {
    quote.className = "warn-text";
    quote.textContent = e.message || String(e);
  }
}

async function doChange(sub) {
  const panel = document.querySelector(`[data-change="${sub.subId}"]`);
  const target = plans.find((p) => p.planId === panel.querySelector("select").value);
  const note = document.querySelector(`[data-status="${sub.subId}"]`);
  const go = panel.querySelector("[data-go]");
  go.disabled = true;
  try {
    note.textContent = "Confirm the plan change in your wallet...";
    note.classList.add("busy");
    const account = await myWallet();
    await LevyWallet.changePlan(account, cfg.managerAddress, sub.subId, target.planId);
    // Show the on-chain result now; the rest of the page catches up at the keeper's next sync.
    sub.planId = target.planId;
    sub.priceUsdc = target.priceUsdc;
    sub.cycleSeconds = target.cycleSeconds;
    const card = document.querySelector(`[data-card="${sub.subId}"]`);
    card.querySelector("[data-plan]").textContent = planLine(sub);
    card.querySelector("[data-price]").textContent = usd(target.priceUsdc);
    card.querySelector("[data-next]").textContent = date(Math.floor(Date.now() / 1000) + Number(target.cycleSeconds));
    setPill(sub.subId, "active");
    renderActions(sub, "active");
    panel.hidden = true;
    note.textContent = `Done: you are on plan #${target.planId}.`;
  } catch (e) {
    note.textContent = e.message || String(e);
    go.disabled = false;
  } finally {
    note.classList.remove("busy");
  }
}

const planLine = (sub) => `Plan #${sub.planId}: ${usd(sub.priceUsdc)} every ${every(sub.cycleSeconds)}`;

function showSession() {
  const s = LevyAuth.address;
  $("booting").hidden = true;
  // Signed out, the panel below has the sign-in button; the header shows the session only.
  $("session").hidden = !s;
  $("who").textContent = s ? short(s) : "";
  $("signedOut").hidden = !!s;
  $("main").hidden = !s;
}

// ---- allowance ----

/**
 * The one USDC allowance all of the subscriber's Levy subscriptions draw from:
 * how far it reaches, with a top-up and a revoke. Values are as of the
 * keeper's last check until an action here reads the chain.
 */
function allowancePanel(funds) {
  const box = document.createElement("section");
  const lowBalance = funds.checked && BigInt(funds.balance) < BigInt(funds.perCycle);
  box.className = funds.checked && (funds.low || lowBalance) ? "banner" : "panel";
  const h = document.createElement("h2");
  h.textContent = "Your allowance";
  const text = document.createElement("p");
  text.style.margin = "0";
  if (funds.checked) {
    const rounds = `${funds.cyclesCovered} more round${funds.cyclesCovered === 1 ? "" : "s"}`;
    text.textContent = `You have approved ${usd(funds.allowanceUsdc)} USDC for Levy, enough for ${rounds} of your subscriptions (${usd(funds.perCycleUsdc)} per round). ` +
      `Your balance is ${usd(funds.balanceUsdc)}. As of Levy's last check.`;
    if (funds.low) text.append(" Top it up so your next payments do not fail.");
  } else {
    text.textContent = "Levy has not checked your allowance yet. It is the USDC you approved for Levy, shared by all your subscriptions.";
  }
  box.append(h, text);
  if (lowBalance) {
    const p = document.createElement("p");
    p.style.margin = "0";
    p.textContent = `Your USDC balance is below one round of your subscriptions (${usd(funds.perCycleUsdc)}).`;
    const faucet = LevyWallet.faucet(cfg.chainId);
    if (faucet) p.append(" ", LevyFormat.externalLink(faucet, "Get test USDC"), " (choose Arc Testnet).");
    box.append(p);
  }
  // Shown even before a wallet is detected (some inject late); without one, a click says so.
  if (!cfg.managerAddress) return box;

  const row = document.createElement("div");
  row.className = "row";
  const status = document.createElement("p");
  status.className = "muted";
  status.style.margin = "0";
  const perRound = BigInt(funds.perCycle || 0);
  if (perRound > 0n) {
    const rounds = document.createElement("input");
    rounds.type = "number"; rounds.min = "1"; rounds.max = "120"; rounds.value = "12"; rounds.style.width = "80px";
    rounds.setAttribute("aria-label", "Rounds to add");
    const add = document.createElement("button");
    add.textContent = "Top up";
    add.onclick = () => changeAllowance(status, [add, revoke], async (account, now) => {
      const n = Number(rounds.value);
      if (!Number.isInteger(n) || n < 1 || n > 120) throw new Error("Enter a whole number of rounds from 1 to 120.");
      return now + perRound * BigInt(n);
    });
    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = "more rounds";
    row.append(rounds, label, add);
  }
  const revoke = document.createElement("button");
  revoke.className = "ghost danger";
  revoke.style.marginLeft = "auto";
  revoke.textContent = "Revoke";
  revoke.onclick = () => {
    if (!confirm("Revoke your whole Levy allowance? Every Levy subscription you have will then fail to charge and pause after repeated failures. To stop one subscription, cancel it instead.")) return;
    changeAllowance(status, [revoke], async () => 0n);
  };
  row.append(revoke);
  box.append(row, status);
  return box;
}

/** Approves a new allowance total, computed from the current one read from the chain. */
async function changeAllowance(status, buttons, total) {
  buttons.forEach((b) => { if (b) b.disabled = true; });
  try {
    status.textContent = "Confirm in your wallet...";
    status.classList.add("busy");
    const account = await myWallet();
    const now = await LevyWallet.allowance(cfg.usdcAddress, account, cfg.managerAddress);
    const next = await total(account, now);
    await LevyWallet.approve(account, cfg.usdcAddress, cfg.managerAddress, next);
    status.textContent = `Done: your Levy allowance is now ${usd(units(next))} USDC. The figures above update at Levy's next check.`;
  } catch (e) {
    status.textContent = e.message || String(e);
  } finally {
    status.classList.remove("busy");
    buttons.forEach((b) => { if (b) b.disabled = false; });
  }
}

async function load() {
  showSession();
  const s = LevyAuth.address;
  if (!s) return;
  const main = $("main");
  main.innerHTML = `<p class="loading">Loading your subscriptions...</p>`;
  const [subs, config, funds, allPlans] = await Promise.all([
    LevyAuth.api(`/api/subscriptions?subscriber=${s}`),
    fetch("/api/config").then((r) => r.json()),
    LevyAuth.api("/api/funds"),
    fetch("/api/plans").then((r) => r.json()),
  ]);
  cfg = config;
  plans = allPlans;
  if (!subs.length) {
    main.innerHTML = `<section class="panel"><h2>No subscriptions</h2><p class="empty">This address has no Levy subscriptions. Subscriptions start from a merchant's checkout link.</p></section>`;
    return;
  }
  const cards = await Promise.all(subs.map(async (sub) => {
    const detail = await LevyAuth.api(`/api/subscriptions/${sub.subId}`);
    const invoices = (detail.charges || []).map(c => `<tr>
      <td class="addr">${short(c.invoiceRef)}</td><td>${usd(c.amountUsdc)}</td>
      <td class="addr">${txCell(c.txHash)}</td></tr>`).join("");
    return `<div class="card sub" data-card="${sub.subId}">
      <h2>Subscription #${sub.subId} <span class="pill ${sub.statusName}" data-pill="${sub.subId}">${sub.statusName}</span></h2>
      <p class="muted" style="margin:-6px 0 0" data-plan>${planLine(sub)}</p>
      <div class="grid">
        <div><div class="label">Price</div><div class="value" data-price>${usd(sub.priceUsdc)}</div></div>
        <div><div class="label">Next charge</div><div class="value" style="font-size:15px" data-next>${sub.statusName === "cancelled" ? "none" : date(sub.nextChargeAt)}</div></div>
        <div><div class="label">Failed attempts</div><div class="value">${sub.failedAttempts}</div></div>
        <div><div class="label">Merchant</div><div class="value addr" style="font-size:13px">${short(sub.merchant)}</div></div>
      </div>
      <div class="row" data-actions="${sub.subId}"></div>
      <div class="change" data-change="${sub.subId}" hidden>
        <label>Switch to <select aria-label="New plan"></select></label>
        <p data-quote></p>
        <div class="row"><button data-go disabled>Switch plan</button><button class="ghost" data-close>Keep my plan</button></div>
      </div>
      <p class="note" data-status="${sub.subId}">Pause, resume, cancel and plan changes are wallet transactions from the account you signed in with.</p>
      <h3>Invoice history</h3>
      ${invoices ? `<div class="table-scroll"><table><thead><tr><th>Invoice</th><th>Amount</th><th>Tx</th></tr></thead><tbody>${invoices}</tbody></table></div>`
                 : `<p class="muted">No charges yet.</p>`}
    </div>`;
  }));
  main.innerHTML = cards.join("");
  if (cfg.managerAddress) subs.forEach((sub) => renderActions(sub, sub.statusName));
  main.prepend(allowancePanel(funds));
}

$("signInMain").onclick = () => LevyAuth.signIn().then(load).catch(e => alert("Sign-in failed: " + e.message));
$("signOut").onclick = () => LevyAuth.signOut().then(() => location.reload());
LevyAuth.ready.then(load).catch(e => { showSession(); if (LevyAuth.address) alert("Load failed: " + e.message); });
