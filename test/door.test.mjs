import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createDoor } from '../door.mjs'
import { Credits } from '../credits.mjs'
import { MockWallet } from '../wallet-mock.mjs'
import { mint, open, parseAuth, preimageMatches, sha256hex } from '../token.mjs'

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
  const wallet = new MockWallet()
  const clock = { ms: Date.UTC(2026, 9, 5) }
  const file = tmp()
  const door = createDoor({ wallet, payerUrl, secret: Buffer.from('s'.repeat(64), 'hex'), credits: new Credits({ file, now: () => clock.ms }), priceSats: 5, now: () => clock.ms, ...over })
  const base = await listen(door)
  t.after(() => { door.close(); payer.server.close() })
  const get = async (p, headers = {}) => { const r = await fetch(base + p, { headers }); return { status: r.status, headers: r.headers, body: await r.json() } }
  const buy = async (url) => {
    const c = await get(`/extract?url=${encodeURIComponent(url)}`)
    assert.equal(c.status, 402)
    return { auth: { authorization: `L402 ${c.body.macaroon}:${wallet.pay(c.body.invoice)}` }, challenge: c }
  }
  return { payer, wallet, clock, base, get, buy, file }
}

const PAGE = 'https://example.com/a'
const path_ = (url) => `/extract?url=${encodeURIComponent(url)}`

test('token: round trip, tamper, wrong secret', () => {
  const claims = { h: 'aa', r: 'extract', q: 'bb', p: 5, exp: 10 }
  const t = mint('k', claims)
  assert.deepEqual(open('k', t), { v: 1, ...claims })
  assert.equal(open('other', t), null)
  const [body, mac] = t.split('.')
  const forged = Buffer.from(JSON.stringify({ v: 1, ...claims, p: 0 })).toString('base64url')
  assert.equal(open('k', `${forged}.${mac}`), null)
  assert.equal(open('k', body), null)
  assert.equal(open('k', 'junk'), null)
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
