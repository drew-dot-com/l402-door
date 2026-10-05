# l402-door

A Lightning front door for a TOON node. An agent pays a Lightning invoice
(L402: `402`, invoice, macaroon), and the door pays the TOON route from the
operator's own channel. No connector change; the door is an app beside the node.

Live: `https://l402.167-233-221-236.sslip.io` sells paid anonymous fetch
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

1. The door asks its wallet for an invoice over Nostr Wallet Connect and signs
   a token binding the payment hash to this request, this URL, this price and
   an expiry. The token rides in the L402 `macaroon` field, which clients treat
   as opaque.
2. The buyer pays and retries with the preimage. `sha256(preimage)` must equal
   the hash in the token, so the door verifies without asking the wallet.
3. The door asks the TOON payer sidecar (`anonfetch/payer`) for the page. The
   sidecar holds the operator's x402 channel and pays the route.
4. The credit is burned only when the TOON leg succeeded. A failed fetch leaves
   it valid until it expires, so the buyer retries with the same credential.
   There are no Lightning refunds.

Money: the buyer's sats land in the operator's Lightning wallet; the
operator's USDC pays the route. Prices are a hand-set number of whole sats.
On the TOON side the payer is the operator, so this proves outside Lightning
demand, not a third-party TOON payer.

## Run

```sh
npm install
L402_WALLET=nwc L402_NWC_FILE=/path/to/nwc.secret L402_PAYER_URL=http://127.0.0.1:3502 node server.mjs
```

The NWC connection must be receive-only (`make_invoice`, `lookup_invoice`);
the door refuses to start on one that can `pay_invoice`. `L402_WALLET=mock`
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

No invoice is sold when the payer sidecar is unreachable, has spent its daily
cap, or does not allow the URL's origin.

## Buying

`client/` is a Lightning-paying sidecar for an agent runtime: the same
`GET /extract?url=` contract as the TOON payer, but it buys from a door and
pays the invoice over NWC with a daily cap in sats. An agent already using the
TOON payer (hermes-toon) switches by changing one URL.

```sh
LN_NWC_FILE=/path/to/nwc-send.secret L402_DOOR=https://l402.167-233-221-236.sslip.io node client/server.mjs
```

`scripts/buy.mjs <url>` buys one answer by hand from a wallet that shows the
payment preimage.

## Test

```sh
npm test
```
