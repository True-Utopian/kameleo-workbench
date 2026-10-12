#!/usr/bin/env bash
set -euo pipefail

# Linux counterpart of the Windows helper. Requires an existing official
# pinned Chromium checkout and its host prerequisites; no system installs.
vesper_stage="${1:-Doctor}"
vesper_checkout="${2:-$HOME/vesper-kernel}"
vesper_jobs="${3:-2}"
vesper_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$vesper_jobs" =~ ^[1-8]$ ]] || { echo 'Jobs must be 1..8' >&2; exit 2; }
[[ "$(uname -s)" == Linux ]] || { echo 'This helper requires Linux' >&2; exit 2; }
[[ -d "$vesper_checkout/src/.git" && -x "$vesper_checkout/depot_tools/gclient" ]] || { echo 'Prepare the official checkout and depot_tools first' >&2; exit 2; }
export PATH="$vesper_checkout/depot_tools:$PATH"
export DEPOT_TOOLS_UPDATE=0 GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false
export GIT_CONFIG_KEY_1=core.fscache GIT_CONFIG_VALUE_1=true
vesper_revision="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).revision)' "$vesper_root/native/chromium/kernel.json")"
[[ "$(git -C "$vesper_checkout/src" rev-parse HEAD)" == "$vesper_revision" ]] || { echo 'Checkout does not match the pinned Chromium revision' >&2; exit 2; }
cd -- "$vesper_checkout/src"
case "$vesper_stage" in
  Doctor)
    printf 'Pinned Chromium: %s\n' "$vesper_revision"
    df -h .
    python3 --version
    ;;
  Sync)
    cd -- "$vesper_checkout"
    gclient sync --nohooks --no-history --shallow "-j$vesper_jobs" --revision "src@$vesper_revision"
    ;;
  Patch)
    while IFS= read -r vesper_name; do
      [[ "$vesper_name" =~ ^[0-9]{4}-[a-z-]+\.patch$ ]] || { echo 'Invalid patch name' >&2; exit 2; }
      vesper_patch="$vesper_root/native/chromium/patches/$vesper_name"
      if ! git apply --reverse --check -- "$vesper_patch" 2>/dev/null; then
        git apply --check -- "$vesper_patch"
        git apply -- "$vesper_patch"
      fi
    done < <(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).patches.join("\n"))' "$vesper_root/native/chromium/kernel.json")
    git diff --check
    ;;
  Generate)
    (cd -- "$vesper_checkout" && gclient runhooks)
    mkdir -p out/Vesper
    node -e 'const fs=require("fs"),m=JSON.parse(fs.readFileSync(process.argv[1]));fs.writeFileSync("out/Vesper/args.gn",Object.entries(m.gnArgs).map(([k,v])=>`${k} = ${JSON.stringify(v)}`).join("\n")+"\n")' "$vesper_root/native/chromium/kernel.json"
    gn gen out/Vesper --fail-on-unused-args
    ;;
  Build)
    vesper_free_kb="$(df -Pk . | awk 'NR==2 {print $4}')"
    (( vesper_free_kb >= 20 * 1024 * 1024 )) || { echo 'Less than 20 GiB free; no files were removed' >&2; exit 2; }
    [[ -f out/Vesper/build.ninja ]] || { echo 'Run Patch and Generate first' >&2; exit 2; }
    autoninja -C out/Vesper chrome "-j$vesper_jobs"
    printf 'Compiled candidate awaits native qualification: %s\n' "$vesper_checkout/src/out/Vesper/chrome"
    ;;
  *) echo 'Stage must be Doctor, Sync, Patch, Generate or Build' >&2; exit 2 ;;
esac
