import { useAtomValue } from 'jotai';
import { BodyPart, TrackerDataT, TrackerStatus } from 'solarxr-protocol';
import { fallbackEnabledAtom, flatTrackersAtom } from '@/store/app-store';

export const offStatuses = new Set<number>([
  TrackerStatus.DISCONNECTED,
  TrackerStatus.TIMED_OUT,
  TrackerStatus.ERROR,
]);

// Body parts whose live trackers can drive each other's fallback estimate. A dead tracker
// is only meaningfully estimated while another tracker in its own limb is still alive. The
// hip and spine drive a leg only as a dangling guess, so legs are kept separate from spine.
const LIMB_GROUPS: BodyPart[][] = [
  [BodyPart.LEFT_UPPER_LEG, BodyPart.LEFT_LOWER_LEG, BodyPart.LEFT_FOOT],
  [BodyPart.RIGHT_UPPER_LEG, BodyPart.RIGHT_LOWER_LEG, BodyPart.RIGHT_FOOT],
  [BodyPart.LEFT_UPPER_ARM, BodyPart.LEFT_LOWER_ARM, BodyPart.LEFT_HAND],
  [BodyPart.RIGHT_UPPER_ARM, BodyPart.RIGHT_LOWER_ARM, BodyPart.RIGHT_HAND],
  [BodyPart.CHEST, BodyPart.UPPER_CHEST, BodyPart.WAIST, BodyPart.HIP],
];

function groupOf(bodyPart: BodyPart): BodyPart[] | undefined {
  return LIMB_GROUPS.find((g) => g.includes(bodyPart));
}

// Decides whether an off tracker is being kept alive by an estimate (fallback) or is just
// off because nothing is left to estimate it from
export function useTrackerFallback(tracker?: TrackerDataT) {
  const fallbackEnabled = useAtomValue(fallbackEnabledAtom);
  const flat = useAtomValue(flatTrackersAtom);

  const status = tracker?.status;
  const off = status != null && offStatuses.has(status);
  const bodyPart = tracker?.info?.bodyPart ?? BodyPart.NONE;
  const assigned = bodyPart !== BodyPart.NONE;
  const isImu = !!tracker?.info?.isImu;

  const group = groupOf(bodyPart);
  const hasLiveSource =
    !!group &&
    flat.some(({ tracker: t }) => {
      const otherPart = t.info?.bodyPart;
      return (
        t.info?.isImu &&
        otherPart != null &&
        otherPart !== bodyPart &&
        group.includes(otherPart) &&
        !offStatuses.has(t.status)
      );
    });

  const fallback = off && assigned && isImu && fallbackEnabled && hasLiveSource;
  return { off, fallback };
}
