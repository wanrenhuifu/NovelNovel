# 把 dsh-novelnovel 装进 Desktop 的 profile，并在**应用完全退出后**自动完成入列与核对。
#
# 为什么等应用退出（**注意：第 1 条已被实测推翻，见下**）：
#   1. ~~profile 的 package.json 被运行中的应用持有（CLI 取写锁只等 120s，且退出时应用会再写一次）~~
#      —— 实测**不成立**：应用运行中对该文件做 ReadWrite/None 的独占打开能成功，说明它不持有文件锁；
#      `dsh plugin --profile desktop remove/add` 在应用运行中也能直接跑通。所以"必须退出"不是硬前提。
#      本脚本仍然等退出，是因为它是**手动触发的一次性操作**，等一下比解释锁语义便宜；
#      **但别把这条当成约束写进别的地方**（曾经就这么写进过 README 与 AGENTS.md）。
#   2. 插件只在启动时装载，装进去之后必须重启才会生效（**这条是真的**，也是唯一的硬理由）。
#
# 判据提醒：**不要用"进程数归零"当退出判据**——实测本机应用重启的窗口短于 2 秒轮询间隔，
#   等进程的脚本会永远等不到那一刻（白等 226 秒）。本脚本的 while 循环沿用了这个写法，
#   所以它只适合"用户真的会长时间不重开"的场景；更稳的做法是轮询 profile 的 package.json
#   是否可写，或干脆不等（见上：删除操作实测不需要等）。
#
# 为什么入口先查产物：profile 里放一份没有 `lib/index.js` 的包，加载期就会报错；
#   先拦下来比让用户对着一个加载失败的插件排查便宜。本包**两个半边都有**，
#   所以 `lib/index.js` 与 `lib/client.js` 都要查（客户端产物缺失会让**所有**客户端插件一起挂）。
#
# 为什么最后要核对 `dsh.profile.bundles`：加载只看这个列表（app-boot 的 loadProfileDirectory
#   逐个解析它），**依赖里有、列表里没有 = 不加载**。插件管理器只给「本次新装的依赖」补列表项，
#   已经掉出去的条目不会自动回来（手动取消选择组合包也是这个状态，那时是有意的）。
#
# 运行环境注意（本机实测）：脚本要能在 Windows PowerShell 5.1 下跑（本机没装 pwsh 7 时它就是
#   默认宿主），所以本文件必须存成 **UTF-8 带 BOM**（5.1 否则按 ANSI 解码，中文注释会让脚本报
#   语法错），并且**绝不能用 `Set-Content -Encoding UTF8` 写 profile 的 package.json**——
#   5.1 的 UTF8 带 BOM，而宿主用 JSON.parse 直接读，带 BOM 会解析失败。文件写入统一走 .NET。
#
# 取消：删除 $stopFile。日志：$logPath。结果：$statusPath。

$ErrorActionPreference = 'Continue'

# —— 本机实测路径（换机器只改这三行）——
$install    = 'D:\Users\qm\AppData\Local\Programs\DeepSeek Harness'
$repo       = 'D:\NovelNovel'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'

$cli         = Join-Path $install 'resources\runtime\cli\bin\dsh.cmd'
$profileJson = Join-Path $profileDir 'package.json'
$logPath     = Join-Path $env:USERPROFILE 'nn-install.log'
$statusPath  = Join-Path $env:USERPROFILE 'nn-install-status.txt'
$stopFile    = Join-Path $env:USERPROFILE 'nn-install.stop'
$pluginName  = 'dsh-novelnovel'
$keepBundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app')

# 机器读的文件（profile 的 package.json）必须**无 BOM**：宿主直接 JSON.parse，BOM 会让它解析失败。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
# 人读的文件（日志/状态）反过来要**带 BOM**：这台机器只有 PowerShell 5.1，
# 它的 Get-Content 对无 BOM 的 UTF-8 按 ANSI 解码，中文日志会变成乱码。
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

function WriteText([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
}
function WriteHuman([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, $utf8Bom)
}
# 必须走 .NET：5.1 的 Get-Content 对**无 BOM 的 UTF-8** 按 ANSI 解码，
# 任何含中文的 package.json（例如 dsh-whale-widget）都会变成乱码并让 ConvertFrom-Json 抛错。
function ReadJson([string]$path) {
  [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
}
function Say([string]$text) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $text"
  Write-Host $line
  [System.IO.File]::AppendAllText($logPath, "$line`r`n", $utf8Bom)
}
function SetStatus([string[]]$lines) {
  WriteHuman $statusPath (($lines -join "`r`n") + "`r`n")
}
function Fail([string]$text) {
  Say "!! $text"
  SetStatus @('结果：失败', "时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')", "原因：$text", "日志：$logPath")
  exit 1
}

SetStatus @('结果：进行中', "开始：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
Say '=== NovelNovel 入列 Desktop profile ==='

# ── 0. 前置闸门 ────────────────────────────────────────────────
foreach ($rel in 'lib\index.js', 'lib\client.js') {
  $f = Join-Path $repo $rel
  if (-not (Test-Path $f)) { Fail "缺少产物 $f —— 先在 $repo 跑 npm run build" }
  if ((Get-Item $f).Length -le 0) { Fail "产物是空文件：$f" }
}
if (-not (Test-Path $cli)) { Fail "找不到打包 CLI：$cli" }
if (-not (Test-Path $profileJson)) { Fail "找不到 profile 清单：$profileJson（先打开一次桌面端让它初始化）" }

# ── 1. 等应用完全退出 ─────────────────────────────────────────
Say "等待 DeepSeek Harness 完全退出（删除 $stopFile 可取消）..."
while ($true) {
  if (Test-Path $stopFile) { Say '收到停止文件，未做任何改动'; exit 0 }
  $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*' })
  if ($running.Count -eq 0) { break }
  Start-Sleep -Seconds 2
}
Say '应用已退出'
Start-Sleep -Seconds 4   # 让文件锁彻底释放、也让应用的收尾写入落完

# ── 2. 备份 ───────────────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $env:USERPROFILE ".dsh\profile-backup-$stamp"
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($f in 'package.json', 'cordis.patch.yml', 'pnpm-lock.yaml') {
  $src = Join-Path $profileDir $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $backup $f) -Force }
}
Say "已备份 profile -> $backup"

# ── 3. 安装（本地路径 = link:，以后 npm run build 的产物直接生效）──
Say "执行：dsh plugin --profile desktop add $repo"
& $cli plugin --profile desktop add $repo 2>&1 | ForEach-Object { Say "  $_" }
$code = $LASTEXITCODE
if ($code -ne 0) {
  Fail "CLI 退出码 $code（127 = 找不到 pnpm）。profile 已备份：$backup；回退：`"$cli`" plugin --profile desktop remove $pluginName"
}

# ── 4. 核对清单，并补回被挤掉的 bundles 记录 ──────────────────
$manifest = ReadJson $profileJson
$deps = @($manifest.dependencies.PSObject.Properties.Name)
if ($deps -notcontains $pluginName) { Fail "package.json 里没有 $pluginName 依赖；备份：$backup" }
Say "依赖清单：$($deps -join ', ')"

# 组合包列表可能整段缺失（`@($null)` 会得到一个含 null 的数组，写回去就是脏数据，必须显式判空）
$bundles = @()
if ($null -ne $manifest.dsh -and $null -ne $manifest.dsh.profile -and $null -ne $manifest.dsh.profile.bundles) {
  $bundles = @($manifest.dsh.profile.bundles)
}
if ($bundles -notcontains $pluginName) {
  Say "bundles 里没有 $pluginName（依赖里有也不算加载）——补上这一项"
  $manifest.dsh.profile.bundles = @($bundles + $pluginName)
  WriteText $profileJson (($manifest | ConvertTo-Json -Depth 20) + "`r`n")
  $bundles = @((ReadJson $profileJson).dsh.profile.bundles)
}
Say "组合包列表：$($bundles -join ', ')"

# ── 5. 最终核对 ───────────────────────────────────────────────
$problems = @()
foreach ($name in ($keepBundles + $pluginName)) {
  if ($bundles -notcontains $name) { $problems += "组合包列表缺 $name" }
}
$installed = Join-Path $profileDir "node_modules\$pluginName"
if (-not (Test-Path (Join-Path $installed 'package.json'))) { $problems += "profile 的 node_modules 里解析不到 $pluginName" }
foreach ($rel in 'lib\index.js', 'lib\client.js') {
  if (-not (Test-Path (Join-Path $installed $rel))) { $problems += "profile 侧看不到 $rel" }
}
# 依赖里有 dsh.bundle 却不在列表里的包 = 装了但不会加载。**这不一定故障**：
# 插件页的「组合包开关」取消选择时就是这个状态（从 bundles 摘掉、依赖保留），是有意为之。
$orphans = @()
foreach ($name in $deps) {
  $pkgJson = Join-Path $profileDir "node_modules\$name\package.json"
  if (-not (Test-Path $pkgJson)) { continue }
  $pkg = ReadJson $pkgJson
  if ($null -ne $pkg.dsh.bundle -and $bundles -notcontains $name) { $orphans += $name }
}
if ($orphans.Count -gt 0) { Say "提示：这些依赖声明了 dsh.bundle 但不在组合包列表里 -> $($orphans -join ', ')（若是在插件页主动关掉的，属正常；否则它们不会加载）" }

if ($problems.Count -gt 0) { Fail "$($problems -join '；')（备份：$backup）" }

Say "完成：$pluginName 已在依赖与组合包列表里，产物可见。"
Say '启动 DeepSeek Harness 后，侧栏应出现 NovelNovel 图标。'
SetStatus @(
  '结果：成功',
  "时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
  "组合包：$($bundles -join ', ')",
  "备份：$backup",
  "回退：`"$cli`" plugin --profile desktop remove $pluginName",
  "日志：$logPath"
)
exit 0
