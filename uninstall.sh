#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_UUID="galaxy-buds-switcher@pulkitmundra.github.io"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
PURGE=false

for arg in "$@"; do
  case "$arg" in
    --purge)
      PURGE=true
      ;;
    -h|--help)
      echo "Usage: ./uninstall.sh [--purge]"
      echo "  Default: Removes CLI/GUI symlinks, desktop/icon links, and local extension symlinks while preserving .env."
      echo "  --purge: Also removes .env, ~/.config/buds-switch.env, GSettings keys, and ~/.local/opt/galaxybudsclient."
      exit 0
      ;;
    *)
      echo "Error: Unknown option '$arg'. Run './uninstall.sh --help' for usage." >&2
      exit 1
      ;;
  esac
done

echo "=== Samsung Galaxy Buds Ubuntu & Android Switcher Uninstaller ==="

# 1. Remove CLI and GUI symlinks in ~/.local/bin
for link_name in buds buds-switch buds-settings; do
  target="$HOME/.local/bin/$link_name"
  if [ -L "$target" ]; then
    rm -f "$target"
    echo "[*] Removed symlink $target"
  fi
done

# 2. Remove desktop entry and icon symlink
if [ -L "$HOME/.local/share/icons/earbuds-symbolic.svg" ]; then
  rm -f "$HOME/.local/share/icons/earbuds-symbolic.svg"
  echo "[*] Removed icon symlink $HOME/.local/share/icons/earbuds-symbolic.svg"
fi
if [ -f "$HOME/.local/share/applications/galaxybudsclient.desktop" ] || [ -L "$HOME/.local/share/applications/galaxybudsclient.desktop" ]; then
  rm -f "$HOME/.local/share/applications/galaxybudsclient.desktop"
  echo "[*] Removed desktop launcher $HOME/.local/share/applications/galaxybudsclient.desktop"
fi

# 3. Remove ~/.config/buds-switch.env symlink (preserving underlying $REPO_DIR/.env)
if [ -L "$HOME/.config/buds-switch.env" ]; then
  rm -f "$HOME/.config/buds-switch.env"
  echo "[*] Removed config symlink $HOME/.config/buds-switch.env"
fi

# 4. Remove local extension symlinks (leaving EGO-managed regular files untouched unless --purge)
if [ -L "$EXT_DIR" ]; then
  gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
  rm -f "$EXT_DIR"
  echo "[*] Removed local extension symlink $EXT_DIR"
elif [ -d "$EXT_DIR" ]; then
  has_local_links=false
  for item in metadata.json extension.js budsQuickToggle.js prefs.js earbuds-symbolic.svg schemas budsSettingsWindow.js; do
    if [ -L "$EXT_DIR/$item" ]; then
      has_local_links=true
      break
    fi
  done

  if [ "$has_local_links" = true ]; then
    gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
    for item in metadata.json extension.js budsQuickToggle.js prefs.js earbuds-symbolic.svg schemas budsSettingsWindow.js; do
      if [ -L "$EXT_DIR/$item" ]; then
        rm -f "$EXT_DIR/$item"
      fi
    done
    rmdir "$EXT_DIR" 2>/dev/null || true
    echo "[*] Removed local extension symlinks in $EXT_DIR"
  elif [ "$PURGE" = true ]; then
    gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
    rm -rf "$EXT_DIR"
    echo "[*] Removed extension directory $EXT_DIR"
  fi
fi

# 5. Optional full purge of user .env, GSettings, and portable GalaxyBudsClient
if [ "$PURGE" = true ]; then
  rm -f "$REPO_DIR/.env" "$HOME/.config/buds-switch.env"
  rm -rf "$HOME/.local/opt/galaxybudsclient"
  if command -v gsettings >/dev/null 2>&1 && [ -d "$REPO_DIR/schemas" ]; then
    GSETTINGS_SCHEMA_DIR="$REPO_DIR/schemas" gsettings reset org.gnome.shell.extensions.galaxy-buds-switcher bud-mac 2>/dev/null || true
    GSETTINGS_SCHEMA_DIR="$REPO_DIR/schemas" gsettings reset org.gnome.shell.extensions.galaxy-buds-switcher macrodroid-webhook 2>/dev/null || true
  fi
  if command -v dconf >/dev/null 2>&1; then
    dconf reset -f /org/gnome/shell/extensions/galaxy-buds-switcher/ 2>/dev/null || true
  fi
  echo "[*] Purged .env, GSettings keys, and ~/.local/opt/galaxybudsclient"
else
  echo "[i] Preserved user configuration in $REPO_DIR/.env (pass '--purge' to delete)."
fi

echo "[x] Uninstallation complete!"
