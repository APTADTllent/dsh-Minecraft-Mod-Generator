/*
  goals.js —— 生物行为表（entity 和 entityai 共用）
  ==================================================

  为什么要单独一个文件：goal 必须写在实体类的 initGoals() 里
  （MC 的 goalSelector 是 protected，外部类碰不到），
  所以 entity 生成实体类时要读这张表，entityai 往表里加条目时也要用它。
  两个子工具互相 import 会绕成环，抽出来谁也不依赖谁。

  每个 goal 有两套写法：
    java    Fabric 的 goal 类
    bedrock 行为组件（基岩版直接塞组件，不用写代码）
*/

export const GOALS = {
  /* ---- 行为目标（goalSelector）：平时干什么 ---- */
  swim: {
    label: '会游泳（不会在水里沉底）',
    side: 'goal', priority: 0,
    imp: 'net.minecraft.entity.ai.goal.SwimGoal',
    java: () => 'new SwimGoal(this)',
    bedrock: {},
  },
  melee: {
    label: '近战攻击目标',
    side: 'goal', priority: 3, speed: 1.0,
    imp: 'net.minecraft.entity.ai.goal.MeleeAttackGoal',
    java: (c) => `new MeleeAttackGoal(this, ${c.speed}f, true)`,
    bedrock: (c) => ({ 'minecraft:behavior.melee_attack': { priority: c.priority, speed_multiplier: c.speed } }),
  },
  wander: {
    label: '到处游荡',
    side: 'goal', priority: 6, speed: 1.0,
    imp: 'net.minecraft.entity.ai.goal.WanderAroundFarGoal',
    java: (c) => `new WanderAroundFarGoal(this, ${c.speed}f)`,
    bedrock: (c) => ({ 'minecraft:behavior.random_stroll': { priority: c.priority, speed_multiplier: c.speed } }),
  },
  lookPlayer: {
    label: '会盯着玩家看',
    side: 'goal', priority: 7, range: 8.0,
    imp: 'net.minecraft.entity.ai.goal.LookAtEntityGoal',
    java: (c) => `new LookAtEntityGoal(this, PlayerEntity.class, ${c.range}f)`,
    bedrock: (c) => ({ 'minecraft:behavior.look_at_player': { priority: c.priority, look_distance: c.range } }),
  },
  lookAround: {
    label: '闲下来四处张望',
    side: 'goal', priority: 8,
    imp: 'net.minecraft.entity.ai.goal.LookAroundGoal',
    java: () => 'new LookAroundGoal(this)',
    bedrock: (c) => ({ 'minecraft:behavior.random_look_around': { priority: c.priority } }),
  },
  escape: {
    label: '受伤后逃跑',
    side: 'goal', priority: 1, speed: 1.2,
    imp: 'net.minecraft.entity.ai.goal.EscapeDangerGoal',
    java: (c) => `new EscapeDangerGoal(this, ${c.speed}f)`,
    bedrock: (c) => ({
      'minecraft:behavior.avoid_mob_type': {
        priority: c.priority,
        entity_types: [{
          filters: { any_of: [{ test: 'is_family', subject: 'other', value: 'player' }] },
          max_dist: 8, walk_speed_multiplier: c.speed,
        }],
      },
    }),
  },
  tempt: {
    label: '被某样东西吸引（比如拿着胡萝卜）',
    side: 'goal', priority: 4, speed: 1.0, item: 'carrot',
    imp: 'net.minecraft.entity.ai.goal.TemptGoal',
    extraImports: ['net.minecraft.recipe.Ingredient', 'net.minecraft.item.Items'],
    java: (c) => `new TemptGoal(this, ${c.speed}f, Ingredient.ofItems(Items.${String(c.item || 'carrot').replace(/^minecraft:/, '').toUpperCase()}), false)`,
    bedrock: (c) => ({ 'minecraft:behavior.follow_mob': { priority: c.priority, speed_multiplier: c.speed } }),
  },

  /* ---- 目标选择器（targetSelector）：打谁 ---- */
  targetPlayer: {
    label: '把玩家当目标（hostile 常用）',
    side: 'target', priority: 2, range: 16.0,
    imp: 'net.minecraft.entity.ai.goal.ActiveTargetGoal',
    extraImports: ['net.minecraft.entity.player.PlayerEntity'],
    java: () => 'new ActiveTargetGoal<>(this, PlayerEntity.class, true)',
    bedrock: (c) => ({
      'minecraft:behavior.nearest_attackable_target': {
        priority: c.priority, must_see: true, reselect_targets: true,
        entity_types: [{ filters: { test: 'is_family', subject: 'other', value: 'player' }, max_dist: c.range }],
      },
    }),
  },
  revenge: {
    label: '被打了会还手',
    side: 'target', priority: 1,
    imp: 'net.minecraft.entity.ai.goal.RevengeGoal',
    java: () => 'new RevengeGoal(this)',
    bedrock: (c) => ({ 'minecraft:behavior.hurt_by_target': { priority: c.priority } }),
  },
  targetMonster: {
    label: '把怪物当目标（守卫型）',
    side: 'target', priority: 3, range: 16.0,
    imp: 'net.minecraft.entity.ai.goal.ActiveTargetGoal',
    extraImports: ['net.minecraft.entity.mob.Monster'],
    java: () => 'new ActiveTargetGoal<>(this, Monster.class, true)',
    bedrock: (c) => ({
      'minecraft:behavior.nearest_attackable_target': {
        priority: c.priority, must_see: true,
        entity_types: [{ filters: { test: 'is_family', subject: 'other', value: 'monster' }, max_dist: c.range }],
      },
    }),
  },
}

export const GOAL_KEYS = Object.keys(GOALS)

/** 给一条 AI 记录补全默认值 */
export function normalizeAi(rec) {
  const def = GOALS[rec.goal]
  if (!def) return null
  return {
    entity: rec.entity,
    goal: rec.goal,
    side: def.side,
    priority: rec.priority === undefined ? def.priority : rec.priority,
    speed: rec.speed === undefined ? (def.speed === undefined ? 1.0 : def.speed) : rec.speed,
    range: rec.range === undefined ? (def.range === undefined ? 16.0 : def.range) : rec.range,
    item: rec.item || def.item || '',
  }
}

/** 一个 goal 的 Java 表达式 */
export function goalJava(rec) {
  const def = GOALS[rec.goal]
  if (!def) return ''
  return def.java(normalizeAi(rec))
}

/** 这批 AI 需要 import 哪些类 */
export function aiImports(list) {
  const imps = new Set()
  for (const raw of list) {
    const rec = normalizeAi(raw)
    if (!rec) continue
    const def = GOALS[rec.goal]
    imps.add(def.imp)
    for (const e of def.extraImports || []) imps.add(e)
  }
  return [...imps].sort()
}

/**
 * 生成 initGoals() 方法体。
 * 没有 AI 时也要生成一个空的 —— 让实体类的形状固定，重渲染时不会忽有忽无。
 */
export function renderInitGoals(list) {
  const rows = (list || []).map(normalizeAi).filter(Boolean)
  const goals = rows.filter((r) => r.side === 'goal').sort((a, b) => a.priority - b.priority)
  const targets = rows.filter((r) => r.side === 'target').sort((a, b) => a.priority - b.priority)

  const lines = []
  if (!goals.length && !targets.length) {
    lines.push('        /* 还没有加任何行为。用 do:entityai 加，比如 goal:wander */')
  }
  for (const g of goals) lines.push(`        this.goalSelector.add(${g.priority}, ${goalJava(g)});`)
  for (const t of targets) lines.push(`        this.targetSelector.add(${t.priority}, ${goalJava(t)});`)

  return `    @Override
    protected void initGoals() {
${lines.join('\n')}
    }`
}

export const __test = { normalizeAi, goalJava, aiImports, renderInitGoals }
