# Galaxy Buds3 Pro - Seamless Ubuntu & Android Switcher

One-click GNOME Quick Settings toggle and CLI switcher for **Samsung Galaxy Buds3 Pro** on Ubuntu 24.04+ (GNOME 45/46/47/48), with instant bidirectional handoff between Ubuntu and Android.

## Why This Exists

Samsung Galaxy Buds3 Pro use Samsung Seamless Switch only between Samsung Galaxy devices, and advertise both Classic Bluetooth (`BR/EDR`) and Bluetooth Low Energy (`LE Audio`) over the same MAC address. On Linux (BlueZ):
1. Standard `bluetoothctl connect` often gets stuck trying to connect LE Audio (`BAP`) instead of Classic Audio (`A2DP Sink` / `AVRCP` / `HFP`).
2. Disconnecting from Ubuntu leaves the earbuds idle instead of automatically reconnecting them to your Android phone.

This project solves both problems:
- **Pull to Ubuntu (`buds-switch connect`)**: Explicitly connects the Classic `BR/EDR` profiles (`A2DP Sink 0000110b`, `AVRCP 0000110e`, `HFP 0000111e`) over D-Bus to pull the earbuds directly away from your phone and sets them as the default PipeWire audio sink (`wpctl`).
- **Push to Android (`buds-switch disconnect`)**: Disconnects from Ubuntu and triggers a lightweight **MacroDroid Webhook** on your Android phone that immediately pulls the earbuds back to your phone.
- **GNOME Quick Settings Pill (`budsQuickToggle.js`)**: Adds a native **Buds3 Pro** pill to the Ubuntu top-right Quick Settings menu with real-time BlueZ D-Bus status updates and a submenu to launch **GalaxyBudsClient** (for ANC, Ambient Sound, Equalizer, and battery levels).

---

## Repository Structure

```text
galaxy-buds-ubuntu/
├── buds-switch                 # CLI script (connect | disconnect | toggle | status)
├── budsQuickToggle.js          # GNOME Shell Quick Settings indicator & menu toggle
├── extension.js                # Standalone GNOME Shell extension entrypoint
├── metadata.json               # Standalone GNOME Shell extension metadata
├── earbuds-symbolic.svg        # Symbolic icon for GNOME Shell & desktop notifications
├── galaxybudsclient.desktop    # Desktop launcher template for GalaxyBudsClient GUI
├── install.sh                  # Automated setup script for a fresh Ubuntu install
├── LICENSE                     # MIT License
├── .env.example                # Template for your Bluetooth MAC & MacroDroid webhook
└── .gitignore                  # Ignores .env so personal MAC/webhook are never committed
```

---

## Fresh System Setup (Step-by-Step)

### 1. Prerequisites on Ubuntu

Ensure standard Bluetooth, PipeWire, and notification tools are installed:

```bash
sudo apt update
sudo apt install -y bluez libglib2.0-bin libnotify-bin curl wireplumber gnome-shell-extension-prefs
```

#### BlueZ Configuration (Prevent Auto-Steal on Boot)
By default on Ubuntu, `AutoEnable=true` in `/etc/bluetooth/main.conf` causes Ubuntu to power on Bluetooth at boot/resume and automatically steal your earbuds away from your phone. Setting `AutoEnable=false` under `[Policy]` stops unsolicited auto-stealing while `buds-switch connect` powers on Bluetooth automatically whenever you click Connect:
```bash
sudo sed -i 's/^#*AutoEnable\s*=.*/AutoEnable=false/' /etc/bluetooth/main.conf
sudo systemctl restart bluetooth
```

Pair and trust your Galaxy Buds3 Pro once with Ubuntu while they are in pairing mode:
```bash
bluetoothctl
# Inside bluetoothctl:
# power on
# scan on
# pair XX:XX:XX:XX:XX:XX
# trust XX:XX:XX:XX:XX:XX
# connect XX:XX:XX:XX:XX:XX
```

### 2. Clone & Configure `.env`

Clone the repository, copy `.env.example` to `.env`, and fill in your earbuds' MAC address and (optionally) your MacroDroid webhook URL:

```bash
git clone https://github.com/pulkitmundra/galaxy-buds-ubuntu.git ~/Desktop/prsnl/galaxy-buds-ubuntu
cd ~/Desktop/prsnl/galaxy-buds-ubuntu
cp .env.example .env
nano .env
```

```ini
BUD_MAC="XX:XX:XX:XX:XX:XX"
MACRODROID_WEBHOOK_BASE="https://trigger.macrodroid.com/YOUR-UUID-HERE"
```

### 3. Run the Installer

```bash
chmod +x install.sh
./install.sh
```

What `install.sh` does:
1. Symlinks `.env` -> `~/.config/buds-switch.env`
2. Symlinks `buds-switch` -> `~/.local/bin/buds-switch`
3. Symlinks `earbuds-symbolic.svg` -> `~/.local/share/icons/earbuds-symbolic.svg`
4. Downloads the official portable **GalaxyBudsClient** binary to `~/.local/opt/galaxybudsclient/GalaxyBudsClient` (if not already present) and installs `~/.local/share/applications/galaxybudsclient.desktop`
5. Installs and enables the GNOME Shell Quick Settings extension (`buds-quick-toggle@local`).
   - *Note*: On Wayland sessions, log out and log back in once so GNOME Shell discovers the new extension.

---

## Android Auto-Reconnect Setup (MacroDroid)

To make your Android phone automatically grab the earbuds the instant you click **Disconnect** on Ubuntu:

1. Install **MacroDroid** from the Google Play Store on your Android phone.
2. Create a new Macro named **Connect Buds**:
   - **Trigger**: `Webhook (Url)` -> Set identifier to `buds`
     - Copy the generated base URL (`https://trigger.macrodroid.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) into `MACRODROID_WEBHOOK_BASE` in your `.env` file (without `/buds` at the end).
   - **Actions**:
     1. `Configure Bluetooth` -> **Connect to Audio Device** -> Select your **Galaxy Buds3 Pro**
     2. `Wait Before Next Action` -> **2 Seconds**
     3. `Configure Bluetooth` -> **Connect to Audio Device** -> Select your **Galaxy Buds3 Pro** (second retry ensures connection if BlueZ takes a moment to release the RFCOMM link)
3. Save and enable the Macro, and set MacroDroid's battery optimization to **Unrestricted** on Android so webhooks deliver instantaneously while the phone screen is off.

---

## CLI Usage

```bash
buds-switch toggle       # Toggle between Ubuntu and Android
buds-switch connect      # Pull earbuds from Android to Ubuntu
buds-switch disconnect   # Disconnect from Ubuntu and push to Android
buds-switch status       # Prints "connected" or "disconnected"
```

You can also bind `buds-switch toggle` to a custom keyboard shortcut in **Ubuntu Settings -> Keyboard -> Custom Shortcuts**.

## License

MIT License
