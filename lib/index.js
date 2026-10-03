/*
  dsh-mc-mod · 宿主半
  ====================

  只对模型暴露【一个】工具：mc_mod

  为什么这么做（这是整个插件最重要的一条设计）：
    21 个子工具如果各自注册，光是工具名 + 描述 + 参数 schema，
    每轮对话都要带上，算下来 8000~12000 token —— 什么都还没干就烧掉了。
    压成一个入口之后固定开销约 600 token，省 90% 以上，
    而模型照样一次就能选对子工具：因为描述里已经给了"目录"。

    参数怎么填不进目录，改成按需查（args:{help:true}）——
    只有真的不会用的时候才花那点 token。

  另一个省 token 的点：当前工程记在宿主半的 ctx 里，
  模型不用每次把工程名、文件内容重新报一遍。
*/
import { defineTool } from '@deepseek-ai/dsh-tools'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TOOLS, BY_KEY, catalog, helpOf } from './tools/index.js'
import { alignProject } from './apifix.js'
import { TOOLS_DIR } from './paths.js'

export const name = 'mc-mod'
export const inject = ['tools']

const VERSION = '1.0.0'

const OUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    /* 注意：DSH 的 value schema DSL 不认顶层的 required 数组，
       必须把 required: true 挂在每个属性上（踩过：schema.required is not supported）。 */
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '(无输出)') }],
}

/**
 * 把参数先过一遍再交给子工具。
 *
 * 为什么必须在【入口】做：
 *   用户给的名字会进 Java 注释（`/** 红宝石块 *​/`）和基岩版的 .lang 文件。
 *   名字里打一个注释结束符，Java 注释就提前结束，后面全变成语法错误；
 *   打一个换行，.lang 就多出一行垃圾。（这两个都是实测出来的，不是想象。）
 *   21 个子工具每个都防一遍不现实，所以在门口统一拦。
 *
 * 为什么算无损：这些字符没有任何合法用途 —— 谁的名字里需要 U+0007？
 *   唯一要小心的是别乱截长度，所以只对 name 收紧到 48（Windows 路径长度
 *   上限会让超长文件名直接 ENOENT），其余字符串放宽到 4000。
 */
function sanitize(value, key = '', depth = 0) {
  if (depth > 6) return value
  if (typeof value === 'string') {
    const s = value
      .replace(/\*\//g, '* /')
      .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '')
    return key === 'name' ? s.slice(0, 48) : s.slice(0, 4000)
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, key, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, k, depth + 1)
    return out
  }
  return value
}

/** 把子工具的返回值压成人能读、又不啰嗦的文本 —— 返回值太长也是在烧 token */
function render(key, r) {
  if (r === null || r === undefined) return `${key}：完成（没有细节）`
  if (typeof r === 'string') return r
  if (r.ok === false) {
    const lines = [`✗ ${key} 没成功：${r.error || '未知原因'}`]
    if (r.hint) lines.push('  ' + r.hint)
    if (r.known) lines.push('  可用的：' + r.known.join(' / '))
    return lines.join('\n')
  }
  const head = [`✓ ${key}`]
  const skip = new Set(['ok', 'note', 'hint'])
  for (const [k, v] of Object.entries(r)) {
    if (skip.has(k)) continue
    if (v === null || v === undefined || v === '') continue
    if (Array.isArray(v)) {
      if (!v.length) continue
      /* 列表太长就截断 —— 模型不需要看 200 行文件清单 */
      const show = v.slice(0, 12)
      head.push(`  ${k}（${v.length}）：`)
      for (const item of show) {
        head.push('    ' + (typeof item === 'object' ? JSON.stringify(item) : String(item)))
      }
      if (v.length > show.length) head.push(`    …还有 ${v.length - show.length} 项`)
    } else if (typeof v === 'object') {
      head.push(`  ${k}：${JSON.stringify(v)}`)
    } else {
      head.push(`  ${k}：${v}`)
    }
  }
  if (r.note) head.push('  ' + r.note)
  if (r.hint) head.push('  ' + r.hint)
  return head.join('\n')
}

export function apply(ctx) {
  /* 宿主半的共享状态：当前在编哪个工程。
     记在这儿，模型就不用每次都把工程名报一遍 —— 又省一笔 token。 */
  const mc = {
    version: VERSION,
    current: '',        /* 当前工程目录 */
    currentName: '',
    touched: 0,         /* 这个工程被改过多少次 */
  }

  ctx.tools.register(defineTool({
    name: 'mc_mod',
    description:
      '《我的世界》模组生成工作台。做模组只用这一个入口：do 指定动哪一块，args 传那个子工具的参数。\n' +
      '\n' +
      '可用：\n' +
      catalog() +
      '\n' +
      '\n' +
      '不确定某个 do 的参数怎么填，就传 args:{help:true} 问一下（只花很少 token，比猜错重来便宜）。\n' +
      'target 有两种：java 出 Fabric 工程（要 JDK 编译成 jar），bedrock 出附加包（纯 JSON，免编译）。\n' +
      '加完东西用 do:verify op:run 体检（断引用/坏贴图/缺条目都能查出来）；换游戏版本用 do:compat。',
    parameters: {
      do: {
        type: 'string',
        description: '要动哪一块，见描述里的目录',
        required: true,
      },
      args: {
        type: 'object',
        description: '那个子工具的参数；不会填就传 {help:true}',
        /* DSH 的 schema 校验要求 object 必须【显式】写 additionalProperties，
           不写就直接拒绝注册（踩过一次：unsupported JSON schema）。
           这里要 true —— 参数是各子工具自己定的，主体工具不该限制字段。 */
        additionalProperties: true,
      },
    },
    output: OUT,
    isConcurrencySafe: () => false,
    async execute(a) {
      const key = String((a && a.do) || '').trim().toLowerCase()
      const raw = (a && a.args && typeof a.args === 'object' && !Array.isArray(a.args)) ? a.args : {}
      const args = sanitize(raw)

      if (!key) {
        return { text: '要用 do= 指定动哪一块。现在有的是：\n' + catalog() }
      }
      if (args.help) return { text: helpOf(key) }

      const tool = BY_KEY.get(key)
      if (!tool) {
        if (key === 'help' || key === 'list') return { text: '可用的：\n' + catalog() }
        return { text: `没有叫「${key}」的子工具。现在有的是：\n${catalog()}` }
      }

      try {
        const r = await tool.run(mc, args)
        /* 返回里带 dir 的才更新"当前工程"。
           注意 op:list 这种"列一下"的返回【绝不能】带 dir —— 它会把当前工程
           冲成工程根目录，之后所有不带 dir 的调用全变成"这个目录不是工程"。 */
        if (r && r.ok && r.dir) {
          mc.current = r.dir
          mc.currentName = r.name || mc.currentName
        }
        /* 子工具的 Java 模板是照 1.21 写的（Identifier.of）。工程目标版本更老
           的话必须改回 new Identifier，不然加一个方块就编译不过。
           条件故意放宽到"只要有当前工程就对齐"：靠返回字段判断的话，漏一个
           工具就是"编译不过"，而对齐本身是幂等的（没变化就一个字节都不写）。 */
        if (r && r.ok && mc.current) {
          try {
            await alignProject(mc.current)
          } catch (e) {
            /* 这里【不能】空着 catch：第一版就是空 catch，把"忘了 import"这种
               ReferenceError 一起吞了，表现成"版本对齐静默失效"，
               查了半天。至少要留个痕。 */
            console.warn('[mc-mod] 版本对齐失败（不影响本次操作）：' + String((e && e.message) || e))
          }
        }
        return { text: render(key, r) }
      } catch (e) {
        return { text: `✗ ${key} 抛异常了：${String((e && e.message) || e).slice(0, 300)}` }
      }
    },
  }))

  /* 加载自证：往工具目录写一个记号文件。
     为什么需要：加了 patch 行之后，"到底生效没有"从外面看不出来 ——
     live reload 有没有加载这个新插件、加载的是哪个进程，全靠猜。
     有这个文件，重启之后看一眼就知道成了没有（也记下了 PID）。 */
  try {
    mkdirSync(TOOLS_DIR, { recursive: true })
    writeFileSync(join(TOOLS_DIR, 'mc-mod-loaded.txt'),
      `mc-mod 加载成功\n时间：${new Date().toLocaleString()}\nPID：${process.pid}\n子工具：${TOOLS.length} 个\n`,
      'utf8')
  } catch { /* 记号文件写不下不该影响插件本身 */ }

  console.log(`[mc-mod] v${VERSION} 已挂载：1 个入口 + ${TOOLS.length} 个子工具（${TOOLS.map((t) => t.key).join(', ')}）`)
}

export const __test = { render, TOOLS, BY_KEY, catalog, helpOf }
