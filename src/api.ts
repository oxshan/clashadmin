import { reactive } from 'vue'
import type { AppState, BatchAction, ImportResult, NodeRecord, Preview, YamlPreview } from '../shared/types'

export const session = reactive<{ authed: boolean | null }>({ authed: null })

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  if (res.status === 401 && path !== '/api/login') session.authed = false
  if (!res.ok) throw new Error(data?.error ?? `请求失败 (${res.status})`)
  return data as T
}

export type NodePatch = Partial<Pick<NodeRecord, 'name' | 'enabled' | 'dialerId' | 'keepDirect'>>

type Authed = { authed: boolean }

export const api = {
  session: () => request<Authed>('/api/session'),
  login: (password: string) => request<Authed>('/api/login', 'POST', { password }),
  logout: () => request<Authed>('/api/logout', 'POST'),
  state: () => request<AppState>('/api/state'),
  lan: () => request<{ origins: string[]; publicUrl: string }>('/api/lan'),
  preview: () => request<Preview>('/api/preview'),
  importNodes: (text: string) => request<ImportResult>('/api/nodes/import', 'POST', { text }),
  previewYaml: (body: { text: string } | { source: string }) => request<YamlPreview>('/api/yaml/preview', 'POST', body),
  importYaml: (text: string, select: number[]) => request<ImportResult>('/api/nodes/import-yaml', 'POST', { text, select }),
  batch: (ids: string[], action: BatchAction) => request<AppState>('/api/nodes/batch', 'POST', { ids, action }),
  putNode: (id: string, yaml: string) => request<AppState>(`/api/nodes/${id}`, 'PUT', { yaml }),
  patchNode: (id: string, patch: NodePatch) => request<AppState>(`/api/nodes/${id}`, 'PATCH', patch),
  deleteNode: (id: string) => request<AppState>(`/api/nodes/${id}`, 'DELETE'),
  reorder: (ids: string[]) => request<AppState>('/api/nodes/reorder', 'POST', { ids }),
  resetToken: () => request<AppState>('/api/token/reset', 'POST'),
}
