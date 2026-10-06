import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createDoor } from '../door.mjs'
import { Credits } from '../credits.mjs'
import { MockWallet } from '../wallet-mock.mjs'
import { createLnPayer } from '../client/lnpayer.mjs'

const listen = (s) => new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${s.address().port}`)))
const tmp = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lnp-')), n)

/** A whole chain: stub TOON payer <- door on a mock wallet <- Lightning payer whose wallet "pays" via the door's mock. */
async function rig(t, over = {}) {
  const toon = { paid: 0, fail: false }
  const toonPayer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (u.pathname === '/budget') return json(200, { ok: true, budget: { remaining: '100000', allowed_origins: [] } })
    if (u.pathname === '/health') return json(200, { ok: true, node: { destination: 'g.drew.anon' } })
    if (toon.fail) { toon.fail = false; return json(502, { ok: false, code: 'node_refused', error: 'T00 exit timeout' }) }
    toon.paid += 1
    return json(200, { ok: true, url: u.searchParams.get('url'), status: 200, title: 'T', content: '# T', content_hash: 'abc', price: { units: '1000' }, node: {}, budget: {} })
  })
  const wallet = new MockWallet({ hold: !!over.hold })
  const door = createDoor({ wallet, hold: !!over.hold, payerUrl: await listen(toonPayer), secret: 'k', credits: new Credits({ file: tmp('spent.jsonl') }), priceSats: 5 })
  await door.ready
  const doorUrl = await listen(door)
  const paid = []
  const ln = createLnPayer({ doorUrl, file: tmp('budget.json'), dailyCapSats: 12, maxPriceSats: 20, payInvoice: async (inv) => { paid.push(inv); return wallet.pay(inv) }, ...over })
  const base = await listen(ln)
  t.after(() => { ln.close(); door.close(); toonPayer.close() })
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() } }
  return { toon, paid, get, wallet }
}

test('the agent asks once and gets the page; the sidecar paid one invoice', async (t) => {
  const { toon, paid, get } = await rig(t)
  const r = await get('/extract?url=https://example.com/a')
  assert.equal(r.status, 200)
  assert.equal(r.body.content, '# T')
  assert.deepEqual(r.body.paid, { sats: 5, payment_hash: r.body.paid.payment_hash })
  assert.equal(r.body.budget.spent, 5)
  assert.equal(paid.length, 1)
  assert.equal(toon.paid, 1)
})

test('a failed TOON fetch is retried on the same credit, no second invoice', async (t) => {
  const { toon, paid, get } = await rig(t)
  toon.fail = true
  const r = await get('/extract?url=https://example.com/a')
  assert.equal(r.status, 200)
  assert.equal(paid.length, 1)
  assert.equal(toon.paid, 1)
})

test('the daily cap and price ceiling refuse before any invoice is paid', async (t) => {
  const { paid, get } = await rig(t)
  assert.equal((await get('/extract?url=https://e.com/1')).status, 200)
  assert.equal((await get('/extract?url=https://e.com/2')).status, 200)
  const r = await get('/extract?url=https://e.com/3')
  assert.equal(r.body.code, 'budget_exhausted')
  assert.equal(paid.length, 2)
  const { get: get2, paid: paid2 } = await rig(t, { maxPriceSats: 4 })
  assert.equal((await get2('/extract?url=https://e.com/1')).body.code, 'price_too_high')
  assert.equal(paid2.length, 0)
})

test('health and bad input', async (t) => {
  const { get } = await rig(t)
  const h = await get('/health')
  assert.equal(h.body.door_ok, true)
  assert.deepEqual(h.body.door_price, { sats: 5 })
  assert.equal((await get('/extract?url=nope')).body.code, 'bad_url')
})

test('hold door: the agent gets the page, and a failed fetch costs nothing', async (t) => {
  const { toon, paid, get } = await rig(t, { hold: true })
  const r = await get('/extract?url=https://example.com/a')
  assert.equal(r.status, 200)
  assert.equal(r.body.content, '# T')
  assert.equal(r.body.budget.spent, 5)
  assert.equal(toon.paid, 1)

  toon.fail = true
  const f = await get('/extract?url=https://example.com/b')
  assert.equal(f.status, 502)
  assert.equal(f.body.code, 'payment_failed')
  assert.equal(f.body.door_settlement, 'hold')
  assert.equal(paid.length, 2)
  const b = await get('/budget')
  assert.equal(b.body.budget.spent, 5, 'a cancelled payment is not counted against the cap')
})
