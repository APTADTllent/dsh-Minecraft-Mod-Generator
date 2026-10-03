/*
  biome —— 生物群系（子工具 #8）
  =================================

  两边都能纯数据搞定，不用写代码：

    java    datapack：data/<modId>/worldgen/biome/<name>.json（1.19+ 支持）
    bedrock behavior_pack/biomes/<name>.json

  群系"能不能真的生成在世界里"取决于有没有被放进 dimension 的
  biome_source —— 那是另一个 datapack 文件（worldgen/…）。
  这里会把群系本体写好，并明确说明"还没有挂进世界"，
  免得用户进了游戏发现哪儿都找不到。

  参数按 MC 的习惯来：温度、降水、天空色、水色，加上地表方块。
  颜色用 #rrggbb 传，内部转成十进制（MC 的 json 里是整数）。
*/
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readMeta, readPart, writePart } from './project.js'

/** MC 的群系分类（影响能刷什么怪） */
export const CATEGORIES = ['plains', 'forest', 'desert', 'jungle', 'snowy', 'swamp', 'ocean', 'nether', 'the_end']

/** 地表材料预设 */
export const SURFACES = {
  grass: { top: 'minecraft:grass_block', mid: 'minecraft:dirt', label: '草地' },
  sand: { top: 'minecraft:sand', mid: 'minecraft:sandstone', label: '沙地' },
  snow: { top: 'minecraft:snow_block', mid: 'minecraft:dirt', label: '雪地' },
  stone: { top: 'minecraft:stone', mid: 'minecraft:stone', label: '石头' },
  ruby: { top: 'minecraft:redstone_block', mid: 'minecraft:stone', label: '红石地（示例）' },
  nether: { top: 'minecraft:netherrack', mid: 'minecraft:netherrack', label: '下界岩' },
  end: { top: 'minecraft:end_stone', mid: 'minecraft:end_stone', label: '末地石' },
}

export const SURFACE_KEYS = Object.keys(SURFACES)

function hexToInt(hex) {
  const s = String(hex || '#000000').replace('#', '').trim()
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return 0
  return parseInt(full, 16)
}

/* ============================ Java（datapack） ============================ */

export function javaBiome(b, modId) {
  const surf = SURFACES[b.surface] || SURFACES.grass
  const spawners = {}
  if (b.category === 'nether') {
    spawners.monster = [
      { type: 'minecraft:zombified_piglin', weight: 100, minCount: 2, maxCount: 4 },
      { type: 'minecraft:magma_cube', weight: 10, minCount: 1, maxCount: 4 },
    ]
  } else if (b.category === 'the_end') {
    spawners.monster = [{ type: 'minecraft:enderman', weight: 10, minCount: 4, maxCount: 4 }]
  } else {
    spawners.creature = [
      { type: 'minecraft:sheep', weight: 12, minCount: 4, maxCount: 4 },
      { type: 'minecraft:pig', weight: 10, minCount: 4, maxCount: 4 },
    ]
    /* 用户自己的生物也能刷进来 */
    for (const m of b.spawnMobs || []) {
      spawners.monster = spawners.monster || []
      spawners.monster.push({ type: `${modId}:${m}`, weight: 20, minCount: 1, maxCount: 2 })
    }
  }

  const biome = {
    temperature: b.temperature,
    downfall: b.downfall,
    has_precipitation: b.precipitation,
    effects: {
      sky_color: hexToInt(b.skyColor),
      fog_color: hexToInt(b.fogColor),
      water_color: hexToInt(b.waterColor),
      water_fog_color: hexToInt(b.waterColor),
      mood_sound: {
        sound: 'minecraft:ambient.cave',
        tick_delay: 6000,
        block_search_extent: 8,
        offset: 2.0,
      },
    },
    spawners,
    spawn_costs: {},
    carvers: {},
    features: [],
    /* 地表材料：MC 的 datapack 用 surface_rule，这里给最简形式 */
    _surface: { top: surf.top, mid: surf.mid, sea_floor: surf.top, foundation: 'minecraft:stone' },
  }
  return biome
}

/* ============================ 基岩版 ============================ */

export function bedrockBiome(b, modId) {
  const surf = SURFACES[b.surface] || SURFACES.grass
  const comps = {
    'minecraft:climate': {
      temperature: b.temperature,
      downfall: b.downfall,
      snow_accumulation: b.temperature < 0.15 ? [1, 2] : [0, 0],
    },
    'minecraft:overworld_height': { noise_type: b.category === 'ocean' ? 'ocean' : 'default' },
    'minecraft:surface_parameters': {
      top_material: { type: surf.top },
      mid_material: { type: surf.mid },
      sea_floor_material: { type: surf.top },
      foundation_material: { type: 'minecraft:stone' },
      sea_material: { type: 'minecraft:water' },
    },
    'minecraft:tags': { tags: [b.category === 'nether' ? 'nether' : 'overworld'] },
  }

  /* 允许用户自己的生物在这个群系生成 */
  if (b.spawnMobs && b.spawnMobs.length) {
    comps['minecraft:spawn_rules'] = {
      rules: b.spawnMobs.map((m, i) => ({
        name: `${modId}:${m}`,
        weight: 20 - i,
        minCount: 1,
        maxCount: 2,
        conditions: [{ condition: 'minecraft:spawns_on_surface' }],
      })),
    }
  }

  return {
    format_version: '1.20.60',
    'minecraft:biome': {
      description: { identifier: `${modId}:${b.name}` },
      components: comps,
    },
  }
}

export default {
  key: 'biome',
  title: '群系',
  summary: '生成生物群系（温度/降水/颜色/地表/刷怪）',
  params: {
    op: 'add（默认）或 list 或 surfaces',
    name: '群系名，小写字母数字下划线',
    label: '显示名（中文）',
    category: '分类：' + CATEGORIES.join('/'),
    temperature: '温度，0.8 温和、0.0 下雪、2.0 沙漠，默认 0.8',
    downfall: '降水，默认 0.4',
    precipitation: '是否下雨，默认 true',
    surface: '地表材料：' + SURFACE_KEYS.join('/'),
    skyColor: '天空色 #rrggbb',
    fogColor: '雾色 #rrggbb',
    waterColor: '水色 #rrggbb',
    spawnMobs: '要让哪些【本工程的生物】在这个群系生成（名字数组）',
  },

  async run(ctx, args) {
    const op = String(args.op || 'add').toLowerCase()

    if (op === 'surfaces') {
      return {
        ok: true,
        surfaces: Object.entries(SURFACES).map(([k, v]) => `${k.padEnd(8)} ${v.label}（${v.top}）`),
        categories: CATEGORIES,
      }
    }

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const list = await readPart(projDir, 'biomes', [])

    if (op === 'list') {
      return {
        ok: true,
        count: list.length,
        biomes: list.map((b) => `${b.name}  ${b.label}  ${b.category}  ${b.surface}`),
        note: list.length ? '' : '还没有群系。用 op:add 加一个。',
      }
    }

    const name = String(args.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '').replace(/^(\d)/, 'b$1')
    if (!name) return { ok: false, error: '要给群系起个名字（name）' }
    if (list.some((b) => b.name === name)) {
      return { ok: false, error: `群系「${name}」已经在这个工程里了` }
    }

    const category = String(args.category || 'plains').toLowerCase()
    if (!CATEGORIES.includes(category)) {
      return { ok: false, error: '不认识的分类：' + category, known: CATEGORIES }
    }
    const surface = String(args.surface || 'grass').toLowerCase()
    if (!SURFACES[surface]) {
      return { ok: false, error: '不认识的地表材料：' + surface, known: SURFACE_KEYS }
    }
    for (const key of ['skyColor', 'fogColor', 'waterColor']) {
      const v = String(args[key] || '').trim()
      if (v && !/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v)) {
        return { ok: false, error: `${key} 要写成 #rrggbb` }
      }
    }

    /* 只有本工程里真有的生物才能刷 —— 否则游戏里那个刷怪项是死的 */
    const entities = await readPart(projDir, 'entities', [])
    const known = entities.map((e) => e.name)
    let spawnMobs = Array.isArray(args.spawnMobs) ? args.spawnMobs.map(String) : []
    const unknown = spawnMobs.filter((m) => !known.includes(m))
    if (unknown.length) {
      return {
        ok: false,
        error: `工程里没有这些生物：${unknown.join(' ')}`,
        known,
        hint: '先用 do:entity 把生物加进来，或者去掉 spawnMobs',
      }
    }

    const b = {
      name,
      label: String(args.label || name),
      category,
      surface,
      temperature: Math.max(-1, Math.min(2, Number(args.temperature === undefined ? 0.8 : args.temperature))),
      downfall: Math.max(0, Math.min(1, Number(args.downfall === undefined ? 0.4 : args.downfall))),
      precipitation: args.precipitation !== false,
      skyColor: String(args.skyColor || '#78a7ff'),
      fogColor: String(args.fogColor || '#c0d8ff'),
      waterColor: String(args.waterColor || '#3f76e4'),
      spawnMobs,
    }

    list.push(b)
    await writePart(projDir, 'biomes', list)

    const written = []
    if (meta.target === 'java') {
      const f = join(projDir, 'src/main/resources/data', meta.modId, 'worldgen/biome', name + '.json')
      await mkdir(dirname(f), { recursive: true })
      await writeFile(f, JSON.stringify(javaBiome(b, meta.modId), null, 2), 'utf8')
      written.push(`data/${meta.modId}/worldgen/biome/${name}.json`)
    } else {
      const f = join(projDir, 'behavior_pack/biomes', name + '.json')
      await mkdir(dirname(f), { recursive: true })
      await writeFile(f, JSON.stringify(bedrockBiome(b, meta.modId), null, 2), 'utf8')
      written.push(`behavior_pack/biomes/${name}.json`)
    }

    return {
      ok: true,
      name,
      label: b.label,
      target: meta.target,
      category,
      surface,
      temperature: b.temperature,
      total: list.length,
      generated: written,
      spawning: spawnMobs.length ? spawnMobs.join(' ') : '（没配自建生物，只有原版怪）',
      note: '★ 群系本体写好了，但还没挂进世界生成 —— ' +
        '要让它真的出现在地图里，得改 dimension 的 biome_source（那是另一个 datapack 文件），' +
        '或者调试时用 /locate biome 找找看。',
      hint: '要加别的群系就换个 name。',
    }
  },
}

export const __test = { CATEGORIES, SURFACES, hexToInt, javaBiome, bedrockBiome }
