# Design

## Context

现有插件用目录复制保存环境，单份约 2.6 GB，备份根写死，恢复脚本从设置页触发时直接关进程、结束只按回车。新插件要在不修改现有插件的前提下，把"存档"变成"一个 zip + 一个脚本"，并让崩溃后的用户能自己完成回档。动机见 `proposal.md`，行为契约见 `specs/`。

已确认的运行环境约束：

- 仅 Windows。系统自带 `C:\Windows\System32\tar.exe`（bsdtar 3.8.9，支持 zip 与 zip64）、PowerShell 5.1、`robocopy`。
- 当前 DSH 44.7.0，安装目录 `C:\tool\dsh`，用户目录 `%USERPROFILE%\.dsh`，profile 内 `node_modules` 约 1.2 GB，安装目录约 1.1 GB。
- 实测：692 MB 目录压缩为 222 MB 用时 16.5 秒（约 42 MB/s）；整份 2.6 GB 预计 60–90 秒。
- 实测：bsdtar 写 zip 不带选项时中文名会变成 `????`；加 `--options hdrcharset=UTF-8` 后写入 UTF-8 标志位，`Expand-Archive` 与 `tar -xf` 都能还原中文名。
- 实测：bsdtar 对 junction 会跟随目录内容打包，而不是存为链接；现有存档里的 `node_modules\dsh-save-slots` 已从 junction 变成真实目录。
- 本机 `LongPathsEnabled=1`，但分发目标机器不一定开启。

## Goals / Non-Goals

**Goals:**

- 单份存档体积与备份耗时显著下降，且离线可完整恢复。
- 备份目录可自由选择，默认位置随安装目录变化，不写死盘符。
- 恢复脚本在 DSH 完全无法启动时仍可独立运行，先确认、后执行、结束停留。
- 回档不删除备份插件自身，不破坏本地 `link:` 依赖。

**Non-Goals:**

- 不迁移、不删除、不隐藏旧格式 `payload` 存档。
- 不做增量备份、去重、加密、云同步。
- 不修改现有 `C:\tool\MyPlugin` 插件。
- 不在本变更内实现自动更新或自动重启 DSH。

## Decisions

### 1. 压缩格式：zip + 系统 bsdtar

用 `C:\Windows\System32\tar.exe -a -c -f <id>.zip` 生成 zip，带 `--options hdrcharset=UTF-8`；恢复用 `tar -x -f` 解压。

- 不选 `Compress-Archive`：PowerShell 5.1 版本对 2 GB 以上内容和大文件有已知失败，且速度明显更慢。
- 不选 7-Zip：需要外部依赖，分发时无法假设对方安装。
- 不选 `tar.gz`/`tar.zst`：zip 是用户双击即可查看的通用格式，且恢复脚本可用系统 tar 直接解压。
- 不选"目录复制 + 用户手动压缩"：体积与分发体验都不可接受。

### 2. 打包用 staging junction，零复制

备份时创建临时 staging 目录，里面放指向 `install`、`profile/<profile>`、`profile/others`、`home`、`runtimes` 的 junction，加一个 `manifest.json`，然后一条 `tar -C staging -a -c` 生成 zip。

- 备选"先 robocopy 到临时目录再压缩"需要额外 2.6 GB 空间和一次全量复制，时间翻倍。
- junction 会被 bsdtar 跟随并写成真实内容，正好满足 zip 内结构；打包完删除 staging 不会影响源目录。

### 3. 恢复先解压到临时目录再镜像

解压到 `<backupRoot>\_restore-tmp\<id>`，校验关键文件后再用 `robocopy /MIR` 恢复 `install` 与 `profile`，`home`/`runtimes` 用 `/E` 覆盖。

- 备选"直接解压覆盖目标"省空间，但中途失败会留下半新半旧的环境，且无法在动目标前完成整体校验。
- 备选"边解压边校验"实现复杂，收益有限。
- 代价是需要额外磁盘空间，由恢复脚本的空间预检与说明覆盖。

### 4. 备份目录持久化在插件自己的数据目录

备份根保存在 `%USERPROFILE%\.dsh\dsh-crash-backup\settings.json`，插件每次请求读取；`cordis.patch.yml` 里的 `config.backupRoot` 只作为初始默认值。

- 备选"启动时改写 `cordis.patch.yml`"：会改用户配置、与 DSH 配置加载竞争、回档时还会被旧配置覆盖。
- 备选"用 DSH 的 settings 服务"：当前没有可用的插件级持久化接口证据，自管 JSON 最稳且可移植。
- 该目录不在备份的 `HOME_ITEMS` 内，回档不会把备份目录路径回滚成旧值。

### 5. 目录选择用系统文件夹对话框

Host 端 `spawn` 一个 `-STA -NoProfile` 的 PowerShell，调用 `System.Windows.Forms.FolderBrowserDialog`，用隐藏的 TopMost 宿主窗体避免被 DSH 窗口遮挡，结果经 stdout 返回；失败或超时回退为手输路径。

- 备选 Electron `dialog.showOpenDialog`：插件能否访问 Electron 模块没有证据，不作为依赖。
- 备选前端 `input[webkitdirectory]`：浏览器拿不到绝对路径，不可行。

### 6. 存档元数据双份：zip 内 manifest + 备份根索引

`manifest.json` 写进 zip，作为存档自包含的事实来源；`index.json` 放备份根，用于列表快速加载，缺失或损坏时从 zip 中央目录/`manifest.json` 重建。

- 备选"元数据放存档文件夹里的 json"：违反"文件夹只放压缩包和脚本"的约束。
- 索引重建用 `tar -xOf <zip> manifest.json` 读取，不需要完整解压。

### 7. 恢复时排除插件自身并重建链接

`robocopy /MIR /XD <profileDir>\node_modules\<self>` 排除本插件；备份时扫描 profile 内 junction/symlink，把相对路径与目标写入 manifest；恢复后按清单用 `mklink /J` 重建。

- 备选"只依赖 /MIR 自然保留"：镜像会删除存档中不存在的插件，必须显式排除。
- 备选 robocopy `/SL`：只能在复制阶段保留链接语义，zip 已经物化，恢复阶段仍需要清单。
- 创建 junction 不需要管理员权限，符合普通用户场景。

### 8. 恢复脚本拆为 cmd + ps1

`RESTORE.cmd` 只负责 `chcp 65001`、调用同目录 `RESTORE.ps1`、传递参数；`RESTORE.ps1` 承载全部逻辑。ps1 以 UTF-8 BOM 写入，保证 PowerShell 5.1 正确显示中文。

- 备选"单文件 cmd 内嵌 PowerShell"：不可维护、易被安全软件误报。
- 备选"只给 ps1"：双击默认用记事本打开，用户无法直接执行。

### 9. 确认交互放在脚本内，UI 触发也保留

无论从设置页触发还是双击，脚本都先显示存档信息并要求 `Y/N`；从 UI 触发时额外保留窗口，直到用户按键。结束后统一用 `ReadKey` 等待任意键，非交互场景回退到 `Read-Host`。

- 备选"UI 已确认就跳过脚本确认"：崩溃场景与 UI 场景行为不一致，且脚本被单独复制出去时失去保护。

### 10. 与旧插件共存但互不干扰

新插件使用独立 id `dsh-crash-backup`、独立路由 `/dsh-crash-backup/api`、独立设置区块。旧插件继续存在时不读取它的存档、不写它的目录；文档要求同时启用时先禁用旧插件。

## Risks / Trade-offs

- [备份时 DSH 正在运行，文件可能被写入] → 压缩前提示"备份期间避免修改设置"，并在失败时给出可读原因；不承诺停机一致性。
- [tar 跟随 junction 可能把链接目标内容一并打包，甚至循环] → 对 node_modules 先扫描链接，记录清单；遇到自引用或指向备份目录的链接时跳过并写入 manifest 警告。
- [恢复需要约 2.6 GB 额外解压空间] → 恢复前预检，说明文件写明空间要求，失败时清理 `_restore-tmp`。
- [FolderBrowserDialog 在某些无桌面会话不可用] → 超时或异常时回退为手输路径，并在 UI 给出提示。
- [目标机器未开启长路径] → 备份/恢复前检测注册表，关闭时提示可能失败，并优先使用 `\\?\` 前缀处理关键路径。
- [未签名的 ps1/cmd 可能被 SmartScreen 或杀软拦截] → 说明文件写明放行方式，脚本失败时提示具体错误，而不是静默退出。
- [旧插件与新插件同时启用会出现两个存档页] → 文档明确要求先禁用旧插件；新插件不自动禁用他人。
- [压缩包内含 `.credentials.yaml`] → 设置页与说明文件提示不要外传；加密列为后续可选项。

## Migration Plan

1. 在 `C:\tool\dsh-crash-backup` 开发并通过本机验证（备份、回档、崩溃模拟）。
2. 把新包加入 profile 依赖（先 `link:` 本地目录），在 `cordis.patch.yml` 中启用新插件、禁用旧插件。
3. 重启 DSH，确认设置页只有一个存档入口，且默认目录指向 `C:\tool\dsh-backups`。
4. 旧存档目录原样保留；需要回档旧存档时继续使用旧目录中自带的 `RESTORE.ps1`。
5. 回滚本变更：禁用新插件、恢复旧插件启用状态，删除新插件目录即可，存档数据不受影响。
