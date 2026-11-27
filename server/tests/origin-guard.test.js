/*
 * 同源守卫测试：验证 CSRF 防护覆盖 form-urlencoded POST、跨源 JSON POST、Referer、SSE GET，
 * 且不误伤无 Origin/Referer 的命令行请求、同源请求和白名单来源。
 *
 * 运行方式：
 *   cd server && bun test tests/origin-guard.test.js
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { app } from '../server.js'

const previousAllowed = process.env.AGENT_ALLOWED_ORIGINS
afterEach(() => {
    if (previousAllowed === undefined) delete process.env.AGENT_ALLOWED_ORIGINS
    else process.env.AGENT_ALLOWED_ORIGINS = previousAllowed
})

describe('同源守卫', () => {
    test('恶意 Origin 的 form-urlencoded POST 被 403 拦截，不能穿过 body 校验到达指令层', async () => {
        const response = await app.handle(new Request('http://localhost:3000/agent/send/nonexistent', {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                origin: 'https://evil.example',
            },
            body: 'input=csrf-probe',
        }))
        expect(response.status).toBe(403)
    })

    test('恶意 Origin 的 JSON POST 同样被 403 拦截', async () => {
        const response = await app.handle(new Request('http://localhost:3000/admin', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin: 'https://evil.example',
            },
            body: JSON.stringify({ op: 'config.read' }),
        }))
        expect(response.status).toBe(403)
    })

    test('Origin 为 null 或不同端口时被 403 拦截', async () => {
        const nullOrigin = await app.handle(new Request('http://localhost:3000/health', {
            headers: { origin: 'null' },
        }))
        expect(nullOrigin.status).toBe(403)

        const otherPort = await app.handle(new Request('http://localhost:3000/health', {
            headers: { origin: 'http://localhost:5173' },
        }))
        expect(otherPort.status).toBe(403)
    })

    test('缺少 Origin 时按 Referer 判定，跨源 Referer 同样 403', async () => {
        const evilReferer = await app.handle(new Request('http://localhost:3000/sse/connect/nonexistent', {
            headers: { referer: 'https://evil.example/attack.html' },
        }))
        expect(evilReferer.status).toBe(403)
    })

    test('SSE GET 请求带恶意 Origin 被 403 拦截，同源放行到业务层', async () => {
        const blocked = await app.handle(new Request('http://localhost:3000/sse/connect/nonexistent', {
            headers: { origin: 'https://evil.example' },
        }))
        expect(blocked.status).toBe(403)

        const controller = new AbortController()
        const sameOrigin = await app.handle(new Request('http://localhost:3000/sse/connect/nonexistent', {
            headers: { origin: 'http://localhost:3000' },
            signal: controller.signal,
        }))
        expect(sameOrigin.status).toBe(200)
        expect(sameOrigin.headers.get('content-type')).toContain('text/event-stream')
        controller.abort()
        await sameOrigin.body?.cancel().catch(() => {})
    })

    test('同源 JSON POST 通过守卫到达指令层（不存在的会话返回 404）', async () => {
        const response = await app.handle(new Request('http://localhost:3000/agent/send/nonexistent', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin: 'http://localhost:3000',
            },
            body: JSON.stringify({ input: 'hello' }),
        }))
        expect(response.status).toBe(404)
    })

    test('Vite dev 代理场景（Origin 已改写为服务地址但保留页面 Referer）通过守卫', async () => {
        const response = await app.handle(new Request('http://127.0.0.1:3000/health', {
            headers: {
                host: '127.0.0.1:3000',
                origin: 'http://127.0.0.1:3000',
                referer: 'http://localhost:5173/chat',
            },
        }))
        expect(response.status).toBe(200)
    })

    test('无 Origin/Referer 的命令行请求放行', async () => {
        const health = await app.handle(new Request('http://localhost:3000/health'))
        expect(health.status).toBe(200)

        const send = await app.handle(new Request('http://localhost:3000/agent/send/nonexistent', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ input: 'cli' }),
        }))
        expect(send.status).toBe(404)
    })

    test('AGENT_ALLOWED_ORIGINS 白名单支持逗号分隔放行', async () => {
        process.env.AGENT_ALLOWED_ORIGINS = 'http://localhost:5173, https://app.example.com/'
        const allowed = await app.handle(new Request('http://localhost:3000/health', {
            headers: { origin: 'https://app.example.com' },
        }))
        expect(allowed.status).toBe(200)

        const denied = await app.handle(new Request('http://localhost:3000/health', {
            headers: { origin: 'https://other.example.com' },
        }))
        expect(denied.status).toBe(403)
    })
})
