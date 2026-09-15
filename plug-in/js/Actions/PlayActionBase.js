import ActionBase from "./ActionBase";
import debug from "debug";
import { PlayDisabledImage } from "../DataImages/play-key-disabled";
import { PlayImage } from "../DataImages/play-key";

const ACTION_NAME = "play-base";
const ACTION_UUID = `com.vulkan.roon-dialed-up.${ACTION_NAME}`;

const log = debug(`action:${ACTION_NAME}`);

export default class PlayActionBase extends ActionBase {
  // ********************************************
  // * Constructors
  // ********************************************
  constructor(config) {
    // Super will set Roon Outputs which will trigger some updates
    super(config);

    log("ctor");

    this.loadDefaultPlayImage(config);
  }

  // ********************************************
  // * Properties
  // ********************************************
  get actionUuid() {
    return ACTION_UUID;
  }

  get defaultPauseImageData() {
     return this._defaultPauseImageData;
  }

  get defaultPlayImageData() {
    return this._defaultPlayImageData;
  }

  get iconName() {
    return "play";
  }

  get defaultStopImageData() {
    return this._defaultStopImageData;
  }

  get imageData() {
    return this._imageData;
  }

  set imageData(value) {
    this._imageData = value;
  }

  get imageKey() {
    return this._imageKey;
  }

  set imageKey(value) {
    if(value !== this._imageKey) {
      this._imageKey = value;

      this.onImageKeyChanged(value);
    }
  }

  get pauseTimerInterval() {
    return this._pauseTimerInterval;
  }

  set pauseTimerInterval(value) {
    this._pauseTimerInterval = value;
  }

  get pauseTimerCount() {
    return this._pauseTimerCount;
  }

  set pauseTimerCount(value) {
    this._pauseTimerCount = value;
  }

  get seekPosition() {
    return this._seekPosition;
  }

  set seekPosition(value) {
    if(value !== this._seekPosition) {
      this._seekPosition = value;
      this.renderImage();
    }
  }

  get showCoverArt() {
    return this._showCoverArt;
  }

  set showCoverArt(value) {
    if(value !== this._showCoverArt) {
      this._showCoverArt = (value === true);

      if(value === true) {
        // Trigger cover art refresh
        this.onImageKeyChanged(this.imageKey);
      } else {
        this.renderImage();
      }
    }
  }

  get showArtistTrack() {
    return this._showArtistTrack;
  }

  set showArtistTrack(value) {
    if(value !== this._showArtistTrack) {
      this._showArtistTrack = (value === true);
      this.renderImage();
    }
  }

  get showProgressBar() {
    return this._showProgressBar;
  }

  set showProgressBar(value) {
    if(value !== this._showProgressBar) {
      this._showProgressBar = (value === true);
      this.renderImage();
    }
  }

  get showSeekPosition() {
    return this._showSeekPosition;
  }

  set showSeekPosition(value) {
    if(value !== this._showSeekPosition) {
      this._showSeekPosition = (value === true);
      this.renderImage();
    }
  }

  get state() {
    return this._state;
  }

  set state(value) {
    if(value !== this._state) {
      this._state = value;

      this.setState((value === "playing" || value == "loading") ? 1 : 0);

      if(value === "paused" && !this.pauseTimerInterval) {
        this.pauseTimerCount = 0;
        this.pauseTimerInterval = setInterval(() => {
          this.pauseTimerCount += 1;
          this.renderImage();
        }, 1000);
      } else if(this.pauseTimerInterval) {
        clearInterval(this.pauseTimerInterval);
        this.pauseTimerInterval = undefined;
      }

      this.renderImage();
    }
  }

  // ********************************************
  // * Private methods, event handlers
  // ********************************************
  onSettingsUpdated(settings) {
    super.onSettingsUpdated(settings);

    if(settings) {
      this.showCoverArt = settings.showCoverArt;
      this.showArtistTrack = settings.showArtistTrack;
      this.showProgressBar = settings.showProgressBar;
      this.showSeekPosition = settings.showSeekPosition;
    }
  }

  onKeyUp(data) {
    super.onKeyUp(data);
  }

  onRoonActiveOutputChanged(activeOutput) {
    super.onRoonActiveOutputChanged(activeOutput);

    if(activeOutput !== null) {
      this.state = activeOutput.state;
      this.seekPosition = activeOutput.seekPosition;
      this.imageKey = activeOutput.imageKey;
      this.artistName = activeOutput.artistName;
      this.songName = activeOutput.songName;
      this.updateProgressBaseline(activeOutput);
    } else {
      this.state = undefined;
      this.seekPosition = undefined;
      this.imageKey = null;
      this.artistName = undefined;
      this.songName = undefined;
    }

    this.renderImage();
  }

  onDispose() {
    log("onDispose");
    if(!this.pauseTimerInterval) {
      clearInterval(this.pauseTimerInterval);
      this.pauseTimerInterval = undefined;
    }

    super.onDispose();
  }

  onImageKeyChanged(imageKey) {
    const width = 144;
    const height = 144;

    if(this.roonCore && imageKey) {
      this.roonCore.services.RoonApiImage.get_image(
        imageKey,
        { scale: "fit", width, height, format: "image/jpeg" },
        (err, contentType, body) => {
          if(err) {
            log(`Error retrieving image from Roon: ${err}`);
            this.imageData = null;
            this.renderImage();
          } else {
            const blob = new Blob([ body ], { type: contentType });
            const imagePromise = createImageBitmap(blob);

            imagePromise.then((image) => {
              this.imageData = {
                image,
                width,
                height,
              };

              this.renderImage();
            });
          }
        }
      );
    } else {
      this.imageData = null;
      this.renderImage();
    }
  }

  // ********************************************
  // * Private methods
  // ********************************************
  renderImage() {
    this.renderFinalImage(this.getStateImageData());
  }

  renderFinalImage(imageData) {
    // If we have either a default image or covert art, render with option text items
    if(imageData) {
      const { image, width, height } = imageData;

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const canvasContext = canvas.getContext("2d");

      canvasContext.drawImage(image, 0, 0);

      if(this.showArtistTrack === true && (this.artistName || this.songName)) {
        const lineHeight = 19;
        const topMargin = 17;

        canvasContext.font = "bold 18px Arial";
        canvasContext.textAlign = "center";
        canvasContext.textBaseline = "middle";
        canvasContext.shadowColor = "#000000";
        canvasContext.shadowBlur = 1;
        canvasContext.lineWidth = 3;
        canvasContext.strokeStyle = "#000000";
        canvasContext.fillStyle = "#ffffff";

        const lines = [this.artistName, this.songName].filter((line) => !!line);
        lines.forEach((line, index) => {
          const text = this.truncateToWidth(canvasContext, line, width - 12);
          const y = topMargin + (index * lineHeight);
          canvasContext.strokeText(text, width / 2, y);
          canvasContext.fillText(text, width / 2, y);
        });
      }

      if(this.showProgressBar === true) {
        const barLeft = 10;
        const barWidth = width - 20;
        const barTop = height - 50;
        const barHeight = 5;
        const percent = this.getProgressPercent();

        canvasContext.fillStyle = "rgba(0, 0, 0, 0.55)";
        canvasContext.fillRect(barLeft, barTop, barWidth, barHeight);

        canvasContext.fillStyle = "#ffffff";
        canvasContext.fillRect(barLeft, barTop, barWidth * (percent / 100), barHeight);
      }

      if(this.showSeekPosition === true && this.seekPosition !== undefined && this.seekPosition !== null &&
        (!this.pauseTimerInterval || (this.pauseTimerInterval && this.pauseTimerCount % 2 ===0))) {
        const seekPositionText = this.formatDuration(this.seekPosition);

        canvasContext.font = "32px Arial";
        canvasContext.textAlign = "center";
        canvasContext.textBaseline = "middle";
        canvasContext.shadowColor = "#000000";
        canvasContext.shadowBlur = 1;
        canvasContext.lineWidth = 3;
        canvasContext.strokeStyle = "#000000";
        canvasContext.strokeText(seekPositionText, width / 2, height - 24);
        canvasContext.fillStyle = "#ffffff";
        canvasContext.fillText(seekPositionText, width / 2, height - 24);
      }

      // Set the image on the button
      const dataUri = canvas.toDataURL("image/png");
      this.setImage(dataUri);
    } else {
      this.setImage(this.getDisabledImageWhenRequested());
    }
  }

  getDisabledImage() {
    return PlayDisabledImage;
  }

  loadDefaultPlayImage(config) {
    this.loadStyledImageObject("play", PlayImage, (imageData) => {
      this._defaultPlayImageData = imageData;

      // Trigger image updates based on this Action's custom settings once base image is ready
      this.showCoverArt = config && config.settings && config.settings.showCoverArt;
      this.showArtistTrack = config && config.settings && config.settings.showArtistTrack;
      this.showProgressBar = config && config.settings && config.settings.showProgressBar;
      this.showSeekPosition = config && config.settings && config.settings.showSeekPosition;
      this.renderFinalImage(this.getStateImageData());
    });
  }

  refreshStyledIcon() {
    this.loadDefaultPlayImage({ settings: this.settings });
  }

  truncateToWidth(canvasContext, text, maxWidth) {
    if(canvasContext.measureText(text).width <= maxWidth) {
      return text;
    }

    let truncated = text;
    while(truncated.length > 1 && canvasContext.measureText(`${truncated}…`).width > maxWidth) {
      truncated = truncated.slice(0, -1);
    }

    return `${truncated}…`;
  }

  formatDuration(duration) {
    const secondsInt = Number.parseInt(duration, 10);
    let hours = Math.floor(secondsInt / 3600);
    let minutes = Math.floor((secondsInt - (hours * 3600)) / 60);
    let seconds = secondsInt - (hours * 3600) - (minutes * 60);

    hours = (hours === 0 ? "" : `${hours}:`);
    if(minutes < 10) { minutes = `0${minutes}`; }
    if(seconds < 10) { seconds = `0${seconds}`; }

    return `${hours == "00" ? "" : hours }${minutes}:${seconds}`;
  }
}
