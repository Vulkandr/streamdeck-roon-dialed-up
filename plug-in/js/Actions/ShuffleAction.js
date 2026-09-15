import ActionBase from "./ActionBase";
import debug from "debug";
import { ShuffleDisabled } from "../DataImages/shuffle-key-disabled";

const ACTION_NAME = "shuffle";
const ACTION_UUID = `com.vulkan.roon-dialed-up.${ACTION_NAME}`;

const log = debug(`action:${ACTION_NAME}`);

export default class ShuffleAction extends ActionBase {
  // ********************************************
  // * Constructors
  // ********************************************
  constructor(config) {
    super(config);

    log("ctor");
  }

  // ********************************************
  // * Properties
  // ********************************************
  get actionUuid() {
    return ACTION_UUID;
  }

  get iconName() {
    return this._shuffle ? "shuffle-on" : "shuffle";
  }

  get shuffle() {
    return this._shuffle;
  }

  set shuffle(value) {
    if(value !== this._shuffle) {
      this._shuffle = (value === true);

      this.setState(value === true ? 0 : 1);
    }
  }

  // ********************************************
  // * Private methods, event handlers
  // ********************************************
  onKeyUp(data) {
    super.onKeyUp(data);

    const shuffle = this.toggleDesiredState(data) === 0;
    this.transportSetting({ shuffle });
  }

  onRoonActiveOutputChanged(activeOutput) {
    super.onRoonActiveOutputChanged(activeOutput);

    if(activeOutput !== null) {
      this.shuffle = (activeOutput.shuffle === true);
      this.setImage(this.getStyledImage());
    } else {
      this.shuffle = false;
      this.setImage(this.getDisabledImageWhenRequested());
    }
  }

  // ********************************************
  // * Private methods
  // ********************************************
  getDisabledImage() {
    return ShuffleDisabled;
  }
}
