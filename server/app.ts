import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { RESERVED_NAMES, nodeKey, parseLines, uniqueName } from '../shared/parse'
import { chainError, nodeNames, renamed, renderClash, renderShadowrocket, rocketUri, ruleTargets } from '../shared/render'
import { formatRule, parseRules, ruleError } from '../shared/rules'
import type { AppState, BatchAction, ImportResult, NodeRecord, Preview, Rule, YamlPreview } from '../shared/types'
import { parseClashYaml, parseProxyYaml, toUri } from '../shared/yaml'
import { type Auth, SESSION_TTL } from './auth'
import { loadSource } from './source'
import { newToken, seedRules } from './store'

const tokenMatches = (given: string, expected: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function reordered<T extends { id: string }>(list: T[], ids: unknown): T[] | null {
  const byId = new Map(list.map((item) => [item.id, item]))
  const valid = Array.isArray(ids) && ids.length === byId.size && new Set(ids).size === ids.length && ids.every((id) => byId.has(id))
  return valid ? ids.map((id) => byId.get(id)!) : null
}

type Env = { Bindings: { incoming?: IncomingMessage } }
const COOKIE = 'clashadmin_session'
const PUBLIC_API = new Set(['/api/session', '/api/login'])

const clientOf = (c: Context<Env>) => c.env?.incoming?.socket.remoteAddress ?? 'local'

function sameOrigin(c: Context<Env>): boolean {
  const origin = c.req.header('origin')
  if (!origin) return true
  try {
    const host = new URL(origin).host
    return host === c.req.header('host') || host === c.req.header('x-forwarded-host')
  } catch {
    return false
  }
}

export function createApp(state: AppState, persist: (state: AppState) => unknown, auth: Auth, lanOrigins: () => string[] = () => [], publicUrl = '') {
  const app = new Hono<Env>()
  const commit = () => (persist(state), state)

  const renameNode = (apply: () => void) => {
    const before = nodeNames(state.nodes)
    apply()
    const moved = renamed(before, nodeNames(state.nodes))
    for (const r of state.rules) r.target = moved.get(r.target) ?? r.target
  }

  const startSession = (c: Context<Env>) =>
    setCookie(c, COOKIE, auth.createSession(), {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: SESSION_TTL / 1000,
      secure: (c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol).startsWith('https'),
    })

  app.onError((e, c) => {
    if (e instanceof SyntaxError || e instanceof TypeError) return c.json({ error: '请求格式错误' }, 400)
    console.error(e)
    return c.json({ error: '服务器内部错误' }, 500)
  })

  app.use('*', async (c, next) => {
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'DENY')
    c.header('Referrer-Policy', 'no-referrer')
  })

  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (c.req.method !== 'GET' && !sameOrigin(c)) return c.json({ error: '请求来源不合法' }, 403)
    if (!PUBLIC_API.has(c.req.path) && !auth.check(getCookie(c, COOKIE))) return c.json({ error: '未登录或登录已过期' }, 401)
    await next()
  })

  app.get('/api/session', (c) => c.json({ authed: auth.check(getCookie(c, COOKIE)) }))

  app.post('/api/login', async (c) => {
    const client = clientOf(c)
    if (auth.locked(client)) return c.json({ error: '尝试次数过多，请 15 分钟后再试' }, 429)
    const body = await c.req.json<{ password?: unknown }>().catch(() => ({ password: undefined }))
    if (!auth.verify(body.password, client)) return c.json({ error: '密码错误' }, 401)
    startSession(c)
    return c.json({ authed: true })
  })

  app.post('/api/logout', (c) => {
    auth.destroySession(getCookie(c, COOKIE))
    deleteCookie(c, COOKIE, { path: '/' })
    return c.json({ authed: false })
  })

  app.get('/api/lan', (c) => c.json({ origins: publicUrl ? [publicUrl] : lanOrigins(), publicUrl }))

  app.get('/api/state', (c) => c.json(state))

  app.get('/api/preview', (c) => {
    const { yaml, warnings } = renderClash(state.nodes, state.rules)
    const rocket = renderShadowrocket(state.nodes)
    return c.json({ clash: yaml, shadowrocket: rocket.text, warnings: [...new Set([...warnings, ...rocket.warnings])] } satisfies Preview)
  })

  app.post('/api/nodes/import', async (c) => {
    const { text } = await c.req.json<{ text: string }>()
    const { nodes, errors } = parseLines(String(text ?? ''), state.nodes)
    state.nodes.push(...nodes.map((n): NodeRecord => ({ ...n, id: randomUUID(), enabled: true, dialerId: null, keepDirect: false })))
    commit()
    return c.json({ added: nodes.length, errors, state } satisfies ImportResult)
  })

  const readYaml = async (body: { text?: string; source?: string }) => {
    const text = body.text ?? (await loadSource(String(body.source ?? '')))
    return { text, parsed: parseClashYaml(text, state.nodes) }
  }

  app.post('/api/yaml/preview', async (c) => {
    try {
      const { text, parsed } = await readYaml(await c.req.json())
      const nodes = parsed.nodes.map((n) => ({
        index: n.index,
        name: n.name,
        type: n.type,
        server: n.server,
        port: n.port,
        dialerName: n.dialerName,
        duplicateOf: n.duplicateOf,
        rocket: Boolean(rocketUri(n)),
      }))
      return c.json({ text, nodes, errors: parsed.errors } satisfies YamlPreview)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.post('/api/nodes/import-yaml', async (c) => {
    const body = await c.req.json<{ text?: string; source?: string; select?: number[] }>()
    let parsed
    try {
      parsed = (await readYaml(body)).parsed
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    const select = Array.isArray(body.select) ? new Set(body.select) : null
    const errors = parsed.errors
    const idByName = new Map(state.nodes.map((n) => [n.name, n.id]))
    const idBySource = new Map<string, string>()
    const added: { record: NodeRecord; dialerName: string | null }[] = []
    for (const { index, sourceName, dialerName, duplicateOf, ...n } of parsed.nodes) {
      if (duplicateOf) {
        idBySource.set(sourceName, idByName.get(duplicateOf)!)
        if (!select) errors.push({ line: index + 1, text: sourceName, error: `已存在（${duplicateOf}），跳过`, duplicate: true })
        continue
      }
      if (select && !select.has(index)) continue
      const record: NodeRecord = { ...n, id: randomUUID(), enabled: true, dialerId: null, keepDirect: false }
      idBySource.set(sourceName, record.id)
      added.push({ record, dialerName })
    }
    state.nodes.push(...added.map((a) => a.record))
    for (const { record, dialerName } of added) {
      if (!dialerName) continue
      const dialerId = idBySource.get(dialerName) ?? idByName.get(dialerName)
      if (dialerId && !chainError(state.nodes, record.id, dialerId)) record.dialerId = dialerId
      else errors.push({ line: 0, text: record.name, error: `已导入，但前置节点「${dialerName}」未导入、不存在或成环，未设置前置` })
    }
    commit()
    return c.json({ added: added.length, errors, state } satisfies ImportResult)
  })

  app.post('/api/nodes/batch', async (c) => {
    const { ids, action } = await c.req.json<{ ids: string[]; action: BatchAction }>()
    if (!Array.isArray(ids) || !['enable', 'disable', 'delete'].includes(action)) return c.json({ error: '参数无效' }, 400)
    const picked = new Set(ids)
    if (action === 'delete') {
      state.nodes = state.nodes.filter((n) => !picked.has(n.id))
      for (const n of state.nodes) if (n.dialerId && picked.has(n.dialerId)) n.dialerId = null
    } else for (const n of state.nodes) if (picked.has(n.id)) n.enabled = action === 'enable'
    return c.json(commit())
  })

  app.put('/api/nodes/:id', async (c) => {
    const node = state.nodes.find((n) => n.id === c.req.param('id'))
    if (!node) return c.json({ error: '节点不存在' }, 404)
    const { yaml } = await c.req.json<{ yaml: string }>()
    let proxy
    try {
      proxy = parseProxyYaml(String(yaml ?? ''))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    const others = state.nodes.filter((n) => n !== node)
    if (RESERVED_NAMES.includes(proxy.name) || others.some((n) => n.name === proxy.name)) return c.json({ error: '名称已存在或是保留名称' }, 400)
    const key = nodeKey(proxy)
    const twin = others.find((n) => nodeKey(n.proxy) === key)
    if (twin) return c.json({ error: `与节点「${twin.name}」重复（类型、地址、端口、凭据相同）` }, 400)
    renameNode(() => Object.assign(node, { name: proxy.name, type: proxy.type, server: proxy.server, port: proxy.port, proxy, uri: toUri(proxy) }))
    return c.json(commit())
  })

  app.patch('/api/nodes/:id', async (c) => {
    const node = state.nodes.find((n) => n.id === c.req.param('id'))
    if (!node) return c.json({ error: '节点不存在' }, 404)
    const body = await c.req.json<Partial<Pick<NodeRecord, 'name' | 'enabled' | 'dialerId' | 'keepDirect'>>>()
    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (!name) return c.json({ error: '名称不能为空' }, 400)
      const others = new Set([...RESERVED_NAMES, ...state.nodes.filter((n) => n !== node).map((n) => n.name)])
      if (uniqueName(name, others) !== name) return c.json({ error: '名称已存在或是保留名称' }, 400)
      renameNode(() => (node.name = node.proxy.name = name))
    }
    if (body.dialerId !== undefined) {
      const error = chainError(state.nodes, node.id, body.dialerId)
      if (error) return c.json({ error }, 400)
      node.dialerId = body.dialerId || null
    }
    if (body.enabled !== undefined) node.enabled = Boolean(body.enabled)
    if (body.keepDirect !== undefined) node.keepDirect = Boolean(body.keepDirect)
    return c.json(commit())
  })

  app.delete('/api/nodes/:id', (c) => {
    const id = c.req.param('id')
    state.nodes = state.nodes.filter((n) => n.id !== id)
    for (const n of state.nodes) if (n.dialerId === id) n.dialerId = null
    return c.json(commit())
  })

  app.post('/api/nodes/reorder', async (c) => {
    const nodes = reordered(state.nodes, (await c.req.json<{ ids: string[] }>()).ids)
    if (!nodes) return c.json({ error: '排序列表与现有节点不一致' }, 400)
    state.nodes = nodes
    return c.json(commit())
  })

  app.post('/api/rules', async (c) => {
    const { text, target } = await c.req.json<{ text: string; target?: string }>()
    const { rules, errors } = parseRules(String(text ?? ''), { fallback: String(target ?? ''), targets: ruleTargets(state.nodes), existing: state.rules })
    state.rules.unshift(...rules.map((r) => ({ ...r, id: randomUUID() })))
    commit()
    return c.json({ added: rules.length, errors, state } satisfies ImportResult)
  })

  app.put('/api/rules/:id', async (c) => {
    const rule = state.rules.find((r) => r.id === c.req.param('id'))
    if (!rule) return c.json({ error: '规则不存在' }, 404)
    const body = await c.req.json<Partial<Rule>>()
    const next: Rule = {
      type: String(body.type ?? '').trim().toUpperCase(),
      payload: String(body.payload ?? '').trim(),
      target: String(body.target ?? ''),
      options: Array.isArray(body.options) ? body.options.map(String) : [],
    }
    const twin = state.rules.some((r) => r !== rule && formatRule(r) === formatRule(next))
    const error = ruleError(next, ruleTargets(state.nodes)) ?? (twin ? '已有一条相同的规则' : null)
    if (error) return c.json({ error }, 400)
    Object.assign(rule, next)
    return c.json(commit())
  })

  app.post('/api/rules/delete', async (c) => {
    const { ids } = await c.req.json<{ ids: string[] }>()
    if (!Array.isArray(ids)) return c.json({ error: '参数无效' }, 400)
    state.rules = state.rules.filter((r) => !ids.includes(r.id))
    return c.json(commit())
  })

  app.post('/api/rules/reorder', async (c) => {
    const rules = reordered(state.rules, (await c.req.json<{ ids: string[] }>()).ids)
    if (!rules) return c.json({ error: '排序列表与现有规则不一致' }, 400)
    state.rules = rules
    return c.json(commit())
  })

  app.post('/api/rules/reset', (c) => {
    state.rules = seedRules()
    return c.json(commit())
  })

  app.post('/api/token/reset', (c) => {
    state.token = newToken()
    return c.json(commit())
  })

  app.get('/sub/:token/:target', (c) => {
    if (!tokenMatches(c.req.param('token'), state.token)) return c.text('Not Found', 404)
    c.header('Cache-Control', 'no-store')
    c.header('Profile-Update-Interval', '24')
    switch (c.req.param('target')) {
      case 'clash':
        c.header('Content-Type', 'text/yaml; charset=utf-8')
        c.header('Content-Disposition', `attachment; filename=clash-${Math.floor(Date.now() / 1000)}.yaml`)
        return c.body(renderClash(state.nodes, state.rules).yaml)
      case 'shadowrocket':
        return c.text(Buffer.from(renderShadowrocket(state.nodes).text).toString('base64'))
      default:
        return c.text('Not Found', 404)
    }
  })

  return app
}
