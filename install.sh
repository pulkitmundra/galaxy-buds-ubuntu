#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Samsung Galaxy Buds Ubuntu & Android Switcher Installer (v1.1.0) ==="

# 1. Check .env and restrict permissions to owner only (0600)
if [ ! -f "$REPO_DIR/.env" ]; then
  umask 077
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  echo "[!] Created $REPO_DIR/.env from .env.example."
  echo "    You can configure your BUD_MAC & MacroDroid Webhook using the GUI ('buds-settings') or by editing $REPO_DIR/.env."
fi
chmod 600 "$REPO_DIR/.env"

# 2. Ensure directories exist
mkdir -p "$HOME/.local/bin"
mkdir -p "$HOME/.local/share/icons"
mkdir -p "$HOME/.local/share/applications"
mkdir -p "$HOME/.config"

# 3. Symlink config, CLI script, GUI settings launcher, and icon
ln -sfn "$REPO_DIR/.env" "$HOME/.config/buds-switch.env"
chmod +x "$REPO_DIR/buds-switch" "$REPO_DIR/buds-settings"
ln -sfn "$REPO_DIR/buds-switch" "$HOME/.local/bin/buds-switch"
ln -sfn "$REPO_DIR/buds-settings" "$HOME/.local/bin/buds-settings"
ln -sfn "$REPO_DIR/earbuds-symbolic.svg" "$HOME/.local/share/icons/earbuds-symbolic.svg"

# 4. Install GalaxyBudsClient if missing
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

# 5. Install desktop entry with current user's $HOME path
sed "s|__HOME__|$HOME|g" "$REPO_DIR/galaxybudsclient.desktop" > "$HOME/.local/share/applications/galaxybudsclient.desktop"

# 6. Install standalone GNOME Shell extension (both Store UUID and legacy local UUID for seamless transition)
for EXT_UUID in "galaxy-buds-switcher@pulkitmundra.github.io" "buds-quick-toggle@local"; do
  EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
  mkdir -p "$EXT_DIR"
  ln -sfn "$REPO_DIR/metadata.json" "$EXT_DIR/metadata.json"
  ln -sfn "$REPO_DIR/extension.js" "$EXT_DIR/extension.js"
  ln -sfn "$REPO_DIR/budsQuickToggle.js" "$EXT_DIR/budsQuickToggle.js"
  ln -sfn "$REPO_DIR/prefs.js" "$EXT_DIR/prefs.js"
  ln -sfn "$REPO_DIR/budsSettingsWindow.js" "$EXT_DIR/budsSettingsWindow.js"
done

# Also link into caffeine@patapon.info if present
CAFFEINE_DIR="$HOME/.local/share/gnome-shell/extensions/caffeine@patapon.info"
if [ -d "$CAFFEINE_DIR" ]; then
  ln -sfn "$REPO_DIR/budsQuickToggle.js" "$CAFFEINE_DIR/budsQuickToggle.js"
fi

# 7. Package official GNOME Extensions Store bundle (.shell-extension.zip)
if command -v zip >/dev/null 2>&1; then
  mkdir -p "$REPO_DIR/dist"
  BUNDLE_PATH="$REPO_DIR/dist/galaxy-buds-switcher@pulkitmundra.github.io.shell-extension.zip"
  rm -f "$BUNDLE_PATH"
  (
    cd "$REPO_DIR"
    zip -q "$BUNDLE_PATH" metadata.json extension.js budsQuickToggle.js prefs.js budsSettingsWindow.js earbuds-symbolic.svg
  )
  echo "[*] Built GNOME Extensions Store package: $BUNDLE_PATH"
fi

gnome-extensions enable "galaxy-buds-switcher@pulkitmundra.github.io" 2>/dev/null || true
gnome-extensions enable "buds-quick-toggle@local" 2>/dev/null || true

echo "[x] Installation complete!"
echo "    - CLI:      buds-switch [connect|disconnect|toggle|profile a2dp|profile hfp|battery|settings|status]"
echo "    - GUI:      buds-settings (Configuration, Android MacroDroid Setup Guide & Live Diagnostics)"
echo "    - Config:   $REPO_DIR/.env (symlinked to ~/.config/buds-switch.env)"
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo "    - Note: Add ~/.local/bin to your PATH in ~/.bashrc: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
echo "    - Note: On Wayland, log out and log back in once if installing the GNOME extension for the first time."
