# Proposal

## Why

现有插件 `dsh-save-slots`（`C:\tool\MyPlugin`）用目录复制的方式保存环境，每份存档约 2.6 GB，且备份根目录写死在配置里；DSH 崩溃后用户既不知道该去哪里、也没有可靠的入口自行回档。回滚脚本在从设置页触发时会直接关掉 DSH 而不询问，结束提示只是"按回车"，取消和失败路径也没有统一的停留方式。恢复 profile 时使用镜像复制，会把存档之后新装的插件一并删除，其中就包括备份插件自身。

因此需要一个可以独立分发给他人下载使用的新插件：存档压缩、目录由用户选择、崩溃后可自助双击回档，并且恢复过程对用户是可见、可取消、可诊断的。

## What Changes

- 在 `C:\tool\dsh-crash-backup` 新建独立插件包（新包名、新插件 id、新 API 路由），不修改、不依赖现有 `C:\tool\MyPlugin`。
- 每个存档一个独立文件夹，文件夹内只放一个压缩包和恢复脚本（`RESTORE.cmd` 双击入口 + `RESTORE.ps1` 实现）。
- 压缩包内保存 DSH 环境与插件信息：`install/`、`profile/<profile>/`（含 node_modules）、`profile/others/`、`home/`、`runtimes/`，以及 `manifest.json`。
- 备份目录默认取 DSH 安装目录所在文件夹下的 `dsh-backups`；用户在设置页可自由选择，选择后在新目录写入基础配置（`settings.json`）和一份简单的使用说明（`README.txt`）。
- 设置页介绍栏增加崩溃提示：DSH 崩溃或无法启动时，可直接到备份目录双击存档里的恢复脚本回档，并提供备份目录路径与打开文件夹的入口。
- 恢复脚本启动后先提示"回档后当前状态无法恢复"，输入 Y 继续、N 中断；无论成功、取消还是失败，结束都执行"按任意键退出"。
- 恢复流程对插件自身做保护：备份与恢复 profile 时排除本插件目录，并记录 `link:` 依赖的 junction，恢复时重建，避免回档后插件被删除或链接被物化。
- 采用压缩存档后，恢复前先校验、空间不足提前拒绝；从设置页触发的回档同样保留脚本内确认。
- 现有 `dsh-save-*` 旧格式存档保持原样，新插件不显示、不迁移。

## Capabilities

### New Capabilities

- `backup-snapshots`: 备份存档的创建、压缩包内容与结构、元数据与索引、数量与空间约束。
- `backup-location`: 备份目录的默认推导、用户选择、重定向后的基础配置写入与合法性校验。
- `crash-restore`: 恢复脚本的确认交互、任意键退出、解压与覆盖流程、插件自身保护、崩溃场景下的自助回档与设置页提示。

### Modified Capabilities

无。这是新插件，不修改现有能力。

## Impact

- 新包 `dsh-crash-backup`：`index.js`（Host 半部、备份/恢复/目录 API）、`client.js`（设置页）、`lib/`（压缩、复制、脚本生成、配置）、`locale/`、`cordis.patch.yml`、`package.json`。
- 运行环境：仅 Windows（依赖系统自带 `C:\Windows\System32\tar.exe`、PowerShell 5.1、`robocopy`）。
- DSH：通过 profile 的 `node_modules` 与 bundle patch 安装；与现有 `dsh-save-slots` 的 section id 和 API 路由不冲突，但两者同时启用会出现两个存档页，需在文档中说明。
- 磁盘：单份压缩包预计 0.9–1.2 GB，恢复时需要额外解压空间，需在预检与说明中体现。
- 安全：压缩包含 `.credentials.yaml`，未加密，需在设置页与说明中提示不要外传。
