/*
  project —— 模组工程管理（子工具 #1，用户清单里的"主体工具"那一层）
  ==================================================================

  一个模组 = 一个目录。这里只管"工程"这件事：建、列、查。
  具体往里塞方块/生物/群系，是其他子工具的活。

  两种目标共用一套目录约定，但内容完全不同：

    java  ←→  Fabric 工程（gradle 构建，产物是 jar，丢进 .minecraft/mods）
    bedrock ←→ 附加包（行为包 + 资源包纯 JSON，产物是 .mcaddon，免编译）

  为什么 Java 版先押 Fabric 而不是 Forge/NeoForge：
    模板最小、构建最快、Java 21 支持最干净。加载器做成参数，
    以后要加 NeoForge 只是多一个 templates 分支，不动上层。
*/
import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { PROJECTS_DIR, projectPath, safeProjectName, normalizeTarget } from '../paths.js'
import { javaSkeleton, bedrockSkeleton } from '../templates.js'
import { resolveProfile, LOADERS, LOADER_KEYS } from '../versions.js'

const META = 'mcmod.json'

/**
 * 推一个合法的模组 id 出来。
 * 坑：工程名常常是中文（"测试模组"），直接过滤非法字符会得到一串下划线 ——
 * 那种 id 塞进 fabric.mod.json 和 Java 包名里既难看又容易出问题。
 * 所以推不出字母时，退回 "mod_" + 名字的短哈希：合法、稳定、同一个名字每次都一样。
 */
function makeModId(explicit, name) {
  const clean = (v) => String(v || '').toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .replace(/^(\d)/, 'm$1')

  const fromExplicit = clean(explicit)
  if (fromExplicit && /[a-z]/.test(fromExplicit)) return fromExplicit

  const fromName = clean(name)
  if (fromName && /[a-z]/.test(fromName)) return fromName

  const h = createHash('sha1').update(String(name || 'mod')).digest('hex').slice(0, 8)
  return 'mod_' + h
}

export async function readMeta(dir) {
  try { return JSON.parse(await readFile(join(dir, META), 'utf8')) } catch { return null }
}

/**
 * 往工程里存一份"内容清单"。
 *
 * 为什么不是往 Java 文件里追加字符串：追加不可靠（重复、顺序乱、格式漂），
 * 而"数据 + 重新渲染"是幂等的 —— 每次改完把整个文件重写一遍，
 * 结果只取决于清单，跟改了几次无关。
 */
export async function readPart(dir, part, fallback) {
  try { return JSON.parse(await readFile(join(dir, '.mcmod', part + '.json'), 'utf8')) } catch { return fallback }
}

export async function writePart(dir, part, data) {
  const f = join(dir, '.mcmod', part + '.json')
  await mkdir(join(dir, '.mcmod'), { recursive: true })
  await writeFile(f, JSON.stringify(data, null, 2), 'utf8')
  return f
}

async function countFiles(dir, depth = 0) {
  if (depth > 6) return { files: 0, bytes: 0 }
  let files = 0, bytes = 0
  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return { files, bytes } }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const sub = await countFiles(p, depth + 1)
      files += sub.files; bytes += sub.bytes
    } else {
      files++
      try { bytes += (await stat(p)).size } catch { /* ignore */ }
    }
  }
  return { files, bytes }
}

/** 把工程里生成了什么汇总一下 —— 模型和人都靠这个看进度 */
async function summarize(dir) {
  const meta = await readMeta(dir)
  const counts = {}
  const buckets = [
    ['blocks', 'blocks'], ['items', 'items'], ['entities', 'entities'],
    ['biomes', 'biomes'], ['recipes', 'recipes'], ['particles', 'particles'],
    ['effects', 'effects'], ['sounds', 'sounds'], ['textures', 'textures'],
    ['structures', 'structures'],
  ]
  for (const [label, sub] of buckets) {
    for (const base of ['behavior_pack', 'resource_pack', 'src/main/resources']) {
      const p = join(dir, base, sub)
      if (!existsSync(p)) continue
      try {
        const n = (await readdir(p)).filter((f) => !f.startsWith('.')).length
        if (n) counts[label] = (counts[label] || 0) + n
      } catch { /* ignore */ }
    }
  }
  return { meta, counts }
}

export default {
  key: 'project',
  title: '模组工程',
  summary: '建/列/查模组工程（target=java 或 bedrock）',
  params: {
    op: 'create / list / info',
    loader: 'create 用：fabric / quilt（forge/neoforge 只警告不生成）',
    name: '工程名（create 必填）',
    target: 'java 或 bedrock（create 必填）',
    mcVersion: '目标游戏版本，默认 1.21',
    modId: '模组 id（小写字母数字下划线，默认由工程名推导）',
  },

  async run(ctx, args) {
    const op = String(args.op || '').toLowerCase().trim()

    /* ---------------- 建工程 ---------------- */
    if (op === 'create') {
      const name = safeProjectName(args.name)
      if (!name) return { ok: false, error: '工程名不合法（不能为空，也不能带 \\ / : * ? " < > |）' }
      const target = normalizeTarget(args.target)
      if (!target) return { ok: false, error: 'target 只能是 java 或 bedrock' }

      const dir = projectPath(name)
      if (existsSync(dir)) {
        const meta = await readMeta(dir)
        return {
          ok: false,
          error: `工程「${name}」已经存在了`,
          hint: meta ? `它是个 ${meta.target} 工程，直接往里加东西就行` : '目录在但是没元数据，可能不是本工具建的',
          dir,
        }
      }

      const mcVersion = String(args.mcVersion || '1.21').trim()
      const modId = makeModId(args.modId, name)
      /* target:neoforge 会被 normalizeTarget 收成 'java' —— 那样用户以为自己
         建了 NeoForge 工程，其实拿到的是 Fabric 的。所以加载器要单独收，
         并且不支持的必须当场说清楚。 */
      const loader = target === 'java' ? String(args.loader || 'fabric').toLowerCase().trim() : ''
      if (loader && !LOADER_KEYS.includes(loader)) {
        return { ok: false, error: '不认识的加载器：' + loader, known: LOADER_KEYS }
      }
      const meta = {
        name, modId, target, mcVersion,
        loader,
        createdAt: new Date().toISOString(),
        packs: target === 'bedrock' ? { behavior: randomUUID(), resource: randomUUID() } : {},
      }

      await mkdir(dir, { recursive: true })
      const made = target === 'java'
        ? await javaSkeleton(dir, meta)
        : await bedrockSkeleton(dir, meta)
      await writeFile(join(dir, META), JSON.stringify(meta, null, 2), 'utf8')

      const prof = resolveProfile(mcVersion)
      const notes = []
      if (target === 'java' && !prof.exact) {
        notes.push(`版本表里没有 ${mcVersion}，依赖版本是按 ${prof.basedOn} 猜的 —— 建议建完跑 do:net op:update 联网校准。`)
      }
      if (loader && !LOADERS[loader]?.full) {
        notes.push(`★ ${LOADERS[loader].label} 本工具不能直接生成：${LOADERS[loader].note}。工程现在还是 Fabric 的写法。`)
      }

      return {
        ok: true,
        dir,
        target,
        mcVersion,
        modId,
        '依赖版本': target === 'java'
          ? `yarn ${prof.yarn} · loader ${prof.loader} · fabric-api ${prof.api} · Java ${prof.java}`
          : undefined,
        files: made,
        notes: notes.length ? notes : undefined,
        note: target === 'java'
          ? 'Fabric 工程骨架已就位，里面带了 build.ps1（一键编译）和「怎么编译.md」。加完东西用 do:verify op:run 体检。'
          : '附加包骨架已就位（行为包 + 资源包），带了「打包.ps1」打 .mcaddon。加完东西用 do:verify op:run 体检。',
        hint: target === 'java'
          ? '机器上没有 gradle 的话，先跑 dsh-mc-mod/scripts/install-gradle.ps1 装一个，build.ps1 会自动找到它。'
          : '',
      }
    }

    /* ---------------- 列出所有工程 ---------------- */
    if (op === 'list' || op === '') {
      if (!existsSync(PROJECTS_DIR)) return { ok: true, root: PROJECTS_DIR, projects: [], note: '还没有任何工程，先用 op=create 建一个' }
      const names = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
        .filter((e) => e.isDirectory()).map((e) => e.name)
      const projects = []
      for (const n of names) {
        const d = join(PROJECTS_DIR, n)
        const meta = await readMeta(d)
        projects.push({
          name: n,
          target: meta ? meta.target : '?',
          modId: meta ? meta.modId : '',
          mcVersion: meta ? meta.mcVersion : '',
          dir: d,
        })
      }
      return { ok: true, root: PROJECTS_DIR, count: projects.length, projects }
    }

    /* ---------------- 看一个工程 ---------------- */
    if (op === 'info') {
      const dir = args.name ? projectPath(args.name) : ''
      if (!dir || !existsSync(dir)) return { ok: false, error: '没找到工程：' + String(args.name || '(没给 name)') }
      const { meta, counts } = await summarize(dir)
      const size = await countFiles(dir)
      return {
        ok: true,
        dir,
        meta,
        contents: counts,
        files: size.files,
        kb: Math.round(size.bytes / 1024),
        empty: Object.keys(counts).length === 0,
        hint: Object.keys(counts).length === 0
          ? '工程还是空的。用 block / item / entity 这些子工具往里加东西。'
          : '用 do:verify op:run 可以体检一遍，看引用有没有断。',
      }
    }

    return {
      ok: false,
      error: '不认识的 op：' + op,
      known: ['create', 'list', 'info'],
      hint: 'op=create 要带 name 和 target；op=list 不用参数；op=info 要带 name。',
    }
  },
}
