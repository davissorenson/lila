import * as rup from 'rollup';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ps from 'node:process';
import * as cps from 'node:child_process';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import { parseModules } from './parse';
import { makeBleepConfig } from './tsconfig';
import { LichessModule, LichessRollup, env, colorFuncs as c } from './env';

export const moduleDeps = new Map<string, string[]>();
export let modules: Map<string, LichessModule>;
let watcher: rup.RollupWatcher;
let startTime: number | undefined = Date.now();

export async function build(moduleNames: string[]) {
  modules = new Map((await parseModules()).map(mod => [mod.name, mod]));
  for (const moduleName of moduleNames)
    if (!known(moduleName) && moduleName != 'all') {
      env.log(c.red('Argument error: ') + `unknown module '${c.magenta(moduleName)}'`);
      return;
    }

  buildDependencyList();

  if (moduleNames.length == 0)
    modules.forEach(m => {
      // we're just doing core
      if (!m.hasTsconfig) return;
      moduleNames.push(m.name);
      m.rollup = undefined;
    });

  const buildModules = moduleNames.includes('all') ? [...modules.values()] : depsMany(moduleNames);

  if (env.opts.gulp !== false) gulpWatch();
  await makeBleepConfig(buildModules);
  typescriptWatch(() => rollupWatch(buildModules));
}

function typescriptWatch(success: () => void) {
  const tsc = cps.spawn(
    'tsc',
    ['-b', path.resolve(env.tsconfigDir, 'bleep.tsconfig.json'), '--incremental', '-w', '--preserveWatchOutput'],
    { cwd: env.tsconfigDir }
  );
  tsc.stdout?.on('data', (txt: Buffer) => {
    // no way to magically get build events...
    // maybe look at transpiling in this process because keying off stdout feels dirty.
    if (!watcher && txt.toString().search('Found 0 errors.') >= 0) {
      env.log('tsc build success. Begin watching...', { ctx: 'tsc' });
      success();
      return;
    }
    env.log(txt, { ctx: 'tsc' });
  });
  tsc.stderr?.on('data', txt => env.log(txt, { ctx: 'tsc' }));
}

function gulpWatch(numTries = 0) {
  const gulp = cps.spawn('yarn', ['gulp', 'css'], { cwd: env.uiDir });
  gulp.stdout?.on('data', txt => env.log(txt, { ctx: 'gulp' }));
  gulp.stderr?.on('data', txt => env.log(txt, { ctx: 'gulp' }));
  gulp.on('close', (code: number) => {
    if (code == 1) {
      // gulp fails to watch on macos with exit code 1 pretty randomly
      if (numTries < 3) {
        env.log(c.red('Retrying gulp watch...'), { ctx: 'gulp' });
        gulpWatch(numTries + 1);
      } else throw 'gulp fail';
    }
  });
}

function rollupWatch(todo: LichessModule[]): void {
  ps.chdir(env.uiDir);

  const outputToHostMod = new Map<string, LichessModule>();
  const triggerScriptCmds = new Set<string>();
  const rollups: rup.RollupOptions[] = [];

  todo.forEach(mod => {
    mod.rollup?.forEach(r => {
      const options = rollupOptions(r);
      const output = path.resolve(env.outDir, `${r.output}.js`);
      outputToHostMod.set(output, mod);
      if (r.isMain) triggerScriptCmds.add(output);
      rollups.push(options);
    });
  });
  if (!rollups.length) {
    rollupDone(0);
    return;
  }
  let moduleName = 'unknown';
  let count = 0;

  watcher = rup.watch(rollups).on('event', (e: rup.RollupWatcherEvent) => {
    if (e.code == 'END') {
      rollupDone(count);
      count = 0;
    } else if (e.code == 'ERROR') {
      rollupError(e.error, moduleName);
    } else if (e.code == 'BUNDLE_START') {
      if (!startTime) startTime = Date.now();
      const output = e.output.length > 0 ? e.output[0] : '';
      const hostMod = outputToHostMod.get(output);
      moduleName = hostMod?.name || 'unknown';
      if (triggerScriptCmds.has(output)) preModule(hostMod);
    } else if (e.code == 'BUNDLE_END') {
      const output = e.output.length > 0 ? e.output[0] : '';
      const hostMod = outputToHostMod.get(output);
      if (triggerScriptCmds.has(output)) postModule(hostMod);
      const result = fs.existsSync(output)
        ? `bundled '${c.cyan(path.basename(output))}' - `
        : `not found '${c.red(output)}' - `;
      env.log(result + c.grey(`${e.duration}ms`), { ctx: 'rollup' });
      e.result?.close();
      count++;
    }
  });
}

function rollupDone(n: number) {
  const results = n > 0 ? `Built ${n} module${n > 1 ? 's' : ''}` : 'Done';
  const elapsed = startTime ? `in ${c.green((Date.now() - startTime) / 1000 + '')}s ` : '';
  env.log(`${results} ${elapsed}- watching...`);
  startTime = undefined;
}

function rollupError(err: rup.RollupError, name: string) {
  if (!err.code) {
    env.log(err, { ctx: name, error: true });
    return;
  }
  const filename = err.loc?.file || err.id || name;
  const loc = err.loc ? `line ${err.loc.line} column ${err.loc.column} of ` : '';
  const preamble = c.red(err.code) + ` in ${loc}'${c.cyan(filename)}'`;
  env.log(`${preamble}\n${err.frame ? c.red(err.frame) : ''}`, { ctx: c.red(name) });
  env.log(c.red(`*** ${name} module bundle failed! ***`), { ctx: c.red(name) });
}

function rollupOptions(o: LichessRollup): rup.RollupWatchOptions {
  const modDir = o.hostMod.root;
  const plugins = (o.plugins || []).concat(
    o.hostMod.hasTsconfig
      ? [typescript({ tsconfig: path.resolve(modDir, 'tsconfig.json') }), resolve(), commonjs({ extensions: ['.js'] })]
      : []
  );
  return {
    input: path.resolve(modDir, o.input),
    plugins: plugins,
    onwarn: o.onWarn,
    output: {
      format: 'iife',
      name: o.importName,
      file: path.resolve(env.outDir, `${o.output}.js`),
      generatedCode: { preset: 'es2015', constBindings: false },
    },
  };
}

function postModule(mod: LichessModule | undefined) {
  mod?.build.post?.forEach((args: string[]) => {
    env.log(c.blue(args.join(' ')), { ctx: mod.name });
    cps.exec(`${args.join(' ')}`, { cwd: mod.root }, (err, stdout, stderr) => {
      if (stdout) env.log(stdout, { ctx: mod.name });
      if (stderr) env.log(stderr, { ctx: mod.name });
      if (err) env.log(err, { ctx: mod.name, error: true });
    });
  });
}

function preModule(mod: LichessModule | undefined) {
  mod?.build.pre?.forEach((args: string[]) => {
    env.log(c.blue(args.join(' ')), { ctx: mod.name });
    // this must block, otherwise the rollup that may depend on this command
    // will begin executing
    const stdout = cps.execSync(`${args.join(' ')}`, { cwd: mod.root });
    if (stdout) env.log(stdout, { ctx: mod.name });
  });
}

function buildDependencyList() {
  modules.forEach(mod => {
    const deplist: string[] = [];
    for (const dep in mod.pkg.dependencies) if (modules.has(dep)) deplist.push(dep);

    moduleDeps.set(mod.name, deplist);
    mod.rollup?.forEach(r => {
      if (r.output && ![mod.name, mod.moduleAlias].includes(r.output)) moduleDeps.set(r.output, [mod.name, ...deplist]);
    });
  });
}

// don't worry about cycles because yarn install would fail
function depsOne(modName: string): LichessModule[] {
  const collect = (dep: string): string[] => [...(moduleDeps.get(dep) || []).flatMap(d => collect(d)), dep];
  return unique(collect(modName).map(name => modules.get(name)));
}

const depsMany = (modNames: string[]): LichessModule[] => unique(modNames.flatMap(depsOne));

const unique = <T>(mods: (T | undefined)[]): T[] => [...new Set(mods.filter(x => x))] as T[];

const known = (name: string): boolean => modules.has(name);
