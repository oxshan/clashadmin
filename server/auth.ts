import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export interface AuthData {
  salt: string
  hash: string
  sessions: Record<string, number>
}

export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000
export const MIN_PASSWORD = 8
const MAX_FAILURES = 5
const LOCK_WINDOW = 15 * 60 * 1000

const digest = (token: string) => createHash('sha256').update(token).digest('hex')
const derive = (password: string, salt: string) => scryptSync(password, Buffer.from(salt, 'hex'), 64)

export function hashPassword(password: string): Pick<AuthData, 'salt' | 'hash'> {
  const salt = randomBytes(16).toString('hex')
  return { salt, hash: derive(password, salt).toString('hex') }
}

export const matchesPassword = (data: Pick<AuthData, 'salt' | 'hash'>, password: string) =>
  timingSafeEqual(derive(password, data.salt), Buffer.from(data.hash, 'hex'))

export function createAuth(data: AuthData, persist: (data: AuthData) => unknown, now: () => number = Date.now) {
  const failures = new Map<string, number[]>()
  const recent = (client: string) => (failures.get(client) ?? []).filter((t) => now() - t < LOCK_WINDOW)

  return {
    locked: (client: string) => recent(client).length >= MAX_FAILURES,

    verify(password: unknown, client: string): boolean {
      const ok = typeof password === 'string' && matchesPassword(data, password)
      if (ok) failures.delete(client)
      else {
        if (failures.size > 10000) for (const key of failures.keys()) if (!recent(key).length) failures.delete(key)
        failures.set(client, [...recent(client), now()])
      }
      return ok
    },

    createSession(): string {
      const token = randomBytes(32).toString('base64url')
      for (const [key, expires] of Object.entries(data.sessions)) if (expires <= now()) delete data.sessions[key]
      data.sessions[digest(token)] = now() + SESSION_TTL
      persist(data)
      return token
    },

    check(token: string | undefined): boolean {
      if (!token) return false
      const expires = data.sessions[digest(token)]
      return expires !== undefined && expires > now()
    },

    destroySession(token: string | undefined) {
      if (!token || !(digest(token) in data.sessions)) return
      delete data.sessions[digest(token)]
      persist(data)
    },
  }
}

export type Auth = ReturnType<typeof createAuth>
