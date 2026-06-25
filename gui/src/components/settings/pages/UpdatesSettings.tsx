import { useEffect, useState } from 'react';
import { useLocalization } from '@fluent/react';
import { useNavigate } from 'react-router-dom';
import {
  ChangeSettingsRequestT,
  ModelSettingsT,
  ModelTogglesT,
  RpcMessage,
  SettingsRequestT,
  SettingsResponseT,
} from 'solarxr-protocol';
import { FirmwareUpdateFlow } from '@/components/updates/FirmwareUpdateFlow';
import { useWebsocketAPI } from '@/hooks/websocket-api';
import { Typography } from '@/components/commons/Typography';
import { Button } from '@/components/commons/Button';
import { CheckboxInternal } from '@/components/commons/Checkbox';
import {
  SettingsPageLayout,
  SettingsPagePaneLayout,
} from '@/components/settings/SettingsPageLayout';
import { DownloadIcon } from '@/components/commons/icon/DownloadIcon';

export function UpdatesSettings() {
  const { l10n } = useLocalization();
  const navigate = useNavigate();
  const { sendRPCPacket, useRPCPacket } = useWebsocketAPI();
  const [modelToggles, setModelToggles] = useState<ModelTogglesT | null>(null);
  const [showFlow, setShowFlow] = useState(false);

  useEffect(() => {
    sendRPCPacket(RpcMessage.SettingsRequest, new SettingsRequestT());
  }, []);

  useRPCPacket(RpcMessage.SettingsResponse, (res: SettingsResponseT) => {
    if (res.modelSettings?.toggles) setModelToggles(res.modelSettings.toggles);
  });

  // Stock mode means none of the VoidReality runtime features are on. The build-flag
  // firmware features still need a reflash to undo, which is what the revert section is for.
  const stockMode =
    !!modelToggles &&
    !modelToggles.fallbackTracking &&
    !modelToggles.straightLegEmulation;

  const setStockMode = (enable: boolean) => {
    if (!modelToggles) return;
    const next = Object.assign(new ModelTogglesT(), modelToggles);
    // Stock mode turns the VoidReality runtime features off. Leaving stock mode restores
    // fallback tracking, which is the on-by-default VoidReality behavior.
    next.fallbackTracking = !enable;
    next.straightLegEmulation = false;
    setModelToggles(next);
    const model = new ModelSettingsT();
    model.toggles = next;
    const req = new ChangeSettingsRequestT();
    req.modelSettings = model;
    sendRPCPacket(RpcMessage.ChangeSettingsRequest, req);
  };

  return (
    <SettingsPageLayout>
      <SettingsPagePaneLayout icon={<DownloadIcon />} id="updates">
        <>
          <Typography variant="main-title">
            {l10n.getString('settings-updates')}
          </Typography>
          <div className="flex flex-col pt-2 pb-4 gap-2">
            <Typography color="secondary">
              {l10n.getString('settings-updates-description')}
            </Typography>
          </div>

          <Typography variant="section-title">
            {l10n.getString('settings-updates-stock_mode')}
          </Typography>
          <div className="flex flex-col pt-1 pb-2">
            <Typography color="secondary" whitespace="whitespace-pre-line">
              {l10n.getString('settings-updates-stock_mode-description')}
            </Typography>
          </div>
          <CheckboxInternal
            variant="toggle"
            outlined
            name="stockMode"
            checked={stockMode}
            onChange={(e) =>
              setStockMode((e.target as HTMLInputElement).checked)
            }
            label={l10n.getString('settings-updates-stock_mode-label')}
          />

          <div className="flex flex-col pt-5">
            <Typography variant="section-title">
              {l10n.getString('settings-updates-firmware')}
            </Typography>
            <div className="flex flex-col pt-1 pb-3">
              <Typography color="secondary" whitespace="whitespace-pre-line">
                {l10n.getString('settings-updates-firmware-description')}
              </Typography>
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => navigate('/settings/firmware-tool')}
              >
                {l10n.getString('settings-updates-firmware-wired')}
              </Button>
              <Button variant="primary" onClick={() => setShowFlow(true)}>
                {l10n.getString('settings-updates-firmware-flash')}
              </Button>
            </div>
          </div>

          <div className="flex flex-col pt-5">
            <Typography variant="section-title">
              {l10n.getString('settings-updates-revert')}
            </Typography>
            <div className="flex flex-col pt-1 pb-3">
              <Typography color="secondary" whitespace="whitespace-pre-line">
                {l10n.getString('settings-updates-revert-description')}
              </Typography>
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => navigate('/settings/firmware-tool')}
              >
                {l10n.getString('settings-updates-revert-button')}
              </Button>
            </div>
          </div>
        </>
      </SettingsPagePaneLayout>
      <FirmwareUpdateFlow open={showFlow} onClose={() => setShowFlow(false)} />
    </SettingsPageLayout>
  );
}
