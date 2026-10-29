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
    createPlan: "0xc558b5eb", // createPlan(address,(uint256,uint256,uint256,uint8,uint32,uint256,uint32,bool))
    changePlan: "0x7b750eed", // changePlan(uint256,uint256)
    subscriptions: "0x2d5bbf60", // subscriptions(uint256)
    plans: "0xb1620616", // plans(uint256)
    billedPrice: "0x7e025486", // billedPrice(uint256)
    setPlanRetired: "0x72c36e75", // setPlanRetired(uint256,bool)
    setPayout: "0xc2fb1ceb", // setPayout(address,address)
    transferOwnership: "0x6d435421", // transferOwnership(address,address)
    acceptOwnership: "0x51710e45", // acceptOwnership(address)
    proposeTransfer: "0x86bde3d1", // proposeTransfer(uint256,address)
    acceptTransfer: "0x2fd5867d", // acceptTransfer(uint256,uint256)
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

  // The chain connect() put the wallet on. The wallet can change network at
  // any time after that, so send() checks it again before every transaction.
  let connectedChain = null;

  /** Ask for the account and make sure the wallet is on `chainId`. */
  async function connect(chainId) {
    connectedChain = null;
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
    connectedChain = hex;
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
   * reverted throws with `hash` and `failed`. Sends nothing unless the wallet
   * is still on the chain connect() checked; the request names that chain too,
   * so a wallet that moves in between refuses it.
   */
  async function send(from, to, data, onSent) {
    if (!connectedChain) throw new Error("Connect your wallet first.");
    if (String(await rpc("eth_chainId")).toLowerCase() !== connectedChain) {
      throw new Error(`Your wallet is on another network now. Switch it back to ${chainName(Number(connectedChain))} and try again. Nothing was sent.`);
    }
    const hash = await rpc("eth_sendTransaction", [{ from, to, data, chainId: connectedChain }]);
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
   * createPlan(account, terms) for the merchant account `account`, which `from`
   * must own. `terms` is the contract's PlanTerms, a static tuple, so it is
   * encoded in place: price, cycleSeconds, trialSeconds, maxFailed, maxCycles
   * (0 = no limit), introPrice, introCycles, transferable. Returns the new
   * plan id from PlanCreated.
   */
  async function createPlan(from, manager, account, t) {
    const data = SEL.createPlan + addr(account) + word(t.price) + word(t.cycleSeconds) + word(t.trialSeconds) +
      word(t.maxFailed) + word(t.maxCycles ?? 0) + word(t.introPrice ?? 0) + word(t.introCycles ?? 0) +
      word(t.transferable ? 1 : 0);
    const r = await send(from, manager, data);
    const log = r.logs.find(
      (l) => l.address.toLowerCase() === manager.toLowerCase() && l.topics[0] === PLAN_CREATED_TOPIC
    );
    return { planId: log ? BigInt(log.topics[1]).toString() : null, txHash: r.transactionHash };
  }

  /** changePlan(subId, newPlanId): subscriber only, same merchant, bills the new plan now. */
  const changePlan = (from, manager, subId, newPlanId) =>
    send(from, manager, SEL.changePlan + word(subId) + word(newPlanId));

  /** Merchant account owner only: stop (or allow again) new subscriptions to a plan. */
  const setPlanRetired = (from, manager, planId, retired) =>
    send(from, manager, SEL.setPlanRetired + word(planId) + word(retired ? 1 : 0));
  /** Owner only: fix where the account's share goes; the zero address follows the owner again. */
  const setPayout = (from, manager, account, payout) =>
    send(from, manager, SEL.setPayout + addr(account) + addr(payout));
  /** Owner only: propose the account's next owner, who must call acceptOwnership. */
  const transferOwnership = (from, manager, account, newOwner) =>
    send(from, manager, SEL.transferOwnership + addr(account) + addr(newOwner));
  const acceptOwnership = (from, manager, account) =>
    send(from, manager, SEL.acceptOwnership + addr(account));
  /** Subscriber only: offer the subscription to wallet `to` (zero withdraws the offer). */
  const proposeTransfer = (from, manager, subId, to) =>
    send(from, manager, SEL.proposeTransfer + word(subId) + addr(to));
  /** The offered wallet only; `planId` must be the subscription's current plan. */
  const acceptTransfer = (from, manager, subId, planId) =>
    send(from, manager, SEL.acceptTransfer + word(subId) + word(planId));

  /**
   * A subscription as the contract holds it right now. The API does not mirror
   * credit, chargeCount or the billed price, which a plan change needs. Getter
   * order: subscriber, planId, start, nextChargeAt, failedAttempts, credit,
   * chargeCount, status. billedPrice is its own mapping.
   */
  async function subscription(manager, subId) {
    const [hex, billedPrice] = await Promise.all([
      rpc("eth_call", [{ to: manager, data: SEL.subscriptions + word(subId) }, "latest"]),
      call(manager, SEL.billedPrice + word(subId)),
    ]);
    const w = (i) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
    return { planId: w(1), nextChargeAt: Number(w(3)), credit: w(5), chargeCount: w(6), status: Number(w(7)), billedPrice };
  }

  /**
   * A plan's terms as the manager holds them. Getter order: merchant, price,
   * cycleSeconds, trialSeconds, maxFailed, exists, retired, transferable,
   * maxCycles, introPrice, introCycles.
   */
  async function planTerms(manager, planId) {
    const hex = await rpc("eth_call", [{ to: manager, data: SEL.plans + word(planId) }, "latest"]);
    const w = (i) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
    return {
      merchant: "0x" + hex.slice(2 + 24, 2 + 64), price: w(1), cycleSeconds: w(2), trialSeconds: w(3),
      exists: w(5) === 1n, retired: w(6) === 1n, maxCycles: w(8), introPrice: w(9), introCycles: w(10),
    };
  }

  /**
   * Throws unless the plan on-chain has the terms the page shows. The page's
   * copy comes from Levy's database and subscribe() carries only the plan id,
   * so a stale copy would show a price the contract does not charge.
   */
  async function checkPlan(manager, shown) {
    const t = await planTerms(manager, shown.planId);
    const differ = [];
    if (!t.exists) differ.push("missing");
    if (t.merchant !== String(shown.merchant).toLowerCase()) differ.push("merchant");
    for (const k of ["price", "cycleSeconds", "trialSeconds", "maxCycles", "introPrice", "introCycles"]) {
      if (t[k] !== BigInt(shown[k] ?? 0)) differ.push(k);
    }
    if (t.retired) differ.push("retired");
    if (differ.length) {
      throw new Error(`Plan #${shown.planId} on-chain does not match this page (${differ.join(", ")}). Nothing was sent. Reload the page, and if this stays, contact the merchant.`);
    }
  }

  /** The price of a plan's first payment: its intro price when it has one. */
  const firstPrice = (plan) => BigInt(Number(plan.introCycles || 0) > 0 ? plan.introPrice : plan.price);

  /**
   * What a plan's first `n` payments cost: its intro cycles at introPrice, the
   * rest at price, and never more payments than a limited plan has.
   */
  function paymentsTotal(plan, n) {
    const count = Number(plan.maxCycles || 0) > 0 ? Math.min(n, Number(plan.maxCycles)) : n;
    const intro = Math.min(count, Number(plan.introCycles || 0));
    return BigInt(plan.introPrice || 0) * BigInt(intro) + BigInt(plan.price) * BigInt(count - intro);
  }

  /**
   * What changePlan would do at `nowSec`, mirroring SubscriptionManager.changePlan:
   * unused time of a paid cycle on the old plan becomes credit, at the price
   * that cycle was billed at (an intro cycle cost less than the plan's price),
   * then the new plan's first cycle is paid from credit first and the rest is
   * pulled. A plan change pays the new plan's full price: intro prices stay
   * with the plan a subscription started on.
   */
  function changePlanQuote(sub, oldPlan, newPlan, nowSec) {
    let credit = sub.credit;
    if (sub.chargeCount > 0n && sub.nextChargeAt > nowSec) {
      let remaining = BigInt(sub.nextChargeAt - nowSec);
      const cycle = BigInt(oldPlan.cycleSeconds);
      if (remaining > cycle) remaining = cycle;
      credit += (sub.billedPrice * remaining) / cycle;
    }
    const price = BigInt(newPlan.price);
    return {
      credit,
      due: credit >= price ? 0n : price - credit,
      creditLeft: credit >= price ? credit - price : 0n,
      nextChargeAt: nowSec + Number(newPlan.cycleSeconds),
    };
  }

  /** pause / resume / cancel a subscription (subscriber or merchant only; the merchant resumes only its own pause). */
  const manage = (from, manager, action, subId) => {
    if (!["pause", "resume", "cancel"].includes(action)) throw new Error(`unknown action ${action}`);
    return send(from, manager, SEL[action] + word(subId));
  };

  return {
    connect, balanceOf, allowance, approve, subscribe, manage, createPlan, changePlan,
    setPlanRetired, setPayout, transferOwnership, acceptOwnership, proposeTransfer, acceptTransfer,
    subscription, planTerms, checkPlan, changePlanQuote, firstPrice, paymentsTotal, receipt, subscribedFrom, usdcText,
    explorer, chainName, txUrl, faucet, friendly,
  };
})();
