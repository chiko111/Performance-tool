# perf-tool

Live performance measurement for React Native **Release** builds on iOS and Android. A browser
dashboard shows FPS, CPU per thread, Hermes and ART GC, memory, long tasks and render time per
**screen, component and file**, with the React Compiler status of each component, why it
rendered, network requests, Redux updates, the phone's temperature and why the app ended when it
crashes or is killed (stack, screen, memory). Sessions can be recorded
and compared, and an automatic before/after mode replays the same gestures on two builds.

It works with **any React Native project**. The project's settings (entry file, Metro config,
env handling, iOS schemes, bundle ids and teams, Android flavors) are detected by a scan and
stored outside the project in `~/.config/perf-tool/projects.json`. A project can have one domain
or several (brands / white labels built from one codebase).

The tool lives **outside the project**. The probe goes only into builds started with `perf`;
normal `yarn ios` / `yarn android` and store builds stay unchanged. While the server runs,
`package.json` has `yarn perf:*` scripts; they are removed when it stops, so the file stays clean
in git.

## Install

### With the app (recommended)

1. Download **Perf-Tool.dmg** from [Releases](https://github.com/chiko111/Performance-tool/releases/latest), open it and drag **Perf Tool** to Applications.
2. Start it. The app has no window: it installs perf-tool in
   `~/Library/Application Support/perf-tool` and opens the **setup page** in the browser
   (http://localhost:8098).
3. **Project:** choose the project folder (Choose folder…) and press **Scan**.
4. **Requirements:** green is fine. Anything missing says how to fix it; `yarn install` and
   `pod install` have a button.
5. **Settings:** the scan fills in everything it finds. Every field has an ⓘ explaining it. Red is
   required, yellow is a recommendation, and both say what to do (for example which file to create
   and what to put in it). Everything can also be typed in by hand.
6. **Multi-domain** (off by default): turn it on when the project builds several domains / brands.
   Each domain has its own env file, iOS scheme, bundle id and **Team ID**, and Android flavor. The
   env file can be one found in the project, one chosen from disk, or pasted (Paste…); a pasted
   one is stored in `~/.config/perf-tool/env/`, outside the project.
7. **Save and install:** saves the settings, puts the `perf` command on PATH and lists every
   command plus the steps to the first run.

The app has its own Node, so the tool does not depend on the Node version of the machine (the
project keeps using its own for Metro). Each time the setup page opens it checks this repository
for a newer version and offers **Update now**. `perf ios|android` checks once a day, and
`perf update` updates by hand.

### From git (without the app)

```sh
git clone https://github.com/chiko111/Performance-tool.git ~/perf-tool && cd ~/perf-tool
./install.sh                 # puts the perf command on PATH
cd <your project> && perf init   # opens the setup page
```

A project that has not been set up is scanned and saved by its first `perf ios|android`;
`perf init` shows the result for review.

Requirements:
- macOS; Node.js 18+ (only without the app);
- Xcode for iOS;
- Android platform-tools (`adb`) for Android;
- a project with `yarn install` (or `npm install`) and `cd ios && pod install` done.

Uninstall: `./install.sh --uninstall`

## Run: one command

From the project folder:

```sh
perf ios                          # pick a connected iPhone or a simulator from a list
perf ios "iPhone 15"              # or a device / simulator by name
perf android                      # the connected Android device
perf android <serial>             # with several devices: the serial
perf ios --variant brand-b        # multi-domain: a chosen domain
```

While the server runs the same commands are available through `yarn`: `yarn perf:ios` /
`yarn perf:android` for one domain, `yarn perf:ios:<domain>` / `yarn perf:android:<domain>` for
several.

The command does everything at once, on both platforms:
1. starts the server and opens the dashboard at **http://localhost:8099**;
2. builds a Release app with the probe for the chosen domain (without `--variant`: the default);
3. installs and starts the app; the data shows up live;
4. **Ctrl-C** stops the server. An active recording is saved first.

Build progress is shown in the terminal and on the dashboard. Device names: `perf devices`.

**Domains:** the domain's env file is bundled in place of the project's env module (e.g.
`env.js`), which itself is never changed. With `react-native-config` the file is passed to the
build as `ENVFILE`. The default domain usually builds with the env module as it is. When the
domains share one iOS boot splash (react-native-bootsplash), `perf` runs the domain's splash
script on a copy of the project, puts the result into the built `.app` and signs it again with
the same certificate.

**Signing team (installing your app on an iPhone):** the Apple team that signs the probe build of your app, in this order: `--team <ID>` → `PERF_TEAM` →
`PERF_TEAM_<DOMAIN>` → the Team ID from the setup page → a local provisioning profile for the
bundle id.

## Record and compare before / after

1. On the dashboard enter a label, e.g. `home-before`, press **● Record**, go through the screens
   and press **■ Stop**.
2. Make the change, run `perf ios …` / `perf android` again and record `home-after`.
3. In **Recordings & compare** pick Before and After and press **Compare**.

**Open screen** (top bar) sends the selected device to any screen it has already shown, so each
recording can start from the same screen without touching the phone. Scripts can do the same:
`POST /navigate {"source": "<device as the dashboard lists it>", "path": [{"name": "…"}]}`. The
source is required, so a command never moves another app that reports to the same server.

The comparison is per screen, per second: render ms/s, long tasks, GC, FPS, drops, CPU per
thread and memory, plus the components that changed most and their React Compiler status
(✗ → ✓). Recordings are in `~/perf-results/<date>_<label>/`.

Every text export starts with a **Summary** written in sentences:
- what got better and what got worse, per screen;
- whether the difference is above the noise;
- the biggest wins and regressions;
- the compiler, network, Redux and temperature.

The tables after it are the details. A comparison export (and the Auto test's) continues with
**Red flags**: everything the dashboard colours red:
- worse metrics (for Auto, also whether the difference is above the run-to-run noise);
- slower components;
- busier threads;
- every rendered component React Compiler did not memoize, with the reason, file and line.

The **Now** column shows the status in the code right now, so a component that is already fixed
shows as `compiled`. The export of a single recording lists all components that are not memoized.

## Automatic before / after (Android and iOS)

Manual recording stays. The **Auto before / after** tab does the same automatically, with the
same actions on both builds. It drives the device of the last `perf android` / `perf ios` (iOS:
device or simulator).

1. Open the app on the screen you test (for example Home), pick the **Platform** and press
   **● Start auto**. Your actions are recorded from the current screen, without a restart. Press
   **■ Stop**. The gestures (tap, long press, swipe and the pauses between them) are saved as a
   scenario in `~/perf-results/scenarios/<name>.json`, together with the start screen and the
   screens it visits. The name is the screen's unless you type another. Right after that the
   scenario is replayed ×**Runs** on the same build: that is **Before**. Your own pass is saved
   too, as `<name>-capture`.
2. Make the change and run `perf android` / `perf ios` (the dashboard stays). Press
   **▶ Replay (after)**. Each run restarts the app, waits for the probe, opens the start screen
   (navigation goes through the probe, with the route's parameters), waits 3 s for the screen to
   load and plays the gestures. Runs are 10 s apart, and the phone cools down to the starting
   temperature first.
3. After the last After run the comparison is shown and copied as text (when the browser allows
   it; otherwise **Copy as text**). **Compare**, **Copy as text** and **Download .md** also work
   later for the selected scenario. **↻ Re-run before** redoes the Before set on the current build.

The comparison is the median Before run against the median After run. The *Run-to-run spread*
table shows each run's value. "better" / "worse" means every After run beat / lost to every
Before run; otherwise the difference is **within the noise**. An After run on the same code as
Before is refused. A run must go through the screens in the order of the capture: one that goes
to another screen is stopped right away and repeated, as is one that never reaches a screen of
the scenario (a tap that hit a moving banner, content that changed).

Do not touch the phone while a run is going. Compare runs with runs: your own pass and a replay
are not the same, because the replay plays gestures at an even speed. Data from the server can
still differ between runs, which is why there are several runs and a median. Avoid tapping
content that moves on its own (auto-scrolling carousels) when recording a scenario.

**How it works per platform:**
- **Android:** gestures are read from the touchscreen with `adb shell getevent`, every touch
  frame with its time. A small helper from `android/replay` (a prebuilt `perf-replay.dex`, run
  with `app_process`; nothing is installed) injects the same frames on the same times, so scrolls
  and flings end where they ended during the capture. Mouse-wheel and trackpad scrolling on the
  emulator is captured too. Scenarios recorded with an older perf-tool have no frames and are
  played with `adb shell input tap|swipe`: capture them again for an exact replay.
- **iOS:** the native probe in the probe build sends every finished gesture to the server (in
  points, with the release speed). A small XCUITest runner from `ios/replay` plays them,
  driving the installed app by bundle id. The project is not touched.
  - The runner is built once per simulator / team (about a minute) and kept in
    `~/Library/Caches/perf-tool/<project>/replay-*`.
  - On a device it is signed automatically with the domain's team, with the bundle id
    `dev.perftool.replay.t<team>`. Xcode → Settings → Accounts needs an Apple ID in that team, and
    the device must be registered, as for the probe build itself.

## Reading the numbers

- **Long task:** the JS thread is busy for ≥ 50 ms without a break. Taps, scrolling, timers and JS
  animations wait meanwhile. **Max JS block** is the longest such freeze. While scrolling the
  target is 0. Timers run on the display's frames, and an idle screen drops to a low refresh rate
  (10-24 Hz on many phones), so one frame of delay is not counted as blocking.
- **Render ms/s:** how long React renders per second. The tables show a component's own time,
  without its children. Time spent in `View`, `Text`, `SvgXml` and the like is counted for your
  component that renders them (column *Incl. library*).
- **Why (render reason):** what changed for the component since its previous render.
  - *props: name* — a changed prop;
  - *state* — its own useState / useReducer;
  - *store (useSelector)* — a Redux value;
  - *context: X* — X is the component that renders the provider;
  - **parent rendered (props equal)** — nothing of its own changed: it rendered only because its
    parent did, and it is not memoized.
- **Network:** requests (fetch / axios / XMLHttpRequest) per endpoint, with ids in the path and
  query values folded together. A **duplicate** is a request to the exact same URL that is still
  loading or finished less than 1 s ago.
- **Redux:**
  - *dispatches/s* and how many of them **changed nothing**. Those still run every useSelector.
  - *State slices*: which parts of the state change and how many components render in the commit
    right after.
  - Action types are seen only for a direct `dispatch`. Actions from thunks show up as slice
    changes.
- **Temperature:**
  - Android gives °C from the CPU, skin and battery sensors, plus the throttling level (none …
    shutdown).
  - iOS gives no degrees, only the thermal state (nominal / fair / serious / critical).
  - A warm phone slows the CPU and frames, so the Summary warns when After started on a warmer
    phone than Before.
- **Compiler ✓ memo:** React Compiler memoized the component, as seen at runtime. **✗** means it
  is not memoized; the reason comes from the compiler itself.
- **UI FPS / UI drops:** frames on the main / UI thread. On Android this counts frames actually
  drawn, so 0 while idle is normal. A drop on Android is a frame that took more than 16.7 ms to
  produce (Android vitals' slow frame). Android's own "janky" count is not used: it measures
  against the app's vsync (8.3 ms at 120 Hz) and marks almost every frame while the screen idles at
  a low refresh rate.
- **Hermes GC / heap:** the JS engine's GC. **ART GC** is the Java/Kotlin GC on Android. A heap that
  only grows is a leak.
- The probe build uses React's profiling renderer, so absolute numbers are a little higher than in
  a store build. Compare probe with probe.

## All commands

```sh
perf init                    # setup page: scan, review and edit the settings
perf ios ["<device>"] [--variant <domain>]   # server + build + install + dashboard (iOS)
perf android [serial] [--variant <domain>]   # server + build + install + dashboard (Android)
perf ios "<…>" --no-server   # build and install only
perf setup [--remove]        # add / remove the yarn perf:* scripts in package.json
perf devices                 # iOS devices / simulators and Android devices
perf server [android]        # the dashboard only
perf compiler [filter] [--all]   # React Compiler status and reasons per component
perf ios-trace <label> "<device>" [seconds]   # Instruments recording + summary
perf update                  # update perf-tool from git
perf clean                   # remove generated files and probe build caches
```

## How it stays outside the project

| Part | How it gets into the probe build only |
| --- | --- |
| JS probe and entry file | `ENTRY_FILE` points to a generated entry in `.generated/<project>/bundle/` |
| Profiling renderer, component names, domain env | `BUNDLE_CONFIG` (iOS) / a Gradle init script (Android) wrap the project's Metro config |
| Native iOS probe | a static library linked with `xcodebuild -xcconfig`, into the app target only |
| iOS build cache | a separate DerivedData in `~/Library/Caches/perf-tool/` (the normal cache is not touched) |
| Android | `./gradlew -I .generated/<project>/init.gradle`; threads, GC and frames are read over adb |
| Project settings | `~/.config/perf-tool/projects.json` (pasted env files: `~/.config/perf-tool/env/`) |

## Troubleshooting

- **macOS blocks the app on first launch:** System Settings → Privacy & Security →
  **Open Anyway** (once). See `How to open.txt` in the DMG.
- **The dashboard stays empty after starting on an iPhone:** the Mac and the phone must be on the
  same Wi-Fi, and the phone must allow local network access (iOS asks on the first launch).
- **`INSTALL_FAILED_UPDATE_INCOMPATIBLE` (Android):** the phone has a build with another
  signature. `adb uninstall <package>` removes it, together with the app's data.
- **`perf ios-trace` reports "unknown problem":** the system symbols for that iOS version are
  missing. Open the device once in Xcode (Window → Devices) and wait for them to download.
- **The build fails:** the full log is in `~/Library/Caches/perf-tool/<project>/ios-build.log`
  (or `android-build.log`).
- **The app does not open the setup page:** its log is `~/Library/Logs/perf-tool-app.log`.
- **Wrong scheme, team or env:** `perf init` → fix the field → Save.
- **The first iOS build is slow:** the probe build has its own DerivedData; later builds are
  incremental.
