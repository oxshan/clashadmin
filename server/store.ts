import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { AppState } from '../shared/types'
import { type AuthData, hashPassword, matchesPassword } from './auth'

const file = resolve(process.env.DATA_FILE ?? 'data/db.json')
const authFile = resolve(dirname(file), 'auth.json')

export const newToken = () => randomBytes(24).toString('base64url')

export function load(): AppState {
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as AppState
  return save({ token: newToken(), nodes: [] })
}

function write<T>(path: string, value: T): T {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
  return value
}

export const save = (state: AppState) => write(file, state)
export const saveAuth = (data: AuthData) => write(authFile, data)

export function loadAuth(password: string): AuthData {
  if (existsSync(authFile)) {
    const data = JSON.parse(readFileSync(authFile, 'utf8')) as AuthData
    if (matchesPassword(data, password)) return data
  }
  return saveAuth({ ...hashPassword(password), sessions: {} })
}
