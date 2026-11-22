import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { parseLines, parseUri } from './parse'
import { chainError, renderClash, renderShadowrocket } from './render'
import type { NodeRecord } from './types'
import { parseClashYaml, parseProxyYaml, toUri } from './yaml'

const VLESS =
  'vless://11111111-2222-4333-8444-555555555555@203.0.113.10:50000?encryption=none&flow=xtls-rprx-vision&security=reality&sni=apple.com&fp=chrome&pbk=SHZKjRNmvjKtcyhCn2ORavwLnTNuT-ZqcnoRis0GyI8&sid=0123abcd&type=tcp&headerType=none#vl-reality-vision-demo'
const HY2 =
  'hysteria2://11111111-2222-4333-8444-555555555555@203.0.113.10:50002?security=tls&alpn=h3&insecure=0&allowInsecure=0&sni=www.bing.com&pinSHA256=0f797d615d96200c9f32529566001e789caa3651a61842eff2bf6342b8b362ba#hy2-demo'
const TUIC =
  'tuic://11111111-2222-4333-8444-555555555555:11111111-2222-4333-8444-555555555555@203.0.113.10:50001?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=www.bing.com&insecure=1&allowInsecure=1&allow_insecure=1#tuic-demo'

const records = (): NodeRecord[] =>
  parseLines([VLESS, HY2, TUIC].join('\n')).nodes.map((n, i) => ({ ...n, id: `n${i}`, enabled: true, dialerId: null, keepDirect: false }))

describe('parseUri', () => {
  it('parses vless reality', () => {
    expect(parseUri(VLESS).proxy).toEqual({
      name: 'vl-reality-vision-demo',
      type: 'vless',
      server: '203.0.113.10',
      port: 50000,
      uuid: '11111111-2222-4333-8444-555555555555',
      network: 'tcp',
      udp: true,
      tls: true,
      flow: 'xtls-rprx-vision',
      servername: 'apple.com',
      'client-fingerprint': 'chrome',
      'reality-opts': { 'public-key': 'SHZKjRNmvjKtcyhCn2ORavwLnTNuT-ZqcnoRis0GyI8', 'short-id': '0123abcd' },
    })
  })

  it('parses hysteria2', () => {
    expect(parseUri(HY2).proxy).toEqual({
      name: 'hy2-demo',
      type: 'hysteria2',
      server: '203.0.113.10',
      port: 50002,
      password: '11111111-2222-4333-8444-555555555555',
      sni: 'www.bing.com',
      alpn: ['h3'],
      fingerprint: '0f797d615d96200c9f32529566001e789caa3651a61842eff2bf6342b8b362ba',
    })
  })

  it('parses tuic', () => {
    expect(parseUri(TUIC).proxy).toEqual({
      name: 'tuic-demo',
      type: 'tuic',
      server: '203.0.113.10',
      port: 50001,
      uuid: '11111111-2222-4333-8444-555555555555',
      password: '11111111-2222-4333-8444-555555555555',
      sni: 'www.bing.com',
      alpn: ['h3'],
      'skip-cert-verify': true,
      'congestion-controller': 'bbr',
      'udp-relay-mode': 'native',
    })
  })

  it('parses socks5 with plain, base64 and no credentials', () => {
    expect(parseUri('socks5://user:p%40ss@1.2.3.4:1080#s5').proxy).toEqual({
      name: 's5',
      type: 'socks5',
      server: '1.2.3.4',
      port: 1080,
      username: 'user',
      password: 'p@ss',
      udp: true,
    })
    expect(parseUri(`socks://${btoa('user:pass')}@1.2.3.4:1080#b64`).proxy).toMatchObject({ username: 'user', password: 'pass' })
    expect(parseUri('socks5://1.2.3.4:1080').proxy).toEqual({ name: 'socks5-1.2.3.4:1080', type: 'socks5', server: '1.2.3.4', port: 1080, udp: true })
    expect(parseUri('socks5://admin@1.2.3.4:1080#u').proxy).toMatchObject({ username: 'admin' })
    expect(() => parseUri('socks5://1.2.3.4')).toThrow('端口')
  })

  it('handles ipv6 hosts and encoded names', () => {
    const node = parseUri('hy2://pw@[2001:db8::1]:443?sni=a.com#%E9%A6%99%E6%B8%AF')
    expect(node.server).toBe('2001:db8::1')
    expect(node.name).toBe('香港')
  })
})

describe('parseLines', () => {
  const other = { name: 'hy2-demo', proxy: parseUri('hy2://x@9.9.9.9:1#hy2-demo').proxy }

  it('reports bad lines and suffixes clashing names', () => {
    const { nodes, errors } = parseLines([HY2, '', 'ss://abc@1.1.1.1:1#x', 'garbage'].join('\n'), [other])
    expect(nodes.map((n) => n.name)).toEqual(['hy2-demo-2'])
    expect(nodes[0].proxy.name).toBe('hy2-demo-2')
    expect(errors.map((e) => e.line)).toEqual([3, 4])
  })

  it('skips nodes that already exist or repeat within the input', () => {
    const existing = parseLines(VLESS).nodes
    const { nodes, errors } = parseLines([VLESS.replace('#vl-reality-vision-demo', '#renamed'), HY2, HY2].join('\n'), existing)
    expect(nodes.map((n) => n.name)).toEqual(['hy2-demo'])
    expect(errors.map((e) => [e.line, e.duplicate])).toEqual([[1, true], [3, true]])
  })
})

describe('chains', () => {
  it('detects cycles and missing dialers', () => {
    const nodes = records()
    nodes[0].dialerId = 'n1'
    expect(chainError(nodes, 'n1', 'n0')).toMatch('环路')
    expect(chainError(nodes, 'n1', 'n1')).toMatch('环路')
    expect(chainError(nodes, 'n1', 'nope')).toMatch('不存在')
    expect(chainError(nodes, 'n1', 'n2')).toBeNull()
  })

  it('renders dialer-proxy in place', () => {
    const nodes = records()
    nodes[0].dialerId = 'n1'
    const { yaml, warnings } = renderClash(nodes)
    const config = parse(yaml)
    expect(warnings).toEqual([])
    expect(config.proxies).toHaveLength(3)
    expect(config.proxies[0]['dialer-proxy']).toBe('hy2-demo')
    expect(config['proxy-groups']).toEqual([
      { name: 'proxy', type: 'select', proxies: ['vl-reality-vision-demo', 'hy2-demo', 'tuic-demo', 'DIRECT'] },
    ])
    expect(config.rules).toEqual([
      'GEOSITE,private,DIRECT',
      'GEOIP,LAN,DIRECT,no-resolve',
      'GEOSITE,cn,DIRECT',
      'GEOSITE,geolocation-!cn,proxy',
      'GEOIP,CN,DIRECT,no-resolve',
      'MATCH,proxy',
    ])
    expect(config.dns['enhanced-mode']).toBe('fake-ip')
  })

  it('keeps the direct node alongside the chained copy', () => {
    const nodes = records()
    Object.assign(nodes[0], { dialerId: 'n1', keepDirect: true })
    const { proxies } = parse(renderClash(nodes).yaml)
    expect(proxies.map((p: { name: string }) => p.name)).toEqual([
      'vl-reality-vision-demo',
      'vl-reality-vision-demo ⟵ hy2-demo',
      'hy2-demo',
      'tuic-demo',
    ])
    expect(proxies[0]['dialer-proxy']).toBeUndefined()
    expect(proxies[1]['dialer-proxy']).toBe('hy2-demo')
  })

  it('drops a chained node instead of silently going direct when its dialer is disabled', () => {
    const nodes = records()
    nodes[0].dialerId = 'n1'
    nodes[1].enabled = false
    const { yaml, warnings } = renderClash(nodes)
    expect(parse(yaml).proxies.map((p: { name: string }) => p.name)).toEqual(['tuic-demo'])
    expect(warnings).toHaveLength(1)
  })

  it('warns when a udp-based node is chained', () => {
    const nodes = records()
    nodes[2].dialerId = 'n0'
    expect(renderClash(nodes).warnings[0]).toMatch('UDP')
  })
})

describe('output consistency', () => {
  it('never references a dialer that is missing from the output', () => {
    const nodes = records()
    nodes[0].dialerId = 'n1'
    nodes[1].dialerId = 'n2'
    nodes[2].enabled = false
    const { yaml, warnings } = renderClash(nodes)
    const { proxies } = parse(yaml)
    expect(proxies).toEqual([])
    expect(warnings).toHaveLength(2)

    nodes[1].keepDirect = true
    const names = parse(renderClash(nodes).yaml).proxies.map((p: { name: string; 'dialer-proxy'?: string }) => [p.name, p['dialer-proxy']])
    expect(names).toEqual([
      ['vl-reality-vision-demo', 'hy2-demo'],
      ['hy2-demo', undefined],
    ])
  })

  it('keeps node names clear of the proxy group and built-in policies', () => {
    const { nodes } = parseLines('socks5://1.1.1.1:1#proxy\nsocks5://1.1.1.2:1#DIRECT')
    expect(nodes.map((n) => n.name)).toEqual(['proxy-2', 'DIRECT-2'])
    expect(parseClashYaml('proxies: [{name: proxy, type: socks5, server: 1.1.1.3, port: 1}]').nodes[0].name).toBe('proxy-2')
  })
})

describe('renderShadowrocket', () => {
  it('outputs enabled uris with current names', () => {
    const nodes = records()
    nodes[0].name = '改名 1'
    nodes[2].enabled = false
    const lines = renderShadowrocket(nodes).text.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(`${VLESS.split('#')[0]}#${encodeURIComponent('改名 1')}`)
    expect(lines[1]).toBe(HY2)
  })

  it('adds the dialer as a chain parameter', () => {
    const nodes = records()
    nodes[0].dialerId = 'n1'
    const out = renderShadowrocket(nodes)
    expect(out.warnings).toEqual([])
    expect(out.text.split('\n')).toEqual([`${VLESS.split('#')[0]}&chain=hy2-demo#vl-reality-vision-demo`, HY2, TUIC])

    Object.assign(nodes[0], { keepDirect: true })
    nodes[1].name = '前置 1'
    const lines = renderShadowrocket(nodes).text.split('\n')
    expect(lines[0]).toBe(VLESS)
    expect(lines[1]).toBe(`${VLESS.split('#')[0]}&chain=${encodeURIComponent('前置 1')}#${encodeURIComponent('vl-reality-vision-demo ⟵ 前置 1')}`)
  })

  it('appends the chain parameter to vmess links', () => {
    const { nodes } = parseClashYaml('proxies: [{name: v, type: vmess, server: a.com, port: 1, uuid: u}, {name: s, type: socks5, server: b.com, port: 2}]')
    const recs = nodes.map((n, i) => ({ ...n, id: `y${i}`, enabled: true, dialerId: i ? null : 'y1', keepDirect: false }))
    const [vm] = renderShadowrocket(recs).text.split('\n')
    expect(vm).toMatch(/^vmess:\/\/[A-Za-z0-9+/=]+\?chain=s$/)
    expect(JSON.parse(Buffer.from(vm.slice(8).split('?')[0], 'base64').toString()).ps).toBe('v')
  })

  it('drops chained nodes that shadowrocket cannot chain instead of going direct', () => {
    const nodes = records()
    nodes[2].dialerId = 'n0'
    const udp = renderShadowrocket(nodes)
    expect(udp.text.split('\n')).toEqual([VLESS, HY2])
    expect(udp.warnings).toHaveLength(1)
    expect(udp.warnings[0]).toMatch('tuic-demo')

    nodes[2].dialerId = null
    nodes[0].dialerId = 'n1'
    nodes[1].dialerId = 'n2'
    const nested = renderShadowrocket(nodes)
    expect(nested.text).toBe(TUIC)
    expect(nested.warnings).toHaveLength(2)

    nodes[1].dialerId = null
    nodes[1].enabled = false
    const disabled = renderShadowrocket(nodes)
    expect(disabled.text).toBe(TUIC)
    expect(disabled.warnings).toEqual(renderClash(nodes).warnings)
  })
})

describe('clash yaml import', () => {
  const SOCKS = 'socks5://user:p%40ss@1.2.3.4:1080#s5'

  it('round-trips every supported type through toUri', () => {
    for (const uri of [VLESS, HY2, TUIC, SOCKS, 'vless://u@[2001:db8::1]:443?security=tls&sni=a.com&type=ws&path=%2Fws&host=h.com&alpn=h2,http/1.1#v6']) {
      const proxy = parseUri(uri).proxy
      expect(parseUri(toUri(proxy)).proxy).toEqual(proxy)
    }
  })

  it('imports proxies, keeps unknown fields, extracts dialer-proxy and reports bad entries', () => {
    const yaml = `
port: 7890
proxies:
  - {name: hy, type: hysteria2, server: 1.1.1.1, port: 443, password: pw, sni: a.com, fast-open: true}
  - {name: s5, type: socks5, server: 2.2.2.2, port: 1080, username: u, password: p, dialer-proxy: hy}
  - {name: ss1, type: ss, server: 3.3.3.3, port: 8388, cipher: aes-128-gcm, password: x}
  - {name: broken, type: vless, server: 4.4.4.4}
  - {type: vless, server: 4.4.4.4, port: 1}
  - {name: hy-again, type: hysteria2, server: 1.1.1.1, port: 443, password: pw}
`
    const existing = [
      { name: 'hy', proxy: parseUri('hy2://other@8.8.8.8:1#hy').proxy },
      { name: 'old-s5', proxy: parseUri('socks5://u:p@2.2.2.2:1080#old-s5').proxy },
    ]
    const { nodes, errors } = parseClashYaml(yaml, existing)
    expect(nodes.map((n) => [n.name, n.sourceName, n.dialerName, n.duplicateOf, n.index])).toEqual([
      ['hy-2', 'hy', null, null, 0],
      ['s5', 's5', 'hy', 'old-s5', 1],
      ['ss1', 'ss1', null, null, 2],
    ])
    expect(nodes[0].proxy).toMatchObject({ name: 'hy-2', 'fast-open': true })
    expect(nodes[0].uri).toBe('hysteria2://pw@1.1.1.1:443?sni=a.com#hy-2')
    expect(nodes[1].proxy).not.toHaveProperty('dialer-proxy')
    expect(nodes[1].uri).toBe('socks5://u:p@2.2.2.2:1080#s5')
    expect(nodes[2].uri).toBe(`ss://${btoa('aes-128-gcm:x').replace(/=+$/, '')}@3.3.3.3:8388#ss1`)
    expect(errors.map((e) => e.text)).toEqual(['broken', '#5', 'hy-again'])
  })

  it('rejects files without proxies', () => {
    expect(() => parseClashYaml('rules: []')).toThrow('proxies')
    expect(() => parseClashYaml('a: [')).toThrow('YAML')
  })

  it('warns about nodes that cannot go into the shadowrocket subscription', () => {
    const { nodes } = parseClashYaml('proxies: [{name: wg1, type: wireguard, server: 3.3.3.3, port: 8388}]')
    const out = renderShadowrocket(nodes.map((n, i) => ({ ...n, id: `y${i}`, enabled: true, dialerId: null, keepDirect: false })))
    expect(out.text).toBe('')
    expect(out.warnings[0]).toMatch('wg1')
  })

  it('generates ss, trojan and vmess links', () => {
    const base = { server: 'a.com', port: 443 }
    expect(toUri({ ...base, name: 'o', type: 'ss', cipher: 'aes-256-gcm', password: 'p/w', plugin: 'obfs', 'plugin-opts': { mode: 'http', host: 'b.com' } })).toBe(
      `ss://${btoa('aes-256-gcm:p/w').replace(/=+$/, '')}@a.com:443?plugin=${encodeURIComponent('obfs-local;obfs=http;obfs-host=b.com')}#o`,
    )
    expect(toUri({ ...base, name: 'x', type: 'ss', cipher: 'aes-256-gcm', password: 'p', plugin: 'shadow-tls' })).toBe('')
    expect(
      toUri({ ...base, name: 't 1', type: 'trojan', password: 'p@ss', sni: 's.com', 'skip-cert-verify': true, network: 'ws', 'ws-opts': { path: '/w', headers: { Host: 'h.com' } } }),
    ).toBe('trojan://p%40ss@a.com:443?security=tls&sni=s.com&allowInsecure=1&type=ws&path=%2Fw&host=h.com#t%201')
    const vmess = toUri({ ...base, name: '香港', type: 'vmess', uuid: 'u-1', alterId: 0, cipher: 'auto', tls: true, servername: 's.com', network: 'ws', 'ws-opts': { path: '/v', headers: { Host: 'h.com' } } })
    expect(JSON.parse(Buffer.from(vmess.replace('vmess://', ''), 'base64').toString())).toEqual({
      v: '2', ps: '香港', add: 'a.com', port: '443', id: 'u-1', aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'h.com', path: '/v', tls: 'tls', sni: 's.com', alpn: '', fp: '',
    })
  })

  it('puts the current name into vmess links and regenerates links for old records', () => {
    const { nodes } = parseClashYaml('proxies: [{name: v, type: vmess, server: a.com, port: 1, uuid: u}, {name: s, type: ss, server: b.com, port: 2, cipher: c, password: p}]')
    const recs = nodes.map((n, i) => ({ ...n, id: `y${i}`, enabled: true, dialerId: null, keepDirect: false }))
    recs[0].name = 'renamed'
    recs[1].uri = ''
    const [vm, ss] = renderShadowrocket(recs).text.split('\n')
    expect(JSON.parse(Buffer.from(vm.replace('vmess://', ''), 'base64').toString()).ps).toBe('renamed')
    expect(ss).toMatch(/^ss:\/\/.+@b\.com:2#s$/)
  })

  it('validates a single edited proxy', () => {
    expect(parseProxyYaml('{name: a, type: socks5, server: 1.1.1.1, port: 1080}')).toMatchObject({ name: 'a', port: 1080 })
    expect(() => parseProxyYaml('- a')).toThrow('字段映射')
    expect(() => parseProxyYaml('{name: a, type: socks5, server: 1.1.1.1, port: 0}')).toThrow('端口')
    expect(() => parseProxyYaml('{name: a, type: socks5, server: 1.1.1.1, port: 1, dialer-proxy: b}')).toThrow('前置')
  })
})
