<#
  install-gradle.ps1 —— 装一个 gradle 到 D:\MCTools\tools\

  为什么需要：Fabric 模组工程要用 gradle 构建，但用户机器上通常没有，
  而工程里的 gradle wrapper（gradlew）需要那个几十 KB 的二进制 jar 才能跑 ——
  那是没法凭空生成的。所以在这儿装一份全局的，工程的 build.ps1 会自动找到它。

  装完会留一个记号文件 D:\MCTools\tools\gradle-path.txt，
  工程里的 build.ps1 也认这个记号。

  用法（普通 PowerShell 窗口里）：
      powershell -ExecutionPolicy Bypass -File install-gradle.ps1
#>
$ErrorActionPreference = 'Stop'

$Version = '8.10'
$Root    = 'D:\MCTools'
$Tools   = Join-Path $Root 'tools'
$Target  = Join-Path $Tools "gradle-$Version"
$Marker  = Join-Path $Tools 'gradle-path.txt'

Write-Host ''
Write-Host "=== 装 gradle $Version ===" -ForegroundColor Cyan
Write-Host ''

# 已经装过就别重复下（130MB 呢）
if (Test-Path -LiteralPath (Join-Path $Target 'bin\gradle.bat')) {
    Write-Host "已经有了：$Target" -ForegroundColor Green
    Set-Content -LiteralPath $Marker -Value $Target -Encoding ASCII
    Write-Host "记号文件也更新了：$Marker"
    exit 0
}

# 系统里本来就有的话，直接用，不折腾
$sys = Get-Command gradle -ErrorAction SilentlyContinue
if ($sys) {
    Write-Host "系统里已经有 gradle：$($sys.Source)" -ForegroundColor Green
    Write-Host '不重复安装。工程的 build.ps1 会优先用它。'
    exit 0
}

New-Item -ItemType Directory -Force -Path $Tools | Out-Null

# 官方源国内常常很慢，所以带一个腾讯云镜像做备份
$Urls = @(
    "https://services.gradle.org/distributions/gradle-$Version-bin.zip",
    "https://mirrors.cloud.tencent.com/gradle/gradle-$Version-bin.zip"
)

$Zip = Join-Path $Tools "gradle-$Version-bin.zip"
$Got = $false
foreach ($u in $Urls) {
    Write-Host "下载：$u"
    try {
        # 用 WebClient 而不是 Invoke-WebRequest：PS 5.1 的 IWR 下大文件慢得多
        $client = New-Object System.Net.WebClient
        $client.DownloadFile($u, $Zip)
        $Got = $true
        break
    } catch {
        Write-Host "  这个源不行：$($_.Exception.Message)" -ForegroundColor Yellow
    } finally {
        if ($client) { $client.Dispose() }
    }
}

if (-not $Got) {
    Write-Host ''
    Write-Host '两个源都下不动。手动装的办法：' -ForegroundColor Red
    Write-Host "  1. 想办法下载 gradle-$Version-bin.zip（约 130MB）"
    Write-Host "  2. 解压到 $Tools\"
    Write-Host "     解压完应该是 $Target\bin\gradle.bat"
    Write-Host ''
    exit 1
}

$mb = [math]::Round((Get-Item -LiteralPath $Zip).Length / 1MB, 1)
Write-Host "下好了：$mb MB" -ForegroundColor Green

Write-Host '解压中...'
if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
Expand-Archive -LiteralPath $Zip -DestinationPath $Tools -Force
Remove-Item -LiteralPath $Zip -Force

if (-not (Test-Path -LiteralPath (Join-Path $Target 'bin\gradle.bat'))) {
    Write-Host "解压出来的结构不对，$Target\bin\gradle.bat 不存在。" -ForegroundColor Red
    exit 1
}

Set-Content -LiteralPath $Marker -Value $Target -Encoding ASCII

Write-Host ''
Write-Host "装好了：$Target" -ForegroundColor Green
Write-Host "记号文件：$Marker"
Write-Host ''
Write-Host '现在回到模组工程目录，跑 build.ps1 就能编译了。'
Write-Host '（第一次编译还要下 Minecraft 依赖，几百 MB，慢是正常的）'
