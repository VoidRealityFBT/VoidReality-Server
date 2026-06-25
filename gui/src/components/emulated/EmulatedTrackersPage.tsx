import { useAtomValue } from 'jotai';
import { useLocalization } from '@fluent/react';
import { useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { BodyPart, TrackerDataT } from 'solarxr-protocol';
import { computedTrackersAtom, flatTrackersAtom } from '@/store/app-store';
import { Typography } from '@/components/commons/Typography';
import { BodyPartIcon } from '@/components/commons/BodyPartIcon';
import { Button } from '@/components/commons/Button';

function EmulatedRow({
  tracker,
  emulated,
}: {
  tracker: TrackerDataT;
  emulated: boolean;
}) {
  const { l10n } = useLocalization();
  const bodyPart = tracker.info?.bodyPart ?? BodyPart.NONE;
  const name =
    tracker.info?.customName?.toString() ||
    tracker.info?.displayName?.toString() ||
    BodyPart[bodyPart];

  return (
    <div className="flex items-center gap-3 bg-background-70 rounded-lg p-3">
      <div className="fill-background-10">
        <BodyPartIcon bodyPart={bodyPart} width={32} />
      </div>
      <div className="flex flex-col flex-grow">
        <Typography bold>{name}</Typography>
        <Typography color="secondary">{tracker.status}</Typography>
      </div>
      <div
        className={
          emulated
            ? 'text-status-special bg-status-special bg-opacity-20 rounded-md px-3 py-1'
            : 'text-status-success bg-status-success bg-opacity-20 rounded-md px-3 py-1'
        }
      >
        <Typography>
          {emulated
            ? l10n.getString('emulated-badge-emulated')
            : l10n.getString('emulated-badge-real')}
        </Typography>
      </div>
    </div>
  );
}

export function EmulatedTrackersPage() {
  const { l10n } = useLocalization();
  const computed = useAtomValue(computedTrackersAtom);
  const flat = useAtomValue(flatTrackersAtom);

  // a body part is real backed if any non computed tracker covers it, including the
  // headset and controllers, else the computed tracker for it is emulated
  const realParts = useMemo(
    () =>
      new Set(
        [...flat, ...computed]
          .filter(({ tracker }) => tracker.info && !tracker.info.isComputed)
          .map(({ tracker }) => tracker.info!.bodyPart)
          .filter((p): p is BodyPart => p != null && p !== BodyPart.NONE)
      ),
    [flat, computed]
  );

  const rows = useMemo(
    () =>
      computed
        .filter(
          ({ tracker }) =>
            tracker.info?.isComputed &&
            tracker.info.bodyPart != null &&
            tracker.info.bodyPart !== BodyPart.NONE
        )
        .map(({ tracker }) => ({
          tracker,
          emulated: !realParts.has(tracker.info!.bodyPart),
        })),
    [computed, realParts]
  );

  const emulatedCount = rows.filter((r) => r.emulated).length;

  return (
    <div className="overflow-y-auto h-full px-4 py-4 flex flex-col gap-3">
      <div className="flex justify-between items-center">
        <Typography variant="main-title">
          {l10n.getString('emulated-title')}
        </Typography>
        <Button variant="secondary" to="/settings/emulated">
          {l10n.getString('emulated-open_settings')}
        </Button>
      </div>
      <Typography color="secondary">
        {l10n.getString('emulated-description', {
          emulated: emulatedCount,
          total: rows.length,
        })}
      </Typography>
      {rows.length === 0 && (
        <Typography>{l10n.getString('emulated-none')}</Typography>
      )}
      <div className="grid sm:grid-cols-1 md:grid-cols-2 gap-3">
        {rows.map(({ tracker, emulated }) => (
          <NavLink
            key={`${tracker.trackerId?.deviceId?.id}:${tracker.trackerId?.trackerNum}`}
            to="#"
            onClick={(e) => e.preventDefault()}
          >
            <EmulatedRow tracker={tracker} emulated={emulated} />
          </NavLink>
        ))}
      </div>
    </div>
  );
}
