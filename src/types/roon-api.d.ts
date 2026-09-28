// The Roon Labs SDK packages (node-roon-api and friends) are plain
// CommonJS with no published type declarations. Rather than hand-write a
// full surface for a proof-of-concept, these are typed as `any` for now --
// worth writing real types once the full 17-action migration is underway
// and more of the surface (RoonApiBrowse, RoonApiImage, etc.) is in use.
declare module "node-roon-api" {
	const RoonApi: any;
	export default RoonApi;
}

declare module "node-roon-api-transport" {
	const RoonApiTransport: any;
	export default RoonApiTransport;
}

declare module "node-roon-api-status" {
	const RoonApiStatus: any;
	export default RoonApiStatus;
}

// Only used to hand node-roon-api the websocket implementation it was
// written for (see roon-connection.ts); no need for full @types/ws.
declare module "ws" {
	const WebSocket: any;
	export default WebSocket;
}

declare module "node-roon-api-browse" {
	const RoonApiBrowse: any;
	export default RoonApiBrowse;
}

declare module "node-roon-api-image" {
	const RoonApiImage: any;
	export default RoonApiImage;
}

declare module "pngjs" {
	export class PNG {
		constructor(options: { width: number; height: number });
		width: number;
		height: number;
		data: Buffer;
		static sync: { write(png: PNG): Buffer };
	}
}

declare module "opentype.js" {
	export interface Font {
		unitsPerEm: number;
		ascender: number;
		descender: number;
		getAdvanceWidth(text: string, fontSize: number, options?: { kerning?: boolean }): number;
		getPath(text: string, x: number, y: number, fontSize: number, options?: { kerning?: boolean }): { commands: PathCommand[]; toPathData(decimals?: number): string };
	}
	export type PathCommand =
		| { type: "M"; x: number; y: number }
		| { type: "L"; x: number; y: number }
		| { type: "Q"; x1: number; y1: number; x: number; y: number }
		| { type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
		| { type: "Z"; x?: number; y?: number };
	export function parse(buffer: ArrayBuffer): Font;
	const opentype: { parse(buffer: ArrayBuffer): Font };
	export default opentype;
}

declare module "@resvg/resvg-wasm" {
	export function initWasm(module: ArrayBuffer | Uint8Array | Buffer): Promise<void>;
	export class Resvg {
		constructor(svg: string, options?: { fitTo?: { mode: "width" | "height" | "zoom" | "original"; value?: number } });
		render(): { asPng(): Uint8Array };
	}
}
