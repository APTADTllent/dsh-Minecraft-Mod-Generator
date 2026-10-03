# 装一个免安装的 JDK（Temurin 21 LTS），用来编译 Java 版模组
# ==========================================================
# 为什么用免安装 zip：
#   不动系统 PATH、不写注册表、不需要管理员权限，装完就是一个文件夹，
#   想撤掉直接删目录。以后插件内部按绝对路径调用 javac/gradle 就行。
#
# 为什么是 21：
#   现在模组生态的主流 LTS（NeoForge 1.20.5+ / Fabric 都吃 21）。
#   要别的版本改 -Feature 即可。
#
# 用法：powershell -File install-jdk.ps1 [-Root D:\MCTools] [-Feature 21]
param(
  [string]$Root = 'D:\MCTools',
  [int]$Feature = 21
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem

New-Item -ItemType Directory -Force -Path $Root | Out-Null

Write-Output "[jdk] 目标目录：$Root"

# 已经装过就别重复下 190MB
$existing = Get-ChildItem $Root -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "jdk-$Feature*" -and (Test-Path (Join-Path $_.FullName 'bin\java.exe')) } |
  Select-Object -First 1
if ($existing) {
  Write-Output "[jdk] 已经有了：$($existing.FullName)"
  & (Join-Path $existing.FullName 'bin\java.exe') -version 2>&1 | ForEach-Object { Write-Output "  $_" }
  exit 0
}

$zip = Join-Path $Root "temurin-jdk$Feature.zip"
$url = "https://api.adoptium.net/v3/binary/latest/$Feature/ga/windows/x64/jdk/hotspot/normal/eclipse"

if (-not (Test-Path $zip) -or (Get-Item $zip).Length -lt 50MB) {
  Write-Output "[jdk] 下载中（约 190MB）：$url"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $ok = $false
  for ($try = 1; $try -le 3 -and -not $ok; $try++) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 1800
      $ok = $true
    } catch {
      Write-Output "[jdk]   第 $try 次失败：$($_.Exception.Message)"
      Start-Sleep -Seconds 5
    }
  }
  if (-not $ok) { throw '下载失败（试了 3 次）' }
  $sw.Stop()
  Write-Output "[jdk] 下载完成：$([math]::Round((Get-Item $zip).Length/1MB,1)) MB，用了 $([math]::Round($sw.Elapsed.TotalSeconds)) 秒"
} else {
  Write-Output "[jdk] 复用已下好的包：$([math]::Round((Get-Item $zip).Length/1MB,1)) MB"
}

Write-Output "[jdk] 解压中 ..."
$sw2 = [Diagnostics.Stopwatch]::StartNew()
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $Root)
$sw2.Stop()
Write-Output "[jdk] 解压完成，用了 $([math]::Round($sw2.Elapsed.TotalSeconds)) 秒"

# zip 里顶层就是一个 jdk-21.x.y+z 目录
$dir = Get-ChildItem $Root -Directory |
  Where-Object { $_.Name -like "jdk-$Feature*" -and (Test-Path (Join-Path $_.FullName 'bin\java.exe')) } |
  Select-Object -First 1
if (-not $dir) { throw '解压完了却没找到 bin\java.exe，包结构可能变了' }

$java = Join-Path $dir.FullName 'bin\java.exe'
$javac = Join-Path $dir.FullName 'bin\javac.exe'
Write-Output "[jdk] 装好了：$($dir.FullName)"
Write-Output "[jdk] 自检："
& $java -version 2>&1 | ForEach-Object { Write-Output "  java  : $_" }
& $javac -version 2>&1 | ForEach-Object { Write-Output "  javac : $_" }

# 把路径记下来，插件直接读这个文件，不用去猜目录名
$marker = Join-Path $Root 'jdk-path.txt'
Set-Content -LiteralPath $marker -Value $dir.FullName -Encoding UTF8
Write-Output "[jdk] 路径已记录到：$marker"

# 下载包留着没用，删掉省 190MB（想重装删 marker 重跑即可）
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Write-Output '[jdk] 完成'
