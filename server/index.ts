import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './app'
import { MIN_PASSWORD, createAuth } from './auth'
import { load, loadAuth, save, saveAuth } from './store'

if (existsSync('.env')) process.loadEnvFile('.env')

const password = process.env.ADMIN_PASSWORD ?? ''
if (password.length < MIN_PASSWORD) {
  console.error(`[clashadmin] 请先配置后台密码：设置环境变量 ADMIN_PASSWORD（至少 ${MIN_PASSWORD} 位），或写入项目根目录的 .env 文件后再启动。`)
  process.exit(1)
}

const port = Number(process.env.PORT ?? 8787)
const hostname = process.env.HOST ?? '0.0.0.0'

let publicUrl = (process.env.PUBLIC_URL ?? '').trim()
if (publicUrl) {
  const url = URL.canParse(publicUrl) ? new URL(publicUrl) : null
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    console.error(`[clashadmin] PUBLIC_URL 无效：${publicUrl}（应形如 https://sub.example.com）`)
    process.exit(1)
  }
  publicUrl = url.origin
}

const lanOrigins = () =>
  process.env.IN_DOCKER || ['127.0.0.1', '::1', 'localhost'].includes(hostname)
    ? []
    : Object.values(networkInterfaces())
        .flat()
        .filter((i) => i && i.family === 'IPv4' && !i.internal && !/^198\.1[89]\./.test(i.address))
        .map((i) => `http://${i!.address}:${port}`)

const app = createApp(load(), save, createAuth(loadAuth(password), saveAuth), lanOrigins, publicUrl)
if (existsSync('dist')) app.use('*', serveStatic({ root: './dist' }))

serve({ fetch: app.fetch, port, hostname }, () => console.log(`clashadmin server: http://${hostname}:${port}`))
