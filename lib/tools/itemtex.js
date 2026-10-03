/*
  itemtex —— 物品纹理生成（子工具 #12）
  =======================================

  和 blocktex 的区别：物品是【透明背景上的形状】，不是满格纹理，
  所以用 shapes.js 的字符画模板，而不是染色算法。

  产出位置：
    java    src/main/resources/assets/<modId>/textures/item/<name>.png
    bedrock resource_pack/textures/items/<name>.png
            并登记进 resource_pack/textures/item_texture.json
            （基岩版的物品贴图不登记就找不到）
*/
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { drawShape, SHAPE_NAMES } from '../shapes.js'
import { toPng, averageColor, opaqueCount } from '../painter.js'
import { readMeta } from './project.js'

/** 每种形状适合做什么，模型照着挑 */
const SHAPE_HINT = {
  gem: '宝石、钻石、水晶这类',
  ingot: '金属锭（铁锭、金锭）',
  nugget: '金属粒',
  dust: '粉末（火药、红石粉）',
  rod: '棍子、长条零件',
  sword: '剑',
  pickaxe: '镐',
  axe: '斧',
  shovel: '铲',
  round: '果实、球、蛋这类圆的',
  bottle: '药水、瓶子',
  bread: '面包、食物',
  seed: '种子、小颗粒',
  paper: '纸、卷轴、地图',
}

export function itemTexturePath(projDir, target, modId, name) {
  return target === 'java'
    ? join(projDir, 'src/main/resources/assets', modId, 'textures/item', name + '.png')
    : join(projDir, 'resource_pack/textures/items', name + '.png')
}

async function registerBedrock(projDir, modId, name) {
  const f = join(projDir, 'resource_pack/textures/item_texture.json')
  let data = { resource_pack_name: modId, texture_name: 'atlas.items', texture_data: {} }
  if (existsSync(f)) {
    try { data = JSON.parse(await readFile(f, 'utf8')) } catch { /* 坏了重建 */ }
    if (!data.texture_data) data.texture_data = {}
  }
  data.texture_data[name] = { textures: 'textures/items/' + name }
  await mkdir(dirname(f), { recursive: true })
  await writeFile(f, JSON.stringify(data, null, 2), 'utf8')
  return f
}

export default {
  key: 'itemtex',
  title: '物品纹理',
  summary: '生成物品贴图（透明底 + 形状：宝石/锭/剑/镐/药水瓶/食物）',
  params: {
    op: 'make（默认）或 shapes（列出所有形状）',
    name: '贴图名，一般和物品 id 同名',
    shape: '形状，见 shapes：' + SHAPE_NAMES.join('/'),
    color: '主色 #rrggbb',
    second: '可选：次色（剑柄、瓶盖），不填按主色压暗',
    ref: '可选：指定一张贴图给形状内部填花纹',
  },

  async run(ctx, args) {
    const op = String(args.op || 'make').toLowerCase()

    if (op === 'shapes') {
      return {
        ok: true,
        shapes: SHAPE_NAMES.map((s) => s + ' — ' + (SHAPE_HINT[s] || '')),
      }
    }

    const name = String(args.name || '').trim().replace(/[^a-zA-Z0-9_]/g, '_')
    if (!name) return { ok: false, error: '要给贴图起个名字（name）' }

    const shape = String(args.shape || 'gem').toLowerCase()
    if (!SHAPE_NAMES.includes(shape)) {
      return { ok: false, error: `没有「${shape}」这种形状`, known: SHAPE_NAMES, hint: '用 op:shapes 看每种适合做什么' }
    }

    const color = String(args.color || '#c0203a').trim()
    if (!/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) {
      return { ok: false, error: 'color 要写成 #rrggbb' }
    }

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道写到哪个工程里', hint: '先用 do:project 建工程，或 args.dir 给路径' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    let refImg = null
    if (args.ref) {
      const R = await import('../refs.js')
      refImg = R.loadRef(args.ref)
      if (!refImg) return { ok: false, error: `找不到参考贴图「${args.ref}」` }
    }

    const cv = drawShape(shape, color, { second: args.second, refImg })
    if (!cv) return { ok: false, error: '画不出来（形状模板缺失）' }

    const png = toPng(cv)
    const out = itemTexturePath(projDir, meta.target, meta.modId, name)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, png)

    const opaque = opaqueCount(cv)
    const reg = meta.target === 'bedrock' ? await registerBedrock(projDir, meta.modId, name) : ''

    return {
      ok: true,
      name,
      shape,
      size: `${cv.w}×${cv.h}`,
      bytes: png.length,
      avgColor: averageColor(cv),
      /* 物品贴图本来就该有大片透明，这里报出来是为了让模型确认没画错 */
      transparentPixels: cv.w * cv.h - opaque,
      file: out.replace(projDir + '\\', ''),
      registered: reg ? reg.replace(projDir + '\\', '') : '（java 版不用登记）',
      note: '物品贴图是透明底的，游戏里按形状绘制，这是正常的。',
    }
  },
}

export const __test = { SHAPE_HINT, itemTexturePath }
