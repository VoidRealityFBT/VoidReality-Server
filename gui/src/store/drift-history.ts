import { DataFeedUpdateT, TrackerDataT } from 'solarxr-protocol';

export interface DriftSample {
  time: number;
  rate: number;
}

// session only drift history per tracker, kept outside react so it survives navigation
const histories = new Map<string, DriftSample[]>();

const MAX_SAMPLES = 200;

function trackerKey(tracker: TrackerDataT): string | null {
  const num = tracker.trackerId?.trackerNum;
  const dev = tracker.trackerId?.deviceId?.id;
  if (num == null) return null;
  return `${dev ?? 'synthetic'}:${num}`;
}

function recordTracker(tracker: TrackerDataT) {
  const key = trackerKey(tracker);
  const rate = tracker.info?.driftRate;
  if (key == null || rate == null || rate === 0) return;

  let list = histories.get(key);
  if (!list) {
    list = [];
    histories.set(key, list);
  }

  // the rate only changes when a reset produces a new measurement
  const last = list[list.length - 1];
  if (last && last.rate === rate) return;

  list.push({ time: Date.now(), rate });
  if (list.length > MAX_SAMPLES) list.shift();
}

export function recordDriftSamples(packet: DataFeedUpdateT) {
  for (const device of packet.devices) {
    for (const tracker of device.trackers) {
      recordTracker(tracker);
    }
  }
  for (const tracker of packet.syntheticTrackers) {
    recordTracker(tracker);
  }
}

export function getDriftHistory(tracker: TrackerDataT): DriftSample[] {
  const key = trackerKey(tracker);
  return (key != null ? histories.get(key) : undefined) ?? [];
}

// Standard deviation of the last few distinct drift measurements, in degrees per minute. A
// low number means the estimate has settled (the correction it drives is steady); a high one
// means it is still bouncing reset to reset. Null until there are at least two measurements.
const STABILITY_WINDOW = 6;

export function getDriftStability(tracker: TrackerDataT): number | null {
  const list = getDriftHistory(tracker);
  if (list.length < 2) return null;
  const recent = list.slice(-STABILITY_WINDOW).map((s) => s.rate);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance =
    recent.reduce((a, b) => a + (b - mean) * (b - mean), 0) / recent.length;
  return Math.sqrt(variance);
}

export type DriftTrend = 'up' | 'down' | 'flat' | 'none';

// Compares the latest drift measurement to the previous one for a trend arrow
export function getDriftTrend(tracker: TrackerDataT): DriftTrend {
  const list = getDriftHistory(tracker);
  if (list.length < 2) return 'none';
  const latest = list[list.length - 1].rate;
  const prev = list[list.length - 2].rate;
  const delta = latest - prev;
  // ignore tiny changes so the arrow does not flicker on noise
  if (Math.abs(delta) < 0.1) return 'flat';
  return delta > 0 ? 'up' : 'down';
}
