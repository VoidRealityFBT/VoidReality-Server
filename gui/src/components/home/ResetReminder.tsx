import { useAtomValue } from 'jotai';
import { useState } from 'react';
import { useLocalization } from '@fluent/react';
import { connectedIMUTrackersAtom, lastResetTimeAtom } from '@/store/app-store';
import { Typography } from '@/components/commons/Typography';

// Estimated accumulated drift (degrees) past which we nudge for a reset.
const REMIND_THRESHOLD_DEG = 12;

// Nudges for a reset once a tracker has likely drifted a noticeable amount since the last
// reset. Accumulated drift is estimated as the measured drift rate times the time since the
// last reset, so it self clears on reset and only appears when it has actually built up
export function ResetReminder() {
  const { l10n } = useLocalization();
  const trackers = useAtomValue(connectedIMUTrackersAtom);
  const lastReset = useAtomValue(lastResetTimeAtom);
  const [dismissedAt, setDismissedAt] = useState(0);

  const minutesSinceReset = (Date.now() - lastReset) / 60000;

  let worst = 0;
  let worstName = '';
  for (const { tracker } of trackers) {
    const rate = tracker.info?.driftRate;
    if (rate == null || rate === 0) continue;
    const accumulated = rate * minutesSinceReset;
    if (accumulated > worst) {
      worst = accumulated;
      worstName =
        tracker.info?.customName?.toString() ||
        tracker.info?.displayName?.toString() ||
        '';
    }
  }

  if (worst < REMIND_THRESHOLD_DEG || dismissedAt === lastReset) return null;

  return (
    <div className="flex gap-3 items-center bg-background-60 rounded-lg mx-4 mt-3 px-4 py-2">
      <Typography
        color="text-status-warning"
        bold
        whitespace="whitespace-nowrap"
      >
        {l10n.getString('home-reset_reminder-title')}
      </Typography>
      <Typography color="secondary">
        {l10n.getString('home-reset_reminder-detail', {
          tracker: worstName,
          degrees: Math.round(worst),
        })}
      </Typography>
      <div className="flex-grow" />
      <div
        className="cursor-pointer select-none"
        onClick={() => setDismissedAt(lastReset)}
      >
        <Typography color="secondary" whitespace="whitespace-nowrap">
          {l10n.getString('home-reset_reminder-dismiss')}
        </Typography>
      </div>
    </div>
  );
}
