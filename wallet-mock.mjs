// A wallet that moves no money, for building and testing the door. It makes
// invoices whose preimage it knows and hands the preimage to anyone who
// "pays", so a door running on it sells for free. server.mjs binds a mock
// door to loopback and says so loudly.
//
// The wallet seam is one call: makeInvoice({sats, memo, expirySec}) ->
// {invoice, paymentHash}. A real wallet (Alby Hub over NWC) implements the
// same call and nothing else.
import { randomBytes } from 'node:crypto'
import { sha256hex } from './token.mjs'

export class MockWallet {
  name = 'mock'
  invoices = new Map() // invoice -> preimage

  async makeInvoice({ sats }) {
    const preimage = randomBytes(32)
    const paymentHash = sha256hex(preimage)
    const invoice = `lnmock${sats}n1${paymentHash}`
    this.invoices.set(invoice, preimage.toString('hex'))
    return { invoice, paymentHash }
  }

  /** The preimage a payer would get back from Lightning, or null for an invoice this wallet never made. */
  pay(invoice) { return this.invoices.get(invoice) ?? null }
}
