// l402-door: a Lightning front door for a TOON node. See door.mjs.
//
// Env:
//   L402_WALLET             REQUIRED. `nwc` is a real wallet over Nostr Wallet Connect (Alby Hub);
//                           `mock` moves no money, gives the preimage to anyone, loopback only.
//   L402_NWC_FILE           the receive-only nostr+walletconnect:// string, default <L402_HOME>/nwc.secret
//   L402_PORT               default 3503          L402_BIND   default 127.0.0.1
//   L402_PAYER_URL          the payer sidecar, default http://127.0.0.1:3502
//   L402_PRICE_SATS         whole sats per extract, set by hand, default 5
//   L402_HOME               signing secret + spent credits, default ~/.l402-door
//   L402_INVOICE_TTL_SEC    default 600           L402_CREDIT_TTL_SEC   default 3600
//   L402_MAX_INVOICES_PER_MIN  default 60
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createDoor } from './door.mjs'
import { Credits } from './credits.mjs'
import { MockWallet } from './wallet-mock.mjs'
import { NwcWallet } from './wallet-nwc.mjs'

const env = (k, d) => process.env[k] ?? d
const PORT = Number(env('L402_PORT', 3503))
const BIND = env('L402_BIND', '127.0.0.1')
const HOME = env('L402_HOME', path.join(os.homedir(), '.l402-door'))
const PAYER_URL = env('L402_PAYER_URL', 'http://127.0.0.1:3502')
const PRICE_SATS = Number(env('L402_PRICE_SATS', 5))
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

const log = (...a) => console.log('[door]', new Date().toISOString(), ...a)
const die = (msg) => { console.error(`[door] ${msg}`); process.exit(1) }

if (!Number.isInteger(PRICE_SATS) || PRICE_SATS < 1) die('L402_PRICE_SATS must be a whole number of sats, 1 or more')

let wallet
const kind = env('L402_WALLET', '')
if (kind === 'mock') {
  if (BIND !== '127.0.0.1' && BIND !== '::1') die('the mock wallet gives its preimages away; it only runs bound to loopback')
  wallet = new MockWallet()
} else if (kind === 'nwc') {
  const file = env('L402_NWC_FILE', path.join(HOME, 'nwc.secret'))
  if (!fs.existsSync(file)) die(`no NWC connection string at ${file} (L402_NWC_FILE)`)
  wallet = new NwcWallet({ url: fs.readFileSync(file, 'utf8').trim() })
  const info = await wallet.check().catch((e) => die(`wallet check failed: ${e?.message ?? e}`))
  log(`wallet ${info.alias ?? '?'} on ${info.network ?? '?'}, methods ${info.methods.join(',')}`)
} else die('set L402_WALLET (mock or nwc)')

// The signing secret is made once and kept; losing it voids unspent credits and nothing else.
fs.mkdirSync(HOME, { recursive: true })
const secretFile = path.join(HOME, 'secret')
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 })
const secret = Buffer.from(fs.readFileSync(secretFile, 'utf8').trim(), 'hex')

const server = createDoor({
  wallet, secret, log, version: VERSION,
  payerUrl: PAYER_URL,
  priceSats: PRICE_SATS,
  credits: new Credits({ file: path.join(HOME, 'spent.jsonl') }),
  invoiceTtlSec: Number(env('L402_INVOICE_TTL_SEC', 600)),
  creditTtlSec: Number(env('L402_CREDIT_TTL_SEC', 3600)),
  maxInvoicesPerMin: Number(env('L402_MAX_INVOICES_PER_MIN', 60)),
})

server.listen(PORT, BIND, () => {
  log(`v${VERSION} listening on http://${BIND}:${PORT} selling extract at ${PRICE_SATS} sats, wallet ${wallet.name}, payer ${PAYER_URL}`)
  if (wallet.name === 'mock') log('MOCK WALLET: no money moves and POST /mock/pay hands out preimages')
})

const shutdown = () => { log('stopping'); server.close(); process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
