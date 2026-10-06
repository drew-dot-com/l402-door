// The real wallet: any Lightning wallet that speaks Nostr Wallet Connect
// (NIP-47), built against Alby Hub and run on Rizful. The connection the door
// is given should be receive-only (make_invoice, lookup_invoice, and the hold
// invoice methods): the door never pays, so a door that is broken into cannot
// spend the wallet. `check` refuses a connection that can.
import { NWCClient } from '@getalby/sdk/nwc'

const HOLD_METHODS = ['make_hold_invoice', 'settle_hold_invoice', 'cancel_hold_invoice']

export class NwcWallet {
  name = 'nwc'
  hold = false

  /** @param o {{url: string, allowSpend?: boolean}} the nostr+walletconnect:// connection string */
  constructor(o) {
    this.client = new NWCClient({ nostrWalletConnectUrl: o.url })
    this.allowSpend = o.allowSpend ?? false
  }

  /**
   * What the wallet says this connection may do. Throws when it cannot make an
   * invoice, or can spend. Sets `hold` when it can make, settle and cancel hold
   * invoices and will say when one is paid.
   */
  async check() {
    const info = await this.client.getInfo()
    const methods = info.methods ?? []
    if (!methods.includes('make_invoice')) throw new Error('the NWC connection cannot make invoices')
    if (!this.allowSpend && methods.includes('pay_invoice')) throw new Error('the NWC connection can spend (pay_invoice); give the door a receive-only connection')
    this.hold = HOLD_METHODS.every((m) => methods.includes(m)) && (info.notifications ?? []).includes('hold_invoice_accepted')
    return { alias: info.alias ?? null, network: info.network ?? null, methods, hold: this.hold }
  }

  async makeInvoice({ sats, memo, expirySec }) {
    const tx = await this.client.makeInvoice({ amount: sats * 1000, description: memo, expiry: expirySec })
    if (!tx?.invoice || !/^[0-9a-f]{64}$/i.test(tx.payment_hash ?? '')) throw new Error('the wallet returned no invoice')
    return { invoice: tx.invoice, paymentHash: tx.payment_hash.toLowerCase() }
  }

  async makeHoldInvoice({ sats, memo, expirySec, paymentHash }) {
    const tx = await this.client.makeHoldInvoice({ amount: sats * 1000, description: memo, expiry: expirySec, payment_hash: paymentHash })
    if (!tx?.invoice) throw new Error('the wallet returned no hold invoice')
    if (tx.payment_hash && tx.payment_hash.toLowerCase() !== paymentHash) throw new Error('the wallet made a hold invoice for a different hash')
    return { invoice: tx.invoice, paymentHash }
  }

  async settle(preimage) { await this.client.settleHoldInvoice({ preimage }) }

  async cancel(paymentHash) { await this.client.cancelHoldInvoice({ payment_hash: paymentHash }) }

  /** Calls cb({paymentHash, msat, description}) each time a payer's HTLC is held. Resolves to an unsubscribe. */
  async watchHeld(cb) {
    return this.client.subscribeNotifications((n) => {
      if (n.notification_type !== 'hold_invoice_accepted') return
      const tx = n.notification
      cb({ paymentHash: String(tx.payment_hash ?? '').toLowerCase(), msat: tx.amount, description: tx.description ?? '' })
    }, ['hold_invoice_accepted'])
  }

  close() { this.client.close() }
}
