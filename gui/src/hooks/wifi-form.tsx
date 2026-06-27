import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { useOnboarding } from './onboarding';

export interface WifiFormData {
  ssid: string;
  password?: string;
}

export function useWifiForm() {
  const navigate = useNavigate();
  const { state, setWifiCredentials } = useOnboarding();
  const { register, reset, handleSubmit, formState, control } =
    useForm<WifiFormData>({
      defaultValues: {},
      reValidateMode: 'onSubmit',
    });

  useEffect(() => {
    if (state.wifi) {
      reset({
        ssid: state.wifi.ssid,
        password: state.wifi.password,
      });
      return;
    }
    
    let active = true;
    window.electronAPI?.wifiCreds
      ?.get()
      .then((stored) => {
        if (active && stored?.ssid) {
          reset({ ssid: stored.ssid, password: stored.password });
          setWifiCredentials(stored.ssid, stored.password);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const submitWifiCreds = (value: WifiFormData) => {
    const password = value.password ?? '';
    setWifiCredentials(value.ssid, password);
    // Remember the network so connecting the next tracker does not prompt for it again.
    window.electronAPI?.wifiCreds
      ?.set({ ssid: value.ssid, password })
      .catch(() => {});
    navigate('/onboarding/connect-trackers', {
      state: { alonePage: state.alonePage },
    });
  };

  return {
    submitWifiCreds,
    handleSubmit,
    register,
    formState,
    hasWifiCreds: !!state.wifi,
    control,
  };
}
