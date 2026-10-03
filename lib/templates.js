/*
  templates.js —— 两种目标的工程骨架
  ===================================

  这里只放"一个能跑起来的最小工程"需要的文件。
  方块/物品/生物这些内容由各自的子工具往里加，不在这。

  版本号写在 gradle.properties 里，构建失败时改那一处就行。
  （Fabric 的这几个版本号会随游戏更新变，所以单独拎出来，别埋在 gradle 脚本里。）
*/
import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveProfile } from './versions.js'
import { alignJavaVersion } from './apifix.js'

async function put(dir, rel, text) {
  const full = join(dir, rel)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, text, 'utf8')
  return rel
}

/* ============================ Java / Fabric ============================ */

/*
  下面几段是"建完工程之后怎么把它编译出来"的辅助文件。

  为什么必须有：骨架建出来是一堆源码，但 Fabric 工程要用 gradle 构建，
  而用户机器上可能既没有 gradle 也没有 gradle wrapper（wrapper 里的 jar 是
  二进制，没法凭空生成）。没有这些东西，用户拿到工程就是干瞪眼 ——
  "生成可用的模组工程"这句话就落空了。

  用数组 join 而不是模板字符串写这些脚本：PowerShell 里到处是 `$`，
  塞进 JS 模板字符串会被当成插值，一个个转义太容易漏。
*/
const BUILD_PS1 = [
  '<#',
  '  编译这个模组（Fabric）。',
  '',
  '  怎么用：右键这个文件 -> "使用 PowerShell 运行"；',
  '          或者在终端里进到这个目录，敲  .\\build.ps1',
  '',
  '  第一次会下载 gradle 和 Minecraft 依赖（几百 MB），慢是正常的。',
  '  编译好的 jar 在  build\\libs\\  里面，丢进 .minecraft\\mods 就行。',
  '#>',
  '$ErrorActionPreference = "Stop"',
  'Set-Location -LiteralPath $PSScriptRoot',
  '',
  'function Find-Jdk {',
  '    # 插件装 JDK 时留的记号文件优先',
  '    $marker = "D:\\MCTools\\tools\\jdk-path.txt"',
  '    if (Test-Path -LiteralPath $marker) {',
  '        $p = (Get-Content -LiteralPath $marker -Raw).Trim()',
  '        if (Test-Path -LiteralPath (Join-Path $p "bin\\javac.exe")) { return $p }',
  '    }',
  '    if ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME "bin\\javac.exe"))) { return $env:JAVA_HOME }',
  '    $cmd = Get-Command javac -ErrorAction SilentlyContinue',
  '    if ($cmd) { return (Split-Path (Split-Path $cmd.Source)) }',
  '    return ""',
  '}',
  '',
  'function Find-Gradle {',
  '    $cmd = Get-Command gradle -ErrorAction SilentlyContinue',
  '    if ($cmd) { return $cmd.Source }',
  '    $root = "D:\\MCTools\\tools"',
  '    if (Test-Path -LiteralPath $root) {',
  '        $hit = Get-ChildItem -LiteralPath $root -Directory -Filter "gradle-*" -ErrorAction SilentlyContinue |',
  '               Sort-Object Name -Descending | Select-Object -First 1',
  '        if ($hit) {',
  '            $bat = Join-Path $hit.FullName "bin\\gradle.bat"',
  '            if (Test-Path -LiteralPath $bat) { return $bat }',
  '        }',
  '    }',
  '    return ""',
  '}',
  '',
  '$jdk = Find-Jdk',
  'if (-not $jdk) {',
  '    Write-Host ""',
  '    Write-Host "没找到 JDK。" -ForegroundColor Red',
  '    Write-Host "先让 AI 跑一下 install-jdk.ps1 装上 JDK（Java 21），再回来编译。"',
  '    Write-Host "或者自己装一个 JDK 21，然后设好 JAVA_HOME 环境变量。"',
  '    exit 1',
  '}',
  'Write-Host "JDK: $jdk" -ForegroundColor DarkGray',
  '$env:JAVA_HOME = $jdk',
  '',
  '$gradle = Find-Gradle',
  'if (-not $gradle) {',
  '    Write-Host ""',
  '    Write-Host "没找到 gradle。" -ForegroundColor Yellow',
  '    Write-Host "让 AI 帮你装（跟它说一声就行），或者手动装："',
  '    Write-Host "  1. 打开 https://services.gradle.org/distributions/"',
  '    Write-Host "  2. 下载 gradle-8.10-bin.zip"',
  '    Write-Host "  3. 解压到 D:\\MCTools\\tools\\  （解压出来应该是 D:\\MCTools\\tools\\gradle-8.10\\bin\\gradle.bat）"',
  '    Write-Host "  4. 再跑一次这个脚本"',
  '    exit 1',
  '}',
  'Write-Host "gradle: $gradle" -ForegroundColor DarkGray',
  '',
  'Write-Host ""',
  'Write-Host "开始编译（第一次要下载依赖，慢是正常的）..." -ForegroundColor Cyan',
  '& $gradle build',
  'if ($LASTEXITCODE -ne 0) {',
  '    Write-Host ""',
  '    Write-Host "编译失败。常见原因：" -ForegroundColor Red',
  '    Write-Host "  · gradle.properties 里的版本号对不上（去 https://fabricmc.net/develop/ 查）"',
  '    Write-Host "  · JDK 版本不对（1.20.x 要 Java 17，1.20.6 起要 Java 21）"',
  '    Write-Host "  · 网络下不动依赖（挂个代理再试）"',
  '    exit 1',
  '}',
  '',
  'Write-Host ""',
  'Write-Host "编译成功！" -ForegroundColor Green',
  'Write-Host "jar 在 build\\libs\\ 里，把它复制到 .minecraft\\mods 就能用了。"',
].join('\n')

const HOWTO_MD = [
  '# 怎么把这个模组编译出来',
  '',
  '这个工程是 **Fabric** 模组（Java 版）。改代码可以在任何编辑器里改，',
  '编译成一个能用的 `.jar` 需要下面几步。',
  '',
  '## 一、最省事的办法：跑 build.ps1',
  '',
  '右键 `build.ps1` → **使用 PowerShell 运行**。',
  '',
  '它会自己找 JDK 和 gradle，然后开始编译。第一次编译会从网上下载',
  'Minecraft 和 Fabric 的依赖（几百 MB），慢是正常的，之后就好了。',
  '',
  '编译成功的话，产物在：',
  '',
  '```',
  'build\\libs\\<模组名>-1.0.0.jar',
  '```',
  '',
  '把这个 jar 复制到 `.minecraft\\mods` 目录里就能用了。',
  '',
  '## 二、需要装什么',
  '',
  '| 东西 | 说明 |',
  '|---|---|',
  '| **JDK 21** | 1.20.6 及以后要 Java 21，1.20.x 要 Java 17 |',
  '| **gradle 8.x** | 构建工具。没有的话脚本会告诉你去哪下 |',
  '',
  'JDK 可以在这个对话里让 AI 装（它有 `install-jdk.ps1`），',
  '或者自己装一个然后设好 `JAVA_HOME`。',
  '',
  '## 三、用 IDE（改代码更舒服）',
  '',
  '推荐 IntelliJ IDEA 社区版（免费）：',
  '',
  '1. `File` → `Open`，选中这个工程目录',
  '2. IDEA 会自己识别 gradle 工程并下载依赖（第一次要等）',
  '3. 右边 `Gradle` 面板里双击 `Tasks` → `build` → `build`',
  '',
  'IDEA 里改完代码能直接断点调试，比命令行方便得多。',
  '',
  '## 四、编译不过怎么办',
  '',
  '按常见程度排：',
  '',
  '1. **版本号对不上** —— `gradle.properties` 里那几行是"哪个游戏版本配哪套依赖"，',
  '   对不上就下不动包。去 https://fabricmc.net/develop/ 查当前版本的正确值，',
  '   或者让 AI 跑 `do:net op:update` 自动改。',
  '2. **JDK 版本不对** —— 1.20.x 用 Java 17，1.20.6 起用 Java 21。',
  '   报 `Unsupported class file major version` 就是这个原因，改 `build.gradle` 里的',
  '   `JavaVersion.VERSION_XX` 和 `options.release`。',
  '3. **下载不下来** —— 国内网络访问 Maven 有时候会卡，挂个代理再试。',
  '',
  '## 五、这个工程里都有什么',
  '',
  '| 路径 | 是什么 |',
  '|---|---|',
  '| `src/main/java/` | 源码。方块、物品、生物的注册都在这里 |',
  '| `src/main/resources/fabric.mod.json` | 模组的名片。id、入口类、依赖声明 |',
  '| `src/main/resources/assets/<模组id>/` | 贴图、语言、音效、粒子 |',
  '| `src/main/resources/data/<模组id>/` | 配方、掉落表这些数据 |',
  '| `.mcmod/` | 插件记的"这个工程里有什么"的清单（改内容用 AI 改，别手改） |',
  '| `build.ps1` | 一键编译 |',
  '',
  '## 六、想改内容的话',
  '',
  '回去跟 AI 说就行，比如"再加一个能发光的方块"、"把红宝石的贴图换成蓝色"。',
  'AI 会通过插件的工具改这个工程，改完可以再跑一次 `build.ps1`。',
  '',
  '> 手改 `.mcmod/` 里的清单和它生成的 Java 文件容易对不上，',
  '> 建议要么全交给 AI，要么全自己来。',
].join('\n')

const GRADLE_WRAPPER = [
  'distributionBase=GRADLE_USER_HOME',
  'distributionPath=wrapper/dists',
  'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10-bin.zip',
  'networkTimeout=10000',
  'validateDistributionUrl=true',
  'zipStoreBase=GRADLE_USER_HOME',
  'zipStorePath=wrapper/dists',
].join('\n') + '\n'

/* ============================ 基岩版打包 ============================ */

const PACK_PS1 = [
  '<#',
  '  把行为包 + 资源包打成一个 .mcaddon 文件。',
  '',
  '  怎么用：右键这个文件 -> "使用 PowerShell 运行"；',
  '          或者在终端里敲  .\\打包.ps1',
  '',
  '  产物在工程根目录，那个 .mcaddon 双击就能装进游戏（或者直接丢进',
  '  Minecraft 的 development_behavior_packs 目录）。',
  '#>',
  '$ErrorActionPreference = "Stop"',
  'Set-Location -LiteralPath $PSScriptRoot',
  '',
  '$name = (Get-Item -LiteralPath $PSScriptRoot).Name',
  '$out  = Join-Path $PSScriptRoot ($name + ".mcaddon")',
  '',
  'foreach ($d in @("behavior_pack", "resource_pack")) {',
  '    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $d))) {',
  '        Write-Host "缺目录：$d" -ForegroundColor Red',
  '        exit 1',
  '    }',
  '}',
  '',
  'if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }',
  '# .mcaddon 就是个 zip，里面装着两个包目录',
  'Compress-Archive -Path (Join-Path $PSScriptRoot "behavior_pack"), (Join-Path $PSScriptRoot "resource_pack") -DestinationPath $out',
  '',
  'Write-Host ""',
  'Write-Host "打好了：$out" -ForegroundColor Green',
  'Write-Host "大小：$([math]::Round((Get-Item -LiteralPath $out).Length / 1KB, 1)) KB"',
].join('\n')

/* ============================ Java / Fabric ============================ */

export async function javaSkeleton(dir, meta) {
  const { modId, mcVersion, name } = meta
  /* 版本号必须按 mcVersion 查表，不能写死：
     早先 yarn_mappings 和 fabric_version 都是拿 mcVersion 拼的，
     建 1.20.1 的工程会得到 "fabric_version=0.102.0+1.20.1" —— 那个版本
     只发布了 +1.21，gradle 会直接报找不到依赖。 */
  const p = resolveProfile(mcVersion)
  const pkg = 'com.example.' + modId
  const pkgPath = pkg.replace(/\./g, '/')
  const cls = modId.replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase())

  const made = []

  made.push(await put(dir, 'settings.gradle', `pluginManagement {
    repositories {
        maven { name = 'Fabric'; url = 'https://maven.fabricmc.net/' }
        mavenCentral()
        gradlePluginPortal()
    }
}

rootProject.name = '${modId}'
`))

  made.push(await put(dir, 'gradle.properties', `# 构建失败先看这里 —— 版本号对不上是最常见的原因
org.gradle.jvmargs=-Xmx1G
org.gradle.parallel=true

# 去 https://fabricmc.net/develop/ 可以查到当前各项的最新版本，
# 或者直接让模型跑 do:net op:update，它会联网把这几行改到最新。
minecraft_version=${mcVersion}
yarn_mappings=${p.yarn}
loader_version=${p.loader}
fabric_version=${p.api}

mod_version=1.0.0
maven_group=com.example
archives_base_name=${modId}
`))

  made.push(await put(dir, 'build.gradle', `plugins {
    id 'fabric-loom' version '${p.loom}'
}

version = project.mod_version
group = project.maven_group

base { archivesName = project.archives_base_name }

repositories { mavenCentral() }

dependencies {
    minecraft "com.mojang:minecraft:\${project.minecraft_version}"
    mappings "net.fabricmc:yarn:\${project.yarn_mappings}:v2"
    modImplementation "net.fabricmc:fabric-loader:\${project.loader_version}"
    modImplementation "net.fabricmc.fabric-api:fabric-api:\${project.fabric_version}"
}

processResources {
    inputs.property "version", project.version
    filesMatching("fabric.mod.json") { expand "version": project.version }
}

tasks.withType(JavaCompile).configureEach { it.options.release = ${p.java} }

java {
    withSourcesJar()
    sourceCompatibility = JavaVersion.VERSION_${p.java}
    targetCompatibility = JavaVersion.VERSION_${p.java}
}
`))

  made.push(await put(dir, 'src/main/resources/fabric.mod.json', JSON.stringify({
    schemaVersion: 1,
    id: modId,
    version: '${version}',
    name,
    description: '用 DSH 的 mc_mod 工具生成的模组',
    authors: [],
    license: 'MIT',
    environment: '*',
    entrypoints: {
      main: [`${pkg}.${cls}`],
      /* 客户端入口现在就写上 —— 生物渲染器和粒子工厂都要挂在这儿，
         漏了的话生物"存在但看不见"、粒子"注册了不显示"，而且都不报错 */
      client: [`${pkg}.ModEntitiesClient`, `${pkg}.ModParticlesClient`],
    },
    depends: {
      fabricloader: `>=${p.loader}`,
      minecraft: `~${mcVersion}`,
      java: `>=${p.java}`,
      'fabric-api': '*',
    },
  }, null, 2) + '\n'))

  made.push(await put(dir, `src/main/java/${pkgPath}/${cls}.java`, `package ${pkg};

import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** 模组入口。方块、物品、生物这些注册都会挂到这里。 */
public class ${cls} implements ModInitializer {
    public static final String MOD_ID = "${modId}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    @Override
    public void onInitialize() {
        LOGGER.info("{} 已加载", MOD_ID);
        ModBlocks.init();
        ModItems.init();
        ModEntities.init();
        ModEffects.init();
        ModParticles.init();
    }
}
`))

  /* 空的效果表 + 粒子表 —— 同理，先放着让工程立刻能编译 */
  made.push(await put(dir, `src/main/java/${pkgPath}/ModEffects.java`, `package ${pkg};

import net.minecraft.entity.effect.StatusEffect;

/** 状态效果注册表 —— 由 DSH 的 mc_mod 工具生成，现在是空的。 */
public final class ModEffects {

    private ModEffects() { }

    public static void init() {
        ${cls}.LOGGER.info("效果表就绪（0 个）");
    }
}
`))

  made.push(await put(dir, `src/main/java/${pkgPath}/ModParticles.java`, `package ${pkg};

/** 粒子注册表 —— 由 DSH 的 mc_mod 工具生成，现在是空的。 */
public final class ModParticles {

    private ModParticles() { }

    public static void init() {
        ${cls}.LOGGER.info("粒子表就绪（0 种）");
    }
}
`))

  made.push(await put(dir, `src/main/java/${pkgPath}/ModParticlesClient.java`, `package ${pkg};

import net.fabricmc.api.ClientModInitializer;

/** 粒子客户端注册 —— 由 DSH 的 mc_mod 工具生成，现在是空的。 */
public class ModParticlesClient implements ClientModInitializer {

    @Override
    public void onInitializeClient() {
        ${cls}.LOGGER.info("粒子渲染器就绪（0 个）");
    }
}
`))

  /* 空生物表 + 空客户端入口 —— 同理，先放着让工程立刻能编译。
     客户端入口必须现在就写进 fabric.mod.json，否则以后加了生物会"看不见"。 */
  made.push(await put(dir, `src/main/java/${pkgPath}/ModEntities.java`, `package ${pkg};

import net.minecraft.entity.EntityType;

/** 生物注册表 —— 由 DSH 的 mc_mod 工具生成，现在是空的。 */
public final class ModEntities {

    private ModEntities() { }

    public static void init() {
        ${cls}.LOGGER.info("生物表就绪（0 种）");
    }
}
`))

  made.push(await put(dir, `src/main/java/${pkgPath}/ModEntitiesClient.java`, `package ${pkg};

import net.fabricmc.api.ClientModInitializer;

/** 客户端初始化 —— 生物的渲染器要挂在这儿，现在是空的。 */
public class ModEntitiesClient implements ClientModInitializer {

    @Override
    public void onInitializeClient() {
        ${cls}.LOGGER.info("客户端渲染器就绪（0 个）");
    }
}
`))

  /* 空的物品表 —— 和 ModBlocks 同理，先放一个空的好让工程立刻能编译 */
  made.push(await put(dir, `src/main/java/${pkgPath}/ModItems.java`, `package ${pkg};

import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.util.Identifier;

/** 物品注册表 —— 由 DSH 的 mc_mod 工具生成，现在是空的。 */
public final class ModItems {

    private ModItems() { }

    private static Item register(String id, Item item) {
        return Registry.register(Registries.ITEM, Identifier.of(${cls}.MOD_ID, id), item);
    }

    public static void init() {
        ${cls}.LOGGER.info("物品表就绪（0 个）");
    }
}
`))

  /* 一开始就放一个空的方块表 —— 这样刚建出来的工程立刻就能编译，
     不会因为 MyMod.java 引用了还不存在的 ModBlocks 而报错。 */
  made.push(await put(dir, `src/main/java/${pkgPath}/ModBlocks.java`, `package ${pkg};

import net.minecraft.block.AbstractBlock;
import net.minecraft.block.Block;
import net.minecraft.item.BlockItem;
import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.util.Identifier;

/** 方块注册表 —— 由 DSH 的 mc_mod 工具生成，现在是空的。 */
public final class ModBlocks {

    private ModBlocks() { }

    private static Block register(String id, Block block) {
        Identifier ident = Identifier.of(${cls}.MOD_ID, id);
        Registry.register(Registries.BLOCK, ident, block);
        Registry.register(Registries.ITEM, ident, new BlockItem(block, new Item.Settings()));
        return block;
    }

    public static void init() {
        ${cls}.LOGGER.info("方块表就绪（0 个）");
    }
}
`))

  /* 编译 / 打包的辅助文件 —— 骨架建出来，得让人知道怎么把它变成能用的东西。
     .ps1 前面加 \uFEFF：Windows PowerShell 5.1 读没有 BOM 的 UTF-8 会把中文
     注释和输出全变成乱码（脚本还能跑，但用户看着心里没底）。 */
  made.push(await put(dir, 'build.ps1', '\uFEFF' + BUILD_PS1))
  made.push(await put(dir, '怎么编译.md', HOWTO_MD))
  made.push(await put(dir, 'gradle/wrapper/gradle-wrapper.properties', GRADLE_WRAPPER))

  /* 上面这些模板是照 1.21 写的（Identifier.of(命名空间, 名字)）。
     目标版本更老的话（1.20.x）这个方法还不存在，生成出来直接编译不过 ——
     所以建完立刻按目标版本改写一遍。子工具往里加东西时也会再对齐一次。 */
  await alignJavaVersion(dir, mcVersion)

  return made
}

/* ============================ Bedrock 附加包 ============================ */

/** 基岩版资源包/行为包用的 UUID：必须是规规矩矩的 v4 */
const uid = () => randomUUID()

export async function bedrockSkeleton(dir, meta) {
  const { name, mcVersion } = meta
  const minEngine = String(mcVersion).split('.').map((n) => parseInt(n, 10) || 0)
  while (minEngine.length < 3) minEngine.push(0)

  const behaviorUuid = meta.packs?.behavior || uid()
  const resourceUuid = meta.packs?.resource || uid()

  const made = []

  made.push(await put(dir, 'behavior_pack/manifest.json', JSON.stringify({
    format_version: 2,
    header: {
      name: `${name} · 行为`,
      description: '由 DSH 的 mc_mod 工具生成',
      uuid: behaviorUuid,
      version: [1, 0, 0],
      min_engine_version: minEngine.slice(0, 3),
    },
    modules: [{ type: 'data', uuid: uid(), version: [1, 0, 0] }],
  }, null, 2) + '\n'))

  made.push(await put(dir, 'resource_pack/manifest.json', JSON.stringify({
    format_version: 2,
    header: {
      name: `${name} · 资源`,
      description: '由 DSH 的 mc_mod 工具生成',
      uuid: resourceUuid,
      version: [1, 0, 0],
      min_engine_version: minEngine.slice(0, 3),
    },
    modules: [{ type: 'resources', uuid: uid(), version: [1, 0, 0] }],
    /* 资源包要声明它依赖行为包，否则两个包在游戏里可能对不上 */
    dependencies: [{ uuid: behaviorUuid, version: [1, 0, 0] }],
  }, null, 2) + '\n'))

  /* 空目录留着，后面各子工具直接往里写，不用先判存在 */
  for (const d of [
    'behavior_pack/blocks', 'behavior_pack/items', 'behavior_pack/entities',
    'behavior_pack/recipes', 'behavior_pack/biomes', 'behavior_pack/loot_tables',
    'behavior_pack/scripts',
    'resource_pack/textures/blocks', 'resource_pack/textures/items',
    'resource_pack/textures/entity', 'resource_pack/models/entity',
    'resource_pack/particles', 'resource_pack/sounds',
    'resource_pack/texts',
  ]) {
    await mkdir(join(dir, d), { recursive: true })
  }
  made.push('behavior_pack/…  resource_pack/…  （空目录已建好）')

  made.push(await put(dir, 'resource_pack/texts/languages.json', JSON.stringify(['en_US', 'zh_CN'], null, 2) + '\n'))
  made.push(await put(dir, 'resource_pack/texts/en_US.lang', `pack.name=${name}\npack.description=Made with DSH mc_mod\n`))
  made.push(await put(dir, 'resource_pack/texts/zh_CN.lang', `pack.name=${name}\npack.description=由 DSH 的 mc_mod 生成\n`))

  /* 附加包不用编译，但要打成 .mcaddon 才能装 —— 手压缩容易压错层级 */
  made.push(await put(dir, '打包.ps1', '\uFEFF' + PACK_PS1))

  return made
}

export const __test = { uid }
