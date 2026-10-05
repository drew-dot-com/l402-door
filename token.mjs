// The door's credential, pure: an HMAC-signed token that binds one Lightning
// payment hash to one request at one price. It rides in the L402 `macaroon`
// field; clients treat that field as opaque, so a signed token is enough and
// the door needs no macaroon library. Proof of payment is the preimage:
// sha256(preimage) must equal the hash the token carries, which the door
// checks without asking the wallet anything.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto'

const b64 = (x) => Buffer.from(x).toString('base64url')

export const sha256hex = (x) => createHash('sha256').update(x).digest('hex')

const sign = (secret, body) => createHmac('sha256', secret).update(body).digest()

/** @param claims {{h: string, r: string, q: string, p: number, exp: number}} hash, route, request hash, price in sats, expiry (unix seconds) */
export function mint(secret, claims) {
  const body = b64(JSON.stringify({ v: 1, ...claims }))
  return `${body}.${b64(sign(secret, body))}`
}

/** The claims when the signature holds, else null. Expiry is the caller's check. */
export function open(secret, token) {
  const [body, mac, ...rest] = String(token).split('.')
  if (!body || !mac || rest.length) return null
  const want = sign(secret, body)
  const got = Buffer.from(mac, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return claims?.v === 1 ? claims : null
  } catch { return null }
}

export function preimageMatches(preimage, paymentHash) {
  if (!/^[0-9a-f]{64}$/i.test(preimage ?? '')) return false
  return sha256hex(Buffer.from(preimage, 'hex')) === String(paymentHash).toLowerCase()
}

/** `Authorization: L402 <token>:<preimage>` (LSAT is the older spelling of the same scheme). */
export function parseAuth(header) {
  const m = /^(?:L402|LSAT)\s+(\S+)$/i.exec(String(header ?? '').trim())
  if (!m) return null
  const i = m[1].lastIndexOf(':')
  if (i <= 0) return null
  return { token: m[1].slice(0, i), preimage: m[1].slice(i + 1) }
}
