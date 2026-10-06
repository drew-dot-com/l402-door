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
//
// With a wallet that can hold (`hold`), the invoice is a hold invoice for a
// preimage only the door knows. The buyer's payment is held, not taken, while
// the door buys the answer: on success the door keeps the answer and settles,
// which hands the buyer the preimage; on failure it cancels and the sats go
// back. So a buyer pays only for an answer that exists. The buyer's side is
// unchanged L402: pay, then retry with the preimage, and the kept answer is
// served. Without a holding wallet the invoice is plain and the buyer pays
// first (the credit is still burned only once the answer is bought).
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { mint, open, preimageMatches, parseAuth, sha256hex } from './token.mjs'

const ROUTE = 'extract'
const MEMO = `l402-door ${ROUTE}`

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
 * @param o {{wallet: {name: string, makeInvoice: Function, pay?: Function, makeHoldInvoice?: Function, settle?: Function, cancel?: Function, watchHeld?: Function},
 *   payerUrl: string, secret: Buffer|string, credits: import('./credits.mjs').Credits, priceSats: number, version?: string,
 *   hold?: boolean, holdFetchTimeoutMs?: number, invoiceTtlSec?: number, creditTtlSec?: number,
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
  // The buyer's wallet waits on a held payment; NWC clients give up after 60 s.
  const holdFetchTimeoutMs = o.holdFetchTimeoutMs ?? 40_000
  const payerUrl = o.payerUrl.replace(/\/+$/, '')
  const hold = !!o.hold
  if (hold && !(o.wallet.makeHoldInvoice && o.wallet.settle && o.wallet.cancel && o.wallet.watchHeld)) throw new Error('hold invoices need a wallet that can make, settle, cancel and watch them')

  const payer = async (path, timeoutMs = payerTimeoutMs) => {
    const r = await fetch(payerUrl + path, { signal: AbortSignal.timeout(timeoutMs) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  /** The TOON leg: the page, or why not. */
  async function buyPage(url, timeoutMs) {
    let r
    try { r = await payer(`/extract?url=${encodeURIComponent(url)}`, timeoutMs) } catch (e) { r = { status: 0, body: { code: 'payer_unreachable', error: String(e?.message ?? e) } } }
    return r.status === 200 && r.body?.ok ? { ok: true, body: r.body } : { ok: false, code: r.body?.code ?? r.status, error: r.body?.error ?? null }
  }

  let holdRefusedUntil = 0
  const pending = new Map() // payment hash -> {preimage, url, claims, expMs}: hold invoices sold, not yet paid
  const answers = new Map() // payment hash -> {body, exp}: bought while the payment was held, kept for the buyer
  const cancel = (h, why) => o.wallet.cancel(h).then(() => log(`hold ${h.slice(0, 12)} cancelled (${why}), nothing taken`), (e) => log(`hold ${h.slice(0, 12)} cancel FAILED (${why}): ${e?.message ?? e}`))

  /** A buyer's HTLC is held: buy the answer, then settle on success or cancel on failure. */
  async function held(ev) {
    const h = String(ev.paymentHash ?? '').toLowerCase()
    const p = pending.get(h)
    if (!p) {
      // One this door sold and then forgot (it restarted): without the
      // preimage it can never settle, so hand the sats straight back. A hold
      // the door did not sell is someone else's on a shared wallet; leave it.
      if (String(ev.description ?? '').startsWith(MEMO)) await cancel(h, 'unknown to this door')
      return
    }
    pending.delete(h)
    if (ev.msat != null && Number(ev.msat) < p.claims.p * 1000) return cancel(h, `underpaid ${ev.msat} msat`)
    if (o.credits.begin(h) !== 'ok') return cancel(h, 'credit already used')
    const r = await buyPage(p.url, holdFetchTimeoutMs)
    o.credits.release(h)
    if (!r.ok) {
      log(`extract ${p.url} FAILED upstream=${r.code} while held ${h.slice(0, 12)}`)
      return cancel(h, 'fetch failed')
    }
    answers.set(h, { body: r.body, exp: p.claims.exp })
    try { await o.wallet.settle(p.preimage); log(`hold ${h.slice(0, 12)} settled ${p.claims.p} sats, answer kept for the buyer`) } catch (e) { log(`hold ${h.slice(0, 12)} settle FAILED: ${e?.message ?? e}`) }
  }

  // An unpaid hold that expires is cancelled as well: if the door missed the
  // notice that it was paid, that is what releases the buyer's sats.
  function sweep() {
    const t = now()
    for (const [h, p] of pending) if (p.expMs <= t) { pending.delete(h); o.wallet.cancel(h).catch(() => {}) }
    for (const [h, a] of answers) if (a.exp * 1000 <= t) answers.delete(h)
  }
  const sweeper = hold ? setInterval(sweep, 30_000) : null
  sweeper?.unref()
  const watching = hold ? Promise.resolve(o.wallet.watchHeld((ev) => { held(ev).catch((e) => log('held', e?.message ?? e)) })) : null

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
    const exp = Math.floor(now() / 1000) + creditTtlSec
    const memo = MEMO
    let invoice, paymentHash, preimage
    let holding = hold && now() >= holdRefusedUntil
    if (holding) {
      preimage = randomBytes(32).toString('hex')
      paymentHash = sha256hex(Buffer.from(preimage, 'hex'))
      try {
        ;({ invoice } = await o.wallet.makeHoldInvoice({ sats: o.priceSats, memo, expirySec: invoiceTtlSec, paymentHash }))
      } catch (e) {
        // A wallet can refuse a hold it advertises (Rizful: none under 1000
        // sats). Sell a plain invoice instead, and stop asking for an hour.
        log(`hold invoice refused (${e?.message ?? e}), selling plain invoices for an hour`)
        holdRefusedUntil = now() + 3_600_000
        holding = false
      }
    }
    if (!holding) ({ invoice, paymentHash } = await o.wallet.makeInvoice({ sats: o.priceSats, memo, expirySec: invoiceTtlSec }))
    const claims = { h: paymentHash, r: ROUTE, q: sha256hex(url), p: o.priceSats, exp }
    if (holding) pending.set(paymentHash, { preimage, url, claims, expMs: now() + invoiceTtlSec * 1000 })
    const token = mint(o.secret, claims)
    res.setHeader('www-authenticate', `L402 macaroon="${token}", invoice="${invoice}"`)
    return send(res, 402, {
      ok: false, code: 'payment_required',
      price: { sats: o.priceSats }, invoice, macaroon: token, payment_hash: paymentHash,
      settlement: holding ? 'hold' : 'upfront',
      invoice_expires_in: invoiceTtlSec, credit_expires_at: exp,
      terms: holding
        ? 'One paid invoice buys one answer for this exact url. Your payment is holding, not taken, while the door buys the answer: if the fetch succeeds the payment settles and your wallet gets the preimage; if it fails the door cancels the payment and your sats return. Then retry with `Authorization: L402 <macaroon>:<preimage>`.'
        : 'One paid invoice buys one answer for this exact url. Retry with `Authorization: L402 <macaroon>:<preimage>`. If the fetch fails the credit stays valid until it expires; there are no Lightning refunds.',
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
    // An answer bought while the payment was held is served as kept. Anything
    // else (a plain invoice, or a hold settled before the door restarted) is
    // bought now.
    const kept = answers.get(claims.h)
    const r = kept ? { ok: true, body: kept.body } : await buyPage(url)
    if (!r.ok) {
      o.credits.release(claims.h)
      log(`extract ${url} FAILED upstream=${r.code} credit kept ${claims.h.slice(0, 12)}`)
      throw new Refusal(502, 'upstream_failed', 'the fetch failed and the credit was not spent, retry with the same credential', { upstream: { code: r.code ?? null, error: r.error ?? null }, credit_expires_at: claims.exp })
    }
    answers.delete(claims.h)
    o.credits.commit(claims.h, claims.exp)
    // The sidecar's budget is the operator's business, not the buyer's.
    const { budget: _budget, price, node, ...page } = r.body
    log(`extract ${url} -> ${page.status} sats=${claims.p} toon_units=${price?.units} hash=${claims.h.slice(0, 12)}`)
    return send(res, 200, { ...page, paid: { sats: claims.p, payment_hash: claims.h }, toon: { price, node } })
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://x')
    if (o.wallet.pay && req.method === 'POST' && u.pathname === '/mock/pay') {
      const preimage = await o.wallet.pay(u.searchParams.get('invoice') ?? '').catch((e) => { if (e?.code === 'cancelled') throw new Refusal(409, 'cancelled', 'the door cancelled the held payment, nothing was taken'); throw e })
      if (!preimage) throw new Refusal(404, 'unknown_invoice', 'the mock wallet never made that invoice')
      return send(res, 200, { ok: true, preimage })
    }
    if (req.method !== 'GET') throw new Refusal(405, 'method', 'GET only')
    if (u.pathname === '/health') {
      const p = await payer('/health').catch(() => null)
      return send(res, 200, { ok: true, version: o.version ?? null, wallet: o.wallet.name, settlement: hold ? 'hold' : 'upfront', price: { sats: o.priceSats }, payer_ok: !!p?.body?.ok, node: p?.body?.node ?? null })
    }
    if (u.pathname === '/extract') {
      const url = targetOf(u.searchParams)
      const auth = parseAuth(req.headers.authorization)
      return auth ? redeem(res, url, auth) : challenge(res, url)
    }
    throw new Refusal(404, 'not_found', 'GET /extract?url=  GET /health')
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof Refusal) return send(res, e.status, { ok: false, code: e.code, error: e.message, ...e.extra })
      log('error', e?.code ?? '', e?.message ?? e)
      if (!res.headersSent) send(res, 502, { ok: false, code: 'error', error: 'the door failed, nothing was spent' })
    })
  })
  server.on('close', () => { if (sweeper) clearInterval(sweeper); watching?.then((stop) => stop?.()).catch(() => {}) })
  // Resolves once the door is watching for held payments; a hold door that
  // cannot watch must not sell, or it would hold sats it never settles.
  server.ready = watching ? watching.then(() => undefined) : Promise.resolve()
  server.ready.catch(() => {})
  return server
}

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
