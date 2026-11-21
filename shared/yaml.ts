import { parse } from 'yaml'
import { type Existing, RESERVED_NAMES, nodeKey, uniqueName } from './parse'
import type { ClashProxy, ParseResult, YamlNode } from './types'

type Raw = Record<string, unknown>
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v))
const flag = (v: unknown) => (v === true ? '1' : '')
const csv = (v: unknown) => (Array.isArray(v) ? v.join(',') : str(v))
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})
const enc = encodeURIComponent
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

function build(scheme: string, userinfo: string, p: ClashProxy, params: Record<string, string>): string {
  const host = p.server.includes(':') ? `[${p.server}]` : p.server
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString()
  return `${scheme}://${userinfo && `${userinfo}@`}${host}:${p.port}${query && `?${query}`}#${enc(p.name)}`
}

function transport(p: ClashProxy, allowed: string[]): Record<string, string> | null {
  const network = str(p.network) || 'tcp'
  if (!allowed.includes(network)) return null
  const ws = obj(p['ws-opts'])
  return {
    type: network,
    path: network === 'ws' ? str(ws.path) : '',
    host: network === 'ws' ? str(obj(ws.headers).Host) : '',
    serviceName: network === 'grpc' ? str(obj(p['grpc-opts'])['grpc-service-name']) : '',
  }
}

function ssPlugin(p: ClashProxy): string | null {
  const o = obj(p['plugin-opts'])
  switch (p.plugin) {
    case undefined:
    case null:
    case '':
      return ''
    case 'obfs':
      return ['obfs-local', `obfs=${str(o.mode)}`, o.host && `obfs-host=${str(o.host)}`].filter(Boolean).join(';')
    case 'v2ray-plugin':
      return ['v2ray-plugin', `mode=${str(o.mode) || 'websocket'}`, o.tls && 'tls', o.host && `host=${str(o.host)}`, o.path && `path=${str(o.path)}`]
        .filter(Boolean)
        .join(';')
    default:
      return null
  }
}

function vmess(p: ClashProxy): string {
  const net = str(p.network) || 'tcp'
  if (!p.uuid || !['tcp', 'ws', 'grpc', 'h2'].includes(net)) return ''
  const ws = obj(p['ws-opts'])
  const h2 = obj(p['h2-opts'])
  const host = net === 'ws' ? str(obj(ws.headers).Host) : net === 'h2' ? csv(h2.host) : ''
  const path = net === 'ws' ? str(ws.path) : net === 'h2' ? str(h2.path) : net === 'grpc' ? str(obj(p['grpc-opts'])['grpc-service-name']) : ''
  const json = {
    v: '2',
    ps: p.name,
    add: p.server,
    port: String(p.port),
    id: str(p.uuid),
    aid: str(p.alterId ?? 0),
    scy: str(p.cipher) || 'auto',
    net,
    type: 'none',
    host,
    path,
    tls: p.tls ? 'tls' : '',
    sni: str(p.servername),
    alpn: csv(p.alpn),
    fp: str(p['client-fingerprint']),
  }
  return `vmess://${b64(JSON.stringify(json))}`
}

export function toUri(p: ClashProxy): string {
  switch (p.type) {
    case 'vless': {
      const reality = obj(p['reality-opts'])
      const tp = transport(p, ['tcp', 'ws', 'grpc'])
      if (!p.uuid || !tp) return ''
      return build('vless', enc(str(p.uuid)), p, {
        encryption: 'none',
        flow: str(p.flow),
        security: reality['public-key'] ? 'reality' : p.tls ? 'tls' : 'none',
        sni: str(p.servername),
        fp: str(p['client-fingerprint']),
        pbk: str(reality['public-key']),
        sid: str(reality['short-id']),
        alpn: csv(p.alpn),
        allowInsecure: flag(p['skip-cert-verify']),
        ...tp,
      })
    }
    case 'trojan': {
      const reality = obj(p['reality-opts'])
      const tp = transport(p, ['tcp', 'ws', 'grpc'])
      if (!p.password || !tp) return ''
      return build('trojan', enc(str(p.password)), p, {
        security: reality['public-key'] ? 'reality' : 'tls',
        sni: str(p.sni),
        fp: str(p['client-fingerprint']),
        pbk: str(reality['public-key']),
        sid: str(reality['short-id']),
        alpn: csv(p.alpn),
        allowInsecure: flag(p['skip-cert-verify']),
        ...tp,
      })
    }
    case 'ss': {
      const plugin = ssPlugin(p)
      if (!p.cipher || !p.password || plugin === null) return ''
      const userinfo = b64(`${str(p.cipher)}:${str(p.password)}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      return build('ss', userinfo, p, { plugin })
    }
    case 'vmess':
      return vmess(p)
    case 'hysteria2':
      if (!p.password) return ''
      return build('hysteria2', enc(str(p.password)), p, {
        sni: str(p.sni),
        alpn: csv(p.alpn),
        insecure: flag(p['skip-cert-verify']),
        pinSHA256: str(p.fingerprint),
        obfs: str(p.obfs),
        'obfs-password': str(p['obfs-password']),
      })
    case 'tuic':
      if (!p.uuid || !p.password) return ''
      return build('tuic', `${enc(str(p.uuid))}:${enc(str(p.password))}`, p, {
        congestion_control: str(p['congestion-controller']),
        udp_relay_mode: str(p['udp-relay-mode']),
        alpn: csv(p.alpn),
        sni: str(p.sni),
        allow_insecure: flag(p['skip-cert-verify']),
        disable_sni: flag(p['disable-sni']),
      })
    case 'socks5':
      if (p.tls) return ''
      return build('socks5', p.username ? `${enc(str(p.username))}:${enc(str(p.password))}` : '', p, {})
    default:
      return ''
  }
}

function toProxy(item: unknown): { proxy: ClashProxy; dialerName: string | null } {
  const raw = obj(item)
  const name = str(raw.name).trim()
  const port = Number(raw.port)
  if (!name) throw new Error('缺少 name')
  if (!raw.type || !raw.server) throw new Error('缺少 type 或 server')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效')
  const { 'dialer-proxy': dialer, ...rest } = raw
  return { proxy: { ...rest, name, type: str(raw.type), server: str(raw.server), port } as ClashProxy, dialerName: str(dialer) || null }
}

function load(text: string): unknown {
  try {
    return parse(text)
  } catch (e) {
    throw new Error(`YAML 解析失败: ${(e as Error).message.split('\n')[0]}`)
  }
}

export function parseProxyYaml(text: string): ClashProxy {
  const doc = load(text)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('内容必须是单个节点的字段映射')
  const { proxy, dialerName } = toProxy(doc)
  if (dialerName) throw new Error('请在节点列表中设置前置节点，不要写 dialer-proxy')
  return proxy
}

export function parseClashYaml(text: string, existing: Existing[] = []): ParseResult<YamlNode> {
  const doc = load(text)
  const list = Array.isArray(doc) ? doc : obj(doc).proxies
  if (!Array.isArray(list)) throw new Error('文件中没有 proxies 列表')
  const taken = new Set([...RESERVED_NAMES, ...existing.map((n) => n.name)])
  const keys = new Map(existing.map((n) => [nodeKey(n.proxy), n.name]))
  const seen = new Set<string>()
  const result: ParseResult<YamlNode> = { nodes: [], errors: [] }
  list.forEach((item, index) => {
    const fallback = str(obj(item).name).trim() || `#${index + 1}`
    try {
      const { proxy, dialerName } = toProxy(item)
      const sourceName = proxy.name
      const key = nodeKey(proxy)
      if (seen.has(key)) throw new Error('与文件内其他节点重复，跳过')
      seen.add(key)
      const duplicateOf = keys.get(key) ?? null
      if (!duplicateOf) proxy.name = uniqueName(sourceName, taken)
      result.nodes.push({ name: proxy.name, type: proxy.type, server: proxy.server, port: proxy.port, uri: toUri(proxy), proxy, index, sourceName, dialerName, duplicateOf })
    } catch (e) {
      result.errors.push({ line: index + 1, text: fallback, error: (e as Error).message })
    }
  })
  return result
}
