import VolumeEncoderAction from "./VolumeEncoderAction";
import debug from "debug";

const ACTION_NAME = "player-controls";
const ACTION_UUID = `com.vulkan.roon-dialed-up.${ACTION_NAME}`;

const log = debug(`action:${ACTION_NAME}`);

/**
 * Play/pause, previous/next track, and mute-this-zone on hold. Shares the
 * entire Screen settings system (album art, title modes, progress bar,
 * transparency, colors) with VolumeEncoderAction via inheritance, so any
 * change made there (aside from control behavior and the Show Volume
 * layout below) applies here too automatically.
 */
export default class PlayerControlsAction extends VolumeEncoderAction {
  // ********************************************
  // * Properties
  // ********************************************
  get actionUuid() {
    return ACTION_UUID;
  }

  get showVolumeDisabledIconWhenUnavailable() {
    return false;
  }

  // ********************************************
  // * Private methods, event handlers
  // ********************************************
  updateTriggerDescription() {
    // Player Controls' push/touch behavior is fixed (always Play/Pause),
    // unlike Adjust Volume where it's user-selectable, so there's nothing
    // to update here, this override just prevents the inherited logic
    // from incorrectly relabeling it based on a setting this action
    // doesn't have.
  }

  onDialRotate(data) {
    log("dialRotate");

    if(data.hasOwnProperty("ticks")) {
      if(data.ticks < 0) {
        this.transportControl("previous");
      } else if(data.ticks > 0) {
        this.transportControl("next");
      }
    }
  }

  onDialUp(data) {
    log("dialUp");

    this.transportControl("playpause");
  }

  onTouchTap(data) {
    log("touchTap");

    if(data.hold === true) {
      this.toggleMute(data);
    } else {
      this.transportControl("playpause");
    }
  }

  getLayoutSettingsKey() {
    const settings = this.settings || {};
    return `${super.getLayoutSettingsKey()}|${settings.showVolume !== false}`;
  }

  buildLayout() {
    const settings = this.settings || {};

    if(settings.showVolume === false) {
      return this.buildCenteredLayout();
    }

    return super.buildLayout();
  }

  /**
   * Used when Show Volume is off: no icon, no dB number, no volume bar,
   * just the title (and progress bar, if enabled) centered as a block in
   * the space that would otherwise be split between the title row and the
   * icon/value/bar row. Font sizes match the normal layout exactly, only
   * the vertical position changes.
   */
  buildCenteredLayout() {
    const settings = this.settings || {};
    const uiOpacity = this.toOpacity(settings.uiTransparency, 100);
    const albumArtOpacity = this.toOpacity(settings.albumArtTransparency, 50);
    const progressBarMode = settings.progressBarMode || "off";
    const titleMode = settings.titleMode || "output";
    const showLogo = settings.showLogo !== false;
    const twoRowTitle = titleMode === "track" && !showLogo;
    const hasProgress = progressBarMode !== "off";

    const background = {
      key: "background",
      type: "pixmap",
      rect: [0, 0, 200, 100],
      zOrder: 0,
      opacity: albumArtOpacity,
    };

    const cleanBarStyle = {
      type: "bar",
      subtype: 0,
      border_w: 0,
      bar_bg_c: "#404040",
      bar_fill_c: settings.barColor || "#ffffff",
    };

    const items = [ background ];
    const titleHeight = twoRowTitle ? 21 : 24;
    const titleFont = twoRowTitle ? 18 : 16;
    const titleBlockHeight = twoRowTitle ? titleHeight * 2 : titleHeight;
    const blockHeight = hasProgress ? titleBlockHeight + 8 + 10 : titleBlockHeight;
    const top = Math.round((100 - blockHeight) / 2);

    items.push({
      key: "displayTitle",
      type: "text",
      rect: [ 16, top, 168, titleHeight ],
      font: { size: titleFont, weight: 600 },
      alignment: "center",
      "text-overflow": "ellipsis",
      zOrder: 1,
      opacity: uiOpacity,
    });

    if(twoRowTitle) {
      items.push({
        key: "songTitle",
        type: "text",
        rect: [ 16, top + titleHeight, 168, titleHeight ],
        font: { size: titleFont, weight: 600 },
        alignment: "center",
        "text-overflow": "ellipsis",
        zOrder: 1,
        opacity: uiOpacity,
      });
    }

    if(hasProgress) {
      items.push({
        key: "progress",
        rect: [ 16, top + titleBlockHeight + 8, 168, 10 ],
        value: 0,
        zOrder: 1,
        opacity: uiOpacity,
        ...cleanBarStyle,
      });
    }

    return {
      id: `player-controls-layout-centered-${progressBarMode}-${twoRowTitle}`,
      items,
    };
  }
}
