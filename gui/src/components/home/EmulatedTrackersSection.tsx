import { useAtomValue } from 'jotai';
import { useLocalization } from '@fluent/react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BodyPart,
  RpcMessage,
  SettingsRequestT,
  SettingsResponseT,
  SteamVRTrackersSettingT,
  TrackerDataT,
} from 'solarxr-protocol';
import { computedTrackersAtom, flatTrackersAtom } from '@/store/app-store';
import { useWebsocketAPI } from '@/hooks/websocket-api';
import { useTracker } from '@/hooks/tracker';
import { Typography } from '@/components/commons/Typography';
import { BodyPartIcon } from '@/components/commons/BodyPartIcon';
import { formatVector3 } from '@/utils/formatting';

function EmulatedRow({ tracker }: { tracker: TrackerDataT }) {
  const { l10n } = useLocalization();
  const navigate = useNavigate();
  const { useRawRotationEulerDegrees } = useTracker(tracker);
  const rot = useRawRotationEulerDegrees();
  const bodyPart = tracker.info?.bodyPart ?? BodyPart.NONE;
  const partName = tracker.info?.displayName?.toString() || BodyPart[bodyPart];

  return (
    <div
      className="flex items-center gap-4 bg-background-60 hover:bg-background-50 cursor-pointer rounded-lg py-3 px-4 h-[70px]"
      onClick={() => navigate('/emulated')}
    >
      <div className="fill-background-10 border-[3px] border-status-special border-opacity-60 rounded-md overflow-clip">
        <BodyPartIcon bodyPart={bodyPart} width={40} />
      </div>
      <div className="flex flex-col flex-grow">
        <Typography bold>{partName}</Typography>
        <Typography color="text-status-special">
          {l10n.getString('emulated-badge-emulated')}
        </Typography>
      </div>
      <Typography color="secondary" whitespace="whitespace-nowrap">
        {formatVector3(rot, 0)}
      </Typography>
    </div>
  );
}

// Lists the body parts being estimated (no physical tracker) and output as their own
// trackers, only while emulation is actually on
export function EmulatedTrackersSection() {
  const { l10n } = useLocalization();
  const { sendRPCPacket, useRPCPacket } = useWebsocketAPI();
  const [steamvr, setSteamvr] = useState<SteamVRTrackersSettingT | null>(null);
  const computed = useAtomValue(computedTrackersAtom);
  const flat = useAtomValue(flatTrackersAtom);

  useEffect(() => {
    sendRPCPacket(RpcMessage.SettingsRequest, new SettingsRequestT());
  }, []);
  useRPCPacket(RpcMessage.SettingsResponse, (res: SettingsResponseT) => {
    if (res.steamVrTrackers) setSteamvr(res.steamVrTrackers);
  });

  const emulationOn =
    !!steamvr &&
    !steamvr.automaticTrackerToggle &&
    !!steamvr.waist &&
    !!steamvr.chest &&
    !!steamvr.leftFoot &&
    !!steamvr.rightFoot &&
    !!steamvr.leftKnee &&
    !!steamvr.rightKnee &&
    !!steamvr.leftElbow &&
    !!steamvr.rightElbow;

  // Body parts that have a real (non-computed) tracker, including the headset and
  // controllers, so head and hands are never counted as emulated
  const realParts = useMemo(
    () =>
      new Set(
        [...flat, ...computed]
          .filter(({ tracker }) => tracker.info && !tracker.info.isComputed)
          .map(({ tracker }) => tracker.info!.bodyPart)
          .filter((p) => p != null && p !== BodyPart.NONE)
      ),
    [flat, computed]
  );

  const emulated = useMemo(
    () =>
      computed.filter(
        ({ tracker }) =>
          tracker.info?.isComputed &&
          tracker.info.bodyPart != null &&
          tracker.info.bodyPart !== BodyPart.NONE &&
          !realParts.has(tracker.info.bodyPart)
      ),
    [computed, realParts]
  );

  if (!emulationOn || emulated.length === 0) return null;

  return (
    <>
      <div className="flex w-full gap-2 items-center px-4 h-5">
        <Typography color="secondary">
          {l10n.getString('toolbar-emulated_trackers', {
            count: emulated.length,
          })}
        </Typography>
        <div className="bg-background-50 h-[2px] rounded-lg flex-grow" />
      </div>
      <div className="grid sm:grid-cols-1 md:grid-cols-2 gap-4 px-5 my-3">
        {emulated.map(({ tracker }) => (
          <EmulatedRow
            key={`${tracker.trackerId?.deviceId?.id}:${tracker.trackerId?.trackerNum}`}
            tracker={tracker}
          />
        ))}
      </div>
    </>
  );
}
