/*
  net —— 联网接口（子工具 #21）
  ============================

  为什么需要联网：compat 里那张版本表是【死的】，写下来那天就开始过期。
  真正靠谱的来源是各家官方的接口：

    Fabric  meta     loader / yarn 的权威版本列表
    Modrinth         fabric-api 这类模组的最新版（它有公开 API，不用 key）
    Mojang  piston   游戏版本清单（最新的正式版是哪个）

  所以这里的 update 会拿真实的接口结果去改工程的 gradle.properties，
  而不是拿内置表猜。

  另一件事：素材。fetch 能把一个图片/音效下载到工程里 ——
  比如从网上找一张 16x16 的材质，下下来直接当物品贴图用。

  断网时不会崩：每个 op 都会给"网络不通"这种明确的结论，
  并告诉模型改用 compat 的内置表。
*/
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, basename, dirname, normalize } from 'node:path'
import { readMeta } from './project.js'
import { resolveProfile } from './compat.js'
import { isPng } from '../png.js'

const UA = 'dsh-mc-mod/0.1.0 (Minecraft mod workbench)'
const TIMEOUT = 9000
const MAX_DOWNLOAD = 8 * 1024 * 1024

/**
 * 探测通不通用的地址。
 * 注意要填【真实存在的端点】，不能填 API 的根路径 ——
 * meta.fabricmc.net/v2 和 api.modrinth.com/v2 这两个根路径本身返回 404，
 * 拿它们探测会把"网是通的"误判成"被拒绝了"（踩过）。
 */
export const SOURCES = {
  'Fabric meta': 'https://meta.fabricmc.net/v2/versions/game',
  Modrinth: 'https://api.modrinth.com/v2/tag/loader',
  'Mojang 版本清单': 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
}

/** 带超时的 GET —— 不加超时的话断网时会一直挂着，模型那边看着就像卡死了 */
export async function getJson(url, timeoutMs = TIMEOUT) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const text = await r.text()
    try {
      return JSON.parse(text)
    } catch {
      /* 被限流或被打到 CDN 时返回的是 HTML，直接把 "Unexpected token '<'" 抛给
         用户等于没说。给一句能看懂的。 */
      throw new Error('返回的不是 JSON（前 40 字：' + text.slice(0, 40).replace(/\s+/g, ' ') + '）')
    }
  } finally {
    clearTimeout(t)
  }
}

export function friendlyNetError(e) {
  const m = String((e && e.message) || e)
  if (/abort/i.test(m)) return '超时（网络慢或者被墙）'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return '域名解析不了 —— 大概没联网'
  if (/ECONNREFUSED|ECONNRESET|fetch failed/i.test(m)) return '连不上 —— 大概没联网或者被挡了'
  if (/HTTP 4\d\d/.test(m)) return '对方拒绝了（' + m + '）'
  if (/不是 JSON/.test(m)) return '对方返回的不是 JSON —— 多半被限流或者被拦截了（' + m.slice(0, 80) + '）'
  return m.slice(0, 120)
}

/* ---------------- Fabric / Modrinth 查询 ---------------- */

/** 查某个游戏版本下所有 Fabric loader 版本，最新的排前面 */
export async function fabricLoaders(mc) {
  const j = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`)
  return (Array.isArray(j) ? j : []).map((x) => ({
    version: x.loader?.version || '',
    stable: !!x.loader?.stable,
  })).filter((x) => x.version)
}

/** 查某个游戏版本的 yarn 映射版本（形如 1.21+build.9） */
export async function fabricYarn(mc) {
  const j = await getJson(`https://meta.fabricmc.net/v2/versions/yarn/${encodeURIComponent(mc)}`)
  return (Array.isArray(j) ? j : []).map((x) => x.version).filter(Boolean)
}

/** 查 Modrinth 上某个模组在指定游戏版本 / 加载器下的最新版 */
export async function modrinthVersion(slug, mc, loader = 'fabric') {
  const url = `https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version` +
    `?game_versions=${encodeURIComponent(JSON.stringify([mc]))}` +
    `&loaders=${encodeURIComponent(JSON.stringify([loader]))}`
  const j = await getJson(url)
  const list = Array.isArray(j) ? j : []
  if (!list.length) return null
  const v = list[0]
  return { version: v.version_number || '', name: v.name || '', downloads: v.downloads || 0 }
}

/* ---------------- gradle.properties 的读写 ---------------- */

/**
 * 从 gradle.properties 的文本里读一个键。
 * 必须认「key = value」这种带空格的写法 —— 用 ^key= 去配的话读不到，
 * 于是报告说"从 (空) 更新到 x"，而文件一个字节都没动（踩过）。
 */
export function readGradleProp(text, key) {
  const m = new RegExp('^[ \\t]*' + key + '[ \\t]*=[ \\t]*(.*)$', 'm').exec(text)
  return m ? m[1].trim() : ''
}

/** 改一个键，保留原来的缩进和等号两边写法；文件里没这个键就原样返回 */
export function setGradleProp(text, key, val) {
  return text.replace(new RegExp('^([ \\t]*)' + key + '([ \\t]*)=([ \\t]*)(.*)$', 'm'),
    (line, indent, ksp, eqsp) => `${indent}${key}${ksp}=${eqsp}${val}`)
}

/* ---------------- 工程依赖更新 ---------------- */

/**
 * 拿真实接口的结果去更新工程的版本号。
 * 查不到的项保持原样，绝不瞎写 —— 宁可少更新，不可写坏。
 */
export async function planUpdate(meta, cur) {
  const mc = meta.mcVersion
  const plan = {}
  const problems = []

  try {
    const yarn = await fabricYarn(mc)
    if (yarn.length) plan.yarn = yarn[0]
    else problems.push(`Fabric 官方没有 ${mc} 的 yarn 映射 —— 版本号是不是写错了`)
  } catch (e) { problems.push('yarn：' + friendlyNetError(e)) }

  try {
    const ld = await fabricLoaders(mc)
    const stable = ld.find((x) => x.stable) || ld[0]
    if (stable) plan.loader = stable.version
  } catch (e) { problems.push('loader：' + friendlyNetError(e)) }

  try {
    const api = await modrinthVersion('fabric-api', mc)
    /* Modrinth 的版本号形如 0.102.0+1.21，正好就是 gradle 里要的写法 */
    if (api) plan.api = api.version
    else problems.push(`Modrinth 上没有 ${mc} 可用的 fabric-api`)
  } catch (e) { problems.push('fabric-api：' + friendlyNetError(e)) }

  const changes = []
  for (const [k, label] of [['yarn', 'yarn_mappings'], ['loader', 'loader_version'], ['api', 'fabric_version']]) {
    if (!plan[k]) continue
    const old = cur[k] || ''
    if (old !== plan[k]) changes.push(`${label}: ${old || '(空)'} → ${plan[k]}`)
  }

  return { plan, changes, problems }
}

/* ============================ 子工具本体 ============================ */

export default {
  key: 'net',
  title: '联网接口',
  summary: '联网查 loader/模组最新版、搜模组、下素材',
  params: {
    op: 'status / fabric / mclist / search / fetch / update',
    mcVersion: 'fabric 用：查哪个游戏版本，默认工程当前的',
    query: 'search 用：搜什么模组',
    limit: 'search 用：返回几条，默认 5',
    url: 'fetch 用：要下载的地址（http/https）',
    save: 'fetch 用：存到工程的哪个相对路径',
    dir: 'update 用：工程目录（默认当前工程）',
  },

  async run(ctx, args) {
    const op = String(args.op || 'status').toLowerCase()

    /* ---------------- 通不通 ---------------- */
    if (op === 'status' || op === 'ping') {
      const results = []
      let up = 0
      for (const [name, url] of Object.entries(SOURCES)) {
        try {
          await getJson(url, 6000)
          results.push(`✓ ${name}`)
          up++
        } catch (e) {
          results.push(`✗ ${name} —— ${friendlyNetError(e)}`)
        }
      }
      /* 三个源全挂就是"现在没网"，这必须是个失败结论 ——
         返回 ok:true 会让模型以为一切正常，接着去用 op:update 白折腾（踩过）。 */
      return {
        ok: up > 0,
        online: up > 0,
        error: up === 0 ? '三个源都连不上 —— 现在没网' : undefined,
        checked: results,
        note: up === Object.keys(SOURCES).length
          ? '三个源都通，可以用 op:update 拿真实的最新版本号。'
          : (up ? '只有部分源通 —— 用得了就用，用不了的部分下面会说明。' : '网络不通。'),
        hint: up ? '' : '断网也能干活：compat 里有一张内置版本表，有可能会过期。',
      }
    }

    /* ---------------- 游戏版本清单 ---------------- */
    if (op === 'mclist' || op === 'mc') {
      try {
        const j = await getJson(SOURCES['Mojang 版本清单'])
        if (!j || !Array.isArray(j.versions) || !j.versions.length) {
          return {
            ok: false,
            error: '版本清单的形状不对 —— 多半被拦截或者限流了',
            hint: '过一会儿再试；内容开头是：' + JSON.stringify(j).slice(0, 100),
          }
        }
        const releases = j.versions.filter((v) => v.type === 'release')
        return {
          ok: true,
          latest: `${j.latest?.release || '?'}（快照 ${j.latest?.snapshot || '?'}）`,
          recent: releases.slice(0, 12).map((v) => `${v.id.padEnd(9)} ${String(v.releaseTime).slice(0, 10)}`),
          note: '做模组优先跟正式版（release）。',
        }
      } catch (e) {
        return { ok: false, error: '查 Mojang 版本清单失败：' + friendlyNetError(e), hint: '确认能上网再试。' }
      }
    }

    /* ---------------- Fabric 版本 ---------------- */
    if (op === 'fabric') {
      const mc = String(args.mcVersion || (ctx.current ? '' : '1.21')).trim()
      let version = mc
      if (!version && ctx.current) {
        const meta = await readMeta(ctx.current)
        version = meta ? meta.mcVersion : ''
      }
      if (!version) return { ok: false, error: '要指定 mcVersion，比如 mcVersion:1.21.4' }

      try {
        const [yarn, loaders] = await Promise.all([fabricYarn(version), fabricLoaders(version)])
        /* 接口通了但一个版本都没有 = 这个游戏版本 Fabric 还没支持，或者形状不对。
           不能返回 ok:true 空列表让模型以为"查到了"（踩过）。 */
        if (!yarn.length && !loaders.length) {
          return {
            ok: false,
            error: `Fabric 那边没有 ${version} 的任何版本 —— 要么这版本还不支持，要么版本号写错了`,
            hint: '用 do:net op:mclist 看有哪些正式版；断网的话用 do:compat op:versions 看内置表。',
          }
        }
        const stableLoader = loaders.filter((x) => x.stable)
        const out = {
          ok: true,
          mcVersion: version,
          yarn: yarn.slice(0, 3),
          loader: stableLoader.slice(0, 3).map((x) => x.version),
          'Java 版本': resolveProfile(version).java,
        }
        try {
          const api = await modrinthVersion('fabric-api', version)
          out['fabric-api'] = api ? [`${api.version}（Modrinth 最新，${api.downloads} 次下载）`] : ['Modrinth 上没查到']
        } catch (e) {
          out['fabric-api'] = ['查不到：' + friendlyNetError(e)]
        }
        out.note = '这些都是刚从官方接口拿的，比 compat 的内置表新。'
        out.hint = '要写进工程就 do:net op:update（不用自己抄）'
        return out
      } catch (e) {
        return {
          ok: false,
          error: `查 Fabric ${version} 的版本失败：` + friendlyNetError(e),
          hint: '断网的话用 do:compat op:versions 看内置表。',
        }
      }
    }

    /* ---------------- 搜模组 ---------------- */
    if (op === 'search' || op === 'find') {
      const q = String(args.query || '').trim()
      if (!q) return { ok: false, error: 'query 要写搜什么，比如 query:小地图' }
      /* 必须取整：Modrinth 收到 limit=2.7 会直接 HTTP 400（踩过） */
      const limit = Math.max(1, Math.min(10, Math.round(Number(args.limit)) || 5))
      const facets = [['project_type:mod'], ['categories:fabric']]
      const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}` +
        `&limit=${limit}&facets=${encodeURIComponent(JSON.stringify(facets))}`
      try {
        const j = await getJson(url)
        const hits = Array.isArray(j.hits) ? j.hits : []
        return {
          ok: true,
          query: q,
          count: hits.length,
          mods: hits.map((h) => `${(h.slug || h.project_id).padEnd(24)} ${h.title}｜${String(h.description || '').slice(0, 40)}｜${h.downloads || 0} 次下载`),
          note: hits.length ? '' : '没搜到。换个词或者去掉加载器限制试试。',
          hint: '这里的 slug 可以拿去 do:net op:fetch 下文件，或者填进 compat 的 dep 声明里。',
        }
      } catch (e) {
        return { ok: false, error: '搜 Modrinth 失败：' + friendlyNetError(e) }
      }
    }

    /* ---------------- 下素材 ---------------- */
    if (op === 'fetch' || op === 'download') {
      const url = String(args.url || '').trim()
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url 必须是 http:// 或 https:// 开头' }

      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 20000)
      let buf
      let declared = 0
      try {
        const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        declared = Number(r.headers.get('content-length') || 0)
        if (declared > MAX_DOWNLOAD) throw new Error(`文件太大（${Math.round(declared / 1024)}KB）`)
        buf = Buffer.from(await r.arrayBuffer())
      } catch (e) {
        return { ok: false, error: '下载失败：' + friendlyNetError(e) }
      } finally {
        clearTimeout(t)
      }

      if (buf.length > MAX_DOWNLOAD) {
        return { ok: false, error: `下下来 ${Math.round(buf.length / 1024)}KB，超过 ${MAX_DOWNLOAD / 1024 / 1024}MB 上限` }
      }
      /* 服务器报的长度和实收对不上 —— 多半是中途断了，写下去就是个坏文件。
         宁可报错，也不能让人拿着一张缺了一半的 PNG 去当贴图。 */
      if (declared && buf.length !== declared) {
        return {
          ok: false,
          error: `下载不完整：服务器说 ${declared} 字节，只收到 ${buf.length} 字节`,
          hint: '重试一次；老是这样就换个源。',
        }
      }

      /* 存哪儿：给了 save 就用 save（必须留在工程里），否则丢到工程的 downloads/ */
      const projDir = String(args.dir || ctx.current || '')
      let rel = String(args.save || '').trim().replace(/\\/g, '/')
      if (rel) {
        const safe = normalize(rel).replace(/\\/g, '/')
        /* 以 / 或 \ 开头的绝对路径也要拦：join 之后其实还是落在工程里，
           但报告回显的 saved 会是 "/abs/x.png"，看着像写到了系统根目录 ——
           说的和做的不一样，比直接报错更糟（踩过）。 */
        if (safe.startsWith('..') || safe.includes(':') || /^[\\/]/.test(safe)) {
          return { ok: false, error: 'save 只能是工程里的相对路径（不能以 / 开头，也不能带盘符）' }
        }
        rel = safe
      } else {
        /* URL 没有路径时（http://host 和 http://host/ 都是）basename 会得到空串，
           拼出来就是 "downloads/" —— 那会把文件直接写到 downloads 这个位置上，
           之后所有不带 save 的下载全崩（踩过）。所以兜一个文件名。 */
        const base = basename(new URL(url).pathname)
        rel = 'downloads/' + (base || 'file.bin')
      }
      if (!rel || rel.endsWith('/')) rel = (rel || 'downloads/') + 'file.bin'
      if (!projDir || !existsSync(projDir)) {
        return { ok: false, error: '没指定工程，存不了文件', hint: '先 do:project op:create 建工程，或传 dir' }
      }

      const full = join(projDir, rel)
      let overwrote = false
      if (existsSync(full)) {
        let isDir = false
        try { isDir = statSync(full).isDirectory() } catch { /* 读不了就当不是 */ }
        if (isDir) {
          return {
            ok: false,
            error: `${rel} 是个目录，不能往里写文件`,
            hint: 'save 要写到具体文件名，比如 resource_pack/textures/items/名字.png。',
          }
        }
        overwrote = true
      }
      try {
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, buf)
      } catch (e) {
        return { ok: false, error: '写文件失败：' + String((e && e.message) || e).slice(0, 120) }
      }

      const kind = isPng(buf) ? 'PNG 图片' : (/OggS/.test(buf.slice(0, 4).toString('latin1')) ? 'Ogg 音频' : '未知格式')
      return {
        ok: true,
        saved: rel,
        kb: Math.round(buf.length / 1024),
        '格式': kind,
        /* 不给 save 的时候，不同 URL 可能落到同一个 downloads/文件名 ——
           第二次是静默覆盖，不说一声的话用户以为两个都下下来了（踩过）。 */
        overwrote: overwrote || undefined,
        note: isPng(buf)
          ? (overwrote ? `是张 PNG。★ 覆盖了已有的 ${rel}。` : '是张 PNG，可以当贴图用。')
          : (overwrote ? `★ 覆盖了已有的 ${rel}。格式不是 PNG/Ogg 的话，游戏多半不认。` : '格式不是 PNG/Ogg 的话，游戏多半不认。'),
        hint: '想当物品贴图，save 成 src/main/resources/assets/<modId>/textures/item/名字.png（Java）',
      }
    }

    /* ---------------- 自动更新依赖 ---------------- */
    if (op === 'update') {
      const projDir = String(args.dir || ctx.current || '')
      if (!projDir || !existsSync(projDir)) return { ok: false, error: '不知道更新哪个工程' }
      const meta = await readMeta(projDir)
      if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }
      if (meta.target !== 'java') {
        return { ok: false, error: '基岩版没有依赖版本要更新（附加包不编译）', hint: '基岩版想换目标版本用 do:compat op:set。' }
      }

      const gp = join(projDir, 'gradle.properties')
      if (!existsSync(gp)) return { ok: false, error: '找不到 gradle.properties' }
      const text = await readFile(gp, 'utf8')
      const read = (k) => readGradleProp(text, k)
      const cur = {
        loader: read('loader_version'),
        yarn: read('yarn_mappings'),
        api: read('fabric_version'),
      }
      const oldOf = { loader_version: cur.loader, yarn_mappings: cur.yarn, fabric_version: cur.api }

      const { plan, changes, problems } = await planUpdate(meta, cur)
      const missingLines = Object.keys(oldOf)
        .filter((k) => !oldOf[k])
        .map((k) => `gradle.properties 里没有 ${k} 这一行`)
      if (!changes.length) {
        return {
          ok: true,
          mcVersion: meta.mcVersion,
          current: [`loader ${cur.loader || '(缺)'}`, `yarn ${cur.yarn || '(缺)'}`, `fabric-api ${cur.api || '(缺)'}`],
          problems: [...problems, ...missingLines].length ? [...problems, ...missingLines] : undefined,
          note: problems.length
            ? '有查不到的项，上面列了原因 —— 已经是最新或者没连上。'
            : '全都是最新的，不用改。',
        }
      }

      /* 只报【真改了的】。报告必须跟落盘一致，不然模型会把假消息转告给用户 */
      let t2 = text
      const updated = []
      const missed = [...missingLines]
      const plan3 = [['loader_version', plan.loader], ['yarn_mappings', plan.yarn], ['fabric_version', plan.api]]
      for (const [key, val] of plan3) {
        if (!val) continue
        const next = setGradleProp(t2, key, val)
        if (next !== t2) {
          t2 = next
          updated.push(`${key}: ${oldOf[key] || '(空)'} → ${val}`)
        } else if (!missed.some((m) => m.includes(key))) {
          missed.push(`gradle.properties 里的 ${key} 认不出来，没敢改`)
        }
      }
      if (!updated.length) {
        return {
          ok: true,
          mcVersion: meta.mcVersion,
          current: plan3.map(([k, v]) => `${k} 想改成 ${v}`),
          problems: [...problems, ...missed, '★ 所以文件一个字节都没动'],
          note: '查到新版本了，但这个工程的 gradle.properties 认不出来 —— 宁可不改，也不乱写。',
        }
      }
      await writeFile(gp, t2, 'utf8')

      /* fabric.mod.json 里的 loader 下限也跟着走，不然加载器版本对不上会拒绝加载 */
      if (plan.loader) {
        const fmj = join(projDir, 'src/main/resources/fabric.mod.json')
        if (existsSync(fmj)) {
          try {
            const j = JSON.parse(await readFile(fmj, 'utf8'))
            j.depends = j.depends || {}
            j.depends.fabricloader = '>=' + plan.loader
            await writeFile(fmj, JSON.stringify(j, null, 2) + '\n', 'utf8')
          } catch { /* JSON 坏了交给 verify 报 */ }
        }
      }

      return {
        ok: true,
        mcVersion: meta.mcVersion,
        updated,
        problems: [...problems, ...missed].length ? [...problems, ...missed] : undefined,
        note: '这些版本号是从 Fabric 官方接口和 Modrinth 现查的，不是内置表里的死数据。',
        hint: '更新完跑 do:verify op:java 确认还能编译。',
      }
    }

    return {
      ok: false,
      error: '不认识的 op：' + op,
      known: ['status', 'fabric', 'mclist', 'search', 'fetch', 'update'],
      hint: 'op=status 先看通不通；op=fabric 查版本；op=search 搜模组；op=fetch 下素材；op=update 自动更新依赖。',
    }
  },
}

export const __test = {
  SOURCES, getJson, friendlyNetError, fabricYarn, fabricLoaders, modrinthVersion,
  planUpdate, readGradleProp, setGradleProp, MAX_DOWNLOAD,
}
