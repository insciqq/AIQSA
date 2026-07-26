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
  sectionIndexOpen: boolean;
  selectSection(section: AdminSectionId): void;
}>;

const ADMIN_HISTORY_STATE_KEY = "aiqsaControlCenter";

type AdminHistoryView = Readonly<{
  view: "section-index" | "section";
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

  const view = (candidate as Record<string, unknown>).view;
  return view === "section-index" || view === "section" ? { view } : null;
}

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

export function useAdminSectionNavigation(): AdminSectionNavigation {
  const [activeSection, setActiveSection] = useState<AdminSectionId>(defaultAdminSection);
  const [sectionIndexOpen, setSectionIndexOpen] = useState(false);
  const activeSectionRef = useRef(activeSection);
  const sectionIndexOpenRef = useRef(sectionIndexOpen);
  const tabRefs = useRef(new Map<AdminSectionId, HTMLButtonElement>());

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

  const selectSection = useCallback((section: AdminSectionId) => {
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

    window.history.pushState(
      historyStateWithAdminView(window.history.state, { view: "section" }),
      "",
      adminSectionPath(window.location.href, section)
    );
  }, []);

  const openSectionIndex = useCallback(() => {
    if (sectionIndexOpenRef.current) {
      return;
    }

    setSectionIndexOpen(true);
    if (typeof window === "undefined") {
      return;
    }

    window.history.pushState(
      historyStateWithAdminView(window.history.state, { view: "section-index" }),
      "",
      `${window.location.pathname}${window.location.search}${window.location.hash}`
    );
  }, []);

  const closeSectionIndex = useCallback(() => {
    if (!sectionIndexOpenRef.current) {
      return;
    }

    if (
      typeof window !== "undefined" &&
      adminHistoryView(window.history.state)?.view === "section-index"
    ) {
      window.history.back();
      return;
    }

    setSectionIndexOpen(false);
  }, []);

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
      selectSection(nextSection);
      focusTab(nextSection);
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
    const syncSection = () => {
      setActiveSection(parseAdminSection(window.location.search));
      setSectionIndexOpen(adminHistoryView(window.history.state)?.view === "section-index");

      const normalizedPath = normalizeAdminSectionPath(window.location.href);
      const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (normalizedPath !== currentPath) {
        window.history.replaceState(window.history.state, "", normalizedPath);
      }
    };

    syncSection();
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
      restoreFocusAfterMutation,
      sectionIndexOpen,
      selectSection
    ]
  );
}
