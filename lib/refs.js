/*
  refs.js —— 参考贴图（纹理生成的底气）
  ======================================

  本机已经有一整套真实的《我的世界》贴图（1012 张，来自游戏 jar）。
  生成新方块纹理时，从里面挑一张当底子染色，比从零画像素像得多。

  找的顺序（先便宜的后贵的）：
    1. DSH_MC_TEXTURES 环境变量直接指一个目录
    2. 已经抽好的缓存目录（也包括隔壁 mc-structure 插件抽的那份）
    3. 游戏版本 jar —— 用自带的 extract-textures.ps1 抽一次进自己的缓存

  只在第一次真的要生成纹理时才动手，平时不碰磁盘。
*/
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { decodePng, isPng } from './png.js'
import { CACHE_DIR } from './paths.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXTRACT = join(HERE, '..', 'scripts', 'extract-textures.ps1')
const REF_DIR = join(CACHE_DIR, 'refs')

/** 候选目录：先看别人抽好的，再看自己的缓存 */
const DIR_CANDIDATES = [
  process.env.DSH_MC_TEXTURES || '',
  join(homedir(), '.dsh', 'mc-structure', 'textures'),   /* 隔壁插件已经抽好了同一份 */
  REF_DIR,
].filter(Boolean)

/** 游戏目录：和 mc-structure 用同一套猜测（那套已经在真机上验证过） */
const GAME_ROOTS = [
  join('D:', 'MCLDownload', 'Game', '.minecraft'),
  join('C:', 'MCLDownload', 'Game', '.minecraft'),
  join(homedir(), 'AppData', 'Roaming', '.minecraft'),
  join(homedir(), 'AppData', 'Local', '.minecraft'),
  join(homedir(), '.minecraft'),
].filter(Boolean)

const ST = {
  ready: false,
  dir: '',
  files: [],          /* 文件名列表，如 ['stone.png', ...] */
  byName: new Map(),  /* 'stone' -> 'stone.png' */
  source: '',
  error: '',
}

const PIX = new Map()   /* 解码结果缓存：文件名 -> {w,h,px} */

function listPng(dir) {
  try { return readdirSync(dir).filter((f) => /\.png$/i.test(f)) } catch { return [] }
}

/** 找游戏版本 jar（挑最大的那个 —— 最新版本贴图最全） */
function findJar() {
  for (const root of GAME_ROOTS) {
    const versions = join(root, 'versions')
    if (!existsSync(versions)) continue
    let best = '', bestSize = 0
    for (const v of readdirSync(versions)) {
      const vd = join(versions, v)
      let jars = []
      try { jars = readdirSync(vd).filter((f) => f.toLowerCase().endsWith('.jar')) } catch { continue }
      for (const j of jars) {
        const size = (() => { try { return readFileSync(join(vd, j)).length } catch { return 0 } })()
        if (size > bestSize) { bestSize = size; best = join(vd, j) }
      }
    }
    if (best) return best
  }
  return ''
}

/** 幂等：准备好了就直接返回 */
export function ensureRefs() {
  if (ST.ready) return status()

  for (const dir of DIR_CANDIDATES) {
    const files = listPng(dir)
    if (files.length > 100) {
      adopt(dir, files, dir === REF_DIR ? 'cache' : 'shared')
      return status()
    }
  }

  const jar = findJar()
  if (jar) {
    try {
      mkdirSync(REF_DIR, { recursive: true })
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', EXTRACT, '-Jar', jar, '-Out', REF_DIR,
      ], { encoding: 'utf8', timeout: 180000, windowsHide: true })
      const files = listPng(REF_DIR)
      if (files.length > 100) {
        adopt(REF_DIR, files, jar)
        return status()
      }
    } catch (e) {
      ST.error = '从 jar 抽贴图失败：' + String((e && e.message) || e).slice(0, 160)
    }
  } else {
    ST.error = '没找到《我的世界》的贴图。可以设 DSH_MC_TEXTURES 指向 textures/block 目录。'
  }
  return status()
}

function adopt(dir, files, source) {
  ST.dir = dir
  ST.files = files
  ST.byName = new Map()
  for (const f of files) ST.byName.set(f.replace(/\.png$/i, '').toLowerCase(), f)
  ST.source = String(source)
  ST.ready = true
  ST.error = ''
}

function status() {
  return { ready: ST.ready, dir: ST.dir, count: ST.files.length, source: ST.source, error: ST.error }
}

export function refNames() {
  return ST.files.slice()
}

export function hasRef(name) {
  return ST.byName.has(String(name || '').replace(/\.png$/i, '').toLowerCase())
}

/** 读一张参考贴图并解码（带缓存） */
export function loadRef(name) {
  ensureRefs()
  const key = String(name || '').replace(/\.png$/i, '').toLowerCase()
  if (PIX.has(key)) return PIX.get(key)
  const file = ST.byName.get(key)
  if (!file) return null
  let img = null
  try {
    const buf = readFileSync(join(ST.dir, file))
    if (!isPng(buf)) return null
    img = decodePng(buf)
  } catch {
    return null
  }
  PIX.set(key, img)
  return img
}

/**
 * 按用途挑一张最合适的参考图。
 * 顺序即优先级 —— 第一个存在的就用它。
 */
const PICKS = {
  stone: ['stone_bricks', 'stone', 'deepslate_bricks', 'cobblestone'],
  smoothStone: ['smooth_stone', 'stone', 'polished_deepslate'],
  planks: ['oak_planks', 'spruce_planks', 'dark_oak_planks', 'birch_planks'],
  log: ['oak_log', 'spruce_log', 'dark_oak_log'],
  metal: ['iron_block', 'gold_block', 'copper_block'],
  gem: ['diamond_block', 'emerald_block', 'lapis_block'],
  wool: ['white_wool', 'light_gray_wool'],
  glass: ['glass', 'white_stained_glass'],
  ore: ['stone', 'deepslate'],
  dirt: ['dirt', 'coarse_dirt'],
  sand: ['sand', 'sandstone'],
  brick: ['bricks', 'stone_bricks'],
  nether: ['netherrack', 'nether_bricks'],
  plant: ['oak_sapling', 'grass_block_side'],
}

/**
 * 拿一张参考图。
 * @param kind PICKS 里的类别
 * @returns {{w,h,px}|null}
 */
export function pickRef(kind) {
  ensureRefs()
  const list = PICKS[kind] || PICKS.stone
  for (const n of list) {
    const img = loadRef(n)
    if (img) return img
  }
  /* 类别全落空就退而求其次：随便挑一张方块图当底子，总比没有强 */
  for (const n of ST.files) {
    if (!/\.png$/i.test(n)) continue
    const img = loadRef(n)
    if (img && img.w >= 8 && img.w <= 64) return img
  }
  return null
}

export const KINDS = Object.keys(PICKS)

export const __test = { PICKS, findJar, REF_DIR }
