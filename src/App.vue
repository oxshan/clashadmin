<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import qrcode from 'qrcode-generator'
import { stringify } from 'yaml'
import { parseLines } from '../shared/parse'
import { chainError, nodeNames, renamed, ruleTargets } from '../shared/render'
import { POLICIES, RULE_OPTIONS, RULE_TYPES, formatRule, parseRules } from '../shared/rules'
import type { AppState, BatchAction, NodeRecord, ParseError, Preview, RuleRecord, YamlPreview } from '../shared/types'
import { api, type NodePatch, session } from './api'

const state = ref<AppState>({ token: '', nodes: [], rules: [] })
const preview = ref<Preview>({ clash: '', shadowrocket: '', warnings: [] })
const input = ref('')
const error = ref('')
const busy = ref(false)
const loaded = ref(false)
const tab = ref<'clash' | 'shadowrocket' | 'qr'>('clash')
const copied = ref('')

const parsed = computed(() => parseLines(input.value, state.value.nodes))
const publicUrl = ref('')
const clashUrl = computed(() => `${publicUrl.value || location.origin}/sub/${state.value.token}/clash`)

const lanOrigins = ref<string[]>([])
const lanOrigin = ref('')
const rocketUrl = computed(() => (lanOrigin.value && state.value.token ? `${lanOrigin.value}/sub/${state.value.token}/shadowrocket` : ''))
const rocketQr = computed(() => {
  if (!rocketUrl.value) return ''
  const qr = qrcode(0, 'M')
  qr.addData(`sub://${btoa(rocketUrl.value)}`)
  qr.make()
  return qr.createDataURL(6, 12)
})

async function run(action: () => Promise<AppState | void>) {
  busy.value = true
  error.value = ''
  try {
    const next = await action()
    if (next) state.value = next
    preview.value = await api.preview()
  } catch (e) {
    error.value = (e as Error).message
    state.value = await api.state().catch(() => state.value)
  } finally {
    busy.value = false
  }
}

async function loadAll() {
  await run(api.state)
  loaded.value = true
  const { origins, publicUrl: fixed } = await api.lan().catch(() => ({ origins: [] as string[], publicUrl: '' }))
  publicUrl.value = fixed
  lanOrigins.value = origins.length || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? origins : [location.origin]
  lanOrigin.value = lanOrigins.value[0] ?? ''
}

onMounted(async () => {
  session.authed = await api.session().then((r) => r.authed, () => false)
})

watch(
  () => session.authed,
  (authed) => {
    if (authed) return loadAll()
    state.value = { token: '', nodes: [], rules: [] }
    preview.value = { clash: '', shadowrocket: '', warnings: [] }
    input.value = ruleInput.value = error.value = ''
    yamlPreview.value = yamlResult.value = null
    picked.value = pickedRules.value = []
    loaded.value = false
    dialog.value?.close()
    ruleDialog.value?.close()
  },
)

const password = ref('')
const loginError = ref('')
const loggingIn = ref(false)

async function login() {
  loggingIn.value = true
  loginError.value = ''
  try {
    await api.login(password.value)
    session.authed = true
  } catch (e) {
    loginError.value = (e as Error).message
  } finally {
    password.value = ''
    loggingIn.value = false
  }
}

const logout = () =>
  api
    .logout()
    .catch(() => {})
    .finally(() => (session.authed = false))

const importNodes = () =>
  run(async () => {
    const { errors, state: next } = await api.importNodes(input.value)
    input.value = errors.filter((e) => !e.duplicate).map((e) => e.text).join('\n')
    return next
  })

const badLines = computed(() => parsed.value.errors.filter((e) => !e.duplicate).length)

const source = ref('')
const yamlPreview = ref<YamlPreview | null>(null)
const yamlPicked = ref<number[]>([])
const yamlResult = ref<{ added: number; errors: ParseError[] } | null>(null)
const yamlFresh = computed(() => yamlPreview.value?.nodes.filter((n) => !n.duplicateOf) ?? [])

const loadYaml = (body: { text: string } | { source: string }) =>
  run(async () => {
    yamlResult.value = yamlPreview.value = null
    yamlPreview.value = await api.previewYaml(body)
    yamlPicked.value = yamlFresh.value.map((n) => n.index)
  })

async function loadFile(event: Event) {
  const el = event.target as HTMLInputElement
  const file = el.files?.[0]
  el.value = ''
  if (file) loadYaml({ text: await file.text() })
}

const importYaml = () =>
  run(async () => {
    const { added, errors, state: next } = await api.importYaml(yamlPreview.value!.text, yamlPicked.value)
    yamlResult.value = { added, errors }
    yamlPreview.value = null
    return next
  })

const picked = ref<string[]>([])
const allPicked = computed(() => state.value.nodes.length > 0 && picked.value.length === state.value.nodes.length)
const togglePickAll = () => (picked.value = allPicked.value ? [] : state.value.nodes.map((n) => n.id))

function batch(action: BatchAction) {
  const ids = picked.value
  if (action === 'delete' && !confirm(`删除选中的 ${ids.length} 个节点？以它们为前置的节点会变为直连。`)) return
  run(async () => {
    const next = await api.batch(ids, action)
    if (action === 'delete') picked.value = []
    return next
  })
}

const dialog = ref<HTMLDialogElement>()
const editing = ref<NodeRecord | null>(null)
const editText = ref('')
const editError = ref('')

async function edit(node: NodeRecord) {
  editing.value = node
  editText.value = stringify(node.proxy, { lineWidth: 0 })
  editError.value = ''
  await nextTick()
  dialog.value?.showModal()
}

async function saveEdit() {
  try {
    const next = await api.putNode(editing.value!.id, editText.value)
    dialog.value?.close()
    run(async () => next)
  } catch (e) {
    editError.value = (e as Error).message
  }
}

const patch = (node: NodeRecord, body: NodePatch) => run(() => api.patchNode(node.id, body))

function rename(node: NodeRecord, event: Event) {
  const el = event.target as HTMLInputElement
  const name = el.value.trim()
  if (name && name !== node.name) patch(node, { name })
  else el.value = node.name
}

function remove(node: NodeRecord) {
  picked.value = picked.value.filter((id) => id !== node.id)
  const dependents = state.value.nodes.filter((n) => n.dialerId === node.id).map((n) => n.name)
  const extra = dependents.length ? `\n以下节点会失去前置：${dependents.join('、')}` : ''
  if (confirm(`删除节点「${node.name}」？${extra}`)) run(() => api.deleteNode(node.id))
}

function swapped(list: { id: string }[], index: number, delta: number) {
  const ids = list.map((item) => item.id)
  ;[ids[index], ids[index + delta]] = [ids[index + delta], ids[index]]
  return ids
}

const move = (index: number, delta: number) => run(() => api.reorder(swapped(state.value.nodes, index, delta)))

const targets = computed(() => ruleTargets(state.value.nodes))
const ruleInput = ref('')
const ruleTarget = ref(POLICIES[0])
watch(
  () => state.value.nodes,
  (now, old) => {
    const target = renamed(nodeNames(old), nodeNames(now)).get(ruleTarget.value) ?? ruleTarget.value
    ruleTarget.value = targets.value.includes(target) ? target : POLICIES[0]
  },
)
const parsedRules = computed(() => parseRules(ruleInput.value, { fallback: ruleTarget.value, targets: targets.value, existing: state.value.rules }))
const badRules = computed(() => parsedRules.value.errors.filter((e) => !e.duplicate).length)

const addRules = () =>
  run(async () => {
    const { errors, state: next } = await api.addRules(ruleInput.value, ruleTarget.value)
    ruleInput.value = errors.filter((e) => !e.duplicate).map((e) => e.text).join('\n')
    return next
  })

const pickedRules = ref<string[]>([])
const allRulesPicked = computed(() => state.value.rules.length > 0 && pickedRules.value.length === state.value.rules.length)
const togglePickAllRules = () => (pickedRules.value = allRulesPicked.value ? [] : state.value.rules.map((r) => r.id))

function deleteRules(ids: string[]) {
  const only = ids.length === 1 && state.value.rules.find((r) => r.id === ids[0])
  if (!confirm(only ? `删除规则「${formatRule(only)}」？` : `删除选中的 ${ids.length} 条规则？`)) return
  run(async () => {
    const next = await api.deleteRules(ids)
    pickedRules.value = pickedRules.value.filter((id) => !ids.includes(id))
    return next
  })
}

const moveRule = (index: number, delta: number) => run(() => api.reorderRules(swapped(state.value.rules, index, delta)))

function resetRules() {
  if (!confirm(`恢复默认规则？现有的 ${state.value.rules.length} 条规则会被替换。`)) return
  run(async () => {
    const next = await api.resetRules()
    pickedRules.value = []
    return next
  })
}

const ruleDialog = ref<HTMLDialogElement>()
const ruleDraft = ref<RuleRecord | null>(null)
const ruleEditError = ref('')

async function editRule(rule: RuleRecord) {
  ruleDraft.value = { ...rule, options: [...rule.options] }
  ruleEditError.value = ''
  await nextTick()
  ruleDialog.value?.showModal()
}

async function saveRule() {
  const { id, ...rule } = ruleDraft.value!
  try {
    const next = await api.putRule(id, rule.type === 'MATCH' ? { ...rule, payload: '', options: [] } : rule)
    ruleDialog.value?.close()
    run(async () => next)
  } catch (e) {
    ruleEditError.value = (e as Error).message
  }
}

const resetToken = () => run(api.resetToken)

async function copy(key: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const el = document.createElement('textarea')
    el.value = text
    el.style.cssText = 'position:fixed;opacity:0'
    document.body.append(el)
    el.select()
    const ok = document.execCommand('copy')
    el.remove()
    if (!ok) return (error.value = '复制失败，请手动选中文本复制')
  }
  copied.value = key
  setTimeout(() => copied.value === key && (copied.value = ''), 1500)
}

const dialerOptions = (node: NodeRecord) =>
  state.value.nodes.filter((n) => n.id !== node.id).map((n) => ({ node: n, blocked: chainError(state.value.nodes, node.id, n.id) }))
</script>

<template>
  <header class="topbar">
    <img src="/assets/icon.svg" width="28" height="28" alt="" />
    <h1>clashadmin</h1>
    <span class="muted">节点订阅生成面板</span>
    <div v-if="session.authed" class="account">
      <button @click="logout">退出登录</button>
    </div>
  </header>

  <main v-if="session.authed === false" class="login">
    <form class="card" @submit.prevent="login">
      <h2>登录后台</h2>
      <label for="password">管理密码</label>
      <input id="password" v-model="password" type="password" autocomplete="current-password" required autofocus />
      <p v-if="loginError" class="alert error" role="alert">{{ loginError }}</p>
      <button type="submit" class="primary" :disabled="loggingIn || !password">{{ loggingIn ? '登录中…' : '登录' }}</button>
    </form>
  </main>

  <main v-else-if="session.authed">
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>

    <section class="card" aria-labelledby="import-title">
      <h2 id="import-title">添加节点</h2>
      <label for="uris">节点链接，一行一个（支持 vless、hysteria2 / hy2、tuic、socks5；已存在的节点自动跳过）</label>
      <textarea id="uris" v-model="input" rows="5" spellcheck="false" placeholder="vless://...&#10;hysteria2://...&#10;tuic://...&#10;socks5://user:pass@host:port#name" />
      <ul v-if="parsed.errors.length" class="line-errors" aria-live="polite">
        <li v-for="e in parsed.errors" :key="e.line">第 {{ e.line }} 行：{{ e.error }}</li>
      </ul>
      <div class="row">
        <button class="primary" :disabled="busy || !parsed.nodes.length" @click="importNodes">
          导入 {{ parsed.nodes.length }} 个节点
        </button>
        <span v-if="badLines" class="muted">{{ badLines }} 行无法识别，导入后会留在输入框中</span>
      </div>

      <form class="yaml" @submit.prevent="loadYaml({ source })">
        <label for="yaml-source">或从 Clash YAML 导入：本机文件路径或 http(s) 链接</label>
        <div class="row">
          <input id="yaml-source" v-model="source" class="mono" spellcheck="false" placeholder="/Users/me/.../profile.yaml 或 https://example.com/sub" />
          <button type="submit" :disabled="busy || !source.trim()">加载</button>
          <label class="file">
            选择文件
            <input type="file" accept=".yaml,.yml" :disabled="busy" @change="loadFile" />
          </label>
        </div>
        <div v-if="yamlPreview" class="candidates">
          <p class="muted">
            解析到 {{ yamlPreview.nodes.length }} 个节点，其中 {{ yamlPreview.nodes.length - yamlFresh.length }} 个已存在。勾选要导入的节点：
          </p>
          <ul>
            <li v-for="n in yamlPreview.nodes" :key="n.index">
              <label class="inline">
                <input v-model="yamlPicked" type="checkbox" :value="n.index" :disabled="!!n.duplicateOf" />
                <span class="cand-name">{{ n.name }}</span>
                <span class="badge">{{ n.type }}</span>
                <span class="mono">{{ n.server }}:{{ n.port }}</span>
                <span v-if="n.duplicateOf" class="tag">已存在：{{ n.duplicateOf }}</span>
                <span v-if="n.dialerName" class="tag">前置：{{ n.dialerName }}</span>
                <span v-if="!n.rocket" class="tag">不进小火箭订阅</span>
              </label>
            </li>
          </ul>
          <ul v-if="yamlPreview.errors.length" class="line-errors">
            <li v-for="e in yamlPreview.errors" :key="e.line">第 {{ e.line }} 个（{{ e.text }}）：{{ e.error }}</li>
          </ul>
          <div class="row">
            <button type="button" class="primary" :disabled="busy || !yamlPicked.length" @click="importYaml">导入所选 {{ yamlPicked.length }} 个</button>
            <button type="button" @click="yamlPicked = yamlPicked.length === yamlFresh.length ? [] : yamlFresh.map((n) => n.index)">
              {{ yamlPicked.length === yamlFresh.length ? '全不选' : '全选' }}
            </button>
            <button type="button" @click="yamlPreview = null">取消</button>
          </div>
        </div>
        <div v-if="yamlResult" aria-live="polite">
          <p class="muted">已导入 {{ yamlResult.added }} 个节点{{ yamlResult.errors.length ? `，${yamlResult.errors.length} 条提示：` : '。' }}</p>
          <ul v-if="yamlResult.errors.length" class="line-errors">
            <li v-for="e in yamlResult.errors" :key="e.text + e.error">{{ e.text }}：{{ e.error }}</li>
          </ul>
        </div>
      </form>
    </section>

    <section class="card" aria-labelledby="nodes-title">
      <h2 id="nodes-title">节点 <span class="muted">{{ state.nodes.length }}</span></h2>
      <p v-if="loaded && !state.nodes.length" class="empty">还没有节点，先在上方粘贴链接导入。</p>
      <div v-if="picked.length" class="row batch" role="toolbar" aria-label="批量操作">
        <span>已选 {{ picked.length }} 个</span>
        <button :disabled="busy" @click="batch('enable')">启用</button>
        <button :disabled="busy" @click="batch('disable')">禁用</button>
        <button class="danger" :disabled="busy" @click="batch('delete')">删除</button>
        <button @click="picked = []">取消选择</button>
      </div>
      <div v-if="state.nodes.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col"><input type="checkbox" :checked="allPicked" aria-label="全选节点" @change="togglePickAll" /></th>
              <th scope="col">名称</th>
              <th scope="col">协议</th>
              <th scope="col">地址</th>
              <th scope="col">前置节点</th>
              <th scope="col">启用</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(node, i) in state.nodes" :key="node.id" :class="{ off: !node.enabled }">
              <td><input v-model="picked" type="checkbox" :value="node.id" :aria-label="`选择 ${node.name}`" /></td>
              <td>
                <input class="name" :value="node.name" :aria-label="`节点名称 ${node.name}`" @change="rename(node, $event)" />
              </td>
              <td><span class="badge" :data-type="node.type">{{ node.type }}</span></td>
              <td class="mono">{{ node.server }}:{{ node.port }}</td>
              <td>
                <select
                  :value="node.dialerId ?? ''"
                  :aria-label="`${node.name} 的前置节点`"
                  @change="patch(node, { dialerId: ($event.target as HTMLSelectElement).value || null })"
                >
                  <option value="">无（直连）</option>
                  <option v-for="o in dialerOptions(node)" :key="o.node.id" :value="o.node.id" :disabled="!!o.blocked && o.node.id !== node.dialerId">
                    {{ o.node.name }}{{ o.blocked ? '（会成环）' : o.node.enabled ? '' : '（已禁用）' }}
                  </option>
                </select>
                <label v-if="node.dialerId" class="inline">
                  <input type="checkbox" :checked="node.keepDirect" @change="patch(node, { keepDirect: !node.keepDirect })" />
                  同时保留直连
                </label>
              </td>
              <td>
                <input type="checkbox" role="switch" class="switch" :checked="node.enabled" :aria-label="`启用 ${node.name}`" @change="patch(node, { enabled: !node.enabled })" />
              </td>
              <td class="actions">
                <button :disabled="busy" :aria-label="`编辑 ${node.name}`" @click="edit(node)">编辑</button>
                <button :disabled="busy || i === 0" :aria-label="`上移 ${node.name}`" @click="move(i, -1)">上移</button>
                <button :disabled="busy || i === state.nodes.length - 1" :aria-label="`下移 ${node.name}`" @click="move(i, 1)">下移</button>
                <button class="danger" :disabled="busy" :aria-label="`删除 ${node.name}`" @click="remove(node)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="hint">前置节点：流量先到前置节点，再由它连接当前节点（本机 → 前置 → 当前节点 → 目标）。仅在 Clash 订阅中生效。</p>
    </section>

    <section class="card" aria-labelledby="rules-title">
      <h2 id="rules-title">分流规则 <span class="muted">{{ state.rules.length }}</span></h2>
      <label for="rule-lines">添加规则，一行一条，格式为「类型,匹配内容,目标」，可以直接粘贴 Clash 配置里的 rules 列表（已存在的规则自动跳过）</label>
      <textarea id="rule-lines" v-model="ruleInput" rows="3" spellcheck="false" placeholder="DOMAIN-SUFFIX,openai.com,proxy&#10;IP-CIDR,10.0.0.0/8,DIRECT,no-resolve&#10;DOMAIN-KEYWORD,google" />
      <ul v-if="parsedRules.errors.length" class="line-errors" aria-live="polite">
        <li v-for="e in parsedRules.errors" :key="e.line">第 {{ e.line }} 行：{{ e.error }}</li>
      </ul>
      <div class="row rules-add">
        <button class="primary" :disabled="busy || !parsedRules.rules.length" @click="addRules">添加 {{ parsedRules.rules.length }} 条规则</button>
        <label class="inline">
          没写目标的行发往
          <select v-model="ruleTarget">
            <option v-for="t in targets" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <span v-if="badRules" class="muted">{{ badRules }} 行无法识别，添加后会留在输入框中</span>
      </div>

      <p v-if="loaded && !state.rules.length" class="empty">还没有规则，所有流量都会直连。</p>
      <div v-if="pickedRules.length" class="row batch" role="toolbar" aria-label="规则批量操作">
        <span>已选 {{ pickedRules.length }} 条</span>
        <button class="danger" :disabled="busy" @click="deleteRules(pickedRules)">删除</button>
        <button @click="pickedRules = []">取消选择</button>
      </div>
      <div v-if="state.rules.length" class="table-wrap">
        <table class="rules">
          <thead>
            <tr>
              <th scope="col"><input type="checkbox" :checked="allRulesPicked" aria-label="全选规则" @change="togglePickAllRules" /></th>
              <th scope="col">顺序</th>
              <th scope="col">类型</th>
              <th scope="col">匹配内容</th>
              <th scope="col">目标</th>
              <th scope="col">参数</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(rule, i) in state.rules" :key="rule.id">
              <td><input v-model="pickedRules" type="checkbox" :value="rule.id" :aria-label="`选择规则 ${formatRule(rule)}`" /></td>
              <td class="mono">{{ i + 1 }}</td>
              <td><span class="badge">{{ rule.type }}</span></td>
              <td class="mono payload">
                <template v-if="rule.payload">{{ rule.payload }}</template>
                <span v-else class="muted">其余全部流量</span>
              </td>
              <td>
                {{ rule.target }}
                <span v-if="!targets.includes(rule.target)" class="tag">目标不可用，未输出</span>
              </td>
              <td class="mono">{{ rule.options.join(', ') }}</td>
              <td class="actions">
                <button :disabled="busy" :aria-label="`编辑规则 ${formatRule(rule)}`" @click="editRule(rule)">编辑</button>
                <button :disabled="busy || i === 0" :aria-label="`上移规则 ${formatRule(rule)}`" @click="moveRule(i, -1)">上移</button>
                <button :disabled="busy || i === state.rules.length - 1" :aria-label="`下移规则 ${formatRule(rule)}`" @click="moveRule(i, 1)">下移</button>
                <button class="danger" :disabled="busy" :aria-label="`删除规则 ${formatRule(rule)}`" @click="deleteRules([rule.id])">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="hint">规则从上到下匹配，命中第一条就停止，所以 MATCH 要放在最后；新添加的规则排在最前面。规则只在 Clash 订阅中生效，小火箭订阅只包含节点。</p>
      <div class="row">
        <button :disabled="busy" @click="resetRules">恢复默认规则</button>
      </div>
    </section>

    <section class="card" aria-labelledby="output-title">
      <h2 id="output-title">订阅链接</h2>
      <ul v-if="preview.warnings.length" class="alert warn">
        <li v-for="w in preview.warnings" :key="w">{{ w }}</li>
      </ul>
      <div class="link">
        <label for="link-clash">Clash Verge（mihomo YAML）</label>
        <div class="row">
          <input id="link-clash" class="mono" readonly :value="clashUrl" @focus="($event.target as HTMLInputElement).select()" />
          <button @click="copy('clash', clashUrl)">{{ copied === 'clash' ? '已复制' : '复制' }}</button>
        </div>
      </div>
      <div class="link">
        <label for="link-rocket">小火箭 Shadowrocket（Base64 节点列表）</label>
        <div class="row">
          <input id="link-rocket" class="mono" readonly :value="rocketUrl" placeholder="没有可供手机访问的地址" @focus="($event.target as HTMLInputElement).select()" />
          <button :disabled="!rocketUrl" @click="copy('rocket', rocketUrl)">{{ copied === 'rocket' ? '已复制' : '复制' }}</button>
        </div>
      </div>
      <div class="row">
        <button class="danger" :disabled="busy" @click="resetToken">重置订阅 token</button>
        <span class="muted">链接包含全部节点凭据，请勿公开分享。</span>
      </div>

      <div class="tabs" role="tablist" aria-label="输出预览">
        <button role="tab" :aria-selected="tab === 'clash'" @click="tab = 'clash'">Clash YAML</button>
        <button role="tab" :aria-selected="tab === 'shadowrocket'" @click="tab = 'shadowrocket'">小火箭（解码后）</button>
        <button role="tab" :aria-selected="tab === 'qr'" @click="tab = 'qr'">小火箭二维码</button>
        <button v-if="tab !== 'qr'" class="copy" @click="copy('preview', preview[tab])">{{ copied === 'preview' ? '已复制' : '复制内容' }}</button>
      </div>
      <div v-if="tab === 'qr'" class="panel" role="tabpanel">
        <div v-if="rocketQr" class="qr">
          <img :src="rocketQr" width="216" height="216" alt="小火箭订阅二维码" />
          <div>
            <p>用相机或小火箭的扫一扫扫码，即可添加订阅。手机需要能访问上面的小火箭订阅地址（局域网地址要连同一个 Wi-Fi）。</p>
            <label v-if="lanOrigins.length > 1" for="lan-origin">服务器有多个网络地址，扫码后连不上就换一个：</label>
            <select v-if="lanOrigins.length > 1" id="lan-origin" v-model="lanOrigin">
              <option v-for="o in lanOrigins" :key="o" :value="o">{{ o }}</option>
            </select>
          </div>
        </div>
        <p v-else-if="loaded" class="muted">没有可供手机访问的地址，无法生成二维码。请用局域网 IP 或域名打开本面板，或在服务端配置 PUBLIC_URL。</p>
      </div>
      <pre v-else role="tabpanel" tabindex="0">{{ preview[tab] || '（空）' }}</pre>
    </section>
  </main>

  <dialog ref="dialog" aria-labelledby="edit-title" @close="editing = null">
    <form v-if="editing" @submit.prevent="saveEdit">
      <h2 id="edit-title">编辑节点</h2>
      <label for="edit-yaml">节点字段（Clash YAML）。前置节点请在列表中设置。</label>
      <textarea id="edit-yaml" v-model="editText" rows="16" spellcheck="false" />
      <p v-if="editError" class="alert error" role="alert">{{ editError }}</p>
      <div class="row">
        <button type="submit" class="primary">保存</button>
        <button type="button" @click="dialog?.close()">取消</button>
      </div>
    </form>
  </dialog>

  <dialog ref="ruleDialog" aria-labelledby="rule-title" @close="ruleDraft = null">
    <form v-if="ruleDraft" class="fields" @submit.prevent="saveRule">
      <h2 id="rule-title">编辑规则</h2>
      <label for="rule-type">类型</label>
      <select id="rule-type" v-model="ruleDraft.type">
        <option v-for="t in RULE_TYPES" :key="t" :value="t">{{ t }}</option>
      </select>
      <template v-if="ruleDraft.type !== 'MATCH'">
        <label for="rule-payload">匹配内容</label>
        <input id="rule-payload" v-model="ruleDraft.payload" class="mono" spellcheck="false" required />
      </template>
      <label for="rule-to">目标</label>
      <select id="rule-to" v-model="ruleDraft.target">
        <option v-if="!targets.includes(ruleDraft.target)" :value="ruleDraft.target">{{ ruleDraft.target }}（不可用）</option>
        <option v-for="t in targets" :key="t" :value="t">{{ t }}</option>
      </select>
      <div v-if="ruleDraft.type !== 'MATCH'" class="row">
        <label v-for="o in RULE_OPTIONS" :key="o" class="inline"><input v-model="ruleDraft.options" type="checkbox" :value="o" />{{ o }}</label>
        <span class="muted">参数只对 IP 类规则有效</span>
      </div>
      <p v-if="ruleEditError" class="alert error" role="alert">{{ ruleEditError }}</p>
      <div class="row">
        <button type="submit" class="primary">保存</button>
        <button type="button" @click="ruleDialog?.close()">取消</button>
      </div>
    </form>
  </dialog>
</template>
