/*
  compat —— 版本适配 / 模组适配（子工具 #19）
  ==========================================

  做模组最烦的两件事：
    1. 照教程写的代码，换个游戏版本就编译不过（API 搬家、方法改名）；
    2. 装到别人电脑上，依赖没声明对，游戏里模组不生效或者直接崩。

  这个子工具就干这两件事：

    versions  内置的"哪个版本配哪套依赖"表，以及各版本的 API 分界点。
    set       把工程的目标版本换掉 —— 不只是改版本号，还会把新旧写法
              （Identifier.of ←→ new Identifier）真的改写掉并保存。
    deps      看/改模组间的依赖声明（Java 是 fabric.mod.json 的 depends 等，
              基岩版是 manifest 的 dependencies）。
    check     拿 API 规则扫一遍工程里已经生成的代码，报出"这个写法在目标
              版本上不存在"，并给出改法。

  两条必须守住的底线（都踩过）：
    · 改写源码绝不能把能编译的代码改坏 —— 所以有词边界判断，
      而且只动代码区，不动注释和字符串里的文本。
    · 报告必须跟实际落盘一致 —— 所以 changed 一律由"改前 / 改后"对比产生，
      没改就不报，改不了就说清为什么。

  诚实说明：versions 表里的版本号是【内置参考值】，会随上游更新而过期。
  要拿真正的最新版，用 do:net op:fabric（联网查 Fabric 官方 meta）。
*/
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readMeta } from './project.js'
import { alignSourceCount } from '../apifix.js'

/* 版本数据（比较、档案表、API 规则）搬到了 ../versions.js —— 建工程的时候
   （templates.js）也要用同一张表，放这个文件里会绕成循环依赖。
   这里 import 进来自己用，再 export 出去给别的子工具和测试用。 */
import {
  cmpVersion, PROFILES, PROFILE_KEYS, resolveProfile, LOADERS, LOADER_KEYS,
  API_RULES, ruleApplies, DEP_KINDS, LOADER_LATEST,
} from '../versions.js'

export {
  cmpVersion, PROFILES, PROFILE_KEYS, resolveProfile, LOADERS, LOADER_KEYS,
  API_RULES, ruleApplies, DEP_KINDS, LOADER_LATEST,
}

/* ---------------- 扫源码 ---------------- */

async function walk(dir, ext, out = []) {
  if (!existsSync(dir)) return out
  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'build' || e.name === '.gradle') continue
      await walk(p, ext, out)
    } else if (e.name.endsWith(ext)) {
      out.push(p)
    }
  }
  return out
}

const lineAt = (src, idx) => src.slice(0, idx).split('\n').length

/** 扫一批 java 源码，返回不兼容清单 */
export function scanSources(files, mcVersion, readFn) {
  const hits = []
  for (const f of files) {
    const src = readFn(f)
    for (const rule of API_RULES) {
      if (ruleApplies(rule, mcVersion)) continue
      const re = new RegExp(rule.re.source, 'g')
      let m
      while ((m = re.exec(src))) {
        hits.push({
          rule: rule.id,
          file: f,
          line: lineAt(src, m.index),
          what: rule.what,
          how: rule.how,
          autofix: rule.autofix || '',
          excerpt: src.slice(m.index, m.index + 60).split('\n')[0],
        })
        if (hits.length > 200) return hits
      }
    }
  }
  return hits
}

/**
 * 可自动改写的两种：Identifier 的新旧写法互换。
 *
 * 真正的替换逻辑在 apifix.js —— 那里把关了词边界、代码区（字符串/文本块/注释）、
 * 以及"用户自己写的同名类不能碰"。这里只是给那两个方向起个短名字。
 */
export function autofixSource(src, fix) {
  if (fix !== 'to-ctor' && fix !== 'to-of') return { text: src, n: 0 }
  return alignSourceCount(src, fix === 'to-of' ? '1.21' : '1.20.1')
}

/* ---------------- 改工程里的版本号 ---------------- */

/**
 * 把 `key=...` 那一行换成新值，保留原来的缩进和等号两边写法。
 * 返回 {text, hit} —— hit=false 说明文件里根本没这个键（那就要报出来，
 * 不能默默什么都不做还说"改了"）。
 */
export function setProp(text, key, val) {
  const re = new RegExp('^([ \\t]*)' + key + '([ \\t]*)=([ \\t]*)(.*)$', 'm')
  if (!re.test(text)) return { text, hit: false }
  return {
    text: text.replace(re, (line, indent, ksp, eqsp) => `${indent}${key}${ksp}=${eqsp}${val}`),
    hit: true,
  }
}

/**
 * 把工程里所有跟版本有关的地方改到目标版本。
 *
 * 返回值里的 changes 是【改前改后对比出来的】，不是"我打算改什么"。
 * 早先是无条件 push 一行"改了四项"，于是文件里没这个键、或者键名被用户改过时，
 * 照样报"已改"，AI 转告用户"已经换到 1.20.1 了"，而工程其实是 1.21 的游戏版本
 * 配 1.20.1 的依赖 —— 必崩，还查不出原因（踩过）。
 *
 * 同样地，loom 的正则要同时认单引号和双引号，JavaVersion 要吃掉 VERSION_1_8
 * 这种老写法（`VERSION_\d+` 只吃数字段，会把它改成不存在的 VERSION_17_8）。
 */
export function retargetJavaFiles(files, p) {
  const out = { files: {}, changes: [], missed: [] }

  if (files['gradle.properties'] !== undefined) {
    const before = files['gradle.properties']
    let t = before
    const wanted = [
      ['minecraft_version', p.mcVersion],
      ['yarn_mappings', p.yarn],
      ['loader_version', p.loader],
      ['fabric_version', p.api],
    ]
    const done = []
    for (const [k, v] of wanted) {
      const r = setProp(t, k, v)
      if (r.text !== t) {
        /* 只有【真变了】才记 —— hit 只说明文件里有这个键，
           值本来就对的话报"改了"就是假消息（踩过）。 */
        done.push(k)
        t = r.text
      } else if (!r.hit) {
        out.missed.push(`gradle.properties 里没有 ${k} 这一行`)
      }
    }
    if (t !== before) {
      out.files['gradle.properties'] = t
      out.changes.push(`gradle.properties：改了 ${done.join(' / ')}`)
    }
  }

  if (files['build.gradle'] !== undefined) {
    const before = files['build.gradle']
    let t = before
    const notes = []
    /* 只换版本号那一段，别把整行重写 —— 有人把 id 和 version 写成两行，
       整行重写会把换行吃掉（排版变了虽然还能跑，但没必要动人家）。 */
    const loomAt = t.indexOf('fabric-loom')
    if (loomAt >= 0) {
      const after = t.slice(loomAt)
      const vm = /version\s+(['"])([^'"]*)\1/.exec(after)
      if (vm && vm[2] !== p.loom) {
        const quoteStart = loomAt + vm.index + vm[0].indexOf(vm[1]) + 1
        t = t.slice(0, quoteStart) + p.loom + t.slice(quoteStart + vm[2].length)
        notes.push(`loom ${p.loom}`)
      }
    } else {
      out.missed.push('build.gradle 里没找到 fabric-loom 插件那一行')
    }
    /* 把 VERSION_1_8 / VERSION_21 这类整个吃掉再写新的 —— 只替换数字段会得到
       VERSION_17_8 这种 Gradle 里根本不存在的枚举。 */
    const beforeJava = t
    t = t.replace(/JavaVersion\.VERSION_[0-9_]+/g, `JavaVersion.VERSION_${p.java}`)
    t = t.replace(/options\.release\s*=\s*\d+/, `options.release = ${p.java}`)
    if (t !== beforeJava) notes.push(`Java ${p.java}`)
    if (t !== before) {
      out.files['build.gradle'] = t
      out.changes.push('build.gradle：' + notes.join(' / '))
    }
  }

  /* 键名是【相对工程的路径】，不是文件名 —— 早先按 'fabric.mod.json' 找键，
     结果永远找不到，版本号改了但依赖声明没改，游戏里直接拒绝加载（踩过）。 */
  const fmjKey = Object.keys(files).find((k) => /fabric\.mod\.json$/.test(k))
  if (fmjKey) {
    let j = null
    try { j = JSON.parse(files[fmjKey]) } catch { j = null }
    if (!j) {
      out.missed.push(`${fmjKey} 不是合法 JSON，依赖声明没跟着改 —— 先把它修好`)
    } else if (!sectionOk(j.depends)) {
      out.missed.push(`${fmjKey} 的 depends 不是对象（现在是 ${JSON.stringify(j.depends)}），没敢动`)
    } else {
      const before = JSON.stringify(j)
      j.depends = j.depends || {}
      j.depends.minecraft = '~' + p.mcVersion
      j.depends.fabricloader = '>=' + p.loader
      j.depends.java = '>=' + p.java
      const after = JSON.stringify(j)
      if (after !== before) {
        out.files[fmjKey] = JSON.stringify(j, null, 2) + '\n'
        out.changes.push(`${fmjKey}：minecraft ~${p.mcVersion} / java >=${p.java}`)
      }
    }
  }

  for (const key of Object.keys(files)) {
    if (!/manifest\.json$/.test(key)) continue
    let j
    try { j = JSON.parse(files[key]) } catch { continue }
    if (!j.header) continue
    const seg = p.mcVersion.split('.').map((n) => parseInt(n, 10) || 0)
    while (seg.length < 3) seg.push(0)
    const want = seg.slice(0, 3)
    if (JSON.stringify(j.header.min_engine_version) === JSON.stringify(want)) continue
    j.header.min_engine_version = want
    out.files[key] = JSON.stringify(j, null, 2) + '\n'
    out.changes.push(`${key}：min_engine_version ${want.join('.')}`)
  }

  return out
}

/* ---------------- 依赖声明 ---------------- */

/** 依赖段必须是对象。是字符串/数字/数组的话写进去要么抛异常要么静默丢数据 */
export function sectionOk(v) {
  return v === undefined || (v !== null && typeof v === 'object' && !Array.isArray(v))
}

/** 找出第一个不是对象的依赖段（返回名字，没问题返回空串） */
export function badSection(modJson, kinds = DEP_KINDS) {
  for (const k of kinds) if (!sectionOk(modJson[k])) return k
  return ''
}

/** 校验一批依赖声明，返回错误说明（没问题返回空串） */
export function validateDeps(list, target) {
  if (!list.length) return ''
  for (const d of list) {
    if (!DEP_KINDS.includes(d.kind)) {
      return `kind 只能是 ${DEP_KINDS.join(' / ')}，写的是「${d.kind}」`
    }
    if (target === 'bedrock') {
      /* 基岩版的版本号要写全三段（1.11.0）—— 写 1.11 的话 manifest 里会变成
         [1,11]，那是非法版本，包加载不了。文案说的也是"三元组"，得对上。 */
      if (!d.remove && d.version && !/^\d+\.\d+\.\d+$/.test(d.version)) {
        return `基岩版的依赖版本要写全三段，比如 1.11.0（Java 那边才写 >=1.0.0）。收到的是「${d.version}」`
      }
    }
  }
  return ''
}

/** 改 fabric.mod.json 的依赖段；没提到的段原样保留 */
export function applyJavaDeps(modJson, list) {
  const j = JSON.parse(JSON.stringify(modJson))
  for (const d of list) {
    const kind = DEP_KINDS.includes(d.kind) ? d.kind : 'depends'
    j[kind] = j[kind] || {}
    if (d.remove) delete j[kind][d.id]
    else j[kind][d.id] = d.version || '*'
  }
  return j
}

/** 基岩版的依赖写在 manifest 的 dependencies 里，格式和 Java 完全不同 */
export function applyBedrockDeps(manifest, list) {
  const j = JSON.parse(JSON.stringify(manifest))
  j.dependencies = Array.isArray(j.dependencies) ? j.dependencies : []
  for (const d of list) {
    if (d.remove) {
      j.dependencies = j.dependencies.filter((x) => (x.module_name || x.uuid) !== d.id)
      continue
    }
    const ver = String(d.version || '1.0.0').split('.').map((n) => parseInt(n, 10) || 0)
    const hit = j.dependencies.find((x) => (x.module_name || x.uuid) === d.id)
    if (hit) hit.version = ver
    else j.dependencies.push({ module_name: d.id, version: ver })
  }
  return j
}

/**
 * 把 args 里的 dep 参数解析成列表：dep 可以是字符串，也可以是数组。
 * args.kind 是给字符串写法用的默认段名 —— 早先字符串写法硬写 depends，
 * 于是 params 里承诺的 kind 参数被静默忽略（踩过）。
 */
export function parseDeps(args) {
  const raw = args.dep === undefined ? args.deps : args.dep
  const arr = Array.isArray(raw) ? raw : (raw !== undefined && raw !== null ? [raw] : [])
  const defKind = String(args.kind || 'depends').trim().toLowerCase() || 'depends'
  return arr.map((d) => {
    if (typeof d === 'string') {
      /* 只在【最后一个】@ 且不在开头时切分 —— 基岩版的模块名本身就带 @，
         "@minecraft/server@1.11.0" 按第一个 @ 切会切出空 id（踩过）。 */
      const at = d.lastIndexOf('@')
      const id = at > 0 ? d.slice(0, at) : d
      const version = at > 0 ? d.slice(at + 1) : ''
      return { id: id.trim(), version: version.trim(), kind: defKind, remove: false }
    }
    if (!d || typeof d !== 'object') return { id: '', version: '', kind: defKind, remove: false }
    return {
      id: String(d.id || d.name || '').trim(),
      version: String(d.version || '').trim(),
      kind: String(d.kind || defKind).trim().toLowerCase(),
      remove: !!d.remove,
    }
  }).filter((d) => d.id)
}

/** dep 参数到底给没给（给了却解析不出东西要报错，不能悄悄变成"列出来看看"） */
function depGiven(args) {
  const raw = args.dep === undefined ? args.deps : args.dep
  if (raw === undefined || raw === null) return false
  if (Array.isArray(raw)) return raw.length > 0
  /* 给了个对象就算给了 —— 即使是 {} 或者 {id:''}：用户确实想加依赖，
     只是写错了，这时候要报错，不能当"没给"去列一遍依赖（踩过）。 */
  if (typeof raw === 'object') return true
  return String(raw).trim() !== ''
}

/* ============================ 子工具本体 ============================ */

export default {
  key: 'compat',
  title: '版本适配 / 模组适配',
  summary: '改目标游戏版本、查 API 不兼容、声明模组依赖',
  params: {
    op: 'versions / set / check / deps',
    mcVersion: 'set 用：目标游戏版本，如 1.20.1 / 1.21 / 1.21.4',
    loader: 'set 用：fabric / quilt（forge/neoforge 只能出提示）',
    dep: 'deps 用：依赖，写 "模组id@版本" 或 {id,version,kind,remove}',
    kind: 'deps 用：depends / recommends / suggests / conflicts / breaks',
    dir: '可选：工程目录（默认当前工程）',
  },

  async run(ctx, args) {
    const a = args || {}
    const op = String(a.op || 'check').toLowerCase()

    /* ---------------- 版本表 ---------------- */
    if (op === 'versions' || op === 'list') {
      return {
        ok: true,
        known: PROFILE_KEYS.map((k) => {
          const p = PROFILES[k]
          return `${k.padEnd(8)} yarn ${p.yarn.padEnd(18)} api ${p.api.padEnd(20)} loader ${p.loader.padEnd(9)} Java ${p.java}`
        }),
        loaders: LOADER_KEYS.map((k) => `${k.padEnd(9)} ${LOADERS[k].full ? '可以做' : '★不能直接做'} —— ${LOADERS[k].note}`),
        apiBreaks: [
          '1.21    Identifier.of(...) 取代 new Identifier(...)',
          '1.21.2  物品注册必须带 registryKey',
          '1.20.6  Java 从 17 提到 21（gradle 会直接报 class file 版本错）',
          '1.20.5  属性变成注册项 RegistryEntry<EntityAttribute>',
          '1.19.3  Registries 包从 net.minecraft.util.registry 搬到 net.minecraft.registry',
        ],
        note: '这些版本号是内置参考值，会过期。要最新的就用 do:net op:fabric 联网查。',
        hint: '换版本：do:compat op:set mcVersion:1.20.1 —— 会自动改写 Identifier 的新旧写法。',
      }
    }

    const projDir = String(a.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道对哪个工程做适配', hint: '先 do:project op:create 建工程，或传 dir' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const cur = String(meta.mcVersion || '1.21')
    const pkgPath = join(projDir, 'src/main/java')

    /* ---------------- 依赖声明 ---------------- */
    if (op === 'deps') {
      const list = parseDeps(a)

      if (!list.length) {
        if (depGiven(a)) {
          return {
            ok: false,
            error: '没看懂要加哪个依赖',
            hint: 'dep 写成 "模组id@版本"（比如 modmenu@>=7.0.0），或者 {id:"模组id", version:"1.0.0", kind:"depends"}。',
          }
        }
        /* 没给 dep = 列出当前的 */
        if (meta.target === 'java') {
          const f = join(projDir, 'src/main/resources/fabric.mod.json')
          if (!existsSync(f)) return { ok: false, error: '找不到 fabric.mod.json' }
          let mod
          try { mod = JSON.parse(await readFile(f, 'utf8')) } catch (e) {
            return { ok: false, error: 'fabric.mod.json 坏了，先修它：' + String(e.message).slice(0, 80) }
          }
          const lines = []
          for (const k of DEP_KINDS) {
            const o = mod[k]
            if (o && typeof o === 'object' && !Array.isArray(o)) {
              for (const [id, v] of Object.entries(o)) lines.push(`${k.padEnd(10)} ${id}  ${v}`)
            }
          }
          const bad = badSection(mod)
          return {
            ok: true,
            count: lines.length,
            deps: lines,
            notes: bad ? [`★ ${bad} 不是对象，写依赖前先修它`] : undefined,
            note: '加依赖：dep:"模组id@>=1.0.0"；删依赖：dep:{id:"模组id",remove:true}。',
          }
        }
        const f = join(projDir, 'behavior_pack/manifest.json')
        if (!existsSync(f)) return { ok: false, error: '找不到 behavior_pack/manifest.json' }
        let man
        try { man = JSON.parse(await readFile(f, 'utf8')) } catch (e) {
          return { ok: false, error: 'manifest.json 坏了：' + String(e.message).slice(0, 80) }
        }
        const deps = (man.dependencies || []).map((d) => `${d.module_name || d.uuid}  ${JSON.stringify(d.version)}`)
        return { ok: true, count: deps.length, deps, note: '基岩版的依赖必须是【另一个包已经装好】的模块名或 UUID。' }
      }

      /* 先把参数校验干净再动文件 —— 报错时文件必须是原样 */
      const bad = validateDeps(list, meta.target)
      if (bad) return { ok: false, error: bad, known: DEP_KINDS }

      if (meta.target === 'java') {
        const f = join(projDir, 'src/main/resources/fabric.mod.json')
        if (!existsSync(f)) return { ok: false, error: '找不到 fabric.mod.json' }
        let mod
        try { mod = JSON.parse(await readFile(f, 'utf8')) } catch (e) {
          return { ok: false, error: 'fabric.mod.json 坏了，先修它：' + String(e.message).slice(0, 80) }
        }
        const badSec = badSection(mod)
        if (badSec) {
          return {
            ok: false,
            error: `fabric.mod.json 的 ${badSec} 不是对象（是 ${JSON.stringify(mod[badSec])}），写进去会出错`,
            hint: `把它改成 {} 再加依赖。`,
          }
        }
        const before = JSON.stringify(mod)
        const next = applyJavaDeps(mod, list)
        /* "删一个本来就不在的" 也要说一声 —— 这个提示不能只放在"有变化"的分支里，
           否则最常见的场景（删错了名字）反而什么都看不到（踩过）。 */
        const gone = list.filter((d) => d.remove && !((mod[d.kind] || {})[d.id]))
        const goneNote = gone.length ? ['这些本来就不在，删了等于没删：' + gone.map((d) => d.id).join(', ')] : []
        if (JSON.stringify(next) === before) {
          return {
            ok: true,
            changed: undefined,
            notes: goneNote.length ? goneNote : undefined,
            note: '本来就是这样的，没有改动。',
          }
        }
        await writeFile(f, JSON.stringify(next, null, 2) + '\n', 'utf8')
        return {
          ok: true,
          changed: list.map((d) => `${d.remove ? '删掉' : '写入'} ${d.kind} ${d.id} ${d.version || '*'}`),
          notes: goneNote.length ? goneNote : undefined,
          file: 'src/main/resources/fabric.mod.json',
          note: '依赖只影响加载顺序和"缺了会怎样"，不会自动帮你下载模组。',
        }
      }

      const f = join(projDir, 'behavior_pack/manifest.json')
      if (!existsSync(f)) return { ok: false, error: '找不到 behavior_pack/manifest.json' }
      let man
      try { man = JSON.parse(await readFile(f, 'utf8')) } catch (e) {
        return { ok: false, error: 'manifest.json 坏了：' + String(e.message).slice(0, 80) }
      }
      const before = JSON.stringify(man)
      const next = applyBedrockDeps(man, list)
      const had = new Set((man.dependencies || []).map((x) => x.module_name || x.uuid))
      const gone = list.filter((d) => d.remove && !had.has(d.id))
      const goneNote = gone.length ? ['这些本来就不在，删了等于没删：' + gone.map((d) => d.id).join(', ')] : []
      if (JSON.stringify(next) === before) {
        return {
          ok: true,
          changed: undefined,
          notes: goneNote.length ? goneNote : undefined,
          note: '本来就是这样的，没有改动。',
        }
      }
      await writeFile(f, JSON.stringify(next, null, 2) + '\n', 'utf8')
      return {
        ok: true,
        changed: list.map((d) => `${d.remove ? '删掉' : '写入'} ${d.id} ${d.version || '1.0.0'}`),
        notes: goneNote.length ? goneNote : undefined,
        file: 'behavior_pack/manifest.json',
        note: '想依赖原版模块（比如脚本 API）就写 @minecraft/server。',
      }
    }

    /* ---------------- 换目标版本 ---------------- */
    if (op === 'set') {
      const v = String(a.mcVersion || '').trim()
      if (!/^\d+\.\d+(\.\d+)?$/.test(v)) {
        return { ok: false, error: 'mcVersion 要写成 1.21 或 1.21.4 这样', known: PROFILE_KEYS }
      }
      /* 加载器先校验 —— 早先是改完文件才校验，报错时工程已经被改了一半，
         mcmod.json 还停在老版本，之后所有 check 都按错的版本判断（踩过）。 */
      const loader = a.loader ? String(a.loader).toLowerCase().trim() : ''
      if (loader && !LOADER_KEYS.includes(loader)) {
        return { ok: false, error: '不认识的加载器：' + loader, known: LOADER_KEYS }
      }
      /* 加载器是 Java 版的概念，附加包里没有这回事 —— 收了只会往 mcmod.json 里
         塞一个没用的字段，还会让返回里冒出一堆 Java 术语，看着像回事其实误导。 */
      if (loader && meta.target !== 'java') {
        return {
          ok: false,
          error: 'loader 是 Java 版才有的东西，基岩版附加包没有加载器这个概念',
          hint: '基岩版换目标版本直接 op:set mcVersion:1.21 就行。',
        }
      }

      const p = resolveProfile(v)

      /* 收集要改的文件内容 */
      const wanted = meta.target === 'java'
        ? ['gradle.properties', 'build.gradle', 'src/main/resources/fabric.mod.json']
        : ['behavior_pack/manifest.json', 'resource_pack/manifest.json']
      const files = {}
      for (const rel of wanted) {
        const f = join(projDir, rel)
        if (existsSync(f)) files[rel] = await readFile(f, 'utf8')
      }

      const res = retargetJavaFiles(files, p)
      for (const [rel, text] of Object.entries(res.files)) {
        await writeFile(join(projDir, rel), text, 'utf8')
      }

      /* 真正有价值的一步：把新旧 Identifier 写法改写掉。
         不这么做的话用户换完版本号照样编译不过，还得自己一个个改。 */
      const fixed = []
      if (meta.target === 'java') {
        for (const f of await walk(pkgPath, '.java')) {
          const src = await readFile(f, 'utf8')
          const r = autofixSource(src, cmpVersion(v, '1.21') >= 0 ? 'to-of' : 'to-ctor')
          if (r.n > 0 && r.text !== src) {
            await writeFile(f, r.text, 'utf8')
            fixed.push(`${relative(projDir, f)} (${r.n} 处)`)
          }
        }
      }

      /* 版本记进 meta，别的子工具读的就是这个 */
      const metaBefore = JSON.stringify(meta)
      const loaderChanged = !!loader && loader !== meta.loader
      meta.mcVersion = v
      if (loader) meta.loader = loader
      if (JSON.stringify(meta) !== metaBefore) {
        await writeFile(join(projDir, 'mcmod.json'), JSON.stringify(meta, null, 2), 'utf8')
      }

      const notes = []
      if (!p.exact) notes.push(`版本表里没有 ${v}，依赖版本是照 ${p.basedOn} 猜的 —— 建议 do:net op:update 联网校准。`)
      for (const m of res.missed) notes.push('★ ' + m)
      if (loaderChanged) notes.push(`加载器记成了 ${loader}。`)
      if (loader && loader !== 'fabric' && LOADERS[loader].full) {
        /* 说 full 只是说"能做"，不是"已经做了"—— build.gradle 还是 Fabric 那套 */
        notes.push(`★ 但构建脚本还是 Fabric 的写法（id 'fabric-loom'）—— 真要生成 ${LOADERS[loader].label} 工程得手改 build.gradle。`)
      }
      if (loader && !LOADERS[loader].full) {
        notes.push(`★ ${LOADERS[loader].label} 本工具不能直接生成：${LOADERS[loader].note}。现在工程还是 Fabric 的写法。`)
      }
      const nothing = !res.changes.length && !fixed.length && !loaderChanged

      return {
        ok: true,
        mcVersion: v,
        changed: res.changes.length ? res.changes : undefined,
        apiRewrites: fixed.length ? fixed : undefined,
        /* Java 专属的概念只在 Java 工程里给 —— 基岩版返回 yarn/fabric-api 是误导 */
        ...(meta.target === 'java' ? { 'Java 版本': p.java, yarn: p.yarn, 'fabric-api': p.api } : {}),
        notes: notes.length ? notes : undefined,
        note: nothing
          ? '已经就是这个版本了，没有需要改的地方。'
          : '改完了。跑 do:verify op:run 复查一遍，再编译。',
      }
    }

    /* ---------------- 扫不兼容 ---------------- */
    if (op === 'check') {
      const v = String(a.mcVersion || cur).trim()
      const hits = []

      if (meta.target === 'java') {
        const srcs = await walk(pkgPath, '.java')
        const { readFileSync } = await import('node:fs')
        for (const h of scanSources(srcs, v, (f) => readFileSync(f, 'utf8'))) {
          hits.push(`${relative(projDir, h.file)}:${h.line}  ${h.what}`)
        }
      } else {
        /* 基岩版：查两个 manifest 的 min_engine_version 对不对得上 */
        for (const rel of ['behavior_pack/manifest.json', 'resource_pack/manifest.json']) {
          const f = join(projDir, rel)
          if (!existsSync(f)) { hits.push(`${rel} 不存在`); continue }
          try {
            const j = JSON.parse(await readFile(f, 'utf8'))
            const me = (j.header?.min_engine_version || []).join('.')
            if (!me) hits.push(`${rel} 没写 min_engine_version`)
            else if (cmpVersion(me, v) > 0) hits.push(`${rel} min_engine_version=${me} 比目标 ${v} 还新，装不进旧版游戏`)
          } catch (e) {
            hits.push(`${rel} 不是合法 JSON：${String(e.message).slice(0, 60)}`)
          }
        }
      }

      const how = []
      for (const r of API_RULES) {
        if (ruleApplies(r, v)) continue
        if (!hits.some((h) => h.includes(r.what))) continue
        how.push(`${r.what} → ${r.how}${r.autofix ? '（可自动改）' : '（★要手改）'}`)
      }

      return {
        ok: true,
        target: meta.target,
        mcVersion: v,
        asked: a.mcVersion ? v : `${v}（工程当前版本）`,
        problems: hits,
        count: hits.length,
        fixes: how,
        note: hits.length
          ? (how.some((h) => h.includes('可自动改')) ? 'do:compat op:set mcVersion:' + v + ' 会自动改写能改的那些。' : '这些都要手改。')
          : `干净：没发现 ${v} 上不存在的写法。`,
      }
    }

    return {
      ok: false,
      error: '不认识的 op：' + op,
      known: ['versions', 'set', 'check', 'deps'],
      hint: 'op=versions 看版本表；op=set 换版本；op=check 只查不改；op=deps 管依赖声明。',
    }
  },
}

export const __test = {
  cmpVersion,
  resolveProfile,
  ruleApplies,
  scanSources,
  autofixSource,
  retargetJavaFiles,
  setProp,
  sectionOk,
  badSection,
  validateDeps,
  applyJavaDeps,
  applyBedrockDeps,
  parseDeps,
  PROFILES,
  PROFILE_KEYS,
  API_RULES,
  LOADERS,
  LOADER_KEYS,
  DEP_KINDS,
}
