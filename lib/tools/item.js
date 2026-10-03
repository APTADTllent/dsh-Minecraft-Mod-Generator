/*
  item —— 物品生成（子工具 #11）
  ================================

  一份物品描述出两套：
    java    → ModItems.java + 语言文件 + 物品栏归类
    bedrock → behavior_pack/items/<name>.json + 语言文件

  和 block 一样是"数据存清单、目标文件整体重渲染"，改多少次都不会漂。
  贴图交给 itemtex 一起生成（没图标在游戏里是紫黑格）。
*/
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readMeta, readPart, writePart } from './project.js'
import itemtex from './itemtex.js'
import { SHAPE_NAMES } from '../shapes.js'
import { itemModelJson } from '../javamodels.js'
import { mainClass } from '../naming.js'

const constName = (n) => String(n).toUpperCase().replace(/[^A-Z0-9_]/g, '_')

/** MC 的物品栏分类（Java 版）。itemuse 也要用它，所以要导出。 */
export const GROUPS = {
  ingredients: 'INGREDIENTS（材料）',
  tools: 'TOOLS（工具）',
  combat: 'COMBAT（战斗）',
  food: 'FOOD_AND_DRINK（食物）',
  building: 'BUILDING_BLOCKS（建筑方块）',
  natural: 'NATURAL（自然）',
  functional: 'FUNCTIONAL（功能）',
  redstone: 'REDSTONE（红石）',
  misc: 'MISC（杂项）',
}

/* ============================ Fabric（Java） ============================ */

/**
 * @param uses 该工程的"道具用法"清单（itemuse 写的）。
 *   有自定义用法的物品必须用 <Name>Item 这个类（重写了 use()），
 *   而不是普通的 new Item(...) —— 这里就是两个子工具接上的地方。
 */
function renderModItems(pkg, modId, items, uses = []) {
  /* 主类名按 modId 推 —— 以前这里写死 MyMod，生成的代码编译不过 */
  const mainCls = mainClass(modId)
  const useMap = new Map(uses.map((u) => [u.item, u]))

  const body = items.map((it) => {
    const s = []
    if (it.stack !== 64) s.push(`.maxCount(${it.stack})`)
    if (it.rarity && it.rarity !== 'common') s.push(`.rarity(Rarity.${it.rarity.toUpperCase()})`)
    if (it.fireproof) s.push('.fireproof()')
    const hasUse = useMap.has(it.name)
    const cls = hasUse ? constName(it.name) + 'Item' : 'Item'
    const tag = hasUse ? `（自定义用法：${useMap.get(it.name).kind}）` : ''
    return `    /** ${it.label}${tag} */\n` +
      `    public static final Item ${constName(it.name)} = register("${it.name}",\n` +
      `        new ${cls}(new Item.Settings()${s.join('')}));`
  }).join('\n\n')

  /* 按物品栏分组归类 —— 不归类玩家只能在搜索里找到 */
  const byGroup = {}
  for (const it of items) {
    const g = GROUPS[it.group] ? it.group : 'ingredients'
    ;(byGroup[g] = byGroup[g] || []).push(it)
  }
  const groupLines = Object.entries(byGroup).map(([g, list]) =>
    `        /* ${GROUPS[g]} */\n` +
    `        ItemGroupEvents.modifyEntriesEvent(ItemGroups.${g.toUpperCase()}).register(entries -> {\n` +
    list.map((it) => `            entries.add(${constName(it.name)});`).join('\n') +
    '\n        });'
  ).join('\n')

  return `package ${pkg};

import net.fabricmc.fabric.api.itemgroup.v1.ItemGroupEvents;
import net.minecraft.item.Item;
import net.minecraft.item.ItemGroups;
import net.minecraft.util.Rarity;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.util.Identifier;

/**
 * 物品注册表 —— 由 DSH 的 mc_mod 工具生成，一共 ${items.length} 个。
 * 要改就改 .mcmod/items.json 再重新生成，别手改这个文件。
 */
public final class ModItems {

    private ModItems() { }

    private static Item register(String id, Item item) {
        return Registry.register(Registries.ITEM, Identifier.of(${mainCls}.MOD_ID, id), item);
    }

${body}

    public static void init() {
${groupLines}
        ${mainCls}.LOGGER.info("注册了 ${items.length} 个物品");
    }
}
`
}

/* ============================ 基岩版 ============================ */

function bedrockItemJson(modId, it) {
  const components = {
    /* 基岩版用 icon 指向 item_texture.json 里登记的键 */
    'minecraft:icon': it.name,
    'minecraft:max_stack_size': it.stack,
    'minecraft:display_name': { value: it.label },
  }
  return {
    format_version: '1.21.0',
    'minecraft:item': {
      description: {
        identifier: `${modId}:${it.name}`,
        menu_category: { category: it.group === 'food' ? 'nature' : 'items' },
      },
      components,
    },
  }
}

async function mergeLang(dir, relPath, entries) {
  const f = join(dir, relPath)
  let data = {}
  if (existsSync(f)) {
    try { data = JSON.parse(await readFile(f, 'utf8')) } catch { /* 重来 */ }
  }
  Object.assign(data, entries)
  await mkdir(dirname(f), { recursive: true })
  await writeFile(f, JSON.stringify(data, null, 2), 'utf8')
  return relPath
}

/** ModItems.java 与语言文件的落点 */
export function javaItemPaths(projDir, modId) {
  const pkg = 'com.example.' + modId
  const rel = pkg.replace(/\./g, '/')
  return {
    pkg,
    java: join(projDir, 'src/main/java', rel, 'ModItems.java'),
    langZh: `src/main/resources/assets/${modId}/lang/zh_cn.json`,
    langEn: `src/main/resources/assets/${modId}/lang/en_us.json`,
  }
}

/**
 * 重新渲染 java 侧的物品注册表。
 *
 * 单独抽出来是因为 itemuse 也要调它：用法加完之后必须把
 * new Item(...) 换成自定义的 <Name>Item(...)，否则右键没反应。
 * 让模型记得"再加一次 item"是把负担推给模型，还多烧一轮 token。
 */
export async function syncJavaItems(projDir, meta, items, uses) {
  const p = javaItemPaths(projDir, meta.modId)
  await mkdir(dirname(p.java), { recursive: true })
  await writeFile(p.java, renderModItems(p.pkg, meta.modId, items, uses), 'utf8')
  const zh = await mergeLang(projDir, p.langZh,
    Object.fromEntries(items.map((it) => [`item.${meta.modId}.${it.name}`, it.label])))
  const en = await mergeLang(projDir, p.langEn,
    Object.fromEntries(items.map((it) => [`item.${meta.modId}.${it.name}`, it.name])))

  /* 物品的模型文件 —— 缺了游戏里也是紫黑格，同样不报错。
     方块也会写 models/item/<名字>.json（借用方块模型），同名的互相覆盖，
     这是对的：本来就该同名同物。 */
  const assets = join(projDir, 'src/main/resources/assets', meta.modId)
  for (const it of items) {
    const f = join(assets, 'models/item', it.name + '.json')
    await mkdir(dirname(f), { recursive: true })
    await writeFile(f, JSON.stringify(itemModelJson(meta.modId, it.name), null, 2) + '\n', 'utf8')
  }

  return [
    p.java.replace(projDir + '\\', ''), zh, en,
    items.length ? `assets/${meta.modId}/models/item/（${items.length} 个物品的模型）` : '',
  ].filter(Boolean)
}

export default {
  key: 'item',
  title: '物品',
  summary: '生成物品（堆叠数/稀有度/物品栏分类/贴图），java 和基岩两套一起出',
  params: {
    op: 'add（默认）或 list',
    name: '物品 id，小写字母数字下划线，例如 ruby',
    label: '显示名（中文），例如 红宝石',
    shape: '图标形状，见 itemtex 的 shapes：' + SHAPE_NAMES.join('/'),
    color: '图标主色 #rrggbb',
    second: '可选：图标次色',
    stack: '堆叠上限，默认 64',
    rarity: '稀有度 common/uncommon/rare/epic',
    group: '物品栏分类：' + Object.keys(GROUPS).join('/'),
  },

  async run(ctx, args) {
    const op = String(args.op || 'add').toLowerCase()

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程，或 args.dir 给路径' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const items = await readPart(projDir, 'items', [])
    /* 道具用法是 itemuse 写的 —— 有自定义用法的物品要换成自定义类 */
    const uses = await readPart(projDir, 'uses', [])
    const useMap = new Map(uses.map((u) => [u.item, u]))

    if (op === 'list') {
      return {
        ok: true,
        target: meta.target,
        count: items.length,
        items: items.map((it) => `${it.name}  ${it.label || ''}  ${it.color}  ${it.shape}`),
        note: items.length ? '' : '还没有物品。用 op:add 加一个。',
      }
    }

    const name = String(args.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '').replace(/^(\d)/, 'i$1')
    if (!name) return { ok: false, error: '要给物品起个 id（name）' }
    if (items.some((it) => it.name === name)) {
      return { ok: false, error: `物品「${name}」已经在这个工程里了`, hint: '看现状用 op:list' }
    }

    const shape = String(args.shape || 'gem').toLowerCase()
    if (!SHAPE_NAMES.includes(shape)) {
      return { ok: false, error: `没有「${shape}」这种形状`, known: SHAPE_NAMES }
    }
    const color = String(args.color || '#c0203a').trim()
    if (!/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) {
      return { ok: false, error: 'color 要写成 #rrggbb' }
    }
    const rarity = String(args.rarity || 'common').toLowerCase()
    if (!['common', 'uncommon', 'rare', 'epic'].includes(rarity)) {
      return { ok: false, error: 'rarity 只能是 common/uncommon/rare/epic' }
    }
    const group = String(args.group || 'ingredients').toLowerCase()
    if (!GROUPS[group]) return { ok: false, error: '不认识的物品栏分类：' + group, known: Object.keys(GROUPS) }

    const it = {
      name,
      label: String(args.label || name),
      shape,
      color,
      second: args.second ? String(args.second) : '',
      stack: Math.max(1, Math.min(64, Math.round(Number(args.stack) || 64))),
      rarity,
      group,
    }

    const tex = await itemtex.run(ctx, {
      op: 'make', name, shape, color, second: it.second || undefined, dir: projDir,
    })
    if (!tex.ok) return { ok: false, error: '图标没生成出来：' + tex.error, hint: tex.hint }

    items.push(it)
    await writePart(projDir, 'items', items)

    const written = []
    if (meta.target === 'java') {
      written.push(...await syncJavaItems(projDir, meta, items, uses))
    } else {
      const f = join(projDir, 'behavior_pack/items', name + '.json')
      await mkdir(dirname(f), { recursive: true })
      await writeFile(f, JSON.stringify(bedrockItemJson(meta.modId, it), null, 2), 'utf8')
      written.push(`behavior_pack/items/${name}.json`)
    }

    return {
      ok: true,
      name,
      target: meta.target,
      total: items.length,
      icon: tex.file,
      generated: written,
      color: it.color,
      stack: it.stack,
      note: meta.target === 'java'
        ? `注册代码在 ModItems.java 里，${mainClass(meta.modId)}.onInitialize() 那行已经调好了。`
        : '基岩版免编译。',
      hint: '要让它能合成，接着用 do:recipe；要让右键有反应，用 do:itemuse。',
    }
  },
}

export const __test = { renderModItems, bedrockItemJson, GROUPS, constName }
