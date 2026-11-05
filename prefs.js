import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const GITHUB_REPO_URL = 'https://github.com/pulkitmundra/galaxy-buds-ubuntu';
const GITHUB_ISSUES_URL = 'https://github.com/pulkitmundra/galaxy-buds-ubuntu/issues';

function cleanModelName(rawName) {
    if (!rawName)
        return 'Samsung Galaxy Buds';
    return rawName.replace(/\s*\([0-9A-Fa-f]{4}\)\s*$/, '').trim() || rawName;
}

function scanPairedGalaxyBudsAsync(cancellable, callback) {
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
            const results = [];
            const fallbackHeadsets = [];
            try {
                const reply = conn.call_finish(res);
                const [objects] = reply.deep_unpack();
                for (const [, ifaces] of Object.entries(objects)) {
                    const dev = ifaces['org.bluez.Device1'];
                    if (!dev)
                        continue;

                    const address = String(dev.Address?.deep_unpack() ?? '').toUpperCase();
                    const name = String(dev.Name?.deep_unpack() ?? '');
                    const alias = String(dev.Alias?.deep_unpack() ?? name);
                    const paired = Boolean(dev.Paired?.deep_unpack() ?? false);
                    const connected = Boolean(dev.Connected?.deep_unpack() ?? false);
                    const icon = String(dev.Icon?.deep_unpack() ?? '');

                    const item = {
                        address,
                        cleanName: cleanModelName(alias || name),
                        paired,
                        connected,
                    };

                    if (/buds/i.test(name) || /buds/i.test(alias))
                        results.push(item);
                    else if (paired && /audio|headset|headphones/i.test(icon))
                        fallbackHeadsets.push(item);
                }
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
            }
            callback(results.length > 0 ? results : fallbackHeadsets);
        }
    );
}

export default class BudsQuickTogglePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const cancellable = new Gio.Cancellable();
        window.connect('close-request', () => cancellable.cancel());

        window.set_default_size(680, 580);
        window.set_search_enabled(false);

        const configPage = new Adw.PreferencesPage({
            title: 'Configuration',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(configPage);

        const deviceGroup = new Adw.PreferencesGroup({
            title: 'Samsung Galaxy Buds Bluetooth Device',
            description: 'Leave MAC empty to auto-detect paired Galaxy Buds, or specify a fixed device MAC.',
        });
        configPage.add(deviceGroup);

        const macRow = new Adw.EntryRow({
            title: 'Earbuds Bluetooth MAC (XX:XX:XX:XX:XX:XX)',
        });
        settings.bind('bud-mac', macRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        deviceGroup.add(macRow);

        const detectRow = new Adw.ActionRow({
            title: 'Auto-Detect Paired Earbuds',
            subtitle: 'Scan BlueZ for paired Samsung Galaxy Buds and fill the MAC address.',
        });
        const detectBtn = new Gtk.Button({
            label: 'Scan BlueZ',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        detectBtn.connect('clicked', () => {
            scanPairedGalaxyBudsAsync(cancellable, paired => {
                if (paired.length > 0) {
                    const best = paired.find(d => d.connected) || paired[0];
                    settings.set_string('bud-mac', best.address);
                    detectRow.set_subtitle(`Detected: ${best.cleanName} (${best.address})`);
                    window.add_toast(new Adw.Toast({
                        title: `Detected ${best.cleanName} (${best.address})`,
                    }));
                } else {
                    detectRow.set_subtitle('No paired Galaxy Buds found in BlueZ.');
                    window.add_toast(new Adw.Toast({
                        title: 'No paired Galaxy Buds found in BlueZ',
                    }));
                }
            });
        });
        detectRow.add_suffix(detectBtn);
        deviceGroup.add(detectRow);

        const webhookGroup = new Adw.PreferencesGroup({
            title: 'Android Auto-Reconnect Webhook (MacroDroid)',
            description: 'Optional webhook triggered on Ubuntu disconnect so your Android phone reclaims the earbuds.',
        });
        configPage.add(webhookGroup);

        const webhookRow = new Adw.EntryRow({
            title: 'MacroDroid Base URL (https://trigger.macrodroid.com/YOUR-UUID)',
        });
        settings.bind('macrodroid-webhook', webhookRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        webhookGroup.add(webhookRow);

        const guidePage = new Adw.PreferencesPage({
            title: 'Android Setup',
            icon_name: 'phone-symbolic',
        });
        window.add(guidePage);

        const overviewGroup = new Adw.PreferencesGroup({
            title: 'How Ubuntu and Android Switching Works',
        });
        guidePage.add(overviewGroup);

        overviewGroup.add(new Adw.ActionRow({
            title: '1. Pulling Audio from Android to Ubuntu',
            subtitle:
                'Galaxy Buds keep a passive Classic Bluetooth (BR/EDR) listener open ' +
                'while connected to a phone. Clicking Connect in Quick Settings connects ' +
                'A2DP, AVRCP, and HFP profiles over BlueZ D-Bus.',
        }));

        overviewGroup.add(new Adw.ActionRow({
            title: '2. Releasing Audio from Ubuntu to Android',
            subtitle:
                'When Ubuntu disconnects Bluetooth, firing a MacroDroid webhook tells ' +
                'your Android phone to immediately reconnect to your Galaxy Buds.',
        }));

        const stepsGroup = new Adw.PreferencesGroup({
            title: 'MacroDroid Setup Steps on Android',
        });
        guidePage.add(stepsGroup);

        stepsGroup.add(new Adw.ActionRow({
            title: 'Step 1 - Create Macro',
            subtitle: 'Open MacroDroid on Android, tap Add Macro, and name it "Connect Buds".',
        }));

        stepsGroup.add(new Adw.ActionRow({
            title: 'Step 2 - Add Webhook Trigger',
            subtitle:
                'Choose Triggers -> Connectivity -> Webhook (Url) with identifier "buds", ' +
                'then paste the base URL in the Configuration tab.',
        }));

        stepsGroup.add(new Adw.ActionRow({
            title: 'Step 3 - Add Bluetooth Connect Actions',
            subtitle:
                'Add Actions -> Connectivity -> Configure Bluetooth -> Connect to Audio Device ' +
                '(select your Galaxy Buds), followed by a 2-second wait and a second ' +
                'Connect to Audio Device action.',
        }));

        stepsGroup.add(new Adw.ActionRow({
            title: 'Step 4 - Unrestricted Battery Usage',
            subtitle:
                'In Android Settings -> Apps -> MacroDroid -> Battery, select Unrestricted ' +
                'so the webhook triggers even when the phone screen is locked.',
        }));

        const linksGroup = new Adw.PreferencesGroup({
            title: 'Project Links',
        });
        guidePage.add(linksGroup);

        const addLinkRow = (title, subtitle, buttonLabel, uri) => {
            const row = new Adw.ActionRow({title, subtitle});
            const btn = new Gtk.Button({
                label: buttonLabel,
                valign: Gtk.Align.CENTER,
            });
            btn.connect('clicked', () => {
                Gio.AppInfo.launch_default_for_uri(uri, null);
            });
            row.add_suffix(btn);
            linksGroup.add(row);
        };

        addLinkRow(
            'Official GNOME Extensions Store Page',
            'https://extensions.gnome.org/extension/11611/samsung-galaxy-buds-quick-settings-switcher/',
            'Open Store Page',
            'https://extensions.gnome.org/extension/11611/samsung-galaxy-buds-quick-settings-switcher/'
        );
        addLinkRow(
            'GitHub Repository and Documentation',
            GITHUB_REPO_URL,
            'Open Repository',
            GITHUB_REPO_URL
        );
        addLinkRow(
            'Report an Issue or Request a Feature',
            GITHUB_ISSUES_URL,
            'Open Issues',
            GITHUB_ISSUES_URL
        );
    }
}
