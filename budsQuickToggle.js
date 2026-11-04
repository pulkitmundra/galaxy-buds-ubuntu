import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const A2DP_UUID = '0000110b-0000-1000-8000-00805f9b34fb';
const AVRCP_UUID = '0000110e-0000-1000-8000-00805f9b34fb';
const HFP_UUID = '0000111e-0000-1000-8000-00805f9b34fb';

function parseBlueZManagedObjects(objects, configuredMacU) {
    let fallbackMatch = null;

    for (const [objPath, ifaces] of Object.entries(objects)) {
        const dev = ifaces['org.bluez.Device1'];
        if (!dev)
            continue;

        const address = String(dev.Address?.deep_unpack() ?? '').toUpperCase();
        const macU = address.replace(/:/g, '_');
        const name = String(dev.Name?.deep_unpack() ?? '');
        const alias = String(dev.Alias?.deep_unpack() ?? name);
        const connected = Boolean(dev.Connected?.deep_unpack() ?? false);
        const paired = Boolean(dev.Paired?.deep_unpack() ?? false);
        const adapter = String(dev.Adapter?.deep_unpack() ?? '/org/bluez/hci0');

        let battery = null;
        const battIface = ifaces['org.bluez.Battery1'];
        if (battIface && battIface.Percentage) {
            const pct = battIface.Percentage.deep_unpack();
            if (pct >= 0 && pct <= 100)
                battery = pct;
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

        if (configuredMacU && objPath.endsWith(`/dev_${configuredMacU}`))
            return info;

        if (!configuredMacU && paired && (/buds/i.test(name) || /buds/i.test(alias))) {
            if (connected || !fallbackMatch)
                fallbackMatch = info;
        }
    }

    if (fallbackMatch)
        return fallbackMatch;

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

function dbusCallAsync(bus, busName, objectPath, ifaceName, methodName, params, cancellable, timeoutMs = 4000) {
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
            cancellable,
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

const BudsMenuToggle = GObject.registerClass(
class BudsMenuToggle extends QuickSettings.QuickMenuToggle {
    _init(gicon, onAction, onOpenPreferences) {
        this._gicon = gicon;

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
        this._connectItem.connect('activate', () => onAction('connect'));
        this.menu.addMenuItem(this._connectItem);

        this._disconnectItem = new PopupMenu.PopupMenuItem('Disconnect Buds (Release to Phone)');
        this._disconnectItem.connect('activate', () => onAction('disconnect'));
        this.menu.addMenuItem(this._disconnectItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._a2dpItem = new PopupMenu.PopupMenuItem('Audio Mode: High-Fidelity Music (A2DP)');
        this._a2dpItem.connect('activate', () => onAction('profile-a2dp'));
        this.menu.addMenuItem(this._a2dpItem);

        this._hfpItem = new PopupMenu.PopupMenuItem('Audio Mode: Call + Microphone (HFP)');
        this._hfpItem.connect('activate', () => onAction('profile-hfp'));
        this.menu.addMenuItem(this._hfpItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._settingsItem = new PopupMenu.PopupMenuItem('Settings & Android Setup Guide');
        this._settingsItem.connect('activate', () => {
            Main.panel.statusArea.quickSettings.menu.close();
            onOpenPreferences();
        });
        this.menu.addMenuItem(this._settingsItem);
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
});

export const BudsIndicator = GObject.registerClass(
class BudsIndicator extends QuickSettings.SystemIndicator {
    _init(extension) {
        super._init();

        this._extension = extension;
        this._settings = extension.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._httpSession = new Soup.Session({timeout: 5});
        this._isBusy = false;

        const iconFile = Gio.File.new_for_path(`${extension.path}/earbuds-symbolic.svg`);
        this._gicon = new Gio.FileIcon({file: iconFile});

        this._indicator = this._addIndicator();
        this._indicator.gicon = this._gicon;
        this._indicator.visible = false;

        this._toggle = new BudsMenuToggle(
            this._gicon,
            action => this._executeAction(action),
            () => this._extension.openPreferences()
        );
        this.quickSettingsItems.push(this._toggle);

        this._toggle.connectObject('clicked', () => this._onToggleClicked(), this);
        this._settings.connectObject('changed', () => this._refreshState(), this);

        Main.panel.statusArea.quickSettings.addExternalIndicator(this);

        this._dbusSubId = Gio.DBus.system.signal_subscribe(
            'org.bluez',
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            null,
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, objectPath, _iface, _signalName, params) => {
                if (!objectPath || !objectPath.includes('/dev_'))
                    return;
                const [ifaceName] = params.deep_unpack();
                if (ifaceName === 'org.bluez.Device1' || ifaceName === 'org.bluez.Battery1')
                    this._refreshState();
            }
        );

        this._refreshState();
    }

    _getConfiguredMacUnderscore() {
        const rawMac = this._settings.get_string('bud-mac').trim().toUpperCase();
        if (/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(rawMac) && rawMac !== 'AA:BB:CC:DD:EE:FF')
            return rawMac.replace(/:/g, '_');
        return null;
    }

    _getWebhookBase() {
        return this._settings
            .get_string('macrodroid-webhook')
            .trim()
            .replace(/\/+$/, '')
            .replace(/\/buds$/i, '');
    }

    _discoverBuds(callback) {
        const configuredMacU = this._getConfiguredMacUnderscore();
        Gio.DBus.system.call(
            'org.bluez',
            '/',
            'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects',
            null,
            new GLib.VariantType('(a{oa{sa{sv}}})'),
            Gio.DBusCallFlags.NONE,
            2000,
            this._cancellable,
            (conn, res) => {
                try {
                    const reply = conn.call_finish(res);
                    const [objects] = reply.deep_unpack();
                    callback(parseBlueZManagedObjects(objects, configuredMacU));
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    const macU = configuredMacU || '00_00_00_00_00_00';
                    callback({
                        objectPath: `/org/bluez/hci0/dev_${macU}`,
                        adapterPath: '/org/bluez/hci0',
                        macUnderscore: macU,
                        alias: 'Samsung Galaxy Buds',
                        connected: false,
                        paired: false,
                        battery: null,
                    });
                }
            }
        );
    }

    _refreshState() {
        this._discoverBuds(info => {
            if (!this._toggle)
                return;
            const {fullTitle, pillTitle} = formatModelTitles(info.alias);

            this._toggle.checked = info.connected;
            this._indicator.visible = info.connected;

            let subtitle = 'Disconnected';
            if (info.connected)
                subtitle = info.battery !== null ? `Connected - ${info.battery}%` : 'Connected';

            this._toggle.updateDeviceLabels(fullTitle, pillTitle, subtitle);
        });
    }

    _onToggleClicked() {
        if (this._isBusy)
            return;
        this._isBusy = true;

        this._toggle.subtitle = this._toggle.checked ? 'Disconnecting...' : 'Connecting...';
        this._executeAction('toggle', () => {
            this._isBusy = false;
            this._refreshState();
        });
    }

    _executeAction(action, doneCallback = null) {
        this._discoverBuds(async info => {
            try {
                if (action === 'connect') {
                    await this._connectBuds(info);
                } else if (action === 'disconnect') {
                    await this._disconnectBuds(info);
                } else if (action === 'toggle') {
                    if (info.connected)
                        await this._disconnectBuds(info);
                    else
                        await this._connectBuds(info);
                } else if (action === 'profile-a2dp') {
                    this._switchPipeWireProfile(info, 'a2dp');
                } else if (action === 'profile-hfp') {
                    this._switchPipeWireProfile(info, 'hfp');
                }
            } finally {
                if (this._toggle)
                    this._refreshState();
                if (doneCallback)
                    doneCallback();
            }
        });
    }

    async _connectBuds(info) {
        try {
            await dbusCallAsync(
                Gio.DBus.system,
                'org.bluez',
                info.adapterPath || '/org/bluez/hci0',
                'org.freedesktop.DBus.Properties',
                'Set',
                new GLib.Variant('(ssv)', [
                    'org.bluez.Adapter1',
                    'Powered',
                    new GLib.Variant('b', true),
                ]),
                this._cancellable,
                2000
            );
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
        }

        let connectedA2dp = false;
        for (const uuid of [A2DP_UUID, AVRCP_UUID, HFP_UUID]) {
            try {
                await dbusCallAsync(
                    Gio.DBus.system,
                    'org.bluez',
                    info.objectPath,
                    'org.bluez.Device1',
                    'ConnectProfile',
                    new GLib.Variant('(s)', [uuid]),
                    this._cancellable,
                    5000
                );
                if (uuid === A2DP_UUID)
                    connectedA2dp = true;
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
            }
        }

        if (!connectedA2dp) {
            try {
                await dbusCallAsync(
                    Gio.DBus.system,
                    'org.bluez',
                    info.objectPath,
                    'org.bluez.Device1',
                    'Connect',
                    null,
                    this._cancellable,
                    6000
                );
            } catch (_e) {
            }
        }
    }

    async _disconnectBuds(info) {
        try {
            await dbusCallAsync(
                Gio.DBus.system,
                'org.bluez',
                info.objectPath,
                'org.bluez.Device1',
                'Disconnect',
                null,
                this._cancellable,
                4000
            );
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
        }

        const webhookBase = this._getWebhookBase();
        if (webhookBase && /^https?:\/\/[A-Za-z0-9._:/-]+$/.test(webhookBase) && this._httpSession) {
            const msg = Soup.Message.new('GET', `${webhookBase}/buds`);
            if (msg) {
                this._httpSession.send_and_read_async(
                    msg,
                    GLib.PRIORITY_DEFAULT,
                    this._cancellable,
                    (session, res) => {
                        try {
                            session.send_and_read_finish(res);
                        } catch (_e) {
                        }
                    }
                );
            }
        }
    }

    _switchPipeWireProfile(info, mode) {
        const macU = info.macUnderscore;
        if (!macU || macU === '00_00_00_00_00_00')
            return;

        try {
            const proc = Gio.Subprocess.new(
                ['pw-dump'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            proc.communicate_utf8_async(null, this._cancellable, (source, res) => {
                try {
                    const [ok, stdout] = source.communicate_utf8_finish(res);
                    if (!ok || !stdout)
                        return;
                    const data = JSON.parse(stdout);
                    const prefix = mode === 'a2dp' ? 'a2dp-sink' : 'headset-head-unit';
                    for (const obj of data) {
                        if (obj.type !== 'PipeWire:Interface:Device')
                            continue;
                        const devName = String(obj.info?.props?.['device.name'] || '').toUpperCase();
                        if (!devName.includes(macU.toUpperCase()))
                            continue;
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
                            setProc.wait_async(this._cancellable, null);
                            break;
                        }
                    }
                } catch (_e) {
                }
            });
        } catch (_e) {
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._cancellable = null;

        this._httpSession.abort();
        this._httpSession = null;

        if (this._dbusSubId) {
            Gio.DBus.system.signal_unsubscribe(this._dbusSubId);
            this._dbusSubId = null;
        }

        this._settings.disconnectObject(this);
        this._settings = null;

        this.quickSettingsItems.forEach(item => item.destroy());
        this._toggle = null;
        this._extension = null;

        super.destroy();
    }
});
