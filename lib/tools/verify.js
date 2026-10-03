/*
  verify —— 工程体检 / 测试（子工具 #20）
  ======================================

  关于"做一个模拟 MC，从本机游戏里抽源码"这件事，先说清楚：
  《我的世界》是闭源商业软件，安装目录里只有 .jar 字节码（混淆过），
  没有源码，抽不出来。所以这个子工具做的是【工程校验器】而不是模拟器：

    它不运行游戏，但它能在你把模组丢进游戏之前，把"装进去必然出事"的问题
    全挑出来 —— 断掉的贴图引用、缺的语言条目、类名和文件名不一致
    （javac 会因此直接报错）、坏掉的 PNG、命名空间写错、清单和代码对不上。

  三条铁律（都是踩出来的）：
    1. 【宁可不说话，不许说假话】内容清单 JSON 坏掉时必须报出来。
       早先读不出来就当空数组，于是体检"零错误、可以打包"，而所有依赖清单的
       检查全静默失效 —— 这是体检器最不能犯的错。
    2. 【分得清"错误"和"只是提醒"】引用了工程里没有的贴图，可能是原版自带的
       （正常用法），也可能是自己漏放了。分不清就不要报成错误，否则 AI 会去
       改一段本来好好的东西。
    3. 【报告要跟事实一致】"真错误 0 条"不能掩盖"这条我没法验证"。

  三种用法：
    run（默认）  静态体检，秒出结果，不需要 JDK
    java         真调 javac 编译一遍。没有 MC 库，所以"找不到符号"算正常，
                 除此之外的报错都是真错误 —— 只有编译器能抓住这类问题
    fix          能自动修的自动修（补语言条目、补客户端入口）

  为什么 op:java 单列：字符串检查永远发现不了少个引号、括号不配对这种事，
  只有真编译器行。
*/
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readMeta } from './project.js'
import { decodePng } from '../png.js'
import { findJdk } from '../paths.js'
import { codeRanges } from '../apifix.js'

/* ============================ 基础工具 ============================ */

/**
 * 把注释和字符串里的内容换成空格 —— 长度和换行都保持不变，
 * 所以拿它做正则匹配时，行号还能对上原文。
 *
 * 为什么需要：文档注释里写一句 `{@code public class ModBlocks {}}`，
 * 天真的正则就会把 ModBlocks 当成"这个文件的类名"，然后报
 * "类名和文件名对不上 —— javac 会拒绝编译"。误报最讨厌，
 * 因为它会推着模型去改一段本来完全正常的代码（踩过）。
 */
export function stripNonCode(src) {
  const mask = (t) => t.replace(/[^\n]/g, ' ')
  let out = ''
  let last = 0
  for (const [s, e] of codeRanges(src)) {
    out += mask(src.slice(last, s)) + src.slice(s, e)
    last = e
  }
  return out + mask(src.slice(last))
}

async function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'build' || e.name === '.gradle' || e.name === 'node_modules' || e.name === '.mcmod') continue
      await walk(p, out)
    } else {
      out.push(p)
    }
  }
  return out
}

async function walkExt(dir, ext, out = []) {
  return (await walk(dir, out)).filter((f) => f.endsWith(ext))
}

/**
 * 找顶层的类名。
 * 注意包私有类（没有 public）也是合法 Java，加同名文件完全没问题 ——
 * 只认 public 会误报"没找到 public class 声明"，把 AI 推去改一段能编译的代码。
 *
 * 还要先剔掉注释和字符串：Javadoc 里写一句 `{@code public class Foo {}}`
 * 就能让这个函数认错类名（踩过）。
 */
export function classNameOf(src) {
  const code = stripNonCode(src)
  const forms = '(?:final\\s+|abstract\\s+|sealed\\s+|non-sealed\\s+|strictfp\\s+)*'
  const pub = new RegExp('public\\s+' + forms + '(?:class|interface|enum|record)\\s+([A-Za-z_$][\\w$]*)').exec(code)
  if (pub) return pub[1]
  const any = new RegExp('(?:^|\\n)' + forms + '(?:class|interface|enum|record)\\s+([A-Za-z_$][\\w$]*)').exec(code)
  return any ? any[1] : ''
}

export function packageOf(src) {
  const m = /^\s*package\s+([\w.]+)\s*;/m.exec(stripNonCode(src))
  return m ? m[1] : ''
}

/**
 * 收集基岩版 JSON 里的 identifier 和 texture 引用。
 * texture 的值可能是【数组】（基岩版合法且常见），早先遇到非字符串就既不记也不
 * 往下走，整段引用被静默丢掉（踩过）。
 */
export function collectIdentifiers(obj, out = []) {
  if (Array.isArray(obj)) { for (const v of obj) collectIdentifiers(v, out); return out }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'identifier' && typeof v === 'string') out.push(v)
      else if (k === 'texture') {
        if (typeof v === 'string') out.push('texture:' + v)
        else if (Array.isArray(v)) {
          for (const one of v) if (typeof one === 'string') out.push('texture:' + one)
            else collectIdentifiers(one, out)
        } else collectIdentifiers(v, out)
      } else collectIdentifiers(v, out)
    }
  }
  return out
}

/** 贴图引用 "textures/blocks/ruby" → 该存在哪个文件 */
export function textureRefToFile(ref) {
  if (!ref.startsWith('textures/')) return ''
  return ref.endsWith('.png') ? ref : ref + '.png'
}

/**
 * 游戏【自带】的贴图。附加包里引用它们是对的，不该报"缺文件"。
 * 最典型的就是粒子：基岩版粒子默认用原版图集 textures/particle/particles。
 *
 * 但这张白名单注定不全（原版的 textures/blocks/stone 也是自带的）——
 * 所以真正靠得住的判断是"登记表里写了却没有文件 = 错误；裸路径引用没有文件 = 警告"，
 * 白名单只用来少报几条噪音。
 */
export const VANILLA_TEX_PREFIX = [
  'textures/particle/', 'textures/ui/', 'textures/gui/', 'textures/environment/',
  'textures/misc/', 'textures/font/', 'textures/map/', 'textures/colormap/',
  'textures/flipbook_textures.json', 'textures/terrain_texture.json', 'textures/item_texture.json',
]

export function isVanillaTexture(ref) {
  return VANILLA_TEX_PREFIX.some((p) => ref.startsWith(p))
}

/**
 * 目录里有没有这个文件，而且【大小写一致】。
 * Windows 的 existsSync 不区分大小写，所以 textures/items/MyIcon.png 和
 * .../myicon.png 都能"找到"；打包到 Linux / macOS / CI 上就是断链。
 * 返回 true / 'case'（只是大小写不对）/ false。
 */
export function realNameExists(rootDir, rel) {
  const segs = String(rel).split('/').filter(Boolean)
  let cur = rootDir
  for (const seg of segs) {
    if (!existsSync(cur)) return false
    let names = []
    try { names = readdirSync(cur) } catch { return false }
    if (!names.includes(seg)) {
      return names.some((n) => n.toLowerCase() === seg.toLowerCase()) ? 'case' : false
    }
    cur = join(cur, seg)
  }
  return true
}

/* 清单有两种形状：数组（方块、物品……）和按名字索引的对象（动作 anims 就是）。
   但【别去猜哪个是哪个】—— 我第一版凭印象把 uses/ai/renders/potions 当成对象，
   结果全是数组，一次误报四条"清单坏了"。形状是工具自己写的，不会无缘无故变，
   真正要防的只有一件事：JSON 语法坏掉（那会让后面所有检查静默失效）。 */
export const PART_NAMES = ['blocks', 'items', 'entities', 'biomes', 'recipes', 'particles',
  'effects', 'sounds', 'structures', 'renders', 'anims', 'potions', 'uses', 'ai', 'textures']

/** 取数组型清单，形状不对就当空的（形状问题不值得报，语法问题上面已经报了） */
export const arr = (parts, name) => (Array.isArray(parts[name]) ? parts[name] : [])

/**
 * 读全部内容清单。
 *
 * 坏掉的清单必须【报出来】：读不出来就当空数组的话，所有依赖清单的检查
 * （语言覆盖、清单↔代码、fix 补条目）会一起静默失效，而体检照样说"干净"。
 * 那是最坏的一种错 —— 用户拿着"可以打包了"去打包一个残缺的模组。
 */
export async function readParts(dir) {
  const parts = {}
  const broken = []
  for (const n of PART_NAMES) {
    const f = join(dir, '.mcmod', n + '.json')
    if (!existsSync(f)) { parts[n] = []; continue }
    try {
      const v = JSON.parse(await readFile(f, 'utf8'))
      if (v === null || typeof v !== 'object') {
        parts[n] = []
        broken.push(`.mcmod/${n}.json 不是对象也不是数组`)
      } else {
        parts[n] = v
      }
    } catch (e) {
      parts[n] = []
      broken.push(`.mcmod/${n}.json 不是合法 JSON（${String(e.message).slice(0, 40)}）`)
    }
  }
  return { parts, broken }
}

/** 工程里"应该存在"的物品 id（方块也算，因为方块自带物品形态） */
export function knownItemIds(parts, modId) {
  const s = new Set()
  for (const b of arr(parts, 'blocks')) s.add(`${modId}:${b.name}`)
  for (const i of arr(parts, 'items')) s.add(`${modId}:${i.name}`)
  return s
}

/* ============================ 静态体检 ============================ */

export async function checkProject(projDir, meta) {
  const errors = []
  const warns = []
  const stat = { javaFiles: 0, pngs: 0, jsons: 0, langs: 0 }
  const isJava = meta.target === 'java'
  const modId = meta.modId

  const { parts, broken } = await readParts(projDir)
  /* 铁律 1：清单坏了，后面的结论全不算数 */
  for (const b of broken) {
    errors.push(`${b} —— 内容清单读不出来，本次体检结果不可信（先修它，或者重新生成一遍）`)
  }
  const blocks = arr(parts, 'blocks')
  const items = arr(parts, 'items')

  /* --- Java：包名/类名/编码 --- */
  if (isJava) {
    const javaDir = join(projDir, 'src/main/java')
    for (const f of await walkExt(javaDir, '.java')) {
      stat.javaFiles++
      const rel = relative(projDir, f)
      const buf = readFileSync(f)
      if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        errors.push(`${rel}：文件开头有 BOM —— javac 会报 "illegal character"`)
      }
      const src = buf.toString('utf8')
      const cls = classNameOf(src)
      const base = f.split(/[\\/]/).pop().replace(/\.java$/, '')
      if (!cls) warns.push(`${rel}：没找到类声明`)
      else if (cls !== base) errors.push(`${rel}：类名是 ${cls}，和文件名对不上 —— javac 会拒绝编译`)
      const pkg = packageOf(src)
      if (!pkg) errors.push(`${rel}：没有 package 声明`)
      else if (!rel.replace(/\\/g, '/').startsWith('src/main/java/' + pkg.replace(/\./g, '/') + '/')) {
        errors.push(`${rel}：package ${pkg} 和它所在的目录对不上`)
      }
    }
    if (!stat.javaFiles) errors.push('src/main/java 下一个 .java 都没有 —— 工程是空的')

    /* 客户端入口：漏了的话生物隐形、粒子不显示，而且不报错 */
    const fmjPath = join(projDir, 'src/main/resources/fabric.mod.json')
    if (existsSync(fmjPath)) {
      stat.jsons++
      try {
        const fmj = JSON.parse(await readFile(fmjPath, 'utf8'))
        const ent = fmj.entrypoints || {}
        if (fmj.id !== modId) errors.push(`fabric.mod.json 的 id 是 ${fmj.id}，和工程记录的 ${modId} 不一致`)
        if ((arr(parts, 'entities').length || arr(parts, 'particles').length) && !(ent.client || []).length) {
          errors.push('fabric.mod.json 没有 client 入口 —— 生物会隐形、粒子不显示（用 op:fix 补）')
        }
        for (const cls of [...(ent.main || []), ...(ent.client || [])]) {
          /* 嵌套类（带 $）不能按文件名推路径，跳过别乱报 */
          if (String(cls).includes('$')) continue
          const rel = 'src/main/java/' + String(cls).replace(/\./g, '/') + '.java'
          if (!existsSync(join(projDir, rel))) errors.push(`入口类不存在：${cls}`)
        }
      } catch (e) {
        errors.push('fabric.mod.json 不是合法 JSON：' + String(e.message).slice(0, 60))
      }
    } else {
      errors.push('缺 src/main/resources/fabric.mod.json —— 这不是个能加载的模组')
    }

    /* 清单 ↔ 代码：按【名字】查。包名从实际文件位置取，别硬编码 com.example */
    for (const [part, fileName, what] of [['blocks', 'ModBlocks.java', '方块'], ['items', 'ModItems.java', '物品']]) {
      const list = part === 'blocks' ? blocks : items
      if (!list.length) continue
      const hit = (await walkExt(join(projDir, 'src/main/java'), '.java'))
        .find((f) => f.split(/[\\/]/).pop() === fileName)
      if (!hit) { errors.push(`清单里有 ${list.length} 个${what}，却没有 ${fileName}`); continue }
      const src = await readFile(hit, 'utf8')
      const miss = list.filter((x) => !src.includes('"' + x.name + '"'))
      if (miss.length) {
        errors.push(`${fileName} 里没有这几个${what}：${miss.map((x) => x.name).slice(0, 5).join(', ')} —— 清单里有但代码没生成`)
      }
    }

    /* 方块/物品的【外观文件】：blockstate + model。缺了游戏里就是紫黑格，
       而且什么都不报 —— 玩家只看到一堆紫黑方块，根本猜不到是文件没生成。
       这是体检器最该抓的一类问题，所以单列出来。 */
    const assetsRoot = join(projDir, 'src/main/resources/assets', modId)
    for (const b of blocks) {
      for (const [rel, what] of [
        [`blockstates/${b.name}.json`, 'blockstate'],
        [`models/block/${b.name}.json`, '模型'],
        [`models/item/${b.name}.json`, '物品形态模型'],
      ]) {
        if (!existsSync(join(assetsRoot, rel))) {
          errors.push(`方块 ${b.name} 缺${what}：assets/${modId}/${rel} —— 游戏里会显示成紫黑格`)
        }
      }
    }
    for (const it of items) {
      if (!existsSync(join(assetsRoot, 'models/item', it.name + '.json'))) {
        errors.push(`物品 ${it.name} 缺模型：assets/${modId}/models/item/${it.name}.json —— 游戏里会显示成紫黑格`)
      }
    }

    /* 生成的代码引用的【本工程类】必须真的存在。
       为什么单列这一条：模板里写死类名（比如 `MyMod.MOD_ID`，而实际主类叫
       `Lab3081`）会生成出编译不过的代码，但编译器的报错是 "cannot find symbol" ——
       那条被"缺 MC 库"的过滤一起吃掉了，谁都看不见。静态查这一步很便宜，别再交学费。 */
    const allJava = await walkExt(join(projDir, 'src/main/java'), '.java')
    const javaNames = new Set(allJava.map((f) => f.split(/[\\/]/).pop()))
    for (const f of allJava) {
      const src = await readFile(f, 'utf8')
      for (const m of src.matchAll(/\b([A-Z][A-Za-z0-9_]*)\.(MOD_ID|LOGGER)\b/g)) {
        if (javaNames.has(m[1] + '.java')) continue
        errors.push(`${relative(projDir, f)} 引用了 ${m[1]}.${m[2]}，但 src/main/java 下没有 ${m[1]}.java 这个类 —— 主类名写死或者写错了`)
      }
    }

    /* 模型文件引用的贴图（基岩版有这项检查，Java 侧不能没有） */
    for (const f of await walkExt(join(assetsRoot, 'models'), '.json')) {
      let j
      try { j = JSON.parse(await readFile(f, 'utf8')) } catch { continue }
      for (const v of Object.values(j.textures || {})) {
        const s = String(v)
        if (!s.startsWith(modId + ':')) continue
        const png = join(assetsRoot, 'textures', s.slice(modId.length + 1) + '.png')
        if (!existsSync(png)) {
          errors.push(`${relative(projDir, f)} 引用了不存在的贴图：${s}`)
        }
      }
    }
  } else {
    for (const p of ['behavior_pack/manifest.json', 'resource_pack/manifest.json']) {
      if (!existsSync(join(projDir, p))) errors.push('缺 ' + p)
    }
    const langDir = join(projDir, 'resource_pack/texts')
    if (existsSync(langDir)) {
      const names = readdirSync(langDir)
      if (!names.includes('zh_CN.lang')) warns.push('没有 zh_CN.lang —— 基岩版语言文件名大小写是严格的')
      if (!names.includes('en_US.lang')) warns.push('没有 en_US.lang')
    } else {
      warns.push('没有 resource_pack/texts 目录')
    }
  }

  /* --- 图片：能不能解码 + 尺寸对不对 --- */
  for (const f of (await walk(projDir)).filter((x) => x.endsWith('.png'))) {
    stat.pngs++
    const rel = relative(projDir, f)
    try {
      const img = decodePng(readFileSync(f))
      const inEntity = /textures[\\/]entity/.test(f)
      if (inEntity) {
        if (img.w % 16 || img.h % 16) warns.push(`${rel}：生物贴图 ${img.w}x${img.h} 不是 16 的整数倍，UV 会对不齐`)
      } else if (img.w !== 16 || img.h !== 16) {
        warns.push(`${rel}：${img.w}x${img.h}，方块/物品贴图按 16x16 画最稳`)
      }
    } catch (e) {
      errors.push(`${rel}：PNG 解不开（${String(e.message).slice(0, 50)}）`)
    }
  }

  /* --- 语言条目：缺、空、值不对 --- */
  if (isJava) {
    const langDir = join(projDir, 'src/main/resources/assets', modId, 'lang')
    for (const [file, key, list] of [['zh_cn.json', 'block.', blocks], ['en_us.json', 'block.', blocks],
      ['zh_cn.json', 'item.', items], ['en_us.json', 'item.', items]]) {
      const f = join(langDir, file)
      if (!existsSync(f)) {
        if (list.length) errors.push(`缺语言文件 assets/${modId}/lang/${file}`)
        continue
      }
      stat.langs++
      let j = {}
      try { j = JSON.parse(await readFile(f, 'utf8')) } catch (e) {
        errors.push(`${file} 不是合法 JSON：${String(e.message).slice(0, 50)}`)
        continue
      }
      if (!j || typeof j !== 'object' || Array.isArray(j)) { errors.push(`${file} 的内容不是个对象`); continue }
      const miss = list.map((x) => key + modId + '.' + x.name).filter((k) => !(k in j))
      if (miss.length) warns.push(`${file} 缺 ${miss.length} 条名字（${miss.slice(0, 3).join(', ')}…）—— 游戏里会显示成乱码键名`)
      /* 有键但值是空的：游戏里显示空名字，比缺了还难查 */
      const empty = Object.entries(j).filter(([k, v]) => (k.startsWith('block.') || k.startsWith('item.')) && !String(v ?? '').trim())
      if (empty.length) warns.push(`${file} 里有 ${empty.length} 条名字是空的（第一个：${empty[0][0]}）—— 游戏里显示空名字`)
    }
  } else {
    const langDir = join(projDir, 'resource_pack/texts')
    for (const [file, want] of [['zh_CN.lang', '方块'], ['en_US.lang', 'block']]) {
      const f = join(langDir, file)
      if (!existsSync(f)) continue
      stat.langs++
      const txt = await readFile(f, 'utf8')
      const rows = txt.split('\n').map((l) => l.trim()).filter(Boolean)
      const badRows = rows.filter((l) => !l.includes('=') && !l.startsWith('#'))
      const emptyRows = rows.filter((l) => /=\s*$/.test(l))
      if (!/pack\.name/.test(txt)) warns.push(`${file} 里没有 pack.name（资源包在游戏里会显示成空名字）`)
      if (badRows.length) errors.push(`${file} 有 ${badRows.length} 行不是 key=value（第一行：${badRows[0].slice(0, 40)}）`)
      if (emptyRows.length) warns.push(`${file} 有 ${emptyRows.length} 条名字是空的（第一条：${emptyRows[0].slice(0, 40)}）`)
      if (blocks.length && want === '方块' && !/^tile\./m.test(txt)) {
        warns.push(`${file} 里没有 tile.* 条目 —— 方块的显示名没写进去`)
      }
    }
  }

  /* --- 基岩版：JSON 合法性 + 命名空间 + 贴图引用 + 登记表 --- */
  if (!isJava) {
    const resRoot = join(projDir, 'resource_pack')
    for (const f of await walk(projDir)) {
      if (!f.endsWith('.json')) continue
      stat.jsons++
      const rel = relative(projDir, f)
      let j
      try { j = JSON.parse(await readFile(f, 'utf8')) } catch (e) {
        errors.push(`${rel} 不是合法 JSON：${String(e.message).slice(0, 60)}`)
        continue
      }
      for (const id of collectIdentifiers(j)) {
        if (id.startsWith('texture:')) {
          const ref = id.slice(8)
          if (isVanillaTexture(ref)) continue
          const relPng = textureRefToFile(ref)
          if (!relPng) continue
          const found = realNameExists(resRoot, relPng)
          if (found === 'case') {
            errors.push(`${rel} 引用的 ${ref} 大小写和磁盘上的不一致 —— Windows 上没事，打包到别的系统就是断链`)
          } else if (!found) {
            /* 分不清是原版自带的图还是自己漏放的，所以只是警告 ——
               报成错误会推着用户去改一段本来正常的东西（铁律 2）。 */
            warns.push(`${rel} 引用 ${ref}：工程里没这张图。原版自带的就没事，是自己的图就得放进去`)
          }
          continue
        }
        const ns = id.split(':')[0]
        if (ns === 'minecraft') warns.push(`${rel}：identifier 用了 minecraft 命名空间（${id}）—— 覆盖原版内容会和别的包冲突`)
        else if (ns !== modId) errors.push(`${rel}：identifier 命名空间是 ${ns}，工程的是 ${modId} —— 游戏里认不出来`)
      }
    }

    /* 登记表 ↔ 实际文件，两个方向都要查 */
    for (const [reg, sub] of [['resource_pack/textures/terrain_texture.json', 'blocks'],
      ['resource_pack/textures/item_texture.json', 'items']]) {
      const f = join(projDir, reg)
      if (!existsSync(f)) continue
      let j
      try { j = JSON.parse(await readFile(f, 'utf8')) } catch { continue }
      const data = j.texture_data || {}
      const registered = new Set()
      for (const [name, entry] of Object.entries(data)) {
        /* entry 可能是字符串、可能是 {textures: ...}，也可能是 null/垃圾 ——
           直接读 .textures 遇到 null 会让整个体检崩掉（踩过）。 */
        let ref = null
        if (typeof entry === 'string') ref = entry
        else if (entry && typeof entry === 'object') ref = entry.textures
        if (ref === null || ref === undefined) continue
        /* textures 写成数组时要【每一个】都查，不能只看第一个 ——
           数组是基岩版合法写法，只看头一个等于漏检（踩过）。 */
        for (const one of (Array.isArray(ref) ? ref : [ref])) {
          if (typeof one !== 'string') continue
          registered.add(one.replace(/\.png$/, ''))
          /* 登记表是【用户自己写的】，它指向的图必须存在 —— 这是硬约束，算错误 */
          const found = realNameExists(join(projDir, 'resource_pack'), textureRefToFile(one))
          if (found === 'case') errors.push(`${reg} 登记的 ${name} 大小写和磁盘上不一致：${one}`)
          else if (!found) errors.push(`${reg} 登记的 ${name} 指向不存在的图：${one}`)
        }
      }
      /* 反向：图在，但登记表里没有 —— 游戏里永远用不上 */
      const dir = join(projDir, 'resource_pack/textures', sub)
      if (existsSync(dir)) {
        for (const fn of readdirSync(dir)) {
          if (!fn.endsWith('.png')) continue
          const ref = `textures/${sub}/${fn.replace(/\.png$/, '')}`
          if (!registered.has(ref)) warns.push(`textures/${sub}/${fn} 没在 ${basename(reg)} 里登记，游戏里用不上这张图`)
        }
      }
    }
  }

  /* --- 配方 / 掉落：引用的东西真的存在吗 --- */
  const known = knownItemIds(parts, modId)
  const checkRef = (id, where) => {
    const s = String(id || '').trim()
    if (!s) return
    const ns = s.split(':')[0]
    if (ns !== modId) return          /* 原版物品太多，不查 */
    if (!known.has(s)) errors.push(`${where} 引用了本工程里不存在的物品：${s}`)
  }
  for (const r of arr(parts, 'recipes')) {
    checkRef(r.output, `配方 ${r.name} 的产出`)
    for (const [k, v] of Object.entries(r.key || {})) checkRef(v, `配方 ${r.name} 的材料 ${k}`)
    if (r.ingredient) checkRef(r.ingredient, `配方 ${r.name} 的材料`)
  }
  for (const e of arr(parts, 'entities')) {
    checkRef(e.drop, `生物 ${e.name} 的掉落物`)
  }

  return { errors, warns, stat, parts }
}

/* ============================ 自动修 ============================ */

export async function fixProject(projDir, meta) {
  const fixed = []
  const skipped = []
  const modId = meta.modId
  const { parts } = await readParts(projDir)

  if (meta.target === 'java') {
    /* 1. 补客户端入口 —— 不修的话生物隐形、粒子不显示，还完全不报错 */
    const f = join(projDir, 'src/main/resources/fabric.mod.json')
    if (existsSync(f)) {
      try {
        const j = JSON.parse(await readFile(f, 'utf8'))
        j.entrypoints = j.entrypoints || {}
        const client = Array.isArray(j.entrypoints.client) ? j.entrypoints.client : []
        for (const cls of [`com.example.${modId}.ModEntitiesClient`, `com.example.${modId}.ModParticlesClient`]) {
          if (!client.includes(cls)) client.push(cls)
        }
        if (JSON.stringify(client) !== JSON.stringify(j.entrypoints.client || [])) {
          j.entrypoints.client = client
          await writeFile(f, JSON.stringify(j, null, 2) + '\n', 'utf8')
          fixed.push('fabric.mod.json 补上客户端入口：' + client.join(', '))
        }
      } catch { skipped.push('fabric.mod.json 不是合法 JSON，没动它 —— 先自己修好') }
    }

    /* 2. 补语言条目 —— 缺了游戏里显示成 item.modid.ruby 这种键名。
       注意：语言文件坏掉时【不能】当空文件重建，那会把用户手写的内容整份抹掉。 */
    const langDir = join(projDir, 'src/main/resources/assets', modId, 'lang')
    const jobs = [
      ['zh_cn.json', arr(parts, 'blocks').map((b) => ['block.' + modId + '.' + b.name, b.label])],
      ['en_us.json', arr(parts, 'blocks').map((b) => ['block.' + modId + '.' + b.name, b.name])],
      ['zh_cn.json', arr(parts, 'items').map((i) => ['item.' + modId + '.' + i.name, i.label])],
      ['en_us.json', arr(parts, 'items').map((i) => ['item.' + modId + '.' + i.name, i.name])],
    ]
    const added = {}
    for (const [file, pairs] of jobs) {
      if (!pairs.length) continue
      const p = join(langDir, file)
      let j = {}
      if (existsSync(p)) {
        const raw = await readFile(p, 'utf8')
        try {
          j = JSON.parse(raw)
          if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('不是对象')
        } catch {
          /* 早先这里是 `catch { j = {} }`，于是把「解析失败」当成「空文件」，
             重建之后用户手写的条目全没了（踩过）。现在宁可不修。 */
          skipped.push(`${file} 不是合法 JSON —— 没敢重建（重建会把你手写的条目抹掉），先自己修好`)
          continue
        }
      }
      let n = 0
      for (const [k, v] of pairs) {
        if (k in j) continue
        j[k] = v || k
        n++
      }
      if (n) {
        await mkdir(langDir, { recursive: true })
        await writeFile(p, JSON.stringify(j, null, 2) + '\n', 'utf8')
        added[file] = (added[file] || 0) + n
      }
    }
    for (const [file, n] of Object.entries(added)) fixed.push(`${file} 补了 ${n} 条名字`)
  } else {
    /* 基岩版：补 pack.name */
    for (const [file, name] of [['zh_CN.lang', meta.name], ['en_US.lang', meta.name]]) {
      const p = join(projDir, 'resource_pack/texts', file)
      if (!existsSync(p)) continue
      const txt = await readFile(p, 'utf8')
      if (/pack\.name/.test(txt)) continue
      await writeFile(p, `pack.name=${name}\npack.description=Made with DSH mc_mod\n` + txt, 'utf8')
      fixed.push(`${file} 补上 pack.name`)
    }
  }

  return { fixed, skipped }
}

/* ============================ 真编译 ============================ */

export function javacCheck(projDir) {
  const jdk = findJdk()
  if (!jdk) {
    return {
      ok: false,
      reason: '没装 JDK',
      hint: '跑 dsh-mc-mod/scripts/install-jdk.ps1 装上 JDK 就能真编译检查了。',
    }
  }
  const files = []
  const walkSync = (d) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walkSync(p)
      else if (e.name.endsWith('.java')) files.push(p)
    }
  }
  walkSync(join(projDir, 'src/main/java'))
  if (!files.length) return { ok: false, reason: '一个 .java 都没有' }

  const outDir = join(projDir, '.mcmod', 'javac-out')
  let raw = ''
  let crashed = ''
  try {
    /* -J-Duser.language=en：中文报错在 Windows 控制台会乱码，
       乱码之后"未结束的字符串文字"这种关键信息就白搭了 */
    raw = execFileSync(join(jdk, 'bin', 'javac.exe'),
      ['-J-Duser.language=en', '-J-Duser.country=US', '-d', outDir, '-encoding', 'UTF-8', ...files],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 })
  } catch (e) {
    /* javac 报了错 → 正常路径，stdout/stderr 里有诊断信息。
       但【进程没能正常结束】时（超时、被杀、启动失败）stdout/stderr 是空的 ——
       那种情况绝不能当成"编译干净"：那是最危险的假安全（踩过）。
       判据：既没有输出、又留下了信号或非零退出码。 */
    const out = String((e.stdout || '') + (e.stderr || ''))
    if (!out.trim() && (e.signal || e.killed === true || typeof e.status === 'number')) {
      crashed = String(e.signal || ('退出码 ' + e.status))
    } else {
      raw = out
    }
  }

  if (crashed && !raw.trim()) {
    return {
      ok: false,
      reason: `javac 没能跑完（${crashed}）—— 这次的编译结果不可信`,
      hint: '重试一次。工程特别大的话，光靠这个子工具编译确实会超时。',
    }
  }

  const lines = raw.split(/\r?\n/).filter((l) => /error:|错误:/.test(l))
  /* 没有 MC / Fabric 的库，这几类必然出现，算正常 */
  const EXPECTED = /package .* does not exist|cannot find symbol|does not exist|symbol:|找不到符号|程序包.*不存在/

  /* 还有一类连锁反应要单独处理：父类/接口找不到时，javac 会把那个文件里所有
     @Override 都报成 "method does not override or implement a method from a supertype"。
     但这【本身】也可能是真错误（方法名拼错、参数写错）。
     在没有 MC 库的环境里两者【无法区分】—— 所以不放进"真错误"，但也不假装没事，
     而是单独列出来说清楚"这条没验证"。 */
  const softFiles = new Set()
  for (const l of lines) {
    const m = /^(.+?\.java):\d+:\s*error:\s*(.*)$/.exec(l.trim())
    if (m && /cannot find symbol|does not exist|找不到符号|程序包/.test(m[2])) softFiles.add(m[1])
  }
  const real = []
  const unverified = []
  for (const l of lines) {
    if (EXPECTED.test(l)) continue
    const m = /^(.+?\.java):\d+:\s*error:/.exec(l.trim())
    if (m && softFiles.has(m[1]) && /does not override or implement/.test(l)) { unverified.push(l.trim()); continue }
    real.push(l)
  }

  return {
    ok: true,
    jdk: jdk.split(/[\\/]/).pop(),
    files: files.length,
    libErrors: lines.length - real.length - unverified.length,
    realErrors: real.length,
    unverified,
    detail: real.slice(0, 10).map((l) => l.trim()),
  }
}

/* ============================ 子工具本体 ============================ */

export default {
  key: 'verify',
  title: '工程体检 / 测试',
  summary: '体检工程：断掉的引用、坏贴图、缺条目、编译错',
  params: {
    op: 'run（默认体检）/ java（真编译）/ fix（自动修小问题）',
    dir: '可选：工程目录（默认当前工程）',
  },

  async run(ctx, args) {
    const a = args || {}
    const op = String(a.op || 'run').toLowerCase()
    const projDir = String(a.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道体检哪个工程', hint: '先 do:project op:create 建工程，或传 dir' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    if (op === 'java') {
      const r = javacCheck(projDir)
      if (!r.ok) return { ok: false, error: r.reason, hint: r.hint || '' }
      /* 注意 ok 恒为 true：ok=false 是"这次操作没干成"，
         而"编译发现了错误"是操作成功、结论是没通过 —— 两者不能混，
         混了模型就只看得到一行 error，看不到错误明细。 */
      const clean = r.realErrors === 0
      return {
        ok: true,
        pass: clean && !r.unverified.length,
        '编译的文件数': r.files,
        '缺 MC/Fabric 库（正常）': r.libErrors,
        '真错误': r.realErrors,
        detail: r.detail,
        '没法验证的 @Override': r.unverified.length ? r.unverified.slice(0, 5) : undefined,
        note: r.realErrors
          ? '这些不是缺库造成的，是真问题，必须改。'
          : (r.unverified.length
            ? `语法层面一条错都没有。但有 ${r.unverified.length} 处 @Override 没法验证 —— 缺 MC 库时 javac 分不清"父类不存在"和"方法名写错了"。这些方法名自己核对一遍。`
            : '没有 MC 库，所以"找不到符号"是正常的；除了那类以外一条错误都没有 —— 说明语法和协同都对。'),
        hint: r.realErrors ? '改完再跑一次 do:verify op:java。' : '',
      }
    }

    if (op === 'fix') {
      const { fixed, skipped } = await fixProject(projDir, meta)
      const after = await checkProject(projDir, meta)
      return {
        ok: true,
        fixed: fixed.length ? fixed : undefined,
        '没敢动的': skipped.length ? skipped : undefined,
        '剩余错误': after.errors.length,
        '剩余警告': after.warns.length,
        problems: after.errors.slice(0, 8),
        note: fixed.length
          ? '改完了，再跑一次 op:run 确认。'
          : (skipped.length ? '有能修的，但前提是文件本身没坏 —— 见上面。' : '没有能自动修的 —— 剩下的要么没问题，要么得手改。'),
      }
    }

    if (op === 'run' || op === 'check' || op === '') {
      const { errors, warns, stat, parts } = await checkProject(projDir, meta)
      const bits = []
      for (const part of ['blocks', 'items', 'entities', 'biomes', 'recipes', 'particles', 'effects', 'sounds']) {
        const list = arr(parts, part); if (list.length) bits.push(`${part} ${list.length}`)
      }
      return {
        ok: true,
        pass: errors.length === 0,
        project: meta.name,
        target: meta.target,
        mcVersion: meta.mcVersion,
        summary: bits.length ? bits.join(' · ') : '（工程是空的，只建了骨架）',
        files: `java ${stat.javaFiles} · png ${stat.pngs} · json ${stat.jsons}`,
        errors,
        warnings: warns,
        '错误数': errors.length,
        '警告数': warns.length,
        note: errors.length
          ? '错误必须修；能用 op:fix 的它会自己修。'
          : (warns.length ? '错误 0 个。警告不致命，但最好看一眼。' : '干净，可以打包了。'),
        hint: '想确认代码真能编译（字符检查看不出来的那些问题），用 do:verify op:java。',
      }
    }

    return {
      ok: false,
      error: '不认识的 op：' + op,
      known: ['run', 'java', 'fix'],
      hint: 'op=run 静态体检；op=java 真编译（要 JDK）；op=fix 自动修小毛病。',
    }
  },
}

export const __test = {
  classNameOf,
  packageOf,
  collectIdentifiers,
  textureRefToFile,
  isVanillaTexture,
  realNameExists,
  readParts,
  knownItemIds,
  checkProject,
  fixProject,
  VANILLA_TEX_PREFIX,
  PART_NAMES,
}
