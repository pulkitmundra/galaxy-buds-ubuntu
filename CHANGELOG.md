# Changelog

All notable changes to **Samsung Galaxy Buds - Ubuntu & Android Seamless Switcher** are documented in this file.

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
