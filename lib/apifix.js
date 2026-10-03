/*
  apifix.js —— 把生成的 Java 对齐到工程的目标游戏版本
  ====================================================

  为什么需要这一层：

    各子工具的 Java 模板是照 1.21 写的（`Identifier.of(命名空间, 名字)`）。
    但 1.20.x 上这个方法还不存在，得用 `new Identifier(命名空间, 名字)`。
    于是"建一个 1.20.1 的工程，加个方块"—— 生成出来的代码在 1.20.1 上根本
    编译不过，而且报的还是"找不到符号"这种让人一头雾水的错。

    修的办法不是让 21 个子工具各自判断版本（那样每加一个工具都要记得这件事，
    迟早漏），而是在文件写完之后统一过一遍：**幂等、便宜、一处管全部**。

  为什么不用"生成时选写法"：模板字符串里到处散着 Identifier，改漏一个就出事；
  而这是纯字符串替换，改错了也一眼看得出来（测试里拿真 javac 兜）。

  只动 Identifier 这一处 —— 别的版本差异（物品注册键、属性注册项）改法不机械，
  乱改会把能编译的代码改坏，交给 compat 的 check 去报告、用户自己动手。
*/
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cmpVersion } from './versions.js'

async function javaFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'build' || e.name === '.gradle') continue
      await javaFiles(p, out)
    } else if (e.name.endsWith('.java')) {
      out.push(p)
    }
  }
  return out
}

/** 1.21 起用 Identifier.of(...)，之前用 new Identifier(...) */
export function wantsFactory(mcVersion) {
  return cmpVersion(mcVersion, '1.21') >= 0
}

/**
 * 把源码切成"代码区"，跳过行注释、块注释、字符串和字符字面量。
 * 不这么做的话 `String s = "Identifier.of(a, b)";` 也会被改 ——
 * 那改的是用户运行时会用到的文本，不是代码。
 */
export function codeRanges(src) {
  const ranges = []
  const n = src.length
  let i = 0
  let start = 0
  const flush = (end) => { if (end > start) ranges.push([start, end]) }
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      flush(i)
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? n : nl
      start = i
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      flush(i)
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      start = i
      continue
    }
    /* 文本块 """...""" 也是运行时字符串，里面一个字都不该动。
       不单独认它的话，会被当成"一个空串 + 一个没闭合的字符串"，
       文本块体整段落进代码区，里面的说明文字就被改了（踩过）。 */
    if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      flush(i)
      const end = src.indexOf('"""', i + 3)
      i = end < 0 ? n : end + 3
      start = i
      continue
    }
    if (c === '"' || c === "'") {
      flush(i)
      let j = i + 1
      while (j < n) {
        if (src[j] === '\\') {
          /* 行尾反斜杠：这行字符串已经断了（Java 的普通字符串不能跨行）。
             继续往下扫的话会把下一整行都当成字符串吞掉，那一整段代码都改不了，
             而且一声不吭（踩过）。 */
          if (src[j + 1] === '\n' || src[j + 1] === '\r') break
          j += 2
          continue
        }
        if (src[j] === c) { j++; break }
        if (src[j] === '\n') break
        j++
      }
      i = j
      start = i
      continue
    }
    i++
  }
  flush(n)
  return ranges
}

/** 只在代码区做替换 */
export function replaceInCode(src, re, repl) {
  let out = ''
  let last = 0
  for (const [s, e] of codeRanges(src)) {
    out += src.slice(last, s) + src.slice(s, e).replace(re, repl)
    last = e
  }
  return out + src.slice(last)
}

/*
  正则的四个讲究（都是踩出来的）：

  1. 必须认全限定名，并且替换时把限定名一起带上：
       Identifier.of(a, b)                    → new Identifier(a, b)
       net.minecraft.util.Identifier.of(a, b) → new net.minecraft.util.Identifier(a, b)
     天真的 /Identifier\.of\(/ 会把第二行改成 net.minecraft.util.new Identifier(...)，
     把能编译的代码变成语法错误。反方向也一样 —— 只认 `new Identifier(` 的话，
     `new net.minecraft.util.Identifier(...)` 会被漏掉，在 1.21 上编译不过。

  2. lookbehind (?<![\w$.]) 挡住两种情况：
       ModIdentifier.of(a, b)    用户自己的类（前面粘着标识符字符）
       o.new Identifier(1)       内部类的实例化语法（前面是点，不是构造调用）
     少了 `$` 会得到 Modnew Identifier(...)，少了 `.` 会把 o.new Identifier(1)
     改成 o.Identifier.of(1)，javac 直接报 unexpected type。

  3. 只在代码区替换（replaceInCode）：字符串、文本块、注释里的同名文本是用户的文本。

  4. 裸 `Identifier`（不带限定名）只在文件确实 import 了 MC 那个 Identifier 时才动 ——
     用户完全可以自己写一个叫 Identifier 的类，那种情况一个字都不该改。
*/
export const OF_RE = /(?<![\w$.])((?:[\w$]+\.)*)Identifier\.of\(/g
export const CTOR_RE = /(?<![\w$.])new\s+((?:[\w$]+\.)*)Identifier\(/g

/** 这个文件用的是不是 Minecraft 那个 Identifier */
export function usesMcIdentifier(src) {
  return /import\s+net\.minecraft\.util\.Identifier\s*;/.test(src) ||
    /net\.minecraft\.util\.Identifier\b/.test(src)
}

/**
 * 把一个源码字符串的 Identifier 写法对齐到目标版本，并数出改了几处。
 * 注意 `Identifier.ofVanilla(` 不受影响 —— 正则要求 `of` 后面紧跟左括号。
 */
export function alignSourceCount(src, mcVersion) {
  let n = 0
  const mcId = usesMcIdentifier(src)
  const text = wantsFactory(mcVersion)
    ? replaceInCode(src, CTOR_RE, (m, qual) => {
      if (!qual && !mcId) return m
      n++
      return (qual || '') + 'Identifier.of('
    })
    : replaceInCode(src, OF_RE, (m, qual) => {
      if (!qual && !mcId) return m
      n++
      return 'new ' + (qual || '') + 'Identifier('
    })
  return { text, n }
}

/** 只要结果不要计数的时候用这个 */
export function alignSource(src, mcVersion) {
  return alignSourceCount(src, mcVersion).text
}

/** 对齐整个工程，返回改动的文件数（幂等：已经是目标写法就一个字节都不动） */
export async function alignJavaVersion(projDir, mcVersion) {
  const root = join(projDir, 'src/main/java')
  let changed = 0
  for (const f of await javaFiles(root)) {
    const src = await readFile(f, 'utf8')
    const next = alignSource(src, mcVersion)
    if (next !== src) {
      await writeFile(f, next, 'utf8')
      changed++
    }
  }
  return changed
}

/**
 * 从工程的 mcmod.json 读目标版本再对齐。基岩版没有 Java 源码，直接返回 0。
 * 读不到元数据就什么都不做 —— 这层是"顺手修正"，不该在别人的流程里抛异常。
 */
export async function alignProject(projDir) {
  if (!projDir || !existsSync(join(projDir, 'mcmod.json'))) return 0
  try {
    const meta = JSON.parse(await readFile(join(projDir, 'mcmod.json'), 'utf8'))
    if (!meta || meta.target !== 'java' || !meta.mcVersion) return 0
    return await alignJavaVersion(projDir, meta.mcVersion)
  } catch {
    return 0
  }
}

export const __test = { codeRanges, replaceInCode, usesMcIdentifier, OF_RE, CTOR_RE }
