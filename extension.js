import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Pango from 'gi://Pango';
import GdkPixbuf from 'gi://GdkPixbuf';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MPRIS_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="Metadata" type="a{sv}" access="read" />
    <property name="PlaybackStatus" type="s" access="read" />
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
  </interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_IFACE);

function smartUnpack(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof GLib.Variant) {
        try { return smartUnpack(value.deep_unpack()); } catch (e) {}
    }
    if (Array.isArray(value)) return value.map(smartUnpack);
    if (typeof value === 'object') return value;
    return value;
}

function getAverageColor(pixbuf) {
    let w = pixbuf.get_width();
    let h = pixbuf.get_height();
    let pixels = pixbuf.get_pixels();
    let rowstride = pixbuf.get_rowstride();
    let n_channels = pixbuf.get_n_channels();
    let r = 0, g = 0, b = 0, count = 0;
    for (let y = 0; y < h; y += 20) {
      for (let x = 0; x < w; x += 20) {
        let idx = y * rowstride + x * n_channels;
        r += pixels[idx]; g += pixels[idx + 1]; b += pixels[idx + 2];
        count++;
      }
    }
    return { r: Math.floor(r / count), g: Math.floor(g / count), b: Math.floor(b / count) };
}

// --- Crossfade Art
const CrossfadeArt = GObject.registerClass(
class CrossfadeArt extends St.Widget {
    _init() {
        super._init({ 
            layout_manager: new Clutter.BinLayout(), 
            style_class: 'art-widget',
        });
        const layerStyle = 'border-radius: 10px; background-size: cover; background-position: center;';
        this._back = new St.Widget({ x_expand: true, y_expand: true, style: layerStyle });
        this._front = new St.Widget({ x_expand: true, y_expand: true, style: layerStyle });
        this.add_child(this._back);
        this.add_child(this._front);
        this._currentUrl = null;
    }
    setArt(url, force = false) {
        if (!force && this._currentUrl === url) return;
        this._currentUrl = url;
        if (!url) {
            this._back.set_style('');
            this._front.set_style('');
            return;
        }
        this._back.set_style(`background-image: url("${url}"); border-radius: 10px; background-size: cover; background-position: center;`);
        this._front.ease({
            opacity: 0,
            duration: 600,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._front.set_style(`background-image: url("${url}"); border-radius: 10px; background-size: cover; background-position: center;`);
                this._front.opacity = 255;
            }
        });
    }
});

// --- Scroll Label 
const ScrollLabel = GObject.registerClass(
class ScrollLabel extends St.Widget {
    _init(styleClass, settings) {
        super._init({ 
            layout_manager: new Clutter.BinLayout(),
            x_expand: true, 
            y_expand: false, 
            clip_to_allocation: true 
        });
        this._settings = settings;
        this._styleClass = styleClass;
        this._text = "";
        
        this._container = new St.BoxLayout({ vertical: false });
        this.add_child(this._container);

        this._label1 = new St.Label({ style_class: styleClass, y_align: Clutter.ActorAlign.CENTER });
        this._label2 = new St.Label({ style_class: styleClass, y_align: Clutter.ActorAlign.CENTER });
        
        this._label1.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._label1.clutter_text.line_wrap = false;
        this._label2.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._label2.clutter_text.line_wrap = false;

        this._container.add_child(this._label1);
        this._separator = new St.Widget({ width: 30 }); 
        this._container.add_child(this._separator);
        this._container.add_child(this._label2);

        this._settings.connect('changed::scroll-text', () => this.setText(this._text, true));
    }

    setText(text, force = false) {
        if (!force && this._text === text) return;
        this._text = text || "";
        
        this._stopAnimation();

        this._label1.text = this._text;
        this._label2.text = this._text;
        
        this._label2.hide();
        this._separator.hide();

        if (!this._settings.get_boolean('scroll-text')) {
            this._label1.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            return;
        }

        this._label1.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        if (this._measureTimeout) GLib.source_remove(this._measureTimeout);
        this._measureTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._checkOverflow();
            this._measureTimeout = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopAnimation() {
        this._container.remove_all_transitions();
        this._container.translation_x = 0;
        if (this._scrollTimer) {
            GLib.source_remove(this._scrollTimer);
            this._scrollTimer = null;
        }
    }

    _checkOverflow() {
        if (!this._settings.get_boolean('scroll-text')) return;
        let boxWidth = this.get_allocation_box().get_width();
        let textWidth = this._label1.get_preferred_width(-1)[1];

        if (textWidth > boxWidth) {
            this._startInfiniteScroll(textWidth);
        }
    }

    _startInfiniteScroll(textWidth) {
        this._label2.show();
        this._separator.show();
        const gap = 30; 
        const distance = textWidth + gap;
        const speed = 30; 
        const duration = (distance / speed) * 1000;

        const loop = () => {
            this._scrollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                this._container.ease({
                    translation_x: -distance,
                    duration: duration,
                    mode: Clutter.AnimationMode.LINEAR,
                    onComplete: () => {
                        this._container.translation_x = 0;
                        loop();
                    }
                });
                return GLib.SOURCE_REMOVE;
            });
        };
        loop();
    }
});

// --- Waveform Visualizer ---
const WaveformVisualizer = GObject.registerClass(
class WaveformVisualizer extends St.BoxLayout {
  _init() {
    super._init({ vertical: false, style: 'spacing: 3px;', y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.END });
    this._bars = [];
    this._color = '255,255,255';
    for (let i = 0; i < 4; i++) {
      let bar = new St.Bin({ style_class: 'visualizer-bar', y_align: Clutter.ActorAlign.END });
      this.add_child(bar);
      this._bars.push(bar);
    }
  }
  setColor(c) { 
      let r = Math.min(255, c.r + 100);
      let g = Math.min(255, c.g + 100);
      let b = Math.min(255, c.b + 100);
      this._color = `${r},${g},${b}`;
  }
  setPlaying(playing) {
    if (this._isPlaying === playing) return;
    this._isPlaying = playing;
    if (this._timerId) { GLib.source_remove(this._timerId); this._timerId = null; }
    if (playing) {
      this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
        let t = Date.now() / 200;
        this._bars.forEach((bar, idx) => {
          let h = 4 + Math.abs(Math.sin(t + idx)) * 14;
          bar.set_style(`height: ${Math.floor(h)}px; background-color: rgb(${this._color});`);
        });
        return GLib.SOURCE_CONTINUE;
      });
    } else {
      this._bars.forEach(bar => bar.set_style(`height: 4px; opacity: 0.4; background-color: rgb(${this._color});`));
    }
  }
});

// --- Main Widget ---
const MusicPill = GObject.registerClass(
class MusicPill extends St.Widget {
  _init(controller) {
    super._init({ 
        style_class: 'music-pill-container', 
        reactive: true, 
        y_align: Clutter.ActorAlign.CENTER, 
        x_align: Clutter.ActorAlign.CENTER,
        opacity: 0,
        visible: false
    });
    this._controller = controller;
    this._currentBusName = null;
    
    this._displayedColor = { r: 40, g: 40, b: 40 };
    this._targetColor = { r: 40, g: 40, b: 40 };
    this._colorAnimId = null;
    this._hideGraceTimer = null;

    this._body = new St.BoxLayout({ style_class: 'pill-body', x_expand: false });
    this._body.set_pivot_point(0.5, 0.5);
    
    this._artWidget = new CrossfadeArt();
    this._body.add_child(new St.Bin({ child: this._artWidget, style: 'margin-right: 8px;' }));

    this._textWrapper = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        x_expand: true, y_expand: true,
        style: 'min-width: 140px; overflow: hidden; margin-right: 4px; margin-left: 2px;' 
    });

    this._textBox = new St.BoxLayout({ 
        vertical: true, x_expand: true, 
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.FILL,
        style: 'padding-left: 4px; padding-right: 4px;' 
    });
    this._titleScroll = new ScrollLabel('music-label-title', this._controller._settings);
    this._artistScroll = new ScrollLabel('music-label-artist', this._controller._settings);
    this._textBox.add_child(this._titleScroll);
    this._textBox.add_child(this._artistScroll);
    this._textWrapper.add_child(this._textBox);

    this._fadeLeft = new St.Widget({ 
        x_expand: false, y_expand: true,
        x_align: Clutter.ActorAlign.START, 
        y_align: Clutter.ActorAlign.FILL,
    });
    this._fadeLeft.set_width(40);
    this._fadeLeft.set_z_position(9999);
    this._textWrapper.add_child(this._fadeLeft);

    this._fadeRight = new St.Widget({ 
        x_expand: false, y_expand: true,
        x_align: Clutter.ActorAlign.END, 
        y_align: Clutter.ActorAlign.FILL,
    });
    this._fadeRight.set_width(40);
    this._fadeRight.set_z_position(9999);
    this._textWrapper.add_child(this._fadeRight);

    this._body.add_child(this._textWrapper);

    this._visualizer = new WaveformVisualizer();
    this._body.add_child(new St.Bin({ child: this._visualizer, style: 'margin-left: 8px;' }));
    this.add_child(this._body);

    this.connect('button-press-event', () => {
        this._body.ease({ scale_x: 0.96, scale_y: 0.96, duration: 80, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        return Clutter.EVENT_STOP;
    });

    this.connect('button-release-event', () => {
        this._body.ease({ scale_x: 1.0, scale_y: 1.0, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_BACK });
        this._controller.togglePlayback();
        return Clutter.EVENT_STOP;
    });

    this.connect('scroll-event', (actor, event) => {
        let direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.RIGHT) {
            this._animateSlide(12);
            this._controller.next();
        } else if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.LEFT) {
            this._animateSlide(-12);
            this._controller.previous();
        }
        return Clutter.EVENT_STOP;
    });
  }

  _animateSlide(offset) {
      this._body.ease({
          translation_x: offset, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: () => { this._body.ease({ translation_x: 0, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_BACK }); }
      });
  }

  updateDisplay(title, artist, artUrl, status, busName, isSkipActive) {
    this._currentStatus = status;
    let forceUpdate = false;

    if (this._currentBusName !== busName) {
        this._currentBusName = busName;
        this._lastTitle = null;
        this._lastArtist = null;
        this._lastArtUrl = null;
        forceUpdate = true;
        
        if (this._hideGraceTimer) {
            GLib.source_remove(this._hideGraceTimer);
            this._hideGraceTimer = null;
        }
    }

    if (!title || status === 'Stopped') {
        if (isSkipActive) return; 

        if (!this._hideGraceTimer && this.visible) {
            this._hideGraceTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                this.ease({ 
                    opacity: 0, duration: 500, 
                    onComplete: () => { 
                        this.hide(); 
                        this._lastTitle = null; 
                        this._lastArtist = null;
                        this._lastArtUrl = null;
                        this._currentBusName = null;
                    }
                });
                this._visualizer.setPlaying(false);
                this._hideGraceTimer = null;
                return GLib.SOURCE_REMOVE;
            });
        }
        return; 
    }

    if (this._hideGraceTimer) {
        GLib.source_remove(this._hideGraceTimer);
        this._hideGraceTimer = null;
    }

    if (!this.visible || this.opacity === 0) {
        this.show();
        this.ease({ opacity: 255, duration: 400 });
    }

    if (this._lastTitle !== title || this._lastArtist !== artist || forceUpdate) {
        this._titleScroll.setText(title || 'Betöltés...', forceUpdate);
        this._artistScroll.setText(artist || '', forceUpdate);
        this._lastTitle = title;
        this._lastArtist = artist;
    }

    this._visualizer.setPlaying(status === 'Playing');
    
    if (forceUpdate || (artUrl && this._lastArtUrl !== artUrl)) {
        this._lastArtUrl = artUrl;
        this._artWidget.setArt(artUrl, forceUpdate);
        if (artUrl) this._loadColorFromArt(artUrl);
    } else {
        this._startColorTransition();
    }
  }

  _loadColorFromArt(artUrl) {
    let file = Gio.File.new_for_uri(artUrl);
    file.load_contents_async(null, (f, res) => {
        try {
            let [ok, bytes] = f.load_contents_finish(res);
            if (ok) {
                let stream = Gio.MemoryInputStream.new_from_bytes(bytes);
                let pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
                this._targetColor = getAverageColor(pixbuf);
                this._visualizer.setColor(this._targetColor);
                this._startColorTransition();
            }
        } catch (e) {}
    });
  }

  _startColorTransition() {
      if (this._colorAnimId) { GLib.source_remove(this._colorAnimId); this._colorAnimId = null; }
      let base = this._targetColor;
      let factor = (this._currentStatus === 'Playing') ? 0.6 : 0.4;
      let targetR = Math.floor(base.r * factor);
      let targetG = Math.floor(base.g * factor);
      let targetB = Math.floor(base.b * factor);

      let steps = 60; let count = 0;
      this._colorAnimId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
          count++;
          let progress = count / steps;
          let t = progress * progress * (3 - 2 * progress); 
          let r = Math.floor(this._displayedColor.r + (targetR - this._displayedColor.r) * t);
          let g = Math.floor(this._displayedColor.g + (targetG - this._displayedColor.g) * t);
          let b = Math.floor(this._displayedColor.b + (targetB - this._displayedColor.b) * t);
          this._applyStyle(r, g, b);
          if (count >= steps) { this._displayedColor = { r: targetR, g: targetG, b: targetB }; this._colorAnimId = null; return GLib.SOURCE_REMOVE; }
          return GLib.SOURCE_CONTINUE;
      });
  }

  _applyStyle(r, g, b) {
      let bgStyle = `background-color: rgba(${r}, ${g}, ${b}, 0.95);`;
      let borderStyle = `border: 1px solid rgba(255,255,255,${this._currentStatus === 'Playing' ? 0.2 : 0.1});`;
      this._body.set_style(`${bgStyle} ${borderStyle} box-shadow: 0 4px 12px rgba(0,0,0,0.4);`);
      this._fadeLeft.set_style(`background-gradient-direction: horizontal; background-gradient-start: rgba(${r}, ${g}, ${b}, 1); background-gradient-end: rgba(${r}, ${g}, ${b}, 0);`);
      this._fadeRight.set_style(`background-gradient-direction: horizontal; background-gradient-start: rgba(${r}, ${g}, ${b}, 0); background-gradient-end: rgba(${r}, ${g}, ${b}, 1);`);
      this._displayedColor = { r, g, b };
  }
});

// --- Extension Entry ---
export default class DynamicMusicExtension extends Extension {
  enable() {
    this._settings = this.getSettings('org.gnome.shell.extensions.dynamic-music-pill');
    this._pill = new MusicPill(this);
    this._proxies = new Map();
    this._lastWinnerName = null;
    this._lastStatusTime = 0;
    this._lastActionTime = 0; 
    this._recheckTimer = null;
    this._connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
    this._inject();
    this._ownerId = this._connection.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE, () => this._scan());
    this._scan();
    this._watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => { this._inject(); return GLib.SOURCE_CONTINUE; });
  }
  
  _inject() {
    let dtd = Main.panel.statusArea['dash-to-dock'];
    let container = (dtd && dtd._box) ? dtd._box : (Main.overview.dash._box || null);
    if (container && this._pill.get_parent() !== container) {
        if (this._pill.get_parent()) this._pill.get_parent().remove_child(this._pill);
        container.insert_child_at_index(this._pill, 0);
    }
  }

  _scan() {
    this._connection.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, null, (c, res) => {
        try {
            let r = smartUnpack(c.call_finish(res));
            let names = Array.isArray(r[0]) ? r[0] : (Array.isArray(r) ? r : []);
            let mprisNames = names.filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
            mprisNames.forEach(n => this._add(n));
            for (let [name, proxy] of this._proxies) {
                if (!mprisNames.includes(name)) this._proxies.delete(name);
            }
            this._updateUI();
        } catch (e) {}
    });
  }

  _add(name) {
    if (this._proxies.has(name)) return;
    try {
        let p = new PlayerProxy(this._connection, name, '/org/mpris/MediaPlayer2');
        p._busName = name;
        p._lastSeen = Date.now();
        p._lastStatusTime = Date.now();
        p._lastPlayingTime = 0; 

        p.connect('g-properties-changed', (proxy, changed) => { 
            let keys = changed.unpack();
            let now = Date.now();
            p._lastSeen = now;
            p._lastStatusTime = now;

            if (keys.Metadata && this._lastWinnerName === p._busName) {
                this._lastActionTime = now;
            }

            if (keys.PlaybackStatus && smartUnpack(keys.PlaybackStatus) === 'Playing') {
                p._lastPlayingTime = now;
            }
            this._updateUI(); 
        });
        this._proxies.set(name, p);
    } catch (e) {}
  }

  _updateUI() {
    if (this._recheckTimer) {
        GLib.source_remove(this._recheckTimer);
        this._recheckTimer = null;
    }

    let active = this._getActivePlayer();
    if (active) {
        this._lastWinnerName = active._busName;
        let m = active.Metadata;
        let title = null, artist = null, artUrl = null;
        if (m) {
            title = smartUnpack(m['xesam:title']);
            artist = smartUnpack(m['xesam:artist']);
            if (Array.isArray(artist)) artist = artist.map(a => smartUnpack(a)).join(', ');
            artUrl = smartUnpack(m['mpris:artUrl']);
        }
        let now = Date.now();
        let isSkipActive = (now - this._lastActionTime < 3000); 
        this._pill.updateDisplay(title, artist, artUrl, active.PlaybackStatus, active._busName, isSkipActive);
    } else {
        this._pill.updateDisplay(null, null, null, 'Stopped', null, false);
    }
  }

  _getActivePlayer() {
      let proxiesArr = Array.from(this._proxies.values());
      if (proxiesArr.length === 0) return null;
      let now = Date.now();

      // 1. HARD LOCK
      if (now - this._lastActionTime < 3000 && this._lastWinnerName) {
          let lockedPlayer = proxiesArr.find(p => p._busName === this._lastWinnerName);
          if (lockedPlayer) {
          
              if (lockedPlayer.PlaybackStatus !== 'Playing' && !this._recheckTimer) {
                  let remaining = 3100 - (now - this._lastActionTime);
                  this._recheckTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, remaining, () => {
                      this._updateUI();
                      return GLib.SOURCE_REMOVE;
                  });
              }
              return lockedPlayer;
          }
      }

      // 2. Scoreing
      let scoredPlayers = proxiesArr.map(p => {
          let score = 0;
          let status = p.PlaybackStatus;
          let m = p.Metadata;
          let hasTitle = m && smartUnpack(m['xesam:title']);
          if (status === 'Playing' && hasTitle) score = 500;
          else if (status === 'Paused' && hasTitle) score = 100;
          else score = 0;
          return { player: p, score: score };
      });

      scoredPlayers.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (b.player._lastPlayingTime !== a.player._lastPlayingTime) {
              return b.player._lastPlayingTime - a.player._lastPlayingTime;
          }
          return b.player._lastSeen - a.player._lastSeen;
      });

      let winner = scoredPlayers[0].player;

      if (winner.PlaybackStatus !== 'Playing') {
          let anyPlaying = scoredPlayers.find(s => s.player.PlaybackStatus === 'Playing' && smartUnpack(s.player.Metadata['xesam:title']));
          if (anyPlaying) winner = anyPlaying.player;
      }

      let winM = winner.Metadata;
      if (!winM || !smartUnpack(winM['xesam:title']) || (winner.PlaybackStatus === 'Stopped' && (now - this._lastActionTime >= 3000))) {
          let backup = scoredPlayers.find(s => s.player.PlaybackStatus === 'Playing' && smartUnpack(s.player.Metadata['xesam:title']));
          if (backup) return backup.player;
          return null;
      }
      return winner;
  }

  togglePlayback() { let p = this._getActivePlayer(); if (p) p.PlayPauseRemote(); }
  next() { this._lastActionTime = Date.now(); let p = this._getActivePlayer(); if (p) p.NextRemote(); }
  previous() { this._lastActionTime = Date.now(); let p = this._getActivePlayer(); if (p) p.PreviousRemote(); }

  disable() {
    if (this._watchdog) GLib.source_remove(this._watchdog);
    if (this._recheckTimer) GLib.source_remove(this._recheckTimer);
    if (this._ownerId) this._connection.signal_unsubscribe(this._ownerId);
    this._pill.destroy();
    this._proxies.clear();
    this._settings = null;
  }
}
