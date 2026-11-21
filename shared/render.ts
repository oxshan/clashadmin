import { stringify } from 'yaml'
import { GROUP, general, rules } from './template'
import type { ClashProxy, NodeRecord } from './types'
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

export function buildProxies(nodes: NodeRecord[]): { proxies: ClashProxy[]; warnings: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const proxies: ClashProxy[] = []
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
    const proxy: ClashProxy = { ...node.proxy, name: node.name }
    if (!node.dialerId) {
      proxies.push(proxy)
      continue
    }
    if (node.keepDirect) proxies.push(proxy)
    if (!chainOk(node)) {
      warnings.push(`「${node.name}」的前置节点不可用（已删除、已禁用、成环，或它自己的前置不可用），链式节点未输出`)
      continue
    }
    const dialer = byId.get(node.dialerId)!
    if (node.type === 'hysteria2' || node.type === 'tuic')
      warnings.push(`「${node.name}」基于 UDP，前置节点「${dialer.name}」必须支持 UDP 转发，否则无法连通`)
    proxies.push({ ...proxy, name: node.keepDirect ? chainName(node.name, dialer.name) : node.name, 'dialer-proxy': dialer.name })
  }
  return { proxies, warnings }
}

export function renderClash(nodes: NodeRecord[]): { yaml: string; warnings: string[] } {
  const { proxies, warnings } = buildProxies(nodes)
  const config = {
    ...general,
    proxies,
    'proxy-groups': [{ name: GROUP, type: 'select', proxies: [...proxies.map((p) => p.name), 'DIRECT'] }],
    rules,
  }
  return { yaml: stringify(config, { lineWidth: 0 }), warnings }
}

export function rocketUri(n: Pick<NodeRecord, 'name' | 'type' | 'uri' | 'proxy'>): string {
  if (n.type === 'vmess') return toUri({ ...n.proxy, name: n.name })
  const uri = n.uri || toUri(n.proxy)
  return uri && `${uri.split('#')[0]}#${encodeURIComponent(n.name)}`
}

export function renderShadowrocket(nodes: NodeRecord[]): { text: string; warnings: string[] } {
  const lines: string[] = []
  const skipped: string[] = []
  for (const n of nodes) {
    if (!n.enabled) continue
    const line = rocketUri(n)
    if (line) lines.push(line)
    else skipped.push(n.name)
  }
  return {
    text: lines.join('\n'),
    warnings: skipped.length ? [`小火箭订阅不包含以下节点（该类型或传输方式暂无法转换为链接）：${skipped.join('、')}`] : [],
  }
}
