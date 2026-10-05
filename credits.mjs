// One paid invoice buys one answer. A credit is burned only after the TOON
// leg succeeded: `begin` takes it while the job runs, `commit` burns it and
// writes it to disk, `release` hands it back when the job failed so the buyer
// can retry. Spent credits are kept until their token expires, then pruned;
// in-flight ones live in memory only, so a crash mid-job errs toward the buyer.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export class Credits {
  /** @param o {{file: string, now?: () => number}} */
  constructor(o) {
    this.file = o.file
    this.now = o.now ?? Date.now
    this.spent = new Map() // payment hash -> token expiry (unix seconds)
    this.flight = new Set()
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        try { const { h, exp } = JSON.parse(line); if (exp > this.now() / 1000) this.spent.set(h, exp) } catch { /* a bad line is skipped */ }
      }
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, [...this.spent].map(([h, exp]) => JSON.stringify({ h, exp }) + '\n').join(''))
    }
  }

  /** 'ok' when the credit is now held by the caller, else why not. */
  begin(hash) {
    if (this.spent.has(hash)) return 'spent'
    if (this.flight.has(hash)) return 'in_flight'
    this.flight.add(hash)
    return 'ok'
  }

  commit(hash, exp) {
    this.flight.delete(hash)
    this.spent.set(hash, exp)
    mkdirSync(dirname(this.file), { recursive: true })
    appendFileSync(this.file, JSON.stringify({ h: hash, exp }) + '\n')
  }

  release(hash) { this.flight.delete(hash) }
}
