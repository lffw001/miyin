import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    /**
     * 并发与超时都是为了让失败只反映真实缺陷，而不是机器抖动。
     *
     * 本机是 8 核，但**经常被其它项目占到 load 90+**（实测 cwd 在别的仓库的 node 进程有 20+ 个）。
     * 那种情况下 60 个测试文件全并发会互相抢资源：同一个用例空载 0.7s，满载能跑到 16s+，
     * 表现为偶发的 `STACK_TRACE_ERROR`（复现率约 1/6，单独跑该文件则 100% 通过）。
     *
     * 所以：**限制 fork 数量**（别把机器打满）+ 放宽单用例超时（留足余量）。
     */
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 20000,
    hookTimeout: 20000,
    env: {
      MIYIN_SOURCE_CALL_TIMEOUT_MS: '800',
      MIYIN_SOURCE_LOAD_TIMEOUT_MS: '500',
    },
  },
  resolve: {
    alias: {
      '#server': fileURLToPath(new URL('./server', import.meta.url)),
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
})
