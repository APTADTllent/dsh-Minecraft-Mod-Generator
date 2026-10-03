/*
  javamodels.js —— Java 版的"外观文件"（blockstate + model）
  ========================================================

  为什么这三样必须有：

    方块要在游戏里看得见，需要  blockstate（这个方块长什么样）+  model（模型描述）
    + 贴图；物品需要 models/item。缺任何一个，游戏里显示的都是紫黑格
    （missing model），而且【什么错都不报】—— 玩家只看到一堆紫黑方块，
    根本猜不到是文件没生成。

  这是一直漏掉的一环：贴图生成了、注册代码也对、也能编译通过，
  但进游戏一看啥都没有。所以补在这儿。

  父模型怎么选：
    · 普通方块用 block/cube_all（六面同一张图）—— 最通用，不会出错
    · 植物（花、树苗、草）用 block/cross（十字交叉），贴图键是 cross 不是 all
    · 原木其实用 block/cube_column 更好看，但那要求顶面和侧面分开画，
      现在只有一张图，用 cube_all 至少不会出错
*/

/** 这个方块该挂在哪个父模型下 */
export function modelParent(kind) {
  return kind === 'plant' ? 'block/cross' : 'block/cube_all'
}

/** 方块状态：告诉游戏"这个方块的所有状态都用这一个模型" */
export function blockstateJson(modId, name) {
  return {
    variants: {
      '': { model: `${modId}:block/${name}` },
    },
  }
}

/** 方块的模型本体 */
export function blockModelJson(modId, name, kind) {
  const tex = `${modId}:block/${name}`
  const parent = modelParent(kind)
  /* cross 的贴图键是 cross，cube_all 的是 all —— 写错了就是紫黑格 */
  return parent === 'block/cross'
    ? { parent, textures: { cross: tex } }
    : { parent, textures: { all: tex } }
}

/** 方块作为物品拿在手里/放在物品栏里时用的模型 —— 直接借用方块模型 */
export function blockItemModelJson(modId, name) {
  return { parent: `${modId}:block/${name}` }
}

/** 普通物品的模型：一张平面图 */
export function itemModelJson(modId, name) {
  return {
    parent: 'item/generated',
    textures: { layer0: `${modId}:item/${name}` },
  }
}

export const __test = { modelParent, blockstateJson, blockModelJson, blockItemModelJson, itemModelJson }
