/*
 * 技能扩展功能测试：通过 Extension.load 加载 extensions/skill，验证 HTTP /admin 动作
 * （skill.list / read / save / remove / toggle / source）、技能目录识别、禁启用状态持久化、
 * 技能工具清单与会话装配，以及停用扩展后的干净卸载。
 *
 * 运行方式：
 *   cd server && bun test tests/skill-extension.test.js
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import Path from '../utils/path.js'
import Agent from '../features/agent.js'
import Config from '../features/config.js'
import Extension from '../features/extension.js'
import History from '../features/history.js'
import Tool from '../features/tool.js'
import Admin from '../commands/admin.js'
import Session from '../commands/session.js'
import { getAgent } from './agent-helpers.js'
import store from '../store.js'
import { app } from '../server.js'
import Skills from '../../extensions/skill/skills.js'
import SkillTool from '../../extensions/skill/tool.js'

const admin = (op, params = {}) => app.handle(new Request('http://localhost/admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, ...params }),
}))

const writeSkill = async (directory, name, description, body) => {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`)
}

const withHome = async callback => {
    const root = join(tmpdir(), `agent-skill-ext-${crypto.randomUUID()}`)
    const data = join(root, 'data')
    const discovery = join(root, 'home')
    const project = join(root, 'project')
    const previous = {
        home: process.env.AGENT_HOME,
        discovery: process.env.AGENT_DISCOVERY_HOME,
        xdg: process.env.XDG_CONFIG_HOME,
        appdata: process.env.APPDATA,
    }
    process.env.AGENT_HOME = data
    Path.lock(data)
    process.env.AGENT_DISCOVERY_HOME = discovery
    process.env.XDG_CONFIG_HOME = join(discovery, '.config')
    process.env.APPDATA = join(discovery, 'AppData', 'Roaming')

    await mkdir(data, { recursive: true })
    await mkdir(project, { recursive: true })
    await mkdir(join(discovery, 'empty'), { recursive: true })
    // 只加载 skill 扩展，避免联动触发 monitor/todo 的状态与工具注册。
    await writeFile(join(data, 'extensions.json'), JSON.stringify({ disabled: ['monitor', 'todo'] }))

    Object.keys(store.config).forEach(key => delete store.config[key])
    Agent.runtime().clear()
    History.clear()
    await Extension.load(Admin.OPS)

    try {
        return await callback({ root, data, discovery, project })
    } finally {
        await Extension.toggle({ name: 'skill', enabled: false }).catch(() => {})
        Path.unlock()
        for (const [key, value] of [
            ['AGENT_HOME', previous.home],
            ['AGENT_DISCOVERY_HOME', previous.discovery],
            ['XDG_CONFIG_HOME', previous.xdg],
            ['APPDATA', previous.appdata],
        ]) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rm(root, { recursive: true, force: true })
    }
}

describe('技能识别与管理（skill 扩展）', () => {
    test('自己的技能直接生效，别的软件的目录先识别、启用后才生效', async () => {
        await withHome(async ({ data, discovery, project }) => {
            await writeSkill(join(data, 'skills', 'review'), 'review', '审查改动', '第一步')
            await writeSkill(join(project, '.agent', 'skills', 'deploy'), 'deploy', '部署', '部署正文')
            const external = join(discovery, '.claude', 'skills')
            await writeSkill(join(external, 'lint'), 'lint', '检查代码', '运行 lint')

            const before = await (await admin('skill.list', { cwd: project })).json()
            expect(before.skills.map(item => item.name).sort()).toEqual(['deploy', 'review'])
            expect(before.skills.find(item => item.name === 'review').body).toBe('')   // 列表不带正文
            const claudeRoot = before.roots.find(item => item.id === 'claude')
            expect(claudeRoot).toMatchObject({ exists: true, enabled: false, skillCount: 1 })

            const enabled = await (await admin('skill.source', { path: external, enabled: true })).json()
            expect(enabled).toEqual({ path: external, enabled: true })

            const after = await (await admin('skill.list', { cwd: project })).json()
            expect(after.skills.map(item => item.name).sort()).toEqual(['deploy', 'lint', 'review'])
            expect(after.skills.find(item => item.name === 'lint').app).toBe('Claude Code')

            await admin('skill.source', { path: external, enabled: false })
            const afterDisable = await (await admin('skill.list', { cwd: project })).json()
            expect(afterDisable.skills.some(item => item.name === 'lint')).toBe(false)
        })
    })

    test('新建、读取、改写和删除自己的技能', async () => {
        await withHome(async ({ data, project }) => {
            const created = await (await admin('skill.save', {
                name: 'write-docs',
                description: '写文档时用',
                body: '先读现有文档',
            })).json()
            expect(created.name).toBe('write-docs')
            expect(created.editable).toBe(true)

            const file = join(data, 'skills', 'write-docs', 'SKILL.md')
            expect(await readFile(file, 'utf8')).toContain('先读现有文档')

            const read = await (await admin('skill.read', { name: 'write-docs' })).json()
            expect(read.body).toBe('先读现有文档')

            const updated = await (await admin('skill.save', {
                name: 'write-docs',
                description: '写文档时用',
                body: '改写后的正文',
            })).json()
            expect(updated.directory).toBe(created.directory)
            expect((await (await admin('skill.read', { name: 'write-docs' })).json()).body).toBe('改写后的正文')

            expect((await admin('skill.read', { name: 'write-docs', cwd: project })).status).toBe(200)

            const removed = await (await admin('skill.remove', { name: 'write-docs' })).json()
            expect(removed).toEqual({ ok: true, name: 'write-docs' })
            expect((await admin('skill.read', { name: 'write-docs' })).status).toBe(404)
        })
    })

    test('项目技能写进当前目录，目录不存在时按 400 返回', async () => {
        await withHome(async ({ project }) => {
            const saved = await (await admin('skill.save', {
                name: 'project-rule',
                description: '项目约定',
                body: '正文',
                scope: 'project',
                cwd: project,
            })).json()
            expect(saved.scope).toBe('project')
            expect(await readFile(join(project, '.agent', 'skills', 'project-rule', 'SKILL.md'), 'utf8')).toContain('正文')

            expect((await admin('skill.save', {
                name: 'x', description: 'x', scope: 'project', cwd: join(project, 'missing'),
            })).status).toBe(400)
        })
    })

    test('填错的名称、说明和目录都按 400 返回，不写出半份文件', async () => {
        await withHome(async ({ discovery }) => {
            expect((await admin('skill.save', { name: '../escape', description: 'x' })).status).toBe(400)
            expect((await admin('skill.save', { name: 'ok', description: '' })).status).toBe(400)
            expect((await admin('skill.save', { name: 'ok', description: 'x', scope: 'elsewhere' })).status).toBe(400)
            expect((await admin('skill.source', { path: 'relative/path', enabled: true })).status).toBe(400)
            expect((await admin('skill.source', { path: join(discovery, 'missing'), enabled: true })).status).toBe(400)
            expect((await admin('skill.source', { path: join(discovery, 'empty'), enabled: true })).status).toBe(400)
            // 白名单外（比如根目录或任意临时目录）不允许收为技能来源。
            expect((await admin('skill.source', { path: tmpdir(), enabled: true })).status).toBe(400)
            expect((await admin('skill.read')).status).toBe(400)
            expect((await admin('skill.read', { name: 'missing' })).status).toBe(404)
        })
    })

    test('禁用的技能不进交给模型的清单，重新启用后回来', async () => {
        await withHome(async ({ data, project }) => {
            await writeSkill(join(data, 'skills', 'review'), 'review', '审查改动', '第一步')
            await writeSkill(join(data, 'skills', 'deploy'), 'deploy', '部署', '部署正文')

            const disabled = await (await admin('skill.toggle', { name: 'review', enabled: false })).json()
            expect(disabled).toEqual({ name: 'review', enabled: false })

            expect((await SkillTool.list({ cwd: project, skills: Skills })).map(item => item.name)).toEqual(['deploy'])
            // 管理页要能读到禁用的技能（enabled: false）才能重新打开；模型清单不含它，所以工具层读不到。
            const disabledSkill = await Skills.read({ name: 'review', cwd: project })
            expect(disabledSkill.enabled).toBe(false)
            await expect(SkillTool.read({ name: 'review', cwd: project, skills: Skills })).rejects.toThrow(/Skill not found/)

            const tool = await SkillTool.build({ cwd: project, skills: Skills })
            expect(tool.description).toContain('deploy')
            expect(tool.description).not.toContain('review')

            const listed = await (await admin('skill.list', { cwd: project })).json()
            expect(listed.skills.find(item => item.name === 'review').enabled).toBe(false)

            await admin('skill.toggle', { name: 'review', enabled: true })
            expect((await SkillTool.list({ cwd: project, skills: Skills })).map(item => item.name).sort()).toEqual(['deploy', 'review'])
        })
    })

    test('外部技能不能被删除，也不能把本应用目录当外部来源', async () => {
        await withHome(async ({ data, discovery }) => {
            const external = join(discovery, '.claude', 'skills')
            await writeSkill(join(external, 'lint'), 'lint', '检查代码', '运行 lint')
            await admin('skill.source', { path: external, enabled: true })

            expect((await admin('skill.remove', { name: 'lint' })).status).toBe(404)
            expect((await admin('skill.source', { path: join(data, 'skills'), enabled: true })).status).toBe(400)
        })
    })

    test('状态文件记录了启用的目录和禁用名单，重启后仍然有效', async () => {
        await withHome(async ({ data, discovery }) => {
            const external = join(discovery, '.claude', 'skills')
            await writeSkill(join(external, 'lint'), 'lint', '检查代码', '运行 lint')
            await writeSkill(join(data, 'skills', 'review'), 'review', '审查', '正文')

            await admin('skill.source', { path: external, enabled: true })
            await admin('skill.toggle', { name: 'review', enabled: false })

            const state = JSON.parse(await readFile(join(data, 'skills.json'), 'utf8'))
            expect(state.sources).toEqual([external])
            expect(state.disabled).toEqual(['review'])

            const skills = await (await admin('skill.list')).json()
            expect(skills.skills.map(item => item.name)).toEqual(['lint', 'review'])
            expect(skills.skills.find(item => item.name === 'review').enabled).toBe(false)
        })
    })

    test('技能工具会带上已启用外部目录里的技能', async () => {
        await withHome(async ({ discovery, project }) => {
            const external = join(discovery, '.claude', 'skills')
            await writeSkill(join(external, 'lint'), 'lint', '检查代码', '运行 lint')
            await admin('skill.source', { path: external, enabled: true })

            const tool = await SkillTool.build({ cwd: project, skills: Skills })
            expect(tool.description).toContain('lint')
            expect(await tool.execute({ name: 'lint' }, { cwd: project })).toBe('运行 lint')
        })
    })

    test('扩展装配注入 Tool.kind / Tool.list 与会话工具表，停用后恢复干净', async () => {
        await withHome(async ({ project }) => {
            await writeSkill(join(project, '.agent', 'skills', 'local'), 'local', '本地技能', '正文')

            expect(Tool.kind({ toolName: 'skill' })).toBe('read')
            const list = await Tool.list()
            expect(list.find(item => item.name === 'skill')).toMatchObject({
                name: 'skill',
                kind: 'read',
                configurable: true,
            })

            await Config.set({ providers: [{ name: 'local', models: [{ id: 'model', name: 'model' }] }], permission: { '*': 'ask' } })
            const { sessionId } = await Session.create({ title: '技能会话', cwd: project })
            const agent = await getAgent(sessionId)
            expect(agent.tools.schema.skill.description).toContain('local')

            await Extension.toggle({ name: 'skill', enabled: false })
            expect((await admin('skill.list')).status).toBe(400)
            expect((await Tool.list()).some(item => item.name === 'skill')).toBe(false)
            expect(Tool.kind({ toolName: 'skill' })).toBe('other')
        })
    })
})
