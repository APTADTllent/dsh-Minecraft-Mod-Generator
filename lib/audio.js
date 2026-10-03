/*
  audio.js —— 音效合成 + WAV 编码
  ==================================

  《我的世界》的音效是 .ogg（Ogg Vorbis），而 Node 没有音频编码器。
  纯手写 Vorbis 编码器不现实（MDCT、码本、心理声学模型，上千行）。

  所以走两步：
    1. 这里合成 PCM 并写成 WAV（WAV 头很简单，几十行搞定）
    2. 交给 ffmpeg 转成 ogg（本机找到了 3 个 ffmpeg，格式工厂带的）

  合成用的是最朴素也最够用的办法：
    振荡器（正弦/方波/三角/噪声）+ 包络（ADSR）+ 频率扫描。
    MC 的音效本来就短（0.1~1 秒）、简单、偏电子味，这套完全够。
*/
import { writeFileSync } from 'node:fs'

export const SAMPLE_RATE = 44100

/* ============================ WAV ============================ */

/**
 * 把 -1..1 的浮点采样编成 16 位单声道 WAV。
 * 单声道 + 44.1kHz 是 MC 音效的惯例，体积小也够用。
 */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const n = samples.length
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    /* 先软削波，免得叠加后爆音 */
    let v = samples[i]
    if (v > 1) v = 1
    else if (v < -1) v = -1
    data.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)          /* PCM */
  h.writeUInt16LE(1, 22)          /* 单声道 */
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)   /* 字节率 */
  h.writeUInt16LE(2, 32)          /* 块对齐 */
  h.writeUInt16LE(16, 34)         /* 位深 */
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/* ============================ 基本波形 ============================ */

export function sine(phase) { return Math.sin(phase * Math.PI * 2) }
export function square(phase) { return (phase % 1) < 0.5 ? 1 : -1 }
export function triangle(phase) {
  const t = phase % 1
  return t < 0.5 ? (4 * t - 1) : (3 - 4 * t)
}
export function saw(phase) { return 2 * (phase % 1) - 1 }

/** 固定种子的白噪声 —— 同参数每次生成同一个音 */
export function makeNoise(seed = 1) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1
  }
}

const WAVES = { sine, square, triangle, saw }

/* ============================ 包络 ============================ */

/**
 * ADSR 包络。音效像不像样，八成靠这个 ——
 * 直上直下的方波听着像蜂鸣器，加上包络才有"打击感"。
 */
export function adsr(t, dur, a = 0.005, d = 0.05, s = 0.3, r = 0.08) {
  if (t < 0 || t > dur) return 0
  const rel = Math.min(r, dur * 0.5)
  if (t < a) return t / a
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d)
  if (t < dur - rel) return s
  return s * Math.max(0, (dur - t) / rel)
}

/** 指数衰减 —— 打击类音效用这个比 ADSR 更干脆 */
export function decay(t, dur, k = 6) {
  if (t < 0 || t > dur) return 0
  return Math.exp(-k * (t / dur))
}

/* ============================ 音效预设 ============================ */

/**
 * 每种音效就是一段"怎么算采样"的描述。
 * 参数都挑成接近 MC 原版听感的：短、干净、稍有噪声。
 */
export const PRESETS = {
  click: {
    label: '点击/按钮（短促的嗒）',
    dur: 0.08,
    make: (t, dur, ctx) => {
      const env = decay(t, dur, 9)
      const f = 1200 - 500 * (t / dur)
      return 0.55 * env * (sine(f * t) * 0.7 + ctx.noise() * 0.3)
    },
  },
  pop: {
    label: '拾取/弹出（啵）',
    dur: 0.12,
    make: (t, dur) => {
      const env = decay(t, dur, 7)
      const f = 700 + 900 * (t / dur)
      return 0.6 * env * sine(f * t)
    },
  },
  thud: {
    label: '重击/落地（闷响）',
    dur: 0.25,
    make: (t, dur, ctx) => {
      const env = decay(t, dur, 6)
      const f = 120 - 60 * (t / dur)
      return 0.75 * env * (sine(f * t) * 0.6 + ctx.noise() * 0.25)
    },
  },
  explosion: {
    label: '爆炸（宽频噪声 + 低频轰鸣）',
    dur: 0.8,
    make: (t, dur, ctx) => {
      const env = decay(t, dur, 4)
      const rumble = sine((70 - 30 * (t / dur)) * t) * 0.5
      /* 噪声随时间变暗：用简单的一阶低通近似 */
      const n = ctx.noise()
      ctx.lp = ctx.lp + (n - ctx.lp) * 0.25
      return 0.8 * env * (ctx.lp * 0.8 + rumble)
    },
  },
  step: {
    label: '脚步（轻而短）',
    dur: 0.09,
    make: (t, dur, ctx) => {
      const env = decay(t, dur, 11)
      ctx.lp = ctx.lp + (ctx.noise() - ctx.lp) * 0.4
      return 0.35 * env * ctx.lp
    },
  },
  hurt: {
    label: '受伤（下行的粗糙音）',
    dur: 0.3,
    make: (t, dur, ctx) => {
      const env = decay(t, dur, 5)
      const f = 400 - 200 * (t / dur)
      return 0.6 * env * (saw(f * t) * 0.5 + ctx.noise() * 0.2)
    },
  },
  levelup: {
    label: '升级（上行三音）',
    dur: 0.7,
    make: (t, dur) => {
      const notes = [523.25, 659.25, 783.99]   /* C5 E5 G5 */
      const seg = dur / 3
      const i = Math.min(2, Math.floor(t / seg))
      const lt = t - i * seg
      const env = adsr(lt, seg, 0.01, 0.05, 0.6, 0.06)
      return 0.5 * env * (sine(notes[i] * t) * 0.8 + triangle(notes[i] * 2 * t) * 0.2)
    },
  },
  open: {
    label: '开门/箱子（吱呀一段）',
    dur: 0.45,
    make: (t, dur, ctx) => {
      const env = adsr(t, dur, 0.02, 0.15, 0.4, 0.15)
      const f = 220 + 180 * Math.sin(t * 9)
      ctx.lp = ctx.lp + (ctx.noise() - ctx.lp) * 0.08
      return 0.45 * env * (saw(f * t) * 0.35 + ctx.lp * 0.4)
    },
  },
  bow: {
    label: '弓箭（嗖）',
    dur: 0.2,
    make: (t, dur, ctx) => {
      const env = decay(t, dur, 8)
      const f = 1800 - 1400 * (t / dur)
      return 0.5 * env * (ctx.noise() * 0.6 + sine(f * t) * 0.4)
    },
  },
  splash: {
    label: '入水（哗啦）',
    dur: 0.5,
    make: (t, dur, ctx) => {
      const env = decay(t, dur, 5)
      ctx.lp = ctx.lp + (ctx.noise() - ctx.lp) * 0.5
      const bub = Math.sin(t * 60) * 0.2
      return 0.6 * env * (ctx.lp * 0.7 + bub)
    },
  },
}

export const PRESET_KEYS = Object.keys(PRESETS)

/**
 * 合成一段音效。
 * @param preset PRESETS 里的名字
 * @param opts.dur    覆盖时长（秒）
 * @param opts.pitch  音高倍数（1 = 原样）
 * @param opts.gain   音量倍数
 * @param opts.seed   噪声种子（同样参数保证同一个音）
 */
export function synth(preset, opts = {}) {
  const def = PRESETS[preset]
  if (!def) return null
  const dur = Math.max(0.02, Math.min(5, Number(opts.dur) || def.dur))
  const pitch = Math.max(0.25, Math.min(4, Number(opts.pitch) || 1))
  const gain = Math.max(0.05, Math.min(2, Number(opts.gain) || 1))
  const n = Math.round(SAMPLE_RATE * dur)
  const out = new Float32Array(n)
  const ctx = { noise: makeNoise(opts.seed === undefined ? 1 : opts.seed), lp: 0 }

  for (let i = 0; i < n; i++) {
    /* pitch 用时间缩放实现：音高上去了，同一段波形跑得更快 */
    const t = (i / SAMPLE_RATE) / pitch
    out[i] = gain * def.make(t, dur / pitch, ctx)
  }

  /* 收尾淡出 5ms，去掉末尾的咔哒声 */
  const fade = Math.min(n, Math.round(SAMPLE_RATE * 0.005))
  for (let i = 0; i < fade; i++) {
    out[n - fade + i] *= (fade - i) / fade
  }
  return { samples: out, sampleRate: SAMPLE_RATE, dur }
}

/** 峰值归一化 —— 免得不同音效音量差太多 */
export function normalize(samples, target = 0.85) {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    if (a > peak) peak = a
  }
  if (peak < 1e-6) return samples
  const k = target / peak
  for (let i = 0; i < samples.length; i++) samples[i] *= k
  return samples
}

/** 直接写出一个 wav 文件 */
export function writeWav(path, samples) {
  writeFileSync(path, encodeWav(samples))
}

export const __test = { WAVES, makeNoise }
