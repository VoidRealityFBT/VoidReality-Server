import { app } from 'electron';
import path, { join } from 'node:path';
import { getPlatform } from './utils';
import { glob } from 'glob';
import { spawn } from 'node:child_process';
import javaVersionJar from '../resources/java-version/JavaVersion.jar?asset&asarUnpack';
import { existsSync, writeFileSync, readdirSync } from 'node:fs';
import { options } from './cli';

const javaBin = getPlatform() === 'windows' ? 'java.exe' : 'java';
export const CONFIG_IDENTIFIER = 'dev.slimevr.SlimeVR';

export const getGuiDataFolder = () => {
  const platform = getPlatform();

  switch (platform) {
    case 'linux':
      if (process.env['XDG_DATA_HOME'])
        return join(process.env['XDG_DATA_HOME'], CONFIG_IDENTIFIER);
      return join(app.getPath('home'), '.local/share', CONFIG_IDENTIFIER);
    case 'windows':
      return join(app.getPath('appData'), CONFIG_IDENTIFIER);
    case 'macos':
      return join(
        app.getPath('home'),
        'Library/Application Support',
        CONFIG_IDENTIFIER
      );
    case 'unknown':
      throw 'error';
  }
};

export const getServerDataFolder = () => {
  const platform = getPlatform();

  switch (platform) {
    case 'linux':
    case 'windows':
    case 'macos':
      return join(app.getPath('appData'), CONFIG_IDENTIFIER);
    case 'unknown':
      throw 'error';
  }
};

export const getLogsFolder = () => {
  return join(getGuiDataFolder(), 'logs');
};

export const getExeFolder = () => {
  return path.dirname(app.getPath('exe'));
};

export const getWindowStateFile = () =>
  join(getServerDataFolder(), '.window-state.json');

const localJavaBin = (sharedDir: string) => {
  const platform = getPlatform();
  switch (platform) {
    case 'macos':
      return join(sharedDir, '../../../../jre/Contents/Home/bin', javaBin);
    default:
      return join(sharedDir, 'jre/bin', javaBin);
  }
};

const javaHomeBin = () => {
  const javaHome = process.env['JAVA_HOME'];
  if (!javaHome) return null;
  const javaHomeJre = join(javaHome, 'bin', javaBin);
  return javaHomeJre;
};

export const findSystemJRE = async (sharedDir: string) => {
  // Try local bundled JRE, JAVA_HOME, per-user installs (e.g. Adoptium in %LOCALAPPDATA%),
  // then common Windows install directories, Unix system locations, and finally PATH. 
  // For some reason this hasn't been detecting Java 17. Its making me sad :<
  const localAppData = process.env['LOCALAPPDATA'];
  const programFiles = process.env['ProgramFiles'];
  const programFilesX86 = process.env['ProgramFiles(x86)'];

  const perUserJavaBins: string[] = localAppData
    ? await glob(path.join(localAppData, 'Programs', '**', 'bin', javaBin))
    : [];

  const programJavaGlobs: string[] = [];
  if (programFiles) {
    programJavaGlobs.push(
      path.join(programFiles, 'Eclipse Adoptium', '**', 'bin', javaBin),
      path.join(programFiles, 'Java', '**', 'bin', javaBin),
      path.join(programFiles, 'AdoptOpenJDK', '**', 'bin', javaBin),
      path.join(programFiles, 'Microsoft', 'jdk-*', 'bin', javaBin),
      path.join(programFiles, 'Zulu', '**', 'bin', javaBin),
      path.join(programFiles, 'OpenJDK', '**', 'bin', javaBin)
    );
  }
  if (programFilesX86) {
    programJavaGlobs.push(
      path.join(programFilesX86, 'Eclipse Adoptium', '**', 'bin', javaBin),
      path.join(programFilesX86, 'Java', '**', 'bin', javaBin),
      path.join(programFilesX86, 'AdoptOpenJDK', '**', 'bin', javaBin),
      path.join(programFilesX86, 'Microsoft', 'jdk-*', 'bin', javaBin),
      path.join(programFilesX86, 'Zulu', '**', 'bin', javaBin),
      path.join(programFilesX86, 'OpenJDK', '**', 'bin', javaBin)
    );
  }
  
  const userJavaGlobs: string[] = [];
  if (localAppData) {
    userJavaGlobs.push(
      path.join(localAppData, 'Programs', 'Eclipse Adoptium', '**', 'bin', javaBin),
      path.join(localAppData, 'Programs', 'AdoptOpenJDK', '**', 'bin', javaBin),
      path.join(localAppData, 'Programs', 'Java', '**', 'bin', javaBin)
    );
  }

  const programJavaBins = (
    await Promise.all(programJavaGlobs.map((g) => glob(g)))
  ).flat();

  const userJavaBins = (
    await Promise.all(userJavaGlobs.map((g) => glob(g)))
  ).flat();

  const paths = [
    localJavaBin(sharedDir),
    javaHomeBin(),
    ...perUserJavaBins,
    ...userJavaBins,
    ...programJavaBins,
    ...(await glob('/usr/lib/jvm/*/bin/' + javaBin)),
    ...(await glob('/Library/Java/JavaVirtualMachines/*/Contents/Home/bin/' + javaBin)),
    // Fallback to java on PATH
    javaBin,
  ];

  for (const path of paths) {
    if (!path) continue;

    const version = await new Promise<number | null>((resolve) => {
      const process = spawn(path, ['-jar', javaVersionJar], {});

      let version: number | null = null;

      process.stdout?.once('data', (data) => {
        try {
          version = parseFloat(data.toString());
        } catch {
          version = null;
        }
      });

      process.on('error', () => {
        resolve(null);
      });

      process.on('exit', () => {
        resolve(version);
      });
    });
    if (version && version >= 17) return path;
  }
  return null;
};

export const findServerJar = () => {
  const resourceRoot = app.isPackaged
    ? path.resolve(process.resourcesPath, '..')
    : undefined;
  const exeFolder = path.dirname(app.getPath('exe'));

  const paths = [
    options.path ? path.resolve(options.path) : undefined,
    resourceRoot,
    app.isPackaged ? path.resolve(process.resourcesPath) : undefined,
    exeFolder,
    // Some Windows builds place slimevr.jar alongside the executable.
    app.isPackaged ? path.resolve(exeFolder, '..') : undefined,
    // AppImage passes the fakeroot in `APPDIR` env var.
    process.env['APPDIR']
      ? path.resolve(join(process.env['APPDIR'], 'usr/share/slimevr/'))
      : undefined,
    // For flatpak container
    path.resolve('/app/share/slimevr/'),
    path.resolve('/usr/share/slimevr/'),

    // For macOS on steam
    path.resolve(`${app.getPath('exe')}/../../../../`),
  ];
  const candidates = paths.filter((p) => !!p).map((p) => join(p!, 'slimevr.jar'));

  const results = candidates.map((c) => ({ path: c, exists: existsSync(c) }));

  try {
    // write diagnostic trace so packaged app runs leave evidence in the user's data folder
    writeFileSync(join(getGuiDataFolder(), 'findServerJar-debug.json'), JSON.stringify(results, null, 2), {
      encoding: 'utf-8',
    });
  } catch (e) {
    // ignore write failures
  }

  const found = results.find((r) => r.exists);
  return found ? found.path : undefined;
};
