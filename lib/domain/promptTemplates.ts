export type LocalPromptTemplateOptions = {
  locale?: string | string[];
  now?: Date;
  timeZone?: string;
};

export function renderLocalPromptTemplate(value: string, options: LocalPromptTemplateOptions = {}): string {
  const now = options.now ?? new Date();
  const localDate = new Intl.DateTimeFormat(options.locale, {
    day: "numeric",
    month: "long",
    timeZone: options.timeZone,
    year: "numeric"
  }).format(now);
  const localTime = new Intl.DateTimeFormat(options.locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: options.timeZone,
    timeZoneName: "short"
  }).format(now);

  return value.replaceAll("{local_date}", localDate).replaceAll("{local_time}", localTime);
}
