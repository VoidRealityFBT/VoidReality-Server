import { useLocalization } from '@fluent/react';
import { useAtomValue } from 'jotai';
import { TrackerStatus } from 'solarxr-protocol';
import { flatTrackersAtom, FlatDeviceTracker } from '@/store/app-store';
import { WifiIcon } from '@/components/commons/icon/WifiIcon';
import { Typography } from '@/components/commons/Typography';
import { Button } from '@/components/commons/Button';
import {
  SettingsPageLayout,
  SettingsPagePaneLayout,
} from '@/components/settings/SettingsPageLayout';
import {
  getNetworkEvents,
  clearNetworkEvents,
  getSessionStartMs,
} from '@/store/network-events';
import { runNetworkDiagnostics, Severity } from '@/store/network-diagnostics';
import { Fragment, useState } from 'react';

function severityColor(severity: Severity): string {
  return severity === 'good'
    ? 'text-status-success'
    : severity === 'warn'
      ? 'text-status-warning'
      : 'text-status-critical';
}

const STATUS_KEY: Record<number, string> = {
  [TrackerStatus.NONE]: 'settings-network-status-none',
  [TrackerStatus.DISCONNECTED]: 'settings-network-status-disconnected',
  [TrackerStatus.OK]: 'settings-network-status-ok',
  [TrackerStatus.BUSY]: 'settings-network-status-busy',
  [TrackerStatus.ERROR]: 'settings-network-status-error',
  [TrackerStatus.OCCLUDED]: 'settings-network-status-occluded',
  [TrackerStatus.TIMED_OUT]: 'settings-network-status-timed_out',
};

function statusColor(status: TrackerStatus | null | undefined): string {
  switch (status) {
    case TrackerStatus.OK:
      return 'text-status-success';
    case TrackerStatus.BUSY:
    case TrackerStatus.OCCLUDED:
      return 'text-status-warning';
    case TrackerStatus.DISCONNECTED:
    case TrackerStatus.ERROR:
    case TrackerStatus.TIMED_OUT:
      return 'text-status-critical';
    default:
      return 'secondary';
  }
}

// Worse RSSI (more negative dBm) and higher packet loss are bad; tint them so problems pop
function rssiColor(rssi: number | null | undefined): string {
  if (rssi == null) return 'secondary';
  if (rssi >= -67) return 'text-status-success';
  if (rssi >= -80) return 'text-status-warning';
  return 'text-status-critical';
}

function lossColor(loss: number | null | undefined): string {
  if (loss == null) return 'secondary';
  if (loss < 0.02) return 'text-status-success';
  if (loss < 0.1) return 'text-status-warning';
  return 'text-status-critical';
}

type Health = 'good' | 'fair' | 'poor';

// Overall connection health from the 2.4 GHz signal, latency and loss. "fair" means the
// tracker is starting to lag; "poor" means it is dropping/badly lagging.
function connectionHealth(
  status: TrackerStatus | null | undefined,
  ping: number | null | undefined,
  loss: number | null | undefined,
  rssi: number | null | undefined
): Health {
  if (status !== TrackerStatus.OK) return 'poor';
  if ((loss ?? 0) >= 0.1 || (ping ?? 0) >= 50 || (rssi ?? 0) < -80)
    return 'poor';
  if ((loss ?? 0) >= 0.02 || (ping ?? 0) >= 20 || (rssi ?? 0) < -70)
    return 'fair';
  return 'good';
}

const HEALTH_KEY: Record<Health, string> = {
  good: 'settings-network-health-good',
  fair: 'settings-network-health-lagging',
  poor: 'settings-network-health-bad',
};

function healthColor(health: Health): string {
  return health === 'good'
    ? 'text-status-success'
    : health === 'fair'
      ? 'text-status-warning'
      : 'text-status-critical';
}

function isImuTracker(d: FlatDeviceTracker) {
  return d.tracker.info?.isImu ?? false;
}

function trackerName(d: FlatDeviceTracker) {
  const info = d.tracker.info;
  return info?.customName?.toString() || info?.displayName?.toString() || '--';
}

function fmt(value: number | null | undefined, suffix = '', digits = 0) {
  return value == null ? '--' : `${value.toFixed(digits)}${suffix}`;
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background-60 rounded-lg p-3 flex flex-col gap-1">
      <Typography color="secondary" variant="standard">
        {label}
      </Typography>
      <Typography bold variant="section-title">
        {value}
      </Typography>
    </div>
  );
}

export function NetworkSettings() {
  const { l10n } = useLocalization();
  const flat = useAtomValue(flatTrackersAtom);
  // Re-render the event log on demand (Clear) without waiting for the next packet
  const [, setTick] = useState(0);
  const trackers = flat.filter(isImuTracker);
  const events = [...getNetworkEvents()].reverse();
  const diagnostics = runNetworkDiagnostics(
    trackers,
    getNetworkEvents(),
    getSessionStartMs()
  );

  const okCount = trackers.filter(
    (d) => d.tracker.status === TrackerStatus.OK
  ).length;
  const pings = trackers
    .map((d) => d.device?.hardwareStatus?.ping)
    .filter((p): p is number => p != null);
  const avgPing =
    pings.length > 0 ? pings.reduce((a, b) => a + b, 0) / pings.length : null;
  const worstLoss = trackers
    .map((d) => d.device?.hardwareStatus?.packetLoss ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);
  const laggingCount = trackers.filter((d) => {
    const st = d.device?.hardwareStatus;
    return (
      connectionHealth(d.tracker.status, st?.ping, st?.packetLoss, st?.rssi) !==
      'good'
    );
  }).length;

  const headers = [
    'settings-network-col-tracker',
    'settings-network-col-health',
    'settings-network-col-status',
    'settings-network-col-ping',
    'settings-network-col-signal',
    'settings-network-col-loss',
    'settings-network-col-packets',
    'settings-network-col-tps',
  ];

  return (
    <SettingsPageLayout>
      <div className="flex flex-col gap-2 w-full">
        <SettingsPagePaneLayout
          icon={<WifiIcon variant="navbar" value={null} />}
          id="network"
        >
          <>
            <Typography variant="main-title">
              {l10n.getString('settings-network')}
            </Typography>
            <Typography color="secondary">
              {l10n.getString('settings-network-description')}
            </Typography>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4">
              <SummaryCard
                label={l10n.getString('settings-network-summary-connected')}
                value={`${okCount} / ${trackers.length}`}
              />
              <SummaryCard
                label={l10n.getString('settings-network-summary-lagging')}
                value={String(laggingCount)}
              />
              <SummaryCard
                label={l10n.getString('settings-network-summary-avg_ping')}
                value={fmt(avgPing, ' ms')}
              />
              <SummaryCard
                label={l10n.getString('settings-network-summary-worst_loss')}
                value={`${(worstLoss * 100).toFixed(0)}%`}
              />
              <SummaryCard
                label={l10n.getString('settings-network-summary-events')}
                value={String(getNetworkEvents().length)}
              />
            </div>

            <div className="mt-6">
              <Typography variant="section-title" bold>
                {l10n.getString('settings-network-diagnostics')}
              </Typography>
            </div>
            <div className="bg-background-70 rounded-lg p-3 mt-2 grid grid-cols-[1fr,_auto] gap-x-4 gap-y-1">
              {diagnostics.map((mt, i) => (
                <Fragment key={i}>
                  <Typography color="secondary" whitespace="whitespace-nowrap">
                    {mt.label}
                  </Typography>
                  <Typography
                    color={severityColor(mt.severity)}
                    whitespace="whitespace-nowrap"
                  >
                    {mt.value}
                  </Typography>
                </Fragment>
              ))}
            </div>

            <div className="mt-6">
              <Typography variant="section-title" bold>
                {l10n.getString('settings-network-trackers')}
              </Typography>
            </div>
            <div className="bg-background-70 rounded-lg p-3 mt-2 overflow-x-auto">
              <div className="grid grid-cols-[1.6fr,_1fr,_1fr,_0.8fr,_1fr,_0.8fr,_1.2fr,_0.7fr] gap-x-3 gap-y-1 min-w-[720px]">
                {headers.map((h) => (
                  <Typography key={h} color="secondary" bold>
                    {l10n.getString(h)}
                  </Typography>
                ))}
                {trackers.length === 0 && (
                  <Typography color="secondary">
                    {l10n.getString('settings-network-no_trackers')}
                  </Typography>
                )}
                {trackers.map((d) => {
                  const st = d.device?.hardwareStatus;
                  const key = `${d.tracker.trackerId?.deviceId?.id}:${d.tracker.trackerId?.trackerNum}`;
                  const health = connectionHealth(
                    d.tracker.status,
                    st?.ping,
                    st?.packetLoss,
                    st?.rssi
                  );
                  return (
                    <Fragment key={key}>
                      <Typography whitespace="whitespace-nowrap">
                        {trackerName(d)}
                      </Typography>
                      <Typography
                        color={healthColor(health)}
                        whitespace="whitespace-nowrap"
                      >
                        {l10n.getString(HEALTH_KEY[health])}
                      </Typography>
                      <Typography color={statusColor(d.tracker.status)}>
                        {l10n.getString(
                          STATUS_KEY[d.tracker.status ?? TrackerStatus.NONE]
                        )}
                      </Typography>
                      <Typography>{fmt(st?.ping, ' ms')}</Typography>
                      <Typography color={rssiColor(st?.rssi)}>
                        {fmt(st?.rssi, ' dBm')}
                      </Typography>
                      <Typography color={lossColor(st?.packetLoss)}>
                        {st?.packetLoss != null
                          ? `${(st.packetLoss * 100).toFixed(0)}%`
                          : '--'}
                      </Typography>
                      <Typography>
                        {st?.packetsLost != null || st?.packetsReceived != null
                          ? `${st?.packetsLost ?? '--'} / ${st?.packetsReceived ?? '--'}`
                          : '--'}
                      </Typography>
                      <Typography>
                        {d.tracker.tps != null ? String(d.tracker.tps) : '--'}
                      </Typography>
                    </Fragment>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-between items-center mt-6">
              <Typography variant="section-title" bold>
                {l10n.getString('settings-network-events')}
              </Typography>
              <Button
                variant="secondary"
                onClick={() => {
                  clearNetworkEvents();
                  setTick((v) => v + 1);
                }}
              >
                {l10n.getString('settings-network-events-clear')}
              </Button>
            </div>
            <div className="bg-background-70 rounded-lg p-3 mt-2 flex flex-col gap-1 max-h-80 overflow-y-auto">
              {events.length === 0 && (
                <Typography color="secondary">
                  {l10n.getString('settings-network-no_events')}
                </Typography>
              )}
              {events.map((e, i) => (
                <div
                  key={`${e.time}-${i}`}
                  className="grid grid-cols-[auto,_1fr,_auto] gap-x-3"
                >
                  <Typography color="secondary" whitespace="whitespace-nowrap">
                    {new Date(e.time).toLocaleTimeString()}
                  </Typography>
                  <Typography whitespace="whitespace-nowrap">
                    {e.trackerName}
                  </Typography>
                  <Typography
                    color={
                      e.down ? 'text-status-critical' : 'text-status-success'
                    }
                    whitespace="whitespace-nowrap"
                  >
                    {l10n.getString(`settings-network-event-${e.reason}`)}
                  </Typography>
                </div>
              ))}
            </div>
          </>
        </SettingsPagePaneLayout>
      </div>
    </SettingsPageLayout>
  );
}
