import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { AppState } from '../shared/types'
import { createApp } from './app'
import { type AuthData, createAuth, hashPassword } from './auth'

const LINES = ['hysteria2://pw@1.1.1.1:443?sni=a.com#front', 'vless://uuid@2.2.2.2:443?security=tls&sni=b.com#exit', 'bad line'].join('\n')

const PASSWORD = 'correct horse battery'

function build(now: () => number = Date.now) {
  const state: AppState = { token: 'secret-token', nodes: [] }
  const authData: AuthData = { ...hashPassword(PASSWORD), sessions: {} }
  const app = createApp(state, () => {}, createAuth(authData, () => {}, now))
  const send = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json', ...headers } })
  const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]
  return { state, authData, send, cookieOf }
}

async function setup() {
  const { state, send, cookieOf } = build()
  const cookie = cookieOf(await send('/api/login', 'POST', { password: PASSWORD }))
  const call = (path: string, method = 'GET', body?: unknown) => send(path, method, body, { Cookie: cookie })
  const res = await call('/api/nodes/import', 'POST', { text: LINES })
  return { state, call, send, cookie, imported: await res.json() }
}

describe('api', () => {
  it('imports nodes and reports errors', async () => {
    const { state, imported } = await setup()
    expect(imported.added).toBe(2)
    expect(imported.errors).toHaveLength(1)
    expect(state.nodes.map((n) => n.name)).toEqual(['front', 'exit'])
  })

  it('sets a dialer, rejects cycles, and clears dialers on delete', async () => {
    const { state, call } = await setup()
    const [front, exit] = state.nodes
    expect((await call(`/api/nodes/${exit.id}`, 'PATCH', { dialerId: front.id })).status).toBe(200)
    expect((await call(`/api/nodes/${front.id}`, 'PATCH', { dialerId: exit.id })).status).toBe(400)
    expect((await call(`/api/nodes/${front.id}`, 'PATCH', { name: 'exit' })).status).toBe(400)
    await call(`/api/nodes/${front.id}`, 'DELETE')
    expect(state.nodes).toHaveLength(1)
    expect(state.nodes[0].dialerId).toBeNull()
  })

  it('serves both subscriptions only with the right token', async () => {
    const { state, call } = await setup()
    await call(`/api/nodes/${state.nodes[1].id}`, 'PATCH', { dialerId: state.nodes[0].id })

    expect((await call('/sub/wrong/clash')).status).toBe(404)
    expect((await call('/sub/secret-token/other')).status).toBe(404)

    const clash = await call('/sub/secret-token/clash')
    expect(clash.headers.get('content-type')).toContain('yaml')
    expect(parse(await clash.text()).proxies[1]['dialer-proxy']).toBe('front')

    const rocket = await call('/sub/secret-token/shadowrocket')
    const lines = Buffer.from(await rocket.text(), 'base64').toString().split('\n')
    expect(lines).toEqual([LINES.split('\n')[0], LINES.split('\n')[1].replace('#', '&chain=front#')])

    await call('/api/token/reset', 'POST')
    expect((await call('/sub/secret-token/clash')).status).toBe(404)
  })
})

describe('yaml import api', () => {
  it('imports from text and links dialers to new and existing nodes', async () => {
    const { state, call } = await setup()
    const text = `proxies:
  - {name: front, type: hysteria2, server: 9.9.9.9, port: 443, password: pw}
  - {name: a, type: socks5, server: 3.3.3.3, port: 1080, dialer-proxy: front}
  - {name: b, type: socks5, server: 3.3.3.4, port: 1080, dialer-proxy: missing}`
    const res = await call('/api/nodes/import-yaml', 'POST', { text })
    const body = await res.json()
    expect(body.added).toBe(3)
    expect(body.errors).toHaveLength(1)
    const byName = Object.fromEntries(state.nodes.map((n) => [n.name, n]))
    expect(byName.a.dialerId).toBe(byName['front-2'].id)
    expect((await (await call('/api/nodes/import-yaml', 'POST', { text })).json()).added).toBe(0)
    expect(state.nodes).toHaveLength(5)
    expect(byName.b.dialerId).toBeNull()
    const clash = parse(await (await call('/sub/secret-token/clash')).text())
    expect(clash.proxies.find((p: { name: string }) => p.name === 'a')['dialer-proxy']).toBe('front-2')
  })

  it('loads from a local path and rejects bad sources', async () => {
    const { state, call } = await setup()
    const dir = mkdtempSync(join(tmpdir(), 'clashadmin-'))
    const file = join(dir, 'p.yaml')
    writeFileSync(file, 'proxies: [{name: local, type: socks5, server: 5.5.5.5, port: 1080}]')
    expect((await call('/api/nodes/import-yaml', 'POST', { source: file })).status).toBe(200)
    expect(state.nodes.at(-1)!.name).toBe('local')
    expect((await call('/api/nodes/import-yaml', 'POST', { source: '/etc/passwd' })).status).toBe(400)
    expect((await call('/api/nodes/import-yaml', 'POST', { source: join(dir, 'nope.yaml') })).status).toBe(400)
    expect((await call('/api/nodes/import-yaml', 'POST', { text: 'rules: []' })).status).toBe(400)
    rmSync(dir, { recursive: true })
  })
})

describe('preview, selection, batch and edit', () => {
  const text = `proxies:
  - {name: front, type: hysteria2, server: 1.1.1.1, port: 443, password: pw}
  - {name: chained, type: socks5, server: 3.3.3.3, port: 1080, dialer-proxy: front}
  - {name: other, type: ss, server: 4.4.4.4, port: 8388, cipher: aes-128-gcm, password: x}
  - {name: wg, type: wireguard, server: 5.5.5.5, port: 51820}`

  it('previews without saving, then imports only the selection and links to the existing duplicate', async () => {
    const { state, call } = await setup()
    const preview = await (await call('/api/yaml/preview', 'POST', { text })).json()
    expect(state.nodes).toHaveLength(2)
    expect(preview.text).toBe(text)
    expect(preview.nodes.map((n: { duplicateOf: string | null; rocket: boolean }) => [n.duplicateOf, n.rocket])).toEqual([
      ['front', true],
      [null, true],
      [null, true],
      [null, false],
    ])
    const res = await (await call('/api/nodes/import-yaml', 'POST', { text, select: [0, 1] })).json()
    expect(res.added).toBe(1)
    expect(res.errors).toEqual([])
    expect(state.nodes.map((n) => n.name)).toEqual(['front', 'exit', 'chained'])
    expect(state.nodes[2].dialerId).toBe(state.nodes[0].id)
  })

  it('skips duplicates on text import', async () => {
    const { state, call } = await setup()
    const res = await (await call('/api/nodes/import', 'POST', { text: LINES.split('\n')[0].replace('#front', '#again') })).json()
    expect(res.added).toBe(0)
    expect(res.errors[0].duplicate).toBe(true)
    expect(state.nodes).toHaveLength(2)
  })

  it('applies batch actions and clears dialers of deleted nodes', async () => {
    const { state, call } = await setup()
    const [front, exit] = state.nodes
    await call(`/api/nodes/${exit.id}`, 'PATCH', { dialerId: front.id })
    await call('/api/nodes/batch', 'POST', { ids: [front.id, exit.id], action: 'disable' })
    expect(state.nodes.map((n) => n.enabled)).toEqual([false, false])
    await call('/api/nodes/batch', 'POST', { ids: [exit.id], action: 'enable' })
    expect(state.nodes.map((n) => n.enabled)).toEqual([false, true])
    expect((await call('/api/nodes/batch', 'POST', { ids: [front.id], action: 'nope' })).status).toBe(400)
    await call('/api/nodes/batch', 'POST', { ids: [front.id], action: 'delete' })
    expect(state.nodes.map((n) => [n.name, n.dialerId])).toEqual([['exit', null]])
  })

  it('edits a node through yaml and validates it', async () => {
    const { state, call } = await setup()
    const [front, exit] = state.nodes
    const put = (yaml: string) => call(`/api/nodes/${front.id}`, 'PUT', { yaml })
    expect((await put('{name: front, type: hysteria2, server: 1.1.1.1, port: 8443, password: new, sni: z.com}')).status).toBe(200)
    expect(state.nodes[0]).toMatchObject({ id: front.id, port: 8443, uri: 'hysteria2://new@1.1.1.1:8443?sni=z.com#front' })
    expect(state.nodes[0].proxy.password).toBe('new')
    expect((await put('{name: exit, type: hysteria2, server: 1.1.1.1, port: 8443, password: new}')).status).toBe(400)
    expect((await put(`{name: front, type: vless, server: 2.2.2.2, port: 443, uuid: ${exit.proxy.uuid}}`)).status).toBe(400)
    expect((await put('name: [')).status).toBe(400)
    expect(state.nodes[0].port).toBe(8443)
  })
})

describe('auth', () => {
  const ROUTES: [string, string][] = [
    ['GET', '/api/state'],
    ['GET', '/api/preview'],
    ['GET', '/api/lan'],
    ['POST', '/api/nodes/import'],
    ['POST', '/api/yaml/preview'],
    ['POST', '/api/nodes/import-yaml'],
    ['POST', '/api/nodes/batch'],
    ['PUT', '/api/nodes/x'],
    ['PATCH', '/api/nodes/x'],
    ['DELETE', '/api/nodes/x'],
    ['POST', '/api/nodes/reorder'],
    ['POST', '/api/token/reset'],
    ['POST', '/api/logout'],
    ['GET', '/api/anything-else'],
  ]

  it('rejects every admin route without a valid session and leaves data untouched', async () => {
    const { state, send } = await setup()
    const before = JSON.stringify(state)
    for (const [method, path] of ROUTES) {
      for (const headers of [{}, { Cookie: 'clashadmin_session=forged' }, { Cookie: 'clashadmin_session=' }] as Record<string, string>[]) {
        const res = await send(path, method, method === 'GET' ? undefined : { text: 'x', ids: [], source: '/etc/hosts.yaml' }, headers)
        expect([method, path, res.status]).toEqual([method, path, 401])
      }
    }
    expect(JSON.stringify(state)).toBe(before)
    expect(await (await send('/api/session')).json()).toEqual({ authed: false })
  })

  it('does not let path tricks reach admin routes', async () => {
    const { send } = await setup()
    for (const path of ['/api/%73tate', '//api/state', '/API/state', '/api/state/', '/api/./state', '/x/../api/state', '/api/session/../state', '/api/login/../state']) {
      const res = await send(path)
      expect([path, res.status === 200 && 'leaked']).toEqual([path, false])
    }
  })

  it('answers malformed bodies with 400 and rejects reserved names', async () => {
    const { state, call, send, cookie } = await setup()
    expect((await send('/api/nodes/batch', 'POST', undefined, { Cookie: cookie })).status).toBe(400)
    expect((await call('/api/nodes/import', 'POST', [])).status).toBe(200)
    expect((await call(`/api/nodes/${state.nodes[0].id}`, 'PATCH', { name: 'proxy' })).status).toBe(400)
    expect((await call(`/api/nodes/${state.nodes[0].id}`, 'PUT', { yaml: '{name: DIRECT, type: socks5, server: 1.1.1.1, port: 1}' })).status).toBe(400)
  })

  it('logs in with the right password only and sets a hardened cookie', async () => {
    const { send } = build()
    expect((await send('/api/login', 'POST', { password: 'wrong' })).status).toBe(401)
    expect((await send('/api/login', 'POST', { password: ['a'] })).status).toBe(401)
    expect((await send('/api/login', 'POST')).status).toBe(401)
    const res = await send('/api/login', 'POST', { password: PASSWORD })
    const cookie = res.headers.get('set-cookie')!
    expect(res.status).toBe(200)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Strict/i)
    expect(cookie).not.toMatch(/Secure/i)
    const https = await send('/api/login', 'POST', { password: PASSWORD }, { 'X-Forwarded-Proto': 'https' })
    expect(https.headers.get('set-cookie')).toMatch(/Secure/i)
  })

  it('stores only a hash of the session token and of the password', async () => {
    const { authData, send, cookieOf } = build()
    const token = cookieOf(await send('/api/login', 'POST', { password: PASSWORD })).split('=')[1]
    expect(JSON.stringify(authData)).not.toContain(token)
    expect(JSON.stringify(authData)).not.toContain(PASSWORD)
  })

  it('locks out after repeated failures, even with the right password', async () => {
    let now = 1_000_000
    const { send } = build(() => now)
    for (let i = 0; i < 5; i++) expect((await send('/api/login', 'POST', { password: `bad${i}` })).status).toBe(401)
    expect((await send('/api/login', 'POST', { password: PASSWORD })).status).toBe(429)
    now += 15 * 60 * 1000 + 1
    expect((await send('/api/login', 'POST', { password: PASSWORD })).status).toBe(200)
  })

  it('expires sessions and invalidates them on logout', async () => {
    let now = 1_000_000
    const { send, cookieOf } = build(() => now)
    const cookie = cookieOf(await send('/api/login', 'POST', { password: PASSWORD }))
    expect((await send('/api/state', 'GET', undefined, { Cookie: cookie })).status).toBe(200)
    now += 7 * 24 * 60 * 60 * 1000 + 1
    expect((await send('/api/state', 'GET', undefined, { Cookie: cookie })).status).toBe(401)

    const fresh = cookieOf(await send('/api/login', 'POST', { password: PASSWORD }))
    await send('/api/logout', 'POST', undefined, { Cookie: fresh })
    expect((await send('/api/state', 'GET', undefined, { Cookie: fresh })).status).toBe(401)
  })

  it('blocks cross-site writes even with a valid cookie', async () => {
    const { state, send, cookie } = await setup()
    const evil = { Cookie: cookie, Origin: 'https://evil.example', Host: 'panel.example' }
    expect((await send('/api/token/reset', 'POST', undefined, evil)).status).toBe(403)
    expect((await send('/api/login', 'POST', { password: PASSWORD }, evil)).status).toBe(403)
    expect(state.token).toBe('secret-token')
    const same = { Cookie: cookie, Origin: 'https://panel.example', Host: 'panel.example' }
    expect((await send('/api/token/reset', 'POST', undefined, same)).status).toBe(200)
    const proxied = { Cookie: cookie, Origin: 'https://panel.example', Host: '127.0.0.1:8787', 'X-Forwarded-Host': 'panel.example' }
    expect((await send('/api/token/reset', 'POST', undefined, proxied)).status).toBe(200)
  })

  it('keeps subscriptions reachable by token without a session', async () => {
    const { send } = await setup()
    expect((await send('/sub/secret-token/clash')).status).toBe(200)
    expect((await send('/sub/wrong/clash')).status).toBe(404)
  })
})

describe('public url', () => {
  it('reports the configured public url as the only origin', async () => {
    const authData: AuthData = { ...hashPassword(PASSWORD), sessions: {} }
    const make = (publicUrl?: string) => createApp({ token: 't', nodes: [] }, () => {}, createAuth(authData, () => {}), () => ['http://10.0.0.2:8787'], publicUrl)
    const lan = async (app: ReturnType<typeof make>) => {
      const login = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'Content-Type': 'application/json' } })
      return (await app.request('/api/lan', { headers: { Cookie: login.headers.get('set-cookie')!.split(';')[0] } })).json()
    }
    expect(await lan(make())).toEqual({ origins: ['http://10.0.0.2:8787'], publicUrl: '' })
    expect(await lan(make('https://sub.example.com'))).toEqual({ origins: ['https://sub.example.com'], publicUrl: 'https://sub.example.com' })
  })
})
