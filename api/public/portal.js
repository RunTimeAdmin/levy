// Page script for portal.html, kept out of the HTML so the Content-Security-Policy
// can forbid inline scripts. Loaded after the shared helpers it uses.
const $ = (id) => document.getElementById(id);
const short = (a) => a ? a.slice(0, 6) + "..." + a.slice(-4) : "";
// USDC amounts arrive as 6-decimal strings ("29.000000"). Show cents, and
// further digits only when they are not zero, so no amount is misstated.
const usd = (s) => "$" + s.replace(/(\.\d\d\d*?)0+$/, "$1");
let cfg; // chain id and contract addresses, for the wallet actions
function txCell(hash) {
  const url = LevyWallet.txUrl(cfg.chainId, hash);
  return url ? `<a href="${url}" target="_blank" rel="noopener">${short(hash)}</a>` : short(hash);
}

// What the contract allows in each state (SubscriptionManager.sol).
const ACTIONS = { trial: ["pause", "cancel"], active: ["pause", "cancel"], past_due: ["pause", "cancel"], paused: ["resume", "cancel"] };
const CONFIRM = {
  pause: (id) => `Pause subscription #${id}? Nothing is charged while it is paused.`,
  resume: (id) => `Resume subscription #${id}? If a charge date passed while it was paused, billing restarts today.`,
  cancel: (id) => `Cancel subscription #${id}? This is final: it cannot be resumed, and time already paid for is not refunded on-chain (refunds are up to the merchant).`,
};
const DONE = { pause: "paused", resume: "active", cancel: "cancelled" };

function renderActions(subId, status) {
  const box = document.querySelector(`[data-actions="${subId}"]`);
  box.replaceChildren(...(ACTIONS[status] || []).map((action) => {
    const b = document.createElement("button");
    b.className = action === "cancel" ? "ghost danger" : "ghost";
    b.textContent = action[0].toUpperCase() + action.slice(1);
    b.onclick = () => act(subId, action);
    return b;
  }));
}

async function act(subId, action) {
  if (!confirm(CONFIRM[action](subId))) return;
  const note = document.querySelector(`[data-status="${subId}"]`);
  const buttons = document.querySelectorAll(`[data-actions="${subId}"] button`);
  buttons.forEach((b) => { b.disabled = true; });
  try {
    note.textContent = "Confirm in your wallet...";
    note.classList.add("busy");
    const account = await LevyWallet.connect(cfg.chainId);
    if (account.toLowerCase() !== LevyAuth.address.toLowerCase()) {
      throw new Error(`Your wallet is on ${short(account)}; switch it to ${short(LevyAuth.address)}, the account you signed in with.`);
    }
    await LevyWallet.manage(account, cfg.managerAddress, action, subId);
    // The portal's data refreshes after the keeper's next sync; show the
    // on-chain result now.
    const status = DONE[action];
    const p = document.querySelector(`[data-pill="${subId}"]`);
    p.className = `pill ${status}`;
    p.textContent = status;
    renderActions(subId, status);
    note.textContent = `Done: subscription #${subId} is ${status} on-chain.`;
  } catch (e) {
    note.textContent = e.message || String(e);
    buttons.forEach((b) => { b.disabled = false; });
  } finally {
    note.classList.remove("busy");
  }
}

function showSession() {
  const s = LevyAuth.address;
  $("booting").hidden = true;
  // Signed out, the panel below has the sign-in button; the header shows the session only.
  $("session").hidden = !s;
  $("who").textContent = s ? short(s) : "";
  $("signedOut").hidden = !!s;
  $("main").hidden = !s;
}

// Shown while the allowance (shared by all the subscriber's Levy
// subscriptions) or the balance will not last. Values are as of the keeper's
// last check.
function fundsBanner(funds) {
  const box = document.createElement("div");
  box.className = "banner";
  const lines = [];
  if (funds.low) {
    lines.push(`Your USDC allowance for Levy covers ${funds.cyclesCovered} more round${funds.cyclesCovered === 1 ? "" : "s"} of your subscriptions (${usd(funds.perCycleUsdc)} per round). Top it up so your next payments do not fail.`);
  }
  if (BigInt(funds.balance) < BigInt(funds.perCycle)) {
    lines.push(`Your USDC balance (${usd(funds.balanceUsdc)}) is below one round of your subscriptions (${usd(funds.perCycleUsdc)}).`);
  }
  for (const text of lines) {
    const p = document.createElement("div");
    p.textContent = text;
    box.append(p);
  }
  const status = document.createElement("div");
  status.className = "muted";
  if (funds.low && cfg.managerAddress) {
    const b = document.createElement("button");
    b.textContent = "Top up allowance (12 rounds)";
    b.onclick = async () => {
      b.disabled = true;
      try {
        status.textContent = "Confirm in your wallet...";
        status.classList.add("busy");
        const account = await LevyWallet.connect(cfg.chainId);
        if (account.toLowerCase() !== LevyAuth.address.toLowerCase()) {
          throw new Error(`Your wallet is on ${short(account)}; switch it to ${short(LevyAuth.address)}, the account you signed in with.`);
        }
        const now = await LevyWallet.allowance(cfg.usdcAddress, account, cfg.managerAddress);
        const total = now + BigInt(funds.perCycle) * 12n;
        await LevyWallet.approve(account, cfg.usdcAddress, cfg.managerAddress, total);
        status.textContent = `Done: your allowance is now $${(total / 1_000_000n).toString()}.${(total % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}. This notice clears at the next check.`;
        b.remove();
      } catch (e) {
        status.textContent = e.message || String(e);
        b.disabled = false;
      } finally {
        status.classList.remove("busy");
      }
    };
    box.append(b);
  }
  box.append(status);
  return box;
}

async function load() {
  showSession();
  const s = LevyAuth.address;
  if (!s) return;
  const main = $("main");
  main.innerHTML = `<p class="loading">Loading your subscriptions...</p>`;
  const [subs, config, funds] = await Promise.all([
    LevyAuth.api(`/api/subscriptions?subscriber=${s}`),
    fetch("/api/config").then((r) => r.json()),
    LevyAuth.api("/api/funds"),
  ]);
  cfg = config;
  if (!subs.length) { main.innerHTML = `<section class="panel"><p class="empty">No subscriptions found for this address.</p></section>`; return; }
  const cards = await Promise.all(subs.map(async (sub) => {
    const detail = await LevyAuth.api(`/api/subscriptions/${sub.subId}`);
    const invoices = (detail.charges || []).map(c => `<tr>
      <td class="addr">${short(c.invoiceRef)}</td><td>${usd(c.amountUsdc)}</td>
      <td class="addr">${txCell(c.txHash)}</td></tr>`).join("");
    return `<div class="card sub">
      <h2>Subscription #${sub.subId} <span class="pill ${sub.statusName}" data-pill="${sub.subId}">${sub.statusName}</span></h2>
      <div class="grid">
        <div><div class="label">Price</div><div class="value">${usd(sub.priceUsdc)}</div></div>
        <div><div class="label">Next charge</div><div class="value" style="font-size:15px">${sub.nextChargeAtIso.slice(0, 10)}</div></div>
        <div><div class="label">Failed attempts</div><div class="value">${sub.failedAttempts}</div></div>
        <div><div class="label">Merchant</div><div class="value addr" style="font-size:13px">${short(sub.merchant)}</div></div>
      </div>
      <div class="row" data-actions="${sub.subId}"></div>
      <p class="note" data-status="${sub.subId}">Pause, resume and cancel are wallet transactions from the account you signed in with.</p>
      <h3>Invoice history</h3>
      ${invoices ? `<div class="table-scroll"><table><thead><tr><th>Invoice</th><th>Amount</th><th>Tx</th></tr></thead><tbody>${invoices}</tbody></table></div>`
                 : `<p class="muted">No charges yet.</p>`}
    </div>`;
  }));
  main.innerHTML = cards.join("");
  if (cfg.managerAddress) subs.forEach((sub) => renderActions(sub.subId, sub.statusName));
  if (funds.checked && (funds.low || BigInt(funds.balance) < BigInt(funds.perCycle))) main.prepend(fundsBanner(funds));
}

$("signInMain").onclick = () => LevyAuth.signIn().then(load).catch(e => alert("Sign-in failed: " + e.message));
$("signOut").onclick = () => LevyAuth.signOut().then(() => location.reload());
LevyAuth.ready.then(load).catch(e => { showSession(); if (LevyAuth.address) alert("Load failed: " + e.message); });
