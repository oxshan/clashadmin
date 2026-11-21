import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

const server = { target: `http://127.0.0.1:${process.env.PORT ?? 8787}`, changeOrigin: false }

export default defineConfig({
  plugins: [vue()],
  server: { host: '127.0.0.1', proxy: { '/api': server, '/sub': server } },
  test: { include: ['shared/**/*.test.ts', 'server/**/*.test.ts'] },
})
