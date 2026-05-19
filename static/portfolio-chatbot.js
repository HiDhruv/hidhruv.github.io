(function () {
  "use strict";

  const SCRIPT = document.currentScript;
  const SCRIPT_URL = new URL(SCRIPT && SCRIPT.src ? SCRIPT.src : window.location.href);
  const BASE_URL = SCRIPT_URL.origin;
  const BACKEND_URL = (SCRIPT && SCRIPT.dataset.backendUrl)
    ? new URL(SCRIPT.dataset.backendUrl, window.location.href).origin
    : BASE_URL;
  const OWNER_NAME = (SCRIPT && SCRIPT.dataset.owner) || "Dhruv Rastogi";
  const BOT_NAME = (SCRIPT && SCRIPT.dataset.botName) || "Dhruv's AI";
  const MODEL = (SCRIPT && SCRIPT.dataset.model) || "gemini-live-2.5-flash-native-audio";
  const VOICE = (SCRIPT && SCRIPT.dataset.voice) || "Puck";
  const VAD_THRESHOLD = 0.022;
  const SILENCE_MS = 1100;
  const CAPTURE_FRAMES = 1024;
  const MAX_CONTEXT_CHARS = 9000;
  const RESPONSE_WATCHDOG_MS = 18000;
  const VOICE_SESSION_LIMIT_MS = 3 * 60 * 1000;
  const DEBUG_BUILD = "portfolio-chat-widget-v21";
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const GOODBYE_REPLY = "Bye, I am closing now. It was nice talking to you.";

  const state = {
    open: false,
    connecting: false,
    connected: false,
    ws: null,
    connectPromise: null,
    audioCtx: null,
    playCtx: null,
    stream: null,
    processor: null,
    silentSink: null,
    captureSampleRate: 16000,
    listening: false,
    speaking: false,
    awaiting: false,
    replyStreamComplete: true,
    speechActive: false,
    lastSpeechAt: 0,
    turnStartedAt: 0,
    audioTurn: 0,
    activeSources: new Set(),
    nextPlayAt: 0,
    currentAssistant: null,
    assistantBuffer: "",
    currentUser: null,
    userBuffer: "",
    responseTimer: null,
    voiceSessionTimer: null,
    voiceSessionStartedAt: 0,
    lifecycleCleanupWired: false,
    sawAssistantResponse: false,
    sawUserTranscript: false,
    avatar: null,
    avatarControls: null,
    welcomedFromAvatar: false,
    recognition: null,
    recognitionActive: false,
    recognitionStopRequested: false,
    recognitionFinalText: "",
    voiceKeepPanelClosed: false,
    voiceSessionActive: false,
    micStarting: false,
    autoListenAfterAssistantReply: false,
    permissionPrimed: false,
    closeAfterAssistantReply: false,
    suppressInputTranscript: false,
    suppressAssistantTranscript: false,
    pageContext: "",
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeText(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    }[char]));
  }

  function wsUrl() {
    const url = new URL("/ws", BACKEND_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        if (window.createVirtualAssistantAvatar) {
          resolve();
        }
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  function collectPageContext() {
    const meta = Array.from(document.querySelectorAll(
      "meta[name='description'], meta[property='og:description']"
    ))
      .map((node) => node.getAttribute("content"))
      .filter(Boolean);

    const clone = document.body ? document.body.cloneNode(true) : document.createElement("body");
    clone.querySelectorAll(
      "script, style, noscript, svg, canvas, iframe, .portfolio-chat-widget, #virtual-assistant-root"
    ).forEach((node) => node.remove());

    const text = [
      `Page title: ${document.title}`,
      ...meta.map((item) => `Page description: ${item}`),
      clone.innerText || "",
    ]
      .join("\n")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return text.slice(0, MAX_CONTEXT_CHARS);
  }

  function systemPrompt() {
    const context = state.pageContext || "No visible portfolio text was captured from this page.";
    return [
      `You are ${BOT_NAME}, a concise chatbot embedded on ${OWNER_NAME}'s portfolio website.`,
      `Help visitors learn about ${OWNER_NAME}, their projects, skills, background, and ways to contact them.`,
      "Use the website content below as your primary source of truth. If a visitor asks about something not present in the content, say you do not see that detail on the portfolio page instead of inventing it.",
      "Keep replies natural and short. For voice replies, prefer one to three sentences.",
      "",
      "Captured portfolio website content:",
      context,
    ].join("\n");
  }

  function injectStyles() {
    if (byId("portfolio-chatbot-style")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "portfolio-chatbot-style";
    style.textContent = `
      .portfolio-chat-widget {
        --pcw-bg: rgba(15, 18, 28, 0.96);
        --pcw-panel: rgba(24, 27, 40, 0.98);
        --pcw-line: rgba(255, 255, 255, 0.12);
        --pcw-text: #f7f8ff;
        --pcw-muted: #aab2c8;
        --pcw-accent: #d269ff;
        --pcw-accent-2: #9a6cff;
        --pcw-user: #e7d7ff;
        position: fixed;
        right: 24px;
        bottom: 104px;
        z-index: 2147483000;
        width: min(390px, calc(100vw - 32px));
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--pcw-text);
        pointer-events: none;
        line-height: normal;
      }

      .portfolio-chat-widget,
      .portfolio-chat-widget *,
      .pcw-launcher,
      .pcw-launcher * {
        box-sizing: border-box;
      }

      .pcw-panel {
        display: none;
        width: 100%;
        min-width: 0;
        max-height: calc(100vh - 128px);
        margin: 0;
        padding: 0;
        position: relative;
        overflow: hidden;
        pointer-events: auto;
        background: var(--pcw-bg);
        border: 1px solid var(--pcw-line);
        border-radius: 8px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(18px);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--pcw-text);
      }

      .portfolio-chat-widget[data-open="true"] .pcw-panel {
        display: block;
      }

      .pcw-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--pcw-line);
        background: rgba(255, 255, 255, 0.04);
      }

      .pcw-title {
        min-width: 0;
      }

      .pcw-title strong {
        display: block;
        font-size: 14px;
        font-weight: 650;
      }

      .pcw-status {
        margin-top: 2px;
        color: var(--pcw-muted);
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .pcw-icon-button {
        width: 36px;
        height: 36px;
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--pcw-line);
        border-radius: 50%;
        color: var(--pcw-text);
        background: rgba(255, 255, 255, 0.06);
        cursor: pointer;
        position: relative;
        transition: background 160ms ease, transform 160ms ease, border-color 160ms ease;
      }

      .pcw-icon-button:hover {
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.22);
      }

      .pcw-icon-button:active {
        transform: scale(0.94);
      }

      .pcw-icon-button[data-active="true"] {
        color: #251132;
        border-color: transparent;
        background: linear-gradient(135deg, var(--pcw-accent), var(--pcw-accent-2));
      }

      #pcw-close {
        color: #ff6b6b;
        border-color: rgba(255, 107, 107, 0.34);
        background: rgba(255, 107, 107, 0.08);
      }

      #pcw-close:hover {
        color: #fff;
        border-color: rgba(255, 107, 107, 0.72);
        background: rgba(255, 72, 72, 0.22);
      }

      .pcw-icon-button[data-loading="true"],
      .pcw-avatar-control[data-loading="true"] {
        cursor: wait;
      }

      .pcw-icon-button[data-loading="true"] svg,
      .pcw-avatar-control[data-loading="true"] svg {
        opacity: 0;
      }

      .pcw-icon-button[data-loading="true"]::after,
      .pcw-avatar-control[data-loading="true"]::after {
        position: absolute;
        width: 17px;
        height: 17px;
        content: "";
        border-radius: 50%;
        border: 2px solid currentColor;
        border-right-color: transparent;
        animation: pcw-spin 780ms linear infinite;
      }

      .pcw-messages {
        height: min(390px, 54vh);
        min-height: 220px;
        overflow: auto;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .pcw-message {
        width: fit-content;
        max-width: min(86%, 300px);
        min-width: 0;
        border-radius: 8px;
        padding: 10px 11px;
        font-size: 14px;
        line-height: 1.45;
        overflow-wrap: break-word;
        word-break: normal;
      }

      .pcw-message.bot {
        align-self: flex-start;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid var(--pcw-line);
      }

      .pcw-message.user {
        align-self: flex-end;
        color: #1c1230;
        background: var(--pcw-user);
      }

      .pcw-message.system {
        align-self: center;
        max-width: 100%;
        color: var(--pcw-muted);
        background: transparent;
        padding: 2px 4px;
        font-size: 12px;
      }

      .pcw-composer {
        border-top: 1px solid var(--pcw-line);
        padding: 10px;
        display: grid;
        grid-template-columns: 40px minmax(0, 1fr) 40px;
        gap: 8px;
        align-items: center;
        background: rgba(0, 0, 0, 0.14);
        margin: 0;
      }

      .pcw-input {
        min-width: 0;
        width: 100%;
        height: 40px;
        min-height: 40px;
        margin: 0;
        padding: 0 12px;
        border: 1px solid var(--pcw-line);
        border-radius: 8px;
        color: var(--pcw-text);
        background: rgba(255, 255, 255, 0.06);
        font: inherit;
        outline: none;
      }

      .pcw-input:focus {
        border-color: rgba(210, 105, 255, 0.7);
      }

      .pcw-level {
        grid-column: 1 / -1;
        height: 4px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
      }

      .pcw-level span {
        display: block;
        width: 0%;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, var(--pcw-accent-2), var(--pcw-accent));
        transition: width 70ms linear;
      }

      .pcw-launcher {
        pointer-events: auto;
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 2147483001;
        min-width: 138px;
        height: 48px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 999px;
        color: #fff;
        background: rgba(34, 17, 54, 0.88);
        box-shadow: 0 18px 42px rgba(0, 0, 0, 0.28);
        backdrop-filter: blur(16px);
        cursor: pointer;
        font: 650 14px/1 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 0 16px;
        margin: 0;
      }

      .pcw-launcher svg,
      .pcw-icon-button svg {
        width: 19px;
        height: 19px;
      }

      .pcw-avatar-controls {
        position: fixed;
        right: 74px;
        bottom: 92px;
        z-index: 2147483002;
        display: none;
        grid-template-columns: repeat(3, 38px);
        gap: 8px;
        pointer-events: auto;
      }

      .pcw-avatar-controls[data-visible="true"] {
        display: grid;
      }

      .pcw-avatar-status {
        grid-column: 1 / -1;
        justify-self: end;
        display: none;
        align-items: center;
        gap: 7px;
        max-width: 150px;
        padding: 7px 11px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 999px;
        color: #fff;
        background: rgba(18, 11, 31, 0.88);
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.24);
        backdrop-filter: blur(16px);
        font: 650 12px/1 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        white-space: nowrap;
      }

      .pcw-avatar-controls[data-status-visible="true"] .pcw-avatar-status {
        display: inline-flex;
      }

      .pcw-avatar-status::before {
        width: 7px;
        height: 7px;
        flex: 0 0 auto;
        content: "";
        border-radius: 50%;
        background: var(--pcw-accent);
        box-shadow: 0 0 12px rgba(210, 105, 255, 0.65);
        animation: pcw-status-pulse 950ms ease-in-out infinite;
      }

      .pcw-avatar-control {
        width: 38px;
        height: 38px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.16);
        color: #fff;
        background: rgba(34, 17, 54, 0.86);
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.26);
        backdrop-filter: blur(16px);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        position: relative;
        transition: background 160ms ease, transform 160ms ease, border-color 160ms ease;
      }

      .pcw-avatar-control:hover {
        background: rgba(83, 42, 124, 0.92);
        border-color: rgba(255, 255, 255, 0.28);
      }

      .pcw-avatar-control:active {
        transform: scale(0.94);
      }

      .pcw-avatar-control[data-active="true"] {
        color: #251132;
        border-color: transparent;
        background: linear-gradient(135deg, var(--pcw-accent), var(--pcw-accent-2));
      }

      #pcw-avatar-stop {
        color: #ff8a8a;
        border-color: rgba(255, 107, 107, 0.42);
        background: rgba(255, 72, 72, 0.14);
      }

      #pcw-avatar-stop:hover {
        color: #fff;
        border-color: rgba(255, 107, 107, 0.82);
        background: rgba(255, 72, 72, 0.28);
        box-shadow: 0 14px 34px rgba(255, 72, 72, 0.2);
      }

      .pcw-avatar-control svg {
        width: 18px;
        height: 18px;
      }

      #virtual-assistant-root {
        z-index: 2147482999 !important;
        bottom: 78px !important;
        right: 18px !important;
      }

      @keyframes pcw-spin {
        to { transform: rotate(360deg); }
      }

      @keyframes pcw-status-pulse {
        0%, 100% { opacity: 0.45; transform: scale(0.82); }
        50% { opacity: 1; transform: scale(1); }
      }

      @media (max-width: 640px) {
        .portfolio-chat-widget {
          right: 12px;
          bottom: 86px;
          width: calc(100vw - 24px);
        }

        .pcw-messages {
          height: min(390px, 58vh);
        }

        .pcw-launcher {
          right: 16px;
          bottom: 16px;
        }

        .pcw-avatar-controls {
          right: 70px;
          bottom: 84px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function icon(name) {
    const icons = {
      message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>',
      x: '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>',
      mic: '<rect x="9" y="2.5" width="6" height="11" rx="3"></rect><path d="M5.5 10.5a6.5 6.5 0 0 0 13 0"></path><path d="M12 17v4"></path><path d="M8.5 21h7"></path>',
      send: '<path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path>',
      stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"></rect>',
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ""}</svg>`;
  }

  function buildWidget() {
    if (byId("portfolio-chat-widget")) {
      return;
    }

    const launcher = document.createElement("button");
    launcher.id = "pcw-launcher";
    launcher.className = "pcw-launcher";
    launcher.type = "button";
    launcher.innerHTML = `${icon("message")} Ask ${escapeText(OWNER_NAME.split(" ")[0] || "me")}`;
    launcher.addEventListener("click", () => toggleWidget(true));

    const root = document.createElement("div");
    root.id = "portfolio-chat-widget";
    root.className = "portfolio-chat-widget";
    root.dataset.open = "false";
    root.innerHTML = `
      <div class="pcw-panel" role="dialog" aria-label="${escapeText(BOT_NAME)} chat">
        <header class="pcw-header">
          <div class="pcw-title">
            <strong>${escapeText(BOT_NAME)}</strong>
            <div class="pcw-status" id="pcw-status">Ready when you are</div>
          </div>
          <button class="pcw-icon-button" id="pcw-close" type="button" aria-label="Close chat" title="Close chat">
            ${icon("x")}
          </button>
        </header>
        <div class="pcw-messages" id="pcw-messages">
          <div class="pcw-message bot">Hi, I can answer questions about ${escapeText(OWNER_NAME)}. Type a question or use the mic.</div>
        </div>
        <div class="pcw-composer">
          <button class="pcw-icon-button" id="pcw-mic" type="button" aria-label="Talk" title="Talk">${icon("mic")}</button>
          <input class="pcw-input" id="pcw-input" type="text" autocomplete="off" placeholder="Ask about projects, skills, or contact" />
          <button class="pcw-icon-button" id="pcw-send" type="button" aria-label="Send" title="Send">${icon("send")}</button>
          <div class="pcw-level" aria-hidden="true"><span id="pcw-level"></span></div>
        </div>
      </div>
    `;

    document.body.appendChild(root);
    document.body.appendChild(launcher);

    byId("pcw-close").addEventListener("click", () => toggleWidget(false));
    byId("pcw-send").addEventListener("click", sendTypedMessage);
    byId("pcw-mic").addEventListener("click", toggleMic);
    byId("pcw-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendTypedMessage();
      }
    });
  }

  function buildAvatarControls() {
    if (byId("pcw-avatar-controls")) {
      state.avatarControls = byId("pcw-avatar-controls");
      return;
    }

    const controls = document.createElement("div");
    controls.id = "pcw-avatar-controls";
    controls.className = "pcw-avatar-controls";
    controls.dataset.visible = "false";
    controls.dataset.statusVisible = "false";
    controls.innerHTML = `
      <div class="pcw-avatar-status" id="pcw-avatar-status" aria-live="polite"></div>
      <button class="pcw-avatar-control" id="pcw-avatar-chat" type="button" aria-label="Open chat" title="Open chat">${icon("message")}</button>
      <button class="pcw-avatar-control" id="pcw-avatar-mic" type="button" aria-label="Talk" title="Talk">${icon("mic")}</button>
      <button class="pcw-avatar-control" id="pcw-avatar-stop" type="button" aria-label="Stop" title="Stop">${icon("stop")}</button>
    `;
    document.body.appendChild(controls);
    state.avatarControls = controls;

    byId("pcw-avatar-chat").addEventListener("click", () => toggleWidget(true));
    byId("pcw-avatar-mic").addEventListener("click", () => toggleMic({ keepPanelClosed: true }));
    byId("pcw-avatar-stop").addEventListener("click", stopAssistantActivity);
  }

  function avatarIsOpen() {
    const avatarRoot = byId("virtual-assistant-root");
    return Boolean(
      state.avatar
      && !state.avatar.isCollapsed
      && !state.open
      && (!avatarRoot || avatarRoot.style.display !== "none")
    );
  }

  function setAvatarShellHidden(hidden) {
    const avatarRoot = byId("virtual-assistant-root");
    if (avatarRoot) {
      avatarRoot.style.display = hidden ? "none" : "";
    }
  }

  function setChatPanelVisible(isVisible) {
    const root = byId("portfolio-chat-widget");
    const launcher = byId("pcw-launcher");
    if (root) {
      root.dataset.open = isVisible ? "true" : "false";
    }
    if (launcher) {
      launcher.style.display = isVisible ? "none" : "inline-flex";
    }
  }

  function closeChatForAvatar() {
    state.open = false;
    setChatPanelVisible(false);
    setAvatarShellHidden(false);
  }

  async function prepareMicForAvatarSession() {
    if (state.listening || state.recognitionActive) {
      return;
    }
    state.voiceKeepPanelClosed = true;
    state.voiceSessionActive = true;
    state.autoListenAfterAssistantReply = true;
    startVoiceSessionTimer();
    closeChatForAvatar();
    if (state.avatar) {
      state.avatar.show();
    }
    setMicLoading(true);
    setStatus("Preparing microphone...");
    syncAvatarControls();

    try {
      await requestMicrophonePermission();
      state.permissionPrimed = true;
      if (!state.awaiting && !state.speaking) {
        await startVoiceRecognition({ skipPermission: true, keepPanelClosed: true });
      } else {
        setMicLoading(false);
        syncAvatarControls();
      }
    } catch (error) {
      state.autoListenAfterAssistantReply = false;
      state.permissionPrimed = false;
      setMicLoading(false);
      setStatus("Mic permission needed");
      const name = error && error.name ? error.name : "";
      const message = name === "NotAllowedError" || name === "SecurityError"
        ? "Microphone permission was blocked. Allow mic access or type your question."
        : error.message || "Microphone permission failed.";
      addMessage("system", message);
      syncAvatarControls();
    }
  }

  function setMicLoading(isLoading) {
    state.micStarting = Boolean(isLoading);
    [byId("pcw-mic"), byId("pcw-avatar-mic")].forEach((button) => {
      if (!button) {
        return;
      }
      button.dataset.loading = state.micStarting ? "true" : "false";
      button.setAttribute("aria-busy", state.micStarting ? "true" : "false");
    });
  }

  function avatarActivityLabel() {
    if (state.micStarting) {
      return "Preparing mic...";
    }
    if (state.listening) {
      return "Listening...";
    }
    if (state.awaiting) {
      return state.closeAfterAssistantReply ? "Closing..." : "Thinking...";
    }
    if (state.speaking) {
      return "Speaking...";
    }
    return "";
  }

  function syncAvatarControls() {
    const controls = state.avatarControls || byId("pcw-avatar-controls");
    if (!controls) {
      return;
    }
    const visible = avatarIsOpen();
    controls.dataset.visible = visible ? "true" : "false";
    const status = byId("pcw-avatar-status");
    const statusText = visible ? avatarActivityLabel() : "";
    controls.dataset.statusVisible = statusText ? "true" : "false";
    if (status) {
      status.textContent = statusText;
      status.setAttribute("aria-hidden", statusText ? "false" : "true");
    }
    const mic = byId("pcw-avatar-mic");
    if (mic) {
      mic.dataset.active = state.listening ? "true" : "false";
      mic.dataset.loading = state.micStarting ? "true" : "false";
      mic.setAttribute("aria-busy", state.micStarting ? "true" : "false");
    }
  }

  function hideAvatarControls() {
    const controls = state.avatarControls || byId("pcw-avatar-controls");
    if (!controls) {
      return;
    }
    controls.dataset.visible = "false";
    controls.dataset.statusVisible = "false";
    const status = byId("pcw-avatar-status");
    if (status) {
      status.textContent = "";
      status.setAttribute("aria-hidden", "true");
    }
  }

  function speakBrowserLine(text, options = {}) {
    const onDone = typeof options.onDone === "function" ? options.onDone : null;
    if (!("speechSynthesis" in window) || !window.SpeechSynthesisUtterance) {
      if (onDone) {
        window.setTimeout(onDone, 700);
      }
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.pitch = 1.03;
      utterance.onstart = () => {
        state.speaking = true;
        if (state.avatar) {
          state.avatar.setMode("speaking");
        }
      };
      utterance.onend = () => {
        state.speaking = false;
        if (onDone) {
          onDone();
        } else {
          showListeningOrReady();
        }
        syncAvatarControls();
      };
      utterance.onerror = () => {
        state.speaking = false;
        if (onDone) {
          onDone();
        } else {
          showListeningOrReady();
        }
        syncAvatarControls();
      };
      window.speechSynthesis.speak(utterance);
    } catch {
      if (onDone) {
        window.setTimeout(onDone, 700);
      }
    }
  }

  function speakBrowserGreeting(text) {
    speakBrowserLine(text);
  }

  function greetFromAvatar() {
    if (state.welcomedFromAvatar) {
      return;
    }
    state.welcomedFromAvatar = true;
    const greeting = `Hi, I am ${BOT_NAME}. You can ask me about ${OWNER_NAME}'s projects, skills, or contact details.`;
    speakWithAssistantVoice(greeting, { keepPanelClosed: true });
  }

  function wireAvatarToggle() {
    const toggle = document.querySelector("#virtual-assistant-root .va-toggle");
    if (!toggle || toggle.dataset.pcwWired === "true") {
      return;
    }
    toggle.dataset.pcwWired = "true";
    toggle.addEventListener("click", () => {
      setTimeout(() => {
        if (avatarIsOpen()) {
          closeChatForAvatar();
          greetFromAvatar();
          prepareMicForAvatarSession();
        }
        syncAvatarControls();
      }, 0);
    });
  }

  function isGoodbyeIntent(text) {
    const normalized = String(text || "")
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) {
      return false;
    }
    return /^(ok\s+|okay\s+|alright\s+|thanks\s+|thank\s+you\s+|that'?s\s+all\s+)*(bye|goodbye|good bye|see you|talk to you later|later)(\s+(now|then|thanks|thank you|dhruv|bot|ai))*$/.test(normalized);
  }

  function closeConversationUi() {
    state.open = false;
    state.awaiting = false;
    state.speaking = false;
    state.listening = false;
    state.voiceKeepPanelClosed = false;
    state.voiceSessionActive = false;
    state.autoListenAfterAssistantReply = false;
    state.closeAfterAssistantReply = false;
    state.suppressInputTranscript = false;
    state.suppressAssistantTranscript = false;
    clearVoiceSessionTimer();
    clearResponseWatchdog();
    closeBackendSocket("portfolio conversation closed");
    const root = byId("portfolio-chat-widget");
    const launcher = byId("pcw-launcher");
    if (root) {
      root.dataset.open = "false";
    }
    if (launcher) {
      launcher.style.display = "inline-flex";
    }
    setAvatarShellHidden(false);
    setStatus("Ready");
    if (state.avatar) {
      state.avatar.setMode("idle");
      state.avatar.hide({ automatic: true });
    }
    syncAvatarControls();
    hideAvatarControls();
  }

  function handleGoodbye(cleanText, options = {}) {
    stopVoiceRecognition({ silent: true });
    stopMic();
    stopPlayback();
    clearResponseWatchdog();
    clearTurnDrafts();
    addMessage("user", cleanText);
    speakWithAssistantVoice(GOODBYE_REPLY, {
      closeAfter: true,
      keepPanelClosed: Boolean(options.keepPanelClosed),
    });
  }

  async function speakWithAssistantVoice(text, options = {}) {
    const line = String(text || "").trim();
    if (!line) {
      return;
    }

    if (options.keepPanelClosed) {
      closeChatForAvatar();
      if (state.avatar) {
        state.avatar.show();
      }
    } else {
      toggleWidget(true, { skipConnect: true });
    }

    stopVoiceRecognition({ silent: true });
    stopMic();
    stopPlayback();
    clearResponseWatchdog();
    clearTurnDrafts();
    addMessage("bot", line);
    state.awaiting = true;
    state.replyStreamComplete = true;
    state.sawAssistantResponse = true;
    state.sawUserTranscript = true;
    state.closeAfterAssistantReply = Boolean(options.closeAfter);
    state.suppressInputTranscript = true;
    state.suppressAssistantTranscript = true;
    setStatus(options.closeAfter ? "Closing..." : "Speaking...");
    if (state.avatar) {
      state.avatar.setMode("thinking");
    }
    syncAvatarControls();

    try {
      await ensureConnected();
      state.ws.send(JSON.stringify({
        type: "speak_line",
        text: line,
      }));
      scheduleResponseWatchdog();
    } catch (error) {
      state.awaiting = false;
      state.closeAfterAssistantReply = false;
      state.suppressInputTranscript = false;
      state.suppressAssistantTranscript = false;
      addMessage("system", `Could not speak: ${error.message || error}`);
      setStatus("Connection failed");
      syncAvatarControls();
    }
  }

  function toggleWidget(forceOpen, options = {}) {
    state.open = typeof forceOpen === "boolean" ? forceOpen : !state.open;
    setChatPanelVisible(state.open);
    if (state.avatar) {
      if (state.open) {
        state.voiceSessionActive = false;
        state.autoListenAfterAssistantReply = false;
        clearVoiceSessionTimer();
        if (state.listening || state.micStarting) {
          stopVoiceRecognition({ silent: true });
        }
        setMicLoading(false);
        if (!state.awaiting && !state.speaking) {
          setStatus("Ready");
        }
        state.avatar.hide({ automatic: true });
        setAvatarShellHidden(true);
      } else if (!state.speaking && !state.listening) {
        setAvatarShellHidden(false);
        state.avatar.hide({ automatic: true });
      } else {
        setAvatarShellHidden(false);
      }
    }
    if (state.open && !options.skipConnect) {
      ensureConnected().catch((error) => {
        setStatus(`Connection failed: ${error.message || error}`);
      });
      if (options.fromAvatar) {
        greetFromAvatar();
      }
      setTimeout(() => byId("pcw-input") && byId("pcw-input").focus(), 80);
    }
    syncAvatarControls();
  }

  function setStatus(text) {
    const status = byId("pcw-status");
    if (status) {
      status.textContent = text;
    }
    syncAvatarControls();
  }

  function clearResponseWatchdog() {
    if (state.responseTimer) {
      clearTimeout(state.responseTimer);
      state.responseTimer = null;
    }
  }

  function clearVoiceSessionTimer() {
    if (state.voiceSessionTimer) {
      clearTimeout(state.voiceSessionTimer);
      state.voiceSessionTimer = null;
    }
    state.voiceSessionStartedAt = 0;
  }

  function closeBackendSocket(reason = "portfolio voice session closed") {
    const ws = state.ws;
    state.ws = null;
    state.connecting = false;
    state.connected = false;
    state.connectPromise = null;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      return;
    }
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "reset_live", reason }));
      }
    } catch {}
    try {
      ws.close(1000, reason.slice(0, 120));
    } catch {}
  }

  function shutdownForPageExit(reason = "portfolio page exit") {
    stopVoiceRecognition({ silent: true });
    stopMic();
    stopPlayback();
    state.open = false;
    state.awaiting = false;
    state.speaking = false;
    state.listening = false;
    state.voiceKeepPanelClosed = false;
    state.voiceSessionActive = false;
    state.autoListenAfterAssistantReply = false;
    clearVoiceSessionTimer();
    clearResponseWatchdog();
    closeBackendSocket(reason);
  }

  function wirePageLifecycleCleanup() {
    if (state.lifecycleCleanupWired) {
      return;
    }
    state.lifecycleCleanupWired = true;
    window.addEventListener("pagehide", () => shutdownForPageExit("portfolio pagehide"));
    window.addEventListener("beforeunload", () => shutdownForPageExit("portfolio beforeunload"));
  }

  function startVoiceSessionTimer() {
    if (state.voiceSessionTimer) {
      return;
    }
    state.voiceSessionStartedAt = Date.now();
    state.voiceSessionTimer = setTimeout(() => {
      state.voiceSessionTimer = null;
      stopAssistantActivity({
        reason: "portfolio voice session 3 minute timeout",
        status: "Voice session ended after 3 minutes",
        closeSocket: true,
      });
    }, VOICE_SESSION_LIMIT_MS);
  }

  function scheduleResponseWatchdog() {
    clearResponseWatchdog();
    state.responseTimer = setTimeout(() => {
      state.responseTimer = null;
      if (!state.awaiting) {
        return;
      }

      state.awaiting = false;
      state.replyStreamComplete = true;
      const message = state.sawUserTranscript
        ? "I heard you, but the reply stalled. Please try again or type the question."
        : "I did not get a response for that turn. Please try speaking closer to the mic or type the question.";
      addMessage("system", message);
      setStatus(state.listening ? "Listening..." : "Ready");
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: "reset_live", reason: "portfolio widget response watchdog" }));
      }
      if (state.avatar) {
        state.avatar.setMode(state.listening ? "listening" : "idle");
      }
    }, RESPONSE_WATCHDOG_MS);
  }

  function setLevel(rms) {
    const level = byId("pcw-level");
    if (level) {
      level.style.width = `${Math.max(0, Math.min(100, Math.round((Number(rms) || 0) * 850)))}%`;
    }
  }

  function friendlyServiceMessage(value) {
    const message = String(value || "");
    const lowered = message.toLowerCase();
    if (lowered.includes("1006") || lowered.includes("abnormal closure")) {
      return "The voice service connection dropped for a moment. Please try sending your message again.";
    }
    return message;
  }

  function addMessage(kind, text) {
    const list = byId("pcw-messages");
    if (!list) {
      return null;
    }
    const node = document.createElement("div");
    node.className = `pcw-message ${kind}`;
    node.textContent = text;
    list.appendChild(node);
    list.scrollTop = list.scrollHeight;
    return node;
  }

  function upsertAssistant(text) {
    if (!state.currentAssistant || !state.currentAssistant.isConnected) {
      state.currentAssistant = addMessage("bot", "");
    }
    state.currentAssistant.textContent = text || "...";
    const list = byId("pcw-messages");
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }

  function upsertUser(text) {
    if (!state.currentUser || !state.currentUser.isConnected) {
      state.currentUser = addMessage("user", "");
    }
    state.currentUser.textContent = text || "...";
    const list = byId("pcw-messages");
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }

  function clearTurnDrafts() {
    state.currentAssistant = null;
    state.assistantBuffer = "";
    state.currentUser = null;
    state.userBuffer = "";
  }

  function discardCurrentUserDraft() {
    if (state.currentUser && state.currentUser.isConnected) {
      state.currentUser.remove();
    }
    state.currentUser = null;
    state.userBuffer = "";
    const list = byId("pcw-messages");
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }

  function showListeningOrReady() {
    if (state.listening) {
      setStatus("Listening...");
      if (state.avatar) {
        state.avatar.setMode("listening");
      }
      syncAvatarControls();
      return;
    }

    setStatus("Ready");
    if (state.avatar) {
      state.avatar.setMode("idle");
    }
    syncAvatarControls();
  }

  function releaseReplyIfReady() {
    if (!state.replyStreamComplete || state.activeSources.size !== 0) {
      return;
    }

    const closeAfterReply = state.closeAfterAssistantReply;
    const shouldAutoListen = state.voiceSessionActive && avatarIsOpen();
    state.awaiting = false;
    state.speaking = false;
    state.closeAfterAssistantReply = false;
    state.autoListenAfterAssistantReply = false;
    state.suppressInputTranscript = false;
    state.suppressAssistantTranscript = false;
    if (closeAfterReply) {
      state.voiceSessionActive = false;
      clearVoiceSessionTimer();
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: "reset_live", reason: "visitor said goodbye" }));
      }
      closeConversationUi();
      return;
    }
    if (shouldAutoListen) {
      state.voiceKeepPanelClosed = true;
      setMicLoading(true);
      setStatus("Preparing microphone...");
      syncAvatarControls();
      startVoiceRecognition({ skipPermission: state.permissionPrimed, keepPanelClosed: true }).catch((error) => {
        state.permissionPrimed = false;
        setMicLoading(false);
        addMessage("system", `Mic error: ${error.message || error}`);
        setStatus("Mic unavailable");
        syncAvatarControls();
      });
      return;
    }
    showListeningOrReady();
    syncAvatarControls();
  }

  function ensurePlayContext() {
    if (!state.playCtx) {
      state.playCtx = new AudioContext({ sampleRate: 24000 });
    }
    if (state.playCtx.state === "suspended") {
      state.playCtx.resume().catch(() => {});
    }
  }

  function ensureConnected() {
    if (state.connected && state.ws && state.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (state.connectPromise) {
      return state.connectPromise;
    }

    state.connecting = true;
    setStatus("Connecting...");
    state.connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl());
      state.ws = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          model: MODEL,
          voice: VOICE,
          systemPrompt: systemPrompt(),
          sessionStrategy: "recycle",
          initialGreeting: false,
          responseModalities: ["AUDIO"],
        }));
      };

      ws.onmessage = (event) => handleServerMessage(event, resolve, reject);
      ws.onerror = () => {
        state.connecting = false;
        state.connected = false;
        state.connectPromise = null;
        reject(new Error("Unable to connect to the voice backend"));
      };
      ws.onclose = () => {
        state.connecting = false;
        state.connected = false;
        state.connectPromise = null;
        if (state.open) {
          setStatus("Disconnected");
        }
      };
    });

    return state.connectPromise;
  }

  function handleServerMessage(event, resolveConnect, rejectConnect) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.type === "setupComplete") {
      state.connected = true;
      state.connecting = false;
      state.connectPromise = null;
      setStatus(`Connected (${DEBUG_BUILD})`);
      if (typeof resolveConnect === "function") {
        resolveConnect();
      }
      return;
    }

    if (data.type === "error") {
      const message = friendlyServiceMessage(data.message || "Backend error");
      setStatus(message);
      addMessage("system", message);
      if (state.connecting && typeof rejectConnect === "function") {
        state.connecting = false;
        state.connected = false;
        state.connectPromise = null;
        rejectConnect(new Error(message));
      }
      return;
    }

    if (data.type === "system" && data.message) {
      setStatus(state.listening ? "Listening..." : "Ready");
      return;
    }

    if (data.type === "audioStartAck") {
      setStatus("Listening... audio turn open");
      return;
    }

    if (data.type === "audioAck") {
      setStatus("Listening... audio received");
      return;
    }

    if (data.type === "audioEndAck") {
      setStatus("Thinking...");
      return;
    }

    if (data.turnDiagnosticMessage) {
      clearResponseWatchdog();
      state.awaiting = false;
      state.replyStreamComplete = true;
      addMessage("system", data.turnDiagnosticMessage);
      clearTurnDrafts();
      showListeningOrReady();
      return;
    }

    if (data.inputTranscript) {
      state.sawUserTranscript = true;
      if (!state.suppressInputTranscript) {
        state.userBuffer = data.inputTranscript;
        upsertUser(state.userBuffer);
      }
      setStatus("Thinking...");
      if (state.avatar) {
        state.avatar.setMode("thinking");
      }
    }

    if (data.outputTranscript) {
      state.sawAssistantResponse = true;
      clearResponseWatchdog();
      state.replyStreamComplete = false;
      if (!state.suppressAssistantTranscript) {
        state.assistantBuffer += data.outputTranscript;
        upsertAssistant(state.assistantBuffer);
      }
      setStatus("Replying...");
    } else if (data.text) {
      state.sawAssistantResponse = true;
      clearResponseWatchdog();
      state.replyStreamComplete = false;
      if (!state.suppressAssistantTranscript) {
        state.assistantBuffer += data.text;
        upsertAssistant(state.assistantBuffer);
      }
      setStatus("Replying...");
    }

    if (data.audioChunks) {
      state.awaiting = false;
      state.speaking = true;
      state.sawAssistantResponse = true;
      clearResponseWatchdog();
      state.replyStreamComplete = false;
      setStatus("Speaking...");
      ensurePlayContext();
      if (state.avatar) {
        state.avatar.show();
        state.avatar.setMode("speaking");
      }
      syncAvatarControls();
      for (const chunk of data.audioChunks) {
        if (state.avatar) {
          state.avatar.speakFromPCM(chunk.data);
        }
        playPCM(chunk.data);
      }
    }

    if (data.generationComplete || data.turnComplete || data.waitingForInput) {
      state.replyStreamComplete = true;
      if (data.turnComplete && !state.sawAssistantResponse && !state.sawUserTranscript) {
        clearResponseWatchdog();
        addMessage("system", "I did not catch that. Please speak a little closer to the mic or type your question.");
      } else if (data.turnComplete && !state.sawAssistantResponse && state.sawUserTranscript) {
        clearResponseWatchdog();
        addMessage("system", "I heard you, but the reply stalled. Please try again or type the question.");
      }
      clearTurnDrafts();
      releaseReplyIfReady();
    }
  }

  async function sendTypedMessage() {
    const input = byId("pcw-input");
    const text = input ? input.value.trim() : "";
    if (!text) {
      return;
    }
    if (input) {
      input.value = "";
    }
    sendTextMessage(text);
  }

  async function sendTextMessage(text, source = "typed", options = {}) {
    const cleanText = (text || "").trim();
    if (!cleanText) {
      return;
    }
    if (options.keepPanelClosed) {
      closeChatForAvatar();
      if (state.avatar) {
        state.avatar.show();
      }
      syncAvatarControls();
    } else {
      toggleWidget(true, { skipConnect: true });
    }
    if (source !== "voice") {
      stopVoiceRecognition({ silent: true });
    }
    stopMic();
    if (isGoodbyeIntent(cleanText)) {
      handleGoodbye(cleanText, options);
      return;
    }
    clearTurnDrafts();
    addMessage("user", cleanText);
    state.awaiting = true;
    state.replyStreamComplete = true;
    state.sawAssistantResponse = false;
    state.sawUserTranscript = true;
    setStatus("Thinking...");
    scheduleResponseWatchdog();
    if (state.avatar) {
      state.avatar.setMode("thinking");
    }
    syncAvatarControls();
    try {
      await ensureConnected();
      state.ws.send(JSON.stringify({ type: "text", text: cleanText }));
      if (source === "voice") {
        setStatus("Thinking...");
      }
    } catch (error) {
      addMessage("system", `Could not send message: ${error.message || error}`);
      setStatus("Connection failed");
    }
  }

  async function toggleMic(options = {}) {
    if (state.listening) {
      stopVoiceRecognition();
      return;
    }
    if (state.micStarting) {
      setStatus("Preparing microphone...");
      return;
    }
    state.voiceKeepPanelClosed = Boolean(options.keepPanelClosed);
    state.voiceSessionActive = state.voiceKeepPanelClosed;
    state.autoListenAfterAssistantReply = state.voiceKeepPanelClosed;
    if (state.voiceKeepPanelClosed) {
      startVoiceSessionTimer();
      closeChatForAvatar();
      if (state.avatar) {
        state.avatar.show();
      }
      syncAvatarControls();
    } else {
      toggleWidget(true, { skipConnect: true });
    }
    if ((state.awaiting || state.speaking) && state.voiceKeepPanelClosed) {
      setMicLoading(true);
      setStatus("Will listen next...");
      syncAvatarControls();
      return;
    }
    try {
      setMicLoading(true);
      setStatus("Preparing microphone...");
      syncAvatarControls();
      await startVoiceRecognition({ keepPanelClosed: state.voiceKeepPanelClosed });
    } catch (error) {
      setMicLoading(false);
      addMessage("system", `Mic error: ${error.message || error}`);
      setStatus("Mic unavailable");
      syncAvatarControls();
    }
  }

  function setupSpeechRecognition() {
    if (!SpeechRecognition) {
      addMessage("system", "Voice input is not supported in this browser. Please type your question.");
      return false;
    }
    if (state.recognition) {
      return true;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setMicLoading(false);
      state.recognitionActive = true;
      state.recognitionStopRequested = false;
      state.recognitionFinalText = "";
      state.listening = true;
      setStatus("Listening...");
      byId("pcw-mic").dataset.active = "true";
      if (byId("pcw-avatar-mic")) {
        byId("pcw-avatar-mic").dataset.active = "true";
      }
      if (state.avatar) {
        state.avatar.show();
        state.avatar.setMode("listening");
      }
      if (!state.voiceKeepPanelClosed) {
        upsertUser("Listening...");
      }
      syncAvatarControls();
    };

    recognition.onresult = (event) => {
      let interim = "";
      let finalText = state.recognitionFinalText;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript || "";
        if (event.results[i].isFinal) {
          finalText += transcript;
        } else {
          interim += transcript;
        }
      }
      state.recognitionFinalText = finalText;
      const visibleText = `${state.recognitionFinalText} ${interim}`.trim();
      if (visibleText && !state.voiceKeepPanelClosed) {
        upsertUser(visibleText);
      }
    };

    recognition.onerror = (event) => {
      setMicLoading(false);
      const code = event.error || "unknown";
      state.recognitionActive = false;
      state.listening = false;
      setStatus("Ready");
      if (code === "no-speech") {
        discardCurrentUserDraft();
      }
      if (state.voiceKeepPanelClosed && code === "no-speech") {
        setStatus("Ready");
      } else {
        addMessage("system", code === "not-allowed"
          ? "Microphone permission was blocked. Allow mic access or type your question."
          : code === "no-speech"
            ? "I did not hear speech. Tap the mic and try again, or type your question."
            : `Voice input failed: ${code}.`);
      }
      stopVoiceRecognition({ silent: true });
      showListeningOrReady();
    };

    recognition.onend = () => {
      setMicLoading(false);
      const finalText = state.recognitionFinalText.trim();
      state.recognitionActive = false;
      state.listening = false;
      const mic = byId("pcw-mic");
      if (mic) {
        mic.dataset.active = "false";
      }
      if (byId("pcw-avatar-mic")) {
        byId("pcw-avatar-mic").dataset.active = "false";
      }
      syncAvatarControls();
      if (finalText && !state.recognitionStopRequested) {
        discardCurrentUserDraft();
        sendTextMessage(finalText, "voice", { keepPanelClosed: state.voiceKeepPanelClosed });
        state.voiceKeepPanelClosed = false;
        return;
      }
      discardCurrentUserDraft();
      state.voiceKeepPanelClosed = false;
      if (!state.awaiting && !state.speaking) {
        showListeningOrReady();
      }
    };

    state.recognition = recognition;
    return true;
  }

  async function requestMicrophonePermission() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Microphone permission is not available in this browser. Please type your question.");
    }

    if (navigator.permissions && navigator.permissions.query) {
      try {
        const permission = await navigator.permissions.query({ name: "microphone" });
        if (permission.state === "denied") {
          throw new Error("Microphone permission is blocked. Allow mic access in browser settings, then try again.");
        }
      } catch (error) {
        if (error && error.message && error.message.includes("blocked")) {
          throw error;
        }
      }
    }

    setStatus("Allow microphone access");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    stream.getTracks().forEach((track) => track.stop());
    state.permissionPrimed = true;
  }

  async function startVoiceRecognition(options = {}) {
    if (options.keepPanelClosed) {
      state.voiceKeepPanelClosed = true;
      closeChatForAvatar();
      if (state.avatar) {
        state.avatar.show();
      }
      syncAvatarControls();
    }
    if (state.awaiting || state.speaking) {
      setMicLoading(false);
      setStatus("Wait for reply");
      return;
    }
    if (state.recognitionActive) {
      setMicLoading(false);
      setStatus("Listening...");
      return;
    }
    if (!setupSpeechRecognition()) {
      setMicLoading(false);
      return;
    }
    try {
      if (!options.skipPermission) {
        await requestMicrophonePermission();
      }
      state.recognitionStopRequested = false;
      state.recognition.start();
    } catch (error) {
      setMicLoading(false);
      state.voiceKeepPanelClosed = false;
      state.autoListenAfterAssistantReply = false;
      state.permissionPrimed = false;
      setStatus("Mic permission needed");
      syncAvatarControls();
      const name = error && error.name ? error.name : "";
      const message = name === "NotAllowedError" || name === "SecurityError"
        ? "Microphone permission was blocked. Allow mic access or type your question."
        : error.message || "Microphone permission failed.";
      addMessage("system", message);
    }
  }

  function stopVoiceRecognition(options = {}) {
    if (!state.recognition) {
      state.voiceSessionActive = false;
      state.autoListenAfterAssistantReply = false;
      setMicLoading(false);
      return;
    }
    state.recognitionStopRequested = true;
    try {
      state.recognition.stop();
    } catch {}
    state.voiceKeepPanelClosed = false;
    state.voiceSessionActive = false;
    state.autoListenAfterAssistantReply = false;
    setMicLoading(false);
    state.recognitionActive = false;
    state.listening = false;
    const mic = byId("pcw-mic");
    if (mic) {
      mic.dataset.active = "false";
    }
    if (byId("pcw-avatar-mic")) {
      byId("pcw-avatar-mic").dataset.active = "false";
    }
    if (!options.silent) {
      showListeningOrReady();
    }
    syncAvatarControls();
  }

  async function startMic() {
    ensurePlayContext();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Microphone access is not available in this browser");
    }
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    state.audioCtx = new AudioContext({ sampleRate: 16000 });
    await state.audioCtx.resume();
    state.captureSampleRate = state.audioCtx.sampleRate;
    const source = state.audioCtx.createMediaStreamSource(state.stream);
    state.processor = state.audioCtx.createScriptProcessor(CAPTURE_FRAMES, 1, 1);
    state.silentSink = state.audioCtx.createGain();
    state.silentSink.gain.value = 0;
    source.connect(state.processor);
    state.processor.connect(state.silentSink);
    state.silentSink.connect(state.audioCtx.destination);
    state.processor.onaudioprocess = onAudioProcess;
    state.listening = true;
    state.speechActive = false;
    state.lastSpeechAt = 0;
    setStatus("Listening...");
    byId("pcw-mic").dataset.active = "true";
    if (state.avatar) {
      state.avatar.show();
      state.avatar.setMode("listening");
    }
    syncAvatarControls();
  }

  function onAudioProcess(event) {
    const samples = event.inputBuffer.getChannelData(0);
    const rms = calcRms(samples);
    const now = performance.now();
    setLevel(rms);
    if (state.avatar) {
      state.avatar.listenLevel(rms);
    }
    if (!state.connected || !state.ws || state.ws.readyState !== WebSocket.OPEN || state.awaiting || state.speaking) {
      return;
    }

    const speechDetected = rms >= VAD_THRESHOLD;
    if (speechDetected) {
      state.lastSpeechAt = now;
      if (!state.speechActive) {
        state.speechActive = true;
        state.replyStreamComplete = true;
        state.sawAssistantResponse = false;
        state.sawUserTranscript = false;
        state.audioTurn += 1;
        state.turnStartedAt = now;
        clearTurnDrafts();
        state.ws.send(JSON.stringify({
          type: "audio_start",
          sampleRate: state.captureSampleRate,
        }));
      }
    }

    if (!state.speechActive) {
      return;
    }

    const pcm = toPCM16(samples);
    state.ws.send(JSON.stringify({
      type: "audio",
      data: toB64(pcm.buffer),
      sampleRate: state.captureSampleRate,
    }));

    if (!speechDetected && now - state.lastSpeechAt >= SILENCE_MS && now - state.turnStartedAt > 500) {
      endAudioTurn();
    }
  }

  function endAudioTurn() {
    if (!state.speechActive || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    state.speechActive = false;
    state.awaiting = true;
    state.sawAssistantResponse = false;
    scheduleResponseWatchdog();
    state.ws.send(JSON.stringify({
      type: "audio_end",
      sampleRate: state.captureSampleRate,
    }));
    setStatus("Thinking...");
    if (state.avatar) {
      state.avatar.setMode("thinking");
    }
  }

  function stopMic() {
    setMicLoading(false);
    if (!state.awaiting && !state.speaking && !state.voiceKeepPanelClosed) {
      state.voiceSessionActive = false;
    }
    if (state.processor) {
      state.processor.disconnect();
      state.processor.onaudioprocess = null;
      state.processor = null;
    }
    if (state.silentSink) {
      state.silentSink.disconnect();
      state.silentSink = null;
    }
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
    }
    if (state.audioCtx) {
      state.audioCtx.close().catch(() => {});
      state.audioCtx = null;
    }
    state.listening = false;
    state.speechActive = false;
    if (!state.awaiting) {
      clearResponseWatchdog();
    }
    setLevel(0);
    const mic = byId("pcw-mic");
    if (mic) {
      mic.dataset.active = "false";
    }
    syncAvatarControls();
  }

  function stopPlayback() {
    for (const source of state.activeSources) {
      try {
        source.stop();
      } catch {}
    }
    state.activeSources.clear();
    state.nextPlayAt = state.playCtx ? state.playCtx.currentTime : 0;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    state.speaking = false;
  }

  function stopAssistantActivity(options = {}) {
    const closeSocket = options.closeSocket !== false;
    const reason = options.reason || "portfolio avatar stop";
    const statusText = options.status || "Ready";
    stopVoiceRecognition({ silent: true });
    stopMic();
    stopPlayback();
    state.open = false;
    state.awaiting = false;
    state.replyStreamComplete = true;
    state.voiceKeepPanelClosed = false;
    state.voiceSessionActive = false;
    state.autoListenAfterAssistantReply = false;
    state.closeAfterAssistantReply = false;
    state.suppressInputTranscript = false;
    state.suppressAssistantTranscript = false;
    clearVoiceSessionTimer();
    clearResponseWatchdog();
    if (closeSocket) {
      closeBackendSocket(reason);
    } else if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "reset_live", reason }));
    }
    setStatus(statusText);
    setChatPanelVisible(false);
    setAvatarShellHidden(false);
    if (state.avatar) {
      state.avatar.setMode("idle");
      state.avatar.hide({ automatic: true });
    }
    syncAvatarControls();
    hideAvatarControls();
  }

  function playPCM(base64Pcm) {
    if (!state.playCtx || !base64Pcm) {
      return;
    }
    const raw = atob(base64Pcm);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      bytes[i] = raw.charCodeAt(i);
    }
    const view = new DataView(bytes.buffer);
    const floatData = new Float32Array(bytes.length / 2);
    for (let i = 0; i < floatData.length; i += 1) {
      floatData[i] = view.getInt16(i * 2, true) / 32768;
    }
    const buffer = state.playCtx.createBuffer(1, floatData.length, 24000);
    buffer.copyToChannel(floatData, 0);
    const source = state.playCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(state.playCtx.destination);
    source.onended = () => {
      state.activeSources.delete(source);
      if (state.activeSources.size === 0) {
        releaseReplyIfReady();
      }
    };
    state.activeSources.add(source);
    const startAt = Math.max(state.nextPlayAt, state.playCtx.currentTime + 0.01);
    source.start(startAt);
    state.nextPlayAt = startAt + buffer.duration;
  }

  function calcRms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / Math.max(1, samples.length));
  }

  function toPCM16(samples) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return out;
  }

  function toB64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  async function init() {
    if (!document.body) {
      window.addEventListener("DOMContentLoaded", init, { once: true });
      return;
    }
    state.pageContext = collectPageContext();
    injectStyles();
    buildWidget();
    wirePageLifecycleCleanup();
    try {
      await loadScript(new URL("/static/virtual-assistant.js", BASE_URL).toString());
      if (window.createVirtualAssistantAvatar) {
        state.avatar = window.createVirtualAssistantAvatar({
          initiallyVisible: false,
          autoShowOnSpeak: true,
        });
        buildAvatarControls();
        wireAvatarToggle();
        state.avatar.hide({ automatic: true });
        syncAvatarControls();
      }
    } catch {
      addMessage("system", "Assistant animation could not load, but chat is still available.");
    }
  }

  init();
})();
