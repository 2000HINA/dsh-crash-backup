# dsh-crash-backup

DSH Desktop 的崩溃备份插件：手动把当前环境保存成**一个目录快照**，DSH 崩溃或无法启动后，直接双击存档里的 `RESTORE.cmd` 就能回档。

- **一份存档 = 一个文件夹**：`dsh-save-<时间戳>\`，里面是 `payload/` 目录、`manifest.json`、`RESTORE.cmd` 和 `RESTORE.ps1`。
- **只手动备份**：没有定时任务、启动/退出自动备份、agent 工具或后台监听；只有设置页的「备份当前环境」按钮会创建存档。
- **不依赖 DSH 回档**：`RESTORE.cmd` / `RESTORE.ps1` 是独立脚本，DSH 进程不存在也能运行。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 1803+ / Windows 11（回档依赖系统自带的 `tar.exe` 和 `robocopy`） |
| PowerShell | Windows PowerShell 5.1（`RESTORE.ps1` 声明 `#Requires -Version 5.1`） |
| DSH | DSH Desktop，当前开发与验证版本为 **44.7.0**；其它版本未验证 |
| 备份空间 | 每份存档约 **2.6 GB**；备份目录所在磁盘至少 **3 GB** 可用空间 |
| 回档空间 | 回档直接从存档目录复制，不再需要额外的解压空间 |
| 权限 | 当前用户可读写 DSH 安装目录、插件 profile 和备份目录 |

只支持 Windows；插件默认管理 `desktop` profile。

## 安装

### 方式一：DSH 插件市场（若已上架）

在 DSH 侧栏打开「插件」页，搜索 `dsh-crash-backup`，安装并启用。市场尚未上架时（0.1.0 未发布），使用方式二或方式三。

### 方式二：`link:` 本地仓库（推荐给开发者）

1. 打开当前 profile 的 `package.json`（默认 profile 为 `desktop`）：

   ```text
   %USERPROFILE%\.dsh\profiles\desktop\package.json
   ```

   设置了 `DSH_HOME` 时改用：

   ```text
   %DSH_HOME%\profiles\desktop\package.json
   ```

2. 在 `dependencies` 中加入下面这一行（路径按实际仓库位置修改，JSON 中用正斜杠）：

   ```json
   "dsh-crash-backup": "link:C:/tool/dsh-crash-backup"
   ```

3. 在 `dsh.profile.bundles` 数组末尾加入包名，启用该 bundle：

   ```json
   "dsh": {
     "profile": {
       "bundles": [
         "@deepseek-ai/dsh-base",
         "@deepseek-ai/dsh-web-app",
         "dsh-crash-backup"
       ]
     }
   }
   ```

4. 重启 DSH。侧栏「插件」页应能看到 `dsh-crash-backup` 并处于启用状态；若没有，用下面的方式三兜底。

### 方式三：手动复制到 `node_modules` + bundle patch

先关闭 DSH，然后复制整个包：

```powershell
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$dest = Join-Path $profileDir 'node_modules\dsh-crash-backup'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path 'C:\tool\dsh-crash-backup\*' -Destination $dest -Recurse -Force
```

再把下面这段追加到 profile 的 `cordis.patch.yml`（默认 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-crash-backup
      name: 'dsh-crash-backup'
      config:
        profile: desktop
```

重启 DSH。手动复制的包不会由包管理器维护，下次 `pnpm install` 或插件安装可能把它清掉；能用方式二就不要用方式三。

## 首次使用

1. 重启 DSH，打开 **设置 → 存档**（侧栏也有入口）。
2. 点击 **备份当前环境**。
3. 等待进度条依次经过：准备备份 → 检查环境 → 复制安装目录与插件 → 写入回退脚本 → 完成。备份期间可以继续使用 DSH，但不要关闭进程。
4. 完成后出现存档卡片，显示创建时间、DSH 版本、插件数量、大小和存档 id。

默认最多保留 **3 份**存档；达到上限后先删除一份旧存档，再备份。备份根目录可以在页面里用「更改目录」修改，不能选磁盘根目录、DSH 安装目录、profile 目录或 DSH home 内部（自动回退目录 `%DSH_HOME%\dsh-backups` 除外）；所选文件夹必须是空文件夹，或已经是本插件的备份目录，否则会被拒绝以免覆盖其中的文件。

## 崩溃后回档

1. 打开备份根目录。默认是 DSH 安装目录**同级**的 `dsh-backups`：DSH 装在 `C:\tool\dsh` 时就是 `C:\tool\dsh-backups`；默认目录不可写时会回退到 `%DSH_HOME%\dsh-backups`。也可以在设置页「存档」查看实际路径并点「打开文件夹」。
2. 进入要回档的 `dsh-save-*` 文件夹（按时间选最新的，或选崩溃前的那份）。
3. 双击 `RESTORE.cmd`。
4. 脚本先显示存档信息，然后让你选择回档方式：输入 `1` 是完整回档，输入 `2` 是仅回滚插件（两种模式的差别见下一节）。
5. 输入 `Y` 确认；如果脚本检测到 DSH 仍在运行，会再问一次是否结束进程，也输入 `Y`。
6. 等待脚本完成。成功、取消、失败三种结束都会停在窗口里，按任意键关闭。
7. 手动重新启动 DSH。

设置页「存档 → 回滚」的弹窗提供同样的两种模式，选定后点「确认回滚」，脚本会带着对应的模式启动。

脚本会先把当前配置快照到 `_pre-restore`，把过程写入 `_restore-logs`。也可以不双击，直接在存档目录运行：

```powershell
# 完整回档
powershell -NoProfile -ExecutionPolicy Bypass -File .\RESTORE.ps1 -Mode full
# 仅回滚插件
powershell -NoProfile -ExecutionPolicy Bypass -File .\RESTORE.ps1 -Mode plugins
```

## 两种回档模式

| 模式 | 恢复范围 | 对存档后新增内容的处理 |
| --- | --- | --- |
| **完整回档**（`-Mode full`，默认） | DSH 安装目录、当前插件 profile、用户目录白名单、`dsh-runtimes` | 安装目录和 profile 用 `robocopy /MIR` 镜像，会删除存档之后新增的文件；用户目录和运行库只覆盖，不删除 |
| **仅回滚插件**（`-Mode plugins`） | 只恢复当前插件 profile：`package.json`、`pnpm-lock.yaml`、`cordis.patch.yml` 和 `node_modules` | profile 用 `/MIR` 镜像，会删除存档之后新增的插件文件；其它内容一律不动 |

**仅回滚插件的确切范围**（适用场景：只是插件装坏或升级出问题，想回到某个插件组合，又不想动 DSH 本身）：

- **只改插件 profile**：`package.json`、锁文件 `pnpm-lock.yaml`、`cordis.patch.yml` 与 `node_modules` 恢复到存档状态；profile 里存档之后新增的插件会被删除。
- **不改 DSH 安装、用户数据和运行库**：安装目录、`home/`（`cordis.patch.yml`、`settings.yaml`、`.credentials.yaml`、`skills`、`storages` 等）和 `dsh-runtimes` 都保持原样，DSH 版本也不会回退。
- **插件数据不回退**：`storages` 等插件运行时数据不在恢复范围内，「仅回滚插件」不会把它们退回到存档时的状态。需要这些数据也回退时用完整回档。
- **DSH 版本不一致会警告**：存档版本与当前 DSH 版本不同时，脚本打印兼容性警告后继续；回档后的插件可能无法加载，遇到问题请改用完整回档。
- **同样需要重启**：两种模式都会先关闭 DSH，完成（或取消、失败）后都要手动重新启动 DSH。

设置页的「回滚」弹窗原样提供这两种模式；存档没有插件内容（`hasProfile: false`）时，「仅回滚插件」置灰并说明原因。两种模式共用同一套确认、回档前快照、日志、本插件自排除和 junction 重建逻辑。

## 数据与目录

插件自己只保存一个设置：**用户选定的备份根目录**。

```text
%USERPROFILE%\.dsh\dsh-crash-backup\settings.json    # 只含 {"backupRoot": "..."}
```

`DSH_HOME` 非默认时，这个文件在 `%DSH_HOME%\dsh-crash-backup\settings.json`。存档本身放在选定的备份目录，默认是 `C:\tool\dsh-backups`；默认目录不可写时会自动回退到 `%DSH_HOME%\dsh-backups`，设置页会说明回退原因。

```text
C:\tool\dsh-backups\
├─ dsh-save-20261024-214000\
│  ├─ payload\                        # install/、profile/、home/、runtimes/
│  ├─ manifest.json                   # 版本、插件清单、链接与体积
│  ├─ RESTORE.cmd                     # 双击入口
│  └─ RESTORE.ps1                     # 实际恢复脚本
├─ _pre-restore\<时间戳>\             # 每次回档前的当前配置快照
├─ _restore-logs\restore-*.log       # 回档日志（含 robocopy 失败明细）
├─ _restore-in-progress.json         # 回档脚本运行期间的占用标记，结束自动删除
├─ index.json                        # 存档索引（可重建的缓存）
├─ settings.json                     # 备份目录自身的元数据，不是插件设置
├─ .dsh-crash-backup.json            # 本插件的备份目录标记，请勿删除
└─ README.txt                        # 备份目录说明
```

如果回档脚本被强制结束（例如在任务管理器里结束进程），`_restore-in-progress.json` 可能残留在备份目录中，需要手动删除；在删除它之前，设置页会一直显示有任务正在进行。

存档的 `payload/` 里包含：`install/`（DSH 安装目录）、`profile/<profile>/`（含 `node_modules`）、其它 profile 的配置文件、`home/`（用户配置白名单，存在时含 `.credentials.yaml`）、`runtimes/`；`manifest.json` 记录版本、插件清单、链接与体积。`sessions`、`attachments`、`cache` 不在存档里，回档也不会删除它们。

## 安全与风险

- **存档里有凭据**：`home/.credentials.yaml` 会以明文进入存档，可能包含 API Key。不要上传、分享或同步备份目录，建议用 NTFS 权限限制访问，必要时放在 BitLocker 卷上。`_pre-restore` 里的配置也可能含敏感信息。
- **`/MIR` 会删除文件**：完整回档会把安装目录和插件 profile 恢复到存档时的状态，仅回滚插件同样会镜像整个插件 profile；存档之后新增或修改的内容都会丢失。确认要回到那一刻再执行。
- **本插件会保留自己**：恢复 profile 时排除 `node_modules\dsh-crash-backup`，并用 `manifest.json` 记录的信息重建 `link:` 依赖的 junction；如果存档创建时插件还没安装，脚本会提示重新安装。
- **回档前会检查常驻进程**：从 profile 的 `node_modules` 或用户目录启动的进程（dsh-ops 的 `fastctx.exe`/`pwsh.exe`、MCP server 等）会占用要恢复的文件；脚本会列出 PID 与路径并询问是否结束，拒绝或无法结束则中止，不修改任何目标。
- **时间戳按 2 秒精度比较**：恢复使用 `/FFT`，存档在 exFAT/FAT32 或被复制工具重写时间时，未变化文件会被跳过；代价是“同尺寸且 2 秒内”的改动可能不被复制。
- **只恢复自己创建的存档**：`RESTORE.ps1` 会执行恢复逻辑，不要运行来路不明的存档脚本。
- **备份不是瞬间快照**：复制时 DSH 仍在运行，文件可能在写入过程中变化。重要操作前先备份；备份进行中不要安装或升级插件，也不要修改设置。

## 卸载

1. 在侧栏「插件」页禁用 `dsh-crash-backup`；需要彻底移除时用「移除」，或从 profile `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 中删掉 `dsh-crash-backup`。
2. 手动复制安装的还要删两处：`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-crash-backup`，以及 profile `cordis.patch.yml` 中安装时追加的 `- insert:` 块（`id: dsh-crash-backup`）。只删除这一段，不要动其它插件配置；保留它会导致重启后 Loader 仍尝试加载已被删除的包并报错。

   ```yaml
   - insert:
       - id: dsh-crash-backup
         name: 'dsh-crash-backup'
         config:
           profile: desktop
   ```

3. 重启 DSH。

**存档和设置不会被删除**：存档在备份目录里，`%USERPROFILE%\.dsh\dsh-crash-backup\settings.json` 也会保留。不再需要时再手动删除备份目录；每份存档自带恢复脚本，即使插件已卸载也仍可回档。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 设置页看不到「存档」 | bundle 未启用或 DSH 未重启。打开侧栏「插件」页确认 `dsh-crash-backup` 已启用；手动安装的检查 `cordis.patch.yml` 和 `node_modules` 路径 |
| 选择目录 / 打开文件夹的窗口看不到 | 窗口可能被 DSH 挡在后面，查看任务栏或重试；仍不行时手动创建目录并写入 `%USERPROFILE%\.dsh\dsh-crash-backup\settings.json`：`{"backupRoot": "D:\\dsh-backups"}`，重启 DSH |
| 双击 `RESTORE.cmd` 窗口一闪而过 | 在存档目录打开 PowerShell 手动运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\RESTORE.ps1 -Mode full`，查看完整报错和 `_restore-logs` 最新日志 |
| 存档缺少 `payload/` 或 `manifest.json` | 脚本会在修改任何目标之前中止。换一个存档；检查磁盘错误和杀毒软件隔离记录；不要尝试强行恢复损坏的存档 |
| 磁盘空间不足 | 备份盘至少保留 3 GB；回档需要目标卷至少 256 MB 可用空间。清理磁盘，或在设置页把备份目录换到空间更大的卷 |
| 提示长路径未启用 | 备份/回档只提示不中止。把 `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled` 设为 `1` 并重启 Windows，可避免深层目录因路径过长失败 |
| 杀毒软件拦截 `RESTORE.ps1` / `RESTORE.cmd` | 把备份目录和 DSH 安装目录加入安全软件排除项，或在安全软件允许后手动运行；不要为此关闭实时防护 |
| 备份卡住或留下 `.partial` 目录 | 文件可能被杀毒软件/索引服务占用；稍后重试。超过 30 分钟的 `.partial` 会在下次备份前自动清理，也可关闭 DSH 后手动删除 |
| 回档后插件消失 | 存档创建于插件安装之前，profile 被存档覆盖。按上面的安装步骤重新安装 `dsh-crash-backup` |
| 回档后 DSH 无法启动 | 打开 `_restore-logs` 最新日志看最后一步；重新运行同一存档的 `RESTORE.ps1`（镜像是幂等的），或从 `_pre-restore` 手动取回配置 |

## 开发

```powershell
npm test
node --check index.js
node --check client.js
Get-ChildItem lib -Filter *.js | ForEach-Object { node --check $_.FullName }
```

打包检查：

```powershell
npm pack --dry-run
```

## 发布前 TODO（维护者）

- [ ] **确认许可证**：`package.json` 目前把 `license` 写成 `MIT` 占位，发布前需仓库所有者确认。
- [ ] **补 `repository` / `homepage` / `author`**：目前没有真实 URL 和作者信息，`package.json` 未填写，避免编造。
- [ ] **补截图**：设置页「存档」、存档卡片、`RESTORE.cmd` 窗口各一张，放进 `docs/` 并链接到本 README。
- [ ] **确认 DSH 版本范围**：当前只验证过 44.7.0；确认后写入 README 并考虑在 `package.json` 增加 `engines.dsh`。
- [ ] **市场发布**：发布 npm 包并在 DSH 插件市场上架后，把「方式一」改为确定可用的步骤。
