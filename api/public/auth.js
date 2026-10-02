// Sign-in for the dashboard and portal: Sign-In with Ethereum (EIP-4361)
// through the browser wallet (window.ethereum). The server writes the message;
// the wallet signs it; the server sets a 24h session cookie that page scripts
// cannot read (HttpOnly), which the browser sends on every API call. Who is
// signed in is asked from the server, so pages wait for LevyAuth.ready.
const LevyAuth = (() => {
  let address = null;
  // Earlier versions kept a bearer token in localStorage; remove it.
  try { localStorage.removeItem("levy_session"); } catch {}

  // Plain wallet errors from wallet.js when the page loads it.
  const friendly = (e) => (typeof LevyWallet !== "undefined" ? LevyWallet.friendly(e) : e?.message || String(e));
  async function wallet(method, params) {
    try {
      return await window.ethereum.request({ method, params });
    } catch (e) {
      throw new Error(friendly(e));
    }
  }

  const hexUtf8 = (text) =>
    "0x" + [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");

  async function send(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(path, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 401) address = null;
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${r.status}`);
    }
    return (r.headers.get("content-type") || "").includes("json") ? r.json() : r.text();
  }

  // A 401 here just means nobody is signed in.
  const ready = send("/api/auth/session").then((s) => { address = s.address; }, () => {});

  async function signIn() {
    if (!window.ethereum) throw new Error("No browser wallet found. Install one (for example MetaMask) to sign in.");
    const [account] = await wallet("eth_requestAccounts");
    const { nonce, message } = await send("/api/auth/challenge", { method: "POST", body: { address: account } });
    const signature = await wallet("personal_sign", [hexUtf8(message), account]);
    address = (await send("/api/auth/verify", { method: "POST", body: { nonce, signature, cookie: true } })).address;
    return address;
  }

  async function signOut() {
    if (address) await send("/api/auth/logout", { method: "POST" }).catch(() => {});
    address = null;
  }

  return {
    signIn,
    signOut,
    api: send,
    ready,
    get address() { return address; },
  };
})();
