// Minimal EIP-1193 helpers for pages that send transactions. A page that asks
// for a USDC approval loads no third-party code, so the few calls Levy needs
// are encoded by hand here; api/test/wallet.test.ts checks every selector and
// the event topic against the contract ABI.
const LevyWallet = (() => {
  const SEL = {
    approve: "0x095ea7b3", // approve(address,uint256)
    allowance: "0xdd62ed3e", // allowance(address,address)
    balanceOf: "0x70a08231", // balanceOf(address)
    subscribe: "0x0f574ba7", // subscribe(uint256)
  };
  // Subscribed(uint256 indexed subId, address indexed subscriber, uint256 indexed planId, uint64 nextChargeAt)
  const SUBSCRIBED_TOPIC = "0xdeda80306cf42bcb405d97f58f27bfaa4c960750693c1ada163cd06978d9b804";

  // What a wallet needs to add Arc if it does not know it yet.
  const CHAINS = {
    5042: { chainName: "Arc", rpcUrls: ["https://rpc.mainnet.arc.io"], blockExplorerUrls: ["https://explorer.arc.io"] },
    5042002: { chainName: "Arc Testnet", rpcUrls: ["https://rpc.testnet.arc.io"], blockExplorerUrls: ["https://explorer.testnet.arc.io"] },
  };
  const explorer = (chainId) => CHAINS[chainId]?.blockExplorerUrls[0] ?? null;

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

  /** subscribe(planId); returns the new subscription id from the Subscribed event. */
  async function subscribe(from, manager, planId) {
    const r = await send(from, manager, SEL.subscribe + word(planId));
    const log = r.logs.find(
      (l) => l.address.toLowerCase() === manager.toLowerCase() && l.topics[0] === SUBSCRIBED_TOPIC
    );
    return { subId: log ? BigInt(log.topics[1]).toString() : null, txHash: r.transactionHash };
  }

  return { connect, balanceOf, allowance, approve, subscribe, explorer };
})();
