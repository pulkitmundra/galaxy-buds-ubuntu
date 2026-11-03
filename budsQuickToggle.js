import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const QuickSettingsMenu = Main.panel.statusArea.quickSettings;
const HOME_DIR = GLib.get_home_dir();

const ICON_PATH = `${HOME_DIR}/.local/share/icons/earbuds-symbolic.svg`;
const SWITCH_SCRIPT = `${HOME_DIR}/.local/bin/buds-switch`;
const SETTINGS_SCRIPT = `${HOME_DIR}/.local/bin/buds-settings`;
const MANAGER_BIN = `${HOME_DIR}/.local/opt/galaxybudsclient/GalaxyBudsClient`;
const BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/pulkitmundra';

function readConfiguredMacUnderscore() {
    try {
        const envPath = `${HOME_DIR}/.config/buds-switch.env`;
        const [ok, bytes] = GLib.file_get_contents(envPath);
        if (ok) {
            const text = new TextDecoder().decode(bytes);
            const match = text.match(/^\s*BUD_MAC\s*=\s*["']?([0-9A-Fa-f:]{17})["']?/m);
            if (match && match[1]) {
                const upper = match[1].toUpperCase();
                if (upper !== 'AA:BB:CC:DD:EE:FF') {
                    return upper.replace(/:/g, '_');
                }
            }
        }
    } catch (_e) {
        // Fallback to BlueZ auto-discovery below
    }
    return null;
}

function discoverBudsFromBlueZ() {
    const configuredMacU = readConfiguredMacUnderscore();
    let fallbackMatch = null;

    try {
        const reply = Gio.DBus.system.call_sync(
            'org.bluez',
            '/',
            'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects',
            null,
            new GLib.VariantType('(a{oa{sa{sv}}})'),
            Gio.DBusCallFlags.NONE,
            1500,
            null
        );
        const [objects] = reply.deep_unpack();

        const unpack = (dict, key, defVal = null) => {
            if (!dict || !(key in dict)) return defVal;
            const v = dict[key];
            return v && typeof v.deep_unpack === 'function' ? v.deep_unpack() : v;
        };

        for (const [objPath, ifaces] of Object.entries(objects)) {
            const dev = ifaces['org.bluez.Device1'];
            if (!dev) continue;

            const address = String(unpack(dev, 'Address', '')).toUpperCase();
            const macU = address.replace(/:/g, '_');
            const name = String(unpack(dev, 'Name', '') || '');
            const alias = String(unpack(dev, 'Alias', '') || name);
            const connected = Boolean(unpack(dev, 'Connected', false));
            const paired = Boolean(unpack(dev, 'Paired', false));

            let battery = null;
            const battIface = ifaces['org.bluez.Battery1'];
            if (battIface) {
                const pct = unpack(battIface, 'Percentage', null);
                if (typeof pct === 'number' && pct >= 0 && pct <= 100) {
                    battery = pct;
                }
            }

            const info = {
                objectPath: objPath,
                macUnderscore: macU,
                alias: alias || name || 'Samsung Galaxy Buds',
                connected,
                paired,
                battery,
            };

            if (configuredMacU && objPath.endsWith(`/dev_${configuredMacU}`)) {
                return info;
            }

            if (!configuredMacU && paired && (/buds/i.test(name) || /buds/i.test(alias))) {
                if (connected || !fallbackMatch) {
                    fallbackMatch = info;
                }
            }
        }
    } catch (_e) {
        // Fallback below if BlueZ is unreachable
    }

    if (fallbackMatch) {
        return fallbackMatch;
    }

    const macU = configuredMacU || '00_00_00_00_00_00';
    return {
        objectPath: `/org/bluez/hci0/dev_${macU}`,
        macUnderscore: macU,
        alias: 'Samsung Galaxy Buds',
        connected: false,
        paired: false,
        battery: null,
    };
}

function formatModelTitles(rawAlias) {
    const cleanFull =
        String(rawAlias || 'Samsung Galaxy Buds')
            .replace(/\s*\([0-9A-Fa-f]{4}\)\s*$/, '')
            .trim() || 'Samsung Galaxy Buds';

    const shortPill =
        cleanFull
            .replace(/^Samsung\s+/i, '')
            .replace(/^Galaxy\s+/i, '')
            .trim() || 'Galaxy Buds';

    return {
        fullTitle: cleanFull,
        pillTitle: shortPill,
    };
}

const BudsMenuToggle = GObject.registerClass(
class BudsMenuToggle extends QuickSettings.QuickMenuToggle {
    _init() {
        this._gicon = Gio.icon_new_for_string(ICON_PATH);
        super._init({
            title: 'Galaxy Buds',
            subtitle: 'Disconnected',
            gicon: this._gicon,
            toggleMode: false,
        });

        this.menu.setHeader(
            this._gicon,
            'Samsung Galaxy Buds',
            'Seamless Ubuntu / Android Switcher'
        );

        this._connectItem = new PopupMenu.PopupMenuItem('Connect Buds (Pull from Phone)');
        this._connectItem.connect('activate', () => {
            this._runCommand([SWITCH_SCRIPT, 'connect']);
        });
        this.menu.addMenuItem(this._connectItem);

        this._disconnectItem = new PopupMenu.PopupMenuItem('Disconnect Buds (Release to Phone)');
        this._disconnectItem.connect('activate', () => {
            this._runCommand([SWITCH_SCRIPT, 'disconnect']);
        });
        this.menu.addMenuItem(this._disconnectItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._a2dpItem = new PopupMenu.PopupMenuItem('Audio Mode: High-Fidelity Music (A2DP)');
        this._a2dpItem.connect('activate', () => {
            this._runCommand([SWITCH_SCRIPT, 'profile', 'a2dp']);
        });
        this.menu.addMenuItem(this._a2dpItem);

        this._hfpItem = new PopupMenu.PopupMenuItem('Audio Mode: Call + Microphone (HFP)');
        this._hfpItem.connect('activate', () => {
            this._runCommand([SWITCH_SCRIPT, 'profile', 'hfp']);
        });
        this.menu.addMenuItem(this._hfpItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._managerItem = new PopupMenu.PopupMenuItem('Open Galaxy Buds Manager');
        this._managerItem.connect('activate', () => {
            QuickSettingsMenu.menu.close();
            this._runCommand([MANAGER_BIN]);
        });
        this.menu.addMenuItem(this._managerItem);

        this._settingsItem = new PopupMenu.PopupMenuItem('Settings & Android Setup Guide');
        this._settingsItem.connect('activate', () => {
            QuickSettingsMenu.menu.close();
            if (GLib.file_test(SETTINGS_SCRIPT, GLib.FileTest.IS_EXECUTABLE)) {
                this._runCommand([SETTINGS_SCRIPT]);
            } else {
                this._runCommand([SWITCH_SCRIPT, 'settings']);
            }
        });
        this.menu.addMenuItem(this._settingsItem);

        this._supportItem = new PopupMenu.PopupMenuItem('Buy Me a Coffee ☕');
        this._supportItem.connect('activate', () => {
            QuickSettingsMenu.menu.close();
            try {
                Gio.AppInfo.launch_default_for_uri(BUY_ME_A_COFFEE_URL, null);
            } catch (e) {
                logError(e, 'GalaxyBudsSwitcher failed to open support URL');
            }
        });
        this.menu.addMenuItem(this._supportItem);
    }

    updateDeviceLabels(fullTitle, pillTitle, subtitleText) {
        this.title = pillTitle;
        this.subtitle = subtitleText;
        this.menu.setHeader(
            this._gicon,
            fullTitle,
            'Seamless Ubuntu / Android Switcher'
        );
    }

    _runCommand(argv) {
        try {
            const proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.NONE
            );
            proc.wait_async(null, null);
        } catch (e) {
            logError(e, 'GalaxyBudsSwitcher failed to run command');
        }
    }
});

export const BudsIndicator = GObject.registerClass(
class BudsIndicator extends QuickSettings.SystemIndicator {
    _init() {
        super._init();

        this._gicon = Gio.icon_new_for_string(ICON_PATH);
        this._indicator = this._addIndicator();
        this._indicator.gicon = this._gicon;
        this._indicator.visible = false;

        this._toggle = new BudsMenuToggle();
        this.quickSettingsItems.push(this._toggle);

        this._isBusy = false;

        this._toggle.connectObject('clicked', () => this._onToggleClicked(), this);

        QuickSettingsMenu.addExternalIndicator(this);

        this._dbusSubId = Gio.DBus.system.signal_subscribe(
            'org.bluez',
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            null,
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, objectPath, _iface, signalName, params) => {
                if (!objectPath || !objectPath.includes('/dev_')) return;
                const [ifaceName] = params.deep_unpack();
                if (ifaceName === 'org.bluez.Device1' || ifaceName === 'org.bluez.Battery1') {
                    this._refreshState();
                }
            }
        );

        this._refreshState();
    }

    _refreshState() {
        const info = discoverBudsFromBlueZ();
        const { fullTitle, pillTitle } = formatModelTitles(info.alias);

        this._toggle.checked = info.connected;
        this._indicator.visible = info.connected;

        let subtitle = 'Disconnected';
        if (info.connected) {
            subtitle = info.battery !== null ? `Connected - ${info.battery}%` : 'Connected';
        }

        this._toggle.updateDeviceLabels(fullTitle, pillTitle, subtitle);
    }

    _onToggleClicked() {
        if (this._isBusy) return;
        this._isBusy = true;

        const info = discoverBudsFromBlueZ();
        this._toggle.subtitle = info.connected ? 'Disconnecting...' : 'Connecting...';

        try {
            const proc = Gio.Subprocess.new(
                [SWITCH_SCRIPT, 'toggle'],
                Gio.SubprocessFlags.NONE
            );
            proc.wait_async(null, () => {
                this._isBusy = false;
                this._refreshState();
            });
        } catch (_e) {
            this._isBusy = false;
            this._refreshState();
        }
    }

    destroy() {
        if (this._dbusSubId) {
            Gio.DBus.system.signal_unsubscribe(this._dbusSubId);
            this._dbusSubId = null;
        }
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});
