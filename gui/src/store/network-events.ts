import { DataFeedUpdateT, TrackerDataT, TrackerStatus } from 'solarxr-protocol';

export type NetworkEventReason =
  | 'timed_out'
  | 'disconnected'
  | 'error'
  | 'occluded'
  | 'no_data'
  | 'reconnected';

export interface NetworkEvent {
  time: number;
  trackerKey: string;
  trackerName: string;
  down: boolean;
  reason: NetworkEventReason;
}

interface TrackerState {
  name: string;
  down: boolean;
}

// Session only connection log kept outside react so it survives navigation. Tracks each
// physical tracker as up/down so the Network page can show when one drops and why, covering
// every drop mode: a non-OK status, vanishing from the feed, or freezing (still OK but no
// data). Status change alone misses the freeze case, which is the common one here.
const states = new Map<string, TrackerState>();
const events: NetworkEvent[] = [];
const MAX_EVENTS = 200;
let version = 0;
const sessionStartMs = Date.now();

export function getSessionStartMs() {
  return sessionStartMs;
}

function trackerKey(tracker: TrackerDataT): string | null {
  const num = tracker.trackerId?.trackerNum;
  const dev = tracker.trackerId?.deviceId?.id;
  if (num == null) return null;
  return `${dev ?? 'synthetic'}:${num}`;
}

function trackerName(tracker: TrackerDataT): string {
  const info = tracker.info;
  return info?.customName?.toString() || info?.displayName?.toString() || 'Tracker';
}

// Returns why a tracker is down, or null if it is up and delivering data. A frozen tracker
// stays "OK" but its tps falls to 0; a dropped one reports a "non-OK" status or disappears.
function downReason(
  present: boolean,
  status: TrackerStatus,
  tps: number | null
): NetworkEventReason | null {
  if (!present) return 'no_data';
  switch (status) {
    case TrackerStatus.DISCONNECTED:
      return 'disconnected';
    case TrackerStatus.TIMED_OUT:
      return 'timed_out';
    case TrackerStatus.ERROR:
      return 'error';
    case TrackerStatus.OCCLUDED:
      return 'occluded';
    case TrackerStatus.OK:
      // Connected but no ticks coming in = frozen. tps null means unreported, treat as up.
      return tps === 0 ? 'no_data' : null;
    default:
      return 'no_data';
  }
}

function pushEvent(
  key: string,
  name: string,
  down: boolean,
  reason: NetworkEventReason
) {
  events.push({ time: Date.now(), trackerKey: key, trackerName: name, down, reason });
  if (events.length > MAX_EVENTS) events.shift();
  version++;
}

export function recordNetworkEvents(packet: DataFeedUpdateT) {
  const present = new Map<
    string,
    { name: string; status: TrackerStatus; tps: number | null }
  >();
  for (const device of packet.devices) {
    for (const tracker of device.trackers) {
      // Only physical IMU trackers connect over the network
      if (!(tracker.info?.isImu ?? false)) continue;
      const key = trackerKey(tracker);
      if (key == null) continue;
      present.set(key, {
        name: trackerName(tracker),
        status: tracker.status ?? TrackerStatus.NONE,
        tps: tracker.tps ?? null,
      });
    }
  }

  // Evaluate every tracker we have ever seen plus the ones present now, so a tracker that
  // vanishes from the feed is still flagged as down.
  const keys = new Set<string>([...states.keys(), ...present.keys()]);
  for (const key of keys) {
    const p = present.get(key);
    const reason = downReason(
      p != null,
      p?.status ?? TrackerStatus.NONE,
      p?.tps ?? null
    );
    const down = reason != null;
    const name = p?.name ?? states.get(key)?.name ?? 'Tracker';
    const state = states.get(key);
    if (!state) {
      // Don't log the first sighting so startup isnt noisy
      states.set(key, { name, down });
      continue;
    }
    state.name = name;
    if (down && !state.down) {
      pushEvent(key, name, true, reason ?? 'no_data');
      state.down = true;
    } else if (!down && state.down) {
      pushEvent(key, name, false, 'reconnected');
      state.down = false;
    }
  }
}

export function getNetworkEvents(): NetworkEvent[] {
  return events;
}

export function getNetworkEventsVersion(): number {
  return version;
}

export function clearNetworkEvents() {
  events.length = 0;
  version++;
}
