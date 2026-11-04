#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Samsung Galaxy Buds Ubuntu & Android Switcher Installer (v1.2.0) ==="

# 1. Check .env and restrict permissions to owner only (0600)
if [ ! -f "$REPO_DIR/.env" ]; then
  umask 077
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  echo "[!] Created $REPO_DIR/.env from .env.example."
  echo "    You can configure your BUD_MAC & MacroDroid Webhook using 'buds-settings' or by editing $REPO_DIR/.env."
fi
chmod 600 "$REPO_DIR/.env"

# 2. Compile GSettings schema
glib-compile-schemas "$REPO_DIR/schemas"

# 3. Ensure directories exist
mkdir -p "$HOME/.local/bin"
mkdir -p "$HOME/.local/share/icons"
mkdir -p "$HOME/.local/share/applications"
mkdir -p "$HOME/.config"

# 4. Symlink config, CLI script, GUI settings launcher, and icon
ln -sfn "$REPO_DIR/.env" "$HOME/.config/buds-switch.env"
chmod +x "$REPO_DIR/buds-switch" "$REPO_DIR/buds-settings"
ln -sfn "$REPO_DIR/buds-switch" "$HOME/.local/bin/buds-switch"
ln -sfn "$REPO_DIR/buds-settings" "$HOME/.local/bin/buds-settings"
ln -sfn "$REPO_DIR/earbuds-symbolic.svg" "$HOME/.local/share/icons/earbuds-symbolic.svg"

# 5. Install GalaxyBudsClient if missing
GALAXY_BUDS_BIN="$HOME/.local/opt/galaxybudsclient/GalaxyBudsClient"
GALAXY_BUDS_SHA256="fa3b0889c2142821f10a2df2b359c7573106c2e0559c9465dd32d983ef1f9ae3"
if [ ! -x "$GALAXY_BUDS_BIN" ]; then
  echo "[*] Downloading GalaxyBudsClient v5.1.1 for Linux x64..."
  mkdir -p "$HOME/.local/opt/galaxybudsclient"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  TMP_ARCHIVE="$TMP_DIR/GalaxyBudsClient_Linux_64bit_Portable.bin.tar.gz"
  curl -fL --proto '=https' "https://github.com/timschneeb/GalaxyBudsClient/releases/download/5.1.1/GalaxyBudsClient_Linux_64bit_Portable.bin.tar.gz" -o "$TMP_ARCHIVE"
  tar -xzf "$TMP_ARCHIVE" --no-same-owner -C "$HOME/.local/opt/galaxybudsclient"
  echo "[*] Verifying GalaxyBudsClient binary SHA-256 checksum..."
  if ! echo "${GALAXY_BUDS_SHA256}  ${GALAXY_BUDS_BIN}" | sha256sum -c - >/dev/null 2>&1; then
    echo "Error: SHA-256 checksum verification failed for $GALAXY_BUDS_BIN" >&2
    rm -f "$GALAXY_BUDS_BIN"
    exit 1
  fi
  chmod +x "$GALAXY_BUDS_BIN"
  rm -rf "$TMP_DIR"
  trap - EXIT
fi

# 6. Install desktop entry with current user's $HOME path
sed "s|__HOME__|$HOME|g" "$REPO_DIR/galaxybudsclient.desktop" > "$HOME/.local/share/applications/galaxybudsclient.desktop"

# 7. Install standalone GNOME Shell extension
EXT_UUID="galaxy-buds-switcher@pulkitmundra.github.io"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
mkdir -p "$EXT_DIR"
rm -f "$EXT_DIR/budsSettingsWindow.js"
ln -sfn "$REPO_DIR/metadata.json" "$EXT_DIR/metadata.json"
ln -sfn "$REPO_DIR/extension.js" "$EXT_DIR/extension.js"
ln -sfn "$REPO_DIR/budsQuickToggle.js" "$EXT_DIR/budsQuickToggle.js"
ln -sfn "$REPO_DIR/prefs.js" "$EXT_DIR/prefs.js"
ln -sfn "$REPO_DIR/earbuds-symbolic.svg" "$EXT_DIR/earbuds-symbolic.svg"
ln -sfn "$REPO_DIR/schemas" "$EXT_DIR/schemas"

# Sync .env values into GSettings if present
if [ -f "$REPO_DIR/.env" ]; then
  # shellcheck disable=SC1090
  source "$REPO_DIR/.env"
  if [ -n "${BUD_MAC:-}" ] && [ "${BUD_MAC}" != "AA:BB:CC:DD:EE:FF" ]; then
    GSETTINGS_SCHEMA_DIR="$REPO_DIR/schemas" gsettings set org.gnome.shell.extensions.galaxy-buds-switcher bud-mac "$BUD_MAC" || true
  fi
  if [ -n "${MACRODROID_WEBHOOK_BASE:-}" ]; then
    GSETTINGS_SCHEMA_DIR="$REPO_DIR/schemas" gsettings set org.gnome.shell.extensions.galaxy-buds-switcher macrodroid-webhook "$MACRODROID_WEBHOOK_BASE" || true
  fi
fi

# 8. Package official GNOME Extensions Store bundle (.shell-extension.zip)
if command -v zip >/dev/null 2>&1; then
  mkdir -p "$REPO_DIR/dist"
  BUNDLE_PATH="$REPO_DIR/dist/galaxy-buds-switcher@pulkitmundra.github.io.shell-extension.zip"
  rm -f "$BUNDLE_PATH"
  (
    cd "$REPO_DIR"
    zip -q "$BUNDLE_PATH" \
      metadata.json \
      extension.js \
      budsQuickToggle.js \
      prefs.js \
      earbuds-symbolic.svg \
      schemas/org.gnome.shell.extensions.galaxy-buds-switcher.gschema.xml
  )
  echo "[*] Built GNOME Extensions Store package: $BUNDLE_PATH"
fi

gnome-extensions enable "$EXT_UUID" 2>/dev/null || true

echo "[x] Installation complete!"
echo "    - CLI:      buds-switch [connect|disconnect|toggle|profile a2dp|profile hfp|battery|settings|status]"
echo "    - GUI:      buds-settings (GNOME Extension Preferences)"
echo "    - Bundle:   $REPO_DIR/dist/galaxy-buds-switcher@pulkitmundra.github.io.shell-extension.zip"
