// Minimal EIP-1193 helpers for pages that send transactions. A page that asks
// for a USDC approval loads no third-party code, so the few calls Levy needs
// are encoded by hand here; api/test/wallet.test.ts checks every selector and
// the event topic against the contract ABI.
const LevyWallet = (() => {
  const SEL = {
    approve: "0x095ea7b3", // approve(address,uint256)
    allowance: "0xdd62ed3e", // allowance(address,address)
    balanceOf: "0x70a08231", // balanceOf(address)
    subscribe: "0x70fb44e1", // subscribe(uint256,bytes32)
    pause: "0x41f23f0a", // pauseSubscription(uint256)
    resume: "0x023a584e", // resumeSubscription(uint256)
    cancel: "0x21235083", // cancelSubscription(uint256)
    createPlan: "0x4471f934", // createPlan(uint256,uint256,uint256,uint256,uint8)
    changePlan: "0x7b750eed", // changePlan(uint256,uint256)
    subscriptions: "0x2d5bbf60", // subscriptions(uint256)
  };
  // Subscribed(uint256 indexed subId, address indexed subscriber, uint256 indexed planId, uint64 nextChargeAt, bytes32 ref)
  const SUBSCRIBED_TOPIC = "0xbbb3775bdfa80ff891b19dfb5bf5d13313dca41abb169fce37c277a64e390659";
  // PlanCreated(uint256 indexed planId, address indexed merchant, uint256 price, uint256 cycleSeconds)
  const PLAN_CREATED_TOPIC = "0xf208d0afa2b256272fcedd633a99db585f8c3bde81849a50997b20a5cfde686f";

  // What a wallet needs to add Arc if it does not know it yet.
  const CHAINS = {
    5042: { chainName: "Arc", rpcUrls: ["https://rpc.mainnet.arc.io"], blockExplorerUrls: ["https://explorer.arc.io"] },
    5042002: { chainName: "Arc Testnet", rpcUrls: ["https://rpc.testnet.arc.io"], blockExplorerUrls: ["https://explorer.testnet.arc.io"] },
  };
  const explorer = (chainId) => CHAINS[chainId]?.blockExplorerUrls[0] ?? null;
  const chainName = (chainId) => CHAINS[chainId]?.chainName ?? `chain ${chainId}`;
  // Test USDC for Arc testnet (kept out of CHAINS, which goes to wallet_addEthereumChain as is).
  const faucet = (chainId) => (chainId === 5042002 ? "https://faucet.circle.com" : null);
  /** Explorer page of a transaction, or null (no explorer for the chain, or not a tx hash). */
  const txUrl = (chainId, hash) =>
    explorer(chainId) && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${explorer(chainId)}/tx/${hash}` : null;

  /**
   * A 6-decimal USDC amount, exactly: cents, plus any further digits that are
   * not zero ($29.00, $29.50, $29.000001, $0.009999). Never rounds.
   */
  const usdcText = (units) => {
    const v = BigInt(units);
    const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
    return `$${v / 1_000_000n}.${frac}`;
  };

  const word = (n) => BigInt(n).toString(16).padStart(64, "0");
  const addr = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

  /** A wallet error in plain words, with the next step where there is one. */
  function friendly(e) {
    const code = e?.code ?? e?.data?.code;
    const msg = String(e?.message || e);
    if (code === 4001 || /user (rejected|denied|cancel)/i.test(msg)) return "You cancelled the request in your wallet.";
    if (code === -32002) return "Your wallet already has a request waiting. Open it, finish or close that request, then try again.";
    if (/insufficient funds/i.test(msg)) return "This wallet does not have enough USDC to pay the network fee.";
    return msg;
  }

  async function rpc(method, params = []) {
    if (!window.ethereum) throw new Error("No browser wallet found. Install one (for example MetaMask) to continue.");
    try {
      return await window.ethereum.request({ method, params });
    } catch (e) {
      const err = new Error(friendly(e));
      err.code = e?.code; // connect() needs 4902 (chain not added yet)
      throw err;
    }
  }

  /** Ask for the account and make sure the wallet is on `chainId`. */
  async function connect(chainId) {
    const [account] = await rpc("eth_requestAccounts");
    const hex = "0x" + chainId.toString(16);
    if (String(await rpc("eth_chainId")).toLowerCase() !== hex) {
      try {
        await rpc("wallet_switchEthereumChain", [{ chainId: hex }]);
      } catch (e) {
        const known = CHAINS[chainId];
        if (e?.code !== 4902 || !known) throw new Error(`Switch your wallet to chain ${chainId} and try again.`);
        await rpc("wallet_addEthereumChain", [{
          chainId: hex, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, ...known,
        }]);
      }
      // A wallet can accept the add or switch request and still not move: check
      // again, or reads and transactions would go to another chain.
      if (String(await rpc("eth_chainId")).toLowerCase() !== hex) {
        throw new Error(`Your wallet is still on another network. Switch it to ${chainName(chainId)} and try again.`);
      }
    }
    return account;
  }

  const call = async (to, data) => BigInt(await rpc("eth_call", [{ to, data }, "latest"]));
  const balanceOf = (token, owner) => call(token, SEL.balanceOf + addr(owner));
  const allowance = (token, owner, spender) => call(token, SEL.allowance + addr(owner) + addr(spender));

  /** The receipt of `hash`, or null while it cannot be read (pending, or the RPC failed). */
  const receipt = (hash) => rpc("eth_getTransactionReceipt", [hash]).catch(() => null);

  /**
   * Send and wait for the receipt (Arc finalizes in one ~0.5s block). `onSent`
   * gets the hash the moment the wallet broadcasts, so a page can remember it.
   * If the receipt cannot be read within two minutes the outcome is unknown,
   * not failed: the error carries `hash` and `unknown`, and the caller must not
   * send again until receipt(hash) says how it ended. A transaction that
   * reverted throws with `hash` and `failed`.
   */
  async function send(from, to, data, onSent) {
    const hash = await rpc("eth_sendTransaction", [{ from, to, data }]);
    if (onSent) onSent(hash);
    for (let i = 0; i < 120; i++) {
      const r = await receipt(hash);
      if (r) {
        if (r.status !== "0x1") throw Object.assign(new Error(`Transaction ${hash} failed on-chain, so nothing changed.`), { hash, failed: true });
        return r;
      }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    throw Object.assign(new Error(`Transaction ${hash} was sent, but its result could not be confirmed yet.`), { hash, unknown: true });
  }

  const approve = (from, token, spender, amount, onSent) =>
    send(from, token, SEL.approve + addr(spender) + word(amount), onSent);

  /** The new subscription in a subscribe receipt, from Subscribed (data: nextChargeAt, then ref). */
  function subscribedFrom(r, manager) {
    const log = r.logs.find(
      (l) => l.address.toLowerCase() === manager.toLowerCase() && l.topics[0] === SUBSCRIBED_TOPIC
    );
    return {
      subId: log ? BigInt(log.topics[1]).toString() : null,
      nextChargeAt: log ? Number(BigInt(log.data.slice(0, 66))) : null,
      txHash: r.transactionHash,
    };
  }

  /**
   * subscribe(planId, ref); `ref` is a 0x-prefixed bytes32 (the merchant's
   * reference, or zero). Returns the new subscription id and its first charge
   * time (unix seconds) from Subscribed, whose data is nextChargeAt then ref.
   */
  async function subscribe(from, manager, planId, ref, onSent) {
    const r = await send(from, manager, SEL.subscribe + word(planId) + ref.replace(/^0x/, ""), onSent);
    return subscribedFrom(r, manager);
  }

  /**
   * createPlan(price, cycleSeconds, trialSeconds, graceSeconds, maxFailed).
   * graceSeconds is informational on-chain, so the pages send 0. Returns the
   * new plan id from PlanCreated.
   */
  async function createPlan(from, manager, { price, cycleSeconds, trialSeconds, maxFailed }) {
    const data = SEL.createPlan + word(price) + word(cycleSeconds) + word(trialSeconds) + word(0) + word(maxFailed);
    const r = await send(from, manager, data);
    const log = r.logs.find(
      (l) => l.address.toLowerCase() === manager.toLowerCase() && l.topics[0] === PLAN_CREATED_TOPIC
    );
    return { planId: log ? BigInt(log.topics[1]).toString() : null, txHash: r.transactionHash };
  }

  /** changePlan(subId, newPlanId): subscriber only, same merchant, bills the new plan now. */
  const changePlan = (from, manager, subId, newPlanId) =>
    send(from, manager, SEL.changePlan + word(subId) + word(newPlanId));

  /**
   * A subscription as the contract holds it right now. The API does not mirror
   * credit or chargeCount, which a plan change needs. Getter order:
   * subscriber, planId, start, nextChargeAt, failedAttempts, credit, chargeCount, status.
   */
  async function subscription(manager, subId) {
    const hex = await rpc("eth_call", [{ to: manager, data: SEL.subscriptions + word(subId) }, "latest"]);
    const w = (i) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
    return { planId: w(1), nextChargeAt: Number(w(3)), credit: w(5), chargeCount: w(6), status: Number(w(7)) };
  }

  /**
   * What changePlan would do at `nowSec`, mirroring SubscriptionManager.changePlan:
   * unused time of a paid cycle on the old plan becomes credit, then the new
   * plan's first cycle is paid from credit first and the rest is pulled.
   */
  function changePlanQuote(sub, oldPlan, newPlan, nowSec) {
    let credit = sub.credit;
    if (sub.chargeCount > 0n && sub.nextChargeAt > nowSec) {
      let remaining = BigInt(sub.nextChargeAt - nowSec);
      const cycle = BigInt(oldPlan.cycleSeconds);
      if (remaining > cycle) remaining = cycle;
      credit += (BigInt(oldPlan.price) * remaining) / cycle;
    }
    const price = BigInt(newPlan.price);
    return {
      credit,
      due: credit >= price ? 0n : price - credit,
      creditLeft: credit >= price ? credit - price : 0n,
      nextChargeAt: nowSec + Number(newPlan.cycleSeconds),
    };
  }

  /** pause / resume / cancel a subscription (subscriber or merchant only). */
  const manage = (from, manager, action, subId) => {
    if (!["pause", "resume", "cancel"].includes(action)) throw new Error(`unknown action ${action}`);
    return send(from, manager, SEL[action] + word(subId));
  };

  return {
    connect, balanceOf, allowance, approve, subscribe, manage, createPlan, changePlan,
    subscription, changePlanQuote, receipt, subscribedFrom, usdcText,
    explorer, chainName, txUrl, faucet, friendly,
  };
})();
