# l402-door

A Lightning front door for a TOON node. An agent pays a Lightning invoice
(L402: `402`, invoice, macaroon), and the door pays the TOON route from the
operator's own channel. No connector change; the door is an app beside the node.

Live: `https://l402.mainnet.toonprotocol.dev` sells paid anonymous fetch
(`g.drew.anon`, the page as markdown with its content hash, fetched over the
Anyone network) for 5 sats.

```
GET /extract?url=<absolute url>
  no credential   -> 402  WWW-Authenticate: L402 macaroon="…", invoice="…"
  L402 credential -> 200  the page, plus what was paid on both sides
GET /health
```

Pay the invoice, then retry with `Authorization: L402 <macaroon>:<preimage>`.

## How it works

1. The door asks its wallet for an invoice over Nostr Wallet Connect and mints
   a real macaroon (libmacaroons v2, base64) whose identifier is aperture's
   L402 layout (version, payment hash, token id) and whose first-party caveats
   bind it to this request, this URL, this price and an expiry. Clients that
   decode the field as a macaroon (lnget, aperture) accept it; clients that
   keep it opaque (402-mcp) echo it back.
2. The buyer pays. With a wallet that can hold (the default when it can), the
   invoice is a **hold invoice** for a preimage only the door knows, so the
   payment is held, not taken. The door sees the HTLC held and buys the answer
   through the TOON payer sidecar (`anonfetch/payer`), which holds the
   operator's x402 channel and pays the route.
3. If the fetch succeeds the door keeps the answer and settles the invoice,
   which hands the buyer the preimage. If it fails, or takes longer than
   `L402_HOLD_FETCH_TIMEOUT_MS`, the door cancels and the sats go back. A buyer
   pays only for an answer that exists.
4. The buyer retries with `Authorization: L402 <macaroon>:<preimage>`.
   `sha256(preimage)` must equal the hash in the token, so the door verifies
   without asking the wallet, and serves the kept answer. The credit buys one
   answer.

A wallet can refuse a hold it advertises: Rizful refuses any under 1000 sats,
so at the default 5 sats the door falls back to a plain invoice (and stops
asking for an hour). Selling on holds at small prices needs a wallet without
that floor.

The buyer's side is plain L402 either way; the 402 body says which kind the
invoice is (`settlement: "hold"` or `"upfront"`). A held payment keeps the
buyer's wallet waiting while the door fetches, so the fetch is cut off well
inside the 60 s that NWC payers wait.

With a plain invoice (`L402_HOLD=off`, or a wallet that cannot hold) the
buyer pays first, and the credit is burned only when the TOON leg succeeded:
a failed fetch leaves it valid until it expires, so the buyer retries with the
same credential. There are no Lightning refunds in that mode. If the door
restarts after settling a hold, the same retry buys the answer then.

Money: the buyer's sats land in the operator's Lightning wallet; the
operator's USDC pays the route. Prices are a hand-set number of whole sats.
On the TOON side the payer is the operator, so this proves outside Lightning
demand, not a third-party TOON payer. A fetch that fails after the route was
paid costs the operator, not the buyer.

## Run

```sh
npm install
L402_WALLET=nwc L402_NWC_FILE=/path/to/nwc.secret L402_PAYER_URL=http://127.0.0.1:3502 node server.mjs
```

The NWC connection must be receive-only (`make_invoice`, `lookup_invoice`,
and for hold invoices `make_hold_invoice`, `settle_hold_invoice`,
`cancel_hold_invoice` plus `hold_invoice_accepted` notifications); the door
refuses to start on one that can `pay_invoice`. `L402_WALLET=mock`
moves no money and hands out preimages, and only runs bound to loopback.
`deploy/docker-compose.yml` is the two-container layout on the node.

| env | default | what |
| --- | --- | --- |
| `L402_WALLET` | required | `nwc` or `mock` |
| `L402_NWC_FILE` | `<L402_HOME>/nwc.secret` | the `nostr+walletconnect://` string |
| `L402_PAYER_URL` | `http://127.0.0.1:3502` | the TOON payer sidecar |
| `L402_PRICE_SATS` | `5` | whole sats per answer |
| `L402_PORT` / `L402_BIND` | `3503` / `127.0.0.1` | |
| `L402_HOME` | `~/.l402-door` | signing secret, spent credits |
| `L402_INVOICE_TTL_SEC` / `L402_CREDIT_TTL_SEC` | `600` / `3600` | |
| `L402_MAX_INVOICES_PER_MIN` | `60` | unpaid invoices are rationed across all callers |
| `L402_HOLD` | `auto` | `auto` holds when the wallet can, `on` requires it, `off` sells plain invoices |
| `L402_HOLD_FETCH_TIMEOUT_MS` | `40000` | how long a held payment waits on the fetch |

No invoice is sold when the payer sidecar is unreachable, has spent its daily
cap, or does not allow the URL's origin.

## Buying

`client/` is a Lightning-paying sidecar for an agent runtime: the same
`GET /extract?url=` contract as the TOON payer, but it buys from a door and
pays the invoice over NWC with a daily cap in sats. An agent already using the
TOON payer (hermes-toon) switches by changing one URL.

```sh
LN_NWC_FILE=/path/to/nwc-send.secret L402_DOOR=https://l402.mainnet.toonprotocol.dev node client/server.mjs
```

`scripts/buy.mjs <url>` buys one answer by hand from a wallet that shows the
payment preimage.

## Test

```sh
npm test
```
