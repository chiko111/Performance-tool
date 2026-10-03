// Plain-text (Markdown) exports of recordings and comparisons, meant to be pasted into a review,
// a ticket or an AI chat for analysis.

import { isNotMemoized } from './compiler-status.mjs';

const value = item => (item == null || Number.isNaN(item) ? '–' : String(item));
const cell = item => value(item).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(columns, rows) {
  if (!rows.length) return '_none_\n';
  const header = `| ${columns.map(column => column.label).join(' | ')} |`;
  const divider = `| ${columns.map(column => (column.num ? '---:' : '---')).join(' | ')} |`;
  const body = rows.map(row => `| ${columns.map(column => cell(column.get(row))).join(' | ')} |`);
  return [header, divider, ...body].join('\n') + '\n';
}

function compilerText(compiler) {
  if (!compiler) return '–';
  if (compiler.status === 'compiled') return '✓ memo';
  return isNotMemoized(compiler.status) ? `✗ ${compiler.status}` : `– ${compiler.status}`;
}

function reasonsText(reasons) {
  return Object.entries(reasons ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${reason} ×${count}`)
    .join('; ');
}

const NETWORK_COLUMNS = [
  { label: 'Endpoint', get: row => row.key },
  { label: 'Requests', num: true, get: row => row.count },
  { label: 'per s', num: true, get: row => row.perSec },
  { label: 'avg ms', num: true, get: row => row.avgMs },
  { label: 'max ms', num: true, get: row => row.maxMs },
  { label: 'KB', num: true, get: row => row.kb },
  { label: 'Duplicates', num: true, get: row => row.duplicates },
  { label: 'Errors', num: true, get: row => row.errors },
  { label: 'Mostly on', get: row => row.topScreen ?? '–' }
];

function networkAndRedux(summary) {
  const redux = summary.redux;
  return `## Network (XMLHttpRequest / fetch per endpoint; ids and query values folded)
A duplicate is a request to an endpoint that was already in flight or finished less than 1 s before.
${table(NETWORK_COLUMNS, summary.network ?? [])}
## Redux
${redux ? `- Dispatches: ${redux.dispatches} (${redux.dispatchesPerSec}/s), of which **${redux.noops} changed nothing** (${redux.noopsPerSec}/s): every dispatch still runs all useSelector selectors.

### State slices that changed (renders = components rendered in the commit right after)
${table(
  [
    { label: 'Slice', get: row => row.slice },
    { label: 'Updates', num: true, get: row => row.updates },
    { label: 'per s', num: true, get: row => row.perSec },
    { label: 'Renders after', num: true, get: row => Math.round(row.renders) },
    { label: 'Renders/s', num: true, get: row => row.rendersPerSec },
    { label: 'Render ms', num: true, get: row => row.renderMs }
  ],
  redux.slices
)}
### Actions dispatched through store.dispatch (actions from inside thunks show only as slice changes)
${table(
  [
    { label: 'Action', get: row => row.type },
    { label: 'Count', num: true, get: row => row.count },
    { label: 'per s', num: true, get: row => row.perSec }
  ],
  redux.actions
)}` : '_no Redux data (probe build from an older perf-tool)_\n'}`;
}

function libraryText(library) {
  return Object.entries(library ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, ms]) => `${name} ${ms}`)
    .join(', ');
}

// ---------- Plain-language summaries (read first; the tables below are the detail) ----------

const ANDROID_THERMAL = ['none', 'light', 'moderate', 'severe', 'critical', 'emergency', 'shutdown'];
const IOS_THERMAL = ['nominal', 'fair', 'serious', 'critical'];
const thermalName = (level, scale) => (level == null ? null : (scale === 'ios' ? IOS_THERMAL : ANDROID_THERMAL)[Math.round(level)] ?? String(level));

const PLAIN_METRICS = [
  ['cpuPct', 'App CPU (% of one core)', '%'],
  ['renderMsPerSec', 'React render time', ' ms/s'],
  ['longTaskMsPerSec', 'JS thread blocked by long tasks', ' ms/s'],
  ['maxBlockMs', 'Longest JS freeze', ' ms'],
  ['jsFps', 'JS frames', ' fps'],
  ['uiDrops', 'Dropped UI frames', ''],
  ['hermesGcMsPerSec', 'JS garbage collection', ' ms/s'],
  ['memoryMaxMb', 'Peak memory', ' MB']
];
const readable = number => (number == null ? '–' : Math.abs(number) >= 100 ? Math.round(number) : Math.round(number * 10) / 10);
const uniqueBy = (rows, key) => [...new Map(rows.map(row => [key(row), row])).values()];
const SIGNIFICANT_CHANGE_PCT = 5;

function temperatureLine(thermal) {
  if (!thermal) return null;
  const degrees = thermal.startC != null ? `${thermal.startC}°C at the start, ${thermal.endC}°C at the end${thermal.cpuMaxC != null ? `, CPU up to ${thermal.cpuMaxC}°C` : ''}` : 'no °C reading (iOS)';
  return `${degrees}; throttling: ${thermalName(thermal.levelMax, thermal.scale) ?? '–'}`;
}

function recordingSummary(summary) {
  const lines = [];
  const meta = summary.meta;
  const screens = summary.screens.filter(row => row.seconds >= 2).slice(0, 4);
  lines.push(`- ${meta.durationSec} s on ${meta.platform}; screens: ${screens.map(row => `${row.screen} ${row.seconds} s`).join(', ') || '–'}.`);
  for (const row of screens) {
    lines.push(
      `- **${row.screen}**: CPU ${readable(row.cpuPct)}% of one core, React render ${readable(row.renderMsPerSec)} ms/s, ` +
        `JS blocked ${readable(row.longTaskMsPerSec)} ms/s by ${value(row.longTasks)} long tasks (longest ${readable(row.maxBlockMs)} ms), ` +
        `JS ${readable(row.jsFps)} fps, ${value(row.uiDrops)} dropped frames, peak memory ${readable(row.memoryMaxMb)} MB.`
    );
  }
  const top = summary.components.slice(0, 3);
  if (top.length) {
    lines.push(`- Most expensive components: ${top.map(row => `${row.component} (${row.screen}) ${row.msPerSec} ms/s${reasonsText(row.reasons) ? ` — ${reasonsText(row.reasons).split('; ')[0]}` : ''}`).join('; ')}.`);
  }
  const notMemoized = uniqueBy(summary.components.filter(row => isNotMemoized(row.compiler?.status)), row => row.component);
  if (notMemoized.length) {
    lines.push(`- Not memoized by React Compiler: ${notMemoized.length} rendered components, e.g. ${notMemoized.slice(0, 3).map(row => `${row.component} (${reasonText((row.compiler.reasons ?? [])[0] ?? row.compiler.status)})`).join('; ')}.`);
  }
  const duplicated = (summary.network ?? []).filter(row => row.duplicates > 0).slice(0, 3);
  if (summary.network?.length) {
    const perSec = summary.network.reduce((sum, row) => sum + row.perSec, 0);
    lines.push(`- Network: ${Math.round(perSec * 100) / 100} requests per second over ${summary.network.length} endpoints${duplicated.length ? `; duplicates on ${duplicated.map(row => `${row.key} (${row.duplicates})`).join(', ')}` : ''}.`);
  }
  if (summary.redux) {
    const busiest = summary.redux.slices[0];
    lines.push(`- Redux: ${summary.redux.dispatchesPerSec} dispatches per second, ${summary.redux.noopsPerSec} of them changed nothing${busiest ? `; most updated: ${busiest.slice} (${busiest.perSec}/s, ${busiest.rendersPerSec} renders/s after it)` : ''}.`);
  }
  const temperature = temperatureLine(meta.thermal);
  if (temperature) lines.push(`- Temperature: ${temperature}.`);
  return `## Summary\n${lines.join('\n')}\n`;
}

function comparisonSummary(result) {
  const lines = [];
  if (result.reversed) {
    lines.push('- **The after set is older than the before set (it was recorded or built earlier): read every change below the other way round, or run Replay (after) again on the new build.**');
  }
  const beforeCode = result.before.build?.code;
  const afterCode = result.after.build?.code;
  if (beforeCode && beforeCode === afterCode) {
    lines.push(`- **Before and after ran the same build (${beforeCode}): every difference below is noise or temperature, not a change in the code.**`);
  } else if (beforeCode && afterCode) {
    lines.push(`- Builds: before ${beforeCode}, after ${afterCode}.`);
  }
  const verdicts = new Map((result.spread ?? []).map(row => [`${row.screen}\u0000${row.metric}`, row.verdict]));
  const noise = (screen, metric) => {
    const verdict = verdicts.get(`${screen}\u0000${metric}`);
    return verdict === 'better' || verdict === 'worse' ? ', beyond the run-to-run noise' : verdict === 'within noise' ? ', **within the noise** of the runs' : '';
  };
  const screens = result.screens
    .filter(screen => screen.metrics.some(m => m.before != null) && screen.metrics.some(m => m.after != null) && screen.screen !== '(unknown)')
    .slice(0, 4);
  for (const screen of screens) {
    const changes = PLAIN_METRICS.map(([metric, label, unit]) => {
      const row = screen.metrics.find(m => m.metric === metric);
      if (!row || row.change == null || Math.abs(row.change) < SIGNIFICANT_CHANGE_PCT) return null;
      const better = HIGHER_IS_BETTER.has(metric) ? row.change > 0 : row.change < 0;
      return { better, text: `${label}: ${readable(row.before)}${unit} → ${readable(row.after)}${unit} (${row.change > 0 ? '+' : ''}${row.change}%) — ${better ? 'better' : '**worse**'}${noise(screen.screen, metric)}` };
    }).filter(Boolean);
    const worse = changes.filter(change => !change.better).length;
    const headline = changes.length ? `${changes.length - worse} better, ${worse} worse` : `no change of ${SIGNIFICANT_CHANGE_PCT}% or more`;
    lines.push(`- **${screen.screen}** — ${headline}`);
    for (const change of changes) lines.push(`  - ${change.text}`);
  }
  const wins = result.components.filter(row => row.deltaMsPerSec < 0).sort((a, b) => a.deltaMsPerSec - b.deltaMsPerSec).slice(0, 3);
  const losses = result.components.filter(row => row.deltaMsPerSec > 0).sort((a, b) => b.deltaMsPerSec - a.deltaMsPerSec).slice(0, 3);
  if (wins.length) lines.push(`- Biggest improvements: ${wins.map(row => `${row.component} ${readable(row.beforeMsPerSec)} → ${readable(row.afterMsPerSec)} ms/s`).join('; ')}.`);
  if (losses.length) lines.push(`- Biggest regressions: ${losses.map(row => `${row.component} ${readable(row.beforeMsPerSec)} → ${readable(row.afterMsPerSec)} ms/s${row.reasons ? ` (${row.reasons.split('; ')[0]})` : ''}`).join('; ')}.`);
  const notMemoized = uniqueBy(result.notMemoized ?? [], row => row.component);
  if (notMemoized.length) {
    const fixedNow = notMemoized.filter(row => row.compilerNow === 'compiled').length;
    lines.push(`- React Compiler: ${notMemoized.length} rendered components are not memoized${fixedNow ? ` (${fixedNow} of them are compiled in the code by now)` : ''}, e.g. ${notMemoized.slice(0, 3).map(row => `${row.component} — ${reasonText(row.compilerReasons[0] ?? row.afterCompiler)}`).join('; ')}.`);
  }
  const requests = (result.network ?? []).filter(row => row.after_perSec > row.before_perSec * 1.1 || row.after_duplicates > row.before_duplicates).slice(0, 3);
  if (requests.length) lines.push(`- Network: more requests on ${requests.map(row => `${row.key} (${row.before_perSec} → ${row.after_perSec}/s, duplicates ${row.before_duplicates} → ${row.after_duplicates})`).join('; ')}.`);
  const noops = result.store?.noopsPerSec;
  if (noops?.before != null && noops?.after != null && noops.after !== noops.before) {
    lines.push(`- Redux dispatches that changed nothing: ${noops.before}/s → ${noops.after}/s.`);
  }
  const before = result.before.thermal;
  const after = result.after.thermal;
  if (before || after) {
    // Even 1.5°C or one throttling step moves CPU-bound numbers by several percent.
    const warmer =
      (before?.startC != null && after?.startC != null && after.startC - before.startC >= 1.5) ||
      (after?.levelMax ?? 0) > (before?.levelMax ?? 0);
    const cooler =
      (before?.startC != null && after?.startC != null && before.startC - after.startC >= 1.5) ||
      (before?.levelMax ?? 0) > (after?.levelMax ?? 0);
    lines.push(
      `- Temperature: before ${temperatureLine(before) ?? '–'}; after ${temperatureLine(after) ?? '–'}.` +
        (warmer ? ' **The phone was warmer for the after run: CPU and frame numbers can be worse because of that, not the change.**' : '') +
        (cooler ? ' **The phone was cooler for the after run: part of an improvement can come from that.**' : '')
    );
  }
  return `## Summary\n${lines.join('\n')}\n`;
}

// Compiler reasons already end with a full stop; old recordings carry the unreadable directive text.
const reasonText = reason => String(reason ?? '').replace("'[object Object]' directive", "'use no memo' (opted out on purpose)").replace(/\.$/, '');

export function summaryToMarkdown(summary) {
  const meta = summary.meta;
  const notMemoized = summary.components.filter(row => isNotMemoized(row.compiler?.status));
  return `# Perf recording: ${meta.id ?? meta.label}

- Platform: ${meta.platform}
- Duration: ${meta.durationSec}s (${meta.jsSamples} JS samples, ${meta.nativeSamples} native samples)
- Started: ${meta.startedAt ? new Date(meta.startedAt).toISOString() : '–'}
- Build: release with profiling renderer (numbers are relative; compare probe build vs probe build)

${recordingSummary(summary)}
## Screens
${table(
  [
    { label: 'Screen', get: row => row.screen },
    { label: 's', num: true, get: row => row.seconds },
    { label: 'Render ms/s', num: true, get: row => row.renderMsPerSec },
    { label: 'Commits/s', num: true, get: row => row.commitsPerSec },
    { label: 'Long tasks', num: true, get: row => row.longTasks },
    { label: 'Long task ms/s', num: true, get: row => row.longTaskMsPerSec },
    { label: 'Max JS block ms', num: true, get: row => row.maxBlockMs },
    { label: 'JS FPS', num: true, get: row => row.jsFps },
    { label: 'UI FPS', num: true, get: row => row.uiFps },
    { label: 'UI drops', num: true, get: row => row.uiDrops },
    { label: 'Worst frame ms', num: true, get: row => row.worstFrameMs },
    { label: 'CPU %', num: true, get: row => row.cpuPct },
    { label: 'Hermes GC ms/s', num: true, get: row => row.hermesGcMsPerSec },
    { label: 'Alloc MB/s', num: true, get: row => row.allocMbPerSec },
    { label: 'Heap MB', num: true, get: row => row.heapMaxMb },
    { label: 'Memory MB', num: true, get: row => row.memoryMaxMb },
    { label: 'ART GC', num: true, get: row => row.artGcCount }
  ],
  summary.screens
)}
## Top threads per screen (% of one core)
${summary.screens
  .map(row => `- **${row.screen}**: ${row.topThreads.map(thread => `${thread.thread} ${thread.cpuPct}%`).join(', ') || '–'}`)
  .join('\n')}

## Components (self render time incl. library children)
${table(
  [
    { label: 'Component', get: row => row.component },
    { label: 'Screen', get: row => row.screen },
    { label: 'ms', num: true, get: row => row.selfMs },
    { label: 'ms/s', num: true, get: row => row.msPerSec },
    { label: 'Renders', num: true, get: row => row.renders },
    { label: 'Mounts', num: true, get: row => row.mounts },
    { label: 'Compiler', get: row => compilerText(row.compiler) },
    { label: 'Why it rendered', get: row => reasonsText(row.reasons) || '–' },
    { label: 'Incl. library', get: row => libraryText(row.library) },
    { label: 'File', get: row => row.file ?? '(library)' }
  ],
  summary.components.slice(0, 60)
)}
## Not memoized by React Compiler (rendered during the recording)
${table(
  [
    { label: 'Component', get: row => row.component },
    { label: 'ms', num: true, get: row => row.selfMs },
    { label: 'Renders', num: true, get: row => row.renders },
    { label: 'Status', get: row => row.compiler.status },
    { label: 'Reasons', get: row => (row.compiler.reasons ?? []).join('; ') },
    { label: 'File', get: row => `${row.file ?? ''}${row.compiler.line ? `:${row.compiler.line}` : ''}` }
  ],
  notMemoized
)}
${networkAndRedux(summary)}
## Files
${table(
  [
    { label: 'File', get: row => row.file },
    { label: 'ms', num: true, get: row => row.selfMs },
    { label: 'Renders', num: true, get: row => row.renders }
  ],
  summary.files.slice(0, 40)
)}
## Threads (whole recording)
${table(
  [
    { label: 'Thread', get: row => row.thread },
    { label: 'avg %', num: true, get: row => row.cpuPct },
    { label: 'CPU ms', num: true, get: row => row.cpuMs }
  ],
  summary.threads.slice(0, 25)
)}
## Slowest commits (≥ 16 ms)
${table(
  [
    { label: 'Screen', get: row => row.screen },
    { label: 'ms', num: true, get: row => row.ms },
    { label: 'Top components', get: row => row.top.map(item => `${item.component} ${item.ms}`).join(', ') }
  ],
  summary.slowCommits.slice(0, 25)
)}`;
}

// The same rule as the red cells of the dashboard: for these metrics an increase is worse.
const HIGHER_IS_BETTER = new Set(['jsFps', 'uiFps']);
const isWorse = (metric, change) => change != null && change !== 0 && (HIGHER_IS_BETTER.has(metric) ? change < 0 : change > 0);
const compilerChange = row => `${row.beforeCompiler ?? '–'} → ${row.afterCompiler ?? '–'}`;
const fileWithLine = row => `${row.file ?? '(library)'}${row.compilerLine ? `:${row.compilerLine}` : ''}`;

// Everything the dashboard shows in red, in one place: worse metrics, slower components and
// threads, and components React Compiler does not memoize (with its reason).
function redFlags(result, screenRows, percent) {
  const verdicts = new Map((result.spread ?? []).map(row => [`${row.screen}\u0000${row.metric}`, row.verdict]));
  const worseMetrics = screenRows.filter(row => isWorse(row.metric, row.change));
  const slowerComponents = result.components.filter(row => row.deltaMsPerSec > 0);
  const busierThreads = result.threads.filter(row => isWorse('cpuPct', row.change));
  const notMemoized = result.notMemoized ?? [];
  const moreRequests = (result.network ?? []).filter(
    row => row.after_perSec > row.before_perSec || row.after_duplicates > row.before_duplicates || row.after_errors > row.before_errors
  );
  const moreSliceRenders = (result.slices ?? []).filter(row => row.after_rendersPerSec > row.before_rendersPerSec || row.after_perSec > row.before_perSec);
  const noops = result.store?.noopsPerSec;
  return `## Red flags
${noops && noops.after > noops.before ? `- Redux dispatches that changed nothing: ${noops.before}/s → **${noops.after}/s**\n` : ''}
### Metrics that got worse
${table(
  [
    { label: 'Screen', get: row => row.screen },
    { label: 'Metric', get: row => row.metric },
    { label: 'Before', num: true, get: row => row.before },
    { label: 'After', num: true, get: row => row.after },
    { label: 'Change', num: true, get: row => percent(row.change) },
    ...(verdicts.size ? [{ label: 'Runs', get: row => verdicts.get(`${row.screen}\u0000${row.metric}`) ?? '–' }] : [])
  ],
  worseMetrics
)}
### Components that got slower (ms per second)
${table(
  [
    { label: 'Component', get: row => row.component },
    { label: 'Screen', get: row => row.screen },
    { label: 'Before', num: true, get: row => row.beforeMsPerSec },
    { label: 'After', num: true, get: row => row.afterMsPerSec },
    { label: 'Δ', num: true, get: row => `+${row.deltaMsPerSec}` },
    { label: 'Renders/s', get: row => `${row.beforeRendersPerSec} → ${row.afterRendersPerSec}` },
    { label: 'Why it rendered', get: row => row.reasons || '–' },
    { label: 'Compiler', get: compilerChange },
    { label: 'File', get: row => row.file ?? '(library)' }
  ],
  slowerComponents.slice(0, 40)
)}
### Threads that got busier (avg % of one core)
${table(
  [
    { label: 'Thread', get: row => row.thread },
    { label: 'Before', num: true, get: row => row.before },
    { label: 'After', num: true, get: row => row.after },
    { label: 'Change', num: true, get: row => percent(row.change) }
  ],
  busierThreads
)}
### Endpoints with more requests, duplicates or errors
${table(
  [
    { label: 'Endpoint', get: row => row.key },
    { label: 'per s', get: row => `${row.before_perSec} → ${row.after_perSec}` },
    { label: 'Duplicates', get: row => `${row.before_duplicates} → ${row.after_duplicates}` },
    { label: 'Errors', get: row => `${row.before_errors} → ${row.after_errors}` },
    { label: 'avg ms', get: row => `${row.before_avgMs} → ${row.after_avgMs}` }
  ],
  moreRequests
)}
### Redux slices that update or re-render more
${table(
  [
    { label: 'Slice', get: row => row.slice },
    { label: 'Updates/s', get: row => `${row.before_perSec} → ${row.after_perSec}` },
    { label: 'Renders/s after it', get: row => `${row.before_rendersPerSec} → ${row.after_rendersPerSec}` }
  ],
  moreSliceRenders
)}
### Not memoized by React Compiler (rendered in before or after)
${table(
  [
    { label: 'Component', get: row => row.component },
    { label: 'Screen', get: row => row.screen },
    { label: 'Before ms/s', num: true, get: row => row.beforeMsPerSec },
    { label: 'After ms/s', num: true, get: row => row.afterMsPerSec },
    { label: 'Compiler', get: compilerChange },
    // Status in the source as it is now: a component fixed after the recording shows compiled here.
    ...(notMemoized.some(row => row.compilerNow !== undefined) ? [{ label: 'Now', get: row => row.compilerNow ?? '–' }] : []),
    { label: 'Reason', get: row => row.compilerReasons.join('; ') || '–' },
    { label: 'File', get: fileWithLine }
  ],
  notMemoized
)}`;
}

export function compareToMarkdown(result) {
  const screenRows = result.screens.flatMap(screen =>
    screen.metrics
      .filter(metric => metric.before != null || metric.after != null)
      .map(metric => ({ screen: screen.screen, ...metric }))
  );
  const percent = change => (change == null ? '–' : `${change > 0 ? '+' : ''}${change}%`);
  return `# Perf comparison

- Before: ${result.before.id} (${result.before.platform}, ${result.before.durationSec}s)
- After: ${result.after.id} (${result.after.platform}, ${result.after.durationSec}s)
- Values are per second on each screen unless noted; for most metrics lower is better (FPS: higher is better).

${comparisonSummary(result)}
${redFlags(result, screenRows, percent)}
## Screens
${table(
  [
    { label: 'Screen', get: row => row.screen },
    { label: 'Metric', get: row => row.metric },
    { label: 'Before', num: true, get: row => row.before },
    { label: 'After', num: true, get: row => row.after },
    { label: 'Change', num: true, get: row => percent(row.change) }
  ],
  screenRows
)}
## Components with the biggest change (ms per second)
${table(
  [
    { label: 'Component', get: row => row.component },
    { label: 'Screen', get: row => row.screen },
    { label: 'Before', num: true, get: row => row.beforeMsPerSec },
    { label: 'After', num: true, get: row => row.afterMsPerSec },
    { label: 'Δ', num: true, get: row => row.deltaMsPerSec },
    { label: 'Renders/s', get: row => `${row.beforeRendersPerSec} → ${row.afterRendersPerSec}` },
    { label: 'Why it rendered (after)', get: row => row.reasons || '–' },
    { label: 'Compiler', get: compilerChange },
    { label: 'File', get: row => row.file ?? '(library)' }
  ],
  result.components.slice(0, 50)
)}
## Network (requests per second)
${table(
  [
    { label: 'Endpoint', get: row => row.key },
    { label: 'Before /s', num: true, get: row => row.before_perSec },
    { label: 'After /s', num: true, get: row => row.after_perSec },
    { label: 'avg ms', get: row => `${row.before_avgMs} → ${row.after_avgMs}` },
    { label: 'KB', get: row => `${row.before_kb} → ${row.after_kb}` },
    { label: 'Duplicates', get: row => `${row.before_duplicates} → ${row.after_duplicates}` },
    { label: 'Errors', get: row => `${row.before_errors} → ${row.after_errors}` }
  ],
  result.network ?? []
)}
## Redux
- Dispatches/s: ${result.store?.dispatchesPerSec.before ?? '–'} → ${result.store?.dispatchesPerSec.after ?? '–'}; that changed nothing: ${result.store?.noopsPerSec.before ?? '–'} → ${result.store?.noopsPerSec.after ?? '–'}

${table(
  [
    { label: 'Slice', get: row => row.slice },
    { label: 'Updates/s', get: row => `${row.before_perSec} → ${row.after_perSec}` },
    { label: 'Renders/s after it', get: row => `${row.before_rendersPerSec} → ${row.after_rendersPerSec}` },
    { label: 'Render ms', get: row => `${row.before_renderMs} → ${row.after_renderMs}` }
  ],
  result.slices ?? []
)}
${table(
  [
    { label: 'Action', get: row => row.type },
    { label: 'per s', get: row => `${row.before_perSec} → ${row.after_perSec}` }
  ],
  result.actions ?? []
)}
## Threads (avg % of one core)
${table(
  [
    { label: 'Thread', get: row => row.thread },
    { label: 'Before', num: true, get: row => row.before },
    { label: 'After', num: true, get: row => row.after },
    { label: 'Change', num: true, get: row => percent(row.change) }
  ],
  result.threads
)}`;
}
