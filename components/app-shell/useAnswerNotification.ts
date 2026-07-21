"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

export function useAnswerNotification() {
  const [notificationSoundEnabled, setNotificationSoundEnabled] = useState(true);
  const notificationSoundEnabledRef = useRef(notificationSoundEnabled);
  const answerAudioRef = useRef<AudioContext | null>(null);
  const faviconPulseTimerRef = useRef<number | null>(null);

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

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      const enabled = window.localStorage.getItem("aiqsa.answerSound") !== "off";
      notificationSoundEnabledRef.current = enabled;
      setNotificationSoundEnabled(enabled);
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    function handleVisible() {
      if (document.visibilityState === "visible") {
        stopReadyFaviconAlert();
      }
    }

    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("focus", stopReadyFaviconAlert);

    return () => {
      stopReadyFaviconAlert();
      const audioContext = answerAudioRef.current;
      answerAudioRef.current = null;
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close().catch(() => undefined);
      }
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("focus", stopReadyFaviconAlert);
    };
  }, [stopReadyFaviconAlert]);

  async function answerAudioContext() {
    if (!notificationSoundEnabledRef.current || typeof window === "undefined") {
      return null;
    }

    const AudioContextConstructor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) {
      return null;
    }

    const context = answerAudioRef.current ?? new AudioContextConstructor();
    answerAudioRef.current = context;
    if (context.state === "suspended") {
      await context.resume().catch(() => undefined);
    }

    return context;
  }

  async function primeAnswerSound() {
    await answerAudioContext().catch(() => null);
  }

  async function playAnswerSound() {
    const context = await answerAudioContext().catch(() => null);
    if (!context) {
      return false;
    }

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(1320, context.currentTime + 0.16);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.14, context.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.04, context.currentTime + 0.2);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.34);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.36);
    return true;
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
    const sounded = await playAnswerSound();
    if (sounded) {
      pulseReadyFavicon();
    }
  }

  function toggleNotificationSound() {
    setNotificationSoundEnabled((enabled) => {
      const next = !enabled;
      notificationSoundEnabledRef.current = next;
      window.localStorage.setItem("aiqsa.answerSound", next ? "on" : "off");
      if (next) {
        void primeAnswerSound();
      }
      return next;
    });
  }

  return {
    notificationSoundEnabled,
    notifyAnswerReady,
    primeAnswerSound,
    toggleNotificationSound
  };
}
