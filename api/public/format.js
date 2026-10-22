// Display helpers shared by the dashboard, portal and checkout pages. Loaded
// after wallet.js and before the page scripts; adds one global, LevyFormat.
const LevyFormat = (() => {
  const short = (a) => a ? a.slice(0, 6) + "..." + a.slice(-4) : "";
  // USDC amounts arrive as 6-decimal strings ("29.000000"). Show cents, and
  // further digits only when they are not zero, so no amount is misstated.
  const usd = (s) => "$" + s.replace(/(\.\d\d\d*?)0+$/, "$1");
  /** Raw 6-decimal units as the API's decimal string ("29.000000"), for usd(). */
  const units = (v) => { const b = BigInt(v); return `${b / 1_000_000n}.${(b % 1_000_000n).toString().padStart(6, "0")}`; };

  /** Names of the plan presets' cycle lengths (seconds), as the dashboard and portal show them. */
  const CYCLE_NAMES = { 86400: "day", 604800: "week", 2592000: "30 days", 7776000: "90 days", 31536000: "year" };
  /** "every ___": the preset's name from `names`, otherwise the length in days. */
  const every = (sec, names = CYCLE_NAMES) => names[sec] ?? `${+(sec / 86400).toFixed(2)} days`;

  const date = (sec) => new Date(sec * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

  /** A link that opens in a new tab without handing it this window (rel=noopener). */
  function externalLink(href, text) {
    const a = document.createElement("a");
    a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = text;
    return a;
  }

  /** A transaction for a table cell (HTML): an explorer link when there is one, else the short hash. */
  function txCell(chainId, hash) {
    const url = LevyWallet.txUrl(chainId, hash);
    return url ? `<a href="${url}" target="_blank" rel="noopener">${short(hash)}</a>` : short(hash);
  }

  return { short, usd, units, every, date, externalLink, txCell };
})();
