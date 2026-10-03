/*
  render —— 渲染 / 雾 / 光影（子工具 #17）
  =========================================

  先把话说清楚，免得用户以为能一键做光影：

    视距      是【玩家客户端】的设置，任何模组都改不了别人的视距。
              能做的只是把"建议视距"写进说明，或者在服务端限制。
    雾        两边都能做：基岩版是 fog JSON（完整可用）；
              Java 版要写 FogModifier（代码，这里生成骨架）。
    光影      只有 Java 版有（shader pack / Iris / OptiFine）。
              写一个能用的光影要 GLSL + 一整套管线，不是工具能生成的 ——
              这里只生成一份【骨架 + 说明】，告诉你从哪儿下手。
    光照/环境 基岩版能调（光照衰减、环境色），Java 版靠数据包有限。

  产出：
    bedrock resource_pack/fogs/<name>.json（完整可用）
    java    FogSettings.java（FogModifier 骨架，需要你自己接上去）
*/
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readMeta, readPart, writePart } from './project.js'

/** 雾的预设：从"清爽"到"伸手不见五指" */
export const FOG_PRESETS = {
  clear: { label: '清爽（看得远）', start: 0.85, end: 1.0, density: 0.0 },
  normal: { label: '普通', start: 0.6, end: 1.0, density: 0.0 },
  misty: { label: '薄雾', start: 0.3, end: 0.9, density: 0.15 },
  thick: { label: '浓雾', start: 0.05, end: 0.5, density: 0.5 },
  underwater: { label: '水下（很近）', start: 0.0, end: 0.15, density: 0.8 },
  nether: { label: '下界（压抑偏红）', start: 0.1, end: 0.6, density: 0.4 },
}

export const FOG_KEYS = Object.keys(FOG_PRESETS)

/** 要调哪些环境 */
export const SLOTS = ['air', 'water', 'weather', 'lava', 'powder_snow']

function hexToRgb01(hex) {
  const s = String(hex || '#ffffff').replace('#', '')
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [1, 1, 1]
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ]
}

/* ============================ 基岩版 fog ============================ */

export function bedrockFog(modId, name, f) {
  const rgb = hexToRgb01(f.color)
  const d = {}
  for (const slot of f.slots) {
    if (slot === 'weather') {
      d.weather = {
        fog_start: f.start, fog_end: f.end,
        fog_color: `#${String(f.color).replace('#', '')}`,
        render_distance_type: f.distanceType,
      }
    } else {
      d[slot] = {
        fog_start: f.start,
        fog_end: f.end,
        fog_color: `#${String(f.color).replace('#', '')}`,
        render_distance_type: f.distanceType,
      }
    }
  }

  const out = {
    format_version: '1.16.100',
    'minecraft:fog_settings': {
      description: { identifier: `${modId}:${name}` },
      distance: d,
    },
  }
  /* 浓雾另外给一个体密度，让它真的"糊"起来 */
  if (f.density > 0) {
    out['minecraft:fog_settings'].volumetric = {
      density: {
        air: { max_density: f.density, uniform: true },
      },
    }
  }
  void rgb
  return out
}

/* ============================ Java 版骨架 ============================ */

/**
 * 名字转类名，并避免后缀重复。
 * 坑：用户把雾叫 ruby_fog，无脑加后缀就成了 RubyFogFog。
 * 名字里已经带了那个词就不再叠一次。
 */
export function classFor(name, suffix) {
  const base = String(name).replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase())
  return base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : base + suffix
}

export function renderFogJava(pkg, modId, name, f) {
  const cls = classFor(name, 'Fog')
  return `package ${pkg};

import net.fabricmc.api.ClientModInitializer;

/**
 * ${name} 的雾效 —— 由 DSH 的 mc_mod 工具生成的骨架。
 *
 * 【要你接的地方】下面 onInitializeClient 里是空的。
 * Fabric 的雾要这样接（1.21 大致长这样，小版本可能有出入）：
 *
 *     FogManager.getInstance() 之类的接口在纯 Fabric 里其实没有，
 *     常见做法是实现 ClientModInitializer 后用 mixin 挂到
 *     BackgroundRenderer.render，或者在渲染回调里按生物群系改雾色。
 *
 * 参数先给你，省得自己试：
 *     雾起点 ${f.start}    雾终点 ${f.end}    颜色 ${f.color}
 *     （${FOG_PRESETS[f.preset] ? FOG_PRESETS[f.preset].label : '自定义'}）
 *
 * 想清楚"这个雾在什么条件下生效"（进群系？在水下？在维度里？）再动手。
 */
public class ${cls} implements ClientModInitializer {

    /** 雾参数 —— 接上去的时候直接用 */
    public static final float FOG_START = ${f.start}f;
    public static final float FOG_END = ${f.end}f;
    public static final int FOG_COLOR = 0x${String(f.color).replace('#', '').toUpperCase()};

    @Override
    public void onInitializeClient() {
        // TODO: 把上面的参数接到渲染管线里（见类注释）
    }
}
`
}

/** 光影骨架说明文件（不是代码，是给人看的路线图） */
export function renderShaderReadme(name, f) {
  /* 这是 Markdown，里面要写行内代码（反引号），而它自己又要在 JS 字符串里 ——
     混着写极容易漏转义（早先就这么挂过一次，整个文件语法错）。
     改成数组 join，反引号当普通字符用，谁也坑不到谁。 */
  const L = [
    '# ' + name + ' · 光影骨架说明',
    '',
    '> 由 DSH 的 mc_mod 工具生成。**这不是一个能用的光影**，是一份路线图。',
    '',
    '## 为什么生成不了能用的光影',
    '',
    '《我的世界》Java 版的光影（shader pack）是一整套 GLSL 管线：',
    'gbuffers 各个阶段、光照传播、阴影贴图、后处理……通常由几十个 `.fsh` / `.vsh`',
    '文件和一份 `shaders.properties` 组成，还要装 Iris 或 OptiFine 才能加载。',
    '这东西只能一版一版调，工具生成不出来 —— 生成出来的也一定跑不起来。',
    '',
    '## 参数（已经按你的要求算好）',
    '',
    '| 项 | 值 |',
    '|---|---|',
    '| 雾起点 | ' + f.start + ' |',
    '| 雾终点 | ' + f.end + ' |',
    '| 雾颜色 | ' + f.color + ' |',
    '| 生效范围 | ' + f.slots.join(' / ') + ' |',
    '',
    '## 从哪儿下手',
    '',
    '1. **先装 Iris**（`mods/` 里放 iris 的 jar），它是现在主流的光影加载器。',
    '2. 拿一个开源光影当底子改，别从零写。找 `shaders/` 目录结构最清楚的那种。',
    '3. **雾**是最容易改的：在 `gbuffers_terrain.fsh` 或后处理里改 fogColor / fogDensity',
    '   两个 uniform，就能出效果 —— 你这套参数可以直接填进去。',
    '4. **视距改不了**（那是玩家客户端的设置），但雾能伪造"看得近"的观感。',
    '',
    '## 如果只是想改观感，其实有更省事的路',
    '',
    '- 改群系的 `sky_color` / `fog_color`（do:biome）—— 不用写 shader',
    '- 改基岩版的 fog JSON（do:render）—— 一个 json 搞定',
    '- 资源包换天空贴图 —— 比写光影简单一百倍',
    '',
  ]
  return L.join('\n')
}

export default {
  key: 'render',
  title: '渲染',
  summary: '调雾效/环境色（基岩版完整，java 版给骨架）；视距改不了，光影生成不了',
  params: {
    op: 'add（默认）或 list 或 presets',
    name: '名字，小写字母数字下划线',
    preset: '雾预设：' + FOG_KEYS.join('/'),
    color: '雾色 #rrggbb',
    start: '可选：雾起点 0~1（占渲染距离的比例）',
    end: '可选：雾终点 0~1',
    density: '可选：体积雾浓度 0~1',
    slots: '作用在哪些环境（数组）：' + SLOTS.join('/'),
    distanceType: 'render（跟着渲染距离）或 fixed（固定格数）',
    wantShader: 'true 时额外生成一份光影路线图说明',
  },

  async run(ctx, args) {
    const op = String(args.op || 'add').toLowerCase()

    if (op === 'presets') {
      return {
        ok: true,
        presets: Object.entries(FOG_PRESETS).map(([k, v]) =>
          `${k.padEnd(10)} ${v.label}（起点 ${v.start} 终点 ${v.end}）`),
        slots: SLOTS,
        note: '视距是玩家客户端的设置，模组改不了；能改的是雾。',
      }
    }

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const list = await readPart(projDir, 'renders', [])

    if (op === 'list') {
      return {
        ok: true,
        count: list.length,
        renders: list.map((r) => `${r.name}  ${r.preset}  ${r.color}  起点${r.start} 终点${r.end}`),
        note: list.length ? '' : '还没有渲染配置。用 op:add 加一个。',
      }
    }

    const name = String(args.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '').replace(/^(\d)/, 'r$1')
    if (!name) return { ok: false, error: '要给这份渲染配置起个名字（name）' }

    const preset = String(args.preset || 'normal').toLowerCase()
    if (!FOG_PRESETS[preset]) {
      return { ok: false, error: `没有「${preset}」这个雾预设`, known: FOG_KEYS, hint: '用 op:presets 看看' }
    }
    const P = FOG_PRESETS[preset]
    const color = String(args.color || '#c0d8ff').trim()
    if (!/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) {
      return { ok: false, error: 'color 要写成 #rrggbb' }
    }

    let slots = Array.isArray(args.slots) && args.slots.length ? args.slots.map(String) : ['air', 'water']
    const badSlots = slots.filter((s) => !SLOTS.includes(s))
    if (badSlots.length) return { ok: false, error: '不认识的环境：' + badSlots.join(' '), known: SLOTS }

    const f = {
      name, preset,
      color,
      start: Math.max(0, Math.min(1, Number(args.start === undefined ? P.start : args.start))),
      end: Math.max(0, Math.min(1, Number(args.end === undefined ? P.end : args.end))),
      density: Math.max(0, Math.min(1, Number(args.density === undefined ? P.density : args.density))),
      slots,
      distanceType: String(args.distanceType || 'render').toLowerCase(),
    }
    if (f.end <= f.start) return { ok: false, error: `雾终点（${f.end}）要大于起点（${f.start}），不然什么也看不见` }
    if (!['render', 'fixed'].includes(f.distanceType)) {
      return { ok: false, error: 'distanceType 只能是 render 或 fixed' }
    }

    const replaced = list.findIndex((r) => r.name === name)
    if (replaced >= 0) list.splice(replaced, 1)
    list.push(f)
    await writePart(projDir, 'renders', list)

    const written = []
    if (meta.target === 'bedrock') {
      const file = join(projDir, 'resource_pack/fogs', name + '.json')
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(bedrockFog(meta.modId, name, f), null, 2), 'utf8')
      written.push(`resource_pack/fogs/${name}.json`)

      /* 基岩版还要在 biomes_client.json 里把雾挂到群系上 */
      const mapFile = join(projDir, 'resource_pack/biomes_client.json')
      let map = { biomes: {} }
      if (existsSync(mapFile)) {
        try { map = JSON.parse(await (await import('node:fs/promises')).readFile(mapFile, 'utf8')) } catch { /* 重建 */ }
        if (!map.biomes) map.biomes = {}
      }
      map.biomes[`${meta.modId}:${name}`] = { fog_identifier: `${meta.modId}:${name}` }
      await mkdir(dirname(mapFile), { recursive: true })
      await writeFile(mapFile, JSON.stringify(map, null, 2), 'utf8')
      written.push('resource_pack/biomes_client.json')
    } else {
      const pkg = 'com.example.' + meta.modId
      const dir = join(projDir, 'src/main/java', pkg.replace(/\./g, '/'))
      await mkdir(dir, { recursive: true })
      const cls = classFor(name, 'Fog')
      await writeFile(join(dir, cls + '.java'), renderFogJava(pkg, meta.modId, name, f), 'utf8')
      written.push(`src/main/java/${pkg.replace(/\./g, '/')}/${cls}.java`)

      if (args.wantShader) {
        const sf = join(projDir, 'shader-notes', name + '-光影说明.md')
        await mkdir(dirname(sf), { recursive: true })
        await writeFile(sf, renderShaderReadme(name, f), 'utf8')
        written.push(`shader-notes/${name}-光影说明.md`)
      }
    }

    return {
      ok: true,
      name,
      preset,
      target: meta.target,
      color,
      '雾范围': `${f.start} → ${f.end}`,
      density: f.density,
      slots: f.slots.join('/'),
      total: list.length,
      generated: written,
      note: meta.target === 'bedrock'
        ? '基岩版的雾是纯 JSON，已经完整可用，并且挂进了 biomes_client.json。'
        : '★ Java 版给的是雾效骨架（参数算好了，接进渲染管线要你自己动手）。视距改不了，光影也生成不了。',
      hint: '想要简单点的观感变化，试试 do:biome 改群系天空色，比写 shader 省事。',
    }
  },
}

export const __test = { FOG_PRESETS, FOG_KEYS, SLOTS, hexToRgb01, bedrockFog, renderFogJava, renderShaderReadme }
