/*
  recipe —— 合成配方（子工具 #14）
  ==================================

  三种配方：有序合成 / 无序合成 / 熔炼。

  两个容易踩的版本坑（1.21 已改，写错游戏直接不认）：
    · datapack 目录是 data/<ns>/recipe/【单数】，1.20.5 之前是 recipes
    · 产出写 "result": { "id": "...", "count": N }，不再是 "item"
  基岩版则是 recipes/【复数】目录，产出还是 "item" —— 两边不一样。

  产出位置：
    java    src/main/resources/data/<modId>/recipe/<name>.json
    bedrock behavior_pack/recipes/<name>.json
*/
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readMeta, readPart, writePart } from './project.js'

const TYPES = {
  shaped: '有序合成（摆成固定图案）',
  shapeless: '无序合成（材料丢进去就行）',
  smelting: '熔炼（烧出来）',
}

/** 'minecraft:iron_ingot' 或 'iron_ingot' 都收，统一补上命名空间 */
function itemId(s) {
  const v = String(s || '').trim()
  if (!v) return ''
  return v.includes(':') ? v : 'minecraft:' + v
}

function recipePath(projDir, target, modId, name) {
  return target === 'java'
    ? join(projDir, 'src/main/resources/data', modId, 'recipe', name + '.json')
    : join(projDir, 'behavior_pack/recipes', name + '.json')
}

/* ============================ 校验 ============================ */

export function validateRecipe(r) {
  if (!TYPES[r.type]) return `不认识的配方类型「${r.type}」，只能是 ${Object.keys(TYPES).join('/')}`
  if (!r.output) return '要指定产出（output），例如 mymod:ruby_block'

  if (r.type === 'shaped') {
    if (!Array.isArray(r.pattern) || r.pattern.length === 0) return '有序合成要给 pattern，例如 ["XXX","XXX","XXX"]'
    if (r.pattern.length > 3) return 'pattern 最多 3 行'
    for (const row of r.pattern) {
      if (typeof row !== 'string') return 'pattern 的每一行都要是字符串'
      if (row.length > 3) return `pattern 每行最多 3 个字符，这行是「${row}」`
    }
    if (!r.key || typeof r.key !== 'object' || !Object.keys(r.key).length) {
      return '有序合成要给 key，把图案里的字符对应到材料，例如 {"X":"minecraft:iron_ingot"}'
    }
    /* 图案里用到的字符必须在 key 里有定义，否则游戏里配方是空的 */
    const used = new Set()
    for (const row of r.pattern) for (const ch of row) if (ch !== ' ') used.add(ch)
    const missing = [...used].filter((c) => !r.key[c])
    if (missing.length) return `图案里用了「${missing.join('')}」但 key 里没定义它`
    return ''
  }

  if (r.type === 'shapeless') {
    if (!Array.isArray(r.ingredients) || r.ingredients.length === 0) {
      return '无序合成要给 ingredients，例如 ["minecraft:iron_ingot","minecraft:coal"]'
    }
    if (r.ingredients.length > 9) return '无序合成最多 9 个材料'
    return ''
  }

  if (r.type === 'smelting') {
    if (!r.input) return '熔炼要给 input（烧什么）'
    return ''
  }
  return ''
}

/* ============================ Java（datapack JSON） ============================ */

export function javaRecipe(modId, r) {
  const resultId = itemId(r.output)
  if (r.type === 'shaped') {
    const key = {}
    for (const [ch, v] of Object.entries(r.key)) key[ch] = { item: itemId(v) }
    return {
      type: 'minecraft:crafting_shaped',
      pattern: r.pattern,
      key,
      result: { id: resultId, count: r.count },
    }
  }
  if (r.type === 'shapeless') {
    return {
      type: 'minecraft:crafting_shapeless',
      ingredients: r.ingredients.map((i) => ({ item: itemId(i) })),
      result: { id: resultId, count: r.count },
    }
  }
  return {
    type: 'minecraft:smelting',
    ingredient: { item: itemId(r.input) },
    result: { id: resultId, count: r.count },
    experience: r.experience,
    cookingtime: r.cookingtime,
  }
}

/* ============================ 基岩版 ============================ */

export function bedrockRecipe(modId, name, r) {
  if (r.type === 'shaped') {
    const key = {}
    for (const [ch, v] of Object.entries(r.key)) key[ch] = { item: itemId(v) }
    return {
      format_version: '1.21.0',
      'minecraft:recipe_shaped': {
        description: { identifier: `${modId}:${name}` },
        tags: ['crafting_table'],
        pattern: r.pattern,
        key,
        result: { item: itemId(r.output) },
      },
    }
  }
  if (r.type === 'shapeless') {
    return {
      format_version: '1.21.0',
      'minecraft:recipe_shapeless': {
        description: { identifier: `${modId}:${name}` },
        tags: ['crafting_table'],
        ingredients: r.ingredients.map((i) => ({ item: itemId(i) })),
        result: { item: itemId(r.output), count: r.count },
      },
    }
  }
  return {
    format_version: '1.21.0',
    'minecraft:recipe_furnace': {
      description: { identifier: `${modId}:${name}` },
      tags: ['furnace', 'blast_furnace', 'smoker'],
      input: itemId(r.input),
      output: itemId(r.output),
    },
  }
}

export default {
  key: 'recipe',
  title: '合成',
  summary: '生成合成/熔炼配方（有序/无序/熔炼），java 和基岩两套一起出',
  params: {
    op: 'add（默认）或 list',
    name: '配方名（一般和产出同名）',
    type: 'shaped（有序）/ shapeless（无序）/ smelting（熔炼）',
    output: '产出物品 id，例如 mymod:ruby_block',
    count: '产出数量，默认 1',
    pattern: 'shaped 用：图案，如 ["XXX","XXX","XXX"]，每行最多 3 个字符',
    key: 'shaped 用：字符对应材料，如 {"X":"minecraft:iron_ingot"}',
    ingredients: 'shapeless 用：材料数组',
    input: 'smelting 用：烧什么',
    experience: 'smelting 用：给多少经验，默认 0.35',
    cookingtime: 'smelting 用：烧多久（tick），默认 200',
  },

  async run(ctx, args) {
    const op = String(args.op || 'add').toLowerCase()

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const recipes = await readPart(projDir, 'recipes', [])

    if (op === 'list') {
      return {
        ok: true,
        count: recipes.length,
        recipes: recipes.map((r) => `${r.name}  ${r.type}  → ${r.output}×${r.count}`),
        note: recipes.length ? '' : '还没有配方。用 op:add 加一个。',
      }
    }

    const name = String(args.name || args.output || '').trim()
      .replace(/^[a-z_]+:/, '').toLowerCase().replace(/[^a-z0-9_]/g, '_')
    if (!name) return { ok: false, error: '要起个配方名（name）' }

    const r = {
      name,
      type: String(args.type || 'shaped').toLowerCase(),
      output: String(args.output || '').trim(),
      count: Math.max(1, Math.min(64, Math.round(Number(args.count) || 1))),
      pattern: Array.isArray(args.pattern) ? args.pattern.map(String) : undefined,
      key: args.key && typeof args.key === 'object' ? args.key : undefined,
      ingredients: Array.isArray(args.ingredients) ? args.ingredients.map(String) : undefined,
      input: args.input ? String(args.input) : undefined,
      experience: Number(args.experience === undefined ? 0.35 : args.experience),
      cookingtime: Math.max(1, Math.round(Number(args.cookingtime) || 200)),
    }

    const bad = validateRecipe(r)
    if (bad) return { ok: false, error: bad, hint: '类型说明：' + Object.entries(TYPES).map(([k, v]) => k + '=' + v).join('；') }

    /* 同名就替换（改配方很常见，不该逼用户先删） */
    const replaced = recipes.some((x) => x.name === name)
    const next = recipes.filter((x) => x.name !== name)
    next.push(r)
    await writePart(projDir, 'recipes', next)

    const out = recipePath(projDir, meta.target, meta.modId, name)
    await mkdir(dirname(out), { recursive: true })
    const json = meta.target === 'java' ? javaRecipe(meta.modId, r) : bedrockRecipe(meta.modId, name, r)
    await writeFile(out, JSON.stringify(json, null, 2), 'utf8')

    /* 数一下盘上到底有几个配方文件，跟清单对一下 —— 防止两边不一致 */
    let onDisk = 0
    try {
      const d = dirname(out)
      onDisk = (await readdir(d)).filter((f) => f.endsWith('.json')).length
    } catch { /* ignore */ }

    return {
      ok: true,
      name,
      type: r.type,
      output: r.output,
      count: r.count,
      replaced,
      total: next.length,
      onDisk,
      file: out.replace(projDir + '\\', ''),
      note: meta.target === 'java'
        ? 'datapack 配方不用注册，游戏自动加载（记得 /reload 或重进世界）。'
        : '基岩版免编译。',
      hint: r.type === 'shaped' && !r.key
        ? ''
        : '要加更多配方就换个 name。',
    }
  },
}

export const __test = { TYPES, itemId, validateRecipe, javaRecipe, bedrockRecipe, recipePath }
