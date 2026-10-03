/*
  entityai —— 生物 AI（子工具 #6）
  ==================================

  《我的世界》的 AI 是"目标选择器 + 一堆 goal"：
    目标选择器（targetSelector）决定"我要打谁"
    行为目标（goalSelector）决定"我平时干什么"
  每个 goal 有个 priority，数字小的优先级高。

  Java 侧：goal 必须写在实体类的 initGoals() 里。
    所以这里只往 .mcmod/ai.json 记清单，实体类由 entity 重渲染时生成 ——
    和 item/itemuse 是同一套协同办法。加完 AI 会立刻触发一次重渲染，
    不用模型记得再跑一次 entity。

  基岩侧：AI 就是往实体 json 的 components 里塞行为组件，简单得多。
*/
import { existsSync } from 'node:fs'
import { readMeta, readPart, writePart } from './project.js'
import { GOALS as GOAL_TABLE, normalizeAi, goalJava, aiImports } from '../goals.js'

/** 行为表在 ../goals.js（entity 也要用，放这儿会绕成循环依赖） */
export const GOALS = GOAL_TABLE

export default {
  key: 'entityai',
  title: '生物AI',
  summary: '给生物加行为（攻击/游荡/逃跑/盯着玩家/被吸引）',
  params: {
    op: 'add（默认）或 list 或 goals',
    entity: '给哪个生物加（生物 id，要先有它）',
    goal: '行为名，见 goals：' + Object.keys(GOALS).join('/'),
    priority: '优先级，数字小的先执行（不填用默认）',
    speed: '速度倍率（攻击/游荡/逃跑/被吸引用）',
    range: '距离（盯人/锁定目标用）',
    item: '被什么吸引（tempt 用），例如 minecraft:carrot',
  },

  async run(ctx, args) {
    const op = String(args.op || 'add').toLowerCase()

    if (op === 'goals') {
      const goalList = Object.entries(GOALS).map(([k, g]) =>
        `${k.padEnd(13)} [${g.side === 'goal' ? '行为' : '目标'}] ${g.label}`)
      return { ok: true, goals: goalList, note: '行为=平时干什么，目标=打谁。priority 小的先执行。' }
    }

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const ai = await readPart(projDir, 'ai', [])
    const entities = await readPart(projDir, 'entities', [])

    if (op === 'list') {
      const byEntity = {}
      for (const a of ai) (byEntity[a.entity] = byEntity[a.entity] || []).push(a.goal)
      return {
        ok: true,
        count: ai.length,
        byEntity: Object.entries(byEntity).map(([e, gs]) => `${e}: ${gs.join(' ')}`),
        note: ai.length ? '' : '还没有 AI。用 op:add 加一个。',
      }
    }

    const entity = String(args.entity || '').trim().replace(/^[a-z_]+:/, '').toLowerCase().replace(/[^a-z0-9_]/g, '_')
    if (!entity) return { ok: false, error: '要指定给哪个生物加 AI（entity）' }
    if (!entities.some((e) => e.name === entity)) {
      return {
        ok: false,
        error: `工程里没有「${entity}」这个生物`,
        known: entities.map((e) => e.name),
        hint: '先用 do:entity 把生物加进来',
      }
    }

    const goal = String(args.goal || '').trim()
    if (!GOALS[goal]) {
      return { ok: false, error: `没有「${goal}」这种行为`, known: Object.keys(GOALS), hint: '用 op:goals 看每种干什么' }
    }
    if (ai.some((a) => a.entity === entity && a.goal === goal)) {
      return { ok: false, error: `${entity} 已经有「${goal}」了`, hint: '同一个行为不用加两次' }
    }

    const def = GOALS[goal]
    const a = {
      entity,
      goal,
      side: def.side,
      priority: Math.max(0, Math.min(10, Math.round(Number(args.priority === undefined ? def.priority : args.priority)))),
      speed: args.speed === undefined ? def.speed : Math.max(0, Math.min(3, Number(args.speed))),
      range: args.range === undefined ? def.range : Math.max(1, Math.min(64, Number(args.range))),
      item: args.item ? String(args.item) : def.item,
    }

    const next = ai.concat([a])
    await writePart(projDir, 'ai', next)

    const written = []
    if (meta.target === 'java') {
      /* 立刻重渲染实体类，把 goal 写进 initGoals() */
      const ent = (await import('./entity.js')).default
      const r = await ent.run(ctx, { op: 'sync', dir: projDir })
      written.push(...(r.generated || []))
    } else {
      /* 基岩版：把行为组件并进实体 json */
      const { readFile, writeFile, mkdir } = await import('node:fs/promises')
      const { dirname, join } = await import('node:path')
      const f = join(projDir, 'behavior_pack/entities', entity + '.json')
      if (!existsSync(f)) return { ok: false, error: '找不到这个生物的 json' }
      const j = JSON.parse(await readFile(f, 'utf8'))
      const comps = j['minecraft:entity'] && j['minecraft:entity'].components
      if (!comps) return { ok: false, error: '实体 json 结构不对' }
      Object.assign(comps, def.bedrock(a))
      await mkdir(dirname(f), { recursive: true })
      await writeFile(f, JSON.stringify(j, null, 2), 'utf8')
      written.push(`behavior_pack/entities/${entity}.json（加了 ${goal}）`)
    }

    return {
      ok: true,
      entity,
      goal,
      side: def.side === 'goal' ? '行为目标' : '目标选择器',
      priority: a.priority,
      totalForEntity: next.filter((x) => x.entity === entity).length,
      generated: written,
      note: def.side === 'goal'
        ? '行为目标：平时自己会做的事。'
        : '目标选择器：决定它把谁当敌人。',
      hint: '要再加别的行为就换个 goal。',
    }
  },
}

export const __test = { GOALS, normalizeAi, goalJava, aiImports }
