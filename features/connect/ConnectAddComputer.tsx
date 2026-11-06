"use client";

import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import {
  CONNECT_CLIENT_DOWNLOAD_PREFIX,
  CONNECT_INSTALL_SCRIPT_PATH,
  connectClientBinaryName,
  connectClientDownloadPath,
  type ConnectArch
} from "@/lib/contracts/connect";
import { useEffect, useId, useState, useSyncExternalStore } from "react";

type AddComputerOs = "posix" | "windows";

const ARCH_LABELS: Readonly<Record<ConnectArch, string>> = { amd64: "x64", arm64: "ARM64" };

/** `/connect/download/windows-<arch>`: the installer named after this installation (D-13). */
export function connectWindowsDownloadPath(arch: ConnectArch): string {
  return `${CONNECT_CLIENT_DOWNLOAD_PREFIX}/windows-${arch}`;
}

/** An address the Windows file name cannot carry: the host is an IPv6 literal. */
export function connectOriginIsIpv6(origin: string): boolean {
  try {
    return new URL(origin).hostname.startsWith("[");
  } catch {
    return false;
  }
}

function originHost(origin: string): string {
  try {
    const url = new URL(origin);
    return `${url.protocol === "http:" ? "http_" : ""}${url.host.replace(":", "_")}`;
  } catch {
    return origin;
  }
}

export function connectPosixInstallSteps(origin: string): readonly Readonly<{ command: string; description: string; title: string }>[] {
  return [
    {
      command: `curl -fsSL ${origin}${CONNECT_INSTALL_SCRIPT_PATH} | sh`,
      description: "Installs aiqsa-connect into ~/.local/bin on macOS, Linux or WSL. No administrator rights are needed.",
      title: "Install AIQSA Connect"
    },
    {
      command: `aiqsa-connect login ${origin}`,
      description: "Shows a code and a link. Open the link and approve the computer.",
      title: "Connect the computer"
    },
    {
      command: "aiqsa-connect service install",
      description: "Keeps AIQSA Connect running in the background and after a restart.",
      title: "Keep it running"
    }
  ];
}

type UserAgentData = Readonly<{
  platform?: string;
  getHighEntropyValues?(hints: readonly string[]): Promise<Readonly<{ architecture?: string }>>;
}>;

function userAgentData(): UserAgentData | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData ?? null;
}

const subscribeNever = () => () => undefined;

/** Windows when this browser says so; macOS and Linux otherwise. */
function guessOs(): AddComputerOs {
  const platform = userAgentData()?.platform ?? navigator.userAgent;
  return /mac|linux|x11|cros|android|iphone|ipad/iu.test(platform) && !/windows/iu.test(platform) ? "posix" : "windows";
}

/** ARM64 only when the browser reports an ARM Windows; x64 otherwise, as most PCs are. */
function useWindowsArch(): ConnectArch {
  const [arch, setArch] = useState<ConnectArch>("amd64");
  useEffect(() => {
    const data = userAgentData();
    if (!data?.getHighEntropyValues || !/windows/iu.test(data.platform ?? "")) return;
    let active = true;
    data.getHighEntropyValues(["architecture"]).then((values) => {
      if (active && values.architecture === "arm") setArch("arm64");
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return arch;
}

function CommandBlock({ command, label }: Readonly<{ command: string; label: string }>) {
  const [copy, setCopy] = useState<"copied" | "error" | "idle">("idle");
  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopy("copied");
    } catch {
      setCopy("error");
    }
  }
  return (
    <div className="v2-connect-command">
      <pre aria-label={label} tabIndex={0}><code>{command}</code></pre>
      <UiV2Button icon="copy" onClick={() => void copyCommand()}>{copy === "copied" ? "Copied" : "Copy"}</UiV2Button>
      {copy === "error" ? <p className="text-metadata text-ink-muted" role="status">Select the command and copy it.</p> : null}
    </div>
  );
}

function Step({ children, number, title }: Readonly<{ children?: React.ReactNode; number: number; title: React.ReactNode }>) {
  return (
    <li className="v2-connect-step">
      <span aria-hidden="true" className="v2-connect-step-number">{number}</span>
      <div className="min-w-0 flex-1 pt-0.5">
        <h4 className="text-sm font-semibold text-ink">{title}</h4>
        {children}
      </div>
    </li>
  );
}

function WindowsSteps({ origin }: Readonly<{ origin: string }>) {
  const preferred = useWindowsArch();
  const other: ConnectArch = preferred === "amd64" ? "arm64" : "amd64";
  if (connectOriginIsIpv6(origin)) {
    const binary = connectClientBinaryName("windows", preferred);
    return (
      <div className="flex flex-col gap-4" data-testid="connect-add-windows-ipv6">
        <p className="text-sm leading-6 text-ink-secondary">
          This installation is reached by an IPv6 address, which the Windows installer cannot carry in its file name.
          Download the program, then connect it with a command in PowerShell, in the folder you saved it to.
        </p>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <a className="v2-connect-link v2-focusable" href={connectClientDownloadPath("windows", preferred)}>
            Download {binary} ({ARCH_LABELS[preferred]})
          </a>
          <a className="v2-connect-link v2-focusable" href={connectClientDownloadPath("windows", other)}>
            {ARCH_LABELS[other]} version
          </a>
        </p>
        <CommandBlock command={`.\\${binary} login ${origin}`} label="Connect the computer command" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5" data-testid="connect-add-windows">
      <div className="v2-connect-download">
        <a className="v2-connect-download-primary v2-focusable" data-testid="connect-download-windows" href={connectWindowsDownloadPath(preferred)}>
          <UiV2Icon name="download" />
          Download for Windows
        </a>
        <a className="v2-connect-link v2-focusable text-sm" data-testid="connect-download-windows-other" href={connectWindowsDownloadPath(other)}>
          {preferred === "amd64" ? "For Windows on ARM (ARM64)" : "For x64 PCs"}
        </a>
      </div>
      <ol className="flex flex-col gap-4">
        <Step number={1} title="Open the downloaded file">
          <p className="mt-1 text-sm leading-6 text-ink-secondary">
            It is named after this AIQSA, for example “AIQSA Connect - {originHost(origin)}.exe”. If Windows shows
            “Windows protected your PC”, choose <strong className="font-semibold text-ink">More info</strong>, then{" "}
            <strong className="font-semibold text-ink">Run anyway</strong>: the program is not signed yet.
          </p>
        </Step>
        <Step number={2} title="Choose Install">
          <p className="mt-1 text-sm leading-6 text-ink-secondary">
            AIQSA Connect installs for your Windows account only, without administrator rights, and starts with Windows.
            It appears in the notification area and in Settings → Apps, where you can remove it.
          </p>
        </Step>
        <Step number={3} title="Approve the computer in your browser">
          <p className="mt-1 text-sm leading-6 text-ink-secondary">
            Your browser opens AIQSA with the computer&apos;s name and a code. Choose Approve, and the computer appears in the list above.
          </p>
        </Step>
      </ol>
    </div>
  );
}

function PosixSteps({ origin }: Readonly<{ origin: string }>) {
  return (
    <div className="flex flex-col gap-4" data-testid="connect-add-posix">
      <p className="text-sm leading-6 text-ink-secondary">Run these commands in a terminal on that computer.</p>
      <ol className="flex flex-col gap-5">
        {connectPosixInstallSteps(origin).map((step, index) => (
          <Step key={step.title} number={index + 1} title={step.title}>
            <p className="mt-1 text-sm leading-6 text-ink-secondary">{step.description}</p>
            <CommandBlock command={step.command} label={`${step.title} command`} />
          </Step>
        ))}
      </ol>
    </div>
  );
}

/** "Add a computer": the Windows download, or the macOS and Linux commands, for this installation (D-20). */
export function ConnectAddComputer({ installOrigin }: Readonly<{ installOrigin: string | null }>) {
  const headingId = useId();
  const [os, setOs] = useState<AddComputerOs | null>(null);
  // The server renders Windows; the browser then shows its own system.
  const guessed = useSyncExternalStore(subscribeNever, guessOs, () => "windows" as const);
  const shown = os ?? guessed;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4" data-testid="connect-add-computer">
      <div>
        <h2 className="text-base font-semibold text-ink" id={headingId}>Add a computer</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
          In a chat where you choose it, the AIQSA agent can then work with files and run commands on that computer,
          with your permissions on it.
        </p>
      </div>
      {installOrigin ? (
        <>
          <div aria-label="Computer system" className="v2-connect-segmented self-start" role="radiogroup">
            <button aria-checked={shown === "windows"} className="v2-focusable" onClick={() => setOs("windows")} role="radio" type="button">
              Windows
            </button>
            <button aria-checked={shown === "posix"} className="v2-focusable" onClick={() => setOs("posix")} role="radio" type="button">
              macOS or Linux
            </button>
          </div>
          {shown === "windows" ? <WindowsSteps origin={installOrigin} /> : <PosixSteps origin={installOrigin} />}
        </>
      ) : (
        <p className="v2-connect-alert" role="alert">
          This installation has no valid public address, so computers cannot be added. Ask your administrator.
        </p>
      )}
    </section>
  );
}
