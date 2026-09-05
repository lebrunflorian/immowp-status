#!/usr/bin/env node
/**
 * Sonde de la page de statut publique (https://www.immowp.fr/status).
 *
 * Tourne sur GitHub Actions, jamais sur l'infrastructure ImmoWP : une sonde
 * hébergée sur le serveur qu'elle surveille reste muette au pire moment.
 *
 * Elle n'utilise aucun secret : tous les points sondés sont publics. Elle ne
 * publie que l'état des services ImmoWP ; l'état par connecteur métier est
 * privé et se consulte dans api_status.php (clé maître).
 *
 *   node status-probe.mjs --out status-data
 *
 * Écrit latest.json (état courant) et history.json (90 jours glissants).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const HISTORY_DAYS = 90;
const TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 3000;
const USER_AGENT = 'ImmoWP-StatusProbe/1.0 (+https://www.immowp.fr/status)';

const COMPONENTS = [
  {
    id: 'api',
    name: 'API ImmoWP',
    description: 'api.immowp.com — lecture des annonces et comptes rendus de synchronisation',
    url: 'https://api.immowp.com/v1/health',
    kind: 'health',
    slowMs: 1500,
  },
  {
    id: 'catalogue',
    name: 'Catalogue de démonstration',
    description: 'Chaîne complète, du site au logiciel métier, sur le compte de démonstration',
    url: 'https://www.immowp.fr/widget/immofacile--demo',
    kind: 'html',
    slowMs: 6000,
  },
  {
    id: 'updates',
    name: 'Mises à jour du plugin',
    description: 'update.immowp.fr — manifeste lu par les sites WordPress équipés',
    url: 'https://update.immowp.fr/immowp_info.json',
    kind: 'json',
    slowMs: 2000,
  },
  {
    id: 'site',
    name: 'Site et documentation',
    description: 'www.immowp.fr — site public, documentation et espace client',
    url: 'https://www.immowp.fr/',
    kind: 'html',
    slowMs: 5000,
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function outputDir() {
  const index = process.argv.indexOf('--out');
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : 'status-data';
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function attempt(component) {
  const started = Date.now();

  try {
    const response = await fetch(component.url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT, 'Cache-Control': 'no-cache' },
      redirect: 'follow',
    });
    const latency = Date.now() - started;

    if (!response.ok) {
      return { state: 'down', latency_ms: latency, detail: `HTTP ${response.status}` };
    }

    if (component.kind === 'health') {
      const body = await response.json();
      if (body?.data?.healthy !== true) {
        const failed = Object.entries(body?.data?.checks ?? {})
          .filter(([, check]) => check?.status !== 'ok')
          .map(([name]) => name);
        return {
          state: 'down',
          latency_ms: latency,
          detail: failed.length ? `dépendance en échec : ${failed.join(', ')}` : 'health check en échec',
        };
      }
    } else if (component.kind === 'json') {
      const body = await response.json();
      if (!body || typeof body !== 'object') {
        return { state: 'down', latency_ms: latency, detail: 'réponse illisible' };
      }
    } else {
      const body = await response.text();
      if (body.length < 500) {
        return { state: 'down', latency_ms: latency, detail: 'réponse vide' };
      }
    }

    const slow = latency > component.slowMs;
    return {
      state: slow ? 'degraded' : 'operational',
      latency_ms: latency,
      detail: slow ? `réponse lente (${latency} ms)` : null,
    };
  } catch (error) {
    return {
      state: 'down',
      latency_ms: null,
      detail: error?.name === 'TimeoutError' ? 'délai dépassé' : 'injoignable',
    };
  }
}

/** Un échec unique peut être un aléa réseau : on ne déclare une panne qu'au second essai. */
async function probe(component) {
  const first = await attempt(component);
  if (first.state !== 'down') return { ...component, ...first };

  await sleep(RETRY_DELAY_MS);
  return { ...component, ...(await attempt(component)) };
}

function overallState(components) {
  if (components.some((component) => component.state === 'down')) return 'down';
  if (components.some((component) => component.state === 'degraded')) return 'degraded';
  return 'operational';
}

function pruneHistory(history) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - (HISTORY_DAYS - 1));
  const limit = cutoff.toISOString().slice(0, 10);

  for (const day of Object.keys(history.days)) {
    if (day < limit) delete history.days[day];
  }
  return history;
}

async function main() {
  const dir = outputDir();
  await mkdir(dir, { recursive: true });

  const history = pruneHistory(await readJson(join(dir, 'history.json'), { days: {} }));

  const results = await Promise.all(COMPONENTS.map(probe));

  const components = results.map((result) => ({
    id: result.id,
    name: result.name,
    description: result.description,
    state: result.state,
    latency_ms: result.latency_ms,
    detail: result.detail,
  }));

  const snapshot = {
    generated_at: new Date().toISOString(),
    overall: overallState(components),
    components,
  };

  const today = snapshot.generated_at.slice(0, 10);
  history.days[today] ??= {};
  for (const component of components) {
    const bucket = (history.days[today][component.id] ??= { ok: 0, degraded: 0, down: 0 });
    if (component.state === 'operational') bucket.ok += 1;
    else if (component.state === 'degraded') bucket.degraded += 1;
    else if (component.state === 'down') bucket.down += 1;
  }

  await writeFile(join(dir, 'latest.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(join(dir, 'history.json'), `${JSON.stringify(history)}\n`);

  console.log(`état global : ${snapshot.overall}`);
  for (const component of components) {
    console.log(
      `  ${component.state.padEnd(12)} ${component.id.padEnd(10)} ${component.latency_ms ?? '—'} ms ${component.detail ?? ''}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
