/*
  entitytex —— 生物贴图（子工具 #7）
  ====================================

  和方块/物品贴图完全不是一回事：
    方块 16×16 满格；物品 16×16 透明底形状；
    生物是 64×64 的【UV 展开图】—— 头、身、四肢各占固定的一块坐标，
    游戏照着这些坐标把平面图裹到骨架上。

  标准玩家 UV 布局（64×64，MC 皮肤就是这张图）：
     头      8,0   - 24,16      帽子层   32,0  - 48,16
     身体   16,16  - 40,32
     右臂   40,16  - 56,32      左臂     32,48 - 48,64
     右腿    0,16  - 16,32      左腿     16,48 - 32,64

  每一块自己又是"六面展开"的（正面/背面/左/右/上/下）。
  这里按标准尺寸把各区域填上颜色，并在头正面画上眼睛 ——
  这样生成出来的生物在游戏里是个"纯色小人 + 有眼睛"，不会再是紫黑格。

  贴图必须正好 64×64，尺寸错了模型会糊成一团。
*/
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { makeCanvas, setPx, toPng, averageColor } from '../painter.js'
import { hexToRgba } from '../png.js'
import { readMeta } from './project.js'

export const TEX_SIZE = 64

/**
 * 各部位在 64×64 图上的位置。
 * from/to 是【正面】那块 8×8（或 8×12）的起点和尺寸，
 * 其余五面由 MC 按固定偏移自己取，我们只要把整块矩形刷成同一个色，
 * 从外面看就是"这个人形是纯色的"。
 */
export const UV = {
  head: { x: 0, y: 0, w: 32, h: 16 },
  hat: { x: 32, y: 0, w: 32, h: 16 },
  body: { x: 16, y: 16, w: 24, h: 16 },
  rightArm: { x: 40, y: 16, w: 16, h: 16 },
  leftArm: { x: 32, y: 48, w: 16, h: 16 },
  rightLeg: { x: 0, y: 16, w: 16, h: 16 },
  leftLeg: { x: 16, y: 48, w: 16, h: 16 },
}

/** 头正面的 8×8 —— 脸画在这儿 */
const FACE = { x: 8, y: 8 }

function shade(hex, k) {
  const [r, g, b] = hexToRgba(hex)
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)))
  return [c(r), c(g), c(b)]
}

function fillRect(cv, rect, rgb, jitter) {
  const [r, g, b] = rgb
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      /* 轻微噪点，免得整块死平（MC 的生物贴图也都有细微纹理） */
      const k = jitter ? 1 + (Math.random() * 2 - 1) * jitter : 1
      setPx(cv, x, y, Math.max(0, Math.min(255, Math.round(r * k))),
        Math.max(0, Math.min(255, Math.round(g * k))),
        Math.max(0, Math.min(255, Math.round(b * k))), 255)
    }
  }
}

/**
 * 生成一张人形生物贴图。
 * @param color     主体色（身体/四肢）
 * @param opts.head 头部颜色，默认同主体色
 * @param opts.eye  眼睛颜色，默认黑色
 * @param opts.belly 腹部/花纹色（可选，给身体加一道）
 */
export function makeEntityTexture(color, opts = {}) {
  const cv = makeCanvas(TEX_SIZE, TEX_SIZE)   /* 默认全透明 */
  const body = hexToRgba(color)
  const head = opts.head ? hexToRgba(opts.head) : body
  const limb = opts.limb ? hexToRgba(opts.limb) : shade(color, 0.88)
  const eye = hexToRgba(opts.eye || '#101010')

  /* 先按部位铺色 */
  fillRect(cv, UV.head, head, 0.04)
  fillRect(cv, UV.body, body, 0.04)
  fillRect(cv, UV.rightArm, limb, 0.04)
  fillRect(cv, UV.leftArm, limb, 0.04)
  fillRect(cv, UV.rightLeg, limb, 0.04)
  fillRect(cv, UV.leftLeg, limb, 0.04)

  /* 腹部一道花纹 */
  if (opts.belly) {
    const b = hexToRgba(opts.belly)
    fillRect(cv, { x: UV.body.x + 4, y: UV.body.y + 8, w: 8, h: 6 }, b, 0.04)
  }

  /* 脸：两只眼睛 + 一条嘴 */
  const [er, eg, eb] = eye
  /* 标准皮肤里，头的正面在 (8,8)-(16,16) */
  const ex1 = FACE.x + 2, ex2 = FACE.x + 5, ey = FACE.y + 4
  for (const ex of [ex1, ex2]) {
    setPx(cv, ex, ey, er, eg, eb, 255)
    setPx(cv, ex, ey + 1, er, eg, eb, 255)
  }
  /* 嘴 */
  for (let x = 3; x <= 4; x++) setPx(cv, FACE.x + x, FACE.y + 7, er, eg, eb, 255)

  return cv
}

export function entityTexturePath(projDir, target, modId, name) {
  return target === 'java'
    ? join(projDir, 'src/main/resources/assets', modId, 'textures/entity', name + '.png')
    : join(projDir, 'resource_pack/textures/entity', name + '.png')
}

export default {
  key: 'entitytex',
  title: '生物贴图',
  summary: '生成 64×64 生物贴图（标准人形 UV，含脸）',
  params: {
    op: 'make（默认）或 uv（列出 UV 布局）',
    name: '贴图名，一般和生物 id 同名',
    color: '主体色 #rrggbb',
    head: '可选：头部颜色',
    limb: '可选：四肢颜色',
    belly: '可选：腹部花纹颜色',
    eye: '可选：眼睛颜色，默认近黑',
  },

  async run(ctx, args) {
    const op = String(args.op || 'make').toLowerCase()

    if (op === 'uv') {
      return {
        ok: true,
        size: `${TEX_SIZE}×${TEX_SIZE}`,
        uv: Object.entries(UV).map(([k, v]) => `${k.padEnd(10)} x=${v.x} y=${v.y} ${v.w}×${v.h}`),
        note: '这是标准玩家 UV 布局，MC 皮肤就是这张图。尺寸必须正好 64×64，错了模型会糊。',
      }
    }

    const name = String(args.name || '').trim().replace(/[^a-zA-Z0-9_]/g, '_')
    if (!name) return { ok: false, error: '要给贴图起个名字（name）' }

    const color = String(args.color || '#8a4fd0').trim()
    if (!/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) {
      return { ok: false, error: 'color 要写成 #rrggbb' }
    }

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道写到哪个工程里', hint: '先用 do:project 建工程' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const cv = makeEntityTexture(color, {
      head: args.head, limb: args.limb, belly: args.belly, eye: args.eye,
    })
    const png = toPng(cv)
    const out = entityTexturePath(projDir, meta.target, meta.modId, name)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, png)

    return {
      ok: true,
      name,
      size: `${cv.w}×${cv.h}`,
      bytes: png.length,
      avgColor: averageColor(cv),
      file: out.replace(projDir + '\\', ''),
      note: '这是人形 UV 的贴图，配 do:entity 生成的人形生物正好。',
    }
  },
}

export const __test = { UV, FACE, TEX_SIZE, makeEntityTexture, entityTexturePath }
