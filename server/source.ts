import { type LookupAddress, lookup } from 'node:dns'
import { readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { BlockList, type LookupFunction, isIP } from 'node:net'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const MAX_BYTES = 10 * 1024 * 1024
const MAX_REDIRECTS = 5
const TIMEOUT = 15000
const BLOCKED = '不允许访问本机或内网地址'

const privateNets = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  privateNets.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 127],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  privateNets.addSubnet(net, prefix, 'ipv6')

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  return !family || privateNets.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

const guardedLookup: LookupFunction = (hostname, options, callback) =>
  lookup(hostname, { ...options, all: true }, (err, result) => {
    const addresses = result as LookupAddress[]
    if (err) return callback(err, '')
    if (addresses.some((a) => isPrivateAddress(a.address))) return callback(new Error(BLOCKED), '')
    if (options.all) callback(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
  })

function get(url: URL, allowPrivate: boolean, signal: AbortSignal): Promise<{ status: number; location?: string; body: string }> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!allowPrivate && isIP(host) && isPrivateAddress(host)) return Promise.reject(new Error(BLOCKED))
  return new Promise((done, fail) => {
    const req = (url.protocol === 'https:' ? https : http).get(
      url,
      { headers: { 'User-Agent': 'clash.meta' }, signal, lookup: allowPrivate ? undefined : guardedLookup },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BYTES) return req.destroy(new Error('文件过大'))
          chunks.push(chunk)
        })
        res.on('end', () => done({ status: res.statusCode ?? 0, location: res.headers.location, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', fail)
      },
    )
    req.on('error', fail)
  })
}

async function download(src: string, allowPrivate: boolean): Promise<string> {
  const signal = AbortSignal.timeout(TIMEOUT)
  let url = new URL(src)
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 http(s) 链接')
      const res = await get(url, allowPrivate, signal)
      if ([301, 302, 303, 307, 308].includes(res.status) && res.location) {
        url = new URL(res.location, url)
        continue
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
      return res.body
    }
    throw new Error('重定向次数过多')
  } catch (e) {
    const err = e as Error
    throw new Error(`下载失败: ${err.name === 'TimeoutError' || err.name === 'AbortError' ? '超时' : err.message}`)
  }
}

export async function loadSource(source: string, allowPrivate = process.env.IMPORT_ALLOW_PRIVATE === '1'): Promise<string> {
  const src = source.trim()
  if (!src) throw new Error('请填写文件路径或 URL')
  if (/^https?:\/\//i.test(src)) {
    if (!URL.canParse(src)) throw new Error('链接格式错误')
    return download(src, allowPrivate)
  }
  const path = resolve(src.replace(/^file:\/\//, '').replace(/^~(?=\/|$)/, homedir()))
  if (!/\.ya?ml$/i.test(path)) throw new Error('只支持 .yaml / .yml 文件')
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new Error('文件不存在')
  if (info.size > MAX_BYTES) throw new Error('文件过大')
  return readFile(path, 'utf8')
}
