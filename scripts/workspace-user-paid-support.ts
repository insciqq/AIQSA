import { codexLbOverridesFromConfig } from "./memory-mcp-codex-smoke-support";

type Service = { environment: Record<string, string>; image: string; ports?: { target: number; published: string; host_ip: string }[] };
export type PaidStand = { name: string; services: Record<string, Service> };

export function requirePaidStand(mode: string | undefined, value: PaidStand) {
  if (mode !== "DISPOSABLE") throw new Error("workspace_user_paid_opt_in_required");
  if (!/^aiqsa-ws-paid-[a-f0-9]{12}$/u.test(value.name)) throw new Error("workspace_user_paid_project_invalid");
  const app = value.services.app;
  const runner = value.services["workspace-runner"];
  const maintenance = value.services["workspace-maintenance"];
  const memoryWorker = value.services["memory-worker"];
  if (!app || !runner || !maintenance) throw new Error("workspace_user_paid_roles_missing");
  if (app.environment.NODE_ENV === "production" && !memoryWorker) {
    throw new Error("workspace_user_paid_deletion_worker_required");
  }
  for (const role of [app, runner, maintenance, ...(memoryWorker ? [memoryWorker] : [])]) {
    const env = role.environment;
    if (env.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME !== "0" ||
      env.AIQSA_WORKSPACE_MEMORY_MIB !== "1024" || env.AIQSA_WORKSPACE_CPUS !== "1" ||
      env.AIQSA_WORKSPACE_MAX_TOOL_ROUNDS !== "12" || env.AIQSA_WORKSPACE_MAX_TOOL_CALLS !== "30" ||
      env.AIQSA_WORKSPACE_TURN_TIMEOUT_SECONDS !== "600") throw new Error("workspace_user_paid_runtime_bounds_invalid");
  }
  const port = (role: Service, target: number) => {
    const entry = role.ports?.find((item) => item.target === target);
    if (!entry || entry.host_ip !== "127.0.0.1" || !/^\d+$/u.test(entry.published) ||
      Number(entry.published) < 1024 || Number(entry.published) > 65535) throw new Error("workspace_user_paid_loopback_required");
    return entry.published;
  };
  const tls = value.services["browser-tls"];
  const baseUrl = tls
    ? `https://127.0.0.1:${port(tls, 8443)}`
    : `http://127.0.0.1:${port(app, 3000)}`;
  if (tls && app.environment.AIQSA_APP_BASE_URL !== baseUrl) {
    throw new Error("workspace_user_paid_tls_origin_mismatch");
  }
  if (tls && app.ports?.some(entry => entry.host_ip !== "127.0.0.1")) {
    throw new Error("workspace_user_paid_loopback_required");
  }
  const database = new URL(app.environment.DATABASE_URL);
  if (database.protocol !== "postgresql:" || database.hostname !== "postgres" || database.pathname !== "/aiqsa" ||
    !database.password || database.username !== "aiqsa") throw new Error("workspace_user_paid_database_invalid");
  database.hostname = "127.0.0.1";
  database.port = port(value.services.postgres, 5432);
  database.search = "";
  return { baseUrl, databaseUrl: database.toString(), project: value.name };
}

export function codexLbRoute(config: string) {
  const checked = codexLbOverridesFromConfig(config);
  const setting = (key: string) => {
    const raw = checked.args.find((arg) => arg.startsWith(`model_providers.codex-lb.${key}=`))?.split("=").slice(1).join("=") ?? "";
    return raw.startsWith('"') ? JSON.parse(raw) as string : raw.slice(1, -1);
  };
  if (setting("wire_api") !== "responses" || /fake/iu.test(checked.configuredModel)) {
    throw new Error("workspace_user_paid_codex_lb_responses_required");
  }
  const root = new URL(setting("base_url"));
  // codex-lb documents separate CLI and OpenAI-compatible roots:
  // https://soju06.github.io/codex-lb/client-setup/
  // Keep the reviewed origin/key/model; only map its exact CLI route.
  if (root.pathname.replace(/\/$/u, "") === "/backend-api/codex") root.pathname = "/v1";
  return { apiRoot: root.toString().replace(/\/$/u, ""), model: checked.configuredModel };
}

export const csvInput = `invoice_id,region,amount,status
INV-101, North ,120.50,paid
INV-102,South,80.00,paid
INV-103,North,15.25,refunded
INV-104,South,40.00,pending
INV-102,South,80.00,paid
INV-105,North,19.50,paid
INV-106,East,0.00,paid
`;

export const pricingInput = `def invoice_total(items, tax_percent):
    subtotal = sum(float(item["unit_price"]) * int(item["quantity"]) for item in items)
    return round(subtotal * (1 + float(tax_percent) / 100), 2)
`;

export const pricingTests = `import unittest
from pricing import invoice_total

class InvoiceTests(unittest.TestCase):
    def test_invoice(self):
        self.assertEqual(invoice_total([{"unit_price": "19.99", "quantity": 2}, {"unit_price": "5.00", "quantity": 1}], "10"), "49.48")
    def test_half_cent(self):
        self.assertEqual(invoice_total([{"unit_price": "0.05", "quantity": 1}], "10"), "0.06")
    def test_empty(self):
        self.assertEqual(invoice_total([], "20"), "0.00")
    def test_negative_quantity(self):
        with self.assertRaises(ValueError):
            invoice_total([{"unit_price": "2.00", "quantity": -1}], "0")

if __name__ == "__main__":
    unittest.main()
`;

export const scheduleInput = JSON.stringify({ sessions: [
  { id: "S1", title: "Opening workshop", start_utc: "2026-10-06T09:00:00Z", minutes: 60 },
  { id: "S2", title: "Data practice", start_utc: "2026-10-06T11:00:00Z", minutes: 45 },
  { id: "S3", title: "Wrap up", start_utc: "2026-10-07T09:00:00Z", minutes: 30 }
] }, null, 2);

export const scheduleRules = "Export agenda CSV columns id,title,start_utc,end_utc in chronological order, using UTC timestamps ending in Z. Calendar events must use UTC DTSTART/DTEND and the session id as UID. No network access or third-party packages are needed. Keep a reusable Python generator in the Workspace project.\n";

// This fixed oracle runs in a disposable networkless container. Generated
// Python is never executed on the operator host or inside the app service.
export const artifactOracle = String.raw`
import base64,csv,io,json,sys,types
from decimal import Decimal
data=json.load(sys.stdin)
files={k:base64.b64decode(v).decode("utf-8-sig") for k,v in data["files"].items()}
case=data["case"]
if case=="csv":
    rows=list(csv.DictReader(io.StringIO(files["cleaned.csv"])))
    assert [(r["invoice_id"],r["region"],Decimal(r["amount"])) for r in rows]==[("INV-101","North",Decimal("120.50")),("INV-102","South",Decimal("80")),("INV-105","North",Decimal("19.50")),("INV-106","East",Decimal("0"))]
    summary=json.loads(files["summary.json"])
    assert summary["invoice_count"]==4 and Decimal(str(summary["total"]))==220
    assert {k:Decimal(str(v)) for k,v in summary["by_region"].items()}=={"North":Decimal("140"),"South":Decimal("80"),"East":Decimal("0")}
    assert len(files["report.md"].strip())>=40
elif case=="code":
    module=types.ModuleType("pricing")
    exec(compile(files["pricing.py"],"pricing.py","exec"),module.__dict__)
    fn=module.invoice_total
    assert fn([{"unit_price":"19.99","quantity":2},{"unit_price":"5.00","quantity":1}],"10")=="49.48"
    assert fn([{"unit_price":"0.05","quantity":1}],"10")=="0.06"
    assert fn([{"unit_price":"2.675","quantity":1}],"0")=="2.68"
    assert fn([{"unit_price":"0.10","quantity":3}],"0")=="0.30"
    assert fn([],"20")=="0.00"
    for item in [{"unit_price":"2.00","quantity":-1},{"unit_price":"-1.00","quantity":1}]:
        try: fn([item],"0")
        except ValueError: pass
        else: raise AssertionError("negative_input_accepted")
    assert "OK" in files["test-results.txt"] and "Ran 4 tests" in files["test-results.txt"]
else:
    revised=case=="schedule_revised"
    suffix="-v2" if revised else ""
    rows=list(csv.DictReader(io.StringIO(files["agenda"+suffix+".csv"])))
    expected=[("S1","2026-10-06T09:00:00Z","2026-10-06T10:00:00Z"),("S2","2026-10-06T12:30:00Z" if revised else "2026-10-06T11:00:00Z","2026-10-06T13:15:00Z" if revised else "2026-10-06T11:45:00Z"),("S3","2026-10-07T09:00:00Z","2026-10-07T09:30:00Z")]
    assert [(r["id"],r["start_utc"],r["end_utc"]) for r in rows]==expected
    text=files["calendar"+suffix+".ics"].replace("\r\n ","").replace("\r\n", "\n")
    events=[]
    for block in text.split("BEGIN:VEVENT")[1:]:
        fields=dict(line.split(":",1) for line in block.split("END:VEVENT")[0].strip().splitlines() if ":" in line)
        events.append((fields["UID"],fields["DTSTART"],fields["DTEND"]))
    compact=lambda t:t.replace("-","").replace(":","")
    assert sorted(events)==sorted((key,compact(start),compact(end)) for key,start,end in expected)
print(json.dumps({"oraclePassed":True}))
`;
