// Sign-in for the dashboard and portal: Sign-In with Ethereum (EIP-4361)
// through the browser wallet (window.ethereum). The server writes the message;
// the wallet signs it; the server returns a 24h bearer token, kept in
// localStorage and sent on every API call.
const LevyAuth = (() => {
  const KEY = "levy_session";
  let session = null;
  try { session = JSON.parse(localStorage.getItem(KEY) || "null"); } catch {}
  if (session && session.expiresAt * 1000 <= Date.now()) session = null;

  function save(s) {
    session = s;
    try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch {}
  }

  const hexUtf8 = (text) =>
    "0x" + [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");

  async function send(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (session) headers.authorization = `Bearer ${session.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(path, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 401 && session) save(null);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${r.status}`);
    }
    return (r.headers.get("content-type") || "").includes("json") ? r.json() : r.text();
  }

  async function signIn() {
    if (!window.ethereum) throw new Error("No browser wallet found. Install one (for example MetaMask) to sign in.");
    const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
    const { nonce, message } = await send("/api/auth/challenge", { method: "POST", body: { address } });
    const signature = await window.ethereum.request({ method: "personal_sign", params: [hexUtf8(message), address] });
    save(await send("/api/auth/verify", { method: "POST", body: { nonce, signature } }));
    return session.address;
  }

  async function signOut() {
    if (session) await send("/api/auth/logout", { method: "POST" }).catch(() => {});
    save(null);
  }

  return {
    signIn,
    signOut,
    api: send,
    get address() { return session ? session.address : null; },
  };
})();
