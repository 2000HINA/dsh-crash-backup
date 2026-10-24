# DSH Crash Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `C:\tool\dsh-crash-backup` 从零构建一个可独立分发的 DSH 备份插件：把当前环境压缩成单份 zip 存档，支持崩溃后双击脚本完整回档，并支持只回滚插件。

**Architecture:** Host 半部（`index.js` + `lib/`）负责路径探测、目录校验、tar 压缩、存档索引、恢复脚本生成与启动；Client 半部（`client.js`）只负责设置页展示与调用同源 API。每个存档一个文件夹，里面只有 zip 与 `RESTORE.cmd`/`RESTORE.ps1`；zip 内是 `install/`、`profile/`、`home/`、`runtimes/` 与 `manifest.json`。备份使用 junction staging 零复制打包，恢复使用脚本本地解压 + robocopy。

**Tech Stack:** Node 20 ESM、Node 内置 `node:test`、Windows 自带 `C:\Windows\System32\tar.exe`（bsdtar 3.8.9）、PowerShell 5.1、robocopy、React（DSH client 通过 `window.__ModuleLoader__` 提供）。

**Spec:**
- `openspec/changes/add-crash-backup/proposal.md`
- `openspec/changes/add-crash-backup/design.md`
- `openspec/changes/add-crash-backup/specs/backup-snapshots/spec.md`
- `openspec/changes/add-crash-backup/specs/backup-location/spec.md`
- `openspec/changes/add-crash-backup/specs/crash-restore/spec.md`
- `openspec/changes/add-plugin-rollback/proposal.md`
- `openspec/changes/add-plugin-rollback/design.md`
- `openspec/changes/add-plugin-rollback/specs/plugin-rollback/spec.md`

## Global Constraints

- 仅 Windows；目标机器需 Windows 10 1803+（系统自带 `tar.exe`）与 PowerShell 5.1。
- 包名、插件 id、API 前缀统一为 `dsh-crash-backup`；路由为 `/dsh-crash-backup/api`。
- 存档文件夹名前缀 `dsh-save-`，同时最多保留 3 份存档。
- 默认备份目录 = `path.dirname(installDir)` 下的 `dsh-backups`；备份目录不得位于 install 或 profile 内，也不得是磁盘根目录。
- 插件数据目录 = `%USERPROFILE%\.dsh\dsh-crash-backup`，只存 `settings.json`。
- zip 内固定结构：`install/`、`profile/<profile>/`、`profile/others/`、`home/`、`runtimes/`、`manifest.json`。
- 压缩必须使用 `--options hdrcharset=UTF-8`，否则中文文件名会变成 `????`。
- 存档文件夹内只允许 3 个文件：`<id>.zip`、`RESTORE.cmd`、`RESTORE.ps1`。
- `RESTORE.ps1` 用 UTF-8 BOM 写入；`RESTORE.cmd` 保持纯 ASCII；脚本内 `chcp 65001`。
- 恢复脚本结束必须走"按任意键退出"：`$Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')`，非交互时回退 `Read-Host`。
- 恢复 profile 时必须排除本插件目录 `node_modules\dsh-crash-backup`，并按 manifest 的 `links` 重建 junction。
- 仅插件模式只写 `profile/<profile>`；不得写 install、home、runtimes。
- 不修改 `C:\tool\MyPlugin`；旧格式 `dsh-save-*` 目录不识别、不迁移、不删除。
- 不引入任何 npm 运行时依赖；测试只用 `node:test` 与 `node:assert/strict`。

## Review Focus

1. **含中文或空格的路径**：安装目录、用户目录、备份目录都可能带中文或空格；zip 内文件名、robocopy 参数、PowerShell 单引号、`start` 命令行都必须原样还原。
2. **备份中断或被占用**：杀毒、索引服务或 DSH 自身占用文件会让 rename/删除失败；不能留下半个存档或一个列表里看得见却打不开的文件夹。
3. **profile 镜像误删插件自身与链接**：`/MIR` 会删掉存档之后新增的插件；junction 会被物化。回档后本插件必须仍在，`link:` 依赖必须仍是 junction。
4. **仅插件模式越界写 install/home**：用户选择"只回滚插件"时，任何对安装目录或用户数据的写入都是数据事故；必须能从目录 mtime/文件哈希证明未改动。
5. **无 DSH、非交互场景下的脚本行为**：崩溃后双击脚本时没有 UI、可能没有控制台输入；菜单、Y/N、任意键退出都不能挂死或静默退出。

---

## Module Map

| 文件 | 职责 |
|---|---|
| `lib/constants.js` | 包名、路由、存档前缀、上限、默认目录名 |
| `lib/config.js` | 运行环境探测（install/home/profile）与默认备份根推导 |
| `lib/settings.js` | `settings.json` 读写、备份目录合法性校验 |
| `lib/location.js` | 重定向后初始化备份目录（README/settings/index/子目录） |
| `lib/picker.js` | 调 PowerShell `FolderBrowserDialog` 选目录，超时回退 |
| `lib/archive.js` | staging junction、bsdtar 打包/列举/前缀解压/校验/哈希 |
| `lib/manifest.js` | manifest 构造与 Markdown 渲染 |
| `lib/index-file.js` | `index.json` 读写与从 zip 重建 |
| `lib/backup.js` | 存档创建、列表、删除、残留清理 |
| `lib/scripts.js` | `RESTORE.ps1`/`RESTORE.cmd`/备份根 `README.txt` 渲染 |
| `lib/restore.js` | 构造恢复命令并启动独立窗口 |
| `lib/api.js` | 同源 HTTP handler（纯函数，便于测试） |
| `index.js` | Cordis 入口：读配置、注册路由 |
| `client.js` | 设置页：列表、备份、进度、回档模式、目录管理、崩溃提示 |

---

### Task 1: 包骨架、常量与插件加载

**Files:**
- Create: `package.json`, `cordis.patch.yml`, `index.js`, `client.js`, `icon.svg`, `locale/zh.json`, `locale/en.json`, `lib/constants.js`, `.gitignore`
- Test: `test/constants.test.js`

**Interfaces:**
- Produces: `PLUGIN_ID = 'dsh-crash-backup'`、`API_ROUTE = '/dsh-crash-backup/api'`、`SAVE_PREFIX = 'dsh-save-'`、`MAX_SAVES = 3`、`SETTINGS_DIR_NAME = 'dsh-crash-backup'`
- Produces: 可被 DSH 加载的最小 `apply(ctx, config)` 与设置页占位组件

- [ ] **Step 1: 初始化 git 与忽略文件**

```bash
cd C:/tool/dsh-crash-backup
git init
```

`.gitignore` 内容：`node_modules/`、`*.partial`、`.DS_Store`。

- [ ] **Step 2: 写失败的常量测试**

```js
// test/constants.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { PLUGIN_ID, API_ROUTE, SAVE_PREFIX, MAX_SAVES } from '../lib/constants.js'

test('plugin identity constants', () => {
  assert.equal(PLUGIN_ID, 'dsh-crash-backup')
  assert.equal(API_ROUTE, '/dsh-crash-backup/api')
  assert.equal(SAVE_PREFIX, 'dsh-save-')
  assert.equal(MAX_SAVES, 3)
})
```

- [ ] **Step 3: 运行并确认失败**

Run: `node --test test/constants.test.js`
Expected: FAIL，`ERR_MODULE_NOT_FOUND` 指向 `lib/constants.js`。

- [ ] **Step 4: 创建骨架**

`lib/constants.js` 导出常量。`package.json` 至少包含：

```json
{
  "name": "dsh-crash-backup",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Compressed DSH environment backups with a crash-safe restore script.",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "lib", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md", "CHANGELOG.md"],
  "scripts": { "test": "node --test test/" },
  "engines": { "node": ">=20" },
  "os": ["win32"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings"] }
  }
}
```

`cordis.patch.yml` 插入插件行 `dsh-crash-backup`，`config` 只放 `profile: desktop`（其余运行期探测）。`index.js` 导出 `apply(ctx)`，先注册一个空的 `settings.section`；`client.js` 用 `window.__ModuleLoader__.load` 渲染"存档"占位区块。`locale/zh.json`、`locale/en.json` 写 `meta.title` 与 `meta.description`。

- [ ] **Step 5: 运行测试与语法检查**

Run: `node --test test/constants.test.js && node --check index.js && node --check client.js`
Expected: 测试 PASS，语法检查无输出。

- [ ] **Step 6: 手动确认 DSH 能加载**

把包以 `link:` 加入 profile 依赖，`cordis.patch.yml` 启用后重启 DSH；设置页出现"存档"区块。
Expected: 页面无报错；旧插件 `dsh-save-slots` 的入口不被改动。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold dsh-crash-backup plugin"
```

---

### Task 2: 运行环境探测与默认备份目录

**Files:**
- Create: `lib/config.js`, `test/config.test.js`

**Interfaces:**
- Produces: `detectInstallDir(execPath: string): string`（返回 exe 所在目录）
- Produces: `detectHome(env: NodeJS.ProcessEnv, homedir: string): string`（`DSH_HOME` 优先，否则 `<homedir>/.dsh`）
- Produces: `defaultBackupRoot(installDir: string): string`（`dirname(installDir)/dsh-backups`）
- Produces: `resolveSettings({ config, env, execPath, homedir }): Settings`
- `Settings = { installDir, home, profile, profileDir, backupRoot, backupRootSource, maxSaves }`，`backupRootSource: 'override' | 'saved' | 'default'`
- Consumes: Task 1 的 `MAX_SAVES`

- [ ] **Step 1: 写失败的测试**

```js
// test/config.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectInstallDir, detectHome, defaultBackupRoot } from '../lib/config.js'

test('install dir is the folder holding the executable', () => {
  assert.equal(detectInstallDir('C:\\tool\\dsh\\DeepSeek Harness.exe'), 'C:\\tool\\dsh')
})

test('DSH_HOME overrides the default home', () => {
  assert.equal(detectHome({ DSH_HOME: 'D:\\dsh-home' }, 'C:\\Users\\a'), 'D:\\dsh-home')
  assert.equal(detectHome({}, 'C:\\Users\\a'), 'C:\\Users\\a\\.dsh')
})

test('default backup root sits next to the install dir', () => {
  assert.equal(defaultBackupRoot('C:\\tool\\dsh'), 'C:\\tool\\dsh-backups')
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `lib/config.js`**

用 `path.win32` 处理路径（测试可在任意平台跑）。`resolveSettings` 内部调用 Task 3 的 `readSavedBackupRoot` 读取已保存目录，优先级为 `config.backupRoot` > 已保存 > 默认；`backupRoot` 计算为 `path.win32.resolve` 后的绝对路径。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/config.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/config.js test/config.test.js
git commit -m "feat: detect install dir and default backup root"
```

---

### Task 3: 设置持久化与备份目录校验

**Files:**
- Create: `lib/settings.js`, `test/settings.test.js`
- Modify: `lib/config.js`（读取已保存值）

**Interfaces:**
- Produces: `settingsFile(home: string): string`（`<home>/dsh-crash-backup/settings.json`）
- Produces: `readSavedBackupRoot(home: string): string | null`
- Produces: `saveBackupRoot(home: string, backupRoot: string): Promise<void>`
- Produces: `validateBackupDir(candidate, { installDir, profileDir }): { ok: true } | { ok: false, code, message }`
- `code ∈ 'inside-install' | 'inside-profile' | 'drive-root' | 'not-writable' | 'empty'`
- Consumes: Task 2 的 `resolveSettings` 调用 `readSavedBackupRoot`

- [ ] **Step 1: 写失败的测试**

```js
// test/settings.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateBackupDir } from '../lib/settings.js'

const env = { installDir: 'C:\\tool\\dsh', profileDir: 'C:\\Users\\a\\.dsh\\profiles\\desktop' }

test('rejects a folder inside the install dir (case-insensitive)', () => {
  const result = validateBackupDir('c:\\TOOL\\dsh\\backups', env)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'inside-install')
})

test('rejects the drive root', () => {
  assert.equal(validateBackupDir('C:\\', env).code, 'drive-root')
})

test('accepts a writable temp folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ok-'))
  assert.deepEqual(validateBackupDir(dir, env), { ok: true })
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --test test/settings.test.js`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `lib/settings.js`**

`validateBackupDir` 步骤：空值 → `empty`；`resolve` 后等于盘根 → `drive-root`；大小写不敏感地判断 `candidate === installDir || candidate.startsWith(installDir + sep)` → `inside-install`；profile 同理 → `inside-profile`；`mkdir -p` 后写临时文件再删除，失败 → `not-writable`；全部通过 → `{ ok: true }`。读取 `settings.json` 时容错解析，坏文件返回 `null`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/settings.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/settings.js test/settings.test.js lib/config.js
git commit -m "feat: persist and validate backup location"
```

---

### Task 4: 备份目录初始化与目录选择器

**Files:**
- Create: `lib/location.js`, `lib/picker.js`, `test/location.test.js`

**Interfaces:**
- Produces: `initializeBackupRoot(root, { version, createdAt }): Promise<void>`，创建 `_pre-restore/`、`_restore-logs/`，写 `README.txt`、`settings.json`、`index.json`（`{ "saves": [] }`）
- Produces: `pickFolder({ initial, timeoutMs }): Promise<string | null>`（取消/超时返回 `null`）
- Consumes: Task 1 常量

- [ ] **Step 1: 写失败的测试**

```js
// test/location.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeBackupRoot } from '../lib/location.js'

test('initializes a new backup root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-'))
  await initializeBackupRoot(root, { version: '0.1.0', createdAt: '2026-10-24T09:00:00.000Z' })
  assert.equal((await stat(join(root, '_pre-restore'))).isDirectory(), true)
  assert.equal((await stat(join(root, '_restore-logs'))).isDirectory(), true)
  const readme = await readFile(join(root, 'README.txt'), 'utf8')
  assert.match(readme, /崩溃/)
  assert.match(readme, /RESTORE\.cmd/)
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --test test/location.test.js`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `lib/location.js`**

README 内容至少包含：这个目录是什么、崩溃后双击哪个文件、两种回档模式、空间要求、凭据警告。`settings.json` 写 `{ version, createdAt, backupRoot: root }`。

- [ ] **Step 4: 实现 `lib/picker.js`**

写一个临时 `.ps1`（UTF-8 BOM）到 `os.tmpdir()`，内容为 `Add-Type -AssemblyName System.Windows.Forms` + `FolderBrowserDialog` + 隐藏 TopMost owner，输出所选路径到 stdout；`spawn` 参数 `['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File', ps1]`，`windowsHide: true`，超时 `kill` 并返回 `null`；输出为空或等于取消标记时返回 `null`。

- [ ] **Step 5: 手动验证选择器**

Run: `node -e "import('./lib/picker.js').then(m=>m.pickFolder({})).then(console.log)"`
Expected: 弹出系统文件夹对话框；选择后打印路径，取消后打印 `null`。

- [ ] **Step 6: 运行测试并提交**

Run: `node --test test/location.test.js`
Expected: PASS。

```bash
git add lib/location.js lib/picker.js test/location.test.js
git commit -m "feat: initialize backup root and folder picker"
```

---

### Task 5: 压缩引擎

**Files:**
- Create: `lib/archive.js`, `test/archive.test.js`

**Interfaces:**
- Produces: `TAR_PATH: string`
- Produces: `createArchive({ zipPath, sources, manifest, onProgress }): Promise<{ entryCount: number }>`，`sources: Array<{ name: string, path: string }>`
- Produces: `listArchive(zipPath): Promise<string[]>`
- Produces: `extractPrefix(zipPath, prefix, destDir): Promise<void>`
- Produces: `readArchiveEntry(zipPath, name): Promise<string>`
- Produces: `verifyArchive(zipPath, requiredEntries: string[]): Promise<{ ok: boolean, missing: string[] }>`
- Produces: `sha256File(filePath): Promise<string>`
- Produces: `dirSize(dir: string): Promise<number>`（不跟随链接，用于 manifest 总体积）
- Consumes: 无

- [ ] **Step 1: 写失败的测试**

```js
// test/archive.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArchive, listArchive, extractPrefix } from '../lib/archive.js'

test('keeps chinese file names inside the zip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-arc-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', '中文 说明.txt'), 'hello')
  const zip = join(root, 'out.zip')
  await createArchive({ zipPath: zip, sources: [{ name: 'src', path: join(root, 'src') }], manifest: { id: 't' } })
  const entries = await listArchive(zip)
  assert.ok(entries.some((e) => e.includes('中文 说明.txt')))
  const dest = join(root, 'out')
  await extractPrefix(zip, 'src', dest)
  assert.deepEqual(await readdir(join(dest, 'src')), ['中文 说明.txt'])
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --test test/archive.test.js`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `createArchive`**

在 `os.tmpdir()` 建 staging 目录；对每个 source 先按 `name` 的目录部分 `mkdir -p`，再用 `fs.symlinkSync(source.path, join(staging, source.name), 'junction')`（目录）或复制（文件）；写 `manifest.json`；执行：

```js
spawn(TAR_PATH, ['--options', 'hdrcharset=UTF-8', '-a', '-c', '-f', zipPath, '-C', staging, '.'], { windowsHide: true })
```

等待退出码 0；统计 `listArchive` 条目数；`finally` 删除 staging 中的 junction（`fs.rmSync(..., { recursive: false })` 后 `rmdir`）与目录，不能删到源目录。

- [ ] **Step 4: 实现列举/解压/校验**

`listArchive` 运行 `tar -tf`，按行过滤空行与 `./` 前缀归一化。`extractPrefix` 先 `listArchive` 找到以 `prefix + '/'` 开头的实际成员写法（带不带 `./`），再运行 `tar -xf zip -C dest <member>`；匹配不到时抛 `Error('archive has no ' + prefix)`。`readArchiveEntry` 用 `tar -xOf`。`verifyArchive` 检查 `requiredEntries` 是否都出现在 `listArchive` 结果中。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/archive.test.js`
Expected: PASS，且中文名断言通过（验证 `hdrcharset` 生效）。

- [ ] **Step 6: 手动验证 junction 打包**

在临时目录建一个指向 `C:\tool\MyPlugin` 的 junction，打包后 `tar -tf` 应列出其内部文件而不是链接本身。Expected: 内容被跟随；源目录文件未被修改。

- [ ] **Step 7: Commit**

```bash
git add lib/archive.js test/archive.test.js
git commit -m "feat: zip archives with utf8 names and junction staging"
```

---

### Task 6: 清单、索引与存档列表

**Files:**
- Create: `lib/manifest.js`, `lib/index-file.js`, `test/manifest.test.js`
- Modify: `lib/archive.js`（导出 `listArchive` 供重建使用，已存在）

**Interfaces:**
- Produces: `buildManifest(input): Manifest`，字段：`schemaVersion: 1`、`producer: 'dsh-crash-backup'`、`id`、`createdAt`、`dshVersion`、`profile`、`installDir`、`home`、`backupRoot`、`plugins: { dependencies, bundles }`、`contents`、`links: Array<{ path, target }>`、`totalBytes`
- Produces: `renderManifestMd(manifest): string`
- Produces: `readIndex(root): Promise<{ saves: SaveSummary[] }>`
- Produces: `writeIndex(root, saves): Promise<void>`
- Produces: `rebuildIndex(root): Promise<SaveSummary[]>`（扫描 `dsh-save-*` 目录，`tar -xOf zip manifest.json`）
- Produces: `readDshVersion(installDir): Promise<string>`、`readProfilePlugins(profileDir): Promise<{ dependencies, bundles }>`
- `SaveSummary = { id, createdAt, dshVersion, pluginCount, sizeBytes, restorable, hasProfile }`
- Consumes: Task 5 的 `listArchive`、`readArchiveEntry`

- [ ] **Step 1: 写失败的测试**

```js
// test/manifest.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildManifest } from '../lib/manifest.js'

test('manifest keeps plugin inventory and links', () => {
  const manifest = buildManifest({
    id: 'dsh-save-20261024-090000',
    createdAt: '2026-10-24T09:00:00.000Z',
    dshVersion: '44.7.0',
    profile: 'desktop',
    installDir: 'C:\\tool\\dsh',
    home: 'C:\\Users\\a\\.dsh',
    backupRoot: 'C:\\tool\\dsh-backups',
    plugins: { dependencies: { 'dsh-ops': '0.3.0' }, bundles: ['dsh-ops'] },
    links: [{ path: 'node_modules/dsh-ops', target: 'C:\\tool\\dsh-ops' }],
    totalBytes: 100,
    contents: { hasInstall: true, hasProfile: true },
  })
  assert.equal(manifest.producer, 'dsh-crash-backup')
  assert.equal(manifest.plugins.dependencies['dsh-ops'], '0.3.0')
  assert.equal(manifest.links[0].target, 'C:\\tool\\dsh-ops')
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --test test/manifest.test.js`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 manifest 与索引**

`rebuildIndex` 对每个存档目录取唯一 `.zip`，读取 zip 内 `manifest.json`；解析失败或 producer 不匹配时跳过。`writeIndex` 用临时文件 + rename 原子写。

- [ ] **Step 4: 补索引测试并运行**

在 `test/manifest.test.js` 增加一个用例：临时目录放 `index.json`，`writeIndex` 后 `readIndex` 得到相同内容；删除 `index.json` 后 `rebuildIndex` 重建空列表。

Run: `node --test test/manifest.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/manifest.js lib/index-file.js test/manifest.test.js
git commit -m "feat: manifest, index and save summaries"
```

---

### Task 7: 备份创建、删除与残留清理

**Files:**
- Create: `lib/backup.js`, `test/backup.test.js`
- Modify: `lib/manifest.js`（导出 `renderManifestMd` 已存在）

**Interfaces:**
- Produces: `createBackup(settings, { onProgress }): Promise<Manifest>`
- Produces: `listSaves(settings): Promise<SaveSummary[]>`
- Produces: `deleteSave(settings, id): Promise<void>`
- Produces: `cleanupOrphans(settings): Promise<void>`
- Produces: `scanProfileLinks(profileDir): Promise<Array<{ path, target }>>`
- Consumes: Task 3 的 `validateBackupDir`、Task 5 的 `createArchive`、`sha256File`、Task 6 的 `buildManifest`、`writeIndex`、Task 8 的 `renderRestorePs1`（Task 8 先写渲染函数签名；任务顺序见下）

> 依赖说明：本任务需要 `renderRestorePs1`。推荐执行顺序是先完成任务 8 的脚本渲染，再运行本任务测试；若严格按编号执行，先在 `lib/scripts.js` 放一个返回最小合法脚本的导出，Task 8 再补全内容，最后回到本任务补跑测试。

- [ ] **Step 1: 写失败的测试**

```js
// test/backup.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackup } from '../lib/backup.js'

async function fakeEnv() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bak-'))
  const install = join(root, 'install')
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'desktop')
  await mkdir(install, { recursive: true })
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(install, 'version'), '44.7.0')
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { a: '1.0.0' } }))
  return {
    root,
    settings: { installDir: install, home, profile: 'desktop', profileDir, backupRoot: join(root, 'dsh-backups'), maxSaves: 3, backupRootSource: 'default' },
  }
}

test('a save folder contains exactly zip and restore scripts', async () => {
  const { settings } = await fakeEnv()
  const manifest = await createBackup(settings, { onProgress: () => {} })
  const folder = join(settings.backupRoot, manifest.id)
  const names = (await readdir(folder)).sort()
  assert.deepEqual(names, [`${manifest.id}.zip`, 'RESTORE.cmd', 'RESTORE.ps1'].sort())
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --test test/backup.test.js`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `createBackup`**

顺序：`cleanupOrphans` → 校验 install/profile 存在 → `validateBackupDir(backupRoot)` → 数量上限 → 空间预检（`fs.statfs` 可选；home 中不存在的项与缺失的 runtimes 直接跳过）→ 生成 id（`SAVE_PREFIX + yyyyMMdd-HHmmss`，冲突加 `-2`）→ `.partial` 目录 → 扫描 links → `createArchive` 打包，sources 依次为 `{ name: 'install', path: settings.installDir }`、`{ name: 'profile/' + settings.profile, path: settings.profileDir }`、`{ name: 'profile/others', path: <home>/profiles`（只取其它 profile 的配置文件）`}`、`{ name: 'home', path: settings.home }`、`{ name: 'runtimes', path: <home>/dsh-runtimes }`，不存在的源跳过；`name` 含斜杠时 `createArchive` 需先创建 staging 内的父目录 → `verifyArchive` 检查 `manifest.json`、`install/`、`profile/<profile>/` → 写 `RESTORE.ps1`（UTF-8 BOM）与 `RESTORE.cmd`，其中 `renderRestorePs1` 的入参固定映射为 `{ id, createdAt, dshVersion, installDir: settings.installDir, home: settings.home, profile: settings.profile, backupRoot: settings.backupRoot, hasProfile: manifest.contents.hasProfile }` → rename `.partial` 为正式目录（失败重试 8 次，间隔递增）→ 更新索引。

- [ ] **Step 4: 实现列表、删除与清理**

`listSaves` 读索引，缺失时 `rebuildIndex`。`deleteSave` 校验 id 正则 `^dsh-save-\d{8}-\d{6}(-\d+)?$`、必须位于 backupRoot 下、不允许符号链接，然后递归删除并重写索引。`cleanupOrphans` 删除 `.partial` 目录与缺少 zip 的存档目录。

- [ ] **Step 5: 补测试：上限、残留、删除**

增加三个用例：第 4 次备份被拒绝且返回 `limit` 信息；存在 `.partial` 目录时 `cleanupOrphans` 删除它；`deleteSave` 后目录与索引都消失。

Run: `node --test test/backup.test.js`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add lib/backup.js test/backup.test.js lib/scripts.js
git commit -m "feat: create compressed saves with atomic folders"
```

---

### Task 8: 恢复脚本渲染

**Files:**
- Create: `lib/scripts.js`, `test/scripts.test.js`

**Interfaces:**
- Produces: `renderRestorePs1(meta): string`；`meta = { id, createdAt, dshVersion, installDir, home, profile, backupRoot, hasProfile }`
- Produces: `renderRestoreCmd(): string`
- Produces: `renderBackupReadme(meta): string`
- Produces: `restoreScriptNames(): { ps1: 'RESTORE.ps1', cmd: 'RESTORE.cmd' }`
- Consumes: 无

- [ ] **Step 1: 写失败的测试**

```js
// test/scripts.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderRestorePs1, renderRestoreCmd } from '../lib/scripts.js'

const meta = {
  id: 'dsh-save-20261024-090000', createdAt: '2026-10-24T09:00:00.000Z', dshVersion: '44.7.0',
  installDir: 'C:\\tool\\dsh', home: 'C:\\Users\\a\\.dsh', profile: 'desktop',
  backupRoot: 'C:\\tool\\dsh-backups', hasProfile: true,
}

test('restore script asks before touching anything', () => {
  const ps1 = renderRestorePs1(meta)
  assert.match(ps1, /是否继续/)
  assert.match(ps1, /ReadKey/)
  assert.match(ps1, /任意键/)
  assert.match(ps1, /-Mode/)
  assert.match(ps1, /robocopy/i)
  assert.match(ps1, /\/XD/i)
  assert.match(ps1, /mklink/i)
  assert.match(ps1, /DeepSeek Harness/)
  assert.match(ps1, /Read-Host/)
  assert.match(ps1, /_restore-tmp/)
  assert.match(ps1, /_pre-restore/)
})

test('cmd entry switches to utf8 code page', () => {
  assert.match(renderRestoreCmd(), /chcp 65001/)
})

test('cmd entry stays ascii and calls ps1', () => {
  const cmd = renderRestoreCmd()
  assert.match(cmd, /RESTORE\.ps1/)
  assert.equal(/[^\x00-\x7F]/.test(cmd), false)
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --test test/scripts.test.js`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现脚本渲染**

`renderRestorePs1` 至少包含：`#Requires -Version 5.1`；参数 `-Mode full|plugins`、`-FromUi`；存档信息与当前 DSH 版本；`Y/N` 确认；`ReadKey` 任意键；用 `Get-Process` 按可执行文件路径检测 DSH；`_restore-tmp` 解压；`_pre-restore` 快照；`robocopy /MIR /XD node_modules\dsh-crash-backup`；`mklink /J` 重建 junction；成功/失败/取消三条路径都调用同一个 `Wait-AnyKey`。中文写成 UTF-8 字符串；写文件时由调用方加 BOM。

- [ ] **Step 4: 验证 PowerShell 语法**

```powershell
powershell -NoProfile -Command "$t=[IO.File]::ReadAllText('C:\path\RESTORE.ps1'); [void][ScriptBlock]::Create($t); 'OK'"
```

Expected: 输出 `OK`，无 `ParserError`。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/scripts.test.js`
Expected: PASS。

```bash
git add lib/scripts.js test/scripts.test.js
git commit -m "feat: render standalone restore scripts"
```

---

### Task 9: 恢复启动

**Files:**
- Create: `lib/restore.js`, `test/restore.test.js`

**Interfaces:**
- Produces: `buildRestoreCommand({ scriptPath, mode }): { file: string, args: string[] }`，`mode: 'full' | 'plugins'`
- Produces: `launchRestore({ scriptPath, cwd, mode }): void`
- Consumes: 无

- [ ] **Step 1: 写失败的测试**

```js
// test/restore.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRestoreCommand } from '../lib/restore.js'

test('passes the mode through to the script', () => {
  const { args } = buildRestoreCommand({ scriptPath: 'C:\\b\\RESTORE.ps1', mode: 'plugins' })
  assert.ok(args.join(' ').includes('-Mode plugins'))
  assert.ok(args.join(' ').includes('-FromUi'))
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --test test/restore.test.js`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`buildRestoreCommand` 返回 `cmd.exe` 与 `['/d','/s','/c', 'start "" "powershell" -NoProfile -ExecutionPolicy Bypass -File "<script>" -FromUi -Mode <mode>']`（字符串拼接，路径用双引号包裹，`windowsVerbatimArguments: true`）。`launchRestore` 使用 `detached: true`、`stdio: 'ignore'`、`unref()`。

- [ ] **Step 4: 运行测试并提交**

Run: `node --test test/restore.test.js`
Expected: PASS。

```bash
git add lib/restore.js test/restore.test.js
git commit -m "feat: launch restore in its own console"
```

---

### Task 10: Host API 与插件入口

**Files:**
- Create: `lib/api.js`, `test/api.test.js`
- Modify: `index.js`（接线）

**Interfaces:**
- Produces: `createHandlers({ settings, deps }): Handlers`；`Handlers` 包含 `status()`, `startBackup()`, `startRestore({ id, mode })`, `removeSave({ id })`, `updateLocation({ path })`, `pickFolder()`, `openFolder()`
- Produces: `state` 对象含 `busy`、`job`、`settings`
- Consumes: Task 2/3/4/7/9 的全部导出

- [ ] **Step 1: 写失败的测试**

```js
// test/api.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHandlers } from '../lib/api.js'

test('status reports empty saves before any backup', async () => {
  const deps = { listSaves: async () => [], readSettings: () => ({ backupRoot: 'C:\\b' }) }
  const handlers = createHandlers({ settings: { backupRoot: 'C:\\b', maxSaves: 3 }, deps })
  const body = await handlers.status()
  assert.deepEqual(body.saves, [])
  assert.equal(body.busy, false)
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --test test/api.test.js`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 handlers 与路由**

`createHandlers` 不碰 `request/response`，只返回数据或抛带 `status`/`message` 的错误。`index.js` 里 `webServer.register` 包装：同源校验（loopback + `sec-fetch-site`）、JSON 解析上限 4 KB、错误转 400/409/500。路由：

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/status` | 列表、busy、job、备份根 |
| POST | `/backup` | 202 + job |
| POST | `/restore` | `{ id, mode }`，202 |
| POST | `/delete` | `{ id }` |
| POST | `/location` | `{ path }`，校验 + 初始化 |
| POST | `/pick-folder` | 返回 `{ path }` 或 `{ canceled: true }` |
| POST | `/open-folder` | `explorer.exe <backupRoot>` |

- [ ] **Step 4: 补测试：忙碌与非法 id**

用例：`busy` 为 true 时 `startBackup` 抛 409；`startRestore` 收到非法 id 抛 400；`updateLocation` 收到 install 内路径抛 400。

Run: `node --test test/api.test.js`
Expected: PASS。

- [ ] **Step 5: 手动验证路由**

启动 DSH，`curl http://127.0.0.1:<port>/dsh-crash-backup/api/status` 返回 JSON。Expected: 含 `backupRoot`、`saves`、`busy`。

- [ ] **Step 6: Commit**

```bash
git add lib/api.js index.js test/api.test.js
git commit -m "feat: expose backup and restore api"
```

---

### Task 11: 设置页

**Files:**
- Modify: `client.js`

**Interfaces:**
- Consumes: Task 10 的全部路由
- Produces: 设置区块 `settings.section` id `dsh-crash-backup`

- [ ] **Step 1: 实现列表与空状态**

显示存档卡片（时间、DSH 版本、插件数、体积）、备份按钮、`已保存 n/3`、当前备份路径。空状态说明"只有手动点击才会备份"。

- [ ] **Step 2: 实现备份进度与错误提示**

轮询 `/status`（1.2 秒），显示阶段文案；失败显示后端 `error`。

- [ ] **Step 3: 实现目录管理与崩溃提示**

介绍栏固定一句："DSH 崩溃或无法启动时，打开备份目录，双击任一存档里的 RESTORE.cmd 即可回档。" 旁边显示路径、`打开文件夹`、`更改目录`。更改目录调用 `/pick-folder` 再 `/location`，失败显示原因。

- [ ] **Step 4: 手动验收**

在 DSH 设置页逐项操作：备份、列表刷新、打开文件夹、取消目录选择、切换到非法目录看到拒绝原因。
Expected: 无未捕获异常；页面刷新后状态保持。

- [ ] **Step 5: Commit**

```bash
git add client.js
git commit -m "feat: backup settings page"
```

---

### Task 12: 使用文档

**Files:**
- Create: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: 写 README**

章节：安装（market/link/manual）、首次备份、崩溃后回档、两种回档模式（Task 15 完成后补）、空间要求、凭据安全、与旧插件共存、卸载。命令必须可复制执行。

- [ ] **Step 2: 验证文档命令**

按 README 从零安装到完成一次备份。
Expected: 步骤无遗漏；路径与实际一致。

- [ ] **Step 3: 补齐发布元数据**

`package.json` 去掉 `"private": true`，补 `license`、`repository`、`homepage`、`keywords`、`author`；`README.md` 写明支持的 DSH 版本范围。验证 `npm pack --dry-run` 包含 `index.js`、`lib/`、`client.js`、`cordis.patch.yml`、`locale/`、`icon.svg`、`README.md`、`CHANGELOG.md`。

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "docs: installation, release metadata and recovery guide"
```

---

### Task 13: 仅插件模式的脚本菜单

**Files:**
- Modify: `lib/scripts.js`, `test/scripts.test.js`

**Interfaces:**
- Produces: `renderRestorePs1(meta)` 输出包含模式菜单与 `-Mode` 分支
- Consumes: Task 8 的脚本结构

- [ ] **Step 1: 写失败的测试**

```js
test('script offers full and plugin-only modes', () => {
  const ps1 = renderRestorePs1(meta)
  assert.match(ps1, /完整回档/)
  assert.match(ps1, /仅回滚插件/)
  assert.match(ps1, /1/)
  assert.match(ps1, /2/)
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --test test/scripts.test.js`
Expected: FAIL，缺少菜单断言。

- [ ] **Step 3: 实现菜单与参数分支**

无 `-Mode` 时显示 `1`/`2` 菜单并循环直到有效输入；带 `-Mode` 时跳过菜单。两种模式共用 `Wait-AnyKey` 与 Y/N 确认，范围提示不同。

- [ ] **Step 4: 运行测试并提交**

Run: `node --test test/scripts.test.js`
Expected: PASS。

```bash
git add lib/scripts.js test/scripts.test.js
git commit -m "feat: restore mode menu"
```

---

### Task 14: 仅插件恢复逻辑

**Files:**
- Modify: `lib/archive.js`（`extractProfile`）、`lib/backup.js`（`snapshotProfile`）、`lib/api.js`（`mode` 校验）
- Test: `test/plugin-rollback.test.js`

**Interfaces:**
- Produces: `extractProfile(zipPath, profile, destDir): Promise<void>`（等价于 `extractPrefix(zipPath, 'profile/' + profile, destDir)`，并处理 `./` 前缀）
- Produces: `snapshotProfile({ profileDir, backupRoot, timestamp }): Promise<string>`（返回快照目录，只含 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`）
- Produces: `assertModeSupported(manifest, mode): void`（`mode === 'plugins'` 且 `!manifest.contents.hasProfile` 时抛错）
- Consumes: Task 5/7/10

- [ ] **Step 1: 写失败的测试**

```js
// test/plugin-rollback.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractProfile, createArchive } from '../lib/archive.js'
import { snapshotProfile, assertModeSupported } from '../lib/backup.js'

test('plugin-only extraction never pulls install or home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-po-'))
  await mkdir(join(root, 'profile', 'desktop'), { recursive: true })
  await mkdir(join(root, 'install'), { recursive: true })
  await writeFile(join(root, 'profile', 'desktop', 'package.json'), '{}')
  await writeFile(join(root, 'install', 'version'), '44.7.0')
  const zip = join(root, 'a.zip')
  await createArchive({ zipPath: zip, sources: [{ name: 'profile', path: join(root, 'profile') }, { name: 'install', path: join(root, 'install') }], manifest: {} })
  const dest = join(root, 'out')
  await extractProfile(zip, 'desktop', dest)
  assert.deepEqual(await readdir(dest), ['profile'])
  assert.deepEqual(await readdir(join(dest, 'profile')), ['desktop'])
})

test('plugin-only snapshot keeps only profile config files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-snap-'))
  const profileDir = join(root, 'profile')
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  await writeFile(join(profileDir, 'package.json'), '{}')
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), '')
  await writeFile(join(profileDir, 'cordis.patch.yml'), '')
  await writeFile(join(profileDir, 'node_modules', 'x.js'), '')
  const dir = await snapshotProfile({ profileDir, backupRoot: root, timestamp: '20261024-090000' })
  assert.deepEqual((await readdir(dir)).sort(), ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml'])
})

test('plugin mode is rejected when the archive has no profile', () => {
  assert.throws(() => assertModeSupported({ contents: { hasProfile: false } }, 'plugins'), /profile/)
  assert.doesNotThrow(() => assertModeSupported({ contents: { hasProfile: true } }, 'plugins'))
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --test test/plugin-rollback.test.js`
Expected: FAIL，`extractProfile` 不存在。

- [ ] **Step 3: 实现三个函数**

`assertModeSupported` 在 `api.startRestore` 里调用，早于启动脚本。`snapshotProfile` 只复制三个文件，目标 `<backupRoot>/_pre-restore/<timestamp>-plugins/`。

- [ ] **Step 4: 运行测试并提交**

Run: `node --test test/plugin-rollback.test.js`
Expected: PASS。

```bash
git add lib/archive.js lib/backup.js lib/api.js test/plugin-rollback.test.js
git commit -m "feat: plugin-only restore extraction and snapshot"
```

---

### Task 15: 设置页回档模式与文档补充

**Files:**
- Modify: `client.js`, `README.md`

- [ ] **Step 1: 回档弹窗加两个选项**

「完整回档」与「仅回滚插件」；每个选项写恢复范围；仅插件选项在 `hasProfile === false` 时禁用并显示原因。确认后调用 `/restore` 传 `mode: 'full' | 'plugins'`。

- [ ] **Step 2: 文案与状态**

提交后显示"正在完整回档"或"正在仅回滚插件"；失败展示错误。

- [ ] **Step 3: 手动验收**

分别执行两种回档，确认页面提示与脚本窗口显示的模式一致。
Expected: 传参正确；取消不会启动脚本。

- [ ] **Step 4: 更新 README 两种模式说明**

写适用场景、范围差异、插件数据不回退、需要重启。

- [ ] **Step 5: Commit**

```bash
git add client.js README.md
git commit -m "feat: choose restore scope in settings"
```

---

### Task 16: 集成验收

**Files:**
- Create: `docs/verification.md`

- [ ] **Step 1: 完整闭环**

备份 → 安装新插件并改配置 → 双击 `RESTORE.cmd` 完整回档 → 重启 DSH。
Expected: 环境回到存档；本插件仍在；`_pre-restore` 有快照。

- [ ] **Step 2: 仅插件闭环**

备份 → 升级某插件 → 设置页选"仅回滚插件"。
Expected: 插件回到存档版本；install 的 `version` 与回档前一致；home 中某个文件 mtime 未变。

- [ ] **Step 3: 崩溃场景**

结束 DSH 进程后双击脚本，分别选 `1`、`2`。
Expected: 不依赖 DSH 完成；结束提示都等待任意键。

- [ ] **Step 4: 路径矩阵**

中文目录、含空格目录、非系统盘各做一次备份与回档。
Expected: 全部成功；失败时给出具体原因。

- [ ] **Step 5: 异常路径**

损坏 zip、磁盘空间不足、目标目录被占用、存档缺少 profile。
Expected: 都在修改目标前中止；日志与提示可读。

- [ ] **Step 6: 记录结果并提交**

`docs/verification.md` 记录每项的命令、结果、截图路径。

```bash
git add docs/verification.md
git commit -m "test: integration verification results"
```
