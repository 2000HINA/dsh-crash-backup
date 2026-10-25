# Spec Delta

## ADDED Requirements

### Requirement: 回档前结束占用 profile 的常驻进程

恢复脚本 SHALL 在覆盖插件 profile 之前，检测可执行文件位于 profile 的 `node_modules` 或用户目录下的常驻进程，列出进程 ID、名称与路径并请求用户确认结束；用户拒绝或进程无法结束时 SHALL 中止回档，且不修改任何目标文件。

#### Scenario: 检测到常驻进程
- **WHEN** 脚本发现 `fastctx.exe`、`pwsh.exe`、`node.exe` 等进程从 profile 的 `node_modules` 启动
- **THEN** 脚本逐项列出这些进程并询问是否结束
- **AND** 用户确认后结束进程并继续回档

#### Scenario: 用户拒绝结束进程
- **WHEN** 脚本列出占用 profile 的进程而用户选择不结束
- **THEN** 脚本中止回档并说明未修改任何文件
- **AND** 不进入镜像或链接重建阶段

### Requirement: 恢复使用 FAT 时间精度并记录失败明细

恢复脚本 SHALL 在恢复调用的 robocopy 中使用 `/FFT` 按 2 秒精度比较时间戳，并把 robocopy 输出写入回档日志；失败时 SHALL 显示包含错误码与相关路径的明细，而不是只报告退出码。

#### Scenario: 时间戳精度低于 2 秒
- **WHEN** 存档位于 exFAT/FAT32 或被复制工具重写过时间戳，文件内容未变化
- **THEN** robocopy 将 2 秒内的时间差异视为相同并跳过该文件
- **AND** 不因时间精度问题重写整个目录

#### Scenario: robocopy 中途失败
- **WHEN** 某个文件因被占用或权限不足无法覆盖
- **THEN** 回档日志包含该文件路径与错误码
- **AND** 控制台显示失败摘要与日志位置

## MODIFIED Requirements

### Requirement: 回档前校验存档与空间

恢复脚本 SHALL 在关闭 DSH 与覆盖目标之前校验存档目录存在、`payload/` 结构与 `manifest.json` 可读，并检查写入目标所需磁盘空间；校验失败时中止且不修改任何目标文件。

#### Scenario: 压缩包损坏
- **WHEN** 存档的 `manifest.json` 无法读取，或存档目录在复制过程中被截断
- **THEN** 脚本报错并终止，不修改安装目录、插件目录或用户目录

#### Scenario: 存档目录不完整
- **WHEN** 存档缺少 `payload/`、`manifest.json` 或目标 profile 内容
- **THEN** 脚本报错并终止，不修改安装目录、插件目录或用户目录

#### Scenario: 磁盘空间不足
- **WHEN** 恢复目标所在磁盘剩余空间低于脚本要求
- **THEN** 脚本提示空间不足并终止，不开始复制

### Requirement: 崩溃后脚本可独立使用

恢复脚本 SHALL 不依赖 DSH 进程、插件运行时或网络即可执行回档，使 DSH 无法启动时用户仍能通过备份目录中的脚本恢复环境。

#### Scenario: DSH 已经崩溃
- **WHEN** DSH 进程不存在，用户直接双击备份目录中的恢复脚本
- **THEN** 脚本正常启动、完成校验与回档，并在结束后提示重新启动 DSH

#### Scenario: 备份目录被移动或重命名
- **WHEN** 用户把整个存档文件夹移动到其它磁盘后双击其中的脚本
- **THEN** 脚本仍能定位同文件夹内的 `payload/` 与 `manifest.json` 并完成回档
