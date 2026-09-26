// Page script for index.html, kept out of the HTML so the Content-Security-Policy
// can forbid inline scripts. Loaded after the shared helpers it uses.
const $ = (id) => document.getElementById(id);

const EVENTS = ["subscription.created","subscription.updated","charge.succeeded","charge.failed","dunning.started","subscription.paused","subscription.resumed","subscription.cancelled","invoice.ready","allowance.low"];
$("hookEvents").innerHTML = EVENTS.map(e =>
  `<label><input type="checkbox" value="${e}" checked> ${e}</label>`).join("");

const short = (a) => a ? a.slice(0, 6) + "..." + a.slice(-4) : "";
// USDC amounts arrive as 6-decimal strings ("29.000000"). Show cents, and
// further digits only when they are not zero, so no amount is misstated.
const usd = (s) => "$" + s.replace(/(\.\d\d\d*?)0+$/, "$1");
const merchant = () => LevyAuth.address;
const api = (p, opts) => LevyAuth.api(p, opts);

function pill(text, cls) { return `<span class="pill ${cls || text}">${text}</span>`; }
// The subscription's merchant reference: readable text when it is ASCII
// (as the checkout encodes short refs), otherwise shortened hex.
function refText(ref) {
  if (!ref) return `<span class="muted">none</span>`;
  const bytes = ref.slice(2).match(/../g).map((h) => parseInt(h, 16));
  const end = bytes.findLastIndex((b) => b !== 0) + 1;
  const text = String.fromCharCode(...bytes.slice(0, end));
  return end > 0 && /^[\x20-\x7e]+$/.test(text) && bytes.slice(end).every((b) => b === 0)
    ? text.replace(/[<>&"]/g, "") : short(ref);
}

function showSession() {
  const m = merchant();
  $("who").textContent = m ? `signed in as ${short(m)}` : "";
  $("signIn").hidden = !!m;
  $("signOut").hidden = !m;
}

async function load() {
  showSession();
  const m = merchant();
  if (!m) return;
  await Promise.all([loadMetrics(m), loadSubs(m), loadDunning(m), loadHooks(m), loadInvoices(m)]);
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

async function loadSubs(m) {
  const subs = await api(`/api/subscriptions?merchant=${m}`);
  if (!subs.length) { $("subs").innerHTML = `<p class="empty">No subscriptions.</p>`; return; }
  $("subs").innerHTML = `<table><thead><tr>
    <th>ID</th><th class="addr">Subscriber</th><th class="addr">Ref</th><th>Price</th><th>Status</th>
    <th>Next charge</th><th>Failed</th><th title="Rounds of the subscriber's Levy charges their allowance still covers">Allowance</th></tr></thead><tbody>` +
    subs.map(s => `<tr>
      <td>${s.subId}</td><td class="addr">${short(s.subscriber)}</td><td class="addr">${refText(s.ref)}</td>
      <td>${usd(s.priceUsdc)}/cycle</td><td>${pill(s.statusName)}</td>
      <td>${s.nextChargeAtIso.slice(0, 10)}</td><td>${s.failedAttempts}</td>
      <td>${s.fundsLow === 1 ? pill(`low: ${s.cyclesCovered}`, "past_due")
           : s.cyclesCovered == null ? `<span class="muted">not checked</span>` : `${s.cyclesCovered} cycles`}</td></tr>`).join("") +
    `</tbody></table>`;
}

async function loadDunning(m) {
  const rows = await api(`/api/dunning?merchant=${m}`);
  if (!rows.length) { $("dunning").innerHTML = `<p class="empty">Queue empty.</p>`; return; }
  $("dunning").innerHTML = `<table><thead><tr>
    <th>Sub</th><th class="addr">Subscriber</th><th>Attempts</th><th>Next retry</th></tr></thead><tbody>` +
    rows.map(r => `<tr><td>${r.subId}</td><td class="addr">${short(r.subscriber)}</td>
      <td>${r.attempts}</td><td>${r.nextRetryAtIso.replace("T", " ").slice(0, 19)}Z</td></tr>`).join("") +
    `</tbody></table>`;
}

async function loadHooks(m) {
  const hooks = await api(`/api/webhooks?merchant=${m}`);
  if (!hooks.length) { $("hooks").innerHTML = `<p class="empty">No endpoints registered.</p>`; return; }
  const rows = await Promise.all(hooks.map(async (h) => {
    const del = await api(`/api/deliveries?webhookId=${h.id}&limit=1`).catch(() => []);
    const last = del[0];
    return `<tr><td class="addr">${short(h.url)}</td>
      <td>${h.events.join(", ")}</td>
      <td>${h.active ? "on" : "off"}</td>
      <td>${last ? `${pill(last.status)} ${last.event_type}` : `<span class="muted">none</span>`}</td>
      <td><button class="ghost" data-toggle="${h.id}" data-active="${h.active}">${h.active ? "Disable" : "Enable"}</button>
      <button class="danger" data-del="${h.id}">Delete</button></td></tr>`;
  }));
  $("hooks").innerHTML = `<table><thead><tr>
    <th>URL</th><th>Events</th><th>Active</th><th>Last delivery</th><th></th></tr></thead>
    <tbody>${rows.join("")}</tbody></table>`;
  $("hooks").querySelectorAll("[data-toggle]").forEach(b => b.onclick = async () => {
    await api(`/api/webhooks/${b.dataset.toggle}`, { method: "PATCH",
      body: { active: b.dataset.active !== "1" } }).catch(e => alert(e.message));
    loadHooks(m);
  });
  $("hooks").querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this webhook?")) return;
    await api(`/api/webhooks/${b.dataset.del}`, { method: "DELETE" }).catch(e => alert(e.message));
    loadHooks(m);
  });
}

async function loadInvoices(m) {
  const rows = await api(`/api/charges?merchant=${m}`);
  if (!rows.length) { $("invoices").innerHTML = `<p class="empty">No charges yet.</p>`; return; }
  $("invoices").innerHTML = `<table><thead><tr>
    <th>Invoice ref</th><th>Sub</th><th>Amount</th><th>Fee</th><th>Tx</th></tr></thead><tbody>` +
    rows.slice(0, 50).map(c => `<tr><td class="addr">${short(c.invoiceRef)}</td>
      <td>${c.subId}</td><td>${usd(c.amountUsdc)}</td><td>${usd(c.feeUsdc)}</td>
      <td class="addr">${short(c.txHash)}</td></tr>`).join("") +
    `</tbody></table>`;
}

$("signIn").onclick = () => LevyAuth.signIn().then(load).catch(e => alert("Sign-in failed: " + e.message));
$("signOut").onclick = () => LevyAuth.signOut().then(() => location.reload());
// The CSV is fetched and saved rather than linked, so a failure shows as an alert.
$("csvLink").onclick = async (e) => {
  e.preventDefault();
  const csv = await api("/api/invoices?format=csv").catch(err => { alert(err.message); return null; });
  if (csv === null) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "levy-invoices.csv";
  a.click();
  URL.revokeObjectURL(a.href);
};
$("addHook").onclick = async () => {
  const m = merchant();
  const url = $("hookUrl").value.trim();
  const events = [...$("hookEvents").querySelectorAll("input:checked")].map(i => i.value);
  if (!m) { alert("Sign in first"); return; }
  if (!url) { alert("Enter an endpoint URL"); return; }
  try {
    await api("/api/webhooks", { method: "POST", body: { url, events } });
  } catch (e) { alert("Register failed: " + e.message); return; }
  $("hookUrl").value = "";
  loadHooks(m);
};
LevyAuth.ready.then(load).catch(e => { showSession(); if (merchant()) alert("Load failed: " + e.message); });
