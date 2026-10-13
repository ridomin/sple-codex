#!/usr/bin/env node
import { loadConfig } from '../core/config/config.js';
import { TokenStore } from '../core/config/token-store.js';
import { ProviderRegistry } from '../core/provider/registry.js';
import { SpotifyProvider } from '../providers/spotify/index.js';
import { FakeProvider } from '../providers/fake/index.js';
import { configureLogging, logHttp, redact } from './output/logging.js';
import { writeError } from './exit-codes.js';
import { createOAuthInteraction } from './auth-interaction.js';
import { packageVersion, parseCommand, readStdin, runCli } from './app.js';

const args = process.argv.slice(2);
const flagArgs = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length);
let errorJson = flagArgs.includes('--json'), errorDebug = flagArgs.includes('--debug');
try {
  const { values } = parseCommand(args);
  errorJson = values.json ?? false; errorDebug = values.debug ?? false;
  configureLogging({ verbose: values.verbose ?? false, debug: values.debug ?? false });
  const config = await loadConfig({ warn: message => { process.stderr.write(`${redact(message)}\n`); } });
  const store = new TokenStore(config.directory), registry = new ProviderRegistry();
  registry.register({ id: 'spotify', displayName: 'Spotify', create: () => new SpotifyProvider({ tokenStore: store, ...(config.spotifyClientId ? { clientId: config.spotifyClientId } : {}), log: logHttp }) });
  if (config.enableFakeProvider) registry.register({ id: 'fake', displayName: 'Fake', create: () => new FakeProvider(store) });
  const interaction = createOAuthInteraction();
  process.exitCode = await runCli(args, { config, store, registry, version: await packageVersion(),
    stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); },
    stdoutTTY: !!process.stdout.isTTY, stderrTTY: !!process.stderr.isTTY, stdinTTY: !!process.stdin.isTTY,
    width: process.stdout.columns || 80, noColor: !!process.env.NO_COLOR,
    stdin: readStdin, prompt: interaction.promptForRedirectUrl, interaction,
  });
} catch (error) { process.exitCode = writeError(error, { json: errorJson, debug: errorDebug }); }
