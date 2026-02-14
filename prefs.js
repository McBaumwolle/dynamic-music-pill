import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

export default class DynamicMusicPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {

        const settings = this.getSettings('org.gnome.shell.extensions.dynamic-music-pill');
        
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Customize the behavior of the Pill'
        });

        const scrollRow = new Adw.ActionRow({ 
            title: 'Scrolling Text',
            subtitle: 'Automatically animate long track titles'
        });

        const toggle = new Gtk.Switch({ 
            active: settings.get_boolean('scroll-text'),
            valign: Gtk.Align.CENTER 
        });


        settings.bind(
            'scroll-text',
            toggle,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        
        scrollRow.add_suffix(toggle);
        group.add(scrollRow);
        page.add(group);
        window.add(page);
    }
}
