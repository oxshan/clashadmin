import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defaultRules } from '../shared/rules'
import type { AppState, RuleRecord } from '../shared/types'
import { type AuthData, hashPassword, matchesPassword } from './auth'

const file = resolve(process.env.DATA_FILE ?? 'data/db.json')
const authFile = resolve(dirname(file), 'auth.json')

export const newToken = () => randomBytes(24).toString('base64url')
export const seedRules = (): RuleRecord[] => defaultRules.map((r) => ({ ...r, options: [...r.options], id: randomUUID() }))

export function load(): AppState {
  if (!existsSync(file)) return save({ token: newToken(), nodes: [], rules: seedRules() })
  const state = JSON.parse(readFileSync(file, 'utf8')) as AppState
  return state.rules ? state : save({ ...state, rules: seedRules() })
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
