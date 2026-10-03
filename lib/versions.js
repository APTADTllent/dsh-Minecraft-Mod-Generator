/*
  versions.js —— 版本数据（单独一个文件，谁都能用）
  ================================================

  为什么从 compat.js 里抽出来：建工程的时候（templates.js）就得知道
  "1.20.1 该配哪个 fabric-api"。如果 templates 去 import compat，
  就绕成 project → templates → compat → project 的循环依赖。
  数据放中间层，两边都往下依赖，干净。

  表里的值是 2026-02 用 do:net op:fabric 实测校准过的，但仍然会过期。
  要最新的就联网查（net 子工具），别信这张表一辈子。

  注意 loader：Fabric loader 是【跨游戏版本的】，同一个最新稳定版能用于
  所有 MC 版本，所以这里每个版本写的是同一个号，不是抄错了。
*/

/* ---------------- 版本比较 ---------------- */

/** 语义化比较：返回 -1 / 0 / 1。只认数字段，多余的后缀忽略。 */
export function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/* ---------------- 版本档案表 ---------------- */

/** Fabric loader 的最新稳定版（跨版本通用） */
export const LOADER_LATEST = '0.19.5'

/**
 * 每个游戏版本该配的那套依赖。
 * java 字段尤其重要：1.20.x 用 Java 17，1.20.6 起必须 21，写错了 gradle 直接报
 * "Unsupported class file major version"。
 *
 * yarn_mappings 和 fabric_version 都带版本后缀，抄错一位 gradle 就找不到包 ——
 * 这也是为什么建工程时必须按 mcVersion 查表，不能写死。
 */
export const PROFILES = {
  '1.20.1': { loader: LOADER_LATEST, yarn: '1.20.1+build.10', api: '0.92.12+1.20.1', loom: '1.4-SNAPSHOT', java: 17 },
  '1.20.4': { loader: LOADER_LATEST, yarn: '1.20.4+build.3', api: '0.97.3+1.20.4', loom: '1.6-SNAPSHOT', java: 17 },
  '1.20.6': { loader: LOADER_LATEST, yarn: '1.20.6+build.3', api: '0.100.8+1.20.6', loom: '1.7-SNAPSHOT', java: 21 },
  '1.21': { loader: LOADER_LATEST, yarn: '1.21+build.9', api: '0.102.0+1.21', loom: '1.7-SNAPSHOT', java: 21 },
  '1.21.1': { loader: LOADER_LATEST, yarn: '1.21.1+build.3', api: '0.116.17+1.21.1', loom: '1.7-SNAPSHOT', java: 21 },
  '1.21.4': { loader: LOADER_LATEST, yarn: '1.21.4+build.8', api: '0.119.4+1.21.4', loom: '1.9-SNAPSHOT', java: 21 },
  '1.21.5': { loader: LOADER_LATEST, yarn: '1.21.5+build.1', api: '0.128.2+1.21.5', loom: '1.10-SNAPSHOT', java: 21 },
}

export const PROFILE_KEYS = Object.keys(PROFILES)

/** 表里没有这个版本时的兜底：按大版本猜一套，并标记 exact=false 好让调用方提醒用户 */
export function resolveProfile(mcVersion) {
  const v = String(mcVersion || '').trim()
  if (PROFILES[v]) return { ...PROFILES[v], mcVersion: v, exact: true }

  const minor = (s) => String(s).split('.').slice(0, 2).join('.')
  const same = PROFILE_KEYS.filter((k) => minor(k) === minor(v))
  if (same.length) {
    /* 同大版本里有别的版本（比如问 1.20，表里有 1.20.1/1.20.4/1.20.6）——
       只借它的构建工具版本【loom】，yarn 和 fabric-api 的后缀必须跟着目标版本走。
       早先是整套抄过来，于是"1.20"会拿到 yarn 1.20.6+build.3 + fabric-api
       0.100.8+1.20.6 + Java 21，写出来的工程自相矛盾，gradle 必崩（踩过）。 */
    const ref = PROFILES[same[same.length - 1]]
    const java = cmpVersion(v, '1.20.5') >= 0 ? 21 : 17
    return {
      loader: LOADER_LATEST,
      yarn: v + '+build.1',
      api: String(ref.api).replace(/\+.*$/, '') + '+' + v,
      loom: ref.loom,
      java,
      mcVersion: v,
      exact: false,
      basedOn: same[same.length - 1],
    }
  }

  /* 往后没见过的版本（比如 1.22）：按"Java 21 + 最新 loom"猜，
     版本后缀跟上，至少不会因为后缀写错而找不到包。 */
  const java = cmpVersion(v, '1.20.5') >= 0 ? 21 : 17
  return {
    loader: LOADER_LATEST,
    yarn: v + '+build.1',
    api: '0.119.4+' + v,
    loom: '1.10-SNAPSHOT',
    java,
    mcVersion: v,
    exact: false,
    basedOn: '(猜的)',
  }
}

/** 加载器的支持程度 —— 必须如实说，不然用户拿着 Forge 工程的期待来看会白费功夫 */
export const LOADERS = {
  fabric: { label: 'Fabric', full: true, note: '模板完整：能编译、能打包成 jar' },
  quilt: { label: 'Quilt', full: true, note: '和 Fabric 基本兼容，把 loom 插件名和 loader 坐标换掉即可' },
  forge: { label: 'Forge', full: false, note: '写法完全不同（@Mod 注解 + 事件总线 + MCP 混淆名），本工具不能直接生成' },
  neoforge: { label: 'NeoForge', full: false, note: '同上，且构建用 NeoGradle，与 Fabric 的 gradle 脚本不通用' },
}

export const LOADER_KEYS = Object.keys(LOADERS)

/* ---------------- API 规则表 ---------------- */

/**
 * 一条规则 = 一个"在某段版本区间里才存在"的写法。
 *
 * since / until 是闭区间，空串表示不设限。
 * 命中条件是：代码里有这个写法，但目标版本【不在】区间里。
 *
 * autofix 是可自动改写的规则名，只有确凿的才写 —— 拿不准的只报告不改，
 * 免得把人家能编译的代码改坏。
 */
export const API_RULES = [
  {
    id: 'identifier-of',
    re: /Identifier\.of\(/g,
    since: '1.21',
    until: '',
    what: 'Identifier.of(命名空间, 名字)',
    how: '1.20.x 换成 new Identifier(命名空间, 名字)（同一套参数，改法机械）',
    autofix: 'to-ctor',
    lang: 'java',
  },
  {
    id: 'identifier-ctor',
    re: /new\s+Identifier\(/g,
    since: '',
    until: '1.20.6',
    what: 'new Identifier(命名空间, 名字)',
    how: '1.21 起换成 Identifier.of(命名空间, 名字)，参数的写法一模一样',
    autofix: 'to-of',
    lang: 'java',
  },
  {
    id: 'item-settings-registry',
    re: /new\s+Item\.Settings\(\)/g,
    since: '',
    until: '1.21.1',
    what: 'new Item.Settings()',
    how: '1.21.2 起物品注册要带注册键：new Item.Settings().registryKey(RegistryKey.of(RegistryKeys.ITEM, id))',
    lang: 'java',
  },
  {
    id: 'registries-old-package',
    re: /net\.minecraft\.util\.registry\./g,
    since: '1.19.3',
    until: '',
    what: 'net.minecraft.util.registry.*',
    how: '1.19.3 起挪到 net.minecraft.registry.*（比如 Registries、RegistryKey）',
    lang: 'java',
  },
  {
    id: 'old-text',
    re: /new\s+(TranslatableText|LiteralText)\s*\(/g,
    since: '1.19',
    until: '',
    what: 'new TranslatableText / new LiteralText',
    how: '1.19 起统一成 Text.translatable(...) / Text.literal(...)',
    lang: 'java',
  },
  {
    id: 'registry-entry-attribute',
    re: /Registries\.ATTRIBUTE\b/g,
    since: '1.20.5',
    until: '',
    what: 'Registries.ATTRIBUTE 当普通对象用',
    how: '1.20.5 起属性是注册项（RegistryEntry），要取 .value() 或直接用 RegistryEntry<EntityAttribute>。这条本工具不自动改，务必手改',
    lang: 'java',
  },
]

/** 某条规则在目标版本上成立吗 */
export function ruleApplies(rule, mcVersion) {
  if (rule.since && cmpVersion(mcVersion, rule.since) < 0) return false
  if (rule.until && cmpVersion(mcVersion, rule.until) > 0) return false
  return true
}

/** 依赖声明的五个段（fabric.mod.json 用的） */
export const DEP_KINDS = ['depends', 'recommends', 'suggests', 'conflicts', 'breaks']
