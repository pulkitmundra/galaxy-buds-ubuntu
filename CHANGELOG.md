# Changelog

All notable changes to **Galaxy Buds3 Pro - Ubuntu & Android Seamless Switcher** are documented in this file.

## [v1.0.0] - 2026-10-30

### Added
- **Direct Classic Bluetooth (`BR/EDR`) Profile Switcher (`buds-switch`):**
  - Connects Classic Bluetooth profiles (`A2DP Sink 0000110b`, `AVRCP 0000110e`, `HFP 0000111e`) directly via BlueZ D-Bus (`org.bluez.Device1.ConnectProfile`), bypassing `LE Audio (BAP)` negotiation hangs on Ubuntu 24.04+.
  - Automatically routes PipeWire default audio output sink (`wpctl`) on connect and sends desktop notifications.
- **Bidirectional Ubuntu <-> Android Handoff:**
  - Triggers a configurable MacroDroid webhook URL on disconnect so your Android phone immediately reclaims the earbuds instead of leaving them idle.
- **Native GNOME 45-48 Quick Settings Extension (`buds3pro-toggle@pulkit`):**
  - Adds a dedicated **Buds3 Pro** Quick Settings toggle pill and top-bar status indicator synchronized in real time via BlueZ D-Bus `PropertiesChanged` signals.
  - Includes a built-in **Open Buds Manager** menu action to launch `GalaxyBudsClient`.
- **On-Demand Adapter Power Management:**
  - Supports powering the Bluetooth controller down when disconnecting to prevent unsolicited audio stealing on laptop boot or suspend/wake.
- **One-Command Installer (`install.sh`):**
  - Automated setup of `~/.local/bin/buds-switch`, `~/.config/buds-switch/config.env`, desktop shortcut, and GNOME Shell extension.
