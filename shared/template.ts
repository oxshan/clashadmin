export const GROUP = 'proxy'

export const general = {
  port: 7890,
  'allow-lan': true,
  mode: 'rule',
  'log-level': 'info',
  'unified-delay': true,
  profile: { 'store-selected': true, 'store-fake-ip': true },
  dns: {
    enable: true,
    listen: '0.0.0.0:1053',
    ipv6: true,
    'prefer-h3': false,
    'respect-rules': true,
    'use-system-hosts': false,
    'cache-algorithm': 'arc',
    'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    'fake-ip-filter': [
      '+.lan',
      '+.local',
      '+.msftconnecttest.com',
      '+.msftncsi.com',
      'localhost.ptlogin2.qq.com',
      'localhost.sec.qq.com',
      '+.in-addr.arpa',
      '+.ip6.arpa',
      'time.*.com',
      'time.*.gov',
      'pool.ntp.org',
      'localhost.work.weixin.qq.com',
    ],
    'default-nameserver': ['223.5.5.5', '119.29.29.29'],
    'nameserver-policy': { 'geosite:cn': ['https://223.5.5.5/dns-query', 'https://doh.pub/dns-query'] },
    nameserver: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
    'proxy-server-nameserver': ['https://223.5.5.5/dns-query', 'https://doh.pub/dns-query'],
  },
}

export const rules = [
  'GEOSITE,private,DIRECT',
  'GEOIP,LAN,DIRECT,no-resolve',
  'GEOSITE,cn,DIRECT',
  `GEOSITE,geolocation-!cn,${GROUP}`,
  'GEOIP,CN,DIRECT,no-resolve',
  `MATCH,${GROUP}`,
]
