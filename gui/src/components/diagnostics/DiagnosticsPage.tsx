import { useAtomValue } from 'jotai';
import { useLocalization } from '@fluent/react';
import classNames from 'classnames';
import { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { TrackerDataT } from 'solarxr-protocol';
import { connectedIMUTrackersAtom, FlatDeviceTracker } from '@/store/app-store';
import { useTracker } from '@/hooks/tracker';
import { Typography } from '@/components/commons/Typography';
import { DriftChart } from '@/components/tracker/DriftChart';
import { DriftTrendArrow } from '@/components/tracker/DriftTrendArrow';
import { getDriftStability } from '@/store/drift-history';
import { StayAlignedInfo } from '@/components/stay-aligned/StayAlignedInfo';

function driftColor(rate: number) {
  return classNames({
    'text-status-success': rate < 1,
    'text-status-warning': rate >= 1 && rate < 3,
    'text-status-critical': rate >= 3,
  });
}

// Turns the per tracker signals the server already has into a single calibration verdict
// and a piece of advice, so the user is told whether and why to recalibrate. Drift rate is
// the main quality signal, then the likely cause is picked from battery, heat, and wifi
function qualityVerdict(
  rate: number | null | undefined,
  temp: number | null | undefined,
  packetLoss: number | null | undefined,
  batteryPct: number | null | undefined
): { labelKey: string; color: string; adviceKey: string } {
  if (rate == null || rate === 0) {
    return {
      labelKey: 'diagnostics-quality-measuring',
      color: 'secondary',
      adviceKey: '',
    };
  }
  let labelKey = 'diagnostics-quality-good';
  let color = 'text-status-success';
  if (rate >= 3) {
    labelKey = 'diagnostics-quality-poor';
    color = 'text-status-critical';
  } else if (rate >= 1) {
    labelKey = 'diagnostics-quality-fair';
    color = 'text-status-warning';
  }

  let adviceKey = 'diagnostics-quality-advice-ok';
  if (rate >= 1) {
    if (batteryPct != null && batteryPct <= 30) {
      adviceKey = 'diagnostics-quality-advice-battery';
    } else if (temp != null && temp >= 45) {
      adviceKey = 'diagnostics-quality-advice-hot';
    } else if (packetLoss != null && packetLoss >= 0.05) {
      adviceKey = 'diagnostics-quality-advice-wifi';
    } else {
      adviceKey = 'diagnostics-quality-advice-recalibrate';
    }
  }
  return { labelKey, color, adviceKey };
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 bg-background-60 rounded-md p-2 min-w-24">
      <Typography color="secondary" whitespace="whitespace-nowrap">
        {label}
      </Typography>
      {children}
    </div>
  );
}

function DiagnosticsRow({ data }: { data: FlatDeviceTracker }) {
  const { l10n } = useLocalization();
  const { tracker, device } = data;
  const { useName } = useTracker(tracker);
  const name = useName();
  const navigate = useNavigate();

  const rate = tracker.info?.driftRate;
  const measuredDrift = rate != null && rate !== 0;
  const stability = getDriftStability(tracker);
  const temp = tracker.temp?.temp;
  const packetLoss = device?.hardwareStatus?.packetLoss;

  return (
    <div className="bg-background-70 rounded-lg p-4 flex flex-col gap-3">
      <div
        className="flex justify-between items-center cursor-pointer"
        onClick={() =>
          navigate(
            `/tracker/${tracker.trackerId?.trackerNum}/${tracker.trackerId?.deviceId?.id}`
          )
        }
      >
        <Typography bold variant="section-title">
          {name}
        </Typography>
        <Typography color="secondary">{tracker.status}</Typography>
      </div>
      <div className="flex flex-wrap gap-3">
        <Stat label={l10n.getString('diagnostics-drift')}>
          <div className="flex items-center gap-1">
            <Typography color={measuredDrift ? driftColor(rate) : 'secondary'}>
              {measuredDrift ? rate.toFixed(2) : '--'}
            </Typography>
            <DriftTrendArrow tracker={tracker} />
          </div>
        </Stat>
        <Stat label={l10n.getString('diagnostics-stability')}>
          <Typography color={stability == null ? 'secondary' : 'primary'}>
            {stability == null ? '--' : `±${stability.toFixed(2)}`}
          </Typography>
        </Stat>
        <Stat label={l10n.getString('diagnostics-temp')}>
          <Typography>{temp && temp !== 0 ? temp.toFixed(2) : '--'}</Typography>
        </Stat>
        <Stat label={l10n.getString('diagnostics-stay_aligned')}>
          <StayAlignedInfo color="primary" tracker={tracker} />
        </Stat>
        <Stat label={l10n.getString('diagnostics-ping')}>
          <Typography>
            {device?.hardwareStatus?.ping != null
              ? `${device.hardwareStatus.ping} ms`
              : '--'}
          </Typography>
        </Stat>
        <Stat label={l10n.getString('diagnostics-packet_loss')}>
          <Typography>
            {packetLoss != null ? `${(packetLoss * 100).toFixed(0)}%` : '--'}
          </Typography>
        </Stat>
        <Stat label={l10n.getString('diagnostics-battery')}>
          <Typography>
            {device?.hardwareStatus?.batteryPctEstimate != null
              ? `${device.hardwareStatus.batteryPctEstimate}%`
              : '--'}
          </Typography>
        </Stat>
      </div>
      {(() => {
        const verdict = qualityVerdict(
          rate,
          temp,
          packetLoss,
          device?.hardwareStatus?.batteryPctEstimate
        );
        return (
          <div className="flex flex-col gap-1 bg-background-60 rounded-md p-2">
            <Typography color="secondary" whitespace="whitespace-nowrap">
              {l10n.getString('diagnostics-quality')}
            </Typography>
            <div className="flex items-center gap-2 flex-wrap">
              <Typography bold color={verdict.color}>
                {l10n.getString(verdict.labelKey)}
              </Typography>
              {verdict.adviceKey && (
                <Typography color="secondary">
                  {l10n.getString(verdict.adviceKey)}
                </Typography>
              )}
            </div>
          </div>
        );
      })()}
      <DriftChart tracker={tracker} />
    </div>
  );
}

export function DiagnosticsPage() {
  const { l10n } = useLocalization();
  const trackers = useAtomValue(connectedIMUTrackersAtom);

  const rowKey = (data: FlatDeviceTracker) =>
    `${data.tracker.trackerId?.deviceId?.id}:${data.tracker.trackerId?.trackerNum}`;

  return (
    <div className="overflow-y-auto h-full px-4 py-4 flex flex-col gap-3">
      <Typography variant="main-title">
        {l10n.getString('diagnostics-title')}
      </Typography>
      <Typography color="secondary">
        {l10n.getString('diagnostics-description')}
      </Typography>
      {trackers.length === 0 && (
        <Typography>{l10n.getString('diagnostics-no_trackers')}</Typography>
      )}
      {trackers.map((data: FlatDeviceTracker) => (
        <DiagnosticsRow key={rowKey(data)} data={data} />
      ))}
    </div>
  );
}
