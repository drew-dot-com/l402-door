// The real wallet: any Lightning wallet that speaks Nostr Wallet Connect
// (NIP-47), built against Alby Hub. The connection the door is given should be
// receive-only (make_invoice, lookup_invoice): the door never pays, so a door
// that is broken into cannot spend the wallet. `check` refuses a connection
// that can.
import { NWCClient } from '@getalby/sdk/nwc'

export class NwcWallet {
  name = 'nwc'

  /** @param o {{url: string, allowSpend?: boolean}} the nostr+walletconnect:// connection string */
  constructor(o) {
    this.client = new NWCClient({ nostrWalletConnectUrl: o.url })
    this.allowSpend = o.allowSpend ?? false
  }

  /** What the wallet says this connection may do. Throws when it cannot make an invoice, or can spend. */
  async check() {
    const info = await this.client.getInfo()
    const methods = info.methods ?? []
    if (!methods.includes('make_invoice')) throw new Error('the NWC connection cannot make invoices')
    if (!this.allowSpend && methods.includes('pay_invoice')) throw new Error('the NWC connection can spend (pay_invoice); give the door a receive-only connection')
    return { alias: info.alias ?? null, network: info.network ?? null, methods }
  }

  async makeInvoice({ sats, memo, expirySec }) {
    const tx = await this.client.makeInvoice({ amount: sats * 1000, description: memo, expiry: expirySec })
    if (!tx?.invoice || !/^[0-9a-f]{64}$/i.test(tx.payment_hash ?? '')) throw new Error('the wallet returned no invoice')
    return { invoice: tx.invoice, paymentHash: tx.payment_hash.toLowerCase() }
  }

  close() { this.client.close() }
}
