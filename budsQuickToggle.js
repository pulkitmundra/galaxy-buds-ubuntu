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

function unpackProp(props, key, fallback) {
    return props[key] ? props[key].deep_unpack() : fallback;
}

function createDefaultDeviceInfo(configuredMacU) {
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

function parseBlueZManagedObjects(objects, configuredMacU) {
    let fallbackMatch = null;

    for (const [objPath, ifaces] of Object.entries(objects)) {
        const dev = ifaces['org.bluez.Device1'];
        if (!dev)
            continue;

        const address = String(unpackProp(dev, 'Address', '')).toUpperCase();
        const macU = address.replace(/:/g, '_');
        const name = String(unpackProp(dev, 'Name', ''));
        const alias = String(unpackProp(dev, 'Alias', name));
        const connected = Boolean(unpackProp(dev, 'Connected', false));
        const paired = Boolean(unpackProp(dev, 'Paired', false));
        const adapter = String(unpackProp(dev, 'Adapter', '/org/bluez/hci0'));

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

    return createDefaultDeviceInfo(configuredMacU);
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

function execCommunicateAsync(argv, cancellable) {
    if (cancellable.is_cancelled())
        return Promise.resolve(null);

    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (_e) {
            resolve(null);
            return;
        }

        const cancelId = cancellable.connect(() => proc.force_exit());

        proc.communicate_utf8_async(null, cancellable, (source, res) => {
            if (cancelId && !cancellable.is_cancelled())
                cancellable.disconnect(cancelId);

            let ok, stdout;
            try {
                [ok, stdout] = source.communicate_utf8_finish(res);
            } catch (_e) {
                resolve(null);
                return;
            }

            resolve(ok && source.get_successful() ? stdout : null);
        });
    });
}

function execCheckAsync(argv, cancellable) {
    if (cancellable.is_cancelled())
        return Promise.resolve(false);

    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (_e) {
            resolve(false);
            return;
        }

        const cancelId = cancellable.connect(() => proc.force_exit());

        proc.wait_check_async(cancellable, (source, res) => {
            if (cancelId && !cancellable.is_cancelled())
                cancellable.disconnect(cancelId);

            try {
                resolve(source.wait_check_finish(res));
            } catch (_e) {
                resolve(false);
            }
        });
    });
}

const BudsMenuToggle = GObject.registerClass(
class BudsMenuToggle extends QuickSettings.QuickMenuToggle {
    constructor(gicon, onAction, onOpenPreferences) {
        super({
            title: 'Galaxy Buds',
            subtitle: 'Disconnected',
            gicon,
            toggleMode: false,
        });

        this._gicon = gicon;

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
    constructor(extension) {
        super();

        this._pendingTimeouts = new Set();
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

        const cancellable = this._cancellable;
        this._dbusSubId = Gio.DBus.system.signal_subscribe(
            'org.bluez',
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            null,
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, objectPath, _iface, _signalName, params) => {
                if (cancellable.is_cancelled())
                    return;
                if (!objectPath || !objectPath.includes('/dev_'))
                    return;
                const [ifaceName] = params.deep_unpack();
                if (ifaceName === 'org.bluez.Device1' || ifaceName === 'org.bluez.Battery1')
                    this._refreshState();
            }
        );

        this._refreshState();
    }

    _waitMs(ms) {
        const cancellable = this._cancellable;
        const pendingTimeouts = this._pendingTimeouts;
        if (cancellable.is_cancelled())
            return Promise.resolve(false);

        return new Promise(resolve => {
            let timeoutId = null;
            let cancelId = 0;

            const finish = ok => {
                if (timeoutId !== null) {
                    pendingTimeouts.delete(timeoutId);
                    timeoutId = null;
                }
                if (cancelId && !cancellable.is_cancelled()) {
                    cancellable.disconnect(cancelId);
                    cancelId = 0;
                }
                resolve(ok);
            };

            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                pendingTimeouts.delete(timeoutId);
                timeoutId = null;
                finish(!cancellable.is_cancelled());
                return GLib.SOURCE_REMOVE;
            });
            pendingTimeouts.add(timeoutId);

            cancelId = cancellable.connect(() => {
                if (timeoutId !== null) {
                    if (pendingTimeouts.delete(timeoutId))
                        GLib.Source.remove(timeoutId);
                    timeoutId = null;
                }
                cancelId = 0;
                finish(false);
            });
        });
    }

    _getConfiguredMacUnderscore() {
        const rawMac = this._settings.get_string('bud-mac').trim().toUpperCase();
        if (/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(rawMac) && rawMac !== 'AA:BB:CC:DD:EE:FF')
            return rawMac.replace(/:/g, '_');
        return null;
    }

    _getWebhookBase() {
        const raw = this._settings.get_string('macrodroid-webhook').trim();
        if (!raw || /YOUR-UUID/i.test(raw))
            return null;

        let uri;
        try {
            uri = GLib.Uri.parse(raw, GLib.UriFlags.NONE);
        } catch (_e) {
            return null;
        }

        const scheme = uri.get_scheme().toLowerCase();
        const host = uri.get_host();
        if ((scheme !== 'http' && scheme !== 'https') || !host)
            return null;

        const cleanPath = (uri.get_path() || '').replace(/\/+$/, '');
        const segments = cleanPath.split('/').filter(Boolean);
        const targetPath = segments.length === 1
            ? `/${segments[0]}/buds`
            : (cleanPath || '/buds');

        return GLib.Uri.build(
            GLib.UriFlags.NONE,
            scheme,
            uri.get_userinfo(),
            host,
            uri.get_port(),
            targetPath,
            uri.get_query(),
            null
        ).to_string();
    }

    _discoverBuds(callback) {
        const cancellable = this._cancellable;
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
            cancellable,
            (conn, res) => {
                let reply;
                try {
                    reply = conn.call_finish(res);
                } catch (_e) {
                    if (cancellable.is_cancelled())
                        return;
                    callback(createDefaultDeviceInfo(configuredMacU));
                    return;
                }

                if (cancellable.is_cancelled())
                    return;

                const [objects] = reply.deep_unpack();
                callback(parseBlueZManagedObjects(objects, configuredMacU));
            }
        );
    }

    _refreshState() {
        const cancellable = this._cancellable;
        this._discoverBuds(info => {
            if (cancellable.is_cancelled())
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
        });
    }

    _executeAction(action, doneCallback = null) {
        const cancellable = this._cancellable;
        this._discoverBuds(async info => {
            if (cancellable.is_cancelled()) {
                if (doneCallback)
                    doneCallback();
                return;
            }

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
                await this._switchPipeWireProfile(info, 'a2dp');
            } else if (action === 'profile-hfp') {
                await this._switchPipeWireProfile(info, 'hfp');
            }

            if (doneCallback)
                doneCallback();

            if (!cancellable.is_cancelled())
                this._refreshState();
        });
    }

    async _connectBuds(info) {
        const cancellable = this._cancellable;

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
                cancellable,
                2000
            );
        } catch (_e) {
            if (cancellable.is_cancelled())
                return;
        }

        let connectedA2dp = false;
        for (const uuid of [A2DP_UUID, AVRCP_UUID, HFP_UUID]) {
            if (cancellable.is_cancelled())
                return;

            let profileConnected = false;
            try {
                await dbusCallAsync(
                    Gio.DBus.system,
                    'org.bluez',
                    info.objectPath,
                    'org.bluez.Device1',
                    'ConnectProfile',
                    new GLib.Variant('(s)', [uuid]),
                    cancellable,
                    5000
                );
                profileConnected = true;
            } catch (_e) {
                if (cancellable.is_cancelled())
                    return;
            }

            if (profileConnected && uuid === A2DP_UUID)
                connectedA2dp = true;
        }

        if (cancellable.is_cancelled())
            return;

        if (!connectedA2dp) {
            try {
                await dbusCallAsync(
                    Gio.DBus.system,
                    'org.bluez',
                    info.objectPath,
                    'org.bluez.Device1',
                    'Connect',
                    null,
                    cancellable,
                    6000
                );
            } catch (_e) {
                if (cancellable.is_cancelled())
                    return;
            }
        }

        if (cancellable.is_cancelled())
            return;

        await this._routeDefaultPipeWireSink(info);
    }

    async _disconnectBuds(info) {
        const cancellable = this._cancellable;

        try {
            await dbusCallAsync(
                Gio.DBus.system,
                'org.bluez',
                info.objectPath,
                'org.bluez.Device1',
                'Disconnect',
                null,
                cancellable,
                4000
            );
        } catch (_e) {
            if (cancellable.is_cancelled())
                return;
        }

        if (cancellable.is_cancelled())
            return;

        const webhookUrl = this._getWebhookBase();
        if (webhookUrl) {
            const msg = Soup.Message.new('GET', webhookUrl);
            if (msg) {
                this._httpSession.send_and_read_async(
                    msg,
                    GLib.PRIORITY_DEFAULT,
                    cancellable,
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

    _findPipeWireSinkId(stdout, info) {
        let data;
        try {
            data = JSON.parse(stdout);
        } catch {
            return null;
        }

        if (!Array.isArray(data))
            return null;

        const macU = String(info.macUnderscore || '').toUpperCase();
        const macColon = macU.replace(/_/g, ':');
        const hasValidMac = Boolean(macU && macU !== '00_00_00_00_00_00');
        const aliasUpper = String(info.alias || '').toUpperCase();
        let fallbackId = null;

        for (const obj of data) {
            if (!obj || obj.type !== 'PipeWire:Interface:Node' || !obj.info)
                continue;

            const props = obj.info.props;
            if (!props || props['media.class'] !== 'Audio/Sink')
                continue;

            const nodeName = String(props['node.name'] || '').toUpperCase();
            const bluezAddr = String(props['api.bluez5.address'] || '').toUpperCase();
            const nodeDesc = String(props['node.description'] || '').toUpperCase();

            if (hasValidMac &&
                (nodeName.includes(macU) || nodeName.includes(macColon) || bluezAddr === macColon))
                return String(obj.id);

            if (!fallbackId && nodeName.startsWith('BLUEZ_OUTPUT.') &&
                ((aliasUpper && nodeDesc.includes(aliasUpper)) || nodeDesc.includes('BUDS')))
                fallbackId = String(obj.id);
        }

        return fallbackId;
    }

    async _routeDefaultPipeWireSink(info) {
        const cancellable = this._cancellable;

        for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt > 0) {
                const ok = await this._waitMs(750);
                if (!ok || cancellable.is_cancelled())
                    return;
            }

            const stdout = await execCommunicateAsync(['pw-dump'], cancellable);
            if (!stdout || cancellable.is_cancelled())
                return;

            const sinkId = this._findPipeWireSinkId(stdout, info);
            if (sinkId) {
                await execCheckAsync(['wpctl', 'set-default', sinkId], cancellable);
                return;
            }
        }
    }

    async _switchPipeWireProfile(info, mode) {
        const cancellable = this._cancellable;

        const macU = info.macUnderscore;
        if (!macU || macU === '00_00_00_00_00_00')
            return;

        const stdout = await execCommunicateAsync(['pw-dump'], cancellable);
        if (!stdout || cancellable.is_cancelled())
            return;

        let data;
        try {
            data = JSON.parse(stdout);
        } catch {
            return;
        }

        if (!Array.isArray(data))
            return;

        const prefix = mode === 'a2dp' ? 'a2dp-sink' : 'headset-head-unit';
        const upperMacU = macU.toUpperCase();
        const upperMacColon = upperMacU.replace(/_/g, ':');

        for (const obj of data) {
            if (!obj || obj.type !== 'PipeWire:Interface:Device' || !obj.info)
                continue;

            const props = obj.info.props;
            if (!props)
                continue;

            const devName = String(props['device.name'] || '').toUpperCase();
            const devAddr = String(props['api.bluez5.address'] || '').toUpperCase();
            if (!devName.includes(upperMacU) && devAddr !== upperMacColon)
                continue;

            const devId = String(obj.id);
            const params = obj.info.params;
            const enumProfiles = (params && Array.isArray(params.EnumProfile))
                ? params.EnumProfile
                : [];
            const candidates = enumProfiles.filter(
                p => p && String(p.name || '').startsWith(prefix) && p.available !== 'no'
            );
            const list = candidates.length > 0
                ? candidates
                : enumProfiles.filter(p => p && String(p.name || '').startsWith(prefix));
            if (list.length > 0) {
                const chosen = list.find(c => c.name === prefix) || list[0];
                await execCheckAsync(
                    ['wpctl', 'set-profile', devId, String(chosen.index)],
                    cancellable
                );
                if (cancellable.is_cancelled())
                    return;
                await this._routeDefaultPipeWireSink(info);
                break;
            }
        }
    }

    destroy() {
        for (const id of this._pendingTimeouts)
            GLib.Source.remove(id);
        this._pendingTimeouts.clear();
        this._pendingTimeouts = null;

        this._cancellable.cancel();
        this._cancellable = null;

        this._httpSession.abort();
        this._httpSession = null;

        if (this._dbusSubId) {
            Gio.DBus.system.signal_unsubscribe(this._dbusSubId);
            this._dbusSubId = null;
        }

        this._toggle.disconnectObject(this);
        this._settings.disconnectObject(this);

        this.quickSettingsItems.forEach(item => item.destroy());
        this._toggle = null;
        this._indicator = null;
        this._gicon = null;
        this._settings = null;
        this._extension = null;

        super.destroy();
    }
});
