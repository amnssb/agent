/*
 * 上下文检查器测试：context.inspect 的形状与来源标注。
 *
 * 断言策略：只验形状与来源标注，不锁 token 数（token 估算随模型配置变化）。
 *
 * 场景覆盖：
 *   1. 空会话（无消息）
 *   2. 带消息的会话（messages 统计正确）
 *   3. estimate vs actual 并排（actual 为 null 时结构仍正确）
 *   4. 缺 sessionId 返回 400
 *   5. 不存在的 sessionId 返回 404
 *
 * 运行方式：
 *   cd server && bun test tests/context-inspect.test.js
 */

import { describe, test, expect } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Path from '../utils/path.js'
import History from '../features/history.js'
import ContextUsage from '../utils/context-usage.js'
import ContextInspect from '../utils/context-inspect.js'
import store from '../store.js'

const withHome = async callback => {
    const root = join(tmpdir(), `ctx-inspect-${crypto.randomUUID()}`)
    const prev = process.env.AGENT_HOME
    process.env.AGENT_HOME = root
    Path.lock(root)
    await mkdir(root, { recursive: true })
    // 给一个最小的 config，否则 Agent.resolve 会找不到 provider 而抛出
    Object.assign(store.config, {
        providers: [{ name: 'test-provider', enabled: true, models: [{ id: 'test-model', context: 8000 }] }],
        compact: { threshold: 0.8 },
        contextKeep: { firstTurns: 3, recentTurns: 3, firstShare: 0.2, recentShare: 0.3 },
        permission: {},
        prompt: { system: '' },
    })
    try {
        return await callback(root)
    } finally {
        Path.unlock()
        if (prev === undefined) delete process.env.AGENT_HOME
        else process.env.AGENT_HOME = prev
        await rm(root, { recursive: true, force: true })
    }
}

// 创建会话并追加消息，返回 sessionId
const makeSession = async (messages = []) => {
    const session = await History.create({
        title: '测试会话',
        provider: 'test-provider',
        model: 'test-model',
    })
    for (const msg of messages) {
        await History.add({ sessionId: session.id, message: msg })
    }
    return session.id
}

describe('context.inspect', () => {
    test('缺 sessionId 返回 400', async () => {
        await expect(ContextInspect.inspect({})).rejects.toMatchObject({ status: 400 })
    })

    test('不存在的 sessionId 返回 404', async () => {
        await withHome(async () => {
            await expect(ContextInspect.inspect({ sessionId: 'no-such-xyz' })).rejects.toMatchObject({ status: 404 })
        })
    })

    test('空会话 — 返回结构完整，messages.total 为 0', async () => {
        await withHome(async () => {
            const sessionId = await makeSession()

            const result = await ContextInspect.inspect({ sessionId })

            // 顶层形状
            expect(result).toHaveProperty('sessionId', sessionId)
            expect(result).toHaveProperty('system')
            expect(result).toHaveProperty('tools')
            expect(result).toHaveProperty('messages')
            expect(result).toHaveProperty('estimate')
            expect(result).toHaveProperty('actual')
            expect(result).toHaveProperty('keep')

            // system 来源标注
            expect(result.system).toHaveProperty('text')
            expect(result.system).toHaveProperty('length')
            expect(Array.isArray(result.system.segments)).toBe(true)
            // 至少有 compact-guide 段（COMPACT_GUIDE 总是在 system 里）
            expect(result.system.segments.some(s => s.kind === 'compact-guide')).toBe(true)

            // tools 是数组
            expect(Array.isArray(result.tools)).toBe(true)

            // messages 统计
            expect(result.messages.total).toBe(0)
            expect(result.messages.shown).toBe(0)
            expect(Array.isArray(result.messages.items)).toBe(true)

            // estimate 结构
            expect(typeof result.estimate.tokens).toBe('number')
            expect(typeof result.estimate.budget).toBe('number')
            expect(result.estimate.budget).toBeGreaterThan(0)
            expect(result.estimate.compactAt).toBe(
                Math.round(result.estimate.budget * result.estimate.compactThreshold)
            )

            // actual 为 null（没跑过任何轮）
            expect(result.actual).toBeNull()

            // keep 结构
            expect(result.keep).toHaveProperty('firstTurns')
            expect(result.keep).toHaveProperty('recentTurns')
        })
    })

    test('带消息 — messages 统计含正确角色', async () => {
        await withHome(async () => {
            const sessionId = await makeSession([
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'world' },
            ])

            const result = await ContextInspect.inspect({ sessionId })

            expect(result.messages.total).toBe(2)
            expect(result.messages.shown).toBe(2)
            const roles = result.messages.items.map(item => item.role)
            expect(roles).toContain('user')
            expect(roles).toContain('assistant')
            result.messages.items.forEach(item => {
                expect(item.bytes).toBeGreaterThan(0)
                expect(typeof item.compact).toBe('boolean')
            })
        })
    })

    test('actual 有数据时 — estimate vs actual 并排', async () => {
        await withHome(async () => {
            const sessionId = await makeSession([{ role: 'user', content: '实测测试' }])
            // 模拟一次 onInject 回调
            ContextUsage.record(sessionId, { tokens: 1000, budget: 10000, compactThreshold: 0.8 })

            const result = await ContextInspect.inspect({ sessionId })

            expect(result.actual).not.toBeNull()
            expect(result.actual.tokens).toBe(1000)
            expect(result.actual.budget).toBe(10000)
            expect(typeof result.actual.compactAt).toBe('number')
            expect(typeof result.actual.percentOfBudget).toBe('number')
        })
    })

    test('system 分段：段数 >= 1，每段都有 kind/chars/lineStart/lineEnd', async () => {
        await withHome(async () => {
            const sessionId = await makeSession()

            const result = await ContextInspect.inspect({ sessionId })
            expect(result.system.segments.length).toBeGreaterThan(0)
            result.system.segments.forEach(seg => {
                expect(['prompt', 'rules', 'compact-guide']).toContain(seg.kind)
                expect(typeof seg.chars).toBe('number')
                expect(typeof seg.lineStart).toBe('number')
                expect(typeof seg.lineEnd).toBe('number')
            })
        })
    })
})
