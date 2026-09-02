import {
  Fragment,
  forwardRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode
} from "react";

export type UiV2IconName =
  | "alert"
  | "archive"
  | "arrow-left"
  | "arrow-up"
  | "assistant"
  | "attach"
  | "book"
  | "braces"
  | "branch"
  | "brand"
  | "chat"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "close"
  | "copy"
  | "download"
  | "edit"
  | "file"
  | "flask"
  | "folder"
  | "folder-plus"
  | "globe"
  | "history"
  | "image"
  | "layers"
  | "library"
  | "link"
  | "lock"
  | "logout"
  | "menu"
  | "memory"
  | "monitor"
  | "moon"
  | "more"
  | "panel"
  | "plug"
  | "plus"
  | "provider-anthropic"
  | "provider-deepseek"
  | "provider-gemini"
  | "provider-openai"
  | "provider-openrouter"
  | "regenerate"
  | "search"
  | "sliders"
  | "settings"
  | "share"
  | "shield"
  | "star"
  | "star-fill"
  | "stop"
  | "sun"
  | "slides"
  | "table"
  | "tool"
  | "trash"
  | "wand";

export function UiV2IconSprite() {
  return (
    <svg aria-hidden="true" className="absolute size-0 overflow-hidden">
      <defs>
        <symbol id="v2-icon-alert" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16h.01" />
        </symbol>
        <symbol id="v2-icon-archive" viewBox="0 0 24 24">
          <path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6" />
        </symbol>
        <symbol id="v2-icon-arrow-left" viewBox="0 0 24 24">
          <path d="M19 12H5M10.5 6.5 5 12l5.5 5.5" />
        </symbol>
        <symbol id="v2-icon-arrow-up" viewBox="0 0 24 24">
          <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />
        </symbol>
        <symbol id="v2-icon-assistant" viewBox="0 0 24 24">
          <circle cx="12" cy="8" r="4" />
          <path d="M4.5 21a7.5 7.5 0 0 1 15 0M18.5 3.5v3M17 5h3" />
        </symbol>
        <symbol id="v2-icon-attach" viewBox="0 0 24 24">
          <path d="m20.5 11.5-8.4 8.4a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7L9.3 17a2 2 0 1 1-2.8-2.8l8.5-8.5" />
        </symbol>
        <symbol id="v2-icon-brand" viewBox="0 0 24 24">
          <rect x="3.5" y="3.5" width="14" height="14" rx="4.5" />
          <path d="M12.5 12.5 21 21" />
        </symbol>
        <symbol id="v2-icon-braces" viewBox="0 0 24 24">
          <path d="M8 4a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2M16 4a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2" />
        </symbol>
        <symbol id="v2-icon-branch" viewBox="0 0 24 24">
          <circle cx="6" cy="5" r="2" />
          <circle cx="18" cy="7" r="2" />
          <circle cx="18" cy="18" r="2" />
          <path d="M8 5h2a4 4 0 0 1 4 4v5a4 4 0 0 0 4 4M14 10a3 3 0 0 1 3-3h1M6 7v12" />
        </symbol>
        <symbol id="v2-icon-book" viewBox="0 0 24 24">
          <path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H12v18H7.5A3.5 3.5 0 0 0 4 23zM20 5.5A3.5 3.5 0 0 0 16.5 2H12v18h4.5A3.5 3.5 0 0 1 20 23z" />
        </symbol>
        <symbol id="v2-icon-chat" viewBox="0 0 24 24">
          <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z" />
        </symbol>
        <symbol id="v2-icon-check" viewBox="0 0 24 24">
          <path d="m5 12.5 4.2 4.2L19 7" />
        </symbol>
        <symbol id="v2-icon-chevron-down" viewBox="0 0 24 24">
          <path d="m6 9 6 6 6-6" />
        </symbol>
        <symbol id="v2-icon-chevron-right" viewBox="0 0 24 24">
          <path d="m9 6 6 6-6 6" />
        </symbol>
        <symbol id="v2-icon-close" viewBox="0 0 24 24">
          <path d="m6 6 12 12M18 6 6 18" />
        </symbol>
        <symbol id="v2-icon-copy" viewBox="0 0 24 24">
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </symbol>
        <symbol id="v2-icon-download" viewBox="0 0 24 24">
          <path d="M12 3v12m-5-5 5 5 5-5M5 21h14" />
        </symbol>
        <symbol id="v2-icon-edit" viewBox="0 0 24 24">
          <path d="M13.5 6.5 17.5 10.5M4 20l4.3-1 10.9-10.9a2.8 2.8 0 0 0-4-4L4.3 15 4 20Z" />
        </symbol>
        <symbol id="v2-icon-file" viewBox="0 0 24 24">
          <path d="M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h6" />
        </symbol>
        <symbol id="v2-icon-flask" viewBox="0 0 24 24">
          <path d="M10 3h4M11 3v6L5 19a1.5 1.5 0 0 0 1.3 2h11.4a1.5 1.5 0 0 0 1.3-2l-6-10V3M8 15h8" />
        </symbol>
        <symbol id="v2-icon-folder" viewBox="0 0 24 24">
          <path d="M3 6.5h6l2 2h10v10H3z" />
        </symbol>
        <symbol id="v2-icon-folder-plus" viewBox="0 0 24 24">
          <path d="M3 6.5h6l2 2h10v10H3zM12 11v5M9.5 13.5h5" />
        </symbol>
        <symbol id="v2-icon-globe" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </symbol>
        <symbol id="v2-icon-history" viewBox="0 0 24 24">
          <path d="M4 5v5h5M5.6 9.2A8 8 0 1 1 4 14M12 8v5l3 2" />
        </symbol>
        <symbol id="v2-icon-image" viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9.5" r="1.5" />
          <path d="m21 16-5-5-8 8" />
        </symbol>
        <symbol id="v2-icon-layers" viewBox="0 0 24 24">
          <path d="m12 3 9 5-9 5-9-5z" />
          <path d="m3 13 9 5 9-5" />
        </symbol>
        <symbol id="v2-icon-library" viewBox="0 0 24 24">
          <path d="M5 4h3v16H5zM10.5 4h3v16h-3zM16 5l3-.8L22 19l-3 .8z" />
        </symbol>
        <symbol id="v2-icon-link" viewBox="0 0 24 24">
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
        </symbol>
        <symbol id="v2-icon-lock" viewBox="0 0 24 24">
          <rect x="5" y="10" width="14" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </symbol>
        <symbol id="v2-icon-logout" viewBox="0 0 24 24">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
        </symbol>
        <symbol id="v2-icon-menu" viewBox="0 0 24 24">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </symbol>
        <symbol id="v2-icon-memory" viewBox="0 0 24 24">
          <rect x="6" y="6" width="12" height="12" rx="2" />
          <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M18 9h4M2 15h4M18 15h4M10 10h4v4h-4z" />
        </symbol>
        <symbol id="v2-icon-monitor" viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </symbol>
        <symbol id="v2-icon-moon" viewBox="0 0 24 24">
          <path d="M20.5 15.2A8.5 8.5 0 0 1 8.8 3.5 8.5 8.5 0 1 0 20.5 15.2Z" />
        </symbol>
        <symbol id="v2-icon-more" viewBox="0 0 24 24">
          <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
        </symbol>
        <symbol id="v2-icon-panel" viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </symbol>
        <symbol id="v2-icon-plug" viewBox="0 0 24 24">
          <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />
        </symbol>
        <symbol id="v2-icon-plus" viewBox="0 0 24 24">
          <path d="M12 5v14M5 12h14" />
        </symbol>
        {/* Provider marks (monochrome, filled): Anthropic, Gemini, DeepSeek and
            OpenRouter from simple-icons (CC0), OpenAI from lobe-icons static
            (MIT). Trademarks belong to their owners; they only denote the
            provider family. */}
        <symbol id="v2-icon-provider-anthropic" viewBox="0 0 24 24">
          <path fill="currentColor" stroke="none" d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
        </symbol>
        <symbol id="v2-icon-provider-deepseek" viewBox="0 0 24 24">
          <path fill="currentColor" stroke="none" d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.59M11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.7 4.7 0 0 1 1.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614m1-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .2.288.306.306 0 0 1-.31.307.306.306 0 0 1-.304-.308m3.11 1.596c-.2.081-.399.151-.59.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.552-.758a1.7 1.7 0 0 1 .016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.56.56 0 0 1-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452" />
        </symbol>
        <symbol id="v2-icon-provider-gemini" viewBox="0 0 24 24">
          <path fill="currentColor" stroke="none" d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
        </symbol>
        <symbol id="v2-icon-provider-openai" viewBox="0 0 24 24">
          <path fill="currentColor" fillRule="evenodd" stroke="none" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
        </symbol>
        <symbol id="v2-icon-provider-openrouter" viewBox="0 0 24 24">
          <path fill="currentColor" stroke="none" d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z" />
        </symbol>
        <symbol id="v2-icon-regenerate" viewBox="0 0 24 24">
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M6.1 8.5A7 7 0 0 1 18.5 7M17.9 15.5A7 7 0 0 1 5.5 17" />
        </symbol>
        <symbol id="v2-icon-search" viewBox="0 0 24 24">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 5 5" />
        </symbol>
        <symbol id="v2-icon-sliders" viewBox="0 0 24 24">
          <path d="M4 6h8M16 6h4M4 12h3M11 12h9M4 18h10M18 18h2" />
          <circle cx="14" cy="6" r="2" />
          <circle cx="9" cy="12" r="2" />
          <circle cx="16" cy="18" r="2" />
        </symbol>
        {/* A gear, not rays: the rays read as a theme/brightness toggle in the rail. */}
        <symbol id="v2-icon-settings" viewBox="0 0 24 24">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </symbol>
        <symbol id="v2-icon-share" viewBox="0 0 24 24">
          <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
          <path d="M12 15V3M7 8l5-5 5 5" />
        </symbol>
        <symbol id="v2-icon-shield" viewBox="0 0 24 24">
          <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />
          <path d="m9 12 2 2 4-4" />
        </symbol>
        <symbol id="v2-icon-star" viewBox="0 0 24 24">
          <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
        </symbol>
        <symbol id="v2-icon-star-fill" viewBox="0 0 24 24">
          <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" fill="currentColor" />
        </symbol>
        <symbol id="v2-icon-stop" viewBox="0 0 24 24">
          <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />
        </symbol>
        <symbol id="v2-icon-sun" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
        </symbol>
        <symbol id="v2-icon-slides" viewBox="0 0 24 24">
          <rect x="3" y="5" width="18" height="13" rx="2" />
          <path d="M8 21h8M12 18v3M7 14l3-3 2 2 4-5" />
        </symbol>
        <symbol id="v2-icon-table" viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18M9 9v11M15 9v11M3 14h18" />
        </symbol>
        <symbol id="v2-icon-tool" viewBox="0 0 24 24">
          <path d="M14.5 6.5a4 4 0 0 0-5-5l2.2 2.2-3 3-2.2-2.2a4 4 0 0 0 5 5L19 17l-2 2-7.5-7.5" />
        </symbol>
        <symbol id="v2-icon-trash" viewBox="0 0 24 24">
          <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
        </symbol>
        <symbol id="v2-icon-wand" viewBox="0 0 24 24">
          <path d="M3 21 14 10M15 3l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 13l.7 1.3 1.3.7-1.3.7L19 17l-.7-1.3-1.3-.7 1.3-.7z" />
        </symbol>
      </defs>
    </svg>
  );
}

export function UiV2Icon({
  className = "",
  name,
  title
}: {
  className?: string;
  name: UiV2IconName;
  /** Native tooltip for a decorative glyph whose meaning has no visible label. */
  title?: string;
}) {
  return (
    <svg className={`v2-icon ${className}`.trim()} aria-hidden="true">
      {title ? <title>{title}</title> : null}
      <use href={`#v2-icon-${name}`} />
    </svg>
  );
}

const PROVIDER_MARKS: Readonly<Record<string, UiV2IconName>> = {
  anthropic: "provider-anthropic",
  deepseek: "provider-deepseek",
  fake: "flask",
  gemini: "provider-gemini",
  openai: "provider-openai",
  openai_compatible: "plug",
  openrouter: "provider-openrouter"
};

/**
 * Monochrome provider mark for a catalog provider family (never a coloured
 * logo): the vendor mark for known families, a neutral plug for compatible
 * endpoints, a flask for the test provider, and the monogram for the rest.
 */
export function UiV2ProviderMark({
  className = "",
  family,
  label
}: {
  className?: string;
  family?: string | null;
  /** Fallback monogram source (the provider name) when the family has no mark. */
  label: string;
}) {
  const icon = family ? PROVIDER_MARKS[family] : undefined;
  if (!icon) return <UiV2Monogram className={className} label={label} />;
  return <UiV2Icon className={`v2-provider-mark ${className}`.trim()} name={icon} />;
}

/**
 * One-letter identity glyph for a provider, domain, or server: the same
 * monogram in the composer chip, the picker, and the Sources list so a
 * source reads identically everywhere.
 */
export function UiV2Monogram({ className = "", label }: { className?: string; label: string }) {
  const initial = label.trim().replace(/^www\./iu, "").slice(0, 1).toLocaleUpperCase() || "·";
  return (
    <span className={`v2-monogram ${className}`.trim()} aria-hidden="true">
      {initial}
    </span>
  );
}

type UiV2ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  icon?: UiV2IconName;
  tone?: "destructive" | "ghost" | "primary";
};

export const UiV2Button = forwardRef<HTMLButtonElement, UiV2ButtonProps>(
  function UiV2Button(
    { busy = false, children, className = "", disabled, icon, tone = "ghost", ...props },
    ref
  ) {
    return (
      <button
        {...props}
        ref={ref}
        className={`v2-button v2-focusable ${className}`.trim()}
        data-busy={busy || undefined}
        data-tone={tone}
        aria-busy={busy || undefined}
        disabled={disabled || busy}
      >
        {busy ? <span className="v2-spinner" aria-hidden="true" /> : icon ? <UiV2Icon name={icon} /> : null}
        <span>{children}</span>
      </button>
    );
  }
);

type UiV2IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: UiV2IconName;
  label: string;
  round?: boolean;
  /**
   * Styled instant tooltip (see `[data-tooltip]` in primitives.css) instead
   * of the browser's delayed `title`; the accessible name stays `label`.
   */
  tooltip?: string;
  tooltipSide?: "left" | "right";
};

export const UiV2IconButton = forwardRef<HTMLButtonElement, UiV2IconButtonProps>(
  function UiV2IconButton(
    { className = "", icon, label, round = false, title = label, tooltip, tooltipSide, type = "button", ...props },
    ref
  ) {
    return (
      <button
        {...props}
        type={type}
        ref={ref}
        className={`v2-icon-button v2-focusable ${className}`.trim()}
        data-round={round || undefined}
        data-tooltip={tooltip}
        data-tooltip-side={tooltip ? tooltipSide : undefined}
        aria-label={label}
        title={tooltip ? undefined : title}
      >
        <UiV2Icon name={icon} />
      </button>
    );
  }
);

/**
 * Accessible switch: a button with role="switch" and the accent track. The
 * accessible name is the setting itself; aria-checked carries the state.
 */
export function UiV2Switch({
  checked,
  className = "",
  disabled = false,
  label,
  onChange,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(next: boolean): void;
}) {
  return (
    <button
      {...props}
      aria-checked={checked}
      aria-label={label}
      className={`v2-switch v2-focusable ${className}`.trim()}
      disabled={disabled}
      role="switch"
      type="button"
      onClick={() => onChange(!checked)}
    >
      <span className="v2-switch-track" aria-hidden="true">
        <span className="v2-switch-thumb" />
      </span>
    </button>
  );
}

export const UiV2MenuSurface = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { label: string }
>(function UiV2MenuSurface({ children, className = "", label, ...props }, ref) {
  return (
    <div
      {...props}
      ref={ref}
      className={`v2-menu ${className}`.trim()}
      role="menu"
      aria-label={label}
    >
      {children}
    </div>
  );
});

export function UiV2MenuItem({
  children,
  icon,
  selected = false,
  sub,
  tone,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Leading 16px glyph in `text3` (danger for destructive items); decorative. */
  icon?: UiV2IconName;
  selected?: boolean;
  sub?: string;
  /** Destructive items keep their place in the menu but read in the danger color. */
  tone?: "destructive";
}) {
  return (
    <button
      {...props}
      className="v2-menu-item v2-focusable"
      role="menuitem"
      aria-current={selected ? "true" : undefined}
      data-icon={icon ? "" : undefined}
      data-tone={tone}
    >
      {icon ? <span className="v2-menu-item-icon"><UiV2Icon name={icon} /></span> : null}
      <span>
        {children}
        {sub ? <span className="v2-menu-item-sub">{sub}</span> : null}
      </span>
      {selected ? <span className="v2-menu-item-check"><UiV2Icon name="check" /></span> : null}
    </button>
  );
}

/**
 * A navigation entry inside a menu: the same metrics as a menu item, but a
 * real link (it keeps the link role so it reads as navigation, not a command).
 */
export function UiV2MenuLink({
  children,
  icon,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { icon?: UiV2IconName }) {
  return (
    <a {...props} className="v2-menu-item v2-focusable" data-icon={icon ? "" : undefined}>
      {icon ? <span className="v2-menu-item-icon"><UiV2Icon name={icon} /></span> : null}
      <span>{children}</span>
    </a>
  );
}

/** Visual group boundary inside a menu surface. */
export function UiV2MenuSeparator() {
  return <div className="v2-menu-separator" role="separator" />;
}

export type UiV2MenuSubmenuItem = Readonly<{
  depth?: number;
  label: string;
  onSelect(): void;
}>;

/** One declarative entry of an action menu rendered by `UiV2MenuActions`. */
export type UiV2MenuAction = Readonly<{
  disabled?: boolean;
  icon?: UiV2IconName;
  label: string;
  /** Rendered only below 900px via CSS; e.g. Share joins the header menu there. */
  mobileOnly?: boolean;
  onSelect?(): void;
  /** Checked state for toggles such as Favorite. */
  selected?: boolean;
  /** Starts a new visual group. */
  separatorBefore?: boolean;
  /** Inline disclosure list (folder picker); scrolls locally when long. */
  submenu?: readonly UiV2MenuSubmenuItem[];
  tone?: "destructive";
}>;

/**
 * The items of an action menu from one declarative list, so surfaces that
 * act on the same object (a chat's row menu and its header "⋯") stay
 * identical in composition, order, grouping, and icons. Selecting an item
 * (or a submenu entry) closes the menu through `onClose` first.
 */
export function UiV2MenuActions({
  actions,
  onClose
}: {
  actions: readonly UiV2MenuAction[];
  onClose(): void;
}) {
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  return (
    <>
      {actions.map((action) => (
        <Fragment key={action.label}>
          {action.separatorBefore ? <UiV2MenuSeparator /> : null}
          <UiV2MenuItem
            data-mobile-only={action.mobileOnly ? "" : undefined}
            disabled={action.disabled}
            icon={action.icon}
            selected={action.selected}
            tone={action.tone}
            {...(action.submenu ? { "aria-expanded": openSubmenu === action.label } : {})}
            onClick={() => {
              if (action.submenu) {
                setOpenSubmenu((current) => current === action.label ? null : action.label);
                return;
              }
              onClose();
              action.onSelect?.();
            }}
          >
            {action.label}
          </UiV2MenuItem>
          {action.submenu && openSubmenu === action.label ? (
            <div aria-label={action.label} className="v2-menu-submenu">
              {action.submenu.map((item, index) => (
                <UiV2MenuItem
                  key={`${item.label}-${index}`}
                  style={{ paddingLeft: `${0.5 + (item.depth ?? 0) * 0.75}rem` } as CSSProperties}
                  onClick={() => {
                    onClose();
                    item.onSelect();
                  }}
                >
                  {item.label}
                </UiV2MenuItem>
              ))}
            </div>
          ) : null}
        </Fragment>
      ))}
    </>
  );
}

export function UiV2Chip({
  children,
  tone = "neutral"
}: {
  children: ReactNode;
  tone?: "danger" | "neutral" | "ok" | "warn";
}) {
  return <span className="v2-chip" data-tone={tone}>{children}</span>;
}

export function UiV2Skeleton({ className = "" }: { className?: string }) {
  return <span className={`v2-skeleton ${className}`.trim()} aria-hidden="true" />;
}

export function UiV2Toast({
  action,
  children,
  onAction
}: {
  action?: string;
  children: ReactNode;
  onAction?(): void;
}) {
  return (
    <div className="v2-toast" role="status">
      <span>{children}</span>
      {action ? (
        <>
          <span aria-hidden="true">·</span>
          <button className="v2-focusable" type="button" onClick={onAction}>
            {action}
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * Keyboard contract of an open menu surface: arrows, Home and End move focus
 * between enabled items and Escape hands control back to the trigger.
 */
export function moveMenuFocusV2(
  event: KeyboardEvent<HTMLElement>,
  menu: HTMLElement | null,
  onEscape: () => void
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    onEscape();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...(menu?.querySelectorAll<HTMLElement>("[role='menuitem']:not(:disabled)") ?? [])];
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? items.length - 1
      : event.key === "ArrowDown"
        ? (current + 1 + items.length) % items.length
        : (current - 1 + items.length) % items.length;
  event.preventDefault();
  items[next]?.focus();
}
