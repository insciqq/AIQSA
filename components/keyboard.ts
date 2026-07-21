export type KeyboardCompositionEvent = {
  isComposing?: boolean;
  key: string;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
  };
};

export function isImeCompositionEvent(event: KeyboardCompositionEvent): boolean {
  return (
    event.isComposing === true ||
    event.nativeEvent?.isComposing === true ||
    event.key === "Process" ||
    event.keyCode === 229
  );
}
