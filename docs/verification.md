# 集成验收结果（Task 16）

- 仓库：`C:\tool\dsh-crash-backup`
- 分支：`feature/crash-backup`；验收基线 HEAD：`25ee070 feat: choose restore scope in settings`
- 时间：2026-10-24（Asia/Shanghai）
- 环境：Windows；Node `v20.20.2`；npm `10.8.2`；Windows PowerShell `5.1.26100.9711`（`RESTORE.cmd` 实际使用的解释器）；系统 ANSI 代码页 `936`（GBK）
- 结论：**可自动执行的部分全部通过**；真实回档、真实 DSH 挂载、页面视觉、旧存档兼容性与异常路径必须由维护者在本机手动执行（第 2、3 节）。

> 约束：真实回档最终会关闭 DSH（双击时先显示存档信息并选择模式，随后是 Y/N 确认和前置校验，之后才结束 DSH 进程）；执行验收的 agent 运行在 DSH 会话内，DSH 一旦被关闭就无法继续观察或补救。因此本会话**只做非破坏性验证**，真实回档由维护者按第 3 节手动执行。

## 1. 已自动验证（unit + temp integration）

### 1.1 单元测试

```powershell
cd C:\tool\dsh-crash-backup
npm test
```

```text
1..132
# tests 132
# suites 0
# pass 132
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2654.6982
```

exit code `0`。13 个测试文件覆盖 `lib/*` 与 `client.js`（`api`、`archive`、`backup`、`client`、`config`、`constants`、`index-file`、`location`、`manifest`、`restore`、`restore-e2e`、`scripts`、`settings`）。
最终评审修复后新增了 `test/restore-e2e.test.js`（真实生成 `RESTORE.ps1` 并运行取消/损坏 zip 两条路径），并删除了已无生产调用方的 `extractProfile`、`snapshotProfile` 及其单元测试。`restore-e2e` 在缺少 Windows PowerShell 或 `tar.exe` 的机器上自动跳过。

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

结果：exit `0`；`entryCount` **21**；`filename` `dsh-crash-backup-0.1.0.tgz`；`size` 55,504 B；`unpackedSize` 179,444 B。
文件：`CHANGELOG.md`、`README.md`、`client.js`、`cordis.patch.yml`、`icon.svg`、`index.js`、`lib/` 下 12 个 `.js`、`locale/en.json`、`locale/zh.json`、`package.json`（合计 21）。`test/` 仍被 `files` 排除，新增的 `test/restore-e2e.test.js` 不进入发布包。dry-run 不生成 tarball；临时输出文件已删除。

### 1.4 临时目录集成验证（非破坏性）

目的：在没有真实 DSH、没有风险的前提下，用真实 `createBackup` 产出一份真存档，验证存档形状、BOM、zip 内容、`listSaves`、脚本可解析，以及本机 ACP（936）下中文文件名能否穿过 `listArchive`（当时还包含随后被移除的 `extractProfile`；ACP 解码是这台机器上最容易出问题的环节）。

注意：中文名结论只在系统 ANSI 代码页 **936（GBK）** 下成立。`archive.js` 按注册表 ACP 选择解码器，932（日文）、949（韩文）、65001（UTF-8）等代码页未实测，不能把这里的通过外推到其它代码页机器。

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
| `extractProfile`（该 helper 已在最终评审后移除） | 解出 `profile/desktop/*`（含中文文件与中文目录）和 `manifest.json`；中文名、两级文件内容、`package.json` 依赖均正确；**未**解出 `install/`（只含插件载荷）。此行为记录的是修复前那次运行，helper 已删除，回档逻辑只保留在 `RESTORE.ps1` 内 |
| `listSaves` | 1 份；`id` 一致、`hasProfile: true`、`pluginCount: 2`、`dshVersion: 0.1.0-it`、`sizeBytes: 1158`、`restorable: true` |
| `manifest.json` | `id`、`producer`、`contents.hasInstall/hasProfile/hasHome`、`links` 为数组，均正确 |
| 进度回调 | `checking:1 -> archive:10 -> scripts:90 -> done:100` |

`RESTORE.ps1` 可解析性（Windows PowerShell 5.1，即 `RESTORE.cmd` 实际调用的解释器）。不依赖外部脚本，直接在 5.1 窗口中内联执行：

```powershell
# 先启动 Windows PowerShell 5.1：powershell.exe -NoProfile
$ps1  = '<save>\RESTORE.ps1'
$text = Get-Content -LiteralPath $ps1 -Raw
$sb   = [ScriptBlock]::Create($text)   # 语法不合法会在这里抛错
"parsed=$($PSVersionTable.PSVersion) length=$($text.Length) params=$((($sb.Ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) -join ','))"
```

```text
parsed=5.1.26100.9711 length=29803 params=Mode,FromUi,InstallDirOverride,UserDshOverride,BackupRootOverride
```

`[ScriptBlock]::Create` 接受整份脚本，5 个参数名与设计一致（`-Mode`、`-FromUi`、三个路径覆盖参数）。`length` 会随存档 id、路径长度和生成时间变化，上例对应 1.4 那一次运行。

清理（同时验证 `deleteSave` 与索引重建）：

```powershell
node .superpowers\sdd\2026-10-24-dsh-crash-backup\it-integration.mjs cleanup $root
```

```text
CLEANUP {"savesBefore":1,"savesAfter":0,"saveGone":true,"rootGone":true}
```

exit `0`：存档文件夹与整个临时根目录均已删除，`listSaves` 回到 0 份。

### 1.5 未触碰真实环境

- 上述所有路径都指向 `%TEMP%` 下的假环境。最终评审修复后新增的 `test/restore-e2e.test.js` 会真实执行一次生成的 `RESTORE.ps1`，但只使用 `%TEMP%` 下的假 install/home/profile，且只走「取消」与「损坏 zip」两条不会写入恢复目标的路径；真实安装目录的 `RESTORE.ps1` / `RESTORE.cmd` 仍未执行。
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
| E | 旧存档不受影响 | 本机已有 2 份旧格式存档（见 3.5），不需要再准备；真正的阻塞是核对「新备份不改动旧存档」必须向真实备份根 `C:\tool\dsh-backups` 写入一份新存档，而本会话只做只读列举 |
| F | 崩溃场景（Step 3：结束 DSH 后运行脚本、菜单/确认处取消） | 需要结束真实 DSH 进程并运行真实脚本；本会话无法在 DSH 被终止后继续观察或补救 |
| G | 路径矩阵（Step 4：中文/空格/非系统盘路径各备份与回档） | 需要对真实备份根和真实安装目录反复写入；本会话只在 `%TEMP%` 的假环境验证过中文路径 |
| H | 异常路径（Step 5：损坏 zip、空间不足、锁定文件、缺 profile） | 需要构造损坏存档、文件锁或磁盘写满；其中写入阶段失败可能留下部分恢复，不能在 agent 会话内执行 |

> 对以上 A–H，本会话只能做到：结构级单元测试（1.1）+ 真实 `createBackup` / `listSaves` 的临时环境集成（1.4；当时还执行过随后被移除的 `extractProfile`）。它们不能替代真实 DSH 进程内的行为。

## 3. 手动验收清单（维护者在本机执行）

### 3.0 通用前置

```powershell
$install  = 'C:\tool\dsh'                        # DSH 安装目录；以设置页显示为准
$DshHome  = Join-Path $env:USERPROFILE '.dsh'    # 设置了 DSH_HOME 时替换
$profile  = Join-Path $DshHome 'profiles\desktop'
$backups  = 'C:\tool\dsh-backups'                # 以设置页「备份目录」为准

# 基线：版本、存档数量、profile 三件套、home 文件 mtime
Get-Content "$install\version"
Get-ChildItem $backups -Force | Select-Object Name, LastWriteTime
Get-FileHash "$profile\package.json", "$profile\pnpm-lock.yaml", "$profile\cordis.patch.yml"
(Get-Item "$DshHome\AGENTS.md").LastWriteTime
(Get-Item "$DshHome\.credentials.yaml").LastWriteTime
Get-ChildItem $backups\_restore-logs -ErrorAction SilentlyContinue
```

- 变量名用 `$DshHome`：`$HOME` / `$home` 是 PowerShell 的只读自动变量，不能赋值。
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
   - [ ] 在 `$DshHome\AGENTS.md` 末尾追加一行 `<!-- task16 full restore probe -->`；
   - [ ] 在 `$install` 下新建 `probe-full-restore.txt`；
   - [ ] 在 profile `package.json` 里加一个无害字段（或安装一个新插件）。
4. [ ] 完全退出 DSH，任务管理器确认无 DSH 进程。
5. [ ] 打开 `$backups\<id>`，双击 `RESTORE.cmd`。
6. [ ] 脚本先打印存档信息（id、时间、存档/当前 DSH 版本、安装目录、用户目录、profile、备份目录、脚本目录），随后显示菜单；输入 `1`（完整回档）。
7. [ ] 看到红色警告后输入 `Y`；若提示检测到 DSH 进程，确认后输入 `Y`。
8. [ ] 等待结束提示，按任意键关闭窗口；手动重启 DSH。

预期观察：

- [ ] 窗口不会一闪而过：存档信息打印后**不等待**，直接显示模式菜单；菜单、Y/N 确认与结束提示都会等待输入；结束（成功/取消/失败）都会停在「按任意键退出…」。
- [ ] `$backups\_pre-restore\<yyyyMMdd-HHmmss>\` 出现，含 `home\cordis.patch.yml`、`home\settings.yaml`（存在时）、`profile\package.json`、`profile\pnpm-lock.yaml`、`profile\cordis.patch.yml`（存在几个复制几个）。
- [ ] `$backups\_restore-logs\restore-<id>-<时间戳>.log` 生成；成功时最后一行为「回档完成，请重启 DSH。」
- [ ] 差异被撤销：`AGENTS.md` 的 probe 行消失、`$install\probe-full-restore.txt` 消失、profile `package.json` 恢复为存档内容。
- [ ] `profile\node_modules\dsh-crash-backup` 仍存在（profile 镜像排除本插件），重启后侧栏「存档」仍在。
- [ ] 重启后 `$install\version` 等于存档版本；设置页可打开，`%USERPROFILE%\.dsh\dsh-crash-backup\settings.json` 中的备份目录设置未被覆盖（home 恢复排除 `dsh-crash-backup`）。
- [ ] home 中**新建**的文件不会被删除（home 用覆盖 `/E`，不是 `/MIR`）；`sessions`、`attachments`、`cache` 未受影响。

核对命令：

```powershell
Get-Content "$install\probe-full-restore.txt" -ErrorAction SilentlyContinue   # 应不存在
Get-Content "$DshHome\AGENTS.md" | Select-String 'task16 full restore probe'      # 应无匹配
Get-ChildItem $backups\_pre-restore | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content (Get-ChildItem $backups\_restore-logs\*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1) -Tail 5
Get-Content "$install\version"
Test-Path "$profile\node_modules\dsh-crash-backup"
```

回滚：

- [ ] 回档结果不正确时，先排除导致失败的条件（如被锁的文件），再用**同一个存档**跑一次 `RESTORE.ps1 -Mode full`（安装目录与 profile 使用镜像，可重复执行；home/runtimes 是覆盖）。
- [ ] 配置类回退：从 `_pre-restore\<时间戳>` 复制回 `home\`、`profile\` 的 5 个文件后重启 DSH。
- [ ] 注意：`_pre-restore` 只有上述 5 个配置文件，**不含安装目录、`node_modules` 或 `AGENTS.md`**，不能用来撤销这三处的覆盖；安装目录或 `node_modules` 出错只能改用另一份存档回档或重装 DSH。

回档租约（可选，不需要真的完成回档；全程在 DSH 运行时做）：

1. [ ] 对一个有 profile 的存档点「回滚」→ 选「仅回滚插件」→「确认回滚」。
2. [ ] 脚本窗口显示信息与说明后停在「是否继续？」提示，先不要输入：检查备份目录出现 `_restore-in-progress.json`，且设置页 `GET /dsh-crash-backup/api/status` 返回 `"busy": true`（备份/回档/删除按钮禁用）。
3. [ ] 在该窗口输入 `N`（脚本取消并停在「按任意键退出」）；关闭窗口后确认 `_restore-in-progress.json` 已消失。
4. [ ] 回到设置页（轮询间隔 1.2 秒）：`busy` 变为 `false` 后可以再次发起备份；`_restore-logs` 中能看到这次取消的日志。取消后不再需要等待 120 秒。

### 3.3 C：真实仅插件回档闭环

1. [ ] 确认存在包含 profile 的新格式存档（`hasProfile: true`；设置页卡片与 3.1 可见）。
2. [ ] 记录回档前基线（安装版本与 profile 配置）：
   ```powershell
   Get-Content "$install\version"
   Get-FileHash "$profile\package.json", "$profile\pnpm-lock.yaml", "$profile\cordis.patch.yml"
   ```
3. [ ] 制造差异：在插件页安装/升级一个插件（会改 profile 与 `node_modules`），或在 profile `package.json` 里加一个依赖；再向 `$DshHome\.credentials.yaml` 追加一行注释，用于证明 home 不被修改：
   ```powershell
   Add-Content -LiteralPath "$DshHome\.credentials.yaml" -Value '# task16 plugin-only probe'
   ```
4. [ ] 在**追加之后**记录 home 与插件数据的回档前基线（这是预期观察的对比对象；不要在追加前记录，否则必然误报）：
   ```powershell
   Get-FileHash "$DshHome\.credentials.yaml"
   (Get-Item "$DshHome\.credentials.yaml").LastWriteTime
   Get-ChildItem "$DshHome\storages" -Recurse -ErrorAction SilentlyContinue |
     Select-Object FullName, LastWriteTime
   Get-ChildItem "$DshHome\storages" -Recurse -File -ErrorAction SilentlyContinue |
     Get-FileHash | Sort-Object Path
   ```
   若 `storages` 不存在或为空，记录“不存在/空目录”即可。
5. [ ] 二选一发起回档：
   - [ ] 脚本入口：退出 DSH 后双击存档的 `RESTORE.cmd`，菜单选 `2`；
   - [ ] 设置页入口：DSH 运行时打开「存档 → 回滚」，弹窗选「仅回滚插件」，点「确认回滚」；脚本检测到 DSH 仍在运行时会询问是否结束进程。
6. [ ] 看到「仅回滚插件：只恢复插件 profile…」说明后输入 `Y`（若询问结束 DSH 也输入 `Y`）。
7. [ ] 等待结束提示，按任意键关闭窗口。**先不要重启 DSH**：完成下面第 3、4 条文件比对后再手动重启，避免 DSH 启动时写 `storages`/配置造成误报。

预期观察：

- [ ] 脚本打印仅插件范围说明；DSH 与存档版本不一致时额外打印兼容性警告，但**继续执行**。
- [ ] `$backups\_pre-restore\<yyyyMMdd-HHmmss>-plugins\` 出现，只含当前 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`（存在几个复制几个），不含 `node_modules`。
- [ ] profile 回到存档状态：新装插件消失、`package.json` 内容与存档一致。
- [ ] `$install\version` 与回档前一致（DSH 不回退）；`$DshHome\.credentials.yaml` 的哈希、mtime 与内容与**第 4 步**的基线一致；`storages` 的 `FullName` / `LastWriteTime` 与哈希清单一致。
- [ ] 日志最后一行为「仅插件回档完成，请重启 DSH 加载回档后的插件。」
- [ ] 重启后侧栏「存档」仍在（本插件被排除在镜像之外）。

回滚：

- [ ] 若只想回退配置：从 `_pre-restore\<时间戳>-plugins` 复制 3 个配置文件回 profile 后重启 DSH；但 `node_modules` 不会跟着回退，`package.json` 与 `node_modules` 可能不一致（依赖缺失/版本不匹配），启动失败时仍需重装依赖或改用升级后的存档回档。
- [ ] `node_modules` 的插件版本无法由 `_pre-restore` 恢复（它只有 3 个配置文件，不含 `node_modules`，也不含 `AGENTS.md`；仅插件模式本来就不改 home/`AGENTS.md`）。要回到回档前的插件组合，必须使用**升级后、回档前创建的存档**再回档，或重新安装/升级对应插件；升级前的旧存档做完整回档会把 `node_modules` 一并退回旧版本，不等于“回到回档前”。

### 3.4 D：弹窗与文件夹选择器视觉行为

在 DSH 运行、插件已挂载的前提下：

1. [ ] 点「更改目录」→ 出现系统文件夹选择器，说明文字为「选择用于保存 DSH 备份的文件夹」，初始位置是当前备份目录，有「新建文件夹」按钮。
2. [ ] 按 Esc / 取消 → 页面路径不变，无错误横幅；按钮恢复可用（不残留「选择目录…」）。
3. [ ] 选择一个合法新目录 → 路径更新，并提示「旧目录中的存档仍然保留，不会被移动或删除」；`%USERPROFILE%\.dsh\dsh-crash-backup\settings.json` 写入新路径；新目录生成 `README.txt`、`settings.json`、`index.json`、`.dsh-crash-backup.json`、`_pre-restore`、`_restore-logs`。
4. [ ] 依次尝试非法目录：磁盘根、`$install` 内、`$profile` 内、`$DshHome` 内（`$DshHome\dsh-backups` 回退目录除外）、UNC 网络路径 `\\server\share`、含有其它文件的非空目录 → 均被拒绝并显示具体原因（如「备份目录不能位于 DSH 安装目录内，回档时该位置会被镜像删除」「所选文件夹不是空的…请选择一个空文件夹」），页面保持原路径且不覆盖其中的文件。
5. [ ] 点「回滚」→ 弹窗标题「回滚到这个存档？」、正文、`回档范围` 两项（完整回档 / 仅回滚插件）默认选中完整回档；有 profile 的存档两项都可选。
6. [ ] 对 `hasProfile: false` 的存档（若有）：plugins 行置灰且**不能被选中**，描述显示「该存档缺少插件内容，无法仅回滚插件。」；因为默认选中完整回档，确认按钮保持可用（禁用项本身选不中，所以不会出现“选中该项后确认按钮禁用”的可见状态）。
7. [ ] 点「取消」或 Esc 或点遮罩 → 弹窗关闭，没有新控制台窗口、`_restore-logs` 无新日志。
8. [ ] 点「删除」→ 二次确认「永久删除」；确认后卡片消失、计数减一；取消则不变。
9. [ ] 用中文、含空格、非系统盘路径各重复一次第 3 步（例如 `D:\dsh 备份 测试\`），确认路径显示与备份/回档可用。
10. [ ] 上限行为：已有 3 份新格式存档时，计数显示 `3/3`，「备份当前环境」按钮禁用且页面不弹错误提示；删除一份后按钮恢复可用。若要核对接口的 409 文案，在浏览器控制台（同源）执行：
    ```js
    fetch('/dsh-crash-backup/api/backup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(async (r) => [r.status, await r.json()])
    ```
    应得到 `[409, { error: '备份数量已达上限（最多 3 份存档），请先删除旧存档后再备份' }]`。这条路径绕过页面，错误不会显示在页面上。

预期：弹窗与页面主题一致（深/浅色都正常）、无溢出、焦点在弹窗内；按钮在 busy 期间禁用；浏览器 Console 无报错。

回滚：

- [ ] 路径改坏时用「更改目录」改回原路径；或删除 `%USERPROFILE%\.dsh\dsh-crash-backup\settings.json`，让插件回退到默认备份目录（不会删除任何存档）。

### 3.5 E：旧存档不受影响

1. [ ] 记录基线（本机已有 2 份旧插件 `dsh-save-slots` 格式存档，含 `payload\` 与 `MANIFEST.json`，没有 `.zip`）。用**不带 zip 的 `dsh-save-*` 目录**作为旧存档集合，记录名称、mtime、顶层文件哈希，以及 payload 的文件数/总字节数：
   ```powershell
   $legacy = Get-ChildItem $backups -Directory -Filter 'dsh-save-*' | Where-Object {
       -not $_.Name.EndsWith('.partial') -and
       -not (Get-ChildItem $_.FullName -File -Filter '*.zip' -ErrorAction SilentlyContinue)
   }
   $legacy | Select-Object Name, LastWriteTime
   # payload 有 4 万多个文件，逐文件哈希太慢；INTEGRITY.json 记录了关键文件的 SHA256，
   # 这里哈希顶层文件（含 INTEGRITY.json）并记录文件数/总字节数。
   $legacy | ForEach-Object { Get-ChildItem $_.FullName -File -Force | Get-FileHash } |
     Sort-Object Path
   $legacy | ForEach-Object {
       $stats = Get-ChildItem $_.FullName -Recurse -File -Force | Measure-Object -Property Length -Sum
       [pscustomobject]@{ Name = $_.Name; Files = $stats.Count; Bytes = $stats.Sum }
   }
   ```
2. [ ] 在设置页完成一次「备份当前环境」。
3. [ ] 重新执行上面的 `$legacy` 三段并对比。

预期观察：

- [ ] 旧格式 `dsh-save-*` 文件夹名称、`LastWriteTime`、顶层文件 `SHA256`（含 `INTEGRITY.json`）、文件数与总字节数均未变；没有迁移、删除或改写。
- [ ] 旧存档不出现在本插件列表里；新存档正常出现。
- [ ] 备份数量上限只统计「文件夹内恰好一个 `.zip`」的存档，旧格式不占名额。
- [ ] `_pre-restore` / `_restore-logs` 只追加，不清理旧内容。
- [ ] 额外：在备份根手工创建一个名为 `dsh-save-stale.partial` 的**目录**（不是文件；`cleanupOrphans` 只处理目录，文件会被跳过），把目录 mtime 改为 1 小时前，再备份一次 → 该目录被清理，其它目录不动：
  ```powershell
  $stale = Join-Path $backups 'dsh-save-stale.partial'
  New-Item -ItemType Directory -Path $stale -Force | Out-Null
  (Get-Item -LiteralPath $stale).LastWriteTime = (Get-Date).AddHours(-1)
  ```

回滚：该项为只读核对，无回滚动作。注意：旧存档自带的 `RESTORE.cmd` 就在该存档文件夹里，文件夹被删除后这个脚本也不可用，只能靠文件历史/另存的副本恢复。

### 3.6 补充项（对应 brief Step 3–5）

崩溃场景：

- [ ] 结束 DSH 进程后双击脚本，分别选 `1`、`2`：都应不依赖 DSH 完成；结束提示都等待任意键。
- [ ] 菜单阶段输入非法字符、直接回车：打印「输入无效：请重新输入 1 或 2。」并重新询问，不退出、不修改目标。
- [ ] 确认阶段输入 `N`、其它内容或直接回车：打印「已取消回档：未修改任何文件。」并停留等待按键。

路径矩阵：

- [ ] 中文目录、含空格目录、非系统盘各做一次备份与回档；全部成功；失败时给出具体原因。

预检类异常（可在修改安装目录/profile/home 之前中止，日志与提示可读）：

- [ ] 损坏 zip（复制一个存档后截断/改坏 zip）→「无法读取存档压缩包，文件可能已损坏。」
- [ ] 启动前磁盘空间不足（可用小容量卷模拟）→ 备份目录/安装目录空间提示。
- [ ] 存档缺少 profile（手工删掉 zip 中的 `profile/desktop` 后运行 `-Mode plugins`）→「存档不包含插件 profile…未修改任何文件。」
- [ ] 存档内**缺少** `manifest.json`（从 zip 删除该条目）→ 在 tar 列目录阶段中止，提示「存档中缺少 manifest.json，压缩包不完整。」，尚未解压、未修改目标。
- [ ] `manifest.json` 存在但内容损坏（改坏 JSON）→ 解压后在第一次 robocopy 前中止，提示「无法解析 manifest.json，存档可能已损坏，回档中止。」
- [ ] `manifest.json` 的 `links` 非法（改成非数组，或让链接指向 profile 之外）→ 解压后在第一次 robocopy 前中止，提示「manifest.json 的 links 不是数组…」或「manifest.json 中的链接指向 profile 之外…」。

写入阶段异常（**不保证原子**）：

> 预检只能拦住能在写入前发现的错误。tar 解压只写 `<backupRoot>\_restore-tmp`；一旦进入恢复阶段，robocopy 开始镜像安装目录/profile，或开始移除、重建 junction，失败就可能留下**部分恢复**的安装目录/profile。`RESTORE.ps1` 没有回滚机制，`_pre-restore` 也不备份安装目录或 `node_modules`。`robocopy`/`tar` 在复制开始后失败时，结果都不是事务性的：`tar` 可能留下不完整的 `_restore-tmp`，`robocopy` 可能留下部分恢复的安装目录/profile，不要假设目标仍是回档前状态。恢复办法：排除失败原因后**从同一份存档重跑**（镜像是幂等的，覆盖会补齐）；若同一份存档仍失败，改用一份已知良好的存档完整回档（没有可用存档时再重装 DSH）。

- [ ] 目标文件被独占（锁定一个 robocopy 会尝试复制、且不在 `_pre-restore` 快照里的文件）→ robocopy 在 `/R:1 /W:1` 重试后以 ≥8 退出，脚本打印并记录「回档失败：robocopy 失败（退出码 N）…」；确认安装目录/profile 可能已部分改变（profile 的目录链接会在 install 镜像前先被移除）。
  - **为什么不用 `$profile\package.json`**：`RESTORE.ps1` 在第一次 robocopy 前会先把 profile 的三个配置文件复制到 `_pre-restore`（`lib/scripts.js` 的快照阶段）；锁住 `package.json` 会让脚本在快照阶段就以「回档失败」退出，根本到不了 robocopy，测不到写入阶段的半恢复。这里锁 `$install\version`：它不在快照里。
  - **关键：先让目标与存档不同**：`Invoke-Robocopy` 没有传 `/IS`，robocopy 默认跳过大小和修改时间都相同的文件。如果刚跑完 3.2、`$install\version` 与存档里的内容完全一致，robocopy 会直接跳过锁住的文件，镜像成功、测试不会失败。所以先用下面的 `Set-Content` 改掉内容（大小/时间随之变化），再持锁。
  - **前置**：下面的锁命令沿用 3.0 定义的 `$install` 等变量，必须在**设置过这些变量的同一个 PowerShell 窗口**执行。新开一个窗口时 `$profile` 是 PowerShell 的自动变量（当前用户的 profile 脚本路径）、`$install` 也为空，会锁错路径或直接报错。本测试只能用**完整回档**（菜单选 `1`，或 `RESTORE.ps1 -Mode full`）；仅插件模式不写安装目录，锁 `$install\version` 不会触发 robocopy 失败。
  - **操作**：在这个持锁窗口执行：
    ```powershell
    # 先让 $install\version 与存档不同，robocopy 才会尝试覆盖它
    Set-Content -LiteralPath "$install\version" -Value 'lock-test' -NoNewline
    $lock = [System.IO.File]::Open("$install\version", 'Open', 'ReadWrite', 'None')
    # 保持此窗口和 $lock 不关闭，去运行 RESTORE.cmd（选 1）；看到 robocopy 失败后：
    $lock.Dispose()
    ```
  - 失败后**不要**直接重启 DSH；先释放锁，再用同一份存档重跑一次完整回档，确认能恢复到存档状态（`version` 会被存档内容覆盖回来）。此测试故意制造半恢复，建议在一次性环境或最后执行。
- [ ] 复制中途磁盘写满（可选，需可丢弃的环境；本会话未验证）：回档进行中占满备份盘或安装盘 → tar/robocopy 失败；同样可能留下不完整的临时目录或部分恢复的目标，按上面的方式重跑。启动前的空间预检见上一组，不等价于复制中途写满。

### 3.7 结果记录表

| 编号 | 执行人 | 日期 | 结果（通过/失败+原因） | 截图路径 | 最新日志 |
| --- | --- | --- | --- | --- | --- |
| A 真实挂载 |  |  |  |  |  |
| B 完整回档 |  |  |  |  |  |
| B 回档租约 |  |  |  |  |  |
| C 仅插件回档 |  |  |  |  |  |
| D 弹窗/选择器 |  |  |  |  |  |
| D 上限行为 |  |  |  |  |  |
| E 旧存档 |  |  |  |  |  |
| Step 3 崩溃场景 |  |  |  |  |  |
| Step 4 路径矩阵 |  |  |  |  |  |
| Step 5 异常路径 |  |  |  |  |  |

截图建议放在 `docs/screenshots/` 并在上表登记；README 的「补截图」待办可一并勾掉。

## 4. 已知限制（来自前序评审，不阻塞本次验收）

1. **遗留 JS helper 已清理**：`lib/archive.js` 的 `extractProfile` 与 `lib/backup.js` 的 `snapshotProfile` 在生产代码中没有调用方（其逻辑内联在 `RESTORE.ps1` 里），最终评审修复时已删除这两个 helper 及其单元测试。`assertModeSupported` 是活代码，由 `lib/api.js` 的 `startRestore` 在启动脚本前调用，仍然保留。今后修改回档逻辑只需同步 `RESTORE.ps1` 模板。
2. **回档锁与租约**：设置页启动回档后，`RESTORE.ps1` 在确认前写入 `<backupRoot>\_restore-in-progress.json`，并在所有退出路径（成功、取消、失败）删除。`status()` 只要看到这个文件就返回 `busy`，所以用户停在 Y/N 提示时不会在 120 秒后误放行第二个备份/回档；取消后脚本退出、租约删除，下一次轮询即恢复空闲。`RESTORE_LOCK_MS = 120000` 的进程内定时器仍保留，作为没有租约时的兜底（可用配置项 `restoreLockMs` 调整）。若脚本被强制结束而来不及删除租约，设置页会保持 `busy`，需要手动删除该文件后重试。真实行为按 3.2 的「回档租约」步骤验证（不是 3.3）。
3. **每份存档约 1 GB**：回档还需要约 zip × 3 + 512 MB 的临时空间（解压到 `<backupRoot>\_restore-tmp\<id>`）。本次集成用的是几 KB 的假环境；**大文件 IO/耗时属于 3.2 的真实备份与回档**，**磁盘在复制中途写满未验证**（3.6 的写入阶段异常只列了测试方法；启动前的空间预检不等价于复制中途写满）。
4. **存档上限 3 份**（`MAX_SAVES = 3`）：`GET /dsh-crash-backup/api/status` 返回 `maxSaves`。达到上限时设置页把「备份当前环境」禁用（计数显示 `3/3`），**不会弹出提示**；`POST /dsh-crash-backup/api/backup` 才返回 409「备份数量已达上限（最多 3 份存档），请先删除旧存档后再备份」，该文案只在绕过 UI 的请求中出现。计数只含「恰好一个 zip」的新格式存档。上限行为需按 3.4 第 10 步实测。
5. 其它同批评审遗留（记录备查）：确认弹窗正文写的是运行 `RESTORE.cmd`，Host 实际启动 `RESTORE.ps1`（功能一致，文案待统一）；`hasProfile` 依赖 `index.json` 摘要，早期缺少该字段的旧索引会让「仅回滚插件」置灰，需删除索引触发重建；**设置页的完整回档描述**（`modeFullDesc`）只写「恢复 DSH 安装目录、插件与用户配置」，未提 `dsh-runtimes`，而 README 的两种模式表已列出 `dsh-runtimes`；脚本实际会覆盖恢复 `dsh-runtimes`。

## 5. 结论

- 自动化部分：`npm test` 132/132 通过（13 个测试文件），14 个入口/模块语法检查通过，打包清单 21 个文件；临时目录集成 34/34 断言通过，含 BOM、zip 结构、PS1 解析、中文名与内容往返（仅 ACP 936）、`listSaves`、`deleteSave` 清理。新增的 `test/restore-e2e.test.js` 会真实运行生成的 `RESTORE.ps1`：取消路径 exit 0 且不改动任何目标，损坏 zip 非零退出并给出可读消息。
- 真实环境部分：**未执行**，原因见第 2 节（A–H）；请按第 3 节逐项手动验收并填写 3.7。在这些手动项完成前，本任务只能算「自动化可执行部分验收通过」，不能宣称真实回档闭环已验收。
- 本次修订后再执行 `npm test`：`# tests 132 / # pass 132 / # fail 0`（exit `0`），文档改动不影响测试。
