/*
  子工具注册表
  ============
  每个子工具对外只有五个字段：
    key      模型在 do= 里写的名字
    title    中文名（给 help 用）
    summary  一行说明 —— 会被拼进主体工具的描述里，所以务必短
    params   参数说明（help 时返回，省得模型瞎猜）
    run(ctx, args)  干活

  summary 就是模型看到的"目录"。写长了每轮都烧 token，
  所以这里只留"干什么"，不留"参数怎么填"—— 参数走 {help:true} 按需查。
*/
import project from './project.js'
import anim from './anim.js'
import biome from './biome.js'
import block from './block.js'
import blocktex from './blocktex.js'
import brewing from './brewing.js'
import compat from './compat.js'
import effect from './effect.js'
import entity from './entity.js'
import entityai from './entityai.js'
import entitytex from './entitytex.js'
import item from './item.js'
import itemtex from './itemtex.js'
import itemuse from './itemuse.js'
import net from './net.js'
import particle from './particle.js'
import recipe from './recipe.js'
import render from './render.js'
import sound from './sound.js'
import structure from './structure.js'
import verify from './verify.js'

/* 顺序按用户给的编号排，这样模型看到的目录和他脑子里的清单一致。
   依赖关系不影响顺序：block 调 blocktex、item 调 itemtex、entity 调 entitytex、
   brewing 调 effect。
   21 个全齐了：2 结构 · 3 方块 · 4 方块纹理 · 5 生物 · 6 生物AI · 7 生物贴图
                8 群系 · 9 效果 · 10 酿造 · 11 物品 · 12 物品纹理 · 13 道具用法
                14 合成 · 15 音效 · 16 动作 · 17 渲染 · 18 粒子
                19 版本适配 · 20 测试 · 21 联网 */
export const TOOLS = [
  project,
  structure,
  block,
  blocktex,
  entity,
  entityai,
  entitytex,
  biome,
  effect,
  brewing,
  item,
  itemtex,
  itemuse,
  recipe,
  sound,
  anim,
  render,
  particle,
  compat,
  verify,
  net,
]

export const BY_KEY = new Map(TOOLS.map((t) => [t.key, t]))

/** 拼进主体工具描述的那份目录 */
export function catalog() {
  return TOOLS.map((t) => `  ${t.key.padEnd(9)} ${t.summary}`).join('\n')
}

/** 某个子工具的用法 —— 只在模型主动问的时候才生成（这就是省 token 的地方） */
export function helpOf(key) {
  const t = BY_KEY.get(key)
  if (!t) {
    return `没有叫「${key}」的子工具。现在有的是：\n${catalog()}`
  }
  const lines = [`${t.key} —— ${t.title}`, '', t.summary, '']
  const params = t.params || {}
  if (Object.keys(params).length) {
    lines.push('参数（放在 args 里）：')
    for (const [k, v] of Object.entries(params)) lines.push(`  ${k.padEnd(10)} ${v}`)
  } else {
    lines.push('这个子工具不需要参数。')
  }
  return lines.join('\n')
}
