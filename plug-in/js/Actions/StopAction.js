import ActionBase from "./ActionBase";
import debug from "debug";
import { StopDisabled } from "../DataImages/stop-key-disabled";

const ACTION_NAME = "stop";
const ACTION_UUID = `com.vulkan.roon-dialed-up.${ACTION_NAME}`;

const log = debug(`action:${ACTION_NAME}`);

export default class StopAction extends ActionBase {
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

  // ********************************************
  // * Properties
  // ********************************************
  get iconName() {
    return "stop";
  }

  // ********************************************
  // * Private methods, event handlers
  // ********************************************
  onKeyUp(data) {
    super.onKeyUp(data);

    this.transportControl("stop");
  }

  onRoonActiveOutputChanged(activeOutput) {
    super.onRoonActiveOutputChanged(activeOutput);

    if(activeOutput !== null && activeOutput.state !== "stopped") {
      this.setImage(this.getStyledImage());
    } else {
      this.setImage(this.getDisabledImageWhenRequested());
    }
  }

  // ********************************************
  // * Private methods
  // ********************************************
  getDisabledImage() {
    return StopDisabled;
  }
}
