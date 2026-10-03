/*
  sound —— 音效（子工具 #15）
  =============================

  流程：合成 PCM → 写 WAV → ffmpeg 转 ogg → 落到工程并注册。

  为什么绕这一圈：《我的世界》只认 .ogg，而 Node 没有音频编码器。
  自己写 Vorbis 编码器不现实（MDCT + 码本 + 心理声学，上千行且容易出错），
  所以借 ffmpeg —— 本机格式工厂自带，已经实测能转（OggS 魔数正确）。

  找不到 ffmpeg 怎么办：不硬失败，把 WAV 留在工程里并明确告诉用户
  "用格式工厂转成 ogg 放进这个目录就行"。半成品也比报错了什么都没有强。

  产出位置：
    java    src/main/resources/assets/<modId>/sounds/<name>.ogg
            并往 assets/<modId>/sounds.json 注册（不然游戏不知道怎么播）
    bedrock resource_pack/sounds/<name>.ogg
            并往 resource_pack/sounds/sound_definitions.json 注册
*/
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { synth, normalize, encodeWav, PRESET_KEYS, PRESETS } from '../audio.js'
import { readMeta, readPart, writePart } from './project.js'

/** ffmpeg 候选位置（含格式工厂自带的） */
const FFMPEG_CANDIDATES = [
  process.env.DSH_FFMPEG || '',
  'C:\\Program Files (x86)\\FormatFactory\\ffmpeg.exe',
  'D:\\FormatFactory\\ffmpeg.exe',
  'D:\\Program Files\\JiJiDown\\OrderEXE\\ffmpeg.exe',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'D:\\ffmpeg\\bin\\ffmpeg.exe',
].filter(Boolean)

export function findFfmpeg() {
  for (const p of FFMPEG_CANDIDATES) {
    if (p && existsSync(p)) return p
  }
  /* PATH 里找找 */
  try {
    const out = execFileSync('where', ['ffmpeg'], { encoding: 'utf8', windowsHide: true })
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (first && existsSync(first)) return first
  } catch { /* 没有就算了 */ }
  return ''
}

/** WAV → ogg。成功返回路径，失败返回 null（不抛） */
export function toOgg(ffmpeg, wavPath, oggPath) {
  try {
    execFileSync(ffmpeg, [
      '-y', '-loglevel', 'error',
      '-i', wavPath,
      '-c:a', 'libvorbis',
      '-ar', '44100', '-ac', '1',
      '-q:a', '4',
      oggPath,
    ], { encoding: 'utf8', timeout: 60000, windowsHide: true })
    return existsSync(oggPath) && readFileSync(oggPath).length > 32 ? oggPath : null
  } catch {
    return null
  }
}

export function soundDir(projDir, target, modId) {
  return target === 'java'
    ? join(projDir, 'src/main/resources/assets', modId, 'sounds')
    : join(projDir, 'resource_pack/sounds')
}

/** Java 版：sounds.json 决定游戏怎么找到这个音效 */
async function registerJava(projDir, modId, name, snd) {
  const f = join(projDir, 'src/main/resources/assets', modId, 'sounds.json')
  let data = {}
  if (existsSync(f)) {
    try { data = JSON.parse(await readFile(f, 'utf8')) } catch { /* 重建 */ }
  }
  data[name] = {
    category: snd.category,
    sounds: [{ name: `${modId}:${name}`, stream: false }],
  }
  await mkdir(dirname(f), { recursive: true })
  await writeFile(f, JSON.stringify(data, null, 2), 'utf8')
  return f
}

/** 基岩版：sound_definitions.json */
async function registerBedrock(projDir, modId, name, snd) {
  const f = join(projDir, 'resource_pack/sounds/sound_definitions.json')
  let data = { format_version: '1.14.0', sound_definitions: {} }
  if (existsSync(f)) {
    try { data = JSON.parse(await readFile(f, 'utf8')) } catch { /* 重建 */ }
    if (!data.sound_definitions) data.sound_definitions = {}
  }
  data.sound_definitions[`${modId}.${name}`] = {
    category: snd.category,
    sounds: [{ name: `sounds/${name}`, stream: false, volume: snd.volume }],
  }
  await mkdir(dirname(f), { recursive: true })
  await writeFile(f, JSON.stringify(data, null, 2), 'utf8')
  return f
}

export default {
  key: 'sound',
  title: '音效',
  summary: '生成音效（合成 → ffmpeg 转 ogg → 自动注册）',
  params: {
    op: 'add（默认）或 list 或 presets',
    name: '音效名，小写字母数字下划线',
    preset: '音效类型，见 presets：' + PRESET_KEYS.join('/'),
    dur: '可选：时长秒数（覆盖预设）',
    pitch: '可选：音高倍数，1 是原样，2 高一倍',
    gain: '可选：音量倍数',
    category: '声音类别：master/player/block/hostile/neutral/ambient/weather/ui',
  },

  async run(ctx, args) {
    const op = String(args.op || 'add').toLowerCase()

    if (op === 'presets') {
      return {
        ok: true,
        presets: Object.entries(PRESETS).map(([k, v]) => `${k.padEnd(10)} ${v.label}（${v.dur}秒）`),
        ffmpeg: findFfmpeg() || '（没找到，会只生成 WAV）',
      }
    }

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    const sounds = await readPart(projDir, 'sounds', [])

    if (op === 'list') {
      return {
        ok: true,
        count: sounds.length,
        sounds: sounds.map((s) => `${s.name}  ${s.preset}  ${s.dur}s  ${s.ogg ? 'ogg' : 'wav(待转)'}`),
        note: sounds.length ? '' : '还没有音效。用 op:add 加一个。',
      }
    }

    const name = String(args.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '').replace(/^(\d)/, 's$1')
    if (!name) return { ok: false, error: '要给音效起个名字（name）' }
    if (sounds.some((s) => s.name === name)) {
      return { ok: false, error: `音效「${name}」已经在这个工程里了`, hint: '看现状用 op:list' }
    }

    const preset = String(args.preset || 'click').toLowerCase()
    if (!PRESETS[preset]) {
      return { ok: false, error: `没有「${preset}」这种音效`, known: PRESET_KEYS, hint: '用 op:presets 看每种什么动静' }
    }

    const CATEGORIES = ['master', 'player', 'block', 'hostile', 'neutral', 'ambient', 'weather', 'ui']
    const category = String(args.category || 'master').toLowerCase()
    if (!CATEGORIES.includes(category)) {
      return { ok: false, error: '不认识的声音类别：' + category, known: CATEGORIES }
    }

    /* 合成 */
    const made = synth(preset, { dur: args.dur, pitch: args.pitch, gain: args.gain, seed: args.seed })
    if (!made) return { ok: false, error: '合成失败' }
    normalize(made.samples, 0.85)
    const wav = encodeWav(made.samples, made.sampleRate)

    /* 先落 WAV 到临时目录，再决定最终格式 */
    const tmp = join(tmpdir(), `dsh-mcsound-${Date.now()}`)
    await mkdir(tmp, { recursive: true })
    const wavPath = join(tmp, name + '.wav')
    writeFileSync(wavPath, wav)

    const dir = soundDir(projDir, meta.target, meta.modId)
    await mkdir(dir, { recursive: true })

    const ffmpeg = findFfmpeg()
    let finalPath = ''
    let format = 'wav'
    if (ffmpeg) {
      const oggPath = join(dir, name + '.ogg')
      const ok = toOgg(ffmpeg, wavPath, oggPath)
      if (ok) { finalPath = oggPath; format = 'ogg' }
    }
    if (!finalPath) {
      /* 没转成：把 WAV 留在工程里，明确告诉用户怎么补 */
      finalPath = join(dir, name + '.wav')
      await writeFile(finalPath, wav)
    }
    try { await rm(tmp, { recursive: true, force: true }) } catch { /* ignore */ }

    const rec = {
      name, preset, dur: made.dur, category,
      volume: Math.max(0.1, Math.min(2, Number(args.volume) || 1)),
      ogg: format === 'ogg',
      bytes: existsSync(finalPath) ? readFileSync(finalPath).length : 0,
    }
    sounds.push(rec)
    await writePart(projDir, 'sounds', sounds)

    const reg = meta.target === 'java'
      ? await registerJava(projDir, meta.modId, name, rec)
      : await registerBedrock(projDir, meta.modId, name, rec)

    return {
      ok: true,
      name,
      preset,
      target: meta.target,
      dur: made.dur + 's',
      format,
      bytes: rec.bytes,
      total: sounds.length,
      file: finalPath.replace(projDir + '\\', ''),
      registered: reg.replace(projDir + '\\', ''),
      note: format === 'ogg'
        ? '已经是 ogg，MC 直接能用。'
        : '★ 没找到 ffmpeg，先给了 WAV。用格式工厂把它转成 ogg（同名）放进同一个目录就行。',
      hint: '要加别的音效就换个 name 和 preset。',
    }
  },
}

export const __test = { FFMPEG_CANDIDATES, findFfmpeg, toOgg, soundDir, PRESET_KEYS }
