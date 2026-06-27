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

// glob treats backslashes as escape characters, so a path.join() pattern (backslashes on
// Windows) silently matches nothing. Normalize to forward slashes, which glob always treats as
// separators. THIS is why Java was never detected(I hate windows.)
const globWin = (pattern: string) => glob(pattern.replace(/\\/g, '/'));

// Reads the major Java version of a java binary. Tries the bundled JavaVersion.jar, then falls
// back to parsing `java -version` (printed to stderr like 'version "21.0.1"'), so a missing or
// unreadable helper jar in the packaged app cannot make a perfectly good JDK look invalid.
const javaMajorVersion = (javaPath: string): Promise<number | null> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (v: number | null) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let out = '';
    const p = spawn(javaPath, ['-jar', javaVersionJar], {});
    p.stdout?.on('data', (d) => (out += d.toString()));
    p.on('error', () => versionFromFlag());
    p.on('exit', () => {
      const v = parseInt(out.trim(), 10);
      if (Number.isFinite(v) && v > 0) return finish(v);
      versionFromFlag();
    });
    function versionFromFlag() {
      let err = '';
      const p2 = spawn(javaPath, ['-version'], {});
      p2.stderr?.on('data', (d) => (err += d.toString()));
      p2.on('error', () => finish(null));
      p2.on('exit', () => {
        const m = err.match(/version "(\d+)(?:\.(\d+))?/);
        if (!m) return finish(null);
        let major = parseInt(m[1], 10);
        if (major === 1 && m[2]) major = parseInt(m[2], 10); // legacy 1.8 == java 8
        finish(Number.isFinite(major) ? major : null);
      });
    }
  });

export const findSystemJRE = async (sharedDir: string) => {
  const localAppData = process.env['LOCALAPPDATA'];
  const programFiles = process.env['ProgramFiles'];
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  const home = process.env['USERPROFILE'] || process.env['HOME'];

  // Direct scan of the home JDK folders (~/.jdks, ~/.gradle/jdks) without glob, since that is
  // exactly where the build script's JDK lives and where the app kept failing to look.
  const homeBinDirs: string[] = [];
  if (home) {
    for (const base of [join(home, '.jdks'), join(home, '.gradle', 'jdks')]) {
      try {
        for (const entry of readdirSync(base)) {
          const bin = join(base, entry, 'bin', javaBin);
          if (existsSync(bin)) homeBinDirs.push(bin);
        }
      } catch {
        // folder not present, ignore
      }
    }
  }

  const globPatterns: string[] = [];
  for (const root of [programFiles, programFilesX86]) {
    if (!root) continue;
    globPatterns.push(
      join(root, 'Eclipse Adoptium', '**', 'bin', javaBin),
      join(root, 'Java', '**', 'bin', javaBin),
      join(root, 'AdoptOpenJDK', '**', 'bin', javaBin),
      join(root, 'Microsoft', 'jdk-*', 'bin', javaBin),
      join(root, 'Zulu', '**', 'bin', javaBin),
      join(root, 'OpenJDK', '**', 'bin', javaBin),
      join(root, 'BellSoft', '**', 'bin', javaBin),
      join(root, 'Amazon Corretto', '**', 'bin', javaBin)
    );
  }
  if (localAppData) {
    globPatterns.push(join(localAppData, 'Programs', '**', 'bin', javaBin));
  }
  if (home) {
    globPatterns.push(
      join(home, '.jdks', '**', 'bin', javaBin),
      join(home, 'scoop', 'apps', '*', 'current', 'bin', javaBin)
    );
  }

  const globbed = (
    await Promise.all(globPatterns.map((g) => globWin(g)))
  ).flat();

  const paths = [
    localJavaBin(sharedDir),
    javaHomeBin(),
    ...homeBinDirs,
    ...globbed,
    ...(await glob('/usr/lib/jvm/*/bin/' + javaBin)),
    ...(await glob('/Library/Java/JavaVirtualMachines/*/Contents/Home/bin/' + javaBin)),
    // Fallback to java on PATH
    javaBin,
  ];

  const trace: { path: string; version: number | null }[] = [];
  let found: string | undefined;
  for (const candidate of paths) {
    if (!candidate) continue;
    const version = await javaMajorVersion(candidate);
    trace.push({ path: candidate, version });
    if (version !== null && version >= 17) {
      found = candidate;
      break;
    }
  }

  try {
    writeFileSync(
      join(getGuiDataFolder(), 'findSystemJRE-debug.json'),
      JSON.stringify({ chosen: found ?? null, candidates: trace }, null, 2),
      { encoding: 'utf-8' }
    );
  } catch {
    // ignore write failures
  }

  return found ?? null;
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
    // Some Windows builds place voidreality.jar alongside the executable.
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
  const candidates = paths
    .filter((p) => !!p)
    .map((p) => join(p!, 'voidreality.jar'));

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
