import PlayPauseAction from "./PlayPauseAction";
import PlayAction from "./PlayAction";
import PauseAction from "./PauseAction";
import PlayItemAction from "./PlayItemAction";
import PlayThisAction from "./PlayThisAction";
import StopAction from "./StopAction";
import PreviousAction from "./PreviousAction";
import NextAction from "./NextAction";
import VolumeUpAction from "./VolumeUpAction";
import VolumeDownAction from "./VolumeDownAction";
import VolumeEncoderAction from "./VolumeEncoderAction";
import PlayerControlsAction from "./PlayerControlsAction";
import VolumeSetAction from "./VolumeSetAction";
import MuteUnmuteAction from "./MuteUnmuteAction";
import LoopAllAction from "./LoopAllAction";
import LoopOneAction from "./LoopOneAction";
import RoonRadioAction from "./RoonRadioAction";
import ShuffleAction from "./ShuffleAction";

export default class ActionFactory {
  static createAction(config) {
    const { actionUuid } = config;
    let result = null;

    switch (actionUuid) {
      case "com.vulkan.roon-dialed-up.play-pause":
        result = new PlayPauseAction(config);
        break;
      case "com.vulkan.roon-dialed-up.play":
        result = new PlayAction(config);
        break;
      case "com.vulkan.roon-dialed-up.pause":
        result = new PauseAction(config);
        break;
      case "com.vulkan.roon-dialed-up.play-this":
        result = new PlayThisAction(config);
        break;
      case "com.vulkan.roon-dialed-up.play-item":
        result = new PlayItemAction(config);
        break;
      case "com.vulkan.roon-dialed-up.stop":
        result = new StopAction(config);
        break;
      case "com.vulkan.roon-dialed-up.previous":
        result = new PreviousAction(config);
        break;
      case "com.vulkan.roon-dialed-up.next":
        result = new NextAction(config);
        break;
      case "com.vulkan.roon-dialed-up.volume-up":
        result = new VolumeUpAction(config);
        break;
      case "com.vulkan.roon-dialed-up.volume-down":
        result = new VolumeDownAction(config);
        break;
      case "com.vulkan.roon-dialed-up.volume-encoder":
        result = new VolumeEncoderAction(config);
        break;
      case "com.vulkan.roon-dialed-up.player-controls":
        result = new PlayerControlsAction(config);
        break;
      case "com.vulkan.roon-dialed-up.volume-set":
        result = new VolumeSetAction(config);
        break;
      case "com.vulkan.roon-dialed-up.mute-unmute":
        result = new MuteUnmuteAction(config);
        break;
      case "com.vulkan.roon-dialed-up.loop-all":
        result = new LoopAllAction(config);
        break;
      case "com.vulkan.roon-dialed-up.loop-one":
        result = new LoopOneAction(config);
        break;
      case "com.vulkan.roon-dialed-up.roon-radio":
        result = new RoonRadioAction(config);
        break;
      case "com.vulkan.roon-dialed-up.shuffle":
        result = new ShuffleAction(config);
        break;
      default:
        console.error(`Unsupported action "${actionUuid}" requested.`);
        break;
    }

    return result;
  }
}