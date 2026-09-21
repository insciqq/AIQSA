const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const timeFormatter = new Intl.DateTimeFormat("en-US", { timeStyle: "short" });

export function formatStudioDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not set" : dateFormatter.format(date);
}

export function formatStudioTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not set" : timeFormatter.format(date);
}
