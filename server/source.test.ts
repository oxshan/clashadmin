import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isPrivateAddress, loadSource } from './source'

let server: http.Server
let base: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/redirect') return res.writeHead(302, { Location: '/sub' }).end()
    if (req.url === '/loop') return res.writeHead(302, { Location: '/loop' }).end()
    if (req.url === '/big') return res.end(Buffer.alloc(11 * 1024 * 1024, 'a'))
    if (req.url === '/missing') return res.writeHead(404).end()
    res.end('proxies: []')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => server.close())

describe('isPrivateAddress', () => {
  it('flags loopback, private, link-local and reserved ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.84', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', 'ff02::1', 'not-an-ip'])
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true])
  })

  it('allows public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '203.0.113.10', '198.18.0.5', '2606:4700:4700::1111'])
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, false])
  })
})

describe('loadSource over http', () => {
  it('refuses loopback and private targets in every spelling', async () => {
    const port = new URL(base).port
    const targets = [
      `${base}/sub`,
      `http://localhost:${port}/sub`,
      `http://2130706433:${port}/sub`,
      `http://0x7f.0.0.1:${port}/sub`,
      `http://127.1:${port}/sub`,
      `http://[::1]:${port}/sub`,
      `http://[::ffff:127.0.0.1]:${port}/sub`,
      'http://192.168.1.1/sub',
      'http://10.0.0.1/sub',
      'http://169.254.169.254/latest/meta-data/',
    ]
    for (const target of targets) await expect(loadSource(target, false), target).rejects.toThrow('内网')
  })

  it('downloads, follows redirects and enforces limits when private targets are allowed', async () => {
    expect(await loadSource(`${base}/sub`, true)).toBe('proxies: []')
    expect(await loadSource(`${base}/redirect`, true)).toBe('proxies: []')
    await expect(loadSource(`${base}/loop`, true)).rejects.toThrow('重定向')
    await expect(loadSource(`${base}/big`, true)).rejects.toThrow('过大')
    await expect(loadSource(`${base}/missing`, true)).rejects.toThrow('404')
  })

  it('rejects other schemes and non-yaml paths', async () => {
    await expect(loadSource('ftp://example.com/a.yaml')).rejects.toThrow()
    await expect(loadSource('/etc/passwd')).rejects.toThrow('yaml')
    await expect(loadSource('')).rejects.toThrow('请填写')
  })
})
