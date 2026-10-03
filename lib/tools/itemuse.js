/*
  itemuse —— 道具用法（子工具 #13）
  ==================================

  让物品"右键有反应"：吃东西、给状态效果、回血、放方块。

  和 item 的协同方式：
    itemuse 只往工程的 .mcmod/uses.json 里记【这个物品有什么用法】，
    真正的 Java 代码由 item.js 重渲染时生成 ——
    因为有特殊用法的物品必须用自定义类（继承 Item 重写 use()），
    而不是 new Item(...)。两边各管一段，谁也别改谁的文件。

  出两套：
    java    → <Name>Item.java（自定义类，重写 use()）
    bedrock → 直接塞进物品 json 的组件里（基岩版不用写代码）
*/
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readMeta, readPart, writePart } from './project.js'
import { syncJavaItems } from './item.js'

const constName = (n) => String(n).toUpperCase().replace(/[^A-Z0-9_]/g, '_')

/** 支持的用法类型 */
const KINDS = {
  food: '可以吃（回饥饿值，可选附带状态效果）',
  effect: '右键给自己一个状态效果（比如速度、隐身）',
  heal: '右键回血',
  place: '右键放置方块（像打火石那样）',
}

/** MC 的状态效果名（Java 版字段名） */
const EFFECTS = [
  'speed', 'slowness', 'haste', 'mining_fatigue', 'strength', 'instant_health',
  'instant_damage', 'jump_boost', 'nausea', 'regeneration', 'resistance',
  'fire_resistance', 'water_breathing', 'invisibility', 'night_vision',
  'hunger', 'weakness', 'poison', 'wither', 'health_boost', 'absorption',
  'saturation', 'glowing', 'levitation', 'slow_falling', 'conduit_power',
  'dolphins_grace', 'blindness', 'darkness',
]

/**
 * 生成 Java 自定义物品类。
 * 注意 Signature：1.21 的 use 返回 TypedActionResult，且要用 world.isClient() 判断端。
 */
export function renderItemUseJava(pkg, modId, use) {
  const cls = constName(use.item) + 'Item'
  const imports = [
    'net.minecraft.entity.player.PlayerEntity',
    'net.minecraft.item.Item',
    'net.minecraft.item.ItemStack',
    'net.minecraft.item.tooltip.TooltipType',
    'net.minecraft.server.world.ServerWorld',
    'net.minecraft.text.Text',
    'net.minecraft.util.Formatting',
    'net.minecraft.util.Hand',
    'net.minecraft.util.TypedActionResult',
    'net.minecraft.world.World',
    'java.util.List',
  ]
  const body = []

  if (use.kind === 'food' || use.kind === 'heal') {
    imports.push('net.minecraft.entity.effect.StatusEffectInstance')
    imports.push('net.minecraft.entity.effect.StatusEffects')
  }
  if (use.kind === 'effect') {
    imports.push('net.minecraft.entity.effect.StatusEffectInstance')
    imports.push('net.minecraft.entity.effect.StatusEffects')
  }
  if (use.kind === 'place') {
    imports.push('net.minecraft.block.Block')
    imports.push('net.minecraft.item.ItemPlacementContext')
    imports.push('net.minecraft.util.hit.BlockHitResult')
    imports.push('net.minecraft.util.math.BlockPos')
    imports.push('net.minecraft.registry.Registries')
    imports.push('net.minecraft.util.Identifier')
  }

  /* ---- use() 主体 ---- */
  let useBody = ''
  if (use.kind === 'food') {
    useBody = `        ItemStack stack = user.getStackInHand(hand);
        if (user.canConsume(${!!use.alwaysEdible})) {
            user.getHungerManager().add(${use.nutrition}, ${use.saturation}f);
            user.getItemCooldownManager().set(this, ${use.cooldown});
            ${use.effect
        ? `user.addStatusEffect(new StatusEffectInstance(StatusEffects.${use.effect.toUpperCase()}, ${use.duration}, ${use.amplifier}));`
        : '/* 没有附加效果 */'}
            if (!user.getAbilities().creativeMode) stack.decrement(1);
            return TypedActionResult.success(stack);
        }
        return TypedActionResult.fail(stack);`
  } else if (use.kind === 'effect') {
    useBody = `        ItemStack stack = user.getStackInHand(hand);
        if (world instanceof ServerWorld) {
            user.addStatusEffect(new StatusEffectInstance(StatusEffects.${String(use.effect || 'speed').toUpperCase()}, ${use.duration}, ${use.amplifier}));
            user.getItemCooldownManager().set(this, ${use.cooldown});
            if (!user.getAbilities().creativeMode) stack.decrement(1);
        }
        return TypedActionResult.success(stack);`
  } else if (use.kind === 'heal') {
    useBody = `        ItemStack stack = user.getStackInHand(hand);
        if (world instanceof ServerWorld) {
            user.heal(${use.amount}f);
            user.getItemCooldownManager().set(this, ${use.cooldown});
            if (!user.getAbilities().creativeMode) stack.decrement(1);
        }
        return TypedActionResult.success(stack);`
  } else {
    useBody = `        ItemStack stack = user.getStackInHand(hand);
        BlockHitResult hit = (BlockHitResult) user.raycast(5.0D, 0.0F, false);
        BlockPos pos = hit.getBlockPos().offset(hit.getSide());
        var block = Registries.BLOCK.get(Identifier.of("${use.block || 'minecraft:stone'}"));
        if (world.getBlockState(pos).isAir()) {
            world.setBlockState(pos, block.getDefaultState());
            if (!user.getAbilities().creativeMode) stack.decrement(1);
            return TypedActionResult.success(stack);
        }
        return TypedActionResult.fail(stack);`
  }

  body.push(`    @Override
    public TypedActionResult<ItemStack> use(World world, PlayerEntity user, Hand hand) {
${useBody}
    }`)

  /* ---- 给个 tooltip，玩家才知道这东西能干嘛 ----
     注意：Java 的字符串是【双引号】，char 才是单引号。
     早先这里写成 '...' 被 javac 判成"未结束的字符串文字"，
     生成的代码一个都编译不过 —— 是拿真 javac 跑出来才发现的。 */
  const tips = []
  if (use.kind === 'food') tips.push(`"吃下后回复 ${use.nutrition} 点饥饿值"`)
  if (use.effect) tips.push(`"${use.effect} 效果 " + (${use.duration} / 20) + " 秒"`)
  if (use.kind === 'heal') tips.push(`"回复 ${use.amount} 点生命"`)
  if (use.kind === 'place') tips.push(`"右键放置 ${use.block}"`)
  if (tips.length) {
    body.push(`    @Override
    public void appendTooltip(ItemStack stack, TooltipContext context, List<Text> tooltip, TooltipType type) {
        ${tips.map((t) => `tooltip.add(Text.literal(${t}).formatted(Formatting.GRAY));`).join('\n        ')}
    }`)
  }

  const uniq = [...new Set(imports)].sort()
  return `package ${pkg};

${uniq.map((i) => 'import ' + i + ';').join('\n')}

/**
 * ${use.label || use.item} 的用法 —— 由 DSH 的 mc_mod 工具生成。
 * 别手改这个文件，改 .mcmod/uses.json 再重新生成。
 */
public class ${cls} extends Item {

    public ${cls}(Settings settings) {
        super(settings);
    }

${body.join('\n\n')}
}
`
}

/** 基岩版：直接往物品 json 的 components 里塞 */
export function bedrockUseComponents(use) {
  const c = {}
  if (use.kind === 'food') {
    c['minecraft:food'] = {
      nutrition: use.nutrition,
      saturation_modifier: 'good',
      can_always_eat: !!use.alwaysEdible,
    }
    if (use.effect) {
      c['minecraft:food'].effects = [{
        name: use.effect,
        duration: use.duration / 20,
        amplifier: use.amplifier,
        chance: 1.0,
      }]
    }
    c['minecraft:use_modifiers'] = { use_duration: 1.6, movement_modifier: 0.35 }
  } else if (use.kind === 'effect' || use.kind === 'heal') {
    c['minecraft:use_modifiers'] = { use_duration: 0.2, movement_modifier: 1.0 }
    /* 基岩版没有"右键给效果"的原生组件，要写脚本；
       这里先挂上可被脚本识别的标记，脚本由 entity/scripts 那边补 */
    c['minecraft:custom_components'] = ['mymod:on_use_effect']
  } else if (use.kind === 'place') {
    c['minecraft:use_modifiers'] = { use_duration: 0.1, movement_modifier: 1.0 }
  }
  return c
}

export default {
  key: 'itemuse',
  title: '道具用法',
  summary: '让物品右键有反应（吃/给效果/回血/放方块）',
  params: {
    op: 'add（默认）或 list 或 kinds',
    item: '给哪个物品加用法（物品 id，要先有这个东西）',
    kind: '用法类型：' + Object.keys(KINDS).join('/'),
    nutrition: 'food 用：回多少饥饿值，默认 4',
    saturation: 'food 用：饱和度，默认 0.3',
    effect: 'effect/food 用：状态效果名，如 speed/regeneration',
    duration: 'effect 用：持续 tick（20 = 1 秒），默认 200',
    amplifier: 'effect 用：等级，0 表示 I 级',
    amount: 'heal 用：回多少血，默认 4',
    block: 'place 用：放什么方块，默认 minecraft:stone',
    cooldown: '冷却 tick，默认 20',
  },

  async run(ctx, args) {
    const op = String(args.op || 'add').toLowerCase()

    if (op === 'kinds') {
      return {
        ok: true,
        kinds: Object.entries(KINDS).map(([k, v]) => k + ' — ' + v),
        effects: EFFECTS.join(' '),
      }
    }

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const uses = await readPart(projDir, 'uses', [])
    const items = await readPart(projDir, 'items', [])

    if (op === 'list') {
      return {
        ok: true,
        count: uses.length,
        uses: uses.map((u) => `${u.item}  ${u.kind}`),
        note: uses.length ? '' : '还没有用法。用 op:add 加一个。',
      }
    }

    const item = String(args.item || '').trim().replace(/^[a-z_]+:/, '').toLowerCase().replace(/[^a-z0-9_]/g, '_')
    if (!item) return { ok: false, error: '要指定给哪个物品加用法（item）' }
    if (!items.some((i) => i.name === item)) {
      return {
        ok: false,
        error: `工程里没有「${item}」这个物品`,
        known: items.map((i) => i.name),
        hint: '先用 do:item 把物品加进来',
      }
    }

    const kind = String(args.kind || 'food').toLowerCase()
    if (!KINDS[kind]) return { ok: false, error: `没有「${kind}」这种用法`, known: Object.keys(KINDS) }

    const effect = String(args.effect || (kind === 'effect' ? 'speed' : '')).toLowerCase()
    if (effect && !EFFECTS.includes(effect)) {
      return { ok: false, error: `不认识的状态效果「${effect}」`, known: EFFECTS }
    }

    const u = {
      item,
      label: (items.find((i) => i.name === item) || {}).label || item,
      kind,
      nutrition: Math.max(0, Math.min(20, Math.round(Number(args.nutrition === undefined ? 4 : args.nutrition)))),
      saturation: Math.max(0, Math.min(20, Number(args.saturation === undefined ? 0.3 : args.saturation))),
      effect,
      duration: Math.max(1, Math.round(Number(args.duration) || 200)),
      amplifier: Math.max(0, Math.min(9, Math.round(Number(args.amplifier) || 0))),
      amount: Math.max(0, Math.min(20, Number(args.amount === undefined ? 4 : args.amount))),
      block: String(args.block || 'minecraft:stone'),
      cooldown: Math.max(0, Math.round(Number(args.cooldown === undefined ? 20 : args.cooldown))),
      alwaysEdible: !!args.alwaysEdible,
    }

    const next = uses.filter((x) => x.item !== item)
    next.push(u)
    await writePart(projDir, 'uses', next)

    const written = []
    if (meta.target === 'java') {
      const pkg = 'com.example.' + meta.modId
      const javaDir = join(projDir, 'src/main/java', pkg.replace(/\./g, '/'))
      await mkdir(javaDir, { recursive: true })
      const cls = constName(item) + 'Item'
      await writeFile(join(javaDir, cls + '.java'), renderItemUseJava(pkg, meta.modId, u), 'utf8')
      written.push(`src/main/java/${pkg.replace(/\./g, '/')}/${cls}.java`)

      /* 关键一步：立刻重渲染 ModItems，把 new Item(...) 换成 <Name>Item(...)。
         不换的话类文件生成了也没人用，右键还是没反应 —— 这一步不能让模型自己记得做。 */
      const itemsNow = await readPart(projDir, 'items', [])
      written.push(...await syncJavaItems(projDir, meta, itemsNow, next))
    } else {
      /* 基岩版：把组件并进物品 json */
      const f = join(projDir, 'behavior_pack/items', item + '.json')
      const j = existsSync(f) ? JSON.parse(await (await import('node:fs/promises')).readFile(f, 'utf8')) : null
      if (j && j['minecraft:item']) {
        Object.assign(j['minecraft:item'].components, bedrockUseComponents(u))
        await writeFile(f, JSON.stringify(j, null, 2), 'utf8')
        written.push(`behavior_pack/items/${item}.json（塞进了用法组件）`)
      } else {
        return { ok: false, error: '找不到这个物品的 json，先用 do:item 加物品' }
      }
    }

    return {
      ok: true,
      item,
      kind,
      target: meta.target,
      generated: written,
      note: meta.target === 'java'
        ? '还得让 do:item 重新渲染一次，把 ModItems 里的 new Item(...) 换成这个自定义类。'
        : '基岩版的"右键给效果"需要 Script API，组件已经挂好标记了。',
      hint: '接着跑一次 do:item（op:list 就行）会自动接上自定义类。',
    }
  },
}

export const __test = { KINDS, EFFECTS, renderItemUseJava, bedrockUseComponents, constName }
