import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const HOME_DIR = GLib.get_home_dir();
const ENV_SYMLINK_PATH = `${HOME_DIR}/.config/buds-switch.env`;
const SWITCH_SCRIPT = `${HOME_DIR}/.local/bin/buds-switch`;
const MANAGER_BIN = `${HOME_DIR}/.local/opt/galaxybudsclient/GalaxyBudsClient`;

const BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/pulkitmundra';
const GITHUB_SPONSORS_URL = 'https://github.com/sponsors/pulkitmundra';
const GITHUB_REPO_URL = 'https://github.com/pulkitmundra/galaxy-buds-ubuntu';
const GITHUB_ISSUES_URL = 'https://github.com/pulkitmundra/galaxy-buds-ubuntu/issues';
const PORTFOLIO_URL = 'https://pulkit-mundra-portfolio.vercel.app';

const AUTO_ENABLE_CMD =
    "sudo sed -i 's/^#*AutoEnable\\s*=.*/AutoEnable=false/' /etc/bluetooth/main.conf && sudo systemctl restart bluetooth";

function esc(text) {
    return GLib.markup_escape_text(String(text ?? ''), -1);
}

function createGroup(title, description) {
    return new Adw.PreferencesGroup({
        title: esc(title),
        description: esc(description),
    });
}

function createActionRow(title, subtitle = '') {
    return new Adw.ActionRow({
        title: esc(title),
        subtitle: esc(subtitle),
        use_markup: false,
    });
}

function resolveEnvFilePath() {
    try {
        if (GLib.file_test(ENV_SYMLINK_PATH, GLib.FileTest.IS_SYMLINK)) {
            const target = GLib.file_read_link(ENV_SYMLINK_PATH);
            if (target) {
                if (GLib.path_is_absolute(target)) {
                    return target;
                }
                const dir = GLib.path_get_dirname(ENV_SYMLINK_PATH);
                return GLib.build_filenamev([dir, target]);
            }
        }
    } catch (_e) {
        // Fallback to symlink path
    }
    return ENV_SYMLINK_PATH;
}

export function readEnvConfig() {
    const config = {
        budMac: '',
        webhookBase: '',
        envPath: resolveEnvFilePath(),
    };
    try {
        const [ok, bytes] = GLib.file_get_contents(ENV_SYMLINK_PATH);
        if (ok) {
            const text = new TextDecoder().decode(bytes);
            const macMatch = text.match(/^\s*BUD_MAC\s*=\s*["']?([^"'\s#]+)["']?/m);
            if (macMatch && macMatch[1] && macMatch[1].toUpperCase() !== 'AA:BB:CC:DD:EE:FF') {
                config.budMac = macMatch[1].toUpperCase();
            }
            const hookMatch = text.match(/^\s*MACRODROID_WEBHOOK_BASE\s*=\s*["']?([^"'\s#]*)["']?/m);
            if (hookMatch && hookMatch[1]) {
                config.webhookBase = hookMatch[1].trim();
            }
        }
    } catch (_e) {
        // Ignore if file doesn't exist yet
    }
    return config;
}

export function saveEnvConfig(budMacInput, webhookInput) {
    const cleanMac = (budMacInput || '').trim().toUpperCase();
    let cleanWebhook = (webhookInput || '').trim();
    cleanWebhook = cleanWebhook.replace(/\/+$/, '').replace(/\/buds$/i, '');

    if (cleanMac && !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(cleanMac)) {
        return {
            ok: false,
            message: 'Invalid Bluetooth MAC format. Expected XX:XX:XX:XX:XX:XX (e.g. A0:B0:BD:4A:12:00).',
        };
    }

    if (cleanWebhook && !/^https?:\/\/[A-Za-z0-9._:/-]+$/.test(cleanWebhook)) {
        return {
            ok: false,
            message: 'Invalid MacroDroid Webhook URL format. Expected https://trigger.macrodroid.com/YOUR-UUID.',
        };
    }

    const content = [
        '# Samsung Galaxy Buds Bluetooth MAC Address (Buds3 Pro, Buds2 Pro, Buds FE, Buds2, Buds Pro, Buds Live, Buds+)',
        `BUD_MAC="${cleanMac || 'AA:BB:CC:DD:EE:FF'}"`,
        '',
        '# MacroDroid Webhook Base URL (without trailing /buds)',
        '# Leave empty if you only want Ubuntu disconnect without auto-triggering Android reconnect',
        `MACRODROID_WEBHOOK_BASE="${cleanWebhook}"`,
        '',
    ].join('\n');

    try {
        const targetPath = resolveEnvFilePath();
        const parentDir = GLib.path_get_dirname(targetPath);
        GLib.mkdir_with_parents(parentDir, 0o700);
        GLib.file_set_contents(targetPath, content);
        GLib.chmod(targetPath, 0o600);
        return {
            ok: true,
            budMac: cleanMac,
            webhookBase: cleanWebhook,
            targetPath,
            message: `Saved configuration to ${targetPath} (permissions 0600).`,
        };
    } catch (e) {
        return {
            ok: false,
            message: `Failed to save configuration: ${e.message}`,
        };
    }
}

export function cleanModelName(rawName) {
    if (!rawName) return 'Samsung Galaxy Buds';
    return rawName.replace(/\s*\([0-9A-Fa-f]{4}\)\s*$/, '').trim() || rawName;
}

export function scanPairedGalaxyBuds() {
    const results = [];
    const fallbackHeadsets = [];
    try {
        const reply = Gio.DBus.system.call_sync(
            'org.bluez',
            '/',
            'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects',
            null,
            new GLib.VariantType('(a{oa{sa{sv}}})'),
            Gio.DBusCallFlags.NONE,
            2000,
            null
        );
        const [objects] = reply.deep_unpack();
        for (const [objPath, ifaces] of Object.entries(objects)) {
            const dev = ifaces['org.bluez.Device1'];
            if (!dev) continue;

            const unpackProp = (dict, key, fallback = null) => {
                if (!dict || !(key in dict)) return fallback;
                const v = dict[key];
                return v && typeof v.deep_unpack === 'function' ? v.deep_unpack() : v;
            };

            const address = String(unpackProp(dev, 'Address', '')).toUpperCase();
            const name = String(unpackProp(dev, 'Name', '') || '');
            const alias = String(unpackProp(dev, 'Alias', '') || name);
            const paired = Boolean(unpackProp(dev, 'Paired', false));
            const connected = Boolean(unpackProp(dev, 'Connected', false));
            const icon = String(unpackProp(dev, 'Icon', '') || '');
            const adapter = String(unpackProp(dev, 'Adapter', '/org/bluez/hci0'));

            let battery = null;
            const battIface = ifaces['org.bluez.Battery1'];
            if (battIface) {
                const pct = unpackProp(battIface, 'Percentage', null);
                if (typeof pct === 'number') {
                    battery = pct;
                }
            }

            const item = {
                objectPath: objPath,
                address,
                name,
                alias,
                cleanName: cleanModelName(alias || name),
                paired,
                connected,
                icon,
                adapter,
                battery,
            };

            if (/buds/i.test(name) || /buds/i.test(alias)) {
                results.push(item);
            } else if (paired && (icon.includes('audio') || icon.includes('headset') || icon.includes('headphones'))) {
                fallbackHeadsets.push(item);
            }
        }
    } catch (_e) {
        // Ignore D-Bus errors
    }
    return results.length > 0 ? results : fallbackHeadsets;
}

function getActivePipeWireProfile(macUnderscore) {
    if (!macUnderscore) return 'Unconfigured';
    try {
        const proc = Gio.Subprocess.new(
            ['pw-dump'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        const [ok, stdoutBytes] = proc.communicate_utf8(null, null);
        if (!ok || !stdoutBytes) return 'Inactive (Disconnected)';
        const data = JSON.parse(stdoutBytes);
        for (const obj of data) {
            if (obj.type !== 'PipeWire:Interface:Device') continue;
            const props = obj.info?.props || {};
            const devName = String(props['device.name'] || '');
            if (devName.toUpperCase().includes(macUnderscore.toUpperCase())) {
                const activeProfiles = obj.info?.params?.Profile || [];
                if (activeProfiles.length > 0) {
                    const prof = activeProfiles[0];
                    const pName = String(prof.name || '');
                    const pDesc = String(prof.description || pName);
                    if (pName.startsWith('a2dp-sink')) {
                        return `High-Fidelity Music (A2DP - ${pDesc})`;
                    }
                    if (pName.startsWith('headset-head-unit')) {
                        return `Call + Microphone (HFP/HSP - ${pDesc})`;
                    }
                    return pDesc;
                }
            }
        }
    } catch (_e) {
        // Fallback below
    }
    return 'Inactive (Disconnected)';
}

function maskWebhookUrl(url) {
    if (!url) return 'Not Configured';
    const match = url.match(/^(https?:\/\/[^/]+\/)([A-Za-z0-9-]+)(.*)$/);
    if (match) {
        const token = match[2];
        if (token.length > 10) {
            return `${match[1]}${token.slice(0, 6)}...${token.slice(-4)}${match[3]}`;
        }
    }
    return url;
}

function copyToClipboard(text, window, toastLabel) {
    try {
        const display = Gdk.Display.get_default();
        if (display) {
            const clipboard = display.get_clipboard();
            clipboard.set(text);
            if (window && typeof window.add_toast === 'function') {
                window.add_toast(new Adw.Toast({ title: esc(toastLabel || 'Copied to clipboard') }));
            }
        }
    } catch (_e) {
        // Ignore clipboard errors
    }
}

function runSubprocessAsync(argv, onDone) {
    try {
        const proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        proc.communicate_utf8_async(null, null, (source, res) => {
            try {
                const [, stdout, stderr] = source.communicate_utf8_finish(res);
                const status = source.get_exit_status();
                if (onDone) onDone(status === 0, (stdout || '').trim(), (stderr || '').trim());
            } catch (err) {
                if (onDone) onDone(false, '', err.message);
            }
        });
    } catch (e) {
        if (onDone) onDone(false, '', e.message);
    }
}

export function populatePreferencesWindow(window) {
    window.set_title('Samsung Galaxy Buds Switcher - Settings & Guide');
    window.set_default_size(760, 680);
    window.set_search_enabled(false);

    const initialCfg = readEnvConfig();

    // =========================================================================
    // TAB 1: CONFIGURATION (MAC + MACRODROID WEBHOOK + QUICK ACTIONS)
    // =========================================================================
    const configPage = new Adw.PreferencesPage({
        title: 'Configuration',
        icon_name: 'preferences-system-symbolic',
    });
    window.add(configPage);

    const deviceGroup = createGroup(
        'Samsung Galaxy Buds Bluetooth Device',
        'Works with all Samsung Galaxy Buds models (Buds3 Pro, Buds3, Buds2 Pro, Buds2, Buds Pro, Buds FE, Buds Live, Buds+).'
    );
    configPage.add(deviceGroup);

    const macRow = createActionRow(
        'Earbuds Bluetooth MAC (BUD_MAC)',
        'Format: XX:XX:XX:XX:XX:XX'
    );
    const macEntry = new Gtk.Entry({
        text: initialCfg.budMac,
        placeholder_text: 'A0:B0:BD:4A:12:00',
        valign: Gtk.Align.CENTER,
        width_chars: 20,
    });
    macRow.add_suffix(macEntry);
    deviceGroup.add(macRow);

    const detectedModelRow = createActionRow(
        'Detected Paired Model',
        'Click "Auto-Detect Paired Buds" to scan BlueZ for your paired Samsung earbuds.'
    );
    const detectBtn = new Gtk.Button({
        label: 'Auto-Detect Paired Buds',
        valign: Gtk.Align.CENTER,
        css_classes: ['suggested-action'],
    });
    detectedModelRow.add_suffix(detectBtn);
    deviceGroup.add(detectedModelRow);

    const webhookGroup = createGroup(
        'Android Auto-Reconnect Webhook (MacroDroid)',
        'When you click Disconnect on Ubuntu, this webhook notifies MacroDroid on your Android phone to immediately reclaim your earbuds.'
    );
    configPage.add(webhookGroup);

    const webhookRow = createActionRow(
        'MacroDroid Base URL',
        'https://trigger.macrodroid.com/YOUR-UUID (without trailing /buds)'
    );
    const webhookEntry = new Gtk.Entry({
        text: initialCfg.webhookBase,
        placeholder_text: 'https://trigger.macrodroid.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        valign: Gtk.Align.CENTER,
        width_chars: 36,
    });
    webhookRow.add_suffix(webhookEntry);
    webhookGroup.add(webhookRow);

    const statusBannerRow = createActionRow(
        'Configuration File',
        initialCfg.envPath
    );

    const saveBtn = new Gtk.Button({
        label: 'Save Configuration',
        valign: Gtk.Align.CENTER,
        css_classes: ['suggested-action'],
    });
    const testWebhookBtn = new Gtk.Button({
        label: 'Test Webhook on Phone',
        valign: Gtk.Align.CENTER,
    });
    statusBannerRow.add_suffix(testWebhookBtn);
    statusBannerRow.add_suffix(saveBtn);
    webhookGroup.add(statusBannerRow);

    const quickActionsGroup = createGroup(
        'Live Switcher & Audio Profile Controls',
        'Test switching between Ubuntu and Android or toggling PipeWire audio profiles right now.'
    );
    configPage.add(quickActionsGroup);

    const handoffRow = createActionRow(
        'Bidirectional Device Handoff',
        'Pull earbuds from your Android phone to Ubuntu or release them back to your phone.'
    );
    const connectNowBtn = new Gtk.Button({
        label: 'Connect (Pull to Ubuntu)',
        valign: Gtk.Align.CENTER,
    });
    const disconnectNowBtn = new Gtk.Button({
        label: 'Disconnect (Release to Phone)',
        valign: Gtk.Align.CENTER,
    });
    handoffRow.add_suffix(connectNowBtn);
    handoffRow.add_suffix(disconnectNowBtn);
    quickActionsGroup.add(handoffRow);

    const profileRow = createActionRow(
        'Ubuntu PipeWire Audio Mode',
        'Switch between High-Fidelity Music (A2DP Sink) and Call + Microphone (HFP/HSP).'
    );
    const a2dpBtn = new Gtk.Button({
        label: 'High-Fidelity Music (A2DP)',
        valign: Gtk.Align.CENTER,
    });
    const hfpBtn = new Gtk.Button({
        label: 'Call + Mic (HFP)',
        valign: Gtk.Align.CENTER,
    });
    profileRow.add_suffix(a2dpBtn);
    profileRow.add_suffix(hfpBtn);
    quickActionsGroup.add(profileRow);

    // =========================================================================
    // TAB 2: ANDROID MACRODROID SETUP GUIDE & UBUNTU BOOT PROTECTION
    // =========================================================================
    const guidePage = new Adw.PreferencesPage({
        title: 'Android Setup',
        icon_name: 'phone-symbolic',
    });
    window.add(guidePage);

    const overviewGroup = createGroup(
        'How Seamless Ubuntu <-> Android Switching Works',
        'Samsung Seamless Switch is proprietary to Samsung OneUI devices. This extension gives Ubuntu the same 1-click bidirectional experience:'
    );
    guidePage.add(overviewGroup);

    overviewGroup.add(
        createActionRow(
            '1. Pulling Audio from Android -> Ubuntu (Zero Phone App Needed)',
            'All Samsung Galaxy Buds keep a passive Classic Bluetooth (BR/EDR) listener open while connected to your phone. Clicking Connect on Ubuntu calls BlueZ D-Bus ConnectProfile for A2DP + AVRCP + HFP directly, pulling audio to Ubuntu in ~1.5s without hanging on LE Audio.'
        )
    );

    overviewGroup.add(
        createActionRow(
            '2. Pushing Audio from Ubuntu -> Android (MacroDroid Webhook)',
            'When Ubuntu disconnects Bluetooth, earbuds normally sit idle instead of reconnecting to your phone. Firing a lightweight MacroDroid webhook tells your Android phone to immediately reconnect to your Galaxy Buds.'
        )
    );

    const macroGroup = createGroup(
        'Step-by-Step Android MacroDroid Setup (Takes 2 Minutes)',
        'Follow these 4 steps on your Android phone to enable instant phone auto-reconnect on disconnect:'
    );
    guidePage.add(macroGroup);

    macroGroup.add(
        createActionRow(
            'Step 1 - Create a New Macro in MacroDroid',
            'Install MacroDroid from Google Play Store, open it, tap "Add Macro", and name it "Connect Buds".'
        )
    );

    const step2Row = createActionRow(
        'Step 2 - Add Trigger: Webhook (Url)',
        'Go to Triggers -> Connectivity -> Webhook (Url). Set identifier to "buds". Copy the base URL (https://trigger.macrodroid.com/YOUR-UUID) into the Configuration tab.'
    );
    const copyIdentifierBtn = new Gtk.Button({
        label: 'Copy "buds"',
        valign: Gtk.Align.CENTER,
    });
    copyIdentifierBtn.connect('clicked', () => {
        copyToClipboard('buds', window, 'Copied webhook identifier "buds"');
    });
    step2Row.add_suffix(copyIdentifierBtn);
    macroGroup.add(step2Row);

    macroGroup.add(
        createActionRow(
            'Step 3 - Add Actions: Connect Audio Device + 2s Retry',
            '1) Actions -> Connectivity -> Configure Bluetooth -> Connect to Audio Device -> Select your Galaxy Buds.\n' +
                '2) Actions -> MacroDroid Specific -> Wait Before Next Action -> 2 Seconds.\n' +
                '3) Add the same "Connect to Audio Device -> Your Galaxy Buds" action a second time (ensures connection if BlueZ takes 1s to release RFCOMM).'
        )
    );

    macroGroup.add(
        createActionRow(
            'Step 4 - Set MacroDroid Battery Usage to Unrestricted',
            'On Android, open Settings -> Apps -> MacroDroid -> Battery -> select "Unrestricted" so the webhook wakes Bluetooth immediately even when your phone screen is locked.'
        )
    );

    const ubuntuBootGroup = createGroup(
        'Recommended: Prevent Ubuntu from Auto-Stealing Buds on Boot / Lid Wake',
        'By default, Ubuntu powers on Bluetooth at boot/resume (AutoEnable=true) and steals your earbuds away from your phone. Setting AutoEnable=false prevents unsolicited stealing while buds-switch still powers on Bluetooth whenever you click Connect.'
    );
    guidePage.add(ubuntuBootGroup);

    const autoEnableRow = createActionRow(
        'Disable Unsolicited Bluetooth AutoEnable',
        AUTO_ENABLE_CMD
    );
    const copyCmdBtn = new Gtk.Button({
        label: 'Copy Command',
        valign: Gtk.Align.CENTER,
    });
    copyCmdBtn.connect('clicked', () => {
        copyToClipboard(AUTO_ENABLE_CMD, window, 'Copied AutoEnable=false command to clipboard');
    });
    autoEnableRow.add_suffix(copyCmdBtn);
    ubuntuBootGroup.add(autoEnableRow);

    // =========================================================================
    // TAB 3: LIVE DIAGNOSTICS, SUPPORTED MODELS & BUY ME A COFFEE
    // =========================================================================
    const infoPage = new Adw.PreferencesPage({
        title: 'Info & Support',
        icon_name: 'dialog-information-symbolic',
    });
    window.add(infoPage);

    const diagGroup = createGroup(
        'Live Earbuds & System Diagnostics',
        'Real-time status from BlueZ D-Bus, PipeWire / WirePlumber, and local configuration.'
    );
    infoPage.add(diagGroup);

    const diagModelRow = createActionRow('Detected Earbuds Model');
    const diagPathRow = createActionRow('BlueZ D-Bus Path & Adapter');
    const diagStateRow = createActionRow('Connection & Battery Status');
    const diagProfileRow = createActionRow('Active PipeWire Audio Profile');
    const diagWebhookRow = createActionRow('MacroDroid Webhook Status');
    const diagManagerRow = createActionRow('GalaxyBudsClient Companion App');

    const refreshDiagBtn = new Gtk.Button({
        label: 'Refresh Status',
        valign: Gtk.Align.CENTER,
    });
    diagModelRow.add_suffix(refreshDiagBtn);

    diagGroup.add(diagModelRow);
    diagGroup.add(diagPathRow);
    diagGroup.add(diagStateRow);
    diagGroup.add(diagProfileRow);
    diagGroup.add(diagWebhookRow);
    diagGroup.add(diagManagerRow);

    const modelsGroup = createGroup(
        'Supported Samsung Galaxy Buds Models',
        'Every Samsung Galaxy Buds model uses Classic Bluetooth (A2DP 0x110B, AVRCP 0x110E, HFP 0x111E) and supports passive BR/EDR takeover:'
    );
    infoPage.add(modelsGroup);

    modelsGroup.add(
        createActionRow(
            'Galaxy Buds3 Pro & Galaxy Buds3 (LE Audio + Classic Dual-Mode)',
            'Bypasses BlueZ experimental LE Audio (BAP) hangs by explicitly connecting Classic BR/EDR profiles over D-Bus.'
        )
    );
    modelsGroup.add(
        createActionRow(
            'Galaxy Buds2 Pro, Buds2, Buds Pro, Buds FE, Buds Live & Buds+',
            'Full 1-click pull from Android, PipeWire default sink routing, A2DP/HFP profile toggle, live battery %, and MacroDroid return handoff.'
        )
    );

    const supportGroup = createGroup(
        'Support the Developer & Project Links',
        'Built and maintained by Pulkit Mundra. If this tool saved you from Bluetooth pairing headaches on Ubuntu, consider supporting the project!'
    );
    infoPage.add(supportGroup);

    const addLinkRow = (title, subtitle, buttonLabel, uri, isSuggested = false) => {
        const row = createActionRow(title, subtitle);
        const btn = new Gtk.Button({
            label: buttonLabel,
            valign: Gtk.Align.CENTER,
            css_classes: isSuggested ? ['suggested-action'] : [],
        });
        btn.connect('clicked', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(uri, null);
            } catch (_e) {
                // Ignore launch error
            }
        });
        row.add_suffix(btn);
        supportGroup.add(row);
    };

    addLinkRow(
        'Buy Me a Coffee ☕',
        'Support ongoing open-source Linux & GNOME desktop tools development',
        'Buy Me a Coffee',
        BUY_ME_A_COFFEE_URL,
        true
    );
    addLinkRow(
        'GitHub Sponsors ❤️',
        'Sponsor @pulkitmundra on GitHub',
        'Sponsor on GitHub',
        GITHUB_SPONSORS_URL
    );
    addLinkRow(
        'GitHub Repository & Documentation',
        GITHUB_REPO_URL,
        'Open GitHub Repo',
        GITHUB_REPO_URL
    );
    addLinkRow(
        'Report an Issue or Request a Feature',
        GITHUB_ISSUES_URL,
        'Open Issues',
        GITHUB_ISSUES_URL
    );
    addLinkRow(
        'Author Portfolio',
        PORTFOLIO_URL,
        'Visit Portfolio',
        PORTFOLIO_URL
    );

    // =========================================================================
    // INTERACTIVE HANDLERS & DIAGNOSTIC REFRESH
    // =========================================================================
    const refreshDiagnostics = () => {
        const currentCfg = readEnvConfig();
        const pairedList = scanPairedGalaxyBuds();
        const targetMac = (macEntry.get_text() || currentCfg.budMac || '').trim().toUpperCase();
        const macUnderscore = targetMac ? targetMac.replace(/:/g, '_') : '';

        let matchedDevice = pairedList.find(d => d.address === targetMac) || pairedList[0] || null;

        if (matchedDevice) {
            detectedModelRow.set_subtitle(
                `${matchedDevice.cleanName} (${matchedDevice.address}) on ${matchedDevice.adapter}`
            );
            diagModelRow.set_subtitle(`${matchedDevice.cleanName} [Raw Alias: ${matchedDevice.alias}]`);
            diagPathRow.set_subtitle(`${matchedDevice.objectPath} (Paired: ${matchedDevice.paired ? 'Yes' : 'No'})`);
            const battText = matchedDevice.battery !== null ? ` - Battery: ${matchedDevice.battery}%` : '';
            diagStateRow.set_subtitle(
                matchedDevice.connected ? `Connected to Ubuntu${battText}` : 'Disconnected (On Phone or In Case)'
            );
        } else if (targetMac) {
            detectedModelRow.set_subtitle(`Configured MAC: ${targetMac} (Not currently visible in BlueZ)`);
            diagModelRow.set_subtitle(`Samsung Galaxy Buds (${targetMac})`);
            diagPathRow.set_subtitle(`/org/bluez/hci0/dev_${macUnderscore}`);
            diagStateRow.set_subtitle('Disconnected or Bluetooth Powered Off');
        } else {
            detectedModelRow.set_subtitle('No paired Galaxy Buds found yet. Pair your earbuds in Ubuntu Bluetooth settings first.');
            diagModelRow.set_subtitle('Not Configured');
            diagPathRow.set_subtitle('N/A');
            diagStateRow.set_subtitle('Unconfigured');
        }

        diagProfileRow.set_subtitle(getActivePipeWireProfile(macUnderscore));
        diagWebhookRow.set_subtitle(maskWebhookUrl(webhookEntry.get_text().trim() || currentCfg.webhookBase));
        const hasManager = GLib.file_test(MANAGER_BIN, GLib.FileTest.IS_EXECUTABLE);
        diagManagerRow.set_subtitle(
            hasManager ? `Installed (${MANAGER_BIN})` : 'Not installed (Run ./install.sh to install)'
        );
    };

    detectBtn.connect('clicked', () => {
        const paired = scanPairedGalaxyBuds();
        if (paired.length > 0) {
            const best = paired.find(d => d.connected) || paired[0];
            macEntry.set_text(best.address);
            detectedModelRow.set_subtitle(
                `Detected: ${best.cleanName} (${best.address}) on ${best.adapter}`
            );
            if (typeof window.add_toast === 'function') {
                window.add_toast(new Adw.Toast({ title: esc(`Detected ${best.cleanName} (${best.address})`) }));
            }
            refreshDiagnostics();
        } else {
            detectedModelRow.set_subtitle(
                'No paired Galaxy Buds detected in BlueZ. Pair your Buds in Ubuntu Settings -> Bluetooth first.'
            );
            if (typeof window.add_toast === 'function') {
                window.add_toast(new Adw.Toast({ title: 'No paired Galaxy Buds found in BlueZ' }));
            }
        }
    });

    saveBtn.connect('clicked', () => {
        const res = saveEnvConfig(macEntry.get_text(), webhookEntry.get_text());
        if (res.ok) {
            macEntry.set_text(res.budMac);
            webhookEntry.set_text(res.webhookBase);
            statusBannerRow.set_subtitle(res.message);
            if (typeof window.add_toast === 'function') {
                window.add_toast(new Adw.Toast({ title: 'Configuration saved (0600)' }));
            }
            refreshDiagnostics();
        } else {
            statusBannerRow.set_subtitle(res.message);
            if (typeof window.add_toast === 'function') {
                window.add_toast(new Adw.Toast({ title: esc(res.message) }));
            }
        }
    });

    testWebhookBtn.connect('clicked', () => {
        let base = webhookEntry.get_text().trim().replace(/\/+$/, '').replace(/\/buds$/i, '');
        if (!base) {
            statusBannerRow.set_subtitle('Enter your MacroDroid Base URL first before testing.');
            if (typeof window.add_toast === 'function') {
                window.add_toast(new Adw.Toast({ title: 'Enter a MacroDroid Webhook URL first' }));
            }
            return;
        }
        const testUrl = `${base}/buds`;
        statusBannerRow.set_subtitle(`Testing webhook GET ${maskWebhookUrl(base)}/buds ...`);
        testWebhookBtn.set_sensitive(false);

        runSubprocessAsync(
            ['curl', '-sS', '--proto', '=https,http', '--max-time', '6', '-o', '/dev/null', '-w', '%{http_code}', '--', testUrl],
            (ok, stdout, stderr) => {
                testWebhookBtn.set_sensitive(true);
                if (ok && (stdout === '200' || stdout === '202' || stdout === '204')) {
                    const msg = `Webhook test succeeded (HTTP ${stdout})! Check your Android phone for the MacroDroid trigger.`;
                    statusBannerRow.set_subtitle(msg);
                    if (typeof window.add_toast === 'function') {
                        window.add_toast(new Adw.Toast({ title: `Webhook triggered (HTTP ${stdout})` }));
                    }
                } else {
                    const msg = `Webhook test failed (HTTP ${stdout || 'ERR'}): ${stderr || 'Verify URL and internet connection.'}`;
                    statusBannerRow.set_subtitle(msg);
                    if (typeof window.add_toast === 'function') {
                        window.add_toast(new Adw.Toast({ title: `Webhook failed (HTTP ${stdout || 'ERR'})` }));
                    }
                }
            }
        );
    });

    connectNowBtn.connect('clicked', () => {
        connectNowBtn.set_sensitive(false);
        runSubprocessAsync([SWITCH_SCRIPT, 'connect'], () => {
            connectNowBtn.set_sensitive(true);
            refreshDiagnostics();
        });
    });

    disconnectNowBtn.connect('clicked', () => {
        disconnectNowBtn.set_sensitive(false);
        runSubprocessAsync([SWITCH_SCRIPT, 'disconnect'], () => {
            disconnectNowBtn.set_sensitive(true);
            refreshDiagnostics();
        });
    });

    a2dpBtn.connect('clicked', () => {
        runSubprocessAsync([SWITCH_SCRIPT, 'profile', 'a2dp'], (_ok, out, err) => {
            if (typeof window.add_toast === 'function') {
                window.add_toast(new Adw.Toast({ title: esc(out || err || 'Switched to High-Fidelity Music (A2DP)') }));
            }
            refreshDiagnostics();
        });
    });

    hfpBtn.connect('clicked', () => {
        runSubprocessAsync([SWITCH_SCRIPT, 'profile', 'hfp'], (_ok, out, err) => {
            if (typeof window.add_toast === 'function') {
                window.add_toast(new Adw.Toast({ title: esc(out || err || 'Switched to Call + Mic (HFP)') }));
            }
            refreshDiagnostics();
        });
    });

    refreshDiagBtn.connect('clicked', () => {
        refreshDiagnostics();
        if (typeof window.add_toast === 'function') {
            window.add_toast(new Adw.Toast({ title: 'Diagnostics refreshed' }));
        }
    });

    refreshDiagnostics();
}

// Standalone launcher mode when executed via `buds-settings`
if (typeof ARGV !== 'undefined' && ARGV.includes('--standalone')) {
    Adw.init();
    const app = new Adw.Application({
        application_id: 'io.github.pulkitmundra.GalaxyBudsSwitcher.Settings',
        flags: Gio.ApplicationFlags.NON_UNIQUE,
    });
    app.connect('activate', application => {
        const win = new Adw.PreferencesWindow({
            application,
        });
        populatePreferencesWindow(win);
        win.present();
    });
    app.run([]);
}
