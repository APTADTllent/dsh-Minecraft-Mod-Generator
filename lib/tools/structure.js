/*
  structure —— 结构（子工具 #2）
  ================================

  把建筑放进模组里，让游戏能生成它（村庄、遗迹、地牢那种）。

  两个平台的结构格式完全不同：

    基岩版  .mcstructure（就是之前那个结构工作台用的格式）
            → behavior_pack/structures/<name>.mcstructure

    Java 版 structure block 的 .nbt
            → data/<modId>/structures/<name>.nbt
            内容是 gzip 压过的 NBT：size / palette / blocks / entities / DataVersion
            和 .mcstructure 不一样（.mcstructure 的方块是整块索引数组，
            .nbt 是"每个方块一条记录"的列表）

  NBT 读写用的是从结构工作台那边复用过来的模块（已经过 32 项往返测试）。

  编辑能力：新建空白、填长方体、放单块、替换方块。
  想画复杂形状（圆、坡屋顶）就先在这儿搭好底子，再用 fill 一层层修。
*/
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import { readMeta, readPart, writePart } from './project.js'
import {
  emptyStructure, fillBox, setBlock, getBlock, replaceBlocks, countBlocks, layerSummary, parseStructure,
} from '../mcstructure.js'
import { TAG, num, strNode, list, compound } from '../nbt.js'

/* Java 的 DataVersion：写错游戏会尝试"升级"结构，可能丢方块。
   1.21 是 3953。要换版本改这一处。 */
const DATA_VERSION = 3953

const STATE = { struct: null, name: '' }

/* ============================ Java 的 .nbt ============================ */

/**
 * .mcstructure（整块索引数组）→ structure block 的 .nbt（逐方块列表）。
 * 两者索引约定不同：.mcstructure 是 ZYX 顺序（z 最快），也就是
 * index = z + sizeZ*(y + sizeY*x)；.nbt 的 pos 是 [x, y, z] 显式坐标，
 * 所以必须一个个转。
 */
export function toStructureNbt(struct) {
  const [sx, sy, sz] = struct.size

  /* 调色板：只留真的用到的方块，空的不进表 */
  const used = new Map()
  const paletteOut = []
  const blocksOut = []

  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        /* 基岩版的顺序是 ZYX（z 最快），别写成 x + sx*(z + sz*y) 那种
           "一层一层"的顺序 —— 游戏不认，导出会躺倒。 */
        const pi = struct.indices[z + sz * (y + sy * x)]
        const p = struct.palette[pi]
        if (!p) continue
        if (p.name === 'minecraft:air' || p.name === 'minecraft:cave_air') continue
        const key = p.name + '|' + JSON.stringify(p.states || {})
        if (!used.has(key)) {
          const entry = { Name: strNode(p.name) }
          const st = p.states || {}
          if (Object.keys(st).length) {
            const props = {}
            for (const [k, v] of Object.entries(st)) props[k] = strNode(String(v))
            entry.Properties = compound(props)
          }
          used.set(key, paletteOut.length)
          paletteOut.push(compound(entry))
        }
        blocksOut.push(compound({
          pos: list([num(x), num(y), num(z)]),
          state: num(used.get(key)),
        }))
      }
    }
  }

  const root = compound({
    size: list([num(sx), num(sy), num(sz)]),
    palette: list(paletteOut),
    blocks: list(blocksOut),
    entities: list([], TAG.Compound),
    DataVersion: num(DATA_VERSION),
  })
  return root
}

export function structurePath(projDir, target, modId, name) {
  return target === 'java'
    ? join(projDir, 'src/main/resources/data', modId, 'structures', name + '.nbt')
    : join(projDir, 'behavior_pack/structures', name + '.mcstructure')
}

/* ============================ 子工具 ============================ */

export default {
  key: 'structure',
  title: '结构',
  summary: '搭建筑结构放进模组（.mcstructure / .nbt），能逐块编辑',
  params: {
    op: 'new（新建，默认）/ fill（填长方体）/ set（放一块）/ replace（替换）/ info / export / list',
    name: '结构名，小写字母数字下划线',
    size_x: 'new：X 格数（1-256）',
    size_y: 'new：高度（1-256）',
    size_z: 'new：Z 格数（1-256）',
    x1: 'fill/replace：起点坐标',
    y1: '',
    z1: '',
    x2: 'fill/replace：终点坐标',
    y2: '',
    z2: '',
    block: '方块 id，例如 minecraft:stone_bricks',
    from: 'replace：被换掉的方块 id',
    to: 'replace：换成什么',
  },

  async run(ctx, args) {
    const op = String(args.op || args.name ? (args.op || 'new') : 'info').toLowerCase()

    const projDir = String(args.dir || ctx.current || '')
    if (!projDir || !existsSync(projDir)) {
      return { ok: false, error: '不知道往哪个工程加', hint: '先用 do:project 建工程' }
    }
    const meta = await readMeta(projDir)
    if (!meta) return { ok: false, error: '这个目录不是本工具建的工程：' + projDir }

    /* ---------------- 列出现有结构 ---------------- */
    if (op === 'list') {
      const dir = meta.target === 'java'
        ? join(projDir, 'src/main/resources/data', meta.modId, 'structures')
        : join(projDir, 'behavior_pack/structures')
      let files = []
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.mcstructure') || f.endsWith('.nbt'))
      } catch { /* 目录还没有 */ }
      return {
        ok: true,
        target: meta.target,
        count: files.length,
        structures: files,
        note: files.length ? '' : '还没有结构。用 op:new 建一个。',
      }
    }

    /* ---------------- 新建 ---------------- */
    if (op === 'new') {
      const name = String(args.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
        .replace(/^_+|_+$/g, '').replace(/^(\d)/, 's$1')
      if (!name) return { ok: false, error: '要给结构起个名字（name）' }
      const cl = (v) => Math.max(1, Math.min(256, Math.round(Number(v) || 1)))
      const [x, y, z] = [cl(args.size_x), cl(args.size_y), cl(args.size_z)]
      STATE.struct = emptyStructure(x, y, z)
      STATE.name = name
      return {
        ok: true,
        name,
        size: `${x}×${y}×${z}`,
        cells: x * y * z,
        note: '空白画布建好了（全是空气）。接着用 op:fill 铺地板、op:set 放方块。',
        hint: '坐标从 0 开始，y=0 是最底层。',
      }
    }

    /* 后面几个 op 都要先有结构 */
    if (!STATE.struct) {
      return {
        ok: false,
        error: '还没有正在编辑的结构',
        hint: '先用 op:new 建一个（或者先 op:list 看看工程里有什么）',
      }
    }
    const s = STATE.struct
    const [sx, sy, sz] = s.size

    /* ---------------- 填长方体 ---------------- */
    if (op === 'fill') {
      const block = String(args.block || '').trim()
      if (!block) return { ok: false, error: '要指定填什么方块（block）' }
      const coords = ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].map((k) => Math.round(Number(args[k]) || 0))
      const [x1, y1, z1, x2, y2, z2] = coords
      if ([x1, y1, z1, x2, y2, z2].some((v) => v < 0 || v >= 256)) {
        return { ok: false, error: '坐标要在 0~255 之间' }
      }
      const n = fillBox(s, x1, y1, z1, x2, y2, z2, block)
      return {
        ok: true,
        filled: n,
        block,
        box: `(${x1},${y1},${z1}) → (${x2},${y2},${z2})`,
        size: `${sx}×${sy}×${sz}`,
        hint: '想看看现在什么样可以用 op:info。',
      }
    }

    /* ---------------- 放一块 ---------------- */
    if (op === 'set') {
      const block = String(args.block || '').trim()
      if (!block) return { ok: false, error: '要指定放什么方块（block）' }
      const x = Math.round(Number(args.x1 ?? args.x) || 0)
      const y = Math.round(Number(args.y1 ?? args.y) || 0)
      const z = Math.round(Number(args.z1 ?? args.z) || 0)
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) {
        return { ok: false, error: `坐标 (${x},${y},${z}) 超出范围，这个结构是 ${sx}×${sy}×${sz}` }
      }
      /* 注意：mcstructure 的 setBlock 返回的是"成没成功"（布尔），
         不是被替换掉的方块。要知道原来是什么，得先 getBlock 一下。 */
      const before = getBlock(s, x, y, z)
      setBlock(s, x, y, z, block)
      return { ok: true, at: `(${x},${y},${z})`, block, was: (before && before.name) || 'minecraft:air' }
    }

    /* ---------------- 替换 ---------------- */
    if (op === 'replace') {
      const from = String(args.from || '').trim()
      const to = String(args.to || '').trim()
      if (!from || !to) return { ok: false, error: '要指定 from（被换掉的）和 to（换成什么）' }
      const n = replaceBlocks(s, from, to)
      return { ok: true, replaced: n, from, to }
    }

    /* ---------------- 看现状 ---------------- */
    if (op === 'info') {
      const counts = countBlocks(s)
      const total = sx * sy * sz
      const solid = counts.filter(([k]) => !k.startsWith('minecraft:air')).reduce((a, [, n]) => a + n, 0)
      return {
        ok: true,
        name: STATE.name || '(未命名)',
        size: `${sx}×${sy}×${sz}`,
        cells: total,
        solid,
        air: total - solid,
        palette: s.palette.length,
        top: counts.slice(0, 8).map(([k, n]) => `${k} × ${n}`),
        layers: layerSummary(s, 2).slice(0, 12),
      }
    }

    /* ---------------- 导出到工程 ---------------- */
    if (op === 'export') {
      const name = String(args.name || STATE.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
      if (!name) return { ok: false, error: '要指定结构名（name）' }

      const out = structurePath(projDir, meta.target, meta.modId, name)
      await mkdir(dirname(out), { recursive: true })

      let buf = null
      let note = ''
      if (meta.target === 'bedrock') {
        const { buildStructure } = await import('../mcstructure.js')
        buf = buildStructure(s)
        note = '基岩版结构，放进行为包的 structures/ 里，用 /structure load 或结构方块就能用。'
      } else {
        buf = gzipSync(await (async () => {
          const { writeNbt } = await import('../nbt.js')
          return writeNbt(toStructureNbt(s), '')
        })())
        note = 'Java 版 structure block 的 .nbt（gzip 压过）。放进 data/<命名空间>/structures/ 后，' +
          '/place structure <命名空间>:<名字> 就能放。'
      }
      await writeFile(out, buf)

      /* 记一笔，便于 op:list 和以后的校验 */
      const structures = await readPart(projDir, 'structures', [])
      const rec = { name, size: s.size, cells: s.indices.length, bytes: buf.length }
      const idx = structures.findIndex((x) => x.name === name)
      if (idx >= 0) structures[idx] = rec
      else structures.push(rec)
      await writePart(projDir, 'structures', structures)

      return {
        ok: true,
        name,
        target: meta.target,
        format: meta.target === 'bedrock' ? '.mcstructure' : '.nbt (gzip)',
        bytes: buf.length,
        file: out.replace(projDir + '\\', ''),
        total: structures.length,
        note,
        hint: '同一个结构可以改完再 export 一次覆盖。',
      }
    }

    return {
      ok: false,
      error: '不认识的 op：' + op,
      known: ['new', 'fill', 'set', 'replace', 'info', 'export', 'list'],
    }
  },
}

export const __test = { DATA_VERSION, toStructureNbt, structurePath, STATE }
