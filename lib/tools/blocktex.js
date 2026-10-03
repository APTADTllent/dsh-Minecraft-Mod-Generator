/*
  blocktex —— 方块纹理生成（子工具 #4）
  =======================================

  怎么保证"像《我的世界》"：拿本机真实的贴图当底子染色，
  而不是凭空画噪点。参考图找不到时才退回程序化生成。

  产出的 PNG 落到工程的正确位置：
    java    src/main/resources/assets/<modId>/textures/block/<name>.png
    bedrock resource_pack/textures/blocks/<name>.png
            同时往 resource_pack/textures/terrain_texture.json 里登记
            （基岩版的方块贴图【必须】登记，不然游戏里是个紫黑格）
*/
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import * as P from '../painter.js'
import * as R from '../refs.js'
import { hexToRgba } from '../png.js'
import { readMeta } from './project.js'

/** 15 类材质，每类说清楚它适合做什么 —— 模型照着挑就行 */
export const KINDS = {
  solid: '纯色（最省事，适合玻璃、灯、混凝土）',
  stone: '石质带噪点（石头、石砖、深板岩这类）',
  smoothStone: '光滑石材（没有杂点，适合石英、抛光石）',
  planks: '木板纹（横向条 + 板缝）',
  log: '原木（竖纹树皮）',
  metal: '金属（铁、金、铜，亮面带竖直光泽）',
  gem: '宝石块（钻石、绿宝石那种亮块）',
  wool: '羊毛/布料（柔和均匀，几乎没噪点）',
  glass: '玻璃（中间通透 + 一圈框）',
  ore: '矿石（石头底 + 撒矿点）',
  dirt: '泥土（粗糙颗粒感）',
  sand: '沙子（细密浅噪点）',
  brick: '砖块（错缝砖纹）',
  nether: '下界系（暗红粗糙）',
  plant: '十字植物（花/树苗/草，透明背景）',
}

/** 用参考图时挑哪一类 */
const REF_KIND = {
  solid: null, stone: 'stone', smoothStone: 'smoothStone', planks: 'planks',
  log: 'log', metal: 'metal', gem: 'gem', wool: 'wool', glass: null,
  ore: 'ore', dirt: 'dirt', sand: 'sand', brick: 'brick', nether: 'nether', plant: null,
}

const SIZE = 16

/** 按类别画一张 16×16。参考图能拿到就染色，拿不到就程序化。 */
export function makeTexture(kind, color, opts = {}) {
  const w = opts.size || SIZE, h = opts.size || SIZE
  const refKind = REF_KIND[kind]
  const refImg = opts.refImg || (refKind ? R.pickRef(refKind) : null)
  const o = { ...opts, color }

  switch (kind) {
    case 'solid':
      return P.fill(P.makeCanvas(w, h), color)

    case 'glass':
      return P.glassPane(w, h, color, o)

    case 'plant':
      return P.crossPlant(w, h, { ...o, petal: color })

    case 'planks':
      if (refImg) return P.retint(refImg, color, { contrast: 1.05 })
      return P.planks(w, h, color, o)

    case 'ore':
      /* 矿石 = 石头底 + 撒矿点。底子必须是石头，不是目标色。 */
      return P.oreOn(refImg || P.noiseStone(w, h, '#7d7d7d', o), color, o)

    case 'wool':
      if (refImg) return P.retint(refImg, color, { contrast: 0.55 })
      return P.noiseStone(w, h, color, { amp: 0.04 })

    case 'smoothStone':
      /* 光滑：染色后把噪点压平一点 */
      if (refImg) return P.retint(refImg, color, { contrast: 0.5 })
      return P.noiseStone(w, h, color, { amp: 0.03 })

    case 'metal':
    case 'gem':
      if (refImg) return P.retint(refImg, color, { contrast: 1.35 })
      return P.noiseStone(w, h, color, { amp: 0.1, specks: 8 })

    case 'log':
      if (refImg) return P.retint(refImg, color, { contrast: 1.1 })
      return P.planks(w, h, color, { rows: 6, seed: 3 })

    case 'dirt':
      if (refImg) return P.retint(refImg, color, { contrast: 1.2 })
      return P.noiseStone(w, h, color, { amp: 0.2, specks: 20 })

    case 'sand':
      if (refImg) return P.retint(refImg, color, { contrast: 0.7 })
      return P.noiseStone(w, h, color, { amp: 0.07 })

    case 'brick':
      if (refImg) return P.retint(refImg, color, { contrast: 1.15 })
      return P.noiseStone(w, h, color, { amp: 0.16 })

    case 'nether':
      if (refImg) return P.retint(refImg, color, { contrast: 1.3 })
      return P.noiseStone(w, h, color, { amp: 0.22, specks: 26 })

    case 'stone':
    default:
      if (refImg) return P.retint(refImg, color, { contrast: 1 })
      return P.noiseStone(w, h, color, o)
  }
}

/** 贴图该写到哪儿 */
export function texturePath(projDir, target, modId, name) {
  return target === 'java'
    ? join(projDir, 'src/main/resources/assets', modId, 'textures/block', name + '.png')
    : join(projDir, 'resource_pack/textures/blocks', name + '.png')
}

/** 基岩版必须在 terrain_texture.json 里登记，否则游戏里显示紫黑格 */
async function registerBedrock(projDir, modId, name) {
  const f = join(projDir, 'resource_pack/textures/terrain_texture.json')
  let data = { resource_pack_name: modId, texture_name: 'atlas.terrain', padding: 8, num_mip_levels: 4, texture_data: {} }
  if (existsSync(f)) {
    try { data = JSON.parse(await readFile(f, 'utf8')) } catch { /* 坏了就重建 */ }
    if (!data.texture_data) data.texture_data = {}
  }
  data.texture_data[name] = { textures: 'textures/blocks/' + name }
  await mkdir(dirname(f), { recursive: true })
  await writeFile(f, JSON.stringify(data, null, 2), 'utf8')
  return f
}

export default {
  key: 'blocktex',
  title: '方块纹理',
  summary: '生成 16×16 方块贴图（染色/噪点/矿石/十字植物/玻璃）',
  params: {
    op: 'make（默认）或 kinds（列出所有材质类型）',
    name: '贴图名，一般和方块 id 同名',
    kind: '材质类型，见 kinds：' + Object.keys(KINDS).join('/'),
    color: '主色 #rrggbb',
    ref: '可选：指定一张参考贴图名（不知道就别填，会自动挑）',
    size: '可选：像素尺寸，默认 16',
  },

  async run(ctx, args) {
    const op = String(args.op || 'make').toLowerCase()

    if (op === 'kinds') {
      return {
        ok: true,
        kinds: Object.entries(KINDS).map(([k, v]) => k + ' — ' + v),
        refs: R.ensureRefs(),
      }
    }

    const name = String(args.name || '').trim().replace(/[^a-zA-Z0-9_]/g, '_')
    if (!name) return { ok: false, error: '要给贴图起个名字（name），一般和方块 id 同名' }

    const kind = String(args.kind || 'stone').toLowerCase()
    if (!KINDS[kind]) {
      return { ok: false, error: `没有「${kind}」这种材质`, known: Object.keys(KINDS), hint: '用 op:kinds 看每种适合做什么' }
    }

    const color = String(args.color || '#8a8a8a').trim()
    if (!/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) {
      return { ok: false, error: 'color 要写成 #rrggbb 这种十六进制颜色' }
    }

    /* 要往工程里写，就得先知道工程在哪 —— 不传就用宿主半记着的当前工程 */
    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return {
        ok: false,
        error: '不知道写到哪个工程里',
        hint: '先用 do:project 的 op:create 建工程，或者 args.dir 给个绝对路径',
      }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程（缺 mcmod.json）：' + projDir }

    const size = Math.max(8, Math.min(64, Math.round(Number(args.size) || SIZE)))
    let refImg = null
    if (args.ref) {
      refImg = R.loadRef(args.ref)
      if (!refImg) return { ok: false, error: `找不到参考贴图「${args.ref}」`, hint: '不填 ref 的话会自动挑一张' }
    }

    const cv = makeTexture(kind, color, { size, refImg })
    if (!cv) return { ok: false, error: '生成失败（这个材质类型需要参考图但一张都没有）' }

    const png = P.toPng(cv)
    const out = texturePath(projDir, meta.target, meta.modId, name)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, png)

    const opaque = P.opaqueCount(cv)
    const reg = meta.target === 'bedrock' ? await registerBedrock(projDir, meta.modId, name) : ''

    return {
      ok: true,
      name,
      kind,
      size: `${cv.w}×${cv.h}`,
      bytes: png.length,
      avgColor: P.averageColor(cv),
      transparentPixels: cv.w * cv.h - opaque,
      file: out.replace(projDir + '\\', ''),
      registered: reg ? reg.replace(projDir + '\\', '') : '（java 版不用登记）',
      note: kind === 'plant'
        ? '十字植物是透明底的，游戏里要用 cross 模型才显示得对。'
        : (opaque === cv.w * cv.h ? '' : '这张有透明像素。'),
    }
  },
}

export const __test = { KINDS, REF_KIND, makeTexture, texturePath }
