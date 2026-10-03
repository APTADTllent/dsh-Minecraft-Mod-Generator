/*
  painter.js —— 16×16 像素画工具
  ================================

  核心思路：【站在真实贴图上改，而不是从零画】。

  为什么：MC 的方块纹理有很强的"风格一致性"——同样一团噪点，
  人手写算法画出来就是不像，但从 stone_bricks.png 派生出来的就天生对味。
  所以我们有一套现成的参考贴图（1012 张，来自本机游戏），
  染色 / 换调 / 叠加 就够了。

  三种做法，按可靠程度排：
    1. retint   拿真实贴图换色（最稳，纹理细节全保留）
    2. noise    程序化噪点（做全新材质，比如没参考的宝石块）
    3. 模板     十字植物、树苗这种有固定形状的（透明背景）

  全部是纯函数，脱离浏览器可测。
*/
import { hexToRgba, rgbaToHex, encodePng } from './png.js'

/* ============================ 画布 ============================ */

export function makeCanvas(w, h) {
  return { w, h, px: new Uint8Array(w * h * 4) }
}

export function fromImage(img) {
  return { w: img.w, h: img.h, px: Uint8Array.from(img.px) }
}

export function clone(cv) {
  return { w: cv.w, h: cv.h, px: Uint8Array.from(cv.px) }
}

export function setPx(cv, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return
  const i = (y * cv.w + x) * 4
  cv.px[i] = r; cv.px[i + 1] = g; cv.px[i + 2] = b; cv.px[i + 3] = a
}

export function getPx(cv, x, y) {
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return [0, 0, 0, 0]
  const i = (y * cv.w + x) * 4
  return [cv.px[i], cv.px[i + 1], cv.px[i + 2], cv.px[i + 3]]
}

export function fill(cv, hex, alpha = 255) {
  const [r, g, b] = hexToRgba(hex)
  for (let i = 0; i < cv.px.length; i += 4) {
    cv.px[i] = r; cv.px[i + 1] = g; cv.px[i + 2] = b; cv.px[i + 3] = alpha
  }
  return cv
}

export function toPng(cv) {
  return encodePng(cv)
}

/** 平均色（不含全透明像素），用来给方块算 map_color 之类 */
export function averageColor(cv) {
  let r = 0, g = 0, b = 0, n = 0
  for (let i = 0; i < cv.px.length; i += 4) {
    if (cv.px[i + 3] < 8) continue
    r += cv.px[i]; g += cv.px[i + 1]; b += cv.px[i + 2]; n++
  }
  if (!n) return '#000000'
  return rgbaToHex(r / n, g / n, b / n)
}

/** 有多少不透明像素（判断"这图是不是空的"） */
export function opaqueCount(cv) {
  let n = 0
  for (let i = 3; i < cv.px.length; i += 4) if (cv.px[i] > 8) n++
  return n
}

/* ============================ 1. 染色（最常用） ============================ */

/**
 * 把一张真实贴图染成目标颜色 —— 保留明暗纹理，只换色。
 *
 * 关键是归一化：先用参考图自己的平均亮度做基准，
 * 这样"把深色石头染成红宝石"不会整体变暗，明暗对比度还在。
 *
 * @param cv       参考画布（通常是真实贴图）
 * @param hex      目标颜色
 * @param opts.contrast  对比度，1 = 原样，>1 更硬朗
 * @param opts.keepAlpha  true = 保留原图透明度（玻璃、植物用）
 */
export function retint(cv, hex, opts = {}) {
  const out = clone(cv)
  const [tr, tg, tb] = hexToRgba(hex)
  const contrast = opts.contrast === undefined ? 1 : Number(opts.contrast)

  let lumSum = 0, n = 0
  for (let i = 0; i < cv.px.length; i += 4) {
    if (cv.px[i + 3] < 8) continue
    lumSum += luminance(cv.px[i], cv.px[i + 1], cv.px[i + 2])
    n++
  }
  const baseline = n ? lumSum / n : 0.5
  if (baseline < 0.02) return out   /* 全黑参考图没法染 */

  for (let i = 0; i < out.px.length; i += 4) {
    const a = cv.px[i + 3]
    if (a < 8) continue
    const lum = luminance(cv.px[i], cv.px[i + 1], cv.px[i + 2])
    /* 相对亮度：1 = 和参考图一样亮 */
    let k = lum / baseline
    if (contrast !== 1) k = 1 + (k - 1) * contrast
    out.px[i] = clamp8(tr * k)
    out.px[i + 1] = clamp8(tg * k)
    out.px[i + 2] = clamp8(tb * k)
    out.px[i + 3] = a
  }
  return out
}

function luminance(r, g, b) {
  return (r * 0.299 + g * 0.587 + b * 0.114) / 255
}

function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

/* ============================ 2. 程序化噪点 ============================ */

/**
 * 石质噪点方块。用固定种子的伪随机，保证同样参数每次画出来一样
 * （不然每改一次模组纹理都在跳，很烦人）。
 */
export function noiseStone(w, h, hex, opts = {}) {
  const cv = makeCanvas(w, h)
  const [r, g, b] = hexToRgba(hex)
  const amp = opts.amp === undefined ? 0.14 : Number(opts.amp)
  const seed = opts.seed === undefined ? 1 : Number(opts.seed)
  const rand = mulberry32(seed)
  /* 先铺一层随机明暗 */
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = 1 + (rand() * 2 - 1) * amp
      setPx(cv, x, y, clamp8(r * k), clamp8(g * k), clamp8(b * k), 255)
    }
  }
  /* 再撒几粒更暗的点，模拟石头里的杂色 */
  const specks = opts.specks === undefined ? Math.round(w * h * 0.06) : Number(opts.specks)
  for (let i = 0; i < specks; i++) {
    const x = Math.floor(rand() * w), y = Math.floor(rand() * h)
    const k = 1 - amp * 1.8
    setPx(cv, x, y, clamp8(r * k), clamp8(g * k), clamp8(b * k), 255)
  }
  return cv
}

/** 木纹：横向条 + 纵向年轮暗线 */
export function planks(w, h, hex, opts = {}) {
  const cv = makeCanvas(w, h)
  const [r, g, b] = hexToRgba(hex)
  const rand = mulberry32(opts.seed === undefined ? 7 : Number(opts.seed))
  const rows = opts.rows === undefined ? 4 : Number(opts.rows)
  const rowH = Math.max(1, Math.floor(h / rows))

  for (let y = 0; y < h; y++) {
    /* 每一"块板"内部亮度略有不同 */
    const band = Math.floor(y / rowH)
    const bandK = 1 + ((band % 3) - 1) * 0.06
    for (let x = 0; x < w; x++) {
      let k = bandK + (rand() * 2 - 1) * 0.05
      /* 板与板之间压一条暗缝 */
      if (y % rowH === 0) k *= 0.72
      setPx(cv, x, y, clamp8(r * k), clamp8(g * k), clamp8(b * k), 255)
    }
  }
  return cv
}

/** 在已有底图（通常是石头）上撒矿点 */
export function oreOn(ref, gemHex, opts = {}) {
  const cv = clone(ref)
  const [gr, gg, gb] = hexToRgba(gemHex)
  const rand = mulberry32(opts.seed === undefined ? 11 : Number(opts.seed))
  const blobs = opts.blobs === undefined ? 5 : Number(opts.blobs)

  for (let i = 0; i < blobs; i++) {
    const cx = Math.floor(rand() * (cv.w - 4)) + 2
    const cy = Math.floor(rand() * (cv.h - 4)) + 2
    const size = rand() < 0.4 ? 3 : 2
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        /* 去掉一角，让矿点看起来不规则 */
        if (size === 3 && dx === 2 && dy === 2 && rand() < 0.6) continue
        const k = 1 + (rand() * 2 - 1) * 0.18
        setPx(cv, cx + dx, cy + dy, clamp8(gr * k), clamp8(gg * k), clamp8(gb * k), 255)
      }
    }
  }
  return cv
}

/* ============================ 3. 模板：十字植物 ============================ */

/**
 * 十字植物（花、树苗、草）。透明背景，只有茎叶和花瓣占像素。
 * MC 里这类方块走的是 cross 模型，贴图必须是透底的。
 *
 * @param kind 'flower' | 'sapling' | 'grass'
 */
export function crossPlant(w, h, opts = {}) {
  const cv = makeCanvas(w, h)      /* 默认全透明 */
  const petal = opts.petal || '#d94f4f'
  const stem = opts.stem || '#3f7a2e'
  const [pr, pg, pb] = hexToRgba(petal)
  const [sr, sg, sb] = hexToRgba(stem)
  const rand = mulberry32(opts.seed === undefined ? 23 : Number(opts.seed))

  const cx = Math.floor(w / 2)
  const kind = opts.kind || 'flower'

  if (kind === 'grass') {
    /* 草：中间几根不同高度的叶片 */
    for (let x = 0; x < w; x++) {
      if (rand() < 0.45) continue
      const top = Math.floor(h * (0.2 + rand() * 0.5))
      for (let y = top; y < h; y++) {
        const k = 1 + (rand() * 2 - 1) * 0.2
        setPx(cv, x, y, clamp8(sr * k), clamp8(sg * k), clamp8(sb * k), 255)
      }
    }
    return cv
  }

  /* 花/树苗：中间一根茎 */
  const stemTop = kind === 'sapling' ? Math.floor(h * 0.35) : Math.floor(h * 0.45)
  for (let y = stemTop; y < h - 1; y++) {
    const k = 1 + (rand() * 2 - 1) * 0.15
    setPx(cv, cx, y, clamp8(sr * k), clamp8(sg * k), clamp8(sb * k), 255)
  }
  /* 两片叶子 */
  const leafY = Math.floor((stemTop + h) / 2)
  if (cx - 2 >= 0) setPx(cv, cx - 1, leafY, sr, sg, sb, 255)
  if (cx + 2 < w) setPx(cv, cx + 1, leafY, sr, sg, sb, 255)

  if (kind === 'sapling') {
    /* 树苗：顶上一小团叶子 */
    for (let dy = -3; dy <= 0; dy++) {
      const half = 2 - Math.abs(dy + 1)
      for (let dx = -half; dx <= half; dx++) {
        const k = 1 + (rand() * 2 - 1) * 0.18
        setPx(cv, cx + dx, stemTop + dy, clamp8(sr * k), clamp8(sg * k), clamp8(sb * k), 255)
      }
    }
  } else {
    /* 花：茎顶开一朵 */
    const cy = stemTop
    for (let dy = -2; dy <= 1; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const d = Math.abs(dx) + Math.abs(dy)
        if (d > 3) continue
        /* 中间留个芯，颜色偏黄 */
        if (dx === 0 && dy === 0) { setPx(cv, cx, cy, 235, 205, 90, 255); continue }
        const k = 1 + (rand() * 2 - 1) * 0.12
        setPx(cv, cx + dx, cy + dy, clamp8(pr * k), clamp8(pg * k), clamp8(pb * k), 255)
      }
    }
  }
  return cv
}

/** 玻璃：中间通透，四周一圈框 + 几个高光点 */
export function glassPane(w, h, hex, opts = {}) {
  const cv = makeCanvas(w, h)
  const [r, g, b] = hexToRgba(hex)
  const line = opts.frame === undefined ? 1 : Number(opts.frame)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = x < line || y < line || x >= w - line || y >= h - line
      if (edge) setPx(cv, x, y, clamp8(r * 0.85), clamp8(g * 0.85), clamp8(b * 0.85), 255)
      else setPx(cv, x, y, r, g, b, 40)
    }
  }
  /* 两道高光 */
  for (let i = 2; i < Math.min(w, h) - 2; i += 5) {
    setPx(cv, i, i, 255, 255, 255, 120)
    if (i + 1 < w) setPx(cv, i + 1, i, 255, 255, 255, 70)
  }
  return cv
}

/* ============================ 小工具 ============================ */

/** 固定种子的伪随机 —— 同参数必然画出同一张图 */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const __test = { luminance, clamp8 }
