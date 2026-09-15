import ActionBase from "./ActionBase";
import debug from "debug";
import { MuteOnDialImage } from "../DataImages/mute-on-dial-image";
import { RoonEncoderFeedback } from "../DataImages/roon-encoder-feedback";
import { RoonEncoderKeyFeedback } from "../DataImages/roon-encoder-key-feedback";
import { VolumeDisabledEncoderFeedback } from "../DataImages/volume-disabled-encoder-feedback";
import { TransparentPixel } from "../DataImages/transparent-pixel";

const ACTION_NAME = "volume-encoder";
const ACTION_UUID = `com.vulkan.roon-dialed-up.${ACTION_NAME}`;

const log = debug(`action:${ACTION_NAME}`);

export default class VolumeEncoderAction extends ActionBase {
  // ********************************************
  // * Constructors
  // ********************************************
  constructor(config) {
    super(config);

    log("ctor");

    this._isAllMuted = false;
    this._isMuted = false;
    this._currentFeedbackLayout = null;
    this._currentLayoutSettingsKey = null;
    this._albumArtImageKey = null;
    this._albumArtDataUri = TransparentPixel;

    this.refreshVolumeDisabledIcon();

    // The native Title field has no effect on this action's actual display
    // (UserTitleEnabled is false in the manifest, and title text is fully
    // handled through the Screen settings instead), so it's set to a plain
    // label rather than left blank and misleadingly editable-looking
    this.setTitle("Disabled");

    // Reflect the persisted Button Press setting in the legend right away;
    // without this, a fresh load shows the manifest's static default text
    // until the user happens to touch a setting for the first time
    this.updateTriggerDescription();
  }

  // ********************************************
  // * Properties
  // ********************************************
  get actionUuid() {
    return ACTION_UUID;
  }

  /**
   * Whether this action collapses to Stream Deck's minimal built-in
   * layout ("$A1", title + N/A, no album art/progress) when the active
   * zone has no volume control. False by default -- title, album art, and
   * progress bar are all independent of volume data, so there's no actual
   * need to hide them just because the volume-specific portion (icon,
   * value, bar) can't be shown. Kept as an overridable flag in case a
   * future action variant genuinely does need the fully-collapsed
   * behavior, but neither Adjust Volume nor Player Controls do.
   */
  get collapseWhenVolumeUnavailable() {
    return false;
  }

  /**
   * Whether this action's icon area swaps to the Volume-Disabled icon when
   * the active zone has no volume control. True by default (Adjust
   * Volume's icon area is inherently about volume, so showing the normal
   * branding/mute icon there when volume can't even be adjusted would be
   * misleading). Player Controls overrides this to false, since it works
   * perfectly well regardless of whether this zone's volume happens to be
   * controllable, and should keep showing its normal icon either way.
   */
  get showVolumeDisabledIconWhenUnavailable() {
    return true;
  }

  get isAllMuted() {
    return this._isAllMuted;
  }

  set isAllMuted(value) {
    if (value !== this._isAllMuted) {
      this._isAllMuted = value === true;
    }
  }

  get isMuted() {
    return this._isMuted;
  }

  set isMuted(value) {
    if (value !== this._isMuted) {
      this._isMuted = value === true;
    }
  }

  // ********************************************
  // * Private methods, event handlers
  // ********************************************
  onDialUp(data) {
    super.onDialUp(data);

    this.performPrimaryPress(data);
  }

  onDialRotate(data) {
    super.onDialRotate(data);

    if(data.hasOwnProperty("ticks")) {
      this.setVolume(data.ticks);
    }
  }

  onTouchTap(data) {
    super.onTouchTap(data);

    if (data.hold === true) {
      if(this.settings.buttonPressMode === "playpause") {
        // Muting every zone doesn't make sense as a side effect of a
        // dial that's primarily being used for playback control
        this.toggleMute(data);
      } else {
        this.toggleMuteAll(data);
      }
    } else {
      this.performPrimaryPress(data);
    }
  }

  /**
   * The short press / tap action, either mute (the original behavior) or
   * play/pause, depending on the Button Press setting.
   */
  performPrimaryPress(data) {
    if(this.settings.buttonPressMode === "playpause") {
      this.transportControl("playpause");
    } else {
      this.toggleMute(data);
    }
  }

  onRoonActiveOutputChanged(activeOutput) {
    super.onRoonActiveOutputChanged(activeOutput);

    // Show Logo only governs whether the touchscreen reclaims the icon's
    // space; the physical button has no such trade-off, so it always
    // shows the Roon branding regardless of that setting
    if (activeOutput !== null && activeOutput.volume) {
      this.isMuted = activeOutput.volume.isMuted === true;
      this.setImage(this.isMuted ? MuteOnDialImage : RoonEncoderKeyFeedback);
    } else {
      this.isMuted = false;
      this.setImage(RoonEncoderKeyFeedback);
    }

    if(activeOutput) {
      const payload = {};

      if(activeOutput.volume || !this.collapseWhenVolumeUnavailable) {
        this.ensureLayout("normal");

        const showLogo = this.settings.showLogo !== false;
        const titleMode = this.settings.titleMode || "output";
        const twoRowTitle = titleMode === "track" && !showLogo;
        const textColor = this.settings.textColor || "#ffffff";

        if(twoRowTitle) {
          const lines = this.getDisplayTitleLines(activeOutput);
          payload.displayTitle = { value: lines.line1, color: textColor };
          payload.songTitle = { value: lines.line2, color: textColor };
        } else {
          payload.displayTitle = { value: this.getDisplayTitleText(activeOutput), color: textColor };
        }

        // Keep album art in sync with the currently playing track, if enabled
        const showAlbumArt = this.settings.showAlbumArt === true;
        const imageKey = showAlbumArt ? activeOutput.imageKey : null;
        if(imageKey !== this._albumArtImageKey) {
          this._albumArtImageKey = imageKey;
          if(imageKey) {
            this.fetchAlbumArt(imageKey);
          } else {
            this._albumArtDataUri = TransparentPixel;
          }
        }
        payload.background = showAlbumArt ? this._albumArtDataUri : TransparentPixel;

        const hasVolume = !!activeOutput.volume;

        if(hasVolume) {
          // Show "MUTED" in red instead of the volume value when muted (this
          // is a status indicator, so it stays red regardless of Text Color)
          payload.value = this.isMuted
            ? { value: "MUTED", color: "#ff3b30" }
            : { value: this.formatVolume(activeOutput.volume), color: textColor };

          // Convert the volume value to a number between 0-100 for the indicator
          const range = activeOutput.volume.max - activeOutput.volume.min;
          const value = activeOutput.volume.value - activeOutput.volume.min;
          const percent = (value / range) * 100;

          const progressBarMode = this.settings.progressBarMode || "off";

          // Volume-level bar: shown in "off" and "separate" modes
          if(progressBarMode === "off" || progressBarMode === "separate") {
            payload.indicator = {
              value: parseInt(percent, 10),
              enabled: true,
            };
            payload.range = {
              min: activeOutput.volume.min,
              max: activeOutput.volume.max,
            };
          }
        } else {
          // This zone has no volume control. Actions that collapse to the
          // minimal disabled layout in this situation (Adjust Volume, whose
          // whole purpose is volume) never reach this branch -- see below.
          // Actions that don't collapse (Player Controls) still need a
          // value shown here, since there's no volume to display, and the
          // bar/indicator explicitly cleared so it doesn't keep showing
          // whatever level it was last set to.
          payload.value = { value: "N/A", color: textColor };
          payload.indicator = { value: 0, enabled: false };
        }

        const progressBarModeForLayout = this.settings.progressBarMode || "off";

        // Playback progress bar: shown in "replace" and "separate" modes,
        // independent of volume availability
        if(progressBarModeForLayout === "replace" || progressBarModeForLayout === "separate") {
          this.updateProgressBaseline(activeOutput);
          payload.progress = this.getProgressPercent();
        }

        // Icon is omitted from the layout entirely when Show Logo is off
        // (see buildLayout), so only send a value for it when it exists.
        // When volume is unavailable, actions that care about that (Adjust
        // Volume, whose icon area is inherently about volume) swap to the
        // Volume-Disabled icon instead of the usual branding/mute icon;
        // actions that don't (Player Controls, which works fine regardless
        // of whether this zone's volume is controllable) keep the normal
        // icon exactly as if volume were available.
        if(showLogo) {
          if(!hasVolume && this.showVolumeDisabledIconWhenUnavailable) {
            payload.icon = this._volumeDisabledIcon;
          } else {
            payload.icon = this.isMuted ? MuteOnDialImage : RoonEncoderFeedback;
          }
        }
      } else {
        this.ensureLayout("disabled");
        payload.displayTitle = activeOutput.displayName;
        payload.value = "N/A";
        payload.icon = this._volumeDisabledIcon;
      }

      this.setFeedback(payload);
    }
  }

  refreshVolumeDisabledIcon() {
    this._volumeDisabledIcon = this.cacheStyledPngIcon("volume-disabled", VolumeDisabledEncoderFeedback);
  }

  refreshStyledIcon() {
    this.refreshVolumeDisabledIcon();
  }

  onSettingsUpdated(settings) {
    super.onSettingsUpdated(settings);

    // Force the layout to be rebuilt on the next update, since opacity/enabled
    // values are baked into the layout definition itself, not sent as a
    // per-update field. A plain settings change (no output/mute change) won't
    // otherwise trigger onRoonActiveOutputChanged, so nudge it here.
    this._currentFeedbackLayout = null;
    this.onRoonActiveOutputChanged(this.roonActiveOutput);

    this.updateTriggerDescription();
  }

  updateTriggerDescription() {
    const isPlayPause = this.settings.buttonPressMode === "playpause";
    this.setTriggerDescription({
      rotate: "Adjust volume",
      push: isPlayPause ? "Play/Pause" : "Mute/unmute",
      touch: isPlayPause ? "Play/Pause" : "Mute/unmute",
      longTouch: isPlayPause ? "Mute/unmute" : "Mute/unmute all zones",
    });
  }

  // ********************************************
  // * Private methods
  // ********************************************
  /**
   * Records current position, track length, and play state as a baseline
   * to estimate progress from between the periodic timer ticks, rather
   * than needing a constant stream of position updates from Roon.
   */
  getDisplayTitleText(activeOutput) {
    const titleMode = this.settings.titleMode || "output";

    if(titleMode === "off") {
      return "";
    }

    if(titleMode === "track" && activeOutput.artistName && activeOutput.songName) {
      return `${activeOutput.artistName} - ${activeOutput.songName}`;
    }

    // Falls back to the output name for "output" mode, or for "track" mode
    // when nothing is currently playing / no track metadata is available
    return activeOutput.displayName;
  }

  /**
   * Used instead of getDisplayTitleText when showing artist and song on
   * two separate rows (only relevant when titleMode is "track").
   */
  getDisplayTitleLines(activeOutput) {
    if(activeOutput.artistName && activeOutput.songName) {
      return { line1: activeOutput.artistName, line2: activeOutput.songName };
    }

    // Nothing playing / no track metadata: fall back to the output name on
    // the first line and leave the second blank
    return { line1: activeOutput.displayName, line2: "" };
  }

  ensureLayout(mode) {
    const settingsKey = this.getLayoutSettingsKey();

    if(this._currentFeedbackLayout !== mode || this._currentLayoutSettingsKey !== settingsKey) {
      if(mode === "normal") {
        this.setFeedbackLayout(this.buildLayout());
      } else {
        this.setFeedbackLayout("$A1");
      }
      this._currentFeedbackLayout = mode;
      this._currentLayoutSettingsKey = settingsKey;
    }
  }

  getLayoutSettingsKey() {
    const settings = this.settings || {};
    return [
      settings.showAlbumArt === true,
      settings.showLogo !== false,
      settings.albumArtTransparency,
      settings.uiTransparency,
      settings.progressBarMode || "off",
      settings.titleMode || "output",
      settings.barColor || "#ffffff",
    ].join("|");
  }

  buildLayout() {
    const settings = this.settings || {};
    const albumArtOpacity = this.toOpacity(settings.albumArtTransparency, 50);
    const uiOpacity = this.toOpacity(settings.uiTransparency, 100);
    const progressBarMode = settings.progressBarMode || "off";
    const showLogo = settings.showLogo !== false;

    const background = {
      key: "background",
      type: "pixmap",
      rect: [0, 0, 200, 100],
      zOrder: 0,
      opacity: albumArtOpacity,
    };

    // A plain filled bar (no triangle indicator), now the shared style for
    // every bar in the layout, volume level included
    const cleanBarStyle = {
      type: "bar",
      subtype: 0,
      border_w: 0,
      bar_bg_c: "#404040",
      bar_fill_c: settings.barColor || "#ffffff",
    };

    const title = (rect, fontSize) => ({
      key: "displayTitle",
      type: "text",
      rect,
      font: { size: fontSize, weight: 600 },
      alignment: "center",
      "text-overflow": "ellipsis",
      zOrder: 1,
      opacity: uiOpacity,
    });

    const titleLine2 = (rect, fontSize) => ({
      key: "songTitle",
      type: "text",
      rect,
      font: { size: fontSize, weight: 600 },
      alignment: "center",
      "text-overflow": "ellipsis",
      zOrder: 1,
      opacity: uiOpacity,
    });

    const icon = (rect) => ({
      key: "icon",
      type: "pixmap",
      rect,
      zOrder: 1,
      opacity: uiOpacity,
    });

    const valueText = (rect, fontSize = 24) => ({
      key: "value",
      type: "text",
      rect,
      font: { size: fontSize, weight: 600 },
      alignment: showLogo ? "right" : "center",
      zOrder: 1,
      opacity: uiOpacity,
    });

    const progressBar = (rect) => ({
      key: "progress",
      rect,
      value: 0,
      zOrder: 1,
      opacity: uiOpacity,
      ...cleanBarStyle,
    });

    const volumeBar = (rect) => ({
      key: "indicator",
      rect,
      value: 0,
      zOrder: 1,
      opacity: uiOpacity,
      ...cleanBarStyle,
    });

    // The value text and any bar sharing the icon's row use this to either
    // sit in the narrower space beside the icon, or expand to reclaim the
    // full width when the icon is hidden
    const sideRect = (y, height) => showLogo ? [76, y, 108, height] : [16, y, 168, height];

    const iconItem = showLogo ? [icon([16, 40, 48, 48])] : [];
    const iconItemSeparate = showLogo ? [icon([16, 42, 48, 48])] : [];

    // Artist / song on two separate rows instead of one combined line, only
    // possible with the icon out of the way, freeing the vertical room the
    // icon's 48px height otherwise forces
    const titleMode = settings.titleMode || "output";
    const twoRowTitle = titleMode === "track" && !showLogo;

    let items;

    if(progressBarMode === "separate") {
      if(twoRowTitle) {
        items = [
          background,
          title([16, 3, 168, 21], 18),
          titleLine2([16, 24, 168, 21], 18),
          progressBar([16, 47, 168, 6]),
          valueText(sideRect(55, 26), 18),
          volumeBar(sideRect(81, 10)),
        ];
      } else {
        // Title (original size) / thin progress row / icon + value / volume bar
        items = [
          background,
          title([16, 10, 168, 20], 16),
          progressBar([16, 32, 168, 6]),
          ...iconItemSeparate,
          valueText(sideRect(42, 32)),
          volumeBar(sideRect(76, 10)),
        ];
      }
    } else if(progressBarMode === "replace") {
      if(twoRowTitle) {
        items = [
          background,
          title([16, 3, 168, 21], 18),
          titleLine2([16, 24, 168, 21], 18),
          progressBar(sideRect(47, 8)),
          valueText(sideRect(57, 34), 24),
        ];
      } else {
        // Same three-row shape as normal, but the value/bar rows swap, and
        // the bar shows progress instead of volume
        items = [
          background,
          title([16, 10, 168, 24], 16),
          ...iconItem,
          progressBar(sideRect(40, 10)),
          valueText(sideRect(54, 34)),
        ];
      }
    } else {
      if(twoRowTitle) {
        items = [
          background,
          title([16, 5, 168, 21], 18),
          titleLine2([16, 26, 168, 21], 18),
          valueText(sideRect(49, 32), 24),
          volumeBar(sideRect(81, 10)),
        ];
      } else {
        // Normal
        items = [
          background,
          title([16, 10, 168, 24], 16),
          ...iconItem,
          valueText(sideRect(40, 32)),
          volumeBar(sideRect(74, 10)),
        ];
      }
    }

    return {
      id: `volume-layout-dynamic-${progressBarMode}-${showLogo}-${twoRowTitle}`,
      items,
    };
  }

  /**
   * Converts a 0-100 transparency setting into the 0..1 (in steps of 0.1)
   * opacity value the Stream Deck layout schema expects.
   */
  toOpacity(transparencySetting, defaultValue) {
    const raw = transparencySetting !== undefined ? transparencySetting : defaultValue;
    const percent = Math.max(0, Math.min(100, Math.round(Number(raw) / 10) * 10));
    return Math.round(percent) / 100;
  }

  fetchAlbumArt(imageKey) {
    const targetWidth = 400;
    const targetHeight = 200;
    const fetchSize = 400; // request a large square-ish box so we get the full, undistorted source image

    if(this.roonCore && imageKey) {
      this.roonCore.services.RoonApiImage.get_image(
        imageKey,
        { scale: "fit", width: fetchSize, height: fetchSize, format: "image/jpeg" },
        (err, contentType, body) => {
          // Bail out if a newer image request has since superseded this one
          if(imageKey !== this._albumArtImageKey) {
            return;
          }

          if(err) {
            log(`"${this.actionUuid}" album art retrieval error: ${err}`);
            this._albumArtDataUri = TransparentPixel;
            this.onRoonActiveOutputChanged(this.roonActiveOutput);
            return;
          }

          const blob = new Blob([ body ], { type: contentType });
          createImageBitmap(blob).then((image) => {
            const canvas = document.createElement("canvas");
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const canvasContext = canvas.getContext("2d");

            // Center-crop the source image to cover the target rect
            // (equivalent to CSS background-size: cover), instead of
            // stretching it to fit
            const targetAspect = targetWidth / targetHeight;
            const sourceAspect = image.width / image.height;
            let sx, sy, sw, sh;

            if(sourceAspect > targetAspect) {
              // Source is relatively wider than target: crop the sides
              sh = image.height;
              sw = sh * targetAspect;
              sx = (image.width - sw) / 2;
              sy = 0;
            } else {
              // Source is relatively taller than target (typical for 1:1
              // album art against this 2:1 tile): crop the top and bottom
              sw = image.width;
              sh = sw / targetAspect;
              sx = 0;
              sy = (image.height - sh) / 2;
            }

            canvasContext.drawImage(image, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);

            this._albumArtDataUri = canvas.toDataURL("image/png");
            this.onRoonActiveOutputChanged(this.roonActiveOutput);
          }).catch((decodeErr) => {
            log(`"${this.actionUuid}" album art decode error: ${decodeErr}`);
            if(imageKey === this._albumArtImageKey) {
              this._albumArtDataUri = TransparentPixel;
              this.onRoonActiveOutputChanged(this.roonActiveOutput);
            }
          });
        }
      );
    } else {
      // roonCore isn't ready yet (can happen briefly on a fresh plugin
      // start, or right after a Roon reconnect). Reset the tracked key so
      // the next onRoonActiveOutputChanged call sees a mismatch again and
      // retries naturally, instead of this track's art being silently
      // marked "handled" with nothing actually fetched.
      this._albumArtImageKey = null;
    }
  }

  setVolume(ticks) {
    const activeOutput = this.roonActiveOutput;

    if (activeOutput !== null && activeOutput.outputId !== null) {
      let step =
        activeOutput.volume && activeOutput.volume.step !== undefined
          ? activeOutput.volume.step
          : 1;

      step = step * ticks;

      this.roonTransport.change_volume(
        activeOutput.outputId,
        "relative_step",
        step,
        (err) => {
          if (err) {
            log(`"${this.actionUuid}" volume change error: ${err}`);
            this.showAlert();
          }
        }
      );
    } else {
      log(`"${this.actionUuid}" volume change error: No active output`);
      this.showAlert();
    }
  }

  toggleMute(data) {
    const outputId = this.getActiveRoonOutputId();

    if (this.roonTransport === null) {
      log(`"${this.actionUuid}" transport control not available`);
      this.showAlert();
      return;
    }

    if (outputId !== null) {
      const mute = !this.isMuted;
      this.roonTransport.mute(outputId, mute ? "mute" : "unmute", (err) => {
        if (err) {
          log(`"${this.actionUuid}" mute change error: ${err}`);
          this.showAlert();
        }
      });
    } else {
      log(`"${this.actionUuid}" mute change error: No active output`);
      this.showAlert();
    }
  }

  toggleMuteAll(data) {
    if (this.roonTransport === null) {
      log(`"${this.actionUuid}" transport control not available`);
      this.showAlert();
      return;
    }

    const mute = !this.isAllMuted;
    this.roonTransport.mute_all(mute ? "mute" : "unmute", (err) => {
      if (err) {
        log(`"${this.actionUuid}" mute all change error: ${err}`);
        this.showAlert();
      } else {
        this.isAllMuted = mute;
      }
    });
  }

  formatVolume(volume) {
    const type = volume.type === "db" ? " dB" : "";

    return `${volume.value}${type}`;
  }
}
