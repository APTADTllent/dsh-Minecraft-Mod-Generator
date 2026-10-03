/*
  brewing —— 酿造配方（子工具 #10）
  ===================================

  把状态效果做成能喝的药水。

  Java 版：药水（Potion）+ 酿造配方（BrewingRecipe）两样都要注册。
           药水归 Registries.POTION；配方挂在 BrewingRecipeRegistry 上。
           【完整可用】，但版本之间这个 API 有改动，注释里标了。

  基岩版：附加包【不能新增酿造配方】—— 和状态效果一样是平台限制。
          只能给说明 + 脚本替代方案（用物品右键直接给效果）。

  一条完整的药水链是这样：
    粗制的药水（awkward） + 你的材料 → 你的药水 → 加萤石粉升级到 II 级
*/
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readMeta, readPart, writePart } from './project.js'
import { mainClass } from '../naming.js'

const constName = (n) => String(n).toUpperCase().replace(/[^A-Z0-9_]/g, '_')
const className = (n) => String(n).replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase())
const potionClass = (n) => {
  const base = className(n)
  return base.toLowerCase().endsWith('potion') ? base : base + 'Potion'
}

/** 酿造基底（MC 里所有药水都从这几样开始） */
export const BASES = {
  awkward: { label: '粗制的药水（最常用）', vanilla: 'AWKWARD', item: 'minecraft:nether_wart' },
  water: { label: '水瓶（直接加水）', vanilla: 'WATER', item: 'minecraft:water_bucket' },
  thick: { label: '浓稠的药水', vanilla: 'THICK', item: 'minecraft:glowstone_dust' },
  mundane: { label: '平凡的药水', vanilla: 'MUNDANE', item: 'minecraft:ghast_tear' },
}

/** 酿造材料（决定"加什么进去变成你的药水"） */
export const INGREDIENTS = [
  'minecraft:redstone', 'minecraft:glowstone_dust', 'minecraft:gunpowder',
  'minecraft:dragon_breath', 'minecraft:fermented_spider_eye', 'minecraft:sugar',
  'minecraft:rabbit_foot', 'minecraft:glistering_melon_slice', 'minecraft:blaze_powder',
  'minecraft:magma_cream', 'minecraft:pufferfish', 'minecraft:golden_carrot',
  'minecraft:turtle_helmet', 'minecraft:phantom_membrane',
]

export const BASE_KEYS = Object.keys(BASES)

/* ============================ Java ============================ */

export function renderModPotions(pkg, modId, list) {
  /* 主类名按 modId 推 —— 以前这里写死 MyMod，生成的代码编译不过 */
  const mainCls = mainClass(modId)
  const body = list.map((p) => {
    const cls = potionClass(p.name)
    /* 单效果用 Potion 的构造器就够；多效果/自定义时长要写注册时带多个 StatusEffectInstance */
    return `    /** ${p.label} —— ${p.effectLabel}，${p.seconds} 秒${p.amplifier > 0 ? '（' + (p.amplifier + 1) + ' 级）' : ''} */\n` +
      `    public static final Potion ${constName(p.name)} = Registry.register(\n` +
      `        Registries.POTION,\n` +
      `        Identifier.of(${mainCls}.MOD_ID, "${p.name}"),\n` +
      `        new Potion(new StatusEffectInstance(ModEffects.${constName(p.effect)}, ${p.ticks}, ${p.amplifier}))\n` +
      `    );`
  }).join('\n\n')

  return `package ${pkg};

import net.minecraft.entity.effect.StatusEffectInstance;
import net.minecraft.potion.Potion;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.util.Identifier;

/**
 * 药水注册表 —— 由 DSH 的 mc_mod 工具生成，一共 ${list.length} 瓶。
 * 注意：药水注册了只是"存在"，还要有酿造配方才知道怎么得到它（见 registerBrewing）。
 */
public final class ModPotions {

    private ModPotions() { }

${body}

    public static void init() {
        ${mainCls}.LOGGER.info("注册了 ${list.length} 瓶药水");
    }

    /**
     * 酿造配方 —— 挂到原版的酿造台上。
     *
     * 【版本提示】BrewingRecipeRegistry 这套 API 在 1.20.5 / 1.21 之间改过
     * （从静态 registerPotionRecipe 变成 PotionRecipe 注册）。
     * 编译报错的话，看这一行，其余结构不用动。
     */
    public static void registerBrewing() {
${list.map((p) => `        // ${p.label}：${p.baseLabel} + ${p.ingredient} → ${p.label}\n` +
    `        BrewingRecipeRegistry.registerPotionRecipe(\n` +
    `            net.minecraft.potion.Potions.${p.baseVanilla},\n` +
    `            net.minecraft.item.Items.${String(p.ingredient).replace('minecraft:', '').toUpperCase()},\n` +
    `            ModPotions.${constName(p.name)}\n` +
    `        );`).join('\n\n')}
    }
}
`
}

/* ============================ 基岩版说明 ============================ */

export function renderBedrockNote(modId, list) {
  const L = [
    '# 基岩版酿造：为什么只能绕路',
    '',
    '> 由 DSH 的 mc_mod 工具生成。',
    '',
    '## 结论先说',
    '',
    '**基岩版的附加包不能新增酿造配方。** 酿造台那一套配方写死在游戏里，',
    '附加包只能改材质和文字，加不了新配方。这是平台限制，不是工具没做。',
    '',
    '## 两条能走的路',
    '',
    '### 路 1：普通物品当药水用（推荐，简单）',
    '',
    '做一个物品，右键直接给效果 —— 玩家根本分不出和自己酿的区别：',
    '',
    '```js',
    'import { world } from "@minecraft/server";',
    '',
    'world.afterEvents.itemUse.subscribe((ev) => {',
    '    if (ev.itemStack?.typeId !== "' + modId + ':你的药水物品") return;',
    '    ev.source.addEffect("' + (list[0] ? (list[0].vanilla || 'speed') : 'speed') + '", ' +
      (list[0] ? list[0].ticks : 3600) + ', { amplifier: ' + (list[0] ? list[0].amplifier : 0) + ' });',
    '});',
    '```',
    '',
    '记得：物品 json 里挂 `minecraft:use_modifiers`，行为包 manifest 声明 scripts 模块，',
    '地图要开实验性玩法（Beta APIs）。',
    '',
    '### 路 2：覆盖原版药水（改材质+文字）',
    '',
    '把某个不常用的原版药水（比如"神龟大师"）的资源包贴图和 `texts/*.lang` 换掉，',
    '行为包那边不用动 —— 玩家看到的就是你的药水。缺点是效果还是原来那个。',
    '',
    '## 你这次要的药水',
    '',
    '| 药水 | 挂在哪个基底 | 加什么 | 对应原版效果 |',
    '|---|---|---|---|',
  ]
  for (const p of list) {
    L.push(`| ${p.label} | ${p.baseLabel} | ${p.ingredient} | ${p.vanilla || '（自定义）'} |`)
  }
  L.push('')
  return L.join('\n')
}

export default {
  key: 'brewing',
  title: '酿造',
  summary: '做药水（基底+材料→药水）；java 能自定义配方，基岩版只能绕路',
  params: {
    op: 'add（默认）或 list 或 bases',
    name: '药水名，小写字母数字下划线，例如 ruby_potion',
    label: '显示名（中文），例如 红石药水',
    effect: '给哪个效果（效果 id，要先有它）',
    base: '酿造基底：' + BASE_KEYS.join('/'),
    ingredient: '加什么材料变成这瓶药，例如 minecraft:redstone',
    seconds: '持续秒数，默认 180（3 分钟）',
    amplifier: '等级，0 表示 I 级，默认 0',
  },

  async run(ctx, args) {
    const op = String(args.op || 'add').toLowerCase()

    if (op === 'bases') {
      return {
        ok: true,
        bases: Object.entries(BASES).map(([k, v]) => `${k.padEnd(10)} ${v.label}`),
        ingredients: INGREDIENTS,
        note: '药水 = 基底 + 材料。材料换成红石加时长、萤石粉加等级。',
      }
    }

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const list = await readPart(projDir, 'potions', [])
    const effects = await readPart(projDir, 'effects', [])

    if (op === 'list') {
      return {
        ok: true,
        count: list.length,
        potions: list.map((p) => `${p.name}  ${p.label}  ${p.baseLabel}+${p.ingredient}  ${p.seconds}s`),
        note: list.length ? '' : '还没有药水。用 op:add 加一个。',
      }
    }

    const name = String(args.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '').replace(/^(\d)/, 'p$1')
    if (!name) return { ok: false, error: '要给这瓶药起个名字（name）' }
    if (list.some((p) => p.name === name)) {
      return { ok: false, error: `药水「${name}」已经在这个工程里了` }
    }

    const effectId = String(args.effect || '').trim().replace(/^[a-z_]+:/, '').toLowerCase()
    if (!effectId) return { ok: false, error: '要指定用哪个效果（effect）' }
    const eff = effects.find((e) => e.name === effectId)
    if (!eff) {
      return {
        ok: false,
        error: `工程里没有「${effectId}」这个效果`,
        known: effects.map((e) => e.name),
        hint: '先用 do:effect 把效果加进来',
      }
    }

    const base = String(args.base || 'awkward').toLowerCase()
    if (!BASES[base]) return { ok: false, error: `不认识的酿造基底「${base}」`, known: BASE_KEYS }

    const ingredient = String(args.ingredient || 'minecraft:redstone').trim()
    if (!/^[a-z_]+:[a-z_]+$/.test(ingredient)) {
      return { ok: false, error: '材料要写成 minecraft:xxx 这样' }
    }

    const p = {
      name,
      label: String(args.label || name),
      effect: effectId,
      effectLabel: eff.label,
      base,
      baseLabel: BASES[base].label,
      baseVanilla: BASES[base].vanilla,
      ingredient,
      seconds: Math.max(1, Math.min(3600, Math.round(Number(args.seconds) || 180))),
      amplifier: Math.max(0, Math.min(9, Math.round(Number(args.amplifier) || 0))),
      /* 基岩版替代方案要用的原版效果名 */
      vanilla: ({ heal: 'regeneration', damage: 'poison', speed: 'speed', armor: 'resistance',
        strength: 'strength', jump: 'jump_boost', nightVision: 'night_vision',
        fireResist: 'fire_resistance', waterBreathing: 'water_breathing', glowing: 'glowing' })[eff.kind] || 'speed',
    }
    p.ticks = p.seconds * 20

    list.push(p)
    await writePart(projDir, 'potions', list)

    const written = []
    if (meta.target === 'java') {
      const pkg = 'com.example.' + meta.modId
      const dir = join(projDir, 'src/main/java', pkg.replace(/\./g, '/'))
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'ModPotions.java'), renderModPotions(pkg, meta.modId, list), 'utf8')
      written.push('ModPotions.java')

      /* 提示要把 registerBrewing 接上 */
      written.push(`（${mainClass(meta.modId)}.onInitialize() 里已经调好了 ModPotions.registerBrewing()）`)
    } else {
      const f = join(projDir, 'brewing-notes', '基岩版酿造说明.md')
      await mkdir(join(projDir, 'brewing-notes'), { recursive: true })
      await writeFile(f, renderBedrockNote(meta.modId, list), 'utf8')
      written.push('brewing-notes/基岩版酿造说明.md')
    }

    return {
      ok: true,
      name,
      label: p.label,
      target: meta.target,
      recipe: `${p.baseLabel} + ${p.ingredient}`,
      effect: `${eff.label}（${p.seconds} 秒${p.amplifier > 0 ? '，' + (p.amplifier + 1) + ' 级' : ''}）`,
      total: list.length,
      generated: written,
      note: meta.target === 'java'
        ? '药水和酿造配方都生成了。'
        : '★ 基岩版不能新增酿造配方（平台限制）—— 生成了两条绕路方案。',
      hint: '同一瓶药加萤石粉能有 II 级，加红石能延长时间 —— 那是原版机制，不用额外做。',
    }
  },
}

export const __test = { BASES, INGREDIENTS, BASE_KEYS, potionClass, renderModPotions, renderBedrockNote }
