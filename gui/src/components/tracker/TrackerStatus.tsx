import classNames from 'classnames';
import { useMemo } from 'react';
import {
  DeviceDataT,
  TrackerDataT,
  TrackerStatus as TrackerStatusEnum,
} from 'solarxr-protocol';
import { Typography } from '@/components/commons/Typography';
import { useLocalization } from '@fluent/react';
import { useTrackerFallback } from '@/hooks/fallback';

const statusLabelMap: { [key: number]: string } = {
  [TrackerStatusEnum.NONE]: 'tracker-status-none',
  [TrackerStatusEnum.BUSY]: 'tracker-status-busy',
  [TrackerStatusEnum.ERROR]: 'tracker-status-error',
  [TrackerStatusEnum.DISCONNECTED]: 'tracker-status-disconnected',
  [TrackerStatusEnum.OCCLUDED]: 'tracker-status-occluded',
  [TrackerStatusEnum.OK]: 'tracker-status-ok',
  [TrackerStatusEnum.TIMED_OUT]: 'tracker-status-timed_out',
};

const statusClassMap: { [key: number]: string } = {
  [TrackerStatusEnum.NONE]: 'bg-background-30',
  [TrackerStatusEnum.BUSY]: 'bg-status-warning',
  [TrackerStatusEnum.ERROR]: 'bg-status-critical',
  [TrackerStatusEnum.DISCONNECTED]: 'bg-background-30',
  [TrackerStatusEnum.OCCLUDED]: 'bg-status-warning',
  [TrackerStatusEnum.OK]: 'bg-status-success',
  [TrackerStatusEnum.TIMED_OUT]: 'bg-status-warning',
};

// A tracker reading 0% battery has died rather than just been turned off
function isDead(device?: DeviceDataT) {
  const pct = device?.hardwareStatus?.batteryPctEstimate;
  return pct != null && pct <= 0;
}

export function TrackerStatus({
  status,
  tracker,
  device,
}: {
  status: number;
  tracker?: TrackerDataT;
  device?: DeviceDataT;
}) {
  const { l10n } = useLocalization();
  const { off, fallback } = useTrackerFallback(tracker);

  const { label, dotClass, textClass } = useMemo(() => {
    if (fallback) {
      return {
        label: l10n.getString('tracker-status-fallback'),
        dotClass: 'bg-status-special',
        textClass: 'text-status-special',
      };
    }
    if (off) {
      const dead = isDead(device);
      return {
        label: l10n.getString(
          dead ? 'tracker-status-dead' : 'tracker-status-off'
        ),
        dotClass: dead ? 'bg-status-critical' : 'bg-background-30',
        textClass: undefined,
      };
    }
    return {
      label: l10n.getString(statusLabelMap[status]),
      dotClass: statusClassMap[status],
      textClass: undefined,
    };
  }, [fallback, off, status, device, l10n]);

  return (
    <div className="flex text-default gap-2">
      <div className="flex flex-col justify-center">
        <div className={classNames('w-2 h-2 rounded-full', dotClass)} />
      </div>
      <Typography whitespace="whitespace-nowrap" color={textClass}>
        {label}
      </Typography>
    </div>
  );
}
