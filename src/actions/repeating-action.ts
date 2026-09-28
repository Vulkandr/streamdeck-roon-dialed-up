import type { KeyAction, KeyDownEvent, KeyUpEvent } from "@elgato/streamdeck";

import { RoonAction, type RoonKeySettings } from "./roon-action";
import type { RoonOutput } from "../roon-connection";

const INTERVAL_MS = 500;

/**
 * Port of RepeatingActionBase: a tap fires once on release; holding the key
 * fires repeatedly (every half second) with an increasing count, which
 * Next/Previous use to seek and Volume Up/Down use to accelerate.
 */
export abstract class RepeatingAction<TSettings extends RoonKeySettings = RoonKeySettings> extends RoonAction<TSettings> {
	private readonly timers = new Map<string, { interval: NodeJS.Timeout; count: number }>();

	protected abstract onTrigger(action: KeyAction<TSettings>, output: RoonOutput | null, count: number): void;

	override async onKeyDown(ev: KeyDownEvent<TSettings>): Promise<void> {
		this.stop(ev.action.id);
		const entry = { count: 0, interval: undefined as unknown as NodeJS.Timeout };
		entry.interval = setInterval(() => {
			entry.count += 1;
			this.onTrigger(ev.action, this.outputFor(ev.payload.settings), entry.count);
		}, INTERVAL_MS);
		this.timers.set(ev.action.id, entry);
	}

	override async onKeyUp(ev: KeyUpEvent<TSettings>): Promise<void> {
		const entry = this.timers.get(ev.action.id);
		this.stop(ev.action.id);
		// Only a plain tap (no repeats fired yet) triggers on release.
		if (!entry || entry.count === 0) {
			this.onTrigger(ev.action, this.outputFor(ev.payload.settings), 0);
		}
	}

	protected override onKeyRemoved(keyId: string): void {
		this.stop(keyId);
	}

	private stop(keyId: string): void {
		const entry = this.timers.get(keyId);
		if (entry) {
			clearInterval(entry.interval);
			this.timers.delete(keyId);
		}
	}
}

/** Hold-to-seek amount: 5s for the first couple of ticks, then doubling, capped at 45s. */
export function seekAmount(count: number): number {
	const amount = count < 3 ? 5 : Math.pow(2, count);
	return Math.min(amount, 45);
}
