/*
 * 扩展禁用名单状态持久化测试：验证 extensions.json 损坏时备份告警、不静默吞错。
 *
 * 运行方式：
 *   cd server && bun test tests/extension-state.test.js
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Admin from '../commands/admin.js'
import Extension from '../features/extension.js'
import Path from '../utils/path.js'

const homes = []
const withHome = async callback => {
    const root = join(tmpdir(), `agent-ext-state-${crypto.randomUUID()}`)
    await mkdir(root, { recursive: true })
    homes.push(root)
    const previousHome = process.env.AGENT_HOME
    process.env.AGENT_HOME = root
    Path.lock(root)
    try {
        return await callback(root)
    } finally {
        Path.unlock()
        if (previousHome === undefined) delete process.env.AGENT_HOME
        else process.env.AGENT_HOME = previousHome
    }
}

afterEach(async () => {
    await Promise.all(homes.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('扩展禁用名单持久化', () => {
    test('extensions.json 损坏时备份坏档并打 stderr 告警，且后续 toggle 可正常写入有效 JSON', () => withHome(async root => {
        const statePath = join(root, 'extensions.json')
        await writeFile(statePath, '{broken json')

        const errors = []
        const originalError = console.error
        console.error = (...args) => errors.push(args.join(' '))
        try {
            const state = await Extension.load(Admin.OPS)
            expect(state.loaded.sort()).toEqual(['monitor', 'skill', 'todo'])
        } finally {
            console.error = originalError
        }

        // 坏档被保留为 .broken-*，且 stderr 输出明确告警
        expect(errors.some(line => line.includes('禁用名单文件损坏'))).toBe(true)
        const broken = await Array.fromAsync(new Bun.Glob('extensions.json.broken-*').scan({ cwd: root }))
        expect(broken).toHaveLength(1)

        // toggle 原子写回有效 JSON，并在末尾停用扩展避免污染同进程后续测试
        try {
            await Extension.toggle({ name: 'todo', enabled: false })
            const persisted = JSON.parse(await Bun.file(statePath).text())
            expect(persisted).toEqual({ disabled: ['todo'] })
        } finally {
            await Extension.toggle({ name: 'todo', enabled: false }).catch(() => {})
            await Extension.toggle({ name: 'monitor', enabled: false }).catch(() => {})
            await Extension.toggle({ name: 'skill', enabled: false }).catch(() => {})
        }
    }))
})
