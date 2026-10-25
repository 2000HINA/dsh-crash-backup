# 开发与安装隔离约定

`C:\tool\dsh-crash-backup` 只作为**源码目录**。DSH 中安装的必须是它的**副本**，不能是链接。

## 为什么

- 旧插件或任何 `/MIR` 恢复可能顺着 `node_modules` 里的 junction 删除链接目标；源码目录一旦被链接，就可能被回档清空。
- 源码目录包含 `.git`、`openspec`、测试与 `.superpowers`，不应出现在运行环境中。

## 标准流程

1. 在源码目录确认工作树干净并跑测试：

   ```powershell
   cd C:\tool\dsh-crash-backup
   npm test
   ```

2. 打包（只包含 `files` 列出的运行文件）：

   ```powershell
   npm pack --pack-destination C:\tool\dsh-plugin-packages
   ```

3. 通过 plugin_manager 从 tarball 安装（生成真实目录副本，依赖为 `file:`）：

   ```text
   plugin_manager install_bundle
     target: C:\tool\dsh-plugin-packages\dsh-crash-backup-0.1.0.tgz
   ```

4. 更新版本时，先移除再安装（同版本号 pnpm 不会重新解包）：

   ```text
   plugin_manager remove_bundle   target: dsh-crash-backup
   plugin_manager install_bundle  target: <新 tarball>
   ```

5. 重启 DSH（Host 半部只在启动时加载）。

## 禁止

- 不要使用 `"dsh-crash-backup": "link:C:/tool/dsh-crash-backup"`。
- 不要手工创建指向源码目录的 junction。
- 不要把备份根设到源码目录或 profile 内。

## 验证

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
(Get-Content "$p\package.json" -Raw | ConvertFrom-Json).dependencies.'dsh-crash-backup'
# 期望：file:C:/tool/dsh-plugin-packages/<版本>.tgz

(Get-Item "$p\node_modules\dsh-crash-backup").LinkType
# 期望：空（真实目录）
```
