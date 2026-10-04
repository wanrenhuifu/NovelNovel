# 把 dsh-novelnovel 重新加入 desktop profile 的 bundles —— 全自动版。
#
# 设计目标：**用户不做任何操作**。脚本在后台常驻，等 DSH 退出后立刻完成入列并核对，
# 全程写日志；用户下次打开 DSH 时面板就已经在了。
#
# 为什么必须等应用退出：profile 的 package.json 被运行中的应用持有，而且应用会在
# 退出/安装插件时整体重写它（上一次就是这么把 bundles 里的记录挤掉的）。
# 顺序必须是：应用完全退出 → dsh plugin add → 核对四项都在。
#
# 取消方式：删除 %TEMP%\nn-restore-bundle.stop（或直接结束这个 powershell 进程）。
# 日志：%TEMP%\nn-restore-bundle.log

$ErrorActionPreference = 'Continue'

$install = 'D:\DSH'
$cli = Join-Path $install 'resources\runtime\cli\bin\dsh.cmd'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$profileJson = Join-Path $profileDir 'package.json'
$pluginPath = 'D:\novelnovel'
$stopFile = Join-Path $env:TEMP 'nn-restore-bundle.stop'
$expectedBundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-whale-widget', 'dsh-novelnovel')

function Say($text) { Write-Host "$(Get-Date -Format 'HH:mm:ss')  $text" }
function SayErr($text) { Write-Host "$(Get-Date -Format 'HH:mm:ss')  !! $text" }

Say ''
Say 'DSH NovelNovel - 自动重新入列 desktop profile'
Say ''

if (-not (Test-Path $cli)) { SayErr "找不到打包 CLI：$cli"; exit 1 }
if (-not (Test-Path $profileJson)) { SayErr "找不到 profile：$profileJson"; exit 1 }
if (-not (Test-Path (Join-Path $pluginPath 'lib\client.js'))) {
  SayErr '缺少客户端产物 lib\client.js —— 先在仓库里跑 npm run build（产物缺失会让启动失败）'
  exit 1
}

# 备份（每次运行都留一份，便于回退）
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $env:USERPROFILE ".dsh\profile-backup-$stamp"
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($f in @('package.json', 'cordis.patch.yml', 'cordis.yml')) {
  $src = Join-Path $profileDir $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $backup $f) -Force }
}
Say "已备份 profile -> $backup"
Say "等待 DSH 完全退出（不设时限；删除 $stopFile 可取消）..."

while ($true) {
  if (Test-Path $stopFile) { Say '收到停止文件，退出（未做任何改动）'; exit 0 }
  $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'DeepSeek' })
  if ($running.Count -eq 0) { break }
  Start-Sleep -Seconds 2
}

Say 'DSH 已退出，开始入列'
Start-Sleep -Seconds 3   # 让文件锁彻底释放

# 已经装过就不重复 add（幂等，避免多余重写）
$before = @()
try { $before = (Get-Content $profileJson -Raw | ConvertFrom-Json).dsh.profile.bundles } catch { }
if ($before -contains 'dsh-novelnovel') {
  Say 'bundles 里已经有 dsh-novelnovel，跳过 add'
} else {
  Say "执行：dsh plugin --profile desktop add $pluginPath"
  & $cli plugin --profile desktop add $pluginPath 2>&1 | ForEach-Object { Say "  $_" }
  $code = $LASTEXITCODE
  if ($code -ne 0) { SayErr "CLI 退出码 $code（profile 已备份：$backup）"; exit $code }
}

# 核对：四项一个都不能少
$bundles = @()
try { $bundles = (Get-Content $profileJson -Raw | ConvertFrom-Json).dsh.profile.bundles } catch { }
Say '核对 bundles：'
$missing = @()
foreach ($want in $expectedBundles) {
  if ($bundles -contains $want) { Say "  OK   $want" } else { SayErr "  缺失 $want"; $missing += $want }
}

if ($missing.Count -gt 0) {
  SayErr "缺 $($missing.Count) 项，请先别启动。备份：$backup"
  SayErr "退回干净状态： `"$cli`" plugin --profile desktop remove dsh-novelnovel"
  exit 1
}

Say ''
Say '完成：四项都在。现在启动 DSH 就会看到 NovelNovel 面板。'
Say '若侧栏没有图标，回退命令：'
Say "  `"$cli`" plugin --profile desktop remove dsh-novelnovel"
exit 0
