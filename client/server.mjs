// Run the Lightning-paying sidecar. See lnpayer.mjs.
//
// Env:
//   LN_NWC_FILE           a nostr+walletconnect:// string that CAN pay (pay_invoice), REQUIRED
//   L402_DOOR             default https://l402.mainnet.toonprotocol.dev
//   LN_PAYER_PORT         default 3504        LN_PAYER_BIND   default 127.0.0.1
//   LN_PAYER_HOME         ledger, default ~/.l402-payer
//   LN_DAILY_CAP_SATS     default 500         LN_MAX_PRICE_SATS   default 20
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NWCClient } from '@getalby/sdk/nwc'
import { createLnPayer } from './lnpayer.mjs'

const env = (k, d) => process.env[k] ?? d
const PORT = Number(env('LN_PAYER_PORT', 3504))
const BIND = env('LN_PAYER_BIND', '127.0.0.1')
const HOME = env('LN_PAYER_HOME', path.join(os.homedir(), '.l402-payer'))
const DOOR = env('L402_DOOR', 'https://l402.mainnet.toonprotocol.dev')
const log = (...a) => console.log('[lnpayer]', new Date().toISOString(), ...a)
const die = (m) => { console.error(`[lnpayer] ${m}`); process.exit(1) }

const file = env('LN_NWC_FILE', '')
if (!file || !fs.existsSync(file)) die('LN_NWC_FILE must point at a nostr+walletconnect:// string that can pay')
const nwc = new NWCClient({ nostrWalletConnectUrl: fs.readFileSync(file, 'utf8').trim() })
const info = await nwc.getInfo().catch((e) => die(`wallet check failed: ${e?.message ?? e}`))
if (!(info.methods ?? []).includes('pay_invoice')) die('this NWC connection cannot pay (no pay_invoice)')
log(`wallet ${info.alias ?? '?'} on ${info.network ?? '?'} can pay`)

const server = createLnPayer({
  doorUrl: DOOR, log,
  file: path.join(HOME, 'budget.json'),
  dailyCapSats: Number(env('LN_DAILY_CAP_SATS', 500)),
  maxPriceSats: Number(env('LN_MAX_PRICE_SATS', 20)),
  payInvoice: async (invoice) => {
    const r = await nwc.payInvoice({ invoice })
    if (!/^[0-9a-f]{64}$/i.test(r?.preimage ?? '')) throw new Error('the wallet paid but returned no preimage')
    return r.preimage.toLowerCase()
  },
})
server.listen(PORT, BIND, () => log(`listening on http://${BIND}:${PORT} buying from ${DOOR}; daily cap ${env('LN_DAILY_CAP_SATS', 500)} sats`))
const shutdown = () => { log('stopping'); server.close(); nwc.close(); process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
