import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useLocalization } from '@fluent/react';
import { useNavigate } from 'react-router-dom';
import {
  BoardType,
  DeviceIdT,
  DeviceIdTableT,
  FirmwarePartT,
  FirmwareUpdateMethod,
  FirmwareUpdateRequestT,
  FirmwareUpdateStatus,
  FirmwareUpdateStatusResponseT,
  FirmwareUpdateStopQueuesRequestT,
  OTAFirmwareUpdateT,
  RpcMessage,
} from 'solarxr-protocol';
import { flatTrackersAtom, FlatDeviceTracker } from '@/store/app-store';
import { useWebsocketAPI } from '@/hooks/websocket-api';
import { useConfig } from '@/hooks/config';
import {
  fetchCurrentFirmwareRelease,
  FirmwareRelease,
  boardTypeFromAssetName,
} from '@/hooks/firmware-update';
import { firmwareUpdateErrorStatus } from '@/hooks/firmware-tool';
import { Typography } from '@/components/commons/Typography';
import { Button } from '@/components/commons/Button';
import { CheckboxInternal } from '@/components/commons/Checkbox';
import { ArrowDownIcon, ArrowUpIcon } from '@/components/commons/icon/ArrowIcons';

// Renders a board id as its build env name (an example would be: BOARD_WEMOSD1MINI), which is also how the
// matching firmware file is named, so the user can line them up at a glance.
const boardName = (board: number | null | undefined): string => {
  if (board == null) return '';
  const key = BoardType[board as BoardType];
  return typeof key === 'string' ? `BOARD_${key}` : '';
};

const STATUS_KEY: { [k: number]: string } = {
  [FirmwareUpdateStatus.DOWNLOADING]: 'updates-flow-status-downloading',
  [FirmwareUpdateStatus.AUTHENTICATING]: 'updates-flow-status-authenticating',
  [FirmwareUpdateStatus.UPLOADING]: 'updates-flow-status-uploading',
  [FirmwareUpdateStatus.SYNCING_WITH_MCU]: 'updates-flow-status-syncing',
  [FirmwareUpdateStatus.REBOOTING]: 'updates-flow-status-rebooting',
  [FirmwareUpdateStatus.PROVISIONING]: 'updates-flow-status-provisioning',
  [FirmwareUpdateStatus.NEED_MANUAL_REBOOT]: 'updates-flow-status-manual_reboot',
  [FirmwareUpdateStatus.DONE]: 'updates-flow-status-done',
  [FirmwareUpdateStatus.ERROR_DEVICE_NOT_FOUND]: 'updates-flow-error-not_found',
  [FirmwareUpdateStatus.ERROR_TIMEOUT]: 'updates-flow-error-timeout',
  [FirmwareUpdateStatus.ERROR_DOWNLOAD_FAILED]: 'updates-flow-error-download',
  [FirmwareUpdateStatus.ERROR_AUTHENTICATION_FAILED]: 'updates-flow-error-auth',
  [FirmwareUpdateStatus.ERROR_UPLOAD_FAILED]: 'updates-flow-error-upload',
  [FirmwareUpdateStatus.ERROR_PROVISIONING_FAILED]: 'updates-flow-error-provisioning',
  [FirmwareUpdateStatus.ERROR_UNSUPPORTED_METHOD]: 'updates-flow-error-method',
  [FirmwareUpdateStatus.ERROR_UNKNOWN]: 'updates-flow-error-unknown',
};

interface TrackerUpdate {
  id: string;
  name: string;
  status: FirmwareUpdateStatus | null;
  progress: number;
  log: { status: FirmwareUpdateStatus; time: number }[];
}

function isError(status: FirmwareUpdateStatus | null) {
  return status != null && firmwareUpdateErrorStatus.includes(status);
}

function TrackerRow({
  tracker,
  l10n,
}: {
  tracker: TrackerUpdate;
  l10n: ReturnType<typeof useLocalization>['l10n'];
}) {
  const [open, setOpen] = useState(false);
  const error = isError(tracker.status);
  const done = tracker.status === FirmwareUpdateStatus.DONE;
  const statusLabel =
    tracker.status != null
      ? l10n.getString(STATUS_KEY[tracker.status] ?? 'updates-flow-status-working')
      : l10n.getString('updates-flow-status-waiting');

  return (
    <div className="bg-background-70 rounded-lg p-3 flex flex-col gap-2">
      <div
        className="flex items-center gap-3 cursor-pointer"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex flex-col flex-grow">
          <Typography bold>{tracker.name}</Typography>
          <Typography
            color={
              error
                ? 'text-status-critical'
                : done
                  ? 'text-status-success'
                  : 'secondary'
            }
          >
            {statusLabel}
          </Typography>
        </div>
        <Typography color="secondary">
          {Math.round(tracker.progress * 100)}%
        </Typography>
        <div className="fill-background-10 w-4">
          {open ? <ArrowUpIcon /> : <ArrowDownIcon />}
        </div>
      </div>
      <div className="h-2 bg-background-50 rounded-full overflow-hidden">
        <div
          className={
            error
              ? 'h-full bg-status-critical'
              : done
                ? 'h-full bg-status-success'
                : 'h-full bg-accent-background-30'
          }
          style={{ width: `${Math.max(2, tracker.progress * 100)}%` }}
        />
      </div>
      {open && (
        <div className="flex flex-col gap-1 bg-background-60 rounded-md p-2 max-h-40 overflow-y-auto">
          {tracker.log.length === 0 && (
            <Typography color="secondary">
              {l10n.getString('updates-flow-log-empty')}
            </Typography>
          )}
          {tracker.log.map((entry, i) => (
            <Typography
              key={i}
              variant="standard"
              color={
                isError(entry.status) ? 'text-status-critical' : 'secondary'
              }
            >
              {new Date(entry.time).toLocaleTimeString()}{' '}
              {l10n.getString(
                STATUS_KEY[entry.status] ?? 'updates-flow-status-working'
              )}
            </Typography>
          ))}
        </div>
      )}
    </div>
  );
}

export function FirmwareUpdateFlow({
  open,
  onClose,
  test = false,
}: {
  open: boolean;
  onClose: () => void;
  test?: boolean;
}) {
  const { l10n } = useLocalization();
  const navigate = useNavigate();
  const { config } = useConfig();
  const { sendRPCPacket, useRPCPacket } = useWebsocketAPI();
  const flat = useAtomValue(flatTrackersAtom);
  const [step, setStep] = useState<'info' | 'progress'>('info');
  const [trackers, setTrackers] = useState<Record<string, TrackerUpdate>>({});
  const [noFirmware, setNoFirmware] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [localError, setLocalError] = useState<string | null>(null);

  // One row per physical device (a device can back several trackers), with what we need to
  // flash it: the id, a name, and the board so the right binary is chosen
  const devices = useMemo(() => {
    const seen = new Set<string>();
    const out: {
      id: string;
      name: string;
      board: number | null | undefined;
    }[] = [];
    for (const { tracker, device } of flat as FlatDeviceTracker[]) {
      const deviceId = tracker.trackerId?.deviceId?.id;
      if (!tracker.info?.isImu || !device?.hardwareInfo || deviceId == null) {
        continue;
      }
      const id = deviceId.toString();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name:
          tracker.info?.customName?.toString() ||
          device.hardwareInfo.displayName?.toString() ||
          id,
        board: device.hardwareInfo.officialBoardType,
      });
    }
    return out;
  }, [flat]);

  // Select every device by default whenever the dialog is opened
  useEffect(() => {
    if (open) {
      setSelected(new Set(devices.map((d) => d.id)));
      setLocalError(null);
    }
  }, [open]);

  useRPCPacket(
    RpcMessage.FirmwareUpdateStatusResponse,
    (data: FirmwareUpdateStatusResponseT) => {
      const id =
        data.deviceId instanceof DeviceIdTableT
          ? data.deviceId.id?.id
          : data.deviceId?.port;
      if (id == null) return;
      const key = id.toString();
      setTrackers((last) => {
        const prev = last[key];
        if (!prev) return last;
        return {
          ...last,
          [key]: {
            ...prev,
            status: data.status,
            progress: data.progress / 100,
            log: [...prev.log, { status: data.status, time: Date.now() }],
          },
        };
      });
    }
  );

  if (!open) return null;

  const physical = flat.filter(
    ({ tracker, device }) =>
      tracker.info?.isImu && device?.hardwareInfo && tracker.trackerId?.deviceId
  );

  // Test mode steps fake trackers through the real status sequence so the flow UI can be
  // checked without a release or touching the server. The second one fails on purpose.
  const simulateUpdate = () => {
    const names = physical.length
      ? physical
          .slice(0, 4)
          .map(
            ({ tracker, device }) =>
              tracker.info?.customName?.toString() ||
              device?.hardwareInfo?.displayName?.toString() ||
              'Tracker'
          )
      : ['Test tracker 1', 'Test tracker 2', 'Test tracker 3'];
    const init: Record<string, TrackerUpdate> = {};
    names.forEach((name, i) => {
      init[`sim-${i}`] = { id: `sim-${i}`, name, status: null, progress: 0, log: [] };
    });
    setTrackers(init);
    setNoFirmware([]);
    setStep('progress');

    names.forEach((_, i) => {
      const id = `sim-${i}`;
      const fail = i === 1;
      const steps: [FirmwareUpdateStatus, number][] = [
        [FirmwareUpdateStatus.DOWNLOADING, 10],
        [FirmwareUpdateStatus.UPLOADING, 45],
        [FirmwareUpdateStatus.SYNCING_WITH_MCU, 75],
        [FirmwareUpdateStatus.REBOOTING, 92],
        [fail ? FirmwareUpdateStatus.ERROR_TIMEOUT : FirmwareUpdateStatus.DONE, 100],
      ];
      steps.forEach(([status, progress], s) => {
        setTimeout(
          () =>
            setTrackers((last) => {
              const prev = last[id];
              if (!prev) return last;
              return {
                ...last,
                [id]: {
                  ...prev,
                  status,
                  progress: progress / 100,
                  log: [...prev.log, { status, time: Date.now() }],
                },
              };
            }),
          i * 400 + s * 900
        );
      });
    });
  };

  // Flashes the selected devices over OTA, using getFile to resolve the firmware binary for
  // each device's board. getFile returns null to skip a device.
  const flashTrackers = (
    getFile: (board: number | null | undefined) => { url: string; digest: string } | null | undefined
  ) => {
    const next: Record<string, TrackerUpdate> = {};
    const missing: string[] = [];

    for (const dev of devices) {
      if (!selected.has(dev.id)) continue;

      const file = getFile(dev.board);
      if (!file) {
        missing.push(dev.name);
        continue;
      }

      next[dev.id] = { id: dev.id, name: dev.name, status: null, progress: 0, log: [] };

      const dId = new DeviceIdT();
      dId.id = Number(dev.id);
      const part = new FirmwarePartT();
      part.offset = 0;
      part.url = file.url;
      part.digest = file.digest;
      const method = new OTAFirmwareUpdateT();
      method.deviceId = dId;
      method.firmwarePart = part;
      const req = new FirmwareUpdateRequestT();
      req.method = method;
      req.methodType = FirmwareUpdateMethod.OTAFirmwareUpdate;
      sendRPCPacket(RpcMessage.FirmwareUpdateRequest, req);
    }

    setTrackers(next);
    setNoFirmware(missing);
    setStep('progress');
  };

  const startUpdate = async () => {
    if (test) {
      simulateUpdate();
      return;
    }
    let release: FirmwareRelease | null = null;
    try {
      if (config?.uuid) release = await fetchCurrentFirmwareRelease(config.uuid);
    } catch (e) {
      console.error('[UpdateFlow] failed to fetch firmware release', e);
    }
    flashTrackers((board) =>
      release && board != null
        ? release.firmwareFiles[board as BoardType]
        : undefined
    );
  };

  // Flash a locally picked .bin over OTA, no GitHub. The server reads the file:// url and
  // skips the digest when it is blank. Guarded so one file cant be sent to the wrong board.
  const startLocalUpdate = async () => {
    if (!window.electronAPI?.openDialog) return;
    setLocalError(null);

    const targets = devices.filter((d) => selected.has(d.id));
    const boards = [...new Set(targets.map((d) => d.board).filter((b) => b != null))];

    // One .bin is built for a single board, so refuse a selection that spans several
    if (boards.length > 1) {
      setLocalError(
        l10n.getString('updates-flow-mixed_boards', {
          boards: boards.map((b) => boardName(b)).join(', '),
        })
      );
      return;
    }
    const targetBoard = boards.length === 1 ? (boards[0] as number) : null;

    const res = await window.electronAPI.openDialog({
      properties: ['openFile'],
      filters: [{ name: 'Firmware', extensions: ['bin'] }],
    });
    const path = res?.filePaths?.[0];
    if (!path) return;

    // If the file name follows the BOARD_<env>-firmware.bin convention we can verify it
    // against the connected tracker and hard-stop a mismatch before anything is flashed.
    // (Might make it where before the server updates individual trackers it checks what type
    // of tracker it is then compares it to the type of tracker the bin is meant for. If incorrect
    // it will not install the bin and prompt the user to flash the correct bin for such tracker.)
    const fileName = path.replace(/\\/g, '/').split('/').pop() ?? '';
    const fileBoard = boardTypeFromAssetName(fileName);
    if (fileBoard != null && targetBoard != null && fileBoard !== targetBoard) {
      setLocalError(
        l10n.getString('updates-flow-board_mismatch', {
          file: boardName(fileBoard),
          tracker: boardName(targetBoard),
        })
      );
      return;
    }

    const url = 'file:///' + path.replace(/\\/g, '/');
    flashTrackers(() => ({ url, digest: '' }));
  };

  const close = () => {
    // Always stop any queued server side update (the local file flash can queue real ones
    // even from the test panel). The server handles this safely when nothing is running.
    sendRPCPacket(
      RpcMessage.FirmwareUpdateStopQueuesRequest,
      new FirmwareUpdateStopQueuesRequestT()
    );
    setStep('info');
    setTrackers({});
    setNoFirmware([]);
    setLocalError(null);
    onClose();
  };

  const list = Object.values(trackers);
  const pending = list.some(
    (t) =>
      t.status != null &&
      t.status !== FirmwareUpdateStatus.DONE &&
      !isError(t.status)
  );

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center backdrop-blur-md bg-background-90/70">
      <div className="bg-background-80 rounded-2xl shadow-2xl p-6 w-[min(92vw,600px)] max-h-[88vh] overflow-y-auto flex flex-col gap-5">
        <Typography variant="main-title">
          {l10n.getString('updates-flow-title')}
        </Typography>

        {step === 'info' && (
          <>
            <Typography color="secondary" whitespace="whitespace-pre-line">
              {l10n.getString('updates-flow-info')}
            </Typography>

            {devices.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <Typography variant="section-title">
                    {l10n.getString('updates-flow-select')}
                  </Typography>
                  <button
                    className="text-accent-background-30 text-standard"
                    onClick={() =>
                      setSelected((prev) =>
                        prev.size === devices.length
                          ? new Set()
                          : new Set(devices.map((d) => d.id))
                      )
                    }
                  >
                    {selected.size === devices.length
                      ? l10n.getString('updates-flow-select-none')
                      : l10n.getString('updates-flow-select-all')}
                  </button>
                </div>
                <div className="flex flex-col gap-1 max-h-52 overflow-y-auto">
                  {devices.map((dev) => (
                    <CheckboxInternal
                      key={dev.id}
                      variant="toggle"
                      name={`flash-${dev.id}`}
                      checked={selected.has(dev.id)}
                      onChange={(e) => {
                        const on = (e.target as HTMLInputElement).checked;
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (on) next.add(dev.id);
                          else next.delete(dev.id);
                          return next;
                        });
                      }}
                      label={
                        boardName(dev.board)
                          ? `${dev.name} — ${boardName(dev.board)}`
                          : dev.name
                      }
                    />
                  ))}
                </div>
              </div>
            )}

            {localError && (
              <Typography color="text-status-critical">{localError}</Typography>
            )}

            <div className="flex gap-2 justify-end flex-wrap">
              <Button variant="tertiary" onClick={close}>
                {l10n.getString('updates-flow-cancel')}
              </Button>
              <Button
                variant="tertiary"
                disabled={devices.length > 0 && selected.size === 0}
                onClick={startLocalUpdate}
              >
                {l10n.getString('updates-flow-local')}
              </Button>
              <Button variant="secondary" onClick={() => navigate('/settings/firmware-tool')}>
                {l10n.getString('updates-flow-wired')}
              </Button>
              <Button
                variant="primary"
                disabled={devices.length > 0 && selected.size === 0}
                onClick={startUpdate}
              >
                {l10n.getString('updates-flow-start')}
              </Button>
            </div>
          </>
        )}

        {step === 'progress' && (
          <>
            {list.length === 0 && (
              <Typography color="secondary">
                {l10n.getString('updates-flow-none')}
              </Typography>
            )}
            <div className="flex flex-col gap-2">
              {list.map((t) => (
                <TrackerRow key={t.id} tracker={t} l10n={l10n} />
              ))}
            </div>
            {noFirmware.length > 0 && (
              <Typography color="text-status-warning">
                {l10n.getString('updates-flow-no_firmware', {
                  trackers: noFirmware.join(', '),
                })}
              </Typography>
            )}
            <div className="flex justify-end">
              <Button variant="primary" disabled={pending} onClick={close}>
                {pending
                  ? l10n.getString('updates-flow-updating')
                  : l10n.getString('updates-flow-close')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
