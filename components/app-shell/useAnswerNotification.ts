"use client";

import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import { isAnswerSoundId, type AnswerSoundId, type AnswerSoundPreferences } from "@/lib/contracts/answerSound";
import { prepareAnswerSound, startAnswerSound } from "./answerSound";

const ALERT_FAVICON_HREF = "/favicon-alert.svg";
const DEFAULT_FAVICON_HREF = "/favicon.svg";

function ensureFaviconLink() {
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = DEFAULT_FAVICON_HREF;
    document.head.appendChild(link);
  }

  return link;
}

export function useAnswerNotification({ accountId, readPreferences }: {
  accountId: string;
  readPreferences(): AnswerSoundPreferences | null;
}) {
  const scope = useMemo(() => Symbol(accountId), [accountId]);
  const currentRef = useRef<{ scope: symbol; readPreferences(): AnswerSoundPreferences | null } | null>(null);
  const answerAudioRef = useRef<AudioContext | null>(null);
  const faviconPulseTimerRef = useRef<number | null>(null);
  const playbackRef = useRef<(() => void) | null>(null);
  const playbackSequenceRef = useRef(0);

  const stopReadyFaviconAlert = useCallback(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    if (faviconPulseTimerRef.current !== null) {
      window.clearTimeout(faviconPulseTimerRef.current);
      faviconPulseTimerRef.current = null;
    }
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (link) {
      link.href = DEFAULT_FAVICON_HREF;
    }
  }, []);

  useLayoutEffect(() => {
    function handleVisible() {
      if (document.visibilityState === "visible") {
        stopReadyFaviconAlert();
      }
    }

    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("focus", stopReadyFaviconAlert);

    return () => {
      currentRef.current = null;
      playbackSequenceRef.current += 1;
      playbackRef.current?.();
      playbackRef.current = null;
      stopReadyFaviconAlert();
      const audioContext = answerAudioRef.current;
      answerAudioRef.current = null;
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close().catch(() => undefined);
      }
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("focus", stopReadyFaviconAlert);
    };
  }, [scope, stopReadyFaviconAlert]);

  useLayoutEffect(() => {
    currentRef.current = { scope, readPreferences };
  });

  function currentPreferences() {
    const current = currentRef.current;
    return current?.scope === scope ? current.readPreferences() : null;
  }

  async function answerAudioContext(preview = false) {
    const preferences = currentPreferences();
    if (!preferences || (!preview && !preferences.answerSoundEnabled) || typeof window === "undefined") return null;
    const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return null;
    const context = answerAudioRef.current ?? new Constructor();
    answerAudioRef.current = context;
    if (context.state === "suspended") await context.resume();
    return context.state === "running" && answerAudioRef.current === context ? context : null;
  }

  async function primeAnswerSound() {
    await answerAudioContext().catch(() => null);
  }

  async function playSound(previewId?: AnswerSoundId) {
    const sequence = ++playbackSequenceRef.current;
    playbackRef.current?.();
    const pending = new AbortController();
    const cancelPending = () => pending.abort();
    playbackRef.current = cancelPending;
    try {
      const context = await answerAudioContext(previewId !== undefined);
      function selectedSound() {
        const preferences = currentPreferences();
        if (!context || context !== answerAudioRef.current || context.state !== "running" ||
          !preferences || pending.signal.aborted || sequence !== playbackSequenceRef.current ||
          (previewId === undefined && !preferences.answerSoundEnabled)) return null;
        return previewId ?? preferences.answerSoundId;
      }
      let sound = selectedSound();
      // Resume and sample decoding can both wait. Recheck the current account,
      // mute and choice immediately before scheduling any audible node.
      while (context && sound !== null) {
        const timer = window.setTimeout(cancelPending, 5000);
        let buffer: AudioBuffer | null;
        try {
          buffer = await prepareAnswerSound(context, sound, pending.signal);
        } finally {
          window.clearTimeout(timer);
        }
        const latest = selectedSound();
        if (latest !== sound) { sound = latest; continue; }
        playbackRef.current = startAnswerSound(context, sound, () => {
          if (sequence === playbackSequenceRef.current) playbackRef.current = null;
        }, buffer);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      if (playbackRef.current === cancelPending) playbackRef.current = null;
    }
  }

  async function previewAnswerSound(sound: AnswerSoundId) {
    return currentRef.current?.scope === scope && isAnswerSoundId(sound) && await playSound(sound);
  }

  function pulseReadyFavicon() {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const link = ensureFaviconLink();
    if (faviconPulseTimerRef.current !== null) {
      window.clearTimeout(faviconPulseTimerRef.current);
    }

    link.href = ALERT_FAVICON_HREF;
    if (document.visibilityState === "visible") {
      faviconPulseTimerRef.current = window.setTimeout(() => {
        faviconPulseTimerRef.current = null;
        link.href = DEFAULT_FAVICON_HREF;
      }, 1800);
      return;
    }

    let alertVisible = true;
    faviconPulseTimerRef.current = window.setInterval(() => {
      alertVisible = !alertVisible;
      link.href = alertVisible ? ALERT_FAVICON_HREF : DEFAULT_FAVICON_HREF;
    }, 1200);
  }

  async function notifyAnswerReady() {
    if (currentRef.current?.scope !== scope) return;
    pulseReadyFavicon();
    await playSound();
  }

  return { notifyAnswerReady, primeAnswerSound, previewAnswerSound };
}
