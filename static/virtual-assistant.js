(function () {
  "use strict";

  const STYLE_ID = "virtual-assistant-style";
  const ROOT_ID = "virtual-assistant-root";
  const SAMPLE_RATE = 24000;
  const FRAME_MS = 42;
  const MAX_QUEUE_FRAMES = 100;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  class VirtualAssistantAvatar {
    constructor(options = {}) {
      this.options = {
        autoShowOnSpeak: options.autoShowOnSpeak !== false,
        initiallyVisible: Boolean(options.initiallyVisible),
      };
      this.mode = "idle";
      this.energy = 0;
      this.targetEnergy = 0;
      this.listenEnergy = 0;
      this.lipQueue = [];
      this.lastQueuePullAt = 0;
      this.lastSpeechAt = 0;
      this.userCollapsed = false;
      this.isCollapsed = !this.options.initiallyVisible;
      this.animationId = null;

      this.injectStyles();
      this.root = this.buildDom();
      document.body.appendChild(this.root);
      this.nodes = {
        stage: this.root.querySelector(".va-stage"),
        toggle: this.root.querySelector(".va-toggle"),
        toggleIconOpen: this.root.querySelector(".va-icon-open"),
        toggleIconClosed: this.root.querySelector(".va-icon-closed"),
        figure: this.root.querySelector(".va-figure-motion"),
        head: this.root.querySelector(".va-head"),
        eyes: this.root.querySelector(".va-eyes"),
        mouth: this.root.querySelector(".va-mouth"),
        leftArm: this.root.querySelector(".va-arm-left"),
        rightArm: this.root.querySelector(".va-arm-right"),
      };

      this.nodes.toggle.addEventListener("click", () => this.toggle());
      this.setCollapsed(this.isCollapsed);
      this.setMode("idle");
      this.tick = this.tick.bind(this);
      this.animationId = requestAnimationFrame(this.tick);
    }

    injectStyles() {
      if (document.getElementById(STYLE_ID)) {
        return;
      }

      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        .va-root {
          --va-energy: 0;
          --va-accent: #df78ff;
          position: fixed;
          right: clamp(14px, 3vw, 28px);
          bottom: clamp(14px, 3vw, 28px);
          z-index: 8;
          width: clamp(132px, 18vw, 188px);
          pointer-events: none;
          color: #f9f4ff;
        }

        .va-stage,
        .va-toggle {
          pointer-events: auto;
        }

        .va-stage {
          position: relative;
          width: 100%;
          aspect-ratio: 0.66;
          transform-origin: 50% 100%;
          transition: opacity 180ms ease, transform 220ms ease, filter 220ms ease;
          filter: drop-shadow(0 26px 54px rgba(0, 0, 0, 0.34));
        }

        .va-root[data-collapsed="true"] .va-stage {
          opacity: 0;
          transform: translateY(18px) scale(0.86);
          pointer-events: none;
          filter: none;
        }

        .va-toggle {
          position: absolute;
          right: 0;
          bottom: 0;
          width: 46px;
          height: 46px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          border-radius: 50%;
          background: rgba(34, 17, 54, 0.78);
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 18px 42px rgba(0, 0, 0, 0.26);
          backdrop-filter: blur(16px);
          transition: transform 160ms ease, background 160ms ease, border-color 160ms ease;
        }

        .va-toggle:hover {
          background: rgba(83, 42, 124, 0.9);
          border-color: rgba(255, 255, 255, 0.28);
        }

        .va-toggle:active {
          transform: scale(0.94);
        }

        .va-root[data-collapsed="false"] .va-toggle {
          right: 5px;
          bottom: calc(100% - 50px);
        }

        .va-root[data-speaking-alert="true"] .va-toggle::after {
          position: absolute;
          inset: -7px;
          content: "";
          border-radius: 50%;
          border: 1px solid rgba(223, 120, 255, 0.65);
          animation: va-toggle-pulse 1.1s ease-out infinite;
        }

        .va-icon {
          width: 21px;
          height: 21px;
          display: block;
        }

        .va-root[data-collapsed="true"] .va-icon-closed,
        .va-root[data-collapsed="false"] .va-icon-open {
          display: none;
        }

        .va-figure {
          width: 100%;
          height: 100%;
          overflow: visible;
        }

        .va-figure-motion {
          transform-origin: 100px 250px;
          animation: va-breathe 4.2s ease-in-out infinite;
        }

        .va-head {
          transform-origin: 100px 78px;
          transform-box: fill-box;
          transition: transform 160ms ease;
        }

        .va-eyes {
          transform-origin: 100px 97px;
          transform-box: fill-box;
        }

        .va-arm-left,
        .va-arm-right {
          transform-origin: 100px 154px;
          transform-box: fill-box;
          transition: transform 180ms ease;
        }

        .va-mouth {
          transform-origin: center;
          transform-box: fill-box;
          transition: rx 50ms linear, ry 50ms linear, opacity 120ms ease;
        }

        .va-aura {
          opacity: 0.5;
          transform-origin: 100px 130px;
          animation: va-aura 3.4s ease-in-out infinite;
        }

        .va-root[data-mode="speaking"] .va-figure-motion {
          animation: va-speaking-body 0.82s ease-in-out infinite;
        }

        .va-root[data-mode="speaking"] .va-head {
          animation: va-speaking-head 0.68s ease-in-out infinite;
        }

        .va-root[data-mode="speaking"] .va-arm-right {
          animation: va-speaking-hand 1.05s ease-in-out infinite;
        }

        .va-root[data-mode="listening"] .va-head {
          animation: va-listening-head 2.6s ease-in-out infinite;
        }

        .va-root[data-mode="thinking"] .va-head {
          animation: va-thinking-head 2s ease-in-out infinite;
        }

        .va-root[data-mode="thinking"] .va-eyes {
          animation: va-thinking-eyes 2s ease-in-out infinite;
        }

        .va-root[data-mode="muted"] .va-stage {
          filter: grayscale(0.45) drop-shadow(0 22px 44px rgba(0, 0, 0, 0.3));
          opacity: 0.72;
        }

        .va-root[data-mode="muted"] .va-figure-motion,
        .va-root[data-mode="muted"] .va-aura {
          animation-play-state: paused;
        }

        @keyframes va-breathe {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-2px) scale(1.012); }
        }

        @keyframes va-speaking-body {
          0%, 100% { transform: translateY(0) rotate(-0.8deg); }
          50% { transform: translateY(-5px) rotate(1deg); }
        }

        @keyframes va-speaking-head {
          0%, 100% { transform: rotate(-2deg) translateY(0); }
          50% { transform: rotate(2.6deg) translateY(-2px); }
        }

        @keyframes va-speaking-hand {
          0%, 100% { transform: rotate(0deg) translateY(0); }
          50% { transform: rotate(-8deg) translateY(-4px); }
        }

        @keyframes va-listening-head {
          0%, 100% { transform: rotate(0deg); }
          45% { transform: rotate(-2deg); }
          70% { transform: rotate(1.4deg); }
        }

        @keyframes va-thinking-head {
          0%, 100% { transform: rotate(-4deg) translateY(0); }
          50% { transform: rotate(3deg) translateY(-2px); }
        }

        @keyframes va-thinking-eyes {
          0%, 100% { transform: translate(0, 0); }
          45% { transform: translate(1px, -2px); }
          75% { transform: translate(-1px, -1px); }
        }

        @keyframes va-aura {
          0%, 100% { transform: scale(0.96); opacity: 0.42; }
          50% { transform: scale(1.04); opacity: 0.72; }
        }

        @keyframes va-toggle-pulse {
          0% { opacity: 0.85; transform: scale(0.78); }
          100% { opacity: 0; transform: scale(1.42); }
        }

        @media (max-width: 640px) {
          .va-root {
            width: 118px;
            right: 12px;
            bottom: 12px;
          }

          .va-toggle {
            width: 42px;
            height: 42px;
          }
        }
      `;
      document.head.appendChild(style);
    }

    buildDom() {
      const existing = document.getElementById(ROOT_ID);
      if (existing) {
        existing.remove();
      }

      const root = document.createElement("div");
      root.id = ROOT_ID;
      root.className = "va-root";
      root.setAttribute("aria-live", "off");
      root.innerHTML = `
        <div class="va-stage" role="img" aria-label="Animated virtual assistant">
          <svg class="va-figure" viewBox="0 0 200 286" aria-hidden="true">
            <defs>
              <radialGradient id="va-aura-gradient" cx="50%" cy="38%" r="56%">
                <stop offset="0%" stop-color="#f6dbff" stop-opacity="0.5"></stop>
                <stop offset="58%" stop-color="#d269ff" stop-opacity="0.28"></stop>
                <stop offset="100%" stop-color="#7c4dff" stop-opacity="0"></stop>
              </radialGradient>
              <linearGradient id="va-body-gradient" x1="44" y1="146" x2="154" y2="262" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stop-color="#9a6cff"></stop>
                <stop offset="100%" stop-color="#d269ff"></stop>
              </linearGradient>
              <linearGradient id="va-face-gradient" x1="64" y1="42" x2="136" y2="126" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stop-color="#fff0fb"></stop>
                <stop offset="100%" stop-color="#f0c7ff"></stop>
              </linearGradient>
              <filter id="va-soft-shadow" x="-40%" y="-40%" width="180%" height="180%">
                <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#090413" flood-opacity="0.28"></feDropShadow>
              </filter>
            </defs>

            <ellipse class="va-aura" cx="100" cy="140" rx="92" ry="126" fill="url(#va-aura-gradient)"></ellipse>
            <ellipse cx="100" cy="268" rx="54" ry="11" fill="rgba(7,4,16,0.28)"></ellipse>

            <g class="va-figure-motion" filter="url(#va-soft-shadow)">
              <path class="va-arm-left" d="M63 157 C31 174 29 220 52 235" fill="none" stroke="#b58dff" stroke-width="18" stroke-linecap="round"></path>
              <path class="va-arm-right" d="M137 157 C169 174 171 214 148 232" fill="none" stroke="#e497ff" stroke-width="18" stroke-linecap="round"></path>

              <path d="M52 158 C58 132 77 120 100 120 C123 120 142 132 148 158 L160 247 C161 258 153 267 142 267 L58 267 C47 267 39 258 40 247 Z" fill="url(#va-body-gradient)"></path>
              <path d="M67 160 C79 149 121 149 133 160 L129 254 L71 254 Z" fill="rgba(255,255,255,0.12)"></path>
              <path d="M82 127 L118 127 L123 151 C115 159 86 159 77 151 Z" fill="#ebc1ff"></path>

              <g class="va-head">
                <path d="M58 82 C58 45 79 26 103 26 C129 26 145 48 145 82 C145 108 127 128 101 128 C75 128 58 108 58 82 Z" fill="url(#va-face-gradient)"></path>
                <path d="M60 78 C64 43 82 26 105 26 C129 26 144 48 145 78 C134 58 117 52 95 54 C79 56 68 64 60 78 Z" fill="#4d266e" opacity="0.94"></path>
                <path d="M70 75 C86 57 116 55 136 72" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="3" stroke-linecap="round"></path>
                <circle cx="73" cy="96" r="7" fill="#f7a5e6" opacity="0.38"></circle>
                <circle cx="128" cy="96" r="7" fill="#f7a5e6" opacity="0.38"></circle>

                <g class="va-eyes">
                  <path d="M77 90 Q84 85 91 90" fill="none" stroke="#321540" stroke-width="3.5" stroke-linecap="round"></path>
                  <path d="M111 90 Q118 85 125 90" fill="none" stroke="#321540" stroke-width="3.5" stroke-linecap="round"></path>
                </g>

                <ellipse class="va-mouth" cx="101" cy="108" rx="9" ry="2.2" fill="#321540"></ellipse>
              </g>
            </g>
          </svg>
        </div>
        <button class="va-toggle" type="button" aria-label="Show assistant" title="Show assistant">
          <svg class="va-icon va-icon-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>
            <circle cx="12" cy="12" r="2.6"></circle>
          </svg>
          <svg class="va-icon va-icon-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 3l18 18"></path>
            <path d="M10.6 10.6A2 2 0 0 0 13.4 13.4"></path>
            <path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6 0 9.5 7 9.5 7a17.1 17.1 0 0 1-3.1 4.1"></path>
            <path d="M6.6 6.7C3.9 8.4 2.5 12 2.5 12s3.5 7 9.5 7c1.5 0 2.8-.4 4-1"></path>
          </svg>
        </button>
      `;
      return root;
    }

    setMode(mode) {
      const normalized = mode || "idle";
      this.mode = normalized;
      this.root.dataset.mode = normalized;

      if (normalized === "speaking") {
        this.revealForSpeech();
      }

      this.root.dataset.speakingAlert =
        normalized === "speaking" && this.isCollapsed ? "true" : "false";

      if (normalized !== "speaking") {
        this.lipQueue.length = 0;
        this.targetEnergy = normalized === "listening" ? this.listenEnergy : 0;
      }
    }

    speakFromPCM(base64Pcm) {
      if (!base64Pcm) {
        return;
      }

      if (this.mode !== "speaking") {
        this.setMode("speaking");
      }

      if (this.options.autoShowOnSpeak) {
        this.revealForSpeech();
      }

      const frames = this.pcmToEnvelope(base64Pcm);
      this.lipQueue.push(...frames);
      if (this.lipQueue.length > MAX_QUEUE_FRAMES) {
        this.lipQueue.splice(0, this.lipQueue.length - MAX_QUEUE_FRAMES);
      }
      this.lastSpeechAt = performance.now();
    }

    listenLevel(rms) {
      const value = clamp((Number(rms) || 0) * 7.5, 0, 1);
      this.listenEnergy = value;
      if (this.mode === "listening") {
        this.targetEnergy = value * 0.38;
      }
    }

    stopSpeaking() {
      this.lipQueue.length = 0;
      this.targetEnergy = 0;
      this.updateMouth(0);
      if (this.mode === "speaking") {
        this.setMode("idle");
      }
    }

    reset() {
      this.lipQueue.length = 0;
      this.energy = 0;
      this.targetEnergy = 0;
      this.listenEnergy = 0;
      this.updateMouth(0);
      this.setMode("idle");
    }

    show(options = {}) {
      if (!options.automatic) {
        this.userCollapsed = false;
      }
      if (options.automatic && this.userCollapsed) {
        return;
      }
      this.setCollapsed(false);
    }

    hide(options = {}) {
      if (!options.automatic) {
        this.userCollapsed = true;
      }
      this.setCollapsed(true);
    }

    toggle() {
      if (this.isCollapsed) {
        this.show();
      } else {
        this.hide();
      }
    }

    destroy() {
      if (this.animationId) {
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
      }
      this.root.remove();
    }

    setCollapsed(collapsed) {
      this.isCollapsed = Boolean(collapsed);
      this.root.dataset.collapsed = this.isCollapsed ? "true" : "false";
      this.root.dataset.speakingAlert =
        this.mode === "speaking" && this.isCollapsed ? "true" : "false";
      const label = this.isCollapsed ? "Show assistant" : "Hide assistant";
      if (this.nodes && this.nodes.toggle) {
        this.nodes.toggle.setAttribute("aria-label", label);
        this.nodes.toggle.setAttribute("title", label);
      }
    }

    revealForSpeech() {
      if (!this.options.autoShowOnSpeak || this.userCollapsed) {
        return;
      }
      this.setCollapsed(false);
    }

    pcmToEnvelope(base64Pcm) {
      const binary = atob(base64Pcm);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }

      const view = new DataView(bytes.buffer);
      const samplesPerFrame = Math.max(1, Math.round(SAMPLE_RATE * (FRAME_MS / 1000)));
      const frames = [];

      for (let byteOffset = 0; byteOffset + 1 < bytes.byteLength; byteOffset += samplesPerFrame * 2) {
        let sum = 0;
        let count = 0;
        const end = Math.min(bytes.byteLength, byteOffset + samplesPerFrame * 2);
        for (let offset = byteOffset; offset + 1 < end; offset += 2) {
          const sample = view.getInt16(offset, true) / 32768;
          sum += sample * sample;
          count += 1;
        }
        const rms = count ? Math.sqrt(sum / count) : 0;
        frames.push(clamp((rms - 0.012) * 12, 0.02, 1));
      }

      return frames.length ? frames : [0.06];
    }

    tick(now) {
      if (!this.lastQueuePullAt) {
        this.lastQueuePullAt = now;
      }

      if (now - this.lastQueuePullAt >= FRAME_MS) {
        this.lastQueuePullAt = now;
        if (this.mode === "speaking" && this.lipQueue.length) {
          this.targetEnergy = this.lipQueue.shift();
        } else if (this.mode === "speaking" && now - this.lastSpeechAt < 520) {
          this.targetEnergy *= 0.72;
        } else if (this.mode === "listening") {
          this.targetEnergy = this.listenEnergy * 0.38;
        } else {
          this.targetEnergy = 0;
        }
      }

      this.energy += (this.targetEnergy - this.energy) * 0.34;
      if (this.energy < 0.006) {
        this.energy = 0;
      }

      this.root.style.setProperty("--va-energy", this.energy.toFixed(3));
      this.updateMouth(this.energy);
      this.animationId = requestAnimationFrame(this.tick);
    }

    updateMouth(energy) {
      const mouth = this.nodes && this.nodes.mouth;
      if (!mouth) {
        return;
      }

      const rx = 8 + energy * 4.5;
      const ry = 2.1 + energy * 10;
      mouth.setAttribute("rx", rx.toFixed(2));
      mouth.setAttribute("ry", ry.toFixed(2));
      mouth.setAttribute("opacity", String(0.72 + energy * 0.28));
    }

  }

  window.VirtualAssistantAvatar = VirtualAssistantAvatar;
  window.createVirtualAssistantAvatar = function createVirtualAssistantAvatar(options) {
    if (window.__virtualAssistantAvatar) {
      return window.__virtualAssistantAvatar;
    }
    window.__virtualAssistantAvatar = new VirtualAssistantAvatar(options);
    return window.__virtualAssistantAvatar;
  };
})();
