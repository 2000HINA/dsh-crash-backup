# Proposal

## Why

压缩存档在实机上暴露了两个问题：zip 往返会丢失亚秒时间戳（实测 `fastctx.exe` 磁盘为 `15:40:30.038`，解压后为 `15:40:30.000`），恢复时 robocopy 因此把整个 `node_modules` 判为“需要重写”，撞上从 `profile\node_modules` 启动的常驻进程（dsh-ops 的 `fastctx.exe`）后以退出码 9 失败；同时恢复需要额外约 2.5 GB 解压空间，速度也明显慢于直接复制。

旧版“目录复制 + 时间戳保真”不会碰未变化的文件，实测能避开这类失败。每份存档多占约 1.7 GB，但本机磁盘余量充足，可靠性、恢复速度和峰值空间更重要。

## What Changes

- **BREAKING**：存档形态从“单 zip + 脚本”改回“目录 + 脚本”。存档文件夹内包含 `payload\`（`install`、`profile`、`home`、`runtimes`、`profile\others`）、`manifest.json`、`RESTORE.cmd`、`RESTORE.ps1`。
- 备份改为 robocopy 目录复制，保留精确时间戳（`/COPY:DAT`），继续使用 `.partial` + 原子重命名、3 份上限、索引与旧存档保护。
- 恢复直接从存档目录 robocopy，不再解压到 `_restore-tmp`，不再依赖 `tar.exe`；保留完整/仅插件两种模式、Y/N 确认、任意键退出、租约锁、自身排除、junction 重建。
- 增加恢复前的进程守卫：检测可执行路径位于 `profile\node_modules` 或用户目录下的常驻进程（fastctx、pwsh、bash、node、python、MCP server），列出并让用户确认结束；拒绝则中止。
- robocopy 统一加 `/FFT` 作为时间精度兜底，并把失败输出写入回档日志（当前被丢弃，只留退出码）。
- 删除 zip/tar 相关模块与测试；更新 README、CHANGELOG 与验收清单中的空间/形态描述。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `backup-snapshots`: 存档不再是压缩包，而是目录快照；内容结构、原子落盘、索引与旧存档保护保持不变。
- `crash-restore`: 恢复从存档目录直接复制，不再解压；新增“结束从 profile 运行的常驻进程”前置守卫与 robocopy 失败明细日志。

## Impact

- `lib/backup.js`：备份流程改为目录复制，去掉 `createArchive`。
- `lib/archive.js`：移除 tar 打包/解压相关函数，保留 `dirSize` 等仍需的辅助。
- `lib/scripts.js`：恢复脚本去掉解压段落，直接对 `payload` 镜像；新增进程守卫与 robocopy 日志。
- 测试：删除 archive/e2e 解压相关断言，新增时间戳保真、进程守卫、日志断言。
- 磁盘：每份约 2.6 GB（3 份约 7.8 GB）；恢复峰值不再需要解压副本。
- 兼容：现有 zip 存档不再被新代码识别；旧 `payload` 目录存档也不识别（两者都不删除）。
