/*
  particle —— 粒子效果（子工具 #18）
  ====================================

  两边差别很大，如实处理：

    基岩版：粒子就是 JSON（particle_effect + 一堆组件），
            贴图直接用原版 particles 图集的某一格 UV，【完整可用】。

    Java 版：自定义粒子要注册 ParticleType（代码），
            还要写 ParticleFactory 和客户端注册。
            这里生成【注册代码 + datapack 粒子定义】，能编译能跑，
            但粒子的具体外观（工厂里怎么造）留一个清晰的方法体让用户改。

  产出位置：
    java    src/main/java/.../ModParticles.java + ModParticlesClient.java
            src/main/resources/assets/<modId>/particles/<name>.json
    bedrock resource_pack/particles/<name>.json
*/
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readMeta, readPart, writePart } from './project.js'
import { mainClass } from '../naming.js'

const constName = (n) => String(n).toUpperCase().replace(/[^A-Z0-9_]/g, '_')
const className = (n) => String(n).replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase())

/** 粒子预设：每种的动态特征 */
export const PRESETS = {
  sparkle: {
    label: '闪光/星星（缓慢上飘后消失）',
    count: 12, life: 1.2, speed: 0.6, gravity: -1.0, size: 0.1,
  },
  flame: {
    label: '火焰（向上加速、快速消失）',
    count: 8, life: 0.8, speed: 0.8, gravity: -3.0, size: 0.12,
  },
  smoke: {
    label: '烟（缓慢上升、变大）',
    count: 10, life: 2.0, speed: 0.4, gravity: -0.5, size: 0.2,
  },
  magic: {
    label: '魔法/附魔（螺旋上飘）',
    count: 16, life: 1.5, speed: 0.5, gravity: -1.2, size: 0.08,
  },
  explosion: {
    label: '爆炸（四散、快速衰减）',
    count: 40, life: 0.6, speed: 6.0, gravity: 2.0, size: 0.25,
  },
  drip: {
    label: '滴落（向下加速）',
    count: 4, life: 1.0, speed: 0.1, gravity: 6.0, size: 0.06,
  },
  heart: {
    label: '爱心（缓慢上飘）',
    count: 6, life: 1.4, speed: 0.5, gravity: -0.8, size: 0.15,
  },
  bubble: {
    label: '气泡（水中上浮）',
    count: 8, life: 1.6, speed: 0.3, gravity: -2.0, size: 0.1,
  },
}

export const PRESET_KEYS = Object.keys(PRESETS)

function hexToRgb01(hex) {
  const s = String(hex || '').replace('#', '').trim()
  if (s.length !== 6 && s.length !== 3) return [1, 1, 1]
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ]
}

/* ============================ 基岩版 ============================ */

export function bedrockParticle(modId, p) {
  const c = hexToRgb01(p.color)
  return {
    format_version: '1.10.0',
    particle_effect: {
      description: {
        identifier: `${modId}:${p.name}`,
        basic_render_parameters: {
          material: 'particles_alpha',
          /* 用原版粒子图集，免得出贴图 */
          texture: 'textures/particle/particles',
        },
      },
      components: {
        'minecraft:emitter_rate_instant': { num_particles: p.count },
        'minecraft:emitter_lifetime_once': { active_time: 0.1 },
        'minecraft:emitter_shape_point': {
          offset: [0, 0.2, 0],
          direction: [0, 1, 0],
        },
        'minecraft:particle_lifetime_expression': { max_lifetime: p.life },
        'minecraft:particle_initial_speed': p.speed,
        'minecraft:particle_motion_dynamic': {
          linear_acceleration: [0, -p.gravity, 0],
          linear_drag_coefficient: 1.0,
        },
        'minecraft:particle_appearance_billboard': {
          size: [p.size, p.size],
          facing_camera_mode: 'rotate_xyz',
          uv: { texture_width: 128, texture_height: 128, uv: [0, 0], uv_size: [8, 8] },
        },
        'minecraft:particle_appearance_tinting': { color: [c[0], c[1], c[2], 1] },
      },
    },
  }
}

/* ============================ Java 版 ============================ */

export function renderModParticles(pkg, modId, list) {
  /* 主类名按 modId 推 —— 以前这里写死 MyMod，生成的代码编译不过 */
  const mainCls = mainClass(modId)
  const body = list.map((p) => {
    const cls = className(p.name) + 'Particle'
    return `    /** ${p.label} */\n` +
      `    public static final DefaultParticleType ${constName(p.name)} = register("${p.name}");`
  }).join('\n\n')

  return `package ${pkg};

import net.fabricmc.fabric.api.particle.v1.FabricParticleTypes;
import net.minecraft.particle.DefaultParticleType;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.util.Identifier;

/**
 * 粒子注册表 —— 由 DSH 的 mc_mod 工具生成，一共 ${list.length} 种。
 * 客户端那边还要在 ModParticlesClient 里挂工厂，不然粒子不会显示。
 */
public final class ModParticles {

    private ModParticles() { }

    private static DefaultParticleType register(String id) {
        return Registry.register(Registries.PARTICLE_TYPE, Identifier.of(${mainCls}.MOD_ID, id),
            FabricParticleTypes.simple());
    }

${body}

    public static void init() {
        ${mainCls}.LOGGER.info("注册了 ${list.length} 种粒子");
    }
}
`
}

export function renderModParticlesClient(pkg, modId, list) {
  const body = list.map((p) =>
    `        ParticleFactoryRegistry.getInstance().register(ModParticles.${constName(p.name)}, provider ->\n` +
    `            new ${className(p.name)}ParticleFactory(provider));`
  ).join('\n')

  return `package ${pkg};

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.particle.v1.ParticleFactoryRegistry;

/**
 * 粒子客户端注册 —— 不挂工厂的话粒子"注册了但不显示"。
 */
public class ModParticlesClient implements ClientModInitializer {

    @Override
    public void onInitializeClient() {
${body}
    }
}
`
}

/** 每个粒子一个工厂类 —— 外观部分留空让用户改 */
export function renderParticleFactory(pkg, p) {
  const cls = className(p.name) + 'ParticleFactory'
  return `package ${pkg};

import net.minecraft.client.particle.Particle;
import net.minecraft.client.particle.ParticleFactory;
import net.minecraft.client.particle.SpriteProvider;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.particle.DefaultParticleType;

/**
 * ${p.label} 的粒子工厂 —— 由 DSH 的 mc_mod 工具生成的骨架。
 *
 * 【要你改的地方】createParticle 里返回 null，所以现在粒子不显示。
 * 想让它显示，改成返回一个真正的粒子（最省事是复用原版的）：
 *
 *     return new FlameParticle.Factory(provider).createParticle(type, world, x, y, z, vx, vy, vz);
 *
 * 或者自己写一个继承 SpriteBillboardParticle 的类，在构造函数里
 * 调 setSprite / setColor / setVelocity 来定外观。
 */
public class ${cls} implements ParticleFactory<DefaultParticleType> {

    private final SpriteProvider spriteProvider;

    public ${cls}(SpriteProvider spriteProvider) {
        this.spriteProvider = spriteProvider;
    }

    @Override
    public Particle createParticle(DefaultParticleType type, ClientWorld world,
                                   double x, double y, double z,
                                   double vx, double vy, double vz) {
        // TODO: 返回一个真正的粒子，见类注释
        return null;
    }
}
`
}

/** datapack 侧的粒子定义（贴图来源） */
export function javaParticleJson(modId, p) {
  return {
    textures: ['minecraft:generic_0', 'minecraft:generic_1'],
  }
}

export default {
  key: 'particle',
  title: '粒子',
  summary: '生成粒子效果（闪光/火焰/烟/魔法/爆炸等）',
  params: {
    op: 'add（默认）或 list 或 presets',
    name: '粒子名，小写字母数字下划线',
    preset: '粒子类型，见 presets：' + PRESET_KEYS.join('/'),
    color: '颜色 #rrggbb',
    count: '可选：一次冒出多少个',
    life: '可选：存活秒数',
    speed: '可选：初速度',
    gravity: '可选：下落强度（负数往上飘）',
  },

  async run(ctx, args) {
    const op = String(args.op || 'add').toLowerCase()

    if (op === 'presets') {
      return {
        ok: true,
        presets: Object.entries(PRESETS).map(([k, v]) =>
          `${k.padEnd(10)} ${v.label}（${v.count}个 / ${v.life}秒）`),
      }
    }

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const list = await readPart(projDir, 'particles', [])

    if (op === 'list') {
      return {
        ok: true,
        count: list.length,
        particles: list.map((p) => `${p.name}  ${p.preset}  ${p.color}`),
        note: list.length ? '' : '还没有粒子。用 op:add 加一个。',
      }
    }

    const name = String(args.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '').replace(/^(\d)/, 'p$1')
    if (!name) return { ok: false, error: '要给粒子起个名字（name）' }
    if (list.some((p) => p.name === name)) {
      return { ok: false, error: `粒子「${name}」已经在这个工程里了` }
    }

    const preset = String(args.preset || 'sparkle').toLowerCase()
    if (!PRESETS[preset]) {
      return { ok: false, error: `没有「${preset}」这种粒子`, known: PRESET_KEYS, hint: '用 op:presets 看每种什么样' }
    }
    const color = String(args.color || '#c0203a').trim()
    if (!/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) {
      return { ok: false, error: 'color 要写成 #rrggbb' }
    }

    const d = PRESETS[preset]
    const p = {
      name,
      preset,
      label: d.label,
      color,
      count: Math.max(1, Math.min(200, Math.round(Number(args.count) || d.count))),
      life: Math.max(0.05, Math.min(10, Number(args.life) || d.life)),
      speed: Math.max(0, Math.min(20, Number(args.speed === undefined ? d.speed : args.speed))),
      gravity: Number(args.gravity === undefined ? d.gravity : args.gravity),
      size: d.size,
    }

    list.push(p)
    await writePart(projDir, 'particles', list)

    const written = []
    if (meta.target === 'java') {
      const pkg = 'com.example.' + meta.modId
      const dir = join(projDir, 'src/main/java', pkg.replace(/\./g, '/'))
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'ModParticles.java'), renderModParticles(pkg, meta.modId, list), 'utf8')
      await writeFile(join(dir, 'ModParticlesClient.java'), renderModParticlesClient(pkg, meta.modId, list), 'utf8')
      for (const x of list) {
        await writeFile(join(dir, className(x.name) + 'ParticleFactory.java'), renderParticleFactory(pkg, x), 'utf8')
      }
      written.push('ModParticles.java', 'ModParticlesClient.java',
        ...list.map((x) => className(x.name) + 'ParticleFactory.java'))

      const jf = join(projDir, 'src/main/resources/assets', meta.modId, 'particles', name + '.json')
      await mkdir(dirname(jf), { recursive: true })
      await writeFile(jf, JSON.stringify(javaParticleJson(meta.modId, p), null, 2), 'utf8')
      written.push(`assets/${meta.modId}/particles/${name}.json`)
    } else {
      const f = join(projDir, 'resource_pack/particles', name + '.json')
      await mkdir(dirname(f), { recursive: true })
      await writeFile(f, JSON.stringify(bedrockParticle(meta.modId, p), null, 2), 'utf8')
      written.push(`resource_pack/particles/${name}.json`)
    }

    return {
      ok: true,
      name,
      preset,
      target: meta.target,
      color,
      count: p.count,
      life: p.life + 's',
      total: list.length,
      generated: written,
      note: meta.target === 'bedrock'
        ? '基岩版粒子是纯 JSON，已经完整可用。'
        : '★ Java 版粒子工厂目前返回 null（粒子不显示）—— 见 ParticleFactory 类注释，改成复用原版粒子即可。',
      hint: '要加别的粒子就换个 name 和 preset。',
    }
  },
}

export const __test = { PRESETS, PRESET_KEYS, bedrockParticle, renderModParticles, renderParticleFactory, javaParticleJson }
