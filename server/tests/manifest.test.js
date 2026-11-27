/*
 * 扩展声明一致性测试：扫描 extensions/<name>/manifest.json，防止 manifest 与入口或 op 声明漂移。
 *
 * 检查项：
 *   1. manifest.json 可解析为 JSON 对象
 *   2. 声明的 backend / frontend 入口文件存在
 *   3. cli.commands[].op 在对应 backend 入口源码里真实注册（文本级核对，不执行）
 *   4. requires 声明的依赖扩展在 extensions/ 下真实存在
 *   5. permissions 为非空字符串数组且与 backend/frontend 入口能力一致（tools / admin-ops / ui）
 *
 * 运行方式：
 *   cd server && bun test tests/manifest.test.js
 */

import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const extensionsDir = fileURLToPath(new URL('../../extensions/', import.meta.url))
const entries = (await readdir(extensionsDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()

const extensionSet = new Set(entries)

describe('扩展 manifest 一致性', () => {
    test('至少存在内置扩展，且全部 manifest 可解析、入口齐全、op 和 requires 一致', async () => {
        expect(entries.length).toBeGreaterThan(0)

        for (const name of entries) {
            const dir = join(extensionsDir, name)
            const manifestFile = Bun.file(join(dir, 'manifest.json'))
            expect(await manifestFile.exists(), `${name} 缺少 manifest.json`).toBe(true)

            // (a) JSON 可解析
            const manifest = await manifestFile.json()
            expect(manifest && typeof manifest === 'object' && !Array.isArray(manifest), `${name}/manifest.json 必须是对象`).toBe(true)

            // (b) backend / frontend 入口存在
            const backendRel = manifest.backend || 'backend.js'
            const backendFile = Bun.file(join(dir, backendRel))
            const hasBackend = await backendFile.exists()
            if (manifest.backend) expect(hasBackend, `${name} 声明的 backend 入口不存在：${backendRel}`).toBe(true)

            if (manifest.frontend) {
                const frontendFile = Bun.file(join(dir, manifest.frontend))
                expect(await frontendFile.exists(), `${name} 声明的 frontend 入口不存在：${manifest.frontend}`).toBe(true)
            }

            // (c) cli.commands[].op 声明的 op 在对应 backend 源码里出现
            const commands = Array.isArray(manifest.cli?.commands) ? manifest.cli.commands : []
            if (commands.some(cmd => cmd?.op)) {
                expect(hasBackend, `${name} 的 cli.commands 声明了 op，但缺少 ${backendRel}`).toBe(true)
                const backendCode = await backendFile.text()
                for (const cmd of commands) {
                    if (!cmd?.op) continue
                    expect(backendCode.includes(cmd.op), `${name}/${backendRel} 未出现声明的 op：${cmd.op}`).toBe(true)
                }
            }

            // (d) requires 指向存在的扩展
            const requires = Array.isArray(manifest.requires) ? manifest.requires : []
            for (const dep of requires) {
                expect(extensionSet.has(dep), `${name} 声明了不存在的依赖扩展：${dep}`).toBe(true)
            }

            // (e) permissions 为非空字符串数组，且内置扩展与实际注册的 tools / admin-ops / ui 一致
            expect(Array.isArray(manifest.permissions) && manifest.permissions.length > 0, `${name}/manifest.json 应声明 permissions`).toBe(true)
            const trimmed = manifest.permissions.map(item => typeof item === 'string' ? item.trim() : '')
            expect(trimmed.every(Boolean), `${name}/manifest.json 的 permissions 不能含空项或非字符串`).toBe(true)
            expect(new Set(trimmed).size, `${name}/manifest.json 的 permissions 不能重复`).toBe(trimmed.length)
            const perms = new Set(trimmed)
            if (manifest.frontend) expect(perms.has('ui'), `${name} 声明了 frontend，permissions 应含 ui`).toBe(true)
            if (hasBackend) {
                const backendCode = await backendFile.text()
                if (backendCode.includes('ctx.op(')) expect(perms.has('admin-ops'), `${name} 注册了 ctx.op，permissions 应含 admin-ops`).toBe(true)
                if (backendCode.includes('Tool.build')) expect(perms.has('tools'), `${name} 注入了工具，permissions 应含 tools`).toBe(true)
            }
        }
    })
})
