import type { UiV2IconName } from "@/components/ui-v2";
import type { ArtifactKind } from "@/lib/contracts/artifacts";

const labels: Readonly<Record<ArtifactKind, string>> = {
  chart: "Chart",
  game: "Game",
  html: "HTML",
  image: "Image",
  slides: "Slides",
  svg: "SVG"
};

const icons: Readonly<Record<ArtifactKind, UiV2IconName>> = {
  chart: "chart",
  game: "gamepad",
  html: "globe",
  image: "image",
  slides: "slides",
  svg: "image"
};

export function artifactKindLabel(kind: ArtifactKind): string {
  return labels[kind];
}

export function artifactKindIcon(kind: ArtifactKind): UiV2IconName {
  return icons[kind];
}
