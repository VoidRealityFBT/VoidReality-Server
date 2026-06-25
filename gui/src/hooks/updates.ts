import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import semver from 'semver';
import { flatTrackersAtom } from '@/store/app-store';
import {
  VOIDREALITY_FIRMWARE_REPO,
  VOIDREALITY_SERVER_REPO,
} from '@/utils/update-config';

// Only hit the GitHub releases API this often. Checking more aggressively (on every
// data feed packet) spams the API into 429 (Too Many Requests). Not really desirable
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface UpdateInfo {
  version: string;
  notes: string;
  date?: string;
  url?: string;
}

interface GithubRelease {
  tag_name: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  prerelease: boolean;
}

async function latestRelease(repo: string): Promise<GithubRelease | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases`);
    if (!res.ok) return null;
    const json: GithubRelease[] = await res.json();
    return json.find((r) => r && !r.prerelease) ?? null;
  } catch {
    return null;
  }
}

function toInfo(release: GithubRelease): UpdateInfo {
  return {
    version: release.tag_name,
    notes: release.body ?? '',
    date: release.published_at,
    url: release.html_url,
  };
}

// Checks the VoidReality server/GUI repo against the running version and the firmware repo
// against each trackers reported firmware, and remembers which versions the user opted out
// of so the panel does not nag.
export function useUpdates() {
  const [serverRelease, setServerRelease] = useState<GithubRelease | null>(null);
  const [firmwareRelease, setFirmwareRelease] = useState<GithubRelease | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      return new Set(
        JSON.parse(localStorage.getItem('voidreality-dismissed-updates') || '[]')
      );
    } catch {
      return new Set();
    }
  });
  const trackers = useAtomValue(flatTrackersAtom);

  // Fetch the latest releases once on mount, then only every UPDATE_CHECK_INTERVAL_MS. This
  // effect has no data dependencies, so it never re-runs on a data-feed packet or re-render.
  // (this was what spammed GitHub into 429.)
  useEffect(() => {
    if (window.__ANDROID__?.isThere()) return;
    let active = true;
    const check = () => {
      latestRelease(VOIDREALITY_SERVER_REPO).then((r) => {
        if (active) setServerRelease(r);
      });
      latestRelease(VOIDREALITY_FIRMWARE_REPO).then((r) => {
        if (active) setFirmwareRelease(r);
      });
    };
    check();
    const id = window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);

  // Derive the app update from the fetched release and the running version. No network.
  const app = useMemo<UpdateInfo | null>(() => {
    if (!serverRelease || !semver.valid(__VERSION_TAG__)) return null;
    const ver = semver.coerce(serverRelease.tag_name);
    return ver && semver.gt(ver, __VERSION_TAG__) ? toInfo(serverRelease) : null;
  }, [serverRelease]);

  // Whether any connected tracker is behind the latest firmware. Re-evaluates as trackers
  // change, but performs no network request
  const firmwareOutdated = useMemo(() => {
    if (!firmwareRelease) return false;
    const latest = semver.coerce(firmwareRelease.tag_name);
    if (!latest) return false;
    return trackers.some(({ device }) => {
      const fw = device?.hardwareInfo?.firmwareVersion?.toString();
      const cur = fw ? semver.coerce(fw) : null;
      return cur != null && semver.gt(latest, cur);
    });
  }, [firmwareRelease, trackers]);

  // Stable reference unless the release or outdated status actually changes.
  const firmware = useMemo<UpdateInfo | null>(
    () => (firmwareOutdated && firmwareRelease ? toInfo(firmwareRelease) : null),
    [firmwareOutdated, firmwareRelease]
  );

  const dismiss = (key: string) => {
    const next = new Set(dismissed);
    next.add(key);
    setDismissed(next);
    localStorage.setItem('voidreality-dismissed-updates', JSON.stringify([...next]));
  };

  const appShown = app && !dismissed.has(`app-${app.version}`) ? app : null;
  const firmwareShown =
    firmware && !dismissed.has(`fw-${firmware.version}`) ? firmware : null;

  return {
    app: appShown,
    firmware: firmwareShown,
    hasUpdate: !!(appShown || firmwareShown),
    dismissApp: () => app && dismiss(`app-${app.version}`),
    dismissFirmware: () => firmware && dismiss(`fw-${firmware.version}`),
  };
}
