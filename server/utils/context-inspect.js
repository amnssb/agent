/*
 * 上下文检查器：把一次对话装配所需的全部上下文成分并排摆出来，只读不改。
 *
 * 所有成分来自现有源，不发明新数据：
 *   system   → Context.system()          用户提示词 + 项目规则 + 压缩规范
 *   tools    → Tool.list()               工具名/描述/权限（扫描结果，不新建 Agent）
 *   messages → History.get()             历史消息的统计摘要（角色/字节量/是否压缩摘要）
 *   estimate → Agent.estimateContext()   token 估算（来自 agent-core 的静态计算）
 *   actual   → ContextUsage.read()       上一轮实测值（来自 onInject 回调，重启即清）
 *   keep     → store.config.contextKeep 当前生效的压缩后保留配置
 *
 * 注册为 /admin op：'context.inspect'（不新增路由）。
 *
 * 调用示例：
 *   const result = await inspect({ sessionId: 'abc' })
 */

import Context from '../features/context.js'
import Tool from '../features/tool.js'
import Agent from '../features/agent.js'
import History from '../features/history.js'
import ContextUsage from './context-usage.js'
import store from '../store.js'
import fail from './fail.js'

// 消息的字节估算（字符数 × 1.5 字节粗估），比 JSON.stringify 快，够诊断用
const byteOf = msg => {
    const content = msg.content
    if (typeof content === 'string') return Math.ceil(content.length * 1.5)
    if (Array.isArray(content)) {
        return Math.ceil(content.reduce((sum, block) => {
            if (block?.type === 'text') return sum + (block.text?.length || 0) * 1.5
            if (block?.type === 'image') return sum + 2000  // 图片按粗估计
            return sum + 50
        }, 0))
    }
    return 0
}

// 判断一条消息是否是压缩摘要（agent-core 的 compact 消息带 compact: true 或 role 为 compact）
const isCompact = msg => msg?.compact === true || msg?.role === 'compact'

// --- 组装消息列表的统计摘要（角色/字节量/是否压缩） ---
const messagesSummary = messages => {
    const tail = messages.slice(-50)    // 最多展示尾部 50 条，防止检查器本身撑爆上下文
    return {
        total: messages.length,
        shown: tail.length,
        items: tail.map(msg => ({
            messageId: msg.messageId,
            role: msg.role,
            bytes: byteOf(msg),
            compact: isCompact(msg),
        })),
    }
}

// --- 工具摘要：name + description 前 120 字 + permission ---
const toolsSummary = tools => tools.map(tool => ({
    name: tool.name,
    kind: tool.kind,
    description: (tool.description || '').slice(0, 120) + ((tool.description?.length || 0) > 120 ? '…' : ''),
    permission: tool.permission,
}))

// --- 对 system 文本按段落来源标注 ---
const annotateSystem = text => {
    if (!text) return { text: '', length: 0, segments: [] }
    const segments = []
    // 识别三个来源段：项目规则（# Workspace rules 开头）、压缩规范（# 上下文压缩 开头）、用户提示词（其余）
    const lines = text.split('\n')
    let current = { kind: 'prompt', start: 0 }
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.startsWith('# Workspace rules')) {
            if (current.start < i) segments.push({ ...current, end: i - 1 })
            current = { kind: 'rules', start: i }
        } else if (line.startsWith('# 上下文压缩')) {
            if (current.start < i) segments.push({ ...current, end: i - 1 })
            current = { kind: 'compact-guide', start: i }
        }
    }
    segments.push({ ...current, end: lines.length - 1 })
    return {
        text,
        length: text.length,
        segments: segments.map(seg => ({
            kind: seg.kind,
            chars: lines.slice(seg.start, seg.end + 1).join('\n').length,
            lineStart: seg.start + 1,
            lineEnd: seg.end + 1,
        })),
    }
}

/**
 * 检查一条会话的上下文装配情况。
 * @param {{ sessionId: string }} params
 */
const inspect = async ({ sessionId } = {}) => {
    if (!sessionId) throw fail(400, 'sessionId is required')

    // 确保会话已加载到内存
    if (!store.sessions[sessionId]) {
        await History.load(sessionId).catch(() => {
            throw fail(404, `session not found: ${sessionId}`)
        })
    }
    const session = store.sessions[sessionId]
    if (!session) throw fail(404, `session not found: ${sessionId}`)

    // --- 并行装配各成分 ---
    const [systemText, toolList, actual] = await Promise.all([
        Context.system({ config: store.config, cwd: session.cwd }),
        Tool.list(),
        ContextUsage.hydrate(sessionId),
    ])

    // History.get 是同步的（内存读）
    const messages = History.get({ sessionId })

    // 读当前 agent settings（走默认值，不装配真实 Agent）
    const agentSettings = Agent.settings(session)

    // 估算 token 数（来自 agent-core 的静态 context.build）
    const resolvedConfig = await Agent.resolve({
        session,
        settings: agentSettings,
        context: Context,
    })
    const budget = resolvedConfig.maxContextTokens
    const ratio = resolvedConfig.contextRatio || store.config.compact?.threshold || 0.8

    const estimate = Agent.estimateContext({
        history: messages.map(msg => ({ ...msg })),
        system: systemText,
        budget,
        ratio,
    })

    // ContextUsage.read 读内存（hydrate 刚把磁盘值填进去了）
    const measured = ContextUsage.read(sessionId)

    return {
        sessionId,
        cwd: session.cwd || null,
        system: annotateSystem(systemText),
        tools: toolsSummary(toolList),
        messages: messagesSummary(messages),
        estimate: {
            tokens: estimate,
            budget,
            compactThreshold: ratio,
            compactAt: Math.round(budget * ratio),
            percentOfBudget: budget > 0 ? Math.round((estimate / budget) * 1000) / 10 : null,
        },
        actual: measured,          // null 表示本次重启后这条会话还没跑过一轮
        keep: { ...store.config.contextKeep },
    }
}

export default { inspect }
