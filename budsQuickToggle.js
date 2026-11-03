import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const HOME_DIR = GLib.get_home_dir();
const SWITCH_SCRIPT = `${HOME_DIR}/.local/bin/buds-switch`;
const SETTINGS_SCRIPT = `${HOME_DIR}/.local/bin/buds-settings`;
const MANAGER_BIN = `${HOME_DIR}/.local/opt/galaxybudsclient/GalaxyBudsClient`;
const BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/pulkitmundra';
const EXT_UUID = 'galaxy-buds-switcher@pulkitmundra.github.io';

const A2DP_UUID = '0000110b-0000-1000-8000-00805f9b34fb';
const AVRCP_UUID = '0000110e-0000-1000-8000-00805f9b34fb';
const HFP_UUID = '0000111e-0000-1000-8000-00805f9b34fb';

function resolveExtensionIcon() {
    try {
        const bundledUrl = new URL('./earbuds-symbolic.svg', import.meta.url);
        const bundledFile = Gio.File.new_for_uri(bundledUrl.href);
        if (bundledFile.query_exists(null)) {
            return new Gio.FileIcon({ file: bundledFile });
        }
    } catch (_e) {
        // Fallback below
    }
    const localPath = `${HOME_DIR}/.local/share/icons/earbuds-symbolic.svg`;
    if (GLib.file_test(localPath, GLib.FileTest.EXISTS)) {
        return Gio.icon_new_for_string(localPath);
    }
    return Gio.icon_new_for_string('audio-headphones-symbolic');
}

function readEnvFile() {
    const cfg = { macUnderscore: null, webhookBase: '' };
    try {
        const envPath = `${HOME_DIR}/.config/buds-switch.env`;
        if (!GLib.file_test(envPath, GLib.FileTest.EXISTS)) {
            return cfg;
        }
        const [ok, bytes] = GLib.file_get_contents(envPath);
        if (ok) {
            const text = new TextDecoder().decode(bytes);
            const macMatch = text.match(/^\s*BUD_MAC\s*=\s*["']?([0-9A-Fa-f:]{17})["']?/m);
            if (macMatch && macMatch[1]) {
                const upper = macMatch[1].toUpperCase();
                if (upper !== 'AA:BB:CC:DD:EE:FF') {
                    cfg.macUnderscore = upper.replace(/:/g, '_');
                }
            }
            const hookMatch = text.match(/^\s*MACRODROID_WEBHOOK_BASE\s*=\s*["']?([^"'\s#]*)["']?/m);
            if (hookMatch && hookMatch[1]) {
                cfg.webhookBase = hookMatch[1].trim().replace(/\/+$/, '').replace(/\/buds$/i, '');
            }
        }
    } catch (_e) {
        // Ignore read error
    }
    return cfg;
}

function parseBlueZManagedObjects(objects, configuredMacU) {
    let fallbackMatch = null;

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
        const adapter = String(unpack(dev, 'Adapter', '/org/bluez/hci0'));

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
            adapterPath: adapter,
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

    if (fallbackMatch) {
        return fallbackMatch;
    }

    const macU = configuredMacU || '00_00_00_00_00_00';
    return {
        objectPath: `/org/bluez/hci0/dev_${macU}`,
        adapterPath: '/org/bluez/hci0',
        macUnderscore: macU,
        alias: 'Samsung Galaxy Buds',
        connected: false,
        paired: false,
        battery: null,
    };
}

function discoverBudsAsync(callback) {
    const { macUnderscore, webhookBase } = readEnvFile();
    Gio.DBus.system.call(
        'org.bluez',
        '/',
        'org.freedesktop.DBus.ObjectManager',
        'GetManagedObjects',
        null,
        new GLib.VariantType('(a{oa{sa{sv}}})'),
        Gio.DBusCallFlags.NONE,
        2000,
        null,
        (conn, res) => {
            try {
                const reply = conn.call_finish(res);
                const [objects] = reply.deep_unpack();
                const info = parseBlueZManagedObjects(objects, macUnderscore);
                info.webhookBase = webhookBase;
                callback(info);
            } catch (_e) {
                const macU = macUnderscore || '00_00_00_00_00_00';
                callback({
                    objectPath: `/org/bluez/hci0/dev_${macU}`,
                    adapterPath: '/org/bluez/hci0',
                    macUnderscore: macU,
                    alias: 'Samsung Galaxy Buds',
                    connected: false,
                    paired: false,
                    battery: null,
                    webhookBase,
                });
            }
        }
    );
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

function dbusCallPromise(bus, busName, objectPath, ifaceName, methodName, params, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        bus.call(
            busName,
            objectPath,
            ifaceName,
            methodName,
            params,
            null,
            Gio.DBusCallFlags.NONE,
            timeoutMs,
            null,
            (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

async function nativeConnectBuds(info) {
    try {
        await dbusCallPromise(
            Gio.DBus.system,
            'org.bluez',
            info.adapterPath || '/org/bluez/hci0',
            'org.freedesktop.DBus.Properties',
            'Set',
            new GLib.Variant('(ssv)', ['org.bluez.Adapter1', 'Powered', new GLib.Variant('b', true)]),
            2000
        );
    } catch (_e) {
        // Ignore if adapter is already powered
    }

    let connectedA2dp = false;
    for (const uuid of [A2DP_UUID, AVRCP_UUID, HFP_UUID]) {
        try {
            await dbusCallPromise(
                Gio.DBus.system,
                'org.bluez',
                info.objectPath,
                'org.bluez.Device1',
                'ConnectProfile',
                new GLib.Variant('(s)', [uuid]),
                5000
            );
            if (uuid === A2DP_UUID) connectedA2dp = true;
        } catch (_e) {
            // Continue trying remaining profiles
        }
    }

    if (!connectedA2dp) {
        try {
            await dbusCallPromise(
                Gio.DBus.system,
                'org.bluez',
                info.objectPath,
                'org.bluez.Device1',
                'Connect',
                null,
                6000
            );
        } catch (_e) {
            // Ignore connect error
        }
    }
}

async function nativeDisconnectBuds(info) {
    try {
        await dbusCallPromise(
            Gio.DBus.system,
            'org.bluez',
            info.objectPath,
            'org.bluez.Device1',
            'Disconnect',
            null,
            4000
        );
    } catch (_e) {
        // Ignore disconnect error
    }

    if (info.webhookBase && /^https?:\/\/[A-Za-z0-9._:/-]+$/.test(info.webhookBase)) {
        try {
            const proc = Gio.Subprocess.new(
                ['curl', '-sS', '--proto', '=https,http', '--max-time', '5', '--', `${info.webhookBase}/buds`],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            proc.wait_async(null, null);
        } catch (_e) {
            // Ignore curl error
        }
    }
}

function nativeSwitchProfile(info, mode) {
    const macU = info.macUnderscore;
    if (!macU || macU === '00_00_00_00_00_00') return;
    try {
        const proc = Gio.Subprocess.new(
            ['pw-dump'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        proc.communicate_utf8_async(null, null, (source, res) => {
            try {
                const [ok, stdout] = source.communicate_utf8_finish(res);
                if (!ok || !stdout) return;
                const data = JSON.parse(stdout);
                const prefix = mode === 'a2dp' ? 'a2dp-sink' : 'headset-head-unit';
                for (const obj of data) {
                    if (obj.type !== 'PipeWire:Interface:Device') continue;
                    const devName = String(obj.info?.props?.['device.name'] || '').toUpperCase();
                    if (!devName.includes(macU.toUpperCase())) continue;
                    const devId = String(obj.id);
                    const enumProfiles = obj.info?.params?.EnumProfile || [];
                    const candidates = enumProfiles.filter(
                        p => String(p.name || '').startsWith(prefix) && p.available !== 'no'
                    );
                    const list = candidates.length > 0
                        ? candidates
                        : enumProfiles.filter(p => String(p.name || '').startsWith(prefix));
                    if (list.length > 0) {
                        const chosen = list.find(c => c.name === prefix) || list[0];
                        const setProc = Gio.Subprocess.new(
                            ['wpctl', 'set-profile', devId, String(chosen.index)],
                            Gio.SubprocessFlags.NONE
                        );
                        setProc.wait_async(null, null);
                        break;
                    }
                }
            } catch (_e) {
                // Ignore PipeWire parse error
            }
        });
    } catch (_e) {
        // Ignore subprocess error
    }
}

const BudsMenuToggle = GObject.registerClass(
class BudsMenuToggle extends QuickSettings.QuickMenuToggle {
    _init(extensionObject = null, onActionDone = null) {
        this._extensionObject = extensionObject;
        this._onActionDone = onActionDone;
        this._gicon = resolveExtensionIcon();

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
            this. executeAction('connect');
        });
        this.menu.addMenuItem(this._connectItem);

        this._disconnectItem = new PopupMenu.PopupMenuItem('Disconnect Buds (Release to Phone)');
        this._disconnectItem.connect('activate', () => {
            this.executeAction('disconnect');
        });
        this.menu.addMenuItem(this._disconnectItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._a2dpItem = new PopupMenu.PopupMenuItem('Audio Mode: High-Fidelity Music (A2DP)');
        this._a2dpItem.connect('activate', () => {
            this.executeAction('profile-a2dp');
        });
        this.menu.addMenuItem(this._a2dpItem);

        this._hfpItem = new PopupMenu.PopupMenuItem('Audio Mode: Call + Microphone (HFP)');
        this._hfpItem.connect('activate', () => {
            this.executeAction('profile-hfp');
        });
        this.menu.addMenuItem(this._hfpItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (GLib.file_test(MANAGER_BIN, GLib.FileTest.IS_EXECUTABLE)) {
            this._managerItem = new PopupMenu.PopupMenuItem('Open Galaxy Buds Manager');
            this._managerItem.connect('activate', () => {
                Main.panel.statusArea.quickSettings.menu.close();
                this._runSubprocess([MANAGER_BIN]);
            });
            this.menu.addMenuItem(this._managerItem);
        }

        this._settingsItem = new PopupMenu.PopupMenuItem('Settings & Android Setup Guide');
        this._settingsItem.connect('activate', () => {
            Main.panel.statusArea.quickSettings.menu.close();
            if (this._extensionObject && typeof this._extensionObject.openPreferences === 'function') {
                this._extensionObject.openPreferences();
            } else if (GLib.file_test(SETTINGS_SCRIPT, GLib.FileTest.IS_EXECUTABLE)) {
                this._runSubprocess([SETTINGS_SCRIPT]);
            } else {
                this._runSubprocess(['gnome-extensions', 'prefs', EXT_UUID]);
            }
        });
        this.menu.addMenuItem(this._settingsItem);

        this._supportItem = new PopupMenu.PopupMenuItem('Buy Me a Coffee ☕');
        this._supportItem.connect('activate', () => {
            Main.panel.statusArea.quickSettings.menu.close();
            try {
                Gio.AppInfo.launch_default_for_uri(BUY_ME_A_COFFEE_URL, null);
            } catch (e) {
                console.error('GalaxyBudsSwitcher failed to open support URL:', e);
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

    executeAction(action, doneCallback = null) {
        const hasCli = GLib.file_test(SWITCH_SCRIPT, GLib.FileTest.IS_EXECUTABLE);
        if (hasCli) {
            let argv = [SWITCH_SCRIPT, 'toggle'];
            if (action === 'connect') argv = [SWITCH_SCRIPT, 'connect'];
            else if (action === 'disconnect') argv = [SWITCH_SCRIPT, 'disconnect'];
            else if (action === 'profile-a2dp') argv = [SWITCH_SCRIPT, 'profile', 'a2dp'];
            else if (action === 'profile-hfp') argv = [SWITCH_SCRIPT, 'profile', 'hfp'];

            this._runSubprocess(argv, () => {
                if (this._onActionDone) this._onActionDone();
                if (doneCallback) doneCallback();
            });
            return;
        }

        // Pure standalone D-Bus / PipeWire execution when installed directly from extensions.gnome.org
        discoverBudsAsync(async info => {
            try {
                if (action === 'connect') {
                    await nativeConnectBuds(info);
                } else if (action === 'disconnect') {
                    await nativeDisconnectBuds(info);
                } else if (action === 'toggle') {
                    if (info.connected) {
                        await nativeDisconnectBuds(info);
                    } else {
                        await nativeConnectBuds(info);
                    }
                } else if (action === 'profile-a2dp') {
                    nativeSwitchProfile(info, 'a2dp');
                } else if (action === 'profile-hfp') {
                    nativeSwitchProfile(info, 'hfp');
                }
            } finally {
                if (this._onActionDone) this._onActionDone();
                if (doneCallback) doneCallback();
            }
        });
    }

    _runSubprocess(argv, onComplete = null) {
        try {
            const proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.NONE
            );
            proc.wait_async(null, () => {
                if (onComplete) onComplete();
            });
        } catch (e) {
            console.error('GalaxyBudsSwitcher failed to run command:', e);
            if (onComplete) onComplete();
        }
    }
});

export const BudsIndicator = GObject.registerClass(
class BudsIndicator extends QuickSettings.SystemIndicator {
    _init(extensionObject = null) {
        super._init();

        this._gicon = resolveExtensionIcon();
        this._indicator = this._addIndicator();
        this._indicator.gicon = this._gicon;
        this._indicator.visible = false;

        this._toggle = new BudsMenuToggle(extensionObject, () => this._refreshState());
        this.quickSettingsItems.push(this._toggle);

        this._isBusy = false;

        this._toggle.connectObject('clicked', () => this._onToggleClicked(), this);

        Main.panel.statusArea.quickSettings.addExternalIndicator(this);

        this._dbusSubId = Gio.DBus.system.signal_subscribe(
            'org.bluez',
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            null,
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, objectPath, _iface, _signalName, params) => {
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
        discoverBudsAsync(info => {
            if (!this._toggle) return;
            const { fullTitle, pillTitle } = formatModelTitles(info.alias);

            this._toggle.checked = info.connected;
            this._indicator.visible = info.connected;

            let subtitle = 'Disconnected';
            if (info.connected) {
                subtitle = info.battery !== null ? `Connected - ${info.battery}%` : 'Connected';
            }

            this._toggle.updateDeviceLabels(fullTitle, pillTitle, subtitle);
        });
    }

    _onToggleClicked() {
        if (this._isBusy) return;
        this._isBusy = true;

        this._toggle.subtitle = this._toggle.checked ? 'Disconnecting...' : 'Connecting...';
        this._toggle.executeAction('toggle', () => {
            this._isBusy = false;
            this._refreshState();
        });
    }

    destroy() {
        if (this._dbusSubId) {
            Gio.DBus.system.signal_unsubscribe(this._dbusSubId);
            this._dbusSubId = null;
        }
        this.quickSettingsItems.forEach(item => item.destroy());
        this._toggle = null;
        super.destroy();
    }
});
