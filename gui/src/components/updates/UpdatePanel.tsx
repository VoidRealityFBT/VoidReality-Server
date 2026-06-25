import { useEffect, useRef, useState } from 'react';
import { useLocalization } from '@fluent/react';
import { useNavigate } from 'react-router-dom';
import { useUpdates, UpdateInfo } from '@/hooks/updates';
import { openUrl } from '@/hooks/crossplatform';
import { Typography } from '@/components/commons/Typography';
import { Button } from '@/components/commons/Button';
import { FirmwareUpdateFlow } from './FirmwareUpdateFlow';

function ReleaseNotes({ info }: { info: UpdateInfo }) {
  const { l10n } = useLocalization();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <Typography variant="section-title" bold>
          {info.version}
        </Typography>
        {info.date && (
          <Typography color="secondary">
            {new Date(info.date).toLocaleDateString()}
          </Typography>
        )}
      </div>
      <div className="max-h-48 overflow-y-auto bg-background-70 rounded-md p-2">
        <Typography whitespace="whitespace-pre-line" color="secondary">
          {info.notes?.trim() || l10n.getString('updates-no_notes')}
        </Typography>
      </div>
    </div>
  );
}

export function UpdatePanel() {
  const { l10n } = useLocalization();
  const navigate = useNavigate();
  const { app, firmware, hasUpdate, dismissApp, dismissFirmware } =
    useUpdates();
  const [showFirmwareChoices, setShowFirmwareChoices] = useState(false);
  const [showFlow, setShowFlow] = useState(false);
  const notified = useRef(false);

  // Fire one desktop notification when an update first appears, so a user in VR is told
  useEffect(() => {
    if (!hasUpdate || notified.current) return;
    notified.current = true;
    try {
      const fire = () =>
        new Notification(l10n.getString('updates-notification-title'), {
          body: l10n.getString('updates-notification-body'),
        });
      if (typeof Notification !== 'undefined') {
        if (Notification.permission === 'granted') fire();
        else if (Notification.permission !== 'denied')
          Notification.requestPermission().then(
            (p) => p === 'granted' && fire()
          );
      }
    } catch {
      // notifications not available, ignore
    }
  }, [hasUpdate, l10n]);

  if (!hasUpdate && !showFlow) return null;

  return (
    <>
      {hasUpdate && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-md bg-background-90/70">
          <div className="bg-background-80 rounded-2xl shadow-2xl p-6 w-[min(90vw,560px)] max-h-[85vh] overflow-y-auto flex flex-col gap-5">
            <Typography variant="main-title">
              {l10n.getString('updates-title')}
            </Typography>

            {app && (
              <div className="flex flex-col gap-3">
                <Typography variant="section-title" color="text-status-special">
                  {l10n.getString('updates-app-heading')}
                </Typography>
                <ReleaseNotes info={app} />
                <div className="flex gap-2 justify-end">
                  <Button variant="tertiary" onClick={() => dismissApp()}>
                    {l10n.getString('updates-opt_out')}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => openUrl(app.url ?? '')}
                  >
                    {l10n.getString('updates-update')}
                  </Button>
                </div>
              </div>
            )}

            {firmware && (
              <div className="flex flex-col gap-3">
                <Typography variant="section-title" color="text-status-special">
                  {l10n.getString('updates-firmware-heading')}
                </Typography>
                <ReleaseNotes info={firmware} />
                {!showFirmwareChoices ? (
                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="tertiary"
                      onClick={() => dismissFirmware()}
                    >
                      {l10n.getString('updates-opt_out')}
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => setShowFirmwareChoices(true)}
                    >
                      {l10n.getString('updates-update')}
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Typography color="secondary">
                      {l10n.getString('updates-firmware-choose')}
                    </Typography>
                    <div className="flex gap-2 justify-end">
                      <Button
                        variant="secondary"
                        onClick={() => navigate('/firmware-tool')}
                      >
                        {l10n.getString('updates-firmware-wired')}
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() => setShowFlow(true)}
                      >
                        {l10n.getString('updates-firmware-wireless')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <FirmwareUpdateFlow open={showFlow} onClose={() => setShowFlow(false)} />
    </>
  );
}
