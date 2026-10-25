# Spec Delta

## REMOVED Requirements

### Requirement: 存档文件夹只包含压缩包和恢复脚本
**Reason**: 存档改为目录复制，不再生成压缩包。
**Migration**: 新存档使用 `payload/` 目录布局；旧 zip 存档仍可用其自带 `RESTORE.ps1` 手动恢复。

### Requirement: 压缩包保存完整环境与插件信息
**Reason**: 环境改为复制到 `payload/`，不再写入压缩包。
**Migration**: 新存档在 `payload/` 下保存环境，`manifest.json` 描述内容与链接。

## ADDED Requirements

### Requirement: 存档文件夹包含环境目录与恢复脚本

系统 SHALL 让每个存档文件夹内包含 `payload/` 环境目录、`manifest.json` 与恢复脚本，不得在该文件夹写入日志或备份过程中的临时文件。

#### Scenario: 检查存档文件夹内容
- **WHEN** 一份备份成功完成
- **THEN** 该文件夹内包含 `payload/`、`manifest.json`、`RESTORE.cmd` 与 `RESTORE.ps1`
- **AND** 备份过程中的临时目录不出现在最终文件夹中

### Requirement: 存档目录保存完整环境与插件信息

系统 SHALL 把 DSH 安装目录、插件 profile（含 node_modules 与 lock 文件）、其它 profile 的配置文件、用户目录中的配置与数据、运行时依赖复制到存档的 `payload/` 下，并写入 `manifest.json`；复制 SHALL 保留来源文件的修改时间，且不得跟随目录链接把链接目标内容复制进存档。

#### Scenario: 检查存档结构
- **WHEN** 用户查看任一新格式存档
- **THEN** 存档内包含 `payload/install/`、`payload/profile/`、`payload/home/`、`payload/runtimes/` 与 `manifest.json`
- **AND** `manifest.json` 记录 DSH 版本、创建时间、profile 名称、插件依赖清单、链接清单与总体积

#### Scenario: 保留时间戳与链接
- **WHEN** 备份一个包含本地链接依赖与深层 node_modules 的环境
- **THEN** 存档中的文件保留来源文件的修改时间，恢复时可以据此跳过未变化的文件
- **AND** 链接目标的内容不被复制进存档，链接记录在 `manifest.json` 中供恢复时重建

#### Scenario: 用户名或路径含中文
- **WHEN** DSH 安装目录或用户目录的路径包含中文、空格或非 ASCII 字符
- **THEN** 复制后的文件名与目录名保持原样，不出现乱码或被替换为问号

## MODIFIED Requirements

### Requirement: 备份完成前存档不可见

系统 SHALL 先把环境内容复制到临时目录，只有在 `payload/`、`manifest.json` 与恢复脚本全部写入成功后才把存档文件夹变为正式状态；任何中断都不得产生可被列表识别为完整的存档。

#### Scenario: 备份中途失败
- **WHEN** 备份在复制或写脚本阶段失败或被中断
- **THEN** 列表不显示该存档，用户也无法从该存档发起回档
- **AND** 残留的临时目录可以被后续备份流程识别并清理

### Requirement: 存档索引可由文件夹重建

系统 SHALL 在备份根目录维护一份存档索引用于列表展示，并保证索引缺失、损坏或与文件夹不一致时可以通过扫描存档文件夹、读取其中的 `manifest.json` 重建，不丢失任何可恢复的存档。

#### Scenario: 索引被删除
- **WHEN** 用户手动删除备份根目录下的索引文件后打开设置页
- **THEN** 列表仍然显示所有新格式存档
- **AND** 索引被重新生成

#### Scenario: 旧格式存档存在
- **WHEN** 备份根目录中存在旧版 `MANIFEST.json` 目录格式的存档
- **THEN** 新插件不把它识别为可回档存档，也不删除或迁移它
