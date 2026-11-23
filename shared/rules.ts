import { GROUP, rules as template } from './template'
import type { ParseError, Rule } from './types'

export const POLICIES = [GROUP, 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS']
export const RULE_OPTIONS = ['no-resolve', 'src']
export const RULE_TYPES = [
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-WILDCARD',
  'DOMAIN-REGEX',
  'GEOSITE',
  'IP-CIDR',
  'IP-CIDR6',
  'IP-SUFFIX',
  'IP-ASN',
  'GEOIP',
  'SRC-GEOIP',
  'SRC-IP-ASN',
  'SRC-IP-CIDR',
  'SRC-IP-SUFFIX',
  'DST-PORT',
  'SRC-PORT',
  'IN-PORT',
  'IN-TYPE',
  'IN-USER',
  'IN-NAME',
  'PROCESS-PATH',
  'PROCESS-PATH-WILDCARD',
  'PROCESS-PATH-REGEX',
  'PROCESS-NAME',
  'PROCESS-NAME-WILDCARD',
  'PROCESS-NAME-REGEX',
  'UID',
  'NETWORK',
  'DSCP',
  'AND',
  'OR',
  'NOT',
  'MATCH',
]

const UNSUPPORTED: Record<string, string> = {
  'RULE-SET': 'RULE-SET 需要 rule-providers，本面板不生成，暂不支持',
  'SUB-RULE': 'SUB-RULE 需要 sub-rules，本面板不生成，暂不支持',
  'REMATCH-NAME': 'REMATCH-NAME 需要 rematch 出站，本面板不生成，暂不支持',
}
const LOGIC = new Set(['AND', 'OR', 'NOT'])

export const formatRule = (r: Rule) => [r.type, r.payload, r.target, ...r.options].filter(Boolean).join(',')

function balanced(text: string): boolean {
  let depth = 0
  for (const ch of text) {
    if (ch === '(') depth++
    else if (ch === ')' && --depth < 0) return false
  }
  return depth === 0 && text.startsWith('((') && text.endsWith('))')
}

export function ruleError(r: Rule, targets?: string[]): string | null {
  if (UNSUPPORTED[r.type]) return UNSUPPORTED[r.type]
  if (!RULE_TYPES.includes(r.type)) return `不支持的规则类型: ${r.type || '（空）'}`
  if (r.type === 'MATCH') {
    if (r.payload || r.options.length) return 'MATCH 不能带匹配内容或参数'
  } else if (!r.payload) return '缺少匹配内容'
  else if (LOGIC.has(r.type)) {
    if (!balanced(r.payload)) return '逻辑规则的匹配内容要写成 ((规则),(规则))，注意括号成对'
  } else if (r.payload.includes(',')) return '匹配内容不能包含逗号'
  const unknown = r.options.find((o) => !RULE_OPTIONS.includes(o))
  if (unknown) return `未知参数: ${unknown}（只支持 ${RULE_OPTIONS.join('、')}）`
  if (!r.target) return '缺少目标策略'
  if (/[\r\n]/.test(r.payload) || /[,\r\n]/.test(r.target)) return '匹配内容不能换行，目标名称不能包含逗号'
  if (targets && !targets.includes(r.target)) return `目标「${r.target}」不存在，可用的目标是 ${POLICIES.join('、')} 或已启用的节点名`
  return null
}

function fields(text: string): string[] {
  const parts = text.split(',').map((s) => s.trim())
  if (!LOGIC.has(parts[0].toUpperCase())) return parts
  const start = text.indexOf(',') + 1
  let depth = 0
  for (let i = start; start && i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return [parts[0], text.slice(start, i + 1).trim(), ...text.slice(i + 1).split(',').slice(1).map((s) => s.trim())]
  }
  return [parts[0], start ? text.slice(start).trim() : '']
}

export function parseRule(line: string, fallback = '', targets?: string[]): Rule {
  const [head, ...rest] = fields(
    line
      .trim()
      .replace(/^-\s+/, '')
      .replace(/^(['"])(.*)\1$/, '$2')
      .trim(),
  )
  const type = head.toUpperCase()
  const payload = type === 'MATCH' ? '' : (rest.shift() ?? '')
  const target = rest.length && !RULE_OPTIONS.includes(rest[0]) ? rest.shift()! : fallback
  const rule: Rule = { type, payload, target, options: rest }
  const error = ruleError(rule, targets)
  if (error) throw new Error(error)
  return rule
}

export interface RuleContext {
  fallback?: string
  targets?: string[]
  existing?: Rule[]
}

export function parseRules(text: string, { fallback = '', targets, existing = [] }: RuleContext = {}): { rules: Rule[]; errors: ParseError[] } {
  const seen = new Set(existing.map(formatRule))
  const result = { rules: [] as Rule[], errors: [] as ParseError[] }
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#') || /^rules\s*:$/i.test(line)) return
    try {
      const rule = parseRule(line, fallback, targets)
      const key = formatRule(rule)
      if (seen.has(key)) return result.errors.push({ line: i + 1, text: line, error: '规则已存在，跳过', duplicate: true })
      seen.add(key)
      result.rules.push(rule)
    } catch (e) {
      result.errors.push({ line: i + 1, text: line, error: (e as Error).message })
    }
  })
  return result
}

export const defaultRules: Rule[] = template.map((line) => parseRule(line))
