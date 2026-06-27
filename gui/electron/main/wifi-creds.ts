import { safeStorage } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { getServerDataFolder } from './paths';
import { logger } from './logger';
import { WifiCreds } from '../shared';

const credsFile = () => join(getServerDataFolder(), 'wifi-creds.enc');

export function getWifiCreds(): WifiCreds | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const file = credsFile();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(file)));
    if (parsed && typeof parsed.ssid === 'string') {
      return { ssid: parsed.ssid, password: parsed.password ?? '' };
    }
    return null;
  } catch (err) {
    logger.error({ err }, 'Failed to read stored WiFi credentials');
    return null;
  }
}

export function setWifiCreds(creds: WifiCreds): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      logger.warn('OS secure storage unavailable; not storing WiFi credentials');
      return false;
    }
    mkdirSync(getServerDataFolder(), { recursive: true });
    const encrypted = safeStorage.encryptString(
      JSON.stringify({ ssid: creds.ssid, password: creds.password ?? '' })
    );
    writeFileSync(credsFile(), encrypted);
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to store WiFi credentials');
    return false;
  }
}

export function clearWifiCreds(): boolean {
  try {
    const file = credsFile();
    if (existsSync(file)) rmSync(file);
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to clear WiFi credentials');
    return false;
  }
}