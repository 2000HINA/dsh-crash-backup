# Tasks

## 1. 存档布局与备份复制

- [x] 1.1 在 `lib/backup.js` 用 robocopy 目录复制替换 `createArchive`：把 `install`、`profile/<profile>`、`profile/others`、`home`、`runtimes` 复制到 `<id>.partial/payload/`，参数含 `/E /COPY:DAT /DCOPY:DAT /XJ`；验证：临时存档内出现 `payload/` 且不含 `.zip`，文件修改时间与源一致。
- [x] 1.2 备份时对 profile 的 junction 使用 `/XJ` 跳过，并继续用 `scanProfileLinks` 写入 `manifest.json.links`；验证：指向 `C:\tool\MyPlugin` 的测试链接目标内容不出现在 `payload/`，manifest 记录该链接。
- [x] 1.3 让正式存档文件夹只含 `payload/`、`manifest.json`、`RESTORE.cmd`、`RESTORE.ps1`，并保持 `.partial` + 原子重命名；验证：备份成功后目录项恰好为这四项，失败时无正式文件夹。
- [x] 1.4 移除 `lib/archive.js` 中不再使用的 tar 打包/解压/列举函数，保留 `dirSize` 等仍被调用的辅助；验证：`grep -r "createArchive\|extractPrefix\|readArchiveEntry" lib/` 无结果，`node --check` 通过。
- [x] 1.5 让 `lib/index-file.js` 的 `rebuildIndex` 从存档目录读取 `manifest.json`，识别条件为 `producer === 'dsh-crash-backup'` 且存在 `payload/`；验证：删除索引后仍能列出全部新格式存档，旧 zip 存档与旧 `MANIFEST.json` 存档都不列出。
- [x] 1.6 更新备份进度阶段（如 `archive` 改为 `copy`）与失败文案；验证：`test/backup.test.js` 断言阶段顺序，UI 阶段映射测试通过。

## 2. 恢复脚本

- [x] 2.1 把预检从 zip/tar 改为检查 `payload/install`、`payload/profile/<profile>`、`manifest.json`，删除 `tar.exe` 与 `tar -tf` 依赖；验证：缺失任一目录时在写目标前中止，`test/scripts.test.js` 断言不再出现 `tar.exe`。
- [x] 2.2 恢复直接从 `<save>/payload` 镜像，不再解压到 `_restore-tmp`；验证：脚本中无 `_restore-tmp`，临时环境端到端恢复成功。
- [x] 2.3 新增“结束从 profile 启动的常驻进程”守卫：扫描 `$ProfileDir\node_modules` 与 `$HomeDir` 下的进程，列出 PID/名称/路径，确认后结束，拒绝或失败则中止；验证：脚本包含守卫段落与确认文案，e2e 用伪造进程列表断言“拒绝即不写目标”。
- [x] 2.4 恢复的所有 robocopy 调用加 `/FFT`，并把输出写入 `_restore-logs` 日志；失败时控制台打印错误摘要；验证：脚本包含 `/FFT` 与日志重定向，e2e 用只读文件制造失败并断言日志含 `ERROR` 与路径。
- [x] 2.5 回归模式菜单、Y/N、租约、自身排除、junction 重建与任意键退出；验证：`test/scripts.test.js` 与 `test/restore-e2e.test.js` 全部通过。

## 3. 设置页与文档

- [x] 3.1 更新 `client.js` 中与存档形态/阶段/空间相关的文案（不再说“压缩包”，阶段改为复制），保持中英文字典键对齐；验证：`test/client.test.js` 字典键集合一致、阶段标签可解析。
- [x] 3.2 更新 `README.md`、`CHANGELOG.md`、`docs/verification.md`：目录布局、每份约 2.6 GB、恢复不解压、常驻进程守卫、`/FFT`、失败日志、旧 zip 存档不识别；验证：文档中的空间与命令与实际行为一致，`npm pack --dry-run` 仍为 21 个文件。

## 4. 集成验收

- [x] 4.1 临时环境完整闭环：备份 → 修改文件并新增文件 → 从存档目录恢复 → 断言环境回到存档、未变化文件时间戳未变。
- [x] 4.2 仅插件模式：备份 → 修改 profile → 仅回滚插件 → 断言 install/home 未变、profile 恢复。
- [ ] 4.3 时间戳与锁：把测试文件时间戳设为 2 秒内差异并占用一个文件，验证 `/FFT` 跳过未变化文件、守卫能列出占用进程、失败日志含具体路径。
- [x] 4.4 旧存档兼容：备份根同时存在 zip 存档与旧 `MANIFEST.json` 存档，验证新插件不列出、不删除、不修改它们。
- [ ] 4.5 手动验收清单：在本机执行一次真实完整回档与一次仅插件回档，记录到 `docs/verification.md`。

## Workflow follow-up

- 全部任务完成后运行 `openspec validate replace-zip-with-directory-copy --strict` 并归档。
- 通过 tarball 重新安装插件（保持开发目录与 DSH 隔离），重启后完成手动验收。
