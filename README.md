# Roon: Dialed Up

A Stream Deck plugin for controlling [Roon](https://roon.app) playback, built on top of the Stream Deck+'s dials, touchscreen and buttons.

This started as a fork of Tomi Blinnikka's [streamdeck-roon](https://github.com/docBliny/streamdeck-roon). None of this would exist without his foundational work, made possible because he open-sourced the project and opened it up for anyone to build on. The codebase has changed substantially since then (new icon system, touchscreen customization, dial support, and more), but the foundation and the original idea are his. Licensed MIT, same as the original; see [LICENSE](LICENSE).

![Key grid icon examples](docs/key-grid-example.png)

## Features

### Buttons

- Play / Pause (album art, artist/track, elapsed time, and progress bar, each independently toggleable)
- Play
- Pause
- Stop
- Play This / Play Item
- Previous
- Next
- Loop All / Loop One (independent toggles)
- Shuffle mode (on / off)
- Volume up
- Volume down
- Volume set
- Mute / Unmute
- Roon Radio on/off

### Dials (Stream Deck+)

- Adjust Volume — rotate to change volume, short press to mute/unmute (or play/pause, if set to that mode), long press to mute/unmute all zones
- Player Controls — play/pause on press, previous/next on rotation, hold-to-mute on the touchscreen, with a Show Volume toggle to switch its touchscreen layout between a centered display and one that includes the volume readout

### Customization

- Three icon styles: LED Grid, LED, and Classic, with a full color picker for the LED styles
- Touchscreen title display: off, output name, or artist–song
- Touchscreen progress bar: off, replacing the volume bar, or as its own row
- Optional logo, hiding it frees up horizontal space for the rest of the layout
- UI and album art transparency sliders
- Independent text and bar color pickers

## Using the Roon logo

The Roon logo isn't bundled with the plugin, to avoid shipping any copyrighted assets. If you'd like it as your icon, save your own copy of the logo, then in the Stream Deck software click the small dropdown arrow on the corner of the action's icon and choose **Set From File** to select it.

![Setting a custom icon from file](set-file-custom.png)

## Installation

Requires Stream Deck software 6.0 or later, on macOS 10.11+ or Windows 10+. The button actions work on any Stream Deck; the two Dial actions need a Stream Deck+.

**Elgato Marketplace:** coming soon, this section will be updated with a link once the listing is live.

**Manual:** build from source (see below), then double-click the resulting `com.vulkan.roon-dialed-up.sdPlugin` to install it.

## Configuration

Add one of the Roon actions to your Deck, enter the hostname (or IP address) and port of your Roon Core, then click **Connect**. The port is usually `9100`, but some Roon Core setups use a dynamic port instead, check your Roon Core's own settings if the default doesn't connect.

Open Roon, go to **Settings → Extensions**, find **Roon: Dialed Up**, and click **Enable**.

## Local development

### Source code

The `plug-in/` and `property-inspector/` folders contain the plugin source. Building produces a `com.vulkan.roon-dialed-up.sdPlugin` folder alongside them.

```
npm install
npm run build
```

The `com.vulkan.roon-dialed-up.sdPlugin` folder is ready to install as soon as this finishes. The last step of `build` also runs Elgato's [Stream Deck CLI](https://docs.elgato.com/streamdeck/cli/intro) (`streamdeck pack`) to produce a single-file `.streamDeckPlugin` package in `../Release/`. That needs the CLI installed globally first:

```
npm install -g @elgato/cli
```

If you skip this, that one step will fail but the `.sdPlugin` folder itself will already be built correctly.

### Enable Stream Deck debug mode

See the [Elgato SDK docs](https://developer.elgato.com/documentation/stream-deck/sdk/create-your-own-plugin/).

**macOS:**

```
defaults write com.elgato.StreamDeck html_remote_debugging_enabled -bool YES
```

**Windows:**

In Registry Editor, add a `DWORD` named `html_remote_debugging_enabled` with value `1` at `HKEY_CURRENT_USER\Software\Elgato Systems GmbH\StreamDeck`.

### Run without installing

Symlink the built plugin folder into the Stream Deck plugins folder (adjust the source path to match your local checkout):

**macOS:**

```
ln -s ~/dev/streamdeck-roon-dialed-up/com.vulkan.roon-dialed-up.sdPlugin ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/com.vulkan.roon-dialed-up.sdPlugin
```

**Windows** (run as Administrator):

```
mklink /D "%APPDATA%\Elgato\StreamDeck\Plugins\com.vulkan.roon-dialed-up.sdPlugin" "C:\path\to\streamdeck-roon-dialed-up\com.vulkan.roon-dialed-up.sdPlugin"
```

Then run the plugin and property inspector in watch mode (two terminals):

```
npm run plug-in:build:watch
npm run property-inspector:build:watch
```

### Build a release package

- Bump `version` in `package.json` and the version number in `manifest.json`
- `npm run build`

## Misc

Roon is a trademark or registered trademark of Roon Labs LLC.

Elgato, Corsair, and Stream Deck are trademarks or registered trademarks of Corsair GmbH.
