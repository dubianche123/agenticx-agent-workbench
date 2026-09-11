import fs from "node:fs";
import path from "node:path";

export const DESKTOP_RUNTIME_PACKAGE = "agenticx[desktop-runtime]";
export const SOCKSIO_REQUIREMENT = "socksio>=1.0.0,<2";

export type DependencyInstallPlan = {
  /** How the plan obtains packages. */
  source: "wheelhouse" | "pypi" | "unavailable";
  /** Arguments after the Python executable. */
  args: string[];
  target: string;
  wheelhouse?: string;
  /** True when executing this plan can contact a package index. */
  networkRequired: boolean;
};

export type WheelhouseSearchOptions = {
  env?: NodeJS.ProcessEnv;
  sourceRoot?: string | null;
  resourcesPath?: string | null;
  cwd?: string;
};

function truthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Explicitly requested no-network mode. We do not infer this from proxy
 * variables: a proxy can be healthy, while these flags are an intentional
 * contract from an offline installer or an agent repairing a local checkout.
 */
export function isOfflineInstallRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return [
    env.AGX_OFFLINE_INSTALL,
    env.AGX_DESKTOP_OFFLINE,
    env.AGX_NO_NETWORK,
    env.PIP_NO_INDEX,
  ].some(truthy);
}

function hasPackageArchive(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => /\.(?:whl|zip|tar\.gz)$/i.test(name));
  } catch {
    return false;
  }
}

/**
 * Locate a wheelhouse that can be copied into a release or kept beside a
 * source checkout. Empty placeholder directories are ignored so the UI does
 * not claim an offline repair is possible when no package archive exists.
 */
export function findBackendWheelhouse(options: WheelhouseSearchOptions = {}): string | null {
  const env = options.env ?? process.env;
  const sourceRoot = options.sourceRoot ?? null;
  const resourcesPath = options.resourcesPath ?? null;
  const cwd = options.cwd ?? process.cwd();
  const candidates = [
    env.AGX_BACKEND_WHEELHOUSE,
    resourcesPath ? path.join(resourcesPath, "backend", "wheelhouse") : null,
    sourceRoot ? path.join(sourceRoot, "packaging", "wheelhouse") : null,
    path.join(cwd, "packaging", "wheelhouse"),
    path.join(cwd, "wheelhouse"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      if (fs.statSync(normalized).isDirectory() && hasPackageArchive(normalized)) {
        return normalized;
      }
    } catch {
      /* Candidate is not present on this installation. */
    }
  }
  return null;
}

function pipInstallArgs(
  target: string,
  wheelhouse: string | null,
): { args: string[]; source: "wheelhouse" | "pypi"; networkRequired: boolean } {
  if (wheelhouse) {
    return {
      source: "wheelhouse",
      networkRequired: false,
      args: [
        "-m",
        "pip",
        "install",
        "--no-index",
        "--find-links",
        wheelhouse,
        "--prefer-binary",
        target,
      ],
    };
  }
  return {
    source: "pypi",
    networkRequired: true,
    args: ["-m", "pip", "install", "--prefer-binary", target],
  };
}

/** Build a bounded, explicit install plan for the desktop runtime package. */
export function buildDesktopRuntimeInstallPlan(options: {
  sourceRoot?: string | null;
  wheelhouse?: string | null;
  offline?: boolean;
} = {}): DependencyInstallPlan {
  const target = options.sourceRoot
    ? `${options.sourceRoot}[desktop-runtime]`
    : DESKTOP_RUNTIME_PACKAGE;
  if (options.sourceRoot) {
    const wheelhouse = options.wheelhouse ?? null;
    if (options.offline && !wheelhouse) {
      return {
        source: "unavailable",
        args: [],
        target,
        networkRequired: true,
      };
    }
    const plan = pipInstallArgs(target, wheelhouse);
    // Keep editable installs as two argv entries so spaces in a Windows path
    // never need shell quoting.
    plan.args.splice(-1, 1, "-e", target);
    return { ...plan, target, wheelhouse: wheelhouse ?? undefined };
  }
  if (options.offline && !options.wheelhouse) {
    return {
      source: "unavailable",
      args: [],
      target,
      networkRequired: true,
    };
  }
  const plan = pipInstallArgs(DESKTOP_RUNTIME_PACKAGE, options.wheelhouse ?? null);
  return { ...plan, target: DESKTOP_RUNTIME_PACKAGE, wheelhouse: options.wheelhouse ?? undefined };
}

/** Build the compatibility socksio install used by older published packages. */
export function buildSocksioInstallPlan(options: {
  wheelhouse?: string | null;
  offline?: boolean;
} = {}): DependencyInstallPlan {
  if (options.offline && !options.wheelhouse) {
    return {
      source: "unavailable",
      args: [],
      target: SOCKSIO_REQUIREMENT,
      networkRequired: true,
    };
  }
  const plan = pipInstallArgs(SOCKSIO_REQUIREMENT, options.wheelhouse ?? null);
  return { ...plan, target: SOCKSIO_REQUIREMENT, wheelhouse: options.wheelhouse ?? undefined };
}
