/**
 * Create (or reuse) a bridge's service account and print the app access apiEndpoint to put in
 * the bridge's `localConfig.yml` as `bridgeApiEndPoint`.
 *
 *   node tools/createBridgeAccountUser.ts [--config-dir <bridge>/config] [--cmc]
 *
 * --config-dir  the bridge's config directory: its `service.appId`, `service.serviceInfoURL` and
 *               `service.bridgeAccountMainStreamId` are used (default: lib-bridge-js's own config).
 * --cmc         also grant `manage` on `:_cmc:inbox` and `:_cmc:apps`, as a bridge that receives
 *               CMC grants needs (bridge-mira, bridge-tempdrop).
 *
 * Credentials come from BRIDGE_USER / BRIDGE_PASS / BRIDGE_EMAIL, or are asked for. An existing
 * access with the same name is kept unless BRIDGE_REPLACE=y (or "y" at the prompt).
 *
 * The bridge stream is created before the access: cores from open-pryv.io 2.0.0-rc.50 refuse a
 * permission carrying `defaultName`.
 */
import path from 'node:path';
import readline from 'node:readline/promises';
import initBoiler from '../src/initBoiler.ts';
import { init as initPryvService, service, userExists } from '../src/lib/pryvService.ts';

const args = process.argv.slice(2);
const configDirArg = args.includes('--config-dir') ? args[args.indexOf('--config-dir') + 1] : undefined;
const withCmc = args.includes('--cmc');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
async function value (envName: string, question: string): Promise<string> {
  return process.env[envName] || (await rl.question(question)).trim();
}

async function go (): Promise<void> {
  const { getConfig } = initBoiler('createBridgeAccount', configDirArg ? path.resolve(configDirArg) : undefined);
  const config = await getConfig();
  const appId = config.get<string>('service:appId');
  const mainStreamId = config.get<string>('service:bridgeAccountMainStreamId') || 'bridge';
  await initPryvService();
  console.log(`Bridge account for appId "${appId}" on ${config.get<string>('service:serviceInfoURL')}`);

  const username = await value('BRIDGE_USER', 'Username: ');
  const password = await value('BRIDGE_PASS', 'Password (visible): ');
  if (!(await userExists(username))) {
    const email = await value('BRIDGE_EMAIL', 'Email: ');
    console.log('Creating user ' + username);
    await service().createUser({ username, password, email, hosting: 'auto', appId, language: 'en' });
  } else {
    console.log('User exists, logging in.');
  }
  const personal = await service().login(username, password, appId + '-personal');

  const existing = ((await personal.api([{ method: 'accesses.get', params: {} }] as any))[0] as any)
    .accesses.find((a: any) => a.name === appId && a.type === 'app');
  if (existing != null) {
    console.log('Found existing access, permissions:', JSON.stringify(existing.permissions));
    const replace = process.env.BRIDGE_REPLACE || (await rl.question('Delete it and create a new one? y/n: ')).trim();
    if (replace !== 'y') {
      console.log('Kept: ' + existing.apiEndpoint);
      return;
    }
    await personal.api([{ method: 'accesses.delete', params: { id: existing.id } }] as any);
  }

  const permissions = [{ streamId: mainStreamId, level: 'manage' }];
  if (withCmc) permissions.push({ streamId: ':_cmc:inbox', level: 'manage' }, { streamId: ':_cmc:apps', level: 'manage' });
  const res = await personal.api([
    { method: 'streams.create', params: { id: mainStreamId, name: 'Bridge' } },
    { method: 'accesses.create', params: { type: 'app', name: appId, permissions } }
  ] as any) as any[];
  if (res[0].error && res[0].error.id !== 'item-already-exists') throw new Error('Stream creation failed: ' + JSON.stringify(res[0].error));
  const apiEndpoint = res[1].access?.apiEndpoint;
  if (apiEndpoint == null) throw new Error('Access creation failed: ' + JSON.stringify(res[1].error));
  console.log('Created: ' + apiEndpoint);
}

go()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => { rl.close(); process.exit(); });
