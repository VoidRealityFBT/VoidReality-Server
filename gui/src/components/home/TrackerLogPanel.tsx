import { useAtomValue } from 'jotai';
import { useLocalization } from '@fluent/react';
import { useMemo, useState } from 'react';
import {
  BoardType,
  BodyPart,
  DeviceDataT,
  MagnetometerStatus,
  McuType,
  TrackerDataT,
} from 'solarxr-protocol';
import {
  computedTrackersAtom,
  flatTrackersAtom,
  FlatDeviceTracker,
} from '@/store/app-store';
import { useTracker } from '@/hooks/tracker';
import { Typography } from '@/components/commons/Typography';
import { Button } from '@/components/commons/Button';

function num(value: number | null | undefined, digits = 2) {
  return value == null ? '--' : value.toFixed(digits);
}

function str(value: string | null | undefined) {
  const s = value?.toString();
  return s && s.length > 0 ? s : '--';
}

function enumName(e: Record<number, string>, value: number | null | undefined) {
  return value == null ? '--' : e[value] ?? String(value);
}

// Euler degrees from a trackers stored quaternion, so the text copy needs no hook
function eulerFromTracker(tracker: TrackerDataT): { x: number; y: number; z: number } {
  const r = tracker.rotation;
  if (!r) return { x: 0, y: 0, z: 0 };
  const x = r.x ?? 0;
  const y = r.y ?? 0;
  const z = r.z ?? 0;
  const w = r.w ?? 1;
  const toDeg = 180 / Math.PI;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return { x: roll * toDeg, y: pitch * toDeg, z: yaw * toDeg };
}

// Every field the desktop has for one tracker, as label/value pairs, used for both the rendered grid and the text copy
function buildRows(
  tracker: TrackerDataT,
  device: DeviceDataT | undefined,
  euler: { x: number; y: number; z: number }
): [string, string][] {
  const info = tracker.info;
  const hw = device?.hardwareInfo;
  const st = device?.hardwareStatus;
  const pos = tracker.position;
  return [
    ['Name', str(info?.customName?.toString() || info?.displayName?.toString())],
    ['Body part', info?.bodyPart != null ? BodyPart[info.bodyPart] : '--'],
    [
      'Kind',
      info?.isComputed
        ? 'Computed'
        : info?.isHmd
          ? 'HMD'
          : info?.isImu
            ? 'IMU'
            : '--',
    ],
    ['Status', String(tracker.status)],
    ['TPS', tracker.tps != null ? String(tracker.tps) : '--'],
    [
      'Rotation X/Y/Z',
      `${num(euler.x, 1)} / ${num(euler.y, 1)} / ${num(euler.z, 1)}`,
    ],
    ['Position X/Y/Z', pos ? `${num(pos.x)} / ${num(pos.y)} / ${num(pos.z)}` : '--'],
    ['Temp C', num(tracker.temp?.temp)],
    ['Drift deg/min', info?.driftRate != null ? num(info.driftRate) : '--'],
    ['Magnetometer', enumName(MagnetometerStatus, info?.magnetometer)],
    ['Manufacturer', str(hw?.manufacturer?.toString())],
    ['Model', str(hw?.model?.toString())],
    ['Board', str(hw?.boardType?.toString())],
    ['Official board', enumName(BoardType, hw?.officialBoardType)],
    ['MCU', enumName(McuType, hw?.mcuId)],
    ['Hardware rev', str(hw?.hardwareRevision?.toString())],
    ['Firmware', str(hw?.firmwareVersion?.toString())],
    ['Firmware date', str(hw?.firmwareDate?.toString())],
    [
      'Protocol ver',
      hw?.networkProtocolVersion != null ? String(hw.networkProtocolVersion) : '--',
    ],
    ['Battery %', st?.batteryPctEstimate != null ? String(st.batteryPctEstimate) : '--'],
    ['Battery V', num(st?.batteryVoltage)],
    ['Ping ms', st?.ping != null ? String(st.ping) : '--'],
    ['RSSI dBm', st?.rssi != null ? String(st.rssi) : '--'],
    ['MCU temp C', num(st?.mcuTemp)],
    [
      'Packet loss',
      st?.packetLoss != null ? `${(st.packetLoss * 100).toFixed(0)}%` : '--',
    ],
    [
      'Packets lost/recv',
      st?.packetsLost != null || st?.packetsReceived != null
        ? `${st?.packetsLost ?? '--'} / ${st?.packetsReceived ?? '--'}`
        : '--',
    ],
  ];
}

function TrackerLog({ data }: { data: FlatDeviceTracker }) {
  const { tracker, device } = data;
  const { useRawRotationEulerDegrees } = useTracker(tracker);
  const euler = useRawRotationEulerDegrees();
  const rows = buildRows(tracker, device, euler);

  return (
    <div className="bg-background-70 rounded-lg p-3 flex flex-col gap-2">
      <Typography bold variant="section-title">
        {rows[0][1]}
      </Typography>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1">
        {rows.slice(1).map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <Typography color="secondary" whitespace="whitespace-nowrap">
              {label}
            </Typography>
            <Typography whitespace="whitespace-nowrap">{value}</Typography>
          </div>
        ))}
      </div>
    </div>
  );
}

// A collapsible panel on the home page that dumps every field the desktop has for each
// tracker, so problems are easy to read and easy to screenshot or copy as text.
export function TrackerLogPanel() {
  const { l10n } = useLocalization();
  const [open, setOpen] = useState(false);
  const flat = useAtomValue(flatTrackersAtom);
  const computed = useAtomValue(computedTrackersAtom);

  const all = useMemo<FlatDeviceTracker[]>(
    () => [...flat, ...computed],
    [flat, computed]
  );

  const copyAll = () => {
    const text = all
      .map(({ tracker, device }) =>
        buildRows(tracker, device, eulerFromTracker(tracker))
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')
      )
      .join('\n\n');
    navigator.clipboard?.writeText(text);
  };

  if (all.length === 0) return null;

  return (
    <>
      <div className="flex w-full gap-2 items-center px-4 h-5">
        <div
          className="flex gap-2 items-center cursor-pointer select-none"
          onClick={() => setOpen((v) => !v)}
        >
          <Typography color="secondary">
            {l10n.getString('home-tracker_logs', { count: all.length })}
          </Typography>
          <Typography color="secondary">{open ? '-' : '+'}</Typography>
        </div>
        <div className="bg-background-50 h-[2px] rounded-lg flex-grow" />
        {open && (
          <Button variant="secondary" onClick={copyAll}>
            {l10n.getString('home-tracker_logs-copy')}
          </Button>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-3 px-5 my-2">
          {all.map((data) => (
            <TrackerLog
              key={`${data.tracker.trackerId?.deviceId?.id}:${data.tracker.trackerId?.trackerNum}`}
              data={data}
            />
          ))}
        </div>
      )}
    </>
  );
}
