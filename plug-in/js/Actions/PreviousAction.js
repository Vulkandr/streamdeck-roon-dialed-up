import RepeatingActionBase from "./RepeatingActionBase";
import debug from "debug";
import { PreviousDisabled } from "../DataImages/previous-key-disabled";

const ACTION_NAME = "previous";
const ACTION_UUID = `com.vulkan.roon-dialed-up.${ACTION_NAME}`;

const log = debug(`action:${ACTION_NAME}`);

export default class PreviousAction extends RepeatingActionBase {
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
    return "previous";
  }

  // ********************************************
  // * Private methods, event handlers
  // ********************************************
  onTriggerAction(data, triggerCount) {
    super.onTriggerAction(data);

    if(triggerCount === 0) {
      this.transportControl("previous");
    } else {
      if(this.roonActiveOutput && this.roonActiveOutput.isSeekAllowed) {

        let amount = triggerCount;
        if(triggerCount < 3) {
          amount = 5;
        } else {
          amount = Math.pow(2, triggerCount);
        }

        // Guardrails
        amount = Math.min(amount, 45);
        this.transportSeek("relative", -amount);
      }
    }
  }

  onRoonActiveOutputChanged(activeOutput) {
    super.onRoonActiveOutputChanged(activeOutput);

    if(activeOutput !== null && activeOutput.isPreviousAllowed === true) {
      this.setImage(this.getStyledImage());
    } else {
      this.setImage(this.getDisabledImageWhenRequested());
    }
  }

  // ********************************************
  // * Private methods
  // ********************************************
  getDisabledImage() {
    return PreviousDisabled;
  }
}
