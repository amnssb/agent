/*
 * 文件系统小工具：路径存在性、目录判断、原子读写、子目录判断。
 *
 * 这些判断在 skills / storage / filesystem / temp-workspace 里各写过一份，
 * 四份实现虽然只差几行，但漂移起来很难发现（比如一处用 access、一处用 stat，
 * 对 symlink 的行为就不一样）。统一收到这里，只维护一套。
 *
 * 调用示例：
 *   await Fs.exists(path)
 *   await Fs.isDirectory(path)
 *   const data = await Fs.readJson(file, {})
 *   const guarded = await Fs.readJsonGuarded(file, {}, { onCorrupt: ({ backupPath }) => ... })
 *   await Fs.writeJson(file, value)
 *   Fs.inside(root, target)
 */

import { access, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { writeFile } from 'atomically'

// --- 路径是否存在；不存在或没权限都算不存在 ---
const exists = async path => {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

// --- 是不是一个目录 ---
// 用 stat 而不是 lstat：~/.claude/skills 这类目录常常是指向真实技能库的
// symlink / junction，lstat 会把它们当成非目录直接跳过。
const isDirectory = async path => {
    try {
        return (await stat(path)).isDirectory()
    } catch {
        return false
    }
}

// --- 是不是一个普通文件 ---
const isFile = async path => {
    try {
        return (await stat(path)).isFile()
    } catch {
        return false
    }
}

// --- 读 JSON；文件不在或内容坏了都用 fallback ---
const readJson = async (path, fallback = null) => {
    try {
        return JSON.parse(await readFile(path, 'utf8'))
    } catch {
        return fallback
    }
}

// --- 读重要状态 JSON：内容损坏时把坏档改名留证并告警，不静默当成空白 ---
const readJsonGuarded = async (path, fallback = null, { onCorrupt } = {}) => {
    let raw
    try {
        raw = await readFile(path, 'utf8')
    } catch (error) {
        if (error?.code === 'ENOENT') return fallback           // 文件尚未建立属于正常情况
        throw error
    }
    try {
        return JSON.parse(raw)
    } catch (error) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const backupPath = `${path}.broken-${stamp}`
        await rename(path, backupPath).catch(() => {})          // 坏档隔离留证，防止下次写入直接覆盖丢失
        if (onCorrupt) onCorrupt({ path, backupPath, error })
        else console.error(`[fs] JSON 损坏，已备份至 ${backupPath}: ${error.message}`)
        return fallback
    }
}

// --- 原子写 JSON：走 atomically 临时文件+rename，中途崩溃不会留下半份 ---
// 模式 0600：这些文件里可能有密钥（MCP 的 env、供应商的 apiKey）。
const writeJson = async (path, value, { mode = 0o600 } = {}) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(value, null, 2), { encoding: 'utf8', mode })
}

// --- child 是否在 parent 里面（含相等） ---
// 用 relative 而不是 startsWith 拼字符串：后者会把 /a/bc 当成 /a/b 的子目录。
const inside = (parent, child) => {
    const path = relative(resolve(String(parent)), resolve(String(child)))
    if (!path) return true                                   // 同一个位置
    return !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)
}

// --- child 是否在 parent 里面，但不含相等 ---
const within = (parent, child) => {
    const base = resolve(String(parent))
    const target = resolve(String(child))
    return target !== base && inside(base, target)
}

export { exists, isDirectory, isFile, readJson, readJsonGuarded, writeJson, inside, within }
export default { exists, isDirectory, isFile, readJson, readJsonGuarded, writeJson, inside, within }
