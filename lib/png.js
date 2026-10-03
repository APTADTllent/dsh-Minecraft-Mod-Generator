/*
  png.js —— 最小 PNG 编解码
  ==========================

  为什么自己写而不是装 sharp / jimp：
    这只是个插件，为了生成 16×16 的像素贴图去拉几百 MB 的依赖不值当。
    而且我们要的东西很窄：读参考贴图的像素 + 写出 16×16 的 PNG。

  支持范围（正好覆盖《我的世界》的贴图）：
    解码：color type 0/2/3/4/6，bit depth 8，非交错
    编码：RGBA8（color type 6），无滤波

  贴图只有 16×16 到 64×64，性能不是问题，清晰第一。
*/
import { inflateSync, deflateSync } from 'node:zlib'

export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/* ============================ 解码 ============================ */

/** 是不是 PNG（只看魔数） */
export function isPng(buf) {
  if (!buf || buf.length < 8) return false
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return false
  return true
}

/**
 * 解一张 PNG。
 * @returns {{w:number,h:number,px:Uint8Array}} px 是 RGBA 顺序，长度 w*h*4
 */
export function decodePng(buf) {
  if (!isPng(buf)) throw new Error('不是 PNG 文件')

  let off = 8
  let ihdr = null
  const idat = []
  let palette = null
  let trns = null

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    off += 12 + len

    if (type === 'IHDR') {
      ihdr = {
        w: data.readUInt32BE(0),
        h: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      }
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      trns = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
  }

  if (!ihdr) throw new Error('PNG 里没有 IHDR')
  /* 允许 1/2/4/8 位深。
     注意：《我的世界》的贴图有【大量】是 depth=4 的调色板 PNG
     （iron_block、oak_planks、sand、netherrack…），
     早先只支持 8 位深，结果这些图全被跳过、纹理退化成一张兜底图。 */
  if (![1, 2, 4, 8].includes(ihdr.depth)) throw new Error(`不支持 ${ihdr.depth} 位深`)
  if (ihdr.interlace !== 0) throw new Error('不支持交错（Adam7）PNG')
  if (!idat.length) throw new Error('PNG 里没有 IDAT')

  /* 每个像素几个字节 */
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color]
  if (channels === undefined) throw new Error('不认识的 color type: ' + ihdr.color)
  if (ihdr.color === 3 && !palette) throw new Error('调色板 PNG 却没有 PLTE')

  const bitsPerPixel = channels * ihdr.depth
  const bytesPerLine = Math.ceil((ihdr.w * bitsPerPixel) / 8)
  /* 滤波的"左邻"偏移：不足一字节的位深按 1 字节算 */
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8))
  const maxVal = (1 << ihdr.depth) - 1

  const raw = inflateSync(Buffer.concat(idat))
  const out = new Uint8Array(ihdr.w * ihdr.h * 4)
  const line = Buffer.alloc(bytesPerLine)
  const prev = Buffer.alloc(bytesPerLine)
  /** 从位流里取第 index 个样本（MSB 优先） */
  const sample = (buf, index) => {
    if (ihdr.depth === 8) return buf[index]
    const bit = index * ihdr.depth
    const byte = bit >> 3
    const shift = 8 - ihdr.depth - (bit & 7)
    return (buf[byte] >> shift) & maxVal
  }

  let p = 0
  for (let y = 0; y < ihdr.h; y++) {
    const ft = raw[p++]
    raw.copy(line, 0, p, p + bytesPerLine)
    p += bytesPerLine
    unfilter(ft, line, prev, bpp, y)

    for (let x = 0; x < ihdr.w; x++) {
      const di = (y * ihdr.w + x) * 4
      let r, g, b, a = 255
      switch (ihdr.color) {
        case 0: {
          /* 灰度：低位深要按比例放大到 0-255 */
          const v = sample(line, x)
          r = g = b = ihdr.depth === 8 ? v : Math.round((v * 255) / maxVal)
          break
        }
        case 2: {
          r = sample(line, x * 3)
          g = sample(line, x * 3 + 1)
          b = sample(line, x * 3 + 2)
          break
        }
        case 3: {
          /* 调色板：值是索引，【不缩放】 */
          const idx = sample(line, x)
          r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2]
          if (trns && idx < trns.length) a = trns[idx]
          break
        }
        case 4: {
          const v = sample(line, x * 2)
          const av = sample(line, x * 2 + 1)
          r = g = b = ihdr.depth === 8 ? v : Math.round((v * 255) / maxVal)
          a = ihdr.depth === 8 ? av : Math.round((av * 255) / maxVal)
          break
        }
        default: {
          r = sample(line, x * 4)
          g = sample(line, x * 4 + 1)
          b = sample(line, x * 4 + 2)
          a = sample(line, x * 4 + 3)
        }
      }
      out[di] = r; out[di + 1] = g; out[di + 2] = b; out[di + 3] = a
    }
    line.copy(prev)
  }

  return { w: ihdr.w, h: ihdr.h, px: out, depth: ihdr.depth, color: ihdr.color }
}

/** PNG 的 5 种行滤波，原地还原 */
function unfilter(type, line, prev, bpp, y) {
  const n = line.length
  switch (type) {
    case 0: break
    case 1:
      for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xFF
      break
    case 2:
      if (y === 0) break
      for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 0xFF
      break
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? line[i - bpp] : 0
        const up = y === 0 ? 0 : prev[i]
        line[i] = (line[i] + ((left + up) >> 1)) & 0xFF
      }
      break
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0
        const b = y === 0 ? 0 : prev[i]
        const c = (i >= bpp && y !== 0) ? prev[i - bpp] : 0
        line[i] = (line[i] + paeth(a, b, c)) & 0xFF
      }
      break
    default: throw new Error('不认识的滤波类型: ' + type)
  }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/* ============================ 编码 ============================ */

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/**
 * 把 RGBA 像素编成 PNG（每行用 Sub 滤波 —— 对贴图这种大片同色的图压缩率更好）
 * @param {{w:number,h:number,px:Uint8Array|Buffer}} img
 */
export function encodePng(img) {
  const { w, h } = img
  const px = img.px
  const stride = w * 4

  /* filter 1 (Sub)：同色区域差值全是 0，deflate 压得非常狠 */
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 1
    for (let i = 0; i < stride; i++) {
      const cur = px[y * stride + i]
      const left = i >= 4 ? px[y * stride + i - 4] : 0
      raw[rowStart + 1 + i] = (cur - left) & 0xFF
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8      /* bit depth */
  ihdr[9] = 6      /* RGBA */
  ihdr[10] = 0     /* deflate */
  ihdr[11] = 0     /* filter method */
  ihdr[12] = 0     /* 非交错 */

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ============================ 给色彩用的工具 ============================ */

/** '#rrggbb' / '#rgb' / 'rrggbb' → [r,g,b,a] */
export function hexToRgba(hex, alpha = 255) {
  const s = String(hex || '').replace('#', '').trim()
  if (s.length === 3) {
    return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16), alpha]
  }
  if (s.length !== 6) return [255, 0, 255, alpha]
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), alpha]
}

/** [r,g,b,a] → '#rrggbb' */
export function rgbaToHex(r, g, b) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return '#' + h(r) + h(g) + h(b)
}

export const __test = { crc32, paeth, unfilter }
