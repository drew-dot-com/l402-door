import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createDoor } from '../door.mjs'
import { Credits } from '../credits.mjs'
import { MockWallet, PaymentCancelled } from '../wallet-mock.mjs'
import { mint, open, parseAuth, preimageMatches, sha256hex } from '../token.mjs'
import { importMacaroon } from 'macaroon'

const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${server.address().port}`)))
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'door-')), 'spent.jsonl')

/** A stand-in for the payer sidecar: counts paid extracts, can be told to fail or run dry. */
function stubPayer() {
  const s = { paid: 0, fail: false, remaining: '100000', origins: [] }
  s.server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const budget = { remaining: s.remaining, allowed_origins: s.origins }
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (u.pathname === '/budget') return json(200, { ok: true, budget })
    if (u.pathname === '/health') return json(200, { ok: true, node: { edge: 'https://edge.test', destination: 'g.drew.anon' } })
    if (u.pathname === '/extract') {
      if (s.fail) return json(502, { ok: false, code: 'node_refused', error: 'T01 peer timeout' })
      s.paid += 1
      return json(200, { ok: true, url: u.searchParams.get('url'), status: 200, title: 'T', content: '# T', content_hash: 'abc', price: { units: '1000', asset: 'USDC' }, node: { destination: 'g.drew.anon' }, budget })
    }
    json(404, { ok: false })
  })
  return s
}

async function rig(t, over = {}) {
  const payer = stubPayer()
  const payerUrl = await listen(payer.server)
  const wallet = new MockWallet({ hold: !!over.hold, holdMinSats: over.holdMinSats })
  const clock = { ms: Date.UTC(2026, 9, 5) }
  const file = tmp()
  const door = createDoor({ wallet, payerUrl, secret: Buffer.from('s'.repeat(64), 'hex'), credits: new Credits({ file, now: () => clock.ms }), priceSats: 5, now: () => clock.ms, ...over })
  await door.ready
  const base = await listen(door)
  t.after(() => { door.close(); payer.server.close() })
  const get = async (p, headers = {}) => { const r = await fetch(base + p, { headers }); return { status: r.status, headers: r.headers, body: await r.json() } }
  const buy = async (url) => {
    const c = await get(`/extract?url=${encodeURIComponent(url)}`)
    assert.equal(c.status, 402)
    return { auth: { authorization: `L402 ${c.body.macaroon}:${await wallet.pay(c.body.invoice)}` }, challenge: c }
  }
  return { payer, wallet, clock, base, get, buy, file }
}

const PAGE = 'https://example.com/a'
const path_ = (url) => `/extract?url=${encodeURIComponent(url)}`

test('token: a real macaroon, round trip, tamper, wrong secret', () => {
  const h = 'aa'.repeat(32)
  const claims = { h, r: 'extract', q: 'bb'.repeat(32), p: 5, exp: 10 }
  const t = mint('k', claims)
  assert.deepEqual(open('k', t), { v: 1, ...claims })
  assert.equal(open('other', t), null)
  // What the clients require: lnget base64-decodes the field and unmarshals a
  // libmacaroons v2 macaroon whose identifier is aperture's L402 layout;
  // 402-mcp only accepts base64 characters (no dots).
  assert.match(t, /^[A-Za-z0-9+/=]+$/)
  const m = importMacaroon(new Uint8Array(Buffer.from(t, 'base64')))
  const id = Buffer.from(m.identifier)
  assert.equal(id.length, 66)
  assert.equal(id.readUInt16BE(0), 0)
  assert.equal(id.subarray(2, 34).toString('hex'), h)
  assert.deepEqual(m.caveats.map((c) => Buffer.from(c.identifier).toString()), ['route = extract', `request = ${claims.q}`, 'price_sats = 5', 'expires = 10'])
  // Editing a caveat byte for byte breaks the HMAC chain; so does adding one; so does another door's key.
  const raw = Buffer.from(t, 'base64')
  const at = raw.indexOf('price_sats = 5')
  assert.ok(at > 0)
  const edited = Buffer.from(raw); edited.write('price_sats = 0', at)
  assert.equal(open('k', edited.toString('base64')), null)
  const extended = importMacaroon(new Uint8Array(raw))
  extended.addFirstPartyCaveat('expires = 99')
  assert.equal(open('k', Buffer.from(extended.exportBinary()).toString('base64')), null)
  // A client may echo the field in url-safe base64.
  assert.deepEqual(open('k', raw.toString('base64url')), { v: 1, ...claims })
  assert.equal(open('k', 'junk'), null)
  assert.equal(open('k', ''), null)
})

test('token: auth header and preimage', () => {
  assert.deepEqual(parseAuth('L402 abc.def:00ff'), { token: 'abc.def', preimage: '00ff' })
  assert.deepEqual(parseAuth('LSAT abc:00'), { token: 'abc', preimage: '00' })
  assert.equal(parseAuth('Bearer abc:00'), null)
  assert.equal(parseAuth('L402 nocolon'), null)
  assert.equal(parseAuth(undefined), null)
  const pre = '11'.repeat(32)
  assert.equal(preimageMatches(pre, sha256hex(Buffer.from(pre, 'hex'))), true)
  assert.equal(preimageMatches('22'.repeat(32), sha256hex(Buffer.from(pre, 'hex'))), false)
  assert.equal(preimageMatches('zz', 'aa'), false)
})

test('challenge, pay, answer; the credit buys exactly one answer', async (t) => {
  const { payer, get, buy } = await rig(t)
  const { auth, challenge } = await buy(PAGE)
  assert.match(challenge.headers.get('www-authenticate'), /^L402 macaroon="[^"]+", invoice="lnmock5n1[0-9a-f]{64}"$/)
  assert.deepEqual(challenge.body.price, { sats: 5 })
  assert.equal(payer.paid, 0, 'nothing is paid on the TOON side before the invoice is')

  const a = await get(path_(PAGE), auth)
  assert.equal(a.status, 200)
  assert.equal(a.body.content, '# T')
  assert.equal(a.body.paid.sats, 5)
  assert.equal(a.body.toon.price.units, '1000')
  assert.equal(a.body.budget, undefined, "the operator's budget does not leak to the buyer")
  assert.equal(payer.paid, 1)

  const again = await get(path_(PAGE), auth)
  assert.equal(again.status, 409)
  assert.equal(again.body.code, 'credit_spent')
  assert.equal(payer.paid, 1)
})

test('refuses a wrong preimage, a forged token, and a credit sold for another url', async (t) => {
  const { payer, get, buy } = await rig(t)
  const { auth, challenge } = await buy(PAGE)
  const bad = await get(path_(PAGE), { authorization: `L402 ${challenge.body.macaroon}:${'00'.repeat(32)}` })
  assert.equal(bad.body.code, 'bad_preimage')
  const forged = await get(path_(PAGE), { authorization: `L402 x.y:${'00'.repeat(32)}` })
  assert.equal(forged.body.code, 'bad_token')
  const other = await get(path_('https://example.com/b'), auth)
  assert.equal(other.status, 403)
  assert.equal(other.body.code, 'wrong_request')
  assert.equal(payer.paid, 0)
})

test('a failed fetch keeps the credit; the retry spends it', async (t) => {
  const { payer, get, buy } = await rig(t)
  const { auth } = await buy(PAGE)
  payer.fail = true
  const f = await get(path_(PAGE), auth)
  assert.equal(f.status, 502)
  assert.equal(f.body.code, 'upstream_failed')
  assert.equal(f.body.upstream.code, 'node_refused')
  payer.fail = false
  assert.equal((await get(path_(PAGE), auth)).status, 200)
  assert.equal(payer.paid, 1)
})

test('an expired credit is refused', async (t) => {
  const { payer, clock, get, buy } = await rig(t, { creditTtlSec: 60 })
  const { auth } = await buy(PAGE)
  clock.ms += 61_000
  const r = await get(path_(PAGE), auth)
  assert.equal(r.status, 401)
  assert.equal(r.body.code, 'credit_expired')
  assert.equal(payer.paid, 0)
})

test('no invoice is sold when the payer is dry, the origin is not allowed, or the payer is down', async (t) => {
  const { payer, wallet, get } = await rig(t)
  payer.remaining = '0'
  assert.equal((await get(path_(PAGE))).body.code, 'sold_out')
  payer.remaining = '100000'
  payer.origins = ['https://allowed.test']
  assert.equal((await get(path_(PAGE))).body.code, 'origin_not_allowed')
  payer.server.close()
  await new Promise((ok) => payer.server.once('close', ok))
  assert.equal((await get(path_(PAGE))).body.code, 'payer_unavailable')
  assert.equal(wallet.invoices.size, 0)
})

test('invoices are rationed per minute', async (t) => {
  const { clock, get } = await rig(t, { maxInvoicesPerMin: 2 })
  assert.equal((await get(path_(PAGE))).status, 402)
  assert.equal((await get(path_(PAGE))).status, 402)
  assert.equal((await get(path_(PAGE))).status, 429)
  clock.ms += 60_000
  assert.equal((await get(path_(PAGE))).status, 402)
})

test('spent credits survive a restart and expired ones are pruned', () => {
  const file = tmp()
  let ms = 1_000_000
  const a = new Credits({ file, now: () => ms })
  assert.equal(a.begin('h1'), 'ok')
  assert.equal(a.begin('h1'), 'in_flight')
  a.commit('h1', 2000)
  a.begin('h2'); a.release('h2')
  const b = new Credits({ file, now: () => ms })
  assert.equal(b.begin('h1'), 'spent')
  assert.equal(b.begin('h2'), 'ok')
  ms = 2_001_000
  assert.equal(new Credits({ file, now: () => ms }).begin('h1'), 'ok')
})

test('bad urls and the mock pay route', async (t) => {
  const { base, get } = await rig(t)
  assert.equal((await get('/extract')).body.code, 'bad_url')
  assert.equal((await get('/extract?url=ftp://x')).body.code, 'bad_url')
  const c = await get(path_(PAGE))
  const p = await (await fetch(`${base}/mock/pay?invoice=${c.body.invoice}`, { method: 'POST' })).json()
  assert.equal(preimageMatches(p.preimage, c.body.payment_hash), true)
  assert.equal((await fetch(`${base}/mock/pay?invoice=nope`, { method: 'POST' })).status, 404)
  const h = await get('/health')
  assert.equal(h.body.wallet, 'mock')
  assert.equal(h.body.payer_ok, true)
})

test('hold: the payment is held while the door buys, settles on success, and the kept answer is served', async (t) => {
  const { payer, wallet, get } = await rig(t, { hold: true })
  const c = await get(path_(PAGE))
  assert.equal(c.status, 402)
  assert.equal(c.body.settlement, 'hold')
  assert.match(c.body.invoice, /^lnmockhold5n1[0-9a-f]{64}$/)
  assert.equal(payer.paid, 0, 'nothing is bought before the payment is held')

  const preimage = await wallet.pay(c.body.invoice) // resolves only once the door settled
  assert.equal(preimageMatches(preimage, c.body.payment_hash), true)
  assert.equal(payer.paid, 1, 'the answer was bought while the payment was held')

  const auth = { authorization: `L402 ${c.body.macaroon}:${preimage}` }
  const a = await get(path_(PAGE), auth)
  assert.equal(a.status, 200)
  assert.equal(a.body.content, '# T')
  assert.equal(a.body.paid.sats, 5)
  assert.equal(payer.paid, 1, 'the kept answer is served, not bought again')
  assert.equal((await get(path_(PAGE), auth)).body.code, 'credit_spent')
})

test('hold: a failed fetch cancels the payment, so nothing is taken', async (t) => {
  const { payer, wallet, get } = await rig(t, { hold: true })
  const c = await get(path_(PAGE))
  payer.fail = true
  await assert.rejects(wallet.pay(c.body.invoice), PaymentCancelled)
  assert.equal(wallet.cancelled.has(c.body.payment_hash), true)
  assert.equal(payer.paid, 0)
  // Paying the same invoice again is refused too: it is cancelled for good.
  await assert.rejects(wallet.pay(c.body.invoice), PaymentCancelled)
})

test('hold: a held payment the door did not sell is cancelled only when it carries the door memo', async (t) => {
  const { payer, wallet } = await rig(t, { hold: true })
  const forgotten = 'ab'.repeat(32), foreign = 'cd'.repeat(32)
  wallet.onHeld({ paymentHash: forgotten, msat: 5000, description: 'l402-door extract' })
  wallet.onHeld({ paymentHash: foreign, msat: 5000, description: 'someone else' })
  await new Promise((ok) => setTimeout(ok, 20))
  assert.equal(wallet.cancelled.has(forgotten), true)
  assert.equal(wallet.cancelled.has(foreign), false)
  assert.equal(payer.paid, 0)
})

test('hold: an underpaid HTLC is cancelled without buying', async (t) => {
  const { payer, wallet, get } = await rig(t, { hold: true })
  const c = await get(path_(PAGE))
  wallet.onHeld({ paymentHash: c.body.payment_hash, msat: 4000, description: 'l402-door extract' })
  await new Promise((ok) => setTimeout(ok, 20))
  assert.equal(wallet.cancelled.has(c.body.payment_hash), true)
  assert.equal(payer.paid, 0)
})

test('hold: a door that restarted after settling buys the answer on redeem', async (t) => {
  const { payer, wallet, get } = await rig(t, { hold: true })
  const c = await get(path_(PAGE))
  const preimage = await wallet.pay(c.body.invoice)
  assert.equal(payer.paid, 1)
  // A fresh door with the same secret and empty memory: the kept answer is gone.
  const file = tmp()
  const door2 = createDoor({ wallet: new MockWallet(), payerUrl: `http://127.0.0.1:${payer.server.address().port}`, secret: Buffer.from('s'.repeat(64), 'hex'), credits: new Credits({ file, now: () => Date.UTC(2026, 9, 5) }), priceSats: 5, now: () => Date.UTC(2026, 9, 5) })
  const base2 = await listen(door2)
  t.after(() => door2.close())
  const r = await fetch(`${base2}${path_(PAGE)}`, { headers: { authorization: `L402 ${c.body.macaroon}:${preimage}` } })
  assert.equal(r.status, 200)
  assert.equal(payer.paid, 2)
})

test('a hold door refuses a wallet that cannot hold', () => {
  assert.throws(() => createDoor({ wallet: { name: 'x', makeInvoice: async () => ({}) }, payerUrl: 'http://x', secret: 'k', credits: null, priceSats: 5, hold: true }), /hold invoices need/)
})

test('hold: a wallet that refuses the hold gets a plain invoice instead, and is not asked again for an hour', async (t) => {
  const { payer, wallet, clock, get } = await rig(t, { hold: true, holdMinSats: 1000 })
  const c = await get(path_(PAGE))
  assert.equal(c.status, 402)
  assert.equal(c.body.settlement, 'upfront')
  assert.match(c.body.invoice, /^lnmock5n1/)
  const auth = { authorization: `L402 ${c.body.macaroon}:${await wallet.pay(c.body.invoice)}` }
  assert.equal((await get(path_(PAGE), auth)).status, 200)
  assert.equal(payer.paid, 1)
  wallet.holdMinSats = 0
  assert.equal((await get(path_(PAGE))).body.settlement, 'upfront', 'still plain within the hour')
  clock.ms += 3_600_000
  assert.equal((await get(path_(PAGE))).body.settlement, 'hold')
})
