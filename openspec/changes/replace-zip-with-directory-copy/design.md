# Design

## Context

当前实现把环境打成 zip，恢复时先解压到 `_restore-tmp`。实机暴露出两个回归：zip 丢失亚秒时间戳，robocopy 因此重写整个 `node_modules`；从 profile 启动的常驻进程（`fastctx.exe`）锁住文件，导致恢复以退出码 9 失败。动机见 `proposal.md`，行为契约见本变更的 `specs/`。

已确认的决定：存档采用旧插件风格 `payload/` 布局；备份与恢复都不跟随 junction（方案 A），链接只记录并在恢复后重建。

## Goals / Non-Goals

**Goals:**

- 恢复不再解压，直接以存档目录为源；文件时间戳与来源一致，未变化文件被跳过。
- 恢复前处理占用 profile 的常驻进程，避免“内容确实变化”时被锁死。
- robocopy 失败时给出可诊断的路径与错误码。
- 保持现有安全机制：模式菜单、Y/N、租约、快照、自身排除、链接重建、任意键退出。

**Non-Goals:**

- 不做 install 按版本去重、不做压缩/加密、不做增量备份。
- 不迁移现有 zip 存档；不删除它们。
- 不改设置页的信息架构，只改与存档形态相关的文案与阶段。

## Decisions

### 1. 存档布局回到 `payload/` + `manifest.json` + 脚本

```
dsh-save-YYYYMMDD-HHMMSS/
  payload/
    install/
    profile/desktop/
    profile/others/<name>/<config files>
    home/
    runtimes/
  manifest.json
  RESTORE.cmd
  RESTORE.ps1
```

与旧插件一致，恢复脚本只需把 `$PSScriptRoot\payload` 当作镜像源。压缩包不再存在，旧 zip 存档变得不可识别但保持原样。

### 2. 备份用 robocopy 复制，`/XJ` 不跟随链接

- 用 `robocopy <source> <partial>\payload\<name> /E /COPY:DAT /DCOPY:DAT /XJ /R:2 /W:1` 逐项复制。
- `/COPY:DAT` 保留修改时间，这是恢复能跳过未变化文件的前提。
- `/XJ` 排除 junction，避免把 `C:\tool\MyPlugin`、插件源码等链接目标复制进存档，也避免循环与串目录；链接由 `scanProfileLinks` 记入 `manifest.json`。
- 备选“跟随链接物化”（zip 当前行为）会让存档依赖外部目录内容且体积不可控，放弃。
- 复制到 `<id>.partial`，全部成功并写好 `manifest.json`/脚本后再改名，保持原子发布。

### 3. 恢复直接读 `payload/`，不再解压

- 预检从“zip + tar -tf”改为检查 `payload/install`、`payload/profile/<profile>`、`manifest.json`。
- 删除 `_restore-tmp` 与 tar 依赖；空间预检只检查目标卷（不再需要 zip×3 的估算）。
- robocopy 统一加 `/FFT`：正常 NTFS 保留 100ns 时不会误判；存档位于 exFAT/FAT32 或被复制工具重写时间时，2 秒内的差异视为相同，避免全量重写。
- 时间戳保真后，`fastctx.exe` 这类未变化文件会被跳过，原失败模式自然消失。

### 4. 进程守卫：只处理“从 profile 启动”的进程

- 在 Y/N 之后、任何覆盖之前，扫描可执行路径位于 `$ProfileDir\node_modules` 或 `$HomeDir` 下的进程，排除主 DSH 进程与当前 PowerShell。
- 展示 PID、名称、路径，要求用户确认；确认后 `Stop-Process -Force`，拒绝或结束失败则中止且不写目标。
- 备选“自动杀进程”：风险太高，不做。
- 该机制只覆盖“内容确实变化”的场景；未变化文件已由 `/FFT` 跳过。

### 5. robocopy 失败明细写入回档日志

- `Invoke-Robocopy` 把 stdout/stderr 重定向到日志文件（按阶段追加），解析 `ERROR <code>` 行。
- 失败时控制台打印最后若干条错误与涉及路径，日志保留完整输出；仍以退出码 ≥8 判定失败。
- 备选“只打印退出码”：无法定位锁文件，放弃。

### 6. 索引与列表改读目录内的 `manifest.json`

- `rebuildIndex` 直接读 `<save>/manifest.json`；不再需要 `tar -xOf`。
- 识别新格式的条件：存在 `manifest.json` 且 `producer === 'dsh-crash-backup'`，并有 `payload/`。
- 旧 zip 存档与旧 `MANIFEST.json` 存档都不识别、不删除。

## Risks / Trade-offs

- [每份约 2.6 GB，3 份约 7.8 GB] → 明确写入 README；提供给用户删除旧存档的操作。
- [`/XJ` 不归档链接目标，目标被删除后插件无法恢复] → 恢复时检测目标不存在并警告跳过（现有行为）；文档说明需要重新安装该插件。
- [备份变慢（复制 2.6 GB）] → 相比压缩省去压缩 CPU，整体通常更快；进度阶段改为 `copy`。
- [进程守卫误杀用户进程] → 只匹配 profile/home 路径、逐项确认、拒绝即中止。
- [exFAT/FAT32 时间精度] → `/FFT` 兜底；README 说明尽量用 NTFS。
- [robocopy 输出很大] → 写文件而非内存；控制台只打印摘要与最后错误。

## Migration Plan

1. 实现完成后从开发目录 `npm pack`，用 tarball 重新安装插件（开发目录不链接到 DSH）。
2. 现有 zip 存档保留但不再列出；仍可用其自带 `RESTORE.ps1` 手动恢复。
3. 回滚本变更：重新安装上一版 tarball；存档目录不被修改。
4. 首次使用新格式前，确认备份根不在安装目录/profile 内。
