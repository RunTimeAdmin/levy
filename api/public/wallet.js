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
  };
  // Subscribed(uint256 indexed subId, address indexed subscriber, uint256 indexed planId, uint64 nextChargeAt, bytes32 ref)
  const SUBSCRIBED_TOPIC = "0xbbb3775bdfa80ff891b19dfb5bf5d13313dca41abb169fce37c277a64e390659";

  // What a wallet needs to add Arc if it does not know it yet.
  const CHAINS = {
    5042: { chainName: "Arc", rpcUrls: ["https://rpc.mainnet.arc.io"], blockExplorerUrls: ["https://explorer.arc.io"] },
    5042002: { chainName: "Arc Testnet", rpcUrls: ["https://rpc.testnet.arc.io"], blockExplorerUrls: ["https://explorer.testnet.arc.io"] },
  };
  const explorer = (chainId) => CHAINS[chainId]?.blockExplorerUrls[0] ?? null;
  const chainName = (chainId) => CHAINS[chainId]?.chainName ?? `chain ${chainId}`;
  /** Explorer page of a transaction, or null (no explorer for the chain, or not a tx hash). */
  const txUrl = (chainId, hash) =>
    explorer(chainId) && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${explorer(chainId)}/tx/${hash}` : null;

  const word = (n) => BigInt(n).toString(16).padStart(64, "0");
  const addr = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

  function rpc(method, params = []) {
    if (!window.ethereum) throw new Error("No browser wallet found. Install one (for example MetaMask) to continue.");
    return window.ethereum.request({ method, params });
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
    }
    return account;
  }

  const call = async (to, data) => BigInt(await rpc("eth_call", [{ to, data }, "latest"]));
  const balanceOf = (token, owner) => call(token, SEL.balanceOf + addr(owner));
  const allowance = (token, owner, spender) => call(token, SEL.allowance + addr(owner) + addr(spender));

  /** Send and wait for the receipt (Arc finalizes in one ~0.5s block). */
  async function send(from, to, data) {
    const hash = await rpc("eth_sendTransaction", [{ from, to, data }]);
    for (let i = 0; i < 120; i++) {
      const r = await rpc("eth_getTransactionReceipt", [hash]);
      if (r) {
        if (r.status !== "0x1") throw new Error(`Transaction ${hash} failed on-chain.`);
        return r;
      }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    throw new Error(`Transaction ${hash} is still pending. Check your wallet before retrying.`);
  }

  const approve = (from, token, spender, amount) =>
    send(from, token, SEL.approve + addr(spender) + word(amount));

  /**
   * subscribe(planId, ref); `ref` is a 0x-prefixed bytes32 (the merchant's
   * reference, or zero). Returns the new subscription id and its first charge
   * time (unix seconds) from Subscribed, whose data is nextChargeAt then ref.
   */
  async function subscribe(from, manager, planId, ref) {
    const r = await send(from, manager, SEL.subscribe + word(planId) + ref.replace(/^0x/, ""));
    const log = r.logs.find(
      (l) => l.address.toLowerCase() === manager.toLowerCase() && l.topics[0] === SUBSCRIBED_TOPIC
    );
    return {
      subId: log ? BigInt(log.topics[1]).toString() : null,
      nextChargeAt: log ? Number(BigInt(log.data.slice(0, 66))) : null,
      txHash: r.transactionHash,
    };
  }

  /** pause / resume / cancel a subscription (subscriber or merchant only). */
  const manage = (from, manager, action, subId) => {
    if (!["pause", "resume", "cancel"].includes(action)) throw new Error(`unknown action ${action}`);
    return send(from, manager, SEL[action] + word(subId));
  };

  return { connect, balanceOf, allowance, approve, subscribe, manage, explorer, chainName, txUrl };
})();
