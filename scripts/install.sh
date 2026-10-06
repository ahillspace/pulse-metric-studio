#!/bin/sh
# Pulse Metric Studio installer for macOS.
#
# One-line install (the repository is private, so this needs the GitHub CLI
# signed in with an account that can read it):
#   gh release download --repo sfdc-qbranch-emu/pulse-metric-studio --pattern install.sh -O - | sh
#
# Pass options through sh -s, for example:
#   gh release download --repo sfdc-qbranch-emu/pulse-metric-studio --pattern install.sh -O - | sh -s -- uninstall

set -eu

# Everything lives in main() so the whole script is parsed before any of it
# runs: when piped into sh, a child command reading stdin cannot eat the rest.
main() {
    repository=${PULSE_METRIC_STUDIO_REPO:-sfdc-qbranch-emu/pulse-metric-studio}
    action='install'
    version=${PULSE_METRIC_STUDIO_VERSION:-latest}
    install_dir=${PULSE_METRIC_STUDIO_INSTALL_DIR:-/Applications}
    launch=1
    app_name='Pulse Metric Studio.app'
    process_name='pulse-metric-studio'
    bundle_id='com.ahillspace.pulsemetricstudio'

    usage() {
        printf '%s\n' 'Usage: install.sh [install|uninstall] [--version VERSION] [--install-dir DIRECTORY] [--repo OWNER/NAME] [--no-launch]'
        printf '%s\n' '  --version VERSION        install an exact release such as 0.1.0; default: latest'
        printf '%s\n' '  --install-dir DIRECTORY  where Pulse Metric Studio.app goes; default: /Applications'
        printf '%s\n' '  --repo OWNER/NAME        release repository; default: sfdc-qbranch-emu/pulse-metric-studio'
        printf '%s\n' '  --no-launch              do not open Pulse Metric Studio after installing'
        printf '%s\n' 'Uninstall removes the app but keeps your connections, drafts, and publication history.'
    }

    fail() {
        printf 'Pulse Metric Studio installer error: %s\n' "$1" >&2
        exit 1
    }

    info() {
        printf '%s\n' "$1"
    }

    while [ "$#" -gt 0 ]; do
        case "$1" in
            install|uninstall)
                action=$1
                shift
                ;;
            --version)
                [ "$#" -ge 2 ] || fail '--version requires a value.'
                version=$2
                shift 2
                ;;
            --install-dir)
                [ "$#" -ge 2 ] || fail '--install-dir requires a value.'
                install_dir=$2
                shift 2
                ;;
            --repo)
                [ "$#" -ge 2 ] || fail '--repo requires a value.'
                repository=$2
                shift 2
                ;;
            --no-launch)
                launch=0
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                usage >&2
                fail "Unknown argument: $1"
                ;;
        esac
    done

    [ "$(uname -s)" = 'Darwin' ] || fail 'This installer is for macOS. On Windows use install.ps1.'

    app_path="${install_dir%/}/${app_name}"

    # Ask a running Pulse Metric Studio to quit (it owns the single-instance
    # lock and its local backend), then force it if it does not exit in time.
    quit_running_app() {
        pgrep -x "$process_name" >/dev/null 2>&1 || return 0
        info 'Quitting the running Pulse Metric Studio...'
        osascript -e "tell application id \"${bundle_id}\" to quit" >/dev/null 2>&1 || true
        attempts=0
        while pgrep -x "$process_name" >/dev/null 2>&1; do
            attempts=$((attempts + 1))
            if [ "$attempts" -ge 20 ]; then
                pkill -x "$process_name" >/dev/null 2>&1 || true
                sleep 1
                break
            fi
            sleep 0.5
        done
    }

    # Fail unless the file's SHA-256 matches its checksums.txt entry.
    verify_checksum() {
        file_name=$(basename "$1")
        matches=$(awk -v name="$file_name" '$2 == name || $2 == "*" name { print $1 }' "${work_dir}/checksums.txt")
        [ -n "$matches" ] || fail "checksums.txt has no entry for ${file_name}."
        [ "$(printf '%s\n' "$matches" | wc -l | tr -d ' ')" -eq 1 ] \
            || fail "checksums.txt has more than one entry for ${file_name}."
        expected=$matches
        actual=$(shasum -a 256 "$1" | awk '{ print $1 }')
        [ "$expected" = "$actual" ] || fail "Checksum mismatch for ${file_name}. Nothing was installed."
    }

    if [ "$action" = 'uninstall' ]; then
        quit_running_app
        if [ -d "$app_path" ]; then
            rm -rf "$app_path"
            info "Removed ${app_path}."
        else
            info "Pulse Metric Studio is not installed at ${app_path}."
        fi
        info "Your data is kept in ~/Library/Application Support/${bundle_id}, and saved Tableau tokens stay in your Keychain."
        exit 0
    fi

    command -v gh >/dev/null 2>&1 || fail 'The GitHub CLI (gh) is required. Install it with: brew install gh'
    gh auth status --hostname github.com >/dev/null 2>&1 || fail 'The GitHub CLI is not signed in. Run: gh auth login'

    case "$(uname -m)" in
        arm64) arch='aarch64' ;;
        x86_64) arch='x64' ;;
        *) fail "Unsupported Mac architecture: $(uname -m)" ;;
    esac

    if [ "$version" = 'latest' ]; then
        tag=$(gh release view --repo "$repository" --json tagName --jq .tagName 2>/dev/null) \
            || fail "Could not find the latest release of ${repository}. Check that your GitHub account can open https://github.com/${repository}."
    else
        tag="v${version#v}"
    fi

    work_dir=$(mktemp -d "${TMPDIR:-/tmp}/pulse-metric-studio-install.XXXXXX")
    mount_dir="${work_dir}/mount"
    cleanup() {
        if [ -d "$mount_dir" ]; then
            hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
        fi
        rm -rf "$work_dir"
    }
    trap cleanup EXIT INT TERM

    info "Downloading Pulse Metric Studio ${tag} for ${arch}..."
    gh release download "$tag" --repo "$repository" --dir "$work_dir" \
        --pattern "Pulse-Metric-Studio_*_${arch}.dmg" --pattern 'checksums.txt' >/dev/null 2>&1 \
        || fail "Could not download Pulse Metric Studio ${tag} from ${repository}."

    dmg_path=''
    for candidate in "$work_dir"/Pulse-Metric-Studio_*_"${arch}".dmg; do
        [ -f "$candidate" ] || continue
        [ -z "$dmg_path" ] || fail 'The release contains more than one matching disk image.'
        dmg_path=$candidate
    done
    [ -n "$dmg_path" ] || fail "Release ${tag} has no macOS ${arch} disk image."
    [ -f "${work_dir}/checksums.txt" ] || fail "Release ${tag} has no checksums.txt, so the download cannot be verified."

    dmg_name=$(basename "$dmg_path")
    verify_checksum "$dmg_path"
    info 'Checksum verified.'

    mkdir -p "$mount_dir"
    hdiutil attach "$dmg_path" -nobrowse -readonly -noautoopen -mountpoint "$mount_dir" -quiet \
        || fail "Could not open ${dmg_name}."
    [ -d "${mount_dir}/${app_name}" ] || fail "${dmg_name} does not contain ${app_name}."

    [ -d "$install_dir" ] || mkdir -p "$install_dir" || fail "Could not create ${install_dir}."
    [ -w "$install_dir" ] || fail "${install_dir} is not writable. Re-run with --install-dir \"\$HOME/Applications\"."

    # Copy the new app beside the old one first, so a failed copy (full disk,
    # interrupted download of the image) leaves the installed version working.
    staged_app="${install_dir}/.${app_name}.new.$$"
    old_app="${install_dir}/.${app_name}.old.$$"
    rm -rf "$staged_app" "$old_app"
    if ! ditto "${mount_dir}/${app_name}" "$staged_app"; then
        rm -rf "$staged_app"
        fail "Could not copy Pulse Metric Studio to ${install_dir}. The installed version was not changed."
    fi

    quit_running_app
    if [ -e "$app_path" ] && ! mv "$app_path" "$old_app"; then
        rm -rf "$staged_app"
        fail "Could not replace ${app_path}. The installed version was not changed."
    fi
    if ! mv "$staged_app" "$app_path"; then
        if [ -e "$old_app" ]; then
            mv "$old_app" "$app_path" || true
        fi
        rm -rf "$staged_app"
        fail "Could not move Pulse Metric Studio into ${install_dir}. The previous version was put back."
    fi
    rm -rf "$old_app"
    # gh does not quarantine downloads, but strip the flag anyway so Gatekeeper
    # never blocks the self-signed app on first launch.
    xattr -dr com.apple.quarantine "$app_path" >/dev/null 2>&1 || true

    info "Installed Pulse Metric Studio ${tag} to ${app_path}."

    if [ "$launch" -eq 1 ]; then
        open "$app_path"
        info 'Pulse Metric Studio is starting.'
    fi
}

main "$@" </dev/null
