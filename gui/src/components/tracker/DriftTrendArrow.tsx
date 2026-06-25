import { TrackerDataT } from 'solarxr-protocol';
import { getDriftTrend } from '@/store/drift-history';

// Small arrow showing whether a tracker's drift went up or down at the last reset
export function DriftTrendArrow({ tracker }: { tracker: TrackerDataT }) {
  const trend = getDriftTrend(tracker);
  if (trend === 'none') return null;

  if (trend === 'flat') {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" className="inline-block">
        <line
          x1="1"
          y1="5"
          x2="9"
          y2="5"
          className="stroke-status-warning"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  // up means drift got worse, down means it improved
  const up = trend === 'up';
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" className="inline-block">
      <polyline
        points={up ? '2,7 5,2 8,7' : '2,3 5,8 8,3'}
        fill="none"
        className={up ? 'stroke-status-critical' : 'stroke-status-success'}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
