import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { Sandbox, Image, Rule, Destination, NetworkPolicy, type DnsBuilder } from 'microsandbox';
import { ensureBundledMicrosandboxRuntime } from '../lib/server/workspace/microsandboxInstall';

async function main() {
  if (process.env.AIQSA_AGENT_GATEWAY_PROBE_DISPOSABLE !== '1' || !process.env.MSB_HOME?.includes('agent-probe')) throw new Error('disposable_target_required');
  await ensureBundledMicrosandboxRuntime();
  const image = process.env.AIQSA_AGENT_PROBE_IMAGE ?? 'aiqsa-workspace:0.1.27';
  await Image.load('/opt/aiqsa/workspace-image.oci.tar', { tag: image });
  const server = createServer((_request, response) => response.end('agent-route-ok'));
  const other = createServer((_request, response) => response.end('must-not-reach'));
  const privateAddress = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
  if (!privateAddress || !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/u.test(privateAddress)) throw new Error('private_probe_network_required');
  await new Promise<void>((resolve) => server.listen(4311, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => other.listen(4310, '0.0.0.0', resolve));
  if (await (await fetch(`http://${privateAddress}:4310`, { signal: AbortSignal.timeout(2000) })).text() !== 'must-not-reach') throw new Error('private_probe_listener_unavailable');
  const name = 'aiqsa-agent-probe-' + randomUUID();
  let sandbox: Awaited<ReturnType<ReturnType<typeof Sandbox.builder>['connectOrCreate']>> | undefined;
  try {
    sandbox = await Sandbox.builder(name).detached(true).image(image)
      .rootDisk(10240).cpus(1).memory(1024).deploymentProfile('single-tenant').security('restricted')
      .network((network) => network.policy({defaultEgress:'deny', defaultIngress:'deny', rules:[
        Rule.allowDns(), Rule.allowEgress(Destination.group('public')),
        {...Rule.allowEgress(Destination.group('host')),protocols:['tcp'],ports:[{start:4311,end:4311}]}
      ]}).dns((dns: InstanceType<typeof DnsBuilder>) => dns.rebindProtection(true)).trustHostCAs(false).maxConnections(256)).connectOrCreate();
    const result = await sandbox.execWith('/usr/bin/python3', (b) => b.args(['-I','-c',
      "import urllib.request,json,socket,subprocess\nbase='http://host.microsandbox.internal:'\nr=False\nreason='none'\ntry: r=urllib.request.urlopen(base+'4311',timeout=5).read()==b'agent-route-ok'\nexcept Exception as e: reason=type(e).__name__+':'+type(getattr(e,'reason',None)).__name__+':'+str(getattr(getattr(e,'reason',None),'errno',None))\nblocked=False\ntry: urllib.request.urlopen(base+'4310',timeout=2)\nexcept Exception: blocked=True\ndef denied(host,port=80):\n try:\n  with socket.create_connection((host,port),timeout=1): return False\n except Exception: return True\nmetadata=denied('169.254.169.254')\nprivate=denied(" + JSON.stringify(privateAddress) + ",4310)\nversion=subprocess.check_output(['/usr/local/bin/codex','--version'],text=True).strip()\nprint(json.dumps({'gateway_reachable':r,'control_blocked':blocked,'metadata_blocked':metadata,'private_blocked':private,'codex_version':version,'reason':reason}))\nraise SystemExit(0 if r and blocked and metadata and private and version=='codex-cli 0.154.0' else 1)"]).timeout(15000));
    const evidence = JSON.parse(result.stdout());
    console.log(JSON.stringify({ gateway_reachable: evidence.gateway_reachable === true, control_blocked: evidence.control_blocked === true,
      metadata_blocked: evidence.metadata_blocked === true, private_blocked: evidence.private_blocked === true,
      codex_version: evidence.codex_version === 'codex-cli 0.154.0' ? evidence.codex_version : 'unexpected', reason: String(evidence.reason).slice(0,80) }));
    if (!result.success) process.exitCode=1;
    await sandbox.stop(); await Sandbox.remove(name); sandbox = undefined;
    sandbox = await Sandbox.builder(name).detached(true).image(image).rootDisk(10240).cpus(1).memory(1024)
      .deploymentProfile('multi-tenant').security('restricted').network((network) => network.policy(NetworkPolicy.none())).connectOrCreate();
    const off = await sandbox.execWith('/usr/bin/python3', (builder) => builder.args(['-I', '-c',
      "import urllib.request,json\nblocked=True\ntry:\n urllib.request.urlopen('http://host.microsandbox.internal:4311',timeout=2)\n blocked=False\nexcept Exception: pass\nprint(json.dumps({'internet_off_gateway_blocked':blocked}))\nraise SystemExit(0 if blocked else 1)"]).timeout(5000));
    console.log(JSON.stringify({ internet_off_gateway_blocked: off.success && JSON.parse(off.stdout()).internet_off_gateway_blocked === true }));
    if (!off.success) process.exitCode = 1;
  } finally {
    if (sandbox) { await sandbox.stop(); await Sandbox.remove(name); }
    server.close();other.close();
    console.log(JSON.stringify({cleanup_complete:true}));
  }
}
main().catch((e)=>{console.log(JSON.stringify({success:false,code:e?.name??'probe_failed', detail:String(e?.message??'').replace(/\/[^\s,;]+/g,'<path>').replace(/aiqsa-agent-probe-[a-f0-9-]+/g,'<sandbox>').slice(0,400)}));process.exitCode=1});
