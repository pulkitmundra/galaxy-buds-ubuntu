import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { populatePreferencesWindow } from './budsSettingsWindow.js';

export default class BudsQuickTogglePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        populatePreferencesWindow(window);
    }
}
