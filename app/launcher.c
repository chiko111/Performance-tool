// Main executable of Perf Tool.app: runs Contents/Resources/launch.sh. A signed Mach-O (not the
// script itself) is what Gatekeeper and notarization expect as the app's executable.
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  char executable[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0) return 1;
  char resolved[PATH_MAX];
  if (!realpath(executable, resolved)) return 1;
  // .../Perf Tool.app/Contents/MacOS/PerfTool → .../Perf Tool.app/Contents/Resources/launch.sh
  char *macos = dirname(resolved);
  char script[PATH_MAX];
  snprintf(script, sizeof(script), "%s/../Resources/launch.sh", macos);
  execl("/bin/bash", "bash", script, (char *)NULL);
  perror("Perf Tool: cannot start launch.sh");
  return 1;
}
