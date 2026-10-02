// Marks every deployment that is not Arc mainnet (chain 5042) with a bar under
// the header, so nobody mistakes a test checkout or portal for a real one.
// Loaded after wallet.js on every page.
fetch("/api/config")
  .then((r) => r.json())
  .then(({ chainId }) => {
    const bar = document.getElementById("testnetBar");
    if (!bar || chainId === 5042) return;
    bar.textContent = `${LevyWallet.chainName(chainId)}: test USDC only, no real money moves.`;
    const faucet = LevyWallet.faucet(chainId);
    if (faucet) {
      const a = document.createElement("a");
      a.href = faucet; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Get test USDC";
      bar.append(" ", a);
    }
    bar.hidden = false;
  })
  .catch(() => {});
