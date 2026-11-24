# 代码路由（CODE MAP）

给接手这个插件的人：**改一个需求，该动哪个文件、哪一段、动完怎么验证。**

读完这份文档应该能回答三个问题：

1. 这个仓库里每个文件是干什么的，什么时候需要改它；
2. 插件和 DeepSeek Harness（下称 DSH）官方代码之间有哪些**外部契约**——那些不是我们的代码，改了会静默失效；
3. 改完之后在哪儿看效果、看什么信号算通过。

---

## 1. 运行时拓扑

```
┌──────────────────────────── DSH 宿主进程（node）────────────────────────────┐
│  profiles/<p>/node_modules/@local/dsh-card-dock/lib/index.js   ← Host 插件     │
│     起三个同源 HTTP 端点：/dsh-card-dock/{events,state,sync}                  │
│     内存里存一份 twinState（草稿 / 会话路径 / 画布尺寸 / 抽屉状态）           │
└───────────────▲───────────────────────────────────┬──────────────────────────┘
                │ SSE + fetch                       │ 浏览器加载
┌───────────────┴───────────────────────────────────▼──────────────────────────┐
│  浏览器页面（DSH Web）                                                        │
│  lib/client.js  ← Web Client 插件，注册进 conversation.input.dock 插槽        │
│     · 读 DSH 会话数据 → 渲染上方"Agen:"卡片（36px 窄条 / 悬停展开历史抽屉）   │
│     · 每帧把输入框的 left/width/底色/字色抄到自己身上（跟随，不重写宽度）     │
│     · BroadcastChannel + SSE 与"气泡分身"双向同步草稿和会话                  │
└───────────────▲───────────────────────────────────┬──────────────────────────┘
                │ 同源页面 + BroadcastChannel       │ Chromium --app
┌───────────────┴───────────────────────────────────▼──────────────────────────┐
│  可选：桌面悬浮气泡（desktop-launcher/dsh_browser_bubble.py）                 │
│     检测本机 Edge/Chrome → --app 打开 ?dsh_bar_clone=1 → 用 Win32 去掉标题栏   │
│     与边框、加 24px 圆角，并按页面标题里的 [DSH-BAR:WxH] 自适应尺寸           │
└──────────────────────────────────────────────────────────────────────────────┘
```

一句话：**Host 插件是双向同步的中转站，Client 插件是 UI，Python 脚本是可选的原版窗口分身。**

---

## 2. 文件职责表

| 文件 | 行数 | 职责 | 什么时候改它 |
| --- | --- | --- | --- |
| `package.json` | 47 | 包清单。`dsh.bundle.patch` 声明 Cordis 补丁；`dsh.client` 声明浏览器半边与它依赖的客户端包；`engines.dsh` 是**版本准入闸门**（不满足会被 DSH 整个跳过） | 加依赖、改版本准入、改客户端注入列表 |
| `cordis.patch.yml` | 4 | 把 Host 插件挂进 profile 的唯一入口（`- insert: id/name`） | 换插件名或加第二条挂载 |
| `lib/index.js` | 222 | Host 半边。内存 `twinState` + 三个端点：SSE 广播 `events`、轮询快照 `state`、双向写入 `sync` | 改同步字段、加端点、改草稿/会话的传播规则 |
| `lib/client.js` | 1158 | **全部 UI 与交互**。注入样式、读 DSH 会话数据、卡片渲染、悬停/展开/拖拽、跟随输入框宽度与材质、跑马灯、双窗同步 | 几乎所有视觉与交互改动都在这里（见第 4 节定位表） |
| `desktop-launcher/dsh_browser_bubble.py` | 347 | 桌面悬浮气泡启动器：找浏览器、拉 `?dsh_bar_clone=1`、Win32 去边框/圆角/置顶、按标题里的尺寸标记自适应、可绑定跟随目标进程 | 改气泡窗口形态、绑定跟随策略、浏览器探测顺序 |
| `desktop-launcher/smoke_verify_card_dock.py` | 44 | 冒烟脚本：打 `state` 与 `sync` 两个端点，验证双向同步推进 | 改 Host 端点契约后同步改它 |
| `Launch-DeepSeek-Bar-Bubble.bat` | 8 | 双击启动器，透传参数（默认 `--dsh-url http://127.0.0.1:3000`） | 改默认端口 |
| `locale/zh.json`、`locale/en.json` | 7 | 插件在"插件市场/插件清单"里显示的名字与描述 | 改展示文案 |
| `docs/DETAIL.zh.md`、`docs/preview.svg` | 1 / 13 | 插件详情页内容与预览图 | 改商品页 |
| `icon.svg` | 5 | 插件图标 | 换图标 |
| `README.md` | 24 | 使用者视角：这个插件是什么、怎么装、怎么起气泡 | 面向使用者的说明 |

`docs/CODE-MAP.md`（本文件）是**开发者视角**的导航，不随功能改动而失效，只在文件/契约变化时更新。

---

## 3. `lib/index.js`（Host 半边）

| 位置 | 内容 |
| --- | --- |
| L6-L7 | `export const name` / `export const inject = ['webServer']` —— **Cordis 4 要求 inject 是数组**，写成 Cordis 3 的 `{required, optional}` 会让插件永久 pending |
| L46-L63 | `twinState`：唯一内存状态（`seq`、`sessionPath`、`draft`、`agentName`、`widthPx`、`drawerExpanded`、`sseClients`） |
| L65-L74 | `broadcastTwinEvent()`：向所有 SSE 连接推 `event: <name>\ndata: <json>` 帧 |
| L78-L107 | `GET /dsh-card-dock/events`：SSE 长连接，先发一帧 `snapshot` 再注册进 `sseClients` |
| L110-L132 | `GET /dsh-card-dock/state`：可轮询的快照（气泡启动器用） |
| L135-L232 | `POST /dsh-card-dock/sync`：双向写入。**只有值真的变化时才 `shouldBroadcast`**，避免回环风暴；`insertQuoteText` 单独走 `twin-quote` 事件 |

字段的权威解释在代码里；要加一个同步字段，三处都要动：`twinState` 默认值、`sync` 的解析分支、`snapshot`/广播的字段列表。

---

## 4. `lib/client.js` 内部结构

单文件、单组件 `CardholderSlipDock`，按执行顺序分成 7 段：

| 行段 | 内容 | 说明 |
| --- | --- | --- |
| L1-L14 | 文件头注释 | 记录设计意图（保留） |
| L15-L52 | 模块头：`require('react')`、常量、`IS_CLONE_BUBBLE`、`BroadcastChannel` | 常量区（第 6 节有逐个数字的含义） |
| L54-L80 | `readStoredBool/Number/String` | localStorage 读取，容错 |
| L81-L235 | `ensureCardDockStyles()`：注入一份 `<style>` | **所有 CSS 都在这里**，含与官方 DOM 对接的覆盖规则（交界圆角、材质、排队条、宽度手柄层级） |
| L236-L400 | 数据提取：`extractTextFromParts` / `parseAssistantBlocksList` / `extractMessagesFromDshProps` | 把 DSH 会话快照翻译成卡片要的 `{id, role, text, tools}` 列表；兼容 `legacy.nodes`、`views.get('chat')`、`session.chat` 三种来源 |
| L397-L403 | `postTwinSync()` | 把本地状态 POST 给 Host 插件 |
| L405-L1190 | `CardholderSlipDock` 组件 | 见下 |
| L1190-L1214 | `apply(ctx)`：把组件注册进 `conversation.input.dock`（`order: 6`） | 想换插槽/排序改这里 |

组件内部（按 hook 顺序，方便搜索定位）：

| 行段 | 内容 |
| --- | --- |
| L419-L440 | state / ref 声明（悬停、固定、展开高度、名字、卡片宽度、隐藏开关） |
| L451-L463 | 从 props 提取消息，算 `latestAssistant` 与 `latestSingleLine`（单行文本来源） |
| L466-L548 | **跟随输入框宽度**：`ResizeObserver` + 短 rAF 轮询，每帧把 `[data-composer-card]` 的 `left/width` 抄给外层，并 `translateX` 校正；同时复制底色/字色/字重/字号 |
| L550-L594 | **单行跑马灯**：rAF 匀速平移（`SPEED = 42px/s` 在 L552，到尾停 700ms 回到起点），不重启、不闪烁 |
| L596-L753 | 双窗同步：SSE/`BroadcastChannel` 收消息 → 应用草稿、会话跳转、`agentName`、`pinned`；同时只把"真的变了"的字段发出去 |
| L760-L785 | `handleMouseEnter/Leave`：**悬停 300ms 才展开**，移开 160ms 收起 |
| L786-L836 | `togglePin`、`handleStartResizeHeight`（上下拖拽调抽屉高度） |
| L837-L847 | `commitAgentName`（双击改称呼） |
| L848-L1189 | 渲染：`renderAgentPrefix()` + 卡片外层（绝对定位、跟随宽度）+ 单行文本 + 展开后的历史抽屉 |

---

## 5. 与 DSH 官方的耦合面（改版后最容易静默坏掉的地方）

这些是**外部契约**，不是本仓库的代码。升级 DSH 后要逐条回归。

### 5.1 客户端模块格式

```js
window.__ModuleLoader__.load({ id: '@local/dsh-card-dock', factory(require) { ...; return { inject:[...], apply(ctx){} } } })
```

用 AMD `define()` 写会直接 `SyntaxError`，但页面看起来正常——只是插槽全空。

### 5.2 插槽

`conversation.input.dock`（list，scope=session）。组件的 props 由 DSH 注入，本插件依赖 `props.inputActions`（`insertQuote/insertDraft/focus`）与 `props.session/sessionId`。

### 5.3 DOM 选择器（结构性契约）

| 选择器 | 用途 | 失效表现 |
| --- | --- | --- |
| `[data-composer-card]` | 原生输入框：宽度/材质的抄写源、卡片纵向锚点、圆角与背景覆盖 | 卡片宽度对不齐、和输入框之间裂开或压盖 |
| `[data-composer-seat]` | 输入框座位（`z-index: 9`），曾把宽度手柄压在下面 | 手柄到输入框上沿就"断"、鼠标落不到 |
| `[data-queue-dock]` | 排队条面板（独立菜单面板），有它时卡片与排队条都要锚在它顶边 | 排队条被卡片盖住 / 出现"锅盖头" |
| `[data-conversation-scroll]` | 会话滚动区（气泡模式下重排用） | 气泡裁切异常 |
| `[data-width-handle]` | **官方**左右拖宽度手柄（自带 `top:0;bottom:0` 与光条） | 手柄延伸失效 |

### 5.4 CSS 宽度轴（**不要自己写**）

```css
.body {
  --dsh-chat-content-width: var(--dsh-chat-user-width, clamp(680px, column*0.64, 920px));
  --dsh-composer-card-max-width: calc(var(--dsh-chat-content-width) + 32px);
}
```

官方 `ConversationWidthControls` 只写 `--dsh-chat-user-width`，输入框宽度由它派生。**本插件不写这三个变量**——早期版本在 `documentElement` 上覆盖它们，导致官方手柄拖了不生效。

### 5.5 层级（z-index）现状

| 元素 | z-index | 备注 |
| --- | --- | --- |
| 官方宽度手柄 | 官方 0 → **本插件抬到 12** | 为了让它延伸到输入框两侧（否则被 seat 的 9 盖住） |
| 输入框座位 `[data-composer-seat]` | 9 | 官方值 |
| 输入框卡片 `[data-composer-card]` | 2 | 本插件设置 |
| 上层卡片 dock wrapper | 1 | 本插件设置 |

---

## 6. 常量与"魔法数字"

| 位置 | 常量 | 含义 / 为什么是这个值 |
| --- | --- | --- |
| client.js L26 | `CARD_RADIUS_PX = 24` | 与输入框圆角一致；交界处两层各出一半（上 `24 24 0 0` / 下 `0 0 24 24`） |
| L27 | `COLLAPSED_LIP_PX = 36` | 收起态窄条高度，与官方排队条 header 同高 |
| L30 | `TUCK_OVERLAP_PX = 0` | **必须为 0**：任何向上压盖都会盖掉输入框顶部插入的排队条 |
| L32 | `HOVER_EXPAND_DELAY_MS = 300` | 悬停意图判定，划过不误触 |
| L33-L35 | `DEFAULT/MIN/MAX_EXPANDED_PX = 280/160/560` | 抽屉展开高度范围 |
| L40-L42 | `dsh_card_dock:*` | localStorage 键：`pinned`、`expanded_height`、`agent_name`（宽度偏好不在这里，归官方 `dsh.conversation.contentWidth`） |
| L552 | `SPEED = 42 px/s`、`HOLD_MS = 700` | 单行跑马灯速度与到尾停留 |
| L1182 | 收起态占位文案 | 没有消息时显示的那行字 |
| index.js L46 | `seq` | 单调递增的版本号，用于让订阅方忽略重复帧 |

---

## 7. 常见需求 → 改动点

| 需求 | 改哪里 |
| --- | --- |
| 改收起态那行文案/占位提示 | `client.js` L1182 `latestSingleLine \|\| '鼠标移入展开对话记录…'` |
| 改单行滚动速度/停留 | `client.js` L550 段 `SPEED` / `HOLD_MS` |
| 改悬停展开/收起延迟 | `client.js` L32 `HOVER_EXPAND_DELAY_MS`；收起延迟在 `handleMouseLeave`（160ms） |
| 改卡片高度范围 | `client.js` L33-L35 |
| 改卡片/排队条/输入框的视觉统一规则 | `client.js` L81-L235 的样式段（交界圆角、背景、描边、排队条覆盖） |
| 改宽度手柄延伸范围 | 同上的 `[data-width-handle]` 规则（当前 `z-index: 12`） |
| 改历史抽屉里显示哪些消息 | `client.js` L271-L400（数据提取）与 L848 之后的抽屉渲染 |
| 加一个双窗同步字段 | `index.js`：`twinState` 默认值 + `sync` 解析 + 广播字段；`client.js`：`postTwinSync` 调用点 + `applyIncomingTwinState` |
| 改气泡窗口形态/跟随 | `dsh_browser_bubble.py`：`sculpt_frameless_rounded_bubble`（圆角/去边框）、`find_target_host_hwnd`（绑定目标）、`main`（主循环） |
| 换插件名 | `package.json` 的 `name`、`cordis.patch.yml` 的 `name`、`client.js` 里的 `id`，三处必须一致 |

---

## 8. 改完之后怎么验证

1. **装进一个隔离沙盒**（不要直接动生产 profile）：
   ```powershell
   # 把本目录复制到 <DSH_HOME>\profiles\web\local-plugins\dsh-card-dock，
   # 在 profile 的 package.json 里加 link 依赖与 dsh.profile.bundles 条目，然后重启实例
   ```
2. **看启动日志**：`sandbox.err.log` 里不能出现 `skipping profile bundle` / `did not activate`。
3. **看页面**：卡片出现在输入框正上方、同宽同色、交界是直的；鼠标停留 0.3s 才展开。
4. **看数值**（浏览器控制台，最能定位问题）：
   ```js
   const c = document.querySelector('[data-composer-card]').getBoundingClientRect();
   const k = document.querySelector('[data-dsb-card]').getBoundingClientRect();
   [k.left - c.left, k.width - c.width, c.top - k.bottom];   // 期望 [0, 0, 0]
   ```
5. **同步链路**：`curl http://127.0.0.1:<port>/dsh-card-dock/state`，或用 `desktop-launcher/smoke_verify_card_dock.py --dsh-url ...`。
6. **排队态**：让 agent 跑起来再发一条消息制造排队，确认 `[data-queue-dock]` 完整可见、与输入框同宽。

---

## 9. 已知取舍

- **宽度只跟随、不重写**：插件不实现自己的拖宽逻辑，只把输入框的矩形抄过来。这样官方手柄永远是唯一真源。
- **压盖量为 0**：不再用"向上压 28px"去遮双层圆角，改为两边圆角互补 + 同色背景；代价是上层卡片必须严格贴住输入框（用每帧测量保证）。
- **跑马灯用 rAF 而非 CSS 动画**：CSS 动画在文本每更新一个 token 时会被重启（原来的 `key` 里带文本长度），表现为闪烁且永远只看到开头。
- **气泡分身是可选件**：依赖本机 Chromium 与 Windows DWM；不装 Python 也不影响浏览器内体验。
- **隐藏窗口**：本插件不含任何原生窗口；如果同仓另有 Tauri 宿主，注意它必须是隐藏窗口，否则全屏置顶会挡住用户桌面。
