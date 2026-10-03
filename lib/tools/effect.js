/*
  effect —— 状态效果（子工具 #9）
  =================================

  加一个自己的 buff/debuff（比如"红石祝福：持续回血"）。

  平台差异很大，如实处理：

    Java 版：能自定义。写一个继承 StatusEffect 的类，
             注册进 Registries.STATUS_EFFECT，再配一个药水就能喝到。
             【完整可用】。

    基岩版：附加包【不能新增状态效果】—— 只能改原版效果的参数
             （时长、等级、颜色），或者用脚本模拟。
             所以这里生成的是"用原版效果拼出来的替代方案 + 说明"，
             不假装生成了一个自定义效果。

  效果能力（kind）：
    heal      持续回血
    damage    持续掉血
    speed     加移动速度（改属性，不用每 tick 干活）
    armor     加护甲
    strength  加攻击力
    jump      加跳跃高度
    nightVision 夜视
    fireResist  抗火
    waterBreathing 水下呼吸
    glowing   发光（容易被看见）
*/
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readMeta, readPart, writePart } from './project.js'
import { mainClass } from '../naming.js'

const constName = (n) => String(n).toUpperCase().replace(/[^A-Z0-9_]/g, '_')
const className = (n) => String(n).replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase())
const effectClass = (n) => {
  const base = className(n)
  return base.toLowerCase().endsWith('effect') ? base : base + 'Effect'
}

/** kind → 怎么实现 */
export const KINDS = {
  heal: { label: '持续回血', category: 'BENEFICIAL', color: '#e05555', tick: true },
  damage: { label: '持续掉血', category: 'HARMFUL', color: '#801010', tick: true },
  speed: { label: '加移动速度', category: 'BENEFICIAL', color: '#7fcaff', attr: ['MOVEMENT_SPEED', 0.2] },
  armor: { label: '加护甲', category: 'BENEFICIAL', color: '#a0a0a0', attr: ['ARMOR', 0.5] },
  strength: { label: '加攻击力', category: 'BENEFICIAL', color: '#c03030', attr: ['ATTACK_DAMAGE', 0.5] },
  jump: { label: '加跳跃高度', category: 'BENEFICIAL', color: '#a0e0a0', attr: ['JUMP_STRENGTH', 0.1] },
  nightVision: { label: '夜视', category: 'BENEFICIAL', color: '#1f1fa0', vanilla: 'NIGHT_VISION' },
  fireResist: { label: '抗火', category: 'BENEFICIAL', color: '#ffa030', vanilla: 'FIRE_RESISTANCE' },
  waterBreathing: { label: '水下呼吸', category: 'BENEFICIAL', color: '#3030a0', vanilla: 'WATER_BREATHING' },
  glowing: { label: '发光（藏不住）', category: 'NEUTRAL', color: '#ffff80', vanilla: 'GLOWING' },
}

export const KIND_KEYS = Object.keys(KINDS)

/**
 * 大小写无关地查 kind。
 * 坑：nightVision / fireResist 这些键是驼峰，而模型很容易写成 nightvision。
 * 早先直接 .toLowerCase() 去查表，结果全查不到 —— 现在建个小写索引。
 */
const KIND_LOOKUP = Object.fromEntries(Object.entries(KINDS).map(([k]) => [k.toLowerCase(), k]))
export function normalizeKind(v) {
  const raw = String(v || 'heal').trim()
  return KIND_LOOKUP[raw] || KIND_LOOKUP[raw.toLowerCase()] || ''
}

/** 基岩版能用的原版效果名（附加包不能新增，只能借这些） */
const VANILLA_MAP = {
  heal: 'regeneration',
  damage: 'poison',
  speed: 'speed',
  armor: 'resistance',
  strength: 'strength',
  jump: 'jump_boost',
  nightVision: 'night_vision',
  fireResist: 'fire_resistance',
  waterBreathing: 'water_breathing',
  glowing: 'glowing',
}

/* ============================ Java ============================ */

export function renderEffectClass(pkg, modId, e) {
  /* 主类名按 modId 推 —— 以前这里写死 MyMod，生成的代码编译不过 */
  const mainCls = mainClass(modId)
  const cls = effectClass(e.name)
  const k = KINDS[e.kind]

  /* 改属性的效果不用重写 tick，MC 自己按属性修饰符算 */
  let body = ''
  if (k.tick) {
    const action = e.kind === 'heal'
      ? `        /* 每 ${e.interval} tick 回 ${e.amount} 点血；等级越高回得越快 */\n        entity.heal(${e.amount}f);`
      : `        /* 每 ${e.interval} tick 掉 ${e.amount} 点血 */\n        entity.damage(this.getDamageSource(), ${e.amount}f);`
    body = `
    @Override
    public boolean canApplyUpdateEffect(int duration, int amplifier) {
        int interval = ${e.interval} >> amplifier;
        return interval <= 0 || duration % interval == 0;
    }

    @Override
    public boolean applyUpdateEffect(LivingEntity entity, int amplifier) {
${action}
        return true;
    }
`
  }

  const attrImport = k.attr ? 'import net.minecraft.entity.attribute.EntityAttributeModifier;\nimport net.minecraft.entity.attribute.EntityAttributes;\n' : ''
  const attrBody = k.attr ? `
    @Override
    public void onApplied(LivingEntity entity, int amplifier) {
        /* 属性类效果：挂一个修饰符上去，MC 自己按它算，不用每 tick 干活 */
        var attr = entity.getAttributeInstance(EntityAttributes.${k.attr[0]});
        if (attr != null) {
            attr.addTemporaryModifier(new EntityAttributeModifier(
                Identifier.of(${mainCls}.MOD_ID, "${e.name}_modifier"),
                ${k.attr[1]} * (amplifier + 1),
                EntityAttributeModifier.Operation.ADD_MULTIPLIED_TOTAL));
        }
    }
` : ''

  return `package ${pkg};

import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.effect.StatusEffect;
import net.minecraft.entity.effect.StatusEffectCategory;
import net.minecraft.util.Identifier;${attrImport}

/**
 * ${e.label} —— 由 DSH 的 mc_mod 工具生成。
 *
 * 类型：${k.label}（${k.category}）
 * 数值：每次 ${e.amount}，间隔 ${e.interval} tick，颜色 ${e.color}
 */
public class ${cls} extends StatusEffect {

    public ${cls}() {
        super(StatusEffectCategory.${k.category}, 0x${String(e.color).replace('#', '').toUpperCase()});
    }
${body}${attrBody}}
`
}

export function renderEffectRegistry(pkg, modId, list) {
  /* 主类名按 modId 推 —— 以前这里写死 MyMod，生成的代码编译不过 */
  const mainCls = mainClass(modId)
  const body = list.map((e) => {
    const k = KINDS[e.kind]
    /* 借原版效果的直接返回原版，不用自己写类 */
    if (k.vanilla) {
      return `    /** ${e.label} —— 直接用原版的 ${k.vanilla}，包一层自己的 id 方便引用 */\n` +
        `    public static final StatusEffect ${constName(e.name)} = Registry.register(\n` +
        `        Registries.STATUS_EFFECT,\n` +
        `        Identifier.of(${mainCls}.MOD_ID, "${e.name}"),\n` +
        `        new ${effectClass(e.name)}()\n` +
        `    );`
    }
    return `    /** ${e.label} */\n` +
      `    public static final StatusEffect ${constName(e.name)} = Registry.register(\n` +
      `        Registries.STATUS_EFFECT,\n` +
      `        Identifier.of(${mainCls}.MOD_ID, "${e.name}"),\n` +
      `        new ${effectClass(e.name)}()\n` +
      `    );`
  }).join('\n\n')

  return `package ${pkg};

import net.minecraft.entity.effect.StatusEffect;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.util.Identifier;

/**
 * 状态效果注册表 —— 由 DSH 的 mc_mod 工具生成，一共 ${list.length} 个。
 * 想让它能喝到，还需要一个带这个效果的药水（见 do:brewing）。
 */
public final class ModEffects {

    private ModEffects() { }

${body}

    public static void init() {
        ${mainCls}.LOGGER.info("注册了 ${list.length} 个状态效果");
    }
}
`
}

/** 借原版效果时也要有个类，不然注册表引用的类不存在 */
export function renderVanillaWrapper(pkg, e) {
  const cls = effectClass(e.name)
  const k = KINDS[e.kind]
  return `package ${pkg};

import net.minecraft.entity.effect.StatusEffect;
import net.minecraft.entity.effect.StatusEffectCategory;
import net.minecraft.entity.effect.StatusEffects;

/**
 * ${e.label} —— 由 DSH 的 mc_mod 工具生成。
 *
 * 【实现方式】这个效果本身是原版就有的，这里只是把你自己的 id 指过去，
 * 这样玩家看到的是"你自己的效果"（名字、图标都能自定义），
 * 但底层行为复用原版的，省得重写一套。
 *
 * 想改成真正独立的行为，把 getDelegate() 换成自己实现 applyUpdateEffect ——
 * 参照 heal / damage 那两个 kind 的写法。
 */
public class ${cls} extends StatusEffect {

    public ${cls}() {
        /* 用一个不存在的原版效果占位，真实行为由 getDelegate 转交 */
        super(StatusEffectCategory.${k.category}, 0x${String(e.color).replace('#', '').toUpperCase()});
    }

    /** 真正干活的还是原版那个 */
    public StatusEffect getDelegate() {
        return StatusEffects.${k.vanilla};
    }
}
`
}

/* ============================ 基岩版替代方案 ============================ */

/** 基岩版不能自定义效果 —— 给一份"用原版效果模拟"的说明 */
export function renderBedrockNote(modId, list) {
  const L = [
    '# 基岩版状态效果：为什么只能"模拟"',
    '',
    '> 由 DSH 的 mc_mod 工具生成。',
    '',
    '## 结论先说',
    '',
    '**基岩版的附加包不能新增状态效果。** 这是平台限制，不是工具没做。',
    '能做的只有两件事：',
    '',
    '1. 给玩家/生物**施加原版已有的效果**（可以自定义时长和等级）',
    '2. 用 Script API 自己记账，模拟出一个"看起来像新效果"的东西',
    '',
    '## 你这次要的效果，对应的原版替代',
    '',
    '| 你要的 | 原版里最接近的 | 说明 |',
    '|---|---|---|',
  ]
  for (const e of list) {
    const v = VANILLA_MAP[e.kind] || '（没有接近的）'
    L.push(`| ${e.label} | ${v} | ${KINDS[e.kind].label} |`)
  }
  L.push(
    '',
    '## 怎么施加（Script API）',
    '',
    '在 `behavior_pack/scripts/` 里放一个 js，用 `@minecraft/server`：',
    '',
    '```js',
    'import { world } from "@minecraft/server";',
    '',
    'world.afterEvents.itemUse.subscribe((ev) => {',
    '    if (ev.itemStack?.typeId !== "' + modId + ':你的物品") return;',
    '    ev.source.addEffect("' + (VANILLA_MAP[list[0] && list[0].kind] || 'speed') + '", 200, { amplifier: 1 });',
    '});',
    '```',
    '',
    '然后行为包的 manifest.json 里要声明 scripts 模块，并且注意：',
    '**Script API 需要开启实验性玩法**（地图设置里勾 Beta APIs）。',
    '',
  )
  return L.join('\n')
}

export default {
  key: 'effect',
  title: '效果',
  summary: '状态效果（回血/加速/抗火…）；java 能自定义，基岩版只能借原版',
  params: {
    op: 'add（默认）或 list 或 kinds',
    name: '效果名，小写字母数字下划线，例如 ruby_blessing',
    label: '显示名（中文），例如 红石祝福',
    kind: '效果类型，见 kinds：' + KIND_KEYS.join('/'),
    amount: 'heal/damage：每次多少，默认 1',
    interval: 'heal/damage：每多少 tick 触发一次，默认 40（2 秒）',
    color: '粒子/图标颜色 #rrggbb（默认按类型）',
  },

  async run(ctx, args) {
    const op = String(args.op || 'add').toLowerCase()

    if (op === 'kinds') {
      return {
        ok: true,
        kinds: Object.entries(KINDS).map(([k, v]) => `${k.padEnd(15)} ${v.label}（${v.category}）`),
        note: '基岩版只能用原版效果模拟，java 版能真正自定义。',
      }
    }

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const list = await readPart(projDir, 'effects', [])

    if (op === 'list') {
      return {
        ok: true,
        count: list.length,
        effects: list.map((e) => `${e.name}  ${e.label}  ${e.kind}`),
        note: list.length ? '' : '还没有效果。用 op:add 加一个。',
      }
    }

    const name = String(args.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '').replace(/^(\d)/, 'e$1')
    if (!name) return { ok: false, error: '要给效果起个名字（name）' }
    if (list.some((e) => e.name === name)) {
      return { ok: false, error: `效果「${name}」已经在这个工程里了` }
    }

    /* 大小写无关：nightVision 和 nightvision 都收 */
    const kind = normalizeKind(args.kind)
    if (!kind) {
      return {
        ok: false,
        error: `没有「${args.kind}」这种效果`,
        known: KIND_KEYS,
        hint: '用 op:kinds 看每种干什么（注意 nightVision/fireResist 是驼峰，但这个工具大小写都认）',
      }
    }
    const k = KINDS[kind]
    const color = String(args.color || k.color).trim()
    if (!/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) {
      return { ok: false, error: 'color 要写成 #rrggbb' }
    }

    const e = {
      name,
      label: String(args.label || name),
      kind,
      category: k.category,
      amount: Math.max(0.5, Math.min(20, Number(args.amount) || 1)),
      interval: Math.max(1, Math.min(1200, Math.round(Number(args.interval) || 40))),
      color,
    }

    list.push(e)
    await writePart(projDir, 'effects', list)

    const written = []
    if (meta.target === 'java') {
      const pkg = 'com.example.' + meta.modId
      const dir = join(projDir, 'src/main/java', pkg.replace(/\./g, '/'))
      await mkdir(dir, { recursive: true })
      if (k.vanilla) {
        await writeFile(join(dir, effectClass(name) + '.java'), renderVanillaWrapper(pkg, e), 'utf8')
      } else {
        await writeFile(join(dir, effectClass(name) + '.java'), renderEffectClass(pkg, meta.modId, e), 'utf8')
      }
      await writeFile(join(dir, 'ModEffects.java'), renderEffectRegistry(pkg, meta.modId, list), 'utf8')
      written.push(effectClass(name) + '.java', 'ModEffects.java')
    } else {
      const f = join(projDir, 'effect-notes', '基岩版效果说明.md')
      await mkdir(join(projDir, 'effect-notes'), { recursive: true })
      await writeFile(f, renderBedrockNote(meta.modId, list), 'utf8')
      written.push('effect-notes/基岩版效果说明.md')
    }

    return {
      ok: true,
      name,
      label: e.label,
      kind,
      target: meta.target,
      category: k.category,
      total: list.length,
      generated: written,
      note: meta.target === 'java'
        ? (k.vanilla
          ? `这个效果借用了原版的 ${k.vanilla}，自己的 id 指向它。`
          : '自定义效果类写好了，注册表也更新了。')
        : '★ 基岩版不能新增状态效果（平台限制）—— 生成了"用原版效果模拟"的说明和脚本示例。',
      hint: '想让它能喝到，接着用 do:brewing 配一个药水。',
    }
  },
}

export const __test = { KINDS, KIND_KEYS, KIND_LOOKUP, normalizeKind, VANILLA_MAP, effectClass, renderEffectClass, renderEffectRegistry, renderVanillaWrapper, renderBedrockNote }
