import { useAtomValue } from 'jotai';
import { useLocalization } from '@fluent/react';
import { connectedIMUTrackersAtom } from '@/store/app-store';
import { Typography } from '@/components/commons/Typography';

// Shows whether "Stay Aligned" is actively correcting and how much across the body
export function StayAlignedStatus() {
  const { l10n } = useLocalization();
  const trackers = useAtomValue(connectedIMUTrackersAtom);

  const active = trackers.filter(({ tracker }) => tracker.stayAligned != null);
  if (active.length === 0) {
    return null;
  }

  const totalCorrection = active.reduce(
    (sum, { tracker }) =>
      sum + Math.abs(tracker.stayAligned!.yawCorrectionInDeg),
    0
  );
  const lockedCount = active.filter(({ tracker }) => tracker.stayAligned!.locked)
    .length;

  return (
    <div className="flex gap-4 items-center bg-background-60 rounded-lg mx-4 px-4 py-2">
      <div className="flex gap-2 items-center">
        <div className="w-2 h-2 rounded-full bg-status-success" />
        <Typography color="secondary">
          {l10n.getString('home-stay_aligned-active')}
        </Typography>
      </div>
      <div className="flex gap-1">
        <Typography color="secondary">
          {l10n.getString('home-stay_aligned-correction')}
        </Typography>
        <Typography>{totalCorrection.toFixed(1)}</Typography>
      </div>
      <div className="flex gap-1">
        <Typography color="secondary">
          {l10n.getString('home-stay_aligned-locked')}
        </Typography>
        <Typography>
          {lockedCount}/{active.length}
        </Typography>
      </div>
    </div>
  );
}
