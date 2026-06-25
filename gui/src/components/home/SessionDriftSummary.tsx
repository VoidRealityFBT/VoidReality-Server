import { useAtomValue } from 'jotai';
import { useLocalization } from '@fluent/react';
import { useNavigate } from 'react-router-dom';
import classNames from 'classnames';
import { connectedIMUTrackersAtom } from '@/store/app-store';
import { Typography } from '@/components/commons/Typography';

function driftColor(rate: number) {
  return classNames({
    'text-status-success': rate < 1,
    'text-status-warning': rate >= 1 && rate < 3,
    'text-status-critical': rate >= 3,
  });
}

// summary of the measured drift across all connected imu trackers
export function SessionDriftSummary() {
  const { l10n } = useLocalization();
  const navigate = useNavigate();
  const trackers = useAtomValue(connectedIMUTrackersAtom);

  const measured = trackers.filter(
    ({ tracker }) =>
      tracker.info?.driftRate != null && tracker.info.driftRate !== 0
  );
  if (measured.length === 0) {
    return null;
  }

  const rates = measured.map(({ tracker }) => tracker.info!.driftRate!);
  const average = rates.reduce((a, b) => a + b, 0) / rates.length;
  const worst = measured.reduce((a, b) =>
    a.tracker.info!.driftRate! >= b.tracker.info!.driftRate! ? a : b
  );
  const worstRate = worst.tracker.info!.driftRate!;
  const worstName =
    worst.tracker.info?.customName?.toString() ||
    worst.tracker.info?.displayName?.toString() ||
    '';

  return (
    <div
      className="flex gap-4 items-center bg-background-60 hover:bg-background-50 cursor-pointer rounded-lg mx-4 mt-3 px-4 py-2"
      onClick={() => navigate('/diagnostics')}
    >
      <Typography color="secondary">
        {l10n.getString('home-drift_summary')}
      </Typography>
      <div className="flex gap-1">
        <Typography color="secondary">
          {l10n.getString('home-drift_summary-average')}
        </Typography>
        <Typography color={driftColor(average)}>
          {average.toFixed(2)}
        </Typography>
      </div>
      <div className="flex gap-1">
        <Typography color="secondary">
          {l10n.getString('home-drift_summary-worst')}
        </Typography>
        <Typography color={driftColor(worstRate)}>
          {worstName} {worstRate.toFixed(2)}
        </Typography>
      </div>
      <div className="flex gap-1">
        <Typography color="secondary">
          {l10n.getString('home-drift_summary-measured')}
        </Typography>
        <Typography>
          {measured.length}/{trackers.length}
        </Typography>
      </div>
    </div>
  );
}
