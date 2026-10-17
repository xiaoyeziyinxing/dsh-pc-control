# dsh-pc-control

DeepSeek Harness（DeepSeek CLI / 桌面客户端）电脑操控插件：让 AI 看到屏幕（截屏 + 本地 OCR）并操作键鼠。零第三方依赖，全部基于 Windows 内置能力（PowerShell 5.1 + WinRT OCR + SendInput）。

## 功能

- **`pc_screenshot`**：截取屏幕（多显示器虚拟屏 / 指定区域），可选 OCR 识别文字——返回行文本 + **词级屏幕绝对坐标**（点击目标 = 词中心）。图片落盘 `%TEMP%\dsh-pc-control\`。
- **`pc_click`**：鼠标单击 / 双击 / 右键（屏幕绝对坐标）。
- **`pc_type`**：向焦点输入框输入文本——**中文等非 ASCII 自动走剪贴板粘贴**（兼容输入法，会覆盖剪贴板），纯 ASCII 直发键盘事件。
- **`pc_key`**：组合键（`ctrl+s`、`enter`、`alt+tab`…，SendInput VK 序列）。
- **`pc_scroll`**：滚轮（垂直 / 水平）。
- **`pc_ball`**：控制 Trae 风格桌面悬浮球（`show` / `hide` / `status`）。

OCR 采用 Windows.Media.Ocr（本地引擎，离线，不用视觉模型）；默认 `zh-Hans-CN`，未装语言包时自动回退用户系统语言。

## 桌面悬浮球（Trae 风格）

web / 桌面客户端下插件加载后**自动在屏幕右上角显示一个置顶圆球**：

- **单击**：弹出**独立悬浮对话窗**（400×640，贴着球出现）——WinForms 无边框圆角窗 + WebView2 承载带登录态的 AI 对话页（URL 由宿主 webApp/connection 服务动态签发，含 token）。不是浏览器窗口：无地址栏、无标签页、无浏览器边框，置顶悬浮
- **对话窗常驻（客户端式）**：× 或 Esc 关闭只是**隐藏**（进程与页面状态保留），再点球**秒级唤起、不重新加载**；网页只加载一次。真退出仅两条路：球右键退出连带杀窗 / 宿主退出或重载时清理
- **对话窗交互**：顶栏可拖动窗口；首访自动关掉「预览版说明」公告；DPI aware（高缩放屏不拉伸不发糊）
- **拖动**：按住左键拖到任意位置，松开即落位；位置跨次启动记忆（`%TEMP%\dsh-pc-control\ball-pos.json`）
- **右键**：菜单——打开 AI 对话（同单击弹出对话窗）/ 退出悬浮球
- 退出宿主（含插件卸载/重载）时球自动退出；宿主被强杀残留的球会在下次宿主启动时自动清理
- LLM 侧可用 `pc_ball` 工具显式控制（show / hide / status）；隐藏后 `show` 可再次唤出

实现为独立 PowerShell WinForms 进程（经 PS 中继 `Start-Process` 拉起，规避 node 直接 detached spawn 导致 PS 控制台主机秒退的坑），零额外依赖。对话窗的 WebView2 托管三件套（SDK 1.0.2365.46）随插件 `vendor/webview2/` 分发，Evergreen Runtime 为 Win11 系统组件；DLL 缺席时自动回退默认浏览器打开。相关配置：`ballEnabled`（默认 true）/ `ballSize`（默认 64px）/ `ballColor`（默认 #0A84FF）。

## 安全模型

| 层级 | 行为 |
| --- | --- |
| 读类（`pc_screenshot`） | 自动放行 |
| 写类（click / type / key / scroll） | 默认每次向用户确认（`confirmActions` 配置可关） |
| 高危组合键（`alt+f4` / `ctrl+alt+del` / `win+d` / `win+m` / `win+l` / `ctrl+shift+esc`） | **无论配置如何都强制确认** |
| FailSafe 保命 | 鼠标进入屏幕左上角保护区（默认 10×10 px）→ 立即中止操作 |

工具调用确认走宿主 approval 机制（缺席时 fail-closed 拒绝）。

## 配置（cordis.patch.yml insert.config）

```yaml
- insert:
    - id: pc-control
      name: dsh-pc-control
      config:
        confirmActions: true   # 写类操作每次确认
        failSafePx: 10         # 左上角保护区边长（像素）
        ocrLang: zh-Hans-CN    # OCR 语言（BCP-47）
        maxOcrLines: 300       # 单次 OCR 最大返回行数
        ballEnabled: true      # 桌面悬浮球（web/桌面端自动显示）
        ballSize: 64           # 球直径（像素，28~160）
        ballColor: '#0A84FF'   # 球主题色
```

## 安装

```bash
dsh plugin add dsh-pc-control       # npm
dsh plugin add <本地目录>            # 本地开发
```

## 使用建议（给 LLM）

1. 先 `pc_screenshot`（OCR）看屏幕——这是插件的"眼睛"
2. 从 OCR 词坐标算出点击中心（`x+w/2, y+h/2`），`pc_click` 点击
3. 需要输入时先点击输入框获得焦点，再 `pc_type`
4. 大屏文字太多时用 `region` 参数局部截屏，OCR 更准也更省上下文

## 平台要求

- Windows 10+（PowerShell 5.1 内置，无需安装任何东西）
- OCR 语言包：设置 → 时间和语言 → 语言 中含目标语言（中文系统默认具备）

## License

MIT
