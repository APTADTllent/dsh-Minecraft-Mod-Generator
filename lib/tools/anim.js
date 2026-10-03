/*
  anim —— 动作（子工具 #16）
  ============================

  给生物加"会动"的感觉：走路摆臂、待机呼吸、攻击挥击。

  两个平台的实现难度差得很远，所以这里如实处理：

    基岩版：动画就是 JSON（animations + animation_controllers），
            用 Molang 表达式驱动骨骼旋转。这部分【完整可用】。

    Java 版：动画要写 Model 类（每个骨头一个 ModelPart，逐帧插值），
            几十上方手写代码，而且和自定义模型绑死。
            所以这里只生成【动画参数 + 渲染器里的挂载点 + 说明】，
            参数是真的（渲染器会读），但真正的骨骼动画需要手写 Model —— 
            这点必须说清楚，不能假装生成好了。

  动作名沿用 MC 的习惯：idle（待机）/ walk（走路）/ attack（攻击）/ death（死亡）。
*/
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readMeta, readPart, writePart } from './project.js'

/** 支持的动作 */
export const ANIMS = {
  idle: {
    label: '待机（呼吸起伏、手臂轻微摆动）',
    length: 2.0,
    molang: {
      /* query.anim_time 是动画内部时间（秒） */
      rightarm: { rotation: ['math.cos(query.anim_time * 180) * 4', 0, 0] },
      leftarm: { rotation: ['-math.cos(query.anim_time * 180) * 4', 0, 0] },
      body: { position: [0, 'math.sin(query.anim_time * 180) * 0.4', 0] },
    },
  },
  walk: {
    label: '走路（手臂前后摆，腿交替）',
    length: 1.0,
    molang: {
      rightarm: { rotation: ['math.cos(query.anim_time * 360) * 30', 0, 0] },
      leftarm: { rotation: ['-math.cos(query.anim_time * 360) * 30', 0, 0] },
      rightleg: { rotation: ['-math.cos(query.anim_time * 360) * 30', 0, 0] },
      leftleg: { rotation: ['math.cos(query.anim_time * 360) * 30', 0, 0] },
    },
  },
  attack: {
    label: '攻击（挥一下手臂）',
    length: 0.5,
    loop: false,
    molang: {
      rightarm: { rotation: ['math.sin(query.anim_time * 720) * 60 - 30', 0, 0] },
    },
  },
  death: {
    label: '死亡（倒地）',
    length: 1.0,
    loop: false,
    molang: {
      body: { rotation: ['query.anim_time * 90', 0, 0] },
    },
  },
}

export const ANIM_KEYS = Object.keys(ANIMS)

/** 基岩版：一份动画定义文件 */
export function bedrockAnimationFile(modId, entity, anims) {
  const animations = {}
  for (const name of anims) {
    const def = ANIMS[name]
    if (!def) continue
    animations[`animation.${modId}.${entity}.${name}`] = {
      loop: def.loop === false ? false : true,
      animation_length: def.length,
      bones: def.molang,
    }
  }
  return { format_version: '1.8.0', animations }
}

/** 基岩版：动画控制器（决定什么时候播哪个） */
export function bedrockControllerFile(modId, entity, anims) {
  const states = []
  const list = anims.filter((a) => ANIMS[a])
  list.forEach((name, i) => {
    /* 每个动画一个状态，用 molang 判断该不该进这个状态 */
    let cond = 'true'
    if (name === 'walk') cond = 'query.modified_move_speed > 0.1'
    else if (name === 'attack') cond = 'query.is_delayed_attacking'
    else if (name === 'idle') cond = 'query.modified_move_speed <= 0.1'
    const transitions = list.filter((x) => x !== name).map((x) => {
      let tc = 'true'
      if (x === 'walk') tc = 'query.modified_move_speed > 0.1'
      else if (x === 'idle') tc = 'query.modified_move_speed <= 0.1'
      else if (x === 'attack') tc = 'query.is_delayed_attacking'
      return { [`${x}`]: tc }
    })
    states.push({
      [`${name}`]: {
        animations: [name],
        blend_transition: 0.2,
        ...(cond !== 'true' ? { transitions } : {}),
      },
    })
  })

  return {
    format_version: '1.10.0',
    animation_controllers: {
      [`controller.animation.${modId}.${entity}.main`]: {
        initial_state: list[0] || 'idle',
        states: states.length ? Object.assign({}, ...states) : {},
      },
    },
  }
}

/** Java 版：渲染时能读到的动画参数（真正的骨骼动画要手写 Model） */
export function renderAnimParams(entity, anims) {
  const rows = anims.filter((a) => ANIMS[a]).map((name) => {
    const d = ANIMS[name]
    return `    /** ${d.label} */\n` +
      `    public static final float ${name.toUpperCase()}_LENGTH = ${d.length}f;`
  }).join('\n\n')
  return rows
}

export default {
  key: 'anim',
  title: '动作',
  summary: '给生物加动作（待机/走路/攻击/死亡）；基岩版完整，java 版给骨架',
  params: {
    op: 'add（默认）或 list 或 anims',
    entity: '给哪个生物加动作（生物 id）',
    anim: '动作名，见 anims：' + ANIM_KEYS.join('/'),
  },

  async run(ctx, args) {
    const op = String(args.op || 'add').toLowerCase()

    if (op === 'anims') {
      return {
        ok: true,
        anims: Object.entries(ANIMS).map(([k, v]) => `${k.padEnd(8)} ${v.label}（${v.length} 秒）`),
      }
    }

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const animMap = await readPart(projDir, 'anims', {})
    const entities = await readPart(projDir, 'entities', [])

    if (op === 'list') {
      return {
        ok: true,
        byEntity: Object.entries(animMap).map(([e, as]) => `${e}: ${as.join(' ')}`),
        note: Object.keys(animMap).length ? '' : '还没有动作。用 op:add 加一个。',
      }
    }

    const entity = String(args.entity || '').trim().replace(/^[a-z_]+:/, '').toLowerCase().replace(/[^a-z0-9_]/g, '_')
    if (!entity) return { ok: false, error: '要指定给哪个生物加动作（entity）' }
    if (!entities.some((e) => e.name === entity)) {
      return {
        ok: false,
        error: `工程里没有「${entity}」这个生物`,
        known: entities.map((e) => e.name),
        hint: '先用 do:entity 把生物加进来',
      }
    }

    const anim = String(args.anim || 'idle').toLowerCase()
    if (!ANIMS[anim]) return { ok: false, error: `没有「${anim}」这种动作`, known: ANIM_KEYS }

    const cur = animMap[entity] || []
    if (cur.includes(anim)) {
      return { ok: false, error: `${entity} 已经有「${anim}」动作了` }
    }
    const next = cur.concat([anim])
    animMap[entity] = next
    await writePart(projDir, 'anims', animMap)

    const written = []
    let javaNote = ''

    if (meta.target === 'bedrock') {
      /* 动画定义 */
      const af = join(projDir, 'resource_pack/animations', `${entity}.animation.json`)
      await mkdir(dirname(af), { recursive: true })
      await writeFile(af, JSON.stringify(bedrockAnimationFile(meta.modId, entity, next), null, 2), 'utf8')
      written.push(`resource_pack/animations/${entity}.animation.json`)

      /* 动画控制器 */
      const cf = join(projDir, 'resource_pack/animation_controllers', `${entity}.controller.json`)
      await mkdir(dirname(cf), { recursive: true })
      await writeFile(cf, JSON.stringify(bedrockControllerFile(meta.modId, entity, next), null, 2), 'utf8')
      written.push(`resource_pack/animation_controllers/${entity}.controller.json`)

      /* 在实体 json 里挂上 */
      const ef = join(projDir, 'behavior_pack/entities', entity + '.json')
      if (existsSync(ef)) {
        const j = JSON.parse(await readFile(ef, 'utf8'))
        const desc = j['minecraft:entity'] && j['minecraft:entity'].description
        if (desc) {
          if (!desc.animations) desc.animations = {}
          desc.animations[`anim_${anim}`] = `animation.${meta.modId}.${entity}.${anim}`
          if (!desc.scripts) desc.scripts = {}
          if (!Array.isArray(desc.scripts.animate)) desc.scripts.animate = []
          const ctrl = `controller.animation.${meta.modId}.${entity}.main`
          if (!desc.scripts.animate.includes(ctrl)) desc.scripts.animate.push(ctrl)
          await writeFile(ef, JSON.stringify(j, null, 2), 'utf8')
          written.push(`behavior_pack/entities/${entity}.json（挂上动画）`)
        }
      }

      /* 基岩版还有一步：客户端实体定义要声明 animation 控制器 */
      const cef = join(projDir, 'resource_pack/entity', entity + '.entity.json')
      await mkdir(dirname(cef), { recursive: true })
      await writeFile(cef, JSON.stringify({
        format_version: '1.10.0',
        'minecraft:client_entity': {
          description: {
            identifier: `${meta.modId}:${entity}`,
            materials: { default: 'entity_alphatest' },
            textures: { default: `textures/entity/${entity}` },
            geometry: { default: 'geometry.humanoid.custom' },
            animations: Object.fromEntries(next.map((a) => [`anim_${a}`, `animation.${meta.modId}.${entity}.${a}`])),
            scripts: { animate: [`controller.animation.${meta.modId}.${entity}.main`] },
            render_controllers: ['controller.render.default'],
          },
        },
      }, null, 2), 'utf8')
      written.push(`resource_pack/entity/${entity}.entity.json`)
    } else {
      /* Java：生成参数常量文件，真正的骨骼动画要手写 Model */
      const pkg = 'com.example.' + meta.modId
      const dir = join(projDir, 'src/main/java', pkg.replace(/\./g, '/'))
      await mkdir(dir, { recursive: true })
      /* 注意：类名不带 .java，只有文件名带 —— 早先拼串把后缀拼进类名，
         生成出 `public final class Xxx.java {`，javac 直接不认。 */
      const cls = entity.replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase()) + 'Animations'
      await writeFile(join(dir, cls + '.java'), `package ${pkg};

/**
 * ${entity} 的动作参数 —— 由 DSH 的 mc_mod 工具生成。
 *
 * 【重要】这里只有参数，没有真正的骨骼动画。
 * Java 版的动画要手写 Model 类（每个骨头一个 ModelPart，逐帧插值），
 * 还要在渲染器里 setAngles() 按这些参数驱动 —— 那部分代码量大且和你的
 * 自定义模型绑死，工具生成不了，得自己写。
 *
 * 已经加的动作：${next.join(' / ')}
 */
public final class ${cls} {

    private ${cls}() { }

${renderAnimParams(entity, next)}
}
`, 'utf8')
      written.push(`src/main/java/${pkg.replace(/\./g, '/')}/${cls}`)
      javaNote = 'Java 版只生成了动作参数常量。真正的骨骼动画需要手写 Model 类并在渲染器 setAngles() 里驱动 —— 这部分工具替不了。'
    }

    return {
      ok: true,
      entity,
      anim,
      target: meta.target,
      total: next.length,
      generated: written,
      note: meta.target === 'bedrock'
        ? '基岩版动画是纯 JSON，已经完整可用。'
        : javaNote,
      hint: '要再加别的动作就换个 anim（' + ANIM_KEYS.join('/') + '）。',
    }
  },
}

export const __test = { ANIMS, ANIM_KEYS, bedrockAnimationFile, bedrockControllerFile, renderAnimParams }
