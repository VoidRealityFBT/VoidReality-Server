import { useLocalization } from '@fluent/react';
import { TrackerDataT } from 'solarxr-protocol';
import { Typography } from '@/components/commons/Typography';
import { getDriftHistory } from '@/store/drift-history';

const WIDTH = 280;
const HEIGHT = 60;
const PADDING = 4;

// per-session line chart of the drift measurements taken at each reset
export function DriftChart({ tracker }: { tracker: TrackerDataT }) {
  const { l10n } = useLocalization();
  const history = getDriftHistory(tracker);

  if (history.length < 2) {
    return null;
  }

  const rates = history.map((s) => s.rate);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const span = max - min || 1;

  const points = history
    .map((s, i) => {
      const x = PADDING + (i / (history.length - 1)) * (WIDTH - PADDING * 2);
      const y =
        HEIGHT - PADDING - ((s.rate - min) / span) * (HEIGHT - PADDING * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const latest = rates[rates.length - 1];

  return (
    <div className="flex flex-col gap-1 bg-background-70 rounded-lg p-3">
      <div className="flex justify-between">
        <Typography color="secondary">
          {l10n.getString('tracker-infos-drift_chart')}
        </Typography>
        <Typography color="secondary">
          {min.toFixed(2)} to {max.toFixed(2)}
        </Typography>
      </div>
      <svg
        width="100%"
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
      >
        <polyline
          points={points}
          fill="none"
          stroke="rgb(var(--accent-background-10))"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <div className="flex justify-between">
        <Typography color="secondary">
          {l10n.getString('tracker-infos-drift_chart-resets', {
            amount: history.length,
          })}
        </Typography>
        <Typography>{latest.toFixed(2)}</Typography>
      </div>
    </div>
  );
}
