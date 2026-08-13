import type {
  AssistantAvatarPalette,
  AssistantAvatarRecipe,
  AssistantAvatarShape
} from "@/lib/contracts/assistants";
import type { ReactNode } from "react";

/*
 * The recipe values live as theme-invariant `--v2-avatar-*` component tokens
 * in the sole token file (styles/tokens-v2.css); the component references
 * them so no palette value exists outside that boundary.
 */
function avatarPaletteTokens(paletteId: AssistantAvatarPalette): {
  background: string;
  foreground: string;
} {
  return {
    background: `var(--v2-avatar-${paletteId}-bg)`,
    foreground: `var(--v2-avatar-${paletteId}-fg)`
  };
}

function shapeElement(
  shape: AssistantAvatarShape,
  size: number,
  fill: string,
  opacity: number,
  rotation: number,
  key: string
): ReactNode {
  const transform = `rotate(${rotation} 24 24)`;
  const half = size / 2;
  switch (shape) {
    case "circle":
      return <circle cx={24} cy={24} fill={fill} key={key} opacity={opacity} r={half} transform={transform} />;
    case "ring":
      return (
        <circle
          cx={24}
          cy={24}
          fill="none"
          key={key}
          opacity={opacity}
          r={half - size * 0.14}
          stroke={fill}
          strokeWidth={size * 0.22}
          transform={transform}
        />
      );
    case "square":
      return (
        <rect
          fill={fill}
          height={size * 0.9}
          key={key}
          opacity={opacity}
          rx={size * 0.16}
          transform={transform}
          width={size * 0.9}
          x={24 - size * 0.45}
          y={24 - size * 0.45}
        />
      );
    case "diamond":
      return (
        <rect
          fill={fill}
          height={size * 0.74}
          key={key}
          opacity={opacity}
          rx={size * 0.12}
          transform={`${transform} rotate(45 24 24)`}
          width={size * 0.74}
          x={24 - size * 0.37}
          y={24 - size * 0.37}
        />
      );
    case "triangle": {
      const top = 24 - half * 0.92;
      const bottom = 24 + half * 0.66;
      const spread = half * 0.9;
      return (
        <path
          d={`M24 ${top} L${24 + spread} ${bottom} Q24 ${bottom + half * 0.26} ${24 - spread} ${bottom} Z`}
          fill={fill}
          key={key}
          opacity={opacity}
          transform={transform}
        />
      );
    }
    case "hexagon": {
      const radius = half * 0.96;
      const points = Array.from({ length: 6 }, (_, index) => {
        const angle = (Math.PI / 3) * index - Math.PI / 6;
        return `${24 + radius * Math.cos(angle)} ${24 + radius * Math.sin(angle)}`;
      }).join(" L");
      return <path d={`M${points} Z`} fill={fill} key={key} opacity={opacity} transform={transform} />;
    }
  }
}

/** Immutable recipe colors identify an Assistant; they never encode status. */
export function AssistantAvatarV2({
  className,
  label,
  recipe,
  size
}: Readonly<{
  className?: string;
  label?: string;
  recipe: AssistantAvatarRecipe;
  size: number;
}>) {
  const palette = avatarPaletteTokens(recipe.paletteId);
  const accents = recipe.accents.map((slot) => {
    const angle = (Math.PI / 4) * slot - Math.PI / 2;
    return {
      key: `accent-${slot}`,
      x: 24 + 16 * Math.cos(angle),
      y: 24 + 16 * Math.sin(angle)
    };
  });

  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={className}
      data-testid="assistant-avatar"
      height={size}
      role={label ? "img" : undefined}
      viewBox="0 0 48 48"
      width={size}
    >
      <rect fill={palette.background} height={48} rx={12} width={48} />
      {shapeElement(
        recipe.backgroundShape,
        40,
        palette.foreground,
        0.18,
        recipe.rotations[0] * 90,
        "background-shape"
      )}
      {shapeElement(
        recipe.foregroundShape,
        22,
        palette.foreground,
        0.95,
        recipe.rotations[1] * 90,
        "foreground-shape"
      )}
      {accents.map((accent) => (
        <circle
          cx={accent.x}
          cy={accent.y}
          fill={palette.foreground}
          key={accent.key}
          opacity={0.8}
          r={2.1}
        />
      ))}
    </svg>
  );
}
