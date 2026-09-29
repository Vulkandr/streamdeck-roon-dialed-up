import streamDeck from "@elgato/streamdeck";

import { PlayerControlsAction, VolumeEncoderAction } from "./actions/encoder-actions";
import { PlayAction, PlayPauseAction } from "./actions/play-actions";
import { PlayItemAction, PlayThisAction } from "./actions/play-item-actions";
import { SearchAction } from "./actions/search";
import { NextAction, PauseAction, PreviousAction, StopAction, VolumeDownAction, VolumeUpAction } from "./actions/simple-actions";
import { StatusAction } from "./actions/status";
import { LaunchAppAction } from "./actions/launch-app";
import { LoopAllAction, LoopOneAction, MuteUnmuteAction, RoonRadioAction, ShuffleAction } from "./actions/toggle-actions";
import { VolumeSetAction } from "./actions/volume-set";
import { startGlobalSettings } from "./global-settings";
import { startPropertyInspectorBridge } from "./pi-bridge";
import { reportFatalError, startRoonConnection } from "./roon-connection";

const log = streamDeck.logger.createScope("plugin");

// Default level (info): trace also logs every message crossing the
// Stream Deck socket, including the key images, which floods the log.

// Without a listener attached, an uncaught exception anywhere in this
// process (including inside a callback deep in the Roon SDK) kills the
// whole plugin silently. Keep the process alive and route the error into
// the on-device Status action instead.
process.on("uncaughtException", (err) => {
	log.error(`uncaughtException: ${err?.stack ?? err}`);
	reportFatalError(err);
});

process.on("unhandledRejection", (reason) => {
	log.error(`unhandledRejection: ${reason instanceof Error ? reason.stack : reason}`);
	reportFatalError(reason);
});

// Keys
streamDeck.actions.registerAction(new PlayPauseAction());
streamDeck.actions.registerAction(new PlayAction());
streamDeck.actions.registerAction(new PauseAction());
streamDeck.actions.registerAction(new PlayItemAction());
streamDeck.actions.registerAction(new PlayThisAction());
streamDeck.actions.registerAction(new StopAction());
streamDeck.actions.registerAction(new PreviousAction());
streamDeck.actions.registerAction(new NextAction());
streamDeck.actions.registerAction(new VolumeUpAction());
streamDeck.actions.registerAction(new VolumeDownAction());
streamDeck.actions.registerAction(new VolumeSetAction());
streamDeck.actions.registerAction(new MuteUnmuteAction());
streamDeck.actions.registerAction(new ShuffleAction());
streamDeck.actions.registerAction(new LoopOneAction());
streamDeck.actions.registerAction(new LoopAllAction());
streamDeck.actions.registerAction(new RoonRadioAction());

// Dials
streamDeck.actions.registerAction(new VolumeEncoderAction());
streamDeck.actions.registerAction(new PlayerControlsAction());

// Roon: Toasted link-outs, and the diagnostic Status key
streamDeck.actions.registerAction(new LaunchAppAction());
streamDeck.actions.registerAction(new SearchAction());
streamDeck.actions.registerAction(new StatusAction());

// Settings panel messaging (Core card, Core picker, output list, globals).
startPropertyInspectorBridge();

// Finally, connect to the Stream Deck, then load shared settings and kick
// off Roon Core discovery.
streamDeck.connect();
// Roon's saved pairing state lives in the global settings, so those load
// first; then the connection starts.
void startGlobalSettings().then(() => startRoonConnection());
