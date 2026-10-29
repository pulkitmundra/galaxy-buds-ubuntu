#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Galaxy Buds3 Pro Ubuntu Switcher Installer ==="

# 1. Check .env and restrict permissions to owner only (0600)
if [ ! -f "$REPO_DIR/.env" ]; then
  umask 077
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  echo "[!] Created $REPO_DIR/.env from .env.example."
  echo "    Please edit $REPO_DIR/.env with your BUD_MAC and MACRODROID_WEBHOOK_BASE."
fi
chmod 600 "$REPO_DIR/.env"

# 2. Ensure directories exist
mkdir -p "$HOME/.local/bin"
mkdir -p "$HOME/.local/share/icons"
mkdir -p "$HOME/.local/share/applications"
mkdir -p "$HOME/.config"

# 3. Symlink config, CLI script, and icon
ln -sfn "$REPO_DIR/.env" "$HOME/.config/buds-switch.env"
chmod +x "$REPO_DIR/buds-switch"
ln -sfn "$REPO_DIR/buds-switch" "$HOME/.local/bin/buds-switch"
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

# 6. Install standalone GNOME Shell extension
EXT_UUID="buds-quick-toggle@local"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
mkdir -p "$EXT_DIR"
ln -sfn "$REPO_DIR/metadata.json" "$EXT_DIR/metadata.json"
ln -sfn "$REPO_DIR/extension.js" "$EXT_DIR/extension.js"
ln -sfn "$REPO_DIR/budsQuickToggle.js" "$EXT_DIR/budsQuickToggle.js"

# Also link into caffeine@patapon.info if present
CAFFEINE_DIR="$HOME/.local/share/gnome-shell/extensions/caffeine@patapon.info"
if [ -d "$CAFFEINE_DIR" ]; then
  ln -sfn "$REPO_DIR/budsQuickToggle.js" "$CAFFEINE_DIR/budsQuickToggle.js"
fi

gnome-extensions enable "$EXT_UUID" 2>/dev/null || true

echo "[x] Installation complete!"
echo "    - CLI: buds-switch [connect|disconnect|toggle|status]"
echo "    - Config: $REPO_DIR/.env (symlinked to ~/.config/buds-switch.env)"
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo "    - Note: Add ~/.local/bin to your PATH in ~/.bashrc: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
echo "    - Note: On Wayland, log out and log back in once if installing the GNOME extension for the first time."
