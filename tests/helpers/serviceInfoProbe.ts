/**
 * Child-process probe for [PSIX] (tests/pryvServiceInfoURL.test.ts). It runs `pryvService.init()` in
 * a fresh process, so no model or service singleton loaded by another suite answers for it, with
 * `fetch` stubbed: every `.../service/info` gets a service info whose `hds-model` asset names that
 * host, so the loaded model's assets tell which service it came from. Prints one `PROBE:` line.
 */
import initBoiler from '../../src/initBoiler.ts';
import * as pryvService from '../../src/lib/pryvService.ts';
import { getHDSModel } from 'hds-lib';

const configured = process.argv[2];
const requested: string[] = [];

globalThis.fetch = async (input: any): Promise<Response> => {
  const url = String(input?.url ?? input);
  requested.push(url);
  const { origin } = new URL(url);
  if (url.endsWith('/service/info')) {
    return Response.json({
      name: 'probe',
      api: origin + '/{username}/',
      register: origin + '/reg/',
      access: origin + '/access/',
      assets: { 'hds-model': origin + '/model/pack.json' }
    });
  }
  if (url.endsWith('/model/pack.json')) return Response.json({ version: '9.9.9-probe', items: {} });
  return new Response('not stubbed', { status: 404 });
};

const { getConfig } = initBoiler(`service-info-probe:${process.pid}`);
(await getConfig()).set('service:serviceInfoURL', configured);
await pryvService.init();
process.stdout.write('\nPROBE:' + JSON.stringify({ requested, modelUrl: getHDSModel().assets?.['hds-model'] }) + '\n');
process.exit(0);
