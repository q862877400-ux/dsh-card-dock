# @local/dsh-card-dock (v1.0.0 · 独立 DeepSeek 卡包抽屉卡 + 100% 原版浏览器实时分身插件)

本插件已将**底部输入框 + 上方悬停弹出的 `Agent:` 历史对话卡片 + 左右两侧宽度拖拽拉伸 + 本机 Edge/Chrome 无头圆角气泡实时分身**完整解耦打包为一个**零外部依赖的独立通用 DeepSeek Harness 插件**，可安装到任意 DSH Profile 中单独使用。

---

## 一、核心特性

1. **上方 `Agent:` 卡与下方原生输入框 100% 同宽、同为 `24px` 大圆角**：
   - 通过 `conversation.input.dock` 插槽直接叠压在 DSH 原生 `[data-composer-card]` 正上方（`28px` 卡包式零缝隙内嵌）；
   - 平时仅露出一行 `36px` 等宽状态窄条；**鼠标移入自动向上丝滑弹出历史聊天记录窗**（`position: absolute`，不挤压上方页面高度），支持置顶「固定」与顶部上下拖拽调节高度；**鼠标移开自动收起**。
2. **左右两侧竖向边缘拖拽调节宽度（复用 DSH 原生变量手感）**：
   - 直接驱动 DSH 官方 `--dsh-chat-content-width` 与 `--dsh-composer-card-max-width`，左右两侧边缘拖拽时 1:1 紧贴鼠标对称缩放，双击边缘一键恢复默认宽度（`780px`）。
3. **100% 保留原版视觉与功能的无边框圆角浏览器气泡分身（`?dsh_bar_clone=1`）**：
   - 彻底告别重绘山寨感：`desktop-launcher/dsh_browser_bubble.py` 自动检测本机 **Edge -> Chrome -> 其他 Chromium 内核浏览器**，直接以 `--app` 加载真正的 DSH 原版页面并裁剪为无标题栏、无边框、带 Windows 11 原生 DWM `24px` 圆角与阴影的悬浮气泡；
   - **一套接口分支出两个输入端**：通过 `BroadcastChannel` + 同源宿主 `/dsh-card-dock/events` SSE 实时双向同步 `input.draft` 与当前会话路由——你在悬浮气泡里每敲一个字，主窗口输入框同步跳出同一个字；聊天记录、`+` 号菜单、`完全权限 ▾`、模型与思考档位选择、语音输入全部 100% 原生共享！
   - 当鼠标移入展开历史卡或点击弹出原生菜单时，气泡窗口底部锚定不动、顶部自动向上扩容，绝不裁切弹窗。

---

## 二、安装与启动方法

> 要给别的开发者交接、或改这个插件之前，先读 [docs/CODE-MAP.md](docs/CODE-MAP.md)：它逐个文件说明职责、与 DSH 官方的耦合面（选择器 / CSS 变量 / z-index）、常见需求该改哪一段，以及改完怎么验证。

```powershell
# 1. 安装独立插件到你的任意 DSH Profile（例如 default 或 web）
dsh plugin --profile web add "file:D:/你的路径/dsh-card-dock-plugin"

# 2. 启动 DSH Web 后，直接在浏览器内即可看到上方同宽 24px 悬停聊天卡！

# 3. 可选：拉起桌面无边框 24px 圆角原版浏览器分身气泡（将 3000 换成你实际的 DSH Web 端口）
python desktop-launcher/dsh_browser_bubble.py --dsh-url http://127.0.0.1:3000

# 4. 可选：将原版分身气泡绑定在任意软件（如 SolidWorks）正中下方并 60Hz 跟随窗口移动与缩放
python desktop-launcher/dsh_browser_bubble.py --dsh-url http://127.0.0.1:3000 --bind-process SLDWORKS.exe
```
