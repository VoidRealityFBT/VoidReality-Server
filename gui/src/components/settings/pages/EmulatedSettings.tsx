import { useEffect, useState } from 'react';
import { useLocalization } from '@fluent/react';
import { useAtomValue } from 'jotai';
import {
  BodyPart,
  ChangeSettingsRequestT,
  ModelSettingsT,
  ModelTogglesT,
  OSCTrackersSettingT,
  RpcMessage,
  SettingsRequestT,
  SettingsResponseT,
  SteamVRTrackersSettingT,
  VRCOSCSettingsT,
} from 'solarxr-protocol';
import { useWebsocketAPI } from '@/hooks/websocket-api';
import { connectedIMUTrackersAtom } from '@/store/app-store';
import { Typography } from '@/components/commons/Typography';
import { CheckboxInternal } from '@/components/commons/Checkbox';
import {
  SettingsPageLayout,
  SettingsPagePaneLayout,
} from '@/components/settings/SettingsPageLayout';
import { HumanIcon } from '@/components/commons/icon/HumanIcon';

export function EmulatedSettings() {
  const { l10n } = useLocalization();
  const { sendRPCPacket, useRPCPacket } = useWebsocketAPI();
  const [trackers, setTrackers] = useState<SteamVRTrackersSettingT | null>(
    null
  );
  // keep the full toggle set so changing one does not clobber the others
  const [modelToggles, setModelToggles] = useState<ModelTogglesT | null>(null);
  const [oscTrackers, setOscTrackers] = useState<OSCTrackersSettingT | null>(
    null
  );
  const straightLeg = !!modelToggles?.straightLegEmulation;

  useEffect(() => {
    sendRPCPacket(RpcMessage.SettingsRequest, new SettingsRequestT());
  }, []);

  useRPCPacket(RpcMessage.SettingsResponse, (res: SettingsResponseT) => {
    if (res.steamVrTrackers) setTrackers(res.steamVrTrackers);
    if (res.modelSettings?.toggles) setModelToggles(res.modelSettings.toggles);
    if (res.vrcOsc?.trackers) setOscTrackers(res.vrcOsc.trackers);
  });

  const setStraightLegEmulation = (enable: boolean) => {
    if (!modelToggles) return;
    // clone so the other toggle values are preserved and React re-renders
    const next = Object.assign(new ModelTogglesT(), modelToggles);
    next.straightLegEmulation = enable;
    setModelToggles(next);
    const model = new ModelSettingsT();
    model.toggles = next;
    const req = new ChangeSettingsRequestT();
    req.modelSettings = model;
    sendRPCPacket(RpcMessage.ChangeSettingsRequest, req);
  };

  const imuTrackers = useAtomValue(connectedIMUTrackersAtom);
  const belowKneeCount = imuTrackers.filter(({ tracker }) => {
    const bp = tracker.info?.bodyPart;
    return (
      bp === BodyPart.LEFT_FOOT ||
      bp === BodyPart.RIGHT_FOOT ||
      bp === BodyPart.LEFT_LOWER_LEG ||
      bp === BodyPart.RIGHT_LOWER_LEG
    );
  }).length;
  // Emulated legs estimate better with foot or ankle trackers, but this is advice, not a
  // requirement. Elbows are solved from the controllers and need no leg trackers at all.
  const hasLegAnchors = belowKneeCount >= 2;

  const emulateAll =
    !!trackers &&
    !trackers.automaticTrackerToggle &&
    !!trackers.waist &&
    !!trackers.chest &&
    !!trackers.leftFoot &&
    !!trackers.rightFoot &&
    !!trackers.leftKnee &&
    !!trackers.rightKnee &&
    !!trackers.leftElbow &&
    !!trackers.rightElbow;

  const setEmulateAll = (enable: boolean) => {
    const t = trackers ?? new SteamVRTrackersSettingT();
    t.automaticTrackerToggle = !enable;
    if (enable) {
      t.waist = true;
      t.chest = true;
      t.leftFoot = true;
      t.rightFoot = true;
      t.leftKnee = true;
      t.rightKnee = true;
      t.leftElbow = true;
      t.rightElbow = true;
    }
    setTrackers(t);
    const req = new ChangeSettingsRequestT();
    req.steamVrTrackers = t;

    // The VRChat OSC FBT roles follow the toggle so emulation can be fully turned off,
    // not just on SteamVR but on the OSC path too. Other OSC settings untouched :3
    const osc = Object.assign(
      new OSCTrackersSettingT(),
      oscTrackers ?? new OSCTrackersSettingT()
    );
    osc.chest = enable;
    osc.waist = enable;
    osc.knees = enable;
    osc.feet = enable;
    osc.elbows = enable;
    setOscTrackers(osc);
    const vrc = new VRCOSCSettingsT();
    vrc.trackers = osc;
    req.vrcOsc = vrc;

    sendRPCPacket(RpcMessage.ChangeSettingsRequest, req);
  };

  return (
    <SettingsPageLayout>
      <SettingsPagePaneLayout icon={<HumanIcon />} id="emulated">
        <>
          <Typography variant="main-title">
            {l10n.getString('settings-emulated')}
          </Typography>
          <div className="flex flex-col pt-2 pb-4 gap-2">
            {l10n
              .getString('settings-emulated-description')
              .split('\n')
              .map((line, i) => (
                <Typography key={i} color="secondary">
                  {line}
                </Typography>
              ))}
          </div>

          <Typography variant="section-title">
            {l10n.getString('settings-emulated-enable')}
          </Typography>
          <div className="flex flex-col pt-1 pb-2">
            <Typography color="secondary">
              {l10n.getString('settings-emulated-enable-description')}
            </Typography>
            <Typography
              color={hasLegAnchors ? 'text-status-success' : 'secondary'}
            >
              {l10n.getString('settings-emulated-requirement', {
                count: belowKneeCount,
              })}
            </Typography>
          </div>
          <CheckboxInternal
            variant="toggle"
            outlined
            name="emulateAllTrackers"
            checked={emulateAll}
            onChange={(e) =>
              setEmulateAll((e.target as HTMLInputElement).checked)
            }
            label={l10n.getString('settings-emulated-enable-label')}
          />

          <div className="flex flex-col pt-5">
            <Typography variant="section-title">
              {l10n.getString('settings-emulated-straight_leg')}
            </Typography>
            <div className="flex flex-col pt-1 pb-2">
              <Typography color="secondary">
                {l10n.getString('settings-emulated-straight_leg-description')}
              </Typography>
            </div>
            <CheckboxInternal
              variant="toggle"
              outlined
              name="straightLegEmulation"
              checked={straightLeg}
              onChange={(e) =>
                setStraightLegEmulation((e.target as HTMLInputElement).checked)
              }
              label={l10n.getString('settings-emulated-straight_leg-label')}
            />
          </div>
        </>
      </SettingsPagePaneLayout>
    </SettingsPageLayout>
  );
}
