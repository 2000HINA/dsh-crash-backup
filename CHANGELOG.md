# Changelog

本项目的所有重要变更记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 0.1.0 - 2026-10-24

### Added

- **初始发布**：DSH 设置页新增「存档」区域，手动把当前 DSH 环境保存成一个存档，最多保留 3 份。
- **压缩存档**：每份存档是一个 `dsh-save-*` 文件夹，内含单个 `.zip` 以及独立的 `RESTORE.cmd` / `RESTORE.ps1`，替代旧插件的明文 `payload` 目录复制。
- **原子发布**：存档先写入 `<id>.partial`，等压缩包、清单和两个恢复脚本全部完成后才重命名为正式目录；中断的 `.partial` 会在下次备份前清理。
- **自定义备份目录**：可在设置页更改备份根目录，选择持久化在 `%USERPROFILE%\.dsh\dsh-crash-backup\settings.json`；默认使用 DSH 安装目录同级的 `dsh-backups`。
- **崩溃安全回档脚本**：`RESTORE.ps1` 不依赖 DSH 即可运行，先展示存档信息并要求输入 `Y` 确认，回档前把当前配置快照到 `_pre-restore`，过程写入 `_restore-logs`，成功/取消/失败都会停留等待按键。
- **回档保护**：安装目录和插件 profile 使用 `robocopy /MIR` 恢复，用户目录和运行库只覆盖不删除；恢复 profile 时排除本插件自身，并按存档清单重建 `link:` 依赖的目录链接。
- **两种回档模式**：设置页「回档」弹窗可选「完整回档」或「仅回滚插件」，双击 `RESTORE.cmd` 也会先给出 1/2 菜单。仅回滚插件只恢复当前插件 profile（`package.json`、`pnpm-lock.yaml`、`cordis.patch.yml` 与 `node_modules`），DSH 安装目录、用户数据、`dsh-runtimes` 与插件数据（`storages` 等）都不回退；DSH 版本不一致时打印兼容性警告后继续，完成后同样需要重启 DSH。存档没有插件内容（`hasProfile: false`）时，设置页禁用该选项并说明原因，接口与脚本也会拒绝执行。
- **与旧存档共存**：只把「`dsh-save-*` 文件夹内含一个 `.zip`」的目录识别为存档，旧插件的 `payload` 格式不会出现在新列表中；文档要求同时启用时先禁用旧插件 `dsh-save-slots`，并提醒先把旧存档移出共用备份根。

### Fixed

- **不再破坏外部文件**：备份目录初始化会写入 `.dsh-crash-backup.json` 标记；非空且没有该标记的文件夹，只有仅含本插件存档与元数据文件时才会被接管（只补写缺失的标记/README/settings，不覆盖已有文件），含其它文件时仍会被拒绝（接口返回 400）。每次备份前都会初始化当前备份根，自动创建的目录因此可以直接在「更改目录」中选择。
- **回档范围补全**：完整回档现在也会把 `profile/others/<name>/<file>` 覆盖复制到 `<home>/profiles/<name>/`；链接目标已不存在的 junction 会记录警告并跳过，不再让整个回档失败。
- **回档租约**：`RESTORE.ps1` 在确认前写入 `_restore-in-progress.json`、在所有退出路径删除；设置页据此保持 `busy`，不会在用户停留于 Y/N 时因 120 秒超时放行第二个备份/回档。租约存在期间，删除存档和更改目录同样返回 409。
- **备份目录与安全提示**：默认目录不可写时回退到 `%DSH_HOME%\dsh-backups` 并在页面说明；页面提示目录不存在、更改目录后旧存档仍保留、存档包含明文 `.credentials.yaml`；UNC 网络路径被拒绝。
- **空间与长路径**：完整回档检查安装目录、profile、用户目录所在卷，仅插件模式只检查 profile；备份/回档开始时检查 `LongPathsEnabled`，未启用只提示不中止。
