// The door itself: an HTTP handler that sells one TOON route for Lightning.
//
//   GET /extract?url=<absolute url>
//     no credential  -> 402, `WWW-Authenticate: L402 macaroon="…", invoice="…"`
//     L402 credential -> the page as markdown with its content hash, fetched
//                        by the node over the Anyone network
//
// The door holds no TOON channel and no TOON client. It asks the payer
// sidecar (anonfetch/payer) over HTTP, and the sidecar pays the route from
// the operator's channel under its own daily cap. So the buyer's sats land in
// the operator's wallet and the operator's USDC pays the route: the operator
// is the payer on the TOON side, and the price in sats is set by hand.
import http from 'node:http'
import { mint, open, preimageMatches, parseAuth, sha256hex } from './token.mjs'

const ROUTE = 'extract'

class Refusal extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra } }

function targetOf(q) {
  const raw = q.get('url')
  if (!raw) throw new Refusal(400, 'bad_url', 'url query parameter is required')
  let u
  try { u = new URL(raw) } catch { throw new Refusal(400, 'bad_url', 'url is not an absolute URL') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Refusal(400, 'bad_url', 'url must be http or https')
  return u.toString()
}

/**
 * @param o {{wallet: {name: string, makeInvoice: Function, pay?: Function}, payerUrl: string, secret: Buffer|string,
 *   credits: import('./credits.mjs').Credits, priceSats: number, version?: string, invoiceTtlSec?: number, creditTtlSec?: number,
 *   maxInvoicesPerMin?: number, minRemaining?: bigint, payerTimeoutMs?: number, now?: () => number, log?: Function}}
 */
export function createDoor(o) {
  const now = o.now ?? Date.now
  const log = o.log ?? (() => {})
  const invoiceTtlSec = o.invoiceTtlSec ?? 600
  const creditTtlSec = o.creditTtlSec ?? 3600
  const maxInvoicesPerMin = o.maxInvoicesPerMin ?? 60
  const minRemaining = o.minRemaining ?? 1000n
  const payerTimeoutMs = o.payerTimeoutMs ?? 70_000
  const payerUrl = o.payerUrl.replace(/\/+$/, '')

  const payer = async (path) => {
    const r = await fetch(payerUrl + path, { signal: AbortSignal.timeout(payerTimeoutMs) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  // An invoice costs the wallet a call and nothing stops a stranger asking for
  // them, so they are rationed per minute across all callers.
  let minute = 0, issued = 0
  function ration() {
    const m = Math.floor(now() / 60_000)
    if (m !== minute) { minute = m; issued = 0 }
    if (issued >= maxInvoicesPerMin) throw new Refusal(429, 'busy', 'too many invoices asked for this minute, try again shortly')
    issued += 1
  }

  /** Refuse before an invoice exists for anything the sidecar would refuse after it is paid. */
  async function sellable(url) {
    const b = await payer('/budget').catch(() => null)
    if (!b?.body?.ok) throw new Refusal(503, 'payer_unavailable', 'the door cannot reach its payer, nothing was charged')
    const { remaining, allowed_origins: origins } = b.body.budget
    if (BigInt(remaining) < minRemaining) throw new Refusal(503, 'sold_out', 'the door has spent its daily budget, nothing was charged')
    if (origins?.length && !origins.includes(new URL(url).origin)) throw new Refusal(403, 'origin_not_allowed', `${new URL(url).origin} is not sold here`)
  }

  async function challenge(res, url) {
    await sellable(url)
    ration()
    const { invoice, paymentHash } = await o.wallet.makeInvoice({ sats: o.priceSats, memo: `l402-door ${ROUTE}`, expirySec: invoiceTtlSec })
    const exp = Math.floor(now() / 1000) + creditTtlSec
    const token = mint(o.secret, { h: paymentHash, r: ROUTE, q: sha256hex(url), p: o.priceSats, exp })
    res.setHeader('www-authenticate', `L402 macaroon="${token}", invoice="${invoice}"`)
    return send(res, 402, {
      ok: false, code: 'payment_required',
      price: { sats: o.priceSats }, invoice, macaroon: token, payment_hash: paymentHash,
      invoice_expires_in: invoiceTtlSec, credit_expires_at: exp,
      terms: 'One paid invoice buys one answer for this exact url. Retry with `Authorization: L402 <macaroon>:<preimage>`. If the fetch fails the credit stays valid until it expires; there are no Lightning refunds.',
    })
  }

  async function redeem(res, url, auth) {
    const claims = open(o.secret, auth.token)
    if (!claims) throw new Refusal(401, 'bad_token', 'the macaroon was not issued by this door')
    if (claims.exp <= now() / 1000) throw new Refusal(401, 'credit_expired', 'this credit has expired, ask again for a new invoice')
    if (claims.r !== ROUTE || claims.q !== sha256hex(url)) throw new Refusal(403, 'wrong_request', 'this credit was sold for a different request')
    if (!preimageMatches(auth.preimage, claims.h)) throw new Refusal(401, 'bad_preimage', 'the preimage does not match the invoice')
    const held = o.credits.begin(claims.h)
    if (held === 'spent') throw new Refusal(409, 'credit_spent', 'this credit has already bought its answer')
    if (held === 'in_flight') throw new Refusal(409, 'credit_in_flight', 'this credit is buying its answer right now')
    let r
    try { r = await payer(`/extract?url=${encodeURIComponent(url)}`) } catch (e) { r = { status: 0, body: { code: 'payer_unreachable', error: String(e?.message ?? e) } } }
    if (r.status !== 200 || !r.body?.ok) {
      o.credits.release(claims.h)
      log(`extract ${url} FAILED upstream=${r.body?.code ?? r.status} credit kept ${claims.h.slice(0, 12)}`)
      throw new Refusal(502, 'upstream_failed', 'the fetch failed and the credit was not spent, retry with the same credential', { upstream: { code: r.body?.code ?? null, error: r.body?.error ?? null }, credit_expires_at: claims.exp })
    }
    o.credits.commit(claims.h, claims.exp)
    // The sidecar's budget is the operator's business, not the buyer's.
    const { budget: _budget, price, node, ...page } = r.body
    log(`extract ${url} -> ${page.status} sats=${claims.p} toon_units=${price?.units} hash=${claims.h.slice(0, 12)}`)
    return send(res, 200, { ...page, paid: { sats: claims.p, payment_hash: claims.h }, toon: { price, node } })
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://x')
    if (o.wallet.pay && req.method === 'POST' && u.pathname === '/mock/pay') {
      const preimage = o.wallet.pay(u.searchParams.get('invoice') ?? '')
      if (!preimage) throw new Refusal(404, 'unknown_invoice', 'the mock wallet never made that invoice')
      return send(res, 200, { ok: true, preimage })
    }
    if (req.method !== 'GET') throw new Refusal(405, 'method', 'GET only')
    if (u.pathname === '/health') {
      const p = await payer('/health').catch(() => null)
      return send(res, 200, { ok: true, version: o.version ?? null, wallet: o.wallet.name, price: { sats: o.priceSats }, payer_ok: !!p?.body?.ok, node: p?.body?.node ?? null })
    }
    if (u.pathname === '/extract') {
      const url = targetOf(u.searchParams)
      const auth = parseAuth(req.headers.authorization)
      return auth ? redeem(res, url, auth) : challenge(res, url)
    }
    throw new Refusal(404, 'not_found', 'GET /extract?url=  GET /health')
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof Refusal) return send(res, e.status, { ok: false, code: e.code, error: e.message, ...e.extra })
      log('error', e?.code ?? '', e?.message ?? e)
      if (!res.headersSent) send(res, 502, { ok: false, code: 'error', error: 'the door failed, nothing was spent' })
    })
  })
}

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
