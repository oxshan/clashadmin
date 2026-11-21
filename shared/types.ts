export type Protocol = 'vless' | 'hysteria2' | 'tuic' | 'socks5'

export type ClashProxy = { name: string; type: string; server: string; port: number } & Record<string, unknown>

export interface ParsedNode {
  name: string
  type: string
  server: string
  port: number
  uri: string
  proxy: ClashProxy
}

export interface YamlNode extends ParsedNode {
  index: number
  sourceName: string
  dialerName: string | null
  duplicateOf: string | null
}

export interface YamlCandidate {
  index: number
  name: string
  type: string
  server: string
  port: number
  dialerName: string | null
  duplicateOf: string | null
  rocket: boolean
}

export interface YamlPreview {
  text: string
  nodes: YamlCandidate[]
  errors: ParseError[]
}

export type BatchAction = 'enable' | 'disable' | 'delete'

export interface NodeRecord extends ParsedNode {
  id: string
  enabled: boolean
  dialerId: string | null
  keepDirect: boolean
}

export interface ParseError {
  line: number
  text: string
  error: string
  duplicate?: boolean
}

export interface ParseResult<T extends ParsedNode = ParsedNode> {
  nodes: T[]
  errors: ParseError[]
}

export interface ImportResult {
  added: number
  errors: ParseError[]
  state: AppState
}

export interface AppState {
  token: string
  nodes: NodeRecord[]
}

export interface Preview {
  clash: string
  shadowrocket: string
  warnings: string[]
}
