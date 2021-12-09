// Manages modules

import { promises as fs } from 'fs';
import { constants as fs_constants } from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';

declare const __static: string;

// TODO: Make configurable via better CLI
const TESTING = process.argv.includes('--testing');
if (TESTING) {
  console.log('Running in testing mode');
}

const AUTOSTART = process.argv.includes('--autostart')
  ? process.argv[process.argv.indexOf('--autostart') + 1].split(',').filter(m => m !== '') || []
  : [];

/**
 * @param {string} exe executable name (without extension if on Windows)
 * @return {Promise<string|null>} executable path if found
 * From: https://abdus.dev/posts/checking-executable-exists-in-path-using-node/
 * */
async function findExecutable(exe: string): Promise<string | null> {
  const envPath = process.env.PATH || '';
  const envExt = process.env.PATHEXT || '';
  const pathDirs = envPath.replace(/["]+/g, '').split(path.delimiter).filter(Boolean);
  const extensions = envExt.split(';');
  const candidates = pathDirs.flatMap(d => extensions.map(ext => path.join(d, exe + ext)));
  try {
    return await Promise.any(candidates.map(checkFileExists));
  } catch (e) {
    return null;
  }

  async function checkFileExists(filePath) {
    if ((await fs.stat(filePath)).isFile()) {
      return filePath;
    }
    throw new Error('Not a file');
  }
}

type ModuleType = 'system' | 'bundled';

export class Module {
  name: string;
  path: string;
  process: ChildProcess | null;
  type: ModuleType;

  constructor(name: string, _path: string, type: ModuleType) {
    this.name = name;
    this.path = _path;
    this.type = type;
  }

  start() {
    // Start the module
    try {
      console.log(`Starting ${this.name}` + (TESTING ? ' (in testing mode)' : ''));

      const args = [];
      if (TESTING) args.push('--testing');

      this.process = spawn(this.path, args);
      this.process.on('close', code => {
        console.log(`Module ${this.name} exited with code ${code}`);
      });
      this.process.stdout.on('data', d => console.log(`stdout: ${d}`));
      this.process.stderr.on('data', d => console.error(`stderr: ${d}`));
    } catch (err) {
      console.error(`ERROR ${this.name}: ${err}`);
    }
  }

  stop() {
    // Stop the module
    if (this.running()) {
      this.process.kill();
    } else {
      console.warn("Module wasn't running, cannot stop.");
    }
  }

  toggle() {
    if (this.running()) {
      this.stop();
    } else {
      this.start();
    }
  }

  running() {
    if (this.process.signalCode === null) return true;
    else return false;
  }
}

export class Manager {
  modules: Module[];
  to_autostart: string[];

  constructor(autostart: string[]) {
    this.to_autostart = autostart;
  }

  async init(): Promise<void> {
    // Stuff that needs async init

    // Init can only be called once
    if (this.modules) {
      console.error('Manager.init() can only be called once. Remove extra call.');
      return;
    }

    console.log('Searching for modules in bundle');
    const modulesBundled = await this.discoverBundledModules();
    console.log('Searching for modules in PATH');
    const modulesSystem = await this.discoverSystemModules();
    this.modules = [...modulesBundled, ...modulesSystem];
  }

  async start(name: string): Promise<void> {
    // Start a specific module, by name.
    // Will always prefer bundled modules.
    // Look among all modules if none found in bundle
    const mod =
      this.modules.filter(m => m.type == 'bundled').find(m => m.name == name) ||
      this.modules.find(m => m.name == name);
    if (mod) {
      await mod.start();
    } else {
      console.error(`Module ${name} could not be started`);
    }
  }

  async autostart(): Promise<void> {
    // Start modules that should autostart
    //
    // No modules to autostart?
    if (this.to_autostart.length == 0) {
      console.log('No modules to autostart');
      return;
    }
    console.log(`Autostarting modules: ${this.to_autostart}`);

    // Start servers first
    await Promise.all(
      this.to_autostart
        .filter(mod => mod.includes('aw-server'))
        .map(async server => {
          await this.start(server);
        })
    );

    // Start the rest of the modules
    await Promise.all(
      this.to_autostart
        .filter(name => !name.includes('aw-server'))
        .map(async (name, _idx) => {
          await this.start(name);
        })
    );
  }

  private async discoverBundledModules(): Promise<Module[]> {
    const bundlepath = path.join(__static, '../modules');
    const modules = await this.discoverModules(bundlepath, 'bundled');
    console.log(`Found ${modules.length} modules in bundle: ${modules.map(m => m.name)}`);
    return modules;
  }

  private async discoverSystemModules(): Promise<Module[]> {
    // NOTE: Might not be possible to start system modules using AppImage due to isolation
    const paths = process.env.PATH.split(path.delimiter);
    //console.log(paths);
    const modules = [];
    await Promise.all(
      paths.map(async p => {
        const foundModules = await this.discoverModules(p, 'system');
        foundModules.forEach((m, _) => {
          // Only add module if one with same name not already found
          if (!modules.map(mm => mm.name).includes(m.name)) {
            modules.push(m);
          }
        });
      })
    );

    console.log(modules.map(m => m.path));
    console.log(`Found ${modules.length} modules in system: ${modules.map(m => m.name)}`);
    return modules;
  }

  private async discoverModules(dir: string, type: ModuleType): Promise<Module[]> {
    // Check all files in directory, and return executables that look executable
    const modules: Module[] = [];
    try {
      const files = await fs.readdir(dir);
      await Promise.all(
        files
          .filter(file => file.match(/aw-(server|watcher)/))
          .map(async file => {
            const filepath = path.join(dir, file);
            const stat = await fs.stat(filepath);
            if (stat.isFile()) {
              const is_exec = await fs
                .access(filepath, fs_constants.X_OK)
                .then(() => true)
                .catch(() => false);

              if (is_exec) {
                console.log(`Found module ${file}`);
                modules.push(new Module(file, filepath, type));
              }
            } else if (stat.isDirectory()) {
              // Recurse
              modules.push(...(await this.discoverModules(filepath, type)));
            } else {
              console.warn('Not a file, and not a dir?');
            }
          })
      );
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return [];
      } else {
        console.error('Could not list the directory due to unexpected error:', err);
      }
    }
    return modules;
  }
}

export const manager = new Manager(AUTOSTART);
