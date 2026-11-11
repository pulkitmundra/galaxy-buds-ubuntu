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

function execCommunicateAsync(argv, cancellable) {
    if (!cancellable || cancellable.is_cancelled())
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

        const cancelId = cancellable.connect(() => {
            try {
                proc.force_exit();
            } catch (_e) {
            }
        });

        proc.communicate_utf8_async(null, cancellable, (source, res) => {
            if (cancelId && !cancellable.is_cancelled())
                cancellable.disconnect(cancelId);
            try {
                const [ok, stdout] = source.communicate_utf8_finish(res);
                resolve(ok && source.get_successful() ? stdout : null);
            } catch (_e) {
                resolve(null);
            }
        });
    });
}

function execCheckAsync(argv, cancellable) {
    if (!cancellable || cancellable.is_cancelled())
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

        const cancelId = cancellable.connect(() => {
            try {
                proc.force_exit();
            } catch (_e) {
            }
        });

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

        this._destroyed = false;
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
            () => this._extension?.openPreferences()
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
                if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
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
        if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
            return Promise.resolve(false);

        const cancellable = this._cancellable;
        return new Promise(resolve => {
            let timeoutId = null;
            let cancelId = 0;

            const finish = ok => {
                if (timeoutId !== null) {
                    this._pendingTimeouts?.delete(timeoutId);
                    timeoutId = null;
                }
                if (cancelId && !cancellable.is_cancelled()) {
                    cancellable.disconnect(cancelId);
                    cancelId = 0;
                }
                resolve(ok);
            };

            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                timeoutId = null;
                finish(!this._destroyed && Boolean(this._cancellable) && !this._cancellable.is_cancelled());
                return GLib.SOURCE_REMOVE;
            });
            this._pendingTimeouts.add(timeoutId);

            cancelId = cancellable.connect(() => {
                if (timeoutId !== null) {
                    GLib.Source.remove(timeoutId);
                    this._pendingTimeouts?.delete(timeoutId);
                    timeoutId = null;
                }
                cancelId = 0;
                finish(false);
            });
        });
    }

    _getConfiguredMacUnderscore() {
        if (this._destroyed || !this._settings)
            return null;
        const rawMac = this._settings.get_string('bud-mac').trim().toUpperCase();
        if (/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(rawMac) && rawMac !== 'AA:BB:CC:DD:EE:FF')
            return rawMac.replace(/:/g, '_');
        return null;
    }

    _getWebhookBase() {
        if (this._destroyed || !this._settings)
            return null;

        const raw = this._settings.get_string('macrodroid-webhook').trim();
        if (!raw || /YOUR-UUID/i.test(raw))
            return null;

        try {
            const uri = GLib.Uri.parse(raw, GLib.UriFlags.NONE);
            const scheme = uri.get_scheme()?.toLowerCase();
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
        } catch (_e) {
            return null;
        }
    }

    _discoverBuds(callback) {
        if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
            return;

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
                    if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
                        return;
                    const [objects] = reply.deep_unpack();
                    callback(parseBlueZManagedObjects(objects, configuredMacU));
                } catch (e) {
                    if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
                        return;
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
        if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
            return;

        this._discoverBuds(info => {
            if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
                return;
            if (!this._toggle || !this._indicator)
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
        if (this._destroyed || this._isBusy || !this._toggle)
            return;
        this._isBusy = true;

        this._toggle.subtitle = this._toggle.checked ? 'Disconnecting...' : 'Connecting...';
        this._executeAction('toggle', () => {
            this._isBusy = false;
        });
    }

    _executeAction(action, doneCallback = null) {
        if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled()) {
            if (doneCallback)
                doneCallback();
            return;
        }

        this._discoverBuds(async info => {
            try {
                if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
                    return;

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
            } finally {
                if (doneCallback)
                    doneCallback();
                if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
                    return;
                if (this._toggle)
                    this._refreshState();
            }
        });
    }

    async _connectBuds(info) {
        if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
            return;

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
            if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
                return;
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

        if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
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
                    this._cancellable,
                    6000
                );
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
            }
        }

        if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
            return;

        await this._routeDefaultPipeWireSink(info);
    }

    async _disconnectBuds(info) {
        if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
            return;

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

        if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
            return;

        const webhookUrl = this._getWebhookBase();
        if (webhookUrl && this._httpSession) {
            const msg = Soup.Message.new('GET', webhookUrl);
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

    _findPipeWireSinkId(stdout, info) {
        try {
            const data = JSON.parse(stdout);
            const macU = String(info.macUnderscore || '').toUpperCase();
            const macColon = macU.replace(/_/g, ':');
            const hasValidMac = Boolean(macU && macU !== '00_00_00_00_00_00');
            const aliasUpper = String(info.alias || '').toUpperCase();
            let fallbackId = null;

            for (const obj of data) {
                if (obj.type !== 'PipeWire:Interface:Node')
                    continue;
                const props = obj.info?.props;
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
        } catch (_e) {
            return null;
        }
    }

    async _routeDefaultPipeWireSink(info) {
        if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
            return;

        for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt > 0) {
                const ok = await this._waitMs(750);
                if (!ok || this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
                    return;
            }

            const stdout = await execCommunicateAsync(['pw-dump'], this._cancellable);
            if (!stdout || this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
                return;

            const sinkId = this._findPipeWireSinkId(stdout, info);
            if (sinkId) {
                await execCheckAsync(['wpctl', 'set-default', sinkId], this._cancellable);
                return;
            }
        }
    }

    async _switchPipeWireProfile(info, mode) {
        if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
            return;

        const macU = info.macUnderscore;
        if (!macU || macU === '00_00_00_00_00_00')
            return;

        const stdout = await execCommunicateAsync(['pw-dump'], this._cancellable);
        if (!stdout || this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
            return;

        try {
            const data = JSON.parse(stdout);
            const prefix = mode === 'a2dp' ? 'a2dp-sink' : 'headset-head-unit';
            const upperMacU = macU.toUpperCase();
            const upperMacColon = upperMacU.replace(/_/g, ':');

            for (const obj of data) {
                if (obj.type !== 'PipeWire:Interface:Device')
                    continue;
                const devName = String(obj.info?.props?.['device.name'] || '').toUpperCase();
                const devAddr = String(obj.info?.props?.['api.bluez5.address'] || '').toUpperCase();
                if (!devName.includes(upperMacU) && devAddr !== upperMacColon)
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
                    await execCheckAsync(
                        ['wpctl', 'set-profile', devId, String(chosen.index)],
                        this._cancellable
                    );
                    if (this._destroyed || !this._cancellable || this._cancellable.is_cancelled())
                        return;
                    await this._routeDefaultPipeWireSink(info);
                    break;
                }
            }
        } catch (_e) {
        }
    }

    destroy() {
        this._destroyed = true;

        if (this._pendingTimeouts) {
            for (const id of this._pendingTimeouts)
                GLib.Source.remove(id);
            this._pendingTimeouts.clear();
            this._pendingTimeouts = null;
        }

        this._cancellable?.cancel();
        this._cancellable = null;

        this._httpSession?.abort();
        this._httpSession = null;

        if (this._dbusSubId) {
            Gio.DBus.system.signal_unsubscribe(this._dbusSubId);
            this._dbusSubId = null;
        }

        this._toggle?.disconnectObject(this);
        this._settings?.disconnectObject(this);
        this._settings = null;

        this.quickSettingsItems.forEach(item => item.destroy());
        this._toggle = null;
        this._indicator = null;
        this._extension = null;

        super.destroy();
    }
});
