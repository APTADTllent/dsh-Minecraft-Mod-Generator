# dsh-minecraft-mod-generator

> 《我的世界》模组生成工作台 · A Minecraft mod-generation toolkit for DSH (DeepSeek Harness).
>
> Java 版生成 **Fabric** 工程，基岩版生成**附加包**，都在对话里直接产出可编译/可导入的文件。

---

## 安装

### 一条命令（推荐）

```bash
dsh plugin add https://github.com/APTADTllent/dsh-minecraft-mod-generator.git
```

DSH 会把这个仓库拉进 profile 的 `node_modules` 并注册好。装完重启 DSH 即可。

### 手动安装（备用）

如果上面那条命令不可用，手动来也是三步：

**1. 放进 DSH profile 的 `node_modules`**

把本目录整个复制过去：

```
<DSH_HOME>/profiles/web/node_modules/dsh-minecraft-mod-generator
```

`<DSH_HOME>` 通常是 `~/.dsh`（Windows 上是 `C:\Users\<你>\.dsh`）。
复制完确认 `<DSH_HOME>/profiles/web/node_modules/dsh-minecraft-mod-generator/package.json` 存在。

**2. 在补丁文件里注册**

编辑 `<DSH_HOME>/profiles/web/cordis.patch.yml`，加一段：

```yaml
- insert:
    - id: mc-mod
      name: 'dsh-minecraft-mod-generator'
```

**3. 重启 DSH**

`cordis.patch.yml` 的 `patchReload: live` **只监视补丁文件本身**。
改了插件源码但没动补丁，DSH 不会重新加载。

重启后在对话里问一句「你能用 mc_mod 吗」，或者直接让它建个模组，就能确认装好了。

### ⚠️ 最容易踩的坑

补丁行里的 `name` 必须是**裸包名**，且该包要能被 Node **从本 profile 解析到** ——
即 `profiles/web/node_modules/dsh-minecraft-mod-generator/package.json` 必须真实存在。

**解析失败会被静默跳过**（`pkgMeta = null`），症状是「模型说不出有这个工具」，
但**不报任何错**。装了却没反应，先查这里。

## 依赖与限制

### 依赖

| 用途 | 需要什么 |
|---|---|
| 基本功能（生成工程骨架、贴图、结构文件） | **无外部依赖** —— `lib/` 是纯 ESM JavaScript，只用 Node 内置模块 |
| 生成 Java 工程 | JDK 21（Fabric 1.20.5+ 要求），Gradle（工程自带 wrapper 配置） |
| 音效转换 | `ffmpeg`（在 PATH 里，或改脚本里的路径） |
| 提取原版贴图 | 一个《我的世界》Java 版客户端 jar；由 `lib/zip.js` 在进程内解包，不需要额外工具 |

`scripts/` 下有三个 PowerShell 脚本帮忙装环境：

- `install-jdk.ps1` — 下载并配置 JDK 21
- `install-gradle.ps1` — 配置 Gradle（带国内镜像回退）
- `extract-textures.ps1` — 已经不在运行时路径上，仅保留给新旧实现做逐字节对比测试，
  不再需要人手调用

装环境这三个脚本是 Windows PowerShell 的。**插件主体（`lib/`）是纯 ESM JavaScript，
跨平台可用**；只有安装/测试脚本是 Windows 专用。

### 限制

- **基岩版有硬限制**：加不了状态效果、加不了酿造配方、没有自定义着色器。
  详见下面「平台差异」一节。
- **Java 只支持 Fabric**。Forge / NeoForge 会被明确警告为不支持，不会假装能生成。
- **改不了视距**，任何模组都改不了。
- **不能生成光影**。
- **`verify` 是静态体检器，不是游戏模拟器**。MC 是闭源商业软件，
  插件不含游戏本体逻辑，**无法预测运行时行为**。
- **生成的工程要你自己编译**。Java 工程需要 JDK 21；插件只生成源码，
  不会替你跑一次完整构建。
- **联网功能只在 `net` 子工具和你主动跑安装脚本时发生**，
  目标域名全部列在下面「安全评审说明」一节。

---

## 关于进程调用与网络（安全评审说明）

这个插件会调用外部程序，全部列出如下，没有其他：

| 调用 | 用途 |
|---|---|
| `execFileSync('where', ['ffmpeg'])` | 查找 ffmpeg 是否可用 |
| `execFileSync(ffmpeg, [...])` | 把音频转成 `.ogg`（基岩版音效格式要求） |
| `execFileSync(<JDK>/bin/javac.exe, [...])` | `verify` 子工具做编译检查 |

**抽原版贴图不在这张表里** —— 自 2026-10-03 起改由 `lib/zip.js` 用 Node 内置
`zlib` 在进程内解包，不起子进程。旧版借 PowerShell + .NET 解包，已移除。

### 这些程序的路径和参数从哪来（评审关心的"是否可被攻击者控制"）

| 受控对象 | 来源 | 模型输入能否影响 |
|---|---|---|
| `ffmpeg` | `DSH_FFMPEG` 环境变量，或 PATH 里查到的第一个 | 不能 |
| `<JDK>/bin/javac.exe` | `scripts/install-jdk.ps1` 写的记号文件，或扫 `<home>/tools/jdk-*` 目录 | 不能 |
| 客户端 `jar` | 在固定的游戏目录候选里扫 `versions/*/*.jar`，挑最大的 | 不能 |
| 传给它们的参数 | 固定开关 + 上述路径 + 工程内自己生成的源文件路径 | 不能 |

工具参数（方块名、尺寸、颜色、模组名等）**只影响生成的源码内容，不进命令行、
也不参与路径解析**。这是本插件的边界：模型能决定"生成什么代码"，不能决定
"调用哪个程序"。

**外联域名**（仅 `net` 子工具和你主动跑安装脚本时会访问）：

```
meta.fabricmc.net / maven.fabricmc.net   Fabric 官方版本与仓库
piston-meta.mojang.com                   Mojang 官方版本清单
api.modrinth.com                         Modrinth 官方 API（搜模组）
services.gradle.org                      Gradle 官方
mirrors.cloud.tencent.com                腾讯镜像（Gradle 备用源）
api.adoptium.net                         Eclipse Adoptium（下载 JDK）
```

**没有硬编码密钥，没有 `eval` / `new Function`，没有递归删除，没有任何遥测或数据外发。**
所有网络请求的目标都是上面这些官方源，且只在对应功能被调用时发生。

---

## 设计核心：为什么只暴露一个工具

对模型**只注册一个**工具 `mc_mod`，内部再按 `do` 参数分派到 **21 个子工具**。

这不是为了好看，是为了省 token：

| 方案 | 每轮对话的固定开销 |
|---|---|
| 21 个工具各自注册 | 约 8000+ token |
| **只注册 `mc_mod`** | **约 570–670 token** |

子工具的参数**不写进工具描述**。模型需要时用 `args: {help: true}` 现问，
答一次只要几十 token —— 用的时候才付钱。

---

## 21 个子工具

| `do` | 作用 |
|---|---|
| `project` | 建/列/查模组工程（target = `java` 或 `bedrock`） |
| `structure` | 搭建筑结构放进模组（`.mcstructure` / `.nbt`），可逐块编辑 |
| `block` | 生成方块（硬度/工具/发光/贴图），Java 与基岩两套一起出 |
| `blocktex` | 生成 16×16 方块贴图（染色/噪点/矿石/十字植物/玻璃） |
| `entity` | 生成生物（血量/速度/碰撞箱/掉落），两套一起出 |
| `entityai` | 给生物加行为（攻击/游荡/逃跑/盯着玩家/被吸引） |
| `entitytex` | 生成 64×64 生物贴图（标准人形 UV，含脸） |
| `biome` | 生成生物群系（温度/降水/颜色/地表/刷怪） |
| `effect` | 状态效果（回血/加速/抗火…） |
| `brewing` | 做药水（基底 + 材料 → 药水） |
| `item` | 生成物品（堆叠数/稀有度/物品栏分类/贴图），两套一起出 |
| `itemtex` | 生成物品贴图（透明底 + 形状：宝石/锭/剑/镐/药水瓶/食物） |
| `itemuse` | 让物品右键有反应（吃/给效果/回血/放方块） |
| `recipe` | 生成合成/熔炼配方（有序/无序/熔炼），两套一起出 |
| `sound` | 生成音效（合成 → ffmpeg 转 ogg → 自动注册） |
| `anim` | 给生物加动作（待机/走路/攻击/死亡） |
| `render` | 调雾效/环境色 |
| `particle` | 生成粒子效果（闪光/火焰/烟/魔法/爆炸等） |
| `compat` | 改目标游戏版本、查 API 不兼容、声明模组依赖 |
| `verify` | 体检工程：断掉的引用、坏贴图、缺条目、编译错 |
| `net` | 联网查 loader/模组最新版、搜模组、下素材 |

不确定某个 `do` 的参数怎么填，传 `args: {help: true}` 问一下即可。

---

## 用法教程

对模型说人话就行：

```
帮我建一个 Fabric 模组，加一种会发光的矿石方块，挖了掉钻石
```

模型会自己调 `mc_mod`，按需要现问子工具的参数。生成完成后用 `do: verify`
体检一遍，再按工程里附带的 `怎么编译.md` 编译。

更完整的例子：

```
帮我建一个基岩版附加包，加一个「彩虹羊毛」方块，硬度跟石头一样，
要用镐子挖，挖了掉 2 个钻石，贴图做成彩色的
```

```
把刚才那个模组升级到 MC 1.21.4，顺便检查有没有 API 不兼容的地方
```

```
帮我查一下 Fabric loader 现在最新是什么版本，然后把工程里的版本号对齐
```

---

## 平台差异（别被误导，这些是硬限制）

| 能力 | Java (Fabric) | 基岩版 |
|---|---|---|
| 方块 / 物品 / 生物 / 群系 | ✅ | ✅ |
| 合成配方 | ✅ | ✅ |
| **状态效果** | ✅ 可自定义 | ❌ **加不了**，只能借原版 |
| **酿造配方** | ✅ 可自定义 | ❌ **加不了**，只能绕路 |
| **自定义着色器 / 光影** | ❌ 生成不了 | ❌ 生成不了 |
| **改视距** | ❌ 任何模组都改不了 | ❌ |
| 粒子 | 工厂返回 `null`，需挂原版粒子 | ✅ |
| 雾效 / 环境色 | 骨架 | ✅ 完整 |
| 生物动作 | 骨架 | ✅ 完整 |

其他必须说清楚的：

- **`verify` 是工程体检器，不是《我的世界》模拟器。** 它做静态检查
  （引用是否存在、方块状态与模型文件是否齐全、`javac` 能否编译通过等）。
  MC 是闭源商业软件，插件里不含也不能含游戏本体逻辑，因此**无法预测运行时行为**。
- **Java 只支持 Fabric。** Forge / NeoForge 会被明确警告为不支持，而不是假装能生成。

---

## 开发

```
lib/
  index.js          注册 mc_mod，唯一的模型入口
  naming.js         主类名/包名的唯一来源
  versions.js       7 个 MC 版本的 profile、loader 版本、API 规则
  apifix.js         跨版本源码改写（Identifier.of / 构造器）
  javamodels.js     方块与物品的 blockstate / model JSON
  mcstructure.js    基岩 .mcstructure 读写
  nbt.js            Java .nbt 结构
  templates.js      Java / 基岩工程骨架
  painter.js        程序化贴图绘制
  png.js            纯 JS PNG 编解码
  tools/            21 个子工具，每个一个文件
scripts/            Windows 环境安装脚本
```

改完代码后要重新复制到 profile 的 `node_modules` 再重启 DSH。

---

## 发布信息（维护者看）

**建议设置的 GitHub Topics**（插件市场靠其中之一识别）：

```
dsh-plugin          ← 必须
dsh
deepseek-harness
cordis-plugin
minecraft
mod-generator
fabric
bedrock
```

**插件标识**：本包的 `package.json` 里**没有** `dsh` 字段——这是有意的。
它是纯宿主插件，不向浏览器注入界面，所以 `dsh.client.platform` 对它没有意义。
识别请依赖 GitHub Topic `dsh-plugin`。

---

## License

MIT
