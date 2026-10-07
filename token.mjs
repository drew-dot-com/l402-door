// The door's credential: a real macaroon (libmacaroons v2 binary, base64), so
// every L402 client that decodes the `macaroon` field as one (lnget, aperture,
// anything on gopkg.in/macaroon.v2) accepts it, and clients that keep it
// opaque (402-mcp) can echo it back. The identifier is aperture's L402 layout:
// a 2-byte version (0), the 32-byte payment hash, a 32-byte token id. The
// request binding rides as first-party caveats, HMAC-chained from the door's
// secret, so nothing can be edited. Proof of payment is the preimage:
// sha256(preimage) must equal the hash in the identifier, which the door checks
// without asking the wallet anything.
import { createHash, randomBytes } from 'node:crypto'
import { newMacaroon, importMacaroon } from 'macaroon'

export const sha256hex = (x) => createHash('sha256').update(x).digest('hex')

const LOCATION = 'l402-door'
const ID_LEN = 2 + 32 + 32
const rootKey = (secret) => new Uint8Array(createHash('sha256').update(String(secret)).digest())
const text = new TextEncoder()

/** @param claims {{h: string, r: string, q: string, p: number, exp: number}} payment hash (hex), route, request hash, price in sats, expiry (unix seconds) */
export function mint(secret, claims) {
  const identifier = new Uint8Array(Buffer.concat([Buffer.from([0, 0]), Buffer.from(claims.h, 'hex'), randomBytes(32)]))
  if (identifier.length !== ID_LEN) throw new Error('payment hash must be 32 bytes')
  const m = newMacaroon({ version: 2, rootKey: rootKey(secret), identifier, location: LOCATION })
  for (const c of [`route = ${claims.r}`, `request = ${claims.q}`, `price_sats = ${claims.p}`, `expires = ${claims.exp}`]) m.addFirstPartyCaveat(text.encode(c))
  return serialize(m).toString('base64')
}

// libmacaroons v2 binary: a version byte, then fields (uvarint type, uvarint
// length, bytes; types: 1 location, 2 identifier, 4 vid, 6 signature) with EOS
// bytes between sections. Written here because the
// package's own exporter grows its buffer without bound on Node 22 (its
// `_grow` compares against a capacity it never sets) and dies on a macaroon
// this size.
const uvarint = (n) => { const out = []; while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7 } out.push(n); return Buffer.from(out) }
const field = (type, bytes) => Buffer.concat([uvarint(type), uvarint(bytes.length), Buffer.from(bytes)])
const EOS = Buffer.from([0])
export function serialize(m) {
  const parts = [Buffer.from([2])]
  if (m.location) parts.push(field(1, text.encode(m.location)))
  parts.push(field(2, m.identifier), EOS)
  for (const c of m.caveats) {
    if (c.location) parts.push(field(1, text.encode(c.location)))
    parts.push(field(2, c.identifier))
    if (c.vid) parts.push(field(4, c.vid))
    parts.push(EOS)
  }
  parts.push(EOS, field(6, m.signature))
  return Buffer.concat(parts)
}

/** The claims when the macaroon was minted by this door and is intact, else null. Expiry is the caller's check. */
export function open(secret, token) {
  let m
  try { m = importMacaroon(new Uint8Array(Buffer.from(String(token), 'base64'))) } catch { return null }
  if (!m || Array.isArray(m)) return null
  const id = Buffer.from(m.identifier)
  if (id.length !== ID_LEN || id.readUInt16BE(0) !== 0) return null
  const got = {}
  try {
    m.verify(rootKey(secret), (cond) => {
      const mm = /^([a-z_]+) = (.*)$/.exec(String(cond))
      if (!mm || mm[1] in got) return 'unknown caveat'
      got[mm[1]] = mm[2]
      return null
    })
  } catch { return null }
  const p = Number(got.price_sats), exp = Number(got.expires)
  if (!got.route || !got.request || !Number.isInteger(p) || !Number.isInteger(exp)) return null
  return { v: 1, h: id.subarray(2, 34).toString('hex'), r: got.route, q: got.request, p, exp }
}

export function preimageMatches(preimage, paymentHash) {
  if (!/^[0-9a-f]{64}$/i.test(preimage ?? '')) return false
  return sha256hex(Buffer.from(preimage, 'hex')) === String(paymentHash).toLowerCase()
}

/** `Authorization: L402 <macaroon>:<preimage>` (LSAT is the older spelling of the same scheme). */
export function parseAuth(header) {
  const m = /^(?:L402|LSAT)\s+(\S+)$/i.exec(String(header ?? '').trim())
  if (!m) return null
  const i = m[1].lastIndexOf(':')
  if (i <= 0) return null
  return { token: m[1].slice(0, i), preimage: m[1].slice(i + 1) }
}
