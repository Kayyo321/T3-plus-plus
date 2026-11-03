#!/bin/sh
# Installs T3++ from a GitHub Release: the desktop app and the `t3pp` command.
# Needs only sh, tar, sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
#
#   curl -fsSL https://raw.githubusercontent.com/Kayyo321/T3-plus-plus/main/install.sh | sh
#
# Rerun it to update. To remove T3++ (your projects, threads, and settings are kept):
#
#   curl -fsSL https://raw.githubusercontent.com/Kayyo321/T3-plus-plus/main/install.sh | sh -s -- uninstall
#
# Environment:
#   T3PP_DESKTOP           1 or 0: install the desktop app (default: 1, except over
#                            SSH and on Linux without a display)
#   T3PP_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: stable; preview is a maintainers' test train)
#   T3PP_VERSION           exact version to install (overrides T3PP_CHANNEL)
#   T3PP_HOME              T3 home directory (default: ~/.t3pp)
#   T3PP_INSTALL_BIN_DIR   where the `t3pp` symlink goes (default: ~/.local/bin)
#   T3PP_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The CLI archive is unpacked into $T3PP_HOME/runtime/versions/<version>, the
# same layout `t3pp service install` uses, so the service reuses this download
# instead of fetching the release again.
set -eu

repo="Kayyo321/T3-plus-plus"
base_url="${T3PP_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
raw_url="https://raw.githubusercontent.com/${repo}"
t3_home="${T3PP_HOME:-$HOME/.t3pp}"
bin_dir="${T3PP_INSTALL_BIN_DIR:-$HOME/.local/bin}"
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"

fail() {
  printf '\nt3pp install: %s\n' "$1" >&2
  exit 1
}

command="${1:-install}"
case "$command" in
  install | uninstall) ;;
  *) fail "unknown command ${command}; expected install or uninstall" ;;
esac

# ANSI stays on stderr, so `curl ... | sh` still gets progress.
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset= bold= muted= accent= green=
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; accent="$(printf '\033[94m')"; green="$(printf '\033[32m')"
fi
step() {
  if "$interactive"; then printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else printf '  %s\n' "$1" >&2; fi
}
if "$interactive"; then
  printf '\n%s' "$bold" >&2
  printf '  %s\n' '██████████ ████████ ' >&2
  printf '  %s\n' '    ███       ▄██▀       T3++' >&2
  printf '  %s%s     %s%s%s\n' '    ███       ████▄ ' "$reset" "$muted" "$command" "$reset$bold" >&2
  printf '  %s\n' '    ███    ▄     ███' >&2
  printf '  %s\n' '    ███    ███████▀ ' >&2
  printf '%s\n' "$reset" >&2
fi

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    status="$(curl -sSL -H "Accept: ${3:-*/*}" -w '%{http_code}' "$1" -o "$2")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response --header="Accept: ${3:-*/*}" "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  else
    fail "curl or wget is required"
  fi
}

mb() {
  tenths=$((($1 * 10 + 524288) / 1048576))
  printf '%s.%s' "$((tenths / 10))" "$((tenths % 10))"
}
# Poll the file written by the downloader; no progress-output parsing or extra request.
download() {
  if ! "$interactive"; then fetch "$1" "$2"; return; fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -D "$2.headers" "$1" -o "$2" 2>"$2.errors" &
  else
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" &
  fi
  download_pid=$!
  previous=-1
  cr="$(printf '\r')"
  while kill -0 "$download_pid" 2>/dev/null; do
    bytes=0; total=0
    if [ -f "$2" ]; then bytes="$(wc -c < "$2")"; fi
    if [ -f "$2.headers" ]; then
      while read -r key value; do
        case "$key" in
          HTTP/*) total=0 ;;
          [Cc]ontent-[Ll]ength:) total="${value%"$cr"}" ;;
        esac
      done < "$2.headers"
    fi
    case "$total" in ''|*[!0-9]*) total=0 ;; esac
    if [ "$bytes" -ne "$previous" ]; then
      if [ "$total" -gt 0 ]; then
        percent=$((bytes * 100 / total)); [ "$percent" -le 100 ] || percent=100
        filled=$((percent * 32 / 100)); bar=; rest=; n=0
        while [ "$n" -lt 32 ]; do
          if [ "$n" -lt "$filled" ]; then bar="${bar}■"; else rest="${rest}·"; fi
          n=$((n + 1))
        done
        printf '\r\033[2K  %s%s%s%s%s %3d%%  %s%s / %s MB%s' "$accent" "$bar" "$reset$muted" "$rest" "$reset" "$percent" "$muted" "$(mb "$bytes")" "$(mb "$total")" "$reset" >&2
      else
        printf '\r\033[2K  %sDownloading%s  %s MB' "$muted" "$reset" "$(mb "$bytes")" >&2
      fi
      previous="$bytes"
    fi
    sleep 0.1
  done
  result=0; wait "$download_pid" || result=$?
  download_pid=
  if [ "$result" -ne 0 ]; then
    printf '\n' >&2
    if [ -f "$2.errors" ]; then cat "$2.errors" >&2; else cat "$2.headers" >&2; fi
    return "$result"
  fi
  size="$(mb "$(wc -c < "$2")")"
  printf '\r\033[2K  %s■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■%s 100%%  %s%s / %s MB%s\n' "$accent" "$reset" "$muted" "$size" "$size" "$reset" >&2
  rm -f "$2.headers" "$2.errors"
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); on Windows, use install.bat" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

if [ "$command" = uninstall ]; then
  if [ "$platform" = darwin ]; then
    for app in "/Applications/T3++.app" "/Applications/T3++ (Nightly).app" \
      "$HOME/Applications/T3++.app" "$HOME/Applications/T3++ (Nightly).app"; do
      if [ -e "$app" ]; then rm -rf "${app:?}" && printf '  Removed %s\n' "$app" >&2; fi
    done
  else
    if [ -e "${data_dir}/t3pp" ]; then printf '  Removed %s\n' "${data_dir}/t3pp" >&2; fi
    # The app writes the hidden URL-handler entry and icons itself (DesktopLinuxUrlHandler.ts).
    rm -rf "${data_dir:?}/t3pp" "${data_dir:?}/applications/t3pp.desktop" \
      "${data_dir:?}/applications/com.t3pp.T3PP.desktop" "${data_dir:?}/icons/com.t3pp.T3PP.desktop.png" \
      "${data_dir:?}/icons/hicolor/256x256/apps/com.t3pp.t3pp.png" "${data_dir:?}/icons/hicolor/256x256/apps/com.t3pp.T3PP.png"
  fi
  if [ -x "${bin_dir}/t3pp" ]; then
    "${bin_dir}/t3pp" uninstall --yes
  else
    printf '  %sNo t3pp command in %s.%s\n' "$muted" "$bin_dir" "$reset" >&2
  fi
  printf '\n  T3++ is uninstalled. Your projects, threads, and settings are still in %s.\n\n' "$t3_home" >&2
  exit 0
fi

# Node single-executables do not support Intel Macs, so they get the desktop app only.
cli=true
if [ "${platform}-${arch}" = darwin-x64 ]; then cli=false; fi
desktop_skipped=
case "${T3PP_DESKTOP:-}" in
  1) desktop=true ;;
  0) desktop=false ;;
  "")
    desktop=true
    if [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ]; then
      desktop=false; desktop_skipped="this is an SSH session"
    elif [ "$platform" = linux ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
      desktop=false; desktop_skipped="there is no display"
    fi
    ;;
  *) fail "T3PP_DESKTOP must be 1 or 0" ;;
esac
if ! "$cli" && ! "$desktop"; then
  fail "there is no t3pp command for Intel Macs, only the desktop app. Run this on the Mac itself, without T3PP_DESKTOP=0."
fi

command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum < "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 < "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

step "Finding your release..."
channel="${T3PP_CHANNEL:-stable}"
version="${T3PP_VERSION:-}"
if [ -z "$version" ]; then
  case "$channel" in
    stable) tag_pattern='v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)' ;;
    nightly | preview) tag_pattern="v\([0-9][^\"]*-${channel}\.[0-9]*\.[0-9]*\)" ;;
    *) fail "T3PP_CHANNEL must be stable, nightly, or preview" ;;
  esac
  tmp_index="$(mktemp)"
  if [ "$channel" = stable ]; then
    # release.yml marks only plain stable releases latest. This is a github.com
    # page, so it is not cut off by a page of newer nightlies or the API quota.
    fetch "https://github.com/${repo}/releases/latest" "$tmp_index" application/json
    version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
  else
    page=1
    while [ -z "$version" ] && [ "$page" -le 10 ]; do
      fetch "https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}" "$tmp_index"
      version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
      grep -q '"tag_name"' "$tmp_index" || break
      page=$((page + 1))
    done
  fi
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a ${channel} release; set T3PP_VERSION"
fi
case "$version" in
  *-preview.*)
    printf '%s\n' \
      "T3++ ${version} is a preview build." \
      "  Preview builds are cut by maintainers from unreleased branches to exercise the release" \
      "  pipeline. They can be broken, receive no fixes, and are never offered as updates." \
      "  Set T3PP_CHANNEL=stable (the default) for a supported build." >&2
    if [ "$channel" != "preview" ] && [ -z "${T3PP_VERSION:-}" ]; then
      fail "refusing a preview build that was not explicitly requested"
    fi
    ;;
esac

work="$(mktemp -d)"
staging=
download_pid=
trap '[ -z "$download_pid" ] || { kill "$download_pid" 2>/dev/null || true; wait "$download_pid" 2>/dev/null || true; }; rm -rf "${work:?}"; [ -z "$staging" ] || rm -rf "${staging:?}"' EXIT
trap 'printf "\n" >&2; exit 130' INT
trap 'printf "\n" >&2; exit 143' TERM

if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalling%s T3++ %s%s%s\n\n' "$muted" "$reset" "$bold" "$version" "$reset" >&2
# Downloads asset $1 to $2 and checks it against SHA256SUMS; $3 names it in messages.
download_verified() {
  if [ ! -f "${work}/SHA256SUMS" ]; then
    fetch_status=0
    fetch "${base_url}/v${version}/SHA256SUMS" "${work}/SHA256SUMS" || fetch_status=$?
    if [ "$fetch_status" -eq 44 ]; then
      fail "T3++ ${version} has no release assets at ${base_url}/v${version}"
    elif [ "$fetch_status" -ne 0 ]; then
      fail "could not download the release checksums"
    fi
  fi
  expected="$(grep " \*\{0,1\}${1}\$" "${work}/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "T3++ ${version} has no $3 for ${platform}-${arch}"
  step "Downloading the $3..."
  download "${base_url}/v${version}/${1}" "$2"
  step "Verifying the download..."
  [ "$(checksum "$2")" = "$expected" ] || fail "checksum mismatch for ${1}"
}

if "$cli"; then
  stem="t3pp-${version}-${platform}-${arch}"
  archive="${stem}.tar.gz"
  versions_dir="${t3_home}/runtime/versions"
  target_dir="${versions_dir}/${version}"

  if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ]; then
    step "Version ${version} of the t3pp command is already downloaded."
  else
    mkdir -p "$versions_dir"
    staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
    download_verified "$archive" "${staging}/${archive}" "t3pp command"
    step "Extracting the t3pp command..."
    tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
    rm -f "${staging:?}/${archive:?}"
    "${staging}/t3pp" --version >/dev/null || fail "the downloaded executable does not run"
    printf '%s\n' "$version" > "${staging}/.install-complete"

    rm -rf "${target_dir:?}"
    mv "$staging" "$target_dir"
    staging=
  fi

  step "Setting up the t3pp command..."
  mkdir -p "$bin_dir"
  ln -sfn "${target_dir}/t3pp" "${bin_dir}/t3pp"
  # Pruning keeps what this launcher points at; a background service cannot see bin_dir otherwise.
  launcher="$(CDPATH='' cd -P -- "$bin_dir" && pwd)/t3pp"
  launchers="${t3_home}/runtime/launchers"
  grep -qxF "$launcher" "$launchers" 2>/dev/null || printf '%s\n' "$launcher" >> "$launchers"
fi

if "$desktop"; then
  case "$version" in
    *-nightly.*) app_name="T3++ (Nightly)"; icon="assets/nightly/nightly-universal-1024.png" ;;
    *) app_name="T3++"; icon="assets/prod/black-universal-1024.png" ;;
  esac
  if [ "$platform" = darwin ]; then
    asset="T3PP-${version}-${arch}.zip"
    download_verified "$asset" "${work}/${asset}" "desktop app"
    step "Installing the desktop app..."
    mkdir "${work}/app"
    ditto -x -k "${work}/${asset}" "${work}/app"
    [ -d "${work}/app/${app_name}.app" ] || fail "the desktop download has no ${app_name}.app"
    apps_dir=/Applications
    if [ ! -w "$apps_dir" ]; then apps_dir="$HOME/Applications"; mkdir -p "$apps_dir"; fi
    rm -rf "${apps_dir:?}/${app_name:?}.app"
    mv "${work}/app/${app_name}.app" "${apps_dir}/${app_name}.app"
    opened="Open ${app_name} from ${apps_dir}."
  else
    if [ "$arch" = x64 ]; then appimage_arch=x86_64; else appimage_arch=arm64; fi
    asset="T3PP-${version}-${appimage_arch}.AppImage"
    download_verified "$asset" "${work}/${asset}" "desktop app"
    step "Installing the desktop app..."
    app_dir="${data_dir}/t3pp"
    mkdir -p "$app_dir" "${data_dir}/applications"
    chmod +x "${work}/${asset}"
    # Renaming leaves a running copy on its old inode. The app's own updater replaces this same path.
    mv "${work}/${asset}" "${app_dir}/T3PP.AppImage"
    fetch "${raw_url}/v${version}/${icon}" "${app_dir}/icon.png" 2>/dev/null || rm -f "${app_dir:?}/icon.png"
    {
      printf '[Desktop Entry]\nType=Application\nName=%s\n' "$app_name"
      printf 'Comment=Desktop GUI for coding agents\nExec="%s" %%U\n' "${app_dir}/T3PP.AppImage"
      if [ -f "${app_dir}/icon.png" ]; then printf 'Icon=%s\n' "${app_dir}/icon.png"; fi
      printf 'Terminal=false\nCategories=Development;\nStartupWMClass=t3code\n'
    } > "${data_dir}/applications/t3pp.desktop"
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database "${data_dir}/applications" >/dev/null 2>&1 || true
    fi
    opened="Open ${app_name} from your app menu."
    if ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; then
      opened="${opened} If it does not start, install your distribution's fuse3 package."
    fi
  fi
fi

if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalled T3++ %s%s\n\n' "$green" "$version" "$reset" >&2
if "$desktop"; then printf '  %s\n' "$opened"; fi
if [ -n "$desktop_skipped" ]; then
  printf '  Skipped the desktop app because %s. Set T3PP_DESKTOP=1 to install it anyway.\n' "$desktop_skipped"
fi
if "$cli"; then
  case ":${PATH}:" in
    *":${bin_dir}:"*) printf '  Run %st3pp%s to use T3++ from a terminal, or %st3pp up%s to use it from your other devices.\n' "$bold" "$reset" "$bold" "$reset" ;;
    *) printf '  Add %s to your PATH to use the %st3pp%s command.\n' "$bin_dir" "$bold" "$reset" ;;
  esac
fi
printf '\n  %sRun the same command again to update. To uninstall:%s\n  curl -fsSL %s/main/install.sh | sh -s -- uninstall\n\n' "$muted" "$reset" "$raw_url"
