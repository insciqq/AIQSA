import {
  adminSectionConfig,
  adminSectionMoveForKey,
  adminSectionPath,
  defaultAdminSection,
  moveAdminSection,
  normalizeAdminSectionPath,
  parseAdminSection,
  type AdminSection,
  type AdminSectionId
} from "@/components/admin/adminSections";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdminSectionNavigation = Readonly<{
  activeSection: AdminSectionId;
  activeSectionConfig: AdminSection;
  closeSectionIndex(): void;
  focusActiveTab(): void;
  openSectionIndex(): void;
  onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, section: AdminSectionId): void;
  registerTab(section: AdminSectionId, node: HTMLButtonElement | null): void;
  restoreFocusAfterMutation(): void;
  requestExit(href: string, proceed: () => void): boolean;
  sectionIndexOpen: boolean;
  selectSection(section: AdminSectionId): boolean;
}>;

export type AdminNavigationTarget =
  | Readonly<{
      href: string;
      kind: "exit";
    }>
  | Readonly<{
      href: string;
      kind: "section";
      section: AdminSectionId;
    }>
  | Readonly<{
      href: string;
      kind: "section-index";
      open: boolean;
    }>;

export type AdminBlockedNavigation = Readonly<{
  proceed(): void;
  target: AdminNavigationTarget;
}>;

export type AdminSectionNavigationOptions = Readonly<{
  canExitAdmin?(href: string): boolean;
  canSelectSection?(section: AdminSectionId): boolean;
  canToggleSectionIndex?(open: boolean): boolean;
  onNavigationBlocked?(navigation: AdminBlockedNavigation): void;
}>;

const ADMIN_HISTORY_STATE_KEY = "aiqsaControlCenter";

type AdminHistoryView = Readonly<{
  entryId: string;
  position: number;
  previousEntryId: string | null;
  sessionId: string;
  view: "section-index" | "section";
}>;

type HistoryPoint = Readonly<{
  adminView: AdminHistoryView | null;
  nativeIndex: number | null;
  nativeKey: string | null;
  path: string;
}>;

function historyStateWithAdminView(current: unknown, view: AdminHistoryView): Record<string, unknown> {
  const base = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};

  return {
    ...base,
    [ADMIN_HISTORY_STATE_KEY]: view
  };
}

function adminHistoryView(value: unknown): AdminHistoryView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = (value as Record<string, unknown>)[ADMIN_HISTORY_STATE_KEY];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const entryId = (candidate as Record<string, unknown>).entryId;
  const position = (candidate as Record<string, unknown>).position;
  const previousEntryId = (candidate as Record<string, unknown>).previousEntryId;
  const sessionId = (candidate as Record<string, unknown>).sessionId;
  const view = (candidate as Record<string, unknown>).view;
  return (view === "section-index" || view === "section") &&
    typeof entryId === "string" && entryId.length > 0 &&
    typeof position === "number" && Number.isInteger(position) && position >= 0 &&
    (previousEntryId === null || (typeof previousEntryId === "string" && previousEntryId.length > 0)) &&
    typeof sessionId === "string" && sessionId.length > 0
    ? { entryId, position, previousEntryId, sessionId, view }
    : null;
}

function currentPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function currentNavigationEntryIdentity(): Readonly<{ index: number | null; key: string | null }> {
  const navigation = (window as unknown as {
    navigation?: { currentEntry?: { index?: unknown; key?: unknown } };
  }).navigation;
  const index = navigation?.currentEntry?.index;
  const key = navigation?.currentEntry?.key;

  return {
    index: typeof index === "number" && Number.isInteger(index) ? index : null,
    key: typeof key === "string" && key.length > 0 ? key : null
  };
}

function currentHistoryPoint(): HistoryPoint {
  const native = currentNavigationEntryIdentity();
  return {
    adminView: adminHistoryView(window.history.state),
    nativeIndex: native.index,
    nativeKey: native.key,
    path: currentPath()
  };
}

function historyPointDelta(target: HistoryPoint, origin: HistoryPoint): number | null {
  if (target.nativeIndex !== null && origin.nativeIndex !== null) {
    return target.nativeIndex - origin.nativeIndex;
  }
  if (target.adminView && origin.adminView) {
    if (target.adminView.entryId === origin.adminView.entryId) return 0;
    if (target.adminView.sessionId === origin.adminView.sessionId) {
      const delta = target.adminView.position - origin.adminView.position;
      return delta === 0 ? null : delta;
    }
  }
  return null;
}

function sameHistoryPoint(left: HistoryPoint, right: HistoryPoint): boolean {
  if (left.nativeKey !== null && right.nativeKey !== null) {
    return left.nativeKey === right.nativeKey && left.path === right.path;
  }
  if (left.nativeIndex !== null && right.nativeIndex !== null) {
    return left.nativeIndex === right.nativeIndex && left.path === right.path;
  }
  if (left.adminView && right.adminView) {
    return left.adminView.entryId === right.adminView.entryId && left.path === right.path;
  }
  return false;
}

function createHistorySessionId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const createHistoryEntryId = createHistorySessionId;

function focusElement(element: HTMLElement | null) {
  if (!element) {
    return;
  }

  element.scrollIntoView?.({
    block: "start"
  });
  element.focus({
    preventScroll: true
  });
}

function hasStableDocumentFocus(): boolean {
  const activeElement = document.activeElement;

  return Boolean(
    activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      activeElement !== document.documentElement &&
      activeElement.isConnected &&
      !activeElement.hidden &&
      !activeElement.closest('[hidden], [inert], [aria-hidden="true"]')
  );
}

export function useAdminSectionNavigation({
  canExitAdmin,
  canSelectSection,
  canToggleSectionIndex,
  onNavigationBlocked
}: AdminSectionNavigationOptions = {}): AdminSectionNavigation {
  const [activeSection, setActiveSection] = useState<AdminSectionId>(defaultAdminSection);
  const [sectionIndexOpen, setSectionIndexOpen] = useState(false);
  const activeSectionRef = useRef(activeSection);
  const sectionIndexOpenRef = useRef(sectionIndexOpen);
  const tabRefs = useRef(new Map<AdminSectionId, HTMLButtonElement>());
  const adminPathnameRef = useRef<string | null>(null);
  const currentAdminViewRef = useRef<AdminHistoryView | null>(null);
  const historySessionIdRef = useRef("");
  const currentHistoryPositionRef = useRef(0);
  const currentNativeIndexRef = useRef<number | null>(null);
  const currentNativeKeyRef = useRef<string | null>(null);
  const currentPathRef = useRef<string | null>(null);
  const allowedTraversalRef = useRef<HistoryPoint | null>(null);
  const rollbackRef = useRef<null | Readonly<{
    blockedTarget: AdminNavigationTarget;
    origin: HistoryPoint;
    replayDelta: number;
    target: HistoryPoint;
  }>>(null);
  const canExitAdminRef = useRef(canExitAdmin);
  const canSelectSectionRef = useRef(canSelectSection);
  const canToggleSectionIndexRef = useRef(canToggleSectionIndex);
  const onNavigationBlockedRef = useRef(onNavigationBlocked);

  useEffect(() => {
    canExitAdminRef.current = canExitAdmin;
  }, [canExitAdmin]);

  useEffect(() => {
    canSelectSectionRef.current = canSelectSection;
  }, [canSelectSection]);

  useEffect(() => {
    canToggleSectionIndexRef.current = canToggleSectionIndex;
  }, [canToggleSectionIndex]);

  useEffect(() => {
    onNavigationBlockedRef.current = onNavigationBlocked;
  }, [onNavigationBlocked]);

  useEffect(() => {
    activeSectionRef.current = activeSection;
  }, [activeSection]);

  useEffect(() => {
    sectionIndexOpenRef.current = sectionIndexOpen;
  }, [sectionIndexOpen]);

  const registerTab = useCallback((section: AdminSectionId, node: HTMLButtonElement | null) => {
    if (node) {
      tabRefs.current.set(section, node);
      return;
    }

    tabRefs.current.delete(section);
  }, []);

  const ensureOwnedCurrentEntry = useCallback((): AdminHistoryView => {
    const path = currentPath();
    const existingView = adminHistoryView(window.history.state);
    const expectedView = currentAdminViewRef.current;
    if (
      existingView &&
      expectedView &&
      existingView.entryId === expectedView.entryId &&
      path === currentPathRef.current
    ) {
      return existingView;
    }

    // A hash navigation or another same-document owner may have inserted an
    // entry without emitting the Control Center's marker. Rebase that current
    // entry before pushing so positions remain exact traversal distances
    // inside this new, contiguous app-owned session.
    const normalizedPath = normalizeAdminSectionPath(window.location.href);
    const view: AdminHistoryView = {
      entryId: createHistoryEntryId(),
      position: 0,
      previousEntryId: null,
      sessionId: createHistorySessionId(),
      view: "section"
    };
    window.history.replaceState(
      historyStateWithAdminView(window.history.state, view),
      "",
      normalizedPath
    );
    const native = currentNavigationEntryIdentity();
    currentAdminViewRef.current = view;
    historySessionIdRef.current = view.sessionId;
    currentHistoryPositionRef.current = 0;
    currentNativeIndexRef.current = native.index;
    currentNativeKeyRef.current = native.key;
    currentPathRef.current = normalizedPath;
    return view;
  }, []);

  const commitSection = useCallback((section: AdminSectionId) => {
    const changedSection = section !== activeSectionRef.current;
    const selectedFromIndex = sectionIndexOpenRef.current;

    setActiveSection(section);
    setSectionIndexOpen(false);

    if (typeof window === "undefined") {
      return;
    }

    if (!changedSection && !selectedFromIndex) {
      return;
    }

    const baseView = ensureOwnedCurrentEntry();
    const position = baseView.position + 1;
    const href = adminSectionPath(window.location.href, section);
    const view: AdminHistoryView = {
      entryId: createHistoryEntryId(),
      position,
      previousEntryId: baseView.entryId,
      sessionId: baseView.sessionId,
      view: "section"
    };
    window.history.pushState(
      historyStateWithAdminView(window.history.state, view),
      "",
      href
    );
    const native = currentNavigationEntryIdentity();
    currentAdminViewRef.current = view;
    currentHistoryPositionRef.current = position;
    currentNativeIndexRef.current = native.index;
    currentNativeKeyRef.current = native.key;
    currentPathRef.current = href;
  }, [ensureOwnedCurrentEntry]);

  const selectSection = useCallback((section: AdminSectionId) => {
    const changedSection = section !== activeSectionRef.current;
    if (changedSection && canSelectSectionRef.current?.(section) === false) {
      const href = typeof window === "undefined"
        ? adminSectionPath("http://localhost/admin", section)
        : adminSectionPath(window.location.href, section);
      onNavigationBlockedRef.current?.({
        proceed: () => commitSection(section),
        target: { href, kind: "section", section }
      });
      return false;
    }

    commitSection(section);
    return true;
  }, [commitSection]);

  const requestExit = useCallback((href: string, proceed: () => void) => {
    if (canExitAdminRef.current?.(href) === false) {
      onNavigationBlockedRef.current?.({
        proceed,
        target: { href, kind: "exit" }
      });
      return false;
    }

    return true;
  }, []);

  const commitOpenSectionIndex = useCallback(() => {
    if (sectionIndexOpenRef.current) {
      return;
    }

    sectionIndexOpenRef.current = true;
    setSectionIndexOpen(true);
    if (typeof window === "undefined") {
      return;
    }

    const baseView = ensureOwnedCurrentEntry();
    const position = baseView.position + 1;
    const href = currentPath();
    const view: AdminHistoryView = {
      entryId: createHistoryEntryId(),
      position,
      previousEntryId: baseView.entryId,
      sessionId: baseView.sessionId,
      view: "section-index"
    };
    window.history.pushState(
      historyStateWithAdminView(window.history.state, view),
      "",
      href
    );
    const native = currentNavigationEntryIdentity();
    currentAdminViewRef.current = view;
    currentHistoryPositionRef.current = position;
    currentNativeIndexRef.current = native.index;
    currentNativeKeyRef.current = native.key;
    currentPathRef.current = href;
  }, [ensureOwnedCurrentEntry]);

  const openSectionIndex = useCallback(() => {
    if (!sectionIndexOpenRef.current && canToggleSectionIndexRef.current?.(true) === false) {
      onNavigationBlockedRef.current?.({
        proceed: commitOpenSectionIndex,
        target: { href: currentPath(), kind: "section-index", open: true }
      });
      return;
    }

    commitOpenSectionIndex();
  }, [commitOpenSectionIndex]);

  const commitCloseSectionIndex = useCallback(() => {
    if (!sectionIndexOpenRef.current) {
      return;
    }

    if (
      typeof window !== "undefined" &&
      adminHistoryView(window.history.state)?.view === "section-index"
    ) {
      sectionIndexOpenRef.current = false;
      setSectionIndexOpen(false);
      window.history.back();
      return;
    }

    sectionIndexOpenRef.current = false;
    setSectionIndexOpen(false);
  }, []);

  const closeSectionIndex = useCallback(() => {
    if (sectionIndexOpenRef.current && canToggleSectionIndexRef.current?.(false) === false) {
      onNavigationBlockedRef.current?.({
        proceed: commitCloseSectionIndex,
        target: { href: currentPath(), kind: "section-index", open: false }
      });
      return;
    }

    commitCloseSectionIndex();
  }, [commitCloseSectionIndex]);

  const focusTab = useCallback((section: AdminSectionId) => {
    if (typeof window === "undefined") {
      return;
    }

    window.setTimeout(() => tabRefs.current.get(section)?.focus(), 0);
  }, []);

  const focusActiveTab = useCallback(() => {
    const selectedTab =
      [...tabRefs.current.values()].find((tab) => tab.getAttribute("aria-selected") === "true") ??
      tabRefs.current.get(activeSectionRef.current) ??
      null;

    focusElement(selectedTab);
  }, []);

  const onTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, section: AdminSectionId) => {
      const direction = adminSectionMoveForKey(event.key);

      if (!direction) {
        return;
      }

      event.preventDefault();
      const nextSection = moveAdminSection(section, direction);
      if (selectSection(nextSection)) {
        focusTab(nextSection);
      }
    },
    [focusTab, selectSection]
  );

  const restoreFocusAfterMutation = useCallback(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const run = () => {
      if (!hasStableDocumentFocus()) {
        focusActiveTab();
      }
    };

    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(run);
      return;
    }

    window.setTimeout(run, 0);
  }, [focusActiveTab]);

  useEffect(() => {
    const applyCurrentAdminEntry = (startNewSession = false) => {
      const nextSection = parseAdminSection(window.location.search);
      setActiveSection(nextSection);
      setSectionIndexOpen(adminHistoryView(window.history.state)?.view === "section-index");

      const normalizedPath = normalizeAdminSectionPath(window.location.href);
      const existingView = adminHistoryView(window.history.state);
      if (!existingView && startNewSession) {
        historySessionIdRef.current = createHistorySessionId();
        currentHistoryPositionRef.current = 0;
      }
      const view = existingView ?? {
        entryId: createHistoryEntryId(),
        position: currentHistoryPositionRef.current,
        previousEntryId: null,
        sessionId: historySessionIdRef.current,
        view: "section" as const
      };
      if (normalizedPath !== currentPath() || !existingView) {
        window.history.replaceState(
          historyStateWithAdminView(window.history.state, view),
          "",
          normalizedPath
        );
      }

      const native = currentNavigationEntryIdentity();
      currentAdminViewRef.current = view;
      historySessionIdRef.current = view.sessionId;
      currentHistoryPositionRef.current = view.position;
      currentNativeIndexRef.current = native.index;
      currentNativeKeyRef.current = native.key;
      currentPathRef.current = normalizedPath;
    };

    const replayBlockedTraversal = (target: HistoryPoint, replayDelta: number) => {
      allowedTraversalRef.current = target;
      window.history.go(replayDelta);
    };

    const rollbackBlockedTraversal = (
      blockedTarget: AdminNavigationTarget,
      origin: HistoryPoint,
      target: HistoryPoint,
      replayDelta: number
    ) => {
      rollbackRef.current = {
        blockedTarget,
        origin,
        replayDelta,
        target
      };
      window.history.go(-replayDelta);
    };

    const syncSection = () => {
      const current = currentHistoryPoint();
      const rollback = rollbackRef.current;
      if (rollback) {
        if (!sameHistoryPoint(current, rollback.origin)) {
          const correction = historyPointDelta(rollback.origin, current);
          if (correction !== null && correction !== 0) {
            window.history.go(correction);
            return;
          }
          rollbackRef.current = null;
          if (window.location.pathname === adminPathnameRef.current) {
            applyCurrentAdminEntry(!current.adminView);
          }
          return;
        }

        rollbackRef.current = null;
        if (rollback.origin.adminView) {
          currentAdminViewRef.current = rollback.origin.adminView;
          historySessionIdRef.current = rollback.origin.adminView.sessionId;
          currentHistoryPositionRef.current = rollback.origin.adminView.position;
        }
        currentNativeIndexRef.current = rollback.origin.nativeIndex;
        currentNativeKeyRef.current = rollback.origin.nativeKey;
        currentPathRef.current = rollback.origin.path;
        onNavigationBlockedRef.current?.({
          proceed: () => replayBlockedTraversal(rollback.target, rollback.replayDelta),
          target: rollback.blockedTarget
        });
        return;
      }

      const allowedTarget = allowedTraversalRef.current;
      if (allowedTarget) {
        if (!sameHistoryPoint(current, allowedTarget)) {
          const correction = historyPointDelta(allowedTarget, current);
          if (correction !== null && correction !== 0) {
            window.history.go(correction);
            return;
          }
        }
        allowedTraversalRef.current = null;
        if (window.location.pathname === adminPathnameRef.current) {
          applyCurrentAdminEntry(!allowedTarget.adminView);
        }
        return;
      }

      const targetPath = currentPath();
      const origin: HistoryPoint = {
        adminView: currentAdminViewRef.current,
        nativeIndex: currentNativeIndexRef.current,
        nativeKey: currentNativeKeyRef.current,
        path: currentPathRef.current ?? targetPath
      };
      const replayDelta = historyPointDelta(current, origin);

      if (window.location.pathname !== adminPathnameRef.current) {
        // All product-owned exits use document navigation and are protected by
        // beforeunload. Post-popstate rollback races the router and is reserved
        // for entries owned by this Control Center session.
        return;
      }

      const nextSection = parseAdminSection(window.location.search);
      const nextIndexOpen = current.adminView?.view === "section-index";
      const indexViewChanged = nextIndexOpen !== sectionIndexOpenRef.current;
      if (
        ((nextSection !== activeSectionRef.current &&
          canSelectSectionRef.current?.(nextSection) === false) ||
          (nextSection === activeSectionRef.current && indexViewChanged &&
            canToggleSectionIndexRef.current?.(nextIndexOpen) === false)) &&
        replayDelta !== null && replayDelta !== 0
      ) {
        rollbackBlockedTraversal(
          nextSection !== activeSectionRef.current
            ? { href: targetPath, kind: "section", section: nextSection }
            : { href: targetPath, kind: "section-index", open: nextIndexOpen },
          origin,
          current,
          replayDelta
        );
        return;
      }

      applyCurrentAdminEntry(!current.adminView);
    };

    adminPathnameRef.current = window.location.pathname;
    const initialView = adminHistoryView(window.history.state);
    currentAdminViewRef.current = initialView;
    historySessionIdRef.current = initialView?.sessionId ?? createHistorySessionId();
    currentHistoryPositionRef.current = initialView?.position ?? 0;
    applyCurrentAdminEntry();
    window.addEventListener("popstate", syncSection);

    return () => window.removeEventListener("popstate", syncSection);
  }, []);

  return useMemo(
    () => ({
      activeSection,
      activeSectionConfig: adminSectionConfig(activeSection),
      closeSectionIndex,
      focusActiveTab,
      openSectionIndex,
      onTabKeyDown,
      registerTab,
      requestExit,
      restoreFocusAfterMutation,
      sectionIndexOpen,
      selectSection
    }),
    [
      activeSection,
      closeSectionIndex,
      focusActiveTab,
      openSectionIndex,
      onTabKeyDown,
      registerTab,
      requestExit,
      restoreFocusAfterMutation,
      sectionIndexOpen,
      selectSection
    ]
  );
}
