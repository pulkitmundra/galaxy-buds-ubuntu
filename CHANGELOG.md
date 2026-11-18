# Changelog

All notable changes to **Samsung Galaxy Buds - Ubuntu & Android Seamless Switcher** are documented in this file.

## [v1.3.0] - 2026-11-18

### Added
- **Seamless Laptop Lid-Close Auto-Handoff to Android (`budsQuickToggle.js`, `metadata.json`, `prefs.js`, `schemas/`):**
  - Added dynamic `handle-lid-switch` pre-sleep interception via `org.freedesktop.login1.Manager.Inhibit` (`Gio.UnixFDList` + `GLib.close`), armed strictly while Galaxy Buds are actively connected to Ubuntu and `lid-close-handoff` is enabled (`0` inhibitors held whenever Buds are disconnected).
  - On laptop lid close (`org.freedesktop.login1` `LidClosed` & `org.freedesktop.UPower` `LidIsClosed`), runs a deterministic sequential handoff **before** `NetworkManager` tears down Wi-Fi: disconnects BlueZ and polls `org.bluez.Device1.Connected` until confirmed `false`, waits a `600 ms` Bluetooth radio settle window, fires an `HTTP/1.1` MacroDroid webhook with automatic transient-error retry, and immediately closes the inhibitor FD so `systemd-logind` executes native system suspend cleanly.
  - Added `"session-modes": ["user", "unlock-dialog"]` in `metadata.json` so lid-close handoff stays active even after GNOME's 5-minute idle screen lock, while automatically hiding `Settings & Android Setup Guide` whenever `Main.sessionMode.allowSettings` is `false`.
  - Automatically aborts the Android webhook if the lid is reopened mid-disconnect, purges stale `Soup.Session` keep-alive sockets after system wake (`PrepareForSleep(false)`), skips handoff when docked to an external monitor in clamshell mode (`Main.layoutManager.monitors.length > 1` with `lid-close-suspend-with-external-monitor = false`), and enforces a hard `10.0 s` fail-safe timer so offline Wi-Fi can never block laptop sleep.
  - Added **Auto-Switch to Android on Laptop Lid Close** `Adw.SwitchRow` in GTK4 / Libadwaita Preferences (`prefs.js`).

## [v1.2.2] - 2026-11-15

### Changed
- **Strict GNOME Extensions Review Best-Practices Cleanup (`extension.js`, `budsQuickToggle.js`, `prefs.js`):** Removed `_destroyed` flags in favor of pure `Gio.Cancellable` lifecycle control, narrowed `try-catch` blocks strictly to throwing GI/JSON calls, removed unnecessary optional chaining, and migrated GObject classes from `_init()` to ES6 `constructor()`.

## [v1.2.1] - 2026-11-11

### Fixed
- **GNOME Shell Lifecycle & PipeWire Sink Routing (`budsQuickToggle.js`, `prefs.js`):** Guarded post-`destroy()` async D-Bus callbacks when locking the screen mid-action, awaited PipeWire profile switches via `Promise`, automatically routed default output sink via `wpctl set-default` on Quick Settings connect, and retained `window._settings` in GTK4 preferences.
- **Hardened `.env` Parsing, Webhook Filtering & Device Alias Support (`install.sh`, `buds-switch`, `buds-settings`):** Replaced `source .env` with a safe parser, blocked placeholder `YOUR-UUID-HERE` outbound calls, preserved query strings in webhook URLs, supported apostrophes (`Pulkit's Buds3 Pro`) and `Galaxy Buds+`, and added the `buds` CLI alias plus `uninstall.sh` and CI validation.

## [v1.2.0] - 2026-11-05

### Added
- **Official Publication on GNOME Extensions Store (`extensions.gnome.org`):**
  - Published and approved on the official GNOME Shell Extensions Store at [`https://extensions.gnome.org/extension/11611/samsung-galaxy-buds-quick-settings-switcher/`](https://extensions.gnome.org/extension/11611/samsung-galaxy-buds-quick-settings-switcher/) (`galaxy-buds-switcher@pulkitmundra.github.io`, `version: 4` for GNOME Shell `45 - 48`).
  - Added 1-click installation support via `extensions.gnome.org` and the **Extension Manager** desktop app (`gnome-shell-extension-manager`).
- **Native `GSettings` Schema & EGO Review Guidelines Compliance (`schemas/`, `budsQuickToggle.js`, `prefs.js`):**
  - Migrated extension configuration (`bud-mac`, `macrodroid-webhook`) to a compiled `GSettings` schema (`org.gnome.shell.extensions.galaxy-buds-switcher`) with `Gio.SettingsBindFlags.DEFAULT` in `Adw.PreferencesWindow` (`prefs.js`).
  - Added full `Gio.Cancellable` lifecycle management across all asynchronous `Gio.DBus` and `Soup.Session` operations so disabling the extension or closing preferences cancels in-flight calls cleanly.
- **Bidirectional CLI <-> `GSettings` Sync (`buds-switch`, `buds-settings`, `install.sh`):**
  - Updated `buds-switch` to read `GSettings` first (with automatic fallback to `~/.config/buds-switch.env`) and `buds-settings` to watch `GSettings` changes and live-sync them back to `.env`.

## [v1.1.0] - 2026-11-03

### Added
- **Universal Samsung Galaxy Buds Support & Auto-Discovery:**
  - Automatically detects and supports all Samsung Galaxy Buds models (`Galaxy Buds3 Pro`, `Buds3`, `Buds2 Pro`, `Buds2`, `Buds Pro`, `Buds FE`, `Buds Live`, `Buds+`) via BlueZ D-Bus (`org.bluez.Device1.Alias` / `Name`).
  - Dynamic Quick Settings pill title (`Buds3 Pro`, `Buds2 Pro`, `Buds FE`, etc.) and dropdown header, plus automatic paired Buds MAC fallback if `.env` is unconfigured.
- **Native 3-Tab GTK4 / Libadwaita Settings & Android Setup GUI (`buds-settings` / `prefs.js`):**
  - **Configuration Tab:** 1-click **"Auto-Detect Paired Buds"** scanner, `BUD_MAC` & `MACRODROID_WEBHOOK_BASE` editor (`0600` permissions), **"Test Webhook on Phone"** live HTTP verifier, and live Connect / Disconnect / A2DP / HFP controls.
  - **Android Setup Tab:** Step-by-step MacroDroid webhook setup guide (`buds` identifier copy helper, 2-second retry action sequence, Unrestricted battery instructions) and 1-click copy button for Ubuntu's `AutoEnable=false` Bluetooth boot protection.
  - **Info & Support Tab:** Real-time system & earbuds diagnostics card (detected model, `/org/bluez/hciX` path, connection & battery `%`, active PipeWire profile, webhook status, `GalaxyBudsClient` status) plus Buy Me a Coffee & GitHub Sponsors links.
- **Live Battery Percentage in GNOME Quick Settings (`budsQuickToggle.js` & `buds-switch battery`):**
  - Subscribes to `org.bluez.Battery1` D-Bus signals and displays live battery percentage right in the Quick Settings pill subtitle (`Connected - 85%`).
- **One-Click Audio Profile Toggle (`A2DP` High-Fidelity Music vs `HFP` Call + Mic):**
  - Added **Audio Mode: High-Fidelity Music (A2DP)** and **Audio Mode: Call + Microphone (HFP)** actions to the GNOME Quick Settings dropdown and `buds-switch profile [a2dp|hfp]` via PipeWire (`pw-dump` + `wpctl set-profile`).
- **GNOME Extensions Store Packaging (`galaxy-buds-switcher@pulkitmundra.github.io`):**
  - Updated `metadata.json` with official store UUID, `url`, `donations` (`buymeacoffee` + `github`), and automated `.shell-extension.zip` bundle generation in `./install.sh`.

## [v1.0.0] - 2026-10-30

### Added
- **Direct Classic Bluetooth (`BR/EDR`) Profile Switcher (`buds-switch`):**
  - Connects Classic Bluetooth profiles (`A2DP Sink 0000110b`, `AVRCP 0000110e`, `HFP 0000111e`) directly via BlueZ D-Bus (`org.bluez.Device1.ConnectProfile`), bypassing `LE Audio (BAP)` negotiation hangs on Ubuntu 24.04+.
  - Automatically routes PipeWire default audio output sink (`wpctl`) on connect and sends desktop notifications.
- **Bidirectional Ubuntu <-> Android Handoff:**
  - Triggers a configurable MacroDroid webhook URL on disconnect so your Android phone immediately reclaims the earbuds instead of leaving them idle.
- **Native GNOME 45-48 Quick Settings Extension:**
  - Adds a dedicated Quick Settings toggle pill and top-bar status indicator synchronized in real time via BlueZ D-Bus `PropertiesChanged` signals.
  - Includes a built-in **Open Galaxy Buds Manager** menu action to launch `GalaxyBudsClient`.
- **On-Demand Adapter Power Management:**
  - Supports preventing unsolicited audio stealing on laptop boot or suspend/wake via `AutoEnable=false`.
- **One-Command Installer (`install.sh`):**
  - Automated setup of `~/.local/bin/buds-switch`, `~/.config/buds-switch.env`, desktop shortcut, and GNOME Shell extension.
