/*
  block —— 方块生成（子工具 #3）
  ================================

  一份方块描述，出两套东西：
    java    → ModBlocks.java（Fabric 注册）+ 语言文件
    bedrock → behavior_pack/blocks/<name>.json + 语言文件

  设计要点：方块清单存在工程的 .mcmod/blocks.json 里，
  每次改动都把目标文件【整体重新生成】一遍。
  为什么不往 Java 文件里追加字符串：追加不可靠 —— 重复加、顺序乱、
  缩进漂、改一次崩一次。数据 + 重渲染是幂等的，生成一百次结果一样。

  贴图交给 blocktex 一起生成（不加贴图的方块在游戏里是紫黑格）。
*/
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readMeta, readPart, writePart } from './project.js'
import blocktex, { KINDS as TEX_KINDS } from './blocktex.js'
import { blockstateJson, blockModelJson, blockItemModelJson } from '../javamodels.js'
import { mainClass } from '../naming.js'

const TOOLS = ['none', 'pickaxe', 'axe', 'shovel', 'hoe', 'shears', 'sword']

/** ruby_block -> RUBY_BLOCK */
const constName = (n) => String(n).toUpperCase().replace(/[^A-Z0-9_]/g, '_')

/* ============================ Fabric（Java） ============================ */

function renderModBlocks(pkg, modId, blocks) {
  /* 主类名必须按 modId 推，不能写死 —— 这里以前写的是 MyMod，
     结果生成出来的 ModBlocks.java 引用一个不存在的类，编译必失败。 */
  const cls = mainClass(modId)
  const body = blocks.map((b) => {
    const s = [`.strength(${b.hardness}f, ${b.hardness}f)`]
    if (b.tool && b.tool !== 'none') s.push('.requiresTool()')
    if (b.light > 0) s.push(`.luminance(state -> ${b.light})`)
    if (b.solid === false) s.push('.nonOpaque()')
    return `    /** ${b.label} */\n` +
      `    public static final Block ${constName(b.name)} = register("${b.name}",\n` +
      `        new Block(AbstractBlock.Settings.create()${s.join('')}));`
  }).join('\n\n')

  const itemGroup = blocks[0]
    ? `\n    /** 把这些方块塞进物品栏的一栏，免得玩家找不到 */\n` +
      `    public static void addToItemGroup(ItemGroup.Entries entries) {\n` +
      blocks.map((b) => `        entries.add(${constName(b.name)});`).join('\n') + '\n    }\n'
    : ''

  return `package ${pkg};

import net.fabricmc.fabric.api.itemgroup.v1.ItemGroupEvents;
import net.minecraft.block.AbstractBlock;
import net.minecraft.block.Block;
import net.minecraft.item.BlockItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemGroup;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.util.Identifier;
import net.minecraft.util.Rarity;

/**
 * 方块注册表 —— 由 DSH 的 mc_mod 工具生成，改的时候改 .mcmod/blocks.json 再重新生成。
 * 一共 ${blocks.length} 个方块。
 */
public final class ModBlocks {

    private ModBlocks() { }

    /** 把方块本体和它的物品形态一起注册 */
    private static Block register(String id, Block block) {
        Identifier ident = Identifier.of(${cls}.MOD_ID, id);
        Registry.register(Registries.BLOCK, ident, block);
        Registry.register(Registries.ITEM, ident, new BlockItem(block, new Item.Settings()));
        return block;
    }

${body}

    /** 模组加载时调用 */
    public static void init() {
        ${cls}.LOGGER.info("注册了 ${blocks.length} 个方块");
    }
${itemGroup}}
`
}

/* ============================ 基岩版 ============================ */

function bedrockBlockJson(modId, b) {
  const components = {
    'minecraft:material_instances': {
      '*': {
        texture: b.name,
        render_method: b.kind === 'plant' ? 'alpha_test' : (b.translucent ? 'blend' : 'opaque'),
      },
    },
    'minecraft:destructible_by_mining': { seconds_to_destroy: b.hardness },
    'minecraft:destructible_by_explosion': { explosion_resistance: Number((b.hardness * 1.5).toFixed(1)) },
    'minecraft:map_color': b.color,
  }
  if (b.light > 0) components['minecraft:light_emission'] = b.light
  if (b.solid === false) components['minecraft:collision_box'] = false

  return {
    format_version: '1.21.0',
    'minecraft:block': {
      description: {
        identifier: `${modId}:${b.name}`,
        menu_category: { category: b.kind === 'plant' ? 'nature' : 'construction' },
      },
      components,
    },
  }
}

/* ============================ 语言文件 ============================ */

async function mergeLang(dir, relPath, entries) {
  const f = join(dir, relPath)
  let data = {}
  if (existsSync(f)) {
    try { data = JSON.parse(await readFile(f, 'utf8')) } catch { /* 坏了就重来 */ }
  }
  Object.assign(data, entries)
  await mkdir(dirname(f), { recursive: true })
  await writeFile(f, JSON.stringify(data, null, 2), 'utf8')
  return relPath
}

/* ============================ 子工具 ============================ */

export default {
  key: 'block',
  title: '方块',
  summary: '生成方块（硬度/工具/发光/贴图），java 和基岩两套一起出',
  params: {
    op: 'add（默认）或 list',
    name: '方块 id，小写字母数字下划线，例如 ruby_block',
    label: '显示名（中文），例如 红宝石块',
    kind: '材质类型，见 blocktex 的 kinds，默认 stone',
    color: '主色 #rrggbb',
    hardness: '硬度秒数，默认 2',
    tool: '要用什么挖：' + TOOLS.join('/') + '，默认 pickaxe',
    light: '发光 0-15，默认 0',
    solid: '是否实心，默认 true',
    translucent: '半透明（玻璃类）',
  },

  async run(ctx, args) {
    const op = String(args.op || 'add').toLowerCase()

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程，或者 args.dir 给路径' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const blocks = await readPart(projDir, 'blocks', [])

    if (op === 'list') {
      return {
        ok: true,
        target: meta.target,
        count: blocks.length,
        blocks: blocks.map((b) => `${b.name}  ${b.label || ''}  ${b.color} 硬度${b.hardness}${b.light ? ' 发光' + b.light : ''}`),
        note: blocks.length ? '' : '还没有方块。用 op:add 加一个。',
      }
    }

    /* ---------------- 加方块 ---------------- */
    const name = String(args.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '').replace(/^(\d)/, 'b$1')
    if (!name) return { ok: false, error: '要给方块起个 id（name），小写字母数字下划线' }
    if (blocks.some((b) => b.name === name)) {
      return { ok: false, error: `方块「${name}」已经在这个工程里了`, hint: '要看现状用 op:list' }
    }

    const kind = String(args.kind || 'stone').toLowerCase()
    if (!TEX_KINDS[kind]) {
      return { ok: false, error: `没有「${kind}」这种材质`, known: Object.keys(TEX_KINDS) }
    }
    const color = String(args.color || '#8a8a8a').trim()
    if (!/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) {
      return { ok: false, error: 'color 要写成 #rrggbb' }
    }
    const tool = String(args.tool || 'pickaxe').toLowerCase()
    if (!TOOLS.includes(tool)) return { ok: false, error: '不认识的工具：' + tool, known: TOOLS }

    const b = {
      name,
      label: String(args.label || name),
      kind,
      color,
      hardness: Math.max(0, Math.min(100, Number(args.hardness) || 2)),
      tool,
      light: Math.max(0, Math.min(15, Math.round(Number(args.light) || 0))),
      solid: args.solid !== false,
      translucent: !!args.translucent,
    }

    /* 先把贴图生成好 —— 没贴图的方块在游戏里是紫黑格 */
    const tex = await blocktex.run(ctx, {
      op: 'make', name, kind, color,
      dir: projDir,
      size: kind === 'plant' ? 16 : 16,
    })
    if (!tex.ok) return { ok: false, error: '贴图没生成出来：' + tex.error, hint: tex.hint }

    blocks.push(b)
    await writePart(projDir, 'blocks', blocks)

    /* 重新渲染目标文件 */
    const written = []
    const long = []
    if (meta.target === 'java') {
      const pkg = 'com.example.' + meta.modId
      const javaDir = join(projDir, 'src/main/java', pkg.replace(/\./g, '/'))
      await mkdir(javaDir, { recursive: true })
      await writeFile(join(javaDir, 'ModBlocks.java'), renderModBlocks(pkg, meta.modId, blocks), 'utf8')
      written.push(`src/main/java/${pkg.replace(/\./g, '/')}/ModBlocks.java`)
      long.push(await mergeLang(projDir, `src/main/resources/assets/${meta.modId}/lang/zh_cn.json`, { [`block.${meta.modId}.${name}`]: b.label }))
      long.push(await mergeLang(projDir, `src/main/resources/assets/${meta.modId}/lang/en_us.json`, { [`block.${meta.modId}.${name}`]: name }))

      /* 外观文件（blockstate + model）—— 缺了的话贴图和代码都对，
         进游戏却是紫黑格，而且不报任何错。所有方块一起重渲染，保持幂等。 */
      const assets = join(projDir, 'src/main/resources/assets', meta.modId)
      for (const x of blocks) {
        const put = async (rel, obj) => {
          const f = join(assets, rel)
          await mkdir(dirname(f), { recursive: true })
          await writeFile(f, JSON.stringify(obj, null, 2) + '\n', 'utf8')
        }
        await put(`blockstates/${x.name}.json`, blockstateJson(meta.modId, x.name))
        await put(`models/block/${x.name}.json`, blockModelJson(meta.modId, x.name, x.kind))
        await put(`models/item/${x.name}.json`, blockItemModelJson(meta.modId, x.name))
      }
      if (blocks.length) {
        long.push(`assets/${meta.modId}/{blockstates,models/block,models/item}/（${blocks.length} 个方块的外观）`)
      }
    } else {
      const bf = join(projDir, 'behavior_pack/blocks', name + '.json')
      await mkdir(dirname(bf), { recursive: true })
      await writeFile(bf, JSON.stringify(bedrockBlockJson(meta.modId, b), null, 2), 'utf8')
      written.push(`behavior_pack/blocks/${name}.json`)
      const lang = `tile.${meta.modId}:${name}.name=${b.label}`
      for (const l of ['zh_CN', 'en_US']) {
        const lf = join(projDir, 'resource_pack/texts', l + '.lang')
        let cur = ''
        try { cur = await readFile(lf, 'utf8') } catch { /* 新建 */ }
        const lines = cur.split(/\r?\n/).filter((x) => x.trim() && !x.startsWith(`tile.${meta.modId}:${name}.name=`))
        lines.push(lang)
        await mkdir(dirname(lf), { recursive: true })
        await writeFile(lf, lines.join('\n') + '\n', 'utf8')
      }
      written.push('resource_pack/texts/*.lang')
    }

    return {
      ok: true,
      name,
      target: meta.target,
      total: blocks.length,
      texture: tex.file,
      generated: written.concat(long),
      color: b.color,
      hardness: b.hardness,
      note: meta.target === 'java'
        ? `注册代码在 ModBlocks.java 里，${mainClass(meta.modId)}.onInitialize() 那行已经调好了 ModBlocks.init()。`
        : '基岩版免编译：把这个工程的 behavior_pack 和 resource_pack 一起打进 .mcaddon 就能用。',
      hint: '再加一个就用同样的 op:add，换个 name。',
    }
  },
}

export const __test = { renderModBlocks, bedrockBlockJson, constName }
