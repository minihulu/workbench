# 工作台 · 桌面客户端（Tauri）

用 [Tauri](https://tauri.app/) 把工作台封装成 Windows / macOS / Linux 原生应用。
Tauri 只做“原生窗口壳”，页面由**后端服务**提供——所以一个客户端可同时连「本机服务」或「你部署的云」，登录同一账号即多端同步（百度网盘那种体验）。

```
workbench/
├── dist/index.html        # 加载占位页（失败兜底：自动重试跳转本地服务）
├── src-tauri/             # Rust/Tauri 工程
│   ├── Cargo.toml
│   ├── build.rs
│   ├── src/main.rs
│   ├── src/lib.rs         # 启动逻辑：拉起 server.py + 窗口导航
│   ├── tauri.conf.json
│   └── icons/             # 各尺寸图标
├── package.json           # tauri CLI 脚本（可选，npm 用户用）
├── server.py              # 后端（随包分发，桌面端自动拉起）
└── workbench.html         # 前端主程序（由后端托管）
```

## 1. 前置依赖

- [Rust](https://rustup.rs/)（含 cargo）
- 系统 WebView 开发库：
  - **Linux**：`webkit2gtk-4.1`、`libsoup-3.0`、`javascriptcoregtk-4.1`、`gtk-3`（Debian/Ubuntu：`sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file`）
  - **macOS**：`xcode-select --install`
  - **Windows**：[WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（通常已自带）+ VS Build Tools
- （可选）Node.js + `@tauri-apps/cli`，用于 `npm run tauri`

## 2. 构建

### 方式 A：cargo（无需 npm）
```bash
cd src-tauri
cargo tauri build        # 产出安装包在 src-tauri/target/release/bundle/
```
> 首次构建会联网拉取 Tauri 依赖（crates.io），请在有网环境执行。

### 方式 B：npm
```bash
npm install
npm run tauri build
```

产物：
- Windows：`target/release/bundle/msi/*.msi` 与 `*.exe`
- macOS：`*.app` / `*.dmg`
- Linux：`*.deb` / `*.AppImage`

## 3. 使用

**本机模式（默认）**：双击应用即可。桌面端会自动拉起随包分发的 `server.py`（数据库写在可写的应用数据目录 `AppData\Roaming\com.workbench.app`，避免安装目录只读），窗口直接导航到 `http://127.0.0.1:8000`，无需手动输入地址。用同一账号登录即与网页/手机端实时同步。

**云端模式**：构建时指定后端地址，让应用直接连你部署的服务（数据仍在云端）：

```bash
# Windows (PowerShell)
$env:WORKBENCH_BACKEND="https://workbench.example.com"
cargo tauri build

# 或 npm
WORKBENCH_BACKEND=https://workbench.example.com npm run tauri build
```

**指定 Python 解释器**（若 `python` 不在 PATH）：构建/运行前设置 `WORKBENCH_PYTHON` 指向解释器路径。

## 4. 自定义后端地址范围

默认允许导航到 `http://localhost:8000` 与 `https://*`（见 `src-tauri/tauri.conf.json` 的 `app.urlScope`）。
若你的服务在其它 http 地址，把该地址加入 `urlScope` 数组后重新 `cargo tauri build`。

## 5. 离线单机版说明

默认打包即为「自带后端」形态：`src-tauri/src/lib.rs` 在应用启动时以子进程拉起随包分发的 `server.py`，
窗口导航到 `http://127.0.0.1:8000`，等价于百度网盘的桌面客户端体验。**目标机器需装有 Python 3**（并在 PATH，或用 `WORKBENCH_PYTHON` 指定）。
若要实现「无需 Python」的纯原生单机版，需把后端用 Rust 重写（替换 `server.py`），属于较大改造。

## 6. 已知边界

- 客户端不含业务逻辑，所有同步/冲突合并在 `workbench.html` 内完成，版本随服务端一致。
- 数据以「登录账号」为单位在云端隔离；同一账号多端实时同步（SSE）+ 离线合并均已实现。
