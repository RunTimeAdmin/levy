# Levy infrastructure security review, 2026-10-24

The contracts were reviewed the same day (`docs/REVIEW_2026-10-24.md`). This
review covers everything else: the keeper, the API and its pages, the
deployment and operations files, CI, the static site, the dependencies and
images, and the live soak host. Code reviewed at `cbefed9` on `main`; the
host as it ran soak 2 on 2026-10-24.

## Method

- **Manual review**, in three independent parts, each read-only and each
  finding then re-checked against the code: the keeper (`keeper/src`,
  `keeper/scripts`), the API and pages (`api/src`, `api/public`), and
  operations, CI and site (`ops/`, `.github/`, `script/`, `site/`). The
  API part ran its checks in-process with `app.inject` and a stubbed DNS;
  the keeper part ran the URL policy against 34 hostile inputs.
- **Live host**, read-only over SSH: OS and updates, listening sockets,
  firewall, SSH settings, Docker containers and mounts, file modes, nginx.
  From outside: TLS versions, response headers, redirects, `security.txt`.
- **Tools.** `npm audit` (keeper and API, dev dependencies included), a
  lockfile check (registry, integrity, install scripts), trufflehog 2 over
  all 65 commits on every ref (regex rules), Trivy 0.76.1 on the keeper and
  API images built from the repo, Semgrep 1.181.1 (JavaScript, TypeScript,
  Node, Express, secrets, Dockerfile, Compose and GitHub Actions rule sets,
  offline, metrics off), hadolint 2.15.1, shellcheck 0.11.0 and
  actionlint 1.7.12.

Severity counts: High 1, Medium 5, Low 12, Info 6.

## Findings

### H-1 A signed webhook for one merchant can be replayed to another

- **Where:** `keeper/src/webhooks.ts:121-128` signs
  `{timestamp}.{deliveryId}.{event}.{body}` with one key for every merchant;
  nothing names the endpoint it was sent to. `docs/merchant-guide.md:126-133`
  tells receivers to check the signature, the timestamp, the event type and
  repeats, but not that `merchant` is their own address or `planId` one of
  their plans.
- **Scenario:** a customer of merchant B receives B's checkout reference R.
  They sign in with any wallet, create their own plan priced at 1 unit and
  subscribe to it with ref R. Levy signs `subscription.created` and
  `charge.succeeded` for that subscription and sends them to the attacker's
  own endpoint. The attacker forwards both, headers included, to B's webhook
  URL within 5 minutes. B's receiver, built from the guide, verifies them,
  links R to the subscription and grants service for 0.000001 USDC.
- **Preconditions:** the attacker knows B's webhook URL, and B does not check
  `merchant` or `planId`.
- **Fix:** sign the destination webhook id (sent as a header) so a delivery
  verifies at one endpoint only, and tell receivers to reject any `merchant`
  that is not theirs and any `planId` that is not one of their plans.

### M-1 The 5-webhook cap can be raced, and URLs have no length limit

- **Where:** `api/src/server.ts:301-312` counts the merchant's webhooks,
  awaits a DNS lookup, then inserts. 50 parallel registrations from one
  session stored 50 webhooks. A 60 KB URL was accepted.
- **Impact:** every event is delivered to every webhook, so one cheap
  subscription that is paused and resumed repeatedly multiplies deliveries
  to endpoints that hang for 5 seconds each. That starves other merchants'
  deliveries (see L-1) and lets Levy be used to send POST floods to a public
  host.
- **Fix:** count and insert with no await in between, and cap URLs at about
  2 KB.

### M-2 The internet-facing API holds, and can create, the webhook signing key

- **Where:** both containers mount `levy-data` (`ops/docker-compose.yml`).
  `GET /api/webhooks/public-key` (`server.ts:338-346`) calls
  `loadSigningKey`, which generates and writes a new private key when the
  file is missing (`webhooks.ts:76-83`, no create-only flag), so the route's
  "keeper has not booted yet" 503 can never fire for a missing key, and on an
  empty volume the API and keeper can each keep a different key. The keeper
  also signs whatever sits in `webhook_deliveries`, a table the API can
  write.
- **Impact:** a compromise of the API (say through a dependency) yields the
  key that makes `charge.succeeded` believable to every merchant. This is a
  more valuable key than the gas key of known item 14.
- **Fix:** only the keeper creates the key, create-only, on storage the API
  cannot read, and publishes just the public key and its id; the API serves
  that. Keep delivery rows out of the API's reach.

### M-3 Delivery ids start again at 1 when the database is recreated

- **Where:** `X-Levy-Delivery` is the `webhook_deliveries` row id
  (`keeper/src/db.ts`, `webhooks.ts:448`). Soak 2 started on a fresh
  database with the same signing key.
- **Impact:** the guide says to store delivery ids and drop repeats, so a
  receiver that kept ids from before the reset silently drops new
  `charge.succeeded` and `subscription.cancelled` events. The soak receiver
  avoided it only because its log was renamed.
- **Fix:** globally unique delivery ids (random, or prefixed with an epoch
  fixed when the database is created).

### M-4 The public soak receiver logs every request, and the soak report counts unsigned ones

- **Where:** `ops/soak/webhook-receiver.mjs:96-115` appends every POST to
  `hooks.jsonl`, signed or not, with its parsed body, and reads the whole
  file back at startup (line 52). The live `/soak-hooks` location has no
  rate limit. `ops/soak-status.sh:52-57` counts events and redeliveries over
  all rows.
- **Impact:** unauthenticated 64 KB POSTs grow the log until the receiver
  cannot restart (a string past V8's limit) or the shared disk fills (169 GB
  free today). Ten unsigned POSTs make the report print every event type as
  received, which is a soak pass criterion; only the separate invalid
  signature line would show it.
- **Fix:** keep bodies only for valid signatures and cap the file, add a
  `limit_req` to `/soak-hooks`, and compute every soak statistic over signed
  rows only.

### M-5 Security fixes written earlier are not on main

- **PR #5** (`claude/dep-security-sweep`, 2026-10-17, open): Dependabot,
  actions pinned to commit SHAs, `LEVY_PUBLIC_ORIGIN` validation, `nosniff`
  and `no-store` on the API, keeper config validation, the RPC URL cut from
  logged errors, and `set-keeper-key.sh` without the key on `sed`'s command
  line. It merges cleanly onto today's `main`. It fixes L-5, L-6, most of L-7
  and part of L-8.
- **`claude/awesome-mendel-xzq52r`** (2026-10-22, no PR): the create-only
  signing key (part of M-2), config validation, database indexes and a clean
  shutdown. It conflicts with `main` in `keeper/src/db.ts`, `indexer.ts` and
  `api/public/dashboard.js`.
- **PR #4** (`claude/tests-and-docs`, 2026-10-17, open): fee math, charge
  path, keeper and sign-in tests; conflicts only in docs.

### Low

- **L-1 Delivery fairness is per webhook, not per merchant** (`db.ts:528-543`,
  8 workers, 5-second timeout). A few dozen free wallets with 5 hanging
  endpoints each can exceed the dispatcher's roughly 17,000 deliveries a day
  and push other merchants' deliveries back. Fix: per-merchant limits per
  pass and on pending deliveries. Not load-tested.
- **L-2 One sign-in flood locks everyone out.** `api/auth.ts:30,91` caps
  pending challenges at 10,000 for the whole server; nginx allows 10 a minute
  plus a burst of 5 per address, so about 200 IPv4 addresses lock out every
  sign-in for 5 minutes, repeatably. (app.getlevy.xyz has no AAAA record, so
  the IPv6 /64 variant does not apply today.) Fix: stateless signed
  challenges, written only on a successful sign-in.
- **L-3 Registration DNS lookups use libuv's 4-thread pool**
  (`webhook-url.ts:103`). Hostnames pointed at a nameserver that never
  answers could stall file reads and so every page. Fix: a c-ares resolver
  with a timeout and a rate limit on `POST /api/webhooks`. Not measured.
- **L-4 `/api/plans` is unauthenticated and unpaginated** (`server.ts:130-136`);
  plan creation costs only gas, so plan spam makes every page download a
  large list. Fix: `GET /api/plans/:id` for checkout, a merchant filter,
  pagination.
- **L-5 The RPC URL can reach the logs** (`keeper/src/index.ts:38,76`). viem's
  error text includes the URL, and providers put API keys in it. Fixed by
  PR #5.
- **L-6 Keeper config is not validated** (`config.ts:38-48`):
  `LEVY_LOG_CHUNK_BLOCKS=0` loops forever, a non-numeric poll interval
  becomes a 1 ms loop against the RPC. Fixed by PR #5.
- **L-7 Private keys in process arguments.** `ops/set-keeper-key.sh:32` puts
  the keeper key in `sed`'s arguments, and the host mounts `/proc` without
  `hidepid`, so any local account can read it while it runs (fixed by
  PR #5). `script/deploy-testnet.ps1:83` passes the deployer key to
  `cast --private-key`, and `ops/treasury-multisig.md` recommends
  `--private-key`. Fix: environment or `--interactive`/`--ledger` only.
- **L-8 CI token and action pinning.** `.github/workflows/ci.yml` has no
  `permissions:` block, checkout keeps the token on disk while `npm ci` and
  forge run, and actions use mutable tags (Semgrep flags 8). The repository's
  default token is read-only (checked), so a retagged action could fake a
  green run but not push. PR #5 pins the actions; add
  `permissions: contents: read` and `persist-credentials: false`.
- **L-9 `.gitignore` misses a root `.env`, `*.pem` and SQLite `-wal`/`-shm`
  files** (checked with `git check-ignore`). Forge loads a root `.env`
  automatically, which makes it the natural place for a mainnet
  `DEPLOYER_PRIVATE_KEY`.
- **L-10 The mainnet treasury check accepts an EIP-7702 delegated wallet**
  (`script/Deploy.s.sol:72` checks only `code.length`). Fix: reject the
  `0xef0100` prefix and require a Safe threshold of at least 2. Matters only
  if Arc mainnet enables 7702.
- **L-11 Container hardening.** Every fixable package CVE Trivy found
  (undici, brace-expansion, ip-address, postcss-selector-parser,
  http-cache-semantics) is in the npm CLI bundled in `node:24-slim`, which
  neither container runs. The base image is not pinned by digest, and the
  containers have no `cap_drop`, `no-new-privileges`, read-only root, or
  memory and process limits on a shared host. Fix: drop npm, npx and
  corepack from the runtime stage, pin the base by digest, add those options.
- **L-12 The keeper and webhook keys live on a shared host.** The VPS also
  runs at least seven other sites and services, one of which needed a
  firewall rule for an attacker in June ("packrai RCE attacker
  2026-06-19"). Root logs in over SSH by key (5 keys); two containers of
  other projects run as root inside. Levy's secrets are root-only on disk,
  but a host-level compromise of any neighbour reaches them. Fix before
  mainnet: a dedicated host for the keeper and API, `hidepid` on `/proc`,
  and a review of the root keys.

### Info

- **I-1** 500 responses return internal error text
  (`?subscription=1&subscription=2` gives `Unknown named parameter '0'`);
  there are no request schemas. Add an error handler and scalar checks.
- **I-2** The database is not tied to a manager address. An old database
  pointed at a new manager would show the old plans at checkout. Store chain
  id and manager in `sync_state` and refuse to start on a mismatch.
- **I-3** Any exception while handling one log aborts the sync before
  charging, so one bad log halts billing for everyone. No attacker-controlled
  trigger was found.
- **I-4** The base image (Debian 12.15) carries 1 critical and 61 high OS
  CVEs, none with a Debian fix yet: zlib's minizip (CVE-2023-45853), which
  Node does not use, util-linux, systemd libraries, gzip and others the
  services never call.
- **I-5** A code-review bundle for an unrelated project (TaxTrace, with a
  zip) was pushed to branch `claude/funny-einstein-jelnlo` of this repo.
- **I-6** Lint notes: hadolint (use `WORKDIR` instead of `cd`; numeric user
  id), shellcheck SC2164 in `ops/soak-status.sh:10` (covered by `set -e`),
  actionlint (an unused loop variable in `ci.yml`).

## Known items re-checked

`SECURITY_REVIEW.md` §9 open items 7 (checkout second tab), 8 (portal top-up
after an unknown outcome), 9 (keeper replay), 10 (webhook retries end near
19 hours), 11 (network checked at connect only), 12 (solc and OpenZeppelin
pinning; the submodule is an untagged commit while `foundry.lock` names
v5.7.0), 13 (dunning rows after pause or cancel), 14 (the API container
holds `LEVY_KEEPER_KEY`, confirmed live) and 15 (CI ignores `.bin`) are all
still open.

## Not issues

- The bare domain already redirects HTTP to HTTPS.
- TLS 1.0 and 1.1 are refused; 1.2 and 1.3 work (certbot's settings override
  the global nginx line that still lists 1.0 and 1.1).
- Docker is 29.6.1, past the versions that let neighbours on the local
  network reach ports published on loopback.
- No container on the host mounts the Docker socket, and the docker group is
  empty.

## Checked and fine

- **Sign-in and sessions:** the server writes the whole SIWE message (domain,
  URI, chain, a 128-bit nonce, issued-at, expiry), verifies against the
  stored message, uses each challenge once and enforces expiry in SQL.
  256-bit session tokens stored as SHA-256; a `__Host-`, Secure, HttpOnly,
  SameSite=Strict cookie; any `Authorization` header turns cookie auth off;
  cookie writes without an `Origin` are refused; no CORS; nothing trusts
  `X-Forwarded-*`.
- **Authorization:** every route is scoped to the signed-in address; other
  users' records return 404; deliveries are scoped through their webhook.
- **Pages:** all 21 HTML sinks interpolate only formatted numbers, constants,
  validated chain hex or escaped text (Semgrep's HTML rules agree), the
  checkout validates `?plan=` and `?ref=`, the CSP forbids inline script,
  framing is refused, and `wallet.js` takes spender, token and chain from
  the server.
- **Webhook URL policy:** all 34 hostile inputs refused (encoded and short
  IPv4 forms, IPv4-mapped, NAT64, 6to4, Teredo, ULA, link-local, cloud
  metadata, userinfo tricks, other ports); every resolved address is checked
  and the same list is used to connect; no redirects; 5-second limit; the
  body is never read.
- **SQL:** every query parameterized; no LIKE; limits clamped.
- **Keys:** the keeper key is never logged or stored; the Permit2 script
  hides the key, checks the chain, and matches Permit2's EIP-712 domain.
- **Supply chain:** `npm audit` clean for keeper and API, dev dependencies
  included; every lockfile entry from npmjs with an integrity hash; install
  scripts only in esbuild and fsevents; no secrets in any commit on any ref
  (the two trufflehog hits are test fixtures such as `user:pw@8.8.8.8`).
- **Host:** Ubuntu 22.04 with unattended upgrades and no security updates
  pending; SSH by key only with fail2ban; the firewall denies inbound except
  22, 80 and 443; every Docker port is bound to loopback; Levy's containers
  run as non-root; `ops/.env` is 600 and root-owned; certificates valid to
  2026-12-25; the site's `security.txt` is valid to 2027-09-25.
- **Headers:** the pages send a strict CSP, `frame-ancestors 'none'`,
  X-Frame-Options, nosniff, a referrer policy and HSTS; plain HTTP redirects
  to HTTPS.

## Before outside merchants, before mainnet

Before soak 2 takes outside merchants: H-1, M-1, M-3 and M-4. Before
mainnet: M-2 and known item 14, M-5, L-7 to L-12, then the external audit,
which should cover this stack as well as the contracts.

## Status (2026-10-24)

Fixed before soak 2's day 0: H-1 (the signature covers the destination
webhook id; the merchant guide adds the `merchant` and plan checks), M-1
(the count is taken again just before the insert; URLs capped at 2,048
characters), M-3 (delivery ids are `{16 hex digits}-{row id}`, the prefix
fixed per database), M-4 (the receiver keeps bodies only for valid
signatures and caps what unsigned requests write, `/soak-hooks` is rate
limited in nginx, the soak report counts signed deliveries only), and M-5 in
part (PR #5 merged, which fixes L-5, L-6, the `set-keeper-key.sh` half of
L-7 and the action pinning in L-8). Each fix has a regression test; the
webhook-cap and signature tests fail without their fix. Everything else
listed above is still open; see `SECURITY_REVIEW.md` §9.
