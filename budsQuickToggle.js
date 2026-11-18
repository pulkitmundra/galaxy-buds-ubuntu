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

const LID_DISCONNECT_TIMEOUT_MS = 4500;
const LID_POST_DISCONNECT_SETTLE_MS = 600;
const LID_WEBHOOK_TIMEOUT_MS = 4000;
const LID_FAILSAFE_RELEASE_MS = 10000;

function closeFdSafely(fd) {
    if (typeof fd !== 'number' || fd < 0)
        return;

    try {
        GLib.close(fd);
    } catch (_e) {
    }
}

function createPowerSettings() {
    const schemaSource = Gio.SettingsSchemaSource.get_default();
    if (!schemaSource)
        return null;

    const schema = schemaSource.lookup('org.gnome.settings-daemon.plugins.power', true);
    if (!schema || !schema.has_key('lid-close-suspend-with-external-monitor'))
        return null;

    return new Gio.Settings({settings_schema: schema});
}

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

        this._settingsSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._settingsSeparator);

        this._settingsItem = new PopupMenu.PopupMenuItem('Settings & Android Setup Guide');
        this._settingsItem.connect('activate', () => {
            if (!Main.sessionMode.allowSettings)
                return;
            Main.panel.statusArea.quickSettings.menu.close();
            onOpenPreferences();
        });
        this.menu.addMenuItem(this._settingsItem);
        this.syncSessionMode();
    }

    syncSessionMode() {
        const canOpenSettings = Boolean(Main.sessionMode.allowSettings);
        this._settingsSeparator.visible = canOpenSettings;
        this._settingsItem.visible = canOpenSettings;
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
        this._powerSettings = createPowerSettings();
        this._cancellable = new Gio.Cancellable();
        this._httpSession = new Soup.Session({timeout: 5});
        this._isBusy = false;

        this._cachedDeviceInfo = null;
        this._lidInhibitFd = -1;
        this._lidInhibitPending = false;
        this._wantLidInhibit = false;
        this._lidIsClosed = false;
        this._lidHandoffInFlight = false;
        this._lidFailSafeTimerId = 0;

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
        this._settings.connectObject('changed', () => {
            this._updateLidInhibitorState();
            this._refreshState();
        }, this);

        this._sessionModeSubId = Main.sessionMode.connect('updated', () => {
            if (this._toggle)
                this._toggle.syncSessionMode();
        });

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

        this._loginPropSubId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1',
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager',
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _objectPath, _iface, _signalName, params) => {
                if (cancellable.is_cancelled())
                    return;
                const [, changedProps] = params.deep_unpack();
                if (changedProps && Object.prototype.hasOwnProperty.call(changedProps, 'LidClosed'))
                    this._onLidStateChanged(Boolean(unpackProp(changedProps, 'LidClosed', false)));
            }
        );

        this._upowerPropSubId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.UPower',
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            '/org/freedesktop/UPower',
            'org.freedesktop.UPower',
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _objectPath, _iface, _signalName, params) => {
                if (cancellable.is_cancelled())
                    return;
                const [, changedProps] = params.deep_unpack();
                if (changedProps && Object.prototype.hasOwnProperty.call(changedProps, 'LidIsClosed'))
                    this._onLidStateChanged(Boolean(unpackProp(changedProps, 'LidIsClosed', false)));
            }
        );

        this._sleepSubId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1',
            'org.freedesktop.login1.Manager',
            'PrepareForSleep',
            '/org/freedesktop/login1',
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _objectPath, _iface, _signalName, params) => {
                if (cancellable.is_cancelled())
                    return;
                const [goingToSleep] = params.deep_unpack();
                if (!goingToSleep) {
                    if (this._httpSession)
                        this._httpSession.abort();
                    this._syncInitialLidState();
                    this._refreshState();
                } else if (
                    !this._lidIsClosed &&
                    !this._lidHandoffInFlight &&
                    this._settings.get_boolean('lid-close-handoff') &&
                    this._cachedDeviceInfo &&
                    this._cachedDeviceInfo.connected
                ) {
                    this._disconnectBluezDevice(this._cachedDeviceInfo, 800);
                }
            }
        );

        this._syncInitialLidState();
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

            this._cachedDeviceInfo = info;
            this._updateLidInhibitorState();

            const {fullTitle, pillTitle} = formatModelTitles(info.alias);

            this._toggle.checked = info.connected;
            this._indicator.visible = info.connected;

            let subtitle = 'Disconnected';
            if (info.connected)
                subtitle = info.battery !== null ? `Connected - ${info.battery}%` : 'Connected';

            this._toggle.updateDeviceLabels(fullTitle, pillTitle, subtitle);
        });
    }

    _syncInitialLidState() {
        const cancellable = this._cancellable;
        Gio.DBus.system.call(
            'org.freedesktop.UPower',
            '/org/freedesktop/UPower',
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.freedesktop.UPower', 'LidIsClosed']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            2000,
            cancellable,
            (conn, res) => {
                let reply;
                try {
                    reply = conn.call_finish(res);
                } catch (_e) {
                    return;
                }

                if (cancellable.is_cancelled() || this._lidHandoffInFlight)
                    return;

                const [innerVariant] = reply.deep_unpack();
                this._lidIsClosed = Boolean(innerVariant.deep_unpack());
                this._updateLidInhibitorState();
            }
        );
    }

    _isClamshellExternalMonitorMode() {
        const monitors = Main.layoutManager.monitors;
        if (!Array.isArray(monitors) || monitors.length <= 1)
            return false;

        if (!this._powerSettings)
            return true;

        return !this._powerSettings.get_boolean('lid-close-suspend-with-external-monitor');
    }

    _clearLidFailSafeTimer() {
        const timerId = this._lidFailSafeTimerId;
        if (timerId !== 0) {
            this._lidFailSafeTimerId = 0;
            if (this._pendingTimeouts && this._pendingTimeouts.delete(timerId))
                GLib.Source.remove(timerId);
        }
    }

    _releaseLidInhibitor() {
        const fd = this._lidInhibitFd;
        if (fd >= 0) {
            this._lidInhibitFd = -1;
            closeFdSafely(fd);
        }
    }

    _updateLidInhibitorState() {
        if (this._lidHandoffInFlight)
            return;

        const shouldHold =
            this._settings.get_boolean('lid-close-handoff') &&
            !this._lidIsClosed &&
            Boolean(this._cachedDeviceInfo && this._cachedDeviceInfo.connected);

        this._wantLidInhibit = shouldHold;

        if (!shouldHold) {
            this._releaseLidInhibitor();
            return;
        }

        if (this._lidInhibitFd >= 0 || this._lidInhibitPending)
            return;

        this._lidInhibitPending = true;
        const cancellable = this._cancellable;

        Gio.DBus.system.call_with_unix_fd_list(
            'org.freedesktop.login1',
            '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager',
            'Inhibit',
            new GLib.Variant('(ssss)', [
                'handle-lid-switch',
                'Samsung Galaxy Buds Switcher',
                'Handing off earbuds to Android before sleep',
                'block',
            ]),
            new GLib.VariantType('(h)'),
            Gio.DBusCallFlags.NONE,
            2000,
            null,
            cancellable,
            (conn, res) => {
                let fdList;
                try {
                    [, fdList] = conn.call_with_unix_fd_list_finish(res);
                } catch (_e) {
                    if (!cancellable.is_cancelled())
                        this._lidInhibitPending = false;
                    return;
                }

                const fds = fdList ? fdList.steal_fds() : [];
                const fd = fds.length > 0 ? fds[0] : -1;
                const keepFd =
                    !cancellable.is_cancelled() &&
                    (this._wantLidInhibit || this._lidHandoffInFlight) &&
                    this._lidInhibitFd < 0;

                if (!keepFd) {
                    closeFdSafely(fd);
                    if (!cancellable.is_cancelled())
                        this._lidInhibitPending = false;
                    return;
                }

                this._lidInhibitPending = false;
                this._lidInhibitFd = fd;
            }
        );
    }

    _onLidStateChanged(isClosed) {
        if (this._lidIsClosed === isClosed)
            return;

        this._lidIsClosed = isClosed;

        if (!isClosed) {
            this._updateLidInhibitorState();
            this._refreshState();
            return;
        }

        this._wantLidInhibit = false;

        const shouldHandoff =
            this._settings.get_boolean('lid-close-handoff') &&
            !this._isClamshellExternalMonitorMode() &&
            Boolean(this._cachedDeviceInfo && this._cachedDeviceInfo.connected);

        if (!shouldHandoff) {
            this._releaseLidInhibitor();
            return;
        }

        this._handleLidClosed();
    }

    async _handleLidClosed() {
        if (this._lidHandoffInFlight)
            return;

        const cancellable = this._cancellable;
        const info = this._cachedDeviceInfo;
        if (!info || !cancellable || cancellable.is_cancelled()) {
            this._releaseLidInhibitor();
            return;
        }

        this._lidHandoffInFlight = true;
        this._clearLidFailSafeTimer();

        const pendingTimeouts = this._pendingTimeouts;
        const failSafeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LID_FAILSAFE_RELEASE_MS, () => {
            pendingTimeouts.delete(failSafeId);
            if (this._lidFailSafeTimerId === failSafeId)
                this._lidFailSafeTimerId = 0;
            this._lidHandoffInFlight = false;
            this._releaseLidInhibitor();
            return GLib.SOURCE_REMOVE;
        });
        this._lidFailSafeTimerId = failSafeId;
        pendingTimeouts.add(failSafeId);

        try {
            await this._disconnectBluezDevice(info, LID_DISCONNECT_TIMEOUT_MS);
            if (cancellable.is_cancelled())
                return;

            if (this._lidIsClosed && !this._isClamshellExternalMonitorMode()) {
                const settled = await this._waitMs(LID_POST_DISCONNECT_SETTLE_MS);
                if (settled && !cancellable.is_cancelled() &&
                    this._lidIsClosed && !this._isClamshellExternalMonitorMode()) {
                    const ok = await this._sendWebhookWithRetry(
                        LID_WEBHOOK_TIMEOUT_MS,
                        () => !this._lidIsClosed || this._isClamshellExternalMonitorMode()
                    );
                    if (!ok && !cancellable.is_cancelled() && this._lidIsClosed)
                        console.warn('[GalaxyBuds] Lid handoff webhook did not succeed before timeout');
                }
            }
        } finally {
            if (this._cancellable === cancellable && !cancellable.is_cancelled()) {
                this._clearLidFailSafeTimer();
                this._lidHandoffInFlight = false;
                if (this._lidIsClosed)
                    this._releaseLidInhibitor();
                else
                    this._updateLidInhibitorState();
                this._refreshState();
            }
        }
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

    async _isBluezConnected(objectPath, timeoutMs = 1000) {
        const cancellable = this._cancellable;
        if (!objectPath || !cancellable || cancellable.is_cancelled())
            return false;

        try {
            const reply = await dbusCallAsync(
                Gio.DBus.system,
                'org.bluez',
                objectPath,
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.bluez.Device1', 'Connected']),
                cancellable,
                timeoutMs
            );
            const [innerVariant] = reply.deep_unpack();
            return Boolean(innerVariant.deep_unpack());
        } catch (_e) {
            return false;
        }
    }

    async _disconnectBluezDevice(info, timeoutMs) {
        const cancellable = this._cancellable;
        if (!info || !cancellable || cancellable.is_cancelled())
            return false;

        const deadlineUs = GLib.get_monotonic_time() + timeoutMs * 1000;

        try {
            await dbusCallAsync(
                Gio.DBus.system,
                'org.bluez',
                info.objectPath,
                'org.bluez.Device1',
                'Disconnect',
                null,
                cancellable,
                timeoutMs
            );
        } catch (_e) {
            if (cancellable.is_cancelled())
                return false;
        }

        while (!cancellable.is_cancelled()) {
            const remainingMs = Math.floor((deadlineUs - GLib.get_monotonic_time()) / 1000);
            if (remainingMs <= 0)
                break;

            const stillConnected = await this._isBluezConnected(
                info.objectPath,
                Math.min(1000, Math.max(200, remainingMs))
            );
            if (!stillConnected)
                return true;

            const ok = await this._waitMs(Math.min(200, remainingMs));
            if (!ok)
                return false;
        }

        return false;
    }

    _sendWebhookWithTimeout(timeoutMs) {
        const parentCancellable = this._cancellable;
        if (!parentCancellable || parentCancellable.is_cancelled() || !this._httpSession)
            return Promise.resolve(false);

        const webhookUrl = this._getWebhookBase();
        if (!webhookUrl)
            return Promise.resolve(false);

        const msg = Soup.Message.new('GET', webhookUrl);
        if (!msg)
            return Promise.resolve(false);

        if (typeof msg.set_force_http1 === 'function')
            msg.set_force_http1(true);

        const pendingTimeouts = this._pendingTimeouts;
        const reqCancellable = new Gio.Cancellable();
        const parentCancelId = parentCancellable.connect(() => reqCancellable.cancel());

        return new Promise(resolve => {
            let timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                pendingTimeouts.delete(timerId);
                timerId = 0;
                reqCancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });
            pendingTimeouts.add(timerId);

            this._httpSession.send_and_read_async(
                msg,
                GLib.PRIORITY_DEFAULT,
                reqCancellable,
                (session, res) => {
                    if (timerId !== 0) {
                        if (pendingTimeouts.delete(timerId))
                            GLib.Source.remove(timerId);
                        timerId = 0;
                    }
                    if (parentCancelId && !parentCancellable.is_cancelled())
                        parentCancellable.disconnect(parentCancelId);

                    let ok = false;
                    try {
                        session.send_and_read_finish(res);
                        const status = msg.get_status();
                        ok = status >= 200 && status < 400;
                    } catch (_e) {
                        ok = false;
                    }
                    resolve(ok);
                }
            );
        });
    }

    async _sendWebhookWithRetry(timeoutMs, shouldAbort = null) {
        const parentCancellable = this._cancellable;
        if (!parentCancellable || parentCancellable.is_cancelled())
            return false;

        const firstOk = await this._sendWebhookWithTimeout(timeoutMs);
        if (firstOk)
            return true;

        if (parentCancellable.is_cancelled() || (shouldAbort && shouldAbort()))
            return false;

        const waited = await this._waitMs(300);
        if (!waited || parentCancellable.is_cancelled() || (shouldAbort && shouldAbort()))
            return false;

        return this._sendWebhookWithTimeout(Math.min(3000, timeoutMs));
    }

    async _triggerPostDisconnectWebhook() {
        const cancellable = this._cancellable;
        if (!cancellable || cancellable.is_cancelled())
            return;

        const settled = await this._waitMs(LID_POST_DISCONNECT_SETTLE_MS);
        if (!settled || cancellable.is_cancelled())
            return;

        await this._sendWebhookWithRetry(5000);
    }

    async _disconnectBuds(info) {
        const cancellable = this._cancellable;

        if (!this._lidHandoffInFlight) {
            this._wantLidInhibit = false;
            this._releaseLidInhibitor();
        }

        await this._disconnectBluezDevice(info, 4500);
        if (!cancellable || cancellable.is_cancelled())
            return;

        this._triggerPostDisconnectWebhook().catch(() => {});
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
        this._wantLidInhibit = false;
        this._lidHandoffInFlight = false;
        this._lidInhibitPending = false;
        this._lidFailSafeTimerId = 0;
        this._releaseLidInhibitor();

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

        if (this._loginPropSubId) {
            Gio.DBus.system.signal_unsubscribe(this._loginPropSubId);
            this._loginPropSubId = null;
        }

        if (this._upowerPropSubId) {
            Gio.DBus.system.signal_unsubscribe(this._upowerPropSubId);
            this._upowerPropSubId = null;
        }

        if (this._sleepSubId) {
            Gio.DBus.system.signal_unsubscribe(this._sleepSubId);
            this._sleepSubId = null;
        }

        if (this._sessionModeSubId) {
            Main.sessionMode.disconnect(this._sessionModeSubId);
            this._sessionModeSubId = 0;
        }

        this._toggle.disconnectObject(this);
        this._settings.disconnectObject(this);

        this.quickSettingsItems.forEach(item => item.destroy());
        this._toggle = null;
        this._indicator = null;
        this._gicon = null;
        this._powerSettings = null;
        this._cachedDeviceInfo = null;
        this._settings = null;
        this._extension = null;

        super.destroy();
    }
});
