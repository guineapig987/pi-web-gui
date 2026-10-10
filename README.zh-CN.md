<div align="center">

# pi-web

**[pi](https://github.com/earendil-works/pi) 编程智能体的浏览器图形界面**

零依赖 · 无需安装程序 · 支持电脑和手机

[한국어](README.md) · [English](README.en.md) · 简体中文

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/session-dark.png">
    <img src="docs/images/session.png" alt="pi-web 界面：项目侧边栏、对话和代码差异" width="860">
  </picture>
  &nbsp;
  <img src="docs/images/mobile.png" alt="手机界面" width="190">
</p>

<p align="center"><sub>截图使用示例数据，界面语言为韩语。</sub></p>

## 简介

pi-web 是一个小型网关服务器：每个会话启动一个 `pi --mode rpc` 进程，并通过 HTTP 和服务器发送事件（SSE）与浏览器通信。它直接使用终端版 pi 的会话文件（`~/.pi/agent/sessions`），因此可以在浏览器中继续终端里开始的对话，反之亦然。

## 主要功能

- **项目侧边栏**：按文件夹集中管理所有项目和会话。运行中的会话会显示状态（工作中、等待回应），已保存的会话一键即可继续。
- **按回合展示的对话视图**：探索类操作（读取文件、搜索）折叠为一行，Shell、编辑、写入则直接显示输出和差异（diff）。每个回合结束时显示已更改的文件列表以及 token 和费用。
- **更改面板**：一览本次会话中所有被修改文件的完整 diff。
- **文件和图片附件**：支持拖放、粘贴和回形针按钮。
- **账号、设置与更新**：可使用订阅（OAuth）或 API 密钥登录，修改常用的 pi 设置，检查并安装 pi 更新，全部在界面内完成。
- **命令面板**（`Ctrl+K`）、`/` 命令与 `@` 文件补全、`!` 执行 Shell、深色模式、任务完成通知。
- **随处可用**：响应式布局、可安装为应用（PWA）、通过 Tailscale 远程访问、登录时自动启动。

## 环境要求

- Node.js 22.19 或更高版本
- 已安装并登录的 [pi](https://github.com/earendil-works/pi)（在终端运行 `pi`，然后使用 `/login`）
- 操作系统：在 Windows 上开发并验证。服务器（`node server.mjs`）按可在 macOS 和 Linux 上运行的方式编写，但尚未验证。`start.cmd`、`piweb` 等辅助脚本仅适用于 Windows。

## 快速开始

1. 安装 Node.js 和 pi。`node -v` 的输出必须是 `v22.19` 或更高。
2. 获取代码：点击 **Code → Download ZIP** 并解压到任意位置，或执行：
   ```bash
   git clone https://github.com/guineapig987/pi-web-gui.git
   cd pi-web-gui
   ```
3. 运行。文件夹放在哪里都可以，也不需要 `npm install`。
   - Windows：双击 `start.cmd`
   - 其他系统：`node server.mjs --open`
4. 浏览器会打开 <http://127.0.0.1:8787>。关闭运行窗口即可停止服务器。

> 如果无法自动找到 pi，请通过环境变量 `PI_CLI` 指定路径（见下文）。

## 使用方法

### 界面布局

| 区域 | 说明 |
|---|---|
| 侧边栏 | 按项目显示运行中和已保存的会话。点击项目行的 `+` 在该文件夹中开始新会话，**添加文件夹**用于添加项目，搜索框可查找任意会话。用 `Ctrl+B` 折叠或展开。 |
| 主页 | 项目列表和会话列表（按今天、本周、本月分组）。 |
| 对话 | 你的消息、智能体的工作（探索、编辑、Shell）、已更改的文件，以及模型、耗时、token 和费用。 |
| 更改面板 | 整个会话按文件显示的 diff，宽度可调。 |
| 输入框 | 选择模型和思考级别、添加附件、发送和停止。扩展发出的确认和选择请求会以卡片形式显示在输入框上方。 |

### 快捷键

| 按键 | 操作 |
|---|---|
| `Ctrl+K` | 命令面板（命令以及所有项目的会话） |
| `Ctrl+Shift+S` | 新建会话 |
| `Ctrl+B` | 折叠/展开侧边栏 |
| `Ctrl+L` | 聚焦输入框 |
| `Ctrl+Shift+E` | 更改面板 |
| `Alt+0` / `Alt+1…9` | 主页 / 按侧边栏顺序切换会话 |
| `Enter` / `Shift+Enter` | 发送 / 换行 |
| 工作中 `Enter` / `Ctrl+Enter` | 立即插话（引导）/ 结束后发送 |
| `Esc` | 停止当前任务 |

### 附件

图片会原样传给模型。其他文件（文档、代码、压缩包等）保存在服务器所在电脑的 `~/.pi/agent/web-uploads/` 下，其路径会写入提示词，由 pi 用工具读取。单个文件上限为 100 MB（`PI_WEB_MAX_UPLOAD_MB`）。上传的文件不会自动删除。文本、代码等 pi 可直接读取的格式效果最好。

### 登录与设置

- **账号**：选择服务商，用订阅（OAuth）登录或保存 API 密钥。服务器运行的代码与终端 `/login` 相同。密钥和令牌只会从浏览器传到服务器，不会再次出现在界面或日志中。
- **设置**：修改 pi 全局 `settings.json` 中的常用项（思考级别、自动压缩、自动重试、代理等）。列表之外的条目以及项目内的 `.pi/settings.json` 不会被改动。

### pi 更新

启动时以及每隔 6 小时，pi-web 会将已安装的 pi 与最新版本（pi.dev）比较。有新版本时顶部会出现提示，点击它（或使用 `/update`）可查看当前和最新版本及更新说明，然后点击 **立即更新** 执行 `pi update`。有会话正在工作时不会开始更新；完成后空闲的会话会自动重启以使用新版本。如果你不是通过 npm 安装的 pi，请用原来的方式更新。

## 配置

### 命令行选项

| 选项 | 说明 |
|---|---|
| `--port <n>` | 端口（默认 `8787`，环境变量 `PI_WEB_PORT`） |
| `--cwd <目录>` | 首先打开的项目文件夹（默认 `~/Documents/pi`） |
| `--host <地址>` | 绑定地址（默认 `127.0.0.1`，环境变量 `PI_WEB_HOST`） |
| `--remote` | 允许其他设备连接：监听所有网卡。**没有登录功能。** 见[远程访问](#远程访问) |
| `--open` | 启动时打开浏览器 |

### 环境变量

| 变量 | 说明 |
|---|---|
| `PI_CLI` | pi 的 `cli.js` 或可执行文件路径（自动查找失败时使用） |
| `PI_WEB_DEFAULT_DIR` | 新会话的默认工作文件夹（默认 `~/Documents/pi`，不存在则创建） |
| `PI_WEB_PI_PACKAGE` | pi 包（`@earendil-works/pi-coding-agent`）所在文件夹，用于登录功能找不到库时 |
| `PI_WEB_PI_ARGS` | 额外传给 pi 的参数（例如 `--approve`） |
| `PI_WEB_ALLOWED_HOSTS` | 允许的 Host 头列表（逗号分隔），通过域名或代理访问时使用 |
| `PI_WEB_MAX_UPLOAD_MB` | 单个附件的最大大小（默认 100） |
| `PI_WEB_IDLE_MINUTES` | 无人查看的空闲会话在多少分钟后关闭（默认 30） |
| `PI_WEB_NO_UPDATE_CHECK` | 设为 `1` 则不检查 pi 新版本（`PI_OFFLINE` 效果相同） |

PowerShell 示例：

```powershell
$env:PI_CLI = "$env:APPDATA\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"
node server.mjs --open
```

## 远程访问

pi 可以读写服务器电脑上的文件并执行命令。**本服务器没有登录功能，因此绝不能直接暴露到互联网。** 与其在路由器上开放端口，不如使用 [Tailscale](https://tailscale.com)——一款只连接你自己设备的免费个人 VPN。

1. 在服务器电脑和要访问的设备（手机、笔记本等）上安装 Tailscale，并登录**同一个账号**。
2. 在服务器电脑上以远程模式启动：
   ```bash
   npm run start:remote        # 等同于：node server.mjs --remote
   ```
3. 在另一台设备的浏览器中打开启动时显示的 `Tailscale: http://100.x.y.z:8787` 地址。如果 Windows 防火墙弹出提示，请在“专用网络”中允许。
4. 如果需要 HTTPS 地址（`https://<电脑名>.<tailnet>.ts.net`），在服务器电脑上运行 `tailscale serve --bg 8787`。

**安全提示**

- 登录了你的 Tailscale 账号的所有设备都能使用这台服务器。请为该账号开启两步验证。
- 在咖啡馆等公共网络中开启 `--remote` 或 `--host 0.0.0.0`，同一网络里的任何人都可以连接。
- 远程模式下，会在服务器电脑屏幕上弹出的文件夹选择窗口和登录终端窗口会被禁用。请在页面内的列表中选择文件夹。
- 服务器电脑关机或休眠时无法访问。

### 安装为应用（PWA）

使用 Chrome 或 Edge 地址栏中的安装图标（或菜单 → 安装应用）即可得到独立窗口的应用。浏览器只允许在 `localhost` 或 HTTPS 地址下安装，因此要在远程设备上安装，请使用上面的 `tailscale serve` 地址。

### 保持常驻运行（Windows）

pi-web 可以在后台无窗口运行，并在你登录时自动启动。在项目文件夹中输入 `piweb`（PowerShell 中为 `.\piweb`）可查看命令列表和当前状态。运行一次 `piweb setup` 并重新打开终端后，可在任意文件夹使用 `piweb`（`piweb unsetup` 可撤销）。

| 命令 | 作用 |
|---|---|
| `piweb install` | 注册登录时自动启动（任务计划程序项 `pi-web`）并启动，以远程模式运行 |
| `piweb uninstall` | 取消自动启动并停止 |
| `piweb status` / `open` / `log` | 状态与地址 / 打开浏览器 / 最近日志 |
| `piweb start` / `stop` / `restart` | 启动 / 停止 / 重启（修改代码之后） |

日志保存在 `logs/`。如果移动了项目文件夹，请重新运行 `piweb install`。无论 PowerShell 执行策略如何，`piweb.cmd` 都会调用该脚本。

## 已知限制

- pi 仅限终端的界面（如 `ctx.ui.custom()`）以及 `/tree` 等内置 TUI 命令在 RPC 模式下不可用。
- 同时在终端 pi 和浏览器中打开**同一个**会话可能损坏会话文件，请先关闭其中一边。
- 项目的 `.pi/` 扩展和设置只有在存在已保存的信任决定时才会加载（在终端 pi 中使用 `/trust`，或设置 `PI_WEB_PI_ARGS=--approve`）。
- 侧边栏通过读取全部会话文件生成列表，会话达到数千个时刷新可能变慢。

## 项目结构

```
server.mjs                  HTTP 服务器、API 路由、SSE
lib/pi-launcher.mjs         查找 pi（Windows .cmd 包装 → 实际 cli.js）
lib/pi-process.mjs          pi RPC 进程（JSONL 分帧、请求/响应配对）
lib/live-session.mjs        运行中的会话、事件缓冲、重连后重放
lib/session-store.mjs       会话文件列表
lib/auth-service.mjs        登录与登出（pi ModelRuntime）
lib/settings-service.mjs    读写 settings.json
lib/uploads.mjs             附件上传
lib/pi-update.mjs           pi 版本检查与 `pi update`
lib/native-picker.mjs       系统文件夹选择窗口
lib/files.mjs               @ 文件搜索、文件夹浏览、新建文件夹
public/js/reducer.js        pi 事件 → 界面状态（服务器与浏览器共用）
public/js/*.js             界面（对话、工具卡片、输入框、弹窗）
start.cmd, piweb.cmd, pi-web-service.ps1   Windows 启动与后台管理
test/                       测试（假 pi、真 pi、浏览器）
```

## 测试

默认使用真实的 pi 验证；假 pi（`test/fake-pi.mjs`）只用于必须在不调用模型的情况下重放固定事件的自动化测试。

```bash
node test/unit.mjs                # 纯逻辑（reducer、Markdown、版本与附件处理）
node test/server-auth.mjs         # 服务器 API：登录、设置、更新、上传（假 pi）
node test/real-pi.mjs             # 真 pi 冒烟测试（免费）：版本、登录状态、会话启动、模型列表、上传
node test/real-pi.mjs --prompt    # 另加两条给模型的简短提问（会消耗你账号的少量 token）
node test/real-server.mjs         # 用真 pi 手动查看界面 (http://127.0.0.1:8791)
node test/e2e.mjs                 # 浏览器自动化测试（假 pi，需要 Playwright）
```

真 pi 测试使用你的登录信息（`~/.pi/agent`），但对话记录保存在临时文件夹中，结束后删除。如果因套餐额度、登录过期等账号问题无法调用模型，该步骤会显示为“跳过”而不是失败。`npm test` 只运行基于假 pi 的测试。

## 许可证

[MIT](LICENSE)
