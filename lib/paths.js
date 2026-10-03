/*
  paths.js —— 工程落在哪、工具装在哪
  ==================================

  全部集中在这儿，别处不许自己拼路径。理由：
    · 用户换机器 / 换盘只要改这一个文件；
    · 测试可以把根目录指到临时目录（DSH_MCMOD_HOME），不碰真实工程。

  目录约定：
    <home>/projects/<工程名>/      一个模组 = 一个目录
    <home>/tools/jdk-21/           JDK（install-jdk.ps1 装的）
    <home>/cache/                  生成过程的中间产物（纹理、音效等）
*/
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

/** 工程与工具的根。测试用 DSH_MCMOD_HOME 指到临时目录。 */
export const DEFAULT_HOME = 'D:\\MCTools'
export const HOME = process.env.DSH_MCMOD_HOME || DEFAULT_HOME

export const PROJECTS_DIR = join(HOME, 'projects')
export const TOOLS_DIR = join(HOME, 'tools')
export const CACHE_DIR = join(HOME, 'cache')

/**
 * JDK 路径：先看 install-jdk.ps1 留的记号文件，再退回到扫目录。
 *
 * 为什么要兜底看默认目录：测试会把 HOME 指到临时目录（工程要隔离），
 * 但 JDK 是装在整个机器上的，不在临时目录里 —— 只认 HOME 的话，
 * 测试里就永远"没装 JDK"，真编译那一步白测了。
 */
export function findJdk() {
  const roots = HOME === DEFAULT_HOME ? [HOME] : [HOME, DEFAULT_HOME]
  for (const root of roots) {
    const marker = join(root, 'tools', 'jdk-path.txt')
    if (existsSync(marker)) {
      try {
        const p = readFileSync(marker, 'utf8').trim()
        if (p && existsSync(join(p, 'bin', 'javac.exe'))) return p
      } catch { /* 记号坏了就往下扫 */ }
    }
  }
  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      for (const d of readdirSync(root)) {
        if (!/^jdk-/i.test(d)) continue
        const p = join(root, d)
        if (existsSync(join(p, 'bin', 'javac.exe'))) return p
      }
    } catch { /* 读不了就换下一个 */ }
  }
  return ''
}

/**
 * 工程目录名做安全化：只允许字母数字下划线连字符和中文，
 * 别让人用 `../` 之类的把文件写到工程根外面去。
 */
export function safeProjectName(name) {
  const raw = String(name || '').trim()
  if (!raw) return ''
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, '').replace(/\.\./g, '').trim()
  if (!cleaned || cleaned === '.' ) return ''
  if (cleaned.length > 60) return cleaned.slice(0, 60)
  return cleaned
}

export function projectPath(name) {
  const safe = safeProjectName(name)
  return safe ? join(PROJECTS_DIR, safe) : ''
}

export const TARGETS = ['java', 'bedrock']

export function normalizeTarget(t) {
  const v = String(t || '').toLowerCase().trim()
  if (v === 'java' || v === 'je' || v === 'forge' || v === 'neoforge' || v === 'fabric') return 'java'
  if (v === 'bedrock' || v === 'be' || v === 'addon' || v === '基岩') return 'bedrock'
  return ''
}
