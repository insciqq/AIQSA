// Read-only, content-free health report from the persisted telemetry, run by
// `./aiqsa.sh health` inside the app image:
//   node --import tsx scripts/health-report.ts [--since 24h|7d|30d] [--json] [--run <reference>]
// Exit codes: 0 report printed, 1 the database could not be read, 2 usage.
import {
  collectHealthReport,
  collectHealthRunReport,
  formatHealthReport,
  formatHealthRunReport,
  HEALTH_REPORT_USAGE,
  parseHealthReportArgs
} from "../lib/server/admin/health/report";

// stdout carries only the report: structured log lines of the services it
// reuses (for example a queue that could not be read) go to stderr.
const writeReport = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

async function main(): Promise<void> {
  const args = parseHealthReportArgs(process.argv.slice(2));
  if ("error" in args) {
    process.stderr.write(`${args.error}\n${HEALTH_REPORT_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    writeReport(`${HEALTH_REPORT_USAGE}\n`);
    return;
  }
  // Loaded only now so a usage error never opens a database client.
  const { closeHealthReportSources, healthReportFailureCode, healthReportSources } = await import("../lib/server/admin/health/reportDefault");
  try {
    const report = args.run === null
      ? await collectHealthReport(healthReportSources, args.range)
      : await collectHealthRunReport(healthReportSources, args.run);
    if (args.json) writeReport(`${JSON.stringify(report, null, 2)}\n`);
    else writeReport(report.kind === "health" ? formatHealthReport(report) : formatHealthRunReport(report));
  } catch (error) {
    process.stderr.write(`Cannot read health telemetry (health_report_failed: ${healthReportFailureCode(error)}).\n`);
    process.exitCode = 1;
  } finally {
    await closeHealthReportSources().catch(() => undefined);
  }
}

void main().catch(() => {
  process.stderr.write("Cannot read health telemetry (health_report_failed: startup).\n");
  process.exitCode = 1;
});
