import {
  adminSectionConfig,
  adminSectionMoveForKey,
  adminSectionPath,
  defaultAdminSection,
  moveAdminSection,
  parseAdminSection,
  type AdminSection,
  type AdminSectionId
} from "@/components/admin/adminSections";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdminSectionNavigation = Readonly<{
  activeSection: AdminSectionId;
  activeSectionConfig: AdminSection;
  focusActiveTab(): void;
  onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, section: AdminSectionId): void;
  registerTab(section: AdminSectionId, node: HTMLButtonElement | null): void;
  restoreFocusAfterMutation(): void;
  selectSection(section: AdminSectionId): void;
}>;

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
  const activeSectionRef = useRef(activeSection);
  const tabRefs = useRef(new Map<AdminSectionId, HTMLButtonElement>());

  useEffect(() => {
    activeSectionRef.current = activeSection;
  }, [activeSection]);

  const registerTab = useCallback((section: AdminSectionId, node: HTMLButtonElement | null) => {
    if (node) {
      tabRefs.current.set(section, node);
      return;
    }

    tabRefs.current.delete(section);
  }, []);

  const selectSection = useCallback((section: AdminSectionId) => {
    setActiveSection(section);

    if (typeof window === "undefined") {
      return;
    }

    window.history.replaceState(null, "", adminSectionPath(window.location.href, section));
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
    const syncSection = () => setActiveSection(parseAdminSection(window.location.search));

    syncSection();
    window.addEventListener("popstate", syncSection);

    return () => window.removeEventListener("popstate", syncSection);
  }, []);

  return useMemo(
    () => ({
      activeSection,
      activeSectionConfig: adminSectionConfig(activeSection),
      focusActiveTab,
      onTabKeyDown,
      registerTab,
      restoreFocusAfterMutation,
      selectSection
    }),
    [activeSection, focusActiveTab, onTabKeyDown, registerTab, restoreFocusAfterMutation, selectSection]
  );
}
