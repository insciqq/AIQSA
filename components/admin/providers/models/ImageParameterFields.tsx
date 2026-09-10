"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { imageParameterDefinitions, type ImageGenerationParameters, type ImageModelConfiguration, type ImageParameterName } from "@/lib/contracts/imageGeneration";

const labels: Record<ImageParameterName, string> = {
  size: "Image size", quality: "Image quality", background: "Background", output_format: "Output format",
  output_compression: "Compression quality", input_fidelity: "Reference fidelity", aspect_ratio: "Aspect ratio",
  image_size: "Resolution", mime_type: "Output format", thinking_level: "Reasoning", resolution: "Resolution", seed: "Seed"
};

export function ImageParameterFields({ image, modelId, parameters, disabled, onChange, defaultLabel = "Provider default" }: {
  image: ImageModelConfiguration;
  modelId: string;
  parameters: ImageGenerationParameters;
  disabled?: boolean;
  defaultLabel?: string;
  onChange(parameters: ImageGenerationParameters): void;
}) {
  const definitions = imageParameterDefinitions(image, modelId);
  return <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
    {Object.entries(definitions).map(([name, definition]) => {
      const key = name as ImageParameterName;
      const update = (value: string) => {
        const next = { ...parameters };
        if (value === "") delete next[key];
        else next[key] = definition.type === "range" ? Number(value) : value;
        onChange(next);
      };
      return <label className="block min-w-0" key={name}>
        <span className="mb-1 block text-xs font-medium text-ink-secondary">{labels[key]}</span>
        {definition.type === "enum" ? <select aria-label={labels[key]} className={inputClass} disabled={disabled} onChange={(event) => update(event.currentTarget.value)} value={parameters[key] ?? ""}>
          <option value="">{defaultLabel}</option>
          {definition.values.map((value) => <option key={value} value={value}>{value}</option>)}
        </select> : <input aria-label={labels[key]} className={inputClass} disabled={disabled}
          min={definition.type === "range" ? definition.min : undefined} max={definition.type === "range" ? definition.max : undefined}
          onChange={(event) => update(event.currentTarget.value)} placeholder={definition.type === "dimensions" ? "auto or 1536x1024" : defaultLabel}
          step={definition.type === "range" ? 1 : undefined} type={definition.type === "range" ? "number" : "text"} value={parameters[key] ?? ""} />}
      </label>;
    })}
  </div>;
}
