# 集成验收结果（Task 16）

- 仓库：`C:\tool\dsh-crash-backup`
- 分支：`feature/crash-backup`；验收基线 HEAD：`25ee070 feat: choose restore scope in settings`
- 时间：2026-10-24（Asia/Shanghai）
- 环境：Windows；Node `v20.20.2`；npm `10.8.2`；Windows PowerShell `5.1.26100.9711`（`RESTORE.cmd` 实际使用的解释器）；系统 ANSI 代码页 `936`（GBK）
- 结论：**可自动执行的部分全部通过**；真实回档、真实 DSH 挂载、页面视觉与旧存档兼容性必须由维护者在本机手动执行（第 2、3 节）。

> 约束：回档的第一步就是关闭 DSH，而执行验收的 agent 运行在 DSH 会话内。执行真实回档会终止 agent 自身，之后既无法观察回档结果，也无法在失败后补救或补记证据。因此本会话**只做非破坏性验证**，真实回档由维护者按第 3 节手动执行。

## 1. 已自动验证（unit + temp integration）

### 1.1 单元测试

```powershell
cd C:\tool\dsh-crash-backup
npm test
```

```text
1..111
# tests 111
# suites 0
# pass 111
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2201.397
```

exit code `0`。12 个测试文件覆盖 `lib/*` 与 `client.js`（`api`、`archive`、`backup`、`client`、`config`、`constants`、`index-file`、`location`、`manifest`、`restore`、`scripts`、`settings`）。

### 1.2 语法检查

```powershell
Get-ChildItem lib -Filter *.js | ForEach-Object { node --check $_.FullName }
node --check index.js
node --check client.js
```

结果：**14/14 通过**，全部 exit `0`：
`lib/api.js`、`lib/archive.js`、`lib/backup.js`、`lib/config.js`、`lib/constants.js`、`lib/index-file.js`、`lib/location.js`、`lib/manifest.js`、`lib/picker.js`、`lib/restore.js`、`lib/scripts.js`、`lib/settings.js`、`index.js`、`client.js`。
`node --check` 只证明语法合法，逻辑由 1.1 与 1.4 覆盖。

### 1.3 打包清单

```powershell
npm pack --dry-run --json
```

结果：exit `0`；`entryCount` **21**；`filename` `dsh-crash-backup-0.1.0.tgz`；`size` 49,856 B；`unpackedSize` 160,467 B。
文件：`CHANGELOG.md`、`README.md`、`client.js`、`cordis.patch.yml`、`icon.svg`、`index.js`、`lib/` 下 12 个 `.js`、`locale/en.json`、`locale/zh.json`、`package.json`（合计 21）。dry-run 不生成 tarball；临时输出文件已删除。

### 1.4 临时目录集成验证（非破坏性）

目的：在没有真实 DSH、没有风险的前提下，用真实 `createBackup` 产出一份真存档，验证存档形状、BOM、zip 内容、`listSaves`、脚本可解析，以及本机 ACP（936）下中文文件名能否穿过 `listArchive` / `extractProfile`（ACP 解码是这台机器上最容易出问题的环节）。

假环境（全部位于 `%TEMP%\dsh-cb-task16-<时间戳>`）：

```text
install\version  install\app.js  install\resources\app.asar
home\AGENTS.md  home\settings.yaml  home\.credentials.yaml  home\skills\demo\SKILL.md
home\profiles\desktop\package.json  pnpm-lock.yaml  cordis.patch.yml
home\profiles\desktop\node_modules\dsh-crash-backup\package.json
home\profiles\desktop\插件说明-中文.txt
home\profiles\desktop\中文子目录\二级文件.txt
backups\                                  # backupRoot
```

验证脚本不入库，位于被忽略的 `.superpowers` 工作区：
`.superpowers\sdd\2026-10-24-dsh-crash-backup\it-integration.mjs`（prepare / cleanup 两个子命令）。

```powershell
$root = Join-Path $env:TEMP ('dsh-cb-task16-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
node .superpowers\sdd\2026-10-24-dsh-crash-backup\it-integration.mjs prepare $root
```

结果：exit `0`，**34 项断言全部 PASS**：

```text
SUMMARY {"saveId":"dsh-save-20261024-224609","folderNames":["RESTORE.cmd","RESTORE.ps1","dsh-save-20261024-224609.zip"],"zipBytes":5664,"zipEntryCount":24,"checks":34,"passed":34,"failed":0}
```

| 检查项 | 实测结果 |
| --- | --- |
| 存档文件夹条目 | 恰好 3 个文件：`RESTORE.cmd`、`RESTORE.ps1`、`dsh-save-20261024-224609.zip` |
| `RESTORE.ps1` BOM | 前 3 字节 `EF BB BF`（UTF-8 BOM） |
| `RESTORE.cmd` | 纯 ASCII（每个字节 < 0x80） |
| zip | 5,664 B / 24 个条目；含 `manifest.json`、`install/version`、`profile/desktop/package.json`；`install/version` 内容为 `0.1.0-it` |
| 中文文件名（`listArchive`） | 保留 `profile/desktop/插件说明-中文.txt`、`profile/desktop/中文子目录/二级文件.txt`（另有目录条目 `profile/desktop/中文子目录/`）；条目名中无 `U+FFFD` 替换字符 |
| 中文内容 | `readArchiveEntry` 读回的文本与写入内容完全一致 |
| `extractProfile` | 解出 `profile/desktop/*`（含中文文件与中文目录）和 `manifest.json`；中文名、两级文件内容、`package.json` 依赖均正确；**未**解出 `install/`（只含插件载荷） |
| `listSaves` | 1 份；`id` 一致、`hasProfile: true`、`pluginCount: 2`、`dshVersion: 0.1.0-it`、`sizeBytes: 1158`、`restorable: true` |
| `manifest.json` | `id`、`producer`、`contents.hasInstall/hasProfile/hasHome`、`links` 为数组，均正确 |
| 进度回调 | `checking:1 -> archive:10 -> scripts:90 -> done:100` |

`RESTORE.ps1` 可解析性（Windows PowerShell 5.1，即 `RESTORE.cmd` 实际调用的解释器）：

```powershell
# parse-check.ps1 的核心：$text = Get-Content -LiteralPath $Path -Raw; [ScriptBlock]::Create($text)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File <root>\parse-check.ps1 -Path <save>\RESTORE.ps1
```

```text
parsed=5.1.26100.9711 length=29803 params=[Mode,FromUi,InstallDirOverride,UserDshOverride,BackupRootOverride]
```

exit `0`：`[ScriptBlock]::Create` 接受整份脚本，5 个参数名与设计一致（`-Mode`、`-FromUi`、三个路径覆盖参数）。

清理（同时验证 `deleteSave` 与索引重建）：

```powershell
node .superpowers\sdd\2026-10-24-dsh-crash-backup\it-integration.mjs cleanup $root
```

```text
CLEANUP {"savesBefore":1,"savesAfter":0,"saveGone":true,"rootGone":true}
```

exit `0`：存档文件夹与整个临时根目录均已删除，`listSaves` 回到 0 份。

### 1.5 未触碰真实环境

- 上述所有路径都指向 `%TEMP%` 下的假环境；**没有执行任何 `RESTORE.ps1` / `RESTORE.cmd`**。
- 真实安装目录 `C:\tool\dsh`、真实 home `%USERPROFILE%\.dsh` 未被写入，也未被当作备份源读取。
- 真实备份根 `C:\tool\dsh-backups` 只做了只读列举：验证前后均为 5 个条目（2 份旧格式 `dsh-save-*`、`_pre-restore`、`_restore-logs`、`README.md`），无新增、删除或改写。
- 写文档前工作树干净；`npm pack --dry-run` 的临时 JSON 已删除。

## 2. 未在本会话验证（必须由维护者在本机执行）

| 编号 | 项目 | 为什么本会话不能执行 |
| --- | --- | --- |
| A | 真实 DSH 挂载（`link:` 安装 + 重启；设置页「存档」渲染） | 挂载生效必须重启 DSH，会终止执行本任务的会话 |
| B | 真实完整回档（备份 → 改配置 → 双击 `RESTORE.cmd` → 重启） | 脚本会关闭 DSH 并镜像真实安装目录/profile；失败时 agent 无法在场补救 |
| C | 真实仅插件回档 | 同上；从设置页发起也会启动脚本并关闭 DSH |
| D | 弹窗 / 文件夹选择器视觉行为 | 需要真实浏览器 DOM 与 Windows 对话框；本项目没有浏览器测试环境 |
| E | 旧存档不受影响 | 需要真实备份根中已存在的旧格式存档（本机现有 2 份，见 3.5） |

> 对这些项目，本会话只能做到：结构级单元测试（1.1）+ 真实 `createBackup` / `extractProfile` / `listSaves` 的临时环境集成（1.4）。它们不能替代真实 DSH 进程内的行为。

## 3. 手动验收清单（维护者在本机执行）

### 3.0 通用前置

```powershell
$install = 'C:\tool\dsh'                        # DSH 安装目录；以设置页显示为准
$home    = Join-Path $env:USERPROFILE '.dsh'    # 设置了 DSH_HOME 时替换
$profile = Join-Path $home 'profiles\desktop'
$backups = 'C:\tool\dsh-backups'                # 以设置页「备份目录」为准

# 基线：版本、存档数量、profile 三件套、home 文件 mtime
Get-Content "$install\version"
Get-ChildItem $backups -Force | Select-Object Name, LastWriteTime
Get-FileHash "$profile\package.json", "$profile\pnpm-lock.yaml", "$profile\cordis.patch.yml"
(Get-Item "$home\AGENTS.md").LastWriteTime
(Get-Item "$home\.credentials.yaml").LastWriteTime
Get-ChildItem $backups\_restore-logs -ErrorAction SilentlyContinue
```

- [ ] 关闭其它 DSH 窗口/实例；回档脚本也会检测并询问是否结束进程。
- [ ] 确认可以接受真实回档导致的数据回退；重要文件先另存副本。
- [ ] 每一步记录截图（建议 `docs/screenshots/task16-<编号>.png`）与 `_restore-logs` 最新日志路径，填入 3.7 的表格。

### 3.1 A：真实 DSH 挂载（link 安装 + 重启，设置页渲染）

1. [ ] 备份 `%USERPROFILE%\.dsh\profiles\desktop\package.json`。
2. [ ] 在 profile `package.json` 的 `dependencies` 加入 `"dsh-crash-backup": "link:C:/tool/dsh-crash-backup"`，并在 `dsh.profile.bundles` 数组末尾加入 `"dsh-crash-backup"`（见 README「安装 → 方式二」）。
3. [ ] 完全退出 DSH 后重启。
4. [ ] 侧栏打开「插件」页，确认 `dsh-crash-backup` 存在且已启用。
5. [ ] 打开 **设置 → 存档**（侧栏也有「存档」入口）。

预期观察：

- [ ] 侧栏出现「存档」；设置页内出现同名分区，标题「存档」，说明文字与 README 一致。
- [ ] 页面显示「备份目录」实际路径、「已保存 n/3」、「备份当前环境」「打开文件夹」「更改目录」。
- [ ] 已存在的 2 份旧格式存档**不**出现在列表里（它们没有 `.zip`），页面显示「还没有存档…」或只显示新格式存档。
- [ ] 浏览器开发者工具 Network 中 `GET /dsh-crash-backup/api/status` 返回 200，Console 无报错；页面无重复「存档」分区（若重复，先禁用旧插件 `dsh-save-slots`）。

回滚：

- [ ] 若渲染失败：从 profile `package.json` 删除 `dsh-crash-backup` 依赖与 bundles 条目，删除 `node_modules\dsh-crash-backup`（junction 用 `Remove-Item` 删除，不要跟随目标），重启 DSH。旧存档与备份根不受影响。

### 3.2 B：真实完整回档闭环（备份 → 改配置 → 双击 RESTORE.cmd → 重启）

1. [ ] 设置页点「备份当前环境」，等待进度依次经过：准备备份 → 检查环境 → 压缩安装目录与插件 → 写入回退脚本 → 完成；记录新存档 `id`。
2. [ ] 在存档文件夹确认恰好 3 个文件：`<id>.zip`、`RESTORE.cmd`、`RESTORE.ps1`；`RESTORE.ps1` 用 `Format-Hex` 看前 3 字节应为 `EF BB BF`。
3. [ ] 制造可观察差异（只改**已存在**的文件；home 不是镜像，新建文件不会被删除）：
   - [ ] 在 `$home\AGENTS.md` 末尾追加一行 `<!-- task16 full restore probe -->`；
   - [ ] 在 `$install` 下新建 `probe-full-restore.txt`；
   - [ ] 在 profile `package.json` 里加一个无害字段（或安装一个新插件）。
4. [ ] 完全退出 DSH，任务管理器确认无 DSH 进程。
5. [ ] 打开 `$backups\<id>`，双击 `RESTORE.cmd`。
6. [ ] 脚本先打印存档信息（id、时间、存档/当前 DSH 版本、安装目录、用户目录、profile、备份目录、脚本目录），随后显示菜单；输入 `1`（完整回档）。
7. [ ] 看到红色警告后输入 `Y`；若提示检测到 DSH 进程，确认后输入 `Y`。
8. [ ] 等待结束提示，按任意键关闭窗口；手动重启 DSH。

预期观察：

- [ ] 窗口不会一闪而过：信息、菜单、确认三处都会等待输入；结束（成功/取消/失败）都会停在「按任意键退出…」。
- [ ] `$backups\_pre-restore\<yyyyMMdd-HHmmss>\` 出现，含 `home\cordis.patch.yml`、`home\settings.yaml`（存在时）、`profile\package.json`、`profile\pnpm-lock.yaml`、`profile\cordis.patch.yml`（存在几个复制几个）。
- [ ] `$backups\_restore-logs\restore-<id>-<时间戳>.log` 生成；成功时最后一行为「回档完成，请重启 DSH。」
- [ ] 差异被撤销：`AGENTS.md` 的 probe 行消失、`$install\probe-full-restore.txt` 消失、profile `package.json` 恢复为存档内容。
- [ ] `profile\node_modules\dsh-crash-backup` 仍存在（profile 镜像排除本插件），重启后侧栏「存档」仍在。
- [ ] 重启后 `$install\version` 等于存档版本；设置页可打开，`%USERPROFILE%\.dsh\dsh-crash-backup\settings.json` 中的备份目录设置未被覆盖（home 恢复排除 `dsh-crash-backup`）。
- [ ] home 中**新建**的文件不会被删除（home 用覆盖 `/E`，不是 `/MIR`）；`sessions`、`attachments`、`cache` 未受影响。

核对命令：

```powershell
Get-Content "$install\probe-full-restore.txt" -ErrorAction SilentlyContinue   # 应不存在
Get-Content "$home\AGENTS.md" | Select-String 'task16 full restore probe'      # 应无匹配
Get-ChildItem $backups\_pre-restore | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content (Get-ChildItem $backups\_restore-logs\*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1) -Tail 5
Get-Content "$install\version"
Test-Path "$profile\node_modules\dsh-crash-backup"
```

回滚：

- [ ] 回档结果不正确时，用同一个存档再跑一次 `RESTORE.ps1 -Mode full`（镜像是幂等的）。
- [ ] 配置类回退：从 `_pre-restore\<时间戳>` 复制回 `home\`、`profile\` 的 5 个文件后重启 DSH。
- [ ] 注意：完整回档**没有**安装目录的完整快照，`_pre-restore` 只含上述 5 个配置文件；安装目录出错只能改用另一份存档回档或重装 DSH。

### 3.3 C：真实仅插件回档闭环

1. [ ] 确认存在包含 profile 的新格式存档（`hasProfile: true`；设置页卡片与 3.1 可见）。
2. [ ] 记录基线：`Get-FileHash "$profile\package.json", "$profile\pnpm-lock.yaml", "$profile\cordis.patch.yml"`；`Get-Content "$install\version"`；`(Get-Item "$home\.credentials.yaml").LastWriteTime`；`storages` 下任一文件 mtime。
3. [ ] 制造差异：在插件页安装/升级一个插件（会改 profile 与 `node_modules`），或在 profile `package.json` 里加一个依赖；再向 `$home\.credentials.yaml` 追加一行注释，用于证明 home 不被修改。
4. [ ] 二选一发起回档：
   - [ ] 脚本入口：退出 DSH 后双击存档的 `RESTORE.cmd`，菜单选 `2`；
   - [ ] 设置页入口：DSH 运行时打开「存档 → 回滚」，弹窗选「仅回滚插件」，点「确认回滚」；脚本检测到 DSH 仍在运行时会询问是否结束进程。
5. [ ] 看到「仅回滚插件：只恢复插件 profile…」说明后输入 `Y`（若询问结束 DSH 也输入 `Y`）。
6. [ ] 等待结束提示，按任意键关闭；手动重启 DSH。

预期观察：

- [ ] 脚本打印仅插件范围说明；DSH 与存档版本不一致时额外打印兼容性警告，但**继续执行**。
- [ ] `$backups\_pre-restore\<yyyyMMdd-HHmmss>-plugins\` 出现，只含当前 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`（存在几个复制几个），不含 `node_modules`。
- [ ] profile 回到存档状态：新装插件消失、`package.json` 内容与存档一致。
- [ ] `$install\version` 与回档前一致（DSH 不回退）；`$home\.credentials.yaml` 的 mtime 与内容未变；插件数据（`storages` 等）未变。
- [ ] 日志最后一行为「仅插件回档完成，请重启 DSH 加载回档后的插件。」
- [ ] 重启后侧栏「存档」仍在（本插件被排除在镜像之外）。

回滚：

- [ ] 从 `_pre-restore\<时间戳>-plugins` 复制 3 个配置文件回 profile，重启 DSH。
- [ ] `node_modules` 的插件版本无法由 `_pre-restore` 恢复；如需完全回到回档前，请用回档前创建的存档做一次完整回档，或重新安装对应插件。

### 3.4 D：弹窗与文件夹选择器视觉行为

在 DSH 运行、插件已挂载的前提下：

1. [ ] 点「更改目录」→ 出现系统文件夹选择器，说明文字为「选择用于保存 DSH 备份的文件夹」，初始位置是当前备份目录，有「新建文件夹」按钮。
2. [ ] 按 Esc / 取消 → 页面路径不变，无错误横幅；按钮恢复可用（不残留「选择目录…」）。
3. [ ] 选择一个合法新目录 → 路径更新；`%USERPROFILE%\.dsh\dsh-crash-backup\settings.json` 写入新路径；新目录生成 `README.txt`、`settings.json`、`index.json`、`_pre-restore`、`_restore-logs`。
4. [ ] 依次尝试非法目录：磁盘根、`$install` 内、`$profile` 内、`$home` 内 → 均被拒绝并显示具体原因（如「备份目录不能位于 DSH 安装目录内，回档时该位置会被镜像删除」），页面保持原路径。
5. [ ] 点「回滚」→ 弹窗标题「回滚到这个存档？」、正文、`回档范围` 两项（完整回档 / 仅回滚插件）默认选中完整回档；有 profile 的存档两项都可选。
6. [ ] 对 `hasProfile: false` 的存档（若有）：plugins 行置灰，描述显示「该存档缺少插件内容，无法仅回滚插件。」，确认按钮在选中该项时禁用。
7. [ ] 点「取消」或 Esc 或点遮罩 → 弹窗关闭，没有新控制台窗口、`_restore-logs` 无新日志。
8. [ ] 点「删除」→ 二次确认「永久删除」；确认后卡片消失、计数减一；取消则不变。
9. [ ] 用中文、含空格、非系统盘路径各重复一次第 3 步（例如 `D:\dsh 备份 测试\`），确认路径显示与备份/回档可用。

预期：弹窗与页面主题一致（深/浅色都正常）、无溢出、焦点在弹窗内；按钮在 busy 期间禁用；浏览器 Console 无报错。

回滚：

- [ ] 路径改坏时用「更改目录」改回原路径；或删除 `%USERPROFILE%\.dsh\dsh-crash-backup\settings.json`，让插件回退到默认备份目录（不会删除任何存档）。

### 3.5 E：旧存档不受影响

1. [ ] 记录基线（本机已有 2 份旧插件 `dsh-save-slots` 格式存档，含 `payload\` 与 `MANIFEST.json`，没有 `.zip`）：

```powershell
Get-ChildItem $backups -Force | Select-Object Name, LastWriteTime
Get-ChildItem $backups\dsh-save-* -Force | Select-Object FullName, LastWriteTime
```

2. [ ] 在设置页完成一次「备份当前环境」。
3. [ ] 重新执行上面的命令并对比。

预期观察：

- [ ] 旧格式 `dsh-save-*` 文件夹内容、名称、`LastWriteTime` 均未变；没有迁移、删除或改写。
- [ ] 旧存档不出现在本插件列表里；新存档正常出现。
- [ ] 备份数量上限只统计「文件夹内恰好一个 `.zip`」的存档，旧格式不占名额。
- [ ] `_pre-restore` / `_restore-logs` 只追加，不清理旧内容。
- [ ] 额外：在备份根手工创建一个 `dsh-save-stale.partial`，把 mtime 改为 1 小时前，再备份一次 → 该 `.partial` 被清理，其它目录不动（验证 `cleanupOrphans` 只清 `.partial`）。

回滚：该项为只读核对，无回滚动作；若不慎删除旧存档，使用旧存档自带的 `RESTORE.cmd` 或文件历史恢复。

### 3.6 补充项（对应 brief Step 3–5）

崩溃场景：

- [ ] 结束 DSH 进程后双击脚本，分别选 `1`、`2`：都应不依赖 DSH 完成；结束提示都等待任意键。
- [ ] 输入非法字符、直接回车、输入 `N`：都在修改目标前取消并停留等待按键。

路径矩阵：

- [ ] 中文目录、含空格目录、非系统盘各做一次备份与回档；全部成功；失败时给出具体原因。

异常路径（都在修改目标前中止、日志与提示可读）：

- [ ] 损坏 zip（复制一个存档后截断/改坏 zip）→「无法读取存档压缩包，文件可能已损坏。」
- [ ] 磁盘空间不足（可用小容量卷模拟）→ 备份目录/安装目录空间提示。
- [ ] 目标目录被占用（例如目标文件被其它进程独占）→ robocopy 失败终止，日志定位到目录。
- [ ] 存档缺少 profile（手工删掉 zip 中的 `profile/desktop` 后运行 `-Mode plugins`）→「存档不包含插件 profile…未修改任何文件。」

### 3.7 结果记录表

| 编号 | 执行人 | 日期 | 结果（通过/失败+原因） | 截图路径 | 最新日志 |
| --- | --- | --- | --- | --- | --- |
| A 真实挂载 |  |  |  |  |  |
| B 完整回档 |  |  |  |  |  |
| C 仅插件回档 |  |  |  |  |  |
| D 弹窗/选择器 |  |  |  |  |  |
| E 旧存档 |  |  |  |  |  |
| Step 3 崩溃场景 |  |  |  |  |  |
| Step 4 路径矩阵 |  |  |  |  |  |
| Step 5 异常路径 |  |  |  |  |  |

截图建议放在 `docs/screenshots/` 并在上表登记；README 的「补截图」待办可一并勾掉。

## 4. 已知限制（来自前序评审，不阻塞本次验收）

1. **JS helper 与内联 `RESTORE.ps1` 存在两套等价逻辑**：`lib/archive.js` 的 `extractProfile`、`lib/backup.js` 的 `snapshotProfile` / `assertModeSupported` 有单元测试与本次集成覆盖；但设置页发起的「仅回滚插件」实际走 `RESTORE.ps1` 内联实现。两套逻辑今后需同步修改；本次只验证了 JS 路径（1.4）与 PS1 的语法可解析（1.4），没有在真实环境验证 PS1 的仅插件分支（3.3）。
2. **回档锁的过期窗口**：`lib/api.js` 的 `RESTORE_LOCK_MS = 120000`。设置页启动回档后 `busy` 会保持 120 秒，期间不能备份/删除/再次回档；120 秒后锁自动释放（无论脚本是否仍在运行），因此用户在脚本里停留超过 2 分钟时，UI 已可发起新的备份/回档。正常完整回档会关闭 DSH，不受影响；真实行为待 3.3 手动确认，必要时可用配置项 `restoreLockMs` 延长。
3. **每份存档约 1 GB**：回档还需要约 zip × 3 + 512 MB 的临时空间（解压到 `<backupRoot>\_restore-tmp\<id>`）。本次集成用的是几 KB 的假环境，**未验证**大文件 IO、耗时、磁盘写满时的中止路径（3.6 手动项）。
4. **存档上限 3 份**（`MAX_SAVES = 3`）：达到上限时接口返回 409、页面提示先删除旧存档。上限的计数只含「恰好一个 zip」的新格式存档；提示文案的视觉效果未在本会话验证（3.4）。
5. 其它同批评审遗留（记录备查）：确认弹窗正文写的是运行 `RESTORE.cmd`，Host 实际启动 `RESTORE.ps1`（功能一致，文案待统一）；`hasProfile` 依赖 `index.json` 摘要，早期缺少该字段的旧索引会让「仅回滚插件」置灰，需删除索引触发重建；完整回档的范围说明未提及 `dsh-runtimes`（脚本实际会覆盖恢复）。

## 5. 结论

- 自动化部分：`npm test` 111/111 通过，14 个入口/模块语法检查通过，打包清单 21 个文件；临时目录集成 34/34 断言通过，含 BOM、zip 结构、PS1 解析、ACP 936 中文名与内容往返、`listSaves`、`deleteSave` 清理。
- 真实环境部分：**未执行**，原因见第 2 节；请按第 3 节逐项手动验收并填写 3.7。在这些手动项完成前，本任务只能算「自动化可执行部分验收通过」，不能宣称真实回档闭环已验收。
- 新增本文档后再次执行 `npm test`：`# tests 111 / # pass 111 / # fail 0`（exit `0`），文档改动不影响测试。
