import debug from "debug";
import { renderIconSvg, renderIconPng } from "../IconRenderer";
import { IconCells } from "../IconCells";

const log = debug("action:base");

export default class ActionBase {
  // ********************************************
  // * Constructors
  // ********************************************
  constructor({
    streamDeck,
    roonCore,
    roonOutputs,
    actionUuid,
    context,
    settings,
    parent,
  } = {}) {
    // Bind and save bound event handlers
    this.onStreamDeckMessage = this.onStreamDeckMessage.bind(this);

    // Initialize internal state
    this._actionUuid = actionUuid;
    this._context = context;
    this.settings = settings || {};
    this.streamDeck = streamDeck;
    this.roonCore = roonCore;
    this.roonActiveOutput = null;
    this._progressBaseSeekPosition = 0;
    this._progressBaseTimestamp = 0;
    this._progressTrackLength = 0;
    this._progressState = null;
    this.roonOutputs = roonOutputs;
    this._parent = parent;
  }

  // ********************************************
  // * Properties
  // ********************************************
  get actionUuid() {
    return this._actionUuid;
  }

  get context() {
    return this._context;
  }

  get parent() {
    return this._parent;
  }

  get roonCore() {
    return this._roonCore;
  }

  set roonCore(value) {
    this._roonCore = value;

    if (value !== null) {
      this.roonTransport = this.roonCore.services.RoonApiTransport;
    } else {
      this.roonTransport = null;
    }
  }

  get roonTransport() {
    return this._roonTransport;
  }

  set roonTransport(value) {
    this._roonTransport = value;
  }

  get roonActiveOutput() {
    return this._roonActiveOutput;
  }

  set roonActiveOutput(value) {
    this._roonActiveOutput = value;
    this.onRoonActiveOutputChanged(value);
  }

  get roonOutputs() {
    return this._roonOutputs;
  }

  set roonOutputs(value) {
    if (value !== this._roonOutputs) {
      this._roonOutputs = value;

      // Find and set the active output, if available
      this.roonActiveOutput = this.getRoonOutputByOutputName(
        this.settings.roonOutputName
      );
    }
  }

  get settings() {
    return this._settings;
  }

  set settings(value) {
    this._settings = value;
  }

  get streamDeck() {
    return this._streamDeck;
  }

  set streamDeck(value) {
    if (value !== this._streamDeck) {
      // Check if we should attempt to remove previous event listener(s)
      if (this._streamDeck) {
        this._streamDeck.removeEventListener(
          "message",
          this.onStreamDeckMessage
        );
      }

      this._streamDeck = value;

      // Add event listener(s)
      if (this._streamDeck) {
        this._streamDeck.addEventListener("message", this.onStreamDeckMessage);
      }
    }
  }

  // ********************************************
  // * Public methods
  // ********************************************
  dispose() {
    this.onDispose();
  }

  // ********************************************
  // * Private methods, event handlers
  // ********************************************
  onStreamDeckMessage(message) {
    const data = message.data || {};
    const { action, context, event, payload } = JSON.parse(data);

    // Check if this message was intended for this action
    if (action === this.actionUuid && context === this.context) {
      switch (event) {
        case "dialDown":
          this.onDialDown(payload);
          break;
        case "dialUp":
          this.onDialUp(payload);
          break;
        case "dialRotate":
          this.onDialRotate(payload);
          break;
        case "didReceiveSettings":
          this.onSettingsUpdated(payload.settings);
          break;
        case "keyDown":
          this.onKeyDown(payload);
          break;
        case "keyUp":
          this.onKeyUp(payload);
          break;
        case "touchTap":
          this.onTouchTap(payload);
          break;
      }
    }
  }

  onDialDown(data) {
    log(`${this.actionUuid} dialDown`);
  }

  onDialUp(data) {
    log(`${this.actionUuid} dialUp`);
  }

  onDialRotate(data) {
    log(`${this.actionUuid} dialRotate`);
  }

  onKeyDown(data) {
    log(`${this.actionUuid} keyDown`);
  }

  onKeyUp(data) {
    log(`${this.actionUuid} keyUp`);

    if (!this.roonCore) {
      this.requestRoonConnect();
    }
  }

  onSettingsUpdated(settings) {
    log(`${this.actionUuid} settings updated`, settings);
    this.settings = settings;

    // Find and set the active output, if available
    this.roonActiveOutput = this.getRoonOutputByOutputName(
      settings.roonOutputName
    );
  }

  onTouchTap(data) {
    log(`${this.actionUuid} touchTap`);
  }

  onRoonActiveOutputChanged(activeOutput) {
    // log(`"${this.actionUuid}" activeRoonOutput changed`);
  }

  onDispose() {
    log(`${this.actionUuid} onDispose`);
    this.activeRoonOutput = null;
    this.roonOutputs = null;
    this.roonCore = null;
    this.streamDeck = null;
    this._parent = null;
  }

  /**
   * Re-applies the current icon (shape, style, color) for this action.
   * Called by the parent plugin whenever global settings (Icon Style,
   * Color) change, so every currently-visible action updates immediately
   * rather than waiting for its next unrelated Roon-triggered refresh.
   * The default implementation just re-runs the existing
   * onRoonActiveOutputChanged logic, which already contains each action's
   * correct enabled/disabled branching and setImage() call. Actions with
   * a more involved image pipeline (canvas-composited overlays) override
   * this to re-trigger that pipeline instead.
   */
  refreshStyledIcon() {
    this.onRoonActiveOutputChanged(this.roonActiveOutput);
  }

  // ********************************************
  // * Private methods
  // ********************************************
  toggleDesiredState(data) {
    let result = 0;
    if (Object.prototype.hasOwnProperty.call(data, "userDesiredState")) {
      result = data.userDesiredState;
    } else {
      result = data.state === 0 ? 1 : 0;
    }

    return result;
  }

  /**
   * Shared playback-progress tracking, used by any action that shows a
   * progress bar (Adjust Volume/Player Controls' touchscreen, and Play/
   * Play-Pause's key). Call updateProgressBaseline() whenever the active
   * output's state/seekPosition/trackLength change, then getProgressPercent()
   * whenever a fresh 0-100 value is needed for rendering -- it accounts for
   * time elapsed since the baseline was set, so playback position keeps
   * advancing smoothly between actual Roon updates.
   */
  updateProgressBaseline(activeOutput) {
    this._progressState = activeOutput.state;

    if(activeOutput.seekPosition !== undefined && activeOutput.trackLength) {
      this._progressBaseSeekPosition = activeOutput.seekPosition;
      this._progressBaseTimestamp = Date.now();
      this._progressTrackLength = activeOutput.trackLength;
    } else {
      this._progressTrackLength = 0;
    }
  }

  getProgressPercent() {
    if(!this._progressTrackLength) {
      return 0;
    }

    let elapsedSeconds = this._progressBaseSeekPosition;
    if(this._progressState === "playing") {
      elapsedSeconds += (Date.now() - this._progressBaseTimestamp) / 1000;
    }

    const percent = (elapsedSeconds / this._progressTrackLength) * 100;
    return Math.max(0, Math.min(100, Math.round(percent)));
  }

  getDisabledImageWhenRequested() {
    const disableWhenUnavailable =
      this.settings && this.settings.disableWhenUnavailable == true;

    return this.getStyledImage(disableWhenUnavailable === true);
  }

  getDisabledImage() {
    return undefined;
  }

  /**
   * The dot-matrix icon name this action displays, e.g. "stop", "mute".
   * Actions with two visual states (mute/mute-on, shuffle/shuffle-on, etc.)
   * override this as a dynamic getter reflecting their current toggle state.
   * Returns null for actions that don't participate in the LED icon system
   * (the dial actions, which keep their own separate icon handling).
   */
  get iconName() {
    return null;
  }

  /**
   * Resolves the current icon for this action given the global Icon Style
   * (LED Grid / LED / Classic) and Color (Classic / Custom) settings.
   * Returns undefined for Classic style, or when this action has no
   * iconName, so callers fall back to the manifest's static image exactly
   * as setImage(undefined) always has.
   *
   * @param {boolean} [dimmed] - true for the per-action "disabled when
   *   unavailable" dimmed appearance (an opt-in setting, separate from the
   *   Volume-Disabled icon's own fixed 40% rule).
   */
  /**
   * Same as getStyledImageForIcon(), but returns a real PNG data URI (via
   * pngjs) instead of an SVG string. Used anywhere the result needs to be
   * a genuine bitmap: loaded into an Image() for canvas compositing, or
   * sent as touchscreen feedback (which requires PNG).
   */
  getStyledPngForIcon(iconName, dimmed = false) {
    const globalSettings = (this.parent && this.parent.globalSettings) || {};
    const iconStyle = globalSettings.iconStyle || "ledGrid";

    if (iconStyle === "classic") {
      return undefined;
    }

    if (!iconName) {
      return undefined;
    }

    const cells = IconCells[iconName];
    if (!cells) {
      return undefined;
    }

    const color = globalSettings.customColor || "#ffffff";

    // Volume-Disabled is the one icon in the set that's always two-tone:
    // the speaker stays in whatever color the user picked (dimmed, per
    // FIXED_BRIGHTNESS), but the X drawn over it is always red, a fixed
    // warning indicator, not tied to Icon Style/Color, same idea as the
    // dial's red Mute icon. It also always renders in plain LED (no grid)
    // regardless of the current Icon Style setting -- the always-visible
    // grid just muddies up an already-busy two-element icon, so there's no
    // LED Grid variant of this one, plain LED covers both cases.
    const isVolumeDisabled = iconName === "volume-disabled";
    const overlayCells = isVolumeDisabled ? IconCells["volume-disabled-x"] : undefined;
    const effectiveStyle = isVolumeDisabled ? "led" : iconStyle;

    return renderIconPng(cells, {
      color,
      style: effectiveStyle,
      iconName,
      disabledDim: dimmed ? 0.40 : undefined,
      overlayCells,
      overlayColor: "#ff2d2d",
      overlayBrightness: 0.70,
    });
  }

  /**
   * Loads a styled icon as an Image object, for actions that composite it
   * with a canvas overlay (album art, seek time, volume level text) rather
   * than displaying it directly. Falls back to classicFallbackSrc when
   * Icon Style is set to Classic, matching that style's normal behavior.
   * Always loads a real PNG (never SVG) into the Image object here --
   * SVG through Image()+canvas has no working precedent in this codebase.
   */
  loadStyledImageObject(iconName, classicFallbackSrc, onReady) {
    const src = this.getStyledPngForIcon(iconName) || classicFallbackSrc;
    const img = new Image();
    img.onload = () => {
      onReady({ image: img, width: 144, height: 144 });
    };
    img.src = src;
  }

  /**
   * Resolves a styled icon as a PNG data URI directly, synchronously, for
   * touchscreen feedback (setFeedback's payload.icon), which requires PNG.
   * Falls back to classicFallbackSrc when Icon Style is set to Classic.
   */
  cacheStyledPngIcon(iconName, classicFallbackSrc) {
    return this.getStyledPngForIcon(iconName) || classicFallbackSrc;
  }

  getStyledImage(dimmed = false) {
    return this.getStyledImageForIcon(this.iconName, dimmed);
  }

  /**
   * Same as getStyledImage(), but for an explicitly named icon rather than
   * this.iconName. Used by actions that composite the icon with something
   * else drawn on a canvas (album art, a seek-time or volume-level overlay)
   * and need the base icon as a loadable Image object rather than one tied
   * to this action's own current state.
   */
  getStyledImageForIcon(iconName, dimmed = false) {
    const globalSettings = (this.parent && this.parent.globalSettings) || {};
    const iconStyle = globalSettings.iconStyle || "ledGrid";

    if (iconStyle === "classic") {
      return undefined;
    }

    if (!iconName) {
      return undefined;
    }

    const cells = IconCells[iconName];
    if (!cells) {
      return undefined;
    }

    const color = globalSettings.customColor || "#ffffff";

    return renderIconSvg(cells, {
      color,
      style: iconStyle,
      iconName,
      disabledDim: dimmed ? 0.40 : undefined,
    });
  }

  getRoonOutputByOutputName(outputName) {
    let result = null;

    if (this.roonOutputs !== null && outputName !== undefined) {
      for (const output of this.roonOutputs) {
        if (output.displayName.toLowerCase() === outputName.toLowerCase()) {
          result = output;
          break;
        }
      }
    }

    return result;
  }

  requestRoonConnect() {
    if (this.parent) {
      this.parent.requestRoonCoreReconnect();
    }
  }

  saveSettings() {
    this.sendMessage({
      event: "setSettings",
      context: this.context,
      payload: this.settings,
    });
  }

  setState(state) {
    this.sendMessage({
      event: "setState",
      context: this.context,
      payload: { state },
    });
  }

  showAlert() {
    this.sendMessage({
      event: "showAlert",
      context: this.context,
    });
  }

  showOk() {
    this.sendMessage({
      event: "showOk",
      context: this.context,
    });
  }

  setTitle(text) {
    this.sendMessage({
      event: "setTitle",
      context: this.context,
      payload: {
        title: text,
        target: 0,
      },
    });
  }

  /**
   * Updates the interaction hint text shown for an encoder action (the
   * small "Push: ..." style descriptions). Any key omitted keeps its
   * current value; Stream Deck's own docs note omitting a key entirely
   * hides that hint, so only pass the ones you want to change.
   */
  setTriggerDescription(descriptions) {
    this.sendMessage({
      event: "setTriggerDescription",
      context: this.context,
      payload: descriptions,
    });
  }

  setImage(imageData) {
    this.sendMessage({
      event: "setImage",
      context: this.context,
      payload: {
        image: imageData,
        target: 0,
      },
    });
  }

  transportControl(action) {
    const outputId = this.getActiveRoonOutputId();

    if (this.roonTransport === null) {
      log(`"${this.actionUuid}" transport control not available`);
      this.showAlert();
      return;
    }

    if (outputId !== null) {
      this.roonTransport.control(outputId, action, (err) => {
        if (err) {
          log(`"${this.actionUuid}" transport control error: ${err}`);
          this.showAlert();
        }
      });
    } else {
      log(`"${this.actionUuid}" transport control error: No active output`);
      this.showAlert();
    }
  }

  transportSeek(how, seconds) {
    const outputId = this.getActiveRoonOutputId();

    if (this.roonTransport === null) {
      log(`"${this.actionUuid}" transport seek not available`);
      this.showAlert();
      return;
    }

    if (outputId !== null) {
      this.roonTransport.seek(outputId, how, seconds, (err) => {
        if (err) {
          log(`"${this.actionUuid}" transport seek error: ${err}`);
          this.showAlert();
        }
      });
    } else {
      log(`"${this.actionUuid}" transport seek error: No active output`);
      this.showAlert();
    }
  }

  transportSetting(settings) {
    const outputId = this.getActiveRoonOutputId();

    if (this.roonTransport === null) {
      log(`"${this.actionUuid}" transport control not available`);
      this.showAlert();
      return;
    }

    if (outputId !== null) {
      this.roonTransport.change_settings(outputId, settings, (err) => {
        if (err) {
          log(`"${this.actionUuid}" transport change error: ${err}`);
          this.showAlert();
        }
      });
    } else {
      log(`"${this.actionUuid}" transport change error: No active output`);
      this.showAlert();
    }
  }

  async roonBrowseAndActivate({ outputId, itemType, itemTitle, itemAction }) {
    const browse = this.roonCore.services.RoonApiBrowse;
    let hierarchy = itemType;
    let path = [];
    let itemKey;
    let result = null;

    switch (itemType) {
      case "artists":
        path = [itemTitle, "Play Artist", itemAction, itemAction];
        break;
      case "albums":
        path = [itemTitle, "Play Album", itemAction, itemAction];
        break;
      case "composers":
        path = [itemTitle, "Play Composer", itemAction, itemAction];
        break;
      case "internet_radio":
        path = [itemTitle, itemTitle];
        break;
      case "genres":
        path = [itemTitle, "Play Genre", itemAction, itemAction];
        break;
      case "playlists":
        path = [itemTitle, "Play Playlist", itemAction, itemAction];
        break;
      case "tags":
        hierarchy = "browse";
        path = [
          "Library",
          "Tags",
          itemTitle,
          "Play Tag",
          itemAction,
          itemAction,
        ];
        break;
    }

    let index = 0;
    for (const pathItem of path) {
      index += 1;
      const options = {
        hierarchy,
        zone_or_output_id: outputId,
      };

      if (!itemKey) {
        options.pop_all = true;
      } else {
        options.item_key = itemKey;
      }

      result = await this.browseAndFind(options, pathItem);

      if (result !== null) {
        itemKey = result.item_key;
      } else {
        // Bail if this part wasn't found
        break;
      }
    }

    return index !== 0 && index === path.length;
  }

  async browseAndFind(options, name) {
    const browseResult = await this.roonBrowse(options);
    let result = null;

    if (name && name.length > 0) {
      if (browseResult && browseResult.action === "list") {
        let offset = 0;
        while (!result) {
          const loadResult = await this.roonLoad({
            hierarchy: options.hierarchy,
            outputId: options.outputId,
            offset,
          });

          // console.log(loadResult)

          // Check if this set of results had the item we were looking for
          result = this.findRoonListItem(loadResult, name);

          // Adjust offset and get next page if needed
          offset = offset + loadResult.items.length;
          if (offset >= loadResult.list.count) {
            // No more results
            break;
          }
        }
      }
    } else {
      log("ERROR: name is required");
    }

    return result;
  }

  async roonBrowse(options) {
    return new Promise((resolve, reject) => {
      this.roonCore.services.RoonApiBrowse.browse(options, (err, result) => {
        if (err) {
          reject(new Error(err));
        } else {
          resolve(result);
        }
      });
    });
  }

  async roonLoad(options) {
    return new Promise((resolve, reject) => {
      this.roonCore.services.RoonApiBrowse.load(options, (err, result) => {
        if (err) {
          reject(new Error(err));
        } else {
          resolve(result);
        }
      });
    });
  }

  findRoonListItem(list, title) {
    let result = null;
    if (list && list.items) {
      for (const item of list.items) {
        if (
          item.title &&
          title &&
          item.title.toLowerCase() === title.toLowerCase()
        ) {
          result = item;
          break;
        }
      }
    }

    return result;
  }

  getActiveRoonOutputId() {
    return (this.roonActiveOutput && this.roonActiveOutput.outputId) || null;
  }

  /**
   * Sends a message if Stream Deck is connected.
   *
   * @param      {Object}  message  The message
   */
  sendMessage(message) {
    if (this.streamDeck) {
      // log(`action "${this.actionUuid}" sending message`, message);
      this.streamDeck.send(JSON.stringify(message));
    }
  }

  /**
   * Sets the SD+ touch display feedback.
   *
   * @param {Object} payload The feedback payload
   */
  setFeedback(payload) {
    this.sendMessage({
      event: "setFeedback",
      context: this.context,
      payload,
    });
  }

  /**
   * Sets the SD+ touch display feedback layout.
   *
   * @param {Object} layoutId The layout ID to use
   */
  setFeedbackLayout(layoutId) {
    this.sendMessage({
      event: "setFeedbackLayout",
      context: this.context,
      payload: {
        layout: layoutId,
      },
    });
  }
}
