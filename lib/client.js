// @local/dsh-card-dock/lib/client.js — Standalone DeepSeek-Bar Cardholder-Slip + Live Browser Twin Client (v1.0.0)
// 1. Mounts the equal-width, 24px-rounded hover-expandable "Agent:" chat history card directly above DSH's native [data-composer-card].
// 2. Reads 100% genuine DSH 0.2.2-rc.5 session messages (session.chat.order + session.chat.nodes.get(key)) including live streaming steps.
// 3. Width of the whole conversation + composer is owned by DSH's official axis
//    (ConversationWidthControls publishes --dsh-chat-user-width; official CSS derives
//    --dsh-chat-content-width and --dsh-composer-card-max-width). This plugin never
//    writes those variables and has no width handles of its own.
// 4. Implements 100% Native Browser Bubble Clone Mode (?dsh_bar_clone=1): strips surrounding DSH chrome via :has([data-composer-seat]) CSS
//    while preserving 100% of DSH's authentic composer (+, 完全权限, model/effort selector, voice, slash menu) AND synchronizing keystroke-by-keystroke
//    draft text, session URL, width, and quotes in real time via BroadcastChannel + /dsh-card-dock/events SSE!

window.__ModuleLoader__.load({
  id: '@local/dsh-card-dock',
  factory(require) {
    const React = require('react');
    const {
      useCallback,
      useEffect,
      useLayoutEffect,
      useMemo,
      useRef,
      useState,
    } = React;
    const h = React.createElement;

    const CARD_RADIUS_PX = 24;
    const COLLAPSED_LIP_PX = 36;
    // 压盖量必须为 0：DSH 在输入框顶部插入排队条时，任何向上压进去的高度都会把那条盖掉一半。
    // 交界处靠"两边圆角互补（上 24 24 0 0 / 下 0 0 24 24）+ 同色背景"保持一整张卡的效果，不需要靠压盖遮缝。
    const TUCK_OVERLAP_PX = 0;
    // 悬停意图判定：鼠标需停留这么久才展开，纯划过不误触
    const HOVER_EXPAND_DELAY_MS = 300;
    const DEFAULT_EXPANDED_PX = 280;
    const MIN_EXPANDED_PX = 160;
    const MAX_EXPANDED_PX = 560;

    // 整组宽度一律交给 DSH 官方机制（ConversationWidthControls 写 --dsh-chat-user-width，
    // 官方 CSS 再派生出 --dsh-chat-content-width 与 --dsh-composer-card-max-width），
    // 插件不再自己算宽度、也不再覆盖这两个变量，否则会和官方拖拽手柄打架。
    const STORAGE_KEY_PINNED = 'dsh_card_dock:pinned';
    const STORAGE_KEY_HEIGHT = 'dsh_card_dock:expanded_height';
    const STORAGE_KEY_AGENT_NAME = 'dsh_card_dock:agent_name';

    const SELF_CLIENT_ID = 'dsh-twin-' + Math.random().toString(36).slice(2, 10);
    const IS_CLONE_BUBBLE =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('dsh_bar_clone') === '1';

    const broadcastChan =
      typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('dsh-card-dock-twin-v1')
        : null;

    function readStoredBool(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : raw === '1';
      } catch {
        return fallback;
      }
    }

    function readStoredNumber(key, fallback, min, max) {
      try {
        const val = Number(localStorage.getItem(key));
        return Number.isFinite(val) && val >= min && val <= max ? val : fallback;
      } catch {
        return fallback;
      }
    }

    function readStoredString(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw && raw.trim() ? raw.trim() : fallback;
      } catch {
        return fallback;
      }
    }

    const STYLE_ID = 'dsh-card-dock-standalone-styles-v1';
    function ensureCardDockStyles() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
      const styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        '@keyframes dgPopIn {',
        '  0%   { opacity: 0.25; transform: translateY(5px); }',
        '  100% { opacity: 1;    transform: translateY(0); }',
        '}',
        '[data-dg-msg-pop] {',
        '  animation: dgPopIn 0.2s cubic-bezier(0.22, 1, 0.36, 1);',
        '}',
        // 单行跑马灯：位移由 rAF 写 transform，这里只保证内层是 nowrap 的 inline-block，
        // 这样 scrollWidth 才量得到真实文字宽度（不再用 CSS 动画，避免每个 token 重启动画）
        '[data-dg-line] {',
        '  display: inline-block;',
        '  white-space: nowrap;',
        '  will-change: transform;',
        '}',
        '[data-dg-scroll]::-webkit-scrollbar { width: 5px; }',
        '[data-dg-scroll]::-webkit-scrollbar-track { background: transparent; }',
        '[data-dg-scroll]::-webkit-scrollbar-thumb {',
        '  background: rgba(255, 255, 255, 0.16);',
        '  border-radius: 999px;',
        '}',
        '[data-composer-card] {',
        '  position: relative !important;',
        '  z-index: 2 !important;',
        '  border-radius: 0 0 24px 24px !important;',
        '  box-sizing: border-box !important;',
        '  background: var(--dsw-alias-bg-layer-2, #2c2c2e) !important;',
        // 原生输入框原本自带硬边描边/阴影，会与上层卡片形成"一层软边一层硬边"，这里统一去掉
        '  box-shadow: none !important;',
        '  border: none !important;',
        '}',
        // 上层卡片：材质/字体全部继承下面输入框（颜色与字重由 sync 时复制 computed style 覆盖）
        '[data-dsb-card] {',
        '  box-shadow: 0 -12px 30px rgba(0, 0, 0, 0.34) !important;',
        '  border: none !important;',
        '}',
        '[data-dsb-card], [data-dsb-card] * {',
        '  font-family: inherit !important;',
        '  font-weight: inherit !important;',
        '}',
        '[data-dsb-card] * {',
        '  color: inherit !important;',
        '}',
        // 官方宽度手柄（[data-width-handle]）本身是 top:0/bottom:0 拉满整列的，但输入框的
        // [data-composer-seat] 用 z-index:9 把它在"输入框那一段"盖住了——所以手柄看起来到
        // 输入框上沿就断了、鼠标也落不到。这里把手柄抬到 seat 之上：手柄会一直向下延伸到
        // 输入框两侧（含下方 footer 区），拖拽手感与上方完全一致。宽度/位置都不动。
        '[data-width-handle] {',
        '  z-index: 12 !important;',
        '}',
        // 排队条（[data-queue-dock]）原本是独立菜单面板：顶部圆角 + 自己的菜单底色 + 描边、
        // 且比输入框窄一圈，夹在两张圆角卡之间就成了"锅盖头"。这里把它并进同一张卡：
        // 全宽、同底色、同文字样式、四角直角（圆角交给上面卡片和下面输入框各出一半）。
        '[data-queue-dock] {',
        '  padding: 0 !important;',
        '}',
        '[data-queue-dock] > div {',
        '  border-radius: 0 !important;',
        '  padding: 0 !important;',
        '}',
        '[data-queue-dock] > div::before {',
        '  background: var(--dsb-surface, var(--dsw-alias-bg-layer-2)) !important;',
        '  backdrop-filter: none !important;',
        '}',
        '[data-queue-dock] > div::after {',
        '  border: none !important;',
        '}',
        '[data-queue-dock] button {',
        '  border-radius: 0 !important;',
        '  color: var(--dsb-text, var(--dsw-alias-label-primary)) !important;',
        '  font-weight: var(--dsb-weight, 400) !important;',
        '  font-size: var(--dsb-fontsize, 13px) !important;',
        '}',
        '[data-composer-card] span[class*="chip"],',
        '[data-composer-card] [data-quote-chip],',
        '[data-composer-card] [data-ref-chip] {',
        '  max-width: 176px !important;',
        '  overflow: hidden !important;',
        '  text-overflow: ellipsis !important;',
        '  white-space: nowrap !important;',
        '}',
        // =====================================================================
        // ?dsh_bar_clone=1 — 100% Authentic Native DSH Floating Browser Bubble Mode!
        // Hides surrounding DSH sidebar/header/transcript/stats while keeping 100%
        // of the genuine [data-composer-card], upper Agent card, and popup menus!
        // =====================================================================
        'html[data-dsh-bar-clone="1"],',
        'html[data-dsh-bar-clone="1"] body {',
        '  margin: 0 !important;',
        '  padding: 0 !important;',
        '  width: 100vw !important;',
        '  height: 100vh !important;',
        '  overflow: hidden !important;',
        '  background: #18181b !important;',
        '}',
        // Hide any sibling branch that neither contains [data-composer-seat] nor is a floating menu/portal
        'html[data-dsh-bar-clone="1"] body *:not(:has([data-composer-seat])):not([data-composer-seat]):not([data-composer-seat] *):not([role="menu"]):not([role="menu"] *):not([role="listbox"]):not([role="listbox"] *):not([role="dialog"]):not([role="dialog"] *):not([data-radix-popper-content-wrapper]):not([data-radix-popper-content-wrapper] *):not([data-floating-ui-portal]):not([data-floating-ui-portal] *) {',
        '  display: none !important;',
        '}',
        // Collapse ancestor wrappers cleanly to full bubble viewport anchored at the bottom
        'html[data-dsh-bar-clone="1"] body *:has([data-composer-seat]) {',
        '  margin: 0 !important;',
        '  padding: 0 !important;',
        '  border: none !important;',
        '  width: 100vw !important;',
        '  max-width: 100vw !important;',
        '  height: 100vh !important;',
        '  min-height: 0 !important;',
        '  background: transparent !important;',
        '  overflow: visible !important;',
        '}',
        'html[data-dsh-bar-clone="1"] [data-conversation-scroll] {',
        '  display: flex !important;',
        '  flex-direction: column !important;',
        '  justify-content: flex-end !important;',
        '  height: 100vh !important;',
        '  overflow: visible !important;',
        '  padding: 0 !important;',
        '}',
        'html[data-dsh-bar-clone="1"] [data-composer-seat] {',
        '  position: fixed !important;',
        '  left: 0 !important;',
        '  right: 0 !important;',
        '  bottom: 0 !important;',
        '  width: 100vw !important;',
        '  max-width: 100vw !important;',
        '  margin: 0 !important;',
        '  padding: 0 !important;',
        '  background: transparent !important;',
        '  z-index: 20 !important;',
        '}',
        'html[data-dsh-bar-clone="1"] [data-composer-seat] > div {',
        '  width: 100vw !important;',
        '  max-width: 100vw !important;',
        '  margin: 0 !important;',
        '  padding: 0 !important;',
        '}',
        'html[data-dsh-bar-clone="1"] [data-composer-card] {',
        '  width: 100vw !important;',
        '  max-width: 100vw !important;',
        '  margin: 0 !important;',
        '}',
        // Hide bottom token stats line under [data-composer-card] in bubble mode
        'html[data-dsh-bar-clone="1"] [data-composer-card] ~ * {',
        '  display: none !important;',
        '}',
      ].join('\n');
      document.head.appendChild(styleEl);
    }

    function extractTextFromParts(parts) {
      if (!parts) return '';
      if (typeof parts === 'string') return parts.trim();
      if (!Array.isArray(parts)) return '';
      const buf = [];
      for (const p of parts) {
        if (!p) continue;
        if (typeof p === 'string') {
          buf.push(p);
        } else if (typeof p.text === 'string' && (p.type === 'text' || p.kind === 'text' || !p.type)) {
          buf.push(p.text);
        } else if (typeof p.content === 'string') {
          buf.push(p.content);
        }
      }
      return buf.join('\n').trim();
    }

    function parseAssistantBlocksList(blocks) {
      const texts = [];
      const tools = [];
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (!b) continue;
          if ((b.kind === 'text' || b.type === 'text') && typeof b.text === 'string' && b.text.trim()) {
            texts.push(b.text.trim());
          } else if ((b.kind === 'tool-call' || b.type === 'tool-call') && b.name) {
            tools.push(String(b.name));
          }
        }
      }
      return { text: texts.join('\n\n').trim(), tools };
    }

    // Supports official DSH 0.2.2-rc.5 (useConversation views.get('chat') + session.chat.order/nodes) AND legacy shapes
    function extractMessagesFromDshProps(props) {
      const result = [];
      if (!props || typeof props !== 'object') return result;

      let chatSnap = null;
      if (typeof props.useConversation === 'function') {
        try {
          chatSnap = props.useConversation((c) => {
            if (!c) return null;
            if (c.views && typeof c.views.get === 'function') return c.views.get('chat');
            return c.chat || null;
          });
        } catch {}
      }
      const session = props.session || null;
      if (!chatSnap && session && session.chat) {
        chatSnap = session.chat;
      }

      // 1a. DSH 0.2.2 legacy.nodes + legacy.partial
      if (chatSnap && chatSnap.legacy && Array.isArray(chatSnap.legacy.nodes) && chatSnap.legacy.nodes.length > 0) {
        for (let i = 0; i < chatSnap.legacy.nodes.length; i += 1) {
          const nd = chatSnap.legacy.nodes[i];
          if (!nd) continue;
          if (nd.kind === 'user' || nd.kind === 'steering') {
            const txt = extractTextFromParts(nd.content);
            if (txt) {
              result.push({
                id: String(nd.messageId || 'u-' + i),
                role: 'user',
                text: txt,
                streaming: false,
              });
            }
          } else if (nd.kind === 'assistant') {
            const parsed = parseAssistantBlocksList(nd.blocks);
            const displayTxt = parsed.text || (parsed.tools.length ? '正在调用 ' + parsed.tools.join(', ') + '…' : '');
            if (displayTxt) {
              result.push({
                id: String(nd.messageId || 'a-' + i),
                role: 'assistant',
                text: displayTxt,
                streaming: false,
              });
            }
          }
        }
        if (chatSnap.legacy.partial && Array.isArray(chatSnap.legacy.partial.blocks)) {
          const pp = parseAssistantBlocksList(chatSnap.legacy.partial.blocks);
          if (pp.text || pp.tools.length) {
            result.push({
              id: 'streaming-partial',
              role: 'assistant',
              text: pp.text || '正在执行 ' + pp.tools.join(', ') + '…',
              streaming: true,
            });
          }
        }
        if (result.length > 0) return result.slice(-40);
      }

      // 1b. Official DSH 0.2.2-rc.5 ChatSnapshot (order + nodes.get(key))
      if (
        chatSnap &&
        Array.isArray(chatSnap.order) &&
        chatSnap.nodes &&
        typeof chatSnap.nodes.get === 'function'
      ) {
        for (const key of chatSnap.order) {
          const node = chatSnap.nodes.get(key);
          const d = node && node.data ? node.data : node;
          if (!d) continue;
          const kind = node.kind || d.kind;
          if (kind === 'user' || kind === 'steering') {
            const txt = extractTextFromParts(d.content ?? d.parts ?? d.text);
            if (txt) {
              result.push({
                id: String(key),
                role: 'user',
                text: txt,
                streaming: false,
              });
            }
          } else if (kind === 'assistant-step' || kind === 'assistant' || Array.isArray(d.blocks)) {
            const parsed = parseAssistantBlocksList(d.blocks);
            const displayTxt = parsed.text || (parsed.tools.length ? '正在调用 ' + parsed.tools.join(', ') + '…' : '');
            if (displayTxt) {
              result.push({
                id: String(key),
                role: 'assistant',
                text: displayTxt,
                streaming: d.status === 'running',
              });
            }
          }
        }
        if (result.length > 0) return result.slice(-40);
      }

      // 2. Fallback for generic arrays (messages / items / turns)
      const list =
        session && Array.isArray(session.messages)
          ? session.messages
          : session && Array.isArray(session.items)
            ? session.items
            : session && Array.isArray(session.turns)
              ? session.turns
              : [];
      for (let i = 0; i < list.length; i += 1) {
        const m = list[i];
        if (!m || typeof m !== 'object') continue;
        const rawRole = String(m.role || m.sender || m.author || '').toLowerCase();
        const role = rawRole.includes('user') || rawRole.includes('human') ? 'user' : 'assistant';
        const txt = extractTextFromParts(m.content ?? m.parts ?? m.blocks ?? m.text ?? m.message);
        if (txt) {
          result.push({
            id: String(m.id || 'msg-' + i),
            role,
            text: txt,
            streaming: Boolean(m.streaming),
          });
        }
      }
      return result.slice(-40);
    }

    function postTwinSync(payload) {
      fetch('/dsh-card-dock/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ clientId: SELF_CLIENT_ID, dshOrigin: window.location.origin }, payload)),
      }).catch(() => {});
    }

    function CardholderSlipDock(props) {
      useEffect(() => {
        ensureCardDockStyles();
        if (IS_CLONE_BUBBLE && typeof document !== 'undefined') {
          document.documentElement.setAttribute('data-dsh-bar-clone', '1');
        }
      }, []);

      // Read live DSH session & live draft from InputZone props (official slots.d.ts contract!)
      const liveDraft =
        props && props.input && typeof props.input.draft === 'string' ? props.input.draft : '';
      const inputActions = props && props.inputActions ? props.inputActions : null;
      const sessionId = props && props.sessionId ? String(props.sessionId) : '';

      const [hovered, setHovered] = useState(false);
      const [pinned, setPinned] = useState(() => readStoredBool(STORAGE_KEY_PINNED, false));
      const [expandedHeight, setExpandedHeight] = useState(() =>
        readStoredNumber(STORAGE_KEY_HEIGHT, DEFAULT_EXPANDED_PX, MIN_EXPANDED_PX, MAX_EXPANDED_PX),
      );
      const [agentName, setAgentName] = useState(() =>
        readStoredString(STORAGE_KEY_AGENT_NAME, 'Agent'),
      );
      const [editingName, setEditingName] = useState(false);
      const [nameDraft, setNameDraft] = useState(agentName);
      const [matchedCardWidth, setMatchedCardWidth] = useState(null);
      const [suppressedByOtherDock, setSuppressedByOtherDock] = useState(false);

      const wrapRef = useRef(null);
      const scrollRef = useRef(null);
      const lipViewportRef = useRef(null);
      const lipTextRef = useRef(null);
      const collapseTimerRef = useRef(null);
    const hoverTimerRef = useRef(null);
      const isResizingHeightRef = useRef(false);
      const isResizingWidthRef = useRef(false);
      const lastRemoteDraftRef = useRef(null);

      // 同一个 profile 里若已装了同类"卡包抽屉"插件，避免重复渲染两层卡片。
      // 选择器是对方插件写在 DOM 上的标记，改名前先确认对方还在用。
      useEffect(() => {
        if (typeof document === 'undefined') return;
        const other = document.querySelector('[data-zegel-dock-active="1"]');
        if (other && other !== wrapRef.current) {
          setSuppressedByOtherDock(true);
        }
      }, []);

      const entries = extractMessagesFromDshProps(props);
      const latestAssistant = useMemo(() => {
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          if (entries[i].role === 'assistant') return entries[i];
        }
        return entries.length > 0 ? entries[entries.length - 1] : null;
      }, [entries]);

      const latestSingleLine = latestAssistant
        ? latestAssistant.text.replace(/\s+/g, ' ').trim()
        : '';

      const isExpanded = pinned || hovered;

      // Lock upper Agent card pixel width 1:1 to DSH's native [data-composer-card]
      useLayoutEffect(() => {
        const dockEl = wrapRef.current;
        if (!dockEl || typeof ResizeObserver === 'undefined') return;
        const findComposer = () => document.querySelector('[data-composer-card]');

        // 直接抄下面输入框的矩形：left/width 用它的视口坐标原样复制过来，
        // 不再各自居中计算（两个父容器不同，居中会差 1~2px 并露出弧线）。
        const syncWidth = () => {
          const composerCard = findComposer();
          const wrap = wrapRef.current;
          if (!composerCard || !wrap) return;
          const rect = composerCard.getBoundingClientRect();
          if (rect.width <= 120) return;

          const px = Math.round(rect.width * 100) / 100;
          wrap.style.width = px + 'px';
          wrap.style.maxWidth = px + 'px';
          wrap.style.minWidth = px + 'px';

          // 先清掉上一帧的位移再量，避免增量漂移
          wrap.style.transform = 'none';
          const own = wrap.getBoundingClientRect();
          const dx = Math.round((rect.left - own.left) * 100) / 100;
          if (Math.abs(dx) > 0.01) wrap.style.transform = 'translateX(' + dx + 'px)';

          // 材质也照抄：背景色 + 文字色/字重/字号/字体，两层用同一套数值
          const cs = getComputedStyle(composerCard);
          const cardEl = wrap.querySelector('[data-dsb-card]');
          if (cardEl) {
            cardEl.style.background = cs.backgroundColor;
            cardEl.style.color = cs.color;
            cardEl.style.fontSize = cs.fontSize;
            cardEl.style.fontWeight = cs.fontWeight;
            cardEl.style.fontFamily = cs.fontFamily;

            // 纵向锚点：有排队条时以排队条顶边为界，没有时贴在输入框顶边。
            // 否则卡片会把 [data-queue-dock] 整条盖掉（上一版就是这么把排队条弄丢的）。
            const queueDock = document.querySelector('[data-queue-dock]');
            const qr = queueDock ? queueDock.getBoundingClientRect() : null;
            const hasQueue = !!(qr && qr.height > 1);
            const anchorTop = hasQueue ? Math.min(rect.top, qr.top) : rect.top;
            const wr = wrap.getBoundingClientRect();
            const gap = Math.round((anchorTop - wr.bottom) * 100) / 100;
            cardEl.style.bottom = (-gap) + 'px';
            // 排队面板与卡片相接的那两个角交给卡片提供圆角，避免又出现"双层弧"；
            // 同时把底色/字色/字重灌进去，让排队条和整张卡是同一块材质
            if (hasQueue) {
              const panel = queueDock.firstElementChild;
              if (panel) panel.style.borderRadius = '0px';
              // 宽度/左边也抄输入框：排队条原来比输入框窄一圈，才是"锅盖头"的另一半原因
              queueDock.style.width = rect.width + 'px';
              queueDock.style.maxWidth = rect.width + 'px';
              queueDock.style.transform = 'none';
              const qrr = queueDock.getBoundingClientRect();
              const qdx = Math.round((rect.left - qrr.left) * 100) / 100;
              if (Math.abs(qdx) > 0.01) queueDock.style.transform = 'translateX(' + qdx + 'px)';
              queueDock.style.setProperty('--dsb-surface', cs.backgroundColor);
              queueDock.style.setProperty('--dsb-text', cs.color);
              queueDock.style.setProperty('--dsb-weight', cs.fontWeight);
              queueDock.style.setProperty('--dsb-fontsize', cs.fontSize);
            }
          }

          setMatchedCardWidth(Math.round(px));
        };

        syncWidth();
        const composerCard = findComposer();
        const ro = new ResizeObserver(syncWidth);
        if (composerCard) ro.observe(composerCard);
        // 输入框宽度只由 CSS 变量驱动时 RO 不一定触发，补一帧一测的短轮询（拖拽 400ms 内）
        const rafTick = (frames) => {
          syncWidth();
          if (frames > 0) requestAnimationFrame(() => rafTick(frames - 1));
        };
        rafTick(24);
        window.addEventListener('resize', syncWidth);
        return () => {
          ro.disconnect();
          window.removeEventListener('resize', syncWidth);
        };
      }, []);

      // 单行跑马灯：rAF 匀速平移，文本增长时继续往前滚，不重启、不闪烁
      useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const SPEED = 42; // px/s，一行约 20 字/秒，够读但不晕
        const HOLD_MS = 700;
        const TAIL_PAD = 16;
        let offset = 0;
        let lastTs = 0;
        let holdUntil = 0;
        let overflow = 0;
        let nextMeasure = 0;
        let raf = 0;

        const tick = (ts) => {
          raf = window.requestAnimationFrame(tick);
          const vp = lipViewportRef.current;
          const tx = lipTextRef.current;
          if (!vp || !tx) return;
          if (!lastTs) lastTs = ts;
          const dt = Math.min(0.12, (ts - lastTs) / 1000);
          lastTs = ts;

          if (ts >= nextMeasure) {
            overflow = Math.max(0, tx.scrollWidth - vp.clientWidth);
            nextMeasure = ts + 250; // 流式增长时每 250ms 重测一次即可
          }
          if (overflow <= 8) {
            if (offset !== 0) {
              offset = 0;
              tx.style.transform = 'none';
            }
            return;
          }
          if (holdUntil) {
            if (ts < holdUntil) return;
            holdUntil = 0;
            offset = 0;
          }
          offset = Math.min(overflow + TAIL_PAD, offset + SPEED * dt);
          if (offset >= overflow + TAIL_PAD) holdUntil = ts + HOLD_MS;
          tx.style.transform = 'translateX(' + (-offset).toFixed(2) + 'px)';
        };
        raf = window.requestAnimationFrame(tick);
        return () => window.cancelAnimationFrame(raf);
      }, []);

      // Scroll history drawer to bottom when expanded or new tokens stream in
      useEffect(() => {
        if (isExpanded && scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      }, [isExpanded, entries.length, latestSingleLine]);

      // =====================================================================
      // Bidirectional Live Twin Sync (BroadcastChannel + Host SSE)
      // =====================================================================
      const applyIncomingTwinState = useCallback(
        (msg) => {
          if (!msg || msg.sourceClientId === SELF_CLIENT_ID) return;

          // 1. Live Draft Text Mirroring (Main DSH <-> Floating Browser Bubble)
          if (
            typeof msg.draft === 'string' &&
            inputActions &&
            typeof inputActions.setDraft === 'function' &&
            msg.draft !== liveDraft
          ) {
            lastRemoteDraftRef.current = msg.draft;
            inputActions.setDraft(msg.draft);
          }

          // 2. Active Session Route Mirroring (Bubble follows Main DSH session switches automatically!)
          if (
            IS_CLONE_BUBBLE &&
            typeof msg.sessionPath === 'string' &&
            msg.sessionPath.startsWith('/') &&
            msg.sessionPath !== window.location.pathname
          ) {
            const targetUrl = msg.sessionPath + '?dsh_bar_clone=1';
            window.location.replace(targetUrl);
            return;
          }

          // 3. Shared UI preferences (agentName, pinned) —— 宽度由 DSH 官方机制负责，不再同步
          if (typeof msg.agentName === 'string' && msg.agentName !== agentName) {
            setAgentName(msg.agentName);
          }
          if (typeof msg.pinned === 'boolean' && msg.pinned !== pinned) {
            setPinned(msg.pinned);
          }
        },
        [inputActions, liveDraft, agentName, pinned],
      );

      // Broadcast local draft & session changes to the twin window!
      useEffect(() => {
        if (lastRemoteDraftRef.current === liveDraft) {
          lastRemoteDraftRef.current = null;
          return;
        }
        const payload = {
          sourceClientId: SELF_CLIENT_ID,
          sessionPath: IS_CLONE_BUBBLE ? undefined : window.location.pathname,
          sessionId: sessionId || undefined,
          draft: liveDraft,
        };
        if (broadcastChan) {
          try {
            broadcastChan.postMessage(payload);
          } catch {}
        }
        const timer = setTimeout(() => {
          postTwinSync(payload);
        }, 16);
        return () => clearTimeout(timer);
      }, [liveDraft, sessionId]);

      // Listen on BroadcastChannel + Host SSE (/dsh-card-dock/events)
      useEffect(() => {
        const onBc = (ev) => {
          applyIncomingTwinState(ev.data);
        };
        if (broadcastChan) {
          broadcastChan.addEventListener('message', onBc);
        }

        let es = null;
        if (typeof EventSource !== 'undefined') {
          es = new EventSource('/dsh-card-dock/events');
          es.addEventListener('twin-sync', (ev) => {
            try {
              applyIncomingTwinState(JSON.parse(ev.data));
            } catch {}
          });
          es.addEventListener('twin-quote', (ev) => {
            try {
              const data = JSON.parse(ev.data);
              if (
                data &&
                data.sourceClientId !== SELF_CLIENT_ID &&
                !IS_CLONE_BUBBLE &&
                inputActions &&
                typeof inputActions.insertQuote === 'function'
              ) {
                inputActions.insertQuote(String(data.quoteText || ''));
              }
            } catch {}
          });
        }

        return () => {
          if (broadcastChan) broadcastChan.removeEventListener('message', onBc);
          if (es) es.close();
        };
      }, [applyIncomingTwinState, inputActions]);

      // In ?dsh_bar_clone=1 Bubble Mode: report exact needed [DSH-BAR:WxH] via document.title (0.01ms Win32 GetWindowTextW!)
      // AND /dsh-card-dock/sync so native dropdown menus (+, 完全权限, 模型选择, /) never get clipped!
      useEffect(() => {
        if (!IS_CLONE_BUBBLE || typeof document === 'undefined') return;
        let lastTag = '';
        const updateBubbleMetrics = () => {
          const cardEl = document.querySelector('[data-composer-card]');
          const cardH = cardEl ? Math.max(84, Math.ceil(cardEl.getBoundingClientRect().height)) : 98;
          const menuEls = document.querySelectorAll(
            '[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], [data-floating-ui-portal]',
          );
          let popupOpen = false;
          for (const el of menuEls) {
            if (el instanceof HTMLElement && el.offsetWidth > 20 && el.offsetHeight > 20) {
              popupOpen = true;
              break;
            }
          }
          const slipVisibleH = isExpanded ? expandedHeight : COLLAPSED_LIP_PX;
          const popupExtraH = popupOpen ? Math.max(260, slipVisibleH) : slipVisibleH;
          const desiredH = Math.min(760, cardH + popupExtraH + 6);
          const desiredW = Math.round(
            (document.querySelector('[data-composer-card]') || { getBoundingClientRect: () => ({ width: 780 }) })
              .getBoundingClientRect().width,
          ) || 780;
          const tag = '[DSH-BAR:' + desiredW + 'x' + desiredH + ']';
          if (tag !== lastTag) {
            lastTag = tag;
            document.title = 'DeepSeek-Bar ' + tag;
            postTwinSync({
              widthPx: desiredW,
              desiredHeightPx: desiredH,
              drawerExpanded: isExpanded,
              popupOpen,
            });
          }
        };

        updateBubbleMetrics();
        const mo = new MutationObserver(updateBubbleMetrics);
        mo.observe(document.body, { childList: true, subtree: true, attributes: true });
        const iv = setInterval(updateBubbleMetrics, 120);
        return () => {
          mo.disconnect();
          clearInterval(iv);
        };
      }, [isExpanded, expandedHeight]);

      const clearCollapseTimer = () => {
        if (collapseTimerRef.current) {
          clearTimeout(collapseTimerRef.current);
          collapseTimerRef.current = null;
        }
      };

      const handleMouseEnter = (e) => {
        if (e && e.buttons !== 0) return;
        clearCollapseTimer();
        if (hoverTimerRef.current) {
          clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = null;
        }
        // 停留 0.3s 才认作"要展开"：鼠标只是划过时不会闪一下
        hoverTimerRef.current = setTimeout(() => {
          hoverTimerRef.current = null;
          setHovered(true);
        }, HOVER_EXPAND_DELAY_MS);
      };

      const handleMouseLeave = () => {
        if (hoverTimerRef.current) {
          clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = null;
        }
        if (isResizingHeightRef.current || isResizingWidthRef.current || editingName) return;
        clearCollapseTimer();
        collapseTimerRef.current = setTimeout(() => {
          setHovered(false);
        }, 160);
      };

      const togglePin = (e) => {
        e.stopPropagation();
        setPinned((prev) => {
          const next = !prev;
          try {
            localStorage.setItem(STORAGE_KEY_PINNED, next ? '1' : '0');
          } catch {}
          postTwinSync({ pinned: next });
          return next;
        });
      };

      // Top Drag Handle: vertical height resize of expanded drawer
      const handleStartResizeHeight = useCallback(
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          isResizingHeightRef.current = true;
          const startY = e.clientY;
          const startH = expandedHeight;

          const onMove = (moveEv) => {
            const deltaY = startY - moveEv.clientY;
            const nextH = Math.max(
              MIN_EXPANDED_PX,
              Math.min(MAX_EXPANDED_PX, Math.round(startH + deltaY)),
            );
            setExpandedHeight(nextH);
          };

          const onUp = (upEv) => {
            isResizingHeightRef.current = false;
            const deltaY = startY - upEv.clientY;
            const finalH = Math.max(
              MIN_EXPANDED_PX,
              Math.min(MAX_EXPANDED_PX, Math.round(startH + deltaY)),
            );
            try {
              localStorage.setItem(STORAGE_KEY_HEIGHT, String(finalH));
            } catch {}
            postTwinSync({ expandedHeightPx: finalH });
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };

          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        },
        [expandedHeight],
      );

      const commitAgentName = () => {
        const trimmed = nameDraft.trim() || 'Agent';
        setAgentName(trimmed);
        setNameDraft(trimmed);
        setEditingName(false);
        try {
          localStorage.setItem(STORAGE_KEY_AGENT_NAME, trimmed);
        } catch {}
        postTwinSync({ agentName: trimmed });
      };

      const renderAgentPrefix = () => {
        if (editingName) {
          return h('input', {
            type: 'text',
            autoFocus: true,
            value: nameDraft,
            onChange: (ev) => setNameDraft(ev.target.value),
            onBlur: commitAgentName,
            onKeyDown: (ev) => {
              if (ev.key === 'Enter') commitAgentName();
              if (ev.key === 'Escape') {
                setNameDraft(agentName);
                setEditingName(false);
              }
            },
            onClick: (ev) => ev.stopPropagation(),
            style: {
              width: Math.max(54, nameDraft.length * 10 + 18) + 'px',
              background: 'rgba(255,255,255,0.09)',
              color: '#f9fafb',
              border: '1px solid rgba(110,168,254,0.65)',
              borderRadius: '6px',
              padding: '1px 6px',
              fontSize: '12.5px',
              fontWeight: 600,
              outline: 'none',
            },
          });
        }
        return h(
          'span',
          {
            title: '双击修改显示名称',
            onDoubleClick: (ev) => {
              ev.stopPropagation();
              setNameDraft(agentName);
              setEditingName(true);
            },
            style: {
              fontWeight: 650,
              color: '#f9fafb',
              flexShrink: 0,
              cursor: 'text',
              userSelect: 'none',
            },
          },
          agentName + ':',
        );
      };

      if (suppressedByOtherDock) return null;

      return h(
        'div',
        {
          ref: wrapRef,
          'data-donegate-dock-wrap': '',
          onMouseEnter: handleMouseEnter,
          onMouseLeave: handleMouseLeave,
          style: {
            position: 'relative',
            width: IS_CLONE_BUBBLE
              ? '100vw'
              : matchedCardWidth
                ? matchedCardWidth + 'px'
                : '100%',
            maxWidth: IS_CLONE_BUBBLE
              ? '100vw'
              : matchedCardWidth
                ? matchedCardWidth + 'px'
                : '100%',
            marginInline: 'auto',
            // flex 父容器默认会让它收缩，导致上层卡片比输入框窄（宽度对不齐的根因）
            flexShrink: 0,
            alignSelf: 'center',
            height: COLLAPSED_LIP_PX + 'px',
            zIndex: 1,
            boxSizing: 'border-box',
            pointerEvents: 'auto',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", sans-serif',
          },
        },
        // Cardholder-Slip Card: 100% equal width & identical 24px radius, tucked TUCK_OVERLAP_PX under [data-composer-card]
        h(
          'div',
          {
            'data-dsb-card': '',
            style: {
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: -TUCK_OVERLAP_PX + 'px',
              height: (isExpanded ? expandedHeight : COLLAPSED_LIP_PX) + TUCK_OVERLAP_PX + 'px',
              paddingBottom: TUCK_OVERLAP_PX + 'px',
              // 交界处必须"直"：只圆上面两个角，下面两角为 0，避免与输入框上沿的
              // 24px 圆弧叠出双层弧线（露出来像藏了一个圆角）
              borderRadius: CARD_RADIUS_PX + 'px ' + CARD_RADIUS_PX + 'px 0 0',
              background: 'var(--dsw-alias-bg-layer-2, #2c2c2e)',
              boxShadow: isExpanded
                ? '0 0 0 0.5px rgba(255, 255, 255, 0.14), 0 -14px 36px rgba(0, 0, 0, 0.42)'
                : '0 0 0 0.5px rgba(255, 255, 255, 0.10)',
              color: '#f3f4f6',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              boxSizing: 'border-box',
              transition: isResizingHeightRef.current
                ? 'none'
                : 'height 0.22s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.2s ease',
            },
          },
          isExpanded
            ? [
                // Top Resize Grip Bar + Pin Button
                h(
                  'div',
                  {
                    key: 'grip-header',
                    onMouseDown: handleStartResizeHeight,
                    title: '上下拖拽调节消息抽屉高度',
                    style: {
                      height: '28px',
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0 14px',
                      cursor: 'ns-resize',
                      borderBottom: '1px solid rgba(255,255,255,0.06)',
                      userSelect: 'none',
                    },
                  },
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '11.5px',
                        color: '#9ca3af',
                      },
                    },
                    renderAgentPrefix(),
                    h(
                      'span',
                      null,
                      '实时对话记录 (' +
                        entries.length +
                        ')' +
                        (IS_CLONE_BUBBLE ? ' · 主窗口分身同步中' : ''),
                    ),
                  ),
                  h('div', {
                    style: {
                      width: '34px',
                      height: '4px',
                      borderRadius: '999px',
                      background: 'rgba(255,255,255,0.22)',
                    },
                  }),
                  h(
                    'div',
                    {
                      style: { display: 'flex', alignItems: 'center', gap: '6px' },
                      onMouseDown: (ev) => ev.stopPropagation(),
                    },
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: togglePin,
                        title: pinned ? '取消固定（鼠标移出自动收起）' : '固定展开聊天窗',
                        style: {
                          padding: '2px 9px',
                          borderRadius: '999px',
                          border: pinned
                            ? '1px solid rgba(255,255,255,0.3)'
                            : '1px solid rgba(255,255,255,0.12)',
                          background: pinned ? '#f9fafb' : 'rgba(255,255,255,0.06)',
                          color: pinned ? '#18181b' : '#d1d5db',
                          fontSize: '11px',
                          fontWeight: 600,
                          cursor: 'pointer',
                        },
                      },
                      pinned ? '已固定' : '固定',
                    ),
                  ),
                ),

                // Scrollable Chat History Body
                h(
                  'div',
                  {
                    key: 'history-scroll',
                    ref: scrollRef,
                    'data-dg-scroll': '',
                    style: {
                      flex: 1,
                      minHeight: 0,
                      overflowY: 'auto',
                      padding: '12px 16px 14px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '12px',
                    },
                  },
                  entries.length === 0
                    ? h(
                        'div',
                        {
                          style: {
                            color: '#81858c',
                            fontSize: '12.5px',
                            textAlign: 'center',
                            padding: '28px 12px',
                          },
                        },
                        '暂无历史消息 — 在下方原版输入框发消息后，对话流将在此实时展开',
                      )
                    : entries.map((item) => {
                        const isUser = item.role === 'user';
                        return h(
                          'div',
                          {
                            key: item.id,
                            style: {
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: isUser ? 'flex-end' : 'flex-start',
                              gap: '4px',
                            },
                          },
                          isUser
                            ? h(
                                'div',
                                {
                                  style: {
                                    maxWidth: '84%',
                                    padding: '7px 12px',
                                    borderRadius: '14px',
                                    background: '#323236',
                                    color: '#f9fafb',
                                    fontSize: '13px',
                                    lineHeight: 1.5,
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                  },
                                },
                                item.text,
                              )
                            : h(
                                'div',
                                {
                                  style: {
                                    width: '100%',
                                    color: '#e5e7eb',
                                    fontSize: '13px',
                                    lineHeight: 1.58,
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                  },
                                },
                                h(
                                  'span',
                                  {
                                    style: {
                                      fontWeight: 650,
                                      color: '#f9fafb',
                                      marginRight: '6px',
                                    },
                                  },
                                  agentName + ':',
                                ),
                                item.text,
                                item.streaming
                                  ? h(
                                      'span',
                                      {
                                        style: {
                                          marginLeft: '6px',
                                          color: '#6ea8fe',
                                          fontSize: '11.5px',
                                        },
                                      },
                                      '● 生成中…',
                                    )
                                  : null,
                              ),
                        );
                      }),
                ),
              ]
            : // Collapsed 36px Cardholder Lip
              h(
                'div',
                {
                  key: 'collapsed-lip',
                  onClick: () => {
                    if (!editingName) setHovered(true);
                  },
                  style: {
                    height: COLLAPSED_LIP_PX + 'px',
                    padding: '0 18px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '7px',
                    fontSize: '13px',
                    lineHeight: '20px',
                    cursor: 'pointer',
                    overflow: 'hidden',
                  },
                },
                renderAgentPrefix(),
                h(
                  'div',
                  {
                    ref: lipViewportRef,
                    'data-dg-msg-pop': '',
                    style: {
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      color: latestSingleLine ? '#cfd3d6' : '#81858c',
                    },
                  },
                  h(
                    'span',
                    {
                      ref: lipTextRef,
                      'data-dg-line': '',
                    },
                    latestSingleLine || '鼠标移入展开对话记录 · 拖拽两侧竖条调聊天区宽度',
                  ),
                ),
              ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx && ctx.slots;
        if (!slots) return;

        if (typeof slots.inject === 'function') {
          slots.inject('conversation.input.dock', () =>
            slots.register(
              {
                name: 'conversation.input.dock',
                id: 'dsh-card-dock-slip',
                order: 6,
              },
              CardholderSlipDock,
            ),
          );
        } else if (typeof slots.register === 'function') {
          slots.register(
            {
              name: 'conversation.input.dock',
              id: 'dsh-card-dock-slip',
              order: 6,
            },
            CardholderSlipDock,
          );
        }
      },
    };
  },
});
