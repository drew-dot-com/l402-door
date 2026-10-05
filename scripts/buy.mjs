#!/usr/bin/env node
// Buy one extract from an l402-door by hand: ask, get the invoice, pay it from
// any Lightning wallet that shows the payment preimage, paste the preimage.
//   node scripts/buy.mjs <page url> [door url]
import readline from 'node:readline/promises'

const [page, door = 'https://l402.167-233-221-236.sslip.io'] = process.argv.slice(2)
if (!page) { console.error('usage: node scripts/buy.mjs <page url> [door url]'); process.exit(1) }
const target = `${door}/extract?url=${encodeURIComponent(page)}`

const c = await fetch(target)
const ch = await c.json()
if (c.status !== 402) { console.error(`expected 402, got ${c.status}:`, ch); process.exit(1) }
console.log(`\nPrice: ${ch.price.sats} sats. Pay this invoice within ${ch.invoice_expires_in / 60} minutes:\n\n${ch.invoice}\n`)

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
for (;;) {
  const preimage = (await rl.question('Preimage (64 hex chars) from your wallet: ')).trim()
  const r = await fetch(target, { headers: { authorization: `L402 ${ch.macaroon}:${preimage}` } })
  const body = await r.json()
  if (r.status === 200) {
    const { content, ...receipt } = body
    console.log('\n' + JSON.stringify(receipt, null, 2) + `\n\n--- content (${content.length} chars) ---\n${content.slice(0, 600)}`)
    break
  }
  console.log(`${r.status} ${body.code}: ${body.error}`)
  if (body.code !== 'bad_preimage' && body.code !== 'upstream_failed') break
  if (body.code === 'upstream_failed') console.log('The credit is still good. Press enter with the same preimage to retry.')
}
rl.close()
