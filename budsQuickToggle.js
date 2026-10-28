import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const QuickSettingsMenu = Main.panel.statusArea.quickSettings;
const HOME_DIR = GLib.get_home_dir();

function getBudMacUnderscore() {
    try {
        const envPath = `${HOME_DIR}/.config/buds-switch.env`;
        const [ok, bytes] = GLib.file_get_contents(envPath);
        if (ok) {
            const text = new TextDecoder().decode(bytes);
            const match = text.match(/^\s*BUD_MAC\s*=\s*["']?([0-9A-Fa-f:]{17})["']?/m);
            if (match && match[1]) {
                return match[1].toUpperCase().replace(/:/g, '_');
            }
        }
    } catch (_e) {
        // Fallback below
    }
    return '00_00_00_00_00_00';
}

function getBudPrimaryPath() {
    return `/org/bluez/hci0/dev_${getBudMacUnderscore()}`;
}
const ICON_PATH = `${HOME_DIR}/.local/share/icons/earbuds-symbolic.svg`;
const SWITCH_SCRIPT = `${HOME_DIR}/.local/bin/buds-switch`;
const MANAGER_BIN = `${HOME_DIR}/.local/opt/galaxybudsclient/GalaxyBudsClient`;

const BudsMenuToggle = GObject.registerClass(
class BudsMenuToggle extends QuickSettings.QuickMenuToggle {
    _init() {
        const gicon = Gio.icon_new_for_string(ICON_PATH);
        super._init({
            title: 'Buds3 Pro',
            subtitle: 'Disconnected',
            gicon,
            toggleMode: false,
        });

        this.menu.setHeader(gicon, 'Galaxy Buds3 Pro', 'Seamless Ubuntu / Android Switcher');

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

        this._managerItem = new PopupMenu.PopupMenuItem('Open Galaxy Buds Manager');
        this._managerItem.connect('activate', () => {
            QuickSettingsMenu.menu.close();
            this._runCommand([MANAGER_BIN]);
        });
        this.menu.addMenuItem(this._managerItem);
    }

    _runCommand(argv) {
        try {
            const proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.NONE
            );
            proc.wait_async(null, null);
        } catch (e) {
            logError(e, 'Buds3Pro failed to run command');
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
            'org.bluez.Device1',
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, objectPath) => {
                if (objectPath && objectPath.endsWith(`/dev_${getBudMacUnderscore()}`)) {
                    this._lastActivePath = objectPath;
                    this._refreshState();
                }
            }
        );

        this._refreshState();
    }

    _getDeviceConnected(objectPath) {
        try {
            const reply = Gio.DBus.system.call_sync(
                'org.bluez',
                objectPath,
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.bluez.Device1', 'Connected']),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                1000,
                null
            );
            const [val] = reply.deep_unpack();
            return val.deep_unpack() === true;
        } catch (_e) {
            return false;
        }
    }

    _resolvePath() {
        const suffix = `/dev_${getBudMacUnderscore()}`;
        if (this._lastActivePath && this._lastActivePath.endsWith(suffix)) {
            return this._lastActivePath;
        }
        return getBudPrimaryPath();
    }

    _refreshState() {
        const connected = this._getDeviceConnected(this._resolvePath());
        this._toggle.checked = connected;
        this._indicator.visible = connected;
        this._toggle.subtitle = connected ? 'Connected' : 'Disconnected';
    }

    _onToggleClicked() {
        if (this._isBusy) return;
        this._isBusy = true;

        const connected = this._getDeviceConnected(this._resolvePath());
        this._toggle.subtitle = connected ? 'Disconnecting...' : 'Connecting...';

        try {
            const proc = Gio.Subprocess.new(
                [SWITCH_SCRIPT, 'toggle'],
                Gio.SubprocessFlags.NONE
            );
            proc.wait_async(null, () => {
                this._isBusy = false;
                this._refreshState();
            });
        } catch (e) {
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
