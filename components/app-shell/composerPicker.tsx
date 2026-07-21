import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import { isImeCompositionEvent } from "@/components/keyboard";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type AriaAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefCallback
} from "react";

type PickerInitialFocus = "search" | "selected";

type ComposerPickerOptions<T> = {
  defaultOpen?: boolean;
  disabled?: boolean;
  dialogId: string;
  initialFocus: PickerInitialFocus;
  itemFocusPreventScroll?: boolean;
  items: readonly T[];
  onClose?: () => void;
  onOpenChange?: (open: boolean) => void;
  onSelect(item: T): void;
  open?: boolean;
  openFromTriggerKeys?: boolean;
  scrollMargins?: { bottom?: number; top?: number };
  selectedIndex: number;
};

type PickerItemProps = {
  onClick(): void;
  onFocus(): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void;
  onMouseMove(): void;
  ref: RefCallback<HTMLButtonElement>;
  tabIndex: number;
};

type PickerTriggerProps = Pick<AriaAttributes, "aria-controls" | "aria-expanded" | "aria-haspopup"> & {
  onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void;
};

function scrollRowWithin(
  container: HTMLElement | null,
  row: HTMLElement | null,
  margins: { bottom?: number; top?: number } = {}
) {
  if (!container || !row) {
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const top = margins.top ?? 0;
  const bottom = margins.bottom ?? 0;
  if (rowRect.top < containerRect.top + top) {
    container.scrollTop -= containerRect.top + top - rowRect.top;
  } else if (rowRect.bottom > containerRect.bottom - bottom) {
    container.scrollTop += rowRect.bottom - (containerRect.bottom - bottom);
  }
}

export function useComposerPickerSession<T>({
  defaultOpen = false,
  disabled = false,
  dialogId,
  initialFocus,
  itemFocusPreventScroll = false,
  items,
  onClose,
  onOpenChange,
  onSelect,
  open: controlledOpen,
  openFromTriggerKeys = false,
  scrollMargins,
  selectedIndex
}: ComposerPickerOptions<T>) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const [activeIndex, setActiveIndex] = useState(() => Math.max(selectedIndex, 0));
  const boundaryRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const wasOpenRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onOpenChangeRef = useRef(onOpenChange);
  const navigableIndex = items.length > 0 ? Math.min(Math.max(activeIndex, 0), items.length - 1) : -1;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  const changeOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) {
        setLocalOpen(nextOpen);
      }
      onOpenChangeRef.current?.(nextOpen);
    },
    [controlledOpen]
  );

  const close = useCallback(() => {
    changeOpen(false);
  }, [changeOpen]);

  const dialogRef = useDialogFocus<HTMLDivElement>({
    active: open,
    autoFocus: false,
    containFocus: false,
    onClose: close,
    restoreFocus: () => triggerRef.current
  });

  useEffect(() => {
    itemRefs.current.length = items.length;
  }, [items.length]);

  useEffect(() => {
    if (open) {
      if (wasOpenRef.current) {
        return;
      }

      wasOpenRef.current = true;
      if (initialFocus === "search") {
        searchRef.current?.focus();
      } else {
        itemRefs.current[navigableIndex]?.focus();
      }
      return;
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      onCloseRef.current?.();
    }
  }, [initialFocus, navigableIndex, open]);

  useEffect(() => {
    if (!disabled || !open) {
      return;
    }

    const timer = window.setTimeout(close, 0);
    return () => window.clearTimeout(timer);
  }, [close, disabled, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (boundaryRef.current && !boundaryRef.current.contains(event.target as Node)) {
        close();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [close, open]);

  useEffect(() => {
    if (scrollMargins === undefined) {
      return;
    }
    scrollRowWithin(resultsRef.current, itemRefs.current[navigableIndex], scrollMargins);
  }, [items, navigableIndex, scrollMargins]);

  function focusItem(index: number) {
    itemRefs.current[index]?.focus(itemFocusPreventScroll ? { preventScroll: true } : undefined);
  }

  function boundedIndex(nextIndex: number) {
    if (items.length === 0) {
      return -1;
    }
    return (nextIndex + items.length) % items.length;
  }

  function moveActive(nextIndex: number, moveFocus: boolean) {
    const bounded = boundedIndex(nextIndex);
    if (bounded < 0) {
      return;
    }

    setActiveIndex(bounded);
    if (moveFocus) {
      focusItem(bounded);
    }
  }

  function selectIndex(index: number) {
    const item = items[index];
    if (item === undefined) {
      return;
    }

    setActiveIndex(index);
    onSelect(item);
    close();
  }

  function handleNavigation(
    event: ReactKeyboardEvent<HTMLElement>,
    index: number,
    moveFocus: boolean
  ) {
    if (isImeCompositionEvent(event)) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(index + 1, moveFocus);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(index - 1, moveFocus);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveActive(0, moveFocus);
    } else if (event.key === "End") {
      event.preventDefault();
      moveActive(items.length - 1, moveFocus);
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectIndex(index);
    } else if (event.key === "Tab" && !event.shiftKey && !moveFocus && items[index] !== undefined) {
      event.preventDefault();
      focusItem(index);
      if (scrollMargins !== undefined) {
        scrollRowWithin(resultsRef.current, itemRefs.current[index], scrollMargins);
      }
    }
  }

  function openAt(index: number) {
    setActiveIndex(items.length > 0 ? Math.min(Math.max(index, 0), items.length - 1) : 0);
    triggerRef.current?.focus();
    changeOpen(true);
  }

  function toggle() {
    if (open) {
      close();
    } else {
      openAt(Math.max(selectedIndex, 0));
    }
  }

  const triggerProps: PickerTriggerProps = {
    "aria-controls": open ? dialogId : undefined,
    "aria-expanded": open,
    "aria-haspopup": "dialog",
    onKeyDown(event) {
      if (
        isImeCompositionEvent(event) ||
        open ||
        !openFromTriggerKeys ||
        !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
      ) {
        return;
      }

      event.preventDefault();
      openAt(event.key === "End" || event.key === "ArrowUp" ? items.length - 1 : 0);
    }
  };

  function getItemProps(index: number): PickerItemProps {
    return {
      onClick: () => selectIndex(index),
      onFocus: () => setActiveIndex(index),
      onKeyDown: (event) => handleNavigation(event, index, true),
      onMouseMove: () => setActiveIndex(index),
      ref: (node) => {
        itemRefs.current[index] = node;
      },
      tabIndex: index === navigableIndex ? 0 : -1
    };
  }

  return {
    boundaryProps: {
      onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
        if (isImeCompositionEvent(event)) {
          event.stopPropagation();
          return;
        }

        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }
    },
    boundaryRef,
    close,
    dialogProps: {
      "aria-modal": false as const,
      id: dialogId,
      role: "dialog" as const
    },
    dialogRef,
    getItemProps,
    handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
      handleNavigation(event, navigableIndex, false);
    },
    navigableIndex,
    open,
    resultsRef,
    searchRef,
    setActiveIndex,
    toggle,
    triggerProps,
    triggerRef
  };
}
