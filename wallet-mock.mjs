// A wallet that moves no money, for building and testing the door. It makes
// invoices whose preimage it knows and hands the preimage to anyone who
// "pays", so a door running on it sells for free. server.mjs binds a mock
// door to loopback and says so loudly.
//
// The wallet seam is makeInvoice({sats, memo, expirySec}) -> {invoice,
// paymentHash}. A wallet that can hold (`hold` true) adds
// makeHoldInvoice({..., paymentHash}), settle(preimage), cancel(paymentHash)
// and watchHeld(cb), where cb({paymentHash, msat, description}) fires when a
// payer's HTLC is held. The real wallet (NWC) implements the same calls.
import { randomBytes } from 'node:crypto'
import { sha256hex } from './token.mjs'

export class PaymentCancelled extends Error { constructor() { super('the payee cancelled the payment'); this.code = 'cancelled' } }

export class MockWallet {
  name = 'mock'
  invoices = new Map() // invoice -> {paymentHash, sats, memo, preimage?, hold}
  waiting = new Map() // payment hash -> resolve, while a payer's HTLC is held
  cancelled = new Set()

  /** @param o {{hold?: boolean, holdMinSats?: number}} holdMinSats mimics a wallet that refuses small holds */
  constructor(o = {}) { this.hold = !!o.hold; this.holdMinSats = o.holdMinSats ?? 0 }

  async makeInvoice({ sats, memo }) {
    const preimage = randomBytes(32)
    const paymentHash = sha256hex(preimage)
    const invoice = `lnmock${sats}n1${paymentHash}`
    this.invoices.set(invoice, { paymentHash, sats, memo, preimage: preimage.toString('hex'), hold: false })
    return { invoice, paymentHash }
  }

  async makeHoldInvoice({ sats, memo, paymentHash }) {
    if (sats < this.holdMinSats) throw new Error(`amount must be at least ${this.holdMinSats * 1000} msat`)
    const invoice = `lnmockhold${sats}n1${paymentHash}`
    this.invoices.set(invoice, { paymentHash, sats, memo, hold: true })
    return { invoice, paymentHash }
  }

  async watchHeld(cb) { this.onHeld = cb; return () => { this.onHeld = null } }

  async settle(preimage) {
    const h = sha256hex(Buffer.from(preimage, 'hex'))
    const resolve = this.waiting.get(h)
    if (!resolve) throw new Error('nothing is held for that preimage')
    this.waiting.delete(h)
    resolve(preimage)
  }

  async cancel(paymentHash) {
    this.cancelled.add(paymentHash)
    const resolve = this.waiting.get(paymentHash)
    if (resolve) { this.waiting.delete(paymentHash); resolve(null) }
  }

  /**
   * The preimage a payer would get back from Lightning, or null for an invoice
   * this wallet never made. A hold invoice answers only once the payee settles
   * it, and throws PaymentCancelled when the payee cancels it instead.
   */
  async pay(invoice) {
    const inv = this.invoices.get(invoice)
    if (!inv) return null
    if (!inv.hold) return inv.preimage
    if (this.cancelled.has(inv.paymentHash)) throw new PaymentCancelled()
    const settled = new Promise((ok) => this.waiting.set(inv.paymentHash, ok))
    this.onHeld?.({ paymentHash: inv.paymentHash, msat: inv.sats * 1000, description: inv.memo })
    const preimage = await settled
    if (!preimage) throw new PaymentCancelled()
    return preimage
  }
}
