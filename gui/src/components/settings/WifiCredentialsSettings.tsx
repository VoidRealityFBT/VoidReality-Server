import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Localized, useLocalization } from '@fluent/react';
import { Input } from '@/components/commons/Input';
import { Button } from '@/components/commons/Button';
import { Typography } from '@/components/commons/Typography';

interface WifiForm {
  ssid: string;
  password?: string;
}

export function WifiCredentialsModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { l10n } = useLocalization();
  const { control, handleSubmit, reset, formState } = useForm<WifiForm>({
    defaultValues: { ssid: '', password: '' },
    mode: 'onChange',
  });
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'cleared'>('idle');

  // Reload the stored credentials each time the panel opens so it shows the current network.
  useEffect(() => {
    if (!isOpen) return;
    setStatus('idle');
    let active = true;
    window.electronAPI?.wifiCreds
      ?.get()
      .then((stored) => {
        if (!active) return;
        if (stored?.ssid) {
          reset({ ssid: stored.ssid, password: stored.password });
          setSaved(true);
        } else {
          reset({ ssid: '', password: '' });
          setSaved(false);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isOpen]);

  const onSave = (value: WifiForm) => {
    window.electronAPI?.wifiCreds
      ?.set({ ssid: value.ssid, password: value.password ?? '' })
      .then(() => {
        setSaved(true);
        setStatus('saved');
      })
      .catch(() => {});
  };

  const onForget = () => {
    window.electronAPI?.wifiCreds
      ?.clear()
      .then(() => {
        reset({ ssid: '', password: '' });
        setSaved(false);
        setStatus('cleared');
      })
      .catch(() => {});
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-md bg-background-90/70"
      onClick={onClose}
    >
      <div
        className="bg-background-80 rounded-2xl shadow-2xl p-6 w-[min(90vw,520px)] max-h-[85vh] overflow-y-auto flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <Typography variant="main-title">
          {l10n.getString('settings-network-wifi')}
        </Typography>
        <Typography color="secondary" whitespace="whitespace-pre-line">
          {l10n.getString('settings-network-wifi-description')}
        </Typography>
        <form
          onSubmit={handleSubmit(onSave)}
          className="flex flex-col gap-3 sentry-mask"
        >
          <Localized
            id="settings-network-wifi-ssid"
            attrs={{ placeholder: true, label: true }}
          >
            <Input
              control={control}
              rules={{ required: true }}
              name="ssid"
              type="text"
              label="SSID"
              placeholder="ssid"
              variant="secondary"
            />
          </Localized>
          <Localized
            id="settings-network-wifi-password"
            attrs={{ placeholder: true, label: true }}
          >
            <Input
              control={control}
              name="password"
              type="password"
              label="Password"
              placeholder="password"
              variant="secondary"
            />
          </Localized>
          {status === 'saved' && (
            <Typography color="text-status-success">
              {l10n.getString('settings-network-wifi-saved')}
            </Typography>
          )}
          {status === 'cleared' && (
            <Typography color="secondary">
              {l10n.getString('settings-network-wifi-cleared')}
            </Typography>
          )}
          <div className="flex gap-2 justify-end items-center pt-1">
            <Button variant="tertiary" onClick={onClose}>
              {l10n.getString('settings-network-wifi-close')}
            </Button>
            {saved && (
              <Button variant="secondary" onClick={onForget}>
                {l10n.getString('settings-network-wifi-forget')}
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={!formState.isValid}
            >
              {l10n.getString('settings-network-wifi-save')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}