// A Lightning-paying sidecar for an agent runtime: the same HTTP contract as
// anonfetch's payer (`GET /extract?url=` -> the page), but it buys from an
// l402-door and pays the invoice over Nostr Wallet Connect. An agent that
// already talks to the TOON payer (hermes-toon) talks to this one unchanged;
// only what pays underneath differs.
//
// Spending rules, enforced before an invoice is paid: a daily cap and a
// per-answer ceiling, both in sats. Anything that can reach the port can
// spend up to the cap with no per-call confirmation, so it binds to loopback.
import http from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseAuth } from '../token.mjs'

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

class Refusal extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra } }

/**
 * @param o {{doorUrl: string, payInvoice: (invoice: string) => Promise<string>, file: string,
 *   dailyCapSats: number, maxPriceSats: number, now?: () => number, log?: Function, timeoutMs?: number}}
 *   payInvoice resolves to the payment preimage (hex).
 */
export function createLnPayer(o) {
  const now = o.now ?? Date.now
  const log = o.log ?? (() => {})
  const door = o.doorUrl.replace(/\/+$/, '')
  const timeoutMs = o.timeoutMs ?? 120_000

  let state = { day: dayOf(now()), spent: 0, count: 0, total_spent: 0, total_count: 0 }
  if (existsSync(o.file)) { try { state = { ...state, ...JSON.parse(readFileSync(o.file, 'utf8')) } } catch { /* a bad file starts a fresh day */ } }
  const roll = () => { const d = dayOf(now()); if (state.day !== d) state = { ...state, day: d, spent: 0, count: 0 } }
  const view = () => { roll(); return { day: state.day, spent: state.spent, cap: o.dailyCapSats, remaining: Math.max(0, o.dailyCapSats - state.spent), count: state.count, total_spent: state.total_spent, total_count: state.total_count, max_price: o.maxPriceSats, unit: 'sats' } }
  const record = (sats) => {
    roll(); state.spent += sats; state.count += 1; state.total_spent += sats; state.total_count += 1
    mkdirSync(dirname(o.file), { recursive: true }); writeFileSync(o.file, JSON.stringify(state, null, 2))
  }

  const ask = async (url, headers = {}) => {
    const r = await fetch(`${door}/extract?url=${encodeURIComponent(url)}`, { headers, signal: AbortSignal.timeout(timeoutMs) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  /** Challenge, pay, redeem. One answer, or a refusal that says what was and was not paid. */
  async function buy(url) {
    const c = await ask(url)
    if (c.status !== 402 || !c.body?.invoice || !c.body?.macaroon) throw new Refusal(502, 'door_refused', `${c.body?.code ?? c.status}: ${c.body?.error ?? 'no challenge'}`, { door: c.body?.code ?? null })
    const sats = Number(c.body.price?.sats)
    roll()
    if (!(sats >= 1)) throw new Refusal(502, 'bad_price', 'the door quoted no price')
    if (sats > o.maxPriceSats) throw new Refusal(402, 'price_too_high', `door price ${sats} sats exceeds LN_MAX_PRICE_SATS ${o.maxPriceSats}`)
    if (state.spent + sats > o.dailyCapSats) throw new Refusal(402, 'budget_exhausted', `daily cap ${o.dailyCapSats} sats reached (${state.spent} spent today, ${sats} asked)`)
    const t0 = now()
    let preimage
    try { preimage = await o.payInvoice(c.body.invoice) } catch (e) {
      // A door selling on hold invoices cancels the payment when its fetch
      // fails, which reaches this side as a failed payment.
      throw new Refusal(502, 'payment_failed', `the invoice was not paid: ${e?.message ?? e}`, { door_settlement: c.body.settlement ?? null, payment_hash: c.body.payment_hash ?? null })
    }
    record(sats)
    const auth = { authorization: `L402 ${c.body.macaroon}:${preimage}` }
    let r = await ask(url, auth)
    if (r.status === 502 && r.body?.code === 'upstream_failed') r = await ask(url, auth) // the credit is still good: one retry
    if (r.status !== 200 || !r.body?.ok) throw new Refusal(502, 'door_failed', `paid ${sats} sats, then ${r.body?.code ?? r.status}: ${r.body?.error ?? ''}`, { paid: { sats, payment_hash: c.body.payment_hash }, macaroon: c.body.macaroon, preimage, credit_expires_at: c.body.credit_expires_at })
    log(`extract ${url} -> ${r.body.status} sats=${sats} ms=${now() - t0} spent_today=${state.spent}`)
    return { ...r.body, budget: view() }
  }

  let chain = Promise.resolve()
  const serialize = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p }

  const send = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b) }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://x')
    if (req.method !== 'GET') throw new Refusal(405, 'method', 'GET only')
    if (u.pathname === '/health') {
      const h = await fetch(`${door}/health`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json()).catch(() => null)
      return send(res, 200, { ok: true, door, door_ok: !!h?.ok, door_price: h?.price ?? null, node: h?.node ?? null, budget: view() })
    }
    if (u.pathname === '/budget') return send(res, 200, { ok: true, budget: view() })
    if (u.pathname === '/extract') {
      const raw = u.searchParams.get('url')
      let url
      try { url = new URL(raw).toString() } catch { throw new Refusal(400, 'bad_url', 'url must be an absolute URL') }
      return send(res, 200, await serialize(() => buy(url)))
    }
    throw new Refusal(404, 'not_found', 'GET /extract?url=  GET /health  GET /budget')
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof Refusal) return send(res, e.status, { ok: false, code: e.code, error: e.message, ...e.extra })
      log('error', e?.code ?? '', e?.message ?? e)
      if (!res.headersSent) send(res, 502, { ok: false, code: e?.code ?? 'error', error: String(e?.message ?? e) })
    })
  })
}

// Only here so the test can prove the header shape the door expects.
export { parseAuth }
