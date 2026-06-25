import { TrackerStatus } from 'solarxr-protocol';
import { FlatDeviceTracker } from '@/store/app-store';
import { NetworkEvent } from '@/store/network-events';

export type Severity = 'good' | 'warn' | 'bad';

export interface Metric {
  label: string;
  value: string;
  severity: Severity;
}

function trackerName(d: FlatDeviceTracker): string {
  const info = d.tracker.info;
  return info?.customName?.toString() || info?.displayName?.toString() || '--';
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

type Getter = (d: FlatDeviceTracker) => number | null | undefined;

function avg(imus: FlatDeviceTracker[], get: Getter): number | null {
  const vals = imus.map(get).filter((v): v is number => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// The lowest/highest value of a metric across trackers, with the tracker it belongs to.
function extreme(
  imus: FlatDeviceTracker[],
  get: Getter,
  dir: 'min' | 'max'
): { value: number; name: string } | null {
  let best: { value: number; name: string } | null = null;
  for (const d of imus) {
    const v = get(d);
    if (v == null) continue;
    if (best == null || (dir === 'min' ? v < best.value : v > best.value)) {
      best = { value: v, name: trackerName(d) };
    }
  }
  return best;
}

// Returns measured network/tracker numbers, each with a threshold-based color. All values are
// real data the server reports or counts from the session connection log; no advice text.
export function runNetworkDiagnostics(
  trackers: FlatDeviceTracker[],
  events: NetworkEvent[],
  sessionStartMs: number
): Metric[] {
  const imus = trackers.filter((d) => d.tracker.info?.isImu ?? false);
  const m: Metric[] = [];
  if (imus.length === 0) {
    return [{ label: 'Trackers connected', value: '0', severity: 'warn' }];
  }

  const rssi: Getter = (d) => d.device?.hardwareStatus?.rssi;
  const ping: Getter = (d) => d.device?.hardwareStatus?.ping;
  const loss: Getter = (d) => d.device?.hardwareStatus?.packetLoss;
  const tps: Getter = (d) => d.tracker.tps;
  const temp: Getter = (d) => d.tracker.temp?.temp;
  const batt: Getter = (d) => d.device?.hardwareStatus?.batteryPctEstimate;

  const up = imus.filter((d) => d.tracker.status === TrackerStatus.OK).length;
  const watchedMs = Math.max(Date.now() - sessionStartMs, 1000);
  const hours = watchedMs / 3600000;
  const downs = events.filter((e) => e.down).length;
  const ups = events.filter((e) => !e.down).length;
  const dropRate = downs / hours;

  m.push({
    label: 'Delivering data',
    value: `${up} / ${imus.length}`,
    severity: up === imus.length ? 'good' : 'bad',
  });
  m.push({ label: 'Watching for', value: fmtDuration(watchedMs), severity: 'good' });
  m.push({
    label: 'Drops',
    value: String(downs),
    severity: downs === 0 ? 'good' : downs < 5 ? 'warn' : 'bad',
  });
  m.push({ label: 'Reconnects', value: String(ups), severity: 'good' });
  m.push({
    label: 'Drop rate',
    value: `${dropRate.toFixed(1)} / hr`,
    severity: dropRate < 1 ? 'good' : dropRate < 6 ? 'warn' : 'bad',
  });

  const aRssi = avg(imus, rssi);
  const wRssi = extreme(imus, rssi, 'min');
  if (aRssi != null && wRssi) {
    m.push({
      label: 'Signal avg / worst',
      value: `${aRssi.toFixed(0)} / ${wRssi.value} dBm (${wRssi.name})`,
      severity: wRssi.value < -80 ? 'bad' : wRssi.value < -70 ? 'warn' : 'good',
    });
  }

  const aPing = avg(imus, ping);
  const wPing = extreme(imus, ping, 'max');
  if (aPing != null && wPing) {
    m.push({
      label: 'Ping avg / worst',
      value: `${aPing.toFixed(0)} / ${wPing.value} ms (${wPing.name})`,
      severity: wPing.value >= 50 ? 'bad' : wPing.value >= 20 ? 'warn' : 'good',
    });
  }

  const aLoss = avg(imus, loss);
  const wLoss = extreme(imus, loss, 'max');
  if (aLoss != null && wLoss) {
    m.push({
      label: 'Packet loss avg / worst',
      value: `${(aLoss * 100).toFixed(1)} / ${(wLoss.value * 100).toFixed(0)}% (${wLoss.name})`,
      severity: wLoss.value >= 0.1 ? 'bad' : wLoss.value >= 0.03 ? 'warn' : 'good',
    });
  }

  const aTps = avg(imus, tps);
  const wTps = extreme(imus, tps, 'min');
  if (aTps != null && wTps) {
    m.push({
      label: 'Update rate avg / lowest',
      value: `${aTps.toFixed(0)} / ${wTps.value} Hz (${wTps.name})`,
      severity: wTps.value < 30 ? 'bad' : wTps.value < 60 ? 'warn' : 'good',
    });
  }

  const hot = extreme(imus, temp, 'max');
  if (hot) {
    m.push({
      label: 'Hottest tracker',
      value: `${hot.value.toFixed(0)} C (${hot.name})`,
      severity: hot.value >= 42 ? 'bad' : hot.value >= 38 ? 'warn' : 'good',
    });
  }

  const lowBatt = extreme(imus, batt, 'min');
  if (lowBatt) {
    m.push({
      label: 'Lowest battery',
      value: `${lowBatt.value.toFixed(0)}% (${lowBatt.name})`,
      severity: lowBatt.value <= 15 ? 'bad' : lowBatt.value <= 30 ? 'warn' : 'good',
    });
  }

  // Per-tracker drop counts this session.
  const per = new Map<string, number>();
  for (const e of events.filter((e) => e.down)) {
    per.set(e.trackerName, (per.get(e.trackerName) ?? 0) + 1);
  }
  for (const d of imus) {
    const c = per.get(trackerName(d)) ?? 0;
    m.push({
      label: `${trackerName(d)} drops`,
      value: String(c),
      severity: c === 0 ? 'good' : c < 3 ? 'warn' : 'bad',
    });
  }

  return m;
}
