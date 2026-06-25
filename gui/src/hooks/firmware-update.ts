import { BoardType, DeviceDataT } from 'solarxr-protocol';
import { cacheWrap } from './cache';
import semver from 'semver';
import { normalizedHash } from './crypto';

export interface FirmwareRelease {
  name: string;
  version: string;
  changelog: string;
  firmwareFiles: Partial<Record<BoardType, { url: string; digest: string }>>;
  userCanUpdate: boolean;
}

const firstAsset = (assets: any[], name: string) =>
  assets.find((asset: any) => asset.name === name && asset.browser_download_url);

// Maps a release asset like "BOARD_WEMOSD1MINI-firmware.bin" to its BoardType. The firmware
// build env names match the BoardType enum keys, so we strip the affixes and look the key up.
export function boardTypeFromAssetName(name: string): BoardType | null {
  const m = /^BOARD_(.+)-firmware\.bin$/.exec(name);
  if (!m) return null;
  const val = (BoardType as Record<string, number | string>)[m[1]];
  return typeof val === 'number' ? (val as BoardType) : null;
}

// Builds the per board file map from a releases assets, covering every board the release
// ships a binary for, not just a hardcoded few.
function firmwareFilesFromAssets(
  assets: any[]
): Partial<Record<BoardType, { url: string; digest: string }>> {
  const files: Partial<Record<BoardType, { url: string; digest: string }>> = {};
  for (const asset of assets) {
    if (!asset?.name || !asset.browser_download_url) continue;
    const board = boardTypeFromAssetName(asset.name);
    if (board == null) continue;
    files[board] = { url: asset.browser_download_url, digest: asset.digest };
  }
  return files;
}

const todaysRange = (deployData: [number, Date][]): number => {
  let maxRange = 0;
  for (const [range, date] of deployData) {
    if (Date.now() >= date.getTime()) maxRange = range;
  }
  return maxRange;
};

const checkUserCanUpdate = async (uuid: string, url: string, fwVersion: string) => {
  const deployDataJson = JSON.parse(
    (await cacheWrap(
      `firmware-${fwVersion}-deploy`,
      async () =>
        JSON.stringify(
          await window.electronAPI.ghGet({ type: 'asset', url }).catch(() => null)
        ),
      60 * 60 * 1000
    )) || 'null'
  );
  if (!deployDataJson) return false;

  const deployData = (
    Object.entries(deployDataJson).map(([key, val]) => {
      return [parseFloat(key), new Date(val as string)];
    }) as [number, Date][]
  ).sort(([a], [b]) => a - b);

  if (deployData.find(([key]) => key > 1 || key <= 0)) return false; // values outside boundaries / cancel

  if (
    deployData.find(
      ([, date], index) =>
        index > 0 && date.getTime() < deployData[index - 1][1].getTime()
    )
  )
    return false; // Dates in the wrong order / cancel

  const todayUpdateRange = todaysRange(deployData);
  if (!todayUpdateRange) return false;

  // Make it so the hash change every version. Prevent the same user from getting the same delay
  return normalizedHash(`${uuid}-${fwVersion}`) <= todayUpdateRange;
};

export async function fetchCurrentFirmwareRelease(
  uuid: string
): Promise<FirmwareRelease | null> {
  if (!window.electronAPI) return null;

  const releases: any[] | null = JSON.parse(
    (await cacheWrap(
      'firmware-releases',
      async () =>
        JSON.stringify(
          await window.electronAPI.ghGet({ type: 'fw-releases' }).catch(() => null)
        ),
      60 * 60 * 1000
    )) || 'null'
  );
  // A 404 or rate limit returns a JSON object, not an array, so guard before iterating
  if (!releases || !Array.isArray(releases)) return null;

  const processedReleses = [];
  for (const release of releases) {
    const deployAsset = firstAsset(release.assets, 'deploy.json');
    if (!release.assets || !deployAsset || release.prerelease) continue;

    const firmwareFiles = firmwareFilesFromAssets(release.assets);
    if (Object.keys(firmwareFiles).length === 0) continue;

    let version = release.tag_name;
    if (version.charAt(0) === 'v') {
      version = version.substring(1);
    }

    const userCanUpdate = await checkUserCanUpdate(
      uuid,
      deployAsset.browser_download_url,
      version
    );
    processedReleses.push({
      name: release.name,
      version,
      changelog: release.body,
      firmwareFiles,
      userCanUpdate,
    });

    if (userCanUpdate) break; // Stop early if we found one valid update. No need to download more
  }
  return (
    processedReleses.find(({ userCanUpdate }) => userCanUpdate) ?? processedReleses[0]
  );
}

export function checkForUpdate(
  currentFirmwareRelease: FirmwareRelease,
  device: DeviceDataT
): 'can-update' | 'low-battery' | 'updated' | 'unavailable' | 'blocked' {
  if (!currentFirmwareRelease.userCanUpdate) return 'blocked';

  if (
    !device.hardwareInfo?.officialBoardType ||
    !semver.valid(currentFirmwareRelease.version) ||
    !semver.valid(device.hardwareInfo.firmwareVersion?.toString() ?? 'none')
  ) {
    return 'unavailable';
  }

  const canUpdate = semver.lt(
    device.hardwareInfo.firmwareVersion?.toString() ?? 'none',
    currentFirmwareRelease.version
  );

  // Only offer an update when the release ships a binary for this exact board, so we never
  // hand a tracker firmware built for a different board.
  if (!currentFirmwareRelease.firmwareFiles[device.hardwareInfo.officialBoardType]) {
    return canUpdate ? 'unavailable' : 'updated';
  }

  if (
    canUpdate &&
    device.hardwareStatus?.batteryPctEstimate != null &&
    (device.hardwareStatus.batteryPctEstimate < 50 ||
      device.hardwareStatus.batteryPctEstimate > 200)
  ) {
    return 'low-battery';
  }

  return canUpdate ? 'can-update' : 'updated';
}
