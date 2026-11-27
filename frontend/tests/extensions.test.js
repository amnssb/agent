/*
 * 前端扩展生命周期测试：验证 app.onDispose 注册的清理回调在停用或重载时逆序执行，
 * 且单个清理异常不影响其它清理回调和注册项回收。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Extensions } from '../src/features/extensions.js'
import { AgentAPI } from '../src/utils/api.js'

test('frontend extension onDispose runs in reverse order on unload and isolates failures', async t => {
  const order = []
  globalThis.__extTestLog = order

  t.mock.method(AgentAPI, 'getExtensionFrontend', async () => ({
    code: `
      export default function setup(app) {
        app.onDispose(() => globalThis.__extTestLog.push('first'))
        app.onDispose(() => { throw new Error('boom') })
        app.onDispose(() => globalThis.__extTestLog.push('third'))
      }
    `,
  }))
  const errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')))

  try {
    t.mock.method(AgentAPI, 'getExtensions', async () => ({
      loaded: ['demo'],
      changed: [],
      extensions: [{ name: 'demo', running: true, hasFrontend: true }],
    }))
    await Extensions.refresh()
    assert.deepEqual(order, [])

    t.mock.method(AgentAPI, 'getExtensions', async () => ({
      loaded: [],
      changed: [],
      extensions: [{ name: 'demo', running: false, hasFrontend: true }],
    }))
    await Extensions.refresh()
    assert.deepEqual(order, ['third', 'first'])
    assert.ok(errors.some(line => line.includes('demo 前端收尾失败')))
  } finally {
    delete globalThis.__extTestLog
  }
})
