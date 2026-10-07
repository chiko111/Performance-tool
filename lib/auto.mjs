// Automatic before/after tests: a scenario is replayed several times on each build, every run is
// a normal recording, and the comparison uses the median run so a single noisy run cannot decide
// the result. The spread table shows whether a difference is bigger than the run-to-run noise.
import fs from 'node:fs';
import path from 'node:path';
import { compareSummaries } from './summary.mjs';
import { compareToMarkdown } from './export.mjs';

const median = values => {
  const list = values.filter(value => value != null).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : Math.round(((list[middle - 1] + list[middle]) / 2) * 100) / 100;
};

const SCREEN_METRICS = [
  'seconds', 'renderMsPerSec', 'commitsPerSec', 'longTasks', 'longTaskMsPerSec', 'maxBlockMs', 'jsFps',
  'hermesGcPerSec', 'hermesGcMsPerSec', 'allocMbPerSec', 'heapMaxMb', 'cpuPct', 'uiFps', 'uiDrops',
  'worstFrameMs', 'memoryMaxMb', 'artGcCount', 'artGcPauseMs', 'batteryMaxC', 'cpuMaxC', 'thermalMax'
];

// Same shape as summarize(), every number being the median over the runs.
export function medianSummary(summaries, meta) {
  const screenNames = [...new Set(summaries.flatMap(summary => summary.screens.map(row => row.screen)))];
  const screens = screenNames.map(screen => {
    const rows = summaries.map(summary => summary.screens.find(row => row.screen === screen));
    return Object.fromEntries([
      ['screen', screen],
      ...SCREEN_METRICS.map(metric => [metric, median(rows.map(row => row?.[metric]))]),
      ['topThreads', []]
    ]);
  });

  const componentKey = row => `${row.screen}\u0000${row.component}`;
  const componentRows = new Map();
  for (const summary of summaries) for (const row of summary.components) {
    if (!componentRows.has(componentKey(row))) componentRows.set(componentKey(row), row);
  }
  const components = [...componentRows.entries()].map(([key, sample]) => {
    const rows = summaries.map(summary => summary.components.find(row => componentKey(row) === key));
    // A component missing from a run did not render in it: that run counts as 0.
    const pick = field => median(rows.map(row => row?.[field] ?? 0));
    return { ...sample, selfMs: pick('selfMs'), renders: pick('renders'), mounts: pick('mounts'), msPerSec: pick('msPerSec'), rendersPerSec: pick('rendersPerSec') };
  });

  const threadNames = [...new Set(summaries.flatMap(summary => summary.threads.map(row => row.thread)))];
  const threads = threadNames
    .map(thread => {
      const rows = summaries.map(summary => summary.threads.find(row => row.thread === thread));
      return { thread, cpuMs: median(rows.map(row => row?.cpuMs ?? 0)), cpuPct: median(rows.map(row => row?.cpuPct ?? 0)) };
    })
    .sort((a, b) => b.cpuPct - a.cpuPct);

  // Rows missing from a run count as 0 there (no request / no update in that run).
  const medianRows = (pick, key, fields) => {
    const ids = [...new Set(summaries.flatMap(summary => (pick(summary) ?? []).map(row => row[key])))];
    return ids.map(id => {
      const rows = summaries.map(summary => (pick(summary) ?? []).find(row => row[key] === id));
      const sample = rows.find(Boolean);
      return { ...sample, ...Object.fromEntries(fields.map(field => [field, median(rows.map(row => row?.[field] ?? 0))])) };
    });
  };
  const redux = {
    dispatchesPerSec: median(summaries.map(summary => summary.redux?.dispatchesPerSec)),
    noopsPerSec: median(summaries.map(summary => summary.redux?.noopsPerSec)),
    slices: medianRows(summary => summary.redux?.slices, 'slice', ['updates', 'perSec', 'commits', 'renders', 'rendersPerSec', 'renderMs']),
    actions: medianRows(summary => summary.redux?.actions, 'type', ['count', 'perSec'])
  };

  return {
    meta: {
      ...meta,
      platform: summaries[0]?.meta.platform ?? 'unknown',
      durationSec: median(summaries.map(summary => summary.meta.durationSec)),
      jsSamples: median(summaries.map(summary => summary.meta.jsSamples)),
      nativeSamples: median(summaries.map(summary => summary.meta.nativeSamples)),
      thermal: summaries[0]?.meta.thermal
        ? {
            startC: median(summaries.map(summary => summary.meta.thermal?.startC)),
            endC: median(summaries.map(summary => summary.meta.thermal?.endC)),
            cpuMaxC: median(summaries.map(summary => summary.meta.thermal?.cpuMaxC)),
            levelMax: median(summaries.map(summary => summary.meta.thermal?.levelMax)),
            scale: summaries[0].meta.thermal.scale,
            perRunStartC: summaries.map(summary => summary.meta.thermal?.startC ?? null)
          }
        : null,
      runs: summaries.map(summary => summary.meta.id),
      build: summaries[0]?.meta.build ?? null
    },
    screens,
    components: components.sort((a, b) => b.selfMs - a.selfMs),
    files: [],
    threads,
    slowCommits: [],
    network: medianRows(summary => summary.network, 'key', ['count', 'perSec', 'avgMs', 'maxMs', 'kb', 'errors', 'duplicates']),
    sockets: medianRows(summary => summary.sockets, 'key', ['messages', 'perSec', 'kb', 'sent', 'sentKb', 'renders', 'rendersPerSec', 'renderMs']),
    redux
  };
}

const SPREAD_METRICS = ['cpuPct', 'renderMsPerSec', 'longTaskMsPerSec', 'maxBlockMs', 'jsFps', 'uiDrops', 'hermesGcMsPerSec', 'memoryMaxMb', 'batteryMaxC', 'thermalMax'];
const HIGHER_IS_BETTER = new Set(['jsFps', 'uiFps']);

// Better / worse only when every after run beats (or loses to) every before run.
function verdict(metric, before, after) {
  if (!before.length) return 'only in after';
  if (!after.length) return 'only in before';
  if (before.length < 2 || after.length < 2) return 'too few runs';
  const [beforeMin, beforeMax] = [Math.min(...before), Math.max(...before)];
  const [afterMin, afterMax] = [Math.min(...after), Math.max(...after)];
  const lower = afterMax < beforeMin;
  const higher = afterMin > beforeMax;
  if (!lower && !higher) return 'within noise';
  return lower !== HIGHER_IS_BETTER.has(metric) ? 'better' : 'worse';
}

export function spread(beforeSummaries, afterSummaries) {
  const screenNames = [...new Set([...beforeSummaries, ...afterSummaries].flatMap(summary => summary.screens.map(row => row.screen)))];
  return screenNames.flatMap(screen =>
    SPREAD_METRICS.map(metric => {
      const values = summaries =>
        summaries.map(summary => summary.screens.find(row => row.screen === screen)?.[metric]).filter(value => value != null);
      const before = values(beforeSummaries);
      const after = values(afterSummaries);
      return { screen, metric, before, after, verdict: verdict(metric, before, after) };
    }).filter(row => row.before.length || row.after.length)
  );
}

export const autoSessionFile = (resultsDir, scenario) => path.join(resultsDir, 'auto', `${scenario}.json`);

export function loadAutoSession(resultsDir, scenario) {
  const file = autoSessionFile(resultsDir, scenario);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { scenario, before: [], after: [] };
}

export function saveAutoSession(resultsDir, session) {
  fs.mkdirSync(path.dirname(autoSessionFile(resultsDir, session.scenario)), { recursive: true });
  fs.writeFileSync(autoSessionFile(resultsDir, session.scenario), JSON.stringify(session, null, 2));
}

export function autoCompare(session, loadSummary) {
  const load = ids => ids.map(id => {
    try {
      return loadSummary(id);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const before = load(session.before);
  const after = load(session.after);
  if (!before.length || !after.length) throw new Error('Run the scenario on the before and on the after build first');
  const result = compareSummaries(
    medianSummary(before, { id: `${session.scenario} · before (median of ${before.length})`, label: 'before' }),
    medianSummary(after, { id: `${session.scenario} · after (median of ${after.length})`, label: 'after' })
  );
  // "Re-run before" on a newer build after an older after set turns the comparison around.
  const builtAt = summaries => summaries[0]?.meta.build?.builtAt ?? null;
  const reversed =
    (session.beforeAt && session.afterAt && session.afterAt < session.beforeAt) ||
    (builtAt(before) && builtAt(after) && builtAt(after) < builtAt(before));
  return {
    ...result,
    scenario: session.scenario,
    reversed: Boolean(reversed),
    runs: { before: before.map(s => s.meta.id), after: after.map(s => s.meta.id) },
    spread: spread(before, after)
  };
}

export function autoCompareToMarkdown(result, scenario) {
  const list = values => values.join(' / ') || '–';
  const gestures = scenario
    ? `- Scenario: ${scenario.name} — ${scenario.gestures.length} gestures, ${Math.round(scenario.durationMs / 1000)} s from ${scenario.start?.screen ?? 'app start'}, recorded on ${scenario.device.model} (${scenario.device.width}×${scenario.device.height})\n`
    : '';
  const startTemperatures = side => result[side].thermal?.perRunStartC?.map(value => (value == null ? '–' : `${value}°C`)).join(' / ');
  // The comparison's own header repeats what is said above.
  const body = compareToMarkdown(result).replace(/^# Perf comparison\n\n(- .*\n)+\n/, '');
  return `# Automatic before/after test: ${result.scenario}

${gestures}- Before runs: ${result.runs.before.join(', ')}
- After runs: ${result.runs.after.join(', ')}
- Each run restarts the app, opens the start screen and replays the same gestures. Numbers are the **median run**;
  "beyond the noise" means every after run beat (or lost to) every before run.
${startTemperatures('before') ? `- Phone temperature at the start of each run — before: ${startTemperatures('before')}; after: ${startTemperatures('after') ?? '–'}\n` : ''}
${body}
## Run-to-run spread
| Screen | Metric | Before runs | After runs | Verdict |
| --- | --- | --- | --- | --- |
${result.spread.map(row => `| ${row.screen} | ${row.metric} | ${list(row.before)} | ${list(row.after)} | ${row.verdict} |`).join('\n')}
`;
}
