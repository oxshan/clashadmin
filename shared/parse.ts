import { GROUP } from './template'
import type { ClashProxy, ParsedNode, ParseResult, Protocol } from './types'

const truthy = (v: string | null) => v === '1' || v === 'true'
const list = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined)
const insecure = (q: URLSearchParams) =>
  truthy(q.get('insecure')) || truthy(q.get('allowInsecure')) || truthy(q.get('allow_insecure'))

function clean<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (v === undefined || v === null || v === '') delete obj[k]
    else if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(clean(v as Record<string, unknown>)).length) delete obj[k]
  }
  return obj
}

function base(url: URL, type: Protocol): ClashProxy {
  const server = url.hostname.replace(/^\[|\]$/g, '')
  const port = Number(url.port)
  if (!server) throw new Error('缺少服务器地址')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效')
  const name = decodeURIComponent(url.hash.slice(1)).trim() || `${type}-${server}:${port}`
  return { name, type, server, port }
}

function vless(url: URL): ClashProxy {
  const q = url.searchParams
  const uuid = decodeURIComponent(url.username)
  if (!uuid) throw new Error('缺少 UUID')
  const security = q.get('security') ?? 'none'
  const network = q.get('type') ?? 'tcp'
  if (!['tcp', 'ws', 'grpc'].includes(network)) throw new Error(`暂不支持的传输方式: ${network}`)
  if (security === 'reality' && !q.get('pbk')) throw new Error('reality 缺少 pbk')
  const tls = security === 'tls' || security === 'reality'
  return clean({
    ...base(url, 'vless'),
    uuid,
    network,
    udp: true,
    tls,
    flow: q.get('flow'),
    servername: tls ? q.get('sni') : undefined,
    'client-fingerprint': tls ? q.get('fp') : undefined,
    alpn: tls ? list(q.get('alpn')) : undefined,
    'skip-cert-verify': tls && insecure(q) ? true : undefined,
    'reality-opts': security === 'reality' ? { 'public-key': q.get('pbk'), 'short-id': q.get('sid') } : undefined,
    'ws-opts': network === 'ws' ? { path: q.get('path') ?? '/', headers: { Host: q.get('host') } } : undefined,
    'grpc-opts': network === 'grpc' ? { 'grpc-service-name': q.get('serviceName') } : undefined,
  })
}

function hysteria2(url: URL): ClashProxy {
  const q = url.searchParams
  const password = decodeURIComponent(url.password ? `${url.username}:${url.password}` : url.username)
  if (!password) throw new Error('缺少密码')
  return clean({
    ...base(url, 'hysteria2'),
    password,
    sni: q.get('sni'),
    alpn: list(q.get('alpn')),
    'skip-cert-verify': insecure(q) ? true : undefined,
    fingerprint: q.get('pinSHA256'),
    obfs: q.get('obfs') === 'none' ? undefined : q.get('obfs'),
    'obfs-password': q.get('obfs-password'),
  })
}

function tuic(url: URL): ClashProxy {
  const q = url.searchParams
  const uuid = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  if (!uuid || !password) throw new Error('需要 uuid:password')
  return clean({
    ...base(url, 'tuic'),
    uuid,
    password,
    sni: q.get('sni'),
    alpn: list(q.get('alpn')),
    'skip-cert-verify': insecure(q) ? true : undefined,
    'congestion-controller': q.get('congestion_control'),
    'udp-relay-mode': q.get('udp_relay_mode'),
    'disable-sni': truthy(q.get('disable_sni')) ? true : undefined,
  })
}

function socks5(url: URL): ClashProxy {
  let username = decodeURIComponent(url.username)
  let password = decodeURIComponent(url.password)
  if (username && !password) {
    try {
      const decoded = atob(username.replace(/-/g, '+').replace(/_/g, '/'))
      const sep = decoded.indexOf(':')
      if (sep > 0 && /^[\x20-\x7e]+$/.test(decoded)) [username, password] = [decoded.slice(0, sep), decoded.slice(sep + 1)]
    } catch {}
  }
  return clean({ ...base(url, 'socks5'), username, password, udp: true })
}

const parsers: Record<string, (url: URL) => ClashProxy> = { vless, hysteria2, hy2: hysteria2, tuic, socks5, socks: socks5, socks5h: socks5 }

export function parseUri(line: string): ParsedNode {
  const uri = line.trim()
  const scheme = uri.match(/^([a-z0-9]+):\/\//i)?.[1].toLowerCase()
  const parser = scheme && parsers[scheme]
  if (!parser) throw new Error(scheme ? `暂不支持的协议: ${scheme}` : '不是有效的节点链接')
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new Error('链接格式错误')
  }
  const proxy = parser(url)
  return { name: proxy.name, type: proxy.type, server: proxy.server, port: proxy.port, uri, proxy }
}

export function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name
  for (let i = 2; taken.has(candidate); i++) candidate = `${name}-${i}`
  taken.add(candidate)
  return candidate
}

export const RESERVED_NAMES = [GROUP, 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']

export const nodeKey = (p: ClashProxy) =>
  [p.type, p.server.toLowerCase(), p.port, p.uuid ?? '', p.password ?? '', p.username ?? ''].join('|')

export type Existing = Pick<ParsedNode, 'name' | 'proxy'>

export function parseLines(text: string, existing: Existing[] = []): ParseResult {
  const taken = new Set([...RESERVED_NAMES, ...existing.map((n) => n.name)])
  const keys = new Set(existing.map((n) => nodeKey(n.proxy)))
  const result: ParseResult = { nodes: [], errors: [] }
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    try {
      const node = parseUri(line)
      const key = nodeKey(node.proxy)
      if (keys.has(key)) return result.errors.push({ line: i + 1, text: line, error: '节点已存在（类型、地址、端口、凭据相同），跳过', duplicate: true })
      keys.add(key)
      node.name = node.proxy.name = uniqueName(node.name, taken)
      result.nodes.push(node)
    } catch (e) {
      result.errors.push({ line: i + 1, text: line, error: (e as Error).message })
    }
  })
  return result
}
