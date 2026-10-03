/*
  entity —— 生物生成（子工具 #5）
  ================================

  生物比方块物品麻烦：一个能看见、能动的生物要四样东西齐全，
  少一样就出问题（最常见的是"生物存在但看不见"—— 忘了注册渲染器）：
    1. 实体类          RubyGolemEntity.java     （血量、速度、碰撞箱）
    2. 实体类型注册    ModEntities.java         （identifier + 尺寸）
    3. 渲染器          RubyGolemRenderer.java   （用哪张贴图、多大）
    4. 客户端注册      ModEntitiesClient.java   （把渲染器挂上）

  模型走【标准人形】：直接复用 MC 自带的 PlayerEntityModel，
  贴图用 entitytex 生成的 64×64 标准 UV。
  这样不用手写骨头和 UV 映射，生物立刻能看能跑；
  要长成别的样子（比如四足），那是自定义 Model 的活，另说。

  AI 和动作分别由 entityai / anim 子工具负责，这里只把架子搭好。

  版本提示：这里按 Fabric 1.21 的 yarn 名字写（EntityAttributes.MAX_HEALTH、
  EntityType.Builder.create(...).build()）。1.21.x 小版本之间这几个 API
  有过改名，要是编译报错，改 Entity 类里那几行就行，结构不用动。
*/
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mainClass } from '../naming.js'
import { readMeta, readPart, writePart } from './project.js'
import entitytex from './entitytex.js'
import { aiImports, renderInitGoals } from '../goals.js'

const constName = (n) => String(n).toUpperCase().replace(/[^A-Z0-9_]/g, '_')
const className = (n) => String(n).replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase())

/** MC 的生成分组 */
export const SPAWN_GROUPS = ['monster', 'creature', 'ambient', 'water_creature', 'misc']

/** 1.21 的属性名（1.20.5 起去掉了 GENERIC_ 前缀） */
const ATTRS = {
  health: 'MAX_HEALTH',
  speed: 'MOVEMENT_SPEED',
  damage: 'ATTACK_DAMAGE',
  armor: 'ARMOR',
  knockback: 'KNOCKBACK_RESISTANCE',
  follow: 'FOLLOW_RANGE',
}

/* ============================ Java 四件套 ============================ */

export function renderEntityClass(pkg, e, aiList = []) {
  const cls = className(e.name) + 'Entity'
  const parent = e.parent === 'hostile' ? 'HostileEntity' : 'PathAwareEntity'
  const importParent = e.parent === 'hostile'
    ? 'net.minecraft.entity.mob.HostileEntity'
    : 'net.minecraft.entity.mob.PathAwareEntity'

  const attrs = [
    `.add(EntityAttributes.${ATTRS.health}, ${e.health})`,
    `.add(EntityAttributes.${ATTRS.speed}, ${e.speed})`,
  ]
  if (e.damage > 0 && e.parent === 'hostile') attrs.push(`.add(EntityAttributes.${ATTRS.damage}, ${e.damage})`)
  if (e.armor > 0) attrs.push(`.add(EntityAttributes.${ATTRS.armor}, ${e.armor})`)
  if (e.followRange !== 16) attrs.push(`.add(EntityAttributes.${ATTRS.follow}, ${e.followRange})`)

  const parentInit = e.parent === 'hostile'
    ? '        return HostileEntity.createHostileAttributes()'
    : '        return MobEntity.createMobAttributes()'

  /* AI 的 import 是动态的 —— 用了哪些 goal 才 import 哪些类 */
  const aiImps = aiImports(aiList)
  const aiImportLines = aiImps.length ? '\n' + aiImps.map((i) => 'import ' + i + ';').join('\n') : ''

  return `package ${pkg};

import net.minecraft.entity.EntityType;
import net.minecraft.entity.attribute.DefaultAttributeContainer;
import net.minecraft.entity.attribute.EntityAttributes;
import net.minecraft.entity.mob.MobEntity;
import ${importParent};
import net.minecraft.world.World;${aiImportLines}

/**
 * ${e.label} —— 由 DSH 的 mc_mod 工具生成。
 *
 * 行为写在 initGoals() 里，由 do:entityai 维护 —— 别手改这个文件，
 * 改了下次重渲染会被覆盖。
 */
public class ${cls} extends ${parent} {

    public ${cls}(EntityType<? extends ${parent}> type, World world) {
        super(type, world);
    }

    public static DefaultAttributeContainer.Builder createAttributes() {
${parentInit}
${attrs.map((a) => '            ' + a).join('\n')};
    }

${renderInitGoals(aiList)}
}
`
}

export function renderEntityRegistration(pkg, modId, entities) {
  /* 主类名按 modId 推 —— 以前这里写死 MyMod，生成的代码编译不过 */
  const mainCls = mainClass(modId)
  const body = entities.map((e) => {
    const cls = className(e.name) + 'Entity'
    return `    /** ${e.label} */\n` +
      `    public static final EntityType<${cls}> ${constName(e.name)} = Registry.register(\n` +
      `        Registries.ENTITY_TYPE,\n` +
      `        Identifier.of(${mainCls}.MOD_ID, "${e.name}"),\n` +
      `        EntityType.Builder.create(${cls}::new, SpawnGroup.${e.spawnGroup.toUpperCase()})\n` +
      `            .dimensions(${e.width}f, ${e.height}f)\n` +
      `            .maxTrackingRange(${e.trackingRange})\n` +
      `            .build()\n` +
      `    );`
  }).join('\n\n')

  return `package ${pkg};

import net.minecraft.entity.EntityType;
import net.minecraft.entity.SpawnGroup;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.util.Identifier;

/**
 * 生物注册表 —— 由 DSH 的 mc_mod 工具生成，一共 ${entities.length} 种。
 */
public final class ModEntities {

    private ModEntities() { }

${body}

    public static void init() {
        ${mainCls}.LOGGER.info("注册了 ${entities.length} 种生物");
    }
}
`
}

export function renderEntityRenderer(pkg, modId, e) {
  /* 主类名按 modId 推 —— 以前这里写死 MyMod，生成的代码编译不过 */
  const mainCls = mainClass(modId)
  const cls = className(e.name) + 'Entity'
  const rcls = className(e.name) + 'Renderer'
  return `package ${pkg};

import net.minecraft.client.render.entity.EntityRendererFactory;
import net.minecraft.client.render.entity.MobEntityRenderer;
import net.minecraft.client.render.entity.model.EntityModelLayers;
import net.minecraft.client.render.entity.model.PlayerEntityModel;
import net.minecraft.util.Identifier;

/**
 * ${e.label} 的渲染器。
 * 模型直接复用 MC 自带的人形（PlayerEntityModel），
 * 贴图是 entitytex 生成的 64×64 标准 UV。
 */
public class ${rcls} extends MobEntityRenderer<${cls}, PlayerEntityModel<${cls}>> {

    public ${rcls}(EntityRendererFactory.Context context) {
        super(context, new PlayerEntityModel<>(context.getPart(EntityModelLayers.PLAYER), false), ${e.shadow}f);
    }

    @Override
    public Identifier getTexture(${cls} entity) {
        return Identifier.of(${mainCls}.MOD_ID, "textures/entity/${e.name}.png");
    }
}
`
}

export function renderClientInit(pkg, entities) {
  const body = entities.map((e) =>
    `        EntityRendererRegistry.register(ModEntities.${constName(e.name)}, ${className(e.name)}Renderer::new);`
  ).join('\n')
  return `package ${pkg};

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.rendering.v1.EntityRendererRegistry;

/**
 * 客户端初始化 —— 生物的渲染器必须在这里挂上，
 * 不挂的话生物是"存在但看不见"的。
 */
public class ModEntitiesClient implements ClientModInitializer {

    @Override
    public void onInitializeClient() {
${body}
    }
}
`
}

/* ============================ 基岩版 ============================ */

export function bedrockEntityJson(modId, e) {
  const components = {
    'minecraft:health': { value: e.health, max: e.health },
    'minecraft:movement': { value: e.speed },
    'minecraft:movement.basic': {},
    'minecraft:navigation.walk': {},
    'minecraft:physics': {},
    'minecraft:collision_box': { width: e.width, height: e.height },
    'minecraft:nameable': {},
    'minecraft:pushable': { is_pushable: true, is_pushable_by_piston: true },
  }
  if (e.parent === 'hostile') {
    components['minecraft:behavior.melee_attack'] = { priority: 3, speed_multiplier: 1.0 }
    components['minecraft:behavior.nearest_attackable_target'] = {
      priority: 2,
      must_see: true,
      reselect_targets: true,
      entity_types: [{ filters: { test: 'is_family', subject: 'other', value: 'player' }, max_dist: e.followRange }],
    }
  }
  /* 注意字段名是 drop 不是 loot —— 早先这里写错，掉落表就永远挂不上 */
  if (e.drop) components['minecraft:loot'] = { table: `loot_tables/entities/${e.name}.json` }
  components['minecraft:behavior.random_stroll'] = { priority: 6, speed_multiplier: 1.0 }
  components['minecraft:behavior.look_at_player'] = { priority: 7, look_distance: 6.0 }

  return {
    format_version: '1.21.0',
    'minecraft:entity': {
      description: {
        identifier: `${modId}:${e.name}`,
        is_spawnable: true,
        is_summonable: true,
      },
      component_groups: {},
      components,
    },
  }
}

export function bedrockLootTable(modId, e) {
  const entries = []
  if (e.drop) {
    entries.push({
      type: 'item',
      name: e.drop,
      weight: 1,
      functions: [{ function: 'set_count', count: { min: e.dropMin, max: e.dropMax } }],
    })
  }
  return {
    pools: entries.length
      ? [{ rolls: 1, entries }]
      : [{ rolls: 0, entries: [] }],
  }
}

/**
 * 把 java 侧四个文件全部重写一遍。
 * 抽出来是因为 entityai 加完行为也要调它 —— goal 必须写在实体类的
 * initGoals() 里（goalSelector 是 protected），没法单独放一个文件。
 */
export async function writeJavaEntities(projDir, meta, entities, ai) {
  const pkg = 'com.example.' + meta.modId
  const dir = join(projDir, 'src/main/java', pkg.replace(/\./g, '/'))
  await mkdir(dir, { recursive: true })
  const written = []

  for (const e of entities) {
    const f = className(e.name) + 'Entity.java'
    await writeFile(join(dir, f), renderEntityClass(pkg, e, ai.filter((a) => a.entity === e.name)), 'utf8')
  }
  written.push(...entities.map((e) => `src/main/java/${pkg.replace(/\./g, '/')}/${className(e.name)}Entity.java`))

  const reg = 'ModEntities.java'
  await writeFile(join(dir, reg), renderEntityRegistration(pkg, meta.modId, entities), 'utf8')
  written.push(`src/main/java/${pkg.replace(/\./g, '/')}/${reg}`)

  for (const e of entities) {
    const f = className(e.name) + 'Renderer.java'
    await writeFile(join(dir, f), renderEntityRenderer(pkg, meta.modId, e), 'utf8')
  }
  written.push(...entities.map((e) => `src/main/java/${pkg.replace(/\./g, '/')}/${className(e.name)}Renderer.java`))

  const cl = 'ModEntitiesClient.java'
  await writeFile(join(dir, cl), renderClientInit(pkg, entities), 'utf8')
  written.push(`src/main/java/${pkg.replace(/\./g, '/')}/${cl}`)

  written.push(await patchFabricClientEntry(projDir, pkg))
  return written
}

export default {
  key: 'entity',
  title: '生物',
  summary: '生成生物（血量/速度/碰撞箱/掉落），java 和基岩两套一起出',
  params: {
    op: 'add（默认）或 list',
    name: '生物 id，小写字母数字下划线，例如 ruby_golem',
    label: '显示名（中文），例如 红宝石傀儡',
    parent: '行为基调：passive（温和，默认）或 hostile（会主动攻击）',
    health: '血量，默认 20',
    speed: '移动速度，默认 0.25',
    damage: '攻击力（hostile 才有意义），默认 0',
    armor: '护甲，默认 0',
    width: '碰撞箱宽，默认 0.6',
    height: '碰撞箱高，默认 1.8',
    color: '贴图主色 #rrggbb',
    drop: '掉落物 id（可选），例如 mymod:ruby',
    dropMin: '掉落最少几个，默认 1',
    dropMax: '掉落最多几个，默认 1',
    spawnGroup: '生成分组：' + SPAWN_GROUPS.join('/'),
  },

  async run(ctx, args) {
    const op = String(args.op || 'add').toLowerCase()

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const entities = await readPart(projDir, 'entities', [])
    /* AI 清单是 entityai 写的 —— initGoals() 要照着它生成 */
    const ai = await readPart(projDir, 'ai', [])
    const aiOf = (name) => ai.filter((a) => a.entity === name)

    /* op:sync —— entityai 加完行为后调它，把 initGoals 重渲染出来。
       （goalSelector 是 protected，goal 只能写在实体类里，没法单独放一个文件。） */
    if (op === 'sync') {
      const written = await writeJavaEntities(projDir, meta, entities, ai)
      return { ok: true, synced: entities.length, generated: written }
    }

    if (op === 'list') {
      return {
        ok: true,
        target: meta.target,
        count: entities.length,
        entities: entities.map((e) => `${e.name}  ${e.label}  ${e.parent}  ${e.health}血`),
        note: entities.length ? '' : '还没有生物。用 op:add 加一个。',
      }
    }

    const name = String(args.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '').replace(/^(\d)/, 'e$1')
    if (!name) return { ok: false, error: '要给生物起个 id（name）' }
    if (entities.some((e) => e.name === name)) {
      return { ok: false, error: `生物「${name}」已经在这个工程里了`, hint: '看现状用 op:list' }
    }

    const parent = String(args.parent || 'passive').toLowerCase()
    if (!['passive', 'hostile'].includes(parent)) {
      return { ok: false, error: 'parent 只能是 passive 或 hostile' }
    }
    const spawnGroup = String(args.spawnGroup || (parent === 'hostile' ? 'monster' : 'creature')).toLowerCase()
    if (!SPAWN_GROUPS.includes(spawnGroup)) {
      return { ok: false, error: '不认识的生成分组：' + spawnGroup, known: SPAWN_GROUPS }
    }
    const color = String(args.color || '#8a4fd0').trim()
    if (!/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) {
      return { ok: false, error: 'color 要写成 #rrggbb' }
    }

    const e = {
      name,
      label: String(args.label || name),
      parent,
      spawnGroup,
      health: Math.max(1, Math.min(1024, Number(args.health) || 20)),
      speed: Math.max(0, Math.min(2, Number(args.speed) || 0.25)),
      damage: Math.max(0, Math.min(2048, Number(args.damage) || 0)),
      armor: Math.max(0, Math.min(30, Number(args.armor) || 0)),
      followRange: Math.max(1, Math.min(64, Number(args.followRange) || 16)),
      width: Math.max(0.1, Math.min(8, Number(args.width) || 0.6)),
      height: Math.max(0.1, Math.min(8, Number(args.height) || 1.8)),
      shadow: Math.max(0, Math.min(2, Number(args.shadow === undefined ? 0.5 : args.shadow))),
      trackingRange: Math.max(2, Math.min(16, Number(args.trackingRange) || 10)),
      color,
      drop: args.drop ? String(args.drop) : '',
      dropMin: Math.max(1, Math.round(Number(args.dropMin) || 1)),
      dropMax: Math.max(1, Math.round(Number(args.dropMax) || 1)),
    }

    /* 贴图先出 —— 没贴图的生物渲染时是紫黑格 */
    const tex = await entitytex.run(ctx, {
      op: 'make', name, color, head: args.head, limb: args.limb, belly: args.belly, dir: projDir,
    })
    if (!tex.ok) return { ok: false, error: '贴图没生成出来：' + tex.error, hint: tex.hint }

    entities.push(e)
    await writePart(projDir, 'entities', entities)

    const written = []
    if (meta.target === 'java') {
      written.push(...await writeJavaEntities(projDir, meta, entities, ai))
    } else {
      const ef = join(projDir, 'behavior_pack/entities', name + '.json')
      await mkdir(dirname(ef), { recursive: true })
      await writeFile(ef, JSON.stringify(bedrockEntityJson(meta.modId, e), null, 2), 'utf8')
      written.push(`behavior_pack/entities/${name}.json`)

      const lf = join(projDir, 'behavior_pack/loot_tables/entities', name + '.json')
      await mkdir(dirname(lf), { recursive: true })
      await writeFile(lf, JSON.stringify(bedrockLootTable(meta.modId, e), null, 2), 'utf8')
      written.push(`behavior_pack/loot_tables/entities/${name}.json`)

      /* 基岩版实体贴图也要登记 */
      const tf = join(projDir, 'resource_pack/textures/entity_texture.json')
      let data = { resource_pack_name: meta.modId, texture_name: 'atlas.entity', texture_data: {} }
      if (existsSync(tf)) {
        try { data = JSON.parse(await readFile(tf, 'utf8')) } catch { /* 重建 */ }
        if (!data.texture_data) data.texture_data = {}
      }
      data.texture_data[name] = { textures: 'textures/entity/' + name }
      await writeFile(tf, JSON.stringify(data, null, 2), 'utf8')
      written.push('resource_pack/textures/entity_texture.json')
    }

    return {
      ok: true,
      name,
      label: e.label,
      target: meta.target,
      total: entities.length,
      texture: tex.file,
      generated: written,
      health: e.health,
      speed: e.speed,
      size: `${e.width}×${e.height}`,
      note: meta.target === 'java'
        ? `注册代码在 ModEntities.java 里，${mainClass(meta.modId)}.onInitialize() 那行已经调好了。`
        : '基岩版免编译。',
      hint: '接着可以用 do:entityai 加行为（攻击/跟随/逃跑），do:anim 加动作。',
    }
  },
}

/**
 * 把客户端入口写进 fabric.mod.json。
 * 漏了这一步渲染器永远不会被调用 —— 表现就是"生物存在但看不见"，
 * 而且不报任何错，极难查。所以这里自动补上。
 */
async function patchFabricClientEntry(projDir, pkg) {
  const f = join(projDir, 'src/main/resources/fabric.mod.json')
  const rel = 'src/main/resources/fabric.mod.json'
  if (!existsSync(f)) return rel + '（没找到，跳过）'
  let j = null
  try { j = JSON.parse(await readFile(f, 'utf8')) } catch { return rel + '（解析失败，跳过）' }
  if (!j.entrypoints) j.entrypoints = {}
  const cls = pkg + '.ModEntitiesClient'
  if (!Array.isArray(j.entrypoints.client)) j.entrypoints.client = []
  if (!j.entrypoints.client.includes(cls)) j.entrypoints.client.push(cls)
  await writeFile(f, JSON.stringify(j, null, 2), 'utf8')
  return rel + '（补上了 client 入口）'
}

export const __test = { SPAWN_GROUPS, ATTRS, className, constName, renderEntityClass, renderEntityRegistration, renderEntityRenderer, renderClientInit, bedrockEntityJson, bedrockLootTable, patchFabricClientEntry }
