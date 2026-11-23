import { stringify } from 'yaml'
import { POLICIES, defaultRules, formatRule } from './rules'
import { GROUP, general } from './template'
import type { ClashProxy, NodeRecord, Rule } from './types'
import { toUri } from './yaml'

export const chainName = (node: string, dialer: string) => `${node} ⟵ ${dialer}`

export function chainError(nodes: NodeRecord[], id: string, dialerId: string | null): string | null {
  if (!dialerId) return null
  const byId = new Map(nodes.map((n) => [n.id, n]))
  if (!byId.has(dialerId)) return '前置节点不存在'
  const seen = new Set([id])
  for (let cur: string | null = dialerId; cur; cur = byId.get(cur)?.dialerId ?? null) {
    if (seen.has(cur)) return '前置关系形成了环路'
    seen.add(cur)
  }
  return null
}

interface Planned {
  node: NodeRecord
  name: string
  dialer: NodeRecord | null
}

function plan(nodes: NodeRecord[]): { items: Planned[]; warnings: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const items: Planned[] = []
  const warnings: string[] = []
  const memo = new Map<string, boolean>()
  const emitted = (n: NodeRecord): boolean => n.enabled && (!n.dialerId || n.keepDirect || chainOk(n))
  const chainOk = (n: NodeRecord): boolean => {
    if (!memo.has(n.id)) {
      const dialer = byId.get(n.dialerId!)
      memo.set(n.id, !!dialer && !chainError(nodes, n.id, n.dialerId) && emitted(dialer))
    }
    return memo.get(n.id)!
  }
  for (const node of nodes) {
    if (!node.enabled) continue
    if (!node.dialerId || node.keepDirect) items.push({ node, name: node.name, dialer: null })
    if (!node.dialerId) continue
    if (!chainOk(node)) {
      warnings.push(`「${node.name}」的前置节点不可用（已删除、已禁用、成环，或它自己的前置不可用），链式节点未输出`)
      continue
    }
    const dialer = byId.get(node.dialerId)!
    items.push({ node, name: node.keepDirect ? chainName(node.name, dialer.name) : node.name, dialer })
  }
  return { items, warnings }
}

const outputNames = (nodes: NodeRecord[]) => new Map(plan(nodes).items.map((i) => [`${i.node.id}/${i.dialer ? 'chain' : 'direct'}`, i.name]))

export const ruleTargets = (nodes: NodeRecord[]) => [...POLICIES, ...outputNames(nodes).values()]

export const nodeNames = (nodes: NodeRecord[]) => outputNames(nodes.map((n) => ({ ...n, enabled: true })))

export const renamed = (before: Map<string, string>, after: Map<string, string>) =>
  new Map([...before].flatMap(([key, name]): [string, string][] => (after.has(key) && after.get(key) !== name ? [[name, after.get(key)!]] : [])))

export function buildProxies(nodes: NodeRecord[]): { proxies: ClashProxy[]; warnings: string[] } {
  const { items, warnings } = plan(nodes)
  const proxies = items.map(({ node, name, dialer }): ClashProxy => {
    if (dialer && (node.type === 'hysteria2' || node.type === 'tuic'))
      warnings.push(`「${node.name}」基于 UDP，前置节点「${dialer.name}」必须支持 UDP 转发，否则无法连通`)
    return { ...node.proxy, name, ...(dialer && { 'dialer-proxy': dialer.name }) }
  })
  return { proxies, warnings }
}

export function renderClash(nodes: NodeRecord[], rules: Rule[] = defaultRules): { yaml: string; warnings: string[] } {
  const { proxies, warnings } = buildProxies(nodes)
  const targets = new Set([...POLICIES, ...proxies.map((p) => p.name)])
  const kept = rules.filter((r) => targets.has(r.target))
  for (const r of rules) if (!targets.has(r.target)) warnings.push(`规则「${formatRule(r)}」的目标节点不在订阅里（已删除、已禁用或前置不可用），该规则未输出`)
  const match = kept.findIndex((r) => r.type === 'MATCH')
  if (match < 0) warnings.push('规则里没有 MATCH 兜底，没有命中任何规则的流量会直连')
  else if (match < kept.length - 1) warnings.push(`MATCH 之后的 ${kept.length - 1 - match} 条规则不会生效，请把 MATCH 移到最后`)
  const config = {
    ...general,
    proxies,
    'proxy-groups': [{ name: GROUP, type: 'select', proxies: [...proxies.map((p) => p.name), 'DIRECT'] }],
    rules: kept.map(formatRule),
  }
  return { yaml: stringify(config, { lineWidth: 0 }), warnings }
}

export function rocketUri(n: Pick<NodeRecord, 'name' | 'type' | 'uri' | 'proxy'>): string {
  if (n.type === 'vmess') return toUri({ ...n.proxy, name: n.name })
  const uri = n.uri || toUri(n.proxy)
  return uri && `${uri.split('#')[0]}#${encodeURIComponent(n.name)}`
}

const ROCKET_NO_CHAIN = new Set(['hysteria', 'hysteria2', 'tuic', 'juicity', 'wireguard', 'anytls'])

function withChain(uri: string, dialer: string): string {
  const hash = uri.indexOf('#')
  const base = hash < 0 ? uri : uri.slice(0, hash)
  return `${base}${base.includes('?') ? '&' : '?'}chain=${encodeURIComponent(dialer)}${hash < 0 ? '' : uri.slice(hash)}`
}

export function renderShadowrocket(nodes: NodeRecord[]): { text: string; warnings: string[] } {
  const { items, warnings } = plan(nodes)
  const skipped: string[] = []
  let entries = items.flatMap(({ node, name, dialer }) => {
    const line = rocketUri({ ...node, name })
    if (!line) skipped.push(name)
    else if (dialer && ROCKET_NO_CHAIN.has(node.type))
      warnings.push(`「${node.name}」的协议在小火箭里不支持「代理通过」，小火箭订阅未输出该链式节点`)
    else return [{ node, name, dialer, line }]
    return []
  })
  for (;;) {
    const names = new Set(entries.map((e) => e.name))
    const kept = entries.filter((e) => !e.dialer || names.has(e.dialer.name))
    if (kept.length === entries.length) break
    for (const e of entries)
      if (!kept.includes(e)) warnings.push(`「${e.node.name}」的前置节点「${e.dialer!.name}」不在小火箭订阅里，小火箭订阅未输出该链式节点`)
    entries = kept
  }
  if (skipped.length) warnings.push(`小火箭订阅不包含以下节点（该类型或传输方式暂无法转换为链接）：${skipped.join('、')}`)
  return { text: entries.map((e) => (e.dialer ? withChain(e.line, e.dialer.name) : e.line)).join('\n'), warnings }
}
